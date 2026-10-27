import { beforeEach, describe, expect, it } from "vitest";
import { formatContinuePrompt } from "../formatting";
import { createWorkflowGateTool, createClearTasksTool } from "../tools";
import { createEmptyBoard } from "../engine";
import { executionActivityIssue, currentWorkOwner } from "../control-journal";
import { executionAcceptanceIssue } from "../execution-settlement";
import { lifecycle } from "./helpers/lifecycle";
import { startSupervisor } from "../supervisor";
import { getBoard, resetState, setBoard } from "../state";
import { currentRuntime } from "../runtime";
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
          spec: { version: 1, kind: "choice" },
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
        id: expect.stringMatching(/^decision-[a-f0-9-]{36}$/),
        taskId: "t-1.1",
        question: "Which compatibility policy should be used?",
      },
    });
    expect(getBoard().workflowStatus).toBe("waiting_for_decision");
  });

  it("keeps an unowned volatile execution barrier even when a fileless adapter loses its task fields", async () => {
    const h = createMockAPI(),
      ctx = createMockContext();
    setBoard(board("implementing"));
    const bound = await createWorkflowGateTool(h.api).execute(
      "bind-volatile",
      {
        action: "bind_execution",
        taskId: "t-1.1",
        executionRef: { source: "workflow", runId: "unverified-memory-run" },
      },
      undefined,
      undefined,
      ctx,
    );
    expect(bound.isError).not.toBe(true);
    setBoard(createEmptyBoard());
    const cleared = await createClearTasksTool(h.api).execute(
      "clear-lost-memory",
      {},
      undefined,
      undefined,
      ctx,
    );
    expect(cleared.isError).toBe(true);
    expect(executionActivityIssue(ctx.sessionManager.getSessionId())).toBeDefined();
    expect(executionActivityIssue("different-session")).toBeUndefined();
    expect(currentRuntime().executionMemoryBindings).toMatchObject([
      { sessionId: ctx.sessionManager.getSessionId(), owner: null },
    ]);
    expect(currentRuntime().supervisor).toBeUndefined();
    expect(currentRuntime().goal).toBeUndefined();
  });

  it("keeps a fileless Goal-owned binding unverified rather than dropping it with task fields", async () => {
    const h = lifecycle();
    setBoard(board("implementing"));
    startSupervisor(h.mock.api, h.ctx, "Synthetic volatile supervised work");
    const owner = currentWorkOwner(h.ctx.sessionManager.getSessionId());
    if (!owner) throw Error("Missing memory fixture owner");
    const result = await createWorkflowGateTool(h.mock.api).execute(
      "owned-volatile",
      {
        action: "bind_execution",
        taskId: "t-1.1",
        executionRef: { source: "pi-subagents", runId: "owned-volatile-run" },
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.isError).not.toBe(true);
    setBoard(createEmptyBoard());
    expect(executionAcceptanceIssue(owner)).toContain("unverified");
    expect(executionActivityIssue(h.ctx.sessionManager.getSessionId())).toBeDefined();
    const cleared = await createClearTasksTool(h.mock.api).execute(
      "clear-volatile",
      {},
      undefined,
      undefined,
      h.ctx,
    );
    expect(cleared.isError).toBe(true);
  });

  it("holds all later mutations when a waiting proposal snapshot write fails", async () => {
    const mockAPI = createMockAPI();
    const tool = createWorkflowGateTool(mockAPI.api);
    setBoard(board("implementing"));
    mockAPI.appendEntry
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("disk full after memory leaf update");
      });
    const result = await tool.execute(
      "proposal",
      {
        action: "wait_for_decision",
        taskId: "t-1.1",
        decision: {
          question: "Approve?",
          whyUserOwned: "new scope",
          spec: { version: 1, kind: "authorization", scope: "Local changes", prohibitions: [] },
        },
      },
      undefined,
      undefined,
      createMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(currentRuntime().journalFault).toMatch(/persistence/i);
    const later = await tool.execute(
      "later",
      {
        action: "bind_execution",
        taskId: "t-1.1",
        executionRef: { source: "workflow", runId: "must-not-bind" },
      },
      undefined,
      undefined,
      createMockContext(),
    );
    expect(later.isError).toBe(true);
    expect(getBoard().tasks[0]!.executionRef).toBeUndefined();
    expect(mockAPI.appendEntry).toHaveBeenCalledTimes(2);
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
          spec: { version: 1, kind: "information", format: "text" },
        },
      },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { error?: string } };

    expect(result.details.error).toMatch(/Independent actionable tasks remain/);
  });

  it("binds an exact external receipt but cannot clear it without an execution-owner transport", async () => {
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
    expect(cleared.details.error).toContain("Execution-owner transport unavailable");
    expect(cleared.details.snapshot.tasks[0]!.executionRef).toEqual(executionRef);
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
