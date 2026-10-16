#!/usr/bin/env node
import { PrismaClient } from './generated/db/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { buildQualityRows } from './report-quality';
import { MetricStatus } from './quality';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/(localhost|127\.0\.0\.1):5433/.test(url)) {
  console.error('[ABORT] TEST_DATABASE_URL ausente ou não aponta para localhost:5433');
  process.exit(1);
}
const parsed = new URL(url);
console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (!ok) failures++;
  else passed++;
}

async function main() {
  try {
    const now = new Date();

    // 1) Obter status inicial do tvl_usd (defillama, scope solana)
    const rows1 = await buildQualityRows(prisma, now);
    const tvlRow1 = rows1.find(r => r.source === 'defillama' && r.scope === 'solana' && r.metric === 'tvl_usd');
    if (!tvlRow1) {
      console.error('[ERRO] Linha defillama tvl_usd scope solana não encontrada');
      process.exit(1);
    }
    console.log(`Status inicial tvl_usd: ${tvlRow1.status}, logsUsed: ${tvlRow1.logsUsed}`);
    check('1) Status inicial tvl_usd não é failed', tvlRow1.status !== 'failed');

    // 2) Inserir 3 erros no CollectionLog para fetch_tvl
    const defillamaSource = await prisma.dataSource.findFirst({ where: { provider: 'defillama' }, select: { id: true } });
    if (!defillamaSource) {
      console.error('[ERRO] DataSource defillama não encontrado');
      process.exit(1);
    }

    await prisma.collectionLog.createMany({
      data: [
        { sourceId: defillamaSource.id, operation: 'fetch_tvl', endpoint: '/v2/historicalChainTvl/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 5 * 60000) },
        { sourceId: defillamaSource.id, operation: 'fetch_tvl', endpoint: '/v2/historicalChainTvl/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 10 * 60000) },
        { sourceId: defillamaSource.id, operation: 'fetch_tvl', endpoint: '/v2/historicalChainTvl/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 15 * 60000) },
      ],
    });
    console.log('Inseridos 3 erros de teste no CollectionLog');

    // 3) Chamar buildQualityRows novamente
    const rows2 = await buildQualityRows(prisma, now);
    const tvlRow2 = rows2.find(r => r.source === 'defillama' && r.scope === 'solana' && r.metric === 'tvl_usd');
    if (!tvlRow2) {
      console.error('[ERRO] Linha defillama tvl_usd scope solana não encontrada após inserção');
      process.exit(1);
    }
    console.log(`Status após erros tvl_usd: ${tvlRow2.status}, logsUsed: ${tvlRow2.logsUsed}`);
    check('2) Status tvl_usd agora é failed', tvlRow2.status === 'failed');
    check('3) logsUsed > 0 para linhas defillama', rows2.filter(r => r.source === 'defillama').every(r => r.logsUsed > 0));
    check('4) logsUsed > 0 para linhas coingecko', rows2.filter(r => r.source === 'coingecko').every(r => r.logsUsed > 0));

    // 4) Verificar que o resumo da fonte defillama NÃO é fresh
    const sourceSummary = new Map<string, MetricStatus[]>();
    for (const r of rows2) {
      if (!sourceSummary.has(r.source)) sourceSummary.set(r.source, []);
      sourceSummary.get(r.source)!.push(r.status);
    }
    const defillamaSummary = sourceSummary.get('defillama');
    if (!defillamaSummary) {
      console.error('[ERRO] Resumo defillama não encontrado');
      process.exit(1);
    }
    console.log(`Resumo defillama: ${defillamaSummary.join(', ')}`);
    check('5) Resumo defillama NÃO é fresh', defillamaSummary.includes('failed') || defillamaSummary.includes('stale') || defillamaSummary.includes('unverified'));

  // 6) Inserir 3 erros na operação fetch_protocols_dex
    await prisma.collectionLog.deleteMany({ where: { errorMessage: 'TEST_QUALITY_TMP' } });
    await prisma.collectionLog.createMany({
      data: [
        { sourceId: defillamaSource.id, operation: 'fetch_protocols_dex', endpoint: '/overview/dexs/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 5 * 60000) },
        { sourceId: defillamaSource.id, operation: 'fetch_protocols_dex', endpoint: '/overview/dexs/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 10 * 60000) },
        { sourceId: defillamaSource.id, operation: 'fetch_protocols_dex', endpoint: '/overview/dexs/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 15 * 60000) },
      ],
    });
    console.log('Inseridos 3 erros na operação fetch_protocols_dex');

    const rows3 = await buildQualityRows(prisma, now);
    const protocolDexRow = rows3.find(r => r.source === 'defillama' && r.scope === 'solana:protocol:pumpswap' && r.metric === 'dex_volume_24h_usd');
    const chainDexRow = rows3.find(r => r.source === 'defillama' && r.scope === 'solana' && r.metric === 'dex_volume_24h_usd');
    const protocolFeesRow = rows3.find(r => r.source === 'defillama' && r.scope === 'solana:protocol:pumpswap' && r.metric === 'fees_24h_usd');
    check('6a) solana:protocol:pumpswap/dex_volume_24h_usd é failed (fetch_protocols_dex)', protocolDexRow?.status === 'failed');
    check('6b) solana/dex_volume_24h_usd NÃO é failed (fetch_dex_volume)', chainDexRow?.status !== 'failed');
    check('6c) solana:protocol:pumpswap/fees_24h_usd NÃO é failed', protocolFeesRow?.status !== 'failed');

    // 7) Inserir 3 erros na operação fetch_dex_volume
    await prisma.collectionLog.deleteMany({ where: { errorMessage: 'TEST_QUALITY_TMP' } });
    await prisma.collectionLog.createMany({
      data: [
        { sourceId: defillamaSource.id, operation: 'fetch_dex_volume', endpoint: '/overview/dexs/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 5 * 60000) },
        { sourceId: defillamaSource.id, operation: 'fetch_dex_volume', endpoint: '/overview/dexs/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 10 * 60000) },
        { sourceId: defillamaSource.id, operation: 'fetch_dex_volume', endpoint: '/overview/dexs/Solana', status: 'error', latencyMs: 100, errorMessage: 'TEST_QUALITY_TMP', collectedAt: new Date(now.getTime() - 15 * 60000) },
      ],
    });
    console.log('Inseridos 3 erros na operação fetch_dex_volume');

    const rows4 = await buildQualityRows(prisma, now);
    const chainDexRow2 = rows4.find(r => r.source === 'defillama' && r.scope === 'solana' && r.metric === 'dex_volume_24h_usd');
    const protocolDexRow2 = rows4.find(r => r.source === 'defillama' && r.scope === 'solana:protocol:pumpswap' && r.metric === 'dex_volume_24h_usd');
    const protocolFeesRow2 = rows4.find(r => r.source === 'defillama' && r.scope === 'solana:protocol:pumpswap' && r.metric === 'fees_24h_usd');
    check('7a) solana/dex_volume_24h_usd é failed (fetch_dex_volume)', chainDexRow2?.status === 'failed');
    check('7b) solana:protocol:pumpswap/dex_volume_24h_usd NÃO é failed (fetch_protocols_dex)', protocolDexRow2?.status !== 'failed');
    check('7c) solana:protocol:pumpswap/fees_24h_usd NÃO é failed', protocolFeesRow2?.status !== 'failed');

    // 8) Verificar que fees_24h_usd do protocolo NÃO é failed em nenhum cenário
    check('8a) fees_24h_usd do protocolo não afetado por fetch_protocols_dex', protocolFeesRow?.status !== 'failed');
    check('8b) fees_24h_usd do protocolo não afetado por fetch_dex_volume', protocolFeesRow2?.status !== 'failed');

  } finally {
    const deleted = await prisma.collectionLog.deleteMany({
      where: { errorMessage: 'TEST_QUALITY_TMP' },
    });
    console.log(`[CLEANUP] Apagados ${deleted.count} registros de teste do CollectionLog`);
    await prisma.$disconnect();
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});