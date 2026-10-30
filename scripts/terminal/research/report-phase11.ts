#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { checkEnvironment } from '../config';
import {
  PHASE11_REPORT_TITLE,
  buildPhase11Analysis,
  loadPhase11Data,
  type HorizonResult,
  type Phase11Analysis,
  type QuestionResult,
} from './phase11-reader';

function formatNumber(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

function table(headers: readonly string[], rows: readonly string[][]): string[] {
  if (rows.length === 0) return ['(sem linhas)'];

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length))
  );
  const render = (row: readonly string[]): string =>
    row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(' | ');

  return [render(headers), widths.map((width) => '-'.repeat(width)).join('-+-'), ...rows.map(render)];
}

function ruleText(question: QuestionResult): string {
  const rule = question.prepared.rule;
  const start =
    rule.returnStartOffsetDays === 0
      ? 'retorno parte do fechamento de D'
      : `retorno parte do fechamento de D+${rule.returnStartOffsetDays}`;
  const lag =
    rule.signalLagDays === 0
      ? 'sinal de D'
      : `sinal visível em D usa D-${rule.signalLagDays}`;
  return `Regra: ${lag}; ${start}; dimensão=${rule.stateDimension ?? 'indicador'}`;
}

function horizonLines(horizon: HorizonResult): string[] {
  const rows: string[][] = [];

  for (const group of horizon.groups) {
    rows.push([
      group.group,
      'primeira',
      String(group.first.n),
      String(group.first.nIndependent),
      formatNumber(group.first.mean),
      formatNumber(group.first.median),
      formatNumber(group.first.positivePct),
      formatNumber(group.firstDifference),
      group.verdict,
    ]);
    rows.push([
      group.group,
      'segunda',
      String(group.second.n),
      String(group.second.nIndependent),
      formatNumber(group.second.mean),
      formatNumber(group.second.median),
      formatNumber(group.second.positivePct),
      formatNumber(group.secondDifference),
      group.verdict,
    ]);
  }

  return [
    '',
    `Horizonte ${horizon.horizon}d — baseline primeira=${formatNumber(horizon.firstBaseline.mean)} segunda=${formatNumber(horizon.secondBaseline.mean)}`,
    ...table(
      [
        'grupo',
        'metade',
        'n',
        'n_independente',
        'média',
        'mediana',
        '% positivos',
        'diferença vs geral',
        'veredito',
      ],
      rows
    ),
  ];
}

function questionLines(question: QuestionResult): string[] {
  const lines = [
    '',
    `=== ${question.prepared.rule.title} ===`,
    ruleText(question),
    `Excluídos por dimensão insuficiente: ${question.prepared.excluded}`,
  ];

  if (question.prepared.note !== null) {
    lines.push(`Aviso: ${question.prepared.note}`);
  }

  for (const horizon of question.horizons) {
    lines.push(...horizonLines(horizon));
  }

  return lines;
}

export function formatPhase11Report(analysis: Phase11Analysis): string {
  const lines = [
    analysis.title,
    '',
    `Período usado: ${analysis.from} a ${analysis.to}`,
    `Dias base: ${analysis.baseDays}; dias com fechamento: ${analysis.closeDays}; dias live: ${analysis.liveDays}`,
    '',
    'Dias excluídos por pergunta:',
  ];

  for (const question of analysis.questions) {
    lines.push(
      `  ${question.prepared.id}: ${question.prepared.excluded} — ${question.prepared.rule.title}`
    );
  }

  for (const question of analysis.questions) {
    lines.push(...questionLines(question));
  }

  lines.push('', '=== Q6 — nível de dex_volume_vs_mean_7d por dia da semana ===');
  lines.push(
    ...table(
      ['grupo', 'metade', 'n', 'n_independente', 'média', 'mediana', '% positivos'],
      analysis.dexLevels.flatMap((row) => [
        [
          row.group,
          'primeira',
          String(row.first.n),
          String(row.first.nIndependent),
          formatNumber(row.first.mean),
          formatNumber(row.first.median),
          formatNumber(row.first.positivePct),
        ],
        [
          row.group,
          'segunda',
          String(row.second.n),
          String(row.second.nIndependent),
          formatNumber(row.second.mean),
          formatNumber(row.second.median),
          formatNumber(row.second.positivePct),
        ],
      ])
    )
  );

  lines.push('', '=== LIVE — somente computeMode=live (n e média, sem veredito) ===');
  lines.push(
    ...table(
      ['pergunta', 'horizonte', 'grupo', 'n', 'média'],
      analysis.live.map((row) => [
        row.question,
        row.horizon === null ? '-' : `${row.horizon}d`,
        row.group,
        String(row.n),
        formatNumber(row.mean),
      ])
    )
  );

  return lines.join('\n');
}

function requireRemoteAllow(): boolean {
  const url = process.env.TERMINAL_DATABASE_URL;
  if (url === undefined || url === '') return true;

  try {
    const host = new URL(url).hostname;
    if (/^(localhost|127\.0\.0\.1)$/.test(host)) return true;
    return process.env.TERMINAL_ALLOW_REMOTE === '1';
  } catch {
    return true;
  }
}

async function main(): Promise<void> {
  if (!requireRemoteAllow()) {
    console.error('[ABORT] report:phase11 exige TERMINAL_ALLOW_REMOTE=1 para banco remoto');
    process.exitCode = 1;
    return;
  }

  checkEnvironment();
  const { prisma } = await import('../db');

  try {
    const data = await loadPhase11Data(prisma);
    console.log(formatPhase11Report(buildPhase11Analysis(data)));
  } catch (error) {
    console.error('[FATAL]', error instanceof Error ? error.message : String(error).slice(0, 300));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main();
}

export { PHASE11_REPORT_TITLE };
