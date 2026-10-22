import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { goalFixture } from "./helpers/goal";
import { createMockTheme } from "./helpers/mocks";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { readGoalHistory, requestGoalTransition } from "../goal-lifecycle";
import { hasActiveNativeQuestion } from "../human-ui";
import { beginReadOnlyView } from "../ui-view-lifecycle";

it("pages archive metadata without hydrating raw receipts, including RPC read-only pages", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  for (let i = 0; i < 12; i++) {
    await f.command(`supervise Archived synthetic ${i}`);
    await f.command("stop");
  }
  const first = readGoalHistory(f.ctx);
  expect(first.items).toHaveLength(10);
  expect(first.nextCursor).toBe("10");
  const last = readGoalHistory(f.ctx, first.nextCursor);
  expect(last.items).toHaveLength(2);
  expect(last.nextCursor).toBeUndefined();
  const legacy = last.items.find((item) => item.goal === "Synthetic old goal");
  expect(legacy).toBeDefined();
  const detail = readGoalHistory(f.ctx, "0", legacy!.goalKey).items[0];
  expect(detail?.supervisor).not.toHaveProperty("receipts");
  const writes = f.entries().length;
  vi.mocked(f.ctx.ui.select)
    .mockResolvedValueOnce("下一页（只读）")
    .mockResolvedValueOnce("返回当前目标（不切换、不执行）");
  await f.command("history");
  Object.assign(f.ctx, { mode: "rpc" });
  vi.mocked(f.ctx.ui.notify).mockClear();
  await f.command("history page:10");
  expect(f.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("Synthetic old goal"),
    "info",
  );
  expect(f.entries()).toHaveLength(writes);
}, 30_000); // Twelve physical native transitions; coverage instrumentation is substantially slower.

it("reaches read-only history from the current board without swapping the selected runtime", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Current menu goal");
  const before = JSON.stringify(currentRuntime().goal);
  const writes = f.entries().length;
  vi.mocked(f.ctx.ui.select).mockImplementation(async (_title, options) => options[1]);
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, value) => value);
  let views = 0;
  const rendered: string[] = [];
  Object.assign(f.ctx.ui, {
    custom: vi.fn(
      (factory: any) =>
        new Promise((resolve) => {
          const component = factory(
            { terminal: { rows: 40 }, requestRender: vi.fn() },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          rendered.push(...component.render(120));
          views++;
          if (views === 1) {
            for (let i = 0; i < 3; i++) component.handleInput("\u001b[B");
            component.handleInput("\r");
          } else component.handleInput("\u001b");
        }),
    ),
  });
  await f.command("tasks");
  expect(views).toBe(2);
  expect(rendered.join("\n")).toContain("历史目标");
  expect(JSON.stringify(currentRuntime().goal)).toBe(before);
  expect(f.entries()).toHaveLength(writes);
});

it("closes an archived read-only view on actual session-tree restoration without replay or reader writes", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Readonly tree current");
  const key = readGoalHistory(f.ctx).items[0]!.goalKey;
  const writes = f.entries().length;
  const theme = createMockTheme();
  const opened = vi.fn();
  Object.assign(f.ctx.ui, {
    custom: vi.fn(
      (factory: any) =>
        new Promise((resolve) => {
          factory(
            { terminal: { rows: 40 }, requestRender: vi.fn() },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          opened();
        }),
    ),
  });
  const view = f.command(`history ${key}`);
  await vi.waitFor(() => {
    expect(opened).toHaveBeenCalled();
  });
  await f.fire("session_tree");
  await view;
  expect(f.entries()).toHaveLength(writes);
  expect(currentRuntime().goal?.current?.seed.goal).toBe("Readonly tree current");
  expect(currentRuntime().journalFault).toBeUndefined();
});

const fixtures: Awaited<ReturnType<typeof goalFixture>>[] = [];
beforeEach(() => {
  resetState();
});
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

it("discards an older restoration after a newer explicit goal stop while its read-only view is closing", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Held reader restore");
  const lease = beginReadOnlyView(f.ctx);
  expect(lease).toBeDefined();
  const oldRestore = f.fire("session_tree");
  await vi.waitFor(() => {
    expect(lease!.signal.aborted).toBe(true);
  });
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  const before = JSON.stringify(currentRuntime().goal);
  lease!.finish();
  await oldRestore;
  expect(JSON.stringify(currentRuntime().goal)).toBe(before);
  expect(currentRuntime().preflight?.phase).toBe("planning");
});

it.each(["empty", "cancel", "unknown", "picker-error", "viewer-error", "no-ui"])(
  "keeps history %s outcomes read-only and restores the current UI",
  async (mode) => {
    const f = await goalFixture();
    fixtures.push(f);
    if (mode !== "empty") await f.command("supervise Read-only failure handling");
    const writes = f.entries().length;
    const before = JSON.stringify(currentRuntime().goal);
    if (mode === "cancel") vi.mocked(f.ctx.ui.select).mockResolvedValue(undefined);
    if (mode === "picker-error")
      vi.mocked(f.ctx.ui.select).mockRejectedValue(new Error("Reader failure"));
    if (mode === "viewer-error")
      vi.mocked(f.ctx.ui.custom).mockRejectedValue(new Error("Viewer failure"));
    if (mode === "no-ui") Object.assign(f.ctx, { hasUI: false });
    const key = readGoalHistory(f.ctx).items[0]?.goalKey;
    await f.command(
      mode === "unknown"
        ? "history not-on-this-branch"
        : mode === "viewer-error"
          ? `history ${key}`
          : "history",
    );
    expect(f.entries()).toHaveLength(writes);
    expect(JSON.stringify(currentRuntime().goal)).toBe(before);
    expect(f.ctx.ui.notify).toHaveBeenCalled();
  },
);

it("does not open a reader over a genuine pending native archive question", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  let finish: ((value: string | undefined) => void) | undefined;
  vi.mocked(f.ctx.ui.select).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const transition = requestGoalTransition(f.api, f.ctx, {
    goal: "Native question owns the UI",
    intent: "supervise",
  });
  await vi.waitFor(() => {
    expect(hasActiveNativeQuestion(f.ctx)).toBe(true);
    expect(finish).toBeDefined();
  });
  const writes = f.entries().length;
  await f.command("history");
  expect(f.ctx.ui.notify).toHaveBeenCalledWith("请先完成当前确认。", "info");
  expect(f.entries()).toHaveLength(writes);
  finish!(undefined);
  expect((await transition).status).toBe("deferred");
});

it("lists only bounded historical metadata and displays a selected old board without switching the current goal or granting anything", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Current new goal");
  const index = readGoalHistory(f.ctx);
  expect(index.items).toHaveLength(1);
  expect(index.items[0]).not.toHaveProperty("board");
  expect(index.items[0]).toMatchObject({
    goal: "Synthetic old goal",
    counts: { total: 1, unfinished: 1 },
  });
  const key = index.items[0]!.goalKey;
  const board = getBoard();
  const goal = structuredClone(currentRuntime().goal);
  const writes = f.entries().length;
  const turns = f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn).length;
  const rendered: string[] = [];
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, value) => value);
  Object.assign(f.ctx.ui, {
    custom: vi.fn(
      (factory: any) =>
        new Promise((resolve) => {
          const component = factory(
            { terminal: { rows: 40 }, requestRender: vi.fn() },
            theme,
            new KeybindingsManager(TUI_KEYBINDINGS),
            resolve,
          );
          rendered.push(...component.render(120));
          component.handleInput("\r");
          rendered.push(...component.render(120));
          component.handleInput("\u001b");
          component.handleInput("\u001b");
        }),
    ),
  });
  await f.command(`history ${key}`);
  expect(rendered.join("\n")).toContain("历史目标");
  expect(rendered.join("\n")).toContain("Synthetic old goal");
  expect(getBoard()).toEqual(board);
  expect(currentRuntime().goal).toEqual(goal);
  expect(f.entries()).toHaveLength(writes);
  expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(
    turns,
  );
  expect(currentRuntime().supervisor).toBeUndefined();
});
