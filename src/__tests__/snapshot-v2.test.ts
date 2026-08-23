import { describe, expect, it } from "vitest";
import { applyEdits, compileBoard, createEmptyBoard, writeTasks } from "../engine";
import { reconstructState } from "../state";
import { isValidSnapshot } from "../validation";
import type { TaskBoardSnapshot } from "../types";
import { createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";

describe("snapshot v2 contract", () => {
  it("freezes the final acceptance task when compiling a board", () => {
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Implement",
            tasks: [{ title: "Implement", prompt: "Implement", profile: "worker" }],
          },
          {
            title: "Accept",
            tasks: [{ title: "Final acceptance", prompt: "Verify", profile: "reviewer" }],
          },
        ],
      },
      NOW,
    );

    board = applyEdits(
      board,
      [{ id: "t-2.1", type: "blockers", data: { dependencies: ["t-1.1"] } }],
      NOW,
    );
    const compiled: TaskBoardSnapshot = compileBoard(board, NOW, "t-2.1");

    expect(compiled).toMatchObject({
      version: 2,
      workflowStatus: "active",
      finalAcceptanceTaskId: "t-2.1",
      stagnantSettles: 0,
    });
    expect(compiled.generation).toBe(board.generation + 1);
  });

  it("rejects a final acceptance task that does not depend on every earlier task", () => {
    let board = createEmptyBoard();
    board = writeTasks(
      board,
      {
        mode: "replace",
        phases: [
          {
            title: "Implement",
            tasks: [{ title: "Implement", prompt: "Implement", profile: "worker" }],
          },
          {
            title: "Accept",
            tasks: [{ title: "Final acceptance", prompt: "Verify", profile: "reviewer" }],
          },
        ],
      },
      NOW,
    );

    expect(() => compileBoard(board, NOW, "t-2.1")).toThrow(
      /Final acceptance task must depend on every earlier task/,
    );
  });

  it("migrates a legacy upstream snapshot to an inactive v2 board", () => {
    const context = createMockContext([
      {
        type: "custom",
        customType: "phased-tasks:snapshot",
        data: {
          version: 1,
          tasks: [
            {
              id: "t-1.1",
              title: "Legacy task",
              prompt: "Continue",
              profile: "worker",
              phase: 1,
              dependencies: [],
              status: "ready",
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          phases: [{ phase: 1, status: "active", title: "Legacy" }],
        },
      },
    ]);

    expect(reconstructState(context)).toMatchObject({
      version: 2,
      generation: 1,
      workflowStatus: "inactive",
      tasks: [{ id: "t-1.1", status: "ready" }],
      stagnantSettles: 0,
    });
  });

  it("rejects a completed snapshot with unfinished tasks", () => {
    expect(
      isValidSnapshot({
        version: 2,
        generation: 3,
        workflowStatus: "completed",
        finalAcceptanceTaskId: "t-1.1",
        stagnantSettles: 0,
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
        phases: [{ phase: 1, status: "active", title: "Accept" }],
      }),
    ).toBe(false);
  });
});
