import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import { currentRuntime } from "./runtime";
import { getBoardRef } from "./state";
import { isTrustedLocalTui, hasActiveNativeQuestion } from "./human-ui";
import { inspectSessionJournal, journalDigest, type SessionJournal } from "./human-journal";
import { sessionJournalView } from "./human-control";
import {
  PreflightStateSchema,
  preflightContext,
  unstartedPreflightStopIssue,
  type PreflightState,
} from "./preflight";
import { appendObservedGoalCheckpoint, readGoalJournal } from "./goal-journal";
import {
  GOAL_PROTOCOL,
  isGoalCarrier,
  scopeEqual,
  type GoalCurrent,
  type GoalPlanning,
  type GoalQuiescence,
  type GoalRuntime,
  type GoalScope,
  type GoalStateRecord,
} from "./goal-records";
import { goalLease, goalScopeContext, invalidateGoalCallbacks } from "./goal-scope";

export interface GoalPlanningRef {
  scope: GoalScope;
  attemptId: string;
  headEntryId: string;
}
export interface GoalPlanningResult {
  status: "planning-ready" | "already-running" | "projection-pending" | "blocked";
  reason?: string;
  planning?: GoalPlanningRef;
}
export interface GoalStopResult {
  status: "stopped" | "already-stopped" | "projection-pending" | "blocked";
  reason?: string;
}
type Loaded = { journal: SessionJournal; view: GoalRuntime; current: GoalCurrent };
export function goalPlanningRef(current: GoalCurrent): GoalPlanningRef {
  return {
    scope: structuredClone(current.scope),
    attemptId: current.planning.attemptId,
    headEntryId: current.headEntryId,
  };
}
function load(ctx: ExtensionContext): Loaded {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const view = readGoalJournal(ctx, journal);
  if (!view?.current || view.pending || view.blocked)
    throw new Error("No confirmed current GoalRun is available for planning control");
  return { journal, view, current: view.current };
}
function observedPreflight(loaded: Loaded): PreflightState {
  const { journal, current } = loaded;
  const index = journal.branch.findIndex((n) => n.id === current.preflightBaseEntryId);
  if (index < 0) throw new Error("Planning seed is outside the current branch");
  const latest = journal.branch
    .slice(index + 1)
    .filter((n) => n.customType === "continuous-tasks:preflight")
    .at(-1);
  const data = latest
    ? isGoalCarrier(latest.data)
      ? latest.data.snapshot
      : undefined
    : current.preflightSeed;
  if (
    !Check(PreflightStateSchema, data) ||
    data.preflightId !== current.planning.preflightId ||
    data.sessionId !== journal.sessionId
  )
    throw new Error("Planning preflight/cache identity changed");
  return data;
}
function planningWorkspaceIssue(ctx: ExtensionContext, current: GoalCurrent): string | undefined {
  const runtime = currentRuntime();
  if (
    runtime.journalFault ||
    runtime.boardRepair ||
    runtime.preflightRepair ||
    runtime.goal?.blocked
  )
    return "Inspect the independent journal/owner repair before planning control";
  if (current.supervisor !== null || runtime.supervisor || runtime.receiptStore)
    return "This GoalRun may already have started; inspect the execution owner";
  if (!["planning", "planning-interrupted", "stopped"].includes(current.phase))
    return "Current GoalRun is not an unstarted planning goal";
  if (getBoardRef().decision || getBoardRef().tasks.length)
    return "Unexpected task/decision work must be inspected, not cleared by planning control";
  if (hasActiveNativeQuestion(ctx)) return "Complete the existing native question first";
  return undefined;
}
function neverStartedIssue(
  ctx: ExtensionContext,
  loaded: Loaded,
  stop = false,
): string | undefined {
  const { current, journal } = loaded;
  const issue = planningWorkspaceIssue(ctx, current);
  if (issue) return issue;
  const base = journal.branch.findIndex((n) => n.id === current.scope.lifecycleCommitId);
  const start = journal.branch
    .slice(base + 1)
    .some(
      (n) =>
        n.customType === "continuous-tasks:preflight-control" &&
        n.data &&
        typeof n.data === "object" &&
        "kind" in n.data &&
        n.data.kind === "start",
    );
  if (start) return "A first-start control exists; its outcome must be inspected";
  const preflight = observedPreflight(loaded);
  if (stop) return unstartedPreflightStopIssue(ctx, preflight);
  const authority = [
    preflight.proposal,
    preflight.approval,
    preflight.started,
    preflight.version === 2 && preflight.permissionRequest,
    preflight.version === 2 && preflight.startRequest,
  ];
  return authority.some(Boolean)
    ? "Real preflight proposal/authorization/start work remains with its original owner"
    : undefined;
}

function quiescence(ctx: ExtensionContext, current: GoalCurrent): GoalQuiescence {
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    throw new Error("The actual host and planning queue have not settled");
  const branchAnchor = ctx.sessionManager.getLeafId();
  if (!branchAnchor) throw new Error("Planning branch identity unavailable");
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    goalRunId: current.scope.goalRunId,
    attemptId: current.planning.attemptId,
    branchAnchor,
    hostIdle: true,
    pendingMessages: false,
    observedAt: Date.now(),
  };
}
function hold(reason: string): void {
  const goal = currentRuntime().goal;
  if (goal) goal.blocked = reason;
}
function writeState(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  loaded: Loaded,
  action: GoalStateRecord["action"],
  phase: GoalStateRecord["phase"],
  planning: GoalPlanning,
  extra: Partial<Pick<GoalStateRecord, "preflightSeed" | "quiescence" | "disposition">> = {},
): GoalCurrent {
  const record: GoalStateRecord = {
    version: 5,
    protocol: GOAL_PROTOCOL,
    kind: "goal-state",
    sessionId: loaded.journal.sessionId,
    scope: loaded.current.scope,
    previous: loaded.current.headEntryId,
    action,
    phase,
    planning,
    supervisor: null,
    ...extra,
  };
  try {
    appendObservedGoalCheckpoint(pi, ctx, record);
    const view = readGoalJournal(ctx);
    if (!view?.current) throw new Error("Confirmed planning state disappeared");
    currentRuntime().goal = structuredClone(view);
    if (extra.preflightSeed) currentRuntime().preflight = structuredClone(extra.preflightSeed);
    return view.current;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Planning metadata acknowledgement unknown";
    const goal = currentRuntime().goal;
    if (goal) goal.repair = { record: structuredClone(record), reason };
    throw error;
  }
}
function repairPlanningProjection(ctx: ExtensionContext): GoalStateRecord["action"] | undefined {
  const runtime = currentRuntime();
  const live = runtime.goal;
  const hint = live?.repair;
  if (!hint) return undefined;
  if (
    runtime.journalFault ||
    runtime.boardRepair ||
    runtime.preflightRepair ||
    (live.blocked && live.blocked !== hint.reason)
  )
    throw new Error("Independent owner fault prevents planning projection repair");
  const loaded = load(ctx);
  const node = loaded.journal.branch.find(
    (entry) => entry.data !== undefined && journalDigest(entry.data) === journalDigest(hint.record),
  );
  if (
    !node ||
    loaded.current.headEntryId !== node.id ||
    !scopeEqual(loaded.current.scope, hint.record.scope)
  )
    throw new Error(
      "Planning metadata has not been confirmed or newer state exists; reopen and inspect without replay",
    );
  // Cache reconciliation cannot cancel an already dispatched planning attempt.
  runtime.goal = structuredClone(loaded.view);
  if (hint.record.preflightSeed) runtime.preflight = structuredClone(loaded.current.preflightSeed);
  return hint.record.action;
}
function settleUnknownPlanning(pi: ExtensionAPI, ctx: ExtensionContext, loaded: Loaded): Loaded {
  if (!["dispatch-claimed", "dispatched"].includes(loaded.current.planning.status)) return loaded;
  const observed = quiescence(ctx, loaded.current);
  invalidateGoalCallbacks();
  writeState(
    pi,
    ctx,
    loaded,
    "settle-planning",
    "planning-interrupted",
    { ...loaded.current.planning, status: "closed-unknown-result" },
    { quiescence: observed },
  );
  return load(ctx);
}
export async function replanCurrentGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<GoalPlanningResult> {
  if (!isTrustedLocalTui(ctx))
    return {
      status: "blocked",
      reason: "Current-goal replan requires a trusted native command context",
    };
  try {
    const repaired = repairPlanningProjection(ctx);
    let loaded = load(ctx);
    const issue = neverStartedIssue(ctx, loaded);
    if (!issue && repaired === "prepare-planning" && loaded.current.planning.status === "prepared")
      return { status: "planning-ready", planning: goalPlanningRef(loaded.current) };
    if (issue || loaded.current.phase === "stopped")
      return {
        status: "blocked",
        reason: issue ?? "A stopped GoalRun cannot be replanned; prepare a new goal",
      };
    if (!ctx.isIdle() || ctx.hasPendingMessages())
      return {
        status: "already-running",
        reason: "Wait for the current host/queue before an explicit replan",
      };
    const original = goalPlanningRef(loaded.current);
    await ctx.waitForIdle();
    loaded = load(ctx);
    if (
      loaded.current.headEntryId !== original.headEntryId ||
      !scopeEqual(loaded.current.scope, original.scope)
    )
      return { status: "blocked", reason: "Planning identity changed while waiting" };
    loaded = settleUnknownPlanning(pi, ctx, loaded);
    const prior = loaded.current.planning;
    if (!Number.isSafeInteger(prior.attemptNo + 1))
      throw new Error("Planning attempt counter exhausted");
    const preflightId = `pf-${randomUUID()}`;
    const planning: GoalPlanning = {
      attemptNo: prior.attemptNo + 1,
      attemptId: randomUUID(),
      preflightId,
      status: "prepared",
    };
    const seed: PreflightState = {
      version: 2,
      sessionId: loaded.journal.sessionId,
      preflightId,
      goal: loaded.current.seed.goal,
      revision: 0,
      phase: "planning",
      approvalFlow: "consolidated-v1",
    };
    const observed = quiescence(ctx, loaded.current);
    invalidateGoalCallbacks();
    const current = writeState(pi, ctx, loaded, "prepare-planning", "planning", planning, {
      preflightSeed: seed,
      quiescence: observed,
    });
    return { status: "planning-ready", planning: goalPlanningRef(current) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Planning state outcome unknown";
    hold(reason);
    return { status: "projection-pending", reason };
  }
}
export async function stopCurrentGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<GoalStopResult> {
  if (!isTrustedLocalTui(ctx))
    return {
      status: "blocked",
      reason: "Current-goal stop requires a trusted native command context",
    };
  try {
    repairPlanningProjection(ctx);
    let loaded = load(ctx);
    if (
      loaded.current.phase === "stopped" &&
      loaded.current.supervisor === null &&
      loaded.current.disposition === "closed-unstarted"
    )
      return { status: "already-stopped" };
    const issue = neverStartedIssue(ctx, loaded, true);
    if (issue) return { status: "blocked", reason: issue };
    const scope = loaded.current.scope;
    const attempt = loaded.current.planning.attemptId;
    if (
      !ctx.isIdle() &&
      !["dispatch-claimed", "dispatched"].includes(loaded.current.planning.status)
    )
      return { status: "blocked", reason: "Busy work is not this goal's claimed planning attempt" };
    invalidateGoalCallbacks();
    if (!ctx.isIdle()) ctx.abort();
    await ctx.waitForIdle();
    loaded = load(ctx);
    if (!scopeEqual(scope, loaded.current.scope) || loaded.current.planning.attemptId !== attempt)
      return { status: "blocked", reason: "Current goal/attempt changed while stopping" };
    const after = neverStartedIssue(ctx, loaded, true);
    if (after) return { status: "blocked", reason: after };
    const observed = quiescence(ctx, loaded.current);
    const status = ["dispatch-claimed", "dispatched"].includes(loaded.current.planning.status)
      ? "closed-unknown-result"
      : loaded.current.planning.status;
    writeState(
      pi,
      ctx,
      loaded,
      "stop-unstarted",
      "stopped",
      { ...loaded.current.planning, status },
      { quiescence: observed, disposition: "closed-unstarted" },
    );
    return { status: "stopped" };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Goal stop outcome unknown";
    hold(reason);
    return { status: "projection-pending", reason };
  }
}
/** Only explicit command callers use this effectful seam, after an observed prepared state. */
export function dispatchGoalPlanning(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  ready: GoalPlanningRef,
): void {
  const loaded = load(ctx);
  const current = loaded.current;
  if (
    !scopeEqual(current.scope, ready.scope) ||
    current.headEntryId !== ready.headEntryId ||
    current.planning.attemptId !== ready.attemptId ||
    current.planning.status !== "prepared"
  )
    throw new Error("Planning dispatch lease is stale or already claimed");
  const issue = neverStartedIssue(ctx, loaded);
  if (issue) throw new Error(issue);
  quiescence(ctx, current);
  const claimed = writeState(pi, ctx, loaded, "claim-planning-dispatch", "planning", {
    ...current.planning,
    status: "dispatch-claimed",
  });
  const content = preflightContext(ctx);
  if (!content) throw new Error("Scoped read-only planning context is unavailable");
  const lease = goalLease();
  currentRuntime().planningLease = lease;
  try {
    pi.sendMessage(
      {
        customType: "continuous-tasks:preflight-planning",
        content: `${goalScopeContext(ctx)}\n${content}`,
        display: false,
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
    const after = load(ctx);
    if (goalLease() !== lease || after.current.headEntryId !== claimed.headEntryId)
      throw new Error("Planning state changed while dispatching");
    writeState(pi, ctx, after, "observe-planning-dispatch", "planning", {
      ...claimed.planning,
      status: "dispatched",
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Planning dispatch outcome unknown";
    hold(reason);
    throw error;
  }
}
export function settleGoalPlanning(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const runtime = currentRuntime();
  if (!runtime.planningLease || runtime.planningLease !== goalLease()) return;
  runtime.planningLease = undefined;
  try {
    const loaded = load(ctx);
    if (
      loaded.current.supervisor !== null ||
      !["dispatch-claimed", "dispatched"].includes(loaded.current.planning.status)
    )
      return;
    const observed = quiescence(ctx, loaded.current);
    const phase = runtime.preflight?.proposal ? "planning" : "planning-interrupted";
    writeState(
      pi,
      ctx,
      loaded,
      "settle-planning",
      phase,
      { ...loaded.current.planning, status: "settled" },
      { quiescence: observed },
    );
  } catch (error) {
    hold(error instanceof Error ? error.message : "Planning settle outcome unknown");
  }
}
