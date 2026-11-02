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
import type { TokenChartPoint, TokenDetail, TokenSummary } from './token-reader';

export const DASHBOARD_FOOTER =
  'Local read-only dashboard. Data: CoinGecko, DefiLlama, Coinalyze, U.S. Treasury, Federal Reserve. Not financial advice.';

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

function priceRow(input: RecapInput, asset: string): string {
  const price = input.prices.find((item) => item.asset.toUpperCase() === asset) ?? null;
  return `<tr><th scope="row">${escapeHtml(asset)}</th><td>${escapeHtml(
    formatPrice(price?.priceUsd)
  )}</td></tr>`;
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

export function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
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

export function renderOverview(input: RecapInput): string {
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
<table>
<thead><tr><th>Asset</th><th>Price</th></tr></thead>
<tbody>${PRICE_ORDER.map((asset) => priceRow(input, asset)).join('')}</tbody>
</table>
</section>
<section>
<h2>Regime</h2>
<p>${escapeHtml(regimeText(input))}</p>
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

  return renderPage('Overview', body);
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

function chartArticle(series: IndicatorSeries): string {
  return `<article class="chart">
<h3>${escapeHtml(series.indicator)} <span class="muted">${escapeHtml(
    latestValueText(series)
  )}</span></h3>
<p class="muted">${escapeHtml(series.scope)} · ${escapeHtml(series.formulaVersion)}</p>
${renderLineChart(series)}
</article>`;
}

export function renderLeverageMacro(
  leverage: readonly IndicatorSeries[],
  macro: readonly IndicatorSeries[]
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
${leverageCharts}
</section>
<section>
<h2>Macro (US)</h2>
${macroCharts}
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

export function renderLaunchpads(groups: readonly LaunchpadIndicatorGroup[]): string {
  const platformList = LAUNCHPAD_SLUGS.map((slug) => launchpadLabel(slug)).join(', ');
  const shareSummaryNote = groups.some((group) => group.indicator.includes('share'))
    ? `<p class="muted">share among the 4 platforms covered: ${escapeHtml(platformList)}</p>`
    : '';

  const table =
    groups.length === 0
      ? '<p>n/a</p>'
      : `<div class="table-scroll"><table>
<thead><tr><th>Platform</th>${groups
          .map((group) => `<th>${escapeHtml(group.indicator)}</th>`)
          .join('')}</tr></thead>
<tbody>${LAUNCHPAD_SLUGS.map((slug) => {
          const cells = groups
            .map((group) => {
              const platform = group.platforms.find((item) => item.slug === slug);
              return `<td>${escapeHtml(launchpadCell(platform?.series))}</td>`;
            })
            .join('');
          return `<tr><th scope="row">${escapeHtml(launchpadLabel(slug))}</th>${cells}</tr>`;
        }).join('')}</tbody>
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
${shareSummaryNote}
${table}
</section>
<section>
<h2>Charts (last 90 days)</h2>
${charts}
</section>`;

  return renderPage('Launchpads', body);
}

const TOKEN_NOTICES = [
  'Values are among the 10 tokens observed, not a market rate.',
  'Raw numbers only: no good/bad label, and sophisticated bot activity is not detected.',
  'Token data comes from GeckoTerminal and is captured 4 times a day.',
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

export function renderTokens(summaries: readonly TokenSummary[]): string {
  const table =
    summaries.length === 0
      ? '<p>n/a</p>'
      : `<div class="table-scroll"><table>
<thead><tr><th>Symbol</th><th>Name</th><th>Address</th><th>Price</th><th>Price 24h</th><th>Liquidity</th><th>Liquidity 24h</th><th>Volume 24h</th><th>Volume 24h change</th><th>Pools</th><th>Holders</th><th>Last capture (UTC)</th></tr></thead>
<tbody>${summaries
          .map(
            (token) => `<tr><th scope="row">${tokenText(
              token.symbol
            )}</th><td>${tokenText(token.name)}</td><td>${tokenAddress(
              token.address
            )}</td><td>${escapeHtml(
              tokenPrice(token.latest?.priceUsd ?? null)
            )}</td><td>${escapeHtml(
              tokenChange(token.priceChangePct)
            )}</td><td>${escapeHtml(
              tokenUsd(token.latest?.liquidityUsd ?? null)
            )}</td><td>${escapeHtml(
              tokenChange(token.liquidityChangePct)
            )}</td><td>${escapeHtml(
              tokenUsd(token.latest?.volume24hUsd ?? null)
            )}</td><td>${escapeHtml(
              tokenChange(token.volumeChangePct)
            )}</td><td>${escapeHtml(
              tokenNumber(token.poolsObserved)
            )}</td><td>${escapeHtml(
              tokenNumber(token.holdersCount)
            )}</td><td>${escapeHtml(
              tokenDateTime(token.latest?.capturedAt ?? null)
            )}</td></tr>`
          )
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
<p class="muted">${sanitizeHtml(detail.address, 200)}</p>
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
