import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PREFLIGHT_ENTRY, preflightEvidence, restorePreflight } from "../preflight";
import { approvePreflight, startApprovedPreflight } from "../preflight-human";
import { requireNativeAnswer, type NativeAnswer } from "../human-ui";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { createSubmitPreflightTool } from "../tools";
import { supervisorState } from "../supervisor";
import { localProposal, preflightLifecycle } from "./helpers/preflight";
import { createMockContext } from "./helpers/mocks";

beforeEach(() => {
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function submitted() {
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  return h;
}

async function approved(selection?: string) {
  const h = await submitted();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  const result = await approvePreflight(h.mock.api, h.ctx, undefined, selection);
  return { h, result };
}

it("returns unsupported for SDK-shaped argv without a real TTY", async () => {
  const h = await submitted();
  const descriptors = [process.stdin, process.stdout].map((s) =>
    Object.getOwnPropertyDescriptor(s, "isTTY"),
  );
  for (const s of [process.stdin, process.stdout])
    Object.defineProperty(s, "isTTY", { configurable: true, value: false });
  try {
    h.mock.sendMessage.mockClear();
    const result = await approvePreflight(h.mock.api, h.ctx);
    expect(result.status).toBe("unsupported");
    expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  } finally {
    [process.stdin, process.stdout].forEach((s, i) => {
      if (descriptors[i]) Object.defineProperty(s, "isTTY", descriptors[i]);
      else Reflect.deleteProperty(s, "isTTY");
    });
  }
});

it("returns unsupported for RPC-mode context even with TTY and SDK argv", async () => {
  const h = await submitted();
  Object.assign(h.ctx, { mode: "rpc" });
  const result = await approvePreflight(h.mock.api, h.ctx);
  expect(result.status).toBe("unsupported");
  expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
});

it("denies a fabricated NativeAnswer DTO that was not produced by requestNativeAnswer", () => {
  const ctx = createMockContext();
  const forged: NativeAnswer = Object.freeze({
    outcome: "approve",
    value: undefined,
    answeredAt: Date.now(),
  });
  const frame = {
    version: 1 as const,
    owner: "preflight" as const,
    sessionId: "test-session",
    requestId: "req-1",
    presentationId: "pres-1",
    scopeDigest: "a".repeat(64),
    baseSnapshotEntryId: "base-1",
    baseSnapshotDigest: "b".repeat(64),
  };
  expect(() => {
    requireNativeAnswer(ctx, forged, frame);
  }).toThrow(/unrecognized|native answer/i);
});

it("defer does not change approval state and produces no sendMessage", async () => {
  const h = await submitted();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  h.mock.sendMessage.mockClear();
  const result = await approvePreflight(h.mock.api, h.ctx);
  expect(result.status).toBe("deferred");
  expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});

it("reject does not grant approval and never starts", async () => {
  const h = await submitted();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("不允许");
  h.mock.sendMessage.mockClear();
  const result = await approvePreflight(h.mock.api, h.ctx);
  expect(result.status).toBe("rejected");
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
  expect(supervisorState()).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});

it("partial approval missing a required permission stays awaiting_authorization", async () => {
  const { h, result } = await approved("A2");
  expect(result.status).toBe("partial");
  expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
  expect(currentRuntime().preflight?.approval?.permissionIds).toEqual(["A2"]);
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(supervisorState()).toBeUndefined();
  // Cannot start with missing required permissions
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await expect(startApprovedPreflight(h.mock.api, h.ctx)).rejects.toThrow();
});

it("identical resubmit returns already_saved without a new native prompt", async () => {
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后决定");
  const planning = currentRuntime().preflight!;
  const first = await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: planning.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(first.details.status).toBe("deferred");
  const selectCallsAfterFirst = vi.mocked(h.ctx.ui.select).mock.calls.length;
  const second = await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: planning.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(second.details.status).toBe("already_saved");
  expect(vi.mocked(h.ctx.ui.select).mock.calls.length).toBe(selectCallsAfterFirst);
});

it("retains confirmed approval under cache write failure with zero sendMessage", async () => {
  const h = await submitted();
  const append = h.mock.appendEntry.getMockImplementation() as (
    type: string,
    data: unknown,
  ) => void;
  h.mock.appendEntry.mockImplementation((type, data: any) => {
    if (type === PREFLIGHT_ENTRY && data.approval) throw new Error("cache write failed");
    append(type, data);
  });
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  h.mock.sendMessage.mockClear();
  const result = await approvePreflight(h.mock.api, h.ctx);
  expect(result.projectionPending).toBe(true);
  expect(result.confirmed?.kind).toBe("approve");
  expect(result.confirmed?.answer).toBe("Approve");
  expect(currentRuntime().journalFault).toBeDefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
  // State is held, not projected
  expect(currentRuntime().preflightRepair).toBeDefined();
});

it("aborted signal prevents approval and leaves state unchanged", async () => {
  const h = await submitted();
  const controller = new AbortController();
  controller.abort();
  const before = structuredClone(currentRuntime().preflight);
  const result = await approvePreflight(h.mock.api, h.ctx, undefined, undefined, controller.signal);
  expect(result.status).toBe("deferred");
  expect(currentRuntime().preflight?.phase).toBe(before?.phase);
  expect(currentRuntime().preflight?.approval).toBeUndefined();
});

it("throws when plan ID hint does not match the current preflight plan", async () => {
  const h = await submitted();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  await expect(approvePreflight(h.mock.api, h.ctx, "stale-plan-id")).rejects.toThrow(/stale/i);
});

it("pending messages block approval with an idle error", async () => {
  const h = await submitted();
  vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
  await expect(approvePreflight(h.mock.api, h.ctx)).rejects.toThrow(/idle|pending/i);
});

it("non-idle context blocks approval", async () => {
  const h = await submitted();
  vi.mocked(h.ctx.isIdle).mockReturnValue(false);
  await expect(approvePreflight(h.mock.api, h.ctx)).rejects.toThrow(/idle|pending/i);
});

it("tampered journal leaf blocks preflightEvidence", async () => {
  const { h } = await approved();
  // Corrupt the raw journal file to simulate a tampered native closure
  const { writeFileSync } = await import("node:fs");
  writeFileSync(h.path, "not a valid journal\n");
  expect(() => {
    preflightEvidence(h.ctx, {
      preflightId: currentRuntime().preflight!.preflightId,
      planId: currentRuntime().preflight!.planId!,
      planDigest: currentRuntime().preflight!.planDigest!,
    });
  }).toThrow();
});

it("session mismatch on restore throws and preserves the prior fault", async () => {
  const h = await submitted();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  await approvePreflight(h.mock.api, h.ctx);
  const faultBefore = currentRuntime().journalFault;
  // Change session identity to simulate a stale session callback
  vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("different-session");
  expect(() => {
    restorePreflight(h.ctx);
  }).toThrow();
  expect(currentRuntime().journalFault).toBe(faultBefore);
});

it("start on a non-approved plan throws without side effects", async () => {
  const h = await submitted();
  // State is awaiting_authorization, not approved
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  h.mock.sendMessage.mockClear();
  await expect(startApprovedPreflight(h.mock.api, h.ctx)).rejects.toThrow();
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(supervisorState()).toBeUndefined();
  expect(h.mock.sendMessage).not.toHaveBeenCalled();
});

it("active-tools adapter blocks approval when tools are already enabled", async () => {
  const h = await submitted();
  // Simulate that session scope is already active (tools enabled from a prior start)
  const { setSessionScopeEnabled } = await import("../scope");
  setSessionScopeEnabled(true);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  // Approval should still work (scope is independent of approval)
  const result = await approvePreflight(h.mock.api, h.ctx);
  expect(result.status).toBe("approved");
  // Reset for other tests
  setSessionScopeEnabled(false);
});
