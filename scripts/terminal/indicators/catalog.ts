import { Decimal } from '../prisma-types';
import { ASSETS, BACKFILL_DEX_METRIC_NAME } from '../config';
import type { Reader } from './loaders';
import { loadPriceSeries, loadVolumeSeries, loadMetricSeries } from './loaders';
import {
  type Point,
  type IndicatorResult,
  simpleReturn,
  realizedVolatility,
  pairRatioReturn,
  distanceToSma,
  insufficientResult,
  addDays,
  PERMANENTLY_UNAVAILABLE,
} from './formulas';
import { LAUNCHPAD_SERIES_DEFS, computeLaunchpadIndicatorRows } from './launchpads';

export type Unit = 'FRACTION' | 'RATIO' | 'ZSCORE' | 'INDEX';

export const FORMULA_VERSION = 'v1';

const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_WINDOW_DAYS = 30;

export interface SeriesMap {
  [id: string]: Point[];
}

export const SERIES_IDS = {
  solanaPrice: 'solana_price',
  bitcoinPrice: 'bitcoin_price',
  ethereumPrice: 'ethereum_price',
  solanaVolume: 'solana_volume',
  solanaDexVolume: 'solana_dex_volume',
  solanaStablecoin: 'solana_stablecoin',
  solanaTvl: 'solana_tvl',
} as const;

interface SeriesDef {
  id: string;
  load: (reader: Reader, from: Date, to: Date, todayUtc: string) => Promise<Point[]>;
}

const SERIES_DEFS: SeriesDef[] = [
  { id: SERIES_IDS.solanaPrice, load: async (r, f, t, u) => (await loadPriceSeries(r, 'solana', f, t, u)).series },
  { id: SERIES_IDS.bitcoinPrice, load: async (r, f, t, u) => (await loadPriceSeries(r, 'bitcoin', f, t, u)).series },
  { id: SERIES_IDS.ethereumPrice, load: async (r, f, t, u) => (await loadPriceSeries(r, 'ethereum', f, t, u)).series },
  { id: SERIES_IDS.solanaVolume, load: async (r, f, t, u) => (await loadVolumeSeries(r, 'solana', f, t, u)).series },
  {
    id: SERIES_IDS.solanaDexVolume,
    load: async (r, f, t, u) =>
      (await loadMetricSeries(r, 'solana', BACKFILL_DEX_METRIC_NAME, { history: 'defillama_history', live: null }, f, t, u)).series,
  },
  {
    id: SERIES_IDS.solanaStablecoin,
    load: async (r, f, t, u) =>
      (await loadMetricSeries(r, 'solana', 'stablecoin_supply_usd', { history: 'defillama_history', live: 'defillama' }, f, t, u)).series,
  },
  {
    id: SERIES_IDS.solanaTvl,
    load: async (r, f, t, u) =>
      (await loadMetricSeries(r, 'solana', 'tvl_usd', { history: 'defillama_history', live: 'defillama' }, f, t, u)).series,
  },
  ...LAUNCHPAD_SERIES_DEFS,
];

// Carrega cada série UMA vez por execução, num intervalo (from, to), nunca por dia.
export async function loadAllSeries(reader: Reader, from: Date, to: Date, todayUtc: string): Promise<SeriesMap> {
  const map: SeriesMap = {};
  for (const def of SERIES_DEFS) {
    map[def.id] = await def.load(reader, from, to, todayUtc);
  }
  return map;
}

export interface IndicatorDef {
  indicator: string;
  scope: string;
  unit: Unit;
  formulaVersion: string;
  inputs: string[];
  window: number;
  minPoints: number;
  compute: (series: SeriesMap, asOf: string) => IndicatorResult;
  describe: (series: SeriesMap, asOf: string) => string[];
}

function fmt(value: number | null): string {
  return value === null ? 'null' : String(value);
}

function pointAt(series: Point[] | undefined, date: string): number | null {
  if (!series) return null;
  const point = series.find((p) => p.date === date);
  return point ? point.value : null;
}

function windowPoints(series: Point[] | undefined, windowStart: string, asOf: string): Point[] {
  if (!series) return [];
  return series.filter((p) => p.date >= windowStart && p.date <= asOf);
}

function returnDef(asset: string, priceId: string, n: number): IndicatorDef {
  return {
    indicator: `return_${n}d`,
    scope: asset,
    unit: 'FRACTION',
    formulaVersion: FORMULA_VERSION,
    inputs: [priceId],
    window: n,
    minPoints: 2,
    compute: (s, asOf) => simpleReturn(s[priceId] ?? [], asOf, n),
    describe: (s, asOf) => {
      const target = addDays(asOf, -n);
      return [`${priceId} ${target}=${fmt(pointAt(s[priceId], target))}`, `${priceId} ${asOf}=${fmt(pointAt(s[priceId], asOf))}`];
    },
  };
}

function volatilityDef(asset: string, priceId: string, n: number): IndicatorDef {
  return {
    indicator: `volatility_${n}d`,
    scope: asset,
    unit: 'FRACTION',
    formulaVersion: FORMULA_VERSION,
    inputs: [priceId],
    window: n,
    minPoints: n + 1,
    // volatilidade diária (realizedVolatility SEM anualizar)
    compute: (s, asOf) => realizedVolatility(s[priceId] ?? [], asOf, n, false),
    describe: (s, asOf) => {
      const windowStart = addDays(asOf, -n);
      const points = windowPoints(s[priceId], windowStart, asOf);
      return [`${priceId} ${windowStart}..${asOf}: ${points.length} pontos`, `${priceId} ${asOf}=${fmt(pointAt(s[priceId], asOf))}`];
    },
  };
}

function relativeDef(scope: string, aId: string, bId: string, n: number): IndicatorDef {
  return {
    indicator: `relative_strength_${n}d`,
    scope,
    unit: 'FRACTION',
    formulaVersion: FORMULA_VERSION,
    inputs: [aId, bId],
    window: n,
    minPoints: 4,
    compute: (s, asOf) => pairRatioReturn(s[aId] ?? [], s[bId] ?? [], asOf, n),
    describe: (s, asOf) => {
      const target = addDays(asOf, -n);
      return [
        `${aId} ${target}=${fmt(pointAt(s[aId], target))}`,
        `${aId} ${asOf}=${fmt(pointAt(s[aId], asOf))}`,
        `${bId} ${target}=${fmt(pointAt(s[bId], target))}`,
        `${bId} ${asOf}=${fmt(pointAt(s[bId], asOf))}`,
      ];
    },
  };
}

function vsMeanDef(indicator: string, seriesId: string, n: number): IndicatorDef {
  return {
    indicator: `${indicator}_${n}d`,
    scope: 'solana',
    unit: 'FRACTION',
    formulaVersion: FORMULA_VERSION,
    inputs: [seriesId],
    window: n,
    minPoints: Math.ceil(0.8 * n),
    compute: (s, asOf) => {
      const windowStart = addDays(asOf, 1 - n);
      const available = windowPoints(s[seriesId], windowStart, asOf).length;
      if (available < Math.ceil(0.8 * n)) {
        return insufficientResult('FRACTION', `cobertura insuficiente para ${indicator}`, available, windowStart, asOf);
      }
      return distanceToSma(s[seriesId] ?? [], asOf, n);
    },
    describe: (s, asOf) => {
      const windowStart = addDays(asOf, 1 - n);
      const points = windowPoints(s[seriesId], windowStart, asOf);
      const mean = points.length > 0 ? points.reduce((acc, p) => acc + p.value, 0) / points.length : null;
      return [`${seriesId} ${asOf}=${fmt(pointAt(s[seriesId], asOf))}`, `media(${n})=${fmt(mean)}`, `pontos=${points.length}`];
    },
  };
}

const PRICE_BY_ASSET: Record<string, string> = {
  solana: SERIES_IDS.solanaPrice,
  bitcoin: SERIES_IDS.bitcoinPrice,
  ethereum: SERIES_IDS.ethereumPrice,
};

const PAIRS: [string, string, string][] = [
  ['solana:bitcoin', SERIES_IDS.solanaPrice, SERIES_IDS.bitcoinPrice],
  ['solana:ethereum', SERIES_IDS.solanaPrice, SERIES_IDS.ethereumPrice],
];

function buildIndicators(): IndicatorDef[] {
  const defs: IndicatorDef[] = [];
  for (const asset of ASSETS) {
    const priceId = PRICE_BY_ASSET[asset];
    for (const n of [1, 7, 30]) defs.push(returnDef(asset, priceId, n));
    for (const n of [7, 30]) defs.push(volatilityDef(asset, priceId, n));
  }
  for (const [scope, aId, bId] of PAIRS) {
    for (const n of [1, 7, 30]) defs.push(relativeDef(scope, aId, bId, n));
  }
  for (const n of [7, 30]) defs.push(vsMeanDef('volume_vs_mean', SERIES_IDS.solanaVolume, n));
  for (const n of [7, 30]) defs.push(vsMeanDef('dex_volume_vs_mean', SERIES_IDS.solanaDexVolume, n));
  for (const n of [7, 30]) defs.push(vsMeanDef('stablecoin_supply_vs_mean', SERIES_IDS.solanaStablecoin, n));
  for (const n of [7, 30]) defs.push(vsMeanDef('tvl_vs_mean', SERIES_IDS.solanaTvl, n));
  return defs;
}

export const INDICATORS: IndicatorDef[] = buildIndicators();

export const ATR_INDICATOR = PERMANENTLY_UNAVAILABLE[0];

function safeCompute(def: IndicatorDef, series: SeriesMap, asOf: string): IndicatorResult {
  try {
    const result = def.compute(series, asOf);
    return { ...result, indicator: def.indicator, unit: result.unit ?? def.unit };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      status: 'insufficient_history',
      value: null,
      unit: def.unit,
      inputCount: 0,
      from: null,
      to: null,
      reason: `erro ao calcular: ${message}`,
      indicator: def.indicator,
    };
  }
}

export function evaluateIndicator(def: IndicatorDef, series: SeriesMap, asOf: string): { result: IndicatorResult; inputs: string[] } {
  return { result: safeCompute(def, series, asOf), inputs: def.describe(series, asOf) };
}

export interface IndicatorRow {
  indicator: string;
  scope: string;
  asOf: Date;
  status: string;
  value: Decimal | null;
  unit: string;
  inputCount: number;
  fromDate: Date | null;
  toDate: Date | null;
  reason: string | null;
  formulaVersion: string;
}

export interface AsOfDate {
  iso: string;
  date: Date;
}

export interface ComputedRows {
  rows: IndicatorRow[];
  statusCounts: Record<string, number>;
}

function toDateOrNull(iso: string | null): Date | null {
  return iso === null ? null : new Date(`${iso}T00:00:00.000Z`);
}

function resultToRow(def: IndicatorDef, result: IndicatorResult, asOf: AsOfDate): IndicatorRow {
  return {
    indicator: def.indicator,
    scope: def.scope,
    asOf: asOf.date,
    status: result.status,
    value: result.value === null ? null : new Decimal(String(result.value)),
    unit: result.unit,
    inputCount: result.inputCount,
    fromDate: toDateOrNull(result.from),
    toDate: toDateOrNull(result.to),
    reason: result.reason,
    formulaVersion: def.formulaVersion,
  };
}

export function computeIndicatorRows(series: SeriesMap, asOfs: AsOfDate[]): ComputedRows {
  const rows: IndicatorRow[] = [];
  const statusCounts: Record<string, number> = { ok: 0, insufficient_history: 0, unavailable: 0 };

  for (const def of INDICATORS) {
    for (const asOf of asOfs) {
      const result = safeCompute(def, series, asOf.iso);
      rows.push(resultToRow(def, result, asOf));
      statusCounts[result.status] = (statusCounts[result.status] ?? 0) + 1;
    }
  }

  // atr: gravado UMA vez por execução, só para o asOf mais recente, nunca 365 vezes.
  if (asOfs.length > 0) {
    const atr = ATR_INDICATOR;
    rows.push({
      indicator: 'atr',
      scope: 'solana',
      asOf: asOfs[0].date,
      status: atr.status,
      value: null,
      unit: atr.unit,
      inputCount: atr.inputCount,
      fromDate: null,
      toDate: null,
      reason: atr.reason,
      formulaVersion: FORMULA_VERSION,
    });
    statusCounts[atr.status] = (statusCounts[atr.status] ?? 0) + 1;
  }

  // Launchpads: indicadores com asOf próprio (a fonte atrasa ~3 dias). Não entram
  // em INDICATORS porque o laço acima usa o asOf pedido para todos; aqui cada
  // linha resolve a própria data e é deduplicada em computeLaunchpadIndicatorRows.
  for (const row of computeLaunchpadIndicatorRows(series, asOfs)) {
    rows.push(row);
    statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  }

  return { rows, statusCounts };
}

export function validateRowInvariants(rows: IndicatorRow[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const label = `${row.indicator}/${row.scope}@${row.asOf.toISOString().slice(0, 10)}`;
    if (row.status === 'ok') {
      if (row.value === null) problems.push(`${label}: status ok sem value`);
      if (row.fromDate === null || row.toDate === null) problems.push(`${label}: status ok sem fromDate/toDate`);
      if (row.reason !== null) problems.push(`${label}: status ok com reason`);
    } else {
      if (row.value !== null) problems.push(`${label}: status ${row.status} com value`);
      if (row.reason === null) problems.push(`${label}: status ${row.status} sem reason`);
    }
  }
  return problems;
}

export function buildAsOfDates(todayStartMs: number, days: number): AsOfDate[] {
  const asOfs: AsOfDate[] = [];
  for (let i = 1; i <= days; i++) {
    const date = new Date(todayStartMs - i * DAY_MS);
    asOfs.push({ iso: date.toISOString().slice(0, 10), date });
  }
  return asOfs;
}

export function buildLoadRange(todayStartMs: number, days: number): { from: Date; to: Date } {
  return {
    from: new Date(todayStartMs - (days + MAX_WINDOW_DAYS) * DAY_MS),
    to: new Date(todayStartMs),
  };
}
