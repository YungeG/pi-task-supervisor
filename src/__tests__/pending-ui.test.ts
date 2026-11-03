import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSupervisorComponents } from "../index";
import { currentRuntime, scopedAPI, type TaskRuntime } from "../runtime";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { installCustomUI, ESC, ENTER } from "./helpers/custom-ui";
import { localProposal } from "./helpers/preflight";

const originalKey = process.env.PI_TASK_SUPERVISOR_PENDING_KEY;
afterEach(() => {
  if (originalKey === undefined) delete process.env.PI_TASK_SUPERVISOR_PENDING_KEY;
  else process.env.PI_TASK_SUPERVISOR_PENDING_KEY = originalKey;
  vi.restoreAllMocks();
});

it("registers a scoped read-only pending shortcut without activating or dispatching work", () => {
  delete process.env.PI_TASK_SUPERVISOR_PENDING_KEY;
  const mock = createMockAPI();
  scopedAPI(mock.api, registerSupervisorComponents);
  expect(mock.registerShortcut).toHaveBeenCalledOnce();
  expect(mock.registerShortcut).toHaveBeenCalledWith(
    "ctrl+shift+y",
    expect.objectContaining({
      description: expect.stringContaining("只读"),
      handler: expect.any(Function),
    }),
  );
  expect(mock.appendEntry).not.toHaveBeenCalled();
  expect(mock.sendMessage).not.toHaveBeenCalled();
  expect(mock.sendUserMessage).not.toHaveBeenCalled();
});

it.each(["off", "", "enter", "ctrl+c", "ctrl+shift+Y", "ctrl+shift+yy"])(
  "disables an off or invalid configured shortcut without falling back: %s",
  (key) => {
    process.env.PI_TASK_SUPERVISOR_PENDING_KEY = key;
    const mock = createMockAPI();
    scopedAPI(mock.api, registerSupervisorComponents);
    expect(mock.registerShortcut).not.toHaveBeenCalled();
    expect(mock.sendMessage).not.toHaveBeenCalled();
    expect(mock.appendEntry).not.toHaveBeenCalled();
  },
);

it("accepts a configured modified letter and declines a busy shortcut without abort or control", async () => {
  process.env.PI_TASK_SUPERVISOR_PENDING_KEY = "ctrl+shift+q";
  const mock = createMockAPI();
  scopedAPI(mock.api, registerSupervisorComponents);
  expect(mock.registerShortcut).toHaveBeenCalledWith("ctrl+shift+q", expect.any(Object));
  const handler = mock.registerShortcut.mock.calls[0]![1].handler as (
    ctx: ExtensionContext,
  ) => Promise<void>;
  const ctx = createMockContext();
  vi.mocked(ctx.isIdle).mockReturnValue(false);
  await handler(ctx);
  expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("只读"), "info");
  expect(ctx.abort).not.toHaveBeenCalled();
  expect(mock.appendEntry).not.toHaveBeenCalled();
  expect(mock.sendMessage).not.toHaveBeenCalled();
});

function instance(id: string, generation: number) {
  delete process.env.PI_TASK_SUPERVISOR_PENDING_KEY;
  const mock = createMockAPI();
  const ctx = createMockContext();
  vi.mocked(ctx.sessionManager.getSessionId).mockReturnValue(id);
  let runtime: TaskRuntime | undefined;
  scopedAPI(mock.api, (api) => {
    registerSupervisorComponents(api);
    api.on("session_start", () => {
      runtime = currentRuntime();
      runtime.enabled = true;
      runtime.board.generation = generation;
      runtime.board.workflowStatus = "paused";
      runtime.board.pauseReason = id;
    });
  });
  const seed = mock.on.mock.calls.filter(([name]) => name === "session_start").at(-1)![1];
  seed({}, ctx);
  const shortcut = mock.registerShortcut.mock.calls[0]![1].handler as (
    ctx: ExtensionContext,
  ) => Promise<void>;
  const settled = mock.on.mock.calls.filter(([name]) => name === "agent_settled").at(-1)![1];
  return {
    mock,
    ctx,
    runtime: runtime!,
    shortcut: () => shortcut(ctx),
    settled: (aborted = false) => settled({ aborted }, ctx),
  };
}

it("opens the actual readonly confirmation view in the original runtime and cannot submit controls", async () => {
  const a = instance("pending-a", 23);
  const b = instance("pending-b", 47);
  const beforeA = structuredClone(a.runtime.board);
  const beforeB = structuredClone(b.runtime.board);
  const observed: TaskRuntime[] = [];
  const driver = installCustomUI(a.ctx, (d) => {
    observed.push(currentRuntime());
    expect(d.render()).toContain("确认与回应");
    for (const key of [ENTER, "a", "r", "s", " "]) d.press(key);
    d.press(ESC);
    d.press(ESC);
  });
  await a.shortcut();
  driver.assertNoScriptErrors();
  expect(observed).toEqual([a.runtime]);
  expect(driver.rendered.join("\n")).toContain("只读");
  expect(a.runtime.board).toEqual(beforeA);
  expect(b.runtime.board).toEqual(beforeB);
  expect(a.mock.appendEntry).not.toHaveBeenCalled();
  expect(b.mock.appendEntry).not.toHaveBeenCalled();
  expect(a.mock.sendMessage).not.toHaveBeenCalled();
  expect(a.mock.sendUserMessage).not.toHaveBeenCalled();
});

it("does not confuse sibling requests or restored branch epochs with the same generation", async () => {
  const a = instance("pending-branches", 12);
  a.runtime.board.workflowStatus = "waiting_for_decision";
  a.runtime.board.decision = {
    id: "branch-a-question",
    taskId: "owned-task",
    question: "请选择",
    whyUserOwned: "只记录选择",
    createdAt: "2026-11-02T00:00:00.000Z",
    spec: { version: 1, kind: "choice" },
    options: ["同一选项"],
  };
  await a.settled();
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(1);
  a.runtime.board.decision = { ...a.runtime.board.decision, id: "branch-b-question" };
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(2);
  expect(a.runtime.board.generation).toBe(12);
  vi.mocked(a.ctx.sessionManager.getLeafId).mockReturnValue("ordinary-descendant-leaf");
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(2);
  // Real session/tree restoration calls invalidateGoalCallbacks(), incrementing goalEpoch.
  a.runtime.goalEpoch++;
  await a.settled();
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(3);
  expect(a.mock.appendEntry).not.toHaveBeenCalled();
  expect(a.mock.sendMessage).not.toHaveBeenCalled();
  expect(a.mock.sendUserMessage).not.toHaveBeenCalled();
});

it("binds preflight notice deduplication to its real request and material identities", async () => {
  const a = instance("pending-preflight", 12);
  a.runtime.preflight = {
    version: 2,
    sessionId: "pending-preflight",
    preflightId: "owned-pending-preflight",
    goal: "只读待办夹具",
    phase: "awaiting_authorization",
    revision: 1,
    planId: "owned-pending-preflight.r1",
    planDigest: "a".repeat(64),
    proposal: structuredClone(localProposal),
    permissionRequest: { id: "00000000-0000-4000-8000-000000000001" },
  };
  await a.settled();
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(1);
  a.runtime.preflight.permissionRequest = { id: "00000000-0000-4000-8000-000000000002" };
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(2);
  a.runtime.preflight.planDigest = "b".repeat(64);
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(3);
  expect(a.mock.appendEntry).not.toHaveBeenCalled();
  expect(a.mock.sendMessage).not.toHaveBeenCalled();
  expect(a.mock.sendUserMessage).not.toHaveBeenCalled();
});

it("settled emits one readonly notice per changed state without opening UI or queuing Main", async () => {
  const a = instance("pending-notice", 12);
  const custom = vi.fn();
  Object.assign(a.ctx.ui, { custom });
  const original = structuredClone(a.runtime.board);
  await a.settled();
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledOnce();
  expect(a.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("待你处理（只读提示）"),
    "info",
  );
  expect(custom).not.toHaveBeenCalled();
  expect(a.runtime.board).toEqual(original);
  a.runtime.board.generation++;
  await a.settled();
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(2);
  a.runtime.board.generation++;
  await a.settled(true);
  expect(a.ctx.ui.notify).toHaveBeenCalledTimes(2);
  expect(a.mock.appendEntry).not.toHaveBeenCalled();
  expect(a.mock.sendMessage).not.toHaveBeenCalled();
  expect(a.mock.sendUserMessage).not.toHaveBeenCalled();
});
