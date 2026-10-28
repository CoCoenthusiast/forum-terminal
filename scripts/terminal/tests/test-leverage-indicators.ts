#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  LEVERAGE_COINS,
  LEVERAGE_FORMULA_VERSION,
  LEVERAGE_INDICATORS,
  LEVERAGE_METRICS,
  LEVERAGE_SCOPES,
  computeLeverageIndicators,
} from '../indicators/leverage-catalog';
import {
  LEVERAGE_FUNDING_REQUIRED_BUCKETS,
  LEVERAGE_MIN_LAST_BUCKET_HOUR_UTC,
  aggregateLeverageHourly,
  leverageFunding7dMean,
  leverageFundingDailySum,
  leverageKnownCutoff,
  leverageOiUsdChange24hPct,
  leverageOiUsdChange7dPct,
  leverageOiUsdClose,
  leveragePremiumDailyMean,
  shiftLeverageDay,
  type LeverageObservation,
} from '../indicators/leverage-formulas';
import {
  buildLeverageAsOfRange,
  buildLeverageSnapshotRows,
  loadLeverageObservationRows,
  parseComputeLeverageArgs,
  writeLeverageRowsInBatches,
} from '../indicators/compute-leverage-indicators';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/(localhost|127\.0\.0\.1):5433/.test(url)) {
  console.error('[ABORT] TEST_DATABASE_URL ausente ou não aponta para localhost:5433');
  process.exit(1);
}

const parsed = new URL(url);
console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

const TEST_PROVIDER = 'test_compute_leverage_indicators';
const TEST_SOURCE = 'test_leverage_source';
const TEST_AS_OF_START = '2025-10-10';
const TEST_AS_OF_END = '2025-10-11';
const TEST_COMPUTED_AT = new Date('2025-10-12T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function bucketTs(day: string, hour: number): Date {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`);
}

function collectedAt(day: string, hour: number, minutes = 30): Date {
  return new Date(bucketTs(day, hour).getTime() + minutes * 60 * 1000);
}

function observation(
  metric: string,
  day: string,
  hour: number,
  value: string,
  minutes = 30
): LeverageObservation {
  return {
    metric,
    bucketTs: bucketTs(day, hour),
    collectedAt: collectedAt(day, hour, minutes),
    value,
  };
}

function rowsForMetric(
  day: string,
  metric: string,
  values: readonly string[]
): LeverageObservation[] {
  return values.map((value, hour) => observation(metric, day, hour, value));
}

function rowsForHours(
  day: string,
  hours: readonly number[],
  values: { oiCoin?: string; markPrice?: string } = {}
): LeverageObservation[] {
  return hours.flatMap((hour) => [
    observation('perp_open_interest_coin', day, hour, values.oiCoin ?? '1'),
    observation('perp_mark_price_usd', day, hour, values.markPrice ?? '100'),
  ]);
}

function rowsForDay(
  day: string,
  values: { oiCoin?: string; markPrice?: string; hours?: number } = {}
): LeverageObservation[] {
  const totalHours = values.hours ?? LEVERAGE_FUNDING_REQUIRED_BUCKETS;
  const hours = Array.from({ length: totalHours }, (_, index) => index);
  return rowsForHours(day, hours, values);
}

function findOutput(
  outputs: ReturnType<typeof computeLeverageIndicators>,
  indicator: string,
  coin: string
) {
  return outputs.find((output) => output.indicator === indicator && output.coin === coin);
}

async function ensureSource(): Promise<string> {
  const existing = await prisma.dataSource.findUnique({ where: { provider: TEST_PROVIDER } });
  if (existing) return existing.id;
  const created = await prisma.dataSource.create({
    data: {
      provider: TEST_PROVIDER,
      displayName: TEST_SOURCE,
      baseUrl: 'http://test.local',
    },
  });
  return created.id;
}

async function cleanup(): Promise<void> {
  const source = await prisma.dataSource.findUnique({ where: { provider: TEST_PROVIDER } });
  if (source) {
    await prisma.metricSnapshot.deleteMany({ where: { sourceId: source.id } });
    await prisma.dataSource.delete({ where: { id: source.id } });
  }

  const start = new Date(`${TEST_AS_OF_START}T00:00:00.000Z`);
  const end = new Date(`${TEST_AS_OF_END}T00:00:00.000Z`);
  await prisma.indicatorSnapshot.deleteMany({
    where: {
      formulaVersion: LEVERAGE_FORMULA_VERSION,
      scope: { in: LEVERAGE_SCOPES },
      asOf: { gte: start, lte: end },
    },
  });
  await prisma.indicatorSnapshot.deleteMany({
    where: {
      scope: { in: LEVERAGE_SCOPES },
      asOf: { gte: start, lte: end },
      formulaVersion: { in: ['v1', 'macro_v1'] },
      reason: { startsWith: 'leverage-test-sentinel' },
    },
  });
}

async function runPureTests(): Promise<void> {
  const day = '2026-10-26';

  const duplicateRows = rowsForDay(day);
  duplicateRows.push(observation('perp_open_interest_coin', day, 23, '2', 90));
  duplicateRows.push(observation('perp_mark_price_usd', day, 23, '200', 90));
  duplicateRows.push(observation('perp_open_interest_coin', day, 23, '3', 120));
  duplicateRows.push(observation('perp_mark_price_usd', day, 23, '300', 120));

  const duplicateResult = leverageOiUsdClose(
    aggregateLeverageHourly(duplicateRows, day),
    day
  );
  check(
    'duplicata por hora usa a última coleta e respeita o corte',
    duplicateResult.status === 'ok' &&
      duplicateResult.value?.toString() === '400' &&
      duplicateResult.inputCount === 24,
    `status=${duplicateResult.status} value=${duplicateResult.value?.toString()}`
  );
  check(
    'corte de conhecimento é D+1 01:00 UTC',
    leverageKnownCutoff(day).toISOString() === '2026-10-27T01:00:00.000Z'
  );

  const nineteen = leverageOiUsdClose(
    aggregateLeverageHourly(rowsForDay(day, { markPrice: '10', hours: 19 }), day),
    day
  );
  check(
    '19 buckets vira insufficient_history com value nulo',
    nineteen.status === 'insufficient_history' &&
      nineteen.value === null &&
      (nineteen.reason?.includes('19 buckets') ?? false),
    `status=${nineteen.status} reason=${nineteen.reason}`
  );

  const twentyFour = leverageOiUsdClose(
    aggregateLeverageHourly(rowsForDay(day, { markPrice: '10' }), day),
    day
  );
  check(
    '24 buckets vira ok',
    twentyFour.status === 'ok' &&
      twentyFour.value?.toString() === '10' &&
      twentyFour.inputCount === 24,
    `status=${twentyFour.status} value=${twentyFour.value?.toString()}`
  );

  const fundingRows = rowsForMetric(
    day,
    'perp_funding_rate_1h',
    Array.from({ length: LEVERAGE_FUNDING_REQUIRED_BUCKETS }, () => '0.0001')
  );
  const funding = leverageFundingDailySum(
    aggregateLeverageHourly(fundingRows, day),
    day
  );
  check(
    `funding diário soma os ${LEVERAGE_FUNDING_REQUIRED_BUCKETS} buckets`,
    funding.status === 'ok' && funding.value?.toString() === '0.0024',
    `status=${funding.status} value=${funding.value?.toString()}`
  );

  const change24Rows = [
    ...rowsForDay('2026-10-25', { markPrice: '100' }),
    ...rowsForDay('2026-10-26', { markPrice: '110' }),
  ];
  const change24 = leverageOiUsdChange24hPct(
    aggregateLeverageHourly(change24Rows, '2026-10-26'),
    '2026-10-26'
  );
  check(
    'variação 24h usa D contra D-1',
    change24.status === 'ok' && change24.value?.toNumber() === 10,
    `status=${change24.status} value=${change24.value?.toString()}`
  );

  const change7Rows = [
    ...rowsForDay('2026-10-20', { markPrice: '100' }),
    ...rowsForDay('2026-10-27', { markPrice: '120' }),
  ];
  const change7 = leverageOiUsdChange7dPct(
    aggregateLeverageHourly(change7Rows, '2026-10-27'),
    '2026-10-27'
  );
  check(
    'variação 7d usa D contra D-7',
    change7.status === 'ok' && change7.value?.toNumber() === 20,
    `status=${change7.status} value=${change7.value?.toString()}`
  );

  const premiumValues = Array.from({ length: 20 }, (_, index) =>
    index % 2 === 0 ? '0.001' : '0.002'
  );
  const premium = leveragePremiumDailyMean(
    aggregateLeverageHourly(
      rowsForMetric(day, 'perp_premium', premiumValues),
      day
    ),
    day
  );
  check(
    'premium diário é a média manual dos 20 buckets',
    premium.status === 'ok' && premium.value?.toString() === '0.0015',
    `status=${premium.status} value=${premium.value?.toString()}`
  );

  const sevenFundingDays = Array.from({ length: 7 }, (_, index) =>
    shiftLeverageDay('2026-10-27', -(6 - index))
  );
  const sevenFundingRows = sevenFundingDays.flatMap((fundingDay) =>
    rowsForMetric(
      fundingDay,
      'perp_funding_rate_1h',
      Array.from({ length: LEVERAGE_FUNDING_REQUIRED_BUCKETS }, () => '0.0001')
    )
  );
  const funding7d = leverageFunding7dMean(
    aggregateLeverageHourly(sevenFundingRows, '2026-10-27'),
    '2026-10-27'
  );
  check(
    'funding 7d exige os 7 dias e faz a média das somas',
    funding7d.status === 'ok' && funding7d.value?.toString() === '0.0024',
    `status=${funding7d.status} value=${funding7d.value?.toString()}`
  );

  const fullDayRows = [
    ...rowsForDay(day),
    ...rowsForMetric(
      day,
      'perp_funding_rate_1h',
      Array.from({ length: 24 }, () => '0.0001')
    ),
    ...rowsForMetric(day, 'perp_premium', Array.from({ length: 24 }, () => '0.001')),
  ];
  const fullDay = aggregateLeverageHourly(fullDayRows, day);
  check(
    'dia com 24 buckets é ok para OI, funding e premium',
    leverageOiUsdClose(fullDay, day).status === 'ok' &&
      leverageFundingDailySum(fullDay, day).status === 'ok' &&
      leveragePremiumDailyMean(fullDay, day).status === 'ok'
  );

  const hours22 = Array.from({ length: 22 }, (_, index) => index + 2);
  const partial22Rows = [
    ...rowsForHours(day, hours22),
    ...hours22.map((hour) => observation('perp_funding_rate_1h', day, hour, '0.0001')),
    ...hours22.map((hour) => observation('perp_premium', day, hour, '0.001')),
  ];
  const partial22 = aggregateLeverageHourly(partial22Rows, day);
  const partial22Funding = leverageFundingDailySum(partial22, day);
  check(
    '22 buckets com último 23:00: OI e premium ok, funding insuficiente',
    leverageOiUsdClose(partial22, day).status === 'ok' &&
      leveragePremiumDailyMean(partial22, day).status === 'ok' &&
      partial22Funding.status === 'insufficient_history' &&
      (partial22Funding.reason?.includes('22 buckets, exige 24') ?? false),
    `funding=${partial22Funding.reason}`
  );

  const hours21 = Array.from({ length: 21 }, (_, index) => index);
  const partial21 = aggregateLeverageHourly(rowsForHours(day, hours21), day);
  const partial21Close = leverageOiUsdClose(partial21, day);
  check(
    '21 buckets com último 20:00: OI insuficiente pelo fechamento',
    partial21Close.status === 'insufficient_history' &&
      partial21Close.value === null &&
      (partial21Close.reason?.includes('último bucket 20:00, mínimo 22:00') ?? false),
    `status=${partial21Close.status} reason=${partial21Close.reason}`
  );

  const now = new Date('2026-10-27T12:00:00.000Z');
  const clamped = buildLeverageAsOfRange(
    parseComputeLeverageArgs(
      ['--from=2026-10-26', '--to=2026-10-27', '--dry-run'],
      now
    ),
    now
  );
  check(
    '--to de hoje é cortado em ontem e gera aviso',
    clamped.to === '2026-10-26' &&
      clamped.asOfs.length === 1 &&
      clamped.asOfs[0] === '2026-10-26' &&
      clamped.ignored.length === 1 &&
      clamped.ignored[0] === '2026-10-27',
    `to=${clamped.to} asOfs=${clamped.asOfs.join(',')} ignored=${clamped.ignored.join(',')}`
  );
  check(
    'constantes de fechamento e funding são versionadas',
    LEVERAGE_MIN_LAST_BUCKET_HOUR_UTC === 22 &&
      LEVERAGE_FUNDING_REQUIRED_BUCKETS === 24
  );

  const empty = aggregateLeverageHourly([], day);
  const emptyClose = leverageOiUsdClose(empty, day);
  const emptyFunding = leverageFundingDailySum(empty, day);
  check(
    'ausência nunca vira zero',
    emptyClose.status === 'insufficient_history' &&
      emptyClose.value === null &&
      emptyFunding.status === 'insufficient_history' &&
      emptyFunding.value === null
  );

  const outputs = computeLeverageIndicators(
    {
      SOL: empty,
      BTC: empty,
      ETH: empty,
    },
    day
  );
  check(
    'catálogo tem 3 moedas x 6 indicadores',
    outputs.length === 18 &&
      LEVERAGE_INDICATORS.length === 18 &&
      LEVERAGE_COINS.length === 3
  );
  check(
    'todos os 18 indicadores existem para SOL, BTC e ETH',
    LEVERAGE_INDICATORS.every((definition) =>
      outputs.some(
        (output) =>
          output.indicator === definition.indicator && output.scope === definition.scope
      )
    ) &&
      findOutput(outputs, 'leverage_oi_usd_close', 'SOL')?.scope ===
        'hyperliquid:perp:SOL'
  );
}

async function runDbTests(sourceId: string): Promise<void> {
  const start = new Date(`${TEST_AS_OF_START}T00:00:00.000Z`);
  const end = new Date(`${TEST_AS_OF_END}T00:00:00.000Z`);
  const metricValues: Record<string, string> = {
    perp_open_interest_coin: '1',
    perp_mark_price_usd: '100',
    perp_funding_rate_1h: '0.0001',
    perp_premium: '0.001',
  };
  const metricUnits: Record<string, string> = {
    perp_open_interest_coin: 'COIN',
    perp_mark_price_usd: 'USD',
    perp_funding_rate_1h: 'FRACTION',
    perp_premium: 'FRACTION',
  };
  const data = LEVERAGE_SCOPES.flatMap((scope) =>
    LEVERAGE_METRICS.flatMap((metric) =>
      [0, 1].map((hour) => ({
        sourceId,
        scope,
        metric,
        value: new Decimal(metricValues[metric]),
        unit: metricUnits[metric],
        bucketTs: bucketTs(TEST_AS_OF_START, hour),
        collectedAt: collectedAt(TEST_AS_OF_START, hour),
      }))
    )
  );
  await prisma.metricSnapshot.createMany({ data });

  let findManyCalls = 0;
  const countingClient = {
    metricSnapshot: {
      findMany: (args: unknown) => {
        findManyCalls++;
        return prisma.metricSnapshot.findMany(
          args as Parameters<typeof prisma.metricSnapshot.findMany>[0]
        );
      },
    },
  } as unknown as Pick<PrismaClient, 'metricSnapshot'>;

  const loaded = await loadLeverageObservationRows(
    countingClient,
    TEST_AS_OF_START,
    TEST_AS_OF_END
  );
  const expectedQueries = LEVERAGE_SCOPES.length * LEVERAGE_METRICS.length;
  check(
    'uma consulta por scope e métrica, não por dia',
    findManyCalls === expectedQueries &&
      loaded.queries === expectedQueries &&
      loaded.observations === expectedQueries * 2,
    `findMany=${findManyCalls} queries=${loaded.queries} obs=${loaded.observations}`
  );

  const asOfs = [TEST_AS_OF_START, TEST_AS_OF_END];
  const computed = buildLeverageSnapshotRows(
    loaded.rowsByScope,
    asOfs,
    TEST_COMPUTED_AT
  );
  check(
    '2 dias x 18 indicadores = 36 linhas',
    computed.rows.length === 36,
    `linhas=${computed.rows.length}`
  );
  check(
    'linhas têm scope e formulaVersion leverage_v1',
    computed.rows.every(
      (row) =>
        LEVERAGE_SCOPES.includes(row.scope) &&
        row.formulaVersion === LEVERAGE_FORMULA_VERSION
    )
  );

  const v1Sentinel = await prisma.indicatorSnapshot.create({
    data: {
      indicator: 'leverage_oi_usd_close',
      scope: 'hyperliquid:perp:SOL',
      asOf: start,
      status: 'ok',
      value: new Decimal('111'),
      unit: 'USD',
      inputCount: 1,
      fromDate: start,
      toDate: start,
      reason: 'leverage-test-sentinel-v1',
      formulaVersion: 'v1',
      computedAt: TEST_COMPUTED_AT,
    },
  });
  const macroSentinel = await prisma.indicatorSnapshot.create({
    data: {
      indicator: 'leverage_oi_usd_close',
      scope: 'hyperliquid:perp:SOL',
      asOf: start,
      status: 'ok',
      value: new Decimal('222'),
      unit: 'USD',
      inputCount: 1,
      fromDate: start,
      toDate: start,
      reason: 'leverage-test-sentinel-macro',
      formulaVersion: 'macro_v1',
      computedAt: TEST_COMPUTED_AT,
    },
  });

  const firstWrite = await writeLeverageRowsInBatches(prisma, computed.rows);
  check(
    'primeira execução grava 36 linhas',
    firstWrite.inserted === 36 && firstWrite.duplicated === 0,
    `inseridas=${firstWrite.inserted} duplicadas=${firstWrite.duplicated}`
  );

  const secondWrite = await writeLeverageRowsInBatches(prisma, computed.rows);
  check(
    'segunda execução grava 0 linhas novas',
    secondWrite.inserted === 0 && secondWrite.duplicated === 36,
    `inseridas=${secondWrite.inserted} duplicadas=${secondWrite.duplicated}`
  );

  const persisted = await prisma.indicatorSnapshot.findFirst({
    where: {
      indicator: 'leverage_oi_usd_close',
      scope: 'hyperliquid:perp:SOL',
      asOf: start,
      formulaVersion: LEVERAGE_FORMULA_VERSION,
    },
  });
  check(
    'linha persistida usa scope e formulaVersion corretos',
    persisted?.scope === 'hyperliquid:perp:SOL' &&
      persisted.formulaVersion === LEVERAGE_FORMULA_VERSION &&
      persisted.computedAt.getTime() === TEST_COMPUTED_AT.getTime()
  );

  const sentinelIds = [v1Sentinel.id, macroSentinel.id];
  const sentinels = await prisma.indicatorSnapshot.findMany({
    where: { id: { in: sentinelIds } },
    orderBy: { formulaVersion: 'asc' },
  });
  check(
    'linhas v1 e macro_v1 existentes não são tocadas',
    sentinels.length === 2 &&
      sentinels[0].formulaVersion === 'macro_v1' &&
      sentinels[0].value?.toString() === '222' &&
      sentinels[1].formulaVersion === 'v1' &&
      sentinels[1].value?.toString() === '111'
  );

  await prisma.indicatorSnapshot.deleteMany({ where: { id: { in: sentinelIds } } });
  await prisma.indicatorSnapshot.deleteMany({
    where: {
      formulaVersion: LEVERAGE_FORMULA_VERSION,
      scope: { in: LEVERAGE_SCOPES },
      asOf: { gte: start, lte: end },
    },
  });
}

async function main(): Promise<void> {
  await cleanup();

  try {
    await runPureTests();
    const sourceId = await ensureSource();
    await runDbTests(sourceId);
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
