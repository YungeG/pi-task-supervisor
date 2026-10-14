import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalPreflightProposal,
  preflightDigest,
  preflightAuthorizationIssue,
  preflightStartBinding,
  preflightEvidence,
  approvePreflight,
  restorePreflight,
  PREFLIGHT_CONTROL_ENTRY,
  PREFLIGHT_ENTRY,
} from "../preflight";
import { currentRuntime } from "../runtime";
import { resetState, setBoard } from "../state";
import { setSessionScopeEnabled } from "../scope";
import {
  acceptanceError,
  evidencePacket,
  holdSupervisor,
  recoverSupervisor,
  supervisorState,
} from "../supervisor";
import { createSubmitPreflightTool } from "../tools";
import { activeBoard } from "./helpers/lifecycle";
import { localProposal, preflightLifecycle } from "./helpers/preflight";

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(false);
});
async function proposed() {
  const h = preflightLifecycle();
  await h.command("preflight Local fixture");
  const tool = createSubmitPreflightTool(h.mock.api);
  const submit = (
    proposal: unknown = localProposal,
    id = currentRuntime().preflight!.preflightId,
  ) => tool.execute("submit", { preflightId: id, proposal } as never, undefined, undefined, h.ctx);
  await submit();
  return { ...h, submit };
}
async function approved() {
  const h = await proposed();
  await h.command(`approve ${currentRuntime().preflight!.planId} A1`);
  return h;
}
async function started() {
  const h = await approved();
  await h.command(`start ${currentRuntime().preflight!.planId}`);
  return h;
}

describe("preflight strict proposal/identity", () => {
  const malformed: Array<[string, (proposal: any) => void]> = [
    ["unknown", (p) => (p.approval = {})],
    ["missing", (p) => delete p.summary],
    ["empty steps", (p) => (p.steps = [])],
    ["too many", (p) => (p.steps = Array(21).fill("step"))],
    ["whitespace", (p) => (p.summary = "  ")],
    ["long text", (p) => (p.summary = "x".repeat(2001))],
    ["secret", (p) => (p.summary = "password=never-store-this")],
    ["duplicate ID", (p) => p.permissions.push(p.permissions[0])],
    ["reserved ID", (p) => (p.permissions[0].id = "all")],
    ["comma ID", (p) => (p.permissions[0].id = "A,1")],
    ["whitespace ID", (p) => (p.permissions[0].id = "A 1")],
    ["unknown permission", (p) => (p.permissions[0].approved = true)],
    ["non boolean", (p) => (p.permissions[0].required = "true")],
    [
      "UTF8 budget",
      (p) => {
        p.steps = Array(8).fill("界".repeat(900));
      },
    ],
  ];
  it.each(malformed)("rejects %s without changing the journal", async (_name, change) => {
    const h = await proposed();
    const before = structuredClone(currentRuntime().preflight);
    const n = h.entries.length;
    const p = structuredClone(localProposal);
    change(p);
    expect((await h.submit(p)).isError).toBe(true);
    expect(h.entries).toHaveLength(n);
    expect(currentRuntime().preflight).toEqual(before);
  });
  it("canonicalizes only agreed whitespace/order and binds session and goal", () => {
    const p = {
      ...localProposal,
      summary: ` ${localProposal.summary} `,
      permissions: [...localProposal.permissions].reverse(),
    };
    expect(canonicalPreflightProposal(" Local   fixture ", p)).toBe(
      canonicalPreflightProposal("Local fixture", localProposal),
    );
    expect(preflightDigest("one", "Local fixture", p)).not.toBe(
      preflightDigest("two", "Local fixture", p),
    );
    expect(preflightDigest("one", "Local fixture", p)).not.toBe(
      preflightDigest("one", "Other fixture", p),
    );
  });
  it("keeps identical submissions idempotent but invalidates old revision approval", async () => {
    const h = await approved();
    const before = structuredClone(currentRuntime().preflight!);
    const n = h.entries.length;
    await h.submit({ ...localProposal, permissions: [...localProposal.permissions].reverse() });
    expect(h.entries).toHaveLength(n);
    expect(currentRuntime().preflight).toEqual(before);
    await h.submit({ ...localProposal, summary: "Changed scope" });
    expect(currentRuntime().preflight).toMatchObject({
      revision: 2,
      phase: "awaiting_authorization",
      approval: undefined,
    });
    await h.command(`start ${before.planId}`);
    expect(supervisorState()).toBeUndefined();
  });
  it("cannot submit without a current human planning context or after execution", async () => {
    const h = await started();
    const n = h.entries.length;
    expect((await h.submit()).isError).toBe(true);
    expect(h.entries).toHaveLength(n);
    expect((await h.submit(localProposal, "pf-wrong")).isError).toBe(true);
    currentRuntime().preflight = undefined;
    expect((await h.submit(localProposal, "pf-wrong")).isError).toBe(true);
  });
  it.each(["unknown", "A1,A1", "A1,", "A1,A2,unknown", "", "A1 A2"])(
    "rejects invalid exact selection %j without half approval",
    async (selection) => {
      const h = await proposed();
      const n = h.entries.length;
      await h.command(`approve ${currentRuntime().preflight!.planId} ${selection}`);
      expect(h.entries).toHaveLength(n);
      expect(currentRuntime().preflight?.approval).toBeUndefined();
    },
  );
  it("replaces all/none/partial selections rather than accumulating them", async () => {
    const h = await proposed();
    const id = currentRuntime().preflight!.planId;
    await h.command(`approve ${id} all`);
    expect(currentRuntime().preflight?.approval?.permissionIds).toEqual(["A1", "A2"]);
    await h.command(`approve ${id} none`);
    expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
    await h.command(`approve ${id} A1`);
    expect(currentRuntime().preflight?.approval?.permissionIds).toEqual(["A1"]);
  });
  it("permits an explicitly confirmed proposal with no extra permissions", async () => {
    const h = await proposed();
    await h.submit({ ...localProposal, permissions: [] });
    await h.command(`approve ${currentRuntime().preflight!.planId} none`);
    await h.command(`start ${currentRuntime().preflight!.planId}`);
    expect(supervisorState()?.status).toBe("active");
  });
});

describe("current-branch human control and persistence", () => {
  it("does not transfer a started grant to a changed supervisor goal", async () => {
    const h = await started();
    const state = supervisorState()!;
    state.goal = "A different scope";
    expect(preflightAuthorizationIssue(h.ctx, state.preflightBinding!)).toContain("goal changed");
    expect(h.fire("tool_call", { toolName: "get_ready_tasks", input: {} })).toMatchObject({
      block: true,
    });
    expect(acceptanceError(activeBoard(), state, h.ctx)).toContain("goal changed");
  });
  it("rejects an already cancelled proposal before persistence", async () => {
    const h = await proposed();
    const n = h.entries.length;
    const controller = new AbortController();
    controller.abort();
    const result = await createSubmitPreflightTool(h.mock.api).execute(
      "cancelled",
      { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
      controller.signal,
      undefined,
      h.ctx,
    );
    expect(result.isError).toBe(true);
    expect(h.entries).toHaveLength(n);
  });

  it.each(["empty", "secret", "long"])(
    "rejects %s goals before creating planning state",
    async (kind) => {
      const h = preflightLifecycle();
      await h.command(
        `preflight ${kind === "empty" ? "" : kind === "secret" ? "password=never-store" : "x".repeat(4001)}`,
      );
      expect(currentRuntime().preflight).toBeUndefined();
      expect(h.entries).toHaveLength(0);
    },
  );
  it.each(["busy", "pending", "existing supervisor", "existing board"])(
    "cannot silently plan over %s",
    async (kind) => {
      const h = preflightLifecycle();
      if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
      if (kind === "pending") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
      if (kind === "existing supervisor") await h.command("supervise Old goal");
      if (kind === "existing board") setBoard(activeBoard());
      await h.command("preflight New goal");
      expect(currentRuntime().preflight).toBeUndefined();
    },
  );
  it("invalidates old plan IDs when a human replaces unstarted planning", async () => {
    const h = await approved();
    const old = currentRuntime().preflight!;
    await h.command("preflight New local goal");
    expect(currentRuntime().preflight?.preflightId).not.toBe(old.preflightId);
    await h.command(`start ${old.planId}`);
    expect(supervisorState()).toBeUndefined();
    expect(currentRuntime().preflight?.approval).toBeUndefined();
  });
  it("rejects malformed newer control entries rather than falling back to older approval", async () => {
    const h = await approved();
    const state = currentRuntime().preflight!;
    h.mock.api.appendEntry(PREFLIGHT_CONTROL_ENTRY, { kind: "approve" });
    expect(() => preflightStartBinding(h.ctx, state.goal, state.planId)).toThrow("journal");
    await h.fire("session_tree");
    expect(currentRuntime().journalFault).toContain("preflight");
  });
  it("marks a missing started association as a half-start fault on restore", async () => {
    const h = await started();
    const last = [...h.entries].reverse().find((e) => e.customType === PREFLIGHT_ENTRY)!;
    (last.data as any).started = undefined;
    await h.fire("session_tree");
    expect(currentRuntime().journalFault).toContain("preflight");
  });
  it("recovery cannot clear revocation through ordinary resume or a decision answer", async () => {
    const h = await started();
    await h.command(`revoke ${currentRuntime().preflight!.planId}`);
    const board = activeBoard({ workflowStatus: "paused" });
    setBoard(board);
    await h.command("resume");
    expect(supervisorState()?.status).toBe("paused");
    const decision = {
      id: "decision-1",
      taskId: "t-1.1",
      question: "Pick scope",
      whyUserOwned: "Human scope",
      options: [],
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    setBoard({ ...board, workflowStatus: "waiting_for_decision", decision });
    await h.command("resolve decision-1 Yes");
    expect(currentRuntime().preflight?.phase).toBe("revoked");
  });
  it("keeps a restored valid partial selection non-executable", async () => {
    const h = await proposed();
    await h.command(`approve ${currentRuntime().preflight!.planId} A2`);
    await h.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().preflight?.phase).toBe("awaiting_authorization");
    await h.command(`start ${currentRuntime().preflight!.planId}`);
    expect(supervisorState()).toBeUndefined();
  });
  it("preserves started scope through compaction, restart and explicit recovery without replay", async () => {
    const h = await started();
    const approval = structuredClone(currentRuntime().preflight?.approval);
    await h.fire("session_before_compact");
    expect(currentRuntime().preflight?.approval).toEqual(approval);
    h.mock.sendMessage.mockClear();
    await h.fire("session_tree");
    expect(supervisorState()?.status).toBe("fault");
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
    await h.command("recover");
    expect(supervisorState()?.status).toBe("active");
    expect(currentRuntime().preflight?.approval).toEqual(approval);
  });
  it("never treats a revocation notification as automatic continuation", async () => {
    const h = await started();
    await h.command(`revoke ${currentRuntime().preflight!.planId}`);
    h.mock.sendMessage.mockClear();
    await h.fire("agent_settled", { aborted: false });
    await h.fire("tool_result", {
      toolName: "read",
      toolCallId: "late-read",
      input: {},
      content: [{ type: "text", text: "done" }],
      isError: false,
    });
    expect(supervisorState()?.status).toBe("paused");
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
  });
  it("keeps preflight material protected at the original UTF8 packet cap", async () => {
    const h = await started();
    const state = supervisorState()!;
    const board = activeBoard();
    board.tasks[0]!.prompt = "界".repeat(22000);
    expect(() => evidencePacket(h.ctx, board, state)).toThrow("64KB");
    const packet = JSON.parse(evidencePacket(h.ctx, activeBoard(), state));
    expect(packet.preflight.approval.controlEntryId).toBe(
      currentRuntime().preflight!.approval!.controlEntryId,
    );
  });

  it.each(["missing", "selection", "digest", "session", "kind", "unknown", "superseded"])(
    "rejects a %s approval closure",
    async (scenario) => {
      const h = await approved();
      const state = currentRuntime().preflight!;
      const event = h.entries.find((e) => e.customType === PREFLIGHT_CONTROL_ENTRY)!;
      const control = event.data as any;
      if (scenario === "missing") h.entries.splice(h.entries.indexOf(event), 1);
      if (scenario === "selection") control.permissionIds = ["A2"];
      if (scenario === "digest") control.planDigest = "f".repeat(64);
      if (scenario === "session") control.sessionId = "wrong";
      if (scenario === "kind") control.kind = "revoke";
      if (scenario === "unknown") control.extra = true;
      if (scenario === "superseded")
        h.mock.api.appendEntry(PREFLIGHT_CONTROL_ENTRY, { ...control, kind: "revoke" });
      expect(() => preflightStartBinding(h.ctx, state.goal, state.planId)).toThrow();
      h.mock.sendMessage.mockClear();
      await h.command(`start ${state.planId}`);
      expect(supervisorState()).toBeUndefined();
      expect(h.mock.sendMessage).not.toHaveBeenCalled();
    },
  );
  it.each(["version", "approved snapshot", "digest", "half control"])(
    "fails closed on %s restoration",
    async (scenario) => {
      const h = await proposed();
      const state = currentRuntime().preflight!;
      const snapshot = [...h.entries].reverse().find((e) => e.customType === PREFLIGHT_ENTRY)!
        .data as any;
      if (scenario === "version") snapshot.version = 2;
      if (scenario === "approved snapshot") snapshot.phase = "approved";
      if (scenario === "digest") snapshot.planDigest = "f".repeat(64);
      if (scenario === "half control")
        h.mock.api.appendEntry(PREFLIGHT_CONTROL_ENTRY, {
          kind: "approve",
          sessionId: state.sessionId,
          preflightId: state.preflightId,
          planId: state.planId,
          planDigest: state.planDigest,
          permissionIds: ["A1"],
          createdAt: new Date().toISOString(),
        });
      await h.fire("session_tree");
      expect(currentRuntime().journalFault).toContain("preflight");
      expect(h.fire("tool_call", { toolName: "write_tasks", input: {} })).toMatchObject({
        block: true,
      });
    },
  );
  it.each([PREFLIGHT_CONTROL_ENTRY, PREFLIGHT_ENTRY])(
    "never grants approval when %s append fails",
    async (entryType) => {
      const h = await proposed();
      const append = h.mock.appendEntry.getMockImplementation()! as (...args: any[]) => unknown;
      h.mock.appendEntry.mockImplementation((type: string, data: unknown) => {
        if (type === entryType) throw new Error("disk full");
        append(type, data);
      });
      await h.command(`approve ${currentRuntime().preflight!.planId} A1`);
      expect(currentRuntime().preflight?.approval).toBeUndefined();
      expect(currentRuntime().journalFault).toBeDefined();
      await h.command("status");
      await h.command(`start ${currentRuntime().preflight!.planId}`);
      expect(supervisorState()).toBeUndefined();
    },
  );
  it("does not fabricate a leaf/control ID from a no-op host", async () => {
    const h = await proposed();
    h.mock.appendEntry.mockImplementation(() => {});
    expect(() =>
      approvePreflight(h.mock.api, h.ctx, currentRuntime().preflight!.planId!, "A1"),
    ).toThrow("persistence");
    expect(currentRuntime().journalFault).toBeDefined();
  });
  it.each(["supervisor append", "started append", "dispatch"])(
    "holds half startup on %s failure without replay",
    async (scenario) => {
      const h = await approved();
      const append = h.mock.appendEntry.getMockImplementation()! as (...args: any[]) => unknown;
      h.mock.appendEntry.mockImplementation((type: string, data: any) => {
        if (
          (scenario === "supervisor append" && type === "continuous-tasks:supervisor") ||
          (scenario === "started append" && type === PREFLIGHT_ENTRY && data.phase === "started")
        )
          throw new Error("disk full");
        append(type, data);
      });
      h.mock.sendMessage.mockClear();
      if (scenario === "dispatch")
        h.mock.sendMessage.mockImplementation((_msg: unknown, options: any) => {
          if (options.triggerTurn) throw new Error("dispatch failed");
        });
      await h.command(`start ${currentRuntime().preflight!.planId}`);
      expect(currentRuntime().journalFault).toBeDefined();
      const turns = h.mock.sendMessage.mock.calls.length;
      await h.command(`start ${currentRuntime().preflight!.planId}`);
      expect(h.mock.sendMessage).toHaveBeenCalledTimes(turns);
    },
  );
  it("blocks busy/pending controls and startup on old boards", async () => {
    const h = await approved();
    const id = currentRuntime().preflight!.planId;
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    await h.command(`start ${id}`);
    expect(supervisorState()).toBeUndefined();
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(false);
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    await h.command(`start ${id}`);
    expect(supervisorState()).toBeUndefined();
    vi.mocked(h.ctx.isIdle).mockReturnValue(true);
    setBoard(activeBoard({ workflowStatus: "paused" }));
    await h.command(`start ${id}`);
    expect(supervisorState()).toBeUndefined();
    setBoard(activeBoard());
    const board = activeBoard();
    board.tasks[0]!.status = "done";
    setBoard(board);
    await h.command(`start ${id}`);
    expect(supervisorState()).toBeUndefined();
  });
  it("requires current verification context for bound recovery and acceptance", async () => {
    const h = await started();
    const state = supervisorState()!;
    expect(preflightAuthorizationIssue(undefined, state.preflightBinding!)).toContain("context");
    expect(acceptanceError(activeBoard(), state)).toContain("context");
    holdSupervisor(h.mock.api, h.ctx, "paused", "pause", "user_pause");
    expect(() => {
      recoverSupervisor(h.mock.api);
    }).toThrow("context");
    expect(preflightEvidence(h.ctx, state.preflightBinding!)).toMatchObject({
      proposal: localProposal,
      approval: { permissionIds: ["A1"] },
    });
    expect(JSON.parse(evidencePacket(h.ctx, activeBoard(), state)).preflight.proposal).toEqual(
      localProposal,
    );
  });
  it("preserves stronger holds across revocation and does not alter approval on ordinary mutations", async () => {
    const h = await started();
    const control = structuredClone(currentRuntime().preflight!.approval);
    const state = supervisorState()!;
    state.epoch += 10;
    expect(preflightAuthorizationIssue(h.ctx, state.preflightBinding!)).toBeUndefined();
    expect(currentRuntime().preflight?.approval).toEqual(control);
    holdSupervisor(h.mock.api, h.ctx, "fault", "real failure", "review_failed");
    await h.command(`revoke ${currentRuntime().preflight!.planId}`);
    expect(state).toMatchObject({ status: "fault", holdCause: "review_failed" });
  });
  it("does not abort on a wrong revocation ID, but aborts and waits before the real revoke", async () => {
    const h = await started();
    await h.command("revoke invalid");
    expect(h.ctx.abort).not.toHaveBeenCalled();
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    vi.mocked(h.ctx.waitForIdle).mockImplementation(async () => {
      vi.mocked(h.ctx.isIdle).mockReturnValue(true);
    });
    await h.command(`revoke ${currentRuntime().preflight!.planId}`);
    expect(h.ctx.abort).toHaveBeenCalledOnce();
    expect(currentRuntime().preflight?.phase).toBe("revoked");
    restorePreflight(h.ctx);
    expect(currentRuntime().preflight?.phase).toBe("revoked");
  });
  it("keeps legacy startup separate after an unexecuted revoked plan", async () => {
    const h = await proposed();
    const id = currentRuntime().preflight!.planId;
    await h.command(`revoke ${id}`);
    await h.command("supervise Local fixture");
    expect(supervisorState()).toBeUndefined();
    await h.command("supervise A different legacy goal");
    expect(supervisorState()?.status).toBe("active");
    expect(supervisorState()?.preflightBinding).toBeUndefined();
    const content = h.fire("before_agent_start").message.content;
    expect(content).toContain("User-recorded supervisor goal: A different legacy goal");
    expect(content).not.toContain("Preflight revoked");
  });
});
