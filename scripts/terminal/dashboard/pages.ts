import { LAUNCHPAD_LABELS, REGIME_LABELS, type RecapInput, type RecapMetric } from '../recap/recap-format';
import { delayDays, type FreshnessResult, type FreshnessStatus } from '../checks/freshness-rules';
import { LAUNCHPAD_SLUGS } from '../config';
import {
  latestPoint,
  latestValueText,
  renderLineChart,
  renderMultiLineChart,
  renderTimeLineChart,
} from './charts';
import type { IndicatorSeries } from './series-reader';
import { escapeHtml, sanitizeHtml, sanitizeText } from './sanitize';
import { ROLLING_FORMULA_VERSION } from '../indicators/rolling-hourly';
import {
  DOLLAR_SERIES_IDS,
  type DollarMacroValue,
} from './macro-reader';
import {
  COINALYZE_LEVERAGE_COINS,
  COINALYZE_LEVERAGE_METRICS,
  HOURLY_LAUNCHPAD_SLUGS,
  HYPERLIQUID_COINS,
  HYPERLIQUID_INDICATORS,
  type CoinalyzeHourlyValue,
  type DailyMetricValue,
  type HourlyMetricValue,
  type LatestPriceValue,
  type RollingHourlyValue,
} from './hourly-reader';
import type { TokenChartPoint, TokenDetail, TokenSummary } from './token-reader';

export const DASHBOARD_FOOTER =
  'Local read-only dashboard. Data: CoinGecko, DefiLlama, Coinalyze, U.S. Treasury, Federal Reserve. Not financial advice.';

export const INTEGRATED_NOTICE =
  'Latest = rolling hourly capture. Closed = daily series. Not comparable.';

export const COINALYZE_HOURLY_NOTICE =
  'Hourly closed candles from Coinalyze. Not comparable with the daily indicators.';

export const ROLLING_HOURLY_NOTICE = `Rolling 24h captures, formula ${ROLLING_FORMULA_VERSION}. Not comparable with the daily closed indicators.`;

export const DOLLAR_PROXY_NOTICE =
  'EUR/USD is a proxy, shown separately. It is not the Fed broad dollar index and is never combined with it.';

export const SINCE_LAST_CLOSE_NOTICE =
  'Raw intraday movement since the last closed day. The state and regime above are computed on closed days only and are not recomputed.';

const HOUR_MS = 60 * 60 * 1000;
const PRICE_ORDER = ['SOL', 'BTC', 'ETH'] as const;

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function metricDate(metric: RecapMetric | null | undefined): string | null {
  const value = metric?.dataAsOf ?? metric?.asOf;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function oldestDate(metrics: readonly (RecapMetric | null | undefined)[]): string | null {
  const dates = metrics
    .map((metric) => metricDate(metric))
    .filter((value): value is string => value !== null)
    .sort();
  return dates.length === 0 ? null : dates[0];
}

function delayText(date: string | null, asOf: string): string {
  if (date === null) return 'n/a';
  const delay = delayDays(new Date(`${date}T00:00:00.000Z`), asOf);
  return `${date} (${delay}d delay)`;
}

function formatPrice(metric: RecapMetric | null | undefined): string {
  const value = metric?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return USD_FORMATTER.format(value);
}

const HOURLY_VALUE_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 6,
});

function formatHourlyValue(value: number | null, unit: string | null): string {
  if (value === null) return 'n/a';
  const formatted = HOURLY_VALUE_FORMATTER.format(value);
  return unit !== null && unit.length > 0 && unit !== 'n/a'
    ? `${formatted} ${unit}`
    : formatted;
}

function formatHourlyAge(ageMs: number | null): string {
  if (ageMs === null) return 'n/a';
  const totalMinutes = Math.max(0, Math.floor(ageMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatHourlyUtc(collectedAt: Date | null): string {
  if (collectedAt === null) return 'n/a';
  return `${collectedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function formatClosedDate(asOf: Date | null): string {
  return asOf === null ? 'n/a' : asOf.toISOString().slice(0, 10);
}

function formatCandleWindow(sourceTs: Date | null): string {
  if (sourceTs === null) return 'n/a';
  const end = new Date(sourceTs.getTime() + HOUR_MS);
  return `hour ${sourceTs.toISOString().slice(11, 16)} to ${end
    .toISOString()
    .slice(11, 16)} UTC`;
}

function ageCell(ageMs: number | null, stale: boolean): string {
  const age = formatHourlyAge(ageMs);
  if (age === 'n/a') return 'n/a';
  return stale ? `${age} <span class="warn">stale</span>` : age;
}

const PRICE_ASSET_BY_LABEL: Record<string, string> = {
  SOL: 'solana',
  BTC: 'bitcoin',
  ETH: 'ethereum',
};

const LATEST_PRICE_LABELS: Record<string, string> = {
  solana: 'SOL',
  bitcoin: 'BTC',
  ethereum: 'ETH',
};

const ACTIVITY_LABELS: Record<string, string> = {
  tvl_usd: 'TVL',
  stablecoin_supply_usd: 'Stablecoins',
  dex_volume_24h_usd: 'DEX volume 24h',
  global_market_cap_usd: 'Global market cap',
  btc_dominance_pct: 'BTC dominance',
};

const COINALYZE_METRIC_LABELS: Record<string, string> = {
  oi_usd_close_1h: 'OI USD',
  funding_rate_close_pct_1h: 'Funding rate %',
  long_short_ratio_1h: 'Long/short ratio',
  long_account_pct_1h: 'Long account %',
  liq_long_usd_1h: 'Long liq. USD',
  liq_short_usd_1h: 'Short liq. USD',
};

function latestPriceLabel(asset: string): string {
  return LATEST_PRICE_LABELS[asset] ?? asset;
}

function activityLabel(metric: string): string {
  return ACTIVITY_LABELS[metric] ?? metric;
}

function closedPriceCell(metric: RecapMetric | null | undefined): string {
  const value = formatPrice(metric);
  const date = metricDate(metric);
  if (value === 'n/a' && date === null) return 'n/a';
  return `${escapeHtml(value)}<br><span class="muted">Closed ${escapeHtml(
    date ?? 'n/a'
  )}</span>`;
}

function latestPriceCell(row: LatestPriceValue | undefined): string {
  if (row === undefined || row.collectedAt === null) return 'n/a';
  const value =
    row.priceUsd === null ? 'n/a' : USD_FORMATTER.format(row.priceUsd);
  return `${escapeHtml(value)}<br><span class="muted">${escapeHtml(
    formatHourlyUtc(row.collectedAt)
  )} · ${ageCell(row.ageMs, row.stale)}</span>`;
}

function closedMetricCell(row: DailyMetricValue | undefined): string {
  if (row === undefined || row.value === null) return 'n/a';
  return `${escapeHtml(formatHourlyValue(row.value, row.unit))}<br><span class="muted">Closed ${escapeHtml(
    formatClosedDate(row.asOf)
  )}</span>`;
}

function latestMetricCell(row: HourlyMetricValue | undefined): string {
  if (row === undefined || row.collectedAt === null) return 'n/a';
  return `${escapeHtml(formatHourlyValue(row.value, row.unit))}<br><span class="muted">${escapeHtml(
    formatHourlyUtc(row.collectedAt)
  )} · ${ageCell(row.ageMs, row.stale)}</span>`;
}

function findHourly(
  rows: readonly HourlyMetricValue[],
  scope: string,
  metric: string
): HourlyMetricValue | undefined {
  return rows.find((row) => row.scope === scope && row.metric === metric);
}

function findDaily(
  rows: readonly DailyMetricValue[],
  scope: string,
  metric: string
): DailyMetricValue | undefined {
  return rows.find((row) => row.scope === scope && row.metric === metric);
}

function hyperliquidCoinLabel(scope: string): string {
  const parts = scope.split(':');
  return parts[parts.length - 1] ?? scope;
}

function launchpadScopeLabel(scope: string): string {
  const slug = scope.startsWith('solana:protocol:')
    ? scope.slice('solana:protocol:'.length)
    : scope;
  return LAUNCHPAD_LABELS[slug] ?? slug;
}

const OVERVIEW_ACTIVITY_METRICS = [
  'tvl_usd',
  'stablecoin_supply_usd',
  'dex_volume_24h_usd',
  'global_market_cap_usd',
  'btc_dominance_pct',
] as const;

function priceRow(
  input: RecapInput,
  asset: string,
  latestPrices: readonly LatestPriceValue[]
): string {
  const price = input.prices.find((item) => item.asset.toUpperCase() === asset) ?? null;
  const latest = latestPrices.find(
    (row) => row.asset === PRICE_ASSET_BY_LABEL[asset]
  );
  return `<tr><th scope="row">${escapeHtml(asset)}</th><td>${closedPriceCell(
    price?.priceUsd
  )}</td><td>${latestPriceCell(latest)}</td></tr>`;
}

function formatRollingDeviation(value: number | null): string {
  if (value === null) return 'n/a';
  const percent = value * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(2)}%`;
}

function rollingValueText(row: RollingHourlyValue | undefined): string {
  if (
    row === undefined ||
    row.relativeDeviation === null ||
    row.referenceMean === null
  ) {
    return 'n/a';
  }
  return `${formatRollingDeviation(row.relativeDeviation)} vs mean ${formatHourlyValue(
    row.referenceMean,
    'USD'
  )}`;
}

function rollingCadenceText(row: RollingHourlyValue | undefined): string {
  if (row === undefined || row.updatesOnceDaily === null) return 'n/a';
  if (!row.updatesOnceDaily) return 'source updates more than once a day';
  const lastChange = formatHourlyUtc(row.lastChangeAt);
  return `source updates once a day (00:00 UTC); last change ${lastChange}`;
}

function findRolling(
  rows: readonly RollingHourlyValue[],
  scope: string,
  metric: string
): RollingHourlyValue | undefined {
  return rows.find((row) => row.scope === scope && row.metric === metric);
}

function launchpadRollingCell(
  volume: RollingHourlyValue | undefined,
  fees: RollingHourlyValue | undefined
): string {
  return `<div>Volume: ${escapeHtml(rollingValueText(volume))}</div><div>Fees: ${escapeHtml(
    rollingValueText(fees)
  )}</div>`;
}

function launchpadCadenceCell(
  volume: RollingHourlyValue | undefined,
  fees: RollingHourlyValue | undefined
): string {
  return `<div>Volume: ${escapeHtml(rollingCadenceText(volume))}</div><div>Fees: ${escapeHtml(
    rollingCadenceText(fees)
  )}</div>`;
}

function overviewRollingRows(rolling: readonly RollingHourlyValue[]): string {
  const row = findRolling(rolling, 'solana', 'dex_volume_24h_usd');
  return `<tr><th scope="row">Solana DEX volume 24h</th><td>${escapeHtml(
    rollingValueText(row)
  )}</td><td>${escapeHtml(rollingCadenceText(row))}</td></tr>`;
}

function overviewActivityRows(
  hourly: readonly HourlyMetricValue[],
  daily: readonly DailyMetricValue[]
): string {
  return OVERVIEW_ACTIVITY_METRICS.map((metric) => {
    const scope =
      metric === 'global_market_cap_usd' || metric === 'btc_dominance_pct'
        ? 'global'
        : 'solana';
    return `<tr><th scope="row">${escapeHtml(
      activityLabel(metric)
    )}</th><td>${closedMetricCell(
      findDaily(daily, scope, metric)
    )}</td><td>${latestMetricCell(
      findHourly(hourly, scope, metric)
    )}</td></tr>`;
  }).join('');
}

function regimeText(input: RecapInput): string {
  const regimeId = input.regime?.regimeId;
  if (typeof regimeId !== 'string' || regimeId.length === 0) return 'n/a';
  const label = REGIME_LABELS[regimeId] ?? regimeId;
  const reason = input.regime?.reason;
  if (typeof reason === 'string' && reason.trim().length > 0) {
    return `${label}; ${reason}`;
  }
  return label;
}

interface SinceLastCloseRow {
  label: string;
  kind: 'price' | 'ratio';
  closeValue: number | null;
  closeDate: string | null;
  latestValue: number | null;
  latestDate: Date | null;
  stale: boolean;
  changePct: number | null;
}

function finiteNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function percentChange(
  latest: number | null,
  close: number | null
): number | null {
  if (latest === null || close === null || close === 0) return null;
  return ((latest - close) / close) * 100;
}

function formatChangePct(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function olderDate(left: Date | null, right: Date | null): Date | null {
  if (left === null || right === null) return null;
  return left.getTime() <= right.getTime() ? left : right;
}

function ratioValue(
  first: number | null,
  second: number | null
): number | null {
  if (first === null || second === null || second === 0) return null;
  return first / second;
}

function sinceLastCloseRows(
  input: RecapInput,
  latestPrices: readonly LatestPriceValue[],
  asOf: string
): string {
  const assets = PRICE_ORDER.map((asset) => {
    const close = input.prices.find(
      (item) => item.asset.toUpperCase() === asset
    )?.priceUsd;
    const closeValue = finiteNumber(close?.value);
    const latest = latestPrices.find(
      (row) => row.asset === PRICE_ASSET_BY_LABEL[asset]
    );
    const latestValue = finiteNumber(latest?.priceUsd);
    return {
      label: asset,
      kind: 'price' as const,
      closeValue,
      closeDate: metricDate(close),
      latestValue,
      latestDate: latest?.collectedAt ?? null,
      stale: latest?.stale ?? false,
      changePct: percentChange(latestValue, closeValue),
    };
  });
  const byLabel = new Map<string, (typeof assets)[number]>(
    assets.map((row) => [row.label, row])
  );
  const ratio = (first: string, second: string): SinceLastCloseRow => {
    const left = byLabel.get(first);
    const right = byLabel.get(second);
    const closeValue = ratioValue(
      left?.closeValue ?? null,
      right?.closeValue ?? null
    );
    const latestValue = ratioValue(
      left?.latestValue ?? null,
      right?.latestValue ?? null
    );
    return {
      label: `${first}/${second}`,
      kind: 'ratio',
      closeValue,
      closeDate: asOf,
      latestValue,
      latestDate: olderDate(
        left?.latestDate ?? null,
        right?.latestDate ?? null
      ),
      stale: (left?.stale ?? false) || (right?.stale ?? false),
      changePct: percentChange(latestValue, closeValue),
    };
  };

  return [...assets, ratio('SOL', 'BTC'), ratio('SOL', 'ETH')]
    .map((row) => {
      const formatValue =
        row.kind === 'price'
          ? (value: number): string => USD_FORMATTER.format(value)
          : (value: number): string => HOURLY_VALUE_FORMATTER.format(value);
      const closed =
        row.closeValue === null
          ? 'n/a'
          : `${escapeHtml(formatValue(row.closeValue))}<br><span class="muted">closed value of ${escapeHtml(
              row.closeDate ?? 'n/a'
            )}</span>`;
      const latest =
        row.latestDate === null
          ? 'n/a'
          : `${row.latestValue === null ? 'n/a' : escapeHtml(formatValue(row.latestValue))}<br><span class="muted">latest ${escapeHtml(
              formatHourlyUtc(row.latestDate)
            )}</span>${row.stale ? ' <span class="warn">stale</span>' : ''}`;
      return `<tr><th scope="row">${escapeHtml(row.label)}</th><td>${closed}</td><td>${latest}</td><td>${escapeHtml(
        formatChangePct(row.changePct)
      )}</td></tr>`;
    })
    .join('');
}

function blockDateRow(block: string, date: string | null, asOf: string): string {
  return `<tr><th scope="row">${escapeHtml(block)}</th><td>${escapeHtml(
    delayText(date, asOf)
  )}</td></tr>`;
}

function statusClass(status: FreshnessStatus): string {
  return status.toLowerCase();
}

function healthRows(results: readonly FreshnessResult[]): string {
  if (results.length === 0) {
    return '<tr><td colspan="3">n/a</td></tr>';
  }
  return results
    .map(
      (result) =>
        `<tr><td>${escapeHtml(result.item)}</td><td class="${statusClass(
          result.status
        )}">${escapeHtml(result.status)}</td><td>${escapeHtml(result.detalhe)}</td></tr>`
    )
    .join('');
}

export function renderPage(
  title: string,
  body: string,
  refreshSeconds = 300
): string {
  const refresh = `<meta http-equiv="refresh" content="${Math.max(
    1,
    Math.floor(refreshSeconds)
  )}">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f1115; color: #e6e6e6; font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
header { padding: 20px 24px 0; }
h1 { margin: 0 0 8px; font-size: 22px; }
nav a { color: #8ab4f8; text-decoration: none; margin-right: 16px; }
nav a:hover { text-decoration: underline; }
main { padding: 20px 24px; }
section { margin-bottom: 24px; }
h2 { font-size: 17px; margin: 0 0 10px; color: #cfd8e3; }
table { border-collapse: collapse; width: 100%; max-width: 900px; }
th, td { border-bottom: 1px solid #262b33; padding: 8px 10px; text-align: left; vertical-align: top; }
thead th { color: #9aa4b2; font-weight: 600; }
tbody th { font-weight: 500; color: #cfd8e3; }
.ok { color: #6dd58c; font-weight: 600; }
.warn { color: #e5c07b; font-weight: 600; }
.fail { color: #f28b82; font-weight: 600; }
.muted { color: #9aa4b2; }
.notice { padding: 10px 12px; border-left: 3px solid #8ab4f8; background: #161b22; color: #cfd8e3; }
article.chart { margin-bottom: 24px; }
article.chart h3 { font-size: 15px; margin: 0 0 2px; color: #cfd8e3; }
article.chart p { margin: 0 0 8px; }
svg.chart { display: block; width: 100%; max-width: 900px; height: auto; border: 1px solid #262b33; border-radius: 6px; }
.table-scroll { overflow-x: auto; }
.token-address { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; overflow-wrap: anywhere; }
footer { padding: 16px 24px 28px; border-top: 1px solid #262b33; color: #9aa4b2; font-size: 13px; }
</style>
</head>
<body>
<header>
<h1>SOL Terminal Dashboard</h1>
<nav><a href="/">Overview</a><a href="/health">Data health</a><a href="/leverage-macro">Leverage &amp; macro</a><a href="/launchpads">Launchpads</a><a href="/tokens">Tokens</a></nav>
</header>
<main>
${body}
</main>
<footer>${escapeHtml(DASHBOARD_FOOTER)}</footer>
</body>
</html>`;
}

export function renderOverview(
  input: RecapInput,
  hourly: readonly HourlyMetricValue[] = [],
  latestPrices: readonly LatestPriceValue[] = [],
  daily: readonly DailyMetricValue[] = [],
  rolling: readonly RollingHourlyValue[] = []
): string {
  const asOf = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf : 'n/a';
  const leverageDate = oldestDate([
    input.leverage.oiUsdChange7dPct,
    input.leverage.funding7dMean,
    input.leverage.liqTotalVsMean7dPct,
    input.leverage.liqLongSharePct,
  ]);
  const macroDate = oldestDate([
    input.macro.dollarBroadChange5dPct,
    input.macro.realYield10yChange5d,
  ]);
  const launchpadDate = oldestDate(input.activity.launchpads.map((item) => item.value));

  const body = `<section>
<h2>Overview</h2>
<p class="muted">As of ${escapeHtml(asOf)}</p>
</section>
<section>
<h2>Prices</h2>
<p class="notice">${escapeHtml(INTEGRATED_NOTICE)}</p>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
<table>
<thead><tr><th>Asset</th><th>Closed</th><th>Latest</th></tr></thead>
<tbody>${PRICE_ORDER.map((asset) =>
    priceRow(input, asset, latestPrices)
  ).join('')}</tbody>
</table>
</section>
<section>
<h2>Market activity</h2>
<p class="notice">${escapeHtml(INTEGRATED_NOTICE)}</p>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
<table>
<thead><tr><th>Metric</th><th>Closed</th><th>Latest</th></tr></thead>
<tbody>${overviewActivityRows(hourly, daily)}</tbody>
</table>
</section>
<section>
<h2>Rolling activity</h2>
<p class="notice">${escapeHtml(ROLLING_HOURLY_NOTICE)}</p>
<p class="muted">Powered by DefiLlama</p>
<table>
<thead><tr><th>Metric</th><th>Rolling vs 7d mean</th><th>Source cadence</th></tr></thead>
<tbody>${overviewRollingRows(rolling)}</tbody>
</table>
</section>
<section>
<h2>Regime</h2>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
<p>${escapeHtml(regimeText(input))}</p>
<h3>Since last close (raw numbers, not part of the closed state)</h3>
<p class="notice">${escapeHtml(SINCE_LAST_CLOSE_NOTICE)}</p>
<table>
<thead><tr><th>Series</th><th>Closed</th><th>Latest</th><th>Change</th></tr></thead>
<tbody>${sinceLastCloseRows(input, latestPrices, asOf)}</tbody>
</table>
</section>
<section>
<h2>Data dates</h2>
<table>
<thead><tr><th>Block</th><th>Data date</th></tr></thead>
<tbody>
${blockDateRow('Leverage', leverageDate, input.asOf)}
${blockDateRow('Macro', macroDate, input.asOf)}
${blockDateRow('Launchpads', launchpadDate, input.asOf)}
</tbody>
</table>
</section>`;

  return renderPage('Overview', body, 300);
}

export function renderDataHealth(
  results: readonly FreshnessResult[],
  overall: FreshnessStatus,
  date: string
): string {
  const body = `<section>
<h2>Data health</h2>
<p class="muted">Reference date: ${escapeHtml(date)}</p>
<p>Overall: <span class="${statusClass(overall)}">${escapeHtml(overall)}</span></p>
</section>
<section>
<h2>Checks</h2>
<table>
<thead><tr><th>Item</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>${healthRows(results)}</tbody>
</table>
</section>`;

  return renderPage('Data health', body);
}

const CHART_TITLES: Record<string, string> = {
  macro_eurusd_change_5d_pct:
    'EUR/USD 5d change (proxy, not the broad dollar index)',
};

function chartTitle(series: IndicatorSeries): string {
  return CHART_TITLES[series.indicator] ?? series.indicator;
}

function chartArticle(series: IndicatorSeries): string {
  return `<article class="chart">
<h3>${escapeHtml(chartTitle(series))} <span class="muted">${escapeHtml(
    latestValueText(series)
  )}</span></h3>
<p class="muted">${escapeHtml(series.scope)} · ${escapeHtml(series.formulaVersion)}</p>
${renderLineChart(series)}
</article>`;
}

function coinalyzeMetricLabel(metric: string): string {
  return COINALYZE_METRIC_LABELS[metric] ?? metric;
}

function coinalyzeValueCell(row: CoinalyzeHourlyValue | undefined): string {
  if (row === undefined || row.value === null) return 'n/a';
  const value = escapeHtml(formatHourlyValue(row.value, row.unit));
  return row.stale ? `${value} <span class="warn">stale</span>` : value;
}

function coinalyzeHourlyRows(
  rows: readonly CoinalyzeHourlyValue[]
): string {
  return COINALYZE_LEVERAGE_COINS.map((coin) => {
    const scope = `coinalyze:${coin}`;
    const values = COINALYZE_LEVERAGE_METRICS.map((metric) =>
      rows.find((row) => row.scope === scope && row.metric === metric)
    );
    const latestSourceTs =
      values
        .map((row) => row?.sourceTs ?? null)
        .filter((sourceTs): sourceTs is Date => sourceTs !== null)
        .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    return `<tr><th scope="row">${escapeHtml(coin)}</th><td>${escapeHtml(
      formatCandleWindow(latestSourceTs)
    )}</td>${values
      .map((row) => `<td>${coinalyzeValueCell(row)}</td>`)
      .join('')}</tr>`;
  }).join('');
}

function hyperliquidRows(
  hourly: readonly HourlyMetricValue[],
  daily: readonly DailyMetricValue[]
): string {
  return HYPERLIQUID_COINS.flatMap((coin) =>
    HYPERLIQUID_INDICATORS.map((metric) => {
      const scope = `hyperliquid:perp:${coin}`;
      return `<tr><th scope="row">${escapeHtml(
        hyperliquidCoinLabel(scope)
      )}</th><td>${escapeHtml(metric)}</td><td>${closedMetricCell(
        findDaily(daily, scope, metric)
      )}</td><td>${latestMetricCell(
        findHourly(hourly, scope, metric)
      )}</td></tr>`;
    })
  ).join('');
}

const DOLLAR_LABELS: Record<string, string> = {
  fed_broad_dollar: 'Broad dollar index (Fed H.10)',
  ecb_eurusd: 'EUR/USD (ECB reference rate), daily proxy',
};

const DOLLAR_NOTES: Record<string, string> = {
  fed_broad_dollar: 'Weekly release (Mondays), 3 to 9 days behind',
  ecb_eurusd:
    'Measures only the euro against the dollar, not the broad dollar index',
};

function dollarValueCell(row: DollarMacroValue | undefined): string {
  if (row === undefined || row.value === null) return 'n/a';
  const value = escapeHtml(formatHourlyValue(row.value, null));
  if (row.unit === null || row.unit.length === 0) return value;
  return `${value} <span class="muted">${escapeHtml(row.unit)}</span>`;
}

function dollarDateCell(row: DollarMacroValue | undefined): string {
  if (row === undefined || row.refDate === null) return 'n/a';
  return escapeHtml(formatClosedDate(row.refDate));
}

function dollarAgeCell(row: DollarMacroValue | undefined): string {
  if (row === undefined || row.ageDays === null) return 'n/a';
  return `${row.ageDays}d old`;
}

function dollarRows(dollarMacro: readonly DollarMacroValue[]): string {
  return DOLLAR_SERIES_IDS.map((seriesId) => {
    const row = dollarMacro.find((item) => item.seriesId === seriesId);
    return `<tr><th scope="row">${escapeHtml(
      DOLLAR_LABELS[seriesId] ?? seriesId
    )}</th><td>${dollarValueCell(row)}</td><td>${dollarDateCell(
      row
    )}</td><td>${dollarAgeCell(row)}</td><td>${escapeHtml(
      DOLLAR_NOTES[seriesId] ?? ''
    )}</td></tr>`;
  }).join('');
}

export function renderLeverageMacro(
  leverage: readonly IndicatorSeries[],
  macro: readonly IndicatorSeries[],
  hyperliquidHourly: readonly HourlyMetricValue[] = [],
  hyperliquidDaily: readonly DailyMetricValue[] = [],
  asOf = 'n/a',
  coinalyzeHourly: readonly CoinalyzeHourlyValue[] = [],
  dollarMacro: readonly DollarMacroValue[] = []
): string {
  const leverageCharts =
    leverage.length === 0 ? '<p>n/a</p>' : leverage.map(chartArticle).join('\n');
  const macroCharts =
    macro.length === 0 ? '<p>n/a</p>' : macro.map(chartArticle).join('\n');

  const body = `<section>
<h2>Leverage &amp; macro</h2>
<p class="notice">Coinalyze leverage data is aggregated across exchanges; macro series have publication delays.</p>
</section>
<section>
<h2>Leverage, SOL (Coinalyze)</h2>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
${leverageCharts}
<h3>Latest closed hour</h3>
<p class="notice">${escapeHtml(COINALYZE_HOURLY_NOTICE)}</p>
<p class="muted">Data: Coinalyze (<a href="https://coinalyze.net">https://coinalyze.net</a>)</p>
<div class="table-scroll"><table>
<thead><tr><th>Coin</th><th>Latest closed hour</th>${COINALYZE_LEVERAGE_METRICS.map(
  (metric) => `<th>${escapeHtml(coinalyzeMetricLabel(metric))}</th>`
).join('')}</tr></thead>
<tbody>${coinalyzeHourlyRows(coinalyzeHourly)}</tbody>
</table></div>
</section>
<section>
<h2>Macro (US)</h2>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
<h3>Dollar</h3>
<p class="notice">${escapeHtml(DOLLAR_PROXY_NOTICE)}</p>
<div class="table-scroll"><table>
<thead><tr><th>Series</th><th>Latest value</th><th>Observation date</th><th>Age</th><th>Note</th></tr></thead>
<tbody>${dollarRows(dollarMacro)}</tbody>
</table></div>
<p class="muted">Sources: Federal Reserve H.10; European Central Bank (ECB reference rates).</p>
${macroCharts}
</section>
<section>
<h2>Hyperliquid</h2>
<p class="notice">${escapeHtml(INTEGRATED_NOTICE)}</p>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
<div class="table-scroll"><table>
<thead><tr><th>Coin</th><th>Metric</th><th>Closed</th><th>Latest</th></tr></thead>
<tbody>${hyperliquidRows(hyperliquidHourly, hyperliquidDaily)}</tbody>
</table></div>
</section>`;

  return renderPage('Leverage & macro', body);
}

export interface LaunchpadPlatformSeries {
  slug: string;
  series: IndicatorSeries;
}

export interface LaunchpadIndicatorGroup {
  indicator: string;
  unit: string;
  platforms: readonly LaunchpadPlatformSeries[];
}

const LAUNCHPAD_VALUE_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});

function launchpadLabel(slug: string): string {
  return LAUNCHPAD_LABELS[slug] ?? slug;
}

function formatLaunchpadValue(value: number, unit: string): string {
  if (unit === 'FRACTION') return `${(value * 100).toFixed(2)}%`;
  if (unit === 'RATIO') return value.toFixed(4);
  const suffix = unit === 'n/a' ? '' : ` ${unit}`;
  return `${LAUNCHPAD_VALUE_FORMATTER.format(value)}${suffix}`;
}

function launchpadCell(series: IndicatorSeries | undefined): string {
  if (series === undefined) return 'n/a';
  const point = latestPoint(series);
  if (point === null) return 'n/a';
  const delay = delayDays(new Date(`${point.date}T00:00:00.000Z`), series.to);
  return `${formatLaunchpadValue(point.value, series.unit)} (${point.date}, ${delay}d delay)`;
}

export function renderLaunchpads(
  groups: readonly LaunchpadIndicatorGroup[],
  hourly: readonly HourlyMetricValue[] = [],
  asOf = 'n/a',
  rolling: readonly RollingHourlyValue[] = []
): string {
  const platformList = LAUNCHPAD_SLUGS.map((slug) => launchpadLabel(slug)).join(', ');
  const platformSlugs = [
    ...new Set([...LAUNCHPAD_SLUGS, ...HOURLY_LAUNCHPAD_SLUGS]),
  ];
  const shareSummaryNote = groups.some((group) => group.indicator.includes('share'))
    ? `<p class="muted">share among the 4 platforms covered: ${escapeHtml(platformList)}</p>`
    : '';

  const table = `<div class="table-scroll"><table>
<thead><tr><th>Platform</th>${groups
    .map((group) => `<th>${escapeHtml(group.indicator)}</th>`)
    .join('')}<th>Rolling vs 7d mean</th><th>Source cadence</th><th>Latest 24h volume</th><th>Latest 24h fees</th></tr></thead>
<tbody>${platformSlugs
    .map((slug) => {
      const cells = groups
        .map((group) => {
          const platform = group.platforms.find((item) => item.slug === slug);
          return `<td>${escapeHtml(launchpadCell(platform?.series))}</td>`;
        })
        .join('');
      const scope = `solana:protocol:${slug}`;
      const latestVolume = findHourly(hourly, scope, 'dex_volume_24h_usd');
      const latestFees = findHourly(hourly, scope, 'fees_24h_usd');
      const rollingVolume = findRolling(rolling, scope, 'dex_volume_24h_usd');
      const rollingFees = findRolling(rolling, scope, 'fees_24h_usd');
      return `<tr><th scope="row">${escapeHtml(launchpadLabel(slug))}</th>${cells}<td>${launchpadRollingCell(
        rollingVolume,
        rollingFees
      )}</td><td>${launchpadCadenceCell(
        rollingVolume,
        rollingFees
      )}</td><td>${latestMetricCell(latestVolume)}</td><td>${latestMetricCell(
        latestFees
      )}</td></tr>`;
    })
    .join('')}</tbody>
</table></div>`;

  const charts =
    groups.length === 0
      ? '<p>n/a</p>'
      : groups
          .map((group) => {
            const first = group.platforms[0]?.series;
            const from = first?.from ?? 'n/a';
            const to = first?.to ?? 'n/a';
            const shareNote = group.indicator.includes('share')
              ? ` <span class="muted">share among the 4 platforms covered: ${escapeHtml(
                  platformList
                )}</span>`
              : '';
            return `<article class="chart">
<h3>${escapeHtml(group.indicator)}${shareNote}</h3>
<p class="muted">${escapeHtml(group.unit)}</p>
${renderMultiLineChart(
  group.platforms.map((platform) => ({
    label: launchpadLabel(platform.slug),
    points: platform.series.points,
  })),
  { from, to, unit: group.unit }
)}
</article>`;
          })
          .join('\n');

  const body = `<section>
<h2>Launchpads</h2>
<p class="notice">High volume is not the same as organic adoption (bots, arbitrage and circular volume are not detected).</p>
<p class="notice">Launchpad data arrives with a 2-day delay. Values are relative to the 4 platforms covered.</p>
</section>
<section>
<h2>Summary</h2>
<p class="notice">${escapeHtml(INTEGRATED_NOTICE)}</p>
<p class="notice">${escapeHtml(ROLLING_HOURLY_NOTICE)}</p>
<p class="muted">Powered by DefiLlama</p>
<p class="muted">Computed on closed day ${escapeHtml(asOf)}</p>
${shareSummaryNote}
${table}
</section>
<section>
<h2>Charts (last 90 days)</h2>
${charts}
</section>`;

  return renderPage('Launchpads', body);
}

const TOKEN_ESTIMATED_NOTICE =
  "Estimated market cap applies today's implied circulating supply to past prices; unlocks, burns and mints are not reflected, so it can be far from the true historical value.";

const TOKEN_NOTICES = [
  'Values are among the 10 tokens observed, not a market rate.',
  'Raw numbers only: no good/bad label, and sophisticated bot activity is not detected.',
  'Token data comes from GeckoTerminal and is captured 4 times a day.',
  'Market cap uses circulating supply and FDV uses total supply, both as reported by GeckoTerminal. Ratios are raw numbers with no good/bad label.',
] as const;

const TOKEN_PRICE_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 8,
});

const TOKEN_USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const TOKEN_MARKET_CAP_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const TOKEN_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
});

function tokenNotices(): string {
  return TOKEN_NOTICES.map((notice) => `<p class="notice">${escapeHtml(notice)}</p>`).join(
    '\n'
  );
}

function tokenText(value: string | null | undefined, maxLength = 40): string {
  const clean = sanitizeHtml(value, maxLength);
  return clean.length > 0 ? clean : 'n/a';
}

function tokenAddress(value: string): string {
  const clean = sanitizeText(value, 200);
  const short =
    clean.length <= 8 ? clean : `${clean.slice(0, 4)}…${clean.slice(-4)}`;
  return escapeHtml(short);
}

function tokenPrice(value: number | null): string {
  return value === null ? 'n/a' : TOKEN_PRICE_FORMATTER.format(value);
}

function tokenUsd(value: number | null): string {
  return value === null ? 'n/a' : TOKEN_USD_FORMATTER.format(value);
}

function tokenMarketCap(value: number | null): string {
  return value === null ? 'n/a' : TOKEN_MARKET_CAP_FORMATTER.format(value);
}

function tokenRatio(numerator: number | null, marketCap: number | null): number | null {
  if (numerator === null || marketCap === null || marketCap === 0) return null;
  const result = (numerator / marketCap) * 100;
  return Number.isFinite(result) ? result : null;
}

function tokenPercent(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`;
}

function tokenWithChange(value: string, change: number | null): string {
  return `${escapeHtml(value)} <span class="muted">(24h ${escapeHtml(tokenChange(change))})</span>`;
}

function tokenNumber(value: number | null): string {
  return value === null ? 'n/a' : TOKEN_NUMBER_FORMATTER.format(value);
}

function tokenChange(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function tokenDateTime(value: Date | null): string {
  if (value === null) return 'n/a';
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const TOKEN_GAP_MS = 9 * 60 * 60 * 1000;

function tokenChart(
  detail: Pick<TokenDetail, 'from' | 'to'>,
  indicator: string,
  unit: string,
  points: readonly TokenChartPoint[]
): string {
  return renderTimeLineChart(points, {
    from: new Date(`${detail.from}T00:00:00.000Z`),
    to: new Date(`${detail.to}T23:59:59.999Z`),
    unit,
    indicator,
    gapMs: TOKEN_GAP_MS,
  });
}

function tokenMarketCapChart(detail: TokenDetail): string {
  const series: {
    label: string;
    points: TokenChartPoint[];
    dashed?: boolean;
  }[] = [];
  if (detail.marketCapPoints.length > 0) {
    series.push({ label: 'Reported', points: detail.marketCapPoints });
  }
  if (detail.marketCapEstimatedPoints.length > 0) {
    series.push({
      label: 'Estimated (price × latest implied supply)',
      points: detail.marketCapEstimatedPoints,
      dashed: true,
    });
  }
  if (series.length === 0) return '<p>n/a</p>';

  return renderMultiLineChart(series, {
    from: new Date(`${detail.from}T00:00:00.000Z`),
    to: new Date(`${detail.to}T23:59:59.999Z`),
    unit: 'USD',
    gapMs: TOKEN_GAP_MS,
    indicator: 'market_cap_usd',
  });
}

export function renderTokens(summaries: readonly TokenSummary[]): string {
  const table =
    summaries.length === 0
      ? '<p>n/a</p>'
      : `<div class="table-scroll"><table>
<thead><tr><th>Symbol</th><th>Address</th><th>Market cap</th><th>FDV</th><th>Price (USD)</th><th>Liquidity</th><th>Liquidity / market cap</th><th>Volume 24h</th><th>Volume 24h / market cap</th><th>Pools</th><th>Holders</th><th>Last capture (UTC)</th></tr></thead>
<tbody>${summaries
          .map((token) => {
            const latest = token.latest;
            const marketCap = latest?.marketCapUsd ?? null;
            const liquidity = latest?.liquidityUsd ?? null;
            const volume = latest?.volume24hUsd ?? null;
            return `<tr><th scope="row"><a href="/tokens/${escapeHtml(
              encodeURIComponent(token.address)
            )}">${tokenText(token.symbol)}</a></th><td class="token-address">${sanitizeHtml(
              token.address,
              200
            )}</td><td class="token-market-cap">${tokenWithChange(
              tokenMarketCap(marketCap),
              token.marketCapChangePct
            )}</td><td class="token-fdv">${escapeHtml(
              tokenMarketCap(latest?.fdvUsd ?? null)
            )}</td><td class="token-price">${tokenWithChange(
              tokenPrice(latest?.priceUsd ?? null),
              token.priceChangePct
            )}</td><td class="token-liquidity">${tokenWithChange(
              tokenUsd(liquidity),
              token.liquidityChangePct
            )}</td><td class="token-ratio">${escapeHtml(
              tokenPercent(tokenRatio(liquidity, marketCap))
            )}</td><td class="token-volume">${tokenWithChange(
              tokenUsd(volume),
              token.volumeChangePct
            )}</td><td class="token-ratio">${escapeHtml(
              tokenPercent(tokenRatio(volume, marketCap))
            )}</td><td>${escapeHtml(
              tokenNumber(token.poolsObserved)
            )}</td><td>${escapeHtml(
              tokenNumber(token.holdersCount)
            )}</td><td>${escapeHtml(
              tokenDateTime(latest?.capturedAt ?? null)
            )}</td></tr>`;
          })
          .join('')}</tbody>
</table></div>`;

  const charts =
    summaries.length === 0
      ? '<p>n/a</p>'
      : summaries
          .map(
            (token) => `<article class="chart">
<h3>${tokenText(token.symbol)} price</h3>
<p class="muted">${tokenAddress(token.address)} · last 14 days</p>
${tokenChart(token, 'price_usd', 'USD', token.pricePoints)}
</article>`
          )
          .join('\n');

  const body = `<section>
<h2>Tokens</h2>
${tokenNotices()}
</section>
<section>
<h2>Summary</h2>
${table}
</section>
<section>
<h2>Price charts (last 14 days)</h2>
${charts}
</section>`;

  return renderPage('Tokens', body);
}

function poolRows(detail: TokenDetail): string {
  if (detail.pools.length === 0) {
    return '<tr><td colspan="8">n/a</td></tr>';
  }
  return detail.pools
    .map(
      (pool) => `<tr><td>${tokenText(pool.dexId)}</td><td>${escapeHtml(
        tokenUsd(pool.reserveInUsd)
      )}</td><td>${escapeHtml(tokenUsd(pool.volume24hUsd))}</td><td>${escapeHtml(
        tokenNumber(pool.buys24h)
      )}</td><td>${escapeHtml(tokenNumber(pool.sells24h))}</td><td>${escapeHtml(
        tokenNumber(pool.buyers24h)
      )}</td><td>${escapeHtml(tokenNumber(pool.sellers24h))}</td><td>${escapeHtml(
        tokenDateTime(pool.poolCreatedAt)
      )}</td></tr>`
    )
    .join('');
}

function holderRows(detail: TokenDetail): string {
  const holder = detail.holder;
  if (holder === null) {
    return '<tr><td colspan="6">n/a</td></tr>';
  }
  return `<tr><td>${escapeHtml(tokenNumber(holder.holdersCount))}</td><td>${escapeHtml(
    tokenNumber(holder.top10Pct)
  )}</td><td>${escapeHtml(tokenNumber(holder.rank11to20Pct))}</td><td>${escapeHtml(
    tokenNumber(holder.rank21to40Pct)
  )}</td><td>${escapeHtml(tokenNumber(holder.restPct))}</td><td>${escapeHtml(
    tokenDateTime(holder.sourceLastUpdated)
  )}</td></tr>`;
}

export function renderTokenDetail(detail: TokenDetail): string {
  const body = `<section>
<h2>${tokenText(detail.symbol)} ${tokenText(detail.name)}</h2>
<p class="muted token-address">${sanitizeHtml(detail.address, 200)}</p>
<p class="muted">Last capture: ${escapeHtml(
    tokenDateTime(detail.latest?.capturedAt ?? null)
  )}</p>
${tokenNotices()}
</section>
<section>
<h2>Price (last 14 days)</h2>
${tokenChart(detail, 'price_usd', 'USD', detail.pricePoints)}
</section>
<section>
<h2>Liquidity (last 14 days)</h2>
${tokenChart(detail, 'liquidity_usd', 'USD', detail.liquidityPoints)}
</section>
<section>
<h2>Volume 24h (last 14 days)</h2>
${tokenChart(detail, 'volume_24h_usd', 'USD', detail.volumePoints)}
</section>
<section>
<h2>Market cap (last 14 days)</h2>
${tokenMarketCapChart(detail)}
<p class="notice">${TOKEN_ESTIMATED_NOTICE}</p>
${detail.marketCapEstimatedPoints.length === 0 ? '<p class="muted">Estimated: n/a</p>' : ''}
</section>
<section>
<h2>FDV (last 14 days)</h2>
${tokenChart(detail, 'fdv_usd', 'USD', detail.fdvPoints)}
</section>
<section>
<h2>Pools (latest capture)</h2>
<div class="table-scroll"><table>
<thead><tr><th>DEX</th><th>Reserve in USD</th><th>Volume 24h</th><th>Buys</th><th>Sells</th><th>Buyers</th><th>Sellers</th><th>Pool created</th></tr></thead>
<tbody>${poolRows(detail)}</tbody>
</table></div>
</section>
<section>
<h2>Holders (latest capture)</h2>
<div class="table-scroll"><table>
<thead><tr><th>Count</th><th>Top 10</th><th>11-20</th><th>21-40</th><th>Rest</th><th>Source last updated</th></tr></thead>
<tbody>${holderRows(detail)}</tbody>
</table></div>
</section>`;

  return renderPage('Token', body);
}
