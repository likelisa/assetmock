/**
 * 适配器测试：真实 v2 引擎 + 真实卡库接入后的行为。
 * 最关键的一条是 **一致性**：批量内核与"交互模式"必须给出同一份月账。
 */
import { describe, expect, it } from 'vitest';
import { advance, choose, funds } from '@/domain/v2/engine';
import type { Draws } from '@/domain/v2/types';
import {
  demoSetup, floorMinorOf, indexOfCards, knobsFromCards, makeRunLike, sampleV2Draw, selectionsForPolicy,
  v2DrawThresholds, v2Driver, v2WorldlineDeps, V2_DEFAULT_DRAWS, variantSetup,
} from './adapter-v2/index';
import { cardLibraryV1, paramPackV1 } from './cards/index';
import { builtinParams, lineSeed, mulberry32, runLine, simulateWorldlines } from '@/domain/worldline';
import type { LineProfile } from '@/domain/worldline';

const policy = { jobLoss: 'WAIT', career: 'DECLINE' } as const;
const months = 60;
const params = paramPackV1();
const cards = cardLibraryV1();
const cardIndex = indexOfCards(cards);

const baseInput = {
  seed: 42, n: 40, k: 4, months, params,
  engineVersion: 'wl-prep', worldlineRulesVersion: 'wl-rules.0.1.0', v2RulesVersion: '0.2.0',
  cardsVersion: cards.version,
};

function tapeFor(seed: number, index: number, count = months): Draws[] {
  const rng = mulberry32(lineSeed(seed, index));
  return Array.from({ length: count }, () => sampleV2Draw(rng));
}

describe('参数落地', () => {
  it('阈值覆盖写进 rules.probabilities（纯数据，不改引擎）', () => {
    const setup = demoSetup();
    const draws = v2DrawThresholds(params);
    expect(draws.status).toBe('OK');
    expect(draws.thresholds.jobLoss).toBe(2000);
    const variant = variantSetup(setup, params, { 'medical.severity': 'card.medical.mid' }, cardIndex);
    expect(variant.rules.probabilities).toEqual(draws.thresholds);
    expect(variant.rules.medicalCost).toBe(10000000);
    expect(variant.rules.months).toBe(setup.rules.months);
  });

  it('参数包缺项时回落 v2 默认值并标 DEGRADED', () => {
    const partial = builtinParams();
    partial.assumptions = partial.assumptions.filter(item => item.key !== 'draw.marketDrop.monthly');
    const draws = v2DrawThresholds(partial);
    expect(draws.status).toBe('DEGRADED');
    expect(draws.missing).toContain('draw.marketDrop.monthly');
    expect(draws.thresholds.marketDrop).toBe(V2_DEFAULT_DRAWS.marketDrop);
  });

  it('卡片能改开销档与利率（含重算月供）', () => {
    const setup = demoSetup('HOME-U02', 'home', 100000000);
    const living = variantSetup(setup, params, { 'living.level': 'card.living.plus5' }, cardIndex);
    expect(living.profile.living).toBe(Math.round(setup.profile.living * 1.05));

    const now = variantSetup(setup, params, { 'rate.env': 'card.rate.lpr2025' }, cardIndex);
    const old = variantSetup(setup, params, { 'rate.env': 'card.rate.lpr2024' }, cardIndex);
    expect(now.plans.b.offer.annualRate).toBe('0.035');
    expect(old.plans.b.offer.annualRate).toBe('0.042');
    // 同一份底账，4.20% 环境下月供更高 —— 这正是世界线要展示的"环境差异"
    expect(old.plans.b.payment).toBeGreaterThan(now.plans.b.payment);
    expect(now.plans.a.method).toBe('full');
    expect(now.plans.a.payment).toBe(0);
  });

  it('门槛与 v2 的实际扣款一致（living - rent + 持有 + 月供）× 3', () => {
    const setup = demoSetup();
    expect(floorMinorOf(setup, 'a')).toBe((setup.profile.living - setup.profile.rent + setup.runningCost) * 3);
    expect(floorMinorOf(setup, 'b')).toBe((setup.profile.living - setup.profile.rent + setup.runningCost + setup.plans.b.payment) * 3);
  });

  it('梯度按目标过滤：汽车目标没有利率档', () => {
    const car = knobsFromCards(cards, params, demoSetup());
    const home = knobsFromCards(cards, params, demoSetup('HOME-U02', 'home', 100000000));
    expect(car.ladders.map(ladder => ladder.key)).not.toContain('rate.env');
    expect(home.ladders.map(ladder => ladder.key)).toContain('rate.env');
    expect(car.ladders.map(ladder => ladder.key)).toContain('medical.severity');
  });
});

describe('内核 × 真实引擎', () => {
  it('确定性', () => {
    const a = simulateWorldlines({ setup: demoSetup(), input: baseInput }, v2WorldlineDeps(policy));
    const b = simulateWorldlines({ setup: demoSetup(), input: baseInput }, v2WorldlineDeps(policy));
    expect(a.minUsables).toEqual(b.minUsables);
    expect(a.candidates).toEqual(b.candidates);
  });

  it('配对：改 B 的月供不影响 A 的逐月走向', () => {
    const setup = variantSetup(demoSetup(), params, {}, cardIndex);
    const tape = tapeFor(3, 2, 24);
    const before = runLine({ driver: v2Driver(policy), setup, tape });
    const tweaked = { ...setup, plans: { ...setup.plans, b: { ...setup.plans.b, payment: Math.round(setup.plans.b.payment * 1.5) } } };
    const after = runLine({ driver: v2Driver(policy), setup: tweaked, tape });
    expect(after.strategies.a.usable).toEqual(before.strategies.a.usable);
  });

  it('失败月口径 = -缺口', () => {
    const setup = variantSetup(demoSetup(), params, { 'medical.severity': 'card.medical.high' }, cardIndex);
    let checked = false;
    for (let index = 0; index < 150 && !checked; index++) {
      const outcome = runLine({ driver: v2Driver(policy), setup, tape: tapeFor(3, index) });
      for (const id of ['a', 'b'] as const) {
        const line = outcome.strategies[id];
        if (!line.firstShortfall) continue;
        checked = true;
        expect(line.usable[line.firstShortfall.month - 1]).toBe(-line.firstShortfall.amountMinor);
        expect(line.minUsable).toBeLessThan(0);
        expect(line.band).toBe('bad');
      }
    }
    expect(checked).toBe(true);
  });

  it('分档计数之和 = n，且候选标签与分档同源', () => {
    const result = simulateWorldlines({ setup: demoSetup(), input: { ...baseInput, n: 120 } }, v2WorldlineDeps(policy));
    expect(result.bands.bad + result.bands.tight + result.bands.ok).toBe(120);
    const floors = Object.fromEntries(result.strategies.map(spec => [spec.id, spec.floorMinor]));
    for (const candidate of result.candidates) {
      if (candidate.label === '不足') expect(candidate.band).toBe('bad');
      if (candidate.label === '紧巴') expect(candidate.band).toBe('tight');
      if (candidate.byStrategy.b.band === 'ok') expect(candidate.byStrategy.b.minBalanceMinor).toBeGreaterThanOrEqual(floors.b);
    }
  });

  it('性能预算：n=200 × 60 月 < 5s', () => {
    const started = performance.now();
    simulateWorldlines({ setup: demoSetup(), input: { ...baseInput, n: 200 } }, v2WorldlineDeps(policy));
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

describe('一致性：批量内核 == 交互模式（最关键的一条）', () => {
  it('同一 setup、同一 tape、同一策略，月账逐字段相等', () => {
    const profiles: LineProfile[] = [{}, { 'medical.severity': 'card.medical.high' }, { 'living.level': 'card.living.plus12' }];
    for (const profile of profiles) {
      const setup = variantSetup(demoSetup(), params, profile, cardIndex);
      for (const index of [0, 7]) {
        const tape = tapeFor(42, index, 36);
        const batch = runLine({ driver: v2Driver(policy), setup, tape });

        const run = makeRunLike(setup, tape);
        while (run.status !== 'ended' && run.state.month < tape.length) {
          advance(run, true);
          if (run.status === 'waiting' && run.pending) choose(run, selectionsForPolicy(run.pending, policy));
        }

        for (const id of ['a', 'b'] as const) {
          const interactive = run.history.map(month => {
            const settled = month.paths[id];
            if (settled.ledger) return funds(settled.state);
            return settled.state.failure ? -settled.state.failure.shortfall : 0;
          });
          expect(batch.strategies[id].usable.slice(0, interactive.length)).toEqual(interactive);
        }
        expect(batch.events.length).toBe(run.history.flatMap(month => month.events).length);
      }
    }
  });
});
