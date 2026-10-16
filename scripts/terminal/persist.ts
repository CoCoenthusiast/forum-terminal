import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { ASSETS, CALC_METHOD, CALC_VERSION, DAILY_CLOSE_WINDOW_MINUTES } from './config';


export const APPROX_CALC_METHOD = 'last_snapshot_of_day_v1';
export const APPROX_CALC_VERSION = 1;


const DAY_MS = 24 * 60 * 60 * 1000;


export async function computeDailyCloses(
  prisma: PrismaClient,
  runCollectedAt: Date,
  lookbackDays: number = 7
): Promise<{ created: number; daysWithoutSnapshot: number; daysAlreadyClosed: number }> {
  const todayUtcMs = Date.UTC(
    runCollectedAt.getUTCFullYear(),
    runCollectedAt.getUTCMonth(),
    runCollectedAt.getUTCDate()
  );


  let created = 0;
  let daysWithoutSnapshot = 0;
  let daysAlreadyClosed = 0;


  for (let i = 1; i <= lookbackDays; i++) {
    const dayStart = new Date(todayUtcMs - i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const windowStart = new Date(dayEnd.getTime() - DAILY_CLOSE_WINDOW_MINUTES * 60 * 1000);


    const existing = await prisma.dailyClose.findMany({
      where: { date: dayStart, asset: { in: [...ASSETS] } },
      select: { asset: true },
    });
    const existingAssets = new Set<string>(existing.map((c: { asset: string }) => c.asset));


    const candidates: {
      asset: string;
      closeUsd: Decimal;
      id: string;
      calcMethod: string;
      calcVersion: number;
    }[] = [];
    let dayHasData = false;


    for (const asset of ASSETS) {
      if (existingAssets.has(asset)) {
        daysAlreadyClosed++;
        dayHasData = true;
        continue;
      }


      const inWindow = await prisma.marketSnapshot.findFirst({
        where: { asset, collectedAt: { gte: windowStart, lt: dayEnd } },
        orderBy: { collectedAt: 'desc' },
        select: { id: true, priceUsd: true },
      });


      if (inWindow) {
        dayHasData = true;
        candidates.push({
          asset,
          closeUsd: inWindow.priceUsd,
          id: inWindow.id,
          calcMethod: CALC_METHOD,
          calcVersion: CALC_VERSION,
        });
        continue;
      }


      const anyInDay = await prisma.marketSnapshot.findFirst({
        where: { asset, collectedAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { collectedAt: 'desc' },
        select: { id: true, priceUsd: true },
      });


      if (anyInDay) {
        dayHasData = true;
        candidates.push({
          asset,
          closeUsd: anyInDay.priceUsd,
          id: anyInDay.id,
          calcMethod: APPROX_CALC_METHOD,
          calcVersion: APPROX_CALC_VERSION,
        });
      }
    }


    if (!dayHasData) {
      daysWithoutSnapshot++;
      continue;
    }


    if (candidates.length === 0) continue;


    const result = await prisma.dailyClose.createMany({
      data: candidates.map((s) => ({
        asset: s.asset,
        date: dayStart,
        closeUsd: s.closeUsd,
        sourceSnapshotId: s.id,
        calcMethod: s.calcMethod,
        calcVersion: s.calcVersion,
      })),
      skipDuplicates: true,
    });
    created += result.count;
  }


  return { created, daysWithoutSnapshot, daysAlreadyClosed };
}