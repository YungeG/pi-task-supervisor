import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { registerEventHandlers } from "../events";
import { startSupervisor, supervisorState } from "../supervisor";
import { createAdvanceTasksTool } from "../tools";
import { getBoard, resetState, setBoard } from "../state";
import { setSessionScopeEnabled } from "../scope";
import type { CompletionEvidence, TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";
const board: TaskBoardSnapshot = {
  version: 2,
  generation: 4,
  workflowStatus: "active",
  finalAcceptanceTaskId: "t-1.1",
  stagnantSettles: 0,
  tasks: [
    {
      id: "t-1.1",
      title: "Accept",
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
function evidence(ref = "tool:validation"): CompletionEvidence {
  return {
    summary: "Validation passed",
    refs: [{ kind: "command", label: "tests", status: "passed", exitCode: 0, ref }],
  };
}
function setup() {
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" } });
  startSupervisor(mock.api, ctx, "Verify approved work");
  registerEventHandlers(mock.api);
  const handler = mock.on.mock.calls.find(([name]) => name === "tool_result")?.[1] as (
    event: ToolResultEvent,
    context: ReturnType<typeof createMockContext>,
  ) => void;
  const observe = (
    id = "validation",
    toolName = "bash",
    exitCode: number | null = 0,
    isError = false,
  ) => {
    handler(
      {
        type: "tool_result",
        toolCallId: id,
        toolName,
        input: { command: "npm test" },
        content: [{ type: "text", text: "validation output" }],
        details: {},
        ...(exitCode === null ? {} : { structuredContent: { exit_code: exitCode } }),
        isError,
      },
      ctx,
    );
  };
  const advance = (proof = evidence()) =>
    createAdvanceTasksTool(mock.api).execute(
      "advance",
      { transitions: [{ id: "t-1.1", evidence: proof }] },
      undefined,
      undefined,
      ctx,
    );
  return { mock, ctx, observe, advance };
}

describe("supervised host evidence", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(board);
  });

  it("rejects a claimed successful command that the host never ran", async () => {
    const { advance } = setup();
    const result = await advance();
    expect(result).toMatchObject({
      isError: true,
      details: { error: expect.stringContaining("host receipt") },
    });
    expect(getBoard().tasks[0]?.status).toBe("reviewing");
  });

  it.each([
    [1, false],
    [0, true],
    [null, false],
  ] as const)("rejects failed or unobserved host exit code %s (%s)", async (exitCode, isError) => {
    const { observe, advance } = setup();
    observe("validation", "bash", exitCode, isError);
    expect(await advance()).toHaveProperty("isError", true);
    expect(getBoard().tasks[0]?.status).toBe("reviewing");
  });

  it("invalidates validation after another potentially mutating tool", async () => {
    const { observe, advance } = setup();
    observe();
    observe("write", "edit", null);
    expect(await advance()).toHaveProperty("isError", true);
  });

  it("cannot reuse evidence from an earlier task review", async () => {
    const { observe, advance } = setup();
    observe();
    setBoard({
      ...board,
      tasks: board.tasks.map((task) => ({ ...task, updatedAt: "2026-08-24T00:00:00.000Z" })),
    });
    expect(await advance()).toHaveProperty("isError", true);
  });

  it("requires a command rather than treating reading an artifact as validation", async () => {
    const { observe, advance } = setup();
    observe("validation", "read", null);
    const proof = evidence();
    proof.refs[0]!.kind = "review";
    expect(await advance(proof)).toHaveProperty("isError", true);
  });

  it("does not overwrite a task board changed while phase configuration loads", async () => {
    const { observe, advance } = setup();
    observe();
    const pending = advance();
    setBoard({ ...board, generation: 6, workflowStatus: "paused", pauseReason: "human pause" });
    expect(await pending).toHaveProperty("isError", true);
    expect(getBoard()).toMatchObject({ generation: 6, workflowStatus: "paused" });
  });

  it("exposes receipt IDs without dropping the host structured result", () => {
    const { mock, ctx } = setup();
    const handler = mock.on.mock.calls.find(([name]) => name === "tool_result")?.[1];
    const result = handler(
      {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "visible-proof",
        input: { command: "npm test" },
        content: [{ type: "text", text: "pass" }],
        structuredContent: { exit_code: 0 },
        isError: false,
      },
      ctx,
    );
    expect(result.structuredContent).toEqual({ exit_code: 0 });
    expect(result.content[1].text).toContain("tool:visible-proof");
  });

  it("does not duplicate receipts or invent successful exit codes for arbitrary tool output", () => {
    const { observe } = setup();
    observe();
    observe();
    observe("reader", "read", null);
    expect(supervisorState()?.receipts).toHaveLength(2);
    expect(supervisorState()?.epoch).toBe(1);
    expect(supervisorState()?.receipts[1]?.exitCode).toBeUndefined();
  });

  it("treats unrelated tools whose names end in _tasks as potentially mutating", async () => {
    const { observe, advance } = setup();
    observe();
    observe("external", "external_tasks", null);
    expect(await advance()).toHaveProperty("isError", true);
  });

  it("binds completion to a genuine successful validation receipt", async () => {
    const { observe, advance } = setup();
    observe();
    const result = await advance();
    expect(result.details).not.toHaveProperty("error");
    expect(getBoard().workflowStatus).toBe("completed");
    expect(supervisorState()?.bindings).toMatchObject([
      { taskId: "t-1.1", refs: ["tool:validation"] },
    ]);
  });
});
