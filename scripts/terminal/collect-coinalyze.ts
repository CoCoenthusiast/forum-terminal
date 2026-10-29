#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment } from './config';
import {
  addUtcDays,
  decimalString,
  formatIsoDateUtc,
  parseIsoDateUtc,
  startOfUtcDay,
  type FetchLike,
} from './sources/macro-config';
import {
  COINALYZE_ASSETS,
  COINALYZE_BACKFILL_BLOCK_DAYS,
  COINALYZE_BASE_URL,
  COINALYZE_CREDIT_LINE,
  COINALYZE_DEFAULT_LOOKBACK_DAYS,
  COINALYZE_DISPLAY_NAME,
  COINALYZE_ENDPOINTS,
  COINALYZE_HISTORY_START_DATE,
  COINALYZE_INSERT_BATCH_SIZE,
  COINALYZE_PROVIDER,
  COINALYZE_REQUEST_PAUSE_MS,
  COINALYZE_SERIES,
  COINALYZE_SYMBOLS,
  coinalyzeEstimatePublishedAt,
  coinalyzeSeriesForEndpoint,
  isCoinalyzeAsset,
  type CoinalyzeAsset,
  type CoinalyzeEndpoint,
  type CoinalyzeSeriesDefinition,
} from './sources/coinalyze-config';
import {
  coinalyzeHistoryUrl,
  parseCoinalyzeHistory,
  requestCoinalyzeHistory,
  warnMissingField,
} from './sources/coinalyze';

const OPERATION = 'fetch_coinalyze_history';
const VALUE_DECIMAL_PLACES = 8;
const ENDPOINT_ORDER: readonly CoinalyzeEndpoint[] = [
  'open_interest',
  'funding_rate',
  'liquidation',
  'long_short_ratio',
];

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

interface CoinalyzeObservation {
  seriesId: string;
  source: 'coinalyze';
  unit: string;
  refDate: Date;
  value: string;
  status: 'ok';
}

export interface CoinalyzeBlock {
  from: Date;
  toExclusive: Date;
}

export interface CollectCoinalyzeOptions {
  prisma?: PrismaClient | null;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
  backfillFrom?: Date;
  only?: readonly CoinalyzeAsset[];
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export interface CoinalyzeSummary {
  ok: boolean;
  observations: number;
  inserted: number;
  unchanged: number;
  warnings: string[];
  failures: string[];
  rateLimited: boolean;
  httpStatus: number | null;
}

export interface CoinalyzeCliOptions {
  dryRun: boolean;
  backfillFrom: Date | null;
  only: CoinalyzeAsset[] | null;
}

function roundObservationValue(value: string): Decimal {
  return new Decimal(value).toDecimalPlaces(
    VALUE_DECIMAL_PLACES,
    Decimal.ROUND_HALF_UP
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseCollectCoinalyzeArgs(
  argv: readonly string[]
): CoinalyzeCliOptions {
  let dryRun = false;
  let backfillFrom: Date | null = null;
  let only: CoinalyzeAsset[] | null = null;

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
      const assets = raw
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value) => value !== '');

      if (assets.length === 0) {
        throw new Error('--only exige ao menos uma série');
      }

      for (const asset of assets) {
        if (!isCoinalyzeAsset(asset)) {
          throw new Error(`--only inválido: ${asset}`);
        }
      }

      only = [...new Set(assets)] as CoinalyzeAsset[];
      continue;
    }

    throw new Error(`argumento desconhecido: ${argument}`);
  }

  return { dryRun, backfillFrom, only };
}

export function buildCoinalyzeHistoryBlocks(
  startDate: Date,
  endDateExclusive: Date,
  blockDays = COINALYZE_BACKFILL_BLOCK_DAYS
): CoinalyzeBlock[] {
  if (!Number.isFinite(blockDays) || blockDays <= 0) {
    throw new Error(`blockDays inválido: ${blockDays}`);
  }
  if (startDate >= endDateExclusive) {
    throw new Error(
      `intervalo inválido: ${formatIsoDateUtc(startDate)} >= ${formatIsoDateUtc(endDateExclusive)}`
    );
  }

  const blocks: CoinalyzeBlock[] = [];

  for (let cursor = startDate; cursor < endDateExclusive; ) {
    const next = addUtcDays(cursor, blockDays);
    const toExclusive = next > endDateExclusive ? endDateExclusive : next;
    blocks.push({ from: cursor, toExclusive });
    cursor = toExclusive;
  }

  return blocks;
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

async function ensureSource(prisma: PrismaClient): Promise<{ id: string }> {
  return prisma.dataSource.upsert({
    where: { provider: COINALYZE_PROVIDER },
    update: {},
    create: {
      provider: COINALYZE_PROVIDER,
      displayName: COINALYZE_DISPLAY_NAME,
      baseUrl: COINALYZE_BASE_URL,
    },
    select: { id: true },
  });
}

function dedupeObservations(
  observations: readonly CoinalyzeObservation[]
): CoinalyzeObservation[] {
  const unique = new Map<string, CoinalyzeObservation>();

  for (const observation of observations) {
    const key = `${observation.seriesId}\u0000${formatIsoDateUtc(observation.refDate)}`;
    unique.set(key, observation);
  }

  return [...unique.values()];
}

async function readLatestByRefDate(
  prisma: PrismaClient,
  seriesId: string,
  startDate: Date,
  endDate: Date
): Promise<{ rowsRead: number; latest: Map<string, LatestObservation> }> {
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
  definition: CoinalyzeSeriesDefinition,
  observations: readonly CoinalyzeObservation[],
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
    definition.seriesId,
    readStartDate,
    readEndDate
  );
  log(
    `[COINALYZE] série=${definition.seriesId} lidas=${existing.rowsRead} ` +
      `intervalo=${formatIsoDateUtc(readStartDate)}..${formatIsoDateUtc(readEndDate)}`
  );

  const rows: InsertRow[] = [];
  let equal = 0;
  let revised = 0;

  for (const observation of observations) {
    const latest = existing.latest.get(formatIsoDateUtc(observation.refDate));
    const value = roundObservationValue(observation.value);
    const sameValue =
      latest !== undefined &&
      latest.status === observation.status &&
      latest.value !== null &&
      latest.value.equals(value);

    if (sameValue) {
      equal++;
      continue;
    }

    const estimate = coinalyzeEstimatePublishedAt(observation.refDate);
    const publishedAt = isBackfill ? estimate : null;
    const firstSeenAt = latest?.firstSeenAt ?? (isBackfill ? estimate : collectedAt);
    const notes: string[] = [];

    if (isBackfill) {
      notes.push('backfill:estimated_publication');
    }

    if (latest !== undefined) {
      revised++;
      notes.push(`revised from ${latest.value?.toString() ?? latest.status}`);
    }

    rows.push({
      seriesId: observation.seriesId,
      source: observation.source,
      refDate: observation.refDate,
      value,
      status: observation.status,
      unit: definition.unit,
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
    throw new Error(
      `série=${definition.seriesId} refDate=${formatIsoDateUtc(outsideReadRange.refDate)} ` +
        `fora do intervalo lido ${formatIsoDateUtc(readStartDate)}..${formatIsoDateUtc(readEndDate)}`
    );
  }

  let inserted = 0;

  for (let offset = 0; offset < rows.length; offset += COINALYZE_INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + COINALYZE_INSERT_BATCH_SIZE);
    const result = await prisma.macroObservation.createMany({
      data: batch,
      skipDuplicates: true,
    });
    inserted += result.count;
    log(
      `[COINALYZE] série=${definition.seriesId} lote=${offset / COINALYZE_INSERT_BATCH_SIZE + 1} ` +
        `inseridas=${result.count}`
    );
  }

  log(
    `[COINALYZE] série=${definition.seriesId} inseridas=${inserted} ` +
      `iguais=${equal} revisadas=${revised}`
  );

  return { inserted, unchanged: equal + (rows.length - inserted) };
}

function printDryRun(
  log: (message: string) => void,
  definitions: readonly CoinalyzeSeriesDefinition[],
  observations: readonly CoinalyzeObservation[],
  warnings: readonly string[],
  failures: readonly string[]
): void {
  log('[DRY-RUN] modo simulação - sem escrita no banco');

  for (const definition of definitions) {
    const rows = observations
      .filter((observation) => observation.seriesId === definition.seriesId)
      .sort((left, right) => right.refDate.getTime() - left.refDate.getTime());

    log(
      `[DRY-RUN] series=${definition.seriesId} count=${rows.length} unit=${definition.unit}`
    );

    for (const row of rows.slice(0, 3)) {
      log(
        `[DRY-RUN]   series=${row.seriesId} refDate=${formatIsoDateUtc(row.refDate)} ` +
          `value=${row.value} status=${row.status}`
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

export async function collectCoinalyze(
  options: CollectCoinalyzeOptions = {}
): Promise<CoinalyzeSummary> {
  const dryRun = options.dryRun ?? false;
  const prisma = options.prisma ?? null;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));
  const sleepImpl = options.sleepImpl ?? sleep;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = process.env.COINALYZE_API_KEY;

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('COINALYZE_API_KEY não definida');
  }
  if (!dryRun && prisma === null) {
    throw new Error('PrismaClient obrigatório fora do dry-run');
  }

  const collectedAt = now();
  const todayStart = startOfUtcDay(collectedAt);
  const historyStart = parseIsoDateUtc(COINALYZE_HISTORY_START_DATE);

  if (historyStart === null) {
    throw new Error('COINALYZE_HISTORY_START_DATE inválida');
  }

  const isBackfill = options.backfillFrom !== undefined;
  const requestedStart = isBackfill
    ? startOfUtcDay(options.backfillFrom as Date)
    : addUtcDays(todayStart, -COINALYZE_DEFAULT_LOOKBACK_DAYS);
  const startDate = requestedStart < historyStart ? historyStart : requestedStart;
  const endDateExclusive = todayStart;

  if (startDate >= endDateExclusive) {
    throw new Error(
      `intervalo sem dias concluídos: ${formatIsoDateUtc(startDate)} >= ${formatIsoDateUtc(endDateExclusive)}`
    );
  }

  const selectedAssets =
    options.only === undefined || options.only.length === 0
      ? [...COINALYZE_ASSETS]
      : [...options.only];
  const definitions = COINALYZE_SERIES.filter((definition) =>
    selectedAssets.includes(definition.asset)
  );
  const blocks = buildCoinalyzeHistoryBlocks(startDate, endDateExclusive);
  const observationsBySeries = new Map<string, CoinalyzeObservation[]>();
  const warnings: string[] = [];
  const failures: string[] = [];
  let inserted = 0;
  let unchanged = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;
  let stopped = false;
  let sourceId: string | null = null;

  if (!dryRun && prisma !== null) {
    sourceId = (await ensureSource(prisma)).id;
  }

  let requestNumber = 0;

  for (const asset of selectedAssets) {
    for (const endpoint of ENDPOINT_ORDER) {
      const endpointDefinitions = coinalyzeSeriesForEndpoint(asset, endpoint);

      for (const block of blocks) {
        if (stopped) break;

        if (requestNumber > 0) {
          await sleepImpl(COINALYZE_REQUEST_PAUSE_MS);
        }
        requestNumber++;

        const fromSeconds = Math.floor(block.from.getTime() / 1000);
        const toSeconds = Math.floor(block.toExclusive.getTime() / 1000) - 1;
        const url = coinalyzeHistoryUrl(asset, endpoint, fromSeconds, toSeconds);
        const startedAt = Date.now();
        const endpointPath = COINALYZE_ENDPOINTS[endpoint];

        try {
          const response = await requestCoinalyzeHistory(url, apiKey, fetchImpl);
          httpStatus = response.status;

          if (response.status !== 200) {
            const message =
              `${asset} ${endpointPath} ${formatIsoDateUtc(block.from)}..` +
              `${formatIsoDateUtc(addUtcDays(block.toExclusive, -1))} HTTP ${response.status}` +
              (response.status === 429
                ? ` retry-after=${response.retryAfter ?? 'AUSENTE'}`
                : ` body=${response.bodyPreview}`);
            failures.push(message);
            logError(`[ERRO] ${message}`);

            if (response.status === 429) {
              rateLimited = true;
            }
            stopped = true;

            if (!dryRun && prisma !== null && sourceId !== null) {
              await writeLog(
                prisma,
                {
                  sourceId,
                  operation: OPERATION,
                  endpoint: endpointPath,
                  status: 'error',
                  latencyMs: response.ms,
                  recordsFetched: 0,
                  errorMessage: message,
                  httpStatus: response.status,
                },
                logError
              );
            }
            break;
          }

          const parsed = parseCoinalyzeHistory(response.payload, COINALYZE_SYMBOLS[asset]);
          warnings.push(...parsed.warnings);
          const completedPoints = parsed.points.filter((point) => {
            if (point.refDate >= todayStart) {
              warnings.push(
                `${COINALYZE_SYMBOLS[asset]}: ${formatIsoDateUtc(point.refDate)} é hoje ou futuro, ignorada`
              );
              return false;
            }
            return true;
          });

          if (!dryRun && prisma !== null && sourceId !== null) {
            await writeLog(
              prisma,
              {
                sourceId,
                operation: OPERATION,
                endpoint: endpointPath,
                status: 'success',
                latencyMs: response.ms,
                recordsFetched: completedPoints.length,
                errorMessage: null,
                httpStatus: null,
              },
              logError
            );
          }

          for (const point of completedPoints) {
            for (const definition of endpointDefinitions) {
              const raw = point.values[definition.field];
              const value = decimalString(raw);

              if (value === null) {
                warnings.push(
                  warnMissingField(definition.seriesId, point.refDate, definition.field)
                );
                continue;
              }

              const entries = observationsBySeries.get(definition.seriesId) ?? [];
              entries.push({
                seriesId: definition.seriesId,
                source: 'coinalyze',
                unit: definition.unit,
                refDate: point.refDate,
                value,
                status: 'ok',
              });
              observationsBySeries.set(definition.seriesId, entries);
            }
          }
        } catch (error) {
          const message = `${asset} ${endpointPath} ${formatIsoDateUtc(block.from)}..` +
            `${formatIsoDateUtc(addUtcDays(block.toExclusive, -1))}: ${errorMessage(error)}`;
          failures.push(message);
          logError(`[ERRO] ${message}`);
          httpStatus = null;
          stopped = true;

          if (!dryRun && prisma !== null && sourceId !== null) {
            await writeLog(
              prisma,
              {
                sourceId,
                operation: OPERATION,
                endpoint: endpointPath,
                status: 'error',
                latencyMs: Date.now() - startedAt,
                recordsFetched: 0,
                errorMessage: message,
                httpStatus: null,
              },
              logError
            );
          }
          break;
        }
      }

      if (stopped) break;
    }

    if (stopped) break;
  }

  const observations = dedupeObservations(
    definitions.flatMap((definition) => observationsBySeries.get(definition.seriesId) ?? [])
  );
  const observationsForSeries = new Map<string, CoinalyzeObservation[]>();

  for (const observation of observations) {
    const entries = observationsForSeries.get(observation.seriesId) ?? [];
    entries.push(observation);
    observationsForSeries.set(observation.seriesId, entries);
  }

  if (failures.length === 0 && !dryRun && prisma !== null) {
    try {
      for (const definition of definitions) {
        const persisted = await persistSeries(
          prisma,
          definition,
          observationsForSeries.get(definition.seriesId) ?? [],
          collectedAt,
          isBackfill,
          startDate,
          addUtcDays(endDateExclusive, -1),
          log
        );
        inserted += persisted.inserted;
        unchanged += persisted.unchanged;
      }
    } catch (error) {
      const message = `persistência: ${errorMessage(error)}`;
      failures.push(message);
      logError(`[ERRO] ${message}`);

      if (sourceId !== null) {
        await writeLog(
          prisma,
          {
            sourceId,
            operation: 'persist_coinalyze_observations',
            endpoint: '/macro-observation',
            status: 'error',
            latencyMs: 0,
            recordsFetched: 0,
            errorMessage: message,
            httpStatus: null,
          },
          logError
        );
      }
    }
  }

  if (dryRun) {
    printDryRun(log, definitions, observations, warnings, failures);
  } else {
    for (const warning of warnings) {
      log(`[AVISO] ${warning}`);
    }
    for (const failure of failures) {
      log(`[FALHA] ${failure}`);
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
  const args = parseCollectCoinalyzeArgs(process.argv.slice(2));
  const apiKey = process.env.COINALYZE_API_KEY;

  if (apiKey === undefined || apiKey.trim() === '') {
    console.error('[ERRO] COINALYZE_API_KEY não definida; abortando sem chamadas');
    process.exitCode = 1;
    return;
  }

  let prisma: PrismaClient | null = null;

  if (!args.dryRun) {
    checkEnvironment();
    const db = await import('./db');
    prisma = db.prisma;
  }

  try {
    const summary = await collectCoinalyze({
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
    console.log(COINALYZE_CREDIT_LINE);

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
