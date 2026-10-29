import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { captureWorkspaceArtifactVersion, type ArtifactVersionV1 } from "./artifact-version";
import { bindContractReview } from "./acceptance-runtime";
import {
  currentWorkOwner,
  appendControlFact,
  appendControlFence,
  captureControlLease,
  assertLease,
  readControlJournal,
  type FinalValidationFact,
  type ReviewAttemptEntry,
  type ReviewAttemptStartedFact,
  type ReviewAttemptObservedFact,
  type GoalOwnerKey,
  type FinalValidationRegistrationFact,
  type FinalValidationRegistrationView,
  type FinalValidationFactView,
} from "./control-journal";
import {
  ownerBoardSnapshot,
  nativeValidationSources,
  executionAcceptanceIssue,
} from "./execution-settlement";
import { journalDigest } from "./human-journal";
import { randomUUID } from "node:crypto";
import { qualifiedEvidence } from "./qualified-evidence";
import { currentRuntime, type TaskRuntime } from "./runtime";
import { getBoardRef } from "./state";
import {
  acceptanceError,
  supervisorState,
  prepareReview,
  reviewViewInput,
  modelAdvisor,
  SupervisorAdviceError,
  ReviewContextChangedError,
  requestAdvisorCall,
  checkedSupervisorAdvice,
  applyAdvice,
  holdSupervisor,
  publishSupervisorAcceptance,
  saveSupervisor,
  type Advice,
  type Advisor,
} from "./supervisor";
import {
  buildReviewView,
  reviewViewDigest,
  resolveEvidenceDetail,
  type ReviewViewInput,
} from "./review-view";
import { advisorExtraCalls } from "./advisor-calls";
import { assessSupervisorBudget } from "./supervisor-budget";
import { scopeExecutionIssue } from "./scope-revision-journal";
import { goalControlIssue, goalLease } from "./goal-scope";
import { digest, redact, redactedJSON, type HostReceipt } from "./receipt-store";
import { preflightAuthorizationIssue } from "./preflight";

export interface ReviewVersionV1 extends Omit<ArtifactVersionV1, "inputs" | "artifacts"> {
  inputCount: number;
  artifactCount: number;
}
export interface FinalValidationObservation {
  owner: GoalOwnerKey;
  taskId: string;
  receiptId: string;
  epoch: number;
  taskDigest: string;
  artifactVersion: ReviewVersionV1;
  durable: boolean;
  nativeRef?: { entryId: string; digest: string };
  validationOnly?: FinalValidationFact["validationOnly"];
}
export interface FinalValidationIntent {
  runtime: TaskRuntime;
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  path: string | undefined;
  goalToken: string;
  board: TaskRuntime["board"];
  boardDigest: string;
  owner: GoalOwnerKey;
  taskId: string;
  taskDigest: string;
  epoch: number;
  artifactVersion: ReviewVersionV1;
  toolName: string;
  inputDigest: string;
  registration?: FinalValidationRegistrationView;
}
export interface FinalReviewStateV1 {
  status:
    | "not_ready"
    | "pending"
    | "running"
    | "retryable_error"
    | "needs_validation"
    | "blocked"
    | "accepted";
  owner: GoalOwnerKey;
  attemptId?: string;
  artifactVersion?: ReviewVersionV1;
  failureClass?: ReviewAttemptObservedFact["failureClass"];
  reason: string;
}
export type FinalReviewEligibility =
  | {
      status: "ready";
      owner: GoalOwnerKey;
      artifactVersion: ReviewVersionV1;
      validation: FinalValidationObservation;
    }
  | { status: "needs_validation" | "blocked"; code: string; reason: string };
export function reviewVersionReference(version: ArtifactVersionV1): ReviewVersionV1 {
  const { inputs, artifacts, ...reference } = version;
  return { ...reference, inputCount: inputs.length, artifactCount: artifacts.length };
}
function currentVersion(ctx: ExtensionContext, owner: GoalOwnerKey): ReviewVersionV1 | undefined {
  const captured = captureWorkspaceArtifactVersion(
    ctx.cwd,
    { kind: "goal", goal: owner },
    ctx.sessionManager.getSessionFile(),
  );
  return captured.status === "known" ? reviewVersionReference(captured.version) : undefined;
}
function registrationInvocationInput(receipt: HostReceipt): Record<string, unknown> | undefined {
  if (
    receipt.tool !== "bash" ||
    !receipt.ok ||
    receipt.eligible === false ||
    receipt.exitCode !== 0 ||
    receipt.input.length >= 2000 ||
    /\[redacted\]|\(empty\)/i.test(receipt.input)
  )
    return undefined;
  try {
    const input: unknown = JSON.parse(receipt.input);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof Reflect.get(input, "command") !== "string" ||
      !Reflect.get(input, "command")
    )
      return undefined;
    return JSON.stringify(input) === receipt.input && redactedJSON(input) === receipt.input
      ? (input as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
function selectedRegistration(owner: GoalOwnerKey): FinalValidationRegistrationView | undefined {
  return [...(currentRuntime().controlJournal?.finalValidationRegistrations ?? [])]
    .reverse()
    .find((record) => digest(record.data.owner.goal) === digest(owner));
}
function validationControlAllowed(
  ctx: ExtensionContext,
  owner: GoalOwnerKey,
  pending: number,
): boolean {
  const runtime = currentRuntime(),
    state = supervisorState(),
    board = getBoardRef();
  if (
    !state ||
    !["active", "fault"].includes(state.status) ||
    runtime.journalFault ||
    board.decision ||
    runtime.receiptStore?.pendingCount !== pending
  )
    return false;
  const phase = runtime.goal?.current?.phase;
  if (phase && !["active", "fault", "reviewing"].includes(phase)) return false;
  if (
    goalControlIssue(ctx) ||
    scopeExecutionIssue(ctx) ||
    (state.preflightBinding && preflightAuthorizationIssue(ctx, state.preflightBinding))
  )
    return false;
  return !executionAcceptanceIssue({ kind: "goal", goal: owner });
}
export function registeredFinalValidation(
  ctx: ExtensionContext,
  toolName: string,
  input: unknown,
  afterCapture = false,
): FinalValidationRegistrationView | undefined {
  try {
    return matchRegisteredFinalValidation(ctx, toolName, input, afterCapture);
  } catch {
    return undefined;
  }
}
function matchRegisteredFinalValidation(
  ctx: ExtensionContext,
  toolName: string,
  input: unknown,
  afterCapture: boolean,
): FinalValidationRegistrationView | undefined {
  if (toolName !== "bash") return undefined;
  const state = supervisorState(),
    board = getBoardRef(),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (
    !state ||
    owner?.kind !== "goal" ||
    !validationControlAllowed(ctx, owner.goal, afterCapture ? 1 : 0)
  )
    return undefined;
  const record = selectedRegistration(owner.goal);
  if (!record) return undefined;
  const data = record.data;
  const context = [
    ctx.cwd,
    digest(board),
    digest(state.bindings),
    state.epoch,
    journalDigest(input),
  ];
  const expected = [
    data.cwd,
    data.boardDigest,
    data.bindingsDigest,
    data.epoch + (afterCapture ? 1 : 0),
    data.inputDigest,
  ];
  if (digest(context) !== digest(expected)) return undefined;
  const lease = captureControlLease(ctx);
  const observed = readControlJournal(ctx).finalValidationRegistrations?.find(
    (entry) => entry.entryId === record.entryId && entry.digest === record.digest,
  );
  if (!observed) return undefined;
  const version = currentVersion(ctx, owner.goal);
  assertLease(ctx, lease);
  return version && digest(version) === digest(data.artifactVersion) ? record : undefined;
}
export function finalValidationReviewDigests(
  ctx: ExtensionContext,
  event: ToolCallEvent,
): Array<{ taskId: string; digest: string }> {
  const record = registeredFinalValidation(ctx, event.toolName, event.input);
  return record ? [{ taskId: record.data.taskId, digest: record.data.taskDigest }] : [];
}
export function currentReviewArtifactVersion(ctx: ExtensionContext): ReviewVersionV1 | undefined {
  if (!ctx.sessionManager.getSessionFile()) return undefined;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  return owner?.kind === "goal" ? currentVersion(ctx, owner.goal) : undefined;
}
function validationCaptureContext(
  ctx: ExtensionContext,
  board: Readonly<ReturnType<typeof getBoardRef>>,
): boolean {
  return (
    !goalControlIssue(ctx) &&
    !(board.workflowStatus === "completed" && !ctx.sessionManager.getSessionFile())
  );
}
export function beginFinalValidation(ctx: ExtensionContext, event: ToolCallEvent): void {
  const runtime = currentRuntime(),
    state = supervisorState(),
    board = getBoardRef();
  if (!state || !validationCaptureContext(ctx, board)) return;
  const registration =
    board.workflowStatus === "completed"
      ? registeredFinalValidation(ctx, event.toolName, event.input, true)
      : undefined;
  if (board.workflowStatus === "completed" && !registration)
    throw new Error(
      "Registered validation context changed before execution; inspect the admitted capture",
    );
  const task = board.tasks.find(
    (task) =>
      task.id === board.finalAcceptanceTaskId && (task.status === "reviewing" || !!registration),
  );
  if (!task || (!registration && state.status !== "active")) return;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (owner?.kind !== "goal") return;
  const version = currentVersion(ctx, owner.goal);
  if (!version) return;
  const intents = (runtime.finalValidationIntents ??= new Map());
  if (intents.size >= 512)
    throw new Error(
      "Validation capture bound reached; inspect pending host work before more execution",
    );
  intents.set(event.toolCallId, {
    runtime,
    manager: ctx.sessionManager,
    sessionId: ctx.sessionManager.getSessionId(),
    path: ctx.sessionManager.getSessionFile(),
    goalToken: goalLease(),
    board: runtime.board,
    boardDigest: digest(board),
    owner: owner.goal,
    taskId: task.id,
    taskDigest: digest(task),
    epoch: state.epoch,
    artifactVersion: version,
    toolName: event.toolName,
    inputDigest: journalDigest(event.input),
    ...(registration ? { registration } : {}),
  });
}
function validationFrameCurrent(ctx: ExtensionContext, intent: FinalValidationIntent): boolean {
  const runtime = currentRuntime();
  return (
    runtime === intent.runtime &&
    ctx.sessionManager === intent.manager &&
    ctx.sessionManager.getSessionId() === intent.sessionId &&
    ctx.sessionManager.getSessionFile() === intent.path &&
    goalLease() === intent.goalToken &&
    runtime.board === intent.board &&
    digest(runtime.board) === intent.boardDigest
  );
}
function eligibleValidationReceipt(intent: FinalValidationIntent, receipt: HostReceipt): boolean {
  const state = supervisorState();
  const allowed =
    state?.status === "active" || (!!intent.registration && state?.status === "fault");
  return (
    !!state &&
    allowed &&
    state.epoch === intent.epoch &&
    receipt.epoch === intent.epoch &&
    receipt.ok &&
    receipt.exitCode === 0 &&
    receipt.eligible !== false &&
    !currentRuntime().receiptStore?.pendingCount &&
    receipt.reviews.some(
      (review) => review.taskId === intent.taskId && review.digest === intent.taskDigest,
    )
  );
}
function recordFinalValidation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  intent: FinalValidationIntent,
  receipt: HostReceipt,
  version: ReviewVersionV1,
): FinalValidationObservation {
  const registration = intent.registration;
  const validationOnly = registration
    ? {
        registrationRef: { entryId: registration.entryId, digest: registration.digest },
        boardDigest: registration.data.boardDigest,
        bindingsDigest: registration.data.bindingsDigest,
      }
    : undefined;
  const observation: FinalValidationObservation = {
    owner: intent.owner,
    taskId: intent.taskId,
    receiptId: receipt.id,
    epoch: receipt.epoch,
    taskDigest: intent.taskDigest,
    artifactVersion: version,
    durable: false,
    ...(validationOnly ? { validationOnly } : {}),
  };
  if (!ctx.sessionManager.getSessionFile()) return observation;
  const lease = captureControlLease(ctx),
    view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("final-review-v1"))
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "final-review-v1" as const])],
      lease,
    );
  const owner = { kind: "goal" as const, goal: intent.owner },
    source = nativeValidationSources(ctx, owner, [receipt.id])[0];
  if (!source) throw new Error("Final validation has no actual native receipt source");
  const fact: FinalValidationFact = {
    version: 1,
    kind: "final-validation",
    recordId: randomUUID(),
    owner,
    validationId: randomUUID(),
    taskId: intent.taskId,
    taskDigest: intent.taskDigest,
    receiptId: receipt.id,
    source,
    snapshotRef: ownerBoardSnapshot(ctx, owner, getBoardRef()),
    epoch: receipt.epoch,
    toolName: intent.toolName,
    inputDigest: intent.inputDigest,
    capturedInputDigest: digest(receipt.input),
    artifactVersion: version,
    observedAt: Date.now(),
    ...(validationOnly ? { validationOnly } : {}),
  };
  const recorded = appendControlFact(pi, ctx, fact);
  return {
    ...observation,
    durable: true,
    nativeRef: { entryId: recorded.entryId, digest: recorded.digest },
  };
}
export function observeFinalValidation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolResultEvent,
  receipt: HostReceipt,
): void {
  const runtime = currentRuntime(),
    intent = runtime.finalValidationIntents?.get(event.toolCallId);
  runtime.finalValidationIntents?.delete(event.toolCallId);
  if (
    !intent ||
    receipt.id !== `tool:${event.toolCallId}` ||
    !validationFrameCurrent(ctx, intent) ||
    goalControlIssue(ctx)
  )
    return;
  if (!eligibleValidationReceipt(intent, receipt)) return;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (owner?.kind !== "goal" || digest(owner.goal) !== digest(intent.owner)) return;
  const version = currentVersion(ctx, owner.goal);
  if (!version || digest(version) !== digest(intent.artifactVersion)) return;
  runtime.finalValidation = recordFinalValidation(pi, ctx, intent, receipt, version);
}
function observationFrom(record: FinalValidationFactView): FinalValidationObservation {
  const data = record.data;
  return {
    owner: data.owner.goal,
    taskId: data.taskId,
    receiptId: data.receiptId,
    taskDigest: data.taskDigest,
    epoch: data.epoch,
    artifactVersion: data.artifactVersion,
    durable: true,
    nativeRef: { entryId: record.entryId, digest: record.digest },
    ...(data.validationOnly ? { validationOnly: data.validationOnly } : {}),
  };
}
function supplementContextCurrent(
  context: NonNullable<FinalValidationFact["validationOnly"]>,
  board: Readonly<ReturnType<typeof getBoardRef>>,
  bindings: readonly NonNullable<ReturnType<typeof supervisorState>>["bindings"][number][],
): boolean {
  return (
    context.boardDigest === journalDigest(board) &&
    context.bindingsDigest === journalDigest(bindings)
  );
}
function supplementalReceiptEligible(receipt: HostReceipt | undefined, epoch: number): boolean {
  return (
    !!receipt &&
    receipt.ok &&
    receipt.exitCode === 0 &&
    receipt.epoch === epoch &&
    receipt.eligible !== false
  );
}
function attestedFinalValidation(
  ctx: ExtensionContext | undefined,
  board: Readonly<ReturnType<typeof getBoardRef>>,
  state: NonNullable<ReturnType<typeof supervisorState>>,
  bindings: NonNullable<ReturnType<typeof supervisorState>>["bindings"],
): FinalValidationObservation | undefined {
  if (!ctx) return undefined;
  const owner = currentWorkOwner(state.sessionId),
    refs = bindings.find((binding) => binding.taskId === board.finalAcceptanceTaskId)?.refs ?? [];
  if (owner?.kind !== "goal") return undefined;
  for (const qualification of currentRuntime().controlJournal?.invocations?.qualifications.values() ??
    []) {
    const data = qualification.data;
    if (data.taskId !== board.finalAcceptanceTaskId || !refs.includes(data.receiptId)) continue;
    const receipt = currentRuntime().receiptStore?.readReceipts([data.receiptId])[0];
    if (
      receipt &&
      qualifiedEvidence(receipt, data.taskId, data.taskDigest, state.epoch, ctx).eligible
    )
      return {
        owner: owner.goal,
        taskId: data.taskId,
        receiptId: data.receiptId,
        taskDigest: data.taskDigest,
        epoch: data.epoch,
        artifactVersion: data.artifactVersion,
        durable: true,
        nativeRef: qualification.ref,
      };
  }
  return undefined;
}
export function qualifiedFinalValidation(
  board: Readonly<ReturnType<typeof getBoardRef>>,
  state: NonNullable<ReturnType<typeof supervisorState>>,
  bindings: readonly NonNullable<
    ReturnType<typeof supervisorState>
  >["bindings"][number][] = state.bindings,
  ctx?: ExtensionContext,
): FinalValidationObservation | undefined {
  const runtime = currentRuntime(),
    owner = currentWorkOwner(state.sessionId);
  if (runtime.journalFault || runtime.receiptStore?.pendingCount || owner?.kind !== "goal")
    return undefined;
  const record = [...(runtime.controlJournal?.finalValidations ?? [])]
    .reverse()
    .find(
      (record) =>
        record.data.validationOnly &&
        record.data.epoch === state.epoch &&
        record.data.taskId === board.finalAcceptanceTaskId &&
        digest(record.data.owner.goal) === digest(owner.goal) &&
        supplementContextCurrent(record.data.validationOnly, board, bindings),
    );
  if (!record) return attestedFinalValidation(ctx, board, state, [...bindings]);
  const receipt = runtime.receiptStore?.readReceipts([record.data.receiptId])[0];
  return supplementalReceiptEligible(receipt, state.epoch)
    ? observationFrom(record)
    : attestedFinalValidation(ctx, board, state, [...bindings]);
}
function applicableValidation(
  ctx: ExtensionContext | undefined,
  owner: GoalOwnerKey,
  taskId: string,
  refs: readonly string[],
): FinalValidationObservation | undefined {
  const state = supervisorState();
  const supplement = state && qualifiedFinalValidation(getBoardRef(), state, state.bindings, ctx);
  if (supplement) return supplement;
  const records = currentRuntime().controlJournal?.finalValidations ?? [];
  const record = [...records]
    .reverse()
    .find(
      (record) =>
        digest(record.data.owner.goal) === digest(owner) &&
        record.data.taskId === taskId &&
        refs.includes(record.data.receiptId),
    );
  if (!record) return currentRuntime().finalValidation;
  return observationFrom(record);
}
function matchingValidation(
  observation: FinalValidationObservation | undefined,
  owner: GoalOwnerKey,
  taskId: string | undefined,
  refs: readonly string[],
  epoch: number,
  version: ReviewVersionV1,
): observation is FinalValidationObservation {
  const state = supervisorState();
  const included =
    observation &&
    (refs.includes(observation.receiptId) ||
      (state &&
        observation.durable &&
        observation.nativeRef &&
        observation.validationOnly &&
        supplementContextCurrent(observation.validationOnly, getBoardRef(), state.bindings)));
  return (
    !!observation &&
    !!included &&
    digest(observation.owner) === digest(owner) &&
    observation.taskId === taskId &&
    observation.epoch === epoch &&
    digest(observation.artifactVersion) === digest(version)
  );
}
function finalReviewControlHeld(status: string, decision: boolean): boolean {
  return (
    ["paused", "stopped", "completed"].includes(status) ||
    ["stopped", "completed"].includes(currentRuntime().goal?.current?.phase ?? "") ||
    decision
  );
}
function finalReviewModeIssue(ctx: ExtensionContext): string | undefined {
  const issue = goalControlIssue(ctx) ?? scopeExecutionIssue(ctx);
  if (issue) return issue;
  const mode = currentRuntime().management;
  return mode?.mode === "off" || mode?.state === "stopping-with-attention"
    ? "Management has stopped; historical final checks are not current review permission"
    : undefined;
}
export function finalReviewEligibility(ctx: ExtensionContext): FinalReviewEligibility {
  const issue = finalReviewModeIssue(ctx);
  if (issue) return { status: "blocked", code: "CONTROL_HELD", reason: issue };
  const state = supervisorState(),
    board = getBoardRef(),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!state || owner?.kind !== "goal")
    return {
      status: "blocked",
      code: "OWNER_UNKNOWN",
      reason: "Final review needs the actual current Goal and verified receipt owner",
    };
  if (finalReviewControlHeld(state.status, Boolean(board.decision)))
    return {
      status: "blocked",
      code: "CONTROL_HELD",
      reason:
        "The actual Goal/control hold must be resolved; review cannot resume business or override stop",
    };
  const error = acceptanceError(board, state, ctx, undefined, state.bindings, true);
  if (error) return { status: "blocked", code: "WORK_NOT_READY", reason: error };
  const version = currentVersion(ctx, owner.goal);
  if (!version)
    return {
      status: "blocked",
      code: "ARTIFACT_UNKNOWN",
      reason: "Current declared workspace/check inputs cannot be captured; unknown is not same",
    };
  const refs =
    state.bindings.find((binding) => binding.taskId === board.finalAcceptanceTaskId)?.refs ?? [];
  const observation = applicableValidation(
    ctx,
    owner.goal,
    board.finalAcceptanceTaskId ?? "",
    refs,
  );
  if (
    !matchingValidation(
      observation,
      owner.goal,
      board.finalAcceptanceTaskId,
      refs,
      state.epoch,
      version,
    )
  )
    return {
      status: "needs_validation",
      code: "VALIDATION_STALE",
      reason:
        "Obtain a real applicable validation for the current version; do not replay completed business",
    };
  return { status: "ready", owner: owner.goal, artifactVersion: version, validation: observation };
}

function leafReference(ctx: ExtensionContext): { entryId: string; digest: string } {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (!leaf) throw new Error("Final review requires an actual native leaf");
  return { entryId: leaf.id, digest: journalDigest(leaf) };
}
function recordReviewStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  eligibility: Extract<FinalReviewEligibility, { status: "ready" }>,
  packet: string,
  startedAt: number,
): ReviewAttemptEntry {
  const state = supervisorState(),
    board = getBoardRef();
  if (!state || !eligibility.validation.durable || !eligibility.validation.nativeRef)
    throw new Error("Final review requires physically confirmed validation applicability");
  const owner = { kind: "goal" as const, goal: eligibility.owner },
    leaf = leafReference(ctx);
  const data: ReviewAttemptStartedFact = {
    version: 1,
    kind: "review-attempt-started",
    recordId: randomUUID(),
    attemptId: randomUUID(),
    owner,
    snapshotRef: ownerBoardSnapshot(ctx, owner, board),
    supervisorRef: leaf,
    baseLeafRef: leaf,
    boardDigest: journalDigest(board),
    bindingsDigest: journalDigest(state.bindings),
    viewDigest: reviewViewDigest({ packet }),
    firstCallViewDigest: journalDigest(["advisor-view-v1", packet]),
    artifactVersion: eligibility.artifactVersion,
    validationRef: eligibility.validation.nativeRef,
    epoch: state.epoch,
    reviewNumber: state.reviews,
    startedAt,
    deadlineAt: startedAt + 30000,
  };
  const receipt = appendControlFact(pi, ctx, data);
  bindContractReview(pi, ctx, { entryId: receipt.entryId, digest: receipt.digest });
  currentRuntime().finalReview = {
    status: "running",
    owner: eligibility.owner,
    attemptId: data.attemptId,
    artifactVersion: eligibility.artifactVersion,
    reason: "Read-only final review is in progress",
  };
  return { start: { entryId: receipt.entryId, digest: receipt.digest, data } };
}
interface AttemptCounters {
  transportRetries: number;
  corrections: number;
  detailRounds: number;
}
function recordReviewResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entry: ReviewAttemptEntry,
  outcome: ReviewAttemptObservedFact["outcome"],
  failureClass: ReviewAttemptObservedFact["failureClass"],
  reason: string,
  counters: AttemptCounters,
): void {
  const start = entry.start,
    state = supervisorState();
  if (!state) throw new Error("Final review lost its actual Supervisor");
  const callIds = (currentRuntime().controlJournal?.advisorFacts ?? []).flatMap((record) =>
    record.data.kind === "advisor-call-started" &&
    record.data.attemptId === start.data.attemptId &&
    digest(record.data.owner) === digest(start.data.owner)
      ? [record.data.callId]
      : [],
  );
  const data: ReviewAttemptObservedFact = {
    version: 1,
    kind: "review-attempt-observed",
    recordId: randomUUID(),
    owner: start.data.owner,
    attemptId: start.data.attemptId,
    startedRef: { entryId: start.entryId, digest: start.digest },
    outcome,
    failureClass,
    callIds,
    ...counters,
    endLeafRef: leafReference(ctx),
    epoch: state.epoch,
    observedAt: Date.now(),
    reason: redact(reason, 1500),
  };
  appendControlFact(pi, ctx, data);
  currentRuntime().finalReview = {
    status: outcome,
    owner: start.data.owner.goal,
    attemptId: start.data.attemptId,
    artifactVersion: start.data.artifactVersion,
    failureClass,
    reason: data.reason,
  };
}
interface ClassifiedReviewFailure {
  failureClass: ReviewAttemptObservedFact["failureClass"];
  retry: boolean;
}
function loopFailure(code: unknown): ClassifiedReviewFailure | undefined {
  const kinds: Record<string, ClassifiedReviewFailure["failureClass"]> = {
    REVIEW_CONTEXT_CHANGED: "control_held",
    REVIEW_BUDGET: "budget",
    REVIEW_MATERIAL: "evidence_missing",
    ADVICE_MISMATCH: "advice_mismatch",
  };
  const failureClass =
    typeof code === "string" && Object.hasOwn(kinds, code) ? kinds[code] : undefined;
  return failureClass ? { failureClass, retry: false } : undefined;
}
function classifyReviewFailure(error: unknown, deadlineAt: number): ClassifiedReviewFailure {
  const status: unknown =
    error instanceof Error
      ? (Reflect.get(error, "status") ?? Reflect.get(error, "statusCode"))
      : undefined;
  const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
  const local = loopFailure(code);
  if (local) return local;
  if (status === 401 || status === 403) return { failureClass: "authentication", retry: false };
  if (Date.now() >= deadlineAt) return { failureClass: "deadline", retry: false };
  if (
    (typeof status === "number" && [408, 429, 500, 502, 503, 504].includes(status)) ||
    ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(String(code))
  )
    return { failureClass: "transient", retry: true };
  return { failureClass: "unknown_model_failure", retry: false };
}
async function cancellableFinal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let listener = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      reject(new Error("Final review cancelled or timed out"));
    };
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", listener);
  }
}
class ReviewLoopError extends Error {
  constructor(
    readonly code: "REVIEW_BUDGET" | "REVIEW_MATERIAL",
    message: string,
  ) {
    super(message);
  }
}
interface ActiveFinalAttempt {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  state: NonNullable<ReturnType<typeof supervisorState>>;
  board: ReturnType<typeof getBoardRef>;
  entry: ReviewAttemptEntry;
  eligibility: Extract<FinalReviewEligibility, { status: "ready" }>;
  counters: AttemptCounters;
  signal: AbortSignal;
  advisor: Advisor;
  packet: string;
  lease: string;
  source: ReviewViewInput;
  delivery?: ReviewViewInput["reviewDelivery"];
  current: () => boolean;
}
type FinalResponse = { kind: "more" } | { kind: "done"; advice?: Advice };
function finalCallIds(entry: ReviewAttemptEntry): string[] {
  return (currentRuntime().controlJournal?.advisorFacts ?? []).flatMap((record) =>
    record.data.kind === "advisor-call-started" &&
    record.data.attemptId === entry.start.data.attemptId &&
    digest(record.data.owner) === digest(entry.start.data.owner)
      ? [record.data.callId]
      : [],
  );
}
function finalCallBudgetSpent(run: ActiveFinalAttempt): boolean {
  const calls = finalCallIds(run.entry).length;
  // The primary slot was reserved before the first provider request; subsequent
  // calls must include it and every extra call in the shared budget.
  const budget = assessSupervisorBudget(
    { ...run.state, reviews: run.state.reviews - (calls === 0 ? 1 : 0) },
    advisorExtraCalls(run.entry.start.data.owner.goal),
  );
  return calls >= 4 || budget.status !== "available";
}
function prepareFinalCall(run: ActiveFinalAttempt): void {
  if (Date.now() >= run.entry.start.data.deadlineAt || run.signal.aborted)
    throw new Error("Final review deadline/cancellation reached");
  if (finalCallBudgetSpent(run))
    throw new ReviewLoopError(
      "REVIEW_BUDGET",
      "Review call slots exhausted; no budget or business state was reset",
    );
  const result = buildReviewView({ ...run.source, reviewDelivery: run.delivery });
  if (result.status === "error") throw new ReviewLoopError("REVIEW_MATERIAL", result.error.message);
  run.packet = result.view.packet;
}
function deliverFinalEvidence(run: ActiveFinalAttempt, advice: Advice): FinalResponse {
  if (run.counters.detailRounds >= 2)
    throw new ReviewLoopError(
      "REVIEW_MATERIAL",
      "Two evidence detail rounds exhausted; remaining material is not implicitly accepted",
    );
  const details = (advice.detailIds ?? []).map((id) => {
    const detail = resolveEvidenceDetail(run.source, id);
    if ("code" in detail) throw new ReviewLoopError("REVIEW_MATERIAL", detail.message);
    return detail;
  });
  if (finalCallBudgetSpent(run))
    throw new ReviewLoopError(
      "REVIEW_BUDGET",
      "No call slot remains to deliver requested evidence",
    );
  run.counters.detailRounds++;
  const prior = run.delivery?.details ?? [];
  run.delivery = {
    ...run.delivery,
    details: [
      ...prior.filter((item) => !details.some((detail) => detail.id === item.id)),
      ...details,
    ],
  };
  return { kind: "more" };
}
function applyFinalResponse(
  run: ActiveFinalAttempt,
  response: NonNullable<Awaited<ReturnType<typeof requestAdvisorCall>>>,
): FinalResponse {
  const { pi, ctx, board, state, entry, counters } = run;
  if (ctx.sessionManager.getLeafId() !== response.leaf) throw new ReviewContextChangedError();
  const now = finalReviewEligibility(ctx);
  if (
    now.status !== "ready" ||
    digest(now.artifactVersion) !== digest(run.eligibility.artifactVersion)
  ) {
    recordReviewResult(
      pi,
      ctx,
      entry,
      "needs_validation",
      "validation_stale",
      "Final inputs changed; obtain applicable validation without replaying work",
      counters,
    );
    holdSupervisor(
      pi,
      ctx,
      "fault",
      "Final inputs changed; obtain applicable validation",
      "review_failed",
    );
    return { kind: "done" };
  }
  const advice = checkedSupervisorAdvice(ctx, board, state, response.result);
  if (advice.action === "request_evidence") return deliverFinalEvidence(run, advice);
  if (advice.action !== "accept" && advice.action !== "hold")
    throw new SupervisorAdviceError(
      "Completed work permits only accept, hold or registered evidence detail; never replay business",
    );
  recordReviewResult(
    pi,
    ctx,
    entry,
    advice.action === "accept" ? "accepted" : "blocked",
    advice.action === "accept" ? "none" : "evidence_missing",
    advice.message,
    counters,
  );
  return { kind: "done", advice: applyAdvice(pi, ctx, board, state, response.result) };
}
function correctFinalAction(run: ActiveFinalAttempt, error: unknown): boolean {
  if (
    !(error instanceof SupervisorAdviceError) ||
    run.counters.corrections >= 1 ||
    run.signal.aborted
  )
    return false;
  run.counters.corrections++;
  run.delivery = {
    ...run.delivery,
    correction: {
      allowedActions: ["accept", "hold", "request_evidence"],
      reason: redact(error.message, 1000),
    },
  };
  return true;
}
function finalRetryFailure(run: ActiveFinalAttempt, error: unknown): ClassifiedReviewFailure {
  const failure = classifyReviewFailure(error, run.entry.start.data.deadlineAt);
  if (["control_held", "authentication", "evidence_missing"].includes(failure.failureClass))
    return failure;
  if (Date.now() >= run.entry.start.data.deadlineAt)
    return { failureClass: "deadline", retry: false };
  return finalCallBudgetSpent(run) ? { failureClass: "budget", retry: false } : failure;
}
function retryFinalCall(run: ActiveFinalAttempt, error: unknown): boolean {
  if (!run.current() || currentRuntime().journalFault) return false;
  const failure = finalRetryFailure(run, error);
  if (failure.failureClass === "advice_mismatch" && correctFinalAction(run, error)) return true;
  if (failure.retry && run.counters.transportRetries < 1 && !run.signal.aborted) {
    run.counters.transportRetries++;
    return true;
  }
  const outcome = [
    "authentication",
    "control_held",
    "advice_mismatch",
    "evidence_missing",
  ].includes(failure.failureClass)
    ? "blocked"
    : "retryable_error";
  recordReviewResult(
    run.pi,
    run.ctx,
    run.entry,
    outcome,
    failure.failureClass,
    error instanceof Error ? error.message : "Unknown model failure",
    run.counters,
  );
  holdSupervisor(
    run.pi,
    run.ctx,
    failure.failureClass === "budget" ? "paused" : "fault",
    error instanceof Error ? error.message : "Final review failed",
    failure.failureClass === "budget" ? "budget_exhausted" : "review_failed",
  );
  return false;
}
async function runFinalCalls(run: ActiveFinalAttempt): Promise<Advice | undefined> {
  for (;;) {
    try {
      prepareFinalCall(run);
      const response = await cancellableFinal(
        requestAdvisorCall(
          run.pi,
          run.ctx,
          run.board,
          run.state,
          run.signal,
          run.advisor,
          run.packet,
          run.lease,
          run.entry.start.data.attemptId,
        ),
        run.signal,
      );
      if (!run.current()) return undefined;
      if (!response || run.signal.aborted || Date.now() >= run.entry.start.data.deadlineAt)
        throw new Error("Final review cancelled or timed out");
      const result = applyFinalResponse(run, response);
      if (result.kind === "done") return result.advice;
    } catch (error) {
      if (!retryFinalCall(run, error)) return undefined;
    }
  }
}
function cacheReviewBudgetHold(
  owner: GoalOwnerKey,
  state: NonNullable<ReturnType<typeof supervisorState>>,
  artifactVersion?: ReviewVersionV1,
  attemptId?: string,
): boolean {
  if (state.holdCause !== "budget_exhausted") return false;
  currentRuntime().finalReview = {
    status: "retryable_error",
    owner,
    failureClass: "budget",
    reason: "Shared Goal review/call budget exhausted; explicit retry does not replenish it",
    ...(artifactVersion ? { artifactVersion } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
  return true;
}
export async function requestFinalReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  parentSignal: AbortSignal,
  advisor: Advisor = modelAdvisor,
): Promise<Advice | undefined> {
  if (currentRuntime().finalReviewAbort && !currentRuntime().finalReviewAbort?.signal.aborted)
    throw new Error(
      "A final review attempt is already running; inspect or cancel it before another retry",
    );
  const eligibility = finalReviewEligibility(ctx),
    state = supervisorState();
  if (!state) return undefined;
  if (eligibility.status !== "ready") {
    const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
    if (owner?.kind === "goal")
      currentRuntime().finalReview = {
        status: eligibility.status,
        owner: owner.goal,
        reason: eligibility.reason,
      };
    if (eligibility.code !== "CONTROL_HELD" && eligibility.code !== "OWNER_UNKNOWN")
      holdSupervisor(pi, ctx, "fault", eligibility.reason, "review_failed");
    return undefined;
  }
  const runtime = currentRuntime(),
    board = getBoardRef(),
    boardDigest = digest(board),
    lease = goalLease(),
    startedAt = Date.now();
  const manager = ctx.sessionManager,
    sessionId = manager.getSessionId(),
    sessionFile = manager.getSessionFile();
  const controller = new AbortController();
  runtime.finalReviewAbort = controller;
  const signal = AbortSignal.any([parentSignal, controller.signal, AbortSignal.timeout(30000)]);
  let entry: ReviewAttemptEntry | undefined;
  const counters: AttemptCounters = { transportRetries: 0, corrections: 0, detailRounds: 0 };
  const current = () =>
    ctx.sessionManager === manager &&
    manager.getSessionId() === sessionId &&
    manager.getSessionFile() === sessionFile &&
    currentRuntime() === runtime &&
    supervisorState() === state &&
    state.status === "reviewing" &&
    goalLease() === lease &&
    getBoardRef() === board &&
    digest(board) === boardDigest &&
    runtime.finalReview?.attemptId === entry?.start.data.attemptId;
  try {
    if (!prepareReview(pi, ctx, board, state)) {
      cacheReviewBudgetHold(eligibility.owner, state, eligibility.artifactVersion);
      return undefined;
    }
    const source = structuredClone(
      reviewViewInput(ctx, board, state, state.bindings, eligibility.artifactVersion),
    );
    const initial = buildReviewView(source);
    if (initial.status === "error") {
      runtime.finalReview = {
        status: "blocked",
        owner: eligibility.owner,
        artifactVersion: eligibility.artifactVersion,
        failureClass: "evidence_missing",
        reason: `${initial.error.code}: ${initial.error.message}`,
      };
      holdSupervisor(pi, ctx, "fault", runtime.finalReview.reason, "review_failed");
      return undefined;
    }
    const packet = initial.view.packet;
    entry = recordReviewStart(pi, ctx, eligibility, packet, startedAt);
    return await runFinalCalls({
      pi,
      ctx,
      state,
      board,
      entry,
      eligibility,
      counters,
      signal,
      advisor,
      packet,
      lease,
      source,
      current,
    });
  } finally {
    if (runtime.finalReviewAbort === controller) runtime.finalReviewAbort = undefined;
  }
}
function existingFinalCheck(): { receipt: HostReceipt; input: Record<string, unknown> } {
  const state = supervisorState(),
    board = getBoardRef();
  const task = board.tasks.find((task) => task.id === board.finalAcceptanceTaskId);
  const binding = state?.bindings.find(
    (binding) => binding.taskId === task?.id && binding.digest === digest(task),
  );
  const refs =
    task?.completionEvidence?.refs
      .filter(
        (ref) =>
          ref.kind === "command" &&
          ref.status === "passed" &&
          ref.exitCode === 0 &&
          ref.ref &&
          binding?.refs.includes(ref.ref),
      )
      .flatMap((ref) => (ref.ref ? [ref.ref] : [])) ?? [];
  const candidates = (currentRuntime().receiptStore?.readReceipts(refs) ?? []).flatMap(
    (receipt) => {
      const input = registrationInvocationInput(receipt);
      return input ? [{ receipt, input }] : [];
    },
  );
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate)
    throw new ReviewLoopError(
      "REVIEW_MATERIAL",
      "A unique fully retained unredacted existing final Bash check is required; missing or ambiguous definitions need explicit trusted check material, never guessed replay",
    );
  return candidate;
}
function registerCompletedValidation(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = supervisorState(),
    board = getBoardRef(),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!state || owner?.kind !== "goal" || !validationControlAllowed(ctx, owner.goal, 0))
    throw new Error(
      "Current authority, execution and host-capture barriers do not permit validation registration",
    );
  const version = currentVersion(ctx, owner.goal);
  if (!version)
    throw new Error(
      "Unknown workspace/check version cannot be registered as applicable validation",
    );
  const check = existingFinalCheck(),
    current = selectedRegistration(owner.goal);
  if (
    current &&
    digest([
      current.data.epoch,
      current.data.boardDigest,
      current.data.bindingsDigest,
      current.data.artifactVersion,
      current.data.inputDigest,
    ]) ===
      digest([
        state.epoch,
        journalDigest(board),
        journalDigest(state.bindings),
        version,
        journalDigest(check.input),
      ])
  )
    return;
  holdSupervisor(
    pi,
    ctx,
    "fault",
    "Completed work requires the registered final validation only; no task or general business write is reopened",
    "review_failed",
  );
  const supervisorRef = leafReference(ctx),
    lease = captureControlLease(ctx),
    view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("final-review-v1"))
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "final-review-v1" as const])],
      lease,
    );
  const task = board.tasks.find((task) => task.id === board.finalAcceptanceTaskId);
  if (!task) throw new Error("Final task changed during validation registration");
  const source = nativeValidationSources(ctx, owner, [check.receipt.id])[0];
  if (!source)
    throw new Error("Registered final check has no actual native invocation/result source");
  const data: FinalValidationRegistrationFact = {
    version: 1,
    kind: "final-validation-registered",
    recordId: randomUUID(),
    owner,
    registrationId: randomUUID(),
    snapshotRef: ownerBoardSnapshot(ctx, owner, board),
    supervisorRef,
    boardDigest: journalDigest(board),
    bindingsDigest: journalDigest(state.bindings),
    epoch: state.epoch,
    taskId: task.id,
    taskDigest: digest(task),
    toolName: "bash",
    inputJSON: check.receipt.input,
    inputDigest: journalDigest(check.input),
    capturedInputDigest: digest(check.receipt.input),
    cwd: ctx.cwd,
    originalReceiptId: check.receipt.id,
    source,
    artifactVersion: version,
    registeredAt: Date.now(),
  };
  appendControlFact(pi, ctx, data);
  currentRuntime().finalReview = {
    status: "needs_validation",
    owner: owner.goal,
    failureClass: "validation_stale",
    reason:
      "Exact prior final-check invocation registered; obtain a new actual stable check, then retry-review. No command was executed or queued",
  };
  pi.sendMessage(
    {
      customType: "continuous-tasks:notice",
      content: `Validation-only registration: bash ${redactedJSON(check.input)} at ${ctx.cwd}. No command was run or queued. Only this already-bound final check is admitted, under unchanged permissions. Registration does not establish semantic check quality or permit business replay; do not run it if its scope/meaning is not validation-only. After an actual successful unchanged-input check, use retry-review.`,
      display: true,
    },
    { triggerTurn: false },
  );
}
function selectedReviewAttempt(owner: GoalOwnerKey): ReviewAttemptEntry | undefined {
  return [...(currentRuntime().controlJournal?.reviewAttempts ?? [])]
    .reverse()
    .find((entry) => digest(entry.start.data.owner.goal) === digest(owner));
}
export function pauseFaultedFinalReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
): boolean {
  const runtime = currentRuntime(),
    state = supervisorState();
  if (
    !state ||
    state.status !== "fault" ||
    runtime.journalFault ||
    !ctx.sessionManager.getSessionFile() ||
    getBoardRef().workflowStatus !== "completed"
  )
    return false;
  const retained = state.reason;
  state.status = "paused";
  state.holdCause = "user_pause";
  state.pending = false;
  state.reason = redact(
    `${reason || "Final review paused by user"}${retained ? `; retained issue: ${retained}` : ""}`,
  );
  saveSupervisor(pi);
  if (runtime.finalReview)
    runtime.finalReview = {
      ...runtime.finalReview,
      status: "blocked",
      failureClass: "control_held",
      reason: state.reason,
    };
  return true;
}
function reviewPauseResumeIssue(ctx: ExtensionContext): string | undefined {
  const runtime = currentRuntime(),
    state = supervisorState();
  if (
    !state ||
    runtime.journalFault ||
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    getBoardRef().decision ||
    runtime.receiptStore?.pendingCount
  )
    return "Resolve actual control/capture holds and wait for Main before resuming review control";
  const issue =
    goalControlIssue(ctx) ??
    scopeExecutionIssue(ctx) ??
    (state.preflightBinding ? preflightAuthorizationIssue(ctx, state.preflightBinding) : undefined);
  if (issue) return issue;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  return owner?.kind === "goal"
    ? executionAcceptanceIssue(owner)
    : "Review has no verified current Goal owner";
}
export function resumePausedFinalReview(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const state = supervisorState();
  if (
    !state ||
    state.status !== "paused" ||
    state.holdCause !== "user_pause" ||
    !ctx.sessionManager.getSessionFile() ||
    getBoardRef().workflowStatus !== "completed"
  )
    return false;
  const issue = reviewPauseResumeIssue(ctx);
  if (issue) throw new Error(issue);
  // Lift only the human pause. Fault/validation context remains closed; Main is never resumed.
  state.status = "fault";
  state.holdCause = "review_failed";
  state.pending = false;
  state.reason =
    "Human final-review pause lifted; inspect validation and use retry-review. Business remains closed";
  saveSupervisor(pi);
  restoreFinalReviewState(ctx);
  return true;
}
export function interruptFinalReview(): void {
  const runtime = currentRuntime();
  if (runtime.finalReview?.status === "running")
    runtime.finalReview = {
      ...runtime.finalReview,
      status: "retryable_error",
      failureClass: "interrupted",
      reason:
        "Review interrupted; inspect current holds and use explicit retry-review, never replay business",
    };
}
function restoredAttemptState(latest: ReviewAttemptEntry, owner: GoalOwnerKey): FinalReviewStateV1 {
  const result = latest.result?.data;
  return {
    status: result?.outcome ?? "retryable_error",
    owner,
    attemptId: latest.start.data.attemptId,
    artifactVersion: latest.start.data.artifactVersion,
    failureClass: result?.failureClass ?? "interrupted",
    reason: result?.reason ?? "Interrupted review restored as held metadata; explicit retry only",
  };
}
function pendingReviewState(
  owner: GoalOwnerKey,
  board: Readonly<ReturnType<typeof getBoardRef>>,
  state: NonNullable<ReturnType<typeof supervisorState>>,
): FinalReviewStateV1 {
  const refs =
    state.bindings.find((binding) => binding.taskId === board.finalAcceptanceTaskId)?.refs ?? [];
  const validation = applicableValidation(
    undefined,
    owner,
    board.finalAcceptanceTaskId ?? "",
    refs,
  );
  return {
    status: validation ? "pending" : "needs_validation",
    owner,
    ...(validation ? { artifactVersion: validation.artifactVersion } : {}),
    reason: validation
      ? "Recorded validation exists; current applicability is checked only on explicit review control"
      : "Completed historical work requires new applicable validation, not task replay",
  };
}
export function restoreFinalReviewState(ctx: ExtensionContext): void {
  const runtime = currentRuntime(),
    state = supervisorState(),
    board = getBoardRef();
  runtime.finalReview = undefined;
  if (!state) return;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (owner?.kind !== "goal") return;
  const latest = selectedReviewAttempt(owner.goal);
  if (
    cacheReviewBudgetHold(
      owner.goal,
      state,
      latest?.start.data.artifactVersion,
      latest?.start.data.attemptId,
    )
  )
    return;
  if (latest) {
    runtime.finalReview = restoredAttemptState(latest, owner.goal);
    return;
  }
  if (board.workflowStatus !== "completed" || state.status === "stopped") return;
  runtime.finalReview = pendingReviewState(owner.goal, board, state);
}
export function finalReviewWriteIssue(ctx: ExtensionContext): string | undefined {
  const runtime = currentRuntime(),
    state = supervisorState();
  if (!state || state.status === "stopped") return undefined;
  const closedWork =
    ctx.sessionManager.getSessionFile() && getBoardRef().workflowStatus === "completed";
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  const selected =
    owner?.kind === "goal" &&
    runtime.finalReview &&
    digest(owner.goal) === digest(runtime.finalReview.owner);
  if (closedWork || selected)
    return "Final review permits only read-only material and qualified review/validation control; completed business and task claiming are not reopened";
  return undefined;
}
function repairConfirmedAcceptance(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  latest: ReviewAttemptEntry | undefined,
  eligibility: FinalReviewEligibility,
): boolean {
  if (!latest || latest.result?.data.outcome !== "accepted" || eligibility.status !== "ready")
    return false;
  const state = supervisorState(),
    board = getBoardRef();
  if (!state) return false;
  const expected = [
    latest.start.data.owner.goal,
    latest.start.data.boardDigest,
    latest.start.data.bindingsDigest,
    latest.start.data.epoch,
    latest.start.data.artifactVersion,
  ];
  const actual = [
    eligibility.owner,
    journalDigest(board),
    journalDigest(state.bindings),
    state.epoch,
    eligibility.artifactVersion,
  ];
  if (digest(actual) !== digest(expected)) return false;
  const lease = captureControlLease(ctx);
  const confirmed = readControlJournal(ctx).reviewAttempts?.find(
    (entry) =>
      entry.start.entryId === latest.start.entryId &&
      entry.start.digest === latest.start.digest &&
      entry.result?.entryId === latest.result?.entryId &&
      entry.result?.digest === latest.result?.digest,
  );
  if (!confirmed) return false;
  assertLease(ctx, lease);
  publishSupervisorAcceptance(pi, ctx, board, state);
  currentRuntime().finalReview = restoredAttemptState(confirmed, eligibility.owner);
  return true;
}
function registerNeededValidation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: GoalOwnerKey,
  reason: string,
  latest?: ReviewAttemptEntry,
): void {
  currentRuntime().finalReview = {
    status: "needs_validation",
    owner,
    reason,
    attemptId: latest?.start.data.attemptId,
  };
  try {
    registerCompletedValidation(pi, ctx);
  } catch (error) {
    if (error instanceof ReviewLoopError)
      currentRuntime().finalReview = {
        status: "blocked",
        owner,
        failureClass: "evidence_missing",
        reason: error.message,
        attemptId: latest?.start.data.attemptId,
      };
    throw error;
  }
}
export async function retryFinalReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  attemptId?: string,
): Promise<void> {
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    throw new Error(
      "Wait for Main to be idle with no pending messages before retrying final review",
    );
  if (currentRuntime().finalReviewAbort && !currentRuntime().finalReviewAbort?.signal.aborted)
    throw new Error(
      "A final review attempt is already running; inspect or cancel it before another retry",
    );
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (owner?.kind !== "goal") throw new Error("Final review has no verified current Goal owner");
  const latest = selectedReviewAttempt(owner.goal);
  if (attemptId && latest?.start.data.attemptId !== attemptId)
    throw new Error("Final review attempt identity changed; inspect before retry");
  const eligibility = finalReviewEligibility(ctx);
  if (repairConfirmedAcceptance(pi, ctx, latest, eligibility)) return;
  if (eligibility.status === "needs_validation") {
    registerNeededValidation(pi, ctx, owner.goal, eligibility.reason, latest);
    return;
  }
  await requestFinalReview(
    pi,
    ctx,
    AbortSignal.timeout(30000),
    currentRuntime().reviewAdvisor ?? modelAdvisor,
  );
}
