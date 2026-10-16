import { loadPriceSeries, loadVolumeSeries, loadMarketCapSeries, loadMetricSeries, SERIES_CATALOG, Reader } from './loaders';
import { simpleReturn } from './formulas';

type MarketRow = { provider: string; collectedAt: Date; priceUsd: unknown; volume24hUsd: unknown; marketCapUsd: unknown };
type MetricRow = { provider: string; collectedAt: Date; value: unknown };

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

function makeReader(marketRows: MarketRow[] = [], metricRows: MetricRow[] = []): { reader: Reader; marketCalls: { asset: string; from: Date; to: Date }[]; metricCalls: { scope: string; metric: string; providers: string[]; from: Date; to: Date }[] } {
  let marketIdx = 0;
  let metricIdx = 0;
  const marketCalls: { asset: string; from: Date; to: Date }[] = [];
  const metricCalls: { scope: string; metric: string; providers: string[]; from: Date; to: Date }[] = [];
  // Métodos async que retornam rows diretamente, satisfazendo a interface Reader
  const reader: Reader = {
    async marketSnapshotFindMany(args: { asset: string; from: Date; to: Date }) {
      marketCalls.push({ asset: args.asset, from: args.from, to: args.to });
      const rows: MarketRow[] = [];
      while (marketIdx < marketRows.length) {
        rows.push(marketRows[marketIdx]);
        marketIdx++;
      }
      return rows;
    },
    async metricSnapshotFindMany(args: { scope: string; metric: string; providers: string[]; from: Date; to: Date }) {
      metricCalls.push({ scope: args.scope, metric: args.metric, providers: args.providers, from: args.from, to: args.to });
      const rows: MetricRow[] = [];
      while (metricIdx < metricRows.length) {
        rows.push(metricRows[metricIdx]);
        metricIdx++;
      }
      return rows;
    }
  };
  return { reader, marketCalls, metricCalls };
}

async function main(): Promise<void> {
  // L1
  const { reader: reader1, marketCalls: mc1 } = makeReader(
    [
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: { toString: () => '100' }, volume24hUsd: '50', marketCapUsd: '200' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), priceUsd: { toString: () => '110' }, volume24hUsd: '51', marketCapUsd: '210' },
    ]
  );
  const r1 = await loadPriceSeries(reader1, 'solana', new Date('2025-01-02'), new Date('2025-01-03'), '2025-01-10');
  check('L1 series length', r1.series.length === 2);
  check('L1 series[0] date', r1.series[0].date === '2025-01-01');
  check('L1 series[0] value', r1.series[0].value === 100);
  check('L1 series[1] date', r1.series[1].date === '2025-01-02');
  check('L1 series[1] value', r1.series[1].value === 110);
  check('L1 reader received asset solana', mc1[0].asset === 'solana');

  // L2
  const { reader: reader2, marketCalls: mc2 } = makeReader(
    [
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: null, volume24hUsd: '200', marketCapUsd: '50000' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), priceUsd: 110, volume24hUsd: '210', marketCapUsd: '51000' },
    ]
  );
  const r2 = await loadPriceSeries(reader2, 'bitcoin', new Date('2025-01-02'), new Date('2025-01-03'), '2025-01-10');
  check('L2 series has 1 row', r2.series.length === 1);
  check('L2 series[0] value', r2.series[0].value === 110);
  check('L2 meta ignored', r2.meta.ignored === 1);

  // L3 volume
  const { reader: reader3V, marketCalls: mc3V } = makeReader(
    [
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: '100', volume24hUsd: '0', marketCapUsd: '200' },
    ]
  );
  const vResult = await loadVolumeSeries(reader3V, 'solana', new Date('2025-01-02'), new Date('2025-01-03'), '2025-01-10');
  check('L3 volume series has point', vResult.series.length === 1);
  check('L3 volume series value is 0', vResult.series[0].value === 0);

  // L3 marketCap
  const { reader: reader3M, marketCalls: mc3M } = makeReader(
    [
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: '100', volume24hUsd: '50', marketCapUsd: '0' },
    ]
  );
  const mResult = await loadMarketCapSeries(reader3M, 'solana', new Date('2025-01-02'), new Date('2025-01-03'), '2025-01-10');
  check('L3 marketCap series empty', mResult.series.length === 0);
  check('L3 marketCap meta ignored', mResult.meta.ignored === 1);

  // L4a
  const { reader: reader4a, metricCalls: metricCalls4a } = makeReader(
    [],
    [
      { provider: 'defillama_history', collectedAt: new Date('2025-01-01T00:00:00.000Z'), value: 50 },
      { provider: 'defillama_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: 60 },
    ]
  );
  const r4a = await loadMetricSeries(reader4a, 'solana', 'tvl_usd', { history: 'defillama_history', live: 'defillama' }, new Date('2025-01-01'), new Date('2025-01-03'), '2025-01-10');
  check('L4a series has 2 rows', r4a.series.length === 2);
  check('L4a fromHistory is 2', r4a.meta.fromHistory === 2);
  check('L4a fromLive is 0', r4a.meta.fromLive === 0);
  check('L4a metric received both providers', metricCalls4a[0].providers.length === 2);

  // L4b
  const { reader: reader4b, metricCalls: metricCalls4b } = makeReader(
    [],
    [
      { provider: 'defillama_history', collectedAt: new Date('2025-01-01T00:00:00.000Z'), value: 50 },
    ]
  );
  const r4b = await loadMetricSeries(reader4b, 'solana', 'tvl_usd', { history: 'defillama_history', live: null }, new Date('2025-01-01'), new Date('2025-01-03'), '2025-01-10');
  check('L4b series has 1 row', r4b.series.length === 1);
  check('L4b fromHistory is 1', r4b.meta.fromHistory === 1);
  check('L4b fromLive is 0', r4b.meta.fromLive === 0);
  check('L4b metric received only history', metricCalls4b[0].providers.length === 1 && metricCalls4b[0].providers[0] === 'defillama_history');

  // L5
  check('L5 catalog 12 keys', Object.keys(SERIES_CATALOG).length === 12);
  check('L5 dex exists', 'solanaDexVolume' in SERIES_CATALOG);

  // L6
  const { reader: reader6, marketCalls: mc6 } = makeReader(
    [
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), priceUsd: 100, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-03T00:00:00.000Z'), priceUsd: 101, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-04T00:00:00.000Z'), priceUsd: 102, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-05T00:00:00.000Z'), priceUsd: 103, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-06T00:00:00.000Z'), priceUsd: 104, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-07T00:00:00.000Z'), priceUsd: 105, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-08T00:00:00.000Z'), priceUsd: 106, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-09T00:00:00.000Z'), priceUsd: 107, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-10T00:00:00.000Z'), priceUsd: 108, volume24hUsd: '0', marketCapUsd: '0' },
      { provider: 'coingecko_history', collectedAt: new Date('2025-01-11T00:00:00.000Z'), priceUsd: 109, volume24hUsd: '0', marketCapUsd: '0' },
    ]
  );
  const r6 = await loadPriceSeries(reader6, 'test', new Date('2025-01-01'), new Date('2025-01-12'), '2025-01-20');
  const sr = simpleReturn(r6.series, '2025-01-10', 7);
  check('L6 simpleReturn status', sr.status === 'ok');
  check('L6 simpleReturn value', Math.abs(sr.value! - (109/102 - 1)) < 1e-9);

  // L7: loadMetricSeries com value null
  const { reader: reader7, metricCalls: metricCalls7 } = makeReader(
    [],
    [
      { provider: 'defillama_history', collectedAt: new Date('2025-01-01T00:00:00.000Z'), value: null },
      { provider: 'defillama_history', collectedAt: new Date('2025-01-02T00:00:00.000Z'), value: 60 },
    ]
  );
  const r7 = await loadMetricSeries(reader7, 'solana', 'tvl_usd', { history: 'defillama_history', live: 'defillama' }, new Date('2025-01-01'), new Date('2025-01-03'), '2025-01-10');
  check('L7 series has 1 row', r7.series.length === 1);
  check('L7 series[0] date', r7.series[0].date === '2025-01-02');
  check('L7 series[0] value', r7.series[0].value === 60);
  check('L7 meta ignored', r7.meta.ignored === 1);
}

main().then(() => {
  console.log('RESULTADO: ' + (total - failures) + ' passaram, ' + failures + ' falharam');
  if (failures > 0) process.exit(1);
});
