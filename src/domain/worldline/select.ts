/**
 * ③ 统计筛选（可复现）：n 条 → 按统一标量排名分五档 → 挑最多 6 条代表 → 去重。
 *
 * 分档用**排名五档**（不是金额区间）：优 / 次优 / 中 / 次劣 / 劣。
 * 挑卡时**从差的一头留下**：劣 → 次劣 → 次优 → 中 → 优。
 * 所以 k=3 拿到的是「劣 / 次劣 / 次优」，k=5 才补齐「中」「优」，
 * k=6 时把样本最多的那一档对半拆开（同一档，多一条不同故事）。
 *
 * ④ 的"最能说服用户的那条"仍是 **Agent 的活**。
 */
import { premiseOf, signatureOf } from './premise';
import { median } from './scalars';
import type { Candidate, Tier, Worldline } from './types';
import { bandVerdicts, tierLabels } from './types';

export const MAX_CARDS = 6;

/** 从差到好：张数不够时优先留下前面的三档 */
const keepOrder: Tier[] = ['worst', 'secondWorst', 'secondBest', 'middle', 'best'];

export interface SelectOptions {
  /** 卡片张数，1..6 */
  k: number;
  /** 候选总数上限，默认 6（agent 上下文预算） */
  limit?: number;
  /** 每槽最多几条 */
  perSlot?: number;
}

export interface SelectResult {
  candidates: Candidate[];
  /** 各档样本数，页面用来标"这一档有多少条" */
  tierCounts: Record<Tier, number>;
}

export function strategyIdsOf(lines: readonly Worldline[]): string[] {
  return Object.keys(lines[0]?.strategies ?? {});
}

export function tierAt(position: number): Tier {
  if (position < 0.2) return 'worst';
  if (position < 0.4) return 'secondWorst';
  if (position < 0.6) return 'middle';
  if (position < 0.8) return 'secondBest';
  return 'best';
}

/** 给每条世界线打排名档位：同一个标量 worstUsable，排到哪一档就是哪一档 */
export function assignTiers(lines: readonly Worldline[]): Map<string, Tier> {
  const sorted = [...lines].sort((left, right) => left.worstUsable - right.worstUsable);
  const total = sorted.length;
  return new Map(sorted.map((line, rank) => [line.id, tierAt((rank + 0.5) / total)]));
}

export function labelOf(tier: Tier): string {
  return tierLabels[tier];
}

/** 距最严那道门槛的余量（负 = 已不足）。展示用，不参与判定。 */
export function marginOf(line: Worldline): number {
  const strictest = Math.max(...Object.values(line.strategies).map(strategy => strategy.floorMinor));
  return line.worstUsable - strictest;
}

export function toCandidate(line: Worldline, tier: Tier): Candidate {
  const byStrategy = {} as Candidate['byStrategy'];
  for (const [id, strategy] of Object.entries(line.strategies)) {
    byStrategy[id] = {
      strategyId: id,
      label: strategy.label,
      minBalanceMinor: strategy.minUsable,
      band: strategy.band,
      verdict: bandVerdicts[strategy.band],
      firstShortfall: strategy.firstShortfall,
    };
  }
  const shock = line.events.find(event => event.kind !== 'career')?.kind ?? null;
  return {
    id: line.id,
    band: line.worstBand,
    tier,
    label: labelOf(tier),
    premise: premiseOf(line),
    profile: line.profile,
    profileLabel: line.profileLabel,
    worstUsable: line.worstUsable,
    marginMinor: marginOf(line),
    cause: { shock, trigger: line.profileLabel ? 'tier' : null },
    series: Object.fromEntries(Object.entries(line.strategies).map(([id, strategy]) => [id, strategy.usable])) as Candidate['series'],
    byStrategy,
  };
}

type Slot = { tier: Tier; members: Worldline[] };

/** 五档分桶，按"从差到好"排列 */
export function buildSlots(lines: readonly Worldline[], tiers: Map<string, Tier>): Slot[] {
  const buckets = new Map<Tier, Worldline[]>();
  for (const line of lines) {
    const tier = tiers.get(line.id) ?? 'middle';
    const bucket = buckets.get(tier) ?? [];
    bucket.push(line);
    buckets.set(tier, bucket);
  }
  return keepOrder
    .filter(tier => (buckets.get(tier)?.length ?? 0) > 0)
    .map(tier => ({ tier, members: buckets.get(tier)! }));
}

function splitSlot(slot: Slot): Slot[] {
  if (slot.members.length < 2) return [slot];
  const sorted = [...slot.members].sort((left, right) => left.worstUsable - right.worstUsable);
  const mid = Math.ceil(sorted.length / 2);
  return [
    { tier: slot.tier, members: sorted.slice(mid) },
    { tier: slot.tier, members: sorted.slice(0, mid) },
  ];
}

/**
 * 张数少于档数 → 从最好的一头丢掉（保住 劣/次劣/次优）；
 * 张数多于档数 → 把样本最多的档对半拆，拆不动就停。
 */
export function fitSlots(slots: readonly Slot[], target: number): Slot[] {
  let current = [...slots];
  while (current.length > target) current = current.slice(0, -1);
  while (current.length < target) {
    const largest = current.reduce((best, slot, index) => (slot.members.length > current[best].members.length ? index : best), 0);
    if (current[largest].members.length < 2) break;
    const pieces = splitSlot(current[largest]);
    current = [...current.slice(0, largest), ...pieces, ...current.slice(largest + 1)];
  }
  return current;
}

function rankWithinSlot(slot: Slot): Worldline[] {
  const slotMedian = median(slot.members.map(line => line.worstUsable));
  return [...slot.members].sort((left, right) => {
    const failedLeft = Object.values(left.strategies).some(strategy => strategy.firstShortfall) ? 0 : 1;
    const failedRight = Object.values(right.strategies).some(strategy => strategy.firstShortfall) ? 0 : 1;
    if (failedLeft !== failedRight) return failedLeft - failedRight;
    if (left.events.length !== right.events.length) return left.events.length - right.events.length;
    const distanceLeft = Math.abs(left.worstUsable - slotMedian);
    const distanceRight = Math.abs(right.worstUsable - slotMedian);
    if (distanceLeft !== distanceRight) return distanceLeft - distanceRight;
    return left.id.localeCompare(right.id);
  });
}

export function selectCandidates(lines: readonly Worldline[], options: SelectOptions): SelectResult {
  const emptyCounts = { worst: 0, secondWorst: 0, middle: 0, secondBest: 0, best: 0 } as Record<Tier, number>;
  if (!lines.length) return { candidates: [], tierCounts: emptyCounts };

  const target = Math.min(MAX_CARDS, Math.max(1, Math.trunc(options.k)));
  const limit = Math.max(1, Math.trunc(options.limit ?? MAX_CARDS));
  const tiers = assignTiers(lines);
  const tierCounts = { ...emptyCounts };
  for (const tier of tiers.values()) tierCounts[tier] += 1;

  const fitted = fitSlots(buildSlots(lines, tiers), Math.min(target, limit));
  const used = new Set<string>();
  const picked: Array<{ line: Worldline; tier: Tier }> = [];
  // 一档一张：张数就是档数，不会因为"多给候选"而多出卡片
  const perSlot = Math.max(1, Math.trunc(options.perSlot ?? 1));
  for (const slot of fitted) {
    const ranked = rankWithinSlot(slot);
    let taken = 0;
    for (const line of ranked) {
      if (taken >= perSlot || picked.length >= limit) break;
      const signature = signatureOf(line.events, line.profile);
      if (used.has(signature)) continue;
      used.add(signature);
      picked.push({ line, tier: slot.tier });
      taken += 1;
    }
    if (taken === 0 && picked.length < limit) picked.push({ line: ranked[0], tier: slot.tier });
  }

  // 展示顺序：优 → 劣
  const quality = (tier: Tier) => keepOrder.indexOf(tier);
  const ordered = [...picked].sort((left, right) => {
    if (left.tier !== right.tier) return quality(right.tier) - quality(left.tier);
    return left.line.worstUsable - right.line.worstUsable;
  });
  return { candidates: ordered.map(item => toCandidate(item.line, item.tier)), tierCounts };
}

export { MAX_CARDS as MAX_CANDIDATES };
