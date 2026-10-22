import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import { supervisorState, type Advisor, type Advice } from "../supervisor";
import { activeBoard, BOUNDARY, deferred, lifecycle } from "./helpers/lifecycle";

const guide: Advice = {
  action: "next_batch",
  message: "Finish the approved implementation and validation",
  taskIds: ["t-1.1"],
  evidenceRefs: [],
};

describe("native supervisor continuation and compaction", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
  });

  it("returns host next-batch control through a native boundary, never as a user message", async () => {
    const advisor = vi.fn<Advisor>(async () => ({ advice: guide }));
    const h = lifecycle(advisor);
    await h.command("supervise Finish and verify the approved work");
    h.mock.sendMessage.mockClear();
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result).toMatchObject({
      continue: true,
      entries: [
        {
          type: "custom_message",
          customType: "continuous-tasks:continue",
          display: false,
          content: expect.stringContaining("NOT USER APPROVAL"),
        },
      ],
    });
    expect(result.entries[0].content).toContain("get_ready_tasks");
    expect(result.entries[0].content).not.toContain(guide.message);
    expect(h.mock.sendUserMessage).not.toHaveBeenCalled();
    expect(supervisorState()).toMatchObject({ status: "active", pending: true, continuations: 1 });
  });

  it("preserves the durable goal through compaction before the settlement boundary", async () => {
    const advisor = vi.fn<Advisor>(async () => ({ advice: guide }));
    const h = lifecycle(advisor);
    await h.command("supervise Finish and verify the approved work");
    await h.fire("session_before_compact");
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result?.continue).toBe(true);
    expect(advisor.mock.calls[0]?.[0]).toContain("Finish and verify the approved work");
    expect(getBoard()).toEqual(activeBoard());
    expect(supervisorState()?.status).toBe("active");
  });

  it("interrupts an in-flight review visibly and ignores its late result after compaction", async () => {
    const reply = deferred<Awaited<ReturnType<Advisor>>>();
    const h = lifecycle(() => reply.promise);
    await h.command("supervise Finish approved work");
    const pending = h.fire("agent_before_settle", BOUNDARY);
    await h.fire("session_before_compact");
    expect(await pending).toBeUndefined();
    reply.resolve({ advice: guide });
    await Promise.resolve();
    expect(supervisorState()).toMatchObject({ status: "fault", pending: false, continuations: 0 });
    expect(h.mock.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        display: true,
        content: expect.stringContaining("stale advice discarded"),
      }),
      { triggerTurn: false },
    );
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
  });

  it("reconciles a native abort during the boundary instead of leaving an active-idle supervisor", async () => {
    const h = lifecycle(async () => ({ advice: guide }));
    await h.command("supervise Finish approved work");
    await h.fire("agent_before_settle", BOUNDARY);
    await h.fire("agent_settled", { type: "agent_settled", aborted: true });
    expect(supervisorState()).toMatchObject({ status: "paused", pending: false });
    expect(getBoard().workflowStatus).toBe("paused");
  });

  it("faults visibly if Pi settles an unfinished supervisor instead of executing its continuation", async () => {
    const h = lifecycle(async () => ({ advice: guide }));
    await h.command("supervise Finish approved work");
    await h.fire("agent_before_settle", BOUNDARY);
    h.mock.sendMessage.mockClear();
    await h.fire("agent_settled", { type: "agent_settled", aborted: false });
    expect(supervisorState()).toMatchObject({ status: "fault", pending: false });
    expect(h.mock.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ display: true }),
      { triggerTurn: false },
    );
    expect(await h.fire("before_agent_start")).toBeUndefined();
  });

  it("does not act on settlement notifications outside an enabled supervised session", async () => {
    const h = lifecycle();
    setSessionScopeEnabled(false);
    await h.fire("agent_settled", { aborted: true });
    setSessionScopeEnabled(true);
    await h.fire("agent_settled", { aborted: false });
    expect(getBoard().workflowStatus).toBe("active");
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects advice whose session branch changed while the model was reviewing", async () => {
    const reply = deferred<Awaited<ReturnType<Advisor>>>();
    const h = lifecycle(() => reply.promise);
    await h.command("supervise Finish approved work");
    const pending = h.fire("agent_before_settle", BOUNDARY);
    vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue("different-branch");
    reply.resolve({ advice: guide });
    expect(await pending).toBeUndefined();
    expect(supervisorState()?.status).toBe("fault");
  });
});
