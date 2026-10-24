import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentRuntime } from "../runtime";
import { createEmptyBoard } from "../engine";
import { CUSTOM_EVENT_TYPE, CUSTOM_SNAPSHOT_TYPE } from "../types";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, reconstructState, resetState, setBoard } from "../state";
import { SUPERVISOR_ENTRY } from "../supervisor";
import {
  createAdvanceTasksTool,
  createClearTasksTool,
  createCompileTasksTool,
  createEditTasksTool,
  createGetReadyTasksTool,
  createWriteTasksTool,
} from "../tools";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";

type Harness = ReturnType<typeof lifecycle>;
type Outcome = Awaited<ReturnType<ReturnType<typeof createGetReadyTasksTool>["execute"]>>;
const toolNames = [
  "write_tasks",
  "edit_tasks",
  "compile_tasks",
  "clear_tasks",
  "get_ready_tasks",
  "advance_tasks",
] as const;

function prepare(name: (typeof toolNames)[number]): void {
  if (name === "write_tasks") setBoard(createEmptyBoard());
  else if (name === "compile_tasks") {
    const board = activeBoard({ workflowStatus: "inactive", finalAcceptanceTaskId: undefined });
    for (const task of board.tasks) task.status = "draft";
    setBoard(board);
  } else if (name === "advance_tasks") {
    const board = activeBoard();
    board.tasks[0]!.status = "implementing";
    setBoard(board);
  }
}

function operation(h: Harness, name: (typeof toolNames)[number]) {
  switch (name) {
    case "write_tasks": {
      const input = {
        mode: "replace" as const,
        phases: [{ title: "Plan", tasks: [{ title: "Work", prompt: "Work", profile: "main" }] }],
      };
      return {
        input,
        execute: () =>
          createWriteTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      };
    }
    case "edit_tasks": {
      const input = { tasks: [{ id: "t-1.1", type: "data" as const, data: { title: "Updated" } }] };
      return {
        input,
        execute: () =>
          createEditTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      };
    }
    case "compile_tasks": {
      const input = { finalAcceptanceTaskId: "t-2.1" };
      return {
        input,
        execute: () =>
          createCompileTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      };
    }
    case "clear_tasks": {
      const input = {};
      return {
        input,
        execute: () =>
          createClearTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      };
    }
    case "get_ready_tasks": {
      const input = { count: 1 };
      return {
        input,
        execute: () =>
          createGetReadyTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      };
    }
    case "advance_tasks": {
      const input = { transitions: [{ id: "t-1.1" }] };
      return {
        input,
        execute: () =>
          createAdvanceTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      };
    }
  }
}

async function hostRun(
  h: Harness,
  name: string,
  input: Record<string, unknown>,
  execute: () => Promise<Outcome>,
): Promise<Outcome> {
  expect(
    await h.fire("tool_call", { type: "tool_call", toolName: name, toolCallId: "update", input }),
  ).toBeUndefined();
  let result: Outcome;
  try {
    result = await execute();
  } catch (error) {
    // SDK-style error result for an execute function that throws instead of returning isError.
    result = {
      content: [{ type: "text", text: error instanceof Error ? error.message : "Host error" }],
      details: undefined,
      isError: true,
    } as unknown as Outcome;
  }
  await h.fire("tool_result", {
    type: "tool_result",
    toolName: name,
    toolCallId: "update",
    input,
    ...result,
    isError: result.isError === true,
  });
  return result;
}

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(true);
  setBoard(activeBoard());
});

describe("task update persistence admission", () => {
  it("closes admission across claim, execute, error result and the next call after append fails", async () => {
    const advisor = vi.fn(async () => ({
      advice: {
        action: "next_batch" as const,
        message: "Continue the ready batch",
        taskIds: ["t-1.1"],
        evidenceRefs: [],
      },
    }));
    const h = lifecycle(advisor);
    await h.command("supervise Complete the approved synthetic board");
    const before = getBoard();
    const input = { count: 1 };
    expect(
      await h.fire("tool_call", {
        toolName: "get_ready_tasks",
        toolCallId: "failed-claim",
        input,
      }),
    ).toBeUndefined();
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("Synthetic persistence I/O failure");
    });
    const result = await createGetReadyTasksTool(h.mock.api).execute(
      "failed-claim",
      input,
      undefined,
      undefined,
      h.ctx,
    );
    await h.fire("tool_result", {
      type: "tool_result",
      toolName: "get_ready_tasks",
      toolCallId: "failed-claim",
      input,
      ...result,
      isError: result.isError === true,
    });
    const next = await h.fire("tool_call", {
      toolName: "advance_tasks",
      toolCallId: "after-failed-claim",
      input: { transitions: [{ id: "t-1.1" }] },
    });
    expect(result.isError).toBe(true);
    expect(getBoard()).toEqual(before);
    expect(result.details.snapshot).toEqual(before);
    expect(currentRuntime().journalFault).toContain("persistence");
    expect(next).toMatchObject({ block: true });
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(advisor).not.toHaveBeenCalled();
  });

  it.each(
    toolNames.flatMap((name) =>
      ["event-before", "event-after", "snapshot-before", "snapshot-after"].map((fault) => ({
        name,
        fault,
      })),
    ),
  )("closes $name after uncertain persistence at $fault", async ({ name, fault }) => {
    prepare(name);
    const before = getBoard();
    const h = lifecycle();
    const op = operation(h, name);
    const append = h.mock.appendEntry.getMockImplementation() as (
      type: string,
      data: unknown,
    ) => void;
    let failed = false;
    h.mock.appendEntry.mockImplementation((type: string, data: unknown) => {
      const target = fault.startsWith("event") ? CUSTOM_EVENT_TYPE : CUSTOM_SNAPSHOT_TYPE;
      if (!failed && type === target) {
        failed = true;
        if (fault.endsWith("after")) append(type, data);
        throw new Error("Synthetic append uncertainty");
      }
      append(type, data);
    });
    const result = await hostRun(h, name, op.input, op.execute);
    const next = await h.fire("tool_call", {
      type: "tool_call",
      toolName: "write_tasks",
      toolCallId: "must-not-retry",
      input: {
        mode: "append",
        phases: [{ title: "Next", tasks: [{ title: "Next", prompt: "Next", profile: "main" }] }],
      },
    });
    expect(failed).toBe(true);
    expect(result.isError).toBe(true);
    expect(getBoard()).toEqual(before);
    expect(currentRuntime().journalFault).toContain("persistence");
    expect(next).toMatchObject({ block: true });
    if (fault === "snapshot-after") {
      expect(
        h.ctx.sessionManager
          .getBranch()
          .some((entry) => entry.type === "custom" && entry.customType === CUSTOM_SNAPSHOT_TYPE),
      ).toBe(true);
    }
  });

  it.each(toolNames)(
    "keeps committed %s successful when a custom UI adapter throws synchronously",
    async (name) => {
      prepare(name);
      const h = lifecycle();
      // This is fault injection into a custom adapter, not a default RPC disconnection test.
      Object.assign(h.ctx, { mode: "rpc" });
      vi.mocked(h.ctx.ui.setStatus).mockImplementation(() => {
        throw new Error("Synthetic synchronous UI failure");
      });
      const op = operation(h, name);
      const result = await hostRun(h, name, op.input, op.execute);
      expect(result.isError).not.toBe(true);
      expect(result.details.snapshot).toEqual(getBoard());
      expect(reconstructState(h.ctx)).toEqual(getBoard());
      expect(currentRuntime().journalFault).toBeUndefined();
    },
  );

  it("retains safe I/O diagnostics while redacting secret-like failure text", async () => {
    const h = lifecycle();
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("password=synthetic-private-value");
    });
    const op = operation(h, "get_ready_tasks");
    const result = await hostRun(h, "get_ready_tasks", op.input, op.execute);
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("[redacted]");
    expect(currentRuntime().journalFault).toContain("persistence");
    expect(JSON.stringify(result).includes("synthetic-private-value")).toBe(false);
  });

  it("does not commit a previously admitted update after an intervening persistence fault", async () => {
    const h = lifecycle();
    const input = {
      mode: "append" as const,
      phases: [
        { title: "Queued", tasks: [{ title: "Queued", prompt: "Queued", profile: "main" }] },
      ],
    };
    expect(
      await h.fire("tool_call", {
        toolName: "write_tasks",
        toolCallId: "already-admitted",
        input,
      }),
    ).toBeUndefined();
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("Synthetic earlier persistence failure");
    });
    const claim = operation(h, "get_ready_tasks");
    await hostRun(h, "get_ready_tasks", claim.input, claim.execute);
    const before = getBoard();
    const entries = h.mock.appendEntry.mock.calls.length;
    const result = await createWriteTasksTool(h.mock.api).execute(
      "already-admitted",
      input,
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.isError).toBe(true);
    expect(getBoard()).toEqual(before);
    expect(h.mock.appendEntry).toHaveBeenCalledTimes(entries);
  });

  it.each(["before", "after"])(
    "closes admission if the completion binding checkpoint fails %s append",
    async (fault) => {
      setBoard(
        activeBoard({
          finalAcceptanceTaskId: "t-1.1",
          tasks: [{ ...activeBoard().tasks[0]!, status: "reviewing" }],
          phases: [{ phase: 1, status: "active" }],
        }),
      );
      const h = lifecycle();
      await h.command("supervise Verify the approved synthetic work");
      await h.fire("tool_result", {
        type: "tool_result",
        toolName: "bash",
        toolCallId: "review-proof",
        input: { command: "synthetic validation" },
        content: [{ type: "text", text: "Synthetic validation passed" }],
        structuredContent: { exit_code: 0 },
        isError: false,
      });
      const before = getBoard();
      const append = h.mock.appendEntry.getMockImplementation() as (
        type: string,
        data: unknown,
      ) => void;
      let failed = false;
      h.mock.appendEntry.mockImplementation((type: string, data: unknown) => {
        if (!failed && type === SUPERVISOR_ENTRY) {
          failed = true;
          if (fault === "after") append(type, data);
          throw new Error("Synthetic binding checkpoint failure");
        }
        append(type, data);
      });
      const input = {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Review verified",
              refs: [
                {
                  kind: "command" as const,
                  label: "validation",
                  status: "passed" as const,
                  ref: "tool:review-proof",
                  exitCode: 0,
                },
              ],
            },
          },
        ],
      };
      const result = await hostRun(h, "advance_tasks", input, () =>
        createAdvanceTasksTool(h.mock.api).execute("update", input, undefined, undefined, h.ctx),
      );
      expect(failed).toBe(true);
      expect(result.isError).toBe(true);
      expect(getBoard()).toEqual(before);
      expect(reconstructState(h.ctx).tasks[0]!.status).toBe("done");
      expect(currentRuntime().journalFault).toContain("persistence");
      expect(
        await h.fire("tool_call", {
          toolName: "compile_tasks",
          toolCallId: "after-binding-failure",
          input: { finalAcceptanceTaskId: "t-1.1" },
        }),
      ).toMatchObject({ block: true });
    },
  );
});
