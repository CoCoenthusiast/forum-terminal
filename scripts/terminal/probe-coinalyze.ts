#!/usr/bin/env node

const API_BASE = 'https://api.coinalyze.net/v1';
const PAUSE_BETWEEN_CALLS_MS = 3_000;
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_PREVIEW_CHARS = 200;
const ABSENT = 'AUSENTE';
const SYMBOLS = ['SOLUSDT_PERP.A', 'BTCUSDT_PERP.A', 'ETHUSDT_PERP.A'] as const;
const MARKET_ASSETS = ['SOL', 'BTC', 'ETH'] as const;

interface FetchOutcome {
  status: number;
  ms: number;
  body: string;
  retryAfter: string | null;
}

interface SummaryRow {
  target: string;
  status: string;
  ms: number | null;
}

interface Target {
  name: string;
  path: string;
  render: (payload: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

function sanitize(value: string): string {
  const key = process.env.COINALYZE_API_KEY;
  const redacted =
    key !== undefined && key !== '' ? value.split(key).join('[REDACTED]') : value;

  return redacted
    .replace(/\p{C}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function display(value: unknown): string {
  if (value === undefined) return ABSENT;
  if (value === null) return 'null';

  if (typeof value === 'string') {
    return sanitize(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  try {
    return sanitize(JSON.stringify(value) ?? ABSENT);
  } catch {
    return ABSENT;
  }
}

function toIsoUtc(value: unknown): string {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(seconds)) return ABSENT;

  const milliseconds = Math.abs(seconds) >= 1_000_000_000_000 ? seconds : seconds * 1000;
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? ABSENT : date.toISOString();
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printMarkets(payload: unknown): void {
  const markets = asArray(payload);

  if (markets === null) {
    console.log(`mercados=${ABSENT}`);
    return;
  }

  console.log(`mercados_total=${markets.length}`);

  for (const asset of MARKET_ASSETS) {
    const matches = markets.filter(
      (market): market is Record<string, unknown> =>
        isRecord(market) && market.base_asset === asset && market.is_perpetual === true
    );

    console.log(`${asset}_perpetuos=${matches.length}`);

    for (const market of matches.slice(0, 3)) {
      console.log(
        [
          `symbol=${display(market.symbol)}`,
          `exchange=${display(market.exchange)}`,
          `margined=${display(market.margined)}`,
          `oi_lq_vol_denominated_in=${display(market.oi_lq_vol_denominated_in)}`,
        ].join(' ')
      );
    }
  }
}

function printCurrentRates(payload: unknown, includeUpdate: boolean): void {
  const rows = asArray(payload);

  if (rows === null) {
    console.log(`registros=${ABSENT}`);
    return;
  }

  for (const symbol of SYMBOLS) {
    const row = rows.find((entry) => isRecord(entry) && entry.symbol === symbol);

    if (!isRecord(row)) {
      console.log(`${symbol} ${ABSENT}`);
      continue;
    }

    const parts = [`symbol=${display(row.symbol)}`, `value=${display(row.value)}`];

    if (includeUpdate) {
      parts.push(`update=${toIsoUtc(row.update)}`);
    }

    console.log(parts.join(' '));
  }
}

function printFundingRates(payload: unknown): void {
  const rows = asArray(payload);

  if (rows === null) {
    console.log(`registros=${ABSENT}`);
    return;
  }

  for (const symbol of SYMBOLS) {
    const row = rows.find((entry) => isRecord(entry) && entry.symbol === symbol);

    if (!isRecord(row)) {
      console.log(`${symbol} ${ABSENT}`);
      continue;
    }

    console.log(
      `symbol=${display(row.symbol)} value=${display(row.value)} update=${toIsoUtc(row.update)}`
    );
  }
}

function historyPoints(payload: unknown): unknown[] | null {
  const root = asRecord(payload);

  if (root !== null) {
    const direct = asArray(root.history);
    if (direct !== null) return direct;
  }

  const entries = asArray(payload);
  if (entries === null) return null;

  for (const entry of entries) {
    if (isRecord(entry)) {
      const history = asArray(entry.history);
      if (history !== null) return history;
    }
  }

  return entries;
}

function printHistory(payload: unknown, fields: readonly string[]): void {
  const points = historyPoints(payload);

  if (points === null) {
    console.log(`pontos=${ABSENT}`);
    return;
  }

  console.log(`pontos=${points.length}`);

  if (points.length === 0) {
    console.log(`primeiro=${ABSENT} ultimo=${ABSENT}`);
    return;
  }

  const first = asRecord(points[0]);
  const last = asRecord(points[points.length - 1]);

  const renderPoint = (point: Record<string, unknown> | null): string =>
    [`t=${point === null ? ABSENT : toIsoUtc(point.t)}`, ...fields.map((field) => `${field}=${display(point?.[field])}`)].join(' ');

  console.log(`primeiro ${renderPoint(first)}`);
  console.log(`ultimo ${renderPoint(last)}`);
}

function buildTargets(fromSeconds: number, toSeconds: number): Target[] {
  const symbols = encodeURIComponent(SYMBOLS.join(','));
  const historyQuery =
    `symbols=${encodeURIComponent('SOLUSDT_PERP.A')}` +
    `&interval=daily&from=${fromSeconds}&to=${toSeconds}`;

  return [
    {
      name: '1 /future-markets',
      path: '/future-markets',
      render: printMarkets,
    },
    {
      name: '2 /open-interest',
      path: `/open-interest?symbols=${symbols}&convert_to_usd=true`,
      render: (payload) => printCurrentRates(payload, true),
    },
    {
      name: '3 /funding-rate',
      path: `/funding-rate?symbols=${symbols}`,
      render: printFundingRates,
    },
    {
      name: '4 /open-interest-history',
      path: `/open-interest-history?${historyQuery}&convert_to_usd=true`,
      render: (payload) => printHistory(payload, ['o', 'h', 'l', 'c']),
    },
    {
      name: '5 /funding-rate-history',
      path: `/funding-rate-history?${historyQuery}`,
      render: (payload) => printHistory(payload, ['o', 'h', 'l', 'c']),
    },
    {
      name: '6 /liquidation-history',
      path: `/liquidation-history?${historyQuery}&convert_to_usd=true`,
      render: (payload) => printHistory(payload, ['l', 's']),
    },
    {
      name: '7 /long-short-ratio-history',
      path: `/long-short-ratio-history?${historyQuery}`,
      render: (payload) => printHistory(payload, ['r', 'l', 's']),
    },
  ];
}

async function fetchTarget(path: string, apiKey: string): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: {
        api_key: apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const body = await response.text();

    return {
      status: response.status,
      ms: Date.now() - startedAt,
      body,
      retryAfter: response.headers.get('retry-after'),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`timeout após ${REQUEST_TIMEOUT_MS} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function printSummary(rows: readonly SummaryRow[]): void {
  console.log('\n=== RESUMO ===');

  const targetWidth = Math.max('Alvo'.length, ...rows.map((row) => row.target.length));
  const statusWidth = Math.max('Status'.length, ...rows.map((row) => row.status.length));
  const msValues = rows.map((row) => (row.ms === null ? '-' : String(row.ms)));
  const msWidth = Math.max('ms'.length, ...msValues.map((value) => value.length));

  console.log(
    `${'Alvo'.padEnd(targetWidth)} | ${'Status'.padEnd(statusWidth)} | ${'ms'.padStart(msWidth)}`
  );
  console.log(`${'-'.repeat(targetWidth)}-+-${'-'.repeat(statusWidth)}-+-${'-'.repeat(msWidth)}`);

  rows.forEach((row, index) => {
    console.log(
      `${row.target.padEnd(targetWidth)} | ${row.status.padEnd(statusWidth)} | ${msValues[index].padStart(msWidth)}`
    );
  });
}

async function main(): Promise<void> {
  const apiKey = process.env.COINALYZE_API_KEY;

  if (apiKey === undefined || apiKey.trim() === '') {
    console.error('[ERRO] COINALYZE_API_KEY não definida; abortando sem chamadas');
    process.exitCode = 1;
    return;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const fromSeconds = nowSeconds - 10 * 24 * 60 * 60;
  const targets = buildTargets(fromSeconds, nowSeconds);
  const results: SummaryRow[] = [];
  let stopped = false;

  console.log('=== COINALYZE PROBE (SOMENTE-LEITURA) ===');
  console.log(`base=${API_BASE}`);
  console.log(`pausa=${PAUSE_BETWEEN_CALLS_MS / 1000}s timeout=${REQUEST_TIMEOUT_MS / 1000}s`);
  console.log(`from=${fromSeconds} to=${nowSeconds}`);

  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];

    if (stopped) {
      results.push({ target: target.name, status: 'NAO_EXECUTADO', ms: null });
      continue;
    }

    console.log(`\n[${index + 1}/${targets.length}] ${target.name}`);
    console.log(`GET ${API_BASE}${target.path}`);

    let outcome: FetchOutcome;

    try {
      outcome = await fetchTarget(target.path, apiKey);
    } catch (error) {
      const message = sanitize(error instanceof Error ? error.message : String(error));
      console.log(`status=ERRO ms=n/a`);
      console.log(`erro=${message}`);
      results.push({ target: target.name, status: 'ERRO', ms: null });

      if (index < targets.length - 1) {
        await sleep(PAUSE_BETWEEN_CALLS_MS);
      }
      continue;
    }

    console.log(`status=${outcome.status} ms=${outcome.ms}`);
    results.push({ target: target.name, status: String(outcome.status), ms: outcome.ms });

    if (outcome.status !== 200) {
      const preview = sanitize(outcome.body).slice(0, BODY_PREVIEW_CHARS);
      console.log(`body=${preview === '' ? '(vazio)' : preview}`);

      if (outcome.status === 401) {
        console.log('[STOP] HTTP 401; interrompendo');
        stopped = true;
      } else if (outcome.status === 429) {
        console.log(`Retry-After=${outcome.retryAfter === null ? ABSENT : sanitize(outcome.retryAfter)}`);
        console.log('[STOP] HTTP 429; interrompendo');
        stopped = true;
      }
    } else {
      target.render(parseJson(outcome.body));
    }

    if (!stopped && index < targets.length - 1) {
      await sleep(PAUSE_BETWEEN_CALLS_MS);
    }
  }

  printSummary(results);
}

main().catch((error) => {
  const message = sanitize(error instanceof Error ? error.message : String(error));
  console.error('[FATAL]', message);
  process.exitCode = 1;
});

export {};
