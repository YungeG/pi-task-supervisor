import { describe, it, expect } from "vitest";
import {
  createEmptyBoard,
  applyEdits,
  claimReadyTasks,
  getStatusCounts,
  hasActionableTasks,
  hasBlockedNonTerminalTasks,
} from "../engine";
import type { TaskEdit } from "../types";
import { NOW, makeCompiledBoard } from "./helpers/engine-helpers";

function completeTask(id: string): TaskEdit {
  return {
    id,
    type: "advance",
    data: {
      evidence: {
        summary: "Reviewed and validated",
        refs: [
          {
            kind: "review",
            label: "test review",
            status: "passed",
            ref: "test://review",
          },
        ],
      },
    },
  };
}

// ═══════════════════════════════════════════
// 9. claimReadyTasks
// ═══════════════════════════════════════════

describe("claimReadyTasks", () => {
  it("claims up to count ready tasks", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
      { title: "C", prompt: "P", profile: "c", phase: 1 },
    ]);

    const result = claimReadyTasks(board, 2, NOW);
    expect(result.claimed).toHaveLength(2);
    expect(result.board.tasks[0]!.status).toBe("implementing");
    expect(result.board.tasks[1]!.status).toBe("implementing");
    expect(result.board.tasks[2]!.status).toBe("ready"); // not claimed
  });

  it("orders by phase ascending, then creation order", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 2 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
      { title: "C", prompt: "P", profile: "c", phase: 1 },
    ]);
    // Helper groups by phase and sorts: tasks become [B(t-1.1), C(t-1.2), A(t-2.1)]
    // Phase 1 is active. Phase 2 is pending.
    // Only phase 1 tasks are ready: B and C.
    // Phase 2 task A stays configured.
    expect(board.tasks[0]!.status).toBe("ready"); // B, phase 1, active
    expect(board.tasks[1]!.status).toBe("ready"); // C, phase 1, active
    expect(board.tasks[2]!.status).toBe("configured"); // A, phase 2, pending

    const result = claimReadyTasks(board, 5, NOW);
    expect(result.claimed).toHaveLength(2);
    expect(result.claimed[0]!.id).toBe("t-1.1"); // phase 1, created first
    expect(result.claimed[1]!.id).toBe("t-1.2"); // phase 1, created second
  });

  it("moves claimed tasks to implementing", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = claimReadyTasks(board, 1, NOW);
    expect(result.claimed[0]!.status).toBe("implementing");
    expect(result.board.tasks[0]!.status).toBe("implementing");
  });

  it("rejects if count < 1", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() => claimReadyTasks(board, 0, NOW)).toThrow(/count must be >= 1/);
    expect(() => claimReadyTasks(board, -1, NOW)).toThrow(/count must be >= 1/);
  });

  it("rejects if any task is implementing/reviewing", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    board = claimReadyTasks(board, 1, NOW).board;
    // t-1.1 is implementing, t-1.2 is ready
    expect(board.tasks[0]!.status).toBe("implementing");

    expect(() => claimReadyTasks(board, 1, NOW)).toThrow(
      /Cannot claim tasks while tasks are implementing or reviewing/,
    );
  });

  it("returns empty claimed array when no ready tasks exist", () => {
    // All done board — claimReadyTasks should return empty claimed.
    let doneBoard = makeCompiledBoard([{ title: "Only", prompt: "P", profile: "c", phase: 1 }]);
    doneBoard = claimReadyTasks(doneBoard, 1, NOW).board;
    doneBoard = applyEdits(doneBoard, [{ id: "t-1.1", type: "advance" }], NOW);
    doneBoard = applyEdits(doneBoard, [completeTask("t-1.1")], NOW);
    const finalResult = claimReadyTasks(doneBoard, 1, NOW);
    expect(finalResult.claimed).toEqual([]);
  });

  it("does not mutate the input board", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const frozen = JSON.parse(JSON.stringify(board));
    claimReadyTasks(board, 1, NOW);
    expect(board).toEqual(frozen);
  });

  it("updates updatedAt on claimed tasks", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const later = "2025-06-01T00:00:00.000Z";
    const result = claimReadyTasks(board, 1, later);
    expect(result.claimed[0]!.updatedAt).toBe(later);
    expect(result.board.tasks[0]!.updatedAt).toBe(later);
  });
});

// ═══════════════════════════════════════════
// 10. getStatusCounts
// ═══════════════════════════════════════════

describe("getStatusCounts", () => {
  it("returns all 7 statuses with correct counts", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    // Both ready after compile
    const counts = getStatusCounts(board);
    expect(counts.draft).toBe(0);
    expect(counts.configured).toBe(0);
    expect(counts.ready).toBe(2);
    expect(counts.implementing).toBe(0);
    expect(counts.reviewing).toBe(0);
    expect(counts.done).toBe(0);
    expect(counts.abandoned).toBe(0);
  });

  it("counts a mixed-status board correctly", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
      { title: "C", prompt: "P", profile: "c", phase: 1 },
    ]);
    // All 3 ready. Claim A, advance to done.
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-1.1")], NOW); // A done
    // B and C should now be ready (or already were)
    board = applyEdits(board, [{ id: "t-1.3", type: "abandon" }], NOW); // C abandoned

    const counts = getStatusCounts(board);
    expect(counts.draft).toBe(0);
    expect(counts.configured).toBe(0);
    expect(counts.ready).toBe(1); // B
    expect(counts.implementing).toBe(0);
    expect(counts.reviewing).toBe(0);
    expect(counts.done).toBe(1); // A
    expect(counts.abandoned).toBe(1); // C
  });

  it("returns zero-filled for empty board", () => {
    const board = createEmptyBoard();
    const counts = getStatusCounts(board);
    const allStatuses: Array<keyof typeof counts> = [
      "draft",
      "configured",
      "ready",
      "implementing",
      "reviewing",
      "done",
      "abandoned",
    ];
    for (const s of allStatuses) {
      expect(counts[s]).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════
// 12. Phase gating
// ═══════════════════════════════════════════

describe("Phase gating", () => {
  it("later phase tasks never become ready until earlier phase is terminal", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);

    // Phase 1 is active, A is ready. Phase 2 is pending, B is configured.
    expect(board.tasks[0]!.status).toBe("ready");
    expect(board.tasks[1]!.status).toBe("configured");
    expect(board.phases.find((p) => p.phase === 1)?.status).toBe("active");
    expect(board.phases.find((p) => p.phase === 2)?.status).toBe("pending");
  });

  it("activates next phase when active phase becomes terminal (all done)", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);

    // Phase 1 active, A ready. Claim and complete A.
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW); // → reviewing
    board = applyEdits(board, [completeTask("t-1.1")], NOW); // → done

    // Phase 1 completed, phase 2 activated. B should be ready.
    expect(board.tasks[0]!.status).toBe("done");
    expect(board.tasks[1]!.status).toBe("ready");
    expect(board.phases.find((p) => p.phase === 1)?.status).toBe("completed");
    expect(board.phases.find((p) => p.phase === 2)?.status).toBe("active");
  });

  it("activates next phase when active phase becomes terminal (all abandoned)", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);

    // Abandon A
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);

    // Phase 1 completed (all terminal), phase 2 activated
    expect(board.tasks[0]!.status).toBe("abandoned");
    expect(board.tasks[1]!.status).toBe("ready");
    expect(board.phases.find((p) => p.phase === 1)?.status).toBe("completed");
    expect(board.phases.find((p) => p.phase === 2)?.status).toBe("active");
  });

  it("activates next phase when active phase has mix of done and abandoned", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
      { title: "C", prompt: "P", profile: "c", phase: 2 },
    ]);

    // Claim and complete A
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-1.1")], NOW); // A done

    // B is ready. Abandon B.
    board = applyEdits(board, [{ id: "t-1.2", type: "abandon" }], NOW);

    // Phase 1 all terminal, phase 2 active, C ready
    expect(board.tasks[2]!.status).toBe("ready");
    expect(board.phases.find((p) => p.phase === 1)?.status).toBe("completed");
    expect(board.phases.find((p) => p.phase === 2)?.status).toBe("active");
  });

  it("handles 3-phase progression", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
      { title: "C", prompt: "P", profile: "c", phase: 3 },
    ]);

    // Phase 1 active
    expect(board.phases.find((p) => p.status === "active")?.phase ?? null).toBe(1);

    // Complete phase 1
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-1.1")], NOW);
    expect(board.phases.find((p) => p.status === "active")?.phase ?? null).toBe(2);
    expect(board.tasks[1]!.status).toBe("ready");

    // Complete phase 2
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-2.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-2.1")], NOW);
    expect(board.phases.find((p) => p.status === "active")?.phase ?? null).toBe(3);
    expect(board.tasks[2]!.status).toBe("ready");

    // Complete phase 3
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-3.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-3.1")], NOW);
    expect(board.phases.find((p) => p.status === "active")?.phase ?? null).toBeNull(); // all done
    expect(board.phases.every((p) => p.status === "completed")).toBe(true);
  });

  it("preserves completedAt for previously completed phases", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);

    const phase1Time = "2025-03-15T12:00:00.000Z";

    // Complete phase 1
    board = claimReadyTasks(board, 1, phase1Time).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], phase1Time);
    board = applyEdits(board, [completeTask("t-1.1")], phase1Time);

    const phase1Record = board.phases.find((p) => p.phase === 1);
    expect(phase1Record?.status).toBe("completed");
    expect(phase1Record?.completedAt).toBe(phase1Time);

    // Complete phase 2 at a later time
    const phase2Time = "2025-06-20T18:00:00.000Z";
    board = claimReadyTasks(board, 1, phase2Time).board;
    board = applyEdits(board, [{ id: "t-2.1", type: "advance" }], phase2Time);
    board = applyEdits(board, [completeTask("t-2.1")], phase2Time);

    // Phase 1's completedAt should be preserved
    const phase1Again = board.phases.find((p) => p.phase === 1);
    expect(phase1Again?.completedAt).toBe(phase1Time);

    const phase2Record = board.phases.find((p) => p.phase === 2);
    expect(phase2Record?.completedAt).toBe(phase2Time);
  });

  it("task in later phase with all deps done stays configured until its phase activates", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2, dependencies: ["t-1.1"] },
    ]);

    // A is ready (phase 1 active, no deps). B is configured (phase 2 pending).
    // B depends on A, but even if A were done, B wouldn't be ready because phase 2 isn't active.
    expect(board.tasks[0]!.status).toBe("ready");
    expect(board.tasks[1]!.status).toBe("configured");
  });
});

// ═══════════════════════════════════════════
// hasActionableTasks / hasBlockedNonTerminalTasks
// ═══════════════════════════════════════════

describe("hasActionableTasks / hasBlockedNonTerminalTasks", () => {
  it("hasActionableTasks returns true when ready tasks exist", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(hasActionableTasks(board)).toBe(true);
  });

  it("hasActionableTasks returns true when implementing tasks exist", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    expect(hasActionableTasks(board)).toBe(true);
  });

  it("hasActionableTasks returns false when all tasks terminal", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-1.1")], NOW);
    expect(hasActionableTasks(board)).toBe(false);
  });

  it("hasBlockedNonTerminalTasks returns true when tasks are blocked", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);

    // Abandon A — B's dep is unsatisfied, B is non-terminal with no actionable tasks
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(hasBlockedNonTerminalTasks(board)).toBe(true);
  });

  it("hasBlockedNonTerminalTasks returns false when all tasks terminal", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(hasBlockedNonTerminalTasks(board)).toBe(false);
  });
});
