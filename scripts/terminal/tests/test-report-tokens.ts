#!/usr/bin/env node
import {
  POOL_WARNING,
  REPORT_HEADER,
  buildTokenReport,
  formatTokenReport,
  type ReportCapture,
  type ReportHolder,
  type ReportPool,
  type ReportSource,
} from '../report-tokens';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

const DAY = new Date('2026-10-23T15:00:00Z');
const PREVIOUS_DAY = new Date(DAY.getTime() - 24 * 60 * 60 * 1000);

function holder(count: number | null, top10: number | null, at: Date | null = null): ReportHolder {
  return { holdersCount: count, top10Pct: top10, sourceLastUpdated: at };
}

function capture(options: Partial<ReportCapture> & { capturedAt: Date }): ReportCapture {
  return {
    liquidityUsd: null,
    volume24hUsd: null,
    buys24hObserved: null,
    sells24hObserved: null,
    pools: [],
    holder: null,
    ...options,
  };
}

function token(symbol: string, captures: readonly ReportCapture[]): ReportSource {
  return {
    address: `ADDR_${symbol}`,
    name: `Token ${symbol}`,
    symbol,
    captures,
  };
}

console.log('=== TESTES DE report-tokens ===\n');

const skipped = buildTokenReport([token('SEM_CAPTURA', [])]);
check('token sem captura é ignorado', skipped.length === 0);

const nullRow = buildTokenReport([token('NULL', [capture({ capturedAt: DAY })])])[0];
check('null: giro n/d', nullRow.giro === null);
check('null: proporção de compras n/d', nullRow.buyRatio === null);
check('null: volume médio por transação n/d', nullRow.avgVolumePerTx === null);
check('null: holdersCount n/d', nullRow.holdersCount === null);
check('null: top10Pct n/d', nullRow.top10Pct === null);
check('null: sourceLastUpdated n/d', nullRow.sourceLastUpdated === null);

const nullText = formatTokenReport([nullRow]);
check('null: saída usa n/d', nullText.includes('giro=n/d') && nullText.includes('holdersCount=n/d'));
check('null: saída não usa 0', !nullText.includes('giro=0') && !nullText.includes('holdersCount=0'));

const zeroRow = buildTokenReport([
  token('ZERO', [
    capture({
      capturedAt: DAY,
      liquidityUsd: 0,
      volume24hUsd: 100,
      buys24hObserved: 0,
      sells24hObserved: 0,
    }),
  ]),
])[0];
check('divisão por zero: giro n/d', zeroRow.giro === null);
check('divisão por zero: proporção n/d', zeroRow.buyRatio === null);
check('divisão por zero: volume médio n/d', zeroRow.avgVolumePerTx === null);

const noPrevious = buildTokenReport([
  token('SEM_ANTERIOR', [
    capture({
      capturedAt: DAY,
      liquidityUsd: 100,
      volume24hUsd: 200,
      buys24hObserved: 10,
      sells24hObserved: 10,
      holder: holder(1000, 0.5, DAY),
    }),
  ]),
])[0];
check('sem captura anterior: liquidez n/d', noPrevious.liquidityChangePct === null);
check('sem captura anterior: holders n/d', noPrevious.holdersChangePct === null);
check('sem captura anterior: previousCapturedAt n/d', noPrevious.previousCapturedAt === null);

const withPrevious = buildTokenReport([
  token('COM_ANTERIOR', [
    capture({
      capturedAt: DAY,
      liquidityUsd: 120,
      volume24hUsd: 240,
      buys24hObserved: 10,
      sells24hObserved: 10,
      pools: [{ buyers24h: 5, sellers24h: 7 }],
      holder: holder(1200, 0.4, DAY),
    }),
    capture({
      capturedAt: PREVIOUS_DAY,
      liquidityUsd: 100,
      volume24hUsd: 100,
      buys24hObserved: 5,
      sells24hObserved: 5,
      holder: holder(1000, 0.5, PREVIOUS_DAY),
    }),
  ]),
])[0];
check(
  'com captura anterior: liquidez +20%',
  withPrevious.liquidityChangePct !== null && Math.abs(withPrevious.liquidityChangePct - 20) < 1e-9,
  `(${withPrevious.liquidityChangePct})`
);
check(
  'com captura anterior: holders +20%',
  withPrevious.holdersChangePct !== null && Math.abs(withPrevious.holdersChangePct - 20) < 1e-9,
  `(${withPrevious.holdersChangePct})`
);
check(
  'com captura anterior: escolhe a mais próxima de 24 h',
  withPrevious.previousCapturedAt?.getTime() === PREVIOUS_DAY.getTime()
);

const ranked = buildTokenReport([
  token('A', [
    capture({
      capturedAt: DAY,
      liquidityUsd: 100,
      volume24hUsd: 300,
      buys24hObserved: 90,
      sells24hObserved: 10,
      holder: holder(300, 0.3, DAY),
    }),
  ]),
  token('B', [
    capture({
      capturedAt: DAY,
      liquidityUsd: 100,
      volume24hUsd: 100,
      buys24hObserved: 10,
      sells24hObserved: 90,
      holder: holder(100, 0.1, DAY),
    }),
  ]),
  token('C', [
    capture({
      capturedAt: DAY,
      liquidityUsd: 100,
      volume24hUsd: 200,
      buys24hObserved: 50,
      sells24hObserved: 50,
      holder: holder(200, 0.2, DAY),
    }),
  ]),
]);
const bySymbol = new Map(ranked.map((row) => [row.symbol, row]));
check(
  'ranking giro: A #1, C #2, B #3',
  bySymbol.get('A')?.rankGiro === 1 && bySymbol.get('C')?.rankGiro === 2 && bySymbol.get('B')?.rankGiro === 3
);
check(
  'ranking compras: A #1, C #2, B #3',
  bySymbol.get('A')?.rankBuyRatio === 1
    && bySymbol.get('C')?.rankBuyRatio === 2
    && bySymbol.get('B')?.rankBuyRatio === 3
);
check(
  'ranking volume/tx: A #1, C #2, B #3',
  bySymbol.get('A')?.rankAvgVolumePerTx === 1
    && bySymbol.get('C')?.rankAvgVolumePerTx === 2
    && bySymbol.get('B')?.rankAvgVolumePerTx === 3
);
check(
  'ranking holders: A #1, C #2, B #3',
  bySymbol.get('A')?.rankHoldersCount === 1
    && bySymbol.get('C')?.rankHoldersCount === 2
    && bySymbol.get('B')?.rankHoldersCount === 3
);

const pools: ReportPool[] = [
  { buyers24h: 1, sellers24h: 10 },
  { buyers24h: 2, sellers24h: null },
  { buyers24h: null, sellers24h: 5 },
];
const poolRow = buildTokenReport([
  token('POOLS', [capture({ capturedAt: DAY, pools, holder: holder(10, 0.25, DAY) })]),
])[0];
check('pools: buyers somados', poolRow.buyers24h === 3, `(${poolRow.buyers24h})`);
check('pools: sellers somados', poolRow.sellers24h === 15, `(${poolRow.sellers24h})`);
const poolText = formatTokenReport([poolRow]);
check('pools: aviso presente', poolText.includes(POOL_WARNING));
check('cabeçalho fixo presente', poolText.includes(REPORT_HEADER));
check('rótulo sourceLastUpdated presente', poolText.includes('sourceLastUpdated='));

console.log('\n=== EXEMPLO DE SAÍDA (dados de teste) ===\n');
console.log(formatTokenReport([withPrevious]));

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
