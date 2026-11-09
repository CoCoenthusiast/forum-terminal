import type { PrismaClient } from '../generated/db/client';
import { previousUtcDay } from '../checks/freshness-rules';
import {
  readIndicatorSeries,
  type SeriesTarget,
} from '../dashboard/series-reader';
import { COINALYZE_LEVERAGE_FORMULA_VERSION } from '../indicators/coinalyze-leverage-catalog';
import { INDICATOR_FORMULA_VERSION } from '../state/compute-state';

const DAY_MS = 24 * 60 * 60 * 1000;
const MARKET_STRUCTURE_WINDOW_DAYS = 90;
const MARKET_STRUCTURE_PRICE_PROVIDER = 'coingecko_history';
const MARKET_STRUCTURE_PRICE_QUERY_LIMIT = 5000;
const RELATIVE_STRENGTH_INDICATOR = 'relative_strength_7d';

const ASSETS = [
  { id: 'solana', label: 'SOL', coinalyzeScope: 'coinalyze:SOL' },
  { id: 'bitcoin', label: 'BTC', coinalyzeScope: 'coinalyze:BTC' },
  { id: 'ethereum', label: 'ETH', coinalyzeScope: 'coinalyze:ETH' },
] as const;

const LEVERAGE_SERIES = [
  {
    id: 'oi_change_1d',
    indicator: 'oi_usd_change_1d_pct',
    label: 'OI change 1d',
  },
  {
    id: 'oi_change_7d',
    indicator: 'oi_usd_change_7d_pct',
    label: 'OI change 7d',
  },
  {
    id: 'funding_7d_mean',
    indicator: 'funding_7d_mean',
    label: 'Funding 7d mean',
  },
  {
    id: 'long_short_ratio_7d_mean',
    indicator: 'long_short_ratio_7d_mean',
    label: 'Long/short ratio 7d mean',
  },
  {
    id: 'liq_total_vs_mean_7d',
    indicator: 'liq_total_vs_mean7d_pct',
    label: 'Total liquidations vs 7d mean',
  },
  {
    id: 'liq_long_share',
    indicator: 'liq_long_share_pct',
    label: 'Long share of liquidations',
  },
] as const;

const RATIOS = [
  { id: 'sol_btc', label: 'SOL/BTC', scope: 'solana:bitcoin' },
  { id: 'sol_eth', label: 'SOL/ETH', scope: 'solana:ethereum' },
] as const;

const MARKET_STRUCTURE_SERIES_TARGETS: readonly SeriesTarget[] = [
  ...ASSETS.flatMap((asset) =>
    LEVERAGE_SERIES.map((definition) => ({
      indicator: definition.indicator,
      scope: asset.coinalyzeScope,
      formulaVersion: COINALYZE_LEVERAGE_FORMULA_VERSION,
    }))
  ),
  ...RATIOS.map((ratio) => ({
    indicator: RELATIVE_STRENGTH_INDICATOR,
    scope: ratio.scope,
    formulaVersion: INDICATOR_FORMULA_VERSION,
  })),
];

export interface MarketStructurePoint {
  date: string;
  value: number;
}

export interface MarketStructureLeverageSeries {
  id:
    | 'oi_change_1d'
    | 'oi_change_7d'
    | 'funding_7d_mean'
    | 'long_short_ratio_7d_mean'
    | 'liq_total_vs_mean_7d'
    | 'liq_long_share';
  label: string;
  unit: string;
  points: MarketStructurePoint[];
}

export interface MarketStructureAsset {
  id: 'solana' | 'bitcoin' | 'ethereum';
  label: 'SOL' | 'BTC' | 'ETH';
  price: MarketStructurePoint[];
  spotVolume: MarketStructurePoint[];
  leverage: MarketStructureLeverageSeries[];
}

export interface MarketStructureRatio {
  id: 'sol_btc' | 'sol_eth';
  label: 'SOL/BTC' | 'SOL/ETH';
  unit: string;
  points: MarketStructurePoint[];
}

export interface MarketStructureSnapshot {
  generatedAt: string;
  asOf: string;
  windowDays: number;
  assets: MarketStructureAsset[];
  relativeStrength: MarketStructureRatio[];
}

type MarketStructureAssetId = MarketStructureAsset['id'];
type MarketStructureLeverageId = MarketStructureLeverageSeries['id'];
type MarketStructureRatioId = MarketStructureRatio['id'];

interface MarketStructurePriceSeries {
  price: MarketStructurePoint[];
  spotVolume: MarketStructurePoint[];
}

interface MarketStructureLeverageInput {
  id: MarketStructureLeverageId;
  unit: string;
  points: readonly MarketStructurePoint[];
}

interface MarketStructureAssetInput {
  id: MarketStructureAssetId;
  price: readonly MarketStructurePoint[];
  spotVolume: readonly MarketStructurePoint[];
  leverage: readonly MarketStructureLeverageInput[];
}

interface MarketStructureRatioInput {
  id: MarketStructureRatioId;
  unit: string;
  points: readonly MarketStructurePoint[];
}

interface MarketStructurePayloadInput {
  asOf: string;
  assets: readonly MarketStructureAssetInput[];
  relativeStrength: readonly MarketStructureRatioInput[];
}

interface MarketSnapshotRow {
  asset: string;
  priceUsd: unknown;
  volume24hUsd: unknown;
  collectedAt: Date;
  sourceTs: Date;
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
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

function pointsFor(
  points: readonly MarketStructurePoint[]
): MarketStructurePoint[] {
  return points.map((point) => ({ date: point.date, value: point.value }));
}

async function readMarketStructurePrices(
  client: Pick<PrismaClient, 'marketSnapshot'>,
  asOf: string
): Promise<Record<MarketStructureAssetId, MarketStructurePriceSeries>> {
  const asOfMs = new Date(`${asOf}T00:00:00.000Z`).getTime();
  // DailyClose convention: the 00:00 UTC point of D+1 is the close of day D.
  const from = new Date(asOfMs - (MARKET_STRUCTURE_WINDOW_DAYS - 2) * DAY_MS);
  const toInclusive = new Date(asOfMs + DAY_MS);

  const rows: MarketSnapshotRow[] = await client.marketSnapshot.findMany({
    where: {
      asset: { in: ASSETS.map((asset) => asset.id) },
      source: { provider: MARKET_STRUCTURE_PRICE_PROVIDER },
      sourceTs: { gte: from, lte: toInclusive },
    },
    orderBy: [{ sourceTs: 'desc' }, { collectedAt: 'desc' }],
    take: MARKET_STRUCTURE_PRICE_QUERY_LIMIT,
    select: {
      asset: true,
      priceUsd: true,
      volume24hUsd: true,
      sourceTs: true,
      collectedAt: true,
    },
  });

  const byAssetDate = new Map<
    string,
    Map<string, { row: MarketSnapshotRow; collectedAt: number }>
  >();

  for (const row of rows) {
    const date = isoDay(row.sourceTs.getTime() - DAY_MS);
    let byDate = byAssetDate.get(row.asset);
    if (byDate === undefined) {
      byDate = new Map();
      byAssetDate.set(row.asset, byDate);
    }

    const collectedAt = row.collectedAt.getTime();
    const current = byDate.get(date);
    if (current === undefined || collectedAt > current.collectedAt) {
      byDate.set(date, { row, collectedAt });
    }
  }

  const result: Record<
    MarketStructureAssetId,
    MarketStructurePriceSeries
  > = {
    solana: { price: [], spotVolume: [] },
    bitcoin: { price: [], spotVolume: [] },
    ethereum: { price: [], spotVolume: [] },
  };

  for (const asset of ASSETS) {
    const byDate = byAssetDate.get(asset.id);
    if (byDate === undefined) continue;

    const price: MarketStructurePoint[] = [];
    const spotVolume: MarketStructurePoint[] = [];

    for (const [date, item] of [...byDate.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    )) {
      const priceValue = numberOrNull(item.row.priceUsd);
      if (priceValue !== null) {
        price.push({ date, value: priceValue });
      }

      const volumeValue = numberOrNull(item.row.volume24hUsd);
      if (volumeValue !== null) {
        spotVolume.push({ date, value: volumeValue });
      }
    }

    result[asset.id] = { price, spotVolume };
  }

  return result;
}

export function buildMarketStructurePayload(
  inputs: MarketStructurePayloadInput,
  generatedAt: Date
): MarketStructureSnapshot {
  const assetById = new Map(inputs.assets.map((asset) => [asset.id, asset]));
  const ratioById = new Map(
    inputs.relativeStrength.map((ratio) => [ratio.id, ratio])
  );

  return {
    generatedAt: generatedAt.toISOString(),
    asOf: inputs.asOf,
    windowDays: MARKET_STRUCTURE_WINDOW_DAYS,
    assets: ASSETS.map((assetDefinition) => {
      const assetInput = assetById.get(assetDefinition.id);
      const leverageById = new Map(
        (assetInput?.leverage ?? []).map((leverage) => [leverage.id, leverage])
      );

      return {
        id: assetDefinition.id,
        label: assetDefinition.label,
        price: pointsFor(assetInput?.price ?? []),
        spotVolume: pointsFor(assetInput?.spotVolume ?? []),
        leverage: LEVERAGE_SERIES.map((leverageDefinition) => {
          const leverageInput = leverageById.get(leverageDefinition.id);
          return {
            id: leverageDefinition.id,
            label: leverageDefinition.label,
            unit: leverageInput?.unit ?? 'n/a',
            points: pointsFor(leverageInput?.points ?? []),
          };
        }),
      };
    }),
    relativeStrength: RATIOS.map((ratioDefinition) => {
      const ratioInput = ratioById.get(ratioDefinition.id);
      return {
        id: ratioDefinition.id,
        label: ratioDefinition.label,
        unit: ratioInput?.unit ?? 'FRACTION',
        points: pointsFor(ratioInput?.points ?? []),
      };
    }),
  };
}

export async function buildMarketStructureSnapshot(
  client: PrismaClient,
  now: Date = new Date()
): Promise<MarketStructureSnapshot> {
  const asOf = previousUtcDay(now);
  const [prices, series] = await Promise.all([
    readMarketStructurePrices(client, asOf),
    readIndicatorSeries(client, MARKET_STRUCTURE_SERIES_TARGETS, asOf),
  ]);

  const seriesByKey = new Map(
    series.map((item) => [`${item.indicator}|${item.scope}`, item])
  );

  const assets: MarketStructureAssetInput[] = ASSETS.map((asset) => {
    const priceInput = prices[asset.id];
    return {
      id: asset.id,
      price: priceInput.price,
      spotVolume: priceInput.spotVolume,
      leverage: LEVERAGE_SERIES.map((definition) => {
        const leverageSeries = seriesByKey.get(
          `${definition.indicator}|${asset.coinalyzeScope}`
        );
        return {
          id: definition.id,
          unit: leverageSeries?.unit ?? 'n/a',
          points: leverageSeries?.points ?? [],
        };
      }),
    };
  });

  const relativeStrength: MarketStructureRatioInput[] = RATIOS.map((ratio) => {
    const ratioSeries = seriesByKey.get(
      `${RELATIVE_STRENGTH_INDICATOR}|${ratio.scope}`
    );
    return {
      id: ratio.id,
      unit: ratioSeries?.unit ?? 'FRACTION',
      points: ratioSeries?.points ?? [],
    };
  });

  return buildMarketStructurePayload(
    { asOf, assets, relativeStrength },
    now
  );
}
