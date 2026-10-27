import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  captureArtifactVersion,
  captureWorkspaceArtifactVersion,
  type ArtifactVersionV1,
} from "./artifact-version";
import {
  appendControlFact,
  appendControlFence,
  captureControlLease,
  currentWorkOwner,
  readControlJournal,
  progressOwnerKey,
  progressKey,
  creditedProgress,
  progressVersionSeen,
  taskGraphDigest,
  type WorkOwnerKey,
  type ProgressDefinition,
  type ProgressObserved,
  type ProgressFactView,
  type BatchAdviceObserved,
} from "./control-journal";
import { currentRuntime, type TaskRuntime } from "./runtime";
import { captureManagementSnapshot, decideAdmission } from "./management-policy";
import { goalLease } from "./goal-scope";
import { getBoardRef } from "./state";
import { ownerBoardSnapshot } from "./execution-settlement";
import { inspectRestorableSession } from "./human-control";
import { journalDigest, type SessionJournal } from "./human-journal";
import { redactedJSON, type HostReceipt } from "./receipt-store";
import type { TaskBoardSnapshot, TaskRecord } from "./types";
import type { ReviewVersionV1 } from "./final-review";
export { progressKey, taskGraphDigest } from "./control-journal";

export interface ProgressRuntime {
  captures: Map<string, PendingProgress[]>;
  pending: PendingProgress[];
  limited: boolean;
  volatileAdvice: Array<{
    owner: string;
    graph: string;
    authority: string;
    advice: BatchAdviceObserved["advice"];
    valid: boolean;
  }>;
}
interface PendingProgress {
  runtime: TaskRuntime;
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  file: string;
  lease: string;
  humanEpoch: number;
  modeRef?: string;
  registration: ProgressFactView & { data: ProgressDefinition };
  taskDigest: string;
  callId: string;
  inputDigest: string;
  before: ReviewVersionV1;
  after?: ReviewVersionV1;
  absent: boolean;
  result?: ProgressObserved["result"];
  receipt?: HostReceipt;
}
function runtimeProgress(): ProgressRuntime {
  return (currentRuntime().progress ??= {
    captures: new Map(),
    pending: [],
    limited: false,
    volatileAdvice: [],
  });
}
function compact(version: ArtifactVersionV1): ReviewVersionV1 {
  const { inputs, artifacts, ...rest } = version;
  return { ...rest, inputCount: inputs.length, artifactCount: artifacts.length };
}
function ownerFacts(owner: WorkOwnerKey): ProgressFactView[] {
  return (currentRuntime().controlJournal?.progressFacts ?? []).filter(
    (r) => progressOwnerKey(r.data.owner) === progressOwnerKey(owner),
  );
}
function capture(
  ctx: ExtensionContext,
  definition: ProgressDefinition,
): ReviewVersionV1 | undefined {
  const result =
    definition.policy === "git-visible-workspace-v1"
      ? captureWorkspaceArtifactVersion(
          definition.root,
          definition.owner,
          ctx.sessionManager.getSessionFile(),
        )
      : captureArtifactVersion(
          {
            scopeId: `progress:${definition.definitionId}`,
            owner: definition.owner,
            root: definition.root,
            inputs: definition.inputs,
            artifacts: definition.artifacts,
            environmentKeys: [],
          },
          {},
        );
  return result.status === "known" ? compact(result.version) : undefined;
}
function absentArtifact(root: string, artifacts: readonly string[]): boolean {
  const target = artifacts[0];
  if (artifacts.length !== 1 || !target || !/^[^/\\.][^/\\]*$/u.test(target)) return false;
  try {
    lstatSync(join(root, target));
    return false;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  }
}
function appendProgress(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: ProgressDefinition | ProgressObserved | BatchAdviceObserved,
): ProgressFactView {
  let view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("progress-facts-v1"))
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "progress-facts-v1" as const])],
      captureControlLease(ctx),
    );
  const saved = appendControlFact(pi, ctx, data);
  view = readControlJournal(ctx);
  currentRuntime().controlJournal = view;
  return { entryId: saved.entryId, digest: saved.digest, data };
}
export interface ProgressMilestone {
  id: string;
  taskId: string;
  milestone: ProgressDefinition["milestone"];
  policy?: ProgressDefinition["policy"];
  inputs?: string[];
  artifact?: string;
  check?: { tool: string; input: Record<string, unknown> };
}
function progressCaptureOwner(ctx: ExtensionContext): WorkOwnerKey | undefined {
  if (!ctx.sessionManager.getSessionFile()) return undefined;
  const mode = captureManagementSnapshot(ctx),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  return owner &&
    mode.state === "active" &&
    mode.mode !== "off" &&
    !mode.identityIssue &&
    !mode.journalFault &&
    !mode.controlPending
    ? owner
    : undefined;
}
function progressCheck(check: ProgressMilestone["check"]): ProgressDefinition["check"] {
  if (!check) return null;
  const raw = redactedJSON(check.input);
  if (raw.length > 2000 || raw !== JSON.stringify(check.input))
    throw Error("Progress check input must be fully retained and nonsecret");
  return { tool: check.tool, inputDigest: journalDigest(raw) };
}
function buildProgressDefinition(
  ctx: ExtensionContext,
  milestone: ProgressMilestone,
  owner: WorkOwnerKey,
  task: TaskRecord,
): ProgressDefinition | undefined {
  const policy = milestone.policy ?? "declared-v1",
    artifacts = milestone.artifact ? [milestone.artifact] : [],
    inputs = milestone.inputs ?? [];
  const absent = milestone.milestone === "artifact" && absentArtifact(ctx.cwd, artifacts),
    check = progressCheck(milestone.check);
  const result =
    policy === "git-visible-workspace-v1"
      ? captureWorkspaceArtifactVersion(ctx.cwd, owner, ctx.sessionManager.getSessionFile())
      : captureArtifactVersion(
          {
            scopeId: `progress:${milestone.id}`,
            owner,
            root: ctx.cwd,
            inputs,
            artifacts: absent ? [] : artifacts,
            environmentKeys: [],
          },
          {},
        );
  if (result.status !== "known") return undefined;
  return {
    version: 1,
    kind: "progress-definition",
    recordId: randomUUID(),
    owner,
    definitionId: milestone.id,
    taskId: task.id,
    taskDigest: journalDigest(task),
    milestone: milestone.milestone,
    policy,
    root: ctx.cwd,
    inputs,
    artifacts,
    baseline: compact(result.version),
    absent,
    check,
    boardRef: ownerBoardSnapshot(ctx, owner, getBoardRef()),
  };
}
function assertSameMilestone(
  definition: ProgressDefinition,
  milestone: ProgressMilestone,
  root: string,
): void {
  const expected = [
    definition.taskId,
    definition.milestone,
    definition.policy,
    definition.root,
    definition.inputs,
    definition.artifacts,
    definition.check,
  ];
  const supplied = [
    milestone.taskId,
    milestone.milestone,
    milestone.policy ?? "declared-v1",
    root,
    milestone.inputs ?? [],
    milestone.artifact ? [milestone.artifact] : [],
    progressCheck(milestone.check),
  ];
  if (journalDigest(expected) !== journalDigest(supplied))
    throw Error(
      "Progress definition conflict; register a distinct trusted milestone, never replace history",
    );
}
/** Trusted host registration seam, deliberately not an agent tool or Main text parser. */
export function registerProgressMilestone(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  milestone: ProgressMilestone,
): (ProgressFactView & { data: ProgressDefinition }) | undefined {
  const owner = progressCaptureOwner(ctx);
  if (!owner) return undefined;
  // SDK 1.1.0's task-only native message lacks durable structured exit; do not pretend to qualify checks.
  if (owner.kind === "board" && milestone.milestone === "check") return undefined;
  const task =
    getBoardRef().workflowStatus === "active"
      ? getBoardRef().tasks.find((t) => t.id === milestone.taskId && t.status === "implementing")
      : undefined;
  if (!task || !/^[A-Za-z0-9_.:-]{1,100}$/.test(milestone.id))
    throw Error("Progress definition needs a bounded host ID and actual implementing task");
  currentRuntime().controlJournal = readControlJournal(ctx);
  const own = ownerFacts(owner),
    previous = own.find(
      (r) => r.data.kind === "progress-definition" && r.data.definitionId === milestone.id,
    );
  if (previous?.data.kind === "progress-definition") {
    assertSameMilestone(previous.data, milestone, ctx.cwd);
    return previous as ProgressFactView & { data: ProgressDefinition };
  }
  if (own.filter((r) => r.data.kind === "progress-definition").length >= 100) {
    runtimeProgress().limited = true;
    return undefined;
  }
  const data = buildProgressDefinition(ctx, milestone, owner, task);
  return data
    ? (appendProgress(pi, ctx, data) as ProgressFactView & { data: ProgressDefinition })
    : undefined;
}
function currentTask(): TaskRecord | undefined {
  if (getBoardRef().workflowStatus !== "active") return undefined;
  const claimed = getBoardRef().tasks.filter((t) =>
    ["implementing", "reviewing"].includes(t.status),
  );
  return claimed.length === 1 && claimed[0]?.status === "implementing" ? claimed[0] : undefined;
}
function progressCandidate(
  ctx: ExtensionContext,
  event: ToolCallEvent,
  registration: ProgressFactView & { data: ProgressDefinition },
  task: TaskRecord,
  readOnly: boolean,
): PendingProgress | undefined {
  const check = registration.data.check,
    file = ctx.sessionManager.getSessionFile();
  if (!file || (readOnly && !check)) return undefined;
  if (
    check &&
    (check.tool !== event.toolName ||
      check.inputDigest !== journalDigest(JSON.stringify(event.input)))
  )
    return undefined;
  const absent =
    registration.data.milestone === "artifact" &&
    absentArtifact(ctx.cwd, registration.data.artifacts);
  const before =
    capture(ctx, registration.data) ?? (absent ? registration.data.baseline : undefined);
  if (!before) return undefined;
  return {
    runtime: currentRuntime(),
    manager: ctx.sessionManager,
    sessionId: ctx.sessionManager.getSessionId(),
    file,
    lease: goalLease(),
    humanEpoch: currentRuntime().humanEpoch,
    modeRef: currentRuntime().management?.record?.entryId,
    registration,
    taskDigest: journalDigest(task),
    callId: event.toolCallId,
    inputDigest: journalDigest(JSON.stringify(event.input)),
    before,
    absent,
  };
}
export function beginProgressCapture(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolCallEvent,
  readOnly: boolean,
): void {
  const task = currentTask(),
    owner = progressCaptureOwner(ctx);
  if (!task || !owner) return;
  const state = runtimeProgress();
  const load = [...state.captures.values()].reduce(
    (n, frames) => n + frames.length,
    state.pending.length,
  );
  if (load >= 128) {
    state.limited = true;
    return;
  }
  if (!readOnly)
    registerProgressMilestone(pi, ctx, {
      id: `input-difference:${task.id}`,
      taskId: task.id,
      milestone: "input_difference",
      policy: "git-visible-workspace-v1",
    });
  const definitions = ownerFacts(owner).filter(
    (r): r is ProgressFactView & { data: ProgressDefinition } =>
      r.data.kind === "progress-definition" &&
      r.data.taskId === task.id &&
      r.data.taskDigest === journalDigest(task),
  );
  const pending = definitions.flatMap((registration) => {
    const candidate = progressCandidate(ctx, event, registration, task, readOnly);
    return candidate ? [candidate] : [];
  });
  if (load + pending.length > 128) {
    state.limited = true;
    return;
  }
  if (pending.length) state.captures.set(event.toolCallId, pending);
}
export function discardUnstartedProgress(toolCallId: string): void {
  currentRuntime().progress?.captures.delete(toolCallId);
}
function pendingCurrent(ctx: ExtensionContext, pending: PendingProgress): boolean {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  return (
    currentRuntime() === pending.runtime &&
    ctx.sessionManager === pending.manager &&
    ctx.sessionManager.getSessionId() === pending.sessionId &&
    ctx.sessionManager.getSessionFile() === pending.file &&
    goalLease() === pending.lease &&
    currentRuntime().humanEpoch === pending.humanEpoch &&
    currentRuntime().management?.record?.entryId === pending.modeRef &&
    !!owner &&
    progressOwnerKey(owner) === progressOwnerKey(pending.registration.data.owner) &&
    currentTask()?.id === pending.registration.data.taskId &&
    journalDigest(currentTask()) === pending.taskDigest
  );
}
function effectSucceeded(event: ToolResultEvent): boolean {
  if (event.isError) return false;
  const structured = event.structuredContent;
  return (
    !structured ||
    typeof structured !== "object" ||
    !("exit_code" in structured) ||
    structured.exit_code === 0
  );
}
function normalizedProgressResult(
  pending: PendingProgress,
  event: ToolResultEvent,
  after: ReviewVersionV1,
): ProgressObserved["result"] | undefined {
  const definition = pending.registration.data;
  if (definition.milestone === "check") return normalizedCheckResult(event);
  if (!effectSucceeded(event)) return undefined;
  if (definition.milestone === "artifact" && pending.absent) return "formed";
  if (definition.milestone === "input_difference" && after.versionId !== pending.before.versionId)
    return "changed";
  return undefined;
}
function normalizedCheckResult(event: ToolResultEvent): ProgressObserved["result"] | undefined {
  const structured = event.structuredContent;
  const exit =
    structured && typeof structured === "object" && "exit_code" in structured
      ? structured.exit_code
      : undefined;
  if (!event.isError && exit === 0) return "success";
  if (event.isError || (typeof exit === "number" && Number.isInteger(exit) && exit !== 0))
    return "failure";
  return undefined;
}
export function observeProgressFact(
  ctx: ExtensionContext,
  event: ToolResultEvent,
  receipt?: HostReceipt,
): void {
  const state = runtimeProgress(),
    pending = state.captures.get(event.toolCallId) ?? [];
  state.captures.delete(event.toolCallId);
  for (const captureState of pending) {
    if (!pendingCurrent(ctx, captureState) || receipt?.eligible === false) continue;
    const after = capture(ctx, captureState.registration.data);
    if (!after) continue;
    const result = normalizedProgressResult(captureState, event, after);
    if (result) state.pending.push({ ...captureState, after, result, receipt });
  }
}
function sameCheckState(own: readonly ProgressFactView[], data: ProgressObserved): boolean {
  const previous = [...own]
    .reverse()
    .find((r) => r.data.kind === "progress-observed" && r.data.definitionId === data.definitionId);
  return previous?.data.kind === "progress-observed" && previous.data.result === data.result;
}
function duplicateProgress(
  own: readonly ProgressFactView[],
  data: ProgressObserved,
  definition: ProgressDefinition,
): boolean {
  if (
    own.some(
      (r) => r.data.kind === "progress-observed" && progressKey(r.data) === progressKey(data),
    ) &&
    (definition.milestone !== "check" || sameCheckState(own, data))
  )
    return true;
  if (data.result === "changed")
    return (
      data.artifactVersion.scopeDigest !== definition.baseline.scopeDigest ||
      progressVersionSeen(own, data.artifactVersion.versionId)
    );
  return (
    data.result === "formed" &&
    own.some(
      (r) => r.data.kind === "progress-observed" && r.data.definitionId === data.definitionId,
    )
  );
}
function flushProgressItem(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  item: PendingProgress,
  journal: SessionJournal,
): void {
  const result = item.result;
  if (!pendingCurrent(ctx, item) || !result || !item.after) return;
  const now = capture(ctx, item.registration.data);
  if (!now || now.versionId !== item.after.versionId) return;
  const owner = item.registration.data.owner,
    own = ownerFacts(owner);
  if (
    own.filter((r) => r.data.kind === "progress-observed").length >= 256 ||
    creditedProgress(own).length >= 128
  ) {
    runtimeProgress().limited = true;
    return;
  }
  const source = journal.branch.find((node) =>
    item.receipt
      ? node.receiptProof?.receipt?.id === item.receipt.id
      : node.toolResultProof?.id === item.callId,
  );
  if (!source) return;
  const data: ProgressObserved = {
    version: 1,
    kind: "progress-observed",
    recordId: randomUUID(),
    owner,
    definitionRef: { entryId: item.registration.entryId, digest: item.registration.digest },
    definitionId: item.registration.data.definitionId,
    taskId: item.registration.data.taskId,
    sourceKind: item.receipt ? "receipt" : "native-result",
    sourceRef: { entryId: source.id, digest: source.digest },
    receiptId: item.receipt?.id ?? `tool:${item.callId}`,
    receiptDigest: item.receipt?.digest ?? source.digest,
    result,
    artifactVersion: now,
  };
  if (!duplicateProgress(own, data, item.registration.data)) appendProgress(pi, ctx, data);
}
export function flushProgressFactsAtBoundary(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = runtimeProgress();
  if (
    !state.pending.length ||
    state.captures.size ||
    currentRuntime().receiptStore?.pendingCount ||
    currentRuntime().journalFault
  )
    return;
  const mode = captureManagementSnapshot(ctx);
  if (decideAdmission(mode, { kind: "boundary" }).verdict === "deny") return;
  currentRuntime().controlJournal = readControlJournal(ctx);
  if (currentRuntime().controlJournal?.pendingHostCaptures?.length) return;
  const journal = inspectRestorableSession(ctx);
  if (!journal) return;
  const pending = state.pending.splice(0);
  for (const item of pending) flushProgressItem(pi, ctx, item, journal);
}
export function progressSince(checkpoint: { owner: WorkOwnerKey; position?: number }): {
  facts: ProgressFactView[];
  keys: string[];
  limited: boolean;
} {
  const own = ownerFacts(checkpoint.owner),
    credited = creditedProgress(own);
  return {
    facts: credited.slice(checkpoint.position ?? 0),
    keys: credited.map((r) => progressKey(r.data as ProgressObserved)),
    limited: currentRuntime().progress?.limited ?? false,
  };
}
export function progressSummary(owner: WorkOwnerKey) {
  const own = ownerFacts(owner),
    projection = progressSince({ owner });
  return {
    credited: projection.keys.length,
    definitions: own.filter((r) => r.data.kind === "progress-definition").length,
    limited: projection.limited,
    recent: projection.facts.slice(-8).flatMap((r) =>
      r.data.kind === "progress-observed"
        ? [
            {
              taskId: r.data.taskId,
              milestoneId: r.data.definitionId,
              result: r.data.result,
              key: progressKey(r.data),
              source: r.data.sourceRef,
              versionId: r.data.artifactVersion.versionId,
            },
          ]
        : [],
    ),
  };
}
function cachedLegacyProgressOwner(owner: WorkOwnerKey): boolean {
  const runtime = currentRuntime();
  if (owner.kind === "goal")
    return (
      owner.goal.sessionId === runtime.supervisor?.sessionId &&
      owner.goal.goalKey === runtime.receiptStore?.checkpoint().goalId
    );
  return (
    !!runtime.controlJournal?.boardOwner &&
    progressOwnerKey(owner) === progressOwnerKey(runtime.controlJournal.boardOwner)
  );
}
export function cachedProgressSummary(): ReturnType<typeof progressSummary> | undefined {
  const runtime = currentRuntime();
  if (runtime.management)
    return runtime.management.activeWorkOwner
      ? progressSummary(runtime.management.activeWorkOwner)
      : undefined;
  const owner = runtime.controlJournal?.progressFacts?.at(-1)?.data.owner;
  if (!owner) return undefined;
  return cachedLegacyProgressOwner(owner) ? progressSummary(owner) : undefined;
}
export function authorityDigest(state: {
  goal: string;
  model: unknown;
  preflightBinding?: unknown;
}): string {
  return journalDigest([
    "host-authority-v1",
    state.goal,
    state.model,
    state.preflightBinding ?? null,
  ]);
}
export interface HostContinuationSnapshot {
  mode: string;
  owner: WorkOwnerKey | null;
  active: boolean;
  held: boolean;
  authorized: boolean;
  pending: boolean;
  unknownExecution: boolean;
  budgetAvailable: boolean;
  reviewed: boolean;
  board: Readonly<TaskBoardSnapshot>;
}
export function decideHostContinuation(snapshot: HostContinuationSnapshot): {
  action: "next_batch" | "review_needed" | "held";
  taskIds: string[];
  factsDigest: string;
} {
  const taskIds = snapshot.board.tasks.filter((t) => t.status === "ready").map((t) => t.id);
  const factsDigest = journalDigest([
    "host-continuation-v1",
    snapshot.owner,
    taskGraphDigest(snapshot.board),
    snapshot.board.tasks.map((t) => [t.id, t.status]),
    snapshot.authorized,
    snapshot.reviewed,
    snapshot.mode,
    snapshot.active,
    snapshot.held,
    snapshot.pending,
    snapshot.unknownExecution,
    snapshot.budgetAvailable,
    snapshot.board.workflowStatus,
    snapshot.board.generation,
    snapshot.board.decision ?? null,
  ]);
  if (
    snapshot.mode !== "supervised" ||
    !snapshot.owner ||
    !snapshot.active ||
    snapshot.held ||
    !snapshot.authorized ||
    snapshot.pending ||
    snapshot.unknownExecution ||
    !snapshot.budgetAvailable ||
    snapshot.board.decision
  )
    return { action: "held", taskIds: [], factsDigest };
  if (
    snapshot.board.workflowStatus !== "active" ||
    snapshot.board.tasks.some((t) => ["implementing", "reviewing"].includes(t.status)) ||
    !taskIds.length ||
    !snapshot.reviewed
  )
    return { action: "review_needed", taskIds: [], factsDigest };
  return { action: "next_batch", taskIds, factsDigest };
}
export function reviewedPlan(
  owner: WorkOwnerKey,
  board: Readonly<TaskBoardSnapshot>,
  authority: string,
  allowVolatile = false,
): boolean {
  const graph = taskGraphDigest(board);
  const latest = ownerFacts(owner)
    .filter((r) => r.data.kind === "batch-advice-observed")
    .at(-1)?.data;
  if (latest?.kind === "batch-advice-observed")
    return (
      latest.valid &&
      latest.advice.action !== "hold" &&
      latest.graphDigest === graph &&
      latest.authorityDigest === authority
    );
  if (!allowVolatile) return false;
  const volatile = currentRuntime()
    .progress?.volatileAdvice.filter((r) => r.owner === progressOwnerKey(owner))
    .at(-1);
  return (
    !!volatile &&
    volatile.valid &&
    volatile.advice.action !== "hold" &&
    volatile.graph === graph &&
    volatile.authority === authority
  );
}
export function recordBatchAdvice(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  state: { goal: string; model: unknown; preflightBinding?: unknown },
  advice: BatchAdviceObserved["advice"],
  valid: boolean,
  callRef?: { entryId: string; digest: string },
): void {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!owner || Buffer.byteLength(JSON.stringify(advice)) > 8000)
    throw Error("Batch advice cannot be fully retained within the bounded native fact");
  if (!ctx.sessionManager.getSessionFile()) {
    const history = runtimeProgress().volatileAdvice;
    if (history.length >= 80)
      throw Error("Volatile advice retention limit reached; no action replay");
    history.push({
      owner: progressOwnerKey(owner),
      graph: taskGraphDigest(board),
      authority: authorityDigest(state),
      advice: structuredClone(advice),
      valid,
    });
    return;
  }
  if (!callRef) return;
  const journal = inspectRestorableSession(ctx);
  const supervisor =
    journal &&
    [...journal.branch]
      .reverse()
      .find(
        (n) =>
          n.supervisorProof?.status === "reviewing" &&
          n.supervisorProof.authorityDigest === authorityDigest(state),
      );
  if (!supervisor) throw Error("Actual reviewing supervisor source is missing");
  appendProgress(pi, ctx, {
    version: 1,
    kind: "batch-advice-observed",
    recordId: randomUUID(),
    owner,
    callRef,
    supervisorRef: { entryId: supervisor.id, digest: supervisor.digest },
    boardRef: ownerBoardSnapshot(ctx, owner, board),
    graphDigest: taskGraphDigest(board),
    authorityDigest: authorityDigest(state),
    valid,
    advice,
  });
}
