import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { registerEventHandlers } from "../events";
import { isSessionScopeEnabled, setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import {
  activeBoard,
  ACTIVATION,
  BOUNDARY,
  deferred,
  getHandler,
  lifecycle,
} from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

// These tests exercise Pi 1.1's actionable boundary; agent_settled is notification-only.
describe("continuous task lifecycle events", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(false);
  });

  it("registers native settlement and compaction hooks, not delayed settled wakeups", () => {
    const { mock } = lifecycle();
    expect(mock.on.mock.calls.map(([name]) => name)).toEqual([
      "session_start",
      "session_tree",
      "session_shutdown",
      "session_before_compact",
      "input",
      "before_agent_start",
      "agent_before_settle",
      "agent_settled",
      "tool_call",
      "tool_result",
    ]);
  });

  it("removes task tools and blocks calls in an unactivated session", async () => {
    const h = lifecycle();
    await h.fire("session_start");
    expect(h.mock.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(await h.fire("tool_call", { toolName: "write_tasks", input: {} })).toMatchObject({
      block: true,
      reason: expect.stringContaining("disabled"),
    });
    expect(await h.fire("tool_call", { toolName: "read", input: {} })).toBeUndefined();
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(await h.fire("before_agent_start")).toBeUndefined();
  });

  it.each(["session_start", "session_tree"])(
    "restores activation and board on %s",
    async (name) => {
      const mock = createMockAPI();
      const ctx = createMockContext([
        ACTIVATION,
        { type: "custom", customType: "continuous-tasks:snapshot", data: activeBoard() },
      ]);
      registerEventHandlers(mock.api);
      await getHandler(mock, name)({}, ctx);
      expect(getBoard()).toEqual(activeBoard());
      expect(isSessionScopeEnabled()).toBe(true);
      expect(mock.setActiveTools).toHaveBeenLastCalledWith(
        expect.arrayContaining(["workflow_gate", "advance_tasks"]),
      );
    },
  );

  it("rejects malformed activation", async () => {
    const mock = createMockAPI();
    const ctx = createMockContext([{ ...ACTIVATION, data: { version: 1, enabled: false } }]);
    registerEventHandlers(mock.api);
    await getHandler(mock, "session_start")({}, ctx);
    expect(isSessionScopeEnabled()).toBe(false);
  });

  it("injects hidden active board context", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    expect(await h.fire("before_agent_start")).toMatchObject({
      message: { display: false, content: expect.stringContaining("Active Phase") },
    });
    for (const workflowStatus of [
      "inactive",
      "paused",
      "waiting_for_decision",
      "completed",
    ] as const) {
      setBoard(activeBoard({ workflowStatus }));
      expect(await h.fire("before_agent_start")).toBeUndefined();
    }
  });

  it("returns one hidden native continuation without a countdown or sendMessage wakeup", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    expect(await h.fire("agent_before_settle", BOUNDARY)).toMatchObject({
      continue: true,
      entries: [
        { customType: "continuous-tasks:continue", display: false, details: { generation: 3 } },
      ],
    });
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
    expect(h.ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it.each([
    { ...BOUNDARY, continue: true },
    { ...BOUNDARY, context: { canContinue: true, pendingMessages: ["pending"] } },
  ])("yields to an existing boundary continuation or pending work", async (event) => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    expect(await h.fire("agent_before_settle", event)).toBeUndefined();
  });

  it("makes an assistant-ended boundary runnable by adding its own guidance entry", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    expect(
      await h.fire("agent_before_settle", {
        ...BOUNDARY,
        context: { canContinue: false, pendingMessages: [] },
      }),
    ).toMatchObject({ continue: true, entries: [{ type: "custom_message" }] });
  });

  it("does not continue when host messages are pending", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
  });

  it.each(["paused", "waiting_for_decision", "inactive", "completed"] as const)(
    "does not continue a %s board",
    async (workflowStatus) => {
      const h = lifecycle();
      setSessionScopeEnabled(true);
      setBoard(activeBoard({ workflowStatus }));
      expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    },
  );

  it.each([
    ["aborted", "The user aborted"],
    ["error", "after Pi retries"],
  ])("pauses after final outcome %s", async (outcome, reason) => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    expect(await h.fire("agent_before_settle", { ...BOUNDARY, outcome })).toBeUndefined();
    expect(getBoard()).toMatchObject({
      workflowStatus: "paused",
      pauseReason: expect.stringContaining(reason),
    });
  });

  it("pauses on deadlock or repeated generation-only churn", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    for (let i = 0; i < 5; i++) {
      setBoard(activeBoard({ generation: 4 + i }));
      expect((await h.fire("agent_before_settle", BOUNDARY))?.continue).toBe(true);
    }
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(getBoard().workflowStatus).toBe("paused");
    setBoard(
      activeBoard({
        tasks: activeBoard().tasks.map((task) => ({ ...task, status: "configured" })),
      }),
    );
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(getBoard().pauseReason).toContain("none are actionable");
  });

  it("consumes a phase prompt only when a continuation is actually returned", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard({ pendingPhasePrompt: { phase: 1, message: "Verify the next phase" } }));
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result.entries[0].content).toContain("Verify the next phase");
    expect(getBoard()).toMatchObject({ generation: 4, pendingPhasePrompt: undefined });
    expect(h.mock.appendEntry).toHaveBeenCalledWith("continuous-tasks:snapshot", getBoard());
    expect(h.mock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Phase 1 complete." }),
      { triggerTurn: false },
    );
  });

  it.each(["input", "session_shutdown", "session_tree", "session_before_compact"])(
    "cancels a boundary while loading configuration on %s",
    async (name) => {
      const mock = createMockAPI();
      const config = deferred<typeof DEFAULT_CONFIG>();
      registerEventHandlers(mock.api, () => config.promise);
      const ctx = createMockContext();
      setSessionScopeEnabled(true);
      setBoard(activeBoard());
      const pending = getHandler(mock, "agent_before_settle")(BOUNDARY, ctx);
      expect(await getHandler(mock, "agent_before_settle")(BOUNDARY, ctx)).toBeUndefined();
      await getHandler(mock, name)({}, ctx);
      config.resolve(DEFAULT_CONFIG);
      expect(await pending).toBeUndefined();
    },
  );

  it("pauses visibly when unsupervised continuation configuration fails", async () => {
    const mock = createMockAPI();
    registerEventHandlers(mock.api, async () => {
      throw new Error("api_key=private-secret config failed");
    });
    const ctx = createMockContext();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    expect(await getHandler(mock, "agent_before_settle")(BOUNDARY, ctx)).toBeUndefined();
    expect(getBoard()).toMatchObject({
      workflowStatus: "paused",
      pauseReason: "[redacted] config failed",
    });
    expect(mock.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ display: true }), {
      triggerTurn: false,
    });
    expect(JSON.stringify(mock.appendEntry.mock.calls)).not.toContain("private-secret");
  });

  it("discards an async configuration result after the board changes", async () => {
    const mock = createMockAPI();
    const config = deferred<typeof DEFAULT_CONFIG>();
    registerEventHandlers(mock.api, () => config.promise);
    const ctx = createMockContext();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    const pending = getHandler(mock, "agent_before_settle")(BOUNDARY, ctx);
    setBoard(activeBoard({ generation: 9 }));
    config.resolve(DEFAULT_CONFIG);
    expect(await pending).toBeUndefined();
  });
});
