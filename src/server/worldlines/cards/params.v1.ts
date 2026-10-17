/**
 * 参数包 v1（节选）：把调研稿 §2 里已逐字核过的数落成 `facts[]` / `assumptions[]`。
 *
 * 抓取日期 2026-10-17；`quote` 是逐字摘录（正式快照还要把正文冻结到
 * `data/worldline/sources/<documentId>.txt` 再跑包含校验）。
 *
 * 规矩：
 * - 事实层只放公开统计 / 派生值，绝不放压力假设；
 * - 公开统计必须带 `sourceQuality`；第三方与智库必须在 `label` 里点名机构；
 * - 压力假设一律 `PUBLIC_STATISTIC` 之外的三档之一，且不带 url。
 */
import type { Param, WorldlineParams } from '@/domain/worldline/types';

const sn = (documentId: string, url: string, documentVersion: string, quote: string, retrievedAt = '2026-10-17') => ({
  kind: 'SNAPSHOT' as const, documentId, url, retrievedAt, documentVersion, quote,
});

const official = (key: string, value: number, unit: Param['unit'], label: string, source: ReturnType<typeof sn>): Param => ({
  key, value, unit, source, basis: 'PUBLIC_STATISTIC', sourceQuality: 'OFFICIAL', label,
});

const assume = (key: string, value: number, unit: Param['unit'], label: string): Param => ({
  key, value, unit, source: { kind: 'BUILTIN' }, basis: 'PRESS_HYPOTHESIS', label,
});

const communique2025 = sn(
  'stats-2025-communique',
  'http://cn.theorychina.org.cn/c/2026-03-01/1541680.shtml',
  '2025年统计公报（2026-02-28 发布）',
  '全年全国城镇调查失业率平均值为5.2%。',
);

export function paramPackV1(): WorldlineParams {
  return {
    version: 'params.v1',
    facts: [
      official('unemployment.rate.annual', 0.052, 'RATIO', '2025 年全国城镇调查失业率年均值 5.2%（存量口径，不是月度中断概率）', communique2025),
      official('unemployment.benefit.maxMonths', 24, 'MONTHS', '失业保险金最长领取 24 个月（缴费 1–5 年 12 个月、5–10 年 18 个月、10 年以上 24 个月）', sn('social-insurance-law', 'https://www.gov.cn/guoqing/2021-10/29/content_5647616.htm', '社会保险法（第四十六条）', '累计缴费十年以上的，领取失业保险金的期限最长为二十四个月。')),
      official('cpi.annual', 0, 'RATIO', '2025 年居民消费价格与上年持平（2024 年为 +0.2%）', sn('stats-2025-communique', 'http://cn.theorychina.org.cn/c/2026-03-01/1541680.shtml', '2025年统计公报（2026-02-28 发布）', '全年居民消费价格与上年持平。')),
      official('living.perCapita.annual', 2947600, 'CNY_MINOR', '2025 年全国居民人均消费支出 29476 元/年', sn('stats-2025-communique', 'http://cn.theorychina.org.cn/c/2026-03-01/1541680.shtml', '2025年统计公报（2026-02-28 发布）', '2025年，全国居民人均消费支出29476元，比上年名义增长4.4%')),
      official('income.perCapita.annual', 4337700, 'CNY_MINOR', '2025 年全国居民人均可支配收入 43377 元/年', sn('stats-2025-communique', 'http://cn.theorychina.org.cn/c/2026-03-01/1541680.shtml', '2025年统计公报（2026-02-28 发布）', '全年全国居民人均可支配收入43377元，比上年增长5.0%')),
      official('income.highGroup.annual', 10377800, 'CNY_MINOR', '2025 年高收入组人均可支配收入 103778 元（角色量级校准用，不用于给真实用户分层）', sn('stats-2025-communique', 'http://cn.theorychina.org.cn/c/2026-03-01/1541680.shtml', '2025年统计公报（2026-02-28 发布）', '高收入组人均可支配收入103778元')),      official('medical.oop.share', 0.275, 'RATIO', '2024 年个人卫生支出占卫生总费用 27.5%', sn('nhc-2024-communique', 'https://www.sohu.com/a/960579071_162422', '2024年我国卫生健康事业发展统计公报（解读稿）', '个人卫生支出25007.5亿元，占27.5%')),
      official('medical.hospital.stay', 987000, 'CNY_MINOR', '2024 年医院次均住院费用 9870 元', sn('nhc-2024-communique', 'https://www.sohu.com/a/960579071_162422', '2024年我国卫生健康事业发展统计公报（解读稿）', '2024年，医院次均住院费用9870.0元')),
      {
        key: 'medical.claim.amount',
        value: 0.732,
        unit: 'RATIO',
        source: sn('e-caa-reading-book', 'https://stcn.com/article/detail/4044003.html', '中国精算师协会《国民防范重大疾病健康教育读本》（证券时报引用）', '重疾赔付金额段中，73.2%集中在10万元以下'),
        basis: 'PUBLIC_STATISTIC',
        sourceQuality: 'THIRD_PARTY',
        label: '中国精算师协会读本：重疾赔付 73.2% 在 10 万元以下（第三方数据，非官方统计）',
      },
      official('market.drawdown.rounds', 0.307, 'RATIO', '沪深300 五轮熊市最大跌幅 72.3/44.3/46.7/30.7/43.6%，其中 30.7% 为最浅一轮', sn('eeo-bear-market', 'https://m.eeo.com.cn/2024/0202/634369.shtml', '经济观察网《熊市的极限》', '第四轮熊市从2018年1月到2019年1月，持续338天，最大跌幅30.7%')),
      official('market.drawdown.avg', 0.475, 'RATIO', '沪深300 五轮熊市平均跌幅 47.5%，平均持续 649 天', sn('eeo-bear-market', 'https://m.eeo.com.cn/2024/0202/634369.shtml', '经济观察网《熊市的极限》', '五轮熊市平均跌幅47.5%')),
      official('market.drawdown.days', 649, 'DIMENSIONLESS', '沪深300 五轮熊市平均持续 649 天（约 21 个月）', sn('eeo-bear-market', 'https://m.eeo.com.cn/2024/0202/634369.shtml', '经济观察网《熊市的极限》', '五轮熊市平均持续649天')),
      official('rate.lpr5y.now', 0.035, 'RATIO', '5 年期以上 LPR 3.50%（2025-05-20 起）', sn('boc-lpr-table', 'https://www.boc.cn/fimarkets/lilv/fd32/201310/t20131031_2591219.html', '中国银行 LPR 全表', '2026-09-20 1年期 3.00% 5年期以上 3.50%')),
      official('rate.lpr5y.2024', 0.042, 'RATIO', '5 年期以上 LPR 4.20%（2024-01-22）', sn('boc-lpr-table', 'https://www.boc.cn/fimarkets/lilv/fd32/201310/t20131031_2591219.html', '中国银行 LPR 全表', '2024-01-22…5年期以上 4.20%')),
      official('retire.age.male', 63, 'DIMENSIONLESS', '男职工法定退休年龄 60→63 岁（15 年渐进）', sn('npc-retirement-2024', 'https://www.spp.gov.cn/spp/tt/202409/t20240913_666042.shtml', '全国人大常委会关于实施渐进式延迟法定退休年龄的决定（2024-09-13）', '将男职工的法定退休年龄从原六十周岁延迟至六十三周岁')),
      official('retire.contribution.minYears', 20, 'DIMENSIONLESS', '养老金最低缴费年限 15→20 年（2030 起每年 +6 个月）', sn('npc-retirement-2024', 'https://www.spp.gov.cn/spp/tt/202409/t20240913_666042.shtml', '全国人大常委会关于实施渐进式延迟法定退休年龄的决定（2024-09-13）', '将职工按月领取基本养老金最低缴费年限由十五年逐步提高至二十年')),
      {
        key: 'family.cost.0to17',
        value: 53800000,
        unit: 'CNY_MINOR',
        source: sn('yuwa-birth-cost-2024', 'https://finance.sina.com.cn/jjxw/2024-02-25/doc-inakfuti3086616.shtml', '育娲人口《中国生育成本报告 2024 版》（界面新闻）', '全国家庭0-17岁孩子的养育成本平均为53.8万元'),
        basis: 'PUBLIC_STATISTIC',
        sourceQuality: 'THINK_TANK',
        label: '育娲人口估算：0–17 岁养育成本 53.8 万元（智库估算，非官方统计）',
      },
      {
        key: 'family.cost.0toCollege',
        value: 68000000,
        unit: 'CNY_MINOR',
        source: sn('yuwa-birth-cost-2024', 'https://finance.sina.com.cn/jjxw/2024-02-25/doc-inakfuti3086616.shtml', '育娲人口《中国生育成本报告 2024 版》（界面新闻）', '0岁至大学本科毕业的养育成本平均为约68万元'),
        basis: 'PUBLIC_STATISTIC',
        sourceQuality: 'THINK_TANK',
        label: '育娲人口估算：0 岁至本科毕业约 68 万元（智库估算，非官方统计）',
      },
    ],
    assumptions: [
      assume('draw.medical.monthly', 20000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定每月约有 2% 的机会出现一次大额医疗自付'),
      assume('draw.jobLoss.monthly', 2000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定每月 0.2% 的收入中断概率（约合每年 2.4%），以 5.2% 的存量失业率作数量级锚点，不等于失业率'),
      assume('draw.bonusDelay.monthly', 200000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定每笔年度奖金有 20% 的机会延期（沿用 v2 游戏设定）'),
      assume('draw.marketDrop.monthly', 50000, 'EVENTS_PER_MILLION_PER_MONTH', '我们假定有持仓的月份约有 5% 的机会出现一次投资下跌'),
      assume('draw.career.monthly', 5000, 'EVENTS_PER_MILLION_PER_MONTH', '职业机会沿用 v2 游戏设定，不额外放大'),
      assume('living.drift.base', 0, 'RATIO', '我们假定有一条世界线的生活开销不加价（对照 CPI 与 5 年 CPI 变化）'),
      assume('living.drift.plus5', 0.05, 'RATIO', '我们假定有一档世界线的生活开销长期高 5%'),
      assume('living.drift.plus12', 0.12, 'RATIO', '我们假定有一档世界线的生活开销长期高 12%'),
      assume('medical.cost.low', 5000000, 'CNY_MINOR', '常见住院自付 5 万元（压力假设；对照次均住院费用 9870 元，这是一次较重住院加自费药的口径）'),
      assume('medical.cost.mid', 10000000, 'CNY_MINOR', '大病自付中档 10 万元（压力假设；参考重疾赔付 73.2% 在 10 万元以下，不是 22–80 万区间下沿）'),
      assume('medical.cost.high', 20000000, 'CNY_MINOR', '大病自付高档 20 万元（压力假设；参考 20 万元以上仅占 8.2% 的尾部，与 22–80 万区间不可混称）'),
      assume('market.dropRate.shallow', 0.15, 'RATIO', '单月下跌 15% 一档（压力假设；整轮熊市最浅一轮为 30.7%，单月幅度按整轮的 1/3–1/2 缩放）'),
      assume('market.dropRate.baseline', 0.2, 'RATIO', '单月下跌 20% 一档，沿用 v2 游戏的现值'),
      assume('market.dropRate.deep', 0.3, 'RATIO', '单月下跌 30% 一档（压力假设；与历史上最浅一轮熊市的整轮跌幅 30.7% 对齐）'),
      assume('market.dropRate.crash', 0.45, 'RATIO', '单月下跌 45% 一档（压力假设；接近五轮熊市平均跌幅 47.5%，属尾部档）'),
      assume('rate.addon', 0, 'RATIO', '本版不放款加点：放款月 LPR 即为名义利率（将来按城市档加分位）'),
      assume('jobLoss.recovery.wait', 6, 'MONTHS', '我们假定"继续找原薪工作"要 6 个月恢复（v2 现值，无公开统计支撑）'),
    ],
  };
}
