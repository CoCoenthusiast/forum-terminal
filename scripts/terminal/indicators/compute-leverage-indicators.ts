#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '../generated/db/client';
import { checkEnvironment } from '../config';
import { Decimal } from '../prisma-types';
import {
  LEVERAGE_COINS,
  LEVERAGE_FORMULA_VERSION,
  LEVERAGE_METRICS,
  LEVERAGE_SCOPE_PREFIX,
  LEVERAGE_SCOPES,
  computeLeverageIndicators,
  type LeverageCoin,
  type LeverageIndicatorOutput,
} from './leverage-catalog';
import {
  aggregateLeverageHourly,
  leverageKnownCutoff,
  type LeverageHourlyData,
  type LeverageObservation,
} from './leverage-formulas';

export const DEFAULT_LEVERAGE_DAYS = 3;
export const MAX_LEVERAGE_DAYS = 370;
export const LEVERAGE_LOAD_LOOKBACK_DAYS = 8;
export const LEVERAGE_WRITE_BATCH_SIZE = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ComputeLeverageOptions {
  days: number;
  from: string | null;
  to: string | null;
  dryRun: boolean;
  save: boolean;
}

export interface LeverageDateRange {
  from: string;
  to: string;
  asOfs: string[];
  ignored: string[];
}

export interface LeverageSnapshotRow {
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

export interface LeverageLoadResult {
  rowsByScope: Record<string, LeverageObservation[]>;
  queries: number;
  observations: number;
  perScopeMetric: Record<string, number>;
}

export interface LeverageRowsResult {
  rows: LeverageSnapshotRow[];
  statusCounts: Record<string, number>;
}

export interface LeverageWriteResult {
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

export function parseComputeLeverageArgs(
  argv: readonly string[],
  now: Date = new Date()
): ComputeLeverageOptions {
  let days = DEFAULT_LEVERAGE_DAYS;
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
  if (totalDays > MAX_LEVERAGE_DAYS) {
    throw new Error(
      `intervalo de ${totalDays} dias excede o limite de ${MAX_LEVERAGE_DAYS} dias`
    );
  }

  return { days, from, to, dryRun, save };
}

export function buildLeverageAsOfRange(
  options: ComputeLeverageOptions,
  now: Date = new Date()
): LeverageDateRange {
  const requestedTo = options.to ?? yesterdayUtc(now);
  const requestedFrom = options.from ?? addDays(requestedTo, -(options.days - 1));
  const yesterday = yesterdayUtc(now);
  const firstIgnored = addDays(yesterday, 1);
  const ignored: string[] = [];

  if (requestedTo >= firstIgnored) {
    const ignoredFrom = requestedFrom > firstIgnored ? requestedFrom : firstIgnored;
    for (let day = ignoredFrom; day <= requestedTo; day = addDays(day, 1)) {
      ignored.push(day);
    }
  }

  const to = requestedTo > yesterday ? yesterday : requestedTo;
  const from = requestedFrom;

  if (from > to) {
    throw new Error(`intervalo não contém dias concluídos (ontem UTC=${yesterday})`);
  }

  const totalDays = inclusiveDays(from, to);
  if (totalDays > MAX_LEVERAGE_DAYS) {
    throw new Error(
      `intervalo de ${totalDays} dias excede o limite de ${MAX_LEVERAGE_DAYS} dias`
    );
  }

  const asOfs: string[] = [];
  for (let index = 0; index < totalDays; index++) {
    asOfs.push(addDays(from, index));
  }

  return { from, to, asOfs, ignored };
}

export function leverageLoadFrom(from: string): string {
  return addDays(from, -LEVERAGE_LOAD_LOOKBACK_DAYS);
}

export async function loadLeverageObservationRows(
  client: Pick<PrismaClient, 'metricSnapshot'>,
  from: string,
  to: string
): Promise<LeverageLoadResult> {
  const loadFrom = parseIsoDate(leverageLoadFrom(from));
  const endExclusive = parseIsoDate(addDays(to, 1));
  const maxCutoff = leverageKnownCutoff(to);
  const rowsByScope: Record<string, LeverageObservation[]> = {};
  const perScopeMetric: Record<string, number> = {};
  let queries = 0;
  let observations = 0;

  for (const scope of LEVERAGE_SCOPES) {
    rowsByScope[scope] = [];
  }

  for (const scope of LEVERAGE_SCOPES) {
    for (const metric of LEVERAGE_METRICS) {
      const rows = await client.metricSnapshot.findMany({
        where: {
          scope,
          metric,
          bucketTs: { gte: loadFrom, lt: endExclusive },
          collectedAt: { lt: maxCutoff },
        },
        select: {
          metric: true,
          bucketTs: true,
          collectedAt: true,
          value: true,
        },
        orderBy: [{ bucketTs: 'asc' }, { collectedAt: 'asc' }],
      });

      queries++;
      observations += rows.length;
      perScopeMetric[`${scope}|${metric}`] = rows.length;
      rowsByScope[scope].push(...rows);
    }
  }

  return { rowsByScope, queries, observations, perScopeMetric };
}

function outputToRow(
  output: LeverageIndicatorOutput,
  asOf: string,
  computedAt: Date
): LeverageSnapshotRow {
  return {
    indicator: output.indicator,
    scope: output.scope,
    asOf: parseIsoDate(asOf),
    status: output.result.status,
    value: output.result.value,
    unit: output.unit,
    inputCount: output.result.inputCount,
    fromDate: output.result.fromDate,
    toDate: output.result.toDate,
    reason: output.result.reason,
    formulaVersion: LEVERAGE_FORMULA_VERSION,
    computedAt,
  };
}

export function buildLeverageSnapshotRows(
  rowsByScope: Readonly<Record<string, readonly LeverageObservation[]>>,
  asOfs: readonly string[],
  computedAt: Date = new Date()
): LeverageRowsResult {
  const rows: LeverageSnapshotRow[] = [];
  const statusCounts: Record<string, number> = {
    ok: 0,
    insufficient_history: 0,
    unavailable: 0,
  };

  for (const asOf of asOfs) {
    const dataByCoin = {} as Record<LeverageCoin, LeverageHourlyData>;

    for (const coin of LEVERAGE_COINS) {
      const scope = `${LEVERAGE_SCOPE_PREFIX}${coin}`;
      dataByCoin[coin] = aggregateLeverageHourly(rowsByScope[scope] ?? [], asOf);
    }

    for (const output of computeLeverageIndicators(dataByCoin, asOf)) {
      rows.push(outputToRow(output, asOf, computedAt));
      statusCounts[output.result.status] =
        (statusCounts[output.result.status] ?? 0) + 1;
    }
  }

  return { rows, statusCounts };
}

export async function writeLeverageRowsInBatches(
  client: Pick<PrismaClient, 'indicatorSnapshot'>,
  rows: readonly LeverageSnapshotRow[],
  batchSize: number = LEVERAGE_WRITE_BATCH_SIZE
): Promise<LeverageWriteResult> {
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

function formatRow(row: LeverageSnapshotRow): string {
  return (
    `[ROW] ${isoDate(row.asOf)} | ${row.scope} | ${row.indicator} | ${row.status} ` +
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
        '[ABORT] compute:leverage-indicators exige TERMINAL_ALLOW_REMOTE=1 para banco remoto'
      );
      process.exit(1);
    }
  } catch {
    // checkEnvironment valida a URL.
  }
}

async function main(): Promise<void> {
  let options: ComputeLeverageOptions;

  try {
    options = parseComputeLeverageArgs(process.argv.slice(2));
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
    const range = buildLeverageAsOfRange(options, now);

    for (const day of range.ignored) {
      console.log(`[AVISO] dia ${day} ainda não terminou, ignorado`);
    }

    const loaded = await loadLeverageObservationRows(
      prisma as PrismaClient,
      range.from,
      range.to
    );
    console.log(
      `[READ] scopes=${LEVERAGE_SCOPES.length} metricas=${LEVERAGE_METRICS.length} ` +
        `queries=${loaded.queries} observacoes=${loaded.observations} ` +
        `intervalo=${range.from}..${range.to} carga_desde=${leverageLoadFrom(range.from)}`
    );

    const computed = buildLeverageSnapshotRows(
      loaded.rowsByScope,
      range.asOfs,
      now
    );
    console.log(
      `[CALC] dias=${range.asOfs.length} linhas=${computed.rows.length} ` +
        `ok=${computed.statusCounts.ok ?? 0} ` +
        `insufficient_history=${computed.statusCounts.insufficient_history ?? 0} ` +
        `unavailable=${computed.statusCounts.unavailable ?? 0}`
    );
    console.log(
      '[INFO] IndicatorSnapshot não tem coluna dedicada de evidência; ' +
        'usando inputCount/fromDate/toDate, como os indicadores atuais. ' +
        'A reason é preservada do catálogo leverage.'
    );

    const writes = options.save && !options.dryRun;

    if (!writes) {
      for (const row of computed.rows) {
        console.log(formatRow(row));
      }
    }

    let writeResult: LeverageWriteResult = { inserted: 0, duplicated: 0 };

    if (writes) {
      writeResult = await writeLeverageRowsInBatches(
        prisma as PrismaClient,
        computed.rows
      );
      console.log(
        `[SAVE] formulaVersion=${LEVERAGE_FORMULA_VERSION} ` +
          `inseridas=${writeResult.inserted} ` +
          `ignoradas_por_duplicidade=${writeResult.duplicated}`
      );
    } else {
      const reason = options.dryRun ? '--dry-run' : 'sem --save';
      console.log(`[SAVE] não executado (${reason}); linhas_gravadas=0`);
    }

    console.log(
      `[RESUMO] scopes=${LEVERAGE_SCOPES.length} metricas=${LEVERAGE_METRICS.length} ` +
        `queries=${loaded.queries} observacoes=${loaded.observations} ` +
        `dias=${range.asOfs.length} linhas=${computed.rows.length} ` +
        `ok=${computed.statusCounts.ok ?? 0} ` +
        `insufficient_history=${computed.statusCounts.insufficient_history ?? 0} ` +
        `unavailable=${computed.statusCounts.unavailable ?? 0} ` +
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
