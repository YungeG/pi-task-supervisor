import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createReadOnlyBoard, renderCompactBoard } from "../board-view";
import type { UiBoardView, UiViewEnvironment } from "../ui-view";
import type { TaskRecord } from "../types";

vi.mock("@earendil-works/pi-tui", async (original) => original());
vi.mock("../runtime", () => {
  throw new Error("presentation cannot import runtime");
});
vi.mock("../human-control", () => {
  throw new Error("presentation cannot import authority");
});
const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text } as Theme;
const down = "\u001b[B";
const enter = "\r";
const esc = "\u001b";
function task(id: string, phase: number): TaskRecord {
  return {
    id,
    phase,
    title: `task-${id}`,
    prompt: `all-material-${id}`,
    status: "configured",
    dependencies: [],
    profile: "worker",
    createdAt: "2026-10-01",
    updatedAt: "2026-10-02",
  };
}
function data(): UiBoardView {
  const tasks = [
    { ...task("t-1.1", 1), status: "implementing" as const },
    task("t-1.2", 1),
    task("t-2.1", 2),
  ];
  return {
    summary: {
      scope: { sessionId: "session", leafId: "leaf", generation: 9, capturedAt: 123 },
      visible: true,
      goals: [{ source: "supervisor", text: "owner-goal" }],
      headline: { source: "journal", level: "error", text: "会话检查未通过" },
      blockers: [
        { source: "journal", level: "error", text: "会话检查未通过" },
        { source: "board", level: "warning", text: "只读审查申请待核对" },
      ],
      next: { source: "journal", level: "error", text: "先查看只读状态，不盲目恢复" },
      counts: { done: 0, total: 3, abandoned: 0, unfinished: 3 },
      phase: "当前阶段",
      tasks: tasks.map((t) => ({ ...t, notes: [] })),
      acceptance: "尚未确认最终验收",
    },
    board: {
      version: 2,
      generation: 9,
      workflowStatus: "waiting_for_decision",
      tasks,
      phases: [
        { phase: 1, status: "active", title: "当前阶段" },
        { phase: 2, status: "pending", title: "后续阶段" },
      ],
      stagnantSettles: 0,
    },
    documents: [
      {
        id: "overview",
        title: "只读诊断",
        availability: "unknown",
        reason: "原因待核实",
        text: "原始诊断材料",
      },
    ],
  };
}
function harness(view = data(), rows = 14) {
  const done = vi.fn();
  const environment: UiViewEnvironment = {
    theme,
    rows: () => rows,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS) as UiViewEnvironment["keybindings"],
    requestRender: vi.fn(),
  };
  const board = createReadOnlyBoard(view, environment, done);
  const lines = (width = 80) => board.render(width).map(stripTerminalSequences);
  const render = (width = 80) => lines(width).join("\n");
  const key = (value: string) => board.handleInput?.(value);
  const select = (value: string) => {
    for (let i = 0; i < 120; i++) {
      const selected = lines().find((line) => line.startsWith("→ ")) ?? "";
      if (selected.includes(value)) {
        key(enter);
        return;
      }
      if (selected.startsWith("→ ▸")) key(enter);
      key(down);
    }
    throw new Error(`Missing visible readonly entry ${value}`);
  };
  return {
    board,
    done,
    lines,
    render,
    key,
    select,
    setRows: (n: number) => {
      rows = n;
    },
  };
}

describe("structured board presentation contract", () => {
  it("puts captured owner state and next step before task progress; hides debug identity from the main header", () => {
    const h = harness();
    const lines = h.lines();
    expect(lines[0]).toContain("会话检查未通过");
    expect(lines[1]).toContain("先查看只读状态");
    expect(lines[2]).toContain("已完成 0/3");
    expect(lines[2]).toContain("░");
    expect(lines[3]).toMatch(/^─+$/);
    expect(lines[4]).toContain("筛选：全部任务");
    expect(lines.slice(0, 5).join("\n")).not.toMatch(/generation|capturedAt|sessionId/);
    h.key(enter);
    const all = [h.render()];
    h.key("\u001b[F");
    all.push(h.render());
    expect(all.join("\n")).toContain("capturedAt：123");
  });
  it("keeps compact state/blocker/next first, bounded progress and original factual distinctions", () => {
    const v = data();
    const s = v.summary;
    const before = JSON.stringify(s);
    const lines = renderCompactBoard(s, 80, theme);
    expect(lines[0]).toContain("会话检查未通过");
    expect(lines[0]).toContain("另 1 项");
    expect(lines[3]).toContain("待办：先查看只读状态");
    expect(lines[1]).toContain("已完成 0/3");
    expect(lines[1]).toContain("░");
    expect(lines.join("\n")).not.toContain("owner-goal");
    expect(lines[7]).toContain("验收记录见详情");
    expect(lines[6]).toContain("实施记录");
    expect(lines).toHaveLength(8);
    const full = harness(v);
    full.render();
    full.key(enter);
    expect(full.render()).toContain("owner-goal");
    full.key(esc);
    full.key(down);
    full.key(down);
    full.key(enter);
    expect(full.render()).toContain("尚未确认最终验收");
    expect(JSON.stringify(s)).toBe(before);
  });
  it("groups tasks under phases, initially expands only the captured current phase, and toggles locally", () => {
    const view = data();
    const before = JSON.stringify(view);
    const h = harness(view, 24);
    const start = h.render();
    expect(start).toContain("▾ P1");
    expect(start).toContain("▸ P2");
    expect(start).toContain("├─");
    expect(start).toContain("task-t-1.1");
    expect(start).not.toContain("task-t-2.1");
    for (let i = 0; i < 3; i++) h.key(down);
    h.key(enter);
    expect(h.render()).toContain("→ ▸ P1");
    expect(h.render()).not.toContain("task-t-1.1");
    h.key(enter);
    expect(h.render()).toContain("→ ▾ P1");
    expect(h.render()).toContain("task-t-1.1");
    expect(JSON.stringify(view)).toBe(before);
    expect(h.done).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "keeps fixed history/acceptance routes with zero tasks (countsUnknown=%s)",
    (countsUnknown) => {
      const v = data();
      const h = harness({
        ...v,
        board: { ...v.board, tasks: [], phases: [] },
        summary: {
          ...v.summary,
          blockers: countsUnknown
            ? v.summary.blockers
            : v.summary.blockers.filter((b) => b.source !== "journal"),
          tasks: [],
          counts: { done: 0, total: 0, unfinished: 0, abandoned: 0 },
        },
      });
      const text = h.render();
      for (const label of ["总览", "确认与回应", "最终验收"]) expect(text).toContain(label);
      if (countsUnknown) {
        expect(text).toContain("任务视图未恢复");
        expect(text).toContain("数量未知");
        expect(text).not.toContain("0/0");
      } else {
        expect(text).toContain("暂无任务");
        expect(text).toContain("0/0");
      }
      expect(text).not.toContain("100%");
      h.select("确认与回应");
      expect(h.render()).toContain("原请求/历史回应");
      h.key(esc);
      h.key(esc);
      expect(h.done).toHaveBeenCalledOnce();
    },
  );
  it("renders wide native master/detail without turning preview into an answer or full-material review", () => {
    const h = harness();
    const narrow = h.render(80);
    const wide = h.render(120);
    expect(narrow).not.toContain("│");
    expect(wide).toContain("│");
    expect(wide).toContain("预览");
    expect(wide).toContain("Enter");
    expect(wide).toContain("只读审查申请待核对");
    expect(wide).not.toContain("原始诊断材料");
    expect(h.lines(120).every((line) => visibleWidth(line) <= 120)).toBe(true);
    h.key(enter);
    expect(h.render(120)).toContain("Esc 回列表");
    h.key(esc);
    expect(h.render(120)).toContain("│");
    expect(h.done).not.toHaveBeenCalled();
  });
  it("keeps capture JSON out of the overview peek but preserves it in the original full document", () => {
    const v = data();
    const h = harness(
      {
        ...v,
        documents: [
          {
            id: "overview",
            title: "captured",
            availability: "available",
            text: "DEBUG-ONLY-ENTRY sessionId: captured-original",
          },
        ],
      },
      24,
    );
    expect(h.render(120)).not.toContain("DEBUG-ONLY-ENTRY");
    h.key(enter);
    h.render(120);
    h.key("\u001b[F");
    expect(h.render(120)).toContain("DEBUG-ONLY-ENTRY");
  });
  it("previews selected task/phase/history/acceptance facts without changing selection or using preview as complete review", () => {
    const h = harness(data(), 24);
    h.render(120);
    for (let i = 0; i < 3; i++) h.key(down);
    expect(h.render(120)).toContain("阶段完整任务记录");
    h.key(down);
    expect(h.render(120)).toContain("all-material-t-1.1");
    expect(h.render(120)).toContain("不是执行器心跳");
    h.render(100);
    h.board.invalidate();
    expect(h.render(120)).toContain("all-material-t-1.1");
    h.key(enter);
    expect(h.render(120)).toContain("Esc 回列表");
    h.key(esc);
    h.key("\u001b[A");
    h.key("\u001b[A");
    expect(h.render(120)).toContain("监督 owner 目标验收");
    h.key("\u001b[A");
    expect(h.render(120)).toContain("原请求/历史回应，不代表当前授权");
    expect(h.done).not.toHaveBeenCalled();
  });
  it("preserves independent status/phase filters and selected task when returning from full details", () => {
    const h = harness();
    h.render();
    h.key("f");
    h.select("阶段 P2");
    expect(h.render()).toContain("全部任务 / P2");
    expect(h.render()).toContain("task-t-2.1");
    h.select("task-t-2.1");
    h.render();
    h.key("\u001b[F");
    expect(h.render()).toContain("all-material-t-2.1");
    h.key(esc);
    expect(h.render()).toContain("→");
    expect(h.render()).toContain("task-t-2.1");
    h.key("f");
    h.select("已结束");
    expect(h.render()).toContain("没有匹配任务（不代表目标完成）");
    expect(h.render()).toContain("确认与回应");
  });
  it("keeps missing phase records visible rather than dropping task material", () => {
    const v = data();
    const h = harness({ ...v, board: { ...v.board, phases: [], tasks: [task("orphan", 3)] } }, 24);
    expect(h.render()).toContain("P3");
    h.select("task-orphan");
    expect(h.render()).toContain("all-material-orphan");
  });
  it("separates done, abandoned and final acceptance instead of filling progress from abandoned work", () => {
    const v = data();
    const h = harness({
      ...v,
      summary: { ...v.summary, counts: { total: 3, done: 1, abandoned: 1, unfinished: 1 } },
    });
    const line = h.lines()[2] ?? "";
    expect(line).toContain("已完成 1/3");
    expect(line).toContain("放弃 1");
    expect(line.match(/█/g)).toHaveLength(4);
    h.select("最终验收");
    expect(h.render()).toContain("尚未确认最终验收");
  });
  it.each([24, 32, 40, 80, 99, 100, 120, 160])(
    "fits colored CJK/unsafe labels at width %i across mode changes and resize",
    (width) => {
      const v = data();
      const h = harness({
        ...v,
        summary: {
          ...v.summary,
          headline: { ...v.summary.headline, text: "需检查\u001b]52;bad\u0007\u202e中🙂" },
        },
      });
      for (const rows of [8, 9, 14, 24, 40]) {
        h.setRows(rows);
        h.board.invalidate();
        const lines = h.lines(width);
        expect(lines.length).toBeLessThanOrEqual(Math.min(rows, 24));
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(lines.join("\n")).not.toContain("\u001b]52");
      }
    },
  );
});
