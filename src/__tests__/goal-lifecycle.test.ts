import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import {
  inspectGoalTransition,
  requestGoalTransition,
  restoreGoalLifecycle,
  readGoalHistory,
  replanCurrentGoal,
  stopCurrentGoal,
} from "../goal-lifecycle";
import { journalDigest } from "../human-journal";
import { submitAndPresentPreflight, startApprovedPreflight } from "../preflight-human";
import { restorePreflight } from "../preflight";
import { localProposal } from "./helpers/preflight";

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

it("archives a stopped paused history and commits an independent planning GoalRun without clearing history or dispatching", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  const original = journalDigest(f.oldEntry);
  expect(
    inspectGoalTransition(f.ctx, { goal: "Synthetic next goal", intent: "supervise" }).status,
  ).toBe("eligible");
  const result = await requestGoalTransition(f.api, f.ctx, {
    goal: "Synthetic next goal",
    intent: "supervise",
  });
  expect(result.status).toBe("committed-planning");
  const current = currentRuntime().goal?.current;
  expect(current?.scope.goalRunId).toMatch(/^rg-/);
  expect(current?.phase).toBe("planning");
  expect(getBoard().tasks).toEqual([]);
  expect(getBoard().generation).toBe(49);
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(currentRuntime().receiptStore).toBeUndefined();
  expect(currentRuntime().preflight).toMatchObject({ phase: "planning", revision: 0 });
  expect(journalDigest(f.entries().find((e) => e.id === f.oldEntry.id))).toBe(original);
  expect(f.sendMessage).not.toHaveBeenCalled();
  const history = readGoalHistory(f.ctx);
  expect(history.items).toHaveLength(1);
  const selected = readGoalHistory(f.ctx, "0", history.items[0]!.goalKey);
  expect(selected.items[0]?.board.tasks).toEqual(f.old.tasks);
  const id = current!.scope.goalRunId;
  resetState();
  const reopened = restoreGoalLifecycle(f.api, f.ctx);
  expect(reopened?.current?.scope.goalRunId).toBe(id);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("can archive a stopped legacy goal before any board was ever recorded, without pretending a missing snapshot is proof", async () => {
  const f = await goalFixture({ emptyBoard: true });
  fixtures.push(f);
  const before = f.entries().map((e) => journalDigest(e));
  expect(f.entries().some((e) => e.customType === "continuous-tasks:snapshot")).toBe(false);
  expect(
    (
      await requestGoalTransition(f.api, f.ctx, {
        goal: "Next after empty history",
        intent: "supervise",
      })
    ).status,
  ).toBe("committed-planning");
  expect(getBoard()).toMatchObject({ generation: 1, workflowStatus: "inactive", tasks: [] });
  expect(
    f
      .entries()
      .slice(0, before.length)
      .map((e) => journalDigest(e)),
  ).toEqual(before);
  const key = readGoalHistory(f.ctx).items[0]!.goalKey;
  expect(readGoalHistory(f.ctx, "0", key).items[0]).toMatchObject({
    boardWasRecorded: false,
    board: { tasks: [], generation: 0 },
  });
});

it("retains an unsupervised board-v1 done record as legacy history without manufacturing completion evidence", async () => {
  const f = await goalFixture({ unsupervisedLegacy: true });
  fixtures.push(f);
  const original = journalDigest(f.entries()[0]);
  expect(f.old.tasks[0]?.completionEvidence).toBeUndefined();
  expect(
    (
      await requestGoalTransition(f.api, f.ctx, {
        goal: "Goal after legacy board",
        intent: "supervise",
      })
    ).status,
  ).toBe("committed-planning");
  expect(getBoard()).toMatchObject({ generation: 2, tasks: [] });
  const key = readGoalHistory(f.ctx).items[0]!.goalKey;
  const old = readGoalHistory(f.ctx, "0", key).items[0];
  expect(old?.phase).toBe("legacy-board");
  expect(old?.board.tasks[0]).toMatchObject({ status: "done" });
  expect(old?.board.tasks[0]?.completionEvidence).toBeUndefined();
  expect(journalDigest(f.entries()[0])).toBe(original);
});

it("reopens an unstarted goal, explicitly replans within its identity, then stops it without a Supervisor and can prepare the following goal", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  expect(
    (await requestGoalTransition(f.api, f.ctx, { goal: "Planning goal", intent: "supervise" }))
      .status,
  ).toBe("committed-planning");
  const before = structuredClone(currentRuntime().goal!.current!);
  resetState();
  restoreGoalLifecycle(f.api, f.ctx);
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect((await replanCurrentGoal(f.api, f.ctx)).status).toBe("planning-ready");
  const replanned = currentRuntime().goal!.current!;
  expect(replanned.scope).toEqual(before.scope);
  expect(replanned.planning.attemptNo).toBe(1);
  expect(replanned.planning.attemptId).not.toBe(before.planning.attemptId);
  expect(replanned.planning.preflightId).not.toBe(before.planning.preflightId);
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(f.sendMessage).not.toHaveBeenCalled();
  expect((await stopCurrentGoal(f.api, f.ctx)).status).toBe("stopped");
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  expect(currentRuntime().supervisor).toBeUndefined();
  const count = f.entries().length;
  expect((await stopCurrentGoal(f.api, f.ctx)).status).toBe("already-stopped");
  expect(f.entries()).toHaveLength(count);
  expect(inspectGoalTransition(f.ctx, { goal: "Following goal", intent: "supervise" }).status).toBe(
    "eligible",
  );
  expect(
    (await requestGoalTransition(f.api, f.ctx, { goal: "Following goal", intent: "supervise" }))
      .status,
  ).toBe("committed-planning");
  expect(currentRuntime().goal?.current?.scope.goalRunId).not.toBe(before.scope.goalRunId);
  expect(readGoalHistory(f.ctx).items).toHaveLength(2);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("repairs the exact written planning attempt after acknowledgement loss instead of allocating another attempt", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await requestGoalTransition(f.api, f.ctx, { goal: "Planning repair", intent: "supervise" });
  const scope = structuredClone(currentRuntime().goal!.current!.scope);
  f.fail((type, data) =>
    type === "continuous-tasks:supervisor" &&
    (data as { action?: string }).action === "prepare-planning"
      ? "after"
      : undefined,
  );
  expect((await replanCurrentGoal(f.api, f.ctx)).status).toBe("projection-pending");
  expect(currentRuntime().goal?.current?.planning.attemptNo).toBe(0);
  f.fail(undefined);
  expect((await replanCurrentGoal(f.api, f.ctx)).status).toBe("planning-ready");
  expect(currentRuntime().goal?.current?.scope).toEqual(scope);
  expect(currentRuntime().goal?.current?.planning.attemptNo).toBe(1);
  expect(
    f.entries().filter((e) => (e.data as { action?: string }).action === "prepare-planning"),
  ).toHaveLength(1);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("rejects a changed pinned model before saving native first-start authority", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await requestGoalTransition(f.api, f.ctx, { goal: "Pinned model goal", intent: "supervise" });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "proposal-call",
    currentRuntime().preflight!.preflightId,
    localProposal,
  );
  Object.assign(f.ctx, { model: { provider: "faux", id: "different" } });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
  await expect(startApprovedPreflight(f.api, f.ctx)).rejects.toThrow(/pinned model/);
  expect(
    f
      .entries()
      .some(
        (e) =>
          e.customType === "continuous-tasks:preflight-control" &&
          (e.data as { kind?: string }).kind === "start",
      ),
  ).toBe(false);
});

it("requires and restores a fresh scope-bound preflight approval for the new goal without starting execution", async () => {
  const f = await goalFixture();
  fixtures.push(f);
  await requestGoalTransition(f.api, f.ctx, { goal: "New authorized plan", intent: "supervise" });
  const goal = structuredClone(currentRuntime().goal!.current!);
  const preflightId = currentRuntime().preflight!.preflightId;
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  const result = await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "proposal-call",
    preflightId,
    localProposal,
  );
  expect(result.status).toBe("approved");
  expect(currentRuntime().preflight?.phase).toBe("approved");
  const latest = f
    .entries()
    .filter((e) => e.customType === "continuous-tasks:preflight")
    .at(-1);
  expect(latest?.data).toMatchObject({
    version: 3,
    goalRunId: goal.scope.goalRunId,
    lifecycleCommitId: goal.scope.lifecycleCommitId,
    snapshot: { version: 2, phase: "approved" },
  });
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(f.sendMessage).not.toHaveBeenCalled();
  resetState();
  restoreGoalLifecycle(f.api, f.ctx);
  restorePreflight(f.ctx);
  expect(currentRuntime().preflight).toMatchObject({
    preflightId,
    phase: "approved",
    approval: { permissionIds: ["A1"] },
  });
  expect(currentRuntime().goal?.current?.scope).toEqual(goal.scope);
  expect(f.sendMessage).not.toHaveBeenCalled();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
  const started = await startApprovedPreflight(f.api, f.ctx);
  expect(started.status).toBe("started");
  expect(currentRuntime().supervisor).toMatchObject({
    goalRunId: goal.scope.goalRunId,
    status: "active",
    reviews: 0,
    continuations: 0,
    stagnant: 0,
    bindings: [],
  });
  expect(currentRuntime().receiptStore?.checkpoint()).toMatchObject({
    goalId: goal.scope.goalRunId,
    receiptCount: 0,
    pending: [],
  });
  expect(
    f
      .entries()
      .filter((e) => e.customType === "continuous-tasks:supervisor")
      .at(-1)?.data,
  ).toMatchObject({
    version: 5,
    kind: "goal-state",
    scope: goal.scope,
    supervisor: { version: 3, status: "active" },
  });
  expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
  f.reload();
  resetState();
  await f.fire("session_tree");
  expect(currentRuntime().goal?.current?.scope).toEqual(goal.scope);
  expect(currentRuntime().preflight?.phase).toBe("started");
  expect(currentRuntime().supervisor).toMatchObject({
    goalRunId: goal.scope.goalRunId,
    status: "fault",
    holdCause: "interrupted",
    reviews: 0,
    continuations: 0,
  });
  expect(currentRuntime().receiptStore?.checkpoint().goalId).toBe(goal.scope.goalRunId);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
});
