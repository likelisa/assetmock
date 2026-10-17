'use client';
import { useEffect, useState } from 'react';
import { LifeSimulator } from './v2/simulator';
import type { Character, Target } from '@/domain/v2/types';
import { SIMULATION_NOTICE, type OpeningDraft } from '@/domain/simulation-opening';
type Opening = { id:string; profile:Character; price?:number };
type Saved = {runId:string;version:number;stale:boolean;source:{kind:string};report:{notice:string}|null;updatedAt:string};
const labels={age:'年龄',cash:'纳入现金',fund:'纳入投资',salary:'月收入',living:'月生活费（不含还本金）',rent:'生活费中的租金',debt:'既有负债本金',debtPayment:'每月还本金',bonus:'年度奖金'};
export function IntegratedSimulation({workspaceId,goalId}:{workspaceId:string;goalId?:string}){
 const [draft,setDraft]=useState<OpeningDraft>();const [values,setValues]=useState<Record<string,string>>({});const [target,setTarget]=useState<Target>('car');
 const [opening,setOpening]=useState<Opening>();const [playing,setPlaying]=useState(true);const [selected,setSelected]=useState<string>();const [reports,setReports]=useState<Saved[]>([]);
 const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [generation,setGeneration]=useState(0);
 async function request<T>(path:string,data?:unknown):Promise<T>{const r=await fetch(`/api/simulations/${path}`,{method:data===undefined?'GET':'POST',headers:{'X-Workspace-Id':workspaceId,'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});const v=await r.json();if(!r.ok)throw new Error(v.error);return v;}
 useEffect(()=>{let active=true;void Promise.all([request<OpeningDraft>(`opening${goalId?`?goalId=${encodeURIComponent(goalId)}`:''}`),request<Saved[]>('reports')]).then(([d,r])=>{if(!active)return;setDraft(d);setTarget(d.target??'car');setValues(Object.fromEntries(Object.entries(d.values).map(([k,v])=>[k,v===null?'':k==='age'?v:(Number(v)/100).toFixed(2)])));setReports(r);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[workspaceId,goalId,generation]); // request is scoped to the current workspace
 async function begin(){if(!draft)return;setBusy(true);setError('');try{
  const converted=Object.fromEntries(Object.entries(values).map(([k,v])=>{if(v.trim()===''||!/^\d+(\.\d{1,2})?$/.test(v))throw new Error('请补齐所有字段；金额最多两位小数。');if(k==='age')return[k,Number(v)];const [yuan,cents='']=v.split('.');return[k,(BigInt(yuan)*100n+BigInt(cents.padEnd(2,'0'))).toString()];}));
  const o=await request<Opening>('opening',{...converted,target,goalId:draft.target===target?(goalId??null):null,sourceSignature:draft.sourceSignature,confirmed:true,acknowledgeRestrictions:true});
  setOpening({...o,price:draft.target===target&&draft.price?Number(draft.price):undefined});setSelected(undefined);setPlaying(true);
 }catch(e){setError(e instanceof Error?e.message:'确认失败');}finally{setBusy(false);}}
 function exit(){setPlaying(false);setOpening(undefined);setSelected(undefined);setGeneration(x=>x+1);setConfirmed(false);}
 if(playing)return <div className="life-game"><LifeSimulator key={opening?.id??selected??'demo'} workspaceId={workspaceId} autoResume={true} opening={opening} initialRunId={selected} onExit={exit}/></div>;
 return <section className="integration-opening"><header><h2>简化底账与推演记录</h2></header>
 <div className="integration-actions"><button className="button-secondary" onClick={()=>{setOpening(undefined);setSelected(undefined);localStorage.removeItem(`life-integrated:${workspaceId}`);setPlaying(true);}}>返回目标选择</button><a className="button-secondary" href="/simulation-archive">查看旧版入口与历史说明</a></div>
 {error&&<p role="alert">{error}</p>}
 {!draft?<p>正在读取当前底账…</p>:<><h3>确认简化游戏底账</h3><p className="integration-notice">{SIMULATION_NOTICE}</p>{goalId&&!draft.target&&<p>当前目标暂不支持推演。可选择买车或买房作为独立游戏假设，不修改原目标。</p>}
 <label>本局目标<select aria-label="本局目标" value={target} onChange={e=>{setTarget(e.target.value as Target);setConfirmed(false);}}><option value="car">买车 · 5 年</option><option value="home">买房 · 30 年</option></select></label>
 <details><summary>查看资产来源与默认排除原因</summary><div className="integration-table"><table><thead><tr><th>资产</th><th>底账余额（元）</th><th>纳入（元）</th><th>说明</th></tr></thead><tbody>{draft.assets.map(a=><tr key={a.id}><td>{a.name}</td><td>{(Number(a.balance)/100).toFixed(2)}</td><td>{(Number(a.included)/100).toFixed(2)}</td><td>{a.reason}</td></tr>)}</tbody></table></div></details>
 <div className="integration-fields">{Object.entries(labels).map(([key,label])=><label key={key}>{label}{key!=='age'?'（元）':''}<input aria-label={label} inputMode="decimal" value={values[key]??''} placeholder="待确认" onChange={e=>{setValues(v=>({...v,[key]:e.target.value}));setConfirmed(false);}}/></label>)}</div>
 <details><summary>预算口径与简化规则</summary><ul>{draft.notes.map(n=><li key={n}>{n}</li>)}</ul></details>
 <label className="integration-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对上述金额；修改只作为游戏假设，不解除真实底账的资金限制。</label>
 <button className="button-primary" disabled={!confirmed||busy} onClick={()=>void begin()}>{busy?'正在确认…':'确认底账，比较付款方案'}</button></>}
 <section className="integration-reports"><h3>本工作区的推演记录</h3>{!reports.length&&<p>尚无记录。游戏进度自动保存，报告需要点击保存。</p>}{reports.map(r=><article key={r.runId}><div><strong>{r.source.kind==='ledger'?'简化底账推演':'虚构角色体验'}</strong><p>{r.report?'报告已保存':'进度已保存'} · {new Date(r.updatedAt).toLocaleString('zh-CN')}</p>{r.stale&&<p>来源底账已更新；继续本局仍使用原快照。</p>}</div><button className="button-secondary" onClick={()=>{setSelected(r.runId);setOpening(undefined);setPlaying(true);}}>查看／继续</button></article>)}</section>
 </section>;
}
