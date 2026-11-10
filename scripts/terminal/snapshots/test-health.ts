#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  LAUNCHPAD_SLUGS,
  STATE_VERSION,
  buildProtocolScope,
} from '../config';
import {
  evaluateFreshness,
  type FreshnessInput,
} from '../checks/freshness-rules';
import { readFreshnessInput } from '../checks/check-freshness';
import { PRICE_ASSET_IDS } from '../recap/recap-reader';
import { publishBlockReason } from './guards';
import { buildHealthPayload, buildHealthSnapshot } from './health';
import { parseArgs } from './publish-snapshots';
import {
  MAX_PAYLOAD_BYTES,
  SNAPSHOT_KEYS,
  isSnapshotKey,
} from './writer';

const AS_OF = '2032-06-15';
const NOW = new Date('2032-06-16T12:00:00.000Z');
const TEST_SOURCE = 'test_health_snapshot';
const RETURN_FORMULA_VERSION = 'v1';
const MACRO_FORMULA_VERSION = 'macro_v1';
const COINALYZE_SCOPE = 'coinalyze:SOL';
const MACRO_SCOPE = 'macro:us';

const ITEM_IDS = [
  'daily_closes',
  'returns_sol',
  'returns_btc',
  'returns_eth',
  'sol_state',
  'coinalyze_leverage',
  'broad_dollar',
  'real_yields',
  'dex_volume',
  'launchpads',
] as const;

const RETURN_LABELS = ['SOL', 'BTC', 'ETH'] as const;

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

function daysBefore(days: number): Date {
  return new Date(at(AS_OF).getTime() - days * 24 * 60 * 60 * 1000);
}

function input(overrides: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    date: AS_OF,
    now: NOW,
    prices: [],
    returns: [],
    stateAsOf: null,
    dailyCloseDate: null,
    coinalyzeAsOf: null,
    dollarToDate: null,
    realYieldToDate: null,
    dexToDate: null,
    launchpads: LAUNCHPAD_SLUGS.map((slug) => ({ slug, toDate: null })),
    lastSuccessfulCollectionAt: null,
    ...overrides,
  };
}

function returnsAt(date: Date): { item: string; asOf: Date }[] {
  return RETURN_LABELS.flatMap((label) => [
    { item: `Return 1d ${label}`, asOf: date },
    { item: `Return 7d ${label}`, asOf: date },
  ]);
}

function itemById(snapshot: ReturnType<typeof buildHealthPayload>, id: string) {
  return snapshot.items.find((item) => item.id === id);
}

function pureTests(): void {
  check(
    'health is an allowed snapshot key',
    SNAPSHOT_KEYS.includes('health') && isSnapshotKey('health')
  );
  const parsed = parseArgs(['--screen=health', '--dry-run']);
  check(
    'CLI parses the health dry-run',
    parsed.screen === 'health' && parsed.dryRun
  );

  const empty = buildHealthPayload(input(), NOW);
  check(
    'health guard blocks when every item has no lastDate',
    publishBlockReason('health', empty) === 'no health data available'
  );
  check(
    'health has exactly the expected item ids in order',
    JSON.stringify(empty.items.map((item) => item.id)) ===
      JSON.stringify(ITEM_IDS)
  );
  check(
    'health missing items keep null lastDate and delayDays',
    empty.items.every(
      (item) => item.lastDate === null && item.delayDays === null
    )
  );

  const mapped = buildHealthPayload(
    input({
      dailyCloseDate: at(AS_OF),
      returns: returnsAt(at(AS_OF)),
      stateAsOf: at(AS_OF),
      coinalyzeAsOf: daysBefore(1),
      dollarToDate: daysBefore(11),
      realYieldToDate: daysBefore(11),
      dexToDate: daysBefore(5),
      launchpads: LAUNCHPAD_SLUGS.map((slug, index) => ({
        slug,
        toDate: index < 3 ? daysBefore(index) : null,
      })),
    }),
    NOW
  );

  check(
    'health maps OK to up_to_date',
    itemById(mapped, 'daily_closes')?.status === 'up_to_date' &&
      itemById(mapped, 'returns_sol')?.status === 'up_to_date' &&
      itemById(mapped, 'sol_state')?.status === 'up_to_date' &&
      itemById(mapped, 'launchpads')?.status === 'up_to_date'
  );
  check(
    'health maps WARN to delayed',
    itemById(mapped, 'coinalyze_leverage')?.status === 'delayed' &&
      itemById(mapped, 'broad_dollar')?.status === 'delayed' &&
      itemById(mapped, 'dex_volume')?.status === 'delayed'
  );
  check(
    'health maps FAIL to stale',
    itemById(mapped, 'real_yields')?.status === 'stale'
  );
  check(
    'health keeps lastDate and delayDays per item',
    itemById(mapped, 'daily_closes')?.lastDate === AS_OF &&
      itemById(mapped, 'daily_closes')?.delayDays === 0 &&
      itemById(mapped, 'coinalyze_leverage')?.lastDate === '2032-06-14' &&
      itemById(mapped, 'coinalyze_leverage')?.delayDays === 1 &&
      itemById(mapped, 'broad_dollar')?.lastDate === '2032-06-04' &&
      itemById(mapped, 'broad_dollar')?.delayDays === 11 &&
      itemById(mapped, 'real_yields')?.lastDate === '2032-06-04' &&
      itemById(mapped, 'real_yields')?.delayDays === 11 &&
      itemById(mapped, 'dex_volume')?.lastDate === '2032-06-10' &&
      itemById(mapped, 'dex_volume')?.delayDays === 5
  );
  check(
    'health launchpads use the oldest date and the 3-of-4 rule',
    itemById(mapped, 'launchpads')?.lastDate === '2032-06-13' &&
      itemById(mapped, 'launchpads')?.delayDays === 2 &&
      itemById(mapped, 'launchpads')?.present === 3 &&
      itemById(mapped, 'launchpads')?.total === 4 &&
      itemById(mapped, 'launchpads')?.status === 'up_to_date'
  );

  const partial = buildHealthPayload(
    input({
      dailyCloseDate: at(AS_OF),
      launchpads: LAUNCHPAD_SLUGS.map((slug, index) => ({
        slug,
        toDate: index < 2 ? at(AS_OF) : null,
      })),
    }),
    NOW
  );
  check(
    'health launchpads below LAUNCHPAD_MIN_PRESENT are delayed',
    itemById(partial, 'launchpads')?.present === 2 &&
      itemById(partial, 'launchpads')?.total === 4 &&
      itemById(partial, 'launchpads')?.status === 'delayed'
  );

  const serialized = JSON.stringify(mapped);
  check(
    'health payload has no hourly, collection or internal fields',
    !serialized.includes('collectedAt') &&
      !serialized.includes('collectionStatus') &&
      !serialized.includes('CollectionLog') &&
      !serialized.includes('Hourly') &&
      !serialized.includes('hourly') &&
      !serialized.includes('detalhe') &&
      !serialized.includes('horário')
  );
  const bytes = Buffer.byteLength(serialized, 'utf8');
  check(
    'health payload fits MAX_PAYLOAD_BYTES',
    bytes <= MAX_PAYLOAD_BYTES,
    `(${bytes} bytes)`
  );
}

interface IndicatorRow {
  indicator: string;
  scope: string;
  asOf: Date;
  status: string;
  value: Decimal | null;
  unit: string;
  inputCount: number;
  fromDate: Date | null;
  toDate: Date | null;
  formulaVersion: string;
}

async function dbTests(url: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  let sourceId = '';
  async function cleanup(): Promise<void> {
    await prisma.dailyClose.deleteMany({
      where: {
        asset: 'solana',
        date: { gte: at('2031-01-01'), lte: at('2033-01-01') },
      },
    });
    await prisma.marketSnapshot.deleteMany({
      where: {
        asset: 'solana',
        collectedAt: { gte: at('2031-01-01'), lte: at('2033-01-01') },
      },
    });
    await prisma.indicatorSnapshot.deleteMany({
      where: {
        asOf: { gte: at('2031-01-01'), lte: at('2033-01-01') },
        formulaVersion: { in: [RETURN_FORMULA_VERSION, MACRO_FORMULA_VERSION] },
      },
    });
    await prisma.marketState.deleteMany({
      where: {
        asOf: { gte: at('2031-01-01'), lte: at('2033-01-01') },
      },
    });
    await prisma.dataSource.deleteMany({ where: { provider: TEST_SOURCE } });
  }

  try {
    await cleanup();

    const source = await prisma.dataSource.create({
      data: {
        provider: TEST_SOURCE,
        displayName: 'Test health source',
        baseUrl: 'https://example.invalid',
      },
    });
    sourceId = source.id;

    const snapshot = await prisma.marketSnapshot.create({
      data: {
        sourceId,
        asset: 'solana',
        priceUsd: new Decimal('100'),
        sourceTs: at(AS_OF),
        collectedAt: at(AS_OF),
      },
    });

    await prisma.dailyClose.create({
      data: {
        asset: 'solana',
        date: at(AS_OF),
        closeUsd: new Decimal('100'),
        sourceSnapshotId: snapshot.id,
        calcMethod: 'test',
        calcVersion: 1,
      },
    });

    const indicatorRows: IndicatorRow[] = [];
    for (const asset of Object.values(PRICE_ASSET_IDS)) {
      for (const indicator of ['return_1d', 'return_7d']) {
        indicatorRows.push({
          indicator,
          scope: asset,
          asOf: at(AS_OF),
          status: 'ok',
          value: new Decimal('0.1'),
          unit: 'FRACTION',
          inputCount: 1,
          fromDate: daysBefore(7),
          toDate: at(AS_OF),
          formulaVersion: RETURN_FORMULA_VERSION,
        });
      }
    }

    indicatorRows.push({
      indicator: 'oi_usd_change_7d_pct',
      scope: COINALYZE_SCOPE,
      asOf: daysBefore(1),
      status: 'ok',
      value: new Decimal('0.1'),
      unit: 'FRACTION',
      inputCount: 1,
      fromDate: daysBefore(7),
      toDate: daysBefore(1),
      formulaVersion: RETURN_FORMULA_VERSION,
    });
    indicatorRows.push({
      indicator: 'macro_dollar_broad_change_5d_pct',
      scope: MACRO_SCOPE,
      asOf: at(AS_OF),
      status: 'ok',
      value: new Decimal('0.1'),
      unit: 'PERCENT',
      inputCount: 1,
      fromDate: daysBefore(11),
      toDate: daysBefore(11),
      formulaVersion: MACRO_FORMULA_VERSION,
    });
    indicatorRows.push({
      indicator: 'macro_real_yield_10y_change_5d',
      scope: MACRO_SCOPE,
      asOf: at(AS_OF),
      status: 'ok',
      value: new Decimal('0.1'),
      unit: 'PERCENT',
      inputCount: 1,
      fromDate: daysBefore(11),
      toDate: daysBefore(11),
      formulaVersion: MACRO_FORMULA_VERSION,
    });
    indicatorRows.push({
      indicator: 'dex_volume_vs_mean_7d',
      scope: 'solana',
      asOf: at(AS_OF),
      status: 'ok',
      value: new Decimal('0.1'),
      unit: 'FRACTION',
      inputCount: 1,
      fromDate: daysBefore(5),
      toDate: daysBefore(5),
      formulaVersion: RETURN_FORMULA_VERSION,
    });
    for (const [index, slug] of LAUNCHPAD_SLUGS.entries()) {
      if (index === 3) continue;
      indicatorRows.push({
        indicator: 'launchpad_dex_volume_vs_mean_7d',
        scope: buildProtocolScope(slug),
        asOf: at(AS_OF),
        status: 'ok',
        value: new Decimal('0.1'),
        unit: 'FRACTION',
        inputCount: 1,
        fromDate: daysBefore(2),
        toDate: index === 0 ? daysBefore(2) : daysBefore(index),
        formulaVersion: RETURN_FORMULA_VERSION,
      });
    }

    await prisma.indicatorSnapshot.createMany({ data: indicatorRows });

    await prisma.marketState.create({
      data: {
        asOf: at(AS_OF),
        stateVersion: STATE_VERSION,
        rulesVersion: 'test',
        computeMode: 'test',
        dataQualityScore: new Decimal('1'),
        oldestDataDate: at(AS_OF),
        payload: {},
      },
    });

    const health = await buildHealthSnapshot(prisma as never, NOW);
    const byId = new Map(health.items.map((item) => [item.id, item]));

    check(
      'health database asOf and item order are fixed',
      health.asOf === AS_OF &&
        JSON.stringify(health.items.map((item) => item.id)) ===
          JSON.stringify(ITEM_IDS)
    );
    check(
      'health database daily closes and returns are up_to_date',
      byId.get('daily_closes')?.lastDate === AS_OF &&
        byId.get('daily_closes')?.delayDays === 0 &&
        byId.get('daily_closes')?.status === 'up_to_date' &&
        byId.get('returns_sol')?.lastDate === AS_OF &&
        byId.get('returns_btc')?.lastDate === AS_OF &&
        byId.get('returns_eth')?.lastDate === AS_OF &&
        byId.get('returns_sol')?.status === 'up_to_date' &&
        byId.get('returns_btc')?.status === 'up_to_date' &&
        byId.get('returns_eth')?.status === 'up_to_date'
    );
    check(
      'health database state, coinalyze and macro statuses match',
      byId.get('sol_state')?.lastDate === AS_OF &&
        byId.get('sol_state')?.status === 'up_to_date' &&
        byId.get('coinalyze_leverage')?.lastDate === '2032-06-14' &&
        byId.get('coinalyze_leverage')?.delayDays === 1 &&
        byId.get('coinalyze_leverage')?.status === 'delayed' &&
        byId.get('broad_dollar')?.lastDate === '2032-06-04' &&
        byId.get('broad_dollar')?.delayDays === 11 &&
        byId.get('broad_dollar')?.status === 'delayed' &&
        byId.get('real_yields')?.lastDate === '2032-06-04' &&
        byId.get('real_yields')?.delayDays === 11 &&
        byId.get('real_yields')?.status === 'stale'
    );
    check(
      'health database DEX and launchpads use toDate',
      byId.get('dex_volume')?.lastDate === '2032-06-10' &&
        byId.get('dex_volume')?.delayDays === 5 &&
        byId.get('dex_volume')?.status === 'delayed' &&
        byId.get('launchpads')?.lastDate === '2032-06-13' &&
        byId.get('launchpads')?.delayDays === 2 &&
        byId.get('launchpads')?.present === 3 &&
        byId.get('launchpads')?.total === 4 &&
        byId.get('launchpads')?.status === 'up_to_date'
    );

    const raw = await readFreshnessInput(prisma as never, AS_OF, NOW);
    const fresh = evaluateFreshness(raw);
    const statusById = new Map(fresh.map((result) => [result.item, result.status]));
    const map: Record<string, string> = {
      daily_closes: 'Daily close SOL',
      sol_state: 'State',
      coinalyze_leverage: 'Coinalyze',
      broad_dollar: 'Broad dollar',
      real_yields: 'Real yield 10y',
      dex_volume: 'DEX volume',
    };
    check(
      'health statuses match evaluateFreshness for the same data',
      Object.entries(map).every(([id, item]) => {
        const expected = statusById.get(item);
        const mappedStatus =
          expected === 'OK'
            ? 'up_to_date'
            : expected === 'WARN'
              ? 'delayed'
              : expected === 'FAIL'
                ? 'stale'
                : null;
        return byId.get(id)?.status === mappedStatus;
      })
    );

    const serialized = JSON.stringify(health);
    const bytes = Buffer.byteLength(serialized, 'utf8');
    check(
      'health database payload fits MAX_PAYLOAD_BYTES',
      bytes <= MAX_PAYLOAD_BYTES,
      `(${bytes} bytes)`
    );
    check(
      'health database payload has no hourly or collection fields',
      !serialized.includes('collectedAt') &&
        !serialized.includes('collectionStatus') &&
        !serialized.includes('Hourly')
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
