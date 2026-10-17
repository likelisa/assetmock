'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AgentConversation } from './agent-conversation';
import { FundingFactsForm } from './goal-funding-form';
import { FundingPlanPanel } from './goal-funding-panel';
import type { getGoalFunding } from '@/server/goal-funding';
import './goal-funding.css';
export type FundingState = Awaited<ReturnType<typeof getGoalFunding>>;
export async function fundingRequest<T>(workspaceId:string,path:string,body?:unknown):Promise<T>{
 const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'X-Workspace-Id':workspaceId,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.error??'操作未完成');return data;
}
export function GoalFundingWorkspace({workspaceId,revision,goals,onDataChange,onOpenPlanning,children}:{workspaceId:string;revision:number;goals:{id:string;name:string}[];onDataChange:()=>Promise<void>;onOpenPlanning:()=>void;children?:ReactNode}){
 const planRef=useRef<HTMLDivElement>(null);const dataChangeRef=useRef(onDataChange);
 useEffect(()=>{dataChangeRef.current=onDataChange;},[onDataChange]);
 const [session,setSession]=useState<{id:string;goalId:string|null}|null>(null);const [requested,setRequested]=useState<string>();const [activity,setActivity]=useState(0);
 const [loaded,setState]=useState<FundingState|null>(null);const state=loaded?.sessionId===session?.id?loaded:null;const sessionRef=useRef<string|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [editing,setEditing]=useState(false);const [mobile,setMobile]=useState<'chat'|'plan'>('chat');const [refreshChat,setRefreshChat]=useState(0);
 const sessionChanged=useCallback((s:{id:string;goalId:string|null}|null)=>{if(sessionRef.current!==s?.id){setEditing(false);setError('');sessionRef.current=s?.id??null;}setSession(s);setActivity(v=>v+1);},[]);
 useEffect(()=>{let alive=true;if(session?.id)void fundingRequest<FundingState>(workspaceId,`/api/goal-planning/${session.id}`).then(s=>{if(alive){setState(s);setError('');if(s.goalId&&s.goalId!==session.goalId){setRefreshChat(v=>v+1);void dataChangeRef.current();}}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[workspaceId,session?.id,session?.goalId,revision,activity]);
 async function create(){setBusy(true);setError('');try{const s=await fundingRequest<{id:string}>(workspaceId,'/api/agent-sessions',{agentKey:'GOAL',title:'买车资金规划'});setRequested(s.id);setMobile('plan');setEditing(true);}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
 async function command(action:'SAVE'|'GENERATE'|'ADOPT',data?:unknown){if(!session)return;setBusy(true);setError('');try{const next=await fundingRequest<FundingState>(workspaceId,`/api/goal-planning/${session.id}`,{action,data});setState(next);setEditing(false);setRefreshChat(v=>v+1);await onDataChange();}catch(e){setError((e as Error).message);throw e;}finally{setBusy(false);}}
 return <section className="funding-workspace" aria-label="目标对话与资金方案">
  <div className="funding-mobile-tabs" role="tablist" aria-label="目标管家视图"><button role="tab" aria-selected={mobile==='chat'} onClick={()=>setMobile('chat')}>对话</button><button role="tab" aria-selected={mobile==='plan'} onClick={()=>setMobile('plan')}>方案</button></div>
  <div className="funding-columns"><div className={`funding-chat ${mobile==='chat'?'is-visible':''}`}>
    <AgentConversation workspaceId={workspaceId} agentKey="GOAL" goals={goals} onDataChange={onDataChange} onOpenPlanning={()=>{setMobile('plan');requestAnimationFrame(()=>{planRef.current?.focus({preventScroll:true});planRef.current?.scrollIntoView({behavior:'smooth',block:'start'});});}} embedded onSessionUpdate={sessionChanged} requestedSessionId={requested} refreshKey={refreshChat}/>
  </div><div className={`funding-plan ${mobile==='plan'?'is-visible':''}`} ref={planRef} tabIndex={-1} style={{scrollMarginTop:96}} aria-label="当前资金规划" aria-busy={busy}>
   {state?.goalId&&!state.activePlan&&!state.evaluation&&<p className="funding-note" role="status"><strong>目标已保存，尚未采用资金方案。</strong><br/>下一步：核对下方底账和费用，保存资料后点击“核对并生成资金方案”。</p>}
   {error&&<p className="funding-alert" role="alert">{error}</p>}
   {!state?<div className="funding-empty"><h2>把目标变成一份可执行的安排</h2><p>从左侧说说买车的预算与时间，或先填写目标。方案会留在这里，随讨论逐步完善。</p><button className="button-primary" disabled={busy} onClick={()=>void create()}>填写买车目标</button>{session&&error&&<button className="button-secondary" onClick={()=>setActivity(v=>v+1)}>重新读取</button>}</div>:
   editing||!state.decisionId?<FundingFactsForm key={`${state.sessionId}:${state.decisionVersion}`} state={state} busy={busy} onCancel={state.decisionId?()=>setEditing(false):undefined} onSave={data=>command('SAVE',data)}/>:
   <FundingPlanPanel state={state} busy={busy} onEdit={()=>setEditing(true)} onGenerate={()=>command('GENERATE')} onAdopt={data=>command('ADOPT',data)} onRefresh={()=>setActivity(v=>v+1)} workspaceId={workspaceId}/>
   }
  </div></div>
  <details className="funding-other"><summary>其他目标、历史方案与统一事项</summary>{children}<button className="manager-text-button" onClick={onOpenPlanning}>查看原规划与实际购车记录</button></details>
 </section>;
}
