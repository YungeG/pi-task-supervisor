import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Structural compatibility with the qualified host; the legacy peer stays supported.
export interface IdleActionState {
  phase: "busy" | "settling" | "idle";
  pendingInputs: number;
  activeActionId?: string;
}
export type IdleActionResult =
  | {
      status: "completed" | "cancelled" | "rejected" | "failed" | "unknown";
      actionId: string;
      reason?: string;
    }
  | { status: "started"; actionId: string; runId: string; sessionId: string };
export type IdleMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
export interface IdleActionHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly result: Promise<IdleActionResult>;
  cancel(): void;
}
export interface IdleActionLease {
  readonly id: string;
  readonly context: ExtensionContext;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  dispatch(
    message: IdleMessage,
    validate: () => boolean | Promise<boolean>,
  ): Promise<IdleActionResult>;
}
export interface IdleActionRequest {
  id: string;
  binding: string;
  isCurrent(): boolean;
  run(lease: IdleActionLease): Promise<void>;
}
export interface IdleActionAPI {
  readonly version: 1;
  state(): IdleActionState;
  request(request: IdleActionRequest): IdleActionHandle;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
function validState(value: unknown): boolean {
  if (
    !record(value) ||
    typeof value.phase !== "string" ||
    !["busy", "settling", "idle"].includes(value.phase)
  )
    return false;
  return Number.isSafeInteger(value.pendingInputs) && Number(value.pendingInputs) >= 0;
}
export function getIdleActions(ctx: ExtensionContext): IdleActionAPI | undefined {
  try {
    const value = (ctx as ExtensionContext & { readonly idleActions?: unknown }).idleActions;
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.state !== "function" ||
      typeof value.request !== "function"
    )
      return;
    const api = value as unknown as IdleActionAPI;
    if (validState(api.state())) return api;
  } catch {
    /* Missing/stale capability remains A-only. */
  }
  return undefined;
}
function startedReceipt(
  value: Record<string, unknown>,
  actionId: string,
  sessionId: string,
): IdleActionResult | undefined {
  if (typeof value.runId !== "string" || !value.runId || value.sessionId !== sessionId) return;
  return { status: "started", actionId, runId: value.runId, sessionId };
}
/** A malformed/foreign receipt can never be promoted into a delivery acknowledgement. */
export function idleOutcome(value: unknown, actionId: string, sessionId: string): IdleActionResult {
  const unknown: IdleActionResult = { status: "unknown", actionId, reason: "dispatch_unknown" };
  if (!record(value) || value.actionId !== actionId) return unknown;
  if (value.status === "started") return startedReceipt(value, actionId, sessionId) ?? unknown;
  if (
    typeof value.status !== "string" ||
    !["completed", "cancelled", "rejected", "failed", "unknown"].includes(value.status)
  )
    return unknown;
  return {
    status: value.status as Exclude<IdleActionResult["status"], "started">,
    actionId,
    ...(typeof value.reason === "string" ? { reason: value.reason.slice(0, 100) } : {}),
  };
}
function optionalDisplay(run: () => void): void {
  try {
    run();
  } catch {
    /* Display cannot invalidate a saved control. */
  }
}
/** Keep real leased blocking UI and every guarded identity/signal/idle getter. */
export function idleControlContext(
  origin: ExtensionContext,
  lease: IdleActionLease,
  onBlockingUI: () => void,
): ExtensionContext {
  const ordinary = origin.ui,
    leased = lease.context.ui;
  const ui: ExtensionContext["ui"] = {
    ...leased,
    notify: (...args) => {
      optionalDisplay(() => {
        ordinary.notify(...args);
      });
    },
    setStatus: (...args) => {
      optionalDisplay(() => {
        ordinary.setStatus(...args);
      });
    },
    setWidget: (key, content, options) => {
      optionalDisplay(() => {
        if (typeof content === "function") ordinary.setWidget(key, content, options);
        else ordinary.setWidget(key, content, options);
      });
    },
  };
  const blocking = new Set(["select", "confirm", "input", "editor", "custom"]);
  const view = new Proxy(ui, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (!blocking.has(String(key)) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        onBlockingUI();
        const result: unknown = Reflect.apply(value, leased, args);
        return result;
      };
    },
  });
  return Object.defineProperties(
    {},
    { ...Object.getOwnPropertyDescriptors(lease.context), ui: { value: view } },
  ) as ExtensionContext;
}
/** Only the original passive notice is adapted; this is never a fallback sender. */
export function idleControlApi(pi: ExtensionAPI, origin: ExtensionContext): ExtensionAPI {
  return {
    ...pi,
    sendMessage(message, options) {
      const display: unknown = message.display;
      if (
        message.customType !== "continuous-tasks:notice" ||
        display !== true ||
        typeof message.content !== "string" ||
        options?.triggerTurn !== false ||
        options.deliverAs !== undefined
      )
        throw new Error("Idle human controls must deliver work through lease.dispatch");
      optionalDisplay(() => {
        origin.ui.notify(message.content as string, "info");
      });
    },
  };
}
