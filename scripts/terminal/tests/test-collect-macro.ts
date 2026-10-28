#!/usr/bin/env node

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import { collectMacro, parseMacroArgs } from '../collect-macro';
import {
  InvalidPayloadError,
  MACRO_REQUEST_PAUSE_MS,
  MACRO_SERIES,
  addUtcDays,
  estimatePublishedAt,
  formatIsoDateUtc,
  nextBusinessDay,
  parseIsoDateUtc,
  startOfUtcDay,
  type BlsSeriesDefinition,
  type FetchLike,
} from '../sources/macro-config';
import { parseTreasuryCsv } from '../sources/macro-treasury';
import { parseNyfedPayload } from '../sources/macro-nyfed';
import { parseEcbCsv } from '../sources/macro-ecb';
import { fedH10Url, parseFedCsv } from '../sources/macro-fed';
import { parseBlsPayload } from '../sources/macro-bls';

const FIXED_NOW_1 = new Date('2026-10-26T20:00:00.000Z');
const FIXED_NOW_2 = new Date('2026-10-26T21:00:00.000Z');
const FIXED_NOW_3 = new Date('2026-10-26T22:00:00.000Z');
const BACKFILL_FROM = new Date('2026-10-20T00:00:00.000Z');
const FED_BACKFILL_FROM = new Date('2026-10-01T00:00:00.000Z');
const BLS_BACKFILL_FROM = new Date('2026-09-01T00:00:00.000Z');
const BLS_SERIES = MACRO_SERIES.filter(
  (definition): definition is BlsSeriesDefinition => definition.source === 'bls'
);

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
  fed?: string;
  fedContentType?: string;
  bls?: unknown;
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

function largeNyfedPayloads(
  startDate: Date,
  count: number
): { sofr: unknown; effr: unknown; startDate: Date } {
  const sofr: Record<string, unknown>[] = [];
  const effr: Record<string, unknown>[] = [];

  for (let index = 0; index < count; index++) {
    const effectiveDate = formatIsoDateUtc(addUtcDays(startDate, index));
    sofr.push({
      effectiveDate,
      type: 'SOFR',
      percentRate: (350 + (index % 10)) / 100,
      revisionIndicator: '',
    });
    effr.push({
      effectiveDate,
      type: 'EFFR',
      percentRate: (340 + (index % 10)) / 100,
      revisionIndicator: '',
    });
  }

  return { sofr: { refRates: sofr }, effr: { refRates: effr }, startDate };
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

function fedCsv(): string {
  return [
    '"Series Description","Nominal Broad Dollar Index","Nominal Major Currencies Dollar Index"',
    '"Unit:","Index:_1997_Jan_100","Index:_1997_Jan_100"',
    '"Time Period","JRXWTFB_N.B","JRXWTFN_N.B","JRXWTFO_N.B"',
    '2026-10-08,121.4469,118.1,119.2',
    '2026-10-09,121.6023,118.4,119.5',
    '2026-10-12,ND,NA,NA',
    '2026-10-19,121.3248,118.0,119.1',
    '2026-10-23,121.3202,117.9,119.0',
  ].join('\n');
}

function blsPayload(options: { missingStatus?: boolean } = {}): unknown {
  return {
    status: options.missingStatus === true ? undefined : 'REQUEST_SUCCEEDED',
    responseTime: 0,
    message: [],
    Results: {
      series: [
        {
          seriesID: 'CUSR0000SA0',
          data: [
            { year: '2026', period: 'M09', value: '336.298' },
            { year: '2026', period: 'M08', value: '-' },
            { year: '2026', period: 'M13', value: '999.999' },
          ],
        },
        {
          seriesID: 'CUSR0000SA0L1E',
          data: [{ year: '2026', period: 'M09', value: '338.896' }],
        },
        {
          seriesID: 'LNS14000000',
          data: [{ year: '2026', period: 'M09', value: '4.2' }],
        },
        {
          seriesID: 'CES0000000001',
          data: [{ year: '2026', period: 'M09', value: '159044' }],
        },
      ],
    },
  };
}

interface FedHistoryRow {
  refDate: Date;
  value: string;
  status: 'ok';
}

function fedHistoryRows(count = 30, startOffsetDays = -40): FedHistoryRow[] {
  const start = addUtcDays(startOfUtcDay(FIXED_NOW_1), startOffsetDays);

  return Array.from({ length: count }, (_, index) => ({
    refDate: addUtcDays(start, index),
    value: (120 + index / 100).toFixed(4),
    status: 'ok' as const,
  }));
}

function fedCsvFromRows(rows: readonly FedHistoryRow[]): string {
  return [
    '"Series Description","Nominal Broad Dollar Index","Nominal Major Currencies Dollar Index"',
    '"Unit:","Index:_1997_Jan_100","Index:_1997_Jan_100"',
    '"Time Period","JRXWTFB_N.B","JRXWTFN_N.B","JRXWTFO_N.B"',
    ...rows.map(
      (row) => `${formatIsoDateUtc(row.refDate)},${row.value},120.0,120.0`
    ),
  ].join('\n');
}

function blsMonth(index: number): { year: string; period: string } {
  const year = 2025 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year: String(year), period: `M${String(month).padStart(2, '0')}` };
}

function blsHistoricalPayload(): unknown {
  const specs = [
    {
      seriesID: 'CUSR0000SA0',
      count: 21,
      value: (index: number) => (300 + index / 10).toFixed(3),
    },
    {
      seriesID: 'CUSR0000SA0L1E',
      count: 21,
      value: (index: number) => (310 + index / 10).toFixed(3),
    },
    {
      seriesID: 'LNS14000000',
      count: 21,
      value: (index: number) => (4 + index / 100).toFixed(2),
    },
    {
      seriesID: 'CES0000000001',
      count: 18,
      value: (index: number) => String(150000 + index * 100),
    },
  ];

  return {
    status: 'REQUEST_SUCCEEDED',
    responseTime: 0,
    message: [],
    Results: {
      series: specs.map((spec) => ({
        seriesID: spec.seriesID,
        data: Array.from({ length: spec.count }, (_, index) => ({
          ...blsMonth(index),
          value: spec.value(index),
        })),
      })),
    },
  };
}

function fedSeedRows(rows: readonly FedHistoryRow[]) {
  return rows.map((row) => ({
    seriesId: 'fed_broad_dollar',
    source: 'fed',
    unit: 'INDEX_1973_100',
    refDate: row.refDate,
    value: row.value,
    status: row.status,
  }));
}

interface MacroSeedObservation {
  seriesId: string;
  source: string;
  unit: string;
  refDate: Date;
  value: string | null;
  status?: string;
}

async function seedMacroObservations(
  prisma: PrismaClient,
  observations: readonly MacroSeedObservation[],
  collectedAt: Date
): Promise<void> {
  if (observations.length === 0) return;

  await prisma.macroObservation.createMany({
    data: observations.map((observation) => ({
      seriesId: observation.seriesId,
      source: observation.source,
      refDate: observation.refDate,
      value: observation.value === null ? null : new Decimal(observation.value),
      status: observation.status ?? 'ok',
      unit: observation.unit,
      publishedAt: null,
      firstSeenAt: collectedAt,
      collectedAt,
      revisionNote: null,
    })),
  });
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
): {
  fetchImpl: FetchLike;
  calls: string[];
  requests: { url: string; init?: RequestInit }[];
} {
  const calls: string[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(url);
    requests.push({ url, init });

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

    if (url.includes('federalreserve.gov/datadownload/Output.aspx')) {
      return new Response(fixtures.fed ?? fedCsv(), {
        status: 200,
        headers: { 'content-type': fixtures.fedContentType ?? 'text/csv; charset=UTF-8' },
      });
    }

    if (url.includes('api.bls.gov/publicAPI/v2/timeseries/data/')) {
      return jsonResponse(fixtures.bls ?? blsPayload());
    }

    return new Response('not found', { status: 404 });
  };

  return { fetchImpl, calls, requests };
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

interface QueryLog {
  query: string;
  params: string;
}

function queryParams(event: QueryLog): unknown[] {
  try {
    const parsed = JSON.parse(event.params) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function macroQueries(events: readonly QueryLog[], operation: 'select' | 'insert'): QueryLog[] {
  const pattern = operation === 'select' ? /^SELECT/i : /^INSERT/i;
  return events.filter(
    (event) => pattern.test(event.query.trim()) && event.query.includes('"MacroObservation"')
  );
}

function queriesForSeries(events: readonly QueryLog[], seriesId: string): number {
  return events.filter((event) => queryParams(event).some((value) => value === seriesId)).length;
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
    'fed: URL de backfill usa ISO e termina na sexta',
    fedH10Url(
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-10-27T00:00:00.000Z')
    ).includes('from=2025-01-01&to=2026-10-23')
  );

  const parsedFed = parseFedCsv(fedCsv());
  check('fed: 5 taxas', parsedFed.rates.length === 5, `(${parsedFed.rates.length})`);
  const fedNd = parsedFed.rates.find(
    (rate) => formatIsoDateUtc(rate.refDate) === '2026-10-12'
  );
  check(
    'fed: ND vira status nd sem valor',
    fedNd?.status === 'nd' && fedNd.value === null
  );
  const fedLatest = parsedFed.rates.find(
    (rate) => formatIsoDateUtc(rate.refDate) === '2026-10-23'
  );
  check(
    'fed: valor decimal e data UTC',
    fedLatest?.value === '121.3202' &&
      fedLatest.refDate.toISOString() === '2026-10-23T00:00:00.000Z'
  );

  let fedMissingHeader = false;
  try {
    parseFedCsv(fedCsv().replace('"Time Period"', '"Date"'));
  } catch (error) {
    fedMissingHeader = error instanceof InvalidPayloadError;
  }
  check('fed: cabeçalho divergente falha', fedMissingHeader);

  let fedNoData = false;
  try {
    parseFedCsv('"Time Period","JRXWTFB_N.B"\n');
  } catch (error) {
    fedNoData = error instanceof InvalidPayloadError;
  }
  check('fed: CSV sem dados falha', fedNoData);

  const parsedBls = parseBlsPayload(blsPayload(), BLS_SERIES);
  check(
    'bls: 4 observações e M13 ignorado',
    parsedBls.observations.length === 4 &&
      !parsedBls.observations.some((observation) => observation.value === '999.999'),
    `(${parsedBls.observations.length})`
  );
  check(
    'bls: "-" omitido com aviso',
    parsedBls.warnings.some((warning) => warning.includes('M08 valor ausente'))
  );

  const blsById = new Map(
    parsedBls.observations.map((observation) => [observation.seriesId, observation])
  );
  const blsCpi = blsById.get('bls_cpi_u_sa');
  check(
    'bls: CPI com unidade INDEX e refDate dia 1',
    blsCpi?.value === '336.298' &&
      blsCpi.unit === 'INDEX' &&
      blsCpi.refDate.toISOString() === '2026-09-01T00:00:00.000Z'
  );
  check(
    'bls: unidades de desemprego e payroll',
    blsById.get('bls_unemployment_rate')?.unit === 'PERCENT' &&
      blsById.get('bls_nonfarm_payrolls')?.unit === 'THOUSANDS'
  );

  let blsMissingStatus = false;
  try {
    parseBlsPayload(blsPayload({ missingStatus: true }), BLS_SERIES);
  } catch (error) {
    blsMissingStatus = error instanceof InvalidPayloadError;
  }
  check('bls: status ausente falha', blsMissingStatus);

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
    'publicação: Fed sexta -> segunda 22 UTC',
    estimatePublishedAt('fed', new Date('2026-10-23T00:00:00.000Z')).toISOString() ===
      '2026-10-26T22:00:00.000Z'
  );
  check(
    'publicação: Fed quinta -> segunda seguinte',
    estimatePublishedAt('fed', new Date('2026-10-08T00:00:00.000Z')).toISOString() ===
      '2026-10-12T22:00:00.000Z'
  );
  check(
    'publicação: BLS mês seguinte 22 UTC',
    estimatePublishedAt('bls', new Date('2026-09-01T00:00:00.000Z')).toISOString() ===
      '2026-10-31T22:00:00.000Z'
  );
  check(
    'publicação: BLS dezembro -> janeiro',
    estimatePublishedAt('bls', new Date('2026-12-01T00:00:00.000Z')).toISOString() ===
      '2027-01-31T22:00:00.000Z'
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
    only: ['treasury', 'nyfed', 'ecb'],
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

  const fedFake = fakeFetch();
  const fedLines: string[] = [];
  const fedDry = await collectMacro({
    dryRun: true,
    only: ['fed'],
    fetchImpl: fedFake.fetchImpl,
    sleepImpl: noSleep().sleepImpl,
    now: () => FIXED_NOW_1,
    log: (line) => fedLines.push(line),
    logError: () => {},
  });
  check(
    'dry-run Fed: 5 observações e lastobs=30',
    fedDry.ok &&
      fedDry.observations === 5 &&
      fedFake.calls.length === 1 &&
      fedFake.calls[0]?.includes('lastobs=30') === true,
    `(observations=${fedDry.observations} calls=${fedFake.calls.length})`
  );
  check(
    'dry-run Fed: ND imprime valor nulo e status',
    fedLines.some(
      (line) =>
        line.includes('refDate=2026-10-12') &&
        line.includes('value=null status=nd')
    )
  );

  const fedHtml = await collectMacro({
    dryRun: true,
    only: ['fed'],
    fetchImpl: fakeFetch({ fed: '<!DOCTYPE html><html><body>erro</body></html>' })
      .fetchImpl,
    sleepImpl: noSleep().sleepImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  check(
    'dry-run Fed: HTML falha sem observações',
    !fedHtml.ok &&
      fedHtml.observations === 0 &&
      fedHtml.failures.some((failure) => failure.includes('HTML'))
  );

  const blsFake = fakeFetch();
  const blsLines: string[] = [];
  const blsDry = await collectMacro({
    dryRun: true,
    only: ['bls'],
    fetchImpl: blsFake.fetchImpl,
    sleepImpl: noSleep().sleepImpl,
    now: () => FIXED_NOW_1,
    log: (line) => blsLines.push(line),
    logError: () => {},
  });
  const blsBody = JSON.parse(String(blsFake.requests[0]?.init?.body)) as {
    seriesid?: string[];
    startyear?: string;
    endyear?: string;
  };
  check(
    'dry-run BLS: 4 observações e uma chamada',
    blsDry.ok && blsDry.observations === 4 && blsFake.calls.length === 1,
    `(observations=${blsDry.observations} calls=${blsFake.calls.length})`
  );
  check(
    'dry-run BLS: corpo com 4 séries e anos live',
    blsBody.seriesid?.join(',') ===
      'CUSR0000SA0,CUSR0000SA0L1E,LNS14000000,CES0000000001' &&
      blsBody.startyear === '2025' &&
      blsBody.endyear === '2026'
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
    where: { provider: { in: ['treasury', 'nyfed', 'ecb', 'fed', 'bls'] } },
    select: { id: true },
  });
  const ids = sources.map((source) => source.id);

  if (ids.length > 0) {
    await prisma.collectionLog.deleteMany({ where: { sourceId: { in: ids } } });
  }

  await prisma.macroObservation.deleteMany({
    where: { source: { in: ['treasury', 'nyfed', 'ecb', 'fed', 'bls'] } },
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
  status: string;
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
      status: true,
    },
  });
}

async function runDb(prisma: PrismaClient, queryLog: QueryLog[]): Promise<void> {
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

  const fed = await collectMacro({
    prisma,
    only: ['fed'],
    backfillFrom: FED_BACKFILL_FROM,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const fedNd = await latestObservation(prisma, 'fed_broad_dollar', '2026-10-12');
  const fedLatest = await latestObservation(prisma, 'fed_broad_dollar', '2026-10-23');

  check(
    'db: Fed grava 5 incluindo ND',
    fed.ok && fed.observations === 5 && fed.inserted === 5,
    `(observations=${fed.observations} inserted=${fed.inserted})`
  );
  check(
    'db: Fed ND fica nulo com status nd',
    fedNd?.value === null &&
      fedNd.status === 'nd' &&
      fedNd.unit === 'INDEX_1973_100' &&
      fedNd.source === 'fed'
  );
  check(
    'db: Fed publicação segunda 22 UTC e nota backfill',
    fedLatest?.publishedAt?.toISOString() === '2026-10-26T22:00:00.000Z' &&
      fedLatest.firstSeenAt.toISOString() === '2026-10-26T22:00:00.000Z' &&
      fedLatest.revisionNote === 'backfill:estimated_publication',
    `(published=${fedLatest?.publishedAt?.toISOString()})`
  );

  queryLog.length = 0;
  const fedAgain = await collectMacro({
    prisma,
    only: ['fed'],
    backfillFrom: FED_BACKFILL_FROM,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  check(
    'db: Fed igual compara status e valor nulo',
    fedAgain.ok && fedAgain.inserted === 0 && fedAgain.unchanged === 5,
    `(inserted=${fedAgain.inserted} unchanged=${fedAgain.unchanged})`
  );
  check(
    'db: Fed faz uma leitura por série',
    macroQueries(queryLog, 'select').length === 1,
    `(${macroQueries(queryLog, 'select').length})`
  );

  await cleanup(prisma);

  const bls = await collectMacro({
    prisma,
    only: ['bls'],
    backfillFrom: BLS_BACKFILL_FROM,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const blsCpi = await latestObservation(prisma, 'bls_cpi_u_sa', '2026-09-01');
  const blsPayroll = await latestObservation(
    prisma,
    'bls_nonfarm_payrolls',
    '2026-09-01'
  );
  const blsCpiRows = await prisma.macroObservation.count({
    where: { seriesId: 'bls_cpi_u_sa' },
  });

  check(
    'db: BLS grava 4 e omite M13/ausente',
    bls.ok &&
      bls.observations === 4 &&
      bls.inserted === 4 &&
      blsCpiRows === 1 &&
      bls.warnings.some((warning) => warning.includes('M08 valor ausente')),
    `(observations=${bls.observations} rows=${blsCpiRows})`
  );
  check(
    'db: BLS CPI unidade, publicação e nota latest_vintage',
    blsCpi?.value?.toString() === '336.298' &&
      blsCpi.unit === 'INDEX' &&
      blsCpi.status === 'ok' &&
      blsCpi.publishedAt?.toISOString() === '2026-10-31T22:00:00.000Z' &&
      blsCpi.revisionNote === 'backfill:estimated_publication;latest_vintage',
    `(published=${blsCpi?.publishedAt?.toISOString()})`
  );
  check(
    'db: BLS payroll em milhares',
    blsPayroll?.value?.toString() === '159044' &&
      blsPayroll.unit === 'THOUSANDS'
  );

  const blsAgain = await collectMacro({
    prisma,
    only: ['bls'],
    backfillFrom: BLS_BACKFILL_FROM,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  check(
    'db: BLS igual não grava novamente',
    blsAgain.ok && blsAgain.inserted === 0 && blsAgain.unchanged === 4,
    `(inserted=${blsAgain.inserted} unchanged=${blsAgain.unchanged})`
  );

  await cleanup(prisma);

  const blsHistorical = blsHistoricalPayload();
  const parsedBlsHistorical = parseBlsPayload(blsHistorical, BLS_SERIES);
  const oldBlsCollectedAt = new Date('2026-05-15T12:00:00.000Z');
  await seedMacroObservations(
    prisma,
    parsedBlsHistorical.observations,
    oldBlsCollectedAt
  );
  check(
    'db: fixture BLS histórica tem 81 observações',
    parsedBlsHistorical.observations.length === 81,
    `(${parsedBlsHistorical.observations.length})`
  );

  queryLog.length = 0;
  const blsLive = await collectMacro({
    prisma,
    only: ['bls'],
    fetchImpl: fakeFetch({ bls: blsHistorical }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const blsLiveSelects = macroQueries(queryLog, 'select');
  const blsLiveRows = await prisma.macroObservation.count({ where: { source: 'bls' } });

  check(
    'db: BLS live com 81 antigas e janela de 10 dias não grava',
    blsLive.ok &&
      blsLive.observations === 81 &&
      blsLive.inserted === 0 &&
      blsLive.unchanged === 81,
    `(inserted=${blsLive.inserted} unchanged=${blsLive.unchanged})`
  );
  check('db: BLS live não duplica as 81', blsLiveRows === 81, `(${blsLiveRows})`);
  check(
    'db: BLS live faz uma leitura por série',
    blsLiveSelects.length === 4 &&
      queriesForSeries(blsLiveSelects, 'bls_cpi_u_sa') === 1 &&
      queriesForSeries(blsLiveSelects, 'bls_core_cpi_sa') === 1 &&
      queriesForSeries(blsLiveSelects, 'bls_unemployment_rate') === 1 &&
      queriesForSeries(blsLiveSelects, 'bls_nonfarm_payrolls') === 1,
    `(selects=${blsLiveSelects.length})`
  );

  await cleanup(prisma);

  const fedRows = fedHistoryRows();
  const oldFedCollectedAt = new Date('2026-09-01T12:00:00.000Z');
  await seedMacroObservations(prisma, fedSeedRows(fedRows), oldFedCollectedAt);

  queryLog.length = 0;
  const fedLive = await collectMacro({
    prisma,
    only: ['fed'],
    fetchImpl: fakeFetch({ fed: fedCsvFromRows(fedRows) }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fedLiveSelects = macroQueries(queryLog, 'select');

  check(
    'db: Fed live com linhas de até 40 dias atrás não grava',
    fedLive.ok &&
      fedLive.observations === 30 &&
      fedLive.inserted === 0 &&
      fedLive.unchanged === 30,
    `(inserted=${fedLive.inserted} unchanged=${fedLive.unchanged})`
  );
  check(
    'db: Fed live antigo faz uma leitura por série',
    fedLiveSelects.length === 1,
    `(selects=${fedLiveSelects.length})`
  );

  await cleanup(prisma);

  const missingIndex = 10;
  await seedMacroObservations(
    prisma,
    fedSeedRows(fedRows.filter((_, index) => index !== missingIndex)),
    oldFedCollectedAt
  );

  queryLog.length = 0;
  const fedNewMiddle = await collectMacro({
    prisma,
    only: ['fed'],
    fetchImpl: fakeFetch({ fed: fedCsvFromRows(fedRows) }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fedNewMiddleSelects = macroQueries(queryLog, 'select');
  const insertedMiddleDate = formatIsoDateUtc(fedRows[missingIndex].refDate);
  const insertedMiddle = await latestObservation(
    prisma,
    'fed_broad_dollar',
    insertedMiddleDate
  );

  check(
    'db: observação nova no meio de dados antigos é gravada',
    fedNewMiddle.ok &&
      fedNewMiddle.inserted === 1 &&
      fedNewMiddle.unchanged === 29 &&
      insertedMiddle?.value?.toString() === '120.1',
    `(inserted=${fedNewMiddle.inserted} middle=${insertedMiddle?.value?.toString()})`
  );
  check(
    'db: observação nova no meio faz uma leitura por série',
    fedNewMiddleSelects.length === 1,
    `(selects=${fedNewMiddleSelects.length})`
  );

  await cleanup(prisma);

  const revisionIndex = 0;
  const revisedFedRows = fedRows.map((row, index) =>
    index === revisionIndex ? { ...row, value: '999.9999' } : row
  );
  await seedMacroObservations(prisma, fedSeedRows(fedRows), oldFedCollectedAt);

  queryLog.length = 0;
  const fedOldRevision = await collectMacro({
    prisma,
    only: ['fed'],
    fetchImpl: fakeFetch({ fed: fedCsvFromRows(revisedFedRows) }).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const fedOldRevisionSelects = macroQueries(queryLog, 'select');
  const revisedOldDate = formatIsoDateUtc(fedRows[revisionIndex].refDate);
  const revisedOld = await latestObservation(
    prisma,
    'fed_broad_dollar',
    revisedOldDate
  );

  check(
    'db: revisão fora de 10 dias grava linha nova',
    fedOldRevision.ok &&
      fedOldRevision.inserted === 1 &&
      fedOldRevision.unchanged === 29 &&
      revisedOld?.value?.toString() === '999.9999' &&
      revisedOld.revisionNote === 'revised from 120',
    `(inserted=${fedOldRevision.inserted} note=${revisedOld?.revisionNote})`
  );
  check(
    'db: revisão antiga faz uma leitura por série',
    fedOldRevisionSelects.length === 1,
    `(selects=${fedOldRevisionSelects.length})`
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

  const largeCount = 1001;
  const largeStart = addUtcDays(startOfUtcDay(FIXED_NOW_1), -(largeCount - 1));
  const largeFixtures = largeNyfedPayloads(largeStart, largeCount);
  const batchLines: string[] = [];

  queryLog.length = 0;
  const largeFirst = await collectMacro({
    prisma,
    only: ['nyfed'],
    backfillFrom: largeStart,
    fetchImpl: fakeFetch(largeFixtures).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    log: (line) => batchLines.push(line),
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  const firstSelects = macroQueries(queryLog, 'select');
  const firstInserts = macroQueries(queryLog, 'insert');

  check(
    'db: lote insere 2002 observações',
    largeFirst.ok &&
      largeFirst.observations === 2002 &&
      largeFirst.inserted === 2002 &&
      largeFirst.unchanged === 0,
    `(observations=${largeFirst.observations} inserted=${largeFirst.inserted})`
  );
  check(
    'db: 1 leitura por série no lote',
    firstSelects.length === 2 &&
      queriesForSeries(firstSelects, 'sofr') === 1 &&
      queriesForSeries(firstSelects, 'effr') === 1,
    `(selects=${firstSelects.length} sofr=${queriesForSeries(firstSelects, 'sofr')} effr=${queriesForSeries(firstSelects, 'effr')})`
  );
  check(
    'db: ceil(1001/500)=3 inserções por série',
    firstInserts.length === 6 &&
      queriesForSeries(firstInserts, 'sofr') === 3 &&
      queriesForSeries(firstInserts, 'effr') === 3,
    `(inserts=${firstInserts.length} sofr=${queriesForSeries(firstInserts, 'sofr')} effr=${queriesForSeries(firstInserts, 'effr')})`
  );
  check(
    'db: progresso inicia cada série',
    batchLines.some((line) => line.includes('série=sofr lidas=0')) &&
      batchLines.some((line) => line.includes('série=effr lidas=0'))
  );
  check(
    'db: progresso registra 6 lotes',
    batchLines.filter((line) => line.includes('lote=')).length === 6,
    `(${batchLines.filter((line) => line.includes('lote=')).length})`
  );
  check(
    'db: progresso termina cada série',
    batchLines.some((line) =>
      line.includes('série=sofr inseridas=1001 iguais=0 revisadas=0')
    ) &&
      batchLines.some((line) =>
        line.includes('série=effr inseridas=1001 iguais=0 revisadas=0')
      )
  );

  queryLog.length = 0;
  const secondLines: string[] = [];
  const largeSecond = await collectMacro({
    prisma,
    only: ['nyfed'],
    backfillFrom: largeStart,
    fetchImpl: fakeFetch(largeFixtures).fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_2,
    log: (line) => secondLines.push(line),
    logError: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  const secondSelects = macroQueries(queryLog, 'select');
  const secondInserts = macroQueries(queryLog, 'insert');

  check(
    'db: segunda execução em lote tem inserted=0',
    largeSecond.ok &&
      largeSecond.observations === 2002 &&
      largeSecond.inserted === 0 &&
      largeSecond.unchanged === 2002,
    `(inserted=${largeSecond.inserted} unchanged=${largeSecond.unchanged})`
  );
  check(
    'db: segunda execução mantém 1 leitura por série',
    secondSelects.length === 2 &&
      queriesForSeries(secondSelects, 'sofr') === 1 &&
      queriesForSeries(secondSelects, 'effr') === 1,
    `(selects=${secondSelects.length})`
  );
  check(
    'db: segunda execução não insere lotes',
    secondInserts.length === 0,
    `(inserts=${secondInserts.length})`
  );
  check(
    'db: segunda execução reporta iguais por série',
    secondLines.some((line) =>
      line.includes('série=sofr inseridas=0 iguais=1001 revisadas=0')
    ) &&
      secondLines.some((line) =>
        line.includes('série=effr inseridas=0 iguais=1001 revisadas=0')
      ) &&
      !secondLines.some((line) => line.includes('lote='))
  );

  await cleanup(prisma);

  const dryLines: string[] = [];
  const dry = await collectMacro({
    prisma,
    dryRun: true,
    fetchImpl: fakeFetch().fetchImpl,
    sleepImpl: async () => {},
    now: () => FIXED_NOW_1,
    only: ['treasury', 'nyfed', 'ecb'],
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
  process.exit(failures === 0 ? 0 : 1);
}

main();
