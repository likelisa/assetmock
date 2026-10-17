/**
 * 两个"出口"的测试：
 * - agent-tool：体积预算、必要字段、prompt 口径；
 * - render-model：DTO 完整、可序列化、长度自洽。
 */
import { describe, expect, it } from 'vitest';
import { demoSetup, v2WorldlineDeps } from './adapter-v2/index';
import { cardLibraryV1, paramPackV1 } from './cards/index';
import { builtinParams, simulateWorldlines, validateParams } from '@/domain/worldline';
import type { WorldlineRunResult } from '@/domain/worldline/types';
import {
  PROMPT_SNIPPET, TOOL_DESCRIPTION, TOOL_INPUT_SCHEMA, TOOL_NAME, TOOL_PAYLOAD_LIMIT_BYTES, TOOL_ROLES,
  assertPayloadBudget, payloadBytes, toToolPayload,
} from './tool-contract';
import { assertRenderable, toRenderModel } from '@/domain/worldline/render-model';

const params = paramPackV1();
const cards = cardLibraryV1();

function result(n = 200): WorldlineRunResult {
  return simulateWorldlines(
    {
      setup: demoSetup(),
      input: {
        seed: 42, n, k: 4, months: 60, params,
        engineVersion: 'wl-prep', worldlineRulesVersion: 'wl-rules.0.1.0', v2RulesVersion: '0.2.0',
        cardsVersion: cards.version,
      },
    },
    v2WorldlineDeps({ jobLoss: 'WAIT', career: 'DECLINE' }),
  );
}

describe('agent 工具契约', () => {
  const payload = toToolPayload(result());

  it('元信息齐全', () => {
    expect(TOOL_NAME).toBe('simulateWorldlines');
    expect(TOOL_DESCRIPTION).toContain('不预测未来');
    expect([...TOOL_ROLES]).toEqual(['GOAL', 'WEALTH', 'CASHFLOW']);
    expect(TOOL_INPUT_SCHEMA.properties.n.maximum).toBe(600);
    expect(TOOL_INPUT_SCHEMA.properties.responsePolicy.enum).toContain('WAIT');
  });

  it('出参 ≤ 6KB，且不含逐月序列', () => {
    const bytes = assertPayloadBudget(payload);
    expect(bytes).toBeLessThanOrEqual(TOOL_PAYLOAD_LIMIT_BYTES);
    const text = JSON.stringify(payload);
    expect(text).not.toContain('usable');
    expect(text).not.toContain('quantilesByMonth');
    expect(payload.candidates.length).toBeGreaterThan(0);
    expect(payload.candidates.length).toBeLessThanOrEqual(6);
  });

  it('结论可复现：seed / n / paramsVersion / cardsVersion 都在出参里', () => {
    expect(payload.seed).toBe(42);
    expect(payload.n).toBe(200);
    expect(payload.paramsVersion).toBe('params.v1');
    expect(payload.cardsVersion).toBe('cards.v1');
    expect(payload.evidenceIds[0].startsWith('WORLDLINE_RUN:')).toBe(true);
  });

  it('每个候选都带两策略判定与出处口径', () => {
    for (const candidate of payload.candidates) {
      expect(candidate.byStrategy.a).toBeTruthy();
      expect(candidate.byStrategy.b).toBeTruthy();
      expect(typeof candidate.byStrategy.a.minBalanceMinor).toBe('string');
      expect(candidate.premise.length).toBeGreaterThan(0);
    }
    const bases = new Set(payload.provenance.map(entry => entry.basis));
    expect(bases.has('PUBLIC_STATISTIC')).toBe(true);
    expect(new Set(result().provenance.map(entry => entry.basis)).has('PRESS_HYPOTHESIS')).toBe(true);
    expect(payload.provenance.length).toBeLessThanOrEqual(6);
  });

  it('prompt 片段写死了三档措辞与口径红线', () => {
    expect(PROMPT_SNIPPET).toContain('在 N 条模拟里有 M 条');
    expect(PROMPT_SNIPPET).toContain('DERIVED');
    expect(PROMPT_SNIPPET).toContain('不用"预测');
    expect(PROMPT_SNIPPET).toContain('getWorldlineDetail');
  });

  it('体积护栏本身有效', () => {
    expect(() => assertPayloadBudget({ big: 'x'.repeat(TOOL_PAYLOAD_LIMIT_BYTES) })).toThrow();
    expect(payloadBytes({ a: 1 })).toBeGreaterThan(0);
  });
});

describe('渲染层 DTO', () => {
  const model = toRenderModel(result(120));

  it('可序列化、长度自洽、门槛存在', () => {
    expect(() => assertRenderable(model)).not.toThrow();
    expect(model.minUsables.a.length).toBe(120);
    expect(model.quantilesByMonth.a.length).toBe(60);
    expect(model.strategies.map(strategy => strategy.id)).toEqual(['a', 'b']);
    expect(model.strategies[1].floorMinor).toBeGreaterThan(model.strategies[0].floorMinor);
  });

  it('三层占比与 n 对齐，claim 与版本都在 meta 里', () => {
    expect(model.bands.bad + model.bands.tight + model.bands.ok).toBe(120);
    expect(model.meta.n).toBe(120);
    expect(model.meta.claim).toContain('条模拟里');
    expect(model.meta.paramsVersion).toBe('params.v1');
    expect(model.provenance.length).toBeGreaterThan(0);
  });

  it('候选给渲染层的是"可画"的最小信息', () => {
    for (const candidate of model.candidates) {
      expect(candidate.byStrategy.a.minBalanceMinor).toBeTypeOf('number');
      expect(['bad', 'tight', 'ok']).toContain(candidate.band);
      expect(candidate.premise.length).toBeGreaterThan(0);
      expect(typeof candidate.profileLabel).toBe('string');
    }
  });
});

describe('参数包校验（出处完整性）', () => {
  const byKey = (pack: ReturnType<typeof paramPackV1>, key: string) =>
    [...pack.facts, ...pack.assumptions].find(item => item.key === key)!;

  it('压力假设不能用研究口吻', () => {
    const pack = paramPackV1();
    Object.assign(byKey(pack, 'draw.jobLoss.monthly'), { label: '研究显示失业率是 3%' });
    expect(validateParams(pack).join()).toContain('研究口吻');
  });

  it('事实层不许塞压力假设', () => {
    const pack = paramPackV1();
    pack.facts = [{ ...byKey(pack, 'draw.medical.monthly') }];
    expect(validateParams(pack).join()).toContain('不能放进 facts');
  });

  it('标了公开统计就必须有快照来源 + sourceQuality', () => {
    const pack = builtinParams();
    pack.assumptions = [{ ...pack.assumptions[0], basis: 'PUBLIC_STATISTIC' }];
    expect(validateParams(pack).join()).toContain('来源不是快照');
  });

  it('标了派生值就必须给公式与输入', () => {
    const pack = paramPackV1();
    pack.facts = [{ ...byKey(pack, 'medical.oop.share'), key: 'medical.oop.perCapitaMinor', basis: 'DERIVED', sourceQuality: 'OFFICIAL' }];
    expect(validateParams(pack).join()).toContain('缺少公式');
  });

  it('派生值带公式可以通过，并能带出 derivation', () => {
    const pack = paramPackV1();
    pack.facts = [{
      ...byKey(pack, 'medical.oop.share'),
      key: 'medical.oop.perCapitaMinor',
      value: 177600,
      unit: 'CNY_MINOR',
      basis: 'DERIVED',
      sourceQuality: 'OFFICIAL',
      label: '由个人卫生支出与全国人口推得人均自付医疗支出约 1776 元/年',
      derivation: { formula: 'round(25007.5e8 / 140828e4 * 100)', inputs: ['medical.oop.total.2024', 'population.total.2024'] },
    }];
    expect(validateParams(pack)).toEqual([]);
    const payload = toToolPayload({ ...result(60), provenance: pack.facts.map(param => ({
      param: param.key, value: param.value, unit: param.unit, label: param.label, basis: param.basis,
      sourceQuality: param.sourceQuality, derivation: param.derivation,
      url: param.source.kind === 'SNAPSHOT' ? param.source.url : undefined,
      retrievedAt: param.source.kind === 'SNAPSHOT' ? param.source.retrievedAt : undefined,
      quote: param.source.kind === 'SNAPSHOT' ? param.source.quote : undefined,
    })) });
    expect(payload.provenance[0].derivation?.formula).toContain('25007.5');
  });
});
