import type {
  BoundaryResult,
  ExtensionCommandContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSupervisorComponents } from "../index";
import { scopedAPI } from "../runtime";
import { startSupervisor } from "../supervisor";
import { resetState } from "../state";
import { activeBoard, ACTIVATION, BOUNDARY, deferred } from "./helpers/lifecycle";
import { attachMockJournal, createMockAPI, createMockContext } from "./helpers/mocks";

function instance(id: string) {
  const mock = createMockAPI();
  const ctx = createMockContext([
    ACTIVATION,
    { type: "custom", customType: "continuous-tasks:snapshot", data: activeBoard() },
  ]);
  attachMockJournal(mock, ctx);
  vi.mocked(ctx.sessionManager.getSessionId).mockReturnValue(id);
  Object.assign(ctx, { model: { provider: "faux", id: "test" } });
  scopedAPI(mock.api, (api) => {
    registerSupervisorComponents(api);
    // Explicit host-module state for isolation tests, not a human command/approval.
    api.on("session_start", (_event, context) => {
      startSupervisor(api, context, id === "session-a" ? "Goal A" : "Goal B");
    });
  });
  const definition = mock.registerCommand.mock.calls[0]?.[1] as {
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  };
  return {
    mock,
    ctx,
    command: (args: string) => definition.handler(args, ctx),
    async fire(name: string, event: unknown = {}) {
      let result: unknown;
      for (const [registered, handler] of mock.on.mock.calls)
        if (registered === name) {
          const value = await handler(event, ctx);
          if (value !== undefined) result = value;
        }
      return result as BoundaryResult | undefined;
    },
  };
}

describe("extension instance isolation", () => {
  beforeEach(() => {
    resetState();
  });

  it("keeps goals and boards independent across simultaneous sessions", async () => {
    const a = instance("session-a");
    const b = instance("session-b");
    await Promise.all([a.fire("session_start"), b.fire("session_start")]);
    await a.command("pause separate maintenance");
    await b.command("status");
    expect(b.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Supervisor: active"),
      "info",
    );
    expect(b.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Goal B"), "info");
    expect(
      b.mock.appendEntry.mock.calls
        .filter(([type]) => type === "continuous-tasks:supervisor")
        .at(-1)?.[1],
    ).toMatchObject({ sessionId: "session-b", goal: "Goal B", status: "active" });
    const tools = a.mock.registerTool.mock.calls.map(([tool]) => tool as ToolDefinition);
    expect(tools.every((tool) => tool.executionMode === "sequential")).toBe(true);
  });

  it("a human pause cancels its own in-flight reviewer immediately", async () => {
    const a = instance("session-a");
    const reply = deferred<any>();
    Object.assign(a.ctx, {
      modelRegistry: {
        find: () => a.ctx.model,
        streamSimple: () => ({ result: () => reply.promise }),
      },
    });
    await a.fire("session_start");
    const pending: Promise<BoundaryResult | undefined> = a.fire("agent_before_settle", BOUNDARY);
    await a.command("pause maintenance");
    const outcome = await Promise.race([
      pending,
      new Promise<string>((resolve) =>
        setTimeout(() => {
          resolve("still waiting");
        }, 20),
      ),
    ]);
    expect(outcome).toBeUndefined();
    reply.resolve({
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            action: "guide",
            message: "Continue",
            taskIds: [],
            evidenceRefs: [],
          }),
        },
      ],
    });
    await Promise.resolve();
    await a.command("status");
    expect(a.ctx.ui.notify).toHaveBeenLastCalledWith(
      expect.stringContaining("Supervisor: paused"),
      "info",
    );
  });
});
