import { describe, expect, it } from 'vitest';
import * as serverRenderer from 'react-dom/server';
import { CandidateCards } from './cards';
import { StrategyPanel } from './chart';
import { buildMarginalBins, buildYDomain, wan } from './geometry';
import type { RenderModel } from '@/domain/worldline/render-model';

const render = serverRenderer.renderToStaticMarkup ?? serverRenderer.renderToString;

const model: RenderModel = {
  meta: {
    seed: 42, n: 4, months: 12, engineVersion: 'wl-test', worldlineRulesVersion: 'wl-rules.test',
    v2RulesVersion: '0.2.0', paramsVersion: 'params.v1', cardsVersion: 'cards.v1',
    cardPlanId: 'plan.default', dataStatus: 'OK', claim: '在 4 条模拟里，1 条出现资金不足',
  },
  strategies: [
    { id: 'a', label: '全款', floorMinor: 3000000, p5: -100000, p50: 8000000, p90: 9000000, bandCounts: { bad: 1, tight: 0, ok: 3 } },
    { id: 'b', label: '低首付', floorMinor: 4500000, p5: 2000000, p50: 9000000, p90: 9500000, bandCounts: { bad: 1, tight: 1, ok: 2 } },
  ],
  bands: { bad: 1, tight: 0, ok: 3 },
  quantilesByMonth: {
    a: Array.from({ length: 12 }, (_, i) => ({ p5: -100000 + i * 1000, p50: 8000000 + i * 1000, p90: 9000000 + i * 1000 })),
    b: Array.from({ length: 12 }, (_, i) => ({ p5: 2000000 + i * 1000, p50: 9000000 + i * 1000, p90: 9500000 + i * 1000 })),
  },
  minUsables: { a: [-100000, 8000000, 8500000, 9000000], b: [2000000, 3000000, 9000000, 9500000] },
  candidates: [
    {
      id: 'W-000', band: 'bad', tier: 'worst', label: '劣', premise: '第 3 月失业；一次大病自付（高档）', profileLabel: '一次大病自付（高档）',
      byStrategy: {
        a: { label: '全款', minBalanceMinor: -100000, band: 'bad', verdict: '承受不了', firstShortfall: { month: 3, amountMinor: 100000 } },
        b: { label: '低首付', minBalanceMinor: 2000000, band: 'tight', verdict: '需要调整', firstShortfall: null },
      },
      cause: { shock: 'jobLoss', trigger: 'tier' },
      series: { a: Array.from({ length: 12 }, (_, i) => 3000000 - i * 400000), b: Array.from({ length: 12 }, (_, i) => 4000000 - i * 300000) },
    },
    {
      id: 'W-001', band: 'ok', tier: 'best', label: '优', premise: '没有发生冲击事件', profileLabel: '',
      byStrategy: {
        a: { label: '全款', minBalanceMinor: 8000000, band: 'ok', verdict: '能承受', firstShortfall: null },
        b: { label: '低首付', minBalanceMinor: 9000000, band: 'ok', verdict: '能承受', firstShortfall: null },
      },
      cause: { shock: null, trigger: null },
      series: { a: Array.from({ length: 12 }, () => 8500000), b: Array.from({ length: 12 }, () => 9200000) },
    },
  ],
  provenance: [{ param: 'jobLoss.monthlyRate', label: '我们假定每月约有 3% 的机会收入中断', basis: 'PRESS_HYPOTHESIS' }],
};

describe('世界线对比渲染层', () => {
  it('纵轴共用：两个策略取同一套范围', () => {
    const domain = buildYDomain(model);
    expect(domain.min).toBeLessThan(-100000);
    expect(domain.max).toBeGreaterThan(9500000);
  });

  it('边际分布按纵轴分箱，密度归一', () => {
    const domain = buildYDomain(model);
    const bins = buildMarginalBins(model.minUsables.a, domain, 10);
    expect(bins).toHaveLength(10);
    expect(Math.max(...bins.map(bin => bin.density))).toBeCloseTo(1, 5);
  });

  it('万元刻度可读', () => {
    expect(wan(0)).toBe('0.00万');
    expect(wan(100000000)).toBe('100万');
    expect(wan(1000000)).toBe('1.00万');
  });

  it('折线面板渲染出分位带、代表线与游标', () => {
    const html = render(<StrategyPanel model={model} strategy={model.strategies[0]} index={0} domain={buildYDomain(model)} cursor={3} />);
    expect(html).toContain('<svg');
    expect(html).toContain('第3月');
    expect(html).toContain('A · 全款');
    expect(html).toContain('最低值分布');
  });

  it('卡片正面给出档位、前提与两策略判定', () => {
    const html = render(<CandidateCards candidates={model.candidates} blind={false} />);
    expect(html).toContain('W-000');
    expect(html).toContain('劣');
    expect(html).toContain('最差一档');
    expect(html).toContain('承受不了');
    expect(html).toContain('点击翻开');
    expect(html).toContain('第 3 月失业');
  });

  it('盲选时背面不泄露档位', () => {
    const html = render(<CandidateCards candidates={model.candidates} blind />);
    expect(html).toContain('待翻开');
    expect(html).not.toContain('>劣<');
  });
});
