import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdvanceEdit, TaskBoardSnapshot, TaskWorkflowEvent } from "./types";
import { applyEdits } from "./engine";
import { loadConfig, resolvePhasePrompt } from "./config";
import { getBoardRef, persistTaskUpdate, refreshUI } from "./state";
import { goalLease } from "./goal-scope";
import { isSessionScopeEnabled } from "./scope";
import { assertObservedEvidence, assertReviewCapacity, bindCompletion } from "./supervisor";
import { currentRuntime } from "./runtime";

export async function checkAndSetPhaseCompletion(
  beforePhases: TaskBoardSnapshot["phases"],
  afterBoard: TaskBoardSnapshot,
): Promise<void> {
  for (const afterPhase of afterBoard.phases) {
    if (afterPhase.status !== "completed") continue;
    const beforePhase = beforePhases.find((phase) => phase.phase === afterPhase.phase);
    if (!beforePhase || beforePhase.status !== "completed") {
      const config = await loadConfig();
      const template = config.phaseCompletionPromptTemplate
        ? resolvePhasePrompt(config.phaseCompletionPromptTemplate, afterPhase.phase)
        : undefined;
      if (template) afterBoard.pendingPhasePrompt = { phase: afterPhase.phase, message: template };
      return;
    }
  }
}
export function assertBoardCurrent(
  board: Readonly<TaskBoardSnapshot>,
  signal: AbortSignal | undefined,
  enabled: boolean,
  lease: string,
): void {
  if (
    signal?.aborted ||
    goalLease() !== lease ||
    getBoardRef() !== board ||
    isSessionScopeEnabled() !== enabled
  )
    throw new Error("Task update cancelled; session or task board changed before commit");
}
function advanceEvent(
  edit: AdvanceEdit,
  before: TaskBoardSnapshot,
  after: TaskBoardSnapshot,
): TaskWorkflowEvent {
  const original = before.tasks.find((task) => task.id === edit.id),
    updated = after.tasks.find((task) => task.id === edit.id);
  if (!original || !updated) throw new Error(`Task "${edit.id}" disappeared during advance`);
  if (original.status !== "implementing" && original.status !== "reviewing")
    throw new Error(`Task "${edit.id}" had invalid pre-advance status ${original.status}`);
  if (updated.status !== "reviewing" && updated.status !== "done")
    throw new Error(`Task "${edit.id}" had invalid post-advance status ${updated.status}`);
  return {
    type: "advance_task",
    id: edit.id,
    from: original.status,
    to: updated.status,
    evidence: edit.data?.evidence,
  };
}
function assertAdvanceEvidence(
  board: Readonly<TaskBoardSnapshot>,
  edits: readonly AdvanceEdit[],
  ctx: ExtensionContext,
): void {
  for (const edit of edits)
    if (board.tasks.find((task) => task.id === edit.id)?.status === "reviewing")
      assertObservedEvidence(edit.id, edit.data?.evidence, ctx);
}
/** The original persistence/binding path, shared by immediate and safe-boundary deferred completion. */
export async function commitTaskAdvance(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  edits: AdvanceEdit[],
  signal?: AbortSignal,
): Promise<TaskBoardSnapshot> {
  const board = getBoardRef(),
    enabled = isSessionScopeEnabled(),
    lease = goalLease(),
    humanEpoch = currentRuntime().humanEpoch,
    manager = ctx.sessionManager;
  const ids = edits.map((edit) => edit.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate task ids in transitions");
  assertAdvanceEvidence(board, edits, ctx);
  const next = applyEdits(board, edits, new Date().toISOString());
  await checkAndSetPhaseCompletion(
    board.phases.map((phase) => ({ ...phase })),
    next,
  );
  assertBoardCurrent(board, signal, enabled, lease);
  if (currentRuntime().humanEpoch !== humanEpoch || ctx.sessionManager !== manager)
    throw new Error("Task advance control/manager changed before commit");
  // Reverify attested versions after asynchronous phase handling; preserve the old flat receipt IO path.
  if (currentRuntime().controlJournal?.invocations?.qualifications.size)
    assertAdvanceEvidence(board, edits, ctx);
  assertReviewCapacity(ctx, next, ids);
  persistTaskUpdate(
    pi,
    edits.map((edit) => advanceEvent(edit, board, next)),
    next,
    () => {
      bindCompletion(pi, next, ids);
    },
    ctx,
  );
  refreshUI(ctx);
  return next;
}
