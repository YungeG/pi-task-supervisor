import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import { startSupervisor, holdSupervisor, supervisorState, type Advisor } from "../supervisor";
import { createGetReadyTasksTool, createWorkflowGateTool } from "../tools";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";

const guide = {
  action: "guide" as const,
  message: "Continue only the approved local work",
  taskIds: ["t-1.1"],
  evidenceRefs: [],
};

async function decisionGate(h: ReturnType<typeof lifecycle>) {
  const claimed = (await createGetReadyTasksTool(h.mock.api).execute(
    "claim",
    { count: 1 },
    undefined,
    undefined,
    h.ctx,
  )) as { details: { error?: string } };
  expect(claimed.details.error).toBeUndefined();
  const waiting = (await createWorkflowGateTool(h.mock.api).execute(
    "decision",
    {
      action: "wait_for_decision",
      taskId: "t-1.1",
      decision: {
        question: "Which local delivery scope is approved?",
        whyUserOwned: "The user must select the delivery scope",
        spec: { version: 1, kind: "choice" },
        options: ["A: documentation", "B: local implementation"],
      },
    },
    undefined,
    undefined,
    h.ctx,
  )) as { details: { error?: string } };
  expect(waiting.details.error).toBeUndefined();
  expect(getBoard().workflowStatus).toBe("waiting_for_decision");
}

async function supervisedWait() {
  const advisor = vi.fn<Advisor>(async () => ({ advice: guide }));
  const h = lifecycle(advisor);
  startSupervisor(h.mock.api, h.ctx, "Complete the approved local work");
  await decisionGate(h);
  h.mock.sendMessage.mockClear();
  return { ...h, advisor };
}

describe("supervised human decision settlement", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
  });

  it("keeps a valid human wait without fault, advisor use, state changes or automatic wakeup", async () => {
    const h = await supervisedWait();
    const board = getBoard();
    const state = structuredClone(supervisorState());
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    await h.fire("agent_settled", { aborted: false });
    expect(supervisorState()).toEqual(state);
    expect(supervisorState()?.status).toBe("active");
    expect(getBoard()).toEqual(board);
    expect(h.advisor).not.toHaveBeenCalled();
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
    expect(await h.fire("tool_call", { toolName: "advance_tasks", input: {} })).toMatchObject({
      block: true,
    });
  });

  it("does not resume an untyped legacy gate from an exact ID and bare answer", async () => {
    const h = await supervisedWait();
    const decision = { ...getBoard().decision!, spec: undefined };
    setBoard({ ...getBoard(), decision });
    const state = structuredClone(supervisorState());
    await h.fire("agent_before_settle", BOUNDARY);
    await h.fire("agent_settled", { aborted: false });
    await h.command(`decide ${decision.id} B`);
    expect(getBoard()).toMatchObject({ workflowStatus: "waiting_for_decision", decision });
    expect(supervisorState()).toEqual(state);
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it("does not let recover approve a still-pending user decision", async () => {
    const h = await supervisedWait();
    const board = getBoard();
    await h.fire("agent_settled", { aborted: false });
    await h.command("recover");
    expect(getBoard()).toEqual(board);
    expect(supervisorState()?.status).toBe("active");
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it("retains native abort precedence and the unanswered decision", async () => {
    const h = await supervisedWait();
    const decision = getBoard().decision;
    await h.fire("agent_settled", { aborted: true });
    expect(supervisorState()).toMatchObject({ status: "paused", holdCause: "run_aborted" });
    expect(getBoard()).toMatchObject({ workflowStatus: "waiting_for_decision", decision });
    expect(h.mock.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ triggerTurn: true }),
    );
  });

  it.each(["missing", "orphan", "foreign", "pending", "reviewing"] as const)(
    "does not hide an inconsistent %s wait as healthy human waiting",
    async (problem) => {
      const h = await supervisedWait();
      if (problem === "missing") setBoard({ ...getBoard(), decision: undefined });
      if (problem === "orphan")
        setBoard({ ...getBoard(), decision: { ...getBoard().decision!, taskId: "unknown-task" } });
      if (problem === "foreign") supervisorState()!.sessionId = "other-session";
      if (problem === "pending") supervisorState()!.pending = true;
      if (problem === "reviewing") supervisorState()!.status = "reviewing";
      await h.fire("agent_settled", { aborted: false });
      expect(supervisorState()).toMatchObject({ status: "fault", holdCause: "interrupted" });
      expect(h.mock.sendMessage).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ triggerTurn: true }),
      );
    },
  );

  it("still faults on unexplained settlement without a human gate", async () => {
    const h = lifecycle();
    startSupervisor(h.mock.api, h.ctx, "Complete the approved local work");
    await h.fire("agent_settled", { aborted: false });
    expect(supervisorState()).toMatchObject({ status: "fault", holdCause: "interrupted" });
  });

  it.each(["paused", "fault", "stopped"] as const)(
    "does not clear a %s supervisor because a decision is pending",
    async (status) => {
      const h = await supervisedWait();
      if (status === "stopped") await h.command("stop");
      else holdSupervisor(h.mock.api, h.ctx, status, "Existing hold", "review_failed");
      const state = structuredClone(supervisorState());
      await h.fire("agent_settled", { aborted: false });
      expect(supervisorState()).toEqual(state);
    },
  );

  it("does not create supervision for a board-only decision wait", async () => {
    const h = lifecycle();
    await decisionGate(h);
    await h.fire("agent_settled", { aborted: false });
    expect(supervisorState()).toBeUndefined();
    expect(getBoard().workflowStatus).toBe("waiting_for_decision");
  });
});
