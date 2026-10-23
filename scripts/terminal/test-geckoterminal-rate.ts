#!/usr/bin/env node
// Simulação SOMENTE-LEITURA da API pública do GeckoTerminal.
// Não acessa banco, não lê .env e não grava nada. O único efeito externo são
// requisições HTTP GET para no máximo 3 tokens de teste da Solana.

import { pathToFileURL } from 'node:url';

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const MAX_CALLS = 3;
const CALLS_PER_MINUTE = 5;
const MIN_INTERVAL_MS = Math.ceil(60_000 / CALLS_PER_MINUTE);
const REQUEST_TIMEOUT_MS = 15_000;

// Tokens conhecidos da Solana usados só como amostra pública.
const TEST_TOKENS = [
  {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    label: 'USDC',
  },
  {
    address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    label: 'BONK',
  },
] as const;

interface TokenAttributes {
  name?: unknown;
  symbol?: unknown;
  address?: unknown;
}

interface CallReport {
  label: string;
  address: string;
  status: number | null;
  ms: number;
  nameRaw: string;
  nameClean: string;
  symbolRaw: string;
  symbolClean: string;
  error: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Remove controles, formatadores invisíveis (zero-width, BOM etc.), pontuação e
// símbolos. Mantém apenas letras Unicode, números e espaços, normalizados.
export function sanitizeTokenText(value: unknown, maxLength = 80): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/\p{C}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

let lastCallAt = 0;
let calls = 0;

async function respectRateLimit(): Promise<void> {
  if (calls >= MAX_CALLS) {
    throw new Error(`limite local de ${MAX_CALLS} chamadas atingido`);
  }
  const waitMs = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (waitMs > 0) {
    console.log(`[RATE] aguardando ${(waitMs / 1000).toFixed(1)}s para respeitar ${CALLS_PER_MINUTE} chamadas/min`);
    await sleep(waitMs);
  }
  lastCallAt = Date.now();
  calls++;
}

async function fetchToken(token: (typeof TEST_TOKENS)[number]): Promise<CallReport> {
  await respectRateLimit();

  const url = `${BASE_URL}/networks/${NETWORK}/tokens/${token.address}`;
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });

    const ms = Date.now() - started;
    const rateLimit = [
      res.headers.get('x-ratelimit-limit'),
      res.headers.get('x-ratelimit-remaining'),
      res.headers.get('retry-after'),
    ].filter((v): v is string => v !== null);

    if (res.status === 429) {
      clearTimeout(timeout);
      console.error(`[429] GeckoTerminal recusou a chamada de ${token.label}; encerrando imediatamente.`);
      if (rateLimit.length > 0) console.error(`[429] headers de limite: ${rateLimit.join(', ')}`);
      process.exit(2);
    }

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }

    const attributes =
      typeof parsed === 'object' && parsed !== null && 'data' in parsed
        ? ((parsed as { data?: { attributes?: TokenAttributes } }).data?.attributes ?? {})
        : {};

    const nameRaw = typeof attributes.name === 'string' ? attributes.name : '';
    const symbolRaw = typeof attributes.symbol === 'string' ? attributes.symbol : '';

    if (!res.ok) {
      return {
        label: token.label,
        address: token.address,
        status: res.status,
        ms,
        nameRaw,
        nameClean: sanitizeTokenText(nameRaw),
        symbolRaw,
        symbolClean: sanitizeTokenText(symbolRaw, 20),
        error: `HTTP ${res.status}`,
      };
    }

    return {
      label: token.label,
      address: token.address,
      status: res.status,
      ms,
      nameRaw,
      nameClean: sanitizeTokenText(nameRaw),
      symbolRaw,
      symbolClean: sanitizeTokenText(symbolRaw, 20),
      error: null,
    };
  } catch (e) {
    const ms = Date.now() - started;
    const error =
      e instanceof Error && e.name === 'AbortError'
        ? `timeout após ${REQUEST_TIMEOUT_MS}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    return {
      label: token.label,
      address: token.address,
      status: null,
      ms,
      nameRaw: '',
      nameClean: '',
      symbolRaw: '',
      symbolClean: '',
      error,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  console.log('=== GECKOTERMINAL / SIMULAÇÃO SOMENTE-LEITURA ===');
  console.log(`endpoint=${BASE_URL}/networks/${NETWORK}/tokens/<address>`);
  console.log(`limite local=${CALLS_PER_MINUTE}/min intervalo=${MIN_INTERVAL_MS}ms máximo=${MAX_CALLS} chamadas`);
  console.log(`tokens de teste=${TEST_TOKENS.length} (${TEST_TOKENS.map((t) => t.label).join(', ')})`);
  console.log(
    `sanitização de exemplo: ${JSON.stringify('  $BON\u200Bk\u0007 <script>  ')} -> ${JSON.stringify(
      sanitizeTokenText('  $BON\u200Bk\u0007 <script>  ')
    )}`
  );

  const reports: CallReport[] = [];
  for (const token of TEST_TOKENS) {
    if (calls >= MAX_CALLS) break;
    const report = await fetchToken(token);
    reports.push(report);
    const status = report.status === null ? 'erro' : `HTTP ${report.status}`;
    const detail = report.error === null ? '' : ` erro=${report.error}`;
    console.log(
      `[CALL ${reports.length}/${MAX_CALLS}] ${report.label} ${status} em ${report.ms}ms` +
        `${detail} name=${JSON.stringify(report.nameClean)} symbol=${JSON.stringify(report.symbolClean)}`
    );
  }

  console.log('\n=== RELATÓRIO ===');
  console.log(`chamadas realizadas=${calls}/${MAX_CALLS}`);
  for (const report of reports) {
    console.log(
      `token=${report.label} address=${report.address} status=${report.status ?? 'erro'} ms=${report.ms}` +
        ` name_raw=${JSON.stringify(report.nameRaw)} name_sanitizado=${JSON.stringify(report.nameClean)}` +
        ` symbol_raw=${JSON.stringify(report.symbolRaw)} symbol_sanitizado=${JSON.stringify(report.symbolClean)}` +
        `${report.error === null ? '' : ` erro=${report.error}`}`
    );
  }

  const failures = reports.filter((r) => r.error !== null).length;
  console.log(`resultado=${failures === 0 ? 'ok' : `${failures} falha(s)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
