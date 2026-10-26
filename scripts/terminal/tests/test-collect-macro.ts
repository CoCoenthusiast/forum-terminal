#!/usr/bin/env node

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { collectMacro, parseMacroArgs } from '../collect-macro';
import {
  InvalidPayloadError,
  MACRO_REQUEST_PAUSE_MS,
  estimatePublishedAt,
  formatIsoDateUtc,
  nextBusinessDay,
  parseIsoDateUtc,
  type FetchLike,
} from '../sources/macro-config';
import { parseTreasuryCsv } from '../sources/macro-treasury';
import { parseNyfedPayload } from '../sources/macro-nyfed';
import { parseEcbCsv } from '../sources/macro-ecb';

const FIXED_NOW_1 = new Date('2026-10-26T20:00:00.000Z');
const FIXED_NOW_2 = new Date('2026-10-26T21:00:00.000Z');
const FIXED_NOW_3 = new Date('2026-10-26T22:00:00.000Z');
const BACKFILL_FROM = new Date('2026-10-20T00:00:00.000Z');

const NOMINAL_HEADER =
  'Date,"1 Mo","1.5 Month","2 Mo","3 Mo","4 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"';
const REAL_HEADER = 'Date,"5 YR","7 YR","10 YR","20 YR","30 YR"';
const ECB_HEADER =
  'KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE,OBS_STATUS';

interface NominalValues {
  y3: string;
  y2: string;
  y5: string;
  y10: string;
  y30: string;
}

interface TreasuryFixtureOptions {
  missing3mOn26?: boolean;
  revised10yOn26?: string;
}

interface NyfedFixtureOptions {
  revised22?: boolean;
  revisionIndicator?: string;
}

interface Fixtures {
  nominal?: string;
  real?: string;
  sofr?: unknown;
  effr?: unknown;
  ecb?: string;
}

interface FakeOptions {
  failSubstring?: string;
  failStatus?: number;
}

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function nominalRow(date: string, values: NominalValues): string {
  return [
    date,
    '4.00',
    '4.01',
    '4.02',
    values.y3,
    '4.04',
    '4.05',
    '4.06',
    values.y2,
    '4.08',
    values.y5,
    '4.10',
    values.y10,
    '4.12',
    values.y30,
  ].join(',');
}

function nominalCsv(options: TreasuryFixtureOptions = {}): string {
  const rows = [
    nominalRow('10/26/2026', {
      y3: options.missing3mOn26 === true ? 'N/A' : '4.22',
      y2: '4.68',
      y5: '4.84',
      y10: options.revised10yOn26 ?? '5.00',
      y30: '5.31',
    }),
    nominalRow('10/23/2026', { y3: '4.22', y2: '4.69', y5: '4.82', y10: '5.00', y30: '5.33' }),
    nominalRow('10/22/2026', { y3: '4.21', y2: '4.66', y5: '4.81', y10: '4.98', y30: '5.29' }),
    nominalRow('10/21/2026', { y3: '4.20', y2: '4.65', y5: '4.80', y10: '4.97', y30: '5.28' }),
    nominalRow('10/20/2026', { y3: '4.18', y2: '4.60', y5: '4.75', y10: '4.95', y30: '5.25' }),
  ];

  return `${NOMINAL_HEADER}\n${rows.join('\n')}\n`;
}

function realRow(date: string, y5: string, y10: string): string {
  return `${date},${y5},4.50,${y10},4.60,4.70`;
}

function realCsv(): string {
  return [
    REAL_HEADER,
    realRow('10/26/2026', '2.37', '2.66'),
    realRow('10/23/2026', '2.34', '2.66'),
    realRow('10/22/2026', '2.32', '2.63'),
    realRow('10/21/2026', '2.30', '2.60'),
    realRow('10/20/2026', '2.28', '2.58'),
  ].join('\n');
}

function sofrPayload(options: NyfedFixtureOptions = {}): unknown {
  const revision = options.revisionIndicator ?? '';

  return {
    refRates: [
      {
        effectiveDate: '2026-10-26',
        type: 'SOFR',
        percentRate: 3.93,
        revisionIndicator: '',
      },
      {
        effectiveDate: '2026-10-23',
        type: 'SOFR',
        percentRate: 3.92,
        revisionIndicator: '',
      },
      {
        effectiveDate: '2026-10-22',
        type: 'SOFR',
        percentRate: options.revised22 === true ? 3.91 : 3.9,
        revisionIndicator: revision,
      },
      {
        effectiveDate: '2026-10-21',
        type: 'SOFR',
        percentRate: 3.88,
        revisionIndicator: '',
      },
      {
        effectiveDate: '2026-10-20',
        type: 'SOFR',
        percentRate: 3.87,
        revisionIndicator: '',
      },
    ],
  };
}

function effrPayload(): unknown {
  return {
    refRates: [
      { effectiveDate: '2026-10-26', type: 'EFFR', percentRate: 3.9, revisionIndicator: '' },
      { effectiveDate: '2026-10-23', type: 'EFFR', percentRate: 3.89, revisionIndicator: '' },
      { effectiveDate: '2026-10-22', type: 'EFFR', percentRate: 3.88, revisionIndicator: '' },
      { effectiveDate: '2026-10-21', type: 'EFFR', percentRate: 3.87, revisionIndicator: '' },
      { effectiveDate: '2026-10-20', type: 'EFFR', percentRate: 3.86, revisionIndicator: '' },
    ],
  };
}

function ecbCsv(): string {
  const rows = [
    ['2026-10-20', '1.1215'],
    ['2026-10-21', '1.1200'],
    ['2026-10-22', '1.1188'],
    ['2026-10-23', '1.1188'],
    ['2026-10-26', '1.1188'],
  ];

  return [
    ECB_HEADER,
    ...rows.map(([date, value]) => `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},${value},A`),
  ].join('\n');
}

function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/csv' },
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(
  fixtures: Fixtures = {},
  options: FakeOptions = {}
): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];

  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);

    if (options.failSubstring !== undefined && url.includes(options.failSubstring)) {
      return new Response('', { status: options.failStatus ?? 429 });
    }

    if (url.includes('daily_treasury_real_yield_curve')) {
      return textResponse(fixtures.real ?? realCsv());
    }

    if (url.includes('daily_treasury_yield_curve')) {
      return textResponse(fixtures.nominal ?? nominalCsv());
    }

    if (url.includes('secured/sofr')) {
      return jsonResponse(fixtures.sofr ?? sofrPayload());
    }

    if (url.includes('unsecured/effr')) {
      return jsonResponse(fixtures.effr ?? effrPayload());
    }

    if (url.includes('data-api.ecb.europa.eu')) {
      return textResponse(fixtures.ecb ?? ecbCsv());
    }

    return new Response('not found', { status: 404 });
  };

  return { fetchImpl, calls };
}

function noSleep(): { sleepImpl: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];

  return {
    sleeps,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    },
  };
}

async function runUnit(): Promise<void> {
  const args = parseMacroArgs([
    '--dry-run',
    '--backfill-from=2026-10-01',
    '--only=treasury,ecb',
  ]);
  check(
    'args: dry-run/backfill/only',
    args.dryRun &&
      args.backfillFrom?.toISOString() === '2026-10-01T00:00:00.000Z' &&
      args.only?.join(',') === 'treasury,ecb'
  );

  let invalidArg = false;
  try {
    parseMacroArgs(['--backfill-from=2026-02-30']);
  } catch {
    invalidArg = true;
  }
  check('args: data inválida falha', invalidArg);

  let unknownArg = false;
  try {
    parseMacroArgs(['--foo']);
  } catch {
    unknownArg = true;
  }
  check('args: argumento desconhecido falha', unknownArg);

  let invalidOnly = false;
  try {
    parseMacroArgs(['--only=treasury,foo']);
  } catch {
    invalidOnly = true;
  }
  check('args: fonte inválida falha', invalidOnly);

  check(
    'data: ISO UTC',
    formatIsoDateUtc(parseIsoDateUtc('2026-10-26') ?? new Date()) === '2026-10-26'
  );
  check('data: ISO inválida', parseIsoDateUtc('2026-13-01') === null);

  const parsedNominal = parseTreasuryCsv(nominalCsv(), ['3 Mo', '2 Yr', '10 Yr']);
  check('tesouro: 5 datas', parsedNominal.rows.length === 5, `(${parsedNominal.rows.length})`);
  check(
    'tesouro: 10 Yr da data mais recente',
    parsedNominal.rows[0]?.values.get('10 Yr') === '5.00'
  );
  check(
    'tesouro: 3 Mo lido pelo nome',
    parsedNominal.rows[0]?.values.get('3 Mo') === '4.22'
  );

  const parsedReal = parseTreasuryCsv(realCsv(), ['5 YR', '10 YR']);
  check(
    'tesouro real: cabeçalho maiúsculo exato',
    parsedReal.rows[0]?.values.get('5 YR') === '2.37' &&
      parsedReal.rows[0]?.values.get('10 YR') === '2.66'
  );

  let missingColumn = false;
  try {
    parseTreasuryCsv(nominalCsv().replace('"10 Yr"', '"10 YR"'), ['10 Yr']);
  } catch (error) {
    missingColumn = error instanceof InvalidPayloadError;
  }
  check('tesouro: coluna divergente falha', missingColumn);

  const parsedMissing = parseTreasuryCsv(nominalCsv({ missing3mOn26: true }), ['3 Mo']);
  const missingRow = parsedMissing.rows.find(
    (row) => formatIsoDateUtc(row.refDate) === '2026-10-26'
  );
  check(
    'tesouro: N/A é omitido sem virar zero',
    missingRow === undefined &&
      parsedMissing.warnings.some((warning) => warning.includes('3 Mo vazio/N/A'))
  );

  const parsedNyfed = parseNyfedPayload(sofrPayload({ revisionIndicator: 'R' }), 'sofr');
  check('nyfed: percentRate numérico vira string', parsedNyfed.rates[0]?.value === '3.93');
  check(
    'nyfed: revisionIndicator preservado',
    parsedNyfed.rates[2]?.revisionIndicator === 'R'
  );
  check('nyfed: effectiveDate UTC', parsedNyfed.rates[0]?.refDate.toISOString() === '2026-10-26T00:00:00.000Z');

  const invalidNyfed = parseNyfedPayload(
    { refRates: [{ effectiveDate: '2026-10-26', type: 'SOFR', percentRate: 'N/A' }] },
    'sofr'
  );
  check(
    'nyfed: percentRate inválido é omitido',
    invalidNyfed.rates.length === 0 && invalidNyfed.warnings.length === 1
  );

  let missingRefRates = false;
  try {
    parseNyfedPayload({});
  } catch (error) {
    missingRefRates = error instanceof InvalidPayloadError;
  }
  check('nyfed: refRates ausente falha', missingRefRates);

  const parsedEcb = parseEcbCsv(ecbCsv());
  check('bce: 5 taxas', parsedEcb.rates.length === 5);
  check('bce: EUR/USD de 26/10', parsedEcb.rates[4]?.value === '1.1188');

  const ecbWithMissing = parseEcbCsv(
    `${ECB_HEADER}\nEXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,2026-10-26,N/A,A\n`
  );
  check(
    'bce: OBS_VALUE N/A omitido',
    ecbWithMissing.rates.length === 0 &&
      ecbWithMissing.warnings.some((warning) => warning.includes('vazio/N/A'))
  );

  let ecbMissingHeader = false;
  try {
    parseEcbCsv(ecbCsv().replace('OBS_VALUE', 'VALOR'));
  } catch (error) {
    ecbMissingHeader = error instanceof InvalidPayloadError;
  }
  check('bce: cabeçalho divergente falha', ecbMissingHeader);

  check(
    'publicação: tesouro 22 UTC',
    estimatePublishedAt('treasury', new Date('2026-10-23T00:00:00.000Z')).toISOString() ===
      '2026-10-23T22:00:00.000Z'
  );
  check(
    'publicação: BCE 16 UTC',
    estimatePublishedAt('ecb', new Date('2026-10-23T00:00:00.000Z')).toISOString() ===
      '2026-10-23T16:00:00.000Z'
  );
  check(
    'publicação: NY Fed sexta -> segunda 13 UTC',
    estimatePublishedAt('nyfed', new Date('2026-10-23T00:00:00.000Z')).toISOString() ===
      '2026-10-26T13:00:00.000Z'
  );
  check(
    'publicação: NY Fed segunda -> terça',
    estimatePublishedAt('nyfed', new Date('2026-10-26T00:00:00.000Z')).toISOString() ===
      '2026-10-27T13:00:00.000Z'
  );
  check(
    'dia útil: sábado -> segunda',
    nextBusinessDay(new Date('2026-10-24T00:00:00.000Z')).toISOString() ===
      '2026-10-26T00:00:00.000Z'
  );

  const fake = fakeFetch();
  const pause = noSleep();
  const dryLines: string[] = [];
  const dry = await collectMacro({
    dryRun: true,
    fetchImpl: fake.fetchImpl,
    sleepImpl: pause.sleepImpl,
    now: () => FIXED_NOW_1,
    log: (line) => dryLines.push(line),
    logError: () => {},
  });

  check(
    'dry-run: 50 observações',
    dry.ok && dry.observations === 50 && dry.inserted === 0,
    `(ok=${dry.ok} observations=${dry.observations})`
  );
  check('dry-run: 5 chamadas HTTP', fake.calls.length === 5, `(${fake.calls.length})`);
  check(
    'dry-run: pausa de 3 s entre chamadas',
    pause.sleeps.length === 4 && pause.sleeps.every((ms) => ms === MACRO_REQUEST_PAUSE_MS),
    `(${pause.sleeps.length})`
  );
  check(
    'dry-run: imprime contagem por série',
    dryLines.some((line) => line.includes('series=ust_nominal_10y count=5')),
    ''
  );
  check(
    'dry-run: imprime 3 mais recentes',
    dryLines.some(
      (line) =>
        line.includes('series=ust_nominal_10y refDate=2026-10-26') &&
        line.includes('value=5.00')
    )
  );
  check(
    'dry-run: 10 séries',
    dryLines.filter((line) => line.startsWith('[DRY-RUN] series=')).length === 10
  );
  check(
    'dry-run: avisa ausência de escrita',
    dryLines.some((line) => line.includes('nenhuma escrita no banco'))
  );

  const fake429 = fakeFetch({}, { failSubstring: 'secured/sofr', failStatus: 429 });
  const pause429 = noSleep();
  const limited = await collectMacro({
    dryRun: true,
    fetchImpl: fake429.fetchImpl,
    sleepImpl: pause429.sleepImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });

  check(
    '429: interrompe sem chamar fontes seguintes',
    limited.rateLimited &&
      limited.failures.length === 1 &&
      fake429.calls.length === 3,
    `(calls=${fake429.calls.length} failures=${limited.failures.length})`
  );

  const emptyOnly = await collectMacro({
    dryRun: true,
    only: [],
    fetchImpl: fakeFetch().fetchImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  }).then(
    () => false,
    () => true
  );
  check('opções: nenhuma série selecionada falha', emptyOnly);

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
  const sources = await prisma.dataSource.findMany({
    where: { provider: { in: ['treasury', 'nyfed', 'ecb'] } },
    select: { id: true },
  });
  const ids = sources.map((source) => source.id);

  if (ids.length > 0) {
    await prisma.collectionLog.deleteMany({ where: { sourceId: { in: ids } } });
  }

  await prisma.macroObservation.deleteMany({
    where: { source: { in: ['treasury', 'nyfed', 'ecb'] } },
  });

  if (ids.length > 0) {
    await prisma.dataSource.deleteMany({ where: { id: { in: ids } } });
  }
}

async function latestObservation(
  prisma: PrismaClient,
  seriesId: string,
  refDate: string
): Promise<{
  value: { toString(): string } | null;
  publishedAt: Date | null;
  firstSeenAt: Date;
  collectedAt: Date;
  revisionNote: string | null;
  unit: string;
  source: string;
} | null> {
  return prisma.macroObservation.findFirst({
    where: { seriesId, refDate: new Date(`${refDate}T00:00:00.000Z`) },
    orderBy: { collectedAt: 'desc' },
    select: {
      value: true,
      publishedAt: true,
      firstSeenAt: true,
      collectedAt: true,
      revisionNote: true,
      unit: true,
      source: true,
    },
  });
}

async function runDb(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);

  const fakeFirst = fakeFetch();
  const first = await collectMacro({
    prisma,
    only: ['treasury'],
    fetchImpl: fakeFirst.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: primeira coleta grava 35',
    first.ok && first.observations === 35 && first.inserted === 35 && first.unchanged === 0,
    `(ok=${first.ok} observations=${first.observations} inserted=${first.inserted})`
  );

  const treasurySource = await prisma.dataSource.findUnique({
    where: { provider: 'treasury' },
    select: { id: true },
  });
  check('db: DataSource treasury', treasurySource !== null);

  const rows = await prisma.macroObservation.findMany({
    where: { source: 'treasury' },
    orderBy: { seriesId: 'asc' },
  });
  const tenYear = rows.find(
    (row) =>
      row.seriesId === 'ust_nominal_10y' &&
      row.refDate.toISOString() === '2026-10-26T00:00:00.000Z'
  );

  check('db: 35 linhas do tesouro', rows.length === 35, `(${rows.length})`);
  check(
    'db: live publishedAt nulo',
    rows.every((row) => row.publishedAt === null)
  );
  check(
    'db: live firstSeenAt=collectedAt',
    rows.every(
      (row) =>
        row.firstSeenAt.toISOString() === FIXED_NOW_1.toISOString() &&
        row.collectedAt.toISOString() === FIXED_NOW_1.toISOString()
    )
  );
  check('db: live sem revisionNote', rows.every((row) => row.revisionNote === null));
  check(
    'db: 10 Yr usa unidade PERCENT',
    tenYear?.unit === 'PERCENT' && tenYear.value?.toString() === '5',
    `(${tenYear?.value?.toString()})`
  );

  if (treasurySource !== null) {
    const successLog = await prisma.collectionLog.findFirst({
      where: {
        sourceId: treasurySource.id,
        operation: 'fetch_treasury_rates',
        status: 'success',
      },
      orderBy: { collectedAt: 'desc' },
    });
    check('db: log success com 35', successLog?.recordsFetched === 35);
  }

  const second = await collectMacro({
    prisma,
    only: ['treasury'],
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: valor idêntico não grava',
    second.ok && second.observations === 35 && second.inserted === 0 && second.unchanged === 35,
    `(inserted=${second.inserted} unchanged=${second.unchanged})`
  );

  const countAfterSecond = await prisma.macroObservation.count({ where: { source: 'treasury' } });
  check('db: contagem permanece 35', countAfterSecond === 35, `(${countAfterSecond})`);

  const revised = await collectMacro({
    prisma,
    only: ['treasury'],
    fetchImpl: fakeFetch({ nominal: nominalCsv({ revised10yOn26: '5.10' }) }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_3,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: revisão grava apenas a linha alterada',
    revised.ok && revised.observations === 35 && revised.inserted === 1 && revised.unchanged === 34,
    `(inserted=${revised.inserted} unchanged=${revised.unchanged})`
  );

  const revisedTenYear = await latestObservation(prisma, 'ust_nominal_10y', '2026-10-26');
  check(
    'db: revisão mantém histórico e valor novo',
    revisedTenYear?.value?.toString() === '5.1'
  );
  check(
    'db: revisionNote com valor anterior',
    revisedTenYear?.revisionNote === 'revised from 5'
  );
  check(
    'db: revisão preserva firstSeenAt',
    revisedTenYear?.firstSeenAt.toISOString() === FIXED_NOW_1.toISOString()
  );

  const historyCount = await prisma.macroObservation.count({
    where: {
      seriesId: 'ust_nominal_10y',
      refDate: new Date('2026-10-26T00:00:00.000Z'),
    },
  });
  check('db: histórico tem 2 linhas da revisão', historyCount === 2, `(${historyCount})`);

  await cleanup(prisma);

  const missing = await collectMacro({
    prisma,
    only: ['treasury'],
    fetchImpl: fakeFetch({ nominal: nominalCsv({ missing3mOn26: true }) }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: célula N/A eleva aviso e reduz linhas',
    missing.ok &&
      missing.observations === 34 &&
      missing.inserted === 34 &&
      missing.warnings.some((warning) => warning.includes('3 Mo vazio/N/A')),
    `(observations=${missing.observations} warnings=${missing.warnings.length})`
  );

  const missingThreeMonth = await prisma.macroObservation.count({
    where: {
      seriesId: 'ust_nominal_3m',
      refDate: new Date('2026-10-26T00:00:00.000Z'),
    },
  });
  check('db: N/A não grava linha nem zero', missingThreeMonth === 0, `(${missingThreeMonth})`);

  await cleanup(prisma);

  const backfill = await collectMacro({
    prisma,
    only: ['nyfed'],
    backfillFrom: BACKFILL_FROM,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: backfill NY Fed grava 10',
    backfill.ok && backfill.observations === 10 && backfill.inserted === 10,
    `(observations=${backfill.observations} inserted=${backfill.inserted})`
  );

  const sofrFriday = await latestObservation(prisma, 'sofr', '2026-10-23');
  check(
    'db: backfill estima publicação da SOFR',
    sofrFriday?.publishedAt?.toISOString() === '2026-10-26T13:00:00.000Z' &&
      sofrFriday.firstSeenAt.toISOString() === '2026-10-26T13:00:00.000Z',
    `(published=${sofrFriday?.publishedAt?.toISOString()})`
  );
  check(
    'db: nota de backfill',
    sofrFriday?.revisionNote === 'backfill:estimated_publication'
  );
  check(
    'db: collectedAt real do backfill',
    sofrFriday?.collectedAt.toISOString() === FIXED_NOW_1.toISOString()
  );

  const sofrBeforeRevision = await latestObservation(prisma, 'sofr', '2026-10-22');
  const originalFirstSeenAt = sofrBeforeRevision?.firstSeenAt.toISOString();

  const backfillRevision = await collectMacro({
    prisma,
    only: ['nyfed'],
    backfillFrom: BACKFILL_FROM,
    fetchImpl: fakeFetch({
      sofr: sofrPayload({ revised22: true, revisionIndicator: 'R' }),
    }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: backfill revisado grava só a alteração',
    backfillRevision.ok &&
      backfillRevision.observations === 10 &&
      backfillRevision.inserted === 1 &&
      backfillRevision.unchanged === 9,
    `(inserted=${backfillRevision.inserted})`
  );

  const sofrRevised = await latestObservation(prisma, 'sofr', '2026-10-22');
  check('db: valor revisado da SOFR', sofrRevised?.value?.toString() === '3.91');
  check(
    'db: nota inclui revisão e revisionIndicator',
    sofrRevised?.revisionNote ===
      'backfill:estimated_publication; revised from 3.9; revisionIndicator=R',
    `(${sofrRevised?.revisionNote})`
  );
  check(
    'db: revisão de backfill preserva firstSeenAt',
    sofrRevised?.firstSeenAt.toISOString() === originalFirstSeenAt
  );

  await cleanup(prisma);

  const ecb = await collectMacro({
    prisma,
    only: ['ecb'],
    backfillFrom: BACKFILL_FROM,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const ecbLatest = await latestObservation(prisma, 'ecb_eurusd', '2026-10-26');

  check(
    'db: BCE grava 5',
    ecb.ok && ecb.observations === 5 && ecb.inserted === 5,
    `(observations=${ecb.observations})`
  );
  check(
    'db: BCE usa USD_PER_EUR e valor correto',
    ecbLatest?.unit === 'USD_PER_EUR' && ecbLatest.value?.toString() === '1.1188'
  );
  check(
    'db: BCE estima publicação 16 UTC',
    ecbLatest?.publishedAt?.toISOString() === '2026-10-26T16:00:00.000Z'
  );

  await cleanup(prisma);

  const fake429 = fakeFetch({}, { failSubstring: 'secured/sofr', failStatus: 429 });
  const limited = await collectMacro({
    prisma,
    only: ['nyfed'],
    fetchImpl: fake429.fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const limitedSource = await prisma.dataSource.findUnique({
    where: { provider: 'nyfed' },
    select: { id: true },
  });
  const limitedRows = await prisma.macroObservation.count({ where: { source: 'nyfed' } });

  check(
    'db: 429 para imediatamente e sem linhas',
    limited.rateLimited &&
      limited.httpStatus === 429 &&
      limited.observations === 0 &&
      fake429.calls.length === 1 &&
      limitedRows === 0,
    `(calls=${fake429.calls.length} rows=${limitedRows})`
  );

  if (limitedSource !== null) {
    const errorLog = await prisma.collectionLog.findFirst({
      where: { sourceId: limitedSource.id, status: 'error', httpStatus: 429 },
    });
    check('db: falha 429 registrada', errorLog !== null);
  }

  await cleanup(prisma);

  const dryLines: string[] = [];
  const dry = await collectMacro({
    prisma,
    dryRun: true,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: (line) => dryLines.push(line),
    logError: () => {},
  });
  const drySources = await prisma.dataSource.count({
    where: { provider: { in: ['treasury', 'nyfed', 'ecb'] } },
  });
  const dryRows = await prisma.macroObservation.count({
    where: { source: { in: ['treasury', 'nyfed', 'ecb'] } },
  });
  const dryLogs = await prisma.collectionLog.count({
    where: { source: { provider: { in: ['treasury', 'nyfed', 'ecb'] } } },
  });

  check('db: dry-run calcula 50', dry.ok && dry.observations === 50);
  check('db: dry-run não cria DataSource', drySources === 0, `(${drySources})`);
  check('db: dry-run não grava MacroObservation', dryRows === 0, `(${dryRows})`);
  check('db: dry-run não grava CollectionLog', dryLogs === 0, `(${dryLogs})`);
  check(
    'db: dry-run imprime série e resumo',
    dryLines.some((line) => line.includes('series=ecb_eurusd count=5')) &&
      dryLines.some((line) => line.includes('resumo observations=50'))
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
  process.exit(failures === 0 ? 0 : 1);
}

main();
