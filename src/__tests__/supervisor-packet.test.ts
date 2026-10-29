import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { getBoardRef, resetState, setBoard } from "../state";
import { startSupervisor, supervisorState } from "../supervisor";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";
import { appendMockEntries } from "./helpers/mocks";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { createAdvanceTasksTool } from "../tools";
import type { CompletionEvidence } from "../types";

const guide = {
  action: "next_batch",
  message: "Finish the approved implementation",
  taskIds: ["t-1.1"],
  evidenceRefs: [],
};

describe("bounded supervisor evidence packet", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
  });

  it("reviews sixteen applicable 1600-character Chinese receipts under 64000 bytes without rewriting retained evidence", async () => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    try {
      expect((await f.review()).isError).not.toBe(true);
      const refs: CompletionEvidence["refs"] = [];
      for (let index = 0; index < 16; index++) {
        const toolName = index === 0 ? "bash" : "read",
          toolCallId = `capacity-${index}`;
        const input =
          index === 0
            ? { command: "synthetic fixed validation" }
            : { path: "synthetic-retained-material" };
        await f.fire("tool_call", { type: "tool_call", toolName, toolCallId, input });
        await f.fire("tool_result", {
          type: "tool_result",
          toolName,
          toolCallId,
          input,
          content: [{ type: "text", text: "核".repeat(1600) }],
          structuredContent: { exit_code: 0 },
          isError: false,
        });
        refs.push({
          kind: index === 0 ? "command" : "review",
          label: `Retained proof ${index}`,
          status: "passed",
          ref: `tool:${toolCallId}`,
          ...(index === 0 ? { exitCode: 0 } : {}),
        });
      }
      const state = supervisorState()!,
        original = structuredClone(state.receipts);
      const packets: string[] = [];
      const streamSimple = vi.fn(
        (_model: unknown, context: { messages: { content: string }[] }) => {
          packets.push(context.messages[0]!.content);
          return {
            result: async () =>
              fauxAssistantMessage(
                JSON.stringify({
                  action: "accept",
                  message: "Synthetic repeated output and host validation reviewed",
                  taskIds: ["t-1.1"],
                  evidenceRefs: refs.map((ref) => ref.ref),
                }),
              ),
          };
        },
      );
      Object.assign(f.ctx, { modelRegistry: { find: () => f.ctx.model, streamSimple } });
      const done = await createAdvanceTasksTool(f.api).execute(
        "capacity-done",
        {
          transitions: [
            { id: "t-1.1", evidence: { summary: "Sixteen real retained fixture results", refs } },
          ],
        },
        undefined,
        undefined,
        f.ctx,
      );
      expect(done.isError, JSON.stringify(done)).not.toBe(true);
      await f.fire("agent_before_settle", BOUNDARY);
      expect(streamSimple).toHaveBeenCalledOnce();
      expect(Buffer.byteLength(packets[0]!, "utf8")).toBeLessThanOrEqual(64_000);
      expect(JSON.parse(packets[0]!).receipts).toHaveLength(16);
      expect(supervisorState()?.status).toBe("completed");
      expect(supervisorState()!.receipts).toEqual(original);
    } finally {
      f.close();
    }
  });

  it("rejects unreviewable required metadata before publishing done or completion bindings", async () => {
    const h = lifecycle();
    setBoard(
      activeBoard({
        finalAcceptanceTaskId: "t-1.1",
        tasks: [{ ...activeBoard().tasks[0]!, title: "核".repeat(24000), status: "reviewing" }],
        phases: [{ phase: 1, status: "active", title: "Bounded" }],
      }),
    );
    startSupervisor(h.mock.api, h.ctx, "Preserve required metadata under the original byte cap");
    await h.fire("tool_result", {
      type: "tool_result",
      toolName: "bash",
      toolCallId: "metadata-proof",
      input: { command: "synthetic metadata check" },
      content: [{ type: "text", text: "Passed" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    const board = structuredClone(getBoardRef()),
      state = supervisorState()!,
      bindings = structuredClone(state.bindings),
      count = h.ctx.sessionManager.getBranch().length;
    const result = await createAdvanceTasksTool(h.mock.api).execute(
      "oversized-done",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Actual fixture result",
              refs: [
                {
                  kind: "command",
                  label: "Fixture validation",
                  status: "passed",
                  ref: "tool:metadata-proof",
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
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("REVIEW_VIEW_TOO_LARGE");
    expect(getBoardRef()).toEqual(board);
    expect(state.bindings).toEqual(bindings);
    expect(h.ctx.sessionManager.getBranch()).toHaveLength(count);
  });

  it.each(["x", "核验"])(
    "bounds large %s receipt excerpts without changing the board or durable evidence",
    async (text) => {
      const h = lifecycle();
      const packets: string[] = [];
      const streamSimple = vi.fn(
        (_model: unknown, context: { messages: { content: string }[] }) => {
          packets.push(context.messages[0]!.content);
          return { result: async () => fauxAssistantMessage(JSON.stringify(guide)) };
        },
      );
      Object.assign(h.ctx, {
        modelRegistry: { find: () => h.ctx.model, streamSimple },
      });
      startSupervisor(h.mock.api, h.ctx, "Validate the approved work without losing its evidence");
      for (let index = 0; index < 40; index++) {
        await h.fire("tool_result", {
          toolName: "read",
          toolCallId: `large-${index}`,
          input: { source: text.repeat(2000) },
          content: [{ type: "text", text: text.repeat(2000) }],
          structuredContent: { exit_code: 0 },
          isError: false,
        });
      }
      const state = supervisorState()!;
      state.bindings.push({ taskId: "t-1.1", digest: "a".repeat(64), refs: ["tool:large-0"] });
      const receipts = structuredClone(state.receipts);
      const bindings = structuredClone(state.bindings);
      const board = structuredClone(getBoardRef());
      appendMockEntries(
        h.ctx,
        Array.from({ length: 16 }, () => ({
          type: "message",
          message: { role: "assistant", content: text.repeat(2000) },
        })),
      );

      expect((await h.fire("agent_before_settle", BOUNDARY))?.continue).toBe(true);
      expect(streamSimple).toHaveBeenCalledOnce();
      expect(Buffer.byteLength(packets[0]!, "utf8")).toBeLessThanOrEqual(64_000);
      const packet = JSON.parse(packets[0]!);
      expect(packet.board).toEqual(board);
      expect(packet.goal).toBe(state.goal);
      expect(packet.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([
        "tool:large-0",
        ...Array.from({ length: 30 }, (_, index) => `tool:large-${index + 10}`),
      ]);
      for (const receipt of packet.receipts) {
        const original = receipts.find((candidate) => candidate.id === receipt.id)!;
        expect(receipt).toMatchObject({
          id: original.id,
          digest: original.digest,
          epoch: original.epoch,
          ok: original.ok,
          exitCode: original.exitCode,
          taskIds: original.taskIds,
          reviews: original.reviews,
        });
      }
      expect(
        packet.receipts.find((receipt: { id: string }) => receipt.id === "tool:large-0"),
      ).toEqual(receipts[0]);
      // The real review checkpoint occupies one of the last 16 native branch entries.
      expect(packet.recent).toHaveLength(15);
      expect(packet.excerpts).toMatchObject({ shortened: true });
      expect(supervisorState()!.receipts).toEqual(receipts);
      expect(supervisorState()!.bindings).toEqual(bindings);
      expect(getBoardRef()).toEqual(board);
    },
  );

  it("bounds dense registered bodies without refusing or rewriting retained acceptance evidence", async () => {
    const h = lifecycle();
    const packets: string[] = [];
    const streamSimple = vi.fn((_model: unknown, context: { messages: { content: string }[] }) => {
      packets.push(context.messages[0]!.content);
      return { result: async () => fauxAssistantMessage(JSON.stringify(guide)) };
    });
    Object.assign(h.ctx, { modelRegistry: { find: () => h.ctx.model, streamSimple } });
    startSupervisor(h.mock.api, h.ctx, "Preserve all bound validation evidence");
    for (let index = 0; index < 40; index++) {
      await h.fire("tool_result", {
        toolName: "read",
        toolCallId: `bound-${index}`,
        input: { source: "x".repeat(2000) },
        content: [{ type: "text", text: "x".repeat(2000) }],
        structuredContent: { exit_code: 0 },
        isError: false,
      });
    }
    const state = supervisorState()!;
    state.bindings = [0, 1].map((group) => ({
      taskId: group === 0 ? "t-1.1" : "t-2.1",
      digest: "a".repeat(64),
      refs: Array.from({ length: 20 }, (_, index) => `tool:bound-${group * 20 + index}`),
    }));
    const receipts = structuredClone(state.receipts);
    const bindings = structuredClone(state.bindings);
    expect((await h.fire("agent_before_settle", BOUNDARY))?.continue).toBe(true);
    expect(supervisorState()).toMatchObject({ status: "active", pending: true });
    expect(streamSimple).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(packets[0]!, "utf8")).toBeLessThanOrEqual(64_000);
    const view = JSON.parse(packets[0]!);
    expect(view.receipts).toHaveLength(40);
    expect(view.excerpts.shortened).toBe(true);
    expect(view.excerpts.details.length).toBeGreaterThan(0);
    expect(supervisorState()!.receipts).toEqual(receipts);
    expect(supervisorState()!.bindings).toEqual(bindings);
  });

  it("measures protected plan limits in UTF-8 bytes, not UTF-16 length", async () => {
    const h = lifecycle();
    const streamSimple = vi.fn();
    Object.assign(h.ctx, { modelRegistry: { find: () => h.ctx.model, streamSimple } });
    setBoard(
      activeBoard({
        tasks: Array.from({ length: 30 }, (_, index) => ({
          ...activeBoard().tasks[0]!,
          id: `t-1.${index + 1}`,
          title: "核".repeat(1000),
        })),
      }),
    );
    startSupervisor(h.mock.api, h.ctx, "Preserve the complete multilingual plan");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("exceeds 64KB"),
    });
    expect(streamSimple).not.toHaveBeenCalled();
  });
});
