import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { currentRuntime } from "./runtime";
import { preflightTaskIssue } from "./preflight";
import type { SupervisorState } from "./supervisor";
import type { TaskBoardSnapshot } from "./types";

export const SUPERVISOR_LIMITS = {
  tasks: 100,
  reviews: 40,
  continuations: 20,
  stagnant: 3,
} as const;

export interface FlowFacts {
  enabled: boolean;
  journalFault?: string;
  preflightIssue?: string;
  sessionId: string;
  idle: boolean;
  pending: boolean;
}

export function flowFacts(ctx: ExtensionContext): FlowFacts {
  const runtime = currentRuntime();
  return {
    enabled: runtime.enabled,
    journalFault: runtime.journalFault,
    preflightIssue: preflightTaskIssue(
      ctx,
      runtime.supervisor?.status === "stopped" ? undefined : runtime.supervisor?.preflightBinding,
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
  if (facts.preflightIssue) return facts.preflightIssue;
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
  return facts.preflightIssue;
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
  if (
    state.reviews >= SUPERVISOR_LIMITS.reviews ||
    state.continuations >= SUPERVISOR_LIMITS.continuations ||
    state.stagnant >= SUPERVISOR_LIMITS.stagnant
  )
    return "Inspect exhausted limits before explicit recover";
  return undefined;
}

function heldNextStep(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState>,
): string {
  if (board.workflowStatus === "completed" || board.tasks.length > SUPERVISOR_LIMITS.tasks)
    return "inspect and stop/re-plan; recover cannot reopen this board";
  if (state.status === "stopped") return "prepare a valid board and a new supervise <goal>";
  return "inspect existing work, then /task-supervisor recover (resets review/continuation limits)";
}

function preflightControlBlocker(facts: FlowFacts): string | undefined {
  if (!facts.preflightIssue) return undefined;
  if (!facts.idle || facts.pending)
    return "wait for the current host run/check and pending messages";
  return `inspect preflight authorization: ${facts.preflightIssue}`;
}

function flowBlocker(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string | undefined {
  if (facts.journalFault) return "inspect journal; control recovery is disabled";
  if (!facts.enabled) return "/task-supervisor enable (tools only), then recheck status";
  if (state && state.sessionId !== facts.sessionId) return "inspect foreign supervisor identity";
  const preflight = preflightControlBlocker(facts);
  if (preflight) return preflight;
  if (board.decision || board.workflowStatus === "waiting_for_decision") {
    if (!board.decision || board.workflowStatus !== "waiting_for_decision")
      return "inspect inconsistent decision gate";
    const after =
      state && ["paused", "fault"].includes(state.status)
        ? `; then ${heldNextStep(board, state)}`
        : "; remaining gates still apply";
    return `/task-supervisor resolve ${board.decision.id} <answer>${after}`;
  }
  if (!facts.idle || facts.pending)
    return "wait for the current host run/check and pending messages";
  return undefined;
}

/** Cached owner observations only: status does not perform RPC or prove process liveness. */
export function externalWaitText(state: Readonly<SupervisorState> | undefined): string {
  const wait = state?.status === "active" ? state.externalWait : undefined;
  if (!wait) return "none confirmed";
  const phase = wait.phase === "active" ? "execution pending" : "results pending Main review";
  return `${phase}; last owner report ${new Date(wait.observedAt).toISOString()}; deadline ${new Date(wait.deadlineAt).toISOString()}`;
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
    return `/task-supervisor resume (board only); then ${heldNextStep(board, state)}`;
  }
  switch (state?.status) {
    case "paused":
    case "fault":
      return heldNextStep(board, state);
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

function preflightBlockerStatus(facts: FlowFacts): string[] {
  return facts.preflightIssue ? [`Preflight blocker: ${facts.preflightIssue}`] : [];
}

export function formatFlowStatus(
  board: Readonly<TaskBoardSnapshot>,
  state: Readonly<SupervisorState> | undefined,
  facts: FlowFacts,
): string[] {
  const claimed = board.tasks.filter((task) => ["implementing", "reviewing"].includes(task.status));
  const lines = [
    `Session: ${facts.enabled ? "enabled" : "disabled"}`,
    `Goal: ${state?.goal ?? "no supervised goal"}`,
    `Main: ${facts.idle ? "idle" : "host run busy (execution/settling)"}${facts.pending ? "; pending messages" : ""}`,
    `Claimed batch: ${claimed.map((task) => task.id).join(", ") || "none"}`,
    "Next checkpoint: native end-of-run; batch guidance only",
  ];
  if (state)
    lines.push(
      `Supervisor: ${state.status}${state.reason ? ` — ${state.reason}` : ""}`,
      `Hold source: ${state.holdCause ?? "unknown"}`,
      `Budget: reviews ${state.reviews}/${SUPERVISOR_LIMITS.reviews}; auto continuations ${state.continuations}/${SUPERVISOR_LIMITS.continuations}; stagnant ${state.stagnant}/${SUPERVISOR_LIMITS.stagnant}; advisor tokens ${state.tokens}; advisor cost ${state.cost}`,
    );
  lines.push(`External wait: ${externalWaitText(state)}`);
  if (facts.journalFault) lines.push(`Fault: ${facts.journalFault}`);
  lines.push(...preflightBlockerStatus(facts));
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
