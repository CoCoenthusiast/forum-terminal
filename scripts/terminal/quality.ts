import { QUALITY_EXPECTED_INTERVAL_MIN, QUALITY_STALE_AFTER_FACTOR, QUALITY_DAILY_METRICS, QUALITY_DAILY_MAX_SOURCE_LAG_HOURS, QUALITY_JUMP_THRESHOLDS, QUALITY_FAILED_LAST_N, QUALITY_HISTORICAL_SOURCE_SUFFIX, QUALITY_DAILY_CLOSE_PRECISE_METHODS, QUALITY_DAILY_CLOSE_APPROXIMATE_METHODS } from './config';

export type MetricStatus = 'failed' | 'stale' | 'unverified' | 'fresh' | 'partial';

export type DailyCloseKind = 'precise' | 'approximate' | 'unknown';

export function classifyDailyCloseMethod(calcMethod: string): DailyCloseKind {
  if ((QUALITY_DAILY_CLOSE_PRECISE_METHODS as readonly string[]).includes(calcMethod)) return 'precise';
  if ((QUALITY_DAILY_CLOSE_APPROXIMATE_METHODS as readonly string[]).includes(calcMethod)) return 'approximate';
  return 'unknown';
}

export interface QualityInput {
  metric: string;
  scope: string;
  source: string;
  latestValue: number | null;
  latestCollectedAt: Date;
  previousValue: number | null;
  previousCollectedAt: Date | null;
  sourceTs: Date | null;
  recentLogs: { status: string; endpoint: string; operation: string }[];
  now: Date;
  isHistorical?: boolean;
  historicalMaxLagDays?: number | null;
}

export interface QualityResult {
  status: MetricStatus;
  reason: string;
}

function isDailyMetric(metric: string): boolean {
  return QUALITY_DAILY_METRICS.includes(metric as any);
}

function getExpectedIntervalMinutes(source: string): number {
  return QUALITY_EXPECTED_INTERVAL_MIN[source as keyof typeof QUALITY_EXPECTED_INTERVAL_MIN] ?? 60;
}

function isValueInvalid(value: number | null): boolean {
  return value === null || !Number.isFinite(value) || value < 0;
}

function isPriceInvalid(value: number | null): boolean {
  return value === null || !Number.isFinite(value) || value <= 0;
}

function hasJump(metric: string, current: number, previous: number | null): boolean {
  if (previous === null) return false;
  if (current === 0 || previous === 0) return false;

  if (metric === 'price' || metric === 'tvl_usd' || metric === 'stablecoin_supply_usd') {
    const ratio = current / previous;
    const threshold = QUALITY_JUMP_THRESHOLDS[metric as keyof typeof QUALITY_JUMP_THRESHOLDS] as number;
    return ratio > (1 + threshold) || ratio < (1 - threshold);
  }

  if (metric.includes('volume') || metric.includes('fees')) {
    const ratio = current / previous;
    const volumeRatio = QUALITY_JUMP_THRESHOLDS.volumeRatio;
    return ratio > volumeRatio || ratio < (1 / volumeRatio);
  }

  return false;
}

export function evaluateMetricQuality(input: QualityInput): QualityResult {
  const { metric, scope, source, latestValue, latestCollectedAt, previousValue, sourceTs, recentLogs, now, isHistorical, historicalMaxLagDays } = input;

  const expectedIntervalMin = getExpectedIntervalMinutes(source);
  const staleThresholdMin = expectedIntervalMin * QUALITY_STALE_AFTER_FACTOR;

  const latestCollectedAtMs = latestCollectedAt.getTime();
  const ageMin = (now.getTime() - latestCollectedAtMs) / 60000;

  if (isValueInvalid(latestValue)) {
    return { status: 'unverified', reason: 'valor inválido (nulo, não finito ou negativo)' };
  }

  if (metric === 'price' && isPriceInvalid(latestValue)) {
    return { status: 'unverified', reason: 'preço inválido (nulo, não finito ou <= 0)' };
  }

  if (!isHistorical) {
    // recentLogs deve vir ordenado do mais recente para o mais antigo
    if (recentLogs.length >= QUALITY_FAILED_LAST_N) {
      const lastN = recentLogs.slice(0, QUALITY_FAILED_LAST_N);
      if (lastN.every(l => l.status === 'error')) {
        return { status: 'failed', reason: `${QUALITY_FAILED_LAST_N} falhas consecutivas no CollectionLog (mais recentes)` };
      }
    }

    if (ageMin > staleThresholdMin) {
      return { status: 'stale', reason: `última coleta há ${Math.round(ageMin)} min (limite ${staleThresholdMin} min)` };
    }

    if (isDailyMetric(metric) && sourceTs) {
      const sourceLagHours = (latestCollectedAtMs - sourceTs.getTime()) / 3600000;
      if (sourceLagHours > QUALITY_DAILY_MAX_SOURCE_LAG_HOURS) {
        return { status: 'stale', reason: `sourceTs ${Math.round(sourceLagHours)}h antes do collectedAt (limite ${QUALITY_DAILY_MAX_SOURCE_LAG_HOURS}h)` };
      }
    }
  }

  if (isHistorical && historicalMaxLagDays !== undefined && historicalMaxLagDays !== null && sourceTs) {
    const sourceDayStartMs = Date.UTC(sourceTs.getUTCFullYear(), sourceTs.getUTCMonth(), sourceTs.getUTCDate());
    const nowDayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const minAllowedDayStartMs = nowDayStartMs - historicalMaxLagDays * 86400000;
    if (sourceDayStartMs < minAllowedDayStartMs) {
      const lastDate = sourceTs.toISOString().slice(0, 10);
      const limitDate = new Date(minAllowedDayStartMs).toISOString().slice(0, 10);
      return { status: 'stale', reason: `último dado em ${lastDate} (limite até ${limitDate})` };
    }
  }

  if (previousValue !== null && hasJump(metric, latestValue!, previousValue)) {
    return { status: 'unverified', reason: `salto anômalo detectado (atual: ${latestValue}, anterior: ${previousValue})` };
  }

  if (!sourceTs) {
    return { status: 'fresh', reason: isHistorical ? 'carga histórica (sem coleta periódica)' : 'horário da fonte indisponível' };
  }

  return { status: 'fresh', reason: isHistorical ? 'carga histórica (sem coleta periódica)' : 'ok' };
}

export function summarizeSource(statuses: MetricStatus[]): MetricStatus {
  if (statuses.length === 0) return 'fresh';

  const hasFresh = statuses.includes('fresh');
  const hasFailed = statuses.includes('failed');
  const hasStale = statuses.includes('stale');
  const hasUnverified = statuses.includes('unverified');

  if (hasFailed) return 'failed';

  if (hasFresh && (hasStale || hasUnverified)) return 'partial';

  if (hasStale) return 'stale';
  if (hasUnverified) return 'unverified';
  if (hasFresh) return 'fresh';

  return 'fresh';
}