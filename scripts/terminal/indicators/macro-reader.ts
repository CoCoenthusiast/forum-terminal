import { Decimal } from '../prisma-types';
import type { PrismaClient } from '../generated/db/client';

// Hipótese, versionada: um estado de D só conhece o que foi visto antes de
// D+1 01:00 UTC. Tesouro de D (22:00 UTC) entra; SOFR de D (D+1 13:00 UTC) não.
export const MACRO_STATE_KNOWN_CUTOFF_UTC_HOUR = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface MacroObservationRowInput {
  seriesId: string;
  refDate: Date;
  value: Decimal | string | number | null;
  status: string;
  firstSeenAt: Date;
}

export interface MacroObservationPoint {
  refDate: Date;
  value: Decimal;
  firstSeenAt: Date;
}

export type MacroSeriesMap = Record<string, MacroObservationPoint[]>;

function parseAsOf(asOf: string): Date {
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

  return date;
}

export function macroKnownCutoff(asOf: string): Date {
  const date = parseAsOf(asOf);

  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() + 1,
      MACRO_STATE_KNOWN_CUTOFF_UTC_HOUR,
      0,
      0,
      0
    )
  );
}

function asOfExclusiveEnd(asOf: string): Date {
  const date = parseAsOf(asOf);
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

function isAbsent(row: MacroObservationRowInput): boolean {
  return (
    row.status.trim().toLowerCase() === 'nd' ||
    toDecimal(row.value) === null
  );
}

function selectKnownSeries(
  rows: readonly MacroObservationRowInput[],
  seriesId: string,
  cutoffMs: number,
  refDateEndMs: number
): MacroObservationPoint[] {
  const latestByRefDate = new Map<number, MacroObservationRowInput>();

  for (const row of rows) {
    if (row.seriesId !== seriesId) continue;
    if (row.firstSeenAt.getTime() >= cutoffMs) continue;
    if (row.refDate.getTime() >= refDateEndMs) continue;

    const key = row.refDate.getTime();
    const current = latestByRefDate.get(key);

    if (current === undefined || row.firstSeenAt.getTime() > current.firstSeenAt.getTime()) {
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

export function readMacroObservationsFromRows(
  rows: readonly MacroObservationRowInput[],
  asOf: string,
  seriesIds: readonly string[]
): MacroSeriesMap {
  const cutoff = macroKnownCutoff(asOf);
  const cutoffMs = cutoff.getTime();
  const refDateEndMs = asOfExclusiveEnd(asOf).getTime();
  const result: MacroSeriesMap = {};

  for (const seriesId of seriesIds) {
    result[seriesId] = selectKnownSeries(rows, seriesId, cutoffMs, refDateEndMs);
  }

  return result;
}

export async function readMacroObservations(
  prisma: PrismaClient,
  asOf: string,
  seriesIds: readonly string[]
): Promise<MacroSeriesMap> {
  const cutoff = macroKnownCutoff(asOf);
  const refDateEnd = asOfExclusiveEnd(asOf);
  const result: MacroSeriesMap = {};

  for (const seriesId of seriesIds) {
    const rows = await prisma.macroObservation.findMany({
      where: {
        seriesId,
        firstSeenAt: { lt: cutoff },
        refDate: { lt: refDateEnd },
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

    result[seriesId] = selectKnownSeries(
      rows,
      seriesId,
      cutoff.getTime(),
      refDateEnd.getTime()
    );
  }

  return result;
}

export function macroObservationAgeDays(latestRefDate: Date, asOf: string): number {
  const asOfDate = parseAsOf(asOf);
  return Math.floor((asOfDate.getTime() - latestRefDate.getTime()) / DAY_MS);
}
