/**
 * 事件卡（数据层）
 *
 * 一张卡 = 一个"冲击强度档" + 一句可复述的前提 + 它引用的真实数据。
 *
 * 为什么是"档"而不是"新事件"：v2 引擎只有 5 类事件（医疗/失业/奖金延期/下跌/职业机会），
 * 且金额、时长、跌幅都是 `rules` 里的纯数据。要加事件种类就得改 `engine.ts`，
 * 与"零侵入"冲突。所以卡片的做法是：**频率仍由概率决定，强度由卡片分档**，
 * 每档把合法数值写进该条世界线的 `setup`（和 §3.7 的开销档同一手法）。
 *
 * 卡片本身不认识引擎：`effect` 是一组引擎旋钮的"建议值"，
 * 由适配器（adapters/assetmock-v2/card-knobs.ts）翻译成 `setup`。
 */
import type { LineProfile, Param } from '@/domain/worldline/types';

/** 数据门类，与调研稿 §1 一致 */
export type CardCategory = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';

/** 权重 0 = 不参与抽样（叙事卡，只进报告与 agent 论据） */
export interface EventCard {
  id: string;
  /** 强度档梯度名；叙事卡用 'narrative' */
  ladder: string;
  category: CardCategory;
  weight: number;
  /** 是否该梯度的默认档（默认档不写进卡片前提，避免满屏噪声） */
  isDefault?: boolean;
  title: string;
  /** 卡片正面前提：一句话，可复述 */
  premise: string;
  /** 引擎旋钮建议值（纯数据），由适配器翻译 */
  effect: CardEffect;
  /** 引用的参数 key；必须在参数包里找得到 */
  params: string[];
  /** 能说什么 */
  canSay: string[];
  /** 不许说什么（口径红线，逐条对应调研稿警告） */
  cantSay: string[];
}

export interface CardEffect {
  /** 单次医疗自付（分）→ rules.medicalCost */
  medicalCostMinor?: number;
  /** 单次投资下跌幅度（Decimal 字符串）→ rules.marketDropRate */
  marketDropRate?: string;
  /** 生活开销整线偏移（0.05 = +5%）→ profile.living */
  livingDrift?: number;
  /** 放款名义利率（Decimal 字符串）→ plans[].offer.annualRate（仅贷款方案） */
  annualRate?: string;
  /** 推演月数上限 → rules.months */
  monthsCap?: number;
}

export interface CardLibrary {
  version: string;
  cards: EventCard[];
}

export interface CardContext {
  /** 参数索引：key → Param */
  params: Map<string, Param>;
  /** 目标（'car' | 'home'）；用来判断某张卡是否适用于本局 */
  target?: string;
}

export interface CardIssue { card: string; problem: string }

export type { LineProfile };
