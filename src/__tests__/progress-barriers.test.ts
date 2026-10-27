import { expect, it, vi } from "vitest";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { getBoardRef } from "../state";
import { BOUNDARY } from "./helpers/lifecycle";
import {
  decideHostContinuation,
  beginProgressCapture,
  discardUnstartedProgress,
  registerProgressMilestone,
  progressSince,
  cachedProgressSummary,
  type HostContinuationSnapshot,
} from "../progress-facts";
function advisor(f: Awaited<ReturnType<typeof executionRegistryFixture>>) {
  Object.assign(f.ctx, {
    modelRegistry: {
      find: () => f.ctx.model,
      streamSimple: () => ({
        result: async () =>
          fauxAssistantMessage(
            JSON.stringify({
              action: "guide",
              message: "Continue authorized task",
              taskIds: ["t-1.1"],
              evidenceRefs: [],
            }),
          ),
      }),
    },
  });
}
it.each(["overlap", "failed", "late-input", "cancelled", "read-only", "nonzero", "unknown-exit"])(
  "never credits %s progress",
  async (kind) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    try {
      advisor(f);
      const call = {
        toolName: kind === "read-only" ? "read" : "bash",
        toolCallId: `barrier-${kind}`,
        input:
          kind === "read-only"
            ? { path: join(f.dir, "review-input.txt") }
            : { command: "owned finite fixture operation" },
      };
      expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
      if (kind === "overlap")
        expect(
          await f.fire("tool_call", { type: "tool_call", ...call, toolCallId: "overlap-second" }),
        ).toBeUndefined();
      if (kind === "cancelled") currentRuntime().humanEpoch++;
      writeFileSync(join(f.dir, "review-input.txt"), "Actual changed bytes\n");
      await f.fire("tool_result", {
        type: "tool_result",
        ...call,
        content: [{ type: "text", text: "Host output, not a progress assertion" }],
        isError: kind === "failed",
        ...(kind === "nonzero"
          ? { structuredContent: { exit_code: 1 } }
          : kind === "unknown-exit"
            ? { structuredContent: { exit_code: "0" } }
            : {}),
      });
      if (kind === "overlap")
        await f.fire("tool_result", {
          type: "tool_result",
          ...call,
          toolCallId: "overlap-second",
          content: [{ type: "text", text: "overlap" }],
          isError: false,
        });
      if (kind === "late-input")
        writeFileSync(join(f.dir, "review-input.txt"), "Changed again after original result\n");
      await f.fire("agent_before_settle", BOUNDARY);
      expect(progressSince({ owner: f.owner }).keys).toEqual([]);
    } finally {
      f.close();
    }
  },
);
it("fails closed on unknown progress append, without provider replay or a passing fact", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    advisor(f);
    const call = {
      toolName: "bash",
      toolCallId: "unknown-progress-append",
      input: { command: "owned finite fixture operation" },
    };
    expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
    writeFileSync(join(f.dir, "review-input.txt"), "Actual new bytes\n");
    await f.fire("tool_result", {
      type: "tool_result",
      ...call,
      content: [{ type: "text", text: "changed" }],
      isError: false,
    });
    const append = f.api.appendEntry.bind(f.api);
    vi.mocked(f.api.appendEntry).mockImplementation((type, data) => {
      if (data && typeof data === "object" && "kind" in data && data.kind === "progress-observed")
        throw Error("Owned injected unknown append");
      append(type, data);
    });
    await f.fire("agent_before_settle", BOUNDARY);
    expect(currentRuntime().journalFault).toBeDefined();
    expect(progressSince({ owner: f.owner }).keys).toEqual([]);
    expect(
      await f.fire("tool_call", {
        type: "tool_call",
        ...call,
        toolCallId: "never-replay-after-unknown",
      }),
    ).toMatchObject({ block: true });
    expect(progressSince({ owner: f.owner }).keys).toEqual([]);
  } finally {
    f.close();
  }
});
it("matches declared checks exactly and bounds optional progress frames without evicting them", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    registerProgressMilestone(f.api, f.ctx, {
      id: "exact-check",
      taskId: "t-1.1",
      milestone: "check",
      inputs: ["review-input.txt"],
      check: { tool: "bash", input: { command: "fixed exact check" } },
    });
    for (const [toolName, command] of [
      ["read", "fixed exact check"],
      ["bash", "different check"],
    ]) {
      const id = `mismatch-${toolName}`;
      beginProgressCapture(
        f.api,
        f.ctx,
        { type: "tool_call", toolName: toolName ?? "read", toolCallId: id, input: { command } },
        true,
      );
      expect(currentRuntime().progress?.captures.has(id)).toBe(false);
    }
    const call = {
      type: "tool_call" as const,
      toolName: "bash",
      toolCallId: "actual-capture-only",
      input: { command: "fixed exact check" },
    };
    beginProgressCapture(f.api, f.ctx, call, true);
    const state = currentRuntime().progress,
      actual = state?.captures.get(call.toolCallId);
    if (!state || !actual?.length) throw Error("Actual registered capture frame missing");
    // Unit load fixture only; these frame aliases do not represent 128 executions or quiescence proof.
    state.captures.clear();
    state.captures.set(
      "bounded-unit-load",
      Array.from({ length: 128 }, () => actual[0]).flatMap((frame) => (frame ? [frame] : [])),
    );
    beginProgressCapture(f.api, f.ctx, { ...call, toolCallId: "over-limit" }, true);
    expect(state.limited).toBe(true);
    expect(state.captures.get("bounded-unit-load")).toHaveLength(128);
    expect(state.captures.has("over-limit")).toBe(false);
    state.captures.clear();
    registerProgressMilestone(f.api, f.ctx, {
      id: "exact-check-second",
      taskId: "t-1.1",
      milestone: "check",
      inputs: ["review-input.txt"],
      check: { tool: "bash", input: { command: "fixed exact check" } },
    });
    state.captures.set(
      "almost-full-unit-load",
      Array.from({ length: 127 }, () => actual[0]).flatMap((frame) => (frame ? [frame] : [])),
    );
    beginProgressCapture(f.api, f.ctx, { ...call, toolCallId: "bundle-over-limit" }, true);
    expect(state.captures.has("bundle-over-limit")).toBe(false);
    state.captures.clear();
    unlinkSync(join(f.dir, "review-input.txt"));
    beginProgressCapture(f.api, f.ctx, { ...call, toolCallId: "missing-registered-input" }, true);
    expect(state.captures.has("missing-registered-input")).toBe(false);
    discardUnstartedProgress(call.toolCallId);
    expect(progressSince({ owner: f.owner, position: 0 }).keys).toEqual([]);
  } finally {
    f.close();
  }
});
it("cached progress projection is read-only and mechanical handoff obeys every independent hold", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    const board = structuredClone(getBoardRef());
    const first = board.tasks[0];
    expect(first).toBeDefined();
    if (first) first.status = "ready";
    const base: HostContinuationSnapshot = {
      mode: "supervised",
      owner: f.owner,
      active: true,
      held: false,
      authorized: true,
      pending: false,
      unknownExecution: false,
      budgetAvailable: true,
      reviewed: true,
      board,
    };
    expect(decideHostContinuation(base).action).toBe("next_batch");
    const barriers: Partial<HostContinuationSnapshot>[] = [
      { mode: "off" },
      { mode: "tasks" },
      { owner: null },
      { active: false },
      { held: true },
      { authorized: false },
      { pending: true },
      { unknownExecution: true },
      { budgetAvailable: false },
    ];
    for (const barrier of barriers)
      expect(decideHostContinuation({ ...base, ...barrier }).action).toBe("held");
    expect(decideHostContinuation({ ...base, reviewed: false }).action).toBe("review_needed");
    expect(decideHostContinuation({ ...base, board: getBoardRef() }).action).toBe("review_needed");
    const calls = vi.mocked(f.api.appendEntry).mock.calls.length;
    expect(cachedProgressSummary()?.credited).toBe(0);
    expect(vi.mocked(f.api.appendEntry).mock.calls.length).toBe(calls);
  } finally {
    f.close();
  }
});
