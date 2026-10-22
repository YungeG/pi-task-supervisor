import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { createEmptyBoard } from "./engine";
import type { SupervisorState } from "./supervisor";
import type { PreflightState } from "./preflight";
import type { ReceiptStore } from "./receipt-store";
import type { TaskBoardSnapshot } from "./types";
import type { GoalRuntime } from "./goal-records";

export interface ProjectionRepairHint {
  sessionId: string;
  controlEntryId: string;
  projectedDigest: string;
  faultMessage: string;
  ownsJournalFault: boolean;
}

export interface TaskRuntime {
  board: TaskBoardSnapshot;
  goal: GoalRuntime | undefined;
  goalEpoch: number;
  planningLease: string | undefined;
  enabled: boolean;
  cancel: () => void;
  manualPauseDepth: number;
  supervisor: SupervisorState | undefined;
  receiptStore: ReceiptStore | undefined;
  receiptIdentity: string | undefined;
  preflight: PreflightState | undefined;
  preflightRepair?: ProjectionRepairHint;
  boardRepair?: ProjectionRepairHint;
  journalFault: string | undefined;
  humanEpoch: number;
  humanAbort: AbortController | undefined;
  boardHumanContext: { sessionId: string; content: string } | undefined;
}

export function createRuntime(): TaskRuntime {
  return {
    board: createEmptyBoard(),
    goal: undefined,
    goalEpoch: 0,
    planningLease: undefined,
    enabled: false,
    cancel: (): void => undefined,
    manualPauseDepth: 0,
    supervisor: undefined as SupervisorState | undefined,
    receiptStore: undefined as ReceiptStore | undefined,
    receiptIdentity: undefined as string | undefined,
    preflight: undefined as PreflightState | undefined,
    preflightRepair: undefined,
    boardRepair: undefined,
    journalFault: undefined as string | undefined,
    humanEpoch: 0,
    humanAbort: undefined,
    boardHumanContext: undefined,
  };
}

const storage = new AsyncLocalStorage<TaskRuntime>();
const testRuntime = createRuntime();

export function currentRuntime(): TaskRuntime {
  return storage.getStore() ?? testRuntime;
}

/** Every callback (and its awaits) belongs to one extension instance, never a global board. */
export function scopedAPI(pi: ExtensionAPI, setup: (api: ExtensionAPI) => void): void {
  const runtime = createRuntime();
  const register = pi.on.bind(pi) as (
    name: string,
    handler: (...args: unknown[]) => unknown,
  ) => () => void;
  const on = ((name: string, handler: (...args: unknown[]) => unknown) =>
    register(name, (...args) =>
      storage.run(runtime, () => handler(...args)),
    )) as ExtensionAPI["on"];
  const scoped: ExtensionAPI = {
    ...pi,
    on,
    registerTool<TParams extends TSchema, TDetails>(tool: ToolDefinition<TParams, TDetails>) {
      pi.registerTool({
        ...tool,
        executionMode: "sequential",
        execute: (...args) => storage.run(runtime, () => tool.execute(...args)),
      });
    },
    registerCommand(name, command) {
      pi.registerCommand(name, {
        ...command,
        handler: (...args) => storage.run(runtime, () => command.handler(...args)),
      });
    },
  };
  storage.run(runtime, () => {
    setup(scoped);
  });
}
