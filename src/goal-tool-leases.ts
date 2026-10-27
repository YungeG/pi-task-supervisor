import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import { goalLease } from "./goal-scope";
import { inspectSessionJournal, journalDigest } from "./human-journal";
import { sessionJournalView } from "./human-control";
import { readGoalFirstStartEntry } from "./preflight";
import { invocationOwnerKey } from "./invocation-tree";
import {
  captureManagementSnapshot,
  activeGoalContext,
  type WorkContext,
} from "./management-policy";

type Stamp = {
  key: string;
  managed: boolean;
  context: WorkContext;
  identity?: string;
  execution: boolean;
};
type Lease = Stamp & {
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  path: string | undefined;
  leafId: string | null;
  allowed: boolean;
  toolName: string;
};
function contextStamp(ctx: ExtensionContext): Stamp {
  const snapshot = captureManagementSnapshot(ctx);
  const goal = activeGoalContext() ? currentRuntime().goal?.current : undefined;
  const identity = snapshot.activeWorkOwner
    ? JSON.stringify([snapshot.activeWorkOwner, goal?.planning.attemptId])
    : undefined;
  const execution = snapshot.context.kind !== "unmanaged" && goal?.supervisor !== null;
  return {
    managed: snapshot.mode !== "off",
    context: snapshot.context,
    identity,
    execution,
    key: JSON.stringify([
      goalLease(),
      snapshot.mode,
      snapshot.record?.data.revision ?? null,
      snapshot.state,
      identity,
      execution,
    ]),
  };
}
function validToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
function sameManager(call: Lease, ctx: ExtensionContext): boolean {
  return (
    call.manager === ctx.sessionManager &&
    call.sessionId === ctx.sessionManager.getSessionId() &&
    call.path === ctx.sessionManager.getSessionFile()
  );
}
function sameExecution(call: Lease, current: Stamp): boolean {
  return (
    call.execution &&
    current.execution &&
    call.identity !== undefined &&
    call.identity === current.identity
  );
}
function ownBoardReplacement(
  call: Lease,
  ctx: ExtensionContext,
  toolName: string,
  current: Stamp,
): boolean {
  if (
    call.context.kind !== "board" ||
    current.context.kind !== "board" ||
    !["write_tasks", "clear_tasks"].includes(toolName)
  )
    return false;
  const record = currentRuntime().management?.record,
    records = currentRuntime().controlJournal?.modeRecords ?? [];
  const previous =
    record &&
    records.find(
      (item) =>
        item.entryId === record.data.previousModeRecord?.entryId &&
        item.digest === record.data.previousModeRecord.digest,
    );
  if (
    !record ||
    !previous ||
    record.data.mode !== "tasks" ||
    previous.data.state !== "stopping-with-attention"
  )
    return false;
  if (
    journalDigest(previous.data.originOwner) !== journalDigest(call.context.owner) ||
    journalDigest(record.data.activeWorkOwner) !== journalDigest(current.context.owner)
  )
    return false;
  const branch = ctx.sessionManager.getBranch(),
    start = branch.findIndex((entry) => entry.id === call.leafId),
    changed = branch.findIndex((entry) => entry.id === previous.entryId);
  return start >= 0 && changed > start;
}
/** Host-captured contexts only: off/unmanaged and old owners never become new evidence. */
function unmatchedResult(
  id: string,
  ctx: ExtensionContext,
  toolName: string,
  current: Stamp,
): "current" | "historical" | "unmanaged" {
  if (
    historicalInvocationCall(id, toolName, current) ||
    historicalModeCall(id, ctx, toolName) ||
    historicalNativeCall(id, ctx, toolName)
  )
    return "historical";
  return current.managed ? "current" : "unmanaged";
}
export class GoalToolLeases {
  private readonly calls = new Map<string, Lease>();
  private readonly recent = new Map<string, Lease>();
  private remember(id: string, call: Lease): void {
    this.recent.delete(id);
    this.recent.set(id, call);
    while (this.recent.size > 512) {
      const first = this.recent.keys().next().value;
      if (first === undefined) break;
      this.recent.delete(first);
    }
  }
  begin(id: string, ctx: ExtensionContext, toolName: string): string | undefined {
    const validName = validToolName(toolName),
      current = contextStamp(ctx);
    const duplicate = current.managed && (this.calls.has(id) || this.recent.has(id));
    const call: Lease = {
      ...current,
      manager: ctx.sessionManager,
      sessionId: ctx.sessionManager.getSessionId(),
      path: ctx.sessionManager.getSessionFile(),
      leafId: ctx.sessionManager.getLeafId(),
      allowed: false,
      toolName: validName ? toolName : "",
    };
    this.recent.delete(id);
    if (current.managed && this.calls.size >= 512 && !this.calls.has(id)) {
      this.remember(id, call);
      return "Callback active-node limit reached; no live parent was evicted";
    }
    if (current.managed) this.calls.set(id, call);
    else this.remember(id, call);
    if (!validName) return "Invalid tool name; callback identity was not admitted";
    return duplicate
      ? "Tool call identity was already admitted; do not replay or reuse it across work owners"
      : undefined;
  }
  allow(id: string): void {
    const call = this.calls.get(id) ?? this.recent.get(id);
    if (call) call.allowed = true;
  }
  private resultLease(id: string): Lease | undefined {
    const call = this.calls.get(id) ?? this.recent.get(id);
    if (call && this.calls.has(id)) {
      this.calls.delete(id);
      this.remember(id, call);
    }
    return call;
  }
  result(
    id: string,
    ctx: ExtensionContext,
    toolName: string,
  ): "current" | "blocked" | "historical" | "unmanaged" {
    const call = this.resultLease(id);
    if (call && !sameManager(call, ctx)) return "historical";
    if (call && (!call.toolName || !call.allowed)) return "blocked";
    const current = contextStamp(ctx);
    if (!call) return unmatchedResult(id, ctx, toolName, current);
    if (!validToolName(toolName) || call.toolName !== toolName) return "current";
    if (!call.managed && !current.managed) return "unmanaged";
    if (
      sameExecution(call, current) ||
      call.key === current.key ||
      ownBoardReplacement(call, ctx, toolName, current)
    )
      return current.managed ? "current" : "unmanaged";
    return "historical";
  }
}
function historicalInvocationCall(id: string, toolName: string, current: Stamp): boolean {
  const nodes = [...(currentRuntime().controlJournal?.invocations?.nodes.values() ?? [])].filter(
    (node) => node.toolCallId === id && node.toolName === toolName,
  );
  if (nodes.length !== 1 || !nodes[0]) return false;
  return (
    current.context.kind === "unmanaged" ||
    invocationOwnerKey(nodes[0].owner) !== invocationOwnerKey(current.context.owner)
  );
}
function historicalModeCall(id: string, ctx: ExtensionContext, toolName: string): boolean {
  const runtime = currentRuntime(),
    selected = runtime.management?.activeWorkOwner;
  if (!selected || !runtime.management?.record) return false;
  const first = (runtime.controlJournal?.modeRecords ?? []).find(
    (record) => journalDigest(record.data.activeWorkOwner) === journalDigest(selected),
  );
  if (!first) return false;
  try {
    const journal = inspectSessionJournal(sessionJournalView(ctx));
    if (journal.branch.some((node) => node.toolCallsIncomplete)) return false;
    const boundary = journal.branch.findIndex((node) => node.id === first.entryId);
    const calls = journal.branch.flatMap((node, index) =>
      (node.toolCalls ?? [])
        .filter((call) => call.id === id)
        .map((call) => ({ index, name: call.name })),
    );
    return calls.length === 1 && calls[0]?.name === toolName && calls[0].index < boundary;
  } catch {
    return false;
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
