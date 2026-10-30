#!/usr/bin/env node

import {
  PHASE11_QUESTION_RULES,
  PHASE11_REPORT_TITLE,
  applySignalLag,
  closesFromPriceRows,
  cutsFromFirstHalf,
  returnRowForSignalDate,
  returnStartDate,
  type DatedValue,
} from '../research/phase11-reader';
import {
  HORIZONS,
  forwardReturns,
  splitHalves,
  type ForwardReturnRow,
} from '../research/phase11-stats';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function close(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isoDay(offset: number): string {
  return new Date(Date.UTC(2024, 0, offset)).toISOString().slice(0, 10);
}

const priceRows = [
  { collectedAt: new Date('2024-01-02T00:00:00.000Z'), priceUsd: '110' },
  { collectedAt: new Date('2024-01-02T00:00:01.000Z'), priceUsd: '999' },
  { collectedAt: new Date('2024-01-03T00:00:00.000Z'), priceUsd: 121 },
  { collectedAt: new Date('2024-01-04T00:00:00.000Z'), priceUsd: null },
  { collectedAt: new Date('2024-01-05T00:00:00.000Z'), priceUsd: 130 },
];
const closes = closesFromPriceRows(priceRows);

check(
  'fechamento de D vem da linha D+1 00:00 UTC',
  closes.length === 3 &&
    closes[0]?.date === '2024-01-01' &&
    closes[0]?.closeUsd === 110 &&
    closes[1]?.date === '2024-01-02' &&
    closes[1]?.closeUsd === 121 &&
    closes[2]?.date === '2024-01-04' &&
    closes[2]?.closeUsd === 130
);
check(
  'linha fora de 00:00 e preço nulo não viram fechamento',
  closes.every((point) => point.closeUsd !== 999)
);

const prices = [
  { date: '2024-01-01', closeUsd: 100 },
  { date: '2024-01-02', closeUsd: 90 },
  { date: '2024-01-03', closeUsd: 99 },
  { date: '2024-01-04', closeUsd: 108.9 },
];
const missingReturns = forwardReturns(closes, HORIZONS);
const missingByDate = new Map<string, ForwardReturnRow>(
  missingReturns.map((row) => [row.date, row])
);
const returns = forwardReturns(prices, HORIZONS);
const byDate = new Map<string, ForwardReturnRow>(returns.map((row) => [row.date, row]));

check(
  'dia faltando devolve null no retorno',
  missingByDate.get('2024-01-02')?.returns[1] === null
);

const coinalyzeRow = returnRowForSignalDate(byDate, '2024-01-01', PHASE11_QUESTION_RULES.Q2);
const regimeRow = returnRowForSignalDate(byDate, '2024-01-01', PHASE11_QUESTION_RULES.Q1);

check(
  'sinal do Coinalyze parte de D+1',
  returnStartDate('2024-01-01', PHASE11_QUESTION_RULES.Q2) === '2024-01-02' &&
    close(coinalyzeRow?.returns[1] ?? 0) === 10 &&
    close(regimeRow?.returns[1] ?? 0) === -10
);

const visible = applySignalLag(
  {
    '2024-01-01': 10,
    '2024-01-02': 20,
    '2024-01-03': 30,
    '2024-01-04': 40,
  },
  PHASE11_QUESTION_RULES.Q6
);

check(
  'lag de 2 dias do spot usa D-2',
  PHASE11_QUESTION_RULES.Q6.signalLagDays === 2 &&
    visible['2024-01-01'] === null &&
    visible['2024-01-02'] === null &&
    visible['2024-01-03'] === 10 &&
    visible['2024-01-04'] === 20
);

const dates = Array.from({ length: 40 }, (_, index) => isoDay(index + 1));
const halves = splitHalves(dates);
const values: DatedValue[] = dates.map((date, index) => ({
  date,
  value: index < 20 ? index + 1 : 1000 + index,
}));
const cuts = cutsFromFirstHalf(values, halves.firstHalf);

check(
  'quartis usam somente a primeira metade',
  halves.firstHalf.length === 20 &&
    cuts !== null &&
    cuts.p25 === 5.75 &&
    cuts.p75 === 15.25
);
check(
  'cabeçalho contém a frase obrigatória',
  PHASE11_REPORT_TITLE ===
    'Indício não é prova. Janela de 12 meses, um único regime de mercado. Resultados exploratórios.'
);

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
if (failures > 0) process.exitCode = 1;
