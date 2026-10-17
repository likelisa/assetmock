/**
 * 卡组测试：**agent 有权限选卡，但没有权限乱来**。
 * 这一层钉住三件事：选卡真的改变结果、判断必须留痕、结构底线不许越过。
 */
import { describe, expect, it } from 'vitest';
import {
  defaultCardPlan, describePlan, laddersFromPlan, paramPackV1, planHash, validateCardPlan,
  cardLibraryV1, cardEvidence, type CardPlan,
} from './cards/index';
import { demoSetup, planFingerprint, v2WorldlineDeps } from './adapter-v2/index';
import { simulateWorldlines } from '@/domain/worldline';
import { toCardCatalogue, toToolPayload, payloadBytes } from './tool-contract';

const params = paramPackV1();
const cards = cardLibraryV1();
const policy = { jobLoss: 'WAIT', career: 'DECLINE' } as const;

const input = {
  seed: 42, n: 120, k: 4, months: 60, params,
  engineVersion: 'wl-prep', worldlineRulesVersion: 'wl-rules.0.1.0', v2RulesVersion: '0.2.0',
  cardsVersion: cards.version,
};

function run(plan?: CardPlan, setup = demoSetup()) {
  const fingerprint = plan ? planFingerprint(plan) : {};
  return simulateWorldlines({ setup, input: { ...input, ...fingerprint } }, v2WorldlineDeps(policy, { cards, plan }));
}

describe('默认卡组', () => {
  it('不传卡组 == 传默认卡组（行为一致，便于回退）', () => {
    const a = run();
    const b = run(defaultCardPlan(cards, 'car'));
    expect(a.bands).toEqual(b.bands);
    expect(a.minUsables).toEqual(b.minUsables);
  });

  it('默认卡组与卡库校验都通过', () => {
    const plan = defaultCardPlan(cards, 'car');
    expect(validateCardPlan(plan, cards, 'car')).toEqual([]);
    expect(describePlan(plan, cards)).toBe('全部按数据权重参与');
  });
});

describe('agent 选卡真的改变结果', () => {
  const pinnedHigh: CardPlan = {
    id: 'plan.medical-high',
    version: 'plan.v1',
    target: 'car',
    notes: ['按用户自述"家族有大病既往史"，医疗按高档参与；其余档位照常'],
    entries: [
      { cardId: 'card.medical.high', ladder: 'medical.severity', mode: 'fixed', rationale: '用户自述家族有大病既往史', evidenceIds: ['FACT:profile:healthNote'] },
      { cardId: 'card.medical.low', ladder: 'medical.severity', mode: 'excluded', rationale: '已钉高档，低档不参与', evidenceIds: ['FACT:profile:healthNote'] },
      { cardId: 'card.medical.mid', ladder: 'medical.severity', mode: 'excluded', rationale: '已钉高档，中档不参与', evidenceIds: ['FACT:profile:healthNote'] },
    ],
  };

  it('钉住医疗高档后，不足条数不少于默认', () => {
    expect(validateCardPlan(pinnedHigh, cards, 'car')).toEqual([]);
    const base = run();
    const pinned = run(pinnedHigh);
    expect(pinned.bands.bad).toBeGreaterThanOrEqual(base.bands.bad);
    expect(pinned.cardPlanId).toBe('plan.medical-high');
    expect(pinned.cardPlanHash).toBe(planHash(pinnedHigh));
  });

  it('把医疗整组排除后，结果里不再有医疗事件与医疗档', () => {
    const noMedical: CardPlan = {
      id: 'plan.no-medical',
      version: 'plan.v1',
      target: 'car',
      notes: ['用户已有足额商业医疗险，本次只看收支与市场波动对医疗的挤出效应，medical.severity 整组不参与'],
      entries: [
        { cardId: 'card.medical.low', ladder: 'medical.severity', mode: 'excluded', rationale: '已投保，自付压力不进入本局', evidenceIds: ['POLICY:p1'] },
        { cardId: 'card.medical.mid', ladder: 'medical.severity', mode: 'excluded', rationale: '已投保', evidenceIds: ['POLICY:p1'] },
        { cardId: 'card.medical.high', ladder: 'medical.severity', mode: 'excluded', rationale: '已投保', evidenceIds: ['POLICY:p1'] },
      ],
    };
    expect(validateCardPlan(noMedical, cards, 'car')).toEqual([]);
    expect(laddersFromPlan(noMedical, cards, 'car').map(ladder => ladder.key)).not.toContain('medical.severity');
    const result = run(noMedical);
    // 医疗阈值其实还在（参数包不变），但前提里不该再出现医疗档位；
    // 用一个必然不含医疗档的检查：候选中没有"大病自付"字样结合医疗档
    for (const candidate of result.candidates) {
      expect(candidate.premise).not.toContain('一次大病自付');
    }
  });

  it('权重覆写会改变档位分布，但不动数值', () => {
    const heavyMarket: CardPlan = {
      id: 'plan.market-heavy',
      version: 'plan.v1',
      target: 'car',
      notes: ['用户自述高波动行业，市场深跌档权重加倍'],
      entries: [
        { cardId: 'card.market.deep', ladder: 'market.severity', mode: 'sampled', weightOverride: 6, rationale: '用户行业波动大', evidenceIds: ['FACT:employment'] },
      ],
    };
    expect(validateCardPlan(heavyMarket, cards, 'car')).toEqual([]);
    const ladders = laddersFromPlan(heavyMarket, cards, 'car');
    const market = ladders.find(ladder => ladder.key === 'market.severity')!;
    expect(market.options.find(option => option.id === 'card.market.deep')!.weight).toBe(6);
  });
});

describe('结构底线：agent 不能绕过', () => {
  it('静默砍掉最重档 → 校验失败', () => {
    const plan: CardPlan = {
      id: 'plan.silent-tail',
      version: 'plan.v1',
      target: 'car',
      notes: ['只留下常见档位'],
      entries: [
        { cardId: 'card.market.crash', ladder: 'market.severity', mode: 'excluded', rationale: '太极端', evidenceIds: [] },
      ],
    };
    expect(validateCardPlan(plan, cards, 'car').some(issue => issue.problem.includes('最重的一档'))).toBe(true);
  });

  it('明说理由就能砍尾部（判断留痕即可，不是不许砍）', () => {
    const plan: CardPlan = {
      id: 'plan.no-tail',
      version: 'plan.v1',
      target: 'car',
      notes: ['用户目标是短期购车，不关心尾部；card.market.crash 不参与'],
      entries: [
        { cardId: 'card.market.crash', ladder: 'market.severity', mode: 'excluded', rationale: '短期目标，尾部不进入本次比较', evidenceIds: ['GOAL:car'] },
      ],
    };
    expect(validateCardPlan(plan, cards, 'car')).toEqual([]);
  });

  it('钉档与抽样混用 → 校验失败', () => {
    const plan: CardPlan = {
      id: 'plan.conflict',
      version: 'plan.v1',
      target: 'car',
      notes: [],
      entries: [
        { cardId: 'card.medical.high', ladder: 'medical.severity', mode: 'fixed', rationale: '病史', evidenceIds: ['FACT:x'] },
        { cardId: 'card.medical.mid', ladder: 'medical.severity', mode: 'sampled', rationale: '也抽中档', evidenceIds: ['FACT:x'] },
      ],
    };
    expect(validateCardPlan(plan, cards, 'car').some(issue => issue.problem.includes('其余档必须标 excluded'))).toBe(true);
  });

  it('叙事卡不能参与抽样；改数字没有入口', () => {
    const plan: CardPlan = {
      id: 'plan.narrative',
      version: 'plan.v1',
      target: 'car',
      notes: [],
      entries: [
        { cardId: 'card.family.childcost', ladder: 'narrative', mode: 'fixed', rationale: '想算养育成本', evidenceIds: [] },
      ],
    };
    const issues = validateCardPlan(plan, cards, 'car');
    expect(issues.some(issue => issue.problem.includes('叙事卡不参与结算'))).toBe(true);
    // 卡组里没有金额字段：卡片的 effect 只在卡库/参数包里，agent 只能选 cardId
    expect(Object.keys(plan.entries[0])).not.toContain('amount');
  });

  it('权重覆写越界 / 跨梯度 / 缺理由都会被拒', () => {
    const tooBig: CardPlan = {
      id: 'plan.big', version: 'plan.v1', target: 'car', notes: [],
      entries: [{ cardId: 'card.market.shallow', ladder: 'market.severity', mode: 'sampled', weightOverride: 99, rationale: 'x', evidenceIds: [] }],
    };
    expect(validateCardPlan(tooBig, cards, 'car').some(issue => issue.problem.includes('权重覆写必须在'))).toBe(true);

    const wrongLadder: CardPlan = {
      id: 'plan.wrong', version: 'plan.v1', target: 'car', notes: [],
      entries: [{ cardId: 'card.market.shallow', ladder: 'medical.severity', mode: 'sampled', rationale: 'x', evidenceIds: [] }],
    };
    expect(validateCardPlan(wrongLadder, cards, 'car').some(issue => issue.problem.includes('梯度写成'))).toBe(true);

    const noReason: CardPlan = {
      id: 'plan.bare', version: 'plan.v1', target: 'car', notes: [],
      entries: [{ cardId: 'card.market.shallow', ladder: 'market.severity', mode: 'sampled', rationale: '  ', evidenceIds: [] }],
    };
    expect(validateCardPlan(noReason, cards, 'car').some(issue => issue.problem.includes('缺少判断理由'))).toBe(true);
  });

  it('目标不匹配（拿汽车卡组跑住房）会被拒', () => {
    const plan = defaultCardPlan(cards, 'home');
    expect(validateCardPlan(plan, cards, 'car').some(issue => issue.problem.includes('适用于 home'))).toBe(true);
  });
});

describe('复现信息', () => {
  it('卡组哈希与条目顺序无关，与判断内容有关', () => {
    const plan = defaultCardPlan(cards, 'car');
    const shuffled = { ...plan, entries: [...plan.entries].reverse() };
    expect(planHash(shuffled)).toBe(planHash(plan));
    const changed = { ...plan, entries: plan.entries.map((entry, index) => (index === 0 ? { ...entry, mode: 'fixed' as const } : entry)) };
    expect(planHash(changed)).not.toBe(planHash(plan));
  });

  it('工具出参带 cardPlanId / cardPlanHash', () => {
    const plan = defaultCardPlan(cards, 'car');
    const result = run(plan);
    const payload = toToolPayload(result);
    expect(payload.cardPlanId).toBe(plan.id);
    expect(payload.cardPlanHash).toBe(planHash(plan));
  });
});

describe('选卡用的卡目录出参', () => {
  const catalogue = toCardCatalogue(cards, {
    target: 'car',
    basesOf: cardId => cardEvidence(cards.cards.find(card => card.id === cardId)!, params).map(item => item.basis),
  });

  it('四组梯度 + 叙事卡都在，且标出默认档', () => {
    expect(catalogue.ladders.map(ladder => ladder.key)).toEqual(['living.level', 'medical.severity', 'market.severity']);
    const medical = catalogue.ladders.find(ladder => ladder.key === 'medical.severity')!;
    expect(medical.defaultOptionId).toBe('card.medical.low');
    expect(medical.options.map(option => option.cardId)).toContain('card.medical.mid');
    expect(catalogue.narrative.length).toBe(6);
  });

  it('体积在预算内（只给标题/前提/依据等级）', () => {
    expect(payloadBytes(catalogue)).toBeLessThan(6144);
  });
});
