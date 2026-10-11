import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatContinuePrompt, formatSummaryLine } from "./formatting";
import { currentRuntime } from "./runtime";
import { showTaskList } from "./board-ui";
import {
  holdSupervisor,
  recoverSupervisor,
  saveSupervisor,
  startSupervisor,
  supervisorNotice,
  supervisorState,
} from "./supervisor";
import { enableSessionScope, isSessionScopeEnabled } from "./scope";
import { getBoardRef, persistEntries, setBoard, updateUI } from "./state";
import { cloneBoard, hasActionableTasks, isSafeBoundedText } from "./validation";

function notifyError(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function continueNow(pi: ExtensionAPI): void {
  const board = getBoardRef();
  const state = supervisorState();
  if (state && state.status !== "stopped" && state.status !== "active") return;
  if (["paused", "waiting_for_decision"].includes(board.workflowStatus)) return;
  if (state?.status !== "active" && !hasActionableTasks(board)) return;
  pi.sendMessage(
    {
      customType: "continuous-tasks:continue",
      content:
        state?.status === "active"
          ? `User-recorded goal: ${state.goal}\nContinue authorized work on the task board, or prepare a complete phased plan with final acceptance. Preserve all approvals and gates. ${formatContinuePrompt(board)}`
          : formatContinuePrompt(board),
      display: false,
      details: { generation: board.generation },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function pause(pi: ExtensionAPI, ctx: ExtensionCommandContext, reason: string): void {
  const board = getBoardRef();
  if (board.workflowStatus !== "active") {
    if (supervisorState()) holdSupervisor(pi, ctx, "paused", reason || "Paused by user");
    else notifyError(ctx, "Pi Task Supervisor is not active");
    return;
  }
  const updated = cloneBoard(board);
  updated.workflowStatus = "paused";
  updated.pauseReason = reason || "Paused by user";
  updated.generation++;
  persistEntries(pi, { type: "pause_user", reason: updated.pauseReason }, updated);
  setBoard(updated);
  updateUI(ctx, updated);
  holdSupervisor(pi, ctx, "paused", updated.pauseReason);
}

function resume(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const board = getBoardRef();
  if (board.workflowStatus !== "paused") {
    notifyError(ctx, "Pi Task Supervisor is not paused");
    return;
  }
  const updated = cloneBoard(board);
  updated.workflowStatus = "active";
  updated.pauseReason = undefined;
  updated.generation++;
  updated.stagnantSettles = 0;
  persistEntries(pi, { type: "resume_user" }, updated);
  setBoard(updated);
  updateUI(ctx, updated);
  continueNow(pi);
}

function resolveDecision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id: string | undefined,
  answer: string,
): void {
  const board = getBoardRef();
  if (board.workflowStatus !== "waiting_for_decision" || !board.decision) {
    notifyError(ctx, "No decision is waiting");
    return;
  }
  if (id !== board.decision.id) {
    notifyError(ctx, `Decision id does not match ${board.decision.id}`);
    return;
  }
  if (!isSafeBoundedText(answer, 1000)) {
    notifyError(ctx, "Decision answer is empty, too long, or secret-like");
    return;
  }
  const updated = cloneBoard(board);
  updated.workflowStatus = "active";
  updated.decision = undefined;
  updated.generation++;
  updated.stagnantSettles = 0;
  persistEntries(pi, { type: "resolve_decision", id, answer }, updated);
  setBoard(updated);
  updateUI(ctx, updated);
  continueNow(pi);
}

function status(ctx: ExtensionCommandContext): void {
  const board = getBoardRef();
  const decision = board.decision ? `; decision ${board.decision.id}` : "";
  const pauseReason = board.pauseReason ? `; ${board.pauseReason}` : "";
  const state = supervisorState();
  const supervisor = state
    ? `; supervisor ${state.status}; reviews ${state.reviews}/40; resumes ${state.continuations}/20; tokens ${state.tokens}; cost ${state.cost}; ${state.reason ?? state.goal}`
    : "";
  ctx.ui.notify(
    `${formatSummaryLine(board)}; ${board.workflowStatus}; generation ${board.generation}; stagnant ${board.stagnantSettles}${decision}${pauseReason}${supervisor}`,
    "info",
  );
}

async function supervisorCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  if (action === "supervise") {
    await ctx.waitForIdle();
    startSupervisor(pi, ctx, text);
    enableSessionScope(pi);
    continueNow(pi);
    return true;
  }
  if (["pause", "stop", "recover"].includes(action)) {
    currentRuntime().cancel();
    if (!ctx.isIdle()) ctx.abort();
    await ctx.waitForIdle();
  }
  if (action === "stop") {
    const state = supervisorState();
    if (!state) throw new Error("No supervisor is registered");
    pause(pi, ctx, "Supervisor stopped by user");
    state.status = "stopped";
    state.pending = false;
    state.reason = "Stopped by user";
    saveSupervisor(pi);
    supervisorNotice(pi, ctx, state.reason);
    return true;
  }
  if (action === "recover") {
    recoverSupervisor(pi);
    supervisorNotice(
      pi,
      ctx,
      "Recovered explicitly. Inspect existing work before continuing; approvals are unchanged.",
    );
    continueNow(pi);
    return true;
  }
  return false;
}

export function registerCommands(pi: ExtensionAPI): void {
  const command = {
    description: "Enable or control Pi Task Supervisor for this session",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const [action = "status", id, ...answerParts] = args.trim().split(/\s+/);
      try {
        if (action === "tasks") {
          await showTaskList(ctx, getBoardRef());
          return;
        }
        if (currentRuntime().journalFault) throw new Error(currentRuntime().journalFault);
        if (
          await supervisorCommand(pi, ctx, action, [id, ...answerParts].filter(Boolean).join(" "))
        )
          return;
        if (action === "enable") {
          if (isSessionScopeEnabled()) {
            ctx.ui.notify("Pi Task Supervisor is already enabled for this session", "info");
            return;
          }
          enableSessionScope(pi);
          ctx.ui.notify("Pi Task Supervisor enabled for this session", "info");
          return;
        }
        if (!isSessionScopeEnabled()) {
          notifyError(ctx, "Pi Task Supervisor is disabled; run /task-supervisor enable");
          return;
        }
        if (action === "status") {
          status(ctx);
          return;
        }
        if (action === "pause") {
          pause(pi, ctx, [id, ...answerParts].filter(Boolean).join(" "));
          return;
        }
        if (action === "resume") {
          resume(pi, ctx);
          return;
        }
        if (action === "resolve") {
          resolveDecision(pi, ctx, id, answerParts.join(" "));
          return;
        }
        notifyError(
          ctx,
          "Usage: /task-supervisor enable|supervise <goal>|status|tasks|pause [reason]|resume|resolve <id> <answer>|recover|stop",
        );
      } catch (error) {
        notifyError(
          ctx,
          error instanceof Error ? error.message : "Pi Task Supervisor command failed",
        );
      }
    },
  };
  pi.registerCommand("task-supervisor", command);
  pi.registerCommand("continuous-tasks", command);
}
