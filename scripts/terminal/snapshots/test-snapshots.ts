#!/usr/bin/env node
import { buildOverviewPayload } from './overview';
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
    'health',
    'leverage-macro',
    'launchpads',
    'tokens',
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
