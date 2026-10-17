import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginReadOnlyView, closeReadOnlyView } from "../ui-view-lifecycle";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { createScopeReview } from "../human-scope-view";
import type { UiViewEnvironment } from "../ui-view";
import { createMockTheme } from "./helpers/mocks";

function context(): ExtensionContext {
  return {
    sessionManager: { getSessionId: () => "synthetic-session", getLeafId: () => null },
    signal: undefined,
  } as unknown as ExtensionContext;
}

describe("read-only view lifecycle", () => {
  it("sentinel: close aborts but joins real finish; duplicate and stale finishes are harmless", async () => {
    const ctx = context();
    const first = beginReadOnlyView(ctx)!;
    expect(first).toBeDefined();
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    let closed = false;
    const closing = closeReadOnlyView(ctx).then(() => {
      closed = true;
    });
    expect(first.signal.aborted).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    first.finish();
    first.finish();
    await closing;
    expect(closed).toBe(true);
    const second = beginReadOnlyView(ctx)!;
    expect(second).toBeDefined();
    first.finish();
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    expect(second.signal.aborted).toBe(false);
    second.finish();
    await closeReadOnlyView(ctx);
  });

  it("admits a null-leaf reader without touching any UI, journal, or owner API", () => {
    const manager = {
      getSessionId: vi.fn(() => "synthetic-session"),
      getLeafId: vi.fn(() => null),
    };
    const ctx = new Proxy(
      { sessionManager: manager, signal: undefined },
      {
        get(target, prop) {
          if (prop !== "sessionManager" && prop !== "signal")
            throw new Error(`Unexpected access: ${String(prop)}`);
          return target[prop];
        },
      },
    ) as unknown as ExtensionContext;
    const lease = beginReadOnlyView(ctx)!;
    expect(lease).toBeDefined();
    expect(lease.signal.aborted).toBe(false);
    expect(manager.getSessionId).toHaveBeenCalledTimes(1);
    expect(manager.getLeafId).toHaveBeenCalledTimes(1);
    lease.finish();
  });

  it.each([null, undefined, "manager", 0, false])("rejects unavailable manager %s", (manager) => {
    const ctx = { sessionManager: manager } as unknown as ExtensionContext;
    expect(beginReadOnlyView(ctx)).toBeUndefined();
  });

  it.each([null, undefined, "", "   ", 10])("rejects unavailable sessionId %s", (sessionId) => {
    const ctx = {
      sessionManager: { getSessionId: () => sessionId, getLeafId: () => null },
    } as unknown as ExtensionContext;
    expect(beginReadOnlyView(ctx)).toBeUndefined();
  });

  it.each([undefined, "", 1, false])("rejects unavailable leaf identity %s", (leafId) => {
    const ctx = {
      sessionManager: { getSessionId: () => "session", getLeafId: () => leafId },
    } as unknown as ExtensionContext;
    expect(beginReadOnlyView(ctx)).toBeUndefined();
  });

  it("accepts a normal leaf with no operation signal", () => {
    const ctx = context();
    ctx.sessionManager.getLeafId = () => "leaf";
    const lease = beginReadOnlyView(ctx)!;
    expect(lease).toBeDefined();
    lease.finish();
  });

  it.each(["sessionManager", "signal", "getSessionId", "getLeafId"])(
    "fails closed when %s getter throws, without retaining a lease",
    (property) => {
      const ctx = context();
      const target = property.startsWith("get") ? ctx.sessionManager : ctx;
      const descriptor = Object.getOwnPropertyDescriptor(target, property);
      Object.defineProperty(target, property, {
        configurable: true,
        get() {
          throw new Error("identity unavailable");
        },
      });
      expect(beginReadOnlyView(ctx)).toBeUndefined();
      if (descriptor) Object.defineProperty(target, property, descriptor);
      const lease = beginReadOnlyView(ctx)!;
      expect(lease).toBeDefined();
      lease.finish();
    },
  );

  it("rejects already-aborted context without installing a listener or occupying the manager", () => {
    const ctx = context();
    const controller = new AbortController();
    controller.abort();
    ctx.signal = controller.signal;
    const add = vi.spyOn(controller.signal, "addEventListener");
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    ctx.signal = undefined;
    const lease = beginReadOnlyView(ctx)!;
    expect(lease).toBeDefined();
    lease.finish();
  });

  it("context abort is cancellation, not completion, and finish removes the exact listener", async () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const lease = beginReadOnlyView(ctx)!;
    const listener = add.mock.calls[0]?.[1];
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    controller.abort();
    expect(lease.signal.aborted).toBe(true);
    expect(beginReadOnlyView({ ...ctx, signal: undefined })).toBeUndefined();
    let closed = false;
    const closing = closeReadOnlyView(ctx).then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    lease.finish();
    lease.finish();
    await closing;
    expect(remove).toHaveBeenCalledExactlyOnceWith("abort", listener);
  });

  it("rechecks context abort after installing the listener", () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const add = controller.signal.addEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((...args) => {
      add(...args);
      controller.abort();
    });
    const lease = beginReadOnlyView(ctx)!;
    expect(lease.signal.aborted).toBe(true);
    lease.finish();
  });

  it("normal finish removes propagation without aborting either the old or later view", () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const first = beginReadOnlyView(ctx)!;
    first.finish();
    const second = beginReadOnlyView({ ...ctx, signal: undefined })!;
    controller.abort();
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    first.finish();
    expect(beginReadOnlyView({ ...ctx, signal: undefined })).toBeUndefined();
    second.finish();
  });

  it("a queued old abort callback cannot cancel or clear a newer lease", () => {
    const ctx = context();
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const add = vi.spyOn(controller.signal, "addEventListener");
    const first = beginReadOnlyView(ctx)!;
    const oldAbort = add.mock.calls[0]?.[1];
    first.finish();
    const second = beginReadOnlyView(ctx)!;
    expect(typeof oldAbort).toBe("function");
    if (typeof oldAbort === "function") oldAbort.call(controller.signal, new Event("abort"));
    first.finish();
    expect(second.signal.aborted).toBe(false);
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    second.finish();
  });

  it("same sessionId on different managers remains isolated", async () => {
    const firstCtx = context();
    const secondCtx = context();
    const first = beginReadOnlyView(firstCtx)!;
    const second = beginReadOnlyView(secondCtx)!;
    const closing = closeReadOnlyView(firstCtx);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    first.finish();
    await closing;
    expect(beginReadOnlyView(secondCtx)).toBeUndefined();
    second.finish();
  });

  it("coordinates contexts sharing the captured manager, even without the same signal", async () => {
    const ctx = context();
    const other = { ...ctx, signal: new AbortController().signal };
    const lease = beginReadOnlyView(ctx)!;
    expect(beginReadOnlyView(other)).toBeUndefined();
    const closing = closeReadOnlyView(other);
    expect(lease.signal.aborted).toBe(true);
    lease.finish();
    await closing;
  });

  it("captures the manager and signal once; a late finish does not use changed ctx getters", () => {
    const ctx = context();
    const originalManager = ctx.sessionManager;
    const controller = new AbortController();
    ctx.signal = controller.signal;
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const first = beginReadOnlyView(ctx)!;
    ctx.sessionManager = context().sessionManager;
    ctx.signal = undefined;
    const second = beginReadOnlyView(ctx)!;
    controller.abort();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    first.finish();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    const fresh = beginReadOnlyView({ ...ctx, sessionManager: originalManager })!;
    expect(fresh).toBeDefined();
    fresh.finish();
    second.finish();
  });

  it("concurrent closes abort once and both wait for the same actual finish", async () => {
    const ctx = context();
    const lease = beginReadOnlyView(ctx)!;
    const abort = vi.fn();
    lease.signal.addEventListener("abort", abort);
    let count = 0;
    const a = closeReadOnlyView(ctx).then(() => {
      count++;
    });
    const b = closeReadOnlyView(ctx).then(() => {
      count++;
    });
    expect(abort).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(count).toBe(0);
    lease.finish();
    await Promise.all([a, b]);
    expect(count).toBe(2);
  });

  it("joins only the captured lease when abort synchronously finishes and opens a newer view", async () => {
    const ctx = context();
    const first = beginReadOnlyView(ctx)!;
    let second: ReturnType<typeof beginReadOnlyView>;
    first.signal.addEventListener("abort", () => {
      first.finish();
      second = beginReadOnlyView(ctx);
    });
    await closeReadOnlyView(ctx);
    expect(second).toBeDefined();
    expect(second!.signal.aborted).toBe(false);
    first.finish();
    expect(beginReadOnlyView(ctx)).toBeUndefined();
    const closing = closeReadOnlyView(ctx);
    expect(second!.signal.aborted).toBe(true);
    second!.finish();
    await closing;
  });

  it("close is no-op without a lease or usable manager", async () => {
    await expect(closeReadOnlyView(context())).resolves.toBeUndefined();
    await expect(closeReadOnlyView({} as ExtensionContext)).resolves.toBeUndefined();
    const ctx = context();
    Object.defineProperty(ctx, "sessionManager", {
      get() {
        throw new Error("gone");
      },
    });
    await expect(closeReadOnlyView(ctx)).resolves.toBeUndefined();
  });

  it("component cancellation and disposal still require the caller's actual finish before close joins", async () => {
    const ctx = context();
    const lease = beginReadOnlyView(ctx)!;
    const theme = createMockTheme();
    vi.mocked(theme.fg).mockImplementation((_color, text) => text);
    const env: UiViewEnvironment = {
      theme,
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS) as UiViewEnvironment["keybindings"],
      rows: () => 24,
      requestRender: vi.fn(),
    };
    const done = vi.fn();
    const review = createScopeReview("synthetic material", env, done);
    const cancel = () => review.handleInput?.("\u001b");
    lease.signal.addEventListener("abort", cancel);
    let joined = false;
    const closing = closeReadOnlyView(ctx).then(() => {
      joined = true;
    });
    try {
      expect(done.mock.calls).toEqual([["cancelled"]]);
      expect(review.render(80)).toEqual([]);
      await Promise.resolve();
      expect(joined).toBe(false);
      expect(beginReadOnlyView(ctx)).toBeUndefined();
    } finally {
      review.dispose();
      review.dispose();
      lease.signal.removeEventListener("abort", cancel);
      lease.finish();
      lease.finish();
    }
    await closing;
    expect(joined).toBe(true);
    review.handleInput?.("\r");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("close needs only the captured manager key, not working session/leaf getters", async () => {
    const ctx = context();
    const lease = beginReadOnlyView(ctx)!;
    ctx.sessionManager.getSessionId = () => {
      throw new Error("changed session");
    };
    ctx.sessionManager.getLeafId = () => {
      throw new Error("changed leaf");
    };
    const closing = closeReadOnlyView(ctx);
    expect(lease.signal.aborted).toBe(true);
    lease.finish();
    await closing;
  });
});
