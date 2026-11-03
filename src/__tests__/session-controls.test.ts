import { beforeEach, expect, it, vi } from "vitest";
import { beginPreflight } from "../preflight";
import { submitAndPresentPreflight } from "../preflight-human";
import { enterPlanningMode } from "../management-policy";
import { enableSessionScope } from "../scope";
import { currentRuntime } from "../runtime";
import { resetState, getBoardRef } from "../state";
import { holdSupervisor } from "../supervisor";
import {
  continuationCandidate,
  humanStateStamp,
  retainHumanDelivery,
  resumeBoardControl,
} from "../session-controls";
import { preflightLifecycle, localProposal } from "./helpers/preflight";
import { createWriteTasksTool, createCompileTasksTool } from "../tools";

beforeEach(resetState);
async function started() {
  const h = preflightLifecycle();
  const pref = beginPreflight(h.mock.api, h.ctx, "Shared control fixture");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  expect(
    (await submitAndPresentPreflight(h.mock.api, h.ctx, "submit", pref.preflightId, localProposal))
      .status,
  ).toBe("approved");
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeDefined();
  return h;
}
it("returns the original continuation without dispatch and rejects a changed source or payload", async () => {
  const h = await started();
  const sends = h.mock.sendMessage.mock.calls.length;
  const candidate = continuationCandidate(h.ctx)!;
  expect(candidate.message.customType).toBe("continuous-tasks:continue");
  expect(candidate.current()).toBe(true);
  expect(h.mock.sendMessage.mock.calls).toHaveLength(sends);
  currentRuntime().supervisor!.tokens++;
  expect(candidate.current()).toBe(false);
});
it.each(["busy", "pending", "journal", "hold", "external", "budget", "reference", "decision"])(
  "preserves the original %s continuation gate",
  async (kind) => {
    const h = await started();
    const state = currentRuntime().supervisor!;
    if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    if (kind === "pending") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    if (kind === "journal") currentRuntime().journalFault = "original unknown";
    if (kind === "hold") state.status = "paused";
    if (kind === "external")
      state.externalWait = {
        boardDigest: "a".repeat(64),
        epoch: 0,
        deadlineAt: Date.now() + 1000,
        observedAt: Date.now(),
        phase: "active",
        refs: [{ taskId: "t", source: "pi-subagents", runId: "r" }],
      };
    if (kind === "budget") state.reviews = 100000;
    if (kind === "reference") {
      const board = currentRuntime().board;
      board.tasks.push({
        id: "t",
        title: "t",
        prompt: "t",
        profile: "main",
        phase: 1,
        dependencies: [],
        status: "ready",
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        executionRef: { source: "pi-subagents", runId: "external" },
      });
    }
    if (kind === "decision") currentRuntime().board.workflowStatus = "waiting_for_decision";
    expect(continuationCandidate(h.ctx)).toBeUndefined();
  },
);
it("keeps saved control and spent counters on an unstarted delivery and never overwrites an existing user hold", async () => {
  const h = await started();
  const start = structuredClone(currentRuntime().preflight!.started);
  const state = currentRuntime().supervisor!;
  state.tokens = 19;
  state.cost = 2;
  state.reviews = 3;
  state.continuations = 4;
  const before = [state.tokens, state.cost, state.reviews, state.continuations];
  const stamp = humanStateStamp(h.ctx);
  retainHumanDelivery(h.mock.api, h.ctx, () => false, { status: "unknown", actionId: "x" });
  expect(humanStateStamp(h.ctx)).toBe(stamp);
  retainHumanDelivery(h.mock.api, h.ctx, () => true, { status: "cancelled", actionId: "x" });
  expect(currentRuntime().preflight!.started).toEqual(start);
  expect([state.tokens, state.cost, state.reviews, state.continuations]).toEqual(before);
  expect(state.status).toBe("paused");
  state.holdCause = "user_pause";
  state.reason = "original user pause";
  retainHumanDelivery(h.mock.api, h.ctx, () => true, { status: "unknown", actionId: "x" });
  expect(state.reason).toBe("original user pause");
  expect(state.holdCause).toBe("user_pause");
});
it("uses the original controller hold for unknown delivery and preparation failure", async () => {
  const h = await started();
  retainHumanDelivery(h.mock.api, h.ctx, () => true, { status: "prepare_failed" });
  expect(currentRuntime().supervisor?.status).toBe("fault");
  const count = h.mock.appendEntry.mock.calls.length;
  retainHumanDelivery(h.mock.api, h.ctx, () => true, {
    status: "started",
    actionId: "a",
    runId: "r",
    sessionId: "test-session",
  });
  expect(h.mock.appendEntry.mock.calls).toHaveLength(count);
});
it("shares normal joint resume without dispatching and preserves spent usage", async () => {
  const h = await started();
  const result = await createWriteTasksTool(h.mock.api).execute(
    "board",
    {
      mode: "replace",
      phases: [{ title: "Owned", tasks: [{ title: "Work", prompt: "Work", profile: "main" }] }],
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const compiled = await createCompileTasksTool(h.mock.api).execute(
    "compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
  await h.command("pause kept");
  const before = currentRuntime().supervisor!;
  before.tokens = 12;
  const sends = h.mock.sendMessage.mock.calls.length;
  expect(resumeBoardControl(h.mock.api, h.ctx)).toBe("resumed");
  expect(getBoardRef().workflowStatus).toBe("active");
  expect(currentRuntime().supervisor!.tokens).toBe(12);
  expect(h.mock.sendMessage.mock.calls).toHaveLength(sends);
  holdSupervisor(h.mock.api, h.ctx, "fault", "strong original", "review_failed");
});
