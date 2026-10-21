#!/usr/bin/env node
import { checkEnvironment } from './config';
import { createPrismaReader } from './indicators/reader';
import {
  loadAllSeries,
  computeIndicatorRows,
  validateRowInvariants,
  evaluateIndicator,
  buildAsOfDates,
  buildLoadRange,
  INDICATORS,
  ATR_INDICATOR,
  FORMULA_VERSION,
  type IndicatorRow,
  type SeriesMap,
} from './indicators/catalog';
import { LAUNCHPAD_INDICATORS, computeLaunchpadIndicatorRows } from './indicators/launchpads';
import type { PrismaClient } from './generated/db/client';

const DEFAULT_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

// Período de espera (em dias) para linhas não-ok (status insufficient_history).
// A gravação usa createMany + skipDuplicates e NUNCA atualiza uma linha existente:
// se uma linha insufficient_history for gravada cedo demais, ela fica "congelada"
// no banco mesmo quando o dado passar a existir. Por isso adiamos a gravação das
// linhas insufficient_history recentes; numa execução futura, quando o histórico já
// estiver completo, elas serão gravadas com status ok. Linhas ok e linhas
// insufficient_history mais antigas que este período seguem gravadas normalmente.
// Exceção: o atr (status unavailable) continua sendo gravado uma vez, como hoje.
export const INSUFFICIENT_HISTORY_WAIT_DAYS = 3;

export interface WriteSelection {
  toWrite: IndicatorRow[];
  heldByWait: IndicatorRow[];
}

// Decide quais linhas serão gravadas nesta execução. Retém (heldByWait) apenas as
// linhas insufficient_history cujo asOf está dentro dos últimos
// INSUFFICIENT_HISTORY_WAIT_DAYS dias em UTC (asOf >= hoje - WAIT_DAYS). O atr tem
// status unavailable, então nunca é retido por este filtro.
export function selectRowsToWrite(rows: IndicatorRow[], todayStartMs: number): WriteSelection {
  const cutoff = todayStartMs - INSUFFICIENT_HISTORY_WAIT_DAYS * DAY_MS;
  const toWrite: IndicatorRow[] = [];
  const heldByWait: IndicatorRow[] = [];
  for (const row of rows) {
    if (row.status === 'insufficient_history' && row.asOf.getTime() >= cutoff) {
      heldByWait.push(row);
    } else {
      toWrite.push(row);
    }
  }
  return { toWrite, heldByWait };
}

function parseDays(): number {
  const idx = process.argv.findIndex((a) => a === '--days' || a.startsWith('--days='));
  if (idx === -1) return DEFAULT_DAYS;
  const arg = process.argv[idx];
  const raw = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : '';
  const parsed = raw === '' ? DEFAULT_DAYS : Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`[ABORT] --days inválido: "${arg}"`);
    process.exit(1);
  }
  return parsed;
}

function fmt(value: number | null): string {
  return value === null ? 'null' : String(value);
}

type LaunchpadDef = (typeof LAUNCHPAD_INDICATORS)[number];

function formatLaunchpadRow(row: IndicatorRow, series: SeriesMap, def: LaunchpadDef | undefined): string {
  const ownAsOf = row.asOf.toISOString().slice(0, 10);
  const fromIso = row.fromDate === null ? ownAsOf : row.fromDate.toISOString().slice(0, 10);
  const toIso = row.toDate === null ? ownAsOf : row.toDate.toISOString().slice(0, 10);
  const inputs = (def?.inputs ?? []).map((seriesId) => {
    const used = (series[seriesId] ?? []).filter((p) => p.date >= fromIso && p.date <= toIso);
    const body = used.length === 0 ? 'sem pontos' : used.map((p) => `${p.date}=${p.value}`).join(' ');
    return `${seriesId} ${fromIso}..${toIso} n=${used.length} ${body}`;
  });
  const reason = row.reason === null ? '' : ` | reason: ${row.reason}`;
  return `${row.indicator} | ${row.scope} | ${row.status} | value=${fmt(row.value === null ? null : Number(row.value.toString()))} ${row.unit} | ${inputs.join(', ')}${reason} | asOf=${ownAsOf}`;
}

function printDryRun(series: SeriesMap, asOfIso: string): void {
  console.log(`[DRY-RUN] asOf mais recente: ${asOfIso}`);
  for (const def of INDICATORS) {
    const { result, inputs } = evaluateIndicator(def, series, asOfIso);
    const reason = result.reason === null ? '' : ` | reason: ${result.reason}`;
    console.log(
      `${def.indicator} | ${def.scope} | ${result.status} | value=${fmt(result.value)} ${result.unit} | ${inputs.join(', ')}${reason} | asOf=${asOfIso}`
    );
  }
  const atr = ATR_INDICATOR;
  console.log(`atr | solana | ${atr.status} | value=null ${atr.unit} | sem OHLC | reason: ${atr.reason} | asOf=${asOfIso}`);

  // Launchpads: cada linha usa o próprio asOf (a fonte atrasa ~3 dias), então
  // calculamos as linhas para o dia pedido e imprimimos row.asOf, não asOfIso.
  // Isso é só leitura/impressão: rows e statusCounts do resumo continuam os de
  // computeIndicatorRows, sem alteração de cálculo ou gravação.
  const defByKey = new Map(LAUNCHPAD_INDICATORS.map((def) => [`${def.indicator}|${def.scope}`, def]));
  const launchpadRows = computeLaunchpadIndicatorRows(series, [
    { iso: asOfIso, date: new Date(`${asOfIso}T00:00:00.000Z`) },
  ]);
  const sortedRows = [...launchpadRows].sort(
    (a, b) => a.indicator.localeCompare(b.indicator) || a.scope.localeCompare(b.scope)
  );

  for (const row of sortedRows) {
    console.log(formatLaunchpadRow(row, series, defByKey.get(`${row.indicator}|${row.scope}`)));
  }
}

// --summary: somente leitura, só launchpad_*. Agrupa por indicador+slug, mostra
// total, contagem por status, asOf mínimo/máximo e 3 amostras (primeira, meio,
// última por asOf) no mesmo formato das linhas do --dry-run.
function printLaunchpadSummary(rows: readonly IndicatorRow[], series: SeriesMap): void {
  const defByKey = new Map(LAUNCHPAD_INDICATORS.map((def) => [`${def.indicator}|${def.scope}`, def]));
  const groups = new Map<string, IndicatorRow[]>();
  for (const row of rows) {
    if (!row.indicator.startsWith('launchpad_')) continue;
    const key = `${row.indicator}|${row.scope}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [row]);
    else group.push(row);
  }

  const ordered = [...groups.values()].sort(
    (a, b) => a[0].indicator.localeCompare(b[0].indicator) || a[0].scope.localeCompare(b[0].scope)
  );
  if (ordered.length === 0) {
    console.log('[SUMMARY] sem linhas launchpad_*');
  }

  for (const group of ordered) {
    group.sort((a, b) => a.asOf.getTime() - b.asOf.getTime());
    const counts: Record<string, number> = { ok: 0, insufficient_history: 0, unavailable: 0 };
    for (const row of group) counts[row.status] = (counts[row.status] ?? 0) + 1;

    const def = defByKey.get(`${group[0].indicator}|${group[0].scope}`);
    const firstIso = group[0].asOf.toISOString().slice(0, 10);
    const lastIso = group[group.length - 1].asOf.toISOString().slice(0, 10);
    console.log(
      `[SUMMARY] ${group[0].indicator} | ${group[0].scope} | total=${group.length} | ok=${counts.ok} insufficient_history=${counts.insufficient_history} unavailable=${counts.unavailable} | asOf=${firstIso}..${lastIso}`
    );

    const sampleIndexes =
      group.length <= 3 ? group.map((_, index) => index) : [0, Math.floor(group.length / 2), group.length - 1];
    for (const index of sampleIndexes) {
      console.log(formatLaunchpadRow(group[index], series, def));
    }
  }
}

export const WRITE_BATCH_SIZE = 500;

export interface WriteBatchesResult {
  inserted: number;
  duplicated: number;
}

// Grava em lotes de WRITE_BATCH_SIZE, em ordem, sem transação interativa.
// createMany + skipDuplicates é idempotente: repetir a execução não duplica.
// Se um lote falhar, paramos e reportamos os índices e o intervalo de asOf do lote;
// os lotes anteriores já foram gravados e podem ser repetidos com segurança.
export async function writeRowsInBatches(
  prisma: PrismaClient,
  rows: readonly IndicatorRow[],
  batchSize: number = WRITE_BATCH_SIZE
): Promise<WriteBatchesResult> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error(`batchSize inválido: ${batchSize}`);
  }

  let inserted = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    try {
      const result = await prisma.indicatorSnapshot.createMany({ data: batch, skipDuplicates: true });
      inserted += result.count;
    } catch (e) {
      let minAsOf = batch[0].asOf;
      let maxAsOf = batch[0].asOf;
      for (const row of batch) {
        if (row.asOf.getTime() < minAsOf.getTime()) minAsOf = row.asOf;
        if (row.asOf.getTime() > maxAsOf.getTime()) maxAsOf = row.asOf;
      }
      const detail = e instanceof Error ? e.message : String(e);
      console.error(
        `[WRITE] lote índices ${start}..${start + batch.length - 1} (0-based), asOf ${minAsOf.toISOString().slice(0, 10)}..${maxAsOf.toISOString().slice(0, 10)} falhou: ${detail.slice(0, 200)} — lotes anteriores já gravados; repetir é seguro (skipDuplicates)`
      );
      throw e;
    }
  }

  return { inserted, duplicated: rows.length - inserted };
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run');
  const isSummary = process.argv.includes('--summary');
  const days = parseDays();

  checkEnvironment();

  const { prisma } = await import('./db');

  try {
    const now = new Date();
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const todayUtc = new Date(todayStart).toISOString().slice(0, 10);

    const asOfs = buildAsOfDates(todayStart, days);
    const { from, to } = buildLoadRange(todayStart, days);

    const reader = createPrismaReader(prisma);
    const series = await loadAllSeries(reader, from, to, todayUtc);

    const { rows, statusCounts } = computeIndicatorRows(series, asOfs);
    const { toWrite, heldByWait } = selectRowsToWrite(rows, todayStart);

    if (isSummary) {
      printLaunchpadSummary(rows, series);
      console.log(
        `[RESUMO] dry-run: calculadas=${rows.length}, seriam_gravadas=${toWrite.length}, retidas_espera=${heldByWait.length} (nada escrito), ok=${statusCounts.ok ?? 0}, insufficient_history=${statusCounts.insufficient_history ?? 0}, unavailable=${statusCounts.unavailable ?? 0}`
      );
      return;
    }

    if (isDryRun) {
      printDryRun(series, asOfs[0].iso);
      console.log(
        `[RESUMO] dry-run: calculadas=${rows.length}, seriam_gravadas=${toWrite.length}, retidas_espera=${heldByWait.length} (nada escrito), ok=${statusCounts.ok ?? 0}, insufficient_history=${statusCounts.insufficient_history ?? 0}, unavailable=${statusCounts.unavailable ?? 0}`
      );
      return;
    }

    const problems = validateRowInvariants(rows);
    if (problems.length > 0) {
      console.error(`[ABORT] invariantes violadas (${problems.length}):`);
      for (const problem of problems.slice(0, 10)) console.error(`  - ${problem}`);
      process.exitCode = 1;
      return;
    }

    const { inserted, duplicated } = await writeRowsInBatches(prisma, toWrite);

    console.log(
      `[RESUMO] formulaVersion=${FORMULA_VERSION}: calculadas=${rows.length}, seriam_gravadas=${toWrite.length}, retidas_espera=${heldByWait.length}, inseridas=${inserted}, ignoradas por duplicidade=${duplicated}, ok=${statusCounts.ok ?? 0}, insufficient_history=${statusCounts.insufficient_history ?? 0}, unavailable=${statusCounts.unavailable ?? 0}`
    );
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Só executa o fluxo quando o arquivo é o entrypoint (tsx direto). Assim os testes
// podem importar selectRowsToWrite/INSUFFICIENT_HISTORY_WAIT_DAYS sem disparar o job.
if (/compute-indicators\.(ts|js)$/.test(process.argv[1] ?? '')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
