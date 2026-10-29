import {
  InvalidPayloadError,
  formatIsoDateUtc,
  startOfUtcDay,
  type FetchLike,
} from './macro-config';
import {
  COINALYZE_API_KEY_ENV,
  COINALYZE_BASE_URL,
  COINALYZE_BODY_PREVIEW_CHARS,
  COINALYZE_ENDPOINTS,
  COINALYZE_REQUEST_TIMEOUT_MS,
  COINALYZE_SYMBOLS,
  type CoinalyzeAsset,
  type CoinalyzeEndpoint,
} from './coinalyze-config';

export interface CoinalyzePoint {
  refDate: Date;
  values: Record<string, unknown>;
}

export interface CoinalyzeHistoryParseResult {
  points: CoinalyzePoint[];
  warnings: string[];
}

export interface CoinalyzeHttpResponse {
  status: number;
  ms: number;
  payload: unknown;
  bodyPreview: string;
  retryAfter: string | null;
}

interface HistoryEntry {
  history: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

function redact(text: string, apiKey: string): string {
  return apiKey === '' ? text : text.split(apiKey).join('[REDACTED]');
}

function preview(text: string, apiKey: string): string {
  return redact(text, apiKey).replace(/\s+/g, ' ').trim().slice(0, COINALYZE_BODY_PREVIEW_CHARS);
}

function unixSeconds(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) return null;

  return Math.abs(numeric) >= 1_000_000_000_000 ? Math.floor(numeric / 1000) : Math.floor(numeric);
}

function historyFromPayload(payload: unknown): unknown[] | null {
  if (isRecord(payload)) {
    return asArray(payload.history);
  }

  const entries = asArray(payload);
  if (entries === null) return null;

  for (const entry of entries) {
    if (isRecord(entry)) {
      const history = asArray(entry.history);
      if (history !== null) return history;
    }
  }

  return entries;
}

export function parseCoinalyzeHistory(
  payload: unknown,
  symbol: string
): CoinalyzeHistoryParseResult {
  const history = historyFromPayload(payload);

  if (history === null) {
    throw new InvalidPayloadError(`Coinalyze ${symbol}: resposta sem history`);
  }

  const points: CoinalyzePoint[] = [];
  const warnings: string[] = [];

  for (const entry of history) {
    if (!isRecord(entry)) {
      warnings.push(`${symbol}: ponto não objetivo ignorado`);
      continue;
    }

    const seconds = unixSeconds(entry.t);

    if (seconds === null) {
      warnings.push(`${symbol}: t inválido ignorado`);
      continue;
    }

    points.push({
      refDate: startOfUtcDay(new Date(seconds * 1000)),
      values: entry,
    });
  }

  return { points, warnings };
}

export function coinalyzeHistoryUrl(
  asset: CoinalyzeAsset,
  endpoint: CoinalyzeEndpoint,
  fromSeconds: number,
  toSeconds: number
): string {
  const params = new URLSearchParams({
    symbols: COINALYZE_SYMBOLS[asset],
    interval: 'daily',
    from: String(fromSeconds),
    to: String(toSeconds),
  });

  if (endpoint === 'open_interest' || endpoint === 'liquidation') {
    params.set('convert_to_usd', 'true');
  }

  return `${COINALYZE_BASE_URL}${COINALYZE_ENDPOINTS[endpoint]}?${params.toString()}`;
}

export async function requestCoinalyzeHistory(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<CoinalyzeHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COINALYZE_REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        api_key: apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const body = await response.text();
    let payload: unknown = null;

    try {
      payload = body.trim() === '' ? null : (JSON.parse(body.replace(/^\uFEFF/, '')) as unknown);
    } catch {
      payload = null;
    }

    return {
      status: response.status,
      ms: Date.now() - startedAt,
      payload,
      bodyPreview: preview(body, apiKey),
      retryAfter: response.headers.get('retry-after'),
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(
        `timeout após ${COINALYZE_REQUEST_TIMEOUT_MS} ms (${COINALYZE_API_KEY_ENV} não é registrada)`
      );
    }

    throw new Error(redact(error instanceof Error ? error.message : String(error), apiKey));
  } finally {
    clearTimeout(timer);
  }
}

export function warnMissingField(
  seriesId: string,
  refDate: Date,
  field: string
): string {
  return `${seriesId}: ${formatIsoDateUtc(refDate)} campo ${field} ausente/N/A`;
}
