#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from './generated/db/client';
import { checkEnvironment } from './config';

export const REPORT_HEADER =
  'Números crus entre os tokens observados. Não é taxa de mercado. Não detecta bot sofisticado. Sem rótulo bom ou ruim.';
export const POOL_WARNING = 'soma entre pools, pode contar o mesmo endereço mais de uma vez';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_PREVIOUS_INTERVAL_MS = 20 * HOUR_MS;
const MAX_PREVIOUS_INTERVAL_MS = 28 * HOUR_MS;

export interface ReportPool {
  buyers24h: number | null;
  sellers24h: number | null;
}

export interface ReportHolder {
  holdersCount: number | null;
  top10Pct: number | null;
  sourceLastUpdated: Date | null;
}

export interface ReportCapture {
  capturedAt: Date;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  buys24hObserved: number | null;
  sells24hObserved: number | null;
  pools: readonly ReportPool[];
  holder: ReportHolder | null;
}

export interface ReportSource {
  address: string;
  name: string | null;
  symbol: string | null;
  captures: readonly ReportCapture[];
}

export interface TokenReportRow {
  address: string;
  name: string | null;
  symbol: string | null;
  latestCapturedAt: Date;
  previousCapturedAt: Date | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  buys24hObserved: number | null;
  sells24hObserved: number | null;
  giro: number | null;
  buyRatio: number | null;
  avgVolumePerTx: number | null;
  holdersCount: number | null;
  top10Pct: number | null;
  sourceLastUpdated: Date | null;
  liquidityChangePct: number | null;
  holdersChangePct: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
  rankGiro: number | null;
  rankBuyRatio: number | null;
  rankAvgVolumePerTx: number | null;
  rankHoldersCount: number | null;
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}

function divide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return finiteOrNull(numerator / denominator);
}

function changePct(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return finiteOrNull((current / previous - 1) * 100);
}

function sumPools(pools: readonly ReportPool[], field: 'buyers24h' | 'sellers24h'): number | null {
  if (pools.length === 0) return null;
  let sum = 0;
  let found = false;
  for (const pool of pools) {
    const value = pool[field];
    if (value !== null && Number.isFinite(value)) {
      sum += value;
      found = true;
    }
  }
  return found ? sum : null;
}

function closestToPreviousDay(captures: readonly ReportCapture[], latestAt: Date): ReportCapture | null {
  const latestMs = latestAt.getTime();
  const target = latestMs - DAY_MS;
  let best: ReportCapture | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const capture of captures) {
    const ms = capture.capturedAt.getTime();
    const interval = latestMs - ms;
    if (interval < MIN_PREVIOUS_INTERVAL_MS || interval > MAX_PREVIOUS_INTERVAL_MS) continue;
    const distance = Math.abs(ms - target);
    if (distance < bestDistance) {
      best = capture;
      bestDistance = distance;
    }
  }
  return best;
}

function rankValues(values: readonly (number | null)[]): (number | null)[] {
  const entries = values
    .map((value, index) => ({ value, index }))
    .filter((entry): entry is { value: number; index: number } => entry.value !== null);
  entries.sort((a, b) => b.value - a.value);

  const ranks: (number | null)[] = values.map(() => null);
  let lastValue: number | null = null;
  let lastRank = 0;
  entries.forEach((entry, position) => {
    const rank = lastValue !== null && entry.value === lastValue ? lastRank : position + 1;
    ranks[entry.index] = rank;
    lastValue = entry.value;
    lastRank = rank;
  });
  return ranks;
}

export function buildTokenReport(sources: readonly ReportSource[]): TokenReportRow[] {
  const rows: TokenReportRow[] = [];

  for (const source of sources) {
    if (source.captures.length === 0) continue;
    const captures = source.captures.slice().sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
    const latest = captures[0];
    const previous = closestToPreviousDay(captures, latest.capturedAt);
    const buys = latest.buys24hObserved;
    const sells = latest.sells24hObserved;
    const txTotal = buys !== null && sells !== null ? buys + sells : null;
    const holder = latest.holder;
    const previousHolder = previous?.holder ?? null;

    rows.push({
      address: source.address,
      name: source.name,
      symbol: source.symbol,
      latestCapturedAt: latest.capturedAt,
      previousCapturedAt: previous?.capturedAt ?? null,
      liquidityUsd: latest.liquidityUsd,
      volume24hUsd: latest.volume24hUsd,
      buys24hObserved: buys,
      sells24hObserved: sells,
      giro: divide(latest.volume24hUsd, latest.liquidityUsd),
      buyRatio: divide(buys, txTotal),
      avgVolumePerTx: divide(latest.volume24hUsd, txTotal),
      holdersCount: holder?.holdersCount ?? null,
      top10Pct: holder?.top10Pct ?? null,
      sourceLastUpdated: holder?.sourceLastUpdated ?? null,
      liquidityChangePct: previous === null ? null : changePct(latest.liquidityUsd, previous.liquidityUsd),
      holdersChangePct: previous === null ? null : changePct(holder?.holdersCount ?? null, previousHolder?.holdersCount ?? null),
      buyers24h: sumPools(latest.pools, 'buyers24h'),
      sellers24h: sumPools(latest.pools, 'sellers24h'),
      rankGiro: null,
      rankBuyRatio: null,
      rankAvgVolumePerTx: null,
      rankHoldersCount: null,
    });
  }

  const rankGiro = rankValues(rows.map((row) => row.giro));
  const rankBuyRatio = rankValues(rows.map((row) => row.buyRatio));
  const rankAvgVolumePerTx = rankValues(rows.map((row) => row.avgVolumePerTx));
  const rankHoldersCount = rankValues(rows.map((row) => row.holdersCount));

  rows.forEach((row, index) => {
    row.rankGiro = rankGiro[index];
    row.rankBuyRatio = rankBuyRatio[index];
    row.rankAvgVolumePerTx = rankAvgVolumePerTx[index];
    row.rankHoldersCount = rankHoldersCount[index];
  });

  return rows;
}

function formatNumber(value: number | null, digits: number): string {
  if (value === null || !Number.isFinite(value)) return 'n/d';
  const fixed = value.toFixed(digits);
  if (digits === 0) return fixed;
  const trimmed = fixed.replace(/\.?0+$/, '') || '0';
  return trimmed === '-0' ? '0' : trimmed;
}

function formatChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/d';
  const sign = value > 0 ? '+' : '';
  return `${sign}${formatNumber(value, 2)}%`;
}

function formatRank(rank: number | null, total: number): string {
  return rank === null ? 'n/d' : `#${rank} de ${total}`;
}

function formatDate(value: Date | null): string {
  return value === null ? 'n/d' : value.toISOString();
}

function formatText(value: string | null): string {
  return value === null ? 'n/d' : value;
}

export function formatTokenReport(rows: readonly TokenReportRow[]): string {
  const total = rows.length;
  const lines: string[] = [REPORT_HEADER, ''];

  if (rows.length === 0) {
    lines.push('Nenhum token observado.');
    return lines.join('\n');
  }

  rows.forEach((row, index) => {
    lines.push(
      `[${index + 1}] ${formatText(row.symbol)} | ${row.address} | capturedAt=${formatDate(row.latestCapturedAt)}`
    );
    lines.push(`  name=${formatText(row.name)} symbol=${formatText(row.symbol)}`);
    lines.push(
      `  liquidityUsd=${formatNumber(row.liquidityUsd, 2)} volume24hUsd=${formatNumber(row.volume24hUsd, 2)}`
    );
    lines.push(
      `  buys24hObserved=${formatNumber(row.buys24hObserved, 0)} sells24hObserved=${formatNumber(row.sells24hObserved, 0)}`
    );
    lines.push(`  giro=${formatNumber(row.giro, 6)} (${formatRank(row.rankGiro, total)})`);
    lines.push(`  proporcaoCompras=${formatNumber(row.buyRatio, 6)} (${formatRank(row.rankBuyRatio, total)})`);
    lines.push(
      `  volumeMedioPorTransacao=${formatNumber(row.avgVolumePerTx, 6)} (${formatRank(row.rankAvgVolumePerTx, total)})`
    );
    lines.push(
      `  holdersCount=${formatNumber(row.holdersCount, 0)} (${formatRank(row.rankHoldersCount, total)}) ` +
        `top10Pct=${formatNumber(row.top10Pct, 4)} sourceLastUpdated=${formatDate(row.sourceLastUpdated)}`
    );
    lines.push(
      `  variacaoLiquidezVs24h=${formatChange(row.liquidityChangePct)} ` +
        `variacaoHoldersVs24h=${formatChange(row.holdersChangePct)}`
    );
    lines.push(
      `  buyers24h=${formatNumber(row.buyers24h, 0)} sellers24h=${formatNumber(row.sellers24h, 0)} (${POOL_WARNING})`
    );
    if (row.previousCapturedAt === null) {
      lines.push('  previousCapturedAt=n/d');
    } else {
      const intervalHours = (row.latestCapturedAt.getTime() - row.previousCapturedAt.getTime()) / HOUR_MS;
      lines.push(
        `  previousCapturedAt=${formatDate(row.previousCapturedAt)} intervaloHoras=${intervalHours.toFixed(1)}`
      );
    }
    lines.push('');
  });

  return lines.join('\n').trimEnd();
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object' && typeof (value as { toString?: unknown }).toString === 'function') {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

async function loadReportSources(prisma: PrismaClient): Promise<ReportSource[]> {
  const tokens = await prisma.token.findMany({
    orderBy: [{ symbol: 'asc' }, { name: 'asc' }, { address: 'asc' }],
    select: {
      address: true,
      name: true,
      symbol: true,
      captures: {
        orderBy: { capturedAt: 'desc' },
        take: 100,
        select: {
          capturedAt: true,
          liquidityUsd: true,
          volume24hUsd: true,
          buys24hObserved: true,
          sells24hObserved: true,
          pools: { select: { buyers24h: true, sellers24h: true } },
          holder: true,
        },
      },
    },
  });

  return tokens.map((token) => ({
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    captures: token.captures.map((capture) => ({
      capturedAt: capture.capturedAt,
      liquidityUsd: toNumber(capture.liquidityUsd),
      volume24hUsd: toNumber(capture.volume24hUsd),
      buys24hObserved: toNumber(capture.buys24hObserved),
      sells24hObserved: toNumber(capture.sells24hObserved),
      pools: capture.pools.map((pool) => ({
        buyers24h: toNumber(pool.buyers24h),
        sellers24h: toNumber(pool.sellers24h),
      })),
      holder: capture.holder === null
        ? null
        : {
            holdersCount: toNumber(capture.holder.holdersCount),
            top10Pct: toNumber(capture.holder.top10Pct),
            sourceLastUpdated: toDate(capture.holder.sourceLastUpdated),
          },
    })),
  }));
}

function requireRemoteAllow(): void {
  const url = process.env.TERMINAL_DATABASE_URL;
  if (url === undefined) return;
  try {
    const host = new URL(url).hostname;
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
    if (!isLocal && process.env.TERMINAL_ALLOW_REMOTE !== '1') {
      console.error('[ABORT] report:tokens exige TERMINAL_ALLOW_REMOTE=1 para banco remoto');
      process.exit(1);
    }
  } catch {
    // checkEnvironment já validou a URL
  }
}

async function main(): Promise<void> {
  checkEnvironment();
  requireRemoteAllow();

  const { prisma } = await import('./db');
  try {
    const sources = await loadReportSources(prisma);
    const rows = buildTokenReport(sources);
    console.log(formatTokenReport(rows));
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
