#!/usr/bin/env node
// Sondagem SOMENTE-LEITURA dos endpoints de pools e info do GeckoTerminal.
// Não importa Prisma, não acessa banco e não lê .env/.env.*.
// Faz exatamente 2 chamadas GET, com 12s entre elas, e para no primeiro 429.

import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const DEFAULT_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const INTERVAL_MS = 12_000;
const REQUEST_TIMEOUT_MS = 15_000;

interface FetchResult {
  status: number;
  ms: number;
  payload: unknown;
  retryAfterSeconds: number | null;
}

function sanitizeText(value: unknown, maxLength = 800): string {
  if (typeof value !== 'string') return '';
  const clean = value
    .normalize('NFKC')
    .replace(/\p{C}/gu, '')
    .replace(/[\u202A-\u202E]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.slice(0, maxLength);
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[truncado]';
  if (typeof value === 'string') return sanitizeText(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source).slice(0, 30)) {
      out[sanitizeText(key, 80)] = sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function attributesOf(payload: unknown): Record<string, unknown> {
  const root = record(payload);
  const data = record(root?.data);
  return record(data?.attributes) ?? {};
}

function dataArray(payload: unknown): Record<string, unknown>[] {
  const root = record(payload);
  return Array.isArray(root?.data) ? (root.data as Record<string, unknown>[]) : [];
}

function nested(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const obj = record(current);
    if (obj === null) return undefined;
    current = obj[key];
  }
  return current;
}

function printable(value: unknown, maxLength = 300): string {
  if (value === undefined) return '<ausente>';
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(sanitizeText(value, maxLength));
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(sanitizeValue(value), null, 2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function parseToken(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--token=')) {
      const value = arg.slice('--token='.length).trim();
      if (value === '') throw new Error('--token recebeu valor vazio');
      return value;
    }
    if (arg === '--token') {
      const value = argv[++i]?.trim();
      if (!value) throw new Error('--token exige um endereço');
      return value;
    }
  }
  return DEFAULT_TOKEN;
}

async function get(path: string): Promise<FetchResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      payload = null;
    }
    return {
      status: res.status,
      ms,
      payload,
      retryAfterSeconds: parseRetryAfter(res.headers.get('retry-after')),
    };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`timeout após ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function printPools(payload: unknown): void {
  const pools = dataArray(payload);
  console.log(`pools_count=${pools.length}`);
  if (pools.length === 0) return;

  for (let i = 0; i < Math.min(3, pools.length); i++) {
    const pool = pools[i];
    const attributes = record(pool.attributes) ?? {};
    const dex = nested(pool, ['relationships', 'dex', 'data', 'id']);
    console.log(`pool[${i + 1}].attributes.keys=${JSON.stringify(Object.keys(attributes).map((k) => sanitizeText(k, 80)))}`);
    console.log(`pool[${i + 1}].name=${printable(attributes.name)}`);
    console.log(`pool[${i + 1}].reserve_in_usd=${printable(attributes.reserve_in_usd)}`);
    console.log(`pool[${i + 1}].volume_usd.h24=${printable(nested(attributes, ['volume_usd', 'h24']))}`);
    console.log(
      `pool[${i + 1}].transactions.h24=` +
        JSON.stringify({
          buys: sanitizeValue(nested(attributes, ['transactions', 'h24', 'buys'])),
          sells: sanitizeValue(nested(attributes, ['transactions', 'h24', 'sells'])),
          buyers: sanitizeValue(nested(attributes, ['transactions', 'h24', 'buyers'])),
          sellers: sanitizeValue(nested(attributes, ['transactions', 'h24', 'sellers'])),
        })
    );
    console.log(`pool[${i + 1}].pool_created_at=${printable(attributes.pool_created_at)}`);
    console.log(`pool[${i + 1}].relationships.dex.data.id=${printable(dex)}`);
  }
}

function printInfo(payload: unknown): void {
  const attributes = attributesOf(payload);
  const keys = Object.keys(attributes).map((key) => sanitizeText(key, 80));
  console.log(`attributes.keys=${JSON.stringify(keys)}`);

  const holders = record(attributes.holders);
  console.log(`holders.count=${printable(holders?.count)}`);
  console.log(`holders.distribution_percentage=${printable(holders?.distribution_percentage)}`);
  console.log(`holders.last_updated=${printable(holders?.last_updated)}`);

  if ('gt_score' in attributes) {
    console.log('gt_score.campo=presente (valor omitido)');
  } else {
    console.log('gt_score.campo=<ausente>');
  }

  if ('launchpad_details' in attributes) {
    console.log(`launchpad_details=${printable(attributes.launchpad_details)}`);
  } else {
    console.log('launchpad_details=<ausente>');
  }
}

function reportFailure(label: string, endpoint: string, result: FetchResult): void {
  if (result.status === 429) {
    console.error(
      `[429] ${label} em ${endpoint} — interrompendo imediatamente` +
        (result.retryAfterSeconds === null ? '' : ` (retry-after=${result.retryAfterSeconds}s)`)
    );
    return;
  }
  if (result.status === 404) {
    console.error(`[404] ${label} em ${endpoint} — endpoint não encontrado para este token`);
    return;
  }
  console.error(`[HTTP ${result.status}] ${label} em ${endpoint}`);
}

async function main(): Promise<void> {
  const token = parseToken(process.argv.slice(2));
  const poolsPath = `/networks/${NETWORK}/tokens/${token}/pools?page=1`;
  const infoPath = `/networks/${NETWORK}/tokens/${token}/info`;

  console.log('=== GECKOTERMINAL PROBE (SOMENTE-LEITURA) ===');
  console.log(`token=${sanitizeText(token, 120)}`);
  console.log(`chamadas=2 intervalo=${INTERVAL_MS / 1000}s`);

  console.log(`\n[1/2] GET ${poolsPath}`);
  const pools = await get(poolsPath);
  console.log(`status=${pools.status} ms=${pools.ms}`);
  if (pools.status === 429) {
    reportFailure('pools', poolsPath, pools);
    process.exitCode = 2;
    return;
  }
  if (pools.status === 404) {
    reportFailure('pools', poolsPath, pools);
  } else if (pools.status >= 200 && pools.status < 300) {
    printPools(pools.payload);
  } else {
    reportFailure('pools', poolsPath, pools);
  }

  console.log(`\n[RATE] aguardando ${INTERVAL_MS / 1000}s antes da segunda chamada`);
  await sleep(INTERVAL_MS);

  console.log(`\n[2/2] GET ${infoPath}`);
  const info = await get(infoPath);
  console.log(`status=${info.status} ms=${info.ms}`);
  if (info.status === 429) {
    reportFailure('info', infoPath, info);
    process.exitCode = 2;
    return;
  }
  if (info.status === 404) {
    reportFailure('info', infoPath, info);
  } else if (info.status >= 200 && info.status < 300) {
    printInfo(info.payload);
  } else {
    reportFailure('info', infoPath, info);
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    console.error('[FATAL]', sanitizeText(e instanceof Error ? e.message : String(e), 300));
    process.exitCode = 1;
  });
}
