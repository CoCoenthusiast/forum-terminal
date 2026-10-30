#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { checkEnvironment } from '../config';
import { parseAsOfArg } from '../report-recap';
import { formatRecap } from './recap-format';
import { readRecapInput } from './recap-reader';

const DAY_MS = 24 * 60 * 60 * 1000;

export function previousUtcDay(now: Date): string {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayMs - DAY_MS).toISOString().slice(0, 10);
}

function requireRemoteAllow(): boolean {
  const url = process.env.TERMINAL_DATABASE_URL;
  if (url === undefined || url === '') return true;

  try {
    const host = new URL(url).hostname;
    if (/^(localhost|127\.0\.0\.1)$/.test(host)) return true;
    return process.env.TERMINAL_ALLOW_REMOTE === '1';
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  const parsed = parseAsOfArg(process.argv.slice(2));
  if (parsed.error !== null) {
    console.error(`[RECAP DRAFT] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const asOf = parsed.asOf ?? previousUtcDay(new Date());

  if (!requireRemoteAllow()) {
    console.error('[ABORT] report:recap-draft exige TERMINAL_ALLOW_REMOTE=1 para banco remoto');
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  const { prisma } = await import('../db');

  try {
    const input = await readRecapInput(prisma, asOf);
    console.log(formatRecap(input));
  } catch (error) {
    console.error(
      '[FATAL]',
      error instanceof Error ? error.message : String(error).slice(0, 300)
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
