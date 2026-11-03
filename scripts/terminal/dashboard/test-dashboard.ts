#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer, HOST } from './server';
import {
  DASHBOARD_FOOTER,
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
