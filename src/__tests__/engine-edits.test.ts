import { describe, it, expect } from "vitest";
import { createEmptyBoard, writeTasks, applyEdits, claimReadyTasks } from "../engine";
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
// 4. applyEdits — advance
// ═══════════════════════════════════════════

describe("applyEdits — advance", () => {
  it("implementing → reviewing succeeds", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    // Claim the ready task → implementing
    const claimed = claimReadyTasks(board, 1, NOW);
    board = claimed.board;
    expect(board.tasks[0]!.status).toBe("implementing");

    // Advance implementing → reviewing
    const result = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    expect(result.tasks[0]!.status).toBe("reviewing");
  });

  it("reviewing → done succeeds", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const claimed = claimReadyTasks(board, 1, NOW);
    board = claimed.board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    expect(board.tasks[0]!.status).toBe("reviewing");

    const result = applyEdits(board, [completeTask("t-1.1")], NOW);
    expect(result.tasks[0]!.status).toBe("done");
  });

  it("done triggers readiness recomputation for dependents", () => {
    // A has no deps (ready after compile). B depends on A.
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);

    expect(board.tasks[0]!.status).toBe("ready");
    expect(board.tasks[1]!.status).toBe("configured"); // B blocked by A

    // Claim A → implementing
    const claimed = claimReadyTasks(board, 1, NOW);
    board = claimed.board;

    // Advance A to reviewing
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);

    // Advance A to done
    board = applyEdits(board, [completeTask("t-1.1")], NOW);

    expect(board.tasks[0]!.status).toBe("done");
    // B should now be ready since its only dependency (A) is done
    expect(board.tasks[1]!.status).toBe("ready");
  });

  it("rejects advance from draft", () => {
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [{ title: "Phase 1", tasks: [{ title: "A", prompt: "P", profile: "c" }] }],
      },
      NOW,
    );

    expect(() => applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW)).toThrow(
      /Cannot advance task/,
    );
  });

  it("rejects advance from configured", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);

    expect(() => applyEdits(board, [{ id: "t-1.2", type: "advance" }], NOW)).toThrow(
      /Cannot advance task/,
    );
  });

  it("rejects advance from ready", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(board.tasks[0]!.status).toBe("ready");

    expect(() => applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW)).toThrow(
      /Cannot advance task/,
    );
  });

  it("rejects advance from done", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW); // → reviewing
    board = applyEdits(board, [completeTask("t-1.1")], NOW); // → done

    expect(() => applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW)).toThrow(
      /Cannot advance task/,
    );
  });

  it("rejects advance from abandoned", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);

    expect(() => applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW)).toThrow(
      /Cannot advance task/,
    );
  });

  it("allows implementing → reviewing → done via sequential advances", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;

    // implementing → reviewing is the only valid first advance
    const result = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    expect(result.tasks[0]!.status).toBe("reviewing");

    // reviewing → done is the second advance
    const result2 = applyEdits(result, [completeTask("t-1.1")], NOW);
    expect(result2.tasks[0]!.status).toBe("done");

    // No way to go directly from implementing to done — it goes through reviewing
  });
});

// ═══════════════════════════════════════════
// 5. applyEdits — abandon
// ═══════════════════════════════════════════

describe("applyEdits — abandon", () => {
  it("succeeds from draft", () => {
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [{ title: "Phase 1", tasks: [{ title: "A", prompt: "P", profile: "c" }] }],
      },
      NOW,
    );
    const result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");
  });

  it("succeeds from configured", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);
    // B is configured (blocked by A)
    expect(board.tasks[1]!.status).toBe("configured");

    const result = applyEdits(board, [{ id: "t-1.2", type: "abandon" }], NOW);
    expect(result.tasks[1]!.status).toBe("abandoned");
  });

  it("succeeds from ready", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(board.tasks[0]!.status).toBe("ready");

    const result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");
  });

  it("succeeds from implementing", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    expect(board.tasks[0]!.status).toBe("implementing");

    const result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");
  });

  it("succeeds from reviewing", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    expect(board.tasks[0]!.status).toBe("reviewing");

    const result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");
  });

  it("rejects from done", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-1.1")], NOW);
    expect(board.tasks[0]!.status).toBe("done");

    expect(() => applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW)).toThrow(
      /Cannot abandon task.*done.*Already resolved/,
    );
  });

  it("rejects from abandoned", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);

    expect(() => applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW)).toThrow(
      /Cannot abandon task.*abandoned.*Already resolved/,
    );
  });

  it("abandon from all non-terminal statuses succeeds", () => {
    // draft
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [{ title: "Phase 1", tasks: [{ title: "A", prompt: "P", profile: "c" }] }],
      },
      NOW,
    );
    let result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");

    // configured (blocked by another task)
    board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);
    result = applyEdits(board, [{ id: "t-1.2", type: "abandon" }], NOW);
    expect(result.tasks[1]!.status).toBe("abandoned");

    // ready
    board = makeCompiledBoard([{ title: "C", prompt: "P", profile: "c", phase: 1 }]);
    result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");

    // implementing
    board = makeCompiledBoard([{ title: "D", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");

    // reviewing
    board = makeCompiledBoard([{ title: "E", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    result = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(result.tasks[0]!.status).toBe("abandoned");
  });

  it("abandon rejects from terminal statuses", () => {
    // done
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
    board = applyEdits(board, [completeTask("t-1.1")], NOW);
    expect(board.tasks[0]!.status).toBe("done");
    expect(() => applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW)).toThrow(
      /Already resolved/,
    );

    // abandoned
    board = makeCompiledBoard([{ title: "B", prompt: "P", profile: "c", phase: 1 }]);
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(board.tasks[0]!.status).toBe("abandoned");
    expect(() => applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW)).toThrow(
      /Already resolved/,
    );
  });

  it("does not satisfy dependencies (dependents stay blocked)", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);
    // B depends on A, both in phase 1
    expect(board.tasks[1]!.status).toBe("configured");

    // Abandon A
    board = applyEdits(board, [{ id: "t-1.1", type: "abandon" }], NOW);
    expect(board.tasks[0]!.status).toBe("abandoned");

    // B should NOT become ready — A is abandoned, not done
    expect(board.tasks[1]!.status).toBe("configured");
  });
});

// ═══════════════════════════════════════════
// 6. applyEdits — data
// ═══════════════════════════════════════════

describe("applyEdits — data", () => {
  it("mutates title", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = applyEdits(
      board,
      [{ id: "t-1.1", type: "data", data: { title: "New Title" } }],
      NOW,
    );
    expect(result.tasks[0]!.title).toBe("New Title");
    expect(result.tasks[0]!.prompt).toBe("P"); // unchanged
  });

  it("mutates prompt", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = applyEdits(
      board,
      [{ id: "t-1.1", type: "data", data: { prompt: "New Prompt" } }],
      NOW,
    );
    expect(result.tasks[0]!.prompt).toBe("New Prompt");
  });

  it("mutates profile", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = applyEdits(
      board,
      [{ id: "t-1.1", type: "data", data: { profile: "new-profile" } }],
      NOW,
    );
    expect(result.tasks[0]!.profile).toBe("new-profile");
  });

  it("mutates phase", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = applyEdits(board, [{ id: "t-1.1", type: "data", data: { phase: 3 } }], NOW);
    expect(result.tasks[0]!.phase).toBe(3);
  });

  it("resets non-terminal non-active tasks to draft", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    // Both are ready after compile
    expect(board.tasks[0]!.status).toBe("ready");
    expect(board.tasks[1]!.status).toBe("ready");

    // Edit A's title — this resets non-terminal non-active tasks to draft
    const result = applyEdits(
      board,
      [{ id: "t-1.1", type: "data", data: { title: "New A" } }],
      NOW,
    );
    // Both should be reset to draft (no tasks are implementing/reviewing)
    expect(result.tasks[0]!.status).toBe("draft");
    expect(result.tasks[1]!.status).toBe("draft");
  });

  it("does not reset done/abandoned tasks", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);
    // Phase 1 active, A ready, B configured (phase 2 pending)
    board = claimReadyTasks(board, 1, NOW).board;
    board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW); // → reviewing
    board = applyEdits(board, [completeTask("t-1.1")], NOW); // → done

    // Now phase 1 is done, phase 2 active, B is ready
    expect(board.tasks[1]!.status).toBe("ready");

    // But we can't do data edits while B is not implementing/reviewing...
    // Actually, data edits are blocked when ANY task is implementing/reviewing, not the other way.
    // And there are no implementing/reviewing tasks, so data edits are fine
    // But it will reset B from ready to draft
    const result = applyEdits(
      board,
      [{ id: "t-2.1", type: "data", data: { title: "New B" } }],
      NOW,
    );
    expect(result.tasks[0]!.status).toBe("done"); // A stays done
    expect(result.tasks[1]!.status).toBe("draft"); // B reset to draft
  });

  it("rejects when tasks are implementing/reviewing", () => {
    let board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    board = claimReadyTasks(board, 1, NOW).board;
    // task-1 is implementing, task-2 is ready
    expect(board.tasks[0]!.status).toBe("implementing");

    expect(() =>
      applyEdits(board, [{ id: "t-1.2", type: "data", data: { title: "X" } }], NOW),
    ).toThrow(/Cannot edit data while tasks are implementing\/reviewing/);
  });

  it("rejects unknown ids", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-999.1", type: "data", data: { title: "X" } }], NOW),
    ).toThrow(/not found/);
  });

  it("rejects empty title", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { title: "" } }], NOW),
    ).toThrow(/title must be a non-empty string/);
  });

  it("rejects whitespace-only title", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { title: "   " } }], NOW),
    ).toThrow(/title must be a non-empty string/);
  });

  it("rejects empty prompt", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { prompt: "" } }], NOW),
    ).toThrow(/prompt must be a non-empty string/);
  });

  it("rejects empty profile", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { profile: "" } }], NOW),
    ).toThrow(/profile must be a non-empty string/);
  });

  it("rejects invalid phase (0)", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { phase: 0 } }], NOW),
    ).toThrow(/phase must be an integer >= 1/);
  });

  it("rejects invalid phase (negative)", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { phase: -1 } }], NOW),
    ).toThrow(/phase must be an integer >= 1/);
  });

  it("rejects non-integer phase", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "data", data: { phase: 1.5 } }], NOW),
    ).toThrow(/phase must be an integer >= 1/);
  });

  it("accepts valid data edits for title, prompt, profile, and phase", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = applyEdits(
      board,
      [
        {
          id: "t-1.1",
          type: "data",
          data: { title: "New Title", prompt: "New Prompt", profile: "new-profile", phase: 3 },
        },
      ],
      NOW,
    );
    expect(result.tasks[0]!.title).toBe("New Title");
    expect(result.tasks[0]!.prompt).toBe("New Prompt");
    expect(result.tasks[0]!.profile).toBe("new-profile");
    expect(result.tasks[0]!.phase).toBe(3);
  });
});

// ═══════════════════════════════════════════
// 7. applyEdits — blockers
// ═══════════════════════════════════════════

describe("applyEdits — blockers", () => {
  it("replaces dependency list", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);
    // B depends on A. Now change B's deps.
    // But B is configured, data edits are fine since no one is implementing/reviewing
    const result = applyEdits(
      board,
      [{ id: "t-1.2", type: "blockers", data: { dependencies: [] } }],
      NOW,
    );
    expect(result.tasks[1]!.dependencies).toEqual([]);
  });

  it("rejects self-dependency", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(
        board,
        [{ id: "t-1.1", type: "blockers", data: { dependencies: ["t-1.1"] } }],
        NOW,
      ),
    ).toThrow(/cannot depend on itself/);
  });

  it("rejects references to nonexistent tasks", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(() =>
      applyEdits(
        board,
        [
          {
            id: "t-1.1",
            type: "blockers",
            data: { dependencies: ["t-999.1"] },
          },
        ],
        NOW,
      ),
    ).toThrow(/non-existent dependencies/);
  });

  it("resets non-terminal non-active tasks to draft", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    // Both ready. Change B's deps.
    const result = applyEdits(
      board,
      [{ id: "t-1.2", type: "blockers", data: { dependencies: [] } }],
      NOW,
    );
    // Both reset to draft
    expect(result.tasks[0]!.status).toBe("draft");
    expect(result.tasks[1]!.status).toBe("draft");
  });

  it("rejects duplicate dependencies", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    expect(() =>
      applyEdits(
        board,
        [
          {
            id: "t-1.2",
            type: "blockers",
            data: { dependencies: ["t-1.1", "t-1.1"] },
          },
        ],
        NOW,
      ),
    ).toThrow(/duplicate dependencies/);
  });

  it("rejects when tasks are implementing/reviewing", () => {
    let board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    board = claimReadyTasks(board, 1, NOW).board;
    expect(board.tasks[0]!.status).toBe("implementing");

    expect(() =>
      applyEdits(board, [{ id: "t-1.1", type: "blockers", data: { dependencies: [] } }], NOW),
    ).toThrow(/Cannot edit blockers while tasks are implementing\/reviewing/);
  });
});

// ═══════════════════════════════════════════
// 8. applyEdits — atomicity
// ═══════════════════════════════════════════

describe("applyEdits — atomicity", () => {
  it("if any edit in a batch fails, none are applied", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);
    // Both ready. Try to advance task-1 (valid) and abandon task-999 (invalid)
    expect(() =>
      applyEdits(
        board,
        [
          { id: "t-1.1", type: "advance" }, // can't advance from ready
          { id: "t-999.1", type: "abandon" }, // doesn't exist
        ],
        NOW,
      ),
    ).toThrow();

    // Board should be unchanged
    expect(board.tasks[0]!.status).toBe("ready");
    expect(board.tasks[1]!.status).toBe("ready");
  });

  it("batch of valid data edits is applied atomically", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);

    const result = applyEdits(
      board,
      [
        { id: "t-1.1", type: "data", data: { title: "New A" } },
        { id: "t-1.2", type: "data", data: { title: "New B" } },
      ],
      NOW,
    );

    expect(result.tasks[0]!.title).toBe("New A");
    expect(result.tasks[1]!.title).toBe("New B");
    // Both reset to draft
    expect(result.tasks[0]!.status).toBe("draft");
    expect(result.tasks[1]!.status).toBe("draft");
  });

  it("batch with one bad edit rolls back all", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 1 },
    ]);

    expect(() =>
      applyEdits(
        board,
        [
          { id: "t-1.1", type: "data", data: { title: "New A" } },
          { id: "t-999.1", type: "data", data: { title: "New Z" } },
        ],
        NOW,
      ),
    ).toThrow(/not found/);

    // Original board unchanged
    expect(board.tasks[0]!.title).toBe("A");
    expect(board.tasks[1]!.title).toBe("B");
  });

  it("empty edits returns a clone", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = applyEdits(board, [], NOW);
    expect(result).toEqual(board);
    expect(result).not.toBe(board); // different reference
  });
});
