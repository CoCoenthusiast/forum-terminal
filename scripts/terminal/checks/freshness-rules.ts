export type FreshnessStatus = 'OK' | 'WARN' | 'FAIL';

export interface FreshnessResult {
  item: string;
  status: FreshnessStatus;
  detalhe: string;
}

export interface PriceCheck {
  label: string;
  collectedAt: Date | null;
}

export interface ReturnCheck {
  item: string;
  asOf: Date | null;
}

export interface LaunchpadCheck {
  slug: string;
  toDate: Date | null;
}

export interface FreshnessInput {
  date: string;
  now: Date;
  prices: readonly PriceCheck[];
  returns: readonly ReturnCheck[];
  stateAsOf: Date | null;
  dailyCloseDate: Date | null;
  coinalyzeAsOf: Date | null;
  dollarToDate: Date | null;
  realYieldToDate: Date | null;
  dexToDate: Date | null;
  launchpads: readonly LaunchpadCheck[];
  lastSuccessfulCollectionAt: Date | null;
}

export const PRICE_MAX_AGE_HOURS = 36;
export const COINALYZE_WARN_DAYS = 2;
export const DOLLAR_OK_DAYS = 10;
export const DOLLAR_WARN_DAYS = 20;
export const REAL_YIELD_OK_DAYS = 5;
export const REAL_YIELD_WARN_DAYS = 10;
export const DEX_OK_DAYS = 4;
export const LAUNCHPAD_OK_DAYS = 4;
export const LAUNCHPAD_MIN_PRESENT = 3;
export const COLLECTION_WARN_HOURS = 3;
export const COLLECTION_FAIL_HOURS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STATUS_RANK: Record<FreshnessStatus, number> = {
  OK: 0,
  WARN: 1,
  FAIL: 2,
};

function utcDayMs(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

export function previousUtcDay(now: Date): string {
  return new Date(utcDayMs(now) - DAY_MS).toISOString().slice(0, 10);
}

export function resolveReferenceDate(
  argv: readonly string[],
  now: Date
): { date: string; error: string | null } {
  const args = argv.filter(
    (arg) => arg === '--date' || arg.startsWith('--date=')
  );

  if (args.length === 0) return { date: previousUtcDay(now), error: null };
  if (args.length > 1) {
    return { date: '', error: 'use --date=YYYY-MM-DD uma única vez' };
  }

  const arg = args[0];
  if (arg === '--date') {
    return { date: '', error: '--date exige o formato YYYY-MM-DD' };
  }

  const value = arg.slice('--date='.length);
  if (parseDate(value) === null) {
    return { date: '', error: `data inválida: ${value}` };
  }

  return { date: value, error: null };
}

export function delayDays(value: Date, date: string): number {
  const reference = parseDate(date);
  if (reference === null) return 0;
  return Math.max(0, Math.round((utcDayMs(reference) - utcDayMs(value)) / DAY_MS));
}

export function ageHours(value: Date, now: Date): number {
  return Math.max(0, (now.getTime() - value.getTime()) / HOUR_MS);
}

export function priceStatus(
  collectedAt: Date | null,
  now: Date
): FreshnessStatus {
  if (collectedAt === null) return 'FAIL';
  return ageHours(collectedAt, now) > PRICE_MAX_AGE_HOURS ? 'FAIL' : 'OK';
}

export function returnStatus(
  asOf: Date | null,
  date: string
): FreshnessStatus {
  if (asOf === null) return 'FAIL';
  return delayDays(asOf, date) > 0 ? 'FAIL' : 'OK';
}

export function stateStatus(asOf: Date | null, date: string): FreshnessStatus {
  if (asOf === null) return 'FAIL';
  return delayDays(asOf, date) > 0 ? 'FAIL' : 'OK';
}

export function dailyCloseStatus(
  closeDate: Date | null,
  date: string
): FreshnessStatus {
  if (closeDate === null) return 'FAIL';
  return closeDate.toISOString().slice(0, 10) === date ? 'OK' : 'FAIL';
}

export function coinalyzeStatus(
  asOf: Date | null,
  date: string
): FreshnessStatus {
  if (asOf === null) return 'FAIL';
  const delay = delayDays(asOf, date);
  if (delay === 0) return 'OK';
  if (delay <= COINALYZE_WARN_DAYS) return 'WARN';
  return 'FAIL';
}

export function dollarStatus(
  toDate: Date | null,
  date: string
): FreshnessStatus {
  if (toDate === null) return 'FAIL';
  const delay = delayDays(toDate, date);
  if (delay <= DOLLAR_OK_DAYS) return 'OK';
  if (delay <= DOLLAR_WARN_DAYS) return 'WARN';
  return 'FAIL';
}

export function realYieldStatus(
  toDate: Date | null,
  date: string
): FreshnessStatus {
  if (toDate === null) return 'FAIL';
  const delay = delayDays(toDate, date);
  if (delay <= REAL_YIELD_OK_DAYS) return 'OK';
  if (delay <= REAL_YIELD_WARN_DAYS) return 'WARN';
  return 'FAIL';
}

export function dexStatus(toDate: Date | null, date: string): FreshnessStatus {
  if (toDate === null) return 'FAIL';
  return delayDays(toDate, date) <= DEX_OK_DAYS ? 'OK' : 'WARN';
}

export function launchpadStatus(
  toDate: Date | null,
  date: string
): FreshnessStatus {
  if (toDate === null) return 'WARN';
  return delayDays(toDate, date) <= LAUNCHPAD_OK_DAYS ? 'OK' : 'WARN';
}

export function collectionStatus(
  collectedAt: Date | null,
  now: Date
): FreshnessStatus {
  if (collectedAt === null) return 'FAIL';
  const age = ageHours(collectedAt, now);
  if (age <= COLLECTION_WARN_HOURS) return 'OK';
  if (age <= COLLECTION_FAIL_HOURS) return 'WARN';
  return 'FAIL';
}

export function worstStatus(
  results: readonly FreshnessResult[]
): FreshnessStatus {
  let worst: FreshnessStatus = 'OK';
  for (const result of results) {
    if (STATUS_RANK[result.status] > STATUS_RANK[worst]) {
      worst = result.status;
    }
  }
  return worst;
}

export function exitCodeFor(results: readonly FreshnessResult[]): 0 | 1 {
  return results.some((result) => result.status === 'FAIL') ? 1 : 0;
}

function dateDetail(value: Date | null, date: string): string {
  if (value === null) return 'date=n/a, delay=n/a';
  return `date=${value.toISOString().slice(0, 10)}, delay=${delayDays(value, date)}d`;
}

function timeDetail(value: Date | null, now: Date): string {
  if (value === null) return 'date=n/a, delay=n/a';
  return `date=${value.toISOString()}, delay=${ageHours(value, now).toFixed(1)}h`;
}

export function evaluateFreshness(input: FreshnessInput): FreshnessResult[] {
  const results: FreshnessResult[] = [];

  for (const price of input.prices) {
    results.push({
      item: `Price ${price.label}`,
      status: priceStatus(price.collectedAt, input.now),
      detalhe: timeDetail(price.collectedAt, input.now),
    });
  }

  for (const ret of input.returns) {
    results.push({
      item: ret.item,
      status: returnStatus(ret.asOf, input.date),
      detalhe: dateDetail(ret.asOf, input.date),
    });
  }

  results.push({
    item: 'State',
    status: stateStatus(input.stateAsOf, input.date),
    detalhe: dateDetail(input.stateAsOf, input.date),
  });

  results.push({
    item: 'Daily close SOL',
    status: dailyCloseStatus(input.dailyCloseDate, input.date),
    detalhe: dateDetail(input.dailyCloseDate, input.date),
  });

  results.push({
    item: 'Coinalyze',
    status: coinalyzeStatus(input.coinalyzeAsOf, input.date),
    detalhe: dateDetail(input.coinalyzeAsOf, input.date),
  });

  results.push({
    item: 'Broad dollar',
    status: dollarStatus(input.dollarToDate, input.date),
    detalhe: dateDetail(input.dollarToDate, input.date),
  });

  results.push({
    item: 'Real yield 10y',
    status: realYieldStatus(input.realYieldToDate, input.date),
    detalhe: dateDetail(input.realYieldToDate, input.date),
  });

  results.push({
    item: 'DEX volume',
    status: dexStatus(input.dexToDate, input.date),
    detalhe: dateDetail(input.dexToDate, input.date),
  });

  for (const launchpad of input.launchpads) {
    results.push({
      item: `Launchpad ${launchpad.slug}`,
      status: launchpadStatus(launchpad.toDate, input.date),
      detalhe: dateDetail(launchpad.toDate, input.date),
    });
  }

  const present = input.launchpads.filter(
    (launchpad) => launchpad.toDate !== null
  ).length;
  if (present < LAUNCHPAD_MIN_PRESENT) {
    results.push({
      item: 'Launchpad coverage',
      status: 'WARN',
      detalhe: `present=${present}/${input.launchpads.length}; partial`,
    });
  }

  results.push({
    item: 'Hourly collection',
    status: collectionStatus(input.lastSuccessfulCollectionAt, input.now),
    detalhe: timeDetail(input.lastSuccessfulCollectionAt, input.now),
  });

  return results;
}
