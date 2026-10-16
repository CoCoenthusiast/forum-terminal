import {
  simpleReturn,
  levelChange,
  turnover,
  pairRatio,
  pairRatioReturn,
  lastCommonDate,
  crossRatio,
  validateSeries,
  buildMap,
  addDays,
  okResult,
  insufficientResult,
  unavailableResult,
  PERMANENTLY_UNAVAILABLE,
  MIN_COVERAGE,
  Point,
  realizedVolatility,
  drawdownFromMax,
  maxDrawdown,
  distanceToSma,
  rangePosition,
  rsiWilder,
  correlation,
  beta,
  zScore,
  meanRatio,
} from './formulas';

let failures = 0;
let total = 0;

function check(nome: string, condicao: boolean): void {
  total++;
  if (condicao) {
    console.log('PASSOU: ' + nome);
  } else {
    console.log('FALHOU: ' + nome);
    failures++;
  }
}

function checkInvariant(resultado: any, nome: string): void {
  total++;
  const statusOk = resultado.status === 'ok';
  const statusNotOk = resultado.status !== 'ok';
  if (statusNotOk) {
    const valueNull = resultado.value === null;
    const reasonFilled = resultado.reason !== null;
    if (valueNull && reasonFilled) {
      console.log('PASSOU: ' + nome);
    } else {
      console.log(
        'FALHOU: ' +
          nome +
          ' - expected value=null && reason!=null for status!==ok, got value=' +
          resultado.value +
          ' reason=' +
          resultado.reason
      );
      failures++;
    }
  } else {
    const reasonNull = resultado.reason === null;
    if (reasonNull) {
      console.log('PASSOU: ' + nome);
    } else {
      console.log(
        'FALHOU: ' + nome + ' - expected reason===null for status===ok, got reason=' + resultado.reason
      );
      failures++;
    }
  }
}

// Helper: cria série de 10 preços com datas em janeiro (com zero à esquerda)
function makeSeries10(): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < 10; i++) {
    const day = String(i + 1).padStart(2, '0');
    result.push({ date: `2025-01-${day}`, value: 100 + i });
  }
  return result;
}

// Helper: cria série de 30 preços com datas em janeiro
function makeSeries30(): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < 30; i++) {
    const day = String(i + 1).padStart(2, '0');
    result.push({ date: `2025-01-${day}`, value: 100 + i * 0.5 });
  }
  return result;
}

const s10 = makeSeries10();
const s30 = makeSeries30();

// 24) correlation tests with simple series
// correlation consigo mesma = 1
const r24a = correlation(s30, s30, '2025-01-30', 29);
checkInvariant(r24a, 'correlation série consigo mesma = 1');
check('correlation valor', Math.abs(r24a.value! - 1) < 1e-9);

// 25) correlation com série constante -> unavailable
// série com todas as mesmas values mas datas diferentes e crecrescentes
const s25: Point[] = [];
for (let i = 0; i < 30; i++) {
  const day = String(i + 1).padStart(2, '0');
  s25.push({ date: `2025-01-${day}`, value: 50 });
}
const r25 = correlation(s10, s25, '2025-01-10', 9);
check('correlation serie constante -> unavailable', r25.status === 'unavailable');

// 27) Sem look-ahead
const s27a: Point[] = [...s10, { date: '2025-02-01', value: 1e9 }];
const r27 = correlation(s10, s27a, '2025-01-10', 9);
check('correlation sem look-ahead', Math.abs(r27.value! - 1) < 1e-9);

// 28) zScore valores 1..10, asOf último, n=10
const s28v: number[] = [];
for (let i = 0; i < 10; i++) s28v.push(i + 1);
const dates28: string[] = [];
for (let i = 0; i < 10; i++) {
  const day = String(i + 1).padStart(2, '0');
  dates28.push(`2025-01-${day}`);
}
const s28: Point[] = [];
for (let i = 0; i < 10; i++) s28.push({ date: dates28[i], value: s28v[i] });
const r28 = zScore(s28, '2025-01-10', 10);
checkInvariant(r28, 'zScore valores 1..10');
check('zScore valor', Math.abs(r28.value! - 4.5 / Math.sqrt(82.5 / 9)) < 1e-9);

// 29) zScore série constante -> unavailable
const s29: Point[] = [];
for (let i = 0; i < 10; i++) {
  const day = String(i + 1).padStart(2, '0');
  s29.push({ date: `2025-01-${day}`, value: 50 });
}
const r29 = zScore(s29, '2025-01-10', 10);
check('zScore serie constante -> unavailable', r29.status === 'unavailable');

// 30) meanRatio valores 1..10, shortN=5, longN=10 -> 8/5.5 (média de 6..10 / média de 1..10)
const dates31: string[] = [];
for (let i = 0; i < 10; i++) {
  const day = String(i + 1).padStart(2, '0');
  dates31.push(`2025-01-${day}`);
}
const s31: Point[] = [];
for (let i = 0; i < 10; i++) s31.push({ date: dates31[i], value: i + 1 });
const r31 = meanRatio(s31, '2025-01-10', 5, 10);
checkInvariant(r31, 'meanRatio valores 1..10, shortN=5, longN=10');
check('meanRatio valor', Math.abs(r31.value! - 8 / 5.5) < 1e-9);

// 31) Média longa = 0 -> unavailable
const s32: Point[] = [];
for (let i = 0; i < 10; i++) {
  const day = String(i + 1).padStart(2, '0');
  s32.push({ date: `2025-01-${day}`, value: 0 });
}
const r30 = meanRatio(s32, '2025-01-10', 5, 10);
check('meanRatio media longa = 0 -> unavailable', r30.status === 'unavailable');

// ==========================================
// TESTES ADICIONAIS (Parte 5)
// ==========================================

// Helper: lança erro se a função passar um erro
function throws(fn: () => void): void {
  try {
    fn();
    throw new Error('Deveria ter lançado erro');
  } catch (e) {
    // Erro lançado como esperado
  }
}

// Helper: gera série com datas consecutivas a partir de "inicio"
function mk(inicio: string, valores: number[]): Point[] {
  const result: Point[] = [];
  let currentDate = inicio;
  for (const v of valores) {
    result.push({ date: currentDate, value: v });
    currentDate = addDays(currentDate, 1);
  }
  return result;
}

// 1. validateSeries: série vazia lança; datas fora de ordem lança; data repetida lança; '2025-02-30' lança; série válida não lança
const sEmpty: Point[] = [];
throws(() => validateSeries(sEmpty));
const sOrderErr: Point[] = [
  { date: '2025-01-03', value: 100 },
  { date: '2025-01-01', value: 50 },
];
throws(() => validateSeries(sOrderErr));
const sRepeat: Point[] = [
  { date: '2025-01-01', value: 100 },
  { date: '2025-01-01', value: 50 },
];
throws(() => validateSeries(sRepeat));
const sInvalidDate: Point[] = [
  { date: '2025-02-30', value: 100 },
];
throws(() => validateSeries(sInvalidDate));
const sValid: Point[] = [
  { date: '2025-01-01', value: 100 },
  { date: '2025-01-02', value: 50 },
];
try {
  validateSeries(sValid);
} catch (e) {
  throw new Error('Série válida não deveria lançar erro');
}

// 2. addDays: ('2025-03-01',-1)='2025-02-28'; ('2024-03-01',-1)='2024-02-29'; ('2025-12-31',1)='2026-01-01'
const addRes1 = addDays('2025-03-01', -1);
check('addDays Março-1 anterior', addRes1 === '2025-02-28');
const addRes2 = addDays('2024-03-01', -1);
check('addDays 2024-03-01 anterior (bissexto)', addRes2 === '2024-02-29');
const addRes3 = addDays('2025-12-31', 1);
check('addDays Ano novo', addRes3 === '2026-01-01');

// 3. simpleReturn: série mk('2025-01-01',[100..109]) (10 pontos), asOf '2025-01-10', n=7 → esperado 109/102 - 1
const sSimple: Point[] = mk('2025-01-01', [100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
const rSimple = simpleReturn(sSimple, '2025-01-10', 7);
check('simpleReturn valor', Math.abs(rSimple.value! - (109/102 - 1)) < 1e-9);
// asOf inexistente → status 'insufficient_history'
const rSimpleNoData = simpleReturn([{ date: '2025-01-01', value: 100 }, { date: '2025-01-05', value: 110 }], '2025-01-15', 7);
check('simpleReturn insufficient_history', rSimpleNoData.status === 'insufficient_history');

// 4. levelChange: mesma entrada do teste 3 → valor igual ao de simpleReturn
const rLevel = levelChange(sSimple, '2025-01-10', 7);
check('levelChange igual a simpleReturn', rLevel.value === rSimple.value);

// 5. turnover: volume 50 e market cap 200 em 2025-01-10 → 0.25. Market cap 0 → 'unavailable'. Data ausente → 'insufficient_history'.
const sTurnoverVol: Point[] = mk('2025-01-10', [50]);
const sTurnoverMc: Point[] = mk('2025-01-10', [200]);
const rTurnover = turnover(sTurnoverVol, sTurnoverMc, '2025-01-10');
check('turnover valor', Math.abs(rTurnover.value! - 0.25) < 1e-9);
const sTurnoverMc0: Point[] = mk('2025-01-10', [0]);
checkInvariant(turnover(sTurnoverVol, sTurnoverMc0, '2025-01-10'), 'turnover marketCap=0 -> unavailable');
const sTurnoverMissing: Point[] = [{ date: '2025-01-12', value: 10 }];
checkInvariant(turnover(sTurnoverVol, sTurnoverMissing, '2025-01-10'), 'turnover data ausente -> insufficient_history');

// 6. pairRatio: A=150, B=50 → 3. B=0 → 'unavailable'.
const sPairA: Point[] = mk('2025-01-10', [150]);
const sPairB: Point[] = mk('2025-01-10', [50]);
const rPair = pairRatio(sPairA, sPairB, '2025-01-10');
check('pairRatio valor', Math.abs(rPair.value! - 3) < 1e-9);
const sPairB0: Point[] = mk('2025-01-10', [0]);
checkInvariant(pairRatio(sPairA, sPairB0, '2025-01-10'), 'pairRatio B=0 -> unavailable');

// 7. pairRatioReturn: A tem 2025-01-03=100 e 2025-01-10=120; B tem 2025-01-03=50 e 2025-01-10=50; asOf '2025-01-10', n=7 → esperado 0.2
const sPR_A: Point[] = [
  { date: '2025-01-03', value: 100 },
  { date: '2025-01-10', value: 120 },
];
const sPR_B: Point[] = [
  { date: '2025-01-03', value: 50 },
  { date: '2025-01-10', value: 50 },
];
const rPairReturn = pairRatioReturn(sPR_A, sPR_B, '2025-01-10', 7);
check('pairRatioReturn valor', Math.abs(rPairReturn.value! - 0.2) < 1e-9);

// 8. lastCommonDate: A com datas 01-01,01-02,01-03 e B com 01-02,01-03,01-04 → '2025-01-03'. Sem datas em comum → null.
const sLC_A: Point[] = [
  { date: '2025-01-01', value: 1 },
  { date: '2025-01-02', value: 1 },
  { date: '2025-01-03', value: 1 },
];
const sLC_B: Point[] = [
  { date: '2025-01-02', value: 1 },
  { date: '2025-01-03', value: 1 },
  { date: '2025-01-04', value: 1 },
];
const rLastCommon = lastCommonDate(sLC_A, sLC_B);
check('lastCommonDate', rLastCommon === '2025-01-03');
const sLC_NoCommon: Point[] = [
  { date: '2025-01-01', value: 1 },
];
const rLastCommonNull = lastCommonDate(sLC_NoCommon, sLC_B);
check('lastCommonDate null', rLastCommonNull === null);

// 9. crossRatio: numerador 10, denominador 4 → 2.5. Denominador 0 → 'unavailable'.
const sCR: Point[] = mk('2025-01-10', [10]);
const sCD: Point[] = mk('2025-01-10', [4]);
const rCross = crossRatio(sCR, sCD, '2025-01-10');
check('crossRatio valor', Math.abs(rCross.value! - 2.5) < 1e-9);
const sCD0: Point[] = mk('2025-01-10', [0]);
checkInvariant(crossRatio(sCR, sCD0, '2025-01-10'), 'crossRatio denominador 0 -> unavailable');

// 10. realizedVolatility: série mk('2025-01-01',[100,110,100,110,100]), asOf '2025-01-05', n=4, annualize=false → esperado Math.log(1.1)*Math.sqrt(4/3). Com annualize=true → esse valor * Math.sqrt(365). Com n=10 nessa mesma série → 'insufficient_history'.
const sRV: Point[] = mk('2025-01-01', [100, 110, 100, 110, 100]);
const rRV = realizedVolatility(sRV, '2025-01-05', 4, false);
check('realizedVolatility valor sem annualize', Math.abs(rRV.value! - Math.log(1.1) * Math.sqrt(4/3)) < 1e-9);
const rRV_ann = realizedVolatility(sRV, '2025-01-05', 4, true);
check('realizedVolatility annualized', Math.abs(rRV_ann.value! - Math.log(1.1) * Math.sqrt(4/3) * Math.sqrt(365)) < 1e-9);
const rRV_n10 = realizedVolatility(sRV, '2025-01-05', 10, false);
check('realizedVolatility insufficient n=10', rRV_n10.status === 'insufficient_history');

// 11. Série S = mk('2025-01-01',[100,120,90,110,108]), asOf '2025-01-05':
// - drawdownFromMax(S,asOf,5) → 108/120 - 1
// - maxDrawdown(S,asOf,5) → 90/120 - 1
// - distanceToSma(S,asOf,5) → 108/105.6 - 1
// - rangePosition(S,asOf,5) → 0.6
// - rangePosition de série constante → 'unavailable'
const sSD: Point[] = mk('2025-01-01', [100, 120, 90, 110, 108]);
const rDD = drawdownFromMax(sSD, '2025-01-05', 5);
check('drawdownFromMax valor', Math.abs(rDD.value! - (108/120 - 1)) < 1e-9);
const rMD = maxDrawdown(sSD, '2025-01-05', 5);
check('maxDrawdown valor', Math.abs(rMD.value! - (90/120 - 1)) < 1e-9);
const rDT = distanceToSma(sSD, '2025-01-05', 5);
check('distanceToSma valor', Math.abs(rDT.value! - (108/105.6 - 1)) < 1e-9);
const rRP = rangePosition(sSD, '2025-01-05', 5);
check('rangePosition valor', Math.abs(rRP.value! - 0.6) < 1e-9);
const sConst: Point[] = mk('2025-01-01', [7, 7, 7, 7, 7]);
checkInvariant(rangePosition(sConst, '2025-01-05', 5), 'rangePosition série constante -> unavailable');

// 12. rsiWilder(mk('2025-01-01',[10,11,10,12,11]),'2025-01-05',3,4) → 54.55 (tolerância 0.005). Série só subindo mk('2025-01-01',[1,2,3,4,5]) com period 3, minPoints 4 → 100. Só caindo mk('2025-01-01',[5,4,3,2,1]) → 0. Série constante mk('2025-01-01',[7,7,7,7,7]) → 50.
const sRSI1: Point[] = mk('2025-01-01', [10, 11, 10, 12, 11]);
const rRSI1 = rsiWilder(sRSI1, '2025-01-05', 3, 4);
check('rsiWilder oscilante', Math.abs(rRSI1.value! - 54.55) < 0.005);
const sRSI2: Point[] = mk('2025-01-01', [1, 2, 3, 4, 5]);
const rRSI2 = rsiWilder(sRSI2, '2025-01-05', 3, 4);
check('rsiWilder só subindo', rRSI2.value === 100);
const sRSI3: Point[] = mk('2025-01-01', [5, 4, 3, 2, 1]);
const rRSI3 = rsiWilder(sRSI3, '2025-01-05', 3, 4);
check('rsiWilder só caindo', rRSI3.value === 0);
const sRSI4: Point[] = mk('2025-01-01', [7, 7, 7, 7, 7]);
const rRSI4 = rsiWilder(sRSI4, '2025-01-05', 3, 4);
check('rsiWilder constante', rRSI4.value === 50);

// 13. beta: B=mk('2025-01-01',[100,110,100,110,100,110]), A = cada valor de B ao quadrado; beta(A,B,'2025-01-06',5) → 2. Beta com B constante → 'unavailable'.
const sB: Point[] = mk('2025-01-01', [100, 110, 100, 110, 100, 110]);
// A = B ao quadrado elemento a elemento
const sBq: Point[] = mk('2025-01-01', [10000, 12100, 10000, 12100, 10000, 12100]);
const rBeta = beta(sBq, sB, '2025-01-06', 5);
check('beta valor', Math.abs(rBeta.value! - 2) < 1e-9);
const sBcon: Point[] = mk('2025-01-01', [50, 50, 50, 50, 50, 50]);
checkInvariant(beta(sBcon, sBcon, '2025-01-06', 5), 'beta B constante -> unavailable');

// 13. correlation negativa: B igual ao item 13 e A = 1/valor de B; correlation(A,B,'2025-01-06',5) → -1.
const sA_neg: Point[] = mk('2025-01-01', [1/100, 1/110, 1/100, 1/110, 1/100, 1/110]);
const rCorrNeg = correlation(sA_neg, sB, '2025-01-06', 5);
check('correlation negativa', Math.abs(rCorrNeg.value! - (-1)) < 1e-9);

// 15. PERMANENTLY_UNAVAILABLE[0].indicator === 'atr' e status === 'unavailable'.
check('PERMANENTLY_UNAVAILABLE', PERMANENTLY_UNAVAILABLE[0].indicator === 'atr');
check('PERMANENTLY_UNAVAILABLE status', PERMANENTLY_UNAVAILABLE[0].status === 'unavailable');

// T1: rsiWilder com sequência irregular (data 01-03 ausente)
const sT1: Point[] = [
  { date: '2025-01-01', value: 50 },
  { date: '2025-01-02', value: 40 },
  { date: '2025-01-04', value: 10 },
  { date: '2025-01-05', value: 11 },
  { date: '2025-01-06', value: 10 },
  { date: '2025-01-07', value: 12 },
  { date: '2025-01-08', value: 11 },
];
const rT1 = rsiWilder(sT1, '2025-01-08', 3, 4);
check('rsiWilder irregular', Math.abs(rT1.value! - 54.5454) < 0.005);

// T2: beta com serie B com poucos pontos (apenas 3 consecutivos, need max(3, ceil(0.8*5))=4 retornos)
const sB_t2: Point[] = mk('2025-01-01', [100, 110, 110]); // 3 pts: 01-01 a 01-03
const sA_t2: Point[] = mk('2025-01-01', [100, 110, 100, 110, 100, 110]); // 6 pts: 01-01 a 01-06
const rT2 = beta(sA_t2, sB_t2, '2025-01-06', 5);
check('beta ponto faltando', rT2.status === 'insufficient_history');

// T3: correlation com mesma situacao
const rT3 = correlation(sA_t2, sB_t2, '2025-01-06', 5);
check('correlation ponto faltando', rT3.status === 'insufficient_history');


// T1: correlation com apenas 1 data em comum (A: 01-01 e 01-02; B: 01-02 e 01-03)
const sA_T1: Point[] = mk('2025-01-01', [100, 110]); // 2025-01-01 e 01-02
const sB_T1: Point[] = mk('2025-01-02', [50, 55]); // 2025-01-02 e 01-03
const rCorr_T1 = correlation(sA_T1, sB_T1, '2025-01-03', 2);
check('correlation 1 data comum', rCorr_T1.status === 'insufficient_history' && rCorr_T1.value === null);

// T1: zScore série diária com 5 pontos, n=30 -> insuficiente por cobertura
const sZ1: Point[] = mk('2025-01-26', [1, 2, 3, 4, 5]); // 5 pontos: 01-26 a 01-30
const rZ1 = zScore(sZ1, '2025-01-30', 30);
check('zScore cobertura insuficiente', rZ1.status === 'insufficient_history' && rZ1.value === null);

// T2: zScore com n=1 -> insuficiente (exige n >= 2)
const sZ2: Point[] = mk('2025-01-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const rZ2 = zScore(sZ2, '2025-01-10', 1);
check('zScore n=1', rZ2.status === 'insufficient_history' && rZ2.value === null);

// T3: meanRatio shortN=11 > longN=10 -> insuficiente
const sZ3: Point[] = mk('2025-01-01', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
const rZ3 = meanRatio(sZ3, '2025-01-10', 11, 10);
check('meanRatio shortN>longN', rZ3.status === 'insufficient_history' && rZ3.value === null);

// T4: meanRatio shortN=0 -> insuficiente
const rZ4 = meanRatio(sZ3, '2025-01-10', 0, 10);
check('meanRatio shortN=0', rZ4.status === 'insufficient_history' && rZ4.value === null);

const rBeta_T2 = beta(sA_T1, sB_T1, "2025-01-03", 2);
check("beta 1 data comum", rBeta_T2.status === "insufficient_history" && rBeta_T2.value === null);
// === NOVOS TESTES AQUI ===
console.log('RESULTADO: ' + (total - failures) + ' passaram, ' + failures + ' falharam');
if (failures > 0) process.exit(1);
