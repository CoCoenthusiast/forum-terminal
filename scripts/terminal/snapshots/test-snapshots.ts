#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { publishBlockReason } from './guards';
import {
  buildMarketStructurePayload,
  buildMarketStructureSnapshot,
} from './market-structure';
import {
  buildOnchainPayload,
  buildOnchainSnapshot,
} from './onchain';
import { buildOverviewPayload } from './overview';
import { COINALYZE_LEVERAGE_FORMULA_VERSION } from '../indicators/coinalyze-leverage-catalog';
import { INDICATOR_FORMULA_VERSION } from '../state/compute-state';
import { parseArgs } from './publish-snapshots';
import { formatRecap, type RecapInput, type RecapMetric } from '../recap/recap-format';
import { onchainLiquidityFromStateRows, regimeFromStateRows } from '../recap/recap-reader';
import type {
  DailyMetricValue,
  HourlyMetricValue,
  LatestPriceValue,
  RollingHourlyValue,
} from '../dashboard/hourly-reader';
import {
  MAX_PAYLOAD_BYTES,
  SNAPSHOT_INSERT_SQL,
  SNAPSHOT_KEYS,
  assertPayloadSize,
  assertRemoteAllowed,
  assertSnapshotKey,
  assertSnapshotWriterUser,
  databaseSecrets,
  isSnapshotKey,
  maskDatabaseUrl,
  parseDatabaseUrl,
  requireForumDatabaseUrl,
  safeErrorMessage,
  writeSnapshot,
} from './writer';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function throws(fn: () => void, pattern?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return pattern === undefined ? true : pattern.test(message);
  }
}

function metric(
  value: number | null,
  asOf: string | null = null,
  dataAsOf: string | null = null
): RecapMetric {
  return { value, unit: null, asOf, dataAsOf };
}

function overviewInput(): RecapInput {
  return {
    asOf: '2026-11-04',
    prices: [
      {
        asset: 'SOL',
        priceUsd: metric(100, '2026-11-04'),
        return1d: metric(1, '2026-11-04'),
        return7d: metric(2, '2026-11-04'),
      },
      {
        asset: 'BTC',
        priceUsd: metric(50000, '2026-11-04'),
        return1d: metric(1, '2026-11-04'),
        return7d: metric(2, '2026-11-04'),
      },
      {
        asset: 'ETH',
        priceUsd: metric(3000, '2026-11-04'),
        return1d: metric(1, '2026-11-04'),
        return7d: metric(2, '2026-11-04'),
      },
    ],
    regime: { regimeId: 'range_neutral', reason: 'test reason' },
    leverage: {
      oiUsdChange7dPct: metric(1, '2026-11-02'),
      funding7dMean: metric(2, '2026-11-01'),
      liqTotalVsMean7dPct: metric(3, '2026-11-03'),
      liqLongSharePct: metric(4, '2026-11-02'),
    },
    macro: {
      dollarBroadChange5dPct: metric(1, '2026-10-30'),
      realYield10yChange5d: metric(2, '2026-10-31'),
    },
    activity: {
      dexVolumeVsMean7d: metric(1, '2026-11-02'),
      launchpads: [
        { slug: 'pump.fun', value: metric(1, '2026-10-29') },
        { slug: 'pumpswap', value: metric(2, '2026-10-30') },
        { slug: 'launchlab', value: metric(3, '2026-10-31') },
        {
          slug: 'meteora-dynamic-bonding-curve',
          value: metric(4, '2026-11-01'),
        },
      ],
    },
  };
}

function overviewReaders(): {
  hourly: HourlyMetricValue[];
  latestPrices: LatestPriceValue[];
  daily: DailyMetricValue[];
  rolling: RollingHourlyValue[];
} {
  const hourly: HourlyMetricValue[] = [
    ['solana', 'tvl_usd', 10, 'USD'],
    ['solana', 'stablecoin_supply_usd', 20, 'USD'],
    ['solana', 'dex_volume_24h_usd', 30, 'USD'],
    ['global', 'global_market_cap_usd', 40, 'USD'],
    ['global', 'btc_dominance_pct', 50, 'FRACTION'],
  ].map(([scope, metric, value, unit]) => ({
    scope: scope as string,
    metric: metric as string,
    value: value as number,
    unit: unit as string,
    collectedAt: new Date('2026-11-05T10:00:00.000Z'),
    ageMs: 2 * 60 * 60 * 1000,
    stale: false,
  }));

  const latestPrices: LatestPriceValue[] = [
    ['solana', 101],
    ['bitcoin', 50100],
    ['ethereum', 3010],
  ].map(([asset, value]) => ({
    asset: asset as string,
    priceUsd: value as number,
    collectedAt: new Date('2026-11-05T10:00:00.000Z'),
    ageMs: 2 * 60 * 60 * 1000,
    stale: false,
  }));

  const daily: DailyMetricValue[] = [
    ['solana', 'tvl_usd', 11, 'USD', '2026-11-04T00:00:00.000Z'],
    ['solana', 'stablecoin_supply_usd', 21, 'USD', '2026-11-04T00:00:00.000Z'],
    ['solana', 'dex_volume_daily_usd', 31, 'USD', '2026-11-03T00:00:00.000Z'],
  ].map(([scope, metric, value, unit, asOf]) => ({
    scope: scope as string,
    metric: metric as string,
    value: value as number,
    unit: unit as string,
    asOf: new Date(asOf as string),
  }));

  const rolling: RollingHourlyValue[] = [
    {
      scope: 'solana',
      metric: 'dex_volume_24h_usd',
      current: 123,
      currentAt: new Date('2026-11-05T10:00:00.000Z'),
      referenceMean: 100,
      relativeDeviation: 0.23,
      referencePoints: 7,
      updatesOnceDaily: true,
      lastChangeAt: new Date('2026-11-05T00:00:00.000Z'),
    },
  ];

  return { hourly, latestPrices, daily, rolling };
}

interface FakeMetricSnapshotRow {
  scope: string;
  metric: string;
  value: unknown;
  collectedAt: Date;
  sourceTs: Date | null;
  source: { provider: string } | null;
}

interface FakeIndicatorSnapshotRow {
  indicator: string;
  scope: string;
  formulaVersion: string;
  status: string;
  value: unknown;
  unit: string | null;
  asOf: Date;
}

interface FakeMetricFindManyArgs {
  where: {
    scope?: string;
    metric?: { in?: readonly string[] };
    source?: { provider?: string };
    sourceTs?: { gte?: Date; lt?: Date; lte?: Date };
  };
}

interface FakeMarketSnapshotRow {
  asset: string;
  priceUsd: unknown;
  volume24hUsd: unknown;
  collectedAt: Date;
  sourceTs: Date;
  source: { provider: string };
}

interface FakeMarketFindManyArgs {
  where: {
    asset?: { in?: readonly string[] };
    source?: { provider?: string };
    sourceTs?: { gte?: Date; lt?: Date; lte?: Date };
  };
}

interface FakeIndicatorFindManyArgs {
  where: {
    asOf?: { gte?: Date; lte?: Date };
    OR?: readonly {
      indicator: string;
      scope: string;
      formulaVersion: string;
    }[];
  };
}

function fakeMarketStructureClient(
  marketRows: readonly FakeMarketSnapshotRow[],
  indicatorRows: readonly FakeIndicatorSnapshotRow[]
): {
  client: unknown;
  marketCalls: FakeMarketFindManyArgs[];
  indicatorCalls: FakeIndicatorFindManyArgs[];
} {
  const marketCalls: FakeMarketFindManyArgs[] = [];
  const indicatorCalls: FakeIndicatorFindManyArgs[] = [];
  const client = {
    marketSnapshot: {
      findMany: async (args: FakeMarketFindManyArgs) => {
        marketCalls.push(args);
        return marketRows.filter((row) => {
          const where = args.where;
          if (
            where.asset?.in !== undefined &&
            !where.asset.in.includes(row.asset)
          ) {
            return false;
          }
          if (
            where.source?.provider !== undefined &&
            row.source.provider !== where.source.provider
          ) {
            return false;
          }
          const sourceTs = row.sourceTs.getTime();
          if (
            where.sourceTs?.gte !== undefined &&
            sourceTs < where.sourceTs.gte.getTime()
          ) {
            return false;
          }
          if (
            where.sourceTs?.lt !== undefined &&
            sourceTs >= where.sourceTs.lt.getTime()
          ) {
            return false;
          }
          if (
            where.sourceTs?.lte !== undefined &&
            sourceTs > where.sourceTs.lte.getTime()
          ) {
            return false;
          }
          return true;
        });
      },
    },
    indicatorSnapshot: {
      findMany: async (args: FakeIndicatorFindManyArgs) => {
        indicatorCalls.push(args);
        return indicatorRows.filter((row) => {
          const where = args.where;
          const asOf = row.asOf.getTime();
          if (
            where.asOf?.gte !== undefined &&
            asOf < where.asOf.gte.getTime()
          ) {
            return false;
          }
          if (
            where.asOf?.lte !== undefined &&
            asOf > where.asOf.lte.getTime()
          ) {
            return false;
          }
          if (where.OR !== undefined) {
            return where.OR.some(
              (target) =>
                target.indicator === row.indicator &&
                target.scope === row.scope &&
                target.formulaVersion === row.formulaVersion
            );
          }
          return true;
        });
      },
    },
  };
  return { client, marketCalls, indicatorCalls };
}

function marketStructureFixtureRows(): {
  marketRows: FakeMarketSnapshotRow[];
  indicatorRows: FakeIndicatorSnapshotRow[];
} {
  const at = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
  const market = (
    asset: string,
    date: string,
    priceUsd: unknown,
    volume24hUsd: unknown,
    collectedAt: string,
    provider = 'coingecko_history'
  ): FakeMarketSnapshotRow => ({
    asset,
    priceUsd,
    volume24hUsd,
    collectedAt: at(collectedAt),
    sourceTs: at(date),
    source: { provider },
  });
  const leverage = (
    indicator: string,
    scope: string,
    date: string,
    value: number,
    unit: string
  ): FakeIndicatorSnapshotRow => ({
    indicator,
    scope,
    formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
    status: 'ok',
    value,
    unit,
    asOf: at(date),
  });
  const ratio = (
    scope: string,
    date: string,
    value: number
  ): FakeIndicatorSnapshotRow => ({
    indicator: 'relative_strength_7d',
    scope,
    formulaVersion: INDICATOR_FORMULA_VERSION,
    status: 'ok',
    value,
    unit: 'FRACTION',
    asOf: at(date),
  });

  return {
    marketRows: [
      market('solana', '2026-08-07', 1, 1, '2026-08-08'),
      market('solana', '2026-08-08', 100, 1000, '2026-08-09'),
      market('solana', '2026-08-09', 999, 999, '2026-08-10', 'coingecko'),
      market('solana', '2026-08-10', 120, 1200, '2026-08-11'),
      market('solana', '2026-11-03', 50, null, '2026-11-04'),
      market('solana', '2026-11-04', null, 130, '2026-11-05'),
      market('solana', '2026-11-05', 190, null, '2026-11-05'),
      market('solana', '2026-11-05', 200, null, '2026-11-06'),
      market('solana', '2026-11-06', 300, 3000, '2026-11-07'),
      market('bitcoin', '2026-11-05', 50000, 500, '2026-11-06'),
      market('ethereum', '2026-11-05', 3000, 300, '2026-11-06'),
    ],
    indicatorRows: [
      leverage('oi_usd_change_1d_pct', 'coinalyze:SOL', '2026-11-01', 1, 'PERCENT'),
      leverage('oi_usd_change_7d_pct', 'coinalyze:SOL', '2026-11-01', 2, 'PERCENT'),
      leverage('funding_7d_mean', 'coinalyze:SOL', '2026-11-01', 3, 'PERCENT'),
      leverage('long_short_ratio_7d_mean', 'coinalyze:SOL', '2026-11-01', 1.5, 'RATIO'),
      leverage('liq_total_vs_mean7d_pct', 'coinalyze:SOL', '2026-11-01', 4, 'PERCENT'),
      leverage('liq_long_share_pct', 'coinalyze:SOL', '2026-11-01', 55, 'PERCENT'),
      leverage('oi_usd_change_1d_pct', 'coinalyze:BTC', '2026-11-01', 10, 'PERCENT'),
      ratio('solana:bitcoin', '2026-11-02', 0.03),
      ratio('solana:ethereum', '2026-11-02', 0.02),
    ],
  };
}

function fakeOnchainClient(
  metricRows: readonly FakeMetricSnapshotRow[],
  indicatorRows: readonly FakeIndicatorSnapshotRow[]
): { client: unknown; metricCalls: FakeMetricFindManyArgs[] } {
  const metricCalls: FakeMetricFindManyArgs[] = [];
  const client = {
    metricSnapshot: {
      findMany: async (args: FakeMetricFindManyArgs) => {
        metricCalls.push(args);
        return metricRows.filter((row) => {
          const where = args.where;
          if (where.scope !== undefined && row.scope !== where.scope) {
            return false;
          }
          if (
            where.metric?.in !== undefined &&
            !where.metric.in.includes(row.metric)
          ) {
            return false;
          }
          if (
            where.source?.provider !== undefined &&
            row.source?.provider !== where.source.provider
          ) {
            return false;
          }
          const sourceTs = row.sourceTs?.getTime();
          if (
            where.sourceTs?.gte !== undefined &&
            (sourceTs === undefined ||
              sourceTs < where.sourceTs.gte.getTime())
          ) {
            return false;
          }
          if (
            where.sourceTs?.lt !== undefined &&
            (sourceTs === undefined ||
              sourceTs >= where.sourceTs.lt.getTime())
          ) {
            return false;
          }
          if (
            where.sourceTs?.lte !== undefined &&
            (sourceTs === undefined ||
              sourceTs > where.sourceTs.lte.getTime())
          ) {
            return false;
          }
          return true;
        });
      },
    },
    indicatorSnapshot: {
      findMany: async () => indicatorRows,
    },
  };
  return { client, metricCalls };
}

function onchainFixtureRows(): {
  metricRows: FakeMetricSnapshotRow[];
  indicatorRows: FakeIndicatorSnapshotRow[];
} {
  const at = (date: string): Date => new Date(`${date}T00:00:00.000Z`);
  const history = (
    metric: string,
    date: string,
    value: number,
    collectedAt: string,
    provider = 'defillama_history'
  ): FakeMetricSnapshotRow => ({
    scope: 'solana',
    metric,
    value,
    collectedAt: at(collectedAt),
    sourceTs: at(date),
    source: { provider },
  });
  const indicator = (
    name: string,
    date: string,
    value: number,
    unit = 'FRACTION',
    status = 'ok'
  ): FakeIndicatorSnapshotRow => ({
    indicator: name,
    scope: 'solana',
    formulaVersion: 'v1',
    status,
    value,
    unit,
    asOf: at(date),
  });

  return {
    metricRows: [
      history('tvl_usd', '2026-08-06', 50, '2026-08-07'),
      history('tvl_usd', '2026-08-07', 100, '2026-08-08'),
      history('tvl_usd', '2026-08-09', 120, '2026-08-10'),
      history('tvl_usd', '2026-08-10', 999, '2026-08-11', 'defillama'),
      history('tvl_usd', '2026-11-04', 190, '2026-11-04'),
      history('tvl_usd', '2026-11-04', 200, '2026-11-05'),
      history('tvl_usd', '2026-11-05', 300, '2026-11-06'),
      history('stablecoin_supply_usd', '2026-08-07', 1000, '2026-08-08'),
      history('stablecoin_supply_usd', '2026-09-01', 1100, '2026-09-02'),
      history('stablecoin_supply_usd', '2026-11-04', 1200, '2026-11-05'),
      history('dex_volume_daily_usd', '2026-08-07', 10, '2026-08-08'),
      history('dex_volume_daily_usd', '2026-08-10', 20, '2026-08-11'),
      history('dex_volume_daily_usd', '2026-11-02', 30, '2026-11-03'),
    ],
    indicatorRows: [
      indicator('tvl_vs_mean_7d', '2026-08-07', 0.05),
      indicator('tvl_vs_mean_7d', '2026-08-09', 0.07),
      indicator('stablecoin_supply_vs_mean_7d', '2026-09-01', -0.02),
      indicator('dex_volume_vs_mean_7d', '2026-11-02', 0.123),
    ],
  };
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      collectKeys(item, keys);
    }
  }
  return keys;
}

async function main(): Promise<void> {
  const expectedKeys = [
    'overview',
    'onchain',
    'health',
    'leverage-macro',
    'launchpads',
    'tokens',
    'market-structure',
    'macro',
  ];
  check(
    'snapshot key whitelist is exact',
    JSON.stringify(SNAPSHOT_KEYS) === JSON.stringify(expectedKeys)
  );
  for (const key of expectedKeys) {
    check(`${key} is an allowed snapshot key`, isSnapshotKey(key));
  }
  check(
    'unknown snapshot key is rejected',
    throws(() => assertSnapshotKey('unknown'), /Invalid snapshot key/)
  );

  const oversized = { data: 'x'.repeat(MAX_PAYLOAD_BYTES) };
  const withinLimit = { data: 'x'.repeat(MAX_PAYLOAD_BYTES - 100) };
  check(
    'payload above 500 KB is rejected',
    throws(() => assertPayloadSize(oversized), /500 KB/)
  );
  check(
    'payload within 500 KB is accepted',
    !throws(() => assertPayloadSize(withinLimit))
  );

  const writerUrl = new URL(
    'postgresql://snapshot_writer:super-secret@db.example:5432/forum'
  );
  check(
    'snapshot_writer user is accepted',
    !throws(() => assertSnapshotWriterUser(writerUrl))
  );
  check(
    'snapshot_writer prefix is accepted',
    !throws(() =>
      assertSnapshotWriterUser(
        new URL('postgresql://snapshot_writer_extra:secret@db.example/db')
      )
    )
  );
  check(
    'non snapshot_writer user is rejected',
    throws(
      () =>
        assertSnapshotWriterUser(
          new URL('postgresql://reader:secret@db.example/db')
        ),
      /snapshot_writer/
    )
  );

  check(
    'SQL uses one INSERT with ON CONFLICT key update',
    SNAPSHOT_INSERT_SQL.includes('INSERT INTO "DashboardSnapshot"') &&
      SNAPSHOT_INSERT_SQL.includes('ON CONFLICT ("key") DO UPDATE')
  );
  for (const column of ['id', 'key', 'payload', 'generatedAt', 'updatedAt']) {
    check(
      `SQL writes the ${column} column`,
      SNAPSHOT_INSERT_SQL.includes(`"${column}"`)
    );
  }
  check(
    'SQL casts payload to jsonb',
    SNAPSHOT_INSERT_SQL.includes('$3::jsonb')
  );
  check(
    'SQL has no DELETE',
    !/\bDELETE\b/i.test(SNAPSHOT_INSERT_SQL)
  );
  check(
    'SQL is a single statement',
    (SNAPSHOT_INSERT_SQL.match(/;/g) ?? []).length === 1
  );

  const calls: { sql: string; values: unknown[] }[] = [];
  const fakePool = {
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values: values ?? [] });
      return { rows: [], rowCount: 1 };
    },
  };
  await writeSnapshot(
    fakePool as never,
    'overview',
    { ok: true },
    new Date('2026-11-05T12:00:00.000Z')
  );
  check('write executes exactly one query', calls.length === 1);
  check('write uses the snapshot SQL', calls[0]?.sql === SNAPSHOT_INSERT_SQL);
  check('write fills five parameters', calls[0]?.values.length === 5);
  check('write uses the overview key', calls[0]?.values[1] === 'overview');
  check('write serializes the payload', calls[0]?.values[2] === '{"ok":true}');
  check(
    'write uses ISO timestamps',
    calls[0]?.values[3] === '2026-11-05T12:00:00.000Z' &&
      calls[0]?.values[4] === '2026-11-05T12:00:00.000Z'
  );
  check(
    'write generates a UUID id',
    typeof calls[0]?.values[0] === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        calls[0]?.values[0] as string
      )
  );

  const readers = overviewReaders();
  const snapshot = buildOverviewPayload(
    overviewInput(),
    readers.hourly,
    readers.latestPrices,
    readers.daily,
    readers.rolling,
    new Date('2026-11-05T12:34:56.789Z')
  );
  const topLevel = Object.keys(snapshot).sort();
  check(
    'overview snapshot has the exact top-level fields',
    JSON.stringify(topLevel) ===
      JSON.stringify(
        [
          'generatedAt',
          'asOf',
          'prices',
          'marketActivity',
          'rollingActivity',
          'regime',
          'onchainLiquidity',
          'sinceLastClose',
          'dataDates',
        ].sort()
      )
  );

  const keys = collectKeys(snapshot);
  for (const forbidden of [
    'rawPayload',
    'inputCount',
    'age',
    'ageMs',
    'stale',
    'return1d',
    'return7d',
    'current',
    'currentAt',
    'referencePoints',
  ]) {
    check(`overview snapshot omits ${forbidden}`, !keys.has(forbidden));
  }

  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  check('generatedAt is ISO 8601 UTC', iso.test(snapshot.generatedAt));
  check('asOf is ISO 8601 UTC', iso.test(snapshot.asOf));
  check(
    'closed price date is ISO 8601 UTC',
    snapshot.prices[0]?.closed.asOf !== null &&
      iso.test(snapshot.prices[0]?.closed.asOf as string)
  );
  check(
    'latest price date is ISO 8601 UTC',
    snapshot.prices[0]?.latest.collectedAt !== null &&
      iso.test(snapshot.prices[0]?.latest.collectedAt as string)
  );
  check(
    'market closed date is ISO 8601 UTC',
    snapshot.marketActivity[0]?.closed.asOf !== null &&
      iso.test(snapshot.marketActivity[0]?.closed.asOf as string)
  );
  check(
    'market latest date is ISO 8601 UTC',
    snapshot.marketActivity[0]?.latest.collectedAt !== null &&
      iso.test(snapshot.marketActivity[0]?.latest.collectedAt as string)
  );

  const tvlActivity = snapshot.marketActivity.find(
    (row) => row.metric === 'tvl_usd'
  );
  const stablecoinActivity = snapshot.marketActivity.find(
    (row) => row.metric === 'stablecoin_supply_usd'
  );
  const dexActivity = snapshot.marketActivity.find(
    (row) => row.metric === 'dex_volume_24h_usd'
  );
  const globalMarketCapActivity = snapshot.marketActivity.find(
    (row) => row.metric === 'global_market_cap_usd'
  );
  const btcDominanceActivity = snapshot.marketActivity.find(
    (row) => row.metric === 'btc_dominance_pct'
  );

  check(
    'market TVL closed comes from the tvl_usd daily metric',
    tvlActivity?.closed.value === 11 &&
      tvlActivity.closed.asOf === '2026-11-04T00:00:00.000Z'
  );
  check(
    'market Stablecoins closed comes from the stablecoin_supply_usd daily metric',
    stablecoinActivity?.closed.value === 21 &&
      stablecoinActivity.closed.asOf === '2026-11-04T00:00:00.000Z'
  );
  check(
    'market DEX volume closed comes from the dex_volume_daily_usd daily metric',
    dexActivity?.closed.value === 31 &&
      dexActivity.closed.asOf === '2026-11-03T00:00:00.000Z'
  );
  check(
    'market DEX volume latest still comes from dex_volume_24h_usd',
    dexActivity?.metric === 'dex_volume_24h_usd' &&
      dexActivity.label === 'DEX volume 24h' &&
      dexActivity.latest.value === 30
  );
  check(
    'global market cap and BTC dominance closed stay null',
    globalMarketCapActivity?.closed.value === null &&
      globalMarketCapActivity.closed.asOf === null &&
      btcDominanceActivity?.closed.value === null &&
      btcDominanceActivity.closed.asOf === null
  );

  const marketKeys = Object.keys(snapshot.marketActivity[0] ?? {}).sort();
  const closedKeys = Object.keys(snapshot.marketActivity[0]?.closed ?? {}).sort();
  const latestKeys = Object.keys(snapshot.marketActivity[0]?.latest ?? {}).sort();
  check(
    'market activity keeps only the snapshot fields',
    JSON.stringify(marketKeys) ===
      JSON.stringify(['closed', 'label', 'latest', 'metric', 'scope']) &&
      JSON.stringify(closedKeys) ===
        JSON.stringify(['asOf', 'unit', 'value']) &&
      JSON.stringify(latestKeys) ===
        JSON.stringify(['collectedAt', 'unit', 'value'])
  );

  const missingDailySnapshot = buildOverviewPayload(
    overviewInput(),
    readers.hourly,
    readers.latestPrices,
    [],
    readers.rolling,
    new Date('2026-11-05T12:34:56.789Z')
  );
  check(
    'missing market closed values are null, never zero',
    missingDailySnapshot.marketActivity.every(
      (row) => row.closed.value === null && row.closed.asOf === null
    )
  );

  check(
    'rolling last change is ISO 8601 UTC',
    snapshot.rollingActivity[0]?.lastChangeAt !== null &&
      iso.test(snapshot.rollingActivity[0]?.lastChangeAt as string)
  );
  check(
    'since last close close date is ISO 8601 UTC',
    snapshot.sinceLastClose[0]?.closeDate !== null &&
      iso.test(snapshot.sinceLastClose[0]?.closeDate as string)
  );
  check(
    'since last close latest date is ISO 8601 UTC',
    snapshot.sinceLastClose[0]?.latestDate !== null &&
      iso.test(snapshot.sinceLastClose[0]?.latestDate as string)
  );
  check(
    'data dates are ISO 8601 UTC',
    snapshot.dataDates.every(
      (row) => row.date !== null && iso.test(row.date)
    )
  );

  const serialized = JSON.stringify(snapshot);
  check(
    'serialized overview has no forbidden fields',
    !/"(?:rawPayload|inputCount|age|ageMs|stale)"/.test(serialized)
  );
  check(
    'overview has five since-last-close rows',
    snapshot.sinceLastClose.length === 5
  );
  check(
    'overview has the ratio rows',
    snapshot.sinceLastClose.some((row) => row.label === 'SOL/BTC') &&
      snapshot.sinceLastClose.some((row) => row.label === 'SOL/ETH')
  );

  const extendedRegimeInput: RecapInput = {
    ...overviewInput(),
    regime: {
      regimeId: 'range_neutral',
      reason: 'test reason',
      decidedBy: {
        sol_trend: 'range',
        sol_relative_strength: 'neutral',
      },
      context: {
        spot: 'calm',
        onchain_liquidity: 'normal',
        launchpads: 'quiet',
      },
    },
  };
  const extendedSnapshot = buildOverviewPayload(
    extendedRegimeInput,
    readers.hourly,
    readers.latestPrices,
    readers.daily,
    readers.rolling,
    new Date('2026-11-05T12:34:56.789Z')
  );
  check(
    'overview regime passes decidedBy and context through',
    JSON.stringify(extendedSnapshot.regime.decidedBy) ===
      JSON.stringify({
        sol_trend: 'range',
        sol_relative_strength: 'neutral',
      }) &&
      JSON.stringify(extendedSnapshot.regime.context) ===
        JSON.stringify({
          spot: 'calm',
          onchain_liquidity: 'normal',
          launchpads: 'quiet',
        })
  );
  check(
    'overview regime without decidedBy and context keeps them null',
    snapshot.regime.decidedBy === null && snapshot.regime.context === null
  );
  check(
    'overview regime has no evidence or rule text fields',
    !/"(?:evidence|thresholdsUsed|ruleDescription|STATE_RULE_DOC)"/.test(
      JSON.stringify(extendedSnapshot.regime)
    )
  );
  check(
    'formatRecap ignores regime decidedBy and context',
    formatRecap(extendedRegimeInput) ===
      formatRecap({
        ...overviewInput(),
        regime: { regimeId: 'range_neutral', reason: 'test reason' },
      })
  );

  const onchainLiquidityInput: RecapInput = {
    ...overviewInput(),
    onchainLiquidity: {
      classification: 'expanding',
      legs: {
        stablecoins: 'expanding',
        tvl: 'neutral',
        dex_volume: 'contracting',
      },
    },
  };
  const onchainLiquiditySnapshot = buildOverviewPayload(
    onchainLiquidityInput,
    readers.hourly,
    readers.latestPrices,
    readers.daily,
    readers.rolling,
    new Date('2026-11-05T12:34:56.789Z')
  );
  check(
    'overview onchainLiquidity passes classification and legs through',
    JSON.stringify(onchainLiquiditySnapshot.onchainLiquidity) ===
      JSON.stringify(onchainLiquidityInput.onchainLiquidity)
  );
  check(
    'overview onchainLiquidity is null when input is absent',
    snapshot.onchainLiquidity === null
  );
  check(
    'overview onchainLiquidity has no values, evidence or rule text fields',
    !/"(?:value|status|stale|asOf|evidence|ruleDescription|rulesApplied|thresholdsUsed|STATE_RULE_DOC)"/.test(
      JSON.stringify(onchainLiquiditySnapshot.onchainLiquidity)
    )
  );
  check(
    'formatRecap ignores onchainLiquidity',
    formatRecap(onchainLiquidityInput) === formatRecap(overviewInput())
  );

  const stateRegime = regimeFromStateRows([
    {
      computeMode: 'live',
      payload: {
        regime: {
          regimeId: 'range_neutral',
          reason: 'test reason',
          decidedBy: {
            sol_trend: 'range',
            sol_relative_strength: 'neutral',
          },
          context: {
            spot: 'calm',
            onchain_liquidity: 'normal',
            launchpads: 'quiet',
          },
        },
      },
    },
  ]);
  check(
    'regimeFromStateRows reads decidedBy and context',
    stateRegime?.decidedBy?.sol_trend === 'range' &&
      stateRegime.decidedBy.sol_relative_strength === 'neutral' &&
      stateRegime.context?.spot === 'calm' &&
      stateRegime.context.onchain_liquidity === 'normal' &&
      stateRegime.context.launchpads === 'quiet'
  );

  const oldStateRegime = regimeFromStateRows([
    {
      computeMode: 'live',
      payload: {
        regime: {
          regimeId: 'range_neutral',
          reason: 'old payload',
        },
      },
    },
  ]);
  check(
    'regimeFromStateRows returns null for old payloads without decidedBy and context',
    oldStateRegime?.decidedBy === null && oldStateRegime.context === null
  );

  const invalidStateRegime = regimeFromStateRows([
    {
      computeMode: 'live',
      payload: {
        regime: {
          regimeId: 'range_neutral',
          reason: 'invalid decidedBy',
          decidedBy: {
            sol_trend: 'range',
            sol_relative_strength: 1,
          },
          context: {
            spot: 'calm',
            onchain_liquidity: 'normal',
            launchpads: 'quiet',
          },
        },
      },
    },
  ]);
  check(
    'regimeFromStateRows returns null when a decidedBy value is not a string',
    invalidStateRegime?.decidedBy === null &&
      invalidStateRegime.context?.spot === 'calm'
  );

  const missingContextKeyRegime = regimeFromStateRows([
    {
      computeMode: 'live',
      payload: {
        regime: {
          regimeId: 'range_neutral',
          reason: 'missing context key',
          decidedBy: {
            sol_trend: 'range',
            sol_relative_strength: 'neutral',
          },
          context: {
            spot: 'calm',
            onchain_liquidity: 'normal',
          },
        },
      },
    },
  ]);
  check(
    'regimeFromStateRows returns null when a context key is missing',
    missingContextKeyRegime?.context === null &&
      missingContextKeyRegime.decidedBy?.sol_trend === 'range'
  );

  const stateLiquidity = onchainLiquidityFromStateRows([
    {
      computeMode: 'live',
      payload: {
        onchain_liquidity: {
          classification: 'expanding',
          evidence: [
            {
              indicator: 'stablecoin_supply_vs_mean_7d',
              scope: 'solana',
              role: 'decides',
              legClassification: 'expanding',
            },
            {
              indicator: 'tvl_vs_mean_7d',
              scope: 'solana',
              role: 'decides',
              legClassification: 'neutral',
            },
            {
              indicator: 'dex_volume_vs_mean_7d',
              scope: 'solana',
              role: 'decides',
              legClassification: 'contracting',
            },
          ],
        },
      },
    },
  ]);
  check(
    'onchainLiquidityFromStateRows reads classification and all legs',
    stateLiquidity?.classification === 'expanding' &&
      stateLiquidity.legs.stablecoins === 'expanding' &&
      stateLiquidity.legs.tvl === 'neutral' &&
      stateLiquidity.legs.dex_volume === 'contracting'
  );

  const oldStateLiquidity = onchainLiquidityFromStateRows([
    {
      computeMode: 'live',
      payload: {
        regime: {
          regimeId: 'range_neutral',
        },
      },
    },
  ]);
  check(
    'onchainLiquidityFromStateRows returns null for old payloads',
    oldStateLiquidity === null
  );

  const invalidLegLiquidity = onchainLiquidityFromStateRows([
    {
      computeMode: 'live',
      payload: {
        onchain_liquidity: {
          classification: 'neutral',
          evidence: [
            {
              indicator: 'stablecoin_supply_vs_mean_7d',
              scope: 'solana',
              role: 'decides',
              legClassification: 1,
            },
            {
              indicator: 'tvl_vs_mean_7d',
              scope: 'solana',
              role: 'decides',
              legClassification: 'expanding',
            },
          ],
        },
      },
    },
  ]);
  check(
    'onchainLiquidityFromStateRows nulls a non-string leg without dropping the others',
    invalidLegLiquidity?.legs.stablecoins === null &&
      invalidLegLiquidity.legs.tvl === 'expanding' &&
      invalidLegLiquidity.legs.dex_volume === null
  );

  const ignoredRoleLiquidity = onchainLiquidityFromStateRows([
    {
      computeMode: 'live',
      payload: {
        onchain_liquidity: {
          classification: 'expanding',
          evidence: [
            {
              indicator: 'stablecoin_supply_vs_mean_7d',
              scope: 'solana',
              role: 'context',
              legClassification: 'contracting',
            },
            {
              indicator: 'tvl_vs_mean_7d',
              scope: 'solana',
              role: 'decides',
              legClassification: 'expanding',
            },
            {
              indicator: 'dex_volume_vs_mean_7d',
              scope: 'ethereum',
              role: 'decides',
              legClassification: 'contracting',
            },
          ],
        },
      },
    },
  ]);
  check(
    'onchainLiquidityFromStateRows ignores evidence that is not decides on solana',
    ignoredRoleLiquidity?.legs.stablecoins === null &&
      ignoredRoleLiquidity.legs.tvl === 'expanding' &&
      ignoredRoleLiquidity.legs.dex_volume === null
  );

  const orderedLiquidity = onchainLiquidityFromStateRows([
    {
      computeMode: 'backfill',
      payload: {
        onchain_liquidity: {
          classification: 'contracting',
          evidence: [],
        },
      },
    },
    {
      computeMode: 'live',
      payload: {
        onchain_liquidity: {
          classification: 'expanding',
          evidence: [],
        },
      },
    },
  ]);
  check(
    'onchainLiquidityFromStateRows prefers live rows over backfill rows',
    orderedLiquidity?.classification === 'expanding'
  );

  const onchainFixture = onchainFixtureRows();
  const onchainFake = fakeOnchainClient(
    onchainFixture.metricRows,
    onchainFixture.indicatorRows
  );
  const onchainSnapshot = await buildOnchainSnapshot(
    onchainFake.client as never,
    new Date('2026-11-05T12:34:56.789Z')
  );
  const onchainById = new Map(
    onchainSnapshot.metrics.map((metric) => [metric.id, metric])
  );
  const onchainTvl = onchainById.get('tvl');
  const onchainStablecoins = onchainById.get('stablecoins');
  const onchainDex = onchainById.get('dex_volume');

  check(
    'onchain metrics use the fixed order and labels',
    JSON.stringify(
      onchainSnapshot.metrics.map((metric) => [metric.id, metric.label])
    ) ===
      JSON.stringify([
        ['tvl', 'TVL'],
        ['stablecoins', 'Stablecoins'],
        ['dex_volume', 'DEX volume'],
      ]) &&
      onchainSnapshot.metrics.every((metric) => metric.usdUnit === 'USD')
  );
  check(
    'onchain snapshot uses a 90-day window ending at asOf',
    onchainSnapshot.asOf === '2026-11-04' &&
      onchainSnapshot.windowDays === 90
  );
  check(
    'onchain USD series are ascending and keep missing days unfilled',
    JSON.stringify(onchainTvl?.usd) ===
      JSON.stringify([
        { date: '2026-08-07', value: 100 },
        { date: '2026-08-09', value: 120 },
        { date: '2026-11-04', value: 200 },
      ]) &&
      JSON.stringify(onchainStablecoins?.usd) ===
        JSON.stringify([
          { date: '2026-08-07', value: 1000 },
          { date: '2026-09-01', value: 1100 },
          { date: '2026-11-04', value: 1200 },
        ]) &&
      JSON.stringify(onchainDex?.usd) ===
        JSON.stringify([
          { date: '2026-08-07', value: 10 },
          { date: '2026-08-10', value: 20 },
          { date: '2026-11-02', value: 30 },
        ])
  );
  check(
    'onchain USD query covers the 90-day window',
    onchainFake.metricCalls[0]?.where.sourceTs?.gte
      ?.toISOString()
      .slice(0, 10) === '2026-08-07' &&
      onchainFake.metricCalls[0]?.where.sourceTs?.lt
        ?.toISOString()
        .slice(0, 10) === '2026-11-05'
  );
  check(
    'onchain USD same-day duplicate uses the highest collectedAt',
    onchainTvl?.usd.filter((point) => point.date === '2026-11-04').length ===
      1 && onchainTvl.usd.at(-1)?.value === 200
  );
  check(
    'onchain USD query filters defillama_history and ignores other providers',
    onchainFake.metricCalls[0]?.where.source?.provider ===
      'defillama_history' &&
      !onchainTvl?.usd.some((point) => point.value === 999)
  );
  check(
    'onchain series keep their own final dates without alignment',
    onchainTvl?.usd.at(-1)?.date === '2026-11-04' &&
      onchainStablecoins?.usd.at(-1)?.date === '2026-11-04' &&
      onchainDex?.usd.at(-1)?.date === '2026-11-02'
  );
  check(
    'onchain vsMean7d keeps the fraction value and unit',
    onchainDex?.vsMean7dUnit === 'FRACTION' &&
      onchainDex.vsMean7d[0]?.value === 0.123
  );

  const onchainKeys = collectKeys(onchainSnapshot);
  const allowedOnchainKeys = new Set([
    'generatedAt',
    'asOf',
    'windowDays',
    'metrics',
    'id',
    'label',
    'usdUnit',
    'usd',
    'vsMean7dUnit',
    'vsMean7d',
    'date',
    'value',
  ]);
  check(
    'onchain payload only contains keys from the declared types',
    [...onchainKeys].every((key) => allowedOnchainKeys.has(key))
  );
  for (const forbidden of [
    'status',
    'collectedAt',
    'evidence',
    'ruleDescription',
    'rawPayload',
  ]) {
    check(`onchain payload omits ${forbidden}`, !onchainKeys.has(forbidden));
  }

  const fullOnchainPoints = Array.from({ length: 90 }, (_, index) => ({
    date: new Date(
      new Date('2026-08-07T00:00:00.000Z').getTime() +
        index * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10),
    value: index + 0.5,
  }));
  const fullOnchainSnapshot = buildOnchainPayload(
    {
      asOf: '2026-11-04',
      metrics: (['tvl', 'stablecoins', 'dex_volume'] as const).map((id) => ({
        id,
        usd: fullOnchainPoints,
        vsMean7d: fullOnchainPoints,
        vsMean7dUnit: 'FRACTION',
      })),
    },
    new Date('2026-11-05T12:34:56.789Z')
  );
  const fullOnchainBytes = Buffer.byteLength(
    JSON.stringify(fullOnchainSnapshot),
    'utf8'
  );
  check(
    'onchain 90-day payload fits MAX_PAYLOAD_BYTES',
    fullOnchainBytes <= MAX_PAYLOAD_BYTES,
    `(${fullOnchainBytes} bytes)`
  );

  const onchainSource = readFileSync(
    new URL('./onchain.ts', import.meta.url),
    'utf8'
  );
  check(
    'onchain builder has no database write calls',
    !/\b(?:create|update|delete|upsert|executeRaw|queryRaw)\b/.test(
      onchainSource
    )
  );

  const marketFixture = marketStructureFixtureRows();
  const marketFake = fakeMarketStructureClient(
    marketFixture.marketRows,
    marketFixture.indicatorRows
  );
  const marketSnapshot = await buildMarketStructureSnapshot(
    marketFake.client as never,
    new Date('2026-11-05T12:34:56.789Z')
  );
  const marketSolana = marketSnapshot.assets.find(
    (asset) => asset.id === 'solana'
  );
  const marketSolanaOi = marketSolana?.leverage.find(
    (series) => series.id === 'oi_change_1d'
  );
  const marketSolBtc = marketSnapshot.relativeStrength.find(
    (ratio) => ratio.id === 'sol_btc'
  );

  check(
    'market-structure uses a 90-day window ending at asOf',
    marketSnapshot.asOf === '2026-11-04' &&
      marketSnapshot.windowDays === 90
  );
  check(
    'market-structure assets use the fixed order and labels',
    JSON.stringify(
      marketSnapshot.assets.map((asset) => [asset.id, asset.label])
    ) ===
      JSON.stringify([
        ['solana', 'SOL'],
        ['bitcoin', 'BTC'],
        ['ethereum', 'ETH'],
      ])
  );
  check(
    'market-structure price is ascending and keeps missing days unfilled',
    JSON.stringify(marketSolana?.price) ===
      JSON.stringify([
        { date: '2026-08-07', value: 100 },
        { date: '2026-08-09', value: 120 },
        { date: '2026-11-02', value: 50 },
        { date: '2026-11-04', value: 200 },
      ])
  );
  check(
    'market-structure spot volume is ascending and keeps missing days unfilled',
    JSON.stringify(marketSolana?.spotVolume) ===
      JSON.stringify([
        { date: '2026-08-07', value: 1000 },
        { date: '2026-08-09', value: 1200 },
        { date: '2026-11-03', value: 130 },
      ])
  );
  check(
    'market-structure price query covers the 90-day window',
    marketFake.marketCalls[0]?.where.sourceTs?.gte
      ?.toISOString()
      .slice(0, 10) === '2026-08-08' &&
      marketFake.marketCalls[0]?.where.sourceTs?.lte
        ?.toISOString()
        .slice(0, 10) === '2026-11-05'
  );
  const firstWindowDate = new Date(
    new Date('2026-11-04T00:00:00.000Z').getTime() - 89 * 24 * 60 * 60 * 1000
  )
    .toISOString()
    .slice(0, 10);
  check(
    'market-structure first point is asOf minus 89 days',
    marketSolana?.price[0]?.date === firstWindowDate
  );

  const conventionMarket = (
    date: string,
    priceUsd: unknown,
    volume24hUsd: unknown,
    collectedAt: string
  ): FakeMarketSnapshotRow => ({
    asset: 'solana',
    priceUsd,
    volume24hUsd,
    collectedAt: new Date(`${collectedAt}T00:00:00.000Z`),
    sourceTs: new Date(`${date}T00:00:00.000Z`),
    source: { provider: 'coingecko_history' },
  });
  const conventionFake = fakeMarketStructureClient(
    [
      conventionMarket('2026-11-09', 123, 456, '2026-11-09'),
      conventionMarket('2026-11-10', 999, 999, '2026-11-10'),
    ],
    []
  );
  const conventionSnapshot = await buildMarketStructureSnapshot(
    conventionFake.client as never,
    new Date('2026-11-09T12:00:00.000Z')
  );
  const conventionSolana = conventionSnapshot.assets.find(
    (asset) => asset.id === 'solana'
  );
  check(
    'market-structure sourceTs 2026-11-09T00:00Z with asOf 2026-11-08 maps to 2026-11-08',
    JSON.stringify(conventionSolana?.price) ===
      JSON.stringify([{ date: '2026-11-08', value: 123 }]) &&
      JSON.stringify(conventionSolana?.spotVolume) ===
        JSON.stringify([{ date: '2026-11-08', value: 456 }])
  );
  check(
    'market-structure sourceTs 2026-11-10T00:00Z with asOf 2026-11-08 does not enter',
    !conventionSolana?.price.some((point) => point.value === 999) &&
      !conventionSolana?.spotVolume.some((point) => point.value === 999) &&
      !conventionSolana?.price.some((point) => point.date === '2026-11-09')
  );

  const dailyCloseFake = fakeMarketStructureClient(
    [
      conventionMarket('2026-11-06', 89.2316664765679, null, '2026-11-06'),
      conventionMarket('2026-11-07', 90.06013199290226, null, '2026-11-07'),
      conventionMarket('2026-11-08', 89.70181157825633, null, '2026-11-08'),
      conventionMarket('2026-11-09', 86.41327548972107, null, '2026-11-09'),
    ],
    []
  );
  const dailyCloseSnapshot = await buildMarketStructureSnapshot(
    dailyCloseFake.client as never,
    new Date('2026-11-09T12:00:00.000Z')
  );
  const dailyCloseSolana = dailyCloseSnapshot.assets.find(
    (asset) => asset.id === 'solana'
  );
  check(
    'price series uses the DailyClose date convention',
    JSON.stringify(dailyCloseSolana?.price) ===
      JSON.stringify([
        { date: '2026-11-05', value: 89.2316664765679 },
        { date: '2026-11-06', value: 90.06013199290226 },
        { date: '2026-11-07', value: 89.70181157825633 },
        { date: '2026-11-08', value: 86.41327548972107 },
      ])
  );

  check(
    'market-structure same-day duplicate uses the highest collectedAt',
    marketSolana?.price.filter((point) => point.date === '2026-11-04')
      .length === 1 &&
      marketSolana.price.find((point) => point.date === '2026-11-04')
        ?.value === 200
  );
  check(
    'market-structure price query filters coingecko_history',
    marketFake.marketCalls[0]?.where.source?.provider === 'coingecko_history'
  );
  check(
    'market-structure never uses coingecko provider rows',
    !marketSolana?.price.some((point) => point.value === 999) &&
      !marketSolana?.spotVolume.some((point) => point.value === 999)
  );
  check(
    'market-structure excludes the partial current day',
    !marketSolana?.price.some((point) => point.date === '2026-11-05') &&
      !marketSolana?.spotVolume.some((point) => point.date === '2026-11-05')
  );
  check(
    'market-structure null price skips only the price day',
    !marketSolana?.price.some((point) => point.date === '2026-11-03') &&
      Boolean(
        marketSolana?.spotVolume.some(
          (point) => point.date === '2026-11-03' && point.value === 130
        )
      )
  );
  check(
    'market-structure null volume skips only the volume day',
    Boolean(
      marketSolana?.price.some(
        (point) => point.date === '2026-11-02' && point.value === 50
      )
    ) &&
      !marketSolana?.spotVolume.some(
        (point) => point.date === '2026-11-02'
      )
  );
  check(
    'market-structure series keep their own final dates',
    marketSolana?.price.at(-1)?.date === '2026-11-04' &&
      marketSolana?.spotVolume.at(-1)?.date === '2026-11-03' &&
      marketSolanaOi?.points.at(-1)?.date === '2026-11-01' &&
      marketSolBtc?.points.at(-1)?.date === '2026-11-02'
  );
  check(
    'market-structure leverage ids and labels are fixed',
    JSON.stringify(
      marketSolana?.leverage.map((series) => [series.id, series.label])
    ) ===
      JSON.stringify([
        ['oi_change_1d', 'OI change 1d'],
        ['oi_change_7d', 'OI change 7d'],
        ['funding_7d_mean', 'Funding 7d mean'],
        ['long_short_ratio_7d_mean', 'Long/short ratio 7d mean'],
        ['liq_total_vs_mean_7d', 'Total liquidations vs 7d mean'],
        ['liq_long_share', 'Long share of liquidations'],
      ])
  );
  check(
    'market-structure leverage maps indicators to the right ids',
    marketSolana?.leverage.map((series) => series.points[0]?.value).join(',') ===
      '1,2,3,1.5,4,55'
  );
  check(
    'market-structure leverage units pass through as returned',
    marketSolana?.leverage.find(
      (series) => series.id === 'long_short_ratio_7d_mean'
    )?.unit === 'RATIO' &&
      marketSolana?.leverage
        .filter((series) => series.id !== 'long_short_ratio_7d_mean')
        .every((series) => series.unit === 'PERCENT')
  );
  check(
    'market-structure relative strength uses solana:bitcoin and solana:ethereum',
    JSON.stringify(
      marketFake.indicatorCalls[0]?.where.OR?.filter(
        (target) => target.indicator === 'relative_strength_7d'
      )
        .map((target) => target.scope)
        .sort()
    ) === JSON.stringify(['solana:bitcoin', 'solana:ethereum'])
  );
  check(
    'market-structure relative strength keeps ids, labels, units and points',
    JSON.stringify(
      marketSnapshot.relativeStrength.map((ratio) => [
        ratio.id,
        ratio.label,
        ratio.unit,
        ratio.points,
      ])
    ) ===
      JSON.stringify([
        [
          'sol_btc',
          'SOL/BTC',
          'FRACTION',
          [{ date: '2026-11-02', value: 0.03 }],
        ],
        [
          'sol_eth',
          'SOL/ETH',
          'FRACTION',
          [{ date: '2026-11-02', value: 0.02 }],
        ],
      ])
  );

  const marketStructureKeys = collectKeys(marketSnapshot);
  const allowedMarketKeys = new Set([
    'generatedAt',
    'asOf',
    'windowDays',
    'assets',
    'relativeStrength',
    'id',
    'label',
    'price',
    'spotVolume',
    'leverage',
    'unit',
    'points',
    'date',
    'value',
  ]);
  check(
    'market-structure payload only contains keys from the declared types',
    [...marketStructureKeys].every((key) => allowedMarketKeys.has(key))
  );
  for (const forbidden of [
    'status',
    'collectedAt',
    'evidence',
    'ruleDescription',
    'rawPayload',
  ]) {
    check(
      `market-structure payload omits ${forbidden}`,
      !marketStructureKeys.has(forbidden)
    );
  }

  const fullMarketPoints = Array.from({ length: 90 }, (_, index) => ({
    date: new Date(
      new Date('2026-08-07T00:00:00.000Z').getTime() +
        index * 24 * 60 * 60 * 1000
    )
      .toISOString()
      .slice(0, 10),
    value: index + 0.5,
  }));
  const fullMarketLeverageIds = [
    'oi_change_1d',
    'oi_change_7d',
    'funding_7d_mean',
    'long_short_ratio_7d_mean',
    'liq_total_vs_mean_7d',
    'liq_long_share',
  ] as const;
  const fullMarketSnapshot = buildMarketStructurePayload(
    {
      asOf: '2026-11-04',
      assets: (['solana', 'bitcoin', 'ethereum'] as const).map((id) => ({
        id,
        price: fullMarketPoints,
        spotVolume: fullMarketPoints,
        leverage: fullMarketLeverageIds.map((leverageId) => ({
          id: leverageId,
          unit: 'PERCENT',
          points: fullMarketPoints,
        })),
      })),
      relativeStrength: (['sol_btc', 'sol_eth'] as const).map((id) => ({
        id,
        unit: 'FRACTION',
        points: fullMarketPoints,
      })),
    },
    new Date('2026-11-05T12:34:56.789Z')
  );
  const fullMarketBytes = Buffer.byteLength(
    JSON.stringify(fullMarketSnapshot),
    'utf8'
  );
  check(
    'market-structure 90-day payload fits MAX_PAYLOAD_BYTES',
    fullMarketBytes <= MAX_PAYLOAD_BYTES,
    `(${fullMarketBytes} bytes)`
  );

  const marketStructureSource = readFileSync(
    new URL('./market-structure.ts', import.meta.url),
    'utf8'
  );
  check(
    'market-structure builder has no database write calls',
    !/\b(?:create|update|delete|upsert|executeRaw|queryRaw)\b/.test(
      marketStructureSource
    )
  );

  const blockedRegimeSnapshot = {
    ...snapshot,
    regime: { ...snapshot.regime, id: null },
  };
  const blockedRegimeReason = publishBlockReason(
    'overview',
    blockedRegimeSnapshot
  );
  check(
    'overview guard blocks when regime is unavailable and cites asOf',
    blockedRegimeReason ===
      `regime not available for asOf ${blockedRegimeSnapshot.asOf}`
  );

  const noClosedPricesSnapshot = {
    ...snapshot,
    regime: { ...snapshot.regime, id: 'range_neutral' },
    prices: snapshot.prices.map((price) => ({
      ...price,
      closed: { ...price.closed, value: null },
    })),
  };
  check(
    'overview guard blocks when every closed price is null',
    publishBlockReason('overview', noClosedPricesSnapshot) ===
      'no closed prices available'
  );
  check(
    'overview guard allows a complete snapshot',
    publishBlockReason('overview', snapshot) === null
  );

  const emptyOnchainSnapshot = {
    ...onchainSnapshot,
    metrics: onchainSnapshot.metrics.map((metric) => ({ ...metric, usd: [] })),
  };
  check(
    'onchain guard blocks when every usd series is empty',
    publishBlockReason('onchain', emptyOnchainSnapshot) ===
      'no onchain series available'
  );

  const partiallyEmptyOnchainSnapshot = {
    ...onchainSnapshot,
    metrics: onchainSnapshot.metrics.map((metric, index) =>
      index === 0 ? { ...metric, usd: [] } : metric
    ),
  };
  check(
    'onchain guard allows a snapshot with only one empty usd series',
    publishBlockReason('onchain', partiallyEmptyOnchainSnapshot) === null
  );

  const emptyMarketSnapshot = {
    ...marketSnapshot,
    assets: marketSnapshot.assets.map((asset) => ({ ...asset, price: [] })),
  };
  check(
    'market-structure guard blocks when every price series is empty',
    publishBlockReason('market-structure', emptyMarketSnapshot) ===
      'no market structure prices available'
  );
  const missingMarketPricesSnapshot = {
    ...marketSnapshot,
    assets: marketSnapshot.assets.map((asset) => ({
      id: asset.id,
      label: asset.label,
      spotVolume: asset.spotVolume,
      leverage: asset.leverage,
    })),
  };
  check(
    'market-structure guard blocks when price is absent',
    publishBlockReason(
      'market-structure',
      missingMarketPricesSnapshot as never
    ) === 'no market structure prices available'
  );
  const partiallyEmptyMarketSnapshot = {
    ...marketSnapshot,
    assets: marketSnapshot.assets.map((asset, index) =>
      index === 0 ? { ...asset, price: [] } : asset
    ),
  };
  check(
    'market-structure guard allows a snapshot with at least one price series',
    publishBlockReason('market-structure', partiallyEmptyMarketSnapshot) ===
      null
  );

  const guardsSource = readFileSync(
    new URL('./guards.ts', import.meta.url),
    'utf8'
  );
  check(
    'guards module has no database or pg imports',
    !/(?:from\s+["']pg["']|@\/lib\/db|PrismaClient|generated\/db|from\s+["'][^"']*prisma)/i.test(
      guardsSource
    )
  );

  const secretUrl =
    'postgresql://snapshot_writer:super-secret@db.example:5432/forum';
  const errorMessage = safeErrorMessage(
    new Error(`connection failed for ${secretUrl}`),
    databaseSecrets(secretUrl)
  );
  check('error message hides the database URL', !errorMessage.includes(secretUrl));
  check(
    'error message hides the database password',
    !errorMessage.includes('super-secret')
  );
  check(
    'error message hides a generic postgres URL',
    !safeErrorMessage(
      new Error('boom postgresql://user:secret@db.example/db')
    ).includes('postgresql://')
  );
  check(
    'invalid URL error does not echo the URL',
    throws(
      () => parseDatabaseUrl('not a url', 'FORUM_SNAPSHOT_DATABASE_URL'),
      /FORUM_SNAPSHOT_DATABASE_URL is invalid/
    ) &&
      !(() => {
        try {
          parseDatabaseUrl('not a url', 'FORUM_SNAPSHOT_DATABASE_URL');
          return true;
        } catch (error) {
          return String(error).includes('not a url');
        }
      })()
  );
  check(
    'missing forum URL has a clear error',
    throws(
      () => requireForumDatabaseUrl({}),
      /Missing FORUM_SNAPSHOT_DATABASE_URL/
    )
  );
  check(
    'masked database shows only host, port and database',
    maskDatabaseUrl(writerUrl) === 'db.example:5432/forum' &&
      !maskDatabaseUrl(writerUrl).includes('snapshot_writer') &&
      !maskDatabaseUrl(writerUrl).includes('super-secret')
  );
  check(
    'remote database is rejected without TERMINAL_ALLOW_REMOTE=1',
    throws(
      () => assertRemoteAllowed(writerUrl, undefined),
      /TERMINAL_ALLOW_REMOTE=1/
    )
  );
  check(
    'remote database is allowed with TERMINAL_ALLOW_REMOTE=1',
    !throws(() => assertRemoteAllowed(writerUrl, '1'))
  );
  check(
    'local database is allowed without TERMINAL_ALLOW_REMOTE=1',
    !throws(() =>
      assertRemoteAllowed(
        new URL('postgresql://snapshot_writer:secret@127.0.0.1:5432/forum'),
        undefined
      )
    )
  );

  const parsed = parseArgs(['--screen=overview', '--dry-run']);
  check(
    'CLI parses the overview dry-run',
    parsed.screen === 'overview' && parsed.dryRun
  );
  const parsedOnchain = parseArgs(['--screen=onchain', '--dry-run']);
  check(
    'CLI parses the onchain dry-run',
    parsedOnchain.screen === 'onchain' && parsedOnchain.dryRun
  );
  check(
    'market-structure is an allowed snapshot key',
    isSnapshotKey('market-structure')
  );
  const parsedMarket = parseArgs(['--screen=market-structure', '--dry-run']);
  check(
    'CLI parses the market-structure dry-run',
    parsedMarket.screen === 'market-structure' && parsedMarket.dryRun
  );
  check(
    'CLI rejects an unknown screen',
    throws(() => parseArgs(['--screen=unknown']), /Invalid snapshot key/)
  );
  check(
    'CLI rejects a missing screen',
    throws(() => parseArgs([]), /Missing --screen/)
  );

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    '[FATAL]',
    error instanceof Error ? error.message : String(error).slice(0, 300)
  );
  process.exitCode = 1;
});
