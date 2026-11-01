#!/usr/bin/env node

import {
  DATA_NOTES,
  LAUNCHPAD_LABELS,
  RECAP_FOOTER,
  RECAP_WEEKEND_VOLUME_NOTE,
  REGIME_LABELS,
  formatRecap,
  type RecapInput,
  type RecapLaunchpad,
  type RecapMetric,
} from '../recap/recap-format';
import { PRICE_ASSET_IDS, readRecapInput } from '../recap/recap-reader';

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
  asOf: string | null,
  dataAsOf: string | null = null
): RecapMetric {
  return { value, unit, asOf, dataAsOf };
}

function lineStarting(text: string, prefix: string): string {
  return text.split('\n').find((line) => line.startsWith(prefix)) ?? '';
}

function dataNotesBlock(text: string): string {
  const start = text.indexOf('**Data notes**');
  const end = text.indexOf('\n---', start);
  if (start < 0 || end < 0) return '';
  return text.slice(start, end);
}

function countOccurrences(text: string, value: string): number {
  return text.split(value).length - 1;
}

function launchpadsWithData(
  input: RecapInput,
  dates: readonly [string, string, string, string],
  value = 0.01
): void {
  const slugs = [
    'pump.fun',
    'pumpswap',
    'launchlab',
    'meteora-dynamic-bonding-curve',
  ] as const;
  input.activity.launchpads = slugs.map(
    (slug, index): RecapLaunchpad => ({
      slug,
      value: metric(value, 'FRACTION', input.asOf, dates[index]),
    })
  );
}

function sample(): RecapInput {
  return {
    asOf: '2026-10-17',
    prices: [
      {
        asset: 'SOL',
        priceUsd: metric(150.25, 'USD', '2026-10-17'),
        return1d: metric(0.0123, 'FRACTION', '2026-10-16', '2026-10-16'),
        return7d: metric(-0.0456, 'FRACTION', '2026-10-17', '2026-10-17'),
      },
      {
        asset: 'BTC',
        priceUsd: metric(null, 'USD', null),
        return1d: metric(null, 'FRACTION', '2026-10-17', '2026-10-16'),
        return7d: metric(0.001, 'FRACTION', '2026-10-17', '2026-10-17'),
      },
      {
        asset: 'ETH',
        priceUsd: metric(3000, 'USD', '2026-10-16'),
        return1d: metric(2, 'PERCENT', '2026-10-17', '2026-10-17'),
        return7d: metric(0, 'PERCENT', '2026-10-17', '2026-10-17'),
      },
    ],
    regime: {
      regimeId: 'range_neutral',
      reason: 'SOL trend and relative strength are neutral.',
    },
    leverage: {
      oiUsdChange7dPct: metric(4.2, 'PERCENT', '2026-10-17', '2026-10-17'),
      funding7dMean: metric(0.0052, 'PERCENT', '2026-10-17', '2026-10-16'),
      liqTotalVsMean7dPct: metric(100, 'PERCENT', '2026-10-17', '2026-10-17'),
      liqLongSharePct: metric(52.1, 'PERCENT', '2026-10-17', '2026-10-17'),
    },
    macro: {
      dollarBroadChange5dPct: metric(-0.4, 'PERCENT', '2026-10-17', '2026-10-15'),
      realYield10yChange5d: metric(0.08, 'PERCENT', '2026-10-17', '2026-10-16'),
    },
    activity: {
      dexVolumeVsMean7d: metric(0.05, 'FRACTION', '2026-10-17', '2026-10-16'),
      launchpads: [
        { slug: 'pump.fun', value: metric(0.1, 'FRACTION', '2026-10-17', '2026-10-15') },
        { slug: 'pumpswap', value: metric(null, 'FRACTION', null, null) },
      ],
    },
  };
}

const forbidden = ['buy', 'sell', 'bullish', 'bearish', 'should', 'good', 'bad'];
const text = formatRecap(sample());
const lower = text.toLowerCase();

check('título com a data', text.startsWith('# SOL Daily Recap: 2026-10-17\n'));
check(
  'bloco Price preservado',
    text.includes('- SOL: $150.25, 1d +1.23% (2026-10-16), 7d -4.56%') &&
    text.includes('- BTC: n/a, 1d n/a, 7d +0.10%') &&
    text.includes('- ETH: $3,000.00 (2026-10-16), 1d +2.00%, 7d 0.00%')
);
check(
  'liquidação como % da média dos 7 dias, sem sinal',
  text.includes('Liquidations: 100.0% of the 7-day average') &&
    !text.includes('Liquidations: +')
);
check(
  'participação de longs sem sinal',
  text.includes('Longs were 52.1% of liquidations') &&
    !text.includes('Longs were +')
);
check('funding com 4 casas e sinal', text.includes('Funding 7d mean: +0.0052%'));
check(
  'juros reais em pontos percentuais',
  text.includes('Real yield 10y 5d: +0.08 pp') &&
    !text.includes('Real yield 10y 5d: +0.08%')
);
check(
  'data real anterior vira data as of',
  text.includes('Funding 7d mean: +0.0052% (data as of 2026-10-16)') &&
    text.includes('Broad dollar 5d: -0.40% (data as of 2026-10-15)') &&
    text.includes('DEX volume vs 7d mean: +5.00% (data as of 2026-10-16)')
);
check(
  'variações com sinal e 2 casas',
  text.includes('OI 7d: +4.20%') &&
    text.includes('pump.fun +10.00% (data as of 2026-10-15)')
);
check(
  'data notes fixas sem nomes internos',
  DATA_NOTES.every((line) => text.includes(line)) &&
    text.includes('Not available: BTC price, BTC 1-day return, PumpSwap DEX volume') &&
    !text.includes('return_1d') &&
    !text.includes('liq_total')
);
check(
  'nota do dólar atualizada',
  text.includes('Broad dollar data can arrive with a delay of more than a week.') &&
    !text.includes('Broad dollar data arrives with a delay of 3 to 7 days.')
);
check('nenhum underline na saída', !text.includes('_'));
check(
  'sem palavras proibidas',
  forbidden.every((word) => !lower.includes(word)),
  forbidden.filter((word) => lower.includes(word)).join(',')
);
check('linha em branco e separador antes do rodapé', text.includes(`\n\n---\n\n${RECAP_FOOTER}`));
check('rodapé fixo', text.endsWith(RECAP_FOOTER));
check(
  'rodapé contém as três URLs das fontes',
  RECAP_FOOTER.includes('https://www.coingecko.com') &&
    RECAP_FOOTER.includes('https://defillama.com') &&
    RECAP_FOOTER.includes('https://coinalyze.net')
);
check(
  'rodapé mantém Powered by CoinGecko',
  RECAP_FOOTER.includes('Powered by CoinGecko')
);
check(
  'U.S. Treasury e Federal Reserve ficam sem endereço',
  RECAP_FOOTER.includes(', U.S. Treasury, Federal Reserve.') &&
    !RECAP_FOOTER.includes('Treasury (') &&
    !RECAP_FOOTER.includes('Reserve (')
);
check(
  'rodapé sem palavras proibidas',
  forbidden.every((word) => !RECAP_FOOTER.toLowerCase().includes(word)),
  forbidden.filter((word) => RECAP_FOOTER.toLowerCase().includes(word)).join(',')
);
check('texto determinístico', formatRecap(sample()) === text);

const expectedRegimes: Record<string, string> = {
  trend_up_confirmed: 'Uptrend, confirmed',
  trend_up_unconfirmed: 'Uptrend, unconfirmed',
  range_neutral: 'Range, neutral',
  trend_down_unconfirmed: 'Downtrend, unconfirmed',
  trend_down_confirmed: 'Downtrend, confirmed',
  weak_without_trend: 'Weak, no trend',
  strong_without_trend: 'Strong, no trend',
  conflicting: 'Conflicting signals',
  insufficient_data: 'Insufficient data',
};

for (const [id, label] of Object.entries(expectedRegimes)) {
  const input = sample();
  input.regime = { regimeId: id, reason: null };
  check(`regime ${id}`, formatRecap(input).includes(`- Regime: ${label}`));
}

const unknownRegime = sample();
unknownRegime.regime = { regimeId: 'custom_regime', reason: null };
check('regime desconhecido como veio', formatRecap(unknownRegime).includes('- Regime: custom_regime'));

const priceThousands = sample();
priceThousands.asOf = '2026-10-19';
priceThousands.prices[0].priceUsd = metric(77474.08, 'USD', '2026-10-17');
priceThousands.prices[1].priceUsd = metric(2254.13, 'USD', '2026-10-17');
priceThousands.prices[2].priceUsd = metric(95.42, 'USD', '2026-10-17');
const priceThousandsText = formatRecap(priceThousands);
check(
  'preço de 5 dígitos usa separador de milhar en-US',
  priceThousandsText.includes('- SOL: $77,474.08') &&
    !priceThousandsText.includes('$77474.08')
);
check(
  'preço de 4 dígitos usa separador de milhar en-US',
  priceThousandsText.includes('- BTC: $2,254.13')
);
check(
  'preço de 2 dígitos não recebe separador',
  priceThousandsText.includes('- ETH: $95.42')
);

const priceThreeDigits = sample();
priceThreeDigits.asOf = '2026-10-19';
priceThreeDigits.prices[0].priceUsd = metric(954.42, 'USD', '2026-10-17');
check(
  'preço de 3 dígitos mantém 2 casas sem separador',
  formatRecap(priceThreeDigits).includes('- SOL: $954.42')
);

const namedLaunchpads = sample();
namedLaunchpads.asOf = '2026-10-19';
launchpadsWithData(namedLaunchpads, [
  '2026-10-17',
  '2026-10-17',
  '2026-10-17',
  '2026-10-17',
]);
const namedLaunchpadsText = formatRecap(namedLaunchpads);
const namedLaunchpadLine = lineStarting(
  namedLaunchpadsText,
  '- Launchpads:'
);
check(
  'nomes legíveis dos 4 launchpads',
  namedLaunchpadLine.includes('pump.fun +1.00%') &&
    namedLaunchpadLine.includes('PumpSwap +1.00%') &&
    namedLaunchpadLine.includes('LaunchLab +1.00%') &&
    namedLaunchpadLine.includes('Meteora DBC +1.00%')
);
check(
  'slugs brutos não aparecem na linha',
  !namedLaunchpadLine.includes('pumpswap ') &&
    !namedLaunchpadLine.includes('launchlab ') &&
    !namedLaunchpadLine.includes('meteora-dynamic-bonding-curve')
);
check(
  'mapa de launchpads é o esperado',
  LAUNCHPAD_LABELS['pump.fun'] === 'pump.fun' &&
    LAUNCHPAD_LABELS.pumpswap === 'PumpSwap' &&
    LAUNCHPAD_LABELS.launchlab === 'LaunchLab' &&
    LAUNCHPAD_LABELS['meteora-dynamic-bonding-curve'] === 'Meteora DBC'
);
check(
  'saída com nomes legíveis sem underline ou palavras proibidas',
  !namedLaunchpadsText.includes('_') &&
    forbidden.every(
      (word) => !namedLaunchpadsText.toLowerCase().includes(word)
    )
);

const unknownLaunchpad = sample();
unknownLaunchpad.asOf = '2026-10-19';
unknownLaunchpad.activity.launchpads = [
  {
    slug: 'otherpad',
    value: metric(0.01, 'FRACTION', '2026-10-19', '2026-10-17'),
  },
];
check(
  'slug desconhecido aparece como veio',
  lineStarting(formatRecap(unknownLaunchpad), '- Launchpads:').includes(
    'otherpad +1.00%'
  )
);

const sameDataDates = sample();
sameDataDates.asOf = '2026-10-19';
launchpadsWithData(sameDataDates, [
  '2026-10-17',
  '2026-10-17',
  '2026-10-17',
  '2026-10-17',
]);
const sameDataLine = lineStarting(
  formatRecap(sameDataDates),
  '- Launchpads:'
);
check(
  'data única aparece uma vez no fim da linha',
  sameDataLine.endsWith(' (data as of 2026-10-17)') &&
    countOccurrences(sameDataLine, '(data as of') === 1
);

const differentDataDates = sample();
differentDataDates.asOf = '2026-10-19';
launchpadsWithData(differentDataDates, [
  '2026-10-16',
  '2026-10-17',
  '2026-10-16',
  '2026-10-17',
]);
const differentDataLine = lineStarting(
  formatRecap(differentDataDates),
  '- Launchpads:'
);
check(
  'datas diferentes mantêm data por item',
  countOccurrences(differentDataLine, '(data as of') === 4 &&
    differentDataLine.includes('pump.fun +1.00% (data as of 2026-10-16)') &&
    differentDataLine.includes('PumpSwap +1.00% (data as of 2026-10-17)')
);

const saturday = sample();
saturday.asOf = '2026-10-31';
saturday.activity.dexVolumeVsMean7d = metric(
  0.05,
  'FRACTION',
  '2026-10-31',
  '2026-10-30'
);
launchpadsWithData(saturday, [
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
]);
const saturdayText = formatRecap(saturday);
check(
  'nota de fim de semana no sábado',
  dataNotesBlock(saturdayText).includes(RECAP_WEEKEND_VOLUME_NOTE) &&
    countOccurrences(saturdayText, RECAP_WEEKEND_VOLUME_NOTE) === 1
);

const sunday = sample();
sunday.asOf = '2026-11-01';
sunday.activity.dexVolumeVsMean7d = metric(
  0.05,
  'FRACTION',
  '2026-11-01',
  '2026-10-30'
);
launchpadsWithData(sunday, [
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
]);
const sundayText = formatRecap(sunday);
check(
  'nota de fim de semana no domingo',
  dataNotesBlock(sundayText).includes(RECAP_WEEKEND_VOLUME_NOTE) &&
    countOccurrences(sundayText, RECAP_WEEKEND_VOLUME_NOTE) === 1
);

const monday = sample();
monday.asOf = '2026-11-02';
monday.activity.dexVolumeVsMean7d = metric(
  0.05,
  'FRACTION',
  '2026-11-02',
  '2026-10-30'
);
launchpadsWithData(monday, [
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
]);
check(
  'sem nota de fim de semana na segunda-feira',
  !formatRecap(monday).includes(RECAP_WEEKEND_VOLUME_NOTE)
);

const mondayDexSaturday = sample();
mondayDexSaturday.asOf = '2026-11-02';
mondayDexSaturday.activity.dexVolumeVsMean7d = metric(
  0.05,
  'FRACTION',
  '2026-11-02',
  '2026-10-31'
);
launchpadsWithData(mondayDexSaturday, [
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
  '2026-10-30',
]);
const mondayDexSaturdayText = formatRecap(mondayDexSaturday);
check(
  'nota de fim de semana quando o dado de DEX cai no sábado',
  dataNotesBlock(mondayDexSaturdayText).includes(
    RECAP_WEEKEND_VOLUME_NOTE
  ) && countOccurrences(mondayDexSaturdayText, RECAP_WEEKEND_VOLUME_NOTE) === 1
);

const mondayLaunchpadSunday = sample();
mondayLaunchpadSunday.asOf = '2026-11-02';
mondayLaunchpadSunday.activity.dexVolumeVsMean7d = metric(
  0.05,
  'FRACTION',
  '2026-11-02',
  '2026-10-30'
);
launchpadsWithData(mondayLaunchpadSunday, [
  '2026-11-01',
  '2026-11-01',
  '2026-11-01',
  '2026-11-01',
]);
const mondayLaunchpadSundayText = formatRecap(mondayLaunchpadSunday);
check(
  'nota de fim de semana quando o dado de launchpad cai no domingo',
  dataNotesBlock(mondayLaunchpadSundayText).includes(
    RECAP_WEEKEND_VOLUME_NOTE
  ) &&
    countOccurrences(mondayLaunchpadSundayText, RECAP_WEEKEND_VOLUME_NOTE) === 1
);

const complete = sample();
complete.prices[1].priceUsd = metric(60000, 'USD', '2026-10-17');
complete.prices[1].return1d = metric(0.01, 'FRACTION', '2026-10-17', '2026-10-17');
complete.activity.launchpads[1].value = metric(0.02, 'FRACTION', '2026-10-17');
check('sem linha Not available quando tudo existe', !formatRecap(complete).includes('Not available:'));

check(
  'mapa de regimes tem 9 ids',
  Object.keys(REGIME_LABELS).length === 9 &&
    Object.entries(expectedRegimes).every(([id, label]) => REGIME_LABELS[id] === label)
);

interface PriceQuery {
  where?: { asset?: { in?: string[] } };
}

interface IndicatorQuery {
  where?: {
    OR?: { indicator: string; scope: string; formulaVersion: string }[];
  };
}

async function runReaderChecks(): Promise<void> {
  const priceQueries: PriceQuery[] = [];
  const indicatorQueries: IndicatorQuery[] = [];
  const pricesById: Record<string, number> = {
    solana: 150,
    bitcoin: 60000,
    ethereum: 3000,
  };

  const client = {
    marketState: {
      findMany: async (_args: unknown) => [],
    },
    marketSnapshot: {
      findMany: async (args: unknown) => {
        priceQueries.push(args as PriceQuery);
        return Object.entries(pricesById).map(([asset, priceUsd]) => ({
          asset,
          collectedAt: new Date('2026-10-17T12:00:00.000Z'),
          priceUsd,
          source: { provider: 'coingecko' },
        }));
      },
    },
    indicatorSnapshot: {
      findMany: async (args: unknown) => {
        indicatorQueries.push(args as IndicatorQuery);
        return Object.keys(pricesById).flatMap((scope) => [
          {
            indicator: 'return_1d',
            scope,
            status: 'ok',
            value: 0.01,
            unit: 'FRACTION',
            asOf: new Date('2026-10-17T00:00:00.000Z'),
            toDate: new Date('2026-10-17T00:00:00.000Z'),
            formulaVersion: 'v1',
          },
          {
            indicator: 'return_7d',
            scope,
            status: 'ok',
            value: 0.02,
            unit: 'FRACTION',
            asOf: new Date('2026-10-17T00:00:00.000Z'),
            toDate: new Date('2026-10-17T00:00:00.000Z'),
            formulaVersion: 'v1',
          },
        ]);
      },
    },
  };

  const input = await readRecapInput(
    client as unknown as Parameters<typeof readRecapInput>[0],
    '2026-10-17'
  );
  const queriedAssets = priceQueries[0]?.where?.asset?.in ?? [];
  const returnTargets = (indicatorQueries[0]?.where?.OR ?? []).filter((item) =>
    item.indicator.startsWith('return_')
  );
  const scopes = [...new Set(returnTargets.map((item) => item.scope))].sort();
  const shortNames = ['sol', 'btc', 'eth'];
  const queriedNames = [...queriedAssets, ...returnTargets.map((item) => item.scope)];

  check(
    'mapa canônico usa solana, bitcoin e ethereum',
    PRICE_ASSET_IDS.SOL === 'solana' &&
      PRICE_ASSET_IDS.BTC === 'bitcoin' &&
      PRICE_ASSET_IDS.ETH === 'ethereum'
  );
  check(
    'consulta MarketSnapshot usa solana, bitcoin e ethereum',
    queriedAssets.join(',') === 'solana,bitcoin,ethereum'
  );
  check(
    'consulta IndicatorSnapshot usa solana, bitcoin e ethereum',
    scopes.join(',') === 'bitcoin,ethereum,solana'
  );
  check(
    'consultas de retorno usam formulaVersion v1',
    returnTargets.every((item) => item.formulaVersion === 'v1')
  );
  check(
    'consultas não usam sol, btc ou eth',
    queriedNames.every((name) => !shortNames.includes(name))
  );
  check(
    'agrupamento mantém rótulos SOL, BTC e ETH',
    input.prices.map((item) => item.asset).join(',') === 'SOL,BTC,ETH'
  );
  check(
    'preços foram ligados pelos ids do banco',
    input.prices.map((item) => item.priceUsd.value).join(',') === '150,60000,3000'
  );
  check(
    'retornos foram ligados pelos scopes do banco',
    input.prices.every(
      (item) => item.return1d.value === 0.01 && item.return7d.value === 0.02
    )
  );

  const rendered = formatRecap(input);
  check(
    'saída continua mostrando SOL, BTC e ETH',
    rendered.includes('- SOL: $150.00') &&
      rendered.includes('- BTC: $60,000.00') &&
      rendered.includes('- ETH: $3,000.00')
  );
}

runReaderChecks()
  .then(() => {
    console.log('\n=== EXEMPLO DE RASCUNHO ===');
    console.log(text);

    console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
    if (failures > 0) process.exitCode = 1;
  })
  .catch((error: unknown) => {
    console.error(
      '[FATAL]',
      error instanceof Error ? error.message : String(error).slice(0, 300)
    );
    process.exitCode = 1;
  });
