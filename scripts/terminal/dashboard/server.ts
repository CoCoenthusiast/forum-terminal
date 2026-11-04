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
import { COINALYZE_LEVERAGE_INDICATORS } from '../indicators/coinalyze-leverage-catalog';
import {
  MACRO_INDICATOR_FORMULA_VERSION,
  MACRO_INDICATORS,
} from '../indicators/macro-catalog';
import { MACRO_SCOPE } from '../indicators/compute-macro-indicators';
import {
  LAUNCHPAD_FORMULA_VERSION,
  LAUNCHPAD_INDICATORS,
} from '../indicators/launchpads';
import { readIndicatorSeries, type SeriesTarget } from './series-reader';
import {
  readCoinalyzeLeverageHourly,
  readHyperliquidDaily,
  readHyperliquidHourly,
  readLaunchpadHourly,
  readLatestPrices,
  readOverviewDaily,
  readOverviewHourly,
  readRollingLaunchpadHourly,
  readRollingOverviewHourly,
} from './hourly-reader';
import {
  renderDataHealth,
  renderLaunchpads,
  renderLeverageMacro,
  renderOverview,
  renderPage,
  renderTokenDetail,
  renderTokens,
  type LaunchpadIndicatorGroup,
} from './pages';
import { readTokenDetail, readTokenSummaries } from './token-reader';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;

const RETURN_FORMULA_VERSION = 'v1';
const MACRO_FORMULA_VERSION = MACRO_INDICATOR_FORMULA_VERSION;
const COINALYZE_SCOPE = 'coinalyze:SOL';

type DashboardClient = PrismaClient;

export interface DashboardDeps {
  getClient?: () => Promise<DashboardClient>;
}

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

function leverageMacroTargets(): { leverage: SeriesTarget[]; macro: SeriesTarget[] } {
  const leverage: SeriesTarget[] = COINALYZE_LEVERAGE_INDICATORS.filter(
    (definition) => definition.coin === 'SOL'
  ).map((definition) => ({
    indicator: definition.indicator,
    scope: definition.scope,
    formulaVersion: definition.formulaVersion,
    unit: definition.unit,
  }));

  const macro: SeriesTarget[] = MACRO_INDICATORS.map((definition) => ({
    indicator: definition.indicator,
    scope: MACRO_SCOPE,
    formulaVersion: MACRO_INDICATOR_FORMULA_VERSION,
  }));

  return { leverage, macro };
}

const LAUNCHPAD_INDICATORS_PER_PLATFORM = 7;

interface LaunchpadTargetGroup {
  indicator: string;
  unit: string;
  targets: SeriesTarget[];
  slugs: string[];
}

function launchpadTargetGroups(): LaunchpadTargetGroup[] {
  const groups = new Map<string, LaunchpadTargetGroup>();

  for (const slug of LAUNCHPAD_SLUGS) {
    const scope = buildProtocolScope(slug);
    const definitions = LAUNCHPAD_INDICATORS.filter(
      (definition) => definition.scope === scope
    );
    if (definitions.length !== LAUNCHPAD_INDICATORS_PER_PLATFORM) {
      throw new Error(
        `launchpad catalog has ${definitions.length} indicators for ${slug}; expected ${LAUNCHPAD_INDICATORS_PER_PLATFORM}`
      );
    }

    for (const definition of definitions) {
      const group = groups.get(definition.indicator) ?? {
        indicator: definition.indicator,
        unit: definition.unit,
        targets: [],
        slugs: [],
      };
      group.targets.push({
        indicator: definition.indicator,
        scope,
        formulaVersion: LAUNCHPAD_FORMULA_VERSION,
        unit: definition.unit,
      });
      group.slugs.push(slug);
      groups.set(definition.indicator, group);
    }
  }

  return [...groups.values()];
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

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  resolveClient: () => Promise<DashboardClient>
): Promise<void> {
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
    const client = await resolveClient();
    const [input, hourly, latestPrices, daily, rolling] = await Promise.all([
      readRecapInput(client, resolved.date),
      readOverviewHourly(client, now),
      readLatestPrices(client, now),
      readOverviewDaily(client, resolved.date),
      readRollingOverviewHourly(client, now),
    ]);
    sendHtml(
      res,
      200,
      renderOverview(input, hourly, latestPrices, daily, rolling)
    );
    return;
  }

  if (url.pathname === '/health') {
    const resolved = resolveDate(url, now);
    if (resolved.error !== null) {
      sendText(res, 400, resolved.error);
      return;
    }
    const client = await resolveClient();
    const input = await readHealthInput(client, resolved.date, now);
    const results = evaluateFreshness(input);
    sendHtml(res, 200, renderDataHealth(results, worstStatus(results), resolved.date));
    return;
  }

  if (url.pathname === '/leverage-macro') {
    const resolved = resolveDate(url, now);
    if (resolved.error !== null) {
      sendText(res, 400, resolved.error);
      return;
    }
    const client = await resolveClient();
    const { leverage, macro } = leverageMacroTargets();
    const [
      series,
      hyperliquidHourly,
      hyperliquidDaily,
      coinalyzeHourly,
    ] = await Promise.all([
      readIndicatorSeries(client, [...leverage, ...macro], resolved.date),
      readHyperliquidHourly(client, now),
      readHyperliquidDaily(client, resolved.date),
      readCoinalyzeLeverageHourly(client, now),
    ]);
    sendHtml(
      res,
      200,
      renderLeverageMacro(
        series.slice(0, leverage.length),
        series.slice(leverage.length),
        hyperliquidHourly,
        hyperliquidDaily,
        resolved.date,
        coinalyzeHourly
      )
    );
    return;
  }

  if (url.pathname === '/launchpads') {
    const resolved = resolveDate(url, now);
    if (resolved.error !== null) {
      sendText(res, 400, resolved.error);
      return;
    }
    const client = await resolveClient();
    const groups = launchpadTargetGroups();
    const [series, hourly, rolling] = await Promise.all([
      readIndicatorSeries(
        client,
        groups.flatMap((group) => group.targets),
        resolved.date
      ),
      readLaunchpadHourly(client, now),
      readRollingLaunchpadHourly(client, now),
    ]);
    let cursor = 0;
    const view: LaunchpadIndicatorGroup[] = groups.map((group) => {
      const platforms = group.slugs.map((slug) => {
        const item = series[cursor];
        cursor += 1;
        if (item === undefined) {
          throw new Error(`missing series for ${slug}/${group.indicator}`);
        }
        return { slug, series: item };
      });
      return { indicator: group.indicator, unit: group.unit, platforms };
    });
    sendHtml(
      res,
      200,
      renderLaunchpads(view, hourly, resolved.date, rolling)
    );
    return;
  }

  if (url.pathname === '/tokens') {
    const client = await resolveClient();
    const summaries = await readTokenSummaries(client, now);
    sendHtml(res, 200, renderTokens(summaries));
    return;
  }

  if (url.pathname.startsWith('/tokens/')) {
    const rawAddress = url.pathname.slice('/tokens/'.length);
    if (rawAddress.length === 0) {
      sendHtml(res, 404, renderPage('Not found', '<p>Token not found.</p>'));
      return;
    }
    let address: string;
    try {
      address = decodeURIComponent(rawAddress);
    } catch {
      sendHtml(res, 404, renderPage('Not found', '<p>Token not found.</p>'));
      return;
    }
    const client = await resolveClient();
    const detail = await readTokenDetail(client, address, now);
    if (detail === null) {
      sendHtml(res, 404, renderPage('Not found', '<p>Token not found.</p>'));
      return;
    }
    sendHtml(res, 200, renderTokenDetail(detail));
    return;
  }

  sendText(res, 404, 'Not Found');
}

export function createDashboardServer(deps: DashboardDeps = {}) {
  const resolveClient = deps.getClient ?? getClient;
  return createHttpServer((req, res) => {
    handleRequest(req, res, resolveClient).catch((error: unknown) => {
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
