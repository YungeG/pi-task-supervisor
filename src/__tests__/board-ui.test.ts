import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { showTaskList, TASK_WIDGET_KEY, updateTaskWidget } from "../board-ui";
import { createEmptyBoard } from "../engine";
import { currentRuntime } from "../runtime";
import { resetState, updateUI } from "../state";
import { holdSupervisor, startSupervisor } from "../supervisor";
import type { TaskBoardSnapshot, TaskRecord, TaskStatus } from "../types";
import { createMockAPI, createMockContext, createMockTheme } from "./helpers/mocks";

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
    expect(lines[0]).toBe("╭─ Tasks  1/7 done · 5 unfinished · 1 abandoned");
    expect(lines[1]).toContain("Phase 1: Implement");
    expect(lines.slice(2, 7).map((line) => line.split(/\s+/u)[2])).toEqual([
      "review",
      "doing",
      "ready",
      "queued",
      "draft",
    ]);
    expect(lines.join("\n")).toContain("waiting for abandoned; waiting for phase 2");
    expect(lines.join("\n")).not.toContain("waiting for done");
    expect(lines.join("\n")).toContain("plan not compiled");
    expect(lines.join("\n")).toContain("run pi-subagents:run-1");
    expect(lines.at(-1)).toBe("╰─ /task-supervisor tasks · 2 folded");
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, expect.any(Function), {
      placement: "aboveEditor",
    });
    expect(snapshot).toEqual(before);
  });

  it("reports overflow and retains an uncapped list of all 100 tasks", async () => {
    const snapshot = board(Array.from({ length: 100 }, (_, i) => task(`t-${i}`, "ready")));
    const ctx = createMockContext();
    updateTaskWidget(ctx, snapshot);
    expect(widget(ctx).render(120).at(-1)).toContain("+95 more");
    await showTaskList(ctx, snapshot);
    expect(vi.mocked(ctx.ui.select).mock.calls[0]?.[1]).toHaveLength(100);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("folds completed work without deleting its evidence", async () => {
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
    await showTaskList(ctx, snapshot);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("tool:validation"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Residual risk: No live business run"),
      "info",
    );
    expect(snapshot).toEqual(before);
  });

  it("shows pause reasons, decisions and supervisor-only faults even on an empty board", () => {
    const { ctx, api } = supervisedContext();
    holdSupervisor(api.api, ctx, "fault", "Validation unavailable");
    expect(widget(ctx).render(120).join("\n")).toContain(
      "Supervisor: fault — Validation unavailable",
    );
    const snapshot: TaskBoardSnapshot = {
      ...board([task("t-1", "ready")]),
      workflowStatus: "paused",
      pauseReason: "Maintenance",
    };
    updateTaskWidget(ctx, snapshot);
    expect(widget(ctx).render(120).join("\n")).toContain("Paused: Maintenance");
    snapshot.workflowStatus = "paused";
    snapshot.pauseReason = undefined;
    updateTaskWidget(ctx, snapshot);
    expect(widget(ctx).render(120).join("\n")).toContain("Paused: Paused by user");
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
      "Decision decision-1 (t-1): Choose compatibility",
    );
  });

  it("displays a malformed journal fault and keeps the full-list view accessible", async () => {
    currentRuntime().journalFault = "Invalid journal";
    const ctx = createMockContext();
    const snapshot = createEmptyBoard();
    updateTaskWidget(ctx, snapshot);
    expect(widget(ctx).render(120).join("\n")).toContain("Fault: Invalid journal");
    await showTaskList(ctx, snapshot);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Invalid journal\nNo tasks"),
      "info",
    );
  });

  it("clears an empty fresh board and does not install custom widgets outside TUI", async () => {
    const ctx = createMockContext();
    updateTaskWidget(ctx, createEmptyBoard());
    expect(ctx.ui.setWidget).toHaveBeenCalledWith(TASK_WIDGET_KEY, undefined);
    updateTaskWidget(ctx, {
      ...createEmptyBoard(),
      workflowStatus: "paused",
      pauseReason: "User hold before planning",
    });
    expect(widget(ctx).render(120).join("\n")).toContain("Paused: User hold before planning");
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
    expect(component.render(1000).join("\n")).toContain("waiting for missing");
    expect(component.render(120).join("\n")).not.toContain("unwanted title");
  });

  it("uses native theme roles and aligned columns without relying on color for status", () => {
    const ctx = createMockContext();
    const snapshot = board([
      task("短", "implementing", { title: "Implement login" }),
      task("longer-id", "ready", { title: "Verify login", dependencies: ["missing"] }),
    ]);
    updateTaskWidget(ctx, snapshot);
    const plain = widget(ctx).render(150);
    const firstTitle = plain[2]!.indexOf("Implement login");
    const secondTitle = plain[3]!.indexOf("Verify login");
    expect(visibleWidth(plain[2]!.slice(0, firstTitle))).toBe(
      visibleWidth(plain[3]!.slice(0, secondTitle)),
    );
    expect(plain[2]).toContain("▶ doing");
    expect(plain[3]).toContain("● ready");
    expect(plain.at(-1)).not.toContain("0 more");
    expect(plain.at(-1)).not.toContain("0 folded");
    const theme = createMockTheme();
    widget(ctx, theme).render(200);
    expect(theme.fg).toHaveBeenCalledWith("accent", "**Tasks**");
    expect(theme.fg).toHaveBeenCalledWith("success", expect.stringContaining("● ready"));
    expect(theme.fg).toHaveBeenCalledWith("warning", " · waiting for missing");
    expect(theme.bold).toHaveBeenCalledWith("Implement login");
    currentRuntime().journalFault = "Invalid journal";
    updateTaskWidget(ctx, snapshot);
    widget(ctx, theme).render(200);
    expect(theme.fg).toHaveBeenCalledWith("error", "Fault: Invalid journal");
  });

  it("caps long IDs so they cannot consume the title column", () => {
    const ctx = createMockContext();
    updateTaskWidget(ctx, board([task("编号".repeat(30), "ready", { title: "Readable title" })]));
    const row = stripTerminalSequences(widget(ctx).render(72)[2]!);
    expect(row).toMatch(/…\s+Readable title/u);
    expect(visibleWidth(row.slice(0, row.indexOf("Readable title")))).toBeLessThanOrEqual(28);
  });

  it("captures session UI data before deferred render and modal awaits", async () => {
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
    expect(component.render(120).join("\n")).toContain("Supervisor: active");
    currentRuntime().supervisor = saved;
    vi.mocked(ctx.ui.select).mockImplementation(async (_title, options) => {
      snapshot.tasks[0]!.title = "Changed during selection";
      currentRuntime().supervisor!.reason = "Changed during selection";
      return options[0];
    });
    await showTaskList(ctx, snapshot);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("[ready] t-1 Task t-1"),
      "info",
    );
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(
      expect.stringContaining("Changed during selection"),
      "info",
    );
  });

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
    expect(lines[2]).toContain("first");
    expect(lines[3]).toContain("later");
    expect(lines[4]).not.toContain("waiting for phase");
  });
});
