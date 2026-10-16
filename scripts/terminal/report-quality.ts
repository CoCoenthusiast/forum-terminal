#!/usr/bin/env node
import type { PrismaClient } from './generated/db/client';
import { checkEnvironment, QUALITY_LOG_OPERATION_MAP, QUALITY_FAILED_LAST_N, QUALITY_HISTORICAL_SOURCE_SUFFIX } from './config';
import { evaluateMetricQuality, summarizeSource, QualityInput, MetricStatus } from './quality';

export interface QualityRow {
  source: string;
  scope: string;
  metric: string;
  value: number | null;
  collectedAt: Date;
  ageMin: number;
  status: MetricStatus;
  reason: string;
  logsUsed: number;
  isHistorical: boolean;
}

export async function buildQualityRows(prisma: PrismaClient, now: Date): Promise<QualityRow[]> {
  const sources = await prisma.dataSource.findMany({
    select: { id: true, provider: true },
  });

  const sourceMap = new Map(sources.map(s => [s.id, s.provider]));

  const metrics = await prisma.metricSnapshot.findMany({
    orderBy: { collectedAt: 'desc' },
  });

  const marketSnapshots = await prisma.marketSnapshot.findMany({
    orderBy: { collectedAt: 'desc' },
  });

  const logs = await prisma.collectionLog.findMany({
    orderBy: { collectedAt: 'desc' },
  });

  const metricGroups = new Map<string, typeof metrics>();
  for (const m of metrics) {
    const key = `${m.sourceId}|${m.scope}|${m.metric}`;
    if (!metricGroups.has(key)) metricGroups.set(key, []);
    metricGroups.get(key)!.push(m);
  }

  const marketGroups = new Map<string, typeof marketSnapshots>();
  for (const m of marketSnapshots) {
    const key = `${m.sourceId}|${m.asset}`;
    if (!marketGroups.has(key)) marketGroups.set(key, []);
    marketGroups.get(key)!.push(m);
  }

  const logGroups = new Map<string, typeof logs>();
  for (const l of logs) {
    const key = `${l.sourceId}|${l.operation}`;
    if (!logGroups.has(key)) logGroups.set(key, []);
    logGroups.get(key)!.push(l);
  }

  function findOperation(source: string, metric: string, scope: string): string | null {
    for (const entry of QUALITY_LOG_OPERATION_MAP) {
      if (entry.source !== source) continue;
      if (entry.metric !== metric) continue;
      if (entry.scopeExact !== undefined && entry.scopeExact !== scope) continue;
      if (entry.scopePrefix !== undefined && !scope.startsWith(entry.scopePrefix)) continue;
      return entry.operation;
    }
    return null;
  }

  const rows: QualityRow[] = [];

  for (const [key, snapshots] of metricGroups) {
    const [sourceId, scope, metric] = key.split('|');
    const source = sourceMap.get(sourceId) || 'unknown';
    const isHistorical = source.endsWith(QUALITY_HISTORICAL_SOURCE_SUFFIX);
    const latest = snapshots[0];
    const previous = snapshots[1] || null;

    const operation = findOperation(source, metric, scope);
    const recentLogs = operation
      ? (logGroups.get(`${sourceId}|${operation}`) || []).slice(0, QUALITY_FAILED_LAST_N)
      : [];

    const input: QualityInput = {
      metric,
      scope,
      source,
      latestValue: latest.value ? Number(latest.value) : null,
      latestCollectedAt: latest.collectedAt,
      previousValue: previous?.value ? Number(previous.value) : null,
      previousCollectedAt: previous?.collectedAt || null,
      sourceTs: latest.sourceTs || null,
      recentLogs: recentLogs.map(l => ({ status: l.status, endpoint: l.endpoint, operation: l.operation })),
      now,
      isHistorical,
    };

    const result = evaluateMetricQuality(input);
    const ageMin = Math.round((now.getTime() - latest.collectedAt.getTime()) / 60000);

    let reason = result.reason;
    if (isHistorical && result.status === 'fresh') {
      reason += ` (última data: ${latest.collectedAt.toISOString().slice(0, 10)})`;
    } else if (!operation && result.status === 'fresh') {
      reason += ' (sem mapeamento de log)';
    }

    rows.push({
      source,
      scope,
      metric,
      value: latest.value ? Number(latest.value) : null,
      collectedAt: latest.collectedAt,
      ageMin,
      status: result.status,
      reason,
      logsUsed: recentLogs.length,
      isHistorical,
    });
  }

  for (const [key, snapshots] of marketGroups) {
    const [sourceId, asset] = key.split('|');
    const source = sourceMap.get(sourceId) || 'unknown';
    const isHistorical = source.endsWith(QUALITY_HISTORICAL_SOURCE_SUFFIX);
    const latest = snapshots[0];
    const previous = snapshots[1] || null;

    const operation = findOperation(source, 'price', asset);
    const recentLogs = operation
      ? (logGroups.get(`${sourceId}|${operation}`) || []).slice(0, QUALITY_FAILED_LAST_N)
      : [];

    const input: QualityInput = {
      metric: 'price',
      scope: asset,
      source,
      latestValue: latest.priceUsd ? Number(latest.priceUsd) : null,
      latestCollectedAt: latest.collectedAt,
      previousValue: previous?.priceUsd ? Number(previous.priceUsd) : null,
      previousCollectedAt: previous?.collectedAt || null,
      sourceTs: latest.sourceTs || null,
      recentLogs: recentLogs.map(l => ({ status: l.status, endpoint: l.endpoint, operation: l.operation })),
      now,
      isHistorical,
    };

    const result = evaluateMetricQuality(input);
    const ageMin = Math.round((now.getTime() - latest.collectedAt.getTime()) / 60000);

    let reason = result.reason;
    if (isHistorical && result.status === 'fresh') {
      reason += ` (última data: ${latest.collectedAt.toISOString().slice(0, 10)})`;
    } else if (!operation && result.status === 'fresh') {
      reason += ' (sem mapeamento de log)';
    }

    rows.push({
      source,
      scope: asset,
      metric: 'price',
      value: latest.priceUsd ? Number(latest.priceUsd) : null,
      collectedAt: latest.collectedAt,
      ageMin,
      status: result.status,
      reason,
      logsUsed: recentLogs.length,
      isHistorical,
    });
  }

  return rows;
}

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log('[DRY-RUN] Modo simulação - requer banco, use execução real');
    return;
  }

  checkEnvironment();

  const { prisma } = await import('./db');

  try {
    const now = new Date();
    const rows = await buildQualityRows(prisma, now);

    console.log('\n=== RELATÓRIO DE QUALIDADE DE DADOS ===');
    console.log(`Agora: ${now.toISOString()}\n`);

    console.log('Fonte      | Scope                    | Métrica              | Valor              | Coletado em (UTC)     | Idade (min) | Logs | Tipo     | Status      | Motivo');
    console.log('-----------|--------------------------|----------------------|--------------------|-----------------------|-------------|------|----------|-------------|------');

    for (const r of rows.sort((a, b) => a.source.localeCompare(b.source) || a.scope.localeCompare(b.scope) || a.metric.localeCompare(b.metric))) {
      const valueStr = r.value !== null ? r.value.toLocaleString() : 'NULL';
      const collectedStr = r.collectedAt.toISOString().replace('T', ' ').slice(0, 19);
      const statusStr = r.status.padEnd(11);
      const tipoStr = r.isHistorical ? 'histórico' : 'ao vivo';
      console.log(`${r.source.padEnd(10)} | ${r.scope.padEnd(24)} | ${r.metric.padEnd(20)} | ${valueStr.padEnd(18)} | ${collectedStr} | ${String(r.ageMin).padStart(11)} | ${String(r.logsUsed).padStart(4)} | ${tipoStr.padEnd(8)} | ${statusStr} | ${r.reason}`);
    }

    const sourceSummary = new Map<string, { statuses: MetricStatus[]; isHistorical: boolean }>();
    for (const r of rows) {
      if (!sourceSummary.has(r.source)) sourceSummary.set(r.source, { statuses: [], isHistorical: r.isHistorical });
      sourceSummary.get(r.source)!.statuses.push(r.status);
    }

    console.log('\n=== RESUMO POR FONTE ===');
    for (const [source, { statuses, isHistorical }] of sourceSummary) {
      const summary = summarizeSource(statuses);
      const histLabel = isHistorical ? ' (histórico)' : '';
      console.log(`${source}${histLabel}: ${summary} (fresh=${statuses.filter(s=>s==='fresh').length}, unverified=${statuses.filter(s=>s==='unverified').length}, stale=${statuses.filter(s=>s==='stale').length}, failed=${statuses.filter(s=>s==='failed').length})`);
    }
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    const { prisma } = await import('./db');
    await prisma.$disconnect();
  }
}

main();