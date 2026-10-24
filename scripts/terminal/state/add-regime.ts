#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { checkEnvironment, STATE_VERSION } from '../config';
import type { Prisma, PrismaClient } from '../generated/db/client';
import { SAVE_TX_MAX_WAIT_MS, SAVE_TX_TIMEOUT_MS } from './compute-state';
import type { MarketState } from './market-state';
import { deriveRegime, type MarketStateWithRegime } from './regime';

export const ADD_REGIME_BATCH_SIZE = 100;

const REQUIRED_CLASSIFICATIONS = [
  ['sol_trend', 'classification'],
  ['sol_relative_strength', 'classification'],
  ['spot', 'classification'],
  ['onchain_liquidity', 'classification'],
  ['launchpads', 'classification'],
] as const;

export interface MarketStateSourceRow {
  id: string;
  asOf: Date;
  computeMode: string;
  payload: unknown;
}

export interface RegimeUpdate {
  id: string;
  asOf: Date;
  computeMode: string;
  payload: MarketStateWithRegime;
}

export interface SkippedRow {
  id: string;
  asOf: Date;
  computeMode: string;
  reason: string;
}

export interface RegimePlan {
  updates: RegimeUpdate[];
  skipped: SkippedRow[];
  alreadyWithRegime: number;
}

export interface ModeSummary {
  computeMode: string;
  count: number;
  firstAsOf: string;
  lastAsOf: string;
}

export function parseArgs(argv: readonly string[]): { save: boolean } {
  return { save: argv.includes('--save') };
}

export function hasRegime(payload: unknown): boolean {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.prototype.hasOwnProperty.call(payload, 'regime');
}

export function validateClassificationPayload(
  payload: unknown
): { ok: true; state: MarketState } | { ok: false; reason: string } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload não é objeto' };
  }

  const record = payload as Record<string, unknown>;
  for (const [parent, child] of REQUIRED_CLASSIFICATIONS) {
    const nested = record[parent];
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) {
      return { ok: false, reason: `payload sem ${parent}.${child}` };
    }
    const value = (nested as Record<string, unknown>)[child];
    if (value === undefined) {
      return { ok: false, reason: `payload sem ${parent}.${child}` };
    }
    if (typeof value !== 'string') {
      return { ok: false, reason: `${parent}.${child} não é string` };
    }
  }

  return { ok: true, state: payload as MarketState };
}

export function planRegimeUpdates(rows: readonly MarketStateSourceRow[]): RegimePlan {
  const updates: RegimeUpdate[] = [];
  const skipped: SkippedRow[] = [];
  let alreadyWithRegime = 0;

  for (const row of rows) {
    if (hasRegime(row.payload)) {
      alreadyWithRegime++;
      continue;
    }

    const validation = validateClassificationPayload(row.payload);
    if (!validation.ok) {
      skipped.push({
        id: row.id,
        asOf: row.asOf,
        computeMode: row.computeMode,
        reason: validation.reason,
      });
      continue;
    }

    updates.push({
      id: row.id,
      asOf: row.asOf,
      computeMode: row.computeMode,
      payload: {
        ...(row.payload as Record<string, unknown>),
        regime: deriveRegime(validation.state),
      } as MarketStateWithRegime,
    });
  }

  return { updates, skipped, alreadyWithRegime };
}

export function toRegimeUpdateArgs(update: RegimeUpdate): {
  where: { id: string };
  data: { payload: Prisma.InputJsonValue };
} {
  return {
    where: { id: update.id },
    data: { payload: update.payload as unknown as Prisma.InputJsonValue },
  };
}

export async function applyRegimeUpdates(
  prisma: PrismaClient,
  updates: readonly RegimeUpdate[]
): Promise<number> {
  let written = 0;

  for (let i = 0; i < updates.length; i += ADD_REGIME_BATCH_SIZE) {
    const batch = updates.slice(i, i + ADD_REGIME_BATCH_SIZE);
    await prisma.$transaction(
      async (tx) => {
        for (const update of batch) {
          await tx.marketState.update(toRegimeUpdateArgs(update));
        }
      },
      { timeout: SAVE_TX_TIMEOUT_MS, maxWait: SAVE_TX_MAX_WAIT_MS }
    );
    written += batch.length;
  }

  return written;
}

export function summarizeByMode(updates: readonly RegimeUpdate[]): ModeSummary[] {
  const byMode = new Map<string, { count: number; first: Date; last: Date }>();

  for (const update of updates) {
    const current = byMode.get(update.computeMode);
    if (current === undefined) {
      byMode.set(update.computeMode, { count: 1, first: update.asOf, last: update.asOf });
      continue;
    }
    current.count++;
    if (update.asOf < current.first) current.first = update.asOf;
    if (update.asOf > current.last) current.last = update.asOf;
  }

  return [...byMode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([computeMode, value]) => ({
      computeMode,
      count: value.count,
      firstAsOf: value.first.toISOString().slice(0, 10),
      lastAsOf: value.last.toISOString().slice(0, 10),
    }));
}

export function summarizeSkipReasons(skipped: readonly SkippedRow[]): string {
  const counts = new Map<string, number>();
  for (const row of skipped) {
    counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([reason, count]) => `${reason}=${count}`)
    .join('; ');
}

async function main(): Promise<void> {
  const { save } = parseArgs(process.argv.slice(2));
  checkEnvironment();

  const { prisma } = await import('../db');

  try {
    const rows = await prisma.marketState.findMany({
      where: { stateVersion: STATE_VERSION },
      select: { id: true, asOf: true, computeMode: true, payload: true },
      orderBy: { asOf: 'asc' },
    });

    const plan = planRegimeUpdates(rows);
    const read = plan.updates.length + plan.skipped.length;

    if (!save) {
      console.log(
        `[ADD-REGIME] lidas=${read} seriam_atualizadas=${plan.updates.length} puladas=${plan.skipped.length}`
      );
      for (const summary of summarizeByMode(plan.updates)) {
        console.log(
          `[ADD-REGIME] computeMode=${summary.computeMode}: seriam_atualizadas=${summary.count} primeira=${summary.firstAsOf} ultima=${summary.lastAsOf}`
        );
      }
      if (plan.skipped.length > 0) {
        console.log(`[ADD-REGIME] puladas_por_motivo: ${summarizeSkipReasons(plan.skipped)}`);
      }
      console.log('[ADD-REGIME] dry-run: nada foi gravado; use --save para gravar');
      return;
    }

    const written = await applyRegimeUpdates(prisma, plan.updates);
    console.log(
      `[ADD-REGIME] lidas=${read} atualizadas=${written} puladas=${plan.skipped.length}`
    );
    for (const summary of summarizeByMode(plan.updates)) {
      console.log(
        `[ADD-REGIME] computeMode=${summary.computeMode}: atualizadas=${summary.count} primeira=${summary.firstAsOf} ultima=${summary.lastAsOf}`
      );
    }
    if (plan.skipped.length > 0) {
      console.log(`[ADD-REGIME] puladas_por_motivo: ${summarizeSkipReasons(plan.skipped)}`);
    }
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
