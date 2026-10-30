export const RECAP_FOOTER =
  'Data: CoinGecko (Powered by CoinGecko), DefiLlama, Coinalyze, U.S. Treasury, Federal Reserve. Informational only, not financial advice. Draft generated automatically; reviewed before posting.';

export const RECAP_WEEKEND_DEX_NOTE =
  'DEX volume has tended to read about 15 to 20% below its 7-day average on Saturdays and Sundays (calendar effect).';

export interface RecapMetric {
  value: number | null;
  unit?: string | null;
  asOf?: string | null;
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

function formatUsd(metric: RecapMetric | null | undefined): string {
  const value = finiteOrNull(metric?.value);
  if (value === null) return 'n/a';
  return `$${value.toFixed(2)}`;
}

function formatPercent(metric: RecapMetric | null | undefined): string {
  const value = finiteOrNull(metric?.value);
  if (value === null) return 'n/a';

  const unit = metric?.unit?.toUpperCase() ?? null;
  const percent = unit === 'FRACTION' ? value * 100 : value;
  const rounded = Math.round(percent * 100) / 100;
  if (rounded === 0) return '0.00%';

  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded.toFixed(2)}%`;
}

function dateSuffix(metric: RecapMetric | null | undefined, recapAsOf: string): string {
  if (finiteOrNull(metric?.value) === null) return '';
  const asOf = metric?.asOf;
  if (typeof asOf !== 'string' || asOf.length === 0 || asOf === recapAsOf) return '';
  return ` (${asOf})`;
}

function metricText(
  label: string,
  metric: RecapMetric | null | undefined,
  recapAsOf: string
): string {
  return `${label}: ${formatPercent(metric)}${dateSuffix(metric, recapAsOf)}`;
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

  const reason = regime?.reason;
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return `- Regime: ${regimeId}`;
  }

  return `- Regime: ${regimeId}; ${reason}`;
}

function launchpadLine(input: RecapInput): string {
  if (input.activity.launchpads.length === 0) return '- Launchpads: n/a';

  const items = input.activity.launchpads.map((item) =>
    `${item.slug} ${formatPercent(item.value)}${dateSuffix(item.value, input.asOf)}`
  );
  return `- Launchpads: ${items.join('; ')}`;
}

function olderSeries(input: RecapInput): string[] {
  const entries: { name: string; metric: RecapMetric }[] = [];

  for (const price of input.prices) {
    entries.push({ name: `price_usd ${price.asset.toUpperCase()}`, metric: price.priceUsd });
    entries.push({ name: `return_1d ${price.asset.toUpperCase()}`, metric: price.return1d });
    entries.push({ name: `return_7d ${price.asset.toUpperCase()}`, metric: price.return7d });
  }

  entries.push(
    { name: 'oi_usd_change_7d_pct', metric: input.leverage.oiUsdChange7dPct },
    { name: 'funding_7d_mean', metric: input.leverage.funding7dMean },
    { name: 'liq_total_vs_mean7d_pct', metric: input.leverage.liqTotalVsMean7dPct },
    { name: 'liq_long_share_pct', metric: input.leverage.liqLongSharePct },
    { name: 'macro_dollar_broad_change_5d_pct', metric: input.macro.dollarBroadChange5dPct },
    {
      name: 'macro_real_yield_10y_change_5d',
      metric: input.macro.realYield10yChange5d,
    },
    { name: 'dex_volume_vs_mean_7d', metric: input.activity.dexVolumeVsMean7d }
  );

  for (const launchpad of input.activity.launchpads) {
    entries.push({
      name: `launchpad_dex_volume_vs_mean_7d ${launchpad.slug}`,
      metric: launchpad.value,
    });
  }

  const seen = new Set<string>();
  const notes: string[] = [];

  for (const entry of entries) {
    const asOf = entry.metric.asOf;
    if (typeof asOf !== 'string' || asOf.length === 0 || asOf >= input.asOf) continue;
    const note = `${entry.name} (${asOf})`;
    if (seen.has(note)) continue;
    seen.add(note);
    notes.push(note);
  }

  return notes;
}

export function formatRecap(input: RecapInput): string {
  const date = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf : 'n/a';
  const notes = olderSeries(input);
  const dexAsOf = input.activity.dexVolumeVsMean7d.asOf;

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
    `- ${metricText('OI 7d', input.leverage.oiUsdChange7dPct, input.asOf)}; ${metricText('Funding 7d mean', input.leverage.funding7dMean, input.asOf)}`,
    `- ${metricText('Liquidation total vs 7d mean', input.leverage.liqTotalVsMean7dPct, input.asOf)}; ${metricText('Long liquidation share', input.leverage.liqLongSharePct, input.asOf)}`,
    '',
    '**Macro (US)**',
    `- ${metricText('Broad dollar 5d', input.macro.dollarBroadChange5dPct, input.asOf)}; ${metricText('Real yield 10y 5d', input.macro.realYield10yChange5d, input.asOf)}`,
    '',
    '**Solana activity**',
    `- ${metricText('DEX volume vs 7d mean', input.activity.dexVolumeVsMean7d, input.asOf)}`,
  ];

  if (isWeekend(dexAsOf)) {
    lines.push(RECAP_WEEKEND_DEX_NOTE);
  }

  lines.push(
    launchpadLine(input),
    '',
    '**Data notes**',
    `- ${notes.length === 0 ? 'None.' : notes.join('; ')}`,
    RECAP_FOOTER
  );

  return lines.join('\n');
}
