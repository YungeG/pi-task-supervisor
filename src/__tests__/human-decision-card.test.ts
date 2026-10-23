import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { DecisionCard, isDecisionDraft, type DecisionDraft } from "../human-decision-card";
import { requireNativeAnswer, type NativeQuestion } from "../human-ui";
import { createMockContext, createMockTheme } from "./helpers/mocks";

const ENTER = "\r",
  ESC = "\u001b",
  DOWN = "\u001b[B",
  F2 = "\u001bOQ",
  F3 = "\u001bOR",
  F4 = "\u001bOS",
  TAB = "\t";
function question(kind: NativeQuestion["kind"] = "authorization"): NativeQuestion {
  return {
    kind,
    title: "怎样处理候选？",
    body: "完整原文：只读本地，禁止安装。\n".repeat(10),
    frame: {
      version: 1,
      owner: "board",
      sessionId: "test-session",
      requestId: "r",
      presentationId: "p",
      scopeDigest: "a".repeat(64),
      baseSnapshotEntryId: "base",
      baseSnapshotDigest: "b".repeat(64),
    },
    options: kind === "choice" ? [" A ", "稍后决定"] : undefined,
    material: {
      context: "候选决策",
      summary: ["范围：只读本地", "风险：不运行命令；禁止安装"],
      sections: [{ title: "范围", markdown: "## 关键范围\n\n- **只读本地**\n- 不安装" }],
    },
    ...(kind === "information"
      ? { informationFormat: "integer", informationValidator: (v: string) => /^\d+$/.test(v) }
      : {}),
  };
}
function environment(rows = 26) {
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_c, s) => s);
  vi.mocked(theme.bold).mockImplementation((s) => s);
  return { theme, keybindings: new KeybindingsManager(), rows: () => rows, requestRender: vi.fn() };
}
const text = (card: DecisionCard, width = 100) =>
  card.render(width).map(stripTerminalSequences).join("\n");
function review(card: DecisionCard, width = 100) {
  for (let i = 0; i < 200; i++) {
    const page = text(card, width);
    if (page.includes("需要你回应")) return;
    expect(page).toContain("只读核对");
    card.handleInput(ENTER);
  }
  throw new Error("scope did not finish");
}
beforeEach(() => {
  initTheme("dark", false);
});

describe("actual same-screen decision host", () => {
  it.each([ENTER, ESC, "m", "r"])(
    "B returns without submitting on %j and never becomes a blank raw placeholder",
    (key) => {
      const done = vi.fn();
      const q = question();
      const card = new DecisionCard(q, q.body, environment(), done);
      text(card);
      card.handleInput(DOWN);
      text(card);
      card.handleInput(F4);
      text(card);
      card.handleInput(key);
      expect(text(card)).toContain("需要你回应");
      expect(text(card)).toContain("→ 允许上述范围");
      expect(done).not.toHaveBeenCalled();
      card.dispose();
    },
  );
  it("injected native navigation wins over m and function-key display shortcuts", () => {
    const done = vi.fn();
    const q = question();
    const env = environment();
    env.keybindings.setUserBindings({ "tui.select.down": "m", "tui.select.up": "f2" });
    const card = new DecisionCard(q, q.body, env, done);
    text(card);
    card.handleInput("m");
    expect(text(card)).toContain("→ 允许上述范围");
    card.handleInput(F2);
    expect(text(card)).toContain("→ 稍后决定");
    expect(done).not.toHaveBeenCalled();
    card.dispose();
  });
  it.each(["authorization", "choice", "information"] as const)(
    "shows formatted context, risk and real %s controls initially",
    (kind) => {
      const done = vi.fn();
      const card = new DecisionCard(question(kind), "ORIGINAL", environment(), done);
      const first = text(card);
      expect(first).toContain("需要你回应");
      expect(first).toContain("怎样处理候选？");
      expect(first).toContain("关键范围");
      expect(first).toContain("风险：不运行命令");
      expect(first).toContain(kind === "information" ? "填写信息" : "稍后决定（不提交）");
      expect(first).not.toContain("**只读本地**");
      expect(first).not.toContain("只读核对（非作答）");
      expect(done).not.toHaveBeenCalled();
      card.dispose();
    },
  );
  it("requires full source coverage and another explicit submission; a draft is never a native answer", () => {
    const q = question();
    const done = vi.fn();
    const card = new DecisionCard(q, q.body, environment(), done);
    for (let i = 0; i < 10; i++) card.handleInput(ENTER);
    expect(done).not.toHaveBeenCalled();
    text(card);
    card.handleInput(DOWN);
    text(card);
    card.handleInput(ENTER);
    review(card);
    expect(done).not.toHaveBeenCalled();
    expect(text(card)).toContain("完整原文已核对");
    card.handleInput(ENTER);
    const draft = done.mock.calls[0]?.[0] as DecisionDraft;
    expect(isDecisionDraft(draft, q)).toBe(true);
    expect(isDecisionDraft({ ...draft }, q)).toBe(false);
    expect(isDecisionDraft(draft, { ...q })).toBe(false);
    expect(() => requireNativeAnswer(createMockContext(), draft, q.frame)).toThrow(
      "Unrecognized native answer",
    );
    expect(card.render(100)).toEqual([]);
    card.handleInput(ENTER);
    expect(done).toHaveBeenCalledOnce();
  });
  it("retains a choice draft across B and returns to the exact selected original value", () => {
    const q = question("choice");
    const done = vi.fn();
    const card = new DecisionCard(q, q.body, environment(), done);
    text(card);
    card.handleInput(DOWN);
    text(card);
    card.handleInput(F4);
    expect(text(card)).toContain("格式化浏览");
    card.handleInput(ESC);
    expect(text(card)).toContain('→ 选项 1 · " A "');
    card.handleInput(ENTER);
    review(card);
    card.handleInput(ENTER);
    expect(done.mock.calls[0]?.[0]).toMatchObject({ kind: "choice", index: 1 });
  });
  it("keeps information draft and IME focus through readonly reading, including a literal m", () => {
    const q = { ...question("information"), informationValidator: () => true };
    const done = vi.fn();
    const card = new DecisionCard(q, q.body, environment(), done);
    card.focused = true;
    expect(card.render(100).join("")).toContain(CURSOR_MARKER);
    card.handleInput("12m");
    text(card);
    card.handleInput(F4);
    expect(card.render(100).join("")).not.toContain(CURSOR_MARKER);
    card.handleInput(ESC);
    expect(text(card)).toContain("12m");
    expect(card.render(100).join("")).toContain(CURSOR_MARKER);
    card.handleInput(ENTER);
    review(card);
    card.handleInput(ENTER);
    expect(done.mock.calls[0]?.[0]).toMatchObject({ kind: "information", value: "12m" });
  });
  it("clears rejected values, including native undo state, instead of echoing them in errors", () => {
    const done = vi.fn();
    const q = question("information");
    const card = new DecisionCard(q, q.body, environment(), done);
    text(card);
    card.handleInput("SENSITIVE_BAD_VALUE");
    text(card);
    card.handleInput(ENTER);
    expect(text(card)).toContain("未保存");
    expect(text(card)).not.toContain("SENSITIVE_BAD_VALUE");
    for (const key of ["\u001f", "\u001b[45;5u", "\u0019"]) {
      card.handleInput(key);
      expect(text(card)).not.toContain("SENSITIVE_BAD_VALUE");
    }
    expect(done).not.toHaveBeenCalled();
    card.handleInput(ESC);
    expect(done.mock.calls).toEqual([[undefined]]);
  });
  it("C contains actual answer controls beside the source and can review without leaving the card", () => {
    const q = question("information");
    const done = vi.fn();
    const card = new DecisionCard(q, q.body, environment(), done);
    text(card, 120);
    card.handleInput("42");
    text(card, 120);
    card.handleInput(F3);
    const split = text(card, 120);
    expect(split).toContain("│");
    expect(split).toContain("填写信息");
    expect(split).toContain("42");
    expect(split).toContain("只读核对");
    card.handleInput(TAB);
    text(card, 120);
    for (let i = 0; i < 100 && !text(card, 120).includes("完整原文已核对"); i++) {
      card.handleInput(ENTER);
      text(card, 120);
    }
    expect(text(card, 120)).toContain("C 双栏");
    expect(done).not.toHaveBeenCalled();
    card.handleInput(ENTER);
    expect(done.mock.calls[0]?.[0]).toMatchObject({ value: "42" });
  });
  it("reflows C safely and retains the input, but does not carry source coverage into new geometry", () => {
    const q = question("information");
    const done = vi.fn();
    const card = new DecisionCard(q, q.body, environment(), done);
    text(card, 120);
    card.handleInput("42");
    text(card, 120);
    card.handleInput(F3);
    text(card, 120);
    expect(text(card, 60)).not.toContain("│");
    expect(text(card, 60)).toContain("42");
    card.handleInput(ENTER);
    expect(text(card, 60)).toContain("只读核对");
    expect(done).not.toHaveBeenCalled();
    card.dispose();
  });
  it("first-start draft cannot accidentally select the canonical Later option", () => {
    const q = {
      ...question("choice"),
      purpose: "first-start" as const,
      options: ["Later", "Start execution"],
    };
    const done = vi.fn();
    const card = new DecisionCard(q, q.body, environment(), done);
    text(card);
    card.handleInput(DOWN);
    text(card);
    card.handleInput(ENTER);
    review(card);
    card.handleInput(ENTER);
    expect(done.mock.calls[0]?.[0]).toMatchObject({ kind: "choice", index: 2 });
  });
  it("cancel/defer is silent and no object is minted without source review", () => {
    for (const cancel of [ENTER, ESC]) {
      const done = vi.fn();
      const card = new DecisionCard(question(), "ORIGINAL", environment(), done);
      text(card);
      card.handleInput(cancel);
      card.handleInput(ENTER);
      expect(done.mock.calls).toEqual([[undefined]]);
    }
  });
  it.each([0, 1, 23, 24, 40, 99, 100, 120, NaN, Infinity])(
    "bounds focused output and all surfaces at width %s",
    (width) => {
      const done = vi.fn();
      const card = new DecisionCard(
        question("information"),
        "中文🙂".repeat(80),
        environment(),
        done,
      );
      card.focused = true;
      const bound = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
      for (const key of ["", F3, F4, ESC, F2]) {
        if (key) card.handleInput(key);
        const lines = card.render(width);
        expect(lines.length).toBeLessThanOrEqual(26);
        expect(lines.every((line) => visibleWidth(line) <= bound)).toBe(true);
      }
      expect(done.mock.calls.every((call) => call[0] === undefined)).toBe(true);
      card.dispose();
    },
  );
  it.each([0, 1, 7, 8, 10, NaN, Infinity])("cannot submit in a %s-row viewport", (rows) => {
    const done = vi.fn();
    const card = new DecisionCard(question(), "ORIGINAL", environment(rows), done);
    text(card);
    for (const key of [DOWN, ENTER, F3, ENTER]) card.handleInput(key);
    expect(done).not.toHaveBeenCalled();
    card.handleInput(ESC);
    expect(done).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
