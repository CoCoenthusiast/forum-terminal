import {
  MACRO_SOURCE_INFO,
  InvalidPayloadError,
  addUtcDays,
  decimalString,
  formatIsoDateUtc,
  normalizeHeader,
  parseCsv,
  parseIsoDateUtc,
  startOfUtcDay,
  type FedSeriesDefinition,
  type MacroFetchResult,
  type MacroHttpClient,
  type MacroObservationValue,
} from './macro-config';

export const FED_H10_ENDPOINT = '/datadownload/Output.aspx';
export const FED_H10_SERIES = '122e3bcb627e8e53f1bf72a1a09cfb81';
export const FED_H10_LASTOBS = 30;

export interface FedRate {
  refDate: Date;
  value: string | null;
  status: 'ok' | 'nd';
}

export interface FedParseResult {
  rates: FedRate[];
  warnings: string[];
}

export function latestFedObservationDate(endDate: Date): Date {
  const daysSinceFriday = (endDate.getUTCDay() + 2) % 7;
  return addUtcDays(startOfUtcDay(endDate), -daysSinceFriday);
}

export function fedH10Url(startDate?: Date, endDate?: Date): string {
  const base =
    `${MACRO_SOURCE_INFO.fed.baseUrl}${FED_H10_ENDPOINT}` +
    `?rel=H10&series=${FED_H10_SERIES}`;
  const range =
    startDate !== undefined && endDate !== undefined
      ? `&from=${formatIsoDateUtc(startDate)}&to=${formatIsoDateUtc(
          latestFedObservationDate(endDate)
        )}`
      : `&lastobs=${FED_H10_LASTOBS}`;

  return `${base}${range}&filetype=csv&label=include&layout=seriescolumn`;
}

function findBroadDollarColumn(rows: readonly string[][], headerIndex: number): number {
  const header = rows[headerIndex] ?? [];
  const normalizedHeader = header.map((value) => normalizeHeader(value).toLowerCase());
  let column = normalizedHeader.indexOf('nominal broad dollar index');

  if (column < 0) {
    column = normalizedHeader.indexOf('jrxwtfb_n.b');
  }

  if (column < 0) {
    column = normalizedHeader.findIndex((value) => value.includes('broad dollar'));
  }

  if (column < 0) {
    for (const row of rows.slice(0, headerIndex)) {
      const label = normalizeHeader(row[0] ?? '').toLowerCase();

      if (label !== 'series description') {
        continue;
      }

      column = row.findIndex(
        (value) => normalizeHeader(value).toLowerCase() === 'nominal broad dollar index'
      );

      if (column >= 0) {
        break;
      }
    }
  }

  return column;
}

export function parseFedCsv(csv: string): FedParseResult {
  const rows = parseCsv(csv);
  const headerIndex = rows.findIndex(
    (row) => normalizeHeader(row[0] ?? '').toLowerCase() === 'time period'
  );

  if (headerIndex < 0) {
    throw new InvalidPayloadError('Fed H.10: cabeçalho Time Period ausente');
  }

  const column = findBroadDollarColumn(rows, headerIndex);

  if (column < 0) {
    throw new InvalidPayloadError(
      'Fed H.10: coluna Nominal Broad Dollar Index ausente no cabeçalho'
    );
  }

  const rates: FedRate[] = [];
  const warnings: string[] = [];
  let dataRows = 0;

  for (const cells of rows.slice(headerIndex + 1)) {
    const dateRaw = normalizeHeader(cells[0] ?? '');

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
      continue;
    }

    dataRows++;
    const refDate = parseIsoDateUtc(dateRaw);

    if (refDate === null) {
      warnings.push(`Fed H.10: data inválida ${dateRaw}`);
      continue;
    }

    const raw = cells[column]?.trim() ?? '';

    if (/^ND$/i.test(raw)) {
      rates.push({ refDate, value: null, status: 'nd' });
      continue;
    }

    const value = decimalString(raw);

    if (value === null) {
      warnings.push(`Fed H.10: ${dateRaw} valor inválido (${raw || '(vazio)'})`);
      continue;
    }

    rates.push({ refDate, value, status: 'ok' });
  }

  if (dataRows === 0) {
    throw new InvalidPayloadError('Fed H.10: nenhuma linha de dados YYYY-MM-DD');
  }

  return { rates, warnings };
}

export async function fetchFedObservations(
  http: MacroHttpClient,
  series: readonly FedSeriesDefinition[],
  startDate: Date,
  endDate: Date,
  isBackfill: boolean
): Promise<MacroFetchResult> {
  if (series.length === 0) {
    return { observations: [], warnings: [] };
  }

  if (isBackfill && latestFedObservationDate(endDate) < startDate) {
    return {
      observations: [],
      warnings: ['Fed H.10: período ainda sem observação publicada'],
    };
  }

  const url = isBackfill ? fedH10Url(startDate, endDate) : fedH10Url();
  const response = await http.getTextWithMetadata(url, 'text/csv,*/*');

  if (
    response.contentType === null ||
    !/^text\/csv\b/i.test(response.contentType.trim())
  ) {
    throw new InvalidPayloadError(
      `Fed H.10: content-type inesperado (${response.contentType ?? 'ausente'})`
    );
  }

  const prefix = response.text.slice(0, 4096).toLowerCase();

  if (prefix.includes('<!doctype html') || prefix.includes('<html')) {
    throw new InvalidPayloadError('Fed H.10: resposta contém HTML em vez de CSV');
  }

  const parsed = parseFedCsv(response.text);
  const observations: MacroObservationValue[] = [];

  for (const definition of series) {
    for (const rate of parsed.rates) {
      if (isBackfill && (rate.refDate < startDate || rate.refDate > endDate)) {
        continue;
      }

      observations.push({
        seriesId: definition.seriesId,
        source: 'fed',
        unit: definition.unit,
        refDate: rate.refDate,
        value: rate.value,
        status: rate.status,
        revisionIndicator: null,
      });
    }
  }

  return { observations, warnings: parsed.warnings };
}
