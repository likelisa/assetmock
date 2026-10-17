import { ServiceError } from '../store';
import { openingDraft } from '../simulations/opening';
import { catalog } from '../v2/catalog';
import { characterFrom, type OpeningDraft } from '@/domain/simulation-opening';
import { calculate, rulesFor } from '@/domain/v2/setup';
import type { Setup, Target } from '@/domain/v2/types';
import { simulateWorldlines } from '@/domain/worldline';
import type { WorldlineRunResult } from '@/domain/worldline/types';
import { toRenderModel } from '@/domain/worldline/render-model';
import { cardEvidence, cardLibraryV1, defaultCardPlan, paramPackV1, validateCardPlan, type CardPlan } from './cards';
import { planFingerprint, v2WorldlineDeps, WORLDLINE_RULES_VERSION } from './adapter-v2';
import { runInputSchema } from './input';
import type { WorldlineRunInput } from './input';

const params = paramPackV1();
const cards = cardLibraryV1();

export const WORLD_LINE_ENGINE_VERSION = 'wl-0.1.0';

export type { WorldlineRunInput, WorldlineValues } from './input';


/** 默认方案：全款 + 30% 首付，与「未来可能性推演」原来的默认对比一致 */
const defaultPlans = (target: Target) => {
  const term = target === 'car' ? 36 : 360;
  const offer = catalog(target)[0];
  if (!offer) throw new ServiceError(422, '缺少示例贷款资料');
  return {
    offer,
    paths: [
      { method: 'full' as const, downPercent: 80, term, offerId: offer.id },
      { method: 'low' as const, downPercent: 30, term, offerId: offer.id },
    ],
  };
};

function priceOf(draft: OpeningDraft, target: Target): number {
  const fromGoal = draft.price ? Number(draft.price) : 0;
  if (Number.isFinite(fromGoal) && fromGoal > 0) return fromGoal;
  return target === 'car' ? 20000000 : 100000000;
}

/** 把简化确认值 + 底账草稿拼成 v2 的 Setup（只读底账，不写任何表） */
export function setupFromValues(draft: OpeningDraft, input: Pick<WorldlineRunInput, 'target' | 'values' | 'goalId' | 'sourceSignature'>): Setup {
  const target = input.target;
  const { offer, paths } = defaultPlans(target);
  const profile = characterFrom(
    {
      target,
      goalId: input.goalId,
      sourceSignature: input.sourceSignature,
      age: input.values.age,
      cash: input.values.cash,
      fund: input.values.fund,
      salary: input.values.salary,
      living: input.values.living,
      rent: input.values.rent,
      debt: input.values.debt,
      debtPayment: input.values.debtPayment,
      bonus: input.values.bonus,
      confirmed: true,
      acknowledgeRestrictions: true,
    },
    'ledger-worldline',
  );
  const { setup, errors } = calculate(
    { target, profileId: profile.id, price: priceOf(draft, target), paths },
    [offer],
    { profile, rules: rulesFor(target) },
  );
  if (errors.length) throw new ServiceError(422, errors.join(' '));
  return setup;
}

/** 首屏：底账草稿 + 默认值与缺口 */
export async function worldlineOpening(workspaceId: string, goalId: string | null) {
  const draft = await openingDraft(workspaceId, goalId);
  const missing: string[] = [];
  for (const key of ['salary', 'living'] as const) if (!draft.values[key]) missing.push(key);
  const target: Target = draft.target ?? 'car';
  return {
    target,
    goal: goalId,
    price: priceOf(draft, target).toString(),
    asOf: draft.asOf,
    sourceSignature: draft.sourceSignature,
    values: draft.values,
    assets: draft.assets,
    notes: draft.notes,
    missing,
    notice: '这些数字只作为本局的假设；世界线不会修改你的底账、目标和已选方案。',
  };
}

/** 卡目录（页面用它显示"这次假设的档位从哪来"） */
export function worldlineCards(target: Target) {
  return {
    cardsVersion: cards.version,
    paramsVersion: params.version,
    dataStatus: 'OK' as const,
    levels: cards.cards
      .filter(card => card.ladder !== 'narrative' && (!isHomeOnly(card.ladder) || target === 'home'))
      .map(card => ({
        id: card.id,
        ladder: card.ladder,
        title: card.title,
        premise: card.premise,
        weight: card.weight,
        effect: card.effect,
        evidence: cardEvidence(card, params).map(item => ({ key: item.key, label: item.label, basis: item.basis, sourceQuality: item.sourceQuality })),
      })),
    narrative: cards.cards.filter(card => card.ladder === 'narrative').map(card => ({ id: card.id, title: card.title, premise: card.premise })),
  };
}

function isHomeOnly(ladder: string) { return ladder === 'rate.env'; }

/** 跑一批世界线 */
export async function runWorldlines(workspaceId: string, raw: unknown, options: { plan?: CardPlan | null } = {}): Promise<{ result: WorldlineRunResult; model: ReturnType<typeof toRenderModel>; planId: string; planHash: string }> {
  const input = runInputSchema.parse(raw);
  const draft = await openingDraft(workspaceId, input.goalId);
  if (draft.sourceSignature !== input.sourceSignature) throw new ServiceError(409, '底账已更新，请重新载入');
  const setup = setupFromValues(draft, input);

  const months = Math.min(input.months ?? setup.rules.months, setup.rules.months);
  const maxN = months > 120 ? 200 : 600;
  const n = Math.min(input.n, maxN);
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);

  const plan = options.plan ?? input.cardPlan ?? defaultCardPlan(cards, input.target);
  const issues = validateCardPlan(plan as CardPlan, cards, input.target);
  if (issues.length) throw new ServiceError(422, `卡组未通过校验：${issues.slice(0, 3).map(issue => issue.problem).join('；')}`);

  const result = simulateWorldlines(
    {
      setup,
      input: {
        seed, n, k: input.k, months, params,
        engineVersion: WORLD_LINE_ENGINE_VERSION,
        worldlineRulesVersion: WORLDLINE_RULES_VERSION,
        v2RulesVersion: setup.rules.version,
        cardsVersion: cards.version,
        ...planFingerprint(plan as CardPlan),
      },
    },
    v2WorldlineDeps({ jobLoss: input.responsePolicy, career: input.careerPolicy }, { cards, plan: plan as CardPlan }),
  );

  return { result, model: toRenderModel(result), planId: (plan as CardPlan).id, planHash: planFingerprint(plan as CardPlan).cardPlanHash };
}
