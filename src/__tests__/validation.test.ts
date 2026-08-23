import { describe, it, expect } from "vitest";
import type { LegacyTaskBoardSnapshot, TaskRecord } from "../types";
import {
  isNonEmptyString,
  isValidPhase,
  hasSelfDependency,
  hasDuplicateDependencies,
  findMissingDependencies,
  detectCycle,
  hasActionableTasks,
  hasBlockedNonTerminalTasks,
  isValidSnapshot,
  cloneBoard,
} from "../validation";

// ── Helpers ──

const NOW = "2025-01-01T00:00:00.000Z";

/** Creates a valid TaskRecord with optional overrides. */
function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    title: "Test task",
    prompt: "Do something",
    profile: "default",
    phase: 1,
    dependencies: [],
    status: "draft",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/** Creates a minimal valid legacy snapshot. */
function makeBoard(overrides: Partial<LegacyTaskBoardSnapshot> = {}): LegacyTaskBoardSnapshot {
  return {
    version: 1,
    tasks: [],
    phases: [],
    ...overrides,
  };
}

// ═══════════════════════════════════════════
// 1. isNonEmptyString
// ═══════════════════════════════════════════

describe("isNonEmptyString", () => {
  it("accepts normal non-empty strings", () => {
    expect(isNonEmptyString("hello")).toBe(true);
    expect(isNonEmptyString("a")).toBe(true);
    expect(isNonEmptyString("hello world")).toBe(true);
  });

  it("accepts strings with leading/trailing whitespace", () => {
    expect(isNonEmptyString("  hello  ")).toBe(true);
    expect(isNonEmptyString("\thello\t")).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isNonEmptyString("")).toBe(false);
  });

  it("rejects whitespace-only string", () => {
    expect(isNonEmptyString("   ")).toBe(false);
    expect(isNonEmptyString("\t\n")).toBe(false);
    expect(isNonEmptyString(" \n ")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(true)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
    expect(isNonEmptyString([])).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 2. isValidPhase
// ═══════════════════════════════════════════

describe("isValidPhase", () => {
  it("accepts positive integers", () => {
    expect(isValidPhase(1)).toBe(true);
    expect(isValidPhase(2)).toBe(true);
    expect(isValidPhase(10)).toBe(true);
    expect(isValidPhase(100)).toBe(true);
  });

  it("rejects 0", () => {
    expect(isValidPhase(0)).toBe(false);
  });

  it("rejects negative numbers", () => {
    expect(isValidPhase(-1)).toBe(false);
    expect(isValidPhase(-10)).toBe(false);
  });

  it("rejects non-integers (floats)", () => {
    expect(isValidPhase(1.5)).toBe(false);
    expect(isValidPhase(0.1)).toBe(false);
    expect(isValidPhase(3.14)).toBe(false);
  });

  it("rejects non-numbers", () => {
    expect(isValidPhase("1")).toBe(false);
    expect(isValidPhase(null)).toBe(false);
    expect(isValidPhase(undefined)).toBe(false);
    expect(isValidPhase(true)).toBe(false);
    expect(isValidPhase(NaN)).toBe(false);
    expect(isValidPhase(Infinity)).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 3. hasSelfDependency
// ═══════════════════════════════════════════

describe("hasSelfDependency", () => {
  it("returns true when task id is in dependencies", () => {
    expect(hasSelfDependency("task-1", ["task-1"])).toBe(true);
    expect(hasSelfDependency("task-1", ["task-2", "task-1", "task-3"])).toBe(true);
  });

  it("returns false when task id is not in dependencies", () => {
    expect(hasSelfDependency("task-1", [])).toBe(false);
    expect(hasSelfDependency("task-1", ["task-2", "task-3"])).toBe(false);
    expect(hasSelfDependency("task-1", [])).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 4. hasDuplicateDependencies
// ═══════════════════════════════════════════

describe("hasDuplicateDependencies", () => {
  it("returns true for duplicate dependencies", () => {
    expect(hasDuplicateDependencies(["task-1", "task-1"])).toBe(true);
    expect(hasDuplicateDependencies(["task-1", "task-2", "task-1"])).toBe(true);
  });

  it("returns false for unique dependencies", () => {
    expect(hasDuplicateDependencies([])).toBe(false);
    expect(hasDuplicateDependencies(["task-1"])).toBe(false);
    expect(hasDuplicateDependencies(["task-1", "task-2", "task-3"])).toBe(false);
  });
});

// ═══════════════════════════════════════════
// 5. findMissingDependencies
// ═══════════════════════════════════════════

describe("findMissingDependencies", () => {
  it("returns missing dependency ids", () => {
    const existing = new Set(["task-1", "task-2"]);
    expect(findMissingDependencies(["task-3"], existing)).toEqual(["task-3"]);
    expect(findMissingDependencies(["task-1", "task-3"], existing)).toEqual(["task-3"]);
    expect(findMissingDependencies(["task-3", "task-4"], existing)).toEqual(["task-3", "task-4"]);
  });

  it("returns empty array when all dependencies exist", () => {
    const existing = new Set(["task-1", "task-2", "task-3"]);
    expect(findMissingDependencies(["task-1", "task-2"], existing)).toEqual([]);
    expect(findMissingDependencies([], existing)).toEqual([]);
  });
});

// ═══════════════════════════════════════════
// 6. detectCycle
// ═══════════════════════════════════════════

describe("detectCycle", () => {
  it("returns empty array for empty graph", () => {
    expect(detectCycle([])).toEqual([]);
  });

  it("returns empty array for tasks with no dependencies", () => {
    const tasks = [
      makeTask({ id: "task-1", dependencies: [] }),
      makeTask({ id: "task-2", dependencies: [] }),
    ];
    expect(detectCycle(tasks)).toEqual([]);
  });

  it("returns empty array for linear chain (A → B → C)", () => {
    const tasks = [
      makeTask({ id: "task-3", dependencies: [] }),
      makeTask({ id: "task-2", dependencies: ["task-3"] }),
      makeTask({ id: "task-1", dependencies: ["task-2"] }),
    ];
    expect(detectCycle(tasks)).toEqual([]);
  });

  it("returns empty array for diamond DAG", () => {
    // task-1 depends on task-2 and task-3, which both depend on task-4
    const tasks = [
      makeTask({ id: "task-4", dependencies: [] }),
      makeTask({ id: "task-2", dependencies: ["task-4"] }),
      makeTask({ id: "task-3", dependencies: ["task-4"] }),
      makeTask({ id: "task-1", dependencies: ["task-2", "task-3"] }),
    ];
    expect(detectCycle(tasks)).toEqual([]);
  });

  it("detects simple cycle (A → B → A)", () => {
    const tasks = [
      makeTask({ id: "task-1", dependencies: ["task-2"] }),
      makeTask({ id: "task-2", dependencies: ["task-1"] }),
    ];
    const cycle = detectCycle(tasks);
    expect(cycle.length).toBeGreaterThan(0);
    // Cycle should contain both task-1 and task-2
    expect(cycle).toContain("task-1");
    expect(cycle).toContain("task-2");
  });

  it("detects longer cycle (A → B → C → A)", () => {
    const tasks = [
      makeTask({ id: "task-1", dependencies: ["task-3"] }),
      makeTask({ id: "task-2", dependencies: ["task-1"] }),
      makeTask({ id: "task-3", dependencies: ["task-2"] }),
    ];
    const cycle = detectCycle(tasks);
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle).toContain("task-1");
    expect(cycle).toContain("task-2");
    expect(cycle).toContain("task-3");
  });

  it("detects self-loop (A → A)", () => {
    const tasks = [makeTask({ id: "task-1", dependencies: ["task-1"] })];
    const cycle = detectCycle(tasks);
    expect(cycle.length).toBeGreaterThan(0);
    expect(cycle).toContain("task-1");
  });

  it("returns empty array when dependency points to non-existent task (no cycle)", () => {
    const tasks = [makeTask({ id: "task-1", dependencies: ["task-999"] })];
    expect(detectCycle(tasks)).toEqual([]);
  });
});

// ═══════════════════════════════════════════
// 7. Board state checks
// ═══════════════════════════════════════════

describe("hasActionableTasks", () => {
  it("returns false for empty board", () => {
    expect(hasActionableTasks(makeBoard())).toBe(false);
  });

  it("returns false when tasks are only draft/configured/done/abandoned", () => {
    const board = makeBoard({
      tasks: [
        makeTask({ status: "draft" }),
        makeTask({ id: "task-2", status: "configured" }),
        makeTask({ id: "task-3", status: "done" }),
        makeTask({ id: "task-4", status: "abandoned" }),
      ],
    });
    expect(hasActionableTasks(board)).toBe(false);
  });

  it("returns true when a task is ready", () => {
    const board = makeBoard({
      tasks: [makeTask({ status: "ready" })],
    });
    expect(hasActionableTasks(board)).toBe(true);
  });

  it("returns true when a task is implementing", () => {
    const board = makeBoard({
      tasks: [makeTask({ status: "implementing" })],
    });
    expect(hasActionableTasks(board)).toBe(true);
  });

  it("returns true when a task is reviewing", () => {
    const board = makeBoard({
      tasks: [makeTask({ status: "reviewing" })],
    });
    expect(hasActionableTasks(board)).toBe(true);
  });
});

describe("hasBlockedNonTerminalTasks", () => {
  it("returns false for empty board", () => {
    expect(hasBlockedNonTerminalTasks(makeBoard())).toBe(false);
  });

  it("returns false when all tasks are terminal", () => {
    const board = makeBoard({
      tasks: [makeTask({ status: "done" }), makeTask({ id: "task-2", status: "abandoned" })],
    });
    expect(hasBlockedNonTerminalTasks(board)).toBe(false);
  });

  it("returns false when actionable tasks exist (ready)", () => {
    const board = makeBoard({
      tasks: [makeTask({ status: "ready" }), makeTask({ id: "task-2", status: "configured" })],
    });
    expect(hasBlockedNonTerminalTasks(board)).toBe(false);
  });

  it("returns false when actionable tasks exist (implementing)", () => {
    const board = makeBoard({
      tasks: [
        makeTask({ status: "implementing" }),
        makeTask({ id: "task-2", status: "configured" }),
      ],
    });
    expect(hasBlockedNonTerminalTasks(board)).toBe(false);
  });

  it("returns true when non-terminal tasks exist but none are actionable (deadlock)", () => {
    const board = makeBoard({
      tasks: [makeTask({ status: "draft" }), makeTask({ id: "task-2", status: "configured" })],
    });
    expect(hasBlockedNonTerminalTasks(board)).toBe(true);
  });
});

// ═══════════════════════════════════════════
// 8. isValidSnapshot
// ═══════════════════════════════════════════

describe("isValidSnapshot", () => {
  it("accepts a valid minimal snapshot", () => {
    expect(isValidSnapshot(makeBoard())).toBe(true);
  });

  it("accepts a valid snapshot with tasks and phases", () => {
    const snapshot: LegacyTaskBoardSnapshot = {
      version: 1,
      tasks: [makeTask()],
      phases: [{ phase: 1, status: "active" }],
    };
    expect(isValidSnapshot(snapshot)).toBe(true);
  });

  it("rejects null", () => {
    expect(isValidSnapshot(null)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isValidSnapshot("string")).toBe(false);
    expect(isValidSnapshot(123)).toBe(false);
    expect(isValidSnapshot(true)).toBe(false);
    expect(isValidSnapshot(undefined)).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(isValidSnapshot(makeBoard({ version: 2 as 1 }))).toBe(false);
    expect(isValidSnapshot(makeBoard({ version: 0 as 1 }))).toBe(false);
  });

  it("rejects missing tasks array", () => {
    const snap = { version: 1, phases: [] };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects missing phases array", () => {
    const snap = { version: 1, tasks: [] };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects non-array tasks", () => {
    const snap = { version: 1, tasks: "not-array", phases: [] };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects non-array phases", () => {
    const snap = { version: 1, tasks: [], phases: "not-array" };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("accepts snapshot with extra nextTaskId field (backward compat)", () => {
    const snap = { version: 1, tasks: [], phases: [], nextTaskId: 3 };
    expect(isValidSnapshot(snap)).toBe(true);
  });
});

// ═══════════════════════════════════════════
// 8b. isValidSnapshot - hardened validation
// ═══════════════════════════════════════════

describe("isValidSnapshot - hardened validation", () => {
  it("rejects snapshot with task missing id", () => {
    const snap = {
      version: 1,
      tasks: [{ title: "Test", status: "draft", phase: 1, dependencies: [] }],
      phases: [],
    };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects snapshot with task having invalid status", () => {
    const snap = {
      version: 1,
      tasks: [{ id: "t-1", title: "Test", status: "unknown", phase: 1, dependencies: [] }],
      phases: [],
    };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects snapshot with task having non-string dependency elements", () => {
    const snap = {
      version: 1,
      tasks: [{ id: "t-1", title: "Test", status: "draft", phase: 1, dependencies: [123] }],
      phases: [],
    };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects snapshot with task having non-array dependencies", () => {
    const snap = {
      version: 1,
      tasks: [{ id: "t-1", title: "Test", status: "draft", phase: 1, dependencies: "bad" }],
      phases: [],
    };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("rejects snapshot with phase having invalid status", () => {
    const snap = {
      version: 1,
      tasks: [],
      phases: [{ phase: 1, status: "unknown" }],
    };
    expect(isValidSnapshot(snap)).toBe(false);
  });

  it("accepts valid snapshot with tasks and phases", () => {
    const snap = {
      version: 1,
      tasks: [
        {
          id: "t-1",
          title: "Test",
          status: "draft",
          phase: 1,
          dependencies: [],
        },
      ],
      phases: [{ phase: 1, status: "active" }],
    };
    expect(isValidSnapshot(snap)).toBe(true);
  });

  it("accepts snapshot with empty tasks and phases arrays", () => {
    expect(isValidSnapshot(makeBoard())).toBe(true);
  });

  it("accepts snapshot with tasks having extra fields (backward compat)", () => {
    const snap = {
      version: 1,
      tasks: [
        {
          id: "t-1",
          title: "Test",
          status: "draft",
          phase: 1,
          dependencies: [],
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          extra: "field",
        },
      ],
      phases: [{ phase: 1, status: "pending", title: "Phase 1" }],
    };
    expect(isValidSnapshot(snap)).toBe(true);
  });
});

// ═══════════════════════════════════════════
// 9. cloneBoard
// ═══════════════════════════════════════════

describe("cloneBoard", () => {
  it("produces a structurally equal copy", () => {
    const board = makeBoard({
      tasks: [makeTask(), makeTask({ id: "t-1.2", title: "Second task" })],
      phases: [{ phase: 1, status: "active" }],
    });
    const clone = cloneBoard(board);
    expect(clone).toEqual(board);
  });

  it("produces a referentially distinct copy", () => {
    const board = makeBoard({
      tasks: [makeTask()],
      phases: [{ phase: 1, status: "active" }],
    });
    const clone = cloneBoard(board);
    expect(clone).not.toBe(board);
    expect(clone.tasks).not.toBe(board.tasks);
    expect(clone.tasks[0]).not.toBe(board.tasks[0]);
    expect(clone.phases).not.toBe(board.phases);
  });

  it("mutations to clone do not affect original", () => {
    const board = makeBoard({
      tasks: [makeTask()],
      phases: [{ phase: 1, status: "active" }],
    });
    const clone = cloneBoard(board);
    clone.tasks[0]!.title = "Modified";
    expect(board.tasks[0]!.title).toBe("Test task");
  });

  it("clones an empty board correctly", () => {
    const board = makeBoard();
    const clone = cloneBoard(board);
    expect(clone).toEqual(board);
    expect(clone).not.toBe(board);
  });
});
