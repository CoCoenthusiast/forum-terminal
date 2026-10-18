#!/usr/bin/env node
import { evaluateMetricQuality, summarizeSource, classifyDailyCloseMethod, MetricStatus } from './quality';

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (!ok) failures++;
  else passed++;
}

const now = new Date('2026-10-10T12:00:00Z');
const baseInput = {
  metric: 'price',
  scope: 'solana',
  source: 'coingecko',
  latestValue: 100,
  latestCollectedAt: new Date(now.getTime() - 30 * 60000),
  previousValue: 95,
  previousCollectedAt: new Date(now.getTime() - 90 * 60000),
  sourceTs: new Date(now.getTime() - 31 * 60000),
  recentLogs: [{ status: 'success', endpoint: '/coins/markets', operation: 'fetch_price' }],
  now,
};

console.log('=== TESTES DE evaluateMetricQuality ===\n');

check('a) dado de 30 min atrás, sem salto -> fresh',
  evaluateMetricQuality({ ...baseInput }).status === 'fresh');

check('b) dado de 4h atrás (fonte horária) -> stale',
  evaluateMetricQuality({
    ...baseInput,
    latestCollectedAt: new Date(now.getTime() - 4 * 3600 * 1000),
    sourceTs: new Date(now.getTime() - 4 * 3600 * 1000 - 60000),
  }).status === 'stale');

check('c) 3 erros seguidos no CollectionLog -> failed',
  evaluateMetricQuality({
    ...baseInput,
    recentLogs: [
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
    ],
  }).status === 'failed');

check('c2) 3 erros salteados entre 5 registros (erro, ok, erro, ok, erro) -> NÃO é failed',
  evaluateMetricQuality({
    ...baseInput,
    recentLogs: [
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'success', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'success', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
    ],
  }).status !== 'failed');

check('c3) apenas 2 registros, ambos erro -> NÃO é failed',
  evaluateMetricQuality({
    ...baseInput,
    recentLogs: [
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
    ],
  }).status !== 'failed');

check('c4) 3 registros mais recentes erro e um mais antigo ok -> failed',
  evaluateMetricQuality({
    ...baseInput,
    recentLogs: [
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      { status: 'success', endpoint: '/coins/markets', operation: 'fetch_price' },
    ],
  }).status === 'failed');

check('d) preço que variou 40% entre duas coletas -> unverified',
  evaluateMetricQuality({
    ...baseInput,
    latestValue: 140,
    previousValue: 100,
  }).status === 'unverified');

check('e) volume que passou de 100 para 700 (razão 7) -> unverified',
  evaluateMetricQuality({
    ...baseInput,
    metric: 'dex_volume_24h_usd',
    latestValue: 700,
    previousValue: 100,
  }).status === 'unverified');

check('f) volume que foi de 0 para 500 -> NÃO é unverified (zero é ignorado na razão)',
  evaluateMetricQuality({
    ...baseInput,
    metric: 'dex_volume_24h_usd',
    latestValue: 500,
    previousValue: 0,
  }).status !== 'unverified');

check('g) métrica diária com sourceTs 40h antes do collectedAt -> stale',
  evaluateMetricQuality({
    ...baseInput,
    metric: 'tvl_usd',
    latestCollectedAt: new Date(now.getTime() - 30 * 60000),
    sourceTs: new Date(now.getTime() - 40 * 3600 * 1000),
  }).status === 'stale');

check('h) sourceTs null com dado recente -> fresh, e o motivo contém "horário da fonte indisponível"',
  (() => {
    const r = evaluateMetricQuality({ ...baseInput, sourceTs: null });
    return r.status === 'fresh' && r.reason.includes('horário da fonte indisponível');
  })());

check('i) preço negativo -> unverified com motivo de valor inválido',
  (() => {
    const r = evaluateMetricQuality({ ...baseInput, latestValue: -10 });
    return r.status === 'unverified' && r.reason.includes('inválido');
  })());

console.log('\n=== TESTES DE summarizeSource ===\n');

check('j) fonte com 1 métrica fresh e 1 stale -> resumo partial',
  summarizeSource(['fresh', 'stale']) === 'partial');

check('k) fonte com tudo fresh -> resumo fresh',
  summarizeSource(['fresh', 'fresh', 'fresh']) === 'fresh');

check('k2) fonte com failed -> failed',
  summarizeSource(['fresh', 'failed']) === 'failed');

check('k3) fonte com stale e unverified -> stale (pior)',
  summarizeSource(['stale', 'unverified']) === 'stale');

check('k4) fonte com unverified apenas -> unverified',
  summarizeSource(['unverified', 'unverified']) === 'unverified');

check('l) dado histórico com collectedAt de 4000 minutos atrás -> fresh e motivo contém "carga histórica"',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      latestCollectedAt: new Date(now.getTime() - 4000 * 60000),
      sourceTs: new Date(now.getTime() - 4000 * 60000 - 60000),
      isHistorical: true,
    });
    return r.status === 'fresh' && r.reason.includes('carga histórica');
  })());

check('m) dado histórico com 3 logs de erro -> NÃO é failed',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      recentLogs: [
        { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
        { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
        { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      ],
      isHistorical: true,
    });
    return r.status !== 'failed';
  })());

check('n) dado histórico com valor negativo -> unverified',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      latestValue: -10,
      isHistorical: true,
    });
    return r.status === 'unverified' && r.reason.includes('inválido');
  })());

check('o) dado histórico com salto de 40% entre os dois últimos pontos (preço) -> unverified',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      latestValue: 140,
      previousValue: 100,
      isHistorical: true,
    });
    return r.status === 'unverified' && r.reason.includes('salto anômalo');
  })());

check('p) mesmo dado de 4000 minutos atrás SEM isHistorical -> continua stale (regressão)',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      latestCollectedAt: new Date(now.getTime() - 4000 * 60000),
      sourceTs: new Date(now.getTime() - 4000 * 60000 - 60000),
      isHistorical: false,
    });
    return r.status === 'stale';
  })());

check('q) mesmo dado com 3 erros SEM isHistorical -> continua failed (regressão)',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      recentLogs: [
        { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
        { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
        { status: 'error', endpoint: '/coins/markets', operation: 'fetch_price' },
      ],
      isHistorical: false,
    });
    return r.status === 'failed';
  })());

console.log('\n=== TESTES DE classifyDailyCloseMethod ===\n');

check('r1) daily_close_from_history_v1 -> precise',
  classifyDailyCloseMethod('daily_close_from_history_v1') === 'precise');

check('r2) last_in_60m_window_v1 -> approximate',
  classifyDailyCloseMethod('last_in_60m_window_v1') === 'approximate');

check('r3) last_snapshot_of_day_v1 -> approximate',
  classifyDailyCloseMethod('last_snapshot_of_day_v1') === 'approximate');

check('r4) método desconhecido -> unknown',
  classifyDailyCloseMethod('metodo_inexistente_v0') === 'unknown');

console.log('\n=== TESTES DE frescor histórico por sourceTs (limites 2/2/2/4) ===\n');

check('s1) preço histórico, sourceTs = D-2 (2026-10-08), lag 2 -> fresh',
  evaluateMetricQuality({
    ...baseInput,
    isHistorical: true,
    historicalMaxLagDays: 2,
    sourceTs: new Date('2026-10-08T00:00:00Z'),
    latestCollectedAt: new Date('2026-10-08T00:00:00Z'),
  }).status === 'fresh');

check('s2) preço histórico, sourceTs = D-3 (2026-10-07), lag 2 -> stale com a data',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      isHistorical: true,
      historicalMaxLagDays: 2,
      sourceTs: new Date('2026-10-07T00:00:00Z'),
      latestCollectedAt: new Date('2026-10-07T00:00:00Z'),
    });
    return r.status === 'stale' && r.reason.includes('2026-10-07');
  })());

check('s3) tvl histórico, sourceTs = D-3 (2026-10-07), lag 2 -> stale com a data',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      metric: 'tvl_usd',
      isHistorical: true,
      historicalMaxLagDays: 2,
      sourceTs: new Date('2026-10-07T00:00:00Z'),
      latestCollectedAt: new Date('2026-10-07T00:00:00Z'),
    });
    return r.status === 'stale' && r.reason.includes('2026-10-07');
  })());

check('s4) stablecoin histórico, sourceTs = D-3 (2026-10-07), lag 2 -> stale com a data',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      metric: 'stablecoin_supply_usd',
      isHistorical: true,
      historicalMaxLagDays: 2,
      sourceTs: new Date('2026-10-07T00:00:00Z'),
      latestCollectedAt: new Date('2026-10-07T00:00:00Z'),
    });
    return r.status === 'stale' && r.reason.includes('2026-10-07');
  })());

check('s5) DEX histórico, sourceTs = D-4 (2026-10-06), lag 4 -> fresh',
  evaluateMetricQuality({
    ...baseInput,
    metric: 'dex_volume_daily_usd',
    isHistorical: true,
    historicalMaxLagDays: 4,
    sourceTs: new Date('2026-10-06T00:00:00Z'),
    latestCollectedAt: new Date('2026-10-06T00:00:00Z'),
  }).status === 'fresh');

check('s6) DEX histórico, sourceTs = D-5 (2026-10-05), lag 4 -> stale com a data',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      metric: 'dex_volume_daily_usd',
      isHistorical: true,
      historicalMaxLagDays: 4,
      sourceTs: new Date('2026-10-05T00:00:00Z'),
      latestCollectedAt: new Date('2026-10-05T00:00:00Z'),
    });
    return r.status === 'stale' && r.reason.includes('2026-10-05');
  })());

check('s7) borda de horário: sourceTs D-2 23:59:59Z, lag 2 -> fresh (compara só a data UTC)',
  evaluateMetricQuality({
    ...baseInput,
    isHistorical: true,
    historicalMaxLagDays: 2,
    sourceTs: new Date('2026-10-08T23:59:59Z'),
    latestCollectedAt: new Date('2026-10-08T23:59:59Z'),
  }).status === 'fresh');

check('s8) borda de horário: sourceTs D-3 23:59:59Z, lag 2 -> stale',
  evaluateMetricQuality({
    ...baseInput,
    isHistorical: true,
    historicalMaxLagDays: 2,
    sourceTs: new Date('2026-10-07T23:59:59Z'),
    latestCollectedAt: new Date('2026-10-07T23:59:59Z'),
  }).status === 'stale');

check('s9) histórico com sourceTs null e campo definido -> fresh sem checar frescor (motivo "carga histórica")',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      isHistorical: true,
      historicalMaxLagDays: 2,
      sourceTs: null,
    });
    return r.status === 'fresh' && r.reason.includes('carga histórica');
  })());

check('s10) histórico antigo SEM historicalMaxLagDays -> fresh (opt-in desativado)',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      isHistorical: true,
      sourceTs: new Date('2026-10-01T00:00:00Z'),
      latestCollectedAt: new Date('2026-10-01T00:00:00Z'),
    });
    return r.status === 'fresh' && r.reason.includes('carga histórica');
  })());

check('s11) mesmo dado antigo COM historicalMaxLagDays=2 -> stale (prova do opt-in)',
  evaluateMetricQuality({
    ...baseInput,
    isHistorical: true,
    historicalMaxLagDays: 2,
    sourceTs: new Date('2026-10-01T00:00:00Z'),
    latestCollectedAt: new Date('2026-10-01T00:00:00Z'),
  }).status === 'stale');

check('s12) valor inválido tem precedência sobre frescor histórico',
  (() => {
    const r = evaluateMetricQuality({
      ...baseInput,
      latestValue: -10,
      isHistorical: true,
      historicalMaxLagDays: 2,
      sourceTs: new Date('2026-10-01T00:00:00Z'),
      latestCollectedAt: new Date('2026-10-01T00:00:00Z'),
    });
    return r.status === 'unverified' && r.reason.includes('inválido');
  })());

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);