import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { resetState, getBoardRef } from "../state";
import { createWorkflowGateTool } from "../tools";
import { captureUiSummary } from "../ui-capture";
import { holdSupervisor } from "../supervisor";
import { setSessionScopeEnabled } from "../scope";
import { currentRuntime } from "../runtime";
import {
  requestModeChange,
  adoptSupervisedMode,
  enterPlanningMode,
  enableTasksMode,
  captureManagementSnapshot,
  decideAdmission,
  completeModeChange,
} from "../management-policy";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { createMockAPI, createMockContext } from "./helpers/mocks";

beforeEach(() => {
  resetState();
});
it.each(["tasks", "supervised"] as const)(
  "does not let generic mode request %s invent an enabling owner",
  async (mode) => {
    const mock = createMockAPI(),
      ctx = createMockContext();
    await expect(requestModeChange(mock.api, ctx, mode)).rejects.toThrow(
      "selected their new owner",
    );
    expect(mock.appendEntry).not.toHaveBeenCalled();
  },
);
it("does not adopt a board owner as a supervised Goal without actual startup", async () => {
  const f = await executionRegistryFixture(true, { gitWorkspace: true });
  try {
    const before = f.entries().length;
    expect(() => {
      adoptSupervisedMode(f.api, f.ctx);
    }).toThrow("actual Goal/verified legacy");
    expect(f.entries()).toHaveLength(before);
  } finally {
    f.close();
  }
});
it("does not enter planning without an actual current preflight", () => {
  const mock = createMockAPI(),
    ctx = createMockContext();
  expect(() => {
    enterPlanningMode(mock.api, ctx);
  }).toThrow("actual current native preflight");
  expect(mock.appendEntry).not.toHaveBeenCalled();
});
it("does not reinterpret an already-started native agreement as fresh planning", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect(currentRuntime().preflight?.started).toBeDefined();
    const before = f.entries().length;
    expect(() => {
      enterPlanningMode(f.api, f.ctx);
    }).toThrow("actual current native preflight");
    expect(f.entries()).toHaveLength(before);
  } finally {
    f.close();
  }
});
it("refuses enable while actual pending messages remain without changing mode or history", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const before = f.entries().length;
    vi.mocked(f.ctx.hasPendingMessages).mockReturnValue(true);
    await expect(enableTasksMode(f.api, f.ctx)).rejects.toThrow("idle/no pending control");
    expect(f.entries()).toHaveLength(before);
    expect(currentRuntime().management?.mode).toBe("supervised");
  } finally {
    f.close();
  }
});
it("cannot use enable to wash a stopping board's unknown writer into a new owner", async () => {
  const f = await executionRegistryFixture(true, { gitWorkspace: true });
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    await f.command("disable");
    expect(currentRuntime().management).toMatchObject({
      mode: "tasks",
      state: "stopping-with-attention",
      activeWorkOwner: { kind: "board" },
    });
    const before = f.entries().length;
    await expect(enableTasksMode(f.api, f.ctx)).rejects.toThrow("pending release/attention");
    expect(f.entries()).toHaveLength(before);
    expect(currentRuntime().controlJournal?.executionRegistry?.[0]?.settlement).toBeUndefined();
  } finally {
    f.close();
  }
});
it("does not confuse a managed abort/wait ACK or wait failure with actual Main quiescence", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    vi.mocked(f.ctx.waitForIdle).mockRejectedValue(Error("Owned synthetic wait failure"));
    await f.command("disable");
    expect(f.ctx.abort).toHaveBeenCalled();
    expect(currentRuntime().management).toMatchObject({
      mode: "supervised",
      state: "stopping-with-attention",
    });
    expect(currentRuntime().management?.attention.some((item) => item.kind === "control")).toBe(
      true,
    );
  } finally {
    f.close();
  }
});
it("does not abort unrelated busy host work when already off", async () => {
  const mock = createMockAPI(),
    ctx = createMockContext();
  setSessionScopeEnabled(false); // This fixture really is unmanaged/off, not legacy task mode.
  vi.mocked(ctx.isIdle).mockReturnValue(false);
  await requestModeChange(mock.api, ctx, "off");
  expect(ctx.abort).not.toHaveBeenCalled();
  expect(ctx.waitForIdle).not.toHaveBeenCalled();
  expect(mock.appendEntry).not.toHaveBeenCalled();
});
it("keeps an unanswered native task decision with its owner, then releases only after the actual response without Main replay", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    vi.mocked(f.ctx.ui.select).mockResolvedValue(undefined);
    const opened = await createWorkflowGateTool(f.api).execute(
      "pending-native-board-question",
      {
        action: "wait_for_decision",
        taskId: "t-1.1",
        decision: {
          question: "Choose an owned fixture path",
          whyUserOwned: "Only the human chooses",
          options: ["A", "B"],
          spec: { version: 1, kind: "choice" },
        },
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(getBoardRef().decision?.response).toBeUndefined();
    await f.command("disable");
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    expect(getBoardRef().decision?.response).toBeUndefined();
    const stoppingStatus = vi.mocked(f.ctx.ui.notify).mock.calls.at(-1)?.[0] ?? "";
    expect(stoppingStatus).toContain("repeat /task-supervisor disable");
    expect(stoppingStatus).not.toContain("/task-supervisor recover");
    vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
    f.sendMessage.mockClear();
    await f.command("decide");
    expect(
      getBoardRef().decision,
      JSON.stringify({
        notices: vi.mocked(f.ctx.ui.notify).mock.calls,
        choices: vi.mocked(f.ctx.ui.select).mock.calls,
      }),
    ).toBeUndefined();
    expect(getBoardRef().workflowStatus).toBe("active");
    expect(
      f
        .entries()
        .some(
          (entry) =>
            entry.customType === "continuous-tasks:event" &&
            (entry.data as { type?: string; outcome?: string; answer?: string }).type ===
              "resolve_decision" &&
            (entry.data as { outcome?: string }).outcome === "answer" &&
            (entry.data as { answer?: string }).answer === "A",
        ),
    ).toBe(true);
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
    await f.command("disable");
    expect(currentRuntime().management?.mode).toBe("off");
  } finally {
    f.close();
  }
});

it("can retain a real native business rejection as history without treating it as unanswered control or forcing task completion", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    f.chooseDraft(2);
    vi.mocked(f.ctx.ui.select).mockResolvedValue("不允许");
    const rejected = await createWorkflowGateTool(f.api).execute(
      "native-business-rejection",
      {
        action: "wait_for_decision",
        taskId: "t-1.1",
        decision: {
          question: "Allow only a synthetic fixture operation?",
          whyUserOwned: "Only the human authorizes",
          spec: {
            version: 1,
            kind: "authorization",
            scope: "Owned private fixture only; no business dispatch",
            prohibitions: [],
          },
        },
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(rejected.isError, JSON.stringify(rejected)).not.toBe(true);
    expect(getBoardRef().decision?.response).toBe("rejected");
    const decision = structuredClone(getBoardRef().decision);
    await f.command("disable");
    expect(currentRuntime().management?.mode).toBe("off");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(getBoardRef().decision).toEqual(decision);
    expect(getBoardRef().tasks[0]?.status).toBe("implementing");
    expect(captureUiSummary(f.ctx, getBoardRef()).visible).toBe(false);
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentRuntime().management?.mode).toBe("off");
    expect(getBoardRef().decision).toEqual(decision);
    // A response string is not enough: cold raw-owner/human restoration must
    // reject a broken original native witness before publishing the off view.
    const lines = readFileSync(f.path, "utf8").trimEnd().split("\n");
    const witnessAt = lines.findIndex((line) => {
      const row = JSON.parse(line) as {
        customType?: string;
        data?: { frame?: { owner?: string } };
      };
      return (
        row.customType === "continuous-tasks:human-readback" && row.data?.frame?.owner === "board"
      );
    });
    expect(witnessAt).toBeGreaterThan(0);
    const witness = JSON.parse(lines[witnessAt]!) as { data: { controlDigest: string } };
    witness.data.controlDigest = "0".repeat(64);
    lines[witnessAt] = JSON.stringify(witness);
    writeFileSync(f.path, lines.join("\n") + "\n");
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeDefined();
    expect(currentRuntime().management?.mode).not.toBe("off");
  } finally {
    f.close();
  }
});

it("does not abort a foreign Session's busy Main from a retained mode and denies stale context/boundary publication", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const foreign = {
      ...f.ctx,
      sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "foreign-session" },
    };
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    const snapshot = captureManagementSnapshot(foreign);
    expect(decideAdmission(snapshot, { kind: "context" }).verdict).toBe("deny");
    expect(decideAdmission(snapshot, { kind: "boundary" }).verdict).toBe("deny");
    const before = f.entries().length;
    await expect(requestModeChange(f.api, foreign, "off")).rejects.toThrow();
    expect(f.ctx.abort).not.toHaveBeenCalled();
    expect(f.entries()).toHaveLength(before);
  } finally {
    f.close();
  }
});

it("rechecks mode ownership after waiting instead of publishing old control into a moved Session", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  let sessionId = f.ctx.sessionManager.getSessionId(),
    file = f.path;
  try {
    const context = {
      ...f.ctx,
      sessionManager: {
        ...f.ctx.sessionManager,
        getSessionId: () => sessionId,
        getSessionFile: () => file,
      },
    };
    vi.mocked(f.ctx.isIdle).mockReturnValue(false);
    vi.mocked(f.ctx.waitForIdle).mockImplementation(async () => {
      sessionId = "foreign-session";
      file = `${f.path}-uncreated-foreign`;
    });
    const before = f.entries().length;
    await expect(requestModeChange(f.api, context, "off")).rejects.toThrow();
    expect(f.entries()).toHaveLength(before);
    expect(currentRuntime().management?.mode).not.toBe("off");
  } finally {
    f.close();
  }
});

it("does not let an old waiting stop overwrite a newer completed native disable", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  let sealed: unknown,
    writes = 0;
  try {
    vi.mocked(f.ctx.waitForIdle).mockImplementationOnce(async () => {
      await requestModeChange(f.api, f.ctx, "off");
      sealed = structuredClone(currentRuntime().management);
      writes = f.entries().length;
    });
    await expect(requestModeChange(f.api, f.ctx, "off")).rejects.toThrow("owner/context changed");
    expect(currentRuntime().management).toEqual(sealed);
    expect(currentRuntime().management?.mode).toBe("off");
    expect(f.entries()).toHaveLength(writes);
    expect(currentRuntime().journalFault).toBeUndefined();
  } finally {
    f.close();
  }
});
it("preserves a real intervening input hold instead of finalizing the stale stop request", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  let writes = 0,
    held: unknown;
  try {
    vi.mocked(f.ctx.waitForIdle).mockImplementationOnce(async () => {
      await f.fire("input", {
        type: "input",
        source: "interactive",
        text: "Inspect before proceeding",
      });
      writes = f.entries().length;
      held = structuredClone(currentRuntime().supervisor);
    });
    await expect(requestModeChange(f.api, f.ctx, "off")).rejects.toThrow("owner/context changed");
    expect(currentRuntime().supervisor).toEqual(held);
    expect(f.entries()).toHaveLength(writes);
    expect(currentRuntime().management?.mode).not.toBe("off");
  } finally {
    f.close();
  }
});

it.each(["manager", "tree"] as const)(
  "rejects an old waiting mode request after native %s identity changes, even with the same Session ID",
  async (change) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    const context = { ...f.ctx };
    let writes = 0,
      selected: unknown;
    try {
      vi.mocked(f.ctx.waitForIdle).mockImplementationOnce(async () => {
        if (change === "manager")
          Object.assign(context, { sessionManager: { ...context.sessionManager } });
        else await f.fire("session_tree");
        writes = f.entries().length;
        selected = structuredClone(currentRuntime().management);
      });
      await expect(requestModeChange(f.api, context, "off")).rejects.toThrow(
        "owner/context changed",
      );
      expect(currentRuntime().management).toEqual(selected);
      expect(f.entries()).toHaveLength(writes);
    } finally {
      f.close();
    }
  },
);
it("guards direct completion against a foreign native Session before any old-owner metadata write", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const snapshot = captureManagementSnapshot(f.ctx);
    const foreign = {
      ...f.ctx,
      sessionManager: { ...f.ctx.sessionManager, getSessionId: () => "foreign-session" },
    };
    const before = f.entries().length;
    expect(() => {
      completeModeChange(f.api, foreign, snapshot);
    }).toThrow("another Session");
    expect(f.entries()).toHaveLength(before);
    expect(currentRuntime().management?.mode).toBe("supervised");
  } finally {
    f.close();
  }
});

it("does not let buffered-management materialization erase an existing stop intent at tool admission", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    await f.command("disable");
    const selected = currentRuntime().management!;
    expect(selected.state).toBe("stopping-with-attention");
    // Unit seam for an SDK setup-only projection becoming durable. This source
    // marker is synthetic, not new provenance or a native qualification proof.
    currentRuntime().management = { ...selected, source: "volatile", record: undefined };
    const before = f.entries().length;
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "must-stay-stopped",
        toolName: "write",
        input: { path: "not-started" },
      }),
    ).toMatchObject({ block: true });
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
    expect(f.entries()).toHaveLength(before);
  } finally {
    f.close();
  }
});

it("does not dispatch recovered Main when native pending messages appear after recovery publication", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    holdSupervisor(f.api, f.ctx, "fault", "Owned recovery fixture", "review_failed");
    vi.mocked(f.ctx.hasPendingMessages).mockImplementation(
      () => currentRuntime().supervisor?.status === "active",
    );
    f.sendMessage.mockClear();
    await f.command("recover");
    expect(currentRuntime().supervisor?.status).toBe("active");
    expect(f.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
  } finally {
    f.close();
  }
});

it("does not replay an unknown mode append when disable is repeated before source inspection", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    f.fail((_type, value) =>
      (value as { kind?: string; mode?: string }).kind === "session-mode-changed" &&
      (value as { mode?: string }).mode === "off"
        ? "before"
        : undefined,
    );
    await f.command("disable");
    expect(currentRuntime().journalFault).toBeDefined();
    const before = f.entries().length;
    f.fail(() => undefined);
    await f.command("disable");
    expect(f.entries()).toHaveLength(before);
    expect(currentRuntime().management?.state).toBe("stopping-with-attention");
  } finally {
    f.close();
  }
});
