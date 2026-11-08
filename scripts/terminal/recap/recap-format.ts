export const RECAP_FOOTER =
  'Data: CoinGecko (Powered by CoinGecko) https://www.coingecko.com | DefiLlama https://defillama.com | Coinalyze https://coinalyze.net | U.S. Treasury | Federal Reserve. Informational only, not financial advice. Draft generated automatically; reviewed before posting.';

export const RECAP_WEEKEND_VOLUME_NOTE =
  'Volume comparisons tend to read lower on Saturdays and Sundays.';

export const RECAP_WEEKEND_DEX_NOTE = RECAP_WEEKEND_VOLUME_NOTE;

export const LAUNCHPAD_LABELS: Readonly<Record<string, string>> = {
  'pump.fun': 'pump.fun',
  pumpswap: 'PumpSwap',
  launchlab: 'LaunchLab',
  'meteora-dynamic-bonding-curve': 'Meteora DBC',
};

export const REGIME_LABELS: Readonly<Record<string, string>> = {
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

export const DATA_NOTES = [
  'n/a means the value was not available.',
  'DEX and launchpad data arrive with a 2-day delay.',
  'Broad dollar data can arrive with a delay of more than a week.',
] as const;

export interface RecapMetric {
  value: number | null;
  unit?: string | null;
  asOf?: string | null;
  dataAsOf?: string | null;
}

export interface RecapPrice {
  asset: string;
  priceUsd: RecapMetric;
  return1d: RecapMetric;
  return7d: RecapMetric;
}

export interface RecapRegime {
  regimeId: string | null;
  reason?: string | null;
  decidedBy?: {
    sol_trend: string;
    sol_relative_strength: string;
  } | null;
  context?: {
    spot: string;
    onchain_liquidity: string;
    launchpads: string;
  } | null;
}

export interface RecapLaunchpad {
  slug: string;
  value: RecapMetric;
}

export interface RecapInput {
  asOf: string;
  prices: readonly RecapPrice[];
  regime: RecapRegime | null;
  leverage: {
    oiUsdChange7dPct: RecapMetric;
    funding7dMean: RecapMetric;
    liqTotalVsMean7dPct: RecapMetric;
    liqLongSharePct: RecapMetric;
  };
  macro: {
    dollarBroadChange5dPct: RecapMetric;
    realYield10yChange5d: RecapMetric;
  };
  activity: {
    dexVolumeVsMean7d: RecapMetric;
    launchpads: readonly RecapLaunchpad[];
  };
}

const PRICE_ORDER = ['SOL', 'BTC', 'ETH'] as const;

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function parseIsoDateUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return ms;
}

function isWeekend(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const ms = parseIsoDateUtc(value);
  if (ms === null) return false;
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toPercent(value: number, unit: string | null | undefined): number {
  return unit?.toUpperCase() === 'FRACTION' ? value * 100 : value;
}

function formatUsd(metric: RecapMetric | null | undefined): string {
  const value = finiteOrNull(metric?.value);
  if (value === null) return 'n/a';
  return USD_FORMATTER.format(value);
}

function formatPercent(metric: RecapMetric | null | undefined): string {
  const value = finiteOrNull(metric?.value);
  if (value === null) return 'n/a';

  const rounded = Math.round(toPercent(value, metric?.unit) * 100) / 100;
  if (rounded === 0) return '0.00%';

  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(2)}%`;
}

function formatSignedFixed(
  metric: RecapMetric | null | undefined,
  decimals: number,
  suffix: string,
  convertFraction: boolean
): string {
  const value = finiteOrNull(metric?.value);
  if (value === null) return 'n/a';

  const base = convertFraction ? toPercent(value, metric?.unit) : value;
  const factor = 10 ** decimals;
  const rounded = Math.round(base * factor) / factor;
  const normalized = rounded === 0 ? 0 : rounded;
  const sign = normalized > 0 ? '+' : '';
  return `${sign}${normalized.toFixed(decimals)}${suffix}`;
}

function formatRatio(metric: RecapMetric | null | undefined): string {
  const value = finiteOrNull(metric?.value);
  if (value === null) return 'n/a';
  return `${toPercent(value, metric?.unit).toFixed(1)}%`;
}

function dateSuffix(metric: RecapMetric | null | undefined, recapAsOf: string): string {
  if (finiteOrNull(metric?.value) === null) return '';
  const asOf = metric?.asOf;
  if (typeof asOf !== 'string' || asOf.length === 0 || asOf === recapAsOf) return '';
  return ` (${asOf})`;
}

function dataOf(metric: RecapMetric | null | undefined): string | null {
  const value = metric?.dataAsOf ?? metric?.asOf;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function dataAsOfSuffix(
  metric: RecapMetric | null | undefined,
  recapAsOf: string
): string {
  if (finiteOrNull(metric?.value) === null) return '';
  const dataAsOf = dataOf(metric);
  if (dataAsOf === null || dataAsOf >= recapAsOf) return '';
  return ` (data as of ${dataAsOf})`;
}

function commonDataAsOf(
  metrics: readonly (RecapMetric | null | undefined)[],
  recapAsOf: string
): string | null {
  if (metrics.length === 0) return null;

  const dates = metrics.map((metric) => {
    if (finiteOrNull(metric?.value) === null) return null;
    const dataAsOf = dataOf(metric);
    if (dataAsOf === null || dataAsOf >= recapAsOf) return null;
    return dataAsOf;
  });

  const first = dates[0];
  if (first === null) return null;
  return dates.every((date) => date === first) ? first : null;
}

function launchpadName(slug: string): string {
  return LAUNCHPAD_LABELS[slug] ?? slug;
}

function metricText(
  label: string,
  formatted: string,
  metric: RecapMetric | null | undefined,
  recapAsOf: string
): string {
  return `${label}: ${formatted}${dataAsOfSuffix(metric, recapAsOf)}`;
}

function priceFor(input: RecapInput, asset: string): RecapPrice | null {
  return input.prices.find((item) => item.asset.toUpperCase() === asset) ?? null;
}

function priceLine(input: RecapInput, asset: string): string {
  const price = priceFor(input, asset);
  const spot = `${formatUsd(price?.priceUsd)}${dateSuffix(price?.priceUsd, input.asOf)}`;
  const first = `1d ${formatPercent(price?.return1d)}${dateSuffix(price?.return1d, input.asOf)}`;
  const second = `7d ${formatPercent(price?.return7d)}${dateSuffix(price?.return7d, input.asOf)}`;
  return `- ${asset}: ${spot}, ${first}, ${second}`;
}

function regimeLine(regime: RecapRegime | null): string {
  const regimeId = regime?.regimeId;
  if (typeof regimeId !== 'string' || regimeId.length === 0) return '- Regime: n/a';

  const label = REGIME_LABELS[regimeId] ?? regimeId;
  const reason = regime?.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return `- Regime: ${label}`;
  }

  return `- Regime: ${label}; ${reason}`;
}

function launchpadLine(input: RecapInput): string {
  if (input.activity.launchpads.length === 0) return '- Launchpads: n/a';

  const sharedDataAsOf = commonDataAsOf(
    input.activity.launchpads.map((item) => item.value),
    input.asOf
  );
  const items = input.activity.launchpads.map((item) => {
    const value = formatPercent(item.value);
    const suffix =
      sharedDataAsOf === null ? dataAsOfSuffix(item.value, input.asOf) : '';
    return `${launchpadName(item.slug)} ${value}${suffix}`;
  });
  const suffix =
    sharedDataAsOf === null ? '' : ` (data as of ${sharedDataAsOf})`;
  return `- Launchpads: ${items.join('; ')}${suffix}`;
}

function unavailableNames(input: RecapInput): string[] {
  const entries: { name: string; metric: RecapMetric }[] = [];

  for (const price of input.prices) {
    const asset = price.asset.toUpperCase();
    entries.push({ name: `${asset} price`, metric: price.priceUsd });
    entries.push({ name: `${asset} 1-day return`, metric: price.return1d });
    entries.push({ name: `${asset} 7-day return`, metric: price.return7d });
  }

  entries.push(
    { name: 'Open interest change', metric: input.leverage.oiUsdChange7dPct },
    { name: 'Funding', metric: input.leverage.funding7dMean },
    { name: 'Liquidations', metric: input.leverage.liqTotalVsMean7dPct },
    { name: 'Long liquidation share', metric: input.leverage.liqLongSharePct },
    { name: 'Broad dollar', metric: input.macro.dollarBroadChange5dPct },
    { name: 'Real yield', metric: input.macro.realYield10yChange5d },
    { name: 'DEX volume', metric: input.activity.dexVolumeVsMean7d }
  );

  for (const launchpad of input.activity.launchpads) {
    entries.push({
      name: `${launchpadName(launchpad.slug)} DEX volume`,
      metric: launchpad.value,
    });
  }

  const missing: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (finiteOrNull(entry.metric.value) !== null) continue;
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    missing.push(entry.name);
  }

  return missing;
}

function hasWeekendVolumeReference(input: RecapInput): boolean {
  if (isWeekend(input.asOf)) return true;
  if (
    finiteOrNull(input.activity.dexVolumeVsMean7d.value) !== null &&
    isWeekend(dataOf(input.activity.dexVolumeVsMean7d))
  ) {
    return true;
  }
  return input.activity.launchpads.some(
    (item) =>
      finiteOrNull(item.value.value) !== null && isWeekend(dataOf(item.value))
  );
}

function dataNoteLines(input: RecapInput): string[] {
  const lines: string[] = [...DATA_NOTES];
  if (hasWeekendVolumeReference(input)) {
    lines.push(RECAP_WEEKEND_VOLUME_NOTE);
  }
  const missing = unavailableNames(input);
  if (missing.length > 0) {
    lines.push(`Not available: ${missing.join(', ')}`);
  }
  return lines;
}

export function formatRecap(input: RecapInput): string {
  const date = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf : 'n/a';

  const lines = [
    `# SOL Daily Recap: ${date}`,
    '',
    '**Price**',
    ...PRICE_ORDER.map((asset) => priceLine(input, asset)),
    '',
    '**Regime**',
    regimeLine(input.regime),
    '',
    '**Leverage, SOL (Coinalyze)**',
    `- ${metricText('OI 7d', formatPercent(input.leverage.oiUsdChange7dPct), input.leverage.oiUsdChange7dPct, input.asOf)}; ${metricText('Funding 7d mean', formatSignedFixed(input.leverage.funding7dMean, 4, '%', true), input.leverage.funding7dMean, input.asOf)}`,
    `- ${metricText('Liquidations', `${formatRatio(input.leverage.liqTotalVsMean7dPct)} of the 7-day average`, input.leverage.liqTotalVsMean7dPct, input.asOf)}; Longs were ${formatRatio(input.leverage.liqLongSharePct)} of liquidations${dataAsOfSuffix(input.leverage.liqLongSharePct, input.asOf)}`,
    '',
    '**Macro (US)**',
    `- ${metricText('Broad dollar 5d', formatPercent(input.macro.dollarBroadChange5dPct), input.macro.dollarBroadChange5dPct, input.asOf)}; ${metricText('Real yield 10y 5d', formatSignedFixed(input.macro.realYield10yChange5d, 2, ' pp', false), input.macro.realYield10yChange5d, input.asOf)}`,
    '',
    '**Solana activity**',
    `- ${metricText('DEX volume vs 7d mean', formatPercent(input.activity.dexVolumeVsMean7d), input.activity.dexVolumeVsMean7d, input.asOf)}`,
  ];

  lines.push(
    launchpadLine(input),
    '',
    '**Data notes**',
    ...dataNoteLines(input),
    '',
    '---',
    '',
    RECAP_FOOTER
  );

  return lines.join('\n');
}
