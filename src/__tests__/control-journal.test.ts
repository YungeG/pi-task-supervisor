import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentRuntime, scopedAPI } from "../runtime";
import { createMockAPI } from "./helpers/mocks";
import { getBoard, resetState, setBoard } from "../state";
import { invalidateGoalCallbacks } from "../goal-scope";
import { setSessionScopeEnabled } from "../scope";
import { lifecycle } from "./helpers/lifecycle";
import {
  appendControlFence,
  captureControlLease,
  readControlJournal,
  controlReadStats,
} from "../control-journal";

const directories: string[] = [];
const fence = () => ({
  version: 6,
  protocol: "task-supervisor-control-v1",
  kind: "format-fence",
  sessionId: "test-session",
  revision: 1,
  previousFence: null,
  features: [],
  owner: null,
});
beforeEach(() => {
  resetState();
  setSessionScopeEnabled(false);
});
afterEach(() => {
  currentRuntime().cancel();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function physicalFence(value: unknown = fence()) {
  const h = lifecycle();
  Object.assign(h.ctx, { hasUI: false, mode: "rpc" });
  const directory = mkdtempSync(join(tmpdir(), "control-fence-"));
  directories.push(directory);
  const path = join(directory, "synthetic.jsonl");
  const row = {
    type: "custom",
    id: "fence",
    parentId: null,
    customType: "continuous-tasks:supervisor",
    data: value,
  };
  (h.ctx.sessionManager.getBranch() as unknown[]).push(row);
  writeFileSync(
    path,
    [{ type: "session", version: 3, id: "test-session" }, row]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(path);
  h.mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const added = {
      type: "custom",
      id: `added-${h.ctx.sessionManager.getBranch().length}`,
      parentId: h.ctx.sessionManager.getLeafId(),
      customType,
      data: structuredClone(data),
    };
    (h.ctx.sessionManager.getBranch() as unknown[]).push(added);
    appendFileSync(path, JSON.stringify(added) + "\n");
  });
  return { ...h, path };
}
it.each(["path", "cwd", "session", "branch-id"])(
  "rebuilds a hot fold when its %s identity changes",
  (change) => {
    const h = physicalFence();
    readControlJournal(h.ctx);
    const once = controlReadStats();
    const row = h.ctx.sessionManager.getBranch()[0] as unknown as {
      id: string;
      data: ReturnType<typeof fence>;
    };
    let path = h.path;
    const header: { type: string; version: number; id: string; cwd?: string } = {
      type: "session",
      version: 3,
      id: "test-session",
    };
    if (change === "path") {
      path = join(h.path + ".copy");
      vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(path);
    }
    if (change === "cwd") header.cwd = "/owned-header-change";
    if (change === "session") {
      header.id = "other-owned-session";
      row.data.sessionId = header.id;
      vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue(header.id);
    }
    if (change === "branch-id") {
      row.id = "other-owned-fence";
      vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue(row.id);
    }
    writeFileSync(path, [header, row].map((value) => JSON.stringify(value)).join("\n") + "\n");
    expect(readControlJournal(h.ctx).latestFence?.entryId).toBe(row.id);
    expect(controlReadStats().foldedNodes).toBeGreaterThan(once.foldedNodes);
  },
);
it("rebuilds a hot fold under another actual scoped runtime rather than borrowing its projection", async () => {
  const h = physicalFence();
  readControlJournal(h.ctx);
  const once = controlReadStats(),
    mock = createMockAPI();
  scopedAPI(mock.api, (api) => {
    api.registerCommand("owned-read", {
      description: "Owned source-only read",
      handler: async (_args, ctx) => {
        readControlJournal(ctx);
      },
    });
  });
  await mock.registerCommand.mock.calls[0]![1].handler("", h.ctx);
  expect(controlReadStats().foldedNodes).toBeGreaterThan(once.foldedNodes);
});
it("rebuilds after branch rewind and does not consume a future fence", () => {
  const h = physicalFence();
  readControlJournal(h.ctx);
  appendControlFence(h.mock.api, h.ctx, ["advisor-accounting-v1"]);
  expect(readControlJournal(h.ctx).latestFence?.data.revision).toBe(2);
  vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue("fence");
  expect(readControlJournal(h.ctx).latestFence?.data.revision).toBe(1);
});
it("memoizes only verified physical-prefix folds, not mutable returned projections", () => {
  const h = physicalFence();
  const first = readControlJournal(h.ctx),
    once = controlReadStats();
  first.latestFence!.data.features.push("advisor-accounting-v1");
  expect(readControlJournal(h.ctx).latestFence!.data.features).toEqual([]);
  expect(controlReadStats().foldedNodes).toBe(once.foldedNodes);
  expect(controlReadStats().hits).toBeGreaterThan(once.hits);
});
it("does not let a hot physical prefix launder changed native bytes or a mismatched SDK mirror", () => {
  const h = physicalFence();
  readControlJournal(h.ctx);
  const rows = h.ctx.sessionManager.getBranch();
  const row = rows[0] as unknown as { data: ReturnType<typeof fence> };
  (row.data.features as string[]).push("advisor-accounting-v1");
  expect(() => readControlJournal(h.ctx)).toThrow("CONTROL_FORMAT_INVALID");
  row.data.features = [];
  expect(readControlJournal(h.ctx).latestFence!.data.features).toEqual([]);
  const text = readFileSync(h.path, "utf8").replace('"revision":1', '"revision":2');
  writeFileSync(h.path, text);
  expect(() => readControlJournal(h.ctx)).toThrow("CONTROL_FORMAT_INVALID");
});
it("restores a valid format fence without treating it as a Supervisor or starting work", async () => {
  const h = physicalFence();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(currentRuntime().controlJournal?.latestFence?.data).toEqual(fence());
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
});
it.each([
  { name: "unknown protocol", data: { ...fence(), protocol: "other" } },
  { name: "extra field", data: { ...fence(), approved: true } },
  { name: "foreign session", data: { ...fence(), sessionId: "other" } },
  { name: "skipped revision", data: { ...fence(), revision: 2 } },
  {
    name: "invented ancestor",
    data: { ...fence(), previousFence: { entryId: "missing", digest: "a".repeat(64) } },
  },
  { name: "unknown feature", data: { ...fence(), features: ["invented"] } },
  {
    name: "unsupported future feature",
    data: { ...fence(), features: ["acceptance-contract-v999"] },
  },
  {
    name: "duplicate feature",
    data: { ...fence(), features: ["advisor-accounting-v1", "advisor-accounting-v1"] },
  },
  {
    name: "unsorted features",
    data: { ...fence(), features: ["progress-facts-v1", "advisor-accounting-v1"] },
  },
  {
    name: "foreign owner",
    data: {
      ...fence(),
      owner: {
        kind: "board",
        board: { sessionId: "other", boardRunId: "board", seedEntryId: "seed" },
      },
    },
  },
  {
    name: "incomplete goal identity",
    data: {
      ...fence(),
      owner: {
        kind: "goal",
        goal: {
          sessionId: "test-session",
          goalKey: "goal",
          goalRunId: "goal",
          lifecycleCommitId: null,
        },
      },
    },
  },
])("holds a $name fence without publishing work", async ({ data }) => {
  const h = physicalFence(data);
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeDefined();
  expect(currentRuntime().enabled).toBe(false);
  expect(currentRuntime().supervisor?.status).not.toBe("completed");
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
});
it("does not restore a new fence from memory-only setup as physically confirmed", async () => {
  const h = physicalFence();
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(undefined);
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toContain("JOURNAL_UNAVAILABLE");
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
});
it("rejects in-place board changes under an already captured control lease", async () => {
  const h = physicalFence();
  await h.fire("session_start");
  const lease = captureControlLease(h.ctx);
  currentRuntime().board.generation++;
  expect(() => appendControlFence(h.mock.api, h.ctx, [], lease)).toThrow("CONTROL_OWNER_CHANGED");
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("confirms a fence append on the physical branch before publishing its new revision", async () => {
  const h = physicalFence();
  await h.fire("session_start");
  const result = appendControlFence(h.mock.api, h.ctx, []);
  expect(result.entryId).toBe(h.ctx.sessionManager.getLeafId());
  expect(currentRuntime().controlJournal?.latestFence?.data.revision).toBe(2);
  expect(h.mock.appendEntry).toHaveBeenCalledTimes(1);
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().controlJournal?.latestFence?.data.revision).toBe(2);
});
it.each(["before", "during"])(
  "does not adopt altered ancestor memory %s a fence append",
  async (phase) => {
    const h = physicalFence();
    await h.fire("session_start");
    const alter = () => {
      const entry = h.ctx.sessionManager.getBranch()[0];
      if (entry?.type !== "custom") throw Error("Missing fixture fence");
      entry.data = { ...fence(), revision: 2 };
    };
    if (phase === "before") alter();
    else {
      const append = h.mock.appendEntry.getMockImplementation() as (
        type: string,
        value: unknown,
      ) => void;
      h.mock.appendEntry.mockImplementationOnce((type: string, value: unknown) => {
        append(type, value);
        alter();
      });
    }
    expect(() => appendControlFence(h.mock.api, h.ctx, [])).toThrow();
    expect(h.mock.appendEntry).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
    expect(currentRuntime().controlJournal?.latestFence?.data.revision).toBe(1);
    expect(Boolean(currentRuntime().journalFault)).toBe(phase === "during");
  },
);
it.each(["before", "memory", "after", "noop"] as const)(
  "locks an uncertain %s append without publishing or retrying",
  async (failure) => {
    const h = physicalFence();
    await h.fire("session_start");
    const before = readFileSync(h.path, "utf8");
    const append = h.mock.appendEntry.getMockImplementation() as (
      type: string,
      value: unknown,
    ) => void;
    h.mock.appendEntry.mockImplementationOnce((type: string, value: unknown) => {
      if (failure === "before") throw Error("synthetic failure before append");
      if (failure === "noop") return;
      if (failure === "memory") {
        (h.ctx.sessionManager.getBranch() as unknown[]).push({
          type: "custom",
          id: "memory-only",
          parentId: "fence",
          customType: type,
          data: structuredClone(value),
        });
        return;
      }
      append(type, value);
      throw Error("synthetic acknowledgement lost");
    });
    expect(() => appendControlFence(h.mock.api, h.ctx, [])).toThrow("CONTROL_JOURNAL_UNCERTAIN");
    expect(currentRuntime().journalFault).toBeDefined();
    expect(currentRuntime().controlJournal?.latestFence?.data.revision).toBe(1);
    expect(() => appendControlFence(h.mock.api, h.ctx, [])).toThrow();
    expect(h.mock.appendEntry).toHaveBeenCalledTimes(1);
    expect(readFileSync(h.path, "utf8") === before).toBe(failure !== "after");
  },
);
it.each(["goal epoch", "board", "session", "path"])(
  "rejects a stale %s lease before writing",
  async (kind) => {
    const h = physicalFence();
    await h.fire("session_start");
    const lease = captureControlLease(h.ctx);
    if (kind === "goal epoch") invalidateGoalCallbacks();
    if (kind === "board") setBoard(getBoard());
    if (kind === "session") vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("other");
    if (kind === "path")
      vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(h.path + ".other");
    expect(() => appendControlFence(h.mock.api, h.ctx, [], lease)).toThrow("CONTROL_OWNER_CHANGED");
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
    expect(currentRuntime().journalFault).toBeUndefined();
  },
);
it("rejects a changed source before writing instead of adopting it", async () => {
  const h = physicalFence();
  await h.fire("session_start");
  const lease = captureControlLease(h.ctx);
  appendFileSync(
    h.path,
    JSON.stringify({
      type: "custom",
      id: "external",
      parentId: "fence",
      customType: "fixture",
      data: {},
    }) + "\n",
  );
  expect(() => appendControlFence(h.mock.api, h.ctx, [], lease)).toThrow("CONTROL_SOURCE_CHANGED");
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("refuses a new persistent write without a recoverable file before append", async () => {
  const h = physicalFence();
  await h.fire("session_start");
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(undefined);
  expect(() => appendControlFence(h.mock.api, h.ctx, [])).toThrow("CONTROL_SOURCE_UNAVAILABLE");
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(currentRuntime().journalFault).toBeUndefined();
});
it("does not trust altered memory data for a physically valid fence", async () => {
  const h = physicalFence();
  const row = h.ctx.sessionManager.getBranch()[0];
  if (row?.type !== "custom") throw Error("Missing synthetic fence");
  row.data = { ...fence(), revision: 2 };
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeDefined();
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
});
it("holds unknown control facts rather than ignoring future semantics", async () => {
  const h = physicalFence();
  h.mock.api.appendEntry("continuous-tasks:control-facts", { version: 1, kind: "unimplemented" });
  h.mock.appendEntry.mockClear();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeDefined();
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
});
it("keeps a legal old memory-only setup usable without inventing a fence", async () => {
  const h = lifecycle();
  await h.fire("session_start");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().controlJournal?.latestFence).toBeUndefined();
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
});
