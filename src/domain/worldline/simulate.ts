/**
 * 编排：n 条世界线 → 统计 → 分档 → 候选 → 对外结构。
 *
 * 每条世界线抽两样东西，都只依赖 `(seed, i)`：
 *   1. 强度档组合（profile）：每个 ladder 抽一档 —— 事件卡就落在这一层；
 *   2. tape：外部经历的随机数序列。
 * 两条策略共用同一份 tape 与同一份 profile ⇒ 配对成立，差异只归因于策略。
 */
import type { StepDriver } from './driver';
import { runLine } from './kernel';
import { validateParams } from './params';
import { signatureOf } from './premise';
import { lineSeed, mulberry32, pickWeighted } from './random';
import { worstBand } from './scalars';
import { selectCandidates } from './select';
import {
  claimText, countBands, evidenceIdsOf, provenanceEntries, quantilesByMonth, strategyStats,
} from './report';
import type {
  EngineKnobs, LineProfile, SimulateInput, Worldline, WorldlineParams, WorldlineRunResult,
} from './types';

export const MAX_N = 2000;

export interface SimulateDeps<TState, TDraws, TSetup> {
  driver: StepDriver<TState, TDraws, TSetup>;
  sampleDraw: (rng: () => number) => TDraws;
  /** 把 profile（强度档组合）落到 setup 上：纯数据，不改引擎 */
  variant: (setup: TSetup, params: WorldlineParams, profile: LineProfile) => TSetup;
  /** 从参数包 + 具体 setup 解出强度档梯度（卡库在这一层进来） */
  knobs: (params: WorldlineParams, setup: TSetup) => EngineKnobs;
}

export interface SimulateRequest<TSetup> {
  setup: TSetup;
  input: SimulateInput;
}

/** 抽一份档位组合 + 人类可读串（非默认档才写出来，并记住它对应哪类事件） */
export function sampleProfile(
  rng: () => number,
  knobs: EngineKnobs,
): { profile: LineProfile; profileLabel: string; profileLabels: Record<string, { label: string; eventKind?: string }> } {
  const profile: LineProfile = {};
  const profileLabels: Record<string, { label: string; eventKind?: string }> = {};
  const labels: string[] = [];
  for (const ladder of knobs.ladders) {
    if (!ladder.options.length) throw new Error(`强度档 ${ladder.key} 没有可选项`);
    const option = pickWeighted(rng, ladder.options.map(item => ({ ...item })));
    profile[ladder.key] = option.id;
    if (option.id !== ladder.defaultOptionId) {
      profileLabels[ladder.key] = { label: option.label, ...(ladder.eventKind ? { eventKind: ladder.eventKind } : {}) };
      labels.push(option.label);
    }
  }
  return { profile, profileLabel: labels.join(' · '), profileLabels };
}

export function simulateWorldlines<TState, TDraws, TSetup>(
  { setup, input }: SimulateRequest<TSetup>,
  deps: SimulateDeps<TState, TDraws, TSetup>,
): WorldlineRunResult {
  const { seed, n, k, params } = input;
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) throw new Error(`世界线条数必须在 1..${MAX_N}`);
  if (!Number.isInteger(seed)) throw new Error('种子必须是整数');
  if (!Number.isInteger(input.months) || input.months < 1) throw new Error('推演月数必须是正整数');
  const problems = validateParams(params);
  if (problems.length) throw new Error(`参数包未通过校验：${problems.slice(0, 3).join('；')}`);

  const months = input.months;
  const specs = deps.driver.describe(setup);
  const knobs = deps.knobs(params, setup);
  const lines: Worldline[] = [];

  for (let index = 0; index < n; index++) {
    const rng = mulberry32(lineSeed(seed, index));
    const { profile, profileLabel, profileLabels } = sampleProfile(rng, knobs);
    const tape = Array.from({ length: months }, () => deps.sampleDraw(rng));
    const lineSetup = deps.variant(setup, params, profile);
    const outcome = runLine({ driver: deps.driver, setup: lineSetup, tape });
    const worstUsable = Math.min(...specs.map(spec => outcome.strategies[spec.id].minUsable));
    lines.push({
      id: `W-${String(index).padStart(3, '0')}`,
      index,
      profile,
      profileLabel,
      profileLabels,
      events: outcome.events,
      strategies: outcome.strategies,
      worstUsable,
      worstBand: worstBand(specs.map(spec => outcome.strategies[spec.id].band)),
      signature: signatureOf(outcome.events, profile),
    });
  }

  const selected = selectCandidates(lines, { k, limit: input.limitCandidates ?? 6 });
  const bands = countBands(lines);
  const failedAnyCount = lines.filter(line => specs.some(spec => line.strategies[spec.id].status === 'failed')).length;
  const shortfallCount = lines.filter(line => line.worstBand === 'bad').length;

  const minUsables = Object.fromEntries(specs.map(spec => [spec.id, lines.map(line => line.strategies[spec.id].minUsable)]));
  const monthly = Object.fromEntries(specs.map(spec => [spec.id, quantilesByMonth(lines, months, spec.id)]));

  return {
    seed,
    n,
    months,
    engineVersion: input.engineVersion,
    worldlineRulesVersion: input.worldlineRulesVersion,
    v2RulesVersion: input.v2RulesVersion,
    paramsVersion: params.version,
    paramsSha256: params.sha256,
    cardsVersion: input.cardsVersion,
    cardPlanId: input.cardPlanId,
    cardPlanHash: input.cardPlanHash,
    dataStatus: input.dataStatus ?? knobs.status,
    strategies: specs,
    bands,
    byStrategy: specs.map(spec => strategyStats(lines, spec.id)),
    candidates: selected.candidates,
    minUsables,
    quantilesByMonth: monthly,
    shortfallCount,
    claim: claimText({ n, bands, shortfallCount, failedAnyCount }),
    provenance: provenanceEntries(params),
    evidenceIds: evidenceIdsOf(seed, n, months, params, selected.candidates.map(candidate => candidate.id)),
  };
}

/** 给"再来一把"与测试用：把结果压成一行便于对拍 */
export function fingerprintOf(result: WorldlineRunResult): string {
  return JSON.stringify({
    seed: result.seed,
    n: result.n,
    bands: result.bands,
    byStrategy: result.byStrategy.map(stat => [stat.strategyId, stat.p5, stat.p50, stat.p90, stat.bandCounts]),
    candidates: result.candidates.map(candidate => [candidate.id, candidate.band, candidate.label, candidate.premise]),
  });
}
