import type { PrismaClient } from '../generated/db/client';
import { previousUtcDay } from '../checks/freshness-rules';
import {
  readIndicatorSeries,
  type SeriesTarget,
} from '../dashboard/series-reader';
import { INDICATOR_FORMULA_VERSION } from '../state/compute-state';

const DAY_MS = 24 * 60 * 60 * 1000;
const ONCHAIN_WINDOW_DAYS = 90;
const ONCHAIN_USD_PROVIDER = 'defillama_history';
const ONCHAIN_USD_QUERY_LIMIT = 5000;
const ONCHAIN_VS_MEAN_UNIT = 'FRACTION';

const ONCHAIN_METRICS = [
  {
    id: 'tvl',
    label: 'TVL',
    usdMetric: 'tvl_usd',
    vsMeanIndicator: 'tvl_vs_mean_7d',
  },
  {
    id: 'stablecoins',
    label: 'Stablecoins',
    usdMetric: 'stablecoin_supply_usd',
    vsMeanIndicator: 'stablecoin_supply_vs_mean_7d',
  },
  {
    id: 'dex_volume',
    label: 'DEX volume',
    usdMetric: 'dex_volume_daily_usd',
    vsMeanIndicator: 'dex_volume_vs_mean_7d',
  },
] as const;

const ONCHAIN_VS_MEAN_TARGETS: readonly SeriesTarget[] = ONCHAIN_METRICS.map(
  (metric) => ({
    indicator: metric.vsMeanIndicator,
    scope: 'solana',
    formulaVersion: INDICATOR_FORMULA_VERSION,
    unit: ONCHAIN_VS_MEAN_UNIT,
  })
);

export interface OnchainPoint {
  date: string;
  value: number;
}

export interface OnchainMetric {
  id: 'tvl' | 'stablecoins' | 'dex_volume';
  label: string;
  usdUnit: string;
  usd: OnchainPoint[];
  vsMean7dUnit: string;
  vsMean7d: OnchainPoint[];
}

export interface OnchainSnapshot {
  generatedAt: string;
  asOf: string;
  windowDays: number;
  metrics: OnchainMetric[];
}

type OnchainMetricId = OnchainMetric['id'];

interface OnchainMetricInput {
  id: OnchainMetricId;
  usd: readonly OnchainPoint[];
  vsMean7d: readonly OnchainPoint[];
  vsMean7dUnit: string;
}

interface OnchainPayloadInput {
  asOf: string;
  metrics: readonly OnchainMetricInput[];
}

interface OnchainUsdRow {
  metric: string;
  value: unknown;
  collectedAt: Date;
  sourceTs: Date | null;
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

function pointsFor(points: readonly OnchainPoint[]): OnchainPoint[] {
  return points.map((point) => ({ date: point.date, value: point.value }));
}

async function readOnchainUsdSeries(
  client: Pick<PrismaClient, 'metricSnapshot'>,
  asOf: string
): Promise<Record<OnchainMetricId, OnchainPoint[]>> {
  const asOfMs = new Date(`${asOf}T00:00:00.000Z`).getTime();
  const from = new Date(asOfMs - (ONCHAIN_WINDOW_DAYS - 1) * DAY_MS);
  const toExclusive = new Date(asOfMs + DAY_MS);

  const rows: OnchainUsdRow[] = await client.metricSnapshot.findMany({
    where: {
      scope: 'solana',
      metric: { in: ONCHAIN_METRICS.map((metric) => metric.usdMetric) },
      source: { provider: ONCHAIN_USD_PROVIDER },
      sourceTs: { gte: from, lt: toExclusive },
    },
    orderBy: [{ sourceTs: 'desc' }, { collectedAt: 'desc' }],
    take: ONCHAIN_USD_QUERY_LIMIT,
    select: {
      metric: true,
      value: true,
      collectedAt: true,
      sourceTs: true,
    },
  });

  const byMetric = new Map<
    string,
    Map<string, { value: number; collectedAt: number }>
  >();

  for (const row of rows) {
    if (row.sourceTs === null) continue;
    const value = numberOrNull(row.value);
    if (value === null) continue;

    const date = isoDay(row.sourceTs.getTime());
    let byDate = byMetric.get(row.metric);
    if (byDate === undefined) {
      byDate = new Map();
      byMetric.set(row.metric, byDate);
    }

    const collectedAt = row.collectedAt.getTime();
    const current = byDate.get(date);
    if (current === undefined || collectedAt > current.collectedAt) {
      byDate.set(date, { value, collectedAt });
    }
  }

  const result: Record<OnchainMetricId, OnchainPoint[]> = {
    tvl: [],
    stablecoins: [],
    dex_volume: [],
  };

  for (const metric of ONCHAIN_METRICS) {
    const byDate = byMetric.get(metric.usdMetric);
    if (byDate === undefined) continue;
    result[metric.id] = [...byDate.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, item]) => ({ date, value: item.value }));
  }

  return result;
}

export function buildOnchainPayload(
  inputs: OnchainPayloadInput,
  generatedAt: Date
): OnchainSnapshot {
  const byId = new Map(inputs.metrics.map((metric) => [metric.id, metric]));

  return {
    generatedAt: generatedAt.toISOString(),
    asOf: inputs.asOf,
    windowDays: ONCHAIN_WINDOW_DAYS,
    metrics: ONCHAIN_METRICS.map((metric) => {
      const input = byId.get(metric.id);
      return {
        id: metric.id,
        label: metric.label,
        usdUnit: 'USD',
        usd: pointsFor(input?.usd ?? []),
        vsMean7dUnit: input?.vsMean7dUnit ?? ONCHAIN_VS_MEAN_UNIT,
        vsMean7d: pointsFor(input?.vsMean7d ?? []),
      };
    }),
  };
}

export async function buildOnchainSnapshot(
  client: PrismaClient,
  now: Date = new Date()
): Promise<OnchainSnapshot> {
  const asOf = previousUtcDay(now);
  const [usd, series] = await Promise.all([
    readOnchainUsdSeries(client, asOf),
    readIndicatorSeries(client, ONCHAIN_VS_MEAN_TARGETS, asOf),
  ]);

  const seriesByIndicator = new Map(
    series.map((item) => [item.indicator, item])
  );
  const metrics: OnchainMetricInput[] = ONCHAIN_METRICS.map((metric) => {
    const vsMean = seriesByIndicator.get(metric.vsMeanIndicator);
    return {
      id: metric.id,
      usd: usd[metric.id],
      vsMean7d: vsMean?.points ?? [],
      vsMean7dUnit: vsMean?.unit ?? ONCHAIN_VS_MEAN_UNIT,
    };
  });

  return buildOnchainPayload({ asOf, metrics }, now);
}
