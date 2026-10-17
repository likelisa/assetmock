/**
 * 通用契约（core 层）
 *
 * 铁律：**core 不认识任何具体业务**。这里没有 assetmock、没有 v2、没有车/房、
 * 没有 React、没有 HTTP、没有数据库，也**没有任何具体金额**。
 *
 * 它只知道四件事：
 *   1. 有一个 setup（不透明类型 TSetup）
 *   2. 有一串外部经历（tape，不透明类型 TDraws）
 *   3. 有 M 个策略，每个策略每月结算出一笔"可用资金"
 *   4. 每条线除了事件序列，还会抽一份"强度档组合"（LineProfile，纯标签）
 *
 * 具体结算规则由 `StepDriver` 注入，具体强度档由适配器把事件卡翻译成旋钮。
 */

export type Minor = number;
export type StrategyId = string;

/** bad = 可用资金 < 0；tight = 0 ≤ 可用资金 < 门槛；ok = 高于门槛 */
export type Band = 'bad' | 'tight' | 'ok';
export type Verdict = '能承受' | '需要调整' | '承受不了';

export const bandRank: Record<Band, number> = { bad: 0, tight: 1, ok: 2 };
export const bandLabels: Record<Band, string> = { bad: '不足', tight: '紧巴', ok: '乐观' };
export const bandVerdicts: Record<Band, Verdict> = { bad: '承受不了', tight: '需要调整', ok: '能承受' };

/** 排名五档：按统一标量 worstUsable 排，不是金额区间 */
export type Tier = 'worst' | 'secondWorst' | 'middle' | 'secondBest' | 'best';
export const tierLabels: Record<Tier, string> = { worst: '劣', secondWorst: '次劣', middle: '中', secondBest: '次优', best: '优' };

/* ────────────── 参数与出处 ────────────── */

export type ParamSource =
  | { kind: 'BUILTIN' }
  | {
    kind: 'SNAPSHOT';
    documentId: string;
    url: string;
    retrievedAt: string;
    documentVersion: string;
    /** 逐字引用；校验时必须在冻结正文里命中 */
    quote: string;
    /** 原文与官方转载并存时用；两处 quote 必须一致 */
    fallbackUrl?: string;
  }
  | { kind: 'USER'; confirmedAt: string };

/**
 * 三档，措辞互不混用：
 * - PUBLIC_STATISTIC：可写"公开统计显示……（出处）"
 * - DERIVED：写"由公开数据推得（公式）"
 * - PRESS_HYPOTHESIS：只能"我们假定……"
 *
 * 没有 WEB 分支：本期运行时零网络。
 */
export type ParamBasis = 'PUBLIC_STATISTIC' | 'DERIVED' | 'PRESS_HYPOTHESIS';

/** 公开统计的成色；只有 OFFICIAL 允许写"国家统计局数据" */
export type SourceQuality = 'OFFICIAL' | 'THIRD_PARTY' | 'THINK_TANK';

/**
 * 前四个是调研稿定的目录口径；最后一个 `EVENTS_PER_MILLION_PER_MONTH`
 * 是引擎自己的"每月每百万事件数"（v2 的 Draws 阈值就是它）。
 */
export type ParamUnit =
  | 'RATIO'
  | 'CNY_MINOR'
  | 'MONTHS'
  | 'DIMENSIONLESS'
  | 'EVENTS_PER_MILLION_PER_MONTH';

export interface Param {
  key: string;
  value: number;
  unit: ParamUnit;
  source: ParamSource;
  basis: ParamBasis;
  sourceQuality?: SourceQuality;
  /** 人话：页面与 agent 直接引用 */
  label: string;
  /** 仅 DERIVED */
  derivation?: { formula: string; inputs: string[] };
}

/** 事实层与假设层分开存：同一快照里既有公报的 5.2%，也有"我们假定……" */
export interface WorldlineParams {
  version: string;
  sha256?: string;
  facts: Param[];
  assumptions: Param[];
}

export interface ProvenanceEntry {
  param: string;
  value: number;
  unit: ParamUnit;
  label: string;
  basis: ParamBasis;
  sourceQuality?: SourceQuality;
  derivation?: { formula: string; inputs: string[] };
  url?: string;
  retrievedAt?: string;
  quote?: string;
}

/* ────────────── 强度档（事件卡落地的地方） ────────────── */

/**
 * 一条世界线的"强度档组合"：ladderKey → optionId。
 * core 只搬运标签，不解释含义；含义由适配器映射到 setup 的纯数据。
 */
export type LineProfile = Record<string, string>;

export interface LadderOption {
  /** 通常是事件卡 id，如 'card.medical.mid' */
  id: string;
  label: string;
  /** 抽样权重，正整数 */
  weight: number;
}

export interface Ladder {
  key: string;
  label: string;
  /**
   * 这条梯度对应哪一类事件；不填表示"长期状态"（如开销档、利率环境），
   * 与事件是否发生无关。卡片前提据此决定要不要写这一档。
   */
  eventKind?: string;
  /** 默认档：抽到它时卡片前提不额外标注，避免满屏噪声 */
  defaultOptionId: string;
  options: LadderOption[];
}

export interface EngineKnobs {
  ladders: Ladder[];
  status: 'OK' | 'DEGRADED';
  /** 参数包缺了、因而用了默认值的 key */
  missing: string[];
}

/* ────────────── 驱动端口 ────────────── */

export interface LineEvent {
  month: number;
  kind: string;
  title: string;
}

export interface StrategyStepMonth {
  status: 'running' | 'completed' | 'failed';
  /** 本月有账目 → 可用资金（分）；失败当月 → 由 core 用 -缺口 记账 */
  settledUsable: Minor | null;
  failure?: { month: number; shortfall: Minor };
}

export interface StrategySpec {
  id: StrategyId;
  label: string;
  /** 分档门槛 = (必需支出 + 到期月供) × 3，口径由适配器给 */
  floorMinor: Minor;
}

/* ────────────── 世界线与结果 ────────────── */

export interface StrategyLine {
  strategyId: StrategyId;
  label: string;
  months: number;
  /** 逐月可用资金；失败月记为 -缺口，之后沿用 */
  usable: Minor[];
  minUsable: Minor;
  endUsable: Minor | null;
  status: 'running' | 'completed' | 'failed';
  firstShortfall: { month: number; amountMinor: Minor } | null;
  floorMinor: Minor;
  band: Band;
}

export interface Worldline {
  id: string;
  index: number;
  profile: LineProfile;
  /** 非默认档的人类可读串，如 '生活开销 +5% · 大病自付中档'；全默认时为空串 */
  profileLabel: string;
  /** 每个非默认档的来源：label + 它对应的事件类别（长期状态为空） */
  profileLabels: Record<string, { label: string; eventKind?: string }>;
  events: LineEvent[];
  strategies: Record<StrategyId, StrategyLine>;
  /** 各策略里较差的那个判定值 —— 唯一判定标量 */
  worstUsable: Minor;
  worstBand: Band;
  /** 事件组合 + 强度档，用于去重"讲同一个故事"的卡 */
  signature: string;
}

export interface StrategyStats {
  strategyId: StrategyId;
  label: string;
  floorMinor: Minor;
  p5: Minor;
  p50: Minor;
  p90: Minor;
  mean: Minor;
  /** P90 − P5：波动幅度（分布级，不是单条线的属性） */
  fragility: Minor;
  bandCounts: Record<Band, number>;
  failedCount: number;
  shortfallCount: number;
}

export interface Candidate {
  id: string;
  band: Band;
  /** 排名五档（劣 / 次劣 / 中 / 次优 / 优） */
  tier: Tier;
  label: string;
  premise: string;
  profile: LineProfile;
  profileLabel: string;
  worstUsable: Minor;
  /** 距最严那道门槛的余量（负 = 已不足）。展示用，不参与判定。 */
  marginMinor: Minor;
  cause: { shock: string | null; trigger: string | null };
  /** 被选中这条线的逐月可用资金：只给渲染层画线，不进 agent 出参 */
  series: Record<StrategyId, Minor[]>;
  byStrategy: Record<StrategyId, {
    strategyId: StrategyId;
    label: string;
    minBalanceMinor: Minor;
    band: Band;
    verdict: Verdict;
    firstShortfall: { month: number; amountMinor: Minor } | null;
  }>;
}

export interface QuantilePoint { p5: Minor; p50: Minor; p90: Minor }

export interface WorldlineRunResult {
  seed: number;
  n: number;
  months: number;
  engineVersion: string;
  /** 世界线自己的规则版本（强度档梯度、应对策略枚举等建模选择） */
  worldlineRulesVersion: string;
  /** 复现时用到的 v2 规则版本 */
  v2RulesVersion: string;
  paramsVersion: string;
  paramsSha256?: string;
  /** 用到的卡库版本（没接卡库时为空） */
  cardsVersion?: string;
  /** agent 选的卡组：id + 哈希，报告里存着才能复述"我们假设了什么" */
  cardPlanId?: string;
  cardPlanHash?: string;
  dataStatus: 'OK' | 'DEGRADED';
  strategies: StrategySpec[];
  /** 世界线级分档计数（按 worstBand） */
  bands: Record<Band, number>;
  byStrategy: StrategyStats[];
  candidates: Candidate[];
  /** 每策略每条线的最小可用资金：右侧边际分布只需这一个数 */
  minUsables: Record<StrategyId, Minor[]>;
  /** 逐月 P5/P50/P90：折线带的传输口径 */
  quantilesByMonth: Record<StrategyId, QuantilePoint[]>;
  shortfallCount: number;
  claim: string;
  provenance: ProvenanceEntry[];
  evidenceIds: string[];
}

export interface SimulateInput {
  seed: number;
  n: number;
  k: number;
  months: number;
  params: WorldlineParams;
  engineVersion: string;
  worldlineRulesVersion: string;
  v2RulesVersion: string;
  cardsVersion?: string;
  cardPlanId?: string;
  cardPlanHash?: string;
  dataStatus?: 'OK' | 'DEGRADED';
  limitCandidates?: number;
}
