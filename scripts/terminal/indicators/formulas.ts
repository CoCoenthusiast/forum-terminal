export type Point = { date: string; value: number };
export type IndicatorResult = {
  status: 'ok' | 'insufficient_history' | 'unavailable';
  value: number | null;
  unit: 'FRACTION' | 'RATIO' | 'ZSCORE' | 'INDEX';
  inputCount: number;
  from: string | null;
  to: string | null;
  reason: string | null;
  indicator?: string;
};
export const MIN_COVERAGE = 0.8;

export function okResult(value: number, unit: 'FRACTION' | 'RATIO' | 'ZSCORE' | 'INDEX', inputCount: number, from: string | null, to: string | null): IndicatorResult {
  return {
    status: 'ok',
    value,
    unit,
    inputCount,
    from,
    to,
    reason: null,
    indicator: undefined,
  };
}

export function insufficientResult(unit: 'FRACTION' | 'RATIO' | 'ZSCORE' | 'INDEX', reason: string, inputCount: number, from: string | null, to: string | null): IndicatorResult {
  return {
    status: 'insufficient_history',
    value: null,
    unit,
    inputCount,
    from,
    to,
    reason,
    indicator: undefined,
  };
}

export function unavailableResult(unit: 'FRACTION' | 'RATIO' | 'ZSCORE' | 'INDEX', reason: string, inputCount: number, from: string | null, to: string | null): IndicatorResult {
  return {
    status: 'unavailable',
    value: null,
    unit,
    inputCount,
    from,
    to,
    reason,
    indicator: undefined,
  };
}

export function validateSeries(series: Point[]): void {
  if (series.length === 0) {
    throw new Error('série vazia');
  }
  for (let i = 1; i < series.length; i++) {
    if (series[i].date <= series[i - 1].date) {
      throw new Error('série fora de ordem crescente ou data repetida em ' + series[i].date);
    }
  }
  for (const p of series) {
    if (p.value === null || !Number.isFinite(p.value)) {
      throw new Error('value não finito em ' + p.date);
    }
    if (!isValidDate(p.date)) {
      throw new Error('data inválida em ' + p.date);
    }
  }
}

function isValidDate(dateStr: string): boolean {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const [, year, month, day] = match;
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() + 1 === m &&
    date.getUTCDate() === d
  );
}

export function addDays(dateStr: string, n: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + n));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildMap(series: Point[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of series) {
    m.set(p.date, p.value);
  }
  return m;
}

export function simpleReturn(series: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(series);
  const targetDate = addDays(asOf, -n);
  const pBefore = series.find(p => p.date === targetDate);

  if (!pBefore || !series.find(p => p.date === asOf)) {
    return insufficientResult('FRACTION', `dados insuficientes para simpleReturn`, 0, asOf, null);
  }

  const pBeforeVal = pBefore.value;
  if (pBeforeVal <= 0) {
    return unavailableResult('FRACTION', `valor não positivo em ${targetDate}`, 0, targetDate, null);
  }

  const pAsOf = series.find(p => p.date === asOf)!;
  const result = pAsOf.value / pBeforeVal - 1;
  return okResult(result, 'FRACTION', 2, targetDate, asOf);
}

export function levelChange(series: Point[], asOf: string, n: number): IndicatorResult {
  return simpleReturn(series, asOf, n);
}

export function turnover(volumeSeries: Point[], marketCapSeries: Point[], asOf: string): IndicatorResult {
  validateSeries(volumeSeries);
  validateSeries(marketCapSeries);
  const vol = volumeSeries.find(p => p.date === asOf);
  const mcap = marketCapSeries.find(p => p.date === asOf);

  if (!vol || !mcap) {
    const missing = !vol ? asOf : (mcap ? null : asOf);
    return insufficientResult('RATIO', `dados insuficientes para ${missing || 'ambos'}`, 0, missing || asOf, null);
  }

  if (vol.value < 0) {
    return unavailableResult('RATIO', `valor não positivo em ${asOf}`, 0, asOf, null);
  }
  if (mcap.value <= 0) {
    return unavailableResult('RATIO', `valor não positivo em ${asOf}`, 0, asOf, null);
  }

  const result = vol.value / mcap.value;
  return okResult(result, 'RATIO', 2, null, null);
}

export function pairRatio(seriesA: Point[], seriesB: Point[], asOf: string): IndicatorResult {
  const a = seriesA.find(p => p.date === asOf);
  const b = seriesB.find(p => p.date === asOf);

  if (!a || !b) {
    const missing = !a ? asOf : (b ? null : asOf);
    return insufficientResult('RATIO', `dados insuficientes para ${missing || 'ambos'}`, 0, missing || asOf, null);
  }

  if (a.value <= 0) {
    return unavailableResult('RATIO', `valor não positivo em ${asOf}`, 0, asOf, null);
  }
  if (b.value <= 0) {
    return unavailableResult('RATIO', `valor não positivo em ${asOf}`, 0, asOf, null);
  }

  const result = a.value / b.value;
  return okResult(result, 'RATIO', 2, null, null);
}

export function pairRatioReturn(seriesA: Point[], seriesB: Point[], asOf: string, n: number): IndicatorResult {
  const pAsOfA = seriesA.find(p => p.date === asOf);
  const pAsOfB = seriesB.find(p => p.date === asOf);
  const targetDate = addDays(asOf, -n);
  const pBeforeA = seriesA.find(p => p.date === targetDate);
  const pBeforeB = seriesB.find(p => p.date === targetDate);

  if (!pAsOfA || !pAsOfB || !pBeforeA || !pBeforeB) {
    const missing = !pAsOfA ? asOf : (!pAsOfB ? asOf : (!pBeforeA ? targetDate : targetDate));
    return insufficientResult('FRACTION', `dados insuficientes para ${missing}`, 0, missing, null);
  }

  const pBeforeAVal = pBeforeA.value;
  const pBeforeBVal = pBeforeB.value;

  if (pBeforeAVal <= 0 || pBeforeBVal <= 0) {
    return unavailableResult('FRACTION', `valor não positivo em ${targetDate}`, 0, targetDate, null);
  }

  const ratioAsOf = pAsOfA.value / pAsOfB.value;
  const ratioBefore = pBeforeAVal / pBeforeBVal;
  const result = ratioAsOf / ratioBefore - 1;
  return okResult(result, 'FRACTION', 4, targetDate, asOf);
}

export function lastCommonDate(seriesA: Point[], seriesB: Point[]): string | null {
  const _mapB = buildMap(seriesB);
  let lastCommon: string | null = null;
  for (const p of seriesA) {
    if (buildMap(seriesB).has(p.date)) {
      lastCommon = p.date;
    }
  }
  return lastCommon;
}

export function crossRatio(numeratorSeries: Point[], denominatorSeries: Point[], asOf: string): IndicatorResult {
  const num = numeratorSeries.find(p => p.date === asOf);
  const den = denominatorSeries.find(p => p.date === asOf);

  if (!num || !den) {
    const missing = !num ? asOf : (den ? null : asOf);
    return insufficientResult('RATIO', `dados insuficientes para ${missing || 'ambos'}`, 0, missing || asOf, null);
  }

  if (num.value < 0) {
    return unavailableResult('RATIO', `valor não positivo em ${asOf}`, 0, asOf, null);
  }
  if (den.value <= 0) {
    return unavailableResult('RATIO', `valor não positivo em ${asOf}`, 0, asOf, null);
  }

  const result = num.value / den.value;
  return okResult(result, 'RATIO', 2, null, null);
}

export function realizedVolatility(series: Point[], asOf: string, n: number, annualize: boolean): IndicatorResult {
  validateSeries(series);
  const windowStart = addDays(asOf, -n);

  let validLogs: number[] = [];

  for (let i = 0; i < series.length - 1; i++) {
    const p1 = series[i];
    const p2 = series[i + 1];
    const d1 = p1.date;
    const d2 = p2.date;

    if (d2 <= asOf && d1 >= windowStart) {
      if (p1.value > 0 && p2.value > 0) {
        const lr = Math.log(p2.value / p1.value);
        validLogs.push(lr);
      }
    }
  }

  if (validLogs.length < n) {
    return insufficientResult('FRACTION', `dados insuficientes para realizedVolatility`, 0, asOf, null);
  }

  const logs = validLogs.slice(0, n);

  const mean = logs.reduce((sum, val) => sum + val, 0) / n;
  let sumSq = 0;
  for (const val of logs) {
    sumSq += (val - mean) ** 2;
  }
  const stdDev = Math.sqrt(sumSq / (n - 1));

  const result = annualize ? stdDev * Math.sqrt(365) : stdDev;

  return okResult(result, 'FRACTION', n, windowStart, asOf);
}

export function drawdownFromMax(series: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(series);
  const windowStart = addDays(asOf, 1 - n);

  let maxPrice: number | null = null;
  let pAsOfVal: number | null = null;
  let validDays = 0;
  let totalDays = 0;

  for (const p of series) {
    if (p.date > asOf || p.date < windowStart) continue;
    totalDays++;
    if (p.value > 0) {
      if (maxPrice === null || p.value > maxPrice) {
        maxPrice = p.value;
      }
      if (p.date === asOf) {
        pAsOfVal = p.value;
      }
      validDays++;
    }
  }

  if (pAsOfVal === null || maxPrice === null || validDays < 1) {
    return insufficientResult('FRACTION', `dados insuficientes para drawdownFromMax`, 0, asOf, null);
  }

  if (validDays < 1) {
    return insufficientResult('FRACTION', `cobertura insuficiente para drawdownFromMax`, 0, asOf, null);
  }

  const coverage = validDays / totalDays;
  if (coverage < MIN_COVERAGE) {
    return insufficientResult('FRACTION', `cobertura insuficiente para drawdownFromMax`, 0, asOf, null);
  }

  const dd = pAsOfVal / maxPrice - 1;
  return okResult(dd, 'FRACTION', 2, windowStart, asOf);
}

export function maxDrawdown(series: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(series);
  const windowStart = addDays(asOf, 1 - n);

  let minDrawdown: number | null = null;
  let maxPriceSoFar: number | null = null;
  let validDays = 0;
  let totalDays = 0;

  const windowSeries: Point[] = [];
  for (const p of series) {
    if (p.date > asOf || p.date < windowStart) continue;
    windowSeries.push(p);
  }
  windowSeries.sort((a, b) => a.date.localeCompare(b.date));

  for (const p of windowSeries) {
    totalDays++;
    if (p.value > 0) {
      if (maxPriceSoFar === null || p.value > maxPriceSoFar) {
        maxPriceSoFar = p.value;
      }
      const dd = p.value / maxPriceSoFar - 1;
      if (minDrawdown === null || dd < minDrawdown) {
        minDrawdown = dd;
      }
      validDays++;
    }
  }

  if (minDrawdown === null) {
    return insufficientResult('FRACTION', `dados insuficientes para maxDrawdown`, 0, asOf, null);
  }

  const coverage = validDays / totalDays;
  if (coverage < MIN_COVERAGE) {
    return insufficientResult('FRACTION', `cobertura insuficiente para maxDrawdown`, 0, asOf, null);
  }

  return okResult(minDrawdown, 'FRACTION', 2, windowStart, asOf);
}

export function distanceToSma(series: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(series);
  const windowStart = addDays(asOf, 1 - n);

  const pAsOf = series.find(p => p.date === asOf);
  if (!pAsOf) {
    return insufficientResult('FRACTION', `P(asOf) nao encontrado em ${asOf}`, 0, asOf, null);
  }

  const windowValues: number[] = [];
  let totalDaysInWindow = 0;
  for (const p of series) {
    if (p.date > asOf || p.date < windowStart) continue;
    totalDaysInWindow++;
    if (Number.isFinite(p.value) && p.value !== null) windowValues.push(p.value);
  }

  if (windowValues.length === 0 || totalDaysInWindow === 0) {
    return insufficientResult('FRACTION', `dados insuficientes para distanceToSma`, 0, asOf, null);
  }

  const coverage = windowValues.length / totalDaysInWindow;
  if (coverage < MIN_COVERAGE) {
    return insufficientResult('FRACTION', `cobertura insuficiente`, 0, asOf, null);
  }

  const smaVal = windowValues.reduce((a, b) => a + b, 0) / windowValues.length;
  const result = pAsOf.value / smaVal - 1;

  return okResult(result, 'FRACTION', windowValues.length, windowStart, asOf);
}

export function rangePosition(series: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(series);
  const windowStart = addDays(asOf, -n);

  const pAsOf = series.find(p => p.date === asOf);
  if (!pAsOf) {
    return insufficientResult('RATIO', `P(asOf) nao encontrado`, 0, asOf, null);
  }

  const windowValues: number[] = [];
  for (const p of series) {
    if (p.date > asOf || p.date < windowStart) continue;
    windowValues.push(p.value);
  }

  if (windowValues.length < 2) {
    return insufficientResult('RATIO', `dados insuficientes para rangePosition`, 0, asOf, null);
  }

  const minVal = Math.min(...windowValues);
  const maxVal = Math.max(...windowValues);

  if (minVal === maxVal) {
    return unavailableResult('RATIO', `range zero em ${asOf}`, 0, asOf, null);
  }

  const result = (pAsOf.value - minVal) / (maxVal - minVal);
  const clamped = Math.max(0, Math.min(1, result));
  return okResult(clamped, 'RATIO', windowValues.length, windowStart, asOf);
}

export function rsiWilder(series: Point[], asOf: string, period = 14, minPoints = 100): IndicatorResult {
  validateSeries(series);

  // Step b: Build consecutive calendar-day sequence ending at asOf (oldest first)
  let sequence: Point[] = [];
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    if (p.date > asOf) continue;
    if (sequence.length === 0) {
      sequence.push(p);
    } else {
      const lastDate = sequence[sequence.length - 1].date;
      const expectedPrev = addDays(lastDate, 1);
      if (p.date === expectedPrev) {
        sequence.push(p);
      } else {
        // Nao consecutivo: descarta sequencia acumulada e recomeça
        sequence = [p];
      }
    }
  }

  // Check if sequence ends at asOf
  if (sequence.length === 0 || sequence[sequence.length - 1].date !== asOf) {
    return insufficientResult('INDEX', `nenhuma sequencia termina em ${asOf}`, 0, asOf, null);
  }

  // Step c: Check minimum points
  const effectiveMinPoints = minPoints < period + 1 ? period + 1 : minPoints;
  if (sequence.length < effectiveMinPoints) {
    return insufficientResult('FRACTION', `sequencia de ${sequence.length} pontos, minimo ${effectiveMinPoints}`, 0, asOf, null);
  }

  // We need at least period+1 points for period variations
  if (sequence.length < period + 1) {
    return insufficientResult('FRACTION', `necessario pelo menos ${period + 1} precos para ${period} variacoes`, 0, asOf, null);
  }

  // Step d: Calculate variations d[i] = value[i+1] - value[i] in chronological order
  const variations: number[] = [];
  for (let i = 0; i < sequence.length - 1; i++) {
    const variation = sequence[i + 1].value - sequence[i].value;
    variations.push(variation);
  }

  // Step e: Semente - média dos primeiros 'period' ganhos e perdas
  const seedGainCount = Math.min(period, variations.length);
  const seedLossCount = Math.min(period, variations.length);
  let seedGainSum = 0;
  let seedLossSum = 0;
  
  for (let i = 0; i < seedGainCount; i++) {
    if (variations[i] > 0) {
      seedGainSum += variations[i];
    } else {
      seedLossSum += Math.abs(variations[i]);
    }
  }
  const avgGain = seedGainCount > 0 ? seedGainSum / period : 0;
  const avgLoss = seedLossCount > 0 ? seedLossSum / period : 0;

  // Step f: For each subsequent variation
  let currentAvgGain = avgGain;
  let currentAvgLoss = avgLoss;
  
  for (let i = period; i < variations.length; i++) {
    const gain = variations[i] > 0 ? variations[i] : 0;
    const loss = variations[i] > 0 ? 0 : Math.abs(variations[i]);
    currentAvgGain = (currentAvgGain * (period - 1) + gain) / period;
    currentAvgLoss = (currentAvgLoss * (period - 1) + loss) / period;
  }

  // Step g: Calculate RSI
  let rsi;
  if (currentAvgGain + currentAvgLoss === 0) {
    rsi = 50;
  } else if (currentAvgLoss === 0) {
    rsi = 100;
  } else {
    rsi = 100 - 100 / (1 + currentAvgGain / currentAvgLoss);
  }
  // No rounding per specification

  // Step h: okResult(value, 'INDEX', sequence length, first date, asOf)
  const firstDate = sequence[0].date;
  return okResult(rsi, 'INDEX', sequence.length, firstDate, asOf);
}

export const PERMANENTLY_UNAVAILABLE: IndicatorResult[] = [
  {
    status: 'unavailable',
    value: null,
    unit: 'RATIO' as const,
    inputCount: 0,
    from: null,
    to: null,
    reason: 'sem OHLC, somente fechamentos',
    indicator: 'atr',
  },
];

// correlation - pairs returns by date (Map), not by array index
export function correlation(seriesA: Point[], seriesB: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(seriesA);
  validateSeries(seriesB);
  const windowStart = addDays(asOf, -n);

  // Collect price data in window by date
  const pricesA: Map<string, number> = new Map();
  const pricesB: Map<string, number> = new Map();

  for (let i = 0; i < seriesA.length; i++) {
    const p = seriesA[i];
    if (p.date >= windowStart && p.date <= asOf) {
      pricesA.set(p.date, p.value);
    }
  }
  for (let i = 0; i < seriesB.length; i++) {
    const p = seriesB[i];
    if (p.date >= windowStart && p.date <= asOf) {
      pricesB.set(p.date, p.value);
    }
  }

  // Find common dates
  const commonDates: string[] = [];
  for (const [date, val] of pricesA) {
    if (pricesB.has(date)) {
      commonDates.push(date);
    }
  }

  if (commonDates.length === 0) {
    return insufficientResult('RATIO', 'nenhum ponto comum', 0, asOf, null);
  }

  if (commonDates.length < 2) {
    return insufficientResult('RATIO', 'dados insuficientes para correlation', 0, asOf, null);
  }

  // Calculate log returns for both series (only between consecutive dates)
  const sortedDates = [...commonDates].sort();

  const returnsA: number[] = [];
  const returnsB: number[] = [];

  for (let i = 1; i < sortedDates.length; i++) {
    const d1 = sortedDates[i - 1];
    const d2 = sortedDates[i];

    // Only count returns between consecutive dates: d2 === addDays(d1, 1)
    const isConsecutive = d2 === addDays(d1, 1);

    const vA1 = pricesA.get(d1);
    const vA2 = pricesA.get(d2);
    const vB1 = pricesB.get(d1);
    const vB2 = pricesB.get(d2);

    if (isConsecutive &&
        vA1 !== undefined && vA2 !== undefined && vB1 !== undefined && vB2 !== undefined &&
        vA1 > 0 && vA2 > 0 && vB1 > 0 && vB2 > 0) {
      const rA = Math.log(vA2 / vA1);
      const rB = Math.log(vB2 / vB1);
      returnsA.push(rA);
      returnsB.push(rB);
    }
  }

  const minReturns = Math.max(3, Math.ceil(MIN_COVERAGE * n));
  if (returnsA.length < minReturns) {
    return insufficientResult('RATIO', 'dados insuficientes para correlation', 0, asOf, null);
  }

  // Calculate means
  const sumA = returnsA.reduce((a, b) => a + b, 0);
  const sumB = returnsB.reduce((a, b) => a + b, 0);
  const meanA = sumA / returnsA.length;
  const meanB = sumB / returnsB.length;

  // Calculate covariance and variances
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < returnsA.length; i++) {
    const ra = returnsA[i] - meanA;
    const rb = returnsB[i] - meanB;
    cov += ra * rb;
    varA += ra ** 2;
    varB += rb ** 2;
  }

  const denominator = Math.sqrt(varA * varB);
  if (denominator === 0) {
    // Variance zero -> unavailable
    return unavailableResult('RATIO', 'variancia zero em correlation', 0, asOf, null);
  }

  const r = cov / denominator;
  return okResult(r, 'RATIO', returnsA.length + 1, sortedDates[0], asOf);
}

// beta: beta(A, B, asOf, n) = covariance(A log-returns, B log-returns) / variance(B log-returns)
export function beta(seriesA: Point[], seriesB: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(seriesA);
  validateSeries(seriesB);
  const windowStart = addDays(asOf, -n);

  // Collect price data in window by date
  const pricesA: Map<string, number> = new Map();
  const pricesB: Map<string, number> = new Map();

  for (let i = 0; i < seriesA.length; i++) {
    const p = seriesA[i];
    if (p.date >= windowStart && p.date <= asOf) {
      pricesA.set(p.date, p.value);
    }
  }
  for (let i = 0; i < seriesB.length; i++) {
    const p = seriesB[i];
    if (p.date >= windowStart && p.date <= asOf) {
      pricesB.set(p.date, p.value);
    }
  }

  // Find common dates
  const commonDates: string[] = [];
  for (const [date, val] of pricesA) {
    if (pricesB.has(date)) {
      commonDates.push(date);
    }
  }

  if (commonDates.length === 0) {
    return insufficientResult('RATIO', 'nenhum ponto comum', 0, asOf, null);
  }

  if (commonDates.length < 2) {
    return insufficientResult('RATIO', 'dados insuficientes para beta', 0, asOf, null);
  }

  // Calculate log returns for both series (only between consecutive dates)
  const sortedDates = [...commonDates].sort();

  const returnsA: number[] = [];
  const returnsB: number[] = [];

  for (let i = 1; i < sortedDates.length; i++) {
    const d1 = sortedDates[i - 1];
    const d2 = sortedDates[i];

    // Only count returns between consecutive dates: d2 === addDays(d1, 1)
    const isConsecutive = d2 === addDays(d1, 1);

    const vA1 = pricesA.get(d1);
    const vA2 = pricesA.get(d2);
    const vB1 = pricesB.get(d1);
    const vB2 = pricesB.get(d2);

    if (isConsecutive &&
        vA1 !== undefined && vA2 !== undefined && vB1 !== undefined && vB2 !== undefined &&
        vA1 > 0 && vA2 > 0 && vB1 > 0 && vB2 > 0) {
      const rA = Math.log(vA2 / vA1);
      const rB = Math.log(vB2 / vB1);
      returnsA.push(rA);
      returnsB.push(rB);
    }
  }

  const minReturns = Math.max(3, Math.ceil(MIN_COVERAGE * n));
  if (returnsA.length < minReturns) {
    return insufficientResult('RATIO', 'dados insuficientes para beta', 0, asOf, null);
  }

  // Calculate means
  const sumA = returnsA.reduce((a, b) => a + b, 0);
  const sumB = returnsB.reduce((a, b) => a + b, 0);
  const meanA = sumA / returnsA.length;
  const meanB = sumB / returnsB.length;

  // Calculate covariance of A and variance of B
  let covAB = 0;
  let varB = 0;
  for (let i = 0; i < returnsA.length; i++) {
    const ra = returnsA[i] - meanA;
    const rb = returnsB[i] - meanB;
    covAB += ra * rb;
    varB += rb ** 2;
  }

  if (varB === 0) {
    // B is constant -> unavailable
    return unavailableResult('RATIO', 'serie B constante', 0, asOf, null);
  }

  const result = covAB / varB;
  return okResult(result, 'RATIO', returnsA.length + 1, sortedDates[0], asOf);
}

// zScore: (value - mean) / stddev over window
export function zScore(series: Point[], asOf: string, n: number): IndicatorResult {
  validateSeries(series);

  if (n < 2) {
    return insufficientResult('ZSCORE', 'n deve ser maior que 1', 0, asOf, null);
  }

  const windowStart = addDays(asOf, 1 - n);

  const windowValues: number[] = [];
  for (const p of series) {
    if (p.date > asOf || p.date < windowStart) continue;
    windowValues.push(p.value);
  }

  if (windowValues.length < Math.ceil(MIN_COVERAGE * n)) {
    return insufficientResult('ZSCORE', 'dados insuficientes para zScore', 0, asOf, null);
  }

  const pAsOf = series.find(p => p.date === asOf);
  if (!pAsOf) {
    return insufficientResult('ZSCORE', 'P(asOf) nao encontrado', 0, asOf, null);
  }

  const mean = windowValues.reduce((a, b) => a + b, 0) / windowValues.length;
  let sumSq = 0;
  for (const v of windowValues) {
    sumSq += (v - mean) ** 2;
  }
  const stddev = Math.sqrt(sumSq / (windowValues.length - 1));

  if (stddev === 0) {
    return unavailableResult('ZSCORE', 'desvio padrao zero', 0, asOf, null);
  }

  const result = (pAsOf.value - mean) / stddev;
  return okResult(result, 'ZSCORE', windowValues.length, windowStart, asOf);
}

// meanRatio: média dos valores do período short sobre média do período long
export function meanRatio(series: Point[], asOf: string, shortN: number, longN: number): IndicatorResult {
  validateSeries(series);

  if (shortN < 1 || shortN > longN) {
    return insufficientResult('RATIO', 'janelas invalidas em meanRatio', 0, asOf, null);
  }

  const windowStart = addDays(asOf, 1 - longN);

  const windowValues: number[] = [];
  for (const p of series) {
    if (p.date > asOf || p.date < windowStart) continue;
    windowValues.push(p.value);
  }

  if (windowValues.length < longN) {
    return insufficientResult('RATIO', 'dados insuficientes para meanRatio', 0, asOf, null);
  }

  // Take last 'longN' values in chronological order
  const longWindow = windowValues.slice(-longN);

  // shortN últimos valores dentro do window long
  const shortWindow = longWindow.slice(-shortN);

  const meanShort = shortWindow.reduce((a, b) => a + b, 0) / shortN;
  const meanLong = longWindow.reduce((a, b) => a + b, 0) / longN;

  if (meanLong === 0) {
    return unavailableResult('RATIO', 'mean longa zero', 0, asOf, null);
  }

  const result = meanShort / meanLong;
  return okResult(result, 'RATIO', windowValues.length, windowStart, asOf);
}