/**
 * 参数包：事实层 / 假设层分开存，全部带出处。
 *
 * core 只做三件事：
 *   1. 校验出处完整性（basis 三档、公开统计要快照 + 逐字引用、派生要给公式）
 *   2. 输出 provenance（页面与 agent 引用它）
 *   3. 给适配器一个按 key 查值的入口
 *
 * 参数包**不认识具体引擎**：哪些 key 会被用到，由适配器决定（见
 * adapters/assetmock-v2/knobs.ts）。新增一个真实数据来源 = 换一份参数包，代码不改。
 */
import type { Param, ParamBasis, ParamUnit, ProvenanceEntry, WorldlineParams } from './types';

export const BUILTIN_PARAMS_VERSION = 'params.builtin.v1';

/** 内置压力假设的统一样子（全项目唯一硬编码处） */
function assumption(key: string, value: number, unit: ParamUnit, label: string): Param {
  return { key, value, unit, source: { kind: 'BUILTIN' }, basis: 'PRESS_HYPOTHESIS', label };
}

/**
 * 内置压力包：`facts` 为空（还没有接真实数据），`assumptions` 是压力假设。
 *
 * 与 v2 游戏默认（每百万每月：医疗 1000 / 失业 2000 / 奖金延期 200000 / 下跌 5000 / 机会 5000）
 * 相比，医疗与失业被明显放大 —— **这是压力假设，不是统计结论**。
 */
export function builtinParams(): WorldlineParams {
  return {
    version: BUILTIN_PARAMS_VERSION,
    facts: [],
    assumptions: [
      assumption('draw.medical.monthly', 20000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定每月约有 2% 的机会出现一次大额医疗自付'),
      assumption('draw.jobLoss.monthly', 30000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定每月约有 3% 的机会收入中断'),
      assumption('draw.bonusDelay.monthly', 200000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定每笔年度奖金有 20% 的机会延期（沿用 v2 游戏设定）'),
      assumption('draw.marketDrop.monthly', 50000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定有持仓的月份约有 5% 的机会出现一次投资下跌'),
      assumption('draw.career.monthly', 5000, 'EVENTS_PER_MILLION_PER_MONTH', '职业机会沿用 v2 游戏设定，不额外放大'),
      assumption('living.drift', 0.05, 'RATIO', '我们假定生活开销在"不加价 / +5% / +10%"三档之间分布'),
    ],
  };
}

/** 事实层 + 假设层合并查表 */
export function paramsIndex(params: WorldlineParams): Map<string, Param> {
  const index = new Map<string, Param>();
  for (const param of [...(params.facts ?? []), ...(params.assumptions ?? [])]) {
    if (index.has(param.key)) throw new Error(`参数 key 重复：${param.key}`);
    index.set(param.key, param);
  }
  return index;
}

export function findParam(params: WorldlineParams, key: string): Param | undefined {
  return paramsIndex(params).get(key);
}

export function allParams(params: WorldlineParams): Param[] {
  return [...(params.facts ?? []), ...(params.assumptions ?? [])];
}

const researchTone = /研究|数据显示|统计表明|权威报告/;

/** 校验参数包；返回问题清单，空数组 = 通过。快照加载与采集器都要过这一关。 */
export function validateParams(params: WorldlineParams): string[] {
  const problems: string[] = [];
  if (!params.version?.trim()) problems.push('参数包缺少 version');
  const facts = params.facts ?? [];
  const assumptions = params.assumptions ?? [];
  if (!facts.length && !assumptions.length) problems.push('参数包是空的');

  const seen = new Set<string>();
  const check = (param: Param, layer: 'facts' | 'assumptions') => {
    if (!param?.key?.trim()) { problems.push(`${layer} 里有参数缺少 key`); return; }
    if (seen.has(param.key)) problems.push(`参数 key 重复：${param.key}`);
    seen.add(param.key);
    if (typeof param.value !== 'number' || !Number.isFinite(param.value)) { problems.push(`${param.key} 不是有限数字`); return; }
    if (param.unit === 'EVENTS_PER_MILLION_PER_MONTH' && (!Number.isInteger(param.value) || param.value < 0 || param.value > 1000000)) {
      problems.push(`${param.key} 必须是 0..1000000 的整数`);
    }
    if (!param.label?.trim()) problems.push(`${param.key} 缺少给用户看的一句话`);
    // 事实层不许塞假设
    if (layer === 'facts' && param.basis === 'PRESS_HYPOTHESIS') problems.push(`${param.key} 是假设，不能放进 facts`);
    if (param.basis === 'PRESS_HYPOTHESIS') {
      if (param.source.kind !== 'BUILTIN') problems.push(`${param.key} 是压力假设，来源应为 BUILTIN`);
      if (researchTone.test(param.label)) problems.push(`${param.key} 是压力假设，不能用研究口吻`);
    }
    if (param.basis === 'PUBLIC_STATISTIC') {
      if (param.source.kind !== 'SNAPSHOT') problems.push(`${param.key} 标了公开统计但来源不是快照`);
      else if (!param.source.url || !param.source.retrievedAt || !param.source.quote) problems.push(`${param.key} 缺少 url / retrievedAt / 逐字引用`);
      if (!param.sourceQuality) problems.push(`${param.key} 标了公开统计但没给 sourceQuality`);
    }
    if (param.basis === 'DERIVED') {
      if (!param.derivation?.formula?.trim() || !param.derivation.inputs?.length) problems.push(`${param.key} 标了派生值但缺少公式或输入`);
    }
  };
  facts.forEach(param => check(param, 'facts'));
  assumptions.forEach(param => check(param, 'assumptions'));
  return problems;
}

export function basisWording(basis: ParamBasis): string {
  if (basis === 'PUBLIC_STATISTIC') return '公开统计（可引出处）';
  if (basis === 'DERIVED') return '由公开数据推得（需带公式）';
  return '压力假设（不可当事实复述）';
}

export function provenanceOf(params: WorldlineParams): ProvenanceEntry[] {
  return allParams(params).map(param => ({
    param: param.key,
    value: param.value,
    unit: param.unit,
    label: param.label,
    basis: param.basis,
    ...(param.sourceQuality ? { sourceQuality: param.sourceQuality } : {}),
    ...(param.derivation ? { derivation: param.derivation } : {}),
    ...(param.source.kind === 'SNAPSHOT'
      ? { url: param.source.url, retrievedAt: param.source.retrievedAt, quote: param.source.quote }
      : {}),
  }));
}
