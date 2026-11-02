import { REGIME_LABELS, type RecapInput, type RecapMetric } from '../recap/recap-format';
import { delayDays, type FreshnessResult, type FreshnessStatus } from '../checks/freshness-rules';

export const DASHBOARD_FOOTER =
  'Local read-only dashboard. Data: CoinGecko, DefiLlama, Coinalyze, U.S. Treasury, Federal Reserve. Not financial advice.';

const PRICE_ORDER = ['SOL', 'BTC', 'ETH'] as const;

const USD_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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
footer { padding: 16px 24px 28px; border-top: 1px solid #262b33; color: #9aa4b2; font-size: 13px; }
</style>
</head>
<body>
<header>
<h1>SOL Terminal Dashboard</h1>
<nav><a href="/">Overview</a><a href="/health">Data health</a></nav>
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
