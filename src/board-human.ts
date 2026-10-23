import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { RestoreJournalRead } from "./restore-journal";
import type { DecisionRecord, TaskBoardSnapshot } from "./types";
import { CUSTOM_SNAPSHOT_TYPE } from "./types";
import { cloneBoard, isValidSnapshotV2, isSafeBoundedText } from "./validation";
import { readableBoardRequest, boardMaterial } from "./human-presentation";
import { validDecisionSpec, validDecisionInformation } from "./decision-spec";
import { ownerSnapshot, selectedGoalEntries, goalLogicalScope } from "./goal-scope";
import { getBoardRef, setBoard, updateUI, reconstructState } from "./state";
import { currentRuntime, type ProjectionRepairHint } from "./runtime";
import {
  captureReadbackFrame,
  publishReadbackControl,
  saveReadbackProjection,
  sessionJournalView,
  inspectRestorableSession,
} from "./human-control";
import {
  requestNativeAnswer,
  isTrustedLocalTui,
  type NativeAnswer,
  type NativeQuestion,
} from "./human-ui";
import {
  inspectSessionJournal,
  findReadbackProof,
  journalDigest,
  type ReadbackProof,
} from "./human-journal";

type ConfirmedProof = Extract<ReadbackProof, { status: "confirmed" }>;
export interface SavedBoardAnswer {
  request: DecisionRecord;
  outcome: NativeAnswer["outcome"];
  value: string;
  controlEntryId: string;
}
export interface BoardHumanResult {
  status: "approved" | "answered" | "rejected" | "deferred" | "legacy" | "unsupported";
  confirmed?: SavedBoardAnswer;
  projectionPending?: boolean;
}
export function decisionScope(decision: DecisionRecord): unknown {
  return goalLogicalScope({
    id: decision.id,
    taskId: decision.taskId,
    question: decision.question,
    whyUserOwned: decision.whyUserOwned,
    spec: decision.spec,
    options: decision.options,
    supersedes: decision.supersedes,
  });
}
export function canReplaceBoardDecision(
  board: Readonly<TaskBoardSnapshot>,
  input: { action?: unknown; taskId?: unknown; decision?: unknown },
): boolean {
  const proposal = input.decision;
  if (
    board.workflowStatus !== "waiting_for_decision" ||
    !board.decision ||
    input.action !== "wait_for_decision" ||
    input.taskId !== board.decision.taskId
  )
    return false;
  return Boolean(
    proposal &&
    typeof proposal === "object" &&
    "supersedes" in proposal &&
    proposal.supersedes === board.decision.id &&
    "spec" in proposal &&
    validDecisionSpec(proposal.spec),
  );
}
function validateOutcome(decision: DecisionRecord, data: Record<string, unknown>): void {
  const spec = decision.spec;
  if (!spec || !validDecisionSpec(spec)) throw new Error("Invalid board human control");
  if (spec.kind === "authorization") {
    if (data.outcome !== "approve" && data.outcome !== "reject")
      throw new Error("Authorization needs an explicit outcome");
    return;
  }
  if (data.outcome !== "answer") throw new Error("Information is not authorization");
  if (spec.kind === "choice" && !decision.options?.includes(String(data.answer)))
    throw new Error("Unknown decision option");
  if (spec.kind === "information" && !validDecisionInformation(spec, String(data.answer)))
    throw new Error("Invalid information answer");
}
export function projectBoardAnswer(
  base: TaskBoardSnapshot,
  data: Record<string, unknown>,
): TaskBoardSnapshot {
  const decision = base.decision;
  if (
    base.workflowStatus !== "waiting_for_decision" ||
    !decision ||
    decision.response ||
    data.id !== decision.id ||
    !isSafeBoundedText(data.answer, 1000)
  )
    throw new Error("Invalid board human control");
  validateOutcome(decision, data);
  const next = cloneBoard(base);
  if (data.outcome === "reject") next.decision = { ...decision, response: "rejected" };
  else {
    next.decision = undefined;
    next.workflowStatus = "active";
  }
  next.generation++;
  next.stagnantSettles = 0;
  return next;
}
function questionFor(decision: DecisionRecord, frame: NativeQuestion["frame"]): NativeQuestion {
  const spec = decision.spec;
  if (!spec) throw new Error("Legacy decision needs a structured replacement");
  return {
    frame,
    kind: spec.kind,
    ...readableBoardRequest(decision),
    material: boardMaterial(decision),
    purpose: spec.kind === "choice" ? "business-choice" : spec.kind,
    ...(spec.kind === "information" ? { informationFormat: spec.format } : {}),
    options: decision.options,
    informationValidator: (value) => validDecisionInformation(spec, value),
  };
}
async function presentDecision(
  ctx: ExtensionContext,
  question: NativeQuestion,
  base: TaskBoardSnapshot,
  signal?: AbortSignal,
): Promise<NativeAnswer | undefined> {
  const runtime = currentRuntime();
  const epoch = runtime.humanEpoch;
  const current = () =>
    currentRuntime() === runtime &&
    runtime.humanEpoch === epoch &&
    !runtime.journalFault &&
    !ctx.hasPendingMessages() &&
    journalDigest(getBoardRef()) === journalDigest(base);
  const controller = new AbortController();
  runtime.humanAbort = controller;
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    return await requestNativeAnswer(ctx, question, current, combined);
  } finally {
    if (runtime.humanAbort === controller) runtime.humanAbort = undefined;
  }
}
function rememberAnswer(ctx: ExtensionContext, confirmed: SavedBoardAnswer): void {
  currentRuntime().boardHumanContext = {
    sessionId: ctx.sessionManager.getSessionId(),
    content: `Confirmed human decision (saved, not task acceptance; other gates still apply): ${JSON.stringify(confirmed)}`,
  };
}
export function boardHumanContext(ctx: ExtensionContext): string | undefined {
  const cached = currentRuntime().boardHumanContext;
  return cached?.sessionId === ctx.sessionManager.getSessionId() ? cached.content : undefined;
}
export async function answerBoardDecision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<BoardHumanResult> {
  if (currentRuntime().journalFault) throw new Error(currentRuntime().journalFault);
  const base = cloneBoard(getBoardRef());
  const decision = base.decision;
  if (base.workflowStatus !== "waiting_for_decision" || !decision)
    throw new Error("No decision is waiting");
  if (!decision.spec || !validDecisionSpec(decision.spec)) return { status: "legacy" };
  if (decision.response === "rejected") return { status: "rejected" };
  if (!isTrustedLocalTui(ctx)) return { status: "unsupported" };
  const frame = captureReadbackFrame(ctx, "board", decision.id, decisionScope(decision), base);
  const answer = await presentDecision(ctx, questionFor(decision, frame), base, signal);
  if (!answer) return { status: "deferred" };
  const control = {
    type: "resolve_decision",
    id: decision.id,
    outcome: answer.outcome,
    answer: answer.value ?? (answer.outcome === "approve" ? "批准上述范围" : "不批准上述范围"),
  };
  const next = projectBoardAnswer(base, control);
  let proof: ConfirmedProof;
  try {
    proof = publishReadbackControl(pi, ctx, answer, frame, control);
  } catch (error) {
    currentRuntime().journalFault =
      "Human decision persistence failed; inspect the control and witness before explicit repair";
    throw error;
  }
  const confirmed: SavedBoardAnswer = {
    request: structuredClone(decision),
    outcome: answer.outcome,
    value: control.answer,
    controlEntryId: proof.control.id,
  };
  const result: BoardHumanResult = {
    status:
      answer.outcome === "approve"
        ? "approved"
        : answer.outcome === "reject"
          ? "rejected"
          : "answered",
    confirmed,
  };
  rememberAnswer(ctx, confirmed);
  try {
    saveReadbackProjection(pi, ctx, proof, next);
    setBoard(next);
    updateUI(ctx, next);
  } catch {
    retainBoardProjection(ctx, proof, next);
    result.projectionPending = true;
  }
  return result;
}
function verifiedProjection(proof: ConfirmedProof): {
  projected: TaskBoardSnapshot;
  confirmed: SavedBoardAnswer;
} {
  const base = ownerSnapshot(proof.base.data);
  if (proof.base.customType !== CUSTOM_SNAPSHOT_TYPE || !isValidSnapshotV2(base))
    throw new Error("Invalid board projection base");
  if (!base.decision || proof.frame.scopeDigest !== journalDigest(decisionScope(base.decision)))
    throw new Error("Board decision scope mismatch");
  const control = proof.control.data as Record<string, unknown>;
  return {
    projected: projectBoardAnswer(base, control),
    confirmed: {
      request: structuredClone(base.decision),
      outcome: control.outcome as NativeAnswer["outcome"],
      value: String(control.answer),
      controlEntryId: proof.control.id,
    },
  };
}
/** Historical material only: never restores a projection or establishes current authority. */
export function readBoardHumanPresentation(
  ctx: ExtensionContext,
):
  | { status: "available"; confirmed: SavedBoardAnswer }
  | { status: "absent" }
  | { status: "unknown"; reason: string } {
  try {
    const persisted = inspectRestorableSession(ctx);
    const branch = persisted
      ? selectedGoalEntries(persisted.branch)
      : selectedGoalEntries(ctx.sessionManager.getBranch());
    const controls = branch.filter(
      (node) =>
        node.type === "custom" &&
        node.customType === "continuous-tasks:event" &&
        node.data &&
        typeof node.data === "object" &&
        "humanInteraction" in node.data,
    );
    if (!controls.length) return { status: "absent" };
    const journal = persisted ?? inspectSessionJournal(sessionJournalView(ctx));
    let latest: SavedBoardAnswer | undefined;
    for (const node of controls) {
      if (!("data" in node)) throw new Error("Invalid board control");
      const frame = (node.data as { humanInteraction: { owner?: string; requestId?: string } })
        .humanInteraction;
      if (frame.owner !== "board" || typeof frame.requestId !== "string")
        throw new Error("Invalid board control frame");
      const proof = findReadbackProof(journal, "board", frame.requestId);
      if (proof.status !== "confirmed") throw new Error("Unconfirmed board control");
      latest = verifiedProjection(proof).confirmed;
    }
    return latest
      ? { status: "available", confirmed: structuredClone(latest) }
      : { status: "absent" };
  } catch {
    return { status: "unknown", reason: "历史回应未核验：文件、分支或原 owner 证明需要检查。" };
  }
}

/** Restore confirmed results into the derived view without ever dispatching Main. */
export function restoreBoardHuman(
  ctx: ExtensionContext,
  board: TaskBoardSnapshot,
  restoration?: RestoreJournalRead,
): TaskBoardSnapshot {
  currentRuntime().boardHumanContext = undefined;
  currentRuntime().boardRepair = undefined;
  const persisted = restoration ? restoration.inspect(ctx) : inspectRestorableSession(ctx);
  const controls = selectedGoalEntries(ctx.sessionManager.getBranch()).filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "continuous-tasks:event" &&
      entry.data &&
      typeof entry.data === "object" &&
      "humanInteraction" in entry.data,
  );
  if (!controls.length) return board;
  const journal = persisted ?? inspectSessionJournal(sessionJournalView(ctx));
  let result = board;
  for (const node of selectedGoalEntries(journal.branch)) {
    if (
      node.customType !== "continuous-tasks:event" ||
      !node.data ||
      typeof node.data !== "object" ||
      !("humanInteraction" in node.data)
    )
      continue;
    const frame = node.data.humanInteraction as { owner?: string; requestId?: string };
    if (frame.owner !== "board" || typeof frame.requestId !== "string")
      throw new Error("Invalid board control frame");
    const proof = findReadbackProof(journal, "board", frame.requestId);
    if (proof.status !== "confirmed")
      throw new Error("Unconfirmed human control; explicit inspection is required");
    const { projected, confirmed } = verifiedProjection(proof);
    result = restoreProjection(ctx, proof, projected, result);
    rememberAnswer(ctx, confirmed);
  }
  return result;
}
function restoreProjection(
  ctx: ExtensionContext,
  proof: ConfirmedProof,
  projected: TaskBoardSnapshot,
  board: TaskBoardSnapshot,
): TaskBoardSnapshot {
  if (board.generation > projected.generation) return board;
  if (board.generation === projected.generation) {
    if (journalDigest(board) !== journalDigest(projected))
      throw new Error("Conflicting board projection");
    return board;
  }
  retainBoardProjection(ctx, proof, projected);
  return projected;
}
function retainBoardProjection(
  ctx: ExtensionContext,
  proof: ConfirmedProof,
  projected: TaskBoardSnapshot,
): void {
  const runtime = currentRuntime();
  const faultMessage =
    "Confirmed human result retained; derived board projection needs explicit repair";
  const ownsJournalFault = !runtime.journalFault;
  runtime.boardRepair = {
    sessionId: ctx.sessionManager.getSessionId(),
    controlEntryId: proof.control.id,
    projectedDigest: journalDigest(projected),
    faultMessage,
    ownsJournalFault,
  };
  if (ownsJournalFault) runtime.journalFault = faultMessage;
  runtime.cancel();
}

function verifiedBoardRepair(
  ctx: ExtensionContext,
  hint: ProjectionRepairHint,
): { proof: ConfirmedProof; projected: TaskBoardSnapshot } {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const node = journal.branch.find((n) => n.id === hint.controlEntryId);
  const frame =
    node?.data && typeof node.data === "object" && "humanInteraction" in node.data
      ? node.data.humanInteraction
      : undefined;
  if (
    !frame ||
    typeof frame !== "object" ||
    !("requestId" in frame) ||
    typeof frame.requestId !== "string"
  )
    throw new Error("Invalid board repair control");
  const proof = findReadbackProof(journal, "board", frame.requestId);
  if (proof.status !== "confirmed" || proof.control.id !== hint.controlEntryId)
    throw new Error("Unconfirmed board repair");
  const { projected } = verifiedProjection(proof);
  if (journalDigest(projected) !== hint.projectedDigest)
    throw new Error("Board repair authority changed");
  return { proof, projected };
}

/** Explicit cache repair only: no new answer, scope enable, budget reset or continuation. */
export function repairBoardProjection(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    throw new Error("Wait for Main and pending messages before repair");
  const runtime = currentRuntime();
  const hint = runtime.boardRepair;
  if (!hint || hint.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("No pending board projection repair");
  const oldFault = runtime.journalFault;
  const oldBoard = getBoardRef();
  const oldContext = runtime.boardHumanContext;
  try {
    const { proof, projected } = verifiedBoardRepair(ctx, hint);
    const view = restoreBoardHuman(ctx, reconstructState(ctx));
    const pending = runtime.boardRepair;
    if (pending) {
      if (
        pending.controlEntryId !== hint.controlEntryId ||
        pending.projectedDigest !== hint.projectedDigest
      )
        throw new Error("Board repair authority changed");
      saveReadbackProjection(pi, ctx, proof, projected);
    }
    setBoard(view);
    updateUI(ctx, view);
    runtime.boardRepair = undefined;
    runtime.journalFault =
      hint.ownsJournalFault && oldFault === hint.faultMessage ? undefined : oldFault;
  } catch (error) {
    setBoard(cloneBoard(oldBoard));
    runtime.boardHumanContext = oldContext;
    runtime.boardRepair = hint;
    runtime.journalFault = oldFault ?? hint.faultMessage;
    throw error;
  }
}
