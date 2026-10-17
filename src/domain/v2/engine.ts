import { customPhase } from './custom';
import { multiply, repayment } from '../money';
import { ids, type Balance, type Choice, type Draws, type Employment, type Month, type Pending, type Run, type Selection, type Setup, type State } from './types';
export const funds = (p: Pick<Balance, 'cash' | 'fund'>) => p.cash + p.fund;
const worth = (p: Balance) => p.cash + p.fund + p.asset - p.debt - p.loan;
export const quietDraws = (): Draws => ({ medical: 999999, jobLoss: 999999, bonusDelay: 999999, marketDrop: 999999, career: 999999 });
export const choiceLabels: Record<Choice, string> = { lower: '接受降薪工作', wait: '继续寻找原薪工作', temporary: '临时工作过渡', accept: '接受职业机会', decline: '维持现状' };
export function initialState(setup: Setup): State {
  const p = setup.profile;
  const paths = {} as State['paths'];
  for (const id of ids) {
    const plan = setup.plans[id];
    const paid = plan.down + (plan.method === 'full' ? 0 : plan.offer.fee);
    const path: Balance = { cash: p.cash - paid, fund: p.fund, asset: setup.input.price, debt: p.debt, loan: plan.principal, paid, netWorth: 0, lastMonth: 0, status: 'running', employment: { salary: p.salary, livingExtra: 0, jobEligible: 1, careerEligible: 1 } };
    path.netWorth = worth(path); assertBalance(path); paths[id] = path;
  }
  return { month: 0, paths, life: { medicalUntil: 0, medicalEligible: 1, bonusDue: 4, bonusOriginal: 4 } };
}
export function assertBalance(p: Balance) {
  if ([p.cash, p.fund, p.asset, p.debt, p.loan, p.paid, p.employment.salary].some(n => !Number.isSafeInteger(n) || n < 0) || p.netWorth !== worth(p)) throw new Error('v0.2账目不变量失败');
}
export function employmentAt(previous: Employment, month: number, setup: Setup): Employment {
  const e = structuredClone(previous);
  if (e.promotion && month >= e.promotion.month) { e.salary = e.promotion.salary; e.livingExtra += 50000; delete e.promotion; }
  if (e.job) {
    const recovery = e.job.month + (e.job.choice === 'lower' ? 3 : 6);
    if (month >= recovery) { e.salary = multiply(e.job.salary, e.job.choice === 'lower' ? '0.8' : '1'); e.jobEligible = recovery + setup.rules.jobCooldown; delete e.job; }
  }
  return e;
}
export function salaryAt(e: Employment, month: number): number {
  if (!e.job) return e.salary;
  return e.job.choice === 'temporary' && month >= e.job.month + 3 ? multiply(e.job.salary, '0.4') : 0;
}
export function reveal(state: State, draws: Draws, setup: Setup): Pending {
  if (Object.values(draws).length !== 5 || Object.values(draws).some(n => !Number.isInteger(n) || n < 0 || n >= 1000000)) throw new Error('随机记录无效');
  const month = state.month + 1, r = setup.rules;
  const result: Pending = { month, events: [], decisions: [], notices: [] };
  const active = ids.filter(id => state.paths[id].status === 'running');
  if (month >= state.life.medicalEligible && draws.medical < r.probabilities.medical) result.events.push({ kind: 'medical', paths: active, title: '大额医疗支出' });
  if (setup.profile.bonus > 0 && month === state.life.bonusOriginal && draws.bonusDelay < r.probabilities.bonusDelay) result.events.push({ kind: 'bonusDelay', paths: active, title: '年度奖金延期三个月' });
  const exposed = active.filter(id => state.paths[id].fund > 0);
  if (exposed.length && draws.marketDrop < r.probabilities.marketDrop) result.events.push({ kind: 'marketDrop', paths: exposed, title: '投资账户下跌' });
  const jobPaths = active.filter(id => { const e = employmentAt(state.paths[id].employment, month, setup); return !e.job && month >= e.jobEligible; });
  const lost = draws.jobLoss < r.probabilities.jobLoss ? jobPaths : [];
  if (lost.length) { result.events.push({ kind: 'jobLoss', paths: lost, title: '收入中断，需要选择求职方式' }); lost.forEach(path => result.decisions.push({ path, kind: 'jobLoss', options: ['lower', 'wait', 'temporary'] })); }
  const careers = active.filter(id => { const e = employmentAt(state.paths[id].employment, month, setup); return !lost.includes(id) && !e.job && month >= e.careerEligible; });
  if (careers.length && draws.career < r.probabilities.career) { result.events.push({ kind: 'career', paths: careers, title: '新的职业机会' }); careers.forEach(path => result.decisions.push({ path, kind: 'career', options: ['accept', 'decline'] })); }
  result.events.forEach(event => { const unaffected = active.filter(id => !event.paths.includes(id)); if (unaffected.length) result.notices.push(`${event.title}：${unaffected.map(id => id.toUpperCase()).join('、')}路径因当前资格或持仓不同而未受影响。`); });
  return result;
}
export function settle(state: State, pending: Pending, selections: Selection[], setup: Setup): Month {
  const month = pending.month;
  if (month !== state.month + 1 || month > setup.rules.months) throw new Error('结算月份无效');
  if (selections.length !== pending.decisions.length || pending.decisions.some(d => selections.filter(s => s.path === d.path && s.kind === d.kind && d.options.includes(s.choice)).length !== 1)) throw new Error('请完成全部有效路径的选择');
  const life = { ...state.life };
  if (pending.events.some(e => e.kind === 'medical')) { life.medicalUntil = month + setup.rules.medicalDuration; life.medicalEligible = month + setup.rules.medicalCooldown; }
  if (pending.events.some(e => e.kind === 'bonusDelay')) life.bonusDue = month + 3;
  const bonus = month === life.bonusDue ? setup.profile.bonus : 0;
  if (month === life.bonusDue) { life.bonusOriginal += 12; life.bonusDue = life.bonusOriginal; }
  const result: Month = { month, events: pending.events, choices: selections.map(s => ({ ...s, month })), life, paths: {} as Month['paths'], milestones: [] };
  for (const id of ids) {
    const settled = settlePath(state.paths[id], id, month, pending, selections, setup, bonus);
    result.paths[id] = settled.path; result.milestones.push(...settled.milestones);
  }
  return result;
}
function settlePath(before: Balance, id: 'a' | 'b', month: number, pending: Pending, selections: Selection[], setup: Setup, bonus: number): { path: Month['paths']['a']; milestones: string[] } {
  const milestones: string[] = [];
    if (before.status !== 'running') return { path: { state: structuredClone(before), ledger: null }, milestones };
    const p = structuredClone(before), plan = setup.plans[id];
    p.employment = employmentAt(p.employment, month, setup);
    if (before.employment.job && !p.employment.job) milestones.push(`${id.toUpperCase()}路径重新就业`);
    for (const selected of selections.filter(s => s.path === id)) {
      if (selected.kind === 'jobLoss') p.employment.job = { month, salary: p.employment.salary, choice: selected.choice };
      if (selected.kind === 'career') {
        p.employment.careerEligible = month + setup.rules.careerCooldown;
        if (selected.choice === 'accept') p.employment.promotion = { month: month + 1, salary: multiply(p.employment.salary, '1.1') };
      }
    }
    const affected = (kind: string) => pending.events.some(e => e.kind === kind && e.paths.includes(id));
    const loan = repayment(p.loan, plan.offer.annualRate, plan.payment, month === plan.term);
    const phase = setup.input.custom ? customPhase(setup.input.custom, id === 'a' ? 0 : 1, month) : undefined;
    const ledger = { salary: phase ? phase.income : salaryAt(p.employment, month), bonus, living: setup.profile.living - (setup.input.custom ? 0 : setup.profile.rent) + p.employment.livingExtra, running: phase ? phase.extraExpense : setup.runningCost,
      medical: affected('medical') ? setup.rules.medicalCost : 0, debtPrincipal: Math.min(p.debt, setup.profile.debtPayment), loanPrincipal: loan.principal, interest: loan.interest,
      fundLoss: affected('marketDrop') ? multiply(p.fund, setup.rules.marketDropRate) : 0, fundSale: 0, depreciation: Math.min(p.asset, setup.depreciation) };
    p.fund -= ledger.fundLoss;
    const cash = p.cash + ledger.salary + ledger.bonus - ledger.living - ledger.running - ledger.medical - ledger.debtPrincipal - loan.total;
    const needed = Math.max(0, -cash);
    if (needed > p.fund) {
      milestones.push(`${id.toUpperCase()}路径资金不足`);
      return { path: { state: { ...structuredClone(before), status: 'failed', failure: { month, shortfall: needed - p.fund } }, ledger: null }, milestones };
    }
    ledger.fundSale = needed; p.fund -= needed; p.cash = cash + needed;
    p.loan -= loan.principal; p.debt -= ledger.debtPrincipal; p.asset -= ledger.depreciation;
    p.paid += loan.total + (phase ? phase.extraExpense : 0); p.lastMonth = month; p.netWorth = worth(p);
    if (before.loan > 0 && p.loan === 0) { p.paidOffMonth = month; milestones.push(`${id.toUpperCase()}路径贷款还清`); }
    if (month === setup.rules.months) p.status = 'completed';
    assertBalance(p);
    const expected = ledger.salary + ledger.bonus - ledger.living - ledger.running - ledger.medical - ledger.interest - ledger.fundLoss - ledger.depreciation;
    if (p.netWorth - before.netWorth !== expected) throw new Error('账目变动无法复算');
    return { path: { state: p, ledger }, milestones };
}

export function stateOf(m: Month): State { return { month: m.month, life: m.life, paths: { a: m.paths.a.state, b: m.paths.b.state } }; }
export function nextBoundary(run: Pick<Run, 'state' | 'setup'>): number {
  const m = run.state.month;
  const active = ids.filter(id => run.state.paths[id].status === 'running');
  if (m + 1 < run.state.life.medicalUntil || active.some(id => !!run.state.paths[id].employment.job)) return Math.min(m + 1, run.setup.rules.months);
  if (run.setup.input.custom) return Math.min(m+1,run.setup.rules.months);
  let next: number;
  if (run.setup.input.target === 'car' && m < 3) next = m + 1;
  else if (m < 12) next = (Math.floor(m / 3) + 1) * 3;
  else if (m < 60) next = (Math.floor(m / 12) + 1) * 12;
  else next = (Math.floor(m / 60) + 1) * 60;
  return Math.min(next, run.setup.rules.months);
}
export function commitMonth(run: Run, pending: Pending, choices: Selection[]) {
  const month = settle(run.state, pending, choices, run.setup);
  month.choices = month.choices.map(c => ({ ...c, inherited: run.inherited.some(x => x.month === c.month && x.path === c.path && x.kind === c.kind && x.choice === c.choice) }));
  run.history.push(month); run.state = stateOf(month); delete run.pending;
  run.status = ids.every(id => run.state.paths[id].status !== 'running') ? 'ended' : 'running';
  return month;
}
export function advance(run: Run, single = false) {
  if (run.status !== 'running') throw new Error('当前状态不能推进');
  run.stageStart = run.state.month;
  const target = single ? run.state.month + 1 : nextBoundary(run);
  do {
    const pending = reveal(run.state, run.tape[run.state.month], run.setup);
    const old = run.inherited.filter(c => c.month === pending.month);
    const skipped = old.filter(c => !pending.decisions.some(d => d.path === c.path && d.kind === c.kind && d.options.includes(c.choice)));
    skipped.forEach(c => run.notices.push(`第${c.month}月${c.path.toUpperCase()}路径的历史选择不再适用，未自动执行。`));
    if (pending.decisions.length) {
      const inherited = pending.decisions.map(d => old.find(c => c.path === d.path && c.kind === d.kind && d.options.includes(c.choice)));
      if (inherited.every(c => c !== undefined)) { commitMonth(run, pending, inherited); run.stopReason = '沿用了本月有效的历史选择'; break; }
      if (old.length) pending.notices.push('部分历史选择无法沿用，请重新确认本月全部有效路径。');
      run.pending = pending; run.status = 'waiting'; run.stopReason = '遇到关键选择'; break;
    }
    const m = commitMonth(run, pending, []);
    run.stopReason = m.milestones.join('；') || (m.events.length ? '遇到人生事件' : '到达阶段节点');
    if (m.events.length || m.milestones.length || ids.every(id => run.state.paths[id].status !== 'running')) break;
  } while (run.state.month < target);
  run.version++;
}
export function choose(run: Run, selections: Selection[]) {
  if (run.status !== 'waiting' || !run.pending) throw new Error('当前没有待处理选择');
  run.stageStart = run.state.month;
  commitMonth(run, run.pending, selections); run.stopReason = '选择已生效，本月已结算'; run.version++;
}
