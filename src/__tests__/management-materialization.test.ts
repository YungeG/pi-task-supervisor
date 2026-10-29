// Real SDK setup buffering/materialization; only mode-module/lifecycle mechanics,
// not native approval, command E2E, or business execution.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { getHandler } from "./helpers/lifecycle";
import { registerEventHandlers } from "../events";
import { currentRuntime } from "../runtime";
import { resetState, getBoardRef } from "../state";
import { flowFacts, formatFlowStatus } from "../flow";
import { readControlJournal } from "../control-journal";
import { enableTasksMode, requestModeChange, materializeManagement } from "../management-policy";
const dirs: string[] = [];
beforeEach(resetState);
afterEach(() => {
  currentRuntime().cancel();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "owned-off-materialization-"));
  dirs.push(dir);
  const manager = SessionManager.create(dir, join(dir, "sessions")),
    mock = createMockAPI(),
    ctx = createMockContext();
  Object.assign(ctx, {
    cwd: dir,
    sessionManager: manager,
    model: { provider: "faux", id: "test" },
  });
  mock.appendEntry.mockImplementation((type: string, data: unknown) => {
    manager.appendCustomEntry(type, structuredClone(data));
  });
  registerEventHandlers(mock.api);
  return {
    dir,
    manager,
    mock,
    ctx,
    materialize: () =>
      manager.appendMessage(
        fauxAssistantMessage("Owned SDK conversation only; no model execution."),
      ),
  };
}
it("persists an explicit volatile off after real first-conversation materialization instead of reviving activation", async () => {
  const f = fixture();
  expect(existsSync(f.manager.getSessionFile()!)).toBe(false);
  await enableTasksMode(f.mock.api, f.ctx);
  await requestModeChange(f.mock.api, f.ctx, "off");
  expect(currentRuntime().management).toMatchObject({ mode: "off", source: "volatile" });
  f.materialize();
  materializeManagement(f.mock.api, f.ctx);
  expect(readControlJournal(f.ctx).modeRecords?.at(-1)?.data).toMatchObject({
    mode: "off",
    state: "active",
    activeWorkOwner: null,
  });
  await getHandler(f.mock, "session_tree")({}, f.ctx);
  expect(currentRuntime().management).toMatchObject({ mode: "off", source: "confirmed" });
  expect(currentRuntime().enabled).toBe(false);
});
it.each(["before_agent_start", "agent_settled", "session_shutdown", "session_tree"])(
  "keeps explicit off through the no-tool materialization lifecycle %s",
  async (event) => {
    const f = fixture();
    await enableTasksMode(f.mock.api, f.ctx);
    await requestModeChange(f.mock.api, f.ctx, "off");
    f.materialize();
    await getHandler(f.mock, event)({}, f.ctx);
    expect(readControlJournal(f.ctx).modeRecords?.at(-1)?.data).toMatchObject({
      mode: "off",
      state: "active",
    });
    expect(currentRuntime().enabled).toBe(false);
  },
);
it("makes only a physically confirmed off idempotent after the source appears", async () => {
  const f = fixture();
  await enableTasksMode(f.mock.api, f.ctx);
  await requestModeChange(f.mock.api, f.ctx, "off");
  f.materialize();
  await requestModeChange(f.mock.api, f.ctx, "off");
  expect(currentRuntime().management?.source).toBe("confirmed");
  const count = f.manager.getBranch().length;
  await requestModeChange(f.mock.api, f.ctx, "off");
  expect(f.manager.getBranch()).toHaveLength(count);
});
it.each(["fresh", "volatile", "confirmed"])(
  "presents %s off as normal unmanaged work, not a request to enable supervision",
  async (kind) => {
    const f = fixture();
    if (kind !== "fresh") {
      await enableTasksMode(f.mock.api, f.ctx);
      await requestModeChange(f.mock.api, f.ctx, "off");
    }
    if (kind === "confirmed") {
      f.materialize();
      materializeManagement(f.mock.api, f.ctx);
    }
    const before = f.manager.getBranch().length;
    const text = formatFlowStatus(
      getBoardRef(),
      currentRuntime().supervisor,
      flowFacts(f.ctx),
    ).join("\n");
    expect(text).toContain("unmanaged");
    expect(text).not.toContain("Next: /task-supervisor enable");
    expect(text).not.toContain("Next checkpoint: native end-of-run");
    expect(f.manager.getBranch()).toHaveLength(before);
  },
);
it("defers durable off while unrelated host work is busy, then persists after native settle", async () => {
  const f = fixture();
  await enableTasksMode(f.mock.api, f.ctx);
  await requestModeChange(f.mock.api, f.ctx, "off");
  f.materialize();
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  materializeManagement(f.mock.api, f.ctx);
  expect(currentRuntime().management).toMatchObject({ mode: "off", source: "volatile" });
  expect(f.ctx.abort).not.toHaveBeenCalled();
  vi.mocked(f.ctx.isIdle).mockReturnValue(true);
  await getHandler(f.mock, "agent_settled")({ aborted: false }, f.ctx);
  expect(currentRuntime().management?.source).toBe("confirmed");
  expect(currentRuntime().enabled).toBe(false);
});
it("does not transfer a volatile off choice onto an earlier native SDK branch", async () => {
  const f = fixture();
  f.manager.appendCustomEntry("owned-base", {});
  const base = f.manager.getLeafId()!;
  await enableTasksMode(f.mock.api, f.ctx);
  await requestModeChange(f.mock.api, f.ctx, "off");
  f.manager.branch(base);
  f.materialize();
  expect(() => {
    materializeManagement(f.mock.api, f.ctx);
  }).toThrow(/original.*source/);
});
it("does not transfer a volatile off intent into another SDK Session source", async () => {
  const original = fixture();
  await enableTasksMode(original.mock.api, original.ctx);
  await requestModeChange(original.mock.api, original.ctx, "off");
  const foreign = fixture();
  foreign.materialize();
  expect(() => {
    materializeManagement(foreign.mock.api, foreign.ctx);
  }).toThrow(/another Session|original.*source/);
  expect(
    foreign.manager
      .getBranch()
      .some(
        (entry) => entry.type === "custom" && entry.customType === "continuous-tasks:control-facts",
      ),
  ).toBe(false);
});
