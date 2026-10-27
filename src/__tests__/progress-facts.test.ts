import { expect, it } from "vitest";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { registerProgressMilestone, progressSince } from "../progress-facts";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { BOUNDARY } from "./helpers/lifecycle";

it("credits a host-registered artifact formation once, not delete/recreate cycles", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () =>
            fauxAssistantMessage(
              JSON.stringify({
                action: "guide",
                message: "Continue",
                taskIds: ["t-1.1"],
                evidenceRefs: [],
              }),
            ),
        }),
      },
    });
    expect(
      registerProgressMilestone(f.api, f.ctx, {
        id: "formed-artifact",
        taskId: "t-1.1",
        milestone: "artifact",
        inputs: ["review-input.txt"],
        artifact: "formed.txt",
      }),
    ).toBeDefined();
    for (let i = 0; i < 2; i++) {
      if (i) unlinkSync(join(f.dir, "formed.txt"));
      const call = {
        toolName: "write",
        toolCallId: `form-${i}`,
        input: { path: join(f.dir, "formed.txt"), content: "Actual artifact\n" },
      };
      expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
      writeFileSync(call.input.path, call.input.content);
      await f.fire("tool_result", {
        type: "tool_result",
        ...call,
        content: [{ type: "text", text: "formed" }],
        isError: false,
      });
      await f.fire("agent_before_settle", BOUNDARY);
    }
    expect(
      progressSince({ owner: f.owner }).facts.filter(
        (r) => r.data.kind === "progress-observed" && r.data.result === "formed",
      ),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});
it("records an exact host-registered check failure to success, never repeated success noise", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () =>
            fauxAssistantMessage(
              JSON.stringify({
                action: "guide",
                message: "Continue",
                taskIds: ["t-1.1"],
                evidenceRefs: [],
              }),
            ),
        }),
      },
    });
    expect(
      registerProgressMilestone(f.api, f.ctx, {
        id: "fixed-check",
        taskId: "t-1.1",
        milestone: "check",
        inputs: ["review-input.txt"],
        check: { tool: "bash", input: { command: "fixed registered check" } },
      }),
    ).toBeDefined();
    for (let i = 0; i < 3; i++) {
      const call = {
        toolName: "bash",
        toolCallId: `check-${i}`,
        input: { command: "fixed registered check" },
      };
      expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
      await f.fire("tool_result", {
        type: "tool_result",
        ...call,
        content: [{ type: "text", text: i ? "pass" : "fail" }],
        structuredContent: { exit_code: i ? 0 : 1 },
        isError: !i,
      });
      await f.fire("agent_before_settle", BOUNDARY);
    }
    expect(
      progressSince({ owner: f.owner }).facts.filter(
        (r) => r.data.kind === "progress-observed" && r.data.result === "success",
      ),
    ).toHaveLength(1);
  } finally {
    f.close();
  }
});

it("retains repeated check-state transitions without recrediting seen successes, then credits a genuinely new fixed version", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () =>
            fauxAssistantMessage(
              JSON.stringify({
                action: "guide",
                message: "Continue",
                taskIds: ["t-1.1"],
                evidenceRefs: [],
              }),
            ),
        }),
      },
    });
    const path = join(f.dir, "review-input.txt"),
      initial = readFileSync(path, "utf8");
    registerProgressMilestone(f.api, f.ctx, {
      id: "stateful-check",
      taskId: "t-1.1",
      milestone: "check",
      inputs: ["review-input.txt"],
      check: { tool: "bash", input: { command: "fixed stateful check" } },
    });
    for (const [i, content] of [
      initial,
      "Actual fixed B\n",
      initial,
      "Actual fixed C\n",
      initial,
      "Actual fixed B\n",
    ].entries()) {
      writeFileSync(path, content);
      const failed = i % 2 === 0,
        call = {
          toolName: "bash",
          toolCallId: `stateful-${i}`,
          input: { command: "fixed stateful check" },
        };
      expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
      await f.fire("tool_result", {
        type: "tool_result",
        ...call,
        content: [{ type: "text", text: failed ? "fail" : "pass" }],
        structuredContent: { exit_code: failed ? 1 : 0 },
        isError: failed,
      });
      await f.fire("agent_before_settle", BOUNDARY);
    }
    expect(
      progressSince({ owner: f.owner }).facts.filter(
        (r) => r.data.kind === "progress-observed" && r.data.result === "success",
      ),
    ).toHaveLength(2);
    expect(currentRuntime().supervisor?.stagnant).toBe(2);
  } finally {
    f.close();
  }
});

it.each(["cycle", "noise", "unknown"])(
  "does not score %s as unlimited implementing progress",
  async (kind) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: kind !== "unknown" });
    try {
      const path = join(f.dir, "review-input.txt");
      const initial = kind === "unknown" ? "Initial\n" : readFileSync(path, "utf8");
      Object.assign(f.ctx, {
        modelRegistry: {
          find: () => f.ctx.model,
          streamSimple: () => ({
            result: async () =>
              fauxAssistantMessage(
                JSON.stringify({
                  action: "guide",
                  message: "Inspect same work",
                  taskIds: ["t-1.1"],
                  evidenceRefs: [],
                }),
              ),
          }),
        },
      });
      let result: unknown;
      for (let i = 0; i < 4; i++) {
        const content =
          kind === "cycle"
            ? i === 2
              ? initial
              : "Seen B\n"
            : kind === "noise"
              ? initial
              : `Unqualified change ${i}\n`;
        const call = { toolName: "write", toolCallId: `${kind}-${i}`, input: { path, content } };
        expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
        writeFileSync(path, content);
        await f.fire("tool_result", {
          type: "tool_result",
          ...call,
          content: [{ type: "text", text: `output timestamp ${Date.now()} ${i}` }],
          isError: false,
        });
        result = await f.fire("agent_before_settle", BOUNDARY);
      }
      expect(result).toBeUndefined();
      expect(currentRuntime().supervisor).toMatchObject({
        status: "paused",
        stagnant: 3,
        holdCause: "stagnant",
      });
    } finally {
      f.close();
    }
  },
);

it("keeps four actual distinct managed edits progressing while the task remains implementing", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    Object.assign(f.ctx, {
      modelRegistry: {
        find: () => f.ctx.model,
        streamSimple: () => ({
          result: async () =>
            fauxAssistantMessage(
              JSON.stringify({
                action: "guide",
                message: "Continue the same authorized implementing task",
                taskIds: ["t-1.1"],
                evidenceRefs: [],
              }),
            ),
        }),
      },
    });
    for (let i = 1; i <= 4; i++) {
      const call = {
        toolName: "write",
        toolCallId: `real-distinct-edit-${i}`,
        input: {
          path: join(f.dir, "review-input.txt"),
          content: `Distinct fixed implementation ${i}\n`,
        },
      };
      expect(await f.fire("tool_call", { type: "tool_call", ...call })).toBeUndefined();
      writeFileSync(call.input.path, call.input.content);
      await f.fire("tool_result", {
        type: "tool_result",
        ...call,
        content: [{ type: "text", text: "Owned edit completed" }],
        isError: false,
      });
      expect(await f.fire("agent_before_settle", BOUNDARY), `distinct edit ${i}`).toMatchObject({
        continue: true,
      });
    }
    expect(currentRuntime().supervisor).toMatchObject({ status: "active", stagnant: 0 });
  } finally {
    f.close();
  }
});
