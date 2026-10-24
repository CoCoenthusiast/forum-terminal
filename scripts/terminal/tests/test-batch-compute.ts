#!/usr/bin/env node
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/db/client';
import { Decimal } from '../prisma-types';
import { WRITE_BATCH_SIZE, writeRowsInBatches } from '../compute-indicators';
import type { IndicatorRow } from '../indicators/catalog';
import { saveMarketStates, type MarketStateRow } from '../state/compute-state';
import type { MarketStateWithRegime } from '../state/regime';

const DAY_MS = 24 * 60 * 60 * 1000;
const TEST_FV = 'v1-batch-500-test';
const TOTAL_ROWS = 1205; // 500 + 500 + 205: força três lotes, com sobra no último

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

function makeRows(total: number): IndicatorRow[] {
  const baseMs = Date.UTC(2001, 0, 1);
  return Array.from({ length: total }, (_, i) => ({
    indicator: `batch_test_${String(Math.floor(i / 10)).padStart(4, '0')}`,
    scope: 'solana',
    asOf: new Date(baseMs + i * DAY_MS),
    status: 'ok',
    value: new Decimal(i),
    unit: 'FRACTION',
    inputCount: 1,
    fromDate: null,
    toDate: null,
    reason: null,
    formulaVersion: TEST_FV,
  }));
}

// O client real é embrulhado só para registrar o tamanho de cada createMany.
// O Proxy preserva o restante do PrismaClient (findMany, deleteMany, $disconnect).
function spyCreateMany(prisma: PrismaClient, calls: number[]): PrismaClient {
  return new Proxy(prisma, {
    get(target, prop) {
      if (prop === 'indicatorSnapshot') {
        const delegate = target.indicatorSnapshot;
        return new Proxy(delegate, {
          get(d, p) {
            if (p === 'createMany') {
              return async (args: { data: unknown[]; skipDuplicates?: boolean }) => {
                calls.push(args.data.length);
                return delegate.createMany(args as never);
              };
            }
            const value = Reflect.get(d, p, d);
            return typeof value === 'function' ? value.bind(d) : value;
          },
        });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaClient;
}

function keyOf(row: { indicator: string; scope: string; asOf: Date }): string {
  return `${row.indicator}|${row.scope}|${row.asOf.toISOString().slice(0, 10)}`;
}

async function runTimeoutUnit(): Promise<void> {
  const never = new Promise<never>(() => {});
  const fake = { $transaction: () => never } as unknown as PrismaClient;
  const row: MarketStateRow = {
    asOf: new Date('2001-01-01T00:00:00.000Z'),
    stateVersion: 'test',
    rulesVersion: 'test',
    computeMode: 'backfill',
    dataQualityScore: 1,
    oldestDataDate: null,
    payload: {} as MarketStateWithRegime,
    computedAt: new Date('2001-01-02T00:00:00.000Z'),
  };

  const origError = console.error;
  const lines: string[] = [];
  console.error = ((...args: unknown[]) => {
    lines.push(args.map((x) => String(x)).join(' '));
  }) as typeof console.error;

  const started = Date.now();
  let threw = false;
  let message = '';
  try {
    await saveMarketStates(fake, [row], 20, 25);
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  } finally {
    console.error = origError;
  }
  const elapsed = Date.now() - started;
  const text = lines.join('\n');

  check('save: timeout aborta o lote em vez de pendurar', threw && message.includes('timeout'), `(${message})`);
  check('save: timeout respeita o limite curto', elapsed < 2000, `(${elapsed}ms)`);
  check('save: log de timeout é claro e idempotente', text.includes('timeout')
    && text.includes('não travar o processo') && text.includes('rodar de novo é seguro'));
}

async function run(url: string): Promise<void> {
  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });

  try {
    await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });

    const rows = makeRows(TOTAL_ROWS);
    const calls: number[] = [];
    const spy = spyCreateMany(prisma, calls);

    const first = await writeRowsInBatches(spy, rows);
    check('WRITE_BATCH_SIZE = 500', WRITE_BATCH_SIZE === 500);
    check('grava todas as linhas', first.inserted === TOTAL_ROWS, `(inserted=${first.inserted})`);
    check('não conta duplicidade na primeira execução', first.duplicated === 0, `(duplicated=${first.duplicated})`);
    check('fatia em 500/500/205', calls.join(',') === '500,500,205', `(chamadas=${calls.join(',')})`);
    check('soma dos lotes não perde linhas', calls.reduce((sum, n) => sum + n, 0) === TOTAL_ROWS);

    const persisted = await prisma.indicatorSnapshot.findMany({
      where: { formulaVersion: TEST_FV },
      select: { indicator: true, scope: true, asOf: true },
    });
    check('banco tem exatamente as 1205 linhas', persisted.length === TOTAL_ROWS, `(count=${persisted.length})`);
    const expected = new Set(rows.map(keyOf));
    const actual = new Set(persisted.map(keyOf));
    check('nenhuma chave foi perdida ou duplicada', actual.size === TOTAL_ROWS
      && [...expected].every((key) => actual.has(key)));

    calls.length = 0;
    const second = await writeRowsInBatches(spy, rows);
    check('segunda execução é idempotente', second.inserted === 0 && second.duplicated === TOTAL_ROWS,
      `(inserted=${second.inserted}, duplicated=${second.duplicated})`);
    check('segunda execução repete os lotes 500/500/205', calls.join(',') === '500,500,205', `(chamadas=${calls.join(',')})`);
    check('idempotência não duplica no banco',
      (await prisma.indicatorSnapshot.count({ where: { formulaVersion: TEST_FV } })) === TOTAL_ROWS);
  } finally {
    try {
      await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });
    } catch {
      // limpeza best-effort
    }
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  await runTimeoutUnit();

  const url = localDbUrl();
  if (url !== null) {
    try {
      await run(url);
    } catch (e) {
      check('teste de lote executou', false, e instanceof Error ? e.message : String(e));
    }
  }

  console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
