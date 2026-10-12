import type { Usage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { registerCommands } from "../commands";
import { registerEventHandlers } from "../events";
import { currentRuntime } from "../runtime";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import { supervisorState, SUPERVISOR_ENTRY, type Advice, type Advisor } from "../supervisor";
import {
  activeBoard,
  ACTIVATION,
  BOUNDARY,
  deferred,
  getHandler,
  lifecycle,
} from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const guide: Advice = {
  action: "guide",
  message: "Complete approved implementation",
  taskIds: ["t-1.1"],
  evidenceRefs: [],
};
const accept: Advice = {
  ...guide,
  action: "accept",
  message: "All work verified",
  evidenceRefs: [],
};

describe("supervisor stopping and recovery policy", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    currentRuntime().journalFault = undefined;
  });

  it.each([
    { ...guide, taskIds: ["invented-task"] },
    { ...guide, evidenceRefs: ["invented-proof"] },
    { ...guide, message: "token=secret-value-123456" },
    { ...guide, message: '{"api_key":"quoted-private-value"}' },
    accept,
    { ...guide, action: "waive-validation" },
  ])("turns invalid or premature advice into a visible fault", async (advice) => {
    const h = lifecycle(async () => ({ advice }) as Awaited<ReturnType<Advisor>>);
    await h.command("supervise Complete approved work");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({ status: "fault", pending: false });
    expect(h.mock.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ display: true, content: expect.stringContaining("Supervisor:") }),
      { triggerTurn: false },
    );
  });

  it("honors an advisor hold without claiming acceptance or resolving decisions", async () => {
    const h = lifecycle(async () => ({
      advice: { ...guide, action: "hold", message: "Missing explicit deployment authority" },
    }));
    await h.command("supervise Complete approved work");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "paused",
      reason: "Missing explicit deployment authority",
    });
    expect(getBoard().workflowStatus).toBe("active");
    expect(await h.fire("before_agent_start")).toBeUndefined();
    expect(await h.fire("tool_call", { toolName: "advance_tasks", input: {} })).toMatchObject({
      block: true,
    });
  });

  it("does not let recovery approve a board pause or waiting decision", async () => {
    const h = lifecycle(async () => ({ advice: guide }));
    await h.command("supervise Complete approved work");
    await h.command("pause maintenance");
    h.mock.sendMessage.mockClear();
    await h.command("recover");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("gate first"),
      "error",
    );
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    await h.command("resume");
    expect(supervisorState()?.status).toBe("active");
    expect(h.mock.sendMessage).toHaveBeenCalledOnce();
    expect(h.mock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "continuous-tasks:continue" }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("clears the supervisor status when the session shuts down", async () => {
    const h = lifecycle();
    await h.command("supervise Complete approved work");
    await h.fire("session_shutdown");
    expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("continuous-supervisor", undefined);
  });

  it("stops without falling back to automatic board continuation", async () => {
    const advisor = vi.fn<Advisor>(async () => ({ advice: guide }));
    const h = lifecycle(advisor);
    await h.command("supervise Complete approved work");
    await h.command("stop");
    expect(supervisorState()?.status).toBe("stopped");
    expect(getBoard().workflowStatus).toBe("paused");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(advisor).not.toHaveBeenCalled();
  });

  it("bounds a provider ignoring cancellation and requires explicit recovery", async () => {
    vi.useFakeTimers();
    const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, ms);
      return controller.signal;
    });
    try {
      const reply = deferred<Awaited<ReturnType<Advisor>>>();
      const h = lifecycle(() => reply.promise);
      await h.command("supervise Complete approved work");
      const pending = h.fire("agent_before_settle", BOUNDARY);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await pending).toBeUndefined();
      expect(supervisorState()?.status).toBe("fault");
      reply.resolve({ advice: guide });
      await Promise.resolve();
      expect(supervisorState()?.continuations).toBe(0);
      await h.command("recover");
      expect(supervisorState()?.status).toBe("active");
    } finally {
      timer.mockRestore();
      vi.useRealTimers();
    }
  });

  it("counts real progress, not generation churn or questions, and pauses a loop", async () => {
    const advisor = vi.fn<Advisor>(async () => ({ advice: guide }));
    const h = lifecycle(advisor);
    await h.command("supervise Complete approved work");
    for (let i = 0; i < 3; i++) {
      expect((await h.fire("agent_before_settle", BOUNDARY))?.continue).toBe(true);
      setBoard(activeBoard({ generation: 10 + i }));
      await h.fire("input", { text: "status?" });
    }
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({ status: "paused", stagnant: 3 });
    expect(advisor).toHaveBeenCalledTimes(3);
  });

  it.each([{ reviews: 40 }, { continuations: 20 }])(
    "enforces the persisted call/resume budget",
    async (budget) => {
      const advisor = vi.fn<Advisor>(async () => ({ advice: guide }));
      const h = lifecycle(advisor);
      await h.command("supervise Complete approved work");
      Object.assign(supervisorState()!, budget);
      expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      expect(supervisorState()?.status).toBe("paused");
      expect(advisor).not.toHaveBeenCalled();
    },
  );

  it("rejects non-finite usage instead of corrupting durable state", async () => {
    const usage = { totalTokens: NaN, cost: { total: Infinity } } as Usage;
    const h = lifecycle(async () => ({ advice: guide, usage }));
    await h.command("supervise Complete approved work");
    await h.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({ status: "fault", tokens: 0, cost: 0 });
  });

  it.each(['{"api_key":"quoted-private-value"}', "", "x".repeat(4001)])(
    "rejects unsafe or invalid human goals without recording them",
    async (goal) => {
      const h = lifecycle();
      await h.command(`supervise ${goal}`);
      expect(supervisorState()).toBeUndefined();
      expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
        expect.stringContaining("non-secret"),
        "error",
      );
      expect(h.mock.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized existing plan before recording a supervisor goal", async () => {
    const board = activeBoard();
    setBoard(
      activeBoard({
        tasks: [
          ...Array.from({ length: 100 }, (_, index) => ({
            ...board.tasks[0]!,
            id: `t-1.${index + 1}`,
          })),
          board.tasks[1]!,
        ],
      }),
    );
    const h = lifecycle();
    await h.command("supervise Complete approved work");
    expect(supervisorState()).toBeUndefined();
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("at most 100 tasks"),
      "error",
    );
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it("does not recover an oversized legacy plan into an invalid journal", async () => {
    const h = lifecycle();
    await h.command("supervise Complete approved work");
    await h.command("pause inspect legacy plan");
    // Legacy paused checkpoints have no proven pause origin.
    supervisorState()!.holdCause = undefined;
    await h.command("resume");
    const board = activeBoard();
    setBoard(
      activeBoard({
        tasks: [
          ...Array.from({ length: 100 }, (_, index) => ({
            ...board.tasks[0]!,
            id: `t-1.${index + 1}`,
          })),
          board.tasks[1]!,
        ],
      }),
    );
    h.mock.sendMessage.mockClear();
    await h.command("recover");
    expect(supervisorState()?.status).toBe("paused");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("at most 100 tasks"),
      "error",
    );
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "replace", count: 101, blocked: true },
    { mode: "replace", count: 100, blocked: false },
    { mode: "append", count: 99, blocked: true },
    { mode: "append", count: 98, blocked: false },
  ])(
    "enforces the task ceiling for supervised writes: $mode $count",
    async ({ mode, count, blocked }) => {
      const h = lifecycle();
      await h.command("supervise Complete approved work");
      if (mode === "replace") setBoard(activeBoard({ tasks: [] }));
      const gate = await h.fire("tool_call", {
        toolName: "write_tasks",
        input: {
          mode,
          phases: [
            {
              title: "Plan",
              tasks: Array.from({ length: count }, () => ({
                title: "Work",
                prompt: "Work",
                profile: "worker",
              })),
            },
          ],
        },
      });
      if (blocked)
        expect(gate).toMatchObject({
          block: true,
          reason: expect.stringContaining("at most 100 tasks"),
        });
      else expect(gate).toBeUndefined();
    },
  );

  it("leaves malformed write parameters to host schema validation without crashing its gate", async () => {
    const h = lifecycle();
    await h.command("supervise Complete approved work");
    for (const phases of [undefined, {}, [null, 7, {}, { tasks: {} }, { tasks: [] }]])
      expect(
        await h.fire("tool_call", { toolName: "write_tasks", input: { mode: "append", phases } }),
      ).toBeUndefined();
  });

  it("prevents replacing a goal, discarding the board, or abandoning its requirements", async () => {
    const h = lifecycle();
    await h.command("supervise Goal A");
    await h.command("supervise Goal B");
    expect(supervisorState()?.goal).toBe("Goal A");
    for (const event of [
      { toolName: "clear_tasks", input: {} },
      { toolName: "write_tasks", input: { mode: "replace" } },
      { toolName: "edit_tasks", input: { tasks: [{ id: "t-1.1", type: "abandon" }] } },
    ])
      expect(await h.fire("tool_call", event)).toMatchObject({ block: true });
  });

  it("fails closed on an invalid durable journal, including re-enable attempts", async () => {
    const mock = createMockAPI();
    const ctx = createMockContext([
      ACTIVATION,
      { type: "custom", customType: SUPERVISOR_ENTRY, data: { version: 1, status: "active" } },
    ]);
    registerEventHandlers(mock.api, async () => DEFAULT_CONFIG);
    registerCommands(mock.api);
    await getHandler(mock, "session_start")({}, ctx);
    const command = mock.registerCommand.mock.calls[0]?.[1];
    await command.handler("enable", ctx);
    expect(mock.setActiveTools).toHaveBeenLastCalledWith(["read"]);
    expect(
      await getHandler(mock, "tool_call")({ toolName: "write_tasks", input: {} }, ctx),
    ).toMatchObject({ block: true });
  });

  it("restores an unfinished supervisor as interrupted, never as active-but-idle", async () => {
    const h = lifecycle();
    await h.command("supervise Complete approved work");
    const saved = structuredClone(supervisorState()!);
    const ctx = createMockContext([
      ACTIVATION,
      { type: "custom", customType: SUPERVISOR_ENTRY, data: saved },
    ]);
    await getHandler(h.mock, "session_start")({}, ctx);
    expect(supervisorState()?.status).toBe("fault");
    expect(h.mock.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ display: true, content: expect.stringContaining("recover") }),
      { triggerTurn: false },
    );
  });
});
