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
  readonly sections: readonly Readonly<{ title: string; markdown: string }>[];
}

type Reader = Component & { dispose(): void };
type Layout = { width: number; rows: number; pages: string[][] };
type CodeRange = { start: number; end: number };

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function escapePoint(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase()}}`;
}

/** Readability only: exact whitespace/control bytes still require the original reader. */
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

/** Capture native syntax output during preparation; later resize/render reads only this cache. */
function preparedMarkdown(text: string, env: UiViewEnvironment): Markdown {
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

/** Formatted browsing cannot complete a review. Only the unchanged raw reader can do so. */
export class MaterialReading implements Component {
  private readonly sections: Array<{ title: string; markdown: Markdown }>;
  private layout: Layout | undefined;
  private page = 0;
  private rawMode = false;
  private shown = false;
  private closed = false;

  constructor(
    material: HumanMaterial,
    private readonly raw: Reader,
    private readonly env: UiViewEnvironment,
  ) {
    this.sections = material.sections.map((section) => ({
      title: section.title,
      markdown: preparedMarkdown(section.markdown, env),
    }));
  }

  invalidate(): void {
    this.layout = undefined;
    this.page = 0;
    this.shown = false;
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
        const title = materialLine(`${section.title}${offset ? "（续）" : ""}`, width);
        page.push(this.env.theme.fg("accent", this.env.theme.bold(title)));
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

  render(width: number): string[] {
    if (this.closed) return [];
    width = dimension(width);
    const rows = dimension(this.env.rows());
    if (this.layout && (this.layout.width !== width || this.layout.rows !== rows))
      this.invalidate();
    if (width < 24 || rows < 8) {
      return width > 0 && rows > 0
        ? [this.env.theme.fg("muted", truncateToWidth("Esc 取消", width, ""))]
        : [];
    }
    this.layout ??= { width, rows, pages: this.pages(width, Math.min(18, rows - 5)) };
    if (this.rawMode) return this.raw.render(width);
    const pages = this.layout.pages.length ? this.layout.pages : [["未提供格式化材料"]];
    const chrome = (text: string) => this.env.theme.fg("muted", materialLine(text, width));
    this.shown = true;
    return [
      this.env.theme.fg("accent", materialLine("格式化浏览（非核对、非作答）", width)),
      chrome(`第 ${this.page + 1}/${pages.length} 页`),
      chrome("接下来仍须核对完整原文"),
      ...(pages[this.page] ?? []),
      chrome(`Esc 取消 | ${this.keyName("tui.select.up")} 回看 | r 原文核对`),
      chrome(
        this.page === pages.length - 1
          ? `${this.keyName("tui.select.confirm")} 原文核对`
          : `${this.keyName("tui.select.confirm")} / ${this.keyName("tui.select.down")} 下一页`,
      ),
    ];
  }

  private move(data: string): boolean {
    const keys = this.env.keybindings;
    if (matchesKey(data, Key.home)) this.page = 0;
    else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.pageUp"))
      this.page = Math.max(0, this.page - 1);
    else if (
      keys.matches(data, "tui.select.confirm") ||
      keys.matches(data, "tui.select.down") ||
      keys.matches(data, "tui.select.pageDown") ||
      matchesKey(data, Key.end)
    )
      this.page = Math.min(Math.max(0, (this.layout?.pages.length ?? 1) - 1), this.page + 1);
    else return false;
    return true;
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keys = this.env.keybindings;
    if (matchesKey(data, Key.escape) || keys.matches(data, "tui.select.cancel")) {
      this.raw.handleInput?.(data);
      this.closed = true;
      return;
    }
    if (this.layout && this.layout.rows !== dimension(this.env.rows())) {
      this.invalidate();
      this.env.requestRender();
    }
    if (!this.layout) return;
    if (this.rawMode) {
      this.raw.handleInput?.(data);
      return;
    }
    if (!this.shown) return;
    if (
      data === "r" ||
      (keys.matches(data, "tui.select.confirm") && this.page >= this.layout.pages.length - 1)
    ) {
      this.rawMode = true;
    } else if (!this.move(data)) return;
    this.shown = false;
    this.env.requestRender();
  }
}
