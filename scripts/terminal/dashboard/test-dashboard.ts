#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDashboardServer, HOST } from './server';
import { DASHBOARD_FOOTER, renderDataHealth, renderLeverageMacro, renderOverview } from './pages';
import { latestValueText, renderLineChart } from './charts';
import type { IndicatorSeries } from './series-reader';
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

  const directory = dirname(fileURLToPath(import.meta.url));
  const writePattern = /(?:\b(?:create|update|upsert|delete)\s*\(|executeRaw)/;
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
