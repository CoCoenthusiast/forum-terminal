import { Point } from './formulas';
import { Meta } from './series';
import { priceSeries, metricSeries, marketFieldSeries } from './series';

export interface Reader {
  marketSnapshotFindMany(args: { asset: string; from: Date; to: Date }): Promise<{ collectedAt: Date; priceUsd: unknown; volume24hUsd: unknown; marketCapUsd: unknown; provider: string }[]>;
  metricSnapshotFindMany(args: { scope: string; metric: string; providers: string[]; from: Date; to: Date }): Promise<{ collectedAt: Date; value: unknown; provider: string }[]>;
}

export function toNumber(x: unknown): number | null {
  if (typeof x === 'number') {
    return isFinite(x) ? x : null;
  }
  if (typeof x === 'string') {
    const n = Number(x);
    return isFinite(n) ? n : null;
  }
  if (x != null && typeof x === 'object') {
    const s = (x as { toString(): string }).toString();
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  return null;
}

export async function loadPriceSeries(
  reader: Reader,
  asset: string,
  from: Date,
  to: Date,
  todayUtc: string
): Promise<{ series: Point[]; meta: Meta }> {
  const rows = await reader.marketSnapshotFindMany({ asset, from, to });
  const converted = rows.map(row => ({
    provider: row.provider,
    collectedAt: row.collectedAt,
    priceUsd: toNumber(row.priceUsd) ?? NaN,
  }));
  return priceSeries(converted, todayUtc);
}

export async function loadVolumeSeries(
  reader: Reader,
  asset: string,
  from: Date,
  to: Date,
  todayUtc: string
): Promise<{ series: Point[]; meta: Meta }> {
  const rows = await reader.marketSnapshotFindMany({ asset, from, to });
  const converted = rows.map(row => ({
    provider: row.provider,
    collectedAt: row.collectedAt,
    value: toNumber(row.volume24hUsd),
  }));
  return marketFieldSeries(converted, true, todayUtc);
}

export async function loadMarketCapSeries(
  reader: Reader,
  asset: string,
  from: Date,
  to: Date,
  todayUtc: string
): Promise<{ series: Point[]; meta: Meta }> {
  const rows = await reader.marketSnapshotFindMany({ asset, from, to });
  const converted = rows.map(row => ({
    provider: row.provider,
    collectedAt: row.collectedAt,
    value: toNumber(row.marketCapUsd),
  }));
  return marketFieldSeries(converted, false, todayUtc);
}

export async function loadMetricSeries(
  reader: Reader,
  scope: string,
  metric: string,
  providers: { history: string; live: string | null },
  from: Date,
  to: Date,
  todayUtc: string
): Promise<{ series: Point[]; meta: Meta }> {
  const allProviders = Object.values(providers).filter((p): p is string => p !== null);
  const rows = await reader.metricSnapshotFindMany({ scope, metric, providers: allProviders, from, to });
  const converted = rows.map(row => ({
    provider: row.provider,
    collectedAt: row.collectedAt,
    value: toNumber(row.value) ?? NaN,
  }));
  return metricSeries(converted, providers, todayUtc);
}

// SERIES_CATALOG - estrutura com 12 entradas (3 ativos x 3 series + 3 metricas)
export const SERIES_CATALOG = {
  solanaPrice: [],
  solanaVolume: [],
  solanaMarketCap: [],
  bitcoinPrice: [],
  bitcoinVolume: [],
  bitcoinMarketCap: [],
  ethereumPrice: [],
  ethereumVolume: [],
  ethereumMarketCap: [],
  solanaTvl: [],
  solanaStablecoin: [],
  solanaDexVolume: [],
} as const;
