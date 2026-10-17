/**
 * 适配器出口：一行接起"通用引擎 + v2 业务 + 事件卡库 + agent 选的卡组"。
 *
 * 用法（服务层与测试都走这个）：
 *   const plan = agentSelectedPlan;                       // agent 根据已知信息选的卡组
 *   const deps = v2WorldlineDeps(policy, { cards, plan });
 *   const result = simulateWorldlines({ setup, input }, deps);
 *
 * 没有 plan 时用 `defaultCardPlan`（全部档位按数据权重参与），保证"没判断也能跑"。
 */
import type { Draws, Setup } from '@/domain/v2/types';
import { cardLibraryV1 } from '../cards/index';
import { defaultCardPlan, laddersFromPlan, planHash, type CardPlan } from '../cards/plan';
import type { CardLibrary } from '../cards/types';
import type { EngineKnobs } from '@/domain/worldline/types';
import type { SimulateDeps } from '@/domain/worldline/simulate';
import { indexOfCards, variantSetup } from './card-knobs';
import { sampleV2Draw, v2Driver, type V2Policy } from './driver';
import { v2DrawThresholds } from './knobs';

export interface WorldlineDepsOptions {
  /** 默认用内置卡库 cards.v1；测试可以塞小卡库 */
  cards?: CardLibrary;
  /** agent 选的卡组；不传 = 默认全卡 */
  plan?: CardPlan;
}

export function v2WorldlineDeps(policy: V2Policy, options: WorldlineDepsOptions = {}): SimulateDeps<unknown, Draws, Setup> {
  const library = options.cards ?? cardLibraryV1();
  const index = indexOfCards(library);
  return {
    driver: v2Driver(policy) as unknown as SimulateDeps<unknown, Draws, Setup>['driver'],
    sampleDraw: sampleV2Draw,
    variant: (setup, params, profile) => variantSetup(setup, params, profile, index),
    knobs: (params, setup): EngineKnobs => {
      const plan = options.plan ?? defaultCardPlan(library, setup.input.target);
      const draws = v2DrawThresholds(params);
      return {
        ladders: laddersFromPlan(plan, library, setup.input.target),
        status: draws.status,
        missing: draws.missing,
      };
    },
  };
}

/** 卡组的复现信息：塞进 input.cardPlanId / cardPlanHash */
export function planFingerprint(plan: CardPlan): { cardPlanId: string; cardPlanHash: string } {
  return { cardPlanId: plan.id, cardPlanHash: planHash(plan) };
}

export { defaultCardPlan, describePlan, laddersFromPlan, planHash, validateCardPlan } from '../cards/plan';
export type { CardPlan, CardPlanEntry, CardPlanMode } from '../cards/plan';
export { WORLDLINE_RULES_VERSION, indexOfCards, knobsFromCards, variantSetup } from './card-knobs';
export { demoOffer, demoSetup, makeRunLike } from './setup';
export {
  floorMinorOf, sampleV2Draw, selectionsForPolicy, v2Driver,
  type CareerPolicy, type ResponsePolicy, type V2Policy,
} from './driver';
export { DRAW_KEY_MAP, V2_DEFAULT_DRAWS, v2DrawThresholds } from './knobs';
