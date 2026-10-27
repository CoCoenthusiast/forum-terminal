#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '../generated/db/client';
import { checkEnvironment } from '../config';
import {
  readMacroObservations,
  type MacroSeriesMap,
} from './macro-reader';
import {
  MACRO_STALE_DAYS_DAILY,
  MACRO_STALE_DAYS_FED,
  macro_breakeven_10y,
  macro_breakeven_5y,
  macro_core_cpi_yoy_pct as computeCoreCpiYoyPct,
  macro_cpi_yoy_pct as computeCpiYoyPct,
  macro_dollar_broad_change_5d_pct,
  macro_eurusd_change_5d_pct,
  macro_payrolls_change_1m as computePayrollsChange1m,
  macro_real_yield_10y_change_5d,
  macro_sofr_effr_spread,
  macro_unemployment_change_3m as computeUnemploymentChange3m,
  macro_ust_2s10s_spread,
  macro_ust_2y_change_5d,
  macro_ust_10y_change_5d,
  type MacroIndicatorResult,
} from './macro-formulas';

export { MACRO_STALE_DAYS_DAILY, MACRO_STALE_DAYS_FED };

// Hipótese, versionada: a refDate mensal é o dia 1. A publicação estimada é o
// fim do mês seguinte, então o dado mais novo conhecido tem de 60 a 91 dias.
// O limite de 105 dias evita marcar como stale durante a janela normal de
// publicação e ainda detecta uma série mensal realmente atrasada.
export const MACRO_STALE_DAYS_MONTHLY = 105;

export const MACRO_INDICATOR_SERIES_IDS = [
  'ust_nominal_2y',
  'ust_nominal_5y',
  'ust_nominal_10y',
  'ust_real_5y',
  'ust_real_10y',
  'sofr',
  'effr',
  'fed_broad_dollar',
  'ecb_eurusd',
  'bls_cpi_u_sa',
  'bls_core_cpi_sa',
  'bls_unemployment_rate',
  'bls_nonfarm_payrolls',
] as const;

export interface MacroIndicatorDefinition {
  indicator: string;
  inputs: readonly string[];
  compute: (series: MacroSeriesMap, asOf: string) => MacroIndicatorResult;
}

function applyMonthlyStaleLimit(result: MacroIndicatorResult): MacroIndicatorResult {
  const ageDays = result.evidence.latestAgeDays;

  if (result.value === null || ageDays === null) {
    return result;
  }

  if (ageDays > MACRO_STALE_DAYS_MONTHLY) {
    return {
      ...result,
      status: 'stale',
      reason:
        `dado mais recente ${result.evidence.latestRefDate} tem ${ageDays} dias ` +
        `(limite ${MACRO_STALE_DAYS_MONTHLY})`,
    };
  }

  if (result.status === 'stale') {
    return { ...result, status: 'ok', reason: null };
  }

  return result;
}

export function macro_cpi_yoy_pct(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return applyMonthlyStaleLimit(computeCpiYoyPct(series, asOf));
}

export function macro_core_cpi_yoy_pct(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return applyMonthlyStaleLimit(computeCoreCpiYoyPct(series, asOf));
}

export function macro_unemployment_change_3m(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return applyMonthlyStaleLimit(computeUnemploymentChange3m(series, asOf));
}

export function macro_payrolls_change_1m(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorResult {
  return applyMonthlyStaleLimit(computePayrollsChange1m(series, asOf));
}

export const MACRO_INDICATORS: MacroIndicatorDefinition[] = [
  {
    indicator: 'macro_ust_2s10s_spread',
    inputs: ['ust_nominal_10y', 'ust_nominal_2y'],
    compute: macro_ust_2s10s_spread,
  },
  {
    indicator: 'macro_ust_10y_change_5d',
    inputs: ['ust_nominal_10y'],
    compute: macro_ust_10y_change_5d,
  },
  {
    indicator: 'macro_ust_2y_change_5d',
    inputs: ['ust_nominal_2y'],
    compute: macro_ust_2y_change_5d,
  },
  {
    indicator: 'macro_breakeven_10y',
    inputs: ['ust_nominal_10y', 'ust_real_10y'],
    compute: macro_breakeven_10y,
  },
  {
    indicator: 'macro_breakeven_5y',
    inputs: ['ust_nominal_5y', 'ust_real_5y'],
    compute: macro_breakeven_5y,
  },
  {
    indicator: 'macro_real_yield_10y_change_5d',
    inputs: ['ust_real_10y'],
    compute: macro_real_yield_10y_change_5d,
  },
  {
    indicator: 'macro_sofr_effr_spread',
    inputs: ['sofr', 'effr'],
    compute: macro_sofr_effr_spread,
  },
  {
    indicator: 'macro_dollar_broad_change_5d_pct',
    inputs: ['fed_broad_dollar'],
    compute: macro_dollar_broad_change_5d_pct,
  },
  {
    indicator: 'macro_eurusd_change_5d_pct',
    inputs: ['ecb_eurusd'],
    compute: macro_eurusd_change_5d_pct,
  },
  {
    indicator: 'macro_cpi_yoy_pct',
    inputs: ['bls_cpi_u_sa'],
    compute: macro_cpi_yoy_pct,
  },
  {
    indicator: 'macro_core_cpi_yoy_pct',
    inputs: ['bls_core_cpi_sa'],
    compute: macro_core_cpi_yoy_pct,
  },
  {
    indicator: 'macro_unemployment_change_3m',
    inputs: ['bls_unemployment_rate'],
    compute: macro_unemployment_change_3m,
  },
  {
    indicator: 'macro_payrolls_change_1m',
    inputs: ['bls_nonfarm_payrolls'],
    compute: macro_payrolls_change_1m,
  },
];

export interface MacroIndicatorOutput {
  indicator: string;
  result: MacroIndicatorResult;
}

export function computeMacroIndicators(
  series: MacroSeriesMap,
  asOf: string
): MacroIndicatorOutput[] {
  return MACRO_INDICATORS.map((definition) => ({
    indicator: definition.indicator,
    result: definition.compute(series, asOf),
  }));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function yesterdayUtc(now: Date): string {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayStart - DAY_MS).toISOString().slice(0, 10);
}

function validAsOf(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

export interface MacroReportOptions {
  asOf: string;
  dryRun: boolean;
}

export function parseMacroReportArgs(
  argv: readonly string[],
  now: Date = new Date()
): MacroReportOptions {
  let asOf: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg.startsWith('--asOf=')) {
      asOf = arg.slice('--asOf='.length);
      continue;
    }

    if (arg === '--asOf') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error('--asOf exige uma data YYYY-MM-DD');
      }
      asOf = next;
      index++;
      continue;
    }

    throw new Error(`argumento desconhecido: ${arg}`);
  }

  const resolved = asOf ?? yesterdayUtc(now);
  if (!validAsOf(resolved)) {
    throw new Error(`--asOf inválido: ${resolved}`);
  }

  return { asOf: resolved, dryRun };
}

function formatValue(value: MacroIndicatorResult['value']): string {
  return value === null ? 'null' : value.toString();
}

function formatEvidence(result: MacroIndicatorResult): string {
  return result.evidence.references
    .map(
      (reference) =>
        `${reference.seriesId}@${reference.refDate}=${reference.value ?? 'null'}`
    )
    .join(',');
}

export function formatMacroIndicatorLine(output: MacroIndicatorOutput): string {
  const { indicator, result } = output;
  return (
    `${indicator} | ${result.status} | value=${formatValue(result.value)} ` +
    `| reason=${result.reason ?? '-'} | latestAgeDays=${result.evidence.latestAgeDays ?? 'null'} ` +
    `| evidence=${formatEvidence(result)}`
  );
}

function requireRemoteAllow(): void {
  const url = process.env.TERMINAL_DATABASE_URL;
  if (url === undefined) return;

  try {
    const host = new URL(url).hostname;
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(host);
    if (!isLocal && process.env.TERMINAL_ALLOW_REMOTE !== '1') {
      console.error(
        '[ABORT] report:macro-indicators exige TERMINAL_ALLOW_REMOTE=1 para banco remoto'
      );
      process.exit(1);
    }
  } catch {
    // checkEnvironment valida a URL.
  }
}

async function main(): Promise<void> {
  let options: MacroReportOptions;

  try {
    options = parseMacroReportArgs(process.argv.slice(2));
  } catch (error) {
    console.error('[ABORT]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  requireRemoteAllow();

  const { prisma } = await import('../db');

  try {
    const series = await readMacroObservations(
      prisma as PrismaClient,
      options.asOf,
      MACRO_INDICATOR_SERIES_IDS
    );
    const outputs = computeMacroIndicators(series, options.asOf);

    if (options.dryRun) {
      console.log('[DRY-RUN] relatório somente leitura; nenhuma escrita no banco');
    }
    console.log(`asOf=${options.asOf} rules=macro_indicators_v1`);

    for (const output of outputs) {
      console.log(formatMacroIndicatorLine(output));
    }

    const statusCounts: Record<string, number> = {};
    for (const output of outputs) {
      statusCounts[output.result.status] = (statusCounts[output.result.status] ?? 0) + 1;
    }
    console.log(
      `resumo total=${outputs.length} ok=${statusCounts.ok ?? 0} ` +
        `insufficient_history=${statusCounts.insufficient_history ?? 0} ` +
        `unavailable=${statusCounts.unavailable ?? 0} stale=${statusCounts.stale ?? 0}`
    );
  } catch (error) {
    console.error('[FATAL]', error instanceof Error ? error.message : String(error).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
