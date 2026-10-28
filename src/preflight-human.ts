import { randomUUID } from "node:crypto";
import {
  appendOwnerSnapshot,
  goalStartIdentityIssue,
  goalPreflightControlIssue,
  goalPreflightDenialOnly,
  goalLease,
} from "./goal-scope";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import {
  captureReadbackFrame,
  publishReadbackControl,
  saveReadbackProjection,
  sessionJournalView,
} from "./human-control";
import {
  inspectSessionJournal,
  journalDigest,
  type ReadbackProof,
  type ReadbackFrame,
} from "./human-journal";
import { isTrustedLocalTui, requestNativeAnswer, type NativeAnswer } from "./human-ui";
import { currentRuntime } from "./runtime";
import {
  PREFLIGHT_ENTRY,
  NativePreflightControlSchema,
  preflightPermissionSelection,
  preflightPlanBinding,
  preflightRequestPredecessor,
  canReusePreflightRequest,
  currentPreflightRequestIssue,
  confirmedApprovalDefinitionSource,
  preflightPermissionScope,
  preflightStartScope,
  projectPreflightPermissions,
  projectPreflightStart,
  submitPreflight,
  inspectPreflightStart,
  inspectConfirmedPreflightProjection,
  markPreflightStarted,
  restorePreflight,
  type PreflightState,
  type PreflightProposal,
  type NativePreflightControl,
  type NativePermissionControl,
  type NativeStartControl,
} from "./preflight";
import { startSupervisor, supervisorNotice, supervisorState } from "./supervisor";
import { formatFlowStatus, flowFacts } from "./flow";
import { getBoardRef } from "./state";
import { enableSessionScope, updateActiveTools } from "./scope";
import { readablePreflight, preflightMaterial, readableApprovalBundle } from "./human-presentation";
import {
  approvalContractProposal,
  captureApprovalContract,
  ensureApprovalWorkflowFence,
} from "./approval-bundle";

type ConfirmedProof = Extract<ReadbackProof, { status: "confirmed" }>;
class StaleApprovalMaterial extends Error {
  constructor() {
    super(
      "Approval definitions changed or became unavailable during native review; no response was saved. Review current material again.",
    );
  }
}
function requireCurrentApprovalMaterial(ctx: ExtensionContext, base: PreflightState): void {
  const captured = base.version === 2 ? base.permissionRequest?.acceptance : undefined;
  if (!captured) return;
  try {
    if (journalDigest(captureApprovalContract(ctx, base)) === journalDigest(captured)) return;
  } catch {
    /* No response publisher has been entered; this is not an unknown write. */
  }
  throw new StaleApprovalMaterial();
}
export interface PreflightHumanResult {
  state: PreflightState;
  status:
    | "approved"
    | "partial"
    | "rejected"
    | "deferred"
    | "unsupported"
    | "started"
    | "already_saved"
    | "awaiting_contract"
    | "defined"
    | "definition_declined";
  remainingGates: string[];
  confirmed?: {
    kind: NativePreflightControl["kind"];
    requestId: string;
    presentationId: string;
    controlEntryId: string;
    permissionIds: string[];
    planId: string;
    planDigest: string;
    answer: string;
  };
  projectionPending?: boolean;
  startupPending?: "startup" | "projection";
}
function own(ctx: ExtensionContext): PreflightState {
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("No current-session preflight");
  return structuredClone(state);
}
function idle(ctx: ExtensionCommandContext): void {
  if (currentRuntime().journalFault) throw new Error(currentRuntime().journalFault);
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    throw new Error("Wait for Main and pending messages before preflight control");
}
function gates(ctx: ExtensionContext, state: PreflightState): string[] {
  const selected = state.approval?.permissionIds ?? [];
  const missing =
    state.proposal?.permissions
      .filter((p) => p.required && !selected.includes(p.id))
      .map((p) => p.id) ?? [];
  return [
    ...(missing.length ? [`Missing required permissions: ${missing.join(", ")}`] : []),
    ...(!state.started
      ? ["Separate native first-start confirmation required; approved is not started"]
      : []),
    ...formatFlowStatus(getBoardRef(), supervisorState(), flowFacts(ctx)),
  ];
}
function result(
  ctx: ExtensionContext,
  state: PreflightState,
  status: PreflightHumanResult["status"],
): PreflightHumanResult {
  return { state: structuredClone(state), status, remainingGates: gates(ctx, state) };
}
function persistenceFault(): void {
  const runtime = currentRuntime();
  runtime.cancel();
  runtime.journalFault ??=
    "Preflight persistence/readback failed; inspect the actual journal before control";
}
function savePreparation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: PreflightState,
): PreflightState {
  try {
    inspectSessionJournal(sessionJournalView(ctx));
    const stored = appendOwnerSnapshot(pi, PREFLIGHT_ENTRY, state);
    const journal = inspectSessionJournal(sessionJournalView(ctx));
    const leaf = journal.branch.at(-1);
    if (leaf?.customType !== PREFLIGHT_ENTRY || journalDigest(leaf.data) !== journalDigest(stored))
      throw new Error("Preflight request persistence failed");
    currentRuntime().preflight = structuredClone(state);
    return state;
  } catch (error) {
    persistenceFault();
    throw error;
  }
}
function legacyStartPermissionMetadata(base: PreflightState, kind: "permission" | "start") {
  if (base.version !== 1 || kind !== "start" || !base.approval) return {};
  return {
    permissionRequest: {
      id: randomUUID(),
      permissionIds: [...base.approval.permissionIds],
      supersedes: { legacyControlEntryId: base.approval.controlEntryId },
    },
  };
}
function prepareLegacyQuestionBase(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  base: PreflightState,
  kind: "permission" | "start",
): PreflightState {
  if (kind !== "permission" || base.version !== 1 || !base.started || !base.approval) return base;
  // Preserve the historical conversion shape, then give the actual question its own successor.
  return savePreparation(pi, ctx, {
    ...base,
    version: 2,
    ...legacyStartPermissionMetadata(base, "start"),
  });
}
function requestOf(base: PreflightState, kind: "permission" | "start") {
  if (base.version !== 2) return;
  return kind === "permission" ? base.permissionRequest : base.startRequest;
}
function requestAcceptance(
  ctx: ExtensionContext,
  base: PreflightState,
  kind: "permission" | "start",
  denyOnly: boolean,
) {
  if (kind !== "permission" || !base.proposal?.contractProposalId) return;
  return denyOnly ? requestOf(base, kind)?.acceptance : captureApprovalContract(ctx, base);
}
function reusableRequest(
  ctx: ExtensionContext,
  base: PreflightState,
  kind: "permission" | "start",
  permissionIds: string[] | undefined,
  denyOnly: boolean,
  acceptance: ReturnType<typeof requestAcceptance>,
): boolean {
  const request = requestOf(base, kind);
  return Boolean(
    request &&
    (denyOnly || request.purpose !== "definitions") &&
    (!acceptance || journalDigest(acceptance) === journalDigest(request.acceptance)) &&
    canReusePreflightRequest(ctx, base, kind) &&
    (kind === "start" ||
      request.purpose === "bundle" ||
      JSON.stringify(request.permissionIds) === JSON.stringify(permissionIds)),
  );
}
function prepareRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  base: PreflightState,
  kind: "permission" | "start",
  permissionIds?: string[],
  denyOnly = false,
): PreflightState {
  base = prepareLegacyQuestionBase(pi, ctx, base, kind);
  const acceptance = requestAcceptance(ctx, base, kind, denyOnly);
  if (reusableRequest(ctx, base, kind, permissionIds, denyOnly, acceptance)) return base;
  const supersedes = preflightRequestPredecessor(ctx, base, kind);
  const next = {
    ...base,
    version: 2 as const,
    ...(kind === "permission" && !base.started ? { startRequest: undefined } : {}),
    ...legacyStartPermissionMetadata(base, kind),
    [kind === "permission" ? "permissionRequest" : "startRequest"]: {
      id: randomUUID(),
      supersedes,
      ...(kind === "permission"
        ? {
            permissionIds: base.proposal?.contractProposalId
              ? base.proposal.permissions.map((p) => p.id).sort()
              : [...(permissionIds ?? [])],
            ...(base.proposal?.contractProposalId
              ? { purpose: "bundle" as const, acceptance }
              : {}),
          }
        : {}),
    },
  };
  const runtime = currentRuntime();
  if (runtime.humanAbort) {
    runtime.humanEpoch++;
    runtime.humanAbort.abort();
    runtime.humanAbort = undefined;
  }
  return savePreparation(pi, ctx, next);
}
function preflightQuestionCurrent(
  ctx: ExtensionContext,
  base: PreflightState,
  start: boolean,
  denyOnly: boolean,
) {
  const runtime = currentRuntime(),
    epoch = runtime.humanEpoch,
    lease = goalLease();
  const fingerprint = journalDigest(base);
  return () =>
    currentRuntime() === runtime &&
    runtime.humanEpoch === epoch &&
    goalLease() === lease &&
    !goalPreflightControlIssue(ctx, denyOnly ? "deny" : "grant") &&
    (!denyOnly || ctx.isIdle()) &&
    !runtime.journalFault &&
    (!start || !goalStartIdentityIssue(ctx, base.goal)) &&
    !ctx.hasPendingMessages() &&
    journalDigest(own(ctx)) === fingerprint;
}
function approvalChoices(base: PreflightState, ids: string[]) {
  return {
    permissions: (base.proposal?.permissions ?? []).map((permission) => ({
      id: permission.id,
      label: permission.action,
      required: permission.required,
    })),
    selectedIds: ids,
    definitionsOnly: base.version === 2 && base.permissionRequest?.purpose === "definitions",
  };
}
function preflightQuestionMaterial(
  ctx: ExtensionContext,
  base: PreflightState,
  ids: string[],
  start: boolean,
  denyOnly: boolean,
) {
  const captured = base.version === 2 ? base.permissionRequest?.acceptance : undefined;
  const bundled = !start && captured;
  const contract = bundled
    ? approvalContractProposal(inspectSessionJournal(sessionJournalView(ctx)), base).data.proposal
    : undefined;
  const presentation =
    bundled && contract
      ? readableApprovalBundle(base, contract, captured)
      : readablePreflight(base, ids, start);
  let material = preflightMaterial(base, ids, start);
  if (Buffer.byteLength(presentation.body, "utf8") > 64000)
    throw Error("Complete approval material exceeds 64KB; no required field is dropped");
  if (denyOnly) {
    const notice =
      "目标已关闭。本次仅接受“不允许”以终结原问题；“允许”或稍后不会新增权限，也不会重启目标。";
    presentation.title = "关闭目标：仅可拒绝原权限问题";
    presentation.body = `${notice}\n\n${presentation.body}`;
    material = {
      ...material,
      sections: [{ title: "仅可拒绝，不可新增许可", markdown: notice }, ...material.sections],
    };
  }
  return { presentation, material, bundled };
}
async function present(
  ctx: ExtensionContext,
  base: PreflightState,
  frame: ReadbackFrame,
  ids: string[],
  start: boolean,
  signal?: AbortSignal,
  denyOnly = false,
): Promise<NativeAnswer | undefined> {
  const runtime = currentRuntime();
  const controller = new AbortController();
  runtime.humanAbort = controller;
  const current = preflightQuestionCurrent(ctx, base, start, denyOnly);
  const { presentation, material, bundled } = preflightQuestionMaterial(
    ctx,
    base,
    ids,
    start,
    denyOnly,
  );
  try {
    return await requestNativeAnswer(
      ctx,
      {
        frame,
        kind: start ? "choice" : "authorization",
        purpose: start ? "first-start" : bundled ? "approval-bundle" : "authorization",
        ...presentation,
        material,
        ...(bundled ? { approval: approvalChoices(base, ids) } : {}),
        ...(start
          ? { options: ["Later", "Start execution"], displayOptions: ["稍后启动", "开始执行"] }
          : {}),
      },
      current,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    );
  } finally {
    if (runtime.humanAbort === controller) runtime.humanAbort = undefined;
  }
}
function approvalDigest(ctx: ExtensionContext, base: PreflightState): string {
  const node = inspectSessionJournal(sessionJournalView(ctx)).branch.find(
    (n) => n.id === base.approval?.controlEntryId,
  );
  if (!node) throw new Error("No current-branch approval control");
  return node.digest;
}
function saved(
  ctx: ExtensionContext,
  state: PreflightState,
  control: NativePreflightControl,
  proof: ConfirmedProof,
  status: PreflightHumanResult["status"],
): PreflightHumanResult {
  return {
    ...result(ctx, state, status),
    confirmed: {
      kind: control.kind,
      requestId: proof.frame.requestId,
      presentationId: proof.frame.presentationId,
      controlEntryId: proof.control.id,
      permissionIds: [...control.permissionIds],
      planId: control.planId,
      planDigest: control.planDigest,
      answer: control.answer,
    },
  };
}
function retainPending(ctx: ExtensionContext, proof: ConfirmedProof, state: PreflightState): void {
  const runtime = currentRuntime();
  const faultMessage = "Confirmed preflight result retained; projection pending explicit repair";
  const ownsJournalFault = !runtime.journalFault;
  runtime.preflightRepair = {
    sessionId: ctx.sessionManager.getSessionId(),
    controlEntryId: proof.control.id,
    projectedDigest: journalDigest(state),
    faultMessage,
    ownsJournalFault,
  };
  if (ownsJournalFault) runtime.journalFault = faultMessage;
  runtime.cancel();
}
function permissionMode(ctx: ExtensionContext, base: PreflightState): boolean {
  const denyOnly = goalPreflightDenialOnly(ctx);
  const issue = goalPreflightControlIssue(ctx, denyOnly ? "deny" : "grant");
  if (issue) throw new Error(issue);
  if (denyOnly && !currentPreflightRequestIssue(ctx, base))
    throw new Error("Closed GoalRun has no unresolved native question; no new permission request");
  return denyOnly;
}
function permissionAnswerAllowed(
  ctx: ExtensionContext,
  answer: NativeAnswer | undefined,
  denyOnly: boolean,
): answer is NativeAnswer {
  if (!answer) return false;
  if (!denyOnly || answer.outcome === "reject") return true;
  ctx.ui.notify("目标已关闭：仅“不允许”可提交，未新增许可；原问题仍需最终回应。", "info");
  return false;
}
function nativePermissionSelection(
  base: PreflightState,
  ids: string[],
  answer: NativeAnswer,
): string[] {
  if (!requestOf(base, "permission")?.acceptance || answer.outcome !== "approve") return ids;
  return preflightPermissionSelection(
    base,
    (JSON.parse(answer.value ?? "[]") as string[]).join(",") || "none",
  );
}
async function permission(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection?: string,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  let base = own(ctx);
  const denyOnly = permissionMode(ctx, base);
  if (
    base.version === 2 &&
    base.approvalFlow === "consolidated-v1" &&
    !base.proposal?.contractProposalId
  )
    throw Error("Complete the acceptance proposal and submit contractProposalId before approval");
  const ids = preflightPermissionSelection(base, selection);
  if (!base.proposal || !base.planId || !base.planDigest)
    throw new Error("No complete preflight proposal");
  if (!isTrustedLocalTui(ctx)) return result(ctx, base, "unsupported");
  base = prepareRequest(pi, ctx, base, "permission", ids, denyOnly);
  if (base.version !== 2 || !base.permissionRequest)
    throw new Error("No native permission request");
  if (base.permissionRequest.acceptance) ensureApprovalWorkflowFence(pi, ctx);
  const frame = captureReadbackFrame(
    ctx,
    "preflight",
    base.permissionRequest.id,
    preflightPermissionScope(base, ids),
    base,
  );
  const answer = await present(ctx, base, frame, ids, false, signal, denyOnly);
  if (!permissionAnswerAllowed(ctx, answer, denyOnly)) return result(ctx, base, "deferred");
  const selectedIds = nativePermissionSelection(base, ids, answer);
  const control: NativePermissionControl = {
    version: 2,
    sessionId: base.sessionId,
    preflightId: base.preflightId,
    planId: base.planId as string,
    planDigest: base.planDigest as string,
    permissionIds: selectedIds,
    createdAt: new Date(answer.answeredAt).toISOString(),
    humanInteraction: frame,
    supersedes: base.permissionRequest.supersedes,
    ...(answer.outcome === "approve"
      ? { kind: "approve", answer: "Approve" }
      : { kind: "reject", answer: "Reject" }),
  };
  return savePermissionAnswer(pi, ctx, base, control, frame, answer);
}
function savePermissionAnswer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  base: PreflightState,
  control: NativePermissionControl,
  frame: ReadbackFrame,
  answer: NativeAnswer,
): PreflightHumanResult {
  if (control.kind === "approve" || control.kind === "define")
    requireCurrentApprovalMaterial(ctx, base);
  let proof: ConfirmedProof;
  try {
    proof = publishReadbackControl(pi, ctx, answer, frame, control);
  } catch (error) {
    persistenceFault();
    throw error;
  }
  const next = projectPreflightPermissions(base, control, proof.control.id);
  const status =
    control.kind === "define"
      ? "defined"
      : control.kind === "decline-definition"
        ? "definition_declined"
        : control.kind === "reject"
          ? "rejected"
          : next.phase === "awaiting_authorization"
            ? "partial"
            : "approved";
  try {
    saveReadbackProjection(pi, ctx, proof, next);
    currentRuntime().preflight = structuredClone(next);
    currentRuntime().preflightDefinitionBlock = undefined;
  } catch {
    retainPending(ctx, proof, next);
    return { ...saved(ctx, next, control, proof, status), projectionPending: true };
  }
  return saved(ctx, next, control, proof, status);
}
/** A replacement definition has its own original native response, with the exact
 * original business grant fixed in scope. It cannot grant permissions or Start. */
function alreadyReviewedDefinition(
  journal: ReturnType<typeof inspectSessionJournal>,
  base: Extract<PreflightState, { version: 2 }>,
  acceptance: ReturnType<typeof captureApprovalContract>,
): boolean {
  const request = base.permissionRequest,
    definition = base.definitionApproval;
  if (
    !request?.acceptance ||
    !definition ||
    definition.requestId !== request.id ||
    journalDigest(request.acceptance) !== journalDigest(acceptance)
  )
    return false;
  const node = journal.nodes.get(definition.controlEntryId);
  if (!node) throw Error("Confirmed definition source is missing");
  confirmedApprovalDefinitionSource(journal, { entryId: node.id, digest: node.digest });
  return true;
}
function reusableDefinitionRequest(
  ctx: ExtensionContext,
  base: PreflightState,
  acceptance: ReturnType<typeof captureApprovalContract>,
  businessApproval: { entryId: string; digest: string },
): boolean {
  const request = requestOf(base, "permission");
  return (
    request?.purpose === "definitions" &&
    journalDigest(request.acceptance) === journalDigest(acceptance) &&
    journalDigest(request.businessApproval) === journalDigest(businessApproval) &&
    canReusePreflightRequest(ctx, base, "permission")
  );
}
function assertDefinitionBusinessCurrent(
  base: PreflightState,
  ids: readonly string[],
  original: ReturnType<typeof confirmedApprovalDefinitionSource>,
): void {
  if (
    original.control.kind !== "approve" ||
    original.base.preflightId !== base.preflightId ||
    original.base.planDigest !== base.planDigest ||
    journalDigest(original.control.permissionIds) !== journalDigest(ids)
  )
    throw Error("Definition review needs its exact original business grant");
}
async function reviewPreflightDefinitions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  let base = own(ctx);
  permissionMode(ctx, base);
  if (base.version !== 2 || !base.approval || base.started)
    throw Error("Pre-start definition review requires its existing business approval");
  if (!isTrustedLocalTui(ctx)) return result(ctx, base, "unsupported");
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const businessApproval = {
    entryId: base.approval.controlEntryId,
    digest: approvalDigest(ctx, base),
  };
  const original = confirmedApprovalDefinitionSource(journal, businessApproval);
  assertDefinitionBusinessCurrent(base, base.approval.permissionIds, original);
  const acceptance = captureApprovalContract(ctx, base);
  if (journalDigest(acceptance.workspace) !== journalDigest(original.capture.workspace))
    throw Error(
      "Workspace identity changed; a definition-only response cannot renew business permission. Use an explicit full native scope review.",
    );
  if (alreadyReviewedDefinition(journal, base, acceptance)) {
    currentRuntime().preflightDefinitionBlock = undefined;
    return result(ctx, base, "already_saved");
  }
  const ids = [...base.approval.permissionIds];
  if (!reusableDefinitionRequest(ctx, base, acceptance, businessApproval)) {
    base = savePreparation(pi, ctx, {
      ...base,
      definitionApproval: undefined,
      startRequest: undefined,
      permissionRequest: {
        id: randomUUID(),
        purpose: "definitions",
        permissionIds: ids,
        acceptance,
        businessApproval,
        supersedes: preflightRequestPredecessor(ctx, base, "permission"),
      },
    });
  }
  if (base.version !== 2 || !base.permissionRequest) throw Error("Definition request is missing");
  const frame = captureReadbackFrame(
    ctx,
    "preflight",
    base.permissionRequest.id,
    preflightPermissionScope(base, ids),
    base,
  );
  const answer = await present(ctx, base, frame, ids, false, signal);
  if (!answer) return result(ctx, base, "deferred");
  const control: NativePermissionControl = {
    version: 2,
    sessionId: base.sessionId,
    ...preflightPlanBinding(base),
    permissionIds: ids,
    createdAt: new Date(answer.answeredAt).toISOString(),
    humanInteraction: frame,
    supersedes: base.permissionRequest.supersedes,
    ...(answer.outcome === "approve"
      ? { kind: "define", answer: "Confirm definitions" }
      : { kind: "decline-definition", answer: "Decline definitions" }),
  };
  return savePermissionAnswer(pi, ctx, base, control, frame, answer);
}
export async function approvePreflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planIdHint?: string,
  selection?: string,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  idle(ctx);
  const base = own(ctx);
  if (planIdHint !== undefined && planIdHint !== base.planId)
    throw new Error("Preflight plan ID is stale");
  const approval = base.approval;
  if (
    base.version === 2 &&
    base.approvalFlow === "consolidated-v1" &&
    approval &&
    !base.started &&
    selection === undefined &&
    !base.proposal?.permissions.some((p) => p.required && !approval.permissionIds.includes(p.id))
  )
    return reviewPreflightDefinitions(pi, ctx, signal);
  return permission(pi, ctx, selection, signal);
}
export async function submitAndPresentPreflight(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolCallId: string,
  preflightId: string,
  proposal: PreflightProposal,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  if (!toolCallId || signal?.aborted) throw new Error("Preflight submission cancelled");
  const before = own(ctx);
  const lease = goalLease();
  const issue = goalPreflightControlIssue(ctx);
  if (issue) throw new Error(issue);
  const state = submitPreflight(pi, ctx, preflightId, proposal);
  if (before.revision === state.revision) return result(ctx, state, "already_saved");
  if (
    state.version === 2 &&
    state.approvalFlow === "consolidated-v1" &&
    !state.proposal?.contractProposalId
  )
    return result(ctx, state, "awaiting_contract");
  try {
    return await permission(pi, ctx, undefined, signal);
  } catch (error) {
    if (
      error instanceof StaleApprovalMaterial ||
      goalLease() !== lease ||
      currentRuntime().journalFault
    )
      throw error;
    persistenceFault();
    throw error;
  }
}
function confirmedBundleCapture(
  ctx: ExtensionContext,
  base: Extract<PreflightState, { version: 2 }>,
) {
  const captured = base.permissionRequest?.acceptance;
  if (
    !captured ||
    !base.definitionApproval ||
    base.definitionApproval.requestId !== base.permissionRequest?.id
  )
    throw Error(
      "Current acceptance definitions are not confirmed; inspect the current native review",
    );
  const verified = inspectConfirmedPreflightProjection(ctx, base.definitionApproval.requestId);
  if (
    verified.proof.control.id !== base.definitionApproval.controlEntryId ||
    verified.state.version !== 2 ||
    journalDigest(verified.state.definitionApproval) !== journalDigest(base.definitionApproval) ||
    journalDigest(verified.state.permissionRequest?.acceptance) !== journalDigest(captured)
  )
    throw Error("Confirmed acceptance definition source is unavailable or mismatched");
  return captured;
}
function recordDefinitionBlock(
  base: Extract<PreflightState, { version: 2 }>,
  kind: "definitions" | "materials" | "scope",
  reason: string,
): void {
  const definition = base.definitionApproval;
  if (!definition) throw Error("Confirmed definition identity is missing");
  currentRuntime().preflightDefinitionBlock = {
    preflightId: base.preflightId,
    planDigest: preflightPlanBinding(base).planDigest,
    controlEntryId: definition.controlEntryId,
    kind,
    reason,
  };
}
function validateBundleBeforeStart(ctx: ExtensionContext, base: PreflightState): void {
  if (base.version !== 2 || !base.proposal?.contractProposalId) return;
  const captured = confirmedBundleCapture(ctx, base);
  let current: typeof captured;
  try {
    current = captureApprovalContract(ctx, base);
  } catch (error) {
    recordDefinitionBlock(
      base,
      "materials",
      error instanceof Error ? error.message : "Definition material unavailable",
    );
    throw error;
  }
  if (journalDigest(current) !== journalDigest(captured)) {
    const scope = journalDigest(current.workspace) !== journalDigest(captured.workspace);
    const reason = scope
      ? "Workspace identity changed; an explicit full native scope review is required"
      : "Checker definitions changed after approval; review current definitions without expanding permissions";
    recordDefinitionBlock(base, scope ? "scope" : "definitions", reason);
    throw Error(reason);
  }
  currentRuntime().preflightDefinitionBlock = undefined;
  if (
    captured.pendingChecks.length &&
    !base.proposal.preparation?.permissionIds.every((id) =>
      base.approval?.permissionIds.includes(id),
    )
  )
    throw Error("Declared preparation is missing its exact permissions");
}
function requireUnusedGoalStart(): void {
  if (currentRuntime().goal?.current?.supervisor)
    throw new Error(
      "This GoalRun already saved its first-start; inspect/repair the existing result without another confirmation",
    );
}
export async function startApprovedPreflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planIdHint?: string,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  idle(ctx);
  let base = own(ctx);
  requireUnusedGoalStart();
  inspectPreflightStart(ctx, base.goal, planIdHint);
  validateBundleBeforeStart(ctx, base);
  if (!isTrustedLocalTui(ctx)) return result(ctx, base, "unsupported");
  base = prepareRequest(pi, ctx, base, "start");
  if (
    base.version !== 2 ||
    !base.startRequest ||
    !base.planId ||
    !base.planDigest ||
    !base.approval
  )
    throw new Error("No native start request");
  const digest = approvalDigest(ctx, base);
  const frame = captureReadbackFrame(
    ctx,
    "preflight",
    base.startRequest.id,
    preflightStartScope(base, digest),
    base,
  );
  const answer = await present(ctx, base, frame, base.approval.permissionIds, true, signal);
  if (!answer || answer.value !== "Start execution") return result(ctx, base, "deferred");
  validateBundleBeforeStart(ctx, base);
  const control: NativeStartControl = {
    version: 2,
    kind: "start",
    answer: "Start execution",
    sessionId: base.sessionId,
    preflightId: base.preflightId,
    planId: base.planId,
    planDigest: base.planDigest,
    permissionIds: [...base.approval.permissionIds],
    createdAt: new Date(answer.answeredAt).toISOString(),
    humanInteraction: frame,
    supersedes: base.startRequest.supersedes,
    approvalControlEntryId: base.approval.controlEntryId,
    approvalControlDigest: digest,
  };
  let proof: ConfirmedProof;
  try {
    proof = publishReadbackControl(pi, ctx, answer, frame, control);
  } catch (error) {
    persistenceFault();
    throw error;
  }
  const projected = projectPreflightStart(base, control, proof.control.id);
  let startupVerified = false;
  try {
    startSupervisor(pi, ctx, base.goal, { answer, frame });
    inspectConfirmedPreflightProjection(ctx, frame.requestId);
    startupVerified = true;
    markPreflightStarted(
      pi,
      ctx,
      { preflightId: base.preflightId, planId: base.planId, planDigest: base.planDigest },
      { answer, frame },
    );
  } catch {
    // A+B is retained even when later startup/cache writes fail. It is never replayed.
    if (startupVerified) retainPending(ctx, proof, projected);
    else persistenceFault();
    return {
      ...saved(ctx, startupVerified ? projected : base, control, proof, "already_saved"),
      projectionPending: true,
      startupPending: startupVerified ? "projection" : "startup",
    };
  }
  supervisorNotice(
    pi,
    ctx,
    "Goal recorded after native first-start confirmation; other gates still apply.",
  );
  enableSessionScope(pi);
  updateActiveTools(pi, true);
  return saved(ctx, projected, control, proof, "started");
}
function repairedJournalFault(
  hint: NonNullable<ReturnType<typeof currentRuntime>["preflightRepair"]>,
  oldFault: string | undefined,
): string | undefined {
  return hint.ownsJournalFault && oldFault === hint.faultMessage ? undefined : oldFault;
}
export function repairPreflightProjection(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    throw new Error("Wait for Main and pending messages before repair");
  const runtime = currentRuntime();
  const hint = runtime.preflightRepair;
  if (!hint || hint.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("No pending preflight projection repair");
  const oldFault = runtime.journalFault;
  const oldState = runtime.preflight;
  try {
    restorePreflight(ctx);
    const journal = inspectSessionJournal(sessionJournalView(ctx));
    const control = journal.branch.find((n) => n.id === hint.controlEntryId)?.data;
    if (!Check(NativePreflightControlSchema, control)) throw new Error("Invalid repair control");
    const verified = inspectConfirmedPreflightProjection(ctx, control.humanInteraction.requestId);
    if (
      verified.proof.control.id !== hint.controlEntryId ||
      journalDigest(verified.state) !== hint.projectedDigest
    )
      throw new Error("Preflight repair authority changed; inspect journal");
    const pending = runtime.preflightRepair;
    if (pending) {
      if (
        pending.controlEntryId !== hint.controlEntryId ||
        pending.projectedDigest !== hint.projectedDigest
      )
        throw new Error("Preflight repair authority changed; inspect journal");
      saveReadbackProjection(pi, ctx, verified.proof, verified.state);
    }
    runtime.preflightRepair = undefined;
    runtime.journalFault = repairedJournalFault(hint, oldFault);
  } catch (error) {
    runtime.preflight = oldState;
    runtime.preflightRepair = hint;
    runtime.journalFault = oldFault ?? hint.faultMessage;
    throw error;
  }
}
