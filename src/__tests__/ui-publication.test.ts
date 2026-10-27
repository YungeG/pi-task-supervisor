import { beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { TaskBoardSnapshot } from "../types";
import { setSessionScopeEnabled } from "../scope";
import * as capture from "../ui-capture";
import * as compact from "../board-view";
import * as status from "../status-ui";
import { TASK_WIDGET_KEY, updateTaskWidget } from "../board-ui";
import { createEmptyBoard } from "../engine";
import { currentRuntime } from "../runtime";
import { getBoard, resetState, setBoard, updateUI } from "../state";
import { createWriteTasksTool } from "../tools";
import {
  reviewSupervisor,
  startSupervisor,
  supervisorState,
  holdSupervisor,
  prepareToolCapture,
} from "../supervisor";
import { lifecycle } from "./helpers/lifecycle";
import {
  attachMockJournal,
  createMockAPI,
  createMockContext,
  createMockTheme,
} from "./helpers/mocks";

function activeBoard() {
  return {
    ...createEmptyBoard(),
    workflowStatus: "active" as const,
    tasks: [
      {
        id: "active",
        title: "Approved work",
        prompt: "Work",
        profile: "worker",
        phase: 1,
        dependencies: [],
        status: "implementing" as const,
        createdAt: "now",
        updatedAt: "now",
      },
    ],
    phases: [{ phase: 1, status: "active" as const }],
  };
}

function render(ctx: ReturnType<typeof createMockContext>) {
  const factory = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1];
  if (typeof factory !== "function") throw new Error("Missing compact widget");
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, text) => text);
  return factory({} as TUI, theme)
    .render(200)
    .join("\n");
}

describe("resident UI publication", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetState();
  });

  it.each(["rpc", "print"])(
    "clears a seeded parent-only Supervisor footer on an ordinary %s refresh",
    (mode) => {
      const ctx = createMockContext();
      Object.assign(ctx, { mode });
      const footer = new Map<string, string | undefined>([
        ["continuous-supervisor", "Supervisor: stopped (1/20 resumes)"],
        ["other-extension", "keep"],
      ]);
      vi.mocked(ctx.ui.setStatus).mockImplementation((key, value) => {
        footer.set(key, value);
      });
      const branch = vi.spyOn(ctx.sessionManager, "getBranch");
      const entries = vi.spyOn(ctx.sessionManager, "getEntries");
      const board = createEmptyBoard();
      const before = JSON.stringify(board);
      updateUI(ctx, board);
      expect(footer.get("continuous-supervisor")).toBeUndefined();
      expect(footer.get("other-extension")).toBe("keep");
      expect(currentRuntime().supervisor).toBeUndefined();
      expect(JSON.stringify(board)).toBe(before);
      expect(branch).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    },
  );

  it.each(["rpc", "print"])(
    "keeps owner identity and stopped/pending rules on every %s refresh",
    (mode) => {
      const ctx = createMockContext();
      Object.assign(ctx, { mode, model: { provider: "faux", id: "test" } });
      const mock = createMockAPI();
      attachMockJournal(mock, ctx);
      setBoard(activeBoard());
      startSupervisor(mock.api, ctx, "UI-only fixture");
      const state = supervisorState();
      if (!state) throw new Error("Missing fixture supervisor");
      const footer = new Map<string, string | undefined>([["other-extension", "keep"]]);
      vi.mocked(ctx.ui.setStatus).mockImplementation((key, value) => {
        footer.set(key, value);
      });
      const dispatches = mock.sendMessage.mock.calls.length;
      for (const sample of [
        { sessionId: "parent-session", status: "active", pending: false, expected: undefined },
        { sessionId: "parent-session", status: "stopped", pending: false, expected: undefined },
        { sessionId: "test-session", status: "stopped", pending: false, expected: undefined },
        {
          sessionId: "test-session",
          status: "stopped",
          pending: true,
          expected: "Supervisor: stopped (0/20 resumes)",
        },
        {
          sessionId: "test-session",
          status: "active",
          pending: false,
          expected: "Supervisor: active (0/20 resumes)",
        },
        {
          sessionId: "test-session",
          status: "reviewing",
          pending: false,
          expected: "Supervisor: checking 0/40",
        },
        {
          sessionId: "test-session",
          status: "paused",
          pending: false,
          expected: "Supervisor: paused (0/20 resumes)",
        },
        {
          sessionId: "test-session",
          status: "fault",
          pending: false,
          expected: "Supervisor: fault (0/20 resumes)",
        },
        {
          sessionId: "test-session",
          status: "completed",
          pending: false,
          expected: "Supervisor: completed (0/20 resumes)",
        },
      ] as const) {
        Object.assign(state, {
          sessionId: sample.sessionId,
          status: sample.status,
          pending: sample.pending,
        });
        const before = JSON.stringify({ state, board: getBoard() });
        const writes = mock.appendEntry.mock.calls.length;
        footer.set("continuous-supervisor", "Supervisor: stale");
        updateUI(ctx, getBoard());
        expect(footer.get("continuous-supervisor")).toBe(sample.expected);
        expect(footer.get("other-extension")).toBe("keep");
        expect(JSON.stringify({ state, board: getBoard() })).toBe(before);
        expect(mock.appendEntry).toHaveBeenCalledTimes(writes);
        expect(mock.sendMessage).toHaveBeenCalledTimes(dispatches);
      }
    },
  );

  it.each(["journal", "board-repair", "preflight-repair", "goal-blocked"])(
    "keeps real %s attention when no current Supervisor exists",
    (kind) => {
      const ctx = createMockContext();
      Object.assign(ctx, { mode: "rpc" });
      const runtime = currentRuntime();
      const hint = {
        sessionId: "test-session",
        controlEntryId: "fixture",
        projectedDigest: "a".repeat(64),
        faultMessage: "MUST_KEEP_DIAGNOSTIC",
        ownsJournalFault: false,
      };
      if (kind === "journal") runtime.journalFault = hint.faultMessage;
      if (kind === "board-repair") runtime.boardRepair = hint;
      if (kind === "preflight-repair") runtime.preflightRepair = hint;
      if (kind === "goal-blocked")
        runtime.goal = { sessionId: "test-session", archives: [], blocked: hint.faultMessage };
      const before = JSON.stringify(runtime);
      updateUI(ctx, createEmptyBoard());
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "continuous-supervisor",
        expect.stringContaining("MUST_KEEP_DIAGNOSTIC"),
      );
      expect(JSON.stringify(runtime)).toBe(before);
    },
  );

  it.each(["rpc", "print"])(
    "does not republish stopped history after the original %s stop command",
    async (mode) => {
      const h = lifecycle();
      Object.assign(h.ctx, { mode });
      setSessionScopeEnabled(true);
      setBoard(activeBoard());
      startSupervisor(h.mock.api, h.ctx, "UI-only stop fixture");
      const footer = new Map<string, string | undefined>([["other-extension", "keep"]]);
      vi.mocked(h.ctx.ui.setStatus).mockImplementation((key, value) => {
        footer.set(key, value);
      });
      await h.command("stop");
      expect(currentRuntime().supervisor).toMatchObject({ status: "stopped", pending: false });
      expect(supervisorState()).toBeUndefined();
      expect(footer.get("continuous-supervisor")).toBeUndefined();
      expect(footer.get("other-extension")).toBe("keep");
      const snapshot = JSON.stringify({ board: getBoard(), state: supervisorState() });
      const writes = h.mock.appendEntry.mock.calls.length;
      updateUI(h.ctx, getBoard());
      expect(footer.get("continuous-supervisor")).toBeUndefined();
      expect(JSON.stringify({ board: getBoard(), state: supervisorState() })).toBe(snapshot);
      expect(h.mock.appendEntry).toHaveBeenCalledTimes(writes);
      expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    },
  );

  it.each(["session_start", "session_tree"])(
    "ignores parent-only stopped history on %s and clears its seeded footer without writing history",
    async (event) => {
      const h = lifecycle();
      Object.assign(h.ctx, { mode: "rpc" });
      vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("parent-session");
      const parentBoard = { ...activeBoard(), generation: 1, finalAcceptanceTaskId: "active" };
      const { isValidSnapshotV2 } = await import("../validation");
      expect(isValidSnapshotV2(parentBoard)).toBe(true);
      setBoard(parentBoard);
      h.mock.api.appendEntry("continuous-tasks:snapshot", parentBoard);
      startSupervisor(h.mock.api, h.ctx, "Parent fixture");
      await h.command("stop");
      expect(currentRuntime().supervisor).toMatchObject({ status: "stopped", pending: false });
      expect(supervisorState()).toBeUndefined();
      vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("child-session");
      const footer = new Map<string, string | undefined>([
        ["continuous-supervisor", "Supervisor: stopped (1/20 resumes)"],
      ]);
      vi.mocked(h.ctx.ui.setStatus).mockImplementation((key, value) => {
        footer.set(key, value);
      });
      const branch = JSON.stringify(h.ctx.sessionManager.getBranch());
      const writes = h.mock.appendEntry.mock.calls.length;
      await h.fire(event);
      expect(supervisorState()).toBeUndefined();
      expect(footer.get("continuous-supervisor")).toBeUndefined();
      expect(JSON.stringify(h.ctx.sessionManager.getBranch())).toBe(branch);
      expect(h.mock.appendEntry).toHaveBeenCalledTimes(writes);
      expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    },
  );

  it.each(["tui", "rpc", "print"])(
    "clears only the stale Supervisor key for a 13-done recorded board in %s",
    (mode) => {
      const ctx = createMockContext();
      Object.assign(ctx, { mode });
      // Status-shape fixture, not evidence of real task or goal acceptance.
      const board: TaskBoardSnapshot = {
        ...activeBoard(),
        workflowStatus: "completed",
        tasks: Array.from({ length: 13 }, (_, i) =>
          activeBoard().tasks.map((task) => ({
            ...task,
            id: `done-${i}`,
            status: "done" as const,
          })),
        ).flat(),
      };
      const footer = new Map<string, string | undefined>([
        ["continuous-supervisor", "Supervisor: stopped (1/20 resumes)"],
        ["other-extension", "keep"],
      ]);
      vi.mocked(ctx.ui.setStatus).mockImplementation((key, value) => {
        footer.set(key, value);
      });
      const before = JSON.stringify(board);
      updateUI(ctx, board);
      updateUI(ctx, board);
      expect(footer.get("continuous-supervisor")).toBeUndefined();
      expect(footer.get("til-done")).toContain("13/13");
      expect(footer.get("other-extension")).toBe("keep");
      expect(JSON.stringify(board)).toBe(before);
      expect(supervisorState()).toBeUndefined();
    },
  );

  it("keeps legacy diagnostics printable and bounded without changing the saved fault", () => {
    const ctx = createMockContext();
    Object.assign(ctx, { mode: "rpc" });
    const fault = "IMPORTANT\u001b[31m\n\u202e".repeat(50);
    currentRuntime().journalFault = fault;
    updateUI(ctx, createEmptyBoard());
    const value = vi
      .mocked(ctx.ui.setStatus)
      .mock.calls.find(([key]) => key === "continuous-supervisor")?.[1];
    expect(typeof value).toBe("string");
    if (typeof value !== "string") throw new Error("Missing diagnostic");
    expect(value).toContain("Supervisor: fault");
    expect(visibleWidth(value)).toBeLessThanOrEqual(64);
    expect(value).not.toMatch(/[\p{Cc}\p{Bidi_Control}]/u);
    expect(currentRuntime().journalFault).toBe(fault);
  });

  it("clears resident status and card after stop while retaining the paused 4-done/1-doing/7-queued history", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    h.mock.api.appendEntry("continuous-tasks:activation", { version: 1, enabled: true });
    const footer = new Map<string, string | undefined>();
    const widgets = new Map<string, unknown>();
    vi.mocked(h.ctx.ui.setStatus).mockImplementation((key, value) => {
      footer.set(key, value);
    });
    vi.mocked(h.ctx.ui.setWidget).mockImplementation((key, value) => {
      widgets.set(key, value);
    });
    startSupervisor(h.mock.api, h.ctx, "Synthetic resident-history fixture");
    const board: TaskBoardSnapshot = {
      ...activeBoard(),
      generation: 47,
      finalAcceptanceTaskId: "t12",
      tasks: Array.from({ length: 12 }, (_, i) => ({
        ...activeBoard().tasks[0]!,
        id: `t${i + 1}`,
        status: i < 4 ? "done" : i === 4 ? "implementing" : "configured",
        // Historical shape fixture only; this test does not assert task/goal acceptance.
        ...(i < 4
          ? {
              completionEvidence: {
                summary: "Previously saved synthetic UI fixture",
                refs: [
                  {
                    kind: "review" as const,
                    label: "Fixture history only",
                    status: "passed" as const,
                    ref: "fixture:historical-review",
                  },
                ],
              },
            }
          : {}),
      })),
    };
    setBoard(board);
    holdSupervisor(h.mock.api, h.ctx, "paused", "Historical advisor hold", "advisor_hold");
    updateUI(h.ctx, board);
    expect(footer.get("til-done")).toBeDefined();
    await h.command("stop");
    expect(currentRuntime().supervisor?.status).toBe("stopped");
    expect(supervisorState()).toBeUndefined();
    expect(getBoard().workflowStatus).toBe("paused");
    expect(getBoard().tasks).toEqual(board.tasks);
    for (const key of ["til-done", "til-done-active", "continuous-supervisor"])
      expect(footer.get(key)).toBeUndefined();
    expect(widgets.get(TASK_WIDGET_KEY)).toBeUndefined();
    expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    const view = capture.captureUiBoardView(h.ctx, getBoard());
    expect(view.board.tasks).toEqual(board.tasks);
    expect(view.summary.counts).toEqual({ total: 12, done: 4, abandoned: 0, unfinished: 8 });
    expect(currentRuntime().supervisor?.holdCause).toBe("advisor_hold");
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    updateUI(h.ctx, getBoard());
    expect(footer.get("til-done")).toBeUndefined();
    expect(widgets.get(TASK_WIDGET_KEY)).toBeUndefined();
    vi.mocked(h.ctx.isIdle).mockReturnValue(true);
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(false);
    await h.fire("session_tree");
    expect(footer.get("til-done")).toBeUndefined();
    expect(widgets.get(TASK_WIDGET_KEY)).toBeUndefined();
    expect(getBoard().tasks).toEqual(board.tasks);
    const writes = h.mock.appendEntry.mock.calls.length;
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("4/12 done"), "info");
    const custom = vi.fn(async () => undefined);
    Object.assign(h.ctx.ui, { custom });
    await h.command("tasks");
    expect(custom).toHaveBeenCalledOnce();
    expect(h.mock.appendEntry).toHaveBeenCalledTimes(writes);
    expect(getBoard().tasks).toEqual(board.tasks);
    expect(footer.get("til-done")).toBeUndefined();
    expect(widgets.get(TASK_WIDGET_KEY)).toBeUndefined();
  });
  it.each([
    "pause",
    "fault",
    "journal",
    "repair",
    "preflight-repair",
    "execution",
    "receipt",
    "decision",
    "foreign",
    "pending",
  ])(
    "keeps real %s attention visible instead of treating every idle host as finished",
    async (kind) => {
      const h = lifecycle();
      setSessionScopeEnabled(true);
      setBoard(activeBoard());
      startSupervisor(h.mock.api, h.ctx, "Synthetic attention fixture");
      if (kind === "receipt")
        prepareToolCapture(h.mock.api, {
          type: "tool_call",
          toolName: "write",
          toolCallId: "pending",
          input: {},
        });
      if (kind === "pending") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
      if (kind === "foreign") currentRuntime().supervisor!.sessionId = "foreign";
      if (kind === "pause" || kind === "fault")
        await h.command(kind === "pause" ? "pause Human pause" : "pause Existing work");
      else await h.command("stop");
      if (kind === "fault")
        holdSupervisor(h.mock.api, h.ctx, "fault", "Independent failure", "review_failed");
      if (kind === "journal") currentRuntime().journalFault = "Independent integrity fault";
      if (kind === "repair")
        currentRuntime().boardRepair = {
          sessionId: "test-session",
          controlEntryId: "saved",
          projectedDigest: "a".repeat(64),
          faultMessage: "Projection pending",
          ownsJournalFault: false,
        };
      if (kind === "preflight-repair")
        currentRuntime().preflightRepair = {
          sessionId: "test-session",
          controlEntryId: "saved",
          projectedDigest: "a".repeat(64),
          faultMessage: "Projection pending",
          ownsJournalFault: false,
        };
      if (kind === "execution") {
        const board = getBoard();
        board.tasks[0]!.executionRef = { source: "workflow", runId: "existing" };
        setBoard(board);
      }
      if (kind === "decision") {
        const board = getBoard();
        board.decision = {
          id: "decision-existing",
          taskId: "active",
          question: "Choose",
          whyUserOwned: "Business choice",
          createdAt: "now",
          options: ["A", "B"],
          spec: { version: 1, kind: "choice" },
        };
        setBoard(board);
      }
      vi.mocked(h.ctx.ui.setStatus).mockClear();
      vi.mocked(h.ctx.ui.setWidget).mockClear();
      updateUI(h.ctx, getBoard());
      const bar = vi
        .mocked(h.ctx.ui.setStatus)
        .mock.calls.filter(([key]) => key === "til-done")
        .at(-1)?.[1];
      expect(bar).toBeDefined();
      expect(vi.mocked(h.ctx.ui.setWidget).mock.calls.at(-1)?.[1]).toEqual(expect.any(Function));
    },
  );
  it("requires explicit new task-only work after stop and never resumes historical supervision", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
    startSupervisor(h.mock.api, h.ctx, "Historical goal");
    await h.command("stop");
    await h.command("resume");
    expect(getBoard().workflowStatus).toBe("paused");
    expect(currentRuntime().supervisor?.status).toBe("stopped");
    expect(supervisorState()).toBeUndefined();
    await h.command("enable");
    expect(currentRuntime().management?.mode).toBe("tasks");
    expect(getBoard().tasks).toHaveLength(0);
    // UI-only new-board shape, not evidence or a revived permission grant.
    setBoard(activeBoard());
    updateUI(h.ctx, getBoard());
    expect(getBoard().workflowStatus).toBe("active");
    expect(
      vi
        .mocked(h.ctx.ui.setStatus)
        .mock.calls.filter(([key]) => key === "til-done")
        .at(-1)?.[1],
    ).toBeDefined();
    expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
  });
  it("reuses one receipt-issue capture for the TUI widget and bar, while RPC keeps old keys/text", () => {
    const ctx = createMockContext();
    const board = activeBoard();
    const mock = createMockAPI();
    attachMockJournal(mock, ctx);
    Object.assign(ctx, { model: { provider: "faux", id: "test" } });
    startSupervisor(mock.api, ctx, "Approved active goal");
    expect(supervisorState()?.status).toBe("active");
    vi.mocked(ctx.ui.setStatus).mockClear();
    vi.mocked(ctx.ui.setWidget).mockClear();
    const facts = vi.spyOn(ctx, "isIdle");
    const captured = vi.spyOn(capture, "captureUiSummary");
    const rendered = vi.spyOn(compact, "renderCompactBoard");
    const formatted = vi.spyOn(status, "formatStatusbar");
    // A real capture projects a foreign receipt identity conservatively, without reading history.
    currentRuntime().receiptStore = { sessionId: "foreign", pendingCount: 1 } as never;
    updateUI(ctx, board);
    expect(captured).toHaveBeenCalledTimes(1);
    const summary = captured.mock.results[0]!.value;
    expect(summary.headline.text).toContain("需检查");
    expect(formatted).toHaveBeenCalledWith(summary);
    expect(formatted.mock.calls[0]?.[0]).toBe(summary);
    const output = render(ctx);
    expect(rendered.mock.calls[0]?.[0]).toBe(summary);
    expect(output).toContain(summary.headline.text);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done", status.formatStatusbar(summary));
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done-active", undefined);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("continuous-supervisor", undefined);
    expect(output).not.toMatch(/(?:下一步|待办)：\/task-supervisor continue/);
    const reads = facts.mock.calls.length;
    render(ctx);
    expect(facts).toHaveBeenCalledTimes(reads);
    const rpc = createMockContext();
    Object.assign(rpc, { mode: "rpc" });
    const branch = vi.spyOn(rpc.sessionManager, "getBranch");
    updateUI(rpc, board);
    expect(captured).toHaveBeenCalledTimes(1);
    expect(branch).not.toHaveBeenCalled();
    expect(rpc.ui.setWidget).not.toHaveBeenCalled();
    expect(vi.mocked(rpc.ui.setStatus).mock.calls).toEqual([
      ["continuous-supervisor", "Supervisor: fault — Receipt identity needs inspection"],
      ["til-done", "0/1 - Phase 1"],
      ["til-done-active", "[active] Approved work"],
    ]);
  });

  it("guards before capture and preserves the two-argument widget API", () => {
    const captured = vi.spyOn(capture, "captureUiSummary");
    const ctx = createMockContext();
    for (const mode of ["rpc", "print"]) {
      Object.assign(ctx, { mode });
      updateTaskWidget(ctx, activeBoard());
    }
    Object.assign(ctx, { mode: "tui", hasUI: false });
    updateTaskWidget(ctx, activeBoard());
    updateUI(ctx, activeBoard());
    expect(captured).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
    Object.assign(ctx, { hasUI: true });
    updateTaskWidget(ctx, activeBoard());
    expect(captured).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, expect.any(Function), {
      placement: "aboveEditor",
    });
  });

  it("accepts an ordinary third summary without recapturing runtime during install or render", () => {
    const ctx = createMockContext();
    const summary = capture.captureUiSummary(ctx, activeBoard());
    const captured = vi.spyOn(capture, "captureUiSummary");
    currentRuntime().journalFault = "Changed after capture";
    updateTaskWidget(ctx, createEmptyBoard(), summary);
    expect(captured).not.toHaveBeenCalled();
    const output = render(ctx);
    expect(output).toContain("Approved work");
    expect(output).not.toContain("Changed after capture");
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it.each(["capture", "widget", "status"])(
    "keeps the saved tool carrier and runtime intact after optional %s failure",
    async (failure) => {
      const ctx = createMockContext();
      const mock = createMockAPI();
      attachMockJournal(mock, ctx);
      const custom = vi.fn();
      Object.assign(ctx.ui, { custom });
      const params = {
        mode: "replace",
        phases: [{ title: "Build", tasks: [{ title: "A", prompt: "Do A", profile: "coder" }] }],
      };
      const tool = createWriteTasksTool(mock.api);
      if (failure === "capture")
        vi.spyOn(capture, "captureUiSummary").mockImplementation(() => {
          throw new Error("UI identity changed");
        });
      if (failure === "widget")
        vi.mocked(ctx.ui.setWidget).mockImplementation(() => {
          throw new Error("UI unavailable");
        });
      if (failure === "status")
        vi.mocked(ctx.ui.setStatus).mockImplementation(() => {
          throw new Error("UI unavailable");
        });
      const result = await tool.execute("write", params, undefined, undefined, ctx);
      expect(result.details).not.toHaveProperty("error");
      expect(result.details.snapshot).toEqual(getBoard());
      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Added 1 task(s)"),
      });
      expect(mock.appendEntry).toHaveBeenCalledTimes(2);
      expect(mock.sendMessage).not.toHaveBeenCalled();
      expect(mock.sendUserMessage).not.toHaveBeenCalled();
      expect(custom).not.toHaveBeenCalled();
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(currentRuntime().supervisor).toBeUndefined();
      expect(currentRuntime().boardRepair).toBeUndefined();
      expect(currentRuntime().preflightRepair).toBeUndefined();
      mock.appendEntry.mockImplementation(() => {
        throw new Error("Actual persistence failure");
      });
      const failed = await tool.execute("write-fail", params, undefined, undefined, ctx);
      expect(failed.details).toMatchObject({ error: "Actual persistence failure" });
    },
  );

  it.each(["rpc", "print"])(
    "preserves old %s empty/terminal carriers without capture/custom/history",
    (mode) => {
      const ctx = createMockContext();
      Object.assign(ctx, { mode });
      const custom = vi.fn();
      Object.assign(ctx.ui, { custom });
      const captured = vi.spyOn(capture, "captureUiSummary");
      const full = vi.spyOn(capture, "captureUiBoardView");
      const history = vi.spyOn(ctx.sessionManager, "getEntries");
      updateUI(ctx, createEmptyBoard());
      const board = activeBoard();
      Object.assign(board.tasks[0]!, { status: "abandoned" });
      updateUI(ctx, board);
      expect(vi.mocked(ctx.ui.setStatus).mock.calls).toEqual([
        ["continuous-supervisor", undefined],
        ["til-done", undefined],
        ["til-done-active", undefined],
        ["continuous-supervisor", undefined],
        ["til-done", "1/1 - Phase 1"],
        ["til-done-active", undefined],
      ]);
      expect(ctx.ui.setWidget).not.toHaveBeenCalled();
      expect(custom).not.toHaveBeenCalled();
      expect(captured).not.toHaveBeenCalled();
      expect(full).not.toHaveBeenCalled();
      expect(history).not.toHaveBeenCalled();
    },
  );

  it.each(["tui", "rpc"])(
    "keeps review publication mode-specific in %s without changing budgets",
    async (mode) => {
      const ctx = createMockContext();
      Object.assign(ctx, { mode, model: { provider: "faux", id: "test" } });
      const mock = createMockAPI();
      attachMockJournal(mock, ctx);
      setBoard(activeBoard());
      startSupervisor(mock.api, ctx, "Review approved work");
      vi.mocked(ctx.ui.setStatus).mockClear();
      const advice = {
        action: "guide" as const,
        message: "Continue approved work",
        taskIds: ["active"],
        evidenceRefs: [],
      };
      const result = await reviewSupervisor(
        mock.api,
        ctx,
        new AbortController().signal,
        async () => {
          expect(supervisorState()).toMatchObject({
            status: "reviewing",
            reviews: 1,
            continuations: 0,
          });
          const statuses = vi.mocked(ctx.ui.setStatus).mock.calls;
          if (mode === "tui") {
            expect(statuses).toContainEqual(["continuous-supervisor", undefined]);
            expect(
              statuses.some(
                ([key, value]) => key === "continuous-supervisor" && value !== undefined,
              ),
            ).toBe(false);
            expect(statuses).toContainEqual(["til-done", "监督检查中 · 已完成 0/1"]);
          } else
            expect(statuses).toContainEqual(["continuous-supervisor", "Supervisor: checking 1/40"]);
          return { advice };
        },
      );
      expect(result).toEqual(advice);
      expect(supervisorState()).toMatchObject({ reviews: 1, continuations: 1, tokens: 0, cost: 0 });
    },
  );

  it("does not consume a real supervisor persistence error as optional publication", () => {
    const ctx = createMockContext();
    Object.assign(ctx, { model: { provider: "faux", id: "test" } });
    const mock = createMockAPI();
    mock.appendEntry.mockImplementation(() => {
      throw new Error("Actual checkpoint failure");
    });
    expect(() => startSupervisor(mock.api, ctx, "Approved goal")).toThrow(
      "Actual checkpoint failure",
    );
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  it("publishes restored owner facts, never the transient pre-recovery view", async () => {
    const h = lifecycle();
    await h.command("supervise Restored goal");
    const captured = vi.spyOn(capture, "captureUiSummary");
    currentRuntime().supervisor = undefined;
    await h.fire("session_tree");
    expect(captured).toHaveBeenCalled();
    for (const result of captured.mock.results) {
      expect(result.value.goals).toContainEqual({ source: "supervisor", text: "Restored goal" });
    }
    expect(render(h.ctx)).toContain("Restored goal");
    expect(supervisorState()).toMatchObject({ status: "fault", holdCause: "interrupted" });
  });

  it("does not reinterpret a TUI transport failure during restore as a runtime journal fault", async () => {
    const h = lifecycle();
    vi.mocked(h.ctx.ui.setStatus).mockImplementation(() => {
      throw new Error("UI unavailable");
    });
    vi.mocked(h.ctx.ui.setWidget).mockImplementation(() => {
      throw new Error("UI unavailable");
    });
    await expect(h.fire("session_start")).resolves.toBeUndefined();
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["tui", "rpc", "print"])("clears only owned keys on %s shutdown", async (mode) => {
    const h = lifecycle();
    Object.assign(h.ctx, { mode });
    h.ctx.ui.setStatus("other-extension", "keep");
    vi.mocked(h.ctx.ui.setStatus).mockClear();
    await h.fire("session_shutdown");
    const expected =
      mode === "tui"
        ? [
            ["til-done", undefined],
            ["til-done-active", undefined],
            ["continuous-supervisor", undefined],
          ]
        : [["continuous-supervisor", undefined]];
    expect(vi.mocked(h.ctx.ui.setStatus).mock.calls).toEqual(expected);
    if (mode === "tui") expect(h.ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, undefined);
    else expect(h.ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("retains budgets, faults, repairs and receipt ownership across capture/transport failures", () => {
    const ctx = createMockContext();
    Object.assign(ctx, { model: { provider: "faux", id: "test" } });
    const mock = createMockAPI();
    attachMockJournal(mock, ctx);
    setBoard(activeBoard());
    startSupervisor(mock.api, ctx, "Approved goal");
    const runtime = currentRuntime();
    runtime.journalFault = "Existing durable fault";
    runtime.boardRepair = {
      sessionId: "test-session",
      controlEntryId: "saved-board",
      projectedDigest: "a".repeat(64),
      faultMessage: "Existing repair",
      ownsJournalFault: true,
    };
    runtime.preflightRepair = { ...runtime.boardRepair, controlEntryId: "saved-preflight" };
    const before = structuredClone({
      board: runtime.board,
      supervisor: runtime.supervisor,
      fault: runtime.journalFault,
      boardRepair: runtime.boardRepair,
      preflightRepair: runtime.preflightRepair,
    });
    const store = runtime.receiptStore;
    const identity = runtime.receiptIdentity;
    const captured = vi.spyOn(capture, "captureUiSummary").mockImplementation(() => {
      throw new Error("UI identity changed");
    });
    updateUI(ctx, runtime.board);
    captured.mockRestore();
    vi.mocked(ctx.ui.setWidget).mockImplementation(() => {
      throw new Error("UI unavailable");
    });
    vi.mocked(ctx.ui.setStatus).mockImplementation(() => {
      throw new Error("UI unavailable");
    });
    updateUI(ctx, runtime.board);
    expect({
      board: runtime.board,
      supervisor: runtime.supervisor,
      fault: runtime.journalFault,
      boardRepair: runtime.boardRepair,
      preflightRepair: runtime.preflightRepair,
    }).toEqual(before);
    expect(runtime.receiptStore).toBe(store);
    expect(runtime.receiptIdentity).toBe(identity);
    expect(mock.appendEntry).toHaveBeenCalledTimes(1);
  });

  it("publishes a zero-task repair hold and multiple blockers consistently without suggesting execution", () => {
    const ctx = createMockContext();
    currentRuntime().preflightRepair = {
      sessionId: "test-session",
      controlEntryId: "saved",
      projectedDigest: "a".repeat(64),
      faultMessage: "Projection pending",
      ownsJournalFault: false,
    };
    updateUI(ctx, createEmptyBoard());
    expect(render(ctx)).toContain("状态同步未完成");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "til-done",
      expect.stringContaining("状态同步未完成"),
    );
    currentRuntime().journalFault = "Durable fault";
    vi.mocked(ctx.hasPendingMessages).mockReturnValue(true);
    updateUI(ctx, activeBoard());
    const output = render(ctx);
    expect(output).toContain("需检查");
    expect(output).toContain("另 2 项");
    expect(output).not.toMatch(/(?:下一步|待办)：\/task-supervisor continue/);
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("til-done", "需检查 · 已完成 0/1");
  });

  it("clears remaining owned shutdown keys even when one TUI transport operation fails", async () => {
    const h = lifecycle();
    vi.mocked(h.ctx.ui.setStatus).mockImplementationOnce(() => {
      throw new Error("UI unavailable");
    });
    await h.fire("session_shutdown");
    expect(h.ctx.ui.setStatus).toHaveBeenCalledTimes(3);
    expect(h.ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, undefined);
    expect(currentRuntime().journalFault).toBeUndefined();
  });

  it.each(["ready", "implementing", "reviewing"] as const)(
    "compiled active board with %s task shows 任务流程已启用（任务记录） on widget AND bar",
    (taskStatus) => {
      const ctx = createMockContext();
      const board = {
        ...createEmptyBoard(),
        workflowStatus: "active" as const,
        tasks: [
          {
            id: "t-active",
            title: "Approved work",
            prompt: "Work",
            profile: "worker",
            phase: 1,
            dependencies: [],
            status: taskStatus,
            createdAt: "now",
            updatedAt: "now",
          },
        ],
        phases: [{ phase: 1, status: "active" as const }],
      };
      updateUI(ctx, board);
      const output = render(ctx);
      expect(output).toContain("任务流程已启用（任务记录）");
      expect(output).not.toContain("只读规划");
      expect(ctx.ui.setStatus).toHaveBeenCalledWith(
        "til-done",
        expect.stringContaining("任务流程已启用（任务记录）"),
      );
      expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done-active", undefined);
    },
  );

  it("inactive planning board keeps 只读规划 on widget AND bar", () => {
    const ctx = createMockContext();
    const board = {
      ...createEmptyBoard(),
      workflowStatus: "inactive" as const,
      tasks: [
        {
          id: "t-draft",
          title: "Draft task",
          prompt: "Draft",
          profile: "worker",
          phase: 1,
          dependencies: [],
          status: "draft" as const,
          createdAt: "now",
          updatedAt: "now",
        },
      ],
      phases: [],
    };
    updateUI(ctx, board);
    const output = render(ctx);
    expect(output).toContain("只读规划");
    expect(output).not.toContain("任务流程已启用（任务记录）");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("til-done", expect.stringContaining("只读规划"));
  });

  it("completed board keeps 任务记录已结束 on widget AND bar", () => {
    const ctx = createMockContext();
    const now = new Date().toISOString();
    const board = {
      ...createEmptyBoard(),
      workflowStatus: "completed" as const,
      finalAcceptanceTaskId: "t-done",
      tasks: [
        {
          id: "t-done",
          title: "Done task",
          prompt: "Done",
          profile: "worker",
          phase: 1,
          dependencies: [],
          status: "done" as const,
          createdAt: now,
          updatedAt: now,
          completionEvidence: {
            summary: "Completed",
            refs: [
              {
                kind: "review" as const,
                label: "review",
                status: "passed" as const,
                ref: "test://r",
              },
            ],
          },
        },
      ],
      phases: [{ phase: 1, status: "completed" as const, completedAt: now }],
    };
    updateUI(ctx, board);
    const output = render(ctx);
    expect(output).toContain("任务记录已结束");
    expect(output).not.toContain("只读规划");
    expect(output).not.toContain("任务流程已启用（任务记录）");
    expect(ctx.ui.setStatus).toHaveBeenCalledWith(
      "til-done",
      expect.stringContaining("任务记录已结束"),
    );
  });
});
