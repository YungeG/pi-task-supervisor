import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { getBoard, resetState, setBoard } from "../state";
import { supervisorState, SUPERVISOR_ENTRY, type Advice } from "../supervisor";
import { createAdvanceTasksTool } from "../tools";
import type { CompletionEvidence } from "../types";
import { activeBoard, ACTIVATION, BOUNDARY, getHandler, lifecycle } from "./helpers/lifecycle";
import { attachMockJournal, createMockContext } from "./helpers/mocks";

const proof: CompletionEvidence = {
  summary: "Fresh validation",
  refs: [
    { kind: "command", label: "tests", ref: "tool:validation", status: "passed", exitCode: 0 },
  ],
};
const accept: Advice = {
  action: "accept",
  message: "Goal verified",
  taskIds: ["t-1.1"],
  evidenceRefs: ["tool:validation"],
};
const single = () =>
  activeBoard({
    finalAcceptanceTaskId: "t-1.1",
    tasks: [{ ...activeBoard().tasks[0]!, status: "reviewing" }],
    phases: [{ phase: 1, status: "active" }],
  });
function event(id = "validation", toolName = "bash"): ToolResultEvent {
  return {
    type: "tool_result",
    toolCallId: id,
    toolName,
    input: { command: "npm test" },
    content: [{ type: "text", text: "Passed" }],
    details: {},
    structuredContent: { exit_code: 0 },
    isError: false,
  };
}
async function ready(advice: Advice = accept) {
  const h = lifecycle(async () => ({ advice }));
  setBoard(single());
  await h.command("supervise Complete and verify approved work");
  await h.fire("tool_result", event());
  const result = await createAdvanceTasksTool(h.mock.api).execute(
    "done",
    { transitions: [{ id: "t-1.1", evidence: proof }] },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.details).not.toHaveProperty("error");
  return h;
}

describe("complete acceptance, not a percentage heuristic", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
  });

  it("accepts only a complete host-validated board and persists acceptance across restart", async () => {
    const h = await ready();
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "completed",
      pending: false,
      acceptedDigest: expect.any(String),
    });
    await h.fire("agent_settled", { aborted: false });
    expect(supervisorState()?.status).toBe("completed");
    const saved = structuredClone(supervisorState()!);
    const ctx = createMockContext([
      ACTIVATION,
      { type: "custom", customType: "continuous-tasks:snapshot", data: getBoard() },
      { type: "custom", customType: SUPERVISOR_ENTRY, data: saved },
    ]);
    await getHandler(h.mock, "session_start")({}, ctx);
    expect(supervisorState()?.status).toBe("completed");
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "continuous-supervisor",
      "Supervisor: completed (0/20 resumes)",
    );
    expect(
      await h.fire("tool_call", { toolName: "write_tasks", input: { mode: "append" } }),
    ).toMatchObject({ block: true });
  });

  it("requires acceptance advice to cite real host evidence", async () => {
    const h = await ready({ ...accept, evidenceRefs: [] });
    await h.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("must cite"),
    });
  });

  it.each([false, true])(
    "rejects acceptance citations to unbound or failed host receipts (failed=%s)",
    async (failed) => {
      const h = await ready({ ...accept, evidenceRefs: ["tool:unbound-read"] });
      await h.fire("tool_result", { ...event("unbound-read", "read"), isError: failed });
      await h.fire("agent_before_settle", BOUNDARY);
      expect(supervisorState()).toMatchObject({
        status: "fault",
        reason: expect.stringContaining("bound successful"),
      });
    },
  );

  it("invalidates final validation after a potentially mutating host tool", async () => {
    const h = await ready();
    await h.fire("tool_result", event("later-edit", "edit"));
    await h.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("stale"),
    });
    await h.command("recover");
    expect(supervisorState()?.status).toBe("fault");
  });

  it("revokes accepted work visibly if later tools can have changed it", async () => {
    const h = await ready();
    await h.fire("agent_before_settle", BOUNDARY);
    await h.fire("tool_result", event("post-accept-write", "write"));
    expect(supervisorState()).toMatchObject({ status: "fault", acceptedDigest: undefined });
  });

  it("does not repeat an old acceptance warning when a later result has a different evidence error", async () => {
    const h = await ready();
    await h.fire("agent_before_settle", BOUNDARY);
    await h.fire("tool_result", event("post-accept-write", "write"));
    h.mock.sendMessage.mockClear();
    const result = await getHandler(h.mock, "tool_result")(event("orphan-result", "write"), h.ctx);
    expect(h.mock.sendMessage).not.toHaveBeenCalled();
    expect(result.content.at(-1).text).toContain("Unmatched or late host result");
    expect(result.structuredContent).toEqual({ exit_code: 0 });
    expect(supervisorState()!.status).toBe("fault");
  });

  it("cannot restore accepted work after a mutation intent even when its result was never captured", async () => {
    const h = await ready();
    await h.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()!.status).toBe("completed");
    await h.fire("tool_call", {
      toolCallId: "after-acceptance-intent",
      toolName: "write",
      input: { path: "fixture" },
    });
    expect(supervisorState()!.acceptedDigest).toBeUndefined();
    const ctx = createMockContext(h.ctx.sessionManager.getBranch());
    attachMockJournal(h.mock, ctx);
    await getHandler(h.mock, "session_start")({}, ctx);
    expect(supervisorState()).toMatchObject({ status: "fault", acceptedDigest: undefined });
    await h.command("recover");
    expect(supervisorState()!.status).toBe("fault");
  });

  it("rejects journal acceptance when the task board no longer matches", async () => {
    const h = await ready();
    await h.fire("agent_before_settle", BOUNDARY);
    const saved = structuredClone(supervisorState()!);
    const board = getBoard();
    board.tasks[0]!.title = "Different task";
    const ctx = createMockContext([
      ACTIVATION,
      { type: "custom", customType: "continuous-tasks:snapshot", data: board },
      { type: "custom", customType: SUPERVISOR_ENTRY, data: saved },
    ]);
    await getHandler(h.mock, "session_start")({}, ctx);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("does not match"),
    });
  });

  it("cannot inherit another session's supervisor even if the board is forked", async () => {
    const h = await ready();
    const ctx = createMockContext([
      ACTIVATION,
      {
        type: "custom",
        customType: SUPERVISOR_ENTRY,
        data: { ...supervisorState()!, sessionId: "source-session" },
      },
    ]);
    await getHandler(h.mock, "session_tree")({}, ctx);
    expect(supervisorState()).toBeUndefined();
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("continuous-supervisor", undefined);
  });

  it.each(["abandoned", "execution", "uncovered", "missing-proof", "changed-task"])(
    "rejects incomplete acceptance: %s",
    async (kind) => {
      const h = await ready();
      const board = getBoard();
      if (kind === "abandoned") board.tasks[0]!.status = "abandoned";
      if (kind === "execution")
        board.tasks[0]!.executionRef = { source: "pi-subagents", runId: "still-running" };
      if (kind === "uncovered") board.tasks.push({ ...board.tasks[0]!, id: "t-1.2" });
      if (kind === "missing-proof") supervisorState()!.bindings = [];
      if (kind === "changed-task") board.tasks[0]!.prompt = "Changed scope";
      setBoard(board);
      await h.fire("agent_before_settle", BOUNDARY);
      expect(supervisorState()?.status).toBe("fault");
    },
  );

  it("preserves real receipts through compaction and an interrupted restart", async () => {
    const h = lifecycle(async () => ({ advice: { ...accept, action: "guide" } }));
    setBoard(single());
    await h.command("supervise Complete approved work");
    await h.fire("tool_result", event());
    await h.fire("session_before_compact");
    const ctx = createMockContext([
      ...h.ctx.sessionManager.getBranch(),
      { type: "custom", customType: "continuous-tasks:snapshot", data: getBoard() },
    ]);
    attachMockJournal(h.mock, ctx);
    await getHandler(h.mock, "session_start")({}, ctx);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      goal: "Complete approved work",
      receipts: [{ id: "tool:validation", exitCode: 0 }],
    });
    await h.command("recover");
    const result = await createAdvanceTasksTool(h.mock.api).execute(
      "done",
      { transitions: [{ id: "t-1.1", evidence: proof }] },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details).not.toHaveProperty("error");
  });
});
