import { describe, it, expect, beforeEach } from "vitest";
import type { TaskBoardSnapshot } from "../types";
import { CUSTOM_EVENT_TYPE, CUSTOM_SNAPSHOT_TYPE } from "../types";
import { createEmptyBoard } from "../engine";
import {
  getBoard,
  setBoard,
  setBoardQuiet,
  getBoardRef,
  incrementAutoContinue,
  resetState,
  reconstructState,
  persistEntries,
  updateUI,
  getLastToolWasAdvance,
  setLastToolWasAdvance,
} from "../state";
import { createMockContext, createMockAPI } from "./helpers/mocks";

// ── Helpers ──

/** Build a minimal valid snapshot for testing */
function makeSampleBoard(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
  const now = new Date().toISOString();
  return {
    version: 2,
    generation: 1,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-2.1",
    tasks: [
      {
        id: "t-1.1",
        title: "Setup project",
        prompt: "Initialize the project",
        profile: "coder",
        phase: 1,
        dependencies: [],
        status: "done",
        createdAt: now,
        updatedAt: now,
        completionEvidence: {
          summary: "Test completion",
          refs: [{ kind: "review", label: "test review", status: "passed", ref: "test://review" }],
        },
      },
      {
        id: "t-2.1",
        title: "Write tests",
        prompt: "Write comprehensive tests",
        profile: "tester",
        phase: 2,
        dependencies: ["t-1.1"],
        status: "ready",
        createdAt: now,
        updatedAt: now,
      },
    ],
    phases: [
      { phase: 1, status: "completed", completedAt: now },
      { phase: 2, status: "active" },
    ],
    stagnantSettles: 0,
    ...overrides,
  };
}

/** Build a branch entry for the mock context */
function snapshotEntry(data: unknown) {
  return { type: "custom", customType: CUSTOM_SNAPSHOT_TYPE, data };
}

function eventEntry(data: unknown) {
  return { type: "custom", customType: CUSTOM_EVENT_TYPE, data };
}

// ── Tests ──

describe("state", () => {
  beforeEach(() => {
    resetState();
  });

  // ── reconstructState ──

  describe("reconstructState", () => {
    it("returns empty board for empty branch", () => {
      const ctx = createMockContext([]);
      const board = reconstructState(ctx);
      expect(board).toEqual(createEmptyBoard());
    });

    it("finds the latest snapshot in reverse scan", () => {
      const firstSnapshot = makeSampleBoard({
        tasks: [
          ...makeSampleBoard().tasks,
          {
            id: "extra",
            title: "Extra",
            prompt: "P",
            profile: "c",
            phase: 1,
            dependencies: [],
            status: "draft",
            createdAt: "",
            updatedAt: "",
          },
        ],
      });
      const secondSnapshot = makeSampleBoard();

      const branch = [
        snapshotEntry(firstSnapshot),
        eventEntry({ type: "compile_tasks" }),
        snapshotEntry(secondSnapshot),
      ];

      const ctx = createMockContext(branch);
      const board = reconstructState(ctx);

      expect(board.tasks.length).toBe(secondSnapshot.tasks.length);
    });

    it("skips entries with wrong customType", () => {
      const snapshot = makeSampleBoard();
      const branch = [
        { type: "custom", customType: "other-event", data: snapshot },
        { type: "custom", customType: "wrong-type", data: snapshot },
        snapshotEntry(snapshot),
      ];

      const ctx = createMockContext(branch);
      const board = reconstructState(ctx);

      // Should find the snapshot, not the earlier wrong-type entries
      expect(board.tasks.length).toBe(snapshot.tasks.length);
    });

    it("skips entries with invalid snapshot data", () => {
      const validSnapshot = makeSampleBoard();
      const branch = [
        snapshotEntry({ version: 2 }), // wrong version
        snapshotEntry(null), // null data
        snapshotEntry(undefined), // undefined data
        snapshotEntry({}), // missing fields
        snapshotEntry({ version: 1, tasks: "not-array", phases: [] }), // invalid tasks
        snapshotEntry(validSnapshot),
      ];

      const ctx = createMockContext(branch);
      const board = reconstructState(ctx);

      expect(board.tasks.length).toBe(validSnapshot.tasks.length);
    });

    it("returns empty board when all snapshots are invalid", () => {
      const branch = [
        snapshotEntry({ version: 2 }),
        snapshotEntry(null),
        snapshotEntry({ bad: "data" }),
      ];

      const ctx = createMockContext(branch);
      const board = reconstructState(ctx);

      expect(board).toEqual(createEmptyBoard());
    });

    it("returns a deep copy (mutations don't affect cached entry)", () => {
      const snapshot = makeSampleBoard();
      const branch = [snapshotEntry(snapshot)];

      const ctx = createMockContext(branch);
      const board = reconstructState(ctx);

      // Mutate the returned board
      board.tasks.push({
        id: "task-evil",
        title: "evil",
        prompt: "evil",
        profile: "evil",
        phase: 1,
        dependencies: [],
        status: "draft",
        createdAt: "",
        updatedAt: "",
      });

      // Re-reconstruct: should still get original data
      const board2 = reconstructState(ctx);
      expect(board2.tasks.length).toBe(snapshot.tasks.length);
    });
  });

  // ── setBoard / getBoard ──

  describe("setBoard / getBoard", () => {
    it("getBoard returns empty board initially", () => {
      const board = getBoard();
      expect(board).toEqual(createEmptyBoard());
    });

    it("setBoard replaces and getBoard returns the new board", () => {
      const newBoard = makeSampleBoard();
      setBoard(newBoard);

      const board = getBoard();
      expect(board).toEqual(newBoard);
    });

    it("setBoard resets auto-continue counter", () => {
      // Increment a few times
      incrementAutoContinue();
      incrementAutoContinue();
      incrementAutoContinue();

      // Set board should reset counter
      setBoard(makeSampleBoard());

      // First increment after reset should be 1
      const count = incrementAutoContinue();
      expect(count).toBe(1);
    });

    it("getBoard returns a deep copy", () => {
      setBoard(makeSampleBoard());
      const board1 = getBoard();

      // Mutate the returned copy
      board1.tasks[0]!.title = "MUTATED";

      // Get a fresh copy — should not reflect the mutation
      const board2 = getBoard();
      expect(board2.tasks[0]!.title).not.toBe("MUTATED");
    });

    it("setBoard stores a deep copy (mutations to original don't affect state)", () => {
      const original = makeSampleBoard();
      setBoard(original);

      // Mutate the original
      original.tasks[0]!.title = "MUTATED";

      // getBoard should not reflect the mutation
      const board = getBoard();
      expect(board.tasks[0]!.title).not.toBe("MUTATED");
    });
  });

  // ── getBoardRef ──

  describe("getBoardRef", () => {
    it("returns the same reference (no clone)", () => {
      setBoard(makeSampleBoard());
      const ref1 = getBoardRef();
      const ref2 = getBoardRef();
      expect(ref1).toBe(ref2);
    });
  });

  // ── setBoardQuiet ──

  describe("setBoardQuiet", () => {
    it("replaces board without resetting auto-continue counter", () => {
      incrementAutoContinue(); // 1
      incrementAutoContinue(); // 2
      incrementAutoContinue(); // 3

      setBoardQuiet(makeSampleBoard());

      // Counter should NOT have been reset
      expect(incrementAutoContinue()).toBe(4);
    });

    it("returns deep copy via getBoard", () => {
      const board = makeSampleBoard();
      setBoardQuiet(board);

      // getBoard should return the same data
      const retrieved = getBoard();
      expect(retrieved).toEqual(board);

      // Mutating getBoard result should not affect stored state
      retrieved.tasks[0]!.title = "MUTATED";
      const fresh = getBoard();
      expect(fresh.tasks[0]!.title).not.toBe("MUTATED");
    });

    it("stores a deep copy (mutations to original don't affect state)", () => {
      const original = makeSampleBoard();
      setBoardQuiet(original);

      // Mutate the original
      original.tasks[0]!.title = "MUTATED";

      // getBoard should not reflect the mutation
      const board = getBoard();
      expect(board.tasks[0]!.title).not.toBe("MUTATED");
    });
  });

  // ── persistEntries ──

  describe("persistEntries", () => {
    it("calls appendEntry twice with correct types and data", () => {
      const { api, appendEntry } = createMockAPI();
      const event = { type: "write_tasks", tasks: [] };
      const snapshot = makeSampleBoard();

      persistEntries(api, event, snapshot);

      expect(appendEntry).toHaveBeenCalledTimes(2);
      expect(appendEntry).toHaveBeenNthCalledWith(1, CUSTOM_EVENT_TYPE, event);
      expect(appendEntry).toHaveBeenNthCalledWith(2, CUSTOM_SNAPSHOT_TYPE, expect.any(Object));
    });

    it("passes the snapshot directly (no clone)", () => {
      const { api, appendEntry } = createMockAPI();
      const snapshot = makeSampleBoard();

      persistEntries(api, { type: "clear_tasks" }, snapshot);

      const passedSnapshot = appendEntry.mock.calls[1]![1] as TaskBoardSnapshot;
      // Should be structurally equal and the same reference (no clone)
      expect(passedSnapshot).toEqual(snapshot);
      expect(passedSnapshot).toBe(snapshot);
    });
  });

  // ── updateUI ──

  describe("updateUI", () => {
    it("clears both status keys when board is empty", () => {
      const ctx = createMockContext([]);
      const emptyBoard = createEmptyBoard();

      updateUI(ctx, emptyBoard);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done", undefined);
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done-active", undefined);
    });

    it("shows phase label and done count", () => {
      const ctx = createMockContext([]);
      const board = makeSampleBoard(); // Phase 2 active, 1 done / 2 total

      updateUI(ctx, board);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done", "1/2 - Phase 2");
    });

    it("shows active items for implementing/reviewing tasks", () => {
      const ctx = createMockContext([]);
      const now = new Date().toISOString();
      const board: TaskBoardSnapshot = {
        version: 2,
        generation: 1,
        workflowStatus: "active",
        finalAcceptanceTaskId: "t-1.2",
        tasks: [
          {
            id: "t-1.1",
            title: "Build feature",
            prompt: "Build it",
            profile: "coder",
            phase: 1,
            dependencies: [],
            status: "implementing",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "t-1.2",
            title: "Review feature",
            prompt: "Review it",
            profile: "reviewer",
            phase: 1,
            dependencies: ["t-1.1"],
            status: "reviewing",
            createdAt: now,
            updatedAt: now,
          },
        ],
        phases: [{ phase: 1, status: "active" }],
        stagnantSettles: 0,
      };

      updateUI(ctx, board);

      // Should set the active lines
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "til-done-active",
        "[t-1.1] Build feature\n[t-1.2] Review feature",
      );
    });

    it("shows done state when all tasks are terminal", () => {
      const ctx = createMockContext([]);
      const now = new Date().toISOString();
      const board: TaskBoardSnapshot = {
        version: 2,
        generation: 1,
        workflowStatus: "completed",
        finalAcceptanceTaskId: "t-1.1",
        tasks: [
          {
            id: "t-1.1",
            title: "Done task",
            prompt: "Done",
            profile: "coder",
            phase: 1,
            dependencies: [],
            status: "done",
            createdAt: now,
            updatedAt: now,
            completionEvidence: {
              summary: "Test completion",
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
          {
            id: "t-1.2",
            title: "Abandoned task",
            prompt: "Abandoned",
            profile: "coder",
            phase: 1,
            dependencies: [],
            status: "abandoned",
            createdAt: now,
            updatedAt: now,
          },
        ],
        phases: [{ phase: 1, status: "completed", completedAt: now }],
        stagnantSettles: 0,
      };

      updateUI(ctx, board);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done", "2/2 - No active phase");
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done-active", undefined);
    });

    it("is a no-op when hasUI is false", () => {
      const ctx = createMockContext([]);
      (ctx as { hasUI: boolean }).hasUI = false;

      updateUI(ctx, makeSampleBoard());

      expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    });

    it("shows 'No active phase' when no active phase exists but tasks remain", () => {
      const ctx = createMockContext([]);
      const now = new Date().toISOString();
      const board: TaskBoardSnapshot = {
        version: 2,
        generation: 1,
        workflowStatus: "inactive",
        tasks: [
          {
            id: "t-1.1",
            title: "Draft task",
            prompt: "Draft",
            profile: "coder",
            phase: 1,
            dependencies: [],
            status: "draft",
            createdAt: now,
            updatedAt: now,
          },
        ],
        phases: [], // No phases computed yet
        stagnantSettles: 0,
      };

      updateUI(ctx, board);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done", "0/1 - No active phase");
    });

    it("clears active status when no implementing/reviewing tasks", () => {
      const ctx = createMockContext([]);
      const board = makeSampleBoard(); // ready + done, no implementing/reviewing

      updateUI(ctx, board);

      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done-active", undefined);
    });
  });

  // ── Auto-continue counter ──

  describe("auto-continue counter", () => {
    it("incrementAutoContinue accumulates", () => {
      expect(incrementAutoContinue()).toBe(1);
      expect(incrementAutoContinue()).toBe(2);
      expect(incrementAutoContinue()).toBe(3);
    });

    it("setBoard resets counter", () => {
      incrementAutoContinue();
      incrementAutoContinue();
      expect(incrementAutoContinue()).toBe(3);

      setBoard(makeSampleBoard());

      expect(incrementAutoContinue()).toBe(1);
    });

    it("resetState resets counter", () => {
      incrementAutoContinue();
      incrementAutoContinue();

      resetState();

      expect(incrementAutoContinue()).toBe(1);
    });
  });

  // ── Double-usage tracking state ──

  describe("double-usage tracking state", () => {
    it("getLastToolWasAdvance returns false initially", () => {
      expect(getLastToolWasAdvance()).toBe(false);
    });

    it("setLastToolWasAdvance sets the flag", () => {
      setLastToolWasAdvance(true);
      expect(getLastToolWasAdvance()).toBe(true);
    });

    it("resetState clears flag", () => {
      setLastToolWasAdvance(true);
      resetState();
      expect(getLastToolWasAdvance()).toBe(false);
    });
  });
});
