#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment } from './config';
import {
  HYPERLIQUID_INFO_ENDPOINT,
  fetchHyperliquidPerpSnapshot,
  HttpError,
  type FetchLike,
  type HyperliquidCoin,
  type HyperliquidCoinData,
  type HyperliquidField,
  type HyperliquidPerpSnapshot,
} from './sources/hyperliquid';

const SOURCE_PROVIDER = 'hyperliquid';
const SOURCE_DISPLAY_NAME = 'Hyperliquid';
const SOURCE_BASE_URL = 'https://api.hyperliquid.xyz';
const OPERATION = 'fetch_perp_metrics';

type MetricUnit = 'FRACTION' | 'USD' | 'COIN';

interface MetricDefinition {
  field: HyperliquidField;
  metric: string;
  unit: MetricUnit;
}

interface MetricRow {
  sourceId: string;
  scope: string;
  metric: string;
  value: Decimal;
  unit: string;
  bucketTs: Date;
  collectedAt: Date;
}

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

export interface InvalidFieldIssue {
  coin: HyperliquidCoin;
  fields: HyperliquidField[];
}

export interface CollectSummary {
  ok: boolean;
  records: number;
  inserted: number;
  missingCoins: HyperliquidCoin[];
  invalidFields: InvalidFieldIssue[];
  httpStatus: number | null;
}

export interface CollectOptions {
  prisma?: PrismaClient | null;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  now?: () => Date;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  { field: 'funding', metric: 'perp_funding_rate_1h', unit: 'FRACTION' },
  { field: 'openInterest', metric: 'perp_open_interest_coin', unit: 'COIN' },
  { field: 'markPx', metric: 'perp_mark_price_usd', unit: 'USD' },
  { field: 'oraclePx', metric: 'perp_oracle_price_usd', unit: 'USD' },
  { field: 'premium', metric: 'perp_premium', unit: 'FRACTION' },
  { field: 'dayNtlVlm', metric: 'perp_day_volume_usd', unit: 'USD' },
];

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

export function startOfUtcHour(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours())
  );
}

function scopeFor(coin: HyperliquidCoin): string {
  return `${SOURCE_PROVIDER}:perp:${coin}`;
}

function buildRows(
  sourceId: string,
  snapshot: HyperliquidPerpSnapshot,
  bucketTs: Date,
  collectedAt: Date
): MetricRow[] {
  const rows: MetricRow[] = [];

  for (const coinData of snapshot.coins) {
    if (!coinData.found) {
      continue;
    }

    for (const definition of METRIC_DEFINITIONS) {
      const raw = coinData.fields[definition.field];

      if (raw === null) {
        continue;
      }

      let value: Decimal;

      try {
        value = new Decimal(raw);
      } catch {
        continue;
      }

      rows.push({
        sourceId,
        scope: scopeFor(coinData.coin),
        metric: definition.metric,
        value,
        unit: definition.unit === 'COIN' ? coinData.coin : definition.unit,
        bucketTs,
        collectedAt,
      });
    }
  }

  return rows;
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

async function writeCoinFailure(
  prisma: PrismaClient,
  sourceId: string,
  coin: HyperliquidCoin,
  reason: string,
  logError: (message: string) => void
): Promise<void> {
  await writeLog(
    prisma,
    {
      sourceId,
      operation: OPERATION,
      endpoint: HYPERLIQUID_INFO_ENDPOINT,
      status: 'error',
      latencyMs: 0,
      recordsFetched: 0,
      errorMessage: `${coin}: ${reason}`,
      httpStatus: null,
    },
    logError
  );
}

function printDryRun(
  log: (message: string) => void,
  rows: readonly MetricRow[],
  bucketTs: Date,
  collectedAt: Date,
  missingCoins: readonly HyperliquidCoin[],
  invalidFields: readonly InvalidFieldIssue[]
): void {
  log('[DRY-RUN] modo simulação - sem escrita no banco');
  log(`[DRY-RUN] bucketTs=${bucketTs.toISOString()} collectedAt=${collectedAt.toISOString()}`);

  for (const row of rows) {
    log(
      `[DRY-RUN] scope=${row.scope} metric=${row.metric} value=${row.value.toString()} ` +
        `unit=${row.unit} bucketTs=${row.bucketTs.toISOString()} collectedAt=${row.collectedAt.toISOString()}`
    );
  }

  for (const coin of missingCoins) {
    log(`[DRY-RUN] falha coin=${coin} motivo=ausente em universe`);
  }

  for (const issue of invalidFields) {
    log(`[DRY-RUN] falha coin=${issue.coin} motivo=campos inválidos: ${issue.fields.join(', ')}`);
  }

  log(
    `[DRY-RUN] resumo records=${rows.length} missing=${missingCoins.length} invalid=${invalidFields.length}`
  );
  log('[DRY-RUN] nenhuma escrita no banco');
}

function snapshotIssues(snapshot: HyperliquidPerpSnapshot): {
  missingCoins: HyperliquidCoin[];
  invalidFields: InvalidFieldIssue[];
} {
  const missingCoins: HyperliquidCoin[] = [];
  const invalidFields: InvalidFieldIssue[] = [];

  for (const coinData of snapshot.coins) {
    if (!coinData.found) {
      missingCoins.push(coinData.coin);
    } else if (coinData.invalidFields.length > 0) {
      invalidFields.push({ coin: coinData.coin, fields: coinData.invalidFields });
    }
  }

  return { missingCoins, invalidFields };
}

function issueReason(coinData: HyperliquidCoinData): string {
  if (!coinData.found) {
    return coinData.reason ?? 'ausente';
  }

  return `campos inválidos: ${coinData.invalidFields.join(', ')}`;
}

export async function collectHyperliquid(options: CollectOptions = {}): Promise<CollectSummary> {
  const dryRun = options.dryRun ?? false;
  const prisma = options.prisma ?? null;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));

  if (!dryRun && prisma === null) {
    throw new Error('PrismaClient obrigatório fora do dry-run');
  }

  const collectedAt = now();
  const bucketTs = startOfUtcHour(collectedAt);
  const source =
    dryRun || prisma === null
      ? null
      : await prisma.dataSource.upsert({
          where: { provider: SOURCE_PROVIDER },
          update: {},
          create: {
            provider: SOURCE_PROVIDER,
            displayName: SOURCE_DISPLAY_NAME,
            baseUrl: SOURCE_BASE_URL,
          },
          select: { id: true },
        });

  const started = Date.now();
  let snapshot: HyperliquidPerpSnapshot;

  try {
    snapshot = await fetchHyperliquidPerpSnapshot(fetchImpl);
  } catch (error) {
    const httpStatus = error instanceof HttpError ? error.status : null;
    const message = errorMessage(error);

    if (prisma !== null && source !== null) {
      await writeLog(
        prisma,
        {
          sourceId: source.id,
          operation: OPERATION,
          endpoint: HYPERLIQUID_INFO_ENDPOINT,
          status: 'error',
          latencyMs: Date.now() - started,
          recordsFetched: 0,
          errorMessage: message,
          httpStatus,
        },
        logError
      );
    }

    logError(`[ERRO] ${OPERATION}: ${message}`);

    return {
      ok: false,
      records: 0,
      inserted: 0,
      missingCoins: [],
      invalidFields: [],
      httpStatus,
    };
  }

  const { missingCoins, invalidFields } = snapshotIssues(snapshot);
  const sourceId = source?.id ?? 'dry-run';
  const rows = buildRows(sourceId, snapshot, bucketTs, collectedAt);

  if (dryRun) {
    printDryRun(log, rows, bucketTs, collectedAt, missingCoins, invalidFields);

    return {
      ok: missingCoins.length === 0 && invalidFields.length === 0,
      records: rows.length,
      inserted: 0,
      missingCoins,
      invalidFields,
      httpStatus: null,
    };
  }

  if (prisma === null || source === null) {
    throw new Error('PrismaClient não inicializado');
  }

  try {
    const inserted = rows.length === 0
      ? 0
      : (await prisma.metricSnapshot.createMany({ data: rows, skipDuplicates: true })).count;

    await writeLog(
      prisma,
      {
        sourceId: source.id,
        operation: OPERATION,
        endpoint: HYPERLIQUID_INFO_ENDPOINT,
        status: 'success',
        latencyMs: Date.now() - started,
        recordsFetched: rows.length,
        errorMessage: null,
        httpStatus: null,
      },
      logError
    );

    for (const coinData of snapshot.coins) {
      if (!coinData.found || coinData.invalidFields.length > 0) {
        await writeCoinFailure(prisma, source.id, coinData.coin, issueReason(coinData), logError);
      }
    }

    return {
      ok: missingCoins.length === 0 && invalidFields.length === 0,
      records: rows.length,
      inserted,
      missingCoins,
      invalidFields,
      httpStatus: null,
    };
  } catch (error) {
    const httpStatus = error instanceof HttpError ? error.status : null;
    const message = errorMessage(error);

    await writeLog(
      prisma,
      {
        sourceId: source.id,
        operation: OPERATION,
        endpoint: HYPERLIQUID_INFO_ENDPOINT,
        status: 'error',
        latencyMs: Date.now() - started,
        recordsFetched: 0,
        errorMessage: message,
        httpStatus,
      },
      logError
    );
    logError(`[ERRO] ${OPERATION}: ${message}`);

    return {
      ok: false,
      records: rows.length,
      inserted: 0,
      missingCoins,
      invalidFields,
      httpStatus,
    };
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  let prisma: PrismaClient | null = null;

  if (!dryRun) {
    checkEnvironment();
    const db = await import('./db');
    prisma = db.prisma;
  }

  try {
    const summary = await collectHyperliquid({ prisma, dryRun });
    console.log(
      `[FIM] records=${summary.records} inserted=${summary.inserted} missing=${summary.missingCoins.length} ` +
        `invalid=${summary.invalidFields.length} http=${summary.httpStatus ?? 'n/a'}`
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
