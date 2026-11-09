import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export const SNAPSHOT_KEYS = [
  'overview',
  'onchain',
  'health',
  'leverage-macro',
  'launchpads',
  'tokens',
  'market-structure',
] as const;

export type SnapshotKey = (typeof SNAPSHOT_KEYS)[number];

export const MAX_PAYLOAD_BYTES = 500 * 1024;
export const SNAPSHOT_WRITER_USER_PREFIX = 'snapshot_writer';

export const SNAPSHOT_INSERT_SQL = `INSERT INTO "DashboardSnapshot" ("id", "key", "payload", "generatedAt", "updatedAt")
VALUES ($1, $2, $3::jsonb, $4, $5)
ON CONFLICT ("key") DO UPDATE
SET "id" = EXCLUDED."id",
    "payload" = EXCLUDED."payload",
    "generatedAt" = EXCLUDED."generatedAt",
    "updatedAt" = EXCLUDED."updatedAt";`;

export function isSnapshotKey(value: string): value is SnapshotKey {
  return (SNAPSHOT_KEYS as readonly string[]).includes(value);
}

export function assertSnapshotKey(value: string): asserts value is SnapshotKey {
  if (!isSnapshotKey(value)) {
    throw new Error(`Invalid snapshot key: ${value}`);
  }
}

export function assertPayloadSize(payload: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Snapshot payload exceeds 500 KB (${bytes} bytes; limit ${MAX_PAYLOAD_BYTES})`
    );
  }
}

export function parseDatabaseUrl(
  value: string | undefined,
  variable: string
): URL {
  if (value === undefined || value === '') {
    throw new Error(`${variable} is required`);
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
      throw new Error('invalid protocol');
    }
    return url;
  } catch {
    throw new Error(`${variable} is invalid`);
  }
}

export function requireForumDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const value = env.FORUM_SNAPSHOT_DATABASE_URL;
  if (value === undefined || value === '') {
    throw new Error('Missing FORUM_SNAPSHOT_DATABASE_URL');
  }
  return value;
}

export function assertSnapshotWriterUser(url: URL): void {
  let username: string;
  try {
    username = decodeURIComponent(url.username);
  } catch {
    throw new Error(
      'FORUM_SNAPSHOT_DATABASE_URL user must start with snapshot_writer'
    );
  }
  if (!username.startsWith(SNAPSHOT_WRITER_USER_PREFIX)) {
    throw new Error(
      'FORUM_SNAPSHOT_DATABASE_URL user must start with snapshot_writer'
    );
  }
}

export function assertRemoteAllowed(
  url: URL,
  allowRemote: string | undefined
): void {
  const isLocal = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  if (!isLocal && allowRemote !== '1') {
    throw new Error('Remote database requires TERMINAL_ALLOW_REMOTE=1');
  }
}

export function validateForumDatabaseUrl(
  databaseUrl: string,
  allowRemote: string | undefined
): URL {
  const url = parseDatabaseUrl(databaseUrl, 'FORUM_SNAPSHOT_DATABASE_URL');
  assertSnapshotWriterUser(url);
  assertRemoteAllowed(url, allowRemote);
  return url;
}

export function maskDatabaseUrl(url: URL): string {
  const port = url.port || '5432';
  const database = url.pathname.replace(/^\//, '');
  return `${url.hostname}:${port}/${database}`;
}

export function databaseSecrets(value: string | undefined): string[] {
  if (value === undefined || value === '') return [];
  try {
    const url = new URL(value);
    return [value, decodeURIComponent(url.password)].filter(
      (secret) => secret.length > 0
    );
  } catch {
    return [value];
  }
}

export function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = []
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret.length > 0) {
      message = message.split(secret).join('[redacted]');
    }
  }
  message = message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[redacted]');
  return message.slice(0, 300);
}

type SnapshotQueryable = Pick<Pool, 'query'>;

export async function writeSnapshot(
  pool: SnapshotQueryable,
  key: SnapshotKey,
  payload: unknown,
  generatedAt: Date
): Promise<void> {
  assertSnapshotKey(key);
  assertPayloadSize(payload);
  const serialized = JSON.stringify(payload);
  const id = randomUUID();
  const timestamp = generatedAt.toISOString();
  await pool.query(SNAPSHOT_INSERT_SQL, [
    id,
    key,
    serialized,
    timestamp,
    timestamp,
  ]);
}

export interface PublishSnapshotOptions {
  databaseUrl: string;
  key: SnapshotKey;
  payload: unknown;
  generatedAt: Date;
  allowRemote: string | undefined;
}

export async function publishSnapshot(
  options: PublishSnapshotOptions
): Promise<void> {
  validateForumDatabaseUrl(options.databaseUrl, options.allowRemote);
  assertPayloadSize(options.payload);

  const pool = new Pool({ connectionString: options.databaseUrl, max: 1 });
  try {
    await writeSnapshot(
      pool,
      options.key,
      options.payload,
      options.generatedAt
    );
  } finally {
    await pool.end();
  }
}
