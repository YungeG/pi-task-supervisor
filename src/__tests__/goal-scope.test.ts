import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import { requestGoalTransition } from "../goal-lifecycle";
import {
  wrapGoalSnapshot,
  unwrapGoalSnapshot,
  supervisorPayload,
  type GoalControl,
} from "../goal-records";
import {
  goalControlIssue,
  goalExecutionIssue,
  goalPreflightControlIssue,
  goalStartIdentityIssue,
  requireCurrentCarrier,
  selectedGoalEntries,
  scopedSupervisorCheckpoint,
  observeScopedSupervisorCheckpoint,
} from "../goal-scope";

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
        goal: "Scope adapter boundaries",
        intent: "preflight",
      })
    ).status,
  ).toBe("committed-planning");
  return f;
}
it("does not unwrap a carrier without selection or across a sibling GoalRun/commit", async () => {
  await prepared();
  const scope = currentRuntime().goal!.current!.scope;
  const original = { allowed: ["read"] };
  const wrapped = wrapGoalSnapshot(scope, original);
  original.allowed.push("write");
  expect(unwrapGoalSnapshot(wrapped, scope)).toEqual({ allowed: ["read"] });
  expect(() => unwrapGoalSnapshot(wrapped)).toThrow("no selected GoalRun");
  expect(() => unwrapGoalSnapshot(wrapped, { ...scope, goalRunId: "other" })).toThrow();
  expect(() => unwrapGoalSnapshot(wrapped, { ...scope, lifecycleCommitId: "sibling" })).toThrow();
  expect(() => {
    requireCurrentCarrier({ version: 2 });
  }).toThrow();
  expect(() => {
    requireCurrentCarrier(wrapGoalSnapshot({ ...scope, goalRunId: "other" }, {}));
  }).toThrow();
  expect(() => selectedGoalEntries([{ id: "not-the-selected-checkpoint" }])).toThrow();
  expect(() => supervisorPayload({ version: 5, kind: "not-a-protocol-record" })).toThrow();
});
it("rejects stale Supervisor observer scope/predecessor/action without publishing a new head", async () => {
  const f = await prepared();
  const before = structuredClone(currentRuntime().goal!.current!);
  const row = scopedSupervisorCheckpoint({}, "active") as Record<string, any>;
  expect(() => {
    observeScopedSupervisorCheckpoint({ ...row, previous: "other-head" }, "unconfirmed");
  }).toThrow();
  expect(() => {
    observeScopedSupervisorCheckpoint(
      { ...row, scope: { ...before.scope, goalRunId: "other" } },
      "unconfirmed",
    );
  }).toThrow();
  expect(() => {
    observeScopedSupervisorCheckpoint({ ...row, action: "stop-unstarted" }, "unconfirmed");
  }).toThrow();
  expect(() => {
    observeScopedSupervisorCheckpoint({}, "unconfirmed");
  }).toThrow();
  const foreign = {
    ...f.ctx,
    sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "foreign" },
  };
  expect(goalControlIssue(foreign)).toContain("another Session");
  expect(currentRuntime().goal?.current).toEqual(before);
});
it("will not prepare an ordinary Supervisor write while a goal-transition fence is pending", async () => {
  const f = await prepared();
  const entry = f
    .entries()
    .find((e) => (e.data as { kind?: string }).kind === "transition-control")!;
  currentRuntime().goal!.pending = {
    controlEntryId: entry.id,
    control: entry.data as GoalControl,
    confirmed: false,
  };
  expect(goalControlIssue(f.ctx)).toContain("not confirmed");
  expect(goalExecutionIssue(f.ctx)).toContain("not confirmed");
  expect(goalPreflightControlIssue(f.ctx)).toContain("not confirmed");
  expect(goalStartIdentityIssue(f.ctx, "Scope adapter boundaries")).toContain("not ready");
  expect(() => scopedSupervisorCheckpoint({}, "active")).toThrow("pending goal transition");
});
