import type { PrismaClient } from '../generated/db/client';
import { deriveRegime } from '../state/regime';
import type { MarketState } from '../state/market-state';
import {
  HORIZONS,
  assignGroup,
  compareToBaseline,
  forwardReturns,
  groupByLabel,
  judgeGroup,
  lagSeries,
  quartileCuts,
  splitHalves,
  summarizeGroup,
  type ClosePoint,
  type ForwardReturnRow,
  type GroupSummary,
  type GroupVerdict,
  type QuartileCuts,
} from './phase11-stats';

export const PHASE11_REPORT_TITLE =
  'Indício não é prova. Janela de 12 meses, um único regime de mercado. Resultados exploratórios.';

export const PHASE11_WINDOW_DAYS = 365;
export const PHASE11_ASSET = 'solana';
export const PHASE11_PRICE_PROVIDER = 'coingecko_history';
export const PHASE11_STATE_VERSION = 'sol_state_v2';
export const PHASE11_RULES_VERSION = 'state_rules_v2';

const DAY_MS = 24 * 60 * 60 * 1000;

export const PHASE11_INDICATORS = {
  oi: {
    scope: 'coinalyze:SOL',
    indicator: 'oi_usd_change_7d_pct',
    formulaVersion: 'coinalyze_leverage_v1',
  },
  funding: {
    scope: 'coinalyze:SOL',
    indicator: 'funding_7d_mean',
    formulaVersion: 'coinalyze_leverage_v1',
  },
  liqTotal: {
    scope: 'coinalyze:SOL',
    indicator: 'liq_total_vs_mean7d_pct',
    formulaVersion: 'coinalyze_leverage_v1',
  },
  liqLong: {
    scope: 'coinalyze:SOL',
    indicator: 'liq_long_share_pct',
    formulaVersion: 'coinalyze_leverage_v1',
  },
  dollar: {
    scope: 'macro:us',
    indicator: 'macro_dollar_broad_change_5d_pct',
    formulaVersion: 'macro_v1',
  },
  realYield: {
    scope: 'macro:us',
    indicator: 'macro_real_yield_10y_change_5d',
    formulaVersion: 'macro_v1',
  },
  dex: {
    scope: 'solana',
    indicator: 'dex_volume_vs_mean_7d',
    formulaVersion: 'v1',
  },
} as const;

export type IndicatorKey = keyof typeof PHASE11_INDICATORS;
export type QuestionId = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6';

export interface QuestionRule {
  title: string;
  stateDimension: 'regime' | null;
  signalLagDays: number;
  returnStartOffsetDays: number;
  indicators: readonly IndicatorKey[];
}

// Regra anti-viés, uma única fonte por pergunta:
// - Q1 usa o regime do próprio dia D e o retorno começa no fechamento de D.
// - Q2..Q5 usam sinal de D, conhecido só depois do fechamento, e o retorno começa em D+1.
// - Q6 usa o DEX visível com atraso de 2 dias (lagSeries) e o retorno começa em D.
export const PHASE11_QUESTION_RULES = {
  Q1: {
    title: 'Q1 — os 9 regimes',
    stateDimension: 'regime',
    signalLagDays: 0,
    returnStartOffsetDays: 0,
    indicators: [],
  },
  Q2: {
    title: 'Q2 — oi_usd_change_7d_pct em low/mid/high',
    stateDimension: null,
    signalLagDays: 0,
    returnStartOffsetDays: 1,
    indicators: ['oi'],
  },
  Q3: {
    title: 'Q3 — funding_7d_mean em low/mid/high',
    stateDimension: null,
    signalLagDays: 0,
    returnStartOffsetDays: 1,
    indicators: ['funding'],
  },
  Q4: {
    title: 'Q4 — pico de liquidações por participação de longs',
    stateDimension: null,
    signalLagDays: 0,
    returnStartOffsetDays: 1,
    indicators: ['liqTotal', 'liqLong'],
  },
  Q5: {
    title: 'Q5 — dólar e juros reais',
    stateDimension: null,
    signalLagDays: 0,
    returnStartOffsetDays: 1,
    indicators: ['dollar', 'realYield'],
  },
  Q6: {
    title: 'Q6 — fim de semana contra dia útil e nível DEX',
    stateDimension: null,
    signalLagDays: 2,
    returnStartOffsetDays: 0,
    indicators: ['dex'],
  },
} as const satisfies Record<QuestionId, QuestionRule>;

export const PHASE11_REGIMES = [
  'trend_up_confirmed',
  'trend_up_unconfirmed',
  'range_neutral',
  'trend_down_unconfirmed',
  'trend_down_confirmed',
  'weak_without_trend',
  'strong_without_trend',
  'conflicting',
  'insufficient_data',
] as const;

export const PHASE11_WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export interface PriceReadRow {
  collectedAt: Date;
  priceUsd: unknown;
}

export interface MarketStateReadRow {
  asOf: Date;
  computeMode: string;
  dataQualityScore: unknown;
  payload: unknown;
}

export interface IndicatorReadRow {
  asOf: Date;
  indicator: string;
  scope: string;
  status: string;
  value: unknown;
  formulaVersion: string;
}

export interface Phase11State {
  date: string;
  computeMode: string;
  dataQualityScore: number | null;
  payload: unknown;
  regimeId: string | null;
}

export type IndicatorValues = Record<string, Record<string, number>>;

export interface Phase11Data {
  from: string;
  to: string;
  closes: ClosePoint[];
  states: Phase11State[];
  allStates: Phase11State[];
  indicators: IndicatorValues;
  queries: number;
}

export interface Phase11ReadOptions {
  to?: string;
  days?: number;
}

export interface DatedValue {
  date: string;
  value: number | null;
}

export interface QuestionCandidate {
  date: string;
  state: Phase11State;
  labels: string[];
  values: Record<string, number | null>;
}

export interface PreparedQuestion {
  id: QuestionId;
  rule: QuestionRule;
  excluded: number;
  candidates: QuestionCandidate[];
  groups: string[];
  cuts: Record<string, QuartileCuts | null>;
  note: string | null;
}

export interface GroupHorizonResult {
  group: string;
  first: GroupSummary;
  firstDifference: number | null;
  second: GroupSummary;
  secondDifference: number | null;
  verdict: GroupVerdict;
}

export interface HorizonResult {
  horizon: number;
  groups: GroupHorizonResult[];
  firstBaseline: GroupSummary;
  secondBaseline: GroupSummary;
}

export interface QuestionResult {
  prepared: PreparedQuestion;
  horizons: HorizonResult[];
}

export interface DexLevelRow {
  group: string;
  first: GroupSummary;
  second: GroupSummary;
}

export interface LiveStat {
  question: QuestionId;
  horizon: number | null;
  group: string;
  n: number;
  mean: number | null;
}

export interface Phase11Analysis {
  title: string;
  from: string;
  to: string;
  baseDays: number;
  liveDays: number;
  closeDays: number;
  questions: QuestionResult[];
  dexLevels: DexLevelRow[];
  live: LiveStat[];
}

function parseIsoDateUtc(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return ms;
}

function isoDateUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function shiftIsoDate(value: string, days: number): string | null {
  const ms = parseIsoDateUtc(value);
  if (ms === null) return null;
  return isoDateUtc(ms + days * DAY_MS);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'object') {
    try {
      const parsed = Number(value.toString());
      return Number.isFinite(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function indicatorKey(scope: string, indicator: string): string {
  return `${scope}|${indicator}`;
}

function keyFor(key: IndicatorKey): string {
  const definition = PHASE11_INDICATORS[key];
  return indicatorKey(definition.scope, definition.indicator);
}

export function closesFromPriceRows(rows: readonly PriceReadRow[]): ClosePoint[] {
  const sorted = [...rows].sort(
    (left, right) => left.collectedAt.getTime() - right.collectedAt.getTime()
  );
  const byCloseDate = new Map<string, number>();

  for (const row of sorted) {
    const collectedMs = row.collectedAt.getTime();
    if (!Number.isFinite(collectedMs) || collectedMs % DAY_MS !== 0) continue;

    const price = numberOrNull(row.priceUsd);
    if (price === null || price <= 0) continue;

    byCloseDate.set(isoDateUtc(collectedMs - DAY_MS), price);
  }

  return [...byCloseDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, closeUsd]) => ({ date, closeUsd }));
}

export function regimeFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  if (record === null) return null;

  const regime = asRecord(record.regime);
  if (regime !== null && typeof regime.regimeId === 'string') {
    return regime.regimeId;
  }

  const trend = asRecord(record.sol_trend);
  const strength = asRecord(record.sol_relative_strength);
  if (typeof trend?.classification !== 'string' || typeof strength?.classification !== 'string') {
    return null;
  }

  try {
    return deriveRegime(record as unknown as MarketState).regimeId;
  } catch {
    return null;
  }
}

export function stateFromReadRow(row: MarketStateReadRow): Phase11State {
  return {
    date: isoDateUtc(row.asOf.getTime()),
    computeMode: row.computeMode,
    dataQualityScore: numberOrNull(row.dataQualityScore),
    payload: row.payload,
    regimeId: regimeFromPayload(row.payload),
  };
}

export function normalizeStateRows(rows: readonly MarketStateReadRow[]): Phase11State[] {
  return rows
    .map(stateFromReadRow)
    .sort((left, right) => left.date.localeCompare(right.date));
}

export function preferLiveStates(states: readonly Phase11State[]): Phase11State[] {
  const byDate = new Map<string, Phase11State>();

  for (const state of states) {
    const current = byDate.get(state.date);
    if (current === undefined || (current.computeMode !== 'live' && state.computeMode === 'live')) {
      byDate.set(state.date, state);
    }
  }

  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function indicatorValuesFromRows(rows: readonly IndicatorReadRow[]): IndicatorValues {
  const result: IndicatorValues = {};

  for (const row of rows) {
    if (row.status.trim().toLowerCase() !== 'ok') continue;
    const value = numberOrNull(row.value);
    if (value === null) continue;

    const date = isoDateUtc(row.asOf.getTime());
    const key = indicatorKey(row.scope, row.indicator);
    const day = result[date] ?? {};
    day[key] = value;
    result[date] = day;
  }

  return result;
}

export function phase11DataFromRows(input: {
  from: string;
  to: string;
  priceRows: readonly PriceReadRow[];
  stateRows: readonly MarketStateReadRow[];
  indicatorRows: readonly IndicatorReadRow[];
  closeThrough?: string;
}): Phase11Data {
  const allStates = normalizeStateRows(input.stateRows).filter(
    (state) => state.date >= input.from && state.date <= input.to
  );
  const closeThrough = input.closeThrough ?? input.to;
  const closes = closesFromPriceRows(input.priceRows).filter(
    (point) => point.date >= input.from && point.date <= closeThrough
  );

  return {
    from: input.from,
    to: input.to,
    closes,
    states: preferLiveStates(allStates),
    allStates,
    indicators: indicatorValuesFromRows(input.indicatorRows),
    queries: 0,
  };
}

export async function loadPhase11Data(
  client: Pick<PrismaClient, 'dataSource' | 'marketSnapshot' | 'marketState' | 'indicatorSnapshot'>,
  options: Phase11ReadOptions = {}
): Promise<Phase11Data> {
  const latest = await client.marketState.findFirst({
    where: {
      stateVersion: PHASE11_STATE_VERSION,
      rulesVersion: PHASE11_RULES_VERSION,
    },
    orderBy: { asOf: 'desc' },
    select: { asOf: true },
  });

  if (latest === null) {
    throw new Error(
      `nenhum MarketState ${PHASE11_STATE_VERSION}/${PHASE11_RULES_VERSION}`
    );
  }

  const to = options.to ?? isoDateUtc(latest.asOf.getTime());
  const toMs = parseIsoDateUtc(to);
  if (toMs === null) throw new Error(`data final inválida: ${to}`);

  const days = options.days ?? PHASE11_WINDOW_DAYS;
  if (!Number.isInteger(days) || days <= 0) throw new Error(`janela inválida: ${days}`);

  const from = isoDateUtc(toMs - (days - 1) * DAY_MS);
  const fromMs = parseIsoDateUtc(from);
  if (fromMs === null) throw new Error(`data inicial inválida: ${from}`);

  const rules = Object.values(PHASE11_QUESTION_RULES);
  const signalLookbackDays = Math.max(...rules.map((rule) => rule.signalLagDays));
  const returnStartDays = Math.max(...rules.map((rule) => rule.returnStartOffsetDays));
  const returnBufferDays = returnStartDays + Math.max(...HORIZONS);
  const closeThrough = isoDateUtc(toMs + returnBufferDays * DAY_MS);

  const source = await client.dataSource.findUnique({
    where: { provider: PHASE11_PRICE_PROVIDER },
    select: { id: true },
  });

  if (source === null) {
    throw new Error(`DataSource ${PHASE11_PRICE_PROVIDER} ausente`);
  }

  const priceRows = await client.marketSnapshot.findMany({
    where: {
      sourceId: source.id,
      asset: PHASE11_ASSET,
      collectedAt: {
        gte: new Date(fromMs + DAY_MS),
        lte: new Date(toMs + (returnBufferDays + 1) * DAY_MS),
      },
    },
    select: { collectedAt: true, priceUsd: true },
    orderBy: { collectedAt: 'asc' },
  });

  const stateRows = await client.marketState.findMany({
    where: {
      stateVersion: PHASE11_STATE_VERSION,
      rulesVersion: PHASE11_RULES_VERSION,
      asOf: { gte: new Date(fromMs), lte: new Date(toMs) },
    },
    select: {
      asOf: true,
      computeMode: true,
      dataQualityScore: true,
      payload: true,
    },
    orderBy: { asOf: 'asc' },
  });

  const definitions = Object.values(PHASE11_INDICATORS);
  const indicatorRows = await client.indicatorSnapshot.findMany({
    where: {
      status: 'ok',
      asOf: {
        gte: new Date(fromMs - signalLookbackDays * DAY_MS),
        lte: new Date(toMs),
      },
      OR: definitions.map((definition) => ({
        scope: definition.scope,
        indicator: definition.indicator,
        formulaVersion: definition.formulaVersion,
      })),
    },
    select: {
      asOf: true,
      indicator: true,
      scope: true,
      status: true,
      value: true,
      formulaVersion: true,
    },
    orderBy: [{ asOf: 'asc' }, { scope: 'asc' }, { indicator: 'asc' }],
  });

  return {
    ...phase11DataFromRows({
      from,
      to,
      closeThrough,
      priceRows,
      stateRows,
      indicatorRows,
    }),
    queries: 4,
  };
}

function isInsufficientClassification(value: unknown): boolean {
  return value === 'insufficient_data' || value === 'unavailable';
}

export function stateDimensionInsufficient(
  state: Phase11State,
  dimension: QuestionRule['stateDimension']
): boolean {
  if (dimension === null) return false;
  if (dimension === 'regime') {
    return state.regimeId === null || state.regimeId === 'insufficient_data';
  }

  const record = asRecord(state.payload);
  const field = asRecord(record?.[dimension]);
  return field === null || isInsufficientClassification(field.classification);
}

function weekdayName(date: string): string | null {
  const ms = parseIsoDateUtc(date);
  if (ms === null) return null;
  return PHASE11_WEEKDAYS[new Date(ms).getUTCDay()] ?? null;
}

function indicatorSeries(
  data: Phase11Data,
  key: IndicatorKey,
  delayDays: number
): Record<string, number | null> {
  const target = keyFor(key);
  const dates = new Set<string>([
    ...data.states.map((state) => state.date),
    ...Object.keys(data.indicators),
  ]);
  const raw: Record<string, number | null> = {};

  for (const date of dates) {
    raw[date] = data.indicators[date]?.[target] ?? null;
  }

  if (delayDays === 0) return raw;
  return lagSeries(raw, delayDays);
}

export function applySignalLag(
  valuesByDate: Readonly<Record<string, number | null | undefined>>,
  rule: Pick<QuestionRule, 'signalLagDays'>
): Record<string, number | null> {
  if (rule.signalLagDays === 0) {
    const direct: Record<string, number | null> = {};
    for (const [date, value] of Object.entries(valuesByDate)) {
      direct[date] = numberOrNull(value);
    }
    return direct;
  }
  return lagSeries(valuesByDate, rule.signalLagDays);
}

export function returnStartDate(
  signalDate: string,
  rule: Pick<QuestionRule, 'returnStartOffsetDays'>
): string | null {
  return shiftIsoDate(signalDate, rule.returnStartOffsetDays);
}

export function returnRowForSignalDate(
  returnsByDate: ReadonlyMap<string, ForwardReturnRow>,
  signalDate: string,
  rule: Pick<QuestionRule, 'returnStartOffsetDays'>
): ForwardReturnRow | null {
  const start = returnStartDate(signalDate, rule);
  return start === null ? null : (returnsByDate.get(start) ?? null);
}

export function cutsFromFirstHalf(
  values: readonly DatedValue[],
  firstHalf: readonly string[]
): QuartileCuts | null {
  const first = new Set(firstHalf);
  return quartileCuts(
    values.filter((item) => first.has(item.date)).map((item) => item.value)
  );
}

function firstHalfDates(dates: readonly string[]): string[] {
  return splitHalves(dates).firstHalf;
}

function candidateLabels(
  id: QuestionId,
  state: Phase11State,
  values: Record<string, number | null>,
  cuts: Record<string, QuartileCuts | null>
): string[] {
  if (id === 'Q1') return state.regimeId === null ? [] : [state.regimeId];

  if (id === 'Q2' || id === 'Q3') {
    const key: IndicatorKey = id === 'Q2' ? 'oi' : 'funding';
    const cut = cuts[key] ?? null;
    const value = values[key] ?? null;
    const group = assignGroup(value, cut);
    return group === null ? [] : [group];
  }

  if (id === 'Q4') {
    const total = values.liqTotal ?? null;
    const share = values.liqLong ?? null;
    const totalCut = cuts.liqTotal ?? null;
    const shareCut = cuts.liqLong ?? null;
    if (total === null || share === null || totalCut === null || shareCut === null) return [];

    if (assignGroup(total, totalCut) !== 'high') return ['sem_pico'];
    const shareGroup = assignGroup(share, shareCut);
    if (shareGroup === 'high') return ['pico_longs_liquidados'];
    if (shareGroup === 'low') return ['pico_shorts_liquidados'];
    return ['pico_share_meio'];
  }

  if (id === 'Q5') {
    const dollar = values.dollar ?? null;
    const realYield = values.realYield ?? null;
    const dollarCut = cuts.dollar ?? null;
    const realYieldCut = cuts.realYield ?? null;
    if (
      dollar === null ||
      realYield === null ||
      dollarCut === null ||
      realYieldCut === null
    ) {
      return [];
    }

    const dollarGroup = assignGroup(dollar, dollarCut);
    const realYieldGroup = assignGroup(realYield, realYieldCut);
    if (dollarGroup === 'high' && realYieldGroup === 'high') return ['both_high'];
    if (dollarGroup === 'low' && realYieldGroup === 'low') return ['both_low'];
    return ['other'];
  }

  const day = weekdayName(state.date);
  if (day === null) return [];
  return [day === 'saturday' || day === 'sunday' ? 'weekend' : 'weekday', day];
}

function groupsFor(id: QuestionId): string[] {
  if (id === 'Q1') return [...PHASE11_REGIMES];
  if (id === 'Q2' || id === 'Q3') return ['low', 'mid', 'high'];
  if (id === 'Q4') {
    return [
      'pico_longs_liquidados',
      'pico_shorts_liquidados',
      'pico_share_meio',
      'sem_pico',
    ];
  }
  if (id === 'Q5') return ['both_high', 'both_low', 'other'];
  return ['weekend', 'weekday', ...PHASE11_WEEKDAYS];
}

export function prepareQuestion(data: Phase11Data, id: QuestionId): PreparedQuestion {
  const rule = PHASE11_QUESTION_RULES[id];
  const series = new Map<IndicatorKey, Record<string, number | null>>();

  for (const key of rule.indicators) {
    series.set(key, indicatorSeries(data, key, rule.signalLagDays));
  }

  const candidatesWithoutLabels: QuestionCandidate[] = [];

  for (const state of data.states) {
    if (stateDimensionInsufficient(state, rule.stateDimension)) continue;

    const values: Record<string, number | null> = {};
    let usable = true;

    for (const key of rule.indicators) {
      const value = series.get(key)?.[state.date] ?? null;
      values[key] = value;
      if (value === null) usable = false;
    }

    if (!usable) continue;
    candidatesWithoutLabels.push({ date: state.date, state, labels: [], values });
  }

  const firstHalf = firstHalfDates(data.states.map((state) => state.date));
  const cuts: Record<string, QuartileCuts | null> = {};

  if (id === 'Q2' || id === 'Q3') {
    const key: IndicatorKey = id === 'Q2' ? 'oi' : 'funding';
    cuts[key] = cutsFromFirstHalf(
      candidatesWithoutLabels.map((candidate) => ({
        date: candidate.date,
        value: candidate.values[key] ?? null,
      })),
      firstHalf
    );
  } else if (id === 'Q4') {
    cuts.liqTotal = cutsFromFirstHalf(
      candidatesWithoutLabels.map((candidate) => ({
        date: candidate.date,
        value: candidate.values.liqTotal ?? null,
      })),
      firstHalf
    );
    cuts.liqLong = cutsFromFirstHalf(
      candidatesWithoutLabels.map((candidate) => ({
        date: candidate.date,
        value: candidate.values.liqLong ?? null,
      })),
      firstHalf
    );
  } else if (id === 'Q5') {
    cuts.dollar = cutsFromFirstHalf(
      candidatesWithoutLabels.map((candidate) => ({
        date: candidate.date,
        value: candidate.values.dollar ?? null,
      })),
      firstHalf
    );
    cuts.realYield = cutsFromFirstHalf(
      candidatesWithoutLabels.map((candidate) => ({
        date: candidate.date,
        value: candidate.values.realYield ?? null,
      })),
      firstHalf
    );
  }

  const candidates = candidatesWithoutLabels
    .map((candidate) => ({
      ...candidate,
      labels: candidateLabels(id, candidate.state, candidate.values, cuts),
    }))
    .filter((candidate) => candidate.labels.length > 0);

  const needsCuts = id === 'Q2' || id === 'Q3' || id === 'Q4' || id === 'Q5';
  const cutsReady = !needsCuts || Object.values(cuts).every((cut) => cut !== null);
  const groups = cutsReady ? groupsFor(id) : [];
  const excluded = data.states.length - candidatesWithoutLabels.length;

  return {
    id,
    rule,
    excluded,
    candidates,
    groups,
    cuts,
    note: cutsReady ? null : 'sem MIN_GROUP_DAYS na primeira metade para os cortes de quartil',
  };
}

interface AlignedCandidate {
  candidate: QuestionCandidate;
  startsAt: string | null;
  row: ForwardReturnRow | null;
}

function alignCandidates(
  candidates: readonly QuestionCandidate[],
  returnsByDate: ReadonlyMap<string, ForwardReturnRow>,
  rule: QuestionRule
): AlignedCandidate[] {
  return candidates.map((candidate) => {
    const startsAt = returnStartDate(candidate.date, rule);
    return {
      candidate,
      startsAt,
      row: startsAt === null ? null : (returnsByDate.get(startsAt) ?? null),
    };
  });
}

function summaryFor(rows: readonly AlignedCandidate[], horizon: number): GroupSummary {
  return summarizeGroup(
    rows.map((row) => row.row).filter((row): row is ForwardReturnRow => row !== null),
    horizon
  );
}

function groupRows(aligned: readonly AlignedCandidate[], group: string): AlignedCandidate[] {
  return aligned.filter((row) => row.candidate.labels.includes(group));
}

function horizonResult(
  prepared: PreparedQuestion,
  aligned: readonly AlignedCandidate[],
  firstDates: ReadonlySet<string>,
  secondDates: ReadonlySet<string>,
  horizon: number
): HorizonResult {
  const firstRows = aligned.filter((row) => firstDates.has(row.candidate.date));
  const secondRows = aligned.filter((row) => secondDates.has(row.candidate.date));
  const firstBaseline = summaryFor(firstRows, horizon);
  const secondBaseline = summaryFor(secondRows, horizon);

  const groups = prepared.groups.map((group) => {
    const first = summaryFor(
      groupRows(firstRows, group),
      horizon
    );
    const second = summaryFor(
      groupRows(secondRows, group),
      horizon
    );
    const firstDifference = compareToBaseline(first, firstBaseline);
    const secondDifference = compareToBaseline(second, secondBaseline);

    return {
      group,
      first,
      firstDifference,
      second,
      secondDifference,
      verdict: judgeGroup(
        { n: first.n, difference: firstDifference },
        { n: second.n, difference: secondDifference }
      ),
    };
  });

  return { horizon, groups, firstBaseline, secondBaseline };
}

function dexLevels(
  prepared: PreparedQuestion,
  firstDates: ReadonlySet<string>,
  secondDates: ReadonlySet<string>
): DexLevelRow[] {
  return prepared.groups.map((group) => {
    const rows = prepared.candidates.filter((candidate) => candidate.labels.includes(group));
    const asReturn = (candidate: QuestionCandidate): ForwardReturnRow => ({
      date: candidate.date,
      returns: { 1: candidate.values.dex ?? null },
    });
    return {
      group,
      first: summarizeGroup(
        rows.filter((candidate) => firstDates.has(candidate.date)).map(asReturn),
        1
      ),
      second: summarizeGroup(
        rows.filter((candidate) => secondDates.has(candidate.date)).map(asReturn),
        1
      ),
    };
  });
}

function liveStats(
  prepared: PreparedQuestion,
  aligned: readonly AlignedCandidate[]
): LiveStat[] {
  const result: LiveStat[] = [];
  const live = aligned.filter((row) => row.candidate.state.computeMode === 'live');

  for (const horizon of HORIZONS) {
    for (const group of prepared.groups) {
      const summary = summaryFor(groupRows(live, group), horizon);
      if (summary.n > 0) {
        result.push({
          question: prepared.id,
          horizon,
          group,
          n: summary.n,
          mean: summary.mean,
        });
      }
    }
  }

  return result;
}

export function buildPhase11Analysis(data: Phase11Data): Phase11Analysis {
  const prepared = (Object.keys(PHASE11_QUESTION_RULES) as QuestionId[]).map((id) =>
    prepareQuestion(data, id)
  );
  const returns = forwardReturns(data.closes, HORIZONS);
  const returnsByDate = new Map(returns.map((row) => [row.date, row]));
  const halves = splitHalves(data.states.map((state) => state.date));
  const firstDates = new Set([...halves.firstHalf]);
  const secondDates = new Set([...halves.secondHalf]);

  const questions: QuestionResult[] = [];
  const live: LiveStat[] = [];

  for (const item of prepared) {
    const aligned = alignCandidates(item.candidates, returnsByDate, item.rule);
    questions.push({
      prepared: item,
      horizons: HORIZONS.map((horizon) =>
        horizonResult(item, aligned, firstDates, secondDates, horizon)
      ),
    });
    live.push(...liveStats(item, aligned));
  }

  const q6 = prepared.find((item) => item.id === 'Q6');
  const levels = q6 === undefined ? [] : dexLevels(q6, firstDates, secondDates);

  return {
    title: PHASE11_REPORT_TITLE,
    from: data.from,
    to: data.to,
    baseDays: data.states.length,
    liveDays: data.states.filter((state) => state.computeMode === 'live').length,
    closeDays: data.closes.length,
    questions,
    dexLevels: levels,
    live,
  };
}

export function regimeGroups(
  candidates: readonly QuestionCandidate[]
): Record<string, QuestionCandidate[]> {
  return groupByLabel(candidates, (candidate) => candidate.labels[0] ?? null);
}
