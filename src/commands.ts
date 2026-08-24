import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatContinuePrompt, formatSummaryLine } from "./formatting";
import { enableSessionScope, isSessionScopeEnabled } from "./scope";
import { getBoardRef, persistEntries, setBoard, updateUI } from "./state";
import { cloneBoard, hasActionableTasks, isSafeBoundedText } from "./validation";

function notifyError(ctx: ExtensionCommandContext, message: string): void {
  if (ctx.hasUI) ctx.ui.notify(message, "error");
}

function continueNow(pi: ExtensionAPI): void {
  const board = getBoardRef();
  if (!hasActionableTasks(board)) return;
  pi.sendMessage(
    {
      customType: "continuous-tasks:continue",
      content: formatContinuePrompt(board),
      display: false,
      details: { generation: board.generation },
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
}

function pause(pi: ExtensionAPI, ctx: ExtensionCommandContext, reason: string): void {
  const board = getBoardRef();
  if (board.workflowStatus !== "active") {
    notifyError(ctx, "Continuous Tasks is not active");
    return;
  }
  const updated = cloneBoard(board);
  updated.workflowStatus = "paused";
  updated.pauseReason = reason || "Paused by user";
  updated.generation++;
  persistEntries(pi, { type: "pause_user", reason: updated.pauseReason }, updated);
  setBoard(updated);
  updateUI(ctx, updated);
}

function resume(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const board = getBoardRef();
  if (board.workflowStatus !== "paused") {
    notifyError(ctx, "Continuous Tasks is not paused");
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
  ctx.ui.notify(
    `${formatSummaryLine(board)}; ${board.workflowStatus}; generation ${board.generation}; stagnant ${board.stagnantSettles}${decision}${pauseReason}`,
    "info",
  );
}

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("continuous-tasks", {
    description: "Enable or control Continuous Tasks for this session",
    handler(args, ctx) {
      const [action = "status", id, ...answerParts] = args.trim().split(/\s+/);
      if (action === "enable") {
        if (isSessionScopeEnabled()) {
          ctx.ui.notify("Continuous Tasks is already enabled for this session", "info");
          return Promise.resolve();
        }
        enableSessionScope(pi);
        ctx.ui.notify("Continuous Tasks enabled for this session", "info");
        return Promise.resolve();
      }
      if (!isSessionScopeEnabled()) {
        notifyError(ctx, "Continuous Tasks is disabled; run /continuous-tasks enable");
        return Promise.resolve();
      }
      if (action === "status") {
        status(ctx);
        return Promise.resolve();
      }
      if (action === "pause") {
        pause(pi, ctx, [id, ...answerParts].filter(Boolean).join(" "));
        return Promise.resolve();
      }
      if (action === "resume") {
        resume(pi, ctx);
        return Promise.resolve();
      }
      if (action === "resolve") {
        resolveDecision(pi, ctx, id, answerParts.join(" "));
        return Promise.resolve();
      }
      notifyError(
        ctx,
        "Usage: /continuous-tasks enable|status|pause [reason]|resume|resolve <id> <answer>",
      );
      return Promise.resolve();
    },
  });
}
