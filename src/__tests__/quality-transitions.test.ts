import { beforeEach, describe, expect, it } from "vitest";
import { createAdvanceTasksTool } from "../tools";
import { resetState, setBoard } from "../state";
import type { CompletionEvidence, TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";

function evidence(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {
    summary: "Reviewed and validated",
    refs: [
      {
        kind: "command",
        label: "focused tests",
        status: "passed",
        exitCode: 0,
        ref: "build/focused-tests.txt",
      },
    ],
    ...overrides,
  };
}

function reviewingBoard(): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 4,
    workflowStatus: "active",
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
        status: "reviewing",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [{ phase: 1, status: "active", title: "Accept" }],
  };
}

describe("quality transitions", () => {
  beforeEach(() => {
    resetState();
  });

  it("rejects reviewing to done without completion evidence", async () => {
    const mockAPI = createMockAPI();
    const tool = createAdvanceTasksTool(mockAPI.api);
    setBoard(reviewingBoard());

    const result = (await tool.execute(
      "advance",
      { transitions: [{ id: "t-1.1" }] },
      undefined,
      undefined,
      createMockContext(),
    )) as { content: Array<{ text?: string }>; details?: { error?: string } };

    expect(result.details?.error).toMatch(/completion evidence/i);
    expect(result.content[0]?.text).toMatch(/completion evidence/i);
  });

  it("completes the workflow when final acceptance has valid evidence", async () => {
    const mockAPI = createMockAPI();
    const tool = createAdvanceTasksTool(mockAPI.api);
    setBoard(reviewingBoard());

    const result = (await tool.execute(
      "advance",
      { transitions: [{ id: "t-1.1", evidence: evidence() }] },
      undefined,
      undefined,
      createMockContext(),
    )) as { details: { snapshot: TaskBoardSnapshot; error?: string } };

    expect(result.details.error).toBeUndefined();
    expect(result.details.snapshot).toMatchObject({
      workflowStatus: "completed",
      tasks: [
        {
          id: "t-1.1",
          status: "done",
          completionEvidence: evidence(),
        },
      ],
    });
  });

  it("rejects failed command evidence", async () => {
    const mockAPI = createMockAPI();
    const tool = createAdvanceTasksTool(mockAPI.api);
    setBoard(reviewingBoard());

    const result = (await tool.execute(
      "advance",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: evidence({
              refs: [
                {
                  kind: "command",
                  label: "focused tests",
                  status: "passed",
                  exitCode: 1,
                },
              ],
            }),
          },
        ],
      },
      undefined,
      undefined,
      createMockContext(),
    )) as { details?: { error?: string } };

    expect(result.details?.error).toMatch(/exitCode 0/);
  });

  it("rejects secret-like evidence", async () => {
    const mockAPI = createMockAPI();
    const tool = createAdvanceTasksTool(mockAPI.api);
    setBoard(reviewingBoard());

    const result = (await tool.execute(
      "advance",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: evidence({ summary: "token=secret-value-123456" }),
          },
        ],
      },
      undefined,
      undefined,
      createMockContext(),
    )) as { details?: { error?: string } };

    expect(result.details?.error).toMatch(/secret-like/);
  });

  it("rejects completion evidence before the review state", async () => {
    const mockAPI = createMockAPI();
    const tool = createAdvanceTasksTool(mockAPI.api);
    setBoard({
      ...reviewingBoard(),
      tasks: reviewingBoard().tasks.map((task) => ({ ...task, status: "implementing" })),
    });

    const result = (await tool.execute(
      "advance",
      { transitions: [{ id: "t-1.1", evidence: evidence() }] },
      undefined,
      undefined,
      createMockContext(),
    )) as { details?: { error?: string } };

    expect(result.details?.error).toMatch(/before review/);
  });
});
