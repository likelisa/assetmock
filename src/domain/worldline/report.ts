/**
 * 汇总与对外文案（口径硬要求）：
 * - 不用"概率"，只用"在 N 条里有 M 条"；
 * - 不用"最坏值 / min / max"，只用 P5 / P50 / P90；
 * - 不用"预测 / 将会"，只用"如果…则…"。
 * `assertDisplayHygiene` 在单测里把这些词卡死。
 */
import { provenanceOf } from './params';
import { distribution } from './scalars';
import type { Band, ProvenanceEntry, StrategyId, StrategyStats, Worldline, WorldlineParams, WorldlineRunResult } from './types';
import { bandLabels } from './types';

export const bannedWords = ['概率', '最坏', '预测', '将会', '必然'];

export function claimText(input: { n: number; bands: Record<Band, number>; shortfallCount: number; failedAnyCount: number }): string {
  const parts = [`在 ${input.n} 条模拟里，${input.bands.bad} 条出现资金不足`];
  if (input.bands.tight) parts.push(`${input.bands.tight} 条余量紧`);
  parts.push(`其余 ${input.bands.ok} 条余量充足`);
  parts.push(`其中 ${input.failedAnyCount} 条至少一个策略中途停止，${input.shortfallCount} 条走到期末仍不足`);
  return `${parts.join('，')}。`;
}

export function strategyStats(lines: readonly Worldline[], strategyId: StrategyId): StrategyStats {
  const values = lines.map(line => line.strategies[strategyId].minUsable);
  const stats = distribution(values);
  const bandCounts: Record<Band, number> = { bad: 0, tight: 0, ok: 0 };
  for (const line of lines) bandCounts[line.strategies[strategyId].band] += 1;
  return {
    strategyId,
    label: lines[0]?.strategies[strategyId].label ?? strategyId,
    floorMinor: lines[0]?.strategies[strategyId].floorMinor ?? 0,
    p5: Math.round(stats.p5),
    p50: Math.round(stats.p50),
    p90: Math.round(stats.p90),
    mean: Math.round(stats.mean),
    fragility: Math.round(stats.fragility),
    bandCounts,
    failedCount: lines.filter(line => line.strategies[strategyId].status === 'failed').length,
    shortfallCount: lines.filter(line => line.strategies[strategyId].minUsable < 0).length,
  };
}

/** 逐月 P5/P50/P90，只统计该月真的存在的观测（失败线不往后污染） */
export function quantilesByMonth(lines: readonly Worldline[], months: number, strategyId: StrategyId) {
  return Array.from({ length: months }, (_, index) => {
    const values = lines
      .map(line => line.strategies[strategyId].usable[index])
      .filter((value): value is number => typeof value === 'number');
    if (!values.length) return { p5: 0, p50: 0, p90: 0 };
    const stats = distribution(values);
    return { p5: Math.round(stats.p5), p50: Math.round(stats.p50), p90: Math.round(stats.p90) };
  });
}

export function countBands(lines: readonly Worldline[]): Record<Band, number> {
  const counts: Record<Band, number> = { bad: 0, tight: 0, ok: 0 };
  for (const line of lines) counts[line.worstBand] += 1;
  return counts;
}

export function bandBreakdown(counts: Record<Band, number>): string {
  return (Object.keys(counts) as Band[]).map(band => `${bandLabels[band]} ${counts[band]}`).join(' / ');
}

/** 只检查给用户看的文案字段，避免误伤 provenance 里"不代表现实概率"这类否定句 */
export function assertDisplayHygiene(result: Pick<WorldlineRunResult, 'claim' | 'candidates'>): void {
  const texts = [result.claim, ...result.candidates.map(candidate => candidate.premise)];
  for (const text of texts) {
    for (const word of bannedWords) {
      if (text.includes(word)) throw new Error(`展示文案出现禁用词「${word}」：${text}`);
    }
  }
}

export function evidenceIdsOf(seed: number, n: number, months: number, params: WorldlineParams, lineIds: readonly string[]): string[] {
  return [`WORLDLINE_RUN:${seed}:${n}:${months}:${params.version}`, ...lineIds.map(id => `WORLDLINE:${id}`)];
}

export function provenanceEntries(params: WorldlineParams): ProvenanceEntry[] {
  return provenanceOf(params);
}
