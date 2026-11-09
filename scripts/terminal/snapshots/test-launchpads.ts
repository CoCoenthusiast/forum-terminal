#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  BACKFILL_DEX_METRIC_NAME,
  BACKFILL_FEES_METRIC_NAME,
  LAUNCHPAD_SLUGS,
  buildProtocolScope,
} from '../config';
import {
  LAUNCHPAD_FORMULA_VERSION,
  LAUNCHPAD_INDICATORS,
} from '../indicators/launchpads';
import { publishBlockReason } from './guards';
import { buildLaunchpadsPayload, buildLaunchpadsSnapshot } from './launchpads';
import { parseArgs } from './publish-snapshots';
import {
  MAX_PAYLOAD_BYTES,
  SNAPSHOT_KEYS,
  isSnapshotKey,
} from './writer';

const DAY_MS = 24 * 60 * 60 * 1000;
const AS_OF = '2032-06-15';
const NOW = new Date('2032-06-16T12:00:00.000Z');
const PROVIDER = 'defillama_history';
const SHARE_NOTE = 'Share among the 4 platforms covered, not market share.';

const INDICATORS = [
  'launchpad_dex_volume_change_7d',
  'launchpad_dex_volume_share_7d',
  'launchpad_dex_volume_vs_mean_7d',
  'launchpad_fees_change_7d',
  'launchpad_fees_share_7d',
  'launchpad_fees_to_volume_7d',
  'launchpad_fees_vs_mean_7d',
] as const;

const INDICATOR_UNIT = new Map(
  LAUNCHPAD_INDICATORS.map((definition) => [
    definition.indicator,
    definition.unit,
  ])
);

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

function fullPoints(): { date: string; value: number }[] {
  return Array.from({ length: 90 }, (_, index) => ({
    date: new Date(at('2032-03-18').getTime() + index * DAY_MS)
      .toISOString()
      .slice(0, 10),
    value: index + 0.5,
  }));
}

function pureTests(): void {
  check(
    'launchpads is an allowed snapshot key',
    SNAPSHOT_KEYS.includes('launchpads') && isSnapshotKey('launchpads')
  );
  const parsed = parseArgs(['--screen=launchpads', '--dry-run']);
  check(
    'CLI parses the launchpads dry-run',
    parsed.screen === 'launchpads' && parsed.dryRun
  );

  const empty = buildLaunchpadsPayload({ asOf: AS_OF, platforms: [] }, NOW);
  check(
    'launchpads guard blocks when every series is empty',
    publishBlockReason('launchpads', empty) ===
      'no launchpads series available'
  );
  check(
    'launchpads payload always carries the 4 slugs and the share note',
    empty.slugs.length === 4 &&
      empty.slugs.every((slug) => LAUNCHPAD_SLUGS.includes(slug)) &&
      empty.shareNote === SHARE_NOTE &&
      empty.platforms.length === 4
  );
  check(
    'launchpads missing series are empty with null lastDate',
    empty.platforms.every(
      (platform) =>
        platform.volume.points.length === 0 &&
        platform.volume.lastDate === null &&
        platform.fees.points.length === 0 &&
        platform.fees.lastDate === null &&
        platform.indicators.length === 7 &&
        platform.indicators.every(
          (indicator) =>
            indicator.points.length === 0 && indicator.lastDate === null
        )
    )
  );

  const points = fullPoints();
  const full = buildLaunchpadsPayload(
    {
      asOf: AS_OF,
      platforms: LAUNCHPAD_SLUGS.map((slug) => ({
        slug,
        volume: { unit: 'USD', points },
        fees: { unit: 'USD', points },
        indicators: INDICATORS.map((id) => ({
          id,
          unit: INDICATOR_UNIT.get(id) ?? 'n/a',
          points,
        })),
      })),
    },
    NOW
  );
  const bytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  check(
    'launchpads 90-day payload fits MAX_PAYLOAD_BYTES',
    bytes <= MAX_PAYLOAD_BYTES,
    `(${bytes} bytes)`
  );
  const serialized = JSON.stringify(full);
  check(
    'launchpads payload has no hourly fields or market-share claim',
    !serialized.includes('rolling_hourly_v1') &&
      !serialized.includes('dex_volume_24h_usd') &&
      serialized.split('market share').length - 1 === 1 &&
      full.shareNote === SHARE_NOTE
  );
}

interface IndicatorInsert {
  indicator: string;
  scope: string;
  asOf: Date;
  status: string;
  value: Decimal | null;
  unit: string;
  inputCount: number;
  formulaVersion: string;
}

async function dbTests(url: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  const scopes = [
    ...LAUNCHPAD_SLUGS.map((slug) => buildProtocolScope(slug)),
    buildProtocolScope('raydium-amm'),
  ];

  let sourceId = '';
  async function cleanup(): Promise<void> {
    if (sourceId !== '') {
      await prisma.metricSnapshot.deleteMany({
        where: {
          sourceId,
          collectedAt: { gte: at('2031-01-01'), lte: at('2033-01-01') },
        },
      });
    }
    await prisma.indicatorSnapshot.deleteMany({
      where: {
        scope: { in: scopes },
        formulaVersion: LAUNCHPAD_FORMULA_VERSION,
        asOf: { gte: at('2031-01-01'), lte: at('2033-01-01') },
      },
    });
  }

  try {
    const source = await prisma.dataSource.upsert({
      where: { provider: PROVIDER },
      update: {},
      create: {
        provider: PROVIDER,
        displayName: 'DefiLlama',
        baseUrl: 'https://defillama.com',
      },
    });
    sourceId = source.id;
    await cleanup();

    const pumpScope = buildProtocolScope('pump.fun');
    const pumpswapScope = buildProtocolScope('pumpswap');
    const meteoraScope = buildProtocolScope('meteora-dynamic-bonding-curve');
    const raydiumScope = buildProtocolScope('raydium-amm');

    const metricRows = [
      { scope: pumpScope, metric: BACKFILL_DEX_METRIC_NAME, value: 0, collectedAt: at('2032-06-14') },
      { scope: pumpScope, metric: BACKFILL_FEES_METRIC_NAME, value: 782669, collectedAt: at('2032-06-14') },
      { scope: pumpScope, metric: BACKFILL_DEX_METRIC_NAME, value: 1000, collectedAt: at('2032-06-15') },
      { scope: pumpScope, metric: BACKFILL_FEES_METRIC_NAME, value: 2000, collectedAt: at('2032-06-15') },
      { scope: pumpScope, metric: BACKFILL_DEX_METRIC_NAME, value: 3000, collectedAt: at('2032-06-16') },
      { scope: pumpScope, metric: BACKFILL_FEES_METRIC_NAME, value: 4000, collectedAt: at('2032-06-16') },
      { scope: pumpScope, metric: BACKFILL_DEX_METRIC_NAME, value: 5000, collectedAt: at('2032-03-17') },
      { scope: pumpScope, metric: BACKFILL_FEES_METRIC_NAME, value: 6000, collectedAt: at('2032-03-17') },
      { scope: pumpScope, metric: BACKFILL_DEX_METRIC_NAME, value: 10, collectedAt: at('2032-03-18') },
      { scope: pumpScope, metric: BACKFILL_FEES_METRIC_NAME, value: 20, collectedAt: at('2032-03-18') },
      { scope: pumpswapScope, metric: BACKFILL_FEES_METRIC_NAME, value: 500, collectedAt: at('2032-06-14') },
      { scope: meteoraScope, metric: BACKFILL_DEX_METRIC_NAME, value: 0, collectedAt: at('2032-06-15') },
      { scope: meteoraScope, metric: BACKFILL_FEES_METRIC_NAME, value: 0, collectedAt: at('2032-06-15') },
      { scope: raydiumScope, metric: BACKFILL_DEX_METRIC_NAME, value: 999999, collectedAt: at('2032-06-15') },
      { scope: raydiumScope, metric: BACKFILL_FEES_METRIC_NAME, value: 999999, collectedAt: at('2032-06-15') },
    ];

    await prisma.metricSnapshot.createMany({
      data: metricRows.map((row) => ({
        sourceId,
        scope: row.scope,
        metric: row.metric,
        value: new Decimal(String(row.value)),
        unit: 'USD',
        collectedAt: row.collectedAt,
      })),
    });

    const indicatorRows: IndicatorInsert[] = [];
    for (const [index, indicator] of INDICATORS.entries()) {
      indicatorRows.push({
        indicator,
        scope: pumpScope,
        asOf: at(index === 3 ? '2032-06-13' : index === 1 ? '2032-06-14' : '2032-06-15'),
        status: 'ok',
        value: new Decimal(String(index + 0.25)),
        unit: INDICATOR_UNIT.get(indicator) ?? 'n/a',
        inputCount: 1,
        formulaVersion: LAUNCHPAD_FORMULA_VERSION,
      });
    }
    indicatorRows.push({
      indicator: 'launchpad_fees_change_7d',
      scope: pumpScope,
      asOf: at('2032-06-16'),
      status: 'insufficient_history',
      value: null,
      unit: INDICATOR_UNIT.get('launchpad_fees_change_7d') ?? 'n/a',
      inputCount: 0,
      formulaVersion: LAUNCHPAD_FORMULA_VERSION,
    });
    indicatorRows.push({
      indicator: 'launchpad_fees_change_7d',
      scope: pumpswapScope,
      asOf: at('2032-06-15'),
      status: 'insufficient_history',
      value: null,
      unit: INDICATOR_UNIT.get('launchpad_fees_change_7d') ?? 'n/a',
      inputCount: 0,
      formulaVersion: LAUNCHPAD_FORMULA_VERSION,
    });
    indicatorRows.push({
      indicator: 'launchpad_dex_volume_change_7d',
      scope: raydiumScope,
      asOf: at('2032-06-15'),
      status: 'ok',
      value: new Decimal('9'),
      unit: INDICATOR_UNIT.get('launchpad_dex_volume_change_7d') ?? 'n/a',
      inputCount: 1,
      formulaVersion: LAUNCHPAD_FORMULA_VERSION,
    });

    await prisma.indicatorSnapshot.createMany({ data: indicatorRows });

    const snapshot = await buildLaunchpadsSnapshot(prisma as never, NOW);
    const bySlug = new Map(
      snapshot.platforms.map((platform) => [platform.slug, platform])
    );
    const pump = bySlug.get('pump.fun');
    const pumpswap = bySlug.get('pumpswap');
    const launchlab = bySlug.get('launchlab');
    const meteora = bySlug.get('meteora-dynamic-bonding-curve');

    check(
      'launchpads asOf, window and slugs are fixed',
      snapshot.asOf === AS_OF &&
        snapshot.windowDays === 90 &&
        snapshot.shareNote === SHARE_NOTE &&
        snapshot.platforms.length === 4 &&
        snapshot.slugs.length === 4 &&
        snapshot.platforms.every((platform) =>
          LAUNCHPAD_SLUGS.includes(platform.slug)
        ) &&
        !snapshot.platforms.some(
          (platform) => platform.slug === ('raydium-amm' as never)
        )
    );

    const pumpVolume14 = pump?.volume.points.find(
      (point) => point.date === '2032-06-14'
    );
    const pumpFees14 = pump?.fees.points.find(
      (point) => point.date === '2032-06-14'
    );
    check(
      'launchpads volume 0 with fees > 0 becomes null, never zero',
      pumpVolume14?.value === null &&
        pumpFees14?.value === 782669 &&
        !pump?.volume.points.some((point) => point.value === 0)
    );
    check(
      'launchpads real zero volume with zero fees stays zero',
      meteora?.volume.points[0]?.date === '2032-06-15' &&
        meteora.volume.points[0]?.value === 0 &&
        meteora.fees.points[0]?.value === 0
    );
    check(
      'launchpads never include the current day or points outside 90 days',
      !pump?.volume.points.some((point) => point.date === '2032-06-16') &&
        !pump?.fees.points.some((point) => point.date === '2032-06-16') &&
        !pump?.volume.points.some((point) => point.date === '2032-03-17') &&
        !pump?.fees.points.some((point) => point.date === '2032-03-17') &&
        pump?.volume.points[0]?.date === '2032-03-18'
    );
    check(
      'launchpads series carry their own lastDate',
      pump?.volume.lastDate === '2032-06-15' &&
        pump?.fees.lastDate === '2032-06-15' &&
        pump?.volume.source === 'DefiLlama' &&
        pump?.volume.unit === 'USD'
    );
    check(
      'launchpads absent series stay empty and null',
      pumpswap?.volume.points.length === 0 &&
        pumpswap.volume.lastDate === null &&
        pumpswap.fees.lastDate === '2032-06-14' &&
        launchlab?.volume.points.length === 0 &&
        launchlab?.fees.points.length === 0 &&
        launchlab?.indicators.every(
          (indicator) => indicator.points.length === 0
        )
    );
    check(
      'launchpads indicators use only ok v1 rows and catalog units',
      pump?.indicators.length === 7 &&
        pump.indicators.every(
          (indicator, index) => indicator.id === INDICATORS[index]
        ) &&
        pump.indicators.every(
          (indicator) => indicator.unit === INDICATOR_UNIT.get(indicator.id)
        ) &&
        pump.indicators[3]?.lastDate === '2032-06-13' &&
        pump.indicators[1]?.lastDate === '2032-06-14' &&
        pump.indicators[3]?.points.length === 1 &&
        pumpswap?.indicators.find(
          (indicator) => indicator.id === 'launchpad_fees_change_7d'
        )?.points.length === 0
    );

    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    check(
      'launchpads database payload fits MAX_PAYLOAD_BYTES',
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
