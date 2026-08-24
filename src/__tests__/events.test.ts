import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, type ContinuousTasksConfig } from "../config";
import { registerEventHandlers } from "../events";
import {
  getBoard,
  getLastToolWasAdvance,
  resetState,
  setBoard,
  setLastToolWasAdvance,
} from "../state";
import type { TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";
const ACTIVATION_ENTRY = {
  type: "custom",
  customType: "continuous-tasks:activation",
  data: { version: 1, enabled: true },
};

type Handler = (event: any, ctx: ExtensionContext) => unknown;

function getHandler(mockAPI: ReturnType<typeof createMockAPI>, eventName: string): Handler {
  const call = mockAPI.on.mock.calls.find(([name]) => name === eventName);
  if (!call) throw new Error(`Handler not registered: ${eventName}`);
  return call[1] as Handler;
}

function context(branch: Array<{ type: string; customType?: string; data?: unknown }> = []) {
  return createMockContext(branch);
}

function config(overrides: Partial<ContinuousTasksConfig> = {}): ContinuousTasksConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function activeBoard(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 3,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-2.1",
    stagnantSettles: 0,
    tasks: [
      {
        id: "t-1.1",
        title: "Implement",
        prompt: "Implement the change",
        profile: "worker",
        phase: 1,
        dependencies: [],
        status: "ready",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "t-2.1",
        title: "Final acceptance",
        prompt: "Verify the change",
        profile: "reviewer",
        phase: 2,
        dependencies: ["t-1.1"],
        status: "configured",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [
      { phase: 1, status: "active", title: "Implement" },
      { phase: 2, status: "pending", title: "Accept" },
    ],
    ...overrides,
  };
}

async function registerAllowed(mockAPI: ReturnType<typeof createMockAPI>, ctx = context()) {
  const branch = ctx.sessionManager.getBranch() as Array<{
    type: string;
    customType?: string;
    data?: unknown;
  }>;
  branch.unshift(ACTIVATION_ENTRY);
  registerEventHandlers(mockAPI.api, async () => config());
  await getHandler(mockAPI, "session_start")({}, ctx);
  return ctx;
}

async function recordNormalEnd(mockAPI: ReturnType<typeof createMockAPI>, ctx: ExtensionContext) {
  await getHandler(mockAPI, "agent_end")(
    { messages: [{ role: "assistant", stopReason: "stop" }] },
    ctx,
  );
}

describe("continuous task lifecycle events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers the complete lifecycle surface", () => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => config());
    expect(mockAPI.on.mock.calls.map(([name]) => name)).toEqual([
      "session_start",
      "session_tree",
      "session_shutdown",
      "before_agent_start",
      "agent_end",
      "agent_settled",
      "input",
      "tool_call",
      "tool_result",
    ]);
  });

  it("removes task tools and blocks calls without session activation", async () => {
    const mockAPI = createMockAPI();
    const ctx = context();
    registerEventHandlers(mockAPI.api, async () => DEFAULT_CONFIG);

    await getHandler(mockAPI, "session_start")({}, ctx);
    expect(mockAPI.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(await getHandler(mockAPI, "tool_call")({ toolName: "write_tasks" }, ctx)).toEqual({
      block: true,
      reason: "Continuous Tasks is disabled for this session",
    });
    expect(await getHandler(mockAPI, "tool_call")({ toolName: "read" }, ctx)).toBeUndefined();
  });

  it("rejects malformed activation entries", async () => {
    const mockAPI = createMockAPI();
    const ctx = context([
      {
        type: "custom",
        customType: "continuous-tasks:activation",
        data: { version: 1, enabled: false },
      },
    ]);
    registerEventHandlers(mockAPI.api, async () => DEFAULT_CONFIG);

    await getHandler(mockAPI, "session_start")({}, ctx);
    expect(mockAPI.setActiveTools).toHaveBeenLastCalledWith(["read"]);
  });

  it("enables all task tools for an activated session", async () => {
    const mockAPI = createMockAPI();
    await registerAllowed(mockAPI);

    const enabled = mockAPI.setActiveTools.mock.calls.at(-1)?.[0] as string[];
    expect(enabled).toContain("read");
    expect(enabled).toContain("workflow_gate");
    expect(enabled).toContain("advance_tasks");
  });

  it("restores a version-2 board on session start", async () => {
    const board = activeBoard();
    const ctx = context([{ type: "custom", customType: "continuous-tasks:snapshot", data: board }]);
    const mockAPI = createMockAPI();
    await registerAllowed(mockAPI, ctx);

    expect(getBoard()).toEqual(board);
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });

  it("restores activation and board state from the selected branch", async () => {
    const board = activeBoard({ generation: 9 });
    const ctx = context([
      ACTIVATION_ENTRY,
      { type: "custom", customType: "continuous-tasks:snapshot", data: board },
    ]);
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => config());

    await getHandler(mockAPI, "session_tree")({}, ctx);
    expect(getBoard().generation).toBe(9);
    expect(mockAPI.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining(["read", "write_tasks", "workflow_gate"]),
    );
  });

  it("injects hidden context only for an active enabled workflow", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());

    const result = (await getHandler(mockAPI, "before_agent_start")({}, ctx)) as {
      message?: { customType: string; display: boolean; content: string };
    };
    expect(result.message).toMatchObject({
      customType: "continuous-tasks:context",
      display: false,
    });
    expect(result.message?.content).toContain("Active Phase");
  });

  it.each(["inactive", "paused", "waiting_for_decision", "completed"] as const)(
    "does not inject context while workflow status is %s",
    async (workflowStatus) => {
      const mockAPI = createMockAPI();
      const ctx = await registerAllowed(mockAPI);
      setBoard(
        activeBoard({
          workflowStatus,
          decision:
            workflowStatus === "waiting_for_decision"
              ? {
                  id: "d1",
                  taskId: "t-1.1",
                  question: "Choose",
                  whyUserOwned: "Product decision",
                  createdAt: NOW,
                }
              : undefined,
        }),
      );

      const result = await getHandler(mockAPI, "before_agent_start")({}, ctx);
      expect(result).toBeUndefined();
    },
  );

  it("records agent_end without scheduling work", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());

    await recordNormalEnd(mockAPI, ctx);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("shows a 3-2-1 countdown and sends one hidden continuation", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());
    await recordNormalEnd(mockAPI, ctx);

    await getHandler(mockAPI, "agent_settled")({}, ctx);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "continuous-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "continuous-tasks-countdown",
      ["⏳ Auto-continuing in 2s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "continuous-tasks-countdown",
      ["⏳ Auto-continuing in 1s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
    await vi.advanceTimersByTimeAsync(1000);

    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "continuous-tasks:continue",
        display: false,
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("uses a timeout without a widget in headless mode", async () => {
    const mockAPI = createMockAPI();
    const ctx = context();
    (ctx as { hasUI: boolean }).hasUI = false;
    await registerAllowed(mockAPI, ctx);
    setBoard(activeBoard());
    await recordNormalEnd(mockAPI, ctx);

    await getHandler(mockAPI, "agent_settled")({}, ctx);
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "continuous-tasks:continue" }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("does not continue while another message is pending", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    (ctx.hasPendingMessages as ReturnType<typeof vi.fn>).mockReturnValue(true);
    setBoard(activeBoard());
    await recordNormalEnd(mockAPI, ctx);

    await getHandler(mockAPI, "agent_settled")({}, ctx);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it("cancels the current countdown on interactive input without pausing", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());
    await recordNormalEnd(mockAPI, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);

    await getHandler(mockAPI, "input")({ source: "interactive", text: "status" }, ctx);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(getBoard().workflowStatus).toBe("active");
  });

  it("discards a stale countdown after a generation change", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());
    await recordNormalEnd(mockAPI, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);

    setBoard(activeBoard({ generation: 4 }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["aborted", "The user aborted the last run"],
    ["error", "The last run still failed after Pi retries"],
  ])("pauses after final outcome %s", async (stopReason, reason) => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());

    await getHandler(mockAPI, "agent_end")({ messages: [{ role: "assistant", stopReason }] }, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);

    expect(getBoard()).toMatchObject({ workflowStatus: "paused", pauseReason: reason });
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: `Continuous Tasks paused: ${reason}` }),
      { triggerTurn: false },
    );
  });

  it("pauses on a non-terminal deadlock", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(
      activeBoard({
        tasks: activeBoard().tasks.map((task) => ({ ...task, status: "configured" })),
      }),
    );
    await recordNormalEnd(mockAPI, ctx);

    await getHandler(mockAPI, "agent_settled")({}, ctx);
    expect(getBoard()).toMatchObject({
      workflowStatus: "paused",
      pauseReason: "Non-terminal tasks remain but none are actionable",
    });
  });

  it("does nothing for a completed board", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard({ workflowStatus: "completed" }));
    await recordNormalEnd(mockAPI, ctx);

    await getHandler(mockAPI, "agent_settled")({}, ctx);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it("announces and consumes a pending phase prompt before continuing", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard({ pendingPhasePrompt: { phase: 1, message: "Phase 1 accepted." } }));
    await recordNormalEnd(mockAPI, ctx);

    await getHandler(mockAPI, "agent_settled")({}, ctx);
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "continuous-tasks:notice",
        content: "Phase 1 complete.",
        display: true,
      }),
      { triggerTurn: false },
    );
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "continuous-tasks:continue",
        content: expect.stringContaining("Phase 1 accepted."),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
    expect(getBoard().pendingPhasePrompt).toBeUndefined();
  });

  it("pauses after the configured number of stagnant automatic continuations", async () => {
    const mockAPI = createMockAPI();
    const ctx = context([ACTIVATION_ENTRY]);
    registerEventHandlers(mockAPI.api, async () =>
      config({ countdownMs: 0, maxStagnantSettles: 2 }),
    );
    await getHandler(mockAPI, "session_start")({}, ctx);
    setBoard(activeBoard());

    await recordNormalEnd(mockAPI, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);
    await vi.runAllTimersAsync();
    await recordNormalEnd(mockAPI, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);
    await vi.runAllTimersAsync();
    await recordNormalEnd(mockAPI, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);

    expect(getBoard()).toMatchObject({ workflowStatus: "paused", stagnantSettles: 2 });
  });

  it("clears a pending countdown during session shutdown", async () => {
    const mockAPI = createMockAPI();
    const ctx = await registerAllowed(mockAPI);
    setBoard(activeBoard());
    await recordNormalEnd(mockAPI, ctx);
    await getHandler(mockAPI, "agent_settled")({}, ctx);

    await getHandler(mockAPI, "session_shutdown")({}, ctx);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("continuous-tasks-countdown", undefined);
  });

  it("resets the double-advance marker after another tool result", async () => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => config());
    setLastToolWasAdvance(true);

    await getHandler(mockAPI, "tool_result")({ toolName: "read" }, context());
    expect(getLastToolWasAdvance()).toBe(false);
  });
});
