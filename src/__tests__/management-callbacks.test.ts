import { expect, it, vi } from "vitest";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { currentWorkOwner } from "../control-journal";
import { createClearTasksTool } from "../tools";

it.each(["managed", "unmanaged"])(
  "does not offer a prior %s result to a new legacy Goal owner",
  async (origin) => {
    const f = await executionRegistryFixture("legacy", { gitWorkspace: true });
    const read = {
      toolName: "read",
      toolCallId: "original-owner-read",
      input: { path: "review-input.txt" },
    };
    try {
      if (origin === "unmanaged") await f.command("disable");
      expect(await f.fire("tool_call", { type: "tool_call", ...read })).toBeUndefined();
      await f.command("disable");
      await f.command("enable");
      await f.command("supervise-legacy Independent new legacy Goal");
      const owner = structuredClone(currentWorkOwner(f.ctx.sessionManager.getSessionId()));
      expect(owner?.kind, JSON.stringify(vi.mocked(f.ctx.ui.notify).mock.calls)).toBe("goal");
      expect(currentRuntime().supervisor?.status).toBe("active");
      const result = await f.fire("tool_result", {
        type: "tool_result",
        ...read,
        content: [{ type: "text", text: "Original readonly result" }],
        isError: false,
      });
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(currentRuntime().supervisor?.status).toBe("active");
      expect(currentWorkOwner(f.ctx.sessionManager.getSessionId())).toEqual(owner);
      expect(currentRuntime().receiptStore?.stats.count).toBe(0);
      expect(JSON.stringify(result)).toContain("Historical");
    } finally {
      f.close();
    }
  },
);
it("continues to capture an actually current managed result", async () => {
  const f = await executionRegistryFixture("legacy", { gitWorkspace: true });
  const read = {
    toolName: "read",
    toolCallId: "current-owner-read",
    input: { path: "review-input.txt" },
  };
  try {
    expect(await f.fire("tool_call", { type: "tool_call", ...read })).toBeUndefined();
    const result = await f.fire("tool_result", {
      type: "tool_result",
      ...read,
      content: [{ type: "text", text: "Current readonly result" }],
      isError: false,
    });
    expect(currentRuntime().receiptStore?.stats.count).toBe(1);
    expect(JSON.stringify(result)).toContain("Host evidence receipt");
  } finally {
    f.close();
  }
});
it("does not misclassify its own confirmed board-replacement result as another owner's late work", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    await f.command("disable");
    await f.command("enable");
    const before = structuredClone(currentWorkOwner(f.ctx.sessionManager.getSessionId()));
    const clear = { toolName: "clear_tasks", toolCallId: "own-empty-clear", input: {} };
    expect(await f.fire("tool_call", { type: "tool_call", ...clear })).toBeUndefined();
    const result = await createClearTasksTool(f.api).execute(
      clear.toolCallId,
      {},
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError).not.toBe(true);
    expect(currentWorkOwner(f.ctx.sessionManager.getSessionId())).not.toEqual(before);
    const returned = await f.fire("tool_result", {
      type: "tool_result",
      ...clear,
      content: result.content,
      isError: false,
    });
    expect(returned).toBeUndefined();
    expect(currentRuntime().journalFault).toBeUndefined();
  } finally {
    f.close();
  }
});
