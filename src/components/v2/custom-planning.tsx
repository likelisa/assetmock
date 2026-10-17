'use client';
import type { Input } from '@/domain/v2/types';
import type { PlanPreview } from './planning';
export function CustomPlanning({input,update,onPrepare,onStart,preview,busy,confirmed,setConfirmed,notice}:{input:Input;update:(v:Input)=>void;onPrepare:(goal:string)=>void;onStart:()=>void;preview:PlanPreview|null;busy:boolean;confirmed:boolean;setConfirmed:(v:boolean)=>void;notice?:string}) {
 const c=input.custom!;
 function edit(fn:(v:NonNullable<Input['custom']>)=>void){const next=structuredClone(input);fn(next.custom!);update(next);}
 return <section><h1>为你的目标，比较两种行动方案</h1><label>想做什么？<textarea aria-label="自定义目标" value={c.goal} placeholder="例如：我想裸辞半年，也考虑边工作边找机会。" onChange={e=>edit(v=>{v.goal=e.target.value;})}/></label><button className="secondary" disabled={busy||!c.goal.trim()} onClick={()=>onPrepare(c.goal)}>AI 整理两种行动方案</button>{notice&&<p role="status">{notice}</p>}
 <p className="hint">先选择角色，再核对以下全部假设。教育、创业收益和重新就业收入均不保证发生；可将对应阶段收入设为零进行压力测试。</p>
 <label>推演月数（1—360）<input type="number" min="1" max="360" value={c.months} onChange={e=>edit(v=>{v.months=Number(e.target.value);})}/></label>
 <div className="v2-pair">{c.actions.map((a,i)=><article className={`v2-plan path-${i?'b':'a'}`} key={i}><h2>行动方案 {i?'B':'A'}</h2><label>方案名称<input value={a.name} onChange={e=>edit(v=>{v.actions[i].name=e.target.value;})}/></label><label>一次性投入（元）<input type="number" min="0" value={a.upfront/100} onChange={e=>edit(v=>{v.actions[i].upfront=Math.round(Number(e.target.value)*100);})}/></label>
 {a.phases.map((p,j)=><fieldset key={j}><legend>第 {j+1} 阶段</legend><label>持续月数<input type="number" min="1" max="360" value={p.months} onChange={e=>edit(v=>{v.actions[i].phases[j].months=Number(e.target.value);})}/></label><label>每月总收入（元）<input type="number" min="0" value={p.income/100} onChange={e=>edit(v=>{v.actions[i].phases[j].income=Math.round(Number(e.target.value)*100);})}/></label><label>每月额外支出（元，不含原生活费）<input type="number" min="0" value={p.extraExpense/100} onChange={e=>edit(v=>{v.actions[i].phases[j].extraExpense=Math.round(Number(e.target.value)*100);})}/></label>{a.phases.length>1&&<button className="text-button" onClick={()=>edit(v=>{v.actions[i].phases.splice(j,1);})}>删除阶段</button>}</fieldset>)}
 <button className="secondary" disabled={a.phases.length>=12} onClick={()=>edit(v=>{v.actions[i].phases.push({months:1,income:0,extraExpense:0});})}>添加阶段</button><p>阶段合计 {a.phases.reduce((n,p)=>n+p.months,0)} / {c.months} 个月</p></article>)}</div>
 <label>假设说明（每行一项）<textarea value={c.assumptions.join('\n')} onChange={e=>edit(v=>{v.assumptions=e.target.value.split('\n');})}/></label>
 <p className="v2-rules">两条方案沿用同一角色原有生活费、租金和既有还款；阶段收入替代原工资，不重复叠加。新增支出在原生活费外计算。本版不新增贷款，不计年度奖金；收入按确认的阶段固定变化，不再抽取随机失业与职业机会。医疗和投资下跌仍按共同事件记录发生。所有修改仅用于本局推演。</p>
 {preview?.errors.map(e=><p role="alert" key={e}>{e}</p>)}<label className="check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对两条行动方案的金额、持续时间和假设，确认开始。</label><button className="primary" disabled={busy||!confirmed||!preview||!!preview.errors.length} onClick={onStart}>确认方案，开始人生</button>
 </section>;
}
