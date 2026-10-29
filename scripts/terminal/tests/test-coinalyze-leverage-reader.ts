#!/usr/bin/env node

import { macroKnownCutoff, type MacroObservationRowInput } from '../indicators/macro-reader';
import {
  buildCoinalyzeLeverageAsOfRange,
  buildCoinalyzeLeverageSnapshotRows,
  parseComputeCoinalyzeLeverageArgs,
} from '../indicators/compute-coinalyze-leverage';
import {
  COINALYZE_LEVERAGE_SERIES_IDS,
  readCoinalyzeObservationsFromRows,
  selectCoinalyzeKnownSeries,
} from '../indicators/coinalyze-leverage-reader';
import {
  coinalyzeLeverageSeriesIds,
  type CoinalyzeLeverageCoin,
} from '../indicators/coinalyze-leverage-catalog';
import { coinalyzeFunding7dMean } from '../indicators/coinalyze-leverage-formulas';

const AS_OF = '2026-10-26';
const CUTOFF = '2026-10-27T01:00:00.000Z';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function row(
  seriesId: string,
  refDate: string,
  value: string | number | null,
  firstSeenAt: string,
  status = 'ok'
): MacroObservationRowInput {
  return {
    seriesId,
    refDate: new Date(`${refDate}T00:00:00.000Z`),
    value,
    status,
    firstSeenAt: new Date(firstSeenAt),
  };
}

function allBeforeCutoff(rows: readonly MacroObservationRowInput[]): boolean {
  const cutoff = new Date(CUTOFF).getTime();
  return rows.every((item) => item.firstSeenAt.getTime() < cutoff);
}

function runSelection(): void {
  const ids = coinalyzeLeverageSeriesIds('SOL');
  const rows: MacroObservationRowInput[] = [
    row(ids.oi, '2026-10-26', '100', '2026-10-27T00:00:00.000Z'),
    row(ids.oi, '2026-10-26', '150', '2026-10-27T00:30:00.000Z'),
    row(ids.oi, '2026-10-26', '200', '2026-10-27T01:00:00.000Z'),
    row(ids.oi, '2026-10-23', '300', '2026-10-27T02:00:00.000Z'),
    row(ids.oi, '2026-10-22', '5', '2026-10-26T12:00:00.000Z'),
    row(ids.oi, '2026-10-21', '7', '2026-10-26T10:00:00.000Z'),
    row(ids.oi, '2026-10-21', '9', '2026-10-27T00:15:00.000Z', 'error'),
    row(ids.oi, '2026-10-20', '11', '2026-10-26T10:00:00.000Z'),
    row(ids.oi, '2026-10-20', null, '2026-10-27T00:15:00.000Z'),
  ];

  const selected = selectCoinalyzeKnownSeries(rows, ids.oi, AS_OF);
  const byDate = new Map(
    selected.map((item) => [item.refDate.toISOString().slice(0, 10), item.value.toString()])
  );

  check(
    'versão mais recente antes do corte vale',
    byDate.get('2026-10-26') === '150',
    `(value=${byDate.get('2026-10-26')})`
  );
  check(
    'versão revisada depois do corte não vale',
    byDate.get('2026-10-26') !== '200' &&
      byDate.has('2026-10-23') === false
  );
  check(
    'versão antiga válida continua valendo',
    byDate.get('2026-10-22') === '5'
  );
  check(
    'status diferente de ok vira ausente sem usar versão antiga',
    byDate.has('2026-10-21') === false
  );
  check(
    'valor nulo na versão mais recente vira ausente',
    byDate.has('2026-10-20') === false
  );
  check(
    'leitor nunca devolve firstSeenAt no corte ou depois',
    allBeforeCutoff(rows.filter((item) => selected.some(
      (point) => point.firstSeenAt.getTime() === item.firstSeenAt.getTime()
    )))
  );
  check(
    'dia faltando fica ausente',
    byDate.has('2026-10-24') === false && byDate.has('2026-10-25') === false
  );
}

function runMissingWindow(): void {
  const ids = coinalyzeLeverageSeriesIds('SOL');
  const rows: MacroObservationRowInput[] = [];

  for (let day = 20; day <= 26; day++) {
    if (day === 23) continue;
    rows.push(
      row(ids.funding, `2026-10-${day}`, String((day - 19) / 100), '2026-10-27T00:00:00.000Z')
    );
  }

  rows.push(
    row(ids.funding, '2026-10-27', '999', '2026-10-26T12:00:00.000Z')
  );

  const selected = readCoinalyzeObservationsFromRows(rows, AS_OF, [ids.funding]);
  const points = selected[ids.funding];

  check(
    'refDate futuro não entra mesmo com firstSeenAt antigo',
    points.every((point) => point.refDate.toISOString().slice(0, 10) <= AS_OF)
  );
  check(
    'janela com dia faltando devolve null na fórmula',
    coinalyzeFunding7dMean(points, AS_OF) === null
  );
}

function completeRows(coin: CoinalyzeLeverageCoin): MacroObservationRowInput[] {
  const ids = coinalyzeLeverageSeriesIds(coin);
  const rows: MacroObservationRowInput[] = [];
  const firstSeen = '2026-10-27T00:00:00.000Z';

  const oiValues: Record<string, string> = {
    '2026-10-19': '100',
    '2026-10-20': '101',
    '2026-10-21': '102',
    '2026-10-22': '103',
    '2026-10-23': '104',
    '2026-10-24': '105',
    '2026-10-25': '100',
    '2026-10-26': '110',
  };

  for (const [date, value] of Object.entries(oiValues)) {
    rows.push(row(ids.oi, date, value, firstSeen));
  }

  rows.push(row(ids.liqLong, '2026-10-19', '60', firstSeen));
  rows.push(row(ids.liqShort, '2026-10-19', '40', firstSeen));

  for (let day = 20; day <= 26; day++) {
    const date = `2026-10-${day}`;
    rows.push(row(ids.funding, date, String((day - 19) / 100), firstSeen));
    rows.push(row(ids.longShortRatio, date, String((day - 9) / 10), firstSeen));
    rows.push(row(ids.liqLong, date, '60', firstSeen));
    rows.push(row(ids.liqShort, date, '40', firstSeen));
  }

  rows.push(row(ids.liqLong, '2026-10-26', '70', firstSeen));
  rows.push(row(ids.liqShort, '2026-10-26', '30', firstSeen));

  return rows;
}

function runCompute(): void {
  const range = buildCoinalyzeLeverageAsOfRange(
    parseComputeCoinalyzeLeverageArgs(['--dry-run'], new Date('2026-10-27T12:00:00.000Z')),
    new Date('2026-10-27T12:00:00.000Z')
  );
  const computed = buildCoinalyzeLeverageSnapshotRows(
    [
      ...completeRows('SOL'),
      ...completeRows('BTC'),
      ...completeRows('ETH'),
    ],
    [AS_OF],
    new Date('2026-10-27T12:00:00.000Z')
  );
  const sol = computed.rows.filter((item) => item.scope === 'coinalyze:SOL');
  const byIndicator = new Map(sol.map((item) => [item.indicator, item.value?.toString()]));

  check(
    'intervalo padrão termina ontem e tem 5 dias',
    range.to === '2026-10-26' && range.from === '2026-10-22' && range.asOfs.length === 5
  );
  check(
    'linhas em memória: 18 por asOf',
    COINALYZE_LEVERAGE_SERIES_IDS.length === 15 &&
      computed.rows.length === 18 &&
      computed.nullCount === 0 &&
      computed.firstCompleteAsOf === AS_OF
  );
  check(
    'catálogo preenche os 6 indicadores por moeda',
    sol.length === 6 && sol.every((item) => item.formulaVersion === 'coinalyze_leverage_v1')
  );
  check(
    'valores do dry-run conferem',
    byIndicator.get('oi_usd_change_1d_pct') === '10' &&
      byIndicator.get('oi_usd_change_7d_pct') === '10' &&
      byIndicator.get('funding_7d_mean') === '0.04' &&
      byIndicator.get('long_short_ratio_7d_mean') === '1.4' &&
      byIndicator.get('liq_total_vs_mean7d_pct') === '100' &&
      byIndicator.get('liq_long_share_pct') === '70'
  );
}

runSelection();
runMissingWindow();
runCompute();

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exitCode = failures === 0 ? 0 : 1;
