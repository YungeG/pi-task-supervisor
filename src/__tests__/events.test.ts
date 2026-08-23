import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TaskBoardSnapshot } from "../types";
import { MAX_AUTO_CONTINUE } from "../types";
import {
  setBoard,
  resetState,
  getBoard,
  getLastToolWasAdvance,
  setLastToolWasAdvance,
} from "../state";
import * as config from "../config";
import { createEmptyBoard, writeTasks, compileBoard, applyEdits, claimReadyTasks } from "../engine";
import { registerEventHandlers } from "../events";
import { createMockAPI, createMockContext } from "./helpers/mocks";

// ── Helpers ──

const NOW = "2025-01-01T00:00:00.000Z";

/** Extract a handler from the mock API's on() calls by event name. */
function getHandler(
  mockAPI: ReturnType<typeof createMockAPI>,
  eventName: string,
): (...args: unknown[]) => unknown {
  const calls = mockAPI.on.mock.calls;
  for (const call of calls) {
    if (call[0] === eventName) {
      return call[1] as (...args: unknown[]) => unknown;
    }
  }
  throw new Error(`No handler registered for event: ${eventName}`);
}

/** Create a board with one task in "ready" status (actionable). */
function makeBoardWithReadyTask(): TaskBoardSnapshot {
  let board = createEmptyBoard();
  board = writeTasks(
    board,
    {
      mode: "replace",
      phases: [
        { title: "Phase 1", tasks: [{ title: "Task A", prompt: "Do A", profile: "coder" }] },
      ],
    },
    NOW,
  );
  return compileBoard(board, NOW);
}

/** Create a board with one task in "implementing" status. */
function makeBoardWithImplementingTask(): TaskBoardSnapshot {
  let board = makeBoardWithReadyTask();
  board = claimReadyTasks(board, 1, NOW).board;
  return board;
}

/** Create a board with one done task (all terminal). */
function makeBoardWithDoneTask(): TaskBoardSnapshot {
  let board = makeBoardWithImplementingTask();
  board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
  board = applyEdits(board, [{ id: "t-1.1", type: "advance" }], NOW);
  return board;
}

/** Create a board that is blocked (non-terminal but not actionable). */
function makeBoardWithBlockedTask(): TaskBoardSnapshot {
  // A depends on B (which is abandoned). A stays configured (not done dep).
  let board = createEmptyBoard();
  board = writeTasks(
    board,
    {
      mode: "replace",
      phases: [
        {
          title: "Phase 1",
          tasks: [
            { title: "A", prompt: "Do A", profile: "coder" },
            { title: "B", prompt: "Do B", profile: "coder" },
          ],
        },
      ],
    },
    NOW,
  );
  board = applyEdits(
    board,
    [{ id: "t-1.1", type: "blockers", data: { dependencies: ["t-1.2"] } }],
    NOW,
  );
  board = compileBoard(board, NOW);
  // A is configured (depends on B), B is ready
  // Abandon B → A is configured but dep is not satisfied
  board = applyEdits(board, [{ id: "t-1.2", type: "abandon" }], NOW);
  return board;
}

// ═══════════════════════════════════════════
// 1. registerEventHandlers — registers all 5 events
// ═══════════════════════════════════════════

describe("registerEventHandlers", () => {
  beforeEach(() => {
    resetState();
  });

  it("registers handlers for all 7 events", () => {
    const mockObj = createMockAPI();
    registerEventHandlers(mockObj.api);

    const registeredEvents = mockObj.on.mock.calls.map(
      (call: unknown) => (call as [string, unknown])[0],
    );
    expect(registeredEvents).toContain("session_start");
    expect(registeredEvents).toContain("session_tree");
    expect(registeredEvents).toContain("session_shutdown");
    expect(registeredEvents).toContain("before_agent_start");
    expect(registeredEvents).toContain("agent_end");
    expect(registeredEvents).toContain("input");
    expect(registeredEvents).toContain("tool_result");
    expect(mockObj.on.mock.calls).toHaveLength(7);
  });
});

// ═══════════════════════════════════════════
// 2. session_start
// ═══════════════════════════════════════════

describe("session_start handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  it("reconstructs state from snapshot and updates UI", () => {
    const snapshotBoard = makeBoardWithReadyTask();
    const ctx = createMockContext([
      { type: "custom", customType: "continuous-tasks:snapshot", data: snapshotBoard },
    ]);

    const handler = getHandler(mockAPI, "session_start");
    handler({}, ctx);

    const currentBoard = getBoard();
    expect(currentBoard.tasks).toHaveLength(1);
    expect(currentBoard.tasks[0]!.title).toBe("Task A");

    // updateUI was called (sets status)
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });

  it("falls back to empty board when no snapshot exists", () => {
    const ctx = createMockContext([]);

    const handler = getHandler(mockAPI, "session_start");
    handler({}, ctx);

    const currentBoard = getBoard();
    expect(currentBoard.tasks).toHaveLength(0);
  });

  it("calls resetConfig", () => {
    const resetConfigSpy = vi.spyOn(config, "resetConfig");
    const ctx = createMockContext([]);

    const handler = getHandler(mockAPI, "session_start");
    handler({}, ctx);

    expect(resetConfigSpy).toHaveBeenCalledTimes(1);
    resetConfigSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════
// 3. session_tree
// ═══════════════════════════════════════════

describe("session_tree handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  it("reconstructs state and updates UI", () => {
    const snapshotBoard = makeBoardWithReadyTask();
    const ctx = createMockContext([
      { type: "custom", customType: "continuous-tasks:snapshot", data: snapshotBoard },
    ]);

    const handler = getHandler(mockAPI, "session_tree");
    handler({}, ctx);

    const currentBoard = getBoard();
    expect(currentBoard.tasks).toHaveLength(1);
    expect(ctx.ui.setStatus).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════
// 3b. session_shutdown
// ═══════════════════════════════════════════

describe("session_shutdown handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears countdown, resets state and config", () => {
    // Set up a board with tasks so agent_end will schedule a countdown
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    // Trigger agent_end to start a countdown
    const agentEndHandler = getHandler(mockAPI, "agent_end");
    agentEndHandler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Countdown should be active
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );

    // Now call session_shutdown
    const resetConfigSpy = vi.spyOn(config, "resetConfig");
    const shutdownHandler = getHandler(mockAPI, "session_shutdown");
    shutdownHandler({}, ctx);

    // Countdown should be cleared
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("phased-tasks-countdown", undefined);

    // State should be reset (empty board)
    const currentBoard = getBoard();
    expect(currentBoard.tasks).toHaveLength(0);

    // Config should be reset
    expect(resetConfigSpy).toHaveBeenCalledTimes(1);
    resetConfigSpy.mockRestore();

    // Advance time — no message should be sent (countdown was cancelled)
    vi.advanceTimersByTime(5000);
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════
// 4. before_agent_start
// ═══════════════════════════════════════════

describe("before_agent_start handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  it("returns context message when board is non-empty", () => {
    setBoard(makeBoardWithReadyTask());

    const handler = getHandler(mockAPI, "before_agent_start");
    const result = handler();

    expect(result).toBeDefined();
    expect(result).toHaveProperty("message");
    const msg = (result as { message: { customType: string; content: string; display: boolean } })
      .message;
    expect(msg.customType).toBe("phased-tasks-context");
    expect(msg.content).toContain("[PHASED TASKS ACTIVE]");
    expect(msg.content).toContain("Task A");
  });

  it("returns undefined when board is empty", () => {
    // Board is empty by default after resetState
    const handler = getHandler(mockAPI, "before_agent_start");
    const result = handler();
    expect(result).toBeUndefined();
  });

  it("returns message with display: false", () => {
    setBoard(makeBoardWithReadyTask());

    const handler = getHandler(mockAPI, "before_agent_start");
    const result = handler();
    const msg = (result as { message: { display: boolean } }).message;
    expect(msg.display).toBe(false);
  });

  it("includes pending phase prompt at top when present", () => {
    const board = makeBoardWithReadyTask();
    board.pendingPhasePrompt = { phase: 1, message: "Phase 1 complete! Moving to Phase 2." };
    setBoard(board);

    const handler = getHandler(mockAPI, "before_agent_start");
    const result = handler();
    const msg = (result as { message: { content: string } }).message;
    expect(msg.content).toContain("Phase 1 complete! Moving to Phase 2.");
    // The phase prompt should appear before the hidden context
    const promptIndex = msg.content.indexOf("Phase 1 complete!");
    const contextIndex = msg.content.indexOf("[PHASED TASKS ACTIVE]");
    expect(promptIndex).toBeLessThan(contextIndex);
  });

  it("message contains formatted board info", () => {
    setBoard(makeBoardWithReadyTask());

    const handler = getHandler(mockAPI, "before_agent_start");
    const result = handler();
    const content = (result as { message: { content: string } }).message.content;
    expect(content).toContain("Active Phase:");
    expect(content).toContain("Status:");
    expect(content).toContain("Remaining tasks:");
    expect(content).toContain("Workflow:");
  });
});

// ═══════════════════════════════════════════
// 5. agent_end
// ═══════════════════════════════════════════

describe("agent_end handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends sendUserMessage when actionable tasks exist", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // 3-second countdown in UI mode
    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
    const prompt = mockAPI.sendUserMessage.mock.calls[0]![0] as string;
    expect(prompt).toContain("Tasks remain");
  });

  it("sends deadlock message when blocked but non-terminal tasks remain", () => {
    setBoard(makeBoardWithBlockedTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
    const prompt = mockAPI.sendUserMessage.mock.calls[0]![0] as string;
    expect(prompt).toContain("blocked");
  });

  it("does nothing when all tasks are terminal", () => {
    setBoard(makeBoardWithDoneTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(5000);

    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does nothing when board is empty", () => {
    // Empty board after resetState
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(5000);

    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does nothing when last assistant message was aborted", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);

    vi.advanceTimersByTime(5000);

    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("increments counter on each call", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    // First call
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
    vi.advanceTimersByTime(3000);

    // Need to reset the mock to track second call
    mockAPI.sendUserMessage.mockClear();

    // Second call — board is still actionable (ready task wasn't consumed by the agent)
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
    vi.advanceTimersByTime(3000);

    // Counter was incremented twice — both calls should trigger auto-continue
    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
  });

  it("stops after MAX_AUTO_CONTINUE with limit message", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    // Call MAX_AUTO_CONTINUE times
    for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }

    mockAPI.sendMessage.mockClear();
    mockAPI.sendUserMessage.mockClear();

    // The next call should hit the limit
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "phased-tasks-notice",
        content: expect.stringContaining(
          `Auto-continue limit reached (${MAX_AUTO_CONTINUE} iterations). 1 task(s) remain unresolved`,
        ),
        display: true,
      }),
      { triggerTurn: false },
    );
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("consumes pending phase prompt (includes it, then clears)", () => {
    const board = makeBoardWithReadyTask();
    board.pendingPhasePrompt = { phase: 1, message: "Phase 1 is done! Onward!" };
    setBoard(board);
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
    const prompt = mockAPI.sendUserMessage.mock.calls[0]![0] as string;
    expect(prompt).toContain("Phase 1 is done! Onward!");

    // The pendingPhasePrompt should have been cleared
    const currentBoard = getBoard();
    expect(currentBoard.pendingPhasePrompt).toBeUndefined();
  });

  it("sends visible phase completion notice when consuming pendingPhasePrompt", () => {
    const board = makeBoardWithReadyTask();
    board.pendingPhasePrompt = { phase: 1, message: "Phase 1 is done! Onward!" };
    setBoard(board);
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Phase completion notice is sent immediately (before countdown)
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "phased-tasks-notice",
        content: "Phase 1 complete.",
        display: true,
      }),
      { triggerTurn: false },
    );
  });

  it("shows countdown widget before auto-continue", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Initial countdown widget should be set immediately
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
  });

  it("shows 2s countdown after 1 second", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Advance 1 second
    vi.advanceTimersByTime(1000);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 2s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
  });

  it("shows 1s countdown after 2 seconds", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(2000);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 1s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
  });

  it("clears countdown and sends message after 3 seconds", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    // Countdown should be cleared (set to undefined)
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("phased-tasks-countdown", undefined);
    // Message sent
    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
  });

  it("falls back to setTimeout in headless mode (no UI)", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();
    // Override hasUI to false
    (ctx as unknown as { hasUI: boolean }).hasUI = false;

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // In headless mode, no countdown widget
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();

    // After 3 seconds, should send message via setTimeout
    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
  });

  it("falls back to followUp delivery on error", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    // First call to sendUserMessage throws
    mockAPI.sendUserMessage.mockImplementationOnce(() => {
      throw new Error("Agent busy");
    });

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    // Should have tried twice: once normal, once with followUp
    expect(mockAPI.sendUserMessage).toHaveBeenCalledTimes(2);
    expect(mockAPI.sendUserMessage).toHaveBeenNthCalledWith(2, expect.any(String), {
      deliverAs: "followUp",
    });
  });

  it("skips silently when both delivery methods fail", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    // Both calls throw
    mockAPI.sendUserMessage.mockImplementation(() => {
      throw new Error("Agent unavailable");
    });

    const handler = getHandler(mockAPI, "agent_end");
    // Should not throw
    expect(() => {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }).not.toThrow();
  });
});

// ═══════════════════════════════════════════
// 6. input
// ═══════════════════════════════════════════

describe("input handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears any pending countdown", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    // Trigger agent_end to start a countdown
    const agentEndHandler = getHandler(mockAPI, "agent_end");
    agentEndHandler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Countdown should be active
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );

    // Now trigger input handler
    const inputHandler = getHandler(mockAPI, "input");
    inputHandler({}, ctx);

    // Countdown should be cleared
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("phased-tasks-countdown", undefined);

    // Advance time — no message should be sent (countdown was cancelled)
    vi.advanceTimersByTime(5000);
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("is safe to call when no countdown is active", () => {
    const ctx = createMockContext();

    const inputHandler = getHandler(mockAPI, "input");
    // Should not throw
    expect(() => inputHandler({}, ctx)).not.toThrow();
  });
});

// ═══════════════════════════════════════════
// 7. Countdown widget lifecycle
// ═══════════════════════════════════════════

describe("countdown widget lifecycle", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows 3-2-1 timer then sends message", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Initial: 3s
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );

    // After 1s: 2s
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 2s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );

    // After 2s total: 1s
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 1s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );

    // After 3s total: clear + send
    vi.advanceTimersByTime(1000);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith("phased-tasks-countdown", undefined);
    expect(mockAPI.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("replaces existing countdown when new agent_end fires", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    // First agent_end
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
    vi.advanceTimersByTime(1000); // 1 second in

    // Second agent_end (should replace countdown)
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Should show 3s again (fresh countdown)
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );
  });
});

// ═══════════════════════════════════════════
// 8. Abort detection
// ═══════════════════════════════════════════

describe("abort detection", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not auto-continue when stopReason is aborted", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "user" }, { role: "assistant", stopReason: "aborted" }] }, ctx);

    vi.advanceTimersByTime(5000);

    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("auto-continues when stopReason is complete", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "user" }, { role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
  });

  it("auto-continues when stopReason is undefined", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant" }] }, ctx);

    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
  });

  it("looks at the last assistant message for abort status", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    // Earlier message is aborted, but the last assistant is complete
    handler(
      {
        messages: [
          { role: "assistant", stopReason: "aborted" },
          { role: "user" },
          { role: "assistant", stopReason: "complete" },
        ],
      },
      ctx,
    );

    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════
// 9. Circuit breaker (MAX_AUTO_CONTINUE)
// ═══════════════════════════════════════════

describe("circuit breaker", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows auto-continue up to MAX_AUTO_CONTINUE times", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }

    // All MAX_AUTO_CONTINUE calls should have sent messages
    expect(mockAPI.sendUserMessage).toHaveBeenCalledTimes(MAX_AUTO_CONTINUE);
  });

  it("sends limit message on the (MAX_AUTO_CONTINUE + 1)th call", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    // Exhaust all allowed continues
    for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }

    mockAPI.sendMessage.mockClear();
    mockAPI.sendUserMessage.mockClear();

    // One more call
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    expect(mockAPI.sendMessage).toHaveBeenCalledTimes(1);
    expect(mockAPI.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "phased-tasks-notice",
        display: true,
      }),
      { triggerTurn: false },
    );
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send user message when limit is reached", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    for (let i = 0; i < MAX_AUTO_CONTINUE + 1; i++) {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }

    // sendUserMessage called exactly MAX_AUTO_CONTINUE times, not more
    expect(mockAPI.sendUserMessage).toHaveBeenCalledTimes(MAX_AUTO_CONTINUE);
    // sendMessage called once for the limit notice
    expect(mockAPI.sendMessage).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════
// 10. Pending phase prompt consumption
// ═══════════════════════════════════════════

describe("pending phase prompt consumption", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("prepends phase prompt to continue message", () => {
    const board = makeBoardWithReadyTask();
    board.pendingPhasePrompt = { phase: 1, message: "🎉 Phase 1 complete!" };
    setBoard(board);
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    const prompt = mockAPI.sendUserMessage.mock.calls[0]![0] as string;
    expect(prompt.startsWith("🎉 Phase 1 complete!")).toBe(true);
    expect(prompt).toContain("Tasks remain");
  });

  it("clears pendingPhasePrompt from board after consumption", () => {
    const board = makeBoardWithReadyTask();
    board.pendingPhasePrompt = { phase: 1, message: "Phase done!" };
    setBoard(board);
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // pendingPhasePrompt should be cleared immediately (not waiting for timer)
    const currentBoard = getBoard();
    expect(currentBoard.pendingPhasePrompt).toBeUndefined();
  });

  it("does not include phase prompt when pendingPhasePrompt is absent", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    const prompt = mockAPI.sendUserMessage.mock.calls[0]![0] as string;
    expect(prompt.startsWith("Tasks remain")).toBe(true);
  });
});

// ═══════════════════════════════════════════
// 11. Headless mode (hasUI: false)
// ═══════════════════════════════════════════

describe("headless mode", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show countdown widget in headless mode", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();
    (ctx as unknown as { hasUI: boolean }).hasUI = false;

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("sends message after timeout in headless mode", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();
    (ctx as unknown as { hasUI: boolean }).hasUI = false;

    const handler = getHandler(mockAPI, "agent_end");
    handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    vi.advanceTimersByTime(3000);

    expect(mockAPI.sendUserMessage).toHaveBeenCalledTimes(1);
  });

  it("does not try to clear widget in headless mode on input", () => {
    const ctx = createMockContext();
    (ctx as unknown as { hasUI: boolean }).hasUI = false;

    const handler = getHandler(mockAPI, "input");
    handler({}, ctx);

    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════
// 12. setBoard resets auto-continue counter
// ═══════════════════════════════════════════

describe("auto-continue counter reset", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("setBoard resets auto-continue counter", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    const handler = getHandler(mockAPI, "agent_end");

    // Call 10 times
    for (let i = 0; i < 10; i++) {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }

    // Now setBoard again — should reset counter
    setBoard(makeBoardWithReadyTask());

    // Should be able to do another 20 iterations
    for (let i = 0; i < MAX_AUTO_CONTINUE; i++) {
      handler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);
      vi.advanceTimersByTime(3000);
    }

    // No limit message yet
    expect(mockAPI.sendMessage).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════
// 13. session_start clears countdown
// ═══════════════════════════════════════════

describe("session_start clears countdown", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  beforeEach(() => {
    resetState();
    vi.useFakeTimers();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears active countdown on session_start", () => {
    setBoard(makeBoardWithReadyTask());
    const ctx = createMockContext();

    // Start a countdown via agent_end
    const agentEndHandler = getHandler(mockAPI, "agent_end");
    agentEndHandler({ messages: [{ role: "assistant", stopReason: "complete" }] }, ctx);

    // Countdown is active
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(
      "phased-tasks-countdown",
      ["⏳ Auto-continuing in 3s... (type anything to interrupt)"],
      { placement: "aboveEditor" },
    );

    // session_start should clear it
    const sessionStartHandler = getHandler(mockAPI, "session_start");
    sessionStartHandler({}, ctx);

    expect(ctx.ui.setWidget).toHaveBeenCalledWith("phased-tasks-countdown", undefined);

    // Advance time — no message should be sent
    vi.advanceTimersByTime(5000);
    expect(mockAPI.sendUserMessage).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════
// 14. tool_result handler (double-usage detection)
// ═══════════════════════════════════════════

describe("tool_result handler", () => {
  let api: ReturnType<typeof createMockAPI>["api"];
  let mockAPI: ReturnType<typeof createMockAPI>;

  const mockAdvanceResult = {
    type: "tool_result" as const,
    toolCallId: "call-1",
    toolName: "advance_tasks",
  };
  const mockOtherResult = {
    type: "tool_result" as const,
    toolCallId: "call-2",
    toolName: "bash",
  };

  beforeEach(() => {
    resetState();
    mockAPI = createMockAPI();
    api = mockAPI.api;
    registerEventHandlers(api);
  });

  it("advance_tasks does not reset lastToolWasAdvance", () => {
    const toolResultHandler = getHandler(mockAPI, "tool_result");

    // Set flag manually (simulating what advance_tasks execute does)
    setLastToolWasAdvance(true);
    expect(getLastToolWasAdvance()).toBe(true);

    // Advance tool_result should NOT reset it
    toolResultHandler(mockAdvanceResult);
    expect(getLastToolWasAdvance()).toBe(true);
  });

  it("non-advance tool resets tracking", () => {
    const toolResultHandler = getHandler(mockAPI, "tool_result");

    // Non-advance tool resets tracking
    toolResultHandler(mockOtherResult);
    expect(getLastToolWasAdvance()).toBe(false);
  });

  it("session_start resets tracking", () => {
    // Set up tracking state directly (simulates advance_tasks execute)
    setLastToolWasAdvance(true);
    expect(getLastToolWasAdvance()).toBe(true);

    // session_start resets it
    const sessionStartHandler = getHandler(mockAPI, "session_start");
    const ctx = createMockContext();
    sessionStartHandler({}, ctx);

    expect(getLastToolWasAdvance()).toBe(false);
  });

  it("session_tree resets tracking", () => {
    // Set up tracking state directly (simulates advance_tasks execute)
    setLastToolWasAdvance(true);
    expect(getLastToolWasAdvance()).toBe(true);

    // session_tree resets it
    const sessionTreeHandler = getHandler(mockAPI, "session_tree");
    const ctx = createMockContext();
    sessionTreeHandler({}, ctx);

    expect(getLastToolWasAdvance()).toBe(false);
  });

  it("input resets tracking", () => {
    // Set up tracking state directly (simulates advance_tasks execute)
    setLastToolWasAdvance(true);
    expect(getLastToolWasAdvance()).toBe(true);

    // input resets it
    const inputHandler = getHandler(mockAPI, "input");
    const ctx = createMockContext();
    inputHandler({}, ctx);

    expect(getLastToolWasAdvance()).toBe(false);
  });
});
