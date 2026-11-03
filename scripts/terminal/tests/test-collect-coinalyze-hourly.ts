#!/usr/bin/env node

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import {
  buildCoinalyzeHourlyUrl,
  buildHourlyWindow,
  collectCoinalyzeHourly,
  parseCoinalyzeHourlyHistory,
  startOfUtcHour,
  type FetchLike,
} from '../collect-coinalyze-hourly';

const FIXED_NOW_1 = new Date('2026-11-02T15:05:00.000Z');
const FIXED_NOW_2 = new Date('2026-11-02T15:35:00.000Z');
const WINDOW = buildHourlyWindow(FIXED_NOW_1);
const CURRENT_HOUR = WINDOW.to;
const PROVIDER = 'coinalyze';

const EXPECTED_METRICS = [
  'oi_usd_close_1h',
  'funding_rate_close_pct_1h',
  'liq_long_usd_1h',
  'liq_short_usd_1h',
  'long_short_ratio_1h',
  'long_account_pct_1h',
];

let passed = 0;
let failures = 0;
let skipped = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function skip(name: string): void {
  console.log(`[SKIP] ${name}`);
  skipped++;
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchImpl: FetchLike;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];

  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function fixtureFor(url: string): { history: Record<string, unknown>[] } {
  const path = new URL(url).pathname;
  const hours = [...WINDOW.hours, CURRENT_HOUR];

  return {
    history: hours.map((hour) => {
      const entry: Record<string, unknown> = {
        t: Math.floor(hour.getTime() / 1000),
        c: '0',
        l: '0',
        s: '0',
        r: '0',
      };

      if (path.includes('open-interest')) {
        entry.c = '1234.567890123';
      } else if (path.includes('funding-rate')) {
        entry.c = '0.0123';
      } else if (path.includes('liquidation')) {
        entry.l = '111.111111119';
        entry.s = '222.222222229';
      } else if (path.includes('long-short-ratio')) {
        entry.r = '1.234567891';
        entry.l = '52.5';
      }

      if (hour.getTime() === CURRENT_HOUR.getTime()) {
        entry.c = '999';
        entry.l = '999';
        entry.s = '999';
        entry.r = '999';
      }

      return entry;
    }),
  };
}

async function runUnit(): Promise<void> {
  check(
    'window: from is 6h before the current hour',
    WINDOW.from.toISOString() === '2026-11-02T09:00:00.000Z',
    `(${WINDOW.from.toISOString()})`
  );
  check(
    'window: to is the current hour',
    WINDOW.to.toISOString() === '2026-11-02T15:00:00.000Z',
    `(${WINDOW.to.toISOString()})`
  );
  check(
    'window: six closed hours',
    WINDOW.hours.length === 6 &&
      WINDOW.hours[0]?.toISOString() === '2026-11-02T09:00:00.000Z' &&
      WINDOW.hours[5]?.toISOString() === '2026-11-02T14:00:00.000Z'
  );
  check(
    'window: startOfUtcHour keeps UTC hour',
    startOfUtcHour(FIXED_NOW_1).toISOString() === CURRENT_HOUR.toISOString()
  );

  const url = new URL(
    buildCoinalyzeHourlyUrl('sol', 'open_interest', WINDOW.from, WINDOW.to)
  );
  check('url: interval is 1hour', url.searchParams.get('interval') === '1hour');
  check(
    'url: from and to are the window bounds',
    url.searchParams.get('from') === String(Math.floor(WINDOW.from.getTime() / 1000)) &&
      url.searchParams.get('to') === String(Math.floor(WINDOW.to.getTime() / 1000))
  );
  check(
    'url: USD conversion only on OI/liquidation',
    url.searchParams.get('convert_to_usd') === 'true' &&
      !new URL(
        buildCoinalyzeHourlyUrl('sol', 'funding_rate', WINDOW.from, WINDOW.to)
      ).searchParams.has('convert_to_usd')
  );

  const parsed = parseCoinalyzeHourlyHistory(
    { history: [{ t: 1_800_000_000, c: '1.5' }, { t: 'inválido' }] },
    'SOLUSDT_PERP.A'
  );
  check(
    'parser: valid point keeps raw timestamp and fields',
    parsed.points.length === 1 &&
      parsed.points[0]?.values.c === '1.5' &&
      parsed.warnings.length === 1
  );

  const normal = fakeFetch((callUrl) => json(200, fixtureFor(callUrl)));
  const sleepCalls: number[] = [];
  const dryLines: string[] = [];
  const dry = await collectCoinalyzeHourly({
    dryRun: true,
    fetchImpl: normal.fetchImpl,
    sleepImpl: async (ms) => {
      sleepCalls.push(ms);
    },
    now: () => FIXED_NOW_1,
    apiKey: 'test-key',
    log: (line) => dryLines.push(line),
    logError: () => {},
  });

  check(
    'dry-run: 12 calls for 3 assets x 4 endpoints',
    normal.calls.length === 12 && dry.calls === 12,
    `(calls=${normal.calls.length})`
  );
  check(
    'dry-run: 2s pause between calls',
    sleepCalls.length === 11 && sleepCalls.every((ms) => ms === 2000),
    `(sleeps=${sleepCalls.length})`
  );
  check(
    'dry-run: 108 metric rows would be inserted',
    dry.wouldInsert === 108 && dry.inserted === 0 && dry.skipped === 0,
    `(wouldInsert=${dry.wouldInsert})`
  );
  check('dry-run: no missing fields', dry.missing === 0, `(missing=${dry.missing})`);
  check(
    'partial candle is discarded',
    !dryLines.some((line) => line.includes(`sourceTs=${CURRENT_HOUR.toISOString()}`)) &&
      !dryLines.some((line) => line.includes('value=999')) &&
      dry.warnings.some((warning) => warning.includes('vela aberta/parcial'))
  );
  check(
    'funding keeps the daily conversion and PERCENT unit',
    dryLines.some(
      (line) =>
        line.includes('scope=coinalyze:SOL') &&
        line.includes('metric=funding_rate_close_pct_1h') &&
        line.includes('value=0.0123') &&
        line.includes('unit=PERCENT')
    )
  );
  check(
    'open interest is USD and rounded to 8 places',
    dryLines.some(
      (line) =>
        line.includes('scope=coinalyze:SOL') &&
        line.includes('metric=oi_usd_close_1h') &&
        line.includes('value=1234.56789012') &&
        line.includes('unit=USD')
    )
  );
  check(
    'liquidation long/short are USD and rounded to 8 places',
    dryLines.some(
      (line) =>
        line.includes('metric=liq_long_usd_1h') &&
        line.includes('value=111.11111112') &&
        line.includes('unit=USD')
    ) &&
      dryLines.some(
        (line) =>
          line.includes('metric=liq_short_usd_1h') &&
          line.includes('value=222.22222223') &&
          line.includes('unit=USD')
      )
  );
  check(
    'long/short ratio stays raw RATIO',
    dryLines.some(
      (line) =>
        line.includes('metric=long_short_ratio_1h') &&
        line.includes('value=1.23456789') &&
        line.includes('unit=RATIO')
    )
  );
  check(
    'long account percent stays raw PERCENT',
    dryLines.some(
      (line) =>
        line.includes('metric=long_account_pct_1h') &&
        line.includes('value=52.5') &&
        line.includes('unit=PERCENT')
    )
  );
  check(
    'all six hourly metric names are present',
    EXPECTED_METRICS.every((metric) =>
      dryLines.some((line) => line.includes(`metric=${metric}`))
    )
  );
  check(
    'all three uppercase scopes are present',
    ['coinalyze:SOL', 'coinalyze:BTC', 'coinalyze:ETH'].every((scope) =>
      dryLines.some((line) => line.includes(`scope=${scope}`))
    )
  );
  check(
    'all requests use the 1hour interval and the same window',
    normal.calls.every((call) => {
      const callUrl = new URL(call.url);
      return (
        callUrl.searchParams.get('interval') === '1hour' &&
        callUrl.searchParams.get('from') ===
          String(Math.floor(WINDOW.from.getTime() / 1000)) &&
        callUrl.searchParams.get('to') ===
          String(Math.floor(WINDOW.to.getTime() / 1000))
      );
    })
  );

  let dbTouched = false;
  const forbiddenPrisma = {
    dataSource: {
      upsert: async () => {
        dbTouched = true;
        throw new Error('db touched');
      },
    },
    metricSnapshot: {
      findMany: async () => {
        dbTouched = true;
        return [];
      },
      createMany: async () => {
        dbTouched = true;
        return { count: 0 };
      },
    },
  } as never;

  const noDb = await collectCoinalyzeHourly({
    prisma: forbiddenPrisma,
    dryRun: true,
    fetchImpl: fakeFetch((callUrl) => json(200, fixtureFor(callUrl))).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    apiKey: 'test-key',
    log: () => {},
    logError: () => {},
  });
  check(
    'dry-run never touches the database',
    dbTouched === false && noDb.wouldInsert === 108
  );

  const missing = fakeFetch((callUrl) => {
    const fixture = fixtureFor(callUrl);

    if (
      callUrl.includes('funding-rate') &&
      callUrl.includes('SOLUSDT_PERP.A')
    ) {
      fixture.history[0] = { ...fixture.history[0], c: 'N/A' };
    }

    return json(200, fixture);
  });
  const missingLines: string[] = [];
  const missingSummary = await collectCoinalyzeHourly({
    dryRun: true,
    fetchImpl: missing.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    apiKey: 'test-key',
    log: (line) => missingLines.push(line),
    logError: () => {},
  });
  check(
    'a missing field is counted and never becomes zero',
    missingSummary.missing === 1 &&
      missingSummary.wouldInsert === 107 &&
      !missingLines.some(
        (line) =>
          line.includes('scope=coinalyze:SOL') &&
          line.includes('metric=funding_rate_close_pct_1h') &&
          line.includes('sourceTs=2026-11-02T09:00:00.000Z')
      ) &&
      !missingLines.some((line) => line.includes('value=0 '))
  );

  const limited = fakeFetch((callUrl) => {
    if (limited.calls.length >= 2) {
      return new Response('', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    }

    return json(200, fixtureFor(callUrl));
  });
  const limitedSleep: number[] = [];
  const limitedSummary = await collectCoinalyzeHourly({
    dryRun: true,
    fetchImpl: limited.fetchImpl,
    sleepImpl: async (ms) => {
      limitedSleep.push(ms);
    },
    now: () => FIXED_NOW_1,
    apiKey: 'test-key',
    log: () => {},
    logError: () => {},
  });
  check(
    '429 stops at the first occurrence without retry',
    limitedSummary.calls === 2 && limited.calls.length === 2 && limitedSleep.length === 1,
    `(calls=${limited.calls.length})`
  );
  check(
    '429 sets rate-limit state, HTTP status and Retry-After',
    limitedSummary.ok === false &&
      limitedSummary.rateLimited === true &&
      limitedSummary.httpStatus === 429 &&
      limitedSummary.retryAfter === '120' &&
      limitedSummary.failures.some(
        (failure) => failure.includes('429') && failure.includes('retry-after=120')
      )
  );
  check(
    '429 does not insert rows',
    limitedSummary.inserted === 0 && limitedSummary.wouldInsert === 6
  );
}

function localDbUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL;

  if (url === undefined || url === '') {
    skip('db: defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test');
    return null;
  }

  const parsed = new URL(url);

  if (!/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) || parsed.port !== '5433') {
    skip(`db: banco não é local:5433 (${parsed.hostname}:${parsed.port})`);
    return null;
  }

  return url;
}

async function getSource(prisma: PrismaClient): Promise<{ id: string } | null> {
  return prisma.dataSource.findUnique({
    where: { provider: PROVIDER },
    select: { id: true },
  });
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  const source = await getSource(prisma);

  if (source === null) {
    return;
  }

  await prisma.metricSnapshot.deleteMany({ where: { sourceId: source.id } });
  await prisma.dataSource.delete({ where: { id: source.id } });
}

async function runDb(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);

  const firstFake = fakeFetch((callUrl) => json(200, fixtureFor(callUrl)));
  const first = await collectCoinalyzeHourly({
    prisma,
    fetchImpl: firstFake.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    apiKey: 'test-key',
    log: () => {},
    logError: () => {},
  });

  check(
    'db: first run inserts 108 rows',
    first.ok &&
      first.inserted === 108 &&
      first.skipped === 0 &&
      first.missing === 0 &&
      first.calls === 12,
    `(ok=${first.ok} inserted=${first.inserted} skipped=${first.skipped} missing=${first.missing})`
  );

  const source = await getSource(prisma);
  check('db: DataSource coinalyze exists', source !== null);

  if (source === null) {
    return;
  }

  const rows = await prisma.metricSnapshot.findMany({
    where: { sourceId: source.id },
  });

  check('db: 108 MetricSnapshot rows', rows.length === 108, `(${rows.length})`);
  check(
    'db: sourceTs and bucketTs are the candle hour',
    rows.every(
      (row) =>
        row.sourceTs !== null &&
        row.bucketTs !== null &&
        row.sourceTs.toISOString() === row.bucketTs.toISOString()
    )
  );
  check(
    'db: the open candle is never written',
    rows.every((row) => row.sourceTs !== null && row.sourceTs < CURRENT_HOUR)
  );
  check(
    'db: collectedAt is the run moment',
    rows.every(
      (row) =>
        row.collectedAt.getTime() >= FIXED_NOW_1.getTime() &&
        row.collectedAt.getTime() < FIXED_NOW_1.getTime() + 1000
    ) &&
      new Set(
        rows.map(
          (row) =>
            `${row.scope}\u0000${row.metric}\u0000${row.collectedAt.getTime()}`
        )
      ).size === rows.length
  );
  check(
    'db: all scopes use the coinalyze prefix',
    ['coinalyze:SOL', 'coinalyze:BTC', 'coinalyze:ETH'].every(
      (scope) => rows.filter((row) => row.scope === scope).length === 36
    )
  );
  check(
    'db: all hourly metric names are stored',
    EXPECTED_METRICS.every((metric) =>
      rows.some((row) => row.metric === metric)
    )
  );

  const solAtStart = rows.find(
    (row) =>
      row.scope === 'coinalyze:SOL' &&
      row.metric === 'oi_usd_close_1h' &&
      row.sourceTs?.toISOString() === WINDOW.from.toISOString()
  );
  const fundingSol = rows.find(
    (row) =>
      row.scope === 'coinalyze:SOL' &&
      row.metric === 'funding_rate_close_pct_1h'
  );
  const ratioSol = rows.find(
    (row) =>
      row.scope === 'coinalyze:SOL' &&
      row.metric === 'long_short_ratio_1h'
  );
  const longAccountSol = rows.find(
    (row) =>
      row.scope === 'coinalyze:SOL' &&
      row.metric === 'long_account_pct_1h'
  );

  check(
    'db: OI value and unit match the daily conversion',
    solAtStart?.value.toString() === '1234.56789012' &&
      solAtStart.unit === 'USD',
    `(${solAtStart?.value.toString()})`
  );
  check(
    'db: funding value and unit match the daily conversion',
    fundingSol?.value.toString() === '0.0123' && fundingSol.unit === 'PERCENT'
  );
  check(
    'db: ratio value and unit match the daily conversion',
    ratioSol?.value.toString() === '1.23456789' && ratioSol.unit === 'RATIO'
  );
  check(
    'db: long account value and unit match the daily conversion',
    longAccountSol?.value.toString() === '52.5' &&
      longAccountSol.unit === 'PERCENT'
  );

  const secondFake = fakeFetch((callUrl) => json(200, fixtureFor(callUrl)));
  const second = await collectCoinalyzeHourly({
    prisma,
    fetchImpl: secondFake.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    apiKey: 'test-key',
    log: () => {},
    logError: () => {},
  });

  check(
    'db: second run is idempotent and inserts 0',
    second.ok &&
      second.inserted === 0 &&
      second.skipped === 108 &&
      second.calls === 12,
    `(inserted=${second.inserted} skipped=${second.skipped})`
  );

  const countAfterSecond = await prisma.metricSnapshot.count({
    where: { sourceId: source.id },
  });
  check(
    'db: second run creates no duplicate rows',
    countAfterSecond === 108,
    `(${countAfterSecond})`
  );

  await cleanup(prisma);
}

async function main(): Promise<void> {
  await runUnit();

  const url = localDbUrl();

  if (url !== null) {
    const adapter = new PrismaPg({ connectionString: url });
    const prisma = new PrismaClient({ adapter });

    try {
      await runDb(prisma);
    } catch (error) {
      check(
        'db executou',
        false,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      try {
        await cleanup(prisma);
      } catch {
        console.error('[CLEANUP] falha na limpeza best-effort');
      }
      await prisma.$disconnect();
    }
  }

  console.log(
    `\n=== RESULTADO: ${passed} passaram, ${failures} falharam, ${skipped} pulados ===`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
