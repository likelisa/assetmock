import type { RenderModel, RenderStrategy } from '@/domain/worldline/render-model';

export const CHART_WIDTH = 520;
export const CHART_HEIGHT = 300;
export const CHART_PAD = { top: 16, right: 58, bottom: 26, left: 56 };
export const MARGINAL_GAP = 12;

export interface YDomain { min: number; max: number }

/** 两个面板共用一套纵轴：所有分位带与代表线一起取范围，各留 4% 余量 */
export function buildYDomain(model: RenderModel): YDomain {
  let min = 0;
  let max = 0;
  for (const strategy of model.strategies) {
    for (const point of model.quantilesByMonth[strategy.id] ?? []) {
      min = Math.min(min, point.p5);
      max = Math.max(max, point.p90);
    }
  }
  for (const candidate of model.candidates) {
    for (const strategy of model.strategies) {
      for (const value of candidate.series[strategy.id] ?? []) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
  }
  const span = Math.max(1, max - min);
  return { min: min - span * 0.04, max: max + span * 0.04 };
}

export interface Bin { from: number; to: number; count: number; density: number }

/** 右侧边际分布：把每线的"最低可用资金"直方化（只用一个标量） */
export function buildMarginalBins(values: readonly number[], domain: YDomain, bins = 40): Bin[] {
  const span = domain.max - domain.min || 1;
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) {
    const ratio = (value - domain.min) / span;
    const index = Math.min(bins - 1, Math.max(0, Math.floor(ratio * bins)));
    counts[index] += 1;
  }
  const smooth = counts.map((count, index) => (counts[index - 1] ?? 0) * 0.25 + count + (counts[index + 1] ?? 0) * 0.25);
  const peak = Math.max(...smooth, 1);
  return counts.map((_, index) => ({
    from: domain.min + (span * index) / bins,
    to: domain.min + (span * (index + 1)) / bins,
    count: counts[index],
    density: smooth[index] / peak,
  }));
}

/** 金额（分）→ 万元，图表刻度用 */
export function wan(minor: number): string {
  const value = minor / 1_000_000;
  const abs = Math.abs(value);
  const text = abs >= 100 ? value.toFixed(0) : abs >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${text}万`;
}

export function yuan(minor: number): string {
  return `${(minor / 100).toLocaleString('zh-CN', { maximumFractionDigits: 0 })}`;
}

export function strategyColor(strategy: RenderStrategy, index: number): string {
  return index === 0 ? '#23669d' : '#c2571a';
}

export const bandColor: Record<string, string> = { ok: '#1f9d6b', tight: '#c98a00', bad: '#d2453f' };
