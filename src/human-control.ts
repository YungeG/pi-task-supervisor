import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  inspectSessionJournal,
  findReadbackProof,
  journalDigest,
  JournalReadError,
  type ReadbackFrame,
  type ReadbackProof,
  type JournalNode,
} from "./human-journal";
import { requireNativeAnswer, type NativeAnswer } from "./human-ui";

export function sessionJournalView(ctx: ExtensionContext) {
  return {
    path: ctx.sessionManager.getSessionFile(),
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
  };
}

/** Existing durable ancestry is checked before any native-history/no-owner fast path. */
export function inspectRestorableSession(
  ctx: ExtensionContext,
): ReturnType<typeof inspectSessionJournal> | undefined {
  const view = sessionJournalView(ctx);
  if (!view.path) return undefined; // Explicit in-memory sessions cannot receive new recoverable approvals.
  try {
    lstatSync(view.path);
  } catch (error) {
    const missing =
      error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
    const conversation = ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
    if (missing && !conversation) return undefined; // Native setup-only sessions have not created a file yet.
    throw new JournalReadError("JOURNAL_UNAVAILABLE");
  }
  return inspectSessionJournal(view);
}

/** The owner supplies its exact current state, not a model-selected storage path. */
export function captureReadbackFrame(
  ctx: ExtensionContext,
  owner: ReadbackFrame["owner"],
  requestId: string,
  scope: unknown,
  state: unknown,
): ReadbackFrame {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const snapshotType =
    owner === "board" ? "continuous-tasks:snapshot" : "continuous-tasks:preflight";
  const stateDigest = journalDigest(state);
  const base = [...journal.branch]
    .reverse()
    .find(
      (node) =>
        node.type === "custom" &&
        node.customType === snapshotType &&
        journalDigest(node.data) === stateDigest,
    );
  if (!base) throw new JournalReadError("READBACK_INVALID");
  return {
    version: 1,
    owner,
    requestId,
    sessionId: journal.sessionId,
    presentationId: randomUUID(),
    scopeDigest: journalDigest(scope),
    baseSnapshotEntryId: base.id,
    baseSnapshotDigest: stateDigest,
  };
}

type ConfirmedProof = Extract<ReadbackProof, { status: "confirmed" }>;

function requireObservedAppend(
  ctx: ExtensionContext,
  customType: string,
  data: unknown,
): JournalNode {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const id = ctx.sessionManager.getLeafId();
  const node = id ? journal.nodes.get(id) : undefined;
  if (
    !node ||
    node.type !== "custom" ||
    node.customType !== customType ||
    journalDigest(node.data) !== journalDigest(data)
  )
    throw new JournalReadError("READBACK_INVALID");
  return node;
}

/**
 * Called only by trusted owner handlers after a native answer. This publishes bytes,
 * not permission state; the owner must derive/validate its own semantic control body.
 */
export function publishReadbackControl(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  answer: NativeAnswer,
  frame: ReadbackFrame,
  body: Record<string, unknown>,
): ConfirmedProof {
  requireNativeAnswer(ctx, answer, frame);
  const before = inspectSessionJournal(sessionJournalView(ctx));
  const previous = findReadbackProof(before, frame.owner, frame.requestId);
  if (previous.status !== "missing") throw new JournalReadError("READBACK_CONFLICT");
  const base = before.branch.find((node) => node.id === frame.baseSnapshotEntryId);
  if (!base || journalDigest(base.data) !== frame.baseSnapshotDigest)
    throw new JournalReadError("READBACK_INVALID");
  const controlType =
    frame.owner === "board" ? "continuous-tasks:event" : "continuous-tasks:preflight-control";
  const control = { ...body, humanInteraction: structuredClone(frame) };
  pi.appendEntry(controlType, control);
  const observed = requireObservedAppend(ctx, controlType, control);
  // No witness can be created when the original control append/readback failed.
  const witness = {
    version: 1,
    controlEntryId: observed.id,
    controlDigest: observed.digest,
    frame: structuredClone(frame),
  };
  pi.appendEntry("continuous-tasks:human-readback", witness);
  requireObservedAppend(ctx, "continuous-tasks:human-readback", witness);
  const proof = findReadbackProof(
    inspectSessionJournal(sessionJournalView(ctx)),
    frame.owner,
    frame.requestId,
  );
  if (proof.status !== "confirmed") throw new JournalReadError("READBACK_INVALID");
  return proof;
}

/** Projection remains a separate, non-authoritative cache write. */
export function saveReadbackProjection(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  proof: ConfirmedProof,
  snapshot: unknown,
): void {
  const checked = findReadbackProof(
    inspectSessionJournal(sessionJournalView(ctx)),
    proof.frame.owner,
    proof.frame.requestId,
  );
  if (
    checked.status !== "confirmed" ||
    checked.control.id !== proof.control.id ||
    checked.witness.id !== proof.witness.id ||
    journalDigest(checked.frame) !== journalDigest(proof.frame)
  )
    throw new JournalReadError("READBACK_INVALID");
  const kind =
    proof.frame.owner === "board" ? "continuous-tasks:snapshot" : "continuous-tasks:preflight";
  pi.appendEntry(kind, snapshot);
  requireObservedAppend(ctx, kind, snapshot);
}
