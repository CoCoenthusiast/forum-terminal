#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const sqlPath = resolve(
  repoRoot,
  'prisma-terminal/sql/2026-11-04-fix-token-collection-failure.sql'
);
const sql = readFileSync(sqlPath, 'utf8');
const databaseUrl = process.env.TEST_DATABASE_URL;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`PASSOU: ${name}`);
    return;
  }

  failed += 1;
  console.log(`FALHOU: ${name}${detail.length > 0 ? ` - ${detail}` : ''}`);
}

function skip(name: string, reason: string): void {
  skipped += 1;
  console.log(`PULADO: ${name} - ${reason}`);
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ColumnRow {
  column_name: string;
  udt_name: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  datetime_precision: number | null;
}

interface ExpectedColumn {
  name: string;
  udt: string;
  nullable: 'YES' | 'NO';
  default: 'none' | '1' | 'CURRENT_TIMESTAMP';
  precision?: number;
}

const expectedColumns: ExpectedColumn[] = [
  { name: 'id', udt: 'text', nullable: 'NO', default: 'none' },
  { name: 'tokenId', udt: 'text', nullable: 'YES', default: 'none' },
  { name: 'tokenAddress', udt: 'text', nullable: 'YES', default: 'none' },
  { name: 'operation', udt: 'text', nullable: 'NO', default: 'none' },
  { name: 'endpoint', udt: 'text', nullable: 'NO', default: 'none' },
  { name: 'status', udt: 'text', nullable: 'NO', default: 'none' },
  { name: 'httpStatus', udt: 'int4', nullable: 'YES', default: 'none' },
  { name: 'retryAfterSeconds', udt: 'int4', nullable: 'YES', default: 'none' },
  { name: 'errorMessage', udt: 'text', nullable: 'YES', default: 'none' },
  { name: 'attempt', udt: 'int4', nullable: 'NO', default: '1' },
  {
    name: 'occurredAt',
    udt: 'timestamp',
    nullable: 'NO',
    default: 'CURRENT_TIMESTAMP',
    precision: 3,
  },
];

const oldColumns = [
  'network',
  'address',
  'reason',
  'statusCode',
  'payload',
  'failedAt',
];

async function createOldTable(client: Client, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  await client.query(`SET search_path TO ${quoteIdent(schema)}`);
  await client.query(`
    CREATE TABLE "Token" (
      "id" TEXT NOT NULL,
      CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
    )
  `);
  await client.query(`
    CREATE TABLE "TokenCollectionFailure" (
      "id" TEXT NOT NULL,
      "network" TEXT NOT NULL DEFAULT 'solana',
      "address" TEXT NOT NULL,
      "reason" TEXT NOT NULL,
      "statusCode" INTEGER,
      "payload" JSONB,
      "failedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "TokenCollectionFailure_pkey" PRIMARY KEY ("id")
    )
  `);
  await client.query(
    'ALTER TABLE "TokenCollectionFailure" ENABLE ROW LEVEL SECURITY'
  );
  await client.query(`
    CREATE POLICY collector_all ON "TokenCollectionFailure"
      FOR ALL
      TO collector
      USING (true)
      WITH CHECK (true)
  `);
  await client.query(
    `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO collector`
  );
  await client.query(
    'GRANT SELECT, INSERT, UPDATE ON "TokenCollectionFailure" TO collector'
  );
}

async function main(): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    skip('fix TokenCollectionFailure SQL', 'TEST_DATABASE_URL is not set');
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const schema = `test_tcf_${suffix}`;
  const lockedSchema = `test_tcf_locked_${suffix}`;
  let createdCollector = false;

  try {
    await client.connect();
  } catch (error) {
    check('connect to local Postgres', false, errorMessage(error));
    await client.end().catch(() => undefined);
    return;
  }

  try {
    const role = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collector') AS exists"
    );
    if (role.rows[0]?.exists !== true) {
      await client.query('CREATE ROLE collector');
      createdCollector = true;
    }

    check(
      'SQL has a single transaction and no destructive statements',
      /^BEGIN;/m.test(sql) &&
        /COMMIT;/m.test(sql) &&
        !/\bDELETE\s+FROM\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i.test(
          sql.replace(/--.*$/gm, '')
        )
    );
    check(
      'empty-table guard runs before the first ALTER',
      sql.indexOf('RAISE EXCEPTION') !== -1 &&
        sql.indexOf('RAISE EXCEPTION') < sql.indexOf('ALTER TABLE')
    );

    await createOldTable(client, schema);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);

    let applyError: unknown = null;
    try {
      await client.query(sql);
    } catch (error) {
      applyError = error;
    }
    check(
      'SQL applies to the empty old table',
      applyError === null,
      errorMessage(applyError)
    );

    const columns = await client.query<ColumnRow>(
      `
        SELECT column_name, udt_name, is_nullable, column_default,
               datetime_precision
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'TokenCollectionFailure'
        ORDER BY ordinal_position
      `,
      [schema]
    );
    const actualColumns = columns.rows;
    const columnsMatch =
      actualColumns.length === expectedColumns.length &&
      expectedColumns.every((expected, index) => {
        const actual = actualColumns[index];
        if (actual === undefined) return false;
        const defaultMatches =
          expected.default === 'none'
            ? actual.column_default === null
            : (actual.column_default ?? '').includes(expected.default);
        const precisionMatches =
          expected.precision === undefined ||
          actual.datetime_precision === expected.precision;
        return (
          actual.column_name === expected.name &&
          actual.udt_name === expected.udt &&
          actual.is_nullable === expected.nullable &&
          defaultMatches &&
          precisionMatches
        );
      });
    check(
      'final columns match the 2026-10-22 format column by column',
      columnsMatch,
      JSON.stringify(actualColumns)
    );
    check(
      'old columns were removed',
      oldColumns.every(
        (name) => !actualColumns.some((column) => column.column_name === name)
      )
    );

    const primaryKey = await client.query<{ columns: string[] }>(
      `
        SELECT array_agg(attribute.attname::text ORDER BY key.ord)::text[] AS columns
        FROM pg_constraint con
        JOIN pg_class table_class ON table_class.oid = con.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY
          AS key(attnum, ord) ON true
        JOIN pg_attribute attribute
          ON attribute.attrelid = table_class.oid
         AND attribute.attnum = key.attnum
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
          AND con.contype = 'p'
        GROUP BY con.oid
      `,
      [schema]
    );
    check(
      'primary key remains on id',
      primaryKey.rows[0]?.columns?.length === 1 &&
        primaryKey.rows[0]?.columns[0] === 'id'
    );

    const foreignKey = await client.query<{
      conname: string;
      local_col: string;
      foreign_table: string;
      foreign_col: string;
      confdeltype: string;
      confupdtype: string;
    }>(
      `
        SELECT con.conname,
               local_attribute.attname AS local_col,
               foreign_class.relname AS foreign_table,
               foreign_attribute.attname AS foreign_col,
               con.confdeltype,
               con.confupdtype
        FROM pg_constraint con
        JOIN pg_class table_class ON table_class.oid = con.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        JOIN pg_class foreign_class ON foreign_class.oid = con.confrelid
        JOIN LATERAL unnest(con.conkey) WITH ORDINALITY
          AS local_key(attnum, ord) ON true
        JOIN pg_attribute local_attribute
          ON local_attribute.attrelid = table_class.oid
         AND local_attribute.attnum = local_key.attnum
        JOIN LATERAL unnest(con.confkey) WITH ORDINALITY
          AS foreign_key(attnum, ord) ON foreign_key.ord = local_key.ord
        JOIN pg_attribute foreign_attribute
          ON foreign_attribute.attrelid = foreign_class.oid
         AND foreign_attribute.attnum = foreign_key.attnum
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
          AND con.contype = 'f'
      `,
      [schema]
    );
    const fk = foreignKey.rows[0];
    check(
      'foreign key matches Token(id) ON DELETE SET NULL ON UPDATE CASCADE',
      fk?.conname === 'TokenCollectionFailure_tokenId_fkey' &&
        fk?.local_col === 'tokenId' &&
        fk?.foreign_table === 'Token' &&
        fk?.foreign_col === 'id' &&
        fk?.confdeltype === 'n' &&
        fk?.confupdtype === 'c'
    );

    const indexes = await client.query<{
      index_name: string;
      indisunique: boolean;
      columns: string[];
    }>(
      `
        SELECT index_class.relname AS index_name,
               index.indisunique,
               array_agg(attribute.attname::text ORDER BY key.ord)::text[] AS columns
        FROM pg_index index
        JOIN pg_class table_class ON table_class.oid = index.indrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        JOIN pg_class index_class ON index_class.oid = index.indexrelid
        JOIN LATERAL unnest(index.indkey) WITH ORDINALITY
          AS key(attnum, ord) ON true
        JOIN pg_attribute attribute
          ON attribute.attrelid = table_class.oid
         AND attribute.attnum = key.attnum
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
          AND NOT index.indisprimary
        GROUP BY index_class.relname, index.indisunique
        ORDER BY index_class.relname
      `,
      [schema]
    );
    const expectedIndexes: Record<string, string[]> = {
      TokenCollectionFailure_tokenAddress_occurredAt_idx: [
        'tokenAddress',
        'occurredAt',
      ],
      TokenCollectionFailure_status_occurredAt_idx: ['status', 'occurredAt'],
      TokenCollectionFailure_tokenId_idx: ['tokenId'],
    };
    const indexesMatch =
      indexes.rows.length === 3 &&
      indexes.rows.every((index) => {
        const expected = expectedIndexes[index.index_name];
        return (
          index.indisunique === false &&
          expected !== undefined &&
          index.columns.length === expected.length &&
          index.columns.every((column, position) => column === expected[position])
        );
      });
    check(
      'the three expected indexes exist with the right columns',
      indexesMatch,
      JSON.stringify(indexes.rows)
    );

    const rls = await client.query<{ relrowsecurity: boolean }>(
      `
        SELECT table_class.relrowsecurity
        FROM pg_class table_class
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
      `,
      [schema]
    );
    check('RLS remains enabled', rls.rows[0]?.relrowsecurity === true);

    const policy = await client.query<{
      polname: string;
      polpermissive: boolean;
      polcmd: string;
      roles: string[];
      qual: string | null;
      withcheck: string | null;
    }>(
      `
        SELECT policy.polname,
               policy.polpermissive,
               policy.polcmd,
               ARRAY(
                 SELECT role.rolname
                 FROM unnest(policy.polroles::oid[]) AS policy_role(oid)
                 JOIN pg_roles role ON role.oid = policy_role.oid
               )::text[] AS roles,
               pg_get_expr(policy.polqual, policy.polrelid) AS qual,
               pg_get_expr(policy.polwithcheck, policy.polrelid) AS withcheck
        FROM pg_policy policy
        JOIN pg_class table_class ON table_class.oid = policy.polrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
      `,
      [schema]
    );
    const collectorPolicy = policy.rows[0];
    check(
      'collector_all policy remains ALL TO collector',
      collectorPolicy?.polname === 'collector_all' &&
        collectorPolicy?.polpermissive === true &&
        collectorPolicy?.polcmd === '*' &&
        collectorPolicy?.roles.includes('collector') === true &&
        collectorPolicy?.qual === 'true' &&
        collectorPolicy?.withcheck === 'true',
      JSON.stringify(collectorPolicy)
    );

    const grants = await client.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `
        SELECT
          has_table_privilege(
            'collector',
            format('%I.%I', $1::text, 'TokenCollectionFailure'),
            'SELECT'
          ) AS can_select,
          has_table_privilege(
            'collector',
            format('%I.%I', $1::text, 'TokenCollectionFailure'),
            'INSERT'
          ) AS can_insert,
          has_table_privilege(
            'collector',
            format('%I.%I', $1::text, 'TokenCollectionFailure'),
            'UPDATE'
          ) AS can_update,
          has_table_privilege(
            'collector',
            format('%I.%I', $1::text, 'TokenCollectionFailure'),
            'DELETE'
          ) AS can_delete
      `,
      [schema]
    );
    const collectorGrants = grants.rows[0];
    check(
      'collector keeps SELECT, INSERT and UPDATE without DELETE',
      collectorGrants?.can_select === true &&
        collectorGrants?.can_insert === true &&
        collectorGrants?.can_update === true &&
        collectorGrants?.can_delete === false
    );

    const countBefore = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "TokenCollectionFailure"'
    );
    check(
      'table remains empty after the migration',
      countBefore.rows[0]?.count === '0'
    );

    let insertError: unknown = null;
    try {
      await client.query('SET ROLE collector');
      await client.query(`
        INSERT INTO "TokenCollectionFailure"
          ("id", "operation", "endpoint", "status")
        VALUES
          ('failure-collector-test', 'collect', '/tokens', 'error')
      `);
    } catch (error) {
      insertError = error;
    } finally {
      await client.query('RESET ROLE').catch(() => undefined);
    }
    check(
      'collector can write a failure row after the migration',
      insertError === null,
      errorMessage(insertError)
    );

    const inserted = await client.query<{
      attempt: number;
      has_occurred_at: boolean;
      token_id: string | null;
      token_address: string | null;
      http_status: number | null;
      retry_after_seconds: number | null;
      error_message: string | null;
    }>(`
      SELECT "attempt",
             "occurredAt" IS NOT NULL AS has_occurred_at,
             "tokenId" AS token_id,
             "tokenAddress" AS token_address,
             "httpStatus" AS http_status,
             "retryAfterSeconds" AS retry_after_seconds,
             "errorMessage" AS error_message
      FROM "TokenCollectionFailure"
      WHERE "id" = 'failure-collector-test'
    `);
    const insertedRow = inserted.rows[0];
    check(
      'collector write uses attempt=1, occurredAt and nullable fields',
      insertedRow?.attempt === 1 &&
        insertedRow?.has_occurred_at === true &&
        insertedRow?.token_id === null &&
        insertedRow?.token_address === null &&
        insertedRow?.http_status === null &&
        insertedRow?.retry_after_seconds === null &&
        insertedRow?.error_message === null
    );

    await createOldTable(client, lockedSchema);
    await client.query(`SET search_path TO ${quoteIdent(lockedSchema)}`);
    await client.query(`
      INSERT INTO "TokenCollectionFailure"
        ("id", "network", "address", "reason", "statusCode", "payload", "failedAt")
      VALUES
        ('existing-row', 'solana', 'address', 'reason', 500, '{}'::jsonb,
         CURRENT_TIMESTAMP)
    `);

    let guardError: unknown = null;
    try {
      await client.query(sql);
    } catch (error) {
      guardError = error;
    }
    await client.query('ROLLBACK').catch(() => undefined);
    check(
      'non-empty table aborts with RAISE EXCEPTION',
      errorMessage(guardError).includes(
        'TokenCollectionFailure must be empty; aborting without changes'
      ),
      errorMessage(guardError)
    );

    const lockedColumns = await client.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'TokenCollectionFailure'
        ORDER BY ordinal_position
      `,
      [lockedSchema]
    );
    const lockedColumnNames = lockedColumns.rows.map((row) => row.column_name);
    const expectedOldColumns = ['id', ...oldColumns];
    check(
      'aborted run leaves the old columns unchanged',
      lockedColumnNames.length === expectedOldColumns.length &&
        expectedOldColumns.every(
          (name, index) => lockedColumnNames[index] === name
        )
    );
    check(
      'aborted run adds no new columns',
      expectedColumns
        .filter((column) => column.name !== 'id')
        .every((column) => !lockedColumnNames.includes(column.name))
    );

    const lockedCount = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "TokenCollectionFailure"'
    );
    check(
      'aborted run leaves the existing row in place',
      lockedCount.rows[0]?.count === '1'
    );

    const lockedForeignKey = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM pg_constraint con
        JOIN pg_class table_class ON table_class.oid = con.conrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
          AND con.contype = 'f'
      `,
      [lockedSchema]
    );
    check(
      'aborted run adds no foreign key',
      lockedForeignKey.rows[0]?.count === '0'
    );

    const lockedIndexes = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM pg_index index
        JOIN pg_class table_class ON table_class.oid = index.indrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
          AND NOT index.indisprimary
      `,
      [lockedSchema]
    );
    check(
      'aborted run adds no indexes',
      lockedIndexes.rows[0]?.count === '0'
    );

    const lockedPolicy = await client.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM pg_policy policy
        JOIN pg_class table_class ON table_class.oid = policy.polrelid
        JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
        WHERE namespace.nspname = $1
          AND table_class.relname = 'TokenCollectionFailure'
          AND policy.polname = 'collector_all'
      `,
      [lockedSchema]
    );
    check(
      'aborted run preserves the collector_all policy',
      lockedPolicy.rows[0]?.count === '1'
    );
  } finally {
    await client.query('SET search_path TO public').catch(() => undefined);
    await client
      .query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
      .catch(() => undefined);
    await client
      .query(`DROP SCHEMA IF EXISTS ${quoteIdent(lockedSchema)} CASCADE`)
      .catch(() => undefined);
    if (createdCollector) {
      await client.query('DROP ROLE IF EXISTS collector').catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

main()
  .catch((error: unknown) => {
    failed += 1;
    console.log(`FALHOU: unexpected test error - ${errorMessage(error)}`);
  })
  .finally(() => {
    console.log(
      `\n=== RESULTADO: ${passed} passaram, ${failed} falharam, ${skipped} pulados ===`
    );
    if (failed > 0) {
      process.exitCode = 1;
    }
  });
