import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";

export const ACTIVATION_ENTRY_TYPE = "continuous-tasks:activation";
export const TASK_TOOL_NAMES: readonly string[] = [
  "write_tasks",
  "edit_tasks",
  "compile_tasks",
  "clear_tasks",
  "get_ready_tasks",
  "advance_tasks",
  "workflow_gate",
];

export const PREFLIGHT_TOOL_NAME = "submit_preflight";
const taskTools = new Set([...TASK_TOOL_NAMES, PREFLIGHT_TOOL_NAME]);

export function setSessionScopeEnabled(value: boolean): void {
  currentRuntime().enabled = value;
}

export function isSessionScopeEnabled(): boolean {
  return currentRuntime().enabled;
}

export function updateActiveTools(pi: ExtensionAPI, value: boolean): void {
  const active = pi.getActiveTools().filter((name) => !taskTools.has(name));
  const preflight = currentRuntime().preflight;
  const planning = preflight && !preflight.started && preflight.phase !== "revoked";
  const selected = planning
    ? preflight.phase === "interrupted"
      ? []
      : [PREFLIGHT_TOOL_NAME]
    : TASK_TOOL_NAMES;
  pi.setActiveTools(value ? [...active, ...selected] : active);
}

function hasActivationEntry(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getBranch().some((entry) => {
    if (entry.type !== "custom") return false;
    const candidate = entry as { customType?: string; data?: unknown };
    if (candidate.customType !== ACTIVATION_ENTRY_TYPE) return false;
    if (typeof candidate.data !== "object" || candidate.data === null) return false;
    const data = candidate.data as { version?: unknown; enabled?: unknown };
    return data.version === 1 && data.enabled === true;
  });
}

export function restoreSessionScope(pi: ExtensionAPI, ctx: ExtensionContext): boolean {
  const value = hasActivationEntry(ctx);
  setSessionScopeEnabled(value);
  updateActiveTools(pi, value);
  return value;
}

export function enableSessionScope(pi: ExtensionAPI): void {
  if (isSessionScopeEnabled()) return;
  pi.appendEntry(ACTIVATION_ENTRY_TYPE, { version: 1, enabled: true });
  setSessionScopeEnabled(true);
  updateActiveTools(pi, true);
}
