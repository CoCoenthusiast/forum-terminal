#!/usr/bin/env node
import { parseOnlyFlag } from './backfill-history';

let failures = 0;
let passed = 0;

function check(name: string, ok: boolean, extra = '') {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (!ok) failures++; else passed++;
}

console.log('=== TESTES DE parseOnlyFlag ===\n');

check('1) sem --only -> only=null, error=null',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts']);
    return r.only === null && r.error === null;
  })());

check('2) --only=coingecko -> only=coingecko',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--only=coingecko']);
    return r.only === 'coingecko' && r.error === null;
  })());

check('3) --only=defillama -> only=defillama',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--only=defillama']);
    return r.only === 'defillama' && r.error === null;
  })());

check('4) --only=xrp -> erro e only=null',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--only=xrp']);
    return r.only === null && r.error !== null && r.error.includes('--only=xrp') && r.error.includes('não suportado');
  })());

check('5) --only= (vazio) -> erro e only=null',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--only=']);
    return r.only === null && r.error !== null && r.error.includes('não suportado');
  })());

check('6) --only=CoinGecko (case diferente) -> erro e only=null',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--only=CoinGecko']);
    return r.only === null && r.error !== null;
  })());

check('7) --only=defillama junto de --days=30 -> only=defillama',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--days=30', '--only=defillama', '--dry-run']);
    return r.only === 'defillama' && r.error === null;
  })());

check('8) --only sem "=" (arg malformado) -> ignorado, only=null',
  (() => {
    const r = parseOnlyFlag(['node', 'backfill-history.ts', '--only']);
    return r.only === null && r.error === null;
  })());

console.log(`\n=== RESULTADO: ${passed} passaram, ${failures} falharam ===`);
process.exit(failures === 0 ? 0 : 1);
