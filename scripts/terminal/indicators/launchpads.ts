import {
  BACKFILL_DEX_METRIC_NAME,
  BACKFILL_FEES_METRIC_NAME,
  LAUNCHPAD_MIN_POINTS,
  LAUNCHPAD_SLUGS,
  LAUNCHPAD_WINDOW_DAYS,
  buildProtocolScope,
  type LaunchpadSlug,
} from '../config';
import { Decimal } from '../prisma-types';
import {
  addDays,
  insufficientResult,
  okResult,
  unavailableResult,
  type IndicatorResult,
  type Point,
} from './formulas';
import type { Reader } from './loaders';
import { loadMetricSeries } from './loaders';
import type { AsOfDate, IndicatorRow, SeriesMap } from './catalog';

// Cópia local de FORMULA_VERSION (catalog.ts). Evita ciclo de import em runtime:
// catalog.ts importa este módulo e este módulo só importa tipos de catalog.ts.
// Manter em sincronia se a versão do catálogo mudar.
export const LAUNCHPAD_FORMULA_VERSION = 'v1';

const DEX_METRIC = BACKFILL_DEX_METRIC_NAME; // dex_volume_daily_usd (nunca dex_volume_24h_usd)
const FEES_METRIC = BACKFILL_FEES_METRIC_NAME; // fees_daily_usd
const HISTORY_PROVIDER = { history: 'defillama_history', live: null } as const;

export interface LaunchpadSeriesIds {
  dex: string;
  fees: string;
  dexInput: string;
}

function buildSeriesId(metric: string, slug: LaunchpadSlug): string {
  return `launchpad:${metric}:${slug}`;
}

export const LAUNCHPAD_SERIES_IDS: Record<LaunchpadSlug, LaunchpadSeriesIds> = {} as Record<LaunchpadSlug, LaunchpadSeriesIds>;
for (const slug of LAUNCHPAD_SLUGS) {
  const dex = buildSeriesId(DEX_METRIC, slug);
  LAUNCHPAD_SERIES_IDS[slug] = {
    dex,
    fees: buildSeriesId(FEES_METRIC, slug),
    dexInput: `${dex}:volume0_fees>0_excluido`,
  };
}

const DEX_INPUT_BY_SERIES_ID = new Map(
  LAUNCHPAD_SLUGS.map((slug) => [LAUNCHPAD_SERIES_IDS[slug].dex, LAUNCHPAD_SERIES_IDS[slug].dexInput])
);

export interface LaunchpadSeriesDef {
  id: string;
  load: (reader: Reader, from: Date, to: Date, todayUtc: string) => Promise<Point[]>;
}

export const LAUNCHPAD_SERIES_DEFS: LaunchpadSeriesDef[] = [];
for (const slug of LAUNCHPAD_SLUGS) {
  const ids = LAUNCHPAD_SERIES_IDS[slug];
  for (const [metric, id] of [[DEX_METRIC, ids.dex], [FEES_METRIC, ids.fees]] as const) {
    LAUNCHPAD_SERIES_DEFS.push({
      id,
      load: async (reader, from, to, todayUtc) =>
        (await loadMetricSeries(reader, buildProtocolScope(slug), metric, HISTORY_PROVIDER, from, to, todayUtc)).series,
    });
  }
}

function seriesOf(series: SeriesMap, id: string): Point[] {
  return series[id] ?? [];
}

function pointAt(points: readonly Point[], date: string): Point | undefined {
  for (const p of points) {
    if (p.date === date) return p;
  }
  return undefined;
}

function lastDateUpTo(points: readonly Point[], upTo: string): string | null {
  let last: string | null = null;
  for (const p of points) {
    if (p.date <= upTo && (last === null || p.date > last)) last = p.date;
  }
  return last;
}

function toValueMap(points: readonly Point[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of points) map.set(p.date, p.value);
  return map;
}

// Pontos com valor numérico. A série de exibição (dexInput) carrega, apenas para
// impressão, pontos marcados como string; o cálculo nunca os consome.
function numericPoints(points: readonly Point[]): Point[] {
  return points.filter((p) => typeof p.value === 'number');
}

// HIPÓTESE (ver config.ts): volume 0 com fees > 0 na mesma data é tratado como
// ausente. Fees 0 ou ausente mantém o zero real. As séries brutas não mudam.
function usableDexPoints(series: SeriesMap, slug: LaunchpadSlug): Point[] {
  const ids = LAUNCHPAD_SERIES_IDS[slug];
  const feesMap = toValueMap(numericPoints(seriesOf(series, ids.fees)));
  return numericPoints(seriesOf(series, ids.dex)).filter(
    (point) => !(point.value === 0 && (feesMap.get(point.date) ?? 0) > 0)
  );
}

// Série somente de exibição usada nos inputs: mantém todas as datas e marca o
// ponto excluído com o motivo, para a linha gerada mostrar a exclusão.
function displayDexPoints(series: SeriesMap, slug: LaunchpadSlug): Point[] {
  const ids = LAUNCHPAD_SERIES_IDS[slug];
  const feesMap = toValueMap(numericPoints(seriesOf(series, ids.fees)));
  return seriesOf(series, ids.dex).map((point) => {
    if (typeof point.value !== 'number' || point.value !== 0) return point;
    const fees = feesMap.get(point.date);
    if (fees === undefined || fees <= 0) return point;
    return { date: point.date, value: `EXCLUIDO(volume=0,fees=${fees})` as unknown as number };
  });
}

function commonDates(maps: readonly Map<string, number>[], from: string, to: string): string[] {
  if (maps.length === 0) return [];
  const dates: string[] = [];
  for (const date of maps[0].keys()) {
    if (date < from || date > to) continue;
    let present = true;
    for (let i = 1; i < maps.length; i++) {
      if (!maps[i].has(date)) {
        present = false;
        break;
      }
    }
    if (present) dates.push(date);
  }
  dates.sort();
  return dates;
}

function lastCommonDateUpTo(lists: readonly Point[][], upTo: string): string | null {
  if (lists.length === 0) return null;
  const maps = lists.map(toValueMap);
  let last: string | null = null;
  for (const date of maps[0].keys()) {
    if (date > upTo) continue;
    let present = true;
    for (let i = 1; i < maps.length; i++) {
      if (!maps[i].has(date)) {
        present = false;
        break;
      }
    }
    if (present && (last === null || date > last)) last = date;
  }
  return last;
}

function sumOn(map: Map<string, number>, dates: readonly string[]): number {
  let total = 0;
  for (const date of dates) total += map.get(date) ?? 0;
  return total;
}

type LaunchpadUnit = 'FRACTION' | 'RATIO';

interface LaunchpadIndicatorDef {
  indicator: string;
  scope: string;
  unit: LaunchpadUnit;
  inputs: readonly string[];
  window: number;
  minPoints: number;
  resolveAsOf: (series: SeriesMap, requestedAsOf: string) => string | null;
  compute: (series: SeriesMap, asOf: string) => IndicatorResult;
}

function makeVsMean(
  indicator: string,
  slug: LaunchpadSlug,
  seriesId: string,
  window: number,
  minPoints: number,
  options?: { inputs?: readonly string[]; points?: (series: SeriesMap) => Point[] }
): LaunchpadIndicatorDef {
  return {
    indicator,
    scope: buildProtocolScope(slug),
    unit: 'FRACTION',
    inputs: options?.inputs ?? [seriesId],
    window,
    minPoints,
    resolveAsOf: (series, requestedAsOf) => lastDateUpTo(seriesOf(series, seriesId), requestedAsOf),
    compute: (series, asOf) => {
      const points = options?.points === undefined ? numericPoints(seriesOf(series, seriesId)) : options.points(series);
      const windowStart = addDays(asOf, 1 - window);
      const current = pointAt(points, asOf);
      if (current === undefined) {
        return insufficientResult('FRACTION', `${indicator}: sem ponto em ${asOf}`, 0, windowStart, asOf);
      }
      const inWindow = points.filter((p) => p.date >= windowStart && p.date <= asOf);
      if (inWindow.length < minPoints) {
        return insufficientResult(
          'FRACTION',
          `${indicator}: ${inWindow.length} pontos em ${window}d (minimo ${minPoints})`,
          inWindow.length,
          windowStart,
          asOf
        );
      }
      const mean = inWindow.reduce((acc, p) => acc + p.value, 0) / inWindow.length;
      if (mean <= 0) {
        return unavailableResult('FRACTION', `${indicator}: media ${window}d nao positiva`, inWindow.length, windowStart, asOf);
      }
      return okResult(current.value / mean - 1, 'FRACTION', inWindow.length, windowStart, asOf);
    },
  };
}

function makeChange(
  indicator: string,
  slug: LaunchpadSlug,
  seriesId: string,
  window: number,
  options?: { inputs?: readonly string[]; points?: (series: SeriesMap) => Point[] }
): LaunchpadIndicatorDef {
  return {
    indicator,
    scope: buildProtocolScope(slug),
    unit: 'FRACTION',
    inputs: options?.inputs ?? [seriesId],
    window,
    minPoints: 2,
    resolveAsOf: (series, requestedAsOf) => lastDateUpTo(seriesOf(series, seriesId), requestedAsOf),
    compute: (series, asOf) => {
      const points = options?.points === undefined ? numericPoints(seriesOf(series, seriesId)) : options.points(series);
      const baseDate = addDays(asOf, -window);
      const current = pointAt(points, asOf);
      const base = pointAt(points, baseDate);
      if (current === undefined || base === undefined) {
        const missing = current === undefined ? asOf : baseDate;
        return insufficientResult('FRACTION', `${indicator}: sem ponto em ${missing}`, current === undefined ? 0 : 1, baseDate, asOf);
      }
      if (base.value <= 0) {
        return unavailableResult('FRACTION', `${indicator}: valor nao positivo em ${baseDate}`, 2, baseDate, asOf);
      }
      return okResult(current.value / base.value - 1, 'FRACTION', 2, baseDate, asOf);
    },
  };
}

function makeFeesToVolume(slug: LaunchpadSlug, window: number, minPoints: number): LaunchpadIndicatorDef {
  const ids = LAUNCHPAD_SERIES_IDS[slug];
  const indicator = 'launchpad_fees_to_volume_7d';
  return {
    indicator,
    scope: buildProtocolScope(slug),
    unit: 'RATIO',
    inputs: [ids.fees, ids.dexInput],
    window,
    minPoints,
    resolveAsOf: (series, requestedAsOf) =>
      lastCommonDateUpTo([seriesOf(series, ids.fees), seriesOf(series, ids.dex)], requestedAsOf),
    compute: (series, asOf) => {
      const windowStart = addDays(asOf, 1 - window);
      const feesMap = toValueMap(numericPoints(seriesOf(series, ids.fees)));
      const dexMap = toValueMap(usableDexPoints(series, slug));
      const dates = commonDates([feesMap, dexMap], windowStart, asOf);
      if (dates.length < minPoints) {
        return insufficientResult(
          'RATIO',
          `${indicator}: ${dates.length} datas comuns em ${window}d (minimo ${minPoints})`,
          dates.length,
          windowStart,
          asOf
        );
      }
      const volume = sumOn(dexMap, dates);
      if (volume === 0) {
        return unavailableResult('RATIO', `${indicator}: volume ${window}d zero`, dates.length, windowStart, asOf);
      }
      return okResult(sumOn(feesMap, dates) / volume, 'RATIO', dates.length, windowStart, asOf);
    },
  };
}

// HIPÓTESE (ver config.ts): os 4 slugs não se sobrepõem no DefiLlama. O share é
// apenas "entre os 4 slugs observados"; não é participação do mercado.
function makeShare(
  indicator: string,
  slug: LaunchpadSlug,
  seriesIds: readonly string[],
  index: number,
  window: number,
  minPoints: number,
  useVolumeExclusion = false
): LaunchpadIndicatorDef {
  return {
    indicator,
    scope: buildProtocolScope(slug),
    unit: 'FRACTION',
    inputs: useVolumeExclusion ? seriesIds.map((id) => DEX_INPUT_BY_SERIES_ID.get(id) ?? id) : [...seriesIds],
    window,
    minPoints,
    resolveAsOf: (series, requestedAsOf) =>
      lastCommonDateUpTo(seriesIds.map((id) => seriesOf(series, id)), requestedAsOf),
    compute: (series, asOf) => {
      const windowStart = addDays(asOf, 1 - window);
      const maps = seriesIds.map((id, seriesIndex) =>
        toValueMap(
          useVolumeExclusion ? usableDexPoints(series, LAUNCHPAD_SLUGS[seriesIndex]) : numericPoints(seriesOf(series, id))
        )
      );
      const dates = commonDates(maps, windowStart, asOf);
      if (dates.length < minPoints) {
        return insufficientResult(
          'FRACTION',
          `${indicator}: ${dates.length} datas comuns aos ${seriesIds.length} slugs em ${window}d (minimo ${minPoints})`,
          dates.length,
          windowStart,
          asOf
        );
      }
      const totals = maps.map((map) => sumOn(map, dates));
      const total = totals.reduce((acc, value) => acc + value, 0);
      if (total === 0) {
        return unavailableResult('FRACTION', `${indicator}: total ${window}d dos ${seriesIds.length} slugs zero`, dates.length, windowStart, asOf);
      }
      return okResult(totals[index] / total, 'FRACTION', dates.length, windowStart, asOf);
    },
  };
}

function buildLaunchpadIndicators(): LaunchpadIndicatorDef[] {
  const defs: LaunchpadIndicatorDef[] = [];
  const dexIds = LAUNCHPAD_SLUGS.map((slug) => LAUNCHPAD_SERIES_IDS[slug].dex);
  const feesIds = LAUNCHPAD_SLUGS.map((slug) => LAUNCHPAD_SERIES_IDS[slug].fees);

  LAUNCHPAD_SLUGS.forEach((slug, index) => {
    const ids = LAUNCHPAD_SERIES_IDS[slug];
    defs.push(
      makeVsMean('launchpad_dex_volume_vs_mean_7d', slug, ids.dex, LAUNCHPAD_WINDOW_DAYS, LAUNCHPAD_MIN_POINTS, {
        inputs: [ids.dexInput],
        points: (series) => usableDexPoints(series, slug),
      })
    );
    defs.push(
      makeVsMean('launchpad_fees_vs_mean_7d', slug, ids.fees, LAUNCHPAD_WINDOW_DAYS, LAUNCHPAD_MIN_POINTS)
    );
    defs.push(makeFeesToVolume(slug, LAUNCHPAD_WINDOW_DAYS, LAUNCHPAD_MIN_POINTS));
    defs.push(
      makeShare(
        'launchpad_dex_volume_share_7d',
        slug,
        dexIds,
        index,
        LAUNCHPAD_WINDOW_DAYS,
        LAUNCHPAD_MIN_POINTS,
        true
      )
    );
    defs.push(makeShare('launchpad_fees_share_7d', slug, feesIds, index, LAUNCHPAD_WINDOW_DAYS, LAUNCHPAD_MIN_POINTS));
    defs.push(
      makeChange('launchpad_dex_volume_change_7d', slug, ids.dex, LAUNCHPAD_WINDOW_DAYS, {
        inputs: [ids.dexInput],
        points: (series) => usableDexPoints(series, slug),
      })
    );
    defs.push(makeChange('launchpad_fees_change_7d', slug, ids.fees, LAUNCHPAD_WINDOW_DAYS));
  });

  return defs;
}

export const LAUNCHPAD_INDICATORS: LaunchpadIndicatorDef[] = buildLaunchpadIndicators();

function safeCompute(def: LaunchpadIndicatorDef, series: SeriesMap, asOf: string): IndicatorResult {
  try {
    return def.compute(series, asOf);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return insufficientResult(def.unit, `erro ao calcular: ${message}`, 0, null, asOf);
  }
}

function toDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function toDateOrNull(iso: string | null): Date | null {
  return iso === null ? null : toDate(iso);
}

function resultToRow(def: LaunchpadIndicatorDef, result: IndicatorResult, asOfIso: string): IndicatorRow {
  return {
    indicator: def.indicator,
    scope: def.scope,
    asOf: toDate(asOfIso),
    status: result.status,
    value: result.value === null ? null : new Decimal(String(result.value)),
    unit: result.unit,
    inputCount: result.inputCount,
    fromDate: toDateOrNull(result.from),
    toDate: toDateOrNull(result.to),
    reason: result.reason,
    formulaVersion: LAUNCHPAD_FORMULA_VERSION,
  };
}

// Cada indicador/slug usa o próprio asOf: a maior data <= pedido em que todas as
// séries exigidas têm ponto. Assim a defasagem de ~3 dias do DefiLlama não vira
// uma fileira de insufficient_history nos dias recentes nem carry-forward.
// Sem nenhuma data utilizável, a linha insufficient_history sai no asOf pedido.
// Linhas repetidas (mesmo indicador/escopo/asOf em pedidos consecutivos) são
// deduplicadas antes de voltar para o catálogo.
export function computeLaunchpadIndicatorRows(series: SeriesMap, asOfs: readonly AsOfDate[]): IndicatorRow[] {
  // Sem NENHUM ponto do cohort, não emite linhas. Isso evita congelar
  // insufficient_history em todo o período anterior à coleta: compute-indicators
  // grava com createMany + skipDuplicates e nunca atualiza linha existente.
  const hasAnyData = LAUNCHPAD_SERIES_DEFS.some((def) => (series[def.id]?.length ?? 0) > 0);
  if (!hasAnyData) return [];

  for (const slug of LAUNCHPAD_SLUGS) {
    series[LAUNCHPAD_SERIES_IDS[slug].dexInput] = displayDexPoints(series, slug);
  }

  const rows: IndicatorRow[] = [];
  const seen = new Set<string>();

  for (const requested of asOfs) {
    for (const def of LAUNCHPAD_INDICATORS) {
      const ownAsOf = def.resolveAsOf(series, requested.iso);
      const rowAsOf = ownAsOf ?? requested.iso;
      const key = `${def.indicator}|${def.scope}|${rowAsOf}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(resultToRow(def, safeCompute(def, series, rowAsOf), rowAsOf));
    }
  }

  return rows;
}
