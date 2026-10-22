#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../generated/db/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Decimal } from '../prisma-types';
import { computeMarketState } from './market-state';
import { LAUNCHPAD_SLUGS, buildProtocolScope } from '../config';
import {
  MAX_BACKFILL_DAYS,
  READ_WINDOW_DAYS,
  SAVE_BATCH_SIZE,
  SAVE_TX_MAX_WAIT_MS,
  SAVE_TX_TIMEOUT_MS,
  buildBackfillInputs,
  buildDayList,
  buildMarketStateInput,
  buildWindow,
  decimalToNumber,
  formatShortSummary,
  loadIndicatorRows,
  parseRunArgs,
  resolveAsOf,
  saveMarketStates,
  shouldPersist,
  toMarketStateRow,
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
async function runPureSection(): Promise<void> {
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

  // parseRunArgs / computeMode
  const refNow = new Date('2026-10-18T10:00:00Z'); // ontem = 2026-10-17
  const def = parseRunArgs(refNow, ['--save']);
  check('args: default é single de ontem', def.mode === 'single' && def.asOf === '2026-10-17' && def.error === null);
  check('args: default com --save é live', def.computeMode === 'live' && def.save === true);
  const noSave = parseRunArgs(refNow, []);
  check('args: sem --save continua single', noSave.mode === 'single' && noSave.save === false);
  check('args: --asof igual a ontem é live', parseRunArgs(refNow, ['--asof=2026-10-17']).computeMode === 'live');
  check('args: --asof mais antigo é backfill', parseRunArgs(refNow, ['--asof=2026-10-16']).computeMode === 'backfill');

  check('args: --from sem --to aborta', parseRunArgs(refNow, ['--from=2026-10-01']).error !== null);
  check('args: --to sem --from aborta', parseRunArgs(refNow, ['--to=2026-10-01']).error !== null);
  check('args: from > to aborta', parseRunArgs(refNow, ['--from=2026-10-10', '--to=2026-10-01']).error !== null);
  check('args: --asof junto com --from aborta', parseRunArgs(refNow, ['--asof=2026-10-10', '--from=2026-10-01', '--to=2026-10-02']).error !== null);
  check('args: --to posterior a ontem aborta', parseRunArgs(refNow, ['--from=2026-10-01', '--to=2026-10-18']).error !== null);
  check('args: --from inválido aborta', parseRunArgs(refNow, ['--from=2026-02-30', '--to=2026-03-01']).error !== null);

  const ok370 = parseRunArgs(refNow, ['--from=2025-10-13', '--to=2026-10-17']);
  check('args: intervalo de 370 dias ok', ok370.error === null && (ok370.days?.length ?? 0) === MAX_BACKFILL_DAYS);
  check('args: intervalo de 371 dias aborta', parseRunArgs(refNow, ['--from=2025-10-12', '--to=2026-10-17']).error !== null);

  const bf = parseRunArgs(refNow, ['--from=2026-10-01', '--to=2026-10-03', '--save']);
  check('args: modo backfill', bf.mode === 'backfill' && bf.computeMode === 'backfill' && bf.save === true);
  check('args: backfill lista os dias', (bf.days ?? []).join(',') === '2026-10-01,2026-10-02,2026-10-03');

  // buildDayList
  check('dias: from == to -> 1 dia', buildDayList('2026-10-05', '2026-10-05').length === 1);
  check('dias: 3 dias inclusive nas pontas', buildDayList('2026-10-01', '2026-10-03').join(',') === '2026-10-01,2026-10-02,2026-10-03');

  // buildBackfillInputs: janela por dia, sem ver o futuro
  const bfRows = [
    row('return_7d', 'solana', dec('0.05'), { asOf: new Date('2026-10-10T00:00:00Z') }),
    row('return_7d', 'solana', dec('0.09'), { asOf: new Date('2026-10-11T00:00:00Z') }),
    row('return_7d', 'solana', dec('0.12'), { asOf: new Date('2026-10-12T00:00:00Z') }),
  ];
  const bfInputs = buildBackfillInputs(bfRows, ['2026-10-10', '2026-10-11']);
  check('backfill: um input por dia', bfInputs.length === 2);
  check('backfill: dia 10 não vê o futuro', bfInputs[0].indicators.every((i) => i.asOf <= '2026-10-10'));
  const d10 = computeMarketState(bfInputs[0]).sol_trend.evidence[0]?.value ?? null;
  const d11 = computeMarketState(bfInputs[1]).sol_trend.evidence[0]?.value ?? null;
  check('backfill: dia 10 usa valor do dia 10', approx(d10, 0.05));
  check('backfill: dia 11 usa valor do dia 11', approx(d11, 0.09));
  check('backfill: dia 10 bullish', computeMarketState(bfInputs[0]).sol_trend.classification === 'bullish');

  // toMarketStateRow
  const rowNow = new Date('2026-10-18T12:00:00Z');
  const msRow = toMarketStateRow(bullState, 'live', rowNow);
  check('row: asOf vira Date UTC', msRow.asOf.toISOString() === '2026-10-17T00:00:00.000Z');
  check('row: computeMode guardado', msRow.computeMode === 'live');
  check('row: versions do estado', msRow.stateVersion === bullState.stateVersion && msRow.rulesVersion === bullState.rulesVersion);
  check('row: score 9/9 = 1', approx(msRow.dataQualityScore, 1));
  check('row: oldestDataDate', msRow.oldestDataDate?.toISOString() === '2026-10-17T00:00:00.000Z');
  check('row: payload é o estado completo', msRow.payload === bullState);
  check('row: computedAt usa now', msRow.computedAt === rowNow);
  check('row: score parcial 8/9', approx(toMarketStateRow(brokenState, 'backfill', rowNow).dataQualityScore, 8 / 9));

  const emptyState = computeMarketState(buildMarketStateInput([], '2026-10-17'));
  check('persist: score 0 não grava', shouldPersist(emptyState) === false);
  check('persist: score > 0 grava', shouldPersist(bullState) === true);
  check('row: oldestDataDate null quando vazio', toMarketStateRow(emptyState, 'backfill', rowNow).oldestDataDate === null);

  // saveMarketStates: transação interativa (callback, não array), timeout alto, lote <= 20
  interface FakeCall { isFn: boolean; timeout: number | undefined; maxWait: number | undefined; count: number }
  const fakeCalls: FakeCall[] = [];
  const upsertArgs: unknown[] = [];
  const fakeTx = {
    marketState: {
      upsert: (args: unknown) => {
        upsertArgs.push(args);
        return Promise.resolve({});
      },
    },
  };
  const fakeClient = {
    $transaction: async (arg0: unknown, options?: { timeout?: number; maxWait?: number }) => {
      const before = upsertArgs.length;
      const isFn = typeof arg0 === 'function';
      if (isFn) await (arg0 as (tx: unknown) => Promise<void>)(fakeTx);
      fakeCalls.push({ isFn, timeout: options?.timeout, maxWait: options?.maxWait, count: upsertArgs.length - before });
      return [];
    },
  };

  const baseRow = toMarketStateRow(bullState, 'backfill', rowNow);
  const manyRows = Array.from({ length: 45 }, (_, i) => ({ ...baseRow, asOf: new Date(Date.UTC(2026, 7, 1 + i)) }));
  const written = await saveMarketStates(fakeClient as unknown as PrismaClient, manyRows);
  check('save: retorna total escrito', written === 45);
  check('save: um $transaction por lote', fakeCalls.length === 3);
  check('save: usa callback e não array', fakeCalls.every((c) => c.isFn === true));
  check('save: timeout >= 30000', fakeCalls.every((c) => (c.timeout ?? 0) >= 30000));
  check('save: timeout/maxWait das constantes', fakeCalls.every((c) => c.timeout === SAVE_TX_TIMEOUT_MS && c.maxWait === SAVE_TX_MAX_WAIT_MS));
  check('save: lote de no máximo 20', fakeCalls.every((c) => c.count <= 20));
  check('save: tamanhos dos lotes 20/20/5', fakeCalls.map((c) => c.count).join(',') === '20,20,5');
  check('save: SAVE_BATCH_SIZE = 20', SAVE_BATCH_SIZE === 20);

  // lote que falha: mensagem curta com intervalo, erro e aviso de idempotência
  let txCount = 0;
  const fakeFail = {
    $transaction: async (arg0: unknown) => {
      txCount++;
      if (typeof arg0 === 'function') await (arg0 as (tx: unknown) => Promise<void>)(fakeTx);
      if (txCount === 2) throw new Error('Transaction API error: expired transaction');
      return [];
    },
  };
  const origError = console.error;
  const errLines: string[] = [];
  console.error = ((...a: unknown[]) => {
    errLines.push(a.map((x) => String(x)).join(' '));
  }) as typeof console.error;
  let threw = false;
  try {
    await saveMarketStates(fakeFail as unknown as PrismaClient, manyRows);
  } catch {
    threw = true;
  } finally {
    console.error = origError;
  }
  const errText = errLines.join('\n');
  check('save: lote que falha lança erro', threw === true);
  check('save: mensagem tem o intervalo do lote', errText.includes('2026-08-21..2026-09-09'));
  check('save: mensagem avisa que repetir é seguro', errText.includes('rodar de novo é seguro (idempotente)'));
}

// ---------- Seção de banco (só com TEST_DATABASE_URL local:5433) ----------
async function runDbSection(url: string): Promise<void> {
  const TEST_FV = 'v1-compute-state-test';
  const KEEP_ASOF = '2001-01-03'; // data de teste isolada de qualquer dado real
  const CLEAN_FROM = new Date('2000-12-25T00:00:00Z');
  const CLEAN_TO = new Date('2001-01-04T00:00:00Z');
  const parsed = new URL(url);
  console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  const asOfMs = Date.UTC(2001, 0, 3);
  const asOfDate = new Date(asOfMs);

  try {
    // Cria a tabela SÓ no banco local (sem RLS, policy, grants nem papel).
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "MarketState" (
        "id" TEXT NOT NULL,
        "asOf" DATE NOT NULL,
        "stateVersion" TEXT NOT NULL,
        "rulesVersion" TEXT NOT NULL,
        "computeMode" TEXT NOT NULL,
        "dataQualityScore" DECIMAL(6,5) NOT NULL,
        "oldestDataDate" DATE,
        "payload" JSONB NOT NULL,
        "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "MarketState_pkey" PRIMARY KEY ("id")
      )
    `);
    await prisma.$executeRawUnsafe(
      `CREATE UNIQUE INDEX IF NOT EXISTS "MarketState_asOf_stateVersion_rulesVersion_computeMode_key"
         ON "MarketState"("asOf", "stateVersion", "rulesVersion", "computeMode")`
    );

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
      { indicator: 'dex_volume_vs_mean_7d', scope: 'solana', value: '0.08', asOf: new Date(asOfMs - 2 * DAY_MS) },
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

    const { from, to } = buildWindow(KEEP_ASOF, READ_WINDOW_DAYS);
    const rows = await loadIndicatorRows(prisma, from, to, TEST_FV);
    check('db: lê 9 linhas da versão de teste', rows.length === 9, `(recebeu ${rows.length})`);

    const lpSeeds = LAUNCHPAD_SLUGS.flatMap((slug) => {
      const scope = buildProtocolScope(slug);
      const asOf = new Date(asOfMs - 2 * DAY_MS);
      return [
        { indicator: 'launchpad_dex_volume_vs_mean_7d', scope, asOf, value: '0.30' },
        { indicator: 'launchpad_fees_vs_mean_7d', scope, asOf, value: '0.25' },
      ];
    });
    await prisma.indicatorSnapshot.createMany({
      data: lpSeeds.map((s) => ({
        indicator: s.indicator,
        scope: s.scope,
        asOf: s.asOf,
        status: 'ok',
        value: new Decimal(s.value),
        unit: 'FRACTION',
        inputCount: 7,
        formulaVersion: TEST_FV,
      })),
    });

    const rowsWithLaunchpads = await loadIndicatorRows(prisma, from, to, TEST_FV);
    check('db: lê 17 linhas com os 8 decisores launchpad', rowsWithLaunchpads.length === 17, `(recebeu ${rowsWithLaunchpads.length})`);
    const state = computeMarketState(buildMarketStateInput(rowsWithLaunchpads, KEEP_ASOF));
    check('db: launchpads strong com asOf próprio', state.launchpads.classification === 'strong'
      && state.launchpads.bySlug['pump.fun'].asOf === '2001-01-01');
    check('db: qualidade continua 9/9 com launchpads', state.data_quality.slotsOk === 9 && state.data_quality.slotsTotal === 9);
    check('db: tendência bullish', state.sol_trend.classification === 'bullish', `(${state.sol_trend.classification})`);

    const firstNow = new Date('2001-01-04T00:00:00Z');
    const liveWhere = {
      asOf_stateVersion_rulesVersion_computeMode: {
        asOf: asOfDate,
        stateVersion: state.stateVersion,
        rulesVersion: state.rulesVersion,
        computeMode: 'live' as const,
      },
    };

    // 1) grava o estado 'live'
    await saveMarketStates(prisma, [toMarketStateRow(state, 'live', firstNow)]);
    check('db: gravou 1 linha live', (await prisma.marketState.count({ where: { asOf: asOfDate, computeMode: 'live' } })) === 1);

    // 2) idempotência: gravar de novo no mesmo dia não duplica
    await saveMarketStates(prisma, [toMarketStateRow(state, 'live', new Date('2001-01-05T00:00:00Z'))]);
    check('db: re-gravar live não duplica', (await prisma.marketState.count({ where: { asOf: asOfDate, computeMode: 'live' } })) === 1);

    // 3) backfill NÃO sobrescreve a linha 'live'
    const liveBefore = await prisma.marketState.findUnique({ where: liveWhere });
    await saveMarketStates(prisma, [toMarketStateRow(state, 'backfill', new Date('2001-02-01T00:00:00Z'))]);
    const liveAfter = await prisma.marketState.findUnique({ where: liveWhere });
    check('db: backfill cria linha própria', (await prisma.marketState.count({ where: { asOf: asOfDate, computeMode: 'backfill' } })) === 1);
    check('db: backfill não altera computedAt do live', liveBefore?.computedAt.getTime() === liveAfter?.computedAt.getTime());
    check('db: live e backfill coexistem', (await prisma.marketState.count({ where: { asOf: asOfDate } })) === 2);

    // 4) backfill idempotente
    await saveMarketStates(prisma, [toMarketStateRow(state, 'backfill', new Date('2001-02-02T00:00:00Z'))]);
    check('db: re-gravar backfill não duplica', (await prisma.marketState.count({ where: { asOf: asOfDate } })) === 2);

    // 5) leitura de volta
    const readBack = await prisma.marketState.findUnique({ where: liveWhere });
    check('db: score lido 9/9', approx(Number(readBack?.dataQualityScore ?? 0), 1));
    check('db: oldestDataDate lido', readBack?.oldestDataDate?.toISOString() === '2001-01-01T00:00:00.000Z');

    // 6) score 0 não é gravado
    const emptyState = computeMarketState(buildMarketStateInput([], KEEP_ASOF));
    if (shouldPersist(emptyState)) await saveMarketStates(prisma, [toMarketStateRow(emptyState, 'backfill', firstNow)]);
    check('db: não grava score 0', (await prisma.marketState.count({ where: { asOf: asOfDate, computeMode: 'backfill' } })) === 1);

    // 7) v1 e v2 coexistem no mesmo asOf (chave inclui stateVersion/rulesVersion)
    const v1ComputedAt = new Date('2001-02-03T00:00:00Z');
    await prisma.marketState.create({
      data: {
        asOf: asOfDate,
        stateVersion: 'sol_state_v1',
        rulesVersion: 'state_rules_v1',
        computeMode: 'backfill',
        dataQualityScore: 1,
        oldestDataDate: new Date('2001-01-01T00:00:00Z'),
        payload: JSON.parse(JSON.stringify({ ...state, stateVersion: 'sol_state_v1', rulesVersion: 'state_rules_v1' })),
        computedAt: v1ComputedAt,
      },
    });
    const v1Where = {
      asOf_stateVersion_rulesVersion_computeMode: {
        asOf: asOfDate,
        stateVersion: 'sol_state_v1',
        rulesVersion: 'state_rules_v1',
        computeMode: 'backfill' as const,
      },
    };
    const v1Before = await prisma.marketState.findUnique({ where: v1Where });
    await saveMarketStates(prisma, [toMarketStateRow(state, 'backfill', new Date('2001-02-04T00:00:00Z'))]);
    const v1After = await prisma.marketState.findUnique({ where: v1Where });
    check('db: v1 coexiste com v2 no mesmo asOf/modo', v1Before !== null
      && (await prisma.marketState.count({ where: { asOf: asOfDate, computeMode: 'backfill' } })) === 2);
    check('db: regravar v2 não altera o payload v1', JSON.stringify(v1Before?.payload) === JSON.stringify(v1After?.payload));
    check('db: regravar v2 não altera o computedAt v1', v1Before?.computedAt.getTime() === v1After?.computedAt.getTime());
    check('db: total do dia inclui v1 e as duas linhas v2', (await prisma.marketState.count({ where: { asOf: asOfDate } })) === 3);
  } catch (e) {
    check('db: seção de banco executou', false, e instanceof Error ? e.message : String(e));
  } finally {
    try {
      await prisma.marketState.deleteMany({ where: { asOf: { gte: CLEAN_FROM, lte: CLEAN_TO } } });
      await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });
    } catch {
      // limpeza best-effort
    }
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  await runPureSection();

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
