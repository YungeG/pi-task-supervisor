import { randomUUID } from "node:crypto";
import { ProposeScopeRevisionParams } from "./scope-revision-schema";
import { ProposeContractParams } from "./acceptance-proposal";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  ToolExecutionEndEvent,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import {
  captureInvocationFrame as selectFrame,
  invocationCarrierCurrent as carrierCurrent,
  invocationFrameCurrent as frameCurrent,
  type InvocationFrame,
} from "./qualified-evidence";
import { getBoardRef } from "./state";
import { captureManagementSnapshot } from "./management-policy";
import { inspectRestorableSession } from "./human-control";
import { journalDigest } from "./human-journal";
import {
  appendControlFact,
  appendControlFence,
  captureControlLease,
  currentWorkOwner,
  readControlJournal,
  type InvocationFact,
  type WorkOwnerKey,
} from "./control-journal";
import { currentReviewArtifactVersion, type ReviewVersionV1 } from "./final-review";
import {
  codemodeCapability,
  invocationEffect,
  invocationParent,
  invocationSealIssue,
  assertInvocationCapacity,
  invocationValidationIssue,
  qualificationKey,
  type InvocationGraph,
  type InvocationNodeV1,
  type InvocationReference,
  type InvocationEndedV1,
  type InvocationRootSeal,
  directInvocationIssue,
  type InvocationRootIndex,
} from "./invocation-tree";
import type { HostReceipt } from "./receipt-store";
import {
  WriteTasksParams,
  EditTasksParams,
  CompileTasksParams,
  ClearTasksParams,
  GetReadyTasksParams,
  AdvanceTasksParams,
  WorkflowGateParams,
} from "./schemas";

interface ResultObservation {
  receiptId: string | null;
  receiptDigest: string | null;
  receiptRef: InvocationReference | null;
  exitCode: number | null;
  version: ReviewVersionV1 | null;
  isError: boolean;
  effects: "tool-only" | "unqualified";
  reasons: string[];
  uncertain: boolean;
}
interface LiveInvocation {
  operationId: string;
  rootId: string;
  frame: InvocationFrame;
  allowed: boolean;
}
export interface InvocationRuntime {
  live: Map<string, LiveInvocation>;
  results: Map<string, ResultObservation>;
  frames: Map<string, InvocationFrame>;
  attention?: string;
}
const metadataSchemas = new Map<string, unknown>([
  ["write_tasks", WriteTasksParams],
  ["edit_tasks", EditTasksParams],
  ["compile_tasks", CompileTasksParams],
  ["clear_tasks", ClearTasksParams],
  ["get_ready_tasks", GetReadyTasksParams],
  ["advance_tasks", AdvanceTasksParams],
  ["workflow_gate", WorkflowGateParams],
  ["propose_contract", ProposeContractParams],
  ["propose_scope_revision", ProposeScopeRevisionParams],
]);
function invocationRuntime(): InvocationRuntime {
  return (currentRuntime().invocation ??= {
    live: new Map(),
    results: new Map(),
    frames: new Map(),
  });
}
function currentGraph(): InvocationGraph | undefined {
  return currentRuntime().controlJournal?.invocations;
}
function metadataTool(tool: ToolInfo | undefined): boolean {
  return (
    !!tool && metadataSchemas.has(tool.name) && tool.parameters === metadataSchemas.get(tool.name)
  );
}
function appendInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: InvocationFact,
): InvocationReference {
  const required =
    data.kind === "invocation-root-sealed" && data.version === 2
      ? (["invocation-tree-v1", "invocation-direct-v1"] as const)
      : (["invocation-tree-v1"] as const);
  if (
    !required.every((feature) =>
      currentRuntime().controlJournal?.latestFence?.data.features.includes(feature),
    )
  ) {
    const view = readControlJournal(ctx);
    currentRuntime().controlJournal = view;
    if (!required.every((feature) => view.latestFence?.data.features.includes(feature)))
      appendControlFence(
        pi,
        ctx,
        [...new Set([...(view.latestFence?.data.features ?? []), ...required])],
        captureControlLease(ctx),
      );
  }
  // The cached feature is only an optimization hint: appendControlFact still checks actual
  // physical prefix + SDK mirror before/after and installs its freshly confirmed projection.
  const recorded = appendControlFact(pi, ctx, data);
  return { entryId: recorded.entryId, digest: recorded.digest };
}
function rootCallSource(ctx: ExtensionContext, event: ToolCallEvent): InvocationReference {
  const journal = inspectRestorableSession(ctx, true);
  const calls =
    journal?.branch.flatMap((node) =>
      (node.toolCalls ?? [])
        .filter((call) => call.id === event.toolCallId && call.name === event.toolName)
        .map((call) => ({ node, call })),
    ) ?? [];
  if (calls.length !== 1 || !calls[0])
    throw Error("Invocation root requires exactly one actual SDK assistant call source");
  return { entryId: calls[0].node.id, digest: calls[0].node.digest };
}
function managedInvocationOwner(
  ctx: ExtensionContext,
  event: ToolCallEvent,
): (WorkOwnerKey & { kind: "goal" }) | undefined {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (
    owner?.kind !== "goal" &&
    event.parentToolCallId !== undefined &&
    event.toolName === "advance_tasks" &&
    getBoardRef().tasks.some((task) => task.status === "reviewing")
  )
    throw Error(
      "Task-only container completion has no qualified original host check receipt on this SDK; no immediate done",
    );
  return owner?.kind === "goal" &&
    ctx.sessionManager.getSessionFile() &&
    captureManagementSnapshot(ctx).supervisorStatus === "active"
    ? owner
    : undefined;
}
function hostSupportsInvocation(pi: ExtensionAPI, event: ToolCallEvent): boolean {
  if (
    pi.getAllTools().some((tool) => tool.name === "codemode") ||
    currentRuntime().controlJournal?.latestFence?.data.features.includes("invocation-tree-v1")
  )
    return true;
  if (event.parentToolCallId !== undefined)
    throw Error("Nested invocation parent is unqualified on this host");
  return false;
}
function admissionFrame(
  ctx: ExtensionContext,
  owner: WorkOwnerKey,
  event: ToolCallEvent,
  graph: InvocationGraph,
  state: InvocationRuntime,
) {
  if (
    [...graph.active].some(
      (id) => graph.nodes.get(id)?.end || !state.frames.has(graph.nodes.get(id)?.rootId ?? ""),
    )
  )
    throw Error("Restored/unknown invocation is not current live SDK work; inspect without replay");
  const parent = invocationParent(graph, owner, event.parentToolCallId);
  assertInvocationCapacity(graph, parent);
  const frame = parent ? state.frames.get(parent.rootId) : selectFrame(ctx, owner);
  if (!frame || !frameCurrent(ctx, frame))
    throw Error("Invocation parent/frame is missing, historical or changed");
  return { parent, frame };
}
/** Called only after existing tool/management/permission gates, before original capture/business start. */
export function admitManagedInvocation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolCallEvent,
): void {
  const owner = managedInvocationOwner(ctx, event);
  if (!owner || !hostSupportsInvocation(pi, event)) return;
  const tool = pi.getAllTools().find((item) => item.name === event.toolName);
  if (event.parentToolCallId === undefined && metadataTool(tool)) return;
  const runtime = invocationRuntime();
  currentRuntime().controlJournal = readControlJournal(ctx);
  const graph = currentGraph();
  if (!graph) throw Error("Invocation graph source unavailable");
  const { parent, frame } = admissionFrame(ctx, owner, event, graph, runtime);
  const operationId = randomUUID(),
    rootId = parent ? parent.rootId : operationId,
    capability = codemodeCapability(tool) ?? null;
  appendInvocation(pi, ctx, {
    version: 1,
    kind: "invocation-started",
    recordId: randomUUID(),
    owner,
    operationId,
    toolCallId: event.toolCallId,
    parentId: parent?.operationId ?? null,
    rootId,
    sequence: graph.sequence + 1,
    toolName: event.toolName,
    effect: metadataTool(tool) ? "metadata" : invocationEffect(tool),
    capability,
    inputDigest: journalDigest(JSON.stringify(event.input)),
    sourceRef: parent ? null : rootCallSource(ctx, event),
    modeRef: frame.modeRef,
  });
  runtime.live.set(event.toolCallId, {
    operationId,
    rootId,
    frame,
    allowed: false,
  });
  if (!parent) runtime.frames.set(operationId, frame);
}
export function allowManagedInvocation(toolCallId: string): void {
  const live = currentRuntime().invocation?.live.get(toolCallId);
  if (live) live.allowed = true;
}
function receiptSource(
  ctx: ExtensionContext,
  receipt: HostReceipt | undefined,
): InvocationReference | null {
  if (!receipt) return null;
  const node = inspectRestorableSession(ctx, true)?.branch.find(
    (item) =>
      item.receiptProof?.receipt?.id === receipt.id &&
      item.receiptProof.receipt.digest === receipt.digest,
  );
  if (!node) throw Error("Invocation result is missing its actual original native receipt");
  return { entryId: node.id, digest: node.digest };
}
function resultEffects(
  ctx: ExtensionContext,
  event: ToolResultEvent,
  node: InvocationNodeV1,
  graph: InvocationGraph,
): string[] {
  if (node.parentId !== null) return [];
  if (node.toolName === "codemode") return containerResultEffects(ctx, event, node, graph);
  return [...graph.nodes.values()].some((child) => child.parentId === node.operationId)
    ? ["Direct SDK tool has unexplained descendants"]
    : [];
}
function containerResultEffects(
  ctx: ExtensionContext,
  event: ToolResultEvent,
  node: InvocationNodeV1,
  graph: InvocationGraph,
): string[] {
  const reasons: string[] = [];
  if (!node.capability) reasons.push("Container source or models API capability is unqualified");
  if (event.content.some((block) => block.type === "image"))
    reasons.push("Image/output file effect is outside the tool-only qualification");
  const details = event.details as
    | { calls?: Array<{ id?: string; name?: string; status?: string }>; fullOutputPath?: unknown }
    | undefined;
  if (details?.fullOutputPath !== undefined) reasons.push("Output spill effect is unqualified");
  const direct = [...graph.nodes.values()].filter((child) => child.parentId === node.operationId);
  if (
    !Array.isArray(details?.calls) ||
    details.calls.length !== direct.length ||
    details.calls.some(
      (call) =>
        !direct.some(
          (child) =>
            child.toolCallId === call.id &&
            child.toolName === call.name &&
            child.end?.outcome === "returned",
        ) || call.status !== "ok",
    )
  )
    reasons.push("Unexplained/failed/cancelled non-tool or descendant call");
  const journal = inspectRestorableSession(ctx, true),
    position = journal?.branch.findIndex((item) => item.id === node.start.ref.entryId) ?? -1;
  if (
    position < 0 ||
    journal?.branch.slice(position + 1).some((item) => item.customType === "codemode-store")
  )
    reasons.push("Store/journal effect or unknown root source");
  return reasons.slice(0, 8);
}
function capturedVersion(
  ctx: ExtensionContext,
  receipt: HostReceipt | undefined,
): ReviewVersionV1 | null {
  return receipt?.ok && receipt.exitCode === 0 && receipt.reviews.length
    ? (currentReviewArtifactVersion(ctx) ?? null)
    : null;
}
function cancelledSDKCall(event: ToolResultEvent, node: InvocationNodeV1): boolean {
  const calls = (event.details as { calls?: Array<{ status?: string }> } | undefined)?.calls;
  return (
    node.parentId === null &&
    Array.isArray(calls) &&
    calls.some((call) => call.status === "running" || call.status === "cancelled")
  );
}
function capturedResult(
  ctx: ExtensionContext,
  event: ToolResultEvent,
  receipt: HostReceipt | undefined,
  node: InvocationNodeV1,
  reasons: string[],
): ResultObservation {
  return {
    uncertain: cancelledSDKCall(event, node),
    receiptId: receipt?.id ?? null,
    receiptDigest: receipt?.digest ?? null,
    receiptRef: receiptSource(ctx, receipt),
    exitCode: receipt?.exitCode ?? null,
    version: capturedVersion(ctx, receipt),
    isError: event.isError,
    effects: reasons.length ? "unqualified" : "tool-only",
    reasons: reasons.slice(0, 8),
  };
}
export function observeManagedInvocationResult(
  ctx: ExtensionContext,
  event: ToolResultEvent,
  receipt: HostReceipt | undefined,
): void {
  const state = currentRuntime().invocation,
    live = state?.live.get(event.toolCallId),
    graph = currentGraph();
  if (!state || !live || !graph) return;
  const node = graph.nodes.get(live.operationId);
  if (!node) throw Error("Invocation result has no admitted node");
  const reasons = resultEffects(ctx, event, node, graph);
  if (!frameCurrent(ctx, live.frame)) reasons.push("Invocation control/owner frame changed");
  state.results.set(event.toolCallId, capturedResult(ctx, event, receipt, node, reasons));
}
function trimInvocationFrames(state: InvocationRuntime): void {
  const graph = currentGraph();
  const closed = [...state.frames.keys()].filter(
    (rootId) => graph?.nodes.get(rootId)?.end && !graph.active.has(rootId),
  );
  for (const rootId of closed.slice(0, Math.max(0, closed.length - 128)))
    state.frames.delete(rootId);
}
function kernelOutcome(
  ctx: ExtensionContext,
  live: LiveInvocation,
  node: InvocationNodeV1,
  graph: InvocationGraph,
  result: ResultObservation | undefined,
  event: ToolExecutionEndEvent,
): InvocationEndedV1["outcome"] {
  if (!live.allowed) return "error";
  const activeChildren = [...graph.active].some(
    (id) => graph.nodes.get(id)?.parentId === node.operationId,
  );
  if (
    !result ||
    result.uncertain ||
    activeChildren ||
    !frameCurrent(ctx, live.frame) ||
    ctx.signal?.aborted
  )
    return "unknown";
  return event.isError || result.isError ? "error" : "returned";
}
function kernelFact(
  owner: WorkOwnerKey,
  node: InvocationNodeV1,
  sequence: number,
  outcome: InvocationEndedV1["outcome"],
  result: ResultObservation | undefined,
): InvocationEndedV1 {
  return {
    version: 1,
    kind: "invocation-ended",
    recordId: randomUUID(),
    owner,
    operationId: node.operationId,
    sequence,
    outcome,
    receiptId: result?.receiptId ?? null,
    receiptDigest: result?.receiptDigest ?? null,
    receiptRef: result?.receiptRef ?? null,
    exitCode: result?.exitCode ?? null,
    effects: result?.effects ?? "unqualified",
    reasons: result?.reasons ?? ["Actual result observation is missing"],
    artifactVersion: result?.version ?? null,
  };
}
/** Kernel end is separate from tool_result; unknown/abort signals never become a quiet root. */
export function observeManagedInvocationEnd(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolExecutionEndEvent,
): void {
  const state = currentRuntime().invocation,
    live = state?.live.get(event.toolCallId),
    graph = currentGraph();
  if (!state || !live || !graph) return;
  if (!carrierCurrent(ctx, live.frame)) {
    state.attention =
      "Historical invocation end has no current owner carrier; no adoption or replay";
    return;
  }
  const node = graph.nodes.get(live.operationId),
    result = state.results.get(event.toolCallId);
  if (!node || node.end) return;
  const outcome = kernelOutcome(ctx, live, node, graph, result, event);
  appendInvocation(
    pi,
    ctx,
    kernelFact(live.frame.owner, node, graph.sequence + 1, outcome, result),
  );
  state.results.delete(event.toolCallId);
  state.live.delete(event.toolCallId);
  trimInvocationFrames(state);
}
function rootSealFact(
  frame: InvocationFrame,
  rootId: string,
  endRef: InvocationReference,
  index: InvocationRootIndex,
  messageRef: InvocationReference,
  version: ReviewVersionV1 | undefined,
  reason: string | undefined,
  direct: boolean,
): InvocationRootSeal {
  const common = {
    kind: "invocation-root-sealed" as const,
    recordId: randomUUID(),
    owner: frame.owner,
    rootId,
    endRef,
    messageRef,
    started: index.started,
    ended: index.ended,
    historyDigest: index.digest,
    epoch: currentRuntime().receiptStore?.epoch ?? 0,
    artifactVersion: version ?? null,
    reason:
      reason ??
      (direct
        ? "Actual direct SDK tool kernel-ended; validation still requires its original receipt"
        : "Actual SDK root and children kernel-ended with qualified tool-only effects"),
  };
  return direct
    ? { ...common, version: 2, rootKind: "direct", outcome: reason ? "held" : "observed" }
    : { ...common, version: 1, outcome: reason ? "held" : "qualified" };
}
function sealOneManagedRoot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rootId: string,
  frame: InvocationFrame,
): void {
  const graph = currentGraph();
  if (!graph) return;
  const root = graph.nodes.get(rootId),
    end = root?.end,
    index = graph.roots.get(rootId);
  if (!root || !end || !index || index.sealed || !frameCurrent(ctx, frame)) return;
  const message = inspectRestorableSession(ctx, true)?.branch.find(
    (node) =>
      node.toolResultProof?.id === root.toolCallId && node.toolResultProof.tool === root.toolName,
  );
  if (!message) return;
  const version = currentReviewArtifactVersion(ctx),
    direct = root.toolName !== "codemode",
    reason = direct
      ? directInvocationIssue(graph, rootId)
      : (invocationSealIssue(graph, rootId) ??
        (!version ? "Managed artifact scope/version is unknown" : undefined));
  appendInvocation(
    pi,
    ctx,
    rootSealFact(
      frame,
      rootId,
      end.ref,
      index,
      { entryId: message.id, digest: message.digest },
      version,
      reason,
      direct,
    ),
  );
}
export function sealManagedRootsAtBoundary(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = currentRuntime().invocation;
  if (!state) return;
  for (const [rootId, frame] of state.frames) sealOneManagedRoot(pi, ctx, rootId, frame);
}
function ensureAttestedFinalReviewFeature(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("final-review-v1"))
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "final-review-v1" as const])],
      captureControlLease(ctx),
    );
}
function originalValidationReceipt(
  receiptId: string,
  taskId: string,
  taskDigest: string,
): HostReceipt {
  const receipt = currentRuntime().receiptStore?.readReceipts([receiptId])[0];
  if (
    !receipt ||
    !receipt.ok ||
    receipt.exitCode !== 0 ||
    !receipt.reviews.some((review) => review.taskId === taskId && review.digest === taskDigest)
  )
    throw Error("Completion receipt is not an actual successful review check for this task");
  return receipt;
}
export function attestManagedReceipt(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  rootId: string,
  receiptId: string,
  taskId: string,
  taskDigest: string,
): InvocationReference {
  const graph = currentGraph(),
    frame = currentRuntime().invocation?.frames.get(rootId);
  if (!graph || !frame || !frameCurrent(ctx, frame))
    throw Error("Completion qualification has no current live host root frame");
  const existing = graph.qualifications.get(qualificationKey(frame.owner, receiptId, taskId));
  if (existing) return existing.ref;
  const node = [...graph.nodes.values()].find(
      (item) => item.rootId === rootId && item.end?.receiptId === receiptId,
    ),
    seal = graph.seals.get(rootId);
  if (!node?.end || !seal || seal.data.outcome !== "qualified" || !seal.data.artifactVersion)
    throw Error("Completion requires its actual qualified root seal and original receipt");
  const issue = invocationValidationIssue(graph, node.operationId);
  if (issue) throw Error(issue);
  const receipt = originalValidationReceipt(receiptId, taskId, taskDigest);
  if (getBoardRef().finalAcceptanceTaskId === taskId) ensureAttestedFinalReviewFeature(pi, ctx);
  return appendInvocation(pi, ctx, {
    version: 1,
    kind: "eligibility-attested",
    recordId: randomUUID(),
    owner: frame.owner,
    operationId: node.operationId,
    receiptId,
    receiptDigest: receipt.digest,
    rootSealRef: seal.ref,
    taskId,
    taskDigest,
    epoch: seal.data.epoch,
    artifactVersion: seal.data.artifactVersion,
    justification: "parent-only-overlap-v1",
  });
}
export function invocationActivityIssue(): string | undefined {
  const state = currentRuntime().invocation;
  if (state?.attention) return state.attention;
  return currentGraph()?.active.size
    ? "Actual invocation nodes remain active/unknown; inspect without replay"
    : undefined;
}
