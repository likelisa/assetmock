/**
 * 接口一：**给 Agent 的工具契约**（渲染层与此无关）
 *
 * 这里只做四件事，全部可单测、不依赖框架、不依赖数据库：
 *   1. 声明工具元信息（名字/类型/描述/入参 JSON Schema）——并入时喂给 agent-tools 的 tool(...)
 *   2. 声明 prompt 片段（口径红线，逐字复用，别让每个调用点各写一版）
 *   3. 把 `WorldlineRunResult` 瘦身成 **≤6KB** 的工具出参
 *   4. 校验体积，超预算直接抛错（逼调用方瘦身，而不是撑爆上下文）
 *
 * 不入出参的东西：n 条 × M 策略的逐月序列。那是渲染层的事，走 HTTP。
 */
import type { Band, ProvenanceEntry, StrategyId, WorldlineRunResult } from '@/domain/worldline/types';
import type { CardLibrary } from './cards/types';
import { defaultCardPlan, describePlan, type CardPlan } from './cards/plan';
import { laddersFromCards } from './cards/ladders';

export const TOOL_NAME = 'simulateWorldlines';
export const TOOL_DETAIL_NAME = 'getWorldlineDetail';
/** 读卡目录：agent 选卡之前先看有什么可选（QUERY） */
export const CARDS_TOOL_NAME = 'getEventCards';
/** 提交卡组：agent 的判断，服务端校验后才会被采纳（PROPOSE） */
export const CARD_PLAN_TOOL_NAME = 'proposeEventCardPlan';
export const TOOL_KIND = 'COMPUTE' as const;
export const CARDS_TOOL_KIND = 'QUERY' as const;
export const CARD_PLAN_TOOL_KIND = 'PROPOSE' as const;
export const TOOL_ROLES = ['GOAL', 'WEALTH', 'CASHFLOW'] as const;
export const TOOL_DESCRIPTION =
  '按当前底账、已选方案与 agent 选定的卡组批量推演 N 条假设世界线，返回分级候选与统计。不预测未来，不代表概率；只用于"如果…则…"的规划参考。';
export const CARDS_TOOL_DESCRIPTION =
  '读取事件卡目录（按目标过滤）：每张卡的强度档、可复述前提、引用的真实数据与依据等级、默认抽样权重。选卡之前先调这个，不要凭印象编卡。';
export const CARD_PLAN_TOOL_DESCRIPTION =
  '提交你为这个用户选定的卡组：哪些卡参与、哪些排除、哪一档要钉死，以及每条判断的理由与依据（引用用户事实）。服务端会校验并拒绝"静默砍掉尾部"或"改数字"的版本。';
export const TOOL_PAYLOAD_LIMIT_BYTES = 6 * 1024;

/** 卡组入参：agent 选卡后的结构化结果，也是 simulateWorldlines 的入参之一 */
export const CARD_PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'version', 'entries', 'notes'],
  properties: {
    id: { type: 'string' },
    version: { type: 'string' },
    target: { type: ['string', 'null'] },
    notes: { type: 'array', items: { type: 'string' }, description: '取舍说明；排除整组梯度或最重档时必须写' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cardId', 'ladder', 'mode', 'rationale', 'evidenceIds'],
        properties: {
          cardId: { type: 'string', description: '必须来自 getEventCards 返回的卡' },
          ladder: { type: 'string' },
          mode: { type: 'string', enum: ['sampled', 'fixed', 'excluded'] },
          weightOverride: { type: 'integer', minimum: 1, description: '仅 sampled；1..原权重×3' },
          rationale: { type: 'string', description: '一句话判断，例如"用户无子女，养育成本不参与"' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/** 入参 JSON Schema：并入时直接用，保证工具目录与实现同一份 */
export const TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goalId: { type: ['string', 'null'], description: '目标；为空表示当前会话目标' },
    strategies: {
      type: 'array',
      items: { type: 'string', enum: ['a', 'b'] },
      minItems: 2,
      maxItems: 2,
      description: '比较哪两条策略；默认当前已选方案的 A/B',
    },
    n: { type: 'integer', minimum: 20, maximum: 600, description: '世界线条数；5 年默认 400，30 年默认 200' },
    k: { type: 'integer', minimum: 1, maximum: 6, description: '卡片张数；默认 6，按 劣/次劣/次优 优先保留' },
    months: { type: ['integer', 'null'], minimum: 1, maximum: 360, description: '推演月数；为空按目标月份' },
    seed: { type: ['integer', 'null'], description: '给定则完全复现；为空则由服务端生成并回传' },
    paramsVersion: { type: ['string', 'null'], description: '参数包版本；为空用当前快照' },
    cardPlan: { ...CARD_PLAN_JSON_SCHEMA, description: '你用 proposeEventCardPlan 提交并被采纳的卡组；省略则用默认卡组（全档按数据权重）' },
    responsePolicy: { type: 'string', enum: ['WAIT', 'LOWER', 'TEMPORARY'], description: '收入中断后的固定应对策略；全条一致才可比' },
    careerPolicy: { type: 'string', enum: ['DECLINE', 'ACCEPT'], description: '职业机会的固定应对策略' },
    focus: { type: 'string', enum: ['GOAL', 'LIQUIDITY'], description: '看目标达成还是看资金链' },
  },
  required: [],
} as const;

/**
 * prompt 片段：接入时粘进目标管家指令。
 * 这几句是口径底线，别改写。
 */
export const PROMPT_SNIPPET = `
世界线推演（simulateWorldlines）用法：
- 只能引用返回的 candidates；不许自己编世界线或改数值。
- 说的是"在 N 条模拟里有 M 条"，不是"有 M% 的概率"。
- 说区间用 P5 / P50 / P90，不说"最坏情况"或"最好情况"。
- 一律用"如果……则……"，不用"预测 / 将会发生"。
- 引用参数按 basis 分三档措辞：
  PUBLIC_STATISTIC → 可写"公开统计显示……（出处 url）"；DERIVED → 必须带公式；
  PRESS_HYPOTHESIS → 只能写"我们假定……"。
- 结论必须给出 seed、n、paramsVersion、cardPlanHash，方便用户复现。
- 若要描述某个月发生了什么，调用 ${TOOL_DETAIL_NAME}，不要凭印象编。

事件卡由你来选（权限在这里）：
- 先调 ${CARDS_TOOL_NAME} 看目录，再用 ${CARD_PLAN_TOOL_NAME} 提交卡组。
- 你只能"选档"，不能改数值：金额、幅度、利率、频率都锁在参数包上。
- 每个判断都要写 rationale；涉及用户情况时必须引用用户事实（evidenceIds），
  例如"用户自述租房、无子女 → 排除养育成本卡"。
- 排除一整组梯度、或排除某梯度最重的一档，必须在 notes 里明说；静默砍尾部会被拒。
- 只有你判断该用户确实面临某种情形时，才把那一档钉死（mode=fixed）；不确定就让它按权重抽。
`.trim();

export interface ToolCandidatePayload {
  id: string;
  band: Band;
  label: string;
  premise: string;
  byStrategy: Record<StrategyId, {
    minBalanceMinor: string;
    band: Band;
    verdict: string;
    firstShortfall: { month: number; amountMinor: string } | null;
  }>;
  cause: { shock: string | null; trigger: string | null };
  marginMinor: string;
}

/* ────────────── 选卡用的工具出参 ────────────── */

export interface CardRow {
  cardId: string;
  title: string;
  premise: string;
  /** 默认抽样权重；0 = 叙事卡 */
  weight: number;
  /** 引用参数的依据等级（PUBLIC_STATISTIC / DERIVED / PRESS_HYPOTHESIS） */
  bases: string[];
  canSay: string[];
  cantSay: string[];
}

export interface CardCataloguePayload {
  cardsVersion: string;
  target?: string;
  /** 当前卡组的一句话摘要（未选时是默认卡组） */
  planSummary: string;
  /** 当前卡组 id（不回显整份卡组，省上下文） */
  /** 参与抽样的梯度；默认档要标出来（抽到它时不写进前提） */
  ladders: Array<{ key: string; eventKind?: string; defaultOptionId: string; options: CardRow[] }>;
  /** 不参与结算、只能当论据的卡 */
  narrative: CardRow[];
  /** 只回摘要不回整份卡组：agent 已经知道自己提交了什么，回显会白占上下文 */
  planId: string;
}

/**
 * 卡目录出参。<6KB 的关键：**只给标题/前提/依据等级，不给整段 label 与 url**。
 * 具体出处由 agent 在结论里引用 provenance（simulateWorldlines 会回传）。
 */
export function toCardCatalogue(
  library: CardLibrary,
  options: {
    target?: string;
    plan?: CardPlan;
    basesOf: (cardId: string) => string[];
  },
): CardCataloguePayload {
  const plan = options.plan ?? defaultCardPlan(library, options.target);
  const base = laddersFromCards(library, options.target);
  const byId = new Map(library.cards.map(card => [card.id, card]));
  const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…` : text);
  const row = (card: CardLibrary['cards'][number]): CardRow => ({
    cardId: card.id,
    title: card.title,
    premise: clip(card.premise, 40),
    weight: card.weight,
    bases: [...new Set(options.basesOf(card.id))],
    canSay: card.canSay.slice(0, 1).map(text => clip(text, 24)),
    cantSay: card.cantSay.slice(0, 1).map(text => clip(text, 28)),
  });
  return {
    cardsVersion: library.version,
    ...(options.target ? { target: options.target } : {}),
    planSummary: describePlan(plan, library),
    ladders: base.map(ladder => ({
      key: ladder.key,
      ...(ladder.eventKind ? { eventKind: ladder.eventKind } : {}),
      defaultOptionId: ladder.defaultOptionId,
      options: ladder.options.flatMap(option => {
        const card = byId.get(option.id);
        return card ? [row(card)] : [];
      }),
    })),
    narrative: library.cards.filter(card => card.ladder === 'narrative' || card.weight === 0).map(row),
    planId: plan.id,
  };
}

export interface ToolPayload {
  seed: number;
  engineVersion: string;
  worldlineRulesVersion: string;
  v2RulesVersion: string;
  paramsVersion: string;
  paramsSha256?: string;
  cardsVersion?: string;
  cardPlanId?: string;
  cardPlanHash?: string;
  dataStatus: 'OK' | 'DEGRADED';
  n: number;
  months: number;
  strategies: Array<{ id: StrategyId; name: string; floorMinor: string }>;
  bands: Record<Band, number>;
  quantiles: Record<StrategyId, { p5Minor: string; p50Minor: string; p90Minor: string }>;
  candidates: ToolCandidatePayload[];
  claim: string;
  provenance: Array<Omit<ProvenanceEntry, 'quote'> & { quote?: string }>;
  evidenceIds: string[];
}

const trimQuote = (quote: string) => (quote.length > 120 ? `${quote.slice(0, 120)}…` : quote);
const trimLabel = (label: string, limit: number) => (label.length > limit ? `${label.slice(0, limit)}…` : label);

/**
 * 出处行要给，但**不能把整本参数包塞进工具出参**：
 * 默认只带 8 条（公开统计优先），label 截断，quote 默认不带。
 * 需要完整出处的场景（报告、页面）走 UI 侧接口，不走 agent。
 */
export interface ToolPayloadOptions {
  provenanceQuotes?: boolean;
  maxProvenance?: number;
  /** 只带这些 key；服务层知道候选用了哪些卡，可以精确传 */
  provenanceKeys?: string[];
  provenanceLabelLimit?: number;
}

export function toToolPayload(result: WorldlineRunResult, options: ToolPayloadOptions = {}): ToolPayload {
  const basisRank = (basis: string) => (basis === 'PUBLIC_STATISTIC' ? 0 : basis === 'DERIVED' ? 1 : 2);
  const prioritized = [...result.provenance].sort((a, b) => basisRank(a.basis) - basisRank(b.basis));
  const chosen = options.provenanceKeys
    ? prioritized.filter(entry => options.provenanceKeys!.includes(entry.param))
    : prioritized.slice(0, options.maxProvenance ?? 4);
  const labelLimit = options.provenanceLabelLimit ?? 60;
  return {
    seed: result.seed,
    engineVersion: result.engineVersion,
    worldlineRulesVersion: result.worldlineRulesVersion,
    v2RulesVersion: result.v2RulesVersion,
    paramsVersion: result.paramsVersion,
    paramsSha256: result.paramsSha256,
    cardsVersion: result.cardsVersion,
    cardPlanId: result.cardPlanId,
    cardPlanHash: result.cardPlanHash,
    dataStatus: result.dataStatus,
    n: result.n,
    months: result.months,
    strategies: result.strategies.map(spec => ({ id: spec.id, name: spec.label, floorMinor: String(spec.floorMinor) })),
    bands: result.bands,
    quantiles: Object.fromEntries(result.byStrategy.map(stat => [
      stat.strategyId,
      { p5Minor: String(stat.p5), p50Minor: String(stat.p50), p90Minor: String(stat.p90) },
    ])),
    candidates: result.candidates.slice(0, 8).map(candidate => ({
      id: candidate.id,
      band: candidate.band,
      label: candidate.label,
      premise: trimLabel(candidate.premise, 90),
      byStrategy: Object.fromEntries(Object.entries(candidate.byStrategy).map(([id, strategy]) => [
        id,
        {
          minBalanceMinor: String(strategy.minBalanceMinor),
          band: strategy.band,
          verdict: strategy.verdict,
          firstShortfall: strategy.firstShortfall
            ? { month: strategy.firstShortfall.month, amountMinor: String(strategy.firstShortfall.amountMinor) }
            : null,
        },
      ])),
      cause: candidate.cause,
      marginMinor: String(candidate.marginMinor),
    })),
    claim: result.claim,
    provenance: chosen.map(entry => ({
      param: entry.param,
      value: entry.value,
      unit: entry.unit,
      label: trimLabel(entry.label, labelLimit),
      basis: entry.basis,
      ...(entry.sourceQuality ? { sourceQuality: entry.sourceQuality } : {}),
      ...(entry.derivation ? { derivation: entry.derivation } : {}),
      ...(entry.url ? { url: entry.url } : {}),
      ...(entry.retrievedAt ? { retrievedAt: entry.retrievedAt } : {}),
      ...(options.provenanceQuotes && entry.quote ? { quote: trimQuote(entry.quote) } : {}),
    })),
    evidenceIds: result.evidenceIds,
  };
}

export function payloadBytes(payload: unknown): number {
  const text = JSON.stringify(payload);
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(text, 'utf8');
  return new TextEncoder().encode(text).length;
}

/** 超预算就抛：宁可让 agent 少一组论据，也不要把上下文撑爆 */
export function assertPayloadBudget(payload: unknown, limit = TOOL_PAYLOAD_LIMIT_BYTES): number {
  const bytes = payloadBytes(payload);
  if (bytes > limit) throw new Error(`工具出参 ${bytes}B 超出 ${limit}B 预算`);
  return bytes;
}

/* ────────────── 校验用 zod（接口与服务共用同一份） ────────────── */

import { z } from 'zod';

export const cardPlanSchema = z.object({
  id: z.string().min(1).max(80),
  version: z.string().min(1).max(40),
  target: z.enum(['car', 'home']).nullable().optional(),
  notes: z.array(z.string().max(200)).max(20),
  entries: z.array(z.object({
    cardId: z.string().min(1).max(80),
    ladder: z.string().min(1).max(60),
    mode: z.enum(['sampled', 'fixed', 'excluded']),
    weightOverride: z.number().int().min(1).max(30).optional(),
    rationale: z.string().max(200),
    evidenceIds: z.array(z.string().max(120)).max(10),
  }).strict()).max(40),
}).strict();