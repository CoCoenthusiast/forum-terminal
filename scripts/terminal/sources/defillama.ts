import {
  DEFILLAMA_BASE_URL,
  DEFILLAMA_STABLECOINS_BASE_URL,
  DEFILLAMA_TVL_ENDPOINT,
  DEFILLAMA_STABLECOIN_ENDPOINT,
  DEFILLAMA_DEX_ENDPOINT,
  DEFILLAMA_FEES_ENDPOINT,
  DEFILLAMA_DEX_PROTOCOL_SLUGS,
  DEFILLAMA_FEES_PROTOCOL_SLUGS,
  REQUEST_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_DELAY_BASE_MS,
} from '../config';

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

async function fetchWithRetry(url: string): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new HttpError(`HTTP ${res.status}`, res.status);
      return res.json();
    } catch (e) {
      clearTimeout(timeout);
      if (e instanceof HttpError && (e.status === 429 || e.status >= 500) && attempt < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_BASE_MS * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

export async function fetchChainTvl(): Promise<{ date: number; tvl: number }> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_TVL_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Resposta inesperada de historicalChainTvl: lista vazia');
  const last = data[data.length - 1];
  if (typeof last.date !== 'number' || typeof last.tvl !== 'number') throw new Error('Campos date/tvl ausentes ou inválidos');
  return { date: last.date, tvl: last.tvl };
}

export async function fetchStablecoinSupply(): Promise<{ date: number; supply: number }> {
  const url = `${DEFILLAMA_STABLECOINS_BASE_URL}${DEFILLAMA_STABLECOIN_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  if (!Array.isArray(data) || data.length === 0) throw new Error('Resposta inesperada de stablecoincharts: lista vazia');
  const last = data[data.length - 1];
  const date = typeof last.date === 'string' ? parseInt(last.date, 10) : last.date;
  const supply = last.totalCirculatingUSD?.peggedUSD;
  if (!Number.isFinite(date) || typeof supply !== 'number' || !Number.isFinite(supply)) {
    throw new Error('Campos date/totalCirculatingUSD.peggedUSD ausentes ou inválidos');
  }
  return { date, supply };
}

export async function fetchDexVolume24h(): Promise<number> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_DEX_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  const volume = data.total24h;
  if (typeof volume !== 'number' || !Number.isFinite(volume) || volume <= 0) {
    throw new Error('Campo total24h ausente, inválido ou zero');
  }
  return volume;
}

export async function fetchDexProtocolsVolume24h(): Promise<Array<{ slug: string; total24h: number }>> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_DEX_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  const protocols = data.protocols;
  if (!Array.isArray(protocols)) throw new Error('Resposta inesperada de dexs/Solana: protocols não é array');
  const result: Array<{ slug: string; total24h: number }> = [];
  for (const slug of DEFILLAMA_DEX_PROTOCOL_SLUGS) {
    const p = protocols.find((x: any) => x.slug === slug);
    if (!p) {
      console.warn(`[fetchDexProtocolsVolume24h] slug não encontrado: ${slug}`);
      continue;
    }
    const total24h = p.total24h;
    if (typeof total24h !== 'number' || !Number.isFinite(total24h) || total24h < 0) {
      console.warn(`[fetchDexProtocolsVolume24h] total24h inválido para ${slug}: ${total24h}`);
      continue;
    }
    result.push({ slug, total24h });
  }
  return result;
}

export async function fetchFeesProtocols24h(): Promise<Array<{ slug: string; total24h: number }>> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_FEES_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  const protocols = data.protocols;
  if (!Array.isArray(protocols)) throw new Error('Resposta inesperada de fees/Solana: protocols não é array');
  const result: Array<{ slug: string; total24h: number }> = [];
  for (const slug of DEFILLAMA_FEES_PROTOCOL_SLUGS) {
    const p = protocols.find((x: any) => x.slug === slug);
    if (!p) {
      console.warn(`[fetchFeesProtocols24h] slug não encontrado: ${slug}`);
      continue;
    }
    const total24h = p.total24h;
    if (typeof total24h !== 'number' || !Number.isFinite(total24h) || total24h < 0) {
      console.warn(`[fetchFeesProtocols24h] total24h inválido para ${slug}: ${total24h}`);
      continue;
    }
    result.push({ slug, total24h });
  }
  return result;
}