import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetState, setBoard, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { registerCommands } from "../commands";
import { setSessionScopeEnabled } from "../scope";
import {
  digest,
  restoreSupervisor,
  recoverSupervisor,
  readSupervisorStartRecord,
  supervisorState,
  saveSupervisor,
  SUPERVISOR_ENTRY,
  assertObservedEvidence,
} from "../supervisor";
import { activeBoard } from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

type Status = "completed" | "paused" | "fault" | "stopped";
function fixture(count: number, status: Status, seed = true) {
  const manager = SessionManager.inMemory();
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { sessionManager: manager, model: { provider: "faux", id: "test" } });
  mock.appendEntry.mockImplementation((kind: string, data: unknown) => {
    manager.appendCustomEntry(kind, structuredClone(data));
  });
  const board = activeBoard();
  if (status === "completed") {
    board.workflowStatus = "completed";
    board.tasks = board.tasks.map((task, i) => ({
      ...task,
      status: "done",
      completionEvidence: {
        summary: "Historical fixture validation",
        refs: [
          {
            kind: "command",
            label: "fixture",
            status: "passed",
            exitCode: 0,
            ref: `tool:legacy-${i}`,
          },
        ],
      },
    }));
    board.phases = board.phases.map((phase) => ({ ...phase, status: "completed" }));
  } else board.tasks[0]!.status = "reviewing";
  const receipts = Array.from({ length: count }, (_, i) => ({
    id: `tool:legacy-${i}`,
    tool: "fixture",
    taskIds: ["t-1.1"],
    reviews: [{ taskId: "t-1.1", digest: "a".repeat(64) }],
    epoch: 9,
    ok: true,
    exitCode: 0,
    digest: "b".repeat(64),
    input: "{}",
    output: "Historical fixture only",
  }));
  const source = {
    version: 1,
    sessionId: manager.getSessionId(),
    goal: "Legacy fixture verification",
    model: { provider: "faux", id: "test" },
    status,
    reviews: 7,
    continuations: 3,
    stagnant: 1,
    epoch: 9,
    pending: false,
    tokens: 1234,
    cost: 0.75,
    receipts,
    bindings:
      status === "completed"
        ? board.tasks.map((task, i) => ({
            taskId: task.id,
            digest: digest(task),
            refs: [`tool:legacy-${i}`],
          }))
        : [],
    ...(status === "completed" ? { acceptedDigest: digest(board) } : {}),
    ...(status === "paused" ? { holdCause: "user_pause", reason: "Human pause remains" } : {}),
  };
  const id = seed ? manager.appendCustomEntry(SUPERVISOR_ENTRY, structuredClone(source)) : "";
  setBoard(board);
  return {
    manager,
    mock,
    ctx,
    source,
    id,
    restore: () => {
      restoreSupervisor(mock.api, ctx);
    },
  };
}

function v2Fixture(count: number, status: Status) {
  const h = fixture(count, status, false);
  let head: string | null = null;
  const batches: string[] = [];
  for (let offset = 0; offset < count; offset += 500) {
    const payload = {
      version: 1,
      sessionId: h.manager.getSessionId(),
      journalId: "v2-fixture",
      previousHead: head,
      first: offset + 1,
      receipts: h.source.receipts.slice(offset, offset + 500),
    };
    head = digest(payload);
    batches.push(
      h.manager.appendCustomEntry("continuous-tasks:supervisor-receipts", { ...payload, head }),
    );
  }
  const source = {
    ...h.source,
    version: 2,
    receipts: [],
    receiptJournal: { id: "v2-fixture", count, head },
  };
  const id = h.manager.appendCustomEntry(SUPERVISOR_ENTRY, structuredClone(source));
  return { ...h, id, source, batches };
}

describe("receipt integration safety and legacy formats", () => {
  beforeEach(() => {
    resetState();
  });

  it.each([1, 2])(
    "reads an exact empty version-%s checkpoint without publishing a Supervisor",
    (version) => {
      const h = version === 1 ? fixture(0, "paused") : v2Fixture(0, "paused");
      const record = readSupervisorStartRecord(h.ctx, h.id);
      expect(record).toMatchObject({
        entryId: h.id,
        state: { version: 1, goal: "Legacy fixture verification", receipts: [] },
      });
      expect(supervisorState()).toBeUndefined();
      expect(h.mock.appendEntry).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])(
    "rejects retained version-%s receipt history as an initial native start",
    (version) => {
      const h = version === 1 ? fixture(2, "paused") : v2Fixture(2, "paused");
      expect(() => readSupervisorStartRecord(h.ctx, h.id)).toThrow(/inherited receipts/);
      expect(supervisorState()).toBeUndefined();
      expect(h.mock.appendEntry).not.toHaveBeenCalled();
    },
  );

  it("preserves a validated completed legacy goal below saturation", () => {
    const h = fixture(499, "completed");
    h.restore();
    expect(supervisorState()!.status).toBe("completed");
    expect(supervisorState()!.epoch).toBe(9);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });

  it("invalidates saturated legacy acceptance without reopening the completed board", () => {
    const h = fixture(500, "completed");
    const sourceHash = digest(h.source);
    h.restore();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      epoch: 10,
      receiptGapEpoch: 10,
      acceptedDigest: undefined,
      reviews: 7,
      continuations: 3,
      tokens: 1234,
      cost: 0.75,
    });
    expect(getBoard().workflowStatus).toBe("completed");
    expect(getBoard().tasks.every((task) => task.status === "done")).toBe(true);
    expect(
      digest(
        h.manager.getEntry(h.id)?.type === "custom"
          ? (h.manager.getEntry(h.id) as { data: unknown }).data
          : undefined,
      ),
    ).toBe(sourceHash);
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(supervisorState()!.epoch).toBe(10);
    expect(() => {
      recoverSupervisor(h.mock.api, h.ctx);
    }).toThrow("completed board");
    expect(currentRuntime().receiptStore).toBeUndefined();
  });

  it("keeps a saturated legacy user pause and budgets while recording the gap once", () => {
    const h = fixture(500, "paused");
    h.restore();
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "user_pause",
      reason: "Human pause remains",
      epoch: 10,
      receiptGapEpoch: 10,
      reviews: 7,
      continuations: 3,
      cost: 0.75,
    });
    expect(currentRuntime().receiptStore).toBeUndefined();
    const last = [...h.manager.getBranch()]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY);
    expect(last).toMatchObject({ data: { version: 1, receiptGapEpoch: 10 } });
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(supervisorState()!.epoch).toBe(10);
  });

  it("retains v2 checkpoint writes but refuses a full v1 fallback when its view is lost", () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    saveSupervisor(h.mock.api);
    expect(h.manager.getLeafEntry()).toMatchObject({
      type: "custom",
      data: { version: 2, receipts: [], receiptJournal: { count: 2 } },
    });
    const before = structuredClone(h.manager.getBranch());
    currentRuntime().receiptStore = undefined;

    expect(() => {
      saveSupervisor(h.mock.api);
    }).toThrow(/receipt ledger is unavailable/);
    expect(h.manager.getBranch()).toEqual(before);
  });

  it("reads an installed-format v2 completed goal without silently discarding supervision", () => {
    const h = v2Fixture(2, "completed");
    h.restore();
    expect(supervisorState()!.status).toBe("completed");
    expect(currentRuntime().receiptStore!.stats).toMatchObject({ count: 2, format: 2 });
    expect(currentRuntime().receiptStore!.readReceipts(["tool:legacy-0"])).toHaveLength(1);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });

  it("keeps 501 v2 receipt bodies in their archive and migrates only through explicit recover", () => {
    const h = v2Fixture(501, "paused");
    const original = digest(h.source);
    h.restore();
    expect(currentRuntime().receiptStore!.stats).toMatchObject({ count: 501, format: 2 });
    expect(supervisorState()!.receipts.length).toBeLessThanOrEqual(128);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
    recoverSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.stats).toMatchObject({ count: 501, format: 3 });
    expect(supervisorState()).toMatchObject({
      status: "active",
      epoch: 10,
      tokens: 1234,
      cost: 0.75,
    });
    const entry = h.manager.getEntry(h.id);
    expect(entry?.type === "custom" ? digest(entry.data) : "").toBe(original);
    expect(
      h.manager
        .getBranch()
        .filter(
          (e) => e.type === "custom" && e.customType === "continuous-tasks:supervisor-receipts",
        ),
    ).toHaveLength(2);
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(currentRuntime().receiptStore!.stats.count).toBe(501);
    expect(currentRuntime().receiptStore!.readReceipts(["tool:legacy-0"])).toHaveLength(1);
  });

  it.each(["missing", "tampered", "duplicate", "orphan", "count", "downgrade", "scope"])(
    "rejects malformed v2 history: %s",
    (kind) => {
      const h = v2Fixture(2, "paused");
      const batch = h.manager.getEntry(h.batches[0]!);
      const header = h.manager.getEntry(h.id);
      if (batch?.type !== "custom" || header?.type !== "custom")
        throw new Error("Missing test fixture");
      if (kind === "missing") batch.customType = "missing-batch";
      if (kind === "tampered") (batch.data as { head: string }).head = "c".repeat(64);
      if (kind === "duplicate")
        h.manager.appendCustomEntry(
          "continuous-tasks:supervisor-receipts",
          structuredClone(batch.data),
        );
      if (kind === "orphan") header.customType = "missing-v2-checkpoint";
      if (kind === "count") (header.data as typeof h.source).receiptJournal.count++;
      if (kind === "downgrade")
        h.manager.appendCustomEntry(SUPERVISOR_ENTRY, { ...h.source, version: 1, receipts: [] });
      if (kind === "scope")
        h.manager.appendCustomEntry(SUPERVISOR_ENTRY, {
          ...h.source,
          goal: "Different goal under the same v2 journal",
        });
      expect(() => {
        h.restore();
      }).toThrow(/v2|downgrade/i);
    },
  );

  it("does not inherit a foreign session's v2 goal or receipts", () => {
    const h = v2Fixture(2, "paused");
    vi.spyOn(h.manager, "getSessionId").mockReturnValue("another-session");
    h.restore();
    expect(supervisorState()).toBeUndefined();
    expect(currentRuntime().receiptStore).toBeUndefined();
  });

  it("persists interrupted v2 control metadata without auto-migrating its receipt bodies", () => {
    const h = v2Fixture(2, "fault");
    const active = { ...h.source, status: "active" };
    h.manager.appendCustomEntry(SUPERVISOR_ENTRY, active);
    h.restore();
    expect(supervisorState()!.status).toBe("fault");
    expect(currentRuntime().receiptStore!.format).toBe(2);
    const last = [...h.manager.getBranch()]
      .reverse()
      .find((e) => e.type === "custom" && e.customType === SUPERVISOR_ENTRY);
    expect(last).toMatchObject({
      data: { version: 2, receipts: [], receiptJournal: { count: 2 } },
    });
    recoverSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.format).toBe(3);
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(currentRuntime().receiptStore!.readReceipts(["tool:legacy-0"])).toHaveLength(1);
  });

  it("does not publish an active v2 recovery candidate when its v3 checkpoint fails", () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    h.mock.appendEntry.mockImplementationOnce(() => {
      throw new Error("recovery disk failure");
    });
    expect(() => {
      recoverSupervisor(h.mock.api, h.ctx);
    }).toThrow("recovery disk failure");
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reviews: 7,
      continuations: 3,
      tokens: 1234,
    });
    expect(currentRuntime().journalFault).toContain("recovery disk failure");
  });

  it("reads and promotes an empty v2 journal without manufacturing receipt bodies", () => {
    const h = v2Fixture(0, "paused");
    h.restore();
    expect(currentRuntime().receiptStore!.stats).toMatchObject({ format: 2, count: 0 });
    recoverSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.stats).toMatchObject({ format: 3, count: 0 });
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(currentRuntime().receiptStore!.stats.count).toBe(0);
  });

  it.each(["body", "checkpoint"])("locks a v2 view after archive %s tampering", (kind) => {
    const h = v2Fixture(2, "paused");
    h.restore();
    const id = kind === "body" ? h.batches[0]! : h.id;
    const entry = h.manager.getEntry(id);
    if (entry?.type !== "custom") throw new Error("Missing fixture entry");
    if (kind === "body")
      (entry.data as { receipts: { output: string }[] }).receipts[0]!.output = "changed archive";
    else (entry.data as { reason: string }).reason = "changed checkpoint";
    // Reach the archive reader itself: the legacy execution gate alone must
    // not make a corrupt-archive test pass without checking the archived body.
    expect(() => currentRuntime().receiptStore!.readReceipts(["tool:legacy-0"])).toThrow(
      /Changed v2 archive/,
    );
    expect(currentRuntime().receiptStore!.healthy).toBe(false);
    expect(() => {
      assertObservedEvidence("t-1.1", {
        summary: "Cannot trust corrupt archive",
        refs: [
          {
            kind: "command",
            label: "fixture",
            status: "passed",
            exitCode: 0,
            ref: "tool:legacy-0",
          },
        ],
      });
    }).toThrow(/v2/);
    expect(currentRuntime().journalFault).toContain("v2");
  });

  it("rejects a rehashed v2 batch that no longer belongs to its validated archive head", () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    const anchor = h.manager.getEntry(h.id);
    const batch = h.manager.getEntry(h.batches[0]!);
    if (anchor?.type !== "custom" || batch?.type !== "custom")
      throw new Error("Missing fixture archive");
    const anchorDigest = digest(anchor.data);
    const { head: originalHead, ...payload } = batch.data as {
      head: string;
      receipts: Array<{ output: string }>;
    };
    payload.receipts[0]!.output = "Changed body with a self-consistent new batch hash";
    const head = digest(payload);
    expect(head).not.toBe(originalHead);
    batch.data = { ...payload, head };
    expect(() => currentRuntime().receiptStore!.readReceipts(["tool:legacy-0"])).toThrow(
      /Changed v2 archive/,
    );
    expect(currentRuntime().receiptStore!.healthy).toBe(false);
    expect(digest(anchor.data)).toBe(anchorDigest);
  });

  it("blocks promotion when its latest v2 checkpoint has changed", () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    const entry = h.manager.getEntry(h.id);
    if (entry?.type === "custom") (entry.data as { reason: string }).reason = "unexpected change";
    expect(() => {
      recoverSupervisor(h.mock.api, h.ctx);
    }).toThrow("Changed v2 migration anchor");
    expect(supervisorState()).toMatchObject({ status: "fault", reviews: 7 });
    expect(currentRuntime().journalFault).toContain("Changed v2");
  });

  it("does not lose a gap barrier that committed before its acknowledgement failed", () => {
    const h = fixture(500, "completed");
    h.mock.appendEntry.mockImplementationOnce((kind: string, data: unknown) => {
      h.manager.appendCustomEntry(kind, structuredClone(data));
      throw new Error("barrier acknowledgement lost");
    });
    expect(() => {
      h.restore();
    }).toThrow("acknowledgement lost");
    expect(supervisorState()).toMatchObject({
      status: "fault",
      epoch: 10,
      receiptGapEpoch: 10,
      acceptedDigest: undefined,
    });
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(supervisorState()!.epoch).toBe(10);
  });

  it("rejects a gap checkpoint that was not actually appended", () => {
    const h = fixture(500, "completed");
    const before = h.manager.getBranch().length;
    h.mock.appendEntry.mockImplementationOnce(() => undefined);
    expect(() => {
      h.restore();
    }).toThrow("not confirmed");
    expect(supervisorState()!.acceptedDigest).toBeUndefined();
    expect(h.manager.getBranch()).toHaveLength(before);
  });

  it("does not allow a forged existing gap marker to retain completed acceptance", () => {
    const h = fixture(500, "completed");
    const entry = h.manager.getEntry(h.id);
    if (entry?.type === "custom") (entry.data as { receiptGapEpoch?: number }).receiptGapEpoch = 9;
    expect(() => {
      h.restore();
    }).toThrow("Invalid legacy receipt gap");
    expect(supervisorState()).toMatchObject({ status: "fault", acceptedDigest: undefined });
  });

  it("keeps ordinary v2 board resume separate from the explicit format recovery", async () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    const board = getBoard();
    board.workflowStatus = "paused";
    board.pauseReason = "Human pause remains";
    setBoard(board);
    setSessionScopeEnabled(true);
    registerCommands(h.mock.api);
    const cmd = h.mock.registerCommand.mock.calls.find(
      ([name]) => name === "task-supervisor",
    )?.[1] as { handler: (args: string, ctx: typeof h.ctx) => Promise<void> };
    await cmd.handler("resume", h.ctx);
    expect(getBoard().workflowStatus).toBe("active");
    expect(supervisorState()!.status).toBe("paused");
    expect(currentRuntime().receiptStore!.format).toBe(2);
    expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn === true)).toBe(
      false,
    );
    recoverSupervisor(h.mock.api, h.ctx);
    expect(currentRuntime().receiptStore!.format).toBe(3);
  });

  it("bounds v2 archive reads independently from their total receipt count", () => {
    const h = v2Fixture(501, "paused");
    h.restore();
    const store = currentRuntime().receiptStore!;
    store.configure({ maxEntries: 1, maxBytes: 16_384 });
    expect(store.readReceipts(["tool:legacy-0", "tool:legacy-500"])).toHaveLength(2);
    expect(store.stats).toMatchObject({ count: 501, cacheEntries: 1, format: 2 });
    expect(store.readReceipts([], 30)).toHaveLength(30);
    expect(store.stats.cacheEntries).toBe(1);
  });

  it("checks v2 predecessor order even when a changed payload has a valid digest", () => {
    const h = v2Fixture(2, "paused");
    const entry = h.manager.getEntry(h.batches[0]!);
    const header = h.manager.getEntry(h.id);
    if (entry?.type !== "custom" || header?.type !== "custom") throw new Error("Missing fixture");
    const body = { ...(entry.data as Record<string, unknown>) };
    delete body.head;
    const payload = { ...body, previousHead: "e".repeat(64) };
    entry.data = { ...payload, head: digest(payload) };
    (header.data as typeof h.source).receiptJournal.head = digest(payload);
    expect(() => {
      h.restore();
    }).toThrow("v2 receipt batch order");
  });

  it("preserves the installed v2 optional zero marker as metadata without treating it as a v1 gap barrier", () => {
    const h = v2Fixture(2, "paused");
    const header = h.manager.getEntry(h.id);
    if (header?.type === "custom")
      (header.data as { receiptGapEpoch?: number }).receiptGapEpoch = 0;
    h.restore();
    expect(currentRuntime().receiptStore!.format).toBe(2);
    recoverSupervisor(h.mock.api, h.ctx);
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(currentRuntime().receiptStore!.format).toBe(3);
    expect(supervisorState()!.epoch).toBe(10);
  });

  it("does not let a zero marker bypass saturation invalidation on inline v1 data", () => {
    const h = fixture(500, "paused");
    const header = h.manager.getEntry(h.id);
    if (header?.type === "custom")
      (header.data as { receiptGapEpoch?: number }).receiptGapEpoch = 0;
    expect(() => {
      h.restore();
    }).toThrow("Invalid legacy receipt gap");
    expect(supervisorState()!.status).toBe("fault");
  });

  it("never borrows a v2 checkpoint from a sibling branch to close its batches", () => {
    const h = v2Fixture(2, "paused");
    h.manager.branch(h.batches[0]!);
    expect(h.manager.getEntry(h.id)).toBeDefined();
    expect(h.manager.getBranch().some((entry) => entry.id === h.id)).toBe(false);
    expect(() => {
      h.restore();
    }).toThrow("Uncommitted v2 receipt journal");
  });

  it("rejects a v3 v2-base anchor that is native but only exists on a sibling branch", () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    recoverSupervisor(h.mock.api, h.ctx);
    const tip = h.manager.getLeafId()!;
    h.manager.branch(h.id);
    const sibling = { ...h.source, reason: "Sibling control checkpoint" };
    const siblingId = h.manager.appendCustomEntry(SUPERVISOR_ENTRY, sibling);
    h.manager.branch(tip);
    const checkpoint = h.manager.getEntry(tip);
    if (checkpoint?.type !== "custom") throw new Error("Missing v3 fixture");
    const data = checkpoint.data as {
      receiptLedger: { legacyBase: { entryId: string; digest: string; version: 2 } };
    };
    data.receiptLedger.legacyBase = { entryId: siblingId, digest: digest(sibling), version: 2 };
    const board = getBoard();
    resetState();
    setBoard(board);
    expect(() => {
      h.restore();
    }).toThrow("Legacy receipt goal scope");
  });

  it("retains runtime fault on an unacknowledged committed recovery and never auto-runs after reopen", () => {
    const h = v2Fixture(2, "paused");
    h.restore();
    h.mock.appendEntry.mockImplementationOnce((kind: string, data: unknown) => {
      h.manager.appendCustomEntry(kind, structuredClone(data));
      throw new Error("recovery acknowledgement lost");
    });
    expect(() => {
      recoverSupervisor(h.mock.api, h.ctx);
    }).toThrow("acknowledgement lost");
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reviews: 7,
      continuations: 3,
      pending: false,
    });
    expect(currentRuntime().journalFault).toContain("acknowledgement lost");
    const board = getBoard();
    resetState();
    setBoard(board);
    h.restore();
    expect(supervisorState()).toMatchObject({ status: "fault", pending: false });
    expect(supervisorState()!.reason).toContain("Interrupted review/continuation");
    // Reopen uses the checkpoint that actually committed, not the old runtime counters.
    expect(supervisorState()!.reviews).toBe(0);
    expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn === true)).toBe(
      false,
    );
    expect(
      h.manager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom" && entry.customType === "continuous-tasks:supervisor-receipts",
        ),
    ).toHaveLength(1);
  });

  it("retains a saturated legacy view under a human projection fault without writing a gap barrier", () => {
    const h = fixture(500, "paused");
    currentRuntime().journalFault = "Human projection pending explicit repair";
    h.restore();
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "user_pause",
      epoch: 9,
      reviews: 7,
      continuations: 3,
      tokens: 1234,
      cost: 0.75,
    });
    expect(supervisorState()!.receipts).toHaveLength(500);
    expect(supervisorState()!.receiptGapEpoch).toBeUndefined();
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
    expect(currentRuntime().journalFault).toBe("Human projection pending explicit repair");
  });

  it("records a deferred legacy saturation barrier before explicit migration after the human hold clears", () => {
    const h = fixture(500, "paused");
    currentRuntime().journalFault = "Human projection pending explicit repair";
    h.restore();
    expect(supervisorState()!.epoch).toBe(9);
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
    // The human repair is outside this owner test; represent its completed hold
    // without granting new scope, then exercise the existing explicit recover.
    currentRuntime().journalFault = undefined;
    recoverSupervisor(h.mock.api, h.ctx);
    expect(supervisorState()).toMatchObject({
      epoch: 11,
      receiptGapEpoch: 10,
      tokens: 1234,
      cost: 0.75,
    });
    expect(currentRuntime().receiptStore!.stats).toMatchObject({ format: 3, count: 500 });
    expect(
      h.manager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === SUPERVISOR_ENTRY &&
            (entry.data as { version: number; receiptGapEpoch?: number }).version === 1 &&
            (entry.data as { receiptGapEpoch?: number }).receiptGapEpoch === 10,
        ),
    ).toBe(true);
  });

  it("does not disturb a stopped saturated legacy goal", () => {
    const h = fixture(500, "stopped");
    h.restore();
    expect(supervisorState()).toMatchObject({ status: "stopped", epoch: 9 });
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
  });
});
