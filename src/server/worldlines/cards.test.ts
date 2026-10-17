/**
 * 事件卡库测试：卡片可信度的唯一闸门。
 * 每一条断言对应调研稿里的一个警告（口径混称、数字手抄、机构名省略、假设抬高成研究）。
 */
import { describe, expect, it } from 'vitest';
import { cardLibraryV1, laddersFromCards, narrativeCards, paramPackV1, validateCards, cardEvidence } from './cards/index';
import { paramsIndex, validateParams } from '@/domain/worldline/params';

const params = paramPackV1();
const cards = cardLibraryV1();

describe('卡库结构', () => {
  it('参数包本身通过校验（出处完整性）', () => {
    expect(validateParams(params)).toEqual([]);
  });

  it('18 张卡、全部通过校验', () => {
    expect(cards.cards.length).toBe(18);
    expect(validateCards(cards, params)).toEqual([]);
  });

  it('覆盖 10 个门类', () => {
    const categories = new Set(cards.cards.map(card => card.category));
    for (const category of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      expect(categories.has(category as never), `缺少门类 ${category}`).toBe(true);
    }
  });
});

describe('数字不许手写：effect 必须等于引用参数的值', () => {
  it('改参数不改卡片 → 校验报错', () => {
    const broken = paramPackV1();
    broken.assumptions = broken.assumptions.map(item => (item.key === 'medical.cost.mid' ? { ...item, value: 12000000 } : item));
    const issues = validateCards(cards, broken);
    expect(issues.some(issue => issue.problem.includes('medical.cost.mid'))).toBe(true);
  });

  it('引用不存在的参数 → 校验报错', () => {
    const broken = cardLibraryV1();
    broken.cards[0] = { ...broken.cards[0], params: ['living.drift.base', 'no.such.param'] };
    expect(validateCards(broken, params).some(issue => issue.problem.includes('no.such.param'))).toBe(true);
  });

  it('每张卡的 medicalCost / marketDropRate / livingDrift / annualRate 都与参数逐一对得上', () => {
    const index = paramsIndex(params);
    for (const card of cards.cards) {
      if (card.effect.medicalCostMinor !== undefined) {
        const key = card.params.find(item => item.startsWith('medical.cost.'))!;
        expect(card.effect.medicalCostMinor).toBe(index.get(key)!.value);
      }
      if (card.effect.marketDropRate !== undefined) {
        const key = card.params.find(item => item.startsWith('market.dropRate.'))!;
        expect(Number(card.effect.marketDropRate)).toBe(index.get(key)!.value);
      }
      if (card.effect.livingDrift !== undefined) {
        const key = card.params.find(item => item.startsWith('living.drift.'))!;
        expect(card.effect.livingDrift).toBe(index.get(key)!.value);
      }
      if (card.effect.annualRate !== undefined) {
        const key = card.params.find(item => item.startsWith('rate.lpr'))!;
        expect(Number(card.effect.annualRate)).toBe(index.get(key)!.value);
      }
    }
  });
});

describe('口径红线', () => {
  it('叙事卡不参与抽样', () => {
    const narratives = narrativeCards(cards);
    expect(narratives.length).toBe(6);
    for (const card of narratives) expect(card.weight).toBe(0);
    const ladders = laddersFromCards(cards, 'car');
    for (const ladder of ladders) {
      for (const option of ladder.options) {
        const card = cards.cards.find(item => item.id === option.id)!;
        expect(card.weight).toBeGreaterThan(0);
      }
    }
  });

  it('第三方 / 智库数据的 label 必须点名机构', () => {
    const thinker = cards.cards.find(card => card.id === 'card.family.childcost')!;
    const evidence = cardEvidence(thinker, params);
    expect(evidence.every(item => /育娲/.test(item.label))).toBe(true);
    expect(evidence.every(item => item.sourceQuality === 'THINK_TANK')).toBe(true);
    const actuary = cards.cards.find(card => card.id === 'card.medical.mid')!;
    expect(cardEvidence(actuary, params).some(item => /精算师协会/.test(item.label))).toBe(true);
  });

  it('压力假设不许用研究口吻', () => {
    const broken = cardLibraryV1();
    const target = broken.cards.find(card => card.id === 'card.medical.mid')!;
    target.premise = '研究显示一次大病平均自付 10 万元';
    expect(validateCards(broken, params).some(issue => issue.problem.includes('研究口吻'))).toBe(true);
  });

  it('知识库里的口径警告落到了 cantSay 上', () => {
    const cant = (id: string) => cards.cards.find(card => card.id === id)!.cantSay.join(' / ');
    expect(cant('card.jobLoss.benefit')).toContain('存量失业率');
    expect(cant('card.medical.high')).toContain('22–80 万');
    expect(cant('card.medical.low')).toContain('9870');
    expect(cant('card.market.shallow')).toContain('整轮熊市跌幅');
    expect(cant('card.rate.lpr2025')).toContain('你能拿到');
    expect(cant('card.retire.horizon')).toContain('替代率');
  });
});

describe('梯度', () => {
  it('四组梯度，权重来自卡片', () => {
    const ladders = laddersFromCards(cards, 'home');
    expect(ladders.map(ladder => ladder.key).sort()).toEqual(['living.level', 'market.severity', 'medical.severity', 'rate.env']);
    const medical = ladders.find(ladder => ladder.key === 'medical.severity')!;
    expect(medical.options.map(option => option.weight)).toEqual([5, 3, 2]);
    expect(medical.defaultOptionId).toBe('card.medical.low');
  });

  it('汽车目标不含利率档', () => {
    expect(laddersFromCards(cards, 'car').map(ladder => ladder.key)).not.toContain('rate.env');
  });
});
