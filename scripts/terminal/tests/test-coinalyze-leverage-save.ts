#!/usr/bin/env node

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import {
  writeCoinalyzeLeverageRowsInBatches,
  type CoinalyzeLeverageSnapshotRow,
} from '../indicators/compute-coinalyze-leverage';

const TEST_FORMULA_VERSION = 'coinalyze_leverage_v1_test_save';
const TEST_SCOPE = 'coinalyze:TEST';
const TEST_AS_OF = new Date('2099-01-01T00:00:00.000Z');

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function localDbUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    console.log('[SKIP] defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test');
    return null;
  }

  const parsed = new URL(url);
  if (!/^(localhost|127\.0\.0\.1)$/.test(parsed.hostname) || parsed.port !== '5433') {
    console.log(`[SKIP] banco não é local:${parsed.port}: ${parsed.hostname}`);
    return null;
  }

  return url;
}

function row(
  indicator: string,
  value: string | null,
  computedAt: Date
): CoinalyzeLeverageSnapshotRow {
  return {
    indicator,
    scope: TEST_SCOPE,
    asOf: TEST_AS_OF,
    status: value === null ? 'insufficient_history' : 'ok',
    value: value === null ? null : new Decimal(value),
    unit: 'PERCENT',
    inputCount: value === null ? 0 : 3,
    fromDate: value === null ? null : new Date('2098-12-26T00:00:00.000Z'),
    toDate: value === null ? null : new Date('2098-12-31T00:00:00.000Z'),
    reason: value === null ? 'sem valor suficiente' : null,
    formulaVersion: TEST_FORMULA_VERSION,
    computedAt,
  };
}

async function cleanup(prisma: PrismaClient): Promise<void> {
  await prisma.indicatorSnapshot.deleteMany({
    where: { formulaVersion: TEST_FORMULA_VERSION },
  });
}

async function run(prisma: PrismaClient): Promise<void> {
  await cleanup(prisma);

  const firstAt = new Date('2026-10-23T10:00:00.000Z');
  const secondAt = new Date('2026-10-23T11:00:00.000Z');
  const thirdAt = new Date('2026-10-23T12:00:00.000Z');
  const firstRows = [
    row('test_coinalyze_save_a', '10', firstAt),
    row('test_coinalyze_save_b', '20', firstAt),
    row('test_coinalyze_save_null', null, firstAt),
  ];

  const first = await writeCoinalyzeLeverageRowsInBatches(prisma, firstRows);
  const countAfterFirst = await prisma.indicatorSnapshot.count({
    where: { formulaVersion: TEST_FORMULA_VERSION },
  });
  const nullRows = await prisma.indicatorSnapshot.count({
    where: {
      formulaVersion: TEST_FORMULA_VERSION,
      indicator: 'test_coinalyze_save_null',
    },
  });

  check(
    'primeira execução cria pontos não nulos',
    first.created === 2 &&
      first.updated === 0 &&
      first.equal === 0 &&
      first.absent === 1 &&
      countAfterFirst === 2,
    `(created=${first.created} updated=${first.updated} equal=${first.equal} absent=${first.absent} rows=${countAfterFirst})`
  );
  check('ponto null não vira linha', nullRows === 0, `(rows=${nullRows})`);

  const firstStored = await prisma.indicatorSnapshot.findFirst({
    where: {
      formulaVersion: TEST_FORMULA_VERSION,
      indicator: 'test_coinalyze_save_a',
    },
  });

  const secondRows = [
    row('test_coinalyze_save_a', '10', secondAt),
    row('test_coinalyze_save_b', '20', secondAt),
    row('test_coinalyze_save_null', null, secondAt),
  ];
  const second = await writeCoinalyzeLeverageRowsInBatches(prisma, secondRows);
  const countAfterSecond = await prisma.indicatorSnapshot.count({
    where: { formulaVersion: TEST_FORMULA_VERSION },
  });
  const secondStored = await prisma.indicatorSnapshot.findFirst({
    where: {
      formulaVersion: TEST_FORMULA_VERSION,
      indicator: 'test_coinalyze_save_a',
    },
  });

  check(
    'segunda execução é idempotente',
    second.created === 0 &&
      second.updated === 0 &&
      second.equal === 2 &&
      second.absent === 1 &&
      countAfterSecond === 2,
    `(created=${second.created} updated=${second.updated} equal=${second.equal} absent=${second.absent} rows=${countAfterSecond})`
  );
  check(
    'linha igual não é alterada',
    secondStored?.computedAt.toISOString() === firstStored?.computedAt.toISOString() &&
      secondStored?.value?.toString() === '10'
  );

  const changedRows = [
    row('test_coinalyze_save_a', '11', thirdAt),
    row('test_coinalyze_save_b', '20', thirdAt),
    row('test_coinalyze_save_null', null, thirdAt),
  ];
  const changed = await writeCoinalyzeLeverageRowsInBatches(prisma, changedRows);
  const changedStored = await prisma.indicatorSnapshot.findFirst({
    where: {
      formulaVersion: TEST_FORMULA_VERSION,
      indicator: 'test_coinalyze_save_a',
    },
  });

  check(
    'valor diferente atualiza sem duplicar',
    changed.created === 0 &&
      changed.updated === 1 &&
      changed.equal === 1 &&
      changed.absent === 1 &&
      (await prisma.indicatorSnapshot.count({
        where: { formulaVersion: TEST_FORMULA_VERSION },
      })) === 2,
    `(created=${changed.created} updated=${changed.updated} equal=${changed.equal} absent=${changed.absent})`
  );
  check(
    'atualização grava novo valor e computedAt',
    changedStored?.value?.toString() === '11' &&
      changedStored.computedAt.toISOString() === thirdAt.toISOString()
  );

  const changedAgain = await writeCoinalyzeLeverageRowsInBatches(prisma, changedRows);
  check(
    'repetir atualização não altera nem duplica',
    changedAgain.created === 0 &&
      changedAgain.updated === 0 &&
      changedAgain.equal === 2 &&
      changedAgain.absent === 1 &&
      (await prisma.indicatorSnapshot.count({
        where: { formulaVersion: TEST_FORMULA_VERSION },
      })) === 2
  );
}

async function main(): Promise<void> {
  const url = localDbUrl();
  if (url === null) {
    console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
    process.exit(0);
  }

  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    await run(prisma);
  } catch (error) {
    check('teste executou', false, error instanceof Error ? error.message : String(error));
  } finally {
    try {
      await cleanup(prisma);
    } catch {
      console.error('[CLEANUP] falha na limpeza best-effort');
    }
    await prisma.$disconnect();
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
