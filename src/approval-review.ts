import { Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { NativeQuestion } from "./human-ui";
import type { UiViewEnvironment } from "./ui-environment";
import { materialLine } from "./human-material-view";

export interface ApprovalOption {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
}
export interface ApprovalSelection {
  readonly outcome: "approve" | "reject";
  readonly permissionIds: readonly string[];
}
const selections = new WeakMap<object, NativeQuestion>();
export function isApprovalSelection(
  value: unknown,
  question: NativeQuestion,
): value is ApprovalSelection {
  return (
    !!value &&
    typeof value === "object" &&
    Object.isFrozen(value) &&
    selections.get(value) === question
  );
}

/** One original native component completion. The result is still a local selection,
 * never a NativeAnswer or a persisted business/definition approval. */
export class ApprovalReview implements Component {
  private selected = new Set<string>();
  private focus = 0;
  private page = 0;
  private shown = new Set<number>();
  private geometry = "";
  private closed = false;
  private layout?: { lines: string[]; capacity: number; pages: number };
  private message = "浏览与选择都是草稿，不产生批准。";
  private readonly definition: boolean;
  private readonly scopeRevision: boolean;

  constructor(
    private readonly question: NativeQuestion,
    private readonly env: UiViewEnvironment,
    private readonly done: (value: ApprovalSelection | undefined) => void,
  ) {
    this.definition = question.purpose === "contract-definition";
    this.scopeRevision = question.purpose === "scope-revision";
    if (this.definition) this.message = "查看材料不会绑定，也不会新增权限或执行。";
    for (const id of question.approval?.selectedIds ?? []) this.selected.add(id);
  }
  invalidate(): void {
    this.layout = undefined;
    this.shown.clear();
    this.page = 0;
  }
  dispose(): void {
    this.closed = true;
    this.layout = undefined;
  }
  private options(): readonly ApprovalOption[] {
    return this.question.approval?.permissions ?? [];
  }
  private complete(outcome: "approve" | "reject"): void {
    const selection = Object.freeze({
      outcome,
      permissionIds: Object.freeze([...this.selected].sort()),
    });
    selections.set(selection, this.question);
    this.dispose();
    this.done(selection);
  }
  private reviewed(): boolean {
    return !!this.layout && this.shown.size === this.layout.pages;
  }
  private choices(width: number): string[] {
    if (this.scopeRevision)
      return [materialLine("仅提交所示范围修订；保留原 Goal/权限对象/Start/暂停/账本。", width)];
    if (this.definition)
      return [materialLine("只保存定义关联；原权限、Start 与暂停保持不变。", width)];
    const options = this.options();
    if (!options.length) return [materialLine("无额外权限；仅确认所示验收定义。", width)];
    const start = Math.min(Math.max(0, this.focus - 1), Math.max(0, options.length - 3));
    return options.slice(start, start + 3).map((option, index) => {
      const focused = start + index === this.focus;
      const value = `${focused ? "›" : " "} [${this.selected.has(option.id) ? "x" : " "}] ${option.required ? "必需" : "可选"} ${option.label}`;
      return this.env.theme.fg(focused ? "accent" : "text", materialLine(value, width));
    });
  }
  private labels() {
    if (this.scopeRevision)
      return {
        heading: "范围修订审核 · 同一 Goal · 仍暂停",
        choices: "本次操作的影响（不新增权限对象）",
        incomplete: "材料未完整核对，不会提交修订",
        suffix: "提交不是恢复或验收通过",
        actions: "Enter 批准本版修订 | r 拒绝本版 | Esc 稍后",
        help: "PgUp/PgDn 阅读 · 只提交所示修订，不另行 Start",
        unread: "请先用 PgDn 完整查看修订材料；本次没有提交。",
        ready: "材料已完整展示；Enter 才保存修订，仍不会执行。",
      };
    if (this.definition)
      return {
        heading: "契约定义审核 · 不新增权限或执行",
        choices: "本次操作的影响（不是权限审批）",
        incomplete: "材料未完整核对，不会绑定",
        suffix: "不代表检查通过或恢复执行",
        actions: "Enter 绑定当前定义 | r 不绑定 | Esc 稍后",
        help: "PgUp/PgDn 阅读 · 只绑定所示定义，不另弹选项确认",
        unread: "请先用 PgDn 完整查看本次材料；本次没有绑定。",
        ready: "材料已完整展示；Enter 才会绑定，尚未执行。",
      };
    return {
      heading: "集中审核 · 范围与验收定义 · 尚未启动",
      choices: "范围选择（只是草稿；完整对象和限制见上方材料）",
      incomplete: "材料未完整核对，不会提交批准",
      suffix: undefined,
      actions: this.question.approval?.definitionsOnly
        ? "Enter 确认更新定义 | r 不确认新定义 | Esc 稍后"
        : "Enter 批准所选范围与定义 | r 拒绝本次方案 | Esc 稍后",
      help: "↑↓ 移动选择 · 空格勾选 · a 全选必需项 · 不新增执行许可",
      unread: "请先用 PgDn 完整查看本次材料；本次没有提交批准。",
      ready: "材料已完整展示；选择仍是草稿，Enter 才保存决定。",
    };
  }
  render(width: number): string[] {
    if (this.closed) return [];
    width = Math.max(0, Math.floor(width));
    const rows = Math.max(0, Math.floor(this.env.rows()));
    if (width < 24 || rows < 14) {
      this.layout = undefined;
      this.shown.clear();
      return width && rows ? [materialLine("空间不足，保持未提交；Esc 稍后。", width)] : [];
    }
    const geometry = `${width}:${rows}`;
    if (this.geometry !== geometry) {
      this.geometry = geometry;
      this.invalidate();
    }
    const choices = this.choices(width);
    const capacity = rows - choices.length - 8;
    if (!this.layout) {
      const lines = wrapTextWithAnsi(this.question.body, width).map((line) =>
        materialLine(line, width),
      );
      this.layout = { lines, capacity, pages: Math.max(1, Math.ceil(lines.length / capacity)) };
    }
    const { lines, pages } = this.layout;
    this.page = Math.min(this.page, pages - 1);
    this.shown.add(this.page);
    const body = lines.slice(this.page * capacity, (this.page + 1) * capacity);
    const missing = this.options().filter(
      (option) => option.required && !this.selected.has(option.id),
    );
    const labels = this.labels();
    const status = this.reviewed() ? "完整材料已核对" : labels.incomplete;
    return [
      this.env.theme.fg("accent", materialLine(labels.heading, width)),
      this.env.theme.bold(materialLine(this.question.title, width)),
      this.env.theme.fg(
        "muted",
        materialLine(`材料 ${this.page + 1}/${pages} · PgUp/PgDn 阅读，关键范围完整保留`, width),
      ),
      ...body,
      ...Array.from({ length: capacity - body.length }, () => ""),
      this.env.theme.fg("muted", materialLine(labels.choices, width)),
      ...choices,
      materialLine(
        `${status} · ${labels.suffix ?? (missing.length ? `缺少${missing.length}项必需权限，保存后仍不启动` : "必需权限已齐，仍需独立Start")}`,
        width,
      ),
      this.env.theme.fg(
        "muted",
        materialLine(this.reviewed() ? labels.ready : this.message, width),
      ),
      materialLine(labels.actions, width),
      this.env.theme.fg("muted", materialLine(labels.help, width)),
    ];
  }
  private movePage(delta: number): void {
    if (!this.layout) return;
    this.page = Math.max(0, Math.min(this.layout.pages - 1, this.page + delta));
    this.env.requestRender();
  }
  private selectRequired(): void {
    if (this.question.approval?.definitionsOnly) return;
    this.selected = new Set(
      this.options()
        .filter((option) => option.required)
        .map((option) => option.id),
    );
  }
  private navigate(data: string): boolean {
    if (matchesKey(data, Key.pageDown)) this.movePage(1);
    else if (matchesKey(data, Key.pageUp)) this.movePage(-1);
    else if (this.env.keybindings.matches(data, "tui.select.up"))
      this.focus = Math.max(0, this.focus - 1);
    else if (this.env.keybindings.matches(data, "tui.select.down"))
      this.focus = Math.min(Math.max(0, this.options().length - 1), this.focus + 1);
    else return false;
    this.env.requestRender();
    return true;
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || this.env.keybindings.matches(data, "tui.select.cancel")) {
      this.dispose();
      this.done(undefined);
      return;
    }
    if (this.navigate(data)) return;
    if (data === "a") this.selectRequired();
    else if (data === " " && !this.question.approval?.definitionsOnly) {
      const option = this.options()[this.focus];
      if (option) {
        if (this.selected.has(option.id)) this.selected.delete(option.id);
        else this.selected.add(option.id);
      }
    } else if (data === "r") {
      this.complete("reject");
      return;
    } else if (this.env.keybindings.matches(data, "tui.select.confirm")) {
      if (this.reviewed()) {
        this.complete("approve");
        return;
      }
      this.message = this.labels().unread;
    } else return;
    this.env.requestRender();
  }
}
