import { Decimal } from '../prisma-types';
import {
  coinalyzeFunding7dMean,
  coinalyzeLiqLongSharePct,
  coinalyzeLiqTotalVsMean7dPct,
  coinalyzeLongShortRatio7dMean,
  coinalyzeOiUsdChange1dPct,
  coinalyzeOiUsdChange7dPct,
  type CoinalyzeAsOf,
  type CoinalyzeDailySeries,
} from './coinalyze-leverage-formulas';

export const COINALYZE_LEVERAGE_FORMULA_VERSION = 'coinalyze_leverage_v1';

export const COINALYZE_LEVERAGE_COINS = ['SOL', 'BTC', 'ETH'] as const;
export type CoinalyzeLeverageCoin = (typeof COINALYZE_LEVERAGE_COINS)[number];

export const COINALYZE_LEVERAGE_SCOPE_PREFIX = 'coinalyze:';

export const COINALYZE_LEVERAGE_SCOPES = COINALYZE_LEVERAGE_COINS.map(
  (coin) => `${COINALYZE_LEVERAGE_SCOPE_PREFIX}${coin}`
);

export const COINALYZE_LEVERAGE_INDICATOR_NAMES = [
  'oi_usd_change_1d_pct',
  'oi_usd_change_7d_pct',
  'funding_7d_mean',
  'long_short_ratio_7d_mean',
  'liq_total_vs_mean7d_pct',
  'liq_long_share_pct',
] as const;

export type CoinalyzeLeverageIndicatorName =
  (typeof COINALYZE_LEVERAGE_INDICATOR_NAMES)[number];

export interface CoinalyzeLeverageSeriesIds {
  oi: string;
  funding: string;
  longShortRatio: string;
  liqLong: string;
  liqShort: string;
}

export type CoinalyzeLeverageSeriesMap = Partial<
  Record<string, CoinalyzeDailySeries>
>;

export interface CoinalyzeLeverageIndicatorDefinition {
  indicator: CoinalyzeLeverageIndicatorName;
  coin: CoinalyzeLeverageCoin;
  scope: string;
  unit: string;
  formulaVersion: typeof COINALYZE_LEVERAGE_FORMULA_VERSION;
  seriesIds: readonly string[];
  compute: (
    series: CoinalyzeLeverageSeriesMap,
    asOf: CoinalyzeAsOf
  ) => Decimal | null;
}

export interface CoinalyzeLeverageIndicatorOutput {
  indicator: CoinalyzeLeverageIndicatorName;
  coin: CoinalyzeLeverageCoin;
  scope: string;
  unit: string;
  formulaVersion: typeof COINALYZE_LEVERAGE_FORMULA_VERSION;
  value: Decimal | null;
}

export function coinalyzeLeverageSeriesIds(
  coin: CoinalyzeLeverageCoin
): CoinalyzeLeverageSeriesIds {
  const asset = coin.toLowerCase();

  return {
    oi: `coinalyze_${asset}_oi_usd_close`,
    funding: `coinalyze_${asset}_funding_rate_close_pct`,
    longShortRatio: `coinalyze_${asset}_long_short_ratio`,
    liqLong: `coinalyze_${asset}_liq_long_usd`,
    liqShort: `coinalyze_${asset}_liq_short_usd`,
  };
}

function seriesFor(
  series: CoinalyzeLeverageSeriesMap,
  seriesId: string
): CoinalyzeDailySeries {
  return series[seriesId] ?? [];
}

export const COINALYZE_LEVERAGE_INDICATORS: CoinalyzeLeverageIndicatorDefinition[] =
  COINALYZE_LEVERAGE_COINS.flatMap((coin) => {
    const scope = `${COINALYZE_LEVERAGE_SCOPE_PREFIX}${coin}`;
    const ids = coinalyzeLeverageSeriesIds(coin);

    return [
      {
        indicator: 'oi_usd_change_1d_pct',
        coin,
        scope,
        unit: 'PERCENT',
        formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
        seriesIds: [ids.oi],
        compute: (series, asOf) =>
          coinalyzeOiUsdChange1dPct(seriesFor(series, ids.oi), asOf),
      },
      {
        indicator: 'oi_usd_change_7d_pct',
        coin,
        scope,
        unit: 'PERCENT',
        formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
        seriesIds: [ids.oi],
        compute: (series, asOf) =>
          coinalyzeOiUsdChange7dPct(seriesFor(series, ids.oi), asOf),
      },
      {
        indicator: 'funding_7d_mean',
        coin,
        scope,
        unit: 'PERCENT',
        formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
        seriesIds: [ids.funding],
        compute: (series, asOf) =>
          coinalyzeFunding7dMean(seriesFor(series, ids.funding), asOf),
      },
      {
        indicator: 'long_short_ratio_7d_mean',
        coin,
        scope,
        unit: 'RATIO',
        formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
        seriesIds: [ids.longShortRatio],
        compute: (series, asOf) =>
          coinalyzeLongShortRatio7dMean(
            seriesFor(series, ids.longShortRatio),
            asOf
          ),
      },
      {
        indicator: 'liq_total_vs_mean7d_pct',
        coin,
        scope,
        unit: 'PERCENT',
        formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
        seriesIds: [ids.liqLong, ids.liqShort],
        compute: (series, asOf) =>
          coinalyzeLiqTotalVsMean7dPct(
            seriesFor(series, ids.liqLong),
            seriesFor(series, ids.liqShort),
            asOf
          ),
      },
      {
        indicator: 'liq_long_share_pct',
        coin,
        scope,
        unit: 'PERCENT',
        formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
        seriesIds: [ids.liqLong, ids.liqShort],
        compute: (series, asOf) =>
          coinalyzeLiqLongSharePct(
            seriesFor(series, ids.liqLong),
            seriesFor(series, ids.liqShort),
            asOf
          ),
      },
    ];
  });

export function computeCoinalyzeLeverageIndicators(
  seriesByCoin: Record<CoinalyzeLeverageCoin, CoinalyzeLeverageSeriesMap>,
  asOf: CoinalyzeAsOf
): CoinalyzeLeverageIndicatorOutput[] {
  return COINALYZE_LEVERAGE_INDICATORS.map((definition) => ({
    indicator: definition.indicator,
    coin: definition.coin,
    scope: definition.scope,
    unit: definition.unit,
    formulaVersion: definition.formulaVersion,
    value: definition.compute(seriesByCoin[definition.coin], asOf),
  }));
}
