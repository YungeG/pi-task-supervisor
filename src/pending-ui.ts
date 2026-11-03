import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { hasActiveNativeQuestion } from "./human-ui";
import { captureUiSummary } from "./ui-capture";
import { showTaskList } from "./board-ui";
import { currentRuntime } from "./runtime";
import { getBoardRef } from "./state";
import { requestIdleHuman, seedIdleHuman, cancelIdleHuman, idleHumanSupported } from "./idle-human";

/** Configuration only; registration neither activates management nor grants control. */
function pendingKey(): KeyId | undefined {
  const value = process.env.PI_TASK_SUPERVISOR_PENDING_KEY ?? "ctrl+shift+y";
  return /^ctrl\+shift\+[a-z]$/u.test(value) ? (value as KeyId) : undefined;
}

function needsAttention(ctx: ExtensionContext): boolean {
  const runtime = currentRuntime();
  if (!runtime.enabled) return false;
  const sessionId = ctx.sessionManager.getSessionId();
  const preflight = runtime.preflight;
  const supervisor = runtime.supervisor;
  return Boolean(
    runtime.journalFault ||
    runtime.board.decision ||
    runtime.board.workflowStatus === "paused" ||
    (preflight?.sessionId === sessionId &&
      ["awaiting_authorization", "approved", "revoked", "interrupted"].includes(preflight.phase)) ||
    (supervisor?.sessionId === sessionId && ["paused", "fault"].includes(supervisor.status)),
  );
}

/** Stable request/material identity; ordinary transcript leaf changes must not re-notify. */
function requestIdentity(): readonly unknown[] {
  const runtime = currentRuntime();
  const preflight = runtime.preflight;
  const requests =
    preflight?.version === 2 ? [preflight.permissionRequest?.id, preflight.startRequest?.id] : null;
  const scopeProposal = runtime.controlJournal?.acceptance?.scopeProposals?.at(-1);
  return [
    runtime.goalEpoch,
    runtime.board.decision?.id,
    preflight?.planDigest,
    preflight?.proposal?.contractProposalId,
    requests,
    scopeProposal ? [scopeProposal.entryId, scopeProposal.digest] : null,
  ];
}

function notifyPendingUi(
  ctx: ExtensionContext,
  notices: WeakMap<object, string>,
  key: KeyId | undefined,
): void {
  try {
    const summary = captureUiSummary(ctx, getBoardRef());
    const runtime = currentRuntime();
    const fingerprint = JSON.stringify([
      summary.scope.sessionId,
      requestIdentity(),
      runtime.goal?.current?.scope.goalRunId,
      runtime.preflight?.preflightId,
      runtime.preflight?.revision,
      runtime.board.generation,
      summary.headline.text,
      summary.next.text,
    ]);
    if (notices.get(ctx.sessionManager) === fingerprint) return;
    const native = idleHumanSupported(ctx);
    ctx.ui.notify(
      native
        ? `待你处理：${summary.headline.text}\n${summary.next.text}\n${key ?? "/task-supervisor tasks"} → 检查当前待办；每项操作仍需独立原生确认。`
        : `待你处理（只读提示）：${summary.headline.text}\n${summary.next.text}\n${key ?? "/task-supervisor tasks"} → 确认与回应；此入口不批准、不启动、不恢复。完整自动控制尚缺宿主 H0。`,
      "info",
    );
    notices.set(ctx.sessionManager, fingerprint);
  } catch {
    // Optional notification cannot change any saved control or schedule Main.
  }
}

/** Legacy hosts stay A-only; new controls always cross the qualified host lease. */
export function registerPendingUi(pi: ExtensionAPI): void {
  const key = pendingKey();
  const notices = new WeakMap<object, string>();
  pi.on("session_start", (_event, ctx) => {
    seedIdleHuman(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    seedIdleHuman(ctx);
  });
  pi.on("session_shutdown", () => {
    cancelIdleHuman();
  });
  if (key) {
    pi.registerShortcut(key, {
      description: "查看待处理确认与回应（旧宿主只读；原生操作仍需独立确认）",
      async handler(ctx) {
        if (!ctx.hasUI || ctx.mode !== "tui") return;
        if (await requestIdleHuman(pi, ctx, "shortcut")) return;
        if (!ctx.isIdle() || ctx.hasPendingMessages() || hasActiveNativeQuestion(ctx)) {
          ctx.ui.notify("请等待当前工作或确认结束后再打开只读待办；不会中断 Main。", "info");
          return;
        }
        await showTaskList(ctx, getBoardRef(), "confirmation");
      },
    });
  }
  pi.on("agent_settled", async (event, ctx) => {
    if (!event.aborted && (await requestIdleHuman(pi, ctx, "automatic"))) return;
    if (event.aborted || !ctx.hasUI || ctx.mode !== "tui" || !needsAttention(ctx)) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages() || hasActiveNativeQuestion(ctx)) return;
    notifyPendingUi(ctx, notices, key);
  });
}
