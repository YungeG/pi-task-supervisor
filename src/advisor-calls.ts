import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  AdvisorUsageSchema,
  ControlJournalError,
  appendControlFact,
  appendControlFence,
  captureControlLease,
  currentWorkOwner,
  readControlJournal,
  type AdvisorFactView,
  type AdvisorObservedFact,
  type AdvisorStartedFact,
  type AdvisorConflictFact,
  type GoalOwnerKey,
} from "./control-journal";
import { journalDigest } from "./human-journal";
import { currentRuntime } from "./runtime";
import type { SupervisorState } from "./supervisor";

export type AdvisorCallStartedV1 = AdvisorStartedFact;
export type AdvisorCallObservedV1 = AdvisorObservedFact;
export interface AdvisorCall {
  readonly callId: string;
  readonly owner: GoalOwnerKey;
  readonly startedRef: { entryId: string; digest: string };
  readonly manager: ExtensionContext["sessionManager"];
  readonly sessionFile: string | undefined;
}
function ownFacts(
  owner: GoalOwnerKey,
  facts = currentRuntime().controlJournal?.advisorFacts ?? [],
): AdvisorFactView[] {
  const key = journalDigest({ kind: "goal", goal: owner });
  return facts.filter((record) => journalDigest(record.data.owner) === key);
}
export interface AdvisorUsage {
  providerCalls: number;
  pendingCalls: number;
  unknownUsageCalls: number;
  knownTokens: number;
  knownCost: number;
  legacyCallsUnknown: boolean;
  conflictedCalls: number;
}
export function advisorUsageFor(owner: GoalOwnerKey): AdvisorUsage {
  const records = ownFacts(owner);
  const starts = records.filter(
    (record): record is AdvisorFactView & { data: AdvisorStartedFact } =>
      record.data.kind === "advisor-call-started",
  );
  const observations = new Map(
    records.flatMap((record) =>
      record.data.kind === "advisor-call-observed"
        ? [[record.data.callId, record.data] as const]
        : [],
    ),
  );
  const baseline = starts[0]?.data.legacySubtotal;
  const conflicts = new Set(
    records.flatMap((record) =>
      record.data.kind === "advisor-call-conflict" ? [record.data.callId] : [],
    ),
  );
  const result: AdvisorUsage = {
    providerCalls: starts.length,
    pendingCalls: 0,
    unknownUsageCalls: 0,
    knownTokens: baseline?.tokens ?? 0,
    knownCost: baseline?.cost ?? 0,
    legacyCallsUnknown: baseline ? baseline.reviews > 0 : true,
    conflictedCalls: conflicts.size,
  };
  for (const start of starts) {
    const observation = observations.get(start.data.callId);
    if (!observation) result.pendingCalls++;
    if (!observation || observation.usage.state === "unknown") {
      result.unknownUsageCalls++;
      continue;
    }
    if (conflicts.has(start.data.callId)) result.unknownUsageCalls++;
    result.knownTokens += observation.usage.values.totalTokens;
    result.knownCost += observation.usage.values.cost.total;
    if (!Number.isSafeInteger(result.knownTokens) || !Number.isFinite(result.knownCost))
      throw Error("Advisor accounting total overflow; known subtotal cannot be claimed complete");
  }
  return result;
}
export function advisorUsageForCurrent(ctx: ExtensionContext): AdvisorUsage | undefined {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (owner?.kind !== "goal") return undefined;
  const usage = advisorUsageFor(owner.goal);
  const state = currentRuntime().supervisor;
  return usage.providerCalls || !state
    ? usage
    : { ...usage, knownTokens: state.tokens, knownCost: state.cost };
}
function attemptCalls(records: readonly AdvisorFactView[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records)
    if (record.data.kind === "advisor-call-started")
      counts.set(record.data.attemptId, (counts.get(record.data.attemptId) ?? 0) + 1);
  return counts;
}
export function advisorExtraCalls(owner: GoalOwnerKey): number {
  return [...attemptCalls(ownFacts(owner)).values()].reduce((total, count) => total + count - 1, 0);
}
function reservedAdvisorSlot(
  reviews: number,
  records: readonly AdvisorFactView[],
  attemptId: string,
): number {
  if (!attemptId || attemptId.length > 100) throw new Error("Invalid host review attempt identity");
  const counts = attemptCalls(records);
  const extraCalls = [...counts.values()].reduce((total, count) => total + count - 1, 0);
  const slot = reviews + extraCalls + (counts.has(attemptId) ? 1 : 0);
  if (!Number.isSafeInteger(slot) || slot < 1 || slot > 40)
    throw new Error("Supervisor shared review/provider call budget exhausted");
  return slot;
}
export function beginAdvisorCall(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: SupervisorState,
  packet: string,
  options: { attemptId?: string } = {},
): AdvisorCall {
  const lease = captureControlLease(ctx);
  if (lease.owner?.kind !== "goal") throw Error("Advisor requires a verified Goal owner");
  const view = readControlJournal(ctx);
  const attemptId = options.attemptId ?? randomUUID();
  const budgetSlot = reservedAdvisorSlot(
    state.reviews,
    ownFacts(lease.owner.goal, view.advisorFacts ?? []),
    attemptId,
  );
  const previous = ownFacts(lease.owner.goal, view.advisorFacts ?? []).find(
    (record) => record.data.kind === "advisor-call-started",
  );
  const legacySubtotal =
    previous?.data.kind === "advisor-call-started"
      ? previous.data.legacySubtotal
      : { tokens: state.tokens, cost: state.cost, reviews: state.reviews - 1 };
  if (!view.latestFence?.data.features.includes("advisor-accounting-v1")) {
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "advisor-accounting-v1" as const])],
      lease,
    );
  }
  const callId = randomUUID();
  const fact: AdvisorStartedFact = {
    version: 1,
    kind: "advisor-call-started",
    recordId: randomUUID(),
    callId,
    owner: { kind: "goal", goal: lease.owner.goal },
    attemptId,
    viewDigest: journalDigest(["advisor-view-v1", packet]),
    model: { ...state.model },
    budgetSlot,
    legacySubtotal,
    startedAt: Date.now(),
  };
  const receipt = appendControlFact(pi, ctx, fact);
  return {
    callId,
    owner: lease.owner.goal,
    startedRef: { entryId: receipt.entryId, digest: receipt.digest },
    manager: ctx.sessionManager,
    sessionFile: ctx.sessionManager.getSessionFile(),
  };
}
function usageObservation(value: unknown, current?: AdvisorUsage): AdvisorObservedFact["usage"] {
  if (value === undefined) return { state: "unknown", reason: "missing" };
  if (!Check(AdvisorUsageSchema, value) || !Object.values(value.cost).every(Number.isFinite))
    return { state: "unknown", reason: "invalid" };
  if (
    current &&
    (!Number.isSafeInteger(current.knownTokens + value.totalTokens) ||
      !Number.isFinite(current.knownCost + value.cost.total))
  )
    return { state: "unknown", reason: "overflow" };
  return { state: "known", values: structuredClone(value) };
}
function outcomeDigest(status: AdvisorObservedFact["status"], value: unknown): string {
  const usage = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const cost =
    usage.cost && typeof usage.cost === "object" ? (usage.cost as Record<string, unknown>) : {};
  const metric = (value: unknown) =>
    typeof value === "number" ? ["number", String(value)] : [typeof value];
  return journalDigest([
    "advisor-observation-v1",
    status,
    typeof value,
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map((key) => metric(usage[key])),
    ["input", "output", "cacheRead", "cacheWrite", "total"].map((key) => metric(cost[key])),
  ]);
}
export function observeAdvisorCall(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  call: AdvisorCall,
  outcome: { status: AdvisorObservedFact["status"]; usage?: unknown },
): { entryId: string; digest: string; leafAfter: string } {
  if (currentRuntime().journalFault) throw new ControlJournalError("CONTROL_JOURNAL_UNCERTAIN");
  if (
    ctx.sessionManager !== call.manager ||
    ctx.sessionManager.getSessionId() !== call.owner.sessionId ||
    ctx.sessionManager.getSessionFile() !== call.sessionFile
  )
    throw Error(
      "Advisor observation belongs to a different Session; original call remains unsettled",
    );
  const view = readControlJournal(ctx);
  const records = ownFacts(call.owner, view.advisorFacts ?? []);
  const previous = records.find(
    (record) => record.data.kind === "advisor-call-observed" && record.data.callId === call.callId,
  );
  const fingerprint = outcomeDigest(outcome.status, outcome.usage);
  if (previous?.data.kind === "advisor-call-observed") {
    const conflicted = records.some(
      (record) =>
        record.data.kind === "advisor-call-conflict" && record.data.callId === call.callId,
    );
    if (conflicted || previous.data.outcomeDigest !== fingerprint) {
      if (!conflicted) {
        const conflict: AdvisorConflictFact = {
          version: 1,
          kind: "advisor-call-conflict",
          recordId: randomUUID(),
          callId: call.callId,
          owner: { kind: "goal", goal: call.owner },
          firstObservationRef: { entryId: previous.entryId, digest: previous.digest },
          outcomeDigest: fingerprint,
          status: outcome.status,
          usage: usageObservation(outcome.usage),
          observedAt: Date.now(),
        };
        appendControlFact(pi, ctx, conflict);
      }
      throw Error("Conflicting Advisor observation; original accounting retained");
    }
    return {
      entryId: previous.entryId,
      digest: previous.digest,
      leafAfter: ctx.sessionManager.getLeafId() ?? previous.entryId,
    };
  }
  const usage = usageObservation(outcome.usage, advisorUsageFor(call.owner));
  const fact: AdvisorObservedFact = {
    version: 1,
    kind: "advisor-call-observed",
    recordId: randomUUID(),
    callId: call.callId,
    owner: { kind: "goal", goal: call.owner },
    startedRef: call.startedRef,
    outcomeDigest: fingerprint,
    status: outcome.status,
    usage,
    observedAt: Date.now(),
  };
  return appendControlFact(pi, ctx, fact);
}
