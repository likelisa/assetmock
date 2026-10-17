/**
 * 适配器：把参数包 + 事件卡翻译成 v2 的纯数据 setup。
 *
 * 两张对照表都在这一层：
 *   1. 参数 key → v2 的 Draws 阈值（`draw.*.monthly` → `rules.probabilities`）；
 *   2. 事件卡 effect → v2 旋钮（医疗金额 / 跌幅 / 开销档 / 利率 / 月数上限）。
 *
 * 引擎一行不改：医疗金额、跌幅、利率、开销都是 `setup` 里的纯数据，
 * 而 `reveal()` 本来就是拿 `rules.probabilities` 与 draws 比较的。
 */
import { monthlyPayment } from '@/domain/money';
import type { Setup } from '@/domain/v2/types';
import type { EngineKnobs, LineProfile, WorldlineParams } from '@/domain/worldline/types';
import { cardIndex, laddersFromCards } from '../cards/index';
import type { CardLibrary, EventCard } from '../cards/types';
import { v2DrawThresholds } from './knobs';

export type CardIndex = Map<string, EventCard>;

export { WORLDLINE_RULES_VERSION } from './knobs';

/** 强度档梯度：由卡库分组得到；仅住房目标有 rate.env */
export function knobsFromCards(cards: CardLibrary, params: WorldlineParams, setup: Setup): EngineKnobs {
  const draws = v2DrawThresholds(params);
  return {
    ladders: laddersFromCards(cards, setup.input.target),
    status: draws.status,
    missing: draws.missing,
  };
}

/**
 * 一条世界线的 setup 变体：阈值 + 该线抽到的每张卡的效果。
 * 两条策略共用返回的这一份，配对才成立。
 */
export function variantSetup(
  setup: Setup,
  params: WorldlineParams,
  profile: LineProfile,
  cards: CardIndex,
): Setup {
  const draws = v2DrawThresholds(params);
  const rules = { ...setup.rules, probabilities: { ...draws.thresholds } };
  const ownProfile = { ...setup.profile };
  const plans = { ...setup.plans } as Setup['plans'];

  for (const cardId of Object.values(profile)) {
    const card = cards.get(cardId);
    if (!card) throw new Error(`未知事件卡：${cardId}`);
    const effect = card.effect;
    if (!(effect.livingDrift === undefined || (effect.livingDrift >= 0 && effect.livingDrift <= 1))) {
      throw new Error(`事件卡 ${card.id} 的开销档越界`);
    }
    if (effect.medicalCostMinor !== undefined) rules.medicalCost = effect.medicalCostMinor;
    if (effect.marketDropRate !== undefined) rules.marketDropRate = effect.marketDropRate;
    if (effect.livingDrift !== undefined) ownProfile.living = Math.round(setup.profile.living * (1 + effect.livingDrift));
    if (effect.monthsCap !== undefined) rules.months = Math.min(setup.rules.months, effect.monthsCap);
    if (effect.annualRate !== undefined) {
      for (const id of ['a', 'b'] as const) {
        const plan = plans[id];
        if (plan.method === 'full') continue;
        plans[id] = {
          ...plan,
          offer: { ...plan.offer, annualRate: effect.annualRate },
          payment: monthlyPayment(plan.principal, effect.annualRate, plan.term),
        };
      }
    }
  }

  return { ...setup, rules, profile: ownProfile, plans };
}

/** 给测试与 demo 用：按卡库新建一份索引 */
export function indexOfCards(cards: CardLibrary): CardIndex {
  return cardIndex(cards);
}
