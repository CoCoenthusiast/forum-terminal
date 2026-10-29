export const COINALYZE_PROVIDER = 'coinalyze';
export const COINALYZE_DISPLAY_NAME = 'Coinalyze';
export const COINALYZE_BASE_URL = 'https://api.coinalyze.net/v1';
export const COINALYZE_API_KEY_ENV = 'COINALYZE_API_KEY';
export const COINALYZE_CREDIT_LINE = 'Data: Coinalyze (https://coinalyze.net)';
export const COINALYZE_AVAILABILITY_RULE_VERSION = 'coinalyze_availability_v1';
export const COINALYZE_HISTORY_START_DATE = '2025-01-01';
export const COINALYZE_DEFAULT_LOOKBACK_DAYS = 5;
export const COINALYZE_BACKFILL_BLOCK_DAYS = 180;
export const COINALYZE_REQUEST_PAUSE_MS = 2_000;
export const COINALYZE_REQUEST_TIMEOUT_MS = 15_000;
export const COINALYZE_BODY_PREVIEW_CHARS = 200;
export const COINALYZE_INSERT_BATCH_SIZE = 500;

export const COINALYZE_ASSETS = ['sol', 'btc', 'eth'] as const;
export type CoinalyzeAsset = (typeof COINALYZE_ASSETS)[number];

export const COINALYZE_SYMBOLS: Record<CoinalyzeAsset, string> = {
  sol: 'SOLUSDT_PERP.A',
  btc: 'BTCUSDT_PERP.A',
  eth: 'ETHUSDT_PERP.A',
};

export const COINALYZE_ENDPOINTS = {
  open_interest: '/open-interest-history',
  funding_rate: '/funding-rate-history',
  liquidation: '/liquidation-history',
  long_short_ratio: '/long-short-ratio-history',
} as const;

export type CoinalyzeEndpoint = keyof typeof COINALYZE_ENDPOINTS;

export type CoinalyzeUnit = 'USD' | 'PERCENT' | 'RATIO';

export interface CoinalyzeSeriesDefinition {
  seriesId: string;
  asset: CoinalyzeAsset;
  endpoint: CoinalyzeEndpoint;
  field: string;
  unit: CoinalyzeUnit;
  label: string;
}

const SERIES_BY_ASSET: Record<CoinalyzeAsset, readonly Omit<CoinalyzeSeriesDefinition, 'asset'>[]> = {
  sol: [
    { seriesId: 'coinalyze_sol_oi_usd_close', endpoint: 'open_interest', field: 'c', unit: 'USD', label: 'SOL open interest close USD' },
    { seriesId: 'coinalyze_sol_funding_rate_close_pct', endpoint: 'funding_rate', field: 'c', unit: 'PERCENT', label: 'SOL funding rate close percent' },
    { seriesId: 'coinalyze_sol_liq_long_usd', endpoint: 'liquidation', field: 'l', unit: 'USD', label: 'SOL long liquidations USD' },
    { seriesId: 'coinalyze_sol_liq_short_usd', endpoint: 'liquidation', field: 's', unit: 'USD', label: 'SOL short liquidations USD' },
    { seriesId: 'coinalyze_sol_long_short_ratio', endpoint: 'long_short_ratio', field: 'r', unit: 'RATIO', label: 'SOL long short ratio' },
    { seriesId: 'coinalyze_sol_long_account_pct', endpoint: 'long_short_ratio', field: 'l', unit: 'PERCENT', label: 'SOL long account percent' },
  ],
  btc: [
    { seriesId: 'coinalyze_btc_oi_usd_close', endpoint: 'open_interest', field: 'c', unit: 'USD', label: 'BTC open interest close USD' },
    { seriesId: 'coinalyze_btc_funding_rate_close_pct', endpoint: 'funding_rate', field: 'c', unit: 'PERCENT', label: 'BTC funding rate close percent' },
    { seriesId: 'coinalyze_btc_liq_long_usd', endpoint: 'liquidation', field: 'l', unit: 'USD', label: 'BTC long liquidations USD' },
    { seriesId: 'coinalyze_btc_liq_short_usd', endpoint: 'liquidation', field: 's', unit: 'USD', label: 'BTC short liquidations USD' },
    { seriesId: 'coinalyze_btc_long_short_ratio', endpoint: 'long_short_ratio', field: 'r', unit: 'RATIO', label: 'BTC long short ratio' },
    { seriesId: 'coinalyze_btc_long_account_pct', endpoint: 'long_short_ratio', field: 'l', unit: 'PERCENT', label: 'BTC long account percent' },
  ],
  eth: [
    { seriesId: 'coinalyze_eth_oi_usd_close', endpoint: 'open_interest', field: 'c', unit: 'USD', label: 'ETH open interest close USD' },
    { seriesId: 'coinalyze_eth_funding_rate_close_pct', endpoint: 'funding_rate', field: 'c', unit: 'PERCENT', label: 'ETH funding rate close percent' },
    { seriesId: 'coinalyze_eth_liq_long_usd', endpoint: 'liquidation', field: 'l', unit: 'USD', label: 'ETH long liquidations USD' },
    { seriesId: 'coinalyze_eth_liq_short_usd', endpoint: 'liquidation', field: 's', unit: 'USD', label: 'ETH short liquidations USD' },
    { seriesId: 'coinalyze_eth_long_short_ratio', endpoint: 'long_short_ratio', field: 'r', unit: 'RATIO', label: 'ETH long short ratio' },
    { seriesId: 'coinalyze_eth_long_account_pct', endpoint: 'long_short_ratio', field: 'l', unit: 'PERCENT', label: 'ETH long account percent' },
  ],
};

export const COINALYZE_SERIES: readonly CoinalyzeSeriesDefinition[] = COINALYZE_ASSETS.flatMap(
  (asset) =>
    SERIES_BY_ASSET[asset].map((definition) => ({
      ...definition,
      asset,
    }))
);

export function isCoinalyzeAsset(value: string): value is CoinalyzeAsset {
  return (COINALYZE_ASSETS as readonly string[]).includes(value);
}

export function coinalyzeSeriesForAsset(
  asset: CoinalyzeAsset
): readonly CoinalyzeSeriesDefinition[] {
  return COINALYZE_SERIES.filter((definition) => definition.asset === asset);
}

export function coinalyzeSeriesForEndpoint(
  asset: CoinalyzeAsset,
  endpoint: CoinalyzeEndpoint
): readonly CoinalyzeSeriesDefinition[] {
  return COINALYZE_SERIES.filter(
    (definition) => definition.asset === asset && definition.endpoint === endpoint
  );
}

export function coinalyzeEstimatePublishedAt(refDate: Date): Date {
  return new Date(
    Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth(),
      refDate.getUTCDate() + 1,
      0,
      30,
      0
    )
  );
}
