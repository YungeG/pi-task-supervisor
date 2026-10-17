import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureReadbackFrame } from "../human-control";
import { journalDigest } from "../human-journal";
import { decisionScope, projectBoardAnswer } from "../board-human";
import type { TUI } from "@earendil-works/pi-tui";
import {
  invalidateTaskWidget,
  showTaskList,
  suspendTaskWidget,
  TASK_WIDGET_KEY,
  updateTaskWidget,
} from "../board-ui";
import { closeReadOnlyView } from "../ui-view-lifecycle";
import { createEmptyBoard } from "../engine";
import { currentRuntime } from "../runtime";
import { resetState, setBoard, updateUI } from "../state";
import * as capture from "../ui-capture";
import { createMockAPI, createMockContext, createMockTheme } from "./helpers/mocks";
import { DOWN, ENTER, ESC, installCustomUI } from "./helpers/custom-ui";
import { registerEventHandlers } from "../events";
import { activeBoard, getHandler } from "./helpers/lifecycle";

const dirs: string[] = [];
beforeEach(() => {
  resetState();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function resident(ctx: ReturnType<typeof createMockContext>) {
  const factory = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)?.[1];
  if (typeof factory !== "function") throw new Error("Missing resident factory");
  return factory({} as TUI, createMockTheme());
}

it("zero-task public route renders absent and unknown history, complete long material, fixed entries and two-level return without writes", async () => {
  const ctx = createMockContext();
  const snapshot = createEmptyBoard();
  const text = Array.from({ length: 100 }, (_, i) => `ORIGINAL-LINE-${i}`).join("\n");
  currentRuntime().preflight = {
    version: 1,
    sessionId: "test-session",
    preflightId: "p",
    goal: text,
    phase: "planning",
    revision: 0,
  };
  const captured = vi.spyOn(capture, "captureUiBoardView");
  const ui = installCustomUI(ctx, (d) => {
    expect(d.render()).toContain("暂无任务");
    expect(d.render()).toContain("最终验收");
    d.open(1);
    // Navigation consumes only the frozen documents, never a second capture or journals.
    vi.mocked(ctx.sessionManager.getBranch).mockImplementation(() => {
      throw new Error("No navigation history");
    });
    vi.mocked(ctx.sessionManager.getSessionId).mockImplementation(() => {
      throw new Error("No navigation identity read");
    });
    d.scrollAll();
    expect(d.doneCount).toBe(0);
    expect(d.press(ESC)).toContain("筛选：全部任务");
    expect(d.doneCount).toBe(0);
    d.press(DOWN);
    d.press(ENTER);
    d.scrollAll();
    d.press(ESC);
    d.press(ESC);
  });
  const before = structuredClone(snapshot);
  await showTaskList(ctx, snapshot);
  ui.assertNoScriptErrors();
  expect(captured).toHaveBeenCalledOnce();
  const all = ui.rendered.join("\n");
  expect(all).toContain("当前方案/请求/选择快照");
  expect(all).toContain("历史回应不代表当前授权");
  for (let i = 0; i < 100; i++) expect(all.replace(/\n/g, "")).toContain(`ORIGINAL-LINE-${i}`);
  expect(all).toContain("当前请求");
  expect(all).toContain("最近已保存回应");
  expect(all).toContain("最终验收任务：未提供/未知");
  expect(snapshot).toEqual(before);
  expect(ctx.ui.select).not.toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBeUndefined();
});

it.each(["absent", "unknown"] as const)(
  "zero-task confirmation consumes frozen %s history instead of inventing an earlier answer",
  async (kind) => {
    const entries =
      kind === "unknown"
        ? [
            {
              type: "custom",
              customType: "continuous-tasks:event",
              data: { humanInteraction: { broken: true } },
            },
          ]
        : [];
    const ctx = createMockContext(entries);
    const ui = installCustomUI(ctx, (d) => {
      d.open(1);
      d.scrollAll();
      d.press(ESC);
      d.press(ESC);
    });
    await showTaskList(ctx, createEmptyBoard());
    ui.assertNoScriptErrors();
    expect(ui.rendered.join("\n")).toContain("确认与回应");
    expect(ui.rendered.join("\n")).toContain(kind === "unknown" ? "材料：未知" : "材料：无此记录");
    expect(ui.rendered.join("\n")).toContain("当前未记录执行前方案");
  },
);

it("suppresses direct captures, keeps status capture-once, resumes latest once and makes old resident factories/render inert", () => {
  const ctx = createMockContext();
  const snapshot = activeBoard();
  setBoard(snapshot);
  updateUI(ctx, snapshot);
  const old = resident(ctx);
  const oldFactory = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)![1];
  const summary = vi.spyOn(capture, "captureUiSummary");
  const token = suspendTaskWidget(ctx)!;
  expect(old.render(120)).toEqual([]);
  expect(typeof oldFactory).toBe("function");
  if (typeof oldFactory === "function")
    expect(oldFactory({} as TUI, createMockTheme()).render(120)).toEqual([]);
  vi.mocked(ctx.ui.setWidget).mockClear();
  updateTaskWidget(ctx, snapshot);
  expect(summary).not.toHaveBeenCalled();
  const latest = {
    ...snapshot,
    generation: snapshot.generation + 1,
    pauseReason: "Newest owner reason",
    workflowStatus: "paused" as const,
  };
  setBoard(latest);
  updateUI(ctx, latest);
  expect(summary).toHaveBeenCalledOnce();
  expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  expect(ctx.ui.setStatus).toHaveBeenCalled();
  token.release();
  token.release();
  expect(summary).toHaveBeenCalledTimes(2);
  expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
  expect(resident(ctx).render(200).join("\n")).toContain("Newest owner reason");
  const reads = vi.mocked(ctx.sessionManager.getSessionId).mock.calls.length;
  resident(ctx); // factory validates scope, render never does
  const component = resident(ctx);
  const boundaryReads = vi.mocked(ctx.sessionManager.getSessionId).mock.calls.length;
  expect(boundaryReads).toBeGreaterThan(reads);
  component.render(80);
  component.render(100);
  expect(ctx.sessionManager.getSessionId).toHaveBeenCalledTimes(boundaryReads);
});

it("independent overlapping tokens, managers, null anchor and cancelled signal are display-only", () => {
  const ctx = createMockContext();
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue(null);
  const signal = new AbortController();
  Object.assign(ctx, { signal: signal.signal });
  const a = suspendTaskWidget(ctx)!;
  const b = suspendTaskWidget(ctx)!;
  const other = createMockContext();
  updateTaskWidget(other, activeBoard());
  expect(typeof vi.mocked(other.ui.setWidget).mock.calls.at(-1)?.[1]).toBe("function");
  vi.mocked(ctx.ui.setWidget).mockClear();
  a.release();
  a.release();
  expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  signal.abort();
  b.release();
  expect(ctx.ui.setWidget).toHaveBeenCalledOnce();
});

it.each(["session", "branch", "manager", "epoch", "getter"] as const)(
  "old %s release cannot restore or clear the new screen",
  (change) => {
    const ctx = createMockContext();
    vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("anchor");
    const token = suspendTaskWidget(ctx)!;
    if (change === "session")
      vi.mocked(ctx.sessionManager.getSessionId).mockReturnValue("new-session");
    if (change === "branch") vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("new-branch");
    if (change === "manager")
      Object.assign(ctx, { sessionManager: createMockContext().sessionManager });
    if (change === "epoch") invalidateTaskWidget(ctx);
    if (change === "getter")
      vi.mocked(ctx.sessionManager.getSessionId).mockImplementation(() => {
        throw new Error("transport unavailable");
      });
    vi.mocked(ctx.ui.setWidget).mockClear();
    expect(() => {
      token.release();
    }).not.toThrow();
    token.release();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  },
);

it("release permits original nonnull anchor ancestry without requiring unchanged board generation", () => {
  const ctx = createMockContext();
  const anchor = ctx.sessionManager.getLeafId()!;
  const token = suspendTaskWidget(ctx)!;
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("child");
  vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([{ id: anchor } as any]);
  const summary = vi.spyOn(capture, "captureUiSummary");
  token.release();
  expect(summary).toHaveBeenCalledOnce();
});

it.each([null, "root"])(
  "a suspension on left cannot restore right using an older %s publication anchor",
  (publicationAnchor) => {
    const ctx = createMockContext([
      { type: "custom", id: "root", parentId: null },
      { type: "custom", id: "left", parentId: "root" },
    ]);
    vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue(publicationAnchor);
    updateUI(ctx, activeBoard());
    vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("left");
    const token = suspendTaskWidget(ctx)!;
    const right = createMockContext([
      { type: "custom", id: "root", parentId: null },
      { type: "custom", id: "right", parentId: "root" },
    ]);
    vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("right");
    vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(right.sessionManager.getBranch());
    const captureSummary = vi.spyOn(capture, "captureUiSummary");
    vi.mocked(ctx.ui.setWidget).mockClear();
    vi.mocked(ctx.ui.setStatus).mockClear();
    token.release();
    expect(captureSummary).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  },
);

it("a deferred resident factory checks its own captured branch, not an earlier common epoch", () => {
  const ctx = createMockContext([
    { type: "custom", id: "root", parentId: null },
    { type: "custom", id: "left", parentId: "root" },
  ]);
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("root");
  updateUI(ctx, activeBoard());
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("left");
  updateUI(ctx, activeBoard());
  const factory = vi.mocked(ctx.ui.setWidget).mock.calls.at(-1)![1];
  if (typeof factory !== "function") throw new Error("Missing left publication");
  const right = createMockContext([
    { type: "custom", id: "root", parentId: null },
    { type: "custom", id: "right", parentId: "root" },
  ]);
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("right");
  vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(right.sessionManager.getBranch());
  expect(factory({} as TUI, createMockTheme()).render(120)).toEqual([]);
});

it("an A factory delayed into a sibling branch cancels despite the common display epoch", async () => {
  const ctx = createMockContext([
    { type: "custom", id: "root", parentId: null },
    { type: "custom", id: "left", parentId: "root" },
  ]);
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("root");
  updateUI(ctx, activeBoard());
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("left");
  const right = createMockContext([
    { type: "custom", id: "root", parentId: null },
    { type: "custom", id: "right", parentId: "root" },
  ]);
  const ui = installCustomUI(ctx);
  const construct = ui.custom.getMockImplementation()!;
  ui.custom.mockImplementationOnce((factory) => {
    vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("right");
    vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(right.sessionManager.getBranch());
    return construct(factory);
  });
  const pending = showTaskList(ctx, activeBoard());
  try {
    await vi.waitFor(() => {
      expect(ui.custom).toHaveBeenCalledOnce();
    });
    expect(ui.doneCount).toBe(1);
    expect(ui.render()).toBe("");
  } finally {
    await closeReadOnlyView(ctx);
    await pending;
  }
});

it("an uncertain live epoch keeps its active suppression instead of replacing it", () => {
  const ctx = createMockContext([
    { type: "custom", id: "anchor", parentId: null },
    { type: "custom", id: "child", parentId: "anchor" },
  ]);
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("anchor");
  const token = suspendTaskWidget(ctx)!;
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("child");
  vi.mocked(ctx.sessionManager.getBranch).mockImplementation(() => {
    throw new Error("Transient identity read failure");
  });
  vi.mocked(ctx.ui.setWidget).mockClear();
  const summary = vi.spyOn(capture, "captureUiSummary");
  updateTaskWidget(ctx, activeBoard());
  expect(summary).not.toHaveBeenCalled();
  expect(vi.mocked(ctx.ui.setWidget).mock.calls.every(([, value]) => value === undefined)).toBe(
    true,
  );
  token.release();
});

it("branch change during mandatory hide does not open A under a newly captured scope", async () => {
  const ctx = createMockContext([
    { type: "custom", id: "root", parentId: null },
    { type: "custom", id: "left", parentId: "root" },
  ]);
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("root");
  updateUI(ctx, activeBoard());
  vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("left");
  const right = createMockContext([
    { type: "custom", id: "root", parentId: null },
    { type: "custom", id: "right", parentId: "root" },
  ]);
  vi.mocked(ctx.ui.setWidget).mockImplementationOnce(() => {
    vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue("right");
    vi.mocked(ctx.sessionManager.getBranch).mockReturnValue(right.sessionManager.getBranch());
  });
  const ui = installCustomUI(ctx, (d) => {
    d.press(ESC);
  });
  await showTaskList(ctx, activeBoard());
  ui.assertNoScriptErrors();
  expect(ui.custom).not.toHaveBeenCalled();
});

it("hide failure opens neither custom nor native UI and adds no journal fault", async () => {
  const ctx = createMockContext();
  const ui = installCustomUI(ctx);
  vi.mocked(ctx.ui.setWidget).mockImplementation(() => {
    throw new Error("hide failed");
  });
  await showTaskList(ctx, activeBoard());
  expect(ui.custom).not.toHaveBeenCalled();
  expect(ctx.ui.select).not.toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBeUndefined();
  vi.mocked(ctx.ui.setWidget).mockReset();
  updateTaskWidget(ctx, activeBoard());
  expect(resident(ctx).render(120).length).toBeGreaterThan(0);
});

it.each(["capture", "custom"] as const)(
  "%s failure returns an unavailable notice, releases admission and never falls back to a partial list",
  async (failure) => {
    const ctx = createMockContext();
    const ui = installCustomUI(ctx);
    if (failure === "capture")
      vi.spyOn(capture, "captureUiBoardView").mockImplementationOnce(() => {
        throw new Error("capture failed");
      });
    else ui.custom.mockRejectedValueOnce(new Error("custom failed"));
    await showTaskList(ctx, activeBoard());
    expect(ctx.ui.notify).toHaveBeenCalledWith("看板暂不可用，请重新打开。", "info");
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(currentRuntime().journalFault).toBeUndefined();
    const next = installCustomUI(ctx, (d) => {
      d.press(ESC);
    });
    await showTaskList(ctx, activeBoard());
    next.assertNoScriptErrors();
    expect(next.custom).toHaveBeenCalledOnce();
  },
);

it("duplicate A is rejected; cancellation actually joins and late callbacks cannot finish twice", async () => {
  const ctx = createMockContext();
  const ui = installCustomUI(ctx);
  const pending = showTaskList(ctx, activeBoard());
  await vi.waitFor(() => {
    expect(ui.custom).toHaveBeenCalledOnce();
  });
  await showTaskList(ctx, activeBoard());
  expect(ui.custom).toHaveBeenCalledOnce();
  await closeReadOnlyView(ctx);
  await pending;
  ui.press(ESC);
  ui.press(ENTER);
  expect(ui.doneCount).toBe(1);
  expect(ui.render()).toBe("");
});

it("abort before the actual factory still completes once and releases A", async () => {
  const ctx = createMockContext();
  const signal = new AbortController();
  Object.assign(ctx, { signal: signal.signal });
  const ui = installCustomUI(ctx);
  const custom = ui.custom.getMockImplementation()!;
  ui.custom.mockImplementationOnce((factory: any) => {
    signal.abort();
    return custom(factory);
  });
  await showTaskList(ctx, activeBoard());
  expect(ui.doneCount).toBe(1);
  expect(ui.render()).toBe("");
  await closeReadOnlyView(ctx);
});

it.each(["session_start", "session_tree", "session_shutdown"])(
  "%s invalidates before abort and awaits actual custom settlement before original lifecycle publication",
  async (event) => {
    const ctx = createMockContext();
    const mock = createMockAPI();
    registerEventHandlers(mock.api);
    const ui = installCustomUI(ctx);
    const custom = ui.custom.getMockImplementation()!;
    let join: (() => void) | undefined;
    ui.custom.mockImplementationOnce(
      (factory: any) =>
        new Promise((resolve) => {
          void custom((tui: any, theme: any, keys: any, done: any) =>
            factory(tui, theme, keys, () => {
              done();
              join = () => {
                resolve(undefined);
              };
            }),
          );
        }),
    );
    const reader = showTaskList(ctx, activeBoard());
    await vi.waitFor(() => {
      expect(ui.custom).toHaveBeenCalledOnce();
    });
    const summary = vi.spyOn(capture, "captureUiSummary");
    const count = vi.mocked(ctx.ui.setWidget).mock.calls.length;
    let completed = false;
    const lifecycle = Promise.resolve(getHandler(mock, event)({}, ctx)).then(() => {
      completed = true;
    });
    await vi.waitFor(() => {
      expect(join).toBeDefined();
    });
    expect(completed).toBe(false);
    expect(summary).not.toHaveBeenCalled();
    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(count);
    join!();
    await reader;
    await lifecycle;
    expect(completed).toBe(true);
    expect(summary).toHaveBeenCalledTimes(event === "session_shutdown" ? 0 : 2);
    const calls = vi.mocked(ctx.ui.setWidget).mock.calls;
    expect(calls.every(([key]) => key === TASK_WIDGET_KEY)).toBe(true);
    const after = calls.length;
    ui.press(ESC);
    expect(ctx.ui.setWidget).toHaveBeenCalledTimes(after);
  },
);

it("public confirmation route retains the real cleared branch response, separates a current request and refuses corrupt latest without rewriting durable bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coordination-history-"));
  dirs.push(dir);
  const session = SessionManager.create(dir, join(dir, "sessions"));
  session.appendMessage({
    role: "user",
    content: "Synthetic SDK-boundary fixture only",
    timestamp: 1,
  });
  const ctx = createMockContext();
  Object.defineProperty(ctx, "sessionManager", { configurable: true, get: () => session });
  const request = {
    id: "old",
    taskId: "t-1.1",
    question: "Original request",
    whyUserOwned: "Original why",
    createdAt: "now",
    spec: {
      version: 1 as const,
      kind: "authorization" as const,
      scope: "Original scope",
      prohibitions: ["Original prohibition"],
    },
  };
  const board = {
    ...activeBoard(),
    decision: request,
    workflowStatus: "waiting_for_decision" as const,
  };
  session.appendCustomEntry("continuous-tasks:snapshot", board);
  const frame = captureReadbackFrame(ctx, "board", request.id, decisionScope(request), board);
  const id = session.appendCustomEntry("continuous-tasks:event", {
    type: "resolve_decision",
    id: request.id,
    outcome: "approve",
    answer: "Original answer",
    humanInteraction: frame,
  });
  session.appendCustomEntry("continuous-tasks:human-readback", {
    version: 1,
    controlEntryId: id,
    controlDigest: journalDigest(session.getEntry(id)),
    frame,
  });
  const cleared = projectBoardAnswer(board, {
    id: request.id,
    outcome: "approve",
    answer: "Original answer",
  });
  const snapshots = [
    cleared,
    {
      ...board,
      decision: { ...request, id: "new", spec: { ...request.spec, scope: "Current-only scope" } },
    },
  ];
  for (const snapshot of snapshots) {
    const file = session.getSessionFile()!;
    const before = readFileSync(file);
    const ui = installCustomUI(ctx, (d) => {
      d.open(1);
      d.scrollAll();
      d.press(ESC);
      d.press(ESC);
    });
    await showTaskList(ctx, snapshot);
    ui.assertNoScriptErrors();
    const all = ui.rendered.join("\n");
    for (const expected of ["Original scope", "Original prohibition", "Original answer", id])
      expect(all).toContain(expected);
    expect(all).toContain(snapshot === cleared ? "当前未记录看板请求" : "Current-only scope");
    expect(readFileSync(file)).toEqual(before);
  }
  session.appendCustomEntry("continuous-tasks:event", {
    type: "resolve_decision",
    id: "bad-latest",
    outcome: "approve",
    answer: "Unconfirmed",
    humanInteraction: { ...frame, requestId: "bad-latest" },
  });
  const before = readFileSync(session.getSessionFile()!);
  const ui = installCustomUI(ctx, (d) => {
    d.open(1);
    d.scrollAll();
    d.press(ESC);
    d.press(ESC);
  });
  await showTaskList(ctx, cleared);
  ui.assertNoScriptErrors();
  expect(ui.rendered.join("\n")).toContain("材料：未知");
  expect(ui.rendered.join("\n")).not.toContain("Original answer");
  expect(ui.rendered.join("\n")).not.toContain("Unconfirmed");
  expect(readFileSync(session.getSessionFile()!)).toEqual(before);
});

it("real board filtering and detail-return retain the frozen capture while owner facts change", async () => {
  const ctx = createMockContext();
  const ready = activeBoard().tasks[0]!;
  const snapshot = {
    ...activeBoard(),
    tasks: [
      ready,
      { ...ready, id: "completed", title: "Frozen ended title", status: "done" as const },
    ],
  };
  const captured = vi.spyOn(capture, "captureUiBoardView");
  const ui = installCustomUI(ctx, (d) => {
    snapshot.tasks[1]!.title = "Mutated owner title";
    d.press("f");
    d.press(DOWN);
    d.press(DOWN);
    const filtered = d.press(ENTER);
    expect(filtered).toContain("筛选：已结束");
    expect(filtered).not.toContain("Approved work");
    d.open(4);
    d.scrollAll();
    expect(d.press(ESC)).toContain("筛选：已结束");
    expect(d.doneCount).toBe(0);
    d.press(ESC);
  });
  await showTaskList(ctx, snapshot);
  ui.assertNoScriptErrors();
  expect(captured).toHaveBeenCalledOnce();
  expect(ui.rendered.join("\n")).toContain("Frozen ended title");
  expect(ui.rendered.join("\n")).not.toContain("Mutated owner title");
  expect(ui.doneCount).toBe(1);
});

it("old final release cannot refresh or clear a newer epoch publication", () => {
  const ctx = createMockContext();
  const old = suspendTaskWidget(ctx)!;
  invalidateTaskWidget(ctx);
  updateTaskWidget(ctx, activeBoard());
  const current = resident(ctx);
  const rendered = current.render(120);
  const summary = vi.spyOn(capture, "captureUiSummary");
  vi.mocked(ctx.ui.setWidget).mockClear();
  old.release();
  old.release();
  expect(summary).not.toHaveBeenCalled();
  expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  expect(current.render(120)).toEqual(rendered);
});

it("custom failure after factory construction disposes A and ignores queued input/abort", async () => {
  const ctx = createMockContext();
  const controller = new AbortController();
  Object.assign(ctx, { signal: controller.signal });
  const ui = installCustomUI(ctx);
  const custom = ui.custom.getMockImplementation()!;
  ui.custom.mockImplementationOnce((factory: any) => {
    void custom(factory);
    throw new Error("host failed after construction");
  });
  await showTaskList(ctx, activeBoard());
  ui.press(ESC);
  ui.press(ENTER);
  controller.abort();
  expect(ui.doneCount).toBe(0);
  expect(ui.render()).toBe("");
  await closeReadOnlyView(ctx);
  expect(ctx.ui.notify).toHaveBeenCalledWith("看板暂不可用，请重新打开。", "info");
});

it("regression: script assertion failure before done is caught by assertNoScriptErrors", async () => {
  const ctx = createMockContext();
  const ui = installCustomUI(ctx, () => {
    expect(false, "I2A-SCRIPT-ERROR-BEFORE-DONE").toBe(true);
  });
  await showTaskList(ctx, activeBoard());
  expect(() => {
    ui.assertNoScriptErrors();
  }).toThrow("I2A-SCRIPT-ERROR-BEFORE-DONE");
});

it("regression: script assertion failure after done is caught by assertNoScriptErrors", async () => {
  const ctx = createMockContext();
  const ui = installCustomUI(ctx, (d) => {
    d.press(ESC);
    expect(false, "I2A-SCRIPT-ERROR-AFTER-DONE").toBe(true);
  });
  await showTaskList(ctx, activeBoard());
  expect(() => {
    ui.assertNoScriptErrors();
  }).toThrow("I2A-SCRIPT-ERROR-AFTER-DONE");
});
