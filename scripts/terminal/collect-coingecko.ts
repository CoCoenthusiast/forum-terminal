#!/usr/bin/env node
import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment } from './config';
import { fetchMarkets, fetchGlobal } from './sources/coingecko';
import { computeDailyCloses } from './persist';

async function logEndpoint(
  prisma: PrismaClient,
  sourceId: string,
  operation: string,
  endpoint: string,
  fn: () => Promise<{ records: number }>
): Promise<{ ok: boolean; error?: string }> {
  const start = Date.now();
  try {
    const result = await fn();
    await prisma.collectionLog.create({
      data: { sourceId, operation, endpoint, status: 'success', latencyMs: Date.now() - start, recordsFetched: result.records }
    });
    return { ok: true };
  } catch (e) {
    let msg: string;
    let httpStatus: number | null = null;
    if (e instanceof Error && 'status' in e && typeof (e as { status?: number }).status === 'number') {
      msg = `HTTP ${(e as { status: number }).status}`;
      httpStatus = (e as { status: number }).status;
    } else if (e instanceof Error) {
      msg = e.message;
    } else {
      msg = String(e);
    }
    const truncated = msg.slice(0, 300);
    try {
      await prisma.collectionLog.create({
        data: { sourceId, operation, endpoint, status: 'error', latencyMs: Date.now() - start, errorMessage: truncated, httpStatus }
      });
    } catch (logErr) {
      console.error('[logEndpoint] falha ao gravar CollectionLog:', logErr instanceof Error ? logErr.message : String(logErr).slice(0, 200));
    }
    return { ok: false, error: truncated };
  }
}

async function run(prisma: PrismaClient): Promise<{ marketsOk: boolean; globalOk: boolean; dailyCloseOk: boolean; dailyCloseStats?: { created: number; daysWithoutSnapshot: number; daysAlreadyClosed: number } }> {
  const runCollectedAt = new Date();
  const source = await prisma.dataSource.upsert({
    where: { provider: 'coingecko' },
    update: {},
    create: { provider: 'coingecko', displayName: 'CoinGecko Demo', baseUrl: 'https://api.coingecko.com/api/v3', version: 'v3' },
    select: { id: true },
  });

  // 1. /coins/markets
  const marketsResult = await logEndpoint(prisma, source.id, 'fetch_price', '/coins/markets', async () => {
    const data = await fetchMarkets();
    if (!Array.isArray(data) || data.length !== 3) throw new Error('Esperado 3 ativos (solana, bitcoin, ethereum)');
    for (const m of data) {
      if (m.current_price === null || m.current_price === undefined) throw new Error(`current_price nulo para ${m.id}`);
      if (!['solana', 'bitcoin', 'ethereum'].includes(m.id)) throw new Error(`Ativo inesperado: ${m.id}`);
    }
    const snapshots = data.map(m => ({
      sourceId: source.id,
      asset: m.id,
      priceUsd: new Decimal(String(m.current_price)),
      change24hPct: m.price_change_percentage_24h != null ? new Decimal(String(m.price_change_percentage_24h)) : null,
      volume24hUsd: m.total_volume != null ? new Decimal(String(m.total_volume)) : null,
      marketCapUsd: m.market_cap != null ? new Decimal(String(m.market_cap)) : null,
      sourceTs: new Date(m.last_updated),
      collectedAt: runCollectedAt,
    }));
    await prisma.marketSnapshot.createMany({ data: snapshots });
    return { records: snapshots.length };
  });
  if (!marketsResult.ok) console.error('[fetch_price] falhou');

  // 2. /global
  const globalResult = await logEndpoint(prisma, source.id, 'fetch_global', '/global', async () => {
    const data = await fetchGlobal();
    if (!data?.data?.market_cap_percentage?.btc || !data.data?.total_market_cap?.usd || !data.data?.updated_at) {
      throw new Error('Campos obrigatórios ausentes em /global');
    }
    const sourceTs = new Date(data.data.updated_at * 1000);
    const metrics = [
      { scope: 'global', metric: 'btc_dominance_pct', value: new Decimal(String(data.data.market_cap_percentage.btc)), unit: 'PERCENT', sourceTs, collectedAt: runCollectedAt, sourceId: source.id },
      { scope: 'global', metric: 'global_market_cap_usd', value: new Decimal(String(data.data.total_market_cap.usd)), unit: 'USD', sourceTs, collectedAt: runCollectedAt, sourceId: source.id },
    ];
    await prisma.metricSnapshot.createMany({ data: metrics });
    return { records: 2 };
  });
  if (!globalResult.ok) console.error('[fetch_global] falhou');

  // 3. DailyClose
  let dailyCloseOk = true;
  let dailyCloseStats: { created: number; daysWithoutSnapshot: number; daysAlreadyClosed: number } | undefined;
  try {
    const stats = await computeDailyCloses(prisma, runCollectedAt, 7);
    dailyCloseStats = stats;
    console.log(`[DailyClose] created=${stats.created}, without_snapshot=${stats.daysWithoutSnapshot}, already_closed=${stats.daysAlreadyClosed}`);
  } catch (e) {
    dailyCloseOk = false;
    console.error('[DailyClose] falhou:', e instanceof Error ? e.message : String(e).slice(0, 300));
  }

  return { marketsOk: marketsResult.ok, globalOk: globalResult.ok, dailyCloseOk, dailyCloseStats };
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log('[DRY-RUN] Modo simulação - sem escrita no banco');
    try {
      const demoKey = process.env.COINGECKO_DEMO_API_KEY;
      const headers: Record<string, string> = { 'Accept': 'application/json' };
      if (demoKey) headers['x-cg-demo-api-key'] = demoKey;

      const [markets, global] = await Promise.all([
        fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=solana,bitcoin,ethereum&order=market_cap_desc&per_page=3&page=1', { headers, signal: AbortSignal.timeout(10000) }).then(r => r.json()),
        fetch('https://api.coingecko.com/api/v3/global', { headers, signal: AbortSignal.timeout(10000) }).then(r => r.json()),
      ]);

      console.log('[DRY-RUN] Dados que seriam gravados:');
      console.log('--- MarketSnapshot (3 ativos) ---');
      const runCollectedAt = new Date();
      for (const m of markets) {
        console.log({
          asset: m.id,
          priceUsd: m.current_price,
          change24hPct: m.price_change_percentage_24h,
          volume24hUsd: m.total_volume,
          marketCapUsd: m.market_cap,
          sourceTs: m.last_updated,
          collectedAt: new Date().toISOString(),
        });
      }
      console.log('--- MetricSnapshot (global) ---');
      const sourceTs = new Date(global.data.updated_at * 1000);
      console.log({
        scope: 'global',
        metric: 'btc_dominance_pct',
        value: global.data.market_cap_percentage.btc,
        unit: 'PERCENT',
        sourceTs: sourceTs.toISOString(),
        collectedAt: new Date().toISOString(),
      });
      console.log({
        scope: 'global',
        metric: 'global_market_cap_usd',
        value: global.data.total_market_cap.usd,
        unit: 'USD',
        sourceTs: sourceTs.toISOString(),
        collectedAt: new Date().toISOString(),
      });
      console.log('[DRY-RUN] DailyClose seria calculado para últimos 7 dias (janela 60min antes de 00:00 UTC)');
      console.log('[DRY-RUN] OK - simulação concluída sem escrita no banco');
    } catch (e) {
      console.error('[DRY-RUN] ERRO:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
    return;
  }

  checkEnvironment();

  const { prisma } = await import('./db');

  let exitCode = 0;
  try {
    const result = await run(prisma);
    if (!result.marketsOk || !result.globalOk || !result.dailyCloseOk) process.exitCode = 1;
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();