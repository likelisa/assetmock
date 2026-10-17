/**
 * 驱动端口：core 与具体业务之间**唯一**的缝。
 *
 * 谁实现它：`adapters/assetmock-v2/driver.ts`（用 v2 的 reveal/settle/stateOf）。
 * core 只调 `init → step × months`，不认识 reveal / 事件 / 贷款 / 房车。
 *
 * 想接别的推演器（房贷模型、养老模型、另一种人生模拟）？再写一个 driver 就行，
 * 上层的统计、分档、候选、agent 出参、渲染 DTO 全部复用。
 */
import type { LineEvent, StrategyId, StrategySpec, StrategyStepMonth } from './types';

export interface StepResult<TState> {
  state: TState;
  /** 本月是第几个月（1 起） */
  month: number;
  paths: Record<StrategyId, StrategyStepMonth>;
  events: LineEvent[];
}

export interface StepDriver<TState, TDraws, TSetup> {
  /** 策略顺序即展示顺序（v2 里是 A、B） */
  strategyIds: readonly StrategyId[];
  /** 开局的策略标签与分档门槛 */
  describe(setup: TSetup): StrategySpec[];
  init(setup: TSetup): TState;
  /** 推进一个月；事件资格、结算顺序、账目不变式都在实现里 */
  step(state: TState, draws: TDraws, setup: TSetup): StepResult<TState>;
  /** 本月是否还有活着的策略（全结束就提前收手） */
  alive(state: TState): boolean;
}

export function describeStrategies<TState, TDraws, TSetup>(driver: StepDriver<TState, TDraws, TSetup>, setup: TSetup): StrategySpec[] {
  return driver.describe(setup);
}
