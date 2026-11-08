import type { PrismaClient } from '../generated/db/client';
import { previousUtcDay } from '../checks/freshness-rules';
import {
  REGIME_LABELS,
  type RecapInput,
  type RecapMetric,
} from '../recap/recap-format';
import { PRICE_ASSET_IDS, readRecapInput } from '../recap/recap-reader';
import {
  readLatestPrices,
  readOverviewDaily,
  readOverviewHourly,
  readRollingOverviewHourly,
  type DailyMetricValue,
  type HourlyMetricValue,
  type LatestPriceValue,
  type RollingHourlyValue,
} from '../dashboard/hourly-reader';

const PRICE_ORDER = ['SOL', 'BTC', 'ETH'] as const;

const OVERVIEW_ACTIVITY = [
  { label: 'TVL', scope: 'solana', metric: 'tvl_usd' },
  { label: 'Stablecoins', scope: 'solana', metric: 'stablecoin_supply_usd' },
  { label: 'DEX volume 24h', scope: 'solana', metric: 'dex_volume_24h_usd' },
  { label: 'Global market cap', scope: 'global', metric: 'global_market_cap_usd' },
  { label: 'BTC dominance', scope: 'global', metric: 'btc_dominance_pct' },
] as const;

const OVERVIEW_CLOSED_METRIC_SOURCE: Partial<
  Record<(typeof OVERVIEW_ACTIVITY)[number]['metric'], string>
> = {
  dex_volume_24h_usd: 'dex_volume_daily_usd',
};

export interface OverviewSnapshotPrice {
  asset: string;
  closed: {
    value: number | null;
    asOf: string | null;
  };
  latest: {
    value: number | null;
    collectedAt: string | null;
  };
}

export interface OverviewSnapshotMarketActivity {
  label: string;
  scope: string;
  metric: string;
  closed: {
    value: number | null;
    unit: string | null;
    asOf: string | null;
  };
  latest: {
    value: number | null;
    unit: string | null;
    collectedAt: string | null;
  };
}

export interface OverviewSnapshotRollingActivity {
  label: string;
  scope: string;
  metric: string;
  relativeDeviation: number | null;
  referenceMean: number | null;
  updatesOnceDaily: boolean | null;
  lastChangeAt: string | null;
}

export interface OverviewSnapshotRegime {
  id: string | null;
  label: string;
  reason: string | null;
  decidedBy: {
    sol_trend: string;
    sol_relative_strength: string;
  } | null;
  context: {
    spot: string;
    onchain_liquidity: string;
    launchpads: string;
  } | null;
}

export interface OverviewSnapshotOnchainLiquidity {
  classification: string | null;
  legs: {
    stablecoins: string | null;
    tvl: string | null;
    dex_volume: string | null;
  };
}

export interface OverviewSnapshotSinceLastClose {
  label: string;
  kind: 'price' | 'ratio';
  closeValue: number | null;
  closeDate: string | null;
  latestValue: number | null;
  latestDate: string | null;
  changePct: number | null;
}

export interface OverviewSnapshotDataDate {
  block: string;
  date: string | null;
}

export interface OverviewSnapshot {
  generatedAt: string;
  asOf: string;
  prices: OverviewSnapshotPrice[];
  marketActivity: OverviewSnapshotMarketActivity[];
  rollingActivity: OverviewSnapshotRollingActivity[];
  regime: OverviewSnapshotRegime;
  onchainLiquidity: OverviewSnapshotOnchainLiquidity | null;
  sinceLastClose: OverviewSnapshotSinceLastClose[];
  dataDates: OverviewSnapshotDataDate[];
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metricDate(metric: RecapMetric | null | undefined): string | null {
  const value = metric?.dataAsOf ?? metric?.asOf;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isoTimestamp(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text =
    value instanceof Date
      ? value.toISOString()
      : /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? `${value}T00:00:00.000Z`
        : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function oldestMetricDate(
  metrics: readonly (RecapMetric | null | undefined)[]
): string | null {
  const dates = metrics
    .map((metric) => metricDate(metric))
    .filter((value): value is string => value !== null)
    .sort();
  return dates.length === 0 ? null : dates[0];
}

function percentChange(
  latest: number | null,
  close: number | null
): number | null {
  if (latest === null || close === null || close === 0) return null;
  return ((latest - close) / close) * 100;
}

function ratioValue(
  first: number | null,
  second: number | null
): number | null {
  if (first === null || second === null || second === 0) return null;
  return first / second;
}

function olderDate(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) return null;
  return left.getTime() <= right.getTime() ? left : right;
}

interface SinceLastCloseDraft {
  label: string;
  kind: 'price' | 'ratio';
  closeValue: number | null;
  closeDate: string | null;
  latestValue: number | null;
  latestDate: Date | null;
  changePct: number | null;
}

function buildSinceLastClose(
  input: RecapInput,
  latestPrices: readonly LatestPriceValue[]
): OverviewSnapshotSinceLastClose[] {
  const assets: SinceLastCloseDraft[] = PRICE_ORDER.map((asset) => {
    const close = input.prices.find(
      (item) => item.asset.toUpperCase() === asset
    )?.priceUsd;
    const closeValue = finiteNumber(close?.value);
    const latest = latestPrices.find(
      (row) => row.asset === PRICE_ASSET_IDS[asset]
    );
    const latestValue = finiteNumber(latest?.priceUsd);
    return {
      label: asset,
      kind: 'price' as const,
      closeValue,
      closeDate: isoTimestamp(metricDate(close)),
      latestValue,
      latestDate: latest?.collectedAt ?? null,
      changePct: percentChange(latestValue, closeValue),
    };
  });
  const byLabel = new Map<string, (typeof assets)[number]>(
    assets.map((row) => [row.label, row])
  );
  const ratio = (first: string, second: string): SinceLastCloseDraft => {
    const left = byLabel.get(first);
    const right = byLabel.get(second);
    const closeValue = ratioValue(
      left?.closeValue ?? null,
      right?.closeValue ?? null
    );
    const latestValue = ratioValue(
      left?.latestValue ?? null,
      right?.latestValue ?? null
    );
    return {
      label: `${first}/${second}`,
      kind: 'ratio',
      closeValue,
      closeDate: isoTimestamp(input.asOf),
      latestValue,
      latestDate: olderDate(
        left?.latestDate ?? null,
        right?.latestDate ?? null
      ),
      changePct: percentChange(latestValue, closeValue),
    };
  };

  return [...assets, ratio('SOL', 'BTC'), ratio('SOL', 'ETH')].map((row) => ({
    ...row,
    latestDate: iso(row.latestDate),
  }));
}

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function buildRegime(input: RecapInput): OverviewSnapshotRegime {
  const id = input.regime?.regimeId ?? null;
  const reason = input.regime?.reason;
  return {
    id,
    label: id === null ? 'n/a' : (REGIME_LABELS[id] ?? id),
    reason:
      typeof reason === 'string' && reason.trim().length > 0 ? reason : null,
    decidedBy: input.regime?.decidedBy ?? null,
    context: input.regime?.context ?? null,
  };
}

export function buildOverviewPayload(
  input: RecapInput,
  hourly: readonly HourlyMetricValue[],
  latestPrices: readonly LatestPriceValue[],
  daily: readonly DailyMetricValue[],
  rolling: readonly RollingHourlyValue[],
  generatedAt: Date = new Date()
): OverviewSnapshot {
  const prices: OverviewSnapshotPrice[] = PRICE_ORDER.map((asset) => {
    const close = input.prices.find(
      (item) => item.asset.toUpperCase() === asset
    )?.priceUsd;
    const latest = latestPrices.find(
      (row) => row.asset === PRICE_ASSET_IDS[asset]
    );
    return {
      asset,
      closed: {
        value: finiteNumber(close?.value),
        asOf: isoTimestamp(metricDate(close)),
      },
      latest: {
        value: finiteNumber(latest?.priceUsd),
        collectedAt: iso(latest?.collectedAt ?? null),
      },
    };
  });

  const marketActivity: OverviewSnapshotMarketActivity[] = OVERVIEW_ACTIVITY.map(
    (item) => {
      const closedMetric =
        OVERVIEW_CLOSED_METRIC_SOURCE[item.metric] ?? item.metric;
      const closed = daily.find(
        (row) => row.scope === item.scope && row.metric === closedMetric
      );
      const latest = hourly.find(
        (row) => row.scope === item.scope && row.metric === item.metric
      );
      return {
        label: item.label,
        scope: item.scope,
        metric: item.metric,
        closed: {
          value: finiteNumber(closed?.value),
          unit: closed?.unit ?? null,
          asOf: iso(closed?.asOf ?? null),
        },
        latest: {
          value: finiteNumber(latest?.value),
          unit: latest?.unit ?? null,
          collectedAt: iso(latest?.collectedAt ?? null),
        },
      };
    }
  );

  const rollingRow = rolling.find(
    (row) => row.scope === 'solana' && row.metric === 'dex_volume_24h_usd'
  );
  const rollingActivity: OverviewSnapshotRollingActivity[] = [
    {
      label: 'Solana DEX volume 24h',
      scope: 'solana',
      metric: 'dex_volume_24h_usd',
      relativeDeviation: finiteNumber(rollingRow?.relativeDeviation),
      referenceMean: finiteNumber(rollingRow?.referenceMean),
      updatesOnceDaily: rollingRow?.updatesOnceDaily ?? null,
      lastChangeAt: iso(rollingRow?.lastChangeAt ?? null),
    },
  ];

  const leverageDate = oldestMetricDate([
    input.leverage.oiUsdChange7dPct,
    input.leverage.funding7dMean,
    input.leverage.liqTotalVsMean7dPct,
    input.leverage.liqLongSharePct,
  ]);
  const macroDate = oldestMetricDate([
    input.macro.dollarBroadChange5dPct,
    input.macro.realYield10yChange5d,
  ]);
  const launchpadDate = oldestMetricDate(
    input.activity.launchpads.map((item) => item.value)
  );

  return {
    generatedAt: generatedAt.toISOString(),
    asOf: isoTimestamp(input.asOf) ?? input.asOf,
    prices,
    marketActivity,
    rollingActivity,
    regime: buildRegime(input),
    onchainLiquidity: input.onchainLiquidity ?? null,
    sinceLastClose: buildSinceLastClose(input, latestPrices),
    dataDates: [
      { block: 'Leverage', date: isoTimestamp(leverageDate) },
      { block: 'Macro', date: isoTimestamp(macroDate) },
      { block: 'Launchpads', date: isoTimestamp(launchpadDate) },
    ],
  };
}

export async function buildOverviewSnapshot(
  client: PrismaClient,
  now: Date = new Date()
): Promise<OverviewSnapshot> {
  const asOf = previousUtcDay(now);
  const [input, hourly, latestPrices, daily, rolling] = await Promise.all([
    readRecapInput(client, asOf),
    readOverviewHourly(client, now),
    readLatestPrices(client, now),
    readOverviewDaily(client, asOf),
    readRollingOverviewHourly(client, now),
  ]);
  return buildOverviewPayload(
    input,
    hourly,
    latestPrices,
    daily,
    rolling,
    now
  );
}
