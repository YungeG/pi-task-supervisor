import { afterEach, expect, it, vi } from "vitest";
import {
  getIdleActions,
  idleControlApi,
  idleControlContext,
  idleOutcome,
  type IdleActionLease,
} from "../host-idle";
import { bindRuntimeCallback, currentRuntime, scopedAPI, type TaskRuntime } from "../runtime";
import { createMockAPI, createMockContext } from "./helpers/mocks";

afterEach(() => vi.restoreAllMocks());

it.each([
  undefined,
  null,
  {},
  { version: 2 },
  { version: 1, state: 1, request() {} },
  { version: 1, state: () => ({}), request() {} },
  { version: 1, state: () => ({ phase: {}, pendingInputs: 0 }), request() {} },
  { version: 1, state: () => ({ phase: "idle", pendingInputs: -1 }), request() {} },
])("does not enable controls from an incomplete or unknown capability: %j", (value) => {
  const ctx = createMockContext();
  Object.assign(ctx, { idleActions: value });
  expect(getIdleActions(ctx)).toBeUndefined();
});
it("retains the actual host capability and fails closed on a stale getter", () => {
  const ctx = createMockContext();
  const api = { version: 1, state: () => ({ phase: "idle", pendingInputs: 0 }), request: vi.fn() };
  Object.assign(ctx, { idleActions: api });
  expect(getIdleActions(ctx)).toBe(api);
  Object.defineProperty(ctx, "idleActions", {
    get() {
      throw Error("stale");
    },
  });
  expect(getIdleActions(ctx)).toBeUndefined();
});
it.each([
  null,
  {},
  { status: "approved", actionId: "a" },
  { status: "started", actionId: "a" },
  { status: "started", actionId: "foreign", runId: "r", sessionId: "s" },
  { status: "started", actionId: "a", runId: "r", sessionId: "foreign" },
])("never treats an invalid/foreign receipt as delivery: %j", (value) => {
  expect(idleOutcome(value, "a", "s")).toMatchObject({ status: "unknown", actionId: "a" });
});
it("recognizes only original delivery outcomes and bounds optional reasons", () => {
  expect(
    idleOutcome({ status: "started", actionId: "a", runId: "r", sessionId: "s" }, "a", "s"),
  ).toEqual({ status: "started", actionId: "a", runId: "r", sessionId: "s" });
  expect(
    idleOutcome({ status: "cancelled", actionId: "a", reason: "x".repeat(200) }, "a", "s"),
  ).toEqual({ status: "cancelled", actionId: "a", reason: "x".repeat(100) });
  expect(idleOutcome({ status: "completed", actionId: "a", reason: {} }, "a", "s")).toEqual({
    status: "completed",
    actionId: "a",
  });
});
it("adapts only passive display while preserving the real leased blocking methods and guarded getters", async () => {
  const origin = createMockContext(),
    leased = createMockContext();
  const signal = new AbortController().signal;
  Object.assign(leased, { mode: "rpc", signal });
  vi.mocked(leased.ui.select).mockResolvedValue("actual leased choice");
  const entered = vi.fn();
  const context = idleControlContext(
    origin,
    {
      id: "a",
      context: leased,
      signal,
      isCurrent: () => true,
      dispatch: vi.fn(async () => ({ status: "completed" as const, actionId: "a" })),
    } satisfies IdleActionLease,
    entered,
  );
  expect(context.mode).toBe("rpc");
  expect(context.signal).toBe(signal);
  expect(context.sessionManager).toBe(leased.sessionManager);
  expect(context.isIdle).toBe(leased.isIdle);
  context.ui.notify("display");
  context.ui.setStatus("key", "value");
  context.ui.setWidget("key", ["line"]);
  context.ui.setWidget("key", () => ({ render: () => [], invalidate() {} }));
  expect(origin.ui.notify).toHaveBeenCalledWith("display");
  expect(leased.ui.notify).not.toHaveBeenCalled();
  expect(await context.ui.select("question", ["choice"])).toBe("actual leased choice");
  expect(entered).toHaveBeenCalledOnce();
  expect(origin.ui.select).not.toHaveBeenCalled();
  vi.mocked(origin.ui.notify).mockImplementation(() => {
    throw Error("display failed");
  });
  expect(() => {
    context.ui.notify("saved control survives");
  }).not.toThrow();
});
it("converts display-only notices but never swallows or forwards a business input", () => {
  const mock = createMockAPI(),
    ctx = createMockContext();
  const api = idleControlApi(mock.api, ctx);
  api.sendMessage(
    { customType: "continuous-tasks:notice", content: "notice", display: true },
    { triggerTurn: false },
  );
  expect(ctx.ui.notify).toHaveBeenCalledWith("notice", "info");
  expect(mock.sendMessage).not.toHaveBeenCalled();
  for (const [message, options] of [
    [
      { customType: "continuous-tasks:continue", content: "work", display: false },
      { triggerTurn: true },
    ],
    [
      { customType: "continuous-tasks:notice", content: "work", display: true },
      { triggerTurn: true },
    ],
    [
      { customType: "continuous-tasks:notice", content: "work", display: false },
      { triggerTurn: false },
    ],
    [{ customType: "continuous-tasks:notice", content: [], display: true }, { triggerTurn: false }],
  ] as const)
    expect(() => {
      api.sendMessage(
        { ...message, content: typeof message.content === "string" ? message.content : [] },
        options,
      );
    }).toThrow(/lease.dispatch/);
  expect(mock.sendMessage).not.toHaveBeenCalled();
});
it("binds a deferred callback and its awaits to its own runtime, not the caller's runtime", async () => {
  const first = createMockAPI(),
    second = createMockAPI();
  let a!: TaskRuntime, b!: TaskRuntime;
  let callback!: () => Promise<TaskRuntime>;
  let invoke!: () => Promise<TaskRuntime>;
  scopedAPI(first.api, () => {
    a = currentRuntime();
    callback = bindRuntimeCallback(async () => {
      await Promise.resolve();
      return currentRuntime();
    });
  });
  scopedAPI(second.api, () => {
    b = currentRuntime();
    invoke = bindRuntimeCallback(callback);
  });
  expect(a).not.toBe(b);
  expect(await invoke()).toBe(a);
});
