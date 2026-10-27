import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { submitAndPresentPreflight } from "../preflight-human";
import {
  createWriteTasksTool,
  createCompileTasksTool,
  createGetReadyTasksTool,
  createAdvanceTasksTool,
  createEditTasksTool,
} from "../tools";
import { GoalToolLeases } from "../goal-tool-leases";
import { evidencePacket } from "../supervisor";
import { readGoalHistory } from "../goal-lifecycle";

const fixtures: Awaited<ReturnType<typeof goalFixture>>[] = [];
beforeEach(() => {
  resetState();
});
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function start(f: Awaited<ReturnType<typeof goalFixture>>, text: string) {
  vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
  await f.command(`supervise ${text}`);
  await f.fire("agent_start");
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    `proposal-${text}`,
    currentRuntime().preflight!.preflightId,
    localProposal,
  );
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
  await f.command("start");
  expect(currentRuntime().supervisor?.status).toBe("active");
}
it("persists actual write/compile/claim/edit/advance tool snapshots within the selected GoalRun and restores that board", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await start(f, "Tool lifecycle");
  const goalId = currentRuntime().goal!.current!.scope.goalRunId;
  await createWriteTasksTool(f.api).execute(
    "write",
    {
      mode: "replace",
      phases: [
        {
          title: "Only",
          tasks: [{ title: "New task", prompt: "New bounded work", profile: "worker" }],
        },
      ],
    },
    undefined,
    undefined,
    f.ctx,
  );
  const edit = await createEditTasksTool(f.api).execute(
    "edit",
    { tasks: [{ id: "t-1.1", type: "data", data: { title: "Edited current task" } }] },
    undefined,
    undefined,
    f.ctx,
  );
  expect(edit.isError, JSON.stringify(edit)).not.toBe(true);
  await createCompileTasksTool(f.api).execute(
    "compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    f.ctx,
  );
  await createGetReadyTasksTool(f.api).execute("claim", { count: 1 }, undefined, undefined, f.ctx);
  const advance = await createAdvanceTasksTool(f.api).execute(
    "advance",
    { transitions: [{ id: "t-1.1" }] },
    undefined,
    undefined,
    f.ctx,
  );
  expect(advance.isError, JSON.stringify(advance)).not.toBe(true);
  expect(getBoard().tasks[0]?.status).toBe("reviewing");
  const snapshots = f
    .entries()
    .filter((entry) => entry.customType === "continuous-tasks:snapshot")
    .slice(2);
  expect(snapshots.length).toBeGreaterThan(2);
  expect(snapshots.every((entry) => (entry.data as { version: number }).version === 3)).toBe(true);
  await f.fire("session_tree");
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(goalId);
  expect(getBoard().tasks[0]).toMatchObject({
    id: "t-1.1",
    title: "Edited current task",
    status: "reviewing",
  });
});
it("keeps a late previous-goal read result out of the new ledger and new fault state", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await start(f, "First scoped goal");
  await f.fire("tool_call", {
    type: "tool_call",
    toolName: "read",
    toolCallId: "old-read",
    input: { path: "old.txt" },
  });
  await f.command("stop");
  await start(f, "Second scoped goal");
  const before = JSON.stringify({
    goal: currentRuntime().goal,
    state: currentRuntime().supervisor,
    store: currentRuntime().receiptStore?.checkpoint,
  });
  const entries = f.entries().length;
  const result = await f.fire("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "old-read",
    input: { path: "old.txt" },
    content: [{ type: "text", text: "Old result" }],
    isError: false,
  });
  expect(result).toMatchObject({
    content: expect.arrayContaining([
      { type: "text", text: expect.stringContaining("Historical goal") },
    ]),
  });
  expect(
    JSON.stringify({
      goal: currentRuntime().goal,
      state: currentRuntime().supervisor,
      store: currentRuntime().receiptStore?.checkpoint,
    }),
  ).toBe(before);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(f.entries()).toHaveLength(entries);
});
it("uses physical old native call identity after cache loss and excludes the old transcript from the current advisor packet", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  appendFileSync(
    f.path,
    JSON.stringify({
      type: "message",
      id: "old-native-call",
      parentId: f.ctx.sessionManager.getLeafId(),
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "OLD_TRANSCRIPT_ONLY" },
          { type: "toolCall", id: "durable-old-call", name: "read", arguments: { path: "old" } },
        ],
      },
    }) + "\n",
  );
  f.reload();
  await start(f, "Current packet scope");
  const cold = new GoalToolLeases();
  expect(cold.result("durable-old-call", f.ctx, "read")).toBe("historical");
  expect(cold.result("unknown-call", f.ctx, "read")).toBe("current");
  const packet = JSON.parse(evidencePacket(f.ctx, getBoard(), currentRuntime().supervisor!));
  expect(JSON.stringify(packet)).not.toContain("OLD_TRANSCRIPT_ONLY");
  expect(packet.goalScope.goalRunId).toBe(currentRuntime().goal?.current?.scope.goalRunId);
});
it("isolates repeated goal text/task IDs and refuses a prior goal's successful bound evidence", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  const review = async () => {
    await createWriteTasksTool(f.api).execute(
      "write",
      {
        mode: "replace",
        phases: [
          {
            title: "Same phase",
            tasks: [{ title: "Same task", prompt: "Same scope", profile: "worker" }],
          },
        ],
      },
      undefined,
      undefined,
      f.ctx,
    );
    await createCompileTasksTool(f.api).execute(
      "compile",
      { finalAcceptanceTaskId: "t-1.1" },
      undefined,
      undefined,
      f.ctx,
    );
    await createGetReadyTasksTool(f.api).execute(
      "claim",
      { count: 1 },
      undefined,
      undefined,
      f.ctx,
    );
    const result = await createAdvanceTasksTool(f.api).execute(
      "review",
      { transitions: [{ id: "t-1.1" }] },
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
  };
  await start(f, "Repeated goal text");
  await review();
  const oldId = currentRuntime().goal!.current!.scope.goalRunId;
  await f.fire("tool_call", {
    type: "tool_call",
    toolName: "bash",
    toolCallId: "old-success-proof",
    input: { command: "unit validation" },
  });
  await f.fire("tool_result", {
    type: "tool_result",
    toolName: "bash",
    toolCallId: "old-success-proof",
    input: { command: "unit validation" },
    content: [{ type: "text", text: "Unit host result" }],
    structuredContent: { exit_code: 0 },
    isError: false,
  });
  const evidence = {
    summary: "Original successful host validation",
    refs: [
      {
        kind: "command" as const,
        label: "Unit validation",
        status: "passed" as const,
        ref: "tool:old-success-proof",
        exitCode: 0,
      },
    ],
  };
  const done = await createAdvanceTasksTool(f.api).execute(
    "done",
    { transitions: [{ id: "t-1.1", evidence }] },
    undefined,
    undefined,
    f.ctx,
  );
  expect(done.isError, JSON.stringify(done)).not.toBe(true);
  expect(getBoard().tasks[0]?.status).toBe("done");
  await f.command("stop");
  await start(f, "Repeated goal text");
  expect(currentRuntime().goal?.current?.scope.goalRunId).not.toBe(oldId);
  expect(currentRuntime().supervisor?.bindings).toEqual([]);
  expect(currentRuntime().receiptStore?.stats.count).toBe(0);
  const old = readGoalHistory(f.ctx, "0", oldId).items[0];
  expect(old?.board.tasks[0]?.status).toBe("done");
  expect(old?.supervisor?.bindings[0]?.refs).toContain("tool:old-success-proof");
  await review();
  const rejected = await createAdvanceTasksTool(f.api).execute(
    "stale-proof",
    { transitions: [{ id: "t-1.1", evidence }] },
    undefined,
    undefined,
    f.ctx,
  );
  expect(rejected.isError).toBe(true);
  expect(getBoard().tasks[0]?.status).toBe("reviewing");
});

it("retains the same-goal late-mutation freshness barrier after restoration and explicit recovery", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await start(f, "Same goal unknown execution");
  await f.fire("tool_call", {
    type: "tool_call",
    toolName: "write",
    toolCallId: "same-goal-late",
    input: { path: "unit-file", content: "x" },
  });
  expect(currentRuntime().receiptStore?.pendingCount).toBe(1);
  await f.fire("session_tree");
  await f.command("recover");
  expect(currentRuntime().supervisor?.status).toBe("active");
  expect(currentRuntime().supervisor?.epoch).toBe(2);
  await f.fire("tool_call", {
    type: "tool_call",
    toolName: "read",
    toolCallId: "before-late-current",
    input: { path: "unit-file" },
  });
  await f.fire("tool_result", {
    type: "tool_result",
    toolName: "read",
    toolCallId: "before-late-current",
    input: { path: "unit-file" },
    content: [{ type: "text", text: "Unit validation" }],
    structuredContent: { exit_code: 0 },
    isError: false,
  });
  await f.fire("tool_result", {
    type: "tool_result",
    toolName: "write",
    toolCallId: "same-goal-late",
    input: { path: "unit-file", content: "x" },
    content: [{ type: "text", text: "Late unit result" }],
    isError: false,
  });
  expect(currentRuntime().supervisor?.epoch).toBe(3);
  expect(currentRuntime().receiptStore?.stats.count).toBe(1);
  expect(currentRuntime().supervisor?.status).toBe("fault");
});

it("bounds callback identities and rejects duplicate/blocked calls without treating eviction as positive old provenance", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Bounded callback identities");
  const book = new GoalToolLeases();
  expect(book.begin("warm-call", f.ctx, "read")).toBeUndefined();
  book.allow("warm-call");
  expect(book.result("warm-call", f.ctx, "read")).toBe("current");
  expect(book.begin("warm-call", f.ctx, "read")).toContain("already admitted");
  expect(book.result("warm-call", f.ctx, "read")).toBe("blocked");
  for (let i = 0; i < 512; i++) book.begin(`bounded-${i}`, f.ctx, "read");
  expect(book.result("warm-call", f.ctx, "read")).toBe("blocked"); // Active capacity does not erase a confirmed admission denial.
  const foreign = {
    ...f.ctx,
    sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "foreign" },
  };
  expect(book.result("bounded-511", foreign, "read")).toBe("historical");
});

it("keeps a live parent callback identity through more than 512 completed siblings", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await start(f, "Owned callback parent retention");
  const book = new GoalToolLeases();
  expect(book.begin("opaque-parent", f.ctx, "codemode")).toBeUndefined();
  book.allow("opaque-parent");
  for (let i = 0; i < 1000; i++) {
    const id = `opaque-child-${i}`;
    expect(book.begin(id, f.ctx, "read")).toBeUndefined();
    book.allow(id);
    expect(book.result(id, f.ctx, "read")).toBe("current");
  }
  expect(book.result("opaque-parent", f.ctx, "codemode")).toBe("current");
});
it("does not classify an unknown result as historical when the physical source cannot be read", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await start(f, "Missing callback source");
  vi.spyOn(f.ctx.sessionManager, "getSessionFile").mockReturnValue(`${f.dir}/missing.jsonl`);
  expect(new GoalToolLeases().result("unproven-call", f.ctx, "read")).toBe("current");
});

it("holds an unexpected successful result after admission was blocked, without creating evidence or approving another goal", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Read-only planning only");
  expect(
    await f.fire("tool_call", {
      type: "tool_call",
      toolName: "write",
      toolCallId: "forbidden-success",
      input: { path: "unit-file", content: "x" },
    }),
  ).toMatchObject({ block: true });
  const writes = f.entries().length;
  await f.fire("tool_result", {
    type: "tool_result",
    toolName: "write",
    toolCallId: "forbidden-success",
    input: { path: "unit-file", content: "x" },
    content: [{ type: "text", text: "Unexpected simulated host success" }],
    isError: false,
  });
  expect(currentRuntime().journalFault).toContain("admission was blocked");
  expect(currentRuntime().receiptStore).toBeUndefined();
  await f.command("supervise Another goal cannot dismiss unknown execution");
  expect(f.entries()).toHaveLength(writes);
  expect(currentRuntime().goal?.current?.seed.goal).toBe("Read-only planning only");
});

it("does not let an old native settled notification settle a newly dispatched planning attempt", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Older pure planning");
  await f.fire("agent_start");
  await f.command("stop");
  vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
  await f.command("supervise New pure planning");
  await f.fire("agent_start");
  const count = f.entries().length;
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  expect(currentRuntime().goal?.current?.planning.status).toBe("dispatched");
  expect(f.entries()).toHaveLength(count);
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  expect(currentRuntime().goal?.current?.planning.status).toBe("settled");
});
