import {describe,it,expect} from 'vitest';
import {db} from '@/lib/db';
import {createAgentSession,startAgentMessage,executeAgentRun} from './five-agent-runtime';
import {confirmAgentProposal} from './agent-proposals';
import {getGoalFunding,saveGoalFunding,coordinateGoalFunding,adoptGoalFunding,prepareFundingProposal} from './goal-funding';
import {currentCarMonth,addMonths} from '@/domain/car-planning';
import {carContext} from './car-planning';
async function seed(){
 const w=await db.workspace.create({data:{}});
 await db.profile.create({data:{workspaceId:w.id,stableMonthlyIncomeMinor:1000000n,essentialExpenseMinor:500000n}});
 const a=await db.asset.create({data:{workspaceId:w.id,name:'存款',type:'CASH',currentValueMinor:20000000n,liquidityLevel:'HIGH',riskLevel:1,isAdjustable:true}});
 const session=await createAgentSession(w.id,{agentKey:'GOAL'});const initial=await getGoalFunding(w.id,session.id);
 const f={...initial.facts,purpose:'测试买车',budgetMinor:'18000000',targetMonth:addMonths(currentCarMonth(),12),landingFeesMinor:'1000000',runningMonthlyMinor:'100000',replacedTransportMinor:'0',monthlyPremiumMinor:'0',reserveFloorMinor:'6000000',cashflowConfirmed:true,insuranceConfirmed:true,constraintsConfirmed:true,costsConfirmed:true,sourcesConfirmed:true,otherGoalsConfirmed:true};
 await db.$transaction(tx=>saveGoalFunding(tx,w.id,session.id,{expectedVersion:null,sourceSignature:initial.sourceSignature,facts:f,confirmTarget:true}));
 return {w,a,session};
}
describe('goal funding lifecycle',()=>{
 it('retains the confirmed local purchase month at the first day boundary',async()=>{
  const w=await db.workspace.create({data:{}});const month=addMonths(currentCarMonth(),12);
  const goal=await db.goal.create({data:{workspaceId:w.id,name:'买车',type:'CAR_PURCHASE',targetAmountMinor:20000000n,targetDate:new Date(`${month}-01T00:00:00+08:00`)}});
  const session=await createAgentSession(w.id,{agentKey:'GOAL',goalId:goal.id});
  expect((await getGoalFunding(w.id,session.id)).facts.targetMonth).toBe(month);
 });

 it('creates a visible goal after generic target confirmation without adopting or reserving',async()=>{
  const w=await db.workspace.create({data:{}});const session=await createAgentSession(w.id,{agentKey:'GOAL'});
  const run=await startAgentMessage(w.id,session.id,{content:'一年后购买20万元汽车',clientMessageId:crypto.randomUUID()});let calls=0;
  const facts={name:'一年后购买20万元汽车',targetAmountMinor:'20000000',targetDate:`${addMonths(currentCarMonth(),12)}-17`,preparedAmountMinor:null,priority:null,reserveMinor:null,monthlyCostMinor:null,assetIds:[],confirmed:false};
  const answer={kind:'ANSWER',message:'请确认目标',toolName:null,argumentsJson:null,specialist:null,evidenceIds:[],missing:[]};
  await executeAgentRun(w.id,run.id,()=>{},{model:async()=>calls++===0?{...answer,kind:'CALL_TOOL',toolName:'proposeGoalDraft',argumentsJson:JSON.stringify({decisionId:null,facts})}:answer});
  const proposal=await db.agentProposal.findFirstOrThrow({where:{runId:run.id}});
  expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(0);
  await confirmAgentProposal(w.id,proposal.id,{version:proposal.version,confirm:true});
  await confirmAgentProposal(w.id,proposal.id,{version:proposal.version,confirm:true});
  const goal=await db.goal.findFirstOrThrow({where:{workspaceId:w.id}});
  expect(goal.type).toBe('CAR_PURCHASE');expect(goal.targetAmountMinor).toBe(20000000n);
  const state=await getGoalFunding(w.id,session.id);expect(state.goalId).toBe(goal.id);expect(state.facts.purpose).toBe(facts.name);expect(state.facts.budgetMinor).toBe('20000000');expect(state.activePlan).toBeNull();
  await db.$transaction(tx=>saveGoalFunding(tx,w.id,session.id,{expectedVersion:null,sourceSignature:state.sourceSignature,confirmTarget:true,facts:state.facts}));
  expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(1);expect(await db.goalDecision.count({where:{workspaceId:w.id}})).toBe(1);
  expect((await db.goal.findUniqueOrThrow({where:{id:goal.id}})).targetDate).toEqual(goal.targetDate);
  expect(await db.carFundingReservation.count({where:{workspaceId:w.id}})).toBe(0);expect(await db.goalFundingReservation.count({where:{workspaceId:w.id}})).toBe(0);
 });
 it('recovers an already confirmed legacy target without replaying chat or duplicating records',async()=>{
  const w=await db.workspace.create({data:{}});
  const d=await db.goalDecision.create({data:{workspaceId:w.id,title:'一年后购买20万元汽车',factsJson:JSON.stringify({name:'一年后购买20万元汽车',targetAmountMinor:'20000000',targetDate:`${addMonths(currentCarMonth(),12)}-17`,preparedAmountMinor:null,priority:null,reserveMinor:'6000000',monthlyCostMinor:'100000',assetIds:[],confirmed:true})}});
  const session=await db.agentSession.create({data:{workspaceId:w.id,agentKey:'GOAL',kind:'FIVE_AGENT',title:'历史买车目标',sourceRevision:0,decisionId:d.id}});
  const other=await db.workspace.create({data:{}});await expect(getGoalFunding(other.id,session.id)).rejects.toThrow('不存在');
  const recovered=await getGoalFunding(w.id,session.id);expect(recovered.goalId).toBeTruthy();expect(recovered.facts.reserveFloorMinor).toBe('6000000');expect(recovered.facts.runningMonthlyMinor).toBe('100000');
  const again=await getGoalFunding(w.id,session.id);expect(again.goalId).toBe(recovered.goalId);expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(1);
  expect(await db.carPlanVersion.count({where:{decision:{workspaceId:w.id}}})).toBe(0);
 });

 it('creates a goal before adoption, persists one plan and actions without actual money movement',async()=>{
  const {w,a,session}=await seed();const before=await getGoalFunding(w.id,session.id);expect(before.goalId).toBeTruthy();expect(before.activePlan).toBeNull();expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(1);
  const e=await coordinateGoalFunding(w.id,session.id);expect(e.scenarios[0].adoptable).toBe(true);expect(e.report?.scenarios[0].accounts).toHaveLength(4);
  const s=await getGoalFunding(w.id,session.id);const body={expectedVersion:s.decisionVersion,evaluationId:e.evaluationId,scenarioKey:e.recommendedKey,confirm:true};const plan=await adoptGoalFunding(w.id,session.id,body);const again=await adoptGoalFunding(w.id,session.id,body);expect(again.id).toBe(plan.id);
  const after=await getGoalFunding(w.id,session.id);expect(after.stage).toBe('已采用');expect(after.activePlan?.report).toBeTruthy();expect(after.actions.length).toBeGreaterThanOrEqual(3);for(const a of await db.action.findMany({where:{workspaceId:w.id}})){const details=JSON.parse(a.detailsJson??"{}");expect(details.prerequisites).toBeInstanceOf(Array);expect(details.steps).toBeInstanceOf(Array);}expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(1);expect((await db.asset.findUniqueOrThrow({where:{id:a.id}})).currentValueMinor).toBe(20000000n);expect(await db.liability.count({where:{workspaceId:w.id}})).toBe(0);
 });
 it('preserves adopted plan while saving an adjustment and blocks stale signatures',async()=>{
  const {w,session}=await seed();const e=await coordinateGoalFunding(w.id,session.id);const s=await getGoalFunding(w.id,session.id);await adoptGoalFunding(w.id,session.id,{expectedVersion:s.decisionVersion,evaluationId:e.evaluationId,scenarioKey:e.recommendedKey,confirm:true});
  const draft=await prepareFundingProposal(w.id,session.id,{maxMonthlyPaymentMinor:'300000'});await db.$transaction(tx=>saveGoalFunding(tx,w.id,session.id,draft));const after=await getGoalFunding(w.id,session.id);expect(after.activePlan?.version).toBe(1);expect(after.facts.maxMonthlyPaymentMinor).toBe('300000');expect(after.stale).toBe(true);
  await expect(db.$transaction(tx=>saveGoalFunding(tx,w.id,session.id,draft))).rejects.toThrow('已变化');
 });
 it('rejects cross-workspace, stale adoption, and duplicate source consumption',async()=>{
  const {w,session}=await seed();const other=await db.workspace.create({data:{}});await expect(getGoalFunding(other.id,session.id)).rejects.toThrow('不存在');
  const e=await coordinateGoalFunding(w.id,session.id);const s=await getGoalFunding(w.id,session.id);await db.workspace.update({where:{id:w.id},data:{portfolioRevision:{increment:1}}});
  await expect(adoptGoalFunding(w.id,session.id,{expectedVersion:s.decisionVersion,evaluationId:e.evaluationId,scenarioKey:e.recommendedKey,confirm:true})).rejects.toThrow('已变化');expect(await db.carFundingReservation.count({where:{workspaceId:w.id}})).toBe(0);
 });
 it('routes conversational car drafts through explicit confirmation and bounded coordination',async()=>{
  const w=await db.workspace.create({data:{}});const session=await createAgentSession(w.id,{agentKey:'GOAL'});
  const run=await startAgentMessage(w.id,session.id,{content:'明年买20万元车，保留6万元',clientMessageId:crypto.randomUUID()});let calls=0;
  const answer={kind:'ANSWER',message:'请核对确认卡',toolName:null,argumentsJson:null,specialist:null,evidenceIds:[],missing:[]};
  await executeAgentRun(w.id,run.id,()=>{},{model:async()=>calls++===0?{...answer,kind:'CALL_TOOL',toolName:'proposeFundingDraft',argumentsJson:JSON.stringify({purpose:'买车',budgetMinor:'20000000',targetMonth:addMonths(currentCarMonth(),12),reserveFloorMinor:'6000000'})}:answer});
  expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(0);
  const proposal=await db.agentProposal.findFirstOrThrow({where:{runId:run.id,operation:'CAR_FUNDING_DRAFT'}});
  await confirmAgentProposal(w.id,proposal.id,{version:proposal.version,confirm:true});await confirmAgentProposal(w.id,proposal.id,{version:proposal.version,confirm:true});
  expect(await db.goal.count({where:{workspaceId:w.id}})).toBe(1);
  const state=await getGoalFunding(w.id,session.id);expect(state.goalId).toBeTruthy();expect(state.activePlan).toBeNull();
  const e=await coordinateGoalFunding(w.id,session.id);expect(e.missing.length).toBeGreaterThan(0);expect(e.scenarios).toHaveLength(0);
  expect(await db.agentRun.count({where:{workspaceId:w.id,mode:'FUNDING_FACT_REVIEW'}})).toBe(3);
 });
 it('adopts quoted minimal financing',async()=>{
  const {w,session}=await seed();let s=await getGoalFunding(w.id,session.id);
  const offer={id:'verified36',label:'已核对36个月',quoted:true,annualRatePercent:'4',rateBasis:'NOMINAL_ANNUAL',termMonths:36,downPaymentPercent:20,maxPrincipalMinor:'16000000',feeMinor:'10000',method:'EQUAL_PAYMENT'};
  await db.$transaction(tx=>saveGoalFunding(tx,w.id,session.id,{expectedVersion:s.decisionVersion,sourceSignature:s.sourceSignature,confirmTarget:true,facts:{...s.facts,budgetMinor:'20000000',loanOffers:[offer]}}));
  const e=await coordinateGoalFunding(w.id,session.id);s=await getGoalFunding(w.id,session.id);const loan=e.scenarios.find(c=>c.method==='LOAN')!;expect(loan.adoptable).toBe(true);
  await adoptGoalFunding(w.id,session.id,{expectedVersion:s.decisionVersion,evaluationId:e.evaluationId,scenarioKey:loan.key,confirm:true});expect((await getGoalFunding(w.id,session.id)).activePlan?.scenario?.loanPayments).toHaveLength(36);
 });
 it('requires investment dates and fees and never unlocks protected assets',async()=>{
  const {w,session}=await seed();const state=await getGoalFunding(w.id,session.id);
  const fund=await db.asset.create({data:{workspaceId:w.id,name:'基金',type:'FUND',currentValueMinor:5000000n,isAdjustable:true,liquidityLevel:"HIGH",riskLevel:1}});
  const insurance=await db.asset.create({data:{workspaceId:w.id,name:'保单现金价值',type:'INSURANCE_CASH_VALUE',goalId:state.goalId,currentValueMinor:5000000n,isAdjustable:true,liquidityLevel:"HIGH",riskLevel:1}});
  const fundSource={assetId:fund.id,amountMinor:'5000000',availableMonth:currentCarMonth(),use:true};
  let c=await db.$transaction(tx=>carContext(tx,w.id,{...state.facts,sources:[...state.facts.sources,fundSource]},state.decisionId!));
  expect(c.missing).toContain('基金需要核对可用日期和动用费用');
  c=await db.$transaction(tx=>carContext(tx,w.id,{...state.facts,sources:[...state.facts.sources,{...fundSource,detailsConfirmed:true,feeMinor:'10000'},{...fundSource,assetId:insurance.id}]},state.decisionId!));
  expect(c.missing).not.toContain('基金需要核对可用日期和动用费用');expect(c.missing).toContain('保单现金价值受保护，不能列为购车来源');expect(c.sources.some(s=>s.assetId===insurance.id)).toBe(false);
 });
 it('links another conversation to the same goal and keeps concurrent adoption idempotent',async()=>{
  const {w,session}=await seed();const state=await getGoalFunding(w.id,session.id);const second=await createAgentSession(w.id,{agentKey:'GOAL',goalId:state.goalId!});expect((await getGoalFunding(w.id,second.id)).decisionId).toBe(state.decisionId);
  const e=await coordinateGoalFunding(w.id,session.id);const body={expectedVersion:state.decisionVersion,evaluationId:e.evaluationId,scenarioKey:e.recommendedKey,confirm:true};
  const results=await Promise.allSettled([adoptGoalFunding(w.id,session.id,body),adoptGoalFunding(w.id,second.id,body)]);expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(await db.carPlanVersion.count({where:{decisionId:state.decisionId!}})).toBe(1);
  const after=await getGoalFunding(w.id,second.id);expect(after.activePlan?.report?.evaluationId).toBe(e.evaluationId);
 });

});
