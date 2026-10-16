#!/usr/bin/env node
import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment, DEFILLAMA_TVL_ENDPOINT, DEFILLAMA_STABLECOIN_ENDPOINT, DEFILLAMA_DEX_ENDPOINT, DEFILLAMA_FEES_ENDPOINT } from './config';
import { fetchChainTvl, fetchStablecoinSupply, fetchDexVolume24h, fetchDexProtocolsVolume24h, fetchFeesProtocols24h } from './sources/defillama';

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

async function run(prisma: PrismaClient): Promise<{ tvlOk: boolean; stablecoinOk: boolean; dexOk: boolean; dexProtocolsOk: boolean; feesProtocolsOk: boolean }> {
  const runCollectedAt = new Date();
  const source = await prisma.dataSource.upsert({
    where: { provider: 'defillama' },
    update: {},
    create: { provider: 'defillama', displayName: 'DefiLlama', baseUrl: 'https://api.llama.fi' },
    select: { id: true },
  });

  const tvlResult = await logEndpoint(prisma, source.id, 'fetch_tvl', DEFILLAMA_TVL_ENDPOINT, async () => {
    const data = await fetchChainTvl();
    if (!Number.isFinite(data.tvl) || data.tvl <= 0) throw new Error(`tvl inválido: ${data.tvl}`);
    await prisma.metricSnapshot.createMany({
      data: [{
        sourceId: source.id,
        scope: 'solana',
        metric: 'tvl_usd',
        value: new Decimal(String(data.tvl)),
        unit: 'USD',
        sourceTs: new Date(data.date * 1000),
        collectedAt: runCollectedAt,
      }],
      skipDuplicates: true,
    });
    return { records: 1 };
  });
  if (!tvlResult.ok) console.error('[fetch_tvl] falhou');

  const stablecoinResult = await logEndpoint(prisma, source.id, 'fetch_stablecoin', DEFILLAMA_STABLECOIN_ENDPOINT, async () => {
    const data = await fetchStablecoinSupply();
    if (!Number.isFinite(data.supply) || data.supply <= 0) throw new Error(`stablecoin supply inválido: ${data.supply}`);
    await prisma.metricSnapshot.createMany({
      data: [{
        sourceId: source.id,
        scope: 'solana',
        metric: 'stablecoin_supply_usd',
        value: new Decimal(String(data.supply)),
        unit: 'USD',
        sourceTs: new Date(data.date * 1000),
        collectedAt: runCollectedAt,
      }],
      skipDuplicates: true,
    });
    return { records: 1 };
  });
  if (!stablecoinResult.ok) console.error('[fetch_stablecoin] falhou');

  const dexResult = await logEndpoint(prisma, source.id, 'fetch_dex_volume', DEFILLAMA_DEX_ENDPOINT, async () => {
    const volume = await fetchDexVolume24h();
    if (!Number.isFinite(volume) || volume <= 0) throw new Error(`dex volume inválido: ${volume}`);
    await prisma.metricSnapshot.createMany({
      data: [{
        sourceId: source.id,
        scope: 'solana',
        metric: 'dex_volume_24h_usd',
        value: new Decimal(String(volume)),
        unit: 'USD',
        collectedAt: runCollectedAt,
      }],
      skipDuplicates: true,
    });
    return { records: 1 };
  });
  if (!dexResult.ok) console.error('[fetch_dex_volume] falhou');

  const dexProtocolsResult = await logEndpoint(prisma, source.id, 'fetch_protocols_dex', DEFILLAMA_DEX_ENDPOINT, async () => {
    const protocols = await fetchDexProtocolsVolume24h();
    if (protocols.length === 0) throw new Error('Nenhum protocolo DEX com dados válidos');
    const records = protocols.map(p => ({
      sourceId: source.id,
      scope: `solana:protocol:${p.slug}`,
      metric: 'dex_volume_24h_usd',
      value: new Decimal(String(p.total24h)),
      unit: 'USD',
      collectedAt: runCollectedAt,
    }));
    await prisma.metricSnapshot.createMany({ data: records, skipDuplicates: true });
    return { records: records.length };
  });
  if (!dexProtocolsResult.ok) console.error('[fetch_protocols_dex] falhou');

  const feesProtocolsResult = await logEndpoint(prisma, source.id, 'fetch_protocols_fees', DEFILLAMA_FEES_ENDPOINT, async () => {
    const protocols = await fetchFeesProtocols24h();
    if (protocols.length === 0) throw new Error('Nenhum protocolo Fees com dados válidos');
    const records = protocols.map(p => ({
      sourceId: source.id,
      scope: `solana:protocol:${p.slug}`,
      metric: 'fees_24h_usd',
      value: new Decimal(String(p.total24h)),
      unit: 'USD',
      collectedAt: runCollectedAt,
    }));
    await prisma.metricSnapshot.createMany({ data: records, skipDuplicates: true });
    return { records: records.length };
  });
  if (!feesProtocolsResult.ok) console.error('[fetch_protocols_fees] falhou');

  return { tvlOk: tvlResult.ok, stablecoinOk: stablecoinResult.ok, dexOk: dexResult.ok, dexProtocolsOk: dexProtocolsResult.ok, feesProtocolsOk: feesProtocolsResult.ok };
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log('[DRY-RUN] Modo simulação - sem escrita no banco');
    try {
      const [tvl, stablecoin, dex] = await Promise.allSettled([
        fetchChainTvl(),
        fetchStablecoinSupply(),
        fetchDexVolume24h(),
      ]);
      console.log('[DRY-RUN] Dados que seriam gravados:');
      console.log('--- MetricSnapshot (tvl_usd) ---');
      if (tvl.status === 'fulfilled') {
        console.log({ scope: 'solana', metric: 'tvl_usd', value: tvl.value.tvl, unit: 'USD', sourceTs: new Date(tvl.value.date * 1000).toISOString(), collectedAt: new Date().toISOString() });
      } else {
        console.log('ERRO:', tvl.reason instanceof Error ? tvl.reason.message : String(tvl.reason));
      }
      console.log('--- MetricSnapshot (stablecoin_supply_usd) ---');
      if (stablecoin.status === 'fulfilled') {
        console.log({ scope: 'solana', metric: 'stablecoin_supply_usd', value: stablecoin.value.supply, unit: 'USD', sourceTs: new Date(stablecoin.value.date * 1000).toISOString(), collectedAt: new Date().toISOString() });
      } else {
        console.log('ERRO:', stablecoin.reason instanceof Error ? stablecoin.reason.message : String(stablecoin.reason));
      }
      console.log('--- MetricSnapshot (dex_volume_24h_usd) ---');
      if (dex.status === 'fulfilled') {
        console.log({ scope: 'solana', metric: 'dex_volume_24h_usd', value: dex.value, unit: 'USD', collectedAt: new Date().toISOString() });
      } else {
        console.log('ERRO:', dex.reason instanceof Error ? dex.reason.message : String(dex.reason));
      }
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
    if (!result.tvlOk && !result.stablecoinOk && !result.dexOk && !result.dexProtocolsOk && !result.feesProtocolsOk) process.exitCode = 1;
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();