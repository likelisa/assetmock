/**
 * 内核：把一条 tape 跑成一条世界线（通用循环，不认识业务）。
 *
 * 只做四件事：
 *   1. driver.init(setup)
 *   2. 逐月 driver.step(state, tape[t], setup)
 *   3. 把每策略的可用资金按同一口径记下来（失败月 = -缺口，之后沿用）
 *   4. 用统一标量算 band
 */
import type { StepDriver } from './driver';
import { bandOf, minOf } from './scalars';
import type { LineEvent, Minor, StrategyId, StrategyLine } from './types';

export interface RunLineParams<TState, TDraws, TSetup> {
  driver: StepDriver<TState, TDraws, TSetup>;
  /** 该世界线自己的 setup（含参数覆盖与开销档） */
  setup: TSetup;
  tape: TDraws[];
}

export interface RunLineOutcome {
  strategies: Record<StrategyId, StrategyLine>;
  events: LineEvent[];
}

export function runLine<TState, TDraws, TSetup>({ driver, setup, tape }: RunLineParams<TState, TDraws, TSetup>): RunLineOutcome {
  const months = tape.length;
  if (!months) throw new Error('世界线的 tape 不能为空');
  const ids = driver.strategyIds;
  const specs = driver.describe(setup);

  const usable = Object.fromEntries(ids.map(id => [id, [] as Minor[]])) as Record<StrategyId, Minor[]>;
  const firstShortfall = Object.fromEntries(ids.map(id => [id, null])) as Record<StrategyId, StrategyLine['firstShortfall']>;
  const events: LineEvent[] = [];

  let state = driver.init(setup);
  for (let t = 0; t < months; t++) {
    if (!driver.alive(state)) break;
    const result = driver.step(state, tape[t], setup);
    for (const id of ids) {
      const month = result.paths[id];
      if (!month) throw new Error(`驱动没有返回策略 ${id} 的当月结果`);
      if (month.settledUsable !== null) {
        usable[id].push(month.settledUsable);
        continue;
      }
      if (month.status === 'failed' && month.failure) {
        // 失败当月：可用资金 = -缺口（等于"现金+投资全砸进去后仍差的数"）
        usable[id].push(-month.failure.shortfall);
        firstShortfall[id] = { month: month.failure.month, amountMinor: month.failure.shortfall };
        continue;
      }
      // 早已结束的策略：沿用上一笔，保持逐月数组等长，分布口径才一致
      usable[id].push(usable[id].length ? usable[id][usable[id].length - 1] : 0);
    }
    events.push(...result.events);
    state = result.state;
  }

  const strategies = {} as Record<StrategyId, StrategyLine>;
  for (const spec of specs) {
    const minUsable = minOf(usable[spec.id]);
    strategies[spec.id] = {
      strategyId: spec.id,
      label: spec.label,
      months: usable[spec.id].length,
      usable: usable[spec.id],
      minUsable,
      endUsable: usable[spec.id].length ? usable[spec.id][usable[spec.id].length - 1] : null,
      status: firstShortfall[spec.id] ? 'failed' : 'completed',
      firstShortfall: firstShortfall[spec.id],
      floorMinor: spec.floorMinor,
      band: bandOf(minUsable, spec.floorMinor),
    };
  }
  return { strategies, events };
}
