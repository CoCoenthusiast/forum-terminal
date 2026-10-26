import {
  MACRO_SOURCE_INFO,
  InvalidPayloadError,
  decimalString,
  formatIsoDateUtc,
  isMissingMacroValue,
  normalizeHeader,
  parseCsv,
  parseIsoDateUtc,
  type EcbSeriesDefinition,
  type MacroFetchResult,
  type MacroHttpClient,
  type MacroObservationValue,
} from './macro-config';

export const ECB_ENDPOINT = '/service/data/EXR/D.USD.EUR.SP00.A';

export interface EcbRate {
  refDate: Date;
  value: string;
}

export interface EcbParseResult {
  rates: EcbRate[];
  warnings: string[];
}

export function ecbCsvUrl(startDate: Date): string {
  return (
    `${MACRO_SOURCE_INFO.ecb.baseUrl}${ECB_ENDPOINT}` +
    `?startPeriod=${formatIsoDateUtc(startDate)}&format=csvdata`
  );
}

export function parseEcbCsv(csv: string): EcbParseResult {
  const table = parseCsv(csv);

  if (table.length === 0) {
    throw new InvalidPayloadError('BCE: CSV vazio');
  }

  const header = (table[0] ?? []).map(normalizeHeader);
  const dateIndex = header.indexOf('TIME_PERIOD');
  const valueIndex = header.indexOf('OBS_VALUE');

  if (dateIndex < 0 || valueIndex < 0) {
    throw new InvalidPayloadError('BCE: colunas TIME_PERIOD/OBS_VALUE ausentes');
  }

  const rates: EcbRate[] = [];
  const warnings: string[] = [];

  for (const cells of table.slice(1)) {
    const dateRaw = cells[dateIndex]?.trim() ?? '';
    const refDate = parseIsoDateUtc(dateRaw);

    if (refDate === null) {
      warnings.push(`BCE: TIME_PERIOD inválido ${dateRaw || '(vazio)'}`);
      continue;
    }

    const raw = cells[valueIndex]?.trim() ?? '';

    if (isMissingMacroValue(raw)) {
      warnings.push(`BCE: ${dateRaw} OBS_VALUE vazio/N/A`);
      continue;
    }

    const value = decimalString(raw);

    if (value === null) {
      warnings.push(`BCE: ${dateRaw} OBS_VALUE inválido (${raw})`);
      continue;
    }

    rates.push({ refDate, value });
  }

  return { rates, warnings };
}

export async function fetchEcbObservations(
  http: MacroHttpClient,
  series: readonly EcbSeriesDefinition[],
  startDate: Date,
  endDate: Date
): Promise<MacroFetchResult> {
  if (series.length === 0) {
    return { observations: [], warnings: [] };
  }

  const csv = await http.getText(ecbCsvUrl(startDate), 'text/csv,*/*');
  const parsed = parseEcbCsv(csv);
  const observations: MacroObservationValue[] = [];

  for (const definition of series) {
    for (const rate of parsed.rates) {
      if (rate.refDate < startDate || rate.refDate > endDate) {
        continue;
      }

      observations.push({
        seriesId: definition.seriesId,
        source: 'ecb',
        unit: definition.unit,
        refDate: rate.refDate,
        value: rate.value,
        revisionIndicator: null,
      });
    }
  }

  return { observations, warnings: parsed.warnings };
}
