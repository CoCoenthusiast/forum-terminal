import { Point, addDays } from './formulas';

export interface PriceRow {
  provider: string;
  collectedAt: Date;
  priceUsd: number;
}

export interface MetricRow {
  provider: string;
  collectedAt: Date;
  value: number;
}

export interface Meta {
  fromHistory: number;
  fromLive: number;
  ignored: number;
}

export function priceSeries(rows: PriceRow[], todayUtc: string): { series: Point[]; meta: Meta } {
  const meta: Meta = { fromHistory: 0, fromLive: 0, ignored: 0 };
  const historyDays = new Map<string, number>(); // date -> priceUsd (history wins)
  const liveDays = new Map<string, number>();   // date -> priceUsd (live, última linha válida)

  const sorted = [...rows].sort((a, b) => {
    const aIsHistory = a.provider === 'coingecko_history';
    const bIsHistory = b.provider === 'coingecko_history';
    if (aIsHistory && !bIsHistory) return -1;
    if (!aIsHistory && bIsHistory) return 1;
    return a.collectedAt.getTime() - b.collectedAt.getTime();
  });

  for (const row of sorted) {
    const { provider, collectedAt, priceUsd } = row;

    if (!isFinite(priceUsd) || priceUsd <= 0) {
      meta.ignored++;
      continue;
    }

    const isoCol = collectedAt.toISOString().slice(0, 10);

    if (provider === 'coingecko_history') {
      // Original check: only accept rows exactly at midnight (getTime % 86400000 === 0)
      // Correction 1: also filter by pointDate vs todayUtc
      const midnightCheck = collectedAt.getTime() % 86400000 === 0;
      if (midnightCheck) {
        const dayUTC = collectedAt.toISOString().slice(0, 10);
        const pointDate = addDays(dayUTC, -1);
        if (pointDate >= todayUtc) {
          meta.ignored++;
        } else {
          if (!historyDays.has(pointDate)) {
            historyDays.set(pointDate, priceUsd);
          }
        }
      } else {
        meta.ignored++;
      }
    } else if (provider === 'coingecko') {
      // Correction 1: filtro para live usa o dia UTC do collectedAt
      if (isoCol >= todayUtc) {
        meta.ignored++;
        continue;
      }
      // Always update liveDays for this day (later collectedAt = greater value)
      liveDays.set(isoCol, priceUsd);
      // fromLive será contado no final (dias únicos sem history)
    } else {
      meta.ignored++;
    }
  }

  // Correction 2: contar DIAS no final, não LINHAS durante o loop
  const allDates = new Set([...historyDays.keys(), ...liveDays.keys()]);
  const sortedDates = [...allDates].sort();

  // Contar quantos dias são de history e quantos são de live (sem history)
  let fromHistoryCount = 0;
  let fromLiveCount = 0;
  for (const date of sortedDates) {
    if (historyDays.has(date)) {
      fromHistoryCount++;
    } else if (liveDays.has(date)) {
      fromLiveCount++;
    }
  }

  const points: Point[] = [];
  for (const date of sortedDates) {
    if (historyDays.has(date)) {
      points.push({ date, value: historyDays.get(date)! });
    } else if (liveDays.has(date)) {
      points.push({ date, value: liveDays.get(date)! });
    }
  }

  return { series: points, meta: { fromHistory: fromHistoryCount, fromLive: fromLiveCount, ignored: meta.ignored } };
}

export function metricSeries(
  rows: MetricRow[],
  providers: { history: string; live: string | null },
  todayUtc: string
): { series: Point[]; meta: Meta } {
  const meta: Meta = { fromHistory: 0, fromLive: 0, ignored: 0 };
  const historyDays = new Map<string, number>();
  const liveDays = new Map<string, number>();

  const sorted = [...rows].sort((a, b) => {
    const aIsHistory = a.provider === providers.history;
    const bIsHistory = b.provider === providers.history;
    if (aIsHistory && !bIsHistory) return -1;
    if (!aIsHistory && bIsHistory) return 1;
    return a.collectedAt.getTime() - b.collectedAt.getTime();
  });

  for (const row of sorted) {
    const { provider, collectedAt, value } = row;

    if (!isFinite(value) || value < 0) {
      meta.ignored++;
      continue;
    }

    const iso = collectedAt.toISOString().slice(0, 10);

    if (iso >= todayUtc) {
      meta.ignored++;
      continue;
    }

    if (providers.live !== null && provider === providers.live) {
      // Always update liveDays (later collectedAt = greater value)
      liveDays.set(iso, value);
    } else if (provider === providers.history) {
      // Always update historyDays (first history win)
      if (!historyDays.has(iso)) {
        historyDays.set(iso, value);
      }
    } else {
      meta.ignored++;
    }
  }

  // Correction 2: Atualizar meta no final
  const allDates = new Set([...historyDays.keys(), ...liveDays.keys()]);
  const sortedDates = [...allDates].sort();

  let fromHistoryCount = 0;
  let fromLiveCount = 0;
  for (const date of sortedDates) {
    if (historyDays.has(date)) {
      fromHistoryCount++;
    } else if (liveDays.has(date)) {
      fromLiveCount++;
    }
  }

  const points: Point[] = [];
  for (const date of sortedDates) {
    if (historyDays.has(date)) {
      points.push({ date, value: historyDays.get(date)! });
    } else if (liveDays.has(date)) {
      points.push({ date, value: liveDays.get(date)! });
    }
  }

  return { series: points, meta: { fromHistory: fromHistoryCount, fromLive: fromLiveCount, ignored: meta.ignored } };
}

export function marketFieldSeries(
  rows: { provider: string; collectedAt: Date; value: number | null }[],
  allowZero: boolean,
  todayUtc: string
): { series: Point[]; meta: Meta } {
  const meta: Meta = { fromHistory: 0, fromLive: 0, ignored: 0 };
  const historyDays = new Map<string, number>(); // date -> value (history wins)
  const liveDays = new Map<string, number>();   // date -> value (live, última linha válida)

  const sorted = [...rows].sort((a, b) => {
    const aIsHistory = a.provider === 'coingecko_history';
    const bIsHistory = b.provider === 'coingecko_history';
    if (aIsHistory && !bIsHistory) return -1;
    if (!aIsHistory && bIsHistory) return 1;
    return a.collectedAt.getTime() - b.collectedAt.getTime();
  });

  for (const row of sorted) {
    const { provider, collectedAt, value } = row;

    // Rule 2: value null, não finito, negativo, ou 0 quando allowZero for false
    if (value == null || !isFinite(value) || (value < 0 || (value === 0 && !allowZero))) {
      meta.ignored++;
      continue;
    }

    const isoCol = collectedAt.toISOString().slice(0, 10);

    if (provider === 'coingecko_history') {
      // Rule 3: só se collectedAt.getTime() % 86400000 === 0; senão ignored++
      if (collectedAt.getTime() % 86400000 !== 0) {
        meta.ignored++;
        continue;
      }
      // Data do ponto = addDays(dia UTC do collectedAt, -1)
      const dayUTC = collectedAt.toISOString().slice(0, 10);
      const pointDate = addDays(dayUTC, -1);
      // Rule 6: excluir data >= todayUtc (para o history vale a data do ponto, já deslocada)
      if (pointDate >= todayUtc) {
        meta.ignored++;
        continue;
      }
      if (!historyDays.has(pointDate)) {
        historyDays.set(pointDate, value);
      }
    } else if (provider === 'coingecko') {
      // Rule 4: data = dia UTC do collectedAt; por dia vale a linha de maior collectedAt
      // Rule 6: excluir data >= todayUtc (para o live, o dia do collectedAt)
      if (isoCol >= todayUtc) {
        meta.ignored++;
        continue;
      }
      // Always update liveDays for this day (later collectedAt = greater value)
      liveDays.set(isoCol, value);
    } else {
      // Rule 1: Provider diferente de 'coingecko_history' e 'coingecko' → ignored++
      meta.ignored++;
      continue;
    }
  }

  // Correction: contar DIAS no final
  const allDates = new Set([...historyDays.keys(), ...liveDays.keys()]);
  const sortedDates = [...allDates].sort();

  // Contar quantos dias são de history e quantos são de live (sem history)
  let fromHistoryCount = 0;
  let fromLiveCount = 0;
  for (const date of sortedDates) {
    if (historyDays.has(date)) {
      fromHistoryCount++;
    } else if (liveDays.has(date)) {
      fromLiveCount++;
    }
  }

  const points: Point[] = [];
  for (const date of sortedDates) {
    if (historyDays.has(date)) {
      points.push({ date, value: historyDays.get(date)! });
    } else if (liveDays.has(date)) {
      points.push({ date, value: liveDays.get(date)! });
    }
  }

  return { series: points, meta: { fromHistory: fromHistoryCount, fromLive: fromLiveCount, ignored: meta.ignored } };
}
