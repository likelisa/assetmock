import { materializeConfirmedGoal } from './confirmed-goal';
import { saveGoalFunding } from "./goal-funding";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, serialize } from "./portfolio";
import { encode, recordRevision } from "./unified-store";
import { agentFacts } from "./agent-context";
import { goalFactsSchema } from "@/domain/agents";
import { assessGenericGoal } from "./goal-capabilities";
import { applyManagerCommand } from "./specialist-managers";
import { applyActionTransition } from "./execution-results";
import { saveConstraint } from "./decision-database";

const confirmationSchema=z.object({version:z.number().int().positive(),confirm:z.literal(true)}).strict();
export async function confirmAgentProposal(workspaceId:string,id:string,raw:unknown){
 const input=confirmationSchema.parse(raw);
 const prior=await db.agentProposal.findFirst({where:{workspaceId,id},include:{run:{include:{session:true}}}});
 if(!prior)throw new ApiError("确认事项不存在",404);
 if(prior.status==="CONFIRMED")return serialize({proposal:prior,result:JSON.parse(prior.resultJson)});
 if(prior.status!=="PENDING"||prior.version!==input.version)throw new ApiError("确认卡已失效",409);
 const fresh=await agentFacts(workspaceId,prior.run.session.goalId,prior.run.session.decisionId);
 if(prior.sourceSignature!==fresh.signature)throw new ApiError("资料已变化，请重新核对并生成确认卡",409);
 return db.$transaction(async tx=>{
  const w=await tx.workspace.findUniqueOrThrow({where:{id:workspaceId}});
  if(w.portfolioRevision!==fresh.revision||w.professionalRevision!==fresh.professionalRevision||w.transactionRevision!==fresh.transactionRevision||w.dataEpoch!==fresh.dataEpoch)throw new ApiError("资料已变化",409);
  const p=await tx.agentProposal.findFirstOrThrow({where:{id,workspaceId}});
  if(p.status==="CONFIRMED")return serialize({proposal:p,result:JSON.parse(p.resultJson)});
  const claim=await tx.agentProposal.updateMany({where:{id,workspaceId,status:"PENDING",version:input.version},data:{status:"COMMITTING"}});
  if(!claim.count)throw new ApiError("确认卡已变化",409);
  const data=JSON.parse(p.dataJson); let result:unknown;
  if(p.operation==="CAR_FUNDING_DRAFT"){
   result=await saveGoalFunding(tx,workspaceId,prior.run.sessionId,data.planning);
  }else if(p.operation==="MANAGER"){
   await applyManagerCommand(tx,workspaceId,data);result={command:data.command,saved:true};
  }else if(p.operation==="CONSTRAINT"){
   result=await saveConstraint(tx,workspaceId,data);
  }else if(p.operation==="ACTION"){
   result=await applyActionTransition(tx,workspaceId,data.actionId,data.status,data.reason);
  }else if(p.operation==="GOAL_FACTS"){
   const facts=goalFactsSchema.parse({...data.facts,confirmed:true});
   if(data.decisionId){const old=await tx.goalDecision.findFirst({where:{workspaceId,id:data.decisionId}});if(!old||old.status==="REDACTED")throw new ApiError("决策不存在",409);result=await tx.goalDecision.update({where:{id:old.id},data:{title:facts.name,factsJson:encode(facts),version:{increment:1}}});}
   else result=await tx.goalDecision.create({data:{workspaceId,title:facts.name,goalId:data.goalId,factsJson:encode(facts)}});
   await tx.workspace.update({where:{id:workspaceId},data:{portfolioRevision:{increment:1}}});
   const d=result as {id:string};await tx.agentSession.update({where:{id:prior.run.sessionId},data:{decisionId:d.id,version:{increment:1}}});
   const goalId=await materializeConfirmedGoal(tx,workspaceId,d.id);
   if(goalId)await tx.agentSession.update({where:{id:prior.run.sessionId},data:{goalId}});
  }else if(p.operation==="ADOPT_PLAN"){
   const e=await tx.goalEvaluationRecord.findFirst({where:{workspaceId,id:data.evaluationId,status:"FEASIBLE"}});
   if(!e||e.sourceSignature!==fresh.signature)throw new ApiError("评估已过期",409);
   const d=await tx.goalDecision.findFirstOrThrow({where:{id:e.decisionId,workspaceId}});
   if(d.version!==e.decisionVersion||d.legacyDecisionId)throw new ApiError("决策已变化，请重新计算",409);
   const f=goalFactsSchema.parse(JSON.parse(d.factsJson));const evaluated=assessGenericGoal(f,fresh,d.goalId,d.id);
   if(evaluated.status!=="FEASIBLE")throw new ApiError("当前方案不满足约束",422);
   const scenario=evaluated.scenarios[0];
   const goal=d.goalId?await tx.goal.findFirstOrThrow({where:{id:d.goalId,workspaceId,deletedAt:null}}):await tx.goal.create({data:{workspaceId,type:"OTHER",name:f.name,targetAmountMinor:BigInt(f.targetAmountMinor!),targetDate:new Date(`${f.targetDate}T00:00:00+08:00`),priority:f.priority??2,priorityConfirmedAt:f.priority?new Date():null,source:"AGENT_CONFIRMED"}});
   await tx.goalFundingReservation.deleteMany({where:{workspaceId,decisionId:d.id}});
   let remaining=BigInt(f.targetAmountMinor!);let protectedRemainder=BigInt(evaluated.minimumReserveMinor??f.reserveMinor??"0");
   for(const fund of evaluated.funding){
    const asset=await tx.asset.findFirstOrThrow({where:{id:fund.assetId,workspaceId,deletedAt:null}});
    const other=(await tx.goalFundingReservation.aggregate({where:{workspaceId,assetId:asset.id},_sum:{amountMinor:true}}))._sum.amountMinor??0n;
    const legacy=(await tx.carFundingReservation.aggregate({where:{workspaceId,assetId:asset.id},_sum:{amountMinor:true}}))._sum.amountMinor??0n;
    let available=asset.currentValueMinor-other-legacy-BigInt(fund.feeMinor);if(fund.protected||available<0n)available=0n;
    const reserve=protectedRemainder>available?available:protectedRemainder;available-=reserve;protectedRemainder-=reserve;
    const use=remaining<available?remaining:available;
    if(use>0n){await tx.goalFundingReservation.create({data:{workspaceId,decisionId:d.id,assetId:asset.id,amountMinor:use}});remaining-=use;}
   }
   const months=evaluated.months??0;
   const monthly=months>0?(remaining+BigInt(months-1))/BigInt(months):0n;
   const last=await tx.goalPlanVersion.aggregate({where:{decisionId:d.id},_max:{version:true}});
   await tx.goalPlanVersion.updateMany({where:{workspaceId,decisionId:d.id,status:"ACTIVE"},data:{status:"SUPERSEDED"}});
   const plan=await tx.goalPlanVersion.create({data:{workspaceId,decisionId:d.id,evaluationId:e.id,version:(last._max.version??0)+1,snapshotJson:encode({facts:f,scenario,evaluation:evaluated,decisionMemory:{constraints:fresh.constraints,preferenceEvidence:fresh.memories,reasons:{status:"NOT_PROVIDED",items:[]},assumptions:{budget:fresh.budget,insuranceNeed:fresh.insuranceNeed,holdings:fresh.holdings}},sourceSignature:fresh.signature,confirmedAt:new Date().toISOString()})}});
   await tx.goalDecision.update({where:{id:d.id},data:{activePlanId:plan.id,status:"ACTIVE",goalId:goal.id,version:{increment:1}}});
   await tx.goal.update({where:{id:goal.id},data:{name:f.name,targetAmountMinor:BigInt(f.targetAmountMinor!),targetDate:new Date(`${f.targetDate}T00:00:00+08:00`),...(f.priority?{priority:f.priority,priorityConfirmedAt:new Date()}:{}),monthlyContributionMinor:monthly,preparedAmountMinor:BigInt(f.targetAmountMinor!)-remaining}});
   const revision=w.portfolioRevision+1;await tx.workspace.update({where:{id:workspaceId},data:{portfolioRevision:revision}});
   const oldActions=await tx.action.findMany({where:{workspaceId,goalId:goal.id,kind:"GOAL_PLANNING",status:{in:["ACCEPTED","PROPOSED","DEFERRED"]}}});
   for(const a of oldActions){await tx.action.update({where:{id:a.id},data:{status:"DISMISSED"}});await tx.actionFeedback.create({data:{actionId:a.id,fromStatus:a.status,toStatus:"DISMISSED",reason:"由用户确认的新方案替代"}});}
   const task=await tx.agentTask.create({data:{workspaceId,type:"GOAL_PLANNING",status:"COMPLETED",sourceRevision:revision,resultId:plan.id,completedAt:new Date()}});
   await tx.action.create({data:{workspaceId,goalId:goal.id,generationTaskId:task.id,sourceRevision:revision,sourceKey:`GOAL:${plan.id}:review`,kind:"GOAL_PLANNING",title:`按计划准备“${goal.name}”的资金`,reason:"按用户确认的方案持续核对真实余额与假设",amountMinor:monthly,status:"ACCEPTED",priority:2,verificationType:"REQUIRES_REVIEW",detailsJson:encode({planVersionId:plan.id,decisionId:d.id})}});
   await tx.agentSession.update({where:{id:prior.run.sessionId},data:{goalId:goal.id,decisionId:d.id}});
   result={goal,plan};
  }else if(p.operation==="GOAL_REVIEW"){
   const d=await tx.goalDecision.findFirstOrThrow({where:{workspaceId,id:data.decisionId,status:{not:"REDACTED"}}});
   const existing=await tx.goalReview.findUnique({where:{decisionId_period:{decisionId:d.id,period:data.period}}});
   if(existing)await recordRevision(tx,workspaceId,"GOAL_REVIEW",existing.id,existing,"用户确认复盘更正");
   for(const b of data.balances as {assetId:string;amountMinor:string}[]){
    const a=await tx.asset.findFirstOrThrow({where:{workspaceId,id:b.assetId,deletedAt:null}});await recordRevision(tx,workspaceId,"ASSET",a.id,a,"目标复盘余额核对");
    await tx.asset.update({where:{id:a.id},data:{currentValueMinor:BigInt(b.amountMinor),asOf:new Date()}});
    await tx.balanceObservation.create({data:{workspaceId,entityType:"ASSET",entityId:a.id,amountMinor:BigInt(b.amountMinor),observedOn:fresh.asOf,source:"USER_REVIEW",confirmed:true,observationKey:`AGENT_REVIEW:${p.id}:${a.id}`}});
   }
   const missing=fresh.assets.filter(a=>!data.balances.some((b:{assetId:string})=>b.assetId===a.id)).map(a=>`${a.name}未纳入本次核对`);
   result=await tx.goalReview.upsert({where:{decisionId_period:{decisionId:d.id,period:data.period}},create:{workspaceId,decisionId:d.id,period:data.period,factsJson:encode(data),resultJson:encode({status:"NEEDS_RECALCULATION",missing,source:"USER_DECLARED"})},update:{factsJson:encode(data),resultJson:encode({status:"NEEDS_RECALCULATION",missing,source:"USER_DECLARED"}),version:{increment:1}}});
   await tx.workspace.update({where:{id:workspaceId},data:{portfolioRevision:{increment:1}}});
  }else throw new ApiError("不支持的确认操作",422);
  const updated=await tx.agentProposal.update({where:{id},data:{status:"CONFIRMED",confirmedAt:new Date(),version:{increment:1},resultJson:encode(result)}});
  await tx.auditEvent.create({data:{workspaceId,entityType:"AGENT_PROPOSAL",entityId:id,action:p.operation,revision:w.portfolioRevision}});
  return serialize({proposal:updated,result});
 },{timeout:15000});
}
export async function rejectAgentProposal(workspaceId:string,id:string){const claim=await db.agentProposal.updateMany({where:{workspaceId,id,status:"PENDING"},data:{status:"REJECTED",version:{increment:1}}});if(!claim.count)throw new ApiError("确认事项已变化",409);return {rejected:true};}
