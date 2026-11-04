import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';

export function getDashboardDatabaseUrl(): string {
  const url = process.env.DASHBOARD_DATABASE_URL;
  if (!url) {
    throw new Error('Missing DASHBOARD_DATABASE_URL');
  }
  return url;
}

export function createDashboardAdapter(url: string): PrismaPg {
  return new PrismaPg({ connectionString: url, max: 3 });
}

export function checkDashboardEnvironment(): void {
  let url: string;
  try {
    url = getDashboardDatabaseUrl();
  } catch (error) {
    console.error(`[ABORT] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  try {
    const parsed = new URL(url);
    const masked = `${parsed.hostname}:${parsed.port || '5432'}/${parsed.pathname.slice(1)}`;
    console.log(`[ENV] DB: ${masked}`);
    const isLocal = /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname);
    const isAllowedRemote =
      process.env.GITHUB_ACTIONS === 'true' ||
      process.env.TERMINAL_ALLOW_REMOTE === '1';
    if (!isLocal && !isAllowedRemote) {
      console.error(
        '[ABORT] Banco remoto não permitido sem GITHUB_ACTIONS=true ou TERMINAL_ALLOW_REMOTE=1'
      );
      process.exit(1);
    }
  } catch {
    console.error('[ABORT] DASHBOARD_DATABASE_URL inválida');
    process.exit(1);
  }
}

let client: PrismaClient | null = null;

export function getDashboardPrisma(): PrismaClient {
  if (client === null) {
    const url = getDashboardDatabaseUrl();
    client = new PrismaClient({ adapter: createDashboardAdapter(url) });
  }
  return client;
}

export default getDashboardPrisma;
