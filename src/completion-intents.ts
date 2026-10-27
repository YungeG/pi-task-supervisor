import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdvanceEdit, CompletionEvidence, TaskBoardSnapshot } from "./types";
import type { ReviewVersionV1 } from "./final-review";
import { currentReviewArtifactVersion } from "./final-review";
import { currentRuntime } from "./runtime";
import { getBoardRef } from "./state";
import { completionEvidenceError } from "./validation";
import { digest, supervisorState, bindCompletion, completionBindingsFor } from "./supervisor";
import {
  appendControlFact,
  appendControlFence,
  captureControlLease,
  currentWorkOwner,
  readControlJournal,
  type WorkOwnerKey,
  executionOwnerSnapshot,
} from "./control-journal";
import { ownerBoardSnapshot } from "./execution-settlement";
import { inspectRestorableSession } from "./human-control";
import {
  invocationOwnerKey,
  type InvocationReference,
  type InvocationNodeV1,
} from "./invocation-tree";
import { attestManagedReceipt } from "./invocation-runtime";
import { qualifiedEvidence } from "./qualified-evidence";

export interface CompletionIntentV1 {
  version: 1;
  kind: "completion-intent-queued";
  recordId: string;
  owner: WorkOwnerKey;
  intentId: string;
  taskId: string;
  taskDigest: string;
  operationId: string;
  rootId: string;
  snapshotRef: InvocationReference;
  evidence: CompletionEvidence;
  receipts: Array<{ id: string; digest: string; ref: InvocationReference }>;
  candidateVersion: ReviewVersionV1;
  queuedAt: number;
}
export interface CompletionDispositionV1 {
  version: 1;
  kind: "completion-intent-disposed";
  recordId: string;
  owner: WorkOwnerKey;
  intentId: string;
  intentRef: InvocationReference;
  outcome: "applied" | "invalidated";
  snapshotRef: InvocationReference | null;
  taskDigest: string | null;
  supervisorRef: InvocationReference | null;
  reason: string;
}
export interface CompletionIntentEntry {
  data: CompletionIntentV1;
  ref: InvocationReference;
  disposition?: { data: CompletionDispositionV1; ref: InvocationReference };
}
export interface DeferredCompletion {
  completionState: "deferred";
  intentIds: string[];
  rootIds: string[];
  snapshot: Readonly<TaskBoardSnapshot>;
}
function appendCompletion(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: CompletionIntentV1 | CompletionDispositionV1,
): InvocationReference {
  let view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("completion-intents-v1")) {
    appendControlFence(
      pi,
      ctx,
      [...new Set([...(view.latestFence?.data.features ?? []), "completion-intents-v1" as const])],
      captureControlLease(ctx),
    );
    view = readControlJournal(ctx);
  }
  currentRuntime().controlJournal = view;
  const recorded = appendControlFact(pi, ctx, data);
  currentRuntime().controlJournal = readControlJournal(ctx);
  return { entryId: recorded.entryId, digest: recorded.digest };
}
function evidenceSources(
  ctx: ExtensionContext,
  evidence: CompletionEvidence,
  rootId: string,
  taskId: string,
  taskDigest: string,
): CompletionIntentV1["receipts"] {
  const graph = currentRuntime().controlJournal?.invocations,
    store = currentRuntime().receiptStore;
  const journal = inspectRestorableSession(ctx, true);
  return evidence.refs
    .filter((ref) => ref.status === "passed")
    .map((ref) => {
      const receipt = ref.ref ? store?.readReceipts([ref.ref])[0] : undefined;
      const node =
        receipt &&
        graph &&
        [...graph.nodes.values()].find(
          (item) => item.rootId === rootId && item.end?.receiptId === receipt.id,
        );
      if (
        !receipt ||
        !node?.end ||
        !receipt.ok ||
        receipt.exitCode !== 0 ||
        !receipt.reviews.some((review) => review.taskId === taskId && review.digest === taskDigest)
      )
        throw Error(
          "Deferred completion requires actual successful zero-exit review receipts from this root",
        );
      const source = journal?.branch.find(
        (item) =>
          item.receiptProof?.receipt?.id === receipt.id &&
          item.receiptProof.receipt.digest === receipt.digest,
      );
      if (!source) throw Error("Deferred completion receipt has no native source");
      return {
        id: receipt.id,
        digest: receipt.digest,
        ref: { entryId: source.id, digest: source.digest },
      };
    });
}
function prepareQueuedIntent(
  ctx: ExtensionContext,
  owner: WorkOwnerKey,
  invocation: InvocationNodeV1,
  board: Readonly<TaskBoardSnapshot>,
  version: ReviewVersionV1,
  edit: AdvanceEdit,
): CompletionIntentV1 | string {
  const task = board.tasks.find((candidate) => candidate.id === edit.id),
    evidence = edit.data?.evidence,
    error = completionEvidenceError(evidence);
  if (!task || error || !evidence) throw Error(error ?? "Deferred task/evidence missing");
  const existing = [...(currentRuntime().controlJournal?.completionIntents?.values() ?? [])].find(
    (entry) =>
      !entry.disposition &&
      entry.data.rootId === invocation.rootId &&
      entry.data.taskId === task.id,
  );
  if (existing) {
    if (
      digest(existing.data.evidence) !== digest(evidence) ||
      existing.data.taskDigest !== digest(task)
    )
      throw Error(
        "Pending completion intent conflicts; finish/invalidate it before a fresh validated request",
      );
    return existing.data.intentId;
  }
  return {
    version: 1,
    kind: "completion-intent-queued",
    recordId: randomUUID(),
    owner,
    intentId: randomUUID(),
    taskId: task.id,
    taskDigest: digest(task),
    operationId: invocation.operationId,
    rootId: invocation.rootId,
    snapshotRef: ownerBoardSnapshot(ctx, owner, board),
    evidence,
    receipts: evidenceSources(ctx, evidence, invocation.rootId, task.id, digest(task)),
    candidateVersion: version,
    queuedAt: Date.now(),
  };
}
/** Returns only for actual nested done requests; ordinary root-level completion stays immediate. */
export function queueCompletionIntents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  toolCallId: string,
  edits: AdvanceEdit[],
): DeferredCompletion | undefined {
  const live = currentRuntime().invocation?.live.get(toolCallId),
    graph = currentRuntime().controlJournal?.invocations;
  const invocation = live && graph?.nodes.get(live.operationId);
  if (!invocation || invocation.parentId === null) return undefined;
  const board = getBoardRef(),
    done = edits.filter(
      (edit) => board.tasks.find((task) => task.id === edit.id)?.status === "reviewing",
    );
  if (!done.length) return undefined;
  if (done.length !== edits.length)
    throw Error(
      "Split reviewing metadata from deferred done requests; no mixed partial transition",
    );
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId()),
    version = currentReviewArtifactVersion(ctx);
  if (!owner || invocationOwnerKey(owner) !== invocationOwnerKey(invocation.owner) || !version)
    throw Error("Deferred completion needs its actual current owner and known candidate version");
  // Validate the whole request before publishing any queued metadata.
  const prepared = done.map((edit) =>
      prepareQueuedIntent(ctx, owner, invocation, board, version, edit),
    ),
    intents: string[] = [];
  for (const item of prepared) {
    if (typeof item === "string") intents.push(item);
    else {
      appendCompletion(pi, ctx, item);
      intents.push(item.intentId);
    }
  }
  return {
    completionState: "deferred",
    intentIds: intents,
    rootIds: [invocation.rootId],
    snapshot: board,
  };
}
function disposition(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entry: CompletionIntentEntry,
  outcome: "applied" | "invalidated",
  reason: string,
): void {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!owner || invocationOwnerKey(owner) !== invocationOwnerKey(entry.data.owner))
    throw Error("Completion disposition belongs to a historical owner; no adoption");
  const board = getBoardRef(),
    task = board.tasks.find((item) => item.id === entry.data.taskId),
    journal = inspectRestorableSession(ctx, true);
  const supervisor =
    outcome === "applied" &&
    journal &&
    [...journal.branch]
      .reverse()
      .find(
        (node) =>
          node.supervisorProof?.sessionId === ctx.sessionManager.getSessionId() &&
          node.supervisorProof.goalKey === (owner.kind === "goal" ? owner.goal.goalKey : undefined),
      );
  appendCompletion(pi, ctx, {
    version: 1,
    kind: "completion-intent-disposed",
    recordId: randomUUID(),
    owner,
    intentId: entry.data.intentId,
    intentRef: entry.ref,
    outcome,
    snapshotRef: outcome === "applied" ? ownerBoardSnapshot(ctx, owner, board) : null,
    taskDigest: outcome === "applied" && task ? digest(task) : null,
    supervisorRef: supervisor ? { entryId: supervisor.id, digest: supervisor.digest } : null,
    reason,
  });
}
function repairEntry(ctx: ExtensionContext, intentId: string): CompletionIntentEntry | undefined {
  if (currentRuntime().journalFault || ctx.hasPendingMessages() || !ctx.isIdle())
    throw Error(
      "Completion metadata repair requires a confirmed quiet journal/current host; never ACK or replay",
    );
  currentRuntime().controlJournal = readControlJournal(ctx);
  if (currentRuntime().controlJournal?.invocations?.active.size)
    throw Error(
      "Actual invocation history remains active/unknown; metadata repair cannot release it",
    );
  const entry = currentRuntime().controlJournal?.completionIntents?.get(intentId),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!entry || !owner || invocationOwnerKey(owner) !== invocationOwnerKey(entry.data.owner))
    throw Error("Completion repair needs an actual intent in the current owner");
  if (entry.disposition?.data.outcome === "applied") return undefined;
  if (entry.disposition)
    throw Error("An invalidated intent cannot be reapplied; obtain a new actual validation");
  return entry;
}
export function repairCompletionMetadata(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  intentId: string,
): void {
  const entry = repairEntry(ctx, intentId);
  if (!entry) return;
  assertConfirmedDoneGroup(entry, ctx);
  const state = supervisorState();
  if (!state) throw Error("Original supervised completion owner is unavailable");
  const board = getBoardRef(),
    bindings = completionBindingsFor(board, [entry.data.taskId], state.bindings);
  if (digest(bindings) !== digest(state.bindings)) bindCompletion(pi, board, [entry.data.taskId]);
  disposition(
    pi,
    ctx,
    entry,
    "applied",
    "Confirmed done snapshot metadata repaired once; no business/check replay and no new freshness",
  );
  const runtime = currentRuntime().invocation;
  if (
    runtime?.attention ===
    "Confirmed deferred task snapshot needs same-group binding/disposition repair; do not advance or replay it"
  )
    runtime.attention = undefined;
}
function assertConfirmedDoneSnapshot(entry: CompletionIntentEntry, ctx: ExtensionContext): void {
  const data = entry.data,
    journal = inspectRestorableSession(ctx, true),
    source = journal?.nodes.get(data.snapshotRef.entryId);
  const before =
      source &&
      executionOwnerSnapshot(source.data, data.owner)?.tasks.find(
        (task) => task.id === data.taskId,
      ),
    task = getBoardRef().tasks.find((item) => item.id === data.taskId);
  if (
    !source ||
    source.digest !== data.snapshotRef.digest ||
    !before ||
    !task ||
    task.status !== "done" ||
    digest({
      ...before,
      status: "done",
      completionEvidence: data.evidence,
      updatedAt: task.updatedAt,
    }) !== digest(task)
  )
    throw Error(
      "Completion repair has no exact confirmed original done snapshot; no advance is run",
    );
  ownerBoardSnapshot(ctx, data.owner, getBoardRef());
}
function assertConfirmedDoneGroup(entry: CompletionIntentEntry, ctx: ExtensionContext): void {
  assertConfirmedDoneSnapshot(entry, ctx);
  const data = entry.data,
    graph = currentRuntime().controlJournal?.invocations;
  if (!graph) throw Error("Completion repair invocation history is unavailable");
  for (const source of data.receipts) {
    const qualified = [...graph.qualifications.values()].find(
      (item) =>
        item.data.receiptId === source.id &&
        item.data.taskId === data.taskId &&
        item.data.taskDigest === data.taskDigest,
    );
    if (!qualified || graph.nodes.get(qualified.data.operationId)?.rootId !== data.rootId)
      throw Error("Completion repair lacks its original sealed qualification history");
  }
}
function prepareDeferredEvidence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: CompletionIntentV1,
): void {
  const task = getBoardRef().tasks.find((item) => item.id === data.taskId);
  if (!task || task.status !== "reviewing" || digest(task) !== data.taskDigest)
    throw Error("Deferred completion task changed; original intent is not reapplied");
  for (const source of data.receipts)
    attestManagedReceipt(pi, ctx, data.rootId, source.id, data.taskId, data.taskDigest);
  const epoch = supervisorState()?.epoch;
  if (epoch === undefined) throw Error("Deferred completion has no current managed receipt epoch");
  for (const source of data.receipts) {
    const receipt = currentRuntime().receiptStore?.readReceipts([source.id])[0];
    if (!receipt || !qualifiedEvidence(receipt, data.taskId, data.taskDigest, epoch, ctx).eligible)
      throw Error(
        "Deferred evidence is stale/unknown; fresh validation is required without business replay",
      );
  }
}
export async function finalizeCompletionIntentsAtBoundary(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  commit: (edits: AdvanceEdit[]) => Promise<TaskBoardSnapshot>,
): Promise<void> {
  const entries = [...(currentRuntime().controlJournal?.completionIntents?.values() ?? [])].filter(
    (entry) => !entry.disposition,
  );
  for (const entry of entries) {
    const data = entry.data;
    try {
      prepareDeferredEvidence(pi, ctx, data);
      await commit([{ id: data.taskId, type: "advance", data: { evidence: data.evidence } }]);
      disposition(
        pi,
        ctx,
        entry,
        "applied",
        "Actual root quiescence and qualified original check committed once",
      );
    } catch (error) {
      if (currentRuntime().journalFault) throw error;
      if (getBoardRef().tasks.find((item) => item.id === data.taskId)?.status === "done") {
        const runtime = currentRuntime().invocation;
        if (runtime)
          runtime.attention =
            "Confirmed deferred task snapshot needs same-group binding/disposition repair; do not advance or replay it";
        throw error;
      }
      disposition(
        pi,
        ctx,
        entry,
        "invalidated",
        error instanceof Error ? error.message : "Deferred completion is unqualified",
      );
      throw error;
    }
  }
}
