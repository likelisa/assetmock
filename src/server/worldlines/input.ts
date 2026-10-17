import { z } from 'zod';

/**
 * 世界线推演的入参契约。
 *
 * 刻意**宽容**：页面会把金额显示成"元"、浏览器会把数字给成字符串，
 * 这些都不该变成"参数无效"。语义校验（例如正负、上限）在服务层做，
 * 这里只保证"能读出数来"。
 */

const minorString = z.union([
  z.string().trim().regex(/^(0|[1-9]\d*)$/, '金额必须是非负整数分'),
  z.number().int().min(0).max(1_000_000_000_000).transform(value => String(value)),
]);

const age = z.coerce.number().refine(value => Number.isInteger(value) && value >= 18 && value <= 90, '年龄需在 18–90 之间');

export const worldlineValuesSchema = z.object({
  age,
  cash: minorString,
  fund: minorString,
  salary: minorString,
  living: minorString,
  rent: minorString,
  debt: minorString,
  debtPayment: minorString,
  bonus: minorString,
});

export type WorldlineValues = z.infer<typeof worldlineValuesSchema>;

const intIn = (min: number, max: number) => z.union([z.number(), z.string().trim().regex(/^\d+$/)])
  .transform(value => Number(value))
  .refine(value => Number.isInteger(value) && value >= min && value <= max, `需在 ${min}–${max} 之间`);

/** 卡组：宽进（缺 target/notes 也接受），严出由 validateCardPlan 负责 */
const cardPlanSchema = z.object({
  id: z.string().min(1).max(80),
  version: z.string().min(1).max(40).default('plan.v1'),
  target: z.enum(['car', 'home']).nullable().optional(),
  notes: z.array(z.string().max(200)).max(20).default([]),
  entries: z.array(z.object({
    cardId: z.string().min(1).max(80),
    ladder: z.string().min(1).max(60),
    mode: z.enum(['sampled', 'fixed', 'excluded']),
    weightOverride: z.number().int().min(1).max(30).optional(),
    rationale: z.string().max(200).default(''),
    evidenceIds: z.array(z.string().max(120)).max(10).default([]),
  })).max(40),
});

export const runInputSchema = z.object({
  goalId: z.string().nullable().optional().default(null),
  target: z.enum(['car', 'home']),
  sourceSignature: z.string().min(1),
  values: worldlineValuesSchema,
  n: intIn(20, 600).optional().default(200),
  months: intIn(1, 360).nullable().optional().default(null),
  seed: intIn(0, 2147483647).nullable().optional().default(null),
  k: intIn(1, 6).optional().default(6),
  responsePolicy: z.enum(['WAIT', 'LOWER', 'TEMPORARY']).optional().default('WAIT'),
  careerPolicy: z.enum(['DECLINE', 'ACCEPT']).optional().default('DECLINE'),
  cardPlan: cardPlanSchema.nullable().optional().default(null),
});

export type WorldlineRunInput = z.infer<typeof runInputSchema>;

/** 把 Zod 的问题翻译成人话，别再让用户看到车贷文案 */
export function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  const labels: Record<string, string> = {
    age: '年龄', cash: '可动用现金', fund: '投资账户', salary: '月收入', living: '月生活费',
    rent: '租金', debt: '既有负债', debtPayment: '每月还本金', bonus: '年度奖金',
    n: '世界线条数', months: '推演月数', seed: '随机种子', k: '卡片张数', target: '本局目标',
  };
  const shown = issues.slice(0, 4).map(issue => {
    const path = issue.path.filter(part => typeof part === 'string').map(String);
    const leaf = path[path.length - 1] ?? '';
    const name = labels[leaf] ?? leaf;
    return name ? `${name}：${issue.message}` : issue.message;
  });
  return shown.join('；');
}
