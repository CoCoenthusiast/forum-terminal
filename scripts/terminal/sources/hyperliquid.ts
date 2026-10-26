export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const HYPERLIQUID_INFO_ENDPOINT = '/info';
export const HYPERLIQUID_REQUEST_TIMEOUT_MS = 15_000;
export const HYPERLIQUID_COINS = ['SOL', 'BTC', 'ETH'] as const;
export const HYPERLIQUID_FIELDS = [
  'funding',
  'openInterest',
  'markPx',
  'oraclePx',
  'premium',
  'dayNtlVlm',
] as const;

export type HyperliquidCoin = (typeof HYPERLIQUID_COINS)[number];
export type HyperliquidField = (typeof HYPERLIQUID_FIELDS)[number];

export type HyperliquidFieldValues = Record<HyperliquidField, string | null>;

export interface HyperliquidCoinData {
  coin: HyperliquidCoin;
  found: boolean;
  reason: string | null;
  fields: HyperliquidFieldValues;
  invalidFields: HyperliquidField[];
}

export interface HyperliquidPerpSnapshot {
  coins: HyperliquidCoinData[];
}

export class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HttpError';
  }
}

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function emptyFields(): HyperliquidFieldValues {
  return {
    funding: null,
    openInterest: null,
    markPx: null,
    oraclePx: null,
    premium: null,
    dayNtlVlm: null,
  };
}

export function toDecimalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed) ? trimmed : null;
}

export function parseHyperliquidPerpSnapshot(payload: unknown): HyperliquidPerpSnapshot {
  if (!Array.isArray(payload) || payload.length < 2) {
    throw new InvalidPayloadError('resposta inesperada: esperado [meta, assetCtxs]');
  }

  const meta = readRecord(payload[0]);
  const assetCtxs = payload[1];
  const universe = meta && Array.isArray(meta.universe) ? meta.universe : null;

  if (!universe || !Array.isArray(assetCtxs)) {
    throw new InvalidPayloadError('resposta inesperada: universe/assetCtxs ausentes');
  }

  const coins = HYPERLIQUID_COINS.map((coin): HyperliquidCoinData => {
    const fields = emptyFields();
    const index = universe.findIndex((entry) => readRecord(entry)?.name === coin);

    if (index < 0) {
      return {
        coin,
        found: false,
        reason: 'ausente em universe',
        fields,
        invalidFields: [],
      };
    }

    const context = readRecord(assetCtxs[index]);

    if (context === null) {
      return {
        coin,
        found: false,
        reason: 'assetCtxs ausente no índice da moeda',
        fields,
        invalidFields: [],
      };
    }

    const invalidFields: HyperliquidField[] = [];

    for (const field of HYPERLIQUID_FIELDS) {
      const value = toDecimalString(context[field]);

      if (value === null) {
        invalidFields.push(field);
      } else {
        fields[field] = value;
      }
    }

    return {
      coin,
      found: true,
      reason: null,
      fields,
      invalidFields,
    };
  });

  return { coins };
}

export async function fetchHyperliquidPerpSnapshot(
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
  timeoutMs = HYPERLIQUID_REQUEST_TIMEOUT_MS
): Promise<HyperliquidPerpSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(HYPERLIQUID_INFO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{"type":"metaAndAssetCtxs"}',
      signal: controller.signal,
    });

    if (response.status === 429) {
      throw new HttpError('HTTP 429', 429);
    }

    if (!response.ok) {
      throw new HttpError(`HTTP ${response.status}`, response.status);
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      throw new InvalidPayloadError('resposta da API não é JSON válido');
    }

    return parseHyperliquidPerpSnapshot(payload);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`timeout após ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
