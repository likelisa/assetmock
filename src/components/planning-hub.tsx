"use client";

import { Activity, AlertTriangle, ChevronRight, Target } from "lucide-react";
import { useState } from "react";
import { FuturePlanningPreview, PlanningView, type FuturePlanningResult, type PlanningResult } from "./agent-views";
import { CarPlanningView } from "./car-planning-view";
import { WorldlineView } from "./worldline/worldline-view";

export type HubTab = "plans" | "scenarios" | "car";

const tabs: Array<{ id: HubTab; label: string; icon: typeof Target }> = [
  { id: "plans", label: "方案比较", icon: Target },
  { id: "scenarios", label: "世界线对比", icon: Activity },
];

export function PlanningHub({
  planning, planningLoading, hasGoals, onGeneratePlans, onSelectPlan, onGoToAgent,
  futurePlanning, futurePlanningLoading, futurePlanningAdopting, onGenerateFuturePlanning, onAdoptFuturePlanning, onViewExecution,
  activeGoal, assessmentCurrent, onGoToAssessment,
  workspaceId, carIntent, onDataChange,
  initialTab = "plans",
}: {
  planning: PlanningResult | null; planningLoading: boolean; hasGoals: boolean;
  onGeneratePlans: () => void; onSelectPlan: (key: "A" | "B" | "C") => void; onGoToAgent: () => void;
  futurePlanning: FuturePlanningResult | null; futurePlanningLoading: boolean; futurePlanningAdopting: boolean; onGenerateFuturePlanning: () => void; onAdoptFuturePlanning: (reportId: string) => void; onViewExecution: () => void;
  activeGoal?: { id: string; name: string } | null;
  assessmentCurrent?: boolean;
  onGoToAssessment?: () => void;
  initialTab?: HubTab;
  workspaceId?: string; carIntent?: string; onDataChange?: () => Promise<void>;
}) {
  const [tab, setTab] = useState<HubTab>(initialTab);
  return <div className="planning-page">
    <header className="planning-page-header"><div><p className="planning-page-kicker">{tab === "scenarios" ? "世界线对比" : "目标规划"}</p><h1>{tab === "scenarios" ? "同一个决定，算出很多种可能" : "为重要目标，选一条清晰的路"}</h1><p>{tab === "scenarios" ? "在几百条假设的人生里，看两条付款路径各自的位置；不预测未来，只把被检验的假设摆出来。" : "比较方案、安排近期行动，并检验变化带来的影响。"}</p></div>{activeGoal && <div className="planning-goal-context"><span>当前目标</span><strong>{activeGoal.name}</strong></div>}</header>
    <nav className="hub-tabs" aria-label="目标规划分区">
      {workspaceId && <button type="button" role="tab" aria-selected={tab === "car"} className={tab === "car" ? "active" : ""} onClick={() => setTab("car")}><Target size={16} />买车决策</button>}
      {tabs.map(({ id, label, icon: Icon }) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={16} />{label}</button>)}
    </nav>
    <div className="planning-page-content">
      {tab === "car" && workspaceId && onDataChange && <CarPlanningView workspaceId={workspaceId} initialIntent={carIntent} onDataChange={onDataChange} onViewExecution={onViewExecution} onEditLedger={onGoToAgent} />}
      {tab === "plans" && !activeGoal && <PlanningPrerequisite icon="goal" title="先选择一个人生目标" description="从首页的目标卡开始规划，系统会始终围绕你选择的目标生成方案。" action="返回选择目标" onAction={onGoToAgent} />}
      {tab === "plans" && activeGoal && !assessmentCurrent && <PlanningPrerequisite icon="assessment" title="先完成现状评估" description={`规划“${activeGoal.name}”前，需要先按当前底账完成一次现状评估。`} action="前往现状评估" onAction={onGoToAssessment ?? onGoToAgent} />}
      {tab === "plans" && activeGoal && assessmentCurrent && <><PlanningView result={planning} loading={planningLoading} hasGoals={hasGoals} onGenerate={onGeneratePlans} onNavigate={onGoToAgent} onSelect={onSelectPlan} /><FuturePlanningPreview result={futurePlanning} planning={planning} loading={futurePlanningLoading} adopting={futurePlanningAdopting} onGenerate={onGenerateFuturePlanning} onAdopt={onAdoptFuturePlanning} onViewExecution={onViewExecution} /></>}
      {tab === "scenarios" && workspaceId && <WorldlineView key={`${workspaceId}:${activeGoal?.id ?? ''}`} workspaceId={workspaceId} goalId={activeGoal?.id ?? null} />}
    </div>
  </div>;
}

function PlanningPrerequisite({ icon, title, description, action, onAction }: {
  icon: "goal" | "assessment"; title: string; description: string; action: string; onAction: () => void;
}) {
  const Icon = icon === "goal" ? Target : AlertTriangle;
  return <div className="flex min-h-[60vh] flex-col items-center justify-center text-center"><span className="grid size-14 place-items-center bg-blue-50 text-blue-700"><Icon size={25} /></span><h2 className="mt-5 text-xl font-semibold">{title}</h2><p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p><button className="button-primary mt-6" onClick={onAction}>{action}<ChevronRight size={16} /></button></div>;
}
