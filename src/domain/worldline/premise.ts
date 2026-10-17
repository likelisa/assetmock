/**
 * 一句话前提：每条世界线都要能"一句话复述"。
 *
 * 只描述**真的发生过**的事（取自驱动返回的 events），强度档也只在相关事件真的发生时才写：
 * 抽到"大病高档"但这条线没生病，就不该在卡片上写"一次大病自付 20 万"。
 * 开销档与利率环境是长期状态，与事件无关，照常标注。
 */
import type { LineEvent, LineProfile } from './types';

export const eventKindLabels: Record<string, string> = {
  medical: '大额医疗支出',
  jobLoss: '收入中断',
  bonusDelay: '奖金延期',
  marketDrop: '投资下跌',
  career: '职业机会',
};

export function describeEvents(events: readonly LineEvent[], limit = 3): string {
  if (!events.length) return '没有发生冲击事件';
  const picked = events.slice(0, limit).map(event => `第${event.month}月${eventKindLabels[event.kind] ?? event.title}`);
  const rest = events.length - picked.length;
  return `${picked.join('；')}${rest > 0 ? `；另有 ${rest} 项` : ''}`;
}

/** 相关档位：长期状态总是写；事件档只在对应事件真的发生时才写 */
export function relevantTiers(
  line: { events: readonly LineEvent[]; profileLabels: Record<string, { label: string; eventKind?: string }> },
  limit = 2,
): string[] {
  const occurred = new Set(line.events.map(event => event.kind));
  return Object.values(line.profileLabels)
    .filter(tier => !tier.eventKind || occurred.has(tier.eventKind))
    .map(tier => tier.label)
    .slice(0, limit);
}

/** 前提 = 事件 + 相关档位 */
export function premiseOf(
  line: { events: readonly LineEvent[]; profileLabels: Record<string, { label: string; eventKind?: string }> },
  options: { eventLimit?: number; tierLimit?: number } = {},
): string {
  const base = describeEvents(line.events, options.eventLimit ?? 3);
  const tiers = relevantTiers(line, options.tierLimit ?? 2);
  return tiers.length ? `${base}；${tiers.join(' · ')}` : base;
}

/** 事件组合 + 档位签名：用于"别让四张卡讲同一个故事"的去重 */
export function signatureOf(events: readonly LineEvent[], profile: LineProfile): string {
  const kinds = [...new Set(events.map(event => event.kind))].sort().join('+') || 'none';
  const tiers = Object.keys(profile).sort().map(key => profile[key]).join(',');
  return `${kinds}@${tiers}`;
}
