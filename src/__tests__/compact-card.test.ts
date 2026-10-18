import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
// Actual installed SDK constructor; no config path/create/reload and no type coercion.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createReadOnlyBoard, renderCompactBoard } from "../board-view";
import type { UiBoardView, UiSummary, UiViewEnvironment } from "../ui-view";
import type { TaskRecord } from "../types";
import { createMockTheme } from "./helpers/mocks";

vi.mock("@earendil-works/pi-tui", async (original) => original());
vi.mock("../runtime", () => {
  throw new Error("card cannot read runtime");
});
vi.mock("../human-control", () => {
  throw new Error("card cannot read approval state");
});
function plainTheme(): Theme {
  const theme = createMockTheme();
  theme.fg = (_role, text) => text;
  theme.bold = (text) => text;
  return theme;
}
const theme = plainTheme();
const legacy = "Legacy receipt format requires explicit recover/migration for unfinished goals";
function summary(): UiSummary {
  return {
    scope: { sessionId: "card-session", leafId: "leaf", generation: 12, capturedAt: 123 },
    visible: true,
    goals: [{ source: "supervisor", text: "按照计划书推进至完成" }],
    headline: { source: "receipt", level: "error", text: "需检查" },
    blockers: [
      { source: "receipt", level: "error", text: legacy },
      { source: "board", level: "warning", text: "其他门槛一" },
      { source: "host", level: "warning", text: "其他门槛二" },
      { source: "supervisor", level: "warning", text: "其他门槛三" },
    ],
    next: { source: "supervisor", level: "warning", text: "下一步未一致确认，请查看状态" },
    counts: { done: 4, total: 12, unfinished: 8, abandoned: 0 },
    phase: "实源包 A：先形成完整有限提案，再等待明确审批",
    tasks: [
      {
        id: "t-2.1",
        phase: 2,
        status: "implementing",
        title: "准备包 A 的准确读集、治理、累计帽与小样方案",
        notes: [],
      },
    ],
    acceptance: "验收任务 t-5.2: configured",
  };
}
function fullView(s: UiSummary): UiBoardView {
  const tasks: TaskRecord[] = s.tasks.map((task) => ({
    ...task,
    profile: "fixture",
    prompt: "完整任务材料",
    dependencies: [],
    createdAt: "fixture",
    updatedAt: "fixture",
  }));
  return {
    summary: s,
    board: {
      version: 2,
      generation: 12,
      workflowStatus: "active",
      tasks,
      phases: [{ phase: 2, status: "active", title: s.phase }],
      stagnantSettles: 0,
    },
    documents: [],
  };
}
function allDetail(s: UiSummary, index: number): string {
  const env: UiViewEnvironment = {
    theme,
    rows: () => 24,
    keybindings: new KeybindingsManager(),
    requestRender: () => {},
  };
  const view = createReadOnlyBoard(fullView(s), env, () => {});
  view.render(80);
  for (let i = 0; i < index; i++) view.handleInput?.("\u001b[B");
  view.handleInput?.("\r");
  let previous = "";
  const pages: string[] = [];
  for (let i = 0; i < 200; i++) {
    const text = view.render(160).map(stripTerminalSequences).join("\n");
    if (text === previous) return pages.join("\n");
    pages.push(text);
    previous = text;
    view.handleInput?.("\u001b[6~");
  }
  throw new Error("Full readonly details did not terminate");
}

describe("resident compact card", () => {
  it("turns the exact reported receipt hold into a bounded eight-line human-readable card", () => {
    const s = summary();
    const before = JSON.stringify(s);
    const lines = renderCompactBoard(s, 80, theme);
    const text = lines.join("\n");
    expect(lines).toHaveLength(8);
    expect(lines[0]).toMatch(/^┌/);
    expect(lines[0]).toContain("需检查");
    expect(text).toContain("另 3 项");
    expect(lines[1]).toContain("已完成 4/12");
    expect(lines[1]).toContain("未结束 8");
    expect(lines[1]).toContain("放弃 0");
    expect((lines[1] ?? "").match(/█/g)).toHaveLength(4);
    expect(lines[2]).toContain("旧版执行记录需显式恢复／迁移");
    expect(lines[3]).toContain("处理指引尚未一致");
    expect(lines[4]).toMatch(/^├/);
    expect(lines[5]).toContain("实源包 A");
    expect(lines[6]).toContain("实施记录");
    expect(lines[6]).toContain("t-2.1");
    expect(lines[7]).toContain("/task-supervisor tasks");
    expect(lines[7]).toContain("验收任务未完成");
    expect(lines[7]).toMatch(/┘$/);
    expect(text).not.toContain("Legacy receipt");
    expect(text).not.toContain("configured");
    expect(text).not.toContain("下一步：下一步");
    expect(text).not.toContain("按照计划书推进至完成");
    expect(JSON.stringify(s)).toBe(before);
  });
  it("retains original goal, raw error, other holds and acceptance metadata in original full details", () => {
    const s = summary();
    const overview = allDetail(s, 0);
    const acceptance = allDetail(s, 2);
    for (const text of [
      s.goals[0]?.text ?? "missing",
      legacy,
      "其他门槛一",
      "其他门槛二",
      "其他门槛三",
      "下一步未一致确认",
      "capturedAt：123",
    ])
      expect(overview).toContain(text);
    expect(acceptance).toContain("验收任务 t-5.2: configured");
  });
  it("does not label an informational headline as a blocker when none was captured", () => {
    const s = summary();
    const text = renderCompactBoard(
      { ...s, headline: { source: "supervisor", level: "info", text: "监督已启用" }, blockers: [] },
      80,
      theme,
    ).join("\n");
    expect(text).not.toContain("阻塞：监督已启用");
    expect(text).toContain("未记录额外阻塞（不是执行许可）");
  });
  it("does not invent translations or actions for unknown owner text", () => {
    const s = summary();
    const unknown = "UNRECOGNIZED_OWNER_CAUSE";
    const text = renderCompactBoard(
      {
        ...s,
        blockers: [{ source: "receipt", level: "error", text: unknown }],
        next: { source: "receipt", level: "warning", text: "EXACT_OWNER_NEXT" },
      },
      80,
      theme,
    ).join("\n");
    expect(text).toContain(unknown);
    expect(text).toContain("EXACT_OWNER_NEXT");
    expect(text).not.toContain("显式恢复／迁移");
  });
  it.each([
    "draft",
    "configured",
    "ready",
    "implementing",
    "reviewing",
    "done",
    "abandoned",
  ] as const)("does not turn %s acceptance-task state into goal acceptance", (status) => {
    const s = summary();
    const text = renderCompactBoard(
      { ...s, acceptance: `验收任务 t-5.2: ${status}` },
      96,
      theme,
    ).join("\n");
    expect(text).not.toContain(`: ${status}`);
    expect(text).not.toContain("目标已验收");
    expect(text).toContain(
      status === "done"
        ? "验收任务已完成"
        : status === "abandoned"
          ? "验收任务已放弃"
          : "验收任务未完成",
    );
  });
  it("does not hide contradictory or unknown acceptance behind a fabricated success", () => {
    const s = summary();
    const text = renderCompactBoard(
      { ...s, acceptance: "验收任务 t-5.2: configured; owner 记录已标记目标完成" },
      80,
      theme,
    ).join("\n");
    expect(text).toContain("验收记录见详情");
    expect(text).not.toContain("目标已验收");
  });
  it.each(["只读规划中", "等待权限确认，尚未启动", "权限已确认，尚未启动", "权限已撤销", "需检查"])(
    "keeps goal and permission state visible before tasks: %s",
    (label) => {
      const s = summary();
      const goal = "仅修改界面";
      const lines = renderCompactBoard(
        {
          ...s,
          goals: [{ source: "preflight", text: goal }],
          headline: { source: "preflight", level: "warning", text: label },
          blockers: [{ source: "preflight", level: "warning", text: label }],
          next: { source: "preflight", level: "warning", text: "查看完整权限方案" },
          counts: { done: 0, total: 0, unfinished: 0, abandoned: 0 },
          tasks: [],
          acceptance: "尚未记录目标验收",
        },
        80,
        theme,
      );
      expect(lines).toHaveLength(8);
      expect(lines[0]).toContain(label);
      expect(lines[1]).toContain(goal);
      expect(lines.join("\n")).toContain("查看完整权限方案");
      expect(lines.join("\n")).toContain("/task-supervisor tasks");
      expect(lines.join("\n")).not.toContain("目标已验收");
    },
  );
  it("distinguishes owner goals before tasks without leaking raw source labels into the card", () => {
    const s = summary();
    const text = renderCompactBoard(
      {
        ...s,
        goals: [
          { source: "supervisor", text: "owner-goal" },
          { source: "preflight", text: "different-goal" },
        ],
        counts: { done: 0, total: 0, unfinished: 0, abandoned: 0 },
        tasks: [],
      },
      96,
      theme,
    ).join("\n");
    expect(text).toContain("owner-goal");
    expect(text).toContain("different-goal");
    expect(text).not.toContain("[supervisor]");
  });
  it.each([0, 1, 2, 8, 24, 31, 32, 40, 72, 80, 96, 120, 200, NaN, Infinity, -1])(
    "fits native cell geometry and safe text at width %s",
    (width) => {
      const s = summary();
      const colored = plainTheme();
      colored.fg = (_name, text) => `\u001b[32m${text}\u001b[0m`;
      const lines = renderCompactBoard(
        { ...s, phase: "中🙂é\u001b]52;c;bad\u0007\u202e".repeat(30) },
        width,
        colored,
      );
      const bound = Number.isFinite(width) ? Math.max(0, Math.min(96, Math.floor(width))) : 0;
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines.every((line) => visibleWidth(line) <= bound)).toBe(true);
      expect(lines.join("\n")).not.toContain("\u001b]52");
      expect(lines.every((line) => !/[\r\n]/.test(line))).toBe(true);
    },
  );
  it("does not read wall clock or mutate frozen inputs", () => {
    const s = summary();
    Object.freeze(s.tasks);
    Object.freeze(s);
    const before = JSON.stringify(s);
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock forbidden");
    });
    try {
      renderCompactBoard(s, 80, theme);
      expect(JSON.stringify(s)).toBe(before);
    } finally {
      now.mockRestore();
    }
  });
});
