import { describe, expect, it, vi } from "vitest";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { UiViewEnvironment } from "../ui-view";
import { createScopeReview } from "../human-scope-view";
import { createMockTheme } from "./helpers/mocks";

function environment(rows = 8): UiViewEnvironment {
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, text) => text);
  return {
    theme,
    keybindings: new KeybindingsManager(TUI_KEYBINDINGS) as UiViewEnvironment["keybindings"],
    rows: () => rows,
    requestRender: vi.fn(),
  };
}

const threePages = Array.from({ length: 9 }, (_, index) => `line-${index}`).join("\n");

function body(lines: string[]): string[] {
  return lines.slice(3, -2);
}

function allPages(review: ReturnType<typeof createScopeReview>, width: number): string[] {
  const contents: string[] = [];
  for (let attempts = 0; attempts < 10000; attempts++) {
    const lines = review.render(width);
    contents.push(...body(lines));
    const match = /第 (\d+)\/(\d+) 页/.exec(lines[1] ?? "");
    if (!match) throw new Error("Missing page indicator");
    if (match[1] === match[2]) return contents;
    review.handleInput?.("\u001b[6~");
  }
  throw new Error("Content did not end");
}

describe("createScopeReview", () => {
  it("sentinel: requires each of three pages to render before advancing or completing", () => {
    const done = vi.fn();
    const review = createScopeReview(threePages, environment(), done);
    const enter = () => review.handleInput?.("\r");
    enter();
    expect(done).not.toHaveBeenCalled();
    expect(review.render(24).join("\n")).toContain("第 1/3 页");
    enter();
    enter();
    enter();
    expect(done).not.toHaveBeenCalled();
    expect(review.render(24).join("\n")).toContain("第 2/3 页");
    enter();
    enter();
    expect(done).not.toHaveBeenCalled();
    expect(review.render(24).join("\n")).toContain("第 3/3 页");
    enter();
    enter();
    expect(done.mock.calls).toEqual([["reviewed"]]);
    expect(review.render(24)).toEqual([]);
    review.dispose();
  });

  it("cancels before first render exactly once, including reentrant input", () => {
    const done = vi.fn(() => review.handleInput?.("\r"));
    const review = createScopeReview(threePages, environment(), done);
    review.handleInput?.("unknown");
    review.handleInput?.("\u001b");
    review.handleInput?.("\u001b");
    review.invalidate();
    expect(done.mock.calls).toEqual([["cancelled"]]);
    expect(review.render(80)).toEqual([]);
  });

  it.each([0, 1, 2])("Esc cancels rendered page %s without reviewing", (page) => {
    const done = vi.fn();
    const review = createScopeReview(threePages, environment(), done);
    for (let current = 0; current <= page; current++) {
      review.render(24);
      if (current < page) review.handleInput?.("\r");
    }
    review.handleInput?.("\u001b");
    review.handleInput?.("\r");
    expect(done.mock.calls).toEqual([["cancelled"]]);
    expect(review.render(24)).toEqual([]);
  });

  it.each([false, true])("dispose is silent and idempotent (rendered=%s)", (rendered) => {
    const done = vi.fn();
    const review = createScopeReview("one page", environment(), done);
    if (rendered) review.render(24);
    review.dispose();
    review.dispose();
    review.invalidate();
    review.handleInput?.("\r");
    review.handleInput?.("\u001b");
    expect(done).not.toHaveBeenCalled();
    expect(review.render(24)).toEqual([]);
  });

  it("stays closed even when completion throws", () => {
    const done = vi.fn(() => {
      throw new Error("host completion");
    });
    const review = createScopeReview("", environment(), done);
    review.render(24);
    expect(() => review.handleInput?.("\r")).toThrow("host completion");
    review.handleInput?.("\r");
    expect(done).toHaveBeenCalledTimes(1);
    expect(review.render(24)).toEqual([]);
  });

  it.each([0, -1, NaN, Infinity, -Infinity, 1, 23.9])(
    "width %s is cancel-only, including before first render",
    (width) => {
      const done = vi.fn();
      const review = createScopeReview("secret body", environment(), done);
      const lines = review.render(width);
      expect(lines.length).toBeLessThanOrEqual(1);
      expect(lines.join("")).not.toContain("secret");
      if (Number.isFinite(width) && width > 0) {
        expect(lines.every((line) => visibleWidth(line) <= Math.floor(width))).toBe(true);
      } else expect(lines).toEqual([]);
      for (const key of ["\r", "\u001b[6~", "\u001b[F", "x"]) review.handleInput?.(key);
      expect(done).not.toHaveBeenCalled();
      review.handleInput?.("\u001b");
      expect(done.mock.calls).toEqual([["cancelled"]]);
    },
  );

  it.each([0, -1, NaN, Infinity, -Infinity, 1, 7.9])("rows %s are cancel-only", (rows) => {
    const done = vi.fn();
    const review = createScopeReview("secret body", environment(rows), done);
    const lines = review.render(80);
    expect(lines.join("")).not.toContain("secret");
    expect(lines.length).toBe(Number.isFinite(rows) && rows >= 1 ? 1 : 0);
    review.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    review.handleInput?.("\u001b");
    expect(done.mock.calls).toEqual([["cancelled"]]);
  });

  it.each([
    [24, 8],
    [25.9, 8.9],
    [80, 24],
    [120, 60],
  ])("bounds output at %s columns and %s rows, using available body height", (width, rows) => {
    const review = createScopeReview(threePages.repeat(100), environment(rows), vi.fn());
    const lines = review.render(width);
    expect(lines.length).toBeLessThanOrEqual(Math.floor(rows));
    expect(body(lines).length).toBeLessThanOrEqual(Math.floor(rows) - 5);
    expect(lines.every((line) => visibleWidth(line) <= Math.floor(width))).toBe(true);
    review.dispose();
  });

  it("End and rapid navigation never skip an unrendered page; backwards paths remain reachable", () => {
    const done = vi.fn();
    const review = createScopeReview(threePages, environment(), done);
    review.render(24);
    for (let count = 0; count < 10; count++) review.handleInput?.("\u001b[F");
    expect(review.render(24)[1]).toContain("第 2/3 页");
    review.handleInput?.("\u001b[5~");
    expect(review.render(24)[1]).toContain("第 1/3 页");
    review.handleInput?.("\u001b[A");
    review.handleInput?.("\u001b[6~");
    expect(review.render(24)[1]).toContain("第 2/3 页");
    review.handleInput?.("\u001b[B");
    expect(review.render(24)[1]).toContain("第 3/3 页");
    for (const key of ["\u001b[B", "\u001b[6~", "\u001b[F", "?", "reviewed"]) {
      review.handleInput?.(key);
    }
    expect(done).not.toHaveBeenCalled();
    review.handleInput?.("\u001b[H");
    expect(review.render(24)[1]).toContain("第 1/3 页");
    review.handleInput?.("\u001b[6~");
    review.handleInput?.("\u001b[6~");
    expect(review.render(24)[1]).toContain("第 3/3 页");
    review.handleInput?.("\r");
    expect(done.mock.calls).toEqual([["reviewed"]]);
  });

  it.each(["width", "height", "invalidate"])("%s reflow discards old coverage", (change) => {
    let rows = 8;
    const env = { ...environment(), rows: () => rows };
    const done = vi.fn();
    const review = createScopeReview(threePages, env, done);
    allPages(review, 24);
    let width = 24;
    if (change === "width") width = 25;
    if (change === "height") rows = 9;
    if (change === "invalidate") {
      review.invalidate();
      review.handleInput?.("\r");
      expect(done).not.toHaveBeenCalled();
    }
    expect(review.render(width)[1]).toContain("第 1/");
    for (let count = 0; count < 10; count++) review.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    expect(review.render(width)[1]).toContain("第 2/");
    allPages(review, width);
    review.handleInput?.("\r");
    expect(done.mock.calls).toEqual([["reviewed"]]);
  });

  it("height changes are noticed on input before rerender, including tiny and restored dimensions", () => {
    let rows = 8;
    const env = { ...environment(), rows: () => rows };
    const done = vi.fn();
    const review = createScopeReview(threePages, env, done);
    allPages(review, 24);
    rows = 1;
    review.handleInput?.("\r");
    expect(env.requestRender).toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
    expect(review.render(24)).toEqual(["Esc 取消"]);
    rows = 8;
    review.handleInput?.("\r");
    expect(review.render(24)[1]).toContain("第 1/3 页");
    review.dispose();
  });

  it("a tiny width resets previous full coverage", () => {
    const done = vi.fn();
    const review = createScopeReview(threePages, environment(), done);
    allPages(review, 24);
    expect(review.render(23)).toEqual(["Esc 取消"]);
    review.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    expect(review.render(24)[1]).toContain("第 1/3 页");
    review.dispose();
  });

  it.each([24, 48, 80])(
    "every grapheme of long CJK/combining text is reachable at width %s",
    (width) => {
      const text = "中文e\u0301🚀".repeat(300);
      const review = createScopeReview(text, environment(), vi.fn());
      const pages = allPages(review, width);
      expect(pages.join("")).toBe(text);
      expect(pages.every((line) => visibleWidth(line) <= width)).toBe(true);
      review.dispose();
    },
  );

  it("preserves blank lines, trailing and repeated spaces, tabs and escaped characters visibly", () => {
    const text = `  first  \n\n${" ".repeat(95)}\nlast\t\\·\r\n`;
    const review = createScopeReview(text, environment(), vi.fn());
    const pages = allPages(review, 24);
    expect(pages).toContain("");
    expect(pages.at(-1)).toBe("");
    expect(pages.join("")).toBe(`··first··${"·".repeat(95)}last\\t\\\\\\u{B7}\\u{D}`);
    review.dispose();
  });

  it("escapes terminal commands, bidi, unusual whitespace, lone surrogates and orphan combining marks", () => {
    const text = "\u0301\n\u001b[31mred\u0007\u009b\u202e\u00a0\u200b\u2028\ud800x\u034f\ufe0f";
    const review = createScopeReview(text, environment(), vi.fn());
    const pages = allPages(review, 24);
    expect(pages.join("")).toBe(
      "\\u{301}\\u{1B}[31mred\\u{7}\\u{9B}\\u{202E}\\u{A0}\\u{200B}\\u{2028}\\u{D800}x\\u{34F}\\u{FE0F}",
    );
    expect(pages.join("")).not.toMatch(/[\p{Cc}\p{Cf}\p{Cs}]/u);
    review.dispose();
  });

  it("uses injected native bindings without changing their config; Esc always cancels", () => {
    const env = environment();
    env.keybindings.setUserBindings({
      "tui.select.confirm": "y",
      "tui.select.down": "n",
      "tui.select.up": "p",
      "tui.select.pageDown": "f",
      "tui.select.pageUp": "b",
      "tui.select.cancel": "q",
    });
    const bindings = structuredClone(env.keybindings.getResolvedBindings());
    const done = vi.fn();
    const review = createScopeReview(threePages, Object.freeze(env), done);
    const initial = review.render(24);
    expect(initial.at(-1)).toBe("下一页: y");
    expect(initial.at(-2)).toContain("回看: p");
    review.handleInput?.("\r");
    expect(review.render(24)[1]).toContain("第 1/3 页");
    review.handleInput?.("n");
    expect(review.render(24)[1]).toContain("第 2/3 页");
    review.handleInput?.("p");
    review.render(24);
    review.handleInput?.("f");
    review.render(24);
    review.handleInput?.("b");
    review.render(24);
    review.handleInput?.("y");
    expect(review.render(24)[1]).toContain("第 2/3 页");
    review.handleInput?.("\u001b");
    expect(done.mock.calls).toEqual([["cancelled"]]);
    expect(env.keybindings.getResolvedBindings()).toEqual(bindings);
    const otherDone = vi.fn();
    createScopeReview("", env, otherDone).handleInput?.("q");
    expect(otherDone.mock.calls).toEqual([["cancelled"]]);
  });

  it("disabled configured actions do not complete; fixed Esc remains usable", () => {
    const env = environment();
    env.keybindings.setUserBindings({ "tui.select.confirm": [], "tui.select.up": [] });
    const done = vi.fn();
    const review = createScopeReview("one page", env, done);
    expect(review.render(24).at(-1)).toBe("继续作答: 未绑定");
    review.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    review.handleInput?.("\u001b");
    expect(done.mock.calls).toEqual([["cancelled"]]);
  });

  it("reapplies the injected theme after invalidate instead of caching ANSI", () => {
    const env = environment();
    vi.mocked(env.theme.fg).mockImplementation((_color, text) => `\u001b[31m${text}\u001b[39m`);
    const text = "unchanged text";
    const review = createScopeReview(text, Object.freeze(env), vi.fn());
    expect(review.render(24)[0]).toContain("\u001b[31m");
    vi.mocked(env.theme.fg).mockImplementation((_color, value) => `\u001b[32m${value}\u001b[39m`);
    review.invalidate();
    const lines = review.render(24);
    expect(lines[0]).toContain("\u001b[32m");
    expect(lines.join("")).not.toContain("\u001b[31m");
    expect(body(lines).map(stripTerminalSequences).join("")).toBe("unchanged·text");
    expect(text).toBe("unchanged text");
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
    review.dispose();
  });

  it("escapes a base+spacing-mark grapheme wider than the minimum viewport", () => {
    const text = "a" + "\u093E".repeat(24);
    const review = createScopeReview(text, environment(), vi.fn());
    const pages = allPages(review, 24);
    const expected = "\\u{61}" + "\\u{93E}".repeat(24);
    expect(pages.join("")).toBe(expected);
    expect(pages.every((line) => visibleWidth(line) <= 24)).toBe(true);
    review.dispose();
  });

  it("escapes an orphan spacing-mark cluster wider than the minimum viewport", () => {
    const text = "\u093E".repeat(25);
    const review = createScopeReview(text, environment(), vi.fn());
    const pages = allPages(review, 24);
    expect(pages.join("")).toBe("\\u{93E}".repeat(25));
    expect(pages.every((line) => visibleWidth(line) <= 24)).toBe(true);
    review.dispose();
  });

  it("reflows oversized escaped graphemes when resizing from wider to 24", () => {
    const text = "a" + "\u093E".repeat(24);
    const review = createScopeReview(text, environment(), vi.fn());
    const widePages = allPages(review, 80);
    expect(widePages.every((line) => visibleWidth(line) <= 80)).toBe(true);
    const narrowPages = allPages(review, 24);
    expect(narrowPages.join("")).toBe(widePages.join(""));
    expect(narrowPages.every((line) => visibleWidth(line) <= 24)).toBe(true);
    review.dispose();
  });
});
