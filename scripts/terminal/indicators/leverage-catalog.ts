import {
  leverageFunding7dMean,
  leverageFundingDailySum,
  leverageOiUsdChange24hPct,
  leverageOiUsdChange7dPct,
  leverageOiUsdClose,
  leveragePremiumDailyMean,
  type LeverageHourlyData,
  type LeverageIndicatorResult,
} from './leverage-formulas';

// Hipótese, versionada: primeira geração persistida dos indicadores de leverage.
export const LEVERAGE_FORMULA_VERSION = 'leverage_v1';

export const LEVERAGE_COINS = ['SOL', 'BTC', 'ETH'] as const;
export type LeverageCoin = (typeof LEVERAGE_COINS)[number];

export const LEVERAGE_SCOPE_PREFIX = 'hyperliquid:perp:';

export const LEVERAGE_SCOPES = LEVERAGE_COINS.map(
  (coin) => `${LEVERAGE_SCOPE_PREFIX}${coin}`
);

export const LEVERAGE_METRICS = [
  'perp_open_interest_coin',
  'perp_mark_price_usd',
  'perp_funding_rate_1h',
  'perp_premium',
] as const;

export const LEVERAGE_INDICATOR_NAMES = [
  'leverage_oi_usd_close',
  'leverage_oi_usd_change_24h_pct',
  'leverage_oi_usd_change_7d_pct',
  'leverage_funding_daily_sum',
  'leverage_funding_7d_mean',
  'leverage_premium_daily_mean',
] as const;

export type LeverageIndicatorName = (typeof LEVERAGE_INDICATOR_NAMES)[number];

export interface LeverageIndicatorDefinition {
  indicator: LeverageIndicatorName;
  coin: LeverageCoin;
  scope: string;
  unit: string;
  compute: (data: LeverageHourlyData, asOf: string) => LeverageIndicatorResult;
}

export const LEVERAGE_INDICATORS: LeverageIndicatorDefinition[] = LEVERAGE_COINS.flatMap(
  (coin) => {
    const scope = `${LEVERAGE_SCOPE_PREFIX}${coin}`;
    return [
      {
        indicator: 'leverage_oi_usd_close',
        coin,
        scope,
        unit: 'USD',
        compute: leverageOiUsdClose,
      },
      {
        indicator: 'leverage_oi_usd_change_24h_pct',
        coin,
        scope,
        unit: 'PERCENT',
        compute: leverageOiUsdChange24hPct,
      },
      {
        indicator: 'leverage_oi_usd_change_7d_pct',
        coin,
        scope,
        unit: 'PERCENT',
        compute: leverageOiUsdChange7dPct,
      },
      {
        indicator: 'leverage_funding_daily_sum',
        coin,
        scope,
        unit: 'FRACTION',
        compute: leverageFundingDailySum,
      },
      {
        indicator: 'leverage_funding_7d_mean',
        coin,
        scope,
        unit: 'FRACTION',
        compute: leverageFunding7dMean,
      },
      {
        indicator: 'leverage_premium_daily_mean',
        coin,
        scope,
        unit: 'FRACTION',
        compute: leveragePremiumDailyMean,
      },
    ];
  }
);

export interface LeverageIndicatorOutput {
  indicator: LeverageIndicatorName;
  coin: LeverageCoin;
  scope: string;
  unit: string;
  result: LeverageIndicatorResult;
}

export function computeLeverageIndicators(
  dataByCoin: Record<LeverageCoin, LeverageHourlyData>,
  asOf: string
): LeverageIndicatorOutput[] {
  return LEVERAGE_INDICATORS.map((definition) => ({
    indicator: definition.indicator,
    coin: definition.coin,
    scope: definition.scope,
    unit: definition.unit,
    result: definition.compute(dataByCoin[definition.coin], asOf),
  }));
}
