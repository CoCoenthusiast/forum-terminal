#!/usr/bin/env node
import {
  filterAndValidatePricePoints,
} from './sources/coingecko-history';
import {
  filterAndValidateTvlPoints,
  filterAndValidateStablecoinPoints,
  filterAndValidateDexVolumePoints,
  filterAndValidateFeesPoints,
  buildDefiLlamaFeesProtocolUrl,
} from './sources/defillama-history';
import {
  BACKFILL_DEX_METRIC_NAME,
  BACKFILL_DEX_PROTOCOL_SLUGS,
  BACKFILL_FEES_METRIC_NAME,
  BACKFILL_FEES_PROTOCOL_SLUGS,
  buildDexProtocolScope,
  buildProtocolScope,
} from './config';

const now = new Date('2026-10-11T12:00:00Z');
const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const yesterdayStartMs = todayStartMs - 86400000;

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (!ok) failures++; else passed++;
}

console.log('=== TESTES DE filterAndValidatePricePoints ===\n');

check('1) ponto exatamente à meia-noite e anterior a hoje -> aceito',
  (() => {
    const rawPoints: [number, number][] = [[yesterdayStartMs, 100]];
    const rawMarketCaps: [number, number][] = [[yesterdayStartMs, 1000000]];
    const rawVolumes: [number, number][] = [[yesterdayStartMs, 500000]];
    const r = filterAndValidatePricePoints(rawPoints, rawMarketCaps, rawVolumes, 'solana', todayStartMs);
    return r.valid.length === 1 && r.valid[0].priceUsd === 100 && r.ignored === 0 && r.invalid === 0;
  })());

check('2) ponto com horário no meio do dia -> ignorado',
  (() => {
    const rawPoints: [number, number][] = [[yesterdayStartMs + 3600000, 100]];
    const r = filterAndValidatePricePoints(rawPoints, [], [], 'solana', todayStartMs);
    return r.valid.length === 0 && r.ignored === 1 && r.ignoredReasons.not_midnight_utc === 1;
  })());

check('3) ponto de hoje 00:00 UTC -> ignorado',
  (() => {
    const rawPoints: [number, number][] = [[todayStartMs, 100]];
    const r = filterAndValidatePricePoints(rawPoints, [], [], 'solana', todayStartMs);
    return r.valid.length === 0 && r.ignored === 1 && r.ignoredReasons.not_closed_day === 1;
  })());

check('4) ponto de data futura -> ignorado',
  (() => {
    const futureMs = todayStartMs + 86400000;
    const rawPoints: [number, number][] = [[futureMs, 100]];
    const r = filterAndValidatePricePoints(rawPoints, [], [], 'solana', todayStartMs);
    return r.valid.length === 0 && r.ignored === 1 && r.ignoredReasons.not_closed_day === 1;
  })());

check('5) preço zero ou negativo ou NaN -> descartado',
  (() => {
    const rawPoints: [number, number][] = [[yesterdayStartMs, 0], [yesterdayStartMs - 86400000, -10], [yesterdayStartMs - 2*86400000, NaN]];
    const r = filterAndValidatePricePoints(rawPoints, [], [], 'solana', todayStartMs);
    return r.valid.length === 0 && r.invalid === 3 && r.ignored === 0;
  })());

check('6) market cap inválido com preço válido -> ponto aceito com market cap null',
  (() => {
    const rawPoints: [number, number][] = [[yesterdayStartMs, 100]];
    const rawMarketCaps: [number, number][] = [[yesterdayStartMs, -5]];
    const rawVolumes: [number, number][] = [[yesterdayStartMs, 500000]];
    const r = filterAndValidatePricePoints(rawPoints, rawMarketCaps, rawVolumes, 'solana', todayStartMs);
    return r.valid.length === 1 && r.valid[0].marketCapUsd === null && r.valid[0].volume24hUsd === 500000;
  })());

console.log('\n=== TESTES DE filterAndValidateStablecoinPoints ===\n');

check('7) stablecoin com date como texto -> convertido corretamente',
  (() => {
    const rawPoints = [{ date: String(Math.floor(yesterdayStartMs / 1000)), totalCirculatingUSD: { peggedUSD: 1000000 } }];
    const r = filterAndValidateStablecoinPoints(rawPoints, todayStartMs);
    return r.valid.length === 1 && r.valid[0].value === 1000000;
  })());

console.log('\n=== TESTES DE filterAndValidateDexVolumePoints ===\n');

check('8) volume DEX igual a 0 -> aceito',
  (() => {
    const threeDaysAgoMs = todayStartMs - 3 * 86400000;
    const rawPoints: [number, number][] = [[Math.floor(threeDaysAgoMs / 1000), 0]];
    const r = filterAndValidateDexVolumePoints(rawPoints, todayStartMs);
    return r.valid.length === 1 && r.valid[0].value === 0;
  })());

check('10) série DEX: ponto de hoje menos 2 dias -> ignorado por quarentena',
  (() => {
    const twoDaysAgoMs = todayStartMs - 2 * 86400000;
    const rawPoints: [number, number][] = [[Math.floor(twoDaysAgoMs / 1000), 1000]];
    const r = filterAndValidateDexVolumePoints(rawPoints, todayStartMs);
    return r.valid.length === 0 && r.ignored === 1 && r.ignoredReasons.quarantine_recent_days === 1;
  })());

check('11) série DEX: ponto de hoje menos 3 dias -> aceito',
  (() => {
    const threeDaysAgoMs = todayStartMs - 3 * 86400000;
    const rawPoints: [number, number][] = [[Math.floor(threeDaysAgoMs / 1000), 1000]];
    const r = filterAndValidateDexVolumePoints(rawPoints, todayStartMs);
    return r.valid.length === 1 && r.ignored === 0 && r.invalid === 0;
  })());

console.log('\n=== TESTES DE filterAndValidateTvlPoints ===\n');

check('9) TVL igual a 0 ou negativo -> descartado',
  (() => {
    const rawPoints = [{ date: Math.floor(yesterdayStartMs / 1000), tvl: 0 }, { date: Math.floor((yesterdayStartMs - 86400000) / 1000), tvl: -100 }];
    const r = filterAndValidateTvlPoints(rawPoints, todayStartMs);
    return r.valid.length === 0 && r.invalid === 2 && r.ignored === 0;
  })());

check('12) série de TVL: ponto de hoje menos 1 dia -> aceito (sem quarentena)',
  (() => {
    const rawPoints = [{ date: Math.floor(yesterdayStartMs / 1000), tvl: 1000000 }];
    const r = filterAndValidateTvlPoints(rawPoints, todayStartMs);
    return r.valid.length === 1 && r.ignored === 0 && r.invalid === 0;
  })());

console.log('\n=== TESTES DO BACKFILL DEX POR PROTOCOLO ===\n');

check('13) DEX protocolo: D-5, D-2, D-1, hoje e amanhã -> só D-5 válido',
  (() => {
    const dayMs = 86400000;
    const rawPoints: [number, number][] = [
      [Math.floor((todayStartMs - 5 * dayMs) / 1000), 500],
      [Math.floor((todayStartMs - 2 * dayMs) / 1000), 200],
      [Math.floor((todayStartMs - 1 * dayMs) / 1000), 100],
      [Math.floor(todayStartMs / 1000), 50],
      [Math.floor((todayStartMs + dayMs) / 1000), 10],
    ];
    const r = filterAndValidateDexVolumePoints(rawPoints, todayStartMs);
    return r.valid.length === 1
      && r.valid[0].value === 500
      && r.ignored === 4
      && r.ignoredReasons.not_closed_day === 2
      && r.ignoredReasons.quarantine_recent_days === 2
      && r.invalid === 0;
  })());

check('14) DEX protocolo: 0 válido; -1 e NaN inválidos',
  (() => {
    const dayMs = 86400000;
    const base = Math.floor((todayStartMs - 5 * dayMs) / 1000);
    const rawPoints: [number, number][] = [[base, 0], [base, -1], [base, NaN]];
    const r = filterAndValidateDexVolumePoints(rawPoints, todayStartMs);
    return r.valid.length === 1 && r.valid[0].value === 0 && r.invalid === 2 && r.ignored === 0;
  })());

check('15) allowlist DEX tem exatamente os 3 slugs e exclui dupla contagem',
  (() => {
    const slugs: readonly string[] = BACKFILL_DEX_PROTOCOL_SLUGS;
    return slugs.length === 3
      && slugs.includes('pump.fun')
      && slugs.includes('pumpswap')
      && slugs.includes('launchlab')
      && !slugs.includes('stonkfun')
      && !slugs.includes('pump.fun-mobile-app');
  })());

check('16) scope e métrica do protocolo montados corretamente',
  (() => {
    const scopesOk = BACKFILL_DEX_PROTOCOL_SLUGS.every((slug) => buildDexProtocolScope(slug) === `solana:protocol:${slug}`);
    const dayMs = 86400000;
    const rawPoints: [number, number][] = [[Math.floor((todayStartMs - 5 * dayMs) / 1000), 123]];
    const r = filterAndValidateDexVolumePoints(rawPoints, todayStartMs);
    return scopesOk
      && BACKFILL_DEX_METRIC_NAME === 'dex_volume_daily_usd'
      && r.valid.length === 1
      && r.valid[0].metric === BACKFILL_DEX_METRIC_NAME;
  })());

console.log(`\n=== TESTES DO BACKFILL FEES POR PROTOCOLO ===\n`);

check('17) allowlist de fees tem exatamente os 3 slugs e exclui dupla contagem',
  (() => {
    const slugs: readonly string[] = BACKFILL_FEES_PROTOCOL_SLUGS;
    return slugs.length === 3
      && slugs.includes('pump.fun')
      && slugs.includes('pumpswap')
      && slugs.includes('launchlab')
      && !slugs.includes('stonkfun')
      && !slugs.includes('pump.fun-mobile-app')
      && !slugs.includes('bags');
  })());

check('18) fees: D-5, D-2, D-1, hoje e amanhã -> só D-5 válido',
  (() => {
    const dayMs = 86400000;
    const rawPoints: [number, number][] = [
      [Math.floor((todayStartMs - 5 * dayMs) / 1000), 500],
      [Math.floor((todayStartMs - 2 * dayMs) / 1000), 200],
      [Math.floor((todayStartMs - 1 * dayMs) / 1000), 100],
      [Math.floor(todayStartMs / 1000), 50],
      [Math.floor((todayStartMs + dayMs) / 1000), 10],
    ];
    const r = filterAndValidateFeesPoints(rawPoints, todayStartMs);
    return r.valid.length === 1
      && r.valid[0].value === 500
      && r.ignored === 4
      && r.ignoredReasons.not_closed_day === 2
      && r.ignoredReasons.quarantine_recent_days === 2
      && r.invalid === 0;
  })());

check('19) fees: 0 válido; -1 e NaN inválidos',
  (() => {
    const dayMs = 86400000;
    const base = Math.floor((todayStartMs - 5 * dayMs) / 1000);
    const rawPoints: [number, number][] = [[base, 0], [base, -1], [base, NaN]];
    const r = filterAndValidateFeesPoints(rawPoints, todayStartMs);
    return r.valid.length === 1 && r.valid[0].value === 0 && r.invalid === 2 && r.ignored === 0;
  })());

check('20) scope e métrica de fees corretos e distintos das outras métricas',
  (() => {
    const scopesOk = BACKFILL_FEES_PROTOCOL_SLUGS.every((slug) => buildProtocolScope(slug) === `solana:protocol:${slug}`);
    const feesMetric: string = BACKFILL_FEES_METRIC_NAME;
    const dayMs = 86400000;
    const rawPoints: [number, number][] = [[Math.floor((todayStartMs - 5 * dayMs) / 1000), 123]];
    const r = filterAndValidateFeesPoints(rawPoints, todayStartMs);
    return scopesOk
      && feesMetric !== BACKFILL_DEX_METRIC_NAME
      && feesMetric !== 'fees_24h_usd'
      && feesMetric === 'fees_daily_usd'
      && r.valid.length === 1
      && r.valid[0].metric === BACKFILL_FEES_METRIC_NAME;
  })());

check('21) URL de fees inclui o slug e dataType=dailyFees explícito',
  (() => {
    const expected = 'https://api.llama.fi/summary/fees/pump.fun?dataType=dailyFees';
    return buildDefiLlamaFeesProtocolUrl('pump.fun') === expected;
  })());

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);