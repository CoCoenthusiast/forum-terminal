import type { PrismaClient } from '../generated/db/client';
import type { Reader } from './loaders';

const MARKET_PROVIDERS = ['coingecko', 'coingecko_history'];

export function createPrismaReader(prisma: PrismaClient): Reader {
  return {
    async marketSnapshotFindMany({ asset, from, to }) {
      const rows = await prisma.marketSnapshot.findMany({
        where: {
          asset,
          collectedAt: { gte: from, lte: to },
          source: { provider: { in: MARKET_PROVIDERS } },
        },
        select: {
          collectedAt: true,
          priceUsd: true,
          volume24hUsd: true,
          marketCapUsd: true,
          source: { select: { provider: true } },
        },
        orderBy: { collectedAt: 'asc' },
      });
      return rows.map((row) => ({
        collectedAt: row.collectedAt,
        priceUsd: row.priceUsd,
        volume24hUsd: row.volume24hUsd,
        marketCapUsd: row.marketCapUsd,
        provider: row.source.provider,
      }));
    },

    async metricSnapshotFindMany({ scope, metric, providers, from, to }) {
      const rows = await prisma.metricSnapshot.findMany({
        where: {
          scope,
          metric,
          collectedAt: { gte: from, lte: to },
          source: { provider: { in: providers } },
        },
        select: {
          collectedAt: true,
          value: true,
          source: { select: { provider: true } },
        },
        orderBy: { collectedAt: 'asc' },
      });
      return rows.map((row) => ({
        collectedAt: row.collectedAt,
        value: row.value,
        provider: row.source.provider,
      }));
    },
  };
}
