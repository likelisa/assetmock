import { AGENT_RUN_TIMEOUT_MS, agentFailure, agentModelTimeoutMs } from './agent-failures';
import { modelConfig } from "@/lib/model-config";
import { z } from "zod";
import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { ApiError, serialize } from "./portfolio";
import { encode } from "./unified-store";
import { structuredResponse } from "./agent-runtime";
import { agentKeySchema, agentLabels, agentPrompt, agentDecisionSchema, decisionJsonSchema, AGENT_PROMPT_VERSION, type AgentKey, type AgentDecision } from "@/domain/agents";
import { agentFacts, contextForAgent, registerAgentDependencies } from "./agent-context";
import { executeAgentTool, toolCatalog } from "./agent-tools";

export type AgentEvent={type:string;runId:string;message?:string;agentKey?:AgentKey;result?:unknown};
type Model=(prompt:string,input:unknown)=>Promise<unknown>;
type Budget={calls:number;tools:number;started:number;signal?:AbortSignal};
const active=["QUEUED","RUNNING"];
const sessionInput=z.object({agentKey:agentKeySchema,goalId:z.string().nullable().default(null),decisionId:z.string().nullable().default(null),title:z.string().trim().max(100).optional()}).strict();
const messageInput=z.object({content:z.string().trim().min(1).max(4000),clientMessageId:z.string().min(8).max(100)}).strict();
export async function listAgentSessions(workspaceId:string,key:unknown){const role=agentKeySchema.parse(key);await agentFacts(workspaceId);return serialize(await db.agentSession.findMany({where:{workspaceId,agentKey:role,kind:{in:["FIVE_AGENT","GOAL_DISCOVERY"]},status:{not:"CANCELLED"}},orderBy:{updatedAt:"desc"},take:30}));}
export async function createAgentSession(workspaceId:string,raw:unknown){
 const input=sessionInput.parse(raw);const facts=await agentFacts(workspaceId,input.goalId,input.decisionId);
 return serialize(await db.agentSession.create({data:{workspaceId,agentKey:input.agentKey,kind:"FIVE_AGENT",goalId:input.goalId,decisionId:input.decisionId??(input.goalId?facts.decisions[0]?.id:null)??null,title:input.title||agentLabels[input.agentKey],sourceRevision:facts.revision}}));
}
export async function getAgentSession(workspaceId:string,id:string){
 const session=await db.agentSession.findFirst({where:{workspaceId,id,kind:{in:["FIVE_AGENT","GOAL_DISCOVERY"]}},include:{messages:{orderBy:[{createdAt:"desc"},{id:"desc"}],take:200},runs:{orderBy:{createdAt:"desc"},take:15,include:{proposals:true}}}});
 if(!session)throw new ApiError("会话不存在",404);
 const fundingDecision=session.agentKey==="GOAL"?await db.carDecision.findFirst({where:{workspaceId,OR:[{goalSessionId:session.id},...(session.goalId?[{goalId:session.goalId}]:[])]},orderBy:{updatedAt:"desc"},select:{id:true,version:true,status:true,activePlanId:true}}):null;
 const proposals=await db.agentProposal.findMany({where:{workspaceId,status:"PENDING",run:{sessionId:id}}});return serialize({...session,funding:fundingDecision,readOnly:session.kind!=="FIVE_AGENT",messages:session.messages.reverse(),proposals});
}
export async function startAgentMessage(workspaceId:string,id:string,raw:unknown){
 const input=messageInput.parse(raw);const session=await db.agentSession.findFirst({where:{workspaceId,id,kind:"FIVE_AGENT",status:{not:"CANCELLED"}}});if(!session)throw new ApiError("会话不存在",404);
 const prior=await db.agentRun.findUnique({where:{sessionId_requestId:{sessionId:id,requestId:input.clientMessageId}}});if(prior){const old=JSON.parse(prior.inputJson);if(old.content!==input.content)throw new ApiError("重复请求标识对应不同消息",409);return prior;}
 const facts=await agentFacts(workspaceId,session.goalId,session.decisionId);
 return db.$transaction(async tx=>{
  const busy=await tx.agentRun.findFirst({where:{workspaceId,sessionId:id,parentRunId:null,status:{in:active}}});
  if(busy&&busy.leaseUntil&&busy.leaseUntil>new Date())throw new ApiError("上一条消息仍在处理，请稍候",409);
  if(busy)await tx.agentRun.update({where:{id:busy.id},data:{status:"INTERRUPTED",errorCode:"LEASE_EXPIRED"}});
  const claimed=await tx.agentSession.updateMany({where:{workspaceId,id,version:session.version,status:{not:"CANCELLED"}},data:{version:{increment:1},status:"PROCESSING",...(session.title===agentLabels[agentKeySchema.parse(session.agentKey)]?{title:input.content.slice(0,36)}:{})}});if(!claimed.count)throw new ApiError("会话已变化，请刷新",409);
  const run=await tx.agentRun.create({data:{workspaceId,sessionId:id,agentKey:agentKeySchema.parse(session.agentKey),requestId:input.clientMessageId,sourceSignature:facts.signature,promptVersion:AGENT_PROMPT_VERSION,model:modelConfig('OPENAI').MODEL?.trim()||"not-configured",inputJson:encode(input),leaseUntil:new Date(Date.now()+130000)}});
  await tx.agentMessage.create({data:{sessionId:id,runId:run.id,clientMessageId:input.clientMessageId,role:"USER",content:input.content,sourceRevision:facts.revision}});return run;
 });
}
async function step(runId:string,name:string,input:unknown,output:unknown,status="COMPLETED"){
 await db.$transaction(async tx=>{const run=await tx.agentRun.findUniqueOrThrow({where:{id:runId}});const previous=await tx.agentStep.aggregate({where:{sessionId:run.sessionId},_max:{sequence:true}});await tx.agentStep.create({data:{sessionId:run.sessionId,runId,sequence:(previous._max.sequence??0)+1,toolName:name,inputJson:encode(input),outputJson:encode(output),status,sourceRevision:0,completedAt:new Date()}});});
}
function checkBudget(b:Budget){if(b.signal?.aborted)throw new ApiError("本次处理已停止，可稍后继续",499);if(b.calls>=16||b.tools>=24||Date.now()-b.started>=AGENT_RUN_TIMEOUT_MS)throw new ApiError("本轮已到处理上限，请继续核对剩余事项",429);}
export async function executeAgentRun(workspaceId:string,id:string,emit:(event:AgentEvent)=>void=()=>{},options:{model?:Model;signal?:AbortSignal}={}){
 const budget:Budget={calls:0,tools:0,started:Date.now(),signal:options.signal};
 const model=options.model??((prompt,input)=>structuredResponse(prompt,input,"financial_agent_decision",decisionJsonSchema,agentModelTimeoutMs(AGENT_RUN_TIMEOUT_MS-(Date.now()-budget.started)),options.signal));
 const run=await db.agentRun.findFirst({where:{workspaceId,id,parentRunId:null}});if(!run)throw new ApiError("运行不存在",404);
 if(!active.includes(run.status))return JSON.parse(run.resultJson);
 const claim=await db.agentRun.updateMany({where:{id,workspaceId,status:"QUEUED"},data:{status:"RUNNING"}});if(!claim.count)return {status:"RUNNING",runId:id};
 try{return await perform(id,budget,model,emit);}
 catch(error){
  const interrupted=options.signal?.aborted;const status=interrupted?"INTERRUPTED":error instanceof ApiError&&error.status===429?"PARTIAL":"FAILED";
  const failure=agentFailure(error,Boolean(interrupted));
  const result={status,mode:"ERROR",message:interrupted?"处理已中断，可继续本次对话。":"本次处理未完成，已保留消息与工具记录。请重试或使用页面中的资料和计算功能。",error:failure.message,runId:id};
  await db.agentRun.updateMany({where:{workspaceId,id,status:{in:active}},data:{status,resultJson:encode(result),errorCode:failure.code,completedAt:new Date()}});
  await db.agentSession.updateMany({where:{id:run.sessionId,workspaceId,status:"PROCESSING"},data:{status:"ACTIVE"}});emit({type:"error",runId:id,result});return result;
 }
}
async function perform(id:string,budget:Budget,model:Model,emit:(e:AgentEvent)=>void):Promise<unknown>{
 const run=await db.agentRun.findUniqueOrThrow({where:{id},include:{session:true}});const key=agentKeySchema.parse(run.agentKey);
 const facts=await agentFacts(run.workspaceId,run.session.goalId,run.session.decisionId);
 await registerAgentDependencies("AGENT_RUN",id,facts);
 const prompt=agentPrompt(key,run.mode);const input=JSON.parse(run.inputJson);
 const messages=run.parentRunId?[]:(await db.agentMessage.findMany({where:{sessionId:run.sessionId},orderBy:[{createdAt:"desc"},{id:"desc"}],take:12})).reverse().map(m=>({role:m.role,content:m.content}));
 if(!run.parentRunId){const older=await db.agentMessage.findMany({where:{sessionId:run.sessionId},orderBy:[{createdAt:"desc"},{id:"desc"}],skip:12,take:24});if(older.length){run.session.summaryJson=encode({nature:"UNCONFIRMED_CONVERSATION_EXCERPTS",coverage:older.map(m=>m.id),excerpts:older.reverse().map(m=>({messageId:m.id,role:m.role,quote:m.content.slice(0,400)})),note:"较早原话摘录，只辅助理解，不作为计算依据"});await db.agentSession.update({where:{id:run.sessionId},data:{summaryJson:run.session.summaryJson}});}}
 const history=await db.agentStep.findMany({where:{runId:id,status:"COMPLETED"},orderBy:{sequence:"asc"}});
 const outputs:{evidenceId:string;tool:string;result:unknown}[]=run.sourceSignature===facts.signature?history.filter(s=>s.toolName!=="MODEL").map(s=>({evidenceId:`STEP:${s.id}`,tool:s.toolName,result:JSON.parse(s.outputJson??"{}")})):[];
 await db.agentRun.update({where:{id},data:{sourceSignature:facts.signature,promptVersion:`${AGENT_PROMPT_VERSION}:${createHash("sha256").update(prompt).digest("hex").slice(0,12)}`}});
 emit({type:"start",runId:id,agentKey:key,message:`${agentLabels[key]}正在核对资料`});
 for(let turn=0;turn<6;turn++){
  checkBudget(budget);budget.calls++;
  const latest=await db.agentRun.findUniqueOrThrow({where:{id}});const parent=run.parentRunId?await db.agentRun.findUnique({where:{id:run.parentRunId}}):null;if(latest.status==="CANCELLED"||parent?.status==="CANCELLED")throw new ApiError("任务已取消",499);
  const raw=await model(prompt,{currentDate:facts.asOf,mode:run.mode,task:input,context:contextForAgent(key,facts),conversation:messages,summary:JSON.parse(run.session.summaryJson),tools:toolCatalog(key),toolResults:outputs});
  const afterModel=await db.agentRun.findUniqueOrThrow({where:{id}});
  if(afterModel.status==="CANCELLED")throw new ApiError("任务已取消",499);
  const response=agentDecisionSchema.parse(raw);await step(id,"MODEL",{promptVersion:AGENT_PROMPT_VERSION,turn},response);checkBudget(budget);
  if(response.kind==="CALL_TOOL"){
   if(!response.toolName||!response.argumentsJson)throw new ApiError("工具请求缺少参数",422);
   budget.tools++;emit({type:"tool",runId:id,agentKey:key,message:"正在核对专业资料与计算依据"});
   try{const result=await executeAgentTool(response.toolName,JSON.parse(response.argumentsJson),{workspaceId:run.workspaceId,agentKey:key,sessionId:run.sessionId,runId:id,goalId:run.session.goalId,decisionId:run.session.decisionId,facts});await step(id,response.toolName,JSON.parse(response.argumentsJson),result);outputs.push({evidenceId:`TOOL:${id}:${turn}`,tool:response.toolName,result});}
   catch(e){await step(id,response.toolName,{argumentsJson:response.argumentsJson},{error:e instanceof Error?e.message:"工具失败"},"FAILED");if(e instanceof ApiError&&e.status===403)throw e;outputs.push({evidenceId:`ERROR:${id}:${turn}`,tool:response.toolName,result:{status:"NEEDS_INFORMATION",error:e instanceof Error?e.message:"工具失败"}});}
   continue;
  }
  if(response.kind==="REQUEST_SPECIALIST"){
   if(key!=="WEALTH"||!response.specialist||response.specialist==="WEALTH"||run.parentRunId)throw new ApiError("只有总管家可以委派四个专业管家",403);
   budget.tools++;checkBudget(budget);
   const child=await db.agentRun.create({data:{workspaceId:run.workspaceId,sessionId:run.sessionId,parentRunId:id,agentKey:response.specialist,mode:"SPECIALIST_REVIEW",requestId:`${id}:${turn}`,status:"RUNNING",sourceSignature:facts.signature,promptVersion:AGENT_PROMPT_VERSION,model:run.model,inputJson:encode({task:response.message,scope:{goalId:run.session.goalId,decisionId:run.session.decisionId}})}});
   emit({type:"specialist",runId:id,agentKey:response.specialist,message:`${agentLabels[response.specialist]}参与核对`});
   let result:unknown;try{result=await perform(child.id,budget,model,emit);}catch(e){result={status:"PARTIAL",agentKey:response.specialist,missing:[e instanceof ApiError?e.message:"专业评估失败"]};await db.agentRun.update({where:{id:child.id},data:{status:"FAILED",resultJson:encode(result),completedAt:new Date()}});}
   await step(id,`SPECIALIST:${response.specialist}`,{task:response.message},result);outputs.push({evidenceId:`RUN:${child.id}`,tool:`SPECIALIST:${response.specialist}`,result});continue;
  }
  return complete(run,response,outputs,facts.signature,emit);
 }
 return complete(run,{kind:"ASK",message:"已完成部分资料核对。本轮未形成完整结论，请继续补充资料或查看待确认事项。",toolName:null,argumentsJson:null,specialist:null,evidenceIds:[],missing:["需要继续核对"]},outputs,facts.signature,emit,"PARTIAL");
}
async function complete(run:{id:string;workspaceId:string;sessionId:string;parentRunId:string|null;agentKey:string},answer:AgentDecision,outputs:unknown[],signature:string,emit:(e:AgentEvent)=>void,forced?:string){
 const pending=await db.agentProposal.findMany({where:{workspaceId:run.workspaceId,run:{OR:[{id:run.id},{parentRunId:run.id}]},status:"PENDING"}});
 const current=await db.agentRun.findUniqueOrThrow({where:{id:run.id},include:{session:true}});const fresh=await agentFacts(run.workspaceId,current.session.goalId,current.session.decisionId);
 if(current.status==="CANCELLED")throw new ApiError("任务已取消",499);
 const paperResults=outputs.map(o=>(o as {result?:{paperContext?:{accountId:string;accountVersion:number};paperContexts?:{accountId:string;accountVersion:number}[];evidenceIds?:unknown[]}}).result).filter(r=>r?.paperContext||r?.paperContexts);
 const paperEvidence=paperResults.flatMap(r=>r?.evidenceIds?.filter((e):e is string=>typeof e==="string"&&e.startsWith("PAPER_"))??[]);
 const worldlineEvidence=outputs.flatMap(o=>{const r=(o as {result?:{evidenceIds?:unknown[]}}).result;return (r?.evidenceIds??[]).filter((e):e is string=>typeof e==="string"&&e.startsWith("WORLDLINE"))});
 const paperContexts=paperResults.flatMap(r=>r?.paperContext?[r.paperContext]:r?.paperContexts??[]);
 const paperStale=(await Promise.all(paperContexts.map(async context=>{const row=await db.paperAccount.findFirst({where:{workspaceId:run.workspaceId,id:context.accountId}});return !row||row.version!==context.accountVersion;}))).some(Boolean);
 const validEvidence=new Set([`FACTS:${fresh.signature}`,`GOALS:${fresh.signature}`,`PROGRESS:${fresh.signature}`,...fresh.assets.map(a=>a.id),...fresh.goals.map(g=>g.id),...fresh.policies.map(p=>p.id),...fresh.constraints.map(c=>c.id),...fresh.actions.map(a=>a.id),...fresh.decisions.map(d=>d.id),...fresh.products.map(p=>p.id),...outputs.map(o=>(o as {evidenceId:string}).evidenceId),...paperEvidence,...worldlineEvidence]);
 if(answer.evidenceIds.some(id=>!validEvidence.has(id)))throw new ApiError("回复引用的依据无法核对，请重新生成",422);
 const stale=fresh.signature!==signature||paperStale;
 const status=forced??(stale?"PARTIAL":pending.length?"WAITING_CONFIRMATION":answer.kind==="ASK"?"WAITING_USER":"COMPLETED");
 const result={runId:run.id,agentKey:run.agentKey,status,mode:"AI",message:stale?`${answer.message}\n资料在处理期间发生变化，请重新核对后采用结果。`:answer.message,evidenceIds:answer.evidenceIds,missing:[...answer.missing,...outputs.flatMap(o=>{const r=(o as {result?:{error?:string}}).result;return r?.error?[`操作未完成：${r.error}`]:[];})],toolResults:serialize(outputs),proposals:serialize(pending),sourceSignature:signature,asOf:fresh.asOf};
 await db.$transaction(async tx=>{
  const claim=await tx.agentRun.updateMany({where:{id:run.id,status:"RUNNING"},data:{status,resultJson:encode(result),completedAt:new Date()}});if(!claim.count)return;
  if(!run.parentRunId){await tx.agentMessage.create({data:{sessionId:run.sessionId,runId:run.id,role:"ASSISTANT",content:result.message,displayJson:encode(result),sourceRevision:fresh.revision}});await tx.agentSession.update({where:{id:run.sessionId},data:{status:"ACTIVE",updatedAt:new Date()}});}
 });
 emit({type:"complete",runId:run.id,result});return result;
}
export async function getAgentRun(workspaceId:string,id:string){const run=await db.agentRun.findFirst({where:{workspaceId,id},include:{proposals:true}});if(!run)throw new ApiError("运行不存在",404);if(active.includes(run.status)&&run.leaseUntil&&run.leaseUntil<new Date()){await db.agentRun.update({where:{id},data:{status:"INTERRUPTED",errorCode:"LEASE_EXPIRED"}});run.status="INTERRUPTED";}return serialize(run);}
export async function resumeAgentRun(workspaceId:string,id:string){const run=await db.agentRun.findFirst({where:{workspaceId,id,parentRunId:null},include:{session:true}});if(!run||run.session.status==="CANCELLED")throw new ApiError("运行不可恢复",409);await getAgentRun(workspaceId,id);const changed=await db.agentRun.updateMany({where:{workspaceId,id,status:{in:["INTERRUPTED","FAILED","PARTIAL"]}},data:{status:"QUEUED",leaseUntil:new Date(Date.now()+130000),errorCode:null}});if(!changed.count)throw new ApiError("运行不处于可恢复状态",409);return {runId:id};}
export async function cancelAgentRun(workspaceId:string,id:string){return db.$transaction(async tx=>{
 const run=await tx.agentRun.findFirst({where:{workspaceId,id,parentRunId:null}});if(!run)throw new ApiError("运行不存在",404);
 const c=await tx.agentRun.updateMany({where:{workspaceId,id,status:{in:active}},data:{status:"CANCELLED",completedAt:new Date()}});if(!c.count)throw new ApiError("运行已经结束",409);
 await tx.agentRun.updateMany({where:{workspaceId,parentRunId:id,status:{in:active}},data:{status:"CANCELLED",completedAt:new Date()}});
 await tx.agentProposal.updateMany({where:{workspaceId,run:{OR:[{id},{parentRunId:id}]},status:"PENDING"},data:{status:"REJECTED"}});
 await tx.agentSession.updateMany({where:{workspaceId,id:run.sessionId,status:"PROCESSING"},data:{status:"ACTIVE"}});return {cancelled:true};
});}
