/**
 * 适配器：把 assetmock 的 v2 结算引擎接到 core 的 `StepDriver` 上。
 *
 * **这是整个世界线模块里唯一 import v2 结算引擎的地方**。
 * core 因此保持通用：换一个推演器只需另写一个 driver。
 *
 * 零侵入：
 * - 只用 `src/domain/v2/engine.ts` 已导出的纯函数（initialState / reveal / settle / stateOf / funds）；
 * - 不 import `server/v2/store.ts`（避免把 better-sqlite3 拖进依赖图）；
 * - 不 mutate 任何既有 run。
 */
import { funds, initialState, reveal, settle, stateOf } from '@/domain/v2/engine';
import type { Draws, Pending, Setup, State } from '@/domain/v2/types';
import type { StepDriver, StepResult } from '@/domain/worldline/driver';
import { drawMillion } from '@/domain/worldline/random';
import { floorFromFixedOutflow } from '@/domain/worldline/scalars';
import type { StrategySpec } from '@/domain/worldline/types';

export type ResponsePolicy = 'WAIT' | 'LOWER' | 'TEMPORARY';
export type CareerPolicy = 'DECLINE' | 'ACCEPT';

export interface V2Policy {
  jobLoss: ResponsePolicy;
  career: CareerPolicy;
}

const jobLossChoice = { WAIT: 'wait', LOWER: 'lower', TEMPORARY: 'temporary' } as const;
const careerChoice = { DECLINE: 'decline', ACCEPT: 'accept' } as const;

const strategyIds = ['a', 'b'] as const;

/** 把本月待决策项映射成固定应对策略；无法映射时报错而不是猜 */
export function selectionsForPolicy(pending: Pending, policy: V2Policy) {
  return pending.decisions.map(decision => {
    const choice = decision.kind === 'jobLoss' ? jobLossChoice[policy.jobLoss] : careerChoice[policy.career];
    if (!decision.options.includes(choice)) throw new Error(`应对策略 ${choice} 不在本月可选范围内（${decision.kind}）`);
    return { path: decision.path, kind: decision.kind, choice };
  });
}

/**
 * 分档门槛：与 `settle()` 实际扣的一致 ——
 * 生活支出记的是 `living - rent`（购房后不再付租金），再加持有成本与月供，× 3 个月。
 * 两条策略的月供不同 ⇒ 门槛本来就不同，不要拉平。
 */
export function floorMinorOf(setup: Setup, strategyId: 'a' | 'b'): number {
  const payment = setup.plans[strategyId].payment;
  return floorFromFixedOutflow(setup.profile.living - setup.profile.rent + setup.runningCost + payment);
}

export function v2Driver(policy: V2Policy): StepDriver<State, Draws, Setup> {
  return {
    strategyIds: [...strategyIds],
    describe(setup): StrategySpec[] {
      return strategyIds.map(id => ({ id, label: setup.plans[id].label, floorMinor: floorMinorOf(setup, id) }));
    },
    init(setup) {
      return initialState(setup);
    },
    alive(state) {
      return strategyIds.some(id => state.paths[id].status === 'running');
    },
    step(state, draws, setup): StepResult<State> {
      const pending = reveal(state, draws, setup);
      const selections = selectionsForPolicy(pending, policy);
      const month = settle(state, pending, selections, setup);
      const paths = Object.fromEntries(strategyIds.map(id => {
        const settled = month.paths[id];
        if (settled.ledger) return [id, { status: settled.state.status, settledUsable: funds(settled.state) }];
        const failure = settled.state.failure;
        if (settled.state.status === 'failed' && failure && failure.month === month.month) {
          return [id, { status: 'failed' as const, settledUsable: null, failure }];
        }
        return [id, { status: settled.state.status, settledUsable: null }];
      }));
      return {
        state: stateOf(month),
        month: month.month,
        paths: paths as StepResult<State>['paths'],
        events: month.events.map(event => ({ month: month.month, kind: event.kind, title: event.title })),
      };
    },
  };
}

/** v2 的 Draws 抽样：0..999999 的 5 个整数，与 `tapeFor()` 同构 */
export function sampleV2Draw(rng: () => number): Draws {
  return {
    medical: drawMillion(rng),
    jobLoss: drawMillion(rng),
    bonusDelay: drawMillion(rng),
    marketDrop: drawMillion(rng),
    career: drawMillion(rng),
  };
}

