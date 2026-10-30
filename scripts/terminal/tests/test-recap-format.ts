#!/usr/bin/env node

import {
  RECAP_FOOTER,
  RECAP_WEEKEND_DEX_NOTE,
  formatRecap,
  type RecapInput,
  type RecapMetric,
} from '../recap/recap-format';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function metric(
  value: number | null,
  unit: string | null,
  asOf: string | null
): RecapMetric {
  return { value, unit, asOf };
}

function sample(): RecapInput {
  return {
    asOf: '2026-10-17',
    prices: [
      {
        asset: 'SOL',
        priceUsd: metric(150.25, 'USD', '2026-10-17'),
        return1d: metric(0.0123, 'FRACTION', '2026-10-16'),
        return7d: metric(-0.0456, 'FRACTION', '2026-10-17'),
      },
      {
        asset: 'BTC',
        priceUsd: metric(null, 'USD', null),
        return1d: metric(null, 'FRACTION', '2026-10-16'),
        return7d: metric(0.001, 'FRACTION', '2026-10-17'),
      },
      {
        asset: 'ETH',
        priceUsd: metric(3000, 'USD', '2026-10-16'),
        return1d: metric(2, 'PERCENT', '2026-10-17'),
        return7d: metric(0, 'PERCENT', '2026-10-17'),
      },
    ],
    regime: {
      regimeId: 'range_neutral',
      reason: 'SOL trend and relative strength are neutral.',
    },
    leverage: {
      oiUsdChange7dPct: metric(4.2, 'PERCENT', '2026-10-17'),
      funding7dMean: metric(0.011, 'PERCENT', '2026-10-16'),
      liqTotalVsMean7dPct: metric(115.5, 'PERCENT', '2026-10-17'),
      liqLongSharePct: metric(52.1, 'PERCENT', '2026-10-17'),
    },
    macro: {
      dollarBroadChange5dPct: metric(-0.4, 'PERCENT', '2026-10-15'),
      realYield10yChange5d: metric(0.08, 'PERCENT', '2026-10-16'),
    },
    activity: {
      dexVolumeVsMean7d: metric(0.05, 'FRACTION', '2026-10-16'),
      launchpads: [
        { slug: 'pump.fun', value: metric(0.1, 'FRACTION', '2026-10-15') },
        { slug: 'pumpswap', value: metric(null, 'FRACTION', null) },
      ],
    },
  };
}

const forbidden = ['buy', 'sell', 'bullish', 'bearish', 'should', 'good', 'bad'];
const text = formatRecap(sample());
const lower = text.toLowerCase();

check('título com a data', text.startsWith('# SOL Daily Recap: 2026-10-17\n'));
check(
  'série ausente vira n/a',
  text.includes('- BTC: n/a, 1d n/a, 7d +0.10%') &&
    text.includes('pumpswap n/a')
);
check(
  'preço em dólar com data quando necessário',
  text.includes('- SOL: $150.25, 1d +1.23% (2026-10-16)') &&
    text.includes('- ETH: $3000.00 (2026-10-16), 1d +2.00%')
);
check(
  'data diferente aparece entre parênteses',
  text.includes('1d +1.23% (2026-10-16)') &&
    text.includes('Funding 7d mean: +0.01% (2026-10-16)')
);
check(
  'fração vira % e percentual não é multiplicado',
  text.includes('SOL: $150.25, 1d +1.23%') &&
    text.includes('$3000.00 (2026-10-16), 1d +2.00%') &&
    text.includes('Liquidation total vs 7d mean: +115.50%')
);
check(
  'data notes lista série mais antiga sem limite inventado',
  text.includes('price_usd ETH (2026-10-16)') &&
    text.includes('return_1d SOL (2026-10-16)') &&
    text.includes('launchpad_dex_volume_vs_mean_7d pump.fun (2026-10-15)')
);
check(
  'sem nota de fim de semana quando o dado é sexta-feira',
  !text.includes(RECAP_WEEKEND_DEX_NOTE)
);

const weekend = sample();
weekend.activity.dexVolumeVsMean7d = metric(0.05, 'FRACTION', '2026-10-17');
const weekendText = formatRecap(weekend);
check(
  'nota de fim de semana só quando o dado é sábado ou domingo',
  weekendText.includes(RECAP_WEEKEND_DEX_NOTE)
);

const weekDay = sample();
weekDay.activity.dexVolumeVsMean7d = metric(0.05, 'FRACTION', '2026-10-19');
check(
  'sem nota de fim de semana na segunda-feira',
  !formatRecap(weekDay).includes(RECAP_WEEKEND_DEX_NOTE)
);

check(
  'sem palavras proibidas',
  forbidden.every((word) => !lower.includes(word)),
  forbidden.filter((word) => lower.includes(word)).join(',')
);
check('rodapé fixo', text.endsWith(RECAP_FOOTER));
check('texto determinístico', formatRecap(sample()) === text);
check('texto curto', text.split('\n').length <= 25, String(text.split('\n').length));

console.log('\n=== EXEMPLO DE RASCUNHO ===');
console.log(text);

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
if (failures > 0) process.exitCode = 1;
