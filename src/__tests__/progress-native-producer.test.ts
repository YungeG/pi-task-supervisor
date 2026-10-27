import { expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { prepareExecutionOwner } from "../execution-settlement";
import { getBoardRef } from "../state";
import { currentRuntime } from "../runtime";
import { progressSince, cachedProgressSummary } from "../progress-facts";
import { BOUNDARY } from "./helpers/lifecycle";
// Unit seam test with actual SDK message append + finite file effects. The separate
// --progress-tasks arm qualifies the full SDK provider/event loop; this is not human proof.
it("persists task-only progress through actual native SDK message sources, with no fabricated receipt", async () => {
  const f = await executionRegistryFixture(true, { gitWorkspace: true });
  try {
    prepareExecutionOwner(f.api, f.ctx, getBoardRef());
    await f.command("enable");
    const manager = SessionManager.open(f.path, join(f.dir, "owned-sdk-sessions"));
    const id = "owned-native-progress-effect",
      path = join(f.dir, "review-input.txt"),
      input = { path, content: "Actual native-source implementation change\n" };
    manager.appendMessage(
      fauxAssistantMessage(fauxToolCall("write", input, { id }), { stopReason: "toolUse" }),
    );
    f.reload();
    expect(
      await f.fire("tool_call", { type: "tool_call", toolName: "write", toolCallId: id, input }),
    ).toBeUndefined();
    writeFileSync(path, input.content);
    await f.fire("tool_result", {
      type: "tool_result",
      toolName: "write",
      toolCallId: id,
      input,
      content: [{ type: "text", text: "Actual finite file effect complete" }],
      isError: false,
    });
    SessionManager.open(f.path, join(f.dir, "owned-sdk-sessions")).appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "write",
      content: [{ type: "text", text: "Actual finite file effect complete" }],
      isError: false,
      timestamp: Date.now(),
    });
    f.reload();
    await f.fire("agent_before_settle", BOUNDARY);
    const progress = progressSince({ owner: f.owner });
    expect(progress.keys).toHaveLength(1);
    expect(progress.facts[0]?.data).toMatchObject({
      kind: "progress-observed",
      sourceKind: "native-result",
      result: "changed",
    });
    expect(progressSince({ owner: f.owner, position: 1 }).facts).toEqual([]);
    expect(cachedProgressSummary()?.credited).toBe(1);
    expect(currentRuntime().journalFault).toBeUndefined();
  } finally {
    f.close();
  }
});
