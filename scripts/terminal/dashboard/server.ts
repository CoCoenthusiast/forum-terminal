#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  LAUNCHPAD_SLUGS,
  STATE_VERSION,
  buildProtocolScope,
  checkEnvironment,
} from '../config';
import type { PrismaClient } from '../generated/db/client';
import {
  evaluateFreshness,
  previousUtcDay,
  resolveReferenceDate,
  worstStatus,
  type FreshnessInput,
} from '../checks/freshness-rules';
import { PRICE_ASSET_IDS, readRecapInput } from '../recap/recap-reader';
import { renderDataHealth, renderOverview } from './pages';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;

const RETURN_FORMULA_VERSION = 'v1';
const MACRO_FORMULA_VERSION = 'macro_v1';
const COINALYZE_SCOPE = 'coinalyze:SOL';
const MACRO_SCOPE = 'macro:us';

type DashboardClient = PrismaClient;

let clientPromise: Promise<DashboardClient> | null = null;

async function getClient(): Promise<DashboardClient> {
  if (clientPromise === null) {
    clientPromise = import('../db').then((module) => module.prisma);
  }
  return clientPromise;
}

export async function disconnectClient(): Promise<void> {
  if (clientPromise === null) return;
  const client = await clientPromise;
  clientPromise = null;
  await client.$disconnect();
}

async function latestToDate(
  client: Pick<DashboardClient, 'indicatorSnapshot'>,
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

async function readHealthInput(
  client: Pick<
    DashboardClient,
    'marketSnapshot' | 'indicatorSnapshot' | 'marketState' | 'dailyClose' | 'collectionLog'
  >,
  date: string,
  now: Date
): Promise<FreshnessInput> {
  const dateValue = new Date(`${date}T00:00:00.000Z`);
  const prices: { label: string; collectedAt: Date | null }[] = [];

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

  const returns: { item: string; asOf: Date | null }[] = [];
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

  const launchpads: { slug: string; toDate: Date | null }[] = [];
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

function resolveDate(url: URL, now: Date): { date: string; error: string | null } {
  const value = url.searchParams.get('date');
  if (value === null) return { date: previousUtcDay(now), error: null };
  return resolveReferenceDate([`--date=${value}`], now);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    sendText(res, 405, 'Method Not Allowed');
    return;
  }

  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const now = new Date();

  if (url.pathname === '/' || url.pathname === '/overview') {
    const resolved = resolveDate(url, now);
    if (resolved.error !== null) {
      sendText(res, 400, resolved.error);
      return;
    }
    const client = await getClient();
    const input = await readRecapInput(client, resolved.date);
    sendHtml(res, 200, renderOverview(input));
    return;
  }

  if (url.pathname === '/health') {
    const resolved = resolveDate(url, now);
    if (resolved.error !== null) {
      sendText(res, 400, resolved.error);
      return;
    }
    const client = await getClient();
    const input = await readHealthInput(client, resolved.date, now);
    const results = evaluateFreshness(input);
    sendHtml(res, 200, renderDataHealth(results, worstStatus(results), resolved.date));
    return;
  }

  sendText(res, 404, 'Not Found');
}

export function createDashboardServer() {
  return createHttpServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      console.error(
        '[DASHBOARD]',
        error instanceof Error ? error.message : String(error).slice(0, 300)
      );
      if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
}

export function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_PORT;
  return port;
}

async function main(): Promise<void> {
  checkEnvironment();
  const port = parsePort(process.env.PORT);
  const server = createDashboardServer();

  server.listen(port, HOST, () => {
    console.log(`[DASHBOARD] listening on http://${HOST}:${port}`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[DASHBOARD] ${signal} received, shutting down`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await disconnectClient().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
