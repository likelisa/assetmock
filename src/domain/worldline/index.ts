/**
 * core 出口。
 *
 * 约定：外部（agent 接口层 / 渲染层 / 适配器）只从这里拿东西；
 * 渲染层**不允许** import 本文件里的实现，只允许读 `interfaces/render-model.ts` 的类型。
 */
export * from './types';
export { mulberry32, lineSeed, drawMillion, pickWeighted } from './random';
export { runLine, type RunLineParams, type RunLineOutcome } from './kernel';
export type { StepDriver, StepResult } from './driver';
export {
  quantile, median, distribution, floorFromFixedOutflow, bandOf, worstBand, minOf,
} from './scalars';
export { buildSlots, fitSlots, selectCandidates, toCandidate, labelOf, marginOf } from './select';
export { describeEvents, premiseOf, signatureOf, eventKindLabels } from './premise';
export {
  builtinParams, validateParams, provenanceOf, paramsIndex, findParam, allParams,
  basisWording, BUILTIN_PARAMS_VERSION,
} from './params';
export { simulateWorldlines, sampleProfile, fingerprintOf, MAX_N, type SimulateDeps, type SimulateRequest } from './simulate';
export {
  claimText, strategyStats, quantilesByMonth, countBands, bandBreakdown,
  assertDisplayHygiene, evidenceIdsOf, bannedWords,
} from './report';
