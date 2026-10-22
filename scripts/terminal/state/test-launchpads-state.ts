#!/usr/bin/env node
import {
  computeMarketState,
  type LaunchpadSlug,
  type MarketState,
  type StateIndicatorInput,
} from './market-state';
import {
  LAUNCHPAD_SLUGS,
  STATE_LAUNCHPAD_MIN_MAJORITY_SLUGS,
  STATE_LAUNCHPAD_MIN_USABLE_SLUGS,
  STATE_LAUNCHPAD_VS_MEAN_STRONG,
  STATE_LAUNCHPAD_VS_MEAN_WEAK,
  STATE_MAX_LEG_LAG_DAYS_LAUNCHPAD,
  STATE_RULES_VERSION,
  STATE_VERSION,
  buildProtocolScope,
} from '../config';

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

const REF = '2026-10-17';

function r(
  indicator: string,
  scope: string,
  value: number | null,
  asOf: string = REF,
  status = 'ok',
  reason: string | null = null
): StateIndicatorInput {
  return { indicator, scope, asOf, status, value, unit: 'FRACTION', reason };
}

const CORE: { indicator: string; scope: string; value: number }[] = [
  { indicator: 'return_7d', scope: 'solana', value: 0.05 },
  { indicator: 'return_30d', scope: 'solana', value: 0.10 },
  { indicator: 'volatility_7d', scope: 'solana', value: 0.04 },
  { indicator: 'relative_strength_7d', scope: 'solana:bitcoin', value: 0.04 },
  { indicator: 'relative_strength_7d', scope: 'solana:ethereum', value: 0.03 },
  { indicator: 'volume_vs_mean_7d', scope: 'solana', value: 0.25 },
  { indicator: 'stablecoin_supply_vs_mean_7d', scope: 'solana', value: 0.08 },
  { indicator: 'tvl_vs_mean_7d', scope: 'solana', value: 0.06 },
  { indicator: 'dex_volume_vs_mean_7d', scope: 'solana', value: 0.07 },
];

interface LpValues {
  volume: number | null;
  fees: number | null;
  asOf?: string;
  volumeAsOf?: string;
  feesAsOf?: string;
  volumeStatus?: string;
  feesStatus?: string;
  volumeReason?: string | null;
  feesReason?: string | null;
}

function coreRows(asOf: string = REF): StateIndicatorInput[] {
  return CORE.map((k) => r(k.indicator, k.scope, k.value, asOf));
}

function lpRows(values: Partial<Record<LaunchpadSlug, LpValues>>, defaultAsOf: string = REF): StateIndicatorInput[] {
  const rows: StateIndicatorInput[] = [];
  for (const slug of LAUNCHPAD_SLUGS) {
    const v = values[slug];
    if (v === undefined) continue;
    const scope = buildProtocolScope(slug);
    const asOf = v.asOf ?? defaultAsOf;
    rows.push(
      r('launchpad_dex_volume_vs_mean_7d', scope, v.volume, v.volumeAsOf ?? asOf, v.volumeStatus ?? 'ok', v.volumeReason ?? null),
      r('launchpad_fees_vs_mean_7d', scope, v.fees, v.feesAsOf ?? asOf, v.feesStatus ?? 'ok', v.feesReason ?? null)
    );
  }
  return rows;
}

function state(values: Partial<Record<LaunchpadSlug, LpValues>>, asOf: string = REF): MarketState {
  return computeMarketState({ asOf, indicators: [...coreRows(asOf), ...lpRows(values, asOf)] });
}

function strong(volume = 0.30, fees = 0.25): LpValues {
  return { volume, fees };
}

function weak(volume = -0.30, fees = -0.25): LpValues {
  return { volume, fees };
}

check('1) dois strong e dois weak no geral dão neutral, com classe por slug',
  (() => {
    const s = state({
      'pump.fun': strong(),
      pumpswap: strong(0.35, 0.30),
      launchlab: weak(),
      'meteora-dynamic-bonding-curve': weak(-0.35, -0.30),
    });
    return s.launchpads.classification === 'neutral'
      && s.launchpads.reason === null
      && s.launchpads.bySlug['pump.fun'].classification === 'strong'
      && s.launchpads.bySlug.pumpswap.classification === 'strong'
      && s.launchpads.bySlug.launchlab.classification === 'weak'
      && s.launchpads.bySlug['meteora-dynamic-bonding-curve'].classification === 'weak'
      && s.launchpads.evidence.length === 8;
  })());

check('2) três strong e um weak no geral dão strong',
  (() => {
    const s = state({
      'pump.fun': strong(),
      pumpswap: strong(),
      launchlab: strong(0.25, 0.20),
      'meteora-dynamic-bonding-curve': weak(),
    });
    return s.launchpads.classification === 'strong' && s.launchpads.reason === null;
  })());

check('3) três slugs utilizáveis bastam; o quarto ausente fica unavailable',
  (() => {
    const s = state({
      'pump.fun': strong(),
      pumpswap: strong(),
      launchlab: strong(),
    });
    return s.launchpads.classification === 'strong'
      && s.launchpads.bySlug['meteora-dynamic-bonding-curve'].classification === 'unavailable'
      && s.launchpads.bySlug['meteora-dynamic-bonding-curve'].reason !== null
      && s.launchpads.bySlug['meteora-dynamic-bonding-curve'].reason.includes('indicador ausente');
  })());

check('4) só dois slugs utilizáveis deixam o geral unavailable com os afetados no reason',
  (() => {
    const s = state({
      'pump.fun': strong(),
      pumpswap: strong(),
    });
    return s.launchpads.classification === 'unavailable'
      && s.launchpads.reason !== null
      && s.launchpads.reason.includes('launchlab')
      && s.launchpads.reason.includes('meteora-dynamic-bonding-curve')
      && s.launchpads.bySlug['pump.fun'].classification === 'strong';
  })());

check('5) lag de 4 dias é aceito e o asOf do slug é o mais recente dos decisores',
  (() => {
    const s = state({
      'pump.fun': { volume: 0.30, fees: 0.25, asOf: '2026-10-13' },
      pumpswap: { volume: 0.30, fees: 0.25, asOf: '2026-10-13' },
      launchlab: { volume: 0.30, fees: 0.25, asOf: '2026-10-13' },
      'meteora-dynamic-bonding-curve': { volume: 0.30, fees: 0.25, asOf: '2026-10-13' },
    });
    return s.launchpads.classification === 'strong'
      && s.launchpads.bySlug['pump.fun'].classification === 'strong'
      && s.launchpads.bySlug['pump.fun'].asOf === '2026-10-13';
  })());

check('6) lag de 5 dias no decisor deixa o slug unavailable, sem usar valor velho',
  (() => {
    const s = state({
      'pump.fun': { volume: 0.30, fees: 0.25, volumeAsOf: '2026-10-12' },
      pumpswap: strong(),
      launchlab: strong(),
      'meteora-dynamic-bonding-curve': strong(),
    });
    const pump = s.launchpads.bySlug['pump.fun'];
    return s.launchpads.classification === 'strong'
      && pump.classification === 'unavailable'
      && pump.reason !== null
      && pump.reason.includes('dado velho')
      && pump.reason.includes(`limite ${STATE_MAX_LEG_LAG_DAYS_LAUNCHPAD}`)
      && pump.asOf === REF;
  })());

check('7) divergência entre volume e fees é neutral com divergent=true e os dois valores',
  (() => {
    const s = state({
      'pump.fun': { volume: 0.30, fees: -0.30 },
      pumpswap: { volume: 0, fees: 0 },
      launchlab: { volume: 0, fees: 0 },
      'meteora-dynamic-bonding-curve': { volume: 0, fees: 0 },
    });
    const pump = s.launchpads.bySlug['pump.fun'];
    const evidenceValues = s.launchpads.evidence
      .filter((e) => e.scope === buildProtocolScope('pump.fun'))
      .map((e) => e.value);
    return s.launchpads.classification === 'neutral'
      && pump.classification === 'neutral'
      && pump.divergent === true
      && pump.reason === null
      && evidenceValues.includes(0.30)
      && evidenceValues.includes(-0.30);
  })());

check('8) em 2025-11-24 pump.fun e meteora sem histórico deixam o geral unavailable',
  (() => {
    const asOf = '2025-11-24';
    const s = state(
      {
        'pump.fun': { volume: null, fees: null, volumeStatus: 'insufficient_history', feesStatus: 'insufficient_history' },
        pumpswap: strong(),
        launchlab: strong(),
        'meteora-dynamic-bonding-curve': { volume: null, fees: null, volumeStatus: 'insufficient_history', feesStatus: 'insufficient_history' },
      },
      asOf
    );
    const pump = s.launchpads.bySlug['pump.fun'];
    return s.launchpads.classification === 'unavailable'
      && s.launchpads.reason !== null
      && s.launchpads.reason.includes('pump.fun')
      && s.launchpads.reason.includes('meteora-dynamic-bonding-curve')
      && pump.classification === 'unavailable'
      && pump.asOf === asOf
      && pump.indicators[0].status === 'insufficient_history'
      && pump.indicators[1].status === 'insufficient_history';
  })());

check('9) decisor novo insufficient_history não cai para o ok antigo',
  (() => {
    const s = computeMarketState({
      asOf: REF,
      indicators: [
        ...coreRows(),
        ...lpRows({ pumpswap: strong(), launchlab: strong(), 'meteora-dynamic-bonding-curve': strong() }),
        r('launchpad_dex_volume_vs_mean_7d', buildProtocolScope('pump.fun'), 0.50, '2026-10-16'),
        r('launchpad_dex_volume_vs_mean_7d', buildProtocolScope('pump.fun'), null, REF, 'insufficient_history'),
        r('launchpad_fees_vs_mean_7d', buildProtocolScope('pump.fun'), 0.30, REF),
      ],
    });
    const pump = s.launchpads.bySlug['pump.fun'];
    return s.launchpads.classification === 'strong'
      && pump.classification === 'unavailable'
      && pump.asOf === REF
      && pump.reason !== null
      && pump.reason.includes('insufficient_history');
  })());

check('10) qualidade continua 9/9, versões v2 e launchpads fora de data_quality',
  (() => {
    const s = state({
      'pump.fun': strong(),
      pumpswap: strong(),
      launchlab: strong(),
      'meteora-dynamic-bonding-curve': strong(),
    });
    const pump = s.launchpads.bySlug['pump.fun'];
    const decides = pump.indicators.filter((i) => i.role === 'decides').length;
    const context = pump.indicators.filter((i) => i.role === 'context').length;
    return s.stateVersion === STATE_VERSION
      && s.rulesVersion === STATE_RULES_VERSION
      && s.stateVersion === 'sol_state_v2'
      && s.rulesVersion === 'state_rules_v2'
      && s.data_quality.slotsOk === 9
      && s.data_quality.slotsTotal === 9
      && s.data_quality.score === 1
      && !s.data_quality.unavailableFields.includes('launchpads')
      && s.launchpads.ruleDescription.includes('entre os 4')
      && pump.indicators.length === 7
      && decides === 2
      && context === 5
      && s.thresholdsUsed.launchpad_vs_mean_strong === STATE_LAUNCHPAD_VS_MEAN_STRONG
      && s.thresholdsUsed.launchpad_vs_mean_weak === STATE_LAUNCHPAD_VS_MEAN_WEAK
      && s.thresholdsUsed.max_leg_lag_days_launchpad === STATE_MAX_LEG_LAG_DAYS_LAUNCHPAD
      && s.thresholdsUsed.launchpad_min_usable_slugs === STATE_LAUNCHPAD_MIN_USABLE_SLUGS
      && s.thresholdsUsed.launchpad_min_majority_slugs === STATE_LAUNCHPAD_MIN_MAJORITY_SLUGS;
  })());

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
