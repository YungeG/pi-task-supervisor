import { ESC, installCustomUI } from "./helpers/custom-ui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommands } from "../commands";
import { isSessionScopeEnabled, setSessionScopeEnabled } from "../scope";
import { currentRuntime } from "../runtime";
import { startSupervisor, supervisorState } from "../supervisor";
import { getBoard, resetState, setBoard } from "../state";
import type { TaskBoardSnapshot } from "../types";
import { attachMockJournal, createMockAPI, createMockContext } from "./helpers/mocks";

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

function commandHandler(mockAPI: ReturnType<typeof createMockAPI>, command = "task-supervisor") {
  const call = mockAPI.registerCommand.mock.calls.find(([name]) => name === command);
  if (!call) throw new Error(`${command} command not registered`);
  return (args: string, ctx: ExtensionCommandContext) => {
    attachMockJournal(mockAPI, ctx as ReturnType<typeof createMockContext>);
    return (
      call[1] as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    ).handler(args, ctx);
  };
}

describe("task-supervisor command", () => {
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

  it("keeps legacy decisions waiting instead of authorizing from bare command text", async () => {
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

    await handler("decide decision-6 compatible", ctx);

    expect(getBoard()).toMatchObject({
      workflowStatus: "waiting_for_decision",
      decision: { id: "decision-6" },
    });
    expect(mockAPI.appendEntry).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it("enables only the current session and does not duplicate the marker", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    const handler = commandHandler(mockAPI);
    setSessionScopeEnabled(false);

    await handler("tasks-only", ctx);
    await handler("tasks-only", ctx);

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
      "Task-board-only management selected; no automatic Supervisor or new business permission",
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenNthCalledWith(
      2,
      "Task-board-only management is already selected for this session",
      "info",
    );
  });

  it("keeps canonical task-only selection idempotent without registering the removed prefix", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    setSessionScopeEnabled(false);

    expect(mockAPI.registerCommand.mock.calls.map((call) => call[0])).toEqual(["task-supervisor"]);
    await commandHandler(mockAPI)("tasks-only", ctx);
    await commandHandler(mockAPI)("tasks-only", ctx);

    expect(mockAPI.appendEntry.mock.calls).toEqual([
      ["continuous-tasks:activation", { version: 1, enabled: true }],
    ]);
    expect(mockAPI.setActiveTools).toHaveBeenCalledWith(
      expect.arrayContaining(["write_tasks", "workflow_gate"]),
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      "Task-board-only management is already selected for this session",
      "info",
    );
  });

  it("rejects control commands until the session is enabled", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    setSessionScopeEnabled(false);

    await commandHandler(mockAPI)("resume", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Management is off; choose /task-supervisor tasks-only for a task board or supervise <goal> for read-only planning",
      "error",
    );
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["pause", "Pi Task Supervisor is not active"],
    ["resume", "Pi Task Supervisor is not paused"],
    ["decide decision-1 answer", "No decision is waiting"],
    ["unknown", "Usage: /task-supervisor"],
  ])("reports invalid command state for %s", async (args, expected) => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext() as ExtensionCommandContext;
    setBoard({ ...activeBoard(), workflowStatus: args === "pause" ? "paused" : "active" });

    await commandHandler(mockAPI)(args, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(expected), "error");
  });

  it("rejects stale IDs and never stores legacy answer arguments, including secrets", async () => {
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
    await commandHandler(mockAPI)("decide decision-5 answer", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Decision id is stale", "error");

    setBoard(waiting);
    await commandHandler(mockAPI)("decide decision-6 token=secret-value-123456", ctx);
    expect(getBoard()).toEqual(waiting);
    expect(mockAPI.appendEntry).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(ctx.ui.notify).mock.calls)).not.toContain("secret-value");
  });

  it("rejects the removed direct-start command without a model call or forged user message", async () => {
    const mockAPI = createMockAPI();
    const ctx = createMockContext();
    Object.assign(ctx, { model: { provider: "faux", id: "test" } });
    registerCommands(mockAPI.api);
    setSessionScopeEnabled(false);

    await commandHandler(mockAPI)("supervise-legacy Verify the approved work", ctx);

    expect(supervisorState()).toBeUndefined();
    expect(mockAPI.appendEntry).not.toHaveBeenCalled();
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it("controls an existing trusted-host supervisor through canonical pause/resume without replacing its goal", async () => {
    const mockAPI = createMockAPI();
    const ctx = createMockContext();
    Object.assign(ctx, { model: { provider: "faux", id: "test" } });
    registerCommands(mockAPI.api);
    setBoard(activeBoard());
    const primary = commandHandler(mockAPI, "task-supervisor");
    attachMockJournal(mockAPI, ctx);
    startSupervisor(mockAPI.api, ctx, "Verify alias compatibility");
    await primary("pause maintenance", ctx);
    expect(supervisorState()).toMatchObject({
      status: "paused",
      goal: "Verify alias compatibility",
    });
    expect(getBoard().workflowStatus).toBe("paused");

    await primary("resume", ctx);
    expect(getBoard().workflowStatus).toBe("active");
    expect(supervisorState()).toMatchObject({
      status: "active",
      goal: "Verify alias compatibility",
      sessionId: "test-session",
    });
    expect(mockAPI.appendEntry).toHaveBeenCalledWith(
      "continuous-tasks:supervisor",
      expect.objectContaining({ goal: "Verify alias compatibility", status: "active" }),
    );
  });

  it("offers a read-only list through the canonical command while disabled", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext();
    const snapshot = {
      ...activeBoard(),
      workflowStatus: "paused" as const,
      pauseReason: "User hold",
    };
    setBoard(snapshot);
    setSessionScopeEnabled(false);
    vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[0]);

    const ui = installCustomUI(ctx, (d) => {
      d.open(0);
      d.scrollAll();
      d.press(ESC);
      d.press(ESC);
    });
    await commandHandler(mockAPI)("tasks", ctx);
    ui.assertNoScriptErrors();

    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ui.rendered.join("\n")).toContain("User hold");
    expect(getBoard()).toEqual(snapshot);
    expect(isSessionScopeEnabled()).toBe(false);
    expect(supervisorState()).toBeUndefined();
    expect(mockAPI.appendEntry).not.toHaveBeenCalled();
    expect(mockAPI.setActiveTools).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("keeps journal-faulted tasks inspectable without granting recovery", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext();
    setBoard(activeBoard());
    currentRuntime().journalFault = "Invalid supervisor journal";
    setSessionScopeEnabled(false);
    vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[0]);

    const ui = installCustomUI(ctx, (d) => {
      d.open(0);
      d.scrollAll();
      d.press(ESC);
      d.press(ESC);
    });
    await commandHandler(mockAPI, "task-supervisor")("tasks", ctx);
    ui.assertNoScriptErrors();
    expect(ui.rendered.join("\n")).toContain("Invalid supervisor journal");
    expect(currentRuntime().journalFault).toBe("Invalid supervisor journal");
    expect(isSessionScopeEnabled()).toBe(false);
    expect(mockAPI.appendEntry).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });

  it("does nothing for headless task inspection", async () => {
    const mockAPI = createMockAPI();
    registerCommands(mockAPI.api);
    const ctx = createMockContext();
    Object.assign(ctx, { hasUI: false });
    await commandHandler(mockAPI)("tasks", ctx);
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(mockAPI.appendEntry).not.toHaveBeenCalled();
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
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
