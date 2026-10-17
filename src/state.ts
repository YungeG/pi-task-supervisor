import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LegacyTaskBoardSnapshot, TaskBoardSnapshot } from "./types";
import { CUSTOM_EVENT_TYPE, CUSTOM_SNAPSHOT_TYPE, LEGACY_CUSTOM_SNAPSHOT_TYPE } from "./types";
import { createEmptyBoard } from "./engine";
import {
  cloneBoard,
  getStatusCounts,
  isValidLegacySnapshot,
  isValidSnapshotV2,
} from "./validation";
import { phaseLabel } from "./formatting";
import { TASK_WIDGET_KEY, updateTaskWidget } from "./board-ui";
import { captureUiSummary } from "./ui-capture";
import { formatStatusbar } from "./status-ui";

import { currentRuntime } from "./runtime";

// ── State Accessors ──

/** Returns a deep copy of the current board. */
export function getBoard(): TaskBoardSnapshot {
  return cloneBoard(currentRuntime().board);
}

/** Replaces the board state with a deep copy. */
export function setBoard(newBoard: TaskBoardSnapshot): void {
  currentRuntime().board = cloneBoard(newBoard);
}

/** Returns a readonly reference to the current board (no clone — caller must not mutate). */
export function getBoardRef(): Readonly<TaskBoardSnapshot> {
  return currentRuntime().board;
}

/** Resets all mutable state. For testing only. */
export function resetState(): void {
  currentRuntime().board = createEmptyBoard();
  currentRuntime().supervisor = undefined;
  currentRuntime().receiptStore = undefined;
  currentRuntime().receiptIdentity = undefined;
  currentRuntime().preflight = undefined;
  currentRuntime().journalFault = undefined;
  currentRuntime().preflightRepair = undefined;
  currentRuntime().boardRepair = undefined;
  currentRuntime().manualPauseDepth = 0;
  currentRuntime().boardHumanContext = undefined;
  currentRuntime().humanEpoch++;
  currentRuntime().humanAbort?.abort();
  currentRuntime().humanAbort = undefined;
}

// ── State Reconstruction ──

function migrateLegacySnapshot(snapshot: LegacyTaskBoardSnapshot): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 1,
    workflowStatus: "inactive",
    tasks: structuredClone(snapshot.tasks),
    phases: structuredClone(snapshot.phases),
    pendingPhasePrompt: snapshot.pendingPhasePrompt
      ? structuredClone(snapshot.pendingPhasePrompt)
      : undefined,
    stagnantSettles: 0,
  };
}

/**
 * Reconstructs board state from session history.
 * Reads local version-2 snapshots and one-way migrates pinned upstream version-1 snapshots.
 * Empty history is inactive; recognized but invalid snapshots fail closed.
 */
export function reconstructState(ctx: ExtensionContext): TaskBoardSnapshot {
  const branch = ctx.sessionManager.getBranch();
  let latestV2: TaskBoardSnapshot | undefined;
  let latestLegacy: LegacyTaskBoardSnapshot | undefined;

  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    const customType = (entry as { customType?: string }).customType;
    const data = (entry as { data?: unknown }).data;
    if (customType === LEGACY_CUSTOM_SNAPSHOT_TYPE) {
      if (latestV2 || !isValidLegacySnapshot(data))
        throw new Error("Invalid or downgraded board snapshot");
      latestLegacy = structuredClone(data);
      continue;
    }
    if (customType !== CUSTOM_SNAPSHOT_TYPE) continue;
    if (!isValidSnapshotV2(data)) throw new Error("Invalid or unknown-version board snapshot");
    if (latestV2 && data.generation <= latestV2.generation)
      throw new Error("Non-monotonic board snapshot");
    latestV2 = cloneBoard(data);
  }

  if (latestV2) return latestV2;
  return latestLegacy ? migrateLegacySnapshot(latestLegacy) : createEmptyBoard();
}

// ── Persistence Helpers ──

/** Append both an event and a snapshot entry. */
export function persistEntries(
  pi: ExtensionAPI,
  event: unknown,
  snapshot: TaskBoardSnapshot,
): void {
  pi.appendEntry(CUSTOM_EVENT_TYPE, event);
  pi.appendEntry(CUSTOM_SNAPSHOT_TYPE, snapshot);
}

// ── UI Sync ──

/** Optional view refresh must not turn a saved result into an owner failure. */
export function refreshUI(ctx: ExtensionContext): void {
  try {
    updateUI(ctx, getBoardRef());
  } catch {
    // The original structured carrier/owner result remains authoritative.
  }
}

/** Updates the persistent task widget and existing status bar. */
export function updateUI(ctx: ExtensionContext, snapshot: Readonly<TaskBoardSnapshot>): void {
  if (!ctx.hasUI) return;
  if (ctx.mode === "tui") {
    try {
      const summary = captureUiSummary(ctx, snapshot);
      updateTaskWidget(ctx, snapshot, summary);
      ctx.ui.setStatus("til-done-active", undefined);
      ctx.ui.setStatus("continuous-supervisor", undefined);
      ctx.ui.setStatus("til-done", formatStatusbar(summary));
    } catch {
      // Capture/transport is optional; never turn it into a durable journal fault.
      for (const key of ["til-done", "til-done-active", "continuous-supervisor"]) {
        try {
          ctx.ui.setStatus(key, undefined);
        } catch {
          // Attempt the remaining owned keys even if one transport call fails.
        }
      }
      try {
        ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
      } catch {
        // The original owner/carrier result remains authoritative.
      }
    }
    return;
  }

  if (snapshot.tasks.length === 0) {
    ctx.ui.setStatus("til-done", undefined);
    ctx.ui.setStatus("til-done-active", undefined);
    return;
  }

  const counts = getStatusCounts(snapshot);

  const done = counts.done + counts.abandoned;
  const total = snapshot.tasks.length;

  const activePhase = snapshot.phases.find((p) => p.status === "active");
  const label = activePhase ? phaseLabel(snapshot, activePhase.phase) : "No active phase";

  ctx.ui.setStatus("til-done", `${done}/${total} - ${label}`);

  const activeLines: string[] = [];
  for (const t of snapshot.tasks) {
    if (t.status === "implementing" || t.status === "reviewing") {
      activeLines.push(`[${t.id}] ${t.title}`);
    }
  }
  ctx.ui.setStatus("til-done-active", activeLines.length > 0 ? activeLines.join("\n") : undefined);
}
