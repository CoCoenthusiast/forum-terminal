import type { PrismaClient } from '../generated/db/client';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SERIES_WINDOW_DAYS = 90;

export interface SeriesTarget {
  indicator: string;
  scope: string;
  formulaVersion: string;
  unit?: string;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface IndicatorSeries {
  indicator: string;
  scope: string;
  formulaVersion: string;
  unit: string;
  from: string;
  to: string;
  points: SeriesPoint[];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function seriesWindow(asOf: string): { from: string; to: string } {
  const toMs = new Date(`${asOf}T00:00:00.000Z`).getTime();
  return {
    from: isoDay(toMs - (SERIES_WINDOW_DAYS - 1) * DAY_MS),
    to: asOf,
  };
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

function seriesKey(indicator: string, scope: string, formulaVersion: string): string {
  return `${scope}|${indicator}|${formulaVersion}`;
}

export async function readIndicatorSeries(
  client: Pick<PrismaClient, 'indicatorSnapshot'>,
  targets: readonly SeriesTarget[],
  asOf: string
): Promise<IndicatorSeries[]> {
  const { from, to } = seriesWindow(asOf);
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);

  const rows =
    targets.length === 0
      ? []
      : await client.indicatorSnapshot.findMany({
          where: {
            asOf: { gte: fromDate, lte: toDate },
            OR: targets.map((target) => ({
              indicator: target.indicator,
              scope: target.scope,
              formulaVersion: target.formulaVersion,
            })),
          },
          select: {
            indicator: true,
            scope: true,
            formulaVersion: true,
            status: true,
            value: true,
            unit: true,
            asOf: true,
          },
          orderBy: { asOf: 'asc' },
        });

  const pointsByKey = new Map<string, Map<string, number>>();
  const unitByKey = new Map<string, string>();

  for (const row of rows) {
    const key = seriesKey(row.indicator, row.scope, row.formulaVersion);
    if (!unitByKey.has(key) && typeof row.unit === 'string' && row.unit.length > 0) {
      unitByKey.set(key, row.unit);
    }
    if (row.status.trim().toLowerCase() !== 'ok') continue;

    const value = numberOrNull(row.value);
    if (value === null) continue;

    const date = row.asOf.toISOString().slice(0, 10);
    let points = pointsByKey.get(key);
    if (points === undefined) {
      points = new Map<string, number>();
      pointsByKey.set(key, points);
    }
    points.set(date, value);
  }

  return targets.map((target) => {
    const key = seriesKey(target.indicator, target.scope, target.formulaVersion);
    const points = pointsByKey.get(key);
    const seriesPoints: SeriesPoint[] = [];
    if (points !== undefined) {
      for (const date of [...points.keys()].sort()) {
        const value = points.get(date);
        if (value !== undefined) seriesPoints.push({ date, value });
      }
    }

    return {
      indicator: target.indicator,
      scope: target.scope,
      formulaVersion: target.formulaVersion,
      unit: target.unit ?? unitByKey.get(key) ?? 'n/a',
      from,
      to,
      points: seriesPoints,
    };
  });
}
