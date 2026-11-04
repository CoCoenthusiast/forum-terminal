#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import {
  ROLLING_FORMULA_VERSION,
  computeRollingHourly,
  type RollingHourlyCapture,
} from './rolling-hourly';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name}`);
  if (ok) passed += 1;
  else failures += 1;
}

function approx(actual: number | null, expected: number, tolerance = 1e-9): boolean {
  return actual !== null && Math.abs(actual - expected) < tolerance;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function at(base: Date, offsetMs: number): Date {
  return new Date(base.getTime() + offsetMs);
}

function capture(
  collectedAt: Date,
  value: number | null,
  sourceTs: Date | null = null
): RollingHourlyCapture {
  return { collectedAt, sourceTs, value };
}

function previousDays(currentAt: Date, values: readonly (number | null)[]): RollingHourlyCapture[] {
  return values.map((value, index) =>
    capture(at(currentAt, -(index + 1) * DAY_MS), value)
  );
}

const now = new Date('2026-11-02T12:00:00.000Z');
const currentAt = new Date('2026-11-02T11:00:00.000Z');

check('formula version is rolling_hourly_v1', ROLLING_FORMULA_VERSION === 'rolling_hourly_v1');

const source = readFileSync(new URL('./rolling-hourly.ts', import.meta.url), 'utf8');
check(
  'rolling formula has no database access',
  !/PrismaClient|metricSnapshot|findMany|createMany|\.update\(|\.delete\(/.test(source)
);

const fullCaptures = [
  capture(currentAt, 200),
  ...previousDays(currentAt, [100, 110, 120, 130, 140, 150, 160]),
];
const full = computeRollingHourly(fullCaptures, now);
const expectedMean = (200 + 100 + 110 + 120 + 130 + 140 + 150 + 160) / 8;
check(
  '7 reference points produce current, mean and relative deviation',
  full.current === 200 &&
    full.referencePoints === 7 &&
    approx(full.referenceMean, expectedMean) &&
    approx(full.relativeDeviation, 200 / expectedMean - 1)
);
check(
  'the mean includes the current capture like distanceToSma',
  approx(full.referenceMean, expectedMean) &&
    !approx(full.referenceMean, (100 + 110 + 120 + 130 + 140 + 150 + 160) / 7)
);

const fivePoints = computeRollingHourly(
  [capture(currentAt, 200), ...previousDays(currentAt, [100, 110, 120, 130, 140])],
  now
);
check(
  '5 of 7 reference points are n/a',
  fivePoints.current === 200 &&
    fivePoints.referencePoints === 5 &&
    fivePoints.referenceMean === null &&
    fivePoints.relativeDeviation === null
);

const dailyCaptures = [
  capture(new Date('2026-10-30T00:00:00.000Z'), 50),
  capture(new Date('2026-11-01T00:00:00.000Z'), 100),
  capture(new Date('2026-11-01T01:00:00.000Z'), 100),
  capture(new Date('2026-11-01T02:00:00.000Z'), 100),
  capture(new Date('2026-11-02T00:00:00.000Z'), 200),
  capture(new Date('2026-11-02T01:00:00.000Z'), 200),
  capture(new Date('2026-11-02T02:00:00.000Z'), 200),
];
const daily = computeRollingHourly(dailyCaptures, now);
check(
  '3 or fewer distinct values in 48h are labelled once a day',
  daily.cadence.updatesOnceDaily === true &&
    daily.cadence.lastChangeAt?.toISOString() === '2026-11-02T00:00:00.000Z'
);

const fourValues = computeRollingHourly(
  [
    capture(new Date('2026-11-01T00:00:00.000Z'), 100),
    capture(new Date('2026-11-01T01:00:00.000Z'), 101),
    capture(new Date('2026-11-01T02:00:00.000Z'), 102),
    capture(new Date('2026-11-01T03:00:00.000Z'), 103),
  ],
  now
);
check('4 distinct values in 48h are not labelled once a day', fourValues.cadence.updatesOnceDaily === false);

const missingReference = computeRollingHourly(
  [capture(currentAt, 200), ...previousDays(currentAt, [100, null, 120, 130, 140, 150, 160])],
  now
);
const missingReferenceMean = (200 + 100 + 120 + 130 + 140 + 150 + 160) / 7;
check(
  'a missing reference value is skipped, not zero',
  missingReference.referencePoints === 6 &&
    approx(missingReference.referenceMean, missingReferenceMean) &&
    missingReference.relativeDeviation !== null
);

const missingCurrent = computeRollingHourly(
  [capture(currentAt, null), ...previousDays(currentAt, [100, 110, 120, 130, 140, 150, 160])],
  now
);
check(
  'a missing current value is n/a',
  missingCurrent.current === null &&
    missingCurrent.referenceMean === null &&
    missingCurrent.relativeDeviation === null
);

const target7 = at(currentAt, -7 * DAY_MS);
const sixExact = previousDays(currentAt, [100, 110, 120, 130, 140, 150]);
const atTolerance = computeRollingHourly(
  [capture(currentAt, 200), ...sixExact, capture(at(target7, 30 * 60 * 1000), 160)],
  now
);
const overTolerance = computeRollingHourly(
  [capture(currentAt, 200), ...sixExact, capture(at(target7, 31 * 60 * 1000), 160)],
  now
);
check(
  'a capture exactly 30 minutes from the target is accepted',
  atTolerance.referencePoints === 7
);
check(
  'a capture 31 minutes from the target is ignored',
  overTolerance.referencePoints === 6
);

const sourceTsCapture = capture(
  new Date('2026-11-02T11:00:00.000Z'),
  200,
  new Date('2026-11-02T11:00:00.000Z')
);
const sourceTsResult = computeRollingHourly(
  [sourceTsCapture, ...previousDays(currentAt, [100, 110, 120, 130, 140, 150, 160])],
  now
);
check(
  'sourceTs is preferred over collectedAt when present',
  sourceTsResult.currentAt?.toISOString() === '2026-11-02T11:00:00.000Z'
);

console.log(`\n${passed} passaram, ${failures} falharam`);
if (failures > 0) process.exitCode = 1;
