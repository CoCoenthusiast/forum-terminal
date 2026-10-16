import { Decimal } from './prisma-types';

export interface CoinGeckoMarket {
  id: string;
  current_price: number | null;
  price_change_percentage_24h: number | null;
  total_volume: number | null;
  market_cap: number | null;
  last_updated: string;
}

export interface CoinGeckoGlobalResponse {
  data: {
    market_cap_percentage: { btc: number };
    total_market_cap: { usd: number };
    updated_at: number;
  };
}

export const ASSETS = ['solana', 'bitcoin', 'ethereum'] as const;
export type Asset = typeof ASSETS[number];

export const MARKETS_ENDPOINT = '/coins/markets?vs_currency=usd&ids=solana,bitcoin,ethereum&order=market_cap_desc&per_page=3&page=1';
export const GLOBAL_ENDPOINT = '/global';
export const BASE_URL = 'https://api.coingecko.com/api/v3';
export const BACKFILL_CG_BASE_URL = 'https://api.coingecko.com/api/v3';
export const REQUEST_TIMEOUT_MS = 10000;
export const MAX_RETRIES = 1;
export const RETRY_DELAY_BASE_MS = 2000;
export const ERROR_MESSAGE_MAX_LENGTH = 300;
export const CALC_METHOD = 'last_in_60m_window_v1';
export const CALC_VERSION = 1;
export const HISTORY_CALC_METHOD = 'daily_close_from_history_v1';
export const HISTORY_CALC_VERSION = 1;
export const DAILY_CLOSE_WINDOW_MINUTES = 60;
export const DAILY_CLOSE_LOOKBACK_DAYS = 7;

export function checkEnvironment(): void {
  const dbUrl = process.env.TERMINAL_DATABASE_URL;
  if (!dbUrl) {
    console.error('[ABORT] TERMINAL_DATABASE_URL não definida');
    process.exit(1);
  }
  try {
    const u = new URL(dbUrl);
    const masked = `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`;
    console.log(`[ENV] DB: ${masked}`);
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
    const isAllowedRemote = process.env.GITHUB_ACTIONS === 'true' || process.env.TERMINAL_ALLOW_REMOTE === '1';
    if (!isLocal && !isAllowedRemote) {
      console.error('[ABORT] Banco remoto não permitido sem GITHUB_ACTIONS=true ou TERMINAL_ALLOW_REMOTE=1');
      process.exit(1);
    }
  } catch {
    console.error('[ABORT] TERMINAL_DATABASE_URL inválida');
    process.exit(1);
  }
}

export function toDecimal(value: number | null | undefined): Decimal | null {
  if (value === null || value === undefined) return null;
  return new Decimal(String(value));
}

export const DEFILLAMA_BASE_URL = 'https://api.llama.fi';
export const DEFILLAMA_STABLECOINS_BASE_URL = 'https://stablecoins.llama.fi';
export const DEFILLAMA_TVL_ENDPOINT = '/v2/historicalChainTvl/Solana';
export const DEFILLAMA_STABLECOIN_ENDPOINT = '/stablecoincharts/Solana';
export const DEFILLAMA_DEX_ENDPOINT = '/overview/dexs/Solana';

export interface DefiLlamaTvlResponse {
  date: number;
  tvl: number;
}

export interface DefiLlamaStablecoinResponse {
  date: string | number;
  totalCirculatingUSD: { peggedUSD: number };
}

export const DEFILLAMA_FEES_ENDPOINT = '/overview/fees/Solana';

export const DEFILLAMA_DEX_PROTOCOL_SLUGS = [
  'pump.fun',
  'pumpswap',
  'pump.fun-mobile-app',
  'raydium-amm',
  'meteora-dlmm',
  'meteora-damm-v2',
  'meteora-dynamic-bonding-curve',
  'meteora-damm-v1',
  'orca-dex',
  'moonshot.money',
  'bonkbot',
  'launchlab',
  'stonkfun',
  'fomo-wallet',
] as const;

export const DEFILLAMA_FEES_PROTOCOL_SLUGS = [
  'pump.fun',
  'pumpswap',
  'pump.fun-mobile-app',
  'raydium-amm',
  'meteora-dlmm',
  'meteora-damm-v2',
  'meteora-dynamic-bonding-curve',
  'meteora-damm-v1',
  'orca-dex',
  'moonshot.money',
  'bonkbot',
  'bonk.fun-launchpad',
  'moonshot-create',
  'jupiter-studio',
  'launchlab',
  'stonkfun',
  'fomo-wallet',
  'bags',
] as const;

export interface DefiLlamaProtocolResponse {
  slug: string;
  name: string;
  total24h: number | null;
}

export const QUALITY_EXPECTED_INTERVAL_MIN = { coingecko: 60, defillama: 60 } as const;
export const QUALITY_STALE_AFTER_FACTOR = 3;
export const QUALITY_DAILY_METRICS = ['tvl_usd', 'stablecoin_supply_usd'] as const;
export const QUALITY_DAILY_MAX_SOURCE_LAG_HOURS = 36;
export const QUALITY_JUMP_THRESHOLDS = { price: 0.30, tvl_usd: 0.30, stablecoin_supply_usd: 0.20, volumeRatio: 5 } as const;
export const QUALITY_FAILED_LAST_N = 3;
export const QUALITY_HISTORICAL_SOURCE_SUFFIX = '_history';

export interface QualityLogOperationMapEntry {
  source: string;
  metric: string;
  scopeExact?: string;
  scopePrefix?: string;
  operation: string;
}

export const QUALITY_LOG_OPERATION_MAP: QualityLogOperationMapEntry[] = [
  { source: 'defillama', metric: 'tvl_usd', operation: 'fetch_tvl' },
  { source: 'defillama', metric: 'stablecoin_supply_usd', operation: 'fetch_stablecoin' },
  { source: 'defillama', metric: 'dex_volume_24h_usd', scopeExact: 'solana', operation: 'fetch_dex_volume' },
  { source: 'defillama', metric: 'dex_volume_24h_usd', scopePrefix: 'solana:protocol:', operation: 'fetch_protocols_dex' },
  { source: 'defillama', metric: 'fees_24h_usd', scopePrefix: 'solana:protocol:', operation: 'fetch_protocols_fees' },
  { source: 'coingecko', metric: 'price', operation: 'fetch_price' },
  { source: 'coingecko', metric: 'btc_dominance_pct', scopePrefix: 'global', operation: 'fetch_global' },
  { source: 'coingecko', metric: 'global_market_cap_usd', scopePrefix: 'global', operation: 'fetch_global' },
] as const;

export const BACKFILL_CG_DAYS = 365;
export const DAILY_CLOSE_BACKFILL_CG_DAYS = 3;
export const BACKFILL_CG_INTERVAL = 'daily';
export const BACKFILL_CG_ASSETS = ['solana', 'bitcoin', 'ethereum'] as const;
export const BACKFILL_CG_PAUSE_MS = 3000;
export const BACKFILL_CG_MAX_RETRIES = 1;
export const BACKFILL_DEX_METRIC_NAME = 'dex_volume_daily_usd';
export const BACKFILL_DEX_CHART_KEY = 'totalDataChart';
export const BACKFILL_DEX_DAILY_QUARANTINE_DAYS = 2; // os últimos dias da série de volume DEX são revistos pela fonte; skipDuplicates não corrige valores já gravados

export interface BackfillPricePoint {
  asset: string;
  priceUsd: number;
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  collectedAt: Date;
  sourceTs: Date;
}
export interface BackfillMetricPoint {
  metric: string;
  value: number;
  collectedAt: Date;
  sourceTs: Date;
}
export interface BackfillSeriesResult {
  name: string;
  received: number;
  ignored: number;
  invalid: number;
  inserted: number;
  firstDate: string | null;
  lastDate: string | null;
  ignoredReasons: Record<string, number>;
}