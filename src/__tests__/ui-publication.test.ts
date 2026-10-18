import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TUI } from "@earendil-works/pi-tui";
import * as capture from "../ui-capture";
import * as compact from "../board-view";
import * as status from "../status-ui";
import { TASK_WIDGET_KEY, updateTaskWidget } from "../board-ui";
import { createEmptyBoard } from "../engine";
import { currentRuntime } from "../runtime";
import { getBoard, resetState, setBoard, updateUI } from "../state";
import { createWriteTasksTool } from "../tools";
import { reviewSupervisor, startSupervisor, supervisorState } from "../supervisor";
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
        ["til-done", undefined],
        ["til-done-active", undefined],
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
