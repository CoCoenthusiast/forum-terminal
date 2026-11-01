#!/usr/bin/env node

import {
  collectionStatus,
  coinalyzeStatus,
  dailyCloseStatus,
  dexStatus,
  dollarStatus,
  evaluateFreshness,
  exitCodeFor,
  launchpadStatus,
  priceStatus,
  realYieldStatus,
  resolveReferenceDate,
  returnStatus,
  stateStatus,
  worstStatus,
  type FreshnessInput,
  type FreshnessResult,
} from '../checks/freshness-rules';

let passed = 0;
let failures = 0;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DATE = '2026-10-17';
const NOW = new Date('2026-10-17T12:00:00.000Z');

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function daysBack(value: string, days: number): Date {
  return new Date(Date.parse(`${value}T00:00:00.000Z`) - days * DAY_MS);
}

function hoursAgo(hours: number): Date {
  return new Date(NOW.getTime() - hours * HOUR_MS);
}

function baseInput(): FreshnessInput {
  return {
    date: DATE,
    now: NOW,
    prices: ['SOL', 'BTC', 'ETH'].map((label) => ({
      label,
      collectedAt: hoursAgo(36),
    })),
    returns: ['SOL', 'BTC', 'ETH'].flatMap((label) => [
      { item: `Return 1d ${label}`, asOf: daysBack(DATE, 0) },
      { item: `Return 7d ${label}`, asOf: daysBack(DATE, 0) },
    ]),
    stateAsOf: daysBack(DATE, 0),
    dailyCloseDate: daysBack(DATE, 0),
    coinalyzeAsOf: daysBack(DATE, 0),
    dollarToDate: daysBack(DATE, 10),
    realYieldToDate: daysBack(DATE, 5),
    dexToDate: daysBack(DATE, 4),
    launchpads: [
      { slug: 'pump.fun', toDate: daysBack(DATE, 4) },
      { slug: 'pumpswap', toDate: daysBack(DATE, 4) },
      { slug: 'launchlab', toDate: daysBack(DATE, 4) },
      {
        slug: 'meteora-dynamic-bonding-curve',
        toDate: daysBack(DATE, 4),
      },
    ],
    lastSuccessfulCollectionAt: hoursAgo(3),
  };
}

function statusOf(
  results: readonly FreshnessResult[],
  item: string
): FreshnessResult | null {
  return results.find((result) => result.item === item) ?? null;
}

check(
  'data padrão é ontem em UTC',
  resolveReferenceDate([], new Date('2026-11-01T00:30:00.000Z')).date ===
    '2026-10-31'
);
check(
  'data padrão cruza o mês em UTC',
  resolveReferenceDate([], new Date('2026-10-01T12:00:00.000Z')).date ===
    '2026-09-30'
);
check(
  'argumento --date é aceito',
  resolveReferenceDate(['--date=2026-10-10'], NOW).date === '2026-10-10'
);

check('preço exatamente 36h = OK', priceStatus(hoursAgo(36), NOW) === 'OK');
check(
  'preço acima de 36h = FAIL',
  priceStatus(new Date(hoursAgo(36).getTime() - 1), NOW) === 'FAIL'
);
check('preço ausente = FAIL', priceStatus(null, NOW) === 'FAIL');

check('return asOf igual a D = OK', returnStatus(daysBack(DATE, 0), DATE) === 'OK');
check('return asOf antes de D = FAIL', returnStatus(daysBack(DATE, 1), DATE) === 'FAIL');
check('return ausente = FAIL', returnStatus(null, DATE) === 'FAIL');

check('state asOf igual a D = OK', stateStatus(daysBack(DATE, 0), DATE) === 'OK');
check('state asOf antes de D = FAIL', stateStatus(daysBack(DATE, 1), DATE) === 'FAIL');
check('state ausente = FAIL', stateStatus(null, DATE) === 'FAIL');

check(
  'fechamento em D = OK',
  dailyCloseStatus(daysBack(DATE, 0), DATE) === 'OK'
);
check(
  'fechamento antes de D = FAIL',
  dailyCloseStatus(daysBack(DATE, 1), DATE) === 'FAIL'
);
check('fechamento ausente = FAIL', dailyCloseStatus(null, DATE) === 'FAIL');

check('coinalyze atraso 0 = OK', coinalyzeStatus(daysBack(DATE, 0), DATE) === 'OK');
check('coinalyze atraso 1 = WARN', coinalyzeStatus(daysBack(DATE, 1), DATE) === 'WARN');
check('coinalyze atraso 2 = WARN', coinalyzeStatus(daysBack(DATE, 2), DATE) === 'WARN');
check('coinalyze atraso 3 = FAIL', coinalyzeStatus(daysBack(DATE, 3), DATE) === 'FAIL');
check('coinalyze ausente = FAIL', coinalyzeStatus(null, DATE) === 'FAIL');

check('dólar atraso 10 = OK', dollarStatus(daysBack(DATE, 10), DATE) === 'OK');
check('dólar atraso 11 = WARN', dollarStatus(daysBack(DATE, 11), DATE) === 'WARN');
check('dólar atraso 20 = WARN', dollarStatus(daysBack(DATE, 20), DATE) === 'WARN');
check('dólar atraso 21 = FAIL', dollarStatus(daysBack(DATE, 21), DATE) === 'FAIL');
check('dólar ausente = FAIL', dollarStatus(null, DATE) === 'FAIL');

check('juros reais atraso 5 = OK', realYieldStatus(daysBack(DATE, 5), DATE) === 'OK');
check('juros reais atraso 6 = WARN', realYieldStatus(daysBack(DATE, 6), DATE) === 'WARN');
check('juros reais atraso 10 = WARN', realYieldStatus(daysBack(DATE, 10), DATE) === 'WARN');
check('juros reais atraso 11 = FAIL', realYieldStatus(daysBack(DATE, 11), DATE) === 'FAIL');
check('juros reais ausente = FAIL', realYieldStatus(null, DATE) === 'FAIL');

check('DEX atraso 4 = OK', dexStatus(daysBack(DATE, 4), DATE) === 'OK');
check('DEX atraso 5 = WARN', dexStatus(daysBack(DATE, 5), DATE) === 'WARN');
check('DEX atraso 100 = WARN, nunca FAIL', dexStatus(daysBack(DATE, 100), DATE) === 'WARN');
check('DEX ausente = FAIL', dexStatus(null, DATE) === 'FAIL');

check(
  'launchpad atraso 4 = OK',
  launchpadStatus(daysBack(DATE, 4), DATE) === 'OK'
);
check(
  'launchpad atraso 5 = WARN',
  launchpadStatus(daysBack(DATE, 5), DATE) === 'WARN'
);
check('launchpad ausente = WARN', launchpadStatus(null, DATE) === 'WARN');

check('coleta exatamente 3h = OK', collectionStatus(hoursAgo(3), NOW) === 'OK');
check(
  'coleta acima de 3h = WARN',
  collectionStatus(new Date(hoursAgo(3).getTime() - 1), NOW) === 'WARN'
);
check('coleta exatamente 6h = WARN', collectionStatus(hoursAgo(6), NOW) === 'WARN');
check(
  'coleta acima de 6h = FAIL',
  collectionStatus(new Date(hoursAgo(6).getTime() - 1), NOW) === 'FAIL'
);
check('coleta ausente = FAIL', collectionStatus(null, NOW) === 'FAIL');

const baseResults = evaluateFreshness(baseInput());
check(
  'todos os itens nos limites leves = RESULT OK',
  worstStatus(baseResults) === 'OK' && exitCodeFor(baseResults) === 0
);

const partial = baseInput();
partial.launchpads = [
  { slug: 'pump.fun', toDate: daysBack(DATE, 0) },
  { slug: 'pumpswap', toDate: daysBack(DATE, 0) },
  { slug: 'launchlab', toDate: null },
  { slug: 'meteora-dynamic-bonding-curve', toDate: null },
];
const partialResults = evaluateFreshness(partial);
const coverage = statusOf(partialResults, 'Launchpad coverage');
check(
  'menos de 3 launchpads = WARN partial',
  coverage?.status === 'WARN' && coverage.detalhe.includes('partial') === true
);
check(
  'WARN vence OK e não gera exit 1',
  worstStatus(partialResults) === 'WARN' && exitCodeFor(partialResults) === 0
);

const missing = baseInput();
missing.stateAsOf = null;
const missingResults = evaluateFreshness(missing);
check(
  'item ausente = FAIL e exit 1',
  statusOf(missingResults, 'State')?.status === 'FAIL' &&
    worstStatus(missingResults) === 'FAIL' &&
    exitCodeFor(missingResults) === 1
);

const statusSample: FreshnessResult[] = [
  { item: 'A', status: 'OK', detalhe: '' },
  { item: 'B', status: 'WARN', detalhe: '' },
  { item: 'C', status: 'OK', detalhe: '' },
];
check('pior status é WARN', worstStatus(statusSample) === 'WARN');
check('WARN sozinho não gera exit 1', exitCodeFor(statusSample) === 0);
check(
  'FAIL vence WARN',
  worstStatus([...statusSample, { item: 'D', status: 'FAIL', detalhe: '' }]) ===
    'FAIL'
);
check(
  'FAIL gera exit 1',
  exitCodeFor([...statusSample, { item: 'D', status: 'FAIL', detalhe: '' }]) === 1
);

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
if (failures > 0) process.exitCode = 1;
