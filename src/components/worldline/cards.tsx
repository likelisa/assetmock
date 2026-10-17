'use client';

import { useState } from 'react';
import type { RenderCandidate } from '@/domain/worldline/render-model';
import { bandColor, yuan } from './geometry';

/** 一条世界线一张牌；点一下翻开。盲选时背面统一中性色，发牌顺序打乱。 */
export function CandidateCards({ candidates, blind }: { candidates: RenderCandidate[]; blind: boolean }) {
  const [flipped, setFlipped] = useState<Record<string, boolean>>({});
  const order = blind ? [...candidates].reverse() : candidates;

  return <div className="wl-cards">
    {order.map(candidate => {
      const open = !!flipped[candidate.id];
      const color = bandColor[candidate.band] ?? '#23669d';
      return <button
        key={candidate.id}
        type="button"
        className={`wl-card${open ? ' is-open' : ''}`}
        style={{ ['--wl-card-color' as string]: blind ? '#23669d' : color }}
        onClick={() => setFlipped(prev => ({ ...prev, [candidate.id]: !prev[candidate.id] }))}
        aria-expanded={open}
      >
        <span className="wl-card-inner">
          <span className="wl-card-back">
            <span className="wl-card-suit">{suitOf(candidate.band)}</span>
            <strong>{blind ? '待翻开' : candidate.label}</strong>
            <small>{candidate.id}</small>
            <em>点击翻开</em>
          </span>
          <span className="wl-card-front" aria-hidden={blind && !open}>
            {blind && !open ? <span className="wl-card-suit">?</span> : <>
            <span className="wl-card-head">
              <b style={{ color }}>{candidate.label}</b>
              <small>{candidate.id}</small>
            </span>
            <span className="wl-card-tier">{tierHint(candidate.tier)}</span>
            <span className="wl-card-suit">{suitOf(candidate.band)}</span>
            <span className="wl-card-premise">{candidate.premise}</span>
            <span className="wl-card-rows">
              {(['a', 'b'] as const).map(id => {
                const row = candidate.byStrategy[id];
                if (!row) return null;
                return <span key={id} className="wl-card-row">
                  <i>{id.toUpperCase()}</i>
                  <span style={{ color: bandColor[row.band] }}>{row.verdict}</span>
                  <em>最低 {yuan(row.minBalanceMinor)} 元</em>
                </span>;
              })}
            </span>
            <span className="wl-card-foot">
              {candidate.cause.shock ? `冲击：${shockLabel(candidate.cause.shock)}` : '无冲击事件'}
              {candidate.cause.trigger === 'tier' ? ' · 档位偏离默认' : ''}
            </span>
            </>}
          </span>
        </span>
      </button>;
    })}
  </div>;
}

const suitOf = (band: string) => (band === 'bad' ? '♥' : band === 'tight' ? '♦' : '♣');
const tierHint = (tier: string) => ({ worst: '最差一档', secondWorst: '次差一档', middle: '中间档', secondBest: '次好一档', best: '最好一档' }[tier] ?? '');
const shockLabel = (kind: string) => ({ medical: '医疗', jobLoss: '收入中断', bonusDelay: '奖金延期', marketDrop: '投资下跌', career: '职业机会' }[kind] ?? kind);
