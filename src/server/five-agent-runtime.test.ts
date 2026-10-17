import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { agentPrompt, type AgentKey } from "@/domain/agents";
import { createAgentSession, startAgentMessage, executeAgentRun, getAgentSession, resumeAgentRun, cancelAgentRun } from "./five-agent-runtime";
import { executeAgentTool } from "./agent-tools";
import { agentFacts } from "./agent-context";
import { confirmAgentProposal } from "./agent-proposals";
import { getManagers } from "./specialist-managers";
import { assessGenericGoal } from "./goal-capabilities";
const ids:string[]=[];
async function seed(){
 const w=await db.workspace.create({data:{ledgerConfirmedAt:new Date(),businessMigratedAt:new Date()}});ids.push(w.id);
 const a=await db.asset.create({data:{workspaceId:w.id,name:"已核对存款",type:"BANK_DEPOSIT",currentValueMinor:2000000n,liquidityLevel:"T0",riskLevel:1}});
 await db.insuranceNeed.create({data:{workspaceId:w.id,status:"NONE",dataJson:JSON.stringify({status:"NONE",insured:"本人",age:30,category:"MEDICAL",annualBudgetMinor:null,preference:"COVERAGE",confirmed:true})}});
 await db.budgetVersion.create({data:{workspaceId:w.id,validFrom:"2020-01-01",revision:1,incomeMinor:1000000n,livingMinor:500000n,debtIncluded:false,premiumsIncluded:false,reason:"测试确认",dataJson:JSON.stringify({incomeMinor:"1000000",livingMinor:"500000",extraFixedMinor:"0",premiumsIncluded:false,debtIncluded:false,confirmed:true})}});
 return {w,a};
}
const answer=(message="已读取资料，请核对下一步。")=>({kind:"ANSWER",message,toolName:null,argumentsJson:null,specialist:null,evidenceIds:[],missing:[]});
const call=(name:string,args:unknown={})=>({...answer(),kind:"CALL_TOOL",toolName:name,argumentsJson:JSON.stringify(args)});
async function running(workspaceId:string,key:AgentKey="GOAL"){const s=await createAgentSession(workspaceId,{agentKey:key});const r=await startAgentMessage(workspaceId,s.id,{content:"讨论我的目标",clientMessageId:crypto.randomUUID()});return {s,r};}
afterAll(async()=>{await db.workspace.deleteMany({where:{id:{in:ids}}});await db.$disconnect();});
describe("five agent architecture",()=>{
 it("has distinct prompts and persistent conversations for all five roles",async()=>{const x=await seed();const prompts=new Set<string>();for(const key of ["WEALTH","GOAL","CASHFLOW","INVESTMENT","INSURANCE"] as AgentKey[]){prompts.add(agentPrompt(key,"USER_DIALOGUE"));const {s,r}=await running(x.w.id,key);await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>answer(`${key}已核对`)});const restored=await getAgentSession(x.w.id,s.id);expect(restored.messages).toHaveLength(2);expect(restored.messages[1].content).toBe(`${key}已核对`);}expect(prompts.size).toBe(5);});
 it("executes actual allowed tools and supplies outputs to the next model step",async()=>{const x=await seed();const {r}=await running(x.w.id,"CASHFLOW");let n=0;await executeAgentRun(x.w.id,r.id,()=>{},{model:async(_,input)=>{if(n++===0)return call("assessCapacity");expect(JSON.stringify(input)).toContain("500000");return answer();}});expect(await db.agentStep.count({where:{runId:r.id,toolName:"assessCapacity"}})).toBe(1);});
 it("refuses a forbidden tool even if the model asks for it",async()=>{const x=await seed();const {r}=await running(x.w.id,"INSURANCE");const result=await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>call("proposeBudget",{})}) as {status:string};expect(result.status).toBe("FAILED");expect(await db.agentProposal.count({where:{workspaceId:x.w.id}})).toBe(0);});
 it("isolates specialist runs from user messages",async()=>{const x=await seed();const {s,r}=await running(x.w.id,"WEALTH");let root=0;await executeAgentRun(x.w.id,r.id,()=>{},{model:async(prompt)=>prompt.includes("【资产管家职责】")&&root++===0?{...answer("评估持续投入"),kind:"REQUEST_SPECIALIST",specialist:"CASHFLOW"}:answer("专业核对已完成")});expect(await db.agentRun.count({where:{parentRunId:r.id,agentKey:"CASHFLOW"}})).toBe(1);expect((await getAgentSession(x.w.id,s.id)).messages).toHaveLength(2);});
 it("does not commit financial changes before confirmation and rejects stale cards",async()=>{const x=await seed();const {r}=await running(x.w.id);let n=0;await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>n++===0?call("proposeGoalDraft",{facts:{name:"个人储备",targetAmountMinor:null,targetDate:null}}):answer()});expect(await db.goalDecision.count({where:{workspaceId:x.w.id}})).toBe(0);const p=await db.agentProposal.findFirstOrThrow({where:{runId:r.id}});await db.workspace.update({where:{id:x.w.id},data:{portfolioRevision:{increment:1}}});await expect(confirmAgentProposal(x.w.id,p.id,{version:p.version,confirm:true})).rejects.toThrow("资料已变化");});
 it("confirms drafts once and preserves unknown amount/date",async()=>{const x=await seed();const {r}=await running(x.w.id);let n=0;await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>n++===0?call("proposeGoalDraft",{facts:{name:"未来安排",targetAmountMinor:null,targetDate:null}}):answer()});const p=await db.agentProposal.findFirstOrThrow({where:{runId:r.id}});await confirmAgentProposal(x.w.id,p.id,{version:p.version,confirm:true});await confirmAgentProposal(x.w.id,p.id,{version:p.version,confirm:true});expect(await db.goalDecision.count({where:{workspaceId:x.w.id}})).toBe(1);expect(await db.goal.count({where:{workspaceId:x.w.id}})).toBe(0);const d=await db.goalDecision.findFirstOrThrow({where:{workspaceId:x.w.id}});expect(JSON.parse(d.factsJson).targetAmountMinor).toBeNull();});
 it("uses common funding rules for different names and unknown values",async()=>{const x=await seed();const f=await agentFacts(x.w.id);const date=new Date();date.setUTCFullYear(date.getUTCFullYear()+1);const base={targetAmountMinor:"1000000",targetDate:date.toISOString().slice(0,10),reserveMinor:"100000",monthlyCostMinor:"0",assetIds:[x.a.id],confirmed:true};const a=assessGenericGoal({name:"应急储备",...base},f);const b=assessGenericGoal({name:"有期限的个人支出",...base},f);expect(a.status).toBe("FEASIBLE");expect(b.status).toBe(a.status);expect(a.scenarios).toEqual(b.scenarios);expect(assessGenericGoal({name:"预算未知",...base,targetAmountMinor:null},f).status).toBe("NEEDS_INFORMATION");});
 it("rejects cross-workspace references at database and tool boundaries",async()=>{const x=await seed(),other=await seed();const {s,r}=await running(x.w.id);await expect(db.goalFundingReservation.create({data:{workspaceId:x.w.id,decisionId:"missing",assetId:other.a.id,amountMinor:1n}})).rejects.toThrow();const f=await agentFacts(x.w.id);await expect(executeAgentTool("proposeHolding",{assetId:other.a.id,productName:"其他空间",availableOn:null,feeMinor:null,feeBasis:"",confirmed:true},{workspaceId:x.w.id,agentKey:"INVESTMENT",sessionId:s.id,runId:r.id,goalId:null,decisionId:null,facts:f})).rejects.toThrow("资产不存在");await expect(getAgentSession(other.w.id,s.id)).rejects.toThrow("会话不存在");});
 it("deduplicates messages and can resume model failures",async()=>{const x=await seed();const s=await createAgentSession(x.w.id,{agentKey:"GOAL"});const input={content:"目标想法",clientMessageId:crypto.randomUUID()};const r=await startAgentMessage(x.w.id,s.id,input);expect((await startAgentMessage(x.w.id,s.id,input)).id).toBe(r.id);await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>{throw new Error("slow model");}});await resumeAgentRun(x.w.id,r.id);await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>answer()});expect((await getAgentSession(x.w.id,s.id)).messages.filter(m=>m.role==="USER")).toHaveLength(1);});
 it("records a recoverable timeout with a useful message and no duplicate input",async()=>{
  const x=await seed();const {s,r}=await running(x.w.id);const result=await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>{throw new DOMException('slow','TimeoutError');}}) as {error:string};
  expect(result.error).toContain('模型回复超时');expect((await db.agentRun.findUniqueOrThrow({where:{id:r.id}})).errorCode).toBe('MODEL_TIMEOUT');
  await resumeAgentRun(x.w.id,r.id);await executeAgentRun(x.w.id,r.id,()=>{},{model:async()=>answer()});expect((await getAgentSession(x.w.id,s.id)).messages.filter(m=>m.role==='USER')).toHaveLength(1);
 });
 it("query tools do not generate reminders, actions or budget changes",async()=>{const x=await seed();const {s,r}=await running(x.w.id,"WEALTH");const f=await agentFacts(x.w.id);const context={workspaceId:x.w.id,agentKey:"WEALTH" as AgentKey,sessionId:s.id,runId:r.id,goalId:null,decisionId:null,facts:f};await executeAgentTool("getGoalProgress",{},context);await executeAgentTool("getBudget",{},context);expect(await db.action.count({where:{workspaceId:x.w.id}})).toBe(0);expect(await db.managerReminder.count({where:{workspaceId:x.w.id}})).toBe(0);expect((await db.workspace.findUniqueOrThrow({where:{id:x.w.id}})).professionalRevision).toBe(0);});
 it("adopts a generic plan atomically without changing balances or duplicating funds",async()=>{
  const x=await seed();const date=new Date();date.setUTCFullYear(date.getUTCFullYear()+1);
  const facts={name:"个人储备目标",targetAmountMinor:"1000000",targetDate:date.toISOString().slice(0,10),reserveMinor:"100000",monthlyCostMinor:"0",assetIds:[x.a.id],confirmed:true};
  const d=await db.goalDecision.create({data:{workspaceId:x.w.id,title:facts.name,factsJson:JSON.stringify(facts)}});
  const s=await createAgentSession(x.w.id,{agentKey:"GOAL",decisionId:d.id});const r=await startAgentMessage(x.w.id,s.id,{content:"请计算目标方案",clientMessageId:crypto.randomUUID()});const f=await agentFacts(x.w.id,null,d.id);
  const context={workspaceId:x.w.id,agentKey:"GOAL" as AgentKey,sessionId:s.id,runId:r.id,goalId:null,decisionId:d.id,facts:f};
  const e=await executeAgentTool("assessGoalFeasibility",{},context) as {evaluationId:string;status:string};expect(e.status).toBe("FEASIBLE");
  const p=await executeAgentTool("proposePlanAdoption",{evaluationId:e.evaluationId,candidateKey:"BASE"},context) as {proposalId:string;version:number};
  await confirmAgentProposal(x.w.id,p.proposalId,{version:p.version,confirm:true});await confirmAgentProposal(x.w.id,p.proposalId,{version:p.version,confirm:true});
  expect(await db.goalPlanVersion.count({where:{workspaceId:x.w.id}})).toBe(1);expect(await db.goal.count({where:{workspaceId:x.w.id}})).toBe(1);expect(await db.action.count({where:{workspaceId:x.w.id}})).toBe(1);
  expect((await db.asset.findUniqueOrThrow({where:{id:x.a.id}})).currentValueMinor).toBe(2000000n);expect((await db.goalFundingReservation.aggregate({where:{workspaceId:x.w.id},_sum:{amountMinor:true}}))._sum.amountMinor).toBe(1000000n);
 });
 it("enforces global asset and repayment red lines",async()=>{
  const x=await seed();await db.decisionConstraint.create({data:{workspaceId:x.w.id,scope:"GLOBAL",type:"NO_USE_ASSET",operator:"NOT_USE",assetId:x.a.id,userText:"保留存款",confirmedAt:new Date()}});
  const f=await agentFacts(x.w.id);const tomorrow=new Date();tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  const result=assessGenericGoal({name:"短期安排",targetAmountMinor:"1000000",targetDate:tomorrow.toISOString().slice(0,10),reserveMinor:"0",monthlyCostMinor:"0",assetIds:[x.a.id],confirmed:true},f);
  expect(result.status).toBe("INFEASIBLE");expect(result.funding[0].protected).toBe(true);expect(result.funding[0].amountMinor).toBe("0");
 });
 it("stops delayed model responses without creating late confirmation cards",async()=>{
  const x=await seed();const {s,r}=await running(x.w.id);let release:(value:unknown)=>void=()=>{};let ready:()=>void=()=>{};const modelReady=new Promise<void>(resolve=>{ready=resolve;});
  const pending=executeAgentRun(x.w.id,r.id,()=>{},{model:()=>new Promise(resolve=>{release=resolve;ready();})});
  await modelReady;await cancelAgentRun(x.w.id,r.id);release(call("proposeGoalDraft",{facts:{name:"不应保存",targetAmountMinor:null,targetDate:null}}));await pending;
  expect(await db.agentProposal.count({where:{runId:r.id}})).toBe(0);expect((await getAgentSession(x.w.id,s.id)).status).toBe("ACTIVE");
 });
 it("deducts confirmed withdrawal fees and scheduled expenses",async()=>{
  const x=await seed();await db.holdingDetail.create({data:{workspaceId:x.w.id,assetId:x.a.id,confirmed:true,availableOn:"2020-01-01",feeMinor:10000n,dataJson:JSON.stringify({feeBasis:"测试费用"})}});
  const f=await agentFacts(x.w.id);const result=assessGenericGoal({name:"费用核对",targetAmountMinor:"1900000",targetDate:f.asOf,reserveMinor:"100000",monthlyCostMinor:"0",assetIds:[x.a.id],confirmed:true},f);
  expect(result.status).toBe("INFEASIBLE");expect(result.funding[0].amountMinor).toBe("1990000");expect(result.gapMinor).toBe("10000");
  await db.holdingDetail.update({where:{assetId:x.a.id},data:{feeMinor:null}});expect(assessGenericGoal({name:"费用未知",targetAmountMinor:"1",targetDate:f.asOf,reserveMinor:"0",monthlyCostMinor:"0",assetIds:[x.a.id],confirmed:true},await agentFacts(x.w.id)).status).toBe("NEEDS_INFORMATION");
 });
 it("stores an explicit global constraint only after confirmation",async()=>{
  const x=await seed();const {s,r}=await running(x.w.id);const f=await agentFacts(x.w.id);const context={workspaceId:x.w.id,agentKey:"GOAL" as AgentKey,sessionId:s.id,runId:r.id,goalId:null,decisionId:null,facts:f};
  const p=await executeAgentTool("proposeConstraint",{decisionId:null,scope:"GLOBAL",type:"NO_USE_ASSET",operator:"NOT_USE",thresholdValue:null,unit:null,currency:null,assetId:x.a.id,goalId:null,userText:"不要动用这笔存款",confirm:true},context) as {proposalId:string;version:number};
  expect(await db.decisionConstraint.count({where:{workspaceId:x.w.id}})).toBe(0);await confirmAgentProposal(x.w.id,p.proposalId,{version:p.version,confirm:true});expect((await agentFacts(x.w.id)).constraints).toHaveLength(1);
 });
 it("records user review balances as real observations and keeps plans unchanged",async()=>{
  const x=await seed();const d=await db.goalDecision.create({data:{workspaceId:x.w.id,title:"继续学习",factsJson:"{}"}});const s=await createAgentSession(x.w.id,{agentKey:"GOAL",decisionId:d.id});const r=await startAgentMessage(x.w.id,s.id,{content:"核对实际余额",clientMessageId:crypto.randomUUID()});const f=await agentFacts(x.w.id,null,d.id);
  const p=await executeAgentTool("proposeGoalReview",{decisionId:d.id,period:f.asOf.slice(0,7),balances:[{assetId:x.a.id,amountMinor:"1700000"}],note:"用户声明余额"},{workspaceId:x.w.id,agentKey:"GOAL",sessionId:s.id,runId:r.id,goalId:null,decisionId:d.id,facts:f}) as {proposalId:string;version:number};
  await confirmAgentProposal(x.w.id,p.proposalId,{version:p.version,confirm:true});await confirmAgentProposal(x.w.id,p.proposalId,{version:p.version,confirm:true});expect(await db.balanceObservation.count({where:{workspaceId:x.w.id,source:"USER_REVIEW"}})).toBe(1);expect(await db.goalReview.count({where:{decisionId:d.id}})).toBe(1);expect(await db.goalPlanVersion.count({where:{decisionId:d.id}})).toBe(0);
 });

 it("shares generic goal reservations and impacts with professional pages",async()=>{
  const x=await seed();const d=await db.goalDecision.create({data:{workspaceId:x.w.id,title:"学习进修",factsJson:JSON.stringify({name:"学习进修",targetAmountMinor:null,targetDate:null})}});
  await db.goalFundingReservation.create({data:{workspaceId:x.w.id,decisionId:d.id,assetId:x.a.id,amountMinor:500000n}});
  const overview=await getManagers(x.w.id);expect(overview.reservations.some(r=>r.assetId===x.a.id&&String(r.amountMinor)==="500000")).toBe(true);expect(overview.impacts.find(i=>i.id===d.id)?.generic).toBe(true);expect((await db.asset.findUniqueOrThrow({where:{id:x.a.id}})).currentValueMinor).toBe(2000000n);
 });

});
