/**
 * 可复现随机源。**不许** 用 Math.random()。
 *
 * 契约：
 * - 第 i 条世界线的种子只依赖 (seed, i) ⇒ 改变 N 不改变前 N 条（增量稳定）。
 * - 同一 (seed, i) 产生的"开销档 + tape"序列固定，因此任何一条线都能单独重算。
 */

/** 32 位种子 PRNG，返回 [0,1) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 第 i 条世界线的种子。7919 是质数，避免相邻种子的相关性。 */
export function lineSeed(seed: number, index: number): number {
  return (seed + index * 7919) >>> 0;
}

/** 0..999999 的整数（与 v2 的 Draws 取值域一致，适配器也按这个域生成） */
export function drawMillion(rng: () => number): number {
  return Math.floor(rng() * 1000000);
}

/** 按权重抽一项，weight 必须为正整数 */
export function pickWeighted<T extends { weight: number }>(rng: () => number, options: readonly T[]): T {
  if (!options.length) throw new Error('权重抽样缺少候选');
  const total = options.reduce((sum, option) => {
    if (!Number.isInteger(option.weight) || option.weight <= 0) throw new Error('权重必须是正整数');
    return sum + option.weight;
  }, 0);
  let ticket = rng() * total;
  for (const option of options) {
    ticket -= option.weight;
    if (ticket < 0) return option;
  }
  return options[options.length - 1];
}
