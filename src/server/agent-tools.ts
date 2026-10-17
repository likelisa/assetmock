import { fundingPatchSchema, prepareFundingProposal, coordinateGoalFunding, getGoalFunding } from "./goal-funding";
import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, serialize } from "./portfolio";
import { encode } from "./unified-store";
import { type AgentKey, goalFactsSchema, minorSchema, daySchema } from "@/domain/agents";
import { budgetSchema, insuranceNeedsSchema, investmentNeedsSchema, policySchema, holdingSchema, screenInsurance, screenInvestments } from "@/domain/specialist-managers";
import { confirmedCapacity, assessGenericGoal } from "./goal-capabilities";
import { registerAgentDependencies, type AgentFacts } from "./agent-context";
import { applyManagerCommand } from "./specialist-managers";
import { constraintSchema } from "@/domain/database-planning";
import { assessLegacyGoal } from "./legacy-goal-adapter";
import { accountInsights, historyPage, historySchema, orderDetails } from "./paper-trading/insights";
import { overview as paperOverview } from "./paper-trading/service";
import * as worldlineAgent from "./worldlines/agent";
import { detailArgs as worldlineDetailArgs, goalArg as worldlineGoalArg, planArgs as worldlinePlanArgs, runArgs as worldlineRunArgs } from "./worldlines/agent";

const all: AgentKey[]=["WEALTH","GOAL","CASHFLOW","INVESTMENT","INSURANCE"];
const empty=z.object({}).strict();
export type ToolContext={ workspaceId:string; agentKey:AgentKey; sessionId:string; runId:string; goalId:string|null; decisionId:string|null; facts:AgentFacts };
type Tool={ roles:AgentKey[]; kind:"QUERY"|"COMPUTE"|"PROPOSE"; description:string; schema:z.ZodType; execute:(args:never,ctx:ToolContext)=>Promise<unknown> };
function tool<A>(roles:AgentKey[],kind:Tool["kind"],description:string,schema:z.ZodType<A>,execute:(args:A,ctx:ToolContext)=>Promise<unknown>):Tool {return {roles,kind,description,schema,execute:execute as Tool["execute"]};}
async function proposal(ctx:ToolContext,operation:string,title:string,data:unknown) {
 const run=await db.agentRun.findFirst({where:{workspaceId:ctx.workspaceId,id:ctx.runId,status:{in:["QUEUED","RUNNING"]}}});if(!run)throw new ApiError("处理已停止，不能再生成确认事项",409);
 const row=await db.agentProposal.create({data:{workspaceId:ctx.workspaceId,runId:ctx.runId,operation,title,sourceSignature:ctx.facts.signature,dataJson:encode(data)}});
 await registerAgentDependencies("AGENT_PROPOSAL",row.id,ctx.facts);
 return {proposalId:row.id,title,status:"PENDING",version:row.version,changes:data,note:"只保存待确认草稿，尚未修改业务资料"};
}
function productReferences(f:AgentFacts){return f.products.map(p=>({productId:JSON.parse(p.dataJson).id,productVersionId:p.id,version:p.version,asOf:JSON.parse(p.dataJson).asOf}));}
async function decision(ctx:ToolContext,id?:string) {const row=await db.goalDecision.findFirst({where:{workspaceId:ctx.workspaceId,id:id??ctx.decisionId??"",status:{not:"REDACTED"}}});if(!row)throw new ApiError("请先确认目标决策资料",422);return row;}
async function paperResult(ctx:ToolContext, accountId:string, result:unknown, recordEvidence:string[]=[], capturedVersion?:number) {
 const account=await db.paperAccount.findFirst({where:{id:accountId,workspaceId:ctx.workspaceId}});
 if(!account)throw new ApiError("模拟账户不存在",404);
 await db.dataDependency.upsert({where:{workspaceId_ownerType_ownerId_sourceType_sourceId:{workspaceId:ctx.workspaceId,ownerType:"AGENT_RUN",ownerId:ctx.runId,sourceType:"PAPER_ACCOUNT",sourceId:accountId}},create:{workspaceId:ctx.workspaceId,ownerType:"AGENT_RUN",ownerId:ctx.runId,sourceType:"PAPER_ACCOUNT",sourceId:accountId},update:{}});
 const version=capturedVersion??account.version;
 return serialize({result,paperContext:{accountId,accountVersion:version,asOf:new Date()},evidenceIds:[`PAPER_ACCOUNT:${accountId}:v${version}`,...recordEvidence],note:"独立模拟资金，只读查询，不改变真实资产、模拟委托或策略授权；复盘结论引用下列证据与资料时间"});
}
export const agentTools:Record<string,Tool>={
 getFundingPlan:tool(["GOAL"],"QUERY","读取当前买车规划草稿、生效方案、资金报告和资料缺口；所有金额引用报告",empty,async(_,c)=>getGoalFunding(c.workspaceId,c.sessionId)),
 proposeFundingDraft:tool(["GOAL"],"PROPOSE","买车目标或本次规划调整：只填写用户明确表达的字段；金额与日期未知可保留草稿。不动资产使用excludedAssetIds，月供限制使用maxMonthlyPaymentMinor。确认后保存目标或调整草稿，绝不采纳方案。",fundingPatchSchema,async(a,c)=>{
   const planning=await prepareFundingProposal(c.workspaceId,c.sessionId,a);
   const state=await getGoalFunding(c.workspaceId,c.sessionId);
   return proposal(c,"CAR_FUNDING_DRAFT","确认买车目标与本次调整",{planning,sourceNames:state.assets.map(x=>({id:x.id,name:x.name})),summary:{name:planning.facts.purpose,targetAmountMinor:planning.facts.budgetMinor,targetDate:planning.facts.targetMonth,reserveMinor:planning.facts.reserveFloorMinor}});
 }),
 requestFundingPlan:tool(["GOAL"],"COMPUTE","请求资产管家进行受控的收支、保费、投资可用性核对与确定性买车资金计算。先确认目标和资料；结果不足则补问，不能递归委派或直接采纳。",empty,async(_,c)=>coordinateGoalFunding(c.workspaceId,c.sessionId,c.runId)),
 getPaperAccounts:tool(["INVESTMENT"],"QUERY","列出本空间的手动、AI策略和历史回放模拟账户；选择明确accountId后读取详情",empty,async(_,c)=>{
  const rows=await db.paperAccount.findMany({where:{workspaceId:c.workspaceId},orderBy:{createdAt:"desc"},select:{id:true,name:true,purpose:true,mode:true,status:true,health:true,initialMinor:true,version:true,createdAt:true,archivedAt:true}});
  for(const a of rows)await db.dataDependency.upsert({where:{workspaceId_ownerType_ownerId_sourceType_sourceId:{workspaceId:c.workspaceId,ownerType:"AGENT_RUN",ownerId:c.runId,sourceType:"PAPER_ACCOUNT",sourceId:a.id}},create:{workspaceId:c.workspaceId,ownerType:"AGENT_RUN",ownerId:c.runId,sourceType:"PAPER_ACCOUNT",sourceId:a.id},update:{}});
  return serialize({accounts:rows,paperContexts:rows.map(a=>({accountId:a.id,accountVersion:a.version})),asOf:new Date(),evidenceIds:rows.map(a=>`PAPER_ACCOUNT:${a.id}:v${a.version}`),note:"手动、AI策略、回放账户资金互不混用；查询不是下单授权"});
 }),
 getPaperAccountSummary:tool(["INVESTMENT"],"QUERY","读取指定模拟账户现金、可用资金、持仓及估值日期；报价不完整时不宣称确定收益",z.object({accountId:z.string().min(1)}).strict(),async(a,c)=>{
  const data=await paperOverview(db,c.workspaceId,a.accountId);if(!data.account)throw new ApiError("模拟账户不存在",404);
  const quoteIds="positions" in data?(data.positions as {quoteId:string|null}[]).flatMap(p=>p.quoteId?[`PAPER_QUOTE:${p.quoteId}`]:[]):[];
  return paperResult(c,a.accountId,{account:data.account,availableMinor:data.account.cashMinor-data.account.frozenMinor,...("positions" in data?{positions:data.positions,marketMinor:data.marketMinor,equityMinor:data.equityMinor,quality:data.quality,floatingMinor:data.floatingMinor}:{}),worker:data.worker,valuationAt:"valuationAt" in data?data.valuationAt:null},quoteIds,data.account.version);
 }),
 getPaperTransactions:tool(["INVESTMENT"],"QUERY","分页读取指定模拟账户的委托、成交、资金流水、历史估值或公司行为；给出可追溯记录ID",historySchema.extend({accountId:z.string().min(1)}).strict(),async(a,c)=>{
  const {accountId,...query}=a;const data=await historyPage(db,c.workspaceId,accountId,query);
  return paperResult(c,accountId,data,data.records.map(r=>`PAPER_${a.kind}:${r.id}`),data.accountVersion);
 }),
 getPaperOrderDetails:tool(["INVESTMENT"],"QUERY","追溯一笔模拟委托的成交批次、费用、冻结解冻、撤单与行情证据",z.object({orderId:z.string().min(1)}).strict(),async(a,c)=>{
  const data=await orderDetails(db,c.workspaceId,a.orderId);
  return paperResult(c,data.accountId,data,[`PAPER_ORDER:${data.order.id}`,...data.order.fills.flatMap(f=>[`PAPER_FILL:${f.id}`,`PAPER_QUOTE:${f.quoteId}`]),...data.order.events.map(e=>`PAPER_EVENT:${e.id}`),...data.entries.map(e=>`PAPER_ENTRY:${e.id}`)],data.accountVersion);
 }),
 getPaperMetrics:tool(["INVESTMENT"],"COMPUTE","程序计算模拟账户收益、费用、观测回撤、双边换手率、集中度及同区间基准；缺失数据不补造",z.object({accountId:z.string().min(1),from:daySchema.optional(),to:daySchema.optional()}).strict(),async(a,c)=>{
  const data=await accountInsights(db,c.workspaceId,a.accountId,{from:a.from,to:a.to});
  return paperResult(c,a.accountId,data,data.evidenceIds.map(id=>`PAPER_RECORD:${id}`),data.accountVersion);
 }),
 getPaperNotes:tool(["INVESTMENT"],"QUERY","只读分页查询用户原始模拟交易复盘笔记，不推断未记录的交易动机",z.object({accountId:z.string().min(1),cursor:z.string().nullable().default(null)}).strict(),async(a,c)=>{
  const data=await historyPage(db,c.workspaceId,a.accountId,{kind:"NOTES",cursor:a.cursor,take:50});
  return paperResult(c,a.accountId,data,data.records.map(r=>`PAPER_NOTE:${r.id}`),data.accountVersion);
 }),
 getOverview:tool(all,"QUERY","查询当前财务事实、确认状态、保护资金和目标",empty,async(_,c)=>serialize({profile:c.facts.profile,ledgerConfirmed:c.facts.ledgerConfirmed,assets:c.facts.assets,liabilities:c.facts.liabilities,goals:c.facts.goals,asOf:c.facts.asOf,evidenceId:`FACTS:${c.facts.signature}`})),
 listGoals:tool(all,"QUERY","查询已有目标与通用决策，避免重复创建",empty,async(_,c)=>serialize({goals:c.facts.goals,decisions:c.facts.decisions,evidenceId:`GOALS:${c.facts.signature}`})),
 getGoalProgress:tool(["WEALTH","GOAL"],"QUERY","读取目标行动与最近复盘，不自动改变状态",empty,async(_,c)=>serialize({actions:c.facts.actions,decisions:c.facts.decisions,evidenceId:`PROGRESS:${c.facts.signature}`})),
 getBudget:tool(all,"QUERY","读取已确认预算、保费和债务承诺",empty,async(_,c)=>serialize({budget:c.facts.budget,insuranceNeed:c.facts.insuranceNeed,policies:c.facts.policies,liabilities:c.facts.liabilities})),
 assessCapacity:tool(["WEALTH","GOAL","CASHFLOW"],"COMPUTE","确定性计算持续投入能力，明确缺失保费口径",empty,async(_,c)=>confirmedCapacity(c.facts,c.goalId)),
 getPolicies:tool(["WEALTH","INSURANCE"],"QUERY","读取本人已有保单、费用及保障资料状态",empty,async(_,c)=>serialize({policies:c.facts.policies,need:c.facts.insuranceNeed,coverageState:c.facts.insuranceNeed?.status??"UNKNOWN"})),
 getHoldings:tool(["WEALTH","INVESTMENT","GOAL"],"QUERY","读取资产、可用日期、费用和资金占用，不改余额",empty,async(_,c)=>serialize({assets:c.facts.assets,holdings:c.facts.holdings,reservations:c.facts.reservations,legacyReservations:c.facts.legacyReservations})),
 getTransactions:tool(["CASHFLOW"],"QUERY","分页读取指定周期流水，不把流水当完整收支",z.object({from:daySchema,to:daySchema,cursor:z.string().nullable().default(null)}).strict(),async(a,c)=>{
  if(a.to<a.from)throw new ApiError("日期区间无效",422);if(a.cursor&&!await db.transaction.findFirst({where:{workspaceId:c.workspaceId,id:a.cursor,deletedAt:null}}))throw new ApiError("分页位置不属于当前空间",422);const rows=await db.transaction.findMany({where:{workspaceId:c.workspaceId,deletedAt:null,occurredOn:{gte:new Date(`${a.from}T00:00:00+08:00`),lt:new Date(new Date(`${a.to}T00:00:00+08:00`).getTime()+86400000)}},orderBy:{id:"asc"},take:50,...(a.cursor?{cursor:{id:a.cursor},skip:1}:{})});
  return serialize({records:rows,nextCursor:rows.length===50?rows.at(-1)?.id:null,completeness:"USER_NOT_CONFIRMED",note:"仅为已录入流水，不代表完整收支或实际存款变化"});
 }),
 summarizeTransactions:tool(["CASHFLOW"],"COMPUTE","汇总任意月、季度或年度区间已录入收支及类别；排除转账等非分析流水，不认定完整",z.object({from:daySchema,to:daySchema}).strict(),async(a,c)=>{
  if(a.to<a.from)throw new ApiError("日期区间无效",422);
  const totals=await db.transaction.groupBy({by:["direction","category"],where:{workspaceId:c.workspaceId,deletedAt:null,analysisTreatment:"COUNT",occurredOn:{gte:new Date(`${a.from}T00:00:00+08:00`),lt:new Date(new Date(`${a.to}T00:00:00+08:00`).getTime()+86400000)}},_sum:{amountMinor:true},_count:true});
  const income=totals.filter(t=>t.direction==="INCOME").reduce((s,t)=>s+(t._sum.amountMinor??0n),0n);const expense=totals.filter(t=>t.direction==="EXPENSE").reduce((s,t)=>s+(t._sum.amountMinor??0n),0n);
  return serialize({from:a.from,to:a.to,incomeMinor:income,expenseMinor:expense,balanceMinor:income-expense,byCategory:totals,coverage:"RECORDED_ONLY",note:"仅为已录入实际，未知月份不补零，结余不等于实际存款增长"});
 }),
 screenProducts:tool(["INVESTMENT","INSURANCE"],"COMPUTE","按已确认需求筛选真实版本化产品，返回排除与待核实条件",empty,async(_,c)=>{
  const seen=new Set<string>();const products=c.facts.products.filter(p=>{if(seen.has(p.productId))return false;seen.add(p.productId);return true;}).map(p=>JSON.parse(p.dataJson));
  if(c.agentKey==="INSURANCE"){const needs=insuranceNeedsSchema.safeParse(c.facts.insuranceNeed?JSON.parse(c.facts.insuranceNeed.dataJson):null);if(!needs.success)return {status:"NEEDS_INFORMATION",missing:["保险需求未确认"],products:[]};return {status:"ASSESSED",products:screenInsurance(products,needs.data),versions:productReferences(c.facts)};}
  const needs=investmentNeedsSchema.safeParse(c.facts.investmentNeed?JSON.parse(c.facts.investmentNeed.dataJson):null);if(!needs.success)return {status:"NEEDS_INFORMATION",missing:["资金用途、金额、日期和风险条件未确认"],products:[]};
  const asset=c.facts.assets.find(a=>a.id===needs.data.assetId);if(needs.data.assetId&&!asset)throw new ApiError("来源资产不存在",422);
  const occupied=asset&&(c.facts.constraints.some(r=>r.type==="NO_USE_ASSET"&&r.assetId===asset.id)||!asset.isAdjustable||!!asset.goalId||c.facts.reservations.some(r=>r.assetId===asset.id)||c.facts.legacyReservations.some(r=>r.assetId===asset.id));
  return {status:"ASSESSED",products:screenInvestments(products,needs.data,c.facts.asOf,!!occupied),versions:productReferences(c.facts),note:"初步筛选，正式意向前请调用evaluateProducts核对全部已确认红线"};
 }),
 compareProducts:tool(["INVESTMENT","INSURANCE"],"QUERY","比较本领域产品资料，保留来源、日期与各自收益口径",z.object({productVersionIds:z.array(z.string()).min(2).max(5)}).strict(),async(a,c)=>{
  const rows=c.facts.products.filter(p=>a.productVersionIds.includes(p.id));if(rows.length!==a.productVersionIds.length)throw new ApiError("产品版本不存在",422);
  if(rows.some(p=>["ACCIDENT","MEDICAL","TERM_LIFE"].includes(JSON.parse(p.dataJson).category)!==(c.agentKey==="INSURANCE")))throw new ApiError("产品不属于当前专业领域",422);
  return serialize({products:rows,note:"仅比较事实，不以不同类别收益直接排序"});
 }),
 evaluateProducts:tool(["INVESTMENT","INSURANCE"],"COMPUTE","保存本次专业筛选结果与产品版本，用于后续意向确认",empty,async(_,c)=>{
  await db.$transaction(tx=>applyManagerCommand(tx,c.workspaceId,{command:"EVALUATE",manager:c.agentKey,expectedVersion:c.facts.professionalRevision}));
  const e=await db.professionalEvaluation.findFirstOrThrow({where:{workspaceId:c.workspaceId,manager:c.agentKey},orderBy:{createdAt:"desc"}});
  return {evaluationId:e.id,result:JSON.parse(e.resultJson),versions:productReferences(c.facts)};
 }),
 proposeProductSelection:tool(["INVESTMENT","INSURANCE"],"PROPOSE","保存产品意向的确认卡，只生成核对行动，不产生购买或保单",z.object({evaluationId:z.string(),productId:z.string()}).strict(),async(a,c)=>{
  const e=await db.professionalEvaluation.findFirst({where:{workspaceId:c.workspaceId,id:a.evaluationId,manager:c.agentKey}});if(!e)throw new ApiError("本领域评估不存在",404);
  const match=JSON.parse(e.resultJson).products.find((p:{product:{id:string};status:string})=>p.product.id===a.productId);
  if(!match||match.status==="EXCLUDED")throw new ApiError("该产品不满足筛选条件",422);
  return proposal(c,"MANAGER",`确认${match.product.name}的意向`,{command:"SELECT",...a,confirm:true});
 }),
 proposeGoalDraft:tool(["GOAL"],"PROPOSE","提出目标决策资料草稿，未知金额和日期可为空，用户确认后保存",z.object({decisionId:z.string().nullable().default(null),facts:goalFactsSchema}).strict(),async(a,c)=>{
  if(a.decisionId&&!await db.goalDecision.findFirst({where:{id:a.decisionId,workspaceId:c.workspaceId,status:{not:"REDACTED"}}}))throw new ApiError("没有此目标决策。新资料确认卡请使用decisionId:null；不要把proposalId当作决策ID",422);if(a.facts.assetIds.some(id=>!c.facts.assets.some(a=>a.id===id)))throw new ApiError("资产不属于当前工作区",422);
  return proposal(c,"GOAL_FACTS","确认目标决策资料",{...a,goalId:c.goalId});
 }),
 assessGoalFeasibility:tool(["GOAL"],"COMPUTE","按通用目标资金、可用时间、预算和储备规则评估，能力不足明确返回",z.object({decisionId:z.string().optional()}).strict(),async(a,c)=>{
  const d=await decision(c,a.decisionId);if(d.legacyDecisionId)return assessLegacyGoal(c.workspaceId,d.legacyDecisionId);
  const result=assessGenericGoal(JSON.parse(d.factsJson),c.facts,d.goalId,d.id);
  const e=await db.goalEvaluationRecord.create({data:{workspaceId:c.workspaceId,decisionId:d.id,decisionVersion:d.version,sourceSignature:c.facts.signature,calculatedOn:c.facts.asOf,capability:result.capability,formulaVersion:result.formulaVersion,inputJson:encode(JSON.parse(d.factsJson)),resultJson:encode(result),status:result.status}});
  await registerAgentDependencies("GOAL_EVALUATION",e.id,c.facts);return {...result,evaluationId:e.id};
 }),
 proposePlanAdoption:tool(["GOAL"],"PROPOSE","提出采纳可行方案的确认卡，不直接创建资金预留",z.object({evaluationId:z.string(),candidateKey:z.literal("BASE")}).strict(),async(a,c)=>{
  const e=await db.goalEvaluationRecord.findFirst({where:{workspaceId:c.workspaceId,id:a.evaluationId,status:"FEASIBLE"}});if(!e||e.sourceSignature!==c.facts.signature)throw new ApiError("方案不可采纳或资料已变化",409);
  const d=await decision(c,e.decisionId);const facts=JSON.parse(d.factsJson);const calculated=JSON.parse(e.resultJson);
  return proposal(c,"ADOPT_PLAN","确认目标资金方案",{...a,summary:{name:facts.name,targetAmountMinor:facts.targetAmountMinor,targetDate:facts.targetDate,reserveMinor:calculated.minimumReserveMinor,monthlyAvailableMinor:calculated.monthlyAvailableMinor,afterGoalMonthlyMinor:calculated.afterGoalMonthlyMinor,funding:calculated.funding,assumptions:calculated.assumptions}});
 }),
 proposeConstraint:tool(["WEALTH","GOAL"],"PROPOSE","提出明确红线的确认卡；本期新约束为个人全局范围，不能自动忽略或解除",constraintSchema,async(a,c)=>{if(a.scope!=="GLOBAL"||a.decisionId!==null)throw new ApiError("本期新增红线请采用个人全局范围",422);if(a.assetId&&!c.facts.assets.some(x=>x.id===a.assetId)||a.goalId&&!c.facts.goals.some(x=>x.id===a.goalId))throw new ApiError("红线关联资料不存在",422);return proposal(c,"CONSTRAINT","确认个人财务红线",a);}),
 proposeBudget:tool(["CASHFLOW"],"PROPOSE","提出完整规划预算确认卡；金额均以分填写，包含费用口径与削减接受状态",budgetSchema,async(a,c)=>proposal(c,"MANAGER","确认规划预算",{command:"BUDGET",expectedVersion:c.facts.professionalRevision,data:a})),
 proposeInsuranceNeed:tool(["INSURANCE"],"PROPOSE","提出本人保险需求确认卡",insuranceNeedsSchema,async(a,c)=>proposal(c,"MANAGER","确认保险需求",{command:"INSURANCE_NEEDS",expectedVersion:c.facts.professionalRevision,data:{...a,insured:"本人"}})),
 proposeInvestmentNeed:tool(["INVESTMENT"],"PROPOSE","提出用途筛选条件确认卡，不改变资产余额",investmentNeedsSchema,async(a,c)=>proposal(c,"MANAGER","确认资金用途与筛选条件",{command:"INVESTMENT_NEEDS",expectedVersion:c.facts.professionalRevision,data:a})),
 proposePolicy:tool(["INSURANCE"],"PROPOSE","提出本人保单资料确认卡，保障额度不计入资产",policySchema,async(a,c)=>{if(a.insured!=="本人")throw new ApiError("只支持本人新增保障",422);return proposal(c,"MANAGER","确认保单资料",{command:"POLICY",expectedVersion:c.facts.professionalRevision,data:a});}),
 proposeHolding:tool(["INVESTMENT"],"PROPOSE","提出持仓补充资料确认卡，余额仍来自底账",holdingSchema,async(a,c)=>{if(!c.facts.assets.some(x=>x.id===a.assetId))throw new ApiError("资产不存在",422);return proposal(c,"MANAGER","确认持仓资料",{command:"HOLDING",expectedVersion:c.facts.professionalRevision,data:a});}),
 proposeActionChange:tool(["GOAL"],"PROPOSE","提出执行事项状态修改，完成仅为用户声明",z.object({actionId:z.string(),status:z.enum(["ACCEPTED","DEFERRED","USER_MARKED_COMPLETED","DISMISSED"]),reason:z.string().max(500).optional()}).strict(),async(a,c)=>{if(!c.facts.actions.some(x=>x.id===a.actionId))throw new ApiError("行动不存在",422);return proposal(c,"ACTION","确认执行事项变更",a);}),
 proposeGoalReview:tool(["GOAL"],"PROPOSE","核对实际账户余额与目标进度，生成复盘确认卡",z.object({decisionId:z.string(),period:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),balances:z.array(z.object({assetId:z.string(),amountMinor:minorSchema}).strict()).min(1).max(50),note:z.string().max(1000)}).strict(),async(a,c)=>{
  await decision(c,a.decisionId);if(a.balances.some(x=>!c.facts.assets.some(y=>y.id===x.assetId)))throw new ApiError("资产不属于当前工作区",422);return proposal(c,"GOAL_REVIEW","确认实际余额与目标复盘",a);
 }),
 getEventCards:tool(["GOAL","WEALTH","CASHFLOW"],"QUERY","读取世界线事件卡目录（按目标过滤）：每张卡的强度档、可复述前提、依据等级与默认权重。选卡前先调这个，不要凭印象编卡",worldlineGoalArg,async(a,c)=>serialize(await worldlineAgent.cardsForAgent(c.workspaceId,a.goalId??c.goalId))),
 proposeEventCardPlan:tool(["GOAL","WEALTH","CASHFLOW"],"COMPUTE","校验你为这个用户选定的世界线卡组：可排除无关卡、可钉住某一档，但只能选档不能改数值；静默砍掉最重档或整组梯度会被拒",worldlinePlanArgs,async(a,c)=>serialize(await worldlineAgent.reviewPlanForAgent(c.workspaceId,a.goalId??c.goalId,a.plan))),
 simulateWorldlines:tool(["GOAL","WEALTH","CASHFLOW"],"COMPUTE","按当前底账与卡组批量推演 N 条世界线，返回分级候选与统计（≤8 条候选、≤6KB）。不预测未来，不代表概率",worldlineRunArgs,async(a,c)=>worldlineAgent.runWorldlinesForAgent(c.workspaceId,{...a,goalId:a.goalId??c.goalId})),
 getWorldlineDetail:tool(["GOAL","WEALTH","CASHFLOW"],"QUERY","重算某条候选世界线的逐月可用资金（抽样≤12 月），用于说明第几个月开始不够",worldlineDetailArgs,async(a,c)=>worldlineAgent.worldlineDetailForAgent(c.workspaceId,{...a,goalId:a.goalId??c.goalId})),
};
export function toolCatalog(key:AgentKey){return Object.entries(agentTools).filter(([,t])=>t.roles.includes(key)).map(([name,t])=>({name,kind:t.kind,description:t.description,inputSchema:z.toJSONSchema(t.schema,{io:"input"})}));}
export async function executeAgentTool(name:string,args:unknown,ctx:ToolContext){const t=agentTools[name];if(!t||!t.roles.includes(ctx.agentKey))throw new ApiError("当前管家没有这个工具权限",403);return t.execute(t.schema.parse(args) as never,ctx);}
