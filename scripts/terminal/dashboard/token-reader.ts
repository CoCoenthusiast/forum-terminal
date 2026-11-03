import type { PrismaClient } from '../generated/db/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_PREVIOUS_INTERVAL_MS = 20 * HOUR_MS;
const MAX_PREVIOUS_INTERVAL_MS = 28 * HOUR_MS;

export const TOKEN_LIMIT = 10;
export const TOKEN_WINDOW_DAYS = 14;

const CAPTURE_TAKE = 100;

type TokenClient = Pick<PrismaClient, 'token' | 'tokenCapture'>;

export interface TokenChartPoint {
  at: Date;
  value: number;
}

export interface TokenCapturePoint {
  capturedAt: Date;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
}

export interface TokenSummary {
  address: string;
  name: string | null;
  symbol: string | null;
  latest: TokenCapturePoint | null;
  previous: TokenCapturePoint | null;
  poolsObserved: number | null;
  holdersCount: number | null;
  priceChangePct: number | null;
  liquidityChangePct: number | null;
  volumeChangePct: number | null;
  marketCapChangePct: number | null;
  pricePoints: TokenChartPoint[];
  from: string;
  to: string;
}

export interface TokenPoolRow {
  poolAddress: string | null;
  poolName: string | null;
  dexId: string | null;
  reserveInUsd: number | null;
  volume24hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
  poolCreatedAt: Date | null;
}

export interface TokenHolderRow {
  holdersCount: number | null;
  top10Pct: number | null;
  rank11to20Pct: number | null;
  rank21to40Pct: number | null;
  restPct: number | null;
  sourceLastUpdated: Date | null;
}

export interface TokenDetail {
  address: string;
  name: string | null;
  symbol: string | null;
  latest: TokenCapturePoint | null;
  pricePoints: TokenChartPoint[];
  liquidityPoints: TokenChartPoint[];
  volumePoints: TokenChartPoint[];
  marketCapPoints: TokenChartPoint[];
  fdvPoints: TokenChartPoint[];
  pools: TokenPoolRow[];
  holder: TokenHolderRow | null;
  from: string;
  to: string;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    try {
      const parsed = Number(value.toString());
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function windowBounds(now: Date): { from: string; to: string; fromMs: number; toMs: number } {
  const dayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const fromMs = dayMs - (TOKEN_WINDOW_DAYS - 1) * DAY_MS;
  return {
    from: isoDay(fromMs),
    to: isoDay(dayMs),
    fromMs,
    toMs: now.getTime(),
  };
}

export function selectPreviousCapture<T extends { capturedAt: Date }>(
  captures: readonly T[],
  latestAt: Date
): T | null {
  const latestMs = latestAt.getTime();
  const targetMs = latestMs - DAY_MS;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const capture of captures) {
    const interval = latestMs - capture.capturedAt.getTime();
    if (interval < MIN_PREVIOUS_INTERVAL_MS || interval > MAX_PREVIOUS_INTERVAL_MS) {
      continue;
    }
    const distance = Math.abs(capture.capturedAt.getTime() - targetMs);
    if (distance < bestDistance) {
      best = capture;
      bestDistance = distance;
    }
  }

  return best;
}

function changePct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  const result = (current / previous - 1) * 100;
  return Number.isFinite(result) ? result : null;
}

function capturePoint(row: {
  capturedAt: Date;
  priceUsd: unknown;
  liquidityUsd: unknown;
  volume24hUsd: unknown;
  marketCapUsd: unknown;
  fdvUsd: unknown;
}): TokenCapturePoint {
  return {
    capturedAt: row.capturedAt,
    priceUsd: toNumber(row.priceUsd),
    liquidityUsd: toNumber(row.liquidityUsd),
    volume24hUsd: toNumber(row.volume24hUsd),
    marketCapUsd: toNumber(row.marketCapUsd),
    fdvUsd: toNumber(row.fdvUsd),
  };
}

function chartPoints(
  captures: readonly TokenCapturePoint[],
  field: 'priceUsd' | 'liquidityUsd' | 'volume24hUsd' | 'marketCapUsd' | 'fdvUsd',
  fromMs: number,
  toMs: number
): TokenChartPoint[] {
  const points: TokenChartPoint[] = [];
  for (const capture of captures) {
    const ms = capture.capturedAt.getTime();
    if (ms < fromMs || ms > toMs) continue;
    const value = capture[field];
    if (value === null) continue;
    points.push({ at: capture.capturedAt, value });
  }
  return points.sort((left, right) => left.at.getTime() - right.at.getTime());
}

export async function readTokenSummaries(
  client: TokenClient,
  now: Date = new Date()
): Promise<TokenSummary[]> {
  const tokens = await client.token.findMany({
    take: TOKEN_LIMIT,
    orderBy: [{ symbol: 'asc' }, { name: 'asc' }, { address: 'asc' }],
    select: {
      address: true,
      name: true,
      symbol: true,
      captures: {
        orderBy: { capturedAt: 'desc' },
        take: CAPTURE_TAKE,
        select: {
          capturedAt: true,
          priceUsd: true,
          liquidityUsd: true,
          volume24hUsd: true,
          marketCapUsd: true,
          fdvUsd: true,
          poolsObserved: true,
          holder: { select: { holdersCount: true } },
        },
      },
    },
  });

  const bounds = windowBounds(now);

  return tokens.map((token) => {
    const captures = token.captures.map(capturePoint);
    const latestRow = token.captures[0];
    const latest = captures[0] ?? null;
    const previous = latest === null ? null : selectPreviousCapture(captures, latest.capturedAt);

    return {
      address: token.address,
      name: token.name,
      symbol: token.symbol,
      latest,
      previous,
      poolsObserved: latestRow?.poolsObserved ?? null,
      holdersCount: latestRow?.holder?.holdersCount ?? null,
      priceChangePct:
        latest === null || previous === null
          ? null
          : changePct(latest.priceUsd, previous.priceUsd),
      liquidityChangePct:
        latest === null || previous === null
          ? null
          : changePct(latest.liquidityUsd, previous.liquidityUsd),
      volumeChangePct:
        latest === null || previous === null
          ? null
          : changePct(latest.volume24hUsd, previous.volume24hUsd),
      marketCapChangePct:
        latest === null || previous === null
          ? null
          : changePct(latest.marketCapUsd, previous.marketCapUsd),
      pricePoints: chartPoints(captures, 'priceUsd', bounds.fromMs, bounds.toMs),
      from: bounds.from,
      to: bounds.to,
    };
  });
}

export async function readTokenDetail(
  client: TokenClient,
  address: string,
  now: Date = new Date()
): Promise<TokenDetail | null> {
  const token = await client.token.findFirst({
    where: { address },
    select: { address: true, name: true, symbol: true },
  });
  if (token === null) return null;

  const bounds = windowBounds(now);
  const captures = await client.tokenCapture.findMany({
    where: {
      token: { address },
      capturedAt: { gte: new Date(bounds.fromMs), lte: now },
    },
    orderBy: { capturedAt: 'asc' },
    select: {
      capturedAt: true,
      priceUsd: true,
      liquidityUsd: true,
      volume24hUsd: true,
      marketCapUsd: true,
      fdvUsd: true,
    },
  });

  const latestRow = await client.tokenCapture.findFirst({
    where: { token: { address } },
    orderBy: { capturedAt: 'desc' },
    select: {
      capturedAt: true,
      priceUsd: true,
      liquidityUsd: true,
      volume24hUsd: true,
      marketCapUsd: true,
      fdvUsd: true,
      pools: {
        select: {
          poolAddress: true,
          poolName: true,
          dexId: true,
          reserveInUsd: true,
          volume24hUsd: true,
          buys24h: true,
          sells24h: true,
          buyers24h: true,
          sellers24h: true,
          poolCreatedAt: true,
        },
      },
      holder: {
        select: {
          holdersCount: true,
          top10Pct: true,
          rank11to20Pct: true,
          rank21to40Pct: true,
          restPct: true,
          sourceLastUpdated: true,
        },
      },
    },
  });

  const points = captures.map(capturePoint);
  const latest = latestRow === null ? null : capturePoint(latestRow);

  return {
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    latest,
    pricePoints: chartPoints(points, 'priceUsd', bounds.fromMs, bounds.toMs),
    liquidityPoints: chartPoints(points, 'liquidityUsd', bounds.fromMs, bounds.toMs),
    volumePoints: chartPoints(points, 'volume24hUsd', bounds.fromMs, bounds.toMs),
    marketCapPoints: chartPoints(points, 'marketCapUsd', bounds.fromMs, bounds.toMs),
    fdvPoints: chartPoints(points, 'fdvUsd', bounds.fromMs, bounds.toMs),
    pools:
      latestRow?.pools.map((pool) => ({
        poolAddress: pool.poolAddress,
        poolName: pool.poolName,
        dexId: pool.dexId,
        reserveInUsd: toNumber(pool.reserveInUsd),
        volume24hUsd: toNumber(pool.volume24hUsd),
        buys24h: toNumber(pool.buys24h),
        sells24h: toNumber(pool.sells24h),
        buyers24h: toNumber(pool.buyers24h),
        sellers24h: toNumber(pool.sellers24h),
        poolCreatedAt: pool.poolCreatedAt,
      })) ?? [],
    holder:
      latestRow?.holder === null || latestRow?.holder === undefined
        ? null
        : {
            holdersCount: toNumber(latestRow.holder.holdersCount),
            top10Pct: toNumber(latestRow.holder.top10Pct),
            rank11to20Pct: toNumber(latestRow.holder.rank11to20Pct),
            rank21to40Pct: toNumber(latestRow.holder.rank21to40Pct),
            restPct: toNumber(latestRow.holder.restPct),
            sourceLastUpdated: latestRow.holder.sourceLastUpdated,
          },
    from: bounds.from,
    to: bounds.to,
  };
}
