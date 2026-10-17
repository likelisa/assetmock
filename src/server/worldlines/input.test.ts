import { describe, expect, it } from 'vitest';
import { runInputSchema, describeIssues, worldlineValuesSchema } from './input';

const values = {
  age: 30, cash: '120000000', fund: '20000000', salary: '3000000', living: '1400000',
  rent: '400000', debt: '0', debtPayment: '0', bonus: '0',
};

describe('入参宽容度（页面把数字给成字符串也不该报错）', () => {
  it('标准请求通过', () => {
    const parsed = runInputSchema.parse({ target: 'car', sourceSignature: 'sig', values });
    expect(parsed.n).toBe(200);
    expect(parsed.months).toBeNull();
    expect(parsed.cardPlan).toBeNull();
    expect(parsed.responsePolicy).toBe('WAIT');
  });

  it('数字给成字符串也能读（n / months / seed / k / age）', () => {
    const parsed = runInputSchema.parse({
      target: 'car', sourceSignature: 'sig',
      values: { ...values, age: '30', cash: 120000000 },
      n: '400', months: '60', seed: '42', k: '4',
    });
    expect(parsed.n).toBe(400);
    expect(parsed.months).toBe(60);
    expect(parsed.seed).toBe(42);
    expect(parsed.k).toBe(4);
    expect(parsed.values.age).toBe(30);
    expect(parsed.values.cash).toBe('120000000');
  });

  it('缺 goalId / cardPlan / 应对策略也能跑', () => {
    const parsed = runInputSchema.parse({ target: 'home', sourceSignature: 'sig', values });
    expect(parsed.goalId).toBeNull();
    expect(parsed.careerPolicy).toBe('DECLINE');
  });

  it('多余字段不报错（页面以后加字段不会把用户挡在门外）', () => {
    const parsed = runInputSchema.parse({ target: 'car', sourceSignature: 'sig', values, debug: true });
    expect(parsed.target).toBe('car');
  });

  it('真正的错还是要拦，并翻译成人话', () => {
    const bad = worldlineValuesSchema.safeParse({ ...values, age: '四十五' });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(describeIssues(bad.error.issues)).toContain('年龄');

    const negative = worldlineValuesSchema.safeParse({ ...values, cash: '-1' });
    expect(negative.success).toBe(false);
    if (!negative.success) expect(describeIssues(negative.error.issues)).toContain('可动用现金');

    const tooBig = runInputSchema.safeParse({ target: 'car', sourceSignature: 'sig', values, n: '5000' });
    expect(tooBig.success).toBe(false);
    if (!tooBig.success) expect(describeIssues(tooBig.error.issues)).toContain('世界线条数');
  });

  it('金额小数会被拒绝（分必须是整数）', () => {
    const parsed = worldlineValuesSchema.safeParse({ ...values, salary: '3000000.5' });
    expect(parsed.success).toBe(false);
  });
});
