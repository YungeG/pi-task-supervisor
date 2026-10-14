import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetState, setBoard, getBoard } from "../state";
import { setSessionScopeEnabled, TASK_TOOL_NAMES } from "../scope";
import { currentRuntime } from "../runtime";
import { supervisorState } from "../supervisor";
import {
  createSubmitPreflightTool,
  createGetReadyTasksTool,
  createAdvanceTasksTool,
  createWorkflowGateTool,
} from "../tools";
import { activeBoard, BOUNDARY, deferred } from "./helpers/lifecycle";
import { localProposal, preflightLifecycle } from "./helpers/preflight";

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(false);
});
async function proposed() {
  const h = preflightLifecycle();
  await h.command("preflight Local implementation");
  await createSubmitPreflightTool(h.mock.api).execute(
    "submit",
    { preflightId: currentRuntime().preflight!.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  return h;
}
async function started() {
  const h = await proposed();
  await h.command(`approve ${currentRuntime().preflight!.planId} A1`);
  await h.command(`start ${currentRuntime().preflight!.planId}`);
  return h;
}

describe("preflight lifecycle authorization boundary", () => {
  it("cannot bypass retained revocation through stop then board-only resume", async () => {
    const h = await started();
    setBoard(activeBoard());
    const id = currentRuntime().preflight!.planId;
    await h.command(`revoke ${id}`);
    await h.command("stop");
    expect(supervisorState()?.status).toBe("stopped");
    await h.command("resume");
    expect(getBoard().workflowStatus).toBe("paused");
    expect(h.fire("tool_call", { toolName: "get_ready_tasks", input: {} })).toMatchObject({
      block: true,
    });
    expect(currentRuntime().preflight?.phase).toBe("revoked");
    setBoard(activeBoard());
    expect(h.fire("tool_call", { toolName: "get_ready_tasks", input: {} })).toMatchObject({
      block: true,
    });
    expect(h.fire("tool_call", { toolName: "clear_tasks", input: {} })).toMatchObject({
      block: true,
    });
  });
  it("keeps stopped board control usable only after exact human reapproval without restarting supervision", async () => {
    const h = await started();
    setBoard(activeBoard());
    const id = currentRuntime().preflight!.planId;
    await h.command(`revoke ${id}`);
    await h.command("stop");
    await h.command(`approve ${id} A1`);
    h.mock.sendMessage.mockClear();
    await h.command("resume");
    expect(getBoard().workflowStatus).toBe("active");
    expect(supervisorState()?.status).toBe("stopped");
    expect(h.fire("tool_call", { toolName: "get_ready_tasks", input: {} })).toBeUndefined();
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
  });
  it("shows the authorization prerequisite before a decision command it would reject", async () => {
    const h = await started();
    setBoard(activeBoard());
    await createGetReadyTasksTool(h.mock.api).execute(
      "claim",
      { count: 1 },
      undefined,
      undefined,
      h.ctx,
    );
    await createWorkflowGateTool(h.mock.api).execute(
      "decision",
      {
        action: "wait_for_decision",
        taskId: "t-1.1",
        decision: {
          question: "Choose a local path",
          whyUserOwned: "Only the user chooses the scope",
          options: ["A", "B"],
        },
      },
      undefined,
      undefined,
      h.ctx,
    );
    const decision = getBoard().decision!;
    const id = currentRuntime().preflight!.planId;
    await h.command(`revoke ${id}`);
    await h.command("status");
    const message = vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)![0];
    expect(message).toContain(`Decision ${decision.id}:`);
    expect(message).toContain("Next: inspect preflight authorization:");
    expect(message).not.toContain(`Next: /task-supervisor resolve ${decision.id}`);
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Next: wait for the current host run/check and pending messages"),
      "info",
    );
    vi.mocked(h.ctx.isIdle).mockReturnValue(true);
    await h.command(`approve ${id} A1`);
    await h.command("status");
    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining(`Next: /task-supervisor resolve ${decision.id}`),
      "info",
    );
  });
  it("retains the exact host-review/exit-code/epoch evidence gates under a started preflight", async () => {
    const h = await started();
    setBoard(activeBoard());
    await createGetReadyTasksTool(h.mock.api).execute(
      "claim",
      { count: 1 },
      undefined,
      undefined,
      h.ctx,
    );
    const advance = createAdvanceTasksTool(h.mock.api);
    await advance.execute(
      "review",
      { transitions: [{ id: "t-1.1" }] },
      undefined,
      undefined,
      h.ctx,
    );
    const proof = (id: string) => ({
      transitions: [
        {
          id: "t-1.1",
          evidence: {
            summary: "Validate the approved local fixture",
            refs: [
              {
                kind: "command" as const,
                label: "host validation",
                status: "passed" as const,
                ref: `tool:${id}`,
                exitCode: 0,
              },
            ],
          },
        },
      ],
    });
    expect(
      (await advance.execute("forged", proof("missing"), undefined, undefined, h.ctx)).details
        .error,
    ).toContain("host receipt");
    h.fire("tool_result", {
      toolName: "validate",
      toolCallId: "failed",
      input: {},
      content: [{ type: "text", text: "failed" }],
      structuredContent: { exit_code: 1 },
      isError: false,
    });
    expect(
      (await advance.execute("failed", proof("failed"), undefined, undefined, h.ctx)).details.error,
    ).toContain("exit_code");
    h.fire("tool_result", {
      toolName: "validate",
      toolCallId: "previous",
      input: {},
      content: [{ type: "text", text: "passed" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    h.fire("tool_result", {
      toolName: "write",
      toolCallId: "later-change",
      input: {},
      content: [{ type: "text", text: "mutation" }],
      isError: false,
    });
    expect(
      (await advance.execute("stale", proof("previous"), undefined, undefined, h.ctx)).details
        .error,
    ).toContain("host receipt");
    h.fire("tool_result", {
      toolName: "validate",
      toolCallId: "fresh",
      input: {},
      content: [{ type: "text", text: "passed" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    expect(
      (await advance.execute("done", proof("fresh"), undefined, undefined, h.ctx)).details.error,
    ).toBeUndefined();
    expect(supervisorState()?.bindings[0]?.refs).toEqual(["tool:fresh"]);
  });
  it("discards late advisor results when the exact bound grant is revoked", async () => {
    const h = await started();
    setBoard(activeBoard());
    const reply = deferred<any>();
    Object.assign(h.ctx, {
      modelRegistry: {
        find: () => h.ctx.model,
        streamSimple: () => ({ result: () => reply.promise }),
      },
    });
    const boundary = h.fire("agent_before_settle", BOUNDARY);
    await h.command(`revoke ${currentRuntime().preflight!.planId}`);
    expect(await boundary).toBeUndefined();
    h.mock.sendMessage.mockClear();
    reply.resolve({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            action: "guide",
            message: "Do not deliver stale guidance",
            taskIds: [],
            evidenceRefs: [],
          }),
        },
      ],
    });
    await Promise.resolve();
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "authorization_revoked",
    });
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
  });
  it.each(["planning append", "activation append", "planning dispatch"])(
    "fails closed on %s without hiding the journal fault",
    async (failure) => {
      const h = preflightLifecycle();
      const append = h.mock.appendEntry.getMockImplementation()! as (...args: any[]) => unknown;
      h.mock.appendEntry.mockImplementation((type: string, data: unknown) => {
        if (
          (failure === "planning append" && type === "continuous-tasks:preflight") ||
          (failure === "activation append" && type === "continuous-tasks:activation")
        )
          throw new Error("disk full");
        append(type, data);
      });
      if (failure === "planning dispatch")
        h.mock.sendMessage.mockImplementation(() => {
          throw new Error("dispatch failed");
        });
      await h.command("preflight Local fixture");
      expect(currentRuntime().journalFault).toBeDefined();
      expect(supervisorState()).toBeUndefined();
      expect(h.fire("tool_call", { toolName: "submit_preflight", input: {} })).toMatchObject({
        block: true,
      });
      await h.command("status");
      expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Fault:"), "info");
    },
  );
  it("blocks every execution-board mutation while planning and awaiting separate start", async () => {
    const h = await proposed();
    for (const toolName of TASK_TOOL_NAMES)
      expect(h.fire("tool_call", { toolName, input: {} })).toMatchObject({ block: true });
    await h.command(`approve ${currentRuntime().preflight!.planId} A1`);
    expect(h.fire("tool_call", { toolName: "get_ready_tasks", input: {} })).toMatchObject({
      block: true,
    });
    expect(h.fire("before_agent_start").message.content).toContain("read-only");
  });
  it("injects the full confirmed scope without calling it a sandbox", async () => {
    const h = await started();
    const content = h.fire("before_agent_start").message.content;
    expect(content).toContain(localProposal.prohibitions[0]);
    expect(content).toContain("A1");
    expect(content).toContain("natural-language");
  });
  it("restores approved control closure without automatically dispatching", async () => {
    const h = await proposed();
    await h.command(`approve ${currentRuntime().preflight!.planId} A1`);
    const id = currentRuntime().preflight!.planId;
    h.mock.sendMessage.mockClear();
    await h.fire("session_tree");
    expect(currentRuntime().preflight).toMatchObject({ phase: "approved", planId: id });
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
    await h.command(`start ${id}`);
    expect(supervisorState()?.status).toBe("active");
  });
  it("does not inherit a foreign session grant or replay interrupted planning", async () => {
    const h = await proposed();
    vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("foreign-session");
    await h.fire("session_tree");
    expect(currentRuntime().preflight).toBeUndefined();
    vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("test-session");
    await h.command("preflight Replacement goal");
    h.mock.sendMessage.mockClear();
    await h.fire("session_tree");
    expect(currentRuntime().preflight?.phase).toBe("interrupted");
    expect(h.fire("tool_call", { toolName: "write_tasks", input: {} })).toMatchObject({
      block: true,
    });
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
  });
  it("revokes the active binding and requires fresh human approval plus explicit recovery", async () => {
    const h = await started();
    const id = currentRuntime().preflight!.planId;
    h.mock.sendMessage.mockClear();
    await h.command(`revoke ${id}`);
    expect(currentRuntime().preflight?.phase).toBe("revoked");
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "authorization_revoked",
    });
    await h.command("recover");
    expect(supervisorState()?.status).toBe("paused");
    await h.command(`approve ${id} A1`);
    expect(currentRuntime().preflight?.phase).toBe("started");
    expect(supervisorState()?.status).toBe("paused");
    expect(h.mock.sendMessage.mock.calls.filter(([, options]) => options.triggerTurn)).toHaveLength(
      0,
    );
    await h.command("recover");
    expect(supervisorState()?.status).toBe("active");
  });
});
