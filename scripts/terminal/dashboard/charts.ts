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

export interface MultiLineSeries {
  label: string;
  points: readonly SeriesPoint[];
}

export interface MultiLineOptions {
  from: string;
  to: string;
  unit: string;
}

export const MULTI_LINE_COLORS = ['#8ab4f8', '#c3a6ff', '#6dd3c1', '#e0b0ff'] as const;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMultiLineChart(
  seriesList: readonly MultiLineSeries[],
  options: MultiLineOptions
): string {
  const allPoints = seriesList.flatMap((item) => item.points);
  if (allPoints.length === 0) return emptyChart();

  const width = SVG_WIDTH;
  const height = 280;
  const padLeft = PAD_LEFT;
  const padRight = PAD_RIGHT;
  const padTop = 44;
  const padBottom = 36;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const fromMs = dayMs(options.from);
  const toMs = dayMs(options.to);
  const spanMs = toMs - fromMs;

  const values = allPoints.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const valueSpan = max - min;

  const xFor = (date: string): number => {
    if (spanMs <= 0) return padLeft;
    const ratio = (dayMs(date) - fromMs) / spanMs;
    return padLeft + Math.max(0, Math.min(1, ratio)) * plotWidth;
  };
  const yFor = (value: number): number =>
    padTop + ((max - value) / valueSpan) * plotHeight;

  const legend = seriesList
    .map((item, index) => {
      const color = MULTI_LINE_COLORS[index % MULTI_LINE_COLORS.length];
      const x = padLeft + index * 140;
      return `<rect x="${x}" y="10" width="10" height="10" fill="${color}"/><text x="${
        x + 14
      }" y="19" fill="#cfd8e3" font-size="11">${escapeXml(item.label)}</text>`;
    })
    .join('');

  const lines = seriesList
    .map((item, index) => {
      const color = MULTI_LINE_COLORS[index % MULTI_LINE_COLORS.length];
      const ordered = [...item.points].sort(
        (left, right) => dayMs(left.date) - dayMs(right.date)
      );
      const segments: SeriesPoint[][] = [];
      let current: SeriesPoint[] = [];
      for (const point of ordered) {
        const previous = current[current.length - 1];
        if (
          previous === undefined ||
          dayMs(point.date) - dayMs(previous.date) === DAY_MS
        ) {
          current.push(point);
        } else {
          segments.push(current);
          current = [point];
        }
      }
      if (current.length > 0) segments.push(current);

      return segments
        .map((segment) => {
          const d = segment
            .map((point, pointIndex) => {
              const command = pointIndex === 0 ? 'M' : 'L';
              return `${command}${xFor(point.date).toFixed(2)},${yFor(
                point.value
              ).toFixed(2)}`;
            })
            .join(' ');
          return `<path class="chart-line" d="${d}" fill="none" stroke="${color}" stroke-width="2"/>`;
        })
        .join('');
    })
    .join('');

  const unitLabel = options.unit === 'n/a' ? '' : options.unit;

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="launchpad chart" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${width}" height="${height}" fill="#12151b"/>
${legend}
<line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${
    padTop + plotHeight
  }" stroke="#2b313a"/>
<line x1="${padLeft}" y1="${padTop + plotHeight}" x2="${
    padLeft + plotWidth
  }" y2="${padTop + plotHeight}" stroke="#2b313a"/>
<text x="${padLeft - 6}" y="${padTop + 4}" fill="#9aa4b2" font-size="11" text-anchor="end">${formatNumber(
    max
  )}</text>
<text x="${padLeft - 6}" y="${padTop + plotHeight + 4}" fill="#9aa4b2" font-size="11" text-anchor="end">${formatNumber(
    min
  )}</text>
<text x="${padLeft}" y="${padTop - 10}" fill="#9aa4b2" font-size="11">${unitLabel}</text>
<text x="${padLeft}" y="${height - 12}" fill="#9aa4b2" font-size="11">${options.from}</text>
<text x="${padLeft + plotWidth}" y="${
    height - 12
  }" fill="#9aa4b2" font-size="11" text-anchor="end">${options.to}</text>
${lines}
</svg>`;
}

export interface TimeSeriesPoint {
  at: Date;
  value: number;
}

export interface TimeLineOptions {
  from: Date;
  to: Date;
  unit: string;
  indicator: string;
  gapMs: number;
}

export function renderTimeLineChart(
  points: readonly TimeSeriesPoint[],
  options: TimeLineOptions
): string {
  if (points.length === 0) return emptyChart();

  const fromMs = options.from.getTime();
  const toMs = options.to.getTime();
  const spanMs = toMs - fromMs;

  const ordered = [...points].sort(
    (left, right) => left.at.getTime() - right.at.getTime()
  );
  const values = ordered.map((point) => point.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const pad = Math.abs(max) > 0 ? Math.abs(max) * 0.1 : 1;
    min -= pad;
    max += pad;
  }
  const valueSpan = max - min;

  const xFor = (at: Date): number => {
    if (spanMs <= 0) return PAD_LEFT;
    const ratio = (at.getTime() - fromMs) / spanMs;
    return PAD_LEFT + Math.max(0, Math.min(1, ratio)) * PLOT_WIDTH;
  };
  const yFor = (value: number): number =>
    PAD_TOP + ((max - value) / valueSpan) * PLOT_HEIGHT;

  const segments: TimeSeriesPoint[][] = [];
  let current: TimeSeriesPoint[] = [];
  for (const point of ordered) {
    const previous = current[current.length - 1];
    if (
      previous === undefined ||
      point.at.getTime() - previous.at.getTime() <= options.gapMs
    ) {
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
          return `${command}${xFor(point.at).toFixed(2)},${yFor(point.value).toFixed(2)}`;
        })
        .join(' ');
      return `<path class="chart-line" d="${d}" fill="none" stroke="#8ab4f8" stroke-width="2"/>`;
    })
    .join('');

  const circles = ordered
    .map(
      (point) =>
        `<circle class="chart-point" data-date="${point.at.toISOString()}" data-value="${String(
          point.value
        )}" cx="${xFor(point.at).toFixed(2)}" cy="${yFor(point.value).toFixed(
          2
        )}" r="2" fill="#8ab4f8"/>`
    )
    .join('');

  const unitLabel = options.unit === 'n/a' ? '' : options.unit;
  const fromLabel = new Date(fromMs).toISOString().slice(0, 10);
  const toLabel = new Date(toMs).toISOString().slice(0, 10);

  return `<svg class="chart" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="${escapeXml(
    options.indicator
  )}" xmlns="http://www.w3.org/2000/svg">
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
<text x="${PAD_LEFT}" y="${PAD_TOP - 10}" fill="#9aa4b2" font-size="11">${escapeXml(
    unitLabel
  )}</text>
<text x="${PAD_LEFT}" y="${SVG_HEIGHT - 12}" fill="#9aa4b2" font-size="11">${fromLabel}</text>
<text x="${PAD_LEFT + PLOT_WIDTH}" y="${
    SVG_HEIGHT - 12
  }" fill="#9aa4b2" font-size="11" text-anchor="end">${toLabel}</text>
${lines}
${circles}
</svg>`;
}
