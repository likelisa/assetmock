import { z } from 'zod';
const amount = z.number().int().min(0).max(100000000000);
export const phaseSchema = z.object({ months: z.number().int().min(1).max(360), income: amount, extraExpense: amount }).strict();
export const actionSchema = z.object({ name: z.string().trim().min(1).max(80), upfront: amount, phases: z.array(phaseSchema).min(1).max(12) }).strict();
export const customSchema = z.object({ goal: z.string().trim().min(1).max(1000), months: z.number().int().min(1).max(360), assumptions: z.array(z.string().max(500)).max(20), actions: z.tuple([actionSchema, actionSchema]) }).strict().superRefine((v,ctx)=>{
  v.actions.forEach((a,i)=>{if(a.phases.reduce((s,p)=>s+p.months,0)!==v.months)ctx.addIssue({code:'custom',path:['actions',i,'phases'],message:'每条方案的阶段月数合计必须等于推演月数'});});
  if(v.actions[0].name===v.actions[1].name)ctx.addIssue({code:'custom',message:'请为两条行动方案填写不同名称'});
});
export type CustomGoal = z.infer<typeof customSchema>;
export function customPhase(goal: CustomGoal, index: number, month: number) {
  let end=0;return goal.actions[index].phases.find(p=>{end+=p.months;return month<=end;})!;
}
