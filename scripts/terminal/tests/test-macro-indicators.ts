#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  MACRO_STATE_KNOWN_CUTOFF_UTC_HOUR,
  macroKnownCutoff,
  readMacroObservations,
  readMacroObservationsFromRows,
  type MacroObservationPoint,
  type MacroObservationRowInput,
  type MacroSeriesMap,
} from '../indicators/macro-reader';
import {
  macro_breakeven_10y,
  macro_breakeven_5y,
  macro_dollar_broad_change_5d_pct,
  macro_eurusd_change_5d_pct,
  macro_real_yield_10y_change_5d,
  macro_sofr_effr_spread,
  macro_ust_2s10s_spread,
  macro_ust_2y_change_5d,
  macro_ust_10y_change_5d,
  type MacroIndicatorResult,
} from '../indicators/macro-formulas';
import {
  MACRO_INDICATORS,
  MACRO_STALE_DAYS_DAILY,
  MACRO_STALE_DAYS_FED,
  MACRO_STALE_DAYS_MONTHLY,
  computeMacroIndicators,
  macro_core_cpi_yoy_pct,
  macro_cpi_yoy_pct,
  macro_payrolls_change_1m,
  macro_unemployment_change_3m,
  parseMacroReportArgs,
} from '../indicators/macro-catalog';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_SOURCE = 'macro_test_reader';
const SERIES_A = 'test_macro_reader_ust';
const SERIES_B = 'test_macro_reader_sofr';
const SERIES_EMPTY = 'test_macro_reader_empty';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function decimalString(value: Decimal | null): string {
  return value === null ? 'null' : value.toString();
}

function point(date: string, value: string, firstSeenAt = `${date}T22:00:00.000Z`): MacroObservationPoint {
  return {
    refDate: new Date(`${date}T00:00:00.000Z`),
    value: new Decimal(value),
    firstSeenAt: new Date(firstSeenAt),
  };
}

function consecutive(values: readonly string[], endDate: string): MacroObservationPoint[] {
  const endMs = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return values.map((value, index) =>
    point(
      new Date(endMs - (values.length - 1 - index) * DAY_MS).toISOString().slice(0, 10),
      value
    )
  );
}

function monthly(entries: ReadonlyArray<readonly [string, string]>): MacroObservationPoint[] {
  return entries.map(([month, value]) => point(`${month}-01`, value));
}

function map(entries: Record<string, MacroObservationPoint[]>): MacroSeriesMap {
  return entries;
}

function baseDailySeries(): MacroSeriesMap {
  return map({
    ust_nominal_10y: consecutive(['4.0', '4.1', '4.2', '4.3', '4.4', '4.5'], '2026-10-06'),
    ust_nominal_2y: consecutive(['3.5', '3.6', '3.7', '3.8', '3.9', '4.0'], '2026-10-06'),
    ust_nominal_5y: consecutive(['3.8', '3.9', '4.0', '4.1', '4.2', '4.3'], '2026-10-06'),
    ust_real_10y: consecutive(['1.5', '1.6', '1.7', '1.8', '1.9', '2.0'], '2026-10-06'),
    ust_real_5y: consecutive(['1.4', '1.5', '1.6', '1.7', '1.8', '1.9'], '2026-10-06'),
    sofr: consecutive(['4.1', '4.12', '4.14', '4.16', '4.18', '4.2'], '2026-10-06'),
    effr: consecutive(['4.0', '4.02', '4.04', '4.06', '4.08', '4.1'], '2026-10-06'),
    fed_broad_dollar: consecutive(
      ['100', '101', '102', '103', '104', '110'],
      '2026-10-06'
    ),
    ecb_eurusd: consecutive(
      ['1.00', '1.01', '1.02', '1.03', '1.04', '1.10'],
      '2026-10-06'
    ),
    bls_cpi_u_sa: monthly([
      ['2025-09', '320'],
      ['2026-09', '336.298'],
    ]),
    bls_core_cpi_sa: monthly([
      ['2025-09', '320'],
      ['2026-09', '338.896'],
    ]),
    bls_unemployment_rate: monthly([
      ['2026-06', '4.0'],
      ['2026-07', '4.1'],
      ['2026-08', '4.1'],
      ['2026-09', '4.2'],
    ]),
    bls_nonfarm_payrolls: monthly([
      ['2026-08', '159015'],
      ['2026-09', '159044'],
    ]),
  });
}

function expectValue(name: string, result: MacroIndicatorResult, expected: string): void {
  check(
    name,
    result.status === 'ok' && decimalString(result.value) === expected,
    `(status=${result.status} value=${decimalString(result.value)})`
  );
}

function runPureTests(): void {
  check(
    'reader: corte D+1 01:00 UTC',
    MACRO_STATE_KNOWN_CUTOFF_UTC_HOUR === 1 &&
      macroKnownCutoff('2026-10-26').toISOString() === '2026-10-27T01:00:00.000Z'
  );

  const rows: MacroObservationRowInput[] = [
    {
      seriesId: 'test_treasury',
      refDate: new Date('2026-10-26T00:00:00.000Z'),
      value: new Decimal('5.0'),
      status: 'ok',
      firstSeenAt: new Date('2026-10-26T22:00:00.000Z'),
    },
    {
      seriesId: 'test_sofr',
      refDate: new Date('2026-10-26T00:00:00.000Z'),
      value: new Decimal('3.9'),
      status: 'ok',
      firstSeenAt: new Date('2026-10-27T13:00:00.000Z'),
    },
    {
      seriesId: 'test_revision',
      refDate: new Date('2026-10-24T00:00:00.000Z'),
      value: new Decimal('1.0'),
      status: 'ok',
      firstSeenAt: new Date('2026-10-24T22:00:00.000Z'),
    },
    {
      seriesId: 'test_revision',
      refDate: new Date('2026-10-24T00:00:00.000Z'),
      value: new Decimal('2.0'),
      status: 'ok',
      firstSeenAt: new Date('2026-10-26T12:00:00.000Z'),
    },
    {
      seriesId: 'test_revision',
      refDate: new Date('2026-10-24T00:00:00.000Z'),
      value: new Decimal('9.0'),
      status: 'ok',
      firstSeenAt: new Date('2026-10-27T02:00:00.000Z'),
    },
    {
      seriesId: 'test_nd',
      refDate: new Date('2026-10-25T00:00:00.000Z'),
      value: null,
      status: 'nd',
      firstSeenAt: new Date('2026-10-25T22:00:00.000Z'),
    },
  ];

  const inMemory = readMacroObservationsFromRows(rows, '2026-10-26', [
    'test_treasury',
    'test_sofr',
    'test_revision',
    'test_nd',
  ]);

  check(
    'reader memória: Tesouro de D entra',
    inMemory.test_treasury?.length === 1 &&
      inMemory.test_treasury[0].value.toString() === '5'
  );
  check('reader memória: SOFR de D não entra', inMemory.test_sofr?.length === 0);
  check(
    'reader memória: revisão usa maior firstSeenAt dentro do corte',
    inMemory.test_revision?.length === 1 &&
      inMemory.test_revision[0].value.toString() === '2'
  );
  check('reader memória: ND entra como ausente', inMemory.test_nd?.length === 0);

  const daily = baseDailySeries();
  const asOf = '2026-10-06';

  expectValue('spread 2s10s', macro_ust_2s10s_spread(daily, asOf), '0.5');
  expectValue('UST 10y change 5d', macro_ust_10y_change_5d(daily, asOf), '0.5');
  expectValue('UST 2y change 5d', macro_ust_2y_change_5d(daily, asOf), '0.5');
  expectValue('breakeven 10y', macro_breakeven_10y(daily, asOf), '2.5');
  expectValue('breakeven 5y', macro_breakeven_5y(daily, asOf), '2.4');
  expectValue('real yield 10y change 5d', macro_real_yield_10y_change_5d(daily, asOf), '0.5');
  expectValue('SOFR-EFFR spread', macro_sofr_effr_spread(daily, asOf), '0.1');
  expectValue('dollar broad change 5d %', macro_dollar_broad_change_5d_pct(daily, asOf), '10');
  expectValue('EUR/USD change 5d %', macro_eurusd_change_5d_pct(daily, asOf), '10');

  const cpiAsOf = '2026-10-26';
  expectValue('CPI YoY %', macro_cpi_yoy_pct(daily, cpiAsOf), '5.093125');
  expectValue('core CPI YoY %', macro_core_cpi_yoy_pct(daily, cpiAsOf), '5.905');
  expectValue('unemployment change 3m', macro_unemployment_change_3m(daily, cpiAsOf), '0.2');
  expectValue('payrolls change 1m', macro_payrolls_change_1m(daily, cpiAsOf), '29');

  const spread = macro_ust_2s10s_spread(daily, asOf);
  check(
    'evidência inclui datas, valores e idade',
    spread.evidence.latestRefDate === '2026-10-06' &&
      spread.evidence.latestAgeDays === 0 &&
      spread.evidence.references.length === 2 &&
      spread.evidence.references[0].seriesId === 'ust_nominal_10y' &&
      spread.evidence.references[0].refDate === '2026-10-06' &&
      spread.evidence.references[0].value === '4.5'
  );

  const differentDates = map({
    ...daily,
    ust_nominal_10y: consecutive(['4.0', '4.1', '4.2', '4.3', '4.4', '4.5'], '2026-10-06'),
    ust_real_10y: consecutive(['1.5', '1.6', '1.7', '1.8', '1.9', '2.0'], '2026-09-30'),
  });
  const diffResult = macro_breakeven_10y(differentDates, asOf);
  check(
    'breakeven sem refDate comum fica indisponível',
    diffResult.status === 'unavailable' && diffResult.value === null
  );

  const missingOctober = map({
    ...daily,
    bls_cpi_u_sa: monthly([
      ['2025-09', '320'],
      ['2026-09', '330'],
      ['2026-10', '335'],
    ]),
  });
  const missingOctoberResult = macro_cpi_yoy_pct(missingOctober, cpiAsOf);
  check(
    'CPI sem mesmo mês do ano anterior: insufficient_history',
    missingOctoberResult.status === 'insufficient_history' &&
      missingOctoberResult.value === null &&
      missingOctoberResult.reason?.includes('2025-10') === true
  );

  const shortSeries = map({
    ...daily,
    ust_nominal_10y: consecutive(['4.0', '4.1', '4.2', '4.3', '4.4'], '2026-10-06'),
  });
  check(
    'variação 5d sem 6 observações: insufficient_history',
    macro_ust_10y_change_5d(shortSeries, asOf).status === 'insufficient_history'
  );

  const staleDaily = map({
    ...daily,
    ust_nominal_10y: consecutive(['4.0', '4.1', '4.2', '4.3', '4.4', '4.5'], '2026-10-20'),
  });
  const staleDailyResult = macro_ust_10y_change_5d(staleDaily, '2026-10-26');
  check(
    `diária com mais de ${MACRO_STALE_DAYS_DAILY} dias fica stale`,
    staleDailyResult.status === 'stale' &&
      decimalString(staleDailyResult.value) === '0.5' &&
      staleDailyResult.evidence.latestAgeDays === 6
  );

  const fedAtLimit = map({
    ...daily,
    fed_broad_dollar: consecutive(
      ['100', '101', '102', '103', '104', '110'],
      '2026-10-16'
    ),
  });
  check(
    `Fed com exatamente ${MACRO_STALE_DAYS_FED} dias ainda é ok`,
    macro_dollar_broad_change_5d_pct(fedAtLimit, '2026-10-26').status === 'ok'
  );

  const fedStale = map({
    ...daily,
    fed_broad_dollar: consecutive(
      ['100', '101', '102', '103', '104', '110'],
      '2026-10-15'
    ),
  });
  check(
    `Fed com mais de ${MACRO_STALE_DAYS_FED} dias fica stale`,
    macro_dollar_broad_change_5d_pct(fedStale, '2026-10-26').status === 'stale'
  );

  const monthlyBoundary = map({
    ...daily,
    bls_cpi_u_sa: monthly([
      ['2025-07', '290'],
      ['2026-07', '300'],
    ]),
  });
  const at105 = macro_cpi_yoy_pct(monthlyBoundary, '2026-10-14');
  const at106 = macro_cpi_yoy_pct(monthlyBoundary, '2026-10-15');
  check(
    `mensal com ${MACRO_STALE_DAYS_MONTHLY} dias é ok`,
    at105.status === 'ok' && at105.evidence.latestAgeDays === 105
  );
  check(
    `mensal com ${MACRO_STALE_DAYS_MONTHLY + 1} dias fica stale`,
    at106.status === 'stale' &&
      at106.evidence.latestAgeDays === 106 &&
      (at106.reason?.includes(`limite ${MACRO_STALE_DAYS_MONTHLY}`) ?? false)
  );

  const monthlyAge86 = map({
    ...daily,
    bls_cpi_u_sa: monthly([
      ['2025-08', '290'],
      ['2026-08', '300'],
    ]),
    bls_core_cpi_sa: monthly([
      ['2025-08', '290'],
      ['2026-08', '300'],
    ]),
    bls_unemployment_rate: monthly([
      ['2026-05', '4.0'],
      ['2026-08', '4.2'],
    ]),
    bls_nonfarm_payrolls: monthly([
      ['2026-07', '159000'],
      ['2026-08', '159029'],
    ]),
  });
  const monthlyAge86Results = [
    macro_cpi_yoy_pct(monthlyAge86, cpiAsOf),
    macro_core_cpi_yoy_pct(monthlyAge86, cpiAsOf),
    macro_unemployment_change_3m(monthlyAge86, cpiAsOf),
    macro_payrolls_change_1m(monthlyAge86, cpiAsOf),
  ];
  check(
    'mensais com 86 dias não ficam stale em 2026-10-26',
    monthlyAge86Results.every(
      (result) => result.status === 'ok' && result.evidence.latestAgeDays === 86
    )
  );

  const reportOptions = parseMacroReportArgs(
    ['--asOf=2026-10-26', '--dry-run'],
    new Date('2026-10-27T12:00:00.000Z')
  );
  check(
    'CLI: --asOf e --dry-run',
    reportOptions.asOf === '2026-10-26' && reportOptions.dryRun
  );
  check(
    'CLI: padrão é ontem em UTC',
    parseMacroReportArgs([], new Date('2026-10-27T12:00:00.000Z')).asOf === '2026-10-26'
  );

  let invalidAsOf = false;
  try {
    parseMacroReportArgs(['--asOf=2026-02-30']);
  } catch {
    invalidAsOf = true;
  }
  check('CLI: data inválida falha', invalidAsOf);

  const outputs = computeMacroIndicators(daily, cpiAsOf);
  check(
    'catálogo: 13 indicadores e todos com evidência',
    MACRO_INDICATORS.length === 13 &&
      outputs.length === 13 &&
      outputs.every((output) => output.result.evidence !== undefined)
  );
}

function localDbUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    console.log(
      '[SKIP] defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test'
    );
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
  await prisma.macroObservation.deleteMany({ where: { source: TEST_SOURCE } });
}

async function runDbTests(url: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({
    adapter,
    log: [{ emit: 'event', level: 'query' }],
  });
  const queryLog: string[] = [];
  prisma.$on('query', (event) => {
    queryLog.push(event.query);
  });

  try {
    await cleanup(prisma);

    await prisma.macroObservation.createMany({
      data: [
        {
          seriesId: SERIES_A,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-23T00:00:00.000Z'),
          value: new Decimal('4.0'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-23T22:00:00.000Z'),
          collectedAt: new Date('2026-10-23T22:00:00.000Z'),
        },
        {
          seriesId: SERIES_A,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-24T00:00:00.000Z'),
          value: new Decimal('4.1'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-24T22:00:00.000Z'),
          collectedAt: new Date('2026-10-24T22:00:00.000Z'),
        },
        {
          seriesId: SERIES_A,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-24T00:00:00.000Z'),
          value: new Decimal('4.2'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-26T12:00:00.000Z'),
          collectedAt: new Date('2026-10-26T12:00:00.000Z'),
        },
        {
          seriesId: SERIES_A,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-24T00:00:00.000Z'),
          value: new Decimal('9.9'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-27T02:00:00.000Z'),
          collectedAt: new Date('2026-10-27T02:00:00.000Z'),
        },
        {
          seriesId: SERIES_A,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-25T00:00:00.000Z'),
          value: null,
          status: 'nd',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-25T22:00:00.000Z'),
          collectedAt: new Date('2026-10-25T22:00:00.000Z'),
        },
        {
          seriesId: SERIES_B,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-23T00:00:00.000Z'),
          value: new Decimal('3.8'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-26T13:00:00.000Z'),
          collectedAt: new Date('2026-10-26T13:00:00.000Z'),
        },
        {
          seriesId: SERIES_B,
          source: TEST_SOURCE,
          refDate: new Date('2026-10-26T00:00:00.000Z'),
          value: new Decimal('3.9'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: new Date('2026-10-27T13:00:00.000Z'),
          collectedAt: new Date('2026-10-27T13:00:00.000Z'),
        },
      ],
    });

    queryLog.length = 0;
    const series = await readMacroObservations(prisma, '2026-10-26', [
      SERIES_A,
      SERIES_B,
      SERIES_EMPTY,
    ]);
    await new Promise((resolve) => setImmediate(resolve));

    const selects = queryLog.filter(
      (query) =>
        /^SELECT/i.test(query.trim()) && query.includes('"MacroObservation"')
    ).length;

    check(
      'db reader: uma consulta por série',
      selects === 3,
      `(${selects})`
    );
    check(
      'db reader: revisão dentro do corte e ND ausente',
      series[SERIES_A]?.length === 2 &&
        series[SERIES_A][0].value.toString() === '4' &&
        series[SERIES_A][1].value.toString() === '4.2',
      `(n=${series[SERIES_A]?.length ?? 'null'})`
    );
    check(
      'db reader: SOFR de D fora do corte',
      series[SERIES_B]?.length === 1 &&
        series[SERIES_B][0].value.toString() === '3.8'
    );
    check('db reader: série sem linhas devolve lista vazia', series[SERIES_EMPTY]?.length === 0);
  } finally {
    try {
      await cleanup(prisma);
    } catch {
      console.error('[CLEANUP] falha na limpeza best-effort');
    }
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  runPureTests();

  const url = localDbUrl();
  if (url !== null) {
    try {
      await runDbTests(url);
    } catch (error) {
      check(
        'db reader executou',
        false,
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
