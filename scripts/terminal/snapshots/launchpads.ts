import type { PrismaClient } from '../generated/db/client';
import { previousUtcDay } from '../checks/freshness-rules';
import {
  readIndicatorSeries,
  type SeriesTarget,
} from '../dashboard/series-reader';
import {
  BACKFILL_DEX_METRIC_NAME,
  BACKFILL_FEES_METRIC_NAME,
  LAUNCHPAD_SLUGS,
  buildProtocolScope,
  type LaunchpadSlug,
} from '../config';
import {
  LAUNCHPAD_FORMULA_VERSION,
  LAUNCHPAD_INDICATORS,
} from '../indicators/launchpads';

const DAY_MS = 24 * 60 * 60 * 1000;
const LAUNCHPADS_WINDOW_DAYS = 90;
const LAUNCHPADS_PROVIDER = 'defillama_history';
const LAUNCHPADS_QUERY_LIMIT = 5000;
const SHARE_NOTE = 'Share among the 4 platforms covered, not market share.';

const INDICATOR_ORDER = [
  'launchpad_dex_volume_change_7d',
  'launchpad_dex_volume_share_7d',
  'launchpad_dex_volume_vs_mean_7d',
  'launchpad_fees_change_7d',
  'launchpad_fees_share_7d',
  'launchpad_fees_to_volume_7d',
  'launchpad_fees_vs_mean_7d',
] as const;

const INDICATOR_LABELS: Record<string, string> = {
  launchpad_dex_volume_change_7d: 'DEX volume change 7d',
  launchpad_dex_volume_share_7d: 'DEX volume share 7d',
  launchpad_dex_volume_vs_mean_7d: 'DEX volume vs mean 7d',
  launchpad_fees_change_7d: 'Fees change 7d',
  launchpad_fees_share_7d: 'Fees share 7d',
  launchpad_fees_to_volume_7d: 'Fees to volume 7d',
  launchpad_fees_vs_mean_7d: 'Fees vs mean 7d',
};

const INDICATOR_UNIT = new Map<string, string>();
for (const definition of LAUNCHPAD_INDICATORS) {
  INDICATOR_UNIT.set(definition.indicator, definition.unit);
}

const LAUNCHPADS_INDICATOR_TARGETS: readonly SeriesTarget[] =
  LAUNCHPAD_SLUGS.flatMap((slug) =>
    INDICATOR_ORDER.map((indicator) => ({
      indicator,
      scope: buildProtocolScope(slug),
      formulaVersion: LAUNCHPAD_FORMULA_VERSION,
    }))
  );

export interface LaunchpadPoint {
  date: string;
  value: number | null;
}

export interface LaunchpadSeries {
  id: string;
  label: string;
  unit: string;
  source: string;
  lastDate: string | null;
  points: LaunchpadPoint[];
}

export interface LaunchpadPlatform {
  slug: LaunchpadSlug;
  volume: LaunchpadSeries;
  fees: LaunchpadSeries;
  indicators: LaunchpadSeries[];
}

export interface LaunchpadsSnapshot {
  generatedAt: string;
  asOf: string;
  windowDays: number;
  slugs: LaunchpadSlug[];
  shareNote: string;
  platforms: LaunchpadPlatform[];
}

interface MetricSnapshotRow {
  scope: string;
  metric: string;
  value: unknown;
  unit: string;
  collectedAt: Date;
}

interface MetricSeriesRead {
  unit: string;
  points: LaunchpadPoint[];
}

interface LaunchpadSeriesInput {
  unit: string;
  points: readonly LaunchpadPoint[];
}

interface LaunchpadIndicatorInput {
  id: string;
  unit: string;
  points: readonly LaunchpadPoint[];
}

interface LaunchpadPlatformInput {
  slug: LaunchpadSlug;
  volume: LaunchpadSeriesInput;
  fees: LaunchpadSeriesInput;
  indicators: readonly LaunchpadIndicatorInput[];
}

interface LaunchpadsPayloadInput {
  asOf: string;
  platforms: readonly LaunchpadPlatformInput[];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    try {
      const parsed = Number(value.toString());
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function pointsFor(points: readonly LaunchpadPoint[]): LaunchpadPoint[] {
  return points.map((point) => ({ date: point.date, value: point.value }));
}

function lastDateFor(points: readonly LaunchpadPoint[]): string | null {
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point.value !== null) return point.date;
  }
  return null;
}

function metricKey(scope: string, metric: string): string {
  return `${scope}|${metric}`;
}

async function readProtocolMetrics(
  client: Pick<PrismaClient, 'metricSnapshot'>,
  asOf: string
): Promise<Map<string, MetricSeriesRead>> {
  const asOfMs = new Date(`${asOf}T00:00:00.000Z`).getTime();
  const from = new Date(asOfMs - (LAUNCHPADS_WINDOW_DAYS - 1) * DAY_MS);
  const to = new Date(asOfMs);

  const rows: MetricSnapshotRow[] = await client.metricSnapshot.findMany({
    where: {
      scope: { in: LAUNCHPAD_SLUGS.map((slug) => buildProtocolScope(slug)) },
      metric: { in: [BACKFILL_DEX_METRIC_NAME, BACKFILL_FEES_METRIC_NAME] },
      source: { provider: LAUNCHPADS_PROVIDER },
      collectedAt: { gte: from, lte: to },
    },
    orderBy: [{ collectedAt: 'asc' }],
    take: LAUNCHPADS_QUERY_LIMIT,
    select: {
      scope: true,
      metric: true,
      value: true,
      unit: true,
      collectedAt: true,
    },
  });

  const byKey = new Map<
    string,
    Map<string, { value: number | null; unit: string }>
  >();

  for (const row of rows) {
    const value = numberOrNull(row.value);
    if (value === null || value < 0) continue;

    const key = metricKey(row.scope, row.metric);
    const date = isoDay(row.collectedAt.getTime());
    let byDate = byKey.get(key);
    if (byDate === undefined) {
      byDate = new Map();
      byKey.set(key, byDate);
    }
    byDate.set(date, { value, unit: row.unit });
  }

  const result = new Map<string, MetricSeriesRead>();
  for (const [key, byDate] of byKey) {
    const ordered = [...byDate.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    const latestUnit = ordered[ordered.length - 1]?.[1]?.unit ?? 'USD';
    result.set(key, {
      unit: latestUnit,
      points: ordered.map(([date, item]) => ({
        date,
        value: item.value,
      })),
    });
  }

  return result;
}

function applyVolumeZeroRule(
  volume: readonly LaunchpadPoint[],
  fees: readonly LaunchpadPoint[]
): LaunchpadPoint[] {
  const feesByDate = new Map(
    fees.map((point) => [point.date, point.value])
  );
  return volume.map((point) => {
    const feeValue = feesByDate.get(point.date);
    if (point.value === 0 && feeValue !== null && feeValue !== undefined && feeValue > 0) {
      return { date: point.date, value: null };
    }
    return { date: point.date, value: point.value };
  });
}

function emptyMetricRead(): MetricSeriesRead {
  return { unit: 'USD', points: [] };
}

export function buildLaunchpadsPayload(
  inputs: LaunchpadsPayloadInput,
  generatedAt: Date
): LaunchpadsSnapshot {
  const platformBySlug = new Map(
    inputs.platforms.map((platform) => [platform.slug, platform])
  );

  return {
    generatedAt: generatedAt.toISOString(),
    asOf: inputs.asOf,
    windowDays: LAUNCHPADS_WINDOW_DAYS,
    slugs: [...LAUNCHPAD_SLUGS],
    shareNote: SHARE_NOTE,
    platforms: LAUNCHPAD_SLUGS.map((slug) => {
      const input = platformBySlug.get(slug);
      const volumePoints = pointsFor(input?.volume.points ?? []);
      const feesPoints = pointsFor(input?.fees.points ?? []);
      const indicatorById = new Map(
        (input?.indicators ?? []).map((indicator) => [
          indicator.id,
          indicator,
        ])
      );

      return {
        slug,
        volume: {
          id: BACKFILL_DEX_METRIC_NAME,
          label: 'DEX volume',
          unit: input?.volume.unit ?? 'USD',
          source: 'DefiLlama',
          lastDate: lastDateFor(volumePoints),
          points: volumePoints,
        },
        fees: {
          id: BACKFILL_FEES_METRIC_NAME,
          label: 'Fees',
          unit: input?.fees.unit ?? 'USD',
          source: 'DefiLlama',
          lastDate: lastDateFor(feesPoints),
          points: feesPoints,
        },
        indicators: INDICATOR_ORDER.map((indicator) => {
          const indicatorInput = indicatorById.get(indicator);
          const points = pointsFor(indicatorInput?.points ?? []);
          return {
            id: indicator,
            label: INDICATOR_LABELS[indicator] ?? indicator,
            unit:
              INDICATOR_UNIT.get(indicator) ??
              indicatorInput?.unit ??
              'n/a',
            source: 'DefiLlama',
            lastDate: lastDateFor(points),
            points,
          };
        }),
      };
    }),
  };
}

export async function buildLaunchpadsSnapshot(
  client: PrismaClient,
  now: Date = new Date()
): Promise<LaunchpadsSnapshot> {
  const asOf = previousUtcDay(now);
  const [metrics, indicatorSeries] = await Promise.all([
    readProtocolMetrics(client, asOf),
    readIndicatorSeries(client, LAUNCHPADS_INDICATOR_TARGETS, asOf),
  ]);

  const indicatorByKey = new Map(
    indicatorSeries.map((item) => [`${item.indicator}|${item.scope}`, item])
  );

  const platforms: LaunchpadPlatformInput[] = LAUNCHPAD_SLUGS.map((slug) => {
    const scope = buildProtocolScope(slug);
    const volume =
      metrics.get(metricKey(scope, BACKFILL_DEX_METRIC_NAME)) ??
      emptyMetricRead();
    const fees =
      metrics.get(metricKey(scope, BACKFILL_FEES_METRIC_NAME)) ??
      emptyMetricRead();

    return {
      slug,
      volume: {
        unit: volume.unit,
        points: applyVolumeZeroRule(volume.points, fees.points),
      },
      fees: { unit: fees.unit, points: fees.points },
      indicators: INDICATOR_ORDER.map((indicator) => {
        const read = indicatorByKey.get(`${indicator}|${scope}`);
        return {
          id: indicator,
          unit: read?.unit ?? INDICATOR_UNIT.get(indicator) ?? 'n/a',
          points: read?.points ?? [],
        };
      }),
    };
  });

  return buildLaunchpadsPayload({ asOf, platforms }, now);
}
