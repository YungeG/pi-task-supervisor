import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import {
  requestGoalTransition,
  replanCurrentGoal,
  stopCurrentGoal,
  dispatchGoalPlanning,
} from "../goal-lifecycle";
import { goalPlanningRef } from "../goal-planning";
import { submitPreflight } from "../preflight";

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
async function prepared() {
  const f = await goalFixture();
  fixtures.push(f);
  expect(
    (
      await requestGoalTransition(f.api, f.ctx, {
        goal: "Command guarded goal",
        intent: "preflight",
      })
    ).status,
  ).toBe("committed-planning");
  return f;
}
it.each(["A", "B", "C"])(
  "reconciles actual %s ACK loss through registered commands without implicit replay or a repeated confirmed answer",
  async (stage) => {
    const f = await goalFixture();
    fixtures.push(f);
    let failed = false;
    f.fail((type, raw) => {
      const data = raw as { kind?: string; frame?: { owner?: string } };
      const matches =
        stage === "A"
          ? data.kind === "transition-control"
          : stage === "B"
            ? type === "continuous-tasks:human-readback" && data.frame?.owner === "goal"
            : data.kind === "transition-committed";
      if (!failed && matches) {
        failed = true;
        return "after";
      }
      return undefined;
    });
    await f.command("supervise Command ACK goal");
    expect(failed).toBe(true);
    expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(0);
    f.fail(undefined);
    const questions = vi.mocked(f.ctx.ui.select).mock.calls.length;
    await f.command("supervise Command ACK goal");
    expect(currentRuntime().goal?.current?.seed.goal).toBe("Command ACK goal");
    expect(vi.mocked(f.ctx.ui.select).mock.calls.length).toBe(questions + (stage === "A" ? 1 : 0));
    expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(
      stage === "A" ? 1 : 0,
    );
    if (stage !== "A") {
      await f.command("preflight");
      expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(
        1,
      );
    }
  },
);
it.each(["scope", "head", "attempt", "already-claimed"])(
  "rejects a %s planning dispatch lease before send",
  async (field) => {
    const f = await prepared();
    const current = currentRuntime().goal!.current!;
    const ready = goalPlanningRef(current);
    if (field === "scope") ready.scope.goalRunId = "other-goal";
    if (field === "head") ready.headEntryId = "other-head";
    if (field === "attempt") ready.attemptId = "other-attempt";
    if (field === "already-claimed") {
      dispatchGoalPlanning(f.api, f.ctx, ready);
      ready.headEntryId = currentRuntime().goal!.current!.headEntryId;
    }
    const writes = f.entries().length;
    const turns = f.sendMessage.mock.calls.length;
    expect(() => {
      dispatchGoalPlanning(f.api, f.ctx, ready);
    }).toThrow();
    expect(f.entries()).toHaveLength(writes);
    expect(f.sendMessage).toHaveBeenCalledTimes(turns);
  },
);

it("aborts only its own claimed pure planning, then records positive quiescence rather than execution completion", async () => {
  const f = await prepared();
  dispatchGoalPlanning(f.api, f.ctx, goalPlanningRef(currentRuntime().goal!.current!));
  let idle = false;
  vi.mocked(f.ctx.isIdle).mockImplementation(() => idle);
  vi.mocked(f.ctx.abort).mockImplementation(() => {
    idle = true;
  });
  expect((await stopCurrentGoal(f.api, f.ctx)).status).toBe("stopped");
  expect(f.ctx.abort).toHaveBeenCalledOnce();
  expect(currentRuntime().goal?.current?.planning.status).toBe("closed-unknown-result");
  expect(currentRuntime().supervisor).toBeUndefined();
});

it("retains claim-before-send uncertainty and never replays the planning message during reopening", async () => {
  const f = await prepared();
  f.sendMessage.mockImplementationOnce(() => {
    throw new Error("Unknown planning transport acknowledgement");
  });
  expect(() => {
    dispatchGoalPlanning(f.api, f.ctx, goalPlanningRef(currentRuntime().goal!.current!));
  }).toThrow("Unknown planning transport");
  expect(currentRuntime().goal?.current?.planning.status).toBe("dispatch-claimed");
  const turns = f.sendMessage.mock.calls.length;
  await f.fire("session_tree");
  expect(f.sendMessage).toHaveBeenCalledTimes(turns);
  expect(currentRuntime().goal?.current?.phase).toBe("planning-interrupted");
  expect((await stopCurrentGoal(f.api, f.ctx)).status).toBe("stopped");
});

it("does not overwrite a newer physical planning state after waiting", async () => {
  const f = await prepared();
  const current = currentRuntime().goal!.current!;
  vi.mocked(f.ctx.waitForIdle).mockImplementationOnce(async () => {
    f.api.appendEntry("continuous-tasks:supervisor", {
      version: 5,
      protocol: "goal-lifecycle-v1",
      kind: "goal-state",
      sessionId: "test-session",
      scope: current.scope,
      previous: current.headEntryId,
      action: "claim-planning-dispatch",
      phase: "planning",
      planning: { ...current.planning, status: "dispatch-claimed" },
      supervisor: null,
    });
  });
  expect(await replanCurrentGoal(f.api, f.ctx)).toMatchObject({
    status: "blocked",
    reason: expect.stringContaining("identity changed"),
  });
});

it("does not replace a live goal with different text or redispatch while the real host is busy", async () => {
  const f = await prepared();
  const current = structuredClone(currentRuntime().goal?.current);
  const entries = f.entries().length;
  await f.command("supervise Different unapproved goal");
  expect(currentRuntime().goal?.current).toEqual(current);
  expect(f.entries()).toHaveLength(entries);
  vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  await f.command("preflight");
  expect(f.entries()).toHaveLength(entries);
  expect(f.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(0);
});
it.each(["replan", "stop"])(
  "denies %s from ordinary RPC without writing or dispatch",
  async (operation) => {
    const f = await prepared();
    const before = f.entries().length;
    Object.assign(f.ctx, { mode: "rpc" });
    const result =
      operation === "replan"
        ? await replanCurrentGoal(f.api, f.ctx)
        : await stopCurrentGoal(f.api, f.ctx);
    expect(result.status).toBe("blocked");
    expect(f.entries()).toHaveLength(before);
  },
);
it.each([
  "busy",
  "pending",
  "journal",
  "board-repair",
  "preflight-repair",
  "proposal",
  "unknown-start",
])("does not replan/end past %s work", async (fault) => {
  const f = await prepared();
  const runtime = currentRuntime();
  if (fault === "busy") vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  if (fault === "pending") vi.mocked(f.ctx.hasPendingMessages).mockReturnValue(true);
  if (fault === "journal") runtime.journalFault = "Independent journal fault";
  if (fault === "board-repair" || fault === "preflight-repair")
    runtime[fault === "board-repair" ? "boardRepair" : "preflightRepair"] = {
      sessionId: "test-session",
      controlEntryId: "unknown",
      projectedDigest: "0".repeat(64),
      faultMessage: "Independent repair",
      ownsJournalFault: false,
    };
  if (fault === "proposal")
    submitPreflight(f.api, f.ctx, runtime.preflight!.preflightId, localProposal);
  if (fault === "unknown-start")
    f.api.appendEntry("continuous-tasks:preflight-control", { kind: "start" });
  const before = f.entries().length;
  expect((await replanCurrentGoal(f.api, f.ctx)).status).not.toBe("planning-ready");
  expect((await stopCurrentGoal(f.api, f.ctx)).status).not.toBe("stopped");
  expect(f.entries()).toHaveLength(before);
  expect(f.ctx.abort).not.toHaveBeenCalled();
});
