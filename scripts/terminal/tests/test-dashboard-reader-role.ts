#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const sqlPath = resolve(
  repoRoot,
  'prisma-terminal/sql/2026-11-04-create-dashboard-reader.sql'
);
const sql = readFileSync(sqlPath, 'utf8');
const databaseUrl = process.env.TEST_DATABASE_URL;

const allowedTables = [
  'CollectionLog',
  'DailyClose',
  'DataSource',
  'IndicatorSnapshot',
  'MacroObservation',
  'MarketSnapshot',
  'MarketState',
  'MetricSnapshot',
  'Token',
  'TokenCapture',
  'TokenHolderCapture',
  'TokenPoolCapture',
];

const forbiddenTables = [
  'DailyCloseCorrection',
  'TokenCollectionFailure',
  'Test_backup',
  'Test_bkp',
];

const writeTestTables = ['CollectionLog', 'DailyClose', 'IndicatorSnapshot'];

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

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

function isPermissionDenied(error: unknown): boolean {
  return errorCode(error) === '42501';
}

function isReadOnlyOrPermissionDenied(error: unknown): boolean {
  const code = errorCode(error);
  return code === '42501' || code === '25006';
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string') return [];
  if (value.startsWith('{') && value.endsWith('}')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return value.length === 0 ? [] : [value];
}

async function main(): Promise<void> {
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    skip('dashboard_reader SQL test', 'TEST_DATABASE_URL is not set');
    return;
  }

  const sqlWithoutComments = sql.replace(/--.*$/gm, '');
  check(
    'SQL runs inside one transaction',
    /^BEGIN;/m.test(sql) && /COMMIT;/m.test(sql)
  );
  check(
    'SQL contains no password',
    !/\bPASSWORD\b/i.test(sql)
  );
  check(
    'SQL does not grant write privileges',
    !/GRANT\s+[^;]*(INSERT|UPDATE|DELETE|TRUNCATE)/i.test(
      sqlWithoutComments
    )
  );
  check(
    'SQL does not grant sequence privileges',
    !/GRANT\s+[^;]*\bON\s+SEQUENCE\b/i.test(sqlWithoutComments)
  );
  check(
    'SQL does not alter default privileges',
    !/\bALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(sqlWithoutComments)
  );
  check(
    'SQL does not touch collector policies',
    !/\bcollector_all\b|\bTO\s+collector\b/i.test(sqlWithoutComments)
  );
  check(
    'SQL names all 12 readable tables',
    allowedTables.every((table) => sql.includes(`"${table}"`))
  );
  check(
    'SQL does not name forbidden tables',
    forbiddenTables.every((table) => !sql.includes(`"${table}"`))
  );

  const client = new Client({ connectionString: databaseUrl });
  const suffix = `${Date.now()}_${randomBytes(4).toString('hex')}`;
  const schema = `test_dashboard_reader_${suffix}`;
  const sequence = 'test_dashboard_reader_sequence';
  const testPassword = randomBytes(24).toString('base64url');
  let roleExistedBefore = false;
  let reader: Client | null = null;

  try {
    await client.connect();
  } catch (error) {
    check('connect to local Postgres', false, errorMessage(error));
    await client.end().catch(() => undefined);
    return;
  }

  try {
    const existingRole = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dashboard_reader') AS exists"
    );
    roleExistedBefore = existingRole.rows[0]?.exists === true;

    await client.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
    await client.query(`SET search_path TO ${quoteIdent(schema)}`);
    for (const table of [...allowedTables, ...forbiddenTables]) {
      await client.query(
        `CREATE TABLE ${quoteIdent(table)} ("id" TEXT NOT NULL PRIMARY KEY)`
      );
      await client.query(
        `ALTER TABLE ${quoteIdent(table)} ENABLE ROW LEVEL SECURITY`
      );
    }
    await client.query(`CREATE SEQUENCE ${quoteIdent(sequence)}`);

    let firstApplyError: unknown = null;
    try {
      await client.query(sql);
    } catch (error) {
      firstApplyError = error;
    }
    check(
      'SQL applies on the first run',
      firstApplyError === null,
      errorMessage(firstApplyError)
    );

    let secondApplyError: unknown = null;
    try {
      await client.query(sql);
    } catch (error) {
      secondApplyError = error;
    }
    check(
      'SQL applies on the second run without error',
      secondApplyError === null,
      errorMessage(secondApplyError)
    );

    if (firstApplyError !== null) {
      return;
    }

    await client.query(
      `GRANT USAGE ON SCHEMA ${quoteIdent(schema)} TO dashboard_reader`
    );

    const role = await client.query<{
      rolcanlogin: boolean;
      rolsuper: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolbypassrls: boolean;
      rolconnlimit: number;
      rolconfig: string[] | string;
      no_password: boolean;
    }>(`
      SELECT role.rolcanlogin,
             role.rolsuper,
             role.rolcreatedb,
             role.rolcreaterole,
             role.rolbypassrls,
             role.rolconnlimit,
             role.rolconfig,
             auth.rolpassword IS NULL AS no_password
      FROM pg_roles role
      JOIN pg_authid auth ON auth.oid = role.oid
      WHERE role.rolname = 'dashboard_reader'
    `);
    const roleRow = role.rows[0];
    check(
      'dashboard_reader has LOGIN, no elevated attributes and connection limit 5',
      roleRow?.rolcanlogin === true &&
        roleRow?.rolsuper === false &&
        roleRow?.rolcreatedb === false &&
        roleRow?.rolcreaterole === false &&
        roleRow?.rolbypassrls === false &&
        roleRow?.rolconnlimit === 5
    );
    check(
      'SQL creates dashboard_reader without a password',
      roleRow?.no_password === true
    );
    const roleConfig = toStringArray(roleRow?.rolconfig);
    check(
      'dashboard_reader defaults to read-only transactions and 10s timeout',
      roleConfig.includes('default_transaction_read_only=on') &&
        roleConfig.includes('statement_timeout=10s')
    );

    const schemaPrivilege = await client.query<{ usage: boolean }>(
      "SELECT has_schema_privilege('dashboard_reader', 'public', 'USAGE') AS usage"
    );
    check(
      'dashboard_reader has USAGE on schema public',
      schemaPrivilege.rows[0]?.usage === true
    );

    for (const table of allowedTables) {
      const privileges = await client.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
      }>(
        `
          SELECT
            has_table_privilege(
              'dashboard_reader',
              format('%I.%I', $1::text, $2::text),
              'SELECT'
            ) AS can_select,
            has_table_privilege(
              'dashboard_reader',
              format('%I.%I', $1::text, $2::text),
              'INSERT'
            ) AS can_insert,
            has_table_privilege(
              'dashboard_reader',
              format('%I.%I', $1::text, $2::text),
              'UPDATE'
            ) AS can_update,
            has_table_privilege(
              'dashboard_reader',
              format('%I.%I', $1::text, $2::text),
              'DELETE'
            ) AS can_delete,
            has_table_privilege(
              'dashboard_reader',
              format('%I.%I', $1::text, $2::text),
              'TRUNCATE'
            ) AS can_truncate
        `,
        [schema, table]
      );
      const row = privileges.rows[0];
      check(
        `dashboard_reader has SELECT only on ${table}`,
        row?.can_select === true &&
          row?.can_insert === false &&
          row?.can_update === false &&
          row?.can_delete === false &&
          row?.can_truncate === false
      );
    }

    const sequencePrivileges = await client.query<{
      can_use: boolean;
      can_select: boolean;
      can_update: boolean;
    }>(
      `
        SELECT
          has_sequence_privilege(
            'dashboard_reader',
            format('%I.%I', $1::text, $2::text),
            'USAGE'
          ) AS can_use,
          has_sequence_privilege(
            'dashboard_reader',
            format('%I.%I', $1::text, $2::text),
            'SELECT'
          ) AS can_select,
          has_sequence_privilege(
            'dashboard_reader',
            format('%I.%I', $1::text, $2::text),
            'UPDATE'
          ) AS can_update
      `,
      [schema, sequence]
    );
    check(
      'dashboard_reader has no sequence privileges',
      sequencePrivileges.rows[0]?.can_use === false &&
        sequencePrivileges.rows[0]?.can_select === false &&
        sequencePrivileges.rows[0]?.can_update === false
    );

    const defaultAcl = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_default_acl acl
      JOIN pg_roles role ON role.oid = acl.defaclrole
      WHERE role.rolname = 'dashboard_reader'
    `);
    check(
      'dashboard_reader has no default privileges',
      defaultAcl.rows[0]?.count === '0'
    );

    const policies = await client.query<{
      tablename: string;
      roles: string[] | string;
      cmd: string;
      qual: string | null;
    }>(
      `
        SELECT tablename, roles, cmd, qual
        FROM pg_policies
        WHERE schemaname = $1
          AND policyname = 'dashboard_reader_select'
        ORDER BY tablename
      `,
      [schema]
    );
    const policyTables = new Set(policies.rows.map((row) => row.tablename));
    check(
      'dashboard_reader has one SELECT policy on each of the 12 tables',
      policies.rows.length === 12 &&
        allowedTables.every((table) => policyTables.has(table))
    );
    check(
      'dashboard_reader policies are SELECT TO dashboard_reader USING true',
      policies.rows.every(
        (row) =>
          row.cmd === 'SELECT' &&
          toStringArray(row.roles).includes('dashboard_reader') &&
          row.qual === 'true'
      )
    );
    check(
      'no dashboard_reader policy exists on forbidden tables',
      forbiddenTables.every((table) => !policyTables.has(table))
    );

    await client.query(
      `ALTER ROLE dashboard_reader PASSWORD ${quoteLiteral(testPassword)}`
    );
    const readerUrl = new URL(databaseUrl);
    readerUrl.username = 'dashboard_reader';
    readerUrl.password = testPassword;
    reader = new Client({ connectionString: readerUrl.toString() });

    let readerConnectError: unknown = null;
    try {
      await reader.connect();
    } catch (error) {
      readerConnectError = error;
    }
    check(
      'dashboard_reader can connect with a test password',
      readerConnectError === null,
      errorMessage(readerConnectError)
    );

    if (readerConnectError === null) {
      await reader.query(`SET search_path TO ${quoteIdent(schema)}`);
      const settings = await reader.query<{
        read_only: string;
        timeout: string;
      }>(`
        SELECT current_setting('default_transaction_read_only') AS read_only,
               current_setting('statement_timeout') AS timeout
      `);
      check(
        'dashboard_reader session is read-only',
        settings.rows[0]?.read_only === 'on'
      );
      check(
        'dashboard_reader session has a 10s statement timeout',
        settings.rows[0]?.timeout === '10s'
      );

      for (const table of allowedTables) {
        let selectError: unknown = null;
        try {
          await reader.query(`SELECT COUNT(*) FROM ${quoteIdent(table)}`);
        } catch (error) {
          selectError = error;
        }
        check(
          `dashboard_reader can SELECT ${table}`,
          selectError === null,
          errorMessage(selectError)
        );
      }

      for (const table of writeTestTables) {
        const operations = [
          [
            'INSERT',
            `INSERT INTO ${quoteIdent(table)} ("id") VALUES ('dashboard-reader-test')`,
          ],
          [
            'UPDATE',
            `UPDATE ${quoteIdent(table)} SET "id" = 'dashboard-reader-test'`,
          ],
          ['DELETE', `DELETE FROM ${quoteIdent(table)}`],
        ] as const;
        for (const [operation, statement] of operations) {
          let writeError: unknown = null;
          try {
            await reader.query(statement);
          } catch (error) {
            writeError = error;
          }
          check(
            `dashboard_reader cannot ${operation} ${table}`,
            isReadOnlyOrPermissionDenied(writeError),
            errorMessage(writeError)
          );
        }
      }

      for (const table of forbiddenTables) {
        let selectError: unknown = null;
        try {
          await reader.query(`SELECT COUNT(*) FROM ${quoteIdent(table)}`);
        } catch (error) {
          selectError = error;
        }
        check(
          `dashboard_reader cannot SELECT ${table}`,
          isPermissionDenied(selectError),
          errorMessage(selectError)
        );
      }

      let readWriteError: unknown = null;
      try {
        await reader.query('BEGIN READ WRITE');
        await reader.query(
          `INSERT INTO ${quoteIdent('CollectionLog')} ("id") VALUES ('dashboard-reader-rw')`
        );
      } catch (error) {
        readWriteError = error;
      }
      await reader.query('ROLLBACK').catch(() => undefined);
      check(
        'BEGIN READ WRITE followed by INSERT is refused',
        isReadOnlyOrPermissionDenied(readWriteError),
        errorMessage(readWriteError)
      );
    } else {
      skip('dashboard_reader connection tests', 'connection failed');
    }
  } finally {
    if (reader !== null) {
      await reader.end().catch(() => undefined);
    }
    await client
      .query('ALTER ROLE dashboard_reader PASSWORD NULL')
      .catch(() => undefined);
    await client.query('SET search_path TO public').catch(() => undefined);
    await client
      .query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
      .catch(() => undefined);
    if (!roleExistedBefore) {
      await client.query('DROP ROLE IF EXISTS dashboard_reader').catch(() => undefined);
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
