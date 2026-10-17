"use client";
import { GoalFundingWorkspace } from "./goal-funding-workspace";
import { DemoSwitch } from "./demo-switch";
import { DataManagementView, clearBusinessCache } from "./data-management-view";

import {
  Activity,
  Banknote,
  Check,
  CircleDollarSign,
  Landmark,
  LayoutDashboard,
  LoaderCircle,
  Menu,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Target,
  Trash2,
  TrendingUp,
  Wallet,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatMoneyInput, minorToYuan, yuanToMinor } from "@/domain/money-input";
import { defaultLedgerHeaders, type LedgerHeaders } from "@/domain/ledger-headers";
import { DiagnosisView, type AgentResults } from "./agent-views";
import { ActionsView, type ExecutionResults } from "./execution-views";
import { PlanningHub } from "./planning-hub";
import { FinancialHome } from "./financial-home";
import { ManagerSummary, SpecialistManagerPage } from "./specialist-managers";
import { BookkeepingView } from "./bookkeeping-view";
import { PromptSidebar } from "./prompt-sidebar";
import { AgentConversation } from "./agent-conversation";
import { GoalDecisionSummary } from "./goal-decision-summary";
import { type AgentKey, agentLabels } from "@/domain/agents";

type Profile = {
  age: number | null;
  familyStatus: string;
  riskLevel: string;
  baseCurrency: "CNY";
  stableMonthlyIncomeMinor: string;
  otherMonthlyIncomeMinor: string;
  rentExpenseMinor: string;
  transportExpenseMinor: string;
  essentialExpenseMinor: string;
};

type Asset = {
  id: string;
  name: string;
  type: string;
  currentValueMinor: string;
  currency: "CNY";
  liquidityLevel: string;
  riskLevel: number;
  isInvestable: boolean;
  isAdjustable: boolean;
  goalId: string | null;
};

type Liability = {
  id: string;
  name: string;
  type: string;
  outstandingBalanceMinor: string;
  isInstallment: boolean;
  monthlyPaymentMinor: string;
  remainingMonths: number | null;
  totalRepaymentMinor: string | null;
  principalMinor: string | null;
  interestMinor: string | null;
  repaymentMethod: string | null;
};

type Goal = {
  id: string;
  name: string;
  type: string;
  targetAmountMinor: string;
  targetDate: string;
  preparedAmountMinor: string;
  monthlyContributionMinor: string;
  priority: number;
  isFlexible: boolean;
};

type Portfolio = {
  backupWarning?: string | null;
  id: string;
  portfolioRevision: number;
  dataEpoch: number;
  ledgerConfirmedAt: string | null;
  ledgerHeaders: LedgerHeaders;
  multiGoalConsentAt: string | null;
  profile: Profile;
  assets: Asset[];
  liabilities: Liability[];
  goals: Goal[];
};

type Resource = Asset | Liability | Goal;
type ResourceKind = "asset" | "liability" | "goal";
type View = "agent" | "bookkeeping" | "assets" | "liabilities" | "goals" | "diagnosis" | "planning" | "execution" | "cashflow-manager" | "investment-assistant" | "insurance-manager" | "data-management";

const UNIFIED_CAR_PLANNING = process.env.NEXT_PUBLIC_GOAL_FUNDING_ENABLED === "1";
const STORAGE_KEY = "financial_associate_workspace_id";
const PLANNING_GOAL_STORAGE_PREFIX = "financial_associate_planning_goal_";
const TOMORROW_DATE = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const labels = {
  assetType: {
    CASH: "现金",
    BANK_DEPOSIT: "银行存款",
    MONEY_MARKET: "货币基金",
    BOND: "债券",
    BOND_FUND: "债券基金",
    EQUITY: "股票",
    EQUITY_FUND: "权益基金",
    REAL_ESTATE: "房产",
    INSURANCE_CASH_VALUE: "保险现金价值",
    PENSION: "养老金",
    ALTERNATIVE: "另类投资",
    OTHER: "其他",
  },
  liabilityType: {
    MORTGAGE: "房贷",
    CAR_LOAN: "车贷",
    CONSUMER_LOAN: "消费贷",
    CREDIT_CARD: "信用卡",
    STUDENT_LOAN: "助学贷款",
    OTHER: "其他",
  },
  goalType: {
    HOME_PURCHASE: "购房",
    EDUCATION: "教育",
    RETIREMENT: "退休",
    ENTREPRENEURSHIP: "创业",
    CAREER_BREAK: "职业间歇",
    WEALTH_GROWTH: "财富增长",
    OTHER: "其他",
  },
  liquidity: { T0: "随时可用", D7: "7 日内", D30: "30 日内", Y1: "1 年内", GT_Y1: "1 年以上", ILLIQUID: "难以变现" },
} as const;

const emptyProfile: Profile = {
  age: null,
  familyStatus: "SINGLE",
  riskLevel: "BALANCED",
  baseCurrency: "CNY",
  stableMonthlyIncomeMinor: "0",
  otherMonthlyIncomeMinor: "0",
  rentExpenseMinor: "0",
  transportExpenseMinor: "0",
  essentialExpenseMinor: "0",
};

function formatMoney(value: bigint) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    maximumFractionDigits: 0,
  }).format(Number(value) / 100);
}

function labelFor(map: Record<string, string>, value: string) {
  return map[value] ?? value;
}

async function request<T>(path: string, workspaceId: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", "X-Workspace-Id": workspaceId, ...options?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? "请求失败，请稍后重试");
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export function FinancialWorkspace() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [agentResults, setAgentResults] = useState<AgentResults>({ diagnosis: null, planning: null, futurePlanning: null });
  const [executionResults, setExecutionResults] = useState<ExecutionResults>({ scenario: null, actions: null });
  const [workspaceId, setWorkspaceId] = useState("");
  const [view, setCurrentView] = useState<View>("agent");
  const [editor, setEditor] = useState<{ kind: ResourceKind; item?: Resource } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: ResourceKind; item: Resource } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [assessmentFocusRequest, setAssessmentFocusRequest] = useState(0);
  const [carIntent, setCarIntent] = useState<string | null>(null);
  const [planningGoalId, setPlanningGoalId] = useState<string | null>(null);
  const [planningEntryTab, setPlanningEntryTab] = useState<"plans" | "scenarios">("plans");
  const [adoptingFuturePlanning, setAdoptingFuturePlanning] = useState(false);
  const [runningTask, setRunningTask] = useState<"WEALTH_DIAGNOSIS" | "FINANCIAL_PLANNING" | "SCENARIO_ANALYSIS" | "ACTION_PLANNING" | "FUTURE_PLANNING_ACTION_REPORT" | null>(null);
  const [promptSidebarOpen, setPromptSidebarOpen] = useState(false);

  const sceneViews: Record<AgentKey, View[]> = { WEALTH: ["agent", "diagnosis"], GOAL: ["execution"], CASHFLOW: ["bookkeeping", "cashflow-manager"], INVESTMENT: ["investment-assistant"], INSURANCE: ["insurance-manager"] };
  const lastSceneView = useRef<Partial<Record<AgentKey, View>>>({});
  const sceneFor = (value: View): AgentKey | null => value === "planning" ? "GOAL" : (Object.keys(sceneViews) as AgentKey[]).find(key => sceneViews[key].includes(value)) ?? null;
  const setView = useCallback((nextView: View, planningTab: "plans" | "scenarios" = "plans") => {
    setPromptSidebarOpen(false);
    setPlanningEntryTab(planningTab);
    setCurrentView(nextView);
    const scene = ["execution", "planning"].includes(nextView) ? "GOAL" : ["agent", "diagnosis"].includes(nextView) ? "WEALTH" : ["bookkeeping", "cashflow-manager"].includes(nextView) ? "CASHFLOW" : nextView === "investment-assistant" ? "INVESTMENT" : nextView === "insurance-manager" ? "INSURANCE" : null;
    if (scene) lastSceneView.current[scene] = nextView === "planning" ? "execution" : nextView;
    const url = new URL(window.location.href); url.searchParams.set("view", nextView);
    if (nextView === "planning" && planningTab === "scenarios") url.searchParams.set("planningTab", "scenarios");
    else url.searchParams.delete("planningTab");
    if (url.toString() !== window.location.href) window.history.pushState({}, "", url);
  }, []);
  useEffect(() => { const sync = () => { const params = new URLSearchParams(window.location.search); const v = params.get("view"); setPlanningEntryTab(params.get("planningTab") === "scenarios" ? "scenarios" : "plans"); if (["agent","diagnosis","planning","execution","bookkeeping","cashflow-manager","investment-assistant","insurance-manager","data-management"].includes(v ?? "")) setCurrentView(v as View); else setCurrentView("agent"); }; window.addEventListener("popstate", sync); return () => window.removeEventListener("popstate", sync); }, []);

  const goToAssessment = useCallback(() => {
    setView("agent");
    setMobileNav(false);
    setAssessmentFocusRequest((request) => request + 1);
  }, [setView]);

  const loadPortfolio = useCallback(async (id: string) => {
    try {
      setError("");
      const planningGoalStorageKey = `${PLANNING_GOAL_STORAGE_PREFIX}${id}`;
      const storedPlanningGoalId = localStorage.getItem(planningGoalStorageKey);
      const [nextPortfolio, nextAgentResults, nextExecutionResults] = await Promise.all([
        request<Portfolio>("/api/portfolio", id),
        request<AgentResults>(`/api/agent-results${storedPlanningGoalId ? `?goalId=${encodeURIComponent(storedPlanningGoalId)}` : ""}`, id),
        request<ExecutionResults>("/api/execution-results", id),
      ]);
      const epochKey = `data-epoch:${id}`;
      const previousEpoch = localStorage.getItem(epochKey);
      if (previousEpoch !== null && previousEpoch !== String(nextPortfolio.dataEpoch)) { clearBusinessCache(id); localStorage.setItem(epochKey, String(nextPortfolio.dataEpoch)); window.location.reload(); return; }
      localStorage.setItem(epochKey, String(nextPortfolio.dataEpoch));
      setPortfolio(nextPortfolio);
      setAgentResults(nextAgentResults);
      setExecutionResults(nextExecutionResults);
      if (storedPlanningGoalId && nextPortfolio.goals.some((goal) => goal.id === storedPlanningGoalId)) {
        setPlanningGoalId(storedPlanningGoalId);
      } else {
        localStorage.removeItem(planningGoalStorageKey);
        setPlanningGoalId(null);
      }
    } catch (loadError) {
      if (loadError instanceof Error && loadError.message.includes("工作区不存在")) {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
        return;
      }
      setError(loadError instanceof Error ? loadError.message : "读取失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    async function initialize() {
      try {
        const storedId = localStorage.getItem(STORAGE_KEY);
        let activeId: string;
        if (!storedId) {
          const startup = await fetch("/api/bootstrap");
          if (!startup.ok) throw new Error("初始化未完成，请查看启动终端的错误后重新启动应用");
          const { demoWorkspaceId } = await startup.json();
          if (demoWorkspaceId) activeId = demoWorkspaceId;
          else {
            const response = await fetch("/api/workspaces", { method: "POST" });
            if (!response.ok) throw new Error("无法创建本地财富空间");
            const workspace = await response.json();
            activeId = workspace.id as string;
          }
          localStorage.setItem(STORAGE_KEY, activeId);
        } else {
          activeId = storedId;
        }
        const requestedView = new URLSearchParams(window.location.search).get("view");
        if (["agent", "diagnosis", "planning", "execution", "bookkeeping", "cashflow-manager", "insurance-manager", "investment-assistant", "data-management"].includes(requestedView ?? "")) setView(requestedView as View, new URLSearchParams(window.location.search).get("planningTab") === "scenarios" ? "scenarios" : "plans");
        setWorkspaceId(activeId);
        await loadPortfolio(activeId);
      } catch (initialError) {
        setError(initialError instanceof Error ? initialError.message : "初始化失败");
        setLoading(false);
      }
    }
    initialize();
  }, [loadPortfolio, setView]);

  async function saveResource(kind: ResourceKind, item: Resource | undefined, body: object) {
    setSaving(true);
    setError("");
    try {
      const plural = kind === "asset" ? "assets" : kind === "liability" ? "liabilities" : "goals";
      await request(`/api/${plural}${item ? `/${item.id}` : ""}`, workspaceId, {
        method: item ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      await loadPortfolio(workspaceId);
      setEditor(null);
      setNotice(item ? "修改已保存" : "已加入财富底账");
      window.setTimeout(() => setNotice(""), 2400);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function saveInlineResource(kind: "asset" | "liability", item: Asset | Liability, body: object) {
    setSaving(true);
    setError("");
    try {
      await request(`/api/${kind === "asset" ? "assets" : "liabilities"}/${item.id}`, workspaceId, { method: "PUT", body: JSON.stringify(body) });
      await loadPortfolio(workspaceId);
      setNotice("金额已更新");
      window.setTimeout(() => setNotice(""), 1800);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "保存失败";
      setError(message);
      throw saveError;
    } finally {
      setSaving(false);
    }
  }

  async function removeResource() {
    if (!deleting) return;
    setSaving(true);
    try {
      const plural = deleting.kind === "asset" ? "assets" : deleting.kind === "liability" ? "liabilities" : "goals";
      await request(`/api/${plural}/${deleting.item.id}`, workspaceId, { method: "DELETE" });
      await loadPortfolio(workspaceId);
      setDeleting(null);
      setNotice("记录已删除");
      window.setTimeout(() => setNotice(""), 2400);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "删除失败");
    } finally {
      setSaving(false);
    }
  }

  async function runAgentTask(type: "WEALTH_DIAGNOSIS" | "FINANCIAL_PLANNING" | "SCENARIO_ANALYSIS" | "ACTION_PLANNING" | "FUTURE_PLANNING_ACTION_REPORT", goalId?: string) {
    setRunningTask(type);
    setError("");
    try {
      await request("/api/tasks", workspaceId, { method: "POST", body: JSON.stringify({ type, goalId }) });
      await loadPortfolio(workspaceId);
      setNotice(type === "WEALTH_DIAGNOSIS" ? "财富诊断已生成" : type === "FINANCIAL_PLANNING" ? "三套规划已生成" : type === "FUTURE_PLANNING_ACTION_REPORT" ? "三个月行动清单已生成" : type === "SCENARIO_ANALYSIS" ? "压力测试已完成" : "行动计划已生成");
      window.setTimeout(() => setNotice(""), 2400);
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : "生成失败");
    } finally {
      setRunningTask(null);
    }
  }

  async function saveProfile(body: Profile, successMessage = "个人画像已更新") {
    setSaving(true);
    setError("");
    try {
      await request("/api/profile", workspaceId, { method: "PUT", body: JSON.stringify(body) });
      await loadPortfolio(workspaceId);
      setNotice(successMessage);
      window.setTimeout(() => setNotice(""), 2400);
      return true;
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : "保存失败");
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function selectPlan(planKey: "A" | "B" | "C") {
    if (!agentResults.planning) return;
    setSaving(true);
    try {
      await request(`/api/plans/${agentResults.planning.id}/selection`, workspaceId, { method: "PUT", body: JSON.stringify({ planKey }) });
      await loadPortfolio(workspaceId);
      setNotice(`Plan ${planKey} 已选定`);
      window.setTimeout(() => setNotice(""), 2400);
    } catch (selectionError) {
      setError(selectionError instanceof Error ? selectionError.message : "选择失败");
    } finally { setSaving(false); }
  }

  async function adoptFuturePlanning(reportId: string) {
    if (!portfolio) return;
    setAdoptingFuturePlanning(true);
    setError("");
    try {
      await request(`/api/future-planning-reports/${reportId}/adopt`, workspaceId, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: portfolio.portfolioRevision }),
      });
      await loadPortfolio(workspaceId);
      setNotice("方案已加入执行进度");
      window.setTimeout(() => setNotice(""), 2400);
    } catch (adoptionError) {
      setError(adoptionError instanceof Error ? adoptionError.message : "采用方案失败");
    } finally {
      setAdoptingFuturePlanning(false);
    }
  }

  async function updateActionStatus(id: string, status: string, reason?: string) {
    setSaving(true);
    try {
      await request(`/api/actions/${id}/status`, workspaceId, { method: "PUT", body: JSON.stringify({ status, reason }) });
      await loadPortfolio(workspaceId);
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "状态更新失败");
      return false;
    } finally { setSaving(false); }
  }

  const assessmentCurrent = Boolean(
    portfolio
    && agentResults.diagnosis?.fourAccountAssessment
    && !agentResults.diagnosis.isStale
    && agentResults.diagnosis.sourceRevision === portfolio.portfolioRevision,
  );
  const planningGoal = portfolio?.goals.find((goal) => goal.id === planningGoalId) ?? null;

  function startCarPlanning(intent = "我想买车") { setCarIntent(intent); setView("planning"); setMobileNav(false); }

  function openSimulation() {
    setCarIntent(null);
    setView("planning", "scenarios");
    setMobileNav(false);
  }

  async function startGoalPlanning(goal: Goal) {
    if (goal.type === "CAR_PURCHASE") { startCarPlanning(); return; }
    setCarIntent(null);
    setPlanningGoalId(goal.id);
    localStorage.setItem(`${PLANNING_GOAL_STORAGE_PREFIX}${workspaceId}`, goal.id);
    if (assessmentCurrent) {
      await loadPortfolio(workspaceId);
      setView("planning");
      setMobileNav(false);
      return;
    }
    goToAssessment();
    setNotice(`请先完成现状评估，再继续规划“${goal.name}”`);
    window.setTimeout(() => setNotice(""), 3200);
  }

  if (loading) return <LoadingScreen />;

  if (!portfolio) {
    return (
      <main className="grid min-h-screen place-items-center px-6">
        <div className="max-w-sm text-center">
          <p className="text-lg font-semibold text-slate-900">财富空间暂时没有加载出来</p>
          <p className="mt-2 text-sm text-slate-500">{error || "请检查数据库配置后重试。"}</p>
          <button className="button-primary mt-5" onClick={() => location.reload()}><RefreshCw size={16} />重新加载</button>
        </div>
      </main>
    );
  }

  const currentScene = sceneFor(view);
  const navigation: { id: View; scene: AgentKey; label: string; icon: typeof Banknote; planned?: boolean }[] = [
    { id: "agent", scene: "WEALTH", label: "资产管家", icon: LayoutDashboard },
    { id: "execution", scene: "GOAL", label: "目标管家", icon: Target },
    { id: "bookkeeping", scene: "CASHFLOW", label: "收支管家", icon: Wallet },
    { id: "investment-assistant", scene: "INVESTMENT", label: "投资管家", icon: TrendingUp },
    { id: "insurance-manager", scene: "INSURANCE", label: "保险管家", icon: ShieldCheck },
  ];
  const currentNavigation = navigation.find(item => item.scene === currentScene);
  const tabLabels: Partial<Record<View, string>> = { agent: "财富总览", diagnosis: "财富诊断", bookkeeping: "记账", "cashflow-manager": "复盘" };

  const selectedPlan = agentResults.planning?.plans.find((item) => item.key === agentResults.planning?.selectedPlanKey) ?? null;

  return (
    <div className={`workspace-shell min-h-screen ${view === "agent" ? "workspace-shell-home" : ""}`}>
      <aside className={`sidebar ${mobileNav ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark"><CircleDollarSign size={20} /></div>
          <div><p className="text-sm font-bold">AI 资产管家</p><p className="text-[11px] text-slate-500">个人财富空间</p></div>
          <button className="icon-button mobile-only ml-auto" onClick={() => setMobileNav(false)} aria-label="关闭导航"><X size={18} /></button>
        </div>
        <div className="sidebar-body">
          <nav className="sidebar-nav" aria-label="AI 资产管家功能">
            {navigation.map(({ id, scene, label, icon: Icon, planned }) => (
              <button key={id} className={`nav-item ${planned ? "nav-item-planned" : ""} ${currentScene === scene ? "nav-item-active" : ""}`} onClick={() => { setView(lastSceneView.current[scene] ?? id); setMobileNav(false); }}>
                <Icon size={18} /><span>{label}{planned && <span className="nav-item-planned-note">（规划中）</span>}</span>
                {["assets", "liabilities", "goals"].includes(id) && <span className="ml-auto text-xs tabular-nums text-slate-400">{id === "assets" ? portfolio.assets.length : id === "liabilities" ? portfolio.liabilities.length : portfolio.goals.length}</span>}
              </button>
            ))}
          </nav>
        </div>
        <div className="sidebar-meta mt-auto">
          <p className="text-xs text-slate-500">财务底账</p>
          <p className="mt-1 text-sm font-semibold tabular-nums">第 {portfolio.portfolioRevision} 版</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">更新底账后，已有报告会提示重新评估。</p>
        </div>
      </aside>

      {mobileNav && <button className="fixed inset-0 z-30 bg-black/30 lg:hidden" aria-label="关闭导航" onClick={() => setMobileNav(false)} />}

      <div className={`workspace-content workspace-content-${view} lg:pl-52`}>
        <header className="workspace-header sticky top-0 z-20 flex h-16 items-center px-4 sm:px-8">
          <button className="icon-button mobile-only mr-3" onClick={() => setMobileNav(true)} aria-label="打开导航"><Menu size={19} /></button>
          <div><p className="text-sm font-semibold">{currentNavigation?.label}</p>{!currentNavigation?.planned && <p className="hidden text-xs text-slate-500 sm:block">数据保存在本机，按当前浏览器对应的匿名空间区分</p>}</div>
          <div className="ml-auto flex items-center gap-3">
            {(view === "diagnosis" || view === "planning") && <button type="button" className="prompt-sidebar-trigger" onClick={() => setPromptSidebarOpen(true)}><PanelRightOpen size={17} />调试 Prompt</button>}
            {!currentNavigation?.planned && <><button className="button-secondary" onClick={() => setView("data-management")}>数据管理</button><div className="workspace-save-status flex items-center gap-2 text-xs"><span className="size-2 rounded-full bg-blue-500" />已保存</div></>}
          </div>
        </header>

        <main className="workspace-main mx-auto max-w-[1600px] px-4 py-7 sm:px-8 sm:py-9">
          <DemoSwitch workspaceId={workspaceId}/>
          {notice && <div className="fixed right-5 top-20 z-50 flex items-center gap-2 border border-blue-200 bg-white px-4 py-3 text-sm font-medium text-blue-800 shadow-lg"><Check size={17} />{notice}</div>}
          {currentScene && sceneViews[currentScene].length > 1 && <div className="scene-tabs" role="tablist" aria-label={`${agentLabels[currentScene]}页面`}>
            {sceneViews[currentScene].map(tab => <button key={tab} role="tab" aria-selected={view === tab} onClick={() => setView(tab)}>{tabLabels[tab]}</button>)}
          </div>}
          {currentScene && currentScene !== "GOAL" && <AgentConversation key={`${workspaceId}:${currentScene}`} workspaceId={workspaceId} agentKey={currentScene} goals={portfolio.goals} onDataChange={() => loadPortfolio(workspaceId)} onOpenPlanning={() => setView("planning")} />}
          {portfolio.backupWarning && <p className="manager-note" role="status">{portfolio.backupWarning} <button className="button-secondary" onClick={() => void loadPortfolio(workspaceId)}>重试备份</button></p>}
          {error && <div className="mb-5 flex items-center justify-between border-l-4 border-rose-500 bg-rose-50 px-4 py-3 text-sm text-rose-800"><span>{error}</span><button onClick={() => setError("")} aria-label="关闭"><X size={16} /></button></div>}

          {view === "agent" && <FinancialHome onViewExecution={() => setView("execution")} onStartCarPlanning={startCarPlanning} onOpenGoalManager={() => setView("execution")} workspaceId={workspaceId} revision={portfolio.portfolioRevision} profile={portfolio.profile ?? emptyProfile} assets={portfolio.assets} liabilities={portfolio.liabilities} goals={portfolio.goals} multiGoalConsentAt={portfolio.multiGoalConsentAt} saving={saving} assessment={agentResults.diagnosis?.fourAccountAssessment ?? null} assessmentStale={agentResults.diagnosis?.isStale ?? false} assessmentLoading={runningTask === "WEALTH_DIAGNOSIS"} assessmentFocusRequest={assessmentFocusRequest} planningGoal={planningGoal} assessmentCurrent={assessmentCurrent} onAssess={() => runAgentTask("WEALTH_DIAGNOSIS")} onViewReport={() => setView("diagnosis")} onStartPlanning={startGoalPlanning} onEdit={(kind, item) => setEditor({ kind, item })} onDelete={(kind, item) => setDeleting({ kind, item })} onSave={saveInlineResource} onSaveProfile={saveProfile} onDataChange={() => loadPortfolio(workspaceId)} />}
          {view === "agent" && <ManagerSummary workspaceId={workspaceId} revision={portfolio.portfolioRevision} onOpen={(manager) => setView(manager === "CASHFLOW" ? "cashflow-manager" : manager === "INSURANCE" ? "insurance-manager" : "investment-assistant")} onCar={() => setView("execution")} onExecution={() => setView("execution")} />}
          {["cashflow-manager", "insurance-manager", "investment-assistant"].includes(view) && <SpecialistManagerPage key={view} workspaceId={workspaceId} manager={view === "cashflow-manager" ? "CASHFLOW" : view === "insurance-manager" ? "INSURANCE" : "INVESTMENT"} onDataChange={() => loadPortfolio(workspaceId)} onBookkeeping={() => setView("bookkeeping")} onExecution={() => setView("execution")} onCar={() => startCarPlanning()} />}
          {view === "execution" && <>
            {UNIFIED_CAR_PLANNING ? <GoalFundingWorkspace key={workspaceId} workspaceId={workspaceId} revision={portfolio.portfolioRevision} goals={portfolio.goals} onDataChange={() => loadPortfolio(workspaceId)} onOpenPlanning={() => setView("planning")}>
              <ManagerSummary workspaceId={workspaceId} revision={portfolio.portfolioRevision} onOpen={() => {}} onCar={() => startCarPlanning()} onExecution={() => {}} remindersOnly />
              <ActionsView result={executionResults.actions} loading={saving} onStatus={updateActionStatus} />
              <GoalDecisionSummary workspaceId={workspaceId} revision={portfolio.portfolioRevision} onOpenPlanning={() => setView("planning")} />
            </GoalFundingWorkspace> : <div className="goal-manager-layout">
              <AgentConversation key={`${workspaceId}:GOAL`} workspaceId={workspaceId} agentKey="GOAL" goals={portfolio.goals} onDataChange={() => loadPortfolio(workspaceId)} onOpenPlanning={() => setView("planning")} embedded /><div>
              <ManagerSummary workspaceId={workspaceId} revision={portfolio.portfolioRevision} onOpen={() => {}} onCar={() => startCarPlanning()} onExecution={() => {}} remindersOnly />
              <ActionsView result={executionResults.actions} loading={saving} onStatus={updateActionStatus} />
              <GoalDecisionSummary workspaceId={workspaceId} revision={portfolio.portfolioRevision} onOpenPlanning={() => setView("planning")} />
            </div></div>}
            <section className="goal-simulation-entry" aria-label="世界线对比">
              <div><h2>也可以看看这件事有多少种走法</h2><p>同一个决定跑很多遍，按你的底账与真实统计假设，比较两种付款方式在几百条世界线里的位置。</p><small>{planningGoal ? `当前规划目标：${planningGoal.name}` : "使用当前底账，先确认简化输入再开始。"}</small></div>
              <button type="button" className="button-secondary" onClick={openSimulation}><Activity size={18} aria-hidden="true" />世界线对比</button>
            </section>
          </>}
          {view === "data-management" && <DataManagementView workspaceId={workspaceId} onChange={() => loadPortfolio(workspaceId)} />}
          {view === "bookkeeping" && <BookkeepingView workspaceId={workspaceId} onExecutionChange={() => loadPortfolio(workspaceId)} />}
          {view === "assets" && <ResourceList kind="asset" items={portfolio.assets} goals={portfolio.goals} onAdd={() => setEditor({ kind: "asset" })} onEdit={(item) => setEditor({ kind: "asset", item })} onDelete={(item) => setDeleting({ kind: "asset", item })} />}
          {view === "liabilities" && <ResourceList kind="liability" items={portfolio.liabilities} goals={portfolio.goals} onAdd={() => setEditor({ kind: "liability" })} onEdit={(item) => setEditor({ kind: "liability", item })} onDelete={(item) => setDeleting({ kind: "liability", item })} />}
          {view === "goals" && <ResourceList kind="goal" items={portfolio.goals} goals={portfolio.goals} onAdd={() => setView("agent")} onEdit={(item) => setEditor({ kind: "goal", item })} onDelete={(item) => setDeleting({ kind: "goal", item })} />}
          {view === "diagnosis" && <DiagnosisView result={agentResults.diagnosis} onGoToAssessment={goToAssessment} />}
          {view === "planning" && <PlanningHub
            key={`${planningEntryTab}:${carIntent !== null ? "car" : planningGoalId ?? "general"}`}
            workspaceId={workspaceId}
            carIntent={carIntent ?? undefined}
            initialTab={planningEntryTab === "scenarios" ? "scenarios" : carIntent !== null ? "car" : "plans"}
            onDataChange={() => loadPortfolio(workspaceId)}
            planning={agentResults.planning}
            planningLoading={runningTask === "FINANCIAL_PLANNING"}
            hasGoals={portfolio.goals.length > 0}
            onGeneratePlans={() => planningGoal ? runAgentTask("FINANCIAL_PLANNING", planningGoal.id) : Promise.resolve()}
            onSelectPlan={selectPlan}
            futurePlanning={agentResults.futurePlanning}
            futurePlanningLoading={runningTask === "FUTURE_PLANNING_ACTION_REPORT"}
            futurePlanningAdopting={adoptingFuturePlanning}
            onGenerateFuturePlanning={() => planningGoal ? runAgentTask("FUTURE_PLANNING_ACTION_REPORT", planningGoal.id) : Promise.resolve()}
            onAdoptFuturePlanning={adoptFuturePlanning}
            onViewExecution={() => setView("execution")}
            onGoToAgent={() => setView("agent")}
            activeGoal={planningGoal}
            assessmentCurrent={assessmentCurrent}
            onGoToAssessment={goToAssessment}
          />}

        </main>
      </div>

      {editor && <ResourceEditor editor={editor} saving={saving} onClose={() => setEditor(null)} onSave={saveResource} />}
      {deleting && <ConfirmDelete deleting={deleting} saving={saving} onCancel={() => setDeleting(null)} onConfirm={removeResource} />}
      {promptSidebarOpen && (view === "diagnosis" || view === "planning") && <PromptSidebar workspaceId={workspaceId} group={view} onClose={() => setPromptSidebarOpen(false)} />}
    </div>
  );
}

function LoadingScreen() {
  return <main className="grid min-h-screen place-items-center bg-[#f3f6fa]"><div className="flex items-center gap-3 text-sm font-medium text-slate-600"><LoaderCircle className="animate-spin text-blue-700" size={20} />正在打开你的财富空间</div></main>;
}

type LedgerAssetDraft = { id?: string; name: string; type: string; amount: string };
type LedgerLiabilityDraft = { id?: string; name: string; type: string; amount: string; monthlyPayment: string };
type LedgerCashflowDraft = { stableIncome: string; otherIncome: string; rent: string; transport: string; essential: string };
type LedgerDraft = { workspaceId: string; sourceRevision: number; headers: LedgerHeaders; assetRows: LedgerAssetDraft[]; liabilityRows: LedgerLiabilityDraft[]; cashflow: LedgerCashflowDraft };

export function LedgerBatchForm({ portfolio, saving, onSave, onAdvancedEdit, draft, onDraftChange }: {
  portfolio: Portfolio;
  saving: boolean;
  onSave: (body: object) => void;
  onAdvancedEdit: (kind: ResourceKind, item: Resource) => void;
  draft: LedgerDraft | null;
  onDraftChange: (draft: LedgerDraft | null) => void;
}) {
  const [editingHeaders, setEditingHeaders] = useState(false);
  const current: LedgerDraft = draft?.workspaceId === portfolio.id ? draft : {
    workspaceId: portfolio.id, sourceRevision: portfolio.portfolioRevision,
    headers: portfolio.ledgerHeaders ?? defaultLedgerHeaders,
    assetRows: portfolio.assets.map((item) => ({ id: item.id, name: item.name, type: item.type, amount: minorToYuan(item.currentValueMinor) })),
    liabilityRows: portfolio.liabilities.map((item) => ({ id: item.id, name: item.name, type: item.type, amount: minorToYuan(item.outstandingBalanceMinor), monthlyPayment: minorToYuan(item.monthlyPaymentMinor) })),
    cashflow: {
      stableIncome: minorToYuan(portfolio.profile?.stableMonthlyIncomeMinor), otherIncome: minorToYuan(portfolio.profile?.otherMonthlyIncomeMinor),
      rent: minorToYuan(portfolio.profile?.rentExpenseMinor), transport: minorToYuan(portfolio.profile?.transportExpenseMinor), essential: minorToYuan(portfolio.profile?.essentialExpenseMinor),
    },
  };
  const { headers, assetRows, liabilityRows, cashflow } = current;
  const staleDraft = current.sourceRevision !== portfolio.portfolioRevision;
  const setHeaders = (update: (value: LedgerHeaders) => LedgerHeaders) => onDraftChange({ ...current, headers: update(headers) });
  const setAssetRows = (update: (value: LedgerAssetDraft[]) => LedgerAssetDraft[]) => onDraftChange({ ...current, assetRows: update(assetRows) });
  const setLiabilityRows = (update: (value: LedgerLiabilityDraft[]) => LedgerLiabilityDraft[]) => onDraftChange({ ...current, liabilityRows: update(liabilityRows) });
  const setCashflow = (update: (value: LedgerCashflowDraft) => LedgerCashflowDraft) => onDraftChange({ ...current, cashflow: update(cashflow) });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      onSave({
        expectedRevision: current.sourceRevision,
        headers,
        profile: {
          stableMonthlyIncomeMinor: yuanToMinor(cashflow.stableIncome),
          otherMonthlyIncomeMinor: yuanToMinor(cashflow.otherIncome),
          rentExpenseMinor: yuanToMinor(cashflow.rent),
          transportExpenseMinor: yuanToMinor(cashflow.transport),
          essentialExpenseMinor: yuanToMinor(cashflow.essential),
        },
        assets: assetRows.map((item) => ({ id: item.id, name: item.name, type: item.type, currentValueMinor: yuanToMinor(item.amount) })),
        liabilities: liabilityRows.map((item) => ({ id: item.id, name: item.name, type: item.type, outstandingBalanceMinor: yuanToMinor(item.amount), monthlyPaymentMinor: yuanToMinor(item.monthlyPayment) })),
      });
    } catch (formError) {
      alert(formError instanceof Error ? formError.message : "请检查底账金额");
    }
  }

  function updateAsset(index: number, patch: Partial<LedgerAssetDraft>) {
    setAssetRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function updateLiability(index: number, patch: Partial<LedgerLiabilityDraft>) {
    setLiabilityRows((rows) => rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  return <form className="flex min-h-[520px] max-h-[620px] flex-col overflow-hidden border border-slate-200 bg-white" onSubmit={submit}>
    <fieldset disabled={saving} className="contents">
    {draft && <div className="flex items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900"><span>{staleDraft ? "底账已更新，旧版草稿仍保留。请核对后重新编辑。" : "有未保存的底账草稿"}</span><button type="button" className="icon-button shrink-0" title="放弃草稿并加载已保存底账" aria-label="放弃草稿" disabled={saving} onClick={() => { if (confirm("放弃未保存的草稿，加载最新底账？")) onDraftChange(null); }}><Trash2 size={15} /></button></div>}
    <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 className="text-sm font-semibold">我的财务底账</h2><div className="flex items-center gap-2">{portfolio.ledgerConfirmedAt && <span className="text-xs text-blue-700">已确认</span>}<button type="button" className="icon-button" title={editingHeaders ? "结束编辑表头" : "编辑表头"} aria-label="编辑表头" aria-pressed={editingHeaders} onClick={() => setEditingHeaders(!editingHeaders)}><Pencil size={15} /></button></div></div>
    <div className="min-h-0 flex-1 overflow-auto">
      <LedgerSection title="资产账户" columns="">
        <LedgerColumnHeaders kind="asset" headers={headers} editing={editingHeaders} onChange={(key, value) => setHeaders((current) => ({ ...current, [key]: value }))} />
        {assetRows.map((row, index) => <div key={row.id ?? `new-asset-${index}`} className="grid min-w-[520px] grid-cols-[minmax(120px,1fr)_110px_minmax(110px,0.75fr)_36px] items-center gap-2 border-t border-slate-100 px-4 py-2.5">
          <input className="ledger-cell" aria-label={`资产类目 ${index + 1}`} value={row.name} maxLength={60} required onChange={(event) => updateAsset(index, { name: event.target.value })} />
          <select className="ledger-cell" aria-label={`${row.name}类型`} value={row.type} onChange={(event) => updateAsset(index, { type: event.target.value })}>{Object.entries(labels.assetType).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <div className="money-input ledger-money"><span>¥</span><input aria-label={`${row.name}余额`} inputMode="decimal" value={row.amount} placeholder="0" onFocus={(event) => updateAsset(index, { amount: event.currentTarget.value.replace(/,/g, "") })} onChange={(event) => updateAsset(index, { amount: event.target.value })} onBlur={() => updateAsset(index, { amount: formatMoneyInput(row.amount) })} /></div>
          {row.id ? <button type="button" className="icon-button" title="编辑账户属性" aria-label={`编辑${row.name}属性`} disabled={staleDraft} onClick={() => { const item = portfolio.assets.find((item) => item.id === row.id); if (item) onAdvancedEdit("asset", item); }}><Settings2 size={15} /></button> : <span />}
        </div>)}
        <button type="button" className="mx-4 my-3 flex items-center gap-2 text-xs font-semibold text-blue-700" onClick={() => setAssetRows((rows) => [...rows, { name: "自定义资产", type: "OTHER", amount: "" }])}><Plus size={15} />添加资产类目</button>
      </LedgerSection>

      <LedgerSection title="负债账户" columns="">
        <LedgerColumnHeaders kind="liability" headers={headers} editing={editingHeaders} onChange={(key, value) => setHeaders((current) => ({ ...current, [key]: value }))} />
        {liabilityRows.map((row, index) => <div key={row.id ?? `new-liability-${index}`} className="grid min-w-[640px] grid-cols-[minmax(110px,1fr)_100px_minmax(95px,0.7fr)_minmax(95px,0.7fr)_36px] items-center gap-2 border-t border-slate-100 px-4 py-2.5">
          <input className="ledger-cell" aria-label={`负债类目 ${index + 1}`} value={row.name} maxLength={60} required onChange={(event) => updateLiability(index, { name: event.target.value })} />
          <select className="ledger-cell" aria-label={`${row.name}类型`} value={row.type} onChange={(event) => updateLiability(index, { type: event.target.value })}>{Object.entries(labels.liabilityType).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <CompactMoneyInput label={`${row.name}余额`} value={row.amount} onChange={(amount) => updateLiability(index, { amount })} />
          <CompactMoneyInput label={`${row.name}月还款`} value={row.monthlyPayment} onChange={(monthlyPayment) => updateLiability(index, { monthlyPayment })} />
          {row.id ? <button type="button" className="icon-button" title="编辑负债属性" aria-label={`编辑${row.name}属性`} disabled={staleDraft} onClick={() => { const item = portfolio.liabilities.find((item) => item.id === row.id); if (item) onAdvancedEdit("liability", item); }}><Settings2 size={15} /></button> : <span />}
        </div>)}
        <button type="button" className="mx-4 my-3 flex items-center gap-2 text-xs font-semibold text-blue-700" onClick={() => setLiabilityRows((rows) => [...rows, { name: "自定义负债", type: "OTHER", amount: "", monthlyPayment: "" }])}><Plus size={15} />添加负债类目</button>
      </LedgerSection>

      <LedgerSection title="每月现金流" columns="未填写按 0 计算">
        <div className="grid grid-cols-2 gap-3 border-t border-slate-100 p-4 sm:grid-cols-3">
          {[
            ["稳定收入", "stableIncome"], ["其他收入", "otherIncome"], ["房租", "rent"], ["交通支出", "transport"], ["月开销", "essential"],
          ].map(([label, key]) => <label key={key} className="text-xs font-medium text-slate-500"><span>{label}</span><CompactMoneyInput label={label} value={cashflow[key as keyof typeof cashflow]} onChange={(value) => setCashflow((current) => ({ ...current, [key]: value }))} /></label>)}
        </div>
      </LedgerSection>
    </div>
    <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3"><p className="text-xs text-slate-400">保存后四账户、结构和评分会按新版本重算</p><button className="button-primary shrink-0" disabled={saving || staleDraft}>{saving ? <LoaderCircle className="animate-spin" size={15} /> : <Check size={15} />}保存整张底账</button></div>
    </fieldset>
  </form>;
}

function LedgerSection({ title, columns, children }: { title: string; columns: string; children: React.ReactNode }) {
  return <section><div className="flex items-center justify-between bg-slate-50 px-4 py-2.5"><h3 className="text-xs font-semibold text-slate-700">{title}</h3><span className="text-[11px] text-slate-400">{columns}</span></div>{children}</section>;
}

function LedgerColumnHeaders({ kind, headers, editing, onChange }: { kind: "asset" | "liability"; headers: LedgerHeaders; editing: boolean; onChange: (key: keyof LedgerHeaders, value: string) => void }) {
  const keys: Array<keyof LedgerHeaders> = kind === "asset" ? ["assetName", "assetType", "assetAmount"] : ["liabilityName", "liabilityType", "liabilityAmount", "liabilityPayment"];
  const grid = kind === "asset" ? "min-w-[520px] grid-cols-[minmax(120px,1fr)_110px_minmax(110px,0.75fr)_36px]" : "min-w-[640px] grid-cols-[minmax(110px,1fr)_100px_minmax(95px,0.7fr)_minmax(95px,0.7fr)_36px]";
  return <div className={`grid items-center gap-2 border-t border-slate-100 px-4 py-2 text-xs font-semibold text-slate-500 ${grid}`}>{keys.map((key) => editing ? <input key={key} className="ledger-cell min-w-0" aria-label={`${kind === "asset" ? "资产" : "负债"}${defaultLedgerHeaders[key]}表头`} value={headers[key]} maxLength={24} required onChange={(event) => onChange(key, event.target.value)} /> : <span key={key} className="break-all">{headers[key]}</span>)}</div>;
}

function CompactMoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="money-input ledger-money mt-1"><span>¥</span><input aria-label={label} inputMode="decimal" value={value} placeholder="0" onFocus={(event) => onChange(event.currentTarget.value.replace(/,/g, ""))} onChange={(event) => onChange(event.target.value)} onBlur={() => onChange(formatMoneyInput(value))} /></div>;
}

function ResourceList({ kind, items, goals, onAdd, onEdit, onDelete }: {
  kind: ResourceKind; items: Resource[]; goals: Goal[]; onAdd: () => void; onEdit: (item: Resource) => void; onDelete: (item: Resource) => void;
}) {
  const config = {
    asset: { title: "资产明细", description: "记录当前价值、流动性和这笔钱承担的目标。", add: "添加资产", empty: "还没有录入资产", emptyText: "从银行存款、基金、股票或房产开始。", icon: Landmark },
    liability: { title: "负债明细", description: "记录未偿余额、月供和剩余期限。", add: "添加负债", empty: "目前没有负债记录", emptyText: "没有负债也可以保持为空；如有房贷或信用卡，请如实录入。", icon: Banknote },
    goal: { title: "人生目标", description: "把未来要完成的事情转换为金额与时间约束。", add: "创建目标", empty: "还没有人生目标", emptyText: "可以从购房、退休、教育或一次职业间歇开始。", icon: Target },
  }[kind];
  return <>
    <div className="section-heading"><div><p className="eyebrow">财富底账</p><h1 className="mt-2 text-2xl font-semibold">{config.title}</h1><p>{config.description}</p></div><button className="button-primary" onClick={onAdd}><Plus size={16} />{config.add}</button></div>
    {items.length === 0 ? <EmptyState icon={config.icon} title={config.empty} description={config.emptyText} action={config.add} onAdd={onAdd} /> : <div className="mt-7 overflow-hidden border border-slate-200 bg-white">
      <div className="hidden grid-cols-[1.6fr_1fr_1fr_86px] border-b border-slate-200 bg-slate-50 px-5 py-3 text-xs font-medium text-slate-500 sm:grid"><span>名称</span><span>{kind === "goal" ? "目标金额" : "当前金额"}</span><span>{kind === "asset" ? "流动性 / 用途" : kind === "liability" ? "月供 / 期限" : "目标日期"}</span><span /></div>
      {items.map((item) => <ResourceRow key={item.id} kind={kind} item={item} goals={goals} onEdit={() => onEdit(item)} onDelete={() => onDelete(item)} />)}
    </div>}
  </>;
}

function ResourceRow({ kind, item, goals, onEdit, onDelete }: { kind: ResourceKind; item: Resource; goals: Goal[]; onEdit: () => void; onDelete: () => void }) {
  const asset = kind === "asset" ? item as Asset : null;
  const liability = kind === "liability" ? item as Liability : null;
  const goal = kind === "goal" ? item as Goal : null;
  const amount = asset?.currentValueMinor ?? liability?.outstandingBalanceMinor ?? goal?.targetAmountMinor ?? "0";
  const typeLabel = asset ? labelFor(labels.assetType, asset.type) : liability ? labelFor(labels.liabilityType, liability.type) : "人生目标";
  const detail = asset ? `${labelFor(labels.liquidity, asset.liquidityLevel)} · ${asset.goalId ? goals.find((g) => g.id === asset.goalId)?.name ?? "目标资金" : "暂未关联目标"}` : liability ? `${formatMoney(BigInt(liability.monthlyPaymentMinor))}/月 · ${liability.remainingMonths ? `${liability.remainingMonths} 个月` : "期限未填"}` : new Date(goal!.targetDate).toLocaleDateString("zh-CN", { year: "numeric", month: "short" });
  return <div className="grid gap-3 border-b border-slate-100 px-4 py-4 last:border-0 sm:grid-cols-[1.6fr_1fr_1fr_86px] sm:items-center sm:px-5">
    <div className="min-w-0"><p className="truncate text-sm font-semibold">{item.name}</p><p className="mt-1 text-xs text-slate-500">{typeLabel}</p></div>
    <p className="text-base font-semibold tabular-nums sm:text-sm">{formatMoney(BigInt(amount))}</p>
    <p className="text-xs text-slate-500">{detail}</p>
    <div className="flex gap-1 sm:justify-end"><button className="icon-button" onClick={onEdit} title="编辑"><Pencil size={15} /></button><button className="icon-button text-rose-600 hover:bg-rose-50" onClick={onDelete} title="删除"><Trash2 size={15} /></button></div>
  </div>;
}

function EmptyState({ icon: Icon, title, description, action, onAdd }: { icon: typeof Banknote; title: string; description: string; action: string; onAdd: () => void }) {
  return <div className="mt-8 flex min-h-80 flex-col items-center justify-center border border-dashed border-slate-300 bg-white px-6 text-center"><span className="grid size-12 place-items-center bg-slate-100 text-slate-600"><Icon size={22} /></span><h2 className="mt-5 text-base font-semibold">{title}</h2><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">{description}</p><button className="button-primary mt-5" onClick={onAdd}><Plus size={16} />{action}</button></div>;
}

function ResourceEditor({ editor, saving, onClose, onSave }: { editor: { kind: ResourceKind; item?: Resource }; saving: boolean; onClose: () => void; onSave: (kind: ResourceKind, item: Resource | undefined, body: object) => void }) {
  const { kind, item } = editor;
  const asset = kind === "asset" ? item as Asset | undefined : undefined;
  const liability = kind === "liability" ? item as Liability | undefined : undefined;
  const goal = kind === "goal" ? item as Goal | undefined : undefined;
  const [installment, setInstallment] = useState(liability?.isInstallment ?? false);
  const title = `${item ? "编辑" : "添加"}${kind === "asset" ? "资产" : kind === "liability" ? "负债" : "目标"}`;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      if (kind === "asset") onSave(kind, item, { name: data.get("name"), currentValueMinor: yuanToMinor(data.get("amount")), currency: "CNY", isAdjustable: data.get("isAdjustable") === "on" });
      if (kind === "liability") {
        const optionalMoney = (name: string) => data.get(name) ? yuanToMinor(data.get(name)) : null;
        onSave(kind, item, installment ? { name: data.get("name"), type: liability?.type, isInstallment: true, outstandingBalanceMinor: null, monthlyPaymentMinor: optionalMoney("monthlyPayment"), remainingMonths: data.get("remainingMonths") ? Number(data.get("remainingMonths")) : null, totalRepaymentMinor: optionalMoney("totalRepayment"), principalMinor: optionalMoney("principal"), interestMinor: optionalMoney("interest"), repaymentMethod: data.get("repaymentMethod") || null } : { name: data.get("name"), type: liability?.type, isInstallment: false, outstandingBalanceMinor: yuanToMinor(data.get("amount")), monthlyPaymentMinor: null, remainingMonths: null, totalRepaymentMinor: null, principalMinor: null, interestMinor: null, repaymentMethod: null });
      }
      if (kind === "goal") onSave(kind, item, { name: data.get("name"), type: goal?.type ?? "OTHER", targetAmountMinor: yuanToMinor(data.get("amount")), targetDate: data.get("targetDate"), preparedAmountMinor: yuanToMinor(data.get("preparedAmount")), monthlyContributionMinor: goal?.monthlyContributionMinor ?? "0", priority: goal?.priority ?? 1, isFlexible: goal?.isFlexible ?? false });
    } catch (formError) { alert(formError instanceof Error ? formError.message : "请检查输入"); }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="editor-panel" role="dialog" aria-modal="true" aria-labelledby="editor-title"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 sm:px-7"><div><p className="text-xs font-medium text-blue-700">财富底账</p><h2 id="editor-title" className="mt-1 text-lg font-semibold">{title}</h2></div><button className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></div>
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}><div className="flex-1 space-y-5 overflow-y-auto px-5 py-6 sm:px-7">
      <Field label="名称"><input name="name" required maxLength={60} defaultValue={item?.name ?? ""} placeholder={kind === "asset" ? "例如：招商银行活期" : kind === "liability" ? "例如：自住房贷款" : "例如：三年后购房"} autoFocus /></Field>
      {kind === "asset" && <><MoneyField name="amount" label="当前价值" value={asset?.currentValueMinor} required /><CheckField name="isAdjustable" label="Agent可以规划调配" description="允许agent在制定计划中对该资产进行增减" defaultChecked={asset?.isAdjustable ?? true} /></>}
      {kind === "liability" && <><label className="flex items-center gap-3 text-sm"><input type="checkbox" className="size-4 accent-blue-700" checked={installment} onChange={(event) => setInstallment(event.target.checked)} />这是分期负债</label>{installment ? <div className="grid gap-5 sm:grid-cols-2"><MoneyField name="monthlyPayment" label="月供" value={liability?.monthlyPaymentMinor} required /><Field label="期限（月）"><input name="remainingMonths" type="number" min="1" max="1200" required defaultValue={liability?.remainingMonths ?? ""} /></Field><MoneyField name="totalRepayment" label="本息和" value={liability?.totalRepaymentMinor ?? undefined} blankWhenMissing /><MoneyField name="principal" label="本金" value={liability?.principalMinor ?? undefined} blankWhenMissing /><MoneyField name="interest" label="利息" value={liability?.interestMinor ?? undefined} blankWhenMissing /><Field label="还款方式"><select name="repaymentMethod" required defaultValue={liability?.repaymentMethod ?? ""}><option value="" disabled>请选择</option><option value="EQUAL_PAYMENT">等额本息</option><option value="EQUAL_PRINCIPAL">等额本金</option></select></Field><p className="text-xs leading-5 text-slate-500 sm:col-span-2">填写本息和后，本金和利息可以留空；同时填写时，三者必须一致。</p></div> : <MoneyField name="amount" label="金额" value={liability?.outstandingBalanceMinor} required />}</>}
      {kind === "goal" && <><MoneyField name="amount" label="目标金额" value={goal?.targetAmountMinor} required /><Field label="目标日期"><input name="targetDate" type="date" min={TOMORROW_DATE} required defaultValue={goal?.targetDate?.slice(0, 10) ?? ""} /></Field><MoneyField name="preparedAmount" label="已准备金额" value={goal?.preparedAmountMinor} /></>}
    </div><div className="flex justify-end gap-2 border-t border-slate-200 bg-white px-5 py-4 sm:px-7"><button type="button" className="button-secondary" onClick={onClose}>取消</button><button className="button-primary" disabled={saving}>{saving && <LoaderCircle className="animate-spin" size={16} />}{item ? "保存修改" : "加入底账"}</button></div></form>
  </section></div>;
}

function ConfirmDelete({ deleting, saving, onCancel, onConfirm }: { deleting: { kind: ResourceKind; item: Resource }; saving: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="dialog-backdrop"><section className="w-[min(420px,calc(100%-2rem))] bg-white p-6 shadow-2xl" role="alertdialog" aria-modal="true"><span className="grid size-10 place-items-center bg-rose-50 text-rose-600"><Trash2 size={19} /></span><h2 className="mt-5 text-lg font-semibold">删除“{deleting.item.name}”？</h2><p className="mt-2 text-sm leading-6 text-slate-500">记录将从底账中移除并保留审计轨迹。{deleting.kind === "goal" ? "与它关联的资产不会被删除，只会解除目标关联。" : ""}</p><div className="mt-6 flex justify-end gap-2"><button className="button-secondary" onClick={onCancel}>取消</button><button className="button-danger" onClick={onConfirm} disabled={saving}>{saving && <LoaderCircle className="animate-spin" size={16} />}确认删除</button></div></section></div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function MoneyField({ name, label, value, required = false, blankWhenMissing = false }: { name: string; label: string; value?: string; required?: boolean; blankWhenMissing?: boolean }) {
  return <Field label={label}><div className="money-input"><span>¥</span><input name={name} inputMode="decimal" required={required} defaultValue={blankWhenMissing && value === undefined ? "" : minorToYuan(value)} placeholder="0.00" onFocus={(event) => { event.currentTarget.value = event.currentTarget.value.replace(/,/g, ""); }} onBlur={(event) => { event.currentTarget.value = formatMoneyInput(event.currentTarget.value); }} /></div></Field>;
}

function CheckField({ name, label, description, defaultChecked }: { name: string; label: string; description: string; defaultChecked: boolean }) {
  return <label className="flex cursor-pointer items-start gap-3 border border-slate-200 p-3.5"><input name={name} type="checkbox" defaultChecked={defaultChecked} className="mt-0.5 size-4 accent-blue-700" /><span><span className="block text-sm font-medium text-slate-800">{label}</span><span className="mt-1 block text-xs leading-5 text-slate-500">{description}</span></span></label>;
}
