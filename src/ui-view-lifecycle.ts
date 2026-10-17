import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type Manager = ExtensionContext["sessionManager"];
type ViewLease = { signal: AbortSignal; finish(): void };
type ActiveView = { controller: AbortController; finished: Promise<void> };

// Coordinates only this extension's readers, not host or third-party prompts.
const views = new WeakMap<Manager, ActiveView>();

function managerFor(ctx: ExtensionContext): Manager | undefined {
  const manager: unknown = ctx.sessionManager;
  return manager !== null && (typeof manager === "object" || typeof manager === "function")
    ? (manager as Manager)
    : undefined;
}

function admission(ctx: ExtensionContext): { manager: Manager; signal?: AbortSignal } | undefined {
  try {
    const manager = managerFor(ctx);
    if (!manager) return undefined;
    const sessionId: unknown = manager.getSessionId();
    const leafId: unknown = manager.getLeafId();
    const signal = ctx.signal;
    if (typeof sessionId !== "string" || !sessionId.trim() || signal?.aborted) return undefined;
    if (leafId !== null && (typeof leafId !== "string" || !leafId)) return undefined;
    return { manager, signal };
  } catch {
    return undefined;
  }
}

export function beginReadOnlyView(ctx: ExtensionContext): ViewLease | undefined {
  const identity = admission(ctx);
  if (!identity || views.has(identity.manager)) return undefined;
  const { manager, signal } = identity;
  const controller = new AbortController();
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const active = { controller, finished };
  views.set(manager, active);
  const abort = () => {
    controller.abort();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let ended = false;
  return {
    signal: controller.signal,
    finish() {
      if (ended) return;
      ended = true;
      signal?.removeEventListener("abort", abort);
      if (views.get(manager) === active) views.delete(manager);
      resolveFinished();
    },
  };
}

export async function closeReadOnlyView(ctx: ExtensionContext): Promise<void> {
  let manager: Manager | undefined;
  try {
    manager = managerFor(ctx);
  } catch {
    return;
  }
  const active = manager ? views.get(manager) : undefined;
  if (!active) return;
  active.controller.abort();
  await active.finished;
}
