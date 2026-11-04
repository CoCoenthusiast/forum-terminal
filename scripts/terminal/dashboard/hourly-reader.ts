import type { PrismaClient } from '../generated/db/client';

const HOUR_MS = 60 * 60 * 1000;

export const HOURLY_WINDOW_HOURS = 6;
export const HOURLY_STALE_HOURS = 3;
const HOURLY_QUERY_LIMIT = 500;
const LATEST_PRICE_QUERY_LIMIT = 500;
const DAILY_QUERY_LIMIT = 500;
const COINALYZE_HOURLY_QUERY_LIMIT = 500;

type HourlyClient = Pick<PrismaClient, 'metricSnapshot'>;
type LatestPriceClient = Pick<PrismaClient, 'marketSnapshot'>;
type DailyClient = Pick<PrismaClient, 'indicatorSnapshot'>;

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

const OVERVIEW_SOLANA_INDICATORS = [
  'tvl_usd',
  'stablecoin_supply_usd',
  'dex_volume_24h_usd',
];

const OVERVIEW_GLOBAL_INDICATORS = ['global_market_cap_usd', 'btc_dominance_pct'];

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

interface CoinalyzeMetricSnapshotRow {
  scope: string;
  metric: string;
  value: unknown;
  unit: string | null;
  sourceTs: Date | null;
  collectedAt: Date;
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

export async function readOverviewDaily(
  client: DailyClient,
  asOf: string
): Promise<DailyMetricValue[]> {
  const indicators = [
    ...OVERVIEW_SOLANA_INDICATORS,
    ...OVERVIEW_GLOBAL_INDICATORS,
  ];
  const latest = await latestDailyMetrics(client, ['solana', 'global'], indicators, asOf);
  return [
    ...dailyValuesFor(latest, ['solana'], OVERVIEW_SOLANA_INDICATORS),
    ...dailyValuesFor(latest, ['global'], OVERVIEW_GLOBAL_INDICATORS),
  ];
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
