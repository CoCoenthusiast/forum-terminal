#!/usr/bin/env node
// Coletor idempotente de tokens da Solana via API pública do GeckoTerminal.
// Não lê .env nem usa dotenv: em modo real depende apenas de TERMINAL_DATABASE_URL
// já presente no ambiente. Use --dry-run para validar sem tocar no banco.

import { pathToFileURL } from 'node:url';
import { Prisma, type PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment } from './config';

const API_BASE = 'https://api.geckoterminal.com/api/v2';
const NETWORK = 'solana';
const CALLS_PER_MINUTE = 5;
const MIN_INTERVAL_MS = Math.ceil(60_000 / CALLS_PER_MINUTE);
const REQUEST_TIMEOUT_MS = 15_000;
const CAPTURE_BUCKET_MS = 60 * 60 * 1000;

export const TOP_POOLS = 5;

const DEFAULT_TOKENS = [
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', // JTO
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', // PUMP
  'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS', // KMNO
  '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', // TRUMP
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
  '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump', // ANSEM
] as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CollectOptions {
  tokens?: readonly string[];
  prisma?: PrismaClient | null;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  intervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export interface CollectSummary {
  tokens: number;
  ok: number;
  failures: number;
  rateLimited: boolean;
}

interface FetchResult {
  status: number;
  payload: unknown;
  ms: number;
}

interface TokenData {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  imageUrl: string | null;
  priceUsd: Decimal;
  liquidityUsd: Decimal | null;
  volume24hUsd: Decimal | null;
}

interface PoolData {
  poolAddress: string;
  poolName: string | null;
  dexId: string | null;
  reserveSortUsd: Decimal | null;
  reserveInUsd: Decimal | null;
  volume24hUsd: Decimal | null;
  buys24h: number | null;
  sells24h: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
  poolCreatedAt: Date | null;
}

interface HolderData {
  holdersCount: number | null;
  top10Pct: Decimal | null;
  rank11to20Pct: Decimal | null;
  rank21to40Pct: Decimal | null;
  restPct: Decimal | null;
  sourceLastUpdated: Date | null;
}

interface TokenResult {
  ok: boolean;
  rateLimited: boolean;
}

interface RateGate {
  wait: () => Promise<void>;
}

interface CollectorContext {
  prisma: PrismaClient | null;
  dryRun: boolean;
  fetchImpl: FetchLike;
  gate: RateGate;
  now: () => Date;
  log: (message: string) => void;
  logError: (message: string) => void;
}

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

class RateLimitError extends HttpError {
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message, 429, retryAfterSeconds);
    this.name = 'RateLimitError';
  }
}

class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): { dryRun: boolean; tokens: string[] } {
  const dryRun = argv.includes('--dry-run') || argv.includes('--dry');
  const addresses: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '--dry') continue;
    if (arg === '--tokens' || arg === '--token') {
      const next = argv[++i];
      if (next) addresses.push(...next.split(','));
      continue;
    }
    if (arg.startsWith('--tokens=') || arg.startsWith('--token=')) {
      addresses.push(...arg.slice(arg.indexOf('=') + 1).split(','));
      continue;
    }
    if (!arg.startsWith('-')) addresses.push(arg);
  }

  const unique = [...new Set(addresses.map((a) => a.trim()).filter(Boolean))];
  return {
    dryRun,
    tokens: unique.length > 0 ? unique : DEFAULT_TOKENS.map((address) => address),
  };
}

function sanitizeTokenText(value: unknown, maxLength = 80): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .normalize('NFKC')
    .replace(/\p{C}/gu, '')
    .replace(/[\u202A-\u202E]/gu, '')
    .replace(/[^\p{L}\p{N}\s._-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return clean.length > 0 ? clean : null;
}

function toDecimal(value: unknown): Decimal | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Decimal(String(value));
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return new Decimal(value.trim());
  }
  return null;
}

function roundTo(value: Decimal | null, decimals: number): Decimal | null {
  return value === null ? null : new Decimal(value.toFixed(decimals));
}

function toInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nested(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    const record = readRecord(current);
    if (record === null) return undefined;
    current = record[key];
  }
  return current;
}

function extractAttributes(payload: unknown): Record<string, unknown> {
  const root = readRecord(payload);
  const data = readRecord(root?.data);
  return readRecord(data?.attributes) ?? {};
}

function parseToken(payload: unknown): TokenData | null {
  const attributes = extractAttributes(payload);
  const priceUsd = toDecimal(attributes.price_usd);
  if (priceUsd === null) return null;
  const volume = readRecord(attributes.volume_usd);
  return {
    name: sanitizeTokenText(attributes.name),
    symbol: sanitizeTokenText(attributes.symbol, 20),
    decimals: toInt(attributes.decimals),
    imageUrl: typeof attributes.image_url === 'string' ? attributes.image_url : null,
    priceUsd,
    liquidityUsd: roundTo(toDecimal(attributes.total_reserve_in_usd), 2),
    volume24hUsd: roundTo(toDecimal(volume?.h24), 2),
  };
}

function parsePools(payload: unknown): PoolData[] {
  const root = readRecord(payload);
  if (!Array.isArray(root?.data)) return [];
  return (root.data as unknown[]).map((item) => {
    const pool = readRecord(item) ?? {};
    const attributes = readRecord(pool.attributes) ?? {};
    const transactions = readRecord(nested(attributes, ['transactions', 'h24']));
    const reserve = toDecimal(attributes.reserve_in_usd);
    return {
      poolAddress: typeof attributes.address === 'string' ? attributes.address : '',
      poolName: sanitizeTokenText(attributes.name),
      dexId: typeof nested(pool, ['relationships', 'dex', 'data', 'id']) === 'string'
        ? (nested(pool, ['relationships', 'dex', 'data', 'id']) as string)
        : null,
      reserveSortUsd: reserve,
      reserveInUsd: roundTo(reserve, 2),
      volume24hUsd: roundTo(toDecimal(nested(attributes, ['volume_usd', 'h24'])), 2),
      buys24h: toInt(transactions?.buys),
      sells24h: toInt(transactions?.sells),
      buyers24h: toInt(transactions?.buyers),
      sellers24h: toInt(transactions?.sellers),
      poolCreatedAt: toDate(attributes.pool_created_at),
    };
  });
}

function parseHolders(payload: unknown): HolderData | null {
  const attributes = extractAttributes(payload);
  const holders = readRecord(attributes.holders);
  if (holders === null) return null;
  const distribution = readRecord(holders.distribution_percentage);
  return {
    holdersCount: toInt(holders.count),
    top10Pct: roundTo(toDecimal(distribution?.top_10), 4),
    rank11to20Pct: roundTo(toDecimal(distribution?.['11_20']), 4),
    rank21to40Pct: roundTo(toDecimal(distribution?.['21_40']), 4),
    restPct: roundTo(toDecimal(distribution?.rest), 4),
    sourceLastUpdated: toDate(holders.last_updated),
  };
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function createGate(
  intervalMs: number,
  sleepImpl: (ms: number) => Promise<void>,
  log: (message: string) => void
): RateGate {
  let lastCallAt: number | null = null;
  return {
    async wait(): Promise<void> {
      if (lastCallAt !== null) {
        const waitMs = intervalMs - (Date.now() - lastCallAt);
        if (waitMs > 0) {
          log(`[RATE] aguardando ${(waitMs / 1000).toFixed(1)}s para respeitar ${CALLS_PER_MINUTE} chamadas/min`);
          await sleepImpl(waitMs);
        }
      }
      lastCallAt = Date.now();
    },
  };
}

function captureBucket(date: Date): Date {
  return new Date(Math.floor(date.getTime() / CAPTURE_BUCKET_MS) * CAPTURE_BUCKET_MS);
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function failureStatus(error: unknown): string {
  if (error instanceof RateLimitError) return 'rate_limited';
  if (error instanceof HttpError) return 'http_error';
  if (error instanceof InvalidPayloadError) return 'invalid_payload';
  return 'error';
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

async function findTokenId(prisma: PrismaClient, address: string): Promise<string | null> {
  try {
    const token = await prisma.token.findUnique({
      where: { network_address: { network: NETWORK, address } },
      select: { id: true },
    });
    return token?.id ?? null;
  } catch {
    return null;
  }
}

async function recordFailure(
  ctx: CollectorContext,
  address: string,
  tokenId: string | null,
  operation: string,
  endpoint: string,
  error: unknown
): Promise<void> {
  if (ctx.dryRun || ctx.prisma === null) return;
  const linkedTokenId = tokenId ?? (await findTokenId(ctx.prisma, address));
  const httpStatus = error instanceof HttpError ? error.status : null;
  const retryAfterSeconds = error instanceof HttpError ? error.retryAfterSeconds : null;
  try {
    await ctx.prisma.tokenCollectionFailure.create({
      data: {
        tokenId: linkedTokenId,
        tokenAddress: address,
        operation,
        endpoint,
        status: failureStatus(error),
        httpStatus,
        retryAfterSeconds,
        errorMessage: errorMessage(error),
        attempt: 1,
      },
    });
    ctx.logError(
      `[DB] falha registrada em TokenCollectionFailure (${operation}/${failureStatus(error)}) para ${shortAddress(address)}`
    );
  } catch (logError) {
    ctx.logError(
      `[DB] não foi possível registrar a falha de ${shortAddress(address)}: ${errorMessage(logError)}`
    );
  }
}

async function fetchEndpoint(ctx: CollectorContext, path: string): Promise<FetchResult> {
  await ctx.gate.wait();

  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await ctx.fetchImpl(`${API_BASE}${path}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const ms = Date.now() - started;
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));

    if (res.status === 429) {
      throw new RateLimitError('GeckoTerminal retornou HTTP 429', retryAfter);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new HttpError(`HTTP ${res.status}`, res.status, retryAfter);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new InvalidPayloadError('resposta da API não é JSON válido');
    }

    return { status: res.status, payload, ms };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`timeout após ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function tokenPath(address: string): string {
  return `/networks/${NETWORK}/tokens/${address}`;
}

function printDryRun(
  ctx: CollectorContext,
  address: string,
  token: TokenData,
  pools: PoolData[] | null,
  holders: HolderData | null
): void {
  const label = token.symbol ?? shortAddress(address);
  ctx.log(
    `[DRY-RUN] token=${label} address=${shortAddress(address)} price=${token.priceUsd.toString()} ` +
      `liquidity=${token.liquidityUsd?.toString() ?? 'null'} pools=${pools === null ? 'indisponivel' : pools.length}`
  );

  if (pools === null) {
    ctx.log('[DRY-RUN] pools=<indisponivel>');
  } else {
    const top = pools
      .filter((pool) => pool.poolAddress !== '')
      .slice()
      .sort((a, b) => (b.reserveSortUsd?.toNumber() ?? Number.NEGATIVE_INFINITY)
        - (a.reserveSortUsd?.toNumber() ?? Number.NEGATIVE_INFINITY))
      .slice(0, TOP_POOLS);

    for (let i = 0; i < top.length; i++) {
      const pool = top[i];
      ctx.log(
        `[DRY-RUN] pool[${i + 1}] address=${pool.poolAddress} name=${pool.poolName ?? 'null'} ` +
          `dex=${pool.dexId ?? 'null'} reserve=${pool.reserveInUsd?.toString() ?? 'null'} ` +
          `volume=${pool.volume24hUsd?.toString() ?? 'null'} buys=${pool.buys24h ?? 'null'} ` +
          `sells=${pool.sells24h ?? 'null'} buyers=${pool.buyers24h ?? 'null'} ` +
          `sellers=${pool.sellers24h ?? 'null'} createdAt=${pool.poolCreatedAt?.toISOString() ?? 'null'}`
      );
    }
  }

  if (holders === null) {
    ctx.log('[DRY-RUN] holders=<sem info>');
  } else {
    ctx.log(
      `[DRY-RUN] holders count=${holders.holdersCount ?? 'null'} top10=${holders.top10Pct?.toString() ?? 'null'} ` +
        `11_20=${holders.rank11to20Pct?.toString() ?? 'null'} 21_40=${holders.rank21to40Pct?.toString() ?? 'null'} ` +
        `rest=${holders.restPct?.toString() ?? 'null'} updated=${holders.sourceLastUpdated?.toISOString() ?? 'null'}`
    );
  }

  ctx.log('[DRY-RUN] nenhuma escrita no banco');
}

async function persist(
  ctx: CollectorContext,
  tokenId: string,
  token: TokenData,
  pools: PoolData[] | null,
  holders: HolderData | null,
  capturedAt: Date
): Promise<void> {
  const prisma = ctx.prisma;
  if (prisma === null) throw new Error('PrismaClient não inicializado');

  const observedBuys = pools === null ? null : pools.reduce((sum, pool) => sum + (pool.buys24h ?? 0), 0);
  const observedSells = pools === null ? null : pools.reduce((sum, pool) => sum + (pool.sells24h ?? 0), 0);
  const poolsObserved = pools === null ? null : pools.length;

  const capture = await prisma.tokenCapture.upsert({
    where: {
      tokenId_capturedAt: {
        tokenId,
        capturedAt,
      },
    },
    create: {
      tokenId,
      priceUsd: token.priceUsd,
      liquidityUsd: token.liquidityUsd,
      volume24hUsd: token.volume24hUsd,
      txCount24h: null,
      rawPayload: Prisma.DbNull,
      poolsObserved,
      buys24hObserved: observedBuys,
      sells24hObserved: observedSells,
      capturedAt,
    },
    update: {
      priceUsd: token.priceUsd,
      liquidityUsd: token.liquidityUsd,
      volume24hUsd: token.volume24hUsd,
      txCount24h: null,
      rawPayload: Prisma.DbNull,
      poolsObserved,
      buys24hObserved: observedBuys,
      sells24hObserved: observedSells,
    },
    select: { id: true },
  });

  if (pools !== null) {
    const top = pools
      .filter((pool) => pool.poolAddress !== '')
      .slice()
      .sort((a, b) => (b.reserveSortUsd?.toNumber() ?? Number.NEGATIVE_INFINITY)
        - (a.reserveSortUsd?.toNumber() ?? Number.NEGATIVE_INFINITY))
      .slice(0, TOP_POOLS);

    // Upserts por (captureId, poolAddress) atualizam os pools já gravados;
    // pools que saíram do top 5 permanecem como estão (sem remoção).
    for (const pool of top) {
      await prisma.tokenPoolCapture.upsert({
        where: {
          captureId_poolAddress: {
            captureId: capture.id,
            poolAddress: pool.poolAddress,
          },
        },
        create: {
          captureId: capture.id,
          poolAddress: pool.poolAddress,
          poolName: pool.poolName,
          dexId: pool.dexId,
          reserveInUsd: pool.reserveInUsd,
          volume24hUsd: pool.volume24hUsd,
          buys24h: pool.buys24h,
          sells24h: pool.sells24h,
          buyers24h: pool.buyers24h,
          sellers24h: pool.sellers24h,
          poolCreatedAt: pool.poolCreatedAt,
        },
        update: {
          poolName: pool.poolName,
          dexId: pool.dexId,
          reserveInUsd: pool.reserveInUsd,
          volume24hUsd: pool.volume24hUsd,
          buys24h: pool.buys24h,
          sells24h: pool.sells24h,
          buyers24h: pool.buyers24h,
          sellers24h: pool.sellers24h,
          poolCreatedAt: pool.poolCreatedAt,
        },
      });
    }
  }

  if (holders !== null) {
    await prisma.tokenHolderCapture.upsert({
      where: { captureId: capture.id },
      create: {
        captureId: capture.id,
        holdersCount: holders.holdersCount,
        top10Pct: holders.top10Pct,
        rank11to20Pct: holders.rank11to20Pct,
        rank21to40Pct: holders.rank21to40Pct,
        restPct: holders.restPct,
        sourceLastUpdated: holders.sourceLastUpdated,
      },
      update: {
        holdersCount: holders.holdersCount,
        top10Pct: holders.top10Pct,
        rank11to20Pct: holders.rank11to20Pct,
        rank21to40Pct: holders.rank21to40Pct,
        restPct: holders.restPct,
        sourceLastUpdated: holders.sourceLastUpdated,
      },
    });
  }
}

async function collectOneToken(ctx: CollectorContext, address: string): Promise<TokenResult> {
  const basePath = tokenPath(address);
  const poolsPath = `${basePath}/pools?page=1`;
  const infoPath = `${basePath}/info`;

  let tokenPayload: unknown;
  try {
    tokenPayload = (await fetchEndpoint(ctx, basePath)).payload;
  } catch (e) {
    await recordFailure(ctx, address, null, 'fetch_token', basePath, e);
    const rateLimited = e instanceof RateLimitError;
    ctx.logError(
      `[ERRO] token=${shortAddress(address)} fetch_token: ${errorMessage(e)}` +
        (rateLimited ? ' — interrompendo imediatamente (HTTP 429)' : '')
    );
    return { ok: false, rateLimited };
  }

  const token = parseToken(tokenPayload);
  if (token === null) {
    const error = new InvalidPayloadError('campo price_usd ausente ou inválido');
    await recordFailure(ctx, address, null, 'fetch_token', basePath, error);
    ctx.logError(`[ERRO] token=${shortAddress(address)} fetch_token: ${error.message}`);
    return { ok: false, rateLimited: false };
  }

  let tokenId: string | null = null;
  if (!ctx.dryRun) {
    if (ctx.prisma === null) throw new Error('PrismaClient não inicializado');
    const stored = await ctx.prisma.token.upsert({
      where: { network_address: { network: NETWORK, address } },
      create: {
        network: NETWORK,
        address,
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        imageUrl: token.imageUrl,
        firstSeenAt: ctx.now(),
        lastSeenAt: ctx.now(),
      },
      update: {
        name: token.name,
        symbol: token.symbol,
        decimals: token.decimals,
        imageUrl: token.imageUrl,
        lastSeenAt: ctx.now(),
      },
      select: { id: true },
    });
    tokenId = stored.id;
  }

  let hadFailure = false;
  let pools: PoolData[] | null = null;
  try {
    pools = parsePools((await fetchEndpoint(ctx, poolsPath)).payload);
  } catch (e) {
    hadFailure = true;
    await recordFailure(ctx, address, tokenId, 'fetch_pools', poolsPath, e);
    ctx.logError(`[ERRO] token=${shortAddress(address)} fetch_pools: ${errorMessage(e)}`);
    if (e instanceof RateLimitError) {
      ctx.logError('[429] interrompendo imediatamente');
      return { ok: false, rateLimited: true };
    }
  }

  let holders: HolderData | null = null;
  try {
    holders = parseHolders((await fetchEndpoint(ctx, infoPath)).payload);
  } catch (e) {
    hadFailure = true;
    await recordFailure(ctx, address, tokenId, 'fetch_info', infoPath, e);
    ctx.logError(`[ERRO] token=${shortAddress(address)} fetch_info: ${errorMessage(e)}`);
    if (e instanceof RateLimitError) {
      ctx.logError('[429] interrompendo imediatamente');
      return { ok: false, rateLimited: true };
    }
  }

  const capturedAt = captureBucket(ctx.now());

  if (ctx.dryRun) {
    printDryRun(ctx, address, token, pools, holders);
    return { ok: !hadFailure, rateLimited: false };
  }

  if (tokenId === null) throw new Error('Token não persistido');
  await persist(ctx, tokenId, token, pools, holders, capturedAt);

  ctx.log(
    `[OK] token=${token.symbol ?? shortAddress(address)} address=${shortAddress(address)} tokenId=${tokenId} ` +
      `price=${token.priceUsd.toString()} liquidity=${token.liquidityUsd?.toString() ?? 'null'} ` +
      `pools=${pools === null ? 'indisponivel' : pools.length} ` +
      `holders=${holders === null ? 'sem info' : (holders.holdersCount ?? 'null')} ` +
      `capturedAt=${capturedAt.toISOString()}`
  );
  return { ok: !hadFailure, rateLimited: false };
}

export async function collectTokens(options: CollectOptions = {}): Promise<CollectSummary> {
  const tokens = (options.tokens ?? DEFAULT_TOKENS).map((token) => token.trim()).filter(Boolean);
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));
  const dryRun = options.dryRun ?? false;
  const prisma = options.prisma ?? null;

  if (!dryRun && prisma === null) {
    throw new Error('PrismaClient obrigatório fora do dry-run');
  }

  const ctx: CollectorContext = {
    prisma,
    dryRun,
    fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
    gate: createGate(options.intervalMs ?? MIN_INTERVAL_MS, options.sleep ?? sleep, log),
    now: options.now ?? (() => new Date()),
    log,
    logError,
  };

  let ok = 0;
  let failures = 0;
  let rateLimited = false;

  for (const token of tokens) {
    const result = await collectOneToken(ctx, token);
    if (result.ok) ok++;
    else failures++;
    if (result.rateLimited) {
      rateLimited = true;
      break;
    }
  }

  return { tokens: tokens.length, ok, failures, rateLimited };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const hasDbUrl =
    typeof process.env.TERMINAL_DATABASE_URL === 'string' &&
    process.env.TERMINAL_DATABASE_URL.trim() !== '';
  const dryRun = parsed.dryRun || !hasDbUrl;

  if (!parsed.dryRun && !hasDbUrl) {
    console.log('[INIT] TERMINAL_DATABASE_URL ausente; usando dry-run automaticamente');
  }
  console.log(`[INIT] modo=${dryRun ? 'dry-run' : 'real'} tokens=${parsed.tokens.length} limite=${CALLS_PER_MINUTE}/min intervalo=${MIN_INTERVAL_MS}ms`);

  let prisma: PrismaClient | null = null;
  if (!dryRun) {
    checkEnvironment();
    const db = await import('./db');
    prisma = db.prisma;
  }

  try {
    const summary = await collectTokens({
      tokens: parsed.tokens,
      prisma,
      dryRun,
    });
    console.log(
      `[FIM] tokens=${summary.tokens} ok=${summary.ok} falhas=${summary.failures} ` +
        `rate_limit=${summary.rateLimited ? 'sim' : 'nao'}`
    );
    if (summary.rateLimited) process.exitCode = 2;
    else if (summary.failures > 0) process.exitCode = 1;
  } finally {
    if (prisma !== null) await prisma.$disconnect();
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((e) => {
    console.error('[FATAL]', errorMessage(e));
    process.exitCode = 1;
  });
}
