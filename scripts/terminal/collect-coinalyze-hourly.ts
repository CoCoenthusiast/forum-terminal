#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { Prisma, type PrismaClient } from './generated/db/client';
import {
  COINALYZE_ASSETS,
  COINALYZE_BASE_URL,
  COINALYZE_BODY_PREVIEW_CHARS,
  COINALYZE_CREDIT_LINE,
  COINALYZE_DISPLAY_NAME,
  COINALYZE_ENDPOINTS,
  COINALYZE_PROVIDER,
  COINALYZE_REQUEST_PAUSE_MS,
  COINALYZE_REQUEST_TIMEOUT_MS,
  COINALYZE_SYMBOLS,
  coinalyzeSeriesForEndpoint,
  type CoinalyzeAsset,
  type CoinalyzeEndpoint,
  type CoinalyzeSeriesDefinition,
} from './sources/coinalyze-config';

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_HOURS = 6;
const VALUE_DECIMAL_PLACES = 8;
const DECIMAL_PATTERN = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ENDPOINT_ORDER: readonly CoinalyzeEndpoint[] = [
  'open_interest',
  'funding_rate',
  'liquidation',
  'long_short_ratio',
];

const HOURLY_METRIC_BY_ENDPOINT_FIELD: Record<string, string> = {
  'open_interest:c': 'oi_usd_close_1h',
  'funding_rate:c': 'funding_rate_close_pct_1h',
  'liquidation:l': 'liq_long_usd_1h',
  'liquidation:s': 'liq_short_usd_1h',
  'long_short_ratio:r': 'long_short_ratio_1h',
  'long_short_ratio:l': 'long_account_pct_1h',
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HourlyWindow {
  from: Date;
  to: Date;
  hours: readonly Date[];
}

export interface HourlyPoint {
  t: Date;
  values: Record<string, unknown>;
}

export interface HourlyParseResult {
  points: HourlyPoint[];
  warnings: string[];
}

export interface HourlyMetricRow {
  sourceId: string;
  scope: string;
  metric: string;
  value: Prisma.Decimal;
  unit: string;
  bucketTs: Date;
  sourceTs: Date;
  collectedAt: Date;
}

export interface CollectCoinalyzeHourlyOptions {
  prisma?: PrismaClient | null;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => Date;
  apiKey?: string;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export interface CoinalyzeHourlySummary {
  ok: boolean;
  inserted: number;
  skipped: number;
  missing: number;
  calls: number;
  wouldInsert: number;
  warnings: string[];
  failures: string[];
  rateLimited: boolean;
  httpStatus: number | null;
  retryAfter: string | null;
}

export interface CoinalyzeHourlyCliOptions {
  dryRun: boolean;
}

interface HistoryHttpResponse {
  status: number;
  ms: number;
  payload: unknown;
  bodyPreview: string;
  retryAfter: string | null;
}

interface ExistingMetricRow {
  scope: string;
  metric: string;
  sourceTs: Date | null;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function startOfUtcHour(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours())
  );
}

export function buildHourlyWindow(now: Date): HourlyWindow {
  const to = startOfUtcHour(now);
  const from = new Date(to.getTime() - WINDOW_HOURS * HOUR_MS);
  const hours = Array.from(
    { length: WINDOW_HOURS },
    (_, index) => new Date(from.getTime() + index * HOUR_MS)
  );
  return { from, to, hours };
}

export function scopeFor(asset: CoinalyzeAsset): string {
  return `${COINALYZE_PROVIDER}:${asset.toUpperCase()}`;
}

export function hourlyMetricFor(
  definition: CoinalyzeSeriesDefinition
): string | null {
  return (
    HOURLY_METRIC_BY_ENDPOINT_FIELD[`${definition.endpoint}:${definition.field}`] ??
    null
  );
}

function decimalString(value: unknown): string | null {
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

function roundValue(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(
    VALUE_DECIMAL_PLACES,
    Prisma.Decimal.ROUND_HALF_UP
  );
}

function metricKey(scope: string, metric: string, sourceTs: Date): string {
  return `${scope}\u0000${metric}\u0000${sourceTs.toISOString()}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function unixSeconds(value: unknown): number | null {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) return null;

  return Math.abs(numeric) >= 1_000_000_000_000
    ? Math.floor(numeric / 1000)
    : Math.floor(numeric);
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

export function parseCoinalyzeHourlyHistory(
  payload: unknown,
  symbol: string
): HourlyParseResult {
  const history = historyFromPayload(payload);

  if (history === null) {
    throw new Error(`Coinalyze ${symbol}: resposta sem history`);
  }

  const points: HourlyPoint[] = [];
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

    points.push({ t: new Date(seconds * 1000), values: entry });
  }

  return { points, warnings };
}

export function buildCoinalyzeHourlyUrl(
  asset: CoinalyzeAsset,
  endpoint: CoinalyzeEndpoint,
  from: Date,
  to: Date
): string {
  const params = new URLSearchParams({
    symbols: COINALYZE_SYMBOLS[asset],
    interval: '1hour',
    from: String(Math.floor(from.getTime() / 1000)),
    to: String(Math.floor(to.getTime() / 1000)),
  });

  if (endpoint === 'open_interest' || endpoint === 'liquidation') {
    params.set('convert_to_usd', 'true');
  }

  return `${COINALYZE_BASE_URL}${COINALYZE_ENDPOINTS[endpoint]}?${params.toString()}`;
}

function redact(text: string, apiKey: string): string {
  return apiKey === '' ? text : text.split(apiKey).join('[REDACTED]');
}

function preview(text: string, apiKey: string): string {
  return redact(text, apiKey)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COINALYZE_BODY_PREVIEW_CHARS);
}

async function requestHistory(
  url: string,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<HistoryHttpResponse> {
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
      payload =
        body.trim() === ''
          ? null
          : (JSON.parse(body.replace(/^\uFEFF/, '')) as unknown);
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
        `timeout após ${COINALYZE_REQUEST_TIMEOUT_MS} ms (a chave da API não é registrada)`
      );
    }

    throw new Error(
      redact(error instanceof Error ? error.message : String(error), apiKey)
    );
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSource(prisma: PrismaClient): Promise<string> {
  const source = await prisma.dataSource.upsert({
    where: { provider: COINALYZE_PROVIDER },
    update: {},
    create: {
      provider: COINALYZE_PROVIDER,
      displayName: COINALYZE_DISPLAY_NAME,
      baseUrl: COINALYZE_BASE_URL,
    },
    select: { id: true },
  });
  return source.id;
}

function checkEnvironment(): void {
  const dbUrl = process.env.TERMINAL_DATABASE_URL;
  if (!dbUrl) {
    throw new Error('TERMINAL_DATABASE_URL não definida');
  }

  const parsed = new URL(dbUrl);
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
  const isAllowedRemote =
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.TERMINAL_ALLOW_REMOTE === '1';

  if (!isLocal && !isAllowedRemote) {
    throw new Error(
      'Banco remoto não permitido sem GITHUB_ACTIONS=true ou TERMINAL_ALLOW_REMOTE=1'
    );
  }
}

export function parseCoinalyzeHourlyArgs(
  argv: readonly string[]
): CoinalyzeHourlyCliOptions {
  let dryRun = false;

  for (const argument of argv) {
    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }

    throw new Error(`argumento desconhecido: ${argument}`);
  }

  return { dryRun };
}

function printDryRun(
  log: (message: string) => void,
  rows: readonly HourlyMetricRow[],
  missing: number,
  calls: number,
  warnings: readonly string[],
  failures: readonly string[]
): void {
  log('[DRY-RUN] modo simulação - sem escrita no banco');

  for (const row of rows) {
    log(
      `[DRY-RUN] scope=${row.scope} metric=${row.metric} value=${row.value.toString()} ` +
        `unit=${row.unit} sourceTs=${row.sourceTs.toISOString()} ` +
        `bucketTs=${row.bucketTs.toISOString()} collectedAt=${row.collectedAt.toISOString()}`
    );
  }

  for (const warning of warnings) {
    log(`[AVISO] ${warning}`);
  }

  for (const failure of failures) {
    log(`[FALHA] ${failure}`);
  }

  log(
    `[DRY-RUN] resumo inseriria=${rows.length} puladas=0 ausentes=${missing} chamadas=${calls}`
  );
  log('[DRY-RUN] nenhuma escrita no banco');
}

export async function collectCoinalyzeHourly(
  options: CollectCoinalyzeHourlyOptions = {}
): Promise<CoinalyzeHourlySummary> {
  const dryRun = options.dryRun ?? false;
  const prisma = options.prisma ?? null;
  const log = options.log ?? ((message: string) => console.log(message));
  const logError = options.logError ?? ((message: string) => console.error(message));
  const sleepImpl = options.sleepImpl ?? sleep;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey ?? process.env.COINALYZE_API_KEY;

  if (apiKey === undefined || apiKey.trim() === '') {
    throw new Error('COINALYZE_API_KEY não definida');
  }
  if (!dryRun && prisma === null) {
    throw new Error('PrismaClient obrigatório fora do dry-run');
  }

  const collectedAt = now();
  const window = buildHourlyWindow(collectedAt);
  const rowsByKey = new Map<string, HourlyMetricRow>();
  const warnings: string[] = [];
  const failures: string[] = [];
  let missing = 0;
  let calls = 0;
  let rateLimited = false;
  let httpStatus: number | null = null;
  let retryAfter: string | null = null;
  let stopped = false;

  const sourceId =
    dryRun || prisma === null ? null : await ensureSource(prisma);

  for (const asset of COINALYZE_ASSETS) {
    for (const endpoint of ENDPOINT_ORDER) {
      if (stopped) break;

      const endpointDefinitions = coinalyzeSeriesForEndpoint(asset, endpoint);
      const scope = scopeFor(asset);
      const endpointPath = COINALYZE_ENDPOINTS[endpoint];

      if (calls > 0) {
        await sleepImpl(COINALYZE_REQUEST_PAUSE_MS);
      }
      calls++;

      const url = buildCoinalyzeHourlyUrl(asset, endpoint, window.from, window.to);
      let response: HistoryHttpResponse;

      try {
        response = await requestHistory(url, apiKey, fetchImpl);
      } catch (error) {
        const message = `${asset} ${endpointPath}: ${errorMessage(error)}`;
        failures.push(message);
        logError(`[ERRO] ${message}`);
        stopped = true;
        break;
      }

      httpStatus = response.status;

      if (response.status !== 200) {
        const message =
          `${asset} ${endpointPath} HTTP ${response.status}` +
          (response.status === 429
            ? ` retry-after=${response.retryAfter ?? 'AUSENTE'}`
            : ` body=${response.bodyPreview}`);
        failures.push(message);
        logError(`[ERRO] ${message}`);

        if (response.status === 429) {
          rateLimited = true;
          retryAfter = response.retryAfter;
        }

        stopped = true;
        break;
      }

      let parsed: HourlyParseResult;

      try {
        parsed = parseCoinalyzeHourlyHistory(
          response.payload,
          COINALYZE_SYMBOLS[asset]
        );
      } catch (error) {
        const message = `${asset} ${endpointPath}: ${errorMessage(error)}`;
        failures.push(message);
        logError(`[ERRO] ${message}`);
        stopped = true;
        break;
      }

      warnings.push(...parsed.warnings);

      const seenHours = new Set<number>();

      for (const point of parsed.points) {
        const timestamp = point.t.getTime();

        if (timestamp >= window.to.getTime()) {
          warnings.push(
            `${COINALYZE_SYMBOLS[asset]}: ${point.t.toISOString()} é vela aberta/parcial, ignorada`
          );
          continue;
        }

        if (timestamp < window.from.getTime()) {
          continue;
        }

        const refDate = startOfUtcHour(point.t);
        seenHours.add(refDate.getTime());

        for (const definition of endpointDefinitions) {
          const metric = hourlyMetricFor(definition);

          if (metric === null) {
            warnings.push(
              `${definition.seriesId}: métrica horária não mapeada para ${definition.endpoint}/${definition.field}`
            );
            continue;
          }

          const value = decimalString(point.values[definition.field]);

          if (value === null) {
            missing++;
            warnings.push(
              `${scope} ${metric} ${refDate.toISOString()}: campo ${definition.field} ausente/N/A`
            );
            continue;
          }

          const key = metricKey(scope, metric, refDate);
          if (rowsByKey.has(key)) continue;

          rowsByKey.set(key, {
            sourceId: sourceId ?? 'dry-run',
            scope,
            metric,
            value: roundValue(value),
            unit: definition.unit,
            bucketTs: refDate,
            sourceTs: refDate,
            collectedAt,
          });
        }
      }

      for (const expectedHour of window.hours) {
        if (!seenHours.has(expectedHour.getTime())) {
          missing += endpointDefinitions.length;
        }
      }
    }

    if (stopped) break;
  }

  const rows = [...rowsByKey.values()];

  if (dryRun) {
    printDryRun(log, rows, missing, calls, warnings, failures);
    return {
      ok: failures.length === 0,
      inserted: 0,
      skipped: 0,
      missing,
      calls,
      wouldInsert: rows.length,
      warnings,
      failures,
      rateLimited,
      httpStatus,
      retryAfter,
    };
  }

  if (failures.length > 0) {
    for (const warning of warnings) log(`[AVISO] ${warning}`);
    for (const failure of failures) log(`[FALHA] ${failure}`);
    return {
      ok: false,
      inserted: 0,
      skipped: 0,
      missing,
      calls,
      wouldInsert: rows.length,
      warnings,
      failures,
      rateLimited,
      httpStatus,
      retryAfter,
    };
  }

  if (prisma === null || sourceId === null) {
    throw new Error('PrismaClient não inicializado');
  }

  const scopes = [...new Set(rows.map((row) => row.scope))];
  const metrics = [...new Set(rows.map((row) => row.metric))];
  const existing = await prisma.metricSnapshot.findMany({
    where: {
      sourceId,
      scope: { in: scopes },
      metric: { in: metrics },
      sourceTs: { gte: window.from, lt: window.to },
    },
    select: { scope: true, metric: true, sourceTs: true },
  });
  const existingKeys = new Set<string>();

  for (const row of existing as ExistingMetricRow[]) {
    if (row.sourceTs !== null) {
      existingKeys.add(metricKey(row.scope, row.metric, row.sourceTs));
    }
  }

  const pending = rows
    .filter(
      (row) => !existingKeys.has(metricKey(row.scope, row.metric, row.sourceTs))
    )
    .map((row) => ({
      ...row,
      collectedAt: new Date(
        collectedAt.getTime() +
          Math.floor((row.sourceTs.getTime() - window.from.getTime()) / HOUR_MS)
      ),
    }));
  const inserted =
    pending.length === 0
      ? 0
      : (
          await prisma.metricSnapshot.createMany({
            data: pending,
            skipDuplicates: true,
          })
        ).count;
  const skipped = rows.length - inserted;

  for (const warning of warnings) log(`[AVISO] ${warning}`);
  for (const failure of failures) log(`[FALHA] ${failure}`);

  return {
    ok: true,
    inserted,
    skipped,
    missing,
    calls,
    wouldInsert: rows.length,
    warnings,
    failures,
    rateLimited,
    httpStatus,
    retryAfter,
  };
}

async function main(): Promise<void> {
  const args = parseCoinalyzeHourlyArgs(process.argv.slice(2));
  const apiKey = process.env.COINALYZE_API_KEY;

  if (apiKey === undefined || apiKey.trim() === '') {
    console.error('[ERRO] COINALYZE_API_KEY não definida; abortando sem chamadas');
    process.exitCode = 1;
    return;
  }

  let prisma: PrismaClient | null = null;

  if (!args.dryRun) {
    try {
      checkEnvironment();
    } catch (error) {
      console.error(`[ABORT] ${errorMessage(error)}`);
      process.exitCode = 1;
      return;
    }

    const db = await import('./db');
    prisma = db.prisma;
  }

  try {
    const summary = await collectCoinalyzeHourly({
      prisma,
      dryRun: args.dryRun,
      apiKey,
    });

    console.log(
      `[FIM] inserted=${summary.inserted} skipped=${summary.skipped} ` +
        `missing=${summary.missing} calls=${summary.calls} ` +
        `would_insert=${summary.wouldInsert} warnings=${summary.warnings.length} ` +
        `failures=${summary.failures.length} ` +
        `rate_limited=${summary.rateLimited ? 'sim' : 'nao'} ` +
        `http=${summary.httpStatus ?? 'n/a'} ` +
        `retry_after=${summary.retryAfter ?? 'n/a'}`
    );
    console.log(COINALYZE_CREDIT_LINE);

    if (!summary.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (prisma !== null) {
      await prisma.$disconnect();
    }
  }
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error('[FATAL]', errorMessage(error));
    process.exitCode = 1;
  });
}
