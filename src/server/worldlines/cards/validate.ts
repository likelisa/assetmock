/**
 * 卡库校验：卡片数值不许手写，必须与它引用的参数一致。
 *
 * 这一层是"卡片可信"的唯一闸门。改一个数忘改另一个数、把压力假设写成研究口吻、
 * 引用了一条参数包里不存在的 key —— 都会在这里被抓住。
 */
import { paramsIndex } from '@/domain/worldline/params';
import type { Param, WorldlineParams } from '@/domain/worldline/types';
import type { CardIssue, CardLibrary, EventCard } from './types';

const researchTone = /研究显示|数据显示|统计表明|权威报告|必定|一定会/;

const unitOf = (value: number, unit: Param['unit']) => `${value}${unit}`;

/** 一条卡里对某个参数的引用，返回问题清单 */
function checkEffectAgainstParam(card: EventCard, param: Param | undefined, key: string, expected: number, tolerance = 0): CardIssue[] {
  if (!param) return [{ card: card.id, problem: `引用了参数包里不存在的 ${key}` }];
  if (Math.abs(param.value - expected) > tolerance) {
    return [{ card: card.id, problem: `${key} 的值是 ${unitOf(param.value, param.unit)}，卡片写的是 ${expected}（卡片不许手写数字）` }];
  }
  return [];
}

export function validateCards(library: CardLibrary, params: WorldlineParams): CardIssue[] {
  const issues: CardIssue[] = [];
  const index = paramsIndex(params);
  const seen = new Set<string>();
  const ladderDefaults = new Map<string, number>();

  for (const card of library.cards) {
    if (seen.has(card.id)) issues.push({ card: card.id, problem: 'id 重复' });
    seen.add(card.id);

    if (!Number.isInteger(card.weight) || card.weight < 0) issues.push({ card: card.id, problem: 'weight 必须是非负整数' });
    if (card.ladder === 'narrative' && card.weight !== 0) issues.push({ card: card.id, problem: '叙事卡不参与抽样，weight 必须为 0' });
    if (card.ladder !== 'narrative' && card.weight === 0) issues.push({ card: card.id, problem: '非叙事卡必须有正的抽样权重' });
    if (!card.premise.trim()) issues.push({ card: card.id, problem: '缺少可复述的前提' });
    if (!card.canSay.length || !card.cantSay.length) issues.push({ card: card.id, problem: '缺 canSay / cantSay 口径' });
    if (!card.params.length) issues.push({ card: card.id, problem: '没有引用任何参数（等于无出处）' });

    for (const key of card.params) {
      if (!index.has(key)) issues.push({ card: card.id, problem: `引用了参数包里不存在的 ${key}` });
    }

    // 引用第三方 / 智库数据时，必须点名机构
    for (const key of card.params) {
      const param = index.get(key);
      if (!param) continue;
      if ((param.sourceQuality === 'THINK_TANK' || param.sourceQuality === 'THIRD_PARTY') && !/育娲|精算师协会/.test(param.label)) {
        issues.push({ card: card.id, problem: `${key} 是${param.sourceQuality === 'THINK_TANK' ? '智库' : '第三方'}数据，label 必须点名机构` });
      }
      if (param.basis === 'PRESS_HYPOTHESIS' && researchTone.test(card.premise)) {
        issues.push({ card: card.id, problem: '前提用了研究口吻，但引用的参数是压力假设' });
      }
    }

    // effect 里的数字必须等于参数值
    const effect = card.effect;
    if (effect.medicalCostMinor !== undefined) {
      const key = card.params.find(item => item.startsWith('medical.cost.'));
      issues.push(...(key ? checkEffectAgainstParam(card, index.get(key), key, effect.medicalCostMinor) : [{ card: card.id, problem: '医疗金额没有引用 medical.cost.* 参数' }]));
    }
    if (effect.marketDropRate !== undefined) {
      const key = card.params.find(item => item.startsWith('market.dropRate.'));
      issues.push(...(key ? checkEffectAgainstParam(card, index.get(key), key, Number(effect.marketDropRate), 1e-9) : [{ card: card.id, problem: '跌幅没有引用 market.dropRate.* 参数' }]));
    }
    if (effect.livingDrift !== undefined) {
      const key = card.params.find(item => item.startsWith('living.drift.'));
      issues.push(...(key ? checkEffectAgainstParam(card, index.get(key), key, effect.livingDrift, 1e-9) : [{ card: card.id, problem: '开销档没有引用 living.drift.* 参数' }]));
    }
    if (effect.annualRate !== undefined) {
      const key = card.params.find(item => item.startsWith('rate.lpr'));
      issues.push(...(key ? checkEffectAgainstParam(card, index.get(key), key, Number(effect.annualRate), 1e-9) : [{ card: card.id, problem: '利率没有引用 rate.* 参数' }]));
    }

    if (card.isDefault) ladderDefaults.set(card.ladder, (ladderDefaults.get(card.ladder) ?? 0) + 1);
  }

  for (const [ladder, count] of ladderDefaults) {
    if (count > 1) issues.push({ card: ladder, problem: '同一梯度只能有一个默认档' });
  }
  return issues;
}

/** 供页面 / agent 引用的一句话：这张卡为什么是这个数 */
export function cardEvidence(card: EventCard, params: WorldlineParams): Array<{ key: string; label: string; basis: Param['basis']; sourceQuality?: Param['sourceQuality'] }> {
  const index = paramsIndex(params);
  return card.params.flatMap(key => {
    const param = index.get(key);
    if (!param) return [];
    return [{ key, label: param.label, basis: param.basis, ...(param.sourceQuality ? { sourceQuality: param.sourceQuality } : {}) }];
  });
}
