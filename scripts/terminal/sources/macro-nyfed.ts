import {
  MACRO_SOURCE_INFO,
  InvalidPayloadError,
  decimalString,
  formatIsoDateUtc,
  parseIsoDateUtc,
  type MacroFetchResult,
  type MacroHttpClient,
  type MacroObservationValue,
  type NyfedRateType,
  type NyfedSeriesDefinition,
} from './macro-config';

export const NYFED_ENDPOINT = '/api/rates';
export const NYFED_REQUEST_TIMEOUT_MS = 15_000;

export interface NyfedRate {
  refDate: Date;
  value: string;
  revisionIndicator: string | null;
}

export interface NyfedParseResult {
  rates: NyfedRate[];
  warnings: string[];
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nyfedPath(rateType: NyfedRateType): string {
  return rateType === 'sofr' ? 'secured/sofr' : 'unsecured/effr';
}

export function nyfedRatesUrl(
  rateType: NyfedRateType,
  startDate: Date,
  endDate: Date
): string {
  return (
    `${MACRO_SOURCE_INFO.nyfed.baseUrl}${NYFED_ENDPOINT}/${nyfedPath(rateType)}/search.json` +
    `?startDate=${formatIsoDateUtc(startDate)}&endDate=${formatIsoDateUtc(endDate)}&type=rate`
  );
}

export function parseNyfedPayload(
  payload: unknown,
  expectedType?: string
): NyfedParseResult {
  const record = readRecord(payload);
  const refRates = record?.refRates;

  if (!Array.isArray(refRates)) {
    throw new InvalidPayloadError('NY Fed: refRates ausente');
  }

  const rates: NyfedRate[] = [];
  const warnings: string[] = [];

  for (const entry of refRates) {
    const item = readRecord(entry);

    if (item === null) {
      warnings.push('NY Fed: entrada inválida em refRates');
      continue;
    }

    const dateRaw = typeof item.effectiveDate === 'string' ? item.effectiveDate : '';
    const refDate = parseIsoDateUtc(dateRaw);

    if (refDate === null) {
      warnings.push(`NY Fed: effectiveDate inválida ${dateRaw || '(vazia)'}`);
      continue;
    }

    if (
      expectedType !== undefined &&
      typeof item.type === 'string' &&
      item.type.toLowerCase() !== expectedType.toLowerCase()
    ) {
      warnings.push(`NY Fed: tipo inesperado ${item.type} em ${dateRaw}`);
      continue;
    }

    const value = decimalString(item.percentRate);

    if (value === null) {
      warnings.push(`NY Fed: percentRate inválido em ${dateRaw}`);
      continue;
    }

    const revisionRaw =
      typeof item.revisionIndicator === 'string' ? item.revisionIndicator.trim() : '';

    rates.push({
      refDate,
      value,
      revisionIndicator: revisionRaw === '' ? null : revisionRaw,
    });
  }

  return { rates, warnings };
}

export async function fetchNyfedObservations(
  http: MacroHttpClient,
  series: readonly NyfedSeriesDefinition[],
  startDate: Date,
  endDate: Date
): Promise<MacroFetchResult> {
  const observations: MacroObservationValue[] = [];
  const warnings: string[] = [];

  for (const definition of series) {
    const payload = await http.getJson(nyfedRatesUrl(definition.rateType, startDate, endDate));
    const parsed = parseNyfedPayload(payload, definition.rateType);
    warnings.push(...parsed.warnings.map((warning) => `${definition.seriesId}: ${warning}`));

    for (const rate of parsed.rates) {
      if (rate.refDate < startDate || rate.refDate > endDate) {
        continue;
      }

      observations.push({
        seriesId: definition.seriesId,
        source: 'nyfed',
        unit: definition.unit,
        refDate: rate.refDate,
        value: rate.value,
        revisionIndicator: rate.revisionIndicator,
      });
    }
  }

  return { observations, warnings };
}
