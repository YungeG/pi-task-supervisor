import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAPI, createMockContext } from "./helpers/mocks";
import { getHandler } from "./helpers/lifecycle";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { setSessionScopeEnabled } from "../scope";
import { startSupervisor, holdSupervisor, recoverSupervisor } from "../supervisor";
import { registerEventHandlers } from "../events";
import { registerCommands } from "../commands";
import { readControlJournal } from "../control-journal";

it.each([true, false])(
  "keeps an unfenced legacy host intent unknown after close_unknown (physical=%s)",
  async (physical) => {
    resetState();
    const dir = mkdtempSync(join(tmpdir(), "owned-mode-host-capture-"));
    const manager = physical
      ? SessionManager.create(dir, join(dir, "sessions"))
      : SessionManager.inMemory(dir);
    const mock = createMockAPI(),
      ctx = createMockContext();
    manager.appendMessage(fauxAssistantMessage("Owned native host-capture fixture only"));
    Object.assign(ctx, { sessionManager: manager, model: { provider: "faux", id: "test" } });
    mock.appendEntry.mockImplementation((type: string, data: unknown) => {
      manager.appendCustomEntry(type, structuredClone(data));
    });
    try {
      manager.appendCustomEntry("continuous-tasks:activation", { version: 1, enabled: true });
      setSessionScopeEnabled(true);
      startSupervisor(mock.api, ctx, "Owned original host-capture Goal");
      registerEventHandlers(mock.api);
      registerCommands(mock.api);
      expect(
        getHandler(mock, "tool_call")(
          {
            type: "tool_call",
            toolName: "write",
            toolCallId: "legacy-unmatched-host-intent",
            input: { path: "not-executed" },
          },
          ctx,
        ),
      ).toBeUndefined();
      holdSupervisor(mock.api, ctx, "fault", "Owned crash boundary", "interrupted");
      recoverSupervisor(mock.api, ctx);
      expect(currentRuntime().receiptStore?.pendingCount).toBe(0);
      expect(
        manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" && entry.customType === "continuous-tasks:control-facts",
          ),
      ).toBe(false);
      if (physical) expect(readControlJournal(ctx).pendingHostCaptures).toHaveLength(1);
      const command = mock.registerCommand.mock.calls[0]![1];
      await command.handler("disable", ctx);
      expect(currentRuntime().journalFault).toBeUndefined();
      expect(currentRuntime().management).toMatchObject({
        mode: "supervised",
        state: "stopping-with-attention",
      });
      expect(currentRuntime().management?.attention.some((item) => item.kind === "capture")).toBe(
        true,
      );
    } finally {
      currentRuntime().cancel();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
