import {
  DEFILLAMA_BASE_URL,
  DEFILLAMA_STABLECOINS_BASE_URL,
  DEFILLAMA_TVL_ENDPOINT,
  DEFILLAMA_STABLECOIN_ENDPOINT,
  DEFILLAMA_DEX_ENDPOINT,
  BACKFILL_DEX_CHART_KEY,
  BACKFILL_DEX_METRIC_NAME,
  BACKFILL_DEX_DAILY_QUARANTINE_DAYS,
  REQUEST_TIMEOUT_MS,
  type BackfillMetricPoint,
} from '../config';

export class HttpError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

async function fetchWithRetry(url: string): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' };
  for (let attempt = 0; attempt <= 1; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

function isClosedDay(tsMs: number, todayStartMs: number): boolean {
  return tsMs < todayStartMs;
}

export function filterAndValidateTvlPoints(
  rawPoints: { date: number; tvl: number }[],
  todayStartMs: number
): { valid: BackfillMetricPoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> } {
  const valid: BackfillMetricPoint[] = [];
  let ignored = 0;
  let invalid = 0;
  const ignoredReasons: Record<string, number> = {};

  const addIgnored = (reason: string) => { ignored++; ignoredReasons[reason] = (ignoredReasons[reason] || 0) + 1; };
  const addInvalid = () => { invalid++; };

  for (const p of rawPoints) {
    const tsMs = p.date * 1000;
    if (!isClosedDay(tsMs, todayStartMs)) {
      addIgnored('not_closed_day');
      continue;
    }
    if (typeof p.tvl !== 'number' || !Number.isFinite(p.tvl) || p.tvl <= 0) {
      addInvalid();
      continue;
    }
    const collectedAt = new Date(tsMs);
    const sourceTs = new Date(tsMs);
    valid.push({ metric: 'tvl_usd', value: p.tvl, collectedAt, sourceTs });
  }

  return { valid, ignored, invalid, ignoredReasons };
}

export function filterAndValidateStablecoinPoints(
  rawPoints: { date: string | number; totalCirculatingUSD: { peggedUSD: number } }[],
  todayStartMs: number
): { valid: BackfillMetricPoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> } {
  const valid: BackfillMetricPoint[] = [];
  let ignored = 0;
  let invalid = 0;
  const ignoredReasons: Record<string, number> = {};

  const addIgnored = (reason: string) => { ignored++; ignoredReasons[reason] = (ignoredReasons[reason] || 0) + 1; };
  const addInvalid = () => { invalid++; };

  for (const p of rawPoints) {
    const dateNum = typeof p.date === 'string' ? parseInt(p.date, 10) : p.date;
    if (!Number.isFinite(dateNum)) {
      addInvalid();
      continue;
    }
    const tsMs = dateNum * 1000;
    if (!isClosedDay(tsMs, todayStartMs)) {
      addIgnored('not_closed_day');
      continue;
    }
    const supply = p.totalCirculatingUSD?.peggedUSD;
    if (typeof supply !== 'number' || !Number.isFinite(supply) || supply <= 0) {
      addInvalid();
      continue;
    }
    const collectedAt = new Date(tsMs);
    const sourceTs = new Date(tsMs);
    valid.push({ metric: 'stablecoin_supply_usd', value: supply, collectedAt, sourceTs });
  }

  return { valid, ignored, invalid, ignoredReasons };
}

export function filterAndValidateDexVolumePoints(
  rawPoints: [number, number][],
  todayStartMs: number
): { valid: BackfillMetricPoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> } {
  const valid: BackfillMetricPoint[] = [];
  let ignored = 0;
  let invalid = 0;
  const ignoredReasons: Record<string, number> = {};

  const addIgnored = (reason: string) => { ignored++; ignoredReasons[reason] = (ignoredReasons[reason] || 0) + 1; };
  const addInvalid = () => { invalid++; };

  const quarantineStartMs = todayStartMs - BACKFILL_DEX_DAILY_QUARANTINE_DAYS * 86400000;

  for (const [tsSec, volume] of rawPoints) {
    const tsMs = tsSec * 1000;
    if (!isClosedDay(tsMs, todayStartMs)) {
      addIgnored('not_closed_day');
      continue;
    }
    if (tsMs >= quarantineStartMs) {
      addIgnored('quarantine_recent_days');
      continue;
    }
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) {
      addInvalid();
      continue;
    }
    const collectedAt = new Date(tsMs);
    const sourceTs = new Date(tsMs);
    valid.push({ metric: BACKFILL_DEX_METRIC_NAME, value: volume, collectedAt, sourceTs });
  }

  return { valid, ignored, invalid, ignoredReasons };
}

export async function fetchDefiLlamaTvl(): Promise<{ date: number; tvl: number }[]> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_TVL_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  if (!Array.isArray(data)) throw new Error('Resposta inesperada de historicalChainTvl: não é array');
  return data;
}

export async function fetchDefiLlamaStablecoins(): Promise<{ date: string | number; totalCirculatingUSD: { peggedUSD: number } }[]> {
  const url = `${DEFILLAMA_STABLECOINS_BASE_URL}${DEFILLAMA_STABLECOIN_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  if (!Array.isArray(data)) throw new Error('Resposta inesperada de stablecoincharts: não é array');
  return data;
}

export async function fetchDefiLlamaDexVolume(): Promise<[number, number][]> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_DEX_ENDPOINT}`;
  const data = await fetchWithRetry(url);
  const chart = data[BACKFILL_DEX_CHART_KEY];
  if (!Array.isArray(chart)) throw new Error(`Resposta inesperada de overview/dexs/Solana: ${BACKFILL_DEX_CHART_KEY} não é array`);
  return chart;
}