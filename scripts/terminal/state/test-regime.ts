#!/usr/bin/env node
import { REGIME_RULES_VERSION } from '../config';
import type {
  FlowClassification,
  LaunchpadClassification,
  MarketState,
  StrengthClassification,
  TrendClassification,
} from './market-state';
import { deriveRegime, type RegimeId } from './regime';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

interface Context {
  spot: FlowClassification;
  onchain_liquidity: FlowClassification;
  launchpads: LaunchpadClassification;
}

const DEFAULT_CONTEXT: Context = {
  spot: 'expanding',
  onchain_liquidity: 'contracting',
  launchpads: 'neutral',
};

function makeState(
  trend: TrendClassification,
  strength: StrengthClassification,
  context: Context = DEFAULT_CONTEXT
): MarketState {
  return {
    sol_trend: { classification: trend },
    sol_relative_strength: { classification: strength },
    spot: { classification: context.spot },
    onchain_liquidity: { classification: context.onchain_liquidity },
    launchpads: { classification: context.launchpads },
  } as unknown as MarketState;
}

interface Case {
  trend: TrendClassification;
  strength: StrengthClassification;
  regimeId: RegimeId;
  description: string;
}

const TABLE: Case[] = [
  {
    trend: 'bullish',
    strength: 'strong',
    regimeId: 'trend_up_confirmed',
    description: 'SOL trend is up and relative strength versus BTC and ETH is strong.',
  },
  {
    trend: 'bullish',
    strength: 'neutral',
    regimeId: 'trend_up_unconfirmed',
    description: 'SOL trend is up while relative strength versus BTC and ETH is neutral.',
  },
  {
    trend: 'neutral',
    strength: 'neutral',
    regimeId: 'range_neutral',
    description: 'SOL trend and relative strength versus BTC and ETH are both neutral.',
  },
  {
    trend: 'bearish',
    strength: 'neutral',
    regimeId: 'trend_down_unconfirmed',
    description: 'SOL trend is down while relative strength versus BTC and ETH is neutral.',
  },
  {
    trend: 'bearish',
    strength: 'weak',
    regimeId: 'trend_down_confirmed',
    description: 'SOL trend is down and relative strength versus BTC and ETH is weak.',
  },
  {
    trend: 'neutral',
    strength: 'weak',
    regimeId: 'weak_without_trend',
    description: 'SOL trend is neutral while relative strength versus BTC and ETH is weak.',
  },
  {
    trend: 'neutral',
    strength: 'strong',
    regimeId: 'strong_without_trend',
    description: 'SOL trend is neutral while relative strength versus BTC and ETH is strong.',
  },
  {
    trend: 'bearish',
    strength: 'strong',
    regimeId: 'conflicting',
    description: 'SOL trend and relative strength versus BTC and ETH point in opposite directions.',
  },
  {
    trend: 'bullish',
    strength: 'weak',
    regimeId: 'conflicting',
    description: 'SOL trend and relative strength versus BTC and ETH point in opposite directions.',
  },
];

console.log('=== TESTES DE deriveRegime ===\n');

for (const item of TABLE) {
  const regime = deriveRegime(makeState(item.trend, item.strength));
  check(
    `${item.trend} + ${item.strength} -> ${item.regimeId}`,
    regime.regimeId === item.regimeId,
    `(${regime.regimeId})`
  );
  check(`description de ${item.regimeId}`, regime.description === item.description, `(${regime.description})`);
  check(
    `decidedBy de ${item.trend} + ${item.strength}`,
    regime.decidedBy.sol_trend === item.trend
      && regime.decidedBy.sol_relative_strength === item.strength
  );
}

const indeterminateTrend: TrendClassification[] = ['insufficient_data', 'unavailable'];
for (const value of indeterminateTrend) {
  const regime = deriveRegime(makeState(value, 'strong'));
  check(
    `sol_trend=${value} -> insufficient_data`,
    regime.regimeId === 'insufficient_data'
      && regime.description === 'Not enough data to describe the regime.'
      && regime.decidedBy.sol_trend === value
  );
}

const indeterminateStrength: StrengthClassification[] = ['insufficient_data', 'unavailable'];
for (const value of indeterminateStrength) {
  const regime = deriveRegime(makeState('bullish', value));
  check(
    `sol_relative_strength=${value} -> insufficient_data`,
    regime.regimeId === 'insufficient_data'
      && regime.description === 'Not enough data to describe the regime.'
      && regime.decidedBy.sol_relative_strength === value
  );
}

const contextA: Context = { spot: 'expanding', onchain_liquidity: 'expanding', launchpads: 'strong' };
const contextB: Context = { spot: 'contracting', onchain_liquidity: 'contracting', launchpads: 'unavailable' };

for (const item of TABLE) {
  const withA = deriveRegime(makeState(item.trend, item.strength, contextA));
  const withB = deriveRegime(makeState(item.trend, item.strength, contextB));
  check(
    `contexto não altera ${item.regimeId}`,
    withA.regimeId === item.regimeId && withB.regimeId === item.regimeId
  );
  check(
    `contexto é apenas lido em ${item.regimeId}`,
    withA.context.spot === 'expanding'
      && withA.context.onchain_liquidity === 'expanding'
      && withA.context.launchpads === 'strong'
      && withB.context.spot === 'contracting'
      && withB.context.onchain_liquidity === 'contracting'
      && withB.context.launchpads === 'unavailable'
  );
}

const versioned = deriveRegime(makeState('neutral', 'neutral'));
check(
  'regimeRulesVersion vem de REGIME_RULES_VERSION',
  versioned.regimeRulesVersion === REGIME_RULES_VERSION,
  `(${versioned.regimeRulesVersion})`
);
check('regimeRulesVersion é regime_rules_v1', versioned.regimeRulesVersion === 'regime_rules_v1');

const descriptions = new Set<string>([
  ...TABLE.map((item) => deriveRegime(makeState(item.trend, item.strength)).description),
  deriveRegime(makeState('insufficient_data', 'strong')).description,
]);
for (const description of descriptions) {
  const lower = description.toLowerCase();
  check(
    `description sem palavras proibidas: ${description}`,
    !lower.includes('good')
      && !lower.includes('bad')
      && !lower.includes('buy')
      && !lower.includes('sell')
      && !lower.includes('bullish signal')
      && !lower.includes('recommend')
  );
  check(`description sem números: ${description}`, !/[0-9]/.test(description));
}

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
