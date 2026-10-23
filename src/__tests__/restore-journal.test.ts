import {
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beginRestoreJournal, RestoreReadInvalidated } from "../restore-journal";
import { invalidateGoalCallbacks } from "../goal-scope";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { findGoalReadbackProof, journalDigest } from "../human-journal";
import { inspectRestorableSession } from "../human-control";
import { createMockContext } from "./helpers/mocks";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return { ...fs, openSync: vi.fn(fs.openSync) };
});
const dirs: string[] = [];
function fixture(persist = true) {
  const dir = mkdtempSync(join(tmpdir(), "restore-read-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const ctx = createMockContext([
    { type: "custom", id: "one", parentId: null, customType: "fixture", data: {} },
  ]);
  vi.mocked(ctx.sessionManager.getSessionFile).mockReturnValue(path);
  const sync = () => {
    writeFileSync(
      path,
      [{ type: "session", version: 3, id: "test-session" }, ...ctx.sessionManager.getBranch()]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    );
  };
  if (persist) sync();
  const append = () => {
    const rows = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
    const id = `node-${rows.length}`;
    rows.push({
      type: "custom",
      id,
      parentId: ctx.sessionManager.getLeafId(),
      customType: "fixture",
      data: {},
    });
    sync();
    return id;
  };
  const prefix = (id: string) => {
    const branch = ctx.sessionManager.getBranch();
    const index = branch.findIndex((x) => x.id === id);
    const visible = branch.slice(0, index + 1);
    const nodes = new Map(visible.map((x) => [x.id, x]));
    const manager = Object.create(ctx.sessionManager, {
      getBranch: { value: () => visible },
      getLeafId: { value: () => id },
      getEntry: { value: (key: string) => nodes.get(key) },
      getLeafEntry: { value: () => nodes.get(id) },
    });
    return Object.create(ctx, { sessionManager: { value: manager } }) as ExtensionContext;
  };
  return { ctx, path, sync, append, prefix };
}

describe("restore-scoped physical journal read", () => {
  beforeEach(() => {
    resetState();
    vi.mocked(openSync).mockClear();
  });
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  it("shares one strict check and closes the capability after the restoration", () => {
    const h = fixture();
    const cycle = beginRestoreJournal(h.ctx);
    expect(cycle.read.require(h.ctx).branch).toHaveLength(1);
    expect(cycle.read.inspect(h.ctx)).toBe(cycle.read.inspect(h.ctx));
    cycle.assertCurrent(h.ctx);
    expect(vi.mocked(openSync).mock.calls.filter((x) => x[0] === h.path)).toHaveLength(1);
    cycle.close();
    expect(() => cycle.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
  });
  it.each(["memory", "setup"])(
    "preserves the legal %s no-file path without opening a journal",
    (kind) => {
      const h = fixture(false);
      if (kind === "memory")
        vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(undefined);
      const cycle = beginRestoreJournal(h.ctx);
      expect(cycle.read.inspect(h.ctx)).toBeUndefined();
      expect(() => cycle.read.require(h.ctx)).toThrow("JOURNAL_UNAVAILABLE");
      expect(openSync).not.toHaveBeenCalled();
      cycle.close();
    },
  );
  it("refuses a missing file once conversation exists", () => {
    const h = fixture(false);
    (h.ctx.sessionManager.getBranch() as unknown[]).push({
      id: "message",
      parentId: "one",
      type: "message",
      message: { role: "user", content: "synthetic" },
    });
    expect(() => beginRestoreJournal(h.ctx)).toThrow("JOURNAL_UNAVAILABLE");
  });
  it.each(["append", "replace", "same-size"])(
    "invalidates a previously verified %s source",
    (kind) => {
      const h = fixture();
      const c = beginRestoreJournal(h.ctx);
      if (kind === "append") h.append();
      else if (kind === "replace") {
        const next = h.path + ".new";
        writeFileSync(next, "{}\n");
        renameSync(next, h.path);
      } else {
        writeFileSync(h.path, readFileSync(h.path, "utf8").replace("test-session", "best-session"));
        // Force an observable metadata change; filesystems can coalesce same-tick writes.
        utimesSync(h.path, 1, 1);
      }
      expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
      c.close();
    },
  );
  it("hands off exactly the one owned install invalidation without reviving old leases", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    const runtime = currentRuntime();
    runtime.planningLease = "old";
    runtime.humanAbort = new AbortController();
    const signal = runtime.humanAbort.signal;
    const before = runtime.goalEpoch;
    c.installGoal(h.ctx, () => {
      invalidateGoalCallbacks();
    });
    expect(runtime.goalEpoch).toBe(before + 1);
    expect(signal.aborted).toBe(true);
    expect(runtime.planningLease).toBeUndefined();
    expect(c.read.require(h.ctx).branch).toHaveLength(1);
    expect(openSync).toHaveBeenCalledTimes(1);
    c.close();
  });
  it.each([0, 2])("rejects an install changing epoch by %s instead of one", (delta) => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    expect(() => {
      c.installGoal(h.ctx, () => {
        currentRuntime().goalEpoch += delta;
      });
    }).toThrow(RestoreReadInvalidated);
    expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
  });
  it("never accepts an external epoch or manager replacement", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    invalidateGoalCallbacks();
    expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
    c.close();
    const other = beginRestoreJournal(h.ctx);
    Object.assign(h.ctx, { sessionManager: createMockContext().sessionManager });
    expect(() => {
      other.assertCurrent(h.ctx);
    }).toThrow(RestoreReadInvalidated);
    other.close();
  });
  it("cuts branch and node lookup to the ancestor and rejects widening it", () => {
    const h = fixture();
    h.append();
    const c = beginRestoreJournal(h.ctx);
    const ctx = h.prefix("one");
    const prefix = c.read.prefix(ctx, "one");
    const value = prefix.require(ctx);
    expect(value.branch.map((x) => x.id)).toEqual(["one"]);
    expect([...value.nodes.keys()]).toEqual(["one"]);
    expect(() => prefix.prefix(h.ctx, "node-1")).toThrow("JOURNAL_BRANCH_INVALID");
    c.close();
  });
  it("never lets a future witness close a goal proof in a startup prefix", () => {
    const h = fixture();
    const rows = h.ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
    rows[0] = {
      type: "custom",
      id: "one",
      parentId: null,
      customType: "continuous-tasks:supervisor",
      data: { version: 3, sessionId: "test-session", status: "stopped", receipts: [] },
    };
    const frame = {
      version: 2,
      owner: "goal",
      sessionId: "test-session",
      requestId: "transition",
      presentationId: "screen",
      scopeDigest: "a".repeat(64),
      baseEntryId: "one",
      baseEntryDigest: journalDigest(rows[0]),
    };
    const control = {
      type: "custom",
      id: "answer",
      parentId: "one",
      customType: "continuous-tasks:supervisor",
      data: {
        version: 5,
        protocol: "goal-lifecycle-v1",
        kind: "transition-control",
        transitionId: "transition",
        humanInteraction: frame,
      },
    };
    const witness = {
      type: "custom",
      id: "witness",
      parentId: "answer",
      customType: "continuous-tasks:human-readback",
      data: { version: 1, controlEntryId: "answer", controlDigest: journalDigest(control), frame },
    };
    rows.push(control, witness);
    h.sync();
    const c = beginRestoreJournal(h.ctx);
    expect(findGoalReadbackProof(c.read.require(h.ctx), "transition").status).toBe("confirmed");
    const ctx = h.prefix("answer");
    const prefix = c.read.prefix(ctx, "answer");
    expect(prefix.require(ctx).nodes.has("witness")).toBe(false);
    expect(findGoalReadbackProof(prefix.require(ctx), "transition").status).toBe("unconfirmed");
    c.close();
  });
  it("does not cache standalone physical checks even while a restore cycle exists", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    expect(inspectRestorableSession(h.ctx)?.branch).toHaveLength(1);
    expect(openSync).toHaveBeenCalledTimes(2);
    c.close();
  });
  it("rejects asynchronous installs and closes their restoration lease", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    expect(() => {
      c.installGoal(h.ctx, () => Promise.resolve());
    }).toThrow(RestoreReadInvalidated);
    expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
  });
  it("does not adopt a changed file without a corresponding owned native append", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    expect(() => {
      c.runSupervisorRestore(h.ctx, () => {
        writeFileSync(h.path, "untrusted replacement bytes");
      });
    }).toThrow(RestoreReadInvalidated);
    expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
  });
  it("rejects a prefix whose branch expands after its initial validation", () => {
    const h = fixture();
    h.append();
    const c = beginRestoreJournal(h.ctx);
    const ctx = h.prefix("one");
    const prefix = c.read.prefix(ctx, "one");
    (ctx.sessionManager.getBranch() as unknown[]).push(h.ctx.sessionManager.getEntry("node-1"));
    expect(() => prefix.inspect(ctx)).toThrow(RestoreReadInvalidated);
    c.close();
  });

  it("rejects a prefix whose session identity changes after creation", () => {
    const h = fixture();
    h.append();
    const c = beginRestoreJournal(h.ctx);
    const ctx = h.prefix("one");
    const prefix = c.read.prefix(ctx, "one");
    Object.defineProperty(ctx.sessionManager, "getSessionId", { value: () => "other" });
    expect(() => prefix.inspect(ctx)).toThrow(RestoreReadInvalidated);
    c.close();
  });
  it("rebuilds after an acknowledged append, while old prefix leases become stale", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    const ctx = h.prefix("one");
    const prefix = c.read.prefix(ctx, "one");
    const leaf = h.append();
    c.afterConfirmedAppend(h.ctx, leaf);
    expect(c.read.require(h.ctx).branch).toHaveLength(2);
    expect(() => prefix.inspect(ctx)).toThrow(RestoreReadInvalidated);
    expect(openSync).toHaveBeenCalledTimes(2);
    c.close();
  });
  it("does not accept a no-op append confirmation even in an in-memory session", () => {
    const h = fixture(false);
    vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(undefined);
    const c = beginRestoreJournal(h.ctx);
    expect(() => {
      c.afterConfirmedAppend(h.ctx, "one");
    }).toThrow(RestoreReadInvalidated);
    expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
    c.close();
  });
  it("refreshes after a synchronous legacy restoration write without replaying it", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    let calls = 0;
    c.runSupervisorRestore(h.ctx, () => {
      calls++;
      h.append();
    });
    expect(calls).toBe(1);
    expect(c.read.require(h.ctx).branch).toHaveLength(2);
    c.close();
  });
  it("invalidates the frame if the owned restoration fails", () => {
    const h = fixture();
    const c = beginRestoreJournal(h.ctx);
    expect(() => {
      c.runSupervisorRestore(h.ctx, () => {
        throw Error("synthetic failure");
      });
    }).toThrow("synthetic failure");
    expect(() => c.read.inspect(h.ctx)).toThrow(RestoreReadInvalidated);
  });
});
