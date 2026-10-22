#!/usr/bin/env node
import {
  computeMarketState,
  latestByIndicator,
  type Evidence,
  type MarketState,
  type MarketStateInput,
  type StateField,
  type StateIndicatorInput,
} from './market-state';
import {
  STATE_VERSION,
  STATE_RULES_VERSION,
  STATE_TREND_RETURN7D_BULLISH,
  STATE_RS_PAIR_STRONG,
  STATE_SPOT_DISTANCE_EXPANDING,
  STATE_MAX_LEG_LAG_DAYS_DEX,
} from '../config';

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function approx(a: number, b: number, tol = 1e-9): boolean {
  return Math.abs(a - b) < tol;
}

// Referência = último dia UTC fechado (ontem). Indicadores normalmente têm esse asOf.
const REF = '2026-10-17';

function r(indicator: string, scope: string, value: number | null, asOf: string = REF, status = 'ok', reason: string | null = null): StateIndicatorInput {
  return { indicator, scope, asOf, status, value, unit: 'FRACTION', reason };
}

const BASE: { indicator: string; scope: string; value: number }[] = [
  { indicator: 'return_7d', scope: 'solana', value: 0.05 },
  { indicator: 'return_30d', scope: 'solana', value: 0.10 },
  { indicator: 'return_1d', scope: 'solana', value: 0.01 },
  { indicator: 'volatility_7d', scope: 'solana', value: 0.04 },
  { indicator: 'relative_strength_7d', scope: 'solana:bitcoin', value: 0.04 },
  { indicator: 'relative_strength_7d', scope: 'solana:ethereum', value: 0.03 },
  { indicator: 'relative_strength_30d', scope: 'solana:bitcoin', value: 0.10 },
  { indicator: 'relative_strength_30d', scope: 'solana:ethereum', value: 0.08 },
  { indicator: 'volume_vs_mean_7d', scope: 'solana', value: 0.25 },
  { indicator: 'volume_vs_mean_30d', scope: 'solana', value: 0.10 },
  { indicator: 'stablecoin_supply_vs_mean_7d', scope: 'solana', value: 0.08 },
  { indicator: 'tvl_vs_mean_7d', scope: 'solana', value: 0.06 },
  { indicator: 'dex_volume_vs_mean_7d', scope: 'solana', value: 0.07 },
];

interface Override {
  value?: number | null;
  asOf?: string;
  status?: string;
  reason?: string | null;
}

function base(overrides: Record<string, Override> = {}): StateIndicatorInput[] {
  return BASE.map((k) => {
    const o = overrides[`${k.indicator}|${k.scope}`];
    return r(k.indicator, k.scope, o?.value !== undefined ? o.value : k.value, o?.asOf ?? REF, o?.status ?? 'ok', o?.reason ?? null);
  });
}

function state(overrides: Record<string, Override> = {}, asOf: string = REF): MarketState {
  const input: MarketStateInput = { asOf, indicators: base(overrides) };
  return computeMarketState(input);
}

function evOf(field: StateField<string>, indicator: string, scope: string): Evidence | undefined {
  return field.evidence.find((e) => e.indicator === indicator && e.scope === scope);
}

console.log('=== TESTES DE computeMarketState ===\n');

check('1) tudo bullish: trend bullish, RS strong, spot expanding, liq expanding, score 1.0',
  (() => {
    const s = state();
    return s.sol_trend.classification === 'bullish'
      && s.sol_relative_strength.classification === 'strong'
      && s.spot.classification === 'expanding'
      && s.onchain_liquidity.classification === 'expanding'
      && approx(s.data_quality.score, 1)
      && s.data_quality.slotsOk === 9
      && s.data_quality.oldestAsOf === REF;
  })());

check('2) tudo bearish: trend bearish, RS weak, spot contracting, liq contracting',
  (() => {
    const s = state({
      'return_7d|solana': { value: -0.05 },
      'relative_strength_7d|solana:bitcoin': { value: -0.04 },
      'relative_strength_7d|solana:ethereum': { value: -0.03 },
      'volume_vs_mean_7d|solana': { value: -0.25 },
      'stablecoin_supply_vs_mean_7d|solana': { value: -0.08 },
      'tvl_vs_mean_7d|solana': { value: -0.06 },
      'dex_volume_vs_mean_7d|solana': { value: -0.07 },
    });
    return s.sol_trend.classification === 'bearish'
      && s.sol_relative_strength.classification === 'weak'
      && s.spot.classification === 'contracting'
      && s.onchain_liquidity.classification === 'contracting';
  })());

check('3) borda da tendência: return_7d exatamente no limite bullish -> bullish',
  state({ 'return_7d|solana': { value: STATE_TREND_RETURN7D_BULLISH } }).sol_trend.classification === 'bullish');

check('4) return_7d 0.029 (abaixo do limite) -> neutral',
  state({ 'return_7d|solana': { value: 0.029 } }).sol_trend.classification === 'neutral');

check('5) borda da força relativa: as duas pernas no limite strong -> strong',
  state({
    'relative_strength_7d|solana:bitcoin': { value: STATE_RS_PAIR_STRONG },
    'relative_strength_7d|solana:ethereum': { value: STATE_RS_PAIR_STRONG },
  }).sol_relative_strength.classification === 'strong');

check('6) RS BTC 0.01 (neutro) e ETH 0.04 -> neutral',
  state({
    'relative_strength_7d|solana:bitcoin': { value: 0.01 },
    'relative_strength_7d|solana:ethereum': { value: 0.04 },
  }).sol_relative_strength.classification === 'neutral');

check('7) RS BTC +0.04 e ETH -0.04 -> neutral (misto)',
  state({
    'relative_strength_7d|solana:bitcoin': { value: 0.04 },
    'relative_strength_7d|solana:ethereum': { value: -0.04 },
  }).sol_relative_strength.classification === 'neutral');

check('8) perna ETH insufficient_history -> insufficient_data citando a perna',
  (() => {
    const s = state({ 'relative_strength_7d|solana:ethereum': { value: null, status: 'insufficient_history', reason: 'poucos pontos' } });
    return s.sol_relative_strength.classification === 'insufficient_data'
      && (s.sol_relative_strength.reason ?? '').includes('solana:ethereum');
  })());

check('9) borda do spot: volume_vs_mean_7d exatamente no limite -> expanding',
  state({ 'volume_vs_mean_7d|solana': { value: STATE_SPOT_DISTANCE_EXPANDING } }).spot.classification === 'expanding');

check('10) volume_vs_mean_7d 0.19 -> neutral',
  state({ 'volume_vs_mean_7d|solana': { value: 0.19 } }).spot.classification === 'neutral');

check('11) liquidez: 2 expanding + 1 neutral -> expanding',
  state({
    'stablecoin_supply_vs_mean_7d|solana': { value: 0.08 },
    'tvl_vs_mean_7d|solana': { value: 0.06 },
    'dex_volume_vs_mean_7d|solana': { value: 0.0 },
  }).onchain_liquidity.classification === 'expanding');

check('12) liquidez: 2 expanding + 1 contracting -> neutral (misto)',
  state({
    'stablecoin_supply_vs_mean_7d|solana': { value: 0.08 },
    'tvl_vs_mean_7d|solana': { value: 0.06 },
    'dex_volume_vs_mean_7d|solana': { value: -0.06 },
  }).onchain_liquidity.classification === 'neutral');

check('13) liquidez: 2 contracting + 1 neutral -> contracting',
  state({
    'stablecoin_supply_vs_mean_7d|solana': { value: -0.08 },
    'tvl_vs_mean_7d|solana': { value: -0.06 },
    'dex_volume_vs_mean_7d|solana': { value: 0.0 },
  }).onchain_liquidity.classification === 'contracting');

check('14) liquidez: só 1 sinal ok (outros 2 insufficient) -> insufficient_data',
  state({
    'tvl_vs_mean_7d|solana': { value: null, status: 'insufficient_history', reason: 'x' },
    'dex_volume_vs_mean_7d|solana': { value: null, status: 'insufficient_history', reason: 'y' },
  }).onchain_liquidity.classification === 'insufficient_data');

check('15) DEX 2 dias atrás (asOf 2026-10-15, limite 4) entra na combinação e aparece na evidência',
  (() => {
    const s = state({ 'dex_volume_vs_mean_7d|solana': { asOf: '2026-10-15', value: 0.07 } });
    const dex = evOf(s.onchain_liquidity, 'dex_volume_vs_mean_7d', 'solana');
    return s.onchain_liquidity.classification === 'expanding'
      && dex !== undefined && dex.asOf === '2026-10-15'
      && s.data_quality.oldestAsOf === '2026-10-15';
  })());

check('16) DEX 5 dias atrás (asOf 2026-10-12, limite 4) é excluído; sobrando 1 sinal -> insufficient_data',
  (() => {
    const s = state({
      'stablecoin_supply_vs_mean_7d|solana': { value: null, status: 'insufficient_history', reason: 'z' },
      'dex_volume_vs_mean_7d|solana': { asOf: '2026-10-12', value: 0.07 },
    });
    const dex = evOf(s.onchain_liquidity, 'dex_volume_vs_mean_7d', 'solana');
    return s.onchain_liquidity.classification === 'insufficient_data'
      && dex !== undefined && dex.stale === true;
  })());

check('17) return_7d com asOf 3 dias atrás (limite 2) -> trend insufficient_data',
  state({ 'return_7d|solana': { asOf: '2026-10-14', value: 0.05 } }).sol_trend.classification === 'insufficient_data');

check('18) entrada vazia: 4 campos insufficient_data, sem exceção',
  (() => {
    const s = computeMarketState({ asOf: REF, indicators: [] });
    return s.sol_trend.classification === 'insufficient_data'
      && s.sol_relative_strength.classification === 'insufficient_data'
      && s.spot.classification === 'insufficient_data'
      && s.onchain_liquidity.classification === 'insufficient_data'
      && s.data_quality.score === 0
      && s.data_quality.oldestAsOf === null;
  })());

check('19) leverage/macro seguem no_collector_v1 e launchpads fica unavailable sem os 3 slugs',
  (() => {
    const s = state();
    return s.leverage.classification === 'unavailable' && s.leverage.rule === 'no_collector_v1'
      && s.launchpads.classification === 'unavailable' && s.launchpads.rule === 'launchpads_activity_v2'
      && Object.keys(s.launchpads.bySlug).length === 4
      && s.launchpads.bySlug['pump.fun'].classification === 'unavailable'
      && s.launchpads.reason !== null && s.launchpads.reason.includes('pump.fun')
      && s.macro.classification === 'unavailable' && s.macro.rule === 'no_collector_v1'
      && s.leverage.evidence.length === 0;
  })());

check('20) reprodutível: mesma entrada gera saída idêntica; versões e limites batem',
  (() => {
    const a = state();
    const b = state();
    return JSON.stringify(a) === JSON.stringify(b)
      && a.stateVersion === STATE_VERSION
      && a.rulesVersion === STATE_RULES_VERSION
      && a.thresholdsUsed.max_leg_lag_days_dex === STATE_MAX_LEG_LAG_DAYS_DEX;
  })());

check('21) valor 0 é dado válido: spot neutral com evidência status ok e value 0',
  (() => {
    const s = state({ 'volume_vs_mean_7d|solana': { value: 0 } });
    const v = evOf(s.spot, 'volume_vs_mean_7d', 'solana');
    return s.spot.classification === 'neutral'
      && v !== undefined && v.status === 'ok' && v.value === 0;
  })());

check('22) valores reais de 2026-10-17: return_7d -0.060347900976 -> bearish; tvl -0.017932207379 -> leg neutral',
  (() => {
    const s = state({
      'return_7d|solana': { value: -0.060347900976 },
      'tvl_vs_mean_7d|solana': { value: -0.017932207379 },
    });
    const tvl = evOf(s.onchain_liquidity, 'tvl_vs_mean_7d', 'solana');
    return s.sol_trend.classification === 'bearish'
      && tvl !== undefined && tvl.legClassification === 'neutral';
  })());

check('23) qualidade parcial: perna ETH ausente -> score 8/9 e aparece em missingCore',
  (() => {
    const s = state({ 'relative_strength_7d|solana:ethereum': { value: null, status: 'insufficient_history', reason: 'x' } });
    return approx(s.data_quality.score, 8 / 9)
      && s.data_quality.slotsOk === 8
      && s.data_quality.missingCore.some((m) => m.scope === 'solana:ethereum');
  })());

console.log('\n=== TESTES DE latestByIndicator ===\n');

check('24) escolhe o asOf mais recente por (indicator, scope)',
  (() => {
    const map = latestByIndicator([
      r('return_7d', 'solana', 0.01, '2026-10-15'),
      r('return_7d', 'solana', 0.05, '2026-10-17'),
    ]);
    return map.get('return_7d|solana')?.value === 0.05;
  })());

check('25) em asOf igual, preocupa-se o status ok sobre insufficient_history',
  (() => {
    const map = latestByIndicator([
      r('return_7d', 'solana', null, '2026-10-17', 'insufficient_history'),
      r('return_7d', 'solana', 0.05, '2026-10-17'),
    ]);
    return map.get('return_7d|solana')?.status === 'ok';
  })());

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
