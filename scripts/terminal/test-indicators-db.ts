#!/usr/bin/env node
import { PrismaClient } from './generated/db/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPrismaReader } from './indicators/reader';
import {
  loadAllSeries,
  computeIndicatorRows,
  validateRowInvariants,
  buildAsOfDates,
  buildLoadRange,
  type IndicatorRow,
} from './indicators/catalog';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/(localhost|127\.0\.0\.1):5433/.test(url)) {
  console.error('[ABORT] TEST_DATABASE_URL ausente ou não aponta para localhost:5433');
  process.exit(1);
}
const parsed = new URL(url);
console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_DAYS = 10;
const ASSET_ROWS = 20;

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function approx(a: number | null, b: number, tol = 1e-9): boolean {
  return a !== null && Math.abs(a - b) < tol;
}

function findRow(rows: IndicatorRow[], indicator: string, scope: string, iso: string): IndicatorRow | undefined {
  return rows.find((r) => r.indicator === indicator && r.scope === scope && r.asOf.toISOString().slice(0, 10) === iso);
}

async function ensureSource(provider: string, displayName: string, baseUrl: string): Promise<{ id: string; created: boolean }> {
  const existing = await prisma.dataSource.findUnique({ where: { provider } });
  if (existing) return { id: existing.id, created: false };
  const created = await prisma.dataSource.create({ data: { provider, displayName, baseUrl } });
  return { id: created.id, created: true };
}

async function main(): Promise<void> {
  const now = new Date();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayUtc = new Date(todayStart).toISOString().slice(0, 10);

  const asOfs = buildAsOfDates(todayStart, TEST_DAYS);
  const { from, to } = buildLoadRange(todayStart, TEST_DAYS);

  const coingecko = await ensureSource('coingecko', 'TEST_INDICATORS_CG', 'http://test.local');
  const defillamaHistory = await ensureSource('defillama_history', 'TEST_INDICATORS_DL', 'http://test.local');

  const cleanupFrom = new Date(todayStart - 60 * DAY_MS);
  const cleanupTo = new Date(todayStart + DAY_MS);

  try {
    // limpa resíduos de execuções anteriores do teste
    await prisma.indicatorSnapshot.deleteMany({ where: { asOf: { gte: asOfs[asOfs.length - 1].date, lte: asOfs[0].date }, formulaVersion: 'v1' } });

    const marketRows: { sourceId: string; asset: string; priceUsd: number; volume24hUsd: number | null; sourceTs: Date; collectedAt: Date }[] = [];
    for (let k = 1; k <= ASSET_ROWS; k++) {
      const dayMs = todayStart - k * DAY_MS;
      marketRows.push({ sourceId: coingecko.id, asset: 'solana', priceUsd: 100 + k, volume24hUsd: 100 + k, sourceTs: new Date(dayMs), collectedAt: new Date(dayMs + 12 * 3600 * 1000) });
      marketRows.push({ sourceId: coingecko.id, asset: 'bitcoin', priceUsd: 50, volume24hUsd: null, sourceTs: new Date(dayMs), collectedAt: new Date(dayMs + 12 * 3600 * 1000) });
      marketRows.push({ sourceId: coingecko.id, asset: 'ethereum', priceUsd: 20, volume24hUsd: null, sourceTs: new Date(dayMs), collectedAt: new Date(dayMs + 12 * 3600 * 1000) });
    }
    await prisma.marketSnapshot.createMany({ data: marketRows });

    const metricRows: { sourceId: string; scope: string; metric: string; value: number; unit: string; sourceTs: Date; collectedAt: Date }[] = [];
    for (let k = 1; k <= ASSET_ROWS; k++) {
      const dayMs = todayStart - k * DAY_MS;
      const at = new Date(dayMs);
      metricRows.push({ sourceId: defillamaHistory.id, scope: 'solana', metric: 'tvl_usd', value: 1000 + k * 100, unit: 'USD', sourceTs: at, collectedAt: at });
      metricRows.push({ sourceId: defillamaHistory.id, scope: 'solana', metric: 'stablecoin_supply_usd', value: 500 + k * 10, unit: 'USD', sourceTs: at, collectedAt: at });
      metricRows.push({ sourceId: defillamaHistory.id, scope: 'solana', metric: 'dex_volume_daily_usd', value: 10 * k, unit: 'USD', sourceTs: at, collectedAt: at });
    }
    await prisma.metricSnapshot.createMany({ data: metricRows });

    const reader = createPrismaReader(prisma);
    const series = await loadAllSeries(reader, from, to, todayUtc);
    const { rows, statusCounts } = computeIndicatorRows(series, asOfs);

    check('catalog gerou 29*10 + 1 linhas', rows.length === 29 * TEST_DAYS + 1, `rows=${rows.length}`);
    check('invariantes de linha ok', validateRowInvariants(rows).length === 0);
    check('atr uma vez, unavailable', statusCounts.unavailable === 1, JSON.stringify(statusCounts));

    const first = await prisma.indicatorSnapshot.createMany({ data: rows, skipDuplicates: true });
    check('primeira execução insere todas', first.count === rows.length, `inserted=${first.count} expected=${rows.length}`);

    // valor calculado à mão: preço solana em today-1 = 101, em today-8 = 108
    const ret7 = findRow(rows, 'return_7d', 'solana', new Date(todayStart - DAY_MS).toISOString().slice(0, 10));
    check('return_7d solana valor = 101/108-1', approx(ret7?.value ? Number(ret7.value.toString()) : null, 101 / 108 - 1), `value=${ret7?.value}`);

    const persisted = await prisma.indicatorSnapshot.findFirst({
      where: { indicator: 'return_7d', scope: 'solana', asOf: new Date(todayStart - DAY_MS), formulaVersion: 'v1' },
    });
    check('return_7d persistido com status ok e from/to', persisted?.status === 'ok' && persisted?.fromDate !== null && persisted?.toDate !== null);

    const second = await prisma.indicatorSnapshot.createMany({ data: rows, skipDuplicates: true });
    check('segunda execução não duplica (idempotência)', second.count === 0, `inserted=${second.count}`);

    const total = await prisma.indicatorSnapshot.count({
      where: { asOf: { gte: asOfs[asOfs.length - 1].date, lte: asOfs[0].date }, formulaVersion: 'v1' },
    });
    check('total persistido continua igual', total === rows.length, `total=${total}`);
  } finally {
    await prisma.indicatorSnapshot.deleteMany({ where: { asOf: { gte: asOfs[asOfs.length - 1].date, lte: asOfs[0].date }, formulaVersion: 'v1' } });
    await prisma.marketSnapshot.deleteMany({ where: { sourceId: coingecko.id, asset: { in: ['solana', 'bitcoin', 'ethereum'] }, collectedAt: { gte: cleanupFrom, lte: cleanupTo } } });
    await prisma.metricSnapshot.deleteMany({ where: { sourceId: defillamaHistory.id, collectedAt: { gte: cleanupFrom, lte: cleanupTo } } });
    if (coingecko.created) {
      const remaining = await prisma.marketSnapshot.count({ where: { sourceId: coingecko.id } });
      if (remaining === 0) await prisma.dataSource.delete({ where: { id: coingecko.id } }).catch(() => {});
    }
    if (defillamaHistory.created) {
      const remaining = await prisma.metricSnapshot.count({ where: { sourceId: defillamaHistory.id } });
      if (remaining === 0) await prisma.dataSource.delete({ where: { id: defillamaHistory.id } }).catch(() => {});
    }
    await prisma.$disconnect();
    console.log('[TEST] dados de teste apagados');
  }

  console.log(`=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
