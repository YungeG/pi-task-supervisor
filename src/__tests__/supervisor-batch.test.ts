import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

async function completeFirstBatch(advice: Advice) {
  const h = lifecycle();
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

  it("rejects current-batch advice at the next-batch checkpoint instead of forwarding contradictory stop text", async () => {
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
    expect(h.streamSimple).toHaveBeenCalledOnce();
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
      expect(supervisorState()!.continuations).toBe(0);
      expect(getBoard().workflowStatus).toBe("paused");
    },
  );
});
