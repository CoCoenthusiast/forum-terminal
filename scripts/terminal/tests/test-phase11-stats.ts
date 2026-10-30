#!/usr/bin/env node

import {
  HORIZONS,
  MIN_GROUP_DAYS,
  QUARTILE_HIGH,
  QUARTILE_LOW,
  assignGroup,
  compareToBaseline,
  forwardReturns,
  groupByLabel,
  judgeGroup,
  lagSeries,
  quartileCuts,
  splitHalves,
  summarizeGroup,
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

function row(date: string, horizon: number, value: number | null): ForwardReturnRow {
  return { date, returns: { [horizon]: value } };
}

const closes = [
  { date: '2024-01-01', closeUsd: 100 },
  { date: '2024-01-02', closeUsd: 110 },
  { date: '2024-01-03', closeUsd: 121 },
  { date: '2024-01-04', closeUsd: 133.1 },
  { date: '2024-01-05', closeUsd: null },
  { date: '2024-01-08', closeUsd: 146.41 },
];

const forward = forwardReturns(closes, HORIZONS);
const byDate = new Map(forward.map((item) => [item.date, item.returns]));

check(
  'retorno 1d em % usa dias corridos',
  close(byDate.get('2024-01-01')?.[1] ?? 0) === 10
);
check(
  'retorno 3d em % usa dias corridos',
  close(byDate.get('2024-01-01')?.[3] ?? 0) === 33.1
);
check(
  'retorno 7d em % usa dias corridos',
  close(byDate.get('2024-01-01')?.[7] ?? 0) === 46.41
);
check(
  'dia faltando devolve null sem pular para o próximo',
  byDate.get('2024-01-04')?.[1] === null &&
    byDate.get('2024-01-05')?.[1] === null
);
check(
  'D+7 além do fim devolve null',
  byDate.get('2024-01-08')?.[7] === null
);

const halves = splitHalves([
  '2024-01-05',
  '2024-01-01',
  '2024-01-04',
  '2024-01-02',
  '2024-01-03',
]);
check(
  'metades com 5 dias: floor(5/2)=2 e 3',
  halves.firstHalf.length === 2 &&
    halves.secondHalf.length === 3 &&
    halves.firstHalf[0] === '2024-01-01' &&
    halves.secondHalf[0] === '2024-01-03'
);

const known = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const cuts = quartileCuts([null, ...known, undefined]);
check(
  'quartis iguais ao percentile_cont',
  cuts !== null && cuts.p25 === 5.75 && cuts.p75 === 15.25
);
check(
  'menos de MIN_GROUP_DAYS devolve null',
  quartileCuts(known.slice(0, MIN_GROUP_DAYS - 1)) === null
);
check(
  'assignGroup usa limites inclusivos',
  cuts !== null &&
    assignGroup(5.75, cuts) === 'low' &&
    assignGroup(10, cuts) === 'mid' &&
    assignGroup(15.25, cuts) === 'high' &&
    assignGroup(null, cuts) === null &&
    assignGroup(10, null) === null
);

const lagged = lagSeries(
  {
    '2024-01-01': 10,
    '2024-01-02': 20,
    '2024-01-03': 30,
    '2024-01-04': null,
    '2024-01-05': 50,
  },
  2
);
check(
  'lagSeries delay 2 usa D-2 e null quando falta',
  lagged['2024-01-01'] === null &&
    lagged['2024-01-02'] === null &&
    lagged['2024-01-03'] === 10 &&
    lagged['2024-01-04'] === 20 &&
    lagged['2024-01-05'] === 30
);

const summary = summarizeGroup(
  [
    row('2024-01-01', 3, 10),
    row('2024-01-02', 3, -5),
    row('2024-01-03', 3, 0),
    row('2024-01-04', 3, 20),
    row('2024-01-05', 3, null),
  ],
  3
);
check(
  'summarizeGroup ignora null e calcula n independente',
  summary.n === 4 &&
    summary.nIndependent === 1 &&
    summary.mean === 6.25 &&
    summary.median === 5 &&
    summary.positivePct === 50
);

const baseline = summarizeGroup(
  [
    row('2024-01-01', 3, 5),
    row('2024-01-02', 3, 5),
    row('2024-01-03', 3, 5),
    row('2024-01-04', 3, 5),
  ],
  3
);
check(
  'compareToBaseline subtrai a média geral',
  compareToBaseline(summary, baseline) === 1.25
);

check(
  'judgeGroup indicio com n suficiente e mesmo sinal',
  judgeGroup({ n: 25, difference: 2 }, { n: 30, difference: 1 }) === 'indicio' &&
    judgeGroup(
      { group: { ...summary, n: 25 }, baseline: { ...baseline, mean: 0 } },
      { group: { ...summary, n: 30, mean: -2 }, baseline: { ...baseline, mean: -5 } }
    ) === 'indicio'
);
check(
  'judgeGroup amostra_pequena se qualquer metade tem n baixo',
  judgeGroup({ n: 19, difference: 2 }, { n: 30, difference: 1 }) ===
    'amostra_pequena' &&
    judgeGroup({ n: 30, difference: 2 }, { n: 1, difference: 1 }) ===
      'amostra_pequena'
);
check(
  'judgeGroup sem_evidencia com sinais diferentes ou diferença nula',
  judgeGroup({ n: 25, difference: 2 }, { n: 30, difference: -1 }) ===
    'sem_evidencia' &&
    judgeGroup({ n: 25, difference: 0 }, { n: 30, difference: 0 }) ===
      'sem_evidencia'
);

const datedRows = [
  { date: '2024-01-05', label: 'trend_up_confirmed' },
  { date: '2024-01-06', label: 'trend_up_unconfirmed' },
  { date: '2024-01-07', label: 'range_neutral' },
  { date: '2024-01-08', label: 'trend_down_unconfirmed' },
  { date: '2024-01-09', label: 'trend_down_confirmed' },
  { date: '2024-01-10', label: 'weak_without_trend' },
  { date: '2024-01-11', label: 'strong_without_trend' },
  { date: '2024-01-12', label: 'conflicting' },
  { date: '2024-01-13', label: 'insufficient_data' },
];
const regimes = groupByLabel(datedRows, (item) => item.label);
const calendar = groupByLabel(datedRows, (item) => item.label);

check(
  'groupByLabel agrupa os 9 regimes',
  Object.keys(regimes).length === 9 &&
    regimes.trend_up_confirmed?.length === 1 &&
    regimes.insufficient_data?.length === 1
);
check(
  'groupByLabel separa sábado e domingo em weekend',
  calendar.weekend.length === 3 &&
    calendar.weekday.length === 6 &&
    calendar.byWeekend.weekend.length === 3 &&
    calendar.byWeekend.weekday.length === 6 &&
    calendar.byWeekday.saturday?.length === 2 &&
    calendar.byWeekday.sunday?.length === 1
);

check(
  'constantes únicas e exportadas',
  HORIZONS.length === 3 &&
    HORIZONS[0] === 1 &&
    HORIZONS[1] === 3 &&
    HORIZONS[2] === 7 &&
    MIN_GROUP_DAYS === 20 &&
    QUARTILE_LOW === 0.25 &&
    QUARTILE_HIGH === 0.75
);

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
if (failures > 0) process.exitCode = 1;
