import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { showTaskList, TASK_WIDGET_KEY, updateTaskWidget } from "../board-ui";
import { DOWN, ESC, installCustomUI } from "./helpers/custom-ui";
import { createEmptyBoard } from "../engine";
import { captureUiSummary } from "../ui-capture";
import { currentRuntime } from "../runtime";
import { resetState, updateUI } from "../state";
import { holdSupervisor, startSupervisor } from "../supervisor";
import type { TaskBoardSnapshot, TaskRecord, TaskStatus } from "../types";
import {
  attachMockJournal,
  createMockAPI,
  createMockContext,
  createMockTheme,
} from "./helpers/mocks";

function task(id: string, status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    prompt: "Approved local work",
    profile: "worker",
    phase: 1,
    dependencies: [],
    status,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

function board(tasks: TaskRecord[]): TaskBoardSnapshot {
  return {
    ...createEmptyBoard(),
    generation: 5,
    workflowStatus: "active",
    tasks,
    phases: [
      { phase: 1, status: "active", title: "Implement" },
      { phase: 2, status: "pending", title: "Accept" },
    ],
  };
}

function widget(ctx: ReturnType<typeof createMockContext>, theme?: Theme) {
  const content = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1];
  if (typeof content !== "function") throw new Error("Task widget was not installed");
  if (!theme) {
    theme = createMockTheme();
    vi.mocked(theme.fg).mockImplementation((_color, value) => value);
    vi.mocked(theme.bold).mockImplementation((value) => value);
  }
  return content({} as TUI, theme);
}

function supervisedContext() {
  const ctx = createMockContext();
  const api = createMockAPI();
  attachMockJournal(api, ctx);
  Object.assign(ctx, { model: { provider: "faux", id: "test" } });
  startSupervisor(api.api, ctx, "Review approved work");
  return { ctx, api };
}

describe("visible task board", () => {
  beforeEach(() => {
    resetState();
  });

  it("shows every unfinished state, priorities and blockers without changing the board", () => {
    const snapshot = board([
      task("done", "done"),
      task("abandoned", "abandoned"),
      task("planned", "draft"),
      task("configured", "configured", { phase: 2, dependencies: ["done", "abandoned"] }),
      task("ready", "ready"),
      task("review", "reviewing"),
      task("implement", "implementing", {
        executionRef: { source: "pi-subagents", runId: "run-1" },
      }),
    ]);
    const before = structuredClone(snapshot);
    const ctx = createMockContext();
    updateUI(ctx, snapshot);
    const lines = widget(ctx).render(200);
    expect(lines).toHaveLength(8);
    expect(lines[3]).toContain("已完成 1/7 · 未结束 5 · 放弃 1");
    expect(lines[3]).toContain("█");
    expect(lines[4]).toContain("阶段：Implement");
    expect(lines[5]).toContain("核验中 · review Task review");
    expect(lines[6]).toBe("/task-supervisor tasks · 另 4 项未结束");
    const summary = captureUiSummary(ctx, snapshot);
    expect(summary.tasks.map((item) => item.status)).toEqual(
      snapshot.tasks.map((item) => item.status),
    );
    const notes = summary.tasks.flatMap((item) => item.notes).join("; ");
    expect(notes).toContain("依赖 abandoned 未完成");
    expect(notes).toContain("所在阶段待处理");
    expect(notes).not.toContain("依赖 done 未完成");
    expect(notes).toContain("未编译");
    expect(notes).toContain("执行状态未知");
    expect(lines[0]).toContain("执行状态未知");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, expect.any(Function), {
      placement: "aboveEditor",
    });
    expect(snapshot).toEqual(before);
  });

  it("keeps approved-but-not-started preflight visible on an empty board without granting execution", () => {
    const ctx = createMockContext();
    currentRuntime().preflight = {
      version: 1,
      sessionId: "test-session",
      preflightId: "pf-ui",
      goal: "只修改当前仓库的界面",
      phase: "approved",
      revision: 1,
      planId: "pf-ui.r1",
      planDigest: "a".repeat(64),
      approval: {
        planId: "pf-ui.r1",
        planDigest: "a".repeat(64),
        permissionIds: ["A1"],
        controlEntryId: "permission-record",
        createdAt: "2026-10-16T00:00:00Z",
      },
    };
    const before = structuredClone(currentRuntime().preflight);
    updateTaskWidget(ctx, createEmptyBoard());
    const lines = widget(ctx).render(100);
    expect(lines.join("\n")).toContain("权限已确认，尚未启动");
    expect(lines.join("\n")).toContain("/task-supervisor start");
    expect(lines.length).toBeLessThanOrEqual(8);
    expect(currentRuntime().preflight).toEqual(before);
    expect(currentRuntime().supervisor).toBeUndefined();
  });

  it.each([
    ["planning", "只读规划中"],
    ["awaiting_authorization", "等待权限确认"],
    ["approved", "权限已确认，尚未启动"],
    ["started", "需检查"],
    ["revoked", "权限已撤销"],
    ["interrupted", "需检查"],
  ] as const)(
    "keeps the %s view width-safe without inventing task execution",
    (phase, expected) => {
      const ctx = createMockContext();
      currentRuntime().preflight = {
        version: 1,
        sessionId: "test-session",
        preflightId: "pf-view",
        goal: "只读界面".repeat(20),
        phase,
        revision: 1,
      };
      const before = structuredClone(currentRuntime().preflight);
      updateTaskWidget(ctx, createEmptyBoard());
      expect(widget(ctx).render(160).join("\n")).toContain(expected);
      for (const width of [1, 20, 40, 80, 120]) {
        const lines = widget(ctx).render(width);
        expect(lines.length).toBeLessThanOrEqual(8);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(currentRuntime().preflight).toEqual(before);
    },
  );

  it("does not describe reauthorization of a retained start as never started", () => {
    const ctx = createMockContext();
    currentRuntime().preflight = {
      version: 1,
      sessionId: "test-session",
      preflightId: "pf-view",
      goal: "Existing goal",
      phase: "awaiting_authorization",
      revision: 1,
      started: { goal: "Existing goal", startedAt: "2026-10-16T00:00:00Z" },
    };
    updateTaskWidget(ctx, createEmptyBoard());
    const output = widget(ctx).render(160).join("\n");
    expect(output).toContain("需检查");
    expect(output).toContain("Preflight startup association is incomplete");
    expect(output).not.toContain("尚未启动");
    expect(output).not.toContain("/task-supervisor start");
  });

  it("does not expose another session's planning state", () => {
    const ctx = createMockContext();
    currentRuntime().preflight = {
      version: 1,
      sessionId: "other-session",
      preflightId: "pf-other",
      goal: "Other private goal",
      phase: "approved",
      revision: 1,
    };
    updateTaskWidget(ctx, createEmptyBoard());
    const output = widget(ctx).render(160).join("\n");
    expect(output).toContain("身份需检查");
    expect(output).not.toContain("Other private goal");
  });

  it.each(["repair", "fault"] as const)(
    "shows a held %s before an approval success label",
    (kind) => {
      const ctx = createMockContext();
      currentRuntime().preflight = {
        version: 1,
        sessionId: "test-session",
        preflightId: "pf-view",
        goal: "Local",
        phase: "approved",
        revision: 1,
      };
      currentRuntime().journalFault = "Inspect journal";
      if (kind === "repair")
        currentRuntime().preflightRepair = {
          sessionId: "test-session",
          controlEntryId: "control",
          projectedDigest: "a".repeat(64),
          faultMessage: "Inspect journal",
          ownsJournalFault: true,
        };
      updateTaskWidget(ctx, createEmptyBoard());
      const output = widget(ctx).render(200).join("\n");
      expect(output).toContain("需检查");
      expect(output).toContain("Inspect journal");
      if (kind === "repair") expect(output).toContain("其他 2 项");
      expect(output).not.toContain("权限已确认，尚未启动");
      expect(output).toContain("下一步未一致确认，请查看状态");
      vi.mocked(ctx.hasPendingMessages).mockReturnValue(true);
      updateTaskWidget(ctx, createEmptyBoard());
      expect(widget(ctx).render(200).join("\n")).toContain("需检查");
      expect(widget(ctx).render(200).join("\n")).not.toContain("下一步：/task-supervisor start");
    },
  );

  it.each(["tui", "rpc"] as const)(
    "reports overflow and retains an uncapped list of all 100 tasks (%s)",
    async (mode) => {
      const snapshot = board(Array.from({ length: 100 }, (_, i) => task(`t-${i}`, "ready")));
      const ctx = createMockContext();
      updateTaskWidget(ctx, snapshot);
      expect(widget(ctx).render(120).join("\n")).toContain("另 99 项未结束");
      Object.assign(ctx, { mode });
      const ui =
        mode === "tui"
          ? installCustomUI(ctx, (d) => {
              for (let i = 0; i < 103; i++) d.press(DOWN);
              d.press(ESC);
            })
          : undefined;
      await showTaskList(ctx, snapshot);
      if (ui) {
        for (const task of snapshot.tasks) expect(ui.rendered.join("\n")).toContain(task.id);
        expect(ctx.ui.select).not.toHaveBeenCalled();
        ui.assertNoScriptErrors();
      } else expect(vi.mocked(ctx.ui.select).mock.calls[0]?.[1]).toHaveLength(100);
      expect(ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it.each(["tui", "rpc"] as const)(
    "folds completed work without deleting its evidence (%s)",
    async (mode) => {
      const snapshot = board([
        task("verified", "done", {
          completionEvidence: {
            summary: "Fresh review passed",
            refs: [
              {
                kind: "command",
                label: "Tests",
                status: "passed",
                ref: "tool:validation",
                exitCode: 0,
              },
              { kind: "review", label: "Manual review", status: "passed" },
            ],
            residualRisks: ["No live business run"],
          },
        }),
      ]);
      const before = structuredClone(snapshot);
      const ctx = createMockContext();
      vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => options[0]);
      updateTaskWidget(ctx, snapshot);
      expect(widget(ctx).render(120).join("\n")).not.toContain("[done]");
      Object.assign(ctx, { mode });
      const ui =
        mode === "tui"
          ? installCustomUI(ctx, (d) => {
              d.open(4);
              d.scrollAll();
              d.press(ESC);
              d.press(ESC);
            })
          : undefined;
      await showTaskList(ctx, snapshot);
      if (ui) {
        expect(ui.rendered.join("\n")).toContain("tool:validation");
        expect(ui.rendered.join("\n")).toContain("残余风险：No live business run");
        ui.assertNoScriptErrors();
      } else {
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("tool:validation"),
          "info",
        );
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Residual risk: No live business run"),
          "info",
        );
      }
      expect(snapshot).toEqual(before);
    },
  );

  it("shows pause reasons, decisions and supervisor-only faults even on an empty board", () => {
    const { ctx, api } = supervisedContext();
    holdSupervisor(api.api, ctx, "fault", "Validation unavailable");
    expect(widget(ctx).render(120).join("\n")).toContain("Supervisor: fault");
    expect(widget(ctx).render(120).join("\n")).toContain("Validation unavailable");
    const snapshot: TaskBoardSnapshot = {
      ...board([task("t-1", "ready")]),
      workflowStatus: "paused",
      pauseReason: "Maintenance",
    };
    updateTaskWidget(ctx, snapshot);
    expect(widget(ctx).render(120).join("\n")).toContain("Maintenance");
    snapshot.workflowStatus = "paused";
    snapshot.pauseReason = undefined;
    updateTaskWidget(ctx, snapshot);
    expect(widget(ctx).render(120).join("\n")).toContain("Supervisor: fault");
    expect(widget(ctx).render(120).join("\n")).not.toContain("Maintenance");
    updateTaskWidget(ctx, {
      ...snapshot,
      workflowStatus: "waiting_for_decision",
      decision: {
        id: "decision-1",
        taskId: "t-1",
        question: "Choose compatibility",
        whyUserOwned: "User decision",
        createdAt: "now",
      },
    });
    expect(widget(ctx).render(120).join("\n")).toContain(
      "Decision decision-1: Choose compatibility",
    );
  });

  it.each(["tui", "rpc"] as const)(
    "displays a malformed journal fault and keeps the full-list view accessible (%s)",
    async (mode) => {
      currentRuntime().journalFault = "Invalid journal";
      const ctx = createMockContext();
      const snapshot = createEmptyBoard();
      updateTaskWidget(ctx, snapshot);
      expect(widget(ctx).render(120).join("\n")).toContain("注意：Invalid journal");
      Object.assign(ctx, { mode });
      const ui =
        mode === "tui"
          ? installCustomUI(ctx, (d) => {
              d.open(0);
              d.scrollAll();
              d.press(ESC);
              d.press(ESC);
            })
          : undefined;
      await showTaskList(ctx, snapshot);
      if (ui) {
        expect(ui.rendered.join("\n")).toContain("Invalid journal");
        ui.assertNoScriptErrors();
      } else
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("Invalid journal\nNo tasks"),
          "info",
        );
    },
  );

  it("clears an empty fresh board and does not install custom widgets outside TUI", async () => {
    const ctx = createMockContext();
    updateTaskWidget(ctx, createEmptyBoard());
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, undefined);
    updateTaskWidget(ctx, {
      ...createEmptyBoard(),
      workflowStatus: "paused",
      pauseReason: "User hold before planning",
    });
    expect(widget(ctx).render(120).join("\n")).toContain("User hold before planning");
    vi.mocked(ctx.ui.setWidget).mockClear();
    for (const mode of ["rpc", "print"]) {
      Object.assign(ctx, { mode });
      updateTaskWidget(ctx, board([task("t-1", "ready")]));
    }
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    Object.assign(ctx, { hasUI: false, mode: "tui" });
    updateTaskWidget(ctx, board([task("t-1", "ready")]));
    await showTaskList(ctx, board([task("t-1", "ready")]));
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps terminal controls and long CJK/multiline text within eight single-width lines", () => {
    const ctx = createMockContext();
    updateTaskWidget(
      ctx,
      board([
        task("t-1", "ready", {
          title: "\u001b[31m登录\u001b[0m\n\t接口\u001b]0;unwanted title\u0007".repeat(20),
          dependencies: ["missing"],
        }),
      ]),
    );
    const theme = createMockTheme();
    vi.mocked(theme.fg).mockImplementation((_color, value) => `\u001b[36m${value}\u001b[39m`);
    vi.mocked(theme.bold).mockImplementation((value) => `\u001b[1m${value}\u001b[22m`);
    const component = widget(ctx, theme);
    component.invalidate();
    for (const width of [0, 1, 2, 10, 35, 120]) {
      const lines = component.render(width);
      expect(lines.length).toBeLessThanOrEqual(8);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        expect(stripTerminalSequences(line)).not.toMatch(/\p{Cc}/u);
        expect(line).not.toContain("\u001b[31m");
      }
    }
    expect(
      captureUiSummary(ctx, board([task("t-1", "ready", { dependencies: ["missing"] })])).tasks[0]
        ?.notes,
    ).toContain("依赖 missing 未完成");
    expect(component.render(120).join("\n")).not.toContain("unwanted title");
  });

  it("uses native theme roles and explicit state text without relying on color", () => {
    const ctx = createMockContext();
    const snapshot = board([
      task("短", "implementing", { title: "Implement login" }),
      task("longer-id", "ready", { title: "Verify login", dependencies: ["missing"] }),
    ]);
    updateTaskWidget(ctx, snapshot);
    const plain = widget(ctx).render(150);
    expect(plain[5]).toContain("处理中（任务记录） · 短 Implement login");
    expect(plain[6]).toContain("另 1 项未结束");
    expect(plain[6]).not.toContain("0 more");
    expect(plain[6]).not.toContain("0 folded");
    const theme = createMockTheme();
    widget(ctx, theme).render(200);
    expect(theme.fg).toHaveBeenCalledWith("muted", expect.stringContaining("已完成"));
    expect(theme.fg).toHaveBeenCalledWith("warning", expect.stringContaining("注意："));
    currentRuntime().journalFault = "Invalid journal";
    updateTaskWidget(ctx, snapshot);
    widget(ctx, theme).render(200);
    expect(theme.fg).toHaveBeenCalledWith("warning", "注意：Invalid journal");
  });

  it.each(["tui", "rpc"] as const)(
    "keeps state and the full-list entry visible when long IDs consume the current row (%s)",
    async (mode) => {
      const ctx = createMockContext();
      const snapshot = board([task("编号".repeat(30), "ready", { title: "Readable title" })]);
      updateTaskWidget(ctx, snapshot);
      const row = stripTerminalSequences(widget(ctx).render(72)[5]!);
      expect(row).toContain("待开始（已就绪）");
      expect(visibleWidth(row)).toBeLessThanOrEqual(72);
      expect(widget(ctx).render(72)[6]).toBe("/task-supervisor tasks");
      Object.assign(ctx, { mode });
      const ui =
        mode === "tui"
          ? installCustomUI(ctx, (d) => {
              d.open(4);
              d.scrollAll();
              d.press(ESC);
              d.press(ESC);
            })
          : undefined;
      await showTaskList(ctx, snapshot);
      if (ui) {
        expect(ui.rendered.join("\n")).toContain("Readable title");
        ui.assertNoScriptErrors();
      } else
        expect(ctx.ui.select).toHaveBeenCalledWith(expect.any(String), [
          expect.stringContaining("Readable title"),
        ]);
    },
  );

  it.each(["tui", "rpc"] as const)(
    "captures session UI data before deferred render and modal awaits (%s)",
    async (mode) => {
      const { ctx } = supervisedContext();
      const snapshot = board([task("t-1", "ready")]);
      updateTaskWidget(ctx, snapshot);
      const component = widget(ctx);
      const captured = component.render(120);
      snapshot.tasks[0]!.title = "Changed after widget capture";
      snapshot.tasks[0]!.id = "Changed ID";
      expect(component.render(120)).toEqual(captured);
      snapshot.tasks[0]!.title = "Task t-1";
      snapshot.tasks[0]!.id = "t-1";
      const saved = currentRuntime().supervisor;
      currentRuntime().supervisor = undefined;
      expect(component.render(120).join("\n")).toContain("监督已启用");
      currentRuntime().supervisor = saved;
      vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => {
        snapshot.tasks[0]!.title = "Changed during selection";
        currentRuntime().supervisor!.reason = "Changed during selection";
        return options[0];
      });
      Object.assign(ctx, { mode });
      const ui =
        mode === "tui"
          ? installCustomUI(ctx, (d) => {
              snapshot.tasks[0]!.title = "Changed during selection";
              currentRuntime().supervisor!.reason = "Changed during selection";
              d.open(4);
              d.scrollAll();
              d.press(ESC);
              d.press(ESC);
            })
          : undefined;
      await showTaskList(ctx, snapshot);
      if (ui) {
        expect(ui.rendered.join("\n")).toContain("标题：Task t-1");
        expect(ui.rendered.join("\n")).not.toContain("Changed during selection");
        ui.assertNoScriptErrors();
      } else {
        expect(ctx.ui.notify).toHaveBeenCalledWith(
          expect.stringContaining("[ready] t-1 Task t-1"),
          "info",
        );
        expect(ctx.ui.notify).not.toHaveBeenCalledWith(
          expect.stringContaining("Changed during selection"),
          "info",
        );
      }
    },
  );

  it("orders equally active tasks by phase and avoids falsely blocking active-phase configuration", () => {
    const ctx = createMockContext();
    updateTaskWidget(
      ctx,
      board([
        task("later", "reviewing", { phase: 2 }),
        task("first", "implementing"),
        task("configured", "configured"),
      ]),
    );
    const lines = widget(ctx).render(120);
    expect(lines[5]).toContain("first");
    expect(lines[6]).toContain("另 2 项未结束");
    expect(
      captureUiSummary(ctx, board([task("configured", "configured")])).tasks[0]?.notes,
    ).not.toContain("所在阶段待处理");
  });
});
