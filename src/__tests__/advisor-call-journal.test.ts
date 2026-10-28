import { expect, it, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { goalFixture, completeGoalProposal } from "./helpers/goal";
import { submitAndPresentPreflight } from "../preflight-human";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { supervisorState } from "../supervisor";
import { advisorUsageFor, beginAdvisorCall, observeAdvisorCall } from "../advisor-calls";

async function context() {
  resetState();
  const f = await goalFixture({ gitWorkspace: true });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
  await f.command("supervise Synthetic accounting protocol");
  await f.fire("agent_start");
  vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
  await submitAndPresentPreflight(
    f.api,
    f.ctx,
    "call-proposal",
    currentRuntime().preflight!.preflightId,
    await completeGoalProposal(f),
  );
  await f.fire("agent_settled", { type: "agent_settled", aborted: false });
  vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
  await f.command("start");
  return f;
}
it("charges extra calls in one review attempt without pretending they are new review admissions", async () => {
  const f = await context();
  try {
    const reserved = { ...supervisorState()!, reviews: 1 };
    const first = beginAdvisorCall(f.api, f.ctx, reserved, "First view", {
      attemptId: "shared-review-attempt",
    });
    observeAdvisorCall(f.api, f.ctx, first, {
      status: "returned",
      usage: fauxAssistantMessage("first").usage,
    });
    const second = beginAdvisorCall(f.api, f.ctx, reserved, "Requested detail", {
      attemptId: "shared-review-attempt",
    });
    observeAdvisorCall(f.api, f.ctx, second, {
      status: "returned",
      usage: fauxAssistantMessage("second").usage,
    });
    const third = beginAdvisorCall(
      f.api,
      f.ctx,
      { ...reserved, reviews: 2 },
      "Next actual review",
      { attemptId: "next-review-attempt" },
    );
    const starts = currentRuntime().controlJournal?.advisorFacts?.filter(
      (record) => record.data.kind === "advisor-call-started",
    );
    expect(
      starts?.map((record) =>
        record.data.kind === "advisor-call-started" ? record.data.budgetSlot : undefined,
      ),
    ).toEqual([1, 2, 3]);
    expect(reserved.reviews).toBe(1);
    expect(advisorUsageFor(third.owner)).toMatchObject({ providerCalls: 3, pendingCalls: 1 });
  } finally {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it("keeps the original 40-slot ceiling and rejects duplicate reservations before another fact write", async () => {
  const f = await context();
  try {
    const state = { ...supervisorState()!, reviews: 40 };
    const call = beginAdvisorCall(f.api, f.ctx, state, "Last reserved synthetic request");
    const before = readFileSync(f.path);
    expect(() => beginAdvisorCall(f.api, f.ctx, state, "Duplicate slot")).toThrow();
    expect(() =>
      beginAdvisorCall(f.api, f.ctx, { ...state, reviews: 41 }, "Over budget"),
    ).toThrow();
    expect(readFileSync(f.path)).toEqual(before);
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(advisorUsageFor(call.owner)).toMatchObject({ providerCalls: 1, unknownUsageCalls: 1 });
  } finally {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it.each(["session", "path"])(
  "does not send an old call observation to a changed %s",
  async (kind) => {
    const f = await context();
    try {
      const call = beginAdvisorCall(
        f.api,
        f.ctx,
        { ...supervisorState()!, reviews: 1 },
        "Fixed synthetic request",
      );
      const before = readFileSync(f.path);
      if (kind === "session")
        Object.assign(f.ctx.sessionManager, { getSessionId: () => "foreign-session" });
      else Object.assign(f.ctx.sessionManager, { getSessionFile: () => f.path + ".different" });
      expect(() =>
        observeAdvisorCall(f.api, f.ctx, call, {
          status: "returned",
          usage: fauxAssistantMessage("fixed").usage,
        }),
      ).toThrow("different Session");
      expect(readFileSync(f.path)).toEqual(before);
      expect(advisorUsageFor(call.owner)).toMatchObject({ providerCalls: 1, unknownUsageCalls: 1 });
    } finally {
      f.restoreHost();
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);
it.each(["missing", "negative-input", "nan-cost", "unsafe-total", "overflow"])(
  "records %s usage as unknown rather than a complete zero",
  async (kind) => {
    const f = await context();
    try {
      const baseline = kind === "overflow" ? Number.MAX_SAFE_INTEGER : 0;
      const call = beginAdvisorCall(
        f.api,
        f.ctx,
        { ...supervisorState()!, tokens: baseline, reviews: 1 },
        "Fixed synthetic request",
      );
      const usage = structuredClone(fauxAssistantMessage("fixed").usage);
      usage.input = 11;
      usage.output = 6;
      usage.totalTokens = 17;
      usage.cost.total = 0.25;
      if (kind === "negative-input") usage.input = -1;
      if (kind === "nan-cost") usage.cost.total = NaN;
      if (kind === "unsafe-total") usage.totalTokens = Number.MAX_SAFE_INTEGER + 1;
      expect(advisorUsageFor(call.owner)).toMatchObject({ pendingCalls: 1 });
      observeAdvisorCall(f.api, f.ctx, call, {
        status: "returned",
        usage: kind === "missing" ? undefined : usage,
      });
      expect(advisorUsageFor(call.owner)).toMatchObject({
        providerCalls: 1,
        unknownUsageCalls: 1,
        knownTokens: baseline,
        knownCost: 0,
        pendingCalls: 0,
      });
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(advisorUsageFor(call.owner)).toMatchObject({
        providerCalls: 1,
        unknownUsageCalls: 1,
        knownTokens: baseline,
        knownCost: 0,
      });
    } finally {
      f.restoreHost();
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);
it.each(["before", "memory", "after"] as const)(
  "holds an uncertain %s observation write and restores only confirmed facts",
  async (failure) => {
    const f = await context();
    try {
      const call = beginAdvisorCall(
        f.api,
        f.ctx,
        { ...supervisorState()!, reviews: 1 },
        "Fixed synthetic request",
      );
      const usage = structuredClone(fauxAssistantMessage("fixed").usage);
      usage.input = 11;
      usage.output = 6;
      usage.totalTokens = 17;
      usage.cost.total = 0.25;
      let attempts = 0;
      f.fail((type, data) => {
        if (
          type === "continuous-tasks:control-facts" &&
          (data as { kind?: string }).kind === "advisor-call-observed"
        ) {
          attempts++;
          return failure;
        }
        return undefined;
      });
      expect(() => observeAdvisorCall(f.api, f.ctx, call, { status: "returned", usage })).toThrow(
        "CONTROL_JOURNAL_UNCERTAIN",
      );
      expect(currentRuntime().journalFault).toBeDefined();
      expect(() => observeAdvisorCall(f.api, f.ctx, call, { status: "returned", usage })).toThrow();
      expect(attempts).toBe(1);
      expect(advisorUsageFor(call.owner)).toMatchObject({
        providerCalls: 1,
        unknownUsageCalls: 1,
        knownTokens: 0,
      });
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(advisorUsageFor(call.owner)).toMatchObject({
        providerCalls: 1,
        unknownUsageCalls: failure === "after" ? 0 : 1,
        knownTokens: failure === "after" ? 17 : 0,
      });
    } finally {
      f.restoreHost();
      rmSync(f.dir, { recursive: true, force: true });
    }
  },
);
it("retains a conflicting response diagnostic across restore without charging the call twice", async () => {
  const f = await context();
  try {
    const call = beginAdvisorCall(
      f.api,
      f.ctx,
      { ...supervisorState()!, reviews: 1 },
      "Fixed synthetic request",
    );
    const usage = structuredClone(fauxAssistantMessage("fixed").usage);
    usage.input = 11;
    usage.output = 6;
    usage.totalTokens = 17;
    usage.cost.total = 0.25;
    observeAdvisorCall(f.api, f.ctx, call, { status: "returned", usage });
    const conflict = { ...usage, totalTokens: 18 };
    expect(() =>
      observeAdvisorCall(f.api, f.ctx, call, { status: "returned", usage: conflict }),
    ).toThrow("Conflicting Advisor observation");
    expect(advisorUsageFor(call.owner)).toMatchObject({
      providerCalls: 1,
      knownTokens: 17,
      knownCost: 0.25,
      conflictedCalls: 1,
    });
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(advisorUsageFor(call.owner)).toMatchObject({
      providerCalls: 1,
      knownTokens: 17,
      knownCost: 0.25,
      conflictedCalls: 1,
    });
  } finally {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
it("does not recount an identical observed call when adding it twice would overflow", async () => {
  const f = await context();
  try {
    const call = beginAdvisorCall(
      f.api,
      f.ctx,
      { ...supervisorState()!, reviews: 1 },
      "Fixed synthetic request",
    );
    const usage = structuredClone(fauxAssistantMessage("fixed").usage);
    usage.input = Number.MAX_SAFE_INTEGER;
    usage.totalTokens = Number.MAX_SAFE_INTEGER;
    observeAdvisorCall(f.api, f.ctx, call, { status: "returned", usage });
    expect(advisorUsageFor(call.owner)).toMatchObject({
      providerCalls: 1,
      knownTokens: Number.MAX_SAFE_INTEGER,
      unknownUsageCalls: 0,
    });
    expect(() =>
      observeAdvisorCall(f.api, f.ctx, call, { status: "returned", usage }),
    ).not.toThrow();
    expect(advisorUsageFor(call.owner)).toMatchObject({
      providerCalls: 1,
      knownTokens: Number.MAX_SAFE_INTEGER,
      unknownUsageCalls: 0,
    });
  } finally {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
});
