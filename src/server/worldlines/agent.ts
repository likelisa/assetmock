import { z } from 'zod';
import { ServiceError } from '../store';
import { openingDraft } from '../simulations/opening';
import { cardEvidence, cardLibraryV1, defaultCardPlan, describePlan, validateCardPlan, type CardPlan } from './cards';
import { cardPlanSchema, toCardCatalogue, toToolPayload } from './tool-contract';
import { paramPackV1 } from './cards';
import { runWorldlines, type WorldlineValues } from './service';
import type { Target } from '@/domain/v2/types';

const params = paramPackV1();
const cards = cardLibraryV1();

const valueKeys = ['age', 'cash', 'fund', 'salary', 'living', 'rent', 'debt', 'debtPayment', 'bonus'] as const;
const valueLabels: Record<(typeof valueKeys)[number], string> = {
  age: '年龄', cash: '可动用现金', fund: '投资账户', salary: '月收入', living: '月生活费',
  rent: '租金', debt: '既有负债', debtPayment: '每月还本金', bonus: '年度奖金',
};

export const goalArg = z.object({ goalId: z.string().nullable().default(null) }).strict();

export const runArgs = z.object({
  goalId: z.string().nullable().default(null),
  n: z.number().int().min(20).max(600).default(200),
  months: z.number().int().min(1).max(360).nullable().default(null),
  seed: z.number().int().min(0).max(2147483647).nullable().default(null),
  k: z.number().int().min(1).max(6).default(6),
  responsePolicy: z.enum(['WAIT', 'LOWER', 'TEMPORARY']).default('WAIT'),
  careerPolicy: z.enum(['DECLINE', 'ACCEPT']).default('DECLINE'),
  cardPlan: cardPlanSchema.nullable().default(null),
}).strict();

export const detailArgs = runArgs.extend({ worldlineId: z.string().min(1).max(40) }).strict();

export const planArgs = z.object({ goalId: z.string().nullable().default(null), plan: cardPlanSchema }).strict();

/** 底账里的简化值必须齐；缺哪项就说缺哪项，不许替用户猜 */
function valuesFromDraft(draft: Awaited<ReturnType<typeof openingDraft>>): WorldlineValues {
  const missing = valueKeys.filter(key => draft.values[key] === null);
  if (missing.length) {
    throw new ServiceError(422, `底账还缺 ${missing.map(key => valueLabels[key]).join('、')}，请先在底账或确认预算里补齐，再跑世界线`);
  }
  const read = (key: (typeof valueKeys)[number]) => String(draft.values[key]);
  return {
    age: Number(read('age')),
    cash: read('cash'), fund: read('fund'), salary: read('salary'), living: read('living'),
    rent: read('rent'), debt: read('debt'), debtPayment: read('debtPayment'), bonus: read('bonus'),
  };
}

async function draftContext(workspaceId: string, goalId: string | null) {
  const draft = await openingDraft(workspaceId, goalId);
  const target: Target = draft.target ?? 'car';
  return { draft, target };
}

/** 读卡目录：agent 选卡之前先看有什么 */
export async function cardsForAgent(workspaceId: string, goalId: string | null) {
  const { target } = await draftContext(workspaceId, goalId);
  const catalogue = toCardCatalogue(cards, {
    target,
    plan: defaultCardPlan(cards, target),
    basesOf: cardId => cardEvidence(cards.cards.find(card => card.id === cardId)!, params).map(item => item.basis),
  });
  return {
    ...catalogue,
    instruction: '选卡时只能选档，不能改数值；排除整组梯度或砍掉最重档必须在 notes 里明说；每条判断写 rationale 并引用用户事实。',
  };
}

/** 校验 agent 提交的卡组（不落库，只回问题清单） */
export async function reviewPlanForAgent(workspaceId: string, goalId: string | null, rawPlan: unknown) {
  const { target } = await draftContext(workspaceId, goalId);
  const plan = cardPlanSchema.parse(rawPlan) as CardPlan;
  const issues = validateCardPlan({ ...plan, target: plan.target ?? undefined }, cards, target);
  return {
    ok: issues.length === 0,
    target,
    issues,
    summary: describePlan(plan, cards),
    next: issues.length ? '修正 issues 后重新提交' : '把这份卡组原样作为 simulateWorldlines 的 cardPlan 入参',
  };
}

/** 跑一批世界线（agent 入口：数值从底账来，不由 agent 提供） */
export async function runWorldlinesForAgent(workspaceId: string, raw: unknown) {
  const args = runArgs.parse(raw);
  const { draft, target } = await draftContext(workspaceId, args.goalId);
  const payload = {
    goalId: args.goalId,
    target,
    sourceSignature: draft.sourceSignature,
    values: valuesFromDraft(draft),
    n: args.n,
    months: args.months,
    seed: args.seed,
    k: args.k,
    responsePolicy: args.responsePolicy,
    careerPolicy: args.careerPolicy,
    cardPlan: args.cardPlan,
  };
  const { result } = await runWorldlines(workspaceId, payload);
  return toToolPayload(result);
}

/** 某条候选的逐月明细（重算，不查缓存）；只抽 ≤12 个月，别撑爆上下文 */
export async function worldlineDetailForAgent(workspaceId: string, raw: unknown) {
  const args = detailArgs.parse(raw);
  const { draft, target } = await draftContext(workspaceId, args.goalId);
  const { result } = await runWorldlines(workspaceId, {
    goalId: args.goalId,
    target,
    sourceSignature: draft.sourceSignature,
    values: valuesFromDraft(draft),
    n: args.n,
    months: args.months,
    seed: args.seed,
    k: args.k,
    responsePolicy: args.responsePolicy,
    careerPolicy: args.careerPolicy,
    cardPlan: args.cardPlan,
  });
  const candidate = result.candidates.find(item => item.id === args.worldlineId);
  if (!candidate) {
    throw new ServiceError(422, `候选里没有 ${args.worldlineId}；本次可用的是 ${result.candidates.map(item => item.id).join('、')}`);
  }
  const step = Math.max(1, Math.ceil(result.months / 12));
  const series = Object.fromEntries(Object.entries(candidate.series).map(([id, values]) => [
    id,
    values.flatMap((value, index) => (index % step === 0 || index === values.length - 1 ? [{ month: index + 1, usableMinor: value }] : [])),
  ]));
  return {
    worldlineId: candidate.id,
    premise: candidate.premise,
    label: candidate.label,
    band: candidate.band,
    byStrategy: candidate.byStrategy,
    series,
    seed: result.seed,
    n: result.n,
    months: result.months,
    paramsVersion: result.paramsVersion,
    cardPlanId: result.cardPlanId,
    cardPlanHash: result.cardPlanHash,
    evidenceIds: result.evidenceIds,
    note: '逐月数值是同一批假设下的重算结果；不是预测，也不代表现实会发生。',
  };
}
