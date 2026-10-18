import {
  STATE_RULES_VERSION,
  STATE_VERSION,
  STATE_TREND_RETURN7D_BULLISH,
  STATE_TREND_RETURN7D_BEARISH,
  STATE_RS_PAIR_STRONG,
  STATE_RS_PAIR_WEAK,
  STATE_SPOT_DISTANCE_EXPANDING,
  STATE_SPOT_DISTANCE_CONTRACTING,
  STATE_LIQ_VS_MEAN_EXPANDING,
  STATE_LIQ_VS_MEAN_CONTRACTING,
  STATE_LIQ_MIN_SIGNALS,
  STATE_MAX_LEG_LAG_DAYS,
  STATE_MAX_LEG_LAG_DAYS_DEX,
  STATE_DATA_QUALITY_CORE,
  STATE_RULE_DOC,
} from '../config';

// Módulo SOL State: função PURA. Não lê banco, não chama rede, não recalcula
// indicadores e não sabe o que é Prisma. Recebe indicadores já calculados
// (no formato do IndicatorSnapshot) e devolve um estado de mercado explicável,
// versionado e reproduzível. Nada aqui é previsão: é descrição do estado atual.

const DAY_MS = 24 * 60 * 60 * 1000;

export type IndicatorStatus = 'ok' | 'insufficient_history' | 'unavailable';

export interface StateIndicatorInput {
  indicator: string;
  scope: string;
  asOf: string; // 'YYYY-MM-DD'
  status: IndicatorStatus | string;
  value: number | null;
  unit: string;
  from?: string | null;
  to?: string | null;
  reason?: string | null;
}

export interface MarketStateInput {
  // No uso real, asOf é o último dia UTC FECHADO (ontem). Os indicadores costumam
  // ter esse mesmo asOf; o volume DEX pode estar 2 a 4 dias atrás por causa da fonte.
  asOf: string;
  indicators: readonly StateIndicatorInput[];
}

export interface Evidence {
  indicator: string;
  scope: string;
  value: number | null;
  asOf: string;
  status: string;
  role: 'decides' | 'context';
  stale?: boolean;
  legClassification?: string;
}

export type TrendClassification = 'bullish' | 'neutral' | 'bearish' | 'insufficient_data' | 'unavailable';
export type StrengthClassification = 'strong' | 'neutral' | 'weak' | 'insufficient_data' | 'unavailable';
export type FlowClassification = 'expanding' | 'neutral' | 'contracting' | 'insufficient_data' | 'unavailable';

export interface StateField<C extends string> {
  classification: C;
  rule: string;
  ruleDescription: string;
  evidence: Evidence[];
  reason: string | null;
}

export interface DataQuality {
  score: number;
  slotsOk: number;
  slotsTotal: number;
  sourcesUsed: { indicator: string; scope: string; asOf: string; status: string }[];
  missingCore: { indicator: string; scope: string; status: string | null; reason: string | null }[];
  oldestAsOf: string | null;
  referenceAsOf: string;
  unavailableFields: string[];
  insufficientDataFields: string[];
}

export interface RulesApplied {
  field: string;
  ruleId: string;
  description: string;
}

export interface MarketState {
  asOf: string;
  stateVersion: string;
  rulesVersion: string;
  sol_trend: StateField<TrendClassification>;
  sol_relative_strength: StateField<StrengthClassification>;
  spot: StateField<FlowClassification>;
  onchain_liquidity: StateField<FlowClassification>;
  leverage: StateField<'unavailable'>;
  launchpads: StateField<'unavailable'>;
  macro: StateField<'unavailable'>;
  data_quality: DataQuality;
  rulesApplied: RulesApplied[];
  thresholdsUsed: Record<string, number>;
}

function isoDayStart(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function diffDays(laterIso: string, earlierIso: string): number {
  return (isoDayStart(laterIso) - isoDayStart(earlierIso)) / DAY_MS;
}

function isOk(ind: StateIndicatorInput | undefined): ind is StateIndicatorInput & { value: number } {
  return ind !== undefined && ind.status === 'ok' && ind.value !== null && typeof ind.value === 'number' && Number.isFinite(ind.value);
}

function ruleDoc(ruleId: string): string {
  return STATE_RULE_DOC[ruleId] ?? '';
}

// Para cada (indicator, scope), guarda a linha de asOf mais recente. Em empate de
// asOf, prefere ok > insufficient_history > unavailable. É o que o banco "quer dizer"
// quando tem a série inteira; fica aqui para ser testável sem banco.
export function latestByIndicator(rows: readonly StateIndicatorInput[]): Map<string, StateIndicatorInput> {
  const rank: Record<string, number> = { ok: 3, insufficient_history: 2, unavailable: 1 };
  const map = new Map<string, StateIndicatorInput>();
  for (const row of rows) {
    const key = `${row.indicator}|${row.scope}`;
    const current = map.get(key);
    if (current === undefined) {
      map.set(key, row);
      continue;
    }
    if (row.asOf > current.asOf) {
      map.set(key, row);
      continue;
    }
    if (row.asOf === current.asOf && (rank[row.status] ?? 0) > (rank[current.status] ?? 0)) {
      map.set(key, row);
    }
  }
  return map;
}

function maxLagFor(indicator: string): number {
  return indicator.startsWith('dex_volume_vs_mean') ? STATE_MAX_LEG_LAG_DAYS_DEX : STATE_MAX_LEG_LAG_DAYS;
}

interface Usability {
  usable: boolean;
  stale: boolean;
  missing: boolean;
  reason: string | null;
}

function usability(ind: StateIndicatorInput | undefined, referenceAsOf: string): Usability {
  if (ind === undefined) {
    return { usable: false, stale: false, missing: true, reason: 'indicador ausente' };
  }
  if (!isOk(ind)) {
    const reason = ind.reason !== null && ind.reason !== undefined ? ind.reason : `status ${ind.status}`;
    return { usable: false, stale: false, missing: false, reason };
  }
  const lag = diffDays(referenceAsOf, ind.asOf);
  const maxLag = maxLagFor(ind.indicator);
  if (lag > maxLag) {
    return { usable: false, stale: true, missing: false, reason: `dado velho: asOf ${ind.asOf} fica ${lag} dias atrás (limite ${maxLag})` };
  }
  return { usable: true, stale: false, missing: false, reason: null };
}

function evidence(ind: StateIndicatorInput | undefined, role: 'decides' | 'context', stale = false, legClassification?: string): Evidence | null {
  if (ind === undefined) return null;
  return {
    indicator: ind.indicator,
    scope: ind.scope,
    value: ind.value,
    asOf: ind.asOf,
    status: ind.status,
    role,
    stale: stale ? true : undefined,
    legClassification,
  };
}

function collectEvidence(entries: (Evidence | null)[]): Evidence[] {
  return entries.filter((e): e is Evidence => e !== null);
}

function legClassifyVsMean(value: number): 'expanding' | 'neutral' | 'contracting' {
  if (value >= STATE_LIQ_VS_MEAN_EXPANDING) return 'expanding';
  if (value <= STATE_LIQ_VS_MEAN_CONTRACTING) return 'contracting';
  return 'neutral';
}

function legClassifyPair(value: number): 'positive' | 'neutral' | 'negative' {
  if (value >= STATE_RS_PAIR_STRONG) return 'positive';
  if (value <= STATE_RS_PAIR_WEAK) return 'negative';
  return 'neutral';
}

function unavailableField(ruleId: string): StateField<'unavailable'> {
  return {
    classification: 'unavailable',
    rule: ruleId,
    ruleDescription: ruleDoc(ruleId),
    evidence: [],
    reason: 'sem coletor nesta versão',
  };
}

function computeTrend(map: Map<string, StateIndicatorInput>, referenceAsOf: string): StateField<TrendClassification> {
  const ruleId = 'trend_return7d_v1';
  const deciding = map.get('return_7d|solana');
  const context = [
    evidence(map.get('return_30d|solana'), 'context'),
    evidence(map.get('return_1d|solana'), 'context'),
    evidence(map.get('volatility_7d|solana'), 'context'),
  ];
  const usable = usability(deciding, referenceAsOf);
  const ev = collectEvidence([evidence(deciding, 'decides', usable.stale), ...context]);

  if (!usable.usable) {
    return {
      classification: 'insufficient_data',
      rule: ruleId,
      ruleDescription: ruleDoc(ruleId),
      evidence: ev,
      reason: usable.reason,
    };
  }

  const value = deciding!.value as number;
  const classification: TrendClassification = value >= STATE_TREND_RETURN7D_BULLISH ? 'bullish' : value <= STATE_TREND_RETURN7D_BEARISH ? 'bearish' : 'neutral';
  return { classification, rule: ruleId, ruleDescription: ruleDoc(ruleId), evidence: ev, reason: null };
}

function computeRelativeStrength(map: Map<string, StateIndicatorInput>, referenceAsOf: string): StateField<StrengthClassification> {
  const ruleId = 'rs_pair_v1';
  const btc = map.get('relative_strength_7d|solana:bitcoin');
  const eth = map.get('relative_strength_7d|solana:ethereum');
  const btcU = usability(btc, referenceAsOf);
  const ethU = usability(eth, referenceAsOf);

  const btcLeg = btcU.usable ? legClassifyPair(btc!.value as number) : undefined;
  const ethLeg = ethU.usable ? legClassifyPair(eth!.value as number) : undefined;

  const ev = collectEvidence([
    evidence(btc, 'decides', btcU.stale, btcLeg),
    evidence(eth, 'decides', ethU.stale, ethLeg),
    evidence(map.get('relative_strength_30d|solana:bitcoin'), 'context'),
    evidence(map.get('relative_strength_30d|solana:ethereum'), 'context'),
  ]);

  const missing: string[] = [];
  if (!btcU.usable) missing.push(`solana:bitcoin (${btcU.reason})`);
  if (!ethU.usable) missing.push(`solana:ethereum (${ethU.reason})`);

  if (missing.length > 0) {
    return {
      classification: 'insufficient_data',
      rule: ruleId,
      ruleDescription: ruleDoc(ruleId),
      evidence: ev,
      reason: `perna(s) indisponível(is): ${missing.join('; ')}`,
    };
  }

  const classification: StrengthClassification =
    btcLeg === 'positive' && ethLeg === 'positive' ? 'strong'
      : btcLeg === 'negative' && ethLeg === 'negative' ? 'weak'
        : 'neutral';
  return { classification, rule: ruleId, ruleDescription: ruleDoc(ruleId), evidence: ev, reason: null };
}

function computeSpot(map: Map<string, StateIndicatorInput>, referenceAsOf: string): StateField<FlowClassification> {
  const ruleId = 'spot_vsmean7d_v1';
  const deciding = map.get('volume_vs_mean_7d|solana');
  const usable = usability(deciding, referenceAsOf);
  const ev = collectEvidence([
    evidence(deciding, 'decides', usable.stale),
    evidence(map.get('volume_vs_mean_30d|solana'), 'context'),
  ]);

  if (!usable.usable) {
    return { classification: 'insufficient_data', rule: ruleId, ruleDescription: ruleDoc(ruleId), evidence: ev, reason: usable.reason };
  }

  const value = deciding!.value as number;
  const classification: FlowClassification = value >= STATE_SPOT_DISTANCE_EXPANDING ? 'expanding' : value <= STATE_SPOT_DISTANCE_CONTRACTING ? 'contracting' : 'neutral';
  return { classification, rule: ruleId, ruleDescription: ruleDoc(ruleId), evidence: ev, reason: null };
}

function computeOnchainLiquidity(map: Map<string, StateIndicatorInput>, referenceAsOf: string): StateField<FlowClassification> {
  const ruleId = 'liq_vsmean7d_v1';
  const legs: { id: string; label: string; scope: string }[] = [
    { id: 'stablecoin_supply_vs_mean_7d', label: 'stablecoins', scope: 'solana' },
    { id: 'tvl_vs_mean_7d', label: 'tvl', scope: 'solana' },
    { id: 'dex_volume_vs_mean_7d', label: 'dex_volume', scope: 'solana' },
  ];

  const ev: Evidence[] = [];
  let nOk = 0;
  let nExpand = 0;
  let nContract = 0;
  const problems: string[] = [];

  for (const leg of legs) {
    const ind = map.get(`${leg.id}|${leg.scope}`);
    const u = usability(ind, referenceAsOf);
    let legClassification: string | undefined;
    if (u.usable) {
      nOk++;
      legClassification = legClassifyVsMean(ind!.value as number);
      if (legClassification === 'expanding') nExpand++;
      if (legClassification === 'contracting') nContract++;
    } else {
      problems.push(`${leg.label} (${u.reason})`);
    }
    const e = evidence(ind, 'decides', u.stale, legClassification);
    if (e !== null) ev.push(e);
  }

  if (nOk < STATE_LIQ_MIN_SIGNALS) {
    return {
      classification: 'insufficient_data',
      rule: ruleId,
      ruleDescription: ruleDoc(ruleId),
      evidence: ev,
      reason: `sinais insuficientes (${nOk} de ${legs.length}): ${problems.join('; ')}`,
    };
  }

  const classification: FlowClassification =
    nContract === 0 && nExpand >= STATE_LIQ_MIN_SIGNALS ? 'expanding'
      : nExpand === 0 && nContract >= STATE_LIQ_MIN_SIGNALS ? 'contracting'
        : 'neutral';
  return { classification, rule: ruleId, ruleDescription: ruleDoc(ruleId), evidence: ev, reason: null };
}

function computeDataQuality(map: Map<string, StateIndicatorInput>, referenceAsOf: string, fields: Record<string, string>): DataQuality {
  const sourcesUsed: DataQuality['sourcesUsed'] = [];
  const missingCore: DataQuality['missingCore'] = [];
  let slotsOk = 0;
  let oldestAsOfMs: number | null = null;

  for (const slot of STATE_DATA_QUALITY_CORE) {
    const ind = map.get(`${slot.indicator}|${slot.scope}`);
    const u = usability(ind, referenceAsOf);
    if (u.usable && ind !== undefined) {
      slotsOk++;
      sourcesUsed.push({ indicator: ind.indicator, scope: ind.scope, asOf: ind.asOf, status: ind.status });
      const ms = isoDayStart(ind.asOf);
      if (oldestAsOfMs === null || ms < oldestAsOfMs) oldestAsOfMs = ms;
    } else {
      missingCore.push({
        indicator: slot.indicator,
        scope: slot.scope,
        status: ind === undefined ? null : ind.status,
        reason: u.reason,
      });
    }
  }

  const unavailableFields = Object.entries(fields).filter(([, c]) => c === 'unavailable').map(([f]) => f);
  const insufficientDataFields = Object.entries(fields).filter(([, c]) => c === 'insufficient_data').map(([f]) => f);

  return {
    score: slotsOk / STATE_DATA_QUALITY_CORE.length,
    slotsOk,
    slotsTotal: STATE_DATA_QUALITY_CORE.length,
    sourcesUsed,
    missingCore,
    oldestAsOf: oldestAsOfMs === null ? null : new Date(oldestAsOfMs).toISOString().slice(0, 10),
    referenceAsOf,
    unavailableFields,
    insufficientDataFields,
  };
}

export function computeMarketState(input: MarketStateInput): MarketState {
  const map = latestByIndicator(input.indicators);
  const referenceAsOf = input.asOf;

  const sol_trend = computeTrend(map, referenceAsOf);
  const sol_relative_strength = computeRelativeStrength(map, referenceAsOf);
  const spot = computeSpot(map, referenceAsOf);
  const onchain_liquidity = computeOnchainLiquidity(map, referenceAsOf);

  const leverage = unavailableField('no_collector_v1');
  const launchpads = unavailableField('no_collector_v1');
  const macro = unavailableField('no_collector_v1');

  const data_quality = computeDataQuality(map, referenceAsOf, {
    sol_trend: sol_trend.classification,
    sol_relative_strength: sol_relative_strength.classification,
    spot: spot.classification,
    onchain_liquidity: onchain_liquidity.classification,
  });

  const rulesApplied: RulesApplied[] = [
    { field: 'sol_trend', ruleId: sol_trend.rule, description: sol_trend.ruleDescription },
    { field: 'sol_relative_strength', ruleId: sol_relative_strength.rule, description: sol_relative_strength.ruleDescription },
    { field: 'spot', ruleId: spot.rule, description: spot.ruleDescription },
    { field: 'onchain_liquidity', ruleId: onchain_liquidity.rule, description: onchain_liquidity.ruleDescription },
    { field: 'leverage', ruleId: leverage.rule, description: leverage.ruleDescription },
    { field: 'launchpads', ruleId: launchpads.rule, description: launchpads.ruleDescription },
    { field: 'macro', ruleId: macro.rule, description: macro.ruleDescription },
  ];

  const thresholdsUsed: Record<string, number> = {
    trend_return7d_bullish: STATE_TREND_RETURN7D_BULLISH,
    trend_return7d_bearish: STATE_TREND_RETURN7D_BEARISH,
    rs_pair_strong: STATE_RS_PAIR_STRONG,
    rs_pair_weak: STATE_RS_PAIR_WEAK,
    spot_distance_expanding: STATE_SPOT_DISTANCE_EXPANDING,
    spot_distance_contracting: STATE_SPOT_DISTANCE_CONTRACTING,
    liq_vs_mean_expanding: STATE_LIQ_VS_MEAN_EXPANDING,
    liq_vs_mean_contracting: STATE_LIQ_VS_MEAN_CONTRACTING,
    liq_min_signals: STATE_LIQ_MIN_SIGNALS,
    max_leg_lag_days: STATE_MAX_LEG_LAG_DAYS,
    max_leg_lag_days_dex: STATE_MAX_LEG_LAG_DAYS_DEX,
  };

  return {
    asOf: referenceAsOf,
    stateVersion: STATE_VERSION,
    rulesVersion: STATE_RULES_VERSION,
    sol_trend,
    sol_relative_strength,
    spot,
    onchain_liquidity,
    leverage,
    launchpads,
    macro,
    data_quality,
    rulesApplied,
    thresholdsUsed,
  };
}
