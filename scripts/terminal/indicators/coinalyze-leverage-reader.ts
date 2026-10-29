import type { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  macroKnownCutoff,
  type MacroObservationPoint,
  type MacroObservationRowInput,
  type MacroSeriesMap,
} from './macro-reader';
import { COINALYZE_LEVERAGE_INDICATORS } from './coinalyze-leverage-catalog';

export const COINALYZE_LEVERAGE_SOURCE = 'coinalyze';
export const COINALYZE_LEVERAGE_LOAD_LOOKBACK_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CoinalyzeObservationRowInput = MacroObservationRowInput;
export type CoinalyzeSeriesMap = MacroSeriesMap;

export interface CoinalyzeLoadResult {
  rows: CoinalyzeObservationRowInput[];
  queries: number;
  perSeries: Record<string, number>;
}

export const COINALYZE_LEVERAGE_SERIES_IDS = Array.from(
  new Set(COINALYZE_LEVERAGE_INDICATORS.flatMap((definition) => definition.seriesIds))
);

function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new Error(`data inválida: ${value}`);
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
    throw new Error(`data inválida: ${value}`);
  }

  return date;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  return isoDate(new Date(parseIsoDate(value).getTime() + days * DAY_MS));
}

function asOfExclusiveEnd(asOf: string): Date {
  const date = parseIsoDate(asOf);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
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

function isAbsent(row: CoinalyzeObservationRowInput): boolean {
  return (
    row.status.trim().toLowerCase() !== 'ok' ||
    toDecimal(row.value) === null
  );
}

export function selectCoinalyzeKnownSeries(
  rows: readonly CoinalyzeObservationRowInput[],
  seriesId: string,
  asOf: string
): MacroObservationPoint[] {
  const cutoffMs = macroKnownCutoff(asOf).getTime();
  const refDateEndMs = asOfExclusiveEnd(asOf).getTime();
  const latestByRefDate = new Map<number, CoinalyzeObservationRowInput>();

  for (const row of rows) {
    if (row.seriesId !== seriesId) continue;
    if (row.firstSeenAt.getTime() >= cutoffMs) continue;
    if (row.refDate.getTime() >= refDateEndMs) continue;

    const key = row.refDate.getTime();
    const current = latestByRefDate.get(key);

    if (current === undefined || row.firstSeenAt.getTime() >= current.firstSeenAt.getTime()) {
      latestByRefDate.set(key, row);
    }
  }

  const points: MacroObservationPoint[] = [];

  for (const row of latestByRefDate.values()) {
    if (isAbsent(row)) continue;

    const value = toDecimal(row.value);
    if (value === null) continue;

    points.push({
      refDate: new Date(row.refDate.getTime()),
      value,
      firstSeenAt: new Date(row.firstSeenAt.getTime()),
    });
  }

  points.sort((left, right) => left.refDate.getTime() - right.refDate.getTime());
  return points;
}

export function readCoinalyzeObservationsFromRows(
  rows: readonly CoinalyzeObservationRowInput[],
  asOf: string,
  seriesIds: readonly string[] = COINALYZE_LEVERAGE_SERIES_IDS
): CoinalyzeSeriesMap {
  const result: CoinalyzeSeriesMap = {};

  for (const seriesId of seriesIds) {
    result[seriesId] = selectCoinalyzeKnownSeries(rows, seriesId, asOf);
  }

  return result;
}

export function coinalyzeLoadFrom(from: string): string {
  return addDays(from, -COINALYZE_LEVERAGE_LOAD_LOOKBACK_DAYS);
}

export async function loadCoinalyzeObservationRows(
  client: Pick<PrismaClient, 'macroObservation'>,
  from: string,
  to: string,
  seriesIds: readonly string[] = COINALYZE_LEVERAGE_SERIES_IDS
): Promise<CoinalyzeLoadResult> {
  const loadFrom = parseIsoDate(coinalyzeLoadFrom(from));
  const rangeEnd = parseIsoDate(to);
  const maxCutoff = macroKnownCutoff(to);

  const rows = await client.macroObservation.findMany({
    where: {
      source: COINALYZE_LEVERAGE_SOURCE,
      seriesId: { in: [...seriesIds] },
      refDate: { gte: loadFrom, lte: rangeEnd },
      firstSeenAt: { lt: maxCutoff },
    },
    select: {
      seriesId: true,
      refDate: true,
      value: true,
      status: true,
      firstSeenAt: true,
    },
    orderBy: [{ refDate: 'asc' }, { firstSeenAt: 'asc' }],
  });

  const perSeries: Record<string, number> = {};
  for (const seriesId of seriesIds) {
    perSeries[seriesId] = 0;
  }
  for (const row of rows) {
    perSeries[row.seriesId] = (perSeries[row.seriesId] ?? 0) + 1;
  }

  return { rows, queries: 1, perSeries };
}
