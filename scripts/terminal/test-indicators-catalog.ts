#!/usr/bin/env node
import type { Reader } from './indicators/loaders';
import { loadAllSeries, computeIndicatorRows, validateRowInvariants, INDICATORS, type IndicatorRow, type SeriesMap, type AsOfDate } from './indicators/catalog';

interface MarketRow {
  provider: string;
  collectedAt: Date;
  priceUsd: unknown;
  volume24hUsd: unknown;
  marketCapUsd: unknown;
}
interface MetricRow {
  provider: string;
  collectedAt: Date;
  value: unknown;
}

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function approx(a: number | null, b: number, tol = 1e-9): boolean {
  return a !== null && Math.abs(a - b) < tol;
}

function makeReader(market: Record<string, MarketRow[]>, metrics: Record<string, MetricRow[]>) {
  const metricCalls: { scope: string; metric: string; providers: string[] }[] = [];
  const reader: Reader = {
    async marketSnapshotFindMany({ asset }) {
      return market[asset] ?? [];
    },
    async metricSnapshotFindMany({ scope, metric, providers }) {
      metricCalls.push({ scope, metric, providers });
      return (metrics[metric] ?? []).filter((r) => providers.includes(r.provider));
    },
  };
  return { reader, metricCalls };
}

const noon = (d: number) => new Date(Date.UTC(2025, 0, d, 12));
const midnight = (d: number) => new Date(Date.UTC(2025, 0, d, 0));

function findRow(rows: IndicatorRow[], indicator: string, scope: string, iso: string): IndicatorRow | undefined {
  return rows.find((r) => r.indicator === indicator && r.scope === scope && r.asOf.toISOString().slice(0, 10) === iso);
}

async function main(): Promise<void> {
  const solana: MarketRow[] = [];
  for (let i = 1; i <= 10; i++) {
    solana.push({
      provider: 'coingecko',
      collectedAt: noon(i),
      priceUsd: 99 + i,
      volume24hUsd: i >= 4 ? 2 * (i - 3) : null,
      marketCapUsd: null,
    });
  }
  const bitcoin: MarketRow[] = [];
  const ethereum: MarketRow[] = [];
  for (let i = 1; i <= 10; i++) {
    bitcoin.push({ provider: 'coingecko', collectedAt: noon(i), priceUsd: 50, volume24hUsd: null, marketCapUsd: null });
    ethereum.push({ provider: 'coingecko', collectedAt: noon(i), priceUsd: 20, volume24hUsd: null, marketCapUsd: null });
  }

  const metrics: Record<string, MetricRow[]> = {
    tvl_usd: [],
    stablecoin_supply_usd: [],
    dex_volume_daily_usd: [],
  };
  for (let i = 1; i <= 10; i++) {
    metrics.tvl_usd.push({ provider: 'defillama_history', collectedAt: midnight(i), value: 1000 + i * 100 });
    metrics.stablecoin_supply_usd.push({ provider: 'defillama_history', collectedAt: midnight(i), value: 500 + i * 10 });
  }
  for (let d = 4; d <= 10; d++) {
    metrics.dex_volume_daily_usd.push({ provider: 'defillama_history', collectedAt: midnight(d), value: 10 * (d - 3) });
  }

  const { reader, metricCalls } = makeReader({ solana, bitcoin, ethereum }, metrics);

  const todayUtc = '2025-01-20';
  const series: SeriesMap = await loadAllSeries(reader, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-20T00:00:00Z'), todayUtc);

  check('catalog 29 indicadores', INDICATORS.length === 29, `length=${INDICATORS.length}`);

  const asOfs: AsOfDate[] = ['2025-01-10', '2025-01-09', '2025-01-08'].map((iso) => ({ iso, date: new Date(`${iso}T00:00:00.000Z`) }));
  const { rows, statusCounts } = computeIndicatorRows(series, asOfs);

  // Valores calculados à mão (entradas conhecidas, sem alterar testes existentes).
  const ret7 = findRow(rows, 'return_7d', 'solana', '2025-01-10');
  check('return_7d solana ok', ret7?.status === 'ok', JSON.stringify(ret7?.status));
  check('return_7d solana valor = 109/102-1', approx(ret7?.value ? Number(ret7.value.toString()) : null, 109 / 102 - 1));

  const ret1 = findRow(rows, 'return_1d', 'solana', '2025-01-10');
  check('return_1d solana valor = 109/108-1', approx(ret1?.value ? Number(ret1.value.toString()) : null, 109 / 108 - 1));

  const rel7 = findRow(rows, 'relative_strength_7d', 'solana:bitcoin', '2025-01-10');
  check('relative_strength_7d solana:bitcoin valor = 109/102-1', approx(rel7?.value ? Number(rel7.value.toString()) : null, 109 / 102 - 1));

  const vol7 = findRow(rows, 'volume_vs_mean_7d', 'solana', '2025-01-10');
  check('volume_vs_mean_7d solana valor = 14/8-1', approx(vol7?.value ? Number(vol7.value.toString()) : null, 14 / 8 - 1));

  const dex7 = findRow(rows, 'dex_volume_vs_mean_7d', 'solana', '2025-01-10');
  check('dex_volume_vs_mean_7d solana valor = 70/40-1', approx(dex7?.value ? Number(dex7.value.toString()) : null, 70 / 40 - 1));

  check('dex usa só dex_volume_daily_usd com live=null',
    metricCalls.some((c) => c.metric === 'dex_volume_daily_usd' && c.providers.length === 1 && c.providers[0] === 'defillama_history') &&
    !metricCalls.some((c) => c.metric === 'dex_volume_24h_usd'));

  // insufficient_history
  const ret30 = findRow(rows, 'return_30d', 'solana', '2025-01-10');
  check('return_30d insufficient_history', ret30?.status === 'insufficient_history' && ret30?.value === null && ret30?.reason !== null);

  const vol30 = findRow(rows, 'volume_vs_mean_30d', 'solana', '2025-01-10');
  check('volume_vs_mean_30d insufficient_history (cobertura)', vol30?.status === 'insufficient_history' && vol30?.value === null);

  // atr unavailable, uma única vez
  const atrRows = rows.filter((r) => r.indicator === 'atr');
  check('atr gravado uma vez só', atrRows.length === 1, `count=${atrRows.length}`);
  check('atr unavailable com reason', atrRows[0]?.status === 'unavailable' && atrRows[0]?.value === null && atrRows[0]?.reason !== null);
  check('atr no asOf mais recente', atrRows[0]?.asOf.toISOString().slice(0, 10) === '2025-01-10');

  const problems = validateRowInvariants(rows);
  check('invariantes de linha ok (ok com inputCount/from/to; não-ok com reason)', problems.length === 0, problems.slice(0, 3).join(' | '));

  check('contagem por status preenchida', (statusCounts.ok ?? 0) > 0 && (statusCounts.insufficient_history ?? 0) > 0 && statusCounts.unavailable === 1,
    JSON.stringify(statusCounts));

  console.log(`=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
