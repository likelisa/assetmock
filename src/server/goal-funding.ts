import { materializeConfirmedGoal } from './confirmed-goal';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '@/lib/db';
import { assetAccount } from '@/domain/account-classification';
import { carFactsSchema, currentCarMonth, type CarEvaluation, type CarScenario } from '@/domain/car-planning';
import { ApiError } from './portfolio';
import { encode } from './unified-store';
import { agentFacts } from './agent-context';
import { professionalFacts } from './specialist-bridge';
import { decisionDependencies, reconcileCarDependencies } from './car-decision-state';
import { adoptCarDecision, evaluateCarDecision } from './car-planning';

const goalMonth=(date:Date)=>date.toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,7);

export const fundingSaveSchema = z.object({ expectedVersion: z.number().int().nonnegative().nullable(), sourceSignature: z.string(), facts: carFactsSchema, confirmTarget: z.boolean().default(false) }).strict();
export const fundingPatchSchema = z.object({ bonuses: carFactsSchema.shape.bonuses.optional(), monthlyIncomeMinor: carFactsSchema.shape.monthlyIncomeMinor.optional(), livingExpensesMinor: carFactsSchema.shape.livingExpensesMinor.optional(), monthlyPremiumMinor: carFactsSchema.shape.monthlyPremiumMinor.optional(), purpose: z.string().max(400).optional(), budgetMinor: carFactsSchema.shape.budgetMinor.optional(), targetMonth: carFactsSchema.shape.targetMonth.optional(), landingFeesMinor: carFactsSchema.shape.landingFeesMinor.optional(), runningMonthlyMinor: carFactsSchema.shape.runningMonthlyMinor.optional(), replacedTransportMinor: carFactsSchema.shape.replacedTransportMinor.optional(), reserveFloorMinor: carFactsSchema.shape.reserveFloorMinor.optional(), maxMonthlyPaymentMinor: carFactsSchema.shape.maxMonthlyPaymentMinor.optional(), excludedAssetIds: z.array(z.string()).max(100).optional(), loanOffers: carFactsSchema.shape.loanOffers.optional() }).strict();
async function sessionFor(tx: Prisma.TransactionClient, workspaceId: string, sessionId: string) {
  const s = await tx.agentSession.findFirst({ where: { id: sessionId, workspaceId, agentKey: 'GOAL', kind: 'FIVE_AGENT', status: { not: 'CANCELLED' } } });
  if (!s) throw new ApiError('目标对话不存在或只读', 404);
  if (s.goalId) { const g = await tx.goal.findFirst({ where: { id: s.goalId, workspaceId, deletedAt: null } }); if (!g || g.type !== 'CAR_PURCHASE') throw new ApiError('本规划支持买车，请为买车创建新话题；其他目标保留原流程', 422); }
  return s;
}
async function linked(tx: Prisma.TransactionClient, workspaceId: string, s: { id: string; goalId: string | null; decisionId: string | null }) {
  const d = s.decisionId ? await tx.goalDecision.findFirst({ where: { id: s.decisionId, workspaceId } }) : null;
  return tx.carDecision.findFirst({ where: { workspaceId, OR: [{ goalSessionId: s.id }, ...(s.goalId ? [{ goalId: s.goalId }] : []), ...(d?.legacyDecisionId ? [{ id: d.legacyDecisionId }] : [])] }, orderBy: { updatedAt: 'desc' } });
}
async function signature(tx: Prisma.TransactionClient, workspaceId: string, s: {goalId: string | null; decisionId: string | null}) {
  return (await agentFacts(workspaceId, s.goalId, s.decisionId, tx)).signature;
}
async function initialFacts(tx: Prisma.TransactionClient, workspaceId: string, goalId: string | null) {
  const [w, pro, goal, reservations, generic] = await Promise.all([
    tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, include: { profile: true, assets: { where: { deletedAt: null } }, liabilities: { where: { deletedAt: null } } } }),
    professionalFacts(tx, workspaceId), goalId ? tx.goal.findFirst({ where: { id: goalId, workspaceId, deletedAt: null } }) : null,
    tx.carFundingReservation.findMany({ where: { workspaceId } }), tx.goalFundingReservation.findMany({ where: { workspaceId } }),
  ]);
  const debt = w.liabilities.reduce((v,l) => v + l.monthlyPaymentMinor, 0n);
  const b = pro.budget;
  const living = b ? BigInt(b.livingMinor) - (b.debtIncluded ? debt : 0n) + BigInt(b.extraFixedMinor) : w.profile ? w.profile.rentExpenseMinor + w.profile.transportExpenseMinor + w.profile.essentialExpenseMinor : null;
  return carFactsSchema.parse({ unifiedPlanning: true, purpose: goal?.name ?? '', budgetMinor: goal?.targetAmountMinor.toString() ?? null, targetMonth: goal ? goalMonth(goal.targetDate) : null,
    monthlyIncomeMinor: b?.incomeMinor ?? (w.profile ? (w.profile.stableMonthlyIncomeMinor+w.profile.otherMonthlyIncomeMinor).toString() : null), livingExpensesMinor: living === null ? null : (living > 0n ? living : 0n).toString(),
    monthlyPremiumMinor: pro.expenseReady ? ((b?.premiumsIncluded ? 0n : BigInt(pro.premiumMinor)) + (b?.proposedPremiumConfirmed ? BigInt(b.proposedPremiumMinor) : 0n)).toString() : null,
    sources: w.assets.map(a => { const holding = pro.holdings.find(h => h.assetId === a.id); const reserved = [...reservations,...generic].filter(r=>r.assetId===a.id).reduce((v,r)=>v+r.amountMinor,0n); return { assetId: a.id, amountMinor: (a.currentValueMinor > reserved ? a.currentValueMinor-reserved : 0n).toString(), availableMonth: holding?.availableOn?.slice(0,7) ?? (a.type==='CASH' ? currentCarMonth() : null), feeMinor: holding?.feeMinor ?? (a.type==='CASH' ? '0' : null), detailsConfirmed: Boolean(holding?.confirmed), use: a.currentValueMinor > reserved && a.isAdjustable && a.currency==='CNY' && (!a.goalId || a.goalId===goalId) && a.type!=='INSURANCE_CASH_VALUE'&&assetAccount(a)!=='protection' && (assetAccount(a)==='liquidity' || Boolean(goalId && a.goalId===goalId)) }; }),
  });
}
export async function getGoalFunding(workspaceId: string, sessionId: string) {
  await db.$transaction(tx=>reconcileCarDependencies(tx,workspaceId));
  return db.$transaction(async tx => {
    let s = await sessionFor(tx, workspaceId, sessionId);
    if (s.decisionId && !s.goalId) {
      await materializeConfirmedGoal(tx, workspaceId, s.decisionId);
      s = await sessionFor(tx, workspaceId, sessionId);
    }
    const row = await linked(tx, workspaceId, s);
    const facts = row ? carFactsSchema.parse(JSON.parse(row.factsJson)) : await initialFacts(tx, workspaceId, s.goalId);
    if (!row && s.decisionId) {
      const prior = await tx.goalDecision.findFirst({where:{id:s.decisionId,workspaceId,status:{not:'REDACTED'}}});
      const target = prior ? JSON.parse(prior.factsJson) : null;
      if (target?.confirmed) {
        facts.runningMonthlyMinor=target.monthlyCostMinor??null;
        facts.reserveFloorMinor=target.reserveMinor??null;
      }
    }
    const w = await tx.workspace.findUniqueOrThrow({where:{id:workspaceId}});
    const plan = row?.activePlanId ? await tx.carPlanVersion.findFirst({ where: { id: row.activePlanId, decisionId: row.id } }) : null;
    const snapshot = plan ? JSON.parse(plan.snapshotJson) as { scenario?: CarScenario; evaluation?: CarEvaluation; status?: string } : null;
    const latest = row ? await tx.carEvaluationRecord.findFirst({ where: { workspaceId, decisionId: row.id, status: { not: 'REDACTED' } }, orderBy: { createdAt: 'desc' } }) : null;
    const evaluation = row?.evaluationJson ? JSON.parse(row.evaluationJson) as CarEvaluation : latest ? JSON.parse(latest.resultJson) as CarEvaluation : null;
    const stale = Boolean(row && (!row.evaluationJson || evaluation?.portfolioRevision !== w.portfolioRevision || evaluation?.transactionRevision !== w.transactionRevision || evaluation?.asOfMonth !== currentCarMonth()));
    const planStale = Boolean(plan && (plan.sourceRevision !== w.portfolioRevision || plan.transactionRevision !== w.transactionRevision || snapshot?.evaluation?.asOfMonth !== currentCarMonth()));
    const unchangedAdopted = Boolean(plan && row && plan.factsJson === row.factsJson && !planStale);
    const stage = row?.status==='PURCHASED' ? '已购车' : unchangedAdopted ? '已采用' : planStale ? '需复盘' : stale || !evaluation ? '待补资料' : evaluation.missing.length ? '待补资料' : evaluation.scenarios.some(c=>c.adoptable) ? '待比较／待确认' : evaluation.scenarios.some(c=>c.feasible) ? '试算方案' : '无可行方案';
    const assets = await tx.asset.findMany({where:{workspaceId,deletedAt:null},orderBy:{id:'asc'}});
    // New assets enter the next draft unselected; deleted unused sources cannot trap the form.
    facts.sources = [...facts.sources.filter(source=>assets.some(a=>a.id===source.assetId)), ...assets.filter(a=>!facts.sources.some(source=>source.assetId===a.id)).map(a=>({assetId:a.id,amountMinor:a.currentValueMinor.toString(),availableMonth:a.type==='CASH'?currentCarMonth():null,feeMinor:a.type==='CASH'?'0':null,use:false}))];
    const goals = await tx.goal.findMany({where:{workspaceId,deletedAt:null,id:{not:s.goalId??''}},orderBy:{id:'asc'}});
    const actions = s.goalId ? await tx.action.findMany({where:{workspaceId,goalId:s.goalId,kind:'CAR_PLANNING'},orderBy:{createdAt:'desc'}}) : [];
    return { sessionId, goalId: s.goalId, decisionId: row?.id ?? null, decisionVersion: row?.version ?? null, sourceSignature: await signature(tx,workspaceId,s),
      facts, stage, stale: stale && !unchangedAdopted, planStale, evaluation,
      activePlan: plan && snapshot?.status!=='REDACTED' ? { id: plan.id, version: plan.version, adoptedAt: plan.adoptedAt.toISOString(), scenario: snapshot?.scenario, report: snapshot?.evaluation?.report } : null,
      assets: assets.map(a=>({id:a.id,name:a.name,type:a.type,account:assetAccount(a),balanceMinor:a.currentValueMinor.toString(),allowed:a.isAdjustable&&a.currency==='CNY'&&(!a.goalId||a.goalId===s.goalId)&&a.type!=='INSURANCE_CASH_VALUE'&&assetAccount(a)!=='protection'})),
      otherGoals: goals.map(g=>({id:g.id,name:g.name,preparedMinor:g.preparedAmountMinor.toString(),monthlyMinor:g.monthlyContributionMinor.toString()})),
      actions: actions.map(a=>({id:a.id,title:a.title,status:a.status,amountMinor:a.amountMinor?.toString()??null,dueDate:a.dueDate?.toISOString()??null})),
    };
  });
}
/** Called within both the direct confirmation and AgentProposal transactions. */
export async function saveGoalFunding(tx: Prisma.TransactionClient, workspaceId: string, sessionId: string, raw: unknown) {
  const input = fundingSaveSchema.parse(raw); const s=await sessionFor(tx,workspaceId,sessionId); const row=await linked(tx,workspaceId,s);
  if (row?.status==='PURCHASED') throw new ApiError('已购车，请使用实际费用复盘',409);
  if ((row?.version??null)!==input.expectedVersion || input.sourceSignature!==await signature(tx,workspaceId,s)) throw new ApiError('资料或草稿已变化，请刷新后核对',409);
  const claim=await tx.agentSession.updateMany({where:{id:s.id,workspaceId,version:s.version},data:{version:{increment:1}}});if(!claim.count)throw new ApiError('对话已变化',409);
  const facts=carFactsSchema.parse({...input.facts,unifiedPlanning:true});
  let goalId=s.goalId??row?.goalId??null;
  if (input.confirmTarget) {
    if(!facts.targetMonth||!facts.budgetMinor||BigInt(facts.budgetMinor)<=0n||!facts.purpose.trim()) throw new ApiError('请确认目标名称、金额和月份',422);
    // A live plan remains unchanged while discussing a replacement.
    if(!row?.activePlanId){
      const existingGoal=goalId?await tx.goal.findFirst({where:{id:goalId,workspaceId,deletedAt:null}}):null;
      const targetDate=existingGoal && goalMonth(existingGoal.targetDate)===facts.targetMonth?existingGoal.targetDate:new Date(`${facts.targetMonth}-01T00:00:00+08:00`);
      const data={name:facts.purpose,type:'CAR_PURCHASE',targetAmountMinor:BigInt(facts.budgetMinor),targetDate};
      const g=goalId?await tx.goal.update({where:{id:goalId},data}):await tx.goal.create({data:{...data,workspaceId,source:'AGENT_CONFIRMED'}});goalId=g.id;
      await tx.workspace.update({where:{id:workspaceId},data:{portfolioRevision:{increment:1}}});
    }
  }
  const w=await tx.workspace.findUniqueOrThrow({where:{id:workspaceId}});
  const data={factsJson:encode(facts),goalId,sourceRevision:w.portfolioRevision,dependenciesJson:encode(await decisionDependencies(tx,workspaceId,goalId)),evaluationJson:null};
  const d=row?await tx.carDecision.update({where:{id:row.id},data:{...data,version:{increment:1}}}):await tx.carDecision.create({data:{...data,workspaceId,goalSessionId:s.id}});
  const priorBridge=s.decisionId?await tx.goalDecision.findFirst({where:{id:s.decisionId,workspaceId,legacyDecisionId:null,activePlanId:null}}):null;
  const bridge=priorBridge?await tx.goalDecision.update({where:{id:priorBridge.id},data:{legacyDecisionId:d.id,goalId,title:facts.purpose||'买车草稿',version:{increment:1}}}):await tx.goalDecision.upsert({where:{legacyDecisionId:d.id},create:{workspaceId,legacyDecisionId:d.id,goalId,title:facts.purpose||'买车草稿',factsJson:encode({name:facts.purpose,targetAmountMinor:facts.budgetMinor,targetDate:facts.targetMonth?`${facts.targetMonth}-01`:null})},update:{goalId,title:facts.purpose||'买车草稿',version:{increment:1}}});
  await tx.agentSession.update({where:{id:s.id},data:{goalId,decisionId:bridge.id,updatedAt:new Date()}});
  return {decisionId:d.id,goalId,version:d.version};
}
export async function prepareFundingProposal(workspaceId: string, sessionId: string, raw: unknown) {
  const patch=fundingPatchSchema.parse(raw);const state=await getGoalFunding(workspaceId,sessionId);
  const {excludedAssetIds,...values}=patch;
  if(excludedAssetIds?.some(id=>!state.assets.some(a=>a.id===id)))throw new ApiError('排除资产不属于当前底账',422);
  const facts=carFactsSchema.parse({...state.facts,...values,unifiedPlanning:true,...(excludedAssetIds?{sources:state.facts.sources.map(s=>({...s,use:excludedAssetIds.includes(s.assetId)?false:s.use}))}:{}),constraintsConfirmed:false,costsConfirmed:false,sourcesConfirmed:false,...(patch.monthlyIncomeMinor!==undefined||patch.livingExpensesMinor!==undefined?{cashflowConfirmed:false}:{}),...(patch.monthlyPremiumMinor!==undefined?{insuranceConfirmed:false}:{})});
  return {expectedVersion:state.decisionVersion,sourceSignature:state.sourceSignature,facts,confirmTarget:Boolean(facts.purpose&&facts.targetMonth&&facts.budgetMinor&&BigInt(facts.budgetMinor)>0n)};
}
/** Bounded, rule-based professional review. The LLM explains these recorded checks. */
export async function coordinateGoalFunding(workspaceId:string,sessionId:string,parentRunId?:string) {
  const state=await getGoalFunding(workspaceId,sessionId);
  if(!state.decisionId||state.decisionVersion===null||!state.goalId)throw new ApiError('请先确认买车目标与规划资料',422);
  if(!state.facts.unifiedPlanning)throw new ApiError('请先核对并保存为统一规划草稿',422);
  const run=await db.agentRun.create({data:{workspaceId,sessionId,parentRunId:parentRunId??null,agentKey:'WEALTH',mode:'FUNDING_COORDINATION',status:'RUNNING',requestId:crypto.randomUUID(),sourceSignature:state.sourceSignature,promptVersion:'funding-coordinator-v1',model:'deterministic',inputJson:encode({decisionId:state.decisionId}),leaseUntil:new Date(Date.now()+120000)}});
  try {
    const checks = [
      { key: 'CASHFLOW', pattern: /收入|支出|收支|债务|月投入|预算/, evidence: { incomeMinor: state.facts.monthlyIncomeMinor, livingMinor: state.facts.livingExpensesMinor, confirmed: state.facts.cashflowConfirmed } },
      { key: 'INSURANCE', pattern: /保费|保障|保单|年度费用/, evidence: { monthlyPremiumMinor: state.facts.monthlyPremiumMinor, coverageNotes: state.facts.coverageNotes, confirmed: state.facts.insuranceConfirmed } },
      { key: 'INVESTMENT', pattern: /资金|资产|来源|持仓|可用|费用|长期|储备/, evidence: { sources: state.facts.sources, confirmed: state.facts.sourcesConfirmed } },
    ];
    for (const check of checks) await db.agentRun.create({data:{workspaceId,sessionId,parentRunId:run.id,agentKey:check.key,mode:'FUNDING_FACT_REVIEW',status:'RUNNING',requestId:`${run.id}:${check.key}`,sourceSignature:state.sourceSignature,promptVersion:'funding-check-v1',model:'deterministic',inputJson:encode(check.evidence),leaseUntil:run.leaseUntil}});
    const evaluation=await evaluateCarDecision(workspaceId,state.decisionId,state.decisionVersion);
    for (const check of checks) {
      const missing = evaluation.missing.filter(item => check.pattern.test(item));
      await db.agentRun.updateMany({where:{workspaceId,parentRunId:run.id,agentKey:check.key},data:{status:missing.length?'PARTIAL':'COMPLETED',resultJson:encode({method:'已录入资料与程序规则核对',evidence:check.evidence,missing,evaluationId:evaluation.evaluationId,sourceSignature:evaluation.sourceSignature}),completedAt:new Date()}});
    }
    await db.agentRun.update({where:{id:run.id},data:{status:evaluation.missing.length?'PARTIAL':'COMPLETED',resultJson:encode(evaluation),completedAt:new Date()}});
    return evaluation;
  }catch(e){await db.agentRun.updateMany({where:{workspaceId,parentRunId:run.id,status:'RUNNING'},data:{status:'FAILED',completedAt:new Date(),resultJson:encode({error:'核对未完成，可重新生成；上次结果保留'})}});await db.agentRun.update({where:{id:run.id},data:{status:'FAILED',resultJson:encode({error:e instanceof Error?e.message:'计算未完成'}),completedAt:new Date()}});throw e;}
}
export async function adoptGoalFunding(workspaceId:string,sessionId:string,raw:unknown){
  const input=z.object({expectedVersion:z.number().int(),evaluationId:z.string(),scenarioKey:z.string(),confirm:z.literal(true)}).strict().parse(raw);
  const s=await sessionFor(db,workspaceId,sessionId);const d=await linked(db,workspaceId,s);if(!d)throw new ApiError('规划不存在',404);
  const {confirm,...body}=input;void confirm;return adoptCarDecision(workspaceId,d.id,body);
}
