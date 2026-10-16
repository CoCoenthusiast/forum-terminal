import {
  BACKFILL_CG_BASE_URL,
  BACKFILL_CG_DAYS,
  BACKFILL_CG_INTERVAL,
  BACKFILL_CG_ASSETS,
  BACKFILL_CG_PAUSE_MS,
  BACKFILL_CG_MAX_RETRIES,
  REQUEST_TIMEOUT_MS,
  type BackfillPricePoint,
} from '../config';

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

async function fetchWithRetry(url: string, headers: Record<string, string>): Promise<any> {
  for (let attempt = 0; attempt <= BACKFILL_CG_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
      return res.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof HttpError && (e.status === 429 || e.status >= 500) && attempt < BACKFILL_CG_MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

function isMidnightUtc(tsMs: number): boolean {
  return tsMs % 86400000 === 0;
}

function isClosedDay(tsMs: number, todayStartMs: number): boolean {
  return tsMs < todayStartMs;
}

export function filterAndValidatePricePoints(
  rawPoints: [number, number][],
  rawMarketCaps: [number, number][],
  rawVolumes: [number, number][],
  asset: string,
  todayStartMs: number
): { valid: BackfillPricePoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> } {
  const valid: BackfillPricePoint[] = [];
  let ignored = 0;
  let invalid = 0;
  const ignoredReasons: Record<string, number> = {};

  const addIgnored = (reason: string) => {
    ignored++;
    ignoredReasons[reason] = (ignoredReasons[reason] || 0) + 1;
  };
  const addInvalid = () => { invalid++; };

  const marketCapMap = new Map(rawMarketCaps.map(([ts, v]) => [ts, v]));
  const volumeMap = new Map(rawVolumes.map(([ts, v]) => [ts, v]));

  for (const [tsMs, price] of rawPoints) {
    if (!isMidnightUtc(tsMs)) {
      addIgnored('not_midnight_utc');
      continue;
    }
    if (!isClosedDay(tsMs, todayStartMs)) {
      addIgnored('not_closed_day');
      continue;
    }
    if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) {
      addInvalid();
      continue;
    }
    const collectedAt = new Date(tsMs);
    const sourceTs = new Date(tsMs);
    const mc = marketCapMap.get(tsMs);
    const vol = volumeMap.get(tsMs);
    const marketCapUsd = (mc !== undefined && mc !== null && Number.isFinite(mc) && mc >= 0) ? mc : null;
    const volume24hUsd = (vol !== undefined && vol !== null && Number.isFinite(vol) && vol >= 0) ? vol : null;
    valid.push({ asset, priceUsd: price, marketCapUsd, volume24hUsd, collectedAt, sourceTs });
  }

  return { valid, ignored, invalid, ignoredReasons };
}

export async function fetchCoinGeckoHistory(asset: string): Promise<{ prices: [number, number][]; market_caps: [number, number][]; total_volumes: [number, number][] }> {
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  if (demoKey) headers['x-cg-demo-api-key'] = demoKey;

  const url = `${BACKFILL_CG_BASE_URL}/coins/${asset}/market_chart?vs_currency=usd&days=${BACKFILL_CG_DAYS}&interval=${BACKFILL_CG_INTERVAL}`;
  const data = await fetchWithRetry(url, headers);
  if (!data || !Array.isArray(data.prices) || !Array.isArray(data.market_caps) || !Array.isArray(data.total_volumes)) {
    throw new Error(`Resposta inesperada para ${asset}: estrutura inválida`);
  }
  return { prices: data.prices, market_caps: data.market_caps, total_volumes: data.total_volumes };
}