import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Keybinding,
} from "@earendil-works/pi-tui";
import type { UiViewEnvironment } from "./ui-environment";
import { MaterialReading, type HumanMaterial } from "./human-material-view";

type ReviewResult = "reviewed" | "cancelled";
type Layout = { width: number; rows: number; lines: string[]; pageSize: number; pages: number };

// Smallest normal viewport the component guarantees full rendering for.
// Graphemes wider than this cannot be split by the native wrapper and must be
// code-point escaped before wrapping.
const MIN_NORMAL_VIEWPORT_WIDTH = 24;

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function escapedCodePoint(char: string): string {
  return `\\u{${char.codePointAt(0)?.toString(16).toUpperCase()}}`;
}

// No terminal commands or invisible separators enter the native wrapper. Spaces
// become visible dots because native word wrapping otherwise discards them.
function displayText(text: string): string {
  const visible = Array.from(text, (char) => {
    if (char === "\n") return char;
    if (char === " ") return "·";
    if (char === "\\") return "\\\\";
    if (char === "\t") return "\\t";
    if (char === "·" || /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}\s]/u.test(char)) {
      return escapedCodePoint(char);
    }
    return char;
  }).join("");
  return Array.from(
    new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(visible),
    ({ segment }) => {
      if (segment === "\n") return segment;
      const width = visibleWidth(segment);
      if (width > 0 && width <= MIN_NORMAL_VIEWPORT_WIDTH) return segment;
      return Array.from(segment, escapedCodePoint).join("");
    },
  ).join("");
}

class ScopeReview implements Component {
  private readonly text: string;
  private layout: Layout | undefined;
  private page = 0;
  private readonly shown = new Set<number>();
  private closed = false;

  constructor(
    text: string,
    private readonly env: UiViewEnvironment,
    private readonly done: (result: ReviewResult) => void,
  ) {
    this.text = displayText(text);
  }

  private reset(): void {
    this.layout = undefined;
    this.page = 0;
    this.shown.clear();
  }

  invalidate(): void {
    this.reset();
  }

  dispose(): void {
    this.closed = true;
    this.reset();
  }

  private complete(result: ReviewResult): void {
    this.dispose();
    this.done(result);
  }

  render(width: number): string[] {
    if (this.closed) return [];
    width = dimension(width);
    const rows = dimension(this.env.rows());
    if (this.layout?.width !== width || this.layout.rows !== rows) this.reset();
    if (width < 24 || rows < 8) {
      return width > 0 && rows > 0
        ? [this.env.theme.fg("muted", truncateToWidth("Esc 取消", width, ""))]
        : [];
    }
    if (!this.layout) {
      const lines = wrapTextWithAnsi(this.text, width);
      const pageSize = Math.min(18, rows - 5);
      this.layout = { width, rows, lines, pageSize, pages: Math.ceil(lines.length / pageSize) };
    }
    const { lines, pageSize, pages } = this.layout;
    const chrome = (text: string) => this.env.theme.fg("muted", truncateToWidth(text, width, ""));
    const keyName = (action: Keybinding) =>
      this.env.keybindings.getKeys(action).join("/") || "未绑定";
    const result = [
      this.env.theme.fg("accent", "只读核对（非作答）"),
      chrome(`第 ${this.page + 1}/${pages} 页`),
      chrome("· 空格；\\ 转义"),
      ...lines.slice(this.page * pageSize, (this.page + 1) * pageSize),
      chrome(`Esc 取消 | 回看: ${keyName("tui.select.up")}`),
      chrome(
        `${this.page === pages - 1 ? "继续作答" : "下一页"}: ${keyName("tui.select.confirm")}`,
      ),
    ];
    this.shown.add(this.page);
    return result;
  }

  private forward(confirm: boolean): void {
    if (!this.layout || !this.shown.has(this.page)) return;
    if (this.page < this.layout.pages - 1) {
      this.page++;
      this.env.requestRender();
    } else if (confirm && this.shown.size === this.layout.pages) {
      this.complete("reviewed");
    }
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const keys = this.env.keybindings;
    if (matchesKey(data, Key.escape) || keys.matches(data, "tui.select.cancel")) {
      this.complete("cancelled");
      return;
    }
    if (this.layout && this.layout.rows !== dimension(this.env.rows())) {
      this.reset();
      this.env.requestRender();
    }
    if (!this.layout) return;
    if (matchesKey(data, Key.home)) {
      this.page = 0;
      this.env.requestRender();
    } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.pageUp")) {
      this.page = Math.max(0, this.page - 1);
      this.env.requestRender();
    } else if (keys.matches(data, "tui.select.confirm")) {
      this.forward(true);
    } else if (
      keys.matches(data, "tui.select.down") ||
      keys.matches(data, "tui.select.pageDown") ||
      matchesKey(data, Key.end)
    ) {
      this.forward(false);
    }
  }
}

export function createScopeReview(
  text: string,
  env: UiViewEnvironment,
  done: (result: ReviewResult) => void,
  material?: HumanMaterial,
): Component & { dispose(): void } {
  const raw = new ScopeReview(text, env, done);
  return material ? new MaterialReading(material, raw, env) : raw;
}
