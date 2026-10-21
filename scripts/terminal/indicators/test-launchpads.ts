#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { LAUNCHPAD_MIN_POINTS, LAUNCHPAD_SLUGS, LAUNCHPAD_WINDOW_DAYS, buildProtocolScope } from '../config';
import {
  LAUNCHPAD_FORMULA_VERSION,
  LAUNCHPAD_INDICATORS,
  LAUNCHPAD_SERIES_IDS,
  computeLaunchpadIndicatorRows,
} from './launchpads';
import {
  computeIndicatorRows,
  loadAllSeries,
  validateRowInvariants,
  type AsOfDate,
  type IndicatorRow,
  type SeriesMap,
} from './catalog';
import { addDays, type Point } from './formulas';
import type { Reader } from './loaders';

const START = '2025-01-01';

let passed = 0;
let failures = 0;

function check(name: string, ok: boolean, extra = ''): void {
  console.log(`${ok ? 'PASSOU' : 'FALHOU'}: ${name} ${extra}`);
  if (ok) passed++;
  else failures++;
}

function approx(actual: number | null, expected: number, tol = 1e-9): boolean {
  return actual !== null && Math.abs(actual - expected) < tol;
}

// D(n) = enésimo dia do teste, começando em 2025-01-01.
function D(n: number): string {
  return addDays(START, n - 1);
}

function points(values: readonly (number | null)[]): Point[] {
  const out: Point[] = [];
  values.forEach((value, index) => {
    if (value !== null) out.push({ date: D(index + 1), value });
  });
  return out;
}

function asOf(iso: string): AsOfDate {
  return { iso, date: new Date(`${iso}T00:00:00.000Z`) };
}

function value(row: IndicatorRow | undefined): number | null {
  if (!row || row.value === null) return null;
  return Number(row.value.toString());
}

function iso(row: IndicatorRow): string {
  return row.asOf.toISOString().slice(0, 10);
}

function findRow(rows: readonly IndicatorRow[], indicator: string, slug: string, date: string): IndicatorRow | undefined {
  return rows.find((r) => r.indicator === indicator && r.scope === buildProtocolScope(slug) && iso(r) === date);
}

interface Msg {
  provider: string;
  collectedAt: Date;
  value: unknown;
}

function makeReader(byKey: Record<string, Msg[]>): {
  reader: Reader;
  calls: { scope: string; metric: string; providers: string[] }[];
} {
  const calls: { scope: string; metric: string; providers: string[] }[] = [];
  const reader: Reader = {
    async marketSnapshotFindMany() {
      return [];
    },
    async metricSnapshotFindMany({ scope, metric, providers }) {
      calls.push({ scope, metric, providers });
      return (byKey[`${scope}|${metric}`] ?? []).filter((row) => providers.includes(row.provider));
    },
  };
  return { reader, calls };
}

function runPureSection(): void {
  check('cohort tem 4 slugs', LAUNCHPAD_SLUGS.length === 4, `lat=${LAUNCHPAD_SLUGS.length}`);
  check('janela = 7d', LAUNCHPAD_WINDOW_DAYS === 7, `window=${LAUNCHPAD_WINDOW_DAYS}`);
  check('minimo = ceil(0.8*7) = 6', LAUNCHPAD_MIN_POINTS === Math.ceil(0.8 * 7), `min=${LAUNCHPAD_MIN_POINTS}`);
  check('7 indicadores x 4 slugs = 28 defs', LAUNCHPAD_INDICATORS.length === 28, `defs=${LAUNCHPAD_INDICATORS.length}`);
  const scopes = new Set(LAUNCHPAD_INDICATORS.map((d) => d.scope));
  check('defs cobrem exatamente 4 escopos', scopes.size === 4 && LAUNCHPAD_SLUGS.every((s) => scopes.has(buildProtocolScope(s))));
  check('formulaVersion local = v1', LAUNCHPAD_FORMULA_VERSION === 'v1');

  const pumpDex = LAUNCHPAD_SERIES_IDS['pump.fun'].dex;
  const pumpFees = LAUNCHPAD_SERIES_IDS['pump.fun'].fees;

  // 1) dia ausente NUNCA vira zero: 6 pontos de 100 no lugar de 7 (um faltando).
  const missingDayMap: SeriesMap = { [pumpDex]: points([100, 100, 100, 100, null, 100, 100, 100, 100, 100]) };
  const missingRows = computeLaunchpadIndicatorRows(missingDayMap, [asOf(D(10))]);
  const missingVs = findRow(missingRows, 'launchpad_dex_volume_vs_mean_7d', 'pump.fun', D(10));
  check('dia ausente: status ok', missingVs?.status === 'ok', JSON.stringify(missingVs?.status));
  check('dia ausente: value = 0 (média dos 6 reais, não 7 com zero)', approx(value(missingVs), 0), `value=${value(missingVs)}`);
  check('dia ausente: inputCount = 6', missingVs?.inputCount === 6, `inputCount=${missingVs?.inputCount}`);
  check('dia ausente: from = D(4)', missingVs?.fromDate?.toISOString().slice(0, 10) === D(4));

  // 2) cobertura insuficiente (< 6 pontos).
  const shortMap: SeriesMap = { [pumpDex]: points([null, null, null, null, null, null, 100, 100, 100, 100]) };
  const shortRow = findRow(
    computeLaunchpadIndicatorRows(shortMap, [asOf(D(10))]),
    'launchpad_dex_volume_vs_mean_7d',
    'pump.fun',
    D(10)
  );
  check(
    'menos de 6 pontos -> insufficient_history',
    shortRow?.status === 'insufficient_history' && shortRow?.value === null && shortRow?.reason !== null,
    JSON.stringify(shortRow?.status)
  );

  // 3) zero real é válido e não é descartado.
  const realZeroMap: SeriesMap = { [pumpDex]: points([100, 100, 100, 100, 100, 100, 100, 100, 100, 0]) };
  const realZeroRow = findRow(
    computeLaunchpadIndicatorRows(realZeroMap, [asOf(D(10))]),
    'launchpad_dex_volume_vs_mean_7d',
    'pump.fun',
    D(10)
  );
  check('zero real: status ok', realZeroRow?.status === 'ok', JSON.stringify(realZeroRow?.status));
  check('zero real: value = -1', approx(value(realZeroRow), -1), `value=${value(realZeroRow)}`);

  // 4) variação 7d exige os dois pontos exatos; sem carry-forward.
  const changeMap: SeriesMap = { [pumpDex]: points([null, null, 100, null, null, null, null, null, null, 120]) };
  const changeRow = findRow(
    computeLaunchpadIndicatorRows(changeMap, [asOf(D(10))]),
    'launchpad_dex_volume_change_7d',
    'pump.fun',
    D(10)
  );
  check('variação 7d: 120/100-1 = 0.2', changeRow?.status === 'ok' && approx(value(changeRow), 0.2), `value=${value(changeRow)}`);

  const noBaseMap: SeriesMap = { [pumpDex]: points([null, null, null, null, null, null, null, null, 100, 120]) };
  const noBaseRow = findRow(
    computeLaunchpadIndicatorRows(noBaseMap, [asOf(D(10))]),
    'launchpad_dex_volume_change_7d',
    'pump.fun',
    D(10)
  );
  check(
    'variação 7d: sem ponto em t-7 -> insufficient (não usa D(9))',
    noBaseRow?.status === 'insufficient_history' && noBaseRow?.value === null,
    JSON.stringify(noBaseRow?.status)
  );

  // 5) fees/volume normal e com ΣV = 0.
  const ratioMap: SeriesMap = {
    [pumpFees]: points([null, null, null, 30, 30, 30, 30, 30, 30, 30]),
    [pumpDex]: points([null, null, null, 100, 100, 100, 100, 100, 100, 100]),
  };
  const ratioRow = findRow(
    computeLaunchpadIndicatorRows(ratioMap, [asOf(D(10))]),
    'launchpad_fees_to_volume_7d',
    'pump.fun',
    D(10)
  );
  check('fees/volume: 210/700 = 0.3', ratioRow?.status === 'ok' && approx(value(ratioRow), 0.3), `value=${value(ratioRow)}`);

  const zeroVolumeMap: SeriesMap = {
    [pumpFees]: points([null, null, null, 0, 0, 0, 0, 0, 0, 0]),
    [pumpDex]: points([null, null, null, 0, 0, 0, 0, 0, 0, 0]),
  };
  const zeroVolumeRow = findRow(
    computeLaunchpadIndicatorRows(zeroVolumeMap, [asOf(D(10))]),
    'launchpad_fees_to_volume_7d',
    'pump.fun',
    D(10)
  );
  check(
    'fees/volume: ΣV=0 -> unavailable',
    zeroVolumeRow?.status === 'unavailable' && zeroVolumeRow?.value === null && zeroVolumeRow?.reason !== null,
    JSON.stringify(zeroVolumeRow?.status)
  );

  // 6) share entre os 4 slugs soma 1; interseção descarta o dia que falta em 1 slug.
  const shareMap: SeriesMap = {};
  LAUNCHPAD_SLUGS.forEach((slug, index) => {
    const values: (number | null)[] = [null, null, null, 10, 10, 10, slug === 'launchlab' ? null : 10, 10, 10, 10];
    shareMap[LAUNCHPAD_SERIES_IDS[slug].dex] = points(values.map((v) => (v === null ? null : v * (index + 1))));
  });
  const shareRows = computeLaunchpadIndicatorRows(shareMap, [asOf(D(10))]);
  const shares = LAUNCHPAD_SLUGS.map((slug) =>
    findRow(shareRows, 'launchpad_dex_volume_share_7d', slug, D(10))
  );
  check('share: 4 linhas ok', shares.every((r) => r?.status === 'ok'), JSON.stringify(shares.map((r) => r?.status)));
  check(
    'share: 0.1/0.2/0.3/0.4',
    approx(value(shares[0]), 0.1) && approx(value(shares[1]), 0.2) && approx(value(shares[2]), 0.3) && approx(value(shares[3]), 0.4),
    shares.map((r) => value(r)).join(',')
  );
  check('share: soma = 1', approx(shares.reduce((acc, r) => acc + (value(r) ?? 0), 0), 1));
  check('share: interseção = 6 datas (dia de launchlab ausente sai para todos)', shares[0]?.inputCount === 6, `inputCount=${shares[0]?.inputCount}`);

  const zeroTotalMap: SeriesMap = {};
  LAUNCHPAD_SLUGS.forEach((slug) => {
    zeroTotalMap[LAUNCHPAD_SERIES_IDS[slug].dex] = points([null, null, null, 0, 0, 0, 0, 0, 0, 0]);
  });
  const zeroTotalRow = findRow(
    computeLaunchpadIndicatorRows(zeroTotalMap, [asOf(D(10))]),
    'launchpad_dex_volume_share_7d',
    'pump.fun',
    D(10)
  );
  check(
    'share: total dos 4 = 0 -> unavailable',
    zeroTotalRow?.status === 'unavailable' && zeroTotalRow?.value === null,
    JSON.stringify(zeroTotalRow?.status)
  );

  // 7) asOf próprio + dedupe: 3 dias pedidos, série só até D(17) -> 1 linha em D(17).
  const lagMap: SeriesMap = { [pumpDex]: points(Array.from({ length: 17 }, () => 100)) };
  const lagRows = computeLaunchpadIndicatorRows(lagMap, [asOf(D(18)), asOf(D(19)), asOf(D(20))]);
  const lagVs = lagRows.filter(
    (r) => r.indicator === 'launchpad_dex_volume_vs_mean_7d' && r.scope === buildProtocolScope('pump.fun')
  );
  check('asOf próprio + dedupe: 1 linha', lagVs.length === 1, `rows=${lagVs.length}`);
  check('asOf próprio: usa D(17), não o dia pedido', lagVs[0] !== undefined && iso(lagVs[0]) === D(17));

  // 8) volume 0 com fees > 0 na mesma data vira AUSENTE (hipótese de dado faltante).
  // D(4) = 0 com fees 500; janela D(4)..D(10) fica com 6 pontos válidos de 100.
  const suspectMap: SeriesMap = {
    [pumpDex]: points([100, 100, 100, 0, 100, 100, 100, 100, 100, 100]),
    [pumpFees]: points([null, null, null, 500, null, null, null, null, null, null]),
  };
  const suspectVs = findRow(
    computeLaunchpadIndicatorRows(suspectMap, [asOf(D(10))]),
    'launchpad_dex_volume_vs_mean_7d',
    'pump.fun',
    D(10)
  );
  check('suspeito: status ok', suspectVs?.status === 'ok', JSON.stringify(suspectVs?.status));
  check('suspeito: value = 0 (média dos 6 válidos)', approx(value(suspectVs), 0), `value=${value(suspectVs)}`);
  check('suspeito: inputCount = 6 (D(4) excluído)', suspectVs?.inputCount === 6, `inputCount=${suspectVs?.inputCount}`);
  check('suspeito: from = D(4) (início da janela)', suspectVs?.fromDate?.toISOString().slice(0, 10) === D(4));
  const pumpDisplayId = LAUNCHPAD_SERIES_IDS['pump.fun'].dexInput;
  const displayPoint = suspectMap[pumpDisplayId]?.find((p) => p.date === D(4));
  check(
    'suspeito: input mostra o ponto excluído e o motivo',
    String(displayPoint?.value) === 'EXCLUIDO(volume=0,fees=500)',
    String(displayPoint?.value)
  );
  check(
    'suspeito: série bruta permanece 0',
    suspectMap[pumpDex]?.find((p) => p.date === D(4))?.value === 0
  );

  // 9) volume 0 com fees 0 continua zero real.
  const zeroFeesMap: SeriesMap = {
    [pumpDex]: points([100, 100, 100, 100, 100, 100, 100, 100, 100, 0]),
    [pumpFees]: points([null, null, null, null, null, null, null, null, null, 0]),
  };
  const zeroFeesRow = findRow(
    computeLaunchpadIndicatorRows(zeroFeesMap, [asOf(D(10))]),
    'launchpad_dex_volume_vs_mean_7d',
    'pump.fun',
    D(10)
  );
  check(
    'volume 0 com fees 0 permanece zero: value = -1',
    zeroFeesRow?.status === 'ok' && approx(value(zeroFeesRow), -1),
    `status=${zeroFeesRow?.status} value=${value(zeroFeesRow)}`
  );
  check('volume 0 com fees 0: inputCount = 7', zeroFeesRow?.inputCount === 7, `inputCount=${zeroFeesRow?.inputCount}`);

  // 10) volume 0 com fees ausentes continua zero real.
  const zeroNoFeesMap: SeriesMap = {
    [pumpDex]: points([100, 100, 100, 100, 100, 100, 100, 100, 100, 0]),
  };
  const zeroNoFeesRow = findRow(
    computeLaunchpadIndicatorRows(zeroNoFeesMap, [asOf(D(10))]),
    'launchpad_dex_volume_vs_mean_7d',
    'pump.fun',
    D(10)
  );
  check(
    'volume 0 com fees ausentes permanece zero: value = -1',
    zeroNoFeesRow?.status === 'ok' && approx(value(zeroNoFeesRow), -1),
    `status=${zeroNoFeesRow?.status} value=${value(zeroNoFeesRow)}`
  );
  check('volume 0 com fees ausentes: inputCount = 7', zeroNoFeesRow?.inputCount === 7, `inputCount=${zeroNoFeesRow?.inputCount}`);

  // 11) change_7d em t (volume suspeito) e em t+7 (base suspeita) -> insufficient_history.
  const changeSuspectValues = Array.from({ length: 17 }, (_, index) => (index === 9 ? 0 : 100));
  const changeSuspectFees = Array.from({ length: 17 }, (_, index) => (index === 9 ? 500 : null));
  const changeSuspectMap: SeriesMap = {
    [pumpDex]: points(changeSuspectValues),
    [pumpFees]: points(changeSuspectFees),
  };
  const changeSuspectRows = computeLaunchpadIndicatorRows(changeSuspectMap, [asOf(D(10)), asOf(D(17))]);
  const changeAtT = findRow(changeSuspectRows, 'launchpad_dex_volume_change_7d', 'pump.fun', D(10));
  const changeAtT7 = findRow(changeSuspectRows, 'launchpad_dex_volume_change_7d', 'pump.fun', D(17));
  check(
    'change_7d em t suspeito -> insufficient_history',
    changeAtT?.status === 'insufficient_history' && changeAtT?.value === null,
    JSON.stringify(changeAtT?.status)
  );
  check(
    'change_7d em t+7 com base suspeita -> insufficient_history',
    changeAtT7?.status === 'insufficient_history' && changeAtT7?.value === null,
    JSON.stringify(changeAtT7?.status)
  );

  // 12) share com 6 datas comuns válidas (uma suspeita excluída) continua ok.
  const shareSuspectMap: SeriesMap = {};
  LAUNCHPAD_SLUGS.forEach((slug, index) => {
    const base = (index + 1) * 10;
    const values: (number | null)[] = [
      null,
      null,
      null,
      base,
      slug === 'pump.fun' ? 0 : base,
      base,
      base,
      base,
      base,
      base,
    ];
    shareSuspectMap[LAUNCHPAD_SERIES_IDS[slug].dex] = points(values);
  });
  shareSuspectMap[pumpFees] = points([null, null, null, null, 500, null, null, null, null, null]);
  const shareSuspectRows = computeLaunchpadIndicatorRows(shareSuspectMap, [asOf(D(10))]);
  const suspectShares = LAUNCHPAD_SLUGS.map((slug) => findRow(shareSuspectRows, 'launchpad_dex_volume_share_7d', slug, D(10)));
  check('share suspeito: 4 linhas ok', suspectShares.every((r) => r?.status === 'ok'), JSON.stringify(suspectShares.map((r) => r?.status)));
  check(
    'share suspeito: 0.1/0.2/0.3/0.4',
    approx(value(suspectShares[0]), 0.1) &&
      approx(value(suspectShares[1]), 0.2) &&
      approx(value(suspectShares[2]), 0.3) &&
      approx(value(suspectShares[3]), 0.4),
    suspectShares.map((r) => value(r)).join(',')
  );
  check('share suspeito: soma = 1', approx(suspectShares.reduce((acc, r) => acc + (value(r) ?? 0), 0), 1));
  check('share suspeito: inputCount = 6', suspectShares[0]?.inputCount === 6, `inputCount=${suspectShares[0]?.inputCount}`);

  // 13) cohort inteiro sem dados: nenhuma linha (não congela insufficient_history).
  check('cohort sem nenhum ponto -> nenhuma linha', computeLaunchpadIndicatorRows({}, [asOf(D(10))]).length === 0);
}

async function runIntegrationSection(): Promise<void> {
  const byKey: Record<string, Msg[]> = {};

  LAUNCHPAD_SLUGS.forEach((slug, index) => {
    const scope = buildProtocolScope(slug);
    const dexRows: Msg[] = [];
    const feesRows: Msg[] = [];
    for (let day = 4; day <= 12; day++) {
      const at = new Date(`${D(day)}T00:00:00.000Z`);
      dexRows.push({ provider: 'defillama_history', collectedAt: at, value: 100 + index * 10 });
      feesRows.push({ provider: 'defillama_history', collectedAt: at, value: 10 + index });
    }
    byKey[`${scope}|dex_volume_daily_usd`] = dexRows;
    byKey[`${scope}|fees_daily_usd`] = feesRows;
  });

  const { reader, calls } = makeReader(byKey);
  const series = await loadAllSeries(reader, new Date('2025-01-01T00:00:00Z'), new Date('2025-01-13T00:00:00Z'), '2025-01-13');
  const asOfs = [asOf(D(12)), asOf(D(11)), asOf(D(10))];
  const { rows } = computeIndicatorRows(series, asOfs);

  const launchpadCalls = calls.filter((c) => c.scope.startsWith('solana:protocol:'));
  check(
    'integração: sem dex_volume_24h_usd',
    !calls.some((c) => c.metric === 'dex_volume_24h_usd'),
    calls.map((c) => c.metric).join(',')
  );
  check(
    'integração: só defillama_history nas séries de launchpad',
    launchpadCalls.length > 0 && launchpadCalls.every((c) => c.providers.length === 1 && c.providers[0] === 'defillama_history')
  );
  check(
    'integração: só métricas diárias de dex/fees',
    launchpadCalls.every((c) => c.metric === 'dex_volume_daily_usd' || c.metric === 'fees_daily_usd'),
    launchpadCalls.map((c) => c.metric).join(',')
  );

  const launchpadRows = rows.filter((r) => r.indicator.startsWith('launchpad_'));
  check('integração: 28 defs x 3 asOfs = 84 linhas', launchpadRows.length === 84, `rows=${launchpadRows.length}`);
  check(
    'integração: 4 escopos presentes',
    LAUNCHPAD_SLUGS.every((slug) => launchpadRows.some((r) => r.scope === buildProtocolScope(slug)))
  );
  check('integração: invariantes de linha ok', validateRowInvariants(rows).length === 0, validateRowInvariants(rows).slice(0, 3).join(' | '));

  const shareAt12 = LAUNCHPAD_SLUGS.map((slug) =>
    findRow(rows, 'launchpad_dex_volume_share_7d', slug, D(12))
  );
  check('integração: share em D(12) soma 1', approx(shareAt12.reduce((acc, r) => acc + (value(r) ?? 0), 0), 1));

  const vsAt12 = findRow(rows, 'launchpad_dex_volume_vs_mean_7d', 'pump.fun', D(12));
  check('integração: volume constante -> vs mean = 0', vsAt12?.status === 'ok' && approx(value(vsAt12), 0), `value=${value(vsAt12)}`);
}

async function runDbSection(url: string): Promise<void> {
  const { PrismaClient } = await import('../generated/db/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { createPrismaReader } = await import('./reader');

  const TEST_FV = 'v1-launchpads-test';
  const FROM = new Date('2001-02-25T00:00:00Z');
  const TO = new Date('2001-03-20T00:00:00Z');
  const CLEAN_FROM = new Date('2001-02-20T00:00:00Z');
  const CLEAN_TO = new Date('2001-03-31T00:00:00Z');
  const TODAY_UTC = '2001-04-01';

  const parsed = new URL(url);
  console.log(`[TEST] DB: ${parsed.hostname}:${parsed.port}/${parsed.pathname.slice(1)}`);

  const adapter = new PrismaPg({ connectionString: url });
  const prisma = new PrismaClient({ adapter });
  const scopes = LAUNCHPAD_SLUGS.map((slug) => buildProtocolScope(slug));

  try {
    let source = await prisma.dataSource.findUnique({ where: { provider: 'defillama_history' } });
    if (source === null) {
      source = await prisma.dataSource.create({
        data: { provider: 'defillama_history', displayName: 'TEST_LAUNCHPADS_DL', baseUrl: 'http://test.local' },
      });
    }

    await prisma.metricSnapshot.deleteMany({ where: { sourceId: source.id, scope: { in: scopes }, collectedAt: { gte: CLEAN_FROM, lte: CLEAN_TO } } });
    await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });

    const rows: {
      sourceId: string;
      scope: string;
      metric: string;
      value: number;
      unit: string;
      sourceTs: Date;
      collectedAt: Date;
    }[] = [];
    LAUNCHPAD_SLUGS.forEach((slug, index) => {
      const scope = buildProtocolScope(slug);
      for (let day = 1; day <= 12; day++) {
        const at = new Date(Date.UTC(2001, 2, day));
        rows.push({ sourceId: source!.id, scope, metric: 'dex_volume_daily_usd', value: 100 + index * 10, unit: 'USD', sourceTs: at, collectedAt: at });
        rows.push({ sourceId: source!.id, scope, metric: 'fees_daily_usd', value: 10 + index, unit: 'USD', sourceTs: at, collectedAt: at });
        rows.push({ sourceId: source!.id, scope, metric: 'dex_volume_24h_usd', value: 999999, unit: 'USD', sourceTs: at, collectedAt: at });
      }
    });
    await prisma.metricSnapshot.createMany({ data: rows });

    const reader = createPrismaReader(prisma);
    const series = await loadAllSeries(reader, FROM, TO, TODAY_UTC);
    const asOfs = [asOf('2001-03-10'), asOf('2001-03-11'), asOf('2001-03-12')];
    const computed = computeIndicatorRows(series, asOfs);

    const lp = computed.rows.filter((r) => r.indicator.startsWith('launchpad_'));
    check('db: 28 defs x 3 asOfs = 84 linhas', lp.length === 84, `rows=${lp.length}`);
    check('db: invariantes ok', validateRowInvariants(computed.rows).length === 0);

    const share = LAUNCHPAD_SLUGS.map((slug) => findRow(lp, 'launchpad_dex_volume_share_7d', slug, '2001-03-12'));
    check('db: share em 2001-03-12 soma 1', approx(share.reduce((acc, r) => acc + (value(r) ?? 0), 0), 1));

    // A isca dex_volume_24h_usd não pode contaminar. Conta: 7 dias × volume
    // diário do seed = 7×(100+110+120+130) = 3220; share de cada slug = 700,
    // 770, 840 e 910 sobre 3220.
    check(
      'db: share não lê dex_volume_24h_usd',
      approx(value(share[0]), 700 / 3220) &&
        approx(value(share[1]), 770 / 3220) &&
        approx(value(share[2]), 840 / 3220) &&
        approx(value(share[3]), 910 / 3220),
      share.map((r) => value(r)).join(',')
    );

    const writeRows = computed.rows.map((r) => ({ ...r, formulaVersion: TEST_FV }));
    const first = await prisma.indicatorSnapshot.createMany({ data: writeRows, skipDuplicates: true });
    check('db: createMany aceita asOf antigo (2001)', first.count === writeRows.length, `inserted=${first.count} expected=${writeRows.length}`);

    const second = await prisma.indicatorSnapshot.createMany({ data: writeRows, skipDuplicates: true });
    check('db: segunda execução não duplica', second.count === 0, `inserted=${second.count}`);

    const persistedOld = await prisma.indicatorSnapshot.count({
      where: { formulaVersion: TEST_FV, asOf: new Date('2001-03-12T00:00:00Z'), indicator: { startsWith: 'launchpad_' } },
    });
    check('db: linhas antigas persistidas', persistedOld > 0, `count=${persistedOld}`);
  } catch (e) {
    check('db: seção de banco executou', false, e instanceof Error ? e.message : String(e));
  } finally {
    try {
      await prisma.indicatorSnapshot.deleteMany({ where: { formulaVersion: TEST_FV } });
      const source = await prisma.dataSource.findUnique({ where: { provider: 'defillama_history' } });
      if (source !== null) {
        await prisma.metricSnapshot.deleteMany({
          where: { sourceId: source.id, scope: { in: scopes }, collectedAt: { gte: CLEAN_FROM, lte: CLEAN_TO } },
        });
      }
    } catch {
      // limpeza best-effort
    }
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  runPureSection();
  await runIntegrationSection();

  const url = process.env.TEST_DATABASE_URL;
  if (url !== undefined && /^(postgresql|postgres):\/\/[^/]*@?(localhost|127\.0\.0\.1):5433\//.test(url)) {
    await runDbSection(url);
  } else {
    console.log('[SKIP] Seção de banco: defina TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5433/terminal_test');
  }

  console.log(`\n${passed} passaram, ${failures} falharam`);
  if (failures > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}
