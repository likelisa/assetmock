/**
 * 卡组（CardPlan）：**agent 根据已知信息选择哪些卡参与这次推演**
 *
 * 权限划分：
 * - 引擎负责：怎么结算、频率阈值（参数包）、以及"至少留一条路"的结构约束；
 * - agent 负责：这张卡跟这个用户有没有关系（排除）、要不要把某一档钉死（判断）、
 *   以及每条判断的理由与依据（引用用户事实）。
 *
 * 三条不能被 agent 绕过的底线：
 * 1. **不能改数字**：卡片数值锁在参数包上，agent 只能选档，不能改金额/幅度/利率；
 * 2. **不能静默砍掉尾部**：把某梯度最重档排除，必须在 `notes` 里明说；否则校验失败；
 * 3. **判断必须带理由与依据**：每条 `rationale` 必填，涉及用户情况的判断要引 `evidenceIds`。
 *
 * 排除与钉档都是**可审计的选择**，不是"悄悄换个假设"。
 */
import type { Ladder, LineProfile } from '@/domain/worldline/types';
import { laddersFromCards } from './ladders';
import type { CardLibrary, EventCard } from './types';

export type CardPlanMode = 'sampled' | 'fixed' | 'excluded';

export interface CardPlanEntry {
  /** 这张卡（= 这个强度档） */
  cardId: string;
  /** 它所属的梯度，必须与卡库一致（防写错） */
  ladder: string;
  mode: CardPlanMode;
  /** sampled 时可覆写抽样权重（1..原权重×3），仍属"档位之间的相对权重"，不是改数值 */
  weightOverride?: number;
  /** agent 的判断，一句话 */
  rationale: string;
  /** 判断依据：用户事实 / 参数 / 上一轮工具结果 */
  evidenceIds: string[];
}

export interface CardPlan {
  id: string;
  version: string;
  /** 适用目标（'car' | 'home'）；与当次 setup 不一致会被拒 */
  target?: string;
  entries: CardPlanEntry[];
  /** 必须写清的取舍：比如"本用户无子女，养育成本不参与"、"尾部仍保留" */
  notes: string[];
}

export interface PlanIssue { card: string; problem: string }

/** 全卡按默认权重参与：没有 agent 判断时的基线 */
export function defaultCardPlan(library: CardLibrary, target?: string): CardPlan {
  return {
    id: 'plan.default',
    version: `plan.default@${library.version}`,
    target,
    entries: library.cards
      .filter(card => card.ladder !== 'narrative')
      .map(card => ({
        cardId: card.id,
        ladder: card.ladder,
        mode: 'sampled' as const,
        rationale: '默认卡组：所有档位按数据权重参与',
        evidenceIds: [],
      })),
    notes: ['默认卡组不针对具体用户做取舍；agent 可以改写它'],
  };
}

/** 列表顺序即严重度递增（卡库里就是这么排的），用它判断"最重档" */
function heaviest(ladder: Ladder): string | undefined {
  return ladder.options[ladder.options.length - 1]?.id;
}

export function validateCardPlan(plan: CardPlan, library: CardLibrary, target?: string): PlanIssue[] {
  const issues: PlanIssue[] = [];
  const cards = new Map(library.cards.map(card => [card.id, card]));
  const ladders = laddersFromCards(library, target);

  if (!plan.id?.trim()) issues.push({ card: plan.id ?? '(plan)', problem: '卡组缺少 id' });
  if (target && plan.target && plan.target !== target) {
    issues.push({ card: plan.id, problem: `卡组适用于 ${plan.target}，当前是 ${target}` });
  }

  const seen = new Set<string>();
  for (const entry of plan.entries) {
    const card = cards.get(entry.cardId);
    if (!card) { issues.push({ card: entry.cardId, problem: '卡库里没有这张卡' }); continue; }
    if (seen.has(entry.cardId)) issues.push({ card: entry.cardId, problem: '同一张卡重复出现' });
    seen.add(entry.cardId);
    if (entry.ladder !== card.ladder) issues.push({ card: entry.cardId, problem: `梯度写成 ${entry.ladder}，卡库是 ${card.ladder}` });
    if (!entry.rationale?.trim()) issues.push({ card: entry.cardId, problem: '缺少判断理由' });
    if (card.ladder === 'narrative' && entry.mode !== 'excluded') {
      issues.push({ card: entry.cardId, problem: '叙事卡不参与结算，只能标记为 excluded（或不出现在卡组里）' });
    }
    if (card.ladder === 'narrative' && entry.mode === 'excluded' && !entry.rationale?.trim()) {
      issues.push({ card: entry.cardId, problem: '叙事卡也要写清为什么不用它' });
    }
    if (entry.mode === 'excluded' && entry.cardId && !entry.evidenceIds.length && !entry.rationale.trim()) {
      issues.push({ card: entry.cardId, problem: '排除一张卡必须给理由' });
    }
    if (entry.weightOverride !== undefined) {
      if (entry.mode !== 'sampled') issues.push({ card: entry.cardId, problem: '只有 sampled 档才能改权重' });
      if (!Number.isInteger(entry.weightOverride) || entry.weightOverride < 1 || entry.weightOverride > card.weight * 3) {
        issues.push({ card: entry.cardId, problem: `权重覆写必须在 1..${card.weight * 3}` });
      }
    }
  }

  // 每一条梯度：不能被整组静默关掉；钉档时其余档必须排除；不能被单一钉档与抽样混用
  for (const ladder of ladders) {
    const entries = plan.entries.filter(entry => entry.ladder === ladder.key && entry.cardId);
    const kept = ladder.options.filter(option => entries.find(entry => entry.cardId === option.id)?.mode !== 'excluded');
    const fixed = entries.filter(entry => entry.mode === 'fixed');
    const wholeLadderExcluded = !kept.length;
    if (wholeLadderExcluded && !plan.notes.some(note => note.includes(ladder.key))) {
      issues.push({ card: ladder.key, problem: `整个梯度 ${ladder.key} 被排除，必须在 notes 里说明理由` });
    }
    if (fixed.length > 1) issues.push({ card: ladder.key, problem: `梯度 ${ladder.key} 同时钉了多档` });
    if (fixed.length === 1) {
      const pinned = fixed[0].cardId;
      const loose = entries.filter(entry => entry.mode === 'sampled' && entry.cardId !== pinned);
      if (loose.length) issues.push({ card: ladder.key, problem: `梯度 ${ladder.key} 已钉档 ${pinned}，其余档必须标 excluded` });
      if (!ladder.options.some(option => option.id === pinned)) issues.push({ card: pinned, problem: '钉的档不在这个梯度里' });
    }
    // 尾部保护：只砍最重档（其余档还在）时，必须明说；整组排除已由上面的 notes 检查覆盖
    const tail = heaviest(ladder);
    const tailEntry = entries.find(entry => entry.cardId === tail);
    if (!wholeLadderExcluded && tail && tailEntry?.mode === 'excluded' && !plan.notes.some(note => note.includes(tail))) {
      issues.push({ card: tail, problem: '排除了该梯度最重的一档，必须在 notes 里明说（不许静默砍尾部）' });
    }
  }
  return issues;
}

/** 卡组 → 梯度：排除的档不参与抽样；钉档的梯度退化为单档 */
export function laddersFromPlan(plan: CardPlan, library: CardLibrary, target?: string): Ladder[] {
  const base = laddersFromCards(library, target);
  const entries = new Map(plan.entries.map(entry => [entry.cardId, entry]));
  const result: Ladder[] = [];
  for (const ladder of base) {
    const kept = ladder.options.filter(option => entries.get(option.id)?.mode !== 'excluded');
    if (!kept.length) continue;
    const pinned = ladder.options.find(option => entries.get(option.id)?.mode === 'fixed');
    if (pinned) {
      result.push({ ...ladder, options: [{ id: pinned.id, label: pinned.label, weight: 1 }], defaultOptionId: ladder.defaultOptionId });
      continue;
    }
    result.push({
      ...ladder,
      options: kept.map(option => {
        const override = entries.get(option.id)?.weightOverride;
        return { ...option, weight: override ?? option.weight };
      }),
    });
  }
  return result;
}

/** 这次推演到底选了哪些卡（写进报告，便于复述"我们假设了什么"） */
export function planProfileCardIds(plan: CardPlan): string[] {
  return plan.entries.filter(entry => entry.mode !== 'excluded').map(entry => entry.cardId).sort();
}

/** 稳定的短哈希（纯函数，无依赖）；服务端存库时应改用 sha256 */
export function planHash(plan: CardPlan): string {
  const payload = JSON.stringify({
    id: plan.id,
    version: plan.version,
    target: plan.target ?? null,
    entries: [...plan.entries]
      .sort((a, b) => a.cardId.localeCompare(b.cardId))
      .map(entry => [entry.cardId, entry.mode, entry.weightOverride ?? null]),
  });
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < payload.length; i++) {
    hash ^= BigInt(payload.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, '0');
}

/** 给页面 / agent 复述的一句话摘要 */
export function describePlan(plan: CardPlan, library: CardLibrary): string {
  const cards = new Map(library.cards.map(card => [card.id, card]));
  const fixed = plan.entries.filter(entry => entry.mode === 'fixed')
    .map(entry => cards.get(entry.cardId)?.title ?? entry.cardId);
  const excluded = plan.entries.filter(entry => entry.mode === 'excluded')
    .map(entry => cards.get(entry.cardId)?.title ?? entry.cardId);
  const parts: string[] = [];
  if (fixed.length) parts.push(`钉住：${fixed.join('、')}`);
  if (excluded.length) parts.push(`排除：${excluded.join('、')}`);
  return parts.length ? parts.join('；') : '全部按数据权重参与';
}

/** 这条线抽到的档位（用于核对卡组是否真的生效） */
export function profileFromCardIds(cardIds: readonly string[], library: CardLibrary): LineProfile {
  const cards = new Map(library.cards.map(card => [card.id, card]));
  const profile: LineProfile = {};
  for (const id of cardIds) {
    const card = cards.get(id);
    if (card && card.ladder !== 'narrative') profile[card.ladder] = id;
  }
  return profile;
}

export type { EventCard };
