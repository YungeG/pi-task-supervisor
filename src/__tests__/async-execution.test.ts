import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerEventHandlers } from "../events";
import { registerCommands } from "../commands";
import { DEFAULT_CONFIG } from "../config";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import { supervisorState, type Advisor } from "../supervisor";
import { activeBoard, ACTIVATION, BOUNDARY, deferred, getHandler } from "./helpers/lifecycle";
import { createMockAPI, createMockContext } from "./helpers/mocks";

function fixture() {
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" } });
  Object.assign(ctx.sessionManager, { getSessionFile: vi.fn(() => undefined) });
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  const on = (name: string, listener: (value: unknown) => void) => {
    const listeners = handlers.get(name) ?? new Set();
    listeners.add(listener);
    handlers.set(name, listeners);
    return () => {
      listeners.delete(listener);
    };
  };
  const emit = (name: string, value: unknown) => {
    for (const listener of [...(handlers.get(name) ?? [])]) listener(value);
  };
  Object.assign(mock.api, { events: { on, emit } });
  const owner = {
    session: { sessionId: "test-session", sessionFile: null as string | null },
    runs: [{ id: "run-1", kind: "subagent", label: "worker", state: "running" }] as Record<
      string,
      unknown
    >[],
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    snapshot: {} as Record<string, unknown>,
    replyVersion: 1,
    enabled: true,
    delay: false,
  };
  const requests: { requestId: string; method: string; params: unknown }[] = [];
  const statusRequested = deferred<boolean>();
  let delayedReply: (() => void) | undefined;
  on("subagents:rpc:v1:request", (raw) => {
    const request = raw as (typeof requests)[number];
    requests.push(request);
    if (request.method === "status") statusRequested.resolve(true);
    const data =
      request.method === "ping"
        ? {
            version: 1,
            methods: ["ping", "status"],
            session: owner.session,
            events: { asyncComplete: "subagent:async-complete" },
            capabilities: {
              asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
            },
          }
        : {
            asyncSnapshot: {
              kind: "pi-subagents.async-status-snapshot",
              version: 1,
              generatedAt: Date.now(),
              omitted: owner.omitted,
              runs: owner.runs,
              ...owner.snapshot,
            },
          };
    const reply = () => {
      emit(`subagents:rpc:v1:reply:${request.requestId}`, {
        version: owner.replyVersion,
        requestId: request.requestId,
        method: request.method,
        success: true,
        data,
      });
    };
    if (!owner.enabled) return;
    if (owner.delay && request.method === "status") delayedReply = reply;
    else reply();
  });
  const advisor = vi.fn<Advisor>(async () => ({
    advice: {
      action: "guide",
      message: "Inspect authorized work",
      taskIds: ["t-1.1"],
      evidenceRefs: [],
    },
  }));
  registerEventHandlers(mock.api, async () => DEFAULT_CONFIG, advisor);
  registerCommands(mock.api);
  const command = mock.registerCommand.mock.calls[0]![1] as {
    handler: (args: string, context: typeof ctx) => Promise<void>;
  };
  return {
    mock,
    ctx,
    advisor,
    emit,
    owner,
    requests,
    statusRequested: statusRequested.promise,
    reply: () => delayedReply?.(),
    start: async () => {
      const board = activeBoard();
      board.tasks[0]!.status = "implementing";
      board.tasks[0]!.executionRef = { source: "pi-subagents", runId: "run-1" };
      setBoard(board);
      await command.handler("supervise Finish authorized work", ctx);
      return board;
    },
    command: (args: string) => command.handler(args, ctx),
    fire: (name: string, value: unknown = {}) => getHandler(mock, name)(value, ctx),
  };
}

describe("owned asynchronous execution wait", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for an owner-confirmed run without calling the advisor or spending continuation budget", async () => {
    const lane = fixture();
    const board = await lane.start();
    const before = structuredClone(supervisorState());

    expect(await lane.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(lane.advisor).not.toHaveBeenCalled();
    expect(supervisorState()).toMatchObject({
      reviews: before!.reviews,
      continuations: before!.continuations,
      stagnant: before!.stagnant,
      epoch: before!.epoch,
    });
    expect(getBoard()).toEqual(board);
    lane.fire("agent_settled", { aborted: false });
    expect(supervisorState()?.status).toBe("active");
  });

  it("does not renew a lease through repeated boundaries or count a known wait as stagnation", async () => {
    const lane = fixture();
    await lane.start();
    Object.assign(supervisorState()!, {
      continuations: 4,
      reviews: 5,
      stagnant: 2,
      pending: true,
      tokens: 42,
      cost: 1.5,
    });
    await lane.fire("agent_before_settle", BOUNDARY);
    const deadline = supervisorState()!.externalWait!.deadlineAt;
    await lane.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({
      reviews: 5,
      continuations: 4,
      stagnant: 2,
      tokens: 42,
      cost: 1.5,
      externalWait: { deadlineAt: deadline },
    });
    expect(lane.advisor).not.toHaveBeenCalled();
    expect(lane.requests.map((request) => request.method)).toEqual([
      "ping",
      "status",
      "ping",
      "status",
    ]);
  });

  it("leaves terminal results for Main without accepting tasks or duplicating the executor wake", async () => {
    const lane = fixture();
    const board = await lane.start();
    await lane.fire("agent_before_settle", BOUNDARY);
    lane.mock.sendMessage.mockClear();
    for (const sessionId of ["other-session", "test-session", "test-session"])
      lane.emit("subagent:async-complete", { sessionId, runId: "run-1", success: true });
    expect(supervisorState()!.externalWait!.phase).toBe("active");
    lane.owner.runs[0]!.state = "complete";
    await lane.fire("before_agent_start");
    await lane.fire("agent_before_settle", BOUNDARY);
    lane.fire("agent_settled", { aborted: false });
    expect(supervisorState()).toMatchObject({
      status: "active",
      externalWait: { phase: "results_pending" },
    });
    expect(getBoard()).toEqual(board);
    expect(lane.mock.sendMessage).not.toHaveBeenCalled();
    expect(lane.advisor).not.toHaveBeenCalled();
    const updated = getBoard();
    updated.tasks[0]!.executionRef = undefined;
    setBoard(updated);
    expect(await lane.fire("agent_before_settle", BOUNDARY)).toMatchObject({ continue: true });
    expect(lane.advisor).toHaveBeenCalledOnce();
  });

  it.each(["failed", "partial", "paused", "stopped", "rejected", "unknown"])(
    "fails closed on owner state %s without losing the existing run reference",
    async (state) => {
      const lane = fixture();
      const board = await lane.start();
      lane.owner.runs[0]!.state = state;
      expect(await lane.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      expect(supervisorState()?.status).toBe("fault");
      expect(getBoard()).toEqual(board);
      expect(lane.advisor).not.toHaveBeenCalled();
    },
  );

  it.each(["foreign", "missing", "truncated", "bad-reply"])(
    "does not trust %s status evidence",
    async (failure) => {
      const lane = fixture();
      await lane.start();
      if (failure === "foreign") lane.owner.session.sessionId = "other-session";
      if (failure === "missing") lane.owner.runs = [];
      if (failure === "truncated") lane.owner.omitted.children = 1;
      if (failure === "bad-reply") lane.owner.replyVersion = 2;
      await lane.fire("agent_before_settle", BOUNDARY);
      expect(supervisorState()?.status).toBe("fault");
      expect(supervisorState()?.externalWait).toBeUndefined();
      expect(lane.advisor).not.toHaveBeenCalled();
    },
  );

  it("does not infer completion when a workflow parent has only dispatched an active child", async () => {
    const lane = fixture();
    await lane.start();
    const board = getBoard();
    board.tasks[0]!.executionRef!.source = "workflow";
    setBoard(board);
    Object.assign(lane.owner.runs[0]!, {
      kind: "workflow",
      state: "complete",
      children: [{ id: "child-1", kind: "step", state: "running" }],
    });
    await lane.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()?.externalWait?.phase).toBe("active");
    expect(lane.advisor).not.toHaveBeenCalled();
  });

  it("cannot bypass exhausted budgets with a background run", async () => {
    const lane = fixture();
    await lane.start();
    supervisorState()!.reviews = 40;
    await lane.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "budget_exhausted",
      reviews: 40,
    });
    expect(lane.requests).toEqual([]);
  });

  it.each(["pause maintenance", "stop"])(
    "preserves %s when a completion arrives",
    async (command) => {
      const lane = fixture();
      await lane.start();
      await lane.fire("agent_before_settle", BOUNDARY);
      await lane.command(command);
      const before = structuredClone(supervisorState());
      lane.emit("subagent:async-complete", {
        sessionId: "test-session",
        runId: "run-1",
        success: true,
      });
      await lane.fire("agent_before_settle", BOUNDARY);
      expect(supervisorState()).toEqual(before);
      expect(getBoard().workflowStatus).toBe("paused");
      expect(lane.advisor).not.toHaveBeenCalled();
    },
  );

  it("expires a finite wait without querying the executor or waking Main", async () => {
    vi.useFakeTimers();
    const lane = fixture();
    const board = await lane.start();
    await lane.fire("agent_before_settle", BOUNDARY);
    lane.mock.sendMessage.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      holdCause: "interrupted",
      continuations: 0,
    });
    expect(getBoard()).toEqual(board);
    expect(lane.requests).toHaveLength(2);
    expect(
      lane.mock.sendMessage.mock.calls.every(([, options]) => options.triggerTurn === false),
    ).toBe(true);
    expect(lane.advisor).not.toHaveBeenCalled();
  });

  it("bounds unavailable owner lookup and disposes its reply listener", async () => {
    vi.useFakeTimers();
    const lane = fixture();
    await lane.start();
    lane.owner.enabled = false;
    const pending = lane.fire("agent_before_settle", BOUNDARY);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toBeUndefined();
    expect(supervisorState()?.status).toBe("fault");
    expect(lane.advisor).not.toHaveBeenCalled();
  });

  it("rejects status that arrives after a human pause", async () => {
    const lane = fixture();
    await lane.start();
    lane.owner.delay = true;
    const pending = lane.fire("agent_before_settle", BOUNDARY);
    await lane.statusRequested;
    await lane.command("pause maintenance");
    lane.reply();
    expect(await pending).toBeUndefined();
    expect(supervisorState()).toMatchObject({ status: "paused", holdCause: "user_pause" });
    expect(supervisorState()?.externalWait).toBeUndefined();
  });

  it.each([
    "session-file",
    "stale-clock",
    "non-finite-clock",
    "duplicate-id",
    "bad-kind",
    "bad-children",
    "too-deep",
    "wrong-source",
  ])("rejects %s owner evidence", async (failure) => {
    const lane = fixture();
    await lane.start();
    if (failure === "session-file") lane.owner.session.sessionFile = "/foreign/session.jsonl";
    if (failure === "stale-clock") lane.owner.snapshot.generatedAt = Date.now() - 60_000;
    if (failure === "non-finite-clock") lane.owner.snapshot.generatedAt = Number.NaN;
    if (failure === "duplicate-id") lane.owner.runs.push({ ...lane.owner.runs[0] });
    if (failure === "bad-kind") lane.owner.runs[0]!.kind = "unknown";
    if (failure === "bad-children") lane.owner.runs[0]!.children = {};
    if (failure === "too-deep") {
      let child = { id: "nested", kind: "step", state: "running" } as Record<string, unknown>;
      for (let depth = 0; depth < 6; depth++)
        child = { id: `nested-${depth}`, kind: "step", state: "running", children: [child] };
      lane.owner.runs[0]!.children = [child];
    }
    if (failure === "wrong-source") {
      const board = getBoard();
      board.tasks[0]!.executionRef!.source = "workflow";
      setBoard(board);
    }
    await lane.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()?.status).toBe("fault");
    expect(lane.advisor).not.toHaveBeenCalled();
  });

  it.each(["board", "epoch", "branch", "session"])(
    "rejects a delayed observation after %s changes",
    async (change) => {
      const lane = fixture();
      await lane.start();
      lane.owner.delay = true;
      const pending = lane.fire("agent_before_settle", BOUNDARY);
      await lane.statusRequested;
      if (change === "branch")
        vi.mocked(lane.ctx.sessionManager.getLeafId).mockReturnValue("changed-leaf");
      if (change === "epoch") supervisorState()!.epoch++;
      if (change === "board") {
        const board = getBoard();
        board.generation++;
        setBoard(board);
      }
      if (change === "session")
        vi.mocked(lane.ctx.sessionManager.getSessionId).mockReturnValue("other-session");
      lane.reply();
      await pending;
      expect(supervisorState()?.status).toBe("fault");
      expect(supervisorState()?.externalWait).toBeUndefined();
      expect(lane.advisor).not.toHaveBeenCalled();
    },
  );

  it("does not suppress legitimate Main work when part of the claimed batch is unbound", async () => {
    const lane = fixture();
    await lane.start();
    const board = getBoard();
    board.tasks[1]!.status = "implementing";
    setBoard(board);
    expect(await lane.fire("agent_before_settle", BOUNDARY)).toMatchObject({ continue: true });
    expect(lane.advisor).toHaveBeenCalledOnce();
    expect(lane.requests).toEqual([]);
  });

  it("keeps a real decision ahead of waiting and never resolves it from a notification", async () => {
    const lane = fixture();
    await lane.start();
    await lane.fire("agent_before_settle", BOUNDARY);
    const board = getBoard();
    board.workflowStatus = "waiting_for_decision";
    board.decision = {
      id: "approval-1",
      taskId: "t-1.1",
      question: "Approve?",
      whyUserOwned: "Requires human authority",
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    setBoard(board);
    lane.emit("subagent:async-complete", {
      sessionId: "test-session",
      runId: "run-1",
      success: true,
    });
    await lane.fire("agent_before_settle", BOUNDARY);
    expect(getBoard()).toEqual(board);
    expect(lane.requests).toHaveLength(2);
    expect(lane.advisor).not.toHaveBeenCalled();
    await lane.command("status");
    expect(lane.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("resolve approval-1"),
      "info",
    );
  });

  it("invalidates waiting during compaction without dispatching another run", async () => {
    const lane = fixture();
    await lane.start();
    await lane.fire("agent_before_settle", BOUNDARY);
    await lane.fire("session_before_compact");
    expect(supervisorState()).toMatchObject({ status: "fault", holdCause: "interrupted" });
    expect(supervisorState()?.externalWait).toBeUndefined();
    expect(lane.requests).toHaveLength(2);
  });

  it("locks recovery if the owner-confirmed wait cannot be persisted", async () => {
    const lane = fixture();
    const board = await lane.start();
    lane.mock.appendEntry.mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    expect(await lane.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()?.status).toBe("fault");
    expect(supervisorState()?.externalWait).toBeUndefined();
    await lane.command("recover");
    expect(supervisorState()?.status).toBe("fault");
    expect(getBoard()).toEqual(board);
    await lane.command("status");
    expect(lane.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("wait persistence failed"),
      "info",
    );
    expect(lane.advisor).not.toHaveBeenCalled();
  });

  it("fails closed and exposes a journal fault if expiry cannot be persisted", async () => {
    vi.useFakeTimers();
    const lane = fixture();
    await lane.start();
    await lane.fire("agent_before_settle", BOUNDARY);
    lane.mock.appendEntry.mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(supervisorState()?.status).toBe("fault");
    await lane.command("status");
    expect(lane.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("expiry persistence failed"),
      "info",
    );
  });

  it("restores an interrupted wait as fault without replaying or importing a foreign fork goal", async () => {
    const lane = fixture();
    const board = await lane.start();
    await lane.fire("agent_before_settle", BOUNDARY);
    const journal = structuredClone(supervisorState());
    vi.mocked(lane.ctx.sessionManager.getBranch).mockReturnValue([
      ACTIVATION,
      { type: "custom", customType: "continuous-tasks:snapshot", data: board },
      { type: "custom", customType: "continuous-tasks:supervisor", data: journal },
    ] as any);
    lane.mock.sendMessage.mockClear();
    await lane.fire("session_tree");
    expect(supervisorState()).toMatchObject({ status: "fault", holdCause: "interrupted" });
    expect(supervisorState()?.externalWait).toBeUndefined();
    vi.mocked(lane.ctx.sessionManager.getSessionId).mockReturnValue("forked-session");
    await lane.fire("session_start");
    expect(supervisorState()).toBeUndefined();
    expect(lane.requests).toHaveLength(2);
    expect(
      lane.mock.sendMessage.mock.calls.every(([, options]) => options.triggerTurn === false),
    ).toBe(true);
  });
});
