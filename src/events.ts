import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ContinuousTasksConfig } from "./config";
import { isSessionEnabled, loadConfig, resetConfig } from "./config";
import { formatContinuePrompt, formatHiddenContext } from "./formatting";
import {
  getBoardRef,
  persistEntries,
  reconstructState,
  setBoard,
  setBoardQuiet,
  setLastToolWasAdvance,
  updateUI,
} from "./state";
import type { TaskBoardSnapshot } from "./types";
import { hasActionableTasks, hasBlockedNonTerminalTasks, cloneBoard } from "./validation";

type RunOutcome = "normal" | "aborted" | "error";
type ConfigLoader = () => Promise<ContinuousTasksConfig>;

let activeCountdown: ReturnType<typeof setInterval> | null = null;
let activeTimeout: ReturnType<typeof setTimeout> | null = null;
let sessionAllowed = false;
let lastRunOutcome: RunOutcome = "normal";
let extensionContinuationGeneration: number | null = null;

function clearCountdown(ctx: ExtensionContext): void {
  if (activeCountdown !== null) clearInterval(activeCountdown);
  if (activeTimeout !== null) clearTimeout(activeTimeout);
  activeCountdown = null;
  activeTimeout = null;
  if (ctx.hasUI) ctx.ui.setWidget("continuous-tasks-countdown", undefined);
}

function sessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function runOutcome(messages: { role: string; stopReason?: string }[]): RunOutcome {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (message.stopReason === "aborted") return "aborted";
    if (message.stopReason === "error") return "error";
    return "normal";
  }
  return "normal";
}

function pause(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  eventType: "abort" | "error" | "deadlock" | "stagnation",
): void {
  const current = getBoardRef();
  if (current.workflowStatus !== "active") return;
  const updated = cloneBoard(current);
  updated.workflowStatus = "paused";
  updated.pauseReason = reason;
  updated.generation++;
  persistEntries(pi, { type: `pause_${eventType}`, reason }, updated);
  setBoard(updated);
  updateUI(ctx, updated);
  pi.sendMessage(
    {
      customType: "continuous-tasks:notice",
      content: `Continuous Tasks paused: ${reason}`,
      display: true,
    },
    { triggerTurn: false },
  );
}

function continuationMessage(board: Readonly<TaskBoardSnapshot>, prefix = ""): string {
  return `${prefix}${formatContinuePrompt(board)}`;
}

function sendContinuation(
  pi: ExtensionAPI,
  board: Readonly<TaskBoardSnapshot>,
  prompt: string,
): void {
  extensionContinuationGeneration = board.generation;
  pi.sendMessage(
    {
      customType: "continuous-tasks:continue",
      content: prompt,
      display: false,
      details: {
        generation: board.generation,
        actionableTaskIds: board.tasks
          .filter((task) => ["ready", "implementing", "reviewing"].includes(task.status))
          .map((task) => task.id),
      },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function scheduleContinuation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: ContinuousTasksConfig,
  prompt: string,
): void {
  clearCountdown(ctx);
  const scheduledGeneration = getBoardRef().generation;
  const fire = () => {
    const board = getBoardRef();
    if (
      board.generation !== scheduledGeneration ||
      board.workflowStatus !== "active" ||
      !hasActionableTasks(board)
    ) {
      return;
    }
    sendContinuation(pi, board, prompt);
  };

  if (!ctx.hasUI || config.countdownMs === 0) {
    activeTimeout = setTimeout(() => {
      activeTimeout = null;
      fire();
    }, config.countdownMs);
    return;
  }

  let remaining = Math.ceil(config.countdownMs / 1000);
  ctx.ui.setWidget(
    "continuous-tasks-countdown",
    [`⏳ Auto-continuing in ${remaining}s... (type anything to interrupt)`],
    { placement: "aboveEditor" },
  );
  activeCountdown = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      ctx.ui.setWidget(
        "continuous-tasks-countdown",
        [`⏳ Auto-continuing in ${remaining}s... (type anything to interrupt)`],
        { placement: "aboveEditor" },
      );
      return;
    }
    clearCountdown(ctx);
    fire();
  }, 1000);
}

function consumePhasePrompt(pi: ExtensionAPI): string {
  const board = getBoardRef();
  if (!board.pendingPhasePrompt) return "";
  const prompt = `${board.pendingPhasePrompt.message}\n\n`;
  pi.sendMessage(
    {
      customType: "continuous-tasks:notice",
      content: `Phase ${board.pendingPhasePrompt.phase} complete.`,
      display: true,
    },
    { triggerTurn: false },
  );
  const updated = cloneBoard(board);
  updated.pendingPhasePrompt = undefined;
  updated.generation++;
  setBoardQuiet(updated);
  pi.appendEntry("continuous-tasks:snapshot", updated);
  return prompt;
}

function recordStagnation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: ContinuousTasksConfig,
): boolean {
  const board = getBoardRef();
  if (extensionContinuationGeneration === null) return false;
  const madeProgress = board.generation !== extensionContinuationGeneration;
  extensionContinuationGeneration = null;
  if (madeProgress) return false;

  const updated = cloneBoard(board);
  updated.stagnantSettles++;
  updated.generation++;
  if (updated.stagnantSettles >= config.maxStagnantSettles) {
    setBoardQuiet(updated);
    pause(
      pi,
      ctx,
      `No task-board progress across ${config.maxStagnantSettles} automatic continuations`,
      "stagnation",
    );
    return true;
  }
  persistEntries(pi, { type: "stagnant_settle", count: updated.stagnantSettles }, updated);
  setBoardQuiet(updated);
  return false;
}

export function registerEventHandlers(
  pi: ExtensionAPI,
  configLoader: ConfigLoader = loadConfig,
): void {
  sessionAllowed = false;
  lastRunOutcome = "normal";
  extensionContinuationGeneration = null;

  pi.on("session_start", async (_event, ctx) => {
    resetConfig();
    clearCountdown(ctx);
    setLastToolWasAdvance(false);
    extensionContinuationGeneration = null;
    lastRunOutcome = "normal";
    const board = reconstructState(ctx);
    setBoard(board);
    updateUI(ctx, board);
    sessionAllowed = isSessionEnabled(await configLoader(), sessionId(ctx));
  });

  pi.on("session_tree", async (_event, ctx) => {
    clearCountdown(ctx);
    setLastToolWasAdvance(false);
    extensionContinuationGeneration = null;
    const board = reconstructState(ctx);
    setBoard(board);
    updateUI(ctx, board);
    sessionAllowed = isSessionEnabled(await configLoader(), sessionId(ctx));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearCountdown(ctx);
    sessionAllowed = false;
    extensionContinuationGeneration = null;
  });

  pi.on("before_agent_start", () => {
    const board = getBoardRef();
    if (!sessionAllowed || board.workflowStatus !== "active") return;
    return {
      message: {
        customType: "continuous-tasks:context",
        content: formatHiddenContext(board),
        display: false,
      },
    };
  });

  pi.on("agent_end", (event) => {
    lastRunOutcome = runOutcome(event.messages);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const config = await configLoader();
    if (!isSessionEnabled(config, sessionId(ctx))) return;
    const board = getBoardRef();
    if (board.workflowStatus !== "active") return;
    if (lastRunOutcome === "aborted") {
      pause(pi, ctx, "The user aborted the last run", "abort");
      return;
    }
    if (lastRunOutcome === "error") {
      pause(pi, ctx, "The last run still failed after Pi retries", "error");
      return;
    }
    if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    if (recordStagnation(pi, ctx, config)) return;

    const current = getBoardRef();
    if (hasActionableTasks(current)) {
      const phasePrompt = consumePhasePrompt(pi);
      const refreshed = getBoardRef();
      scheduleContinuation(pi, ctx, config, continuationMessage(refreshed, phasePrompt));
      return;
    }
    if (hasBlockedNonTerminalTasks(current)) {
      pause(pi, ctx, "Non-terminal tasks remain but none are actionable", "deadlock");
    }
  });

  pi.on("input", (_event, ctx) => {
    clearCountdown(ctx);
    extensionContinuationGeneration = null;
    setLastToolWasAdvance(false);
  });

  pi.on("tool_result", (event) => {
    const toolName = (event as { toolName?: string }).toolName;
    if (toolName !== "advance_tasks") setLastToolWasAdvance(false);
  });
}
