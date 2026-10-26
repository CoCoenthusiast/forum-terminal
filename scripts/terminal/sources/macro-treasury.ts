import {
  MACRO_SOURCE_INFO,
  InvalidPayloadError,
  decimalString,
  formatIsoDateUtc,
  isMissingMacroValue,
  normalizeHeader,
  parseCsv,
  parseUsDateUtc,
  yearsBetween,
  type MacroFetchResult,
  type MacroHttpClient,
  type MacroObservationValue,
  type TreasuryCurve,
  type TreasurySeriesDefinition,
} from './macro-config';

export const TREASURY_ENDPOINT =
  '/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv';
export const TREASURY_NOMINAL_TYPE = 'daily_treasury_yield_curve';
export const TREASURY_REAL_TYPE = 'daily_treasury_real_yield_curve';

export interface TreasuryRow {
  refDate: Date;
  values: Map<string, string>;
}

export interface TreasuryParseResult {
  rows: TreasuryRow[];
  warnings: string[];
}

function curveCsvType(curve: TreasuryCurve): string {
  return curve === 'nominal' ? TREASURY_NOMINAL_TYPE : TREASURY_REAL_TYPE;
}

export function treasuryCsvUrl(year: number, curve: TreasuryCurve): string {
  const type = curveCsvType(curve);

  return (
    `${MACRO_SOURCE_INFO.treasury.baseUrl}${TREASURY_ENDPOINT}/${year}/all` +
    `?type=${type}&field_tdr_date_value=${year}&page&_format=csv`
  );
}

export function parseTreasuryCsv(csv: string, columns: readonly string[]): TreasuryParseResult {
  const table = parseCsv(csv);

  if (table.length === 0) {
    throw new InvalidPayloadError('Tesouro: CSV vazio');
  }

  const header = (table[0] ?? []).map(normalizeHeader);
  const dateIndex = header.indexOf('Date');

  if (dateIndex < 0) {
    throw new InvalidPayloadError('Tesouro: coluna Date ausente');
  }

  const columnIndexes = new Map<string, number>();

  for (const column of columns) {
    const index = header.indexOf(column);

    if (index < 0) {
      throw new InvalidPayloadError(`Tesouro: coluna ${column} ausente no cabeçalho`);
    }

    columnIndexes.set(column, index);
  }

  const rows: TreasuryRow[] = [];
  const warnings: string[] = [];

  for (const cells of table.slice(1)) {
    const dateRaw = cells[dateIndex]?.trim() ?? '';
    const refDate = parseUsDateUtc(dateRaw);

    if (refDate === null) {
      warnings.push(`Tesouro: data inválida ${dateRaw || '(vazia)'}`);
      continue;
    }

    const values = new Map<string, string>();

    for (const column of columns) {
      const raw = cells[columnIndexes.get(column) ?? -1]?.trim() ?? '';

      if (isMissingMacroValue(raw)) {
        warnings.push(`Tesouro: ${formatIsoDateUtc(refDate)} ${column} vazio/N/A`);
        continue;
      }

      const value = decimalString(raw);

      if (value === null) {
        warnings.push(`Tesouro: ${formatIsoDateUtc(refDate)} ${column} inválido (${raw})`);
        continue;
      }

      values.set(column, value);
    }

    if (values.size > 0) {
      rows.push({ refDate, values });
    }
  }

  return { rows, warnings };
}

export async function fetchTreasuryObservations(
  http: MacroHttpClient,
  series: readonly TreasurySeriesDefinition[],
  startDate: Date,
  endDate: Date
): Promise<MacroFetchResult> {
  const byCurve = new Map<TreasuryCurve, TreasurySeriesDefinition[]>();

  for (const definition of series) {
    const definitions = byCurve.get(definition.curve) ?? [];
    definitions.push(definition);
    byCurve.set(definition.curve, definitions);
  }

  const observations: MacroObservationValue[] = [];
  const warnings: string[] = [];

  for (const [curve, definitions] of byCurve) {
    const columns = [...new Set(definitions.map((definition) => definition.column))];

    for (const year of yearsBetween(startDate, endDate)) {
      const csv = await http.getText(treasuryCsvUrl(year, curve), 'text/csv,*/*');
      const parsed = parseTreasuryCsv(csv, columns);
      warnings.push(...parsed.warnings);

      for (const row of parsed.rows) {
        if (row.refDate < startDate || row.refDate > endDate) {
          continue;
        }

        for (const definition of definitions) {
          const value = row.values.get(definition.column);

          if (value === undefined) {
            continue;
          }

          observations.push({
            seriesId: definition.seriesId,
            source: 'treasury',
            unit: definition.unit,
            refDate: row.refDate,
            value,
            revisionIndicator: null,
          });
        }
      }
    }
  }

  return { observations, warnings };
}
