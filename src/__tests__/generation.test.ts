import { describe, expect, it } from "vitest";
import { claimReadyTasks, createEmptyBoard } from "../engine";
import { reconstructState, resetState, setBoard } from "../state";
import { createClearTasksTool } from "../tools";
import { isValidSnapshotV2 } from "../validation";
import type { TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";

function readyBoard(generation = 5): TaskBoardSnapshot {
  return {
    version: 2,
    generation,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-1.1",
    stagnantSettles: 4,
    tasks: [
      {
        id: "t-1.1",
        title: "Final acceptance",
        prompt: "Verify",
        profile: "reviewer",
        phase: 1,
        dependencies: [],
        status: "ready",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [{ phase: 1, status: "active" }],
  };
}

describe("generation monotonicity", () => {
  it("increments generation and resets stagnation after a successful claim", () => {
    const result = claimReadyTasks(readyBoard(), 1, NOW);
    expect(result.board).toMatchObject({ generation: 6, stagnantSettles: 0 });
  });

  it("preserves monotonic generation when clearing the board", async () => {
    resetState();
    setBoard(readyBoard());
    const tool = createClearTasksTool(createMockAPI().api);

    const result = (await tool.execute("clear", {}, undefined, undefined, createMockContext())) as {
      details: { snapshot: TaskBoardSnapshot };
    };

    expect(result.details.snapshot).toMatchObject({
      generation: 6,
      workflowStatus: "inactive",
      tasks: [],
    });
  });

  it("rejects generation zero for a persisted v2 snapshot", () => {
    expect(isValidSnapshotV2({ ...createEmptyBoard(), generation: 0 })).toBe(false);
  });

  it("fails closed when later session snapshots regress generation", () => {
    const branch = [
      {
        type: "custom",
        customType: "continuous-tasks:snapshot",
        data: readyBoard(5),
      },
      {
        type: "custom",
        customType: "continuous-tasks:snapshot",
        data: readyBoard(4),
      },
    ];

    expect(reconstructState(createMockContext(branch))).toEqual(createEmptyBoard());
  });
});
