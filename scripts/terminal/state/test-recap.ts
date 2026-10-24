#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type {
  LaunchpadClassification,
  MarketState,
  StrengthClassification,
  TrendClassification,
} from './market-state';
import { deriveRegime, type MarketStateWithRegime } from './regime';
import { buildRecapDraft } from './recap';
import { hasRegimePayload, parseAsOfArg } from '../report-recap';

const DISCLAIMER =
  'This recap describes market conditions. It is not financial advice and does not predict prices.';

const FORBIDDEN = [
  'good',
  'bad',
  'buy',
  'sell',
  'should',
  'recommend',
  'predict',
  'bullish signal',
  'opportunity',
];

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function forbiddenWords(text: string): string[] {
  const withoutDisclaimer = text.replace(DISCLAIMER, ' ').toLowerCase();
  return FORBIDDEN.filter((word) => withoutDisclaimer.includes(word));
}

function checkClean(label: string, text: string): void {
  const hits = forbiddenWords(text);
  check(`${label}: sem palavras proibidas`, hits.length === 0, hits.join(','));
  check(`${label}: sem undefined/null/NaN`, !/\b(undefined|null|NaN)\b/.test(text));
  check(`${label}: sem travessão ou hífen de pontuação`, !/[—–]/.test(text) && !text.includes(' - '));
}

function makeState(
  trend: TrendClassification = 'bullish',
  strength: StrengthClassification = 'strong'
): MarketStateWithRegime {
  const base: MarketState = {
    asOf: '2026-10-17',
    stateVersion: 'sol_state_v2',
    rulesVersion: 'state_rules_v2',
    sol_trend: {
      classification: trend,
      rule: 'trend_return7d_v1',
      ruleDescription: 'Trend rule',
      evidence: [
        {
          indicator: 'return_7d',
          scope: 'solana',
          value: 0.031,
          asOf: '2026-10-17',
          status: 'ok',
          role: 'decides',
        },
      ],
      reason: null,
    },
    sol_relative_strength: {
      classification: strength,
      rule: 'rs_pair_v1',
      ruleDescription: 'Relative strength rule',
      evidence: [
        {
          indicator: 'relative_strength_7d',
          scope: 'solana:bitcoin',
          value: 0.03,
          asOf: '2026-10-17',
          status: 'ok',
          role: 'decides',
          legClassification: strength,
        },
        {
          indicator: 'relative_strength_7d',
          scope: 'solana:ethereum',
          value: 0.025,
          asOf: '2026-10-17',
          status: 'ok',
          role: 'decides',
          legClassification: strength,
        },
      ],
      reason: null,
    },
    spot: {
      classification: 'expanding',
      rule: 'spot_vsmean7d_v1',
      ruleDescription: 'Spot rule',
      evidence: [
        {
          indicator: 'volume_vs_mean_7d',
          scope: 'solana',
          value: 0.25,
          asOf: '2026-10-17',
          status: 'ok',
          role: 'decides',
        },
      ],
      reason: null,
    },
    onchain_liquidity: {
      classification: 'expanding',
      rule: 'liq_vsmean7d_v1',
      ruleDescription: 'Liquidity rule',
      evidence: [],
      reason: null,
    },
    leverage: {
      classification: 'unavailable',
      rule: 'no_collector_v1',
      ruleDescription: 'No collector',
      evidence: [],
      reason: null,
    },
    launchpads: {
      classification: 'neutral',
      rule: 'launchpads_activity_v2',
      ruleDescription: 'Launchpads rule',
      evidence: [],
      reason: null,
      bySlug: {} as MarketState['launchpads']['bySlug'],
    },
    macro: {
      classification: 'unavailable',
      rule: 'no_collector_v1',
      ruleDescription: 'No collector',
      evidence: [],
      reason: null,
    },
    data_quality: {
      score: 1,
      slotsOk: 9,
      slotsTotal: 9,
      sourcesUsed: [],
      missingCore: [],
      oldestAsOf: '2026-10-17',
      referenceAsOf: '2026-10-17',
      unavailableFields: [],
      insufficientDataFields: [],
    },
    rulesApplied: [],
    thresholdsUsed: {},
  };

  return { ...base, regime: deriveRegime(base) };
}

function run(): void {
  check('asof: sem flag usa a linha mais recente', parseAsOfArg([]).asOf === null);
  check(
    'asof: data válida',
    parseAsOfArg(['--asof=2026-10-17']).asOf === '2026-10-17'
      && parseAsOfArg(['--asof=2026-10-17']).error === null
  );
  check('asof: data impossível rejeitada', parseAsOfArg(['--asof=2026-02-30']).error !== null);
  check('asof: sem valor rejeitado', parseAsOfArg(['--asof']).error !== null);
  check('asof: duplicado rejeitado', parseAsOfArg(['--asof=2026-10-17', '--asof=2026-10-16']).error !== null);
  check('payload: regime detectado', hasRegimePayload({ regime: {} }) === true);
  check('payload: sem regime detectado', hasRegimePayload({}) === false);
  check('payload: null não tem regime', hasRegimePayload(null) === false);

  const baseState = makeState();
  const baseText = buildRecapDraft(baseState);

  check('base: título', baseText.startsWith('SOL Daily Recap: 2026-10-17\n'));
  check('base: regime', baseText.includes(`Regime: ${baseState.regime.description}`));
  check('base: trend e percentual', baseText.includes('Trend: bullish, 7d return +3.1%'));
  check(
    'base: força relativa',
    baseText.includes('Relative strength vs BTC: strong, 7d +3.0%; vs ETH: strong, 7d +2.5%')
  );
  check('base: spot', baseText.includes('Spot volume: expanding, +25.0% vs 7d average'));
  check('base: liquidez', baseText.includes('On-chain liquidity: expanding'));
  check('base: launchpads', baseText.includes('Launchpads: neutral'));
  check('base: não cobertos', baseText.includes('Not covered yet: leverage and macro.'));
  check(
    'base: qualidade',
    baseText.includes('Data quality: 9 of 9 core series available. Oldest data point: 2026-10-17.')
  );
  check('base: sem linha de atraso', !baseText.includes('Delayed inputs:'));
  check('base: aviso fixo', baseText.includes(DISCLAIMER));
  check('base: regras', baseText.includes('Rules: sol_state_v2, state_rules_v2, regime_rules_v1.'));
  check(
    'base: fontes',
    baseText.endsWith('Data: CoinGecko, DefiLlama. Powered by CoinGecko. Powered by DefiLlama.')
  );
  check('base: determinístico', buildRecapDraft(baseState) === baseText);
  checkClean('base', baseText);

  const cases: Array<{
    trend: TrendClassification;
    strength: StrengthClassification;
    expected: string;
  }> = [
    { trend: 'bullish', strength: 'strong', expected: 'trend_up_confirmed' },
    { trend: 'bullish', strength: 'neutral', expected: 'trend_up_unconfirmed' },
    { trend: 'neutral', strength: 'neutral', expected: 'range_neutral' },
    { trend: 'bearish', strength: 'neutral', expected: 'trend_down_unconfirmed' },
    { trend: 'bearish', strength: 'weak', expected: 'trend_down_confirmed' },
    { trend: 'neutral', strength: 'weak', expected: 'weak_without_trend' },
    { trend: 'neutral', strength: 'strong', expected: 'strong_without_trend' },
    { trend: 'bearish', strength: 'strong', expected: 'conflicting' },
    { trend: 'bullish', strength: 'weak', expected: 'conflicting' },
    { trend: 'insufficient_data', strength: 'neutral', expected: 'insufficient_data' },
  ];

  const seen = new Set<string>();
  for (const item of cases) {
    const state = makeState(item.trend, item.strength);
    const text = buildRecapDraft(state);
    seen.add(state.regime.regimeId);
    check(
      `regime: ${item.trend}+${item.strength} -> ${item.expected}`,
      state.regime.regimeId === item.expected
        && text.includes(`Regime: ${state.regime.description}`)
    );
    checkClean(`regime ${item.expected}`, text);
  }
  check('regimes: 9 ids cobertos', seen.size === 9);

  const percentState = makeState();
  percentState.sol_trend.evidence[0].value = 0.031;
  percentState.sol_relative_strength.evidence[0].value = -0.02;
  percentState.sol_relative_strength.evidence[0].legClassification = 'weak';
  percentState.sol_relative_strength.evidence[1].value = 0;
  percentState.sol_relative_strength.evidence[1].legClassification = 'neutral';
  percentState.spot.evidence[0].value = 0.25;
  const percentText = buildRecapDraft(percentState);
  check('percentual: +3.1%', percentText.includes('Trend: bullish, 7d return +3.1%'));
  check(
    'percentual: -2.0% e 0.0%',
    percentText.includes('Relative strength vs BTC: weak, 7d -2.0%; vs ETH: neutral, 7d 0.0%')
  );
  check('percentual: +25.0%', percentText.includes('Spot volume: expanding, +25.0% vs 7d average'));
  checkClean('percentual', percentText);

  percentState.sol_relative_strength.evidence[1].value = -0.00001;
  const negativeZeroText = buildRecapDraft(percentState);
  check(
    'percentual: zero negativo vira 0.0%',
    negativeZeroText.includes('vs ETH: neutral, 7d 0.0%')
  );
  checkClean('zero negativo', negativeZeroText);

  const nullState = makeState();
  nullState.sol_trend.evidence[0].value = null;
  const nullText = buildRecapDraft(nullState);
  check('valor null vira n/a', nullText.includes('Trend: bullish, 7d return n/a'));
  checkClean('valor null', nullText);

  const nanState = makeState();
  nanState.sol_trend.evidence[0].value = Number.NaN;
  const nanText = buildRecapDraft(nanState);
  check('valor NaN vira n/a', nanText.includes('Trend: bullish, 7d return n/a'));
  checkClean('valor NaN', nanText);

  const missingState = makeState();
  missingState.spot.evidence = [];
  const missingText = buildRecapDraft(missingState);
  check(
    'evidence ausente vira n/a',
    missingText.includes('Spot volume: expanding, n/a vs 7d average')
  );
  checkClean('evidence ausente', missingText);

  const lowData = makeState('insufficient_data', 'unavailable');
  lowData.sol_trend.evidence[0].value = null;
  lowData.sol_relative_strength.evidence[0].value = null;
  lowData.sol_relative_strength.evidence[1].value = null;
  lowData.spot.evidence[0].value = null;
  lowData.spot.classification = 'unavailable';
  lowData.onchain_liquidity.classification = 'unavailable';
  lowData.launchpads.classification = 'unavailable';
  const lowText = buildRecapDraft(lowData);
  check('insuficiente: trend', lowText.includes('Trend: not enough data, 7d return n/a'));
  check(
    'insuficiente: força relativa',
    lowText.includes('Relative strength vs BTC: not enough data, 7d n/a; vs ETH: not enough data, 7d n/a')
  );
  check('insuficiente: spot', lowText.includes('Spot volume: not enough data, n/a vs 7d average'));
  check('insuficiente: liquidez', lowText.includes('On-chain liquidity: not enough data'));
  check('insuficiente: launchpads', lowText.includes('Launchpads: not enough data'));
  check(
    'insuficiente: sem códigos internos',
    !lowText.includes('insufficient_data') && !lowText.includes('unavailable')
  );
  checkClean('insuficiente', lowText);

  const staleState = makeState();
  staleState.sol_trend.evidence[0].stale = true;
  staleState.sol_relative_strength.evidence[0].stale = true;
  staleState.sol_relative_strength.evidence[1].stale = true;
  const staleText = buildRecapDraft(staleState);
  check(
    'stale: lista sem duplicar',
    staleText.includes('Delayed inputs: return_7d, relative_strength_7d.')
  );
  check('stale: uma única linha', staleText.split('Delayed inputs:').length === 2);
  checkClean('stale', staleText);

  const noOldest = makeState();
  noOldest.data_quality.oldestAsOf = null;
  const noOldestText = buildRecapDraft(noOldest);
  check('oldest null vira n/a', noOldestText.includes('Oldest data point: n/a.'));
  checkClean('oldest null', noOldestText);

  const launchpadState = makeState();
  launchpadState.launchpads.classification = 'strong' as LaunchpadClassification;
  const launchpadText = buildRecapDraft(launchpadState);
  check('launchpads: classificação formatada', launchpadText.includes('Launchpads: strong'));
  checkClean('launchpads', launchpadText);

  console.log('\n=== EXEMPLO DE RASCUNHO ===');
  console.log(baseText);

  console.log(`\n${passed} passaram, ${failures} falharam`);
  if (failures > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run();
}
