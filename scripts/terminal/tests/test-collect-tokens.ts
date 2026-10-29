#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { collectTokens, type FetchLike } from '../collect-tokens';

const NETWORK = 'solana';
const TOKEN = 'TokenTest1111111111111111111111111111111111';
const OTHER_TOKEN = 'TokenTest2222222222222222222222222222222222';
const FIXED_NOW = new Date('2026-10-23T15:05:00.000Z');
const FIXED_CAPTURE = '2026-10-23T15:00:00.000Z';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function localDbUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    console.log('[SKIP] defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test');
    return null;
  }
  const parsed = new URL(url);
  if (!/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) || parsed.port !== '5433') {
    console.log(`[SKIP] banco não é local:${parsed.port}: ${parsed.hostname}`);
    return null;
  }
  return url;
}

function sqlFile(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../../prisma-terminal/sql', file);
}

async function ensureCollectorRole(client: Client): Promise<void> {
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'collector'");
  if (role.rowCount === 0) {
    await client.query('CREATE ROLE collector NOLOGIN');
  }
}

async function ensureLocalSchema(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const existing = await client.query<{
      token: string | null;
      capture: string | null;
      failure: string | null;
      pool: string | null;
      holder: string | null;
    }>(`
      SELECT
        to_regclass('public."Token"')::text AS token,
        to_regclass('public."TokenCapture"')::text AS capture,
        to_regclass('public."TokenCollectionFailure"')::text AS failure,
        to_regclass('public."TokenPoolCapture"')::text AS pool,
        to_regclass('public."TokenHolderCapture"')::text AS holder
    `);
    const row = existing.rows[0];
    const oldReady = row.token !== null && row.capture !== null && row.failure !== null;
    const newReady = row.pool !== null && row.holder !== null;

    if (oldReady && newReady) return;
    if (!oldReady) {
      const anyOld = row.token !== null || row.capture !== null || row.failure !== null;
      if (anyOld) throw new Error('schema local parcial: tabelas antigas incompletas');
      await ensureCollectorRole(client);
      await client.query(await readFile(sqlFile('2026-10-22-create-token-captures.sql'), 'utf8'));
    }
    if (!newReady) {
      const anyNew = row.pool !== null || row.holder !== null;
      if (anyNew) throw new Error('schema local parcial: tabelas novas incompletas');
      await client.query(await readFile(sqlFile('2026-10-23-token-pools-holders.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

function json(status: number, payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fakeFetch(handler: (url: string) => Response): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      return handler(url);
    },
  };
}

function callKind(url: string): 'pools' | 'info' | 'token' {
  if (url.includes('/pools?')) return 'pools';
  if (url.endsWith('/info')) return 'info';
  return 'token';
}

const POOL_FIXTURES = [
  { address: 'PoolA', name: 'Pool A', dex: 'orca', reserve: '300.00', volume: '400.00', buys: 40, sells: 400, buyers: 60, sellers: 600, created: '2024-01-04T00:00:00Z' },
  { address: 'PoolB', name: 'Pool\u202EOne', dex: 'orca', reserve: '600.556', volume: '100.006', buys: 10, sells: 100, buyers: 30, sellers: 300, created: '2024-01-01T00:00:00Z' },
  { address: 'PoolC', name: 'Pool C', dex: 'meteora', reserve: '100.00', volume: '600.00', buys: 60, sells: 600, buyers: 80, sellers: 800, created: '2024-01-06T00:00:00Z' },
  { address: 'PoolD', name: 'Pool D', dex: 'raydium', reserve: '500.00', volume: '200.00', buys: 20, sells: 200, buyers: 40, sellers: 400, created: '2024-01-02T00:00:00Z' },
  { address: 'PoolE', name: 'Pool E', dex: 'raydium', reserve: '200.00', volume: '500.00', buys: 50, sells: 500, buyers: 70, sellers: 700, created: '2024-01-05T00:00:00Z' },
  { address: 'PoolF', name: 'Pool F', dex: 'meteora', reserve: '400.00', volume: '300.00', buys: 30, sells: 300, buyers: 50, sellers: 500, created: '2024-01-03T00:00:00Z' },
] as const;

function tokenPayload(price: string): unknown {
  return {
    data: {
      attributes: {
        address: TOKEN,
        name: 'Te\u202Est Token',
        symbol: '$T\u200BKN',
        decimals: 6,
        image_url: 'https://example.invalid/token.png',
        price_usd: price,
        total_reserve_in_usd: '123.4567',
        volume_usd: { h24: '999.999' },
      },
    },
  };
}

function poolsPayload(): unknown {
  return {
    data: POOL_FIXTURES.map((pool) => ({
      id: `solana_${pool.address}`,
      type: 'pool',
      attributes: {
        address: pool.address,
        name: pool.name,
        pool_created_at: pool.created,
        reserve_in_usd: pool.reserve,
        volume_usd: { h24: pool.volume },
        transactions: {
          h24: {
            buys: pool.buys,
            sells: pool.sells,
            buyers: pool.buyers,
            sellers: pool.sellers,
          },
        },
      },
      relationships: { dex: { data: { id: pool.dex } } },
    })),
  };
}

function infoPayload(): unknown {
  return {
    data: {
      attributes: {
        holders: {
          count: 1234,
          distribution_percentage: {
            top_10: '10.1234',
            '11_20': '20.5678',
            '21_40': '30.25',
            rest: '39.0588',
          },
          last_updated: '2026-10-23T13:00:00Z',
        },
        gt_score: 'NAO_GRAVAR',
        gt_score_details: { internal: 'NAO_GRAVAR' },
        mint_authority: 'NAO_GRAVAR',
        freeze_authority: 'NAO_GRAVAR',
        is_honeypot: false,
        developer_address: 'NAO_GRAVAR',
        developer_holding_percentage: 99,
      },
    },
  };
}

function prismaWithFailingFailureCreate(
  prisma: PrismaClient,
  error: Error
): PrismaClient {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === 'tokenCollectionFailure') {
        return {
          create: async () => {
            throw error;
          },
        };
      }

      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.tokenCollectionFailure.deleteMany({
    where: { tokenAddress: { in: [TOKEN, OTHER_TOKEN] } },
  });
  await prisma.token.deleteMany({
    where: { address: { in: [TOKEN, OTHER_TOKEN] } },
  });
}

async function getToken(prisma: PrismaClient): Promise<{ id: string } | null> {
  return prisma.token.findUnique({
    where: { network_address: { network: NETWORK, address: TOKEN } },
    select: { id: true },
  });
}

async function runIdempotent(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);
  let price = '1.234567890123456789';
  const fake = fakeFetch((url) => {
    const kind = callKind(url);
    if (kind === 'pools') return json(200, poolsPayload());
    if (kind === 'info') return json(200, infoPayload());
    return json(200, tokenPayload(price));
  });

  const options = {
    tokens: [TOKEN],
    prisma,
    fetchImpl: fake.fetchImpl,
    intervalMs: 0,
    now: () => FIXED_NOW,
    log: () => {},
    logError: () => {},
  };

  const first = await collectTokens(options);
  check('idempotência: primeira execução ok', first.ok === 1 && first.failures === 0 && !first.rateLimited);

  const token = await getToken(prisma);
  check('idempotência: token gravado', token !== null);
  if (token === null) return;

  const capture = await prisma.tokenCapture.findFirst({
    where: { tokenId: token.id },
    include: { pools: true, holder: true },
  });
  check('idempotência: uma captura', (await prisma.tokenCapture.count({ where: { tokenId: token.id } })) === 1);
  check('idempotência: cinco pools', capture?.pools.length === 5, `(pools=${capture?.pools.length ?? 0})`);
  check('idempotência: um holder', capture?.holder !== null && capture?.holder !== undefined);

  check('token: nome sanitizado', (await prisma.token.findUnique({ where: { id: token.id } }))?.name === 'Test Token');
  check('token: símbolo sanitizado', (await prisma.token.findUnique({ where: { id: token.id } }))?.symbol === 'TKN');
  check('captura: rawPayload null', capture?.rawPayload === null);
  check('captura: txCount24h null', capture?.txCount24h === null);
  check('captura: poolsObserved=6', capture?.poolsObserved === 6);
  check('captura: buys24hObserved=210', capture?.buys24hObserved === 210, `(${capture?.buys24hObserved})`);
  check('captura: sells24hObserved=2100', capture?.sells24hObserved === 2100, `(${capture?.sells24hObserved})`);
  check('captura: liquidez com 2 casas', capture?.liquidityUsd?.toFixed(2) === '123.46', `(${capture?.liquidityUsd?.toFixed(2)})`);
  check('captura: volume com 2 casas', capture?.volume24hUsd?.toFixed(2) === '1000.00', `(${capture?.volume24hUsd?.toFixed(2)})`);

  const top = capture?.pools.find((pool) => pool.poolAddress === 'PoolB');
  check('pool: nome sanitizado', top?.poolName === 'PoolOne', `(${top?.poolName})`);
  check('pool: sells lê sells (100)', top?.sells24h === 100, `(${top?.sells24h})`);
  check('pool: sellers lê sellers (300)', top?.sellers24h === 300, `(${top?.sellers24h})`);
  check('pool: buys=10', top?.buys24h === 10);
  check('pool: buyers=30', top?.buyers24h === 30);
  check('pool: reserve com 2 casas', top?.reserveInUsd?.toFixed(2) === '600.56', `(${top?.reserveInUsd?.toFixed(2)})`);
  check('pools: exclui o menor reserve', capture?.pools.every((pool) => pool.poolAddress !== 'PoolC') === true);

  check('holder: count', capture?.holder?.holdersCount === 1234);
  check('holder: top10Pct', capture?.holder?.top10Pct?.toFixed(4) === '10.1234');
  check('holder: rank11to20Pct', capture?.holder?.rank11to20Pct?.toFixed(4) === '20.5678');
  check('holder: rank21to40Pct', capture?.holder?.rank21to40Pct?.toFixed(4) === '30.2500');
  check('holder: restPct', capture?.holder?.restPct?.toFixed(4) === '39.0588');
  check(
    'holder: sourceLastUpdated',
    capture?.holder?.sourceLastUpdated?.toISOString() === '2026-10-23T13:00:00.000Z'
  );

  const captureId = capture?.id;
  const poolsBefore = capture?.pools.length ?? 0;
  price = '2.5';
  const second = await collectTokens(options);
  check('idempotência: segunda execução ok', second.ok === 1 && second.failures === 0 && !second.rateLimited);

  const capture2 = await prisma.tokenCapture.findFirst({
    where: { tokenId: token.id },
    include: { pools: true, holder: true },
  });
  check('idempotência: captura não duplicou', (await prisma.tokenCapture.count({ where: { tokenId: token.id } })) === 1);
  check('idempotência: mesmo captureId', capture2?.id === captureId);
  check('idempotência: preço atualizado', capture2?.priceUsd.toFixed(6) === '2.500000');
  check('idempotência: pools não duplicaram', capture2?.pools.length === poolsBefore && capture2?.pools.length === 5);
  check('idempotência: holder não duplicou', (await prisma.tokenHolderCapture.count({ where: { captureId: captureId ?? '' } })) === 1);
  check('idempotência: token não duplicou', (await prisma.token.count({ where: { address: TOKEN } })) === 1);
}

async function runRateLimit(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);
  const fake = fakeFetch((url) => {
    const kind = callKind(url);
    if (kind === 'pools') return json(429, { errors: [{ status: '429' }] }, { 'retry-after': '42' });
    if (kind === 'info') return json(200, infoPayload());
    return json(200, tokenPayload('1.0'));
  });

  const result = await collectTokens({
    tokens: [TOKEN, OTHER_TOKEN],
    prisma,
    fetchImpl: fake.fetchImpl,
    intervalMs: 0,
    now: () => FIXED_NOW,
    log: () => {},
    logError: () => {},
  });

  check('429: interrompe tudo', result.rateLimited && result.failures === 1 && result.ok === 0);
  check('429: exatamente 2 chamadas', fake.calls.length === 2, `(${fake.calls.length})`);
  check('429: não chamou /info', !fake.calls.some((url) => url.endsWith('/info')));
  check('429: não chamou o segundo token', !fake.calls.some((url) => url.includes(OTHER_TOKEN)));

  const failure = await prisma.tokenCollectionFailure.findFirst({
    where: { tokenAddress: TOKEN },
    orderBy: { occurredAt: 'desc' },
  });
  check('429: falha registrada', failure !== null);
  check('429: operação fetch_pools', failure?.operation === 'fetch_pools', `(${failure?.operation})`);
  check('429: status rate_limited', failure?.status === 'rate_limited', `(${failure?.status})`);
  check('429: httpStatus 429', failure?.httpStatus === 429);
  check('429: retryAfterSeconds 42', failure?.retryAfterSeconds === 42);
  check('429: não gravou captura', (await prisma.tokenCapture.count({ where: { token: { address: TOKEN } } })) === 0);
}

async function runInfo404(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);
  const fake = fakeFetch((url) => {
    const kind = callKind(url);
    if (kind === 'info') return json(404, { errors: [{ status: '404' }] });
    if (kind === 'pools') return json(200, poolsPayload());
    return json(200, tokenPayload('3.0'));
  });

  const result = await collectTokens({
    tokens: [TOKEN],
    prisma,
    fetchImpl: fake.fetchImpl,
    intervalMs: 0,
    now: () => FIXED_NOW,
    log: () => {},
    logError: () => {},
  });

  const token = await getToken(prisma);
  const capture = token === null
    ? null
    : await prisma.tokenCapture.findFirst({
        where: { tokenId: token.id },
        include: { holder: true },
      });

  check('404 info: token não derrubado', result.failures === 1 && capture !== null);
  check('404 info: captura gravada', capture !== null);
  check('404 info: sem holders', capture !== null && capture.holder === null);
  check('404 info: captura mantém pools', capture?.poolsObserved === 6);
  const failure = await prisma.tokenCollectionFailure.findFirst({
    where: { tokenAddress: TOKEN, operation: 'fetch_info' },
    orderBy: { occurredAt: 'desc' },
  });
  check('404 info: falha registrada', failure !== null && failure.httpStatus === 404);
}

async function runFailureLog(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);
  const fake = fakeFetch((url) => {
    const kind = callKind(url);
    if (kind === 'info') return json(404, { errors: [{ status: '404' }] });
    if (kind === 'pools') return json(200, poolsPayload());
    return json(200, tokenPayload('5.0'));
  });
  const beginning = `INICIO_NAO_DEVERIA_APARECER_${'x'.repeat(500)}`;
  const ending = 'FINAL_DA_CAUSA_REAL';
  const createError = Object.assign(new Error(`${beginning} ${ending}`), {
    code: 'P2003',
    meta: { field_name: 'tokenId', reason: 'META_DA_CAUSA' },
  });
  const lines: string[] = [];

  const result = await collectTokens({
    tokens: [TOKEN],
    prisma: prismaWithFailingFailureCreate(prisma, createError),
    fetchImpl: fake.fetchImpl,
    intervalMs: 0,
    now: () => FIXED_NOW,
    log: () => {},
    logError: (line) => lines.push(line),
  });

  const line = lines.find((entry) =>
    entry.includes('[DB] não foi possível registrar a falha')
  );

  check(
    'falha ao registrar: não relança e mantém falha',
    result.failures === 1 && !result.rateLimited
  );
  check(
    'falha ao registrar: log mostra code',
    line?.includes('code=P2003') === true,
    `(${line})`
  );
  check(
    'falha ao registrar: log mostra meta JSON',
    line?.includes('meta={"field_name":"tokenId","reason":"META_DA_CAUSA"}') === true
  );
  check(
    'falha ao registrar: log mostra final da mensagem',
    line?.includes(ending) === true && line?.includes(beginning) !== true
  );
}

async function runDryRun(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);
  const fake = fakeFetch((url) => {
    const kind = callKind(url);
    if (kind === 'pools') return json(200, poolsPayload());
    if (kind === 'info') return json(200, infoPayload());
    return json(200, tokenPayload('4.0'));
  });
  const lines: string[] = [];

  const result = await collectTokens({
    tokens: [TOKEN],
    prisma,
    dryRun: true,
    fetchImpl: fake.fetchImpl,
    intervalMs: 0,
    now: () => FIXED_NOW,
    log: (line) => lines.push(line),
    logError: () => {},
  });

  check('dry-run: execução ok', result.ok === 1 && result.failures === 0);
  check('dry-run: sem Token', (await prisma.token.count({ where: { address: TOKEN } })) === 0);
  check('dry-run: sem TokenCapture', (await prisma.tokenCapture.count({ where: { token: { address: TOKEN } } })) === 0);
  check('dry-run: imprime preço/liquidez', lines.some((line) => line.includes('price=4 ') && line.includes('liquidity=123.46')));
  check('dry-run: imprime 5 pools', lines.filter((line) => line.includes('pool[')).length === 5);
  check('dry-run: imprime holders', lines.some((line) => line.includes('holders count=1234')));
}

async function main(): Promise<void> {
  const url = localDbUrl();
  if (url === null) {
    console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
    process.exit(0);
  }

  let prisma: PrismaClient | null = null;
  try {
    await ensureLocalSchema(url);
    const adapter = new PrismaPg({ connectionString: url });
    prisma = new PrismaClient({ adapter });

    await runIdempotent(prisma);
    await runRateLimit(prisma);
    await runInfo404(prisma);
    await runFailureLog(prisma);
    await runDryRun(prisma);
  } catch (e) {
    check('teste executou', false, e instanceof Error ? e.message : String(e));
  } finally {
    if (prisma !== null) {
      try {
        await cleanup(prisma);
      } catch {
        // limpeza best-effort
      }
      await prisma.$disconnect();
    }
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
