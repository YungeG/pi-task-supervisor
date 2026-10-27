import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import { readControlFences } from "./control-journal";
import { createEmptyBoard } from "./engine";
import type { TaskBoardSnapshot } from "./types";
import { inspectRestorableSession, sessionJournalView } from "./human-control";
import {
  findGoalReadbackProof,
  inspectSessionJournal,
  isGoalReadbackFrame,
  journalDigest,
  type JournalNode,
  type SessionJournal,
} from "./human-journal";
import {
  NativePreflightControlSchema,
  PreflightStateSchema,
  type PreflightState,
} from "./preflight";
import { decodeSupervisorEntry } from "./supervisor";
import { isSafeBoundedText, isValidSnapshotV2, isValidLegacySnapshot } from "./validation";
import { migrateLegacySnapshot } from "./state";
import {
  GOAL_ENTRY,
  isGoalCarrier,
  isGoalRecord,
  scopeEqual,
  type GoalCommit,
  type GoalControl,
  type GoalCurrent,
  type GoalRecord,
  type GoalRuntime,
  type GoalSeed,
  type GoalSource,
  type GoalSourceRef,
  type GoalStateRecord,
} from "./goal-records";

function fail(message: string): never {
  throw new Error(`Goal lifecycle: ${message}`);
}
export function goalTransitionScope(
  from: GoalSource,
  seed: GoalSeed,
  transitionId: string,
): object {
  return { action: "archive-and-plan", transitionId, from, seed };
}
function entryData(ctx: ExtensionContext, node: JournalNode): unknown {
  if (node.data !== undefined) return node.data;
  const entry = ctx.sessionManager.getEntry(node.id);
  if (!entry || journalDigest(entry) !== node.digest) return fail("native source/cache mismatch");
  return entry.type === "custom" ? entry.data : fail("source is not an owner record");
}
export function resolveGoalSource(
  ctx: ExtensionContext,
  journal: SessionJournal,
  ref: GoalSourceRef,
): unknown {
  const node = journal.branch.find((e) => e.id === ref.entryId);
  if (!node || node.digest !== ref.entryDigest || node.type !== "custom")
    return fail("source entry changed or left the branch");
  const data = entryData(ctx, node);
  if (ref.selector === "data") return data;
  if (ref.selector === "legacy-board")
    return isValidLegacySnapshot(data)
      ? migrateLegacySnapshot(data)
      : fail("invalid legacy board source");
  if (ref.selector === "snapshot")
    return isGoalCarrier(data) ? data.snapshot : fail("invalid scoped source carrier");
  return lifecycleSource(data, ref.selector);
}
function lifecycleSource(data: unknown, selector: GoalSourceRef["selector"]): unknown {
  if (!isGoalRecord(data)) return fail("invalid source lifecycle carrier");
  if (selector === "supervisor")
    return data.kind === "goal-state" && data.supervisor
      ? data.supervisor
      : fail("missing source Supervisor");
  if (selector === "seed-board")
    return data.kind === "transition-committed"
      ? data.seed.board
      : fail("missing source board seed");
  if (data.kind === "transition-committed") return data.seed.preflight;
  return data.kind === "goal-state" && data.preflightSeed
    ? data.preflightSeed
    : fail("missing source preflight seed");
}

export function goalSourceRef(
  node: JournalNode,
  selector: GoalSourceRef["selector"],
): GoalSourceRef {
  return { entryId: node.id, entryDigest: node.digest, selector };
}
function validateSource(
  ctx: ExtensionContext,
  journal: SessionJournal,
  control: GoalControl,
): void {
  const source = control.from;
  if (source.sessionId !== journal.sessionId || control.sessionId !== journal.sessionId)
    fail("foreign transition");
  const board = sourceBoard(ctx, journal, source);
  if (journalDigest(board) !== source.boardDigest) fail("invalid source board");
  if (
    board.decision ||
    board.tasks.some((t) => t.executionRef) ||
    board.workflowStatus === "active"
  )
    fail("source still has live work or a decision");
  validateSourcePayloads(ctx, journal, source);
  for (const ref of [source.head, source.board, source.preflight, source.supervisor]) {
    if (ref && journal.branch.findIndex((n) => n.id === ref.entryId) < 0)
      fail("unclosed source reference");
  }
  if (control.seed.board.generation !== board.generation + 1)
    fail("new board generation is not the exact successor");
}
export function sourceBoard(
  ctx: ExtensionContext,
  journal: SessionJournal,
  source: GoalSource,
): TaskBoardSnapshot {
  if (source.board) {
    const board = resolveGoalSource(ctx, journal, source.board);
    if (source.board.selector === "legacy-board") return board as TaskBoardSnapshot;
    if (!isValidSnapshotV2(board)) return fail("invalid source board");
    return board;
  }
  const recorded = journal.branch.some((node) =>
    ["continuous-tasks:snapshot", "phased-tasks:snapshot"].includes(node.customType ?? ""),
  );
  if (source.scope || !source.supervisor || recorded)
    return fail("missing board is not verified empty legacy history");
  return createEmptyBoard();
}
function validateSourcePayloads(
  ctx: ExtensionContext,
  journal: SessionJournal,
  source: GoalSource,
): void {
  if (source.supervisor) {
    const data = resolveGoalSource(ctx, journal, source.supervisor);
    const decoded = decodeSupervisorEntry(data);
    if (
      !["stopped", "completed"].includes(decoded.state.status) ||
      decoded.state.pending ||
      decoded.state.sessionId !== journal.sessionId
    )
      fail("source Supervisor is not terminal");
    if (journalDigest(data) !== source.supervisorDigest) fail("source Supervisor digest changed");
  } else if (source.supervisorDigest !== null) fail("untraced Supervisor digest");
  if (source.preflight) {
    const data = resolveGoalSource(ctx, journal, source.preflight);
    if (
      !Check(PreflightStateSchema, data) ||
      data.sessionId !== journal.sessionId ||
      journalDigest(data) !== source.preflightDigest
    )
      fail("source preflight changed");
  } else if (source.preflightDigest !== null) fail("untraced preflight digest");
}
function validatedSeed(raw: unknown, sessionId: string): GoalSeed {
  if (!raw || typeof raw !== "object") return fail("invalid new goal identity");
  const seed = raw as GoalSeed;
  if (!isSafeBoundedText(seed.goal, 4000) || !/^rg-[a-f0-9-]{36}$/.test(seed.goalRunId))
    return fail("invalid new goal identity");
  const board = seed.board;
  if (
    !isValidSnapshotV2(board) ||
    board.tasks.length ||
    board.phases.length ||
    board.workflowStatus !== "inactive" ||
    board.decision ||
    board.finalAcceptanceTaskId ||
    board.pendingPhasePrompt ||
    board.stagnantSettles
  )
    fail("new goal inherited board state");
  validatePlanningSeed(seed.preflight, sessionId, seed.goal, seed.planning.preflightId);
  if (seed.planning.attemptNo !== 0 || seed.planning.status !== "prepared")
    fail("new goal must start with one prepared attempt");
  return seed;
}
function validatePlanningSeed(
  data: unknown,
  sessionId: string,
  goal: string,
  preflightId: string,
): asserts data is PreflightState {
  if (
    !Check(PreflightStateSchema, data) ||
    data.version !== 2 ||
    data.sessionId !== sessionId ||
    data.goal !== goal ||
    data.preflightId !== preflightId ||
    data.revision !== 0 ||
    data.phase !== "planning"
  )
    fail("invalid planning seed identity");
  if (
    data.proposal ||
    data.approval ||
    data.started ||
    data.planId ||
    data.planDigest ||
    data.permissionRequest ||
    data.startRequest
  )
    fail("planning seed inherited authority");
}
function decodeControl(
  ctx: ExtensionContext,
  journal: SessionJournal,
  node: JournalNode,
): GoalControl {
  if (
    !isGoalRecord(node.data) ||
    node.data.kind !== "transition-control" ||
    !isGoalReadbackFrame(node.data.humanInteraction)
  )
    return fail("invalid transition control");
  const control = node.data as GoalControl;
  validatedSeed(control.seed, journal.sessionId);
  const frame = control.humanInteraction;
  if (
    control.transitionId !== frame.requestId ||
    frame.sessionId !== journal.sessionId ||
    frame.baseEntryId !== control.from.head.entryId ||
    frame.baseEntryDigest !== control.from.head.entryDigest ||
    frame.scopeDigest !==
      journalDigest(goalTransitionScope(control.from, control.seed, control.transitionId))
  )
    fail("goal native scope changed");
  validateSource(ctx, journal, control);
  return control;
}
function prefix(journal: SessionJournal, index: number): SessionJournal {
  const branch = journal.branch.slice(0, index + 1);
  return { ...journal, branch, nodes: new Map(branch.map((n) => [n.id, n])) };
}
function validateSupersession(
  pending: NonNullable<GoalRuntime["pending"]>,
  control: GoalControl,
  journal: SessionJournal,
): void {
  const old = journal.branch.find((n) => n.id === pending.controlEntryId);
  const proof = findGoalReadbackProof(journal, pending.control.transitionId);
  const previous = control.supersedes;
  if (!old || !previous || proof.status !== "unconfirmed") fail("unconfirmed predecessor changed");
  if (
    previous.entryId !== old.id ||
    previous.entryDigest !== old.digest ||
    previous.requestId !== pending.control.transitionId
  )
    fail("unconfirmed predecessor changed");
  if (
    journalDigest(control.from) !== journalDigest(pending.control.from) ||
    journalDigest(control.seed) !== journalDigest(pending.control.seed)
  )
    fail("supersession changed the chosen goal");
}
function acceptControl(
  runtime: GoalRuntime,
  control: GoalControl,
  node: JournalNode,
  journal: SessionJournal,
): void {
  if (runtime.pending) validateSupersession(runtime.pending, control, journal);
  else if (control.supersedes) fail("missing superseded transition");
  const current = runtime.current;
  if (current) {
    if (
      !control.from.scope ||
      !scopeEqual(control.from.scope, current.scope) ||
      control.from.head.entryId !== current.headEntryId
    )
      fail("source goal selection changed");
    if (!["stopped", "completed"].includes(current.phase))
      fail("current goal was not stopped/completed");
  } else if (control.from.scope) fail("source lifecycle selection is missing");
  runtime.pending = { controlEntryId: node.id, control, confirmed: false };
}
function validateCommitProof(
  commit: GoalCommit,
  pending: NonNullable<GoalRuntime["pending"]>,
  journal: SessionJournal,
): void {
  const proof = findGoalReadbackProof(journal, commit.transitionId);
  if (proof.status !== "confirmed") fail("commit lacks confirmed native readback");
  if (
    proof.control.id !== commit.controlEntryId ||
    proof.control.digest !== commit.controlDigest ||
    proof.witness.id !== commit.witnessEntryId ||
    proof.witness.digest !== commit.witnessDigest
  )
    fail("commit proof references changed");
  if (
    journalDigest(commit.from) !== journalDigest(pending.control.from) ||
    journalDigest(commit.seed) !== journalDigest(pending.control.seed)
  )
    fail("commit changed its native choice");
}
function acceptCommit(runtime: GoalRuntime, node: JournalNode, journal: SessionJournal): void {
  if (!isGoalRecord(node.data) || node.data.kind !== "transition-committed")
    return fail("invalid commit");
  const commit = node.data as GoalCommit;
  const pending = runtime.pending;
  if (!pending || commit.transitionId !== pending.control.transitionId)
    fail("commit has no exact pending control");
  validateCommitProof(commit, pending, journal);
  const seed = validatedSeed(commit.seed, journal.sessionId);
  const keys = [
    commit.from.goalKey,
    runtime.current?.scope.goalRunId,
    ...runtime.archives.map((a) => a.goalKey),
  ];
  if (keys.includes(seed.goalRunId)) fail("GoalRun identity reused");
  runtime.archives.push({
    commitEntryId: node.id,
    goalKey: commit.from.goalKey,
    source: structuredClone(commit.from),
  });
  runtime.current = {
    scope: { goalRunId: seed.goalRunId, lifecycleCommitId: node.id },
    seed: structuredClone(seed),
    phase: "planning",
    planning: structuredClone(seed.planning),
    headEntryId: node.id,
    preflightSeed: structuredClone(seed.preflight),
    preflightBaseEntryId: node.id,
    supervisor: null,
    board: structuredClone(seed.board),
  };
  runtime.pending = undefined;
}

function validateSupervisorState(
  current: GoalCurrent,
  state: GoalStateRecord,
  sessionId: string,
): void {
  if (!state.supervisor) fail("missing Supervisor state");
  const data = state.supervisor as { version?: unknown; receiptLedger?: { goalId?: unknown } };
  const decoded = decodeSupervisorEntry(data);
  const value = decoded.state;
  const identity = [
    value.sessionId,
    value.goal,
    value.model,
    value.preflightBinding?.preflightId,
    value.status,
  ];
  const expected = [
    sessionId,
    current.seed.goal,
    current.seed.model,
    current.preflightSeed.preflightId,
    state.phase,
  ];
  if (
    data.version !== 3 ||
    data.receiptLedger?.goalId !== current.scope.goalRunId ||
    journalDigest(identity) !== journalDigest(expected)
  )
    fail("Supervisor changed GoalRun identity");
  const inherited = [
    value.reviews,
    value.continuations,
    value.stagnant,
    value.tokens,
    value.cost,
    value.epoch,
    value.pending,
    value.bindings.length,
    value.acceptedDigest,
    decoded.ledger?.receiptCount,
    decoded.ledger?.pending.length,
  ];
  if (current.supervisor === null && inherited.some(Boolean))
    fail("Supervisor start inherited proof or budgets");
}

function sameAttempt(current: GoalCurrent, state: GoalStateRecord): void {
  if (
    state.planning.attemptNo !== current.planning.attemptNo ||
    state.planning.attemptId !== current.planning.attemptId ||
    state.planning.preflightId !== current.planning.preflightId
  )
    fail("planning attempt changed unexpectedly");
}
function validatePlanningState(
  current: GoalCurrent,
  state: GoalStateRecord,
  sessionId: string,
): void {
  if (
    current.supervisor !== null ||
    state.supervisor !== null ||
    ["stopped", "completed"].includes(current.phase)
  )
    fail("planning control cannot reopen execution");
  if (state.action === "prepare-planning") {
    if (
      state.planning.attemptNo !== current.planning.attemptNo + 1 ||
      state.planning.attemptId === current.planning.attemptId ||
      state.planning.preflightId === current.planning.preflightId ||
      state.planning.status !== "prepared" ||
      state.phase !== "planning"
    )
      fail("invalid replacement planning attempt");
    validatePlanningSeed(
      state.preflightSeed,
      sessionId,
      current.seed.goal,
      state.planning.preflightId,
    );
    return;
  }
  sameAttempt(current, state);
  if (state.preflightSeed !== undefined) fail("unexpected planning seed replacement");
  validatePlanningAction(current, state);
}
function validatePlanningAction(current: GoalCurrent, state: GoalStateRecord): void {
  const transitions = {
    "claim-planning-dispatch": {
      before: ["prepared"],
      after: ["dispatch-claimed"],
      phases: ["planning"],
    },
    "observe-planning-dispatch": {
      before: ["dispatch-claimed"],
      after: ["dispatched"],
      phases: ["planning"],
    },
    "settle-planning": {
      before: ["dispatch-claimed", "dispatched"],
      after: ["settled", "closed-unknown-result"],
      phases: ["planning", "planning-interrupted"],
    },
    "stop-unstarted": {
      before: ["prepared", "dispatch-claimed", "dispatched", "settled", "closed-unknown-result"],
      after: ["prepared", "settled", "closed-unknown-result"],
      phases: ["stopped"],
    },
  };
  if (!(state.action in transitions)) fail("invalid planning action transition");
  const rule = transitions[state.action as keyof typeof transitions];
  if (
    !rule.before.includes(current.planning.status) ||
    !rule.after.includes(state.planning.status) ||
    !rule.phases.includes(state.phase)
  )
    fail("invalid planning action transition");
  if (state.action === "stop-unstarted" && state.disposition !== "closed-unstarted")
    fail("stop disposition missing");
}

function validateQuiescence(
  current: GoalCurrent,
  state: GoalStateRecord,
  node: JournalNode,
  sessionId: string,
): void {
  const needs = ["prepare-planning", "settle-planning", "stop-unstarted"].includes(state.action);
  const observed = state.quiescence;
  if (needs && !observed) fail("planning control lacks observed host quiescence");
  if (
    observed &&
    (observed.sessionId !== sessionId ||
      observed.goalRunId !== current.scope.goalRunId ||
      observed.attemptId !== current.planning.attemptId ||
      observed.branchAnchor !== node.parentId)
  )
    fail("planning quiescence scope changed");
  if (state.action !== "stop-unstarted" && state.disposition !== undefined)
    fail("unexpected stop disposition");
}
function acceptState(runtime: GoalRuntime, node: JournalNode): void {
  if (
    !isGoalRecord(node.data) ||
    node.data.kind !== "goal-state" ||
    !runtime.current ||
    runtime.pending
  )
    return fail("state has no current GoalRun");
  const state = node.data as GoalStateRecord;
  const current = runtime.current;
  if (
    state.sessionId !== runtime.sessionId ||
    !scopeEqual(state.scope, current.scope) ||
    state.previous !== current.headEntryId
  )
    fail("goal-state predecessor/scope changed");
  validateQuiescence(current, state, node, runtime.sessionId);
  if (state.action === "supervisor") {
    sameAttempt(current, state);
    if (state.preflightSeed !== undefined) fail("Supervisor cannot replace a planning seed");
    validateSupervisorState(current, state, runtime.sessionId);
  } else validatePlanningState(current, state, runtime.sessionId);
  current.phase = state.phase;
  current.planning = structuredClone(state.planning);
  current.headEntryId = node.id;
  current.supervisor = structuredClone(state.supervisor);
  current.disposition = state.disposition;
  if (state.preflightSeed) {
    current.preflightSeed = structuredClone(state.preflightSeed);
    current.preflightBaseEntryId = node.id;
  }
}
function validateScopedOwner(current: GoalCurrent, node: JournalNode): void {
  if (!["continuous-tasks:snapshot", "continuous-tasks:preflight"].includes(node.customType ?? ""))
    return;
  const data = node.data;
  if (!isGoalCarrier(data) || !scopeEqual(data, current.scope))
    fail("owner record left current GoalRun scope");
  if (node.customType === "continuous-tasks:snapshot") {
    if (!isValidSnapshotV2(data.snapshot) || data.snapshot.generation <= current.board.generation)
      fail("invalid/nonmonotonic scoped board");
    current.board = structuredClone(data.snapshot);
    return;
  }
  if (!Check(PreflightStateSchema, data.snapshot) || data.snapshot.version !== 2)
    fail("invalid scoped preflight");
  const expected = [
    current.preflightSeed.sessionId,
    current.seed.goal,
    current.planning.preflightId,
  ];
  const actual = [data.snapshot.sessionId, data.snapshot.goal, data.snapshot.preflightId];
  if (journalDigest(actual) !== journalDigest(expected))
    fail("scoped preflight changed its current planning identity");
}
function validateClosedPreflight(current: GoalCurrent, node: JournalNode): void {
  if (
    node.customType === "continuous-tasks:preflight-control" &&
    current.phase === "stopped" &&
    current.disposition === "closed-unstarted" &&
    node.data &&
    typeof node.data === "object" &&
    "kind" in node.data &&
    node.data.kind !== "revoke" &&
    !(node.data.kind === "reject" && Check(NativePreflightControlSchema, node.data))
  )
    fail("closed unstarted goal cannot acquire a new permission/start control");
}
function validateOwnerAfterFence(runtime: GoalRuntime, node: JournalNode, seen: boolean): void {
  if (node.customType === GOAL_ENTRY) {
    if (![1, 2, 3, 5, 6].includes(node.wireVersion ?? -1))
      fail("unsupported Supervisor wire version");
    // readControlFences validates the complete selected branch before this owner fold.
    if (node.wireVersion === 6) return;
    if (seen && node.wireVersion !== 5)
      fail("Supervisor checkpoint downgraded after lifecycle fence");
    return;
  }
  const owners = [
    "continuous-tasks:snapshot",
    "continuous-tasks:preflight",
    "continuous-tasks:event",
    "continuous-tasks:preflight-control",
    "continuous-tasks:receipt-ledger",
  ];
  if (runtime.pending && owners.includes(node.customType ?? ""))
    fail("owner changed during pending transition");
  const current = runtime.current;
  if (!current) return;
  validateClosedPreflight(current, node);
  if (
    node.customType === "continuous-tasks:receipt-ledger" &&
    (current.supervisor === null ||
      node.receiptGoalId !== current.scope.goalRunId ||
      node.receiptSessionId !== runtime.sessionId)
  )
    fail("receipt arrived outside the started current GoalRun");
  validateScopedOwner(current, node);
}

function passiveBoardSnapshot(
  node: JournalNode,
  passive: boolean,
  pending: GoalRuntime["pending"],
): boolean {
  return (
    passive &&
    !pending &&
    node.customType === "continuous-tasks:snapshot" &&
    !isGoalCarrier(node.data) &&
    isValidSnapshotV2(node.data)
  );
}
/** Physical read-only fold. Native admission is never based on a substituted SessionManager. */
export function readGoalJournal(
  ctx: ExtensionContext,
  supplied?: SessionJournal,
): GoalRuntime | undefined {
  const journal = supplied ?? inspectRestorableSession(ctx);
  if (!journal) return undefined;
  const control = readControlFences(journal);
  const modeRecords = new Map(
    (control.modeRecords ?? []).map((record) => [record.entryId, record.data]),
  );
  const result: GoalRuntime = { sessionId: journal.sessionId, archives: [] };
  let seen = false,
    passiveBoard = false;
  for (const [index, node] of journal.branch.entries()) {
    const data = node.data;
    const mode = modeRecords.get(node.id);
    if (mode) passiveBoard = ["off", "tasks"].includes(mode.mode);
    // Only an already encountered, fully validated handoff makes a later bare
    // board another context. No future mode record or pending transition can
    // excuse a missing/foreign scoped carrier in the retained Goal history.
    if (passiveBoardSnapshot(node, passiveBoard, result.pending)) continue;
    validateOwnerAfterFence(result, node, seen);
    if (node.customType === GOAL_ENTRY && node.wireVersion === 5) {
      if (!isGoalRecord(data) || data.sessionId !== journal.sessionId)
        fail("invalid lifecycle record");
      seen = true;
      const view = prefix(journal, index);
      if (data.kind === "transition-control")
        acceptControl(result, decodeControl(ctx, view, node), node, view);
      else if (data.kind === "transition-committed") acceptCommit(result, node, view);
      else acceptState(result, node);
    }
  }
  if (!seen) return undefined;
  if (result.pending)
    result.pending.confirmed =
      findGoalReadbackProof(journal, result.pending.control.transitionId).status === "confirmed";
  return result;
}
export function appendObservedGoalCheckpoint(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  record: GoalRecord,
): string {
  const parent = ctx.sessionManager.getLeafId();
  pi.appendEntry(GOAL_ENTRY, record);
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const id = ctx.sessionManager.getLeafId();
  const observed = id ? journal.nodes.get(id) : undefined;
  if (
    !observed ||
    observed.parentId !== parent ||
    observed.customType !== GOAL_ENTRY ||
    journalDigest(observed.data) !== journalDigest(record)
  )
    return fail("checkpoint append not physically confirmed");
  return observed.id;
}
