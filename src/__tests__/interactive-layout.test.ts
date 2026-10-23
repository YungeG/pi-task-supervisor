import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createScopeReview } from "../human-scope-view";
import { createMockTheme } from "./helpers/mocks";

vi.mock("@earendil-works/pi-tui", async (original) => original());

function environment() {
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_role, text) => text);
  vi.mocked(theme.bold).mockImplementation((text) => text);
  return { theme, keybindings: new KeybindingsManager(), rows: () => 14, requestRender: vi.fn() };
}
beforeEach(() => {
  initTheme("dark", false);
});

function formattedPages(view: ReturnType<typeof createScopeReview>, width: number): string[][] {
  const pages: string[][] = [];
  view.render(width);
  view.handleInput?.("m");
  let previous = "";
  for (let i = 0; i < 200; i++) {
    const lines = view.render(width).map(stripTerminalSequences);
    const key = lines.join("\n");
    if (key === previous) return pages;
    pages.push(lines);
    previous = key;
    view.handleInput?.("\u001b[B");
  }
  throw new Error("Formatted material did not reach its end");
}

const material = {
  context: "请核对这份离线示例",
  sections: [{ title: "代码示例", markdown: "```ts\nconst answer = {\n  dryRun: true,\n};\n```" }],
};

describe("interactive material layout through the existing reader", () => {
  it("starts with canonical review and needs no mandatory formatted detour", () => {
    initTheme("dark", false);
    const done = vi.fn();
    const view = createScopeReview("ORIGINAL_REVIEW_SENTINEL", environment(), done, material);
    const first = view.render(80).map(stripTerminalSequences).join("\n");
    expect(first).not.toContain("格式化浏览");
    expect(first).toContain("ORIGINAL_REVIEW_SENTINEL");
    expect(first).toContain("m 材料");
    expect(done).not.toHaveBeenCalled();
    view.handleInput?.("\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
    view.dispose();
  });

  it("keeps a complete short code block together rather than cutting it at a page boundary", () => {
    const done = vi.fn();
    const view = createScopeReview("RAW_REQUIRED", environment(), done, {
      context: "代码范围",
      sections: [
        {
          title: "允许范围",
          markdown:
            "一段说明。\n\n```bash\nnpm run typecheck\n```\n\n```ts\nconst config = {\n  dryRun: true,\n};\n```",
        },
      ],
    });
    const pages = formattedPages(view, 80).map((lines) => lines.join("\n"));
    expect(
      pages.some(
        (page) =>
          page.includes("```ts") &&
          page.includes("const config = {") &&
          page.includes("  dryRun: true") &&
          page.includes("};"),
      ),
    ).toBe(true);
    expect(done).not.toHaveBeenCalled();
    view.dispose();
  });

  it("keeps section headings with their body and repeats context while long code continues", () => {
    const done = vi.fn();
    const view = createScopeReview("RAW_REQUIRED", environment(), done, {
      context: "代码范围",
      sections: [
        { title: "目标", markdown: "短目标" },
        {
          title: "允许范围",
          markdown: `\u0060\u0060\u0060ts\n${Array.from({ length: 25 }, (_, i) => `const line${i} = ${i};`).join("\n")}\n\u0060\u0060\u0060`,
        },
        { title: "禁止事项", markdown: "不执行示例" },
      ],
    });
    const pages = formattedPages(view, 40);
    const text = pages.flat().join("\n");
    expect(text).toContain("允许范围（续）");
    expect(text).toContain("const line0 = 0;");
    expect(text).toContain("const line24 = 24;");
    expect(text).toContain("禁止事项");
    expect(pages.every((lines) => lines.length <= 14)).toBe(true);
    expect(
      pages.every(
        (lines) => !["允许范围", "禁止事项", "允许范围（续）"].includes(lines.at(-3) ?? ""),
      ),
    ).toBe(true);
    expect(done).not.toHaveBeenCalled();
    view.dispose();
  });

  it("cannot replace actual full raw review with End or undisplayed key presses", () => {
    const done = vi.fn();
    const raw = Array.from({ length: 40 }, (_, i) => `RAW_LINE_${i}`).join("\n");
    const view = createScopeReview(raw, environment(), done, material);
    view.handleInput?.("r");
    expect(done).not.toHaveBeenCalled();
    view.render(80);
    view.handleInput?.("r");
    expect(view.render(80).join("\n")).toContain("RAW_LINE_0");
    for (let i = 0; i < 100; i++) view.handleInput?.("\u001b[F");
    expect(done).not.toHaveBeenCalled();
    for (let i = 0; i < 100; i++) view.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    const seen: string[] = [];
    for (let i = 0; i < 100 && !done.mock.calls.length; i++) {
      seen.push(view.render(80).join("\n"));
      view.handleInput?.("\r");
    }
    expect(seen.join("\n")).toContain("RAW_LINE_39");
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
    view.dispose();
  });

  it.each(["formatted", "raw"])("cancels %s mode once and never produces reviewed", (mode) => {
    const done = vi.fn();
    const view = createScopeReview("RAW", environment(), done, material);
    view.render(80);
    if (mode === "formatted") {
      view.handleInput?.("m");
      view.render(80);
      view.handleInput?.("\u001b");
      expect(done).not.toHaveBeenCalled();
      view.render(80);
    }
    view.handleInput?.("\u001b");
    view.handleInput?.("\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("cancelled");
    expect(view.render(80)).toEqual([]);
    view.dispose();
  });

  it("resets both layouts and prior raw progress after an actual viewport change", () => {
    let rows = 14;
    const done = vi.fn();
    const view = createScopeReview(
      Array.from({ length: 30 }, (_, i) => `RAW_${i}`).join("\n"),
      { ...environment(), rows: () => rows },
      done,
      material,
    );
    view.render(80);
    view.handleInput?.("r");
    view.render(80);
    view.handleInput?.("\r");
    view.render(80);
    rows = 10;
    view.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    const resized = view.render(40);
    expect(resized[1]).toContain("第 1/");
    expect(resized.join("\n")).toContain("RAW_0");
    expect(resized.length).toBeLessThanOrEqual(10);
    view.dispose();
    expect(view.render(80)).toEqual([]);
  });

  it.each([0, 1, 8, 23, 24, 32, 40, 80, 120, NaN, Infinity, -1])(
    "bounds material geometry at width %s",
    async (width) => {
      const { visibleWidth } = await import("@earendil-works/pi-tui");
      const done = vi.fn();
      const view = createScopeReview("RAW", environment(), done, {
        context: "中🙂",
        sections: [
          { title: "中🙂".repeat(60), markdown: "中🙂\u001b]52;c;payload\u0007\u202e".repeat(20) },
        ],
      });
      const lines = view.render(width);
      const bound = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      expect(lines.every((line) => visibleWidth(line) <= bound)).toBe(true);
      expect(lines.join("\n")).not.toContain("\u001b]52");
      expect(lines.join("\n")).not.toContain("\u202e");
      expect(lines.length).toBeLessThanOrEqual(14);
      expect(done).not.toHaveBeenCalled();
      view.dispose();
    },
  );

  it.each([0, 1, 7])("is cancel-only in a %s-row viewport", (rows) => {
    const done = vi.fn();
    const view = createScopeReview("RAW", { ...environment(), rows: () => rows }, done, material);
    expect(view.render(80).join("\n")).not.toContain("dryRun");
    view.handleInput?.("\r");
    view.handleInput?.("r");
    expect(done).not.toHaveBeenCalled();
    view.handleInput?.("\u001b");
    expect(done).toHaveBeenCalledExactlyOnceWith("cancelled");
    view.dispose();
  });

  it("captures material inputs and prepares native syntax before deferred renders", () => {
    const input = {
      context: "原始问题",
      sections: [
        {
          title: "代码",
          markdown: "\u0060\u0060\u0060ts\nconst original = 1;\n\u0060\u0060\u0060",
        },
      ],
    };
    const view = createScopeReview("RAW", environment(), vi.fn(), input);
    input.sections[0]!.markdown = "MUTATED_OWNER_VALUE";
    view.render(80);
    view.handleInput?.("m");
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Deferred render read wall clock");
    });
    try {
      expect(view.render(80).map(stripTerminalSequences).join("\n")).toContain(
        "const original = 1;",
      );
      view.invalidate();
      const resized = view.render(40).map(stripTerminalSequences).join("\n");
      expect(resized).toContain("const original = 1;");
      expect(resized).not.toContain("MUTATED_OWNER_VALUE");
    } finally {
      now.mockRestore();
      view.dispose();
    }
  });

  it("renders native headings, lists, emphasis and links without bypassing original text", () => {
    const done = vi.fn();
    const view = createScopeReview("ORIGINAL_WITH_LINK_AND_MARKUP", environment(), done, {
      context: "格式样例",
      sections: [
        {
          title: "原生格式",
          markdown: "## 小标题\n\n- **必需**\n- *提示*\n\n[资料](https://example.invalid)",
        },
      ],
    });
    const text = formattedPages(view, 80).flat().join("\n");
    expect(text).toContain("小标题");
    expect(text).toContain("必需");
    expect(text).toContain("提示");
    expect(text).toContain("资料");
    expect(done).not.toHaveBeenCalled();
    view.dispose();
  });

  it("shows and honors actual rebound native keys in formatted and exact-source steps", () => {
    const done = vi.fn();
    const env = {
      ...environment(),
      keybindings: new KeybindingsManager({
        "tui.select.confirm": "ctrl+x",
        "tui.select.up": "ctrl+p",
        "tui.select.down": "ctrl+n",
      }),
    };
    const view = createScopeReview("RAW_REQUIRED", env, done, material);
    view.render(80);
    view.handleInput?.("m");
    const first = view.render(80).join("\n");
    expect(first).toContain("ctrl+x");
    expect(first).toContain("ctrl+p");
    expect(first).not.toContain("Enter 原文核对");
    view.handleInput?.("\u0018");
    expect(done).not.toHaveBeenCalled();
    expect(view.render(80).join("\n")).toContain("RAW_REQUIRED");
    view.handleInput?.("\u0018");
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
    view.dispose();
  });

  it("handles empty display material without treating it as original review", () => {
    const done = vi.fn();
    const view = createScopeReview("RAW_REQUIRED", environment(), done, {
      context: "",
      sections: [],
    });
    view.render(80);
    view.handleInput?.("m");
    expect(view.render(80).join("\n")).toContain("未提供格式化材料");
    view.handleInput?.("\r");
    expect(done).not.toHaveBeenCalled();
    expect(view.render(80).join("\n")).toContain("RAW_REQUIRED");
    view.handleInput?.("\r");
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
    view.dispose();
  });
});
