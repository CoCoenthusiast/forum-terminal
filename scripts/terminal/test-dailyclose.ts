import { PrismaClient } from './generated/db/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { computeDailyCloses, APPROX_CALC_METHOD } from './persist';
import { ASSETS, CALC_METHOD } from './config';


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
function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (!ok) failures++;
}


async function main() {
  const prisma = createTestPrisma(url as string);


  const ds = await prisma.dataSource.create({
    data: {
      provider: 'TEST_DAILYCLOSE_TMP',
      displayName: 'TEST_DAILYCLOSE_TMP',
      baseUrl: 'http://test.local',
    },
  });
  const sourceId: string = ds.id;


  const runAt = new Date();
  const noonToday = new Date(Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate(), 12));
  const todayStart = Date.UTC(runAt.getUTCFullYear(), runAt.getUTCMonth(), runAt.getUTCDate());
  const day = (i: number) => new Date(todayStart - i * DAY_MS);


  const mk = (asset: string, at: Date, price: number) =>
    prisma.marketSnapshot.create({
      data: { sourceId, asset, priceUsd: price, sourceTs: at, collectedAt: at },
    });


  try {
    // Dia 1 (caso a): snapshot cedo + snapshot DENTRO da janela final; esperado o da janela
    for (const a of ASSETS) {
      await mk(a, new Date(day(1).getTime() + 3 * 3600 * 1000), 10);
      await mk(a, new Date(day(1).getTime() + DAY_MS - 10 * 60 * 1000), 11);
    }
    // Dia 2 (caso b): só snapshots fora da janela; esperado o ÚLTIMO do dia (200)
    for (const a of ASSETS) {
      await mk(a, new Date(day(2).getTime() + 2 * 3600 * 1000), 100);
      await mk(a, new Date(day(2).getTime() + 5 * 3600 * 1000), 200);
    }
    // Dia 3 (caso c): nenhum snapshot
    // Hoje: snapshot que NÃO pode gerar fechamento
    for (const a of ASSETS) await mk(a, new Date(todayStart + 6 * 3600 * 1000), 999);


    const r1 = await computeDailyCloses(prisma, noonToday, 3);
    console.log('Primeira execução:', r1);


    const closes = await prisma.dailyClose.findMany({
      where: { sourceSnapshot: { sourceId } },
      orderBy: [{ date: 'asc' }, { asset: 'asc' }],
    });
    console.log(closes.map((c) => ({
      asset: c.asset, date: c.date.toISOString().slice(0, 10),
      calcMethod: c.calcMethod, calcVersion: c.calcVersion, closeUsd: c.closeUsd.toString(),
    })));


    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const d1 = closes.filter((c) => iso(c.date) === iso(day(1)));
    const d2 = closes.filter((c) => iso(c.date) === iso(day(2)));
    const d3 = closes.filter((c) => iso(c.date) === iso(day(3)));
    const d0 = closes.filter((c) => iso(c.date) === iso(new Date(todayStart)));


    check('a) dia na janela: 3 fechamentos com CALC_METHOD e preço 11',
      d1.length === 3 && d1.every((c) => c.calcMethod === CALC_METHOD && Number(c.closeUsd.toString()) === 11));
    check('b) dia fora da janela: 3 fechamentos com APPROX e preço do último snapshot (200)',
      d2.length === 3 && d2.every((c) => c.calcMethod === APPROX_CALC_METHOD && Number(c.closeUsd.toString()) === 200));
    check('c) dia sem coleta: nenhum fechamento', d3.length === 0);
    check('c2) dia atual nunca é fechado', d0.length === 0);
    check('c3) primeira execução criou 6 fechamentos', r1.created === 6, JSON.stringify(r1));


    const r2 = await computeDailyCloses(prisma, noonToday, 3);
    console.log('Segunda execução:', r2);
    const closes2 = await prisma.dailyClose.count({ where: { sourceSnapshot: { sourceId } } });
    check('d) rodar duas vezes: sem duplicatas', closes2 === closes.length && r2.created === 0,
      `linhas=${closes2}`);
  } finally {
    await prisma.dailyClose.deleteMany({ where: { sourceSnapshot: { sourceId } } });
    await prisma.marketSnapshot.deleteMany({ where: { sourceId } });
    await prisma.dataSource.delete({ where: { id: sourceId } });
    await prisma.$disconnect();
    console.log('[TEST] dados de teste apagados');
  }


  console.log(failures === 0 ? 'RESULTADO: TODOS PASSARAM' : `RESULTADO: ${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
}


main().catch((e) => { console.error(e); process.exit(1); });