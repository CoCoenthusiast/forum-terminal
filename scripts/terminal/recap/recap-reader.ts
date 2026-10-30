import type { PrismaClient } from '../generated/db/client';
import { LAUNCHPAD_SLUGS, STATE_VERSION, buildProtocolScope } from '../config';
import { hasRegimePayload } from '../report-recap';
import { priceSeries } from '../indicators/series';
import type {
  RecapInput,
  RecapLaunchpad,
  RecapMetric,
  RecapPrice,
  RecapRegime,
} from './recap-format';

const DAY_MS = 24 * 60 * 60 * 1000;
const PRICE_LOOKBACK_DAYS = 60;
const RETURN_FORMULA_VERSION = 'v1';
const COINALYZE_FORMULA_VERSION = 'coinalyze_leverage_v1';
const MACRO_FORMULA_VERSION = 'macro_v1';

interface IndicatorTarget {
  key: string;
  indicator: string;
  scope: string;
  formulaVersion: string;
}

const PRICE_ASSETS = ['SOL', 'BTC', 'ETH'] as const;
const LEVERAGE_SCOPE = 'coinalyze:SOL';
const MACRO_SCOPE = 'macro:us';

function target(
  key: string,
  indicator: string,
  scope: string,
  formulaVersion: string
): IndicatorTarget {
  return { key, indicator, scope, formulaVersion };
}

const TARGETS: IndicatorTarget[] = [
  ...PRICE_ASSETS.flatMap((asset) => [
    target(
      `return1d|${asset}`,
      'return_1d',
      asset.toLowerCase(),
      RETURN_FORMULA_VERSION
    ),
    target(
      `return7d|${asset}`,
      'return_7d',
      asset.toLowerCase(),
      RETURN_FORMULA_VERSION
    ),
  ]),
  target(
    'oiUsdChange7dPct',
    'oi_usd_change_7d_pct',
    LEVERAGE_SCOPE,
    COINALYZE_FORMULA_VERSION
  ),
  target(
    'funding7dMean',
    'funding_7d_mean',
    LEVERAGE_SCOPE,
    COINALYZE_FORMULA_VERSION
  ),
  target(
    'liqTotalVsMean7dPct',
    'liq_total_vs_mean7d_pct',
    LEVERAGE_SCOPE,
    COINALYZE_FORMULA_VERSION
  ),
  target(
    'liqLongSharePct',
    'liq_long_share_pct',
    LEVERAGE_SCOPE,
    COINALYZE_FORMULA_VERSION
  ),
  target(
    'dollarBroadChange5dPct',
    'macro_dollar_broad_change_5d_pct',
    MACRO_SCOPE,
    MACRO_FORMULA_VERSION
  ),
  target(
    'realYield10yChange5d',
    'macro_real_yield_10y_change_5d',
    MACRO_SCOPE,
    MACRO_FORMULA_VERSION
  ),
  target(
    'dexVolumeVsMean7d',
    'dex_volume_vs_mean_7d',
    'solana',
    RETURN_FORMULA_VERSION
  ),
  ...LAUNCHPAD_SLUGS.map((slug) =>
    target(
      `launchpad|${slug}`,
      'launchpad_dex_volume_vs_mean_7d',
      buildProtocolScope(slug),
      RETURN_FORMULA_VERSION
    )
  ),
];

export interface IndicatorReadRow {
  indicator: string;
  scope: string;
  status: string;
  value: unknown;
  unit: string;
  asOf: Date;
  formulaVersion: string;
}

export interface StateReadRow {
  computeMode: string;
  payload: unknown;
}

export interface MarketPriceReadRow {
  provider: string;
  collectedAt: Date;
  priceUsd: unknown;
}

function nextDay(value: string): string {
  return new Date(new Date(`${value}T00:00:00.000Z`).getTime() + DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function priceFromRows(
  rows: readonly MarketPriceReadRow[],
  asOf: string
): RecapMetric {
  if (rows.length === 0) return emptyMetric();

  const converted = rows.map((row) => ({
    provider: row.provider,
    collectedAt: row.collectedAt,
    priceUsd: numberOrNull(row.priceUsd) ?? Number.NaN,
  }));
  const points = priceSeries(converted, nextDay(asOf)).series.filter(
    (point) => point.date <= asOf
  );
  const latest = points[points.length - 1];
  if (latest === undefined) return emptyMetric();

  return { value: latest.value, unit: 'USD', asOf: latest.date };
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function seriesKey(row: IndicatorReadRow): string {
  return `${row.scope}|${row.indicator}|${row.formulaVersion}`;
}

function targetKey(item: IndicatorTarget): string {
  return `${item.scope}|${item.indicator}|${item.formulaVersion}`;
}

function emptyMetric(): RecapMetric {
  return { value: null, unit: null, asOf: null };
}

export function latestMetrics(
  rows: readonly IndicatorReadRow[]
): Map<string, RecapMetric> {
  const latest = new Map<string, RecapMetric>();

  for (const row of rows) {
    if (row.status.trim().toLowerCase() !== 'ok') continue;
    const key = seriesKey(row);
    const asOf = row.asOf.toISOString().slice(0, 10);
    const current = latest.get(key);
    if (current !== undefined && typeof current.asOf === 'string' && current.asOf >= asOf) {
      continue;
    }

    latest.set(key, {
      value: numberOrNull(row.value),
      unit: row.unit,
      asOf,
    });
  }

  return latest;
}

export function regimeFromStateRows(
  rows: readonly StateReadRow[]
): RecapRegime | null {
  if (rows.length === 0) return null;

  const ordered = [...rows].sort((left, right) => {
    if (left.computeMode === right.computeMode) return 0;
    return left.computeMode === 'live' ? -1 : 1;
  });

  for (const row of ordered) {
    const payload = asRecord(row.payload);
    if (payload === null || !hasRegimePayload(payload)) continue;

    const regime = asRecord(payload.regime);
    if (regime === null) continue;

    const regimeId = typeof regime.regimeId === 'string' ? regime.regimeId : null;
    const description =
      typeof regime.description === 'string' && regime.description.trim().length > 0
        ? regime.description
        : null;
    const reason =
      typeof regime.reason === 'string' && regime.reason.trim().length > 0
        ? regime.reason
        : description;

    return { regimeId, reason };
  }

  return null;
}

export function recapInputFromRows(
  asOf: string,
  stateRows: readonly StateReadRow[],
  indicatorRows: readonly IndicatorReadRow[],
  priceRowsByAsset: Readonly<Record<string, readonly MarketPriceReadRow[]>> = {}
): RecapInput {
  const metrics = latestMetrics(indicatorRows);

  const metric = (key: string): RecapMetric => {
    const item = TARGETS.find((candidate) => candidate.key === key);
    if (item === undefined) return emptyMetric();
    return metrics.get(targetKey(item)) ?? emptyMetric();
  };

  const prices: RecapPrice[] = PRICE_ASSETS.map((asset) => ({
    asset,
    priceUsd: priceFromRows(priceRowsByAsset[asset.toLowerCase()] ?? [], asOf),
    return1d: metric(`return1d|${asset}`),
    return7d: metric(`return7d|${asset}`),
  }));

  const launchpads: RecapLaunchpad[] = LAUNCHPAD_SLUGS.map((slug) => ({
    slug,
    value: metric(`launchpad|${slug}`),
  }));

  return {
    asOf,
    prices,
    regime: regimeFromStateRows(stateRows),
    leverage: {
      oiUsdChange7dPct: metric('oiUsdChange7dPct'),
      funding7dMean: metric('funding7dMean'),
      liqTotalVsMean7dPct: metric('liqTotalVsMean7dPct'),
      liqLongSharePct: metric('liqLongSharePct'),
    },
    macro: {
      dollarBroadChange5dPct: metric('dollarBroadChange5dPct'),
      realYield10yChange5d: metric('realYield10yChange5d'),
    },
    activity: {
      dexVolumeVsMean7d: metric('dexVolumeVsMean7d'),
      launchpads,
    },
  };
}

export async function readRecapInput(
  client: Pick<PrismaClient, 'marketState' | 'indicatorSnapshot' | 'marketSnapshot'>,
  asOf: string
): Promise<RecapInput> {
  const asOfDate = new Date(`${asOf}T00:00:00.000Z`);
  if (Number.isNaN(asOfDate.getTime()) || asOfDate.toISOString().slice(0, 10) !== asOf) {
    throw new Error(`data inválida: ${asOf}`);
  }

  const stateRows = await client.marketState.findMany({
    where: {
      stateVersion: STATE_VERSION,
      asOf: asOfDate,
    },
    select: { computeMode: true, payload: true },
  });

  const priceRows = await client.marketSnapshot.findMany({
    where: {
      asset: { in: PRICE_ASSETS.map((asset) => asset.toLowerCase()) },
      collectedAt: {
        gte: new Date(asOfDate.getTime() - PRICE_LOOKBACK_DAYS * DAY_MS),
        lte: new Date(asOfDate.getTime() + DAY_MS),
      },
      source: { provider: { in: ['coingecko_history', 'coingecko'] } },
    },
    select: {
      asset: true,
      collectedAt: true,
      priceUsd: true,
      source: { select: { provider: true } },
    },
  });

  const priceRowsByAsset: Record<string, MarketPriceReadRow[]> = {};
  for (const row of priceRows) {
    const asset = row.asset.toLowerCase();
    priceRowsByAsset[asset] = priceRowsByAsset[asset] ?? [];
    priceRowsByAsset[asset].push({
      provider: row.source.provider,
      collectedAt: row.collectedAt,
      priceUsd: row.priceUsd,
    });
  }

  const indicatorRows = await client.indicatorSnapshot.findMany({
    where: {
      status: 'ok',
      asOf: { lte: asOfDate },
      OR: TARGETS.map((item) => ({
        indicator: item.indicator,
        scope: item.scope,
        formulaVersion: item.formulaVersion,
      })),
    },
    select: {
      indicator: true,
      scope: true,
      status: true,
      value: true,
      unit: true,
      asOf: true,
      formulaVersion: true,
    },
    orderBy: { asOf: 'desc' },
  });

  return recapInputFromRows(asOf, stateRows, indicatorRows, priceRowsByAsset);
}
