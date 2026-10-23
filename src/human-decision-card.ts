import {
  Input,
  SelectList,
  Key,
  matchesKey,
  visibleWidth,
  type Component,
  type Focusable,
  type Markdown,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { NativeQuestion } from "./human-ui";
import type { UiViewEnvironment } from "./ui-environment";
import { isSafeBoundedText } from "./validation";
import { createScopeReview } from "./human-scope-view";
import {
  MaterialReading,
  materialLine,
  preparedMarkdown,
  isNativeReadingAction,
  type HumanMaterial,
} from "./human-material-view";

/** A local draft, not a NativeAnswer, control record, grant or startup response. */
export type DecisionDraft = Readonly<{
  kind: NativeQuestion["kind"];
  index?: number;
  value?: string;
}>;
const drafts = new WeakMap<object, NativeQuestion>();
export function isDecisionDraft(value: unknown, question: NativeQuestion): value is DecisionDraft {
  return Boolean(
    value && typeof value === "object" && Object.isFrozen(value) && drafts.get(value) === question,
  );
}
type Surface = "answer" | "split" | "material" | "source";
type Review = ReturnType<typeof createScopeReview>;
const NOOP_READER = { render: () => [], invalidate() {}, dispose() {} };
const DOWN = "\u001b[B",
  UP = "\u001b[A";
function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * One captured question, same-screen draft controls and readonly material.
 * Full original review still owns coverage. Only the caller's subsequent native
 * select can confirm a draft; rendering/browsing never creates a NativeAnswer.
 */
export class DecisionCard implements Component, Focusable {
  private readonly question: NativeQuestion;
  private readonly body: Markdown;
  private input = new Input({ prompt: "> " });
  private readonly choices: SelectItem[];
  private readonly select: SelectList;
  private readonly preview: MaterialReading;
  private readonly context: MaterialReading;
  private source: Review | undefined;
  private surface: Surface = "answer";
  private origin: "answer" | "split" = "answer";
  private sourceFocused = false;
  private reviewed = false;
  private geometry: { width: number; rows: number } | undefined;
  private shown = false;
  private closed = false;
  private hasFocus = false;
  private message = "草稿尚未提交；浏览不会保存回应。";

  constructor(
    private readonly owner: NativeQuestion,
    private readonly original: string,
    private readonly env: UiViewEnvironment,
    private readonly done: (draft: DecisionDraft | undefined) => void,
    initial?: DecisionDraft,
    recheck = false,
  ) {
    this.question = {
      ...owner,
      options: owner.options ? [...owner.options] : undefined,
      material: owner.material ? structuredClone(owner.material) : undefined,
    };
    const material: HumanMaterial = this.question.material ?? {
      context: this.question.title,
      sections: [{ title: "本次请求", markdown: this.question.body }],
    };
    this.body = preparedMarkdown(
      material.sections
        .map((s) => `### ${materialLine(s.title, 120)}\n\n${s.markdown}`)
        .join("\n\n"),
      env,
    );
    this.preview = new MaterialReading(material, NOOP_READER, env, "material");
    this.context = new MaterialReading(material, NOOP_READER, env, "material");
    this.choices = this.makeChoices();
    this.select = new SelectList(this.choices, 3, {
      selectedPrefix: (text) => env.theme.fg("accent", text),
      selectedText: (text) => env.theme.fg("accent", text),
      description: (text) => env.theme.fg("muted", text),
      scrollInfo: (text) => env.theme.fg("muted", text),
      noMatch: (text) => env.theme.fg("muted", text),
    });
    this.input.onSubmit = () => {
      this.submitDraft();
    };
    if (initial && isDecisionDraft(initial, owner)) {
      this.reviewed = !recheck;
      if (initial.value !== undefined && this.validInformation(initial.value))
        this.input.setValue(initial.value);
      if (initial.index !== undefined)
        this.select.setSelectedIndex(
          this.choices.findIndex((item) => Number(item.value) === initial.index),
        );
    }
  }
  get focused(): boolean {
    return this.hasFocus;
  }
  set focused(value: boolean) {
    this.hasFocus = value;
    this.syncFocus();
  }
  private syncFocus(): void {
    this.input.focused =
      this.hasFocus &&
      this.question.kind === "information" &&
      !this.sourceFocused &&
      (this.surface === "answer" || this.surface === "split");
  }
  private makeChoices(): SelectItem[] {
    const defer = {
      value: "0",
      label: "稍后决定（不提交）",
      description: "保留等待状态，不授予权限。",
    };
    if (this.question.kind === "authorization")
      return [
        defer,
        {
          value: "1",
          label: "允许上述范围（草稿）",
          description: "仍须核对完整范围，并经原生最终确认。",
        },
        { value: "2", label: "不允许（草稿）", description: "拒绝与稍后不同；仍由原生确认保存。" },
      ];
    if (this.question.purpose === "first-start")
      return [
        defer,
        {
          value: "2",
          label: "开始执行（草稿）",
          description: "只启动已确认的当前方案，不扩大权限。",
        },
      ];
    return [
      defer,
      ...(this.question.options ?? []).map((value, i) => ({
        value: String(i + 1),
        label: materialLine(`选项 ${i + 1} · ${JSON.stringify(value)}`, 200),
        description: "本次仅选择方案，不扩大权限；原值以完整范围为准。",
      })),
    ];
  }
  private line(value: string, width: number): string {
    return materialLine(value, width);
  }
  private muted(value: string, width: number): string {
    return this.env.theme.fg("muted", this.line(value, width));
  }
  private refresh(): void {
    this.shown = false;
    this.syncFocus();
    this.env.requestRender();
  }
  private validInformation(value: string): boolean {
    if (!isSafeBoundedText(value, 1000)) return false;
    try {
      return !this.question.informationValidator || this.question.informationValidator(value);
    } catch {
      return false;
    }
  }
  private finish(draft: DecisionDraft | undefined): void {
    if (this.closed) return;
    this.dispose();
    this.done(draft);
  }
  private getSource(): Review {
    this.source ??= createScopeReview(this.original, this.env, (result) => {
      this.source = undefined;
      if (result === "reviewed") {
        this.reviewed = true;
        this.message = "完整范围已核对；请明确提交草稿，之后仍有原生最终确认。";
      } else this.message = "已返回作答；未提交回应，草稿仍保留。";
      this.surface = this.origin;
      this.sourceFocused = false;
      this.refresh();
    });
    return this.source;
  }
  private openSource(): void {
    this.origin = this.surface === "split" ? "split" : "answer";
    this.surface = "source";
    this.message = "先核对完整范围。阅读完成只返回草稿，不会提交或授权。";
    this.refresh();
  }
  private submitDraft(): void {
    if (!this.shown || this.closed) return;
    let draft: DecisionDraft;
    if (this.question.kind === "information") {
      const value = this.input.getValue();
      if (!this.validInformation(value)) {
        // Drop native undo/kill-ring state too: rejected text must not reappear.
        this.input = new Input({ prompt: "> " });
        this.input.onSubmit = () => {
          this.submitDraft();
        };
        this.syncFocus();
        this.message = `未保存：请输入安全、有效的${this.question.informationFormat ?? "文本"}信息（最多1000字）。`;
        this.refresh();
        return;
      }
      draft = { kind: "information", value };
    } else {
      const index = Number(this.select.getSelectedItem()?.value ?? "0");
      if (index === 0) {
        this.finish(undefined);
        return;
      }
      draft = { kind: this.question.kind, index };
    }
    if (!this.reviewed) {
      this.openSource();
      return;
    }
    const frozen = Object.freeze(draft);
    drafts.set(frozen, this.owner);
    this.finish(frozen);
  }
  private controls(width: number): string[] {
    if (this.question.kind === "information")
      return [
        this.line(`填写信息 · ${this.question.informationFormat ?? "文本"} · 原值保存`, width),
        ...this.input.render(width),
      ];
    return this.select.render(width);
  }
  private summary(width: number): string[] {
    const values = this.question.material?.summary ?? [
      "摘要不替代完整范围；执行、写入和首次启动仍受原有门槛约束。",
    ];
    const lines = values
      .slice(0, 3)
      .map((value) => this.env.theme.fg("warning", this.line(value, width)));
    if (values.length > 3)
      lines.push(this.muted(`另有 ${values.length - 3} 项范围/风险摘要，完整核对时查看。`, width));
    return lines;
  }
  private reservedKey(data: string): boolean {
    return (
      isNativeReadingAction(this.env.keybindings, data) ||
      (this.question.kind === "information" &&
        this.env.keybindings.matches(data, "tui.input.submit"))
    );
  }
  private shortcuts(split: boolean): string {
    const hints: string[] = [];
    if (split && !this.reservedKey("\t")) hints.push("Tab 作答/原文");
    if (!this.reservedKey("\u001bOQ")) hints.push("F2 原文核对");
    if ((this.geometry?.width ?? 0) >= 100 && !this.reservedKey("\u001bOR"))
      hints.push(split ? "F3 单栏" : "F3 双栏");
    if (!this.reservedKey("\u001bOS")) hints.push("F4 材料");
    if (this.question.kind !== "information" && !this.reservedKey("m")) hints.push("m 材料");
    return hints.join(" | ");
  }
  private card(width: number, rows: number, split = false): string[] {
    const controls = this.controls(width);
    const summary = this.summary(width);
    const fixed = 7 + controls.length + summary.length;
    if (rows < fixed + 1) {
      this.shown = false;
      return [this.muted("空间不足，请扩大终端；Esc 稍后决定", width)];
    }
    const body = this.body.render(width);
    const capacity = rows - fixed;
    const notice =
      body.length > capacity
        ? "正文为摘要，提交前须核对完整原文"
        : "关键范围与草稿同屏，最终确认前须核对原文";
    return [
      this.env.theme.fg(
        "accent",
        this.line(`需要你回应 · ${split ? "C 双栏" : "A 会话卡"} · 草稿作答（尚未提交）`, width),
      ),
      this.line(this.question.title, width),
      ...body.slice(0, capacity),
      this.muted(notice, width),
      ...summary,
      ...controls,
      this.muted(
        this.reviewed ? "完整原文已核对 · 未保存回应" : "完整原文尚未核对 · 不会提交",
        width,
      ),
      this.muted(this.message, width),
      this.muted(
        `${this.env.keybindings.getKeys("tui.select.confirm").join("/") || "未绑定"} 下一步（草稿） | Esc 稍后`,
        width,
      ),
      this.muted(this.shortcuts(split), width),
    ];
  }
  private split(width: number, rows: number): string[] {
    const leftWidth = Math.floor((width - 3) / 2);
    const left = this.card(leftWidth, rows, true);
    this.origin = "split";
    const right = this.reviewed
      ? this.context.render(width - leftWidth - 3)
      : this.getSource().render(width - leftWidth - 3);
    return Array.from({ length: Math.max(left.length, right.length) }, (_, i) => {
      const line = left[i] ?? "";
      return `${line}${" ".repeat(Math.max(0, leftWidth - visibleWidth(line)))} │ ${right[i] ?? ""}`;
    });
  }
  render(width: number): string[] {
    if (this.closed) return [];
    width = dimension(width);
    const rows = dimension(this.env.rows());
    if (this.geometry && (this.geometry.width !== width || this.geometry.rows !== rows))
      this.invalidate();
    this.geometry = { width, rows };
    if (width < 24 || rows < 8) {
      this.shown = false;
      return width && rows ? [this.muted("Esc 稍后决定", width)] : [];
    }
    if (width < 100 && this.surface === "split") {
      this.surface = "answer";
      this.sourceFocused = false;
    }
    this.syncFocus();
    this.shown = true;
    if (this.surface === "material") return this.preview.render(width);
    if (this.surface === "source") return this.getSource().render(width);
    return this.surface === "split" ? this.split(width, rows) : this.card(width, rows);
  }
  private displayKey(data: string): boolean {
    if (matchesKey(data, Key.f2)) {
      this.openSource();
      return true;
    }
    if (matchesKey(data, Key.f3) && (this.geometry?.width ?? 0) >= 100) {
      this.surface = this.surface === "split" ? "answer" : "split";
      this.reviewed = false;
      this.source?.dispose();
      this.source = undefined;
      this.sourceFocused = false;
      this.refresh();
      return true;
    }
    if (matchesKey(data, Key.f4) || (data === "m" && this.question.kind !== "information")) {
      this.origin = this.surface === "split" ? "split" : "answer";
      this.surface = "material";
      this.refresh();
      return true;
    }
    return false;
  }
  private handleAnswer(data: string): void {
    const keys = this.env.keybindings;
    if (keys.matches(data, "tui.select.confirm")) {
      this.submitDraft();
      return;
    }
    if (this.question.kind === "information") {
      this.input.handleInput(data);
      this.env.requestRender();
      return;
    }
    const selected = this.choices.findIndex(
      (item) => item.value === this.select.getSelectedItem()?.value,
    );
    if (keys.matches(data, "tui.select.up"))
      this.select.setSelectedIndex(Math.max(0, selected - 1));
    else if (keys.matches(data, "tui.select.down"))
      this.select.setSelectedIndex(Math.min(this.choices.length - 1, selected + 1));
    else if (data === UP || data === DOWN) this.select.handleInput(data);
    else return;
    this.refresh();
  }
  private cancel(): void {
    if (this.surface === "material" || this.surface === "source") {
      this.source?.dispose();
      this.source = undefined;
      this.surface = this.origin;
      this.sourceFocused = false;
      this.refresh();
    } else if (this.sourceFocused) {
      this.sourceFocused = false;
      this.refresh();
    } else this.finish(undefined);
  }
  private submitKey(data: string): boolean {
    return (
      this.env.keybindings.matches(data, "tui.select.confirm") ||
      (this.question.kind === "information" &&
        this.env.keybindings.matches(data, "tui.input.submit"))
    );
  }
  private browseMaterial(data: string): void {
    const fixedReturn =
      !isNativeReadingAction(this.env.keybindings, data) && ["m", "r"].includes(data);
    if (this.env.keybindings.matches(data, "tui.select.confirm") || fixedReturn) {
      this.surface = this.origin;
      this.refresh();
    } else this.preview.handleInput(data);
  }
  private handleReading(data: string): boolean {
    if (this.surface === "material") {
      this.browseMaterial(data);
      return true;
    }
    if (this.surface === "source") {
      this.getSource().handleInput?.(data);
      return true;
    }
    if (matchesKey(data, Key.tab) && this.surface === "split" && !this.reservedKey(data)) {
      this.sourceFocused = !this.sourceFocused;
      this.message = this.sourceFocused
        ? "焦点：完整原文；Enter 只完成核对，不会提交。"
        : "焦点：作答；下一步仍需原生最终确认。";
      this.refresh();
      return true;
    }
    if (this.sourceFocused) {
      this.getSource().handleInput?.(data);
      return true;
    }
    return false;
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || this.env.keybindings.matches(data, "tui.select.cancel")) {
      this.cancel();
      return;
    }
    if (this.geometry && this.geometry.rows !== dimension(this.env.rows())) {
      this.invalidate();
      this.env.requestRender();
      return;
    }
    if (!this.geometry || !this.shown) return;
    if (this.handleReading(data)) return;
    if (this.submitKey(data)) {
      this.submitDraft();
      return;
    }
    if (isNativeReadingAction(this.env.keybindings, data) || !this.displayKey(data))
      this.handleAnswer(data);
  }
  invalidate(): void {
    this.geometry = undefined;
    this.shown = false;
    this.reviewed = false;
    this.source?.dispose();
    this.source = undefined;
    this.body.invalidate();
    this.preview.invalidate();
    this.context.invalidate();
    this.select.invalidate();
    this.input.invalidate();
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.focused = false;
    this.input.setValue("");
    this.source?.dispose();
    this.preview.dispose();
    this.context.dispose();
  }
}
