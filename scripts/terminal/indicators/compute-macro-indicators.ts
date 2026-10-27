#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '../generated/db/client';
import { checkEnvironment } from '../config';
import { Decimal } from '../prisma-types';
import {
  computeMacroIndicators,
  MACRO_INDICATOR_FORMULA_VERSION,
  MACRO_INDICATOR_SERIES_IDS,
  type MacroIndicatorOutput,
} from './macro-catalog';
import {
  macroKnownCutoff,
  readMacroObservationsFromRows,
  type MacroObservationRowInput,
  type MacroSeriesMap,
} from './macro-reader';

export const DEFAULT_MACRO_DAYS = 5;
export const MAX_MACRO_DAYS = 370;
export const MACRO_LOAD_LOOKBACK_MONTHS = 14;
export const MACRO_SCOPE = 'macro:us';
export const MACRO_WRITE_BATCH_SIZE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

const MACRO_UNITS: Record<string, string> = {
  macro_ust_2s10s_spread: 'PERCENT',
  macro_ust_10y_change_5d: 'PERCENT',
  macro_ust_2y_change_5d: 'PERCENT',
  macro_breakeven_10y: 'PERCENT',
  macro_breakeven_5y: 'PERCENT',
  macro_real_yield_10y_change_5d: 'PERCENT',
  macro_sofr_effr_spread: 'PERCENT',
  macro_dollar_broad_change_5d_pct: 'PERCENT',
  macro_eurusd_change_5d_pct: 'PERCENT',
  macro_cpi_yoy_pct: 'PERCENT',
  macro_core_cpi_yoy_pct: 'PERCENT',
  macro_unemployment_change_3m: 'PERCENT',
  macro_payrolls_change_1m: 'THOUSANDS',
};

export interface ComputeMacroOptions {
  days: number;
  from: string | null;
  to: string | null;
  dryRun: boolean;
  save: boolean;
}

export interface MacroDateRange {
  from: string;
  to: string;
  asOfs: string[];
}

export interface MacroSnapshotRow {
  indicator: string;
  scope: string;
  asOf: Date;
  status: string;
  value: Decimal | null;
  unit: string;
  inputCount: number;
  fromDate: Date | null;
  toDate: Date | null;
  reason: string | null;
  formulaVersion: string;
  computedAt: Date;
}

export interface MacroLoadResult {
  rows: MacroObservationRowInput[];
  queries: number;
  perSeries: Record<string, number>;
}

export interface MacroRowsResult {
  rows: MacroSnapshotRow[];
  statusCounts: Record<string, number>;
}

export interface MacroWriteResult {
  inserted: number;
  duplicated: number;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

function validIsoDate(value: string): boolean {
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

function addDays(value: string, days: number): string {
  const date = parseIsoDate(value);
  return isoDate(new Date(date.getTime() + days * DAY_MS));
}

function yesterdayUtc(now: Date): string {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return isoDate(new Date(todayStart - DAY_MS));
}

function inclusiveDays(from: string, to: string): number {
  const fromMs = parseIsoDate(from).getTime();
  const toMs = parseIsoDate(to).getTime();
  return Math.floor((toMs - fromMs) / DAY_MS) + 1;
}

export function parseComputeMacroArgs(
  argv: readonly string[],
  now: Date = new Date()
): ComputeMacroOptions {
  let days = DEFAULT_MACRO_DAYS;
  let from: string | null = null;
  let to: string | null = null;
  let dryRun = false;
  let save = false;

  function valueAfter(index: number, flag: string): string {
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${flag} exige um valor`);
    }
    return next;
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--save') {
      save = true;
      continue;
    }

    if (arg === '--days' || arg.startsWith('--days=')) {
      const raw = arg === '--days' ? valueAfter(index, '--days') : arg.slice('--days='.length);
      if (arg === '--days') index++;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--days inválido: ${raw}`);
      }
      days = parsed;
      continue;
    }

    if (arg === '--from' || arg.startsWith('--from=')) {
      from = arg === '--from' ? valueAfter(index, '--from') : arg.slice('--from='.length);
      if (arg === '--from') index++;
      continue;
    }

    if (arg === '--to' || arg.startsWith('--to=')) {
      to = arg === '--to' ? valueAfter(index, '--to') : arg.slice('--to='.length);
      if (arg === '--to') index++;
      continue;
    }

    throw new Error(`argumento desconhecido: ${arg}`);
  }

  if (from !== null && !validIsoDate(from)) {
    throw new Error(`--from inválido: ${from}`);
  }
  if (to !== null && !validIsoDate(to)) {
    throw new Error(`--to inválido: ${to}`);
  }

  const resolvedTo = to ?? yesterdayUtc(now);
  const resolvedFrom = from ?? addDays(resolvedTo, -(days - 1));

  if (resolvedFrom > resolvedTo) {
    throw new Error(`intervalo inválido: ${resolvedFrom} > ${resolvedTo}`);
  }

  const totalDays = inclusiveDays(resolvedFrom, resolvedTo);
  if (totalDays > MAX_MACRO_DAYS) {
    throw new Error(
      `intervalo de ${totalDays} dias excede o limite de ${MAX_MACRO_DAYS} dias`
    );
  }

  return { days, from, to, dryRun, save };
}

export function buildMacroAsOfRange(options: ComputeMacroOptions, now: Date = new Date()): MacroDateRange {
  const to = options.to ?? yesterdayUtc(now);
  const from = options.from ?? addDays(to, -(options.days - 1));
  const totalDays = inclusiveDays(from, to);

  if (from > to) {
    throw new Error(`intervalo inválido: ${from} > ${to}`);
  }
  if (totalDays > MAX_MACRO_DAYS) {
    throw new Error(
      `intervalo de ${totalDays} dias excede o limite de ${MAX_MACRO_DAYS} dias`
    );
  }

  const asOfs: string[] = [];
  for (let index = 0; index < totalDays; index++) {
    asOfs.push(addDays(from, index));
  }

  return { from, to, asOfs };
}

export function macroLoadFrom(from: string): string {
  const date = parseIsoDate(from);
  return isoDate(
    new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth() - MACRO_LOAD_LOOKBACK_MONTHS,
        1
      )
    )
  );
}

export async function loadMacroObservationRows(
  client: Pick<PrismaClient, 'macroObservation'>,
  from: string,
  to: string,
  seriesIds: readonly string[] = MACRO_INDICATOR_SERIES_IDS
): Promise<MacroLoadResult> {
  const loadFrom = parseIsoDate(macroLoadFrom(from));
  const rangeEnd = parseIsoDate(to);
  const maxCutoff = macroKnownCutoff(to);
  const rows: MacroObservationRowInput[] = [];
  const perSeries: Record<string, number> = {};

  for (const seriesId of seriesIds) {
    const seriesRows = await client.macroObservation.findMany({
      where: {
        seriesId,
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

    rows.push(...seriesRows);
    perSeries[seriesId] = seriesRows.length;
  }

  return { rows, queries: seriesIds.length, perSeries };
}

function earliestDate(dates: readonly Date[]): Date | null {
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function latestDate(dates: readonly Date[]): Date | null {
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function outputToRow(output: MacroIndicatorOutput, asOf: string, computedAt: Date): MacroSnapshotRow {
  const { indicator, result } = output;
  const referenceDates = result.evidence.references.map(
    (reference) => parseIsoDate(reference.refDate)
  );

  return {
    indicator,
    scope: MACRO_SCOPE,
    asOf: parseIsoDate(asOf),
    status: result.status,
    value: result.value,
    unit: MACRO_UNITS[indicator] ?? 'PERCENT',
    inputCount: result.evidence.references.length,
    fromDate: earliestDate(referenceDates),
    toDate: latestDate(referenceDates),
    reason: result.reason,
    formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
    computedAt,
  };
}

export function buildMacroSnapshotRows(
  observations: readonly MacroObservationRowInput[],
  asOfs: readonly string[],
  computedAt: Date = new Date(),
  seriesIds: readonly string[] = MACRO_INDICATOR_SERIES_IDS
): MacroRowsResult {
  const rows: MacroSnapshotRow[] = [];
  const statusCounts: Record<string, number> = {
    ok: 0,
    insufficient_history: 0,
    unavailable: 0,
    stale: 0,
  };

  for (const asOf of asOfs) {
    const series: MacroSeriesMap = readMacroObservationsFromRows(
      observations,
      asOf,
      seriesIds
    );

    for (const output of computeMacroIndicators(series, asOf)) {
      rows.push(outputToRow(output, asOf, computedAt));
      statusCounts[output.result.status] =
        (statusCounts[output.result.status] ?? 0) + 1;
    }
  }

  return { rows, statusCounts };
}

export async function writeMacroRowsInBatches(
  client: Pick<PrismaClient, 'indicatorSnapshot'>,
  rows: readonly MacroSnapshotRow[],
  batchSize: number = MACRO_WRITE_BATCH_SIZE
): Promise<MacroWriteResult> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize inválido: ${batchSize}`);
  }

  let inserted = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    try {
      const result = await client.indicatorSnapshot.createMany({
        data: batch,
        skipDuplicates: true,
      });
      inserted += result.count;
    } catch (error) {
      const first = batch[0];
      const last = batch[batch.length - 1];
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[WRITE] lote ${start}..${start + batch.length - 1} falhou ` +
          `(${isoDate(first.asOf)}..${isoDate(last.asOf)}): ${detail.slice(0, 200)}; ` +
          'lotes anteriores já gravados, repetir é seguro (skipDuplicates)'
      );
      throw error;
    }
  }

  return { inserted, duplicated: rows.length - inserted };
}

function formatValue(value: Decimal | null): string {
  return value === null ? 'null' : value.toString();
}

function formatRow(row: MacroSnapshotRow): string {
  return (
    `[ROW] ${isoDate(row.asOf)} | ${row.indicator} | ${row.status} ` +
    `| value=${formatValue(row.value)} | reason=${row.reason ?? '-'}`
  );
}

function requireRemoteAllow(): void {
  const url = process.env.TERMINAL_DATABASE_URL;
  if (url === undefined) return;

  try {
    const host = new URL(url).hostname;
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
    if (!isLocal && process.env.TERMINAL_ALLOW_REMOTE !== '1') {
      console.error(
        '[ABORT] compute:macro-indicators exige TERMINAL_ALLOW_REMOTE=1 para banco remoto'
      );
      process.exit(1);
    }
  } catch {
    // checkEnvironment valida a URL.
  }
}

async function main(): Promise<void> {
  let options: ComputeMacroOptions;

  try {
    options = parseComputeMacroArgs(process.argv.slice(2));
  } catch (error) {
    console.error('[ABORT]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  requireRemoteAllow();

  const { prisma } = await import('../db');

  try {
    const now = new Date();
    const range = buildMacroAsOfRange(options, now);

    const loaded = await loadMacroObservationRows(prisma as PrismaClient, range.from, range.to);
    console.log(
      `[READ] series=${MACRO_INDICATOR_SERIES_IDS.length} queries=${loaded.queries} ` +
        `observacoes=${loaded.rows.length} intervalo=${range.from}..${range.to} ` +
        `carga_desde=${macroLoadFrom(range.from)}`
    );

    const computed = buildMacroSnapshotRows(loaded.rows, range.asOfs, now);
    console.log(
      `[CALC] dias=${range.asOfs.length} linhas=${computed.rows.length} ` +
        `ok=${computed.statusCounts.ok ?? 0} ` +
        `insufficient_history=${computed.statusCounts.insufficient_history ?? 0} ` +
        `unavailable=${computed.statusCounts.unavailable ?? 0} ` +
        `stale=${computed.statusCounts.stale ?? 0}`
    );
    console.log(
      '[INFO] IndicatorSnapshot não tem coluna dedicada de evidência; ' +
        'usando inputCount/fromDate/toDate, como os indicadores atuais. ' +
        'A reason é preservada do catálogo macro.'
    );

    const writes = options.save && !options.dryRun;

    if (!writes) {
      for (const row of computed.rows) {
        console.log(formatRow(row));
      }
    }

    let writeResult: MacroWriteResult = { inserted: 0, duplicated: 0 };

    if (writes) {
      writeResult = await writeMacroRowsInBatches(prisma as PrismaClient, computed.rows);
      console.log(
        `[SAVE] formulaVersion=${MACRO_INDICATOR_FORMULA_VERSION} ` +
          `inseridas=${writeResult.inserted} ` +
          `ignoradas_por_duplicidade=${writeResult.duplicated}`
      );
    } else {
      const reason = options.dryRun ? '--dry-run' : 'sem --save';
      console.log(`[SAVE] não executado (${reason}); linhas_gravadas=0`);
    }

    console.log(
      `[RESUMO] series=${MACRO_INDICATOR_SERIES_IDS.length} queries=${loaded.queries} ` +
        `observacoes=${loaded.rows.length} dias=${range.asOfs.length} ` +
        `linhas=${computed.rows.length} ` +
        `ok=${computed.statusCounts.ok ?? 0} ` +
        `insufficient_history=${computed.statusCounts.insufficient_history ?? 0} ` +
        `unavailable=${computed.statusCounts.unavailable ?? 0} ` +
        `stale=${computed.statusCounts.stale ?? 0} ` +
        `linhas_gravadas=${writeResult.inserted}`
    );
  } catch (error) {
    console.error('[FATAL]', error instanceof Error ? error.message : String(error).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
