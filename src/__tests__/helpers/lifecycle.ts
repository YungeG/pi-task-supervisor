import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG } from "../../config";
import { registerEventHandlers } from "../../events";
import { registerCommands } from "../../commands";
import type { Advisor } from "../../supervisor";
import type { TaskBoardSnapshot } from "../../types";
import { createMockAPI, createMockContext } from "./mocks";

export const NOW = "2026-08-23T00:00:00.000Z";
export const ACTIVATION = {
  type: "custom",
  customType: "continuous-tasks:activation",
  data: { version: 1, enabled: true },
};
export const BOUNDARY = {
  type: "agent_before_settle",
  outcome: "completed",
  continue: false,
  context: { canContinue: true, pendingMessages: [] },
};
export function activeBoard(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 3,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-2.1",
    stagnantSettles: 0,
    tasks: [
      {
        id: "t-1.1",
        title: "Implement",
        prompt: "Implement",
        profile: "worker",
        phase: 1,
        dependencies: [],
        status: "ready",
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "t-2.1",
        title: "Final acceptance",
        prompt: "Verify",
        profile: "reviewer",
        phase: 2,
        dependencies: ["t-1.1"],
        status: "configured",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [
      { phase: 1, status: "active", title: "Implement" },
      { phase: 2, status: "pending", title: "Accept" },
    ],
    ...overrides,
  };
}
export function getHandler(mock: ReturnType<typeof createMockAPI>, name: string) {
  const call = mock.on.mock.calls.find(([event]) => event === name);
  if (!call) throw new Error(`Unregistered event: ${name}`);
  return call[1] as (event: any, ctx: ExtensionContext) => any;
}
export function lifecycle(advisor?: Advisor) {
  const mock = createMockAPI();
  const ctx = createMockContext();
  Object.assign(ctx, { model: { provider: "faux", id: "test" } });
  registerEventHandlers(mock.api, async () => DEFAULT_CONFIG, advisor);
  registerCommands(mock.api);
  const command = mock.registerCommand.mock.calls[0]?.[1] as {
    handler: (args: string, context: ReturnType<typeof createMockContext>) => Promise<void>;
  };
  return {
    mock,
    ctx,
    fire: (name: string, event: unknown = {}) => getHandler(mock, name)(event, ctx),
    command: (args: string) => command.handler(args, ctx),
  };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
