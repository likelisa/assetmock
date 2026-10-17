'use client';
import { useState } from 'react';
import { money } from '@/domain/money';
import { methodLabel } from '@/domain/v2/setup';
import { ids, type Character, type Input, type Plan, type Target } from '@/domain/v2/types';
import type { LoanOffer, LoanResearch } from '@/domain/types';
import { LoanResearchPanel, OfferSource } from '../loan-research';
export interface PlanPreview { input: Input; plans: Record<'a' | 'b', Plan>; errors: string[]; months: number }
export function TargetPicker({ onSelect }: { onSelect: (target: Target | 'custom') => void }) {
  return <section className="v2-intro"><div><p className="chapter">一个决定，几年以后</p><h1>你想要的生活，<br />从哪一步开始？</h1><p className="lead">带着一个愿望，走进两段平行人生。遇到意外时做选择，再看看几年以后，你为生活留下了什么。</p></div><div className="v2-targets">
    <button onClick={() => onSelect('car')}><span className="v2-icon">车</span><h2>买一辆自己的车</h2><p>经历 5 年 · 默认车贷 3 年</p><small>还完贷款以后，故事继续。</small></button>
    <button onClick={() => onSelect('home')}><span className="v2-icon">家</span><h2>拥有一个自己的家</h2><p>经历 30 年 · 默认房贷 30 年</p><small>不同首付，改变以后选择的余地。</small></button>
    <button onClick={() => onSelect('custom')}><span className="v2-icon">愿</span><h2>自定义人生目标</h2><p>教育、创业、裸辞，以及你的其他计划</p><small>说出想法，让 AI 整理两种行动方案，再由你确认。</small></button>
  </div></section>;
}
export function Profiles({ profiles, onSelect }: { profiles: Character[]; onSelect: (profile: Character) => void }) {
  return <section><h1>选择故事的主角</h1><p className="hint">以下均为虚构游戏角色。底账只用于模拟，不代表真实个人。</p><div className="v2-profiles">{profiles.map(p => <article key={p.id}><h2>{p.name}</h2><p>{p.description}</p><strong>初始资金 {money(p.cash + p.fund)} 元</strong><details><summary>展开财富底账</summary><dl className="terms">{[['现金', p.cash], ['投资账户', p.fund], ['月工资', p.salary], ['月生活支出', p.living], ['其中租金', p.rent], ['既有负债', p.debt], ['年奖金', p.bonus]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{money(Number(value))} 元</dd></div>)}</dl></details><button className="primary" onClick={() => onSelect(p)}>选择{p.name}</button></article>)}</div></section>;
}
export function Planning({ input, update, offers, preview, busy, confirmed, setConfirmed, onStart, onPrepare, prepared, onApply, replay }: {
  input: Input; update: (input: Input) => void; offers: LoanOffer[]; preview: PlanPreview | null; busy: boolean; confirmed: boolean; setConfirmed: (v: boolean) => void;
  onStart: () => void; onPrepare: (goal: string) => void; prepared?: { notice: string; source: string; trace: string[]; research?: LoanResearch }; onApply: (id: string, rate: string, fee: number) => Promise<void>; replay: boolean;
}) {
  const [goal, setGoal] = useState(input.target === 'home' ? '我想买100万元的房子，比较30%和50%首付，贷款30年。' : '我想买一辆20万元的车，比较全款和贷款。');
  const home = input.target === 'home';
  function changePlan(index: number, patch: Partial<Input['paths'][0]>) { const next = structuredClone(input); Object.assign(next.paths[index], patch); update(next); }
  return <section><h1>{replay ? '相同经历，改一个决定' : '为愿望选两条路'}</h1><p className="lead">{home ? '三十年里，不同的首付会留下怎样的生活余量？' : '先买到喜欢的车，再经历还贷与还清后的生活。'}</p>
    {!replay && <div className="v2-goal"><label htmlFor="v2-goal">告诉 AI 你的目标</label><textarea id="v2-goal" value={goal} onChange={e => setGoal(e.target.value)} /><button className="secondary" disabled={busy} onClick={() => onPrepare(goal)}>AI 整理目标与资料</button><p className="hint">也可以直接编辑下方表单。搜索结果仅供参考，所有条件需确认。</p></div>}
    {prepared && <div className="notice"><b>{prepared.source === 'model' ? 'AI 整理' : '规则说明'}</b><p>{prepared.notice}</p><details><summary>查看处理过程</summary>{prepared.trace.map((t, i) => <p key={i}>{t}</p>)}</details></div>}
    <label className="v2-price">{home ? '购房' : '购车'}预算（元）<input aria-label="购置预算" type="number" min={home ? 500000 : 50000} max={home ? 5000000 : 300000} step="1000" value={input.price / 100} onChange={e => update({ ...input, price: Math.round(Number(e.target.value) * 100) })} /></label>
    <div className="v2-pair">{ids.map((id, i) => { const p = input.paths[i], calculated = preview?.plans[id]; return <article className={`v2-plan path-${id}`} key={id}><h2>路径 {id.toUpperCase()}</h2><label>付款方式<select aria-label={`路径${id}付款方式`} value={p.method} onChange={e => { const method = e.target.value as Input['paths'][0]['method']; changePlan(i, { method, downPercent: method === 'high' ? 50 : 30 }); }}>{Object.entries(methodLabel).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      {p.method !== 'full' && <><label>首付比例（%）<input type="number" min="20" max="80" value={p.downPercent} onChange={e => changePlan(i, { downPercent: Number(e.target.value) })} /></label><label>贷款期限<select value={p.term} onChange={e => changePlan(i, { term: Number(e.target.value) })}>{(home ? [120, 240, 360] : [12, 24, 36, 60]).map(n => <option value={n} key={n}>{n / 12} 年（{n} 个月）</option>)}</select></label><label>贷款资料<select value={p.offerId} onChange={e => changePlan(i, { offerId: e.target.value })}>{offers.map(o => <option value={o.id} key={o.id}>{o.name}</option>)}</select></label></>}
      {calculated && <><dl className="terms"><div><dt>开局支付</dt><dd>{money(calculated.down + (p.method === 'full' ? 0 : calculated.offer.fee))} 元</dd></div><div><dt>贷款本金</dt><dd>{money(calculated.principal)} 元</dd></div><div><dt>每月还款</dt><dd>{money(calculated.payment)} 元</dd></div>{p.method !== 'full' && <><div><dt>年化名义利率</dt><dd>{(Number(calculated.offer.annualRate) * 100).toFixed(2)}%</dd></div><div><dt>一次性费用</dt><dd>{money(calculated.offer.fee)} 元</dd></div></>}</dl>{p.method !== 'full' && <><OfferSource offer={calculated.offer} /><p className="hint">等额本息；所填首付、期限为本次游戏假设，月供从第1月开始。</p></>}</>}
    </article>; })}</div>
    <div className="v2-rules"><b>{home ? '30 年 / 360 个月' : '5 年 / 60 个月'}的生活假设</b><p>{home ? '购房后移除角色原租金，每月新增持有支出1,000元。不模拟税费、装修、提前还贷与房产买卖。示例贷款费用为零不表示现实费用为零。' : '每月新增用车支出1,500元。车款和用车预算包含本版简化的购置和使用成本。'} 物价固定，投资正常收益为零，工资仅因明确事件改变。房屋和车辆不计入剩余资金。</p><details><summary>查看随机事件规则</summary><p>有资格月份独立抽取：医疗0.1%（5万元，治疗3个月，冷却12个月）；失业0.2%（至少停薪3个月，重新就业后冷却12个月）；投资下跌0.5%（跌20%）；职业机会0.5%（冷却24个月）。每年奖金节点20%概率延期3个月。全部为游戏参数，不是现实概率。</p></details></div>
    {preview?.errors.map(e => <p role="alert" className="error" key={e}>{e}</p>)}
    <label className="check"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我已核对两条方案，理解以上均为游戏假设，并确认开始。</label>
    <button className="primary" disabled={busy || !confirmed || !preview || preview.errors.length > 0} onClick={onStart}>{replay ? '确认修改，沿用相同经历' : '确认方案，开始人生'}</button>
    {prepared?.research && <LoanResearchPanel target={input.target} research={prepared.research} input={{ downPaymentPercent: input.paths[1].downPercent, termMonths: input.paths[1].term }} disabled={busy} onApply={onApply} />}
  </section>;
}
