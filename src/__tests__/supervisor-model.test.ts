import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setSessionScopeEnabled } from "../scope";
import { resetState, setBoard } from "../state";
import { supervisorState } from "../supervisor";
import { activeBoard, BOUNDARY, lifecycle } from "./helpers/lifecycle";
import { appendMockEntries } from "./helpers/mocks";

const guide = {
  action: "guide",
  message: "Finish the approved implementation",
  taskIds: ["t-1.1"],
  evidenceRefs: [],
};

describe("session-runtime advisor adapter", () => {
  beforeEach(() => {
    resetState();
    setSessionScopeEnabled(true);
    setBoard(activeBoard());
  });

  it("uses the pinned session runtime with no tools, bounded output, signal, and usage", async () => {
    const h = lifecycle();
    const reply = structuredClone(fauxAssistantMessage(JSON.stringify(guide)));
    reply.usage.totalTokens = 7;
    reply.usage.cost.total = 0.25;
    const find = vi.fn(() => h.ctx.model);
    const streamSimple = vi.fn(() => ({ result: async () => reply }));
    Object.assign(h.ctx, { modelRegistry: { find, streamSimple } });
    await h.command("supervise Validate the approved work");
    Object.assign(h.ctx, { model: { provider: "changed", id: "changed" } });
    const result = await h.fire("agent_before_settle", BOUNDARY);
    expect(result?.continue).toBe(true);
    expect(find).toHaveBeenCalledWith("faux", "test");
    expect(streamSimple).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tools: [],
        systemPrompt: expect.stringContaining("no percentage"),
        messages: [
          expect.objectContaining({
            role: "user",
            content: expect.stringContaining("Validate the approved work"),
          }),
        ],
      }),
      expect.objectContaining({ maxTokens: 2048, signal: expect.any(AbortSignal) }),
    );
    expect(supervisorState()).toMatchObject({ tokens: 7, cost: 0.25 });
  });

  it.each([
    fauxAssistantMessage("not JSON"),
    fauxAssistantMessage("{}"),
    fauxAssistantMessage(JSON.stringify({ ...guide, message: "token=secret-value-123456" })),
    fauxAssistantMessage("too long", { stopReason: "length" }),
    fauxAssistantMessage("failed", {
      stopReason: "error",
      errorMessage: "Bearer private-secret-value",
    }),
    fauxAssistantMessage(fauxToolCall("bash", { command: "invalid" })),
  ])(
    "exposes invalid, failed, or tool-using model replies without silent fallback",
    async (reply) => {
      const h = lifecycle();
      Object.assign(h.ctx, {
        modelRegistry: {
          find: () => h.ctx.model,
          streamSimple: () => ({ result: async () => reply }),
        },
      });
      await h.command("supervise Validate the approved work");
      expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
      expect(supervisorState()?.status).toBe("fault");
      expect(h.mock.sendMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({ display: true }),
        { triggerTurn: false },
      );
      expect(JSON.stringify(h.mock.appendEntry.mock.calls)).not.toContain("private-secret-value");
    },
  );

  it("redacts structured credentials and transcript strings without corrupting the advisor JSON", async () => {
    const h = lifecycle();
    const packets: string[] = [];
    Object.assign(h.ctx, {
      modelRegistry: {
        find: () => h.ctx.model,
        streamSimple: (_model: unknown, context: { messages: { content: string }[] }) => {
          packets.push(context.messages[0]!.content);
          return { result: async () => fauxAssistantMessage(JSON.stringify(guide)) };
        },
      },
    });
    await h.command("supervise Validate approved work");
    await h.fire("tool_result", {
      toolName: "read",
      toolCallId: "credentials",
      input: { api_key: "input-private", nested: { password: { value: "nested-private" } } },
      content: [{ type: "text", text: '{"token":"output-private"} Bearer output-bearer' }],
      isError: false,
    });
    appendMockEntries(h.ctx, [
      { type: "message", message: { role: "user", content: 'authorization="transcript-private"' } },
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "api_key=recent-private" }] },
      },
      { type: "custom", customType: "unrelated", data: { value: "not a message" } },
    ]);
    expect((await h.fire("agent_before_settle", BOUNDARY))?.continue).toBe(true);
    const packet = JSON.parse(packets[0]!);
    expect(packet.goal).toBe("Validate approved work");
    expect(packet.receipts[0].input).toContain("[redacted]");
    expect(packet.recent).toHaveLength(2);
    const persisted = JSON.stringify(h.mock.appendEntry.mock.calls);
    for (const secret of [
      "input-private",
      "nested-private",
      "output-private",
      "output-bearer",
      "transcript-private",
      "recent-private",
    ]) {
      expect(packets[0]).not.toContain(secret);
      expect(persisted).not.toContain(secret);
    }
  });

  it("rejects oversized evidence packets visibly before making any model call", async () => {
    const h = lifecycle();
    const streamSimple = vi.fn();
    Object.assign(h.ctx, { modelRegistry: { find: () => h.ctx.model, streamSimple } });
    setBoard(
      activeBoard({
        tasks: Array.from({ length: 40 }, (_, index) => ({
          ...activeBoard().tasks[0]!,
          id: `t-1.${index + 1}`,
          prompt: "x".repeat(2000),
        })),
      }),
    );
    await h.command("supervise Validate the approved large plan");
    expect(await h.fire("agent_before_settle", BOUNDARY)).toBeUndefined();
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("exceeds 64KB"),
    });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("fails visibly when the pinned model is missing", async () => {
    const h = lifecycle();
    const streamSimple = vi.fn();
    Object.assign(h.ctx, { modelRegistry: { find: () => undefined, streamSimple } });
    await h.command("supervise Validate approved work");
    await h.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: expect.stringContaining("unavailable"),
    });
    expect(streamSimple).not.toHaveBeenCalled();
  });

  it("exposes transport failures without leaking their credentials", async () => {
    const h = lifecycle();
    Object.assign(h.ctx, {
      modelRegistry: {
        find: () => h.ctx.model,
        streamSimple: () => {
          throw new Error("api_key=private-secret-value connection refused");
        },
      },
    });
    await h.command("supervise Validate approved work");
    await h.fire("agent_before_settle", BOUNDARY);
    expect(supervisorState()).toMatchObject({
      status: "fault",
      reason: "[redacted] connection refused",
    });
  });
});
