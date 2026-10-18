import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  requestNativeAnswer,
  requireNativeAnswer,
  hasActiveNativeQuestion,
  type NativeQuestion,
} from "../human-ui";
import { beginReadOnlyView } from "../ui-view-lifecycle";
import { showTaskList, TASK_WIDGET_KEY } from "../board-ui";
import { createEmptyBoard } from "../engine";
import { resetState, setBoard, updateUI } from "../state";
import * as uiCapture from "../ui-capture";
import { validDecisionInformation } from "../decision-spec";
import { createMockTheme } from "./helpers/mocks";

vi.mock("node:fs", () => ({
  realpathSync: vi.fn((path: string) => path),
  readFileSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));
const argv = process.argv;
const stdin = Object.getOwnPropertyDescriptor(process, "stdin")!;
const stdout = Object.getOwnPropertyDescriptor(process, "stdout")!;
afterEach(() => {
  process.argv = argv;
  Object.defineProperty(process, "stdin", stdin);
  Object.defineProperty(process, "stdout", stdout);
  vi.restoreAllMocks();
});

function trusted(): void {
  Object.defineProperty(process, "stdin", { value: { isTTY: true }, configurable: true });
  Object.defineProperty(process, "stdout", { value: { isTTY: true }, configurable: true });
  vi.mocked(realpathSync).mockImplementation((path: any) => String(path));
  vi.mocked(statSync).mockReturnValue({ isDirectory: () => true } as any);
  vi.mocked(readFileSync).mockImplementation((path: any) => {
    if (String(path).endsWith("@earendil-works/pi-coding-agent/package.json"))
      return JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
    throw new Error("No package");
  });
  const prefix = process.execPath.slice(0, process.execPath.lastIndexOf("/bin/node"));
  process.argv = ["node", `${prefix}/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`];
}

function question(overrides: Partial<NativeQuestion> = {}): NativeQuestion {
  return {
    frame: {
      version: 1,
      owner: "board",
      sessionId: "session",
      requestId: "request",
      presentationId: "presentation",
      scopeDigest: "a".repeat(64),
      baseSnapshotEntryId: "base",
      baseSnapshotDigest: "b".repeat(64),
    },
    kind: "authorization",
    title: "Original scope",
    body: "Full original body\n".repeat(30),
    ...overrides,
  };
}

function harness() {
  trusted();
  const rendered: string[][] = [];
  const components: Array<Component & { dispose?(): void }> = [];
  const control: {
    action: "review" | "cancel" | "hold";
    rows: number;
    width: number;
    beforeFactory?: () => void;
    afterFactory?: () => void;
  } = { action: "review", rows: 24, width: 80 };
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, text) => text);
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  let completed: unknown;
  function drive(action: "review" | "cancel" = "review"): void {
    const component = components.at(-1)!;
    for (let page = 0; page < 10000 && completed === undefined; page++) {
      const lines = component.render(control.width);
      rendered.push(lines);
      // A tiny viewport is cancel-only. Leave it pending for explicit test input.
      if (action !== "cancel" && !lines[1]?.startsWith("第 ")) return;
      component.handleInput?.(action === "cancel" ? "\u001b" : "\r");
    }
    if (completed === undefined) throw new Error("Review did not complete");
  }
  const custom = vi.fn(
    (factory: any) =>
      new Promise((resolve) => {
        completed = undefined;
        const done = (value: unknown) => {
          completed = value;
          resolve(value);
        };
        control.beforeFactory?.();
        const component = factory(
          {
            terminal: {
              get rows() {
                return control.rows;
              },
            },
            requestRender: vi.fn(),
          },
          theme,
          keys,
          done,
        );
        components.push(component);
        control.afterFactory?.();
        if (control.action === "hold") {
          rendered.push(component.render(control.width));
        } else drive(control.action);
      }),
  );
  const ctx = {
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: vi.fn(() => "session"),
      getLeafId: vi.fn(() => "leaf"),
      getBranch: vi.fn(() => []),
    },
    ui: {
      custom,
      select: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
      setWidget: vi.fn(),
      setStatus: vi.fn(),
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
  } as unknown as ExtensionContext;
  return {
    ctx,
    custom,
    rendered,
    components,
    control,
    drive,
    setAction: (value: typeof control.action) => {
      control.action = value;
    },
  };
}

// These first two sentinels run RED/GREEN before expanding the composition matrix.
describe("native composition sentinels", () => {
  it("suspends own widget across A→C actual join and restores the latest original publication", async () => {
    resetState();
    const h = harness();
    const snapshot = { ...createEmptyBoard(), generation: 1, workflowStatus: "active" as const };
    setBoard(snapshot);
    const summaries = vi.spyOn(uiCapture, "captureUiSummary");
    const setWidget = vi.fn();
    Object.assign(h.ctx.ui, { setWidget, setStatus: vi.fn() });
    Object.assign(h.ctx, { isIdle: () => true, hasPendingMessages: () => false });
    updateUI(h.ctx, snapshot);
    const original = setWidget.mock.calls.at(-1)![1];
    h.setAction("hold");
    let joinReader: (() => void) | undefined;
    let readerDone = 0;
    h.custom.mockImplementationOnce(
      (factory: any) =>
        new Promise((resolve) => {
          const component = factory(
            { terminal: { rows: 24 }, requestRender: vi.fn() },
            createMockTheme(),
            new KeybindingsManager(TUI_KEYBINDINGS),
            () => {
              readerDone++;
              joinReader = () => {
                resolve(undefined);
              };
            },
          );
          h.components.push(component);
          h.rendered.push(component.render(80));
        }),
    );
    const reader = showTaskList(h.ctx, snapshot);
    await vi.waitFor(() => {
      expect(h.custom).toHaveBeenCalledOnce();
    });
    expect(h.rendered.flat().join("\n")).toContain("确认与回应");
    expect(original({} as any, createMockTheme()).render(80)).toEqual([]);
    const latest = {
      ...snapshot,
      generation: 2,
      workflowStatus: "paused" as const,
      pauseReason: "Latest owner fact",
    };
    setBoard(latest);
    const hiddenCalls = setWidget.mock.calls.length;
    updateUI(h.ctx, latest);
    expect(setWidget).toHaveBeenCalledTimes(hiddenCalls);
    const native = requestNativeAnswer(h.ctx, question(), () => true);
    await vi.waitFor(() => {
      expect(readerDone).toBe(1);
    });
    expect(hasActiveNativeQuestion(h.ctx)).toBe(true);
    expect(h.custom).toHaveBeenCalledOnce();
    expect(setWidget.mock.calls.every(([key]) => key === TASK_WIDGET_KEY)).toBe(true);
    const beforeJoin = setWidget.mock.calls.length;
    joinReader!();
    await reader;
    await vi.waitFor(() => {
      expect(h.custom).toHaveBeenCalledTimes(2);
    });
    expect(setWidget).toHaveBeenCalledTimes(beforeJoin);
    expect(h.components[0]!.render(80)).toEqual([]);
    h.drive("cancel");
    expect(await native).toBeUndefined();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
    expect(setWidget).toHaveBeenCalledTimes(beforeJoin + 1);
    const resumed = setWidget.mock.calls.at(-1)![1]({} as any, createMockTheme());
    expect(resumed.render(100).join("\n")).toContain("Latest owner fact");
    expect(summaries).toHaveBeenCalledTimes(3);
    expect(summaries.mock.calls.at(-1)?.[1].generation).toBe(2);
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
  });
  it("sentinel 1: review alone is not an answer; cancel skips native final; close abort cannot reenter", async () => {
    const h = harness();
    const q = question();
    const lease = beginReadOnlyView(h.ctx)!;
    let reentrant: Promise<unknown> | undefined;
    lease.signal.addEventListener("abort", () => {
      reentrant = requestNativeAnswer(h.ctx, q, () => true);
    });
    let nativeDone: ((value: string) => void) | undefined;
    vi.mocked(h.ctx.ui.select).mockImplementation(
      () =>
        new Promise((resolve) => {
          nativeDone = resolve;
        }),
    );
    const pending = requestNativeAnswer(h.ctx, q, () => true);
    await vi.waitFor(() => {
      expect(lease.signal.aborted).toBe(true);
    });
    expect(await reentrant).toBeUndefined();
    expect(h.custom).not.toHaveBeenCalled();
    lease.finish();
    await vi.waitFor(() => {
      expect(h.ctx.ui.select).toHaveBeenCalledOnce();
    });
    expect(h.rendered.length).toBeGreaterThan(1);
    expect(() => requireNativeAnswer(h.ctx, "reviewed", q.frame)).toThrow();
    expect(() =>
      requireNativeAnswer(h.ctx, Object.freeze({ outcome: "approve" }), q.frame),
    ).toThrow();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    nativeDone!("允许上述范围");
    const answer = await pending;
    expect(answer?.outcome).toBe("approve");
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    expect(h.components.every((component) => component.render(80).length === 0)).toBe(true);
    h.setAction("cancel");
    vi.mocked(h.ctx.ui.select).mockClear();
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
  });

  it("sentinel 2: invalid integer/date is visibly unsaved; explicit retry preserves raw valid value; later saves nothing", async () => {
    for (const [format, invalid, valid] of [
      ["integer", "1.5", "-0"],
      ["date", "2025-02-29", "2024-02-29"],
    ] as const) {
      const h = harness();
      const q = question({
        kind: "information",
        purpose: "information",
        informationFormat: format,
        informationValidator: (value) =>
          validDecisionInformation({ version: 1, kind: "information", format }, value),
      });
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(invalid).mockResolvedValueOnce(valid);
      vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("重新输入");
      const answer = await requestNativeAnswer(h.ctx, q, () => true);
      expect(answer?.value).toBe(valid);
      expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
      expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
      const [title, options] = vi.mocked(h.ctx.ui.select).mock.calls[0]!;
      expect(title).toContain("未保存");
      expect(options).toEqual(["稍后输入", "重新输入", "重新核对全文"]);
      expect(
        JSON.stringify([
          h.rendered,
          vi.mocked(h.ctx.ui.select).mock.calls,
          vi.mocked(h.ctx.ui.input).mock.calls,
        ]),
      ).not.toContain(invalid);
      expect(h.ctx.ui.notify).not.toHaveBeenCalled();
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(invalid);
      vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后输入");
      expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
      expect(h.ctx.ui.input).toHaveBeenCalledTimes(3);
    }
  });
});

type Harness = ReturnType<typeof harness>;
function bodyText(h: Harness): string {
  return h.rendered.flatMap((lines) => lines.slice(3, -2)).join("");
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const reviewAgain = "重新核对全文";
describe("captured purposes and exact native mappings", () => {
  it.each([undefined, "authorization"] as const)(
    "authorization purpose %s retains original approve/reject/defer mapping",
    async (purpose) => {
      for (const [label, outcome] of [
        ["允许上述范围", "approve"],
        ["不允许", "reject"],
        ["稍后决定", undefined],
      ] as const) {
        const h = harness();
        vi.mocked(h.ctx.ui.select).mockResolvedValueOnce(label);
        const q = question({ purpose });
        const answer = await requestNativeAnswer(h.ctx, q, () => true);
        expect(answer?.outcome).toBe(outcome);
        if (answer) expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
        expect(h.ctx.ui.select).toHaveBeenCalledWith(
          "范围确认（全文已核对） — 请求 request",
          ["稍后决定", "允许上述范围", "不允许", reviewAgain],
          expect.any(Object),
        );
      }
    },
  );

  it.each([undefined, "business-choice"] as const)(
    "business purpose %s indexes even reserved original strings without normalization",
    async (purpose) => {
      const values = [
        "Later",
        "稍后决定",
        "重新核对全文",
        "选项 1",
        "  原值\n尾行  ",
        "Start execution",
      ];
      for (const [index, value] of values.entries()) {
        const h = harness();
        vi.mocked(h.ctx.ui.select).mockResolvedValueOnce(`选项 ${index + 1}`);
        const q = question({ kind: "choice", purpose, options: values });
        const answer = await requestNativeAnswer(h.ctx, q, () => true);
        expect(answer?.value).toBe(value);
        expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
        expect(vi.mocked(h.ctx.ui.select).mock.calls[0]?.[1]).toEqual([
          "稍后决定（不提交）",
          ...values.map((_, i) => `选项 ${i + 1}`),
          reviewAgain,
        ]);
        const scope = bodyText(h);
        expect(scope).toContain("选项·1Later");
        expect(scope).toContain("选项·3重新核对全文");
        expect(scope).toContain("··原值尾行··");
      }
    },
  );

  it("ordinary preflight choice does not infer first-start from owner, title, canonical values or display labels", async () => {
    const h = harness();
    const q = question({
      kind: "choice",
      title: "首次启动",
      frame: { ...question().frame, owner: "preflight" },
      options: ["Later", "Start execution"],
      displayOptions: ["稍后启动", "开始执行"],
    });
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("开始执行");
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("选项 1");
    expect((await requestNativeAnswer(h.ctx, q, () => true))?.value).toBe("Later");
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后决定（不提交）");
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
  });

  it("explicit first-start requires exact original canonical pair and preflight frame; later never mints an answer", async () => {
    const h = harness();
    const q = question({
      kind: "choice",
      purpose: "first-start",
      frame: { ...question().frame, owner: "preflight" },
      options: ["Later", "Start execution"],
    });
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后启动");
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce(reviewAgain).mockResolvedValueOnce("开始执行");
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(answer?.value).toBe("Start execution");
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    expect(bodyText(h)).toContain("Start·execution");
    for (const invalid of [
      { ...q, frame: question().frame },
      { ...q, options: ["Start execution", "Later"] },
      { ...q, options: ["Later", "Start execution", "extra"] },
      { ...q, options: ["Later", "Start execution "] },
    ]) {
      const blocked = harness();
      expect(await requestNativeAnswer(blocked.ctx, invalid, () => true)).toBeUndefined();
      expect(blocked.custom).not.toHaveBeenCalled();
      expect(blocked.ctx.ui.select).not.toHaveBeenCalled();
    }
  });

  it.each([
    { purpose: "invented" },
    { purpose: null },
    { purpose: "information" },
    { purpose: "first-start" },
    { purpose: "business-choice" },
    { kind: "information", purpose: "authorization" },
    { kind: "choice", purpose: "information", options: ["A"] },
    { kind: "invented" },
    { informationFormat: "integer" },
    { kind: "information", informationFormat: "float" },
  ])(
    "unknown or conflicting display metadata fails closed before closing readers: %j",
    async (overrides) => {
      const h = harness();
      const lease = beginReadOnlyView(h.ctx)!;
      const q = question(overrides as Partial<NativeQuestion>);
      expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
      expect(lease.signal.aborted).toBe(false);
      lease.finish();
      expect(h.custom).not.toHaveBeenCalled();
      expect(h.ctx.ui.input).not.toHaveBeenCalled();
      expect(h.ctx.ui.select).not.toHaveBeenCalled();
    },
  );

  it.each([
    { options: undefined },
    { options: [] },
    { options: ["duplicate", "duplicate"] },
    { options: ["A", "B"], displayOptions: ["same", "same"] },
    { options: ["A", "B"], displayOptions: ["only"] },
  ])(
    "validates original options/displayOptions before using indexed labels: %j",
    async (mapping) => {
      const h = harness();
      expect(
        await requestNativeAnswer(h.ctx, question({ kind: "choice", ...mapping }), () => true),
      ).toBeUndefined();
      expect(h.custom).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["authorization", "Approve"],
    ["authorization", "Defer"],
    ["authorization", "Reject"],
    ["authorization", "选项 1"],
    ["choice", "A"],
    ["choice", "Later"],
    ["choice", "稍后决定"],
    ["choice", "选项 0"],
    ["choice", "选项 3"],
    ["choice", "not offered"],
  ] as const)("rejects unoffered native callback for %s: %s", async (kind, selected) => {
    const h = harness();
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce(selected);
    expect(
      await requestNativeAnswer(h.ctx, question({ kind, options: ["A", "Later"] }), () => true),
    ).toBeUndefined();
  });

  it("does not trust mutation of the labels array passed to native select", async () => {
    const h = harness();
    vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, labels) => {
      labels[1] = "injected";
      return "injected";
    });
    expect(
      await requestNativeAnswer(
        h.ctx,
        question({ kind: "choice", options: ["canonical"] }),
        () => true,
      ),
    ).toBeUndefined();
  });

  it("captures all display metadata, frame, validator and original option bytes before the first await", async () => {
    const h = harness();
    const q = question({
      kind: "choice",
      purpose: "business-choice",
      options: ["  Later  ", "Exact\nOriginal"],
      displayOptions: ["first", "second"],
    });
    const originalFrame = structuredClone(q.frame);
    const lease = beginReadOnlyView(h.ctx)!;
    lease.signal.addEventListener("abort", () => {
      Object.assign(q, {
        purpose: "first-start",
        title: "Changed title",
        body: "Changed body",
        informationFormat: "date",
      });
      (q.options as string[])[1] = "Changed value";
      (q.displayOptions as string[])[1] = "first";
      Object.assign(q.frame, { requestId: "changed-frame" });
      lease.finish();
    });
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("选项 2");
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(answer?.value).toBe("Exact\nOriginal");
    expect(requireNativeAnswer(h.ctx, answer, originalFrame)).toBe(answer);
    expect(bodyText(h)).toContain("Original·scope");
    expect(bodyText(h)).toContain("ExactOriginal");
    expect(bodyText(h)).not.toContain("Changed");

    const info = harness();
    const validator = vi.fn((value: string) => value === "-0");
    const iq = question({
      kind: "information",
      purpose: "information",
      informationFormat: "integer",
      informationValidator: validator,
    });
    const request = requestNativeAnswer(info.ctx, iq, () => true);
    Object.assign(iq, {
      informationFormat: "date",
      purpose: "first-start",
      informationValidator: () => false,
    });
    vi.mocked(info.ctx.ui.input).mockResolvedValueOnce("-0");
    expect((await request)?.value).toBe("-0");
    expect(validator).toHaveBeenCalledWith("-0");
    expect(vi.mocked(info.ctx.ui.input).mock.calls[0]?.[0]).toContain("整数");
  });

  it("reviewagain stays within the same captured frame, lock and scope, then only final native approval mints", async () => {
    const h = harness();
    const q = question();
    vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
      expect(hasActiveNativeQuestion(h.ctx)).toBe(true);
      expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
      return vi.mocked(h.ctx.ui.select).mock.calls.length === 1 ? reviewAgain : "允许上述范围";
    });
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(answer?.outcome).toBe("approve");
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    expect(h.custom).toHaveBeenCalledTimes(2);
    expect(bodyText(h).split("Original·scope")).toHaveLength(3);
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
  });
});

describe("information feedback stays on original native transport", () => {
  it.each([undefined, "text", "integer", "date"] as const)(
    "format %s is visible in title and review, never a replacement for the owner validator",
    async (format) => {
      const h = harness();
      const validator = vi.fn(() => true);
      const raw = "  unnormalized value  ";
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(raw);
      const q = question({
        kind: "information",
        informationFormat: format,
        informationValidator: validator,
      });
      const answer = await requestNativeAnswer(h.ctx, q, () => true);
      expect(answer?.value).toBe(raw);
      expect(validator).toHaveBeenCalledWith(raw);
      const hint =
        format === "integer" ? "整数" : format === "date" ? "日期 YYYY-MM-DD" : "文本，最多1000字";
      expect(vi.mocked(h.ctx.ui.input).mock.calls[0]).toEqual([
        `补充信息：${hint} — 请求 request`,
        undefined,
        expect.any(Object),
      ]);
      expect(bodyText(h)).toContain(`格式：${hint.replaceAll(" ", "·")}`);
      expect(h.ctx.ui.select).not.toHaveBeenCalled();
    },
  );

  it.each(["password=secret123", "token=must-not-echo", "x".repeat(1001), ""])(
    "unsafe or overlong value never reaches owner validator or any echo: %.24s",
    async (invalid) => {
      const h = harness();
      const validator = vi.fn(() => true);
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(invalid);
      vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后输入");
      expect(
        await requestNativeAnswer(
          h.ctx,
          question({
            kind: "information",
            informationFormat: "integer",
            informationValidator: validator,
          }),
          () => true,
        ),
      ).toBeUndefined();
      expect(validator).not.toHaveBeenCalled();
      expect(vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0]).toBe(
        "未保存：需要安全且不超过1000字的信息 — 请求 request",
      );
      if (invalid)
        expect(
          JSON.stringify([
            h.rendered,
            vi.mocked(h.ctx.ui.input).mock.calls,
            vi.mocked(h.ctx.ui.select).mock.calls,
            vi.mocked(h.ctx.ui.notify).mock.calls,
          ]),
        ).not.toContain(invalid);
      expect(h.ctx.ui.notify).not.toHaveBeenCalled();
    },
  );

  it("bounded check keeps exact 1000-character original without trim or conversion", async () => {
    const h = harness();
    const raw = ` ${"界".repeat(998)} `;
    vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(raw);
    const answer = await requestNativeAnswer(h.ctx, question({ kind: "information" }), () => true);
    expect(answer?.value).toBe(raw);
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
  });

  it.each([
    ["integer", " 1", "1"],
    ["integer", "01", "-0"],
    ["integer", "9007199254740992", "9007199254740991"],
    ["date", "2024-2-29", "2024-02-29"],
    ["date", "2023-02-29", "2023-02-28"],
  ] as const)(
    "owner %s validation rejects %s until explicit retry supplies %s",
    async (format, invalid, valid) => {
      const h = harness();
      const q = question({
        kind: "information",
        informationFormat: format,
        informationValidator: (value) =>
          validDecisionInformation({ version: 1, kind: "information", format }, value),
      });
      vi.mocked(h.ctx.ui.input)
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce(invalid)
        .mockResolvedValueOnce(valid);
      vi.mocked(h.ctx.ui.select)
        .mockResolvedValueOnce("重新输入")
        .mockResolvedValueOnce("重新输入");
      const answer = await requestNativeAnswer(h.ctx, q, () => true);
      expect(answer?.value).toBe(valid);
      expect(h.custom).toHaveBeenCalledOnce();
      expect(h.ctx.ui.input).toHaveBeenCalledTimes(3);
      expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
    },
  );

  it("information回看 reopens exact scope and then original input, not editor or prefill", async () => {
    const h = harness();
    vi.mocked(h.ctx.ui.input).mockResolvedValueOnce("bad").mockResolvedValueOnce("42");
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce(reviewAgain);
    const answer = await requestNativeAnswer(
      h.ctx,
      question({
        kind: "information",
        informationFormat: "integer",
        informationValidator: (value) => value === "42",
      }),
      () => true,
    );
    expect(answer?.value).toBe("42");
    expect(h.custom).toHaveBeenCalledTimes(2);
    expect(bodyText(h).split("Original·scope")).toHaveLength(3);
    expect(vi.mocked(h.ctx.ui.input).mock.calls.every((call) => call[1] === undefined)).toBe(true);
  });

  it.each([undefined, "unknown", "42", "允许上述范围"])(
    "invalid feedback choice %s cannot implicitly retry or mint",
    async (label) => {
      const h = harness();
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce("bad");
      vi.mocked(h.ctx.ui.select).mockResolvedValueOnce(label);
      expect(
        await requestNativeAnswer(
          h.ctx,
          question({ kind: "information", informationValidator: () => false }),
          () => true,
        ),
      ).toBeUndefined();
      expect(h.ctx.ui.input).toHaveBeenCalledOnce();
      expect(h.custom).toHaveBeenCalledOnce();
    },
  );

  it("undefined input is safe later, not invalid feedback", async () => {
    const h = harness();
    vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(undefined);
    expect(
      await requestNativeAnswer(h.ctx, question({ kind: "information" }), () => true),
    ).toBeUndefined();
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
  });
});

const awaitPhases = [
  "close",
  "review",
  "select",
  "input",
  "retry-select",
  "reviewagain",
  "retry-input",
] as const;
const invalidations = [
  "session",
  "branch",
  "current",
  "pending",
  "ctx-signal",
  "foreign-signal",
] as const;

describe("same original operation validity at every await boundary", () => {
  it.each(awaitPhases.flatMap((phase) => invalidations.map((change) => ({ phase, change }))))(
    "$phase rejects $change changes without native answer or downstream UI",
    async ({ phase, change }) => {
      const h = harness();
      const ctxAbort = new AbortController();
      const foreignAbort = new AbortController();
      Object.assign(h.ctx, { signal: ctxAbort.signal });
      let current = true;
      let pending = false;
      const isCurrent = () => current && !pending;
      const q = question(
        phase.includes("input") || phase === "retry-select"
          ? { kind: "information", informationValidator: (value) => value === "valid" }
          : {},
      );
      const native = deferred<string | undefined>();
      let lease: ReturnType<typeof beginReadOnlyView>;
      if (phase === "close") lease = beginReadOnlyView(h.ctx);
      if (phase === "review") h.setAction("hold");
      if (phase === "reviewagain") {
        vi.mocked(h.ctx.ui.select).mockImplementationOnce(async () => {
          h.setAction("hold");
          return reviewAgain;
        });
      } else if (phase === "input") {
        vi.mocked(h.ctx.ui.input).mockReturnValueOnce(native.promise);
      } else if (phase === "retry-input") {
        vi.mocked(h.ctx.ui.input)
          .mockResolvedValueOnce("invalid")
          .mockReturnValueOnce(native.promise);
        vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("重新输入");
      } else if (phase === "retry-select") {
        vi.mocked(h.ctx.ui.input).mockResolvedValueOnce("invalid");
        vi.mocked(h.ctx.ui.select).mockReturnValueOnce(native.promise);
      } else {
        vi.mocked(h.ctx.ui.select).mockReturnValueOnce(native.promise);
      }
      expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
      const request = requestNativeAnswer(h.ctx, q, isCurrent, foreignAbort.signal);
      expect(hasActiveNativeQuestion(h.ctx)).toBe(true);
      await vi.waitFor(() => {
        if (phase === "close") expect(lease?.signal.aborted).toBe(true);
        else if (phase === "review") expect(h.custom).toHaveBeenCalledOnce();
        else if (phase === "reviewagain") expect(h.custom).toHaveBeenCalledTimes(2);
        else if (phase === "input") expect(h.ctx.ui.input).toHaveBeenCalledOnce();
        else if (phase === "retry-input") expect(h.ctx.ui.input).toHaveBeenCalledTimes(2);
        else expect(h.ctx.ui.select).toHaveBeenCalledOnce();
      });
      expect(hasActiveNativeQuestion(h.ctx)).toBe(true);
      expect(await requestNativeAnswer(h.ctx, q, isCurrent, foreignAbort.signal)).toBeUndefined();
      const before = [
        h.custom.mock.calls.length,
        vi.mocked(h.ctx.ui.select).mock.calls.length,
        vi.mocked(h.ctx.ui.input).mock.calls.length,
      ];
      if (change === "session")
        vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("other-session");
      if (change === "branch")
        vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue("other-leaf");
      if (change === "current") current = false;
      if (change === "pending") pending = true;
      if (change === "ctx-signal") ctxAbort.abort();
      if (change === "foreign-signal") foreignAbort.abort();
      if (phase === "close") lease?.finish();
      else if (phase === "review" || phase === "reviewagain") h.drive();
      else
        native.resolve(
          phase === "retry-select"
            ? "重新输入"
            : q.kind === "information"
              ? "valid"
              : "允许上述范围",
        );
      expect(await request).toBeUndefined();
      expect([
        h.custom.mock.calls.length,
        vi.mocked(h.ctx.ui.select).mock.calls.length,
        vi.mocked(h.ctx.ui.input).mock.calls.length,
      ]).toEqual(before);
      expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
      expect(h.components.every((component) => component.render(80).length === 0)).toBe(true);
    },
  );

  it("allows leaf advancement on the original branch, including require-time ancestor checks", async () => {
    const h = harness();
    const q = question();
    vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
      vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue("descendant");
      vi.mocked(h.ctx.sessionManager.getBranch).mockReturnValue([{ id: "leaf" }] as any);
      return "允许上述范围";
    });
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    vi.mocked(h.ctx.sessionManager.getBranch).mockReturnValue([]);
    expect(() => requireNativeAnswer(h.ctx, answer, q.frame)).toThrow("Branch changed");
  });

  it("checks validity before the microtask can close or abort another readonly view", async () => {
    const h = harness();
    const lease = beginReadOnlyView(h.ctx)!;
    let current = true;
    const request = requestNativeAnswer(h.ctx, question(), () => current);
    current = false;
    expect(await request).toBeUndefined();
    expect(lease.signal.aborted).toBe(false);
    lease.finish();
    expect(h.custom).not.toHaveBeenCalled();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
  });
});

describe("public custom failure closure, explicit cleanup and bounded controls", () => {
  it.each([
    "missing-custom",
    "custom-throws",
    "unknown-custom",
    "fabricated-reviewed",
    "select-throws",
    "input-throws",
    "feedback-throws",
    "validator-throws",
  ] as const)("%s never falls back to summary approval or retries", async (failure) => {
    const h = harness();
    const q = question(
      failure.includes("input") || failure.includes("feedback") || failure.includes("validator")
        ? { kind: "information" }
        : {},
    );
    vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
    if (failure === "missing-custom") Object.assign(h.ctx.ui, { custom: undefined });
    if (failure === "custom-throws")
      h.custom.mockImplementationOnce(() => {
        throw new Error("host failure");
      });
    if (failure === "unknown-custom") h.custom.mockResolvedValueOnce("unknown");
    if (failure === "fabricated-reviewed") h.custom.mockResolvedValueOnce("reviewed");
    if (failure === "select-throws")
      vi.mocked(h.ctx.ui.select).mockRejectedValueOnce(new Error("select failure"));
    if (failure === "input-throws")
      vi.mocked(h.ctx.ui.input).mockRejectedValueOnce(new Error("input failure"));
    if (failure === "feedback-throws") {
      Object.assign(q, { informationValidator: () => false });
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce("bad");
      vi.mocked(h.ctx.ui.select).mockRejectedValueOnce(new Error("feedback failure"));
    }
    if (failure === "validator-throws") {
      Object.assign(q, {
        informationValidator: () => {
          throw new Error("validator failure");
        },
      });
      vi.mocked(h.ctx.ui.input).mockResolvedValueOnce("bad");
    }
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
    expect(h.components.every((component) => component.render(80).length === 0)).toBe(true);
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it.each([
    [23, 24],
    [80, 17],
  ] as const)(
    "tiny viewport %s×%s is cancel-only, without summary fallback",
    async (width, rows) => {
      const h = harness();
      Object.assign(h.control, { width, rows });
      const request = requestNativeAnswer(h.ctx, question(), () => true);
      await vi.waitFor(() => {
        expect(h.custom).toHaveBeenCalledOnce();
      });
      expect(h.rendered.flat()).toEqual(["Esc 取消"]);
      h.components[0]!.handleInput?.("\r");
      expect(h.ctx.ui.select).not.toHaveBeenCalled();
      h.drive("cancel");
      expect(await request).toBeUndefined();
      expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
    },
  );

  it.each(["before-factory", "after-factory", "held-review"] as const)(
    "abort at %s cancels native custom and removes exactly its signal listener",
    async (point) => {
      const h = harness();
      const controller = new AbortController();
      const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
      const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
      if (point === "before-factory")
        h.control.beforeFactory = () => {
          controller.abort();
        };
      if (point === "after-factory")
        h.control.afterFactory = () => {
          controller.abort();
        };
      if (point === "held-review") h.setAction("hold");
      const request = requestNativeAnswer(h.ctx, question(), () => true, controller.signal);
      await vi.waitFor(() => {
        expect(h.custom).toHaveBeenCalledOnce();
      });
      if (point === "held-review") controller.abort();
      expect(await request).toBeUndefined();
      const callback = add.mock.calls.find(([name]) => name === "abort")?.[1];
      expect(callback).toBeTypeOf("function");
      expect(remove).toHaveBeenCalledWith("abort", callback);
      expect(h.components[0]?.render(80)).toEqual([]);
      expect(h.ctx.ui.select).not.toHaveBeenCalled();
      expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
    },
  );

  it("custom throwing after actual construction still disposes and removes its callback", async () => {
    const h = harness();
    const controller = new AbortController();
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    h.control.afterFactory = () => {
      throw new Error("host render failed");
    };
    expect(
      await requestNativeAnswer(h.ctx, question(), () => true, controller.signal),
    ).toBeUndefined();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(h.components[0]?.render(80)).toEqual([]);
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
  });

  it("short real native titles stay single-line <=64 columns while every original title/body/option is reviewed", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const h = harness();
    const title = "题".repeat(1000);
    const body = "原文🚀".repeat(1200);
    const option = "全值".repeat(1000);
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("选项 1");
    const answer = await requestNativeAnswer(
      h.ctx,
      question({ title, body, kind: "choice", options: [option] }),
      () => true,
    );
    expect(answer?.value).toBe(option);
    const text = bodyText(h);
    expect(text).toContain(title);
    expect(text).toContain(body);
    expect(text).toContain(option);
    for (const [nativeTitle] of vi.mocked(h.ctx.ui.select).mock.calls) {
      expect(nativeTitle).not.toContain("\n");
      expect(visibleWidth(nativeTitle)).toBeLessThanOrEqual(64);
    }
    expect(
      h.rendered.every(
        (lines) => lines.length <= 14 && lines.every((line) => visibleWidth(line) <= 80),
      ),
    ).toBe(true);
  });

  it("P2 RED: two authorizations with different requestIds produce distinct final titles containing each short original id", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const h1 = harness();
    vi.mocked(h1.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    await requestNativeAnswer(
      h1.ctx,
      question({ frame: { ...question().frame, requestId: "alpha-request-1" } }),
      () => true,
    );
    const h2 = harness();
    vi.mocked(h2.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    await requestNativeAnswer(
      h2.ctx,
      question({ frame: { ...question().frame, requestId: "beta-request-2" } }),
      () => true,
    );
    const titles1 = vi.mocked(h1.ctx.ui.select).mock.calls.map(([t]) => t);
    const titles2 = vi.mocked(h2.ctx.ui.select).mock.calls.map(([t]) => t);
    // Final select titles must differ
    expect(titles1).not.toEqual(titles2);
    // Each must contain its own requestId
    expect(titles1.some((t) => t.includes("alpha-request-1"))).toBe(true);
    expect(titles2.some((t) => t.includes("beta-request-2"))).toBe(true);
    // All titles still within 64 columns and single-line
    for (const t of [...titles1, ...titles2]) {
      expect(t).not.toContain("\n");
      expect(visibleWidth(t)).toBeLessThanOrEqual(64);
    }
  });

  it("P2 RED: all final control titles include requestId for every purpose/input/retry", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const rid = "req-42";
    // Authorization
    const hAuth = harness();
    vi.mocked(hAuth.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    await requestNativeAnswer(
      hAuth.ctx,
      question({ frame: { ...question().frame, requestId: rid } }),
      () => true,
    );
    expect(vi.mocked(hAuth.ctx.ui.select).mock.calls.some(([t]) => t.includes(rid))).toBe(true);

    // First-start
    const hFirst = harness();
    vi.mocked(hFirst.ctx.ui.select).mockResolvedValueOnce("开始执行");
    await requestNativeAnswer(
      hFirst.ctx,
      question({
        kind: "choice",
        purpose: "first-start",
        options: ["Later", "Start execution"],
        frame: { ...question().frame, owner: "preflight", requestId: rid },
      }),
      () => true,
    );
    expect(vi.mocked(hFirst.ctx.ui.select).mock.calls.some(([t]) => t.includes(rid))).toBe(true);

    // Business choice
    const hBiz = harness();
    vi.mocked(hBiz.ctx.ui.select).mockResolvedValueOnce("选项 1");
    await requestNativeAnswer(
      hBiz.ctx,
      question({ kind: "choice", options: ["A"], frame: { ...question().frame, requestId: rid } }),
      () => true,
    );
    expect(vi.mocked(hBiz.ctx.ui.select).mock.calls.some(([t]) => t.includes(rid))).toBe(true);

    // Information input
    const hInfo = harness();
    vi.mocked(hInfo.ctx.ui.input).mockResolvedValueOnce("some info");
    await requestNativeAnswer(
      hInfo.ctx,
      question({ kind: "information", frame: { ...question().frame, requestId: rid } }),
      () => true,
    );
    expect(vi.mocked(hInfo.ctx.ui.input).mock.calls.some(([t]) => t.includes(rid))).toBe(true);

    // Information retry (invalid input)
    const hRetry = harness();
    vi.mocked(hRetry.ctx.ui.input).mockResolvedValueOnce("x".repeat(1001));
    vi.mocked(hRetry.ctx.ui.select).mockResolvedValueOnce("重新输入");
    vi.mocked(hRetry.ctx.ui.input).mockResolvedValueOnce("valid");
    await requestNativeAnswer(
      hRetry.ctx,
      question({ kind: "information", frame: { ...question().frame, requestId: rid } }),
      () => true,
    );
    // The retry select title must also include requestId
    expect(vi.mocked(hRetry.ctx.ui.select).mock.calls.some(([t]) => t.includes(rid))).toBe(true);

    // Width check on all
    const allCalls = [
      ...vi.mocked(hAuth.ctx.ui.select).mock.calls,
      ...vi.mocked(hFirst.ctx.ui.select).mock.calls,
      ...vi.mocked(hBiz.ctx.ui.select).mock.calls,
      ...vi.mocked(hInfo.ctx.ui.input).mock.calls,
      ...vi.mocked(hRetry.ctx.ui.input).mock.calls,
      ...vi.mocked(hRetry.ctx.ui.select).mock.calls,
    ];
    for (const [t] of allCalls) {
      expect(t).not.toContain("\n");
      expect(visibleWidth(t)).toBeLessThanOrEqual(64);
    }
  });

  it.each([
    ["bidi", "a\u202Eb", "a\\u202eb"],
    ["control", "a\n\u001bb", "a\\u000a\\u001bb"],
    ["non-ASCII", "a😀b", "a\\u{1f600}b"],
    ["oversized cluster", `g${"\u093e".repeat(150)}`, "g\\u093e\\u093e"],
  ] as const)(
    "escapes %s requestId material visibly in the final native title",
    async (_kind, requestId, escapedPrefix) => {
      const { visibleWidth, stripTerminalSequences } = await import("@earendil-works/pi-tui");
      const h = harness();
      vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
      const answer = await requestNativeAnswer(
        h.ctx,
        question({ frame: { ...question().frame, requestId } }),
        () => true,
      );
      expect(answer?.outcome).toBe("approve");
      const titles = vi.mocked(h.ctx.ui.select).mock.calls.map(([t]) => t);
      expect(titles).toHaveLength(1);
      for (const title of titles) {
        expect(title).toContain(`请求 ${escapedPrefix}`);
        expect(stripTerminalSequences(title)).toBe(title);
        // eslint-disable-next-line no-control-regex
        expect(title).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
        expect(title).not.toContain("\n");
        expect(visibleWidth(title)).toBeLessThanOrEqual(64);
      }
    },
  );

  it("P2 RED: extremely long requestId is truncated so title stays ≤64 columns", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const h = harness();
    const longId = "r".repeat(200);
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    await requestNativeAnswer(
      h.ctx,
      question({ frame: { ...question().frame, requestId: longId } }),
      () => true,
    );
    const titles = vi.mocked(h.ctx.ui.select).mock.calls.map(([t]) => t);
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("请求 r");
    for (const t of titles) {
      expect(t).not.toContain("\n");
      expect(visibleWidth(t)).toBeLessThanOrEqual(64);
    }
  });

  it("holds the original lock through review cancel and releases it for a fresh native request", async () => {
    const h = harness();
    h.setAction("hold");
    const first = requestNativeAnswer(h.ctx, question(), () => true);
    expect(hasActiveNativeQuestion(h.ctx)).toBe(true);
    expect(await requestNativeAnswer(h.ctx, question(), () => true)).toBeUndefined();
    await vi.waitFor(() => {
      expect(h.custom).toHaveBeenCalledOnce();
    });
    h.drive("cancel");
    expect(await first).toBeUndefined();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
    h.setAction("review");
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    expect((await requestNativeAnswer(h.ctx, question(), () => true))?.outcome).toBe("approve");
  });
});

describe("original admission and opaque answer validation remain closed", () => {
  it("active C rejects A without replacement or a second suspension", async () => {
    const h = harness();
    h.setAction("hold");
    const pending = requestNativeAnswer(h.ctx, question(), () => true);
    await vi.waitFor(() => {
      expect(h.custom).toHaveBeenCalledOnce();
    });
    const widgets = vi.mocked(h.ctx.ui.setWidget).mock.calls.length;
    await showTaskList(h.ctx, createEmptyBoard());
    expect(h.custom).toHaveBeenCalledOnce();
    expect(h.ctx.ui.setWidget).toHaveBeenCalledTimes(widgets);
    expect(hasActiveNativeQuestion(h.ctx)).toBe(true);
    h.drive("cancel");
    expect(await pending).toBeUndefined();
  });

  it("native hide failure refuses before A preemption or scope/native UI", async () => {
    const h = harness();
    const lease = beginReadOnlyView(h.ctx)!;
    vi.mocked(h.ctx.ui.setWidget).mockImplementationOnce(() => {
      throw new Error("hide failed");
    });
    expect(await requestNativeAnswer(h.ctx, question(), () => true)).toBeUndefined();
    expect(lease.signal.aborted).toBe(false);
    lease.finish();
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
  });

  it("post-confirmation optional refresh and identity transport failures never discard the opaque carrier", async () => {
    const h = harness();
    vi.mocked(h.ctx.ui.select).mockImplementationOnce(async (_title, offered) => {
      expect(offered).toContain("允许上述范围");
      // Inject only after mandatory hide/review, not at native entry.
      vi.mocked(h.ctx.ui.setWidget).mockImplementation(() => {
        throw new Error("optional refresh failed");
      });
      vi.mocked(h.ctx.ui.setStatus).mockImplementation(() => {
        throw new Error("optional status failed");
      });
      return "允许上述范围";
    });
    const q = question();
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(answer?.outcome).toBe("approve");
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
  });
  it.each([
    "session",
    "leaf",
    "frame-version",
    "frame-session",
    "current",
    "ctx-signal",
    "foreign-signal",
  ] as const)("trusted admission still denies %s before any UI", async (reason) => {
    const h = harness();
    const q = question();
    const controller = new AbortController();
    if (reason === "session") vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("");
    if (reason === "leaf") vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue(null);
    if (reason === "frame-version") Object.assign(q.frame, { version: 2 });
    if (reason === "frame-session") Object.assign(q.frame, { sessionId: "other" });
    controller.abort();
    if (reason === "ctx-signal") Object.assign(h.ctx, { signal: controller.signal });
    expect(
      await requestNativeAnswer(
        h.ctx,
        q,
        () => reason !== "current",
        reason === "foreign-signal" ? controller.signal : undefined,
      ),
    ).toBeUndefined();
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
  });

  it.each([
    "owner",
    "sessionId",
    "requestId",
    "presentationId",
    "scopeDigest",
    "baseSnapshotEntryId",
    "baseSnapshotDigest",
  ] as const)("requireNativeAnswer still checks exact frame %s", async (field) => {
    const h = harness();
    const q = question();
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    expect(() => requireNativeAnswer(h.ctx, answer, { ...q.frame, [field]: "different" })).toThrow(
      "Frame mismatch",
    );
  });

  it.each(["ctx-signal", "foreign-signal", "replacement-ctx-signal", "manager"] as const)(
    "opaque answer cannot escape %s validation at use time",
    async (change) => {
      const h = harness();
      const q = question();
      const controller = new AbortController();
      if (change === "ctx-signal") Object.assign(h.ctx, { signal: controller.signal });
      vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
      const answer = await requestNativeAnswer(
        h.ctx,
        q,
        () => true,
        change === "foreign-signal" ? controller.signal : undefined,
      );
      expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
      if (change === "replacement-ctx-signal") Object.assign(h.ctx, { signal: controller.signal });
      if (change === "manager")
        Object.assign(h.ctx, { sessionManager: { ...h.ctx.sessionManager } });
      else controller.abort();
      expect(() => requireNativeAnswer(h.ctx, answer, q.frame)).toThrow(
        change === "manager" ? "Session mismatch" : "Request cancelled",
      );
      expect(() => requireNativeAnswer(h.ctx, structuredClone(answer), q.frame)).toThrow(
        "Unrecognized native answer",
      );
    },
  );

  it("concurrent original-map locks are manager identity scoped, not session text scoped", async () => {
    const first = harness();
    const second = harness();
    first.setAction("hold");
    const pending = requestNativeAnswer(first.ctx, question(), () => true);
    vi.mocked(second.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    expect((await requestNativeAnswer(second.ctx, question(), () => true))?.outcome).toBe(
      "approve",
    );
    expect(hasActiveNativeQuestion(first.ctx)).toBe(true);
    first.drive("cancel");
    expect(await pending).toBeUndefined();
    expect(hasActiveNativeQuestion(first.ctx)).toBe(false);
  });
});

describe("display-only context for formatted questions", () => {
  it("captures display material before asynchronous UI work and binds the original opaque answer", async () => {
    const h = harness();
    const material = {
      context: "ORIGINAL_CONTEXT",
      sections: [{ title: "原始栏目", markdown: "ORIGINAL_MATERIAL" }],
    };
    const q = question({ material });
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("允许上述范围");
    const pending = requestNativeAnswer(h.ctx, q, () => true);
    material.context = "MUTATED_CONTEXT";
    material.sections[0]!.markdown = "MUTATED_MATERIAL";
    const answer = await pending;
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    expect(vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0]).toContain("ORIGINAL_CONTEXT");
    expect(vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0]).not.toContain("MUTATED_CONTEXT");
    expect(h.rendered.flat().join("\n")).toContain("ORIGINAL_MATERIAL");
    expect(h.rendered.flat().join("\n")).not.toContain("MUTATED_MATERIAL");
    expect(() => requireNativeAnswer(h.ctx, structuredClone(answer), q.frame)).toThrow(
      "Unrecognized native answer",
    );
  });

  it("cannot advance from formatted browsing directly to a native decision without rendered original pages", async () => {
    const h = harness();
    h.setAction("hold");
    const q = question({
      material: { context: "原始问题", sections: [{ title: "简介", markdown: "一句话" }] },
    });
    const pending = requestNativeAnswer(h.ctx, q, () => true);
    await vi.waitFor(() => {
      expect(h.custom).toHaveBeenCalledOnce();
    });
    const view = h.components[0];
    view?.handleInput?.("\r");
    for (let i = 0; i < 100; i++) view?.handleInput?.("\r");
    expect(h.ctx.ui.select).not.toHaveBeenCalled();
    expect(h.ctx.ui.input).not.toHaveBeenCalled();
    h.drive("cancel");
    expect(await pending).toBeUndefined();
    expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
  });

  it("retains question context during input retry without echoing rejected text or prefilling", async () => {
    const h = harness();
    const rejected = "SENSITIVE_BAD_DATE";
    const q = question({
      kind: "information",
      informationFormat: "date",
      informationValidator: (value) => value === "2024-02-29",
      material: {
        context: "文档标签日期",
        sections: [{ title: "信息要求", markdown: "日期 YYYY-MM-DD" }],
      },
    });
    vi.mocked(h.ctx.ui.input).mockResolvedValueOnce(rejected).mockResolvedValueOnce("2024-02-29");
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("重新输入");
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    expect(answer?.value).toBe("2024-02-29");
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
    for (const [title, placeholder] of vi.mocked(h.ctx.ui.input).mock.calls) {
      expect(title).toContain("问题：文档标签日期");
      expect(placeholder).toBeUndefined();
    }
    const allUi = JSON.stringify([
      h.rendered,
      vi.mocked(h.ctx.ui.select).mock.calls,
      vi.mocked(h.ctx.ui.input).mock.calls,
    ]);
    expect(allUi).not.toContain(rejected);
    expect(h.custom).toHaveBeenCalledOnce();
  });

  it.each(["ctx", "foreign"] as const)(
    "cancels formatted reading on the %s abort signal with no native control",
    async (source) => {
      const h = harness();
      h.setAction("hold");
      const controller = new AbortController();
      if (source === "ctx") Object.assign(h.ctx, { signal: controller.signal });
      const q = question({
        material: { context: "只读材料", sections: [{ title: "范围", markdown: "完整内容" }] },
      });
      const pending = requestNativeAnswer(
        h.ctx,
        q,
        () => true,
        source === "foreign" ? controller.signal : undefined,
      );
      await vi.waitFor(() => {
        expect(h.custom).toHaveBeenCalledOnce();
      });
      controller.abort();
      expect(await pending).toBeUndefined();
      expect(h.ctx.ui.select).not.toHaveBeenCalled();
      expect(h.ctx.ui.input).not.toHaveBeenCalled();
      expect(hasActiveNativeQuestion(h.ctx)).toBe(false);
      expect(h.components[0]?.render(80)).toEqual([]);
    },
  );

  it("bounds and escapes rich option excerpts without accepting an unoffered ordinal alias", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const h = harness();
    const q = question({
      kind: "choice",
      options: ["同一前缀".repeat(100), "同一前缀".repeat(99) + "尾部", "code\n\u001b[31m\u202e"],
      material: {
        context: "\u202e很长的具体问题".repeat(30),
        sections: [{ title: "原始选项", markdown: "保留全文" }],
      },
    });
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("选项 2");
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
    const [title, labels] = vi.mocked(h.ctx.ui.select).mock.calls[0] ?? ["", []];
    expect(title.split("\n")).toHaveLength(2);
    expect(title.split("\n").every((line) => visibleWidth(line) <= 64)).toBe(true);
    expect(title).not.toContain("\u202e");
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => visibleWidth(label) <= 32)).toBe(true);
    expect(labels.join("")).not.toContain("\u001b");
    expect(labels.join("")).not.toContain("\u202e");
  });

  it("shows ordinal plus option meaning but returns the exact original colliding value", async () => {
    const h = harness();
    const q = question({
      kind: "choice",
      options: ["Later", " 稍后决定 ", "重新核对全文"],
      material: {
        context: "选择原始业务项",
        sections: [{ title: "选项", markdown: "只读选项说明" }],
      },
    });
    vi.mocked(h.ctx.ui.select).mockImplementationOnce(async (_title, labels) => labels[2]);
    const answer = await requestNativeAnswer(h.ctx, q, () => true);
    const labels = vi.mocked(h.ctx.ui.select).mock.calls[0]?.[1] ?? [];
    expect(labels[2]).toBe('选项 2 · " 稍后决定 "');
    expect(new Set(labels).size).toBe(labels.length);
    expect(answer?.value).toBe(" 稍后决定 ");
    expect(requireNativeAnswer(h.ctx, answer, q.frame)).toBe(answer);
  });
  it("keeps the original identity header and adds only one safe bounded question line", async () => {
    const { visibleWidth } = await import("@earendil-works/pi-tui");
    const h = harness();
    const q = question({
      material: {
        context: "核对本地代码范围\n不得伪造新标题\u001b[31m",
        sections: [{ title: "用途", markdown: "这是只读预览，仍需核对原文。" }],
      },
    });
    vi.mocked(h.ctx.ui.select).mockResolvedValueOnce("稍后决定");
    expect(await requestNativeAnswer(h.ctx, q, () => true)).toBeUndefined();
    const title = vi.mocked(h.ctx.ui.select).mock.calls[0]?.[0] ?? "missing";
    const lines = title.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("范围确认（全文已核对） — 请求 request");
    expect(lines[1]).toContain("核对本地代码范围");
    expect(visibleWidth(lines[1] ?? "")).toBeLessThanOrEqual(64);
    expect(lines[1]).not.toContain("\u001b");
    expect(h.rendered.flat().join("\n")).toContain("Full·original·body");
    expect(h.rendered.flat().join("\n")).toContain("格式化浏览");
  });
});
