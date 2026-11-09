import type { PrismaClient } from '../generated/db/client';
import { previousUtcDay } from '../checks/freshness-rules';
import {
  readIndicatorSeries,
  type SeriesTarget,
} from '../dashboard/series-reader';
import {
  MACRO_INDICATORS,
  MACRO_INDICATOR_FORMULA_VERSION,
} from '../indicators/macro-catalog';
import { MACRO_SERIES } from '../sources/macro-config';

const DAY_MS = 24 * 60 * 60 * 1000;
const MACRO_WINDOW_DAYS = 90;
const MACRO_SCOPE = 'macro:us';
const MACRO_QUERY_LIMIT = 5000;
const MACRO_MONTHLY_LOOKBACK_DAYS = 400;
const MACRO_MONTHLY_POINTS = 12;

type MacroFrequency = 'daily' | 'weekly' | 'monthly';

const SERIES_ORDER: readonly {
  id: string;
  frequency: MacroFrequency;
}[] = [
  { id: 'ust_nominal_3m', frequency: 'daily' },
  { id: 'ust_nominal_2y', frequency: 'daily' },
  { id: 'ust_nominal_5y', frequency: 'daily' },
  { id: 'ust_nominal_10y', frequency: 'daily' },
  { id: 'ust_nominal_30y', frequency: 'daily' },
  { id: 'ust_real_5y', frequency: 'daily' },
  { id: 'ust_real_10y', frequency: 'daily' },
  { id: 'sofr', frequency: 'daily' },
  { id: 'effr', frequency: 'daily' },
  { id: 'fed_broad_dollar', frequency: 'weekly' },
  { id: 'ecb_eurusd', frequency: 'daily' },
  { id: 'bls_cpi_u_sa', frequency: 'monthly' },
  { id: 'bls_core_cpi_sa', frequency: 'monthly' },
  { id: 'bls_unemployment_rate', frequency: 'monthly' },
  { id: 'bls_nonfarm_payrolls', frequency: 'monthly' },
];

const DAILY_SERIES_IDS = SERIES_ORDER.filter(
  (series) => series.frequency !== 'monthly'
).map((series) => series.id);

const MONTHLY_SERIES_IDS = SERIES_ORDER.filter(
  (series) => series.frequency === 'monthly'
).map((series) => series.id);

const SERIES_DEFINITION = new Map(
  MACRO_SERIES.map((definition) => [definition.seriesId, definition])
);

const INDICATOR_LABELS: Record<string, string> = {
  macro_ust_2s10s_spread: '2s10s spread',
  macro_ust_10y_change_5d: '10y change 5d',
  macro_ust_2y_change_5d: '2y change 5d',
  macro_breakeven_10y: '10y breakeven',
  macro_breakeven_5y: '5y breakeven',
  macro_real_yield_10y_change_5d: '10y real yield change 5d',
  macro_sofr_effr_spread: 'SOFR-EFFR spread',
  macro_dollar_broad_change_5d_pct: 'Broad dollar change 5d',
  macro_eurusd_change_5d_pct: 'EUR/USD change 5d',
  macro_cpi_yoy_pct: 'CPI YoY',
  macro_core_cpi_yoy_pct: 'Core CPI YoY',
  macro_unemployment_change_3m: 'Unemployment change 3m',
  macro_payrolls_change_1m: 'Payrolls change 1m',
};

const MACRO_INDICATOR_TARGETS: readonly SeriesTarget[] = MACRO_INDICATORS.map(
  (definition) => ({
    indicator: definition.indicator,
    scope: MACRO_SCOPE,
    formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
  })
);

export interface MacroPoint {
  date: string;
  value: number | null;
}

export interface MacroSeries {
  id: string;
  label: string;
  unit: string;
  source: string;
  frequency: MacroFrequency;
  lastDate: string | null;
  points: MacroPoint[];
}

export interface MacroIndicatorSeries {
  id: string;
  label: string;
  unit: string;
  lastDate: string | null;
  points: MacroPoint[];
}

export interface MacroSnapshot {
  generatedAt: string;
  asOf: string;
  windowDays: number;
  series: MacroSeries[];
  indicators: MacroIndicatorSeries[];
}

interface MacroObservationRow {
  seriesId: string;
  source: string;
  unit: string;
  refDate: Date;
  value: unknown;
  status: string;
  firstSeenAt: Date;
  collectedAt: Date;
}

interface MacroSeriesRead {
  unit: string;
  source: string;
  points: MacroPoint[];
}

interface MacroSeriesInput {
  id: string;
  unit: string;
  source: string;
  points: readonly MacroPoint[];
}

interface MacroIndicatorInput {
  id: string;
  unit: string;
  points: readonly MacroPoint[];
}

interface MacroPayloadInput {
  asOf: string;
  series: readonly MacroSeriesInput[];
  indicators: readonly MacroIndicatorInput[];
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

function pointsFor(points: readonly MacroPoint[]): MacroPoint[] {
  return points.map((point) => ({ date: point.date, value: point.value }));
}

function lastDateFor(points: readonly MacroPoint[]): string | null {
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index];
    if (point.value !== null) return point.date;
  }
  return null;
}

function emptySeriesRead(id: string): MacroSeriesRead {
  const definition = SERIES_DEFINITION.get(id);
  return {
    unit: definition?.unit ?? 'n/a',
    source: definition?.source ?? 'unknown',
    points: [],
  };
}

function collectSeries(
  rows: readonly MacroObservationRow[],
  limitPerSeries: number | null
): Map<string, MacroSeriesRead> {
  const bySeriesDate = new Map<
    string,
    Map<string, { row: MacroObservationRow; seenAt: number }>
  >();

  for (const row of rows) {
    if (row.status === 'nd') continue;
    const date = isoDay(row.refDate.getTime());
    let byDate = bySeriesDate.get(row.seriesId);
    if (byDate === undefined) {
      byDate = new Map();
      bySeriesDate.set(row.seriesId, byDate);
    }

    const seenAt = Math.max(
      row.firstSeenAt.getTime(),
      row.collectedAt.getTime()
    );
    const current = byDate.get(date);
    if (current === undefined || seenAt > current.seenAt) {
      byDate.set(date, { row, seenAt });
    }
  }

  const result = new Map<string, MacroSeriesRead>();
  for (const [seriesId, byDate] of bySeriesDate) {
    const ordered = [...byDate.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    );
    const selected =
      limitPerSeries === null ? ordered : ordered.slice(-limitPerSeries);
    const points = selected.map(([date, item]) => ({
      date,
      value: numberOrNull(item.row.value),
    }));
    const latest = ordered[ordered.length - 1]?.[1]?.row;
    result.set(seriesId, {
      unit: latest?.unit ?? emptySeriesRead(seriesId).unit,
      source: latest?.source ?? emptySeriesRead(seriesId).source,
      points,
    });
  }

  return result;
}

async function readMacroObservations(
  client: Pick<PrismaClient, 'macroObservation'>,
  asOf: string
): Promise<Map<string, MacroSeriesRead>> {
  const asOfMs = new Date(`${asOf}T00:00:00.000Z`).getTime();
  const dailyFrom = new Date(asOfMs - (MACRO_WINDOW_DAYS - 1) * DAY_MS);
  const monthlyFrom = new Date(asOfMs - MACRO_MONTHLY_LOOKBACK_DAYS * DAY_MS);
  const toInclusive = new Date(asOfMs);

  const select = {
    seriesId: true,
    source: true,
    unit: true,
    refDate: true,
    value: true,
    status: true,
    firstSeenAt: true,
    collectedAt: true,
  } as const;

  const [dailyRows, monthlyRows]: [MacroObservationRow[], MacroObservationRow[]] =
    await Promise.all([
      client.macroObservation.findMany({
        where: {
          seriesId: { in: DAILY_SERIES_IDS },
          status: { not: 'nd' },
          refDate: { gte: dailyFrom, lte: toInclusive },
        },
        orderBy: [{ refDate: 'desc' }, { firstSeenAt: 'desc' }],
        take: MACRO_QUERY_LIMIT,
        select,
      }),
      client.macroObservation.findMany({
        where: {
          seriesId: { in: MONTHLY_SERIES_IDS },
          status: { not: 'nd' },
          refDate: { gte: monthlyFrom, lte: toInclusive },
        },
        orderBy: [{ refDate: 'desc' }, { firstSeenAt: 'desc' }],
        take: MACRO_QUERY_LIMIT,
        select,
      }),
    ]);

  const result = collectSeries(dailyRows, null);
  for (const [seriesId, value] of collectSeries(
    monthlyRows,
    MACRO_MONTHLY_POINTS
  )) {
    result.set(seriesId, value);
  }

  for (const series of SERIES_ORDER) {
    if (!result.has(series.id)) {
      result.set(series.id, emptySeriesRead(series.id));
    }
  }

  return result;
}

export function buildMacroPayload(
  inputs: MacroPayloadInput,
  generatedAt: Date
): MacroSnapshot {
  const seriesById = new Map(
    inputs.series.map((series) => [series.id, series])
  );
  const indicatorById = new Map(
    inputs.indicators.map((indicator) => [indicator.id, indicator])
  );

  return {
    generatedAt: generatedAt.toISOString(),
    asOf: inputs.asOf,
    windowDays: MACRO_WINDOW_DAYS,
    series: SERIES_ORDER.map((series) => {
      const definition = SERIES_DEFINITION.get(series.id);
      const input = seriesById.get(series.id);
      const points = pointsFor(input?.points ?? []);
      return {
        id: series.id,
        label: definition?.label ?? series.id,
        unit: input?.unit ?? definition?.unit ?? 'n/a',
        source: input?.source ?? definition?.source ?? 'unknown',
        frequency: series.frequency,
        lastDate: lastDateFor(points),
        points,
      };
    }),
    indicators: MACRO_INDICATORS.map((definition) => {
      const input = indicatorById.get(definition.indicator);
      const points = pointsFor(input?.points ?? []);
      return {
        id: definition.indicator,
        label:
          INDICATOR_LABELS[definition.indicator] ?? definition.indicator,
        unit: input?.unit ?? 'n/a',
        lastDate: lastDateFor(points),
        points,
      };
    }),
  };
}

export async function buildMacroSnapshot(
  client: PrismaClient,
  now: Date = new Date()
): Promise<MacroSnapshot> {
  const asOf = previousUtcDay(now);
  const [observations, indicatorSeries] = await Promise.all([
    readMacroObservations(client, asOf),
    readIndicatorSeries(client, MACRO_INDICATOR_TARGETS, asOf),
  ]);

  const series: MacroSeriesInput[] = SERIES_ORDER.map((definition) => {
    const read = observations.get(definition.id);
    return {
      id: definition.id,
      unit: read?.unit ?? 'n/a',
      source: read?.source ?? 'unknown',
      points: read?.points ?? [],
    };
  });

  const indicators: MacroIndicatorInput[] = MACRO_INDICATORS.map(
    (definition) => {
      const read = indicatorSeries.find(
        (item) => item.indicator === definition.indicator
      );
      return {
        id: definition.indicator,
        unit: read?.unit ?? 'n/a',
        points: read?.points ?? [],
      };
    }
  );

  return buildMacroPayload({ asOf, series, indicators }, now);
}
