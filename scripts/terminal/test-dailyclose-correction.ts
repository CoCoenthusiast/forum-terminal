#!/usr/bin/env node
import { PrismaClient } from './generated/db/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { computeDailyCloses, upgradeDailyCloses, APPROX_CALC_METHOD } from './persist';
import { CALC_METHOD, HISTORY_CALC_METHOD } from './config';


const url = process.env.TEST_DATABASE_URL;
if (!url || !/(localhost|127\.0\.0\.1):5433/.test(url)) {
  console.error('[ABORT] TEST_DATABASE_URL ausente ou não aponta para localhost:5433');
  process.exit(1);
}
const parsed = new URL(url);
console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);


function createTestPrisma(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}


const DAY_MS = 24 * 60 * 60 * 1000;
let failures = 0;
let passed = 0;
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++; else failures++;
}


async function main() {
  const prisma = createTestPrisma(url as string);

  const runAt = new Date(Date.UTC(2035, 5, 20, 12)); // 2035-06-20T12:00Z
  const todayStart = Date.UTC(2035, 5, 20);
  const day = (i: number) => new Date(todayStart - i * DAY_MS);

  const historyProvider = 'coingecko_history';
  const liveProvider = 'coingecko';

  const existingHistory = await prisma.dataSource.findUnique({ where: { provider: historyProvider } });
  const existingLive = await prisma.dataSource.findUnique({ where: { provider: liveProvider } });

  const historySource = existingHistory ?? await prisma.dataSource.create({
    data: { provider: historyProvider, displayName: 'TEST_DCC_HISTORY', baseUrl: 'http://test.local' },
  });
  const liveSource = existingLive ?? await prisma.dataSource.create({
    data: { provider: liveProvider, displayName: 'TEST_DCC_LIVE', baseUrl: 'http://test.local' },
  });
  const historySourceId = historySource.id;
  const liveSourceId = liveSource.id;

  const cleanupFrom = new Date(Date.UTC(2035, 5, 1));
  const cleanupTo = new Date(Date.UTC(2035, 7, 1));

  const mkSnapshot = (sourceId: string, asset: string, at: Date, price: number) =>
    prisma.marketSnapshot.create({
      data: { sourceId, asset, priceUsd: price, sourceTs: at, collectedAt: at },
    });

  const mkClose = (asset: string, date: Date, snapshotId: string, price: number, method: string) =>
    prisma.dailyClose.create({
      data: { asset, date, closeUsd: price, sourceSnapshotId: snapshotId, calcMethod: method, calcVersion: 1 },
    });

  const getClose = (asset: string, date: Date) =>
    prisma.dailyClose.findUnique({ where: { asset_date: { asset, date } } });

  try {
    // --- Cenário 1: histórico vence o snapshot ao vivo da janela (bitcoin, 06-19) ---
    const live1 = await mkSnapshot(liveSourceId, 'bitcoin', new Date(day(1).getTime() + DAY_MS - 30 * 60 * 1000), 100);
    await mkClose('bitcoin', day(1), live1.id, 100, CALC_METHOD);
    await mkSnapshot(historySourceId, 'bitcoin', day(0), 200); // 06-20T00:00 = diaEnd de 06-19

    // --- Cenário 2: histórico vence o aprox (ethereum, 06-18) ---
    const approx2 = await mkSnapshot(liveSourceId, 'ethereum', new Date(day(2).getTime() + 2 * 3600 * 1000), 300);
    await mkClose('ethereum', day(2), approx2.id, 300, APPROX_CALC_METHOD);
    await mkSnapshot(historySourceId, 'ethereum', day(1), 400); // 06-19T00:00 = diaEnd de 06-18

    // --- Cenário 3: sem histórico, permanece inalterado (solana, 06-17) ---
    const live3 = await mkSnapshot(liveSourceId, 'solana', new Date(day(3).getTime() + DAY_MS - 30 * 60 * 1000), 500);
    await mkClose('solana', day(3), live3.id, 500, CALC_METHOD);

    // --- Cenário 4: cadeia deslocada (solana 06-14/15/16) ---
    // Linhas existentes apontam para o snapshot do próprio dia; alvos do histórico são o snapshot do dia seguinte.
    const s14 = await mkSnapshot(liveSourceId, 'solana', new Date(day(6).getTime() + 12 * 3600 * 1000), 10); // 06-14T12:00
    await mkClose('solana', day(6), s14.id, 10, APPROX_CALC_METHOD);
    const s15 = await mkSnapshot(historySourceId, 'solana', day(5), 11); // 06-15T00:00 = alvo de 06-14
    await mkClose('solana', day(5), s15.id, 900, APPROX_CALC_METHOD);
    const s16 = await mkSnapshot(historySourceId, 'solana', day(4), 12); // 06-16T00:00 = alvo de 06-15
    await mkClose('solana', day(4), s16.id, 900, APPROX_CALC_METHOD);
    const s17 = await mkSnapshot(historySourceId, 'solana', day(3), 13); // 06-17T00:00 = alvo de 06-16
    // Nota: s17 também é diaEnd de 06-16; s15/s16/s17 são os alvos do histórico da cadeia.

    // --- Executa o upgrade (deve processar em ordem decrescente) ---
    const r1 = await upgradeDailyCloses(prisma, runAt, 7);
    console.log('Primeira execução do upgrade:', r1);

    check('1) histórico vence janela ao vivo (bitcoin 06-19)',
      (await getClose('bitcoin', day(1)))?.calcMethod === HISTORY_CALC_METHOD &&
      Number((await getClose('bitcoin', day(1)))!.closeUsd.toString()) === 200);

    check('2) histórico vence aprox (ethereum 06-18)',
      (await getClose('ethereum', day(2)))?.calcMethod === HISTORY_CALC_METHOD &&
      Number((await getClose('ethereum', day(2)))!.closeUsd.toString()) === 400);

    check('3) sem histórico permanece inalterado (solana 06-17)',
      (await getClose('solana', day(3)))?.calcMethod === CALC_METHOD &&
      Number((await getClose('solana', day(3)))!.closeUsd.toString()) === 500);

    const c14 = await getClose('solana', day(6));
    const c15 = await getClose('solana', day(5));
    const c16 = await getClose('solana', day(4));
    check('4) cadeia deslocada corrigida sem violar unicidade e na ordem certa',
      c14?.calcMethod === HISTORY_CALC_METHOD && Number(c14!.closeUsd.toString()) === 11 &&
      c15?.calcMethod === HISTORY_CALC_METHOD && Number(c15!.closeUsd.toString()) === 12 &&
      c16?.calcMethod === HISTORY_CALC_METHOD && Number(c16!.closeUsd.toString()) === 13,
      `06-14=${c14?.closeUsd.toString()} 06-15=${c15?.closeUsd.toString()} 06-16=${c16?.closeUsd.toString()}`);

    check('4b) primeira execução: corrected=5, blocked=0, alreadyCurrent=1, noCandidate=0',
      r1.corrected === 5 && r1.blocked === 0 && r1.alreadyCurrent === 1 && r1.noCandidate === 0,
      JSON.stringify(r1));

    const corrCount = await prisma.dailyCloseCorrection.count({
      where: { date: { gte: cleanupFrom, lt: cleanupTo } },
    });
    check('4c) 5 registros de correção gravados', corrCount === 5, `count=${corrCount}`);

    const corrBitcoin = await prisma.dailyCloseCorrection.findFirst({
      where: { asset: 'bitcoin', date: day(1) },
    });
    check('4d) correção guarda valores antigos e novos',
      corrBitcoin !== null &&
      Number(corrBitcoin!.oldCloseUsd.toString()) === 100 &&
      Number(corrBitcoin!.newCloseUsd.toString()) === 200 &&
      corrBitcoin!.oldCalcMethod === CALC_METHOD &&
      corrBitcoin!.newCalcMethod === HISTORY_CALC_METHOD);

    // --- Segunda execução: idempotente ---
    const r2 = await upgradeDailyCloses(prisma, runAt, 7);
    console.log('Segunda execução do upgrade:', r2);
    const corrCount2 = await prisma.dailyCloseCorrection.count({
      where: { date: { gte: cleanupFrom, lt: cleanupTo } },
    });
    check('5) segunda execução não corrige nem duplica', r2.corrected === 0 && corrCount2 === 5,
      `corrected=${r2.corrected} corrections=${corrCount2}`);

    // --- Cenário 6: computeDailyCloses usa histórico ao criar (não corrige existentes) ---
    const createRunAt = new Date(Date.UTC(2035, 6, 1, 12)); // 2035-07-01T12:00Z -> fecha 06-30
    const day0630 = new Date(Date.UTC(2035, 5, 30));
    const day0701 = new Date(Date.UTC(2035, 6, 1));
    await mkSnapshot(historySourceId, 'bitcoin', day0701, 50); // 07-01T00:00 = diaEnd de 06-30
    const r3 = await computeDailyCloses(prisma, createRunAt, 1);
    const created = await getClose('bitcoin', day0630);
    check('6) computeDailyCloses cria fechamento a partir do histórico',
      r3.created === 1 && created?.calcMethod === HISTORY_CALC_METHOD &&
      Number(created!.closeUsd.toString()) === 50,
      JSON.stringify(r3));
  } finally {
    await prisma.dailyCloseCorrection.deleteMany({ where: { date: { gte: cleanupFrom, lt: cleanupTo } } });
    await prisma.dailyClose.deleteMany({
      where: { sourceSnapshot: { sourceId: { in: [historySourceId, liveSourceId] } } },
    });
    await prisma.marketSnapshot.deleteMany({
      where: { sourceId: { in: [historySourceId, liveSourceId] }, collectedAt: { gte: cleanupFrom, lt: cleanupTo } },
    });
    if (!existingHistory) {
      const remaining = await prisma.marketSnapshot.count({ where: { sourceId: historySourceId } });
      if (remaining === 0) await prisma.dataSource.delete({ where: { id: historySourceId } }).catch(() => {});
    }
    if (!existingLive) {
      const remaining = await prisma.marketSnapshot.count({ where: { sourceId: liveSourceId } });
      if (remaining === 0) await prisma.dataSource.delete({ where: { id: liveSourceId } }).catch(() => {});
    }
    await prisma.$disconnect();
    console.log('[TEST] dados de teste apagados');
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}


main().catch((e) => { console.error(e); process.exit(1); });
