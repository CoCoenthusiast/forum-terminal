import type { PrismaClient } from '../generated/db/client';
import { computeRollingHourly } from '../indicators/rolling-hourly';

const HOUR_MS = 60 * 60 * 1000;

export const HOURLY_WINDOW_HOURS = 6;
export const HOURLY_STALE_HOURS = 3;
const HOURLY_QUERY_LIMIT = 500;
const LATEST_PRICE_QUERY_LIMIT = 500;
const DAILY_QUERY_LIMIT = 500;
const OVERVIEW_CLOSED_QUERY_LIMIT = 100;
const OVERVIEW_CLOSED_LOOKBACK_DAYS = 15;
const COINALYZE_HOURLY_QUERY_LIMIT = 500;
const ROLLING_QUERY_LIMIT = 10000;
const ROLLING_LOOKBACK_MS = 8 * 24 * HOUR_MS;

type HourlyClient = Pick<PrismaClient, 'metricSnapshot'>;
type LatestPriceClient = Pick<PrismaClient, 'marketSnapshot'>;
type DailyClient = Pick<PrismaClient, 'indicatorSnapshot'>;
type OverviewDailyClient = Pick<PrismaClient, 'metricSnapshot'>;

export const LATEST_PRICE_ASSETS = ['solana', 'bitcoin', 'ethereum'];
const LATEST_PRICE_PROVIDER = 'coingecko';

export interface LatestPriceValue {
  asset: string;
  priceUsd: number | null;
  collectedAt: Date | null;
  ageMs: number | null;
  stale: boolean;
}

export interface DailyMetricValue {
  scope: string;
  metric: string;
  value: number | null;
  unit: string | null;
  asOf: Date | null;
}

export interface HourlyMetricValue {
  scope: string;
  metric: string;
  value: number | null;
  unit: string | null;
  collectedAt: Date | null;
  ageMs: number | null;
  stale: boolean;
}

export interface CoinalyzeHourlyValue {
  scope: string;
  metric: string;
  value: number | null;
  unit: string | null;
  sourceTs: Date | null;
  stale: boolean;
}

export interface RollingHourlyValue {
  scope: string;
  metric: string;
  current: number | null;
  currentAt: Date | null;
  referenceMean: number | null;
  relativeDeviation: number | null;
  referencePoints: number;
  updatesOnceDaily: boolean | null;
  lastChangeAt: Date | null;
}

const OVERVIEW_SOLANA_INDICATORS = [
  'tvl_usd',
  'stablecoin_supply_usd',
  'dex_volume_24h_usd',
];

const OVERVIEW_GLOBAL_INDICATORS = ['global_market_cap_usd', 'btc_dominance_pct'];

const OVERVIEW_CLOSED_PROVIDER = 'defillama_history';
const OVERVIEW_CLOSED_METRICS = [
  'tvl_usd',
  'stablecoin_supply_usd',
  'dex_volume_daily_usd',
] as const;

export const COINALYZE_HOURLY_WINDOW_HOURS = 8;
export const COINALYZE_LEVERAGE_COINS = ['SOL', 'BTC', 'ETH'] as const;
export const COINALYZE_LEVERAGE_METRICS = [
  'oi_usd_close_1h',
  'funding_rate_close_pct_1h',
  'long_short_ratio_1h',
  'long_account_pct_1h',
  'liq_long_usd_1h',
  'liq_short_usd_1h',
] as const;

export const HYPERLIQUID_COINS = ['SOL', 'BTC', 'ETH'];
export const HYPERLIQUID_INDICATORS = [
  'perp_funding_rate_1h',
  'perp_open_interest_coin',
  'perp_premium',
  'perp_mark_price_usd',
];

export const HOURLY_LAUNCHPAD_SLUGS = [
  'pump.fun',
  'pumpswap',
  'launchlab',
  'meteora-dynamic-bonding-curve',
  'raydium-amm',
  'meteora-dlmm',
  'meteora-damm-v1',
  'meteora-damm-v2',
];

export const HOURLY_LAUNCHPAD_INDICATORS = ['dex_volume_24h_usd', 'fees_24h_usd'];

interface MarketSnapshotRow {
  asset: string;
  priceUsd: unknown;
  collectedAt: Date;
  source: { provider: string } | null;
}

interface IndicatorSnapshotRow {
  scope: string;
  indicator: string;
  value: unknown;
  unit: string | null;
  asOf: Date;
}

interface MetricSnapshotRow {
  scope: string;
  metric: string;
  value: unknown;
  unit: string | null;
  collectedAt: Date;
}

interface OverviewDailyMetricRow {
  scope: string;
  metric: string;
  value: unknown;
  unit: string | null;
  sourceTs: Date | null;
}

interface CoinalyzeMetricSnapshotRow {
  scope: string;
  metric: string;
  value: unknown;
  unit: string | null;
  sourceTs: Date | null;
  collectedAt: Date;
}

interface RollingMetricSnapshotRow {
  scope: string;
  metric: string;
  value: unknown;
  collectedAt: Date;
  sourceTs: Date | null;
}

function toNumber(value: unknown): number | null {
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

function metricKey(scope: string, metric: string): string {
  return `${scope}\u0000${metric}`;
}

function ageMsAt(now: Date, collectedAt: Date | null): number | null {
  return collectedAt === null
    ? null
    : Math.max(0, now.getTime() - collectedAt.getTime());
}

function isStale(ageMs: number | null): boolean {
  return ageMs !== null && ageMs > HOURLY_STALE_HOURS * HOUR_MS;
}

async function latestMetrics(
  client: HourlyClient,
  scopes: readonly string[],
  indicators: readonly string[],
  now: Date
): Promise<Map<string, MetricSnapshotRow>> {
  const since = new Date(now.getTime() - HOURLY_WINDOW_HOURS * HOUR_MS);
  const rows = await client.metricSnapshot.findMany({
    where: {
      scope: { in: [...scopes] },
      metric: { in: [...indicators] },
      collectedAt: { gte: since, lte: now },
    },
    orderBy: { collectedAt: 'desc' },
    take: HOURLY_QUERY_LIMIT,
    select: {
      scope: true,
      metric: true,
      value: true,
      unit: true,
      collectedAt: true,
    },
  });

  const latest = new Map<string, MetricSnapshotRow>();
  for (const row of rows) {
    const key = metricKey(row.scope, row.metric);
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

function buildValue(
  scope: string,
  metric: string,
  row: MetricSnapshotRow | undefined,
  now: Date
): HourlyMetricValue {
  const collectedAt = row?.collectedAt ?? null;
  const ageMs = ageMsAt(now, collectedAt);
  return {
    scope,
    metric,
    value: row === undefined ? null : toNumber(row.value),
    unit: row?.unit ?? null,
    collectedAt,
    ageMs,
    stale: isStale(ageMs),
  };
}

function valuesFor(
  latest: Map<string, MetricSnapshotRow>,
  scopes: readonly string[],
  indicators: readonly string[],
  now: Date
): HourlyMetricValue[] {
  const values: HourlyMetricValue[] = [];
  for (const scope of scopes) {
    for (const metric of indicators) {
      values.push(
        buildValue(scope, metric, latest.get(metricKey(scope, metric)), now)
      );
    }
  }
  return values;
}

export async function readOverviewHourly(
  client: HourlyClient,
  now: Date = new Date()
): Promise<HourlyMetricValue[]> {
  const scopes = ['solana', 'global'];
  const indicators = [...OVERVIEW_SOLANA_INDICATORS, ...OVERVIEW_GLOBAL_INDICATORS];
  const latest = await latestMetrics(client, scopes, indicators, now);

  return [
    ...valuesFor(latest, ['solana'], OVERVIEW_SOLANA_INDICATORS, now),
    ...valuesFor(latest, ['global'], OVERVIEW_GLOBAL_INDICATORS, now),
  ];
}

export async function readHyperliquidHourly(
  client: HourlyClient,
  now: Date = new Date()
): Promise<HourlyMetricValue[]> {
  const scopes = HYPERLIQUID_COINS.map((coin) => `hyperliquid:perp:${coin}`);
  const latest = await latestMetrics(client, scopes, HYPERLIQUID_INDICATORS, now);
  return valuesFor(latest, scopes, HYPERLIQUID_INDICATORS, now);
}

export async function readLaunchpadHourly(
  client: HourlyClient,
  now: Date = new Date()
): Promise<HourlyMetricValue[]> {
  const scopes = HOURLY_LAUNCHPAD_SLUGS.map((slug) => `solana:protocol:${slug}`);
  const latest = await latestMetrics(
    client,
    scopes,
    HOURLY_LAUNCHPAD_INDICATORS,
    now
  );
  return valuesFor(latest, scopes, HOURLY_LAUNCHPAD_INDICATORS, now);
}

async function latestCoinalyzeMetrics(
  client: HourlyClient,
  now: Date
): Promise<Map<string, CoinalyzeMetricSnapshotRow>> {
  const since = new Date(now.getTime() - COINALYZE_HOURLY_WINDOW_HOURS * HOUR_MS);
  const closedBefore = new Date(now.getTime() - HOUR_MS);
  const rows = await client.metricSnapshot.findMany({
    where: {
      scope: { startsWith: 'coinalyze:' },
      metric: { endsWith: '_1h' },
      sourceTs: { gte: since, lte: closedBefore },
    },
    orderBy: [{ sourceTs: 'desc' }, { collectedAt: 'desc' }],
    take: COINALYZE_HOURLY_QUERY_LIMIT,
    select: {
      scope: true,
      metric: true,
      value: true,
      unit: true,
      sourceTs: true,
      collectedAt: true,
    },
  });

  const latest = new Map<string, CoinalyzeMetricSnapshotRow>();
  for (const row of rows) {
    if (row.sourceTs === null) continue;
    const key = metricKey(row.scope, row.metric);
    const current = latest.get(key);
    if (
      current === undefined ||
      current.sourceTs === null ||
      row.sourceTs.getTime() > current.sourceTs.getTime() ||
      (row.sourceTs.getTime() === current.sourceTs.getTime() &&
        row.collectedAt.getTime() > current.collectedAt.getTime())
    ) {
      latest.set(key, row);
    }
  }
  return latest;
}

function coinalyzeCandleIsStale(now: Date, sourceTs: Date | null): boolean {
  if (sourceTs === null) return false;
  const candleEnd = sourceTs.getTime() + HOUR_MS;
  return now.getTime() - candleEnd > HOURLY_STALE_HOURS * HOUR_MS;
}

function buildCoinalyzeValue(
  scope: string,
  metric: string,
  row: CoinalyzeMetricSnapshotRow | undefined,
  now: Date
): CoinalyzeHourlyValue {
  const sourceTs = row?.sourceTs ?? null;
  return {
    scope,
    metric,
    value: row === undefined ? null : toNumber(row.value),
    unit: row?.unit ?? null,
    sourceTs,
    stale: coinalyzeCandleIsStale(now, sourceTs),
  };
}

export async function readCoinalyzeLeverageHourly(
  client: HourlyClient,
  now: Date = new Date()
): Promise<CoinalyzeHourlyValue[]> {
  const scopes = COINALYZE_LEVERAGE_COINS.map((coin) => `coinalyze:${coin}`);
  const latest = await latestCoinalyzeMetrics(client, now);
  return scopes.flatMap((scope) =>
    COINALYZE_LEVERAGE_METRICS.map((metric) =>
      buildCoinalyzeValue(scope, metric, latest.get(metricKey(scope, metric)), now)
    )
  );
}

async function rollingMetrics(
  client: HourlyClient,
  scopes: readonly string[],
  metrics: readonly string[],
  now: Date
): Promise<Map<string, RollingMetricSnapshotRow[]>> {
  const since = new Date(now.getTime() - ROLLING_LOOKBACK_MS);
  const rows = await client.metricSnapshot.findMany({
    where: {
      scope: { in: [...scopes] },
      metric: { in: [...metrics] },
      collectedAt: { gte: since, lte: now },
    },
    orderBy: { collectedAt: 'desc' },
    take: ROLLING_QUERY_LIMIT,
    select: {
      scope: true,
      metric: true,
      value: true,
      collectedAt: true,
      sourceTs: true,
    },
  });

  const grouped = new Map<string, RollingMetricSnapshotRow[]>();
  for (const row of rows) {
    const key = metricKey(row.scope, row.metric);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [row]);
    else group.push(row);
  }
  return grouped;
}

function buildRollingValue(
  scope: string,
  metric: string,
  rows: readonly RollingMetricSnapshotRow[],
  now: Date
): RollingHourlyValue {
  const result = computeRollingHourly(
    rows.map((row) => ({
      sourceTs: row.sourceTs,
      collectedAt: row.collectedAt,
      value: toNumber(row.value),
    })),
    now
  );
  return {
    scope,
    metric,
    current: result.current,
    currentAt: result.currentAt,
    referenceMean: result.referenceMean,
    relativeDeviation: result.relativeDeviation,
    referencePoints: result.referencePoints,
    updatesOnceDaily: result.cadence.updatesOnceDaily,
    lastChangeAt: result.cadence.lastChangeAt,
  };
}

export async function readRollingOverviewHourly(
  client: HourlyClient,
  now: Date = new Date()
): Promise<RollingHourlyValue[]> {
  const scopes = ['solana'];
  const metrics = ['dex_volume_24h_usd'];
  const grouped = await rollingMetrics(client, scopes, metrics, now);
  return scopes.flatMap((scope) =>
    metrics.map((metric) =>
      buildRollingValue(scope, metric, grouped.get(metricKey(scope, metric)) ?? [], now)
    )
  );
}

export async function readRollingLaunchpadHourly(
  client: HourlyClient,
  now: Date = new Date()
): Promise<RollingHourlyValue[]> {
  const scopes = HOURLY_LAUNCHPAD_SLUGS.map((slug) => `solana:protocol:${slug}`);
  const grouped = await rollingMetrics(
    client,
    scopes,
    HOURLY_LAUNCHPAD_INDICATORS,
    now
  );
  return scopes.flatMap((scope) =>
    HOURLY_LAUNCHPAD_INDICATORS.map((metric) =>
      buildRollingValue(scope, metric, grouped.get(metricKey(scope, metric)) ?? [], now)
    )
  );
}

export async function readLatestPrices(
  client: LatestPriceClient,
  now: Date = new Date()
): Promise<LatestPriceValue[]> {
  const since = new Date(now.getTime() - HOURLY_WINDOW_HOURS * HOUR_MS);
  const rows = await client.marketSnapshot.findMany({
    where: {
      asset: { in: [...LATEST_PRICE_ASSETS] },
      collectedAt: { gte: since, lte: now },
      source: { provider: LATEST_PRICE_PROVIDER },
    },
    orderBy: { collectedAt: 'desc' },
    take: LATEST_PRICE_QUERY_LIMIT,
    select: {
      asset: true,
      priceUsd: true,
      collectedAt: true,
      source: { select: { provider: true } },
    },
  });

  const latest = new Map<string, MarketSnapshotRow>();
  for (const row of rows) {
    if (row.source?.provider !== LATEST_PRICE_PROVIDER) continue;
    if (!latest.has(row.asset)) latest.set(row.asset, row);
  }

  return LATEST_PRICE_ASSETS.map((asset) => {
    const row = latest.get(asset);
    const collectedAt = row?.collectedAt ?? null;
    const ageMs = ageMsAt(now, collectedAt);
    return {
      asset,
      priceUsd: row === undefined ? null : toNumber(row.priceUsd),
      collectedAt,
      ageMs,
      stale: isStale(ageMs),
    };
  });
}

function closedDay(asOf: string): Date | null {
  const date = new Date(`${asOf}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function latestDailyMetrics(
  client: DailyClient,
  scopes: readonly string[],
  indicators: readonly string[],
  asOf: string
): Promise<Map<string, IndicatorSnapshotRow>> {
  const date = closedDay(asOf);
  if (date === null) return new Map();

  const rows = await client.indicatorSnapshot.findMany({
    where: {
      scope: { in: [...scopes] },
      indicator: { in: [...indicators] },
      status: 'ok',
      asOf: { lte: date },
    },
    orderBy: { asOf: 'desc' },
    take: DAILY_QUERY_LIMIT,
    select: {
      scope: true,
      indicator: true,
      value: true,
      unit: true,
      asOf: true,
    },
  });

  const latest = new Map<string, IndicatorSnapshotRow>();
  for (const row of rows) {
    const key = metricKey(row.scope, row.indicator);
    if (!latest.has(key)) latest.set(key, row);
  }
  return latest;
}

function dailyValuesFor(
  latest: Map<string, IndicatorSnapshotRow>,
  scopes: readonly string[],
  indicators: readonly string[]
): DailyMetricValue[] {
  const values: DailyMetricValue[] = [];
  for (const scope of scopes) {
    for (const metric of indicators) {
      const row = latest.get(metricKey(scope, metric));
      values.push({
        scope,
        metric,
        value: row === undefined ? null : toNumber(row.value),
        unit: row?.unit ?? null,
        asOf: row?.asOf ?? null,
      });
    }
  }
  return values;
}

async function latestOverviewDailyMetrics(
  client: OverviewDailyClient,
  asOf: string
): Promise<Map<string, OverviewDailyMetricRow>> {
  const date = closedDay(asOf);
  if (date === null) return new Map();

  const since = new Date(
    date.getTime() - OVERVIEW_CLOSED_LOOKBACK_DAYS * 24 * HOUR_MS
  );
  const rows = await client.metricSnapshot.findMany({
    where: {
      scope: 'solana',
      metric: { in: [...OVERVIEW_CLOSED_METRICS] },
      source: { provider: OVERVIEW_CLOSED_PROVIDER },
      sourceTs: { gte: since, lte: date },
    },
    orderBy: { sourceTs: 'desc' },
    take: OVERVIEW_CLOSED_QUERY_LIMIT,
    select: {
      scope: true,
      metric: true,
      value: true,
      unit: true,
      sourceTs: true,
    },
  });

  const latest = new Map<string, OverviewDailyMetricRow>();
  for (const row of rows) {
    if (row.sourceTs === null || row.sourceTs.getTime() > date.getTime()) continue;
    const current = latest.get(row.metric);
    if (current === undefined || current.sourceTs === null) {
      latest.set(row.metric, row);
    } else if (row.sourceTs.getTime() > current.sourceTs.getTime()) {
      latest.set(row.metric, row);
    }
  }
  return latest;
}

function overviewDailyValuesFor(
  latest: Map<string, OverviewDailyMetricRow>
): DailyMetricValue[] {
  return OVERVIEW_CLOSED_METRICS.map((metric) => {
    const row = latest.get(metric);
    return {
      scope: 'solana',
      metric,
      value: row === undefined ? null : toNumber(row.value),
      unit: row?.unit ?? null,
      asOf: row?.sourceTs ?? null,
    };
  });
}

export async function readOverviewDaily(
  client: OverviewDailyClient,
  asOf: string
): Promise<DailyMetricValue[]> {
  // global_market_cap_usd and btc_dominance_pct have no daily series in
  // defillama_history, so their Closed value stays n/a.
  const latest = await latestOverviewDailyMetrics(client, asOf);
  return overviewDailyValuesFor(latest);
}

export async function readHyperliquidDaily(
  client: DailyClient,
  asOf: string
): Promise<DailyMetricValue[]> {
  const scopes = HYPERLIQUID_COINS.map((coin) => `hyperliquid:perp:${coin}`);
  const latest = await latestDailyMetrics(
    client,
    scopes,
    HYPERLIQUID_INDICATORS,
    asOf
  );
  return dailyValuesFor(latest, scopes, HYPERLIQUID_INDICATORS);
}
