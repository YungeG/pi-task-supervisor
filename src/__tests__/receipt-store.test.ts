import { writeFileSync } from "node:fs";
import { SessionManager, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerEventHandlers } from "../events";
import { getBoard, resetState, setBoard } from "../state";
import { currentRuntime } from "../runtime";
import {
  assertObservedEvidence,
  recoverSupervisor,
  restoreSupervisor,
  readSupervisorStartRecord,
  startSupervisor,
  saveSupervisor,
  supervisorState,
  digest,
  SUPERVISOR_ENTRY,
} from "../supervisor";
import { RECEIPT_LEDGER_ENTRY, ReceiptStore, type ReceiptLedger } from "../receipt-store";
import { activeBoard, getHandler } from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

function fixture() {
  const manager = SessionManager.inMemory();
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" }, sessionManager: manager });
  mock.appendEntry.mockImplementation((type: string, data: unknown) => {
    manager.appendCustomEntry(type, structuredClone(data));
  });
  registerEventHandlers(mock.api);
  startSupervisor(mock.api, ctx, "Retain long-running host evidence");
  const event = (id: string, overrides: Partial<ToolResultEvent> = {}): ToolResultEvent => ({
    type: "tool_result",
    toolName: "read",
    toolCallId: id,
    input: { path: "fixture.txt" },
    content: [{ type: "text", text: "fixture" }],
    details: undefined,
    isError: false,
    ...overrides,
  });
  const begin = (id: string, overrides: Partial<ToolResultEvent> = {}) =>
    getHandler(mock, "tool_call")({ ...event(id, overrides), type: "tool_call" }, ctx);
  const finish = (id: string, overrides: Partial<ToolResultEvent> = {}) =>
    getHandler(mock, "tool_result")(event(id, overrides), ctx);
  const capture = (id: string, overrides: Partial<ToolResultEvent> = {}) => {
    expect(begin(id, overrides)?.block).not.toBe(true);
    return finish(id, overrides);
  };
  Object.assign(mock.api, {
    getAllTools: () => [{ name: "validate_readonly", annotations: { readOnlyHint: true } }],
  });
  return { manager, mock, ctx, capture, begin, finish };
}

function legacyFixture(count = 500, status: "fault" | "stopped" = "fault") {
  const h = fixture();
  const legacy = structuredClone(supervisorState()!);
  resetState();
  const board = activeBoard();
  board.tasks[0]!.status = "reviewing";
  setBoard(board);
  const manager = SessionManager.inMemory();
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" }, sessionManager: manager });
  mock.appendEntry.mockImplementation((type: string, data: unknown) => {
    manager.appendCustomEntry(type, structuredClone(data));
  });
  legacy.sessionId = manager.getSessionId();
  legacy.epoch = 4;
  legacy.status = status;
  legacy.tokens = 123;
  legacy.cost = 0.25;
  legacy.reviews = 7;
  legacy.receipts = Array.from({ length: count }, (_, i) => ({
    id: `tool:legacy-${i}`,
    tool: "validate_readonly",
    taskIds: ["t-1.1"],
    reviews: [{ taskId: "t-1.1", digest: digest(board.tasks[0]) }],
    epoch: 4,
    ok: true,
    exitCode: 0,
    digest: "a".repeat(64),
    input: "{}",
    output: "historical fixture",
  }));
  manager.appendCustomEntry(SUPERVISOR_ENTRY, legacy);
  registerEventHandlers(mock.api);
  restoreSupervisor(mock.api, ctx);
  return { manager, mock, ctx, legacy, initial: h };
}
const proof = (id: string) => ({
  summary: "Host validation",
  refs: [
    { kind: "command" as const, label: "fixture", status: "passed" as const, exitCode: 0, ref: id },
  ],
});

describe("native initial Supervisor checkpoint inspection", () => {
  beforeEach(() => {
    resetState();
  });

  it("reads the exact original S prefix after later host receipts without publishing or writing", () => {
    const h = fixture();
    const initial = h.manager.getLeafId()!;
    h.capture("after-start");
    const owner = supervisorState();
    const store = currentRuntime().receiptStore;
    const length = h.manager.getBranch().length;
    const record = readSupervisorStartRecord(h.ctx, initial);
    expect(record).toMatchObject({
      entryId: initial,
      state: { status: "active", epoch: 0, receipts: [], reviews: 0, continuations: 0 },
    });
    expect(supervisorState()).toBe(owner);
    expect(currentRuntime().receiptStore).toBe(store);
    expect(h.manager.getBranch()).toHaveLength(length);
  });

  it("inspects the startup prefix through a real-SDK-style getter-only session context", () => {
    const h = fixture();
    const tip = h.manager.getLeafId()!;
    Object.defineProperty(h.ctx, "sessionManager", { get: () => h.manager, configurable: true });
    expect(readSupervisorStartRecord(h.ctx, tip)).toMatchObject({
      entryId: tip,
      state: { epoch: 0, receipts: [] },
    });
  });

  it("rejects nonempty total receipt history even though the wire checkpoint has an empty cache", () => {
    const h = fixture();
    h.capture("not-initial");
    saveSupervisor(h.mock.api);
    const tip = h.manager.getLeafId()!;
    const entry = h.manager.getEntry(tip);
    expect(entry).toMatchObject({
      type: "custom",
      data: { version: 3, receipts: [], receiptLedger: { receiptCount: 1 } },
    });
    expect(() => readSupervisorStartRecord(h.ctx, tip)).toThrow(/inherited receipts/);
  });

  it("rejects pending host intents without closing or replaying them", () => {
    const h = fixture();
    h.begin("unknown-start", { toolName: "bash" });
    saveSupervisor(h.mock.api);
    const tip = h.manager.getLeafId()!;
    const length = h.manager.getBranch().length;
    expect(() => readSupervisorStartRecord(h.ctx, tip)).toThrow(/pending captures/);
    expect(currentRuntime().receiptStore!.pendingCount).toBe(1);
    expect(h.manager.getBranch()).toHaveLength(length);
  });

  it("does not borrow a globally queryable checkpoint outside the current branch", () => {
    const h = fixture();
    const initial = h.manager.getLeafId()!;
    h.capture("future-branch");
    const future = h.manager.getLeafId()!;
    h.manager.branch(initial);
    expect(h.manager.getEntry(future)).toBeDefined();
    expect(() => readSupervisorStartRecord(h.ctx, future)).toThrow(/current-branch/);
  });

  it("prevents a read-only history inspector from appending even a matching checkpoint", () => {
    const h = fixture();
    const tip = h.manager.getLeafId()!;
    const entry = h.manager.getEntry(tip);
    if (entry?.type !== "custom") throw new Error("Missing actual fixture checkpoint");
    const metadata = (entry.data as { receiptLedger: ReceiptLedger }).receiptLedger;
    const inspector = ReceiptStore.restore(undefined, h.ctx, metadata);
    expect(() => {
      inspector.appendCheckpoint(SUPERVISOR_ENTRY, entry.data);
    }).toThrow("Read-only receipt inspection cannot append");
    expect(h.manager.getLeafId()).toBe(tip);
  });

  it.each(["message", "other-owner"])(
    "rejects a current-branch %s entry instead of borrowing an earlier Supervisor",
    (kind) => {
      const h = fixture();
      const id =
        kind === "message"
          ? h.manager.appendMessage({
              role: "user",
              content: "Synthetic wrong-entry probe",
              timestamp: Date.now(),
            })
          : h.manager.appendCustomEntry("fixture:notice", { synthetic: true });
      expect(() => readSupervisorStartRecord(h.ctx, id)).toThrow(/Supervisor startup checkpoint/);
    },
  );

  it("rejects a current-branch Supervisor whose session does not match the owner", () => {
    const h = fixture();
    const tip = h.manager.getLeafId()!;
    const entry = h.manager.getEntry(tip);
    if (entry?.type !== "custom") throw new Error("Missing actual fixture checkpoint");
    (entry.data as { sessionId: string }).sessionId = "foreign-session";
    expect(() => readSupervisorStartRecord(h.ctx, tip)).toThrow(/Missing Supervisor startup state/);
  });

  it("rejects a checkpoint epoch that contradicts an otherwise empty initial ledger", () => {
    const h = fixture();
    const tip = h.manager.getLeafId()!;
    const entry = h.manager.getEntry(tip);
    if (entry?.type !== "custom") throw new Error("Missing actual fixture checkpoint");
    (entry.data as { epoch: number }).epoch = 1;
    expect(() => readSupervisorStartRecord(h.ctx, tip)).toThrow(/checkpoint does not match/);
  });

  it("validates the ledger itself rather than accepting a zero-counter schema projection", () => {
    const h = fixture();
    const tip = h.manager.getLeafId()!;
    const entry = h.manager.getEntry(tip);
    if (entry?.type !== "custom") throw new Error("Missing actual fixture checkpoint");
    (entry.data as { receiptLedger: { receiptCount: number } }).receiptLedger.receiptCount = 1;
    expect(() => readSupervisorStartRecord(h.ctx, tip)).toThrow(/checkpoint does not match/);
  });
});

describe("long-running host receipt lifecycle", () => {
  beforeEach(() => {
    resetState();
    const board = activeBoard();
    board.tasks[0]!.status = "reviewing";
    setBoard(board);
  });

  it("runs a representative small sample on the real SDK journal", () => {
    const h = fixture();
    for (let n = 0; n < 10; n++) h.capture(`sample-${n}`);
    expect(supervisorState()?.status).toBe("active");
    expect(h.manager.getBranch().length).toBeGreaterThan(10);
  });

  it("records the 501st host result without faulting the goal", () => {
    const h = fixture();
    let result;
    for (let n = 0; n < 501; n++) result = h.capture(`long-${n}`);
    expect(supervisorState()?.status).toBe("active");
    expect(result.content.at(-1).text).toContain("tool:long-500");
    expect(currentRuntime().receiptStore!.stats.cacheEntries).toBeLessThanOrEqual(128);
  });

  it("can use current-review validation after it is evicted from a one-entry cache", () => {
    const h = fixture();
    currentRuntime().receiptStore!.configure({ maxEntries: 1, maxBytes: 16_384 });
    h.capture("early-proof", {
      toolName: "validate_readonly",
      structuredContent: { exit_code: 0 },
    });
    for (let i = 0; i < 40; i++) h.capture(`later-read-${i}`);
    expect(supervisorState()!.receipts.some((r) => r.id === "tool:early-proof")).toBe(false);
    expect(() => {
      assertObservedEvidence("t-1.1", {
        summary: "Real retained fixture proof",
        refs: [
          {
            kind: "command",
            label: "fixture",
            status: "passed",
            exitCode: 0,
            ref: "tool:early-proof",
          },
        ],
      });
    }).not.toThrow();
    expect(currentRuntime().receiptStore!.stats.cacheEntries).toBe(1);
    expect(currentRuntime().receiptStore!.readReceipts([], 30)).toHaveLength(30);
  });

  it("latches a journal fault when an evicted proof cannot be found in its archive", () => {
    const h = fixture();
    const store = currentRuntime().receiptStore!;
    store.configure({ maxEntries: 1, maxBytes: 16_384 });
    h.capture("lost-proof", { toolName: "validate_readonly", structuredContent: { exit_code: 0 } });
    const entryId = h.manager
      .getBranch()
      .find((e) => e.type === "custom" && e.customType === RECEIPT_LEDGER_ENTRY)!.id;
    h.capture("later");
    const getEntry = h.manager.getEntry.bind(h.manager);
    vi.spyOn(h.manager, "getEntry").mockImplementation((id) =>
      id === entryId ? undefined : getEntry(id),
    );
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:lost-proof"));
    }).toThrow("Missing archived");
    expect(currentRuntime().journalFault).toContain("Missing archived");
    expect(
      getHandler(h.mock, "tool_call")(
        { type: "tool_call", toolName: "get_ready_tasks", input: { count: 1 } },
        h.ctx,
      ),
    ).toMatchObject({ block: true, reason: expect.stringContaining("Missing archived") });
  });

  it("replays committed receipts after the last small checkpoint without repeating execution", () => {
    const h = fixture();
    h.capture("committed");
    const board = getBoard();
    resetState();
    setBoard(board);
    restoreSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.stats.count).toBe(1);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:committed"])[0]?.id).toBe(
      "tool:committed",
    );
    expect(supervisorState()!.status).toBe("fault");
    recoverSupervisor(h.mock.api, h.ctx);
    expect(supervisorState()!.status).toBe("active");
  });

  it("keeps an interrupted mutation unknown and requires explicit recovery with a freshness barrier", () => {
    const h = fixture();
    h.begin("interrupted-write", { toolName: "write" });
    expect(supervisorState()!.epoch).toBe(1);
    const board = getBoard();
    resetState();
    setBoard(board);
    restoreSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.pendingCount).toBe(1);
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
    recoverSupervisor(h.mock.api, h.ctx);
    expect(supervisorState()!.epoch).toBe(2);
    expect(currentRuntime().receiptStore!.pendingCount).toBe(0);
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
  });

  it("persists a late-result freshness barrier without fabricating a replacement proof", () => {
    const h = fixture();
    h.begin("late-write", { toolName: "write" });
    const board = getBoard();
    resetState();
    setBoard(board);
    restoreSupervisor(h.mock.api, h.ctx);
    recoverSupervisor(h.mock.api, h.ctx);
    h.capture("before-late", {
      toolName: "validate_readonly",
      structuredContent: { exit_code: 0 },
    });
    h.finish("late-write", { toolName: "write" });
    expect(supervisorState()!.epoch).toBe(3);
    expect(currentRuntime().receiptStore!.stats.count).toBe(1);
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:before-late"));
    }).toThrow("fresh host receipt");
    const current = getBoard();
    resetState();
    setBoard(current);
    restoreSupervisor(h.mock.api, h.ctx);
    expect(supervisorState()!.epoch).toBe(3);
    expect(currentRuntime().receiptStore!.stats.count).toBe(1);
  });

  it("rejects an unrepresentable host capture before it can poison the durable ledger", () => {
    const h = fixture();
    const before = h.manager.getBranch().length;
    expect(h.begin("x".repeat(400), { toolName: "write" })).toMatchObject({ block: true });
    expect(h.manager.getBranch()).toHaveLength(before);
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
  });

  it("does not trust an append that returns without a real native entry", () => {
    const h = fixture();
    h.mock.appendEntry.mockImplementationOnce(() => undefined);
    expect(h.begin("invisible", { toolName: "write" })).toMatchObject({ block: true });
    expect(currentRuntime().journalFault).toContain("not confirmed");
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
  });

  it("restores a committed intent after an uncertain append without retrying it", () => {
    const h = fixture();
    h.mock.appendEntry.mockImplementationOnce((type: string, data: unknown) => {
      h.manager.appendCustomEntry(type, structuredClone(data));
      throw new Error("append committed before transport failed");
    });
    expect(h.begin("uncertain-intent", { toolName: "write" })).toMatchObject({ block: true });
    const board = getBoard();
    resetState();
    setBoard(board);
    restoreSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.pendingCount).toBe(1);
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
    expect(supervisorState()!.epoch).toBe(1);
  });

  it("replays a committed result even when its acknowledgement failed", () => {
    const h = fixture();
    h.begin("uncertain-result", { toolName: "write" });
    h.mock.appendEntry.mockImplementationOnce((type: string, data: unknown) => {
      h.manager.appendCustomEntry(type, structuredClone(data));
      throw new Error("receipt committed before acknowledgement failed");
    });
    h.finish("uncertain-result", { toolName: "write" });
    const board = getBoard();
    resetState();
    setBoard(board);
    restoreSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.stats.count).toBe(1);
    expect(currentRuntime().receiptStore!.pendingCount).toBe(0);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:uncertain-result"])).toHaveLength(1);
  });

  it("does not mislabel a SDK-blocked tool as executed or fabricate its receipt", () => {
    const h = fixture();
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("cannot record intent");
    });
    expect(h.begin("blocked-result", { toolName: "write" })).toMatchObject({ block: true });
    expect(h.finish("blocked-result", { toolName: "write", isError: true })).toBeUndefined();
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
    expect(h.ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("fails closed rather than guessing how to load an unsupported checkpoint version", async () => {
    const h = fixture();
    const entry = h.manager
      .getBranch()
      .find((e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY)!;
    if (entry.type === "custom") (entry.data as { version: number }).version = 4;
    await getHandler(h.mock, "session_start")({}, h.ctx);
    expect(currentRuntime().journalFault).toContain("Invalid supervisor journal");
    expect(supervisorState()).toBeUndefined();
    expect(h.mock.setActiveTools).toHaveBeenLastCalledWith(["read"]);
  });

  it("blocks a mutation before execution when its intent cannot be persisted", () => {
    const h = fixture();
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    expect(h.begin("blocked-write", { toolName: "write" })).toMatchObject({
      block: true,
      reason: expect.stringContaining("Tool not started"),
    });
    expect(currentRuntime().journalFault).toContain("persistence");
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
  });

  it.each([2, 500])(
    "migrates %i legacy receipts only on explicit recovery and requires fresh validation",
    (count) => {
      const h = legacyFixture(count);
      expect(currentRuntime().receiptStore).toBeUndefined();
      expect(supervisorState()!.status).toBe("fault");
      recoverSupervisor(h.mock.api, h.ctx);
      const store = currentRuntime().receiptStore!;
      expect(store.stats.count).toBe(count);
      expect(supervisorState()).toMatchObject({
        status: "active",
        // Saturation invalidates once at load; explicit format recovery creates its own freshness boundary.
        epoch: count === 500 ? 6 : 5,
        tokens: 123,
        cost: 0.25,
        reviews: 0,
      });
      expect(() => {
        assertObservedEvidence("t-1.1", proof("tool:legacy-0"));
      }).toThrow("fresh host receipt");
      expect(store.readReceipts(["tool:legacy-0"])[0]?.output).toBe("historical fixture");
      const metadata = h.manager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY)
        .at(-1)!;
      expect(metadata).toMatchObject({
        data: {
          version: 3,
          receipts: [],
          receiptLedger: { receiptCount: count, legacyBase: { entryId: expect.any(String) } },
        },
      });
      const board = getBoard();
      resetState();
      setBoard(board);
      restoreSupervisor(h.mock.api, h.ctx);
      expect(currentRuntime().receiptStore!.stats.count).toBe(count);
      expect(currentRuntime().receiptStore!.readReceipts(["tool:legacy-0"])).toHaveLength(1);
    },
  );

  it("does not migrate or reopen a stopped legacy goal", () => {
    const h = legacyFixture(500, "stopped");
    expect(supervisorState()!.status).toBe("stopped");
    expect(currentRuntime().receiptStore).toBeUndefined();
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
    expect(() => {
      recoverSupervisor(h.mock.api, h.ctx);
    }).toThrow("not paused or faulted");
  });

  it("is idempotent even after a duplicate's body has left the cache, but rejects conflicts", () => {
    const h = fixture();
    currentRuntime().receiptStore!.configure({ maxEntries: 1, maxBytes: 16_384 });
    h.capture("one");
    h.capture("two");
    h.capture("one");
    expect(currentRuntime().receiptStore!.stats.count).toBe(2);
    h.capture("one", { content: [{ type: "text", text: "conflicting body" }] });
    expect(currentRuntime().journalFault).toContain("Conflicting duplicate");
    expect(currentRuntime().receiptStore!.stats.count).toBe(2);
  });

  it("does not let a checkpoint redefine the user goal under the same ledger identity", () => {
    const h = fixture();
    h.capture("one");
    saveSupervisor(h.mock.api);
    const last = [...h.manager.getBranch()]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY)!;
    if (last.type === "custom")
      (last.data as { goal: string }).goal = "A different unapproved goal";
    const board = getBoard();
    resetState();
    setBoard(board);
    expect(() => {
      restoreSupervisor(h.mock.api, h.ctx);
    }).toThrow(/identity|goal scope/);
  });

  it("rejects an altered archived ledger record on restart", () => {
    const h = fixture();
    h.capture("one");
    const entry = h.manager
      .getBranch()
      .find((e) => e.type === "custom" && e.customType === RECEIPT_LEDGER_ENTRY)!;
    if (entry.type === "custom") (entry.data as { hash: string }).hash = "b".repeat(64);
    const board = getBoard();
    resetState();
    setBoard(board);
    expect(() => {
      restoreSupervisor(h.mock.api, h.ctx);
    }).toThrow(/ledger/);
  });

  it("rejects a checkpoint counter that is not explained by its ledger", () => {
    const h = fixture();
    const entry = h.manager
      .getBranch()
      .find((e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY)!;
    if (entry.type === "custom")
      (entry.data as { receiptLedger: { receiptCount: number } }).receiptLedger.receiptCount = 1;
    const board = getBoard();
    resetState();
    setBoard(board);
    expect(() => {
      restoreSupervisor(h.mock.api, h.ctx);
    }).toThrow("checkpoint");
  });

  it("refuses to restore an own receipt stream after its goal checkpoints disappear", () => {
    const h = fixture();
    h.capture("one");
    for (const entry of h.manager.getBranch())
      if (entry.type === "custom" && entry.customType === SUPERVISOR_ENTRY)
        entry.customType = "missing-checkpoint";
    const board = getBoard();
    resetState();
    setBoard(board);
    expect(() => {
      restoreSupervisor(h.mock.api, h.ctx);
    }).toThrow(/checkpoint|ledger/);
  });

  it("bounds UTF-8 cache bytes while an oversized individual proof remains archived", () => {
    const board = getBoard();
    board.tasks = Array.from({ length: 100 }, (_, i) => ({
      ...board.tasks[0]!,
      id: `t-1.${i + 1}`,
      status: "reviewing",
    }));
    setBoard(board);
    const h = fixture();
    const store = currentRuntime().receiptStore!;
    store.configure({ maxEntries: 100, maxBytes: 16_384 });
    h.capture("oversized", {
      input: { text: "核".repeat(2000) },
      content: [{ type: "text", text: "验".repeat(2000) }],
    });
    expect(store.stats.cacheEntries).toBe(0);
    expect(store.readReceipts(["tool:oversized"])).toHaveLength(1);
    expect(store.stats.cacheBytes).toBe(0);
    h.capture("small");
    expect(store.stats.cacheBytes).toBeLessThanOrEqual(16_384);
    expect(() => {
      store.configure({ maxEntries: 0, maxBytes: 16_384 });
    }).toThrow("Invalid bounded");
  });

  it("preserves branch membership instead of reading an archived sibling's proof", () => {
    const h = fixture();
    h.capture("common");
    const leaf = h.manager.getLeafId()!;
    h.capture("sibling");
    h.manager.branch(leaf);
    const board = getBoard();
    resetState();
    setBoard(board);
    restoreSupervisor(h.mock.api, h.ctx);
    const store = currentRuntime().receiptStore!;
    expect(store.readReceipts(["tool:common"])).toHaveLength(1);
    expect(store.readReceipts(["tool:sibling"])).toHaveLength(0);
  });

  it("keeps the same goal text from inheriting a replacement goal's receipt IDs", () => {
    const h = fixture();
    h.capture("previous-goal");
    const oldId = currentRuntime().receiptStore!.checkpoint().goalId;
    supervisorState()!.status = "stopped";
    startSupervisor(h.mock.api, h.ctx, "Retain long-running host evidence");
    expect(currentRuntime().receiptStore!.checkpoint().goalId).not.toBe(oldId);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:previous-goal"])).toHaveLength(0);
  });

  it("does not promote a result started before the current task review", () => {
    const board = getBoard();
    board.tasks[0]!.status = "implementing";
    setBoard(board);
    const h = fixture();
    const command = { toolName: "validate_readonly", structuredContent: { exit_code: 0 } };
    h.begin("too-early", command);
    board.tasks[0]!.status = "reviewing";
    setBoard(board);
    h.finish("too-early", command);
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:too-early"));
    }).toThrow("fresh host receipt");
  });

  it("invalidates a child validation when an opaque parent may still modify work", () => {
    const h = fixture();
    h.begin("opaque-parent", { toolName: "codemode" });
    h.capture("child-proof", { toolName: "bash", structuredContent: { exit_code: 0 } });
    h.finish("opaque-parent", { toolName: "codemode" });
    expect(supervisorState()!.epoch).toBe(3);
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:child-proof"));
    }).toThrow("fresh host receipt");
    h.capture("independent-proof", { toolName: "bash", structuredContent: { exit_code: 0 } });
    expect(() => {
      assertObservedEvidence("t-1.1", proof("tool:independent-proof"));
    }).not.toThrow();
  });

  it("keeps a failed result append visibly unknown instead of retrying its tool", () => {
    const h = fixture();
    h.begin("may-have-written", { toolName: "write" });
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("result disk failure");
    });
    h.finish("may-have-written", { toolName: "write" });
    expect(currentRuntime().journalFault).toContain("result disk failure");
    const alerts = (h.ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.length;
    h.finish("may-have-written", { toolName: "write" });
    expect(h.ctx.ui.notify).toHaveBeenCalledTimes(alerts);
    expect(currentRuntime().receiptStore!.pendingCount).toBe(1);
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
    expect(supervisorState()!.epoch).toBe(1);
  });

  it("measures linear encoded ledger growth with a bounded raw cache", () => {
    const n = Number(process.env.RECEIPT_RESOURCE_N ?? 100);
    expect(Number.isSafeInteger(n) && n >= 10 && n <= 5000).toBe(true);
    const h = fixture();
    const branchCalls = vi.spyOn(h.manager, "getBranch");
    const encodedBytes = () =>
      h.manager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === RECEIPT_LEDGER_ENTRY)
        .reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e), "utf8"), 0);
    const start = performance.now();
    let halfBytes = 0;
    for (let i = 0; i < n; i++) {
      h.capture(`resource-${i}`);
      if (i + 1 === Math.floor(n / 2)) halfBytes = encodedBytes();
    }
    const bytes = encodedBytes();
    const stats = currentRuntime().receiptStore!.stats;
    expect(bytes / halfBytes).toBeLessThanOrEqual(2.5);
    expect(stats.count).toBe(n);
    expect(stats.cacheEntries).toBeLessThanOrEqual(stats.maxEntries);
    expect(stats.cacheBytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.indexed).toBe(n);
    expect(branchCalls).toHaveBeenCalledTimes(2);
    if (process.env.RECEIPT_RESOURCE_REPORT)
      writeFileSync(
        process.env.RECEIPT_RESOURCE_REPORT,
        JSON.stringify(
          {
            n,
            halfBytes,
            encodedLedgerBytes: bytes,
            growth: bytes / halfBytes,
            elapsedMs: performance.now() - start,
            journal: "SDK in-memory; encoded ledger bytes, not disk latency",
            ...stats,
          },
          null,
          2,
        ) + "\n",
      );
  });

  it("does not bless validation that overlaps an unfinished mutation", () => {
    const h = fixture();
    h.begin("writer", { toolName: "write" });
    h.capture("overlap", { toolName: "validate_readonly", structuredContent: { exit_code: 0 } });
    h.finish("writer", { toolName: "write" });
    expect(() => {
      assertObservedEvidence("t-1.1", {
        summary: "Cannot use overlapping proof",
        refs: [
          { kind: "command", label: "fixture", status: "passed", exitCode: 0, ref: "tool:overlap" },
        ],
      });
    }).toThrow("fresh host receipt");
    h.capture("fresh", { toolName: "validate_readonly", structuredContent: { exit_code: 0 } });
    expect(() => {
      assertObservedEvidence("t-1.1", {
        summary: "Independent final fixture",
        refs: [
          { kind: "command", label: "fixture", status: "passed", exitCode: 0, ref: "tool:fresh" },
        ],
      });
    }).not.toThrow();
  });
});
