import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RestoreJournalRead } from "./restore-journal";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { currentRuntime, type TaskRuntime } from "./runtime";
import type { PreflightState } from "./preflight";
import { acceptanceLayersFromCache } from "./acceptance-contract";
import { advisorBudgetAssessment, type AdvisorUsage } from "./advisor-calls";
import {
  SUPERVISOR_LIMITS,
  assessSupervisorBudget,
  type SupervisorBudgetAssessment,
} from "./supervisor-budget";
export { SUPERVISOR_LIMITS } from "./supervisor-budget";
import type { ManagementState } from "./management-policy";
import { cachedScopeFlow } from "./scope-revision-journal";
import { SCOPE_REVISION_FAULT } from "./scope-revision-facts";
import { cachedProgressSummary } from "./progress-facts";
import type { FinalReviewStateV1 } from "./final-review";
import { goalControlIssue } from "./goal-scope";
import { preflightTaskIssue } from "./preflight";
import {
  approvalAction,
  PREFLIGHT_ASSOCIATION_FAULT,
  type ApprovalAction,
} from "./approval-bundle";
import { executionActivityIssue } from "./control-journal";
import type { SupervisorState } from "./supervisor";
import type { TaskBoardSnapshot, AcceptanceLayers } from "./types";

export interface FlowFacts {
  enabled: boolean;
  journalFault?: string;
  goalIssue?: string;
  goal?: Readonly<{
    sessionId: string;
    goalRunId: string;
    phase: string;
    preflightId: string;
    hasSupervisor: boolean;
    closedUnstarted: boolean;
    hasProposal: boolean;
    preflightPhase?: string;
  }>;
  preflightIssue?: string;
  approval?: Readonly<ApprovalAction>;
  scope?: ReturnType<typeof cachedScopeFlow>;
  activityIssue?: string;
  receiptIssue?: string;
  advisorUsage?: AdvisorUsage;
  budget?: Readonly<SupervisorBudgetAssessment>;
  finalReview?: Readonly<FinalReviewStateV1>;
  progress?: ReturnType<typeof cachedProgressSummary>;
  acceptance?: Readonly<AcceptanceLayers>;
  management?: Readonly<{
    mode: ManagementState["mode"];
    state: ManagementState["state"];
    context: "goal" | "board" | "unmanaged" | "unknown";
    revision: number | null;
    source: ManagementState["source"];
    lastGoal: ManagementState["lastGoal"];
    attention: ManagementState["attention"];
    loadedRevision: "unknown";
  }>;
  sessionId: string;
  idle: boolean;
  pending: boolean;
}

function currentGoalFacts(): FlowFacts["goal"] {
  const runtime = currentRuntime();
  const goal = runtime.goal;
  if (!goal?.current || (runtime.management && runtime.management.activeWorkOwner?.kind !== "goal"))
    return undefined;
  const current = goal.current;
  return {
    sessionId: goal.sessionId,
    goalRunId: current.scope.goalRunId,
    phase: current.phase,
    preflightId: current.planning.preflightId,
    hasSupervisor: current.supervisor !== null,
    closedUnstarted: current.disposition === "closed-unstarted",
    hasProposal: Boolean(runtime.preflight?.proposal),
    preflightPhase: runtime.preflight?.phase,
  };
}
function cachedFinalReview(ctx: ExtensionContext): FlowFacts["finalReview"] {
  const runtime = currentRuntime(),
    review = runtime.finalReview;
  if (
    !review ||
    (runtime.management && runtime.management.activeWorkOwner?.kind !== "goal") ||
    !runtime.supervisor ||
    review.owner.sessionId !== ctx.sessionManager.getSessionId()
  )
    return undefined;
  return review.owner.goalRunId === (runtime.goal?.current?.scope.goalRunId ?? null)
    ? review
    : undefined;
}
/** Cached presentation only: no ownership hydration, file/version capture or ledger read. */
function legacyManagementFacts(): FlowFacts["management"] {
  const runtime = currentRuntime();
  const mode =
    runtime.goal?.current || runtime.supervisor || runtime.preflight
      ? "supervised"
      : runtime.enabled
        ? "tasks"
        : "off";
  return {
    mode,
    state: "active",
    context: mode === "off" ? "unmanaged" : "unknown",
    revision: null,
    source: "legacy-compatible",
    lastGoal: null,
    attention: [],
    loadedRevision: "unknown",
  };
}
function managementFacts(): FlowFacts["management"] {
  const selected = currentRuntime().management;
  if (!selected) return legacyManagementFacts();
  return {
    mode: selected.mode,
    state: selected.state,
    context: selected.activeWorkOwner?.kind ?? (selected.mode === "off" ? "unmanaged" : "unknown"),
    revision: selected.record?.data.revision ?? null,
    source: selected.source,
    lastGoal: selected.lastGoal,
    attention: selected.attention,
    loadedRevision: "unknown",
  };
}
/** Bounded resident projection only. Does not scan/hydrate, capture files or grant authority. */
function currentApprovalState(runtime: TaskRuntime, sessionId: string) {
  const state = runtime.preflight;
  if (
    state?.sessionId !== sessionId ||
    (runtime.management && runtime.management.mode !== "supervised") ||
    (state.started && runtime.management && runtime.management.activeWorkOwner?.kind !== "goal") ||
    (runtime.goal?.current && runtime.goal.current.planning.preflightId !== state.preflightId)
  )
    return;
  return state;
}
function matchingDefinitionBlock(
  state: PreflightState,
  block: TaskRuntime["preflightDefinitionBlock"],
) {
  if (state.version !== 2 || !block) return;
  return block.preflightId === state.preflightId &&
    block.planDigest === state.planDigest &&
    block.controlEntryId === state.definitionApproval?.controlEntryId
    ? block
    : undefined;
}
export function cachedApprovalAction(sessionId: string): ApprovalAction | undefined {
  const runtime = currentRuntime(),
    state = currentApprovalState(runtime, sessionId);
  if (!state) return;
  const block = matchingDefinitionBlock(state, runtime.preflightDefinitionBlock);
  const action = approvalAction(
    state,
    Boolean(acceptanceLayersFromCache(runtime).contractId),
    block !== undefined,
  );
  if (!action || !block) return action;
  if (block.kind === "capability")
    return {
      kind: "materials",
      actor: "Main",
      proposalId: state.proposal?.contractProposalId,
      effect: `上次实际宿主检测没有合格证据通道；Main先核对工具模式与正式检查入口，不重批权限或Start。${block.reason}`,
    };
  if (block.kind === "materials")
    return {
      kind: "materials",
      actor: "Main",
      proposalId: state.proposal?.contractProposalId,
      effect: `真实输入/能力材料暂不可用；Main 先核对并补齐，不请求 Start，也不因此重批业务权限。${block.reason}`,
    };
  if (block.kind === "scope")
    return {
      kind: "permissions",
      actor: "user",
      proposalId: state.proposal?.contractProposalId,
      command: `/task-supervisor approve ${state.planId} ${state.approval?.permissionIds.join(",") || "none"}`,
      effect: "工作区身份已改变；仅定义审核不能延展旧业务许可，需要明确的新范围确认，仍不启动。",
    };
  return action;
}
function cachedBudgetFacts(managedGoal: boolean): FlowFacts["budget"] {
  const state = currentRuntime().supervisor;
  return managedGoal && state ? advisorBudgetAssessment(state) : undefined;
}
export function flowFacts(ctx: ExtensionContext, restoration?: RestoreJournalRead): FlowFacts {
  const runtime = currentRuntime();
  const managedGoal = !runtime.management || runtime.management.activeWorkOwner?.kind === "goal";
  return {
    enabled: runtime.enabled,
    journalFault: runtime.journalFault,
    goalIssue: goalControlIssue(ctx),
    goal: currentGoalFacts(),
    finalReview: cachedFinalReview(ctx),
    management: managementFacts(),
    budget: cachedBudgetFacts(managedGoal),
    progress: cachedProgressSummary(),
    acceptance: acceptanceLayersFromCache(runtime),
    scope: cachedScopeFlow(),
    approval: cachedApprovalAction(ctx.sessionManager.getSessionId()),
    activityIssue: managedGoal
      ? executionActivityIssue(ctx.sessionManager.getSessionId())
      : undefined,
    receiptIssue: !managedGoal
      ? undefined
      : runtime.receiptStore?.pendingCount
        ? "Unknown host capture requires explicit recover and fresh validation"
        : runtime.supervisor &&
            (!runtime.receiptStore || runtime.receiptStore.format === 2) &&
            runtime.supervisor.status !== "stopped"
          ? "Legacy receipt format requires explicit recover/migration for unfinished goals"
          : undefined,
    preflightIssue: !managedGoal
      ? undefined
      : preflightTaskIssue(
          ctx,
          runtime.supervisor?.status === "stopped"
            ? undefined
            : runtime.supervisor?.preflightBinding,
          restoration,
        ),
    sessionId: ctx.sessionManager.getSessionId(),
    idle: ctx.isIdle(),
    pending: ctx.hasPendingMessages(),
  };
}

/** Structural control gates apply to both joint recovery and legacy board-only resume. */
export function resumeControlIssue(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string | undefined {
  if (facts.journalFault) return "Inspect the journal before recovery";
  if (facts.goalIssue) return facts.goalIssue;
  if (facts.preflightIssue) return facts.preflightIssue;
  if (facts.scope && !facts.scope.recoveryRequired) return facts.scope.issue;
  if (!facts.idle || facts.pending || board.decision)
    return "Wait for Main and pending messages; resolve any decision before resuming";
  if (
    state &&
    (state.sessionId !== facts.sessionId ||
      state.pending ||
      ["active", "reviewing", "completed"].includes(state.status))
  )
    return "Inspect the inconsistent supervisor state before resuming";
  return undefined;
}

function controlFault(facts: FlowFacts): string | undefined {
  if (facts.journalFault) return "Inspect the journal before recovery";
  return facts.goalIssue ?? facts.scope?.issue ?? facts.preflightIssue ?? facts.receiptIssue;
}

/** Pure qualification shared by command control and read-only status projection. */
export function ordinaryResumeIssue(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState>,
  facts: FlowFacts,
): string | undefined {
  const fault = controlFault(facts);
  if (fault) return fault;
  if (!facts.enabled) return "Enable the session explicitly before control";
  if (!facts.idle || facts.pending) return "Wait for Main to be idle with no pending messages";
  if (state.sessionId !== facts.sessionId) return "Supervisor belongs to another session";
  if (board.workflowStatus !== "paused" || board.decision)
    return "Resolve the task-board gate before recovery";
  if (state.status !== "paused" || state.pending)
    return "Inspect the interrupted or inconsistent supervisor state";
  if (board.tasks.length > SUPERVISOR_LIMITS.tasks)
    return "Stop and repair the oversized plan before a new goal";
  if (state.holdCause !== "user_pause") return "Inspect the hold before explicit recover";
  const budget = facts.budget ?? assessSupervisorBudget(state, 0);
  if (budget.status !== "available") return budget.reason;
  if (state.stagnant >= SUPERVISOR_LIMITS.stagnant)
    return "Inspect the progress hold before explicit recovery";
  return undefined;
}

function heldNextStep(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState>,
  facts?: FlowFacts,
): string {
  const budget = facts?.budget ?? assessSupervisorBudget(state, 0);
  if (budget.status !== "available")
    return budget.reason ?? "Inspect unknown budget; no automatic recovery";
  if (board.workflowStatus === "completed" || board.tasks.length > SUPERVISOR_LIMITS.tasks)
    return "inspect and stop/re-plan; recover cannot reopen this board";
  if (state.status === "stopped") return "prepare a valid board and a new supervise <goal>";
  return "inspect existing work, then /task-supervisor recover (preserves spent review/continuation budget)";
}

function preflightControlBlocker(facts: FlowFacts): string | undefined {
  if (!facts.preflightIssue) return undefined;
  if (!facts.idle || facts.pending)
    return "wait for the current host run/check and pending messages";
  return `inspect preflight authorization: ${facts.preflightIssue}`;
}

function decisionNextStep(board: Readonly<TaskBoardSnapshot>, after: string): string {
  if (!board.decision?.spec)
    return `legacy decision needs a complete structured replacement from Main, then /task-supervisor decide (native; no ID)${after}`;
  if (board.decision.response === "rejected")
    return `scope rejected; request a new structured replacement before another native response${after}`;
  return `/task-supervisor decide (native response; no ID or chat approval)${after}`;
}

function decisionGateStep(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string {
  if (!board.decision || board.workflowStatus !== "waiting_for_decision")
    return "inspect inconsistent decision gate";
  const after =
    state && ["paused", "fault"].includes(state.status)
      ? `; then ${heldNextStep(board, state, facts)}`
      : "; remaining gates still apply";
  return decisionNextStep(board, after);
}

function stoppingManagementNext(
  board: Readonly<TaskBoardSnapshot>,
  facts: FlowFacts,
): string | undefined {
  if (facts.management?.state !== "stopping-with-attention") return undefined;
  const finish =
    "then repeat /task-supervisor disable after actual quiescence; no recover/start or business replay";
  if (facts.journalFault || facts.goalIssue)
    return `Automation stopped; inspect original owner/journal before any metadata repair; ${finish}`;
  if (board.decision)
    return `/task-supervisor decide (original native response only, not business restart); ${finish}`;
  if (facts.preflightIssue)
    return `Resolve the original native preflight question with its owner; revocation alone is not an answer; ${finish}`;
  return `Inspect exact existing writer/capture/control facts and repair metadata only; ${finish}`;
}
function journalNext(facts: FlowFacts): string {
  if (facts.journalFault === SCOPE_REVISION_FAULT)
    return (
      facts.scope?.next.replace("review-scope", "repair-scope") ??
      "Inspect original scope source; no recovery or replay"
    );
  return facts.journalFault === PREFLIGHT_ASSOCIATION_FAULT &&
    facts.idle &&
    !facts.pending &&
    !facts.receiptIssue &&
    !facts.activityIssue
    ? "user: /task-supervisor repair-preflight — 只精确修复已确认定义的关联；不重批、不 Start、不派发，原暂停与预算保留"
    : "inspect journal; control recovery is disabled";
}
function inactiveManagementNext(facts: FlowFacts): string | undefined {
  if (facts.management?.mode === "off")
    return "Unmanaged: ordinary host-authorized work needs no task management; explicitly choose a management mode only if wanted";
  return facts.enabled
    ? undefined
    : "/task-supervisor tasks-only (task board only), then recheck status";
}
function scopeNext(facts: FlowFacts): string | undefined {
  return facts.scope ? (facts.activityIssue ?? facts.receiptIssue ?? facts.scope.next) : undefined;
}
function flowBlocker(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string | undefined {
  const stopping = stoppingManagementNext(board, facts);
  if (stopping) return stopping;
  const planning = unstartedGoalNext(board, facts);
  if (planning) return planning;
  if (facts.journalFault) return journalNext(facts);
  if (facts.goalIssue) return `inspect goal lifecycle: ${facts.goalIssue}`;
  const inactive = inactiveManagementNext(facts);
  if (inactive) return inactive;
  if (state && state.sessionId !== facts.sessionId) return "inspect foreign supervisor identity";
  const approval = scopeNext(facts) ?? approvalNext(board, state, facts);
  if (approval) return approval;
  const preflight = preflightControlBlocker(facts);
  if (preflight) return preflight;
  if (board.decision || board.workflowStatus === "waiting_for_decision") {
    return decisionGateStep(board, state, facts);
  }
  if (!facts.idle || facts.pending)
    return "wait for the current host run/check and pending messages";
  return finalReviewNext(board, state, facts);
}

/** Cached owner observations only: status does not perform RPC or prove process liveness. */
export function externalWaitText(state: Readonly<SupervisorState> | undefined): string {
  const wait = state?.status === "active" ? state.externalWait : undefined;
  if (!wait) return "none confirmed";
  const phase = wait.phase === "active" ? "execution pending" : "results pending Main review";
  return `${phase}; last owner report ${new Date(wait.observedAt).toISOString()}; deadline ${new Date(wait.deadlineAt).toISOString()}`;
}

function unstartedGoalNext(
  board: Readonly<TaskBoardSnapshot>,
  facts: FlowFacts,
): string | undefined {
  const goal = facts.goal;
  if (
    !goal ||
    goal.hasSupervisor ||
    board.decision ||
    facts.journalFault ||
    facts.goalIssue ||
    facts.receiptIssue
  )
    return undefined;
  if (!facts.idle || facts.pending)
    return "wait for the current host run and pending messages; no automatic planning replay";
  if (goal.phase === "stopped" && goal.closedUnstarted)
    return "/task-supervisor supervise <new goal> (archive stopped history; independent new permissions/start)";
  if (!["planning", "planning-interrupted"].includes(goal.phase)) return undefined;
  const approval = approvalNext(board, undefined, facts);
  if (approval) return approval;
  if (goal.preflightPhase === "approved")
    return "/task-supervisor start (separate native first-start; approval alone does not execute)";
  if (goal.hasProposal)
    return "/task-supervisor approve (current native permission request; not chat approval)";
  return "/task-supervisor supervise --replan (same unstarted Goal, read-only), or /task-supervisor stop (end this unstarted goal)";
}

function approvalControlNext(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string | undefined {
  if (board.decision || board.workflowStatus === "waiting_for_decision")
    return decisionGateStep(board, state, facts);
  if (facts.activityIssue || facts.receiptIssue)
    return `先检查未闭合/未知执行：${facts.activityIssue ?? facts.receiptIssue}；不得自动重派或补授权`;
  if (!facts.idle || facts.pending || state?.pending)
    return "等待当前宿主调用与消息实际结束；不自动重放批准或 Start";
  return undefined;
}
function preparationNext(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  action: Readonly<ApprovalAction>,
  facts: FlowFacts,
): string | undefined {
  if (
    state?.status === "paused" &&
    !board.finalAcceptanceTaskId &&
    board.tasks.every((task) => task.status === "draft")
  )
    return `user: ${action.laterCommand} — 检查准备是否就绪，仅审核具体定义；既有暂停不变，其他门仍有效`;
  if (state?.status === "fault")
    return `${heldNextStep(board, state, facts)}；仅回到已批准备，不跳过定义审核`;
  return undefined;
}
function approvalNext(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string | undefined {
  const action = facts.approval;
  if (
    !action ||
    action.kind === "bound" ||
    ["stopped", "completed"].includes(facts.goal?.phase ?? "") ||
    (facts.goal?.phase === "fault" && action.kind !== "association")
  )
    return;
  const blocker = approvalControlNext(board, state, facts);
  if (blocker) return blocker;
  if (action.kind === "preparing") {
    const preparing = preparationNext(board, state, action, facts);
    if (preparing) return preparing;
  }
  return `${action.actor}: ${action.command ? action.command + " — " : ""}${action.effect}${action.laterCommand ? ` 完成准备后：${action.laterCommand}` : ""}`;
}
function finalReviewNext(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string | undefined {
  const review = facts.finalReview;
  if (
    !review ||
    board.workflowStatus !== "completed" ||
    !state ||
    ["stopped", "completed"].includes(facts.goal?.phase ?? "")
  )
    return undefined;
  if (facts.receiptIssue)
    return "inspect unknown host captures before review control; no automatic replay";
  if (state.status === "paused" && state.holdCause === "user_pause")
    return "/task-supervisor resume (lift the review-only human pause; business and spent limits remain closed), then retry-review";
  if (!["active", "fault"].includes(state.status)) return undefined;
  if (review.status === "needs_validation")
    return "inspect applicable final-check registration via /task-supervisor retry-review; new validation only, no task/business replay";
  if (["retryable_error", "pending", "blocked"].includes(review.status))
    return `/task-supervisor retry-review${review.attemptId ? ` ${review.attemptId}` : ""} (same Goal, read-only review; permissions and spent budget unchanged)`;
  return undefined;
}
/** Only recommends actions; an opaque execution reference never establishes liveness. */
export function nextFlowStep(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string {
  const blocker = flowBlocker(board, state, facts);
  if (blocker) return blocker;
  if (board.workflowStatus === "paused") {
    const issue = resumeControlIssue(board, state, facts);
    if (issue) return `inspect paused control state: ${issue}`;
    if (!state) return "/task-supervisor resume (board-only)";
    if (!ordinaryResumeIssue(board, state, facts))
      return "/task-supervisor resume (ordinary pause; limits unchanged)";
    return `/task-supervisor resume (board only); then ${heldNextStep(board, state, facts)}`;
  }
  switch (state?.status) {
    case "paused":
    case "fault":
      return heldNextStep(board, state, facts);
    case "stopped":
      return "prepare a valid board, then /task-supervisor supervise <goal>";
    case "completed":
      return "goal marked completed; no automatic continuation";
    case "reviewing":
      return "wait for the native Supervisor check";
    case "active":
      if (state.externalWait) {
        if (state.externalWait.deadlineAt <= Date.now())
          return "inspect expired external wait; do not relaunch the existing run";
        return "executor wakes Main; inspect delivered results, clear exact references, then obtain fresh host validation";
      }
      return "execute/review eligible tasks; finish the batch normally for the native check";
    default:
      return "execute/review eligible tasks; finish the batch normally for the native check";
  }
}

function evidenceBlockerStatus(facts: FlowFacts): string[] {
  return [
    ...(facts.preflightIssue ? [`Preflight blocker: ${facts.preflightIssue}`] : []),
    ...(facts.receiptIssue ? [`Evidence: ${facts.receiptIssue}`] : []),
  ];
}

function receiptStatusLines(): string[] {
  const s = currentRuntime().receiptStore?.stats;
  return s
    ? [
        `Receipts: ${s.count} total; cache ${s.cacheEntries}/${s.maxEntries} entries, ${s.cacheBytes}/${s.maxBytes} UTF-8 bytes; ${s.pending} unknown/in-flight; ledger v${s.format} ${s.healthy ? "healthy" : "fault"}; ${s.indexed} locator entries (linear metadata)`,
      ]
    : [];
}
function advisorStatusLines(usage: AdvisorUsage | undefined): string[] {
  return usage
    ? [
        `Advisor provider calls: ${usage.providerCalls} tracked; pending: ${usage.pendingCalls}; unknown usage: ${usage.unknownUsageCalls}; conflicts: ${usage.conflictedCalls}; untracked historical calls: ${usage.legacyCallsUnknown ? "unknown" : "none"}`,
      ]
    : ["Advisor provider calls: untracked/legacy (unknown); known subtotals are not full usage"];
}
function supervisorBudgetLine(
  state: Readonly<SupervisorState>,
  usage: AdvisorUsage | undefined,
  budget: FlowFacts["budget"],
): string {
  const spent = budget ? (budget.spentReviews ?? "unknown") : state.reviews;
  return `Budget: reviews ${spent}/${SUPERVISOR_LIMITS.reviews}; auto continuations ${state.continuations}/${SUPERVISOR_LIMITS.continuations}; stagnant ${state.stagnant}/${SUPERVISOR_LIMITS.stagnant}; advisor known tokens ${usage?.knownTokens ?? state.tokens}; known cost ${usage?.knownCost ?? state.cost}`;
}
function finalReviewStatusLines(
  board: Readonly<TaskBoardSnapshot>,
  review: FlowFacts["finalReview"],
): string[] {
  if (!review) return [];
  return [
    `Work: ${board.workflowStatus === "completed" ? "task-complete" : "not complete"}; final review: ${review.status}${review.attemptId ? ` (${review.attemptId})` : ""}; ${review.reason}; recorded version only, current applicability is rechecked by review control`,
  ];
}
export function managementStatusLines(management: FlowFacts["management"]): string[] {
  if (!management) return [];
  const last = management.lastGoal;
  return [
    `Management: ${management.mode}; ${management.state}; WorkContext: ${management.context}; mode revision ${management.revision ?? "volatile/unknown"} (${management.source})`,
    `Loaded code revision: ${management.loadedRevision}; disk changes are not proof of a running revision`,
    ...(last
      ? [
          `Last Goal: ${last.owner?.goalKey ?? "unknown"} (history only); recorded acceptance: ${last.acceptedRef ? "yes" : "not established by mode record"}; current validity: ${last.validity === "stale" ? "stale" : "needs_verification"}; not a current permission or evidence grant`,
        ]
      : []),
    ...management.attention.map((issue) => `Management attention (${issue.kind}): ${issue.reason}`),
  ];
}
function claimedBatchLine(claimed: Readonly<TaskBoardSnapshot["tasks"]>, facts: FlowFacts): string {
  const label = facts.management?.mode === "off" ? "Retained tasks (history)" : "Claimed batch";
  return `${label}: ${claimed.map((task) => task.id).join(", ") || "none"}`;
}
function supervisorStatusLines(
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string[] {
  if (!state)
    return facts.advisorUsage
      ? [
          "Advisor usage below belongs to retained history, not a renewed current budget",
          `Retained known tokens ${facts.advisorUsage.knownTokens}; known cost ${facts.advisorUsage.knownCost}; unknown calls are not known zero`,
          ...advisorStatusLines(facts.advisorUsage),
        ]
      : [];
  return [
    `Supervisor: ${state.status}${state.reason ? ` — ${state.reason}` : ""}`,
    `Hold source: ${state.holdCause ?? "unknown"}`,
    supervisorBudgetLine(state, facts.advisorUsage, facts.budget),
    ...advisorStatusLines(facts.advisorUsage),
  ];
}
export function acceptanceStatusLines(layers: Readonly<AcceptanceLayers> | undefined): string[] {
  if (!layers) return [];
  return [
    `Acceptance layers: task records ${layers.taskRecords}; host bindings ${layers.hostBindings} (not revalidated by UI); contract ${layers.contract}${layers.contractId ? ` ${layers.contractId} r${layers.revision}` : ""}; model review ${layers.modelReview}`,
    `Native manual responses: ${layers.manualResponses} physical records; current applicability unknown; person/product acceptance not inferred; definition quality needs independent review`,
  ];
}
export function formatFlowStatus(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string[] {
  const claimed = board.tasks.filter((task) => ["implementing", "reviewing"].includes(task.status));
  const lines = [
    `Session: ${facts.enabled ? "enabled" : "disabled"}`,
    ...managementStatusLines(facts.management),
    `Goal: ${state?.goal ?? "no supervised goal"}`,
    `Main: ${facts.idle ? "idle" : "host run busy (execution/settling)"}${facts.pending ? "; pending messages" : ""}`,
    claimedBatchLine(claimed, facts),
    facts.management?.mode === "off"
      ? "Next checkpoint: none; unmanaged work"
      : "Next checkpoint: native end-of-run; batch guidance only",
  ];
  lines.push(...supervisorStatusLines(state, facts));
  lines.push(...acceptanceStatusLines(facts.acceptance));
  if (facts.progress)
    lines.push(
      `Host progress: ${facts.progress.credited}/128 credited; ${facts.progress.definitions}/100 definitions; limited ${facts.progress.limited}; progress is not permission/done/acceptance`,
    );
  lines.push(...finalReviewStatusLines(board, facts.finalReview));
  lines.push(...receiptStatusLines());
  lines.push(`External wait: ${externalWaitText(state)}`);
  if (facts.journalFault) lines.push(`Fault: ${facts.journalFault}`);
  if (facts.scope) lines.push(`Scope: ${facts.scope.issue}`);
  lines.push(...evidenceBlockerStatus(facts));
  if (board.pauseReason) lines.push(`Paused: ${board.pauseReason}`);
  if (board.decision) lines.push(`Decision ${board.decision.id}: ${board.decision.question}`);
  for (const task of claimed) {
    if (task.executionRef)
      lines.push(
        `Execution ${task.id}: ${task.executionRef.source}:${task.executionRef.runId}; status unknown`,
      );
  }
  lines.push(`Next: ${nextFlowStep(board, state, facts)}`);
  return lines.map((line) =>
    stripTerminalSequences(line)
      .replace(/\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}
