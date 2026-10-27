import {
  MACRO_SOURCE_INFO,
  InvalidPayloadError,
  decimalString,
  type BlsSeriesDefinition,
  type MacroFetchResult,
  type MacroHttpClient,
  type MacroObservationValue,
} from './macro-config';

export const BLS_ENDPOINT = '/publicAPI/v2/timeseries/data/';

export interface BlsRequest {
  seriesid: string[];
  startyear: string;
  endyear: string;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseMessage(record: Record<string, unknown>): string {
  if (Array.isArray(record.message)) {
    return record.message.map((value) => String(value)).join(' ');
  }

  return typeof record.message === 'string' ? record.message : '';
}

export function blsApiUrl(): string {
  return `${MACRO_SOURCE_INFO.bls.baseUrl}${BLS_ENDPOINT}`;
}

export function parseBlsPayload(
  payload: unknown,
  series: readonly BlsSeriesDefinition[]
): MacroFetchResult {
  const record = readRecord(payload);

  if (record === null) {
    throw new InvalidPayloadError('BLS: resposta não é um objeto JSON');
  }

  const status = typeof record.status === 'string' ? record.status : '';

  if (status !== 'REQUEST_SUCCEEDED') {
    const message = responseMessage(record);
    throw new InvalidPayloadError(
      `BLS: status ${status || 'ausente'}${message === '' ? '' : `: ${message}`}`
    );
  }

  const results = readRecord(record.Results);
  const apiSeries = results?.series;

  if (!Array.isArray(apiSeries)) {
    throw new InvalidPayloadError('BLS: Results.series ausente');
  }

  const byId = new Map<string, unknown[]>();

  for (const entry of apiSeries) {
    const item = readRecord(entry);
    const seriesID = typeof item?.seriesID === 'string' ? item.seriesID : '';
    const data = item?.data;

    if (seriesID !== '' && Array.isArray(data)) {
      byId.set(seriesID, data);
    }
  }

  const observations: MacroObservationValue[] = [];
  const warnings: string[] = [];

  for (const definition of series) {
    const data = byId.get(definition.apiSeriesId);

    if (data === undefined) {
      warnings.push(`${definition.seriesId}: série ${definition.apiSeriesId} ausente`);
      continue;
    }

    for (const entry of data) {
      const item = readRecord(entry);
      const year = typeof item?.year === 'string' ? item.year.trim() : '';
      const period = typeof item?.period === 'string' ? item.period.trim() : '';

      if (period === 'M13') {
        continue;
      }

      if (!/^\d{4}$/.test(year) || !/^M(0[1-9]|1[0-2])$/.test(period)) {
        warnings.push(
          `${definition.seriesId}: referência inválida ${year || '(ano vazio)'}-${period || '(período vazio)'}`
        );
        continue;
      }

      const refDate = new Date(
        Date.UTC(Number(year), Number(period.slice(1)) - 1, 1)
      );
      const raw = item?.value;

      if (
        raw === null ||
        raw === undefined ||
        (typeof raw === 'string' && (raw.trim() === '' || raw.trim() === '-'))
      ) {
        warnings.push(`${definition.seriesId}: ${year}-${period} valor ausente`);
        continue;
      }

      const value = decimalString(raw);

      if (value === null) {
        warnings.push(
          `${definition.seriesId}: ${year}-${period} valor inválido (${String(raw)})`
        );
        continue;
      }

      observations.push({
        seriesId: definition.seriesId,
        source: 'bls',
        unit: definition.unit,
        refDate,
        value,
        status: 'ok',
        revisionIndicator: null,
      });
    }
  }

  return { observations, warnings };
}

export async function fetchBlsObservations(
  http: MacroHttpClient,
  series: readonly BlsSeriesDefinition[],
  startDate: Date,
  endDate: Date,
  isBackfill: boolean
): Promise<MacroFetchResult> {
  if (series.length === 0) {
    return { observations: [], warnings: [] };
  }

  const startYear = isBackfill
    ? startDate.getUTCFullYear()
    : endDate.getUTCFullYear() - 1;
  const endYear = endDate.getUTCFullYear();
  const body: BlsRequest = {
    seriesid: series.map((definition) => definition.apiSeriesId),
    startyear: String(startYear),
    endyear: String(endYear),
  };
  const payload = await http.postJson(blsApiUrl(), body);
  const parsed = parseBlsPayload(payload, series);

  if (!isBackfill) {
    return parsed;
  }

  return {
    observations: parsed.observations.filter(
      (observation) =>
        observation.refDate >= startDate && observation.refDate <= endDate
    ),
    warnings: parsed.warnings,
  };
}
