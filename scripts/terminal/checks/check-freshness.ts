#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '../generated/db/client';
import {
  LAUNCHPAD_SLUGS,
  STATE_VERSION,
  buildProtocolScope,
  checkEnvironment,
} from '../config';
import { PRICE_ASSET_IDS } from '../recap/recap-reader';
import {
  evaluateFreshness,
  exitCodeFor,
  resolveReferenceDate,
  worstStatus,
  type FreshnessInput,
} from './freshness-rules';

const RETURN_FORMULA_VERSION = 'v1';
const MACRO_FORMULA_VERSION = 'macro_v1';
const COINALYZE_SCOPE = 'coinalyze:SOL';
const MACRO_SCOPE = 'macro:us';

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

async function latestToDate(
  client: Pick<PrismaClient, 'indicatorSnapshot'>,
  indicator: string,
  scope: string,
  asOf: Date
): Promise<Date | null> {
  const row = await client.indicatorSnapshot.findFirst({
    where: {
      indicator,
      scope,
      formulaVersion: MACRO_FORMULA_VERSION,
      asOf: { lte: asOf },
      toDate: { not: null },
    },
    orderBy: { toDate: 'desc' },
    select: { toDate: true },
  });
  return row?.toDate ?? null;
}

async function readFreshnessInput(
  client: Pick<
    PrismaClient,
    | 'marketSnapshot'
    | 'indicatorSnapshot'
    | 'marketState'
    | 'dailyClose'
    | 'collectionLog'
  >,
  date: string,
  now: Date
): Promise<FreshnessInput> {
  const dateValue = new Date(`${date}T00:00:00.000Z`);
  const prices = [];

  for (const [label, asset] of Object.entries(PRICE_ASSET_IDS)) {
    const row = await client.marketSnapshot.findFirst({
      where: {
        asset,
        collectedAt: { lte: now },
      },
      orderBy: { collectedAt: 'desc' },
      select: { collectedAt: true },
    });
    prices.push({ label, collectedAt: row?.collectedAt ?? null });
  }

  const returns = [];
  for (const [label, scope] of Object.entries(PRICE_ASSET_IDS)) {
    for (const [indicator, name] of [
      ['return_1d', '1d'],
      ['return_7d', '7d'],
    ] as const) {
      const row = await client.indicatorSnapshot.findFirst({
        where: {
          indicator,
          scope,
          formulaVersion: RETURN_FORMULA_VERSION,
          asOf: { lte: dateValue },
        },
        orderBy: { asOf: 'desc' },
        select: { asOf: true },
      });
      returns.push({
        item: `Return ${name} ${label}`,
        asOf: row?.asOf ?? null,
      });
    }
  }

  const state = await client.marketState.findFirst({
    where: {
      stateVersion: STATE_VERSION,
      asOf: { lte: dateValue },
    },
    orderBy: { asOf: 'desc' },
    select: { asOf: true },
  });

  const close = await client.dailyClose.findFirst({
    where: { asset: 'solana', date: dateValue },
    select: { date: true },
  });

  const coinalyze = await client.indicatorSnapshot.findFirst({
    where: { scope: COINALYZE_SCOPE },
    orderBy: { asOf: 'desc' },
    select: { asOf: true },
  });

  const dollarToDate = await latestToDate(
    client,
    'macro_dollar_broad_change_5d_pct',
    MACRO_SCOPE,
    dateValue
  );
  const realYieldToDate = await latestToDate(
    client,
    'macro_real_yield_10y_change_5d',
    MACRO_SCOPE,
    dateValue
  );

  const dex = await client.indicatorSnapshot.findFirst({
    where: {
      indicator: 'dex_volume_vs_mean_7d',
      scope: 'solana',
      formulaVersion: RETURN_FORMULA_VERSION,
      asOf: { lte: dateValue },
      toDate: { not: null },
    },
    orderBy: { toDate: 'desc' },
    select: { toDate: true },
  });

  const launchpads = [];
  for (const slug of LAUNCHPAD_SLUGS) {
    const row = await client.indicatorSnapshot.findFirst({
      where: {
        indicator: 'launchpad_dex_volume_vs_mean_7d',
        scope: buildProtocolScope(slug),
        formulaVersion: RETURN_FORMULA_VERSION,
        asOf: { lte: dateValue },
        toDate: { not: null },
      },
      orderBy: { toDate: 'desc' },
      select: { toDate: true },
    });
    launchpads.push({ slug, toDate: row?.toDate ?? null });
  }

  const collection = await client.collectionLog.findFirst({
    where: {
      status: 'success',
      collectedAt: { lte: now },
    },
    orderBy: { collectedAt: 'desc' },
    select: { collectedAt: true },
  });

  return {
    date,
    now,
    prices,
    returns,
    stateAsOf: state?.asOf ?? null,
    dailyCloseDate: close?.date ?? null,
    coinalyzeAsOf: coinalyze?.asOf ?? null,
    dollarToDate,
    realYieldToDate,
    dexToDate: dex?.toDate ?? null,
    launchpads,
    lastSuccessfulCollectionAt: collection?.collectedAt ?? null,
  };
}

async function main(): Promise<void> {
  const now = new Date();
  const parsed = resolveReferenceDate(process.argv.slice(2), now);
  if (parsed.error !== null) {
    console.error(`[FRESHNESS] ${parsed.error}`);
    console.log('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }

  if (!requireRemoteAllow()) {
    console.error(
      '[ABORT] check:freshness exige TERMINAL_ALLOW_REMOTE=1 para banco remoto'
    );
    console.log('RESULT: FAIL');
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  const { prisma } = await import('../db');

  try {
    const input = await readFreshnessInput(prisma, parsed.date, now);
    const results = evaluateFreshness(input);
    for (const result of results) {
      console.log(`${result.status.padEnd(4)} ${result.item}: ${result.detalhe}`);
    }
    console.log(`RESULT: ${worstStatus(results)}`);
    process.exitCode = exitCodeFor(results);
  } catch (error) {
    console.error(
      '[FATAL]',
      error instanceof Error ? error.message : String(error).slice(0, 300)
    );
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
