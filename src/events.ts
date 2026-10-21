import type {
  AgentBeforeSettleEvent,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ContinuousTasksConfig } from "./config";
import { createEmptyBoard } from "./engine";
import { inspectRestorableSession } from "./human-control";
import { formatJournalReadError } from "./human-journal";
import { restoreBoardHuman, boardHumanContext, canReplaceBoardDecision } from "./board-human";
import { claimedExecutionRefs, executionWaitTimer, waitForExecutions } from "./async-execution";
import { currentRuntime } from "./runtime";
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

function continuation(prompt: string): BoundaryResult {
  return {
    continue: true,
    entries: [
      {
        type: "custom_message",
        customType: "continuous-tasks:continue",
        content: prompt,
        display: false,
        details: { generation: getBoardRef().generation },
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
  pi.appendEntry("continuous-tasks:snapshot", updated);
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
  if (!advice || !current() || ctx.hasPendingMessages()) return undefined;
  return continuation(
    `[SUPERVISOR ADVICE — NOT USER APPROVAL]\n${advice.message}\nTasks: ${advice.taskIds.join(", ") || "prepare/repair the goal's task plan"}\nEvidence: ${advice.evidenceRefs.join(", ") || "collect fresh tool evidence"}\nPreserve all real approvals, pauses, budgets and existing execution receipts.`,
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

function makeController(pi: ExtensionAPI, configLoader: ConfigLoader, advisor?: Advisor): Control {
  let serial = 0;
  let inFlight: AbortController | undefined;
  let lastProgress: string | undefined;
  let stagnant = 0;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    currentRuntime().humanEpoch++;
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
    const progress = digest(
      board.tasks.map((task) => [task.id, task.status, task.completionEvidence]),
    );
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
    if (!isSessionScopeEnabled() || inFlight) return undefined;
    if (!boundaryAllowed(pi, event, ctx)) return undefined;
    const controller = new AbortController();
    inFlight = controller;
    const ticket = serial;
    const signal = reviewSignal(controller, ctx);
    try {
      const state = supervisorState();
      if (permissionBlocked(pi, ctx)) return undefined;
      if (state && state.status !== "stopped") {
        if (
          claimedExecutionRefs(getBoardRef()).length &&
          (await waitForExecutions(pi, ctx, signal, () => ticket === serial))
        ) {
          clearTimeout(waitTimer);
          waitTimer = executionWaitTimer(pi, ctx);
          return undefined;
        }
        return await supervisedBoundary(pi, ctx, signal, () => ticket === serial, advisor);
      }
      return await baseBoundary(ticket, ctx);
    } catch (error) {
      if (ticket === serial) holdBoundaryError(pi, ctx, error);
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

function registerSessionHandlers(pi: ExtensionAPI, control: Control): void {
  const restore = async (ctx: ExtensionContext) => {
    control.cancel();
    invalidateTaskWidget(ctx);
    await closeReadOnlyView(ctx);
    let board = createEmptyBoard();
    setBoard(board);
    currentRuntime().journalFault = undefined;
    currentRuntime().preflightRepair = undefined;
    currentRuntime().preflight = undefined;
    currentRuntime().boardRepair = undefined;
    currentRuntime().boardHumanContext = undefined;
    try {
      inspectRestorableSession(ctx);
      board = restoreBoardHuman(ctx, reconstructState(ctx));
      restoreSessionScope(pi, ctx);
      setBoard(board);
      restorePreflight(ctx);
      restoreSupervisor(pi, ctx);
      updateUI(ctx, board);
      updateActiveTools(pi, isSessionScopeEnabled());
    } catch (error) {
      // Do not reinterpret malformed durable state as an inactive, safe-to-continue supervisor.
      const diagnostic = formatJournalReadError(error);
      const reason = diagnostic
        ? `Journal restore blocked: ${diagnostic}; inspect session state before recovery`
        : error instanceof Error && /preflight/i.test(error.message)
          ? "Invalid preflight journal; inspect session state before recovery"
          : "Invalid supervisor journal; inspect session state before recovery";
      currentRuntime().journalFault =
        board.tasks.length === 0
          ? `${reason}; task view not restored, counts unknown (saved records are not deleted)`
          : reason;
      // Restore only a held view after another owner's failure; no writes or replay.
      restoreFaultedSupervisor(pi, ctx);
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
  };
  const restoreCache = async (ctx: ExtensionContext) => {
    await restore(ctx);
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
    setSessionScopeEnabled(false);
    invalidateTaskWidget(ctx);
    await closeReadOnlyView(ctx);
    clearOwnedUI(ctx);
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
      state.status = "active";
      saveSupervisor(pi);
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
  return preflightTaskIssue(ctx, state?.status === "stopped" ? undefined : state?.preflightBinding);
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

function taskGate(
  toolName: string,
  input: Record<string, unknown>,
  ctx: ExtensionContext,
): string | undefined {
  if (toolName === "submit_preflight") return submissionGate(ctx);
  if (!TASK_TOOL_NAMES.includes(toolName)) return undefined;
  if (decisionReplacementAllowed(toolName, input)) return undefined;
  const issue = taskControlIssue(ctx);
  if (issue) return issue;
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

function planningMessage(preflight: string | undefined) {
  if (!isSessionScopeEnabled() || !preflight || currentRuntime().preflight?.started)
    return undefined;
  return {
    message: {
      customType: "continuous-tasks:preflight-context",
      content: preflight,
      display: false,
    },
  };
}

function registerWorkHandlers(pi: ExtensionAPI, control: Control): void {
  pi.on("before_agent_start", (_event, ctx) => {
    const board = getBoardRef();
    const state = supervisorState();
    const preflight = preflightContext(ctx);
    if (currentRuntime().journalFault) return undefined;
    const planning = planningMessage(preflight);
    if (planning) return planning;
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
    if (!isSessionScopeEnabled()) return;
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
      const decision = board.decision;
      const waitingForDecision =
        board.workflowStatus === "waiting_for_decision" &&
        decision !== undefined &&
        board.tasks.some((task) => task.id === decision.taskId) &&
        state?.status === "active" &&
        !state.pending &&
        state.sessionId === ctx.sessionManager.getSessionId();
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
  const blockedCaptures = new Set<string>();
  pi.on("tool_call", (event, ctx) => {
    const reason = taskGate(event.toolName, event.input, ctx);
    if (reason) return { block: true, reason };
    try {
      prepareToolCapture(pi, event);
    } catch (error) {
      blockedCaptures.add(event.toolCallId);
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
    if (blockedCaptures.delete(event.toolCallId) && event.isError) return undefined;
    const previousFault = currentRuntime().journalFault;
    try {
      const receipt = observeTool(pi, event);
      if (receipt)
        return {
          content: [
            ...event.content,
            {
              type: "text" as const,
              text: `Host evidence receipt: ${receipt.id}; epoch ${receipt.epoch}; observed exit_code ${receipt.exitCode ?? "unavailable"}. Use only fresh successful receipts captured during this task's review.`,
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
  currentRuntime().cancel = control.cancel;
  registerSessionHandlers(pi, control);
  registerWorkHandlers(pi, control);
  registerReceiptHandlers(pi);
}
