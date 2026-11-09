#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import { MACRO_INDICATOR_FORMULA_VERSION } from '../indicators/macro-catalog';
import { publishBlockReason } from './guards';
import { buildMacroPayload, buildMacroSnapshot } from './macro';
import { parseArgs } from './publish-snapshots';
import {
  MAX_PAYLOAD_BYTES,
  SNAPSHOT_KEYS,
  isSnapshotKey,
} from './writer';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_SOURCE = 'test_macro_snapshot';
const AS_OF = '2032-06-15';
const NOW = new Date('2032-06-16T12:00:00.000Z');

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function at(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function pureTests(): void {
  check(
    'macro is an allowed snapshot key',
    SNAPSHOT_KEYS.includes('macro') && isSnapshotKey('macro')
  );
  const parsed = parseArgs(['--screen=macro', '--dry-run']);
  check(
    'CLI parses the macro dry-run',
    parsed.screen === 'macro' && parsed.dryRun
  );

  const empty = buildMacroPayload(
    { asOf: AS_OF, series: [], indicators: [] },
    NOW
  );
  check(
    'macro guard blocks when every series is empty',
    publishBlockReason('macro', empty) === 'no macro series available'
  );

  const dollar = buildMacroPayload(
    {
      asOf: AS_OF,
      series: [
        {
          id: 'fed_broad_dollar',
          unit: 'INDEX_1973_100',
          source: 'fed',
          points: [{ date: '2032-06-13', value: 121.5 }],
        },
        {
          id: 'ecb_eurusd',
          unit: 'USD_PER_EUR',
          source: 'ecb',
          points: [
            { date: '2032-06-14', value: 1.08 },
            { date: '2032-06-15', value: null },
          ],
        },
      ],
      indicators: [],
    },
    NOW
  );
  const fed = dollar.series.find((series) => series.id === 'fed_broad_dollar');
  const ecb = dollar.series.find((series) => series.id === 'ecb_eurusd');
  check(
    'macro guard allows a payload with at least one series',
    publishBlockReason('macro', dollar) === null
  );
  check(
    'macro keeps fed broad dollar and EUR/USD in separate series',
    fed?.unit === 'INDEX_1973_100' &&
      fed.lastDate === '2032-06-13' &&
      ecb?.unit === 'USD_PER_EUR' &&
      ecb.lastDate === '2032-06-14'
  );
  check(
    'macro missing value is null, never zero',
    ecb?.points.at(-1)?.value === null &&
      !dollar.series.some((series) =>
        series.points.some((point) => point.value === 0)
      )
  );

  const fullPoints = Array.from({ length: 90 }, (_, index) => ({
    date: new Date(at('2032-03-18').getTime() + index * DAY_MS)
      .toISOString()
      .slice(0, 10),
    value: index + 0.5,
  }));
  const full = buildMacroPayload(
    {
      asOf: AS_OF,
      series: [
        'ust_nominal_3m',
        'ust_nominal_2y',
        'ust_nominal_5y',
        'ust_nominal_10y',
        'ust_nominal_30y',
        'ust_real_5y',
        'ust_real_10y',
        'sofr',
        'effr',
        'fed_broad_dollar',
        'ecb_eurusd',
        'bls_cpi_u_sa',
        'bls_core_cpi_sa',
        'bls_unemployment_rate',
        'bls_nonfarm_payrolls',
      ].map((id) => ({
        id,
        unit: 'PERCENT',
        source: 'test',
        points: fullPoints,
      })),
      indicators: Array.from({ length: 13 }, (_, index) => ({
        id: `macro_test_${index}`,
        unit: 'PERCENT',
        points: fullPoints,
      })),
    },
    NOW
  );
  const bytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  check(
    'macro 90-day payload fits MAX_PAYLOAD_BYTES',
    bytes <= MAX_PAYLOAD_BYTES,
    `(${bytes} bytes)`
  );
}

async function dbTests(url: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  const indicatorNames = [
    'macro_cpi_yoy_pct',
    'macro_sofr_effr_spread',
    'macro_ust_2s10s_spread',
  ];

  async function cleanup(): Promise<void> {
    await prisma.macroObservation.deleteMany({ where: { source: TEST_SOURCE } });
    await prisma.indicatorSnapshot.deleteMany({
      where: {
        indicator: { in: indicatorNames },
        scope: 'macro:us',
        formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
        asOf: { gte: at('2031-01-01'), lte: at('2033-01-01') },
      },
    });
  }

  try {
    await cleanup();

    await prisma.macroObservation.createMany({
      data: [
        {
          seriesId: 'fed_broad_dollar',
          source: TEST_SOURCE,
          refDate: at('2032-06-14'),
          value: new Decimal('121.5'),
          status: 'ok',
          unit: 'INDEX_1973_100',
          firstSeenAt: at('2032-06-15'),
          collectedAt: at('2032-06-15'),
        },
        {
          seriesId: 'fed_broad_dollar',
          source: TEST_SOURCE,
          refDate: at('2032-06-15'),
          value: new Decimal('999'),
          status: 'nd',
          unit: 'INDEX_1973_100',
          firstSeenAt: at('2032-06-16'),
          collectedAt: at('2032-06-16'),
        },
        {
          seriesId: 'ecb_eurusd',
          source: TEST_SOURCE,
          refDate: at('2032-06-14'),
          value: new Decimal('1.08'),
          status: 'ok',
          unit: 'USD_PER_EUR',
          firstSeenAt: at('2032-06-15'),
          collectedAt: at('2032-06-15'),
        },
        {
          seriesId: 'ecb_eurusd',
          source: TEST_SOURCE,
          refDate: at('2032-06-15'),
          value: new Decimal('1.09'),
          status: 'ok',
          unit: 'USD_PER_EUR',
          firstSeenAt: at('2032-06-16'),
          collectedAt: at('2032-06-16'),
        },
        {
          seriesId: 'sofr',
          source: TEST_SOURCE,
          refDate: at('2032-06-15'),
          value: null,
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: at('2032-06-16'),
          collectedAt: at('2032-06-16'),
        },
        {
          seriesId: 'ust_nominal_10y',
          source: TEST_SOURCE,
          refDate: at('2032-06-15'),
          value: new Decimal('4.25'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: at('2032-06-16'),
          collectedAt: at('2032-06-16'),
        },
        {
          seriesId: 'ust_nominal_2y',
          source: TEST_SOURCE,
          refDate: at('2032-01-01'),
          value: new Decimal('99'),
          status: 'ok',
          unit: 'PERCENT',
          firstSeenAt: at('2032-01-02'),
          collectedAt: at('2032-01-02'),
        },
        ...Array.from({ length: 13 }, (_, index) => {
          const date = new Date(
            at('2031-06-01').getTime() + index * 30 * DAY_MS
          );
          return {
            seriesId: 'bls_cpi_u_sa',
            source: TEST_SOURCE,
            refDate: date,
            value: new Decimal(String(300 + index)),
            status: 'ok',
            unit: 'INDEX',
            firstSeenAt: new Date(date.getTime() + DAY_MS),
            collectedAt: new Date(date.getTime() + DAY_MS),
          };
        }),
      ],
    });

    await prisma.indicatorSnapshot.createMany({
      data: [
        {
          indicator: 'macro_cpi_yoy_pct',
          scope: 'macro:us',
          asOf: at('2032-06-15'),
          status: 'ok',
          value: new Decimal('3.1'),
          unit: 'PERCENT',
          inputCount: 1,
          formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
        },
        {
          indicator: 'macro_sofr_effr_spread',
          scope: 'macro:us',
          asOf: at('2032-06-15'),
          status: 'insufficient_history',
          value: null,
          unit: 'PERCENT',
          inputCount: 0,
          formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
        },
        {
          indicator: 'macro_ust_2s10s_spread',
          scope: 'macro:us',
          asOf: at('2032-06-14'),
          status: 'ok',
          value: new Decimal('0.5'),
          unit: 'PERCENT',
          inputCount: 2,
          formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
        },
      ],
    });

    const snapshot = await buildMacroSnapshot(prisma as never, NOW);
    const byId = new Map(snapshot.series.map((series) => [series.id, series]));
    const fed = byId.get('fed_broad_dollar');
    const ecb = byId.get('ecb_eurusd');
    const sofr = byId.get('sofr');
    const ust10 = byId.get('ust_nominal_10y');
    const ust2 = byId.get('ust_nominal_2y');
    const cpi = byId.get('bls_cpi_u_sa');
    const absent = byId.get('ust_nominal_3m');
    const cpiIndicator = snapshot.indicators.find(
      (indicator) => indicator.id === 'macro_cpi_yoy_pct'
    );
    const spreadIndicator = snapshot.indicators.find(
      (indicator) => indicator.id === 'macro_sofr_effr_spread'
    );

    check(
      'macro asOf and window are fixed',
      snapshot.asOf === AS_OF && snapshot.windowDays === 90
    );
    check(
      'macro fed broad dollar and EUR/USD stay separate with own lastDate',
      fed?.id === 'fed_broad_dollar' &&
        fed.lastDate === '2032-06-14' &&
        ecb?.id === 'ecb_eurusd' &&
        ecb.lastDate === '2032-06-15'
    );
    check(
      'macro excludes nd rows and never turns them into zero',
      !fed?.points.some((point) => point.value === 999) &&
        !snapshot.series.some((series) =>
          series.points.some((point) => point.value === 0)
        )
    );
    check(
      'macro explicit null value stays null',
      sofr?.points.length === 1 &&
        sofr.points[0]?.date === '2032-06-15' &&
        sofr.points[0]?.value === null &&
        sofr.lastDate === null
    );
    check(
      'macro absent series is empty with null lastDate',
      absent?.points.length === 0 && absent.lastDate === null
    );
    check(
      'macro daily window keeps only the last 90 days',
      ust10?.points.at(-1)?.value === 4.25 &&
        !ust2?.points.some((point) => point.value === 99)
    );
    check(
      'macro monthly BLS keeps the last 12 months',
      cpi?.points.length === 12 &&
        cpi.lastDate === cpi.points.at(-1)?.date
    );
    check(
      'macro indicators use only macro:us ok rows with own asOf',
      cpiIndicator?.points.length === 1 &&
        cpiIndicator.points[0]?.date === '2032-06-15' &&
        cpiIndicator.points[0]?.value === 3.1 &&
        cpiIndicator.unit === 'PERCENT' &&
        spreadIndicator?.points.length === 0 &&
        spreadIndicator.lastDate === null
    );
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    check(
      'macro database payload fits MAX_PAYLOAD_BYTES',
      bytes <= MAX_PAYLOAD_BYTES,
      `(${bytes} bytes)`
    );
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  pureTests();

  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/(localhost|127\.0\.0\.1):5433/.test(url)) {
    console.error(
      '[ABORT] TEST_DATABASE_URL ausente ou não aponta para localhost:5433'
    );
    process.exitCode = 1;
    return;
  }

  await dbTests(url);

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
