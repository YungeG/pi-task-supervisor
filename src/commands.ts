import { reviewScopeRevision, repairScopeRevision, revokeScopeRevision } from "./scope-revision";
import {
  approvePreflight,
  startApprovedPreflight,
  repairPreflightProjection,
} from "./preflight-human";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { answerBoardDecision, boardHumanContext, repairBoardProjection } from "./board-human";
import { formatContinuePrompt, formatSummaryLine } from "./formatting";
import {
  flowFacts,
  formatFlowStatus,
  ordinaryResumeIssue,
  resumeControlIssue,
  SUPERVISOR_LIMITS,
} from "./flow";
import { currentRuntime } from "./runtime";
import { repairCompletionMetadata } from "./completion-intents";
import {
  verifyManualCheck,
  reviewAcceptanceContract,
  adoptPreflightAcceptance,
  preflightAssociationIssue,
  repairPreflightAcceptance,
} from "./acceptance-runtime";
import {
  requestModeChange,
  captureManagementSnapshot,
  decideAdmission,
  enableTasksMode,
  adoptSupervisedMode,
  enterPlanningMode,
  assertPlanningAdmission,
} from "./management-policy";
import { retryFinalReview, pauseFaultedFinalReview, resumePausedFinalReview } from "./final-review";
import {
  advisorUsageForCurrent,
  advisorUsageFor,
  advisorBudgetAssessment,
  type AdvisorUsage,
} from "./advisor-calls";
import { loadConfig } from "./config";
import {
  beginPreflight,
  inspectPreflightStart,
  preflightContext,
  preflightStatusLines,
  revokePreflight,
  currentPreflightRequestIssue,
  type PreflightState,
} from "./preflight";
import { showTaskList } from "./board-ui";
import { showGoalHistory } from "./goal-history-ui";
import {
  holdSupervisor,
  recoverSupervisor,
  saveSupervisor,
  supervisorNotice,
  supervisorState,
} from "./supervisor";
import { enableSessionScope, isSessionScopeEnabled, updateActiveTools } from "./scope";
import { getBoardRef, persistEntries, setBoard, updateUI, refreshUI } from "./state";
import { preflightNotice, boardNotice } from "./human-presentation";
import { cloneBoard, hasActionableTasks } from "./validation";
import { routeGoalCommand, goalStatusText, parseSuperviseArgs } from "./goal-commands";
import { goalExecutionIssue } from "./goal-scope";

function notifyError(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function continuationContent(ctx: ExtensionCommandContext): string {
  const state = supervisorState();
  const board = getBoardRef();
  return `${boardHumanContext(ctx) ?? ""}\n${preflightContext(ctx) ?? ""}\n${state?.status === "active" ? `User-recorded goal: ${state.goal}\nContinue authorized work on the task board, or prepare a complete phased plan with final acceptance. Preserve all approvals and gates. ${formatContinuePrompt(board)}` : formatContinuePrompt(board)}`;
}

function continuationHeld(): boolean {
  const state = supervisorState();
  if (!state || state.status === "stopped") return false;
  return (
    state.status !== "active" ||
    state.pending ||
    Boolean(state.externalWait) ||
    advisorBudgetAssessment(state).status !== "available" ||
    state.stagnant >= SUPERVISOR_LIMITS.stagnant
  );
}

function continueNow(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (decideAdmission(captureManagementSnapshot(ctx), { kind: "boundary" }).verdict === "deny")
    return;
  if (goalExecutionIssue(ctx) || preflightAssociationIssue(ctx)) return;
  const board = getBoardRef();
  const state = supervisorState();
  const facts = flowFacts(ctx);
  if (
    !facts.idle ||
    facts.pending ||
    facts.journalFault ||
    facts.preflightIssue ||
    facts.receiptIssue
  )
    return;
  if (continuationHeld() || board.tasks.some((task) => task.executionRef)) return;
  if (["paused", "waiting_for_decision"].includes(board.workflowStatus)) return;
  if (state?.status !== "active" && !hasActionableTasks(board)) return;
  pi.sendMessage(
    {
      customType: "continuous-tasks:continue",
      content: continuationContent(ctx),
      display: false,
      details: { generation: board.generation },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function pause(pi: ExtensionAPI, ctx: ExtensionCommandContext, reason: string): void {
  if (pauseFaultedFinalReview(pi, ctx, reason)) {
    updateUI(ctx, getBoardRef());
    return;
  }
  const board = getBoardRef();
  if (board.workflowStatus !== "active") {
    if (supervisorState())
      holdSupervisor(pi, ctx, "paused", reason || "Paused by user", "user_pause");
    else notifyError(ctx, "Pi Task Supervisor is not active");
    return;
  }
  const updated = cloneBoard(board);
  updated.workflowStatus = "paused";
  updated.pauseReason = reason || "Paused by user";
  updated.generation++;
  persistEntries(pi, { type: "pause_user", reason: updated.pauseReason }, updated);
  setBoard(updated);
  updateUI(ctx, updated);
  holdSupervisor(pi, ctx, "paused", updated.pauseReason, "user_pause");
}

function resume(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (resumePausedFinalReview(pi, ctx)) {
    updateUI(ctx, getBoardRef());
    return;
  }
  const board = getBoardRef();
  if (board.workflowStatus !== "paused") {
    notifyError(ctx, "Pi Task Supervisor is not paused");
    return;
  }
  const facts = flowFacts(ctx);
  const state = supervisorState();
  const controlIssue = resumeControlIssue(board, state, facts);
  if (controlIssue) {
    notifyError(ctx, controlIssue);
    return;
  }
  const next =
    state && !ordinaryResumeIssue(board, state, facts)
      ? {
          ...structuredClone(state),
          status: "active" as const,
          reason: undefined,
          holdCause: undefined,
          pending: false,
        }
      : undefined;
  const updated = cloneBoard(board);
  updated.workflowStatus = "active";
  updated.pauseReason = undefined;
  updated.generation++;
  updated.stagnantSettles = 0;
  currentRuntime().cancel();
  try {
    // Write Supervisor first: a partial durable restore is interrupted/faulted, never replayed.
    if (next) saveSupervisor(pi, next);
    persistEntries(pi, { type: "resume_user", supervisorResumed: Boolean(next) }, updated);
    if (next) currentRuntime().supervisor = next;
    setBoard(updated);
    updateUI(ctx, updated);
    if (state && !next) {
      ctx.ui.notify(
        `Task board resumed only; Supervisor remains ${state.status}. ${
          state.status === "stopped" || board.tasks.length > SUPERVISOR_LIMITS.tasks
            ? "Stop/re-plan a valid goal; no automatic continuation."
            : "Inspect existing work, then /task-supervisor recover (preserves spent review/continuation budget)."
        }`,
        "info",
      );
      return;
    }
    continueNow(pi, ctx);
  } catch {
    currentRuntime().supervisor = state;
    setBoard(cloneBoard(board));
    const message =
      "Resume persistence/dispatch failed; inspect journal and pending work before recovery";
    currentRuntime().journalFault = message;
    updateUI(ctx, board);
    notifyError(ctx, message);
  }
}

function withTaskDetails(ctx: ExtensionCommandContext, message: string): string {
  return ctx.hasUI && ctx.mode === "tui"
    ? `${message}\n详情：/task-supervisor tasks → 确认与回应`
    : message;
}

async function resolveDecision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id: string | undefined,
): Promise<void> {
  const board = getBoardRef();
  if (!board.decision || board.workflowStatus !== "waiting_for_decision")
    throw new Error("No decision is waiting");
  if (id !== undefined && id !== board.decision.id) throw new Error("Decision id is stale");
  await ctx.waitForIdle();
  const result = await answerBoardDecision(pi, ctx);
  const notice = boardNotice(result);
  refreshUI(ctx);
  ctx.ui.notify(withTaskDetails(ctx, notice.message), notice.level);
  if (result.status === "approved" || result.status === "answered") continueNow(pi, ctx);
}

function statusAdvisorUsage(ctx: ExtensionCommandContext): AdvisorUsage | undefined {
  try {
    const selected = captureManagementSnapshot(ctx);
    return selected.mode === "off" && selected.lastGoal?.owner
      ? advisorUsageFor(selected.lastGoal.owner)
      : advisorUsageForCurrent(ctx);
  } catch {
    return undefined;
  } // Unknown ownership never becomes a claimed zero total.
}
function status(ctx: ExtensionCommandContext): void {
  const board = getBoardRef();
  ctx.ui.notify(
    [
      `${formatSummaryLine(board)}; ${board.workflowStatus}; generation ${board.generation}; stagnant ${board.stagnantSettles}`,
      ...formatFlowStatus(board, supervisorState(), {
        ...flowFacts(ctx),
        advisorUsage: statusAdvisorUsage(ctx),
      }),
      ...preflightStatusLines(ctx),
      ...(goalStatusText() ? [goalStatusText()] : []),
    ].join("\n"),
    "info",
  );
}

async function beginPlanning(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  goal: string,
): Promise<void> {
  await ctx.waitForIdle();
  assertPlanningAdmission(ctx);
  beginPreflight(pi, ctx, goal, { consolidated: true });
  try {
    enableSessionScope(pi);
    enterPlanningMode(pi, ctx);
    updateActiveTools(pi, true);
    refreshUI(ctx);
    const content = preflightContext(ctx);
    if (!content) throw new Error("Preflight planning context changed before dispatch");
    pi.sendMessage(
      { customType: "continuous-tasks:preflight-planning", content, display: false },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  } catch {
    currentRuntime().cancel();
    currentRuntime().journalFault =
      "Preflight planning dispatch failed; inspect journal before control";
    throw new Error(currentRuntime().journalFault);
  }
}

function hasPlanningMaterial(pref: PreflightState): boolean {
  return !!(
    pref.proposal ||
    pref.approval ||
    (pref.version === 2 && (pref.permissionRequest || pref.startRequest))
  );
}
function currentPlanningGoal(ctx: ExtensionCommandContext, text: string): string | undefined {
  const request = parseSuperviseArgs(text),
    runtime = currentRuntime(),
    pref = runtime.preflight;
  const selected = captureManagementSnapshot(ctx).mode === "supervised";
  const same =
    selected &&
    pref?.sessionId === ctx.sessionManager.getSessionId() &&
    (!request.goal || pref.goal === request.goal);
  if (!request.replan)
    return same &&
      pref.phase !== "revoked" &&
      !["stopped", "completed"].includes(runtime.supervisor?.status ?? "")
      ? undefined
      : request.goal;
  if (!same)
    throw Error("--replan needs the same current unstarted Goal; it cannot create another target");
  if (pref.started || runtime.supervisor)
    throw Error(
      "Started Goal: use propose_scope_revision and review-scope, not replan or another Start",
    );
  if (hasPlanningMaterial(pref))
    throw Error(
      "Existing proposal/approval/control remains with its original owner; inspect it or submit changed material in that attempt, without moving old permission to a new attempt",
    );
  return pref.goal;
}
async function startGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planId?: string,
): Promise<void> {
  await ctx.waitForIdle();
  const planning = currentRuntime().preflight;
  if (!planning)
    throw Error("No current preflight plan; use supervise for read-only planning first");
  inspectPreflightStart(ctx, planning.goal, planId);
  const outcome = await startApprovedPreflight(pi, ctx, planId);
  const notice = preflightNotice(outcome);
  refreshUI(ctx);
  ctx.ui.notify(withTaskDetails(ctx, notice.message), notice.level);
  if (outcome.status === "started") {
    try {
      adoptSupervisedMode(pi, ctx);
      const config = await loadConfig();
      if (config.receiptCache) currentRuntime().receiptStore?.configure(config.receiptCache);
      adoptPreflightAcceptance(pi, ctx);
      continueNow(pi, ctx);
    } catch (error) {
      currentRuntime().cancel();
      currentRuntime().journalFault ??=
        "Preflight startup dispatch outcome unknown; inspect pending Main, never replay";
      throw error;
    }
  }
}

async function settleMain(ctx: ExtensionCommandContext, manual: boolean): Promise<void> {
  const runtime = currentRuntime();
  if (manual) runtime.manualPauseDepth++;
  try {
    runtime.cancel();
    if (!ctx.isIdle()) ctx.abort();
    await ctx.waitForIdle();
    if (!ctx.isIdle())
      throw new Error("Host has not settled; inspect command-context bindings before control");
  } finally {
    if (manual) runtime.manualPauseDepth--;
  }
}

async function revokeGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planId: string,
): Promise<void> {
  const planning = currentRuntime().preflight;
  if (
    !planning ||
    planning.sessionId !== ctx.sessionManager.getSessionId() ||
    planning.planId !== planId
  )
    throw new Error("Exact current-session preflight plan ID is required for revocation");
  const state = supervisorState();
  const bound =
    state?.sessionId === planning.sessionId &&
    state.status !== "stopped" &&
    state.preflightBinding?.preflightId === planning.preflightId;
  if (bound) await settleMain(ctx, true);
  else await ctx.waitForIdle();
  const revoked = revokePreflight(pi, ctx, planId);
  if (bound) {
    try {
      holdSupervisor(
        pi,
        ctx,
        "paused",
        "Human revoked preflight authorization; reapprove the exact plan and recover explicitly",
        "authorization_revoked",
      );
    } catch {
      currentRuntime().journalFault =
        "Preflight revocation hold persistence failed; inspect journal before control";
      throw new Error(currentRuntime().journalFault);
    }
  }
  updateActiveTools(pi, isSessionScopeEnabled());
  status(ctx);
  const requestIssue = currentPreflightRequestIssue(ctx, revoked);
  if (requestIssue && ctx.hasUI)
    ctx.ui.notify(
      `${requestIssue}. Permission is withdrawn. For an unanswered question, use approve and select Reject/不允许, then explicitly revoke again before archive; independent holds remain.`,
      "info",
    );
}

function repairCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, action: string): boolean {
  if (action === "repair-decision") repairBoardProjection(pi, ctx);
  else if (action === "repair-preflight") {
    if (currentRuntime().preflightRepair) repairPreflightProjection(pi, ctx);
    else repairPreflightAcceptance(pi, ctx);
  } else return false;
  status(ctx);
  return true;
}
async function verifyArtifactCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  text: string,
): Promise<void> {
  if (!text) throw new Error("Usage: /task-supervisor verify-check <checkId>");
  const result = await verifyManualCheck(pi, ctx, text);
  refreshUI(ctx);
  if (ctx.hasUI)
    ctx.ui.notify(
      result.status === "confirmed"
        ? "已记录当前版本的正式人工条件回应；这不授予业务权限、不启动或恢复任务。"
        : result.status === "unsupported"
          ? "正式人工条件回应需要受信本机原生 TUI；聊天、SDK/复制的 UI 结果不作确认。"
          : "人工条件仍未确认；没有自动重问、授权或继续任务。",
      result.status === "confirmed" ? "info" : "warning",
    );
}
async function evidenceMetadataCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (action === "review-contract") {
    if (!text) throw new Error("Usage: /task-supervisor review-contract <proposalId>");
    const result = await reviewAcceptanceContract(pi, ctx, text);
    refreshUI(ctx);
    if (ctx.hasUI)
      ctx.ui.notify(
        result.status === "bound"
          ? "验收条件与检查定义已绑定当前版本；没有新增权限、首次启动或产物接受。"
          : `契约仍未绑定：${result.status}；不会自动执行或重问。`,
        result.status === "bound" ? "info" : "warning",
      );
  } else if (action === "verify-check") await verifyArtifactCommand(pi, ctx, text);
  else if (action === "repair-completion") {
    repairCompletionMetadata(pi, ctx, text);
    status(ctx);
  } else if (action === "retry-review") {
    await retryFinalReview(pi, ctx, text || undefined);
    status(ctx);
  } else return false;
  return true;
}
async function supervisorCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (action === "supervise") {
    const goal = currentPlanningGoal(ctx, text);
    if (goal === undefined) status(ctx);
    else await beginPlanning(pi, ctx, goal);
    return true;
  }
  if (action === "start") {
    await startGoal(pi, ctx, text || undefined);
    return true;
  }
  if (await evidenceMetadataCommand(pi, ctx, action, text)) return true;
  if (action === "revoke") {
    await revokeGoal(pi, ctx, text);
    return true;
  }
  if (action === "pause" && !isSessionScopeEnabled()) return false;
  if (["pause", "recover"].includes(action)) await settleMain(ctx, action === "pause");
  if (action === "recover") {
    if (ctx.hasPendingMessages()) throw new Error("Wait for pending messages before recovery");
    recoverSupervisor(pi, ctx);
    supervisorNotice(
      pi,
      ctx,
      "Recovered explicitly. Inspect existing work before continuing; approvals are unchanged.",
    );
    continueNow(pi, ctx);
    return true;
  }
  return false;
}

async function approveCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (action !== "approve") return false;
  const [id, ...selection] = text ? text.split(/\s+/) : [];
  await ctx.waitForIdle();
  const outcome = await approvePreflight(
    pi,
    ctx,
    id,
    selection.length ? selection.join(" ") : undefined,
  );
  const notice = preflightNotice(outcome);
  refreshUI(ctx);
  ctx.ui.notify(withTaskDetails(ctx, notice.message), notice.level);
  return true;
}

function tasksOnlyNotice(ctx: ExtensionCommandContext, already: boolean): void {
  ctx.ui.notify(
    already
      ? "Task-board-only management is already selected for this session"
      : "Task-board-only management selected; no automatic Supervisor or new business permission",
    "info",
  );
}
async function readOnlyCommand(
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (action === "history") {
    await showGoalHistory(ctx, text || undefined);
    return true;
  }
  if (action === "tasks") {
    await showTaskList(ctx, getBoardRef());
    return true;
  }
  if (action === "status") {
    status(ctx);
    return true;
  }
  return false;
}
async function scopeRevisionCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (!["review-scope", "repair-scope", "revoke-scope"].includes(action)) return false;
  if (!text)
    throw Error(
      `Usage: /task-supervisor ${action} <${action === "revoke-scope" ? "revisionId" : "proposalId"}>`,
    );
  const result =
    action === "review-scope"
      ? await reviewScopeRevision(pi, ctx, text)
      : action === "repair-scope"
        ? await repairScopeRevision(pi, ctx, text)
        : await revokeScopeRevision(pi, ctx, text);
  refreshUI(ctx);
  if (ctx.hasUI)
    ctx.ui.notify(
      `范围记录：${result.status}；仍保留原权限/Start/暂停/用量，不代表恢复或验收。`,
      "info",
    );
  return true;
}
async function ownerControlCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (await scopeRevisionCommand(pi, ctx, action, text)) return true;
  if (action === "tasks-only") {
    const before = captureManagementSnapshot(ctx);
    await enableTasksMode(pi, ctx);
    updateActiveTools(pi, isSessionScopeEnabled());
    refreshUI(ctx);
    tasksOnlyNotice(ctx, before.mode === "tasks" && before.state === "active");
    return true;
  }
  if (action === "disable" || action === "stop") {
    await requestModeChange(pi, ctx, "off");
    updateActiveTools(pi, isSessionScopeEnabled());
    refreshUI(ctx);
    status(ctx);
    return true;
  }
  if (["approve", "start"].includes(action) && captureManagementSnapshot(ctx).mode !== "supervised")
    throw new Error(
      "Select a new supervised planning context; off/task-only mode cannot revive historical permission or first-start",
    );
  return routeGoalCommand(pi, ctx, action, text);
}
export function registerCommands(pi: ExtensionAPI): void {
  const command = {
    description:
      "Choose supervised planning or task-board-only management; inspect/control this session",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const [action = "status", id, ...answerParts] = args.trim().split(/\s+/);
      try {
        if (await readOnlyCommand(ctx, action, [id, ...answerParts].filter(Boolean).join(" ")))
          return;
        if (
          await ownerControlCommand(pi, ctx, action, [id, ...answerParts].filter(Boolean).join(" "))
        )
          return;
        if (repairCommand(pi, ctx, action)) return;
        if (currentRuntime().journalFault) throw new Error(currentRuntime().journalFault);
        if (await approveCommand(pi, ctx, action, [id, ...answerParts].filter(Boolean).join(" ")))
          return;
        if (
          await supervisorCommand(pi, ctx, action, [id, ...answerParts].filter(Boolean).join(" "))
        )
          return;
        if (!isSessionScopeEnabled()) {
          notifyError(
            ctx,
            "Management is off; choose /task-supervisor tasks-only for a task board or supervise <goal> for read-only planning",
          );
          return;
        }
        if (action === "pause") {
          pause(pi, ctx, [id, ...answerParts].filter(Boolean).join(" "));
          return;
        }
        if (action === "resume") {
          resume(pi, ctx);
          return;
        }
        if (action === "decide") {
          await resolveDecision(pi, ctx, id);
          return;
        }
        notifyError(
          ctx,
          "Usage: /task-supervisor supervise <goal> | supervise --replan [same unstarted goal] (-- protects literal goal text) | tasks-only | disable | approve [planId [all|none|IDs]] | start [planId] | decide [id] (native) | repair-preflight | repair-decision | revoke <planId> | status | tasks | history [goalKey|page:offset] (read-only) | pause [reason] | resume | recover | repair-completion <intentId> | verify-check <checkId> | review-contract <proposalId> | review-scope <proposalId> | repair-scope <proposalId> | revoke-scope <revisionId> | retry-review [attemptId] | stop",
        );
      } catch (error) {
        notifyError(
          ctx,
          error instanceof Error ? error.message : "Pi Task Supervisor command failed",
        );
      }
    },
  };
  pi.registerCommand("task-supervisor", command);
}
