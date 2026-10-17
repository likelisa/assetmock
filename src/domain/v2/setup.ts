import { customSchema } from './custom';
import { z } from 'zod';
import { profiles } from '../fixtures';
import { monthlyPayment, multiply } from '../money';
import type { LoanOffer } from '../types';
import { ids, type Character, type Input, type Plan, type Rules, type Setup, type Target } from './types';

export const characters: Character[] = [
  ...profiles.map(p => ({ ...p, version: '0.2.0', target: 'car' as const, rent: 0, age: 30 })),
  ...[
    ['HOME-U01', '首付充足型', 600000, 100000, 20000, 10000, 3500, 20000],
    ['HOME-U02', '可全款型', 1200000, 200000, 30000, 14000, 4000, 30000],
    ['HOME-U03', '收支偏紧型', 550000, 50000, 12000, 8000, 3000, 0],
  ].map(([id, name, cash, fund, salary, living, rent, bonus]) => ({ id: String(id), name: String(name), description: '虚构购房角色 · 30岁', version: '0.2.0', target: 'home' as const, age: 30,
    cash: Number(cash) * 100, fund: Number(fund) * 100, salary: Number(salary) * 100, living: Number(living) * 100, rent: Number(rent) * 100, bonus: Number(bonus) * 100, bonusMonth: 4, debt: 0, debtPayment: 0 })),
];
export const planSchema = z.object({ method: z.enum(['full', 'low', 'high']), downPercent: z.number().int().min(20).max(80), term: z.number().int(), offerId: z.string().min(1).max(100) }).strict();
export const inputSchema = z.object({ custom: customSchema.optional(), target: z.enum(['car', 'home']), profileId: z.string(), price: z.number().int(), paths: z.tuple([planSchema, planSchema]) }).strict().superRefine((v, ctx) => {
  if (v.custom) { if(v.target !== 'car' || v.price !== 0) ctx.addIssue({code:'custom',message:'自定义目标不使用购置金额'}); return; }
  const home = v.target === 'home';
  if (v.price < (home ? 50000000 : 5000000) || v.price > (home ? 500000000 : 30000000)) ctx.addIssue({ code: 'custom', path: ['price'], message: '价格超出范围' });
  if (v.paths[0].method === v.paths[1].method) ctx.addIssue({ code: 'custom', path: ['paths'], message: '请选择两种不同付款方式' });
  v.paths.forEach((p, i) => { if (!(home ? [120, 240, 360] : [12, 24, 36, 60]).includes(p.term)) ctx.addIssue({ code: 'custom', path: ['paths', i, 'term'], message: '贷款期限无效' }); });
});
export function defaultInput(target: Target): Input {
  const home = target === 'home';
  const base = { term: home ? 360 : 36, offerId: home ? 'home-example' : 'loan-a' };
  return { target, profileId: home ? 'HOME-U01' : 'GAME-U01', price: home ? 100000000 : 20000000,
    paths: [{ ...base, method: home ? 'low' : 'full', downPercent: 30 }, { ...base, method: home ? 'high' : 'low', downPercent: home ? 50 : 30 }] };
}
export function rulesFor(target: Target): Rules {
  return { version: '0.2.0', months: target === 'home' ? 360 : 60, startMonth: '2026-11', probabilities: { medical: 1000, jobLoss: 2000, bonusDelay: 200000, marketDrop: 5000, career: 5000 }, medicalCost: 5000000, medicalDuration: 3, medicalCooldown: 12, jobCooldown: 12, careerCooldown: 24, marketDropRate: '0.2' };
}
export const methodLabel = { full: '全款', low: '低首付贷款', high: '高首付贷款' };
export function calculate(raw: unknown, offers: LoanOffer[], frozen?: Pick<Setup, 'profile' | 'rules' | 'source'>): { setup: Setup; errors: string[] } {
  const input = inputSchema.parse(raw);
  const profile = frozen?.profile ?? characters.find(p => p.id === input.profileId && p.target === input.target);
  if (!profile || profile.id !== input.profileId || profile.target !== input.target) throw new Error('角色与目标不匹配');
  if (input.custom) {
    const c=input.custom;
    if(frozen && 'input' in frozen && c.months!==frozen.rules.months) throw new Error('沿用经历重玩时不能改变推演月数');
    const offer: LoanOffer = { id:'custom-no-loan',name:'行动假设（无新增贷款）',annualRate:'0',fee:0,sourceType:'preset_fixture',documentId:'custom-actions',documentVersion:'1',defaultDownPaymentPercent:100,defaultTermMonths:12,excerpt:'用户确认的行动假设，不是金融产品。' };
    const plans=Object.fromEntries(ids.map((id,i)=>[id,{id,method:'full' as const,downPercent:100,term:c.months,offerId:offer.id,label:c.actions[i].name,down:c.actions[i].upfront,principal:0,payment:0,offer}])) as Setup['plans'];
    const rules={...(frozen?.rules ?? rulesFor('car')), version:'0.4.0' as const, months:c.months, probabilities:{...(frozen?.rules ?? rulesFor('car')).probabilities,jobLoss:0,career:0}};
    return {setup:{input,profile:structuredClone({...profile,bonus:0}),source:frozen?.source,plans,rules,runningCost:0,depreciation:0},errors:ids.flatMap(id=>plans[id].down>profile.cash?[`${plans[id].label}开局现金不足，缺口 ${((plans[id].down-profile.cash)/100).toFixed(2)} 元。`]:[])};
  }
  const plans = {} as Setup['plans'];
  const errors: string[] = [];
  ids.forEach((id, i) => {
    const p = input.paths[i];
    const offer = offers.find(o => o.id === p.offerId);
    if (!offer) throw new Error('贷款资料不存在');
    const full = p.method === 'full';
    const down = full ? input.price : multiply(input.price, String(p.downPercent / 100));
    const principal = input.price - down;
    const plan: Plan = { ...p, id, label: methodLabel[p.method], down, principal, payment: full ? 0 : monthlyPayment(principal, offer.annualRate, p.term), offer: structuredClone(offer) };
    plans[id] = plan;
    const shortfall = down + (full ? 0 : offer.fee) - profile.cash;
    if (shortfall > 0) errors.push(`${id.toUpperCase()} ${plan.label}开局现金不足，缺口 ${(shortfall / 100).toFixed(2)} 元。`);
  });
  return { setup: { source: frozen?.source, input, profile: structuredClone(profile), plans, rules: structuredClone(frozen?.rules ?? rulesFor(input.target)), runningCost: input.target === 'home' ? 100000 : 150000, depreciation: input.target === 'home' ? 0 : multiply(input.price, '0.01') }, errors };
}
