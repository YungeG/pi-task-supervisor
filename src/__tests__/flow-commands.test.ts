import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentRuntime } from "../runtime";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import {
  holdSupervisor,
  restoreSupervisor,
  startSupervisor,
  supervisorState,
  SUPERVISOR_ENTRY,
} from "../supervisor";
import { activeBoard, lifecycle } from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

function setup() {
  const h = lifecycle();
  const { mock, ctx } = h;
  setBoard(activeBoard());
  startSupervisor(mock.api, ctx, "Finish the authorized task board");
  const command = mock.registerCommand.mock.calls.find(
    ([name]) => name === "task-supervisor",
  )?.[1] as {
    handler: (args: string, context: typeof ctx) => Promise<void>;
  };
  return { mock, ctx, fire: h.fire, run: (args: string) => command.handler(args, ctx) };
}

describe("ordinary supervised pause recovery", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
  });

  it("resumes a confirmed human pause once without resetting supervisor counters or usage", async () => {
    const { mock, run, fire } = setup();
    for (let i = 0; i < 73; i++)
      fire("tool_result", {
        type: "tool_result",
        toolName: "write",
        toolCallId: `epoch-${i}`,
        input: {},
        content: [{ type: "text", text: "changed" }],
        isError: false,
      });
    Object.assign(supervisorState()!, {
      reviews: 7,
      continuations: 4,
      stagnant: 1,
      epoch: 73,
      tokens: 800,
      cost: 0.25,
    });
    await run("pause maintenance");
    mock.sendMessage.mockClear();

    await run("resume");

    expect(getBoard().workflowStatus).toBe("active");
    expect(supervisorState()).toMatchObject({
      status: "active",
      reviews: 7,
      continuations: 4,
      stagnant: 1,
      epoch: 73,
      tokens: 800,
      cost: 0.25,
      goal: "Finish the authorized task board",
      sessionId: "test-session",
      model: { provider: "faux", id: "test" },
    });
    expect(mock.sendMessage).toHaveBeenCalledOnce();
    expect(mock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "continuous-tasks:continue" }),
      { triggerTurn: true, deliverAs: "followUp" },
    );
  });

  it("does not jointly resume a human pause with an unresolved host capture", async () => {
    const { run, fire } = setup();
    fire("tool_call", {
      type: "tool_call",
      toolName: "write",
      toolCallId: "unresolved",
      input: {},
    });
    await run("pause inspect pending write");
    await run("resume");
    expect(getBoard().workflowStatus).toBe("active");
    expect(supervisorState()!.status).toBe("paused");
    expect(currentRuntime().receiptStore!.pendingCount).toBe(1);
    await run("recover");
    expect(supervisorState()!.status).toBe("active");
    expect(currentRuntime().receiptStore!.pendingCount).toBe(0);
    expect(supervisorState()!.epoch).toBe(2);
  });

  it.each([
    "run_aborted",
    "run_failed",
    "advisor_hold",
    "review_failed",
    "budget_exhausted",
    "stagnant",
    "interrupted",
    "acceptance_invalid",
    "unknown",
  ] as const)(
    "does not turn a %s hold into ordinary recovery after another human pause",
    async (cause) => {
      const { mock, ctx, run } = setup();
      holdSupervisor(mock.api, ctx, "paused", "Original hold", cause);
      await run("pause maintenance");
      expect(supervisorState()).toMatchObject({ holdCause: cause, reason: "Original hold" });
      mock.sendMessage.mockClear();
      await run("resume");
      expect(supervisorState()?.status).toBe("paused");
      expect(mock.sendMessage).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Task board resumed only"),
        "info",
      );
    },
  );

  it("keeps a fault latched and requires explicit recover after board resume", async () => {
    const { mock, ctx, run } = setup();
    holdSupervisor(mock.api, ctx, "fault", "Original failure", "review_failed");
    await run("pause maintenance");
    expect(supervisorState()).toMatchObject({ status: "fault", reason: "Original failure" });
    mock.sendMessage.mockClear();
    await run("resume");
    expect(supervisorState()?.status).toBe("fault");
    expect(mock.sendMessage).not.toHaveBeenCalled();
    await run("recover");
    expect(supervisorState()).toMatchObject({ status: "active", holdCause: undefined });
    expect(mock.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn)).toHaveLength(
      1,
    );
  });

  it.each([
    ["reviews", 40],
    ["continuations", 20],
    ["stagnant", 3],
  ] as const)("preserves exhausted %s after pause and resume", async (field, limit) => {
    const { mock, run } = setup();
    supervisorState()![field] = limit;
    await run("pause maintenance");
    mock.sendMessage.mockClear();
    await run("resume");
    expect(supervisorState()![field]).toBe(limit);
    expect(supervisorState()?.status).toBe("paused");
    expect(mock.sendMessage).not.toHaveBeenCalled();
  });

  it("keeps status read-only and actionable even while disabled and journal-faulted", async () => {
    const { mock, ctx, run } = setup();
    setSessionScopeEnabled(false);
    currentRuntime().journalFault = "Invalid supervisor journal";
    const board = getBoard();
    const state = structuredClone(supervisorState());
    mock.appendEntry.mockClear();
    mock.sendMessage.mockClear();
    await run("status");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Session: disabled"),
      "info",
    );
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("inspect journal"),
      "info",
    );
    expect(getBoard()).toEqual(board);
    expect(supervisorState()).toEqual(state);
    expect(mock.appendEntry).not.toHaveBeenCalled();
    expect(mock.sendMessage).not.toHaveBeenCalled();
    expect(mock.setActiveTools).not.toHaveBeenCalled();
  });

  it("shows the decision before recover when a fault and decision gate coexist", async () => {
    const { mock, ctx, run } = setup();
    holdSupervisor(mock.api, ctx, "fault", "Validation unavailable", "review_failed");
    setBoard({
      ...getBoard(),
      workflowStatus: "waiting_for_decision",
      decision: {
        id: "choose",
        taskId: "t-1.1",
        question: "Choose compatibility",
        whyUserOwned: "User decision",
        createdAt: "now",
      },
    });
    mock.appendEntry.mockClear();
    mock.sendMessage.mockClear();
    await run("status");
    expect(ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("structured replacement from Main, then /task-supervisor decide"),
      "info",
    );
    const text = vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0] as string;
    expect(
      text.indexOf("structured replacement from Main, then /task-supervisor decide"),
    ).toBeLessThan(text.lastIndexOf("recover"));
    expect(text).toContain("Validation unavailable");
    expect(mock.appendEntry).not.toHaveBeenCalled();
    expect(mock.sendMessage).not.toHaveBeenCalled();
  });

  it("describes host activity and execution references without claiming child liveness", async () => {
    const { ctx, run } = setup();
    const board = getBoard();
    board.tasks[0]!.status = "implementing";
    board.tasks[0]!.executionRef = { source: "workflow", runId: "run-1" };
    setBoard(board);
    vi.mocked(ctx.isIdle).mockReturnValue(false);
    await run("status");
    const text = vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0] as string;
    expect(text).toContain("host run busy");
    expect(text).toContain("workflow:run-1; status unknown");
    expect(text).toContain("batch guidance only");
    expect(text).toContain("auto continuations");
  });

  it("gives Main a soft batch checkpoint without invoking an advisor or abort", async () => {
    const lane = lifecycle();
    setBoard(activeBoard());
    await lane.command("supervise Finish authorized work");
    lane.ctx.abort = vi.fn();
    const result = await lane.fire("before_agent_start");
    expect(result.message.content).toContain("finish this run normally");
    expect(result.message.content).toContain("guidance, not a host-enforced phase gate");
    expect(lane.ctx.abort).not.toHaveBeenCalled();
    expect(supervisorState()?.reviews).toBe(0);
  });

  it("does not jointly resume an oversized task board", async () => {
    const { mock, run } = setup();
    const board = getBoard();
    setBoard({
      ...board,
      tasks: Array.from({ length: 101 }, (_, i) => ({
        ...board.tasks[0]!,
        id: `task-${i}`,
      })),
    });
    await run("pause maintenance");
    mock.sendMessage.mockClear();
    await run("resume");
    expect(supervisorState()?.status).toBe("paused");
    expect(mock.sendMessage).not.toHaveBeenCalled();
  });

  it("does not infer legacy pause authority from its reason text", async () => {
    const { mock, run } = setup();
    Object.assign(supervisorState()!, {
      status: "paused",
      reason: "Paused by user",
      holdCause: undefined,
    });
    await run("pause maintenance");
    expect(supervisorState()?.holdCause).toBeUndefined();
    mock.sendMessage.mockClear();
    await run("resume");
    expect(supervisorState()?.status).toBe("paused");
    expect(mock.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["busy", "pending", "decision", "foreign", "continuation", "inconsistent"])(
    "does not mutate or dispatch on the %s control gate",
    async (gate) => {
      const { mock, ctx, run } = setup();
      await run("pause maintenance");
      if (gate === "busy") vi.mocked(ctx.isIdle).mockReturnValue(false);
      if (gate === "pending") vi.mocked(ctx.hasPendingMessages).mockReturnValue(true);
      if (gate === "decision")
        setBoard({
          ...getBoard(),
          decision: {
            id: "choose",
            taskId: "t-1.1",
            question: "Choose",
            whyUserOwned: "Approval",
            createdAt: "now",
          },
        });
      if (gate === "foreign") supervisorState()!.sessionId = "another-session";
      if (gate === "continuation") supervisorState()!.pending = true;
      if (gate === "inconsistent") supervisorState()!.status = "active";
      const board = getBoard();
      const state = structuredClone(supervisorState());
      mock.appendEntry.mockClear();
      mock.sendMessage.mockClear();
      await run("resume");
      expect(getBoard()).toEqual(board);
      expect(supervisorState()).toEqual(state);
      expect(mock.appendEntry).not.toHaveBeenCalled();
      expect(mock.sendMessage).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2, 3])("fails closed when resume journal append %i fails", async (failure) => {
    const { mock, run } = setup();
    await run("pause maintenance");
    const board = getBoard();
    const state = structuredClone(supervisorState());
    const written: Array<{ type: string; customType: string; data: unknown }> = [];
    let calls = 0;
    mock.appendEntry.mockImplementation((customType, data) => {
      if (++calls === failure) throw new Error("disk unavailable");
      written.push({ type: "custom", customType, data });
    });
    mock.sendMessage.mockClear();
    await run("resume");
    expect(getBoard()).toEqual(board);
    expect(supervisorState()).toEqual(state);
    expect(currentRuntime().journalFault).toContain("Resume persistence/dispatch failed");
    expect(mock.sendMessage).not.toHaveBeenCalled();
    if (failure > 1) {
      expect(written[0]?.customType).toBe(SUPERVISOR_ENTRY);
      resetState();
      setBoard(board);
      restoreSupervisor(createMockAPI().api, createMockContext(written));
      expect(supervisorState()?.status).toBe("fault");
    }
  });

  it("does not retry an unknown dispatch outcome", async () => {
    const { mock, run } = setup();
    await run("pause maintenance");
    mock.sendMessage.mockClear();
    mock.sendMessage.mockImplementation(() => {
      throw new Error("transport unavailable");
    });
    await run("resume");
    expect(mock.sendMessage).toHaveBeenCalledOnce();
    expect(currentRuntime().journalFault).toContain("dispatch failed");
    expect(getBoard().workflowStatus).toBe("paused");
  });

  it("does not dispatch twice on concurrent resume commands", async () => {
    const { mock, run } = setup();
    await run("pause maintenance");
    mock.sendMessage.mockClear();
    await Promise.all([run("resume"), run("resume")]);
    expect(mock.sendMessage).toHaveBeenCalledOnce();
  });

  it("rejects an unbound/no-op idle wait and does not retain a manual-pause intent", async () => {
    const lane = lifecycle();
    setBoard(activeBoard());
    await lane.command("supervise Finish authorized work");
    vi.mocked(lane.ctx.isIdle).mockReturnValue(false);
    const board = getBoard();
    const state = structuredClone(supervisorState());
    lane.mock.appendEntry.mockClear();
    lane.mock.sendMessage.mockClear();
    await lane.command("pause maintenance");
    expect(lane.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Host has not settled"),
      "error",
    );
    expect(getBoard()).toEqual(board);
    expect(supervisorState()).toEqual(state);
    expect(lane.mock.appendEntry).not.toHaveBeenCalled();
    lane.fire("agent_settled", { aborted: true });
    expect(supervisorState()).toMatchObject({ status: "paused", holdCause: "run_aborted" });
  });

  it("recognizes only the host abort caused by an explicit busy pause command", async () => {
    const lane = lifecycle();
    setBoard(activeBoard());
    await lane.command("supervise Finish authorized work");
    vi.mocked(lane.ctx.isIdle).mockReturnValue(false);
    vi.mocked(lane.ctx.waitForIdle).mockImplementation(async () => {
      lane.fire("agent_settled", { aborted: true });
      vi.mocked(lane.ctx.isIdle).mockReturnValue(true);
    });
    await lane.command("pause maintenance");
    lane.mock.sendMessage.mockClear();
    await lane.command("resume");
    expect(supervisorState()?.status).toBe("active");
    expect(lane.mock.sendMessage).toHaveBeenCalledOnce();
    lane.fire("agent_settled", { aborted: true });
    expect(supervisorState()).toMatchObject({ status: "paused", holdCause: "run_aborted" });
  });
});
