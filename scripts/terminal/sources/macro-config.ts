export const MACRO_AVAILABILITY_RULES_VERSION = 'macro_availability_v2';
export const MACRO_DEFAULT_LOOKBACK_DAYS = 10;
export const MACRO_REQUEST_TIMEOUT_MS = 15_000;
export const MACRO_REQUEST_PAUSE_MS = 3_000;

export type MacroSource = 'treasury' | 'nyfed' | 'ecb' | 'fed' | 'bls';
export type MacroUnit =
  | 'PERCENT'
  | 'USD_PER_EUR'
  | 'INDEX_1973_100'
  | 'INDEX'
  | 'THOUSANDS';
export type TreasuryCurve = 'nominal' | 'real';
export type NyfedRateType = 'sofr' | 'effr';

export interface MacroSourceInfo {
  provider: MacroSource;
  displayName: string;
  baseUrl: string;
}

export const MACRO_SOURCE_INFO: Record<MacroSource, MacroSourceInfo> = {
  treasury: {
    provider: 'treasury',
    displayName: 'U.S. Department of the Treasury',
    baseUrl: 'https://home.treasury.gov',
  },
  nyfed: {
    provider: 'nyfed',
    displayName: 'Federal Reserve Bank of New York',
    baseUrl: 'https://markets.newyorkfed.org',
  },
  ecb: {
    provider: 'ecb',
    displayName: 'European Central Bank',
    baseUrl: 'https://data-api.ecb.europa.eu',
  },
  fed: {
    provider: 'fed',
    displayName: 'Federal Reserve Board H.10',
    baseUrl: 'https://www.federalreserve.gov',
  },
  bls: {
    provider: 'bls',
    displayName: 'U.S. Bureau of Labor Statistics',
    baseUrl: 'https://api.bls.gov',
  },
};

export const MACRO_SOURCES: readonly MacroSource[] = [
  'treasury',
  'nyfed',
  'ecb',
  'fed',
  'bls',
];

interface MacroSeriesBase {
  seriesId: string;
  source: MacroSource;
  unit: MacroUnit;
  label: string;
}

export interface TreasurySeriesDefinition extends MacroSeriesBase {
  source: 'treasury';
  curve: TreasuryCurve;
  column: string;
}

export interface NyfedSeriesDefinition extends MacroSeriesBase {
  source: 'nyfed';
  rateType: NyfedRateType;
}

export interface EcbSeriesDefinition extends MacroSeriesBase {
  source: 'ecb';
}

export interface FedSeriesDefinition extends MacroSeriesBase {
  source: 'fed';
}

export interface BlsSeriesDefinition extends MacroSeriesBase {
  source: 'bls';
  apiSeriesId: string;
}

export type MacroSeriesDefinition =
  | TreasurySeriesDefinition
  | NyfedSeriesDefinition
  | EcbSeriesDefinition
  | FedSeriesDefinition
  | BlsSeriesDefinition;

export const MACRO_SERIES: readonly MacroSeriesDefinition[] = [
  {
    seriesId: 'ust_nominal_3m',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury nominal 3-month',
    curve: 'nominal',
    column: '3 Mo',
  },
  {
    seriesId: 'ust_nominal_2y',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury nominal 2-year',
    curve: 'nominal',
    column: '2 Yr',
  },
  {
    seriesId: 'ust_nominal_5y',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury nominal 5-year',
    curve: 'nominal',
    column: '5 Yr',
  },
  {
    seriesId: 'ust_nominal_10y',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury nominal 10-year',
    curve: 'nominal',
    column: '10 Yr',
  },
  {
    seriesId: 'ust_nominal_30y',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury nominal 30-year',
    curve: 'nominal',
    column: '30 Yr',
  },
  {
    seriesId: 'ust_real_5y',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury real 5-year',
    curve: 'real',
    column: '5 YR',
  },
  {
    seriesId: 'ust_real_10y',
    source: 'treasury',
    unit: 'PERCENT',
    label: 'Treasury real 10-year',
    curve: 'real',
    column: '10 YR',
  },
  {
    seriesId: 'sofr',
    source: 'nyfed',
    unit: 'PERCENT',
    label: 'Secured Overnight Financing Rate',
    rateType: 'sofr',
  },
  {
    seriesId: 'effr',
    source: 'nyfed',
    unit: 'PERCENT',
    label: 'Effective Federal Funds Rate',
    rateType: 'effr',
  },
  {
    seriesId: 'ecb_eurusd',
    source: 'ecb',
    unit: 'USD_PER_EUR',
    label: 'ECB EUR/USD reference rate',
  },
  {
    seriesId: 'fed_broad_dollar',
    source: 'fed',
    unit: 'INDEX_1973_100',
    label: 'Fed H.10 Nominal Broad Dollar Index',
  },
  {
    seriesId: 'bls_cpi_u_sa',
    source: 'bls',
    unit: 'INDEX',
    label: 'BLS CPI-U seasonally adjusted',
    apiSeriesId: 'CUSR0000SA0',
  },
  {
    seriesId: 'bls_core_cpi_sa',
    source: 'bls',
    unit: 'INDEX',
    label: 'BLS core CPI seasonally adjusted',
    apiSeriesId: 'CUSR0000SA0L1E',
  },
  {
    seriesId: 'bls_unemployment_rate',
    source: 'bls',
    unit: 'PERCENT',
    label: 'BLS unemployment rate',
    apiSeriesId: 'LNS14000000',
  },
  {
    seriesId: 'bls_nonfarm_payrolls',
    source: 'bls',
    unit: 'THOUSANDS',
    label: 'BLS total nonfarm payrolls',
    apiSeriesId: 'CES0000000001',
  },
];

export interface MacroObservationValue {
  seriesId: string;
  source: MacroSource;
  unit: MacroUnit;
  refDate: Date;
  value: string | null;
  status?: 'ok' | 'nd';
  revisionIndicator: string | null;
}

export interface MacroFetchResult {
  observations: MacroObservationValue[];
  warnings: string[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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

export interface MacroHttpOptions {
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pauseMs?: number;
}

export interface MacroTextResponse {
  text: string;
  contentType: string | null;
}

export interface MacroHttpClient {
  getText(url: string, accept: string): Promise<string>;
  getTextWithMetadata(url: string, accept: string): Promise<MacroTextResponse>;
  getJson(url: string): Promise<unknown>;
  postJson(url: string, payload: unknown): Promise<unknown>;
}

interface MacroRequestOptions {
  method?: 'GET' | 'POST';
  accept: string;
  contentType?: string;
  body?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMacroHttpClient(options: MacroHttpOptions = {}): MacroHttpClient {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleepImpl = options.sleepImpl ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? MACRO_REQUEST_TIMEOUT_MS;
  const pauseMs = options.pauseMs ?? MACRO_REQUEST_PAUSE_MS;
  let calls = 0;

  async function request(url: string, requestOptions: MacroRequestOptions): Promise<Response> {
    if (calls > 0) {
      await sleepImpl(pauseMs);
    }

    calls++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: requestOptions.accept };

    if (requestOptions.contentType !== undefined) {
      headers['Content-Type'] = requestOptions.contentType;
    }

    try {
      const response = await fetchImpl(url, {
        method: requestOptions.method ?? 'GET',
        headers,
        body: requestOptions.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new HttpError(`HTTP ${response.status}`, response.status);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`timeout após ${timeoutMs}ms`);
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new InvalidPayloadError('resposta da API não é JSON válido');
    }
  }

  return {
    async getText(url, accept) {
      const response = await request(url, { accept });
      return response.text();
    },
    async getTextWithMetadata(url, accept) {
      const response = await request(url, { accept });
      return {
        text: await response.text(),
        contentType: response.headers.get('content-type'),
      };
    },
    async getJson(url) {
      const response = await request(url, { accept: 'application/json' });
      return readJson(response);
    },
    async postJson(url, payload) {
      const response = await request(url, {
        method: 'POST',
        accept: 'application/json',
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
      return readJson(response);
    },
  };
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char === '\r') {
      if (text[index + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

function validDateParts(year: number, month: number, day: number): Date | null {
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

export function parseIsoDateUtc(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;

  return validDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
}

export function parseUsDateUtc(value: string): Date | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (match === null) return null;

  return validDateParts(Number(match[3]), Number(match[1]), Number(match[2]));
}

export function formatIsoDateUtc(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

export function yearsBetween(startDate: Date, endDate: Date): number[] {
  const years: number[] = [];

  for (let year = startDate.getUTCFullYear(); year <= endDate.getUTCFullYear(); year++) {
    years.push(year);
  }

  return years;
}

export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

export function nextBusinessDay(date: Date): Date {
  let candidate = addUtcDays(date, 1);

  while (isWeekend(candidate)) {
    candidate = addUtcDays(candidate, 1);
  }

  return candidate;
}

// Hipótese versionada: usada apenas para preencher publishedAt/firstSeenAt em backfill.
export function estimatePublishedAt(source: MacroSource, refDate: Date): Date {
  if (source === 'treasury') {
    return new Date(
      Date.UTC(
        refDate.getUTCFullYear(),
        refDate.getUTCMonth(),
        refDate.getUTCDate(),
        22,
        0,
        0
      )
    );
  }

  if (source === 'ecb') {
    return new Date(
      Date.UTC(
        refDate.getUTCFullYear(),
        refDate.getUTCMonth(),
        refDate.getUTCDate(),
        16,
        0,
        0
      )
    );
  }

  if (source === 'nyfed') {
    const day = nextBusinessDay(refDate);

    return new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 13, 0, 0)
    );
  }

  if (source === 'fed') {
    const daysSinceMonday = (refDate.getUTCDay() + 6) % 7;
    const nextMonday = addUtcDays(refDate, -daysSinceMonday + 7);

    return new Date(
      Date.UTC(
        nextMonday.getUTCFullYear(),
        nextMonday.getUTCMonth(),
        nextMonday.getUTCDate(),
        22,
        0,
        0
      )
    );
  }

  const followingMonthLastDay = new Date(
    Date.UTC(
      refDate.getUTCFullYear(),
      refDate.getUTCMonth() + 2,
      0,
      22,
      0,
      0
    )
  );

  return followingMonthLastDay;
}

const DECIMAL_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function decimalString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && DECIMAL_PATTERN.test(trimmed) ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const stringified = String(value);
    return DECIMAL_PATTERN.test(stringified) ? stringified : null;
  }

  return null;
}

export function isMissingMacroValue(value: string): boolean {
  const trimmed = value.trim();
  return trimmed === '' || /^N\/A$/i.test(trimmed);
}

export function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, '').trim();
}
