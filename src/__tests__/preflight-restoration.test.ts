import { enterPlanningMode } from "../management-policy";
import { enableSessionScope } from "../scope";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import {
  beginPreflight,
  PREFLIGHT_ENTRY,
  PREFLIGHT_CONTROL_ENTRY,
  preflightDigest,
  restorePreflight,
  currentPreflightRequestIssue,
  type PreflightState,
} from "../preflight";
import { approvePreflight, startApprovedPreflight } from "../preflight-human";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { createSubmitPreflightTool } from "../tools";
import { localProposal, preflightLifecycle } from "./helpers/preflight";

beforeEach(() => {
  resetState();
});
async function proposed(approve = false) {
  const h = preflightLifecycle();
  beginPreflight(h.mock.api, h.ctx, "Local fixture");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue(approve ? "允许上述范围" : "稍后决定");
  await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: localProposal,
    },
    undefined,
    undefined,
    h.ctx,
  );
  return h;
}
function state() {
  const s = structuredClone(currentRuntime().preflight!);
  if (s.version !== 2 || !s.permissionRequest) throw new Error("Native fixture required");
  return s;
}
function restoreWithoutWrites(h: ReturnType<typeof preflightLifecycle>) {
  const count = h.entries.length;
  restorePreflight(h.ctx);
  expect(h.entries).toHaveLength(count);
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
}
it.each(["selection", "predecessor", "omitted", "wrong control"])(
  "rejects changed request %s",
  async (kind) => {
    const h = await proposed(true);
    const s = state();
    const original = s.permissionRequest!;
    if (kind === "selection") original.permissionIds = ["A2"];
    else {
      s.permissionRequest = { ...original, id: randomUUID() };
      if (kind === "predecessor") s.permissionRequest.supersedes = { requestId: randomUUID() };
      if (kind === "wrong control")
        s.permissionRequest.supersedes = { requestId: original.id, controlEntryId: "invented" };
    }
    h.mock.api.appendEntry(PREFLIGHT_ENTRY, s);
    expect(() => {
      restorePreflight(h.ctx);
    }).toThrow(/request/i);
  },
);
it("retires superseded requests and never revives them", async () => {
  const h = await proposed();
  const first = state();
  await approvePreflight(h.mock.api, h.ctx, undefined, "all");
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
    ...state(),
    permissionRequest: first.permissionRequest,
  });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow(/request/i);
});
it("rejects cross-owner reuse and recycled preflight identities", async () => {
  const h = await proposed();
  const first = state();
  beginPreflight(h.mock.api, h.ctx, "Another local goal");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  const planning = structuredClone(currentRuntime().preflight!);
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
    ...first,
    preflightId: planning.preflightId,
    goal: planning.goal,
    planId: `${planning.preflightId}.r1`,
    planDigest: preflightDigest(first.sessionId, planning.goal, localProposal),
  });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow(/request/i);
});
it("rejects an unanswered start request on an unapproved plan", async () => {
  const h = await proposed();
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, { ...state(), startRequest: { id: randomUUID() } });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow(/start request/i);
});
it("retains the used start request through later rejection and approval", async () => {
  const h = await proposed(true);
  await h.command("start");
  const started = state();
  h.chooseDraft(2);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("不允许");
  await approvePreflight(h.mock.api, h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  await approvePreflight(h.mock.api, h.ctx);
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentRuntime().preflight?.started).toEqual(started.started);
  expect(currentRuntime().preflight).toHaveProperty("startRequest", started.startRequest);
});
it.each(["missing", "exact", "later", "contradictory"])(
  "handles %s native C without rollback or writes",
  async (kind) => {
    const h = await proposed();
    const append = h.mock.appendEntry.getMockImplementation() as (
      type: string,
      data: unknown,
    ) => void;
    h.mock.appendEntry.mockImplementation((type, data: any) => {
      if (type === PREFLIGHT_ENTRY && data.approval) throw new Error("C failed");
      append(type, data);
    });
    vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
    const result = await approvePreflight(h.mock.api, h.ctx);
    expect(result.projectionPending).toBe(true);
    h.mock.appendEntry.mockImplementation(append);
    currentRuntime().journalFault = undefined;
    if (kind === "exact") h.mock.api.appendEntry(PREFLIGHT_ENTRY, result.state);
    if (kind === "contradictory")
      h.mock.api.appendEntry(PREFLIGHT_ENTRY, { ...result.state, approval: undefined });
    if (kind === "later") {
      const s = result.state;
      const proposal = { ...localProposal, summary: "A later canonical plan" };
      h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
        ...s,
        revision: 2,
        planId: `${s.preflightId}.r2`,
        proposal,
        planDigest: preflightDigest(s.sessionId, s.goal, proposal),
        phase: "awaiting_authorization",
        approval: undefined,
        permissionRequest: {
          id: randomUUID(),
          permissionIds: ["A1"],
          supersedes: {
            requestId: state().permissionRequest!.id,
            controlEntryId: result.confirmed!.controlEntryId,
          },
        },
      });
    }
    h.mock.sendMessage.mockClear();
    if (kind === "contradictory")
      expect(() => {
        restorePreflight(h.ctx);
      }).toThrow();
    else {
      restoreWithoutWrites(h);
      expect(Boolean(currentRuntime().preflightRepair)).toBe(kind === "missing");
      expect(currentRuntime().preflight?.revision).toBe(kind === "later" ? 2 : 1);
    }
  },
);
function legacy() {
  const h = preflightLifecycle();
  const planning: PreflightState = {
    version: 1,
    sessionId: "test-session",
    preflightId: "pf-history",
    goal: "Local fixture",
    revision: 0,
    phase: "planning",
  };
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, planning);
  const plan: PreflightState = {
    ...planning,
    revision: 1,
    planId: "pf-history.r1",
    proposal: localProposal,
    planDigest: preflightDigest(planning.sessionId, planning.goal, localProposal),
    phase: "awaiting_authorization",
  };
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, plan);
  const createdAt = "2026-01-01T00:00:00.000Z";
  h.mock.api.appendEntry(PREFLIGHT_CONTROL_ENTRY, {
    kind: "approve",
    sessionId: plan.sessionId,
    preflightId: plan.preflightId,
    planId: plan.planId,
    planDigest: plan.planDigest,
    permissionIds: ["A1", "A2"],
    createdAt,
  });
  const approved: PreflightState = {
    ...plan,
    phase: "approved",
    approval: {
      planId: plan.planId!,
      planDigest: plan.planDigest!,
      permissionIds: ["A1", "A2"],
      controlEntryId: h.ctx.sessionManager.getLeafId()!,
      createdAt,
    },
  };
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, approved);
  return { ...h, approved };
}
it("does not close a genuine deferred legacy permission question merely because Start happened later", async () => {
  const h = legacy();
  restorePreflight(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await approvePreflight(h.mock.api, h.ctx, undefined, "all");
  const question = state().permissionRequest!;
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  expect((await startApprovedPreflight(h.mock.api, h.ctx)).status).toBe("started");
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
  expect(state().permissionRequest).toEqual(question);
  await h.command("stop");
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
  const writes = h.entries.length;
  const command = h.mock.registerCommand.mock.calls[0]![1];
  vi.mocked(h.ctx.ui.select).mockResolvedValue("确认提交所选方案");
  await command.handler("supervise Do not hide the legacy question", h.ctx);
  expect(h.entries).toHaveLength(writes);
  expect(currentRuntime().goal?.current).toBeUndefined();
});

it("uses a fresh real question after a deferred legacy Start created metadata-only permission identity", async () => {
  const h = legacy();
  restorePreflight(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后启动");
  await startApprovedPreflight(h.mock.api, h.ctx);
  const bridge = state().permissionRequest!;
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await approvePreflight(h.mock.api, h.ctx, undefined, "all");
  expect(state().permissionRequest!.id).not.toBe(bridge.id);
  expect(state().permissionRequest!.supersedes).toEqual({ requestId: bridge.id });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await startApprovedPreflight(h.mock.api, h.ctx);
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
});

it("does not disguise a real question on an already-started v1 owner as historical conversion metadata", async () => {
  const h = legacy();
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
    ...h.approved,
    phase: "started",
    started: { goal: h.approved.goal, startedAt: "2026-01-01T01:00:00.000Z" },
  });
  restorePreflight(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await approvePreflight(h.mock.api, h.ctx, undefined, "all");
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
  expect(currentRuntime().preflight?.approval).toEqual(h.approved.approval);
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
});

it("keeps an independent persistence hold if the real question cannot follow a legacy conversion", async () => {
  const h = legacy();
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
    ...h.approved,
    phase: "started",
    started: { goal: h.approved.goal, startedAt: "2026-01-01T01:00:00.000Z" },
  });
  restorePreflight(h.ctx);
  const append = h.mock.appendEntry.getMockImplementation() as (
    type: string,
    data: unknown,
  ) => void;
  h.mock.appendEntry.mockImplementation((type, data: any) => {
    if (type === PREFLIGHT_ENTRY && data.permissionRequest?.supersedes?.requestId)
      throw new Error("Question persistence failed");
    append(type, data);
  });
  vi.mocked(h.ctx.ui.select).mockClear();
  await expect(approvePreflight(h.mock.api, h.ctx, undefined, "all")).rejects.toThrow(
    "Question persistence failed",
  );
  expect(currentRuntime().journalFault).toContain("persistence/readback failed");
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  expect(currentRuntime().preflight?.approval).toEqual(h.approved.approval);
});

it("preserves exact historical grant and legal Native Start without assuming its permission field was answered", async () => {
  const h = legacy();
  restorePreflight(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  const result = await startApprovedPreflight(h.mock.api, h.ctx);
  expect(result.status).toBe("started");
  expect(result.state.approval).toEqual(h.approved.approval);
  expect(
    h.entries
      .filter((e) => e.customType === PREFLIGHT_CONTROL_ENTRY)
      .map((e) => (e.data as any).kind),
  ).toEqual(["approve", "start"]);
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentRuntime().preflight?.started).toEqual(result.state.started);
  expect(currentRuntime().preflight?.approval).toEqual(h.approved.approval);
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
});
it.each(["answer", "revoke"])(
  "lets the original owner resolve ambiguous legacy closure by a real %s without rewriting history",
  async (action) => {
    const h = legacy();
    restorePreflight(h.ctx);
    vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
    await startApprovedPreflight(h.mock.api, h.ctx);
    await h.command("stop");
    const before = readFileSync(h.path);
    const old = state();
    expect(currentPreflightRequestIssue(h.ctx, old)).toContain("unanswered");
    if (action === "answer") {
      vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
      const result = await approvePreflight(h.mock.api, h.ctx, undefined, "all");
      expect(result.confirmed?.kind).toBe("approve");
      expect(state().permissionRequest!.id).not.toBe(old.permissionRequest!.id);
      expect(state().permissionRequest!.supersedes).toEqual({
        requestId: old.permissionRequest!.id,
      });
    } else {
      await h.command(`revoke ${old.planId}`);
      expect(currentRuntime().preflight?.approval).toBeUndefined();
      expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain(
        "unanswered",
      );
      h.chooseDraft(2);
      vi.mocked(h.ctx.ui.select).mockResolvedValue("不允许");
      const denied = await approvePreflight(h.mock.api, h.ctx, undefined, "all");
      expect(denied.confirmed?.kind).toBe("reject");
      expect(currentRuntime().preflight?.approval).toBeUndefined();
      await h.command(`revoke ${old.planId}`);
    }
    expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toBeUndefined();
    expect(currentRuntime().preflight?.started).toEqual(old.started);
    expect(readFileSync(h.path).subarray(0, before.length).equals(before)).toBe(true);
    // Closing the original question is not itself a positive off/quiescence observation.
    await h.command("disable");
    expect(currentRuntime().management).toMatchObject({ mode: "off", state: "active" });
    h.mock.sendMessage.mockClear();
    restoreWithoutWrites(h);
    expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toBeUndefined();
    vi.mocked(h.ctx.ui.select).mockResolvedValue("确认提交所选方案");
    const command = h.mock.registerCommand.mock.calls[0]![1];
    await command.handler("supervise After actual owner closure", h.ctx);
    expect(currentRuntime().goal?.current?.scope.goalRunId).toBeTruthy();
  },
);

it("does not reuse an unverified legacy-start permission bridge for a newer deferred permission question", async () => {
  const h = legacy();
  restorePreflight(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await startApprovedPreflight(h.mock.api, h.ctx);
  const before = structuredClone(currentRuntime().preflight!);
  expect(before.version).toBe(2);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await approvePreflight(h.mock.api, h.ctx, undefined, "all");
  const after = currentRuntime().preflight!;
  expect(
    after.version === 2 &&
      before.version === 2 &&
      after.permissionRequest?.id !== before.permissionRequest?.id,
  ).toBe(true);
  expect(after.approval).toEqual(before.approval);
  expect(currentPreflightRequestIssue(h.ctx, after)).toContain("unanswered");
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain("unanswered");
});

it.each([true, false])(
  "reads the old native started shape only with validated v1 trace, without granting request closure: %s",
  (traced) => {
    const h = legacy();
    const started = { goal: h.approved.goal, startedAt: "2026-01-01T01:00:00.000Z" };
    if (traced)
      h.mock.api.appendEntry(PREFLIGHT_ENTRY, { ...h.approved, phase: "started", started });
    h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
      ...h.approved,
      version: 2,
      phase: "started",
      started,
      permissionRequest: {
        id: randomUUID(),
        permissionIds: ["A1", "A2"],
        supersedes: { legacyControlEntryId: h.approved.approval!.controlEntryId },
      },
    });
    if (traced) {
      restoreWithoutWrites(h);
      expect(currentRuntime().preflight?.approval).toEqual(h.approved.approval);
      expect(currentPreflightRequestIssue(h.ctx, currentRuntime().preflight!)).toContain(
        "unanswered",
      );
    } else
      expect(() => {
        restorePreflight(h.ctx);
      }).toThrow();
  },
);
it("does not accept conflicting v1 snapshots inside mixed history", () => {
  const h = legacy();
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, {
    ...h.approved,
    approval: { ...h.approved.approval!, permissionIds: ["A1"] },
  });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow();
});
it("rejects native-to-legacy downgrade", async () => {
  const h = await proposed(true);
  const s = state();
  Reflect.deleteProperty(s, "permissionRequest");
  Reflect.deleteProperty(s, "startRequest");
  h.mock.api.appendEntry(PREFLIGHT_ENTRY, { ...s, version: 1 });
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow(/downgrade/i);
});

it("replaces a cleared deferred start using its exact unanswered predecessor", async () => {
  const h = await proposed(true);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后启动");
  await startApprovedPreflight(h.mock.api, h.ctx);
  const first = state().startRequest!;
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await approvePreflight(h.mock.api, h.ctx, undefined, "all");
  expect(state().startRequest).toBeUndefined();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后启动");
  await startApprovedPreflight(h.mock.api, h.ctx);
  expect(state().startRequest).toMatchObject({ supersedes: { requestId: first.id } });
  expect(state().startRequest!.id).not.toBe(first.id);
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
});
it("validates legacy approval at the original native start prefix before later revoke", async () => {
  const h = legacy();
  restorePreflight(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  expect((await startApprovedPreflight(h.mock.api, h.ctx)).status).toBe("started");
  await h.command(`revoke ${h.approved.planId}`);
  h.mock.sendMessage.mockClear();
  restoreWithoutWrites(h);
  expect(currentRuntime().preflight?.phase).toBe("revoked");
});
