#!/usr/bin/env node

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { collectHyperliquid, startOfUtcHour } from '../collect-hyperliquid';
import {
  fetchHyperliquidPerpSnapshot,
  HttpError,
  parseHyperliquidPerpSnapshot,
  toDecimalString,
  type FetchLike,
  type HyperliquidCoin,
  type HyperliquidPerpSnapshot,
} from '../sources/hyperliquid';

const FIXED_NOW_1 = new Date('2026-10-23T15:05:00.000Z');
const FIXED_NOW_2 = new Date('2026-10-23T15:35:00.000Z');
const BUCKET = '2026-10-23T15:00:00.000Z';
const PROVIDER = 'hyperliquid';

type FixtureContext = Record<string, unknown>;
type Fixture = [Record<string, unknown>, FixtureContext[]];
type FakeCall = { url: string; init?: RequestInit };

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

function context(overrides: FixtureContext = {}): FixtureContext {
  return {
    funding: '0.00001',
    openInterest: '1000.5',
    dayNtlVlm: '2000000.25',
    markPx: '100.25',
    oraclePx: '100.5',
    premium: '-0.0001',
    ...overrides,
  };
}

function fixture(): Fixture {
  return [
    {
      universe: [
        { name: 'BTC' },
        { name: 'ETH' },
        { name: 'SOL' },
      ],
    },
    [
      context({
        funding: '0.00002',
        openInterest: '42000.5',
        dayNtlVlm: '2854102532.05',
        markPx: '79958.0',
        oraclePx: '79982.0',
        premium: '-0.0003',
      }),
      context({
        funding: '-0.0000017',
        openInterest: '1127878.79',
        dayNtlVlm: '1004206727.3',
        markPx: '2307.7',
        oraclePx: '2308.9',
        premium: '-0.0005',
      }),
      context({
        funding: '0.0000125',
        openInterest: '5555414.2800000003',
        dayNtlVlm: '155707972.255899936',
        markPx: '100.36',
        oraclePx: '100.3925',
        premium: '-0.0003237294',
      }),
    ],
  ];
}

function fixtureWithoutEth(): Fixture {
  const data = fixture();
  return [
    { universe: [{ name: 'BTC' }, { name: 'SOL' }] },
    [data[1][0] as FixtureContext, data[1][2] as FixtureContext],
  ];
}

function fixtureWithInvalidSolPremium(): Fixture {
  const data = fixture();
  const sol = data[1][2];

  if (sol !== undefined) {
    sol.premium = 'NAO_E_DECIMAL';
  }

  return data;
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): {
  fetchImpl: FetchLike;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];

  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return handler(url, init);
    },
  };
}

function coinOf(snapshot: HyperliquidPerpSnapshot, coin: HyperliquidCoin) {
  return snapshot.coins.find((item) => item.coin === coin);
}

async function runUnit(): Promise<void> {
  const parsed = parseHyperliquidPerpSnapshot(fixture());
  const sol = coinOf(parsed, 'SOL');
  const btc = coinOf(parsed, 'BTC');
  const eth = coinOf(parsed, 'ETH');

  check('parser: SOL encontrado pelo nome', sol?.found === true);
  check('parser: SOL usa assetCtxs do mesmo índice', sol?.fields.funding === '0.0000125', `(${sol?.fields.funding})`);
  check('parser: OI preservado como string', sol?.fields.openInterest === '5555414.2800000003');
  check('parser: premium preservado como string', sol?.fields.premium === '-0.0003237294');
  check('parser: BTC lido pelo nome', btc?.fields.funding === '0.00002' && btc?.fields.markPx === '79958.0');
  check('parser: ETH lido pelo nome', eth?.fields.markPx === '2307.7' && eth?.fields.oraclePx === '2308.9');

  check('decimal: aceita string decimal', toDecimalString('1.2345') === '1.2345');
  check('decimal: aceita notação científica', toDecimalString('-1e-8') === '-1e-8');
  check('decimal: rejeita number', toDecimalString(1.2) === null);
  check('decimal: rejeita vazio', toDecimalString('') === null);
  check('decimal: rejeita texto', toDecimalString('abc') === null);

  check('bucket: início da hora UTC', startOfUtcHour(FIXED_NOW_1).toISOString() === BUCKET);

  const missing = parseHyperliquidPerpSnapshot(fixtureWithoutEth());
  const missingEth = coinOf(missing, 'ETH');
  check('parser: moeda ausente marcada', missingEth?.found === false && missingEth?.reason === 'ausente em universe');

  const invalid = parseHyperliquidPerpSnapshot(fixtureWithInvalidSolPremium());
  const invalidSol = coinOf(invalid, 'SOL');
  check('parser: campo inválido marcado', invalidSol?.invalidFields.includes('premium') === true);
  check('parser: campo inválido não vira valor', invalidSol?.fields.premium === null);
  check('parser: outros campos seguem válidos', invalidSol?.fields.funding === '0.0000125');

  const fake429 = fakeFetch(() => new Response('', { status: 429 }));
  let rateLimitError: unknown = null;

  try {
    await fetchHyperliquidPerpSnapshot(fake429.fetchImpl);
  } catch (error) {
    rateLimitError = error;
  }

  check('429: lança HttpError 429', rateLimitError instanceof HttpError && rateLimitError.status === 429);
  check('429: exatamente uma chamada', fake429.calls.length === 1, `(${fake429.calls.length})`);
  check(
    '429: chamada é POST metaAndAssetCtxs',
    fake429.calls[0]?.init?.method === 'POST' &&
      fake429.calls[0]?.init?.body === '{"type":"metaAndAssetCtxs"}'
  );

  const dryLines: string[] = [];
  const fakeDry = fakeFetch(() => json(200, fixture()));
  const dry = await collectHyperliquid({
    dryRun: true,
    fetchImpl: fakeDry.fetchImpl,
    now: () => FIXED_NOW_1,
    log: (line) => dryLines.push(line),
    logError: () => {},
  });

  check('dry-run: 18 métricas', dry.records === 18 && dry.ok, `(records=${dry.records})`);
  check('dry-run: uma chamada', fakeDry.calls.length === 1);
  check(
    'dry-run: imprime funding SOL',
    dryLines.some(
      (line) =>
        line.includes('scope=hyperliquid:perp:SOL') &&
        line.includes('metric=perp_funding_rate_1h') &&
        line.includes('value=0.0000125')
    )
  );
  check(
    'dry-run: OI com unidade da moeda',
    dryLines.some(
      (line) =>
        line.includes('scope=hyperliquid:perp:SOL') &&
        line.includes('metric=perp_open_interest_coin') &&
        line.includes('unit=SOL')
    )
  );
  check('dry-run: não imprime OI em USD', !dryLines.some((line) => line.includes('perp_open_interest_usd')));
  check('dry-run: avisa ausência de escrita', dryLines.some((line) => line.includes('nenhuma escrita no banco')));

  const missingLines: string[] = [];
  const missingSummary = await collectHyperliquid({
    dryRun: true,
    fetchImpl: fakeFetch(() => json(200, fixtureWithoutEth())).fetchImpl,
    now: () => FIXED_NOW_1,
    log: (line) => missingLines.push(line),
    logError: () => {},
  });

  check(
    'dry-run: moeda ausente falha sem inventar zero',
    !missingSummary.ok &&
      missingSummary.missingCoins.includes('ETH') &&
      missingSummary.records === 12 &&
      missingLines.some((line) => line.includes('falha coin=ETH'))
  );
}

async function getSource(prisma: PrismaClient): Promise<{ id: string } | null> {
  return prisma.dataSource.findUnique({
    where: { provider: PROVIDER },
    select: { id: true },
  });
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  const source = await getSource(prisma);

  if (source === null) {
    return;
  }

  await prisma.metricSnapshot.deleteMany({ where: { sourceId: source.id } });
  await prisma.collectionLog.deleteMany({ where: { sourceId: source.id } });
  await prisma.dataSource.delete({ where: { id: source.id } });
}

async function runDb(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);

  const fakeFirst = fakeFetch(() => json(200, fixture()));
  const first = await collectHyperliquid({
    prisma,
    fetchImpl: fakeFirst.fetchImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: primeira coleta grava 18',
    first.ok && first.records === 18 && first.inserted === 18,
    `(ok=${first.ok} records=${first.records} inserted=${first.inserted})`
  );
  check('db: uma chamada POST', fakeFirst.calls.length === 1 && fakeFirst.calls[0]?.init?.method === 'POST');

  const source = await getSource(prisma);
  check('db: DataSource hyperliquid', source !== null);

  if (source === null) {
    return;
  }

  const rows = await prisma.metricSnapshot.findMany({ where: { sourceId: source.id } });
  const solOpenInterest = rows.find(
    (row) => row.scope === 'hyperliquid:perp:SOL' && row.metric === 'perp_open_interest_coin'
  );
  const solFunding = rows.find(
    (row) => row.scope === 'hyperliquid:perp:SOL' && row.metric === 'perp_funding_rate_1h'
  );

  check('db: 18 linhas no banco', rows.length === 18, `(${rows.length})`);
  check(
    'db: 6 métricas por moeda',
    ['SOL', 'BTC', 'ETH'].every(
      (coin) => rows.filter((row) => row.scope === `hyperliquid:perp:${coin}`).length === 6
    )
  );
  check('db: bucketTs no início da hora UTC', rows.every((row) => row.bucketTs?.toISOString() === BUCKET));
  check(
    'db: collectedAt da coleta',
    rows.every((row) => row.collectedAt.toISOString() === FIXED_NOW_1.toISOString())
  );
  check('db: OI usa unidade SOL', solOpenInterest?.unit === 'SOL');
  check(
    'db: OI persiste conforme precisão do schema',
    solOpenInterest?.value.toString() === '5555414.28',
    `(${solOpenInterest?.value.toString()})`
  );
  check(
    'db: funding preservado via Decimal',
    solFunding?.unit === 'FRACTION' && solFunding.value.toString() === '0.0000125'
  );
  check('db: sem open interest USD', !rows.some((row) => row.metric === 'perp_open_interest_usd'));

  const successLog = await prisma.collectionLog.findFirst({
    where: { sourceId: source.id, status: 'success', operation: 'fetch_perp_metrics' },
    orderBy: { collectedAt: 'desc' },
  });
  check('db: CollectionLog success com 18', successLog?.recordsFetched === 18);

  const fakeSecond = fakeFetch(() => json(200, fixture()));
  const second = await collectHyperliquid({
    prisma,
    fetchImpl: fakeSecond.fetchImpl,
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });

  check(
    'db: segunda execução na mesma hora não quebra',
    second.ok && second.records === 18 && second.inserted === 18,
    `(ok=${second.ok} records=${second.records} inserted=${second.inserted})`
  );

  const countAfterSecond = await prisma.metricSnapshot.count({ where: { sourceId: source.id } });
  const bucketCountAfterSecond = await prisma.metricSnapshot.count({
    where: { sourceId: source.id, bucketTs: new Date(BUCKET) },
  });

  check('db: duas execuções na mesma hora duplicam linhas', countAfterSecond === 36, `(count=${countAfterSecond})`);
  check('db: duplicatas ficam no mesmo bucketTs', bucketCountAfterSecond === 36, `(count=${bucketCountAfterSecond})`);

  const third = await collectHyperliquid({
    prisma,
    fetchImpl: fakeFetch(() => json(200, fixture())).fetchImpl,
    now: () => FIXED_NOW_2,
    log: () => {},
    logError: () => {},
  });

  const countAfterThird = await prisma.metricSnapshot.count({ where: { sourceId: source.id } });
  check(
    'db: mesmo collectedAt é ignorado por skipDuplicates',
    third.inserted === 0 && countAfterThird === 36,
    `(inserted=${third.inserted} count=${countAfterThird})`
  );

  await cleanup(prisma);

  const fakeMissing = fakeFetch(() => json(200, fixtureWithoutEth()));
  const missing = await collectHyperliquid({
    prisma,
    fetchImpl: fakeMissing.fetchImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const missingSource = await getSource(prisma);

  check(
    'db: moeda ausente grava somente as outras',
    !missing.ok &&
      missing.missingCoins.includes('ETH') &&
      missing.records === 12 &&
      missing.inserted === 12,
    `(ok=${missing.ok} records=${missing.records} inserted=${missing.inserted})`
  );

  if (missingSource !== null) {
    const missingRows = await prisma.metricSnapshot.count({ where: { sourceId: missingSource.id } });
    const ethRows = await prisma.metricSnapshot.count({
      where: { sourceId: missingSource.id, scope: 'hyperliquid:perp:ETH' },
    });
    const ethFailure = await prisma.collectionLog.findFirst({
      where: {
        sourceId: missingSource.id,
        status: 'error',
        operation: 'fetch_perp_metrics',
        errorMessage: { contains: 'ETH' },
      },
    });

    check('db: 12 linhas sem ETH', missingRows === 12, `(${missingRows})`);
    check('db: nenhuma métrica ETH', ethRows === 0, `(${ethRows})`);
    check('db: falha ETH registrada', ethFailure !== null);
  }

  await cleanup(prisma);

  const invalid = await collectHyperliquid({
    prisma,
    fetchImpl: fakeFetch(() => json(200, fixtureWithInvalidSolPremium())).fetchImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const invalidSource = await getSource(prisma);

  check(
    'db: campo inválido é omitido',
    !invalid.ok &&
      invalid.records === 17 &&
      invalid.inserted === 17 &&
      invalid.invalidFields.some((issue) => issue.coin === 'SOL' && issue.fields.includes('premium')),
    `(records=${invalid.records} inserted=${invalid.inserted})`
  );

  if (invalidSource !== null) {
    const premiumRows = await prisma.metricSnapshot.count({
      where: {
        sourceId: invalidSource.id,
        scope: 'hyperliquid:perp:SOL',
        metric: 'perp_premium',
      },
    });
    const invalidFailure = await prisma.collectionLog.findFirst({
      where: {
        sourceId: invalidSource.id,
        status: 'error',
        operation: 'fetch_perp_metrics',
        errorMessage: { contains: 'SOL' },
      },
    });

    check('db: perp_premium SOL não gravado', premiumRows === 0, `(${premiumRows})`);
    check('db: falha do campo inválido registrada', invalidFailure !== null);
  }

  await cleanup(prisma);

  const fake429 = fakeFetch(() => new Response('', { status: 429 }));
  const limited = await collectHyperliquid({
    prisma,
    fetchImpl: fake429.fetchImpl,
    now: () => FIXED_NOW_1,
    log: () => {},
    logError: () => {},
  });
  const limitedSource = await getSource(prisma);

  check(
    'db: 429 para sem retry e sem métricas',
    limited.httpStatus === 429 && limited.records === 0 && fake429.calls.length === 1,
    `(http=${limited.httpStatus} calls=${fake429.calls.length})`
  );

  if (limitedSource !== null) {
    const limitedRows = await prisma.metricSnapshot.count({ where: { sourceId: limitedSource.id } });
    const limitedLog = await prisma.collectionLog.findFirst({
      where: { sourceId: limitedSource.id, status: 'error', httpStatus: 429 },
    });

    check('db: 429 não grava métricas', limitedRows === 0, `(${limitedRows})`);
    check('db: falha 429 registrada', limitedLog !== null);
  }

  await cleanup(prisma);

  const dryLines: string[] = [];
  const dry = await collectHyperliquid({
    prisma,
    dryRun: true,
    fetchImpl: fakeFetch(() => json(200, fixture())).fetchImpl,
    now: () => FIXED_NOW_1,
    log: (line) => dryLines.push(line),
    logError: () => {},
  });
  const drySource = await getSource(prisma);
  const anyHyperliquidMetrics = await prisma.metricSnapshot.count({
    where: { source: { provider: PROVIDER } },
  });
  const anyHyperliquidLogs = await prisma.collectionLog.count({
    where: { source: { provider: PROVIDER } },
  });

  check('db: dry-run calcula 18', dry.ok && dry.records === 18, `(records=${dry.records})`);
  check('db: dry-run não cria DataSource', drySource === null);
  check('db: dry-run não grava métricas', anyHyperliquidMetrics === 0, `(${anyHyperliquidMetrics})`);
  check('db: dry-run não grava CollectionLog', anyHyperliquidLogs === 0, `(${anyHyperliquidLogs})`);
  check('db: dry-run imprime 18 métricas', dryLines.filter((line) => line.includes('scope=')).length === 18);
}

async function main(): Promise<void> {
  await runUnit();

  const url = localDbUrl();

  if (url !== null) {
    const adapter = new PrismaPg({ connectionString: url });
    const prisma = new PrismaClient({ adapter });

    try {
      await runDb(prisma);
    } catch (error) {
      check('db executou', false, error instanceof Error ? error.message : String(error));
    } finally {
      try {
        await cleanup(prisma);
      } catch {
        console.error('[CLEANUP] falha na limpeza best-effort');
      }
      await prisma.$disconnect();
    }
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
