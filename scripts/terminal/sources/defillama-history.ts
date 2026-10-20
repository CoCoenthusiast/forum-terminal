import {
  DEFILLAMA_BASE_URL,
  DEFILLAMA_STABLECOINS_BASE_URL,
  DEFILLAMA_TVL_ENDPOINT,
  DEFILLAMA_STABLECOIN_ENDPOINT,
  DEFILLAMA_DEX_ENDPOINT,
  DEFILLAMA_DEX_PROTOCOL_SUMMARY_PREFIX,
  DEFILLAMA_FEES_PROTOCOL_SUMMARY_PREFIX,
  DEFILLAMA_FEES_PROTOCOL_DATA_TYPE,
  BACKFILL_DEX_CHART_KEY,
  BACKFILL_DEX_METRIC_NAME,
  BACKFILL_DEX_DAILY_QUARANTINE_DAYS,
  BACKFILL_FEES_CHART_KEY,
  BACKFILL_FEES_METRIC_NAME,
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

function filterAndValidateDailyProtocolPoints(
  rawPoints: [number, number][],
  todayStartMs: number,
  metricName: string
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
    valid.push({ metric: metricName, value: volume, collectedAt, sourceTs });
  }

  return { valid, ignored, invalid, ignoredReasons };
}

export function filterAndValidateDexVolumePoints(
  rawPoints: [number, number][],
  todayStartMs: number
): { valid: BackfillMetricPoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> } {
  return filterAndValidateDailyProtocolPoints(rawPoints, todayStartMs, BACKFILL_DEX_METRIC_NAME);
}

export function filterAndValidateFeesPoints(
  rawPoints: [number, number][],
  todayStartMs: number
): { valid: BackfillMetricPoint[]; ignored: number; invalid: number; ignoredReasons: Record<string, number> } {
  return filterAndValidateDailyProtocolPoints(rawPoints, todayStartMs, BACKFILL_FEES_METRIC_NAME);
}

export interface ProtocolDateGapAnalysis {
  firstDate: string | null;
  lastDate: string | null;
  expectedDays: number;
  presentDays: number;
  missingDays: number;
  missingDates: string[];
  missingClosed: number;
  missingRecent: number;
  offMidnight: number;
}

export function analyzeProtocolDateGaps(
  rawPoints: [number, number][],
  todayStartMs: number,
  maxMissingDates = 20
): ProtocolDateGapAnalysis {
  const dayMs = 86400000;
  let offMidnight = 0;
  const days = new Set<number>();

  for (const [tsSec] of rawPoints) {
    if (tsSec % 86400 !== 0) offMidnight++;
    days.add(Math.floor((tsSec * 1000) / dayMs) * dayMs);
  }

  if (days.size === 0) {
    return { firstDate: null, lastDate: null, expectedDays: 0, presentDays: 0, missingDays: 0, missingDates: [], missingClosed: 0, missingRecent: 0, offMidnight };
  }

  const sorted = [...days].sort((a, b) => a - b);
  const firstDay = sorted[0];
  const lastDay = sorted[sorted.length - 1];
  const expectedDays = (lastDay - firstDay) / dayMs + 1;
  const presentDays = days.size;
  const missingDays = expectedDays - presentDays;
  const closedCutoff = todayStartMs - 3 * dayMs;
  let missingClosed = 0;
  let missingRecent = 0;
  const missingDates: string[] = [];

  for (let day = firstDay; day <= lastDay; day += dayMs) {
    if (days.has(day)) continue;
    if (day <= closedCutoff) missingClosed++;
    else missingRecent++;
    if (missingDates.length < maxMissingDates) {
      missingDates.push(new Date(day).toISOString().slice(0, 10));
    }
  }

  return {
    firstDate: new Date(firstDay).toISOString().slice(0, 10),
    lastDate: new Date(lastDay).toISOString().slice(0, 10),
    expectedDays,
    presentDays,
    missingDays,
    missingDates,
    missingClosed,
    missingRecent,
    offMidnight,
  };
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

export async function fetchDefiLlamaDexProtocolVolume(slug: string): Promise<[number, number][]> {
  const url = `${DEFILLAMA_BASE_URL}${DEFILLAMA_DEX_PROTOCOL_SUMMARY_PREFIX}${encodeURIComponent(slug)}`;
  const data = await fetchWithRetry(url);
  const chart = data[BACKFILL_DEX_CHART_KEY];
  if (!Array.isArray(chart)) throw new Error(`Resposta inesperada de summary/dexs/${slug}: ${BACKFILL_DEX_CHART_KEY} não é array`);
  return chart;
}

export function buildDefiLlamaFeesProtocolUrl(slug: string): string {
  return `${DEFILLAMA_BASE_URL}${DEFILLAMA_FEES_PROTOCOL_SUMMARY_PREFIX}${encodeURIComponent(slug)}?dataType=${DEFILLAMA_FEES_PROTOCOL_DATA_TYPE}`;
}

export async function fetchDefiLlamaFeesProtocolDaily(slug: string): Promise<[number, number][]> {
  const url = buildDefiLlamaFeesProtocolUrl(slug);
  const data = await fetchWithRetry(url);
  const chart = data[BACKFILL_FEES_CHART_KEY];
  if (!Array.isArray(chart)) throw new Error(`Resposta inesperada de summary/fees/${slug}?dataType=${DEFILLAMA_FEES_PROTOCOL_DATA_TYPE}: ${BACKFILL_FEES_CHART_KEY} não é array`);
  return chart;
}