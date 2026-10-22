import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { UiBoardView, UiViewEnvironment } from "../ui-view";
import { createReadOnlyBoard, renderCompactBoard } from "../board-view";
import type { TaskRecord, TaskStatus } from "../types";

// Exercise native Text too, rather than setup's Text double.
vi.mock("@earendil-works/pi-tui", async (original) => original());
vi.mock("../runtime", () => {
  throw new Error("board-view must not import runtime");
});
vi.mock("../human-control", () => {
  throw new Error("board-view must not import control");
});
vi.mock("../board-human", () => {
  throw new Error("board-view must not import owner");
});
vi.mock("../engine", () => {
  throw new Error("board-view must not import engine");
});

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const down = "\u001b[B";
const esc = "\u001b";
function fixture(): UiBoardView {
  return {
    summary: {
      scope: { sessionId: "session", leafId: "leaf", generation: 4, capturedAt: 1234 },
      visible: true,
      goals: [{ source: "preflight", text: "零任务目标" }],
      headline: { source: "preflight", level: "warning", text: "待权限确认" },
      blockers: [{ source: "preflight", level: "warning", text: "待权限确认" }],
      next: { source: "preflight", level: "info", text: "查看当前方案" },
      counts: { total: 0, done: 0, abandoned: 0, unfinished: 0 },
      tasks: [],
      acceptance: "owner 验收未提供/未知",
    },
    board: {
      version: 2,
      generation: 4,
      workflowStatus: "inactive",
      tasks: [],
      phases: [],
      stagnantSettles: 0,
    },
    documents: [
      {
        id: "current-board-request",
        title: "当前请求",
        availability: "absent",
        text: "无当前请求",
      },
      {
        id: "latest-board-response",
        title: "最近已保存回应",
        availability: "available",
        text: "原值 saved-value / control-record",
      },
      {
        id: "preflight",
        title: "当前方案",
        availability: "available",
        text: "完整方案 material-end",
      },
    ],
  };
}
function harness(view = fixture(), rows = 24) {
  const done = vi.fn();
  const env: UiViewEnvironment = {
    theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS) as UiViewEnvironment["keybindings"],
    requestRender: vi.fn(),
    rows: () => rows,
  };
  const board = createReadOnlyBoard(view, env, done);
  const render = (width = 80) => board.render(width).map(stripTerminalSequences).join("\n");
  const key = (data: string) => board.handleInput?.(data);
  return {
    board,
    render,
    key,
    done,
    env,
    setRows: (value: number) => {
      rows = value;
    },
  };
}

describe("board-view representative smoke", () => {
  it("keeps confirmation/history/preflight reachable with zero tasks and returns in two Esc levels", () => {
    const h = harness();
    expect(h.render()).toContain("确认与回应");
    expect(h.render()).toContain("暂无任务");
    h.key(down);
    h.key("\r");
    let detail = h.render();
    h.key("\u001b[F");
    detail += h.render();
    expect(detail).toContain("原请求/历史回应，不代表当前授权");
    expect(detail).toContain("saved-value / control-record");
    expect(detail).toContain("material-end");
    h.key(esc);
    expect(h.render()).toContain("→ 确认与回应");
    expect(h.done).not.toHaveBeenCalled();
    h.key(esc);
    h.key(esc);
    expect(h.done).toHaveBeenCalledTimes(1);
  });
  it("bounds compact/full output at representative widths while retaining compact entry and blocker", () => {
    const view = fixture();
    for (const width of [0, 1, 8, 40, 80, 120]) {
      const lines = renderCompactBoard(view.summary, width, theme);
      expect(lines.length).toBeLessThanOrEqual(8);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const h = harness(view);
      expect(h.board.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
      h.key(esc);
      expect(h.done).toHaveBeenCalledTimes(1);
    }
    const compact = renderCompactBoard(view.summary, 100, theme).join("\n");
    expect(compact).toContain("/task-supervisor tasks");
    expect(compact).toContain("待权限确认");
  });
});

function task(id: string, status: TaskStatus = "ready", phase = 1): TaskRecord {
  return {
    id,
    title: `title-${id}`,
    status,
    phase,
    profile: "implementation",
    prompt: `prompt-${id}`,
    dependencies: [],
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
  };
}
function withTasks(tasks: TaskRecord[]): UiBoardView {
  const view = fixture();
  const done = tasks.filter((t) => t.status === "done").length;
  const abandoned = tasks.filter((t) => t.status === "abandoned").length;
  return {
    ...view,
    board: {
      ...view.board,
      tasks,
      phases: [
        { phase: 1, status: "completed", title: "Plan" },
        { phase: 2, status: "active", title: "Implementation" },
      ],
    },
    summary: {
      ...view.summary,
      counts: { total: tasks.length, done, abandoned, unfinished: tasks.length - done - abandoned },
      tasks: tasks.map((t) => ({ ...t, notes: [] })),
    },
  };
}
type Harness = ReturnType<typeof harness>;
function select(h: Harness, label: string): void {
  for (let i = 0; i < 110; i++) {
    if (
      h
        .render(80)
        .split("\n")
        .some((line) => line.startsWith("→ ") && line.includes(label))
    ) {
      h.key("\r");
      return;
    }
    if (
      h
        .render(80)
        .split("\n")
        .some((line) => line.startsWith("→ ▸"))
    )
      h.key("\r");
    h.key(down);
  }
  throw new Error(`No selectable row: ${label}`);
}
function readAll(h: Harness, width = 120): string {
  const pages: string[] = [];
  let previous = "";
  for (let i = 0; i < 300; i++) {
    const current = h.render(width);
    if (current === previous) return pages.join("\n");
    pages.push(current);
    previous = current;
    h.key("\u001b[6~");
  }
  throw new Error("Detail failed to reach end");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

describe("renderCompactBoard", () => {
  it("omits invisible sessions and remains bounded for nonfinite or negative dimensions", () => {
    const s = fixture().summary;
    expect(renderCompactBoard({ ...s, visible: false }, 80, theme)).toEqual([]);
    for (const width of [-1, NaN, Infinity]) {
      expect(renderCompactBoard(s, width, theme).every((line) => visibleWidth(line) === 0)).toBe(
        true,
      );
    }
  });
  it("preserves attention count, entry, all count distinctions and both goal sources under overload", () => {
    const view = withTasks([
      task("doing", "implementing"),
      task("done", "done"),
      task("dropped", "abandoned"),
    ]);
    const s = {
      ...view.summary,
      goals: [
        { source: "supervisor" as const, text: "owner-goal" },
        { source: "preflight" as const, text: "different-goal" },
      ],
      blockers: [
        {
          source: "receipt" as const,
          level: "error" as const,
          text: "RECEIPT " + "long-fault ".repeat(100),
        },
        { source: "board" as const, level: "warning" as const, text: "current question" },
        { source: "repair" as const, level: "warning" as const, text: "repair issue" },
      ],
    };
    const lines = renderCompactBoard(s, 80, theme);
    expect(lines).toHaveLength(8);
    const text = lines.join("\n");
    for (const expected of [
      "已完成 1/3",
      "未结束 1",
      "放弃 1",
      "另 2 项",
      "RECEIPT",
      "/task-supervisor tasks",
      "doing",
    ])
      expect(text).toContain(expected);
    const full = harness({ ...view, summary: s });
    full.render(80);
    full.key("\r");
    const all = readAll(full, 160);
    expect(all).toContain("owner-goal");
    expect(all).toContain("different-goal");
    expect(text).not.toContain("title-done");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });
  it("escapes injected ANSI/OSC, line breaks and bidi while using host styles and width tools", () => {
    const s = fixture().summary;
    const colored = {
      bold: theme.bold,
      fg: (_color: string, text: string) => `\u001b[32m${text}\u001b[0m`,
    } as Theme;
    const lines = renderCompactBoard(
      { ...s, goals: [{ source: "preflight", text: "中🙂é\u001b]52;c;payload\u0007\n\u202e" }] },
      120,
      colored,
    );
    const text = lines.map(stripTerminalSequences).join("\n");
    expect(text).toContain("中🙂é\\u001b]52;c;payload\\u0007\\n\\u202e");
    expect(lines[0]).toContain("\u001b[32m");
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });
});

describe("createReadOnlyBoard navigation", () => {
  it("orders phases first, then existing status priority, preserving ties", () => {
    const h = harness(
      withTasks([
        task("p2doing", "implementing", 2),
        task("p1done", "done"),
        task("p1draft", "draft"),
        task("p1ready", "ready"),
        task("p1review", "reviewing"),
        task("p1doing", "implementing"),
        task("p1abandoned", "abandoned"),
      ]),
    );
    h.render(80);
    select(h, "▸ P1");
    const text = h.render(80);
    const order = ["p1review", "p1doing", "p1ready", "p1draft", "p1done", "p1abandoned", "p2doing"];
    expect(order.map((id) => text.indexOf(` · ${id} `))).toEqual(
      order.map((id) => text.indexOf(` · ${id} `)).sort((a, b) => a - b),
    );
    expect(text).toContain("总览");
    expect(text).toContain("确认与回应");
    expect(text).toContain("最终验收");
  });
  it("applies independent fixed ended/unfinished and phase filters without hiding fixed entries", () => {
    const h = harness(
      withTasks([task("p1ready"), task("p2done", "done", 2), task("p2abandoned", "abandoned", 2)]),
    );
    h.render();
    h.key("f");
    select(h, "已结束");
    expect(h.render()).not.toContain("title-p1ready");
    expect(h.render()).toContain("title-p2done");
    expect(h.render()).toContain("已放弃");
    h.key("f");
    select(h, "阶段 P1");
    const empty = h.render();
    expect(empty).toContain("已结束 / P1");
    expect(empty).toContain("没有匹配任务（不代表目标完成）");
    for (const entry of ["总览", "确认与回应", "最终验收"]) expect(empty).toContain(entry);
    select(h, "确认与回应");
    expect(readAll(h)).toContain("saved-value");
    h.key(esc);
    h.render();
    h.key("f");
    select(h, "未结束");
    expect(h.render()).toContain("title-p1ready");
    expect(h.render()).not.toContain("title-p2done");
    h.key("f");
    select(h, "全部阶段");
    h.render();
    h.key("f");
    select(h, "全部任务");
    expect(h.render()).toContain("title-p2done");
  });
  it("returns long detail to the same filter and cursor; f is only active in the main list", () => {
    const view = withTasks([
      task("a"),
      { ...task("b"), prompt: Array.from({ length: 80 }, (_, i) => `line-${i}`).join("\n") },
      task("c", "done"),
    ]);
    const h = harness(view);
    h.render();
    h.key("f");
    select(h, "未结束");
    select(h, "title-b");
    expect(h.render()).toContain("任务详情");
    h.key("f");
    expect(h.render()).toContain("任务详情");
    expect(readAll(h)).toContain("line-79");
    h.key(esc);
    expect(h.render()).toContain("未结束 / 全部阶段");
    expect(
      h
        .render(80)
        .split("\n")
        .find((line) => line.startsWith("→ ")),
    ).toContain("待开始（已就绪） · b");
    h.key("f");
    h.render();
    h.key("f");
    expect(h.render()).toContain("选择固定筛选");
    h.key(esc);
    expect(
      h
        .render(80)
        .split("\n")
        .find((line) => line.startsWith("→ ")),
    ).toContain("待开始（已就绪） · b");
    expect(h.done).not.toHaveBeenCalled();
    h.key(esc);
    expect(h.done).toHaveBeenCalledTimes(1);
  });
  it("implements list PgUp/PgDn and scrolls detail with custom injected bindings, line/page and Home/End", () => {
    const h = harness(
      withTasks(
        Array.from({ length: 40 }, (_, i) => ({
          ...task(`t${i}`),
          prompt: Array.from({ length: 100 }, (_, n) => `material-${n}`).join("\n"),
        })),
      ),
    );
    h.render();
    h.key("\u001b[6~");
    expect(h.render()).not.toContain("→ 总览");
    h.key("\u001b[5~");
    expect(h.render()).toContain("→ 总览");
    h.env.keybindings.setUserBindings({
      "tui.select.down": "j",
      "tui.select.up": "k",
      "tui.select.confirm": "o",
      "tui.select.pageDown": "n",
      "tui.select.pageUp": "p",
    });
    h.key("j");
    h.key("j");
    h.key("j");
    h.key("o");
    h.key("j");
    h.key("o");
    const initial = h.render();
    h.key("j");
    expect(h.render()).not.toEqual(initial);
    h.key("k");
    expect(h.render()).toEqual(initial);
    h.key("n");
    expect(h.render()).not.toEqual(initial);
    h.key("p");
    expect(h.render()).toEqual(initial);
    h.key("\u001b[F");
    expect(h.render()).toContain("material-99");
    h.key("\u001b[H");
    expect(h.render()).toEqual(initial);
  });
  it("advertises reliable detail arrows without promising host-reserved page keys", () => {
    const v = fixture();
    const h = harness({
      ...v,
      documents: v.documents.map((document) => ({
        ...document,
        text: Array.from({ length: 40 }, (_, i) => `detail-${i}`).join("\n"),
      })),
    });
    h.render();
    h.key(down);
    h.key("\r");
    const first = h.render();
    expect(first).toContain("↑↓ 滚动");
    expect(first).not.toContain("PgUp PgDn");
    const top = Number(first.match(/(\d+)\/\d+ 行/)?.[1]);
    h.key(down);
    const next = h.render();
    expect(Number(next.match(/(\d+)\/\d+ 行/)?.[1])).toBe(top + 1);
    expect(h.done).not.toHaveBeenCalled();
  });
  it("exposes absent, unknown with reason and missing document explanations", () => {
    const v = fixture();
    const h = harness({
      ...v,
      documents: [
        {
          id: "latest-board-response",
          title: "最近回应",
          availability: "unknown",
          reason: "scope conflict",
          text: "cached material not proof",
        },
        { id: "preflight", title: "方案", availability: "absent", text: "未记录方案" },
      ],
    });
    h.render();
    select(h, "确认与回应");
    const all = readAll(h);
    for (const text of [
      "当前请求",
      "未知：未提供材料",
      "scope conflict",
      "cached material not proof",
      "无此记录",
      "未记录方案",
      "待权限确认",
    ])
      expect(all).toContain(text);
  });
});

describe("createReadOnlyBoard full immutable details", () => {
  it("keeps zero-task overview and acceptance reachable with explicit unknowns rather than success", () => {
    const v = fixture();
    const h = harness({
      ...v,
      documents: [],
      summary: {
        ...v.summary,
        goals: [],
        blockers: [],
        scope: { ...v.summary.scope, leafId: null },
      },
    });
    h.render();
    select(h, "总览");
    const overview = readAll(h);
    expect(overview).toContain("目标：未提供/未知");
    expect(overview).toContain("leafId：未提供");
    expect(overview).toContain("未记录阻塞（不是执行许可）");
    h.key(esc);
    h.render();
    select(h, "最终验收");
    const acceptance = readAll(h);
    expect(acceptance).toContain("最终验收任务 ID：未提供/未知");
    expect(acceptance).toContain("最终验收任务：未提供/未知");
    expect(acceptance).toContain("owner 验收未提供/未知");
  });
  it("visibly retains astral control code points rather than dropping their low surrogate", () => {
    const h = harness(
      withTasks([{ ...task("astral"), prompt: "before\u{e0001}after\u0000\u007f\u0085" }]),
    );
    h.render();
    select(h, "title-astral");
    expect(readAll(h)).toContain("before\\u{e0001}after\\u0000\\u007f\\u0085");
  });
  it("shows every task field, dependency state, evidence ref, exitCode zero and digest without truncating long material", () => {
    const detailed = {
      ...task("full", "done", 2),
      dependencies: ["dependency", "missing"],
      executionRef: { source: "workflow" as const, runId: "run-ref" },
      prompt: Array.from({ length: 240 }, (_, i) => `prompt-line-${i}`).join("\n"),
      completionEvidence: {
        summary: "full evidence summary",
        refs: [
          {
            kind: "command" as const,
            label: "test cmd",
            status: "passed" as const,
            ref: "artifact-ref",
            exitCode: 0,
            digest: "sha256:abcdef",
          },
        ],
        residualRisks: ["risk-one", "risk-two"],
      },
    };
    const h = harness(withTasks([detailed, task("dependency", "abandoned")]));
    h.render();
    select(h, "title-full");
    const all = readAll(h);
    for (const text of [
      "ID：full",
      "P2",
      "Implementation",
      "implementation",
      "不是具名负责人",
      "2026-10-01",
      "2026-10-02",
      "不是心跳",
      "dependency · 已放弃",
      "missing · 缺失/未知",
      "workflow:run-ref",
      "存活未知",
      "full evidence summary",
      "artifact-ref",
      "exitCode：0",
      "digest：sha256:abcdef",
      "risk-one",
      "risk-two",
    ])
      expect(all).toContain(text);
    for (let i = 0; i < 240; i++) expect(all).toContain(`prompt-line-${i}`);
  });
  it.each([undefined, [], ["known-risk"]])(
    "distinguishes unrecorded risks from an explicit empty risk list: %j",
    (risks) => {
      const t = {
        ...task("evidence"),
        completionEvidence: {
          summary: "e",
          refs: [],
          ...(risks === undefined ? {} : { residualRisks: risks }),
        },
      };
      const h = harness(withTasks([t]));
      h.render();
      select(h, "title-evidence");
      const all = readAll(h);
      expect(all).toContain(
        risks === undefined
          ? "残余风险：未记录（不是无风险）"
          : risks.length
            ? "残余风险：known-risk"
            : "残余风险：已明确记录无（owner 记录）",
      );
      expect(all).toContain("证据 refs：无已记录引用");
    },
  );
  it("does not infer final goal acceptance from done tasks and shows complete final task evidence", () => {
    const v = withTasks([
      {
        ...task("final", "done"),
        completionEvidence: {
          summary: "final-owner-evidence",
          refs: [{ kind: "review", label: "review", status: "fixed" }],
        },
      },
    ]);
    const h = harness({
      ...v,
      board: { ...v.board, finalAcceptanceTaskId: "final" },
      documents: [
        {
          id: "acceptance",
          title: "owner 验收记录",
          availability: "unknown",
          text: "目标尚未提供 owner 结论",
          reason: "readback unavailable",
        },
      ],
    });
    h.render();
    select(h, "最终验收");
    const all = readAll(h);
    for (const text of [
      "owner 验收未提供/未知",
      "任务完成 ≠ 最终验收任务完成 ≠ 目标已验收",
      "ID：final",
      "任务已完成",
      "final-owner-evidence",
      "readback unavailable",
      "exitCode：未记录",
      "digest：未记录",
    ])
      expect(all).toContain(text);
  });
  it("keeps significant whitespace and visibly escapes C0/C1/OSC/APC/bidi, including very long Unicode lines", () => {
    const prompt =
      "  lead  two\t tab\r\n\ntrailing  \n\u001b[31mRED\u001b]52;c;secret\u0007\u009b2J\u001b_apc\u001b\\\u202e\u2028\n" +
      "中🙂é".repeat(70) +
      "END-MATERIAL";
    const h = harness(withTasks([{ ...task("unsafe"), prompt }]));
    h.render();
    select(h, "title-unsafe");
    const all = readAll(h, 80);
    for (const expected of [
      "␠␠lead␠␠two\\t tab\\r",
      "trailing␠␠",
      "\\u001b[31mRED",
      "\\u001b]52;c;secret\\u0007",
      "\\u009b2J",
      "\\u001b_apc",
      "\\u202e\\u2028",
      "END-MATERIAL",
    ])
      expect(all).toContain(expected);
    h.key("\u001b[H");
    for (let i = 0; i < 20; i++) {
      const lines = h.board.render(40);
      expect(lines.length).toBeLessThanOrEqual(24);
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      expect(lines.at(-1)).toContain("Esc 回列表");
      expect(lines.join("")).not.toContain("\u001b]52");
      h.key("\u001b[6~");
    }
  });
  it("overview exposes all blocker sources, owner next and exact frozen capture identity", () => {
    const v = fixture();
    const blockers = (
      ["journal", "receipt", "preflight", "repair", "board", "host", "supervisor"] as const
    ).map((source) => ({ source, level: "warning" as const, text: `${source}-all-details` }));
    const h = harness({
      ...v,
      summary: { ...v.summary, blockers },
      documents: [
        {
          id: "overview",
          title: "owner 外部报告",
          availability: "available",
          text: "observedAt:100 deadlineAt:200 phase:waiting reference:exact-ref 仅最近 owner 报告",
        },
      ],
    });
    h.render();
    h.key("\r");
    const all = readAll(h);
    for (const line of blockers) expect(all).toContain(line.text);
    for (const text of [
      "sessionId：session",
      "leafId：leaf",
      "generation：4",
      "capturedAt：1234",
      "查看当前方案",
      "exact-ref",
      "仅最近 owner 报告",
    ])
      expect(all).toContain(text);
  });
  it("navigation is value-only, does not read wall clock or mutate frozen input, and dispose is idempotent", () => {
    const view = freeze(withTasks([task("frozen")]));
    const before = JSON.stringify(view);
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("wall clock forbidden");
    });
    try {
      const h = harness(view);
      h.render();
      select(h, "title-frozen");
      h.render();
      h.key("\u001b[6~");
      h.render();
      h.key(esc);
      h.render();
      h.key("f");
      h.render();
      h.key(esc);
      h.render();
      renderCompactBoard(view.summary, 80, theme);
      h.board.invalidate();
      h.render();
      h.board.dispose();
      h.board.dispose();
      h.key(esc);
      expect(h.board.render(80)).toEqual([]);
      expect(h.done).not.toHaveBeenCalled();
      expect(JSON.stringify(view)).toBe(before);
      expect(h.env.requestRender).toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });
});

describe("createReadOnlyBoard viewport and lifecycle", () => {
  it("fits body <=18, keeps cancel reachable across short windows and handles height/width resize", () => {
    const view = withTasks(Array.from({ length: 30 }, (_, i) => task(`t${i}`)));
    for (const rows of [0, 1, 3, 7, 8, 9, 12, 24, 40]) {
      for (const width of [0, 1, 23, 24, 40, 80, 120]) {
        const h = harness(view, rows);
        const lines = h.board.render(width);
        expect(lines.length).toBeLessThanOrEqual(rows);
        expect(lines.length).toBeLessThanOrEqual(24);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
        if (rows < 8 || width < 24) {
          h.key("\r");
          h.key("f");
          expect(h.board.render(width)).toEqual(lines);
        }
        h.key(esc);
        expect(h.done).toHaveBeenCalledTimes(1);
      }
    }
    for (const rows of [8, 9])
      expect(harness(fixture(), rows).board.render(80).length).toBeLessThanOrEqual(rows);
  });
  it("reflows full details on width change/invalidate, refreshes native styles, and cancels from tiny detail", () => {
    const v = withTasks([{ ...task("resize"), prompt: "long-content-".repeat(100) + "LAST" }]);
    const h = harness(v);
    h.render();
    select(h, "title-resize");
    const initial = h.render(80);
    h.key("\u001b[6~");
    h.render(80);
    expect(h.board.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
    h.board.invalidate();
    h.render(120);
    h.key("\u001b[F");
    expect(h.render(120)).toContain("LAST");
    h.key("\u001b[H");
    expect(h.render(80)).toEqual(initial);
    h.setRows(10);
    expect(h.board.render(80).length).toBeLessThanOrEqual(10);
    h.setRows(7);
    expect(h.render(80)).toContain("Esc 返回 · 窗口过小");
    h.key(esc);
    expect(h.done).toHaveBeenCalledTimes(1);
  });
  it("uses live theme functions rather than retaining styled text across invalidation", () => {
    const h = harness();
    const color = vi
      .spyOn(theme, "fg")
      .mockImplementation((_token, text) => `\u001b[32m${text}\u001b[0m`);
    try {
      expect(h.board.render(80).join("\n")).toContain("\u001b[32m");
      color.mockImplementation((_token, text) => `\u001b[34m${text}\u001b[0m`);
      h.board.invalidate();
      expect(h.board.render(80).join("\n")).toContain("\u001b[34m");
      expect(h.board.render(80).join("\n")).not.toContain("\u001b[32m");
      expect(h.board.handleMouse).toBeUndefined();
    } finally {
      color.mockRestore();
    }
  });
});

interface IsolatedDetail {
  material: string;
  widthSafe: boolean;
  closed: boolean;
  wideMaterial: string;
}

/** A stuck native render must not block Vitest or grow without a heap limit. */
function isolatedDetail(prompt: string, resize: boolean): Promise<IsolatedDetail> {
  const view = withTasks([
    {
      ...task("bounded"),
      prompt,
      completionEvidence: { summary: "readable中🙂é-material-tail", refs: [] },
    },
  ]);
  const code = `
    const { parentPort, workerData } = await import("node:worker_threads");
    const { createJiti } = await import(workerData.loader);
    const { createReadOnlyBoard } = await createJiti(workerData.module, { moduleCache: false }).import(workerData.module);
    const { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, stripTerminalSequences } =
      await import("@earendil-works/pi-tui");
    let closed = false;
    const board = createReadOnlyBoard(workerData.view, {
      theme: { fg: (_color, text) => text },
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
      rows: () => 24, requestRender: () => {},
    }, () => { closed = true; });
    board.render(80);
    for (let i = 0; i < 110; i++) {
      const selected = board.render(80).map(stripTerminalSequences).find(line => line.startsWith("→ ")) || "";
      if (selected.includes("title-bounded")) { board.handleInput("\\r"); break; }
      if (selected.startsWith("→ ▸")) board.handleInput("\\r");
      board.handleInput("\\u001b[B");
      if (i === 109) throw new Error("Bounded task is not reachable");
    }
    let wideMaterial = "";
    if (workerData.resize) {
      wideMaterial += board.render(80).map(stripTerminalSequences).join("");
      board.handleInput("\\u001b[6~");
      wideMaterial += board.render(80).map(stripTerminalSequences).join("");
      board.render(24);
      board.handleInput("\\u001b[H");
    }
    let widthSafe = true;
    let previous;
    const material = [];
    for (let i = 0; i < 300; i++) {
      const lines = board.render(24).map(stripTerminalSequences);
      widthSafe &&= lines.length <= 24 && lines.every(line => visibleWidth(line) <= 24);
      const body = lines.slice(5, -1).map(line => line.trimEnd());
      const position = body.join("\\n");
      if (position === previous) {
        board.handleInput("\\u001b");
        board.render(24);
        board.handleInput("\\u001b");
        parentPort.postMessage({ material: material.join(""), widthSafe, closed, wideMaterial });
        board.dispose();
        break;
      }
      material.push(...(i === 0 ? body : body.slice(-1)));
      previous = position;
      board.handleInput("\\u001b[B");
      if (i === 299) throw new Error("Detail failed to reach end");
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, {
      eval: true,
      execArgv: [...process.execArgv, "--experimental-transform-types"],
      workerData: {
        module: new URL("../board-view.ts", import.meta.url).href,
        loader: new URL(
          "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/jiti-loader.js",
          import.meta.url,
        ).href,
        view,
        resize,
      },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
    });
    let settled = false;
    let expectedTermination = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      expectedTermination = true;
      void worker.terminate().then(() => {
        reject(new Error("Isolated detail exceeded 3000ms"));
      }, reject);
    }, 3000);
    worker.once("message", (result: IsolatedDetail) => {
      if (settled) return;
      settled = true;
      expectedTermination = true;
      clearTimeout(timer);
      void worker.terminate().then(() => {
        resolve(result);
      }, reject);
    });
    worker.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (expectedTermination || settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Isolated detail exited ${code} without a result`));
    });
  });
}

describe("board-view bounded grapheme regressions", () => {
  it("completes a representative ordinary fixture through the isolated runner", async () => {
    const prompt = "中🙂é ordinary";
    const result = await isolatedDetail(prompt, false);
    expect(result.material).toContain(`prompt：${prompt}全部依赖：`);
    expect(result.material).toContain("readable中🙂é-material-tail");
    expect(result.widthSafe).toBe(true);
    expect(result.closed).toBe(true);
  });

  it.each([false, true])(
    "preserves every oversized-cluster code point and following material (resize=%s)",
    async (resize) => {
      const result = await isolatedDetail("a" + "\u093e".repeat(24), resize);
      expect(result.material).toContain(`prompt：\\u0061${"\\u093e".repeat(24)}全部依赖：`);
      expect(result.material.match(/\\u093e/g)).toHaveLength(24);
      if (resize) {
        expect(result.wideMaterial).toContain("a" + "\u093e".repeat(24));
        expect(result.wideMaterial).not.toContain("\\u093e");
      }
      expect(result.material).toContain("readable中🙂é-material-tail");
      expect(result.widthSafe).toBe(true);
      expect(result.closed).toBe(true);
    },
  );
});

describe("board-view oversized-cluster boundaries", () => {
  it.each(["a", "🙂"])("escapes only the oversized %s cluster, not its neighbors", async (base) => {
    const cluster = base + "\u093e".repeat(24);
    const result = await isolatedDetail(`中🙂é${cluster}Z中`, false);
    const escapedBase = base === "a" ? "\\u0061" : "\\u{1f642}";
    expect(result.material).toContain(
      `prompt：中🙂é${escapedBase}${"\\u093e".repeat(24)}Z中全部依赖：`,
    );
    expect(result.widthSafe).toBe(true);
    expect(result.closed).toBe(true);
  });

  it("keeps an exactly fitting spacing-mark cluster readable", async () => {
    const prompt = "a" + "\u093e".repeat(23);
    const result = await isolatedDetail(prompt, false);
    expect(result.material).toContain(`prompt：${prompt}全部依赖：`);
    expect(result.material).not.toContain("\\u093e");
    expect(result.widthSafe).toBe(true);
    expect(result.closed).toBe(true);
  });
});

describe("parent board acceptance", () => {
  it("prioritizes actual implementing/reviewing records in the compact current-work slot", () => {
    const view = withTasks([
      task("queued-first", "configured"),
      task("doing-priority", "implementing", 2),
    ]);
    const before = JSON.stringify(view);
    const compact = renderCompactBoard(view.summary, 120, theme).join("\n");
    expect(compact).toContain("doing-priority");
    expect(compact).not.toContain("queued-first");
    expect(JSON.stringify(view)).toBe(before);
  });

  it.each(["implementing", "reviewing"] as const)(
    "keeps the %s task-record label ahead of a long title at 40/80 columns",
    (status) => {
      const view = withTasks([{ ...task("t1", status), title: "x".repeat(100) }]);
      const summary = {
        ...view.summary,
        headline: { source: "supervisor" as const, level: "info" as const, text: "监督已启用" },
      };
      const before = JSON.stringify(view);
      for (const width of [40, 80]) {
        const lines = renderCompactBoard(summary, width, theme);
        expect(lines[6]).toContain(status === "implementing" ? "实施记录" : "核验记录");
        expect(lines[6]).toContain("t1");
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      expect(JSON.stringify(view)).toBe(before);
    },
  );

  it("does not let a long phase name hide the primary state", () => {
    const summary = {
      ...fixture().summary,
      phase: "超长阶段".repeat(50),
      headline: { source: "receipt" as const, level: "error" as const, text: "需检查" },
    };
    const lines = renderCompactBoard(summary, 40, theme);
    expect(lines[0]).toContain("需检查");
    expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
  });

  it("makes non-ASCII scope spaces explicit in the complete read-only detail", () => {
    const h = harness(withTasks([{ ...task("unicode-spaces"), prompt: "a\u00a0b\nend\u3000\n" }]));
    h.render();
    select(h, "title-unicode-spaces");
    const all = readAll(h, 80);
    expect(all).toContain("a\\u00a0b");
    expect(all).toContain("end\\u3000");
  });
});
