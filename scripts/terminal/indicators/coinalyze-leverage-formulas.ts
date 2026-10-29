import { Decimal } from '../prisma-types';

const DAY_MS = 24 * 60 * 60 * 1000;

export type CoinalyzeDailyValue = Decimal | string | number | null;

export interface CoinalyzeDailyPoint {
  refDate: Date | string;
  value: CoinalyzeDailyValue;
}

export type CoinalyzeDailySeries = readonly CoinalyzeDailyPoint[];
export type CoinalyzeAsOf = Date | string;

type ValueByDay = Map<string, Decimal>;

function parseAsOfDay(asOf: CoinalyzeAsOf): string {
  const date = asOf instanceof Date ? asOf : new Date(asOf);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`asOf inválido: ${String(asOf)}`);
  }

  return date.toISOString().slice(0, 10);
}

function pointDay(refDate: Date | string): string | null {
  const date = refDate instanceof Date ? refDate : new Date(refDate);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString().slice(0, 10);
}

function shiftDay(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + amount * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function toDecimal(value: CoinalyzeDailyValue): Decimal | null {
  if (value === null) return null;

  try {
    if (value instanceof Decimal) return value;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return new Decimal(value);
  } catch {
    return null;
  }
}

function indexSeries(series: CoinalyzeDailySeries): ValueByDay {
  const values: ValueByDay = new Map();

  for (const point of series) {
    const day = pointDay(point.refDate);
    const value = toDecimal(point.value);

    if (day === null || value === null) continue;

    values.set(day, value);
  }

  return values;
}

function valueOn(values: ValueByDay, day: string): Decimal | null {
  return values.get(day) ?? null;
}

function windowValues(
  values: ValueByDay,
  endDay: string,
  count: number
): Decimal[] | null {
  const result: Decimal[] = [];

  for (let offset = count - 1; offset >= 0; offset--) {
    const value = valueOn(values, shiftDay(endDay, -offset));
    if (value === null) return null;
    result.push(value);
  }

  return result;
}

function mean(values: readonly Decimal[]): Decimal {
  return values
    .reduce((sum, value) => sum.plus(value), new Decimal(0))
    .dividedBy(values.length);
}

function totalOn(
  longValues: ValueByDay,
  shortValues: ValueByDay,
  day: string
): Decimal | null {
  const long = valueOn(longValues, day);
  const short = valueOn(shortValues, day);

  if (long === null || short === null) return null;

  return long.plus(short);
}

function changePct(
  series: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf,
  daysBack: number
): Decimal | null {
  const asOfDay = parseAsOfDay(asOf);
  const values = indexSeries(series);
  const current = valueOn(values, asOfDay);
  const base = valueOn(values, shiftDay(asOfDay, -daysBack));

  if (current === null || base === null || base.isZero()) {
    return null;
  }

  return current.minus(base).dividedBy(base).times(100);
}

export function coinalyzeOiUsdChange1dPct(
  series: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf
): Decimal | null {
  return changePct(series, asOf, 1);
}

export function coinalyzeOiUsdChange7dPct(
  series: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf
): Decimal | null {
  return changePct(series, asOf, 7);
}

export function coinalyzeFunding7dMean(
  series: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf
): Decimal | null {
  const values = windowValues(indexSeries(series), parseAsOfDay(asOf), 7);
  return values === null ? null : mean(values);
}

export function coinalyzeLongShortRatio7dMean(
  series: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf
): Decimal | null {
  const values = windowValues(indexSeries(series), parseAsOfDay(asOf), 7);
  return values === null ? null : mean(values);
}

export function coinalyzeLiqTotalVsMean7dPct(
  longSeries: CoinalyzeDailySeries,
  shortSeries: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf
): Decimal | null {
  const asOfDay = parseAsOfDay(asOf);
  const longValues = indexSeries(longSeries);
  const shortValues = indexSeries(shortSeries);
  const currentTotal = totalOn(longValues, shortValues, asOfDay);

  if (currentTotal === null) return null;

  const previousTotals: Decimal[] = [];

  for (let offset = 7; offset >= 1; offset--) {
    const total = totalOn(longValues, shortValues, shiftDay(asOfDay, -offset));
    if (total === null) return null;
    previousTotals.push(total);
  }

  const previousMean = mean(previousTotals);

  if (previousMean.isZero()) return null;

  return currentTotal.dividedBy(previousMean).times(100);
}

export function coinalyzeLiqLongSharePct(
  longSeries: CoinalyzeDailySeries,
  shortSeries: CoinalyzeDailySeries,
  asOf: CoinalyzeAsOf
): Decimal | null {
  const asOfDay = parseAsOfDay(asOf);
  const long = valueOn(indexSeries(longSeries), asOfDay);
  const short = valueOn(indexSeries(shortSeries), asOfDay);

  if (long === null || short === null) return null;

  const total = long.plus(short);

  if (total.isZero()) return null;

  return long.dividedBy(total).times(100);
}
