#!/usr/bin/env node
import { buildOverviewPayload } from './overview';
import { parseArgs } from './publish-snapshots';
import type { RecapInput, RecapMetric } from '../recap/recap-format';
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
    ['solana', 'tvl_usd', 11, 'USD'],
    ['solana', 'stablecoin_supply_usd', 21, 'USD'],
    ['solana', 'dex_volume_24h_usd', 31, 'USD'],
    ['global', 'global_market_cap_usd', 41, 'USD'],
    ['global', 'btc_dominance_pct', 51, 'FRACTION'],
  ].map(([scope, metric, value, unit]) => ({
    scope: scope as string,
    metric: metric as string,
    value: value as number,
    unit: unit as string,
    asOf: new Date('2026-11-04T00:00:00.000Z'),
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
