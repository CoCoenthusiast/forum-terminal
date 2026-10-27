import { Decimal } from '../prisma-types';

// Hipótese, versionada: um dia D só conhece coletas anteriores a D+1 01:00 UTC.
export const LEVERAGE_KNOWN_CUTOFF_UTC_HOUR = 1;

// Hipótese, versionada: 20 buckets horários completos cobrem a maior parte do dia
// e evitam transformar falhas curtas de coleta em um dia inteiro indisponível.
export const LEVERAGE_MIN_HOURLY_BUCKETS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const METRIC_FIELDS = {
  perp_open_interest_coin: 'oiCoin',
  perp_mark_price_usd: 'markPrice',
  perp_funding_rate_1h: 'funding',
  perp_premium: 'premium',
} as const;

type LeverageField = (typeof METRIC_FIELDS)[keyof typeof METRIC_FIELDS];

export type LeverageStatus = 'ok' | 'insufficient_history' | 'unavailable';

export interface LeverageObservation {
  metric: string;
  bucketTs: Date | null;
  collectedAt: Date;
  value: Decimal | string | number | null;
}

export interface LeverageBucketValues {
  oiCoin: Decimal | null;
  markPrice: Decimal | null;
  funding: Decimal | null;
  premium: Decimal | null;
}

export type LeverageHourlyData = Map<number, LeverageBucketValues>;

export interface LeverageIndicatorResult {
  value: Decimal | null;
  status: LeverageStatus;
  reason: string | null;
  inputCount: number;
  fromDate: Date | null;
  toDate: Date | null;
}

interface DayBucket {
  bucketTs: number;
  values: LeverageBucketValues;
}

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`asOf inválido: ${value}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`asOf inválido: ${value}`);
  }

  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toDecimal(value: Decimal | string | number | null): Decimal | null {
  if (value === null) return null;

  try {
    if (value instanceof Decimal) return value;
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return new Decimal(value);
  } catch {
    return null;
  }
}

function emptyBucket(): LeverageBucketValues {
  return {
    oiCoin: null,
    markPrice: null,
    funding: null,
    premium: null,
  };
}

function startOfUtcHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function startOfUtcDay(asOf: string): Date {
  const date = parseIsoDate(asOf);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function leverageKnownCutoff(asOf: string): Date {
  const date = parseIsoDate(asOf);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + 1,
      LEVERAGE_KNOWN_CUTOFF_UTC_HOUR,
      0,
      0,
      0
    )
  );
}

export function shiftLeverageDay(asOf: string, days: number): string {
  const start = startOfUtcDay(asOf);
  return isoDate(new Date(start.getTime() + days * DAY_MS));
}

export function aggregateLeverageHourly(
  rows: readonly LeverageObservation[],
  asOf: string
): LeverageHourlyData {
  const cutoffMs = leverageKnownCutoff(asOf).getTime();
  const selected = new Map<
    number,
    { values: LeverageBucketValues; collectedAt: Partial<Record<LeverageField, number>> }
  >();

  for (const row of rows) {
    if (row.bucketTs === null) continue;
    if (row.collectedAt.getTime() >= cutoffMs) continue;

    const field = METRIC_FIELDS[row.metric as keyof typeof METRIC_FIELDS] as
      | LeverageField
      | undefined;
    if (field === undefined) continue;

    const value = toDecimal(row.value);
    if (value === null) continue;

    const bucketTs = startOfUtcHour(row.bucketTs.getTime());
    let selectedBucket = selected.get(bucketTs);
    if (selectedBucket === undefined) {
      selectedBucket = { values: emptyBucket(), collectedAt: {} };
      selected.set(bucketTs, selectedBucket);
    }

    const previousCollectedAt = selectedBucket.collectedAt[field];
    const collectedAtMs = row.collectedAt.getTime();
    if (previousCollectedAt === undefined || collectedAtMs > previousCollectedAt) {
      selectedBucket.values[field] = value;
      selectedBucket.collectedAt[field] = collectedAtMs;
    }
  }

  const result: LeverageHourlyData = new Map();
  for (const [bucketTs, bucket] of selected) {
    result.set(bucketTs, bucket.values);
  }

  return result;
}

function dayBuckets(data: LeverageHourlyData, asOf: string): DayBucket[] {
  const start = startOfUtcDay(asOf).getTime();
  const end = start + DAY_MS;
  const buckets: DayBucket[] = [];

  for (const [bucketTs, values] of data) {
    if (bucketTs >= start && bucketTs < end) {
      buckets.push({ bucketTs, values });
    }
  }

  buckets.sort((left, right) => left.bucketTs - right.bucketTs);
  return buckets;
}

function completeBuckets(
  data: LeverageHourlyData,
  asOf: string,
  fields: readonly LeverageField[]
): DayBucket[] {
  return dayBuckets(data, asOf).filter((bucket) =>
    fields.every((field) => bucket.values[field] !== null)
  );
}

function failed(
  status: LeverageStatus,
  reason: string,
  inputCount: number,
  fromDate: Date | null,
  toDate: Date | null
): LeverageIndicatorResult {
  return { value: null, status, reason, inputCount, fromDate, toDate };
}

function coverageFailure(buckets: readonly DayBucket[]): LeverageIndicatorResult {
  return failed(
    'insufficient_history',
    `${buckets.length} buckets, mínimo ${LEVERAGE_MIN_HOURLY_BUCKETS}`,
    buckets.length,
    buckets.length === 0 ? null : new Date(buckets[0].bucketTs),
    buckets.length === 0 ? null : new Date(buckets[buckets.length - 1].bucketTs)
  );
}

function dailyLeverageClose(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  const buckets = completeBuckets(data, asOf, ['oiCoin', 'markPrice']);

  if (buckets.length < LEVERAGE_MIN_HOURLY_BUCKETS) {
    return coverageFailure(buckets);
  }

  const last = buckets[buckets.length - 1];
  const oiCoin = last.values.oiCoin;
  const markPrice = last.values.markPrice;
  if (oiCoin === null || markPrice === null) {
    return coverageFailure(buckets);
  }

  return {
    value: oiCoin.times(markPrice),
    status: 'ok',
    reason: null,
    inputCount: buckets.length,
    fromDate: new Date(buckets[0].bucketTs),
    toDate: new Date(last.bucketTs),
  };
}

function dailyFundingSum(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  const buckets = completeBuckets(data, asOf, ['funding']);

  if (buckets.length < LEVERAGE_MIN_HOURLY_BUCKETS) {
    return coverageFailure(buckets);
  }

  const value = buckets.reduce(
    (sum, bucket) => sum.plus(bucket.values.funding as Decimal),
    new Decimal(0)
  );

  return {
    value,
    status: 'ok',
    reason: null,
    inputCount: buckets.length,
    fromDate: new Date(buckets[0].bucketTs),
    toDate: new Date(buckets[buckets.length - 1].bucketTs),
  };
}

function leverageChange(
  data: LeverageHourlyData,
  asOf: string,
  daysBack: number
): LeverageIndicatorResult {
  const baseDay = shiftLeverageDay(asOf, -daysBack);
  const current = dailyLeverageClose(data, asOf);
  const base = dailyLeverageClose(data, baseDay);

  if (current.status !== 'ok' || current.value === null) {
    return failed(
      'insufficient_history',
      `${asOf}: ${current.reason ?? 'sem leverage_oi_usd_close'}`,
      current.inputCount,
      current.fromDate,
      current.toDate
    );
  }

  if (base.status !== 'ok' || base.value === null) {
    return failed(
      'insufficient_history',
      `${baseDay}: ${base.reason ?? 'sem leverage_oi_usd_close'}`,
      current.inputCount + base.inputCount,
      base.fromDate,
      current.toDate
    );
  }

  if (base.value.lessThanOrEqualTo(0)) {
    return failed(
      'unavailable',
      `variação percentual indisponível: valor base não positivo em ${baseDay}`,
      current.inputCount + base.inputCount,
      base.fromDate,
      current.toDate
    );
  }

  return {
    value: current.value.dividedBy(base.value).minus(1).times(100),
    status: 'ok',
    reason: null,
    inputCount: current.inputCount + base.inputCount,
    fromDate: base.fromDate,
    toDate: current.toDate,
  };
}

export function leverageOiUsdClose(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  return dailyLeverageClose(data, asOf);
}

export function leverageOiUsdChange24hPct(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  return leverageChange(data, asOf, 1);
}

export function leverageOiUsdChange7dPct(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  return leverageChange(data, asOf, 7);
}

export function leverageFundingDailySum(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  return dailyFundingSum(data, asOf);
}

export function leverageFunding7dMean(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  const days = Array.from({ length: 7 }, (_, index) =>
    shiftLeverageDay(asOf, -(6 - index))
  );
  const results = days.map((day) => dailyFundingSum(data, day));
  const failedIndex = results.findIndex((result) => result.status !== 'ok');

  if (failedIndex !== -1) {
    const day = days[failedIndex];
    const result = results[failedIndex];
    let lastToDate: Date | null = null;
    for (let index = results.length - 1; index >= 0; index--) {
      if (results[index].toDate !== null) {
        lastToDate = results[index].toDate;
        break;
      }
    }

    return failed(
      'insufficient_history',
      `${day}: ${result.reason ?? 'funding diário indisponível'}`,
      results.reduce((sum, item) => sum + item.inputCount, 0),
      results.find((item) => item.fromDate !== null)?.fromDate ?? null,
      lastToDate
    );
  }

  const sum = results.reduce(
    (total, result) => total.plus(result.value as Decimal),
    new Decimal(0)
  );

  return {
    value: sum.dividedBy(7),
    status: 'ok',
    reason: null,
    inputCount: results.reduce((total, result) => total + result.inputCount, 0),
    fromDate: results[0].fromDate,
    toDate: results[results.length - 1].toDate,
  };
}

export function leveragePremiumDailyMean(
  data: LeverageHourlyData,
  asOf: string
): LeverageIndicatorResult {
  const buckets = completeBuckets(data, asOf, ['premium']);

  if (buckets.length < LEVERAGE_MIN_HOURLY_BUCKETS) {
    return coverageFailure(buckets);
  }

  const sum = buckets.reduce(
    (total, bucket) => total.plus(bucket.values.premium as Decimal),
    new Decimal(0)
  );

  return {
    value: sum.dividedBy(buckets.length),
    status: 'ok',
    reason: null,
    inputCount: buckets.length,
    fromDate: new Date(buckets[0].bucketTs),
    toDate: new Date(buckets[buckets.length - 1].bucketTs),
  };
}
