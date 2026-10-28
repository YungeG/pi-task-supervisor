import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ContinuousTasksConfig } from "./config";
import { contractCompilationAdmission, preflightAssociationIssue } from "./acceptance-runtime";
import {
  observeFinalValidation,
  finalReviewWriteIssue,
  interruptFinalReview,
  restoreFinalReviewState,
  registeredFinalValidation,
} from "./final-review";
import {
  readControlJournal,
  currentWorkOwner,
  executionPersistenceIssue,
  isExecutionRepairRequest,
} from "./control-journal";
import { createEmptyBoard } from "./engine";
import {
  beginRestoreJournal,
  RestoreReadInvalidated,
  type RestoreJournalCycle,
} from "./restore-journal";
import { formatJournalReadError } from "./human-journal";
import { restoreBoardHuman, boardHumanContext, canReplaceBoardDecision } from "./board-human";
import { claimedExecutionRefs, executionWaitTimer, waitForExecutions } from "./async-execution";
import {
  captureManagementSnapshot,
  decideAdmission,
  restoreManagement,
  activeGoalContext,
  materializeManagement,
} from "./management-policy";
import { currentRuntime } from "./runtime";
import { existingExecutionMetadata } from "./execution-settlement";
import { preflightContext, preflightTaskIssue, restorePreflight } from "./preflight";
import { invalidateTaskWidget, TASK_WIDGET_KEY } from "./board-ui";
import { closeReadOnlyView } from "./ui-view-lifecycle";
import { loadConfig, resetConfig } from "./config";
import { formatContinuePrompt, formatHiddenContext } from "./formatting";
import {
  isSessionScopeEnabled,
  restoreSessionScope,
  TASK_TOOL_NAMES,
  setSessionScopeEnabled,
  updateActiveTools,
} from "./scope";
import { getBoardRef, persistEntries, reconstructState, setBoard, updateUI } from "./state";
import { cloneBoard, hasActionableTasks, hasBlockedNonTerminalTasks } from "./validation";
import {
  digest,
  currentExecutionWait,
  holdSupervisor,
  observeTool,
  prepareToolCapture,
  redact,
  restoreSupervisor,
  reviewSupervisor,
  saveSupervisor,
  supervisorPlanError,
  supervisorState,
  type Advisor,
  type SupervisorHoldCause,
} from "./supervisor";

import { restoreGoalLifecycle, settleGoalPlanning } from "./goal-lifecycle";
import { GoalToolLeases } from "./goal-tool-leases";
import { finalizeCompletionIntentsAtBoundary } from "./completion-intents";
import { commitTaskAdvance } from "./task-advance";
import {
  admitManagedInvocation,
  allowManagedInvocation,
  observeManagedInvocationResult,
  observeManagedInvocationEnd,
  sealManagedRootsAtBoundary,
  invocationActivityIssue,
} from "./invocation-runtime";
import {
  beginProgressCapture,
  discardUnstartedProgress,
  observeProgressFact,
  flushProgressFactsAtBoundary,
  progressSince,
} from "./progress-facts";
import {
  appendOwnerSnapshot,
  invalidateGoalCallbacks,
  goalExecutionIssue,
  goalControlIssue,
  goalScopeContext,
  goalLease,
} from "./goal-scope";

type ConfigLoader = () => Promise<ContinuousTasksConfig>;
type Control = {
  cancel: () => void;
  boundary: (
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ) => Promise<BoundaryResult | undefined>;
};

function pauseBoard(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  cause: SupervisorHoldCause = "unknown",
): void {
  const board = getBoardRef();
  if (board.workflowStatus === "active") {
    const updated = cloneBoard(board);
    updated.workflowStatus = "paused";
    updated.pauseReason = reason;
    updated.generation++;
    persistEntries(pi, { type: "pause_controller", reason, cause }, updated);
    setBoard(updated);
    updateUI(ctx, updated);
    pi.sendMessage(
      {
        customType: "continuous-tasks:notice",
        content: `Pi Task Supervisor paused: ${reason}`,
        display: true,
      },
      { triggerTurn: false },
    );
  }
  holdSupervisor(pi, ctx, "paused", reason, cause);
}

function continuation(prompt: string, action?: "guide" | "next_batch"): BoundaryResult {
  return {
    continue: true,
    entries: [
      {
        type: "custom_message",
        customType: "continuous-tasks:continue",
        content: prompt,
        display: false,
        details: { generation: getBoardRef().generation, ...(action ? { action } : {}) },
      },
    ],
  };
}

function consumePhasePrompt(pi: ExtensionAPI): string {
  const board = getBoardRef();
  if (!board.pendingPhasePrompt) return "";
  const prompt = `${board.pendingPhasePrompt.message}\n\n`;
  pi.sendMessage(
    {
      customType: "continuous-tasks:notice",
      content: `Phase ${board.pendingPhasePrompt.phase} complete.`,
      display: true,
    },
    { triggerTurn: false },
  );
  const updated = cloneBoard(board);
  updated.pendingPhasePrompt = undefined;
  updated.generation++;
  setBoard(updated);
  appendOwnerSnapshot(pi, "continuous-tasks:snapshot", updated);
  return prompt;
}

/** A signal race bounds even a provider that ignores cancellation. No automatic retry on review failure. */
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      reject(new Error("Supervisor review cancelled or timed out"));
    };
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}

function reviewSignal(controller: AbortController, ctx: ExtensionContext): AbortSignal {
  return AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(30_000),
    ...(ctx.signal ? [ctx.signal] : []),
  ]);
}

function boundaryAllowed(
  pi: ExtensionAPI,
  event: AgentBeforeSettleEvent,
  ctx: ExtensionContext,
): boolean {
  if (event.outcome !== "completed") {
    pauseBoard(
      pi,
      ctx,
      event.outcome === "aborted"
        ? "The user aborted the last run"
        : "The last run still failed after Pi retries",
      event.outcome === "aborted"
        ? currentRuntime().manualPauseDepth > 0
          ? "user_pause"
          : "run_aborted"
        : "run_failed",
    );
    return false;
  }
  return (
    // Our returned guidance entry creates runnable context when the last message is assistant.
    !event.continue &&
    !event.context.pendingMessages.length &&
    !ctx.hasPendingMessages() &&
    !["paused", "waiting_for_decision"].includes(getBoardRef().workflowStatus)
  );
}

async function supervisedBoundary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal,
  current: () => boolean,
  advisor?: Advisor,
): Promise<BoundaryResult | undefined> {
  if (!current()) return undefined;
  const advice = await cancellable(reviewSupervisor(pi, ctx, signal, advisor), signal);
  if (!advice || !current() || ctx.hasPendingMessages() || preflightAssociationIssue(ctx))
    return undefined;
  if (advice.action === "next_batch")
    return continuation(
      `[SUPERVISOR CONTROL — NOT USER APPROVAL]\nAction: next_batch. No batch is claimed and ready work remains; this is not a goal pause. Call get_ready_tasks to claim the next ready batch now. Work within the existing authorized scope; batch completion alone does not require another confirmation.\n${formatContinuePrompt(getBoardRef())}\nReview targets: ${advice.taskIds.join(", ")}\nEvidence: ${advice.evidenceRefs.join(", ") || "collect fresh tool evidence"}\nPreserve all real approvals, pauses, budgets and existing execution receipts.`,
      "next_batch",
    );
  return continuation(
    `[SUPERVISOR ADVICE — NOT USER APPROVAL]\n${advice.message}\nTasks: ${advice.taskIds.join(", ") || "prepare/repair the goal's task plan"}\nEvidence: ${advice.evidenceRefs.join(", ") || "collect fresh tool evidence"}\nPreserve all real approvals, pauses, budgets and existing execution receipts.`,
    "guide",
  );
}

function permissionBlocked(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const state = supervisorState();
  const reason =
    currentRuntime().journalFault ??
    preflightTaskIssue(ctx, state?.status === "stopped" ? undefined : state?.preflightBinding);
  if (!reason) return false;
  if (state?.preflightBinding) holdSupervisor(pi, ctx, "paused", reason, "authorization_revoked");
  return true;
}
function holdBoundaryError(pi: ExtensionAPI, ctx: ExtensionContext, error: unknown): void {
  const reason = redact(error instanceof Error ? error.message : "Continuation failed");
  const state = supervisorState();
  if (state && state.status !== "stopped")
    holdSupervisor(pi, ctx, "fault", reason, "review_failed");
  else pauseBoard(pi, ctx, reason);
}

function invocationBoundaryNeeded(): boolean {
  const runtime = currentRuntime();
  return !!(
    runtime.invocation?.attention ||
    runtime.controlJournal?.invocations?.nodes.size ||
    runtime.controlJournal?.completionIntents?.size
  );
}
async function prepareInvocationBoundary(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  sealManagedRootsAtBoundary(pi, ctx);
  const issue = invocationActivityIssue();
  if (issue) throw new Error(issue);
  await finalizeCompletionIntentsAtBoundary(pi, ctx, (edits) => commitTaskAdvance(pi, ctx, edits));
}
function boundaryAdmitted(
  pi: ExtensionAPI,
  event: AgentBeforeSettleEvent,
  ctx: ExtensionContext,
  busy: boolean,
): boolean {
  return (
    decideAdmission(captureManagementSnapshot(ctx), { kind: "boundary" }).verdict !== "deny" &&
    isSessionScopeEnabled() &&
    !busy &&
    !goalExecutionIssue(ctx) &&
    boundaryAllowed(pi, event, ctx)
  );
}
function makeController(pi: ExtensionAPI, configLoader: ConfigLoader, advisor?: Advisor): Control {
  let serial = 0;
  let inFlight: AbortController | undefined;
  let lastProgress: string | undefined;
  let stagnant = 0;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    currentRuntime().humanEpoch++;
    interruptFinalReview();
    currentRuntime().finalReviewAbort?.abort();
    currentRuntime().finalReviewAbort = undefined;
    currentRuntime().humanAbort?.abort();
    currentRuntime().humanAbort = undefined;
    serial++;
    clearTimeout(waitTimer);
    waitTimer = undefined;
    inFlight?.abort();
    inFlight = undefined;
  };
  const baseBoundary = async (
    ticket: number,
    ctx: ExtensionContext,
  ): Promise<BoundaryResult | undefined> => {
    const board = getBoardRef();
    if (board.workflowStatus !== "active") return undefined;
    const config = await configLoader();
    if (ticket !== serial || getBoardRef() !== board) return undefined;
    const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
    const progress = digest([
      board.tasks.map((task) => [task.id, task.status, task.completionEvidence]),
      owner ? progressSince({ owner }).keys : [],
    ]);
    stagnant = lastProgress === progress ? stagnant + 1 : 0;
    lastProgress = progress;
    if (stagnant >= config.maxStagnantSettles) {
      pauseBoard(
        pi,
        ctx,
        `No task-board progress across ${config.maxStagnantSettles} automatic continuations`,
        "stagnant",
      );
      return undefined;
    }
    if (hasActionableTasks(board))
      return continuation(`${consumePhasePrompt(pi)}${formatContinuePrompt(getBoardRef())}`);
    if (hasBlockedNonTerminalTasks(board))
      pauseBoard(pi, ctx, "Non-terminal tasks remain but none are actionable");
    return undefined;
  };
  const boundary = async (
    event: AgentBeforeSettleEvent,
    ctx: ExtensionContext,
  ): Promise<BoundaryResult | undefined> => {
    if (!boundaryAdmitted(pi, event, ctx, inFlight !== undefined)) return undefined;
    const controller = new AbortController();
    inFlight = controller;
    const ticket = serial;
    const lease = goalLease();
    const current = () => ticket === serial && goalLease() === lease && !goalExecutionIssue(ctx);
    const signal = reviewSignal(controller, ctx);
    try {
      const state = supervisorState();
      if (permissionBlocked(pi, ctx)) return undefined;
      if (invocationBoundaryNeeded()) {
        await prepareInvocationBoundary(pi, ctx);
        if (!current()) return undefined;
      }
      flushProgressFactsAtBoundary(pi, ctx);
      if (executionPersistenceIssue(currentWorkOwner(ctx.sessionManager.getSessionId())))
        return undefined;
      if (state && state.status !== "stopped") {
        if (
          claimedExecutionRefs(getBoardRef()).length &&
          (await waitForExecutions(pi, ctx, signal, current))
        ) {
          clearTimeout(waitTimer);
          waitTimer = executionWaitTimer(pi, ctx);
          return undefined;
        }
        return await supervisedBoundary(pi, ctx, signal, current, advisor);
      }
      return await baseBoundary(ticket, ctx);
    } catch (error) {
      if (current()) holdBoundaryError(pi, ctx, error);
      return undefined;
    } finally {
      if (inFlight === controller) inFlight = undefined;
    }
  };
  return { cancel, boundary };
}

function restoreFaultedSupervisor(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    restoreSupervisor(pi, ctx);
  } catch {
    currentRuntime().supervisor = undefined;
    currentRuntime().receiptPersistence = undefined;
  }
}

function clearOwnedUI(ctx: ExtensionContext): void {
  if (ctx.hasUI) {
    if (ctx.mode === "tui") {
      const keys = ["til-done", "til-done-active", "continuous-supervisor"];
      for (const key of [...keys, TASK_WIDGET_KEY]) {
        try {
          if (key === TASK_WIDGET_KEY) ctx.ui.setWidget(key, undefined);
          else ctx.ui.setStatus(key, undefined);
        } catch {
          // Shutdown cleanup is best-effort and owns no other extension's keys.
        }
      }
    } else ctx.ui.setStatus("continuous-supervisor", undefined);
  }
}

function reportRestoreFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: ReturnType<typeof createEmptyBoard>,
  error: unknown,
): void {
  // Do not reinterpret malformed durable state as an inactive, safe-to-continue supervisor.
  const diagnostic = formatJournalReadError(error);
  const reason = diagnostic
    ? `Journal restore blocked: ${diagnostic}; inspect session journal state before recovery`
    : error instanceof Error && /preflight/i.test(error.message)
      ? "Invalid preflight journal; inspect session state before recovery"
      : "Invalid supervisor journal; inspect session state before recovery";
  currentRuntime().journalFault =
    board.tasks.length === 0
      ? `${reason}; task view not restored, counts unknown (saved records are not deleted)`
      : reason;
  // An unstable source exhausted its bounded read attempts: do not scan it again for UI.
  if (error instanceof RestoreReadInvalidated) {
    currentRuntime().journalFault = `${reason}; task view not restored, counts unknown (saved records are not deleted)`;
    currentRuntime().supervisor = undefined;
    currentRuntime().receiptStore = undefined;
    currentRuntime().receiptIdentity = undefined;
    currentRuntime().receiptPersistence = undefined;
    board = createEmptyBoard();
    setBoard(board);
  } else {
    // Restore only a held view after another owner's failure; no writes or replay.
    restoreFaultedSupervisor(pi, ctx);
  }
  setSessionScopeEnabled(false);
  updateActiveTools(pi, false);
  updateUI(ctx, board);
  const faultStatus = `Supervisor: fault (${diagnostic ?? "journal restore"})`;
  if (ctx.hasUI && ctx.mode !== "tui") ctx.ui.setStatus("continuous-supervisor", faultStatus);
  pi.sendMessage(
    {
      customType: "continuous-tasks:notice",
      content: `${currentRuntime().journalFault}; task continuation disabled.`,
      display: true,
    },
    { triggerTurn: false },
  );
}

function restoreSelectedManagement(
  ctx: ExtensionContext,
  board: ReturnType<typeof createEmptyBoard>,
  read: RestoreJournalCycle["read"],
): ReturnType<typeof createEmptyBoard> {
  restoreManagement(ctx);
  const runtime = currentRuntime(),
    management = runtime.management;
  if (management && management.activeWorkOwner?.kind !== "goal") runtime.finalReview = undefined;
  if (management?.mode !== "tasks") return board;
  const selected = restoreBoardHuman(ctx, reconstructState(ctx), read);
  setBoard(selected);
  return selected;
}
function retryRestoreRead(error: unknown, attempt: number): boolean {
  return (
    attempt === 0 &&
    error instanceof RestoreReadInvalidated &&
    ["source", "leaf"].includes(error.reason)
  );
}

async function restoreSession(
  pi: ExtensionAPI,
  control: Control,
  ctx: ExtensionContext,
  attempt = 0,
): Promise<void> {
  control.cancel();
  invalidateGoalCallbacks();
  const runtime = currentRuntime();
  const epoch = runtime.goalEpoch;
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId();
  invalidateTaskWidget(ctx);
  await closeReadOnlyView(ctx);
  if (
    currentRuntime() !== runtime ||
    runtime.goalEpoch !== epoch ||
    ctx.sessionManager !== manager ||
    manager.getSessionId() !== sessionId
  )
    return;
  runtime.sessionId = sessionId;
  runtime.goal = undefined;
  runtime.controlJournal = undefined;
  runtime.management = undefined;
  runtime.progress = undefined;
  runtime.invocation = undefined;
  runtime.finalValidationIntents = undefined;
  runtime.finalValidation = undefined;
  runtime.finalReview = undefined;
  let board = createEmptyBoard();
  setBoard(board);
  currentRuntime().journalFault = undefined;
  currentRuntime().preflightRepair = undefined;
  currentRuntime().preflight = undefined;
  currentRuntime().boardRepair = undefined;
  currentRuntime().boardHumanContext = undefined;
  let cycle: RestoreJournalCycle | undefined;
  try {
    const active = beginRestoreJournal(ctx);
    cycle = active;
    runtime.controlJournal = readControlJournal(ctx, active.read);
    restoreGoalLifecycle(pi, ctx, {
      read: active.read,
      install: (operation) => {
        active.installGoal(ctx, operation);
      },
      afterConfirmedAppend: (id) => {
        active.afterConfirmedAppend(ctx, id);
      },
    });
    board = restoreBoardHuman(ctx, reconstructState(ctx), active.read);
    restoreSessionScope(pi, ctx);
    setBoard(board);
    restorePreflight(ctx, active.read);
    active.runSupervisorRestore(ctx, () => {
      restoreSupervisor(pi, ctx, active.read);
    });
    restoreFinalReviewState(ctx);
    board = restoreSelectedManagement(ctx, board, active.read);
    updateUI(ctx, board, active.read);
    active.assertCurrent(ctx);
    updateActiveTools(pi, isSessionScopeEnabled());
  } catch (error) {
    if (
      currentRuntime() !== runtime ||
      ctx.sessionManager !== manager ||
      manager.getSessionId() !== sessionId ||
      (error instanceof RestoreReadInvalidated && error.reason === "epoch")
    )
      return;
    if (retryRestoreRead(error, attempt)) {
      cycle?.close();
      await restoreSession(pi, control, ctx, 1);
      return;
    }
    reportRestoreFailure(pi, ctx, board, error);
  } finally {
    cycle?.close();
  }
}

function registerSessionHandlers(pi: ExtensionAPI, control: Control): void {
  const restoreCache = async (ctx: ExtensionContext) => {
    await restoreSession(pi, control, ctx);
    const store = currentRuntime().receiptStore;
    const config = await loadConfig();
    if (store && currentRuntime().receiptStore === store && config.receiptCache)
      store.configure(config.receiptCache);
  };
  pi.on("session_start", async (_event, ctx) => {
    resetConfig();
    await restoreCache(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await restoreCache(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    control.cancel();
    invalidateGoalCallbacks();
    const epoch = currentRuntime().goalEpoch;
    setSessionScopeEnabled(false);
    invalidateTaskWidget(ctx);
    await closeReadOnlyView(ctx);
    if (currentRuntime().goalEpoch === epoch) clearOwnedUI(ctx);
  });
  pi.on("session_before_compact", (_event, ctx) => {
    control.cancel();
    if (supervisorState()?.externalWait)
      holdSupervisor(
        pi,
        ctx,
        "fault",
        "Context changed during external waiting; inspect the existing run before recovery.",
        "interrupted",
      );
    else if (supervisorState()?.status === "reviewing")
      holdSupervisor(
        pi,
        ctx,
        "fault",
        "Context changed during supervisor review; stale advice discarded. Recover after compaction.",
        "review_failed",
      );
  });
  pi.on("input", (_event, ctx) => {
    control.cancel();
    const state = supervisorState();
    if (state?.status === "reviewing") {
      if (currentRuntime().finalReview?.attemptId && getBoardRef().workflowStatus === "completed")
        holdSupervisor(
          pi,
          ctx,
          "fault",
          "Final review interrupted by input; inspect and retry-review without replaying work",
          "interrupted",
        );
      else {
        state.status = "active";
        saveSupervisor(pi);
      }
      updateUI(ctx, getBoardRef());
    }
  });
}

function editsCompletedTask(toolName: string, input: Record<string, unknown>): boolean {
  return (
    toolName === "edit_tasks" &&
    Array.isArray(input.tasks) &&
    input.tasks.some(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        getBoardRef().tasks.some((task) => task.id === item.id && task.status === "done"),
    )
  );
}

function supervisedWriteLimitError(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== "write_tasks" || !Array.isArray(input.phases)) return undefined;
  const added = input.phases.reduce<number>(
    (total, phase: unknown) =>
      total +
      (typeof phase === "object" && phase !== null && "tasks" in phase && Array.isArray(phase.tasks)
        ? phase.tasks.length
        : 0),
    0,
  );
  return supervisorPlanError(added + (input.mode === "replace" ? 0 : getBoardRef().tasks.length));
}

function submissionGate(ctx: ExtensionContext): string | undefined {
  const goalIssue = goalControlIssue(ctx);
  if (goalIssue) return goalIssue;
  const current = currentRuntime().goal?.current;
  if (current && current.phase !== "planning")
    return "Current GoalRun needs an explicit live planning attempt before another proposal";
  const state = currentRuntime().preflight;
  return (
    currentRuntime().journalFault ??
    (!isSessionScopeEnabled() ||
    !state ||
    state.sessionId !== ctx.sessionManager.getSessionId() ||
    state.started ||
    ["revoked", "interrupted"].includes(state.phase)
      ? "No valid human-created preflight planning context"
      : undefined)
  );
}
function taskControlIssue(ctx: ExtensionContext): string | undefined {
  if (currentRuntime().journalFault) return currentRuntime().journalFault;
  if (!isSessionScopeEnabled()) return "Pi Task Supervisor is disabled for this session";
  if (["paused", "waiting_for_decision"].includes(getBoardRef().workflowStatus))
    return "Task-board gate must be resolved by its human command";
  const state = supervisorState();
  return activeGoalContext()
    ? preflightTaskIssue(ctx, state?.status === "stopped" ? undefined : state?.preflightBinding)
    : undefined;
}

function decisionReplacementAllowed(toolName: string, input: Record<string, unknown>): boolean {
  return (
    toolName === "workflow_gate" &&
    canReplaceBoardDecision(getBoardRef(), input) &&
    isSessionScopeEnabled() &&
    !currentRuntime().journalFault
  );
}

function abandonsRequiredTasks(toolName: string, input: Record<string, unknown>): boolean {
  return (
    toolName === "edit_tasks" &&
    Array.isArray(input.tasks) &&
    input.tasks.some(
      (item: unknown) =>
        typeof item === "object" && item !== null && "type" in item && item.type === "abandon",
    )
  );
}

function scopedDecisionReplacement(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): boolean {
  if (!decisionReplacementAllowed(toolName, input) || goalControlIssue(ctx)) return false;
  const phase = activeGoalContext() ? currentRuntime().goal?.current?.phase : undefined;
  return phase === undefined || !["stopped", "completed"].includes(phase);
}
function lifecycleToolRule(
  pi: ExtensionAPI,
  name: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): { handled: boolean; issue?: string } {
  if (
    name === "submit_preflight" ||
    (name === "propose_contract" &&
      currentRuntime().preflight &&
      !currentRuntime().preflight?.started)
  )
    return { handled: true, issue: submissionGate(ctx) };
  const issue = goalExecutionIssue(ctx);
  if (!TASK_TOOL_NAMES.includes(name)) {
    if (registeredFinalValidation(ctx, name, input)) return { handled: true };
    const blocked =
      issue ??
      executionPersistenceIssue(currentWorkOwner(ctx.sessionManager.getSessionId())) ??
      finalReviewWriteIssue(ctx);
    return { handled: true, issue: !goalReadOnlyTool(pi, name) ? blocked : undefined };
  }
  if (scopedDecisionReplacement(name, input, ctx)) return { handled: true };
  if (issue && scopedExecutionMetadataRepair(name, input, ctx)) return { handled: false };
  return issue ? { handled: true, issue } : { handled: false };
}
function scopedExecutionMetadataRepair(
  name: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): boolean {
  const state = supervisorState();
  return (
    currentRuntime().goal?.current?.phase === "fault" &&
    !goalControlIssue(ctx) &&
    state?.status === "fault" &&
    state.holdCause === "interrupted" &&
    isExecutionRepairRequest(name, input, currentWorkOwner(ctx.sessionManager.getSessionId()))
  );
}
function executionTaskGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): { handled: boolean; issue?: string } {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  const issue = executionPersistenceIssue(owner);
  if (!issue) return { handled: false };
  const state = supervisorState();
  const repairable =
    !state ||
    state.status === "active" ||
    (state.status === "fault" && state.holdCause === "interrupted");
  return {
    handled: true,
    issue: repairable && isExecutionRepairRequest(toolName, input, owner) ? undefined : issue,
  };
}
function managementToolRule(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown>,
): { handled: boolean; issue?: string } {
  const management = captureManagementSnapshot(ctx);
  const metadataRepair = existingExecutionMetadata(ctx, toolName, input);
  const controlRepair = scopedDecisionReplacement(toolName, input, ctx);
  const validationCheck = toolName === "bash" && !!registeredFinalValidation(ctx, toolName, input);
  const admission = decideAdmission(management, {
    kind: "tool",
    taskTool: TASK_TOOL_NAMES.includes(toolName),
    preflightTool:
      toolName === "submit_preflight" ||
      (toolName === "propose_contract" &&
        !!currentRuntime().preflight &&
        !currentRuntime().preflight?.started),
    readOnly: goalReadOnlyTool(pi, toolName),
    metadataRepair,
    validationCheck,
    controlRepair,
  });
  if (admission.verdict === "deny") return { handled: true, issue: admission.reason };
  const contractIssue = contractCompilationAdmission(
    ctx,
    toolName,
    input,
    goalReadOnlyTool(pi, toolName),
  );
  if (contractIssue) return { handled: true, issue: contractIssue };
  return {
    handled:
      management.mode === "off" ||
      (management.state === "stopping-with-attention" && (metadataRepair || controlRepair)),
  };
}
function taskGate(
  pi: ExtensionAPI,
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): string | undefined {
  const mode = managementToolRule(pi, ctx, toolName, input);
  if (mode.handled) return mode.issue;
  const rule = lifecycleToolRule(pi, toolName, input, ctx);
  if (rule.handled) return rule.issue;
  const issue = taskControlIssue(ctx);
  if (issue) return issue;
  const execution = executionTaskGate(toolName, input, ctx);
  if (execution.handled) return execution.issue;
  const finalReview = finalReviewWriteIssue(ctx);
  if (finalReview) return finalReview;
  const state = supervisorState();
  if (!state || state.status === "stopped") return undefined;
  if (["paused", "fault", "reviewing", "completed"].includes(state.status))
    return `Supervisor is ${state.status}; explicit human recovery is required`;
  if (editsCompletedTask(toolName, input))
    return "Completed supervised tasks are frozen; stop before changing their scope";
  if (
    toolName === "clear_tasks" ||
    (toolName === "write_tasks" && input.mode === "replace" && getBoardRef().tasks.length > 0)
  )
    return "A supervised goal cannot discard its task board";
  if (abandonsRequiredTasks(toolName, input))
    return "A supervised goal cannot abandon required tasks";
  return supervisedWriteLimitError(toolName, input);
}

function goalReadOnlyTool(pi: ExtensionAPI, name: string): boolean {
  return (
    ["read", "grep", "find", "ls"].includes(name) ||
    pi.getAllTools().find((tool) => tool.name === name)?.annotations?.readOnlyHint === true
  );
}
function planningMessage(preflight: string | undefined, ctx: ExtensionContext) {
  if (!isSessionScopeEnabled() || !preflight || currentRuntime().preflight?.started)
    return undefined;
  return {
    message: {
      customType: "continuous-tasks:preflight-context",
      content: goalScopeContext(ctx) ? `${goalScopeContext(ctx)}\n${preflight}` : preflight,
      display: false,
    },
  };
}

function beforePlanningContext(
  ctx: ExtensionContext,
  preflight: string | undefined,
): { handled: boolean; value?: ReturnType<typeof planningMessage> } {
  if (currentRuntime().journalFault) return { handled: true };
  const issue = goalExecutionIssue(ctx);
  const current = currentRuntime().goal?.current;
  if (goalControlIssue(ctx) || (issue && current?.phase !== "planning"))
    return {
      handled: true,
      value: {
        message: {
          customType: "continuous-tasks:goal-hold",
          content: `${goalScopeContext(ctx)}\n${issue}\nRead-only diagnosis only; do not mutate tasks, submit stale proposals, approve or start.`,
          display: false,
        },
      },
    };
  const value = planningMessage(preflight, ctx);
  return { handled: Boolean(value), value };
}
function decisionWait(
  board: ReturnType<typeof getBoardRef>,
  state: ReturnType<typeof supervisorState>,
): boolean {
  const decision = board.decision;
  return (
    board.workflowStatus === "waiting_for_decision" &&
    decision !== undefined &&
    board.tasks.some((task) => task.id === decision.taskId) &&
    state?.status === "active" &&
    !state.pending
  );
}
function managementPlanningContext(ctx: ExtensionContext, supervised: boolean) {
  const preflight = supervised ? preflightContext(ctx) : undefined;
  const leading = supervised
    ? beforePlanningContext(ctx, preflight)
    : { handled: false, value: undefined };
  return { preflight, leading };
}
function registerWorkHandlers(pi: ExtensionAPI, control: Control): void {
  const runs: string[] = [];
  const runScope = (ctx: ExtensionContext) =>
    JSON.stringify([
      goalLease(),
      ctx.sessionManager.getSessionId(),
      currentRuntime().goal?.current?.supervisor === null ? "planning" : "execution",
    ]);
  pi.on("agent_start", (_event, ctx) => {
    const key = runScope(ctx);
    if (runs.at(-1) !== key) runs.push(key);
    if (runs.length > 128) runs.shift();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const management = captureManagementSnapshot(ctx);
    if (decideAdmission(management, { kind: "context" }).verdict === "deny") return undefined;
    const board = getBoardRef();
    const state = supervisorState();
    const { preflight, leading } = managementPlanningContext(ctx, management.mode === "supervised");
    if (leading.handled) return leading.value;
    if (
      !isSessionScopeEnabled() ||
      (state && !["active", "stopped"].includes(state.status)) ||
      (board.workflowStatus !== "active" && state?.status !== "active")
    )
      return undefined;
    return {
      message: {
        customType: "continuous-tasks:context",
        content: `${boardHumanContext(ctx) ?? ""}\n${preflight ? `${preflight}\n` : ""}${formatHiddenContext(board)}\n${state?.status === "active" ? `User-recorded supervisor goal: ${state.goal}\nEvidence refs must use real host receipts tool:<id>, observed during review. Supervisor guidance is never user approval.` : ""}${currentExecutionWait(board, state) ? "\nExisting external executions are bound. Inspect the executor's delivered results and exact run IDs; clear resolved references and obtain fresh host validation. A wait or completion notification is neither acceptance nor permission to launch duplicate work." : ""}`,
        display: false,
      },
    };
  });
  pi.on("agent_before_settle", control.boundary);
  // Native aborts during an awaited boundary are reported only after it returns.
  // This notification reconciles state; it never schedules another turn.
  pi.on("agent_settled", (event, ctx) => {
    const started = runs.shift();
    if (started ? started !== runScope(ctx) : Boolean(currentRuntime().goal?.current)) return;
    if (!isSessionScopeEnabled()) return;
    settleGoalPlanning(pi, ctx);
    if (goalExecutionIssue(ctx)) return;
    if (event.aborted) {
      control.cancel();
      pauseBoard(
        pi,
        ctx,
        "The user aborted the last run; inspect before resuming",
        currentRuntime().manualPauseDepth > 0 ? "user_pause" : "run_aborted",
      );
    } else {
      const board = getBoardRef();
      const state = supervisorState();
      const waitingForDecision =
        decisionWait(board, state) && state?.sessionId === ctx.sessionManager.getSessionId();
      if (
        ["active", "reviewing"].includes(state?.status ?? "") &&
        !waitingForDecision &&
        !currentExecutionWait(board, state)
      )
        holdSupervisor(
          pi,
          ctx,
          "fault",
          "Pi settled with an unfinished goal; inspect the blocked continuation before explicit recovery",
          "interrupted",
        );
    }
  });
}

function registerReceiptHandlers(pi: ExtensionAPI): void {
  const leases = new GoalToolLeases();
  pi.on("tool_call", (event, ctx) => {
    try {
      materializeManagement(pi, ctx);
      const reason =
        leases.begin(event.toolCallId, ctx, event.toolName) ??
        taskGate(pi, event.toolName, event.input, ctx);
      if (reason) return { block: true, reason };
      admitManagedInvocation(pi, ctx, event);
      beginProgressCapture(pi, ctx, event, goalReadOnlyTool(pi, event.toolName));
      prepareToolCapture(pi, event, ctx);
      leases.allow(event.toolCallId);
      allowManagedInvocation(event.toolCallId);
    } catch (error) {
      discardUnstartedProgress(event.toolCallId);
      const reason = error instanceof Error ? error.message : "Receipt capture unavailable";
      const store = currentRuntime().receiptStore;
      if (store && !store.healthy) currentRuntime().journalFault = reason;
      const state = supervisorState();
      if (state) {
        state.status = "fault";
        state.pending = false;
        state.reason = reason;
      }
      return { block: true, reason: `Tool not started: ${reason}` };
    }
    return undefined;
  });
  pi.on("tool_result", (event, ctx) => {
    const scope = leases.result(event.toolCallId, ctx, event.toolName);
    if (scope === "unmanaged") return undefined;
    if (scope === "historical")
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: "Historical goal/planning-attempt result: not current evidence, approval, progress or a reason to replay this tool.",
          },
        ],
        ...(event.structuredContent === undefined
          ? {}
          : { structuredContent: event.structuredContent }),
      };
    if (scope === "blocked" && event.isError) return undefined;
    if (scope === "blocked")
      currentRuntime().journalFault ??=
        "Successful result after tool admission was blocked; inspect actual execution before continuing";
    const previousFault = currentRuntime().journalFault;
    try {
      const receipt = observeTool(pi, event);
      observeManagedInvocationResult(ctx, event, receipt);
      observeProgressFact(ctx, event, receipt);
      const validationWarning = observeValidationSafely(pi, ctx, event, receipt, previousFault);
      if (receipt)
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `Host evidence receipt: ${receipt.id}; epoch ${receipt.epoch}; observed exit_code ${receipt.exitCode ?? "unavailable"}. Use only fresh successful receipts captured during this task's review.${validationWarning ? ` Final validation applicability unavailable: ${validationWarning}; the host receipt itself remains recorded.` : ""}`,
            },
          ],
          ...(event.structuredContent === undefined
            ? {}
            : { structuredContent: event.structuredContent }),
        };
    } catch (error) {
      const reason = receiptFailure(pi, ctx, error, previousFault);
      return {
        content: [
          ...event.content,
          {
            type: "text" as const,
            text: `Evidence not recorded: ${reason}. Do not treat this result as a new proof or automatically retry the tool.`,
          },
        ],
        ...(event.structuredContent === undefined
          ? {}
          : { structuredContent: event.structuredContent }),
      };
    }
    return undefined;
  });
  pi.on("tool_execution_end", (event, ctx) => {
    try {
      observeManagedInvocationEnd(pi, ctx, event);
    } catch (error) {
      const reason = receiptFailure(pi, ctx, error, currentRuntime().journalFault);
      const invocation = currentRuntime().invocation;
      if (invocation) invocation.attention = reason;
    }
  });
}

function observeValidationSafely(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: Parameters<typeof observeFinalValidation>[2],
  receipt: Parameters<typeof observeFinalValidation>[3] | undefined,
  previousFault: string | undefined,
): string | undefined {
  if (!receipt) {
    currentRuntime().finalValidationIntents?.delete(event.toolCallId);
    return undefined;
  }
  try {
    observeFinalValidation(pi, ctx, event, receipt);
    return undefined;
  } catch (error) {
    const runtime = currentRuntime();
    if (runtime.journalFault) {
      const state = supervisorState();
      if (state) {
        state.status = "fault";
        state.pending = false;
        state.acceptedDigest = undefined;
      }
      return runtime.journalFault;
    }
    return receiptFailure(pi, ctx, error, previousFault);
  }
}
function receiptFailure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  error: unknown,
  previousFault: string | undefined,
): string {
  const reason = error instanceof Error ? error.message : "Evidence capture failed";
  const state = supervisorState();
  const store = currentRuntime().receiptStore;
  if (store && !store.healthy) {
    currentRuntime().journalFault = reason;
    if (state) {
      state.status = "fault";
      state.pending = false;
      state.reason = reason;
      state.acceptedDigest = undefined;
    }
  } else if (state?.status !== "fault") {
    holdSupervisor(pi, ctx, "fault", reason, "review_failed");
  }
  if (currentRuntime().journalFault && previousFault !== reason)
    ctx.ui.notify(`Evidence not committed; tool may have executed. ${reason}`, "error");
  return reason;
}

export function registerEventHandlers(
  pi: ExtensionAPI,
  configLoader: ConfigLoader = loadConfig,
  advisor?: Advisor,
): void {
  const control = makeController(pi, configLoader, advisor);
  currentRuntime().reviewAdvisor = advisor;
  currentRuntime().cancel = control.cancel;
  registerSessionHandlers(pi, control);
  registerWorkHandlers(pi, control);
  registerReceiptHandlers(pi);
}
