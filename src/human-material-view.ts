import { highlightCode } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  stripTerminalSequences,
  type Component,
  type MarkdownTheme,
  type Keybinding,
} from "@earendil-works/pi-tui";
import type { UiViewEnvironment } from "./ui-environment";

/** Display-only data. It is never a request frame, proof, canonical answer or permission. */
export interface HumanMaterial {
  readonly context: string;
  /** Owner-derived decision summary; never substitutes for canonical review. */
  readonly summary?: readonly string[];
  readonly sections: readonly Readonly<{ title: string; markdown: string }>[];
}

type Reader = Component & { dispose(): void };
type Layout = { width: number; rows: number; pages: string[][] };
type CodeRange = { start: number; end: number };
type Surface = "card" | "material" | "split";
const SPLIT_COLUMNS = 100;
const NATIVE_ACTIONS = [
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.select.up",
  "tui.select.down",
  "tui.select.pageUp",
  "tui.select.pageDown",
] as const satisfies readonly Keybinding[];

export function isNativeReadingAction(
  keys: UiViewEnvironment["keybindings"],
  data: string,
): boolean {
  return NATIVE_ACTIONS.some((action) => keys.matches(data, action));
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function escapePoint(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase()}}`;
}

/** Markdown is supplementary: canonical values remain in the original reader. */
function safeText(text: string): string {
  const visible = Array.from(text, (char) => {
    if (char === "\n" || char === " ") return char;
    if (char === "\t") return "    ";
    return /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\s]/u.test(char)
      ? escapePoint(char)
      : char;
  }).join("");
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visible),
    ({ segment }) => {
      if (segment === "\n") return segment;
      const width = visibleWidth(segment);
      return width > 0 && width <= 24 ? segment : Array.from(segment, escapePoint).join("");
    },
  ).join("");
}

/** One safe display line; no owner-controlled new header or terminal instruction. */
export function materialLine(text: string, width: number): string {
  return stripTerminalSequences(
    truncateToWidth(safeText(text).replace(/\n/g, "\\n"), dimension(width), "…"),
  );
}

function markdownTheme(env: UiViewEnvironment): MarkdownTheme {
  const fg = env.theme.fg.bind(env.theme);
  return {
    heading: (text) => fg("mdHeading", env.theme.bold(text)),
    link: (text) => fg("mdLink", text),
    linkUrl: (text) => fg("mdLinkUrl", text),
    code: (text) => fg("mdCode", text),
    codeBlock: (text) => fg("mdCodeBlock", text),
    codeBlockBorder: (text) => fg("mdCodeBlockBorder", text),
    quote: (text) => fg("mdQuote", text),
    quoteBorder: (text) => fg("mdQuoteBorder", text),
    hr: (text) => fg("mdHr", text),
    listBullet: (text) => fg("mdListBullet", text),
    bold: env.theme.bold.bind(env.theme),
    italic: (text) => env.theme.italic(text),
    strikethrough: env.theme.strikethrough.bind(env.theme),
    underline: (text) => env.theme.underline(text),
  };
}

/** Prepare syntax once, never invoke a highlighter or external work during render. */
export function preparedMarkdown(text: string, env: UiViewEnvironment): Markdown {
  const syntax = new Map<string, readonly string[]>();
  let preparing = true;
  const theme: MarkdownTheme = {
    ...markdownTheme(env),
    highlightCode: (code, lang) => {
      const key = JSON.stringify([code, lang]);
      if (preparing) syntax.set(key, Object.freeze(highlightCode(code, lang)));
      const lines = syntax.get(key);
      if (!lines) throw new Error("Material code was not prepared");
      return [...lines];
    },
  };
  const markdown = new Markdown(safeText(text), 0, 0, theme, undefined, {
    preserveOrderedListMarkers: true,
    preserveBackslashEscapes: true,
    renderLatex: false,
  });
  markdown.render(80);
  preparing = false;
  return markdown;
}

function codeRanges(lines: readonly string[]): CodeRange[] {
  const ranges: CodeRange[] = [];
  let start: number | undefined;
  lines.forEach((line, index) => {
    const text = stripTerminalSequences(line).trim();
    if (start === undefined) {
      if (text.startsWith("```")) start = index;
    } else if (text === "```") {
      ranges.push({ start, end: index + 1 });
      start = undefined;
    }
  });
  return ranges;
}

function fittingLines(
  ranges: readonly CodeRange[],
  offset: number,
  available: number,
  capacity: number,
  remaining: number,
): number {
  const count = Math.min(available, remaining);
  const crossing = ranges.find(
    (range) =>
      range.start >= offset &&
      range.start < offset + count &&
      range.end > offset + count &&
      range.end - range.start < capacity,
  );
  return crossing ? crossing.start - offset : count;
}

/**
 * A: canonical scope, once. B: optional Markdown reader. C: explicit wide view.
 * Only `raw` owns review completion. Neither material navigation nor a preview
 * can advance its coverage or produce an answer; native select/input follows it.
 */
export class MaterialReading implements Component {
  private readonly sections: Array<{ title: string; markdown: Markdown }>;
  private readonly context: string;
  private layout: Layout | undefined;
  private geometry: { width: number; rows: number } | undefined;
  private page = 0;
  private surface: Surface = "card";
  private origin: "card" | "split" = "card";
  private shown = false;
  private closed = false;

  constructor(
    material: HumanMaterial,
    private readonly raw: Reader,
    private readonly env: UiViewEnvironment,
    initialSurface: Surface = "card",
  ) {
    this.surface = initialSurface;
    this.context = material.context;
    this.sections = material.sections.map((section) => ({
      title: section.title,
      markdown: preparedMarkdown(section.markdown, env),
    }));
  }

  invalidate(): void {
    this.layout = undefined;
    this.geometry = undefined;
    this.page = 0;
    this.shown = false;
    for (const section of this.sections) section.markdown.invalidate();
    this.raw.invalidate();
  }
  dispose(): void {
    this.closed = true;
    this.invalidate();
    this.raw.dispose();
  }
  private keyName(action: Keybinding): string {
    return this.env.keybindings.getKeys(action).join("/") || "未绑定";
  }
  private nativeAction(data: string): boolean {
    return isNativeReadingAction(this.env.keybindings, data);
  }
  private chrome(text: string, width: number): string {
    return this.env.theme.fg("muted", materialLine(text, width));
  }

  private pages(width: number, capacity: number): string[][] {
    const pages: string[][] = [[]];
    for (const section of this.sections) {
      const lines = section.markdown.render(width);
      if (!lines.length) lines.push("（空）");
      const ranges = codeRanges(lines);
      let offset = 0;
      while (offset < lines.length) {
        let page = pages.at(-1);
        const nextCode = ranges.find(
          (range) => range.start === offset && range.end - range.start < capacity,
        );
        const required = 1 + (nextCode ? nextCode.end - nextCode.start : 1);
        if (
          !page ||
          capacity - page.length < required ||
          (offset === 0 &&
            lines.length + 1 <= capacity &&
            lines.length + 1 > capacity - page.length)
        ) {
          page = [];
          pages.push(page);
        }
        page.push(
          this.env.theme.fg(
            "accent",
            this.env.theme.bold(materialLine(`${section.title}${offset ? "（续）" : ""}`, width)),
          ),
        );
        const count = fittingLines(
          ranges,
          offset,
          capacity - page.length,
          capacity,
          lines.length - offset,
        );
        page.push(...lines.slice(offset, offset + count));
        offset += count;
      }
    }
    return pages.filter((page) => page.length > 0);
  }

  private material(width: number, rows: number, preview = false): string[] {
    if (!this.layout || this.layout.width !== width || this.layout.rows !== rows)
      this.layout = { width, rows, pages: this.pages(width, rows - 5) };
    const pages = this.layout.pages.length ? this.layout.pages : [["未提供格式化材料"]];
    const page = preview ? 0 : Math.min(this.page, pages.length - 1);
    if (!preview) this.page = page;
    return [
      this.env.theme.fg("accent", materialLine("格式化浏览（非核对、非作答）", width)),
      this.chrome(`第 ${page + 1}/${pages.length} 页`, width),
      this.chrome(`问题：${this.context}`, width),
      ...(pages[page] ?? []),
      this.chrome(
        preview ? "补充材料不代替左侧原文" : `Esc 返回 | ${this.keyName("tui.select.up")} 回看`,
        width,
      ),
      this.chrome(
        preview
          ? this.nativeAction("m")
            ? "补充材料仅供参考"
            : "m 展开完整材料"
          : `${this.keyName("tui.select.confirm")} 返回作答 | ${this.keyName("tui.select.down")} 下一页`,
        width,
      ),
    ];
  }

  private interactive(): boolean {
    return Boolean(this.geometry && this.geometry.width >= 24 && dimension(this.env.rows()) >= 8);
  }
  private refresh(): void {
    this.shown = false;
    this.env.requestRender();
  }
  private card(width: number, split = false): string[] {
    const lines = this.raw.render(width);
    const hints: string[] = [];
    if (!this.nativeAction("m")) hints.push("m 材料");
    if (split && !this.nativeAction("\t")) hints.push("Tab 单栏");
    else if (width >= SPLIT_COLUMNS && !this.nativeAction("\t")) hints.push("Tab 双栏");
    if (hints.length && lines.length > 1)
      lines[lines.length - 2] = this.chrome(
        `Esc 取消 | ${hints.join(" | ")} | ${this.keyName("tui.select.up")} 回看`,
        width,
      );
    return lines;
  }
  private split(width: number, rows: number): string[] {
    const leftWidth = Math.floor((width - 3) / 2);
    const left = this.card(leftWidth, true);
    const right = this.material(width - leftWidth - 3, rows, true);
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => {
      const line = left[index] ?? "";
      return `${line}${" ".repeat(leftWidth - visibleWidth(line))} │ ${right[index] ?? ""}`;
    });
  }

  render(width: number): string[] {
    if (this.closed) return [];
    width = dimension(width);
    const rows = dimension(this.env.rows());
    if (this.geometry && (this.geometry.width !== width || this.geometry.rows !== rows))
      this.invalidate();
    this.geometry = { width, rows };
    if (!this.interactive()) {
      this.shown = false;
      return width > 0 && rows > 0 ? [this.chrome("Esc 取消", width)] : [];
    }
    if (width < SPLIT_COLUMNS && this.surface === "split") this.surface = "card";
    this.shown = true;
    if (this.surface === "material") return this.material(width, rows);
    return this.surface === "split" ? this.split(width, rows) : this.card(width);
  }

  /** Fixed display shortcuts never shadow a configured native action. */
  private switchSurface(data: string): boolean {
    if (this.nativeAction(data)) return false;
    if (data === "m") {
      if (this.surface === "material") this.surface = this.origin;
      else {
        this.origin = this.surface;
        this.surface = "material";
      }
    } else if (data === "r" && this.surface === "material") this.surface = this.origin;
    else if (
      matchesKey(data, Key.tab) &&
      this.surface !== "material" &&
      (this.geometry?.width ?? 0) >= SPLIT_COLUMNS
    ) {
      this.surface = this.surface === "split" ? "card" : "split";
      this.raw.invalidate();
    } else return false;
    this.refresh();
    return true;
  }
  private moveMaterial(data: string): void {
    const keys = this.env.keybindings;
    const last = Math.max(0, (this.layout?.pages.length ?? 1) - 1);
    if (keys.matches(data, "tui.select.confirm")) this.surface = this.origin;
    else if (matchesKey(data, Key.home)) this.page = 0;
    else if (matchesKey(data, Key.end)) this.page = last;
    else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.pageUp"))
      this.page = Math.max(0, this.page - 1);
    else if (keys.matches(data, "tui.select.down") || keys.matches(data, "tui.select.pageDown"))
      this.page = Math.min(last, this.page + 1);
    else return;
    this.refresh();
  }
  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, Key.escape) || this.env.keybindings.matches(data, "tui.select.cancel")) {
      if (this.surface === "material" && this.interactive()) {
        this.surface = this.origin;
        this.refresh();
      } else this.raw.handleInput?.(data);
      return;
    }
    if (this.geometry && this.geometry.rows !== dimension(this.env.rows())) {
      this.invalidate();
      this.env.requestRender();
    }
    if (!this.interactive() || !this.shown) return;
    if (this.switchSurface(data)) return;
    if (this.surface === "material") this.moveMaterial(data);
    else this.raw.handleInput?.(data);
  }
}
