'use client';
import { useEffect, useState } from 'react';
import { histogram, riskOf, sharedEdges, type EndingAnalysisSnapshot } from '@/domain/worldline/ending';
import { yuan } from './geometry';
import './ending-analysis.css';
const money=(v:number)=>`${yuan(v)} 元`;
export function EndingAnalysis({workspaceId,runId,version}:{workspaceId:string;runId:string;version:number}) {
  const [analysis,setAnalysis]=useState<EndingAnalysisSnapshot>();
  const [error,setError]=useState('');
  const [attempt,setAttempt]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    async function load() {
      const url=`/api/simulations/runs/${runId}/worldline-analysis`;
      const headers={'X-Workspace-Id':workspaceId,'Content-Type':'application/json'};
      async function request(method:'GET'|'POST') {
        const response=await fetch(url,{method,headers,signal:controller.signal,...(method==='POST'?{body:JSON.stringify({expectedVersion:version})}:{})});
        const result=await response.json();
        if(!response.ok) throw new Error(result.error || '样本分析暂时不可用');
        return result as {analysis:EndingAnalysisSnapshot|null};
      }
      try { let result=await request('GET'); if(!result.analysis) result=await request('POST'); if(!controller.signal.aborted && result.analysis) setAnalysis(result.analysis); }
      catch(e) {if(!controller.signal.aborted) setError(e instanceof Error?e.message:'样本分析暂时不可用');}
    }
    void load();return ()=>controller.abort();
  },[workspaceId,runId,version,attempt]);
  return <section className="ending-analysis" aria-label="本局多世界分析">
    <h2>换一些经历，结果会怎样？</h2>
    <p>本局经历已记录。下面另算 200 个模拟样本，不把本局计入样本。</p>
    {!analysis && !error && <p role="status">正在按本局条件计算样本…你可以继续查看结局或重玩。</p>}
    {error && <p role="alert">{error} <button onClick={()=>{setError('');setAttempt(a=>a+1);}}>重试分析</button></p>}
    {analysis && <>
      <p>沿用本局底账、付款方案与事件规则，仅改变随机经历。统一应对：失业后继续寻找原薪工作，职业机会维持现状；未复刻你的逐次选择。</p>
      <div className="ending-pair">{analysis.strategies.map(s=><article key={s.id}><h3>{s.id.toUpperCase()} · {s.label}</h3><strong>{s.failed} / {analysis.n} 个样本出现资金缺口</strong><p>模拟样本占比 {(s.failed/analysis.n*100).toFixed(1)}%</p><p>样本最低可用资金的中位数：{money(s.p50)}</p><p>其中 5% 分位 {money(s.p5)} · 90% 分位 {money(s.p90)}</p></article>)}</div>
      <p>以上是本局假设下的样本占比，不是现实发生概率。负数表示未能支付的缺口，不是实际账户负余额。</p>
      <details><summary>展开样本与分析</summary><Distribution analysis={analysis}/>
        <h3>代表性模拟样本</h3><p>按两方案最低可用资金中的较低值排序，展示最低、中间、最高三个样本；均不是你玩的本局。</p>
        {analysis.samples.map((sample,index)=><details key={sample.id}><summary>{['较低结果','中间结果','较高结果'][index]} · {sample.id}</summary>
          <SampleChart sample={sample} months={analysis.months}/>
          {Object.entries(sample.strategies).map(([id,s])=><p key={id}>{id.toUpperCase()} · {s.label}：最低 {money(s.minUsable)}；{s.firstShortfall?`第 ${s.firstShortfall.month} 月缺口 ${money(s.firstShortfall.amountMinor)}，此后停止展示`:'完成模拟期限'}</p>)}
          <details><summary>事件经过（{sample.events.length}）</summary>{sample.events.map((e,i)=><p key={i}>第 {e.month} 月：{e.title}</p>)}</details>
        </details>)}
        <details><summary>计算依据与复现信息</summary><p>本局 {analysis.runId} · 版本 {analysis.runVersion}；模拟期限 {analysis.months} 个月；样本 {analysis.n} 个。</p><p>游戏规则 {analysis.rulesVersion} · 计算 {analysis.version} · 随机种子 {analysis.seed}</p><p>事件抽取阈值（每百万／月，是否触发还受游戏状态约束）：</p><ul>{Object.entries(analysis.probabilities).map(([key,value])=><li key={key}>{({medical:'医疗',jobLoss:'失业',bonusDelay:'奖金延期',marketDrop:'投资下跌',career:'职业机会'} as Record<string,string>)[key] ?? key}：{value}</li>)}</ul><p>采用游戏内假设，没有额外引入真实统计数据、压力参数或未来收益。</p><p className="ending-signature">输入签名 {analysis.signature}</p></details>
      </details>
    </>}
  </section>;
}
function Distribution({analysis}:{analysis:EndingAnalysisSnapshot}) {
  const edges=sharedEdges(analysis.strategies.flatMap(s=>s.minima),[0,...analysis.strategies.flatMap(s=>[s.floor,s.floor*1.25])]);
  return <section><h3>最低可用资金分布</h3><p>两方案共用金额区间与 0–100% 占比刻度，每个样本计数一次。柱长表示实际样本占比，颜色表示储备状态。</p>
    <div className="ending-pair">{analysis.strategies.map(s=><article key={s.id}><h4>{s.id.toUpperCase()} · {s.label}</h4><p>储备门槛 {money(s.floor)}{s.floor<edges[0]||s.floor>edges.at(-1)!?'（在分布范围外）':''}</p>
      {histogram(s.minima,edges).map((b,i)=>{const risk=riskOf(b.from,s.floor);return <div className="ending-bin" key={i}><span>{money(b.from)} 至 {money(b.to)}{i===edges.length-2?'（含上限）':'（不含上限）'}</span><div className="ending-track"><div style={{width:`${b.share*100}%`,background:risk.color}}/></div><span>{b.count} 个 · {(b.share*100).toFixed(1)}% · {risk.label}</span></div>;})}
    </article>)}</div></section>;
}
function SampleChart({sample,months}:{sample:EndingAnalysisSnapshot['samples'][number];months:number}) {
  const values=Object.values(sample.strategies).flatMap(s=>s.usable), min=Math.min(0,...values), max=Math.max(1,...values);
  const y=(v:number)=>180-(v-min)/(max-min)*150;
  return <figure><svg viewBox="0 0 640 215" role="img" aria-label="代表性模拟样本的两方案逐月资金与失败缺口">
    <text x="5" y="18">{money(max)}</text><text x="5" y="200">{money(min)}</text>
    {Object.entries(sample.strategies).map(([id,s],index)=><polyline key={id} points={s.usable.map((v,i)=>`${100+i/Math.max(1,months-1)*520},${y(v)}`).join(' ')} fill="none" stroke={index===0?'#267DFF':'#FF5D00'} strokeWidth="2" strokeDasharray={index===0?undefined:'6 4'}/>)}
    <text x="100" y="212">第 1 月</text><text x="555" y="212">第 {months} 月</text>
  </svg><figcaption>A 蓝色实线 · B 橘色虚线；失败月绘制缺口，之后不延长曲线。</figcaption></figure>;
}
