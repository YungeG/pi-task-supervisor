import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentRuntime } from "../runtime";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import { supervisorState, type Advice } from "../supervisor";
import { createAdvanceTasksTool, createGetReadyTasksTool } from "../tools";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";

const stopMessage = "本批已经完成。现在整体暂停，不领取下一批任务，等待用户确认。";
const legacyGuide: Advice = {
  action: "guide",
  message: stopMessage,
  taskIds: ["t-1.1"],
  evidenceRefs: ["tool:batch-validation"],
};

async function completeFirstBatch(advice: Advice, third = false) {
  const h = lifecycle();
  if (third) {
    const board = getBoard();
    board.tasks.push({
      ...board.tasks[1]!,
      id: "t-3.1",
      title: "Third",
      phase: 3,
      dependencies: ["t-2.1"],
      status: "configured",
    });
    board.phases.push({ phase: 3, title: "Third", status: "pending" });
    board.finalAcceptanceTaskId = "t-3.1";
    setBoard(board);
  }
  const streamSimple = vi.fn((_model: unknown, _context: { messages: { content: string }[] }) => ({
    result: async () => fauxAssistantMessage(JSON.stringify(advice)),
  }));
  Object.assign(h.ctx, {
    modelRegistry: { find: () => h.ctx.model, streamSimple },
  });
  await h.command("supervise Complete both approved batches without repeated confirmation");
  const claim = createGetReadyTasksTool(h.mock.api);
  const advance = createAdvanceTasksTool(h.mock.api);
  expect(
    (await claim.execute("claim-first", { count: 1 }, undefined, undefined, h.ctx)).details,
  ).not.toHaveProperty("error");
  expect(
    (
      await advance.execute(
        "review-first",
        { transitions: [{ id: "t-1.1" }] },
        undefined,
        undefined,
        h.ctx,
      )
    ).details,
  ).not.toHaveProperty("error");
  await h.fire("tool_result", {
    type: "tool_result",
    toolCallId: "batch-validation",
    toolName: "bash",
    input: { command: "synthetic batch validation" },
    content: [{ type: "text", text: "Batch checks passed" }],
    structuredContent: { exit_code: 0 },
    details: {},
    isError: false,
  });
  expect(
    (
      await advance.execute(
        "finish-first",
        {
          transitions: [
            {
              id: "t-1.1",
              evidence: {
                summary: "First batch verified",
                refs: [
                  {
                    kind: "command",
                    label: "batch checks",
                    ref: "tool:batch-validation",
                    status: "passed",
                    exitCode: 0,
                  },
                ],
              },
            },
          ],
        },
        undefined,
        undefined,
        h.ctx,
      )
    ).details,
  ).not.toHaveProperty("error");
  expect(getBoard()).toMatchObject({
    workflowStatus: "active",
    tasks: [
      { id: "t-1.1", status: "done" },
      { id: "t-2.1", status: "ready" },
      ...(third ? [{ id: "t-3.1", status: "configured" }] : []),
    ],
  });
  return { ...h, streamSimple, claim };
}

describe("host-controlled batch continuation", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
  });

  it("corrects one legal batch-action mismatch within the same budget and never forwards its prose", async () => {
    const h = await completeFirstBatch(legacyGuide);
    h.streamSimple
      .mockImplementationOnce(() => ({
        result: async () => fauxAssistantMessage(JSON.stringify(legacyGuide)),
      }))
      .mockImplementationOnce(() => ({
        result: async () =>
          fauxAssistantMessage(
            JSON.stringify({ ...legacyGuide, action: "next_batch", taskIds: ["t-2.1"] }),
          ),
      }));
    h.mock.sendMessage.mockClear();
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result).toMatchObject({
      continue: true,
      entries: [{ details: { action: "next_batch" } }],
    });
    expect(JSON.stringify(result)).not.toContain(stopMessage);
    expect(h.streamSimple).toHaveBeenCalledTimes(2);
    // Fileless compatibility has no durable extra-call ledger, so its second call consumes another review slot.
    expect(supervisorState()).toMatchObject({ status: "active", reviews: 2, continuations: 1 });
  });

  it("does not hand off a done-looking batch after its native completion bindings disappear", async () => {
    const h = await completeFirstBatch({
      ...legacyGuide,
      action: "next_batch",
      taskIds: ["t-2.1"],
    });
    const state = supervisorState();
    if (!state) throw Error("Supervisor missing");
    state.bindings = [];
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(h.streamSimple).not.toHaveBeenCalled();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      continuations: 0,
      reason: expect.stringContaining("completed-task bindings"),
    });
  });
  it("does not buy an action correction after the original review budget is spent", async () => {
    const h = await completeFirstBatch(legacyGuide);
    const state = supervisorState();
    if (!state) throw Error("Supervisor missing");
    state.reviews = 39;
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(h.streamSimple).toHaveBeenCalledOnce();
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "budget_exhausted",
      reviews: 40,
      continuations: 0,
    });
  });
  it("does not correct another semantic violation hidden behind a wrong batch action", async () => {
    const h = await completeFirstBatch({ ...legacyGuide, detailIds: ["invented-detail"] });
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(h.streamSimple).toHaveBeenCalledOnce();
    expect(supervisorState()).toMatchObject({ status: "fault", continuations: 0 });
  });
  it("discards a wrong action if its captured board facts changed before the response", async () => {
    const h = await completeFirstBatch(legacyGuide);
    h.streamSimple.mockImplementationOnce(() => ({
      result: async () => {
        const board = getBoard();
        board.generation++;
        setBoard(board);
        return fauxAssistantMessage(JSON.stringify(legacyGuide));
      },
    }));
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(h.streamSimple).toHaveBeenCalledOnce();
    expect(supervisorState()?.continuations).toBe(0);
  });
  it("hands off a later mechanically ready batch without another provider call after its unchanged plan was reviewed", async () => {
    const h = await completeFirstBatch(
      { ...legacyGuide, action: "next_batch", taskIds: ["t-2.1"] },
      true,
    );
    expect(await h.fire("agent_before_settle", BOUNDARY)).toMatchObject({ continue: true });
    await h.claim.execute("claim-second", { count: 1 }, undefined, undefined, h.ctx);
    const advance = createAdvanceTasksTool(h.mock.api);
    expect(
      (
        await advance.execute(
          "review-second",
          { transitions: [{ id: "t-2.1" }] },
          undefined,
          undefined,
          h.ctx,
        )
      ).isError,
    ).not.toBe(true);
    await h.fire("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "second-proof",
      input: { command: "synthetic second validation" },
      content: [{ type: "text", text: "passed" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    expect(
      (
        await advance.execute(
          "finish-second",
          {
            transitions: [
              {
                id: "t-2.1",
                evidence: {
                  summary: "Second verified",
                  refs: [
                    {
                      kind: "command",
                      label: "second",
                      status: "passed",
                      ref: "tool:second-proof",
                      exitCode: 0,
                    },
                  ],
                },
              },
            ],
          },
          undefined,
          undefined,
          h.ctx,
        )
      ).isError,
    ).not.toBe(true);
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result).toMatchObject({
      continue: true,
      entries: [{ details: { action: "next_batch" } }],
    });
    expect(JSON.stringify(result)).toContain("t-3.1");
    expect(h.streamSimple).toHaveBeenCalledOnce();
    expect(supervisorState()).toMatchObject({ reviews: 1, continuations: 2 });
  });

  it("blocks a repeated batch-action mismatch after one correction without forwarding contradictory stop text", async () => {
    const h = await completeFirstBatch(legacyGuide);
    h.mock.sendMessage.mockClear();
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      holdCause: "review_failed",
      continuations: 0,
      stagnant: 0,
      pending: false,
    });
    expect(getBoard().tasks[1]!.status).toBe("ready");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(h.streamSimple).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(h.mock.sendMessage.mock.calls)).not.toContain(stopMessage);
  });

  it("starts the next batch from host control without forwarding contradictory advisor prose", async () => {
    const h = await completeFirstBatch({
      ...legacyGuide,
      action: "next_batch",
      taskIds: ["t-2.1"],
    });
    h.mock.sendMessage.mockClear();
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result).toMatchObject({
      continue: true,
      entries: [
        {
          customType: "continuous-tasks:continue",
          content: expect.stringContaining("get_ready_tasks"),
          details: { action: "next_batch" },
        },
      ],
    });
    expect(result.entries[0].content).toContain("not a goal pause");
    expect(result.entries[0].content).not.toContain(stopMessage);
    expect(JSON.stringify(h.mock.sendMessage.mock.calls)).not.toContain(stopMessage);
    const packet = JSON.parse(h.streamSimple.mock.calls[0]![1].messages[0]!.content);
    expect(packet.batch).toMatchObject({ claimedTaskIds: [], readyTaskIds: ["t-2.1"] });
    expect(
      (await h.claim.execute("claim-next", { count: 1 }, undefined, undefined, h.ctx)).details,
    ).not.toHaveProperty("error");
    expect(getBoard().tasks[1]!.status).toBe("implementing");
    expect(supervisorState()).toMatchObject({
      status: "active",
      continuations: 1,
      stagnant: 0,
    });
  });

  it("holds the entire goal immediately when the structured action is hold, not at the stagnation limit", async () => {
    const h = await completeFirstBatch({ ...legacyGuide, action: "hold" });
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "paused",
      holdCause: "advisor_hold",
      reason: stopMessage,
      continuations: 0,
      stagnant: 0,
    });
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(h.streamSimple).toHaveBeenCalledOnce();
    expect(getBoard().tasks[1]!.status).toBe("ready");
  });

  it("keeps guide for a claimed batch without claiming another one", async () => {
    const message = "Inspect the claimed acceptance task and collect fresh validation";
    const h = await completeFirstBatch({
      ...legacyGuide,
      message,
      taskIds: ["t-2.1"],
    });
    await h.claim.execute("claim-next", { count: 1 }, undefined, undefined, h.ctx);
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result).toMatchObject({
      continue: true,
      entries: [{ content: expect.stringContaining(message), details: { action: "guide" } }],
    });
    expect(getBoard().tasks[1]!.status).toBe("implementing");
    expect(
      (await h.claim.execute("overlap", { count: 1 }, undefined, undefined, h.ctx)).details,
    ).toHaveProperty("error", expect.stringContaining("implementing or reviewing"));
  });

  it.each(["claimed", "unresolved", "finished-target", "empty-targets", "no-ready", "completed"])(
    "rejects next_batch with incompatible host state: %s",
    async (kind) => {
      const advice: Advice = { ...legacyGuide, action: "next_batch", taskIds: ["t-2.1"] };
      if (kind === "finished-target") advice.taskIds = ["t-1.1"];
      if (kind === "empty-targets") advice.taskIds = [];
      const h = await completeFirstBatch(advice);
      if (kind === "claimed")
        await h.claim.execute("claim-next", { count: 1 }, undefined, undefined, h.ctx);
      const board = getBoard();
      if (kind === "unresolved")
        board.tasks[0]!.executionRef = { source: "pi-subagents", runId: "unknown-old-run" };
      if (kind === "no-ready") board.tasks[1]!.status = "configured";
      if (kind === "completed") {
        board.tasks[1]!.status = "done";
        board.workflowStatus = "completed";
      }
      setBoard(board);
      expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      expect(supervisorState()).toMatchObject({
        status: "fault",
        continuations: 0,
        stagnant: 0,
        pending: false,
      });
    },
  );

  it.each(["pause maintenance", "stop"])(
    "never lets next_batch override explicit user control: %s",
    async (command) => {
      const h = await completeFirstBatch({
        ...legacyGuide,
        action: "next_batch",
        taskIds: ["t-2.1"],
      });
      await h.command(command);
      expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      expect(h.streamSimple).not.toHaveBeenCalled();
      expect(currentRuntime().supervisor!.continuations).toBe(0);
      if (command === "stop") expect(supervisorState()).toBeUndefined();
      expect(getBoard().workflowStatus).toBe("paused");
    },
  );
});
