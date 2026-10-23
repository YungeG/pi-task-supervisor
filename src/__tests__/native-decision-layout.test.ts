import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { createScopeReview } from "../human-scope-view";
import { createMockTheme } from "./helpers/mocks";

vi.mock("@earendil-works/pi-tui", async (original) => original());
const ENTER = "\r",
  ESC = "\u001b",
  DOWN = "\u001b[B",
  TAB = "\t";
const material = {
  context: "候选审阅",
  sections: [
    {
      title: "补充材料",
      markdown: "## 原生 Markdown\n\n- **风险说明**\n\n```ts\nconst dryRun = true;\n```",
    },
  ],
};
function environment(rows = 16) {
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, text) => text);
  vi.mocked(theme.bold).mockImplementation((text) => text);
  return { theme, keybindings: new KeybindingsManager(), rows: () => rows, requestRender: vi.fn() };
}
const text = (view: ReturnType<typeof createScopeReview>, width = 80) =>
  view.render(width).map(stripTerminalSequences).join("\n");
beforeEach(() => {
  initTheme("dark", false);
});

describe("native A/B/C decision reading", () => {
  it("starts with canonical A and completes a short review once without a formatted detour", () => {
    const done = vi.fn();
    const view = createScopeReview("EXACT_SCOPE_NOT_SUMMARY", environment(), done, material);
    expect(text(view)).toContain("EXACT_SCOPE_NOT_SUMMARY");
    expect(text(view)).not.toContain("const dryRun");
    view.handleInput?.(ENTER);
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
    expect(view.render(80)).toEqual([]);
  });
  it("uses the available height rather than a hard 18-line ceiling", () => {
    const view = createScopeReview(
      Array.from({ length: 40 }, (_, i) => `line_${i}`).join("\n"),
      environment(50),
      vi.fn(),
      material,
    );
    expect(text(view)).toContain("line_39");
    expect(view.render(80).length).toBeLessThanOrEqual(50);
    view.dispose();
  });
  it("B is optional Markdown reading; Enter or Esc only returns to A", () => {
    const done = vi.fn();
    const view = createScopeReview("CANONICAL", environment(), done, material);
    text(view);
    view.handleInput?.("m");
    expect(text(view)).toContain("const dryRun = true;");
    expect(text(view)).toContain("原生 Markdown");
    view.handleInput?.(ENTER);
    expect(done).not.toHaveBeenCalled();
    expect(text(view)).toContain("CANONICAL");
    view.handleInput?.("m");
    text(view);
    view.handleInput?.(ESC);
    expect(done).not.toHaveBeenCalled();
    expect(text(view)).toContain("CANONICAL");
    view.handleInput?.(ESC);
    expect(done).toHaveBeenCalledExactlyOnceWith("cancelled");
  });
  it("returning from B preserves canonical page and cannot supply canonical coverage", () => {
    const done = vi.fn();
    const raw = Array.from({ length: 30 }, (_, i) => `SOURCE_${i}`).join("\n");
    const view = createScopeReview(raw, environment(12), done, material);
    text(view);
    view.handleInput?.(ENTER);
    expect(text(view)).toContain("第 2/");
    view.handleInput?.("m");
    text(view);
    view.handleInput?.(ENTER);
    expect(text(view)).toContain("第 2/");
    expect(done).not.toHaveBeenCalled();
    for (let i = 0; i < 50 && !done.mock.calls.length; i++) {
      text(view);
      view.handleInput?.(ENTER);
    }
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
  });
  it("C is explicit and wide-only, with canonical text and material in separate columns", () => {
    const done = vi.fn();
    const view = createScopeReview("CANONICAL_SOURCE", environment(), done, material);
    text(view, 120);
    view.handleInput?.(TAB);
    const columns = view.render(120);
    expect(columns.join("\n")).toContain("│");
    expect(columns.join("\n")).toContain("CANONICAL_SOURCE");
    expect(columns.join("\n")).toContain("补充材料");
    expect(columns.every((line) => visibleWidth(line) <= 120)).toBe(true);
    expect(done).not.toHaveBeenCalled();
    const narrow = text(view, 60);
    expect(narrow).toContain("CANONICAL_SOURCE");
    expect(narrow).not.toContain("│");
    view.handleInput?.(TAB);
    expect(text(view, 60)).not.toContain("│");
    view.dispose();
  });
  it("does not count unrendered keys, material browsing or terminal reflow as review", () => {
    const done = vi.fn();
    let rows = 12;
    const view = createScopeReview(
      Array.from({ length: 30 }, (_, i) => `RAW_${i}`).join("\n"),
      { ...environment(), rows: () => rows },
      done,
      material,
    );
    for (let i = 0; i < 50; i++) view.handleInput?.(ENTER);
    expect(done).not.toHaveBeenCalled();
    text(view);
    view.handleInput?.("m");
    text(view);
    for (let i = 0; i < 50; i++) view.handleInput?.(DOWN);
    expect(done).not.toHaveBeenCalled();
    view.handleInput?.(ESC);
    text(view);
    rows = 8;
    view.handleInput?.(ENTER);
    expect(done).not.toHaveBeenCalled();
    expect(text(view)).toContain("第 1/");
    view.dispose();
  });
  it("honors rebound native actions before fixed material shortcuts", () => {
    const done = vi.fn();
    const env = environment();
    env.keybindings.setUserBindings({ "tui.select.confirm": "m" });
    const view = createScopeReview("EXACT", env, done, material);
    text(view);
    view.handleInput?.("m");
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
  });
  it("makes tiny viewports cancel-only in every surface", () => {
    for (const rows of [0, 1, 7]) {
      const done = vi.fn();
      const view = createScopeReview("EXACT", environment(rows), done, material);
      text(view);
      view.handleInput?.("m");
      view.handleInput?.(TAB);
      view.handleInput?.(ENTER);
      expect(done).not.toHaveBeenCalled();
      view.handleInput?.(ESC);
      expect(done).toHaveBeenCalledExactlyOnceWith("cancelled");
    }
  });

  it.each(["card", "material", "split"])(
    "bounds %s with hostile text across narrow and wide geometries",
    (surface) => {
      for (const width of [0, 1, 23, 24, 40, 99, 100, 120, NaN, Infinity]) {
        const done = vi.fn();
        const view = createScopeReview(
          "中文🙂\u001b]52;c;BAD\u0007\u202e".repeat(20),
          environment(),
          done,
          {
            context: "上下文\u202e",
            sections: [
              { title: "长标题".repeat(50), markdown: "中文🙂\u001b[31m\u202e".repeat(80) },
            ],
          },
        );
        view.render(width);
        if (surface === "material") view.handleInput?.("m");
        if (surface === "split") view.handleInput?.(TAB);
        const lines = view.render(width);
        const bound = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
        expect(lines.every((line) => visibleWidth(line) <= bound)).toBe(true);
        expect(lines.length).toBeLessThanOrEqual(16);
        expect(lines.join("\n")).not.toContain("\u001b]52");
        expect(lines.join("\n")).not.toContain("\u202e");
        expect(done).not.toHaveBeenCalled();
        view.dispose();
      }
    },
  );
  it("material page and split origin survive optional reading without changing canonical coverage", () => {
    const done = vi.fn();
    const view = createScopeReview("ORIGINAL\n".repeat(50), environment(), done, {
      context: "长材料",
      sections: [{ title: "材料", markdown: "line\n".repeat(80) }],
    });
    text(view, 120);
    view.handleInput?.(TAB);
    text(view, 120);
    view.handleInput?.("m");
    text(view, 120);
    view.handleInput?.(DOWN);
    expect(text(view, 120)).toContain("第 2/");
    view.handleInput?.(ESC);
    expect(text(view, 120)).toContain("│");
    view.handleInput?.("m");
    expect(text(view, 120)).toContain("第 2/");
    view.handleInput?.(ENTER);
    text(view, 120);
    view.handleInput?.(TAB);
    for (let i = 0; i < 30; i++) view.handleInput?.(ENTER);
    expect(done).not.toHaveBeenCalled();
    view.dispose();
  });
  it("Home/End can locate B material but never supply canonical coverage", () => {
    const done = vi.fn();
    const view = createScopeReview("CANONICAL\n".repeat(20), environment(), done, {
      context: "long",
      sections: [{ title: "long", markdown: "line\n".repeat(50) }],
    });
    text(view);
    view.handleInput?.("m");
    text(view);
    view.handleInput?.("\u001b[F");
    expect(text(view)).not.toContain("第 1/");
    view.handleInput?.("\u001b[H");
    expect(text(view)).toContain("第 1/");
    view.handleInput?.(ENTER);
    for (let i = 0; i < 50; i++) view.handleInput?.(ENTER);
    expect(done).not.toHaveBeenCalled();
    view.dispose();
  });
  it.each(["r", "tab"] as const)("does not shadow native confirmation bound to %j", (binding) => {
    const done = vi.fn();
    const env = environment();
    env.keybindings.setUserBindings({ "tui.select.confirm": binding });
    const view = createScopeReview("SOURCE", env, done, material);
    text(view, 120);
    view.handleInput?.(binding === "tab" ? TAB : binding);
    expect(done).toHaveBeenCalledExactlyOnceWith("reviewed");
  });
  it("dispose and repeated keys cannot revive B or emit another completion", () => {
    const done = vi.fn();
    const view = createScopeReview("SOURCE", environment(), done, material);
    text(view);
    view.handleInput?.("m");
    text(view);
    view.dispose();
    view.invalidate();
    for (const key of [ENTER, ESC, "m", TAB]) view.handleInput?.(key);
    expect(view.render(120)).toEqual([]);
    expect(done).not.toHaveBeenCalled();
  });
});
