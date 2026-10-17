import { generateText } from 'ai';
import { model } from '../ai';
import { modelConfig } from '@/lib/model-config';
import { customSchema } from '@/domain/v2/custom';
import type { Character } from '@/domain/v2/types';
export async function prepareCustom(goal: string, profile: Character) {
  if (!modelConfig('LLM').API_KEY?.trim()) return {source:'rules',notice:'AI 暂不可用，请手动填写并确认两条行动方案。'};
  try {
    const result=await generateText({model:model(),maxRetries:0,maxOutputTokens:6000,abortSignal:AbortSignal.timeout(45000),system:'你是人生行动方案助手。把用户目标整理为两种不同且具体的行动方案（例如裸辞半年和边工作边找机会），不是行动与不行动，不套用车贷。只返回 JSON：{goal,months,assumptions,actions:[{name,upfront,phases:[{months,income,extraExpense}]}]}。所有金额为整数分。months 为1至360，两条方案各自阶段月数总和必须等于 months，每条最多12阶段。income 是该阶段每月全部税后收入（不是增量）；extraExpense 是原月生活费之外每月新增支出；upfront 是开局一次性支出。原生活费保持不变，原租金继续计入。没有新增贷款、奖金和自动工资增长，不模拟随机失业或职业机会，医疗与市场事件由引擎处理。不承诺找到工作、创业成功、教育回报。用户未提供的数值必须在 assumptions 中逐项注明为待确认的游戏假设，说明可能失败；不能声称是真实预测。所有值非负。不得替用户确认。',prompt:JSON.stringify({goal,profile})});
    const custom=customSchema.parse(JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')));
    return {source:'model',custom,notice:'AI 草拟了两条行动方案。所有收入、支出和持续期均需核对确认，不能视为现实预测。'};
  } catch {return {source:'rules',notice:'AI 整理失败或超时；请手动填写两条方案，仍可正常推演。'};}
}
