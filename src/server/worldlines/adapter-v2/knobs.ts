/**
 * 适配器：把参数包翻译成 v2 引擎认的旋钮。
 *
 * 参数包是全项目的"数据契约"（facts / assumptions + 出处），
 * 但 v2 只认 `rules.probabilities` 那几个每百万整数与一个 living 数字。
 * 这一层就是那张对照表 —— 换引擎时改这里，core 与接口层都不动。
 */
import type { WorldlineParams } from '@/domain/worldline/types';
import { findParam } from '@/domain/worldline/params';

/** 世界线自己的规则版本：开销档梯度、应对策略枚举这些"建模选择"的版本号 */
export const WORLDLINE_RULES_VERSION = 'wl-rules.0.1.0';

/** 参数 key → v2 的 Draws 键；新增事件种类时两边一起加 */
export const DRAW_KEY_MAP = {
  medical: 'draw.medical.monthly',
  jobLoss: 'draw.jobLoss.monthly',
  bonusDelay: 'draw.bonusDelay.monthly',
  marketDrop: 'draw.marketDrop.monthly',
  career: 'draw.career.monthly',
} as const;

export type DrawKey = keyof typeof DRAW_KEY_MAP;

/** v2 默认概率（每百万每月），参数包缺项时回落到它，状态标 DEGRADED */
export const V2_DEFAULT_DRAWS: Record<DrawKey, number> = {
  medical: 1000,
  jobLoss: 2000,
  bonusDelay: 200000,
  marketDrop: 5000,
  career: 5000,
};

export interface V2DrawThresholds {
  thresholds: Record<DrawKey, number>;
  status: 'OK' | 'DEGRADED';
  missing: string[];
}

/** 从参数包取每百万阈值；缺哪项就用 v2 默认值并记下来 */
export function v2DrawThresholds(params: WorldlineParams): V2DrawThresholds {
  const thresholds = {} as Record<DrawKey, number>;
  const missing: string[] = [];
  for (const key of Object.keys(DRAW_KEY_MAP) as DrawKey[]) {
    const param = findParam(params, DRAW_KEY_MAP[key]);
    if (param && Number.isInteger(param.value) && param.value >= 0 && param.value <= 1000000) {
      thresholds[key] = param.value;
    } else {
      thresholds[key] = V2_DEFAULT_DRAWS[key];
      missing.push(DRAW_KEY_MAP[key]);
    }
  }
  return { thresholds, status: missing.length ? 'DEGRADED' : 'OK', missing };
}

