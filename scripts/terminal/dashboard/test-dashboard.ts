#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer, HOST } from './server';
import {
  COINALYZE_HOURLY_NOTICE,
  DASHBOARD_FOOTER,
  INTEGRATED_NOTICE,
  ROLLING_HOURLY_NOTICE,
  renderDataHealth,
  renderLaunchpads,
  renderLeverageMacro,
  renderOverview,
  renderTokenDetail,
  renderTokens,
  type LaunchpadIndicatorGroup,
} from './pages';
import {
  latestValueText,
  renderLineChart,
  renderMultiLineChart,
  renderTimeLineChart,
} from './charts';
import type { IndicatorSeries } from './series-reader';
import {
  COINALYZE_HOURLY_WINDOW_HOURS,
  COINALYZE_LEVERAGE_METRICS,
  HOURLY_STALE_HOURS,
  HOURLY_WINDOW_HOURS,
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
  readTokenDetail,
  readTokenSummaries,
  selectPreviousCapture,
  type TokenDetail,
  type TokenSummary,
} from './token-reader';
import { LAUNCHPAD_LABELS } from '../recap/recap-format';
import { LAUNCHPAD_SLUGS } from '../config';
import type { RecapInput, RecapMetric } from '../recap/recap-format';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function metric(value: number | null): RecapMetric {
  return { value, unit: null, asOf: null, dataAsOf: null };
}

const HOUR_MS = 60 * 60 * 1000;

function emptyInput(): RecapInput {
  return {
    asOf: '2026-11-01',
    prices: [
      { asset: 'SOL', priceUsd: metric(null), return1d: metric(null), return7d: metric(null) },
      { asset: 'BTC', priceUsd: metric(null), return1d: metric(null), return7d: metric(null) },
      { asset: 'ETH', priceUsd: metric(null), return1d: metric(null), return7d: metric(null) },
    ],
    regime: null,
    leverage: {
      oiUsdChange7dPct: metric(null),
      funding7dMean: metric(null),
      liqTotalVsMean7dPct: metric(null),
      liqLongSharePct: metric(null),
    },
    macro: {
      dollarBroadChange5dPct: metric(null),
      realYield10yChange5d: metric(null),
    },
    activity: {
      dexVolumeVsMean7d: metric(null),
      launchpads: [],
    },
  };
}

function emptySeries(indicator: string, scope: string, unit: string): IndicatorSeries {
  return {
    indicator,
    scope,
    formulaVersion: 'test_v1',
    unit,
    from: '2026-01-01',
    to: '2026-03-31',
    points: [],
  };
}

function tokenSummary(overrides: Partial<TokenSummary> = {}): TokenSummary {
  return {
    address: 'So11111111111111111111111111111111111111112',
    name: 'Test Token',
    symbol: 'TEST',
    latest: null,
    previous: null,
    poolsObserved: null,
    holdersCount: null,
    priceChangePct: null,
    liquidityChangePct: null,
    volumeChangePct: null,
    marketCapChangePct: null,
    pricePoints: [],
    from: '2026-10-20',
    to: '2026-11-02',
    ...overrides,
  };
}

function tokenDetail(overrides: Partial<TokenDetail> = {}): TokenDetail {
  return {
    address: 'So11111111111111111111111111111111111111112',
    name: 'Test Token',
    symbol: 'TEST',
    latest: null,
    pricePoints: [],
    liquidityPoints: [],
    volumePoints: [],
    marketCapPoints: [],
    marketCapEstimatedPoints: [],
    impliedSupply: null,
    fdvPoints: [],
    pools: [],
    holder: null,
    from: '2026-10-20',
    to: '2026-11-02',
    ...overrides,
  };
}

interface StatusResponse {
  status: number;
  allow: string | undefined;
  body: string;
}

function requestStatus(port: number, method: string, path: string): Promise<StatusResponse> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          allow: res.headers.allow,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const server = createDashboardServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => resolve());
  });

  const address = server.address();
  const boundToHost =
    address !== null &&
    typeof address === 'object' &&
    address.address === HOST;
  check('server binds explicitly to 127.0.0.1', boundToHost);

  const port = address !== null && typeof address === 'object' ? address.port : 0;

  const post = await requestStatus(port, 'POST', '/');
  check('POST returns 405', post.status === 405);
  check('405 advertises GET only', (post.allow ?? '').toUpperCase() === 'GET');

  const put = await requestStatus(port, 'PUT', '/health');
  check('PUT returns 405', put.status === 405);

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const overview = renderOverview(emptyInput());
  check('overview renders n/a when data is missing', overview.includes('n/a'));
  check('overview never turns missing prices into zero', !overview.includes('$0.00'));
  check('overview shows SOL, BTC and ETH', ['SOL', 'BTC', 'ETH'].every((asset) => overview.includes(`>${asset}<`)));
  check('overview has the dashboard footer', overview.includes(DASHBOARD_FOOTER));
  check('overview links to leverage & macro', overview.includes('href="/leverage-macro"'));
  check('overview links to launchpads', overview.includes('href="/launchpads"'));
  check('overview links to tokens', overview.includes('href="/tokens"'));

  const emptyPlatforms = LAUNCHPAD_SLUGS.map((slug) => ({
    slug,
    series: emptySeries(
      'launchpad_dex_volume_vs_mean_7d',
      `solana:protocol:${slug}`,
      'FRACTION'
    ),
  }));
  const launchpadsPage = renderLaunchpads([
    {
      indicator: 'launchpad_dex_volume_vs_mean_7d',
      unit: 'FRACTION',
      platforms: emptyPlatforms,
    },
  ]);
  check('launchpads page shows n/a for empty data', launchpadsPage.includes('n/a'));
  check(
    'launchpads page has the organic adoption notice',
    launchpadsPage.includes(
      'High volume is not the same as organic adoption (bots, arbitrage and circular volume are not detected).'
    )
  );
  check(
    'launchpads page has the delay notice',
    launchpadsPage.includes(
      'Launchpad data arrives with a 2-day delay. Values are relative to the 4 platforms covered.'
    )
  );
  check('launchpads page has the dashboard footer', launchpadsPage.includes(DASHBOARD_FOOTER));

  interface HourlyQuery {
    where?: { collectedAt?: { gte?: Date; lte?: Date } };
    take?: number;
  }

  interface LatestPriceQuery {
    where?: {
      collectedAt?: { gte?: Date; lte?: Date };
      source?: { provider?: string };
    };
    take?: number;
  }

  const hourlyNow = new Date('2026-11-02T12:00:00.000Z');
  const hourlyQueries: HourlyQuery[] = [];
  const recentAt = new Date(hourlyNow.getTime() - HOUR_MS);
  const recentRows = [
    { scope: 'solana', metric: 'tvl_usd', value: 1234.5, unit: 'USD', collectedAt: recentAt },
    {
      scope: 'global',
      metric: 'btc_dominance_pct',
      value: 55.5,
      unit: 'PERCENT',
      collectedAt: recentAt,
    },
  ];
  const recentClient = {
    metricSnapshot: {
      findMany: async (args: HourlyQuery) => {
        hourlyQueries.push(args);
        return recentRows;
      },
    },
  };
  const recentHourly = await readOverviewHourly(recentClient as never, hourlyNow);
  const recentTvl = recentHourly.find(
    (row) => row.scope === 'solana' && row.metric === 'tvl_usd'
  );
  check(
    'a recent hourly capture is fresh',
    recentTvl?.value === 1234.5 &&
      recentTvl.stale === false &&
      recentTvl.ageMs === HOUR_MS
  );
  check(
    'the hourly query uses a 6h window',
    hourlyQueries[0]?.where?.collectedAt?.gte?.getTime() ===
      hourlyNow.getTime() - HOURLY_WINDOW_HOURS * HOUR_MS
  );
  check('the hourly query has a limit', (hourlyQueries[0]?.take ?? 0) > 0);

  const recentOverview = renderOverview(emptyInput(), recentHourly);
  check(
    'overview integrates hourly values into market activity',
    recentOverview.includes('<h2>Market activity</h2>') &&
      recentOverview.includes(INTEGRATED_NOTICE) &&
      !recentOverview.includes('Latest hourly capture') &&
      !recentOverview.includes('<h2>Latest price</h2>')
  );
  check(
    'overview has closed and latest columns',
    recentOverview.includes('<th>Metric</th><th>Closed</th><th>Latest</th>')
  );
  check(
    'overview activity shows latest value, UTC time and age',
    recentOverview.includes('1,234.5 USD') &&
      recentOverview.includes('2026-11-02 11:00 UTC') &&
      recentOverview.includes('1h 0m')
  );

  const staleAt = new Date(
    hourlyNow.getTime() - (HOURLY_STALE_HOURS + 1) * HOUR_MS
  );
  const staleRows = [
    { scope: 'solana', metric: 'tvl_usd', value: 99, unit: 'USD', collectedAt: staleAt },
  ];
  const staleClient = {
    metricSnapshot: { findMany: async () => staleRows },
  };
  const staleHourly = await readOverviewHourly(staleClient as never, hourlyNow);
  const staleTvl = staleHourly.find(
    (row) => row.scope === 'solana' && row.metric === 'tvl_usd'
  );
  check(
    'a capture older than 3h is stale',
    staleTvl?.stale === true &&
      staleTvl.ageMs === (HOURLY_STALE_HOURS + 1) * HOUR_MS
  );
  const staleOverview = renderOverview(emptyInput(), staleHourly);
  check(
    'a stale hourly capture shows the last value, age and stale marker',
    staleOverview.includes('99 USD') &&
      staleOverview.includes('4h 0m') &&
      staleOverview.includes('stale')
  );

  const emptyHourlyClient = {
    metricSnapshot: { findMany: async () => [] },
  };
  const noHourly = await readOverviewHourly(emptyHourlyClient as never, hourlyNow);
  check(
    'no hourly capture yields n/a fields',
    noHourly.every(
      (row) =>
        row.value === null &&
        row.collectedAt === null &&
        row.ageMs === null &&
        row.stale === false
    )
  );
  const noHourlyOverview = renderOverview(emptyInput(), noHourly);
  check(
    'no hourly capture renders n/a in latest columns, never zero',
    noHourlyOverview.includes('<th>Latest</th>') &&
      noHourlyOverview.includes('<td>n/a</td>') &&
      !noHourlyOverview.includes('0 USD')
  );

  const partialRows = [
    { scope: 'solana', metric: 'tvl_usd', value: 1, unit: 'USD', collectedAt: hourlyNow },
  ];
  const partialClient = {
    metricSnapshot: { findMany: async () => partialRows },
  };
  const partialHourly = await readOverviewHourly(partialClient as never, hourlyNow);
  const missingMetric = partialHourly.find(
    (row) => row.metric === 'stablecoin_supply_usd'
  );
  check(
    'a missing hourly metric is n/a',
    missingMetric?.value === null &&
      missingMetric.collectedAt === null &&
      missingMetric.ageMs === null
  );
  check(
    'a missing hourly metric renders n/a, not zero',
    renderOverview(emptyInput(), partialHourly).includes(
      'Stablecoins</th><td>n/a</td><td>n/a</td>'
    )
  );

  interface DailyQuery {
    where?: {
      asOf?: { lte?: Date };
      status?: string;
    };
    take?: number;
  }

  const overviewDailyRows = [
    {
      scope: 'solana',
      indicator: 'tvl_usd',
      value: 2000,
      unit: 'USD',
      asOf: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      scope: 'solana',
      indicator: 'stablecoin_supply_usd',
      value: 3000,
      unit: 'USD',
      asOf: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      scope: 'solana',
      indicator: 'dex_volume_24h_usd',
      value: 4000,
      unit: 'USD',
      asOf: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      scope: 'global',
      indicator: 'global_market_cap_usd',
      value: 5000,
      unit: 'USD',
      asOf: new Date('2026-11-01T00:00:00.000Z'),
    },
    {
      scope: 'global',
      indicator: 'btc_dominance_pct',
      value: 55,
      unit: 'PERCENT',
      asOf: new Date('2026-11-01T00:00:00.000Z'),
    },
  ];
  const overviewDailyQueries: DailyQuery[] = [];
  const overviewDailyClient = {
    indicatorSnapshot: {
      findMany: async (args: DailyQuery) => {
        overviewDailyQueries.push(args);
        return overviewDailyRows;
      },
    },
  };
  const overviewDaily = await readOverviewDaily(
    overviewDailyClient as never,
    '2026-11-01'
  );
  check(
    'overview daily query reads ok indicator snapshots up to the closed day',
    overviewDailyQueries[0]?.where?.status === 'ok' &&
      overviewDailyQueries[0]?.where?.asOf?.lte?.toISOString() ===
        '2026-11-01T00:00:00.000Z'
  );
  check(
    'overview daily values come from indicator snapshots',
    overviewDaily.find((row) => row.metric === 'tvl_usd')?.value === 2000
  );
  const integratedOverview = renderOverview(
    emptyInput(),
    recentHourly,
    [],
    overviewDaily
  );
  check(
    'overview shows closed and latest values side by side',
    integratedOverview.includes('2,000 USD') &&
      integratedOverview.includes('1,234.5 USD') &&
      integratedOverview.includes('Closed 2026-11-01')
  );
  check(
    'overview labels the closed day',
    integratedOverview.includes('Computed on closed day 2026-11-01')
  );

  interface RollingQuery {
    where?: {
      scope?: { in?: string[] };
      metric?: { in?: string[] };
      collectedAt?: { gte?: Date; lte?: Date };
    };
    orderBy?: { collectedAt?: 'desc' };
    take?: number;
  }

  check(
    'rolling notice is fixed',
    ROLLING_HOURLY_NOTICE ===
      'Rolling 24h captures, formula rolling_hourly_v1. Not comparable with the daily closed indicators.'
  );

  const rollingNow = new Date('2026-11-02T12:00:00.000Z');
  const rollingCurrentAt = new Date('2026-11-02T11:00:00.000Z');
  const rollingValues = [100, 110, 120, 130, 140, 150, 160];
  const rollingRows = [
    {
      scope: 'solana',
      metric: 'dex_volume_24h_usd',
      value: 200,
      collectedAt: rollingCurrentAt,
      sourceTs: null,
    },
    ...rollingValues.map((value, index) => ({
      scope: 'solana',
      metric: 'dex_volume_24h_usd',
      value,
      collectedAt: new Date(
        rollingCurrentAt.getTime() - (index + 1) * 24 * 60 * 60 * 1000
      ),
      sourceTs: null,
    })),
  ];
  const rollingQueries: RollingQuery[] = [];
  const rollingClient = {
    metricSnapshot: {
      findMany: async (args: RollingQuery) => {
        rollingQueries.push(args);
        return rollingRows;
      },
    },
  };
  const rollingOverview = await readRollingOverviewHourly(
    rollingClient as never,
    rollingNow
  );
  const rollingQuery = rollingQueries[0];
  check(
    'rolling overview reads the Solana DEX volume series',
    rollingOverview.length === 1 &&
      rollingOverview[0]?.scope === 'solana' &&
      rollingOverview[0]?.metric === 'dex_volume_24h_usd'
  );
  check(
    'rolling query uses an 8-day capture window',
    rollingQuery?.where?.scope?.in?.includes('solana') === true &&
      rollingQuery?.where?.metric?.in?.includes('dex_volume_24h_usd') === true &&
      rollingQuery?.where?.collectedAt?.gte?.getTime() ===
        rollingNow.getTime() - 8 * 24 * 60 * 60 * 1000 &&
      rollingQuery?.where?.collectedAt?.lte?.getTime() === rollingNow.getTime() &&
      (rollingQuery?.take ?? 0) > 0
  );
  const rollingSolana = rollingOverview[0];
  check(
    'rolling overview computes current, mean and relative deviation',
    rollingSolana?.current === 200 &&
      rollingSolana.referencePoints === 7 &&
      Math.abs((rollingSolana.referenceMean ?? 0) - 138.75) < 1e-9 &&
      Math.abs((rollingSolana.relativeDeviation ?? 0) - (200 / 138.75 - 1)) <
        1e-9
  );
  check(
    'rolling overview detects a once-a-day source and last change',
    rollingSolana?.updatesOnceDaily === true &&
      rollingSolana.lastChangeAt?.toISOString() ===
        '2026-11-02T11:00:00.000Z'
  );
  const rollingOverviewPage = renderOverview(
    emptyInput(),
    [],
    [],
    [],
    rollingOverview
  );
  check(
    'overview shows the rolling activity block',
    rollingOverviewPage.includes('<h2>Rolling activity</h2>') &&
      rollingOverviewPage.includes(ROLLING_HOURLY_NOTICE) &&
      rollingOverviewPage.includes('<th>Rolling vs 7d mean</th><th>Source cadence</th>') &&
      rollingOverviewPage.includes('Powered by DefiLlama')
  );
  check(
    'overview rolling block shows deviation, mean and cadence',
    rollingOverviewPage.includes('+44.14% vs mean 138.75 USD') &&
      rollingOverviewPage.includes(
        'source updates once a day (00:00 UTC); last change 2026-11-02 11:00 UTC'
      )
  );

  const rollingLaunchRows = [
    ...rollingRows.map((row) => ({
      ...row,
      scope: 'solana:protocol:pump.fun',
      metric: 'dex_volume_24h_usd',
    })),
    ...rollingRows.map((row) => ({
      ...row,
      scope: 'solana:protocol:pump.fun',
      metric: 'fees_24h_usd',
    })),
  ];
  const rollingLaunchClient = {
    metricSnapshot: { findMany: async () => rollingLaunchRows },
  };
  const rollingLaunchpads = await readRollingLaunchpadHourly(
    rollingLaunchClient as never,
    rollingNow
  );
  const rollingPumpVolume = rollingLaunchpads.find(
    (row) =>
      row.scope === 'solana:protocol:pump.fun' &&
      row.metric === 'dex_volume_24h_usd'
  );
  const rollingPumpFees = rollingLaunchpads.find(
    (row) =>
      row.scope === 'solana:protocol:pump.fun' &&
      row.metric === 'fees_24h_usd'
  );
  check(
    'rolling launchpads cover 8 slugs x 2 metrics',
    rollingLaunchpads.length === 16 &&
      rollingPumpVolume?.current === 200 &&
      rollingPumpFees?.current === 200
  );
  check(
    'rolling launchpads missing platforms are n/a',
    rollingLaunchpads.find(
      (row) =>
        row.scope === 'solana:protocol:pumpswap' &&
        row.metric === 'dex_volume_24h_usd'
    )?.current === null
  );
  const rollingLaunchPage = renderLaunchpads(
    [],
    [],
    '2026-11-01',
    rollingLaunchpads
  );
  check(
    'launchpads adds rolling and cadence columns next to the daily columns',
    rollingLaunchPage.includes(
      '<th>Rolling vs 7d mean</th><th>Source cadence</th><th>Latest 24h volume</th><th>Latest 24h fees</th>'
    ) &&
      rollingLaunchPage.includes(ROLLING_HOURLY_NOTICE) &&
      rollingLaunchPage.includes('Powered by DefiLlama')
  );
  check(
    'launchpads rolling cells show volume and fees',
    rollingLaunchPage.includes('Volume: +44.14% vs mean 138.75 USD') &&
      rollingLaunchPage.includes('Fees: +44.14% vs mean 138.75 USD') &&
      rollingLaunchPage.includes(
        'Volume: source updates once a day (00:00 UTC); last change 2026-11-02 11:00 UTC'
      )
  );

  const emptyRollingClient = {
    metricSnapshot: { findMany: async () => [] },
  };
  const emptyRolling = await readRollingLaunchpadHourly(
    emptyRollingClient as never,
    rollingNow
  );
  check(
    'rolling with no captures is n/a, never zero',
    emptyRolling.length === 16 &&
      emptyRolling.every(
        (row) =>
          row.current === null &&
          row.referenceMean === null &&
          row.relativeDeviation === null &&
          row.updatesOnceDaily === null
      )
  );
  const emptyRollingPage = renderLaunchpads(
    [],
    [],
    '2026-11-01',
    emptyRolling
  );
  check(
    'launchpads rolling n/a is rendered without zero',
    emptyRollingPage.includes('Volume: n/a') &&
      emptyRollingPage.includes('Fees: n/a') &&
      !emptyRollingPage.includes('0 USD')
  );

  const hyperRows = [
    {
      scope: 'hyperliquid:perp:SOL',
      metric: 'perp_funding_rate_1h',
      value: 0.0001,
      unit: 'FRACTION',
      collectedAt: recentAt,
    },
  ];
  const hyperClient = {
    metricSnapshot: { findMany: async () => hyperRows },
  };
  const hyperHourly = await readHyperliquidHourly(hyperClient as never, hourlyNow);
  check('hyperliquid hourly covers 3 coins x 4 metrics', hyperHourly.length === 12);
  check(
    'hyperliquid missing metrics are n/a',
    hyperHourly.filter((row) => row.value === null).length === 11
  );

  const hyperDailyRows = [
    {
      scope: 'hyperliquid:perp:SOL',
      indicator: 'perp_funding_rate_1h',
      value: 0.0002,
      unit: 'FRACTION',
      asOf: new Date('2026-11-01T00:00:00.000Z'),
    },
  ];
  const hyperDailyClient = {
    indicatorSnapshot: { findMany: async () => hyperDailyRows },
  };
  const hyperDaily = await readHyperliquidDaily(
    hyperDailyClient as never,
    '2026-11-01'
  );
  check(
    'hyperliquid daily covers 3 coins x 4 metrics',
    hyperDaily.length === 12
  );
  check(
    'hyperliquid daily missing metrics are n/a',
    hyperDaily.filter((row) => row.value === null).length === 11
  );
  const hyperPage = renderLeverageMacro(
    [],
    [],
    hyperHourly,
    hyperDaily,
    '2026-11-01'
  );
  check(
    'leverage & macro integrates Hyperliquid daily and latest',
    hyperPage.includes('<h2>Hyperliquid</h2>') &&
      hyperPage.includes(INTEGRATED_NOTICE) &&
      hyperPage.includes('0.0002 FRACTION') &&
      hyperPage.includes('0.0001 FRACTION') &&
      hyperPage.includes('Closed 2026-11-01') &&
      hyperPage.includes('Computed on closed day 2026-11-01')
  );
  check(
    'hyperliquid values stay raw',
    hyperPage.includes('0.0001 FRACTION') && !hyperPage.includes('0.01%')
  );

  interface CoinalyzeHourlyQuery {
    where?: {
      scope?: { startsWith?: string };
      metric?: { endsWith?: string };
      sourceTs?: { gte?: Date; lte?: Date };
    };
    orderBy?: { sourceTs?: 'desc'; collectedAt?: 'desc' }[];
    take?: number;
  }

  const coinalyzeNow = new Date('2026-11-02T15:05:00.000Z');
  const coinalyzeRecentAt = new Date('2026-11-02T14:00:00.000Z');
  const coinalyzeOlderAt = new Date('2026-11-02T13:00:00.000Z');
  const coinalyzeRows = [
    {
      scope: 'coinalyze:SOL',
      metric: 'oi_usd_close_1h',
      value: 900,
      unit: 'USD',
      sourceTs: coinalyzeOlderAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:SOL',
      metric: 'oi_usd_close_1h',
      value: 1000,
      unit: 'USD',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:SOL',
      metric: 'funding_rate_close_pct_1h',
      value: 0.01,
      unit: 'PERCENT',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:SOL',
      metric: 'long_short_ratio_1h',
      value: 1.2,
      unit: 'RATIO',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:SOL',
      metric: 'long_account_pct_1h',
      value: 55,
      unit: 'PERCENT',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:SOL',
      metric: 'liq_long_usd_1h',
      value: 0,
      unit: 'USD',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:SOL',
      metric: 'liq_short_usd_1h',
      value: 5,
      unit: 'USD',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
    {
      scope: 'coinalyze:BTC',
      metric: 'oi_usd_close_1h',
      value: 2000,
      unit: 'USD',
      sourceTs: coinalyzeRecentAt,
      collectedAt: coinalyzeNow,
    },
  ];
  const coinalyzeQueries: CoinalyzeHourlyQuery[] = [];
  const coinalyzeClient = {
    metricSnapshot: {
      findMany: async (args: CoinalyzeHourlyQuery) => {
        coinalyzeQueries.push(args);
        return coinalyzeRows;
      },
    },
  };
  const coinalyzeHourly = await readCoinalyzeLeverageHourly(
    coinalyzeClient as never,
    coinalyzeNow
  );
  const coinalyzeQuery = coinalyzeQueries[0];
  check(
    'coinalyze hourly covers 3 coins x 6 metrics',
    coinalyzeHourly.length === 18
  );
  check(
    'coinalyze hourly query filters by scope, metric and closed window',
    coinalyzeQuery?.where?.scope?.startsWith === 'coinalyze:' &&
      coinalyzeQuery?.where?.metric?.endsWith === '_1h' &&
      coinalyzeQuery?.where?.sourceTs?.gte?.toISOString() ===
        new Date(
          coinalyzeNow.getTime() -
            COINALYZE_HOURLY_WINDOW_HOURS * 60 * 60 * 1000
        ).toISOString() &&
      coinalyzeQuery?.where?.sourceTs?.lte?.toISOString() ===
        new Date(coinalyzeNow.getTime() - 60 * 60 * 1000).toISOString() &&
      (coinalyzeQuery?.take ?? 0) > 0
  );
  check(
    'coinalyze hourly query orders by newest candle',
    coinalyzeQuery?.orderBy?.[0]?.sourceTs === 'desc' &&
      coinalyzeQuery?.orderBy?.[1]?.collectedAt === 'desc'
  );
  const solOi = coinalyzeHourly.find(
    (row) =>
      row.scope === 'coinalyze:SOL' && row.metric === 'oi_usd_close_1h'
  );
  check(
    'coinalyze picks the newest candle per scope and metric',
    solOi?.value === 1000 &&
      solOi.sourceTs?.toISOString() === coinalyzeRecentAt.toISOString() &&
      solOi.stale === false
  );
  const coinalyzePresent = new Set(
    coinalyzeRows.map((row) => `${row.scope}\u0000${row.metric}`)
  ).size;
  check(
    'coinalyze missing coins and metrics are n/a',
    coinalyzeHourly.filter((row) => row.value === null).length ===
      18 - coinalyzePresent &&
      coinalyzeHourly.find(
        (row) =>
          row.scope === 'coinalyze:ETH' && row.metric === 'oi_usd_close_1h'
      )?.value === null
  );
  const coinalyzePage = renderLeverageMacro(
    [],
    [],
    [],
    [],
    '2026-11-01',
    coinalyzeHourly
  );
  check(
    'leverage & macro shows the latest closed Coinalyze hour',
    coinalyzePage.includes('<h3>Latest closed hour</h3>') &&
      coinalyzePage.includes(COINALYZE_HOURLY_NOTICE) &&
      coinalyzePage.includes('hour 14:00 to 15:00 UTC') &&
      coinalyzePage.includes('1,000 USD') &&
      coinalyzePage.includes('2,000 USD')
  );
  check(
    'coinalyze zero liquidation is a real zero',
    coinalyzeHourly.find(
      (row) =>
        row.scope === 'coinalyze:SOL' &&
        row.metric === 'liq_long_usd_1h'
    )?.value === 0 && coinalyzePage.includes('0 USD')
  );
  check(
    'leverage & macro keeps the Coinalyze credit link',
    coinalyzePage.includes(
      '<a href="https://coinalyze.net">https://coinalyze.net</a>'
    )
  );

  const staleCoinalyzeAt = new Date('2026-11-02T10:00:00.000Z');
  const staleCoinalyzeClient = {
    metricSnapshot: {
      findMany: async () => [
        {
          scope: 'coinalyze:SOL',
          metric: 'oi_usd_close_1h',
          value: 1100,
          unit: 'USD',
          sourceTs: staleCoinalyzeAt,
          collectedAt: coinalyzeNow,
        },
      ],
    },
  };
  const staleCoinalyze = await readCoinalyzeLeverageHourly(
    staleCoinalyzeClient as never,
    coinalyzeNow
  );
  const staleSolOi = staleCoinalyze.find(
    (row) =>
      row.scope === 'coinalyze:SOL' && row.metric === 'oi_usd_close_1h'
  );
  check(
    'coinalyze marks a candle ending more than 3h ago as stale',
    staleSolOi?.stale === true &&
      staleCoinalyze.filter((row) => row.stale).length === 1
  );
  const staleCoinalyzePage = renderLeverageMacro(
    [],
    [],
    [],
    [],
    '2026-11-01',
    staleCoinalyze
  );
  check(
    'leverage & macro shows stale next to the Coinalyze value',
    staleCoinalyzePage.includes(
      '1,100 USD <span class="warn">stale</span>'
    ) && staleCoinalyzePage.includes('hour 10:00 to 11:00 UTC')
  );

  const emptyCoinalyzeClient = {
    metricSnapshot: { findMany: async () => [] },
  };
  const emptyCoinalyze = await readCoinalyzeLeverageHourly(
    emptyCoinalyzeClient as never,
    coinalyzeNow
  );
  check(
    'coinalyze with no rows is n/a, not zero',
    emptyCoinalyze.length === 18 &&
      emptyCoinalyze.every(
        (row) =>
          row.value === null && row.sourceTs === null && row.stale === false
      )
  );
  const emptyCoinalyzePage = renderLeverageMacro(
    [],
    [],
    [],
    [],
    '2026-11-01',
    emptyCoinalyze
  );
  check(
    'leverage & macro renders n/a for missing Coinalyze hours',
    emptyCoinalyzePage.includes('<h3>Latest closed hour</h3>') &&
      emptyCoinalyzePage.includes('<td>n/a</td>') &&
      !emptyCoinalyzePage.includes('0 USD')
  );

  const missingCoinalyzeClient = {
    metricSnapshot: {
      findMany: async () =>
        coinalyzeRows.filter(
          (row) =>
            !(
              row.scope === 'coinalyze:SOL' &&
              row.metric === 'funding_rate_close_pct_1h'
            )
        ),
    },
  };
  const missingCoinalyze = await readCoinalyzeLeverageHourly(
    missingCoinalyzeClient as never,
    coinalyzeNow
  );
  const missingFunding = missingCoinalyze.find(
    (row) =>
      row.scope === 'coinalyze:SOL' &&
      row.metric === 'funding_rate_close_pct_1h'
  );
  check(
    'coinalyze missing metric is n/a',
    missingFunding?.value === null &&
      missingFunding.sourceTs === null &&
      missingFunding.stale === false &&
      COINALYZE_LEVERAGE_METRICS.includes('funding_rate_close_pct_1h')
  );

  const launchHourlyRows = [
    {
      scope: 'solana:protocol:pump.fun',
      metric: 'dex_volume_24h_usd',
      value: 100,
      unit: 'USD',
      collectedAt: recentAt,
    },
    {
      scope: 'solana:protocol:pump.fun',
      metric: 'fees_24h_usd',
      value: 5,
      unit: 'USD',
      collectedAt: recentAt,
    },
  ];
  const launchHourlyClient = {
    metricSnapshot: { findMany: async () => launchHourlyRows },
  };
  const launchHourly = await readLaunchpadHourly(
    launchHourlyClient as never,
    hourlyNow
  );
  check('launchpad hourly covers 8 slugs x 2 metrics', launchHourly.length === 16);
  check(
    'launchpad missing metrics are n/a',
    launchHourly.filter((row) => row.value === null).length === 14
  );
  const launchHourlyPage = renderLaunchpads([], launchHourly, '2026-11-01');
  check(
    'launchpads integrates hourly columns into the platform table',
    launchHourlyPage.includes('<th>Latest 24h volume</th><th>Latest 24h fees</th>') &&
      launchHourlyPage.includes(INTEGRATED_NOTICE) &&
      !launchHourlyPage.includes('Hourly protocol activity')
  );
  check(
    'launchpad latest columns show both hourly values',
    launchHourlyPage.includes('100 USD') &&
      launchHourlyPage.includes('5 USD') &&
      launchHourlyPage.includes('pump.fun')
  );
  check(
    'launchpads labels the closed day',
    launchHourlyPage.includes('Computed on closed day 2026-11-01')
  );

  const latestPriceQueries: LatestPriceQuery[] = [];
  const latestPriceRows = [
    {
      asset: 'solana',
      priceUsd: 150,
      collectedAt: recentAt,
      source: { provider: 'coingecko' },
    },
    {
      asset: 'bitcoin',
      priceUsd: 60000,
      collectedAt: recentAt,
      source: { provider: 'coingecko' },
    },
    {
      asset: 'ethereum',
      priceUsd: 3000,
      collectedAt: recentAt,
      source: { provider: 'coingecko' },
    },
  ];
  const latestPriceClient = {
    marketSnapshot: {
      findMany: async (args: LatestPriceQuery) => {
        latestPriceQueries.push(args);
        return latestPriceRows;
      },
    },
  };
  const latestPrices = await readLatestPrices(
    latestPriceClient as never,
    hourlyNow
  );
  const latestSol = latestPrices.find((row) => row.asset === 'solana');
  check(
    'a recent latest price capture is fresh',
    latestSol?.priceUsd === 150 &&
      latestSol.stale === false &&
      latestSol.ageMs === HOUR_MS
  );
  check(
    'the latest price query uses a 6h window',
    latestPriceQueries[0]?.where?.collectedAt?.gte?.getTime() ===
      hourlyNow.getTime() - HOURLY_WINDOW_HOURS * HOUR_MS
  );
  check(
    'the latest price query has a limit',
    (latestPriceQueries[0]?.take ?? 0) > 0
  );
  check(
    'the latest price query filters coingecko',
    latestPriceQueries[0]?.where?.source?.provider === 'coingecko'
  );

  const latestPricePage = renderOverview(emptyInput(), [], latestPrices);
  check(
    'latest prices integrate into the Prices table',
    latestPricePage.includes('<th>Asset</th><th>Closed</th><th>Latest</th>') &&
      !latestPricePage.includes('<h2>Latest price</h2>')
  );
  check(
    'integrated latest prices show SOL, BTC and ETH values, UTC and age',
    latestPricePage.includes('$150.00') &&
      latestPricePage.includes('$60,000.00') &&
      latestPricePage.includes('$3,000.00') &&
      latestPricePage.includes('2026-11-02 11:00 UTC') &&
      latestPricePage.includes('1h 0m')
  );
  check(
    'overview has a 300s meta refresh',
    latestPricePage.includes('<meta http-equiv="refresh" content="300">')
  );

  const stalePriceAt = new Date(
    hourlyNow.getTime() - (HOURLY_STALE_HOURS + 1) * HOUR_MS
  );
  const stalePriceRows = [
    {
      asset: 'solana',
      priceUsd: 99,
      collectedAt: stalePriceAt,
      source: { provider: 'coingecko' },
    },
  ];
  const stalePriceClient = {
    marketSnapshot: { findMany: async () => stalePriceRows },
  };
  const stalePrices = await readLatestPrices(
    stalePriceClient as never,
    hourlyNow
  );
  const staleSol = stalePrices.find((row) => row.asset === 'solana');
  check(
    'a latest price capture older than 3h is stale',
    staleSol?.stale === true &&
      staleSol.ageMs === (HOURLY_STALE_HOURS + 1) * HOUR_MS
  );
  const stalePricePage = renderOverview(emptyInput(), [], stalePrices);
  check(
    'a stale latest price shows value, age and stale marker',
    stalePricePage.includes('$99.00') &&
      stalePricePage.includes('4h 0m') &&
      stalePricePage.includes('stale')
  );

  const noPriceClient = {
    marketSnapshot: { findMany: async () => [] },
  };
  const noPrices = await readLatestPrices(noPriceClient as never, hourlyNow);
  check(
    'no latest price capture yields n/a fields',
    noPrices.every(
      (row) =>
        row.priceUsd === null &&
        row.collectedAt === null &&
        row.ageMs === null &&
        row.stale === false
    )
  );
  const noPricePage = renderOverview(emptyInput(), [], noPrices);
  check(
    'no latest price capture renders n/a in the latest column, never zero',
    noPricePage.includes('<th>Asset</th><th>Closed</th><th>Latest</th>') &&
      noPricePage.includes('<td>n/a</td>') &&
      !noPricePage.includes('$0.00')
  );

  const historyRows = [
    {
      asset: 'solana',
      priceUsd: 999,
      collectedAt: new Date(hourlyNow.getTime() - 10 * 60 * 1000),
      source: { provider: 'coingecko_history' },
    },
    {
      asset: 'solana',
      priceUsd: 100,
      collectedAt: new Date(hourlyNow.getTime() - 2 * HOUR_MS),
      source: { provider: 'coingecko' },
    },
  ];
  const historyClient = {
    marketSnapshot: { findMany: async () => historyRows },
  };
  const historyPrices = await readLatestPrices(
    historyClient as never,
    hourlyNow
  );
  const historySol = historyPrices.find((row) => row.asset === 'solana');
  check(
    'coingecko_history rows are ignored',
    historySol?.priceUsd === 100 && historySol.ageMs === 2 * HOUR_MS
  );
  const historyPage = renderOverview(emptyInput(), [], historyPrices);
  check(
    'coingecko_history values never appear in integrated prices',
    historyPage.includes('$100.00') &&
      !historyPage.includes('$999.00') &&
      !historyPage.includes('coingecko_history')
  );

  const sharePage = renderLaunchpads([
    {
      indicator: 'launchpad_dex_volume_share_7d',
      unit: 'FRACTION',
      platforms: emptyPlatforms.map((item) => ({
        slug: item.slug,
        series: emptySeries(
          'launchpad_dex_volume_share_7d',
          item.series.scope,
          'FRACTION'
        ),
      })),
    },
  ]);
  check(
    'share is labeled as among the 4 platforms covered',
    sharePage.includes('share among the 4 platforms covered')
  );
  const expectedPlatformList = LAUNCHPAD_SLUGS.map(
    (slug) => LAUNCHPAD_LABELS[slug] ?? slug
  ).join(', ');
  check(
    'share lists all 4 platforms',
    sharePage.includes(
      `share among the 4 platforms covered: ${expectedPlatformList}`
    )
  );

  const multiGap = renderMultiLineChart(
    [
      {
        label: 'test',
        points: [
          { date: '2026-01-01', value: 1 },
          { date: '2026-01-02', value: 2 },
          { date: '2026-01-04', value: 4 },
          { date: '2026-01-05', value: 5 },
        ],
      },
    ],
    { from: '2026-01-01', to: '2026-01-05', unit: 'FRACTION' }
  );
  check(
    'a gap in a multi-line chart keeps two segments',
    (multiGap.match(/class="chart-line"/g) ?? []).length === 2
  );

  const timeGap = renderTimeLineChart(
    [
      { at: new Date('2026-01-01T00:00:00.000Z'), value: 1 },
      { at: new Date('2026-01-01T06:00:00.000Z'), value: 2 },
      { at: new Date('2026-01-01T18:00:00.000Z'), value: 4 },
    ],
    {
      from: new Date('2026-01-01T00:00:00.000Z'),
      to: new Date('2026-01-02T00:00:00.000Z'),
      unit: 'USD',
      indicator: 'price_usd',
      gapMs: 9 * 60 * 60 * 1000,
    }
  );
  check(
    'a missing token capture splits the line into two segments',
    (timeGap.match(/class="chart-line"/g) ?? []).length === 2
  );

  const leveragePage = renderLeverageMacro(
    [emptySeries('oi_usd_change_1d_pct', 'coinalyze:SOL', 'PERCENT')],
    []
  );
  check('leverage & macro page shows n/a for an empty series', leveragePage.includes('n/a'));
  check(
    'leverage & macro page has the delay notice',
    leveragePage.includes(
      'Coinalyze leverage data is aggregated across exchanges; macro series have publication delays.'
    )
  );
  check('leverage & macro page has the dashboard footer', leveragePage.includes(DASHBOARD_FOOTER));

  const gapSeries: IndicatorSeries = {
    indicator: 'gap_test',
    scope: 'test',
    formulaVersion: 'test_v1',
    unit: 'PERCENT',
    from: '2026-01-01',
    to: '2026-01-05',
    points: [
      { date: '2026-01-01', value: 1 },
      { date: '2026-01-02', value: 2 },
      { date: '2026-01-04', value: 4 },
      { date: '2026-01-05', value: 5 },
    ],
  };
  const gapChart = renderLineChart(gapSeries);
  const segmentCount = (gapChart.match(/class="chart-line"/g) ?? []).length;
  check('a gap splits the line into two segments', segmentCount === 2);
  check('a gap never becomes a zero point', !gapChart.includes('data-value="0"'));
  check(
    'the chart title data shows the last value and date',
    latestValueText(gapSeries).includes('5') && latestValueText(gapSeries).includes('2026-01-05')
  );

  const health = renderDataHealth([], 'FAIL', '2026-11-01');
  check('data health shows the overall result', health.includes('FAIL'));
  check('data health renders n/a when there are no checks', health.includes('n/a'));
  check('data health has the dashboard footer', health.includes(DASHBOARD_FOOTER));

  const refreshMeta = '<meta http-equiv="refresh" content="300">';
  check(
    'data health has a 300s meta refresh',
    renderDataHealth([], 'OK', '2026-11-01').includes(refreshMeta)
  );
  check(
    'leverage & macro has a 300s meta refresh',
    renderLeverageMacro([], []).includes(refreshMeta)
  );
  check(
    'launchpads has a 300s meta refresh',
    renderLaunchpads([]).includes(refreshMeta)
  );
  check(
    'tokens has a 300s meta refresh',
    renderTokens([]).includes(refreshMeta)
  );

  const emptyTokensPage = renderTokens([]);
  check('tokens page shows n/a for an empty table', emptyTokensPage.includes('n/a'));
  check(
    'tokens page has the observed-tokens notice',
    emptyTokensPage.includes(
      'Values are among the 10 tokens observed, not a market rate.'
    )
  );
  check(
    'tokens page has the raw numbers notice',
    emptyTokensPage.includes(
      'Raw numbers only: no good/bad label, and sophisticated bot activity is not detected.'
    )
  );
  check(
    'tokens page has the GeckoTerminal notice',
    emptyTokensPage.includes(
      'Token data comes from GeckoTerminal and is captured 4 times a day.'
    )
  );
  check(
    'tokens page has the market cap/FDV notice',
    emptyTokensPage.includes(
      'Market cap uses circulating supply and FDV uses total supply, both as reported by GeckoTerminal. Ratios are raw numbers with no good/bad label.'
    )
  );
  check('tokens page has the dashboard footer', emptyTokensPage.includes(DASHBOARD_FOOTER));

  const fullAddress = tokenSummary().address;
  const tokenRowPage = renderTokens([tokenSummary()]);
  check(
    'token symbol links to the full address',
    tokenRowPage.includes(`href="/tokens/${encodeURIComponent(fullAddress)}"`)
  );
  check(
    'tokens table shows the full address',
    tokenRowPage.includes(`<td class="token-address">${fullAddress}</td>`)
  );
  check(
    'tokens table uses the requested column order',
    tokenRowPage.includes(
      '<th>Symbol</th><th>Address</th><th>Market cap</th><th>FDV</th><th>Price (USD)</th><th>Liquidity</th><th>Liquidity / market cap</th><th>Volume 24h</th><th>Volume 24h / market cap</th><th>Pools</th><th>Holders</th><th>Last capture (UTC)</th>'
    )
  );

  const tokenLatest = {
    capturedAt: new Date('2026-11-02T12:00:00.000Z'),
    priceUsd: 2,
    liquidityUsd: 1_000_000,
    volume24hUsd: 2_000_000,
    marketCapUsd: null as number | null,
    fdvUsd: null as number | null,
  };
  const nullMarketCapPage = renderTokens([tokenSummary({ latest: tokenLatest })]);
  check(
    'market cap null renders n/a',
    nullMarketCapPage.includes('<td class="token-market-cap">n/a')
  );
  check(
    'ratios are n/a when market cap is null',
    (nullMarketCapPage.match(/<td class="token-ratio">n\/a<\/td>/g) ?? []).length === 2
  );

  const zeroMarketCapPage = renderTokens([
    tokenSummary({
      latest: { ...tokenLatest, marketCapUsd: 0, fdvUsd: 0 },
    }),
  ]);
  check(
    'market cap zero does not divide',
    (zeroMarketCapPage.match(/<td class="token-ratio">n\/a<\/td>/g) ?? []).length === 2 &&
      !zeroMarketCapPage.includes('Infinity') &&
      !zeroMarketCapPage.includes('NaN')
  );

  const ratioPage = renderTokens([
    tokenSummary({
      latest: {
        ...tokenLatest,
        marketCapUsd: 100_000_000,
        fdvUsd: 120_000_000,
      },
    }),
  ]);
  check(
    'market cap and FDV use zero-decimal dollar formatting',
    ratioPage.includes('$100,000,000') && ratioPage.includes('$120,000,000')
  );
  check(
    'liquidity / market cap is a percentage',
    ratioPage.includes('<td class="token-ratio">1.00%</td>')
  );
  check(
    'volume / market cap is a percentage',
    ratioPage.includes('<td class="token-ratio">2.00%</td>')
  );

  const dirtyName = '\u202e<script>alert(1)</script>';
  const dirtyTokenDetail = renderTokenDetail(tokenDetail({ name: dirtyName }));
  check('token names strip bidi controls', !dirtyTokenDetail.includes('\u202e'));
  check(
    'token names are HTML escaped',
    !dirtyTokenDetail.includes('<script>') &&
      dirtyTokenDetail.includes('&lt;script&gt;')
  );

  const specialAddress = 'abc<def&ghi';
  const specialTokensPage = renderTokens([tokenSummary({ address: specialAddress })]);
  check(
    'special addresses are escaped in the table',
    specialTokensPage.includes('abc&lt;def&amp;ghi') &&
      !specialTokensPage.includes('<def')
  );
  check(
    'special addresses are encoded in links',
    specialTokensPage.includes(
      `href="/tokens/${encodeURIComponent(specialAddress)}"`
    )
  );
  check(
    'special addresses are escaped in the detail',
    renderTokenDetail(tokenDetail({ address: specialAddress })).includes(
      'abc&lt;def&amp;ghi'
    )
  );

  const latestAt = new Date('2026-11-02T12:00:00.000Z');
  const oneHourBefore = new Date(latestAt.getTime() - 60 * 60 * 1000);
  const twentyOneHoursBefore = new Date(latestAt.getTime() - 21 * 60 * 60 * 1000);
  check(
    'a previous capture under 20h is ignored',
    selectPreviousCapture(
      [{ capturedAt: oneHourBefore }, { capturedAt: latestAt }],
      latestAt
    ) === null
  );
  check(
    'a previous capture near 24h is used',
    selectPreviousCapture(
      [{ capturedAt: twentyOneHoursBefore }, { capturedAt: latestAt }],
      latestAt
    )?.capturedAt.getTime() === twentyOneHoursBefore.getTime()
  );
  check(
    'token variation shows n/a when the previous capture is too close',
    renderTokens([tokenSummary({ priceChangePct: null })]).includes('n/a')
  );

  const summaryNow = new Date('2026-11-02T12:00:00.000Z');
  const summaryCaptures = [
    {
      capturedAt: summaryNow,
      priceUsd: 2,
      liquidityUsd: 1_000_000,
      volume24hUsd: 2_000_000,
      marketCapUsd: 100_000_000,
      fdvUsd: 120_000_000,
      poolsObserved: 3,
      holder: { holdersCount: 1000 },
    },
    {
      capturedAt: new Date(summaryNow.getTime() - 60 * 60 * 1000),
      priceUsd: 1,
      liquidityUsd: 900_000,
      volume24hUsd: 1_800_000,
      marketCapUsd: 90_000_000,
      fdvUsd: 110_000_000,
      poolsObserved: 3,
      holder: { holdersCount: 900 },
    },
  ];
  const summaryClient = {
    token: {
      findMany: async () => [
        {
          address: fullAddress,
          name: 'Test Token',
          symbol: 'TEST',
          captures: summaryCaptures,
        },
      ],
    },
  };
  const marketCapSummaries = await readTokenSummaries(summaryClient as never, summaryNow);
  check(
    'market cap variation is n/a when the previous capture is under 20h',
    marketCapSummaries[0]?.marketCapChangePct === null
  );
  check(
    'market cap variation n/a is rendered',
    renderTokens(marketCapSummaries).includes(
      '$100,000,000 <span class="muted">(24h n/a)</span>'
    )
  );

  const gapNow = new Date('2026-11-02T12:00:00.000Z');
  const gapCaptures = [
    {
      capturedAt: new Date(gapNow.getTime() - 12 * 60 * 60 * 1000),
      priceUsd: 1,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: 100_000,
      fdvUsd: 120_000,
    },
    {
      capturedAt: new Date(gapNow.getTime() - 6 * 60 * 60 * 1000),
      priceUsd: 2,
      liquidityUsd: 1100,
      volume24hUsd: 2100,
      marketCapUsd: null,
      fdvUsd: null,
    },
    {
      capturedAt: gapNow,
      priceUsd: 3,
      liquidityUsd: 1200,
      volume24hUsd: 2200,
      marketCapUsd: 300_000,
      fdvUsd: 360_000,
    },
  ];
  const gapClient = {
    token: {
      findFirst: async () => ({
        address: fullAddress,
        name: 'Test Token',
        symbol: 'TEST',
      }),
    },
    tokenCapture: {
      findMany: async () => gapCaptures,
      findFirst: async () => ({ ...gapCaptures[2], pools: [], holder: null }),
    },
  };
  const gapDetail = await readTokenDetail(gapClient as never, fullAddress, gapNow);
  check(
    'a null market cap capture is omitted, not zero',
    gapDetail !== null &&
      gapDetail.marketCapPoints.length === 2 &&
      gapDetail.marketCapPoints.every((point) => point.value !== 0)
  );
  const marketCapGapChart = renderTimeLineChart(gapDetail?.marketCapPoints ?? [], {
    from: new Date(`${gapDetail?.from ?? '2026-10-20'}T00:00:00.000Z`),
    to: new Date(`${gapDetail?.to ?? '2026-11-02'}T23:59:59.999Z`),
    unit: 'USD',
    indicator: 'market_cap_usd',
    gapMs: 9 * 60 * 60 * 1000,
  });
  check(
    'a null market cap capture becomes a chart gap',
    (marketCapGapChart.match(/class="chart-line"/g) ?? []).length === 2 &&
      !marketCapGapChart.includes('data-value="0"')
  );

  const estimateNow = new Date('2026-11-02T12:00:00.000Z');
  const estimateOldAt = new Date(estimateNow.getTime() - 6 * 60 * 60 * 1000);
  const estimateCaptures = [
    {
      capturedAt: estimateOldAt,
      priceUsd: 0.5,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: null,
      fdvUsd: null,
    },
    {
      capturedAt: estimateNow,
      priceUsd: 1,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: 100,
      fdvUsd: 120,
    },
  ];
  const estimateClient = {
    token: {
      findFirst: async () => ({
        address: fullAddress,
        name: 'Test Token',
        symbol: 'TEST',
      }),
    },
    tokenCapture: {
      findMany: async () => estimateCaptures,
      findFirst: async () => ({ ...estimateCaptures[1], pools: [], holder: null }),
    },
  };
  const estimateDetail = await readTokenDetail(
    estimateClient as never,
    fullAddress,
    estimateNow
  );
  check(
    'implied supply comes from the latest reported market cap',
    estimateDetail?.impliedSupply === 100
  );
  check(
    'an old capture without market cap is estimated from price',
    estimateDetail?.marketCapEstimatedPoints.length === 1 &&
      estimateDetail.marketCapEstimatedPoints[0]?.value === 50
  );
  check(
    'a capture with reported market cap uses the reported value',
    estimateDetail?.marketCapPoints.length === 1 &&
      estimateDetail.marketCapPoints[0]?.value === 100
  );
  check(
    'reported captures are not duplicated in the estimated series',
    estimateDetail?.marketCapEstimatedPoints.every(
      (point) => point.at.getTime() !== estimateNow.getTime()
    ) ?? false
  );

  const reportedOldAt = new Date(estimateNow.getTime() - 12 * 60 * 60 * 1000);
  const reportedCaptures = [
    {
      capturedAt: reportedOldAt,
      priceUsd: 1,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: 80,
      fdvUsd: 100,
    },
    {
      capturedAt: estimateNow,
      priceUsd: 2,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: 200,
      fdvUsd: 240,
    },
  ];
  const reportedClient = {
    token: {
      findFirst: async () => ({
        address: fullAddress,
        name: 'Test Token',
        symbol: 'TEST',
      }),
    },
    tokenCapture: {
      findMany: async () => reportedCaptures,
      findFirst: async () => ({ ...reportedCaptures[1], pools: [], holder: null }),
    },
  };
  const reportedDetail = await readTokenDetail(
    reportedClient as never,
    fullAddress,
    estimateNow
  );
  check(
    'a reported capture is not replaced by an estimate',
    reportedDetail?.marketCapPoints.length === 2 &&
      reportedDetail.marketCapPoints[0]?.value === 80 &&
      reportedDetail.marketCapEstimatedPoints.length === 0
  );

  const noSupplyNow = new Date('2026-11-02T12:00:00.000Z');
  const noSupplyCaptures = [
    {
      capturedAt: new Date(noSupplyNow.getTime() - 6 * 60 * 60 * 1000),
      priceUsd: 0.5,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: null,
      fdvUsd: null,
    },
    {
      capturedAt: noSupplyNow,
      priceUsd: 1,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: null,
      fdvUsd: null,
    },
  ];
  const noSupplyClient = {
    token: {
      findFirst: async () => ({
        address: fullAddress,
        name: 'Test Token',
        symbol: 'TEST',
      }),
    },
    tokenCapture: {
      findMany: async () => noSupplyCaptures,
      findFirst: async () => ({ ...noSupplyCaptures[1], pools: [], holder: null }),
    },
  };
  const noSupplyDetail = await readTokenDetail(
    noSupplyClient as never,
    fullAddress,
    noSupplyNow
  );
  check(
    'no reported market cap means no estimated series',
    noSupplyDetail?.impliedSupply === null &&
      noSupplyDetail.marketCapEstimatedPoints.length === 0
  );
  check(
    'a missing estimated series renders n/a',
    noSupplyDetail !== null && renderTokenDetail(noSupplyDetail).includes('Estimated: n/a')
  );

  const priceGapNow = new Date('2026-11-02T12:00:00.000Z');
  const priceGapCaptures = [
    {
      capturedAt: new Date(priceGapNow.getTime() - 12 * 60 * 60 * 1000),
      priceUsd: null,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: null,
      fdvUsd: null,
    },
    {
      capturedAt: new Date(priceGapNow.getTime() - 9 * 60 * 60 * 1000),
      priceUsd: 0,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: null,
      fdvUsd: null,
    },
    {
      capturedAt: new Date(priceGapNow.getTime() - 3 * 60 * 60 * 1000),
      priceUsd: 0.5,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: null,
      fdvUsd: null,
    },
    {
      capturedAt: priceGapNow,
      priceUsd: 1,
      liquidityUsd: 1000,
      volume24hUsd: 2000,
      marketCapUsd: 100,
      fdvUsd: 120,
    },
  ];
  const priceGapClient = {
    token: {
      findFirst: async () => ({
        address: fullAddress,
        name: 'Test Token',
        symbol: 'TEST',
      }),
    },
    tokenCapture: {
      findMany: async () => priceGapCaptures,
      findFirst: async () => ({ ...priceGapCaptures[3], pools: [], holder: null }),
    },
  };
  const priceGapDetail = await readTokenDetail(
    priceGapClient as never,
    fullAddress,
    priceGapNow
  );
  check(
    'captures with null or zero price are omitted from the estimate',
    priceGapDetail?.marketCapEstimatedPoints.length === 1 &&
      priceGapDetail.marketCapEstimatedPoints[0]?.value === 50 &&
      priceGapDetail.marketCapEstimatedPoints.every((point) => point.value > 0)
  );

  const combinedDetail = tokenDetail({
    marketCapPoints: [{ at: new Date('2026-11-01T00:00:00.000Z'), value: 100 }],
    marketCapEstimatedPoints: [
      { at: new Date('2026-11-01T06:00:00.000Z'), value: 50 },
    ],
    impliedSupply: 100,
  });
  const combinedPage = renderTokenDetail(combinedDetail);
  check('market cap chart has the reported legend', combinedPage.includes('Reported'));
  check(
    'market cap chart has the estimated legend',
    combinedPage.includes('Estimated (price × latest implied supply)')
  );
  check(
    'estimated market cap series is dashed',
    combinedPage.includes('data-dashed="true"') &&
      combinedPage.includes('stroke-dasharray="6 4"')
  );
  check(
    'market cap estimate notice is present',
    combinedPage.includes(
      "Estimated market cap applies today's implied circulating supply to past prices; unlocks, burns and mints are not reflected, so it can be far from the true historical value."
    )
  );

  const emptyTokenDetail = renderTokenDetail(tokenDetail());
  check('token detail shows n/a for empty data', emptyTokenDetail.includes('n/a'));
  check(
    'token detail shows the full address',
    emptyTokenDetail.includes(`<p class="muted token-address">${fullAddress}</p>`)
  );
  check(
    'token detail has the raw numbers notice',
    emptyTokenDetail.includes(
      'Raw numbers only: no good/bad label, and sophisticated bot activity is not detected.'
    )
  );
  check(
    'token detail has the GeckoTerminal notice',
    emptyTokenDetail.includes(
      'Token data comes from GeckoTerminal and is captured 4 times a day.'
    )
  );
  check(
    'token detail has the market cap/FDV notice',
    emptyTokenDetail.includes(
      'Market cap uses circulating supply and FDV uses total supply, both as reported by GeckoTerminal. Ratios are raw numbers with no good/bad label.'
    )
  );
  check(
    'token detail has the dashboard footer',
    emptyTokenDetail.includes(DASHBOARD_FOOTER)
  );

  const notFoundServer = createDashboardServer({
    getClient: async () =>
      ({ token: { findFirst: async () => null } }) as never,
  });
  await new Promise<void>((resolve, reject) => {
    notFoundServer.once('error', reject);
    notFoundServer.listen(0, HOST, () => resolve());
  });
  const notFoundAddress = notFoundServer.address();
  const notFoundPort =
    notFoundAddress !== null && typeof notFoundAddress === 'object'
      ? notFoundAddress.port
      : 0;
  const missingToken = await requestStatus(notFoundPort, 'GET', '/tokens/unknown');
  check('an unknown token address returns 404', missingToken.status === 404);
  await new Promise<void>((resolve) => notFoundServer.close(() => resolve()));

  const detailClient = {
    token: {
      findFirst: async () => ({
        address: fullAddress,
        name: 'Test Token',
        symbol: 'TEST',
      }),
    },
    tokenCapture: {
      findMany: async () => [],
      findFirst: async () => null,
    },
  };
  const detailServer = createDashboardServer({
    getClient: async () => detailClient as never,
  });
  await new Promise<void>((resolve, reject) => {
    detailServer.once('error', reject);
    detailServer.listen(0, HOST, () => resolve());
  });
  const detailAddress = detailServer.address();
  const detailPort =
    detailAddress !== null && typeof detailAddress === 'object'
      ? detailAddress.port
      : 0;
  const foundToken = await requestStatus(
    detailPort,
    'GET',
    `/tokens/${encodeURIComponent(fullAddress)}`
  );
  check('a full token address returns 200', foundToken.status === 200);
  check(
    'the full token address detail shows the full address',
    foundToken.body.includes(fullAddress)
  );
  await new Promise<void>((resolve) => detailServer.close(() => resolve()));

  const directory = dirname(fileURLToPath(import.meta.url));
  const writePattern = /(?:\b(?:create|update|upsert|delete)\s*\(|executeRaw|rawPayload)/;
  const sources = readdirSync(directory).filter(
    (file) => file.endsWith('.ts') && file !== 'test-dashboard.ts'
  );
  for (const file of sources) {
    const source = readFileSync(join(directory, file), 'utf8');
    check(`${file} has no write operations`, !writePattern.test(source));
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(
    '[FATAL]',
    error instanceof Error ? error.message : String(error).slice(0, 300)
  );
  process.exitCode = 1;
});
