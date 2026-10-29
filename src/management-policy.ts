import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import { scopeControlAttention } from "./scope-revision-journal";
import { invocationGraphIssue, invocationUnknownIssue } from "./invocation-tree";
import {
  currentWorkOwner,
  retainedWorkOwner,
  readControlJournal,
  captureControlLease,
  appendControlFence,
  appendControlFact,
  appendManagedBoardSnapshot,
  executionActivityIssue,
  isBoardReplacementEvent,
  executionOwnerSnapshot,
  ownerSession,
  modeGoalSourceMatches,
  sameGoalOwner,
  type WorkOwnerKey,
  type SessionModeChangedV1,
  type SessionModeView,
} from "./control-journal";
import { invalidateGoalCallbacks, goalLease } from "./goal-scope";
import { saveSupervisor } from "./supervisor";
import { RECEIPT_LEDGER_ENTRY } from "./receipt-store";
import { ownerBoardSnapshot, prepareExecutionOwner } from "./execution-settlement";
import { createEmptyBoard } from "./engine";
import { setBoard, persistEntries, persistTaskUpdate } from "./state";
import { enableSessionScope } from "./scope";
import { hasActiveNativeQuestion } from "./human-ui";
import { currentPreflightRequestIssue } from "./preflight";
import { journalDigest } from "./human-journal";
import { randomUUID } from "node:crypto";
import { stopCurrentGoal } from "./goal-planning";
import { inspectRestorableSession } from "./human-control";

export type ManagementMode = "off" | "tasks" | "supervised";
export type WorkContext =
  | { kind: "unmanaged" }
  | { kind: "board"; owner: Extract<WorkOwnerKey, { kind: "board" }> }
  | { kind: "goal"; owner: Extract<WorkOwnerKey, { kind: "goal" }> };
export interface ManagementState {
  mode: ManagementMode;
  state: SessionModeChangedV1["state"];
  activeWorkOwner: WorkOwnerKey | null;
  lastGoal: SessionModeChangedV1["lastGoal"];
  attention: SessionModeChangedV1["attention"];
  source: "confirmed" | "volatile" | "legacy-compatible";
  record?: SessionModeView;
  /** Original volatile choice identity; not durable proof or a wire field. */
  volatileSource?: { sessionId: string; path: string | undefined; leafId: string | null };
}
function cachedInvocationIssue(unknownOnly = false): string | undefined {
  const runtime = currentRuntime(),
    graph = runtime.controlJournal?.invocations;
  return unknownOnly
    ? invocationUnknownIssue(
        graph,
        new Set(runtime.invocation?.frames.keys() ?? []),
        runtime.invocation?.attention,
      )
    : invocationGraphIssue(graph, runtime.invocation?.attention);
}
export interface ManagementSnapshot extends ManagementState {
  context: WorkContext;
  legacyEnabled: boolean;
  journalFault?: string;
  identityIssue?: string;
  invocationIssue?: string;
  supervisorStatus?: string;
  goalPhase?: string;
  controlPending: boolean;
}
export interface AdmissionOperation {
  kind: "tool" | "context" | "boundary";
  taskTool?: boolean;
  preflightTool?: boolean;
  readOnly?: boolean;
  metadataRepair?: boolean;
  validationCheck?: boolean;
  controlRepair?: boolean;
}
export interface AdmissionDecision {
  verdict: "allow" | "readonly_only" | "deny";
  owner: WorkOwnerKey | null;
  context: WorkContext;
  reason?: string;
}
export function workContext(owner: WorkOwnerKey | null): WorkContext {
  return owner
    ? owner.kind === "goal"
      ? { kind: "goal", owner }
      : { kind: "board", owner }
    : { kind: "unmanaged" };
}
function planningPhase(): string | undefined {
  const preflight = currentRuntime().preflight;
  return preflight && !preflight.started
    ? preflight.phase === "planning"
      ? "planning"
      : "planning-interrupted"
    : undefined;
}
function legacyManagement(ctx: ExtensionContext): ManagementState {
  const runtime = currentRuntime();
  const managed = Boolean(
    runtime.goal?.current || runtime.supervisor || planningPhase() || runtime.journalFault,
  );
  const mode: ManagementMode = managed ? "supervised" : runtime.enabled ? "tasks" : "off";
  return {
    mode,
    state: "active",
    activeWorkOwner: mode === "off" ? null : currentWorkOwner(ctx.sessionManager.getSessionId()),
    source: "legacy-compatible",
    lastGoal: null,
    attention: [],
  };
}
function managedOwnerFacts(
  selected: ManagementState,
): Pick<ManagementSnapshot, "supervisorStatus" | "goalPhase"> {
  const runtime = currentRuntime();
  if (selected.activeWorkOwner?.kind === "goal")
    return {
      supervisorStatus: runtime.supervisor?.status,
      goalPhase: runtime.goal?.current?.phase ?? planningPhase(),
    };
  return selected.mode === "supervised" ? { goalPhase: planningPhase() } : {};
}
function volatileSource(ctx: ExtensionContext): NonNullable<ManagementState["volatileSource"]> {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    path: ctx.sessionManager.getSessionFile(),
    leafId: ctx.sessionManager.getLeafId(),
  };
}
function managementIdentityIssue(
  ctx: ExtensionContext,
  selected: ManagementState,
): string | undefined {
  const sessionId = ctx.sessionManager.getSessionId(),
    source = selected.volatileSource;
  if (
    selected.source === "volatile" &&
    source &&
    (source.sessionId !== sessionId ||
      source.path !== ctx.sessionManager.getSessionFile() ||
      (source.leafId !== null &&
        !ctx.sessionManager.getBranch().some((entry) => entry.id === source.leafId)))
  )
    return "Volatile management belongs to another Session or original source";
  if (selected.record && selected.record.data.sessionId !== sessionId)
    return "Selected management record belongs to another Session";
  if (selected.activeWorkOwner && ownerSession(selected.activeWorkOwner) !== sessionId)
    return "Selected work owner belongs to another Session";
  return undefined;
}
export function captureManagementSnapshot(ctx: ExtensionContext): ManagementSnapshot {
  const runtime = currentRuntime(),
    selected = runtime.management ?? legacyManagement(ctx);
  const controlPending = Boolean(
    runtime.goal?.pending ||
    runtime.goal?.blocked ||
    hasActiveNativeQuestion(ctx) ||
    scopeControlAttention(),
  );
  return {
    ...selected,
    controlPending,
    context: workContext(selected.activeWorkOwner),
    legacyEnabled: runtime.enabled,
    journalFault: runtime.journalFault,
    identityIssue: managementIdentityIssue(ctx, selected),
    invocationIssue: cachedInvocationIssue(true),
    ...managedOwnerFacts(selected),
  };
}
function readonlyVerdict(operation: AdmissionOperation): AdmissionDecision["verdict"] {
  return operation.kind === "tool" && operation.readOnly ? "readonly_only" : "deny";
}
function unmanagedTool(operation: AdmissionOperation): boolean {
  return operation.kind === "tool" && !operation.taskTool && !operation.preflightTool;
}
function legacyHeld(snapshot: ManagementSnapshot): boolean {
  return snapshot.source === "legacy-compatible" && !snapshot.legacyEnabled;
}
function supervisedHeld(snapshot: ManagementSnapshot): boolean {
  return (
    snapshot.mode === "supervised" &&
    (snapshot.activeWorkOwner === null ||
      ["paused", "fault", "reviewing", "completed", "stopped"].includes(
        snapshot.supervisorStatus ?? "",
      ) ||
      ["planning", "planning-interrupted", "stopped", "completed", "paused", "fault"].includes(
        snapshot.goalPhase ?? "",
      ))
  );
}
function supervisedHoldVerdict(
  snapshot: ManagementSnapshot,
  operation: AdmissionOperation,
): AdmissionDecision["verdict"] {
  if (operation.kind === "context") return "allow";
  if (
    operation.kind === "tool" &&
    (operation.metadataRepair ||
      operation.controlRepair ||
      operation.validationCheck ||
      (operation.preflightTool && snapshot.goalPhase === "planning"))
  )
    return "allow";
  return readonlyVerdict(operation);
}
function stoppingVerdict(operation: AdmissionOperation): AdmissionDecision["verdict"] {
  return operation.kind === "tool" && (operation.metadataRepair || operation.controlRepair)
    ? "allow"
    : readonlyVerdict(operation);
}
function managementSafetyIssue(
  snapshot: ManagementSnapshot,
  operation: AdmissionOperation,
): Pick<AdmissionDecision, "verdict" | "reason"> | undefined {
  const integrity = snapshot.identityIssue || snapshot.journalFault;
  if (integrity) return { verdict: readonlyVerdict(operation), reason: integrity };
  if (snapshot.invocationIssue)
    return {
      verdict:
        operation.controlRepair || operation.metadataRepair ? "allow" : readonlyVerdict(operation),
      reason: snapshot.invocationIssue,
    };
  return undefined;
}
export function decideAdmission(
  snapshot: ManagementSnapshot,
  operation: AdmissionOperation,
): AdmissionDecision {
  const result = (verdict: AdmissionDecision["verdict"], reason?: string): AdmissionDecision => ({
    verdict,
    reason,
    owner: snapshot.activeWorkOwner,
    context: snapshot.context,
  });
  const safety = managementSafetyIssue(snapshot, operation);
  if (safety) return result(safety.verdict, safety.reason);
  if (snapshot.controlPending)
    return result(
      operation.controlRepair ? "allow" : readonlyVerdict(operation),
      "A real native/Goal control remains pending; no mode or model flag closes it",
    );
  if (snapshot.state === "stopping-with-attention")
    return result(
      stoppingVerdict(operation),
      "Automation is stopped; actual writer/control attention prevents complete release",
    );
  if (snapshot.mode === "off")
    return result(
      unmanagedTool(operation) ? "allow" : "deny",
      "Management is off (disabled); ordinary work is unmanaged and historical goals grant no permission",
    );
  if (legacyHeld(snapshot))
    return result(
      readonlyVerdict(operation),
      "Retained legacy management is held; explicitly inspect and choose a mode",
    );
  if (snapshot.mode === "tasks" && operation.preflightTool)
    return result("deny", "Task-only mode has no live supervised planning request");
  if (supervisedHeld(snapshot))
    return result(
      supervisedHoldVerdict(snapshot, operation),
      `Managed Goal is ${snapshot.supervisorStatus ?? snapshot.goalPhase ?? "planning/owner-pending"}; no ordinary execution is reopened`,
    );
  return result("allow");
}
export function activeGoalContext(): boolean {
  const selected = currentRuntime().management;
  return !selected || selected.activeWorkOwner?.kind === "goal";
}
export function publishManagement(record: SessionModeView): ManagementState {
  const runtime = currentRuntime(),
    data = record.data;
  runtime.management = {
    mode: data.mode,
    state: data.state,
    activeWorkOwner: structuredClone(data.activeWorkOwner),
    lastGoal: structuredClone(data.lastGoal),
    attention: structuredClone(data.attention),
    source: "confirmed",
    record,
  };
  runtime.enabled = data.mode !== "off" || data.state === "stopping-with-attention";
  return runtime.management;
}
export function restoreManagement(ctx: ExtensionContext): void {
  const runtime = currentRuntime(),
    latest = runtime.controlJournal?.modeRecords?.at(-1);
  if (latest) {
    const selected = publishManagement(latest);
    holdInvalidatedTaskOwner(latest, selected);
  } else runtime.management = undefined;
  if (latest && latest.data.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("Management belongs to another Session");
}
function holdInvalidatedTaskOwner(latest: SessionModeView, selected: ManagementState): void {
  const runtime = currentRuntime(),
    data = latest.data;
  if (data.mode !== "tasks" || data.state !== "active" || data.activeWorkOwner?.kind !== "board")
    return;
  if (
    journalDigest(data.activeWorkOwner) ===
    journalDigest(runtime.controlJournal?.boardOwner ?? null)
  )
    return;
  runtime.management = {
    ...selected,
    state: "stopping-with-attention",
    activeWorkOwner: null,
    attention: [
      attention(
        "source",
        "Actual board replacement invalidated the selected owner; explicit tasks-only must repair retained-board metadata",
      ),
    ],
  };
}
function attention(
  kind: SessionModeChangedV1["attention"][number]["kind"],
  reason: string,
  ref: SessionModeChangedV1["boardRef"] = null,
): SessionModeChangedV1["attention"][number] {
  return { kind, reason, ref };
}
function foreignSupervisedContext(ctx: ExtensionContext): boolean {
  const runtime = currentRuntime();
  return (
    runtime.management?.mode === "supervised" &&
    !!runtime.supervisor &&
    runtime.supervisor.sessionId !== ctx.sessionManager.getSessionId()
  );
}
function volatileUnknownHostCapture(ctx: ExtensionContext): boolean {
  if (ctx.sessionManager.getSessionFile()) return false;
  // Memory history may retain a negative safety reference, never durable
  // settlement proof. Legacy close_unknown acknowledges loss, not writer exit.
  return ctx.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom" &&
        entry.customType === RECEIPT_LEDGER_ENTRY &&
        entry.data &&
        typeof entry.data === "object" &&
        "kind" in entry.data &&
        entry.data.kind === "close_unknown",
    );
}
function writerAttention(ctx: ExtensionContext): SessionModeChangedV1["attention"] {
  const runtime = currentRuntime(),
    issues: SessionModeChangedV1["attention"] = [];
  if (runtime.journalFault) issues.push(attention("source", runtime.journalFault));
  if (foreignSupervisedContext(ctx))
    issues.push(
      attention(
        "source",
        "Retained supervised context belongs to another Session; no confirmed release",
      ),
    );
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    issues.push(
      attention(
        "control",
        "Wait for actual Main idle and pending messages; stop ACK is not quiescence",
      ),
    );
  const invocation = cachedInvocationIssue();
  if (invocation) issues.push(attention("capture", invocation));
  const activity = executionActivityIssue(ctx.sessionManager.getSessionId());
  if (activity) issues.push(attention("execution", activity));
  if (runtime.board.tasks.some((task) => task.executionRef) && !activity)
    issues.push(
      attention(
        "execution",
        "Retained execution references need exact owner settlement, never field deletion",
      ),
    );
  if (
    runtime.receiptStore?.pendingCount ||
    runtime.controlJournal?.pendingHostCaptures?.length ||
    volatileUnknownHostCapture(ctx)
  )
    issues.push(
      attention(
        "capture",
        "Unmatched host intent remains unknown even after an in-memory close/recovery",
      ),
    );
  return issues;
}
function unstartedGoalNeedsClose(): boolean {
  const current = currentRuntime().goal?.current;
  return !!current && current.supervisor === null && current.phase !== "stopped";
}
function nativeControlAttention(ctx: ExtensionContext): SessionModeChangedV1["attention"] {
  const runtime = currentRuntime(),
    issues: SessionModeChangedV1["attention"] = [];
  if (unstartedGoalNeedsClose())
    issues.push(
      attention(
        "control",
        "Unstarted Goal has not been positively closed by its original native owner",
      ),
    );
  if (
    runtime.goal?.pending ||
    runtime.goal?.blocked ||
    runtime.preflightRepair ||
    runtime.boardRepair
  )
    issues.push(attention("control", "Actual Goal/control or projection work remains unresolved"));
  if (runtime.board.decision && !runtime.board.decision.response)
    issues.push(attention("control", "A real task decision remains unanswered"));
  if (hasActiveNativeQuestion(ctx))
    issues.push(attention("control", "A real native question is still open"));
  const scope = scopeControlAttention();
  if (scope) issues.push(attention("control", scope));
  const preflight = runtime.preflight;
  if (preflight) {
    const issue = currentPreflightRequestIssue(ctx, preflight);
    if (issue) issues.push(attention("control", issue));
  }
  return issues;
}
function releaseAttention(ctx: ExtensionContext): SessionModeChangedV1["attention"] {
  return [...writerAttention(ctx), ...nativeControlAttention(ctx)];
}
function retainedGoalSource(
  ctx: ExtensionContext,
  owner: Extract<WorkOwnerKey, { kind: "goal" }>["goal"],
): SessionModeChangedV1["boardRef"] {
  if (owner.lifecycleCommitId) {
    // This immutable birth ref is still checked against physical prefix bytes
    // during append. Choosing a newer mutable checkpoint needs no extra scan.
    const birth = ctx.sessionManager.getEntry(owner.lifecycleCommitId);
    return birth ? { entryId: birth.id, digest: journalDigest(birth) } : null;
  }
  const journal = inspectRestorableSession(ctx);
  const entry =
    journal && [...journal.branch].reverse().find((node) => modeGoalSourceMatches(node, owner));
  return entry ? { entryId: entry.id, digest: entry.digest } : null;
}
function retainedGoal(
  snapshot: ManagementSnapshot,
  ctx: ExtensionContext,
): SessionModeChangedV1["lastGoal"] {
  if (snapshot.activeWorkOwner?.kind !== "goal") return snapshot.lastGoal;
  const owner = snapshot.activeWorkOwner.goal;
  const accepted = [...(currentRuntime().controlJournal?.reviewAttempts ?? [])]
    .reverse()
    .find(
      (entry) =>
        entry.result?.data.outcome === "accepted" &&
        sameGoalOwner(entry.start.data.owner.goal, owner),
    );
  return {
    owner: snapshot.activeWorkOwner.goal,
    sourceRef: retainedGoalSource(ctx, owner),
    acceptedRef: accepted?.result
      ? { entryId: accepted.result.entryId, digest: accepted.result.digest }
      : null,
    validity: "needs_verification",
  };
}
type ModeTarget = { owner?: WorkOwnerKey | null; boardRef?: SessionModeChangedV1["boardRef"] };
function selectedModeBoard(
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
  target?: ModeTarget,
): SessionModeChangedV1["boardRef"] {
  if (target && "boardRef" in target) return target.boardRef ?? null;
  const board = currentRuntime().board;
  const exists = ctx.sessionManager.getBranch().some((entry) => {
    if (
      entry.type !== "custom" ||
      !("customType" in entry) ||
      entry.customType !== "continuous-tasks:snapshot" ||
      !("data" in entry)
    )
      return false;
    const observed = executionOwnerSnapshot(entry.data, snapshot.activeWorkOwner);
    return observed && journalDigest(observed) === journalDigest(board);
  });
  if (exists) return ownerBoardSnapshot(ctx, snapshot.activeWorkOwner, board);
  if (board.tasks.length)
    throw new Error(
      "Retained board has no actual confirmed owner snapshot; inspect source before changing mode",
    );
  return null;
}
function selectedModeOwner(
  snapshot: ManagementSnapshot,
  mode: ManagementMode,
  state: ManagementState["state"],
  target?: ModeTarget,
): WorkOwnerKey | null {
  if (target && "owner" in target) return target.owner ?? null;
  return mode === "off" && state === "active" ? null : snapshot.activeWorkOwner;
}
function appendMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
  mode: ManagementMode,
  state: ManagementState["state"],
  issues: SessionModeChangedV1["attention"],
  target?: { owner?: WorkOwnerKey | null; boardRef?: SessionModeChangedV1["boardRef"] },
): void {
  const lease = captureControlLease(ctx),
    view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("management-mode-v1"))
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "management-mode-v1" as const])],
      lease,
    );
  const previous = view.modeRecords?.at(-1);
  const boardRef = selectedModeBoard(ctx, snapshot, target),
    activeWorkOwner = selectedModeOwner(snapshot, mode, state, target);
  const data: SessionModeChangedV1 = {
    version: 1,
    kind: "session-mode-changed",
    recordId: randomUUID(),
    sessionId: ctx.sessionManager.getSessionId(),
    revision: (previous?.data.revision ?? 0) + 1,
    previousModeRecord: previous ? { entryId: previous.entryId, digest: previous.digest } : null,
    mode,
    state,
    originOwner: snapshot.activeWorkOwner,
    activeWorkOwner,
    boardRef,
    lastGoal: retainedGoal(snapshot, ctx),
    attention: issues,
    hostIdle: ctx.isIdle(),
    pendingMessages: ctx.hasPendingMessages(),
    observedAt: Date.now(),
  };
  const saved = appendControlFact(pi, ctx, data);
  publishManagement({ entryId: saved.entryId, digest: saved.digest, data });
}
function durableModeSource(ctx: ExtensionContext): boolean {
  // SDK1.1 buffers setup entries until an actual user/assistant conversation.
  // Only that documented setup/no-file case is volatile; corruption/loss throws.
  return inspectRestorableSession(ctx) !== undefined;
}
export function assertPlanningAdmission(ctx: ExtensionContext): void {
  const invocation = cachedInvocationIssue();
  if (invocation) throw new Error(invocation);
  const runtime = currentRuntime();
  const activity = executionActivityIssue(ctx.sessionManager.getSessionId());
  if (activity) throw new Error(activity);
  if (runtime.receiptStore?.pendingCount || runtime.controlJournal?.pendingHostCaptures?.length)
    throw new Error(
      "Resolve actual unknown host captures before preparing another supervised context",
    );
  if (runtime.management?.state === "stopping-with-attention")
    throw new Error("Complete pending mode release/attention before another supervised plan");
}
export function enterPlanningMode(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const snapshot = captureManagementSnapshot(ctx),
    preflight = currentRuntime().preflight;
  if (!preflight || preflight.started || preflight.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("Supervised planning needs the actual current native preflight context");
  if (!durableModeSource(ctx)) {
    currentRuntime().management = {
      mode: "supervised",
      state: "active",
      activeWorkOwner: null,
      lastGoal: snapshot.lastGoal,
      attention: [],
      source: "volatile",
      volatileSource: volatileSource(ctx),
    };
    currentRuntime().enabled = true;
    return;
  }
  appendMode(pi, ctx, snapshot, "supervised", "active", [], { owner: null, boardRef: null });
}
export function adoptSupervisedMode(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prior?: ManagementSnapshot,
): void {
  const owner = retainedWorkOwner(ctx.sessionManager.getSessionId());
  if (owner?.kind !== "goal")
    throw new Error("Supervised mode requires an actual Goal/verified legacy receipt owner");
  const snapshot = prior ?? captureManagementSnapshot(ctx);
  if (
    snapshot.mode === "supervised" &&
    snapshot.source !== "legacy-compatible" &&
    journalDigest(snapshot.activeWorkOwner) === journalDigest(owner)
  )
    return;
  if (!durableModeSource(ctx)) {
    currentRuntime().management = {
      mode: "supervised",
      state: "active",
      activeWorkOwner: owner,
      lastGoal: snapshot.lastGoal,
      attention: [],
      source: "volatile",
      volatileSource: volatileSource(ctx),
    };
    currentRuntime().enabled = true;
    return;
  }
  // The predecessor is physical mode history, not the newly installed Goal cache.
  const previous = readControlJournal(ctx).modeRecords?.at(-1);
  if (previous) publishManagement(previous);
  else currentRuntime().management ??= { ...snapshot };
  const source = previous
    ? { ...snapshot, activeWorkOwner: previous.data.activeWorkOwner }
    : snapshot;
  appendMode(pi, ctx, source, "supervised", "active", [], { owner, boardRef: null });
}
async function prepareTaskMode(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<{ snapshot: ManagementSnapshot; complete: boolean }> {
  await ctx.waitForIdle();
  if (!ctx.isIdle() || ctx.hasPendingMessages() || hasActiveNativeQuestion(ctx))
    throw new Error("Wait for idle/no pending control before selecting task-only management");
  let snapshot = captureManagementSnapshot(ctx);
  if (snapshot.mode === "tasks" && snapshot.activeWorkOwner?.kind === "board") {
    if (snapshot.state !== "active")
      throw new Error("Complete the pending release/attention before re-enabling managed work");
    if (snapshot.source === "legacy-compatible")
      appendMode(pi, ctx, snapshot, "tasks", "active", []);
    return { snapshot, complete: true };
  }
  if (
    snapshot.mode !== "off" &&
    !(snapshot.mode === "tasks" && snapshot.activeWorkOwner === null)
  ) {
    await requestModeChange(pi, ctx, "off");
    snapshot = captureManagementSnapshot(ctx);
  }
  if (snapshot.state === "stopping-with-attention" && snapshot.mode !== "tasks")
    throw new Error("Complete tracked writer/control release before task-only management");
  return { snapshot, complete: false };
}
function repairTaskBoardProjection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
): ManagementSnapshot {
  const record = snapshot.record;
  if (
    snapshot.mode !== "tasks" ||
    snapshot.activeWorkOwner !== null ||
    record?.data.state !== "active" ||
    record.data.activeWorkOwner?.kind !== "board"
  )
    return snapshot;
  const boardRef = ownerBoardSnapshot(ctx, null, currentRuntime().board);
  const source = { ...snapshot, activeWorkOwner: record.data.activeWorkOwner };
  // No await or business operation: the original owner is a metadata lease,
  // still stopping, only until its physically confirmed null-owner successor.
  currentRuntime().management = source;
  appendMode(
    pi,
    ctx,
    source,
    "tasks",
    "stopping-with-attention",
    [attention("source", "Retained replacement board needs its actual seed")],
    { owner: null, boardRef },
  );
  return captureManagementSnapshot(ctx);
}
function bootstrapTaskBoard(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
  preserveVolatileBoard = false,
): ManagementSnapshot {
  const runtime = currentRuntime();
  if (runtime.management && snapshot.mode !== "off")
    return repairTaskBoardProjection(pi, ctx, snapshot);
  enableSessionScope(pi);
  const newWorkspace =
    !preserveVolatileBoard &&
    snapshot.mode === "off" &&
    (runtime.goal?.current || runtime.supervisor);
  const board = newWorkspace ? createEmptyBoard() : structuredClone(runtime.board);
  board.generation = runtime.board.generation + 1;
  const saved = appendManagedBoardSnapshot(pi, ctx, board);
  appendMode(
    pi,
    ctx,
    snapshot,
    "tasks",
    "stopping-with-attention",
    [attention("source", "Task-only board owner bootstrap needs confirmed seed")],
    { owner: null, boardRef: { entryId: saved.entryId, digest: saved.digest } },
  );
  setBoard(board);
  return captureManagementSnapshot(ctx);
}
function finishTaskBootstrap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
): void {
  const runtime = currentRuntime();
  runtime.controlJournal = readControlJournal(ctx);
  if (!runtime.controlJournal.boardOwner) prepareExecutionOwner(pi, ctx, runtime.board);
  runtime.controlJournal = readControlJournal(ctx);
  const owner = runtime.controlJournal.boardOwner;
  if (!owner) throw new Error("Task-only management has no actual confirmed board owner");
  appendMode(pi, ctx, snapshot, "tasks", "active", [], {
    owner,
    boardRef: ownerBoardSnapshot(ctx, null, runtime.board),
  });
}
export function managementBoardReplacement(events: readonly unknown[]): boolean {
  const state = currentRuntime().management;
  return (
    !!state &&
    state.mode === "tasks" &&
    state.source === "confirmed" &&
    events.some(isBoardReplacementEvent)
  );
}
export function completeManagementBoardUpdate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  events: readonly unknown[],
): void {
  if (!managementBoardReplacement(events)) return;
  const snapshot = captureManagementSnapshot(ctx),
    boardRef = ownerBoardSnapshot(ctx, null, currentRuntime().board);
  appendMode(
    pi,
    ctx,
    snapshot,
    "tasks",
    "stopping-with-attention",
    [attention("source", "Task board replacement needs its actual new owner")],
    { owner: null, boardRef },
  );
  finishTaskBootstrap(pi, ctx, captureManagementSnapshot(ctx));
}
function resetVolatileTaskHistory(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
): void {
  const runtime = currentRuntime();
  if (snapshot.mode !== "off" || !(runtime.goal?.current || runtime.supervisor)) return;
  const board = createEmptyBoard();
  board.generation = runtime.board.generation + 1;
  persistTaskUpdate(pi, [{ type: "clear_tasks" }], board, undefined, ctx);
}
export async function enableTasksMode(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const prepared = await prepareTaskMode(pi, ctx);
  if (prepared.complete) return;
  const runtime = currentRuntime();
  let snapshot = prepared.snapshot;
  if (!durableModeSource(ctx)) {
    resetVolatileTaskHistory(pi, ctx, snapshot);
    runtime.management = {
      mode: "tasks",
      state: "active",
      activeWorkOwner: null,
      lastGoal: snapshot.lastGoal,
      attention: [],
      source: "volatile",
      volatileSource: volatileSource(ctx),
    };
    enableSessionScope(pi);
    runtime.enabled = true;
    return;
  }
  snapshot = bootstrapTaskBoard(pi, ctx, snapshot);
  finishTaskBootstrap(pi, ctx, snapshot);
}
export function materializeManagement(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const runtime = currentRuntime(),
    selected = runtime.management;
  if (
    !selected ||
    selected.source !== "volatile" ||
    selected.state === "stopping-with-attention" ||
    !durableModeSource(ctx)
  )
    return;
  let snapshot = captureManagementSnapshot(ctx);
  const identityIssue = managementIdentityIssue(ctx, selected);
  if (identityIssue) throw new Error(identityIssue);
  if (selected.mode === "off") {
    // Source materialization is not proof that unrelated Main work is idle.
    if (ctx.isIdle() && !ctx.hasPendingMessages()) completeModeChange(pi, ctx, snapshot);
    return;
  }
  if (selected.mode === "tasks") {
    snapshot = bootstrapTaskBoard(pi, ctx, { ...snapshot, mode: "off" }, true);
    finishTaskBootstrap(pi, ctx, snapshot);
    return;
  }
  appendMode(pi, ctx, snapshot, "supervised", "active", [], {
    owner: selected.activeWorkOwner,
    boardRef: null,
  });
}
function modeRequestCurrent(
  ctx: ExtensionContext,
  runtime: ReturnType<typeof currentRuntime>,
  snapshot: ManagementSnapshot,
): () => boolean {
  const manager = ctx.sessionManager,
    sessionId = manager.getSessionId(),
    file = manager.getSessionFile();
  const modeRef = snapshot.record?.entryId,
    owner = journalDigest(snapshot.activeWorkOwner);
  return () =>
    runtime === currentRuntime() &&
    manager === ctx.sessionManager &&
    sessionId === manager.getSessionId() &&
    file === manager.getSessionFile() &&
    modeRef === runtime.management?.record?.entryId &&
    owner === journalDigest(runtime.management?.activeWorkOwner ?? null);
}
async function settleManagedMain(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.isIdle()) ctx.abort();
  try {
    await ctx.waitForIdle();
  } catch {
    /* The actual idle observation, not ACK, decides release. */
  }
}
export async function requestModeChange(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  mode: ManagementMode,
): Promise<void> {
  if (mode !== "off")
    throw new Error("Explicit enabling adapters have not selected their new owner yet");
  const runtime = currentRuntime();
  // Cancellation wins even when ownership/journal inspection itself cannot complete.
  invalidateGoalCallbacks();
  const snapshot = captureManagementSnapshot(ctx);
  runtime.management = { ...snapshot, state: "stopping-with-attention" };
  if (snapshot.identityIssue) {
    runtime.management.attention = [attention("source", snapshot.identityIssue)];
    throw new Error(snapshot.identityIssue);
  }
  if (snapshot.mode === "off" && snapshot.state === "active") {
    runtime.management = { ...snapshot };
    runtime.enabled = false;
    if (snapshot.source === "volatile") materializeManagement(pi, ctx);
    return;
  }
  const current = modeRequestCurrent(ctx, runtime, snapshot),
    token = goalLease(),
    humanEpoch = runtime.humanEpoch;
  await settleManagedMain(ctx);
  if (!current() || token !== goalLease() || humanEpoch !== runtime.humanEpoch)
    throw new Error("Management owner/context changed while stopping; inspect before repair");
  if (runtime.goal?.current?.supervisor === null) await stopCurrentGoal(pi, ctx);
  if (!current())
    throw new Error("Management owner/context changed while closing original control");
  completeModeChange(pi, ctx, snapshot);
}
function pauseReleasedBoard(pi: ExtensionAPI, issues: SessionModeChangedV1["attention"]): void {
  const board = currentRuntime().board;
  // A writer can remain uncertain while the retained board is genuinely paused.
  // Do not append through an uncertain source or unresolved native control.
  if (
    issues.some((issue) => ["source", "control"].includes(issue.kind)) ||
    board.workflowStatus !== "active"
  )
    return;
  const next = structuredClone(board);
  next.workflowStatus = "paused";
  next.pauseReason = issues.length
    ? "Management stopping; inspect retained attention before complete release"
    : "Management stopped by user; retained work is history";
  next.generation++;
  persistEntries(pi, { type: "pause_user", reason: next.pauseReason }, next);
  setBoard(next);
}
function stopRetainedOwner(
  pi: ExtensionAPI,
  snapshot: ManagementSnapshot,
  issues: SessionModeChangedV1["attention"],
): void {
  pauseReleasedBoard(pi, issues);
  const runtime = currentRuntime(),
    state = runtime.supervisor;
  if (snapshot.activeWorkOwner?.kind !== "goal" || !state) return;
  state.status = issues.length ? "fault" : "stopped";
  state.pending = false;
  state.externalWait = undefined;
  state.reason = issues.length
    ? "Automation stopped; inspect writer/control attention before complete release"
    : "Stopped by user; old work retained as history";
  if (issues.length) state.holdCause = "interrupted";
  if (!runtime.journalFault) saveSupervisor(pi);
}
function publishVolatileRelease(
  ctx: ExtensionContext,
  snapshot: ManagementSnapshot,
  issues: SessionModeChangedV1["attention"],
): void {
  const runtime = currentRuntime();
  runtime.management = {
    ...snapshot,
    mode: issues.length ? snapshot.mode : "off",
    state: issues.length ? "stopping-with-attention" : "active",
    activeWorkOwner: issues.length ? snapshot.activeWorkOwner : null,
    lastGoal: retainedGoal(snapshot, ctx),
    attention: issues,
    source: "volatile",
    volatileSource: volatileSource(ctx),
    record: undefined,
  };
  runtime.enabled = issues.length > 0;
}
export function completeModeChange(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prior?: ManagementSnapshot,
): void {
  const snapshot = prior ?? captureManagementSnapshot(ctx),
    runtime = currentRuntime();
  const identityIssue = managementIdentityIssue(ctx, snapshot);
  if (identityIssue) {
    runtime.cancel();
    throw new Error(identityIssue);
  }
  try {
    const durable = durableModeSource(ctx);
    if (!runtime.journalFault && durable) runtime.controlJournal = readControlJournal(ctx);
    const issues = releaseAttention(ctx);
    stopRetainedOwner(pi, snapshot, issues);
    if (runtime.journalFault) {
      runtime.management = { ...snapshot, state: "stopping-with-attention", attention: issues };
      return;
    }
    if (!durable) {
      publishVolatileRelease(ctx, snapshot, issues);
      return;
    }
    appendMode(
      pi,
      ctx,
      snapshot,
      issues.length ? snapshot.mode : "off",
      issues.length ? "stopping-with-attention" : "active",
      issues,
    );
  } catch (error) {
    runtime.journalFault ??=
      error instanceof Error ? error.message : "Management persistence uncertain";
    runtime.management = {
      ...snapshot,
      state: "stopping-with-attention",
      attention: [attention("source", runtime.journalFault)],
    };
    runtime.cancel();
    throw error;
  }
}
