import type { Evidence } from './market-state';
import type { MarketStateWithRegime } from './regime';

const DISCLAIMER =
  'This recap describes market conditions. It is not financial advice and does not predict prices.';

function textOrNa(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'n/a';
}

function formatClassification(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'not enough data';
  if (value === 'insufficient_data' || value === 'unavailable') return 'not enough data';
  return value;
}

function formatPercent(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  const rounded = Math.round(value * 1000) / 10;
  if (rounded === 0) return '0.0%';
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

function formatCount(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'n/a';
}

function findDecides(
  evidence: readonly Evidence[] | undefined,
  indicator: string,
  scope: string
): Evidence | null {
  if (!Array.isArray(evidence)) return null;
  return evidence.find(
    (item) => item.role === 'decides' && item.indicator === indicator && item.scope === scope
  ) ?? null;
}

function staleIndicators(state: MarketStateWithRegime): string[] {
  const fields = [
    state?.sol_trend,
    state?.sol_relative_strength,
    state?.spot,
    state?.onchain_liquidity,
    state?.leverage,
    state?.launchpads,
    state?.macro,
  ];
  const seen = new Set<string>();

  for (const field of fields) {
    if (!Array.isArray(field?.evidence)) continue;
    for (const item of field.evidence) {
      if (item.stale === true && typeof item.indicator === 'string' && item.indicator.length > 0) {
        seen.add(item.indicator);
      }
    }
  }

  return [...seen];
}

export function buildRecapDraft(state: MarketStateWithRegime): string {
  const trendEvidence = findDecides(state?.sol_trend?.evidence, 'return_7d', 'solana');
  const btcEvidence = findDecides(
    state?.sol_relative_strength?.evidence,
    'relative_strength_7d',
    'solana:bitcoin'
  );
  const ethEvidence = findDecides(
    state?.sol_relative_strength?.evidence,
    'relative_strength_7d',
    'solana:ethereum'
  );
  const spotEvidence = findDecides(
    state?.spot?.evidence,
    'volume_vs_mean_7d',
    'solana'
  );
  const dataQuality = state?.data_quality;
  const delayed = staleIndicators(state);

  const lines = [
    `SOL Daily Recap: ${textOrNa(state?.asOf)}`,
    `Regime: ${textOrNa(state?.regime?.description)}`,
    `Trend: ${formatClassification(state?.sol_trend?.classification)}, 7d return ${formatPercent(trendEvidence?.value)}`,
    `Relative strength vs BTC: ${formatClassification(btcEvidence?.legClassification)}, 7d ${formatPercent(btcEvidence?.value)}; vs ETH: ${formatClassification(ethEvidence?.legClassification)}, 7d ${formatPercent(ethEvidence?.value)}`,
    `Spot volume: ${formatClassification(state?.spot?.classification)}, ${formatPercent(spotEvidence?.value)} vs 7d average`,
    `On-chain liquidity: ${formatClassification(state?.onchain_liquidity?.classification)}`,
    `Launchpads: ${formatClassification(state?.launchpads?.classification)}`,
    'Not covered yet: leverage and macro.',
    `Data quality: ${formatCount(dataQuality?.slotsOk)} of ${formatCount(dataQuality?.slotsTotal)} core series available. Oldest data point: ${textOrNa(dataQuality?.oldestAsOf)}.`,
  ];

  if (delayed.length > 0) {
    lines.push(`Delayed inputs: ${delayed.join(', ')}.`);
  }

  lines.push(
    DISCLAIMER,
    `Rules: ${textOrNa(state?.stateVersion)}, ${textOrNa(state?.rulesVersion)}, ${textOrNa(state?.regime?.regimeRulesVersion)}.`,
    'Data: CoinGecko, DefiLlama. Powered by CoinGecko. Powered by DefiLlama.'
  );

  return lines.join('\n');
}
