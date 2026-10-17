import type { LineEvent, StrategyLine } from './types';
export const ENDING_VERSION = 'ending.v1';
export const SAMPLE_COUNT = 200;
export const RESPONSE_POLICY = { jobLoss: 'WAIT', career: 'DECLINE' } as const;
export interface EndingAnalysisSnapshot {
  version: typeof ENDING_VERSION;
  runId: string;
  runVersion: number;
  signature: string;
  seed: number;
  rulesVersion: string;
  probabilities: Record<string, number>;
  policy: typeof RESPONSE_POLICY;
  n: number;
  months: number;
  createdAt: string;
  strategies: Array<{ id: string; label: string; floor: number; failed: number; minima: number[]; p5: number; p50: number; p90: number }>;
  samples: Array<{ id: string; events: LineEvent[]; strategies: Record<string, StrategyLine> }>;
}
export interface HistogramBin { from: number; to: number; count: number; share: number }
/** Shared monetary edges include every risk threshold, so no bin straddles a risk band. */
export function sharedEdges(values: number[], thresholds: number[]): number[] {
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max(1, (high - low) * 0.08);
  const min = low - padding, max = high + padding;
  return [...new Set([...Array.from({ length: 21 }, (_, i) => min + (max - min) * i / 20), ...thresholds.filter(t => t > min && t < max)])].sort((a,b) => a-b);
}
export function histogram(values: number[], edges: number[]): HistogramBin[] {
  return edges.slice(0,-1).map((from,i) => {
    const to=edges[i+1];
    const count=values.filter(v => v >= from && (v < to || (i === edges.length-2 && v <= to))).length;
    return {from,to,count,share:values.length ? count/values.length : 0};
  });
}
export function riskOf(value: number, floor: number) {
  if(value < 0) return {label:'资金不足',color:'#E02D2D'};
  if(value < floor) return {label:'低于储备门槛',color:'#FC5B5B'};
  if(value < floor*1.25) return {label:'贴近门槛',color:'#F2881B'};
  return {label:'有余量',color:'#52D11F'};
}
