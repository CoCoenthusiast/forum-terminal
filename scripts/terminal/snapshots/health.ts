import type { PrismaClient } from '../generated/db/client';
import { readFreshnessInput } from '../checks/check-freshness';
import {
  COINALYZE_WARN_DAYS,
  DEX_OK_DAYS,
  DOLLAR_OK_DAYS,
  DOLLAR_WARN_DAYS,
  LAUNCHPAD_MIN_PRESENT,
  LAUNCHPAD_OK_DAYS,
  REAL_YIELD_OK_DAYS,
  REAL_YIELD_WARN_DAYS,
  coinalyzeStatus,
  dailyCloseStatus,
  delayDays,
  dexStatus,
  dollarStatus,
  launchpadStatus,
  previousUtcDay,
  realYieldStatus,
  returnStatus,
  stateStatus,
  worstStatus,
  type FreshnessInput,
  type FreshnessResult,
  type FreshnessStatus,
} from '../checks/freshness-rules';
import {
  BACKFILL_DEX_DAILY_QUARANTINE_DAYS,
  LAUNCHPAD_SLUGS,
} from '../config';

const RETURN_LABELS = ['SOL', 'BTC', 'ETH'] as const;

export type HealthStatus = 'up_to_date' | 'delayed' | 'stale';

export interface HealthItem {
  id: string;
  label: string;
  source: string;
  lastDate: string | null;
  delayDays: number | null;
  status: HealthStatus;
  expectedLag: string;
  present?: number;
  total?: number;
}

export interface HealthSnapshot {
  generatedAt: string;
  asOf: string;
  items: HealthItem[];
}

const STATUS_MAP: Record<FreshnessStatus, HealthStatus> = {
  OK: 'up_to_date',
  WARN: 'delayed',
  FAIL: 'stale',
};

const EXPECTED_LAG = {
  dailyClose: 'Daily close; same-day data expected',
  returns: 'Daily close; same-day data expected',
  state: 'Daily state; same-day data expected',
  coinalyze: `Daily leverage; OK same day, delayed up to ${COINALYZE_WARN_DAYS} days`,
  broadDollar: `Weekly release; OK up to ${DOLLAR_OK_DAYS} days, delayed up to ${DOLLAR_WARN_DAYS} days`,
  realYields: `Daily release; OK up to ${REAL_YIELD_OK_DAYS} days, delayed up to ${REAL_YIELD_WARN_DAYS} days`,
  dexVolume: `${BACKFILL_DEX_DAILY_QUARANTINE_DAYS}-day quarantine on DefiLlama daily volume; OK up to ${DEX_OK_DAYS} days`,
  launchpads: `${BACKFILL_DEX_DAILY_QUARANTINE_DAYS}-day quarantine on DefiLlama daily volume; OK up to ${LAUNCHPAD_OK_DAYS} days; ${LAUNCHPAD_MIN_PRESENT} of ${LAUNCHPAD_SLUGS.length} slugs required`,
} as const;

function isoDay(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

function delayFor(value: Date | null, date: string): number | null {
  return value === null ? null : delayDays(value, date);
}

function item(
  id: string,
  label: string,
  source: string,
  value: Date | null,
  status: FreshnessStatus,
  expectedLag: string,
  date: string,
  extra?: Pick<HealthItem, 'present' | 'total'>
): HealthItem {
  return {
    id,
    label,
    source,
    lastDate: isoDay(value),
    delayDays: delayFor(value, date),
    status: STATUS_MAP[status],
    expectedLag,
    ...extra,
  };
}

function returnDates(
  input: FreshnessInput,
  label: string
): { oneDay: Date | null; sevenDay: Date | null } {
  return {
    oneDay:
      input.returns.find((entry) => entry.item === `Return 1d ${label}`)
        ?.asOf ?? null,
    sevenDay:
      input.returns.find((entry) => entry.item === `Return 7d ${label}`)
        ?.asOf ?? null,
  };
}

function combinedReturnStatus(
  label: string,
  dates: readonly (Date | null)[],
  date: string
): FreshnessStatus {
  const results: FreshnessResult[] = dates.map((value, index) => ({
    item: `${label} ${index}`,
    status: returnStatus(value, date),
    detalhe: '',
  }));
  return worstStatus(results);
}

function combinedReturnDate(dates: readonly (Date | null)[]): Date | null {
  if (dates.some((value) => value === null)) return null;
  const values = dates.filter((value): value is Date => value !== null);
  if (values.length === 0) return null;
  return new Date(Math.min(...values.map((value) => value.getTime())));
}

function launchpadAggregate(
  input: FreshnessInput,
  date: string
): { value: Date | null; status: FreshnessStatus; present: number; total: number } {
  const presentRows = input.launchpads.filter(
    (launchpad) => launchpad.toDate !== null
  );
  const present = presentRows.length;
  const total = input.launchpads.length;
  const oldest =
    presentRows.length === 0
      ? null
      : new Date(
          Math.min(
            ...presentRows.map((launchpad) =>
              (launchpad.toDate as Date).getTime()
            )
          )
        );

  if (present < LAUNCHPAD_MIN_PRESENT) {
    return { value: oldest, status: 'WARN', present, total };
  }

  return {
    value: oldest,
    status: launchpadStatus(oldest, date),
    present,
    total,
  };
}

export function buildHealthPayload(
  input: FreshnessInput,
  generatedAt: Date
): HealthSnapshot {
  const date = input.date;
  const items: HealthItem[] = [
    item(
      'daily_closes',
      'Daily closes',
      'CoinGecko',
      input.dailyCloseDate,
      dailyCloseStatus(input.dailyCloseDate, date),
      EXPECTED_LAG.dailyClose,
      date
    ),
  ];

  for (const label of RETURN_LABELS) {
    const dates = returnDates(input, label);
    const values = [dates.oneDay, dates.sevenDay] as const;
    items.push(
      item(
        `returns_${label.toLowerCase()}`,
        `${label} returns`,
        'CoinGecko',
        combinedReturnDate(values),
        combinedReturnStatus(label, values, date),
        EXPECTED_LAG.returns,
        date
      )
    );
  }

  items.push(
    item(
      'sol_state',
      'SOL state',
      'CoinGecko + DefiLlama',
      input.stateAsOf,
      stateStatus(input.stateAsOf, date),
      EXPECTED_LAG.state,
      date
    )
  );

  items.push(
    item(
      'coinalyze_leverage',
      'Coinalyze leverage',
      'Coinalyze',
      input.coinalyzeAsOf,
      coinalyzeStatus(input.coinalyzeAsOf, date),
      EXPECTED_LAG.coinalyze,
      date
    )
  );

  items.push(
    item(
      'broad_dollar',
      'Broad dollar index',
      'Federal Reserve Board H.10',
      input.dollarToDate,
      dollarStatus(input.dollarToDate, date),
      EXPECTED_LAG.broadDollar,
      date
    )
  );

  items.push(
    item(
      'real_yields',
      'Real yields',
      'U.S. Department of the Treasury',
      input.realYieldToDate,
      realYieldStatus(input.realYieldToDate, date),
      EXPECTED_LAG.realYields,
      date
    )
  );

  items.push(
    item(
      'dex_volume',
      'DEX volume',
      'DefiLlama',
      input.dexToDate,
      dexStatus(input.dexToDate, date),
      EXPECTED_LAG.dexVolume,
      date
    )
  );

  const launchpads = launchpadAggregate(input, date);
  items.push(
    item(
      'launchpads',
      'Launchpads',
      'DefiLlama',
      launchpads.value,
      launchpads.status,
      EXPECTED_LAG.launchpads,
      date,
      { present: launchpads.present, total: launchpads.total }
    )
  );

  return {
    generatedAt: generatedAt.toISOString(),
    asOf: date,
    items,
  };
}

export async function buildHealthSnapshot(
  client: PrismaClient,
  now: Date = new Date()
): Promise<HealthSnapshot> {
  const asOf = previousUtcDay(now);
  const input = await readFreshnessInput(client, asOf, now);
  return buildHealthPayload(input, now);
}
