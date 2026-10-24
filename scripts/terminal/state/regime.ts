import { REGIME_RULES_VERSION } from '../config';
import type {
  FlowClassification,
  LaunchpadClassification,
  MarketState,
  StrengthClassification,
  TrendClassification,
} from './market-state';

export type RegimeId =
  | 'trend_up_confirmed'
  | 'trend_up_unconfirmed'
  | 'range_neutral'
  | 'trend_down_unconfirmed'
  | 'trend_down_confirmed'
  | 'weak_without_trend'
  | 'strong_without_trend'
  | 'conflicting'
  | 'insufficient_data';

export interface Regime {
  regimeId: RegimeId;
  regimeRulesVersion: string;
  description: string;
  decidedBy: {
    sol_trend: TrendClassification;
    sol_relative_strength: StrengthClassification;
  };
  context: {
    spot: FlowClassification;
    onchain_liquidity: FlowClassification;
    launchpads: LaunchpadClassification;
  };
}

export type MarketStateWithRegime = MarketState & { regime: Regime };

const REGIME_DESCRIPTIONS: Record<RegimeId, string> = {
  trend_up_confirmed: 'SOL trend is up and relative strength versus BTC and ETH is strong.',
  trend_up_unconfirmed: 'SOL trend is up while relative strength versus BTC and ETH is neutral.',
  range_neutral: 'SOL trend and relative strength versus BTC and ETH are both neutral.',
  trend_down_unconfirmed: 'SOL trend is down while relative strength versus BTC and ETH is neutral.',
  trend_down_confirmed: 'SOL trend is down and relative strength versus BTC and ETH is weak.',
  weak_without_trend: 'SOL trend is neutral while relative strength versus BTC and ETH is weak.',
  strong_without_trend: 'SOL trend is neutral while relative strength versus BTC and ETH is strong.',
  conflicting: 'SOL trend and relative strength versus BTC and ETH point in opposite directions.',
  insufficient_data: 'Not enough data to describe the regime.',
};

function decideRegime(trend: TrendClassification, strength: StrengthClassification): RegimeId {
  if (
    trend === 'insufficient_data'
    || trend === 'unavailable'
    || strength === 'insufficient_data'
    || strength === 'unavailable'
  ) {
    return 'insufficient_data';
  }

  switch (`${trend}|${strength}`) {
    case 'bullish|strong':
      return 'trend_up_confirmed';
    case 'bullish|neutral':
      return 'trend_up_unconfirmed';
    case 'neutral|neutral':
      return 'range_neutral';
    case 'bearish|neutral':
      return 'trend_down_unconfirmed';
    case 'bearish|weak':
      return 'trend_down_confirmed';
    case 'neutral|weak':
      return 'weak_without_trend';
    case 'neutral|strong':
      return 'strong_without_trend';
    case 'bearish|strong':
    case 'bullish|weak':
      return 'conflicting';
    default:
      return 'insufficient_data';
  }
}

export function deriveRegime(state: MarketState): Regime {
  const trend = state.sol_trend.classification;
  const strength = state.sol_relative_strength.classification;
  const regimeId = decideRegime(trend, strength);

  return {
    regimeId,
    regimeRulesVersion: REGIME_RULES_VERSION,
    description: REGIME_DESCRIPTIONS[regimeId],
    decidedBy: {
      sol_trend: trend,
      sol_relative_strength: strength,
    },
    context: {
      spot: state.spot.classification,
      onchain_liquidity: state.onchain_liquidity.classification,
      launchpads: state.launchpads.classification,
    },
  };
}
