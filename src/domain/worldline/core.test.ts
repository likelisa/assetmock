/**
 * core 层单测 —— 故意用**一个假的 driver**，证明 core 与具体业务无关。
 * 真实 v2 的接入在 adapter.test.ts 里验证；卡库在 cards.test.ts 里验证。
 */
import { describe, expect, it } from 'vitest';
import type { StepDriver, StepResult } from './driver';
import {
  assertDisplayHygiene, bandOf, bandRank, builtinParams, claimText, fingerprintOf,
  lineSeed, mulberry32, pickWeighted, runLine, sampleProfile, selectCandidates, simulateWorldlines, worstBand,
} from './index';
import type { Band, EngineKnobs, SimulateDeps, Worldline } from './index';

/* ── 一个假世界：两个策略，一个冲击事件，一个"开销档"梯度 ── */
interface FakeSetup { salary: number; fixed: number; cash: number; shockCost: number }
interface FakeDraw { shock: number }
interface FakeState { month: number; cash: number; dead: boolean }

const fakeDriver: StepDriver<FakeState, FakeDraw, FakeSetup> = {
  strategyIds: ['a', 'b'],
  describe: setup => [
    { id: 'a', label: '宽松', floorMinor: setup.fixed },
    { id: 'b', label: '紧巴', floorMinor: setup.fixed * 3 },
  ],
  init: setup => ({ month: 0, cash: setup.cash, dead: false }),
  alive: state => !state.dead,
  step(state, draw, setup): StepResult<FakeState> {
    const next: FakeState = { ...state, month: state.month + 1 };
    const shock = draw.shock < 20000 ? setup.shockCost : 0;
    next.cash = state.cash + setup.salary - setup.fixed - shock;
    if (next.cash < 0) {
      next.dead = true;
      return {
        state: next,
        month: next.month,
        paths: {
          a: { status: 'failed', settledUsable: null, failure: { month: next.month, shortfall: -next.cash } },
          b: { status: 'failed', settledUsable: null, failure: { month: next.month, shortfall: -(next.cash - setup.fixed) } },
        },
        events: [{ month: next.month, kind: 'shock', title: '冲击' }],
      };
    }
    return {
      state: next,
      month: next.month,
      paths: {
        a: { status: 'running', settledUsable: next.cash },
        b: { status: 'running', settledUsable: next.cash - setup.fixed },
      },
      events: shock ? [{ month: next.month, kind: 'shock', title: '冲击' }] : [],
    };
  },
};

const fakeKnobs: EngineKnobs = {
  ladders: [{
    key: 'living.level',
    label: '开销档',
    defaultOptionId: 'base',
    options: [
      { id: 'base', label: '不加价', weight: 6 },
      { id: 'plus5', label: '+5%', weight: 4 },
    ],
  }],
  status: 'OK',
  missing: [],
};

const fakeDeps: SimulateDeps<FakeState, FakeDraw, FakeSetup> = {
  driver: fakeDriver,
  sampleDraw: rng => ({ shock: Math.floor(rng() * 1000000) }),
  variant: (setup, _params, profile) => ({ ...setup, fixed: profile['living.level'] === 'plus5' ? Math.round(setup.fixed * 1.05) : setup.fixed }),
  knobs: () => fakeKnobs,
};

const fakeSetup: FakeSetup = { salary: 2000000, fixed: 1600000, cash: 3000000, shockCost: 4000000 };
const fakeInput = {
  seed: 42, n: 80, k: 4, months: 60, params: builtinParams(),
  engineVersion: 'fake-1', worldlineRulesVersion: 'wl-fake-1', v2RulesVersion: '0',
};

describe('core 与业务无关（假 driver + 假卡库也能跑）', () => {
  it('确定性：同种子两次结果相同', () => {
    const a = simulateWorldlines({ setup: fakeSetup, input: fakeInput }, fakeDeps);
    const b = simulateWorldlines({ setup: fakeSetup, input: fakeInput }, fakeDeps);
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it('增量稳定：n=30 的前 30 条 == n=90 的前 30 条', () => {
    const small = simulateWorldlines({ setup: fakeSetup, input: { ...fakeInput, n: 30 } }, fakeDeps);
    const large = simulateWorldlines({ setup: fakeSetup, input: { ...fakeInput, n: 90 } }, fakeDeps);
    expect(small.minUsables.a).toEqual(large.minUsables.a.slice(0, 30));
    expect(small.minUsables.b).toEqual(large.minUsables.b.slice(0, 30));
  });

  it('配对：同一 tape 上两策略的差异只来自策略', () => {
    const tape = Array.from({ length: 12 }, (_, index) => ({ shock: 999999 - index }));
    const outcome = runLine({ driver: fakeDriver, setup: fakeSetup, tape });
    expect(outcome.strategies.b.minUsable).toBe(outcome.strategies.a.minUsable - fakeSetup.fixed);
  });
});

describe('强度档抽样', () => {
  it('每条线每个 ladder 恰好抽一档，默认档不写进标签', () => {
    const rng = mulberry32(1);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const { profile, profileLabel, profileLabels } = sampleProfile(rng, fakeKnobs);
      expect(Object.keys(profile)).toEqual(['living.level']);
      expect(['base', 'plus5']).toContain(profile['living.level']);
      seen.add(profile['living.level']);
      if (profile['living.level'] === 'base') { expect(profileLabel).toBe(''); expect(Object.keys(profileLabels)).toHaveLength(0); }
      else expect(profileLabel).toBe('+5%');
    }
    expect(seen.size).toBe(2);
  });
});

describe('失败口径（失败即停记负值）', () => {
  it('失败当月 = -缺口，之后沿用', () => {
    const tape = [{ shock: 100 }, ...Array.from({ length: 11 }, () => ({ shock: 999999 }))];
    const outcome = runLine({ driver: fakeDriver, setup: { ...fakeSetup, cash: 100 }, tape });
    const line = outcome.strategies.a;
    expect(line.status).toBe('failed');
    expect(line.usable[0]).toBe(-line.firstShortfall!.amountMinor);
    expect(new Set(line.usable).size).toBe(1);
  });
});

describe('统一基准', () => {
  it('卡片标签来自排名档位；分档计数之和 = n', () => {
    const result = simulateWorldlines({ setup: fakeSetup, input: { ...fakeInput, n: 120 } }, fakeDeps);
    const floors = Object.fromEntries(result.strategies.map(spec => [spec.id, spec.floorMinor]));
    for (const candidate of result.candidates) {
      const bands: Band[] = Object.values(candidate.byStrategy).map(strategy => strategy.band);
      expect(candidate.band).toBe(worstBand(bands));
      expect(candidate.byStrategy.a.band).toBe(bandOf(candidate.byStrategy.a.minBalanceMinor, floors.a));
      expect(candidate.label).toBe({ worst: '劣', secondWorst: '次劣', middle: '中', secondBest: '次优', best: '优' }[candidate.tier]);
    }
    expect(result.bands.bad + result.bands.tight + result.bands.ok).toBe(120);
  });

  it('卡片最多 6 张，且优先留下 劣 / 次劣 / 次优', () => {
    const lines: Worldline[] = Array.from({ length: 100 }, (_, index) => {
      const tape = Array.from({ length: 12 }, (_, month) => ({ shock: index * 5000 + month }));
      const outcome = runLine({ driver: fakeDriver, setup: fakeSetup, tape });
      const worstUsable = Math.min(outcome.strategies.a.minUsable, outcome.strategies.b.minUsable);
      return {
        id: `W-${index}`, index, profile: { 'living.level': 'base' }, profileLabel: '', profileLabels: {},
        events: outcome.events, strategies: outcome.strategies, worstUsable,
        worstBand: worstBand([outcome.strategies.a.band, outcome.strategies.b.band]),
        signature: `s${index}`,
      };
    });
    const three = selectCandidates(lines, { k: 3 });
    expect(three.candidates).toHaveLength(3);
    expect(three.candidates.map(candidate => candidate.tier).sort()).toEqual(['secondBest', 'secondWorst', 'worst']);

    const six = selectCandidates(lines, { k: 6 });
    expect(six.candidates.length).toBeLessThanOrEqual(6);
    expect(six.candidates.length).toBeGreaterThanOrEqual(5);
    expect(new Set(six.candidates.map(candidate => candidate.id)).size).toBe(six.candidates.length);

    // k 越小越先丢"好档"：k=4 不该出现"优"，k=2 只剩 劣/次劣
    const tiers = (k: number) => selectCandidates(lines, { k }).candidates.map(candidate => candidate.tier);
    expect(tiers(4)).not.toContain('best');
    expect(tiers(2).sort()).toEqual(['secondWorst', 'worst']);
  });

  it('张数超过档数时拆样本最多的一档，仍不超过 6', () => {
    const lines: Worldline[] = Array.from({ length: 30 }, (_, index) => {
      const tape = Array.from({ length: 12 }, (_, month) => ({ shock: index * 20000 + month }));
      const outcome = runLine({ driver: fakeDriver, setup: fakeSetup, tape });
      const worstUsable = Math.min(outcome.strategies.a.minUsable, outcome.strategies.b.minUsable);
      return {
        id: `W-${index}`, index, profile: { 'living.level': 'base' }, profileLabel: '', profileLabels: {},
        events: outcome.events, strategies: outcome.strategies, worstUsable,
        worstBand: worstBand([outcome.strategies.a.band, outcome.strategies.b.band]),
        signature: `s${index}`,
      };
    });
    for (const k of [1, 2, 3, 4, 5, 6]) {
      const selected = selectCandidates(lines, { k });
      expect(selected.candidates.length).toBeLessThanOrEqual(6);
      expect(selected.candidates.length).toBeLessThanOrEqual(k);
      expect(new Set(selected.candidates.map(candidate => candidate.id)).size).toBe(selected.candidates.length);
    }
  });

  it('文案口径：claim 不含禁用词', () => {
    const result = simulateWorldlines({ setup: fakeSetup, input: fakeInput }, fakeDeps);
    expect(() => assertDisplayHygiene(result)).not.toThrow();
    expect(result.claim).toContain('条模拟里');
    expect(claimText({ n: 10, bands: { bad: 1, tight: 2, ok: 7 }, shortfallCount: 1, failedAnyCount: 2 })).toContain('在 10 条模拟里');
  });
});

describe('随机源', () => {
  it('mulberry32 可复现，lineSeed 只依赖 (seed,i)', () => {
    const a = mulberry32(lineSeed(9, 3));
    const b = mulberry32(lineSeed(9, 3));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(lineSeed(9, 0)).toBe(9);
    expect(lineSeed(9, 1)).toBe((9 + 7919) >>> 0);
  });

  it('pickWeighted 只返回候选项、权重非法即报错', () => {
    const options = [{ weight: 1, value: 'x' }, { weight: 3, value: 'y' }];
    const rng = mulberry32(1);
    for (let i = 0; i < 50; i++) expect(['x', 'y']).toContain(pickWeighted(rng, options).value);
    expect(() => pickWeighted(rng, [{ weight: 0, value: 'z' }])).toThrow();
  });
});

describe('分档函数本身', () => {
  it('bandRank 单调、bandOf 三段正确', () => {
    expect(bandRank.bad).toBeLessThan(bandRank.tight);
    expect(bandRank.tight).toBeLessThan(bandRank.ok);
    expect(bandOf(-1, 100)).toBe('bad');
    expect(bandOf(0, 100)).toBe('tight');
    expect(bandOf(99, 100)).toBe('tight');
    expect(bandOf(100, 100)).toBe('ok');
  });
});
