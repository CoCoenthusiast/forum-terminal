#!/usr/bin/env node

const REQUEST_TIMEOUT_MS = 15_000;
const PAUSE_BETWEEN_CALLS_MS = 3_000;
const FED_TEXT_PREVIEW_CHARS = 400;
const BLS_SERIES_IDS = ['CUSR0000SA0', 'CUSR0000SA0L1E', 'LNS14000000', 'CES0000000001'] as const;
const ABSENT = 'AUSENTE';

type HttpMethod = 'GET' | 'POST';
type Extractor = (body: string, contentType: string) => string;

interface Target {
  name: string;
  url: string;
  method: HttpMethod;
  headers?: Record<string, string>;
  body?: string;
  extract: Extractor;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) {
    return ABSENT;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return JSON.stringify(value) ?? ABSENT;
  } catch {
    return ABSENT;
  }
}

function displayKeys(value: Record<string, unknown>): string {
  const keys = Object.keys(value);
  return keys.length === 0 ? '[]' : keys.join(', ');
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function extractHyperliquidMeta(body: string): string {
  const data = parseJson(body);

  if (!Array.isArray(data) || data.length < 2) {
    return ABSENT;
  }

  const meta = isRecord(data[0]) ? data[0] : null;
  const assetCtxs = Array.isArray(data[1]) ? data[1] : null;
  const universe = meta && Array.isArray(meta.universe) ? meta.universe : null;

  if (!universe || !assetCtxs) {
    return ABSENT;
  }

  return ['SOL', 'BTC', 'ETH']
    .map((name) => {
      const index = universe.findIndex((entry) => isRecord(entry) && entry.name === name);

      if (index < 0) {
        return `${name}=${ABSENT}`;
      }

      const universeEntry = universe[index];
      const context = assetCtxs[index];

      if (!isRecord(context)) {
        return `${name}=${ABSENT}`;
      }

      const universeName = isRecord(universeEntry) ? universeEntry.name : undefined;
      const resolvedName = context.name ?? universeName ?? name;

      return [
        name,
        `name=${displayValue(resolvedName)}`,
        `funding=${displayValue(context.funding)}`,
        `openInterest=${displayValue(context.openInterest)}`,
        `dayNtlVlm=${displayValue(context.dayNtlVlm)}`,
        `markPx=${displayValue(context.markPx)}`,
        `oraclePx=${displayValue(context.oraclePx)}`,
        `premium=${displayValue(context.premium)}`,
      ].join(' ');
    })
    .join('; ');
}

function extractHyperliquidFunding(body: string): string {
  const data = parseJson(body);

  if (!Array.isArray(data)) {
    return ABSENT;
  }

  const formatRecord = (record: unknown): string => {
    if (!isRecord(record)) {
      return ABSENT;
    }

    return `{time=${displayValue(record.time)}, fundingRate=${displayValue(record.fundingRate)}}`;
  };

  return `registros=${data.length} primeiro=${formatRecord(data[0])} ultimo=${formatRecord(data[data.length - 1])}`;
}

function extractDydxMarkets(body: string): string {
  const data = parseJson(body);
  const markets = isRecord(data) && isRecord(data.markets) ? data.markets : null;
  const sol = markets && isRecord(markets['SOL-USD']) ? markets['SOL-USD'] : null;

  if (!sol) {
    return `chaves=${ABSENT}; openInterest=${ABSENT}; nextFundingRate=${ABSENT}; volume24H=${ABSENT}`;
  }

  return [
    `chaves=${displayKeys(sol)}`,
    `openInterest=${displayValue(sol.openInterest)}`,
    `nextFundingRate=${displayValue(sol.nextFundingRate)}`,
    `volume24H=${displayValue(sol.volume24H)}`,
  ].join('; ');
}

function extractDydxHistorical(body: string): string {
  const data = parseJson(body);
  const records =
    isRecord(data) && Array.isArray(data.historicalFunding)
      ? data.historicalFunding
      : Array.isArray(data)
        ? data
        : null;

  if (!records || records.length === 0) {
    return ABSENT;
  }

  return `primeiro=${displayValue(records[0])}`;
}

function extractNyFed(body: string): string {
  const data = parseJson(body);
  const refRates = isRecord(data) && Array.isArray(data.refRates) ? data.refRates : null;
  const first = refRates?.[0];

  if (!isRecord(first)) {
    return `chaves=${ABSENT}`;
  }

  return `chaves=${displayKeys(first)}`;
}

function findLastEntry(xml: string): string | null {
  const entries = xml.match(/<(?:[\w.-]+:)?entry\b[\s\S]*?<\/(?:[\w.-]+:)?entry>/gi);

  if (!entries || entries.length === 0) {
    return null;
  }

  return entries[entries.length - 1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlTagValue(xml: string, tagName: string): string | null {
  const tag = escapeRegExp(tagName);
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${tag}>`,
    'i'
  );
  const match = pattern.exec(xml);

  if (!match || match[1] === undefined) {
    return null;
  }

  const value = match[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .trim();

  return value.length > 0 ? value : null;
}

function xmlFieldNames(entry: string): string[] {
  const names = new Set<string>();
  const pattern = /<(?:[\w.-]+:)?([A-Z][A-Z0-9_]*)\b[^>]*>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(entry)) !== null) {
    const name = match[1];

    if (name !== undefined) {
      names.add(name);
    }
  }

  return [...names];
}

function displayFieldNames(names: readonly string[]): string {
  return names.length === 0 ? '[]' : names.join(', ');
}

function extractTreasuryYieldXml(body: string): string {
  const entry = findLastEntry(body);

  if (!entry) {
    return ABSENT;
  }

  return [
    `campos=${displayFieldNames(xmlFieldNames(entry))}`,
    `BC_2YEAR=${displayValue(xmlTagValue(entry, 'BC_2YEAR'))}`,
    `BC_10YEAR=${displayValue(xmlTagValue(entry, 'BC_10YEAR'))}`,
    `data=${displayValue(xmlTagValue(entry, 'NEW_DATE'))}`,
  ].join('; ');
}

function extractTreasuryCsv(body: string): string {
  const lines = body
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return `cabeçalho=${ABSENT}; primeira=${ABSENT}; segunda=${ABSENT}`;
  }

  return [
    `cabeçalho=${displayValue(lines[0])}`,
    `primeira=${displayValue(lines[1])}`,
    `segunda=${displayValue(lines[2])}`,
  ].join('; ');
}

function isHtmlBody(body: string, contentType: string): boolean {
  const type = contentType.toLowerCase();
  const start = body.trimStart().toLowerCase();
  return type.includes('text/html') || start.startsWith('<!doctype html') || start.startsWith('<html');
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFedH10(body: string, contentType: string): string {
  const html = isHtmlBody(body, contentType);
  const base = `Content-Type=${displayValue(contentType)}; HTML=${html ? 'sim' : 'não'}`;

  if (!html) {
    return base;
  }

  const text = stripHtml(body);
  const preview = text.length > 0 ? text.slice(0, FED_TEXT_PREVIEW_CHARS) : ABSENT;

  return [
    base,
    `texto=${preview}`,
    `contém JRXWTFB_N.B=${body.includes('JRXWTFB_N.B') ? 'sim' : 'não'}`,
  ].join('; ');
}

function extractBls(body: string): string {
  const data = parseJson(body);
  const results = isRecord(data) && isRecord(data.Results) ? data.Results : null;
  const seriesList = results && Array.isArray(results.series) ? results.series : null;

  return BLS_SERIES_IDS.map((seriesId) => {
    const series = seriesList?.find((entry) => isRecord(entry) && entry.seriesID === seriesId);

    if (!isRecord(series)) {
      return `${seriesId}=${ABSENT}`;
    }

    const dataItems = Array.isArray(series.data) ? series.data : null;
    const latest = dataItems?.find(
      (item) => isRecord(item) && (item.latest === 'true' || item.latest === true)
    );

    if (!isRecord(latest)) {
      return `${seriesId}=${ABSENT}`;
    }

    const hasFootnotes = Object.prototype.hasOwnProperty.call(latest, 'footnotes');

    return [
      seriesId,
      `year=${displayValue(latest.year)}`,
      `period=${displayValue(latest.period)}`,
      `value=${displayValue(latest.value)}`,
      `footnotes=${hasFootnotes ? 'sim' : 'não'}`,
    ].join(' ');
  }).join('; ');
}

function xmlAttribute(attributes: string, name: string): string | null {
  const pattern = new RegExp(
    `\\b${escapeRegExp(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i'
  );
  const match = pattern.exec(attributes);
  return match ? match[1] ?? match[2] ?? null : null;
}

function extractEcbXml(body: string): string {
  let date: string | null = null;
  let usd: string | null = null;
  const pattern = /<Cube\b([^>]*)>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    const attributes = match[1];

    if (attributes === undefined) {
      continue;
    }

    if (date === null) {
      date = xmlAttribute(attributes, 'time');
    }

    if (usd === null) {
      const currency = xmlAttribute(attributes, 'currency');
      const rate = xmlAttribute(attributes, 'rate');

      if (currency === 'USD' && rate !== null) {
        usd = rate;
      }
    }
  }

  return `data=${displayValue(date)}; USD=${displayValue(usd)}`;
}

function extractEcbCsv(body: string): string {
  const lines = body
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) {
    return `cabeçalho=${ABSENT}; linhas=${ABSENT}`;
  }

  const header = lines[0];
  const rows = lines.slice(1);

  return [
    `cabeçalho=${displayValue(header)}`,
    `linhas=${rows.length > 0 ? rows.join(' | ') : ABSENT}`,
  ].join('; ');
}

function extractTreasuryRealXml(body: string): string {
  const entry = findLastEntry(body);

  if (!entry) {
    return ABSENT;
  }

  const fiveYear = xmlTagValue(entry, 'TC_5YEAR') ?? xmlTagValue(entry, 'BC_5YEAR');
  const tenYear = xmlTagValue(entry, 'TC_10YEAR') ?? xmlTagValue(entry, 'BC_10YEAR');

  return [
    `campos=${displayFieldNames(xmlFieldNames(entry))}`,
    `5Y=${displayValue(fiveYear)}`,
    `10Y=${displayValue(tenYear)}`,
    `data=${displayValue(xmlTagValue(entry, 'NEW_DATE'))}`,
  ].join('; ');
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
      extract: extractHyperliquidMeta,
    },
    {
      name: '2 Hyperliquid fundingHistory SOL',
      url: 'https://api.hyperliquid.xyz/info',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'fundingHistory', coin: 'SOL', startTime }),
      extract: extractHyperliquidFunding,
    },
    {
      name: '3 dYdX perpetualMarkets SOL-USD',
      url: 'https://indexer.dydx.trade/v4/perpetualMarkets?ticker=SOL-USD',
      method: 'GET',
      extract: extractDydxMarkets,
    },
    {
      name: '4 dYdX historicalFunding SOL-USD',
      url: 'https://indexer.dydx.trade/v4/historicalFunding/SOL-USD?limit=5',
      method: 'GET',
      extract: extractDydxHistorical,
    },
    {
      name: '5 NY Fed SOFR',
      url: 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json',
      method: 'GET',
      extract: extractNyFed,
    },
    {
      name: '6 NY Fed EFFR',
      url: 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json',
      method: 'GET',
      extract: extractNyFed,
    },
    {
      name: '7 Treasury yield curve XML',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=202610',
      method: 'GET',
      extract: extractTreasuryYieldXml,
    },
    {
      name: '8 Treasury yield curve CSV',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/2026/all?type=daily_treasury_yield_curve&field_tdr_date_value=2026&page&_format=csv',
      method: 'GET',
      extract: extractTreasuryCsv,
    },
    {
      name: '9 Fed H.10 CSV',
      url: 'https://www.federalreserve.gov/datadownload/DownloadTable.aspx?filetype=csv&label=include&lastobs=30&layout=seriescolumn&rel=H10&series=122e3bcb627e8e53f1bf72a1a09cfb81&type=package',
      method: 'GET',
      extract: extractFedH10,
    },
    {
      name: '9b Fed H.10 CSV Output.aspx',
      url: 'https://www.federalreserve.gov/datadownload/Output.aspx?rel=H10&series=122e3bcb627e8e53f1bf72a1a09cfb81&lastobs=30&from=&to=&filetype=csv&label=include&layout=seriescolumn',
      method: 'GET',
      extract: extractFedH10,
    },
    {
      name: '10 BLS CPI and labor',
      url: 'https://api.bls.gov/publicAPI/v2/timeseries/data/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"seriesid":["CUSR0000SA0","CUSR0000SA0L1E","LNS14000000","CES0000000001"],"startyear":"2025","endyear":"2026"}',
      extract: extractBls,
    },
    {
      name: '11 ECB EUR/USD XML',
      url: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      method: 'GET',
      extract: extractEcbXml,
    },
    {
      name: '11b ECB EUR/USD CSV',
      url: 'https://data-api.ecb.europa.eu/service/data/EXR/D.USD.EUR.SP00.A?lastNObservations=5&format=csvdata',
      method: 'GET',
      extract: extractEcbCsv,
    },
    {
      name: '12 Treasury real yield XML',
      url: 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_real_yield_curve&field_tdr_date_value_month=202610',
      method: 'GET',
      extract: extractTreasuryRealXml,
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
    let fields: string;

    try {
      fields = target.extract(body, contentType);
    } catch {
      fields = ABSENT;
    }

    console.log(`Status: ${response.status}`);
    console.log(`Tempo: ${ms} ms`);
    console.log(`Content-Type: ${contentType}`);
    console.log(`Campos: ${fields}`);

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
    console.log(`Campos: ${ABSENT}`);
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
      console.log(`Campos: ${ABSENT} (domínio bloqueado por 429)`);
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
