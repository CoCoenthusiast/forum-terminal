#!/usr/bin/env node

import {
  coinalyzeFunding7dMean,
  coinalyzeLiqLongSharePct,
  coinalyzeLiqTotalVsMean7dPct,
  coinalyzeLongShortRatio7dMean,
  coinalyzeOiUsdChange1dPct,
  coinalyzeOiUsdChange7dPct,
  type CoinalyzeDailyPoint,
} from '../indicators/coinalyze-leverage-formulas';
import {
  COINALYZE_LEVERAGE_FORMULA_VERSION,
  COINALYZE_LEVERAGE_INDICATORS,
  COINALYZE_LEVERAGE_INDICATOR_NAMES,
  coinalyzeLeverageSeriesIds,
  computeCoinalyzeLeverageIndicators,
} from '../indicators/coinalyze-leverage-catalog';

const AS_OF = '2026-10-26';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function point(date: string, value: string | number | null): CoinalyzeDailyPoint {
  return { refDate: date, value };
}

function values(series: readonly CoinalyzeDailyPoint[]): string[] {
  return series.map((item) => `${String(item.refDate)}=${String(item.value)}`);
}

function oiSeries(): CoinalyzeDailyPoint[] {
  return [
    point('2026-10-18', '80'),
    point('2026-10-19', '100'),
    point('2026-10-20', '101'),
    point('2026-10-21', '102'),
    point('2026-10-22', '103'),
    point('2026-10-23', '104'),
    point('2026-10-24', '105'),
    point('2026-10-25', '100'),
    point('2026-10-26', '110'),
    point('2026-10-27', '999999'),
  ];
}

function fundingSeries(): CoinalyzeDailyPoint[] {
  return [
    point('2026-10-20', '0.01'),
    point('2026-10-21', '0.02'),
    point('2026-10-22', '0.03'),
    point('2026-10-23', '0.04'),
    point('2026-10-24', '0.05'),
    point('2026-10-25', '0.06'),
    point('2026-10-26', '0.07'),
    point('2026-10-27', '999'),
  ];
}

function ratioSeries(): CoinalyzeDailyPoint[] {
  return [
    point('2026-10-20', '1.1'),
    point('2026-10-21', '1.2'),
    point('2026-10-22', '1.3'),
    point('2026-10-23', '1.4'),
    point('2026-10-24', '1.5'),
    point('2026-10-25', '1.6'),
    point('2026-10-26', '1.7'),
    point('2026-10-27', '99'),
  ];
}

function liquidationSeries(longBase: string, shortBase: string): {
  long: CoinalyzeDailyPoint[];
  short: CoinalyzeDailyPoint[];
} {
  const long: CoinalyzeDailyPoint[] = [];
  const short: CoinalyzeDailyPoint[] = [];

  for (let day = 19; day <= 25; day++) {
    long.push(point(`2026-10-${day}`, longBase));
    short.push(point(`2026-10-${day}`, shortBase));
  }

  long.push(point('2026-10-26', '70'));
  short.push(point('2026-10-26', '30'));
  long.push(point('2026-10-27', '999999'));
  short.push(point('2026-10-27', '999999'));

  return { long, short };
}

function runFormulas(): void {
  const oi = oiSeries();
  const oi1d = coinalyzeOiUsdChange1dPct(oi, AS_OF);
  const oi7d = coinalyzeOiUsdChange7dPct(oi, AS_OF);

  check(
    'OI: variação 1d normal',
    oi1d?.toString() === '10',
    `(value=${oi1d?.toString()})`
  );
  check(
    'OI: variação 7d normal ignora datas futuras',
    oi7d?.toString() === '10',
    `(value=${oi7d?.toString()})`
  );

  const oiMissingBase = oi.filter((item) => item.refDate !== '2026-10-19');
  check(
    'OI: janela incompleta devolve null',
    coinalyzeOiUsdChange7dPct(oiMissingBase, AS_OF) === null
  );

  const oiZeroBase = [
    point('2026-10-19', '0'),
    point('2026-10-26', '110'),
  ];
  check(
    'OI: divisor zero devolve null',
    coinalyzeOiUsdChange7dPct(oiZeroBase, AS_OF) === null
  );

  const funding = fundingSeries();
  const fundingMean = coinalyzeFunding7dMean(funding, AS_OF);
  check(
    'funding: média de 7 dias normal',
    fundingMean?.toString() === '0.04',
    `(value=${fundingMean?.toString()})`
  );

  const fundingMissingMiddle = funding.filter((item) => item.refDate !== '2026-10-23');
  check(
    'funding: dia faltando no meio devolve null',
    coinalyzeFunding7dMean(fundingMissingMiddle, AS_OF) === null
  );

  const ratioMean = coinalyzeLongShortRatio7dMean(ratioSeries(), AS_OF);
  check(
    'long/short: média de 7 dias normal',
    ratioMean?.toString() === '1.4',
    `(value=${ratioMean?.toString()})`
  );

  const ratioMissingMiddle = ratioSeries().filter(
    (item) => item.refDate !== '2026-10-23'
  );
  check(
    'long/short: janela incompleta devolve null',
    coinalyzeLongShortRatio7dMean(ratioMissingMiddle, AS_OF) === null
  );

  const liquidation = liquidationSeries('60', '40');
  const vsMean = coinalyzeLiqTotalVsMean7dPct(
    liquidation.long,
    liquidation.short,
    AS_OF
  );
  const longShare = coinalyzeLiqLongSharePct(
    liquidation.long,
    liquidation.short,
    AS_OF
  );

  check(
    'liquidação: total contra média dos 7 dias anteriores',
    vsMean?.toString() === '100',
    `(value=${vsMean?.toString()})`
  );
  check(
    'liquidação: participação de longs no dia',
    longShare?.toString() === '70',
    `(value=${longShare?.toString()})`
  );

  const liquidMissingMiddle = liquidationSeries('60', '40');
  liquidMissingMiddle.long = liquidMissingMiddle.long.filter(
    (item) => item.refDate !== '2026-10-22'
  );
  check(
    'liquidação: dia faltando no meio devolve null',
    coinalyzeLiqTotalVsMean7dPct(
      liquidMissingMiddle.long,
      liquidMissingMiddle.short,
      AS_OF
    ) === null
  );

  const zeroMean = liquidationSeries('0', '0');
  check(
    'liquidação: média dos 7 dias zero devolve null',
    coinalyzeLiqTotalVsMean7dPct(zeroMean.long, zeroMean.short, AS_OF) === null
  );
  check(
    'liquidação: divisor zero na participação devolve null',
    coinalyzeLiqLongSharePct(
      [point('2026-10-26', '0')],
      [point('2026-10-26', '0')],
      AS_OF
    ) === null
  );
  check(
    'liquidação: valor ausente no dia devolve null',
    coinalyzeLiqLongSharePct(
      [point('2026-10-26', '70')],
      [],
      AS_OF
    ) === null
  );
  check(
    'valor inválido não vira zero',
    coinalyzeFunding7dMean(
      funding.map((item) =>
        item.refDate === '2026-10-23' ? point(item.refDate, 'N/A') : item
      ),
      AS_OF
    ) === null,
    `(series=${values(funding).length})`
  );
}

function runCatalog(): void {
  const names = new Set(COINALYZE_LEVERAGE_INDICATORS.map((item) => item.indicator));
  const scopes = new Set(COINALYZE_LEVERAGE_INDICATORS.map((item) => item.scope));
  const solIds = coinalyzeLeverageSeriesIds('SOL');

  check(
    'catálogo: 18 indicadores, 3 moedas e 6 nomes',
    COINALYZE_LEVERAGE_INDICATORS.length === 18 &&
      scopes.size === 3 &&
      names.size === 6 &&
      COINALYZE_LEVERAGE_INDICATOR_NAMES.every((name) => names.has(name))
  );
  check(
    'catálogo: escopos e versão',
    scopes.has('coinalyze:SOL') &&
      scopes.has('coinalyze:BTC') &&
      scopes.has('coinalyze:ETH') &&
      COINALYZE_LEVERAGE_INDICATORS.every(
        (item) => item.formulaVersion === COINALYZE_LEVERAGE_FORMULA_VERSION
      )
  );
  check(
    'catálogo: séries da moeda em minúsculas',
    solIds.oi === 'coinalyze_sol_oi_usd_close' &&
      solIds.funding === 'coinalyze_sol_funding_rate_close_pct' &&
      solIds.longShortRatio === 'coinalyze_sol_long_short_ratio' &&
      solIds.liqLong === 'coinalyze_sol_liq_long_usd' &&
      solIds.liqShort === 'coinalyze_sol_liq_short_usd'
  );

  const liquidation = liquidationSeries('60', '40');
  const series = {
    [solIds.oi]: oiSeries(),
    [solIds.funding]: fundingSeries(),
    [solIds.longShortRatio]: ratioSeries(),
    [solIds.liqLong]: liquidation.long,
    [solIds.liqShort]: liquidation.short,
  };
  const outputs = computeCoinalyzeLeverageIndicators(
    {
      SOL: series,
      BTC: {},
      ETH: {},
    },
    AS_OF
  );
  const sol = outputs.filter((item) => item.coin === 'SOL');
  const btc = outputs.filter((item) => item.coin === 'BTC');

  check(
    'catálogo: compute usa as séries por moeda',
    sol.length === 6 &&
      sol.every((item) => item.value !== null) &&
      btc.length === 6 &&
      btc.every((item) => item.value === null)
  );

  const units = new Map(
    COINALYZE_LEVERAGE_INDICATORS.map((item) => [item.indicator, item.unit])
  );
  check(
    'catálogo: unidades',
    units.get('oi_usd_change_1d_pct') === 'PERCENT' &&
      units.get('funding_7d_mean') === 'PERCENT' &&
      units.get('long_short_ratio_7d_mean') === 'RATIO' &&
      units.get('liq_long_share_pct') === 'PERCENT'
  );
}

runFormulas();
runCatalog();

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exitCode = failures === 0 ? 0 : 1;
