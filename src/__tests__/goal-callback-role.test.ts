import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appendFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import { submitAndPresentPreflight } from "../preflight-human";
import { readGoalFirstStartEntry } from "../preflight";
import { GoalToolLeases } from "../goal-tool-leases";
import { inspectSessionJournal } from "../human-journal";
import { sessionJournalView } from "../human-control";

// Approved seams: repair plan §5/§6, real native journal plus registered result event.
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
async function startedAfterPlanningCall(
  calls: Array<{ id: string; name?: string }> = [{ id: "planning-read", name: "read" }],
  admit = false,
) {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Cold planning role");
  await f.fire("agent_start");
  appendFileSync(
    f.path,
    JSON.stringify({
      type: "message",
      id: "planning-native-call",
      parentId: f.ctx.sessionManager.getLeafId(),
      message: {
        role: "assistant",
        content: [
          ...calls.map((call) => ({ type: "toolCall", ...call, arguments: { path: "synthetic" } })),
        ],
      },
    }) + "\n",
  );
  f.reload();
  if (admit)
    await f.fire("tool_call", {
      type: "tool_call",
      toolCallId: "planning-read",
      toolName: "read",
      input: { path: "synthetic" },
    });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "cold-plan",
    currentRuntime().preflight!.preflightId,
    localProposal,
  );
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
  await f.command("start");
  expect(currentRuntime().supervisor?.status).toBe("active");
  return f;
}
it.each([
  [
    "duplicate occurrences in one message",
    [
      { id: "planning-read", name: "read" },
      { id: "planning-read", name: "read" },
    ],
    "read",
  ],
  ["a different result name", [{ id: "planning-read", name: "read" }], "write"],
  ["an absent original name", [{ id: "planning-read" }], "read"],
  ["an overlong original name", [{ id: "planning-read", name: "x".repeat(201) }], "read"],
  ["a pre-start write", [{ id: "planning-read", name: "write" }], "write"],
  ["an unproven custom hint", [{ id: "planning-read", name: "custom-read" }], "custom-read"],
] as const)("does not invent historical provenance from %s", async (_label, calls, name) => {
  const f = await startedAfterPlanningCall([...calls]);
  const writes = f.entries().length;
  expect(new GoalToolLeases().result("planning-read", f.ctx, name)).toBe("current");
  expect(f.entries()).toHaveLength(writes);
});

it.each([false, true])(
  "does not discard a different-name write as old planning (hot=%s)",
  async (hot) => {
    const f = await startedAfterPlanningCall(undefined, hot);
    await f.fire("tool_result", {
      type: "tool_result",
      toolCallId: "planning-read",
      toolName: "write",
      input: { path: "synthetic", content: "uncertain" },
      content: [{ type: "text", text: "Unexpected different-name success" }],
      isError: false,
    });
    expect(currentRuntime().supervisor?.epoch).toBe(1);
    expect(currentRuntime().supervisor?.status).toBe("fault");
    expect(currentRuntime().receiptStore?.stats.count).toBe(0);
  },
);

it("preserves the same planning role when active callback capacity is reached without evicting it", async () => {
  const f = await startedAfterPlanningCall(undefined, true);
  for (let i = 0; i < 512; i++)
    await f.fire("tool_call", {
      type: "tool_call",
      toolCallId: `other-read-${i}`,
      toolName: "read",
      input: { path: "synthetic" },
    });
  const before = currentRuntime().receiptStore!.checkpoint();
  const writes = f.entries().length;
  const result = await f.fire("tool_result", {
    type: "tool_result",
    toolCallId: "planning-read",
    toolName: "read",
    input: { path: "synthetic" },
    content: [{ type: "text", text: "Retained planning result at callback capacity" }],
    isError: false,
  });
  expect(result).toMatchObject({
    content: expect.arrayContaining([
      { type: "text", text: expect.stringContaining("Historical goal") },
    ]),
  });
  expect(currentRuntime().receiptStore!.checkpoint()).toEqual(before);
  expect(currentRuntime().supervisor?.status).toBe("active");
  expect(f.entries()).toHaveLength(writes);
});

it.each([1000, 1001, "uninspectable content"])(
  "does not confuse uninspected assistant metadata with zero calls: %s",
  async (content) => {
    const f = await startedAfterPlanningCall();
    appendFileSync(
      f.path,
      JSON.stringify({
        type: "message",
        id: "metadata-boundary",
        parentId: f.ctx.sessionManager.getLeafId(),
        message: {
          role: "assistant",
          content:
            typeof content === "number"
              ? Array.from({ length: content }, () => ({ type: "text", text: "not cached" }))
              : content,
        },
      }) + "\n",
    );
    f.reload();
    const complete = content === 1000;
    expect(new GoalToolLeases().result("planning-read", f.ctx, "read")).toBe(
      complete ? "historical" : "current",
    );
    const node = inspectSessionJournal(sessionJournalView(f.ctx)).branch.find(
      (n) => n.id === "metadata-boundary",
    )!;
    expect(node.toolCallsIncomplete).toBe(complete ? undefined : true);
    expect(node.toolCalls).toEqual(complete ? [] : undefined);
    expect(JSON.stringify(node)).not.toContain("not cached");
  },
);

it.each(["user", "toolResult"])(
  "does not mistake non-assistant %s content for uncertain tool-call ownership",
  async (role) => {
    const f = await startedAfterPlanningCall();
    appendFileSync(
      f.path,
      JSON.stringify({
        type: "message",
        id: "not-an-assistant-call",
        parentId: f.ctx.sessionManager.getLeafId(),
        message: { role, content: [{ type: "toolCall", id: "planning-read", name: "read" }] },
      }) + "\n",
    );
    f.reload();
    expect(new GoalToolLeases().result("planning-read", f.ctx, "read")).toBe("historical");
  },
);

it("keeps the unknown-result barrier when an oversized post-start message can hide a duplicate call", async () => {
  const f = await startedAfterPlanningCall();
  appendFileSync(
    f.path,
    JSON.stringify({
      type: "message",
      id: "oversized-execution-call",
      parentId: f.ctx.sessionManager.getLeafId(),
      message: {
        role: "assistant",
        content: [
          ...Array.from({ length: 1000 }, () => ({ type: "text", text: "bounded filler" })),
          { type: "toolCall", id: "planning-read", name: "read", arguments: { path: "synthetic" } },
        ],
      },
    }) + "\n",
  );
  f.reload();
  await f.fire("tool_result", {
    type: "tool_result",
    toolCallId: "planning-read",
    toolName: "read",
    input: { path: "synthetic" },
    content: [{ type: "text", text: "Ambiguous delayed execution read" }],
    isError: false,
  });
  expect(currentRuntime().supervisor?.epoch).toBe(1);
  expect(currentRuntime().supervisor?.status).toBe("fault");
  expect(currentRuntime().receiptStore?.stats.count).toBe(0);
});

it("does not classify a native call after the real first-start as earlier planning", async () => {
  const f = await startedAfterPlanningCall();
  appendFileSync(
    f.path,
    JSON.stringify({
      type: "message",
      id: "after-start-native-call",
      parentId: f.ctx.sessionManager.getLeafId(),
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "execution-read", name: "read", arguments: {} }],
      },
    }) + "\n",
  );
  f.reload();
  expect(new GoalToolLeases().result("execution-read", f.ctx, "read")).toBe("current");
});

it("still holds an unexpected success after invalid-name admission was blocked", async () => {
  const f = await startedAfterPlanningCall();
  const name = "x".repeat(201);
  expect(
    await f.fire("tool_call", {
      type: "tool_call",
      toolCallId: "bad-name-success",
      toolName: name,
      input: {},
    }),
  ).toMatchObject({ block: true });
  await f.fire("tool_result", {
    type: "tool_result",
    toolCallId: "bad-name-success",
    toolName: name,
    input: {},
    content: [{ type: "text", text: "Unexpected host success" }],
    isError: false,
  });
  expect(currentRuntime().journalFault).toContain("admission was blocked");
});

it("rejects an overlong admission name rather than retaining unbounded callback metadata", async () => {
  const f = await startedAfterPlanningCall();
  expect(new GoalToolLeases().begin("invalid-name", f.ctx, "x".repeat(201))).toContain("Invalid");
});

it.each(["", "x".repeat(201)])(
  "does not classify an invalid result name as historical",
  async (name) => {
    const f = await startedAfterPlanningCall();
    expect(new GoalToolLeases().result("planning-read", f.ctx, name)).toBe("current");
  },
);

it("retains bounded names and duplicate occurrence IDs, never native arguments or text bodies", async () => {
  const f = await startedAfterPlanningCall([
    { id: "planning-read", name: "read" },
    { id: "planning-read", name: "read" },
  ]);
  const node = inspectSessionJournal(sessionJournalView(f.ctx)).branch.find(
    (n) => n.id === "planning-native-call",
  )!;
  const inputDigest = "ae1a6c9dc0cfbb09092fe3f79bb3b3519e9086b3346d8cb1b6376ba643c2072a";
  expect(node.toolCalls).toEqual([
    { id: "planning-read", name: "read", inputDigest },
    { id: "planning-read", name: "read", inputDigest },
  ]);
  expect(node.toolCallIds).toEqual(["planning-read", "planning-read"]);
  expect(node.data).toBeUndefined();
  expect(JSON.stringify(node)).not.toContain("synthetic");
});

it("reads the original startup without mutation after later permission approval and recovery", async () => {
  const f = await startedAfterPlanningCall();
  const original = readGoalFirstStartEntry(f.ctx, currentRuntime().goal!.current!);
  expect(original).toBeDefined();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await f.command("approve");
  await f.fire("session_tree");
  await f.command("recover");
  const before = JSON.stringify({
    goal: currentRuntime().goal,
    preflight: currentRuntime().preflight,
    supervisor: currentRuntime().supervisor,
    fault: currentRuntime().journalFault,
  });
  const writes = f.entries().length;
  expect(readGoalFirstStartEntry(f.ctx, currentRuntime().goal!.current!)).toBe(original);
  expect(new GoalToolLeases().result("planning-read", f.ctx, "read")).toBe("historical");
  expect(
    JSON.stringify({
      goal: currentRuntime().goal,
      preflight: currentRuntime().preflight,
      supervisor: currentRuntime().supervisor,
      fault: currentRuntime().journalFault,
    }),
  ).toBe(before);
  expect(f.entries()).toHaveLength(writes);
});

it("does not select a sibling or contradictory first startup instead of preserving uncertainty", async () => {
  const f = await startedAfterPlanningCall();
  const current = currentRuntime().goal!.current!;
  expect(() =>
    readGoalFirstStartEntry(f.ctx, {
      ...current,
      scope: { ...current.scope, lifecycleCommitId: "sibling" },
    }),
  ).toThrow();
  const first = readGoalFirstStartEntry(f.ctx, current)!;
  const rows = readFileSync(f.path, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  rows.find((row) => row.id === first).data.supervisor.epoch = 1;
  writeFileSync(f.path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  f.reload();
  expect(() => readGoalFirstStartEntry(f.ctx, current)).toThrow();
  expect(new GoalToolLeases().result("planning-read", f.ctx, "read")).toBe("current");
});

it("does not fault or advance the execution ledger for a proven pre-start read result after callback cache loss", async () => {
  const f = await startedAfterPlanningCall();
  const before = structuredClone(currentRuntime().supervisor);
  const ledger = currentRuntime().receiptStore!.checkpoint();
  const writes = f.entries().length;
  const result = await f.fire("tool_result", {
    type: "tool_result",
    toolCallId: "planning-read",
    toolName: "read",
    input: { path: "synthetic" },
    content: [{ type: "text", text: "Late old pure planning read" }],
    isError: false,
  });
  expect(result).toMatchObject({
    content: expect.arrayContaining([
      { type: "text", text: expect.stringContaining("Historical goal") },
    ]),
  });
  expect(currentRuntime().receiptStore!.checkpoint()).toEqual(ledger);
  expect(currentRuntime().supervisor).toEqual(before);
  expect(f.entries()).toHaveLength(writes);
});
