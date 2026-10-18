import type { TaskBoardSnapshot, TaskStatus, TaskRecord, PhaseRecord } from "./types";
import type { SupervisorState } from "./supervisor";
import type { PreflightState } from "./preflight";
import type { FlowFacts } from "./flow";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

// ── Public Types ──

export type UiSource =
  | "board"
  | "supervisor"
  | "preflight"
  | "host"
  | "journal"
  | "receipt"
  | "repair";

export type UiLine = Readonly<{
  text: string;
  source: UiSource;
  level: "info" | "warning" | "error";
}>;

export type UiScope = Readonly<{
  sessionId: string;
  leafId: string | null;
  generation: number;
  capturedAt: number;
}>;

export type UiDocument = Readonly<{
  id: "overview" | "acceptance" | "current-board-request" | "latest-board-response" | "preflight";
  title: string;
  availability: "available" | "unknown" | "absent";
  text: string;
  reason?: string;
}>;

export type UiTaskSummary = Readonly<{
  id: string;
  title: string;
  phase: number;
  status: TaskStatus;
  notes: readonly string[];
}>;

export type UiGoal = Readonly<{ source: "supervisor" | "preflight"; text: string }>;

export type UiCounts = Readonly<{
  total: number;
  done: number;
  abandoned: number;
  unfinished: number;
}>;

export type UiSummary = Readonly<{
  scope: UiScope;
  visible: boolean;
  goals: readonly UiGoal[];
  headline: UiLine;
  blockers: readonly UiLine[];
  next: UiLine;
  counts: UiCounts;
  phase?: string;
  tasks: readonly UiTaskSummary[];
  acceptance: string;
}>;

export type UiBoardView = Readonly<{
  summary: UiSummary;
  board: Readonly<TaskBoardSnapshot>;
  documents: readonly UiDocument[];
}>;

export type { UiViewEnvironment } from "./ui-environment";

export interface UiSummaryInput {
  readonly scope: UiScope;
  readonly board: Readonly<TaskBoardSnapshot>;
  readonly facts: Readonly<FlowFacts>;
  readonly supervisor?: Readonly<SupervisorState>;
  readonly preflight?: Readonly<PreflightState>;
  readonly repairs?: Readonly<{ board: boolean; preflight: boolean }>;
  readonly limits: Readonly<{ reviews: number; continuations: number; stagnant: number }>;
  readonly ownerNext?: string;
  readonly preflightDisplay?: Readonly<{ label: string; next: string }>;
}

// ── Helpers ──

function safeDisplayText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deepFreeze<T>(obj: T): Readonly<T> {
  if (obj === null || typeof obj !== "object") return obj;
  Object.freeze(obj);
  for (const value of Object.values(obj as Record<string, unknown>)) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      deepFreeze(value);
    }
  }
  return obj;
}

function line(text: string, source: UiSource, level: UiLine["level"]): UiLine {
  return { text: safeDisplayText(text), source, level };
}

function cloneScope(scope: UiScope): UiScope {
  return { ...scope };
}

// ── Identity Checks ──

function isForeignSupervisor(input: UiSummaryInput): boolean {
  const { supervisor, scope } = input;
  return supervisor !== undefined && supervisor.sessionId !== scope.sessionId;
}

function hasIdentityIssue(input: UiSummaryInput): boolean {
  return (
    isForeignSupervisor(input) ||
    (input.preflight !== undefined && input.preflight.sessionId !== input.scope.sessionId) ||
    input.facts.sessionId !== input.scope.sessionId
  );
}

function isSameSessionSupervisor(input: UiSummaryInput): boolean {
  const { supervisor, scope } = input;
  return supervisor !== undefined && supervisor.sessionId === scope.sessionId;
}

// ── Counts ──

function computeCounts(tasks: readonly TaskRecord[]): UiCounts {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const abandoned = tasks.filter((t) => t.status === "abandoned").length;
  return { total, done, abandoned, unfinished: total - done - abandoned };
}

// ── Goals ──

function computeGoals(input: UiSummaryInput): UiGoal[] {
  const goals: UiGoal[] = [];
  if (isSameSessionSupervisor(input) && input.supervisor) {
    goals.push({ source: "supervisor", text: safeDisplayText(input.supervisor.goal) });
  }
  if (input.preflight && input.preflight.sessionId === input.scope.sessionId) {
    goals.push({ source: "preflight", text: safeDisplayText(input.preflight.goal) });
  }
  return goals;
}

// ── Phase ──

function computePhase(phases: readonly PhaseRecord[]): string | undefined {
  const active = phases.find((p) => p.status === "active");
  if (!active) return undefined;
  return active.title ? safeDisplayText(active.title) : String(active.phase);
}

// ── Task Notes ──

function findTaskById(tasks: readonly TaskRecord[], id: string): TaskRecord | undefined {
  return tasks.find((t) => t.id === id);
}

function findPhaseByNumber(phases: readonly PhaseRecord[], phase: number): PhaseRecord | undefined {
  return phases.find((p) => p.phase === phase);
}

function computeTaskNotes(
  task: TaskRecord,
  tasks: readonly TaskRecord[],
  phases: readonly PhaseRecord[],
): string[] {
  const notes: string[] = [];
  for (const depId of task.dependencies) {
    const dep = findTaskById(tasks, depId);
    if (!dep || dep.status !== "done") {
      notes.push(`依赖 ${safeDisplayText(depId)} 未完成`);
    }
  }
  if (task.status === "draft") {
    notes.push("未编译");
  }
  if (task.status === "configured") {
    const phase = findPhaseByNumber(phases, task.phase);
    if (phase && phase.status === "pending") {
      notes.push("所在阶段待处理");
    }
  }
  if (task.executionRef) {
    notes.push("执行状态未知");
  }
  return notes;
}

// ── Task Summaries ──

function computeTaskSummaries(
  tasks: readonly TaskRecord[],
  phases: readonly PhaseRecord[],
): UiTaskSummary[] {
  return tasks.map((task) => ({
    id: safeDisplayText(task.id),
    title: safeDisplayText(task.title),
    phase: task.phase,
    status: task.status,
    notes: computeTaskNotes(task, tasks, phases),
  }));
}

// ── Visibility ──

function hasOnlyHistoricalPreflight(input: UiSummaryInput): boolean {
  const { preflight, supervisor } = input;
  if (!preflight) return true;
  if (!supervisor || !supervisor.preflightBinding) return false;
  const binding = supervisor.preflightBinding;
  return (
    preflight.phase === "started" &&
    preflight.goal === supervisor.goal &&
    preflight.preflightId === binding.preflightId &&
    preflight.planId === binding.planId &&
    preflight.planDigest === binding.planDigest
  );
}

/** Explicit stop leaves history, not a resident work indicator. Independent attention stays visible. */
function isQuietStoppedHistory(input: UiSummaryInput): boolean {
  const { board, supervisor, facts, repairs } = input;
  if (supervisor?.sessionId !== input.scope.sessionId || supervisor.status !== "stopped")
    return false;
  if (supervisor.pending || ["active", "waiting_for_decision"].includes(board.workflowStatus))
    return false;
  if (board.tasks.some((task) => task.executionRef)) return false;
  if (!hasOnlyHistoricalPreflight(input)) return false;
  return ![
    board.decision,
    repairs?.board,
    repairs?.preflight,
    facts.journalFault,
    facts.receiptIssue,
    facts.preflightIssue,
  ].some(Boolean);
}

function computeVisible(
  input: UiSummaryInput,
  counts: UiCounts,
  goals: readonly UiGoal[],
): boolean {
  const { board, facts, repairs } = input;
  if (hasIdentityIssue(input)) return true;
  if (isQuietStoppedHistory(input)) return false;
  if (goals.length > 0) return true;
  if (counts.total > 0) return true;
  if (board.workflowStatus !== "inactive") return true;
  if (board.decision) return true;
  if (repairs?.board || repairs?.preflight) return true;
  if (facts.journalFault || facts.receiptIssue || facts.preflightIssue) return true;
  return false;
}

// ── Blockers ──

function collectFaultBlockers(facts: Readonly<FlowFacts>): UiLine[] {
  const blockers: UiLine[] = [];
  if (facts.journalFault) {
    blockers.push(line(facts.journalFault, "journal", "error"));
  }
  if (facts.receiptIssue) {
    blockers.push(line(facts.receiptIssue, "receipt", "error"));
  }
  if (facts.preflightIssue) {
    blockers.push(line(facts.preflightIssue, "preflight", "warning"));
  }
  return blockers;
}

function collectRepairBlockers(
  repairs: Readonly<{ board: boolean; preflight: boolean }> | undefined,
): UiLine[] {
  const blockers: UiLine[] = [];
  if (repairs?.board) {
    blockers.push(line("Board repair pending", "repair", "warning"));
  }
  if (repairs?.preflight) {
    blockers.push(line("Preflight repair pending", "repair", "warning"));
  }
  return blockers;
}

function collectBoardBlockers(board: Readonly<TaskBoardSnapshot>): UiLine[] {
  const blockers: UiLine[] = [];
  if (board.decision) {
    const text =
      board.decision.response === "rejected"
        ? `Decision ${board.decision.id}: rejected`
        : `Decision ${board.decision.id}: ${board.decision.question}`;
    blockers.push(line(text, "board", "warning"));
  }
  if (board.pauseReason) {
    blockers.push(line(board.pauseReason, "board", "warning"));
  }
  return blockers;
}

function collectSupervisorBlockers(
  supervisor: Readonly<SupervisorState> | undefined,
  limits: Readonly<{ reviews: number; continuations: number; stagnant: number }>,
  capturedAt: number,
): UiLine[] {
  const blockers: UiLine[] = [];
  if (!supervisor) return blockers;
  if (supervisor.reason) {
    blockers.push(line(supervisor.reason, "supervisor", "warning"));
  }
  if (supervisor.holdCause) {
    blockers.push(line(`Hold: ${supervisor.holdCause}`, "supervisor", "warning"));
  }
  if (supervisor.reviews >= limits.reviews) {
    blockers.push(
      line(
        `Reviews limit reached: ${supervisor.reviews}/${limits.reviews}`,
        "supervisor",
        "warning",
      ),
    );
  }
  if (supervisor.continuations >= limits.continuations) {
    blockers.push(
      line(
        `Continuations limit reached: ${supervisor.continuations}/${limits.continuations}`,
        "supervisor",
        "warning",
      ),
    );
  }
  if (supervisor.stagnant >= limits.stagnant) {
    blockers.push(
      line(
        `Stagnant limit reached: ${supervisor.stagnant}/${limits.stagnant}`,
        "supervisor",
        "warning",
      ),
    );
  }
  if (supervisor.externalWait && supervisor.externalWait.deadlineAt <= capturedAt) {
    blockers.push(line("External wait expired", "supervisor", "warning"));
  }
  return blockers;
}

function collectHostBlockers(facts: Readonly<FlowFacts>): UiLine[] {
  const blockers: UiLine[] = [];
  if (!facts.idle) {
    blockers.push(line("Host run busy", "host", "warning"));
  }
  if (facts.pending) {
    blockers.push(line("Pending messages", "host", "warning"));
  }
  return blockers;
}

function collectBlockers(input: UiSummaryInput): UiLine[] {
  return [
    ...(hasIdentityIssue(input) ? [line("当前状态身份需检查", "host", "error")] : []),
    ...collectFaultBlockers(input.facts),
    ...collectRepairBlockers(input.repairs),
    ...collectBoardBlockers(input.board),
    ...collectSupervisorBlockers(
      isSameSessionSupervisor(input) ? input.supervisor : undefined,
      input.limits,
      input.scope.capturedAt,
    ),
    ...collectHostBlockers(input.facts),
  ];
}

// ── Preflight Gate Exception ──

function hasEffectivePreflightBinding(input: UiSummaryInput): boolean {
  const { supervisor } = input;
  if (!supervisor || supervisor.sessionId !== input.scope.sessionId) return false;
  if (supervisor.status === "stopped") return false;
  return supervisor.preflightBinding !== undefined;
}

function isPreflightGateException(input: UiSummaryInput): boolean {
  const { preflight, facts, scope } = input;
  if (!facts.preflightIssue) return false;
  if (!preflight || preflight.sessionId !== scope.sessionId) return false;
  const gatePhases: ReadonlySet<string> = new Set([
    "planning",
    "awaiting_authorization",
    "approved",
  ]);
  if (!gatePhases.has(preflight.phase)) return false;
  if (preflight.started) return false;
  if (hasEffectivePreflightBinding(input)) return false;
  if (facts.journalFault || facts.receiptIssue) return false;
  if (hasIdentityIssue(input)) return false;
  return true;
}

// ── Headline/Next Levels ──

type HeadlineResult = Readonly<{ headline: UiLine; next: UiLine }>;

function headlineNextLevel1(
  input: UiSummaryInput,
  gateException: boolean,
): HeadlineResult | undefined {
  const { facts, scope } = input;
  const hasIdentity = hasIdentityIssue(input);
  const hasFault = Boolean(facts.journalFault);
  const hasReceipt = Boolean(facts.receiptIssue);
  const hasExpired = hasExpiredExternalWait(input, scope.capturedAt);
  const hasPreflight = Boolean(facts.preflightIssue) && !gateException;
  if (!hasIdentity && !hasFault && !hasReceipt && !hasExpired && !hasPreflight) return undefined;
  return buildLevel1Result(hasIdentity, hasFault, hasReceipt, hasExpired, hasPreflight);
}

function hasExpiredExternalWait(input: UiSummaryInput, capturedAt: number): boolean {
  return (
    isSameSessionSupervisor(input) &&
    input.supervisor !== undefined &&
    input.supervisor.externalWait !== undefined &&
    input.supervisor.externalWait.deadlineAt <= capturedAt
  );
}

function buildLevel1Result(
  hasIdentity: boolean,
  hasFault: boolean,
  hasReceipt: boolean,
  hasExpired: boolean,
  hasPreflight: boolean,
): HeadlineResult {
  const headlineText = hasIdentity ? "身份需检查" : "需检查";
  const headlineSource = selectLevel1Source(
    hasIdentity,
    hasFault,
    hasReceipt,
    hasExpired,
    hasPreflight,
  );
  const headline = line(headlineText, headlineSource, "error");
  const nextSource = selectLevel1NextSource(
    hasReceipt,
    hasIdentity,
    hasFault,
    hasExpired,
    hasPreflight,
  );
  const next = line("下一步未一致确认，请查看状态", nextSource, "error");
  return { headline, next };
}

function selectLevel1Source(
  hasIdentity: boolean,
  hasFault: boolean,
  hasReceipt: boolean,
  hasExpired: boolean,
  hasPreflight: boolean,
): UiSource {
  if (hasIdentity) return "host";
  if (hasFault) return "journal";
  if (hasReceipt) return "receipt";
  if (hasExpired) return "supervisor";
  if (hasPreflight) return "preflight";
  return "journal";
}

function selectLevel1NextSource(
  hasReceipt: boolean,
  hasIdentity: boolean,
  hasFault: boolean,
  hasExpired: boolean,
  hasPreflight: boolean,
): UiSource {
  if (hasReceipt) return "receipt";
  if (hasIdentity) return "host";
  if (hasFault) return "journal";
  if (hasExpired) return "supervisor";
  if (hasPreflight) return "preflight";
  return "journal";
}

function headlineNextLevel2(input: UiSummaryInput): HeadlineResult | undefined {
  const { repairs } = input;
  if (!repairs?.board && !repairs?.preflight) return undefined;
  const headline = line("确认或回应已保存，状态同步未完成", "repair", "warning");
  const next = line("查看状态，勿重复确认/启动", "repair", "warning");
  return { headline, next };
}

function headlineNextLevel3(input: UiSummaryInput): HeadlineResult | undefined {
  const { preflight, board, scope } = input;
  const preflightRevoked =
    preflight &&
    preflight.sessionId === scope.sessionId &&
    (preflight.phase === "revoked" || preflight.phase === "interrupted");
  const decisionRejected = board.decision?.response === "rejected";
  if (!preflightRevoked && !decisionRejected) return undefined;
  if (preflightRevoked && preflight.phase === "interrupted")
    return {
      headline: line("执行前流程已中断，需要检查", "preflight", "warning"),
      next: line("先检查状态，不要重放已有执行", "preflight", "warning"),
    };
  const headline = line("权限已撤销或范围未获允许", "board", "warning");
  const next = line("先检查状态或由 Main 修改完整请求，不重复催问", "board", "warning");
  return { headline, next };
}

function headlineNextLevel4(input: UiSummaryInput): HeadlineResult | undefined {
  const { board } = input;
  if (!board.decision) return undefined;
  if (board.decision.response === "rejected") return undefined;
  if (board.decision.spec) {
    const headline = line("等待原生回应", "board", "info");
    const next = line("等待原生回应", "board", "info");
    return { headline, next };
  }
  const headline = line("旧请求待 Main 完整替换", "board", "warning");
  const next = line("由 Main 修改完整请求", "board", "warning");
  return { headline, next };
}

function headlineNextLevel5(input: UiSummaryInput): HeadlineResult | undefined {
  const { facts } = input;
  if (facts.idle && !facts.pending) return undefined;
  const headline = line("宿主工作中", "host", "info");
  const next = line("等待宿主当前工作和待处理消息", "host", "info");
  return { headline, next };
}

function headlineNextLevel6(input: UiSummaryInput): HeadlineResult | undefined {
  const { board, ownerNext } = input;
  const boardPaused = board.workflowStatus === "paused";
  const supervisorHeld = isSupervisorHeld(input);
  const budgetExhausted = isBudgetExhausted(input);
  if (!boardPaused && !supervisorHeld && !budgetExhausted) return undefined;
  const headlineText = buildLevel6HeadlineText(input, boardPaused, supervisorHeld, budgetExhausted);
  const headline = line(headlineText, "supervisor", "warning");
  const nextText = ownerNext ? safeDisplayText(ownerNext) : "查看状态";
  const next = line(nextText, "supervisor", "info");
  return { headline, next };
}

function isSupervisorHeld(input: UiSummaryInput): boolean {
  const { supervisor, scope } = input;
  return (
    supervisor !== undefined &&
    supervisor.sessionId === scope.sessionId &&
    (supervisor.status === "paused" ||
      supervisor.status === "fault" ||
      supervisor.status === "stopped")
  );
}

function isBudgetExhausted(input: UiSummaryInput): boolean {
  const { supervisor, limits, scope } = input;
  return (
    supervisor !== undefined &&
    supervisor.sessionId === scope.sessionId &&
    (supervisor.reviews >= limits.reviews ||
      supervisor.continuations >= limits.continuations ||
      supervisor.stagnant >= limits.stagnant)
  );
}

function buildLevel6HeadlineText(
  input: UiSummaryInput,
  boardPaused: boolean,
  supervisorHeld: boolean,
  budgetExhausted: boolean,
): string {
  const reasons: string[] = [];
  if (boardPaused && input.board.pauseReason) {
    reasons.push(safeDisplayText(input.board.pauseReason));
  }
  if (supervisorHeld && input.supervisor) {
    reasons.push(`Supervisor: ${input.supervisor.status}`);
    if (input.supervisor.holdCause) reasons.push(`Hold: ${input.supervisor.holdCause}`);
  }
  if (budgetExhausted) reasons.push("预算已达上限");
  return reasons.length > 0 ? reasons.join("; ") : "已暂停";
}

function headlineNextLevel7(input: UiSummaryInput): HeadlineResult | undefined {
  const { preflight, scope, preflightDisplay } = input;
  if (!preflight || preflight.sessionId !== scope.sessionId) return undefined;
  const notStartedPhases: ReadonlySet<string> = new Set([
    "planning",
    "awaiting_authorization",
    "approved",
  ]);
  if (!notStartedPhases.has(preflight.phase)) return undefined;
  if (preflight.started) return undefined;
  const headline = line(preflightDisplay?.label ?? "执行前流程待处理", "preflight", "info");
  const next = line(preflightDisplay?.next ?? "查看状态", "preflight", "info");
  return { headline, next };
}

function headlineNextLevel8(input: UiSummaryInput): HeadlineResult | undefined {
  const { supervisor, scope, board } = input;
  if (supervisor && supervisor.sessionId === scope.sessionId && supervisor.externalWait) {
    const wait = supervisor.externalWait;
    const phaseText =
      wait.phase === "results_pending"
        ? "结果待 Main 核验（最近owner报告）"
        : "等待外部结果（最近owner报告）";
    const headline = line(phaseText, "supervisor", "info");
    const next = line(phaseText, "supervisor", "info");
    return { headline, next };
  }
  const hasExecutionRef = board.tasks.some((t) => t.executionRef !== undefined);
  if (hasExecutionRef) {
    const headline = line("执行状态未知", "board", "info");
    const next = line("执行状态未知", "board", "info");
    return { headline, next };
  }
  return undefined;
}

function headlineNextLevel9(input: UiSummaryInput): HeadlineResult | undefined {
  const { supervisor, scope, preflight } = input;
  if (supervisor && supervisor.sessionId === scope.sessionId) {
    switch (supervisor.status) {
      case "reviewing":
        return {
          headline: line("监督检查中", "supervisor", "info"),
          next: line("监督检查中", "supervisor", "info"),
        };
      case "active":
        return {
          headline: line("监督已启用", "supervisor", "info"),
          next: line(
            safeDisplayText(input.ownerNext ?? "") || "尚无已确认的下一步，请查看状态",
            "supervisor",
            "info",
          ),
        };
      case "completed":
        return {
          headline: line("监督记录已标记目标完成", "supervisor", "info"),
          next: line("监督记录已标记目标完成", "supervisor", "info"),
        };
      default:
        break;
    }
  }
  if (
    preflight &&
    preflight.sessionId === scope.sessionId &&
    preflight.phase === "started" &&
    preflight.started
  ) {
    return {
      headline: line("启动记录已保存", "preflight", "info"),
      next: line("启动记录已保存", "preflight", "info"),
    };
  }
  return undefined;
}

function headlineNextFallback(input: UiSummaryInput): HeadlineResult {
  const { board } = input;
  if (board.tasks.length === 0) {
    return {
      headline: line("暂无任务", "board", "info"),
      next: line("尚无已确认的下一步，请查看状态", "board", "info"),
    };
  }
  if (board.workflowStatus === "completed") {
    return {
      headline: line("任务记录已结束", "board", "info"),
      next: line("尚无已确认的下一步，请查看状态", "board", "info"),
    };
  }
  if (board.workflowStatus === "active") {
    const nextText = safeDisplayText(input.ownerNext ?? "") || "尚无已确认的下一步，请查看状态";
    return {
      headline: line("任务流程已启用（任务记录）", "board", "info"),
      next: line(nextText, "board", "info"),
    };
  }
  return {
    headline: line("只读规划", "board", "info"),
    next: line("尚无已确认的下一步，请查看状态", "board", "info"),
  };
}

function computeHeadlineAndNext(input: UiSummaryInput, gateException: boolean): HeadlineResult {
  return (
    headlineNextLevel1(input, gateException) ??
    headlineNextLevel2(input) ??
    headlineNextLevel3(input) ??
    headlineNextLevel4(input) ??
    headlineNextLevel5(input) ??
    headlineNextLevel6(input) ??
    headlineNextLevel7(input) ??
    headlineNextLevel8(input) ??
    headlineNextLevel9(input) ??
    headlineNextFallback(input)
  );
}

// ── Acceptance ──

function computeAcceptance(input: UiSummaryInput): string {
  const { board, supervisor, scope } = input;
  const acceptanceId = board.finalAcceptanceTaskId;
  if (!acceptanceId) return "尚未记录目标验收";
  const task = findTaskById(board.tasks, acceptanceId);
  if (!task) return "尚未记录目标验收";
  const parts: string[] = [`验收任务 ${safeDisplayText(acceptanceId)}: ${task.status}`];
  if (supervisor && supervisor.sessionId === scope.sessionId && supervisor.status === "completed") {
    parts.push("owner 记录已标记目标完成");
  }
  return parts.join("; ");
}

// ── Main Function ──

export function buildUiSummary(input: UiSummaryInput): UiSummary {
  const counts = computeCounts(input.board.tasks);
  const goals = computeGoals(input);
  const phase = computePhase(input.board.phases);
  const tasks = computeTaskSummaries(input.board.tasks, input.board.phases);
  const visible = computeVisible(input, counts, goals);
  const blockers = collectBlockers(input);
  const gateException = isPreflightGateException(input);
  const { headline, next } = computeHeadlineAndNext(input, gateException);
  const acceptance = computeAcceptance(input);
  const scope = cloneScope(input.scope);
  const summary: UiSummary = {
    scope,
    visible,
    goals,
    headline,
    blockers,
    next,
    counts,
    phase,
    tasks,
    acceptance,
  };
  return deepFreeze(summary);
}
