#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '../generated/db/client';
import { SAVE_TX_MAX_WAIT_MS, SAVE_TX_TIMEOUT_MS } from './compute-state';
import type { MarketState } from './market-state';
import { deriveRegime, type MarketStateWithRegime } from './regime';
import {
  ADD_REGIME_BATCH_SIZE,
  applyRegimeUpdates,
  hasRegime,
  parseArgs,
  planRegimeUpdates,
  summarizeByMode,
  summarizeSkipReasons,
  toRegimeUpdateArgs,
  validateClassificationPayload,
  type MarketStateSourceRow,
  type RegimeUpdate,
} from './add-regime';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function validPayload(): Record<string, unknown> {
  return {
    asOf: '2026-10-17',
    stateVersion: 'sol_state_v2',
    rulesVersion: 'state_rules_v2',
    sol_trend: { classification: 'bullish', evidence: [{ value: 0.05 }] },
    sol_relative_strength: { classification: 'strong', evidence: [] },
    spot: { classification: 'expanding' },
    onchain_liquidity: { classification: 'contracting' },
    leverage: { classification: 'unavailable' },
    launchpads: { classification: 'neutral' },
    macro: { classification: 'unavailable' },
    data_quality: { score: 1, slotsOk: 9, slotsTotal: 9, oldestAsOf: '2026-10-17' },
    rulesApplied: [],
    thresholdsUsed: { trend: 0.03 },
    extraField: { keep: true },
  };
}

function sourceRow(
  id: string,
  asOf: string,
  computeMode: string,
  payload: unknown
): MarketStateSourceRow {
  return { id, asOf: new Date(`${asOf}T00:00:00Z`), computeMode, payload };
}

async function run(): Promise<void> {
  check('args: padrão é dry-run', parseArgs([]).save === false);
  check('args: --save ativa gravação', parseArgs(['--save']).save === true);

  const valid = validPayload();
  check('payload válido detectado', validateClassificationPayload(valid).ok === true);
  check('payload sem regime', hasRegime(valid) === false);

  const withoutLaunchpads = validPayload();
  delete withoutLaunchpads.launchpads;
  const missing = validateClassificationPayload(withoutLaunchpads);
  check(
    'payload sem classificação é rejeitado',
    missing.ok === false && missing.reason === 'payload sem launchpads.classification'
  );

  const nonString = validPayload();
  (nonString.spot as Record<string, unknown>).classification = 123;
  const typed = validateClassificationPayload(nonString);
  check(
    'classificação não-string é rejeitada',
    typed.ok === false && typed.reason === 'spot.classification não é string'
  );

  const validLiveFirst = sourceRow('valid-live-1', '2026-10-03', 'live', validPayload());
  const validBackfill = sourceRow('valid-backfill', '2026-10-02', 'backfill', validPayload());
  const validLiveLast = sourceRow('valid-live-2', '2026-10-01', 'live', validPayload());
  const skippedRow = sourceRow('invalid', '2026-10-04', 'backfill', withoutLaunchpads);
  const alreadyWithRegime = sourceRow('already', '2026-10-05', 'live', {
    ...validPayload(),
    regime: { regimeId: 'range_neutral' },
  });

  const rows = [validLiveFirst, validBackfill, validLiveLast, skippedRow, alreadyWithRegime];
  const plan = planRegimeUpdates(rows);
  check('plano: 3 atualizações', plan.updates.length === 3);
  check('plano: 1 pulada', plan.skipped.length === 1);
  check('plano: 1 já tinha regime', plan.alreadyWithRegime === 1);
  check('plano: lidas = atualizações + puladas', plan.updates.length + plan.skipped.length === 4);
  check(
    'plano: linha já com regime não foi relida',
    plan.updates.every((u) => u.id !== 'already')
      && plan.skipped.every((s) => s.id !== 'already')
  );

  const skipped = plan.skipped[0];
  check('pulada: motivo', skipped?.reason === 'payload sem launchpads.classification');
  check('pulada: data registrada', skipped?.asOf.toISOString() === '2026-10-04T00:00:00.000Z');
  check('pulada: computeMode registrado', skipped?.computeMode === 'backfill');

  const update = plan.updates.find((u) => u.id === 'valid-live-1');
  check('atualização: linha válida encontrada', update !== undefined);

  if (update !== undefined) {
    const expected = validLiveFirst.payload as MarketState;
    const { regime, ...oldPayload } = update.payload as MarketStateWithRegime & Record<string, unknown>;
    check('payload antigo: todos os campos iguais', JSON.stringify(oldPayload) === JSON.stringify(expected));
    check('payload antigo: campos extras preservados', JSON.stringify(oldPayload.extraField) === JSON.stringify({ keep: true }));
    check('regime: chave acrescentada', regime !== undefined);
    check('regime: regimeId bate com deriveRegime', regime.regimeId === deriveRegime(expected).regimeId);
    check('regime: versão', regime.regimeRulesVersion === 'regime_rules_v1');
    check(
      'regime: decidedBy',
      regime.decidedBy.sol_trend === 'bullish'
        && regime.decidedBy.sol_relative_strength === 'strong'
    );
    check(
      'regime: context',
      regime.context.spot === 'expanding'
        && regime.context.onchain_liquidity === 'contracting'
        && regime.context.launchpads === 'neutral'
    );

    const args = toRegimeUpdateArgs(update);
    check('update: raiz só where/data', Object.keys(args).sort().join(',') === 'data,where');
    check('update: where só id', Object.keys(args.where).join(',') === 'id' && args.where.id === 'valid-live-1');
    check('update: data só payload', Object.keys(args.data).join(',') === 'payload');
    check('update: sem computedAt', !('computedAt' in args));
    check(
      'update: sem colunas da linha',
      !('asOf' in args)
        && !('stateVersion' in args)
        && !('rulesVersion' in args)
        && !('computeMode' in args)
        && !('dataQualityScore' in args)
        && !('oldestDataDate' in args)
    );
  }

  const idempotentRows: MarketStateSourceRow[] = plan.updates.map((u) => ({
    id: u.id,
    asOf: u.asOf,
    computeMode: u.computeMode,
    payload: u.payload,
  }));
  const secondPlan = planRegimeUpdates(idempotentRows);
  check(
    'idempotência: segunda execução não atualiza nem pula',
    secondPlan.updates.length === 0 && secondPlan.skipped.length === 0
  );
  check('idempotência: todas já têm regime', secondPlan.alreadyWithRegime === idempotentRows.length);

  const modeSummary = summarizeByMode(plan.updates);
  check('resumo: dois computeModes', modeSummary.map((m) => m.computeMode).join(',') === 'backfill,live');
  const liveSummary = modeSummary.find((m) => m.computeMode === 'live');
  check(
    'resumo: live primeira/última',
    liveSummary?.count === 2
      && liveSummary.firstAsOf === '2026-10-01'
      && liveSummary.lastAsOf === '2026-10-03'
  );
  const backfillSummary = modeSummary.find((m) => m.computeMode === 'backfill');
  check(
    'resumo: backfill primeira/última',
    backfillSummary?.count === 1
      && backfillSummary.firstAsOf === '2026-10-02'
      && backfillSummary.lastAsOf === '2026-10-02'
  );
  check('resumo: motivos das puladas', summarizeSkipReasons(plan.skipped) === 'payload sem launchpads.classification=1');

  check('lotes: tamanho 100', ADD_REGIME_BATCH_SIZE === 100);
  const bulkPayload = {
    ...validPayload(),
    regime: deriveRegime(validPayload() as unknown as MarketState),
  } as MarketStateWithRegime;
  const bulkUpdates: RegimeUpdate[] = Array.from({ length: 205 }, (_, i) => ({
    id: `bulk-${i}`,
    asOf: new Date(Date.UTC(2026, 0, 1 + i)),
    computeMode: 'backfill',
    payload: bulkPayload,
  }));

  const seenArgs: Array<{
    where: { id: string };
    data: { payload: unknown };
  }> = [];
  const txOptions: Array<{ timeout?: number; maxWait?: number }> = [];
  const batchSizes: number[] = [];
  const tx = {
    marketState: {
      update: async (args: { where: { id: string }; data: { payload: unknown } }) => {
        seenArgs.push(args);
        return {};
      },
    },
  };
  const fakePrisma = {
    $transaction: async (
      fn: (client: typeof tx) => Promise<void>,
      options: { timeout?: number; maxWait?: number }
    ) => {
      txOptions.push(options);
      const before = seenArgs.length;
      await fn(tx);
      batchSizes.push(seenArgs.length - before);
      return [];
    },
  };

  const written = await applyRegimeUpdates(fakePrisma as unknown as PrismaClient, bulkUpdates);
  check('lotes: retorno total', written === 205);
  check('lotes: três transações', txOptions.length === 3);
  check('lotes: 100/100/5', batchSizes.join(',') === '100,100,5');
  check(
    'lotes: timeout igual ao saveMarketStates',
    txOptions.every((o) => o.timeout === SAVE_TX_TIMEOUT_MS && o.maxWait === SAVE_TX_MAX_WAIT_MS)
  );
  check('lotes: update só com payload', seenArgs.every((a) => Object.keys(a.data).join(',') === 'payload'));
  check('lotes: update sem computedAt', seenArgs.every((a) => !('computedAt' in a)));
  check('lotes: update com where id', seenArgs.every((a) => Object.keys(a.where).join(',') === 'id'));

  let failedTransactions = 0;
  let stopped = false;
  const failingPrisma = {
    $transaction: async (fn: (client: typeof tx) => Promise<void>) => {
      failedTransactions++;
      if (failedTransactions === 2) throw new Error('falha simulada');
      await fn(tx);
      return [];
    },
  };
  try {
    await applyRegimeUpdates(failingPrisma as unknown as PrismaClient, bulkUpdates);
  } catch {
    stopped = true;
  }
  check('lotes: para no primeiro erro', stopped && failedTransactions === 2);

  console.log(`\n${passed} passaram, ${failures} falharam`);
  if (failures > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  run();
}
