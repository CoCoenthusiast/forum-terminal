#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { checkEnvironment } from '../config';
import type { PrismaClient } from '../generated/db/client';
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

async function main(): Promise<void> {
  const resolved = resolveAsOf(new Date(), process.argv);
  if (resolved.error !== null) {
    console.error(`[ABORT] ${resolved.error}`);
    process.exit(1);
  }
  const asOf = resolved.asOf;

  checkEnvironment();

  const { prisma } = await import('../db');

  try {
    const { from, to } = buildWindow(asOf, READ_WINDOW_DAYS);
    const rows = await loadIndicatorRows(prisma, from, to);
    const input = buildMarketStateInput(rows, asOf);
    const state = computeMarketState(input);

    console.log(JSON.stringify(state, null, 2));
    for (const line of formatShortSummary(state)) console.log(line);
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
