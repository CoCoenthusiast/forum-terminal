#!/usr/bin/env node

const REQUEST_TIMEOUT_MS = 15_000;
const PAUSE_BETWEEN_CALLS_MS = 3_000;
const BODY_PREVIEW_CHARS = 200;

type HttpMethod = 'GET' | 'POST';

interface Target {
  name: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
}

interface ProbeResult {
  target: string;
  status: string;
  httpStatus: number | null;
  ms: number;
}

interface SummaryRow {
  target: string;
  status: string;
  ms: number;
}

function buildTargets(): Target[] {
  const startTime = Date.now() - 2 * 24 * 60 * 60 * 1000;

  return [
    {
      name: '1 Hyperliquid metaAndAssetCtxs',
      url: 'https://api.hyperliquid.xyz/info',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"type":"metaAndAssetCtxs"}',
    },
    {
      name: '2 Hyperliquid fundingHistory SOL',
      url: 'https://api.hyperliquid.xyz/info',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin: 'SOL', startTime }),
    },
    {
      name: '3 dYdX perpetualMarkets SOL-USD',
      url: 'https://indexer.dydx.trade/v4/perpetualMarkets?ticker=SOL-USD',
      method: 'GET',
    },
    {
      name: '4 dYdX historicalFunding SOL-USD',
      url: 'https://indexer.dydx.trade/v4/historicalFunding/SOL-USD?limit=5',
      method: 'GET',
    },
    {
      name: '5 NY Fed SOFR',
      url: 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json',
      method: 'GET',
    },
    {
      name: '6 NY Fed EFFR',
      url: 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json',
      method: 'GET',
    },
    {
      name: '7 Treasury yield curve XML',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=202610',
      method: 'GET',
    },
    {
      name: '8 Treasury yield curve CSV',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv',
      method: 'GET',
    },
    {
      name: '9 Fed H.10 CSV',
      url: 'https://www.federalreserve.gov/datadownload/DownloadTable.aspx?filetype=csv&label=include&lastobs=30&layout=seriescolumn&rel=H10&series=122e3bcb627e8e53f1bf72a1a09cfb81&type=package',
      method: 'GET',
    },
    {
      name: '10 BLS CPI and labor',
      url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"seriesid":["CUSR0000SA0","CUSR0000SA0L1E","LNS14000000","CES0000000001"],"startyear":"2025","endyear":"2026"}',
    },
    {
      name: '11 ECB EUR/USD XML',
      url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      method: 'GET',
    },
    {
      name: '12 Treasury real yield XML',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_real_yield_curve&field_tdr_date_value_month=202610',
      method: 'GET',
    },
  ];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function targetDomain(target: Target): string {
  return new URL(target.url).hostname;
}

async function probe(target: Target): Promise<ProbeResult> {
  console.log(`\n=== ${target.name} ===`);
  console.log(`URL: ${target.url}`);
  console.log(`Method: ${target.method}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(target.url, {
      method: target.method,
      headers: target.headers,
      body: target.body,
      signal: controller.signal,
    });
    const body = await response.text();
    const ms = Date.now() - startedAt;
    const contentType = response.headers.get('content-type') ?? '(none)';

    console.log(`Status: ${response.status}`);
    console.log(`Tempo: ${ms} ms`);
    console.log(`Content-Type: ${contentType}`);
    console.log(`Body (first ${BODY_PREVIEW_CHARS} chars): ${body.slice(0, BODY_PREVIEW_CHARS)}`);

    return {
      target: target.name,
      status: String(response.status),
      httpStatus: response.status,
      ms,
    };
  } catch (error) {
    const ms = Date.now() - startedAt;
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    const status = isTimeout ? 'TIMEOUT' : 'ERROR';

    console.log(`Status: ${status}`);
    console.log(`Tempo: ${ms} ms`);
    console.log('Content-Type: n/a');
    console.log(`Body (first ${BODY_PREVIEW_CHARS} chars): n/a`);
    if (!isTimeout) {
      console.log(`Erro: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { target: target.name, status, httpStatus: null, ms };
  } finally {
    clearTimeout(timer);
  }
}

function printSummary(results: readonly SummaryRow[]): void {
  console.log('\n=== RESUMO ===');

  const targetWidth = Math.max('Alvo'.length, ...results.map((row) => row.target.length));
  const statusWidth = Math.max('Status'.length, ...results.map((row) => row.status.length));
  const msWidth = Math.max('ms'.length, ...results.map((row) => String(row.ms).length));

  console.log(
    `${'Alvo'.padEnd(targetWidth)} | ${'Status'.padEnd(statusWidth)} | ${'ms'.padStart(msWidth)}`
  );
  console.log(`${'-'.repeat(targetWidth)}-+-${'-'.repeat(statusWidth)}-+-${'-'.repeat(msWidth)}`);

  for (const row of results) {
    console.log(
      `${row.target.padEnd(targetWidth)} | ${row.status.padEnd(statusWidth)} | ${String(row.ms).padStart(msWidth)}`
    );
  }
}

async function main(): Promise<void> {
  const targets = buildTargets();
  const blockedDomains = new Set<string>();
  const results: ProbeResult[] = [];

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    const domain = targetDomain(target);

    if (blockedDomains.has(domain)) {
      console.log(`\n=== ${target.name} ===`);
      console.log(`SKIP: domínio ${domain} já retornou 429 nesta execução`);
      results.push({ target: target.name, status: 'SKIP', httpStatus: null, ms: 0 });
      continue;
    }

    const result = await probe(target);
    results.push(result);

    if (result.httpStatus === 429) {
      blockedDomains.add(domain);
    }

    if (index < targets.length - 1) {
      await sleep(PAUSE_BETWEEN_CALLS_MS);
    }
  }

  printSummary(results);
}

main().catch((error) => {
  console.error('[FATAL]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
