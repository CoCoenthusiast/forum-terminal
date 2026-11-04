import type { PrismaClient } from '../generated/db/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const DOLLAR_QUERY_LIMIT = 500;

export const DOLLAR_WINDOW_DAYS = 30;

type MacroClient = Pick<PrismaClient, 'macroObservation'>;

export const DOLLAR_SERIES_IDS = ['fed_broad_dollar', 'ecb_eurusd'] as const;
export type DollarSeriesId = (typeof DOLLAR_SERIES_IDS)[number];

export interface DollarMacroValue {
  seriesId: DollarSeriesId;
  value: number | null;
  unit: string | null;
  refDate: Date | null;
  firstSeenAt: Date | null;
  ageDays: number | null;
}

interface DollarObservationRow {
  seriesId: string;
  value: unknown;
  unit: string;
  status: string;
  refDate: Date;
  firstSeenAt: Date;
}

function toNumber(value: unknown): number | null {
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

function ageDaysAt(now: Date, refDate: Date | null): number | null {
  if (refDate === null) return null;
  return Math.max(0, Math.floor((now.getTime() - refDate.getTime()) / DAY_MS));
}

function buildDollarValue(
  seriesId: DollarSeriesId,
  row: DollarObservationRow | undefined,
  now: Date
): DollarMacroValue {
  const refDate = row?.refDate ?? null;
  return {
    seriesId,
    value: row === undefined ? null : toNumber(row.value),
    unit: row?.unit ?? null,
    refDate,
    firstSeenAt: row?.firstSeenAt ?? null,
    ageDays: ageDaysAt(now, refDate),
  };
}

export async function readDollarMacro(
  client: MacroClient,
  now: Date = new Date()
): Promise<DollarMacroValue[]> {
  const since = new Date(now.getTime() - DOLLAR_WINDOW_DAYS * DAY_MS);
  const rows = await client.macroObservation.findMany({
    where: {
      seriesId: { in: [...DOLLAR_SERIES_IDS] },
      status: 'ok',
      value: { not: null },
      refDate: { gte: since, lte: now },
    },
    orderBy: [{ refDate: 'desc' }, { firstSeenAt: 'desc' }],
    take: DOLLAR_QUERY_LIMIT,
    select: {
      seriesId: true,
      value: true,
      unit: true,
      status: true,
      refDate: true,
      firstSeenAt: true,
    },
  });

  const latest = new Map<string, DollarObservationRow>();
  for (const row of rows) {
    if (row.status !== 'ok' || toNumber(row.value) === null) continue;
    const current = latest.get(row.seriesId);
    if (
      current === undefined ||
      row.refDate.getTime() > current.refDate.getTime() ||
      (row.refDate.getTime() === current.refDate.getTime() &&
        row.firstSeenAt.getTime() > current.firstSeenAt.getTime())
    ) {
      latest.set(row.seriesId, row);
    }
  }

  return DOLLAR_SERIES_IDS.map((seriesId) =>
    buildDollarValue(seriesId, latest.get(seriesId), now)
  );
}
