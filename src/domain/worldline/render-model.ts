/**
 * 接口二：**给渲染层的 DTO**（引擎与渲染之间的墙）
 *
 * 规则：
 * - 渲染层只读本文件的类型与 `toRenderModel()` 的输出；不 import core 内部实现、不 import 服务层；
 * - 本文件不 import React / DOM / next / 任何 UI 库（只 import 类型）。
 *
 * 传输口径（性能关键）：
 * - 折线只要"逐月 P5/P50/P90 三根带"+ 被选中那几条线的月度序列；
 * - 边际分布只要"每策略每条线一个标量"（minUsables），直方图在客户端算；
 * - 代表线（≤8 条）给完整前提与两策略判定。
 */
import type { Band, QuantilePoint, StrategyId, Verdict, WorldlineRunResult } from './types';

export interface RenderStrategy {
  id: StrategyId;
  label: string;
  /** 分档门槛（分）；两栏色带高度按各自的 floor 画，这是正确的 */
  floorMinor: number;
  p5: number;
  p50: number;
  p90: number;
  bandCounts: Record<Band, number>;
}

export interface RenderCandidate {
  id: string;
  band: Band;
  /** 排名五档：worst / secondWorst / middle / secondBest / best */
  tier: string;
  label: string;
  premise: string;
  /** 非默认档的人类可读串（如"生活开销 +5% · 大病自付中档"），全默认时为空串 */
  profileLabel: string;
  byStrategy: Record<StrategyId, {
    label: string;
    minBalanceMinor: number;
    band: Band;
    verdict: Verdict;
    firstShortfall: { month: number; amountMinor: number } | null;
  }>;
  cause: { shock: string | null; trigger: string | null };
  /** 这条世界线的逐月可用资金（画折线用） */
  series: Record<StrategyId, number[]>;
}

export interface RenderModel {
  meta: {
    seed: number;
    n: number;
    months: number;
    engineVersion: string;
    worldlineRulesVersion: string;
    v2RulesVersion: string;
    paramsVersion: string;
    cardsVersion?: string;
    cardPlanId?: string;
    cardPlanHash?: string;
    dataStatus: 'OK' | 'DEGRADED';
    claim: string;
  };
  strategies: RenderStrategy[];
  /** 世界线级三档计数（画"三层占比"用） */
  bands: Record<Band, number>;
  /** 逐月分位带：画折线带用 */
  quantilesByMonth: Record<StrategyId, QuantilePoint[]>;
  /** 每策略每条线的最小可用资金：画右侧边际分布（1 个数字 1 条线） */
  minUsables: Record<StrategyId, number[]>;
  candidates: RenderCandidate[];
  /** 给"这些假设从哪来"的一行一段，basis 决定措辞 */
  provenance: Array<{ param: string; label: string; basis: string; url?: string }>;
}

export function toRenderModel(result: WorldlineRunResult): RenderModel {
  return {
    meta: {
      seed: result.seed,
      n: result.n,
      months: result.months,
      engineVersion: result.engineVersion,
      worldlineRulesVersion: result.worldlineRulesVersion,
      v2RulesVersion: result.v2RulesVersion,
      paramsVersion: result.paramsVersion,
      cardsVersion: result.cardsVersion,
      cardPlanId: result.cardPlanId,
      cardPlanHash: result.cardPlanHash,
      dataStatus: result.dataStatus,
      claim: result.claim,
    },
    strategies: result.strategies.map(spec => {
      const stats = result.byStrategy.find(item => item.strategyId === spec.id);
      return {
        id: spec.id,
        label: spec.label,
        floorMinor: spec.floorMinor,
        p5: stats?.p5 ?? 0,
        p50: stats?.p50 ?? 0,
        p90: stats?.p90 ?? 0,
        bandCounts: stats?.bandCounts ?? { bad: 0, tight: 0, ok: 0 },
      };
    }),
    bands: result.bands,
    quantilesByMonth: result.quantilesByMonth,
    minUsables: result.minUsables,
    candidates: result.candidates.map(candidate => ({
      id: candidate.id,
      band: candidate.band,
      tier: candidate.tier,
      label: candidate.label,
      premise: candidate.premise,
      profileLabel: candidate.profileLabel,
      byStrategy: Object.fromEntries(Object.entries(candidate.byStrategy).map(([id, strategy]) => [
        id,
        {
          label: strategy.label,
          minBalanceMinor: strategy.minBalanceMinor,
          band: strategy.band,
          verdict: strategy.verdict,
          firstShortfall: strategy.firstShortfall,
        },
      ])),
      cause: candidate.cause,
      series: candidate.series,
    })),
    provenance: result.provenance.map(entry => ({
      param: entry.param,
      label: entry.label,
      basis: entry.basis,
      ...(entry.url ? { url: entry.url } : {}),
    })),
  };
}

/** 渲染层自检：模型必须可 JSON 序列化、minUsables 长度与 n 一致 */
export function assertRenderable(model: RenderModel): void {
  const round = JSON.parse(JSON.stringify(model)) as RenderModel;
  if (round.meta.n !== model.meta.n) throw new Error('渲染模型无法稳定序列化');
  for (const [id, values] of Object.entries(round.minUsables)) {
    if (!Array.isArray(values) || values.length !== model.meta.n) throw new Error(`策略 ${id} 的 minUsables 长度与 n 不符`);
  }
  for (const strategy of round.strategies) {
    if (!Number.isFinite(strategy.floorMinor)) throw new Error(`策略 ${strategy.id} 缺少门槛`);
  }
}
