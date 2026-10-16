import type { PrismaClient } from './generated/db/client';
import { Decimal } from './prisma-types';
import { ASSETS, CALC_METHOD, CALC_VERSION, DAILY_CLOSE_WINDOW_MINUTES, HISTORY_CALC_METHOD, HISTORY_CALC_VERSION } from './config';


export const APPROX_CALC_METHOD = 'last_snapshot_of_day_v1';
export const APPROX_CALC_VERSION = 1;


const DAY_MS = 24 * 60 * 60 * 1000;

const HISTORY_PROVIDER = 'coingecko_history';

interface CloseCandidate {
  id: string;
  closeUsd: Decimal;
  method: string;
  version: number;
}

const METHOD_RANK: Record<string, number> = {
  [HISTORY_CALC_METHOD]: 3,
  [CALC_METHOD]: 2,
  [APPROX_CALC_METHOD]: 1,
};

function methodRank(method: string): number {
  return METHOD_RANK[method] ?? 0;
}

function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

async function findHistoryClose(prisma: PrismaClient, asset: string, dayEnd: Date): Promise<CloseCandidate | null> {
  const snapshot = await prisma.marketSnapshot.findFirst({
    where: { asset, collectedAt: dayEnd, source: { provider: HISTORY_PROVIDER } },
    select: { id: true, priceUsd: true },
  });
  if (!snapshot) return null;
  return { id: snapshot.id, closeUsd: snapshot.priceUsd, method: HISTORY_CALC_METHOD, version: HISTORY_CALC_VERSION };
}

async function findBestCloseCandidate(
  prisma: PrismaClient,
  asset: string,
  dayStart: Date,
  dayEnd: Date,
  windowStart: Date
): Promise<CloseCandidate | null> {
  const history = await findHistoryClose(prisma, asset, dayEnd);
  if (history) return history;

  const inWindow = await prisma.marketSnapshot.findFirst({
    where: { asset, collectedAt: { gte: windowStart, lt: dayEnd } },
    orderBy: { collectedAt: 'desc' },
    select: { id: true, priceUsd: true },
  });
  if (inWindow) {
    return { id: inWindow.id, closeUsd: inWindow.priceUsd, method: CALC_METHOD, version: CALC_VERSION };
  }

  const anyInDay = await prisma.marketSnapshot.findFirst({
    where: { asset, collectedAt: { gte: dayStart, lt: dayEnd } },
    orderBy: { collectedAt: 'desc' },
    select: { id: true, priceUsd: true },
  });
  if (anyInDay) {
    return { id: anyInDay.id, closeUsd: anyInDay.priceUsd, method: APPROX_CALC_METHOD, version: APPROX_CALC_VERSION };
  }

  return null;
}


export async function computeDailyCloses(
  prisma: PrismaClient,
  runCollectedAt: Date,
  lookbackDays: number = 7
): Promise<{ created: number; daysWithoutSnapshot: number; daysAlreadyClosed: number }> {
  const todayUtcMs = utcDayStart(runCollectedAt);


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


    const candidates: ({ asset: string } & CloseCandidate)[] = [];
    let dayHasData = false;


    for (const asset of ASSETS) {
      if (existingAssets.has(asset)) {
        daysAlreadyClosed++;
        dayHasData = true;
        continue;
      }


      const candidate = await findBestCloseCandidate(prisma, asset, dayStart, dayEnd, windowStart);
      if (candidate) {
        dayHasData = true;
        candidates.push({ asset, ...candidate });
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
        calcMethod: s.method,
        calcVersion: s.version,
      })),
      skipDuplicates: true,
    });
    created += result.count;
  }


  return { created, daysWithoutSnapshot, daysAlreadyClosed };
}


export async function upgradeDailyCloses(
  prisma: PrismaClient,
  runCollectedAt: Date,
  lookbackDays: number = 7
): Promise<{ corrected: number; alreadyCurrent: number; noCandidate: number; blocked: number }> {
  const todayUtcMs = utcDayStart(runCollectedAt);

  interface UpgradeJob {
    asset: string;
    date: Date;
    existingId: string;
    existingCloseUsd: Decimal;
    existingCalcMethod: string;
    candidate: CloseCandidate;
  }

  const jobs: UpgradeJob[] = [];
  let alreadyCurrent = 0;
  let noCandidate = 0;

  for (let i = 1; i <= lookbackDays; i++) {
    const dayStart = new Date(todayUtcMs - i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const windowStart = new Date(dayEnd.getTime() - DAILY_CLOSE_WINDOW_MINUTES * 60 * 1000);

    for (const asset of ASSETS) {
      const existing = await prisma.dailyClose.findUnique({
        where: { asset_date: { asset, date: dayStart } },
        select: { id: true, closeUsd: true, calcMethod: true, sourceSnapshotId: true },
      });
      if (!existing) continue;

      const candidate = await findBestCloseCandidate(prisma, asset, dayStart, dayEnd, windowStart);
      if (!candidate) {
        noCandidate++;
        continue;
      }

      if (methodRank(candidate.method) <= methodRank(existing.calcMethod)) {
        alreadyCurrent++;
        continue;
      }

      jobs.push({
        asset,
        date: dayStart,
        existingId: existing.id,
        existingCloseUsd: existing.closeUsd,
        existingCalcMethod: existing.calcMethod,
        candidate,
      });
    }
  }

  jobs.sort((a, b) => b.date.getTime() - a.date.getTime());

  let corrected = 0;
  let blocked = 0;

  for (const job of jobs) {
    const conflict = await prisma.dailyClose.findFirst({
      where: { sourceSnapshotId: job.candidate.id, NOT: { id: job.existingId } },
      select: { id: true },
    });
    if (conflict) {
      blocked++;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      await tx.dailyClose.update({
        where: { id: job.existingId },
        data: {
          closeUsd: job.candidate.closeUsd,
          sourceSnapshotId: job.candidate.id,
          calcMethod: job.candidate.method,
          calcVersion: job.candidate.version,
        },
      });
      await tx.dailyCloseCorrection.create({
        data: {
          asset: job.asset,
          date: job.date,
          oldCloseUsd: job.existingCloseUsd,
          newCloseUsd: job.candidate.closeUsd,
          oldCalcMethod: job.existingCalcMethod,
          newCalcMethod: job.candidate.method,
          reason: `preferred ${job.candidate.method} over ${job.existingCalcMethod}`,
          dailyCloseId: job.existingId,
        },
      });
    });
    corrected++;
  }

  return { corrected, alreadyCurrent, noCandidate, blocked };
}
