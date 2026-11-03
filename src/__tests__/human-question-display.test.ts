import { expect, it, vi } from "vitest";
import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  stripTerminalSequences,
  visibleWidth,
  type Component,
  Input,
  CURSOR_MARKER,
} from "@earendil-works/pi-tui";
import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApprovalReview } from "../approval-review";
import { KeybindingsManager as AppKeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import type { NativeQuestion } from "../human-ui";
import { reviewScope } from "../human-ui";
import { frameQuestion } from "../human-question-frame";
import { createMockContext, createMockTheme } from "./helpers/mocks";

function builtinTheme(name: string): Theme {
  const root = dirname(
    dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))),
  );
  const raw = JSON.parse(
    readFileSync(join(root, "dist/modes/interactive/theme", name + ".json"), "utf8"),
  ) as { vars: Record<string, string | number>; colors: Record<string, string | number> };
  const colors = Object.entries(raw.colors).map(
    ([key, value]) => [key, raw.vars[value] ?? value] as const,
  );
  const backgrounds = new Set([
    "selectedBg",
    "searchMatchBg",
    "userMessageBg",
    "customMessageBg",
    "toolPendingBg",
    "toolSuccessBg",
    "toolErrorBg",
  ]);
  return new Theme(
    Object.fromEntries(colors.filter(([key]) => !backgrounds.has(key))) as ConstructorParameters<
      typeof Theme
    >[0],
    Object.fromEntries(colors.filter(([key]) => backgrounds.has(key))) as ConstructorParameters<
      typeof Theme
    >[1],
    "truecolor",
  );
}
function luminance(ansi: string): number {
  const numbers = ansi.match(/\d+/gu)!.map(Number).slice(2, 5);
  expect(numbers).toHaveLength(3);
  return numbers.reduce((sum, v, i) => {
    const normalized = v / 255;
    return (
      sum +
      (normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4) *
        ([0.2126, 0.7152, 0.0722][i] ?? 0)
    );
  }, 0);
}
it.each(["dark", "light"])(
  "keeps a real %s theme question border visibly distinct from its filled background",
  (name) => {
    const theme = builtinTheme(name),
      fg = luminance(theme.getFgAnsi("borderAccent")),
      bg = luminance(theme.getBgAnsi("userMessageBg"));
    expect((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)).toBeGreaterThanOrEqual(3);
    const question: NativeQuestion = {
      frame: {
        version: 1,
        owner: "board",
        sessionId: "visual-only",
        requestId: "visual-only",
        presentationId: "visual-only",
        scopeDigest: "a".repeat(64),
        baseSnapshotEntryId: "base",
        baseSnapshotDigest: "b".repeat(64),
      },
      kind: "authorization",
      purpose: "approval-bundle",
      title: "是否允许本次明确范围？（隔离视觉样本）",
      body: "目标：只读核对当前示例，不操作任何业务会话。\n\n范围：仅查看本机临时目录里的测试材料。\n\n禁止：网络、下单、发布、修改真实业务数据。\n\n本页使用完整边框、独立底色与固定可见的按键提示。\n\n批准不是 Start，阅读和渲染都不会批准。",
      approval: {
        permissions: [{ id: "A1", label: "只读查看隔离测试材料", required: true }],
        selectedIds: ["A1"],
      },
    };
    const finished = vi.fn(),
      inner = new ApprovalReview(
        question,
        {
          theme,
          keybindings: new AppKeybindingsManager(),
          rows: () => 33,
          requestRender: vi.fn(),
        },
        finished,
      ),
      panel = frameQuestion(inner, theme),
      rows = panel.render(114);
    expect(rows.every((row) => visibleWidth(row) === 114)).toBe(true);
    expect(rows[0]).toContain(theme.getFgAnsi("borderAccent"));
    expect(rows.every((row) => row.includes(theme.getBgAnsi("userMessageBg")))).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    if (process.env.PI_UI_VISUAL_OUT) {
      mkdirSync(process.env.PI_UI_VISUAL_OUT, { recursive: true });
      writeFileSync(
        join(process.env.PI_UI_VISUAL_OUT, `question-${name}.json`),
        JSON.stringify({
          theme: name,
          width: 114,
          rows,
          contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
        }),
      );
    }
  },
);

it("puts the actual readonly question in a visibly separated, bounded panel, without confirming on render", async () => {
  const ctx = createMockContext();
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation(
    (color, text) =>
      `\u001b[38;2;${color === "borderAccent" ? "210;160;255" : "225;225;225"}m${text}\u001b[39m`,
  );
  Object.assign(theme, {
    bg: vi.fn((_color: string, text: string) => `\u001b[48;2;30;40;65m${text}\u001b[49m`),
  });
  let selected: unknown;
  let calls = 0;
  Object.assign(ctx.ui, {
    custom: vi.fn(
      (
        factory: (
          tui: unknown,
          theme: Theme,
          keys: KeybindingsManager,
          done: (value: unknown) => void,
        ) => Component,
        options: unknown,
      ) =>
        new Promise((resolve) => {
          const component = factory(
            { terminal: { rows: 24 }, requestRender: vi.fn() },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            (value) => {
              selected = value;
              calls++;
              resolve(value);
            },
          );
          const rows = component.render(80),
            plain = rows.map(stripTerminalSequences);
          expect(plain[0]).toMatch(/^╭─.*╮$/u);
          expect(plain.at(-1)).toMatch(/^╰─.*╯$/u);
          expect(rows.join("\n")).toContain("\u001b[48;2;30;40;65m");
          expect(rows[0]).toContain("\u001b[38;2;210;160;255m");
          expect(plain.join("\n")).toContain("只读核对");
          expect(plain.join("\n")).toContain("Esc");
          expect(rows.length).toBeLessThanOrEqual(Math.floor(24 * 0.9));
          expect(rows.every((row) => visibleWidth(row) <= 80)).toBe(true);
          expect(options).toMatchObject({ overlay: true });
          expect(calls).toBe(0);
          component.handleInput?.("\u001b");
        }),
    ),
  });
  expect(
    await reviewScope(ctx as ExtensionContext, "原范围：只读材料，不代表批准。", () => true),
  ).toBe(false);
  expect(selected).toBe("cancelled");
  expect(calls).toBe(1);
});

it("forwards focus, typed information, Enter, invalidate and disposal to the original input only", () => {
  const input = new Input({ prompt: "> " }),
    submit = vi.fn(),
    invalidate = vi.fn(),
    dispose = vi.fn();
  input.onSubmit = submit;
  const content = {
    get focused() {
      return input.focused;
    },
    set focused(v: boolean) {
      input.focused = v;
    },
    render: (w: number) => input.render(w),
    handleInput: (d: string) => {
      input.handleInput(d);
    },
    invalidate,
    dispose,
  };
  const frame = frameQuestion(content, createMockTheme());
  frame.focused = true;
  expect(input.focused).toBe(true);
  expect(frame.focused).toBe(true);
  frame.handleInput?.("42");
  expect(frame.render(40).join("\n")).toContain(CURSOR_MARKER);
  frame.handleInput?.("\r");
  expect(submit).toHaveBeenCalledExactlyOnceWith("42");
  frame.focused = false;
  expect(input.focused).toBe(false);
  frame.invalidate();
  expect(invalidate).toHaveBeenCalledOnce();
  frame.dispose();
  frame.dispose();
  frame.handleInput?.("\r");
  expect(submit).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(frame.render(40)).toEqual([]);
});
it.each([0, 1, 5, 6, 24, 80, Number.NaN, Number.POSITIVE_INFINITY])(
  "keeps a narrow/invalid width %s bounded and still forwards Esc without confirming",
  (width) => {
    const input = vi.fn(),
      content = {
        render: (w: number) => (w ? ["x".repeat(w)] : []),
        handleInput: input,
        invalidate: vi.fn(),
        dispose: vi.fn(),
      };
    const frame = frameQuestion(content, createMockTheme());
    expect(frame.focused).toBe(false);
    frame.focused = true;
    const rows = frame.render(width);
    const bounded = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    expect(
      rows.every(
        (line) =>
          visibleWidth(
            stripTerminalSequences(line).replaceAll("[text]", "").replaceAll("[borderAccent]", ""),
          ) <= bounded,
      ),
    ).toBe(true);
    frame.handleInput?.("\u001b");
    expect(input).toHaveBeenCalledExactlyOnceWith("\u001b");
  },
);
it("restores the panel background after nested content resets", () => {
  const theme = createMockTheme(),
    bg = "\u001b[48;2;30;40;65m",
    fg = "\u001b[38;2;225;225;225m";
  vi.mocked(theme.getBgAnsi).mockReturnValue(bg);
  vi.mocked(theme.getFgAnsi).mockReturnValue(fg);
  const content = {
    render: () => ["a\u001b[0mb\u001b[49mc\u001b[39md"],
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
  const frame = frameQuestion(content, theme);
  expect(frame.render(40).join("\n")).toContain(
    "\u001b[0m" + bg + fg + "b\u001b[49m" + bg + "c\u001b[39m" + fg + "d",
  );
});
