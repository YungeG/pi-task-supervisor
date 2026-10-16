import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskBoardSnapshot } from "./types";
import { getBoardRef, updateUI } from "./state";
import { currentRuntime } from "./runtime";
import {
  currentExecutionWait,
  digest,
  holdSupervisor,
  saveSupervisor,
  supervisorBudgetAvailable,
  supervisorState,
  type SupervisorState,
} from "./supervisor";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY = "subagents:rpc:v1:reply:";
export const ASYNC_COMPLETE = "subagent:async-complete";
export const EXECUTION_WAIT_MS = 30 * 60_000;
const RPC_TIMEOUT_MS = 2000;

export interface ExecutionIdentity {
  taskId: string;
  source: "pi-subagents" | "workflow";
  runId: string;
}
export type ExecutionState = "active" | "completed" | "failed";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid execution-owner protocol record");
  return value as Record<string, unknown>;
}

export function claimedExecutionRefs(board: Readonly<TaskBoardSnapshot>): ExecutionIdentity[] {
  const claimed = board.tasks.filter((task) => ["implementing", "reviewing"].includes(task.status));
  if (!claimed.length || claimed.some((task) => !task.executionRef)) return [];
  return claimed.flatMap((task) =>
    task.executionRef ? [{ taskId: task.id, ...task.executionRef }] : [],
  );
}

async function requestOwner(
  pi: ExtensionAPI,
  method: "ping" | "status",
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const requestId = randomUUID();
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(RPC_TIMEOUT_MS)]);
  return new Promise((resolve, reject) => {
    let dispose: () => void = () => undefined;
    const cleanup = () => {
      dispose();
      bounded.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("Execution-owner lookup cancelled or timed out"));
    };
    dispose = pi.events.on(`${RPC_REPLY}${requestId}`, (raw) => {
      try {
        const reply = record(raw);
        if (reply.requestId !== requestId) return;
        cleanup();
        if (reply.version !== 1 || reply.method !== method || reply.success !== true)
          throw new Error("Execution owner rejected lookup or returned an invalid reply");
        resolve(record(reply.data));
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error("Execution-owner reply failed"));
      }
    });
    if (bounded.aborted) {
      abort();
      return;
    }
    bounded.addEventListener("abort", abort, { once: true });
    try {
      pi.events.emit(RPC_REQUEST, { version: 1, requestId, method, params });
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error("Execution-owner request failed"));
    }
  });
}

function nodeState(raw: unknown, depth = 0): ExecutionState {
  if (depth > 4) throw new Error("Execution-owner status exceeds nesting bound");
  const node = record(raw);
  if (!["subagent", "workflow", "step", "host-step"].includes(String(node.kind)))
    throw new Error("Unknown execution-owner node kind");
  const state = node.state;
  if (
    ![
      "queued",
      "running",
      "complete",
      "failed",
      "partial",
      "paused",
      "stopped",
      "rejected",
    ].includes(String(state))
  )
    throw new Error("Unknown execution-owner state");
  const children = node.children ?? [];
  if (!Array.isArray(children) || children.length > 32)
    throw new Error("Invalid execution-owner child inventory");
  const states = children.map((child) => nodeState(child, depth + 1));
  if (
    ["failed", "partial", "paused", "stopped", "rejected"].includes(String(state)) ||
    states.includes("failed")
  )
    return "failed";
  if (["queued", "running"].includes(String(state)) || states.includes("active")) return "active";
  return "completed";
}

function assertOwner(ping: Record<string, unknown>, ctx: ExtensionContext): void {
  const session = record(ping.session);
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (
    ping.version !== 1 ||
    session.sessionId !== ctx.sessionManager.getSessionId() ||
    (session.sessionFile ?? null) !== (sessionFile ?? null)
  )
    throw new Error("Execution owner belongs to another session");
  const capabilities = record(ping.capabilities);
  const advertised = record(capabilities.asyncStatusSnapshot);
  const events = record(ping.events);
  if (
    advertised.kind !== "pi-subagents.async-status-snapshot" ||
    advertised.version !== 1 ||
    events.asyncComplete !== ASYNC_COMPLETE
  )
    throw new Error("Execution owner does not expose the required versioned contract");
}

function snapshotNodes(data: Record<string, unknown>): Record<string, unknown>[] {
  const snapshot = record(data.asyncSnapshot);
  const omitted = record(snapshot.omitted);
  if (
    snapshot.kind !== "pi-subagents.async-status-snapshot" ||
    snapshot.version !== 1 ||
    typeof snapshot.generatedAt !== "number" ||
    !Number.isSafeInteger(snapshot.generatedAt) ||
    Math.abs(Date.now() - snapshot.generatedAt) > 10_000 ||
    omitted.runs !== 0 ||
    omitted.children !== 0 ||
    omitted.byteLimitExceeded !== false ||
    !Array.isArray(snapshot.runs) ||
    snapshot.runs.length > 100
  )
    throw new Error("Missing, stale, truncated or invalid execution-owner snapshot");
  const nodes = snapshot.runs.map(record);
  const ids = nodes.map((node) => node.id);
  if (ids.some((id) => typeof id !== "string") || new Set(ids).size !== ids.length)
    throw new Error("Ambiguous execution-owner run identity");
  return nodes;
}

/** Read the execution owner's current-session snapshot, never display text or arbitrary paths. */
export async function observeExecutions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  refs: readonly ExecutionIdentity[],
  signal: AbortSignal,
): Promise<ExecutionState> {
  assertOwner(await requestOwner(pi, "ping", {}, signal), ctx);
  const nodes = snapshotNodes(await requestOwner(pi, "status", {}, signal));
  const states = refs.map((ref) => {
    const node = nodes.find((candidate) => candidate.id === ref.runId);
    if (!node || (ref.source === "workflow" && node.kind !== "workflow"))
      throw new Error(`Execution owner cannot confirm exact run ${ref.runId}`);
    return nodeState(node);
  });
  if (states.includes("failed")) return "failed";
  return states.includes("active") ? "active" : "completed";
}

function lookupCurrent(
  ctx: ExtensionContext,
  state: SupervisorState,
  board: Readonly<TaskBoardSnapshot>,
  signal: AbortSignal,
  current: () => boolean,
  epoch: number,
  leaf: string | null,
): boolean {
  if (
    signal.aborted ||
    !current() ||
    supervisorState() !== state ||
    supervisorState()?.status !== "active" ||
    ctx.hasPendingMessages()
  )
    return false;
  if (
    getBoardRef() !== board ||
    state.epoch !== epoch ||
    ctx.sessionManager.getLeafId() !== leaf ||
    state.sessionId !== ctx.sessionManager.getSessionId()
  )
    throw new Error(
      "Session or task context changed during execution lookup; stale status discarded",
    );
  return true;
}

function persistWait(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    saveSupervisor(pi);
  } catch {
    const reason = "External wait persistence failed; inspect the journal before recovery";
    currentRuntime().journalFault = reason;
    try {
      holdSupervisor(pi, ctx, "fault", reason, "interrupted");
    } catch {
      // The hold sets in-memory fault before appending; do not unlock a broken journal.
      updateUI(ctx, getBoardRef());
    }
  }
}

/** Existing executor notifications wake Main; this adapter neither duplicates them nor accepts results. */
export async function waitForExecutions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal: AbortSignal,
  current: () => boolean,
): Promise<boolean> {
  const state = supervisorState();
  const board = getBoardRef();
  if (state?.status !== "active" || board.workflowStatus !== "active" || board.decision)
    return false;
  const refs = claimedExecutionRefs(board);
  if (!refs.length) return false;
  if (!supervisorBudgetAvailable(pi, ctx, state)) return true;
  const previous = state.externalWait;
  const sameRefs = previous && digest(previous.refs) === digest(refs);
  if (sameRefs && previous.deadlineAt <= Date.now())
    throw new Error("External execution wait expired; inspect the existing run before recovery");
  const epoch = state.epoch;
  const leaf = ctx.sessionManager.getLeafId();
  const observed = await observeExecutions(pi, ctx, refs, signal);
  if (!lookupCurrent(ctx, state, board, signal, current, epoch, leaf)) return true;
  if (observed === "failed")
    throw new Error(
      "External execution failed or stopped; inspect the existing run before recovery",
    );
  state.pending = false;
  state.externalWait = {
    boardDigest: digest(board),
    epoch,
    deadlineAt: sameRefs ? previous.deadlineAt : Date.now() + EXECUTION_WAIT_MS,
    observedAt: Date.now(),
    phase: observed === "active" ? "active" : "results_pending",
    refs,
  };
  persistWait(pi, ctx);
  updateUI(ctx, board);
  return true;
}

/** One absolute expiry timer, not a status poll or a model wake. */
export function executionWaitTimer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ReturnType<typeof setTimeout> | undefined {
  const state = supervisorState();
  const wait = currentExecutionWait(getBoardRef(), state);
  if (!state || !wait) return undefined;
  const timer = setTimeout(
    () => {
      if (
        supervisorState() !== state ||
        state.externalWait !== wait ||
        state.sessionId !== ctx.sessionManager.getSessionId() ||
        !currentExecutionWait(getBoardRef(), state, wait.deadlineAt - 1)
      )
        return;
      try {
        holdSupervisor(
          pi,
          ctx,
          "fault",
          "External execution wait expired; inspect the existing run before recovery",
          "interrupted",
        );
        if (currentRuntime().journalFault) throw new Error("Expiry checkpoint was not persisted");
      } catch {
        currentRuntime().journalFault =
          "External wait expiry persistence failed; inspect the journal before recovery";
        updateUI(ctx, getBoardRef());
      }
    },
    Math.max(0, wait.deadlineAt - Date.now()),
  );
  timer.unref();
  return timer;
}
