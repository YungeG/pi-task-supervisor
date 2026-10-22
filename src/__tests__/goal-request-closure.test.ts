import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import { submitAndPresentPreflight } from "../preflight-human";
import { currentPreflightRequestIssue } from "../preflight";
import { wrapGoalSnapshot, type GoalStateRecord } from "../goal-records";
import { readGoalJournal } from "../goal-journal";

// Approved seams: repair plan §4/§6 and R5 native choice A packet; registered commands,
// restoration and native journal validation. Forged fixture rows are never authority.
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
async function approved() {
  const f = await goalFixture();
  fixtures.push(f);
  await f.command("supervise Current request closure");
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "initial-proposal",
    currentRuntime().preflight!.preflightId,
    localProposal,
  );
  expect(currentRuntime().preflight?.phase).toBe("approved");
  return f;
}
it.each([
  "不允许",
  "允许上述范围",
  "稍后决定",
  "队列变化",
  "Main繁忙",
  "读回丢失",
  "伪造批准",
  "伪造开始",
  "伪造拒绝格式",
])("only accepts native denial on a legacy closed-unstarted owner: %s", async (choice) => {
  const f = await approved();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const current = currentRuntime().goal!.current!;
  const id = current.scope.goalRunId;
  // Owned R1 persisted-state regression fixture, not an authority-producing operation.
  const record: GoalStateRecord = {
    version: 5,
    protocol: "goal-lifecycle-v1",
    kind: "goal-state",
    sessionId: "test-session",
    scope: current.scope,
    previous: current.headEntryId,
    action: "stop-unstarted",
    phase: "stopped",
    planning: { ...current.planning, status: "closed-unknown-result" },
    supervisor: null,
    disposition: "closed-unstarted",
    quiescence: {
      sessionId: "test-session",
      goalRunId: id,
      attemptId: current.planning.attemptId,
      branchAnchor: f.ctx.sessionManager.getLeafId()!,
      hostIdle: true,
      pendingMessages: false,
      observedAt: Date.now(),
    },
  };
  f.api.appendEntry("continuous-tasks:supervisor", record);
  await f.fire("session_tree");
  const writes = f.entries().length;
  await f.command("supervise Do not hide legacy pending request");
  expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(id);
  expect(f.entries()).toHaveLength(writes);
  await f.command(`revoke ${currentRuntime().preflight!.planId}`);
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toContain("unanswered");
  if (choice.startsWith("伪造")) {
    const control = f
      .entries()
      .find(
        (e) =>
          e.customType === "continuous-tasks:preflight-control" &&
          (e.data as any).kind === "approve",
      )!.data as Record<string, unknown>;
    f.api.appendEntry("continuous-tasks:preflight-control", {
      ...structuredClone(control),
      kind: choice === "伪造批准" ? "approve" : choice === "伪造开始" ? "start" : "reject",
      ...(choice === "伪造拒绝格式" ? { version: 1, answer: "Reject" } : {}),
    });
    expect(() => readGoalJournal(f.ctx)).toThrow("closed unstarted goal");
    expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toBeTruthy();
    expect(currentRuntime().preflight?.approval).toBeUndefined();
    expect(currentRuntime().supervisor).toBeUndefined();
    return;
  }
  const beforeAnswer = f.entries().length;
  const sends = f.sendMessage.mock.calls.length;
  if (choice === "读回丢失")
    f.fail((kind, data: any) =>
      kind === "continuous-tasks:human-readback" && data.frame?.owner === "preflight"
        ? "before"
        : undefined,
    );
  if (choice === "队列变化")
    vi.mocked(f.ctx.ui.select).mockImplementation(async () => {
      vi.mocked(f.ctx.hasPendingMessages).mockReturnValue(true);
      return "不允许";
    });
  else if (choice === "Main繁忙")
    vi.mocked(f.ctx.ui.select).mockImplementation(async () => {
      vi.mocked(f.ctx.isIdle).mockReturnValue(false);
      return "不允许";
    });
  else vi.mocked(f.ctx.ui.select).mockResolvedValue(choice === "读回丢失" ? "不允许" : choice);
  await f.command("approve");
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(f.sendMessage).toHaveBeenCalledTimes(sends);
  const controls = f
    .entries()
    .slice(beforeAnswer)
    .filter((e) => e.customType === "continuous-tasks:preflight-control");
  if (choice === "读回丢失") {
    expect(controls).toHaveLength(1);
    expect(controls[0]!.data).toMatchObject({ version: 2, kind: "reject" });
    expect(currentRuntime().journalFault).toBeTruthy();
    expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toBeTruthy();
    return;
  }
  if (choice !== "不允许") {
    expect(controls).toHaveLength(0);
    vi.mocked(f.ctx.hasPendingMessages).mockReturnValue(false);
    vi.mocked(f.ctx.isIdle).mockReturnValue(true);
    await f.fire("session_tree");
    expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toContain(
      "unanswered",
    );
    return;
  }
  expect(controls).toHaveLength(1);
  expect(controls[0]!.data).toMatchObject({ version: 2, kind: "reject", answer: "Reject" });
  expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toBeUndefined();
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  expect(currentRuntime().supervisor).toBeUndefined();
  await f.command(`revoke ${currentRuntime().preflight!.planId}`);
  await f.fire("session_tree");
  expect(currentRuntime().goal?.current?.phase).toBe("stopped");
  expect(currentRuntime().supervisor).toBeUndefined();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("选项 1");
  await f.command("supervise After actual owner closure");
  expect(currentRuntime().goal?.current?.scope.goalRunId).not.toBe(id);
});

it("does not accept a revoked projection without its actual owner control", async () => {
  const f = await approved();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const state = { ...currentRuntime().preflight!, phase: "revoked", approval: undefined };
  f.api.appendEntry(
    "continuous-tasks:preflight",
    wrapGoalSnapshot(currentRuntime().goal!.current!.scope, state),
  );
  const writes = f.entries().length;
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).not.toBe("stopped");
  expect(f.entries()).toHaveLength(writes);
});

it("does not let request-field removal erase a genuine unanswered permission request", async () => {
  const f = await approved();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const state = { ...currentRuntime().preflight!, permissionRequest: undefined };
  f.api.appendEntry(
    "continuous-tasks:preflight",
    wrapGoalSnapshot(currentRuntime().goal!.current!.scope, state),
  );
  const writes = f.entries().length;
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).not.toBe("stopped");
  expect(f.entries()).toHaveLength(writes);
});

it("retains the same identity when the original unanswered question is still genuinely open", async () => {
  const f = await approved();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const question = structuredClone(currentRuntime().preflight!);
  const writes = f.entries().length;
  await f.command("approve");
  expect(currentRuntime().preflight).toEqual(question);
  expect(f.entries()).toHaveLength(writes);
  expect(currentPreflightRequestIssue(f.ctx, question)).toContain("unanswered");
});

it("does not reuse a revoked unanswered question when the same permission selection is asked again", async () => {
  const f = await approved();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const first = structuredClone(currentRuntime().preflight!);
  if (first.version !== 2) throw new Error("Native request required");
  await f.command(`revoke ${first.planId}`);
  await f.command("approve");
  expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toContain("unanswered");
  const after = currentRuntime().preflight!;
  expect(after.version === 2 && after.permissionRequest?.id).not.toBe(first.permissionRequest!.id);
  expect(after.version === 2 && after.permissionRequest?.supersedes).toEqual({
    requestId: first.permissionRequest!.id,
  });
  await f.fire("session_tree");
  const writes = f.entries().length;
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).not.toBe("stopped");
  await f.command("supervise Must retain the repeated question");
  expect(f.entries()).toHaveLength(writes);
  expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toContain("unanswered");
});

it("does not let an older revoke close a newer permission request, including after reopening", async () => {
  const f = await approved();
  await f.command(`revoke ${currentRuntime().preflight!.planId}`);
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command(`approve ${currentRuntime().preflight!.planId} none`);
  const state = structuredClone(currentRuntime().preflight!);
  expect(state.phase).toBe("revoked");
  await f.fire("session_tree");
  const writes = f.entries().length;
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).not.toBe("stopped");
  expect(f.entries()).toHaveLength(writes);
  expect(currentRuntime().preflight).toEqual(state);
});

it("observes an unanswered request without mutating runtime, repair state or the journal", async () => {
  const f = await approved();
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const before = JSON.stringify({
    goal: currentRuntime().goal,
    preflight: currentRuntime().preflight,
    repair: currentRuntime().preflightRepair,
    fault: currentRuntime().journalFault,
  });
  const writes = f.entries().length;
  expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toContain("unanswered");
  expect(
    JSON.stringify({
      goal: currentRuntime().goal,
      preflight: currentRuntime().preflight,
      repair: currentRuntime().preflightRepair,
      fault: currentRuntime().journalFault,
    }),
  ).toBe(before);
  expect(f.entries()).toHaveLength(writes);
});

it.each(["defer", "cancel", "no-TUI"])(
  "withdraws permission immediately without UI but does not finalize an unanswered question by revoke alone: %s",
  async (mode) => {
    const f = await approved();
    vi.mocked(f.ctx.ui.select).mockResolvedValue(mode === "cancel" ? undefined : "稍后决定");
    await f.command("approve");
    const state = structuredClone(currentRuntime().preflight!);
    if (mode === "no-TUI") Object.assign(f.ctx, { hasUI: false });
    vi.mocked(f.ctx.ui.select).mockClear();
    await f.command(`revoke ${state.planId}`);
    expect(currentRuntime().preflight?.phase).toBe("revoked");
    expect(currentRuntime().preflight?.approval).toBeUndefined();
    expect(f.ctx.ui.select).not.toHaveBeenCalled();
    if (mode !== "no-TUI")
      expect(f.ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("does not answer"),
        "info",
      );
    expect(currentPreflightRequestIssue(f.ctx, currentRuntime().preflight!)).toContain(
      "unanswered",
    );
    await f.fire("session_tree");
    const writes = f.entries().length;
    await f.command("stop");
    expect(currentRuntime().goal?.current?.phase).not.toBe("stopped");
    expect(f.entries()).toHaveLength(writes);
    const final = currentRuntime().preflight;
    expect(final?.version === 2 && final.permissionRequest).toEqual(
      state.version === 2 && state.permissionRequest,
    );
    expect(currentRuntime().supervisor).toBeUndefined();
  },
);

it.each(["started", "revoked"])(
  "does not archive a stopped %s execution goal while its newer permission request is unanswered",
  async (phase) => {
    const f = await approved();
    vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
    await f.command("start");
    if (phase === "revoked") await f.command(`revoke ${currentRuntime().preflight!.planId}`);
    expect(currentRuntime().preflight?.phase).toBe(phase);
    const id = currentRuntime().goal!.current!.scope.goalRunId;
    vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
    await f.command("approve");
    await f.command("stop");
    expect(currentRuntime().goal?.current?.phase).toBe("stopped");
    const state = structuredClone(currentRuntime().preflight);
    const writes = f.entries().length;
    vi.mocked(f.ctx.ui.select).mockResolvedValue("选项 1");
    await f.command("supervise Must not hide current request");
    expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(id);
    expect(currentRuntime().preflight).toEqual(state);
    expect(f.entries()).toHaveLength(writes);
  },
);

it("does not stop an approved unstarted goal while its newer native permission request is unanswered", async () => {
  const f = await approved();
  const before = structuredClone(currentRuntime().preflight!);
  vi.mocked(f.ctx.ui.select).mockResolvedValue("稍后决定");
  await f.command("approve");
  const state = currentRuntime().preflight!;
  expect(
    state.version === 2 &&
      before.version === 2 &&
      state.permissionRequest?.id !== before.permissionRequest?.id,
  ).toBe(true);
  expect(state.approval).toEqual(before.approval);
  const writes = f.entries().length;
  await f.command("stop");
  expect(currentRuntime().goal?.current?.phase).not.toBe("stopped");
  expect(f.entries()).toHaveLength(writes);
  expect(currentRuntime().preflight).toEqual(state);
  expect(currentRuntime().supervisor).toBeUndefined();
});
