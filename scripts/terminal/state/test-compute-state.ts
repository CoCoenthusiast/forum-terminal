#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../generated/db/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Decimal } from '../prisma-types';
import { computeMarketState } from './market-state';
import {
  READ_WINDOW_DAYS,
  buildMarketStateInput,
  buildWindow,
  decimalToNumber,
  formatShortSummary,
  loadIndicatorRows,
  resolveAsOf,
  type IndicatorRowRaw,
} from './compute-state';

const DAY_MS = 24 * 60 * 60 * 1000;

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function approx(a: number | null, b: number, tol = 1e-9): boolean {
  return a !== null && Math.abs(a - b) < tol;
}

// Decimal-like puro, sem importar o runtime do Prisma na seção pura.
function dec(s: string): { toString(): string } {
  return { toString: () => s };
}

function row(
  indicator: string,
  scope: string,
  value: unknown,
  opts: { asOf?: Date; status?: string; reason?: string | null } = {}
): IndicatorRowRaw {
  return {
    indicator,
    scope,
    asOf: opts.asOf ?? new Date('2026-10-17T00:00:00Z'),
    status: opts.status ?? 'ok',
    value,
    unit: 'FRACTION',
    fromDate: null,
    toDate: null,
    reason: opts.reason ?? null,
  };
}

// Todas as 9 pernas do núcleo de qualidade, todas "ok" e no mesmo asOf.
function bullishRows(): IndicatorRowRaw[] {
  return [
    row('return_7d', 'solana', dec('0.05')),
    row('return_30d', 'solana', dec('0.12')),
    row('volatility_7d', 'solana', dec('0.04')),
    row('relative_strength_7d', 'solana:bitcoin', dec('0.03')),
    row('relative_strength_7d', 'solana:ethereum', dec('0.025')),
    row('volume_vs_mean_7d', 'solana', dec('0.25')),
    row('stablecoin_supply_vs_mean_7d', 'solana', dec('0.06')),
    row('tvl_vs_mean_7d', 'solana', dec('0.07')),
    row('dex_volume_vs_mean_7d', 'solana', dec('0.08')),
  ];
}

function bearishRows(): IndicatorRowRaw[] {
  return [
    row('return_7d', 'solana', dec('-0.05')),
    row('return_30d', 'solana', dec('-0.12')),
    row('volatility_7d', 'solana', dec('0.04')),
    row('relative_strength_7d', 'solana:bitcoin', dec('-0.03')),
    row('relative_strength_7d', 'solana:ethereum', dec('-0.03')),
    row('volume_vs_mean_7d', 'solana', dec('-0.25')),
    row('stablecoin_supply_vs_mean_7d', 'solana', dec('-0.06')),
    row('tvl_vs_mean_7d', 'solana', dec('-0.07')),
    row('dex_volume_vs_mean_7d', 'solana', dec('-0.08')),
  ];
}

// ---------- Seção pura (sempre roda, sem banco) ----------
function runPureSection(): void {
  // decimalToNumber
  check('decimal: Decimal-string -> número', decimalToNumber(dec('123.45')) === 123.45);
  check('decimal: string -> número', decimalToNumber('0.5') === 0.5);
  check('decimal: number -> number', decimalToNumber(7) === 7);
  check('decimal: null -> null', decimalToNumber(null) === null);
  check('decimal: undefined -> null', decimalToNumber(undefined) === null);
  check('decimal: string inválida -> null', decimalToNumber('abc') === null);
  check('decimal: string vazia -> null', decimalToNumber('') === null);
  check('decimal: NaN -> null', decimalToNumber(NaN) === null);
  check('decimal: Infinity -> null', decimalToNumber(Infinity) === null);

  // buildMarketStateInput
  const okRow = row('return_7d', 'solana', dec('0.05'));
  const okInput = buildMarketStateInput([okRow], '2026-10-17');
  const okInd = okInput.indicators[0];
  check('mapper: asOf de referência preservado', okInput.asOf === '2026-10-17');
  check('mapper: value Decimal convertido', approx(okInd.value, 0.05));
  check('mapper: asOf -> ISO dia', okInd.asOf === '2026-10-17');
  check('mapper: status preservado', okInd.status === 'ok');
  check('mapper: from/to nulos -> null', okInd.from === null && okInd.to === null);

  const nonMidnight = buildMarketStateInput(
    [row('return_7d', 'solana', dec('0.05'), { asOf: new Date('2026-10-17T18:30:00Z') })],
    '2026-10-17'
  ).indicators[0];
  check('mapper: asOf não-meia-noite corta pro dia UTC', nonMidnight.asOf === '2026-10-17');

  const insufficient: IndicatorRowRaw = {
    indicator: 'relative_strength_7d',
    scope: 'solana:ethereum',
    asOf: new Date('2026-10-17T00:00:00Z'),
    status: 'insufficient_history',
    value: null,
    unit: 'FRACTION',
    fromDate: new Date('2026-09-01T00:00:00Z'),
    toDate: new Date('2026-10-16T00:00:00Z'),
    reason: 'poucos pontos',
  };
  const insInd = buildMarketStateInput([insufficient], '2026-10-17').indicators[0];
  check('mapper: value null permanece null', insInd.value === null);
  check('mapper: status insufficient_history preservado', insInd.status === 'insufficient_history');
  check('mapper: reason preservado', insInd.reason === 'poucos pontos');
  check('mapper: from/to -> ISO dia', insInd.from === '2026-09-01' && insInd.to === '2026-10-16');

  // resolveAsOf
  const now = new Date('2026-10-18T10:00:00Z');
  const noFlag = resolveAsOf(now, []);
  check('asof: padrão = ontem UTC', noFlag.asOf === '2026-10-17' && noFlag.error === null);
  const midnight = resolveAsOf(new Date('2026-10-18T00:00:00Z'), []);
  check('asof: meia-noite -> ontem UTC', midnight.asOf === '2026-10-17' && midnight.error === null);
  const explicit = resolveAsOf(now, ['--asof=2026-10-10']);
  check('asof: data passada aceita', explicit.asOf === '2026-10-10' && explicit.error === null);
  const yesterdayFlag = resolveAsOf(now, ['--asof=2026-10-17']);
  check('asof: ontem aceito', yesterdayFlag.asOf === '2026-10-17' && yesterdayFlag.error === null);
  const todayFlag = resolveAsOf(now, ['--asof=2026-10-18']);
  check('asof: hoje rejeitado (posterior a ontem)', todayFlag.error !== null);
  const feb30 = resolveAsOf(now, ['--asof=2026-02-30']);
  check('asof: 2026-02-30 inválido', feb30.error !== null);
  const unpadded = resolveAsOf(now, ['--asof=2026-2-3']);
  check('asof: 2026-2-3 inválido', unpadded.error !== null);
  const noValue = resolveAsOf(now, ['--asof']);
  check('asof: --asof sem valor inválido', noValue.error !== null);
  const emptyValue = resolveAsOf(now, ['--asof=']);
  check('asof: --asof= vazio inválido', emptyValue.error !== null);
  const farFuture = resolveAsOf(now, ['--asof=2099-01-01']);
  check('asof: 2099-01-01 rejeitado', farFuture.error !== null);

  // buildWindow
  const win = buildWindow('2026-10-17', 10);
  check('janela: from = asOf - 9 dias', win.from.toISOString() === '2026-10-08T00:00:00.000Z');
  check('janela: to = asOf', win.to.toISOString() === '2026-10-17T00:00:00.000Z');
  check('janela: READ_WINDOW_DAYS = 10', READ_WINDOW_DAYS === 10);

  // Pipeline pura: rows -> input -> estado
  const bullState = computeMarketState(buildMarketStateInput(bullishRows(), '2026-10-17'));
  check('pipeline: tendência bullish', bullState.sol_trend.classification === 'bullish');
  check('pipeline: força relativa strong', bullState.sol_relative_strength.classification === 'strong');
  check('pipeline: spot expanding', bullState.spot.classification === 'expanding');
  check('pipeline: liquidez expanding', bullState.onchain_liquidity.classification === 'expanding');
  check('pipeline: qualidade 9/9', bullState.data_quality.slotsOk === 9 && bullState.data_quality.slotsTotal === 9);
  check('pipeline: score 1.00', approx(bullState.data_quality.score, 1));
  check('pipeline: asOf mais antigo', bullState.data_quality.oldestAsOf === '2026-10-17');

  const brokenRows = bullishRows().map((r) =>
    r.indicator === 'relative_strength_7d' && r.scope === 'solana:ethereum'
      ? row('relative_strength_7d', 'solana:ethereum', null, { status: 'insufficient_history', reason: 'poucos pontos' })
      : r
  );
  const brokenState = computeMarketState(buildMarketStateInput(brokenRows, '2026-10-17'));
  check('pipeline: perna ausente -> força insufficient_data', brokenState.sol_relative_strength.classification === 'insufficient_data');
  check('pipeline: perna ausente -> qualidade 8/9', brokenState.data_quality.slotsOk === 8 && brokenState.data_quality.slotsTotal === 9);

  const staleDexRows = bullishRows().map((r) =>
    r.indicator === 'dex_volume_vs_mean_7d'
      ? row('dex_volume_vs_mean_7d', 'solana', dec('0.08'), { asOf: new Date('2026-10-15T00:00:00Z') })
      : r
  );
  const staleDexState = computeMarketState(buildMarketStateInput(staleDexRows, '2026-10-17'));
  check('pipeline: DEX 2 dias atrás ainda entra', staleDexState.onchain_liquidity.classification === 'expanding');
  check('pipeline: DEX vira o asOf mais antigo', staleDexState.data_quality.oldestAsOf === '2026-10-15');
  check('pipeline: DEX atrasado ainda conta 9/9', staleDexState.data_quality.slotsOk === 9);

  // formatShortSummary (resumo por último, uma linha por campo)
  const summary = formatShortSummary(bullState);
  check('resumo: contém tendência', summary.includes('Tendência: bullish'));
  check('resumo: contém força relativa', summary.includes('Força relativa: strong'));
  check('resumo: contém spot', summary.includes('Spot: expanding'));
  check('resumo: contém liquidez', summary.includes('Liquidez onchain: expanding'));
  check('resumo: contém qualidade', summary.includes('Qualidade dos dados: 9/9 (1.00)'));
  check('resumo: última linha é o asOf mais antigo', summary[summary.length - 1] === 'asOf mais antigo usado: 2026-10-17');

  const bearSummary = formatShortSummary(computeMarketState(buildMarketStateInput(bearishRows(), '2026-10-17')));
  check('resumo: bearish', bearSummary.includes('Tendência: bearish'));
  check('resumo: weak', bearSummary.includes('Força relativa: weak'));
  check('resumo: spot contracting', bearSummary.includes('Spot: contracting'));
  check('resumo: liquidez contracting', bearSummary.includes('Liquidez onchain: contracting'));
}

// ---------- Seção de banco (só com TEST_DATABASE_URL local:5433) ----------
async function runDbSection(url: string): Promise<void> {
  const TEST_FV = 'v1-compute-state-test';
  const parsed = new URL(url);
  console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  const now = new Date();
  const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const asOfMs = todayStartMs - DAY_MS;
  const asOfIso = new Date(asOfMs).toISOString().slice(0, 10);
  const dexDate = new Date(asOfMs - 2 * DAY_MS);

  try {
    await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });

    const seeds: { indicator: string; scope: string; value: string; asOf: Date }[] = [
      { indicator: 'return_7d', scope: 'solana', value: '0.05', asOf: new Date(asOfMs) },
      { indicator: 'return_30d', scope: 'solana', value: '0.12', asOf: new Date(asOfMs) },
      { indicator: 'volatility_7d', scope: 'solana', value: '0.04', asOf: new Date(asOfMs) },
      { indicator: 'relative_strength_7d', scope: 'solana:bitcoin', value: '0.03', asOf: new Date(asOfMs) },
      { indicator: 'relative_strength_7d', scope: 'solana:ethereum', value: '0.025', asOf: new Date(asOfMs) },
      { indicator: 'volume_vs_mean_7d', scope: 'solana', value: '0.25', asOf: new Date(asOfMs) },
      { indicator: 'stablecoin_supply_vs_mean_7d', scope: 'solana', value: '0.06', asOf: new Date(asOfMs) },
      { indicator: 'tvl_vs_mean_7d', scope: 'solana', value: '0.07', asOf: new Date(asOfMs) },
      { indicator: 'dex_volume_vs_mean_7d', scope: 'solana', value: '0.08', asOf: dexDate },
    ];

    await prisma.indicatorSnapshot.createMany({
      data: seeds.map((s) => ({
        indicator: s.indicator,
        scope: s.scope,
        asOf: s.asOf,
        status: 'ok',
        value: new Decimal(s.value),
        unit: 'FRACTION',
        inputCount: 1,
        formulaVersion: TEST_FV,
      })),
    });

    const { from, to } = buildWindow(asOfIso, READ_WINDOW_DAYS);
    const rows = await loadIndicatorRows(prisma, from, to, TEST_FV);
    check('db: lê 9 linhas da versão de teste', rows.length === 9, `(recebeu ${rows.length})`);

    const input = buildMarketStateInput(rows, asOfIso);
    const state = computeMarketState(input);
    check('db: tendência bullish', state.sol_trend.classification === 'bullish', `(${state.sol_trend.classification})`);
    check('db: força relativa strong', state.sol_relative_strength.classification === 'strong');
    check('db: liquidez expanding', state.onchain_liquidity.classification === 'expanding');
    check('db: qualidade 9/9', state.data_quality.slotsOk === 9 && state.data_quality.slotsTotal === 9);
    check('db: asOf mais antigo = DEX 2 dias atrás', state.data_quality.oldestAsOf === dexDate.toISOString().slice(0, 10));
  } catch (e) {
    check('db: seção de banco executou', false, e instanceof Error ? e.message : String(e));
  } finally {
    try {
      await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });
    } catch {
      // limpeza best-effort
    }
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  runPureSection();

  const url = process.env.TEST_DATABASE_URL;
  if (url !== undefined && /(localhost|127\.0\.0\.1):5433/.test(url)) {
    await runDbSection(url);
  } else {
    console.log('[SKIP] Seção de banco: defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test');
  }

  console.log(`\n${passed} passaram, ${failures} falharam`);
  if (failures > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
