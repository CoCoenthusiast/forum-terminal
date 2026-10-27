import { Decimal } from '../prisma-types';
import {
  macroObservationAgeDays,
  type MacroObservationPoint,
  type MacroSeriesMap,
} from './macro-reader';

export const MACRO_STALE_DAYS_DAILY = 5;
export const MACRO_STALE_DAYS_FED = 10;
export const MACRO_STALE_DAYS_MONTHLY = 60;

export type MacroIndicatorStatus =
  | 'ok'
  | 'insufficient_history'
  | 'unavailable'
  | 'stale';

export interface MacroEvidenceReference {
  seriesId: string;
  refDate: string;
  value: string | null;
}

export interface MacroEvidence {
  references: MacroEvidenceReference[];
  latestRefDate: string | null;
  latestAgeDays: number | null;
}

export interface MacroIndicatorResult {
  value: Decimal | null;
  status: MacroIndicatorStatus;
  reason: string | null;
  evidence: MacroEvidence;
}

function parseAsOfMs(asOf: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (match === null) {
    throw new Error(`asOf inválido: ${asOf}`);
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
    throw new Error(`asOf inválido: ${asOf}`);
  }

  return date.getTime();
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function pointsUpTo(
  series: MacroSeriesMap,
  seriesId: string,
  asOf: string
): MacroObservationPoint[] {
  const endMs = parseAsOfMs(asOf) + 24 * 60 * 60 * 1000;
  return [...(series[seriesId] ?? [])]
    .filter((point) => point.refDate.getTime() < endMs)
    .sort((left, right) => left.refDate.getTime() - right.refDate.getTime());
}

function reference(seriesId: string, point: MacroObservationPoint): MacroEvidenceReference {
  return {
    seriesId,
    refDate: isoDate(point.refDate),
    value: point.value.toString(),
  };
}

function missingReference(seriesId: string, refDate: Date): MacroEvidenceReference {
  return {
    seriesId,
    refDate: isoDate(refDate),
    value: null,
  };
}

function evidence(
  references: MacroEvidenceReference[],
  latestRefDate: Date | null,
  asOf: string
): MacroEvidence {
  return {
    references,
    latestRefDate: latestRefDate === null ? null : isoDate(latestRefDate),
    latestAgeDays:
      latestRefDate === null ? null : macroObservationAgeDays(latestRefDate, asOf),
  };
}

function computed(
  value: Decimal,
  references: MacroEvidenceReference[],
  latestRefDate: Date,
  asOf: string,
  maxAgeDays: number
): MacroIndicatorResult {
  const resultEvidence = evidence(references, latestRefDate, asOf);
  const ageDays = resultEvidence.latestAgeDays;

  if (ageDays !== null && ageDays > maxAgeDays) {
    return {
      value,
      status: 'stale',
      reason:
        `dado mais recente ${resultEvidence.latestRefDate} tem ${ageDays} dias ` +
        `(limite ${maxAgeDays})`,
      evidence: resultEvidence,
    };
  }

  return {
    value,
    status: 'ok',
    reason: null,
    evidence: resultEvidence,
  };
}

function failed(
  status: 'insufficient_history' | 'unavailable',
  reason: string,
  references: MacroEvidenceReference[],
  latestRefDate: Date | null,
  asOf: string
): MacroIndicatorResult {
  return {
    value: null,
    status,
    reason,
    evidence: evidence(references, latestRefDate, asOf),
  };
}

function latestPoint(points: readonly MacroObservationPoint[]): MacroObservationPoint | null {
  return points.length === 0 ? null : points[points.length - 1];
}

function latestCommonPoint(
  left: readonly MacroObservationPoint[],
  right: readonly MacroObservationPoint[]
): { left: MacroObservationPoint; right: MacroObservationPoint } | null {
  const rightByDate = new Map<number, MacroObservationPoint>();
  for (const point of right) {
    rightByDate.set(point.refDate.getTime(), point);
  }

  for (let index = left.length - 1; index >= 0; index--) {
    const match = rightByDate.get(left[index].refDate.getTime());
    if (match !== undefined) {
      return { left: left[index], right: match };
    }
  }

  return null;
}

function sameDateDifference(
  leftId: string,
  rightId: string,
  series: MacroSeriesMap,
  asOf: string,
  maxAgeDays: number
): MacroIndicatorResult {
  const left = pointsUpTo(series, leftId, asOf);
  const right = pointsUpTo(series, rightId, asOf);
  const leftLatest = latestPoint(left);
  const rightLatest = latestPoint(right);

  if (leftLatest === null || rightLatest === null) {
    const references: MacroEvidenceReference[] = [];
    if (leftLatest !== null) references.push(reference(leftId, leftLatest));
    if (rightLatest !== null) references.push(reference(rightId, rightLatest));

    const missing = leftLatest === null ? leftId : rightId;
    const latest = leftLatest?.refDate ?? rightLatest?.refDate ?? null;

    return failed(
      'insufficient_history',
      `${missing}: sem observação até ${asOf}`,
      references,
      latest,
      asOf
    );
  }

  const common = latestCommonPoint(left, right);

  if (common === null) {
    return failed(
      'unavailable',
      `sem refDate comum entre ${leftId} e ${rightId}`,
      [reference(leftId, leftLatest), reference(rightId, rightLatest)],
      new Date(Math.max(leftLatest.refDate.getTime(), rightLatest.refDate.getTime())),
      asOf
    );
  }

  return computed(
    common.left.value.minus(common.right.value),
    [reference(leftId, common.left), reference(rightId, common.right)],
    common.left.refDate,
    asOf,
    maxAgeDays
  );
}

function observationChange(
  seriesId: string,
  series: MacroSeriesMap,
  asOf: string,
  previousObservations: number,
  mode: 'absolute' | 'percent',
  maxAgeDays: number
): MacroIndicatorResult {
  const points = pointsUpTo(series, seriesId, asOf);
  const current = latestPoint(points);

  if (current === null) {
    return failed(
      'insufficient_history',
      `${seriesId}: sem observação até ${asOf}`,
      [],
      null,
      asOf
    );
  }

  if (points.length < previousObservations + 1) {
    return failed(
      'insufficient_history',
      `${seriesId}: ${points.length} observações, precisa de ${previousObservations + 1}`,
      [reference(seriesId, current)],
      current.refDate,
      asOf
    );
  }

  const previous = points[points.length - 1 - previousObservations];
  const references = [reference(seriesId, previous), reference(seriesId, current)];

  if (mode === 'percent') {
    if (previous.value.lessThanOrEqualTo(0)) {
      return failed(
        'unavailable',
        `${seriesId}: valor não positivo em ${isoDate(previous.refDate)}`,
        references,
        current.refDate,
        asOf
      );
    }

    return computed(
      current.value.dividedBy(previous.value).minus(1).times(100),
      references,
      current.refDate,
      asOf,
      maxAgeDays
    );
  }

  return computed(
    current.value.minus(previous.value),
    references,
    current.refDate,
    asOf,
    maxAgeDays
  );
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthOffset(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function pointInMonth(
  points: readonly MacroObservationPoint[],
  target: Date
): MacroObservationPoint | null {
  const targetKey = monthKey(target);
  for (let index = points.length - 1; index >= 0; index--) {
    if (monthKey(points[index].refDate) === targetKey) {
      return points[index];
    }
  }
  return null;
}

function monthlyChange(
  seriesId: string,
  series: MacroSeriesMap,
  asOf: string,
  monthsBack: number,
  mode: 'absolute' | 'percent',
  maxAgeDays: number
): MacroIndicatorResult {
  const points = pointsUpTo(series, seriesId, asOf);
  const current = latestPoint(points);

  if (current === null) {
    return failed(
      'insufficient_history',
      `${seriesId}: sem observação até ${asOf}`,
      [],
      null,
      asOf
    );
  }

  const targetDate = monthOffset(current.refDate, -monthsBack);
  const base = pointInMonth(points, targetDate);

  if (base === null) {
    return failed(
      'insufficient_history',
      `${seriesId}: sem observação em ${monthKey(targetDate)}`,
      [reference(seriesId, current), missingReference(seriesId, targetDate)],
      current.refDate,
      asOf
    );
  }

  const references = [reference(seriesId, base), reference(seriesId, current)];

  if (mode === 'percent') {
    if (base.value.lessThanOrEqualTo(0)) {
      return failed(
        'unavailable',
        `${seriesId}: valor não positivo em ${isoDate(base.refDate)}`,
        references,
        current.refDate,
        asOf
      );
    }

    return computed(
      current.value.dividedBy(base.value).minus(1).times(100),
      references,
      current.refDate,
      asOf,
      maxAgeDays
    );
  }

  return computed(
    current.value.minus(base.value),
    references,
    current.refDate,
    asOf,
    maxAgeDays
  );
}

export function macro_ust_2s10s_spread(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return sameDateDifference(
    'ust_nominal_10y',
    'ust_nominal_2y',
    series,
    asOf,
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_ust_10y_change_5d(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return observationChange(
    'ust_nominal_10y',
    series,
    asOf,
    5,
    'absolute',
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_ust_2y_change_5d(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return observationChange(
    'ust_nominal_2y',
    series,
    asOf,
    5,
    'absolute',
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_breakeven_10y(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return sameDateDifference(
    'ust_nominal_10y',
    'ust_real_10y',
    series,
    asOf,
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_breakeven_5y(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return sameDateDifference(
    'ust_nominal_5y',
    'ust_real_5y',
    series,
    asOf,
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_real_yield_10y_change_5d(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return observationChange(
    'ust_real_10y',
    series,
    asOf,
    5,
    'absolute',
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_sofr_effr_spread(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return sameDateDifference('sofr', 'effr', series, asOf, MACRO_STALE_DAYS_DAILY);
}

export function macro_dollar_broad_change_5d_pct(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return observationChange(
    'fed_broad_dollar',
    series,
    asOf,
    5,
    'percent',
    MACRO_STALE_DAYS_FED
  );
}

export function macro_eurusd_change_5d_pct(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return observationChange(
    'ecb_eurusd',
    series,
    asOf,
    5,
    'percent',
    MACRO_STALE_DAYS_DAILY
  );
}

export function macro_cpi_yoy_pct(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return monthlyChange(
    'bls_cpi_u_sa',
    series,
    asOf,
    12,
    'percent',
    MACRO_STALE_DAYS_MONTHLY
  );
}

export function macro_core_cpi_yoy_pct(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return monthlyChange(
    'bls_core_cpi_sa',
    series,
    asOf,
    12,
    'percent',
    MACRO_STALE_DAYS_MONTHLY
  );
}

export function macro_unemployment_change_3m(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return monthlyChange(
    'bls_unemployment_rate',
    series,
    asOf,
    3,
    'absolute',
    MACRO_STALE_DAYS_MONTHLY
  );
}

export function macro_payrolls_change_1m(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return monthlyChange(
    'bls_nonfarm_payrolls',
    series,
    asOf,
    1,
    'absolute',
    MACRO_STALE_DAYS_MONTHLY
  );
}
