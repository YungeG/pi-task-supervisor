import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  inspectSessionJournal,
  findReadbackProof,
  type JournalNode,
  type SessionJournal,
} from "./human-journal";
import { sessionJournalView } from "./human-control";
import { readGoalJournal, resolveGoalSource, sourceBoard } from "./goal-journal";
import { decodeSupervisorEntry, type SupervisorState } from "./supervisor";
import { isGoalRecord, isGoalCarrier, scopeEqual, type GoalArchive } from "./goal-records";
import type { TaskBoardSnapshot } from "./types";
import type { PreflightState } from "./preflight";

export interface GoalHistorySummary {
  goalKey: string;
  goal: string;
  phase: string;
  archiveEntryId: string;
  boardWasRecorded: boolean;
  counts: { total: number; done: number; abandoned: number; unfinished: number };
  usage: Pick<SupervisorState, "reviews" | "continuations" | "stagnant" | "tokens" | "cost"> | null;
  receiptCount: number;
}
export interface GoalHistoryResponse {
  kind: "board" | "permission" | "start";
  controlEntryId?: string;
  status: "confirmed-readback" | "legacy-record-only" | "unknown";
  request?: unknown;
  record?: unknown;
  reason?: string;
}
export interface GoalHistoryItem extends GoalHistorySummary {
  board: TaskBoardSnapshot;
  preflight: PreflightState | null;
  /** Projection metadata only: no old raw receipt bodies are copied into a history page. */
  supervisor: Omit<SupervisorState, "receipts"> | null;
  responses: GoalHistoryResponse[];
}
export interface GoalHistoryPage<T = GoalHistorySummary> {
  items: T[];
  nextCursor?: string;
}
type Selected = {
  journal: SessionJournal;
  archive: GoalArchive;
  board: TaskBoardSnapshot;
  supervisor: ReturnType<typeof decodeSupervisorEntry> | null;
  preflight: PreflightState | null;
};
function windowFor(journal: SessionJournal, archive: GoalArchive): SessionJournal {
  const index = journal.branch.findIndex((node) => node.id === archive.commitEntryId);
  if (index < 0) throw new Error("History archive boundary missing");
  return { ...journal, branch: journal.branch.slice(0, index + 1) };
}
function select(ctx: ExtensionContext, journal: SessionJournal, archive: GoalArchive): Selected {
  const view = windowFor(journal, archive);
  const source = archive.source;
  const board = sourceBoard(ctx, view, source);
  const raw = source.supervisor ? resolveGoalSource(ctx, view, source.supervisor) : null;
  const supervisor = raw ? decodeSupervisorEntry(raw) : null;
  const preflight = source.preflight
    ? (resolveGoalSource(ctx, view, source.preflight) as PreflightState)
    : null;
  return { journal: view, archive, board, supervisor, preflight };
}
function receiptCount(supervisor: Selected["supervisor"]): number {
  return (
    supervisor?.ledger?.receiptCount ??
    supervisor?.v2?.count ??
    supervisor?.state.receipts.length ??
    0
  );
}
function summary(selected: Selected): GoalHistorySummary {
  const { archive, board, supervisor } = selected;
  let goal = "未记录监督目标";
  let phase = "legacy-board";
  if (supervisor) {
    goal = supervisor.state.goal;
    phase = supervisor.state.status;
  } else if (archive.source.scope) {
    const seed = selected.journal.branch.find(
      (node) => node.id === archive.source.scope?.lifecycleCommitId,
    )?.data;
    if (!isGoalRecord(seed) || seed.kind !== "transition-committed")
      throw new Error("History lifecycle seed missing");
    goal = seed.seed.goal;
    phase = "stopped";
  }
  const state = supervisor?.state;
  const done = board.tasks.filter((task) => task.status === "done").length;
  const abandoned = board.tasks.filter((task) => task.status === "abandoned").length;
  return {
    goalKey: archive.goalKey,
    goal,
    phase,
    archiveEntryId: archive.commitEntryId,
    boardWasRecorded: archive.source.board !== null,
    counts: {
      total: board.tasks.length,
      done,
      abandoned,
      unfinished: board.tasks.length - done - abandoned,
    },
    usage: state
      ? {
          reviews: state.reviews,
          continuations: state.continuations,
          stagnant: state.stagnant,
          tokens: state.tokens,
          cost: state.cost,
        }
      : null,
    receiptCount: receiptCount(supervisor),
  };
}
function rawResponse(
  selected: Selected,
  node: JournalNode | undefined,
  kind: GoalHistoryResponse["kind"],
): GoalHistoryResponse {
  if (!node || !node.data || typeof node.data !== "object")
    return { kind, status: "unknown", reason: "Original control record missing or unretained" };
  const data = node.data;
  const frame =
    "humanInteraction" in data
      ? (data.humanInteraction as { owner?: "board" | "preflight"; requestId?: string })
      : undefined;
  if (!frame)
    return {
      kind,
      controlEntryId: node.id,
      status: "legacy-record-only",
      record: structuredClone(data),
    };
  if (!frame.requestId || (frame.owner !== "board" && frame.owner !== "preflight"))
    return { kind, status: "unknown", reason: "Original native frame unknown" };
  try {
    const proof = findReadbackProof(selected.journal, frame.owner, frame.requestId);
    if (proof.status !== "confirmed" || proof.control.id !== node.id)
      throw new Error("Unconfirmed historical control");
    const payload = isGoalCarrier(proof.base.data) ? proof.base.data.snapshot : proof.base.data;
    return {
      kind,
      controlEntryId: node.id,
      status: "confirmed-readback",
      request: structuredClone(payload),
      record: structuredClone(data),
    };
  } catch {
    return {
      kind,
      controlEntryId: node.id,
      status: "unknown",
      reason: "Historical readback not confirmed; no current authority inferred",
    };
  }
}
function boardResponse(selected: Selected): GoalHistoryResponse {
  const scope = selected.archive.source.scope;
  if (!scope)
    return {
      kind: "board",
      status: "unknown",
      reason:
        "Legacy history has no GoalRun scope; do not attach an arbitrary latest response to this goal",
    };
  const node = selected.journal.branch
    .filter((entry) => {
      const data = entry.data;
      if (
        entry.customType !== "continuous-tasks:event" ||
        !data ||
        typeof data !== "object" ||
        !("humanInteraction" in data)
      )
        return false;
      const frame = data.humanInteraction as { owner?: string; baseSnapshotEntryId?: string };
      const base = frame.baseSnapshotEntryId
        ? selected.journal.nodes.get(frame.baseSnapshotEntryId)?.data
        : undefined;
      return frame.owner === "board" && isGoalCarrier(base) && scopeEqual(base, scope);
    })
    .at(-1);
  return rawResponse(selected, node, "board");
}
function responses(selected: Selected): GoalHistoryResponse[] {
  const state = selected.preflight;
  const permission = state?.approval?.controlEntryId;
  const start =
    state?.started && "controlEntryId" in state.started ? state.started.controlEntryId : undefined;
  return [
    boardResponse(selected),
    rawResponse(
      selected,
      selected.journal.branch.find((n) => n.id === permission),
      "permission",
    ),
    rawResponse(
      selected,
      selected.journal.branch.find((n) => n.id === start),
      "start",
    ),
  ];
}
function detail(selected: Selected): GoalHistoryItem {
  const state = selected.supervisor?.state;
  let supervisor: Omit<SupervisorState, "receipts"> | null = null;
  if (state) {
    const { receipts: bodies, ...metadata } = state;
    void bodies; // Deliberately omit historical raw receipts instead of copying them.
    supervisor = metadata;
  }
  return {
    ...summary(selected),
    board: structuredClone(selected.board),
    preflight: structuredClone(selected.preflight),
    supervisor: structuredClone(supervisor),
    responses: responses(selected),
  };
}
/** Index is bounded metadata; only an explicit goal ID materializes its one historical detail. */
export function readGoalHistory(ctx: ExtensionContext, cursor?: string): Readonly<GoalHistoryPage>;
export function readGoalHistory(
  ctx: ExtensionContext,
  cursor: string | undefined,
  goalRunId: string,
): Readonly<GoalHistoryPage<GoalHistoryItem>>;
export function readGoalHistory(
  ctx: ExtensionContext,
  cursor = "0",
  goalRunId?: string,
): Readonly<GoalHistoryPage<GoalHistorySummary | GoalHistoryItem>> {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const view = readGoalJournal(ctx, journal);
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid goal history cursor");
  const archives = [...(view?.archives ?? [])]
    .reverse()
    .filter((item) => !goalRunId || item.goalKey === goalRunId);
  const page = archives.slice(offset, offset + (goalRunId ? 1 : 10));
  const items = page.map((archive) => {
    const selected = select(ctx, journal, archive);
    return goalRunId ? detail(selected) : summary(selected);
  });
  return {
    items,
    ...(offset + page.length < archives.length ? { nextCursor: String(offset + page.length) } : {}),
  };
}
