#!/usr/bin/env node
import { filterAndValidatePricePoints } from './sources/coingecko-history';
import { addDays } from './indicators/formulas';

const DAY_MS = 86400000;

// Referência: agora é 2026-10-11; "hoje" (D+1) começa em 2026-10-11T00:00Z.
const now = new Date('2026-10-11T12:00:00Z');
const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const todayMidnight = todayStartMs;            // 00:00 de D+1 -> fechamento de D (2026-10-10)
const yesterdayMidnight = todayStartMs - DAY_MS; // 00:00 de D   -> fechamento de D-1 (2026-10-09)
const futureMidnight = todayStartMs + DAY_MS;    // 00:00 de D+2 -> futuro

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (!ok) failures++; else passed++;
}

// (a) O ponto de 00:00 UTC de D+1 representa o fechamento do dia D.
const aFiltered = filterAndValidatePricePoints([[todayMidnight, 100]], [], [], 'solana', todayStartMs, true);
const aCloseDate = aFiltered.valid.length === 1
  ? addDays(aFiltered.valid[0].collectedAt.toISOString().slice(0, 10), -1)
  : null;
check('a1) ponto 00:00 de D+1 é aceito no modo do job',
  aFiltered.valid.length === 1 && aFiltered.ignored === 0 && aFiltered.invalid === 0);
check('a2) collectedAt do ponto é a meia-noite de D+1',
  aFiltered.valid.length === 1 && aFiltered.valid[0].collectedAt.getTime() === todayMidnight);
check('a3) fechamento do ponto é o dia D (D+1 menos 1 dia)',
  aCloseDate === '2026-10-10', `closeDate=${aCloseDate}`);

// (b) Limiar do job aceita o 00:00 de hoje; o backfill padrão continua rejeitando.
const bDefaultToday = filterAndValidatePricePoints([[todayMidnight, 100]], [], [], 'solana', todayStartMs, false);
check('b1) backfill padrão rejeita o 00:00 de hoje',
  bDefaultToday.valid.length === 0 && bDefaultToday.ignored === 1 && bDefaultToday.ignoredReasons.not_closed_day === 1);

const bDefaultImplicit = filterAndValidatePricePoints([[todayMidnight, 100]], [], [], 'solana', todayStartMs);
check('b2) backfill padrão (parâmetro omitido) rejeita o 00:00 de hoje',
  bDefaultImplicit.valid.length === 0 && bDefaultImplicit.ignoredReasons.not_closed_day === 1);

const bJobToday = filterAndValidatePricePoints([[todayMidnight, 100]], [], [], 'solana', todayStartMs, true);
check('b3) modo do job aceita o 00:00 de hoje',
  bJobToday.valid.length === 1 && bJobToday.ignored === 0);

const bDefaultYesterday = filterAndValidatePricePoints([[yesterdayMidnight, 100]], [], [], 'solana', todayStartMs, false);
const bJobYesterday = filterAndValidatePricePoints([[yesterdayMidnight, 100]], [], [], 'solana', todayStartMs, true);
check('b4) meia-noite de ontem aceita nos dois modos',
  bDefaultYesterday.valid.length === 1 && bJobYesterday.valid.length === 1);

const bDefaultFuture = filterAndValidatePricePoints([[futureMidnight, 100]], [], [], 'solana', todayStartMs, false);
const bJobFuture = filterAndValidatePricePoints([[futureMidnight, 100]], [], [], 'solana', todayStartMs, true);
check('b5) futuro rejeitado nos dois modos',
  bDefaultFuture.valid.length === 0 && bDefaultFuture.ignoredReasons.not_closed_day === 1 &&
  bJobFuture.valid.length === 0 && bJobFuture.ignoredReasons.not_closed_day === 1);

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
