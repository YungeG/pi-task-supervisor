import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type SelectItem,
  SelectList,
  HStack,
  ScrollView,
  Text,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { UiBoardView, UiDocument, UiSummary, UiViewEnvironment } from "./ui-view";
import type { TaskRecord, TaskStatus } from "./types";

const ENTRY = "/task-supervisor tasks";
const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "待规划",
  configured: "已编排",
  ready: "待开始（已就绪）",
  implementing: "处理中（任务记录）",
  reviewing: "核验中",
  done: "任务已完成",
  abandoned: "已放弃",
};
const STATUS_ORDER: Record<TaskStatus, number> = {
  implementing: 0,
  reviewing: 0,
  ready: 1,
  configured: 2,
  draft: 3,
  done: 4,
  abandoned: 5,
};
const FILTER_LABEL = { all: "全部任务", unfinished: "未结束", ended: "已结束" };
type TaskFilter = keyof typeof FILTER_LABEL;
const FIXED_ITEMS: SelectItem[] = [
  { value: "overview", label: "总览" },
  { value: "confirmation", label: "确认与回应" },
  { value: "acceptance", label: "最终验收" },
];

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function escapeCodePoint(char: string): string {
  const code = char.codePointAt(0) ?? 0;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/** Escape controls rather than erasing potentially significant evidence or terminal instructions. */
function safeText(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu, (char) => {
    if (char === " " || char === "\n" || char === "\u200c" || char === "\u200d") return char;
    if (char === "\t") return "\\t";
    if (char === "\r") return "\\r";
    return escapeCodePoint(char);
  });
}
function singleLine(value: string): string {
  return safeText(value).replace(/\n/g, "\\n");
}
function counts(summary: UiSummary): string {
  const c = summary.counts;
  return `已完成 ${c.done}/${c.total} · 未结束 ${c.unfinished} · 放弃 ${c.abandoned}`;
}
function goals(summary: UiSummary): string {
  return summary.goals.length
    ? summary.goals.map((goal) => `[${goal.source}] ${goal.text}`).join("；")
    : "未提供/未知";
}

function progressLine(summary: UiSummary): string {
  const { done, total } = summary.counts;
  const filled = total > 0 ? Math.floor((12 * done) / total) : 0;
  const cells = Math.max(0, Math.min(12, filled));
  return `${counts(summary)}  ${"█".repeat(cells)}${"░".repeat(12 - cells)}`;
}

/** State, blocker and next action precede secondary task records; never infer a grant. */
export function renderCompactBoard(summary: UiSummary, width: number, theme: Theme): string[] {
  if (!summary.visible) return [];
  const w = dimension(width);
  const task = [...summary.tasks]
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.phase - b.phase)
    .find((item) => item.status !== "done" && item.status !== "abandoned");
  const attention = summary.blockers[0]?.text ?? summary.headline.text;
  const other = Math.max(0, summary.blockers.length - 1);
  const lines = [
    `状态：${summary.headline.text}`,
    `注意：${other ? `其他 ${other} 项 · ` : ""}${attention}`,
    `下一步：${summary.next.text}`,
    `─ ${progressLine(summary)}`,
    `目标：${goals(summary)} · 阶段：${summary.phase ?? "未提供/未知"}`,
    ...(task ? [`${STATUS_LABEL[task.status]} · ${task.id} ${task.title}`] : []),
    `${ENTRY}${summary.counts.unfinished > 1 ? ` · 另 ${summary.counts.unfinished - 1} 项未结束` : ""}`,
    `最终验收：${summary.acceptance}`,
  ];
  return lines.map((line, index) =>
    truncateToWidth(
      theme.fg(index === 1 ? "warning" : index === 2 ? "accent" : "muted", singleLine(line)),
      w,
      "…",
    ),
  );
}

function documentText(view: UiBoardView, id: UiDocument["id"], title: string): string {
  const doc = view.documents.find((item) => item.id === id);
  if (!doc) return `${title}\n未知：未提供材料`;
  const availability = { available: "可查看", unknown: "未知", absent: "无此记录" };
  return [title, doc.title, `材料：${availability[doc.availability]}`, doc.reason, doc.text]
    .filter((line) => line !== undefined)
    .join("\n");
}
function overviewText(view: UiBoardView): string {
  const s = view.summary;
  return [
    `目标：${goals(s)}`,
    `阶段：${s.phase ?? "未提供/未知"}`,
    `状态：[${s.headline.source}] ${s.headline.text}`,
    counts(s),
    `下一步：[${s.next.source}] ${s.next.text}`,
    "全部注意事项：",
    ...s.blockers.map((line) => `[${line.source}/${line.level}] ${line.text}`),
    ...(s.blockers.length ? [] : ["未记录阻塞（不是执行许可）"]),
    `sessionId：${s.scope.sessionId}`,
    `leafId：${s.scope.leafId ?? "未提供"}`,
    `generation：${s.scope.generation}`,
    `capturedAt：${s.scope.capturedAt}`,
    documentText(view, "overview", "总览材料"),
  ].join("\n");
}
function confirmationText(view: UiBoardView): string {
  return [
    "原请求/历史回应，不代表当前授权",
    "只读材料；此处不批准、不启动、不恢复。退出后由用户显式发起既有命令。",
    documentText(view, "current-board-request", "当前请求"),
    documentText(view, "latest-board-response", "最近已保存回应"),
    documentText(view, "preflight", "当前权限方案与原回应"),
    "当前门槛与注意事项：",
    ...view.summary.blockers.map((line) => `[${line.source}/${line.level}] ${line.text}`),
  ].join("\n\n");
}
function evidenceText(task: TaskRecord): string[] {
  const evidence = task.completionEvidence;
  if (!evidence) return ["完成证据：未记录", "残余风险：未记录（不是无风险）"];
  return [
    `证据 summary：${evidence.summary}`,
    ...(evidence.refs.length ? [] : ["证据 refs：无已记录引用"]),
    ...evidence.refs.map((ref) =>
      [
        `引用：${ref.kind} · ${ref.status} · ${ref.label}`,
        `ref：${ref.ref ?? "未记录"}`,
        `exitCode：${ref.exitCode ?? "未记录"}`,
        `digest：${ref.digest ?? "未记录"}`,
      ].join("\n"),
    ),
    ...(evidence.residualRisks === undefined
      ? ["残余风险：未记录（不是无风险）"]
      : evidence.residualRisks.length
        ? evidence.residualRisks.map((risk) => `残余风险：${risk}`)
        : ["残余风险：已明确记录无（owner 记录）"]),
  ];
}
function taskText(view: UiBoardView, task: TaskRecord): string {
  const phase = view.board.phases.find((item) => item.phase === task.phase);
  return [
    `ID：${task.id}`,
    `标题：${task.title}`,
    `状态：${STATUS_LABEL[task.status]} [${task.status}]`,
    `阶段：P${task.phase} · ${phase?.title ?? "未命名"} · ${phase?.status ?? "未提供/未知"}`,
    `profile：${task.profile}（执行配置，不是具名负责人）`,
    `创建时间：${task.createdAt}`,
    `更新时间：${task.updatedAt}（不是心跳）`,
    "prompt：",
    task.prompt,
    "全部依赖：",
    ...(task.dependencies.length
      ? task.dependencies.map((id) => {
          const dependency = view.board.tasks.find((item) => item.id === id);
          return `${id} · ${dependency ? STATUS_LABEL[dependency.status] : "缺失/未知"}`;
        })
      : ["无依赖"]),
    task.executionRef
      ? `执行引用：${task.executionRef.source}:${task.executionRef.runId}（仅引用，存活未知）`
      : "执行引用：未记录（存活未知）",
    ...evidenceText(task),
  ].join("\n");
}
function acceptanceText(view: UiBoardView): string {
  const id = view.board.finalAcceptanceTaskId;
  const task = view.board.tasks.find((item) => item.id === id);
  return [
    `监督 owner 目标验收：${view.summary.acceptance}`,
    "任务完成 ≠ 最终验收任务完成 ≠ 目标已验收；打开看板不重新验收。",
    `最终验收任务 ID：${id ?? "未提供/未知"}`,
    task ? taskText(view, task) : "最终验收任务：未提供/未知",
    documentText(view, "acceptance", "最终验收材料"),
  ].join("\n\n");
}

const detailSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Text trims boundary spaces. Escape only oversized clusters; consume every token once. */
function fullLines(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of safeText(text).split("\n")) {
    const explicit = raw.replace(/^ +| {2,}| +$/g, (spaces) => "␠".repeat(spaces.length));
    let line = "";
    let cells = 0;
    for (const { segment } of detailSegmenter.segment(explicit)) {
      const tokens =
        visibleWidth(segment) > width ? Array.from(segment, escapeCodePoint).join("") : [segment];
      for (const token of tokens) {
        const tokenWidth = visibleWidth(token);
        if (cells + tokenWidth > width) {
          lines.push(line);
          line = "";
          cells = 0;
        }
        line += token;
        cells += tokenWidth;
      }
    }
    lines.push(line);
  }
  return lines;
}

class ReadOnlyBoard implements Component {
  private mode: "list" | "filters" | "detail" = "list";
  private taskFilter: TaskFilter = "all";
  private phase: number | undefined;
  private selected = "overview";
  private filterIndex = 0;
  private detailTitle = "";
  private detail = "";
  private detailWidth = 0;
  private detailLines: string[] = [];
  private scroll = new ScrollView(new Text("", 0, 0), { scrollbar: "hidden" });
  private closed = false;
  private small = true;
  private bodyRows = 1;
  private collapsed = new Set<number>();
  private previewKey = "";
  private previewLines: string[] = [];

  constructor(
    private view: UiBoardView,
    private env: UiViewEnvironment,
    private done: () => void,
  ) {
    const current =
      view.board.phases.find((phase) => phase.status === "active")?.phase ??
      this.tasks().find((task) => task.status !== "done" && task.status !== "abandoned")?.phase ??
      this.phaseIds()[0];
    this.collapsed = new Set(this.phaseIds().filter((phase) => phase !== current));
  }

  private phaseIds(): number[] {
    return [
      ...new Set([
        ...this.view.board.phases.map((p) => p.phase),
        ...this.view.board.tasks.map((t) => t.phase),
      ]),
    ].sort((a, b) => a - b);
  }

  private tasks(): TaskRecord[] {
    return this.view.board.tasks
      .filter((task) => {
        if (this.phase !== undefined && task.phase !== this.phase) return false;
        const ended = task.status === "done" || task.status === "abandoned";
        return this.taskFilter === "all" || (this.taskFilter === "ended" ? ended : !ended);
      })
      .sort((a, b) => a.phase - b.phase || STATUS_ORDER[a.status] - STATUS_ORDER[b.status]);
  }
  private phaseItems(phase: number, tasks: readonly TaskRecord[]): SelectItem[] {
    const title =
      this.view.board.phases.find((item) => item.phase === phase)?.title ?? "未命名阶段";
    const done = tasks.filter((task) => task.status === "done").length;
    const collapsed = this.collapsed.has(phase);
    const header = {
      value: `phase:${phase}`,
      label: singleLine(
        `${collapsed ? "▸" : "▾"} P${phase} · ${title} · 已完成 ${done}/${tasks.length}`,
      ),
    };
    return [
      header,
      ...(collapsed
        ? []
        : tasks.map((task, index) => ({
            value: `task:${task.id}`,
            label: singleLine(
              `  ${index === tasks.length - 1 ? "└─" : "├─"} ${STATUS_LABEL[task.status]} · ${task.id} ${task.title}`,
            ),
          }))),
    ];
  }

  private items(): SelectItem[] {
    const tasks = this.tasks();
    return [
      ...FIXED_ITEMS,
      ...this.phaseIds().flatMap((phase) => {
        const matching = tasks.filter((task) => task.phase === phase);
        return matching.length ? this.phaseItems(phase, matching) : [];
      }),
    ];
  }
  private filters(): SelectItem[] {
    const phases = [
      ...new Set([
        ...this.view.board.phases.map((p) => p.phase),
        ...this.view.board.tasks.map((t) => t.phase),
      ]),
    ].sort((a, b) => a - b);
    return [
      ...Object.entries(FILTER_LABEL).map(([value, label]) => ({
        value,
        label: `${this.taskFilter === value ? "✓ " : ""}${label}`,
      })),
      { value: "phase:all", label: `${this.phase === undefined ? "✓ " : ""}全部阶段` },
      ...phases.map((phase) => ({
        value: `phase:${phase}`,
        label: `${this.phase === phase ? "✓ " : ""}阶段 P${phase}`,
      })),
    ];
  }
  private list(items: SelectItem[], index: number, rows: number): SelectList {
    const { theme } = this.env;
    const list = new SelectList(items, Math.max(1, rows - 1), {
      selectedPrefix: (s) => theme.fg("accent", s),
      selectedText: (s) => theme.fg("accent", s),
      description: (s) => theme.fg("muted", s),
      scrollInfo: (s) => theme.fg("dim", s),
      noMatch: (s) => theme.fg("muted", s),
    });
    list.setSelectedIndex(index);
    return list;
  }
  private filterLabel(): string {
    return `筛选：${FILTER_LABEL[this.taskFilter]} / ${this.phase === undefined ? "全部阶段" : `P${this.phase}`}`;
  }
  private renderList(width: number, rows: number): string[] {
    const items = this.mode === "filters" ? this.filters() : this.items();
    const index =
      this.mode === "filters"
        ? this.filterIndex
        : Math.max(
            0,
            items.findIndex((item) => item.value === this.selected),
          );
    const empty = this.mode === "list" && !this.tasks().length;
    const available = rows - (empty ? 1 : 0);
    const lines = this.list(items, index, available).render(width).slice(0, available);
    if (empty)
      lines.push(
        this.view.board.tasks.length
          ? "没有匹配任务（不代表目标完成）"
          : "暂无任务；确认与回应、总览和验收仍可查看",
      );
    return lines;
  }

  private previewOverview(): string {
    const summary = this.view.summary;
    const document = this.view.documents.find((item) => item.id === "overview");
    return [
      `下一步：${summary.next.text}`,
      ...summary.blockers.map((line) => `注意：${line.text}`),
      `目标：${goals(summary)}`,
      `最终验收：${summary.acceptance}`,
      document?.reason ?? "完整诊断与捕获标识请进入总览",
    ].join("\n");
  }

  private previewTask(): string {
    const task = this.view.board.tasks.find((item) => `task:${item.id}` === this.selected);
    if (!task) return "未知：未提供材料";
    return [
      task.title,
      `状态：${STATUS_LABEL[task.status]}（不是执行器心跳）`,
      "任务说明（预览，不是完整核对）：",
      task.prompt,
      `依赖：${task.dependencies.join("、") || "无依赖"}`,
      `完成证据：${task.completionEvidence?.summary ?? "未记录"}`,
      "完整证据、风险与元数据请进入任务详情",
    ].join("\n");
  }

  private previewRecords(): string {
    if (this.selected === "acceptance")
      return [
        `监督 owner 目标验收：${this.view.summary.acceptance}`,
        "任务完成不等于目标验收",
        `最终验收任务：${this.view.board.finalAcceptanceTaskId ?? "未提供/未知"}`,
        "完整任务证据与 owner 材料请进入最终验收",
      ].join("\n");
    const availability = { available: "可查看", unknown: "未知", absent: "无此记录" };
    return [
      "原请求/历史回应，不代表当前授权",
      ...this.view.documents
        .filter((doc) =>
          ["current-board-request", "latest-board-response", "preflight"].includes(doc.id),
        )
        .map(
          (doc) =>
            `${doc.title}：${availability[doc.availability]}${doc.reason ? ` · ${doc.reason}` : ""}`,
        ),
      "这里没有批准、恢复或启动入口",
      "原始全文与已保存原值请进入确认与回应",
    ].join("\n");
  }

  private previewText(): string {
    if (this.selected === "overview") return this.previewOverview();
    if (this.selected.startsWith("phase:")) {
      const phase = Number(this.selected.slice(6));
      return [
        "阶段完整任务记录（不受当前筛选影响）",
        ...this.view.board.tasks
          .filter((task) => task.phase === phase)
          .map((task) => `${task.id} · ${STATUS_LABEL[task.status]} · ${task.title}`),
      ].join("\n");
    }
    if (this.selected.startsWith("task:")) return this.previewTask();
    return this.previewRecords();
  }

  private renderPreview(width: number): string[] {
    const key = `${this.selected}\u0000${width}`;
    if (key !== this.previewKey) {
      this.previewLines = fullLines(this.previewText(), width);
      this.previewKey = key;
    }
    const hint = this.selected.startsWith("phase:")
      ? "预览 · Enter 展开/折叠"
      : "只读预览 · Enter 查看全文";
    return [
      this.env.theme.fg("accent", truncateToWidth(hint, width, "…")),
      ...this.previewLines.slice(0, this.bodyRows - 1),
    ];
  }

  private renderBody(width: number): string[] {
    if (this.mode === "detail") return this.renderDetail(width);
    if (this.mode !== "list" || width < 100 || this.bodyRows < 4)
      return this.renderList(width, this.bodyRows);
    const leftWidth = Math.min(54, Math.floor(width * 0.44));
    const rightWidth = width - leftWidth - 3;
    return new HStack(
      [
        {
          component: new Text(this.renderList(leftWidth, this.bodyRows).join("\n"), 0, 0),
          basis: leftWidth,
          grow: 0,
          shrink: 0,
        },
        {
          component: new Text(
            Array(this.bodyRows).fill(this.env.theme.fg("muted", "│")).join("\n"),
            0,
            0,
          ),
          basis: 1,
          grow: 0,
          shrink: 0,
        },
        {
          component: new Text(this.renderPreview(rightWidth).join("\n"), 0, 0),
          grow: 1,
          minSize: 1,
        },
      ],
      { gap: 1 },
    )
      .render(width)
      .slice(0, this.bodyRows);
  }

  render(width: number): string[] {
    if (this.closed) return [];
    const w = dimension(width);
    const rows = dimension(this.env.rows());
    this.small = w < 24 || rows < 8;
    if (this.small) return rows ? [truncateToWidth("Esc 返回 · 窗口过小", w, "")] : [];
    this.bodyRows = Math.min(18, rows - 6);
    const summary = this.view.summary;
    const header = [
      `${summary.headline.text} · 任务看板（只读快照）`,
      `下一步：${summary.next.text}`,
      progressLine(summary),
      "─".repeat(w),
      this.mode === "detail" ? this.detailTitle : this.filterLabel(),
    ];
    const body = this.renderBody(w);
    const hint =
      this.mode === "detail"
        ? `Esc 回列表 · ↑↓ 滚动 · ${this.scroll.scrollTop + 1}/${this.detailLines.length} 行`
        : this.mode === "filters"
          ? "Esc 回列表 · ↑↓ 选择固定筛选 · Enter 应用"
          : "Esc 返回编辑器 · ↑↓ 选择 · Enter 查看/折叠 · f 筛选";
    return [
      ...header.map((line) => this.env.theme.fg("text", singleLine(line))),
      ...body,
      this.env.theme.fg("muted", hint),
    ].map((line) => truncateToWidth(line, w, "…"));
  }
  private renderDetail(width: number): string[] {
    if (width !== this.detailWidth) {
      this.detailLines = fullLines(this.detail, width);
      this.detailWidth = width;
      // ScrollView.render is intentionally unbounded in main-screen mode; clip its public scroll state here.
      const text = new Text(this.detailLines.join("\n"), 0, 0);
      const top = this.scroll.scrollTop;
      this.scroll = new ScrollView(text, { scrollbar: "hidden" });
      this.scroll.updateLayout(this.detailLines.length, this.bodyRows, this.env.requestRender);
      this.scroll.scrollTo(top);
    }
    this.scroll.updateLayout(this.detailLines.length, this.bodyRows, this.env.requestRender);
    return this.scroll
      .render(width)
      .slice(this.scroll.scrollTop, this.scroll.scrollTop + this.bodyRows);
  }
  private detailsFor(value: string): { title: string; text: string } | undefined {
    const title = FIXED_ITEMS.find((item) => item.value === value)?.label ?? "任务详情";
    if (value === "overview") return { title, text: overviewText(this.view) };
    if (value === "confirmation") return { title, text: confirmationText(this.view) };
    if (value === "acceptance") return { title, text: acceptanceText(this.view) };
    const task = this.view.board.tasks.find((item) => `task:${item.id}` === value);
    return task ? { title, text: taskText(this.view, task) } : undefined;
  }

  private open(value: string): void {
    if (value.startsWith("phase:")) {
      const phase = Number(value.slice(6));
      if (this.collapsed.has(phase)) this.collapsed.delete(phase);
      else this.collapsed.add(phase);
      return;
    }
    const details = this.detailsFor(value);
    if (!details) return;
    this.detailTitle = details.title;
    this.detail =
      "空白显示：␠ 表示显著空格；\\t/\\r/\\uXXXX 表示原控制字符、非普通空白与超宽字素。\n" +
      details.text;
    this.detailWidth = 0;
    this.scroll.scrollToStart();
    this.mode = "detail";
  }
  private cancel(): void {
    if (this.mode !== "list" && !this.small) this.mode = "list";
    else {
      this.closed = true;
      this.done();
    }
  }
  private applyFilter(value: string): void {
    if (value === "all" || value === "unfinished" || value === "ended") this.taskFilter = value;
    else this.phase = value === "phase:all" ? undefined : Number(value.slice("phase:".length));
    if (this.phase !== undefined) this.collapsed.delete(this.phase);
    if (!this.items().some((item) => item.value === this.selected)) this.selected = "overview";
    this.mode = "list";
  }
  private scrollInput(data: string): void {
    const kb = this.env.keybindings;
    if (kb.matches(data, "tui.select.pageUp")) this.scroll.scrollBy(-this.bodyRows);
    else if (kb.matches(data, "tui.select.pageDown")) this.scroll.scrollBy(this.bodyRows);
    else if (kb.matches(data, "tui.select.up")) this.scroll.scrollBy(-1);
    else if (kb.matches(data, "tui.select.down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, Key.home)) this.scroll.scrollToStart();
    else if (matchesKey(data, Key.end)) this.scroll.scrollToEnd();
  }
  private listInput(data: string): void {
    const items = this.mode === "filters" ? this.filters() : this.items();
    let index =
      this.mode === "filters"
        ? this.filterIndex
        : Math.max(
            0,
            items.findIndex((item) => item.value === this.selected),
          );
    const kb = this.env.keybindings;
    if (kb.matches(data, "tui.select.confirm")) {
      const value = items[index]?.value;
      if (value !== undefined) {
        if (this.mode === "filters") this.applyFilter(value);
        else this.open(value);
      }
      return;
    }
    if (kb.matches(data, "tui.select.up")) index = (index + items.length - 1) % items.length;
    else if (kb.matches(data, "tui.select.down")) index = (index + 1) % items.length;
    else if (kb.matches(data, "tui.select.pageUp"))
      index = Math.max(0, index - Math.max(1, this.bodyRows - 1));
    else if (kb.matches(data, "tui.select.pageDown"))
      index = Math.min(items.length - 1, index + Math.max(1, this.bodyRows - 1));
    if (this.mode === "filters") this.filterIndex = index;
    else this.selected = items[index]?.value ?? "overview";
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || this.env.keybindings.matches(data, "tui.select.cancel"))
      this.cancel();
    else if (this.small) return;
    else if (this.mode === "detail") this.scrollInput(data);
    else if (this.mode === "list" && matchesKey(data, "f")) {
      this.mode = "filters";
      this.filterIndex = 0;
    } else this.listInput(data);
    this.env.requestRender();
  }
  invalidate(): void {
    this.detailWidth = 0;
    this.previewKey = "";
    this.scroll.invalidate();
  }
  dispose(): void {
    this.closed = true;
  }
}

/** Navigation only. The integration owner supplies snapshot capture and interaction cancellation. */
export function createReadOnlyBoard(
  view: UiBoardView,
  env: UiViewEnvironment,
  done: () => void,
): Component & { dispose(): void } {
  return new ReadOnlyBoard(view, env, done);
}
