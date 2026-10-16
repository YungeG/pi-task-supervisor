import { SessionManager, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { resetState, setBoard, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import {
  assertObservedEvidence,
  digest,
  holdSupervisor,
  observeTool,
  prepareToolCapture,
  recoverSupervisor,
  restoreSupervisor,
  saveSupervisor,
  startSupervisor,
  supervisorState,
  SUPERVISOR_ENTRY,
} from "../supervisor";
import { RECEIPT_LEDGER_ENTRY } from "../receipt-store";
import { activeBoard, lifecycle } from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

// Port of the original V2 candidate's 15 regression cases. Native writes now use
// V3; retained V2 fixtures are read-only. No test is disabled or satisfied by
// making cache projections look like a complete receipt history.
function event(id: string, toolName = "read"): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: id,
    toolName,
    input: { command: "synthetic validation" },
    content: [{ type: "text", text: "synthetic output" }],
    structuredContent: { exit_code: 0 },
    details: undefined,
    isError: false,
  };
}
function setup() {
  const manager = SessionManager.inMemory();
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" }, sessionManager: manager });
  mock.appendEntry.mockImplementation((kind: string, data: unknown) => {
    manager.appendCustomEntry(kind, structuredClone(data));
  });
  startSupervisor(mock.api, ctx, "Preserve host evidence");
  const capture = (result: ToolResultEvent) => {
    prepareToolCapture(mock.api, { ...result, type: "tool_call" });
    observeTool(mock.api, result);
  };
  return { manager, mock, ctx, capture };
}
function context(entries: Parameters<typeof createMockContext>[0], sessionId: string) {
  const ctx = createMockContext(entries);
  ctx.sessionManager.getSessionId = () => sessionId;
  return ctx;
}
function proof(ref: string) {
  return {
    summary: "Synthetic test of host binding",
    refs: [
      {
        kind: "command" as const,
        label: "validation",
        status: "passed" as const,
        exitCode: 0,
        ref,
      },
    ],
  };
}
function allReceipts(count: number) {
  return currentRuntime().receiptStore!.readReceipts(
    Array.from({ length: count }, (_, i) => `tool:read-${i}`),
  );
}

describe("original V2 receipt regressions across V3 integration", () => {
  beforeEach(() => {
    resetState();
    const board = activeBoard();
    board.tasks[0]!.status = "reviewing";
    setBoard(board);
  });

  it("records the 501st receipt and mutating epoch without losing earlier proofs", () => {
    const h = setup();
    h.capture(event("read-0"));
    const first = structuredClone(currentRuntime().receiptStore!.readReceipts(["tool:read-0"])[0]);
    for (let i = 1; i < 500; i++) h.capture(event(`read-${i}`));
    h.capture(event("validation", "bash"));
    expect(currentRuntime().receiptStore!.stats.count).toBe(501);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:read-0"])[0]).toEqual(first);
    expect(supervisorState()!.epoch).toBe(1);
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:validation"));
    }).not.toThrow();
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:read-499"));
    }).toThrow("fresh host receipt");
    h.capture(event("validation", "bash"));
    expect(currentRuntime().receiptStore!.stats.count).toBe(501);
    expect(supervisorState()!.epoch).toBe(1);
  });

  it("stores receipt bodies once rather than duplicating them in every checkpoint", () => {
    const h = setup();
    h.capture(event("one"));
    h.capture(event("two"));
    saveSupervisor(h.mock.api);
    const branch = h.manager.getBranch();
    const snapshots = branch.filter(
      (e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY,
    );
    expect(
      snapshots.every(
        (e) =>
          e.type === "custom" &&
          (e.data as { version: number }).version === 3 &&
          (e.data as { receipts: unknown[] }).receipts.length === 0,
      ),
    ).toBe(true);
    const bodies = branch.filter(
      (e) => e.type === "custom" && e.customType === RECEIPT_LEDGER_ENTRY,
    );
    expect(bodies).toHaveLength(2);
    expect(
      bodies.map((e) =>
        e.type === "custom" ? (e.data as { receipt: unknown }).receipt : undefined,
      ),
    ).toEqual(currentRuntime().receiptStore!.readReceipts(["tool:one", "tool:two"]));
  });

  it("restores all receipts, bindings and budgets without recovering a pause", () => {
    const h = setup();
    for (let i = 0; i < 501; i++) h.capture(event(`read-${i}`));
    Object.assign(supervisorState()!, {
      status: "paused",
      holdCause: "user_pause",
      reason: "keep approval gate",
      reviews: 7,
      continuations: 5,
      stagnant: 2,
      tokens: 1234,
      cost: 0.75,
      bindings: [{ taskId: "t-1.1", digest: "1".repeat(64), refs: ["tool:read-0"] }],
    });
    saveSupervisor(h.mock.api);
    const receipts = allReceipts(501);
    restoreSupervisor(createMockAPI().api, h.ctx);
    expect(supervisorState()).toMatchObject({
      status: "paused",
      reviews: 7,
      continuations: 5,
      stagnant: 2,
      tokens: 1234,
      cost: 0.75,
      bindings: [{ taskId: "t-1.1", digest: "1".repeat(64), refs: ["tool:read-0"] }],
    });
    expect(currentRuntime().receiptStore!.stats.count).toBe(501);
    expect(allReceipts(501)).toEqual(receipts);
  });

  it.each(["paused", "fault", "completed"] as const)(
    "retains saturated legacy %s history and usage across its gap boundary",
    (status) => {
      const h = setup();
      for (let i = 0; i < 500; i++) h.capture(event(`read-${i}`));
      const legacy = {
        ...structuredClone(supervisorState()!),
        receipts: allReceipts(500),
        status,
        holdCause: "user_pause" as const,
        acceptedDigest: "1".repeat(64),
        reviews: 7,
        continuations: 5,
        tokens: 1234,
        cost: 0.75,
      };
      const manager = SessionManager.inMemory();
      legacy.sessionId = manager.getSessionId();
      manager.appendCustomEntry(SUPERVISOR_ENTRY, structuredClone(legacy));
      const mock = createMockAPI();
      const ctx = createMockContext();
      Object.assign(ctx, { sessionManager: manager });
      mock.appendEntry.mockImplementation((kind: string, data: unknown) => {
        manager.appendCustomEntry(kind, structuredClone(data));
      });
      restoreSupervisor(mock.api, ctx);
      expect(supervisorState()).toMatchObject({
        status: status === "paused" ? "paused" : "fault",
        acceptedDigest: undefined,
        reviews: 7,
        continuations: 5,
        tokens: 1234,
        cost: 0.75,
        epoch: legacy.epoch + 1,
      });
      expect(supervisorState()!.receipts).toEqual(legacy.receipts);
      recoverSupervisor(mock.api, ctx);
      const store = currentRuntime().receiptStore!;
      expect(allReceipts(500)).toEqual(legacy.receipts);
      prepareToolCapture(mock.api, { ...event("after-upgrade", "bash"), type: "tool_call" });
      observeTool(mock.api, event("after-upgrade", "bash"));
      expect(store.stats.count).toBe(501);
      expect(allReceipts(500)).toEqual(legacy.receipts);
      holdSupervisor(mock.api, ctx, "paused", "Inspect upgraded history", "user_pause");
      const epoch = supervisorState()!.epoch;
      restoreSupervisor(mock.api, ctx);
      expect(supervisorState()!.epoch).toBe(epoch);
      expect(allReceipts(500)).toEqual(legacy.receipts);
    },
  );

  it("uses only the current branch and does not inherit a foreign session", () => {
    const h = setup();
    h.capture(event("one"));
    Object.assign(supervisorState()!, { status: "paused", holdCause: "user_pause" });
    saveSupervisor(h.mock.api);
    const prefix = structuredClone(h.manager.getBranch());
    h.capture(event("other-branch"));
    const own = context(prefix, h.manager.getSessionId());
    restoreSupervisor(createMockAPI().api, own);
    expect(currentRuntime().receiptStore!.stats.count).toBe(1);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:one"])).toHaveLength(1);
    restoreSupervisor(createMockAPI().api, context(prefix, "foreign-session"));
    expect(supervisorState()).toBeUndefined();
  });

  it.each(["missing", "tampered", "duplicate", "orphan", "count", "downgrade"])(
    "fails closed for %s retained V2 journal data",
    (kind) => {
      const h = setup();
      h.capture(event("read-0"));
      const receipts = allReceipts(1);
      const logical = {
        ...structuredClone(supervisorState()!),
        status: "paused" as const,
        holdCause: "user_pause" as const,
        receipts: [],
      };
      const payload = {
        version: 1,
        sessionId: logical.sessionId,
        journalId: "retained-v2",
        previousHead: null,
        first: 1,
        receipts,
      };
      const head = digest(payload);
      const entries: NonNullable<Parameters<typeof createMockContext>[0]> = [
        {
          id: "v2-start",
          parentId: null,
          type: "custom",
          customType: SUPERVISOR_ENTRY,
          data: {
            ...logical,
            version: 2,
            receiptJournal: { id: "retained-v2", count: 0, head: null },
          },
        },
        {
          id: "v2-body",
          parentId: "v2-start",
          type: "custom",
          customType: "continuous-tasks:supervisor-receipts",
          data: { ...payload, head },
        },
        {
          id: "v2-end",
          parentId: "v2-body",
          type: "custom",
          customType: SUPERVISOR_ENTRY,
          data: { ...logical, version: 2, receiptJournal: { id: "retained-v2", count: 1, head } },
        },
      ];
      if (kind === "missing") entries.splice(1, 1);
      if (kind === "tampered")
        (entries[1]!.data as { receipts: Array<{ ok: boolean }> }).receipts[0]!.ok = false;
      if (kind === "duplicate") entries.splice(2, 0, structuredClone(entries[1]!));
      if (kind === "orphan") entries.splice(2);
      if (kind === "count")
        (entries[2]!.data as { receiptJournal: { count: number } }).receiptJournal.count++;
      if (kind === "downgrade")
        entries.push({
          id: "v1-downgrade",
          parentId: "v2-end",
          type: "custom",
          customType: SUPERVISOR_ENTRY,
          data: logical,
        });
      expect(() => {
        restoreSupervisor(createMockAPI().api, context(entries, logical.sessionId));
      }).toThrow(/v2|Receipt checkpoint/);
    },
  );

  it("keeps ordinary resume on the same journal and preserves its proofs", async () => {
    const h = lifecycle();
    await h.command("supervise Preserve approved work");
    await h.fire("tool_call", { ...event("before-pause"), type: "tool_call" });
    await h.fire("tool_result", event("before-pause"));
    await h.command("pause maintenance");
    const before = h.ctx.sessionManager
      .getBranch()
      .filter((e) => e.type === "custom" && e.customType === RECEIPT_LEDGER_ENTRY);
    await h.command("resume");
    expect(
      h.ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === RECEIPT_LEDGER_ENTRY),
    ).toEqual(before);
    restoreSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:before-pause"])).toHaveLength(1);
    expect(supervisorState()!.status).toBe("fault");
  });

  it("does not silently retry an uncertain result append after a recorded intent", () => {
    const h = setup();
    h.mock.appendEntry.mockImplementation((kind: string, data: unknown) => {
      if (kind === RECEIPT_LEDGER_ENTRY && (data as { kind?: string }).kind === "receipt")
        throw new Error("disk failure");
      h.manager.appendCustomEntry(kind, structuredClone(data));
    });
    prepareToolCapture(h.mock.api, { ...event("one", "bash"), type: "tool_call" });
    expect(() => observeTool(h.mock.api, event("one", "bash"))).toThrow("disk failure");
    expect(() => {
      saveSupervisor(h.mock.api);
    }).toThrow(/uncertain|disk failure/);
    expect(supervisorState()!.epoch).toBe(1);
    expect(getBoard().workflowStatus).toBe("active");
  });
});
