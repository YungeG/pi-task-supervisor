import { beforeEach, describe, expect, it } from "vitest";
import { formatContinuePrompt } from "../formatting";
import { createWorkflowGateTool } from "../tools";
import { getBoard, resetState, setBoard } from "../state";
import type { TaskBoardSnapshot } from "../types";
import { isValidSnapshotV2 } from "../validation";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";

function board(status: "ready" | "implementing" = "ready"): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 5,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-1.1",
    stagnantSettles: 0,
    tasks: [
      {
        id: "t-1.1",
        title: "Current task",
        prompt: "Continue",
        profile: "worker",
        phase: 1,
        dependencies: [],
        status,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [{ phase: 1, status: "active", title: "Current" }],
  };
}

describe("workflow_gate", () => {
  beforeEach(() => {
    resetState();
  });

  it("enters a structured user decision gate", async () => {
    const mockAPI = createMockAPI();
    const tool = createWorkflowGateTool(mockAPI.api);
    setBoard(board());

    const result = (await tool.execute(
      "gate",
      {
        action: "wait_for_decision",
        taskId: "t-1.1",
        decision: {
          question: "Which compatibility policy should be used?",
          whyUserOwned: "This changes the supported product contract",
          options: ["strict", "compatible"],
        },
      },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { snapshot: TaskBoardSnapshot; error?: string } };

    expect(result.details.error).toBeUndefined();
    expect(result.details.snapshot).toMatchObject({
      workflowStatus: "waiting_for_decision",
      decision: {
        id: "decision-6",
        taskId: "t-1.1",
        question: "Which compatibility policy should be used?",
      },
    });
    expect(getBoard().workflowStatus).toBe("waiting_for_decision");
  });

  it("rejects waiting while another independent task remains actionable", async () => {
    const mockAPI = createMockAPI();
    const tool = createWorkflowGateTool(mockAPI.api);
    setBoard({
      ...board(),
      tasks: [
        ...board().tasks,
        {
          ...board().tasks[0]!,
          id: "t-1.2",
          title: "Independent task",
        },
      ],
    });

    const result = (await tool.execute(
      "gate",
      {
        action: "wait_for_decision",
        taskId: "t-1.1",
        decision: {
          question: "Choose",
          whyUserOwned: "Product decision",
        },
      },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { error?: string } };

    expect(result.details.error).toMatch(/Independent actionable tasks remain/);
  });

  it("binds and clears an exact external execution receipt", async () => {
    const mockAPI = createMockAPI();
    const tool = createWorkflowGateTool(mockAPI.api);
    setBoard(board("implementing"));
    const executionRef = { source: "pi-subagents" as const, runId: "run-123" };

    const bound = (await tool.execute(
      "gate",
      { action: "bind_execution", taskId: "t-1.1", executionRef },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { snapshot: TaskBoardSnapshot; error?: string } };
    expect(bound.details.error).toBeUndefined();
    expect(bound.details.snapshot.tasks[0]!.executionRef).toEqual(executionRef);

    const cleared = (await tool.execute(
      "gate",
      { action: "clear_execution", taskId: "t-1.1", executionRef },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { snapshot: TaskBoardSnapshot; error?: string } };
    expect(cleared.details.error).toBeUndefined();
    expect(cleared.details.snapshot.tasks[0]!.executionRef).toBeUndefined();
  });

  it("warns continuations to inspect an existing run instead of relaunching", () => {
    const value = {
      ...board("implementing"),
      tasks: board("implementing").tasks.map((task) => ({
        ...task,
        executionRef: { source: "pi-subagents" as const, runId: "run-123" },
      })),
    };

    expect(formatContinuePrompt(value)).toContain(
      "Existing pi-subagents run run-123; inspect it and do not launch a duplicate writer.",
    );
  });

  it("rejects malformed restored gate state", () => {
    expect(
      isValidSnapshotV2({
        ...board("implementing"),
        tasks: board("implementing").tasks.map((task) => ({
          ...task,
          executionRef: { source: "unknown", runId: "run-123" },
        })),
      }),
    ).toBe(false);
    expect(
      isValidSnapshotV2({
        ...board(),
        workflowStatus: "waiting_for_decision",
        decision: {
          id: "decision-6",
          question: "Choose",
          whyUserOwned: "Product decision",
          createdAt: NOW,
        },
      }),
    ).toBe(false);
  });

  it("rejects replacing an existing execution receipt", async () => {
    const mockAPI = createMockAPI();
    const tool = createWorkflowGateTool(mockAPI.api);
    setBoard({
      ...board("implementing"),
      tasks: board("implementing").tasks.map((task) => ({
        ...task,
        executionRef: { source: "workflow" as const, runId: "existing-run" },
      })),
    });

    const result = (await tool.execute(
      "gate",
      {
        action: "bind_execution",
        taskId: "t-1.1",
        executionRef: { source: "workflow", runId: "replacement-run" },
      },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { error?: string } };

    expect(result.details.error).toMatch(/already has an execution receipt/);
  });
});
