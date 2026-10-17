/**
 * 仅准备代码/测试用的 Setup 构造。
 *
 * 正式并入时**不要**用这个文件：真实入口是
 *   `server/simulations/opening.ts` 的 frozenOpening → `domain/v2/setup.ts` 的 calculate()
 * （它带底账来源、排除原因、金额分与用户确认）。
 * 这里只是让内核在没有数据库的情况下能跑测试与演示。
 */
import { initialState } from '@/domain/v2/engine';
import { calculate } from '@/domain/v2/setup';
import type { Run, Setup, Target } from '@/domain/v2/types';
import type { LoanOffer } from '@/domain/types';

export const demoOffer: LoanOffer = {
  id: 'loan-a',
  name: '示例贷款（5.8% 名义年化）',
  defaultDownPaymentPercent: 30,
  defaultTermMonths: 36,
  annualRate: '0.058',
  fee: 0,
  documentId: 'prep-demo',
  documentVersion: '1',
  sourceType: 'preset_fixture',
  excerpt: '仅用于准备代码的示例参数，不代表真实报价。',
};

/** 全款 + 低首付贷款：与项目默认对比一致 */
export function demoSetup(profileId = 'GAME-U01', target: Target = 'car', priceMinor = 20000000): Setup {
  const term = target === 'car' ? 36 : 360;
  const { setup, errors } = calculate(
    {
      target,
      profileId,
      price: priceMinor,
      paths: [
        { method: 'full', downPercent: 80, term, offerId: demoOffer.id },
        { method: 'low', downPercent: 30, term, offerId: demoOffer.id },
      ],
    },
    [demoOffer],
  );
  if (errors.length) throw new Error(`demo setup 不成立：${errors.join(' ')}`);
  return setup;
}

/**
 * 与 `src/server/v2/store.ts` 的 `makeRun()` 同构（纯数据，8 行）。
 * 有意不 import 那个文件：它把 better-sqlite3 拖进依赖图。
 */
export function makeRunLike(setup: Setup, tape: Run['tape'], sessionId = 'prep'): Run {
  const initial = initialState(setup);
  return {
    schemaVersion: 2,
    id: 'prep-run',
    sessionId,
    createdAt: new Date(0).toISOString(),
    setup,
    tape,
    initial,
    state: initial,
    history: [],
    version: 0,
    status: 'running',
    inherited: [],
    notices: [],
    stageStart: 0,
    stopReason: '',
  };
}
