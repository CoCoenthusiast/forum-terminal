export const ROLLING_FORMULA_VERSION = 'rolling_hourly_v1';
export const ROLLING_REFERENCE_DAYS = 7;
export const ROLLING_MIN_REFERENCE_POINTS = 6;
export const ROLLING_TOLERANCE_MS = 30 * 60 * 1000;
export const ROLLING_CADENCE_WINDOW_MS = 48 * 60 * 60 * 1000;
export const ROLLING_DAILY_DISTINCT_VALUES = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RollingHourlyCapture {
  sourceTs?: Date | string | null;
  collectedAt?: Date | string | null;
  value: number | null;
}

export interface RollingHourlyCadence {
  updatesOnceDaily: boolean | null;
  lastChangeAt: Date | null;
}

export interface RollingHourlyResult {
  current: number | null;
  currentAt: Date | null;
  referenceMean: number | null;
  relativeDeviation: number | null;
  referencePoints: number;
  cadence: RollingHourlyCadence;
}

interface NormalizedCapture {
  at: Date;
  value: number | null;
}

function captureTime(capture: RollingHourlyCapture): Date | null {
  const raw = capture.sourceTs ?? capture.collectedAt;
  if (raw === null || raw === undefined) return null;
  const date = raw instanceof Date ? raw : new Date(raw);
  return Number.isFinite(date.getTime()) ? date : null;
}

function captureValue(capture: RollingHourlyCapture): number | null {
  return typeof capture.value === 'number' && Number.isFinite(capture.value)
    ? capture.value
    : null;
}

function normalize(
  captures: readonly RollingHourlyCapture[],
  asOf: Date
): NormalizedCapture[] {
  const normalized: NormalizedCapture[] = [];
  for (const capture of captures) {
    const at = captureTime(capture);
    if (at === null || at.getTime() > asOf.getTime()) continue;
    normalized.push({ at, value: captureValue(capture) });
  }
  normalized.sort((left, right) => left.at.getTime() - right.at.getTime());
  return normalized;
}

function cadenceOf(
  captures: readonly NormalizedCapture[],
  asOf: Date
): RollingHourlyCadence {
  const windowStart = asOf.getTime() - ROLLING_CADENCE_WINDOW_MS;
  const distinct = new Set<number>();
  for (const capture of captures) {
    if (
      capture.value !== null &&
      capture.at.getTime() >= windowStart &&
      capture.at.getTime() <= asOf.getTime()
    ) {
      distinct.add(capture.value);
    }
  }

  let lastValue: number | null = null;
  let lastChangeAt: Date | null = null;
  for (const capture of captures) {
    if (capture.value === null) continue;
    if (lastValue !== null && capture.value !== lastValue) {
      lastChangeAt = capture.at;
    }
    lastValue = capture.value;
  }

  return {
    updatesOnceDaily:
      distinct.size === 0
        ? null
        : distinct.size <= ROLLING_DAILY_DISTINCT_VALUES,
    lastChangeAt,
  };
}

function closestCapture(
  captures: readonly NormalizedCapture[],
  targetMs: number
): NormalizedCapture | null {
  let best: NormalizedCapture | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const capture of captures) {
    if (capture.value === null) continue;
    const distance = Math.abs(capture.at.getTime() - targetMs);
    if (distance > ROLLING_TOLERANCE_MS) continue;
    if (
      best === null ||
      distance < bestDistance ||
      (distance === bestDistance && capture.at.getTime() > best.at.getTime())
    ) {
      best = capture;
      bestDistance = distance;
    }
  }
  return best;
}

// catalog.ts distanceToSma includes asOf in its SMA (windowStart = asOf + 1 - n).
// Following that convention, the reference mean below includes the current capture
// in addition to the up-to-seven captures at t-24h, t-48h, ... t-168h.
// The 6-of-7 minimum applies only to the reference captures; the current capture
// is not counted as one of those reference points.
export function computeRollingHourly(
  captures: readonly RollingHourlyCapture[],
  asOf: Date
): RollingHourlyResult {
  const normalized = normalize(captures, asOf);
  const cadence = cadenceOf(normalized, asOf);
  const currentCapture = normalized[normalized.length - 1];
  const currentAt = currentCapture?.at ?? null;
  const current = currentCapture?.value ?? null;

  if (currentCapture === undefined || currentAt === null || current === null) {
    return {
      current,
      currentAt,
      referenceMean: null,
      relativeDeviation: null,
      referencePoints: 0,
      cadence,
    };
  }

  const referenceValues: number[] = [];
  for (let day = 1; day <= ROLLING_REFERENCE_DAYS; day += 1) {
    const target = currentAt.getTime() - day * DAY_MS;
    const match = closestCapture(normalized, target);
    if (match !== null && match.value !== null) {
      referenceValues.push(match.value);
    }
  }

  if (referenceValues.length < ROLLING_MIN_REFERENCE_POINTS) {
    return {
      current,
      currentAt,
      referenceMean: null,
      relativeDeviation: null,
      referencePoints: referenceValues.length,
      cadence,
    };
  }

  const meanValues = [...referenceValues, current];
  const referenceMean =
    meanValues.reduce((total, value) => total + value, 0) / meanValues.length;
  const relativeDeviation =
    referenceMean === 0 ? null : current / referenceMean - 1;

  return {
    current,
    currentAt,
    referenceMean,
    relativeDeviation,
    referencePoints: referenceValues.length,
    cadence,
  };
}
