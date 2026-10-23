#!/usr/bin/env node
import { buildProtocolScope, STATE_BACKFILL_AVAILABILITY_DELAY_DAYS } from '../config';
import {
  buildBackfillInputs,
  buildMarketStateInput,
  buildWindow,
  resolveAsOf,
  type IndicatorRowRaw,
} from './compute-state';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = '2026-10-17';
const DELAYED_DAY = new Date(Date.UTC(2026, 9, 17) - 2 * DAY_MS).toISOString().slice(0, 10);

function row(indicator: string, asOf: string, scope = 'solana'): IndicatorRowRaw {
  return {
    indicator,
    scope,
    asOf: new Date(`${asOf}T00:00:00Z`),
    status: 'ok',
    value: '0.1',
    unit: 'FRACTION',
    fromDate: null,
    toDate: null,
    reason: null,
  };
}

function backfillIndicators(rows: readonly IndicatorRowRaw[]): readonly { indicator: string; asOf: string }[] {
  return buildBackfillInputs(rows, [DAY])[0].indicators;
}

console.log('=== TESTES DE DISPONIBILIDADE NO BACKFILL ===\n');

check('constante: atraso de 2 dias', STATE_BACKFILL_AVAILABILITY_DELAY_DAYS === 2, `(${STATE_BACKFILL_AVAILABILITY_DELAY_DAYS})`);
check('auxiliar: dia-2 calculado em UTC', DELAYED_DAY === '2026-10-15', `(${DELAYED_DAY})`);

const dex = backfillIndicators([
  row('dex_volume_vs_mean_7d', DAY),
  row('dex_volume_vs_mean_7d', DELAYED_DAY),
]);
check('dex: linha do dia fica de fora', !dex.some((ind) => ind.asOf === DAY));
check('dex: linha do dia-2 entra', dex.some((ind) => ind.asOf === DELAYED_DAY));

const launchpadScope = buildProtocolScope('pump.fun');
const launchpad = backfillIndicators([
  row('launchpad_fees_vs_mean_7d', DAY, launchpadScope),
  row('launchpad_fees_vs_mean_7d', DELAYED_DAY, launchpadScope),
]);
check('launchpad: linha do dia fica de fora', !launchpad.some((ind) => ind.asOf === DAY));
check('launchpad: linha do dia-2 entra', launchpad.some((ind) => ind.asOf === DELAYED_DAY));

const ret = backfillIndicators([
  row('return_7d', DAY),
  row('return_7d', DELAYED_DAY),
]);
check('return: linha do dia entra', ret.some((ind) => ind.asOf === DAY));
check('return: linha do dia-2 entra', ret.some((ind) => ind.asOf === DELAYED_DAY));

const otherDex = backfillIndicators([row('dex_volume_daily_usd', DAY)]);
check('outros indicadores: corte continua no dia', otherDex.some((ind) => ind.asOf === DAY));

const win = buildWindow(DAY, 10);
check('live: buildWindow from = dia-9', win.from.toISOString() === '2026-10-08T00:00:00.000Z', `(${win.from.toISOString()})`);
check('live: buildWindow to = dia', win.to.toISOString() === '2026-10-17T00:00:00.000Z', `(${win.to.toISOString()})`);

const resolved = resolveAsOf(new Date('2026-10-18T10:00:00Z'), []);
check('live: resolveAsOf continua ontem', resolved.asOf === DAY && resolved.error === null, `(${resolved.asOf})`);

const liveInput = buildMarketStateInput([row('dex_volume_vs_mean_7d', DAY)], DAY);
check('live: buildMarketStateInput mantém a linha do dia', liveInput.indicators.length === 1 && liveInput.indicators[0].asOf === DAY);

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
