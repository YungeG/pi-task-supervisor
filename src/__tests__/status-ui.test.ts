import { describe, expect, it } from "vitest";
import type { UiSummary, UiLine, UiScope, UiCounts, UiTaskSummary } from "../ui-view";
import { formatStatusbar } from "../status-ui";
import { visibleWidth } from "@earendil-works/pi-tui";

// ── Test Helpers ──

function makeScope(overrides: Partial<UiScope> = {}): UiScope {
  return {
    sessionId: "sess-1",
    leafId: "leaf-1",
    generation: 1,
    capturedAt: 1000,
    ...overrides,
  };
}

function makeLine(
  text: string,
  level: UiLine["level"] = "info",
  source: UiLine["source"] = "board",
): UiLine {
  return { text, source, level };
}

function makeCounts(overrides: Partial<UiCounts> = {}): UiCounts {
  return {
    total: 6,
    done: 2,
    abandoned: 0,
    unfinished: 4,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<UiSummary> = {}): UiSummary {
  return {
    scope: makeScope(),
    visible: true,
    goals: [],
    headline: makeLine("只读规划"),
    blockers: [],
    next: makeLine("尚无已确认的下一步，请查看状态"),
    counts: makeCounts(),
    tasks: [] as readonly UiTaskSummary[],
    acceptance: "尚未记录目标验收",
    ...overrides,
  };
}

// ── Representative RED/GREEN Cases ──

describe("formatStatusbar", () => {
  describe("RED: attention headline must appear as prefix, not as progress", () => {
    it("shows error headline as prefix before done count", () => {
      const summary = makeSummary({
        headline: makeLine("需检查", "error", "receipt"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).toMatch(/^需检查/);
      expect(result).toContain("已完成 2/6");
      expect(result).toContain("放弃 1");
    });

    it("shows warning headline as prefix", () => {
      const summary = makeSummary({
        headline: makeLine("确认或回应已保存，状态同步未完成", "warning", "repair"),
        counts: makeCounts({ done: 0, total: 3 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).toMatch(/^确认或回应已保存/);
      expect(result).toContain("已完成 0/3");
    });
  });

  describe("GREEN: basic formatting", () => {
    it("returns undefined when not visible", () => {
      const summary = makeSummary({ visible: false });
      expect(formatStatusbar(summary)).toBeUndefined();
    });

    it("shows done count without abandoned when abandoned=0", () => {
      const summary = makeSummary({
        counts: makeCounts({ done: 2, total: 6, abandoned: 0, unfinished: 4 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBe("只读规划 · 已完成 2/6");
    });

    it("shows abandoned separately when abandoned>0", () => {
      const summary = makeSummary({
        counts: makeCounts({ done: 2, total: 6, abandoned: 1, unfinished: 3 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBe("只读规划 · 已完成 2/6 · 放弃 1");
    });

    it("includes info-level current state before progress", () => {
      const summary = makeSummary({
        headline: makeLine("监督检查中", "info", "supervisor"),
        counts: makeCounts({ done: 1, total: 3 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBe("监督检查中 · 已完成 1/3");
      expect(result).toContain("监督检查中");
    });
  });

  // ── State / Edge Cases ──

  describe("zero tasks", () => {
    it("shows 0/0 with no abandoned", () => {
      const summary = makeSummary({
        counts: makeCounts({ total: 0, done: 0, abandoned: 0, unfinished: 0 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBe("只读规划 · 已完成 0/0");
    });
  });

  describe("VF4 journal view uncertainty", () => {
    it("does not turn a journal-fault empty view into known zero tasks", () => {
      const summary = makeSummary({
        headline: makeLine("需检查", "error", "journal"),
        blockers: [
          makeLine("JOURNAL_LIMIT metric=fileBytes observed=101 limit=100", "error", "journal"),
        ],
        counts: makeCounts({ total: 0, done: 0, unfinished: 0, abandoned: 0 }),
      });
      const before = JSON.stringify(summary);
      const result = formatStatusbar(summary);
      expect(result).toContain("任务视图未恢复");
      expect(result).toContain("数量未知");
      expect(result).not.toContain("0/0");
      expect(JSON.stringify(summary)).toBe(before);
    });

    it("retains known nonempty counts even with a journal blocker", () => {
      const summary = makeSummary({
        blockers: [makeLine("JOURNAL_INVALID", "error", "journal")],
        counts: makeCounts({ total: 3, done: 1, unfinished: 2 }),
      });
      expect(formatStatusbar(summary)).toContain("已完成 1/3");
    });
  });

  describe("all abandoned", () => {
    it("shows done=0 and abandoned count", () => {
      const summary = makeSummary({
        counts: makeCounts({ total: 3, done: 0, abandoned: 3, unfinished: 0 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBe("只读规划 · 已完成 0/3 · 放弃 3");
    });
  });

  describe("all done", () => {
    it("shows done=N/N with no abandoned", () => {
      const summary = makeSummary({
        counts: makeCounts({ total: 5, done: 5, abandoned: 0, unfinished: 0 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBe("只读规划 · 已完成 5/5");
    });
  });

  // ── Long Text / Control Chars ──

  describe("long text and control characters", () => {
    it("strips ANSI escape sequences from headline", () => {
      const summary = makeSummary({
        headline: makeLine("\u001b[31m需检查\u001b[0m", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 2 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).not.toContain("\u001b");
      expect(result).toMatch(/^需检查/);
    });

    it("strips control characters from headline", () => {
      const summary = makeSummary({
        headline: makeLine("需\u0000\u0001检查", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 2 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).not.toContain("\u0000");
      expect(result).not.toContain("\u0001");
      expect(result).toContain("需");
      expect(result).toContain("检查");
    });

    it("strips newlines from headline text", () => {
      const summary = makeSummary({
        headline: makeLine("需检查\n状态", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 2 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).not.toContain("\n");
    });

    it("does not produce newlines in output", () => {
      const summary = makeSummary({
        headline: makeLine("很长".repeat(40), "warning", "board"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).not.toContain("\n");
    });
  });

  // ── CJK / Width ──

  describe("CJK and width constraints", () => {
    it("truncates to max 64 visible columns", () => {
      const longHeadline = "注".repeat(50);
      const summary = makeSummary({
        headline: makeLine(longHeadline, "error", "receipt"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(visibleWidth(result!)).toBeLessThanOrEqual(64);
    });

    it("preserves attention prefix when truncating", () => {
      const longHeadline = "注".repeat(30);
      const summary = makeSummary({
        headline: makeLine(longHeadline, "error", "receipt"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // The result should start with the headline prefix (possibly truncated)
      expect(result!.startsWith("注")).toBe(true);
    });

    it("handles mixed ASCII and CJK within 64 columns", () => {
      const summary = makeSummary({
        headline: makeLine("需检查", "error", "receipt"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(visibleWidth(result!)).toBeLessThanOrEqual(64);
      // "需检查" = 6 cols + " · " = 3 + "已完成 2/6" = 10 + " · " = 3 + "放弃 1" = 4 = 26
      expect(result).toBe("需检查 · 已完成 2/6 · 放弃 1");
    });

    it("truncates done segment when headline is very long", () => {
      const longHeadline = "注".repeat(31); // 62 visible columns
      const summary = makeSummary({
        headline: makeLine(longHeadline, "error", "receipt"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(visibleWidth(result!)).toBeLessThanOrEqual(64);
      // Headline takes 62 cols, separator 3, leaves 64-62-3 = -1 → no room for done
      // Actually 62 + 3 = 65 > 64, so done won't fit at all
      // But headline itself is 62 which is ≤ 64, so it should be truncated
      expect(visibleWidth(result!)).toBeLessThanOrEqual(64);
    });

    it("exact 64 columns does not truncate", () => {
      // Build a headline that makes the total exactly 64
      // "已完成 2/6" = 10 cols (CJK: 已(2)+完(2)+成(2)+space(1)+2(1)+/(1)+6(1))
      // " · " = 3 cols
      // "放弃 1" = 6 cols (CJK: 放(2)+弃(2)+space(1)+1(1))
      // Total tail: 10 + 3 + 6 = 19
      // separator before headline: 3
      // Headline can be 64 - 3 - 19 = 42 visible columns
      const headlineText = "A".repeat(42);
      const summary = makeSummary({
        headline: makeLine(headlineText, "warning", "board"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(visibleWidth(result!)).toBeLessThanOrEqual(64);
      // Should contain all segments since total ≤ 64
      expect(result).toContain("已完成 2/6");
      expect(result).toContain("放弃 1");
    });
  });

  // ── Safety: No forbidden operations ──

  describe("safety constraints", () => {
    it("output contains no ANSI escape sequences", () => {
      const summary = makeSummary({
        headline: makeLine("\u001b[1;31mERROR\u001b[0m", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 3, abandoned: 2 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // No ANSI escape character, including non-CSI sequences.
      expect(result).not.toContain(String.fromCharCode(27));
    });

    it("output contains no control characters", () => {
      const summary = makeSummary({
        headline: makeLine("检查\u0007\u0008", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 3 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // No Cc characters
      expect(result).not.toMatch(/\p{Cc}/u);
    });

    it("visibly escapes U+202E (RIGHT-TO-LEFT OVERRIDE) before width calculation", () => {
      const summary = makeSummary({
        headline: makeLine("需检查\u202E", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 2 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // Bidi control must not survive as raw character
      expect(result).not.toContain("\u202E");
      // Should be visibly escaped as literal text
      expect(result).toContain("\\u202e");
      // Suffix count must still appear
      expect(result).toContain("已完成 1/2");
    });

    it("visibly escapes U+2066 (LEFT-TO-RIGHT ISOLATE) before width calculation", () => {
      const summary = makeSummary({
        headline: makeLine("\u2066监督检查中", "info", "supervisor"),
        counts: makeCounts({ done: 2, total: 4 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // Bidi control must not survive as raw character
      expect(result).not.toContain("\u2066");
      // Should be visibly escaped as literal text
      expect(result).toContain("\\u2066");
      // Suffix count must still appear
      expect(result).toContain("已完成 2/4");
    });

    it("preserves input immutability when escaping bidi controls", () => {
      const summary = makeSummary({
        headline: makeLine("状态\u202E检查", "error", "receipt"),
        counts: makeCounts({ done: 1, total: 2 }),
      });
      const before = JSON.stringify(summary);
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // Input must not be mutated
      expect(JSON.stringify(summary)).toBe(before);
      // Output must not contain raw bidi
      expect(result).not.toContain("\u202E");
      expect(result).toContain("\\u202e");
    });

    it("escaped bidi controls contribute to width calculation correctly", () => {
      const summary = makeSummary({
        headline: makeLine("注".repeat(20) + "\u202E", "error", "receipt"),
        counts: makeCounts({ done: 2, total: 6, abandoned: 1 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      // Width must stay within 64 columns
      expect(visibleWidth(result!)).toBeLessThanOrEqual(64);
      // Escaped bidi text "\u202e" is 6 ASCII chars
      // Should not contain raw bidi
      expect(result).not.toContain("\u202E");
    });

    it("does not include full task list", () => {
      const tasks: UiTaskSummary[] = Array.from({ length: 20 }, (_, i) => ({
        id: `t-${i}`,
        title: `Task ${i}`,
        phase: 1,
        status: "done" as const,
        notes: [],
      }));
      const summary = makeSummary({
        tasks,
        counts: makeCounts({ total: 20, done: 20, abandoned: 0, unfinished: 0 }),
      });
      const result = formatStatusbar(summary);
      expect(result).toBeDefined();
      expect(result).not.toContain("t-0");
      expect(result).not.toContain("Task 0");
      expect(result).toBe("只读规划 · 已完成 20/20");
    });
  });
});

// Info is severity, not permission to hide the current workflow state.
describe("parent status acceptance", () => {
  it.each(["权限已确认，尚未启动", "等待原生回应", "等待外部结果（最近owner报告）", "监督检查中"])(
    "keeps the info-level state %s before secondary progress",
    (text) => {
      const summary = makeSummary({
        headline: makeLine(text, "info", "preflight"),
        counts: makeCounts({ total: 0, done: 0, abandoned: 0, unfinished: 0 }),
      });
      const result = formatStatusbar(summary);
      expect(result?.startsWith(text)).toBe(true);
      expect(result).toContain("已完成 0/0");
    },
  );

  it("sanitizes an info-level headline and leaves the input unchanged", () => {
    const summary = makeSummary({ headline: makeLine("待\n启动\u001b[0m", "info", "preflight") });
    const before = JSON.stringify(summary);
    const result = formatStatusbar(summary);
    expect(result?.startsWith("待 启动")).toBe(true);
    expect(result).not.toContain(String.fromCharCode(27));
    expect(JSON.stringify(summary)).toBe(before);
  });
});
