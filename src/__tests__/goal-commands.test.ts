import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture, completeGoalProposal } from "./helpers/goal";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import { BOUNDARY } from "./helpers/lifecycle";
import { readControlJournal } from "../control-journal";
import { submitAndPresentPreflight } from "../preflight-human";

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

it("routes supervise through native archive then one claimed read-only planning turn, and supports explicit same-goal replan/stop", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  const sendSaw: string[] = [];
  f.sendMessage.mockImplementation((_message, options) => {
    if (options?.triggerTurn)
      sendSaw.push(currentRuntime().goal?.current?.planning.status ?? "none");
  });
  await f.command("supervise Native next goal");
  await f.fire("agent_start");
  const current = currentRuntime().goal?.current;
  expect(current?.phase).toBe("planning");
  expect(current?.seed.goal).toBe("Native next goal");
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(sendSaw).toEqual(["dispatch-claimed"]);
  expect(current?.planning.status).toBe("dispatched");
  expect(
    await f.fire("tool_call", {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "not-authorized",
      input: { command: "write hypothetical business data" },
    }),
  ).toMatchObject({ block: true });
  expect(
    await f.fire("tool_call", {
      type: "tool_call",
      toolName: "read",
      toolCallId: "readonly",
      input: { path: "README.md" },
    }),
  ).toBeUndefined();
  expect(
    await f.fire("tool_call", {
      type: "tool_call",
      toolName: "submit_preflight",
      toolCallId: "proposal",
      input: { preflightId: currentRuntime().preflight!.preflightId },
    }),
  ).toBeUndefined();
  expect(f.sendMessage.mock.calls.find(([, options]) => options?.triggerTurn)?.[0]).toMatchObject({
    customType: "continuous-tasks:preflight-planning",
    display: false,
    content: expect.stringContaining("read-only proposal"),
  });
  const id = current!.scope.goalRunId;
  await f.command("supervise Native next goal");
  expect(sendSaw).toHaveLength(1);
  expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  expect(currentRuntime().goal?.current?.phase).toBe("planning-interrupted");
  await f.command("supervise --replan");
  expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(id);
  expect(currentRuntime().goal?.current?.planning.attemptNo).toBe(1);
  expect(sendSaw).toEqual(["dispatch-claimed", "dispatch-claimed"]);
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  const blocked = await f.fire("tool_call", {
    type: "tool_call",
    toolName: "write_tasks",
    toolCallId: "stopped-write",
    input: { mode: "replace", phases: [] },
  });
  expect(blocked).toMatchObject({ block: true });
  expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
  await f.command("supervise Following native goal");
  expect(currentRuntime().goal?.current?.scope.goalRunId).not.toBe(id);
  expect(currentRuntime().goal?.archives).toHaveLength(2);
  expect(sendSaw).toEqual(["dispatch-claimed", "dispatch-claimed", "dispatch-claimed"]);
});

it("does not dispatch business Main until the new goal has its own approval and separate native first-start", async () => {
  const f = await goalFixture({ gitWorkspace: true });
  fixtures.push(f);
  await f.command("supervise Native permission sequence");
  await f.fire("agent_start");
  const turns = () => f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn);
  expect(turns()).toHaveLength(1);
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "new-proposal",
    currentRuntime().preflight!.preflightId,
    await completeGoalProposal(f),
  );
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(turns()).toHaveLength(1);
  vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
  await f.command("start");
  expect(currentRuntime().supervisor?.status).toBe("active");
  expect(currentRuntime().preflight?.phase).toBe("started");
  const journal = readControlJournal(f.ctx);
  const bound = journal.acceptance?.contracts.at(-1)?.data;
  expect(bound?.authority.kind).toBe("preflight-reviewed");
  expect(bound?.owner).toMatchObject({
    kind: "goal",
    goal: {
      goalRunId: currentRuntime().goal?.current?.scope.goalRunId,
      lifecycleCommitId: currentRuntime().goal?.current?.scope.lifecycleCommitId,
    },
  });
  expect(journal.acceptance?.contractReviews).toHaveLength(0);
  expect(turns()).toHaveLength(2);
  expect(turns()[1]?.[0]).toMatchObject({
    customType: "continuous-tasks:continue",
    display: false,
  });
  const starts = f
    .entries()
    .filter(
      (e) =>
        e.customType === "continuous-tasks:preflight-control" &&
        (e.data as { kind?: string }).kind === "start",
    ).length;
  await f.command("start");
  expect(turns()).toHaveLength(2);
  expect(
    f
      .entries()
      .filter(
        (e) =>
          e.customType === "continuous-tasks:preflight-control" &&
          (e.data as { kind?: string }).kind === "start",
      ),
  ).toHaveLength(starts);
});

it("can explicitly end an approved but never-started planning goal without revoking or reusing its old permission", async () => {
  const f = await goalFixture({ gitWorkspace: true });
  fixtures.push(f);
  await f.command("supervise Approved draft goal");
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "approved-draft",
    currentRuntime().preflight!.preflightId,
    await completeGoalProposal(f),
  );
  const approval = structuredClone(currentRuntime().preflight?.approval);
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  expect(currentRuntime().supervisor).toBeUndefined();
  const controls = f
    .entries()
    .filter((e) => e.customType === "continuous-tasks:preflight-control").length;
  await f.command("approve");
  expect(
    f.entries().filter((e) => e.customType === "continuous-tasks:preflight-control"),
  ).toHaveLength(controls);
  vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
  await f.command("supervise New goal after approved draft");
  expect(
    currentRuntime().goal?.current?.seed.goal,
    JSON.stringify(vi.mocked(f.ctx.ui.notify).mock.calls),
  ).toBe("New goal after approved draft");
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(currentRuntime().preflight?.phase).toBe("planning");
});

it("does not redispatch on reopen and exposes explicit replan/stop instead of resume/recover for an unstarted goal", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Reopened command goal");
  const id = currentRuntime().goal!.current!.scope.goalRunId;
  const turns = () => f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn).length;
  expect(turns()).toBe(1);
  f.reload();
  resetState();
  await f.fire("session_tree");
  expect(currentRuntime().goal?.current?.phase).toBe("planning-interrupted");
  expect(turns()).toBe(1);
  const count = f.entries().length;
  await f.command("resume");
  await f.command("recover");
  expect(f.entries()).toHaveLength(count);
  expect(turns()).toBe(1);
  await f.command("supervise --replan");
  expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(id);
  expect(currentRuntime().goal?.current?.planning.attemptNo).toBe(1);
  expect(turns()).toBe(2);
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  const after = f.entries().length;
  await f.command("stop");
  expect(f.entries()).toHaveLength(after);
});
