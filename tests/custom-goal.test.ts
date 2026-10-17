import { describe,it,expect } from 'vitest';
import { calculate,defaultInput,inputSchema } from '../src/domain/v2/setup';
import { initialState,reveal,settle,stateOf,quietDraws } from '../src/domain/v2/engine';
import type { Input } from '../src/domain/v2/types';
function example():Input{return {...defaultInput('car'),price:0,custom:{goal:'裸辞半年与边工作边找机会',months:12,assumptions:['第7月恢复收入仅为假设'],actions:[{name:'裸辞半年',upfront:100000,phases:[{months:6,income:0,extraExpense:10000},{months:6,income:1800000,extraExpense:0}]},{name:'边工作边寻找',upfront:0,phases:[{months:12,income:1800000,extraExpense:0}]}]}};}
describe('自定义行动目标',()=>{
 it('逐月使用阶段收入，保持原生活费，没有车辆支出与贷款，累计支付可核对',()=>{
  const {setup,errors}=calculate(example(),[]);expect(errors).toEqual([]);let state=initialState(setup);
  for(let i=1;i<=12;i++){const result=settle(state,reveal(state,quietDraws(),setup),[],setup);expect(result.paths.a.ledger!.salary).toBe(i<=6?0:1800000);state=stateOf(result);}
  expect(state.paths.a.cash).toBe(26000000-100000-60000);expect(state.paths.b.cash).toBe(26000000+10800000);expect(state.paths.a.paid).toBe(160000);expect(state.paths.a.loan).toBe(0);expect(state.paths.a.asset).toBe(0);
 });
 it('拒绝不覆盖整个观察期的阶段、负金额以及超过安全范围的金额',()=>{for(const patch of [{months:7},{income:-1},{extraExpense:1e15}]){const input=example();Object.assign(input.custom!.actions[0].phases[0],patch);expect(inputSchema.safeParse(input).success).toBe(false);}});
 it('不会叠加随机失业、职业机会和年度奖金；医疗与市场仍共享抽取',()=>{const {setup}=calculate(example(),[]);const state=initialState(setup);const p=reveal(state,{medical:0,jobLoss:0,career:0,marketDrop:0,bonusDelay:0},setup);expect(p.decisions).toEqual([]);expect(p.events.map(e=>e.kind)).toEqual(['medical','marketDrop']);expect(setup.profile.bonus).toBe(0);});
 it('现金不足时阻止开局',()=>{const input=example();input.custom!.actions[0].upfront=30000000;expect(calculate(input,[]).errors.length).toBe(1);});
 it('逐分重算且旧购车规则仍为60个月',()=>{expect(calculate(example(),[])).toEqual(calculate(example(),[]));expect(defaultInput('car').custom).toBeUndefined();});
 it('同月医疗使一条路径失败时，不提交失败财务快照，另一条继续',()=>{const input=example();input.custom!.actions[0].upfront=25000000;const {setup}=calculate(input,[]);const state=initialState(setup);const pending=reveal(state,{...quietDraws(),medical:0},setup);const result=settle(state,pending,[],setup);expect(result.paths.a.state.status).toBe('failed');expect(result.paths.a.ledger).toBeNull();expect(result.paths.a.state.cash).toBe(state.paths.a.cash);expect(result.paths.b.state.lastMonth).toBe(1);});
 it('当前底账租金不会因自定义行动被移除',()=>{const input=example();const original=calculate(input,[]).setup;original.profile.rent=350000;const {setup}=calculate(input,[],original);const state=initialState(setup);expect(settle(state,reveal(state,quietDraws(),setup),[],setup).paths.a.ledger!.living).toBe(original.profile.living);});

});
