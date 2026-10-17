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
  type SeriesMap,
} from './indicators/catalog';

const DEFAULT_DAYS = 365;

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
      `${def.indicator} | ${def.scope} | ${result.status} | value=${fmt(result.value)} ${result.unit} | ${inputs.join(', ')}${reason}`
    );
  }
  const atr = ATR_INDICATOR;
  console.log(`atr | solana | ${atr.status} | value=null ${atr.unit} | sem OHLC | reason: ${atr.reason}`);
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

    if (isDryRun) {
      printDryRun(series, asOfs[0].iso);
      console.log(
        `[RESUMO] dry-run: calculadas=${rows.length} (nada escrito), ok=${statusCounts.ok ?? 0}, insufficient_history=${statusCounts.insufficient_history ?? 0}, unavailable=${statusCounts.unavailable ?? 0}`
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

    const result = await prisma.indicatorSnapshot.createMany({ data: rows, skipDuplicates: true });
    const inserted = result.count;
    const duplicated = rows.length - inserted;

    console.log(
      `[RESUMO] formulaVersion=${FORMULA_VERSION}: calculadas=${rows.length}, inseridas=${inserted}, ignoradas por duplicidade=${duplicated}, ok=${statusCounts.ok ?? 0}, insufficient_history=${statusCounts.insufficient_history ?? 0}, unavailable=${statusCounts.unavailable ?? 0}`
    );
  } catch (e) {
    console.error('[FATAL]', e instanceof Error ? e.message : String(e).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
