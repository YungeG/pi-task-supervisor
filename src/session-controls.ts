import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IdleMessage, IdleActionResult } from "./host-idle";
import { currentRuntime } from "./runtime";
import { getBoardRef, setBoard, persistEntries, updateUI } from "./state";
import { cloneBoard, hasActionableTasks } from "./validation";
import { formatContinuePrompt } from "./formatting";
import { boardHumanContext } from "./board-human";
import { preflightContext } from "./preflight";
import {
  flowFacts,
  nextFlowStep,
  resumeControlIssue,
  ordinaryResumeIssue,
  SUPERVISOR_LIMITS,
} from "./flow";
import {
  captureManagementSnapshot,
  decideAdmission,
  adoptSupervisedMode,
} from "./management-policy";
import { goalExecutionIssue } from "./goal-scope";
import { preflightAssociationIssue, adoptPreflightAcceptance } from "./acceptance-runtime";
import { advisorBudgetAssessment } from "./advisor-calls";
import {
  supervisorState,
  holdSupervisor,
  saveSupervisor,
  type SupervisorHoldCause,
} from "./supervisor";
import { resumePausedFinalReview } from "./final-review";
import { journalDigest } from "./human-journal";
import { currentWorkOwner } from "./control-journal";
import { loadConfig } from "./config";
import type { TaskBoardSnapshot } from "./types";
import type { SupervisorState } from "./supervisor";

function notifyControlError(ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function continuationContent(ctx: ExtensionContext): string {
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

function currentContinuation(ctx: ExtensionContext): IdleMessage | undefined {
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
  return {
    customType: "continuous-tasks:continue",
    content: continuationContent(ctx),
    display: false,
    details: { generation: board.generation },
  };
}

export function resumeBoardControl(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): "resumed" | "board_only" | "review_only" | "unchanged" {
  if (resumePausedFinalReview(pi, ctx)) {
    updateUI(ctx, getBoardRef());
    return "review_only";
  }
  const board = getBoardRef();
  if (board.workflowStatus !== "paused") {
    notifyControlError(ctx, "Pi Task Supervisor is not paused");
    return "unchanged";
  }
  const facts = flowFacts(ctx);
  const state = supervisorState();
  const controlIssue = resumeControlIssue(board, state, facts);
  if (controlIssue) {
    notifyControlError(ctx, controlIssue);
    return "unchanged";
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
        `Task board resumed only; Supervisor remains ${state.status}. ${nextFlowStep(
          updated,
          supervisorState(),
          flowFacts(ctx),
        )}`,
        "info",
      );
      return "board_only";
    }
    return "resumed";
  } catch {
    resumeControlFailure(ctx, board, state);
    return "unchanged";
  }
}

export function resumeControlFailure(
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  state: SupervisorState | undefined,
): void {
  currentRuntime().supervisor = state;
  setBoard(cloneBoard(board));
  const message =
    "Resume persistence/dispatch failed; inspect journal and pending work before recovery";
  currentRuntime().journalFault = message;
  updateUI(ctx, board);
  notifyControlError(ctx, message);
}

export function pauseBoard(
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

/** Current original facts only. The hash never acts as permission. */
export function humanStateStamp(ctx: ExtensionContext): string {
  const runtime = currentRuntime();
  return journalDigest([
    currentWorkOwner(ctx.sessionManager.getSessionId()),
    runtime.goal?.current?.scope,
    runtime.management?.record && [
      runtime.management.record.entryId,
      runtime.management.record.digest,
    ],
    getBoardRef(),
    runtime.preflight,
    supervisorState(),
    runtime.controlJournal?.acceptance?.contracts.map((entry) => [entry.entryId, entry.digest]),
    runtime.controlJournal?.acceptance?.scopeCommits?.map((entry) => [entry.entryId, entry.digest]),
    runtime.controlJournal?.acceptance?.scopeRevocations?.map((entry) => [
      entry.entryId,
      entry.digest,
    ]),
  ]);
}

export function continuationCandidate(
  ctx: ExtensionContext,
): { message: IdleMessage; current(): boolean } | undefined {
  const message = currentContinuation(ctx);
  if (!message) return;
  const stamp = humanStateStamp(ctx);
  const payload = journalDigest(message);
  return {
    message: structuredClone(message),
    current: () => {
      const fresh = currentContinuation(ctx);
      return !!fresh && humanStateStamp(ctx) === stamp && journalDigest(fresh) === payload;
    },
  };
}

/** The original post-Start metadata adoption, without sending another model input. */
export async function adoptStartedGoal(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  adoptSupervisedMode(pi, ctx);
  const config = await loadConfig();
  if (config.receiptCache) currentRuntime().receiptStore?.configure(config.receiptCache);
  adoptPreflightAcceptance(pi, ctx);
}

/** Only the caller's still-current original owner may be held after a saved control. */
export function retainHumanDelivery(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  source: () => boolean,
  result: IdleActionResult | { status: "prepare_failed" },
): void {
  if (["started", "completed"].includes(result.status) || !source()) return;
  const state = supervisorState();
  if (state && state.status !== "active") return; // Preserve an independent user/stronger hold.
  const unknown = result.status === "unknown" || result.status === "prepare_failed";
  const reason = unknown
    ? "Human control retained; delivery/preparation needs inspection. Do not repeat Start or replay work."
    : "Human control retained; this host delivery did not start. Inspect before explicit recovery; do not repeat Start.";
  pauseBoard(pi, ctx, reason, "interrupted");
  if (unknown && state?.status === "paused")
    holdSupervisor(pi, ctx, "fault", reason, "interrupted");
}
