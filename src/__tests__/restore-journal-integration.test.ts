import {
  appendFileSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { getHandler, lifecycle } from "./helpers/lifecycle";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { submitAndPresentPreflight } from "../preflight-human";
import * as preflight from "../preflight";
import * as restoreJournal from "../restore-journal";
import * as flow from "../flow";
import { holdSupervisor, supervisorState } from "../supervisor";
import { registerEventHandlers } from "../events";
import { invalidateGoalCallbacks } from "../goal-scope";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof NodeFs>();
  return { ...fs, openSync: vi.fn(fs.openSync), readSync: vi.fn(fs.readSync) };
});
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
const fixtures: Awaited<ReturnType<typeof goalFixture>>[] = [];
const dirs: string[] = [];
beforeEach(() => {
  resetState();
  vi.mocked(openSync).mockImplementation(realFs.openSync);
  vi.mocked(readSync).mockImplementation(realFs.readSync);
});
afterEach(() => {
  for (const h of fixtures.splice(0)) {
    h.restoreHost();
    rmSync(h.dir, { recursive: true, force: true });
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function opens(path: string) {
  return vi.mocked(openSync).mock.calls.filter((x) => x[0] === path).length;
}
function resetReads() {
  vi.mocked(openSync).mockClear();
  vi.mocked(readSync).mockClear();
}
async function scoped(start = false) {
  const h = await goalFixture();
  fixtures.push(h);
  await h.command("supervise Shared restore fixture");
  if (start) {
    await h.fire("agent_start");
    vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
    await submitAndPresentPreflight(
      h.api,
      h.ctx,
      "synthetic-proposal",
      currentRuntime().preflight!.preflightId,
      localProposal,
    );
    await h.fire("agent_settled", { type: "agent_settled", aborted: false });
    vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
    await h.command("start");
    expect(supervisorState()?.status).toBe("active");
    holdSupervisor(h.api, h.ctx, "paused", "Retain synthetic grant", "user_pause");
  }
  return h;
}
it("restores a stable v5 planning GoalRun once despite its own epoch handoff", async () => {
  const h = await scoped();
  const before = h.entries().length;
  const epoch = currentRuntime().goalEpoch;
  const goal = currentRuntime().goal!.current!.scope.goalRunId;
  h.appendEntry.mockClear();
  h.sendUserMessage.mockClear();
  resetReads();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(goal);
  expect(currentRuntime().goalEpoch).toBe(epoch + 2);
  expect(opens(h.path)).toBe(1);
  expect(h.entries()).toHaveLength(before);
  expect(h.appendEntry).not.toHaveBeenCalled();
  expect(h.sendUserMessage).not.toHaveBeenCalled();
});
it("shares deep native approve/start and UI restoration reads, but not live admission checks", async () => {
  const h = await scoped(true);
  const before = h.entries().length;
  h.appendEntry.mockClear();
  h.sendUserMessage.mockClear();
  resetReads();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(supervisorState()?.status).toBe("paused");
  expect(currentRuntime().preflight?.phase).toBe("started");
  expect(h.entries()).toHaveLength(before);
  expect(opens(h.path)).toBe(1);
  expect(h.appendEntry).not.toHaveBeenCalled();
  const binding = supervisorState()!.preflightBinding!;
  resetReads();
  expect(preflight.preflightAuthorizationIssue(h.ctx, binding)).toBeUndefined();
  expect(opens(h.path)).toBeGreaterThan(0);
  expect(h.sendUserMessage).not.toHaveBeenCalled();
});
it("abandons a late UI epoch invalidation without UI, journal writes or dispatch", async () => {
  const h = await scoped(true);
  const facts = flow.flowFacts;
  let injected = false;
  vi.spyOn(flow, "flowFacts").mockImplementation((ctx, read) => {
    if (read && !injected) {
      injected = true;
      invalidateGoalCallbacks();
    }
    return facts(ctx, read);
  });
  h.appendEntry.mockClear();
  h.sendMessage.mockClear();
  h.sendUserMessage.mockClear();
  vi.mocked(h.ctx.ui.setStatus).mockClear();
  vi.mocked(h.ctx.ui.setWidget).mockClear();
  await h.fire("session_start");
  expect(injected).toBe(true);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(h.ctx.ui.setStatus).not.toHaveBeenCalled();
  expect(h.ctx.ui.setWidget).not.toHaveBeenCalled();
  expect(h.appendEntry).not.toHaveBeenCalled();
  expect(h.sendMessage).not.toHaveBeenCalled();
  expect(h.sendUserMessage).not.toHaveBeenCalled();
});

it("preserves deep preflight restoration invalidation instead of converting it to an approval issue", async () => {
  const h = await scoped(true);
  const cycle = restoreJournal.beginRestoreJournal(h.ctx);
  const require = cycle.read.require.bind(cycle.read);
  vi.spyOn(cycle.read, "require").mockImplementation((ctx) => {
    invalidateGoalCallbacks();
    return require(ctx);
  });
  try {
    expect(() =>
      preflight.preflightAuthorizationIssue(
        h.ctx,
        supervisorState()!.preflightBinding!,
        cycle.read,
      ),
    ).toThrow(restoreJournal.RestoreReadInvalidated);
  } finally {
    cycle.close();
  }
});

it.each(["epoch", "source"] as const)(
  "preserves %s invalidation during bound preflight restore without an authorization-hold append",
  async (change) => {
    const h = await scoped(true);
    const authorization = preflight.preflightAuthorizationIssue;
    let injected = false;
    vi.spyOn(preflight, "preflightAuthorizationIssue").mockImplementation((ctx, binding, read) => {
      if (read && !injected) {
        injected = true;
        if (change === "epoch") invalidateGoalCallbacks();
        else {
          const stat = realFs.statSync(h.path);
          realFs.utimesSync(h.path, stat.atime, new Date(stat.mtimeMs + 2000));
        }
      }
      return authorization(ctx, binding, read);
    });
    h.appendEntry.mockClear();
    h.sendMessage.mockClear();
    h.sendUserMessage.mockClear();
    resetReads();
    await h.fire("session_start");
    expect(injected).toBe(true);
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(h.appendEntry).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    expect(opens(h.path)).toBe(change === "source" ? 2 : 1);
    if (change === "source") expect(supervisorState()?.status).toBe("paused");
  },
);

it("preserves a legacy 500-entry gap append, then performs a write-free single read on reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-legacy-gap-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const state = {
    version: 1,
    sessionId: "test-session",
    goal: "Synthetic legacy gap",
    model: { provider: "faux", id: "test" },
    status: "fault",
    holdCause: "interrupted",
    reviews: 0,
    continuations: 0,
    stagnant: 0,
    epoch: 0,
    pending: false,
    tokens: 0,
    cost: 0,
    bindings: [],
    receipts: Array.from({ length: 500 }, (_, i) => ({
      id: `tool:old-${i}`,
      tool: "read",
      taskIds: [],
      reviews: [],
      epoch: 0,
      ok: true,
      digest: "a".repeat(64),
      input: "{}",
      output: "synthetic",
    })),
  };
  const ctx = createMockContext([
    {
      id: "legacy",
      parentId: null,
      type: "custom",
      customType: "continuous-tasks:supervisor",
      data: state,
    },
  ]);
  const mock = createMockAPI();
  vi.mocked(ctx.sessionManager.getSessionFile).mockReturnValue(path);
  writeFileSync(
    path,
    [{ type: "session", version: 3, id: "test-session" }, ...ctx.sessionManager.getBranch()]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const rows = ctx.sessionManager.getBranch() as unknown as Array<Record<string, unknown>>;
    const entry = {
      id: `append-${rows.length}`,
      parentId: ctx.sessionManager.getLeafId(),
      type: "custom",
      customType,
      data: structuredClone(data),
    };
    rows.push(entry);
    appendFileSync(path, JSON.stringify(entry) + "\n");
  });
  registerEventHandlers(mock.api);
  await getHandler(mock, "session_start")({}, ctx);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(mock.appendEntry).toHaveBeenCalledTimes(1);
  expect(supervisorState()).toMatchObject({ status: "fault", epoch: 1, receiptGapEpoch: 1 });
  const count = ctx.sessionManager.getBranch().length;
  mock.appendEntry.mockClear();
  resetReads();
  await getHandler(mock, "session_start")({}, ctx);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(ctx.sessionManager.getBranch()).toHaveLength(count);
  expect(mock.appendEntry).not.toHaveBeenCalled();
  expect(opens(path)).toBe(1);
});
it("finishes an already-confirmed pending goal once, then reopens without another append", async () => {
  const h = await goalFixture();
  fixtures.push(h);
  h.fail((kind, value) =>
    kind === "continuous-tasks:supervisor" &&
    value !== null &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "transition-committed"
      ? "before"
      : undefined,
  );
  await h.command("supervise Recover confirmed transition only");
  h.fail(undefined);
  h.appendEntry.mockClear();
  h.sendUserMessage.mockClear();
  resetReads();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().goal?.current?.seed.goal).toBe("Recover confirmed transition only");
  expect(
    h.appendEntry.mock.calls.filter(
      ([, value]) =>
        value !== null &&
        typeof value === "object" &&
        "kind" in value &&
        value.kind === "transition-committed",
    ),
  ).toHaveLength(1);
  expect(opens(h.path)).toBeGreaterThan(1);
  expect(h.sendUserMessage).not.toHaveBeenCalled();
  h.appendEntry.mockClear();
  resetReads();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(opens(h.path)).toBe(1);
  expect(h.appendEntry).not.toHaveBeenCalled();
});
it.each(["epoch", "invalid"] as const)(
  "preserves the original %s error from post-confirmation goal refresh without repeating its commit",
  async (failure) => {
    const h = await goalFixture();
    fixtures.push(h);
    const atCommit = (kind: string, value: unknown) =>
      kind === "continuous-tasks:supervisor" &&
      value !== null &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "transition-committed";
    h.fail((kind, value) => (atCommit(kind, value) ? "before" : undefined));
    await h.command("supervise Refresh confirmed transition only");
    h.fail(undefined);
    const begin = restoreJournal.beginRestoreJournal;
    let refreshing = false;
    let injected = false;
    vi.spyOn(restoreJournal, "beginRestoreJournal").mockImplementation((ctx) => {
      const cycle = begin(ctx);
      const after = cycle.afterConfirmedAppend.bind(cycle);
      vi.spyOn(cycle, "afterConfirmedAppend").mockImplementation((context, id) => {
        refreshing = true;
        if (failure === "invalid") {
          injected = true;
          appendFileSync(h.path, Buffer.from([0xff]));
        }
        try {
          after(context, id);
        } finally {
          refreshing = false;
        }
      });
      return cycle;
    });
    vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
      const count = realFs.readSync(...args);
      if (count === 0 && refreshing && failure === "epoch" && !injected) {
        injected = true;
        invalidateGoalCallbacks();
      }
      return count;
    });
    h.appendEntry.mockClear();
    h.sendMessage.mockClear();
    h.sendUserMessage.mockClear();
    await h.fire("session_start");
    expect(injected).toBe(true);
    expect(h.appendEntry.mock.calls.filter(([kind, value]) => atCommit(kind, value))).toHaveLength(
      1,
    );
    expect(h.sendUserMessage).not.toHaveBeenCalled();
    if (failure === "epoch") {
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(h.sendMessage).not.toHaveBeenCalled();
    } else expect(currentRuntime().journalFault).toContain("JOURNAL_INVALID");
  },
);

it.each(["before", "memory", "after"] as const)(
  "keeps the %s append failure contract during pending-goal restoration",
  async (failure) => {
    const h = await goalFixture();
    fixtures.push(h);
    const atCommit = (kind: string, value: unknown) =>
      kind === "continuous-tasks:supervisor" &&
      value !== null &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "transition-committed";
    h.fail((kind, value) => (atCommit(kind, value) ? "before" : undefined));
    await h.command("supervise Existing confirmation only");
    h.fail((kind, value) => (atCommit(kind, value) ? failure : undefined));
    h.appendEntry.mockClear();
    h.sendUserMessage.mockClear();
    await h.fire("session_start");
    const commits = readFileSync(h.path, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { data?: { kind?: string } })
      .filter((entry) => entry.data?.kind === "transition-committed");
    expect(h.appendEntry.mock.calls.filter(([kind, value]) => atCommit(kind, value))).toHaveLength(
      1,
    );
    expect(commits).toHaveLength(failure === "after" ? 1 : 0);
    if (failure === "after") {
      expect(currentRuntime().goal?.current?.seed.goal).toBe("Existing confirmation only");
    } else expect(currentRuntime().journalFault ?? currentRuntime().goal?.blocked).toBeTruthy();
    expect(h.sendUserMessage).not.toHaveBeenCalled();
  },
);

it("stops after two unstable reads and does not issue another held-view scan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-unstable-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const h = lifecycle();
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(path);
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  let changes = 0;
  vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
    const count = realFs.readSync(...args);
    if (count === 0) {
      const entry = {
        type: "custom",
        id: `change-${++changes}`,
        parentId: h.ctx.sessionManager.getLeafId(),
        customType: "fixture",
        data: {},
      };
      (h.ctx.sessionManager.getBranch() as unknown[]).push(entry);
      appendFileSync(path, JSON.stringify(entry) + "\n");
    }
    return count;
  });
  resetReads();
  await h.fire("session_start");
  expect(opens(path)).toBe(2);
  expect(changes).toBe(2);
  expect(currentRuntime().journalFault).toContain("counts unknown");
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
});
it("abandons an externally invalidated epoch without retry or publishing a new failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-external-epoch-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const h = lifecycle();
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(path);
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  let changed = false;
  vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
    const count = realFs.readSync(...args);
    if (count === 0 && !changed) {
      changed = true;
      invalidateGoalCallbacks();
    }
    return count;
  });
  resetReads();
  await h.fire("session_start");
  expect(opens(path)).toBe(1);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
});

it("retries one changing physical read without replay or unbounded retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "restore-changing-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const h = lifecycle();
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(path);
  writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
  const actual = vi.mocked(readSync).getMockImplementation()!;
  let changed = false;
  vi.mocked(readSync).mockImplementation((...args: Parameters<typeof readSync>) => {
    const count = actual(...args);
    if (count === 0 && !changed) {
      changed = true;
      const entry = {
        type: "custom",
        id: "concurrent-notice",
        parentId: null,
        customType: "fixture",
        data: {},
      };
      (h.ctx.sessionManager.getBranch() as unknown[]).push(entry);
      appendFileSync(path, JSON.stringify(entry) + "\n");
    }
    return count;
  });
  resetReads();
  await h.fire("session_start");
  expect(changed).toBe(true);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(opens(path)).toBe(2);
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
});
