import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import { goalLease } from "./goal-scope";
import { inspectSessionJournal } from "./human-journal";
import { sessionJournalView } from "./human-control";
import { readGoalFirstStartEntry } from "./preflight";

type Lease = {
  key: string;
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  allowed: boolean;
  identity?: string;
  execution: boolean;
  toolName: string;
};
function workIdentity(): string | undefined {
  const current = currentRuntime().goal?.current;
  return current
    ? JSON.stringify([
        current.scope.goalRunId,
        current.scope.lifecycleCommitId,
        current.planning.attemptId,
      ])
    : undefined;
}
function sameExecution(call: Lease, ctx: ExtensionContext): boolean {
  return (
    call.execution &&
    call.identity !== undefined &&
    call.identity === workIdentity() &&
    currentRuntime().goal?.current?.supervisor !== null &&
    call.sessionId === ctx.sessionManager.getSessionId()
  );
}
function toolLease(): string {
  if (!currentRuntime().goal?.current) return "legacy";
  return JSON.stringify([
    goalLease(),
    currentRuntime().goal?.current?.supervisor === null ? "planning" : "execution",
  ]);
}
function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
/** Bounded identities only, never receipt bodies or a second evidence journal. */
export class GoalToolLeases {
  private readonly calls = new Map<string, Lease>();
  begin(id: string, ctx: ExtensionContext, toolName: string): string | undefined {
    const validName = validToolName(toolName);
    const duplicate = currentRuntime().goal?.current && this.calls.has(id);
    this.calls.delete(id);
    this.calls.set(id, {
      key: toolLease(),
      manager: ctx.sessionManager,
      sessionId: ctx.sessionManager.getSessionId(),
      allowed: false,
      toolName: validName ? toolName : "", // Retain only a bounded denied-call marker for invalid names.
      identity: workIdentity(),
      execution: currentRuntime().goal?.current?.supervisor !== null,
    });
    while (this.calls.size > 512) {
      const oldest = this.calls.keys().next().value;
      if (oldest === undefined) break;
      this.calls.delete(oldest);
    }
    if (!validName) return "Invalid tool name; callback identity was not admitted";
    return duplicate
      ? "Tool call identity was already admitted; do not replay or reuse it across GoalRuns"
      : undefined;
  }
  allow(id: string): void {
    const call = this.calls.get(id);
    if (call) call.allowed = true;
  }
  result(
    id: string,
    ctx: ExtensionContext,
    toolName: string,
  ): "current" | "blocked" | "historical" {
    const call = this.calls.get(id);
    if (call && !call.toolName) return "blocked";
    if (!validToolName(toolName)) return "current";
    if (call) {
      if (call.toolName !== toolName) return "current";
      if (
        !sameExecution(call, ctx) &&
        (call.key !== toolLease() ||
          call.manager !== ctx.sessionManager ||
          call.sessionId !== ctx.sessionManager.getSessionId())
      )
        return "historical";
      return call.allowed ? "current" : "blocked";
    }
    return historicalNativeCall(id, ctx, toolName) ? "historical" : "current";
  }
}
function historicalNativeCall(id: string, ctx: ExtensionContext, toolName: string): boolean {
  const current = currentRuntime().goal?.current;
  if (!current || !currentRuntime().supervisor) return false;
  // Only the rare unmatched/reopened callback pays for a physical read. Unknown is not old.
  try {
    const journal = inspectSessionJournal(sessionJournalView(ctx));
    if (journal.branch.some((node) => node.toolCallsIncomplete)) return false;
    const anchor = journal.branch.findIndex((node) => node.id === current.preflightBaseEntryId);
    const owners = journal.branch.flatMap((node, index) =>
      (node.toolCalls ?? [])
        .filter((call) => call.id === id)
        .map((call) => ({ index, name: call.name })),
    );
    const owner = owners.length === 1 ? owners[0] : undefined;
    if (anchor < 0 || !owner || owner.name !== toolName) return false;
    if (owner.index < anchor) return true;
    if (!["read", "grep", "find", "ls"].includes(toolName)) return false;
    const startup = readGoalFirstStartEntry(ctx, current);
    const started = journal.branch.findIndex((node) => node.id === startup);
    return started > anchor && owner.index > anchor && owner.index < started;
  } catch {
    return false;
  }
}
