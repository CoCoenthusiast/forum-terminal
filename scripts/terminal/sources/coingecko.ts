import {
  BASE_URL,
  MARKETS_ENDPOINT,
  GLOBAL_ENDPOINT,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAY_BASE_MS,
  type CoinGeckoMarket,
  type CoinGeckoGlobalResponse,
} from '../config';

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export async function fetchWithRetry(url: string): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  if (demoKey) headers['x-cg-demo-api-key'] = demoKey;

  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
      return res.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof HttpError && (e.status === 429 || e.status >= 500) && attempt < 1) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw e;
    }
  }
}

export async function fetchMarkets(): Promise<any[]> {
  const url = `${BASE_URL}/coins/markets?vs_currency=usd&ids=solana,bitcoin,ethereum&order=market_cap_desc&per_page=3&page=1`;
  const data = await fetchWithRetry(url);
  if (!Array.isArray(data)) throw new Error('Resposta inesperada de /coins/markets: não é array');
  return data;
}

export async function fetchGlobal(): Promise<any> {
  const url = `${BASE_URL}/global`;
  const data = await fetchWithRetry(url);
  return data;
}