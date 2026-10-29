import { startSupervisor } from "../supervisor";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, it } from "vitest";
import { getBoard, resetState, setBoard } from "../state";
import { setSessionScopeEnabled } from "../scope";
import { createWorkflowGateTool } from "../tools";
import { observeExecutionSettlement, type ExecutionGeneration } from "../execution-settlement";
import { activeBoard, lifecycle } from "./helpers/lifecycle";

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(true);
});
function ownedProtocol() {
  const h = lifecycle();
  const events = createEventBus();
  Object.assign(h.mock.api, { events });
  const now = Date.now();
  const proof = {
    version: 1,
    state: "observed",
    runId: "owned-run",
    runnerProcessInstanceId: "runner-generation-1",
    observedAt: now,
    instances: [
      {
        kind: "runner",
        processInstanceId: "runner-generation-1",
        closeObservedAt: now,
        exitCode: 0 as number | null,
        signal: null as string | null,
      },
    ],
    resumeDisposition: "unavailable",
  };
  const root = {
    id: "owned-run",
    kind: "subagent",
    state: "complete",
    children: [{ id: "step:0", kind: "step", state: "complete" }],
  };
  const ping = {
    version: 1,
    methods: ["ping", "status"],
    session: { sessionId: h.ctx.sessionManager.getSessionId(), sessionFile: null },
    capabilities: {
      asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
      processTerminalProof: { version: 1, lifecycleArtifactVersion: 3 },
    },
    events: { asyncComplete: "subagent:async-complete" },
  };
  const data = {
    details: { runId: "owned-run", lifecycleStatus: { processTerminal: proof } },
    asyncSnapshot: {
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      generatedAt: now,
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      runs: [root],
    },
  };
  const generation: ExecutionGeneration = {
    kind: "runner",
    runnerProcessInstanceId: "runner-generation-1",
  };
  events.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as { requestId: string; method: string; params: { id?: string } };
    if (request.method === "status") expect(request.params).toEqual({ id: "owned-run" });
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: true,
      data: request.method === "ping" ? ping : data,
    });
  });
  return {
    ...h,
    proof,
    root,
    ping,
    data,
    generation,
    observe: (expected: ExecutionGeneration | undefined = generation) =>
      observeExecutionSettlement(
        h.mock.api,
        h.ctx,
        { taskId: "t-1.1", source: "pi-subagents", runId: "owned-run" },
        new AbortController().signal,
        expected,
      ),
  };
}
function ownedWorkflow() {
  const h = ownedProtocol();
  h.root.kind = "workflow";
  h.root.children[0]!.id = "finite";
  h.proof.runId = "child-run";
  const inventory = {
    version: 1,
    workflowRunId: "owned-run",
    parentToolCallId: "owned-parent",
    inventoryComplete: true,
    workflowState: "completed",
    children: [{ childId: "finite", runId: "child-run", state: "completed" }],
  };
  const proof = {
    version: 1,
    kind: "workflow",
    runId: "owned-run",
    state: "observed",
    dispatchClosed: true,
    observedAt: Date.now(),
    children: [h.proof],
  };
  Object.assign(h.data.details, {
    mode: "single",
    lifecycleStatus: undefined,
    workflowChildren: inventory,
    workflowTerminalProof: proof,
  });
  const generation: ExecutionGeneration = { kind: "workflow", parentToolCallId: "owned-parent" };
  return {
    ...h,
    inventory,
    workflowProof: proof,
    workflowGeneration: generation,
    observeWorkflow: () =>
      observeExecutionSettlement(
        h.mock.api,
        h.ctx,
        { taskId: "t-1.1", source: "workflow", runId: "owned-run" },
        new AbortController().signal,
        generation,
      ),
  };
}
it("uses closed workflow inventory and exact child proofs instead of inventing a root runner", async () => {
  const h = ownedWorkflow();
  expect(await h.observeWorkflow()).toMatchObject({
    outcome: "success",
    writerEvidence: "observed",
    generation: h.workflowGeneration,
  });
});
it.each([
  "open-dispatch",
  "incomplete-inventory",
  "wrong-parent",
  "missing-proof",
  "extra-proof",
  "wrong-child-run",
  "wrong-instance",
  "host-step",
  "wrong-capability",
  "empty-inventory",
])("holds workflow %s without guessing a writer", async (kind) => {
  const h = ownedWorkflow();
  if (kind === "open-dispatch") h.workflowProof.dispatchClosed = false;
  if (kind === "incomplete-inventory") h.inventory.inventoryComplete = false;
  if (kind === "wrong-parent") h.inventory.parentToolCallId = "different-parent";
  if (kind === "missing-proof") h.workflowProof.children = [];
  if (kind === "extra-proof") h.workflowProof.children.push({ ...h.proof, runId: "extra-run" });
  if (kind === "wrong-child-run") h.proof.runId = "another-child";
  if (kind === "wrong-instance") h.proof.instances[0]!.processInstanceId = "another-instance";
  if (kind === "host-step") h.root.children[0]!.kind = "host-step";
  if (kind === "wrong-capability") h.ping.capabilities.processTerminalProof.version = 2;
  if (kind === "empty-inventory") {
    h.inventory.children = [];
    h.workflowProof.children = [];
    h.root.children = [];
  }
  expect((await h.observeWorkflow()).outcome).toBe("unknown");
});
it("recognizes a same-generation complete snapshot with the qualified runner proof", async () => {
  const h = ownedProtocol();
  expect(await h.observe()).toMatchObject({
    outcome: "success",
    writerEvidence: "observed",
    generation: h.generation,
  });
});
it.each([
  "pending",
  "unknown",
  "wrong-run",
  "wrong-generation",
  "resumable",
  "wrong-capability",
  "extra-instance",
  "future-time",
  "bad-exit",
])("does not release with %s writer evidence", async (kind) => {
  const h = ownedProtocol();
  if (kind === "pending" || kind === "unknown") h.proof.state = kind;
  if (kind === "wrong-run") h.proof.runId = "another-run";
  if (kind === "wrong-generation") h.proof.runnerProcessInstanceId = "another-generation";
  if (kind === "resumable") h.proof.resumeDisposition = "available";
  if (kind === "wrong-capability") h.ping.capabilities.processTerminalProof.version = 2;
  if (kind === "extra-instance") h.proof.instances.push({ ...h.proof.instances[0]! });
  if (kind === "future-time") h.proof.observedAt = Date.now() + 60000;
  if (kind === "bad-exit") h.proof.instances[0]!.exitCode = 1;
  expect((await h.observe()).outcome).toBe("unknown");
});
it.each(["complete", "failed"])(
  "keeps a %s parent active while its child still runs",
  async (parent) => {
    const h = ownedProtocol();
    h.root.state = parent;
    h.root.children[0]!.state = "running";
    expect((await h.observe()).outcome).toBe("active");
  },
);
it.each(["failed", "partial", "rejected", "stopped", "paused"])(
  "does not relabel terminal %s as success",
  async (state) => {
    const h = ownedProtocol();
    h.root.state = state;
    expect((await h.observe()).outcome).toBe(
      state === "paused" ? "unknown" : state === "stopped" ? "cancelled" : "failure",
    );
  },
);
it.each(["foreign", "stale", "omitted", "missing-run"])(
  "rejects a %s owner snapshot",
  async (kind) => {
    const h = ownedProtocol();
    if (kind === "foreign") h.ping.session.sessionId = "different-session";
    if (kind === "stale") h.data.asyncSnapshot.generatedAt = Date.now() - 20000;
    if (kind === "omitted") h.data.asyncSnapshot.omitted.children = 1;
    if (kind === "missing-run") h.data.asyncSnapshot.runs = [];
    await expect(h.observe()).rejects.toThrow();
  },
);
it("keeps an active owner-confirmed Run bound when clear_execution is requested", async () => {
  const h = ownedProtocol();
  h.root.state = "running";
  const board = activeBoard();
  board.tasks[0]!.status = "implementing";
  setBoard(board);
  startSupervisor(h.mock.api, h.ctx, "Finish synthetic authorized work");
  const tool = createWorkflowGateTool(h.mock.api);
  const executionRef = { source: "pi-subagents" as const, runId: "owned-run" };
  expect(
    (
      await tool.execute(
        "bind",
        { action: "bind_execution", taskId: "t-1.1", executionRef },
        undefined,
        undefined,
        h.ctx,
      )
    ).isError,
  ).not.toBe(true);
  const clear = await tool.execute(
    "clear",
    { action: "clear_execution", taskId: "t-1.1", executionRef },
    undefined,
    undefined,
    h.ctx,
  );
  expect(clear.isError).toBe(true);
  expect(getBoard().tasks[0]?.executionRef).toEqual(executionRef);
});
