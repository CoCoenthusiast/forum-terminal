#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  MACRO_INDICATOR_FORMULA_VERSION,
  MACRO_INDICATOR_SERIES_IDS,
} from '../indicators/macro-catalog';
import {
  MAX_MACRO_DAYS,
  MACRO_SCOPE,
  buildMacroAsOfRange,
  buildMacroSnapshotRows,
  loadMacroObservationRows,
  parseComputeMacroArgs,
  writeMacroRowsInBatches,
} from '../indicators/compute-macro-indicators';
import type { MacroObservationRowInput } from '../indicators/macro-reader';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/(localhost|127\.0\.0\.1):5433/.test(url)) {
  console.error('[ABORT] TEST_DATABASE_URL ausente ou não aponta para localhost:5433');
  process.exit(1);
}

const parsed = new URL(url);
console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

const TEST_SOURCE = 'test_compute_macro_indicators';
const TEST_AS_OF_START = '2031-01-10';
const TEST_AS_OF_END = '2031-01-16';
const TEST_REF_DATE = '2031-01-10';
const TEST_COMPUTED_AT = new Date('2031-01-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function rowFor(
  seriesId: string,
  refDate: string,
  value: string,
  firstSeenAt = `${refDate}T22:00:00.000Z`
): MacroObservationRowInput {
  return {
    seriesId,
    refDate: new Date(`${refDate}T00:00:00.000Z`),
    value,
    status: 'ok',
    firstSeenAt: new Date(firstSeenAt),
  };
}

function dailyRows(
  seriesId: string,
  endDate: string,
  values: readonly string[]
): MacroObservationRowInput[] {
  const endMs = new Date(`${endDate}T00:00:00.000Z`).getTime();
  return values.map((value, index) => {
    const date = new Date(endMs - (values.length - 1 - index) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    return rowFor(seriesId, date, value);
  });
}

function findRow(
  rows: ReturnType<typeof buildMacroSnapshotRows>['rows'],
  indicator: string,
  asOf: string
) {
  return rows.find(
    (row) => row.indicator === indicator && row.asOf.toISOString().slice(0, 10) === asOf
  );
}

async function cleanup(): Promise<void> {
  const start = new Date(`${TEST_AS_OF_START}T00:00:00.000Z`);
  const end = new Date(`${TEST_AS_OF_END}T00:00:00.000Z`);
  await prisma.macroObservation.deleteMany({ where: { source: TEST_SOURCE } });
  await prisma.indicatorSnapshot.deleteMany({
    where: { scope: MACRO_SCOPE, asOf: { gte: start, lte: end } },
  });
}

async function main(): Promise<void> {
  await cleanup();

  try {
    const seedValues: Record<string, string> = {
      ust_nominal_2y: '4.1',
      ust_nominal_5y: '4.3',
      ust_nominal_10y: '4.6',
      ust_real_5y: '1.6',
      ust_real_10y: '1.8',
      sofr: '4.30',
      effr: '4.20',
      fed_broad_dollar: '120',
      ecb_eurusd: '1.10',
      bls_cpi_u_sa: '300',
      bls_core_cpi_sa: '310',
      bls_unemployment_rate: '4.1',
      bls_nonfarm_payrolls: '159000',
    };

    await prisma.macroObservation.createMany({
      data: MACRO_INDICATOR_SERIES_IDS.map((seriesId) => ({
        seriesId,
        source: TEST_SOURCE,
        refDate: new Date(`${TEST_REF_DATE}T00:00:00.000Z`),
        value: new Decimal(seedValues[seriesId]),
        status: 'ok',
        unit: 'TEST',
        firstSeenAt: new Date(`${TEST_REF_DATE}T22:00:00.000Z`),
        collectedAt: new Date(`${TEST_REF_DATE}T23:00:00.000Z`),
      })),
    });

    let findManyCalls = 0;
    const countingClient = {
      macroObservation: {
        findMany: (args: unknown) => {
          findManyCalls++;
          return prisma.macroObservation.findMany(
            args as Parameters<typeof prisma.macroObservation.findMany>[0]
          );
        },
      },
    } as unknown as Pick<PrismaClient, 'macroObservation'>;

    const loaded = await loadMacroObservationRows(
      countingClient,
      TEST_AS_OF_START,
      TEST_AS_OF_END
    );
    check(
      'uma consulta por série, não por dia',
      findManyCalls === MACRO_INDICATOR_SERIES_IDS.length &&
        loaded.queries === MACRO_INDICATOR_SERIES_IDS.length,
      `findMany=${findManyCalls} queries=${loaded.queries} dias=7`
    );
    check(
      'carga traz uma observação de cada série',
      loaded.rows.length === MACRO_INDICATOR_SERIES_IDS.length &&
        MACRO_INDICATOR_SERIES_IDS.every((seriesId) => loaded.perSeries[seriesId] === 1),
      `obs=${loaded.rows.length}`
    );

    const range = buildMacroAsOfRange(
      parseComputeMacroArgs([
        `--from=${TEST_AS_OF_START}`,
        `--to=${TEST_AS_OF_END}`,
        '--dry-run',
      ])
    );
    check('CLI: intervalo inclusivo de 7 dias', range.asOfs.length === 7);
    check(
      'CLI: limite de 370 dias',
      (() => {
        try {
          buildMacroAsOfRange({
            days: 5,
            from: '2030-01-01',
            to: '2031-01-06',
            dryRun: true,
            save: false,
          });
          return false;
        } catch {
          return true;
        }
      })(),
      `limite=${MAX_MACRO_DAYS}`
    );

    const firstBuild = buildMacroSnapshotRows(
      loaded.rows,
      range.asOfs,
      TEST_COMPUTED_AT
    );
    check(
      'calcula 7 dias x 13 indicadores',
      firstBuild.rows.length === 91,
      `linhas=${firstBuild.rows.length}`
    );
    check(
      'linhas têm scope macro:us e formulaVersion macro_v1',
      firstBuild.rows.every(
        (row) => row.scope === MACRO_SCOPE && row.formulaVersion === MACRO_INDICATOR_FORMULA_VERSION
      )
    );

    const v1Sentinel = await prisma.indicatorSnapshot.create({
      data: {
        indicator: 'macro_cpi_yoy_pct',
        scope: MACRO_SCOPE,
        asOf: new Date(`${TEST_AS_OF_START}T00:00:00.000Z`),
        status: 'ok',
        value: new Decimal('123.123'),
        unit: 'PERCENT',
        inputCount: 1,
        fromDate: new Date(`${TEST_REF_DATE}T00:00:00.000Z`),
        toDate: new Date(`${TEST_REF_DATE}T00:00:00.000Z`),
        reason: 'v1 sentinel',
        formulaVersion: 'v1',
        computedAt: TEST_COMPUTED_AT,
      },
    });

    const firstWrite = await writeMacroRowsInBatches(prisma, firstBuild.rows);
    check(
      'primeira execução grava 91 linhas',
      firstWrite.inserted === 91 && firstWrite.duplicated === 0,
      `inseridas=${firstWrite.inserted} duplicadas=${firstWrite.duplicated}`
    );

    const secondWrite = await writeMacroRowsInBatches(prisma, firstBuild.rows);
    check(
      'segunda execução grava 0 linhas novas',
      secondWrite.inserted === 0 && secondWrite.duplicated === 91,
      `inseridas=${secondWrite.inserted} duplicadas=${secondWrite.duplicated}`
    );

    const persisted = await prisma.indicatorSnapshot.findFirst({
      where: {
        indicator: 'macro_cpi_yoy_pct',
        scope: MACRO_SCOPE,
        asOf: new Date(`${TEST_AS_OF_START}T00:00:00.000Z`),
        formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
      },
    });
    check(
      'linha persistida usa scope e formulaVersion corretos',
      persisted?.scope === MACRO_SCOPE &&
        persisted.formulaVersion === MACRO_INDICATOR_FORMULA_VERSION &&
        persisted.computedAt.getTime() === TEST_COMPUTED_AT.getTime()
    );

    const sentinelAfter = await prisma.indicatorSnapshot.findUnique({
      where: { id: v1Sentinel.id },
    });
    const v1Count = await prisma.indicatorSnapshot.count({
      where: {
        scope: MACRO_SCOPE,
        asOf: new Date(`${TEST_AS_OF_START}T00:00:00.000Z`),
        formulaVersion: 'v1',
      },
    });
    check(
      'linhas v1 existentes não são tocadas',
      sentinelAfter?.formulaVersion === 'v1' &&
        sentinelAfter.reason === 'v1 sentinel' &&
        sentinelAfter.value?.toString() === '123.123' &&
        v1Count === 1
    );

    const staleRows = buildMacroSnapshotRows(
      dailyRows('ust_nominal_10y', '2026-09-25', ['4.0', '4.1', '4.2', '4.3', '4.4', '4.5']),
      ['2026-10-26'],
      TEST_COMPUTED_AT
    );
    const stale = findRow(staleRows.rows, 'macro_ust_10y_change_5d', '2026-10-26');
    check(
      'stale grava status stale e mantém o valor calculado',
      stale?.status === 'stale' && stale.value?.toString() === '0.5',
      `status=${stale?.status} value=${stale?.value?.toString()}`
    );

    const insufficientRows = buildMacroSnapshotRows([], ['2026-10-26'], TEST_COMPUTED_AT);
    check(
      'insufficient_history grava value nulo',
      insufficientRows.rows.length === 13 &&
        insufficientRows.rows.every(
          (row) => row.status === 'insufficient_history' && row.value === null
        )
    );

    const unavailableRows = buildMacroSnapshotRows(
      [
        rowFor('ust_nominal_10y', '2026-10-20', '4.5'),
        rowFor('ust_real_10y', '2026-10-21', '1.5'),
      ],
      ['2026-10-22'],
      TEST_COMPUTED_AT
    );
    const unavailable = findRow(
      unavailableRows.rows,
      'macro_breakeven_10y',
      '2026-10-22'
    );
    check(
      'série sem data comum fica indisponível com value nulo, nunca zero',
      unavailable?.status === 'unavailable' && unavailable.value === null,
      `status=${unavailable?.status} value=${unavailable?.value?.toString()}`
    );
  } finally {
    await cleanup();
    await prisma.$disconnect();
    console.log('[TEST] dados de teste apagados');
  }

  console.log(`=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}


main().catch((error) => {
  console.error(error);
  process.exit(1);
});
