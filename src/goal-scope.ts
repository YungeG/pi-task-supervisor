import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import {
  isGoalCarrier,
  scopeEqual,
  unwrapGoalSnapshot,
  wrapGoalSnapshot,
  type GoalScope,
  type GoalPhase,
  type GoalStateRecord,
  isGoalRecord,
  GOAL_PROTOCOL,
} from "./goal-records";

export function currentGoalScope(): GoalScope | undefined {
  return currentRuntime().goal?.current?.scope;
}
export function ownerSnapshot(data: unknown): unknown {
  return unwrapGoalSnapshot(data, currentGoalScope());
}
export function storedOwnerSnapshot(snapshot: unknown): unknown {
  const scope = currentGoalScope();
  return scope ? wrapGoalSnapshot(scope, snapshot) : snapshot;
}
export function appendOwnerSnapshot(pi: ExtensionAPI, type: string, snapshot: unknown): unknown {
  const value = storedOwnerSnapshot(snapshot);
  pi.appendEntry(type, value);
  return value;
}
export function goalLogicalScope<T extends object>(
  scope: T,
): T | { goalScope: GoalScope; payload: T } {
  const goal = currentRuntime().goal?.current;
  return goal ? { goalScope: goal.scope, payload: scope } : scope;
}

/** Filters owner reads by an actual selected checkpoint, never by a caller-selected goal string. */
export function selectedGoalEntries<T extends { id: string }>(
  entries: readonly T[],
  owner: "board" | "preflight" = "board",
): readonly T[] {
  const current = currentRuntime().goal?.current;
  if (!current) return entries;
  const base =
    owner === "preflight" ? current.preflightBaseEntryId : current.scope.lifecycleCommitId;
  const index = entries.findIndex((entry) => entry.id === base);
  if (index < 0) throw new Error("Selected GoalRun checkpoint is not on this branch");
  return entries.slice(index + 1);
}
export function requireCurrentCarrier(data: unknown): void {
  const scope = currentGoalScope();
  if (scope && (!isGoalCarrier(data) || !scopeEqual(data, scope)))
    throw new Error("Native base belongs to a different GoalRun");
}
export function goalControlIssue(ctx?: ExtensionContext): string | undefined {
  const goal = currentRuntime().goal;
  if (!goal) return undefined;
  if (ctx && goal.sessionId !== ctx.sessionManager.getSessionId())
    return "Current GoalRun belongs to another Session";
  if (goal.blocked) return goal.blocked;
  return goal.pending
    ? "Goal transition is not confirmed; inspect the control/witness before continuing"
    : undefined;
}
export function goalExecutionIssue(ctx?: ExtensionContext): string | undefined {
  const issue = goalControlIssue(ctx);
  if (issue) return issue;
  const current = currentRuntime().goal?.current;
  if (current && !["active", "reviewing"].includes(current.phase))
    return `GoalRun is ${current.phase}; no automatic board continuation or execution`;
  return undefined;
}
export function goalPreflightDenialOnly(ctx: ExtensionContext): boolean {
  if (goalControlIssue(ctx)) return false;
  const current = currentRuntime().goal?.current;
  return Boolean(current && ["stopped", "completed"].includes(current.phase));
}
export function goalPreflightControlIssue(
  ctx: ExtensionContext,
  intent: "grant" | "deny" = "grant",
): string | undefined {
  const issue = goalControlIssue(ctx);
  if (issue) return issue;
  if (intent === "deny" && goalPreflightDenialOnly(ctx)) return undefined;
  const current = currentRuntime().goal?.current;
  return current && ["stopped", "completed", "fault"].includes(current.phase)
    ? "Current GoalRun is closed/held; no new proposal, approval or first-start"
    : undefined;
}
export function goalStartIdentityIssue(ctx: ExtensionContext, goal: string): string | undefined {
  const runtime = currentRuntime();
  const current = runtime.goal?.current;
  if (!current) return undefined;
  if (
    runtime.goal?.pending ||
    runtime.goal?.blocked ||
    ["stopped", "completed", "fault"].includes(current.phase)
  )
    return "Current GoalRun is not ready for its first-start";
  const actual = ctx.model && [ctx.model.provider, ctx.model.id];
  const expected = [current.seed.model.provider, current.seed.model.id];
  return goal !== current.seed.goal || JSON.stringify(actual) !== JSON.stringify(expected)
    ? "Current GoalRun requires its exact goal and pinned model before first-start"
    : undefined;
}

export function goalScopeContext(ctx: ExtensionContext): string {
  const current = currentRuntime().goal?.current;
  return current
    ? `Current GoalRun ${current.scope.goalRunId}; lifecycle ${current.scope.lifecycleCommitId}; planning attempt ${current.planning.attemptId}; phase ${current.phase}; session ${ctx.sessionManager.getSessionId()}. Earlier goals are read-only history, not current tasks, permissions or evidence.`
    : "";
}
export function scopedSupervisorCheckpoint(payload: unknown, phase: GoalPhase): unknown {
  const goal = currentRuntime().goal;
  if (goal?.pending) throw new Error("A pending goal transition cannot write Supervisor state");
  const current = goal?.current;
  if (!current) return payload;
  const record: GoalStateRecord = {
    version: 5,
    protocol: GOAL_PROTOCOL,
    kind: "goal-state",
    sessionId: goal.sessionId,
    scope: current.scope,
    previous: current.headEntryId,
    action: "supervisor",
    phase,
    planning: structuredClone(current.planning),
    supervisor: payload,
  };
  return record;
}
export function observeScopedSupervisorCheckpoint(value: unknown, entryId: string): void {
  const current = currentRuntime().goal?.current;
  if (!current) return;
  if (
    !isGoalRecord(value) ||
    value.kind !== "goal-state" ||
    value.action !== "supervisor" ||
    !scopeEqual(value.scope, current.scope) ||
    value.previous !== current.headEntryId
  )
    throw new Error("Supervisor checkpoint lost its current GoalRun lease");
  current.headEntryId = entryId;
  current.phase = value.phase;
  current.supervisor = structuredClone(value.supervisor);
}

export function invalidateGoalCallbacks(): void {
  const runtime = currentRuntime();
  runtime.goalEpoch++;
  runtime.planningLease = undefined;
  runtime.humanEpoch++;
  runtime.humanAbort?.abort();
  runtime.humanAbort = undefined;
  runtime.cancel();
}
export function goalLease(): string {
  const current = currentRuntime().goal?.current;
  return JSON.stringify([
    current?.scope.goalRunId,
    current?.scope.lifecycleCommitId,
    current?.planning.attemptId,
    currentRuntime().goalEpoch,
  ]);
}
