export const HORIZONS = [1, 3, 7] as const;
export const MIN_GROUP_DAYS = 20;
export const QUARTILE_LOW = 0.25;
export const QUARTILE_HIGH = 0.75;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClosePoint {
  date: string;
  closeUsd: number | null;
}

export interface ForwardReturnRow {
  date: string;
  returns: Record<number, number | null>;
}

export interface Halves {
  firstHalf: string[];
  secondHalf: string[];
}

export interface QuartileCuts {
  p25: number;
  p75: number;
}

export type GroupLabel = 'low' | 'mid' | 'high';
export type GroupVerdict = 'indicio' | 'amostra_pequena' | 'sem_evidencia';

export interface GroupSummary {
  n: number;
  nIndependent: number;
  mean: number | null;
  median: number | null;
  positivePct: number | null;
}

export type BaselineInput =
  | number
  | GroupSummary
  | readonly (number | null | undefined)[]
  | null
  | undefined;

export interface GroupEvidence {
  n: number;
  difference: number | null;
}

export type JudgeHalfInput = unknown;

export type LabelGroups<T> = Record<string, T[]> & {
  readonly byLabel: Record<string, T[]>;
  readonly byWeekday: Record<string, T[]>;
  readonly byWeekend: Record<'weekday' | 'weekend', T[]>;
  readonly weekend: T[];
  readonly weekday: T[];
};

const WEEKDAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

function parseIsoDateUtc(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const parsed = new Date(ms);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return ms;
}

function isoDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftIsoDate(date: string, days: number): string | null {
  const ms = parseIsoDateUtc(date);
  if (ms === null) return null;
  return isoDateUtc(ms + days * DAY_MS);
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const before = sorted[middle - 1];
  const after = sorted[middle];
  if (before === undefined || after === undefined) return null;
  return (before + after) / 2;
}

function percentileCont(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 1) return sortedValues[0] as number;

  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex] as number;
  const upper = sortedValues[upperIndex] as number;
  const weight = position - lowerIndex;

  return lower + (upper - lower) * weight;
}

function returnsForHorizon(row: unknown, horizon: number): number | null {
  if (row === null || typeof row !== 'object') return null;
  const candidate = row as {
    returns?: Record<number, number | null | undefined>;
    returnPct?: number | null;
    value?: number | null;
  };

  if (candidate.returns !== undefined) {
    return finiteOrNull(candidate.returns[horizon]);
  }
  if (candidate.returnPct !== undefined) {
    return finiteOrNull(candidate.returnPct);
  }
  return finiteOrNull(candidate.value);
}

export function forwardReturns(
  closes: readonly ClosePoint[],
  horizons: readonly number[] = HORIZONS
): ForwardReturnRow[] {
  const closesByDate = new Map<string, number | null>();

  for (const point of closes) {
    if (parseIsoDateUtc(point.date) === null) continue;
    closesByDate.set(point.date, finiteOrNull(point.closeUsd));
  }

  const dates = [...closesByDate.keys()].sort();
  const finiteHorizons = horizons.filter(
    (horizon) => typeof horizon === 'number' && Number.isFinite(horizon)
  );

  return dates.map((date) => {
    const current = closesByDate.get(date) ?? null;
    const result: Record<number, number | null> = {};

    for (const horizon of finiteHorizons) {
      const targetDate = shiftIsoDate(date, horizon);
      const target = targetDate === null ? null : (closesByDate.get(targetDate) ?? null);

      result[horizon] =
        current === null || current === 0 || target === null
          ? null
          : (target / current - 1) * 100;
    }

    return { date, returns: result };
  });
}

export function splitHalves(dates: readonly string[]): Halves {
  const sorted = [...dates].sort();
  const middle = Math.floor(sorted.length / 2);

  return {
    firstHalf: sorted.slice(0, middle),
    secondHalf: sorted.slice(middle),
  };
}

export function quartileCuts(
  values: readonly (number | null | undefined)[]
): QuartileCuts | null {
  const valid = values
    .map((value) => finiteOrNull(value))
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);

  if (valid.length < MIN_GROUP_DAYS) return null;

  return {
    p25: percentileCont(valid, QUARTILE_LOW),
    p75: percentileCont(valid, QUARTILE_HIGH),
  };
}

export function assignGroup(
  value: number | null | undefined,
  cuts: QuartileCuts | null | undefined
): GroupLabel | null {
  const numericValue = finiteOrNull(value);
  if (numericValue === null || cuts === null || cuts === undefined) return null;
  if (!Number.isFinite(cuts.p25) || !Number.isFinite(cuts.p75)) return null;

  if (numericValue <= cuts.p25) return 'low';
  if (numericValue >= cuts.p75) return 'high';
  return 'mid';
}

export function lagSeries(
  valuesByDate:
    | Readonly<Record<string, number | null | undefined>>
    | ReadonlyMap<string, number | null | undefined>,
  delayDays: number
): Record<string, number | null> {
  const entries =
    valuesByDate instanceof Map
      ? [...valuesByDate.entries()]
      : Object.entries(valuesByDate);
  const values = new Map<string, number | null>();

  for (const [date, value] of entries) {
    if (parseIsoDateUtc(date) === null) continue;
    values.set(date, finiteOrNull(value));
  }

  const result: Record<string, number | null> = {};
  for (const date of [...values.keys()].sort()) {
    const sourceDate = shiftIsoDate(date, -delayDays);
    result[date] = sourceDate === null ? null : (values.get(sourceDate) ?? null);
  }

  return result;
}

export function summarizeGroup(
  rows: readonly unknown[],
  horizon: number
): GroupSummary {
  const values: number[] = [];

  for (const row of rows) {
    const value = returnsForHorizon(row, horizon);
    if (value !== null) values.push(value);
  }

  const n = values.length;
  const positive = values.filter((value) => value > 0).length;

  return {
    n,
    nIndependent: horizon > 0 ? Math.floor(n / horizon) : 0,
    mean: mean(values),
    median: median(values),
    positivePct: n === 0 ? null : (positive / n) * 100,
  };
}

function baselineMean(value: BaselineInput): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return finiteOrNull(value);
  if (Array.isArray(value)) {
    const values = value
      .map((item) => finiteOrNull(item))
      .filter((item): item is number => item !== null);
    return mean(values);
  }

  const summary = value as GroupSummary;
  return finiteOrNull(summary.mean);
}

export function compareToBaseline(
  group: GroupSummary | number | null | undefined,
  baseline: BaselineInput
): number | null {
  if (group === null || group === undefined) return null;

  const groupMean = typeof group === 'number' ? finiteOrNull(group) : finiteOrNull(group.mean);
  const referenceMean = baselineMean(baseline);

  if (groupMean === null || referenceMean === null) return null;
  return groupMean - referenceMean;
}

function toEvidence(half: JudgeHalfInput): GroupEvidence | null {
  if (half === null || typeof half !== 'object') return null;

  const candidate = half as Record<string, unknown>;
  const groupValue = candidate.group ?? candidate.summary ?? candidate.stats ?? candidate;
  const group =
    groupValue !== null && typeof groupValue === 'object'
      ? (groupValue as Record<string, unknown>)
      : null;
  const nValue = candidate.n ?? group?.n;
  const n = finiteOrNull(nValue);
  if (n === null) return null;

  let difference = finiteOrNull(
    candidate.difference ??
      candidate.diff ??
      candidate.baselineDifference ??
      candidate.baselineDiff ??
      group?.difference ??
      group?.diff
  );

  if (difference === null) {
    const baseline = candidate.baseline ?? candidate.baselineSummary;
    if (baseline !== undefined && group !== null) {
      difference = compareToBaseline(group as unknown as GroupSummary, baseline as BaselineInput);
    }
  }

  if (difference === null) {
    const groupMean = finiteOrNull(candidate.mean ?? group?.mean);
    const referenceMean = finiteOrNull(
      candidate.baselineMean ?? candidate.referenceMean ?? candidate.overallMean
    );
    if (groupMean !== null && referenceMean !== null) {
      difference = groupMean - referenceMean;
    }
  }

  return { n, difference };
}

export function judgeGroup(
  firstHalf: JudgeHalfInput,
  secondHalf: JudgeHalfInput
): GroupVerdict {
  const first = toEvidence(firstHalf);
  const second = toEvidence(secondHalf);

  if ((first?.n ?? 0) < MIN_GROUP_DAYS || (second?.n ?? 0) < MIN_GROUP_DAYS) {
    return 'amostra_pequena';
  }

  const firstDifference = first?.difference ?? null;
  const secondDifference = second?.difference ?? null;
  if (firstDifference === null || secondDifference === null) {
    return 'sem_evidencia';
  }

  const samePositive = firstDifference > 0 && secondDifference > 0;
  const sameNegative = firstDifference < 0 && secondDifference < 0;

  return samePositive || sameNegative ? 'indicio' : 'sem_evidencia';
}

export function groupByLabel<T>(
  rows: readonly T[],
  labelOf: (row: T) => string | null | undefined
): LabelGroups<T> {
  const labels = new Map<string, T[]>();

  for (const row of rows) {
    const label = labelOf(row);
    if (label === null || label === undefined) continue;
    const group = labels.get(label);
    if (group === undefined) labels.set(label, [row]);
    else group.push(row);
  }

  const groups = Object.fromEntries(labels) as LabelGroups<T>;
  const weekdays: Record<string, T[]> = Object.fromEntries(
    WEEKDAY_NAMES.map((name) => [name, [] as T[]])
  );
  const weekend: T[] = [];
  const weekday: T[] = [];

  for (const row of rows) {
    const date =
      row !== null && typeof row === 'object'
        ? (row as { date?: unknown }).date
        : undefined;
    if (typeof date !== 'string') continue;

    const ms = parseIsoDateUtc(date);
    if (ms === null) continue;

    const day = new Date(ms).getUTCDay();
    const name = WEEKDAY_NAMES[day];
    if (name !== undefined) weekdays[name]?.push(row);

    if (day === 0 || day === 6) weekend.push(row);
    else weekday.push(row);
  }

  const byWeekend: Record<'weekday' | 'weekend', T[]> = { weekday, weekend };

  Object.defineProperties(groups, {
    byLabel: { value: groups, enumerable: false },
    byWeekday: { value: weekdays, enumerable: false },
    byWeekend: { value: byWeekend, enumerable: false },
    weekend: { value: weekend, enumerable: false },
    weekday: { value: weekday, enumerable: false },
  });

  return groups;
}
