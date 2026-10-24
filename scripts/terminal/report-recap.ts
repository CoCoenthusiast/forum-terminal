#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from './generated/db/client';
import { checkEnvironment, STATE_VERSION } from './config';
import { buildRecapDraft } from './state/recap';
import type { MarketStateWithRegime } from './state/regime';

export function parseAsOfArg(argv: readonly string[]): { asOf: string | null; error: string | null } {
  const args = argv.filter((arg) => arg === '--asof' || arg.startsWith('--asof='));
  if (args.length === 0) return { asOf: null, error: null };
  if (args.length > 1) return { asOf: null, error: 'use --asof=YYYY-MM-DD uma única vez' };

  const arg = args[0];
  if (arg === '--asof') return { asOf: null, error: '--asof exige o formato YYYY-MM-DD' };

  const value = arg.slice('--asof='.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { asOf: null, error: `data inválida: ${value}` };
  }

  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    return { asOf: null, error: `data inválida: ${value}` };
  }

  return { asOf: value, error: null };
}

export function hasRegimePayload(payload: unknown): boolean {
  return payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && Object.prototype.hasOwnProperty.call(payload, 'regime');
}

function requireRemoteAllow(): void {
  const url = process.env.TERMINAL_DATABASE_URL;
  if (url === undefined) return;
  try {
    const host = new URL(url).hostname;
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
    if (!isLocal && process.env.TERMINAL_ALLOW_REMOTE !== '1') {
      console.error('[ABORT] recap:draft exige TERMINAL_ALLOW_REMOTE=1 para banco remoto');
      process.exit(1);
    }
  } catch {
    // checkEnvironment já validou a URL
  }
}

async function main(): Promise<void> {
  const { asOf, error } = parseAsOfArg(process.argv.slice(2));
  if (error !== null) {
    console.error(`[RECAP] ${error}`);
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  requireRemoteAllow();

  const { prisma } = await import('./db');

  try {
    const row = await prisma.marketState.findFirst({
      where: {
        stateVersion: STATE_VERSION,
        computeMode: 'live',
        ...(asOf === null ? {} : { asOf: new Date(`${asOf}T00:00:00Z`) }),
      },
      orderBy: { asOf: 'desc' },
      select: { asOf: true, payload: true },
    });

    if (row === null) {
      const target = asOf === null ? 'live mais recente' : `live de ${asOf}`;
      console.error(`[RECAP] nenhuma linha ${target} para stateVersion=${STATE_VERSION}`);
      process.exitCode = 1;
      return;
    }

    if (!hasRegimePayload(row.payload)) {
      const rowAsOf = row.asOf.toISOString().slice(0, 10);
      console.error(
        `[RECAP] payload sem regime em asOf=${rowAsOf} computeMode=live; rode state:add-regime`
      );
      process.exitCode = 1;
      return;
    }

    console.log(buildRecapDraft(row.payload as unknown as MarketStateWithRegime));
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
