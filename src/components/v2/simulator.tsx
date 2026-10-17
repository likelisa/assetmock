'use client';
import { CustomPlanning } from './custom-planning';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { choiceLabels } from '@/domain/v2/engine';
import { defaultInput } from '@/domain/v2/setup';
import type { Character, ChoiceRecord, Input, PublicRun, Selection, Target } from '@/domain/v2/types';
import type { Explanation, LoanOffer, LoanResearch } from '@/domain/types';
import type { Suggestion } from '@/server/v2/ai';
import { Planning, Profiles, TargetPicker, type PlanPreview } from './planning';
import { EndingAnalysis } from '../worldline/ending-analysis';
import { Game } from './game';
type Catalog = { profiles: Character[]; offers: Record<Target, LoanOffer[]>; searchEnabled: boolean };
type Prepared = { input: Input; source: string; trace: string[]; supported: boolean; notice: string; research?: LoanResearch };
type Recommendation = { source: string; selected?: Suggestion; options: Suggestion[]; notice: string };
export function LifeSimulator({ workspaceId, opening, initialRunId, onExit, autoResume = true }: { autoResume?: boolean; workspaceId?: string; opening?: { id: string; profile: Character; price?: number }; initialRunId?: string; onExit?: () => void } = {}) {
  const storageKey = workspaceId ? `life-integrated:${workspaceId}` : 'life-run-v2';
  const api = useCallback(async function api<T>(path: string, data?: unknown): Promise<T> {
    const payload = data === undefined ? undefined : { ...(data as object), ...(opening ? { openingId: opening.id } : {}) };
    const response = await fetch(`${workspaceId ? '/api/simulations' : '/api/v2'}/${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(100000) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '请求失败'); return result;
  }, [workspaceId, opening]);

  const [catalog, setCatalog] = useState<Catalog>(); const [screen, setScreen] = useState<'target' | 'profiles' | 'plan' | 'game'>(opening ? 'plan' : 'target');
  const [input, setInput] = useState<Input>(() => opening ? { ...defaultInput(opening.profile.target), profileId: opening.profile.id, ...(opening.price ? {price:opening.price} : {}) } : defaultInput('car')); const [run, setRun] = useState<PublicRun>();
  const [preview, setPreview] = useState<PlanPreview | null>(null); const [confirmed, setConfirmed] = useState(false); const [prepared, setPrepared] = useState<Prepared>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [legacy, setLegacy] = useState(false);
  const [explanation, setExplanation] = useState<Explanation>(); const [explaining, setExplaining] = useState(false);
  const [recommendation, setRecommendation] = useState<Recommendation>(); const [recommending, setRecommending] = useState(false);
  const [parent, setParent] = useState<{ id: string; override?: ChoiceRecord }>();
  const current = useRef(''); const retry = useRef<{ fingerprint: string; key: string } | null>(null);
  function accept(next: PublicRun) { setRun(next); setScreen('game'); localStorage.setItem(storageKey, next.id); current.current = `${next.id}:${next.version}`; setExplanation(undefined); setRecommendation(undefined); }
  useEffect(() => {
    let active = true;
    void (async () => { try {
      const data = await api<Catalog>('catalog'); if (!active) return; setCatalog(data); setLegacy(!!localStorage.getItem('life-run'));
      const saved = initialRunId || (!opening && autoResume ? localStorage.getItem(storageKey) : null); if (saved) { const next = await api<PublicRun>(`runs/${saved}`); if (active) accept(next); }
    } catch (e) { if (active) setError(e instanceof Error ? e.message : '无法载入'); } })();
    return () => { active = false; };
  }, [api, initialRunId, opening, storageKey, autoResume]);
  useEffect(() => {
    if (screen !== 'plan') return;
    let active = true;
    const timer = setTimeout(() => { void api<PlanPreview>('plans/calculate', input).then(next => { if (active) { setPreview(next); setError(''); } }).catch(e => { if (active) { setPreview(null); setError(e.message); } }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [input, screen, api]);
  function update(next: Input) { setInput(next); setConfirmed(false); setPreview(null); }
  async function work(label: string, fn: () => Promise<void>) { setBusy(label); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : '操作失败，请重试'); } finally { setBusy(''); } }
  function chooseTarget(target: Target | 'custom') { const next=defaultInput(target==='custom'?'car':target); if(target==='custom'){next.price=0;next.custom={goal:'',months:12,assumptions:['待填写：两种行动的收入、支出及持续时间。'],actions:[{name:'行动方案 A',upfront:0,phases:[{months:12,income:0,extraExpense:0}]},{name:'行动方案 B',upfront:0,phases:[{months:12,income:0,extraExpense:0}]}]};} update(next); setParent(undefined); setPrepared(undefined); setScreen('profiles'); }
  function chooseProfile(p: Character) { update(input.custom ? {...input,profileId:p.id,custom:{...input.custom,actions:input.custom.actions.map(a=>({...a,phases:a.phases.map(p2=>({...p2,income:p.salary}))})) as NonNullable<Input['custom']>['actions']}} : { ...defaultInput(p.target), profileId: p.id }); setScreen('plan'); }
  function start() { void work('正在保存方案并创建相同经历…', async () => { const next = await api<PublicRun>(parent ? `runs/${parent.id}/replay` : 'runs', { input, confirmed: true, ...(parent ? { sameExperience: true, override: parent.override } : {}) }); accept(next); setParent(undefined); }); }
  function prepareCustom(goal:string){void work('AI 正在整理两种行动方案…',async()=>{const next=await api<{source:string;notice:string;custom?:Input['custom']}>('plans/custom',{goal,profileId:input.profileId});setNotice(next.notice);if(next.custom)update({...input,custom:next.custom});});}
  function prepare(goal: string) { void work('正在核对目标、读取资料和计算方案，通常需要几十秒…', async () => { const next = await api<Prepared>('plans/prepare', { target: input.target, profileId: input.profileId, goal }); setPrepared(next); if (next.supported) update(next.input); }); }
  async function apply(sourceId: string, rate: string, fee: number) { await work('正在保存已确认的模拟条件…', async () => { const offer = await api<LoanOffer>('plans/from-search', { target: input.target, sourceId, annualRatePercent: rate, feeYuan: fee, acknowledged: true }); setCatalog(c => c ? { ...c, offers: { ...c.offers, [input.target]: [...c.offers[input.target], offer] } } : c); const next = structuredClone(input); next.paths.forEach(p => { if (p.method !== 'full') p.offerId = offer.id; }); update(next); }); }
  function mutate(action: 'advance' | 'choose', selections?: Selection[]) { if (!run) return; const data = { expectedVersion: run.version, ...(selections ? { selections } : {}) }; const fingerprint = JSON.stringify({ id: run.id, action, data }); if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, key: crypto.randomUUID() }; const requestKey = retry.current.key;
    void work('正在结算，遇到关键事件会停下来…', async () => { const next = await api<PublicRun>(`runs/${run.id}/${action}`, { ...data, requestKey }); accept(next); retry.current = null; });
  }
  async function explain() { if (!run) return; const expected = current.current; setExplaining(true); try { const result = await api<Explanation>(`runs/${run.id}/explanation`, {}); if (expected === current.current) setExplanation(result); } catch { if (expected === current.current) setExplanation({ source: 'rules', facts: run.facts, paragraphs: [], notice: 'AI 暂不可用，以上账目与规则说明仍可查看。' }); } finally { setExplaining(false); } }
  async function recommend() { if (!run) return; const expected = current.current; setRecommending(true); try { const result = await api<Recommendation>(`runs/${run.id}/recommendation`, {}); if (expected === current.current) setRecommendation(result); } catch (e) { setError(e instanceof Error ? e.message : '建议暂不可用'); } finally { setRecommending(false); } }
  function replay(suggestion?: Suggestion) { if (!run) return; setParent({ id: run.id, override: suggestion?.override }); update(suggestion?.input ?? run.input); setPrepared(undefined); setScreen('plan'); }
  function newGame() { localStorage.removeItem(storageKey); if(opening && onExit){onExit();return;} setRun(undefined); setParent(undefined); setScreen('target'); current.current = ''; setPrepared(undefined); setError(''); }
  return <main className="shell v2-shell"><header className="topbar"><Link className="brand" href="/"><span className="brand-mark">流</span>人生模拟器</Link><div className="v2-nav"><span>{workspaceId ? '未来可能性推演 · 平行人生' : 'v0.2 · 平行人生'}</span>{onExit && <button className="text-button" onClick={onExit}>返回底账与报告</button>}<Link href="/legacy">{legacy ? '继续旧版游戏' : '旧版入口'}</Link>{screen !== 'target' && <button className="text-button" disabled={!!busy} onClick={newGame}>新故事</button>}</div></header>
    <nav className="steps" aria-label="游戏阶段">{['目标', '角色', '方案', '人生'].map((label, i) => <span className={`step ${['target', 'profiles', 'plan', 'game'][i] === screen ? 'current' : ''}`} key={label}><i>{i + 1}</i>{label}</span>)}</nav>
    {notice && !(screen === 'plan' && input.custom) && <p className="v2-rules">{notice}</p>}
    {error && <div role="alert" className="error">{error}{run && <button onClick={() => void work('同步进度…', async () => accept(await api<PublicRun>(`runs/${run.id}`)))}>同步游戏进度</button>}</div>}
    {workspaceId && run && <section className="v2-rules"><p>{run.source?.kind === 'ledger' ? '本局使用你确认的简化数据，不完整模拟真实底账中的资金限制、产品条款及未来变化。' : '虚构角色体验，不修改当前财务底账。'}</p><details><summary>本局输入与简化假设</summary><p>起始现金 {(run.profile.cash/100).toFixed(2)} 元；投资 {(run.profile.fund/100).toFixed(2)} 元；月收入 {(run.profile.salary/100).toFixed(2)} 元；月生活费 {(run.profile.living/100).toFixed(2)} 元。结算从 {run.rules.startMonth} 开始。</p><ul>{run.source?.notes.map(n=><li key={n}>{n}</li>)}</ul></details><button className="secondary" disabled={!!busy} onClick={() => void work('正在保存报告…', async () => { await api(`runs/${run.id}/report`, {}); setNotice('报告已保存，可返回底账与报告查看。'); })}>保存推演报告</button></section>}
    {busy && <div role="status" className="busy"><span className="spinner" />{busy}</div>}
    {screen === 'plan' && parent && run && <section className="v2-rules"><label>修改一次历史选择（可选）<select aria-label="修改历史选择" value={parent.override ? `${parent.override.month}:${parent.override.path}:${parent.override.choice}` : ''} onChange={e => { const [month, path, choice] = e.target.value.split(':'); const prior = run.history.flatMap(m => m.choices).find(c => c.month === Number(month) && c.path === path); setParent({ id: parent.id, override: prior ? { ...prior, choice: choice as ChoiceRecord['choice'] } : undefined }); setConfirmed(false); }}><option value="">沿用有效的历史选择</option>{run.history.flatMap(m => m.choices).flatMap(c => (c.kind === 'jobLoss' ? ['lower', 'wait', 'temporary'] as const : ['accept', 'decline'] as const).filter(choice => choice !== c.choice).map(choice => <option key={`${c.month}:${c.path}:${choice}`} value={`${c.month}:${c.path}:${choice}`}>第{c.month}月 {c.path.toUpperCase()}路径：改为{choiceLabels[choice]}</option>))}</select></label><p className="hint">其他有效选择自动沿用；资格变化导致历史选择不适用时，游戏会明确提示。</p></section>}
    {!catalog ? <p>正在载入角色与资料…</p> : screen === 'target' ? <TargetPicker onSelect={chooseTarget} /> : screen === 'profiles' ? <Profiles profiles={catalog.profiles.filter(p => p.target === input.target)} onSelect={chooseProfile} /> : screen === 'plan' && input.custom ? <CustomPlanning input={input} update={update} onPrepare={prepareCustom} onStart={start} preview={preview} busy={!!busy} confirmed={confirmed} setConfirmed={setConfirmed} notice={notice}/> : screen === 'plan' ? <Planning key={parent?.id ?? input.profileId} input={input} update={update} offers={catalog.offers[input.target]} preview={preview} busy={!!busy} confirmed={confirmed} setConfirmed={setConfirmed} onStart={start} onPrepare={prepare} prepared={prepared} onApply={apply} replay={!!parent} /> : run && <Game endingAnalysis={workspaceId && run.status === 'ended' && !run.input.custom ? <EndingAnalysis key={`${run.id}:${run.version}`} workspaceId={workspaceId} runId={run.id} version={run.version}/> : undefined} run={run} busy={!!busy} onAdvance={() => mutate('advance')} onChoose={s => mutate('choose', s)} explanation={explanation} explaining={explaining} onExplain={() => void explain()} recommendation={recommendation} recommending={recommending} onRecommend={() => void recommend()} onReplay={replay} onNew={newGame} />}
    <footer><span>游戏假设与事件参数 · 不代表真实报价或人生预测</span><span>现金与投资留下余量，选择留下故事。</span></footer></main>;
}
