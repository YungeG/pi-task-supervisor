import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { getBoardRef, resetState, setBoard } from "../state";
import { supervisorState } from "../supervisor";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";

const guide = {
  action: "guide",
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
      await h.command("supervise Validate the approved work without losing its evidence");
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
      vi.mocked(h.ctx.sessionManager.getBranch).mockReturnValue(
        Array.from({ length: 16 }, () => ({
          type: "message",
          message: { role: "assistant", content: text.repeat(2000) },
        })) as any,
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
      expect(packet.recent).toHaveLength(16);
      expect(packet.excerpts).toMatchObject({ shortened: true });
      expect(supervisorState()!.receipts).toEqual(receipts);
      expect(supervisorState()!.bindings).toEqual(bindings);
      expect(getBoardRef()).toEqual(board);
    },
  );

  it("refuses oversized bound evidence rather than shortening acceptance proof", async () => {
    const h = lifecycle();
    const streamSimple = vi.fn();
    Object.assign(h.ctx, { modelRegistry: { find: () => h.ctx.model, streamSimple } });
    await h.command("supervise Preserve all bound validation evidence");
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
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("exceeds 64KB"),
    });
    expect(streamSimple).not.toHaveBeenCalled();
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
          prompt: "核".repeat(1000),
        })),
      }),
    );
    await h.command("supervise Preserve the complete multilingual plan");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("exceeds 64KB"),
    });
    expect(streamSimple).not.toHaveBeenCalled();
  });
});
