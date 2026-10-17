/**
 * 事件卡库出口。
 *
 * 用法：
 *   const params = paramPackV1();
 *   const cards = cardLibraryV1();
 *   validateCards(cards, params);          // 数值与出处对拍
 *   laddersFromCards(cards, 'car');        // 交给 core 抽档
 */
export * from './types';
export { paramPackV1 } from './params.v1';
export { cardLibraryV1 } from './library';
export {
  cardsByLadder, cardIndex, laddersFromCards, narrativeCards, NARRATIVE_LADDER,
} from './ladders';
export { validateCards, cardEvidence } from './validate';
export {
  defaultCardPlan, validateCardPlan, laddersFromPlan, planHash, describePlan,
  planProfileCardIds, profileFromCardIds,
  type CardPlan, type CardPlanEntry, type CardPlanMode, type PlanIssue,
} from './plan';
