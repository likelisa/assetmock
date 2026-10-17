/**
 * 标量：唯一的判定标量 + 唯一的分档函数 + 分位数。
 *
 * 血泪约束：判定 / 档位 / 颜色 / 排序 / 卡片标签必须同源。
 * 所以这里只有 `minUsable` 与 `bandOf`；任何别的口径（期末值、排名分桶、最差月）
 * 都不许参与判定。
 */
import type { Band, Minor } from './types';
import { bandRank } from './types';

export function quantile(sortedAsc: readonly number[], q: number): number {
  if (!sortedAsc.length) return 0;
  if (q <= 0) return sortedAsc[0];
  if (q >= 1) return sortedAsc[sortedAsc.length - 1];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

export function sortedCopy(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

export function median(values: readonly number[]): number {
  return quantile(sortedCopy(values), 0.5);
}

export interface Distribution { p5: number; p50: number; p90: number; mean: number; fragility: number }

export function distribution(values: readonly number[]): Distribution {
  if (!values.length) return { p5: 0, p50: 0, p90: 0, mean: 0, fragility: 0 };
  const sorted = sortedCopy(values);
  const p5 = quantile(sorted, 0.05);
  const p90 = quantile(sorted, 0.9);
  return {
    p5,
    p50: quantile(sorted, 0.5),
    p90,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    fragility: p90 - p5,
  };
}

/** 分档门槛 = 当月固定流出 × 3 个月；口径由适配器传进来，core 只做比较 */
export function floorFromFixedOutflow(fixedOutflowMinor: Minor): Minor {
  return fixedOutflowMinor * 3;
}

export function bandOf(value: Minor, floorMinor: Minor): Band {
  if (value < 0) return 'bad';
  return value < floorMinor ? 'tight' : 'ok';
}

/** 各策略里较差的那个档 —— 世界线的统一基准 */
export function worstBand(bands: readonly Band[]): Band {
  return bands.reduce<Band>((worst, band) => (bandRank[band] < bandRank[worst] ? band : worst), 'ok');
}

export function minOf(values: readonly number[]): Minor {
  return values.length ? Math.min(...values) : 0;
}
