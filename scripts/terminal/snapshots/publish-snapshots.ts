#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  getDashboardDatabaseUrl,
  getDashboardPrisma,
} from '../dashboard/db-readonly';
import { publishBlockReason } from './guards';
import { buildMacroSnapshot, type MacroSnapshot } from './macro';
import {
  buildMarketStructureSnapshot,
  type MarketStructureSnapshot,
} from './market-structure';
import { buildOnchainSnapshot, type OnchainSnapshot } from './onchain';
import { buildOverviewSnapshot, type OverviewSnapshot } from './overview';
import {
  assertPayloadSize,
  assertRemoteAllowed,
  assertSnapshotKey,
  databaseSecrets,
  maskDatabaseUrl,
  parseDatabaseUrl,
  publishSnapshot,
  requireForumDatabaseUrl,
  safeErrorMessage,
  validateForumDatabaseUrl,
  type SnapshotKey,
} from './writer';

export interface PublishArgs {
  screen: SnapshotKey;
  dryRun: boolean;
}

export function parseArgs(argv: readonly string[]): PublishArgs {
  let screen: string | null = null;
  let dryRun = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg.startsWith('--screen=')) {
      screen = arg.slice('--screen='.length);
    } else if (arg === '--screen') {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error('--screen requires a value');
      }
      screen = value;
      index++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (screen === null || screen === '') {
    throw new Error('Missing --screen');
  }
  assertSnapshotKey(screen);
  return { screen, dryRun };
}

export async function run(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const args = parseArgs(argv);
  if (
    args.screen !== 'overview' &&
    args.screen !== 'onchain' &&
    args.screen !== 'market-structure' &&
    args.screen !== 'macro'
  ) {
    throw new Error(`Screen not implemented: ${args.screen}`);
  }

  const dashboardUrl = getDashboardDatabaseUrl();
  const dashboardParsed = parseDatabaseUrl(
    dashboardUrl,
    'DASHBOARD_DATABASE_URL'
  );
  assertRemoteAllowed(dashboardParsed, env.TERMINAL_ALLOW_REMOTE);

  const forumUrl = args.dryRun ? null : requireForumDatabaseUrl(env);
  const forumParsed =
    forumUrl === null
      ? null
      : validateForumDatabaseUrl(forumUrl, env.TERMINAL_ALLOW_REMOTE);

  const prisma = getDashboardPrisma();
  try {
    let snapshot:
      | OverviewSnapshot
      | OnchainSnapshot
      | MarketStructureSnapshot
      | MacroSnapshot;
    if (args.screen === 'overview') {
      snapshot = await buildOverviewSnapshot(prisma, new Date());
    } else if (args.screen === 'onchain') {
      snapshot = await buildOnchainSnapshot(prisma, new Date());
    } else if (args.screen === 'market-structure') {
      snapshot = await buildMarketStructureSnapshot(prisma, new Date());
    } else if (args.screen === 'macro') {
      snapshot = await buildMacroSnapshot(prisma, new Date());
    } else {
      throw new Error(`Screen not implemented: ${args.screen}`);
    }
    assertPayloadSize(snapshot);
    const serialized = JSON.stringify(snapshot);
    const blockReason = publishBlockReason(args.screen, snapshot);

    if (args.dryRun) {
      console.log(`key: ${args.screen}`);
      console.log(`bytes: ${Buffer.byteLength(serialized, 'utf8')}`);
      console.log(`fields: ${Object.keys(snapshot).join(', ')}`);
      console.log(
        `publishable: ${blockReason === null ? 'yes' : `no (${blockReason})`}`
      );
      return;
    }

    if (blockReason !== null) {
      console.log(`[SNAPSHOT] skipped, not published: ${blockReason}`);
      return;
    }

    await publishSnapshot({
      databaseUrl: forumUrl as string,
      key: args.screen,
      payload: snapshot,
      generatedAt: new Date(snapshot.generatedAt),
      allowRemote: env.TERMINAL_ALLOW_REMOTE,
    });
    console.log(
      `[SNAPSHOT] wrote ${args.screen} to ${maskDatabaseUrl(forumParsed as URL)}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (error) {
    const secrets = [
      ...databaseSecrets(process.env.DASHBOARD_DATABASE_URL),
      ...databaseSecrets(process.env.FORUM_SNAPSHOT_DATABASE_URL),
    ];
    console.error(`[SNAPSHOT] ${safeErrorMessage(error, secrets)}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  void main();
}
