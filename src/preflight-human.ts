import { randomUUID } from "node:crypto";
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
  findReadbackProof,
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
  preflightRequestPredecessor,
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
import { readablePreflight } from "./human-presentation";

type ConfirmedProof = Extract<ReadbackProof, { status: "confirmed" }>;
export interface PreflightHumanResult {
  state: PreflightState;
  status:
    | "approved"
    | "partial"
    | "rejected"
    | "deferred"
    | "unsupported"
    | "started"
    | "already_saved";
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
    pi.appendEntry(PREFLIGHT_ENTRY, state);
    const journal = inspectSessionJournal(sessionJournalView(ctx));
    const leaf = journal.branch.at(-1);
    if (leaf?.customType !== PREFLIGHT_ENTRY || journalDigest(leaf.data) !== journalDigest(state))
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
function prepareRequest(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  base: PreflightState,
  kind: "permission" | "start",
  permissionIds?: string[],
): PreflightState {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const request =
    base.version === 2
      ? kind === "permission"
        ? base.permissionRequest
        : base.startRequest
      : undefined;
  if (
    request &&
    findReadbackProof(journal, "preflight", request.id).status === "missing" &&
    (kind === "start" || JSON.stringify(request.permissionIds) === JSON.stringify(permissionIds))
  )
    return base;
  const supersedes = preflightRequestPredecessor(ctx, base, kind);
  const next = {
    ...base,
    version: 2 as const,
    ...(kind === "permission" && !base.started ? { startRequest: undefined } : {}),
    ...legacyStartPermissionMetadata(base, kind),
    [kind === "permission" ? "permissionRequest" : "startRequest"]: {
      id: randomUUID(),
      supersedes,
      ...(kind === "permission" ? { permissionIds: [...(permissionIds ?? [])] } : {}),
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
async function present(
  ctx: ExtensionContext,
  base: PreflightState,
  frame: ReadbackFrame,
  ids: string[],
  start: boolean,
  signal?: AbortSignal,
): Promise<NativeAnswer | undefined> {
  const runtime = currentRuntime();
  const epoch = runtime.humanEpoch;
  const controller = new AbortController();
  runtime.humanAbort = controller;
  const fingerprint = journalDigest(base);
  const current = () =>
    currentRuntime() === runtime &&
    runtime.humanEpoch === epoch &&
    !runtime.journalFault &&
    !ctx.hasPendingMessages() &&
    journalDigest(own(ctx)) === fingerprint;
  const presentation = readablePreflight(base, ids, start);
  try {
    return await requestNativeAnswer(
      ctx,
      {
        frame,
        kind: start ? "choice" : "authorization",
        purpose: start ? "first-start" : "authorization",
        ...presentation,
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
async function permission(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  selection?: string,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  let base = own(ctx);
  const ids = preflightPermissionSelection(base, selection);
  if (!base.proposal || !base.planId || !base.planDigest)
    throw new Error("No complete preflight proposal");
  if (!isTrustedLocalTui(ctx)) return result(ctx, base, "unsupported");
  base = prepareRequest(pi, ctx, base, "permission", ids);
  if (base.version !== 2 || !base.permissionRequest)
    throw new Error("No native permission request");
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
    preflightId: base.preflightId,
    planId: base.planId as string,
    planDigest: base.planDigest as string,
    permissionIds: ids,
    createdAt: new Date(answer.answeredAt).toISOString(),
    humanInteraction: frame,
    supersedes: base.permissionRequest.supersedes,
    ...(answer.outcome === "approve"
      ? { kind: "approve", answer: "Approve" }
      : { kind: "reject", answer: "Reject" }),
  };
  let proof: ConfirmedProof;
  try {
    proof = publishReadbackControl(pi, ctx, answer, frame, control);
  } catch (error) {
    persistenceFault();
    throw error;
  }
  const next = projectPreflightPermissions(base, control, proof.control.id);
  const status =
    control.kind === "reject"
      ? "rejected"
      : next.phase === "awaiting_authorization"
        ? "partial"
        : "approved";
  try {
    saveReadbackProjection(pi, ctx, proof, next);
    currentRuntime().preflight = structuredClone(next);
  } catch {
    retainPending(ctx, proof, next);
    return { ...saved(ctx, next, control, proof, status), projectionPending: true };
  }
  return saved(ctx, next, control, proof, status);
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
  const state = submitPreflight(pi, ctx, preflightId, proposal);
  if (before.revision === state.revision) return result(ctx, state, "already_saved");
  try {
    return await permission(pi, ctx, undefined, signal);
  } catch (error) {
    if (currentRuntime().journalFault) throw error;
    persistenceFault();
    throw error;
  }
}
export async function startApprovedPreflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planIdHint?: string,
  signal?: AbortSignal,
): Promise<PreflightHumanResult> {
  idle(ctx);
  let base = own(ctx);
  inspectPreflightStart(ctx, base.goal, planIdHint);
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
