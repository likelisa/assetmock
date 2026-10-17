import { describe, expect, it } from "vitest";
import * as serverRenderer from "react-dom/server";
import { PlanningHub, type HubTab } from "./planning-hub";
import type { FuturePlanningResult, PlanningResult } from "./agent-views";

const render = serverRenderer.renderToStaticMarkup ?? serverRenderer.renderToString;

const planning: PlanningResult = {
  id: "plan-1", sourceRevision: 3, isStale: false, mode: "OPENAI", model: "test-model",
  selectedPlanKey: "A", recommendedPlanKey: "A", createdAt: "2026-09-21T00:00:00.000Z", goalId: "goal-1", goalName: "三年后购房",
  plans: [{
    key: "A", name: "目标优先", principle: "PRIORITY", targetDate: "2029-09-01",
    targetAmountMinor: "50000000", monthlyContributionMinor: "800000", monthlyCashflowAfterContributionMinor: "200000",
    immediateReserveGapMinor: "0", projectedAmountMinor: "50000000", projectedGapMinor: "0",
    feasibility: "FEASIBLE", summary: "优先满足目标", gain: "目标确定性最高", sacrifice: "日常结余偏紧",
  }, {
    key: "B", name: "平衡方案", principle: "BALANCE", targetDate: "2029-09-01",
    targetAmountMinor: "45000000", monthlyContributionMinor: "600000", monthlyCashflowAfterContributionMinor: "400000",
    immediateReserveGapMinor: "0", projectedAmountMinor: "45000000", projectedGapMinor: "0",
    feasibility: "FEASIBLE", summary: "兼顾目标和现金流", gain: "保留日常余量", sacrifice: "目标预算需要调整",
  }, {
    key: "C", name: "安全优先", principle: "SAFETY", targetDate: "2030-09-01",
    targetAmountMinor: "50000000", monthlyContributionMinor: "400000", monthlyCashflowAfterContributionMinor: "600000",
    immediateReserveGapMinor: "0", projectedAmountMinor: "50000000", projectedGapMinor: "0",
    feasibility: "FEASIBLE", summary: "优先保障现金流", gain: "安全空间更充足", sacrifice: "目标时间延后",
  }],
};


const futurePlanning: FuturePlanningResult = {
  id: "report-1", goalId: "goal-1", planSetId: "plan-1", planKey: "A", sourceRevision: 3, isStale: false,
  mode: "OPENAI", model: "test-model", promptVersion: "future-planning-action-v2", informationCompleteness: "BASIC",
  reportText: "未来规划行动清单", adoptedAt: null, createdAt: "2026-09-22T00:00:00.000Z",
  report: {
    information_completeness: "BASIC", summary: "按目标优先方案推进。", assumptions: ["暂不计投资收益"],
    risks: [{ id: "cashflow", title: "现金流偏紧", reason: "每月投入较高", impact: "日常余量减少", direction: "保留必要缓冲" }],
    actions: [{ id: "confirm_budget", priority: "P0", title: "确认目标预算", reason: "锁定执行范围", steps: ["核对目标金额"], amount: null, currency: "CNY", due_in_days: 14, prerequisites: [], completion_criteria: "预算已书面确认", verification_required: "更新目标底账" }],
    missing_information: [], disclaimer: "本规划用于资产整理与目标规划参考，不构成投资建议。",
  },
};

function hub(tab: HubTab, options: { workspaceId?: string; activeGoal?: boolean; assessmentCurrent?: boolean; futurePlanning?: FuturePlanningResult | null } = {}) {
  const activeGoal = options.activeGoal ?? true;
  const assessmentCurrent = options.assessmentCurrent ?? true;
  return <PlanningHub
    planning={planning}
    planningLoading={false}
    hasGoals
    onGeneratePlans={() => {}}
    onSelectPlan={() => {}}
    onGoToAgent={() => {}}
    futurePlanning={options.futurePlanning ?? null}
    futurePlanningLoading={false}
    futurePlanningAdopting={false}
    onGenerateFuturePlanning={() => {}}
    onAdoptFuturePlanning={() => {}}
    onViewExecution={() => {}}
    workspaceId={options.workspaceId}
    activeGoal={activeGoal ? { id: "goal-1", name: "三年后购房" } : null}
    assessmentCurrent={assessmentCurrent}
    onGoToAssessment={() => {}}
    initialTab={tab}
  />;
}

describe("planning hub", () => {
  it("keeps the future-planning sections reachable from one page", () => {
    const html = render(hub("plans"));
    for (const label of ["方案比较", "世界线对比"]) expect(html).toContain(label);
    expect(html).not.toContain("持续财富任务");
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).not.toContain("行动计划");
    expect(html.match(/<h1/g) ?? []).toHaveLength(1);
  });

  it("renders the plan comparison and worldline entry", () => {
    const planHtml = render(hub("plans"));
    expect(planHtml).toContain("比较三条路径");
    expect(planHtml).toContain("当前目标");
    expect(planHtml).toContain("三年后购房");
    expect(planHtml).toContain("系统推荐");
    expect(planHtml).toContain("查看其他方案（2）");
    expect(planHtml).not.toContain("平衡方案");
    const scenarioHtml = render(hub("scenarios", {workspaceId:"test-workspace"}));
    expect(scenarioHtml).toContain("世界线对比");
    expect(scenarioHtml).toContain("正在读取当前底账");
    expect(scenarioHtml).not.toContain("未来可能性推演");
  });

  it("blocks planning until a goal is selected and a current assessment exists", () => {
    expect(render(hub("plans", { activeGoal: false }))).toContain("先选择一个人生目标");
    const assessmentGate = render(hub("plans", { assessmentCurrent: false }));
    expect(assessmentGate).toContain("先完成现状评估");
    expect(assessmentGate).toContain("前往现状评估");
    expect(assessmentGate).not.toContain("生成 Plan A / B / C");
  });

  it("renders the structured three-month action preview", () => {
    const html = render(hub("plans", { futurePlanning }));
    expect(html).toContain("未来3个月");
    expect(html).toContain("确认目标预算");
    expect(html).toContain("预算已书面确认");
    expect(html).toContain("重新生成清单");
    expect(html).toContain("采用此方案并开始执行");
  });

  it("groups numbers throughout the action report", () => {
    const report = futurePlanning.report!;
    const formatted = {
      ...futurePlanning,
      report: {
        ...report,
        summary: "目标1000000元",
        actions: [{ ...report.actions[0], title: "准备12000元", reason: "还差345000元", steps: ["每月存入12000元"], completion_criteria: "累计120000元" }],
        risks: [{ ...report.risks[0], impact: "可能需要23000元", direction: "预留35000元" }],
        assumptions: ["预计收入200000元"],
        missing_information: [{ field: "budget", question: "预算是否为1000000元？", why_needed: "确认1000000元目标" }],
      },
    } satisfies FuturePlanningResult;
    const html = render(hub("plans", { futurePlanning: formatted }));
    for (const amount of ["1,000,000", "12,000", "345,000", "120,000", "23,000", "35,000", "200,000"]) {
      expect(html).toContain(amount);
    }
    expect(html).not.toContain("1000000");
  });

  it("shows the execution entry after a plan has been adopted", () => {
    const html = render(hub("plans", { futurePlanning: { ...futurePlanning, adoptedAt: "2026-09-22T01:00:00.000Z" } }));
    expect(html).toContain("这份方案已进入执行进度");
    expect(html).toContain("查看执行进度");
    expect(html).not.toContain("采用此方案并开始执行");
  });
});
