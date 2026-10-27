import { expect, it, vi } from "vitest";
import { BOUNDARY } from "./helpers/lifecycle";
import { executionRegistryFixture as context } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { currentWorkOwner, appendControlFact } from "../control-journal";
import { getBoard, setBoard } from "../state";
import { createEmptyBoard } from "../engine";
import { appendOwnerSnapshot } from "../goal-scope";
import { executionAcceptanceIssue } from "../execution-settlement";
import {
  createWriteTasksTool,
  createCompileTasksTool,
  createGetReadyTasksTool,
  createAdvanceTasksTool,
} from "../tools";

it("seeds and restores an enabled board-only owner using the actual native seed ID, never a Supervisor", async () => {
  const f = await context(true);
  try {
    const bound = await f.invoke("bind_execution");
    expect(bound.isError, JSON.stringify(bound)).not.toBe(true);
    expect(f.owner.kind).toBe("board");
    const seed = f
      .entries()
      .find(
        (entry) =>
          entry.customType === "continuous-tasks:control-facts" &&
          (entry.data as { kind?: string }).kind === "board-run-seed",
      );
    expect(seed).toBeDefined();
    if (f.owner.kind === "board") expect(f.owner.board.seedEntryId).toBe(seed?.id);
    const owner = structuredClone(f.owner);
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(f.owner).toEqual(owner);
    expect(currentRuntime().supervisor).toBeUndefined();
    expect(currentRuntime().goal?.current).toBeUndefined();
    f.backend.state = "complete";
    const cleared = await f.invoke("clear_execution");
    expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
    expect(getBoard().tasks[0]?.executionRef).toBeUndefined();
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
    expect(currentRuntime().supervisor).toBeUndefined();
  } finally {
    f.close();
  }
});
it.each(["before", "memory", "after"] as const)(
  "recovers a %s board seed append without duplicate committed seeds or early RPC",
  async (failure) => {
    const f = await context(true);
    try {
      f.fail((type, data) =>
        type === "continuous-tasks:control-facts" &&
        (data as { kind?: string }).kind === "board-run-seed"
          ? failure
          : undefined,
      );
      expect((await f.invoke("bind_execution")).isError).toBe(true);
      expect(currentRuntime().journalFault).toBeDefined();
      expect(f.backend.statusQueries).toBe(0);
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const repaired = await f.invoke("bind_execution");
      expect(repaired.isError, JSON.stringify(repaired)).not.toBe(true);
      expect(currentRuntime().controlJournal?.boardSeeds).toHaveLength(1);
      expect(currentRuntime().supervisor).toBeUndefined();
      f.backend.state = "complete";
      expect((await f.invoke("clear_execution")).isError).not.toBe(true);
    } finally {
      f.close();
    }
  },
);
it("imports an old reference under the recovered legacy ledger owner, not a fabricated GoalRun", async () => {
  const f = await context("legacy");
  try {
    const board = getBoard();
    board.tasks[0]!.executionRef = f.executionRef;
    board.generation++;
    appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", board);
    setBoard(board);
    f.backend.state = "complete";
    const cleared = await f.invoke("clear_execution");
    expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
    const entry = currentRuntime().controlJournal?.executionRegistry?.[0];
    expect(entry?.binding.data.imported).toBe(true);
    expect(f.owner.kind).toBe("goal");
    if (f.owner.kind === "goal") {
      expect(f.owner.goal.goalRunId).toBeNull();
      expect(f.owner.goal.goalKey).toBe(currentRuntime().receiptStore?.checkpoint().goalId);
    }
    expect(currentRuntime().goal?.current).toBeUndefined();
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
  } finally {
    f.close();
  }
});
it("requires an actual native pure-v1 anchor recovery before importing its unverified execution", async () => {
  const f = await context(true);
  try {
    const board = getBoard();
    board.tasks[0]!.executionRef = f.executionRef;
    board.generation++;
    appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", board);
    setBoard(board);
    // Genuine v1 history: never append v1 over an existing modern ledger checkpoint.
    const legacy = {
      version: 1,
      sessionId: "test-session",
      goal: "Synthetic pure-v1 goal",
      model: { provider: "faux", id: "test" },
      status: "paused",
      reviews: 0,
      continuations: 0,
      stagnant: 0,
      epoch: 0,
      pending: false,
      receipts: [],
      bindings: [],
      tokens: 0,
      cost: 0,
    };
    f.api.appendEntry("continuous-tasks:supervisor", legacy);
    const anchor = f.entries().at(-1)!;
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(currentWorkOwner("test-session")).toBeNull();
    const count = f.entries().length;
    expect((await f.invoke("clear_execution")).isError).toBe(true);
    expect(f.entries()).toHaveLength(count);
    expect(f.backend.statusQueries).toBe(0);
    await f.command("recover");
    expect(
      currentRuntime().receiptStore,
      JSON.stringify({
        fault: currentRuntime().journalFault,
        state: currentRuntime().supervisor,
        board: getBoard(),
        notices: vi.mocked(f.ctx.ui.notify).mock.calls.slice(-3),
      }),
    ).toBeDefined();
    f.backend.state = "complete";
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "legacy-import",
        toolName: "workflow_gate",
        input: { action: "clear_execution", taskId: "t-1.1", executionRef: f.executionRef },
      }),
    ).toBeUndefined();
    const result = await f.invoke("clear_execution");
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(currentRuntime().controlJournal?.executionRegistry?.[0]?.binding.data.imported).toBe(
      true,
    );
    expect(f.entries().find((entry) => entry.id === anchor.id)?.data).toEqual(legacy);
    expect(f.owner.kind).toBe("goal");
    if (f.owner.kind === "goal") expect(f.owner.goal.goalKey).toMatch(/^legacy-/);
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
  } finally {
    f.close();
  }
});
it.each([false, true])(
  "cannot discard a registered board writer when task fields were lost: %s",
  async (lost) => {
    const f = await context(true);
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      if (lost) {
        const empty = createEmptyBoard();
        empty.generation = getBoard().generation + 1;
        appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", empty);
        f.reload();
        await f.fire("session_tree");
      }
      const count = f.entries().length;
      expect((await f.clearBoard()).isError).toBe(true);
      expect(f.entries()).toHaveLength(count);
      expect(executionAcceptanceIssue(f.owner)).toBeDefined();
    } finally {
      f.close();
    }
  },
);
it("does not start another Goal over a registered board writer whose task field was lost", async () => {
  const f = await context(true);
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    const empty = createEmptyBoard();
    empty.generation = getBoard().generation + 1;
    appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", empty);
    f.reload();
    await f.fire("session_tree");
    vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
    const count = f.entries().length;
    await f.command("supervise Another synthetic goal");
    expect(currentRuntime().goal?.current).toBeUndefined();
    expect(f.entries()).toHaveLength(count);
    expect(executionAcceptanceIssue(f.owner)).toBeDefined();
  } finally {
    f.close();
  }
});
it("does not reinterpret a board's format fence as a legacy Supervisor when opening a new quiescent Goal", async () => {
  const f = await context(true);
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    f.backend.state = "complete";
    expect((await f.invoke("clear_execution")).isError).not.toBe(true);
    // Nonempty historical inactive board selects the existing scoped-transition route.
    // This is an ownership fixture, not a new P4 exit implementation.
    const previous = getBoard(),
      retired = createEmptyBoard();
    retired.generation = previous.generation + 1;
    retired.tasks = previous.tasks.map((task) => ({ ...task, status: "draft" }));
    retired.phases = [{ phase: 1, status: "pending", title: "Historical inactive" }];
    appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", retired);
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    vi.mocked(f.ctx.ui.select).mockResolvedValue("确认提交所选方案");
    await f.command("supervise New isolated planning goal");
    expect(
      currentRuntime().goal?.current,
      JSON.stringify(vi.mocked(f.ctx.ui.notify).mock.calls.slice(-2)),
    ).toBeDefined();
    expect(currentRuntime().goal?.current?.phase).toBe("planning");
    expect(currentRuntime().supervisor).toBeUndefined();
    expect(currentRuntime().controlJournal?.executionRegistry).toHaveLength(1);
  } finally {
    f.close();
  }
});
it.each(["complete", "failed"])(
  "starts a new native board identity only after a known %s writer was closed and the board replaced",
  async (outcome) => {
    const f = await context(true);
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      const oldOwner = structuredClone(f.owner);
      f.backend.state = outcome;
      expect((await f.invoke("clear_execution")).isError).not.toBe(true);
      // Historical quiescent field-loss fixture; this tests native identity boundaries,
      // not a P4 exit command or fabricated task/goal completion.
      const retired = createEmptyBoard();
      retired.generation = getBoard().generation + 1;
      appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", retired);
      f.reload();
      await f.fire("session_tree");
      expect((await f.clearBoard()).isError).not.toBe(true);
      await createWriteTasksTool(f.api).execute(
        "new-board",
        {
          mode: "replace",
          phases: [
            {
              title: "New",
              tasks: [{ title: "New check", prompt: "New isolated input", profile: "main" }],
            },
          ],
        },
        undefined,
        undefined,
        f.ctx,
      );
      await createCompileTasksTool(f.api).execute(
        "compile-new",
        { finalAcceptanceTaskId: "t-1.1" },
        undefined,
        undefined,
        f.ctx,
      );
      await createGetReadyTasksTool(f.api).execute(
        "claim-new",
        { count: 1 },
        undefined,
        undefined,
        f.ctx,
      );
      f.backend.runId = "new-board-run";
      f.backend.generation = "new-board-process";
      f.backend.state = "running";
      const ref = { source: "pi-subagents" as const, runId: "new-board-run" };
      const bound = await f.invoke("bind_execution", ref);
      expect(bound.isError, JSON.stringify(bound)).not.toBe(true);
      expect(f.owner).not.toEqual(oldOwner);
      expect(currentRuntime().controlJournal?.boardSeeds).toHaveLength(2);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(f.owner).not.toEqual(oldOwner);
      f.backend.state = "complete";
      expect((await f.invoke("clear_execution", ref)).isError).not.toBe(true);
      expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
      if (outcome === "failed") expect(executionAcceptanceIssue(oldOwner)).toContain("resolution");
    } finally {
      f.close();
    }
  },
);
it("keeps running clear -> fresh validation -> done -> native boundary behind the execution barrier", async () => {
  const f = await context();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    const input = { action: "clear_execution", taskId: "t-1.1", executionRef: f.executionRef };
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "early-clear",
        toolName: "workflow_gate",
        input,
      }),
    ).toBeUndefined();
    const cleared = await f.invoke("clear_execution");
    expect(cleared.isError).toBe(true);
    await f.fire("tool_result", {
      type: "tool_result",
      toolCallId: "early-clear",
      toolName: "workflow_gate",
      input,
      content: cleared.content,
      isError: true,
    });
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    const evidence = {
      summary: "Fresh host result does not prove an active writer ended",
      refs: [
        {
          kind: "command" as const,
          label: "Fresh fixture validation",
          status: "passed" as const,
          ref: "tool:repair-proof",
          exitCode: 0,
        },
      ],
    };
    const done = await createAdvanceTasksTool(f.api).execute(
      "early-done",
      { transitions: [{ id: "t-1.1", evidence }] },
      undefined,
      undefined,
      f.ctx,
    );
    expect(done.isError).toBe(true);
    expect(getBoard().tasks[0]?.status).toBe("reviewing");
    const reviews = currentRuntime().supervisor?.reviews;
    expect(await f.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(currentRuntime().supervisor?.status).not.toBe("completed");
    expect(currentRuntime().supervisor?.reviews).toBe(reviews);
    expect(getBoard().tasks[0]?.executionRef).toEqual(f.executionRef);
    expect(executionAcceptanceIssue(f.owner)).toBeDefined();
  } finally {
    f.close();
  }
});
it.each(["before", "memory", "after"] as const)(
  "keeps a %s first binding fact write uncertain until explicit cold-read registration/repair",
  async (failure) => {
    const f = await context();
    try {
      f.fail((type, data) =>
        type === "continuous-tasks:control-facts" &&
        (data as { kind?: string }).kind === "execution-binding"
          ? failure
          : undefined,
      );
      expect((await f.invoke("bind_execution")).isError).toBe(true);
      expect(currentRuntime().journalFault).toBeDefined();
      expect(getBoard().tasks[0]?.executionRef).toBeUndefined();
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const queries = f.backend.statusQueries;
      // Without a committed binding fact, normal interrupted-Goal recovery is still required.
      // This is explicit new registration of the same supplied ref, not replay of external work.
      if (failure !== "after") await f.command("recover");
      expect(
        await f.fire("tool_call", {
          type: "tool_call",
          toolCallId: "binding-fact-repair",
          toolName: "workflow_gate",
          input: { action: "bind_execution", taskId: "t-1.1", executionRef: f.executionRef },
        }),
      ).toBeUndefined();
      const result = await f.invoke("bind_execution");
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(f.backend.statusQueries).toBe(queries + (failure === "after" ? 0 : 1));
      expect(currentRuntime().controlJournal?.executionRegistry).toHaveLength(1);
      expect(executionAcceptanceIssue(f.owner)).toBeDefined();
      expect(getBoard().tasks[0]?.executionRef).toEqual(f.executionRef);
    } finally {
      f.close();
    }
  },
);
it.each(["observation", "settlement"])(
  "rejects another observation after the binding's confirmed terminal %s",
  async (stage) => {
    const f = await context();
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      f.backend.state = "complete";
      if (stage === "observation")
        f.fail((type, data) =>
          type === "continuous-tasks:control-facts" &&
          (data as { kind?: string }).kind === "execution-settlement"
            ? "before"
            : undefined,
        );
      const cleared = await f.invoke("clear_execution");
      expect(!!cleared.isError).toBe(stage === "observation");
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const record = currentRuntime().controlJournal?.executionFacts?.find(
        (record) => record.data.kind === "execution-observation",
      );
      if (!record || record.data.kind !== "execution-observation")
        throw Error("Missing real fixture observation");
      const conflicting = structuredClone(record.data);
      conflicting.recordId = "conflicting-terminal-observation";
      conflicting.observation.outcome = "failure";
      const count = f.entries().length;
      expect(() => appendControlFact(f.api, f.ctx, conflicting)).toThrow();
      expect(f.entries()).toHaveLength(count);
    } finally {
      f.close();
    }
  },
);
it("confirms and restores a registered terminal release instead of relying on a deleted field", async () => {
  const f = await context();
  try {
    const bound = await f.invoke("bind_execution");
    expect(bound.isError, JSON.stringify(bound)).not.toBe(true);
    f.backend.state = "complete";
    const cleared = await f.invoke("clear_execution");
    expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
    expect(getBoard().tasks[0]?.executionRef).toBeUndefined();
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(getBoard().tasks[0]?.executionRef).toBeUndefined();
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
  } finally {
    f.close();
  }
});
it("resolves only a known failure using later native validation without changing the failed outcome", async () => {
  const f = await context();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    f.backend.state = "failed";
    expect((await f.invoke("clear_execution")).isError).not.toBe(true);
    expect(executionAcceptanceIssue(f.owner)).toContain("resolution");
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    const result = await f.resolve();
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
    const count = f.entries().length;
    expect((await f.resolve()).isError).not.toBe(true);
    expect(f.entries()).toHaveLength(count);
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
    expect(currentRuntime().controlJournal?.executionRegistry?.[0]?.settlement?.data.outcome).toBe(
      "failure",
    );
    expect(getBoard().tasks[0]?.status).toBe("reviewing");
  } finally {
    f.close();
  }
});
it.each(["binding", "settlement", "release"])(
  "holds ordinary writes after a restored partial %s group, but admits exact explicit repair",
  async (group) => {
    const f = await context();
    try {
      if (group !== "binding") {
        expect((await f.invoke("bind_execution")).isError).not.toBe(true);
        f.backend.state = "complete";
      }
      f.fail((type, data) => {
        if (
          group === "settlement" &&
          type === "continuous-tasks:control-facts" &&
          (data as { kind?: string }).kind === "execution-settlement"
        )
          return "before";
        return group !== "settlement" && type === "continuous-tasks:snapshot"
          ? "before"
          : undefined;
      });
      expect(
        (await f.invoke(group === "binding" ? "bind_execution" : "clear_execution")).isError,
      ).toBe(true);
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const count = f.entries().length;
      expect((await f.review()).isError).toBe(true);
      expect(f.entries()).toHaveLength(count);
      const external = await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "blocked-write",
        toolName: "bash",
        input: { command: "synthetic forbidden write" },
      });
      expect(external).toMatchObject({ block: true });
      expect(f.entries()).toHaveLength(count);
      const action = group === "binding" ? "bind_execution" : "clear_execution";
      const admission = await f.fire("tool_call", {
        type: "tool_call",
        toolCallId: "explicit-repair",
        toolName: "workflow_gate",
        input: { action, taskId: "t-1.1", executionRef: f.executionRef },
      });
      expect(admission, JSON.stringify(admission)).toBeUndefined();
      const result = await f.invoke(action);
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect((await f.review()).isError).not.toBe(true);
    } finally {
      f.close();
    }
  },
);
it("does not create another binding while an earlier critical group is incomplete", async () => {
  const f = await context();
  try {
    f.fail((type) => (type === "continuous-tasks:snapshot" ? "before" : undefined));
    expect((await f.invoke("bind_execution")).isError).toBe(true);
    f.fail(undefined);
    f.reload();
    await f.fire("session_tree");
    const count = f.entries().length,
      queries = f.backend.statusQueries;
    expect(
      (await f.invoke("bind_execution", { source: "pi-subagents", runId: "unrelated-run" }))
        .isError,
    ).toBe(true);
    expect(f.entries()).toHaveLength(count);
    expect(f.backend.statusQueries).toBe(queries);
  } finally {
    f.close();
  }
});
it.each(["unknown", "successful"])(
  "cannot use resolution to reinterpret an %s execution",
  async (kind) => {
    const f = await context();
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      if (kind === "successful") {
        f.backend.state = "complete";
        expect((await f.invoke("clear_execution")).isError).not.toBe(true);
      }
      const count = f.entries().length;
      expect((await f.resolve()).isError).toBe(true);
      expect(f.entries()).toHaveLength(count);
      if (kind === "unknown") expect(getBoard().tasks[0]?.executionRef).toEqual(f.executionRef);
    } finally {
      f.close();
    }
  },
);
it.each(["fabricated", "before-binding", "early-intent", "stale"])(
  "rejects %s resolution validation even when the current task text matches",
  async (kind) => {
    const f = await context();
    try {
      expect((await f.review()).isError).not.toBe(true);
      if (kind === "before-binding") await f.validate();
      const command = {
        toolName: "bash",
        toolCallId: "repair-proof",
        input: { command: "synthetic repair validation" },
      };
      if (kind === "early-intent") await f.fire("tool_call", { type: "tool_call", ...command });
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      f.backend.state = "failed";
      expect((await f.invoke("clear_execution")).isError).not.toBe(true);
      if (kind === "early-intent")
        await f.fire("tool_result", {
          type: "tool_result",
          ...command,
          content: [{ type: "text", text: "Synthetic success" }],
          structuredContent: { exit_code: 0 },
          isError: false,
        });
      if (kind === "stale") {
        await f.validate();
        await f.validate("later-mutating-command");
      }
      const count = f.entries().length;
      expect((await f.resolve()).isError).toBe(true);
      expect(f.entries()).toHaveLength(count);
      expect(executionAcceptanceIssue(f.owner)).toContain("resolution");
    } finally {
      f.close();
    }
  },
);
it.each(["before", "memory", "after"] as const)(
  "restores a %s resolution append without replay or changing the failed execution",
  async (failure) => {
    const f = await context();
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      f.backend.state = "failed";
      expect((await f.invoke("clear_execution")).isError).not.toBe(true);
      expect((await f.review()).isError).not.toBe(true);
      await f.validate();
      f.fail((type, data) =>
        type === "continuous-tasks:control-facts" &&
        (data as { kind?: string }).kind === "execution-resolution"
          ? failure
          : undefined,
      );
      expect((await f.resolve()).isError).toBe(true);
      expect(currentRuntime().journalFault).toBeDefined();
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const queries = f.backend.statusQueries;
      expect((await f.resolve()).isError).not.toBe(true);
      expect(f.backend.statusQueries).toBe(queries);
      expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
      expect(
        f
          .entries()
          .filter(
            (entry) =>
              entry.customType === "continuous-tasks:control-facts" &&
              (entry.data as { kind?: string }).kind === "execution-resolution",
          ),
      ).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
it("rejects replacement resolution when validation preceded the replacement writer's release", async () => {
  const f = await context();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    f.backend.state = "failed";
    expect((await f.invoke("clear_execution")).isError).not.toBe(true);
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    f.backend.runId = "replacement-run";
    f.backend.generation = "replacement-generation";
    f.backend.state = "running";
    const ref = { source: "pi-subagents" as const, runId: "replacement-run" };
    expect((await f.invoke("bind_execution", ref)).isError).not.toBe(true);
    f.backend.state = "complete";
    expect((await f.invoke("clear_execution", ref)).isError).not.toBe(true);
    const nextId = currentRuntime().controlJournal?.executionRegistry?.[1]?.binding.data.bindingId,
      count = f.entries().length;
    expect((await f.resolve(undefined, "superseded_success", nextId)).isError).toBe(true);
    expect(f.entries()).toHaveLength(count);
    expect(executionAcceptanceIssue(f.owner)).toContain("resolution");
  } finally {
    f.close();
  }
});
it("links a distinct later successful execution and new validation without rewriting the earlier failure", async () => {
  const f = await context();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    f.backend.state = "failed";
    expect((await f.invoke("clear_execution")).isError).not.toBe(true);
    f.backend.runId = "replacement-run";
    f.backend.generation = "replacement-generation";
    f.backend.state = "running";
    const replacement = { source: "pi-subagents" as const, runId: "replacement-run" };
    expect((await f.invoke("bind_execution", replacement)).isError).not.toBe(true);
    f.backend.state = "complete";
    expect((await f.invoke("clear_execution", replacement)).isError).not.toBe(true);
    const bindingId =
      currentRuntime().controlJournal?.executionRegistry?.[1]?.binding.data.bindingId;
    expect(bindingId).toBeDefined();
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    const result = await f.resolve(undefined, "superseded_success", bindingId);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
    f.reload();
    await f.fire("session_tree");
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(
      currentRuntime().controlJournal?.executionRegistry?.map(
        (entry) => entry.settlement?.data.outcome,
      ),
    ).toEqual(["failure", "success"]);
  } finally {
    f.close();
  }
});
it("discards a settlement after an intervening board change instead of overwriting the newer task", async () => {
  const f = await context();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    f.backend.state = "complete";
    f.fail((type, data) => {
      if (
        type === "continuous-tasks:control-facts" &&
        (data as { kind?: string }).kind === "execution-observation"
      )
        queueMicrotask(() => {
          const changed = getBoard();
          changed.tasks[0]!.title = "Newer task title";
          setBoard(changed);
        });
      return undefined;
    });
    expect((await f.invoke("clear_execution")).isError).toBe(true);
    expect(getBoard().tasks[0]?.title).toBe("Newer task title");
    expect(getBoard().tasks[0]?.executionRef).toEqual(f.executionRef);
  } finally {
    f.close();
  }
});
it.each(["before", "memory", "after"] as const)(
  "repairs a %s settlement append from its confirmed observation without a new lookup",
  async (failure) => {
    const f = await context();
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      f.backend.state = "complete";
      f.fail((type, data) =>
        type === "continuous-tasks:control-facts" &&
        (data as { kind?: string }).kind === "execution-settlement"
          ? failure
          : undefined,
      );
      expect((await f.invoke("clear_execution")).isError).toBe(true);
      expect(currentRuntime().journalFault).toBeDefined();
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      const lookups = f.backend.statusQueries;
      const repaired = await f.invoke("clear_execution");
      expect(repaired.isError, JSON.stringify(repaired)).not.toBe(true);
      expect(f.backend.statusQueries).toBe(lookups);
      expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
      const observations = f
        .entries()
        .filter(
          (entry) =>
            entry.customType === "continuous-tasks:control-facts" &&
            (entry.data as { kind?: string }).kind === "execution-observation",
        );
      expect(observations).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
it.each(["before", "memory", "after"] as const)(
  "repairs only a confirmed settlement's derived release after a %s snapshot failure",
  async (failure) => {
    const f = await context();
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      f.backend.state = "complete";
      f.fail((type) => (type === "continuous-tasks:snapshot" ? failure : undefined));
      expect((await f.invoke("clear_execution")).isError).toBe(true);
      expect(currentRuntime().journalFault).toBeDefined();
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const repaired = await f.invoke("clear_execution");
      expect(repaired.isError, JSON.stringify(repaired)).not.toBe(true);
      expect(getBoard().tasks[0]?.executionRef).toBeUndefined();
      expect(executionAcceptanceIssue(f.owner)).toBeUndefined();
      const settlements = f
        .entries()
        .filter(
          (entry) =>
            entry.customType === "continuous-tasks:control-facts" &&
            (entry.data as { kind?: string }).kind === "execution-settlement",
        );
      expect(settlements).toHaveLength(1);
    } finally {
      f.close();
    }
  },
);
it.each(["before", "memory", "after"] as const)(
  "repairs only the derived binding snapshot after a %s commit failure",
  async (failure) => {
    const f = await context();
    try {
      f.fail((type, data) =>
        type === "continuous-tasks:snapshot" &&
        !!data &&
        typeof data === "object" &&
        "snapshot" in data
          ? failure
          : undefined,
      );
      expect((await f.invoke("bind_execution")).isError).toBe(true);
      expect(currentRuntime().journalFault).toBeDefined();
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      const repaired = await f.invoke("bind_execution");
      expect(repaired.isError, JSON.stringify(repaired)).not.toBe(true);
      expect(getBoard().tasks[0]?.executionRef).toEqual(f.executionRef);
      const bindings = f
        .entries()
        .filter(
          (entry) =>
            entry.customType === "continuous-tasks:control-facts" &&
            (entry.data as { kind?: string }).kind === "execution-binding",
        );
      expect(bindings).toHaveLength(1);
      expect(executionAcceptanceIssue(f.owner)).toBeDefined();
    } finally {
      f.close();
    }
  },
);
it.each(["active", "new-generation", "active-child"])(
  "cannot release a registered %s execution",
  async (kind) => {
    const f = await context();
    try {
      expect((await f.invoke("bind_execution")).isError).not.toBe(true);
      if (kind !== "active") f.backend.state = "complete";
      if (kind === "new-generation") f.backend.generation = "a-new-generation";
      if (kind === "active-child") f.backend.childState = "running";
      expect((await f.invoke("clear_execution")).isError).toBe(true);
      expect(getBoard().tasks[0]?.executionRef).toEqual(f.executionRef);
      expect(executionAcceptanceIssue(f.owner)).toBeDefined();
    } finally {
      f.close();
    }
  },
);
it("retains the registry barrier when a restored owner snapshot has lost its task field/list", async () => {
  const f = await context();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    // A valid historical/adapter snapshot can lose a field even when modern tools forbid it.
    // Exercise the approved persistence/restore seam, not a fabricated execution proof.
    const lost = createEmptyBoard();
    lost.generation = getBoard().generation + 1;
    appendOwnerSnapshot(f.api, "continuous-tasks:snapshot", lost);
    f.reload();
    await f.fire("session_tree");
    expect(getBoard().tasks).toHaveLength(0);
    expect(executionAcceptanceIssue(f.owner)).toBeDefined();
  } finally {
    f.close();
  }
});
