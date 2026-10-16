#!/usr/bin/env node
import {
  filterAndValidatePricePoints,
} from './sources/coingecko-history';
import {
  filterAndValidateTvlPoints,
  filterAndValidateStablecoinPoints,
  filterAndValidateDexVolumePoints,
} from './sources/defillama-history';

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

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);