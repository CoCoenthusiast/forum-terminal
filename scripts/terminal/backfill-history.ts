#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { checkEnvironment, BACKFILL_CG_DAYS, DAILY_CLOSE_BACKFILL_CG_DAYS, BACKFILL_CG_ASSETS, BACKFILL_CG_PAUSE_MS, BACKFILL_DEX_METRIC_NAME, BACKFILL_DEX_PROTOCOL_ALL_SLUGS, BACKFILL_DEX_PROTOCOL_PAUSE_MS, BACKFILL_FEES_METRIC_NAME, BACKFILL_FEES_PROTOCOL_SLUGS, BACKFILL_FEES_PROTOCOL_PAUSE_MS, DEFILLAMA_DEX_PROTOCOL_SUMMARY_PREFIX, DEFILLAMA_FEES_PROTOCOL_SUMMARY_PREFIX, buildProtocolScope, type BackfillSeriesResult, type BackfillPricePoint, type BackfillMetricPoint } from './config';
import { fetchCoinGeckoHistory, filterAndValidatePricePoints } from './sources/coingecko-history';
import { fetchDefiLlamaTvl, filterAndValidateTvlPoints, fetchDefiLlamaStablecoins, filterAndValidateStablecoinPoints, fetchDefiLlamaDexVolume, fetchDefiLlamaDexProtocolVolume, filterAndValidateDexVolumePoints, fetchDefiLlamaFeesProtocolDaily, filterAndValidateFeesPoints, analyzeProtocolDateGaps } from './sources/defillama-history';
import { upgradeDailyCloses } from './persist';

async function logEndpoint(
  prisma: PrismaClient,
  sourceId: string,
  operation: string,
  endpoint: string,
  fn: () => Promise<{ records: number }>
): Promise<{ ok: boolean; error?: string; records: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    await prisma.collectionLog.create({
      data: { sourceId, operation, endpoint, status: 'success', latencyMs: Date.now() - start, recordsFetched: result.records }
    });
    return { ok: true, records: result.records };
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
    return { ok: false, error: truncated, records: 0 };
  }
}

async function upsertDataSource(prisma: PrismaClient, provider: string, displayName: string, baseUrl: string): Promise<string> {
  const ds = await prisma.dataSource.upsert({
    where: { provider },
    update: {},
    create: { provider, displayName, baseUrl },
    select: { id: true },
  });
  return ds.id;
}

async function runPriceBackfill(prisma: PrismaClient, cgSourceId: string, asset: string, todayStartMs: number, days: number = BACKFILL_CG_DAYS, includeTodayMidnight: boolean = false): Promise<BackfillSeriesResult> {
  const operation = `backfill_price_${asset}`;
  const endpoint = `/coins/${asset}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  let received = 0, ignored = 0, invalid = 0, inserted = 0;
  let firstDate: string | null = null, lastDate: string | null = null;
  const ignoredReasons: Record<string, number> = {};
  let result: { ok: boolean; error?: string; records: number } = { ok: false, error: '', records: 0 };

  const data = await fetchCoinGeckoHistory(asset, days);
  received = data.prices.length;

  const filtered = filterAndValidatePricePoints(data.prices, data.market_caps, data.total_volumes, asset, todayStartMs, includeTodayMidnight);
  ignored = filtered.ignored;
  invalid = filtered.invalid;
  Object.entries(filtered.ignoredReasons).forEach(([k, v]) => { ignoredReasons[k] = (ignoredReasons[k] || 0) + v; });

  if (filtered.valid.length > 0) {
    const valid = filtered.valid;
    firstDate = valid[0].collectedAt.toISOString().slice(0, 10);
    lastDate = valid[valid.length - 1].collectedAt.toISOString().slice(0, 10);

    result = await logEndpoint(prisma, cgSourceId, operation, endpoint, async () => {
      let totalInserted = 0;
      for (let i = 0; i < valid.length; i += 500) {
        const batch = valid.slice(i, i + 500);
        const res = await prisma.marketSnapshot.createMany({
          data: batch.map(p => ({
            sourceId: cgSourceId,
            asset: p.asset,
            priceUsd: new Decimal(String(p.priceUsd)),
            change24hPct: null,
            volume24hUsd: p.volume24hUsd !== null ? new Decimal(String(p.volume24hUsd)) : null,
            marketCapUsd: p.marketCapUsd !== null ? new Decimal(String(p.marketCapUsd)) : null,
            sourceTs: p.sourceTs,
            collectedAt: p.collectedAt,
          })),
          skipDuplicates: true,
        });
        totalInserted += res.count;
      }
      return { records: totalInserted };
    });
    inserted = result.records;
  }

  if (!result.ok) console.error(`[${operation}] falhou: ${result.error}`);

  return { name: operation, received, ignored, invalid, inserted, firstDate, lastDate, ignoredReasons };
}

async function runMetricBackfill(
  prisma: PrismaClient,
  llamaSourceId: string,
  metric: string,
  fetchFn: () => Promise<any>,
  filterFn: (data: any, todayStartMs: number) => { valid: BackfillMetricPoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> },
  todayStartMs: number,
  options?: { scope?: string; endpoint?: string; operation?: string }
): Promise<BackfillSeriesResult> {
  const operation = options?.operation ?? `backfill_${metric}`;
  const endpoint = options?.endpoint ?? (metric === 'tvl_usd' ? '/v2/historicalChainTvl/Solana'
    : metric === 'stablecoin_supply_usd' ? '/stablecoincharts/Solana'
    : '/overview/dexs/Solana');
  const scope = options?.scope ?? 'solana';
  let received = 0, ignored = 0, invalid = 0, inserted = 0;
  let firstDate: string | null = null, lastDate: string | null = null;
  const ignoredReasons: Record<string, number> = {};
  let result: { ok: boolean; error?: string; records: number } = { ok: false, error: '', records: 0 };

  const rawData = await fetchFn();
  received = Array.isArray(rawData) ? rawData.length : 0;

  const filtered = filterFn(rawData, todayStartMs);
  ignored = filtered.ignored;
  invalid = filtered.invalid;
  Object.entries(filtered.ignoredReasons).forEach(([k, v]) => { ignoredReasons[k] = (ignoredReasons[k] || 0) + v; });

  if (filtered.valid.length > 0) {
    const valid = filtered.valid;
    firstDate = valid[0].collectedAt.toISOString().slice(0, 10);
    lastDate = valid[valid.length - 1].collectedAt.toISOString().slice(0, 10);

    result = await logEndpoint(prisma, llamaSourceId, operation, endpoint, async () => {
      let totalInserted = 0;
      for (let i = 0; i < valid.length; i += 500) {
        const batch = valid.slice(i, i + 500);
        const res = await prisma.metricSnapshot.createMany({
          data: batch.map(p => ({
            sourceId: llamaSourceId,
            scope,
            metric: p.metric,
            value: new Decimal(String(p.value)),
            unit: 'USD',
            sourceTs: p.sourceTs,
            collectedAt: p.collectedAt,
          })),
          skipDuplicates: true,
        });
        totalInserted += res.count;
      }
      return { records: totalInserted };
    });
    inserted = result.records;
  }

  if (!result.ok) console.error(`[${operation}] falhou: ${result.error}`);

  return { name: operation, received, ignored, invalid, inserted, firstDate, lastDate, ignoredReasons };
}

export type OnlyProvider = 'coingecko' | 'defillama';

export function parseOnlyFlag(argv: readonly string[]): { only: OnlyProvider | null; error: string | null } {
  const arg = argv.find((a) => a.startsWith('--only='));
  if (arg === undefined) return { only: null, error: null };
  const value = arg.slice('--only='.length);
  if (value === 'coingecko' || value === 'defillama') return { only: value, error: null };
  return { only: null, error: `valor de --only não suportado: "${arg}"` };
}

async function runUpgradeCloses(): Promise<void> {
  const lookbackArg = process.argv.find((a) => a.startsWith('--lookback='));
  let lookback = 30;
  if (lookbackArg !== undefined) {
    const raw = lookbackArg.slice('--lookback='.length);
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`[ABORT] --lookback inválido: "${lookbackArg}"`);
      process.exit(1);
    }
    lookback = parsed;
  }

  checkEnvironment();

  const { prisma } = await import('./db');

  try {
    const result = await upgradeDailyCloses(prisma, new Date(), lookback);
    console.log(`[UPGRADE] lookback=${lookback}, corrigidos=${result.corrected}, já atuais=${result.alreadyCurrent}, sem candidato=${result.noCandidate}, bloqueados=${result.blocked}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  if (process.argv.includes('--upgrade-closes')) {
    await runUpgradeCloses();
    return;
  }

  const isDryRun = process.argv.includes('--dry-run');

  const daysArgIndex = process.argv.findIndex((a) => a === '--days' || a.startsWith('--days='));
  let daysOverride: number | null = null;
  if (daysArgIndex !== -1) {
    const arg = process.argv[daysArgIndex];
    const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
    const parsed = raw === '' ? DAILY_CLOSE_BACKFILL_CG_DAYS : Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`[ABORT] --days inválido: "${arg}"`);
      process.exit(1);
    }
    daysOverride = parsed;
  }

  const onlyResult = parseOnlyFlag(process.argv);
  if (onlyResult.error !== null) {
    console.error(`[ABORT] ${onlyResult.error}`);
    process.exit(1);
  }
  const only = onlyResult.only;
  const onlyCoingecko = only === 'coingecko';
  const onlyDefillama = only === 'defillama';

  const effectiveDays = daysOverride ?? BACKFILL_CG_DAYS;
  const includeTodayMidnight = daysOverride !== null;

  const now = new Date();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  if (isDryRun) {
    console.log('[DRY-RUN] Modo simulação - sem escrita no banco');
    try {
      if (!onlyDefillama) {
        console.log(`Buscando dados CoinGecko (dias=${effectiveDays}, includeTodayMidnight=${includeTodayMidnight})...`);
        for (const asset of BACKFILL_CG_ASSETS) {
          const data = await fetchCoinGeckoHistory(asset, effectiveDays);
          console.log(`${asset}: ${data.prices.length} pontos brutos`);
          const filtered = filterAndValidatePricePoints(data.prices, data.market_caps, data.total_volumes, asset, todayStartMs, includeTodayMidnight);
          console.log(`  válidos: ${filtered.valid.length}, ignorados: ${filtered.ignored} (${JSON.stringify(filtered.ignoredReasons)}), inválidos: ${filtered.invalid}`);
          if (filtered.valid.length > 0) {
            console.log(`  primeira data: ${filtered.valid[0].collectedAt.toISOString().slice(0, 10)}, última: ${filtered.valid[filtered.valid.length - 1].collectedAt.toISOString().slice(0, 10)}`);
          }
          if (asset !== BACKFILL_CG_ASSETS[BACKFILL_CG_ASSETS.length - 1]) {
            await new Promise(r => setTimeout(r, BACKFILL_CG_PAUSE_MS));
          }
        }
      }

      if (!onlyCoingecko) {
        console.log('Buscando dados DefiLlama...');
        const tvlData = await fetchDefiLlamaTvl();
        console.log(`tvl_usd: ${tvlData.length} pontos brutos`);
        const tvlFiltered = filterAndValidateTvlPoints(tvlData, todayStartMs);
        console.log(`  válidos: ${tvlFiltered.valid.length}, ignorados: ${tvlFiltered.ignored} (${JSON.stringify(tvlFiltered.ignoredReasons)}), inválidos: ${tvlFiltered.invalid}`);

        const stableData = await fetchDefiLlamaStablecoins();
        console.log(`stablecoin_supply_usd: ${stableData.length} pontos brutos`);
        const stableFiltered = filterAndValidateStablecoinPoints(stableData, todayStartMs);
        console.log(`  válidos: ${stableFiltered.valid.length}, ignorados: ${stableFiltered.ignored} (${JSON.stringify(stableFiltered.ignoredReasons)}), inválidos: ${stableFiltered.invalid}`);

        const dexData = await fetchDefiLlamaDexVolume();
        console.log(`dex_volume_daily_usd: ${dexData.length} pontos brutos`);
        const dexFiltered = filterAndValidateDexVolumePoints(dexData, todayStartMs);
        console.log(`  válidos: ${dexFiltered.valid.length}, ignorados: ${dexFiltered.ignored} (${JSON.stringify(dexFiltered.ignoredReasons)}), inválidos: ${dexFiltered.invalid}`);

        for (let i = 0; i < BACKFILL_DEX_PROTOCOL_ALL_SLUGS.length; i++) {
          const slug = BACKFILL_DEX_PROTOCOL_ALL_SLUGS[i];
          const protocolData = await fetchDefiLlamaDexProtocolVolume(slug);
          console.log(`dex_volume_daily_usd ${slug}: ${protocolData.length} pontos brutos`);
          const gaps = analyzeProtocolDateGaps(protocolData, todayStartMs);
          const shown = gaps.missingDates.length;
          const extra = gaps.missingDays > shown ? ` (+${gaps.missingDays - shown} não listados)` : '';
          console.log(`  buracos: esperados=${gaps.expectedDays}, presentes=${gaps.presentDays}, ausentes=${gaps.missingDays}, ate_D-3=${gaps.missingClosed}, recentes=${gaps.missingRecent}, fora_da_meia_noite=${gaps.offMidnight}`);
          console.log(`  datas ausentes: [${gaps.missingDates.join(', ')}]${extra}`);
          const protocolFiltered = filterAndValidateDexVolumePoints(protocolData, todayStartMs);
          console.log(`  válidos: ${protocolFiltered.valid.length}, ignorados: ${protocolFiltered.ignored} (${JSON.stringify(protocolFiltered.ignoredReasons)}), inválidos: ${protocolFiltered.invalid}`);
          if (protocolFiltered.valid.length > 0) {
            console.log(`  primeira data: ${protocolFiltered.valid[0].collectedAt.toISOString().slice(0, 10)}, última: ${protocolFiltered.valid[protocolFiltered.valid.length - 1].collectedAt.toISOString().slice(0, 10)}`);
          }
          if (i < BACKFILL_DEX_PROTOCOL_ALL_SLUGS.length - 1) {
            await new Promise(r => setTimeout(r, BACKFILL_DEX_PROTOCOL_PAUSE_MS));
          }
        }

        for (let i = 0; i < BACKFILL_FEES_PROTOCOL_SLUGS.length; i++) {
          const slug = BACKFILL_FEES_PROTOCOL_SLUGS[i];
          const feesData = await fetchDefiLlamaFeesProtocolDaily(slug);
          console.log(`fees_daily_usd ${slug}: ${feesData.length} pontos brutos`);
          const feesFiltered = filterAndValidateFeesPoints(feesData, todayStartMs);
          console.log(`  válidos: ${feesFiltered.valid.length}, ignorados: ${feesFiltered.ignored} (${JSON.stringify(feesFiltered.ignoredReasons)}), inválidos: ${feesFiltered.invalid}`);
          if (feesFiltered.valid.length > 0) {
            console.log(`  primeira data: ${feesFiltered.valid[0].collectedAt.toISOString().slice(0, 10)}, última: ${feesFiltered.valid[feesFiltered.valid.length - 1].collectedAt.toISOString().slice(0, 10)}`);
          }
          if (i < BACKFILL_FEES_PROTOCOL_SLUGS.length - 1) {
            await new Promise(r => setTimeout(r, BACKFILL_FEES_PROTOCOL_PAUSE_MS));
          }
        }
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

  let allFailed = true;
  const results: BackfillSeriesResult[] = [];

  try {
    const cgSourceId = onlyDefillama ? null : await upsertDataSource(prisma, 'coingecko_history', 'CoinGecko (histórico)', 'https://api.coingecko.com/api/v3');
    const llamaSourceId = onlyCoingecko ? null : await upsertDataSource(prisma, 'defillama_history', 'DefiLlama (histórico)', 'https://api.llama.fi');

    if (cgSourceId) {
      for (const asset of BACKFILL_CG_ASSETS) {
        try {
          console.log(`Executando backfill de preço para ${asset} (dias=${effectiveDays})...`);
          const res = await runPriceBackfill(prisma, cgSourceId, asset, todayStartMs, effectiveDays, includeTodayMidnight);
          results.push(res);
          if (res.inserted > 0 || res.ignored > 0 || res.invalid > 0) allFailed = false;
          console.log(`  ${res.name}: recebidos=${res.received}, ignorados=${res.ignored}, inválidos=${res.invalid}, inseridos=${res.inserted}, primeiro=${res.firstDate}, último=${res.lastDate}`);
        } catch (e) {
          console.error(`  ${asset} falhou:`, e instanceof Error ? e.message : String(e).slice(0, 300));
        }
        if (asset !== BACKFILL_CG_ASSETS[BACKFILL_CG_ASSETS.length - 1]) {
          await new Promise(r => setTimeout(r, BACKFILL_CG_PAUSE_MS));
        }
      }
    }

    if (llamaSourceId) {
      try {
        console.log('Executando backfill de TVL...');
        const tvlRes = await runMetricBackfill(prisma, llamaSourceId, 'tvl_usd', fetchDefiLlamaTvl, filterAndValidateTvlPoints, todayStartMs);
        results.push(tvlRes);
        if (tvlRes.inserted > 0 || tvlRes.ignored > 0 || tvlRes.invalid > 0) allFailed = false;
        console.log(`  ${tvlRes.name}: recebidos=${tvlRes.received}, ignorados=${tvlRes.ignored}, inválidos=${tvlRes.invalid}, inseridos=${tvlRes.inserted}, primeiro=${tvlRes.firstDate}, último=${tvlRes.lastDate}`);
      } catch (e) {
        console.error('  tvl_usd falhou:', e instanceof Error ? e.message : String(e).slice(0, 300));
      }

      try {
        console.log('Executando backfill de Stablecoin Supply...');
        const stableRes = await runMetricBackfill(prisma, llamaSourceId, 'stablecoin_supply_usd', fetchDefiLlamaStablecoins, filterAndValidateStablecoinPoints, todayStartMs);
        results.push(stableRes);
        if (stableRes.inserted > 0 || stableRes.ignored > 0 || stableRes.invalid > 0) allFailed = false;
        console.log(`  ${stableRes.name}: recebidos=${stableRes.received}, ignorados=${stableRes.ignored}, inválidos=${stableRes.invalid}, inseridos=${stableRes.inserted}, primeiro=${stableRes.firstDate}, último=${stableRes.lastDate}`);
      } catch (e) {
        console.error('  stablecoin_supply_usd falhou:', e instanceof Error ? e.message : String(e).slice(0, 300));
      }

      try {
        console.log('Executando backfill de DEX Volume...');
        const dexRes = await runMetricBackfill(prisma, llamaSourceId, 'dex_volume_daily_usd', fetchDefiLlamaDexVolume, filterAndValidateDexVolumePoints, todayStartMs);
        results.push(dexRes);
        if (dexRes.inserted > 0 || dexRes.ignored > 0 || dexRes.invalid > 0) allFailed = false;
        console.log(`  ${dexRes.name}: recebidos=${dexRes.received}, ignorados=${dexRes.ignored}, inválidos=${dexRes.invalid}, inseridos=${dexRes.inserted}, primeiro=${dexRes.firstDate}, último=${dexRes.lastDate}`);
      } catch (e) {
        console.error('  dex_volume_daily_usd falhou:', e instanceof Error ? e.message : String(e).slice(0, 300));
      }

      for (let i = 0; i < BACKFILL_DEX_PROTOCOL_ALL_SLUGS.length; i++) {
        const slug = BACKFILL_DEX_PROTOCOL_ALL_SLUGS[i];
        try {
          console.log(`Executando backfill de DEX Volume (${slug})...`);
          const protocolRes = await runMetricBackfill(
            prisma,
            llamaSourceId,
            BACKFILL_DEX_METRIC_NAME,
            () => fetchDefiLlamaDexProtocolVolume(slug),
            filterAndValidateDexVolumePoints,
            todayStartMs,
            {
              scope: buildProtocolScope(slug),
              endpoint: `${DEFILLAMA_DEX_PROTOCOL_SUMMARY_PREFIX}${slug}`,
              operation: `backfill_${BACKFILL_DEX_METRIC_NAME}_${slug}`,
            }
          );
          results.push(protocolRes);
          if (protocolRes.inserted > 0 || protocolRes.ignored > 0 || protocolRes.invalid > 0) allFailed = false;
          console.log(`  ${protocolRes.name}: recebidos=${protocolRes.received}, ignorados=${protocolRes.ignored}, inválidos=${protocolRes.invalid}, inseridos=${protocolRes.inserted}, primeiro=${protocolRes.firstDate}, último=${protocolRes.lastDate}`);
        } catch (e) {
          console.error(`  dex_volume_daily_usd (${slug}) falhou:`, e instanceof Error ? e.message : String(e).slice(0, 300));
        }
        if (i < BACKFILL_DEX_PROTOCOL_ALL_SLUGS.length - 1) {
          await new Promise(r => setTimeout(r, BACKFILL_DEX_PROTOCOL_PAUSE_MS));
        }
      }

      for (let i = 0; i < BACKFILL_FEES_PROTOCOL_SLUGS.length; i++) {
        const slug = BACKFILL_FEES_PROTOCOL_SLUGS[i];
        try {
          console.log(`Executando backfill de Fees (${slug})...`);
          const feesRes = await runMetricBackfill(
            prisma,
            llamaSourceId,
            BACKFILL_FEES_METRIC_NAME,
            () => fetchDefiLlamaFeesProtocolDaily(slug),
            filterAndValidateFeesPoints,
            todayStartMs,
            {
              scope: buildProtocolScope(slug),
              endpoint: `${DEFILLAMA_FEES_PROTOCOL_SUMMARY_PREFIX}${slug}?dataType=dailyFees`,
              operation: `backfill_${BACKFILL_FEES_METRIC_NAME}_${slug}`,
            }
          );
          results.push(feesRes);
          if (feesRes.inserted > 0 || feesRes.ignored > 0 || feesRes.invalid > 0) allFailed = false;
          console.log(`  ${feesRes.name}: recebidos=${feesRes.received}, ignorados=${feesRes.ignored}, inválidos=${feesRes.invalid}, inseridos=${feesRes.inserted}, primeiro=${feesRes.firstDate}, último=${feesRes.lastDate}`);
        } catch (e) {
          console.error(`  fees_daily_usd (${slug}) falhou:`, e instanceof Error ? e.message : String(e).slice(0, 300));
        }
        if (i < BACKFILL_FEES_PROTOCOL_SLUGS.length - 1) {
          await new Promise(r => setTimeout(r, BACKFILL_FEES_PROTOCOL_PAUSE_MS));
        }
      }
    }

    console.log('\n=== RESUMO DO BACKFILL ===');
    for (const r of results) {
      console.log(`${r.name}: recebidos=${r.received}, ignorados=${r.ignored}, inválidos=${r.invalid}, inseridos=${r.inserted}, primeiro=${r.firstDate}, último=${r.lastDate}`);
      if (Object.keys(r.ignoredReasons).length > 0) {
        console.log(`  motivos ignorados: ${JSON.stringify(r.ignoredReasons)}`);
      }
    }

  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    const { prisma } = await import('./db');
    await prisma.$disconnect();
  }

  if (allFailed) {
    console.error('[ERRO] Todas as séries falharam');
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
