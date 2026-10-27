import { createEventBus } from "@earendil-works/pi-coding-agent";
import { expect, vi } from "vitest";
import { rmSync } from "node:fs";
import { goalFixture } from "./goal";
import { localProposal } from "./preflight";
import { submitAndPresentPreflight } from "../../preflight-human";
import { currentRuntime } from "../../runtime";
import { currentWorkOwner } from "../../control-journal";
import { adoptSupervisedMode } from "../../management-policy";
import { resetState } from "../../state";
import { setSessionScopeEnabled } from "../../scope";
import { startSupervisor } from "../../supervisor";
import {
  createWriteTasksTool,
  createCompileTasksTool,
  createGetReadyTasksTool,
  createAdvanceTasksTool,
  createWorkflowGateTool,
  createClearTasksTool,
} from "../../tools";

export async function completedReviewFixture(
  boardOnly: false | "legacy" = false,
  gitWorkspace: boolean | "uninitialized" = true,
) {
  const f = await executionRegistryFixture(boardOnly, { gitWorkspace });
  try {
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    const result = await createAdvanceTasksTool(f.api).execute(
      "complete-fixture",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Actual stable fixture check",
              refs: [
                {
                  kind: "command",
                  label: "Fixed validation",
                  status: "passed",
                  ref: "tool:repair-proof",
                  exitCode: 0,
                },
              ],
            },
          },
        ],
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return f;
  } catch (error) {
    f.close();
    throw error;
  }
}
export async function executionRegistryFixture(
  boardOnly: boolean | "legacy" = false,
  options: { gitWorkspace?: boolean | "uninitialized" } = {},
) {
  resetState();
  const f = await goalFixture({
    unsupervisedLegacy: boardOnly !== false,
    gitWorkspace: options.gitWorkspace,
  });
  // Persist explicit activation in this synthetic Session; a memory flag is not restored authority.
  setSessionScopeEnabled(false);
  await f.command("enable");
  if (!boardOnly) {
    vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
    await f.command("supervise Owned execution registry");
    if (!currentRuntime().preflight) {
      const diagnostic = JSON.stringify(vi.mocked(f.ctx.ui.notify).mock.calls);
      currentRuntime().cancel();
      f.restoreHost();
      throw new Error(
        `Owned scoped fixture did not enter planning; retained ${f.dir}; notices: ${diagnostic}`,
      );
    }
    await f.fire("agent_start");
    vi.mocked(f.ctx.ui.select).mockResolvedValue("允许上述范围");
    await submitAndPresentPreflight(
      f.api,
      f.ctx,
      "execution-proposal",
      currentRuntime().preflight!.preflightId,
      localProposal,
    );
    await f.fire("agent_settled", { type: "agent_settled", aborted: false });
    vi.mocked(f.ctx.ui.select).mockResolvedValue("开始执行");
    await f.command("start");
  }
  await createWriteTasksTool(f.api).execute(
    "write",
    {
      mode: "replace",
      phases: [
        {
          title: "One",
          tasks: [{ title: "Check", prompt: "Synthetic bounded input", profile: "main" }],
        },
      ],
    },
    undefined,
    undefined,
    f.ctx,
  );
  if (boardOnly === "legacy") {
    // Explicit compatibility adapter, not an implicit fresh-supervise shortcut.
    startSupervisor(f.api, f.ctx, "Synthetic legacy execution goal");
    adoptSupervisedMode(f.api, f.ctx);
  }
  await createCompileTasksTool(f.api).execute(
    "compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    f.ctx,
  );
  await createGetReadyTasksTool(f.api).execute("claim", { count: 1 }, undefined, undefined, f.ctx);
  const events = createEventBus();
  Object.assign(f.api, { events });
  const backend = {
    state: "running",
    runId: "owned-run",
    generation: "owned-generation",
    childState: undefined as string | undefined,
    statusQueries: 0,
  };
  events.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as { requestId: string; method: string };
    if (request.method === "status") backend.statusQueries++;
    const now = Date.now();
    const proof = {
      version: 1,
      state: backend.state === "running" ? "pending" : "observed",
      runId: backend.runId,
      runnerProcessInstanceId: backend.generation,
      observedAt: now,
      instances: [
        {
          kind: "runner",
          processInstanceId: backend.generation,
          closeObservedAt: now,
          exitCode: 0,
          signal: null,
        },
      ],
      resumeDisposition: "unavailable",
    };
    const data =
      request.method === "ping"
        ? {
            version: 1,
            methods: ["ping", "status"],
            session: { sessionId: "test-session", sessionFile: f.path },
            capabilities: {
              asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 },
              processTerminalProof: { version: 1, lifecycleArtifactVersion: 3 },
            },
            events: { asyncComplete: "subagent:async-complete" },
          }
        : {
            details: { runId: backend.runId, lifecycleStatus: { processTerminal: proof } },
            asyncSnapshot: {
              kind: "pi-subagents.async-status-snapshot",
              version: 1,
              generatedAt: now,
              omitted: { runs: 0, children: 0, byteLimitExceeded: false },
              runs: [
                {
                  id: backend.runId,
                  kind: "subagent",
                  state: backend.state,
                  children: [
                    { id: "step:0", kind: "step", state: backend.childState ?? backend.state },
                  ],
                },
              ],
            },
          };
    events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
      version: 1,
      requestId: request.requestId,
      method: request.method,
      success: true,
      data,
    });
  });
  const gate = createWorkflowGateTool(f.api);
  const executionRef = { source: "pi-subagents" as const, runId: "owned-run" };
  const invoke = (action: "bind_execution" | "clear_execution", ref = executionRef) =>
    gate.execute(
      action,
      { action, taskId: "t-1.1", executionRef: ref },
      undefined,
      undefined,
      f.ctx,
    );
  const review = () =>
    createAdvanceTasksTool(f.api).execute(
      "review",
      { transitions: [{ id: "t-1.1" }] },
      undefined,
      undefined,
      f.ctx,
    );
  const validate = async (id = "repair-proof") => {
    const tool = {
      toolCallId: id,
      toolName: "bash",
      input: { command: "synthetic repair validation" },
    };
    await f.fire("tool_call", { type: "tool_call", ...tool });
    await f.fire("tool_result", {
      type: "tool_result",
      ...tool,
      content: [{ type: "text", text: "Synthetic success" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
  };
  const resolve = (
    validationRefs = ["tool:repair-proof"],
    resolutionKind: "validated_repair" | "superseded_success" = "validated_repair",
    supersedingBindingId?: string,
  ) => {
    const settlementId =
      currentRuntime().controlJournal?.executionRegistry?.find((entry) => entry.settlement)
        ?.settlement?.data.settlementId ?? "no-settlement";
    return gate.execute(
      "resolve",
      {
        action: "resolve_execution",
        taskId: "t-1.1",
        resolution: {
          settlementId,
          resolutionKind,
          validationRefs,
          ...(supersedingBindingId ? { supersedingBindingId } : {}),
        },
      },
      undefined,
      undefined,
      f.ctx,
    );
  };
  return {
    ...f,
    backend,
    executionRef,
    invoke,
    get owner() {
      const owner = currentWorkOwner("test-session");
      if (!owner) throw Error("Missing fixture owner");
      return owner;
    },
    review,
    validate,
    resolve,
    clearBoard: () =>
      createClearTasksTool(f.api).execute("clear-board", {}, undefined, undefined, f.ctx),
    close: () => {
      currentRuntime().cancel();
      f.restoreHost();
      rmSync(f.dir, { recursive: true, force: true });
    },
  };
}
