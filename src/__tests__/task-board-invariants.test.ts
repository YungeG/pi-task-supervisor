import { startSupervisor } from "../supervisor";
import { beforeEach, describe, expect, it } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, reconstructState, resetState, setBoard } from "../state";
import { applyEdits, createEmptyBoard } from "../engine";
import { createCompileTasksTool, createEditTasksTool, createWriteTasksTool } from "../tools";
import { isValidSnapshotV2 } from "../validation";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(true);
  setBoard(activeBoard());
});

describe("task-board compilation invariants", () => {
  it("invalidates old compilation before saving a phase edit and keeps every snapshot restorable", async () => {
    const h = lifecycle();
    startSupervisor(h.mock.api, h.ctx, "Complete the approved synthetic board");
    const edit = createEditTasksTool(h.mock.api);
    const input = {
      tasks: [{ id: "t-1.1", type: "data" as const, data: { phase: 3 } }],
    };
    expect(
      await h.fire("tool_call", { toolCallId: "move", toolName: "edit_tasks", input }),
    ).toBeUndefined();
    const moved = await edit.execute("move", input, undefined, undefined, h.ctx);
    expect(moved.isError).not.toBe(true);
    expect(getBoard()).toMatchObject({
      workflowStatus: "inactive",
      finalAcceptanceTaskId: undefined,
      phases: [
        { phase: 2, status: "pending" },
        { phase: 3, status: "pending" },
      ],
    });
    expect(isValidSnapshotV2(getBoard())).toBe(true);
    expect(reconstructState(h.ctx)).toEqual(getBoard());

    const relocatedFinal = await edit.execute(
      "move-final",
      { tasks: [{ id: "t-2.1", type: "data", data: { phase: 4 } }] },
      undefined,
      undefined,
      h.ctx,
    );
    expect(relocatedFinal.isError).not.toBe(true);
    const compiled = await createCompileTasksTool(h.mock.api).execute(
      "recompile",
      { finalAcceptanceTaskId: "t-2.1" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(compiled.isError).not.toBe(true);
    expect(getBoard()).toMatchObject({
      workflowStatus: "active",
      tasks: [
        { id: "t-1.1", phase: 3, status: "ready" },
        { id: "t-2.1", phase: 4, status: "configured" },
      ],
    });
    expect(reconstructState(h.ctx)).toEqual(getBoard());
  });

  it.each(["paused", "waiting_for_decision"] as const)(
    "does not replace a %s gate with inactive compilation metadata",
    async (workflowStatus) => {
      const board = activeBoard({
        workflowStatus,
        ...(workflowStatus === "paused"
          ? { pauseReason: "Human maintenance" }
          : {
              decision: {
                id: "scope-choice",
                taskId: "t-1.1",
                question: "Choose the scope",
                whyUserOwned: "The user owns scope",
                spec: { version: 1, kind: "choice" },
                options: ["A", "B"],
                createdAt: "2026-10-24T00:00:00.000Z",
              },
            }),
      });
      setBoard(board);
      const h = lifecycle();
      expect(
        await h.fire("tool_call", {
          toolCallId: "held-edit",
          toolName: "edit_tasks",
          input: { tasks: [{ id: "t-1.1", type: "data", data: { phase: 3 } }] },
        }),
      ).toMatchObject({ block: true });
      expect(() =>
        applyEdits(
          board,
          [{ id: "t-1.1", type: "data", data: { phase: 3 } }],
          "2026-10-24T00:00:00.000Z",
        ),
      ).toThrow("task-board gate");
      expect(getBoard()).toEqual(board);
      expect(h.mock.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("rejects an unfinished future dependency instead of activating a deadlock", async () => {
    setBoard(createEmptyBoard());
    const h = lifecycle();
    await createWriteTasksTool(h.mock.api).execute(
      "write",
      {
        mode: "replace",
        phases: ["A", "B", "Final"].map((title) => ({
          title,
          tasks: [{ title, prompt: title, profile: "worker" }],
        })),
      },
      undefined,
      undefined,
      h.ctx,
    );
    await createEditTasksTool(h.mock.api).execute(
      "dependencies",
      {
        tasks: [
          { id: "t-1.1", type: "blockers", data: { dependencies: ["t-2.1"] } },
          { id: "t-3.1", type: "blockers", data: { dependencies: ["t-1.1"] } },
        ],
      },
      undefined,
      undefined,
      h.ctx,
    );
    const before = getBoard();
    const result = await createCompileTasksTool(h.mock.api).execute(
      "compile-deadlock",
      { finalAcceptanceTaskId: "t-3.1" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.details).toHaveProperty("error", expect.stringContaining("future phase"));
    expect(getBoard()).toEqual(before);
  });

  it.each(["dependency-done", "waiter-done"])(
    "does not reject a future-phase reference that cannot deadlock: %s",
    async (kind) => {
      const initial = activeBoard();
      const proof = {
        summary: "Previously completed work",
        refs: [{ kind: "review" as const, label: "review", status: "passed" as const }],
      };
      setBoard(
        activeBoard({
          finalAcceptanceTaskId: "t-3.1",
          tasks: [
            {
              ...initial.tasks[0]!,
              dependencies: ["t-2.1"],
              status: kind === "waiter-done" ? "done" : "configured",
              ...(kind === "waiter-done" ? { completionEvidence: proof } : {}),
            },
            {
              ...initial.tasks[1]!,
              dependencies: [],
              status: kind === "dependency-done" ? "done" : "configured",
              ...(kind === "dependency-done" ? { completionEvidence: proof } : {}),
            },
            { ...initial.tasks[1]!, id: "t-3.1", phase: 3, dependencies: ["t-1.1"] },
          ],
          phases: [1, 2, 3].map((phase) => ({ phase, status: "pending" })),
        }),
      );
      const h = lifecycle();
      const result = await createCompileTasksTool(h.mock.api).execute(
        "compile-history",
        { finalAcceptanceTaskId: "t-3.1" },
        undefined,
        undefined,
        h.ctx,
      );
      expect(result.isError).not.toBe(true);
      expect(getBoard().tasks.find((task) => task.status === "ready")?.id).toBe(
        kind === "dependency-done" ? "t-1.1" : "t-2.1",
      );
      expect(reconstructState(h.ctx)).toEqual(getBoard());
    },
  );

  it.each(["done", "abandoned"] as const)(
    "keeps a terminal board-only workflow completed after recompilation: %s",
    async (status) => {
      const initial = activeBoard();
      const proof = {
        summary: "Previously reviewed",
        refs: [{ kind: "review" as const, label: "review", status: "passed" as const }],
      };
      setBoard(
        activeBoard({
          workflowStatus: "completed",
          tasks: [
            {
              ...initial.tasks[0]!,
              status,
              ...(status === "done" ? { completionEvidence: proof } : {}),
            },
            { ...initial.tasks[1]!, status: "done", completionEvidence: proof },
          ],
          phases: [1, 2].map((phase) => ({ phase, status: "completed" })),
        }),
      );
      expect(isValidSnapshotV2(getBoard())).toBe(true);
      const h = lifecycle();
      const input = { finalAcceptanceTaskId: "t-2.1" };
      expect(
        await h.fire("tool_call", {
          toolCallId: "terminal-recompile",
          toolName: "compile_tasks",
          input,
        }),
      ).toBeUndefined();
      const result = await createCompileTasksTool(h.mock.api).execute(
        "terminal-recompile",
        input,
        undefined,
        undefined,
        h.ctx,
      );
      expect(result.isError).not.toBe(true);
      expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      expect(getBoard().workflowStatus).toBe("completed");
      expect(reconstructState(h.ctx)).toEqual(getBoard());
    },
  );
});
