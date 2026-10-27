import { expect, it } from "vitest";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { getBoardRef, resetState } from "../state";
import { goalFixture } from "./helpers/goal";
import { rmSync } from "node:fs";
import { TASK_TOOL_NAMES } from "../scope";
import { BOUNDARY } from "./helpers/lifecycle";
import { currentWorkOwner } from "../control-journal";
import { createWriteTasksTool } from "../tools";

it.each([false, "legacy", true] as const)(
  "disables a quiescent %s owner without requiring unfinished tasks to be done and persists off across tree restore",
  async (kind) => {
    const f = await executionRegistryFixture(kind, { gitWorkspace: true });
    const board = structuredClone(getBoardRef());
    try {
      await f.command("disable");
      expect(currentRuntime().enabled).toBe(false);
      expect(
        (f.setActiveTools.mock.calls.at(-1)?.[0] as string[]).some((name) =>
          TASK_TOOL_NAMES.includes(name),
        ),
      ).toBe(false);
      expect(getBoardRef().tasks).toEqual(board.tasks);
      expect(await f.fire("before_agent_start")).toBeUndefined();
      expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      const receipts = currentRuntime().receiptStore?.stats.count;
      const call = {
        toolName: "write",
        toolCallId: "new-unmanaged-write",
        input: { path: "unmanaged.txt", content: "Owned fixture only" },
      };
      expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
      expect(
        await f.fire("tool_result", {
          type: "tool_result",
          ...call,
          content: [{ type: "text", text: "Owned fixture result" }],
          isError: false,
        }),
      ).toBeUndefined();
      expect(currentRuntime().receiptStore?.stats.count).toBe(receipts);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(currentRuntime().enabled).toBe(false);
      expect(await f.fire("before_agent_start")).toBeUndefined();
      expect(
        await f.fire("tool_call", {
          type: "tool_call",
          ...call,
          toolCallId: "restored-unmanaged-write",
        }),
      ).toBeUndefined();
    } finally {
      f.close();
    }
  },
);
it("enables a new task-only board after detach without reviving the old Supervisor, Goal grant or scoped evidence", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  const previousOwner = structuredClone(f.owner);
  try {
    await f.command("disable");
    await f.command("enable");
    expect(currentRuntime().management?.mode).toBe("tasks");
    const owner = currentWorkOwner(f.ctx.sessionManager.getSessionId());
    expect(owner?.kind).toBe("board");
    expect(owner).not.toEqual(previousOwner);
    expect(getBoardRef().tasks).toHaveLength(0);
    const input = {
      mode: "replace" as const,
      phases: [
        {
          title: "Independent light board",
          tasks: [{ title: "New task", prompt: "Independent fixed fixture task", profile: "main" }],
        },
      ],
    };
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolName: "write_tasks",
        toolCallId: "new-light-board",
        input,
      }),
    ).toBeUndefined();
    const result = await createWriteTasksTool(f.api).execute(
      "new-light-board",
      input,
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError).not.toBe(true);
    const snapshot = f
      .entries()
      .filter((entry) => entry.customType === "continuous-tasks:snapshot")
      .at(-1)?.data as { version?: number };
    expect(snapshot.version).toBe(2);
    expect(getBoardRef().tasks[0]?.title).toBe("New task");
    expect(currentRuntime().supervisor?.status).toBe("stopped");
    const selectedOwner = currentWorkOwner(f.ctx.sessionManager.getSessionId());
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentWorkOwner(f.ctx.sessionManager.getSessionId())).toEqual(selectedOwner);
    expect(getBoardRef().tasks[0]?.title).toBe("New task");
    const context = await f.fire("before_agent_start");
    expect(JSON.stringify({ context })).not.toContain(
      previousOwner.kind === "goal" ? previousOwner.goal.goalRunId! : "no-old-goal",
    );
  } finally {
    f.close();
  }
});
it("uses explicit planning/approval/first-start for fresh supervise rather than a history-dependent legacy shortcut", async () => {
  resetState();
  const f = await goalFixture({ emptyBoard: true, unsupervisedLegacy: true, gitWorkspace: true });
  try {
    f.sendMessage.mockClear();
    await f.command("supervise New explicitly managed work");
    expect(currentRuntime().preflight).toMatchObject({
      goal: "New explicitly managed work",
      phase: "planning",
    });
    expect(currentRuntime().supervisor).toBeUndefined();
    expect(currentRuntime().management?.mode).toBe("supervised");
    expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(1);
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolName: "write",
        toolCallId: "before-independent-start",
        input: { path: "not-started" },
      }),
    ).toMatchObject({ block: true });
  } finally {
    currentRuntime().cancel();
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it("closes an actually unstarted scoped Goal through its native owner before completing off", async () => {
  resetState();
  const f = await goalFixture({ gitWorkspace: true });
  try {
    await f.command("supervise Owned unstarted management goal");
    expect(currentRuntime().goal?.current?.supervisor).toBeNull();
    expect(currentRuntime().goal?.current?.phase).toBe("planning");
    await f.command("stop");
    expect(currentRuntime().goal?.current).toMatchObject({
      phase: "stopped",
      disposition: "closed-unstarted",
      supervisor: null,
    });
    expect(currentRuntime().management).toMatchObject({
      mode: "off",
      state: "active",
      activeWorkOwner: null,
    });
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().management?.mode).toBe("off");
    expect(await f.fire("before_agent_start")).toBeUndefined();
  } finally {
    currentRuntime().cancel();
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it("stop releases known quiescent scoped work for ordinary new tools without lending its old Goal permission", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const owner = structuredClone(f.owner);
    await f.command("stop");
    expect(currentRuntime().enabled).toBe(false);
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "new-unmanaged-git",
        input: { command: "git status --short" },
      }),
    ).toBeUndefined();
    expect(currentWorkOwner(f.ctx.sessionManager.getSessionId())).not.toEqual(owner);
    expect(await f.fire("before_agent_start")).toBeUndefined();
  } finally {
    f.close();
  }
});
it("cancels local automation before refusing release of an unresolved writer and keeps its exact reference", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  const runtime = currentRuntime(),
    originalCancel = runtime.cancel;
  let cancelled = 0;
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    const binding = structuredClone(runtime.controlJournal!.executionRegistry![0]!.binding);
    runtime.cancel = () => {
      cancelled++;
      originalCancel();
    };
    await f.command("disable");
    expect(cancelled).toBeGreaterThan(0);
    expect(runtime.controlJournal!.executionRegistry![0]!.binding).toEqual(binding);
    expect(getBoardRef().tasks[0]?.executionRef).toEqual(f.executionRef);
    expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolName: "write",
        toolCallId: "unknown-writer-must-not-detach",
        input: { path: "not-started" },
      }),
    ).toMatchObject({ block: true });
  } finally {
    runtime.cancel = originalCancel;
    f.close();
  }
});
it("allows a known failed but settled/released execution to remain history without resolution or forced task completion", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    f.backend.state = "failed";
    expect((await f.invoke("clear_execution")).isError).not.toBe(true);
    await f.command("disable");
    expect(currentRuntime().enabled).toBe(false);
    expect(currentRuntime().controlJournal?.executionRegistry?.[0]).toMatchObject({
      settlement: { data: { outcome: "failure" } },
    });
    expect(currentRuntime().controlJournal?.executionRegistry?.[0]?.resolution).toBeUndefined();
    expect(getBoardRef().tasks[0]?.status).toBe("implementing");
  } finally {
    f.close();
  }
});
it("does not turn close_unknown recovery into quiescence proof or restart automation after disable", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolName: "bash",
        toolCallId: "missing-owned-result",
        input: { command: "synthetic no-result fixture" },
      }),
    ).toBeUndefined();
    await f.command("disable");
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    f.sendMessage.mockClear();
    await f.command("recover");
    expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    await f.command("disable");
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    expect(currentRuntime().controlJournal?.pendingHostCaptures).toHaveLength(1);
  } finally {
    f.close();
  }
});
it("does not accept model-controlled mode or context fields as an escape from a real managed pause", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    await f.command("pause");
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolName: "write",
        toolCallId: "forged-context",
        input: { path: "not-started", managed: false, mode: "off", workContext: "unmanaged" },
      }),
    ).toMatchObject({ block: true });
  } finally {
    f.close();
  }
});
