#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment } from './config';
import {
  MACRO_AVAILABILITY_RULES_VERSION,
  MACRO_DEFAULT_LOOKBACK_DAYS,
  MACRO_SERIES,
  MACRO_SOURCE_INFO,
  MACRO_SOURCES,
  HttpError,
  addUtcDays,
  createMacroHttpClient,
  estimatePublishedAt,
  formatIsoDateUtc,
  parseIsoDateUtc,
  startOfUtcDay,
  type BlsSeriesDefinition,
  type EcbSeriesDefinition,
  type FedSeriesDefinition,
  type MacroFetchResult,
  type MacroHttpClient,
  type MacroObservationValue,
  type MacroSeriesDefinition,
  type MacroSource,
  type NyfedSeriesDefinition,
  type TreasurySeriesDefinition,
  type FetchLike,
} from './sources/macro-config';
import {
  TREASURY_ENDPOINT,
  fetchTreasuryObservations,
} from './sources/macro-treasury';
import { NYFED_ENDPOINT, fetchNyfedObservations } from './sources/macro-nyfed';
import { ECB_ENDPOINT, fetchEcbObservations } from './sources/macro-ecb';
import { FED_H10_ENDPOINT, fetchFedObservations } from './sources/macro-fed';
import { BLS_ENDPOINT, fetchBlsObservations } from './sources/macro-bls';

const SOURCE_ORDER: readonly MacroSource[] = ['treasury', 'nyfed', 'ecb', 'fed', 'bls'];

const OPERATION_BY_SOURCE: Record<MacroSource, string> = {
  treasury: 'fetch_treasury_rates',
  nyfed: 'fetch_nyfed_rates',
  ecb: 'fetch_ecb_rates',
  fed: 'fetch_fed_h10',
  bls: 'fetch_bls_series',
};

const ENDPOINT_BY_SOURCE: Record<MacroSource, string> = {
  treasury: TREASURY_ENDPOINT,
  nyfed: NYFED_ENDPOINT,
  ecb: ECB_ENDPOINT,
  fed: FED_H10_ENDPOINT,
  bls: BLS_ENDPOINT,
};

interface LogData {
  sourceId: string;
  operation: string;
  endpoint: string;
  status: string;
  latencyMs: number;
  recordsFetched: number;
  errorMessage: string | null;
  httpStatus: number | null;
}

interface LatestObservation {
  value: Decimal | null;
  status: string;
  firstSeenAt: Date;
}

interface InsertRow {
  seriesId: string;
  source: string;
  refDate: Date;
  value: Decimal | null;
  status: string;
  unit: string;
  publishedAt: Date | null;
  firstSeenAt: Date;
  collectedAt: Date;
  revisionNote: string | null;
}

export interface CollectMacroOptions {
  prisma?: PrismaClient | null;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
  backfillFrom?: Date;
  only?: readonly MacroSource[];
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export interface CollectMacroSummary {
  ok: boolean;
  observations: number;
  inserted: number;
  unchanged: number;
  warnings: string[];
  failures: string[];
  rateLimited: boolean;
  httpStatus: number | null;
}

export interface MacroCliOptions {
  dryRun: boolean;
  backfillFrom: Date | null;
  only: MacroSource[] | null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function isMacroSource(value: string): value is MacroSource {
  return (MACRO_SOURCES as readonly string[]).includes(value);
}

export function parseMacroArgs(argv: readonly string[]): MacroCliOptions {
  let dryRun = false;
  let backfillFrom: Date | null = null;
  let only: MacroSource[] | null = null;

  for (const argument of argv) {
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (argument.startsWith('--backfill-from=')) {
      const raw = argument.slice('--backfill-from='.length);
      const parsed = parseIsoDateUtc(raw);

      if (parsed === null) {
        throw new Error(`--backfill-from inválido: ${raw}`);
      }

      backfillFrom = parsed;
      continue;
    }

    if (argument.startsWith('--only=')) {
      const raw = argument.slice('--only='.length);
      const sources = raw.split(',').map((value) => value.trim()).filter((value) => value !== '');

      if (sources.length === 0) {
        throw new Error('--only exige ao menos uma fonte');
      }

      for (const source of sources) {
        if (!isMacroSource(source)) {
          throw new Error(`--only inválido: ${source}`);
        }
      }

      only = [...new Set(sources)] as MacroSource[];
      continue;
    }

    throw new Error(`argumento desconhecido: ${argument}`);
  }

  return { dryRun, backfillFrom, only };
}

async function writeLog(
  prisma: PrismaClient,
  data: LogData,
  logError: (message: string) => void
): Promise<void> {
  try {
    await prisma.collectionLog.create({ data });
  } catch (error) {
    logError(
      `[DB] não foi possível gravar CollectionLog (${data.operation}/${data.status}): ${errorMessage(error)}`
    );
  }
}

async function ensureSource(prisma: PrismaClient, source: MacroSource): Promise<{ id: string }> {
  const info = MACRO_SOURCE_INFO[source];

  return prisma.dataSource.upsert({
    where: { provider: info.provider },
    update: {},
    create: {
      provider: info.provider,
      displayName: info.displayName,
      baseUrl: info.baseUrl,
    },
    select: { id: true },
  });
}

async function fetchSource(
  http: MacroHttpClient,
  source: MacroSource,
  series: readonly MacroSeriesDefinition[],
  startDate: Date,
  endDate: Date,
  isBackfill: boolean
): Promise<MacroFetchResult> {
  if (source === 'treasury') {
    const definitions = series.filter(
      (definition): definition is TreasurySeriesDefinition => definition.source === 'treasury'
    );
    return fetchTreasuryObservations(http, definitions, startDate, endDate);
  }

  if (source === 'nyfed') {
    const definitions = series.filter(
      (definition): definition is NyfedSeriesDefinition => definition.source === 'nyfed'
    );
    return fetchNyfedObservations(http, definitions, startDate, endDate);
  }

  if (source === 'ecb') {
    const definitions = series.filter(
      (definition): definition is EcbSeriesDefinition => definition.source === 'ecb'
    );
    return fetchEcbObservations(http, definitions, startDate, endDate);
  }

  if (source === 'fed') {
    const definitions = series.filter(
      (definition): definition is FedSeriesDefinition => definition.source === 'fed'
    );
    return fetchFedObservations(http, definitions, startDate, endDate, isBackfill);
  }

  const definitions = series.filter(
    (definition): definition is BlsSeriesDefinition => definition.source === 'bls'
  );
  return fetchBlsObservations(http, definitions, startDate, endDate, isBackfill);
}

function dedupeObservations(
  observations: readonly MacroObservationValue[]
): MacroObservationValue[] {
  const unique = new Map<string, MacroObservationValue>();

  for (const observation of observations) {
    const key = `${observation.seriesId}\u0000${formatIsoDateUtc(observation.refDate)}`;
    unique.set(key, observation);
  }

  return [...unique.values()];
}

const INSERT_BATCH_SIZE = 500;

class MacroPersistenceError extends Error {
  constructor(readonly seriesId: string, message: string) {
    super(message);
    this.name = 'MacroPersistenceError';
  }
}

interface LatestByRefDate {
  rowsRead: number;
  latest: Map<string, LatestObservation>;
}

async function readLatestByRefDate(
  prisma: PrismaClient,
  seriesId: string,
  startDate: Date,
  endDate: Date
): Promise<LatestByRefDate> {
  const rows = await prisma.macroObservation.findMany({
    where: {
      seriesId,
      refDate: { gte: startDate, lte: endDate },
    },
    orderBy: [{ refDate: 'asc' }, { collectedAt: 'desc' }],
    select: {
      refDate: true,
      value: true,
      status: true,
      firstSeenAt: true,
    },
  });
  const latest = new Map<string, LatestObservation>();

  for (const row of rows) {
    const key = formatIsoDateUtc(row.refDate);

    if (!latest.has(key)) {
      latest.set(key, {
        value: row.value,
        status: row.status,
        firstSeenAt: row.firstSeenAt,
      });
    }
  }

  return { rowsRead: rows.length, latest };
}

async function persistSeries(
  prisma: PrismaClient,
  seriesId: string,
  observations: readonly MacroObservationValue[],
  collectedAt: Date,
  isBackfill: boolean,
  fallbackStartDate: Date,
  fallbackEndDate: Date,
  log: (message: string) => void
): Promise<{ inserted: number; unchanged: number }> {
  let readStartDate = fallbackStartDate;
  let readEndDate = fallbackEndDate;

  if (observations.length > 0) {
    readStartDate = observations[0].refDate;
    readEndDate = observations[0].refDate;

    for (const observation of observations) {
      if (observation.refDate < readStartDate) readStartDate = observation.refDate;
      if (observation.refDate > readEndDate) readEndDate = observation.refDate;
    }
  }

  const existing = await readLatestByRefDate(
    prisma,
    seriesId,
    readStartDate,
    readEndDate
  );
  log(
    `[MACRO] série=${seriesId} lidas=${existing.rowsRead} ` +
      `intervalo=${formatIsoDateUtc(readStartDate)}..${formatIsoDateUtc(readEndDate)}`
  );

  const rows: InsertRow[] = [];
  let equal = 0;
  let revised = 0;

  for (const observation of observations) {
    const latest = existing.latest.get(formatIsoDateUtc(observation.refDate));
    const status = observation.status ?? 'ok';
    const value =
      observation.value === null ? null : new Decimal(observation.value);
    const sameValue =
      latest !== undefined &&
      latest.status === status &&
      ((latest.value === null && value === null) ||
        (latest.value !== null &&
          value !== null &&
          latest.value.equals(value)));

    if (sameValue) {
      equal++;
      continue;
    }

    const estimate = estimatePublishedAt(observation.source, observation.refDate);
    const publishedAt = isBackfill ? estimate : null;
    const firstSeenAt = latest?.firstSeenAt ?? (isBackfill ? estimate : collectedAt);
    const notes: string[] = [];

    if (isBackfill) {
      notes.push(
        observation.source === 'bls'
          ? 'backfill:estimated_publication;latest_vintage'
          : 'backfill:estimated_publication'
      );
    }

    if (latest !== undefined) {
      revised++;
      notes.push(
        `revised from ${latest.value?.toString() ?? latest.status}`
      );
    }

    if (observation.revisionIndicator !== null) {
      notes.push(`revisionIndicator=${observation.revisionIndicator}`);
    }

    rows.push({
      seriesId: observation.seriesId,
      source: observation.source,
      refDate: observation.refDate,
      value,
      status,
      unit: observation.unit,
      publishedAt,
      firstSeenAt,
      collectedAt,
      revisionNote: notes.length > 0 ? notes.join('; ') : null,
    });
  }

  const outsideReadRange = rows.find(
    (row) => row.refDate < readStartDate || row.refDate > readEndDate
  );

  if (outsideReadRange !== undefined) {
    throw new MacroPersistenceError(
      seriesId,
      `série=${seriesId} refDate=${formatIsoDateUtc(outsideReadRange.refDate)} ` +
        `fora do intervalo lido ${formatIsoDateUtc(readStartDate)}..${formatIsoDateUtc(readEndDate)}`
    );
  }

  const batchCount = Math.ceil(rows.length / INSERT_BATCH_SIZE);
  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE);
    const batchNumber = offset / INSERT_BATCH_SIZE + 1;

    try {
      const result = await prisma.macroObservation.createMany({
        data: batch,
        skipDuplicates: true,
      });
      inserted += result.count;
      log(
        `[MACRO] série=${seriesId} lote=${batchNumber}/${batchCount} inseridas=${result.count}`
      );
    } catch (error) {
      throw new MacroPersistenceError(
        seriesId,
        `série=${seriesId} lote=${batchNumber}/${batchCount}: ${errorMessage(error)}`
      );
    }
  }

  log(
    `[MACRO] série=${seriesId} inseridas=${inserted} iguais=${equal} revisadas=${revised}`
  );

  return { inserted, unchanged: equal + (rows.length - inserted) };
}

async function persistSource(
  prisma: PrismaClient,
  series: readonly MacroSeriesDefinition[],
  observations: readonly MacroObservationValue[],
  collectedAt: Date,
  isBackfill: boolean,
  startDate: Date,
  endDate: Date,
  log: (message: string) => void
): Promise<{ inserted: number; unchanged: number }> {
  const bySeries = new Map<string, MacroObservationValue[]>();

  for (const observation of observations) {
    const entries = bySeries.get(observation.seriesId) ?? [];
    entries.push(observation);
    bySeries.set(observation.seriesId, entries);
  }

  let inserted = 0;
  let unchanged = 0;

  for (const definition of series) {
    const persisted = await persistSeries(
      prisma,
      definition.seriesId,
      bySeries.get(definition.seriesId) ?? [],
      collectedAt,
      isBackfill,
      startDate,
      endDate,
      log
    );
    inserted += persisted.inserted;
    unchanged += persisted.unchanged;
  }

  return { inserted, unchanged };
}

function printDryRun(
  log: (message: string) => void,
  series: readonly MacroSeriesDefinition[],
  observations: readonly MacroObservationValue[],
  warnings: readonly string[],
  failures: readonly string[],
  startDate: Date,
  endDate: Date,
  collectedAt: Date
): void {
  log('[DRY-RUN] modo simulação - sem escrita no banco');
  log(
    `[DRY-RUN] período=${formatIsoDateUtc(startDate)}..${formatIsoDateUtc(endDate)} ` +
      `collectedAt=${collectedAt.toISOString()} rules=${MACRO_AVAILABILITY_RULES_VERSION}`
  );

  for (const definition of series) {
    const rows = observations
      .filter((observation) => observation.seriesId === definition.seriesId)
      .sort((left, right) => right.refDate.getTime() - left.refDate.getTime());

    log(
      `[DRY-RUN] series=${definition.seriesId} count=${rows.length} unit=${definition.unit}`
    );

    for (const row of rows.slice(0, 3)) {
      log(
        `[DRY-RUN]   series=${row.seriesId} refDate=${formatIsoDateUtc(row.refDate)} ` +
          `value=${row.value ?? 'null'} status=${row.status ?? 'ok'}`
      );
    }
  }

  for (const warning of warnings) {
    log(`[AVISO] ${warning}`);
  }

  for (const failure of failures) {
    log(`[FALHA] ${failure}`);
  }

  log(
    `[DRY-RUN] resumo observations=${observations.length} warnings=${warnings.length} ` +
      `failures=${failures.length}`
  );
  log('[DRY-RUN] nenhuma escrita no banco');
}

export async function collectMacro(
  options: CollectMacroOptions = {}
): Promise<CollectMacroSummary> {
  const dryRun = options.dryRun ?? false;
  const prisma = options.prisma ?? null;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));
  const now = options.now ?? (() => new Date());

  if (!dryRun && prisma === null) {
    throw new Error('PrismaClient obrigatório fora do dry-run');
  }

  const collectedAt = now();
  const endDate = startOfUtcDay(collectedAt);

  if (options.backfillFrom !== undefined && Number.isNaN(options.backfillFrom.getTime())) {
    throw new Error('backfillFrom inválido');
  }

  const startDate =
    options.backfillFrom === undefined
      ? addUtcDays(endDate, -(MACRO_DEFAULT_LOOKBACK_DAYS - 1))
      : startOfUtcDay(options.backfillFrom);

  if (startDate > endDate) {
    throw new Error(
      `backfillFrom ${formatIsoDateUtc(startDate)} posterior ao fim ${formatIsoDateUtc(endDate)}`
    );
  }

  const isBackfill = options.backfillFrom !== undefined;
  const only = options.only === undefined ? MACRO_SOURCES : options.only;
  const selectedSeries = MACRO_SERIES.filter((definition) => only.includes(definition.source));

  if (selectedSeries.length === 0) {
    throw new Error('nenhuma série selecionada');
  }

  const http = createMacroHttpClient({
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const observations: MacroObservationValue[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  let inserted = 0;
  let unchanged = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;

  for (const source of SOURCE_ORDER) {
    const series = selectedSeries.filter((definition) => definition.source === source);

    if (series.length === 0) {
      continue;
    }

    let sourceRow: { id: string } | null = null;

    if (!dryRun && prisma !== null) {
      sourceRow = await ensureSource(prisma, source);
    }

    const started = Date.now();

    try {
      const result = await fetchSource(
        http,
        source,
        series,
        startDate,
        endDate,
        isBackfill
      );
      const deduped = dedupeObservations(result.observations);
      observations.push(...deduped);
      warnings.push(...result.warnings);

      if (!dryRun && prisma !== null && sourceRow !== null) {
        const persisted = await persistSource(
          prisma,
          series,
          deduped,
          collectedAt,
          isBackfill,
          startDate,
          endDate,
          log
        );
        inserted += persisted.inserted;
        unchanged += persisted.unchanged;

        await writeLog(
          prisma,
          {
            sourceId: sourceRow.id,
            operation: OPERATION_BY_SOURCE[source],
            endpoint: ENDPOINT_BY_SOURCE[source],
            status: 'success',
            latencyMs: Date.now() - started,
            recordsFetched: deduped.length,
            errorMessage: null,
            httpStatus: null,
          },
          logError
        );
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : null;
      const persistenceFailure = error instanceof MacroPersistenceError;
      const message = errorMessage(error);
      httpStatus = status;
      failures.push(`${source}: ${message}`);
      logError(`[ERRO] ${source}: ${message}`);

      if (!dryRun && prisma !== null && sourceRow !== null) {
        await writeLog(
          prisma,
          {
            sourceId: sourceRow.id,
            operation: OPERATION_BY_SOURCE[source],
            endpoint: ENDPOINT_BY_SOURCE[source],
            status: 'error',
            latencyMs: Date.now() - started,
            recordsFetched: 0,
            errorMessage: message,
            httpStatus: status,
          },
          logError
        );
      }

      if (status === 429) {
        rateLimited = true;
        logError('[429] interrompendo imediatamente');
        break;
      }

      if (persistenceFailure) {
        logError('[MACRO] interrompendo após falha de gravação');
        break;
      }
    }
  }

  if (dryRun) {
    printDryRun(
      log,
      selectedSeries,
      observations,
      warnings,
      failures,
      startDate,
      endDate,
      collectedAt
    );
  } else {
    for (const warning of warnings) {
      log(`[AVISO] ${warning}`);
    }
  }

  return {
    ok: failures.length === 0,
    observations: observations.length,
    inserted,
    unchanged,
    warnings,
    failures,
    rateLimited,
    httpStatus,
  };
}

async function main(): Promise<void> {
  const args = parseMacroArgs(process.argv.slice(2));
  let prisma: PrismaClient | null = null;

  if (!args.dryRun) {
    checkEnvironment();
    const db = await import('./db');
    prisma = db.prisma;
  }

  try {
    const summary = await collectMacro({
      prisma,
      dryRun: args.dryRun,
      backfillFrom: args.backfillFrom ?? undefined,
      only: args.only ?? undefined,
    });

    console.log(
      `[FIM] observations=${summary.observations} inserted=${summary.inserted} ` +
        `unchanged=${summary.unchanged} warnings=${summary.warnings.length} ` +
        `failures=${summary.failures.length} rate_limited=${summary.rateLimited ? 'sim' : 'nao'} ` +
        `http=${summary.httpStatus ?? 'n/a'}`
    );

    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (prisma !== null) {
      await prisma.$disconnect();
    }
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error('[FATAL]', errorMessage(error));
    process.exitCode = 1;
  });
}
