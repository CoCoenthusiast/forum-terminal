import { priceSeries, metricSeries, marketFieldSeries } from './series';
import { simpleReturn, validateSeries, turnover } from './formulas';

let failures = 0;
let total = 0;

function check(nome: string, condicao: boolean): void {
  total++;
  if (condicao) {
    console.log('PASSOU: ' + nome);
  } else {
    console.log('FALHOU: ' + nome);
    failures++;
  }
}

// T1: priceSeries, linhas 'coingecko_history' em 2025-01-02T00:00:00.000Z=100 e 2025-01-03T00:00:00.000Z=110, todayUtc '2025-01-10' → [{2025-01-01,100},{2025-01-02,110}].
const t1Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: 100 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), priceUsd: 110 },
];
const t1Result = priceSeries(t1Rows, '2025-01-10');
check('T1 priceSeries',
  t1Result.series.length === 2 &&
  t1Result.series[0].date === '2025-01-01' && t1Result.series[0].value === 100 &&
  t1Result.series[1].date === '2025-01-02' && t1Result.series[1].value === 110 &&
  t1Result.meta.fromHistory === 2 && t1Result.meta.fromLive === 0 && t1Result.meta.ignored === 0
);

// T2: 'coingecko_history' em 2025-01-03T00:00:01.000Z=120, todayUtc '2025-01-10' → série vazia e meta.ignored=1
const t2Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:01.000Z'), priceUsd: 120 },
];
const t2Result = priceSeries(t2Rows, '2025-01-10');
check('T2 priceSeries fora do meio dia',
  t2Result.series.length === 0 && t2Result.meta.ignored === 1 && t2Result.meta.fromHistory === 0 && t2Result.meta.fromLive === 0
);

// T3: 'coingecko' em 2025-01-05T05:00:00Z=200, 2025-01-05T23:00:00Z=210, 2025-01-06T01:00:00Z=220, todayUtc '2025-01-07' → [{2025-01-05,210},{2025-01-06,220}]
const t3Rows = [
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T05:00:00.000Z'), priceUsd: 200 },
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T23:00:00.000Z'), priceUsd: 210 },
  { provider: 'coingecko', collectedAt: new Date('2025-01-06T01:00:00.000Z'), priceUsd: 220 },
];
const t3Result = priceSeries(t3Rows, '2025-01-07');
check('T3 priceSeries live',
  t3Result.series.length === 2 &&
  t3Result.series[0].date === '2025-01-05' && t3Result.series[0].value === 210 &&
  t3Result.series[1].date === '2025-01-06' && t3Result.series[1].value === 220
);

// T4: 'coingecko_history' 2025-01-06T00:00:00Z=205 mais 'coingecko' 2025-01-05T23:00:00Z=210, todayUtc '2025-01-10' → [{2025-01-05,205}], meta.fromHistory=1, meta.fromLive=0
const t4Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-06T00:00:00.000Z'), priceUsd: 205 },
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T23:00:00.000Z'), priceUsd: 210 },
];
const t4Result = priceSeries(t4Rows, '2025-01-10');
check('T4 history wins over live',
  t4Result.series.length === 1 &&
  t4Result.series[0].date === '2025-01-05' && t4Result.series[0].value === 205 &&
  t4Result.meta.fromHistory === 1 && t4Result.meta.fromLive === 0 && t4Result.meta.ignored === 0
);

// T5: 'coingecko' em 2025-01-07T03:00:00Z=50, todayUtc '2025-01-07' → série vazia
const t5Rows = [
  { provider: 'coingecko', collectedAt: new Date('2025-01-07T03:00:00.000Z'), priceUsd: 50 },
];
const t5Result = priceSeries(t5Rows, '2025-01-07');
check('T5 live fora do prazo',
  t5Result.series.length === 0 && t5Result.meta.ignored === 1
);

// T6: 'coingecko_history' à meia-noite com priceUsd 0, -1 e NaN (três linhas em dias diferentes) → série vazia, meta.ignored=3
const t6Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-01T00:00:00.000Z'), priceUsd: 0 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: -1 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), priceUsd: NaN },
];
const t6Result = priceSeries(t6Rows, '2025-01-10');
check('T6 priceUsd inválidos',
  t6Result.series.length === 0 && t6Result.meta.ignored === 3 && t6Result.meta.fromHistory === 0 && t6Result.meta.fromLive === 0
);

// T7: 4 linhas 'coingecko_history' embaralhadas (2025-01-05, 2025-01-02, 2025-01-04, 2025-01-03, todas T00:00:00Z, valores 5,2,4,3), todayUtc '2025-01-10' → datas 2025-01-01, 01-02, 01-03, 01-04 em ordem crescente com valores 2,3,4,5, e validateSeries(série) não lança
const t7Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-05T00:00:00.000Z'), priceUsd: 5 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: 2 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-04T00:00:00.000Z'), priceUsd: 4 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), priceUsd: 3 },
];
const t7Result = priceSeries(t7Rows, '2025-01-10');
// Verificar série em ordem crescente e validateSeries
check('T7 série ordenada',
  t7Result.series.length === 4 &&
  t7Result.series[0].date === '2025-01-01' && t7Result.series[0].value === 2 &&
  t7Result.series[1].date === '2025-01-02' && t7Result.series[1].value === 3 &&
  t7Result.series[2].date === '2025-01-03' && t7Result.series[2].value === 4 &&
  t7Result.series[3].date === '2025-01-04' && t7Result.series[3].value === 5
);
// Verificar validateSeries não lança
try {
  validateSeries(t7Result.series);
  check('T7 validateSeries não lança', true);
} catch {
  check('T7 validateSeries não lança', false);
}

// T8: metricSeries, providers {history:'defillama_history', live:'defillama'}; history 2025-01-01T00:00:00Z=5 e 2025-01-02T00:00:00Z=7; live 2025-01-02T10:00:00Z=9, 2025-01-03T10:00:00Z=8, 2025-01-03T20:00:00Z=9; todayUtc '2025-01-04' → [{01-01,5},{01-02,7},{01-03,9}]
const t8Rows = [
  { provider: 'defillama_history', collectedAt: new Date('2025-01-01T00:00:00.000Z'), value: 5 },
  { provider: 'defillama_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: 7 },
  { provider: 'defillama', collectedAt: new Date('2025-01-02T10:00:00.000Z'), value: 9 },
  { provider: 'defillama', collectedAt: new Date('2025-01-03T10:00:00.000Z'), value: 8 },
  { provider: 'defillama', collectedAt: new Date('2025-01-03T20:00:00.000Z'), value: 9 },
];
const t8Result = metricSeries(t8Rows, { history: 'defillama_history', live: 'defillama' }, '2025-01-04');
check('T8 metricSeries',
  t8Result.series.length === 3 &&
  t8Result.series[0].date === '2025-01-01' && t8Result.series[0].value === 5 &&
  t8Result.series[1].date === '2025-01-02' && t8Result.series[1].value === 7 &&
  t8Result.series[2].date === '2025-01-03' && t8Result.series[2].value === 9
);

// T9: mesmas linhas de history/live mas só history 2025-01-01T00:00:00Z=5 e live 2025-01-02T10:00:00Z=9, providers.live = null, todayUtc '2025-01-04' → [{01-01,5}], meta.fromHistory=1, meta.fromLive=0, meta.ignored=1
const t9Rows = [
  { provider: 'defillama_history', collectedAt: new Date('2025-01-01T00:00:00.000Z'), value: 5 },
  { provider: 'defillama', collectedAt: new Date('2025-01-02T10:00:00.000Z'), value: 9 },
];
const t9Result = metricSeries(t9Rows, { history: 'defillama_history', live: null }, '2025-01-04');
check('T9 metricSeries live null',
  t9Result.series.length === 1 &&
  t9Result.series[0].date === '2025-01-01' && t9Result.series[0].value === 5 &&
  t9Result.meta.fromHistory === 1 && t9Result.meta.fromLive === 0 && t9Result.meta.ignored === 1
);

// T10: 10 linhas 'coingecko_history' com collectedAt de 2025-01-02T00:00:00.000Z até 2025-01-11T00:00:00.000Z (um dia de diferença) e priceUsd 100,101,...,109; todayUtc '2025-01-20'; s = priceSeries(...).series; r = simpleReturn(s,'2025-01-10',7); exigir s.length === 10, s[0].date === '2025-01-01', s[9].date === '2025-01-10', r.status === 'ok' e Math.abs(r.value - (109/102 - 1)) < 1e-9
const t10Rows = (() => {
  const rows = [];
  for (let i = 0; i < 10; i++) {
    const date = Date.UTC(2025, 0, 2 + i); // 2025-01-02 a 2025-01-11
    rows.push({ provider: 'coingecko_history', collectedAt: new Date(Date.UTC(2025, 0, 2 + i)), priceUsd: 100 + i });
  }
  return rows;
})();
const s = priceSeries(t10Rows, '2025-01-20').series;
check('T10 series length', s.length === 10 && s[0].date === '2025-01-01' && s[9].date === '2025-01-10');
const r = simpleReturn(s, '2025-01-10', 7);
check('T10 priceSeries + simpleReturn', r.status === 'ok' && Math.abs(r.value! - (109/102 - 1)) < 1e-9);
check('T10 simpleReturn status ok', r.status === 'ok');

// T11: 'coingecko_history' em 2025-01-10T00:00:00.000Z=130, todayUtc '2025-01-10' → [{2025-01-09,130}] (o ponto vale o dia anterior, que já está fechado)
const t11Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-10T00:00:00.000Z'), priceUsd: 130 },
];
const t11Result = priceSeries(t11Rows, '2025-01-10');
check('T11 priceSeries ponto anterior',
  t11Result.series.length === 1 &&
  t11Result.series[0].date === '2025-01-09' && t11Result.series[0].value === 130
);

// T12: 'coingecko' em 2025-01-05T05:00:00Z=200 e 2025-01-05T23:00:00Z=210, todayUtc '2025-01-07' → [{2025-01-05,210}] e meta.fromLive===1 (conta dias, não linhas)
const t12Rows = [
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T05:00:00.000Z'), priceUsd: 200 },
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T23:00:00.000Z'), priceUsd: 210 },
];
const t12Result = priceSeries(t12Rows, '2025-01-07');
check('T12 priceSeries fromLive',
  t12Result.series.length === 1 &&
  t12Result.series[0].date === '2025-01-05' && t12Result.series[0].value === 210 &&
  t12Result.meta.fromLive === 1
);

// Summary
if (failures > 0) process.exit(1);

// T13: history 2025-01-02T00:00:00.000Z=500 e 2025-01-03T00:00:00.000Z=600, allowZero false, todayUtc '2025-01-10' → [{2025-01-01,500},{2025-01-02,600}].
const t13Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: 500 },
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), value: 600 },
];
const t13Result = marketFieldSeries(t13Rows, false, '2025-01-10');
check('T13 history 2025-01-02 e 01-03',
  t13Result.series.length === 2 &&
  t13Result.series[0].date === '2025-01-01' && t13Result.series[0].value === 500 &&
  t13Result.series[1].date === '2025-01-02' && t13Result.series[1].value === 600 &&
  t13Result.meta.fromHistory === 2 && t13Result.meta.fromLive === 0 && t13Result.meta.ignored === 0
);

// T14: history 2025-01-02T00:00:00.000Z com value null, allowZero false → série vazia e meta.ignored === 1.
const t14Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: null },
];
const t14Result = marketFieldSeries(t14Rows, false, '2025-01-10');
check('T14 history value null',
  t14Result.series.length === 0 && t14Result.meta.ignored === 1
);

// T15: history 2025-01-02T00:00:00.000Z=0: com allowZero true → [{2025-01-01,0}]; com allowZero false → série vazia e meta.ignored === 1 (dois resultados, um só check).
const t15RowsTrue = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: 0 },
];
const t15ResultTrue = marketFieldSeries(t15RowsTrue, true, '2025-01-10');
check('T15 allowZero true',
  t15ResultTrue.series.length === 1 && t15ResultTrue.series[0].date === '2025-01-01' && t15ResultTrue.series[0].value === 0
);
const t15RowsFalse = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: 0 },
];
const t15ResultFalse = marketFieldSeries(t15RowsFalse, false, '2025-01-10');
check('T15 allowZero false',
  t15ResultFalse.series.length === 0 && t15ResultFalse.meta.ignored === 1
);

// T16: live 2025-01-05T05:00:00Z=7 e 2025-01-05T23:00:00Z=9, allowZero false, todayUtc '2025-01-07' → [{2025-01-05,9}] e meta.fromLive === 1.
const t16Rows = [
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T05:00:00.000Z'), value: 7 },
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T23:00:00.000Z'), value: 9 },
];
const t16Result = marketFieldSeries(t16Rows, false, '2025-01-07');
check('T16 live 2025-01-05',
  t16Result.series.length === 1 && t16Result.series[0].date === '2025-01-05' && t16Result.series[0].value === 9 &&
  t16Result.meta.fromLive === 1
);

// T17: history 2025-01-06T00:00:00Z=8 mais live 2025-01-05T23:00:00Z=9, todayUtc '2025-01-10' → [{2025-01-05,8}], meta.fromHistory === 1 e meta.fromLive === 0.
const t17Rows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-06T00:00:00.000Z'), value: 8 },
  { provider: 'coingecko', collectedAt: new Date('2025-01-05T23:00:00.000Z'), value: 9 },
];
const t17Result = marketFieldSeries(t17Rows, false, '2025-01-10');
check('T17 history + live',
  t17Result.series.length === 1 && t17Result.series[0].date === '2025-01-05' && t17Result.series[0].value === 8 &&
  t17Result.meta.fromHistory === 1 && t17Result.meta.fromLive === 0
);

// T18: integração: volume = marketFieldSeries com history 2025-01-11T00:00:00Z=50 (allowZero true); marketCap = marketFieldSeries com history 2025-01-11T00:00:00Z=200 (allowZero false); todayUtc '2025-01-20'; r = turnover(volume.series, marketCap.series, '2025-01-10'); exigir r.status === 'ok' e Math.abs(r2.value - 0.25) < 1e-9.
const t18VolumeRows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-11T00:00:00.000Z'), value: 50 },
];
const t18VolumeResult = marketFieldSeries(t18VolumeRows, true, '2025-01-20');
const t18MarketCapRows = [
  { provider: 'coingecko_history', collectedAt: new Date('2025-01-11T00:00:00.000Z'), value: 200 },
];
const t18MarketCapResult = marketFieldSeries(t18MarketCapRows, false, '2025-01-20');
const rTurnover = turnover(t18VolumeResult.series, t18MarketCapResult.series, '2025-01-10');
check('T18 turnover integration',
  rTurnover.status === 'ok' && Math.abs((rTurnover.value ?? 0) - 0.25) < 1e-9
);

console.log("RESULTADO: " + (total - failures) + " passaram, " + failures + " falharam");
if (failures > 0) process.exit(1);
