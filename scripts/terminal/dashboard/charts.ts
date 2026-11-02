import type { IndicatorSeries, SeriesPoint } from './series-reader';

const DAY_MS = 24 * 60 * 60 * 1000;
const SVG_WIDTH = 640;
const SVG_HEIGHT = 220;
const PAD_LEFT = 64;
const PAD_RIGHT = 16;
const PAD_TOP = 28;
const PAD_BOTTOM = 36;
const PLOT_WIDTH = SVG_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = SVG_HEIGHT - PAD_TOP - PAD_BOTTOM;

const NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
});

function formatNumber(value: number): string {
  return NUMBER_FORMATTER.format(value);
}

function dayMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

export function latestPoint(series: IndicatorSeries): SeriesPoint | null {
  if (series.points.length === 0) return null;
  return series.points[series.points.length - 1];
}

export function latestValueText(series: IndicatorSeries): string {
  const point = latestPoint(series);
  if (point === null) return 'n/a';
  const unit = series.unit === 'n/a' ? '' : ` ${series.unit}`;
  return `${formatNumber(point.value)}${unit} (${point.date})`;
}

function emptyChart(): string {
  return `<svg class="chart" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="n/a" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#12151b"/>
<text x="${SVG_WIDTH / 2}" y="${SVG_HEIGHT / 2}" fill="#9aa4b2" font-size="14" text-anchor="middle">n/a</text>
</svg>`;
}

export function renderLineChart(series: IndicatorSeries): string {
  if (series.points.length === 0) return emptyChart();

  const fromMs = dayMs(series.from);
  const toMs = dayMs(series.to);
  const spanMs = toMs - fromMs;

  const ordered = [...series.points].sort((left, right) => dayMs(left.date) - dayMs(right.date));
  const values = ordered.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const valueSpan = max - min;

  const xFor = (date: string): number => {
    if (spanMs <= 0) return PAD_LEFT;
    const ratio = (dayMs(date) - fromMs) / spanMs;
    return PAD_LEFT + Math.max(0, Math.min(1, ratio)) * PLOT_WIDTH;
  };
  const yFor = (value: number): number =>
    PAD_TOP + ((max - value) / valueSpan) * PLOT_HEIGHT;

  const segments: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const point of ordered) {
    const previous = current[current.length - 1];
    if (previous === undefined || dayMs(point.date) - dayMs(previous.date) === DAY_MS) {
      current.push(point);
    } else {
      segments.push(current);
      current = [point];
    }
  }
  if (current.length > 0) segments.push(current);

  const lines = segments
    .map((segment) => {
      const d = segment
        .map((point, index) => {
          const command = index === 0 ? 'M' : 'L';
          return `${command}${xFor(point.date).toFixed(2)},${yFor(point.value).toFixed(2)}`;
        })
        .join(' ');
      return `<path class="chart-line" d="${d}" fill="none" stroke="#8ab4f8" stroke-width="2"/>`;
    })
    .join('');

  const circles = ordered
    .map(
      (point) =>
        `<circle class="chart-point" data-date="${point.date}" data-value="${String(
          point.value
        )}" cx="${xFor(point.date).toFixed(2)}" cy="${yFor(point.value).toFixed(
          2
        )}" r="2" fill="#8ab4f8"/>`
    )
    .join('');

  const unitLabel = series.unit === 'n/a' ? '' : series.unit;

  return `<svg class="chart" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="${series.indicator}" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#12151b"/>
<line x1="${PAD_LEFT}" y1="${PAD_TOP}" x2="${PAD_LEFT}" y2="${
    PAD_TOP + PLOT_HEIGHT
  }" stroke="#2b313a"/>
<line x1="${PAD_LEFT}" y1="${PAD_TOP + PLOT_HEIGHT}" x2="${
    PAD_LEFT + PLOT_WIDTH
  }" y2="${PAD_TOP + PLOT_HEIGHT}" stroke="#2b313a"/>
<text x="${PAD_LEFT - 6}" y="${PAD_TOP + 4}" fill="#9aa4b2" font-size="11" text-anchor="end">${formatNumber(
    max
  )}</text>
<text x="${PAD_LEFT - 6}" y="${PAD_TOP + PLOT_HEIGHT + 4}" fill="#9aa4b2" font-size="11" text-anchor="end">${formatNumber(
    min
  )}</text>
<text x="${PAD_LEFT}" y="${PAD_TOP - 10}" fill="#9aa4b2" font-size="11">${unitLabel}</text>
<text x="${PAD_LEFT}" y="${SVG_HEIGHT - 12}" fill="#9aa4b2" font-size="11">${series.from}</text>
<text x="${PAD_LEFT + PLOT_WIDTH}" y="${
    SVG_HEIGHT - 12
  }" fill="#9aa4b2" font-size="11" text-anchor="end">${series.to}</text>
${lines}
${circles}
</svg>`;
}
