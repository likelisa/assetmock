import { money } from '../money';
import type { Fact } from '../types';
import { choiceLabels, funds, nextBoundary, quietDraws, reveal, settle, stateOf } from './engine';
import { ids, type Month, type PublicRun, type Run, type Selection, type Trial } from './types';
export function stageFacts(run: Run, from: number, to = run.state.month): Fact[] {
  const facts: Fact[] = [];
  if (from === to) return [{ id: 'stage:opening', text: `本阶段尚未结算新的月份，现有账目截至第${to}月，等待下一步选择或推进。` }];
  for (const id of ids) {
    const months = run.history.filter(m => m.month > from && m.month <= to);
    const end = to === 0 ? run.initial.paths[id] : run.history[to - 1].paths[id].state;
    const start = from === 0 ? run.initial.paths[id] : run.history[from - 1].paths[id].state;
    const ledgers = months.flatMap(m => m.paths[id].ledger ? [m.paths[id].ledger!] : []);
    const income = ledgers.reduce((v, l) => v + l.salary + l.bonus, 0);
    const expense = ledgers.reduce((v, l) => v + l.living + l.running + l.medical, 0);
    const investmentLoss = ledgers.reduce((v, l) => v + l.fundLoss, 0);
    const repaid = ledgers.reduce((v, l) => v + l.debtPrincipal + l.loanPrincipal + l.interest, 0);
    facts.push({ id: `stage:${from}:${to}:${id}`, text: `${id.toUpperCase()} ${run.setup.plans[id].label}：第${from + 1}至${to}月成功结算部分，收入${money(income)}元，生活及持有、医疗支出${money(expense)}元，还款${money(repaid)}元，投资损失${money(investmentLoss)}元；剩余资金变化${money(funds(end) - funds(start))}元。余额截至第${end.lastMonth}月。` });
  }
  return facts;
}
export function trials(run: Run): Trial[] {
  if (!run.pending) return [];
  const pending = run.pending;
  return pending.decisions.flatMap(d => d.options.map(choice => {
    const choices: Selection[] = pending.decisions.map(other => ({ path: other.path, kind: other.kind, choice: other === d ? choice : other.options[0] }));
    let state = structuredClone(run.state);
    let end: Month | undefined;
    for (let i = 0; i < 6 && state.month < run.setup.rules.months; i++) {
      const p = i === 0 ? pending : reveal(state, quietDraws(), run.setup);
      end = settle(state, p, i === 0 ? choices : [], run.setup); state = stateOf(end);
    }
    const balance = end!.paths[d.path].state;
    return { path: d.path, choice, funds: funds(balance), lastMonth: balance.lastMonth, failureMonth: balance.failure?.month };
  }));
}
export function toPublic(run: Run): PublicRun {
  const commonMonth = Math.min(...ids.map(id => run.state.paths[id].lastMonth));
  const common = commonMonth ? run.history[commonMonth - 1].paths : { a: { state: run.initial.paths.a }, b: { state: run.initial.paths.b } };
  const summaryFacts: Fact[] = ids.map(id => ({ id: `ending:${id}`, text: `${id.toUpperCase()} ${run.setup.plans[id].label}，截至第${run.state.paths[id].lastMonth}月：剩余资金${money(funds(run.state.paths[id]))}元，负债${money(run.state.paths[id].loan + run.state.paths[id].debt)}元，${run.setup.input.custom ? '行动累计支出' : '购置累计支付'}${money(run.state.paths[id].paid)}元。${run.state.paths[id].failure ? `第${run.state.paths[id].failure!.month}月资金不足。` : ''}` }));
  summaryFacts.push({ id: 'comparison:common', text: `共同成功月份为第${commonMonth}月，A减B剩余资金差${money(funds(common.a.state) - funds(common.b.state))}元；剩余资金未扣负债，不是净资产或收益。` });
  summaryFacts.push({ id: 'comparison:payments', text: `${run.setup.input.custom ? '两种行动的初始投入' : '开局付款方式'}：A开局支付${money(run.initial.paths.a.paid)}元，B开局支付${money(run.initial.paths.b.paid)}元；${run.setup.input.custom ? '后续阶段收入与额外支出继续改变剩余资金。' : '后续本金偿还和利息会继续改变剩余资金。'}` });
  const choices = run.history.flatMap(m => m.choices);
  summaryFacts.push({ id: 'comparison:choices', text: choices.length ? `后续选择记录：${choices.map(c => `第${c.month}月${c.path.toUpperCase()}选择${choiceLabels[c.choice]}`).join('；')}。后续选择不同时，期末差异不能全部归因于付款方式。` : run.setup.input.custom ? '本局按确认的行动阶段结算，差异来自初始投入、阶段收入及支出；医疗和市场事件使用相同外部经历。' : '本局尚无后续职业选择，变化来自购置、日常收支及已揭晓事件。' });
  const facts = stageFacts(run, run.stageStart);
  const trialResults = trials(run);
  if (run.pending) {
    facts.push({ id: 'pending:events', text: `第${run.pending.month}月待选择，尚未结算：${run.pending.events.map(e => e.title).join('、')}。` });
    trialResults.forEach(t => facts.push({ id: `trial:${t.path}:${t.choice}`, text: `${t.path.toUpperCase()}选择${choiceLabels[t.choice]}（${{ lower: '停薪3个月，之后工资固定为原工资80%', wait: '停薪6个月，之后恢复原工资', temporary: '停薪3个月，再3个月固定领取原工资40%，之后恢复原工资', accept: '下月工资增加10%，生活费增加500元', decline: '工资与支出维持现状' }[t.choice]}），已知本月事件并假设之后没有新事件的六个月试算：截至第${t.lastMonth}月剩余资金${money(t.funds)}元${t.failureMonth ? `，第${t.failureMonth}月资金不足` : ''}；不是未来保证。` }));
  }
  return { source: run.setup.source, schemaVersion: 2, id: run.id, version: run.version, input: run.setup.input, profile: run.setup.profile, plans: run.setup.plans, rules: run.setup.rules, month: run.state.month,
    totalMonths: run.setup.rules.months, status: run.status, paths: run.state.paths, pending: run.pending, trials: trialResults, history: run.history,
    timeline: [{ month: 0, a: funds(run.initial.paths.a), b: funds(run.initial.paths.b) }, ...run.history.map(m => ({ month: m.month, a: m.paths.a.ledger ? funds(m.paths.a.state) : null, b: m.paths.b.ledger ? funds(m.paths.b.state) : null }))],
    annual: run.history.filter(m => m.month % 12 === 0).map(m => ({ year: m.month / 12, facts: stageFacts(run, m.month - 12, m.month) })),
    facts, stageStart: run.stageStart, stopReason: run.stopReason, notices: run.notices, nextMonth: nextBoundary(run), summary: { commonMonth, difference: funds(common.a.state) - funds(common.b.state), facts: summaryFacts } };
}
