/**
 * 卡库 → 强度档梯度（Ladder[]）
 *
 * core 只看见 `Ladder`（key / label / options / defaultOptionId），看不见卡片内容。
 * 所以"哪张卡属于哪个梯度、要不要参与抽样、某个目标适不适用"全在这一层决定。
 */
import type { Ladder } from '@/domain/worldline/types';
import type { CardLibrary, EventCard } from './types';

/** 只对住房目标生效的梯度 */
const HOME_ONLY_LADDERS = new Set(['rate.env']);

/** 梯度 → 它对应的事件类别；不填 = 长期状态（与事件是否发生无关） */
const LADDER_EVENT_KIND: Record<string, string | undefined> = {
  'medical.severity': 'medical',
  'market.severity': 'marketDrop',
  'living.level': undefined,
  'rate.env': undefined,
};

/** 叙事卡不参与抽样：weight 必须为 0，且不属于任何梯度 */
export const NARRATIVE_LADDER = 'narrative';

export function cardsByLadder(library: CardLibrary): Map<string, EventCard[]> {
  const map = new Map<string, EventCard[]>();
  for (const card of library.cards) {
    if (card.ladder === NARRATIVE_LADDER) continue;
    const bucket = map.get(card.ladder) ?? [];
    bucket.push(card);
    map.set(card.ladder, bucket);
  }
  return map;
}

export function laddersFromCards(library: CardLibrary, target?: string): Ladder[] {
  const ladders: Ladder[] = [];
  for (const [key, cards] of cardsByLadder(library)) {
    if (target && HOME_ONLY_LADDERS.has(key) && target !== 'home') continue;
    const playable = cards.filter(card => card.weight > 0);
    if (!playable.length) continue;
    const fallback = playable[0];
    const eventKind = LADDER_EVENT_KIND[key];
    ladders.push({
      key,
      label: key,
      ...(eventKind ? { eventKind } : {}),
      defaultOptionId: (playable.find(card => card.isDefault) ?? fallback).id,
      options: playable.map(card => ({ id: card.id, label: card.title, weight: card.weight })),
    });
  }
  return ladders;
}

export function cardIndex(library: CardLibrary): Map<string, EventCard> {
  return new Map(library.cards.map(card => [card.id, card]));
}

export function narrativeCards(library: CardLibrary): EventCard[] {
  return library.cards.filter(card => card.ladder === NARRATIVE_LADDER || card.weight === 0);
}
