import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { submitAndPresentPreflight } from "../preflight-human";
import { currentRuntime } from "../runtime";
import { createWriteTasksTool, createCompileTasksTool, createGetReadyTasksTool } from "../tools";
import { resetState, setBoard } from "../state";
import { setSessionScopeEnabled } from "../scope";
import { supervisorState } from "../supervisor";
import { activeBoard, BOUNDARY, deferred, lifecycle } from "./helpers/lifecycle";

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(true);
  setBoard(activeBoard());
});
function expectedUsage(kind: string) {
  if (kind === "unavailable")
    return { providerCalls: 0, unknownUsageCalls: 0, knownTokens: 0, knownCost: 0 };
  if (["transport-error", "missing-usage", "invalid-usage", "late-abort"].includes(kind))
    return { providerCalls: 1, unknownUsageCalls: 1, knownTokens: 0, knownCost: 0 };
  return { providerCalls: 1, unknownUsageCalls: 0, knownTokens: 17, knownCost: 0.25 };
}
it.each([
  "invalid-json",
  "unavailable",
  "late-stop",
  "late-new-goal",
  "late-leaf",
  "late-abort",
  "failed-with-usage",
  "transport-error",
  "missing-usage",
  "invalid-usage",
])(
  "restores scoped accounting for %s without inferring calls from reviews or charging twice",
  async (kind) => {
    const { advisorUsageFor } = await import("../advisor-calls");
    const f = await goalFixture();
    try {
      vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
      await f.command("supervise Scoped synthetic usage ledger");
      await f.fire("agent_start");
      vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
      await submitAndPresentPreflight(
        f.api,
        f.ctx,
        "usage-proposal",
        currentRuntime().preflight!.preflightId,
        localProposal,
      );
      await f.fire("agent_settled", { type: "agent_settled", aborted: false });
      vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
      await f.command("start");
      const scope = currentRuntime().goal!.current!.scope;
      const owner = {
        sessionId: "test-session",
        goalKey: scope.goalRunId,
        goalRunId: scope.goalRunId,
        lifecycleCommitId: scope.lifecycleCommitId,
      };
      await createWriteTasksTool(f.api).execute(
        "write",
        {
          mode: "replace",
          phases: [
            {
              title: "One",
              tasks: [{ title: "Verify", prompt: "Synthetic bounded check", profile: "main" }],
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
      const response = structuredClone(fauxAssistantMessage("invalid JSON"));
      response.usage.input = 11;
      response.usage.output = 6;
      response.usage.totalTokens = 17;
      response.usage.cost.total = 0.25;
      if (kind === "failed-with-usage")
        Object.assign(response, {
          stopReason: "error",
          errorMessage: "synthetic provider failure",
        });
      if (kind === "missing-usage") Object.assign(response, { usage: undefined });
      if (kind === "invalid-usage") response.usage.totalTokens = Infinity;
      const late = kind.startsWith("late-");
      const requested = deferred<boolean>();
      const returned = deferred<typeof response>();
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => (kind === "unavailable" ? undefined : f.ctx.model),
          streamSimple: () => {
            requested.resolve(true);
            if (kind === "transport-error") throw Error("Synthetic transport failure");
            return { result: async () => (late ? returned.promise : response) };
          },
        },
      });
      const expected = { ...expectedUsage(kind), pendingCalls: 0 };
      const review = f.fire("agent_before_settle", BOUNDARY);
      if (late) {
        await requested.promise;
        if (kind === "late-leaf")
          f.api.appendEntry("synthetic-unrelated-observation", { value: "external leaf change" });
        else await f.command("stop");
        if (kind === "late-new-goal") {
          vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
          await f.command("supervise Distinct new synthetic goal");
          await f.fire("agent_start");
          vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
          await submitAndPresentPreflight(
            f.api,
            f.ctx,
            "next-usage-proposal",
            currentRuntime().preflight!.preflightId,
            localProposal,
          );
          await f.fire("agent_settled", { type: "agent_settled", aborted: false });
          vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
          await f.command("start");
        }
        if (kind === "late-abort") returned.reject(new Error("Synthetic aborted request"));
        else returned.resolve(response);
      }
      await review;
      // Stop settles the control boundary before the late model callback; await its observed result.
      if (late)
        await vi.waitFor(
          () => {
            expect(advisorUsageFor(owner)).toMatchObject(expected);
          },
          { timeout: 1000, interval: 5 },
        );
      expect(advisorUsageFor(owner)).toMatchObject(expected);
      if (["late-stop", "late-abort"].includes(kind))
        expect(currentRuntime().supervisor?.status).toBe("stopped");
      if (kind === "late-new-goal")
        expect(supervisorState()).toMatchObject({ status: "active", tokens: 0, cost: 0 });
      if (kind === "late-leaf")
        expect(supervisorState()).toMatchObject({
          status: "fault",
          reason: expect.stringContaining("context changed"),
        });
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(advisorUsageFor(owner)).toMatchObject(expected);
      expect(currentRuntime().supervisor).toMatchObject(
        kind === "late-new-goal"
          ? { tokens: 0, cost: 0 }
          : { tokens: expected.knownTokens, cost: expected.knownCost },
      );
      const count = f.entries().length;
      await f.command("status");
      const status = vi.mocked(f.ctx.ui.notify).mock.calls.at(-1)?.[0] ?? "";
      const current =
        kind === "late-new-goal" ? { providerCalls: 0, unknownUsageCalls: 0 } : expected;
      expect(status).toContain(`Advisor provider calls: ${current.providerCalls} tracked`);
      expect(status).toContain(`unknown usage: ${current.unknownUsageCalls}`);
      expect(status).toContain("known cost");
      expect(f.entries()).toHaveLength(count);
    } finally {
      f.restoreHost();
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);
it("holds an inconsistent same-owner mutation barrier instead of leaving a review in progress", async () => {
  const h = lifecycle();
  const streamSimple = vi.fn(() => ({ result: async () => fauxAssistantMessage("unused") }));
  Object.assign(h.ctx, {
    modelRegistry: {
      find: () => {
        supervisorState()!.epoch++;
        return h.ctx.model;
      },
      streamSimple,
    },
  });
  await h.command("supervise Fixed authorized same-owner work");
  await h.fire("agent_before_settle", BOUNDARY);
  expect(streamSimple).not.toHaveBeenCalled();
  // The synthetic epoch inconsistency also triggers the stronger receipt identity/version hold.
  expect(supervisorState()).toMatchObject({
    status: "fault",
    reason: expect.stringContaining("changed"),
  });
});
it("does not send a provider request after the pinned model lookup changes the Session", async () => {
  const h = lifecycle();
  const streamSimple = vi.fn(() => ({ result: async () => fauxAssistantMessage("unused") }));
  Object.assign(h.ctx, {
    modelRegistry: {
      find: () => {
        vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("different-session");
        return h.ctx.model;
      },
      streamSimple,
    },
  });
  await h.command("supervise Fixed authorized old session work");
  await h.fire("agent_before_settle", BOUNDARY);
  expect(streamSimple).not.toHaveBeenCalled();
});
it("accounts a returned response before rejecting invalid JSON", async () => {
  const h = lifecycle();
  const response = structuredClone(fauxAssistantMessage("not valid JSON"));
  response.usage.input = 11;
  response.usage.output = 6;
  response.usage.totalTokens = 17;
  response.usage.cost.total = 0.25;
  Object.assign(h.ctx, {
    modelRegistry: {
      find: () => h.ctx.model,
      streamSimple: () => ({ result: async () => response }),
    },
  });
  await h.command("supervise Finish authorized synthetic work");
  await h.fire("agent_before_settle", BOUNDARY);
  expect(supervisorState()).toMatchObject({
    status: "fault",
    reviews: 1,
    tokens: 17,
    cost: 0.25,
    reason: "Supervisor returned invalid JSON",
  });
});
it("accounts returned model consumption even when the host rejects a guide in place of next_batch", async () => {
  const h = lifecycle();
  const response = structuredClone(
    fauxAssistantMessage(
      JSON.stringify({
        action: "guide",
        message: "Inspect work",
        taskIds: ["t-1.1"],
        evidenceRefs: [],
      }),
    ),
  );
  response.usage.input = 11;
  response.usage.output = 6;
  response.usage.totalTokens = 17;
  response.usage.cost.total = 0.25;
  Object.assign(h.ctx, {
    modelRegistry: {
      find: () => h.ctx.model,
      streamSimple: () => ({ result: async () => response }),
    },
  });
  await h.command("supervise Finish the authorized synthetic work");
  expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
  expect(supervisorState()).toMatchObject({
    status: "fault",
    reviews: 2,
    tokens: 34,
    cost: 0.5,
    reason: expect.stringContaining("must use next_batch"),
  });
});
