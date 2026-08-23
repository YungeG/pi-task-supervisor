import { describe, it, expect } from "vitest";
import { createEmptyBoard, writeTasks } from "../engine";
import { makeBoardWithStatuses } from "./helpers/engine-helpers";

// ═══════════════════════════════════════════
// 1. createEmptyBoard
// ═══════════════════════════════════════════

describe("createEmptyBoard", () => {
  it("returns correct empty shape", () => {
    const board = createEmptyBoard();
    expect(board).toEqual({
      version: 2,
      generation: 0,
      workflowStatus: "inactive",
      tasks: [],
      phases: [],
      pendingPhasePrompt: undefined,
      stagnantSettles: 0,
    });
  });
});

// ═══════════════════════════════════════════
// 2. writeTasks
// ═══════════════════════════════════════════

const NOW = "2025-01-01T00:00:00.000Z";

describe("writeTasks", () => {
  it("creates draft tasks with phase-relative ids (t-phase.index)", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Phase 1",
            tasks: [
              { title: "Task A", prompt: "Do A", profile: "coder" },
              { title: "Task B", prompt: "Do B", profile: "coder" },
            ],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.id).toBe("t-1.1");
    expect(result.tasks[1]!.id).toBe("t-1.2");
    expect(result.tasks[0]!.status).toBe("draft");
    expect(result.tasks[1]!.status).toBe("draft");
  });

  it("sets createdAt and updatedAt to the now parameter", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Phase 1",
            tasks: [{ title: "Task A", prompt: "Do A", profile: "coder" }],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks[0]!.createdAt).toBe(NOW);
    expect(result.tasks[0]!.updatedAt).toBe(NOW);
  });

  it("initializes dependencies to an empty array", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Phase 1",
            tasks: [{ title: "Task A", prompt: "Do A", profile: "coder" }],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks[0]!.dependencies).toEqual([]);
  });

  it("assigns sequential phase numbers across input phases", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Phase A",
            tasks: [{ title: "Task A", prompt: "Do A", profile: "coder" }],
          },
          {
            title: "Phase B",
            tasks: [{ title: "Task B", prompt: "Do B", profile: "coder" }],
          },
          {
            title: "Phase C",
            tasks: [{ title: "Task C", prompt: "Do C", profile: "coder" }],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks[0]!.id).toBe("t-1.1");
    expect(result.tasks[1]!.id).toBe("t-2.1");
    expect(result.tasks[2]!.id).toBe("t-3.1");
    expect(result.tasks[0]!.phase).toBe(1);
    expect(result.tasks[1]!.phase).toBe(2);
    expect(result.tasks[2]!.phase).toBe(3);
  });

  // ── Replace mode ──

  it("replace mode starts from a fresh empty board", () => {
    // Create a board with some tasks first
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Old Phase",
            tasks: [{ title: "Old Task", prompt: "P", profile: "c" }],
          },
        ],
      },
      NOW,
    );
    expect(board.tasks).toHaveLength(1);

    // Replace with new tasks
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "New Phase",
            tasks: [{ title: "New Task", prompt: "P", profile: "c" }],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.title).toBe("New Task");
    expect(result.tasks[0]!.id).toBe("t-1.1");
  });

  it("replace mode rejects when active tasks exist", () => {
    const board = makeBoardWithStatuses([{ title: "A", phase: 1, status: "implementing" }]);
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "Phase 1",
              tasks: [{ title: "New", prompt: "P", profile: "c" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Cannot replace board while tasks are implementing or reviewing/);
  });

  // ── Append mode ──

  it("append mode adds to existing board", () => {
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Phase 1",
            tasks: [{ title: "First", prompt: "P", profile: "c" }],
          },
        ],
      },
      NOW,
    );

    const result = writeTasks(
      board,
      {
        mode: "append",
        phases: [
          {
            title: "Phase 2",
            tasks: [{ title: "Second", prompt: "P", profile: "c" }],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!.title).toBe("First");
    expect(result.tasks[1]!.title).toBe("Second");
    expect(result.tasks[1]!.id).toBe("t-2.1");
    expect(result.tasks[1]!.phase).toBe(2);
  });

  it("append mode computes startPhase from existing tasks", () => {
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          { title: "P1", tasks: [{ title: "A", prompt: "P", profile: "c" }] },
          { title: "P2", tasks: [{ title: "B", prompt: "P", profile: "c" }] },
          { title: "P3", tasks: [{ title: "C", prompt: "P", profile: "c" }] },
        ],
      },
      NOW,
    );
    // Existing phases are 1, 2, 3

    const result = writeTasks(
      board,
      {
        mode: "append",
        phases: [
          {
            title: "P4",
            tasks: [
              { title: "D", prompt: "P", profile: "c" },
              { title: "E", prompt: "P", profile: "c" },
            ],
          },
        ],
      },
      NOW,
    );

    expect(result.tasks[3]!.id).toBe("t-4.1");
    expect(result.tasks[3]!.phase).toBe(4);
    expect(result.tasks[4]!.id).toBe("t-4.2");
    expect(result.tasks[4]!.phase).toBe(4);
  });

  it("append mode on empty board starts from phase 1", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "append",
        phases: [
          {
            title: "Phase 1",
            tasks: [{ title: "A", prompt: "P", profile: "c" }],
          },
        ],
      },
      NOW,
    );
    expect(result.tasks[0]!.id).toBe("t-1.1");
    expect(result.tasks[0]!.phase).toBe(1);
  });

  // ── Phase records ──

  it("creates PhaseRecords with pending status and title", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Setup",
            tasks: [{ title: "A", prompt: "P", profile: "c" }],
          },
          {
            title: "Implementation",
            tasks: [{ title: "B", prompt: "P", profile: "c" }],
          },
        ],
      },
      NOW,
    );

    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]).toEqual({
      phase: 1,
      status: "pending",
      title: "Setup",
    });
    expect(result.phases[1]).toEqual({
      phase: 2,
      status: "pending",
      title: "Implementation",
    });
  });

  // ── Phase title validation ──

  it("rejects empty phase title", () => {
    const board = createEmptyBoard();
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "",
              tasks: [{ title: "T", prompt: "P", profile: "c" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Phase 1: title must be a non-empty string/);
  });

  it("rejects whitespace-only phase title", () => {
    const board = createEmptyBoard();
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "   ",
              tasks: [{ title: "T", prompt: "P", profile: "c" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Phase 1: title must be a non-empty string/);
  });

  // ── Task validation ──

  it("rejects empty task title", () => {
    const board = createEmptyBoard();
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "Phase 1",
              tasks: [{ title: "", prompt: "P", profile: "c" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Phase 1 task 1: title must be a non-empty string/);
  });

  it("rejects whitespace-only task title", () => {
    const board = createEmptyBoard();
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "Phase 1",
              tasks: [{ title: "   ", prompt: "P", profile: "c" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Phase 1 task 1: title must be a non-empty string/);
  });

  it("rejects empty prompt", () => {
    const board = createEmptyBoard();
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "Phase 1",
              tasks: [{ title: "T", prompt: "", profile: "c" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Phase 1 task 1: prompt must be a non-empty string/);
  });

  it("rejects empty profile", () => {
    const board = createEmptyBoard();
    expect(() =>
      writeTasks(
        board,
        {
          mode: "replace",
          phases: [
            {
              title: "Phase 1",
              tasks: [{ title: "T", prompt: "P", profile: "" }],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/Phase 1 task 1: profile must be a non-empty string/);
  });

  // ── MAX_TASKS ──

  it("rejects when total would exceed MAX_TASKS (100)", () => {
    const board = createEmptyBoard();
    const tasks99 = Array.from({ length: 99 }, (_, i) => ({
      title: `Task ${i + 1}`,
      prompt: "P",
      profile: "c",
    }));
    const full = writeTasks(
      board,
      { mode: "replace", phases: [{ title: "Phase 1", tasks: tasks99 }] },
      NOW,
    );
    expect(full.tasks).toHaveLength(99);

    // Adding 2 more via append would exceed 100
    expect(() =>
      writeTasks(
        full,
        {
          mode: "append",
          phases: [
            {
              title: "Phase 2",
              tasks: [
                { title: "Overflow 1", prompt: "P", profile: "c" },
                { title: "Overflow 2", prompt: "P", profile: "c" },
              ],
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/would exceed maximum/);

    // Adding exactly 1 more is fine
    const exact = writeTasks(
      full,
      {
        mode: "append",
        phases: [{ title: "Phase 2", tasks: [{ title: "Exact 100", prompt: "P", profile: "c" }] }],
      },
      NOW,
    );
    expect(exact.tasks).toHaveLength(100);
  });

  // ── Immutability ──

  it("does not mutate the input board", () => {
    const board = createEmptyBoard();
    const frozen = JSON.parse(JSON.stringify(board));
    writeTasks(
      board,
      {
        mode: "replace",
        phases: [{ title: "Phase 1", tasks: [{ title: "T", prompt: "P", profile: "c" }] }],
      },
      NOW,
    );
    expect(board).toEqual(frozen);
  });

  // ── Trimming ──

  it("trims whitespace from title, prompt, profile, and phase title", () => {
    const board = createEmptyBoard();
    const result = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "  Setup Phase  ",
            tasks: [{ title: "  Task A  ", prompt: "  Do A  ", profile: "  coder  " }],
          },
        ],
      },
      NOW,
    );
    expect(result.tasks[0]!.title).toBe("Task A");
    expect(result.tasks[0]!.prompt).toBe("Do A");
    expect(result.tasks[0]!.profile).toBe("coder");
    expect(result.phases[0]!.title).toBe("Setup Phase");
  });
});
