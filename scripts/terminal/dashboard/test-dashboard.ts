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
  check('tokens page has the dashboard footer', emptyTokensPage.includes(DASHBOARD_FOOTER));

  const dirtyName = '\u202e<script>alert(1)</script>';
  const dirtyTokensPage = renderTokens([tokenSummary({ name: dirtyName })]);
  check('token names strip bidi controls', !dirtyTokensPage.includes('\u202e'));
  check(
    'token names are HTML escaped',
    !dirtyTokensPage.includes('<script>') &&
      dirtyTokensPage.includes('&lt;script&gt;')
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

  const emptyTokenDetail = renderTokenDetail(tokenDetail());
  check('token detail shows n/a for empty data', emptyTokenDetail.includes('n/a'));
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
