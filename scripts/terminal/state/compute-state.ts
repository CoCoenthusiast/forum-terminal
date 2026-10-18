#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { checkEnvironment } from '../config';
import type { Prisma, PrismaClient } from '../generated/db/client';
import { computeMarketState, type MarketState, type MarketStateInput, type StateIndicatorInput } from './market-state';

// Comando de LEITURA: lê o IndicatorSnapshot, monta o MarketStateInput, chama
// computeMarketState e IMPRIME o resultado. Não grava nada no banco.

const DAY_MS = 24 * 60 * 60 * 1000;

// Copiado de indicators/catalog.ts:19 (FORMULA_VERSION = 'v1'). A cópia é local
// porque importar catalog.ts traria @prisma/client/runtime/library (via
// prisma-types.ts) para o módulo puro. Manter em sincronia se o catálogo mudar.
export const INDICATOR_FORMULA_VERSION = 'v1';

// Janela de leitura: últimos 10 dias UTC inclusivos até o asOf. Cobre até o maior
// atraso tolerado (DEX, 4 dias). Fica local porque config.ts não é alterável aqui.
export const READ_WINDOW_DAYS = 10;

// Backfill: máximo de dias por execução, tamanho do lote de upserts, e limites da
// transação interativa (lotes menores + timeout maior por causa do pooler remoto).
export const MAX_BACKFILL_DAYS = 370;
export const SAVE_BATCH_SIZE = 20;
export const SAVE_TX_TIMEOUT_MS = 60000;
export const SAVE_TX_MAX_WAIT_MS = 15000;

// 'live' = estado do dia padrão (ontem UTC, com --save; --asof igual a ontem também é
// 'live'). Qualquer outra gravação (--asof mais antigo ou --from/--to) é 'backfill'.
// O backfill nunca sobrescreve 'live' porque computeMode faz parte da chave única.
export type ComputeMode = 'live' | 'backfill';

export interface IndicatorRowRaw {
  indicator: string;
  scope: string;
  asOf: Date;
  status: string;
  value: unknown; // Decimal | string | number | null
  unit: string;
  fromDate: Date | null;
  toDate: Date | null;
  reason: string | null;
}

function isPlainObject(x: unknown): x is { toString(): string } {
  return typeof x === 'object' && x !== null;
}

export function decimalToNumber(x: unknown): number | null {
  if (x === null || x === undefined) return null;
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string') {
    if (x.trim() === '') return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  if (isPlainObject(x)) {
    const s = x.toString();
    if (s.trim() === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isValidIsoDate(iso: string): boolean {
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isoStartMs(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

// Resolve o asOf de referência: padrão = ontem UTC (último dia fechado); --asof=YYYY-MM-DD
// sobrepõe. Rejeita formato inválido e data posterior a ontem. Devolve { asOf, error }.
export function resolveAsOf(now: Date, argv: readonly string[]): { asOf: string; error: string | null } {
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterdayMs = todayStartMs - DAY_MS;
  const yesterdayIso = new Date(yesterdayMs).toISOString().slice(0, 10);

  const arg = argv.find((a) => a === '--asof' || a.startsWith('--asof='));
  if (arg === undefined) return { asOf: yesterdayIso, error: null };

  if (arg === '--asof') return { asOf: yesterdayIso, error: "'--asof' sem valor" };

  const raw = arg.slice('--asof='.length);
  if (raw === '') return { asOf: yesterdayIso, error: "'--asof=' sem valor" };
  if (!isValidIsoDate(raw)) return { asOf: yesterdayIso, error: `--asof inválido: "${raw}" (use YYYY-MM-DD)` };

  const rawMs = Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10)));
  if (rawMs > yesterdayMs) return { asOf: yesterdayIso, error: `--asof "${raw}" é posterior a ontem UTC (${yesterdayIso})` };

  return { asOf: raw, error: null };
}

// Janela [asOf - (days-1), asOf] em UTC, no início do dia.
export function buildWindow(asOf: string, days: number = READ_WINDOW_DAYS): { from: Date; to: Date } {
  const toMs = Date.UTC(Number(asOf.slice(0, 4)), Number(asOf.slice(5, 7)) - 1, Number(asOf.slice(8, 10)));
  return { from: new Date(toMs - (days - 1) * DAY_MS), to: new Date(toMs) };
}

export function buildMarketStateInput(rows: readonly IndicatorRowRaw[], asOf: string): MarketStateInput {
  const indicators: StateIndicatorInput[] = rows.map((row) => ({
    indicator: row.indicator,
    scope: row.scope,
    asOf: row.asOf.toISOString().slice(0, 10),
    status: row.status,
    value: decimalToNumber(row.value),
    unit: row.unit,
    from: row.fromDate === null ? null : row.fromDate.toISOString().slice(0, 10),
    to: row.toDate === null ? null : row.toDate.toISOString().slice(0, 10),
    reason: row.reason,
  }));
  return { asOf, indicators };
}

export function formatShortSummary(state: MarketState): string[] {
  return [
    '=== RESUMO SOL STATE ===',
    `asOf de referência: ${state.asOf}`,
    `Tendência: ${state.sol_trend.classification}`,
    `Força relativa: ${state.sol_relative_strength.classification}`,
    `Spot: ${state.spot.classification}`,
    `Liquidez onchain: ${state.onchain_liquidity.classification}`,
    `Qualidade dos dados: ${state.data_quality.slotsOk}/${state.data_quality.slotsTotal} (${state.data_quality.score.toFixed(2)})`,
    `asOf mais antigo usado: ${state.data_quality.oldestAsOf ?? 'nenhum'}`,
  ];
}

interface FlagRead {
  present: boolean;
  value: string | null;
  error: string | null;
}

function readFlag(argv: readonly string[], name: string): FlagRead {
  const arg = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (arg === undefined) return { present: false, value: null, error: null };
  if (arg === `--${name}`) return { present: true, value: null, error: `'--${name}' sem valor` };
  const value = arg.slice(name.length + 3);
  if (value === '') return { present: true, value: null, error: `'--${name}=' sem valor` };
  return { present: true, value, error: null };
}

export interface RunArgs {
  mode: 'single' | 'backfill';
  asOf: string | null;
  days: string[] | null;
  save: boolean;
  computeMode: ComputeMode;
  error: string | null;
}

export function buildDayList(fromIso: string, toIso: string): string[] {
  const days: string[] = [];
  const end = isoStartMs(toIso);
  for (let ms = isoStartMs(fromIso); ms <= end; ms += DAY_MS) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

// Valida as flags ANTES de tocar no banco. --asof (um dia) e --from/--to (intervalo)
// são mutuamente exclusivos; --from e --to andam juntos; tudo <= ontem UTC.
export function parseRunArgs(now: Date, argv: readonly string[]): RunArgs {
  const save = argv.includes('--save');
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const yesterdayIso = new Date(todayMs - DAY_MS).toISOString().slice(0, 10);

  const fail = (error: string): RunArgs => ({
    mode: 'single',
    asOf: null,
    days: null,
    save,
    computeMode: 'backfill',
    error,
  });

  const from = readFlag(argv, 'from');
  const to = readFlag(argv, 'to');
  const asof = readFlag(argv, 'asof');

  if (from.error !== null) return fail(from.error);
  if (to.error !== null) return fail(to.error);
  if (asof.error !== null) return fail(asof.error);

  const hasFrom = from.present;
  const hasTo = to.present;
  const hasAsOf = asof.present;

  if (hasAsOf && (hasFrom || hasTo)) return fail('--asof não pode ser usado junto com --from/--to');
  if (hasFrom !== hasTo) return fail('--from e --to precisam ser usados juntos');

  if (!hasFrom && !hasTo) {
    const resolved = resolveAsOf(now, argv);
    if (resolved.error !== null) return fail(resolved.error);
    const computeMode: ComputeMode = resolved.asOf === yesterdayIso ? 'live' : 'backfill';
    return { mode: 'single', asOf: resolved.asOf, days: null, save, computeMode, error: null };
  }

  const fromIso = from.value as string;
  const toIso = to.value as string;
  if (!isValidIsoDate(fromIso)) return fail(`--from inválido: "${fromIso}" (use YYYY-MM-DD)`);
  if (!isValidIsoDate(toIso)) return fail(`--to inválido: "${toIso}" (use YYYY-MM-DD)`);

  const fromMs = isoStartMs(fromIso);
  const toMs = isoStartMs(toIso);
  const yesterdayMs = isoStartMs(yesterdayIso);

  if (fromMs > toMs) return fail(`--from (${fromIso}) é posterior a --to (${toIso})`);
  if (toMs > yesterdayMs) return fail(`--to (${toIso}) é posterior a ontem UTC (${yesterdayIso})`);

  const span = Math.round((toMs - fromMs) / DAY_MS) + 1;
  if (span > MAX_BACKFILL_DAYS) return fail(`intervalo de ${span} dias excede o máximo de ${MAX_BACKFILL_DAYS}`);

  return { mode: 'backfill', asOf: null, days: buildDayList(fromIso, toIso), save, computeMode: 'backfill', error: null };
}

// Calcula o input de cada dia em memória, a partir de UMA leitura só do intervalo.
// Cada dia usa a janela [dia-9, dia], igual ao buildWindow do modo de um dia.
export function buildBackfillInputs(rows: readonly IndicatorRowRaw[], daysIso: readonly string[]): MarketStateInput[] {
  return daysIso.map((day) => {
    const dayMs = isoStartMs(day);
    const fromMs = dayMs - (READ_WINDOW_DAYS - 1) * DAY_MS;
    const slice = rows.filter((row) => {
      const ms = row.asOf.getTime();
      return ms >= fromMs && ms <= dayMs;
    });
    return buildMarketStateInput(slice, day);
  });
}

export interface MarketStateRow {
  asOf: Date;
  stateVersion: string;
  rulesVersion: string;
  computeMode: ComputeMode;
  dataQualityScore: number;
  oldestDataDate: Date | null;
  payload: MarketState;
  computedAt: Date;
}

export function toMarketStateRow(state: MarketState, computeMode: ComputeMode, now: Date): MarketStateRow {
  const oldest = state.data_quality.oldestAsOf;
  return {
    asOf: new Date(isoStartMs(state.asOf)),
    stateVersion: state.stateVersion,
    rulesVersion: state.rulesVersion,
    computeMode,
    dataQualityScore: state.data_quality.score,
    oldestDataDate: oldest === null ? null : new Date(isoStartMs(oldest)),
    payload: state,
    computedAt: now,
  };
}

// Dias sem nenhum sinal utilizável (score 0) não são gravados: não dizem nada e
// seriam reescritos assim que o dado chegasse.
export function shouldPersist(state: MarketState): boolean {
  return state.data_quality.score > 0;
}

// Única função que fala com o banco. Recebe o client por parâmetro (testável no
// banco local). formulaVersion é parâmetro para o teste semear uma versão exclusiva
// sem tocar em linhas reais.
export async function loadIndicatorRows(
  prisma: PrismaClient,
  from: Date,
  to: Date,
  formulaVersion: string = INDICATOR_FORMULA_VERSION
): Promise<IndicatorRowRaw[]> {
  const rows = await prisma.indicatorSnapshot.findMany({
    where: { asOf: { gte: from, lte: to }, formulaVersion },
    orderBy: { asOf: 'desc' },
    select: {
      indicator: true,
      scope: true,
      asOf: true,
      status: true,
      value: true,
      unit: true,
      fromDate: true,
      toDate: true,
      reason: true,
    },
  });
  return rows;
}

// Grava em lotes de SAVE_BATCH_SIZE upserts. Cada lote roda numa transação
// INTERATIVA (callback, não array) com timeout próprio, porque o pooler remoto
// derruba transações antigas. O upsert usa a chave única
// (asOf, stateVersion, rulesVersion, computeMode), então rodar de novo no mesmo dia
// reescreve a mesma linha (idempotente) e um backfill não toca nas linhas 'live'.
export async function saveMarketStates(
  prisma: PrismaClient,
  rows: readonly MarketStateRow[],
  batchSize: number = SAVE_BATCH_SIZE
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    try {
      await prisma.$transaction(
        async (tx) => {
          for (const row of batch) {
            await tx.marketState.upsert({
              where: {
                asOf_stateVersion_rulesVersion_computeMode: {
                  asOf: row.asOf,
                  stateVersion: row.stateVersion,
                  rulesVersion: row.rulesVersion,
                  computeMode: row.computeMode,
                },
              },
              create: {
                asOf: row.asOf,
                stateVersion: row.stateVersion,
                rulesVersion: row.rulesVersion,
                computeMode: row.computeMode,
                dataQualityScore: row.dataQualityScore,
                oldestDataDate: row.oldestDataDate,
                payload: row.payload as unknown as Prisma.InputJsonValue,
                computedAt: row.computedAt,
              },
              update: {
                dataQualityScore: row.dataQualityScore,
                oldestDataDate: row.oldestDataDate,
                payload: row.payload as unknown as Prisma.InputJsonValue,
                computedAt: row.computedAt,
              },
            });
          }
        },
        { timeout: SAVE_TX_TIMEOUT_MS, maxWait: SAVE_TX_MAX_WAIT_MS }
      );
    } catch (e) {
      const first = batch[0]?.asOf.toISOString().slice(0, 10) ?? '?';
      const last = batch[batch.length - 1]?.asOf.toISOString().slice(0, 10) ?? '?';
      const detail = e instanceof Error ? e.message : String(e);
      console.error(`[SAVE] lote ${first}..${last} falhou: ${detail.slice(0, 200)} — rodar de novo é seguro (idempotente)`);
      throw e;
    }
    written += batch.length;
  }
  return written;
}

function printState(state: MarketState): void {
  console.log(JSON.stringify(state, null, 2));
  for (const line of formatShortSummary(state)) console.log(line);
}

async function main(): Promise<void> {
  const now = new Date();
  const args = parseRunArgs(now, process.argv);
  if (args.error !== null) {
    console.error(`[ABORT] ${args.error}`);
    process.exit(1);
  }

  checkEnvironment();

  const { prisma } = await import('../db');

  try {
    if (args.mode === 'single') {
      const asOf = args.asOf as string;
      const { from, to } = buildWindow(asOf, READ_WINDOW_DAYS);
      const rows = await loadIndicatorRows(prisma, from, to);
      const state = computeMarketState(buildMarketStateInput(rows, asOf));
      printState(state);

      if (!args.save) {
        console.log('[SAVE] desativado (use --save para gravar)');
      } else if (!shouldPersist(state)) {
        console.log('[SAVE] pulado: score 0 (nenhum sinal utilizável)');
      } else {
        const written = await saveMarketStates(prisma, [toMarketStateRow(state, args.computeMode, now)]);
        console.log(
          `[SAVE] gravados=${written} asOf=${asOf} computeMode=${args.computeMode} stateVersion=${state.stateVersion} rulesVersion=${state.rulesVersion}`
        );
      }
      return;
    }

    const days = args.days as string[];
    const fromIso = days[0];
    const toIso = days[days.length - 1];
    const loadFrom = buildWindow(fromIso, READ_WINDOW_DAYS).from;
    const loadTo = new Date(isoStartMs(toIso));
    const rows = await loadIndicatorRows(prisma, loadFrom, loadTo);
    const states = buildBackfillInputs(rows, days).map((input) => computeMarketState(input));
    const skipped = states.filter((s) => !shouldPersist(s)).length;
    const toWrite = states.filter(shouldPersist).map((s) => toMarketStateRow(s, 'backfill', now));

    if (!args.save) {
      console.log(
        `[BACKFILL] dias=${days.length}, pulados_vazios=${skipped}, seriam_gravados=${toWrite.length} (nada escrito; use --save)`
      );
      return;
    }

    const written = await saveMarketStates(prisma, toWrite);
    console.log(`[BACKFILL] dias=${days.length}, pulados_vazios=${skipped}, gravados=${written}`);
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
