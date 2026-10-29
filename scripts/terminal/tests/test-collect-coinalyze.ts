#!/usr/bin/env node

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import {
  buildCoinalyzeHistoryBlocks,
  collectCoinalyze,
  parseCollectCoinalyzeArgs,
} from '../collect-coinalyze';
import {
  COINALYZE_CREDIT_LINE,
  COINALYZE_SERIES,
  COINALYZE_SYMBOLS,
  type CoinalyzeAsset,
  type CoinalyzeEndpoint,
} from '../sources/coinalyze-config';
import { coinalyzeHistoryUrl, parseCoinalyzeHistory } from '../sources/coinalyze';
import {
  addUtcDays,
  formatIsoDateUtc,
  parseIsoDateUtc,
  startOfUtcDay,
  type FetchLike,
} from '../sources/macro-config';

const TEST_API_KEY = 'test-coinalyze-key-123';
const ORIGINAL_API_KEY = process.env.COINALYZE_API_KEY;
process.env.COINALYZE_API_KEY = TEST_API_KEY;

const FIXED_NOW_1 = new Date('2026-10-26T20:00:00.000Z');
const FIXED_NOW_2 = new Date('2026-10-26T21:00:00.000Z');
const FIXED_NOW_3 = new Date('2026-10-26T22:00:00.000Z');
const TODAY = '2026-10-26';
const FIXTURE_START = new Date('2025-01-01T00:00:00.000Z');
const ASSET_INDEX: Record<CoinalyzeAsset, number> = { sol: 0, btc: 1, eth: 2 };
const ENDPOINTS: readonly CoinalyzeEndpoint[] = [
  'open_interest',
  'funding_rate',
  'liquidation',
  'long_short_ratio',
];

interface FakeOptions {
  failStatus?: number;
  failAfter?: number;
  retryAfter?: string;
  reviseDate?: string;
  revisedValue?: string;
  oiOverrides?: Record<string, string>;
  missing?: {
    asset: CoinalyzeAsset;
    endpoint: CoinalyzeEndpoint;
    date: string;
    field: string;
  };
}

interface QueryLog {
  query: string;
  params: string;
}

interface ObservationRow {
  seriesId: string;
  refDate: Date;
  value: { toString(): string } | null;
  status: string;
  unit: string;
  publishedAt: Date | null;
  firstSeenAt: Date;
  collectedAt: Date;
  revisionNote: string | null;
}

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function serial(day: Date): number {
  return Math.round((day.getTime() - FIXTURE_START.getTime()) / 86_400_000);
}

function oiValue(asset: CoinalyzeAsset, day: Date): string {
  return String(1_000 + ASSET_INDEX[asset] * 100_000 + serial(day));
}

function fundingValue(asset: CoinalyzeAsset, day: Date): string {
  return (0.01 + (ASSET_INDEX[asset] * 100 + serial(day)) / 100_000).toFixed(6);
}

function liquidationValue(asset: CoinalyzeAsset, day: Date, field: 'l' | 's'): string {
  return String((field === 'l' ? 10 : 20) + ASSET_INDEX[asset] * 100_000 + serial(day));
}

function ratioValue(asset: CoinalyzeAsset, day: Date): string {
  return (1.5 + (ASSET_INDEX[asset] + serial(day)) / 1_000).toFixed(4);
}

function longAccountValue(asset: CoinalyzeAsset, day: Date): string {
  return (55 + (ASSET_INDEX[asset] + serial(day)) / 1_000).toFixed(4);
}

function pointsFromUrl(url: URL, options: FakeOptions): unknown[] {
  const from = new Date(Number(url.searchParams.get('from')) * 1000);
  const to = new Date(Number(url.searchParams.get('to')) * 1000);
  const start = startOfUtcDay(from);
  const last = startOfUtcDay(to);
  const asset = (Object.keys(COINALYZE_SYMBOLS) as CoinalyzeAsset[]).find(
    (key) => COINALYZE_SYMBOLS[key] === url.searchParams.get('symbols')
  );
  const endpoint = (Object.entries({
    open_interest: '/open-interest-history',
    funding_rate: '/funding-rate-history',
    liquidation: '/liquidation-history',
    long_short_ratio: '/long-short-ratio-history',
  }) as [CoinalyzeEndpoint, string][]).find(([, path]) => url.pathname.endsWith(path))?.[0];

  if (asset === undefined || endpoint === undefined) return [];

  const dates: Date[] = [];

  for (let day = start; day <= last; day = addUtcDays(day, 1)) {
    dates.push(day);
  }

  const todayStart = startOfUtcDay(FIXED_NOW_1);

  if (!dates.some((day) => day.getTime() === todayStart.getTime())) {
    dates.push(todayStart);
  }

  return dates.map((day) => {
    const iso = formatIsoDateUtc(day);
    const point: Record<string, unknown> = {
      t: Math.floor(day.getTime() / 1000),
    };

    if (endpoint === 'open_interest') {
      point.o = oiValue(asset, day);
      point.h = oiValue(asset, day);
      point.l = oiValue(asset, day);
      point.c =
        options.reviseDate === iso && options.revisedValue !== undefined
          ? options.revisedValue
          : options.oiOverrides?.[`${asset}:${iso}`] ?? oiValue(asset, day);
    } else if (endpoint === 'funding_rate') {
      point.o = fundingValue(asset, day);
      point.h = fundingValue(asset, day);
      point.l = fundingValue(asset, day);
      point.c = fundingValue(asset, day);
    } else if (endpoint === 'liquidation') {
      point.l = liquidationValue(asset, day, 'l');
      point.s = liquidationValue(asset, day, 's');
    } else {
      point.r = ratioValue(asset, day);
      point.l = longAccountValue(asset, day);
      point.s = '44.5';
    }

    if (
      options.missing !== undefined &&
      options.missing.asset === asset &&
      options.missing.endpoint === endpoint &&
      options.missing.date === iso
    ) {
      delete point[options.missing.field];
    }

    return point;
  });
}

function fakeFetch(options: FakeOptions = {}): {
  fetchImpl: FetchLike;
  calls: { url: string; init?: RequestInit }[];
} {
  const calls: { url: string; init?: RequestInit }[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });

    if (
      options.failStatus !== undefined &&
      (options.failAfter === undefined || calls.length > options.failAfter)
    ) {
      return new Response(`falha com ${TEST_API_KEY}`, {
        status: options.failStatus,
        headers:
          options.retryAfter === undefined
            ? undefined
            : { 'Retry-After': options.retryAfter },
      });
    }

    const parsed = new URL(url);
    const symbol = parsed.searchParams.get('symbols') ?? 'AUSENTE';
    const history = pointsFromUrl(parsed, options);

    return new Response(JSON.stringify([{ symbol, history }]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { fetchImpl, calls };
}

function queryParams(event: QueryLog): unknown[] {
  try {
    const parsed = JSON.parse(event.params) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function macroSelects(events: readonly QueryLog[]): QueryLog[] {
  return events.filter(
    (event) => /^SELECT/i.test(event.query.trim()) && event.query.includes('"MacroObservation"')
  );
}

function seriesSelectCount(events: readonly QueryLog[], seriesId: string): number {
  return events.filter((event) => queryParams(event).some((value) => value === seriesId)).length;
}

async function runUnit(): Promise<void> {
  const args = parseCollectCoinalyzeArgs([
    '--dry-run',
    '--backfill-from=2026-10-01',
    '--only=sol,btc',
  ]);
  check(
    'args: dry-run/backfill/only',
    args.dryRun &&
      args.backfillFrom?.toISOString() === '2026-10-01T00:00:00.000Z' &&
      args.only?.join(',') === 'sol,btc'
  );

  let invalidDate = false;
  try {
    parseCollectCoinalyzeArgs(['--backfill-from=2026-02-30']);
  } catch {
    invalidDate = true;
  }
  check('args: data inválida falha', invalidDate);

  let invalidOnly = false;
  try {
    parseCollectCoinalyzeArgs(['--only=xrp']);
  } catch {
    invalidOnly = true;
  }
  check('args: ativo inválido falha', invalidOnly);

  const start = parseIsoDateUtc('2025-01-01');
  const end = parseIsoDateUtc('2026-10-26');

  if (start === null || end === null) throw new Error('datas fixas inválidas');

  const blocks = buildCoinalyzeHistoryBlocks(start, end);
  check(
    'blocos de 180 dias contíguos',
    blocks.length === 4 &&
      blocks[0]?.from.toISOString() === start.toISOString() &&
      blocks[0]?.toExclusive.toISOString() === addUtcDays(start, 180).toISOString() &&
      blocks.every(
        (block, index) =>
          index === 0 || block.from.getTime() === blocks[index - 1]?.toExclusive.getTime()
      ) &&
      blocks.every(
        (block) =>
          Math.round(
            (block.toExclusive.getTime() - block.from.getTime()) / 86_400_000
          ) <= 180
      ) &&
      blocks[blocks.length - 1]?.toExclusive.toISOString() === end.toISOString(),
    `(${blocks.length})`
  );

  const url = coinalyzeHistoryUrl(
    'sol',
    'open_interest',
    Math.floor(start.getTime() / 1000),
    Math.floor(end.getTime() / 1000) - 1
  );
  check(
    'URL: um símbolo, daily e convert_to_usd',
    url.includes('/open-interest-history?') &&
      url.includes('symbols=SOLUSDT_PERP.A') &&
      url.includes('interval=daily') &&
      url.includes('convert_to_usd=true')
  );

  const parsedHistory = parseCoinalyzeHistory(
    [
      {
        symbol: 'SOLUSDT_PERP.A',
        history: [
          { t: 1_790_000_000, o: 1, h: 2, l: 0.5, c: 1.5 },
          { t: 'invalid', o: 1, h: 2, l: 0.5, c: 1.5 },
        ],
      },
    ],
    'SOLUSDT_PERP.A'
  );
  check(
    'parser: history e t inválido com aviso',
    parsedHistory.points.length === 1 &&
      parsedHistory.warnings.some((warning) => warning.includes('t inválido'))
  );

  const dryLines: string[] = [];
  const dryFake = fakeFetch();
  const sleeps: number[] = [];
  const dry = await collectCoinalyze({
    dryRun: true,
    fetchImpl: dryFake.fetchImpl,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
    now: () => FIXED_NOW_1,
    backfillFrom: parseIsoDateUtc('2026-10-01') ?? undefined,
    log: (line) => dryLines.push(line),
    logError: (line) => dryLines.push(line),
  });
  check(
    'dry-run: 18 séries e 25 dias por série',
    dry.ok &&
      dry.observations === 450 &&
      dryLines.filter((line) => line.includes('[DRY-RUN] series=') && line.includes('count='))
        .length === 18 &&
      dryLines.some((line) => line.includes('series=coinalyze_sol_oi_usd_close count=25')),
    `(observations=${dry.observations})`
  );
  check(
    'dry-run: imprime 3 mais recentes por série',
    dryLines.filter(
      (line) =>
        line.includes('[DRY-RUN]   series=coinalyze_sol_oi_usd_close') &&
        line.includes('refDate=')
    ).length === 3
  );
  check(
    'dry-run: hoje nunca aparece',
    !dryLines.some((line) => line.includes(`refDate=${TODAY}`)) &&
      dryLines.some((line) => line.includes(`${TODAY} é hoje ou futuro, ignorada`))
  );
  check(
    'dry-run: 12 chamadas, 11 esperas de 2 s',
    dryFake.calls.length === 12 &&
      sleeps.length === 11 &&
      sleeps.every((ms) => ms === 2_000),
    `(calls=${dryFake.calls.length} sleeps=${sleeps.length})`
  );
  check(
    'dry-run: sem escrita no banco',
    dryLines.some((line) => line.includes('nenhuma escrita no banco'))
  );
  check(
    'dry-run: chave no header e nunca na saída',
    dryFake.calls.every(
      (call) => (call.init?.headers as Record<string, string> | undefined)?.api_key === TEST_API_KEY
    ) &&
      !dryLines.join('\n').includes(TEST_API_KEY)
  );
  check('crédito Coinalyze definido', COINALYZE_CREDIT_LINE === 'Data: Coinalyze (https://coinalyze.net)');
}

function localDbUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    console.log('[SKIP] defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test');
    return null;
  }

  const parsed = new URL(url);
  if (!/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) || parsed.port !== '5433') {
    console.log(`[SKIP] banco não é local:${parsed.port}: ${parsed.hostname}`);
    return null;
  }

  return url;
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  const source = await prisma.dataSource.findUnique({
    where: { provider: 'coinalyze' },
    select: { id: true },
  });

  if (source !== null) {
    await prisma.collectionLog.deleteMany({ where: { sourceId: source.id } });
  }

  await prisma.macroObservation.deleteMany({ where: { source: 'coinalyze' } });

  if (source !== null) {
    await prisma.dataSource.delete({ where: { id: source.id } });
  }
}

async function latestObservation(
  prisma: PrismaClient,
  seriesId: string,
  refDate: string
): Promise<ObservationRow | null> {
  return prisma.macroObservation.findFirst({
    where: { seriesId, refDate: new Date(`${refDate}T00:00:00.000Z`) },
    orderBy: { collectedAt: 'desc' },
    select: {
      seriesId: true,
      refDate: true,
      value: true,
      status: true,
      unit: true,
      publishedAt: true,
      firstSeenAt: true,
      collectedAt: true,
      revisionNote: true,
    },
  });
}

async function runDb(prisma: PrismaClient, queryLog: QueryLog[]): Promise<void> {
  await cleanup(prisma);

  const firstFake = fakeFetch();
  queryLog.length = 0;
  const first = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: firstFake.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  const firstSelects = macroSelects(queryLog);
  const solSeries = COINALYZE_SERIES.filter((definition) => definition.asset === 'sol');
  const oi = await latestObservation(prisma, 'coinalyze_sol_oi_usd_close', '2026-10-23');
  const todayRows = await prisma.macroObservation.count({
    where: { source: 'coinalyze', refDate: { gte: new Date(`${TODAY}T00:00:00.000Z`) } },
  });

  check(
    'db: live grava 5 dias x 6 séries',
    first.ok && first.observations === 30 && first.inserted === 30 && first.unchanged === 0,
    `(observations=${first.observations} inserted=${first.inserted})`
  );
  check('db: vela de hoje não é gravada', todayRows === 0, `(${todayRows})`);
  check(
    'db: live publishedAt nulo e firstSeenAt=collectedAt',
    oi?.publishedAt === null &&
      oi.firstSeenAt.toISOString() === FIXED_NOW_1.toISOString() &&
      oi.collectedAt.toISOString() === FIXED_NOW_1.toISOString()
  );
  check(
    'db: uma leitura por série',
    firstSelects.length === solSeries.length &&
      solSeries.every((definition) => seriesSelectCount(firstSelects, definition.seriesId) === 1),
    `(selects=${firstSelects.length})`
  );

  queryLog.length = 0;
  const second = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  check(
    'db: segunda execução grava zero',
    second.ok && second.inserted === 0 && second.unchanged === 30,
    `(inserted=${second.inserted} unchanged=${second.unchanged})`
  );

  const third = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: fakeFetch({ reviseDate: '2026-10-23', revisedValue: '999999' }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_3,
    log: () => {},
    logError: () => {},
  });
  const revised = await latestObservation(prisma, 'coinalyze_sol_oi_usd_close', '2026-10-23');

  check(
    'db: revisão grava uma linha',
    third.ok && third.inserted === 1 && third.unchanged === 29,
    `(inserted=${third.inserted} unchanged=${third.unchanged})`
  );
  check(
    'db: revisão usa revised from e preserva firstSeenAt',
    revised?.value?.toString() === '999999' &&
      revised.revisionNote === `revised from ${oiValue('sol', new Date('2026-10-23T00:00:00.000Z'))}` &&
      revised.firstSeenAt.toISOString() === FIXED_NOW_1.toISOString(),
    `(note=${revised?.revisionNote} value=${revised?.value?.toString()})`
  );

  await cleanup(prisma);

  const failLogs: string[] = [];
  const limitedFake = fakeFetch({ failStatus: 429, failAfter: 2, retryAfter: '17' });
  const limited = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: limitedFake.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: (line) => failLogs.push(line),
  });
  const limitedSource = await prisma.dataSource.findUnique({
    where: { provider: 'coinalyze' },
    select: { id: true },
  });
  const limitedRows = await prisma.macroObservation.count({ where: { source: 'coinalyze' } });
  const limitedLog =
    limitedSource === null
      ? null
      : await prisma.collectionLog.findFirst({
          where: { sourceId: limitedSource.id, httpStatus: 429 },
          orderBy: { collectedAt: 'desc' },
        });

  check(
    'db: 429 para, registra Retry-After e não grava',
    limited.rateLimited &&
      limited.httpStatus === 429 &&
      limitedFake.calls.length === 3 &&
      limitedRows === 0 &&
      limitedLog?.errorMessage?.includes('retry-after=17') === true,
    `(calls=${limitedFake.calls.length} rows=${limitedRows})`
  );
  check(
    'db: 429 não vaza a chave',
    !failLogs.join('\n').includes(TEST_API_KEY) &&
      limitedLog?.errorMessage?.includes(TEST_API_KEY) !== true
  );

  await cleanup(prisma);

  const unauthorizedFake = fakeFetch({ failStatus: 401 });
  const unauthorized = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: unauthorizedFake.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: 401 para na primeira chamada',
    unauthorized.httpStatus === 401 &&
      unauthorizedFake.calls.length === 1 &&
      unauthorized.inserted === 0
  );

  await cleanup(prisma);

  const missing = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: fakeFetch({
      missing: {
        asset: 'sol',
        endpoint: 'open_interest',
        date: '2026-10-23',
        field: 'c',
      },
    }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const missingRow = await latestObservation(prisma, 'coinalyze_sol_oi_usd_close', '2026-10-23');
  const otherSeriesRow = await latestObservation(
    prisma,
    'coinalyze_sol_funding_rate_close_pct',
    '2026-10-23'
  );

  check(
    'db: valor ausente vira aviso sem zero',
    missing.ok &&
      missing.inserted === 29 &&
      missing.warnings.some((warning) =>
        warning.includes('coinalyze_sol_oi_usd_close: 2026-10-23 campo c ausente/N/A')
      ) &&
      missingRow === null &&
      otherSeriesRow !== null,
    `(inserted=${missing.inserted} warnings=${missing.warnings.length})`
  );

  await cleanup(prisma);

  const backfill = await collectCoinalyze({
    prisma,
    only: ['sol'],
    backfillFrom: parseIsoDateUtc('2026-10-01') ?? undefined,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const backfilled = await latestObservation(
    prisma,
    'coinalyze_sol_oi_usd_close',
    '2026-10-01'
  );

  check(
    'db: backfill grava 25 dias x 6 séries',
    backfill.ok && backfill.observations === 150 && backfill.inserted === 150,
    `(observations=${backfill.observations} inserted=${backfill.inserted})`
  );
  check(
    'db: backfill usa D+1 00:30 e nota de publicação',
    backfilled?.publishedAt?.toISOString() === '2026-10-02T00:30:00.000Z' &&
      backfilled.firstSeenAt.toISOString() === '2026-10-02T00:30:00.000Z' &&
      backfilled.revisionNote === 'backfill:estimated_publication',
    `(published=${backfilled?.publishedAt?.toISOString()})`
  );

  const backfillAgain = await collectCoinalyze({
    prisma,
    only: ['sol'],
    backfillFrom: parseIsoDateUtc('2026-10-01') ?? undefined,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  check(
    'db: segundo backfill grava zero',
    backfillAgain.ok && backfillAgain.inserted === 0 && backfillAgain.unchanged === 150,
    `(inserted=${backfillAgain.inserted} unchanged=${backfillAgain.unchanged})`
  );

  await cleanup(prisma);

  const longBaseOverrides: Record<string, string> = {
    'sol:2026-10-22': '824229.14280000',
    'sol:2026-10-23': '1051912.52420000',
    'sol:2026-10-24': '-1051912.52420000',
    'sol:2026-10-25': '0.00000000',
  };
  const longApiOverrides: Record<string, string> = {
    'sol:2026-10-22': '824229.1428000003',
    'sol:2026-10-23': '1051912.5242000006',
    'sol:2026-10-24': '-1051912.5242000006',
    'sol:2026-10-25': '0.000000004',
  };
  const longFirst = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: fakeFetch({ oiOverrides: longBaseOverrides }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const longSecond = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: fakeFetch({ oiOverrides: longApiOverrides }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  const longTotal = await prisma.macroObservation.count({ where: { source: 'coinalyze' } });
  const longOis = await Promise.all(
    ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map((date) =>
      latestObservation(prisma, 'coinalyze_sol_oi_usd_close', date)
    )
  );
  const unchangedAt = (row: ObservationRow | null): boolean =>
    row?.collectedAt.toISOString() === FIXED_NOW_1.toISOString();

  check(
    'db: valores longos arredondados não geram revisão falsa',
    longFirst.ok &&
      longFirst.inserted === 30 &&
      longSecond.ok &&
      longSecond.inserted === 0 &&
      longSecond.unchanged === 30 &&
      longTotal === 30,
    `(first=${longFirst.inserted} second=${longSecond.inserted} total=${longTotal})`
  );
  check(
    'db: 1051912.5242000006 é igual a 1051912.52420000 após arredondar',
    longOis[1]?.value?.toString() === '1051912.5242' && unchangedAt(longOis[1]),
    `(value=${longOis[1]?.value?.toString()})`
  );
  check(
    'db: 824229.1428000003 é igual a 824229.14280000 após arredondar',
    longOis[0]?.value?.toString() === '824229.1428' && unchangedAt(longOis[0]),
    `(value=${longOis[0]?.value?.toString()})`
  );
  check(
    'db: valores negativo e zero longos são iguais após arredondar',
    longOis[2]?.value?.toString() === '-1051912.5242' &&
      unchangedAt(longOis[2]) &&
      longOis[3]?.value?.toString() === '0' &&
      unchangedAt(longOis[3]),
    `(negative=${longOis[2]?.value?.toString()} zero=${longOis[3]?.value?.toString()})`
  );

  const longRevision = await collectCoinalyze({
    prisma,
    only: ['sol'],
    fetchImpl: fakeFetch({
      oiOverrides: { ...longApiOverrides, 'sol:2026-10-23': '1051912.52420001' },
    }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_3,
    log: () => {},
    logError: () => {},
  });
  const revisedLongOis = await latestObservation(
    prisma,
    'coinalyze_sol_oi_usd_close',
    '2026-10-23'
  );

  check(
    'db: mudança real na 8ª casa grava revisão',
    longRevision.ok &&
      longRevision.inserted === 1 &&
      longRevision.unchanged === 29 &&
      revisedLongOis?.value?.toString() === '1051912.52420001' &&
      revisedLongOis.revisionNote === 'revised from 1051912.5242' &&
      revisedLongOis.firstSeenAt.toISOString() === FIXED_NOW_1.toISOString(),
    `(inserted=${longRevision.inserted} note=${revisedLongOis?.revisionNote})`
  );

  await cleanup(prisma);

  const longBackfillOverrides: Record<string, string> = {
    'sol:2026-10-01': '1051912.5242000006',
    'sol:2026-10-02': '824229.1428000003',
    'sol:2026-10-03': '-1051912.5242000006',
    'sol:2026-10-04': '0.000000004',
  };
  const longBackfillFirst = await collectCoinalyze({
    prisma,
    only: ['sol'],
    backfillFrom: parseIsoDateUtc('2026-10-01') ?? undefined,
    fetchImpl: fakeFetch({ oiOverrides: longBackfillOverrides }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const longBackfillAgain = await collectCoinalyze({
    prisma,
    only: ['sol'],
    backfillFrom: parseIsoDateUtc('2026-10-01') ?? undefined,
    fetchImpl: fakeFetch({ oiOverrides: longBackfillOverrides }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: segundo backfill com valores longos grava zero',
    longBackfillFirst.ok &&
      longBackfillFirst.inserted === 150 &&
      longBackfillAgain.ok &&
      longBackfillAgain.inserted === 0 &&
      longBackfillAgain.unchanged === 150,
    `(first=${longBackfillFirst.inserted} second=${longBackfillAgain.inserted})`
  );

  await cleanup(prisma);
}

async function main(): Promise<void> {
  try {
    await runUnit();

    const url = localDbUrl();

    if (url !== null) {
      const adapter = new PrismaPg({ connectionString: url });
      const prisma = new PrismaClient({
        adapter,
        log: [{ emit: 'event', level: 'query' }],
      });
      const queryLog: QueryLog[] = [];
      prisma.$on('query', (event) => {
        queryLog.push({ query: event.query, params: event.params });
      });

      try {
        await runDb(prisma, queryLog);
      } catch (error) {
        check('db executou', false, error instanceof Error ? error.message : String(error));
      } finally {
        try {
          await cleanup(prisma);
        } catch {
          console.error('[CLEANUP] falha na limpeza best-effort');
        }
        await prisma.$disconnect();
      }
    }

    console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    if (ORIGINAL_API_KEY === undefined) {
      delete process.env.COINALYZE_API_KEY;
    } else {
      process.env.COINALYZE_API_KEY = ORIGINAL_API_KEY;
    }
  }
}

main();
