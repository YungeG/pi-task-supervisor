import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import {
  inspectSessionJournal,
  findReadbackProof,
  findGoalReadbackProof,
  journalDigest,
  JournalReadError,
  type ReadbackFrame,
  type ReadbackProof,
  type GoalReadbackFrame,
  type GoalReadbackProof,
  type NativeReadbackFrame,
  type JournalNode,
} from "./human-journal";
import { requireNativeAnswer, type NativeAnswer } from "./human-ui";
import {
  appendOwnerSnapshot,
  ownerSnapshot,
  requireCurrentCarrier,
  selectedGoalEntries,
} from "./goal-scope";

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
  immutable = false,
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
  return inspectSessionJournal(view, undefined, immutable);
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
  const base = [...selectedGoalEntries(journal.branch, owner)]
    .reverse()
    .find(
      (node) =>
        node.type === "custom" &&
        node.customType === snapshotType &&
        journalDigest(ownerSnapshot(node.data, owner)) === stateDigest,
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
    baseSnapshotDigest: journalDigest(base.data),
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
  requireCurrentCarrier(base.data, frame.owner);
  const controlType =
    frame.owner === "board" ? "continuous-tasks:event" : "continuous-tasks:preflight-control";
  const control = { ...body, humanInteraction: structuredClone(frame) };
  pi.appendEntry(controlType, control);
  const observed = requireObservedAppend(ctx, controlType, control);
  // No witness can be created when the original control append/readback failed.
  publishWitness(pi, ctx, observed, frame);
  const proof = findReadbackProof(
    inspectSessionJournal(sessionJournalView(ctx)),
    frame.owner,
    frame.requestId,
  );
  if (proof.status !== "confirmed") throw new JournalReadError("READBACK_INVALID");
  return proof;
}

function publishWitness(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  control: JournalNode,
  frame: NativeReadbackFrame,
): void {
  const witness = {
    version: 1,
    controlEntryId: control.id,
    controlDigest: control.digest,
    frame: structuredClone(frame),
  };
  pi.appendEntry("continuous-tasks:human-readback", witness);
  requireObservedAppend(ctx, "continuous-tasks:human-readback", witness);
}

/** Typed native consumers reuse the original physical witness producer only after
 * requireNativeAnswer admission; this helper alone does not confirm an answer. */
export { publishWitness as publishObservedNativeWitness };
export function captureGoalReadbackFrame(
  ctx: ExtensionContext,
  requestId: string,
  scope: unknown,
  baseEntryId: string,
): GoalReadbackFrame {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const base = journal.branch.find((node) => node.id === baseEntryId);
  if (
    !base ||
    base.type !== "custom" ||
    !["continuous-tasks:supervisor", "continuous-tasks:snapshot", "phased-tasks:snapshot"].includes(
      base.customType ?? "",
    )
  )
    throw new JournalReadError("READBACK_INVALID");
  return {
    version: 2,
    owner: "goal",
    sessionId: journal.sessionId,
    requestId,
    presentationId: randomUUID(),
    scopeDigest: journalDigest(scope),
    baseEntryId,
    baseEntryDigest: base.digest,
  };
}
/** A is also the old-reader version fence; B never exists without observed A. */
export function publishGoalReadbackControl(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  answer: NativeAnswer,
  frame: GoalReadbackFrame,
  body: Record<string, unknown>,
): Extract<GoalReadbackProof, { status: "confirmed" }> {
  requireNativeAnswer(ctx, answer, frame);
  const before = inspectSessionJournal(sessionJournalView(ctx));
  if (findGoalReadbackProof(before, frame.requestId).status !== "missing")
    throw new JournalReadError("READBACK_CONFLICT");
  const base = before.branch.find((node) => node.id === frame.baseEntryId);
  if (!base || base.digest !== frame.baseEntryDigest)
    throw new JournalReadError("READBACK_INVALID");
  const control = { ...body, humanInteraction: structuredClone(frame) };
  pi.appendEntry("continuous-tasks:supervisor", control);
  const observed = requireObservedAppend(ctx, "continuous-tasks:supervisor", control);
  publishWitness(pi, ctx, observed, frame);
  const proof = findGoalReadbackProof(
    inspectSessionJournal(sessionJournalView(ctx)),
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
  const stored = appendOwnerSnapshot(pi, kind, snapshot);
  requireObservedAppend(ctx, kind, stored);
}
