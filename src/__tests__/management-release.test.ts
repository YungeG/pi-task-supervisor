import { expect, it } from "vitest";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { getBoardRef } from "../state";
import { BOUNDARY } from "./helpers/lifecycle";
import { readControlJournal, currentWorkOwner } from "../control-journal";
import { createWriteTasksTool } from "../tools";

it.each(["before", "memory", "after"] as const)(
  "cold-inspects a %s task bootstrap mode publication and explicitly repairs metadata without replaying business",
  async (failure) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    try {
      await f.command("disable");
      f.fail((_type, value) => {
        const data = value as { kind?: string; mode?: string; state?: string };
        return data.kind === "session-mode-changed" &&
          data.mode === "tasks" &&
          data.state === "stopping-with-attention"
          ? failure
          : undefined;
      });
      await f.command("tasks-only");
      expect(currentRuntime().journalFault).toBeDefined();
      f.fail(() => undefined);
      f.reload();
      f.sendMessage.mockClear();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      await f.command("tasks-only");
      expect(currentRuntime().management).toMatchObject({
        mode: "tasks",
        state: "active",
        activeWorkOwner: { kind: "board" },
      });
      expect(getBoardRef().tasks).toHaveLength(0);
      expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    } finally {
      f.close();
    }
  },
);

it.each(["before", "memory", "after"] as const)(
  "holds a %s replacement-mode publication until explicit same-board metadata repair",
  async (failure) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    const tool = createWriteTasksTool(f.api);
    const input = (title: string) => ({
      mode: "replace" as const,
      phases: [
        {
          title: "Independent work",
          tasks: [{ title, prompt: "Owned fixed task definition", profile: "main" }],
        },
      ],
    });
    try {
      await f.command("disable");
      await f.command("tasks-only");
      expect(
        (
          await tool.execute(
            "initial-light-board",
            input("Original light task"),
            undefined,
            undefined,
            f.ctx,
          )
        ).isError,
      ).not.toBe(true);
      const previous = currentWorkOwner(f.ctx.sessionManager.getSessionId());
      f.fail((_type, value) => {
        const data = value as { kind?: string; mode?: string; state?: string };
        return data.kind === "session-mode-changed" &&
          data.mode === "tasks" &&
          data.state === "stopping-with-attention"
          ? failure
          : undefined;
      });
      expect(
        (
          await tool.execute(
            "replace-light-board",
            input("Confirmed replacement task"),
            undefined,
            undefined,
            f.ctx,
          )
        ).isError,
      ).toBe(true);
      f.fail(() => undefined);
      f.reload();
      f.sendMessage.mockClear();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(currentRuntime().management?.state).toBe("stopping-with-attention");
      expect(await f.fire("before_agent_start")).toBeUndefined();
      await f.command("tasks-only");
      expect(currentRuntime().management).toMatchObject({
        mode: "tasks",
        state: "active",
        activeWorkOwner: { kind: "board" },
      });
      expect(currentWorkOwner(f.ctx.sessionManager.getSessionId())).not.toEqual(previous);
      expect(getBoardRef().tasks[0]?.title).toBe("Confirmed replacement task");
      expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    } finally {
      f.close();
    }
  },
);

it("completes the same release only after exact metadata repair observes a real later terminal writer", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    await f.command("disable");
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    f.backend.state = "complete";
    const input = { action: "clear_execution", taskId: "t-1.1", executionRef: f.executionRef };
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "exact-stopped-writer-repair",
        toolName: "workflow_gate",
        input,
      }),
    ).toBeUndefined();
    const cleared = await f.invoke("clear_execution");
    expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
    expect(currentRuntime().controlJournal?.executionRegistry?.[0]?.settlement?.data.outcome).toBe(
      "success",
    );
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    f.sendMessage.mockClear();
    await f.command("disable");
    expect(currentRuntime().management).toMatchObject({
      mode: "off",
      state: "active",
      activeWorkOwner: null,
    });
    expect(getBoardRef().tasks[0]?.status).toBe("implementing");
    expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
  } finally {
    f.close();
  }
});

it("settles a late original host result without adopting it as new work or silently finishing the pending release", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  const call = {
    toolCallId: "original-host-intent",
    toolName: "bash",
    input: { command: "synthetic fixed result only" },
  };
  try {
    expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
    await f.command("disable");
    expect(currentRuntime().controlJournal?.pendingHostCaptures).toHaveLength(1);
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    const board = structuredClone(getBoardRef());
    f.sendMessage.mockClear();
    await f.fire("tool_result", {
      type: "tool_result",
      ...call,
      content: [{ type: "text", text: "Owned synthetic result" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    expect(currentRuntime().receiptStore?.pendingCount).toBe(0);
    expect(readControlJournal(f.ctx).pendingHostCaptures).toHaveLength(0);
    expect(currentRuntime().supervisor?.status).toBe("fault");
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    expect(getBoardRef()).toEqual(board);
    expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    await f.command("disable");
    expect(currentRuntime().management?.mode).toBe("off");
  } finally {
    f.close();
  }
});

it.each(["before", "memory", "after"] as const)(
  "cancels before a %s mode append failure and cold-inspects the actual outcome without replay",
  async (failure) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    const runtime = currentRuntime(),
      cancel = runtime.cancel;
    let cancelled = false,
      inspectedCancellation = false;
    try {
      runtime.cancel = () => {
        cancelled = true;
        cancel();
      };
      f.fail((_type, data) => {
        const row = data as { kind?: string; mode?: string };
        if (row.kind !== "session-mode-changed" || row.mode !== "off") return undefined;
        inspectedCancellation = cancelled;
        return failure;
      });
      await f.command("disable");
      expect(inspectedCancellation).toBe(true);
      expect(runtime.management?.state).toBe("stopping-with-attention");
      expect(runtime.journalFault).toBeDefined();
      expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      f.fail(() => undefined);
      f.reload();
      const writes = f.entries().length;
      f.sendMessage.mockClear();
      await f.fire("session_tree");
      expect(f.entries()).toHaveLength(writes);
      expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
      expect(currentRuntime().management?.mode === "off").toBe(failure === "after");
      expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    } finally {
      runtime.cancel = cancel;
      f.close();
    }
  },
);
