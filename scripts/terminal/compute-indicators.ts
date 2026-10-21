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
    const ownAsOf = row.asOf.toISOString().slice(0, 10);
    const fromIso = row.fromDate === null ? ownAsOf : row.fromDate.toISOString().slice(0, 10);
    const toIso = row.toDate === null ? ownAsOf : row.toDate.toISOString().slice(0, 10);
    const def = defByKey.get(`${row.indicator}|${row.scope}`);
    const inputs = (def?.inputs ?? []).map((seriesId) => {
      const used = (series[seriesId] ?? []).filter((p) => p.date >= fromIso && p.date <= toIso);
      const body = used.length === 0 ? 'sem pontos' : used.map((p) => `${p.date}=${p.value}`).join(' ');
      return `${seriesId} ${fromIso}..${toIso} n=${used.length} ${body}`;
    });
    const reason = row.reason === null ? '' : ` | reason: ${row.reason}`;
    console.log(
      `${row.indicator} | ${row.scope} | ${row.status} | value=${fmt(row.value === null ? null : Number(row.value.toString()))} ${row.unit} | ${inputs.join(', ')}${reason} | asOf=${ownAsOf}`
    );
  }
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run');
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

    const result = await prisma.indicatorSnapshot.createMany({ data: toWrite, skipDuplicates: true });
    const inserted = result.count;
    const duplicated = toWrite.length - inserted;

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
