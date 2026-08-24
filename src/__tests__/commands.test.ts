import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { registerCommands } from "../commands";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import type { TaskBoardSnapshot } from "../types";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const NOW = "2026-08-23T00:00:00.000Z";

function activeBoard(): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 5,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-1.1",
    stagnantSettles: 0,
    tasks: [
      {
        id: "t-1.1",
        title: "Current task",
        prompt: "Continue",
        profile: "worker",
        phase: 1,
        dependencies: [],
        status: "ready",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [{ phase: 1, status: "active", title: "Current" }],
  };
}

function commandHandler(mockAPI: ReturnType<typeof createMockAPI>) {
  const call = mockAPI.registerCommand.mock.calls.find(([name]) => name === "continuous-tasks");
  if (!call) throw new Error("continuous-tasks command not registered");
  return (call[1] as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> })
    .handler;
}

describe("continuous-tasks command", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
  });

  it("pauses and resumes an active board", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    const handler = commandHandler(mockAPI);
    setBoard(activeBoard());

    await handler("pause maintenance", ctx);
    expect(getBoard()).toMatchObject({ workflowStatus: "paused", pauseReason: "maintenance" });

    await handler("resume", ctx);
    expect(getBoard()).toMatchObject({ workflowStatus: "active", pauseReason: undefined });
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "continuous-tasks:continue", display: false }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("resolves the exact waiting decision and resumes", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    const handler = commandHandler(mockAPI);
    setBoard({
      ...activeBoard(),
      workflowStatus: "waiting_for_decision",
      decision: {
        id: "decision-6",
        taskId: "t-1.1",
        question: "Choose",
        whyUserOwned: "Product decision",
        createdAt: NOW,
      },
    });

    await handler("resolve decision-6 compatible", ctx);

    expect(getBoard()).toMatchObject({ workflowStatus: "active", decision: undefined });
    expect(mockAPI.appendEntry).toHaveBeenCalledWith(
      "continuous-tasks:event",
      expect.objectContaining({
        type: "resolve_decision",
        id: "decision-6",
        answer: "compatible",
      }),
    );
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "continuous-tasks:continue" }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("enables only the current session and does not duplicate the marker", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    const handler = commandHandler(mockAPI);
    setSessionScopeEnabled(false);

    await handler("enable", ctx);
    await handler("enable", ctx);

    expect(mockAPI.appendEntry).toHaveBeenCalledTimes(1);
    expect(mockAPI.appendEntry).toHaveBeenCalledWith("continuous-tasks:activation", {
      version: 1,
      enabled: true,
    });
    expect(mockAPI.setActiveTools).toHaveBeenCalledWith(
      expect.arrayContaining(["read", "write_tasks", "workflow_gate"]),
    );
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(
      1,
      "Continuous Tasks enabled for this session",
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(
      2,
      "Continuous Tasks is already enabled for this session",
      "info",
    );
  });

  it("rejects control commands until the session is enabled", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    setSessionScopeEnabled(false);

    await commandHandler(mockAPI)("status", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Continuous Tasks is disabled; run /continuous-tasks enable",
      "error",
    );
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["pause", "Continuous Tasks is not active"],
    ["resume", "Continuous Tasks is not paused"],
    ["resolve decision-1 answer", "No decision is waiting"],
    ["unknown", "Usage: /continuous-tasks"],
  ])("reports invalid command state for %s", async (args, expected) => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    setBoard({ ...activeBoard(), workflowStatus: args === "pause" ? "paused" : "active" });

    await commandHandler(mockAPI)(args, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(expected), "error");
  });

  it("rejects a stale decision id and secret-like answer", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    const waiting = {
      ...activeBoard(),
      workflowStatus: "waiting_for_decision" as const,
      decision: {
        id: "decision-6",
        taskId: "t-1.1",
        question: "Choose",
        whyUserOwned: "Product decision",
        createdAt: NOW,
      },
    };
    setBoard(waiting);
    await commandHandler(mockAPI)("resolve decision-5 answer", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Decision id does not match decision-6", "error");

    setBoard(waiting);
    await commandHandler(mockAPI)("resolve decision-6 token=secret-value-123456", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Decision answer is empty, too long, or secret-like",
      "error",
    );
  });

  it("reports status without starting a model turn", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    setBoard(activeBoard());

    await commandHandler(mockAPI)("status", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("generation 5"), "info");
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });
});
