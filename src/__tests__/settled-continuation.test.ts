import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../config";
import { registerEventHandlers } from "../events";
import { getBoard, resetState, setBoard } from "../state";
import type { TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const SESSION_ID = "01a0228b-ccbb-7fdf-b504-9f815411e609";
const NOW = "2026-08-23T00:00:00.000Z";

function getHandler(mockAPI: ReturnType<typeof createMockAPI>, eventName: string) {
  const call = mockAPI.on.mock.calls.find(([name]) => name === eventName);
  if (!call) throw new Error(`Handler not registered: ${eventName}`);
  return call[1] as (event: any, ctx: ExtensionContext) => void | Promise<void>;
}

function activeBoard(): TaskBoardSnapshot {
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
  };
}

function settledContext(): ExtensionContext {
  const context = createMockContext() as ExtensionContext & {
    isIdle: () => boolean;
    hasPendingMessages: () => boolean;
  };
  context.isIdle = () => true;
  context.hasPendingMessages = () => false;
  Object.assign(context.sessionManager, { getSessionId: () => SESSION_ID });
  return context;
}

describe("settled continuation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("queues one hidden custom continuation only after agent_settled", async () => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => ({
      ...DEFAULT_CONFIG,
      enabledSessionIds: [SESSION_ID],
    }));
    setBoard(activeBoard());
    const context = settledContext();

    await getHandler(mockAPI, "agent_end")(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      context,
    );
    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();

    await getHandler(mockAPI, "agent_settled")({}, context);
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "continuous-tasks:continue",
        display: false,
        details: expect.objectContaining({ generation: 3 }),
      }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("is a complete no-op for a session outside the allowlist", async () => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => DEFAULT_CONFIG);
    setBoard(activeBoard());
    const context = settledContext();

    await getHandler(mockAPI, "agent_end")(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      context,
    );
    await getHandler(mockAPI, "agent_settled")({}, context);
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
    expect(getBoard()).toEqual(activeBoard());
  });

  it("discards a countdown when the board generation changes", async () => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => ({
      ...DEFAULT_CONFIG,
      enabledSessionIds: [SESSION_ID],
    }));
    setBoard(activeBoard());
    const context = settledContext();

    await getHandler(mockAPI, "agent_end")(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      context,
    );
    await getHandler(mockAPI, "agent_settled")({}, context);
    setBoard({ ...activeBoard(), generation: 4 });
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["aborted", "The user aborted the last run"],
    ["error", "The last run still failed after Pi retries"],
  ])("pauses instead of continuing after %s", async (stopReason, reason) => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => ({
      ...DEFAULT_CONFIG,
      enabledSessionIds: [SESSION_ID],
    }));
    setBoard(activeBoard());
    const context = settledContext();

    await getHandler(mockAPI, "agent_end")(
      { messages: [{ role: "assistant", stopReason }] },
      context,
    );
    await getHandler(mockAPI, "agent_settled")({}, context);

    expect(getBoard()).toMatchObject({ workflowStatus: "paused", pauseReason: reason });
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "continuous-tasks:notice",
        content: `Continuous Tasks paused: ${reason}`,
      }),
      { triggerTurn: false },
    );
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("resumes auto-continuation after answering a progress question", async () => {
    const mockAPI = createMockAPI();
    registerEventHandlers(mockAPI.api, async () => ({
      ...DEFAULT_CONFIG,
      enabledSessionIds: [SESSION_ID],
    }));
    setBoard(activeBoard());
    const context = settledContext();

    await getHandler(mockAPI, "agent_end")(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      context,
    );
    await getHandler(mockAPI, "agent_settled")({}, context);
    await getHandler(mockAPI, "input")({ source: "interactive", text: "进度如何" }, context);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();

    await getHandler(mockAPI, "agent_end")(
      { messages: [{ role: "assistant", stopReason: "stop" }] },
      context,
    );
    await getHandler(mockAPI, "agent_settled")({}, context);
    await vi.advanceTimersByTimeAsync(3000);

    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "continuous-tasks:continue" }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });
});
