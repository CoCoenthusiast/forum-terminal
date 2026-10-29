#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '../generated/db/client';
import { checkEnvironment } from '../config';
import { Decimal } from '../prisma-types';
import {
  COINALYZE_LEVERAGE_COINS,
  COINALYZE_LEVERAGE_INDICATORS,
  COINALYZE_LEVERAGE_FORMULA_VERSION,
  computeCoinalyzeLeverageIndicators,
  type CoinalyzeLeverageCoin,
  type CoinalyzeLeverageIndicatorDefinition,
  type CoinalyzeLeverageSeriesMap,
} from './coinalyze-leverage-catalog';
import {
  COINALYZE_LEVERAGE_SERIES_IDS,
  coinalyzeLoadFrom,
  loadCoinalyzeObservationRows,
  readCoinalyzeObservationsFromRows,
  type CoinalyzeObservationRowInput,
} from './coinalyze-leverage-reader';

export const DEFAULT_COINALYZE_LEVERAGE_DAYS = 5;
export const COINALYZE_LEVERAGE_WRITE_BATCH_SIZE = 500;
// IndicatorSnapshot.value é numeric(30,12): alinhar ao arredondamento do Postgres.
export const COINALYZE_LEVERAGE_VALUE_SCALE = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ComputeCoinalyzeLeverageOptions {
  days: number;
  from: string | null;
  to: string | null;
  dryRun: boolean;
  save: boolean;
}

export interface CoinalyzeLeverageDateRange {
  from: string;
  to: string;
  asOfs: string[];
}

export interface CoinalyzeLeverageSnapshotRow {
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

export interface CoinalyzeLeverageRowsResult {
  rows: CoinalyzeLeverageSnapshotRow[];
  nullCount: number;
  firstCompleteAsOf: string | null;
}

export interface CoinalyzeLeverageWriteResult {
  created: number;
  updated: number;
  equal: number;
  absent: number;
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
  return isoDate(new Date(parseIsoDate(value).getTime() + days * DAY_MS));
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

export function parseComputeCoinalyzeLeverageArgs(
  argv: readonly string[],
  now: Date = new Date()
): ComputeCoinalyzeLeverageOptions {
  let days = DEFAULT_COINALYZE_LEVERAGE_DAYS;
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

  return { days, from, to, dryRun, save };
}

export function buildCoinalyzeLeverageAsOfRange(
  options: ComputeCoinalyzeLeverageOptions,
  now: Date = new Date()
): CoinalyzeLeverageDateRange {
  const to = options.to ?? yesterdayUtc(now);
  const from = options.from ?? addDays(to, -(options.days - 1));
  const totalDays = inclusiveDays(from, to);

  if (from > to) {
    throw new Error(`intervalo inválido: ${from} > ${to}`);
  }

  const asOfs: string[] = [];
  for (let index = 0; index < totalDays; index++) {
    asOfs.push(addDays(from, index));
  }

  return { from, to, asOfs };
}

function definitionKey(
  indicator: string,
  coin: CoinalyzeLeverageCoin
): string {
  return `${coin}:${indicator}`;
}

function evidenceFor(
  definition: CoinalyzeLeverageIndicatorDefinition,
  series: CoinalyzeLeverageSeriesMap,
  asOf: string
): { inputCount: number; fromDate: Date | null; toDate: Date | null } {
  const endMs = parseIsoDate(asOf).getTime();
  const startMs = endMs - 7 * DAY_MS;
  let inputCount = 0;
  let fromMs: number | null = null;
  let toMs: number | null = null;

  for (const seriesId of definition.seriesIds) {
    for (const point of series[seriesId] ?? []) {
      const refDate =
        point.refDate instanceof Date ? point.refDate : new Date(point.refDate);
      const refDateMs = refDate.getTime();
      if (Number.isNaN(refDateMs)) continue;
      if (refDateMs < startMs || refDateMs > endMs) continue;

      inputCount++;
      if (fromMs === null || refDateMs < fromMs) fromMs = refDateMs;
      if (toMs === null || refDateMs > toMs) toMs = refDateMs;
    }
  }

  return {
    inputCount,
    fromDate: fromMs === null ? null : new Date(fromMs),
    toDate: toMs === null ? null : new Date(toMs),
  };
}

export function buildCoinalyzeLeverageSnapshotRows(
  observations: readonly CoinalyzeObservationRowInput[],
  asOfs: readonly string[],
  computedAt: Date = new Date(),
  seriesIds: readonly string[] = COINALYZE_LEVERAGE_SERIES_IDS
): CoinalyzeLeverageRowsResult {
  const rows: CoinalyzeLeverageSnapshotRow[] = [];
  const definitions = new Map(
    COINALYZE_LEVERAGE_INDICATORS.map((definition) => [
      definitionKey(definition.indicator, definition.coin),
      definition,
    ])
  );
  const completeByAsOf = new Map<string, boolean>();

  for (const asOf of asOfs) {
    const series = readCoinalyzeObservationsFromRows(observations, asOf, seriesIds);
    const outputs = computeCoinalyzeLeverageIndicators(
      {
        SOL: series,
        BTC: series,
        ETH: series,
      },
      asOf
    );
    let complete = true;

    for (const output of outputs) {
      const definition = definitions.get(
        definitionKey(output.indicator, output.coin)
      );
      const evidence =
        definition === undefined
          ? { inputCount: 0, fromDate: null, toDate: null }
          : evidenceFor(definition, series, asOf);

      if (output.value === null) complete = false;

      rows.push({
        indicator: output.indicator,
        scope: output.scope,
        asOf: parseIsoDate(asOf),
        status: output.value === null ? 'insufficient_history' : 'ok',
        value: output.value,
        unit: output.unit,
        inputCount: evidence.inputCount,
        fromDate: evidence.fromDate,
        toDate: evidence.toDate,
        reason: output.value === null ? 'sem valor suficiente' : null,
        formulaVersion: output.formulaVersion,
        computedAt,
      });
    }

    completeByAsOf.set(asOf, complete);
  }

  const nullCount = rows.filter((row) => row.value === null).length;
  const firstCompleteAsOf =
    asOfs.find((asOf) => completeByAsOf.get(asOf) === true) ?? null;

  return { rows, nullCount, firstCompleteAsOf };
}

function rowKey(row: {
  indicator: string;
  scope: string;
  asOf: Date;
  formulaVersion: string;
}): string {
  return [
    row.indicator,
    row.scope,
    row.asOf.toISOString(),
    row.formulaVersion,
  ].join('\u0000');
}

function sameDate(left: Date | null, right: Date | null): boolean {
  if (left === null || right === null) return left === right;
  return left.getTime() === right.getTime();
}

function roundSnapshotValue(value: Decimal | null): Decimal | null {
  return value === null
    ? null
    : value.toDecimalPlaces(
        COINALYZE_LEVERAGE_VALUE_SCALE,
        Decimal.ROUND_HALF_UP
      );
}

function sameValue(left: Decimal | null, right: Decimal | null): boolean {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

function sameSnapshot(
  existing: {
    status: string;
    value: Decimal | null;
    unit: string;
    inputCount: number;
    fromDate: Date | null;
    toDate: Date | null;
    reason: string | null;
  },
  row: CoinalyzeLeverageSnapshotRow
): boolean {
  return (
    existing.status === row.status &&
    sameValue(existing.value, row.value) &&
    existing.unit === row.unit &&
    existing.inputCount === row.inputCount &&
    sameDate(existing.fromDate, row.fromDate) &&
    sameDate(existing.toDate, row.toDate) &&
    existing.reason === row.reason
  );
}

function snapshotData(row: CoinalyzeLeverageSnapshotRow): {
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
} {
  return {
    indicator: row.indicator,
    scope: row.scope,
    asOf: row.asOf,
    status: row.status,
    value: row.value,
    unit: row.unit,
    inputCount: row.inputCount,
    fromDate: row.fromDate,
    toDate: row.toDate,
    reason: row.reason,
    formulaVersion: row.formulaVersion,
    computedAt: row.computedAt,
  };
}

export async function writeCoinalyzeLeverageRowsInBatches(
  client: Pick<PrismaClient, 'indicatorSnapshot'>,
  rows: readonly CoinalyzeLeverageSnapshotRow[],
  batchSize: number = COINALYZE_LEVERAGE_WRITE_BATCH_SIZE
): Promise<CoinalyzeLeverageWriteResult> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize inválido: ${batchSize}`);
  }

  const normalizedRows = rows.map((row) => ({
    ...row,
    value: roundSnapshotValue(row.value),
  }));
  const writable = normalizedRows.filter((row) => row.value !== null);
  const result: CoinalyzeLeverageWriteResult = {
    created: 0,
    updated: 0,
    equal: 0,
    absent: normalizedRows.length - writable.length,
  };

  for (let start = 0; start < writable.length; start += batchSize) {
    const batch = writable.slice(start, start + batchSize);
    const existingRows = await client.indicatorSnapshot.findMany({
      where: {
        OR: batch.map((row) => ({
          indicator: row.indicator,
          scope: row.scope,
          asOf: row.asOf,
          formulaVersion: row.formulaVersion,
        })),
      },
      select: {
        indicator: true,
        scope: true,
        asOf: true,
        status: true,
        value: true,
        unit: true,
        inputCount: true,
        fromDate: true,
        toDate: true,
        reason: true,
        formulaVersion: true,
      },
    });
    const existingByKey = new Map(
      existingRows.map((row) => [rowKey(row), row])
    );

    for (const row of batch) {
      const existing = existingByKey.get(rowKey(row));
      const data = snapshotData(row);

      if (existing !== undefined && sameSnapshot(existing, row)) {
        result.equal++;
        continue;
      }

      await client.indicatorSnapshot.upsert({
        where: {
          indicator_scope_asOf_formulaVersion: {
            indicator: row.indicator,
            scope: row.scope,
            asOf: row.asOf,
            formulaVersion: row.formulaVersion,
          },
        },
        create: data,
        update: {
          status: data.status,
          value: data.value,
          unit: data.unit,
          inputCount: data.inputCount,
          fromDate: data.fromDate,
          toDate: data.toDate,
          reason: data.reason,
          computedAt: data.computedAt,
        },
      });

      if (existing === undefined) {
        result.created++;
      } else {
        result.updated++;
      }
    }
  }

  return result;
}

function formatValue(value: Decimal | null): string {
  return value === null ? 'null' : value.toString();
}

function printDryRun(
  asOfs: readonly string[],
  rows: readonly CoinalyzeLeverageSnapshotRow[],
  nullCount: number,
  firstCompleteAsOf: string | null
): void {
  for (const asOf of asOfs) {
    const asOfDate = parseIsoDate(asOf);

    for (const coin of COINALYZE_LEVERAGE_COINS) {
      const output = rows.filter(
        (row) =>
          row.asOf.getTime() === asOfDate.getTime() && row.scope === `coinalyze:${coin}`
      );
      const values = output.map(
        (row) => `${row.indicator}=${formatValue(row.value)}`
      );

      console.log(`[ASOF] ${asOf} ${coin} | ${values.join(' ')}`);
    }
  }

  console.log(
    `[RESUMO] asOfs=${asOfs.length} pontos=${rows.length} ` +
      `nulos=${nullCount} primeiro_completo=${firstCompleteAsOf ?? 'null'}`
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
        '[ABORT] compute:coinalyze-leverage exige TERMINAL_ALLOW_REMOTE=1 para banco remoto'
      );
      process.exit(1);
    }
  } catch {
    // checkEnvironment valida a URL.
  }
}

async function main(): Promise<void> {
  let options: ComputeCoinalyzeLeverageOptions;

  try {
    options = parseComputeCoinalyzeLeverageArgs(process.argv.slice(2));
  } catch (error) {
    console.error('[ABORT]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (!options.dryRun && !options.save) {
    console.error('[ABORT] gravação ainda não implementada');
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  requireRemoteAllow();

  const { prisma } = await import('../db');

  try {
    const now = new Date();
    const range = buildCoinalyzeLeverageAsOfRange(options, now);
    const loaded = await loadCoinalyzeObservationRows(
      prisma as PrismaClient,
      range.from,
      range.to
    );

    console.log(
      `[READ] series=${COINALYZE_LEVERAGE_SERIES_IDS.length} queries=${loaded.queries} ` +
        `observacoes=${loaded.rows.length} intervalo=${range.from}..${range.to} ` +
        `carga_desde=${coinalyzeLoadFrom(range.from)}`
    );

    const computed = buildCoinalyzeLeverageSnapshotRows(
      loaded.rows,
      range.asOfs,
      now
    );
    const writes = options.save && !options.dryRun;
    let writeResult: CoinalyzeLeverageWriteResult = {
      created: 0,
      updated: 0,
      equal: 0,
      absent: computed.nullCount,
    };

    if (writes) {
      writeResult = await writeCoinalyzeLeverageRowsInBatches(
        prisma as PrismaClient,
        computed.rows
      );
    } else {
      printDryRun(
        range.asOfs,
        computed.rows,
        computed.nullCount,
        computed.firstCompleteAsOf
      );
    }

    console.log(
      `[SAVE] ${writes ? '' : 'não executado (--dry-run); '}` +
        `criadas=${writeResult.created} atualizadas=${writeResult.updated} ` +
        `iguais=${writeResult.equal} ausentes=${writeResult.absent} ` +
        `formulaVersion=${COINALYZE_LEVERAGE_FORMULA_VERSION}`
    );
  } catch (error) {
    console.error(
      '[FATAL]',
      (error instanceof Error ? error.message : String(error)).slice(0, 300)
    );
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
