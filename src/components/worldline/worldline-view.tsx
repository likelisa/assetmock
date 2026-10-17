'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RenderModel } from '@/domain/worldline/render-model';
import { CandidateCards } from './cards';
import { StrategyPanel } from './chart';
import { bandColor, buildYDomain, wan, yuan } from './geometry';
import './worldline.css';

const minorKeys = ['cash', 'fund', 'salary', 'living', 'rent', 'debt', 'debtPayment', 'bonus'] as const;
type MinorKey = (typeof minorKeys)[number];

const labels: Record<MinorKey | 'age', string> = {
  age: '年龄',
  cash: '可动用现金',
  fund: '投资账户',
  salary: '月收入',
  living: '月生活费（含租金）',
  rent: '生活费中的租金',
  debt: '既有负债',
  debtPayment: '每月还本金',
  bonus: '年度奖金',
};

type OpeningDraft = {
  target: 'car' | 'home';
  goal: string | null;
  price: string;
  asOf: string;
  sourceSignature: string;
  values: Record<MinorKey | 'age', string | null>;
  assets: Array<{ id: string; name: string; balance: string; included: string; bucket: 'cash' | 'fund' | 'excluded'; reason: string }>;
  notes: string[];
  missing: string[];
  notice: string;
};

type Settings = {
  n: number;
  months: number;
  seed: number;
  k: number;
  responsePolicy: 'WAIT' | 'LOWER' | 'TEMPORARY';
};

const policyLabels: Record<Settings['responsePolicy'], string> = {
  WAIT: '继续找原薪工作（停薪 6 个月）',
  LOWER: '接受降薪（停薪 3 个月，之后 80%）',
  TEMPORARY: '临时工作过渡（停薪 3 个月，再 3 个月 40%）',
};

/** "1,200,000.5" → "120000050"（分）；脏字符直接忽略 */
function toMinor(text: string): string {
  const clean = text.replace(/[^0-9.]/g, '');
  const [whole = '0', fraction = ''] = clean.split('.');
  const cents = `${fraction}00`.slice(0, 2);
  return (BigInt(whole || '0') * 100n + BigInt(cents || '0')).toString();
}

function toYuan(minor: string | null): string {
  return minor === null ? '' : (Number(minor) / 100).toFixed(2);
}

export function WorldlineView({ workspaceId, goalId }: { workspaceId?: string; goalId?: string | null }) {
  const [draft, setDraft] = useState<OpeningDraft>();
  const [values, setValues] = useState<Record<MinorKey | 'age', string>>({} as Record<MinorKey | 'age', string>);
  const [target, setTarget] = useState<'car' | 'home'>('car');
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [settings, setSettings] = useState<Settings>({ n: 400, months: 60, seed: 42, k: 6, responsePolicy: 'WAIT' });
  const [model, setModel] = useState<RenderModel>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(1);
  const [blind, setBlind] = useState(false);
  const [reload, setReload] = useState(0);

  const request = useCallback(async <T,>(path: string, data?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`/api/worldlines/${path}`, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}) },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
    } catch {
      throw new Error('连不上本地服务：请确认 npm run dev 正在运行，然后点下面的「重新连接」。');
    }
    const payload = await response.json().catch(() => ({ error: `服务返回了非 JSON 响应（HTTP ${response.status}）` }));
    if (!response.ok) throw new Error(payload.error ?? '请求失败');
    return payload as T;
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    void request<OpeningDraft>(`opening${goalId ? `?goalId=${encodeURIComponent(goalId)}` : ''}`)
      .then(next => {
        if (!active) return;
        const months = next.target === 'home' ? 360 : 60;
        setDraft(next);
        setTarget(next.target);
        setSettings(prev => ({ ...prev, months, n: months > 120 ? 200 : 400 }));
        setValues(Object.fromEntries((['age', ...minorKeys] as const).map(key => [
          key,
          key === 'age' ? (next.values.age ?? '') : toYuan(next.values[key]),
        ])) as Record<MinorKey | 'age', string>);
      })
      .catch(nextError => { if (active) setError(nextError instanceof Error ? nextError.message : '无法读取底账'); });
    return () => { active = false; };
  }, [goalId, reload, request, workspaceId]);

  const missing = useMemo(() => (['age', ...minorKeys] as const).filter(key => !values[key]?.trim()), [values]);
  const ready = !!draft && confirmed && !missing.length && !busy;

  /** 发请求之前先把明显不合法的挡掉，别让用户看到服务器的原始报错 */
  function precheck(): string | null {
    const ageValue = Number(values.age);
    if (!Number.isInteger(ageValue) || ageValue < 18 || ageValue > 90) return `年龄需在 18–90 之间（现在填的是 ${values.age || '空'}）`;
    if (toMinor(values.rent) > toMinor(values.living)) return '生活费中的租金不能超过月生活费';
    if (toMinor(values.living) === '0') return '月生活费不能是 0，否则算不出紧巴门槛';
    if (toMinor(values.salary) === '0' && toMinor(values.fund) === '0' && toMinor(values.cash) === '0') return '现金、投资、月收入不能同时为 0';
    if (settings.n < 20) return '世界线条数至少 20 条';
    if (settings.months < 1) return '推演月数至少 1 个月';
    return null;
  }

  async function run() {
    if (!draft || !workspaceId) return;
    const blocked = precheck();
    if (blocked) { setError(blocked); return; }
    setBusy(true);
    setError('');
    try {
      const next = await request<RenderModel>('runs', {
        goalId: draft.goal,
        target,
        sourceSignature: draft.sourceSignature,
        values: {
          age: Number(values.age),
          ...Object.fromEntries(minorKeys.map(key => [key, toMinor(values[key])])),
        },
        n: settings.n,
        months: settings.months,
        seed: settings.seed,
        k: settings.k,
        responsePolicy: settings.responsePolicy,
        careerPolicy: 'DECLINE',
      });
      setModel(next);
      setCursor(1);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '推演失败');
    } finally {
      setBusy(false);
    }
  }

  if (!workspaceId) return <p className="wl-empty">世界线对比需要先进入一个工作区。</p>;
  if (!draft) return <div className="wl-empty">
    <p className={error ? 'wl-error' : 'wl-empty'} role={error ? 'alert' : undefined}>{error || '正在读取当前底账…'}</p>
    {error && <button type="button" className="button-secondary" onClick={() => { setError(''); setReload(value => value + 1); }}>重新连接</button>}
  </div>;

  const domain = model ? buildYDomain(model) : { min: 0, max: 1 };
  const brief = ['cash', 'fund', 'salary', 'living'] as const;

  return <div className="worldline-app">
    <section className="wl-notice">
      <strong>这些是假设，不是预测。</strong>
      <span>同一个决定跑很多遍，挑几条有代表性的摆出来比较；不改你的底账、目标和已选方案。</span>
    </section>

    {error && <p className="wl-error" role="alert">{error}</p>}

    {!model && <section className="wl-panel-card">
      <header>
        <p className="wl-kicker">第一步 · 确认输入并开跑</p>
        <h2>用这份底账，跑几百段假设的人生</h2>
        <p>数字来自你的底账与已确认预算；想改就点「修改假设」，改动只作为本局假设。</p>
      </header>

      <label className="wl-field wl-field-wide">本局目标
        <select value={target} onChange={event => {
          const next = event.target.value as 'car' | 'home';
          const months = next === 'home' ? 360 : 60;
          setTarget(next);
          setSettings(prev => ({ ...prev, months, n: months > 120 ? 200 : 400 }));
          setConfirmed(false);
        }}>
          <option value="car">买车 · 5 年</option>
          <option value="home">买房 · 30 年</option>
        </select>
      </label>

      <ul className="wl-summary">
        {brief.map(key => <li key={key}>
          <span>{labels[key]}</span>
          <b>{values[key]?.trim() ? `${yuan(Number(toMinor(values[key])))} 元` : '待补'}</b>
        </li>)}
      </ul>

      <div className="wl-inline">
        <button type="button" className="button-secondary" onClick={() => setEditing(value => !value)}>
          {editing ? '收起输入' : '修改假设'}
        </button>
        <label className="wl-switch"><input type="checkbox" checked={blind} onChange={event => setBlind(event.target.checked)} />卡片盲选</label>
      </div>

      {editing && <div className="wl-grid">
        <label className="wl-field">年龄
          <input inputMode="numeric" value={values.age ?? ''} onChange={event => { setValues({ ...values, age: event.target.value }); setConfirmed(false); }} />
        </label>
        {minorKeys.map(key => <label key={key} className="wl-field">{labels[key]}（元）
          <input inputMode="decimal" value={values[key] ?? ''} onChange={event => { setValues({ ...values, [key]: event.target.value }); setConfirmed(false); }} />
        </label>)}
      </div>}

      <details className="wl-details">
        <summary>更多设置（条数 / 种子 / 应对方式）</summary>
        <div className="wl-grid">
          <label className="wl-field">世界线条数
            <input inputMode="numeric" value={settings.n} onChange={event => setSettings({ ...settings, n: Number(event.target.value.replace(/\D/g, '')) || 20 })} />
          </label>
          <label className="wl-field">卡片张数
            <select value={settings.k} onChange={event => setSettings({ ...settings, k: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5, 6].map(value => <option key={value} value={value}>{value} 张</option>)}
            </select>
          </label>
          <label className="wl-field">推演月数
            <input inputMode="numeric" value={settings.months} onChange={event => setSettings({ ...settings, months: Number(event.target.value.replace(/\D/g, '')) || 1 })} />
          </label>
          <label className="wl-field">随机种子
            <input inputMode="numeric" value={settings.seed} onChange={event => setSettings({ ...settings, seed: Number(event.target.value.replace(/\D/g, '')) || 0 })} />
          </label>
        </div>
        <label className="wl-field wl-field-wide">收入中断后怎么办（全条一致，才可比）
          <select value={settings.responsePolicy} onChange={event => setSettings({ ...settings, responsePolicy: event.target.value as Settings['responsePolicy'] })}>
            {Object.entries(policyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <ul className="wl-notes">{draft.notes.map(note => <li key={note}>{note}</li>)}</ul>
      </details>

      <details className="wl-details">
        <summary>资产来源与排除原因（{draft.assets.length}）</summary>
        <table>
          <thead><tr><th>资产</th><th>底账（元）</th><th>纳入（元）</th><th>说明</th></tr></thead>
          <tbody>{draft.assets.map(asset => <tr key={asset.id}>
            <td>{asset.name}</td>
            <td>{yuan(Number(asset.balance))}</td>
            <td>{yuan(Number(asset.included))}</td>
            <td>{asset.reason}</td>
          </tr>)}</tbody>
        </table>
      </details>

      <label className="wl-confirm">
        <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
        我已核对；以上数字只作为本局假设，不解除真实底账的资金限制。
      </label>

      <footer className="wl-actions">
        <button type="button" className="button-primary" disabled={!ready} onClick={() => void run()}>
          {busy ? '正在推算…' : missing.length ? `还缺 ${missing.map(key => labels[key]).join('、')}` : '开始推演'}
        </button>
      </footer>
    </section>}

    {model && <section className="wl-panel-card">
      <header>
        <p className="wl-kicker">结果 · {model.meta.n} 条 × {model.meta.months} 月</p>
        <h2>{model.meta.claim}</h2>
      </header>

      <div className="wl-bands" role="img" aria-label={`${model.meta.n} 条世界线的三档分布`}>
        {model.bands.bad > 0 && <span className="wl-band is-bad" style={{ flexGrow: model.bands.bad }}>{model.bands.bad} 条不足</span>}
        {model.bands.tight > 0 && <span className="wl-band is-tight" style={{ flexGrow: model.bands.tight }}>{model.bands.tight} 条紧巴</span>}
        {model.bands.ok > 0 && <span className="wl-band is-ok" style={{ flexGrow: model.bands.ok }}>{model.bands.ok} 条乐观</span>}
      </div>

      <div className="wl-stats">
        {model.strategies.map(strategy => <article key={strategy.id}>
          <h3>{strategy.id.toUpperCase()} · {strategy.label}</h3>
          <dl>
            <div><dt>门槛</dt><dd>{yuan(strategy.floorMinor)} 元</dd></div>
            <div><dt>P5</dt><dd>{yuan(strategy.p5)} 元</dd></div>
            <div><dt>P50</dt><dd>{yuan(strategy.p50)} 元</dd></div>
            <div><dt>P90</dt><dd>{yuan(strategy.p90)} 元</dd></div>
          </dl>
        </article>)}
      </div>

      <div className="wl-cards-head"><h3>抽几张看看（最多 6 张，优先 劣 / 次劣 / 次优）</h3></div>
      <CandidateCards candidates={model.candidates} blind={blind} />

      <div className="wl-charts">
        {model.strategies.map((strategy, index) => <StrategyPanel key={strategy.id} model={model} strategy={strategy} index={index} domain={domain} cursor={cursor} />)}
      </div>
      <label className="wl-cursor">
        第 <b>{cursor}</b> 月
        <input type="range" min={1} max={model.meta.months} value={cursor} onChange={event => setCursor(Number(event.target.value))} />
        <span>{wan(domain.min)} ~ {wan(domain.max)}</span>
      </label>
      <ul className="wl-legend">
        {model.candidates.map(candidate => <li key={candidate.id}><i style={{ background: bandColor[candidate.band] }} />{candidate.id} · {candidate.label}</li>)}
      </ul>

      <details className="wl-details">
        <summary>这些假设从哪来（{model.provenance.length} 条）</summary>
        <ul>{model.provenance.map(entry => <li key={entry.param}>
          <b>{entry.param}</b><span>{entry.label}</span>
          <em>{entry.basis === 'PUBLIC_STATISTIC' ? '公开统计' : entry.basis === 'DERIVED' ? '由公开数据推得' : '压力假设'}</em>
        </li>)}</ul>
      </details>

      <p className="wl-meta">
        种子 {model.meta.seed} · {model.meta.n} 条 × {model.meta.months} 月 · 参数 {model.meta.paramsVersion}
        {model.meta.cardsVersion ? ` · 卡库 ${model.meta.cardsVersion}` : ''}
        {model.meta.cardPlanId ? ` · 卡组 ${model.meta.cardPlanId}` : ''}
      </p>

      <footer className="wl-actions">
        <button type="button" className="button-secondary" onClick={() => { setModel(undefined); setConfirmed(false); }}>改输入</button>
        <button type="button" className="button-primary" disabled={busy} onClick={() => void run()}>{busy ? '正在重算…' : '换一批重算'}</button>
      </footer>
    </section>}
  </div>;
}
