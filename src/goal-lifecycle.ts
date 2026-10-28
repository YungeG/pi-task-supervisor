import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { RestoreJournalRead } from "./restore-journal";
import { randomUUID } from "node:crypto";
import { executionActivityIssue, executionOwnerSnapshot } from "./control-journal";
import { ensureApprovalWorkflowFence } from "./approval-bundle";

export interface GoalRestoreOptions {
  read: RestoreJournalRead;
  install: (operation: () => void) => void;
  afterConfirmedAppend: (entryId: string) => void;
}
import { createEmptyBoard } from "./engine";
import { getBoardRef } from "./state";
import { currentRuntime } from "./runtime";
import { adoptSupervisedMode, captureManagementSnapshot } from "./management-policy";
import { isSafeBoundedText, isValidSnapshotV2 } from "./validation";
import { hasActiveNativeQuestion, isTrustedLocalTui, requestNativeAnswer } from "./human-ui";
import {
  captureGoalReadbackFrame,
  publishGoalReadbackControl,
  sessionJournalView,
} from "./human-control";
import {
  findGoalReadbackProof,
  inspectSessionJournal,
  journalDigest,
  type JournalNode,
  type SessionJournal,
} from "./human-journal";
import {
  appendObservedGoalCheckpoint,
  goalSourceRef,
  goalTransitionScope,
  readGoalJournal,
  resolveGoalSource,
  sourceBoard,
} from "./goal-journal";
import {
  GOAL_ENTRY,
  GOAL_PROTOCOL,
  type GoalCommit,
  type GoalControl,
  type GoalCurrent,
  type GoalRuntime,
  type GoalSeed,
  type GoalSource,
  type GoalSourceRef,
  isGoalCarrier,
  scopeEqual,
} from "./goal-records";
import { invalidateGoalCallbacks } from "./goal-scope";
import { decodeSupervisorEntry } from "./supervisor";
import {
  currentPreflightRequestIssue,
  unstartedPreflightStopIssue,
  type PreflightState,
} from "./preflight";
import { goalPlanningRef, type GoalPlanningRef } from "./goal-planning";
export {
  replanCurrentGoal,
  stopCurrentGoal,
  dispatchGoalPlanning,
  settleGoalPlanning,
} from "./goal-planning";

export interface GoalTransitionRequest {
  goal: string;
  intent: "supervise" | "preflight";
}
export interface GoalTransitionView {
  status: "fresh" | "same-current" | "eligible" | "blocked" | "pending";
  goal: string;
  reason?: string;
  source?: GoalSource;
}
export interface GoalTransitionResult {
  planning?: GoalPlanningRef;
  status: "cancelled" | "deferred" | "committed-planning" | "projection-pending" | "blocked";
  reason?: string;
}
const normalize = (value: string) => value.trim().split(/\s+/).join(" ");
function failure(message: string): never {
  throw new Error(`Goal lifecycle: ${message}`);
}
function sourceNode(journal: SessionJournal, id: string): JournalNode {
  return journal.branch.find((node) => node.id === id) ?? failure("source anchor missing");
}
function passiveOwnerView(): boolean {
  const mode = currentRuntime().management;
  return !!mode && (mode.mode !== "supervised" || mode.activeWorkOwner?.kind !== "goal");
}
function retainedLegacyBoardRef(
  journal: SessionJournal,
  type: string,
  current?: GoalCurrent,
): GoalSourceRef | null | undefined {
  if (current || !passiveOwnerView() || type !== "continuous-tasks:snapshot") return undefined;
  const supervisor = journal.branch
    .filter((node) => node.customType === GOAL_ENTRY && node.wireVersion !== 6)
    .at(-1);
  const retained = [...(currentRuntime().controlJournal?.modeRecords ?? [])]
    .reverse()
    .find(
      (record) =>
        record.data.originOwner?.kind === "goal" &&
        record.data.mode === "off" &&
        record.data.state === "active" &&
        record.data.lastGoal?.sourceRef?.entryId === supervisor?.id,
    );
  if (!retained) return undefined;
  return retained.data.boardRef
    ? goalSourceRef(sourceNode(journal, retained.data.boardRef.entryId), "data")
    : null;
}
function selectedSourceNode(
  node: JournalNode,
  type: string,
  current: GoalCurrent | undefined,
): boolean {
  return (
    !(current && passiveOwnerView() && type === "continuous-tasks:snapshot") ||
    (isGoalCarrier(node.data) && scopeEqual(node.data, current.scope))
  );
}
function latestRef(
  journal: SessionJournal,
  type: string,
  current?: GoalCurrent,
): GoalSourceRef | null {
  const base =
    type === "continuous-tasks:preflight"
      ? current?.preflightBaseEntryId
      : current?.scope.lifecycleCommitId;
  const offset = base ? journal.branch.findIndex((n) => n.id === base) : -1;
  const types =
    type === "continuous-tasks:snapshot" && !current ? [type, "phased-tasks:snapshot"] : [type];
  const retained = retainedLegacyBoardRef(journal, type, current);
  if (retained !== undefined) return retained;
  const node = journal.branch
    .slice(offset + 1)
    .filter((n) => types.includes(n.customType ?? ""))
    .filter((n) => selectedSourceNode(n, type, current))
    .at(-1);
  if (node)
    return goalSourceRef(
      node,
      node.customType === "phased-tasks:snapshot" ? "legacy-board" : current ? "snapshot" : "data",
    );
  if (!current) return null;
  const id =
    type === "continuous-tasks:preflight"
      ? current.preflightBaseEntryId
      : current.scope.lifecycleCommitId;
  return goalSourceRef(
    sourceNode(journal, id),
    type === "continuous-tasks:preflight" ? "seed-preflight" : "seed-board",
  );
}
function sourceSnapshot(
  ctx: ExtensionContext,
  journal: SessionJournal,
  source: GoalSourceRef | null,
): unknown {
  return source ? resolveGoalSource(ctx, journal, source) : undefined;
}
function sourceSupervisor(
  journal: SessionJournal,
  board: GoalSourceRef | null,
  current?: GoalCurrent,
): { head: JournalNode; supervisor: GoalSourceRef | null } {
  if (current) {
    const head = sourceNode(journal, current.headEntryId);
    return { head, supervisor: current.supervisor ? goalSourceRef(head, "supervisor") : null };
  }
  const legacy = journal.branch
    .filter((n) => n.customType === GOAL_ENTRY && n.wireVersion !== 6)
    .at(-1);
  return {
    head:
      legacy ??
      (board ? sourceNode(journal, board.entryId) : failure("no historical owner exists")),
    supervisor: legacy ? goalSourceRef(legacy, "data") : null,
  };
}
function capturedSupervisor(
  ctx: ExtensionContext,
  journal: SessionJournal,
  ref: GoalSourceRef | null,
): unknown {
  if (!ref) return undefined;
  const value = sourceSnapshot(ctx, journal, ref);
  const decoded = decodeSupervisorEntry(value);
  const runtime = currentRuntime();
  if (
    decoded.ledger &&
    (!runtime.receiptStore ||
      journalDigest(runtime.receiptStore.checkpoint()) !== journalDigest(decoded.ledger))
  )
    failure("receipt view does not match its persisted checkpoint");
  if (decoded.v2 && (!runtime.receiptStore || runtime.receiptStore.format !== 2))
    failure("legacy receipt view is not loaded");
  const fields = (state: typeof decoded.state | undefined) =>
    state && [
      state.sessionId,
      state.goal,
      state.model,
      state.status,
      state.epoch,
      state.pending,
      state.reviews,
      state.continuations,
      state.stagnant,
      state.tokens,
      state.cost,
      state.bindings,
      state.preflightBinding,
      state.acceptedDigest,
      state.reason,
      state.holdCause,
      state.externalWait,
    ];
  if (journalDigest(fields(decoded.state)) !== journalDigest(fields(runtime.supervisor)))
    failure("Supervisor cache/source changed");
  return value;
}
function capturedPreflight(
  ctx: ExtensionContext,
  journal: SessionJournal,
  ref: GoalSourceRef | null,
): unknown {
  const value = sourceSnapshot(ctx, journal, ref);
  const cached = currentRuntime().preflight;
  if (!ref) {
    if (cached) failure("preflight cache has no native source");
    return undefined;
  }
  if (!cached) failure("preflight source is not loaded");
  const normalized = cached.phase === "interrupted" ? { ...cached, phase: "planning" } : cached;
  if (
    journalDigest(value) !== journalDigest(cached) &&
    journalDigest(value) !== journalDigest(normalized)
  )
    failure("preflight cache/source changed");
  return value;
}
function passiveTaskRecord(journal: SessionJournal) {
  const mode = currentRuntime().management?.record;
  if (
    !mode ||
    mode.data.mode !== "tasks" ||
    mode.data.activeWorkOwner?.kind !== "board" ||
    !mode.data.boardRef
  )
    return undefined;
  const node = journal.nodes.get(mode.entryId);
  return node?.digest === mode.digest && journalDigest(node.data) === journalDigest(mode.data)
    ? mode
    : undefined;
}
function confirmedRetainedBoard(journal: SessionJournal, archived: GoalSourceRef | null): boolean {
  const retained = [...(currentRuntime().controlJournal?.modeRecords ?? [])]
    .reverse()
    .find(
      (record) =>
        record.data.originOwner?.kind === "goal" &&
        (archived
          ? record.data.boardRef?.entryId === archived.entryId &&
            record.data.boardRef.digest === archived.entryDigest
          : record.data.mode === "off" && record.data.boardRef === null),
    );
  if (!retained) return false;
  const node = journal.nodes.get(retained.entryId);
  return (
    node?.digest === retained.digest && journalDigest(node.data) === journalDigest(retained.data)
  );
}
function passiveBoardCacheMatches(
  journal: SessionJournal,
  archived: GoalSourceRef | null,
): boolean {
  const mode = passiveTaskRecord(journal);
  if (!mode || !confirmedRetainedBoard(journal, archived)) return false;
  const index = journal.branch.findIndex((node) => node.id === mode.data.boardRef?.entryId);
  if (index < 0) return false;
  const snapshot = journal.branch
    .slice(index)
    .filter((node) => node.customType === "continuous-tasks:snapshot" && !isGoalCarrier(node.data))
    .at(-1);
  const active = snapshot && executionOwnerSnapshot(snapshot.data, mode.data.activeWorkOwner);
  return !!active && journalDigest(active) === journalDigest(getBoardRef());
}
function captureSource(
  ctx: ExtensionContext,
  journal: SessionJournal,
  view: GoalRuntime | undefined,
): GoalSource {
  const current = view?.current;
  const board = latestRef(journal, "continuous-tasks:snapshot", current);
  const actualBoard = board ? sourceSnapshot(ctx, journal, board) : createEmptyBoard();
  if (
    (board && board.selector !== "legacy-board" && !isValidSnapshotV2(actualBoard)) ||
    (journalDigest(actualBoard) !== journalDigest(getBoardRef()) &&
      !passiveBoardCacheMatches(journal, board))
  )
    failure("board/cache identity changed");
  const preflight = latestRef(journal, "continuous-tasks:preflight", current);
  const { head, supervisor } = sourceSupervisor(journal, board, current);
  const supValue = capturedSupervisor(ctx, journal, supervisor);
  const preflightValue = capturedPreflight(ctx, journal, preflight);
  return {
    sessionId: journal.sessionId,
    goalKey: current?.scope.goalRunId ?? legacyGoalKey(supervisor, supValue, board),
    scope: current?.scope ?? null,
    head: goalSourceRef(head, "data"),
    board,
    preflight,
    supervisor,
    boardDigest: journalDigest(actualBoard),
    preflightDigest: preflight ? journalDigest(preflightValue) : null,
    supervisorDigest: supervisor ? journalDigest(supValue) : null,
  };
}

function legacyGoalKey(
  supervisor: GoalSourceRef | null,
  value: unknown,
  board: GoalSourceRef | null,
): string {
  if (!supervisor)
    return board ? `legacy-board:${board.entryId}` : failure("no legacy board owner exists");
  const decoded = decodeSupervisorEntry(value);
  return decoded.ledger?.goalId ?? `legacy-checkpoint:${supervisor.entryId}`;
}
function terminalIssue(ctx: ExtensionContext, view: GoalRuntime | undefined): string | undefined {
  const runtime = currentRuntime();
  const state = runtime.supervisor;
  const board = getBoardRef();
  if (board.decision || board.workflowStatus === "waiting_for_decision")
    return "Resolve the real board decision before changing goals";
  if (board.workflowStatus === "active") return "Stop the active board before changing goals";
  if (
    state &&
    (!["stopped", "completed"].includes(state.status) ||
      state.sessionId !== ctx.sessionManager.getSessionId() ||
      state.pending)
  )
    return "Explicitly stop the current goal before changing goals";
  if (view?.current && !["stopped", "completed"].includes(view.current.phase))
    return "Explicitly end the current GoalRun before changing goals";
  const executionIssue = executionActivityIssue(ctx.sessionManager.getSessionId());
  if (executionIssue) return executionIssue;
  if (board.tasks.some((t) => t.executionRef) || state?.externalWait)
    return "Inspect and close the existing external execution references; no automatic relaunch";
  return preflightTransitionIssue(ctx, view);
}
function closedDraft(view: GoalRuntime | undefined, state: PreflightState): boolean {
  const current = view?.current;
  return (
    current?.phase === "stopped" &&
    current.disposition === "closed-unstarted" &&
    current.supervisor === null &&
    state.preflightId === current.planning.preflightId &&
    !state.started
  );
}
function preflightTransitionIssue(
  ctx: ExtensionContext,
  view: GoalRuntime | undefined,
): string | undefined {
  const state = currentRuntime().preflight;
  if (!state) return undefined;
  const requestIssue = currentPreflightRequestIssue(ctx, state);
  if (requestIssue) return requestIssue;
  if (closedDraft(view, state)) return unstartedPreflightStopIssue(ctx, state);
  if (!["started", "revoked"].includes(state.phase))
    return "The current preflight still has unfinished planning/authorization/start work";
  const binding = currentRuntime().supervisor?.preflightBinding;
  return binding?.preflightId === state.preflightId
    ? undefined
    : "The retained preflight does not belong to the stopped goal";
}

function commonIssue(ctx: ExtensionContext, ownQuestion = false): string | undefined {
  const runtime = currentRuntime();
  if (runtime.journalFault) return runtime.journalFault;
  if (runtime.boardRepair || runtime.preflightRepair)
    return "Repair the exact retained owner projection before changing goals";
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    return "Wait for Main and pending messages before changing goals";
  if (!ownQuestion && hasActiveNativeQuestion(ctx))
    return "Complete the existing native question before changing goals";
  if (runtime.receiptStore && (!runtime.receiptStore.healthy || runtime.receiptStore.pendingCount))
    return "Receipt history is unhealthy or has unknown host captures; inspect it before changing goals";
  return undefined;
}
function freshCandidate(view: GoalRuntime | undefined): boolean {
  const board = getBoardRef();
  return (
    !view?.current &&
    !currentRuntime().supervisor &&
    !board.tasks.length &&
    board.workflowStatus === "inactive" &&
    !board.decision
  );
}
function inspectWithJournal(
  ctx: ExtensionContext,
  request: GoalTransitionRequest,
  journal: SessionJournal,
  ownQuestion = false,
): GoalTransitionView {
  const goal = normalize(request.goal);
  const view = readGoalJournal(ctx, journal);
  if (view?.pending)
    return {
      status: "pending",
      goal,
      reason: "Existing goal transition requires exact readback/repair",
    };
  if (
    view?.current &&
    view.current.seed.goal === goal &&
    !["stopped", "completed"].includes(view.current.phase)
  )
    return { status: "same-current", goal };
  if (freshCandidate(view)) return { status: "fresh", goal };
  const issue = commonIssue(ctx, ownQuestion) ?? terminalIssue(ctx, view);
  if (issue) return { status: "blocked", goal, reason: issue };
  return { status: "eligible", goal, source: captureSource(ctx, journal, view) };
}
export function inspectGoalTransition(
  ctx: ExtensionContext,
  request: GoalTransitionRequest,
): GoalTransitionView {
  const goal = normalize(request.goal);
  if (!isSafeBoundedText(goal, 4000) || !ctx.model)
    return {
      status: "blocked",
      goal,
      reason: "A bounded non-secret goal and active model are required",
    };
  try {
    return inspectWithJournal(ctx, request, inspectSessionJournal(sessionJournalView(ctx)));
  } catch (error) {
    return {
      status: "blocked",
      goal,
      reason: error instanceof Error ? error.message : "Goal transition inspection failed",
    };
  }
}
function newSeed(ctx: ExtensionContext, goal: string, previousGeneration: number): GoalSeed {
  const preflightId = `pf-${randomUUID()}`;
  const model = ctx.model;
  if (!model) return failure("active model is unavailable");
  const board = createEmptyBoard();
  board.generation = previousGeneration + 1;
  return {
    goalRunId: `rg-${randomUUID()}`,
    goal,
    model: { provider: model.provider, id: model.id },
    board,
    preflight: {
      version: 2,
      sessionId: ctx.sessionManager.getSessionId(),
      preflightId,
      goal,
      phase: "planning",
      revision: 0,
      approvalFlow: "consolidated-v1",
    },
    planning: { attemptNo: 0, attemptId: randomUUID(), preflightId, status: "prepared" },
  };
}
function installGoalView(view: GoalRuntime): void {
  const runtime = currentRuntime();
  invalidateGoalCallbacks();
  runtime.goal = structuredClone(view);
  const current = view.current;
  if (!current) return;
  runtime.board = structuredClone(current.board);
  runtime.preflight = structuredClone(current.preflightSeed);
  runtime.supervisor = undefined;
  runtime.receiptStore = undefined;
  runtime.receiptIdentity = undefined;
  runtime.receiptPersistence = undefined;
  runtime.boardHumanContext = undefined;
  runtime.boardRepair = undefined;
  runtime.preflightRepair = undefined;
}
function makeCommit(
  control: GoalControl,
  controlNode: JournalNode,
  witness: JournalNode,
): GoalCommit {
  return {
    version: 5,
    protocol: GOAL_PROTOCOL,
    kind: "transition-committed",
    sessionId: control.sessionId,
    transitionId: control.transitionId,
    controlEntryId: controlNode.id,
    controlDigest: controlNode.digest,
    witnessEntryId: witness.id,
    witnessDigest: witness.digest,
    from: structuredClone(control.from),
    seed: structuredClone(control.seed),
  };
}
function commitPending(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  view: GoalRuntime,
  restore?: GoalRestoreOptions,
): GoalRuntime {
  const pending = view.pending;
  if (!pending?.confirmed) return view;
  let committed: string;
  try {
    const journal = inspectSessionJournal(sessionJournalView(ctx));
    const proof = findGoalReadbackProof(journal, pending.control.transitionId);
    if (proof.status !== "confirmed" || proof.control.id !== pending.controlEntryId)
      return failure("transition proof changed before commit");
    committed = appendObservedGoalCheckpoint(
      pi,
      ctx,
      makeCommit(pending.control, proof.control, proof.witness),
    );
    if (!restore) return readGoalJournal(ctx) ?? failure("committed goal selection disappeared");
  } catch (error) {
    view.blocked = error instanceof Error ? error.message : "Goal transition commit uncertain";
    return view;
  }
  // A failed lease refresh must reach the orchestrator, not install an uncertain old view.
  restore.afterConfirmedAppend(committed);
  return (
    readGoalJournal(ctx, restore.read.inspect(ctx)) ??
    failure("committed goal selection disappeared")
  );
}
function transitionHold(ctx: ExtensionContext, reason: string): void {
  const runtime = currentRuntime();
  runtime.cancel();
  runtime.goal ??= { sessionId: ctx.sessionManager.getSessionId(), archives: [] };
  runtime.goal.blocked = reason;
}
export function restoreGoalLifecycle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  restore?: GoalRestoreOptions,
): GoalRuntime | undefined {
  const view = readGoalJournal(ctx, restore?.read.inspect(ctx));
  if (!view) {
    currentRuntime().goal = undefined;
    return undefined;
  }
  const selectedView = commitPending(pi, ctx, view, restore);
  if (restore)
    restore.install(() => {
      installGoalView(selectedView);
    });
  else installGoalView(selectedView);
  const selected = currentRuntime().goal?.current;
  const preflight = currentRuntime().preflight;
  if (selected?.supervisor === null && selected.phase === "planning") {
    selected.phase = "planning-interrupted";
    if (preflight?.phase === "planning") preflight.phase = "interrupted";
  }
  return structuredClone(currentRuntime().goal);
}
interface TransitionChoice {
  source: GoalSource;
  seed: GoalSeed;
  supersedes?: GoalControl["supersedes"];
}
function pendingChoice(
  ctx: ExtensionContext,
  request: GoalTransitionRequest,
  ownQuestion = false,
): TransitionChoice {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const view = readGoalJournal(ctx, journal);
  const pending = view?.pending;
  if (!pending || pending.confirmed)
    return failure("transition needs projection repair, not another native answer");
  const { from, seed } = pending.control;
  if (
    normalize(request.goal) !== seed.goal ||
    journalDigest(ctx.model && { provider: ctx.model.provider, id: ctx.model.id }) !==
      journalDigest(seed.model)
  )
    return failure("pending transition has a different exact goal/model");
  const issue = commonIssue(ctx, ownQuestion) ?? terminalIssue(ctx, view);
  if (issue) return failure(issue);
  const board = sourceBoard(ctx, journal, from);
  if (journalDigest(board) !== journalDigest(getBoardRef()))
    return failure("pending transition board changed");
  capturedSupervisor(ctx, journal, from.supervisor);
  capturedPreflight(ctx, journal, from.preflight);
  const previous = sourceNode(journal, pending.controlEntryId);
  return {
    source: from,
    seed,
    supersedes: {
      entryId: previous.id,
      entryDigest: previous.digest,
      requestId: pending.control.transitionId,
    },
  };
}
function transitionChoice(ctx: ExtensionContext, request: GoalTransitionRequest): TransitionChoice {
  const inspected = inspectGoalTransition(ctx, request);
  if (inspected.status === "pending") return pendingChoice(ctx, request);
  if (inspected.status !== "eligible" || !inspected.source)
    return failure(inspected.reason ?? "No terminal goal is ready for this transition");
  const archived = sourceBoard(
    ctx,
    inspectSessionJournal(sessionJournalView(ctx)),
    inspected.source,
  );
  return { source: inspected.source, seed: newSeed(ctx, inspected.goal, archived.generation) };
}
function choiceIsCurrent(
  ctx: ExtensionContext,
  request: GoalTransitionRequest,
  choice: TransitionChoice,
): boolean {
  try {
    if (choice.supersedes) {
      const pending = pendingChoice(ctx, request, true);
      return journalDigest(pending) === journalDigest(choice);
    }
    const next = inspectWithJournal(
      ctx,
      request,
      inspectSessionJournal(sessionJournalView(ctx)),
      true,
    );
    return (
      next.status === "eligible" &&
      journalDigest(next.source) === journalDigest(choice.source) &&
      journalDigest(ctx.model && { provider: ctx.model.provider, id: ctx.model.id }) ===
        journalDigest(choice.seed.model)
    );
  } catch {
    return false;
  }
}
function archiveQuestion(
  choice: TransitionChoice,
  frame: ReturnType<typeof captureGoalReadbackFrame>,
  ctx: ExtensionContext,
) {
  const runtime = currentRuntime();
  const board = sourceBoard(ctx, inspectSessionJournal(sessionJournalView(ctx)), choice.source);
  const oldGoal =
    runtime.goal?.current?.seed.goal ?? runtime.supervisor?.goal ?? "未记录监督目标（仅历史看板）";
  const counts = {
    total: board.tasks.length,
    done: board.tasks.filter((t) => t.status === "done").length,
    abandoned: board.tasks.filter((t) => t.status === "abandoned").length,
    unfinished: board.tasks.filter((t) => !["done", "abandoned"].includes(t.status)).length,
  };
  const state = runtime.supervisor;
  const usage = state
    ? {
        reviews: state.reviews,
        continuations: state.continuations,
        stagnant: state.stagnant,
        tokens: state.tokens,
        cost: state.cost,
      }
    : "未启动监督，无已记录的 Supervisor 用量";
  const body = `旧目标原值：\n${oldGoal}\n旧目标身份：${choice.source.goalKey}\n旧状态：${state?.status ?? runtime.goal?.current?.phase ?? board.workflowStatus}\n旧任务计数：${JSON.stringify(counts)}；未完成记录原样归档。\n旧用量原样保留：${JSON.stringify(usage)}\n新目标原值：\n${choice.seed.goal}\n新目标模型：${choice.seed.model.provider}/${choice.seed.model.id}\n\n新目标独立记账，从零开始 reviews/continuations/stagnant，重新规划、授权、启动；这不是重置旧目标额度。本次不批准业务，不启动旧任务，不取消外部进程。`;
  return {
    frame,
    kind: "choice" as const,
    purpose: "business-choice" as const,
    title: "归档旧目标并规划新目标",
    body,
    material: {
      context: choice.seed.goal,
      summary: ["只归档并只读规划；不授予业务权限、不启动旧任务。", `新目标：${choice.seed.goal}`],
      sections: [{ title: "旧目标与新目标", markdown: body }],
    },
    options: ["Archive and plan new goal", "Cancel"],
    displayOptions: ["归档旧目标并规划新目标", "取消（不提交）"],
  };
}

export async function requestGoalTransition(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  request: GoalTransitionRequest,
  signal?: AbortSignal,
): Promise<GoalTransitionResult> {
  if (!isTrustedLocalTui(ctx))
    return {
      status: "blocked",
      reason: "A trusted local native TUI is required to archive and prepare a goal",
    };
  let choice: TransitionChoice;
  try {
    choice = transitionChoice(ctx, request);
  } catch (error) {
    return {
      status: "blocked",
      reason: error instanceof Error ? error.message : "Goal transition blocked",
    };
  }
  const { source, seed } = choice;
  const transitionId = randomUUID();
  const frame = captureGoalReadbackFrame(
    ctx,
    transitionId,
    goalTransitionScope(source, seed, transitionId),
    source.head.entryId,
  );
  const runtime = currentRuntime();
  const epoch = runtime.humanEpoch;
  const current = () =>
    runtime === currentRuntime() &&
    runtime.humanEpoch === epoch &&
    !signal?.aborted &&
    choiceIsCurrent(ctx, request, choice);
  const answer = await requestNativeAnswer(
    ctx,
    archiveQuestion(choice, frame, ctx),
    current,
    signal,
  );
  if (!answer) return { status: "deferred" };
  if (answer.value !== "Archive and plan new goal") return { status: "cancelled" };
  try {
    if (!current()) throw new Error("Goal transition source changed");
    ensureApprovalWorkflowFence(pi, ctx);
    const body: GoalControl = {
      version: 5,
      protocol: GOAL_PROTOCOL,
      kind: "transition-control",
      sessionId: source.sessionId,
      transitionId,
      from: source,
      seed,
      createdAt: new Date(answer.answeredAt).toISOString(),
      humanInteraction: frame,
      ...(choice.supersedes ? { supersedes: choice.supersedes } : {}),
    };
    const priorManagement = captureManagementSnapshot(ctx);
    const proof = publishGoalReadbackControl(pi, ctx, answer, frame, body);
    appendObservedGoalCheckpoint(pi, ctx, makeCommit(body, proof.control, proof.witness));
    const view = readGoalJournal(ctx) ?? failure("committed goal selection missing");
    const selected = view.current;
    if (!selected) return failure("committed current goal missing");
    installGoalView(view);
    // This path follows the actual native archive/planning answer, unlike raw
    // restoration, which must never reactivate a detached historical owner.
    adoptSupervisedMode(pi, ctx, priorManagement);
    return { status: "committed-planning", planning: goalPlanningRef(selected) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Goal transition persistence uncertain";
    transitionHold(ctx, reason);
    return { status: "projection-pending", reason };
  }
}

export { readGoalHistory } from "./goal-history";
export type { GoalHistorySummary, GoalHistoryItem, GoalHistoryPage } from "./goal-history";
