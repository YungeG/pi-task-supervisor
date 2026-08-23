import { describe, it, expect } from "vitest";
import type { TaskRecord, TaskBoardSnapshot } from "../types";
import { STATUS_ICONS } from "../types";
import {
  phaseLabel,
  formatBoardText,
  formatSummaryLine,
  formatClaimedTaskDetails,
  formatHiddenContext,
  formatContinuePrompt,
  formatAllDoneMessage,
} from "../formatting";
import { createEmptyBoard } from "../engine";
import { NOW, makeCompiledBoard, makeBoardWithStatuses } from "./helpers/engine-helpers";

// ═══════════════════════════════════════════
// phaseLabel
// ═══════════════════════════════════════════

describe("phaseLabel", () => {
  it("returns label with title when phase record has a title", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(phaseLabel(board, 1)).toBe("Phase 1: Phase 1");
  });

  it("returns plain phase number when no matching phase record", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    expect(phaseLabel(board, 99)).toBe("Phase 99");
  });

  it("returns plain phase number when phase record has no title", () => {
    const board: TaskBoardSnapshot = {
      ...createEmptyBoard(),
      phases: [{ phase: 2, status: "pending" }],
    };
    expect(phaseLabel(board, 2)).toBe("Phase 2");
  });
});

// ═══════════════════════════════════════════
// formatBoardText
// ═══════════════════════════════════════════

describe("formatBoardText", () => {
  it("returns 'No tasks on the board.' for empty board", () => {
    const board = createEmptyBoard();
    expect(formatBoardText(board)).toBe("No tasks on the board.");
  });

  it("formats a single-phase board with tasks", () => {
    const board = makeCompiledBoard([
      { title: "Task A", prompt: "Do A", profile: "coder", phase: 1 },
      { title: "Task B", prompt: "Do B", profile: "coder", phase: 1 },
    ]);

    const result = formatBoardText(board);
    expect(result).toContain("Task Board:");
    expect(result).toContain("─── Phase 1: Phase 1 ───");
    expect(result).toContain(`${STATUS_ICONS.ready} t-1.1: Task A`);
    expect(result).toContain(`${STATUS_ICONS.ready} t-1.2: Task B`);
    expect(result).toContain("Summary: 2 ready");
  });

  it("formats a multi-phase board", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
      { title: "C", prompt: "P", profile: "c", phase: 1 },
    ]);

    const result = formatBoardText(board);
    // Phase 1 section should appear before phase 2 section
    const phase1Idx = result.indexOf("─── Phase 1:");
    const phase2Idx = result.indexOf("─── Phase 2:");
    expect(phase1Idx).toBeGreaterThan(0);
    expect(phase2Idx).toBeGreaterThan(phase1Idx);

    expect(result).toContain("t-1.1: A");
    expect(result).toContain("t-1.2: C");
    expect(result).toContain("t-2.1: B");
  });

  it("shows dependencies with → depends on", () => {
    const board = makeCompiledBoard([
      { title: "First", prompt: "P", profile: "c", phase: 1 },
      { title: "Second", prompt: "P", profile: "c", phase: 1, dependencies: ["t-1.1"] },
    ]);

    const result = formatBoardText(board);
    expect(result).toContain("t-1.2: Second → depends on t-1.1");
  });

  it("shows multiple dependencies joined by comma", () => {
    const board = makeBoardWithStatuses([
      { title: "A", phase: 1, status: "ready" },
      { title: "B", phase: 1, status: "configured", dependencies: ["t-1.1", "other-id"] },
    ]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatBoardText(board);
    expect(result).toContain("→ depends on t-1.1, other-id");
  });

  it("respects activePhaseOnly: true option showing only the active phase", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);
    // After compile, phase 1 is active, phase 2 is pending
    const result = formatBoardText(board, { activePhaseOnly: true });
    expect(result).toContain("Phase 1:");
    expect(result).not.toContain("Phase 2:");
  });

  it("shows all phases when activePhaseOnly: true but no active phase exists", () => {
    const board = makeBoardWithStatuses([
      { title: "A", phase: 1, status: "done" },
      { title: "B", phase: 2, status: "done" },
    ]);
    // No phases set → no active phase → should show all
    board.phases = [];

    const result = formatBoardText(board, { activePhaseOnly: true });
    // Both tasks appear (both phases shown)
    expect(result).toContain("Phase 1");
    expect(result).toContain("Phase 2");
  });

  it("includes summary line at the bottom across all phases", () => {
    // Use makeBoardWithStatuses to control statuses across phases
    const board = makeBoardWithStatuses([
      { title: "A", phase: 1, status: "ready" },
      { title: "B", phase: 2, status: "ready" },
    ]);
    board.phases = [
      { phase: 1, status: "active" },
      { phase: 2, status: "pending" },
    ];

    const result = formatBoardText(board);
    // Summary always covers all phases
    expect(result).toMatch(/Summary:.*2 ready/);
    // Summary is the last line
    const lines = result.split("\n");
    const lastNonEmpty = lines.filter((l) => l.trim() !== "").pop()!;
    expect(lastNonEmpty).toMatch(/^Summary:/);
  });
});

// ═══════════════════════════════════════════
// formatSummaryLine
// ═══════════════════════════════════════════

describe("formatSummaryLine", () => {
  it("includes phase label and done counts when active phase exists", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);

    const result = formatSummaryLine(board);
    expect(result).toContain("Phase 1:");
    expect(result).toContain("0/2 done");
  });

  it("shows just counts when no active phase", () => {
    const board = makeBoardWithStatuses([
      { title: "A", phase: 1, status: "done" },
      { title: "B", phase: 1, status: "done" },
    ]);
    board.phases = [];

    const result = formatSummaryLine(board);
    expect(result).toBe("2/2 done");
    expect(result).not.toContain("Phase");
  });

  it("counts abandoned as done for the summary", () => {
    const board = makeBoardWithStatuses([
      { title: "A", phase: 1, status: "done" },
      { title: "B", phase: 1, status: "abandoned" },
      { title: "C", phase: 1, status: "ready" },
    ]);
    board.phases = [];

    const result = formatSummaryLine(board);
    expect(result).toBe("2/3 done");
  });

  it("returns 0/0 done for empty board", () => {
    const board = createEmptyBoard();
    expect(formatSummaryLine(board)).toBe("0/0 done");
  });
});

// ═══════════════════════════════════════════
// formatClaimedTaskDetails
// ═══════════════════════════════════════════

describe("formatClaimedTaskDetails", () => {
  function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
    return {
      id: "t-1.1",
      title: "Test Task",
      prompt: "Line 1",
      profile: "coder",
      phase: 1,
      dependencies: [],
      status: "implementing",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("formats a single task with short prompt", () => {
    const task = makeTask({ prompt: "Do the thing" });
    const result = formatClaimedTaskDetails([task]);
    expect(result).toContain(`${STATUS_ICONS.implementing} t-1.1: Test Task  (coder)`);
    expect(result).toContain("Do the thing");
  });

  it("shows profile in parentheses", () => {
    const task = makeTask({ profile: "special-agent" });
    const result = formatClaimedTaskDetails([task]);
    expect(result).toContain("(special-agent)");
  });

  it("truncates prompts longer than 3 lines and shows (truncated)", () => {
    const task = makeTask({ prompt: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5" });
    const result = formatClaimedTaskDetails([task]);
    expect(result).toContain("Line 1");
    expect(result).toContain("Line 2");
    expect(result).toContain("Line 3");
    expect(result).not.toContain("Line 4");
    expect(result).not.toContain("Line 5");
    expect(result).toContain("... (truncated)");
  });

  it("does NOT show (truncated) for exactly 3-line prompts", () => {
    const task = makeTask({ prompt: "Line 1\nLine 2\nLine 3" });
    const result = formatClaimedTaskDetails([task]);
    expect(result).not.toContain("(truncated)");
  });

  it("formats multiple tasks separated by blank lines", () => {
    const tasks = [
      makeTask({ id: "t-1.1", title: "Task A" }),
      makeTask({ id: "t-1.2", title: "Task B" }),
    ];
    const result = formatClaimedTaskDetails(tasks);
    expect(result).toContain("t-1.1: Task A");
    expect(result).toContain("t-1.2: Task B");
    // Separated by double newline
    expect(result).toContain("\n\n");
  });
});

// ═══════════════════════════════════════════
// formatHiddenContext
// ═══════════════════════════════════════════

describe("formatHiddenContext", () => {
  it("includes [PHASED TASKS ACTIVE] header", () => {
    const board = createEmptyBoard();
    const result = formatHiddenContext(board);
    expect(result).toContain("[PHASED TASKS ACTIVE]");
  });

  it("includes Active Phase: line", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = formatHiddenContext(board);
    expect(result).toContain("Active Phase: Phase 1: Phase 1");
  });

  it("shows 'none' for active phase when no phases", () => {
    const board = createEmptyBoard();
    const result = formatHiddenContext(board);
    expect(result).toContain("Active Phase: none");
  });

  it("includes Status: line with counts", () => {
    const board = makeCompiledBoard([{ title: "A", prompt: "P", profile: "c", phase: 1 }]);
    const result = formatHiddenContext(board);
    expect(result).toContain("Status:");
    expect(result).toContain("1 ready");
  });

  it("includes Workflow: line", () => {
    const board = createEmptyBoard();
    const result = formatHiddenContext(board);
    expect(result).toContain("Workflow: write_tasks");
  });

  it("shows 'Currently claimed:' section for implementing tasks", () => {
    const board = makeBoardWithStatuses([
      { title: "Active Task", phase: 1, status: "implementing" },
    ]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatHiddenContext(board);
    expect(result).toContain("Currently claimed:");
    expect(result).toContain(`${STATUS_ICONS.implementing} [t-1.1] Active Task`);
  });

  it("shows 'Currently claimed:' section for reviewing tasks", () => {
    const board = makeBoardWithStatuses([{ title: "Review Task", phase: 1, status: "reviewing" }]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatHiddenContext(board);
    expect(result).toContain("Currently claimed:");
    expect(result).toContain(`${STATUS_ICONS.reviewing} [t-1.1] Review Task`);
  });

  it("shows 'Remaining tasks:' section for non-terminal tasks", () => {
    const board = makeBoardWithStatuses([{ title: "Ready Task", phase: 1, status: "ready" }]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatHiddenContext(board);
    expect(result).toContain("Remaining tasks:");
    expect(result).toContain(`${STATUS_ICONS.ready} t-1.1: Ready Task`);
  });

  it("does not include terminal tasks in Remaining tasks", () => {
    const board = makeBoardWithStatuses([{ title: "Done", phase: 1, status: "done" }]);
    board.phases = [{ phase: 1, status: "completed" }];

    const result = formatHiddenContext(board);
    const remainingIdx = result.indexOf("Remaining tasks:");
    const remainingSection = result.slice(remainingIdx, result.indexOf("\n\n", remainingIdx));
    // "Remaining tasks:" header is there but no task entries follow
    expect(remainingSection.trim()).toBe("Remaining tasks:");
  });

  it("shows 'Recently completed:' section for done/abandoned tasks", () => {
    const board = makeBoardWithStatuses([
      { title: "Finished", phase: 1, status: "done" },
      { title: "Cancelled", phase: 1, status: "abandoned" },
    ]);
    board.phases = [{ phase: 1, status: "completed" }];

    const result = formatHiddenContext(board);
    expect(result).toContain("Recently completed:");
    expect(result).toContain(`${STATUS_ICONS.done} t-1.1: Finished`);
    expect(result).toContain(`${STATUS_ICONS.abandoned} t-1.2: Cancelled`);
  });

  it("shows overflow message when more than 10 recently completed tasks", () => {
    const tasks: Array<{ title: string; phase: number; status: "done"; dependencies?: string[] }> =
      [];
    for (let i = 1; i <= 12; i++) {
      tasks.push({ title: `Task ${i}`, phase: 1, status: "done" });
    }
    const board = makeBoardWithStatuses(tasks);
    board.phases = [{ phase: 1, status: "completed" }];

    const result = formatHiddenContext(board);
    expect(result).toContain("... and 2 more terminal tasks");
    // Should still show exactly 10 recently completed entries
    const recentlySection = result.slice(result.indexOf("Recently completed:"));
    const completedLines = recentlySection
      .split("\n")
      .filter(
        (l) =>
          l.trim().startsWith(STATUS_ICONS.done) || l.trim().startsWith(STATUS_ICONS.abandoned),
      );
    expect(completedLines).toHaveLength(10);
  });

  it("sorts recently completed by updatedAt descending", () => {
    const board = makeBoardWithStatuses([
      { title: "Older", phase: 1, status: "done" },
      { title: "Newer", phase: 1, status: "done" },
    ]);
    board.phases = [{ phase: 1, status: "completed" }];
    // Override updatedAt to control ordering
    board.tasks[0]!.updatedAt = "2025-01-01T00:00:00.000Z";
    board.tasks[1]!.updatedAt = "2025-01-02T00:00:00.000Z";

    const result = formatHiddenContext(board);
    const recentlyIdx = result.indexOf("Recently completed:");
    const section = result.slice(recentlyIdx);
    const newerIdx = section.indexOf("Newer");
    const olderIdx = section.indexOf("Older");
    expect(newerIdx).toBeLessThan(olderIdx);
  });
});

// ═══════════════════════════════════════════
// formatContinuePrompt
// ═══════════════════════════════════════════

describe("formatContinuePrompt", () => {
  it("shows 'Ready to claim' when ready tasks exist", () => {
    const board = makeBoardWithStatuses([{ title: "A", phase: 1, status: "ready" }]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatContinuePrompt(board);
    expect(result).toContain("Tasks remain. Continue working on the phased task board.");
    expect(result).toContain("Ready to claim: 1 task(s). Call get_ready_tasks to claim them.");
  });

  it("shows 'Currently claimed' when implementing tasks exist", () => {
    const board = makeBoardWithStatuses([{ title: "Active", phase: 1, status: "implementing" }]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatContinuePrompt(board);
    expect(result).toContain("Currently claimed:");
    expect(result).toContain("[t-1.1] Active (implementing)");
  });

  it("shows 'Currently claimed' when reviewing tasks exist", () => {
    const board = makeBoardWithStatuses([{ title: "Under Review", phase: 1, status: "reviewing" }]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatContinuePrompt(board);
    expect(result).toContain("Currently claimed:");
    expect(result).toContain("[t-1.1] Under Review (reviewing)");
  });

  it("shows blocked message for deadlock (non-terminal, not ready/active)", () => {
    const board = makeBoardWithStatuses([{ title: "Blocked", phase: 1, status: "configured" }]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatContinuePrompt(board);
    expect(result).toContain("The task board is blocked");
    expect(result).toContain("Blocked tasks:");
    expect(result).toContain("[t-1.1] Blocked (configured,");
  });

  it("returns empty string when all tasks are terminal", () => {
    const board = makeBoardWithStatuses([
      { title: "Done", phase: 1, status: "done" },
      { title: "Abandoned", phase: 1, status: "abandoned" },
    ]);
    board.phases = [{ phase: 1, status: "completed" }];

    const result = formatContinuePrompt(board);
    expect(result).toBe("");
  });

  it("returns empty string for empty board", () => {
    const board = createEmptyBoard();
    expect(formatContinuePrompt(board)).toBe("");
  });

  it("includes both ready count and active tasks when both exist", () => {
    const board = makeBoardWithStatuses([
      { title: "Working", phase: 1, status: "implementing" },
      { title: "Waiting", phase: 1, status: "ready" },
    ]);
    board.phases = [{ phase: 1, status: "active" }];

    const result = formatContinuePrompt(board);
    expect(result).toContain("Currently claimed:");
    expect(result).toContain("Ready to claim: 1 task(s)");
  });
});

// ═══════════════════════════════════════════
// formatAllDoneMessage
// ═══════════════════════════════════════════

describe("formatAllDoneMessage", () => {
  it("returns generic message when phases array is empty", () => {
    const board = createEmptyBoard();
    expect(formatAllDoneMessage(board)).toBe("All tasks resolved.");
  });

  it("includes last phase label when phases exist", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 2 },
    ]);
    // makeCompiledBoard sets phase titles as "Phase N"
    const result = formatAllDoneMessage(board);
    expect(result).toBe("All tasks resolved. Phase 2: Phase 2 complete.");
  });

  it("uses the last phase in the phases array", () => {
    const board = makeCompiledBoard([
      { title: "A", prompt: "P", profile: "c", phase: 1 },
      { title: "B", prompt: "P", profile: "c", phase: 3 },
      { title: "C", prompt: "P", profile: "c", phase: 5 },
    ]);
    // makeCompiledBoard re-numbers phases as 1,2,3 with titles "Phase 1", "Phase 3", "Phase 5"
    const lastPhaseNum = board.phases[board.phases.length - 1]!.phase;
    const lastPhaseTitle = board.phases[board.phases.length - 1]!.title;
    const result = formatAllDoneMessage(board);
    expect(result).toBe(`All tasks resolved. Phase ${lastPhaseNum}: ${lastPhaseTitle} complete.`);
  });
});
