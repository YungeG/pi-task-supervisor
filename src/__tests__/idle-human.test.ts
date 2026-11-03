import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { IdleActionRequest, IdleActionResult, IdleMessage } from "../host-idle";
import {
  requestIdleHuman,
  seedIdleHuman,
  cancelIdleHuman,
  reconcileHumanContinuationTools,
  humanKernelStarted,
  settleHumanDeliveryFailure,
} from "../idle-human";
import { holdSupervisor, saveSupervisor } from "../supervisor";
import { getBoardRef } from "../state";
import { proposeAcceptanceContract } from "../acceptance-runtime";
import { proposeScopeRevision, reviewScopeRevisionNow } from "../scope-revision";
import { installCustomUI } from "./helpers/custom-ui";
import { createWriteTasksTool, createCompileTasksTool } from "../tools";
import { cloneBoard } from "../validation";
import { persistEntries, setBoard } from "../state";
import { readControlJournal, currentWorkOwner } from "../control-journal";
import { journalDigest } from "../human-journal";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import type { AcceptanceProposal } from "../acceptance-proposal";
import { beginPreflight } from "../preflight";
import { submitAndPresentPreflight } from "../preflight-human";
import { enterPlanningMode } from "../management-policy";
import { enableSessionScope } from "../scope";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { registerPendingUi } from "../pending-ui";
import { preflightLifecycle, localProposal } from "./helpers/preflight";

beforeEach(() => {
  cancelIdleHuman();
  resetState();
});
afterEach(() => vi.restoreAllMocks());

// This is the extension/public-H0 seam, not a second host scheduler or TTY proof.
it("requests independent Start after original permission, then runs only on the host lease", async () => {
  const h = preflightLifecycle();
  registerPendingUi(h.mock.api);
  const seed = h.mock.on.mock.calls.filter(([name]) => name === "session_start").at(-1)![1];
  await seed({}, h.ctx);
  const planning = beginPreflight(h.mock.api, h.ctx, "Owned first Start");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  const approval = await submitAndPresentPreflight(
    h.mock.api,
    h.ctx,
    "submit",
    planning.preflightId,
    localProposal,
  );
  expect(approval.status).toBe("approved");
  const permission = currentRuntime().preflight!.approval!.controlEntryId;
  const controller = new AbortController();
  let request: IdleActionRequest | undefined;
  let finish!: (result: IdleActionResult) => void;
  const result = new Promise<IdleActionResult>((resolve) => {
    finish = resolve;
  });
  const requestAction = vi.fn((value: IdleActionRequest) => {
    request = value;
    return {
      id: value.id,
      signal: controller.signal,
      result,
      cancel: () => {
        controller.abort();
      },
    };
  });
  Object.assign(h.ctx, {
    idleActions: {
      version: 1,
      state: () => ({ phase: "settling", pendingInputs: 1 }),
      request: requestAction,
    },
  });
  const settled = h.mock.on.mock.calls.filter(([name]) => name === "agent_settled").at(-1)![1];
  const before = h.ui.custom.mock.calls.length;
  await settled({ aborted: false }, h.ctx);
  expect(requestAction).toHaveBeenCalledOnce();
  expect(h.ui.custom.mock.calls).toHaveLength(before);
  expect(currentRuntime().preflight?.started).toBeUndefined();
  const leaseContext = Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(h.ctx),
      signal: { value: controller.signal },
      waitForIdle: {
        value: () => {
          throw new Error("No command wait in leased callback");
        },
      },
    },
  ) as ExtensionContext;
  const receipt = {
    status: "started" as const,
    actionId: request!.id,
    runId: randomUUID(),
    sessionId: "test-session",
  };
  const dispatch = vi.fn(async (_message: unknown, validate: () => boolean | Promise<boolean>) => {
    expect(await validate()).toBe(true);
    return receipt;
  });
  vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
    options.includes("开始执行") ? "开始执行" : "允许上述范围",
  );
  const sends = h.mock.sendMessage.mock.calls.length;
  const setters = h.mock.setActiveTools.mock.calls.length;
  await request!.run({
    id: request!.id,
    context: leaseContext,
    signal: controller.signal,
    isCurrent: () => true,
    dispatch,
  });
  finish(receipt);
  await result;
  expect(currentRuntime().preflight?.approval?.controlEntryId).toBe(permission);
  expect(currentRuntime().preflight?.started).toBeDefined();
  expect(h.mock.setActiveTools.mock.calls).toHaveLength(setters);
  expect(h.mock.sendMessage.mock.calls).toHaveLength(sends);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(h.ui.custom.mock.calls.length).toBeGreaterThan(before);
});

async function approved() {
  const h = preflightLifecycle();
  const planning = beginPreflight(h.mock.api, h.ctx, "Owned idle control");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("允许上述范围");
  expect(
    (
      await submitAndPresentPreflight(
        h.mock.api,
        h.ctx,
        "submit",
        planning.preflightId,
        localProposal,
      )
    ).status,
  ).toBe("approved");
  return h;
}

function capturedHost(ctx: ExtensionContext) {
  let finish!: (value: IdleActionResult) => void;
  let pending!: Promise<IdleActionResult>;
  let controller = new AbortController();
  let request!: IdleActionRequest;
  let phase: "busy" | "idle" | "settling" = "idle";
  let inputCount = 0;
  const requestAction = vi.fn((value: IdleActionRequest) => {
    request = value;
    controller = new AbortController();
    pending = new Promise<IdleActionResult>((resolve) => {
      finish = resolve;
    });
    return {
      id: value.id,
      signal: controller.signal,
      result: pending,
      cancel: () => {
        controller.abort();
      },
    };
  });
  Object.assign(ctx, {
    idleActions: {
      version: 1,
      state: () => ({ phase, pendingInputs: inputCount }),
      request: requestAction,
    },
  });
  return {
    requestAction,
    busy: () => {
      phase = "busy";
    },
    queued: () => {
      inputCount = 1;
    },
    run: async (
      behavior?: (
        validate: () => boolean | Promise<boolean>,
        controller: AbortController,
        receipt: Extract<IdleActionResult, { status: "started" }>,
      ) => Promise<IdleActionResult>,
    ) => {
      const leaseContext = Object.defineProperties(
        {},
        {
          ...Object.getOwnPropertyDescriptors(ctx),
          signal: { value: controller.signal },
          waitForIdle: {
            value: () => {
              throw Error("command-only wait");
            },
          },
        },
      ) as ExtensionContext;
      const receipt = {
        status: "started" as const,
        actionId: request.id,
        runId: randomUUID(),
        sessionId: ctx.sessionManager.getSessionId(),
      };
      let delivered: IdleActionResult | undefined;
      const dispatch = vi.fn(
        async (_message: IdleMessage, validate: () => boolean | Promise<boolean>) => {
          delivered = behavior
            ? await behavior(validate, controller, receipt)
            : (await validate())
              ? receipt
              : { status: "rejected", actionId: request.id, reason: "validation" };
          return delivered;
        },
      );
      await request.run({
        id: request.id,
        context: leaseContext,
        signal: controller.signal,
        isCurrent: () => !controller.signal.aborted,
        dispatch,
      });
      finish(delivered ?? { status: "completed", actionId: request.id });
      await pending;
      return { dispatch, receipt };
    },
  };
}

it.each(["error", "non-error"] as const)(
  "retains the single saved Start when dispatch rejects with %s, without replay",
  async (kind) => {
    const h = await approved(),
      host = capturedHost(h.ctx);
    vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
    const grant = structuredClone(currentRuntime().preflight!.approval),
      sends = h.mock.sendMessage.mock.calls.length;
    expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(true);
    await host.run(
      vi
        .fn()
        .mockRejectedValue(
          kind === "error"
            ? new Error("owned dispatch transport failed")
            : "untyped transport failure",
        ),
    );
    expect(currentRuntime().preflight?.approval).toEqual(grant);
    expect(currentRuntime().preflight?.started).toBeDefined();
    expect(["paused", "fault"]).toContain(currentRuntime().supervisor?.status);
    expect(h.mock.sendMessage.mock.calls).toHaveLength(sends);
    expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
    expect(host.requestAction).toHaveBeenCalledOnce();
  },
);

it("does not auto-repeat a deferred parent, but permits explicit native reopening", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("稍后启动");
  expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(true);
  const first = await host.run();
  expect(first.dispatch).not.toHaveBeenCalled();
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
  expect(host.requestAction).toHaveBeenCalledOnce();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  const second = await host.run();
  await manual;
  expect(second.dispatch).toHaveBeenCalledOnce();
  expect(currentRuntime().preflight?.started).toBeDefined();
});
it("seeds restored pending controls as history instead of opening old questions", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  seedIdleHuman(h.ctx);
  expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
  expect(host.requestAction).not.toHaveBeenCalled();
  expect(currentRuntime().preflight?.started).toBeUndefined();
});
it.each(["busy", "queued"] as const)(
  "does not queue a manual question behind %s host work",
  async (kind) => {
    const h = await approved(),
      host = capturedHost(h.ctx);
    host[kind]();
    expect(await requestIdleHuman(h.mock.api, h.ctx, "shortcut")).toBe(true);
    expect(host.requestAction).not.toHaveBeenCalled();
  },
);
it("leaves unsupported frontends and missing capabilities on the old display-only path", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  Object.assign(h.ctx, { mode: "rpc" });
  expect(await requestIdleHuman(h.mock.api, h.ctx, "shortcut")).toBe(false);
  expect(host.requestAction).not.toHaveBeenCalled();
});
it.each(["cancelled", "unknown", "rejected"] as const)(
  "retains a saved Start and enters the original hold on %s delivery",
  async (status) => {
    const h = await approved(),
      host = capturedHost(h.ctx);
    vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
    await requestIdleHuman(h.mock.api, h.ctx, "automatic");
    await host.run(async (_validate, controller, receipt) => {
      expect(currentRuntime().preflight?.started).toBeDefined();
      if (status === "cancelled") controller.abort();
      return { status, actionId: receipt.actionId };
    });
    expect(currentRuntime().preflight?.started).toBeDefined();
    expect(["paused", "fault"]).toContain(currentRuntime().supervisor?.status);
    expect(currentRuntime().supervisor?.reviews).toBe(0);
    expect(currentRuntime().supervisor?.continuations).toBe(0);
    const starts = h.entries.filter(
      (row) =>
        row.customType === "continuous-tasks:preflight-control" &&
        (row.data as { kind?: string }).kind === "start",
    );
    expect(starts).toHaveLength(1);
    expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
    expect(host.requestAction).toHaveBeenCalledOnce();
  },
);
it("rechecks the frozen post-control source before dispatch without refunding changed usage", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  await host.run(async (validate, _controller, receipt) => {
    currentRuntime().supervisor!.tokens = 17;
    expect(await validate()).toBe(false);
    return { status: "rejected", actionId: receipt.actionId, reason: "validation" };
  });
  expect(currentRuntime().supervisor?.tokens).toBe(17);
  expect(currentRuntime().preflight?.started).toBeDefined();
});
it("projects only its deferred original Start after logical start and consumes the marker once", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  const { dispatch } = await host.run();
  const before = h.mock.setActiveTools.mock.calls.length;
  const event = { messageType: "custom", message: dispatch.mock.calls[0]![0] };
  reconcileHumanContinuationTools(h.mock.api, event, h.ctx);
  expect(h.mock.setActiveTools.mock.calls).toHaveLength(before + 1);
  reconcileHumanContinuationTools(h.mock.api, event, h.ctx);
  expect(h.mock.setActiveTools.mock.calls).toHaveLength(before + 1);
});
it("holds an acknowledged preparation failure without a second Start or continuation", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  const { receipt } = await host.run();
  const start = structuredClone(currentRuntime().preflight!.started);
  expect(settleHumanDeliveryFailure(h.mock.api, { idleActionFailure: receipt }, h.ctx)).toBe(true);
  expect(currentRuntime().supervisor?.status).toBe("fault");
  expect(currentRuntime().preflight?.started).toEqual(start);
  expect(settleHumanDeliveryFailure(h.mock.api, { idleActionFailure: receipt }, h.ctx)).toBe(false);
});
it("aborts a failed native tool projection and does not mislabel it as the user's abort", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  const { dispatch } = await host.run();
  h.mock.setActiveTools.mockImplementationOnce(() => {
    throw Error("projection failed");
  });
  reconcileHumanContinuationTools(
    h.mock.api,
    { messageType: "custom", message: dispatch.mock.calls[0]![0] },
    h.ctx,
  );
  expect(h.ctx.abort).toHaveBeenCalledOnce();
  humanKernelStarted();
  expect(settleHumanDeliveryFailure(h.mock.api, { aborted: true }, h.ctx)).toBe(true);
  expect(currentRuntime().supervisor?.reason).not.toContain("user aborted");
  expect(currentRuntime().supervisor?.status).toBe("fault");
});

async function contractFixture(pending: boolean, start = true) {
  const h = preflightLifecycle(),
    root = dirname(h.path);
  const header = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0]!);
  writeFileSync(h.path, JSON.stringify({ ...header, cwd: root }) + "\n");
  h.ctx.cwd = root;
  writeFileSync(join(root, "input.txt"), "owned");
  const checker =
    "import unittest\nclass Output(unittest.TestCase):\n def test_output(self):\n  self.assertTrue(True)\n";
  if (!pending) writeFileSync(join(root, "test_output.py"), checker);
  const pref = beginPreflight(h.mock.api, h.ctx, "Original metadata fixture");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  const contract: AcceptanceProposal = {
    version: 1,
    scopeId: "idle-contract",
    inputs: ["input.txt"],
    artifacts: ["result.txt"],
    environment: { profileId: "owned", values: {} },
    requirements: [{ requirementId: "output", source: "original", text: "output", required: true }],
    checks: [
      {
        kind: "automatic",
        checkId: "output",
        requirementIds: ["output"],
        script: "test_output.py",
        checkerFiles: ["test_output.py"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        runtime: "python-unittest-v1",
        checkerRoot: root,
        permissionId: "A1",
        tests: ["test_output.Output.test_output"],
        expected: {
          minTests: 1,
          requiredCases: ["test_output.Output.test_output"],
          allowedSkipped: [],
        },
      },
    ],
  };
  const proposed = proposeAcceptanceContract(h.mock.api, h.ctx, contract);
  const plan = {
    ...localProposal,
    permissions: localProposal.permissions.map((permission) =>
      permission.id === "A1" ? { ...permission, target: root } : permission,
    ),
    contractProposalId: proposed.proposalId,
    ...(pending
      ? {
          preparation: {
            checkIds: ["output"],
            permissionIds: ["A1"],
            steps: ["Create test_output.py"],
          },
        }
      : {}),
  };
  const approval = await submitAndPresentPreflight(
    h.mock.api,
    h.ctx,
    "submit",
    pref.preflightId,
    plan,
  );
  expect(approval.status).toBe("approved");
  if (start) {
    await h.command("start");
    expect(currentRuntime().preflight?.started).toBeDefined();
  }
  if (pending) writeFileSync(join(root, "test_output.py"), checker);
  return { ...h, root, contract, plan };
}
it("offers missing declared required permissions after a partial grant, not missing optional effects", async () => {
  const h = preflightLifecycle(),
    pref = beginPreflight(h.mock.api, h.ctx, "Complete original required permissions");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  const proposal = {
    ...localProposal,
    permissions: [
      ...localProposal.permissions.map((p) => ({ ...p, required: true })),
      { ...localProposal.permissions[1]!, id: "A3", required: false },
    ],
  };
  expect(
    (await submitAndPresentPreflight(h.mock.api, h.ctx, "submit", pref.preflightId, proposal))
      .status,
  ).toBe("deferred");
  await h.command(`approve ${currentRuntime().preflight!.planId} A1`);
  expect(currentRuntime().preflight?.approval?.permissionIds).toEqual(["A1"]);
  const host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
    options.includes("开始执行") ? "稍后启动" : "允许上述范围",
  );
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  const { dispatch } = await host.run();
  await manual;
  expect(currentRuntime().preflight?.approval?.permissionIds).toEqual(["A1", "A2"]);
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(dispatch).not.toHaveBeenCalled();
});

it("reopens permissions and asks a distinct Start in the same lease, never through legacy sending", async () => {
  const h = preflightLifecycle();
  const pref = beginPreflight(h.mock.api, h.ctx, "Permission then independent Start");
  enableSessionScope(h.mock.api);
  enterPlanningMode(h.mock.api, h.ctx);
  const deferred = await submitAndPresentPreflight(
    h.mock.api,
    h.ctx,
    "submit",
    pref.preflightId,
    localProposal,
  );
  expect(deferred.status).toBe("deferred");
  const host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
    options.includes("开始执行") ? "开始执行" : "允许上述范围",
  );
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  const sends = h.mock.sendMessage.mock.calls.length;
  const { dispatch } = await host.run();
  await manual;
  expect(dispatch).toHaveBeenCalledOnce();
  expect(h.mock.sendMessage.mock.calls).toHaveLength(sends);
  const controls = h.entries
    .filter((row) => row.customType === "continuous-tasks:preflight-control")
    .map((row) => (row.data as { kind: string }).kind);
  expect(controls).toEqual(["approve", "start"]);
});
it.each([false, true])(
  "does not save or dispatch from a stale deferred source (branch=%s)",
  async (branch) => {
    const h = await approved(),
      host = capturedHost(h.ctx);
    await requestIdleHuman(h.mock.api, h.ctx, "automatic");
    if (branch) vi.mocked(h.ctx.sessionManager.getBranch).mockReturnValue([]);
    else currentRuntime().goalEpoch++;
    const { dispatch } = await host.run();
    expect(dispatch).not.toHaveBeenCalled();
    expect(currentRuntime().preflight?.started).toBeUndefined();
  },
);
it("does not treat a same-ID changed material as its captured request", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  currentRuntime().preflight!.planDigest = "b".repeat(64);
  const { dispatch } = await host.run();
  expect(dispatch).not.toHaveBeenCalled();
  expect(currentRuntime().preflight?.started).toBeUndefined();
});
it("retains saved Start on a real post-Start metadata publication fault", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  const append = h.mock.appendEntry.getMockImplementation() as
    | ((kind: string, data: unknown) => void)
    | undefined;
  if (!append) throw Error("publisher unavailable");
  h.mock.appendEntry.mockImplementation((kind, data) => {
    if (
      currentRuntime().preflight?.started &&
      data &&
      typeof data === "object" &&
      "kind" in data &&
      data.kind === "session-mode-changed"
    )
      throw Error("owned post-start fault");
    append(kind, data);
  });
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  const { dispatch } = await host.run();
  expect(dispatch).not.toHaveBeenCalled();
  expect(currentRuntime().preflight?.started).toBeDefined();
  expect(currentRuntime().journalFault).toBeTruthy();
  expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
});
async function pausedBoard() {
  const h = await contractFixture(false);
  const draft = await createWriteTasksTool(h.mock.api).execute(
    "board",
    {
      mode: "replace",
      phases: [{ title: "Owned", tasks: [{ title: "Work", prompt: "Work", profile: "main" }] }],
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(draft.isError, JSON.stringify(draft.content)).not.toBe(true);
  const compiled = await createCompileTasksTool(h.mock.api).execute(
    "compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
  await h.command("pause actual user pause");
  return h;
}
async function taskOnlyPausedBoard(h = preflightLifecycle()) {
  await h.command("tasks-only");
  const board = await createWriteTasksTool(h.mock.api).execute(
    "owned-tasks",
    {
      mode: "replace",
      phases: [
        {
          title: "Owned",
          tasks: [{ title: "Task-only work", prompt: "Owned work", profile: "main" }],
        },
      ],
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(board.isError, JSON.stringify(board.content)).not.toBe(true);
  const compiled = await createCompileTasksTool(h.mock.api).execute(
    "owned-compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
  await h.command("pause owned task-only pause");
  return h;
}
it.each(["cancelled", "rejected", "unknown"] as const)(
  "cannot retain an old %s delivery against an actually replaced task-board owner",
  async (status) => {
    const h = await taskOnlyPausedBoard(),
      host = capturedHost(h.ctx);
    vi.mocked(h.ctx.ui.select).mockResolvedValue("确认执行这一恢复控制");
    const original = currentWorkOwner(h.ctx.sessionManager.getSessionId());
    let writes = 0;
    let replacement: unknown;
    const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    const { dispatch } = await host.run(async (_validate, _controller, receipt) => {
      const result = await createWriteTasksTool(h.mock.api).execute(
        "replacement",
        {
          mode: "replace",
          phases: [
            {
              title: "Replacement",
              tasks: [{ title: "New owner", prompt: "New work", profile: "main" }],
            },
          ],
        },
        undefined,
        undefined,
        h.ctx,
      );
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(currentWorkOwner(h.ctx.sessionManager.getSessionId())).not.toEqual(original);
      const compiled = await createCompileTasksTool(h.mock.api).execute(
        "replacement-compile",
        { finalAcceptanceTaskId: "t-1.1" },
        undefined,
        undefined,
        h.ctx,
      );
      expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
      expect(getBoardRef().workflowStatus).toBe("active");
      writes = h.mock.appendEntry.mock.calls.length;
      replacement = structuredClone(getBoardRef());
      return status === "unknown"
        ? { status, actionId: receipt.actionId }
        : { status, actionId: receipt.actionId, reason: "validation" };
    });
    await manual;
    expect(dispatch).toHaveBeenCalledOnce();
    expect(h.mock.appendEntry.mock.calls).toHaveLength(writes);
    expect(getBoardRef()).toEqual(replacement);
  },
);
function unknownRecoverySource(h: Awaited<ReturnType<typeof taskOnlyPausedBoard>>, kind: string) {
  const runtime = currentRuntime();
  if (kind === "owner")
    runtime.management = {
      ...runtime.management!,
      activeWorkOwner: null,
      state: "stopping-with-attention",
      attention: [{ kind: "source", reason: "Actual owner invalidated", ref: null }],
    };
  else if (kind === "stopping")
    runtime.management = { ...runtime.management!, state: "stopping-with-attention" };
  else if (kind === "activity")
    runtime.executionMemoryBindings = [
      {
        sessionId: h.ctx.sessionManager.getSessionId(),
        owner: null,
        taskId: "unknown",
        executionRef: { source: "workflow", runId: "unknown-writer" },
      },
    ];
  else if (kind === "capture")
    runtime.controlJournal!.pendingHostCaptures = [
      {
        entryId: "unknown-intent",
        digest: "a".repeat(64),
        sessionId: h.ctx.sessionManager.getSessionId(),
        goalKey: "unknown",
        captureId: "unknown",
      },
    ];
  else
    runtime.invocation = {
      live: new Map(),
      results: new Map(),
      frames: new Map(),
      attention: "Unresolved invocation",
    };
}
it.each(["owner", "stopping", "activity", "capture", "invocation"])(
  "only diagnoses task-only unknown %s sources before offering recovery",
  async (kind) => {
    const h = await taskOnlyPausedBoard();
    unknownRecoverySource(h, kind);
    const host = capturedHost(h.ctx),
      writes = h.mock.appendEntry.mock.calls.length;
    const offer = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    expect(host.requestAction).not.toHaveBeenCalled();
    expect(await offer).toBe(false);
    expect(h.mock.appendEntry.mock.calls).toHaveLength(writes);
    expect(getBoardRef().workflowStatus).toBe("paused");
  },
);
it.each(["activity", "capture", "invocation"])(
  "rechecks actual unknown %s after native recovery confirmation",
  async (kind) => {
    const h = await taskOnlyPausedBoard(),
      host = capturedHost(h.ctx);
    let writes = 0;
    vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
      unknownRecoverySource(h, kind);
      writes = h.mock.appendEntry.mock.calls.length;
      return "确认执行这一恢复控制";
    });
    const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    const { dispatch } = await host.run();
    await manual;
    expect(dispatch).not.toHaveBeenCalled();
    expect(h.mock.appendEntry.mock.calls).toHaveLength(writes);
    expect(getBoardRef().workflowStatus).toBe("paused");
  },
);
it.each(["joint", "board-only", "recover"])(
  "displays exact recovery facts and the separate %s effect before confirming",
  async (kind) => {
    const h = kind === "recover" ? await approved() : await pausedBoard();
    if (kind === "recover") await h.command("start");
    if (kind !== "joint")
      holdSupervisor(h.mock.api, h.ctx, "paused", "independent technical hold", "advisor_hold");
    const before = structuredClone(currentRuntime().supervisor!);
    before.reviews = 3;
    before.continuations = 2;
    before.tokens = 41;
    before.cost = 0.25;
    saveSupervisor(h.mock.api, before);
    currentRuntime().supervisor = before;
    const owner = currentWorkOwner(h.ctx.sessionManager.getSessionId()),
      board = getBoardRef(),
      digest = journalDigest(board),
      generation = board.generation;
    h.ui.reviewedMaterial.length = 0;
    const host = capturedHost(h.ctx);
    vi.mocked(h.ctx.ui.select).mockResolvedValue("确认执行这一恢复控制");
    const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    await host.run();
    await manual;
    const shown = h.ui.reviewedMaterial.join("\n").replace(/[\s·]/gu, "");
    expect(shown).toContain("恢复控制材料");
    expect(shown).toContain(digest);
    expect(shown).toContain(`"generation":${generation}`);
    expect(shown).toContain(JSON.stringify(owner));
    for (const text of [
      '"reviews":3',
      '"continuations":2',
      '"tokens":41',
      '"cost":0.25',
      "执行结算",
      "scope",
      "holdCause",
    ])
      expect(shown).toContain(text);
    expect(shown).toContain(
      kind === "joint"
        ? "联合解除普通user_pause"
        : kind === "board-only"
          ? "仅恢复看板"
          : "原Supervisorrecover",
    );
    expect(currentRuntime().supervisor?.reviews).toBe(3);
    expect(currentRuntime().supervisor?.tokens).toBe(41);
  },
);

it("requires the separate final recovery choice after full material reading, and Esc changes nothing", async () => {
  const h = await pausedBoard(),
    host = capturedHost(h.ctx),
    before = structuredClone(getBoardRef()),
    supervisor = structuredClone(currentRuntime().supervisor),
    writes = h.mock.appendEntry.mock.calls.length;
  const reader = installCustomUI(h.ctx, (d) => d.press("\u001b"));
  vi.mocked(h.ctx.ui.select).mockClear().mockResolvedValue("确认执行这一恢复控制");
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  const { dispatch } = await host.run();
  await manual;
  reader.assertNoScriptErrors();
  expect(dispatch).not.toHaveBeenCalled();
  expect(h.ctx.ui.select).not.toHaveBeenCalled();
  expect(getBoardRef()).toEqual(before);
  expect(currentRuntime().supervisor).toEqual(supervisor);
  expect(h.mock.appendEntry.mock.calls).toHaveLength(writes);
});
it("shows exact prospective scope adoption and preserves spent usage until the separate original recover", async () => {
  const h = await pausedBoard();
  const p = proposeScopeRevision(h.mock.api, h.ctx, {
    plan: { ...h.plan, acceptance: ["revised output"] },
    contract: {
      ...h.contract,
      requirements: h.contract.requirements.map((r) => ({ ...r, text: "revised output" })),
    },
    reason: "Explicit amended output",
  });
  expect((await reviewScopeRevisionNow(h.mock.api, h.ctx, p.proposalId)).status).toBe("committed");
  await h.command("resume");
  const revision = readControlJournal(h.ctx).acceptance!.scopeCommits!.at(-1)!;
  expect(currentRuntime().supervisor?.scopeRevisionRef).toBeUndefined();
  h.ui.reviewedMaterial.length = 0;
  const host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("确认执行这一恢复控制");
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  await host.run();
  await manual;
  const shown = h.ui.reviewedMaterial.join("\n").replace(/[\s·]/gu, "");
  expect(shown).toContain(revision.entryId);
  expect(shown).toContain(revision.digest);
  expect(shown).toContain('"recoveryRequired":true');
  expect(shown).toContain("revisedoutput");
  expect(shown).toContain("将采用所列原revision/proposal");
  expect(currentRuntime().supervisor?.scopeRevisionRef).toEqual({
    entryId: revision.entryId,
    digest: revision.digest,
  });
});

it("does not display a retained historical Goal contract as the current independent task-board contract", async () => {
  const h = await contractFixture(false),
    old = readControlJournal(h.ctx).acceptance!.contracts.at(-1)!;
  const oldOwner = currentWorkOwner(h.ctx.sessionManager.getSessionId());
  await h.command("disable");
  await taskOnlyPausedBoard(h);
  expect(currentWorkOwner(h.ctx.sessionManager.getSessionId())).not.toEqual(oldOwner);
  expect(
    readControlJournal(h.ctx).acceptance!.contracts.some((c) => c.entryId === old.entryId),
  ).toBe(true);
  h.ui.reviewedMaterial.length = 0;
  const host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("确认执行这一恢复控制");
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  await host.run();
  await manual;
  const shown = h.ui.reviewedMaterial.join("\n").replace(/[\s·]/gu, "");
  expect(shown).toContain('"currentContract":"未提供/未知"');
  expect(shown).not.toContain(old.digest);
  expect(shown).not.toContain(old.entryId);
});

it.each(["confirm", "later", "changed"] as const)(
  "uses a separate native resume and preserves the original pause when %s",
  async (choice) => {
    const h = await pausedBoard(),
      host = capturedHost(h.ctx),
      before = structuredClone(currentRuntime().supervisor);
    vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
      if (choice === "changed") currentRuntime().supervisor!.tokens++;
      return choice === "later" ? "稍后" : "确认执行这一恢复控制";
    });
    const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    const { dispatch } = await host.run();
    await manual;
    if (choice === "confirm") {
      expect(dispatch).toHaveBeenCalledOnce();
      expect(currentRuntime().supervisor?.status).toBe("active");
    } else {
      expect(dispatch).not.toHaveBeenCalled();
      expect(currentRuntime().supervisor?.status).toBe("paused");
      expect(getBoardRef().workflowStatus).toBe("paused");
    }
    expect(currentRuntime().supervisor?.reviews).toBe(before!.reviews);
  },
);
it("recovers only after a separate native choice and the original recovery checks", async () => {
  const h = await approved();
  await h.command("start");
  holdSupervisor(h.mock.api, h.ctx, "paused", "inspect original work", "advisor_hold");
  const host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("确认执行这一恢复控制");
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  const { dispatch } = await host.run();
  await manual;
  expect(dispatch).toHaveBeenCalledOnce();
  expect(currentRuntime().supervisor?.status).toBe("active");
});
it.each(["choice", "information"] as const)(
  "reopens an original board %s gate without inventing permission",
  async (kind) => {
    const h = await pausedBoard();
    // Release the ordinary original pause first; the new gate has its own original source.
    await h.command("resume");
    const board = cloneBoard(getBoardRef());
    board.workflowStatus = "waiting_for_decision";
    board.generation++;
    board.decision = {
      id: "owned-idle-decision",
      taskId: "t-1.1",
      question: "Owned decision",
      whyUserOwned: "User-owned information only",
      createdAt: "2026-11-02T00:00:00Z",
      spec:
        kind === "choice"
          ? { version: 1, kind: "choice" }
          : { version: 1, kind: "information", format: "integer" },
      ...(kind === "choice" ? { options: ["only option"] } : {}),
    };
    persistEntries(h.mock.api, { type: "fixture-decision" }, board);
    setBoard(board);
    const host = capturedHost(h.ctx);
    vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
      kind === "choice"
        ? options.includes("确认提交所选方案")
          ? "确认提交所选方案"
          : (options.find((option) => /^选项 1/u.test(option)) ?? "only option")
        : "确认提交信息",
    );
    const grant = structuredClone(currentRuntime().preflight!.approval),
      start = structuredClone(currentRuntime().preflight!.started);
    const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    await host.run();
    await manual;
    expect(
      getBoardRef().decision,
      JSON.stringify(vi.mocked(h.ctx.ui.notify).mock.calls),
    ).toBeUndefined();
    expect(currentRuntime().preflight!.approval).toEqual(grant);
    expect(currentRuntime().preflight!.started).toEqual(start);
  },
);
it.each(["later", "definition"] as const)(
  "selects only the requested item from a native multi-control menu: %s",
  async (choice) => {
    const h = await contractFixture(true);
    holdSupervisor(h.mock.api, h.ctx, "paused", "prepared", "advisor_hold");
    const host = capturedHost(h.ctx);
    vi.mocked(h.ctx.ui.select).mockImplementation(async (_title, options) =>
      choice === "later"
        ? "稍后"
        : (options.find((option) => option.includes("检查准备")) ?? "稍后"),
    );
    const held = structuredClone(currentRuntime().supervisor);
    const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
    const { dispatch } = await host.run();
    await manual;
    expect(dispatch).not.toHaveBeenCalled();
    expect(currentRuntime().supervisor).toEqual(held);
    expect(readControlJournal(h.ctx).acceptance?.contractReviews.length ?? 0).toBe(
      choice === "definition" ? 1 : 0,
    );
  },
);

it("reviews a changed pre-start definition without recollecting permission or Start", async () => {
  const h = await contractFixture(false, false);
  const grant = structuredClone(currentRuntime().preflight!.approval);
  writeFileSync(
    join(h.root, "test_output.py"),
    readFileSync(join(h.root, "test_output.py"), "utf8") + "\n# new concrete version\n",
  );
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  const host = capturedHost(h.ctx);
  const manual = requestIdleHuman(h.mock.api, h.ctx, "shortcut");
  const { dispatch } = await host.run();
  await manual;
  expect(dispatch).not.toHaveBeenCalled();
  expect(currentRuntime().preflight!.approval).toEqual(grant);
  const pref = currentRuntime().preflight;
  expect(pref?.version === 2 && pref.definitionApproval).toBeTruthy();
  expect(pref?.started).toBeUndefined();
});
it("discovers and reviews an actual new current-Goal proposal, not a command string", async () => {
  const h = await contractFixture(false);
  const proposed = proposeAcceptanceContract(h.mock.api, h.ctx, {
    ...h.contract,
    checks: h.contract.checks.map((check) =>
      check.kind === "automatic" ? { ...check, timeoutMs: 2000 } : check,
    ),
  });
  holdSupervisor(h.mock.api, h.ctx, "paused", "review current definitions", "advisor_hold");
  const held = structuredClone(currentRuntime().supervisor),
    host = capturedHost(h.ctx);
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  const { dispatch } = await host.run();
  expect(dispatch).not.toHaveBeenCalled();
  expect(currentRuntime().supervisor).toEqual(held);
  expect(
    readControlJournal(h.ctx).acceptance?.contractReviews.at(-1)?.control.data.proposalRef.entryId,
  ).toBe(proposed.ref.entryId);
});
it.each(["no-proposal", "revoked", "interrupted", "rejected", "foreign-session"] as const)(
  "does not offer a cached control for %s preflight material",
  async (reason) => {
    const h = await approved(),
      host = capturedHost(h.ctx),
      pref = currentRuntime().preflight!;
    if (pref.version !== 2) throw Error("v2 required");
    if (reason === "no-proposal") pref.proposal = undefined;
    else if (reason === "revoked" || reason === "interrupted") pref.phase = reason;
    else if (reason === "rejected") pref.permissionDisposition = "rejected";
    else pref.sessionId = "foreign-session";
    expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
    expect(host.requestAction).not.toHaveBeenCalled();
  },
);
it("retains the separate preparation Start while concrete materials remain absent", async () => {
  const h = await contractFixture(true, false);
  rmSync(join(h.root, "test_output.py"));
  const grant = structuredClone(currentRuntime().preflight!.approval),
    host = capturedHost(h.ctx);
  expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(true);
  const { dispatch } = await host.run();
  expect(dispatch).not.toHaveBeenCalled();
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(currentRuntime().preflight?.approval).toEqual(grant);
});

it("does not create a pending question without a real current branch anchor", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue(null);
  expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
  expect(host.requestAction).not.toHaveBeenCalled();
});
it.each(["disable", "tasks-only"])(
  "does not revive preflight controls after explicit %s mode selection",
  async (mode) => {
    const h = await approved();
    await h.command(mode);
    const host = capturedHost(h.ctx);
    expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(false);
    expect(host.requestAction).not.toHaveBeenCalled();
  },
);
it("does not project deferred tools for an unrelated trigger or a held/tampered original Start", async () => {
  const h = await approved(),
    host = capturedHost(h.ctx);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("开始执行");
  await requestIdleHuman(h.mock.api, h.ctx, "automatic");
  const { dispatch } = await host.run();
  const before = h.mock.setActiveTools.mock.calls.length;
  for (const event of [
    null,
    {},
    { messageType: "user" },
    { messageType: "custom", message: {} },
    { messageType: "custom", message: { customType: "unrelated" } },
  ])
    reconcileHumanContinuationTools(h.mock.api, event, h.ctx);
  const event = { messageType: "custom", message: dispatch.mock.calls[0]![0] };
  currentRuntime().supervisor!.status = "paused";
  reconcileHumanContinuationTools(h.mock.api, event, h.ctx);
  currentRuntime().supervisor!.status = "active";
  const pref = currentRuntime().preflight;
  if (pref?.version !== 2 || !pref.started || !("controlEntryId" in pref.started))
    throw Error("native source missing");
  pref.started.controlEntryId = "foreign";
  reconcileHumanContinuationTools(h.mock.api, event, h.ctx);
  expect(h.mock.setActiveTools.mock.calls).toHaveLength(before);
});

it.each(["definition", "scope"] as const)(
  "automatically reviews %s metadata with original witnesses but never dispatches or resumes",
  async (kind) => {
    const h = await contractFixture(kind === "definition");
    if (kind === "scope") {
      const draft = await createWriteTasksTool(h.mock.api).execute(
        "board",
        {
          mode: "replace",
          phases: [{ title: "Owned", tasks: [{ title: "Work", prompt: "Work", profile: "main" }] }],
        },
        undefined,
        undefined,
        h.ctx,
      );
      expect(draft.isError, JSON.stringify(draft.content)).not.toBe(true);
      const compiled = await createCompileTasksTool(h.mock.api).execute(
        "compile",
        { finalAcceptanceTaskId: "t-1.1" },
        undefined,
        undefined,
        h.ctx,
      );
      expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
      await h.command("pause original");
      proposeScopeRevision(h.mock.api, h.ctx, {
        plan: { ...h.plan, acceptance: ["revised output"] },
        contract: {
          ...h.contract,
          requirements: h.contract.requirements.map((r) => ({ ...r, text: "revised output" })),
        },
        reason: "Exact condition amendment",
      });
    } else holdSupervisor(h.mock.api, h.ctx, "paused", "prepared", "advisor_hold");
    const held = structuredClone(currentRuntime().supervisor),
      board = structuredClone(getBoardRef()),
      pref = structuredClone(currentRuntime().preflight);
    const host = capturedHost(h.ctx);
    expect(await requestIdleHuman(h.mock.api, h.ctx, "automatic")).toBe(true);
    const { dispatch } = await host.run();
    expect(dispatch).not.toHaveBeenCalled();
    expect(currentRuntime().supervisor).toEqual(held);
    expect(getBoardRef()).toEqual(board);
    expect(currentRuntime().preflight).toEqual(pref);
    const acceptance = readControlJournal(h.ctx).acceptance!;
    if (kind === "scope") expect(acceptance.scopeCommits).toHaveLength(1);
    else expect(acceptance.contractReviews).toHaveLength(1);
  },
);
