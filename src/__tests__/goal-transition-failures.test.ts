import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { resetState, getBoard, setBoard, reconstructState } from "../state";
import { currentRuntime } from "../runtime";
import {
  inspectGoalTransition,
  requestGoalTransition,
  restoreGoalLifecycle,
} from "../goal-lifecycle";
import { journalDigest } from "../human-journal";

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
async function fixture() {
  const f = await goalFixture();
  fixtures.push(f);
  return f;
}
const request = { goal: "Independent new goal", intent: "supervise" as const };

it.each([
  "busy",
  "queued",
  "decision",
  "external",
  "fault",
  "repair",
  "receipt-pending",
  "rpc",
  "secret",
])("does not archive or dispatch through the real %s gate", async (kind) => {
  const f = await fixture();
  if (kind === "busy") vi.mocked(f.ctx.isIdle).mockReturnValue(false);
  if (kind === "queued") vi.mocked(f.ctx.hasPendingMessages).mockReturnValue(true);
  if (kind === "decision") {
    const board = getBoard();
    board.decision = {
      id: "choice",
      taskId: "old-task",
      question: "Choose",
      whyUserOwned: "Business",
      createdAt: "now",
      spec: { version: 1, kind: "choice" },
      options: ["A"],
    };
    setBoard(board);
  }
  if (kind === "external") {
    const board = getBoard();
    board.tasks[0]!.executionRef = { source: "workflow", runId: "unresolved" };
    setBoard(board);
  }
  if (kind === "fault") currentRuntime().journalFault = "Independent integrity failure";
  if (kind === "repair")
    currentRuntime().boardRepair = {
      sessionId: "test-session",
      controlEntryId: "retained",
      projectedDigest: "a".repeat(64),
      faultMessage: "Projection pending",
      ownsJournalFault: false,
    };
  if (kind === "receipt-pending")
    currentRuntime().receiptStore!.prepareToolCapture(
      { type: "tool_call", toolName: "write", toolCallId: "unresolved", input: {} },
      [],
      false,
    );
  if (kind === "rpc") Object.assign(f.ctx, { mode: "rpc" });
  const count = f.entries().length;
  const before = getBoard();
  const result = await requestGoalTransition(
    f.api,
    f.ctx,
    kind === "secret" ? { ...request, goal: "api_key=private-value-12345678" } : request,
  );
  expect(result.status).toBe("blocked");
  expect(f.entries()).toHaveLength(count);
  expect(getBoard()).toEqual(before);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it.each([
  "active-board",
  "supervisor-held",
  "supervisor-pending",
  "foreign-supervisor",
  "unfinished-preflight",
  "unbound-revoked",
  "preflight-repair",
  "missing-model",
])("preserves an independently %s owner rather than archiving it", async (kind) => {
  const f = await fixture();
  const runtime = currentRuntime();
  if (kind === "active-board") {
    const board = getBoard();
    board.workflowStatus = "active";
    setBoard(board);
  }
  if (kind === "supervisor-held") runtime.supervisor!.status = "paused";
  if (kind === "supervisor-pending") runtime.supervisor!.pending = true;
  if (kind === "foreign-supervisor") runtime.supervisor!.sessionId = "foreign";
  if (kind === "unfinished-preflight" || kind === "unbound-revoked")
    runtime.preflight = {
      version: 2,
      sessionId: "test-session",
      preflightId: "independent-pf",
      goal: "Independent retained request",
      revision: 0,
      phase: kind === "unbound-revoked" ? "revoked" : "planning",
    };
  if (kind === "preflight-repair")
    runtime.preflightRepair = {
      sessionId: "test-session",
      controlEntryId: "retained",
      projectedDigest: "a".repeat(64),
      faultMessage: "Independent projection",
      ownsJournalFault: false,
    };
  if (kind === "missing-model") Object.assign(f.ctx, { model: undefined });
  const count = f.entries().length;
  const board = getBoard();
  expect((await requestGoalTransition(f.api, f.ctx, request)).status).toBe("blocked");
  expect(f.entries()).toHaveLength(count);
  expect(getBoard()).toEqual(board);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it.each(["选项 2", "稍后决定（不提交）"])(
  "leaves old format/state unchanged after native %s",
  async (selected) => {
    const f = await fixture();
    vi.mocked(f.ctx.ui.select).mockResolvedValue(selected);
    const count = f.entries().length;
    const result = await requestGoalTransition(f.api, f.ctx, request);
    expect(["cancelled", "deferred"]).toContain(result.status);
    expect(f.entries()).toHaveLength(count);
    expect(getBoard()).toEqual(f.old);
  },
);

it.each([
  ["A", "before"],
  ["A", "memory"],
  ["A", "after"],
  ["B", "before"],
  ["B", "memory"],
  ["B", "after"],
  ["C", "before"],
  ["C", "memory"],
  ["C", "after"],
] as const)(
  "holds unconfirmed runtime at %s/%s and reopens from actual committed bytes without replay",
  async (stage, mode) => {
    const f = await fixture();
    const old = journalDigest(f.oldEntry);
    f.fail((type, data) => {
      const value = data as { version?: number; kind?: string; frame?: { owner?: string } };
      const matches =
        stage === "B"
          ? type === "continuous-tasks:human-readback" && value.frame?.owner === "goal"
          : type === "continuous-tasks:supervisor" &&
            value.version === 5 &&
            value.kind === (stage === "A" ? "transition-control" : "transition-committed");
      return matches ? mode : undefined;
    });
    expect((await requestGoalTransition(f.api, f.ctx, request)).status).toBe("projection-pending");
    expect(getBoard()).toEqual(f.old);
    expect(currentRuntime().supervisor?.status).toBe("stopped");
    expect(f.sendMessage).not.toHaveBeenCalled();
    f.fail(undefined);
    f.reload();
    resetState();
    const reopened = restoreGoalLifecycle(f.api, f.ctx);
    const committed = stage === "C" || (stage === "B" && mode === "after");
    expect(Boolean(reopened?.current)).toBe(committed);
    if (committed) {
      expect(reopened?.current?.phase).toBe("planning-interrupted");
      expect(getBoard().tasks).toEqual([]);
    } else {
      expect(reconstructState(f.ctx).tasks).toEqual(f.old.tasks);
      expect(reopened?.pending?.confirmed ?? false).toBe(false);
    }
    expect(
      f.entries().filter((e) => (e.data as { kind?: string }).kind === "transition-committed"),
    ).toHaveLength(committed ? 1 : 0);
    expect(journalDigest(f.entries().find((e) => e.id === f.oldEntry.id))).toBe(old);
    expect(f.sendMessage).not.toHaveBeenCalled();
  },
);

it("rejects a changed owner source during native selection without writing archive authority", async () => {
  const f = await fixture();
  vi.mocked(f.ctx.ui.select).mockImplementation(async () => {
    const board = getBoard();
    board.generation++;
    board.pauseReason = "Changed by user";
    f.api.appendEntry("continuous-tasks:snapshot", board);
    setBoard(board);
    return "确认提交所选方案";
  });
  expect((await requestGoalTransition(f.api, f.ctx, request)).status).toBe("deferred");
  expect(f.entries().some((e) => (e.data as { version?: number }).version === 5)).toBe(false);
  expect(f.sendMessage).not.toHaveBeenCalled();
});

it("requires a fresh native answer to supersede A-only while retaining its exact chosen GoalRun seed", async () => {
  const f = await fixture();
  f.fail((type, data) =>
    type === "continuous-tasks:supervisor" &&
    (data as { kind?: string }).kind === "transition-control"
      ? "after"
      : undefined,
  );
  expect((await requestGoalTransition(f.api, f.ctx, request)).status).toBe("projection-pending");
  const first = f
    .entries()
    .find((e) => (e.data as { kind?: string }).kind === "transition-control")!;
  const chosen = first.data as { seed: { goalRunId: string }; transitionId: string };
  f.fail(undefined);
  f.reload();
  resetState();
  await f.fire("session_tree");
  expect(currentRuntime().goal?.pending?.confirmed).toBe(false);
  expect((await requestGoalTransition(f.api, f.ctx, request)).status).toBe("committed-planning");
  expect(currentRuntime().goal?.current?.scope.goalRunId).toBe(chosen.seed.goalRunId);
  expect(
    f.entries().filter((e) => (e.data as { kind?: string }).kind === "transition-control"),
  ).toHaveLength(2);
  expect(
    f.entries().filter((e) => (e.data as { kind?: string }).kind === "transition-committed"),
  ).toHaveLength(1);
  expect(
    f
      .entries()
      .some(
        (e) =>
          e.customType === "continuous-tasks:human-readback" &&
          (e.data as { frame: { requestId: string } }).frame.requestId === chosen.transitionId,
      ),
  ).toBe(false);
  expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
});

it("refuses unintegrated wire4 rather than interpreting it as the new lifecycle", async () => {
  const f = await fixture();
  f.api.appendEntry("continuous-tasks:supervisor", { version: 4, sessionId: "test-session" });
  expect(inspectGoalTransition(f.ctx, request)).toMatchObject({
    status: "blocked",
    reason: expect.stringContaining("unsupported Supervisor wire version"),
  });
});
