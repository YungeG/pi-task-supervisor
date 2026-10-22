import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { readGoalHistory, type GoalHistoryItem, type GoalHistorySummary } from "./goal-history";
import { buildUiSummary, type UiBoardView, type UiDocument } from "./ui-view";
import { freezeClone } from "./ui-capture";
import { createReadOnlyBoard } from "./board-view";
import { suspendTaskWidget } from "./board-ui";
import { beginReadOnlyView } from "./ui-view-lifecycle";
import { hasActiveNativeQuestion } from "./human-ui";
import { SUPERVISOR_LIMITS } from "./flow";

/** Archived DTO only; never call a current owner or temporarily install an old runtime. */
export function captureGoalHistoryView(ctx: ExtensionContext, item: GoalHistoryItem): UiBoardView {
  const scope = {
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
    generation: item.board.generation,
    capturedAt: Date.now(),
  };
  const summary = buildUiSummary({
    scope,
    board: item.board,
    supervisor: item.supervisor ? { ...item.supervisor, receipts: [] } : undefined,
    preflight: item.preflight ?? undefined,
    facts: { enabled: false, sessionId: scope.sessionId, idle: false, pending: false },
    limits: SUPERVISOR_LIMITS,
  });
  const immutable = {
    ...summary,
    headline: {
      text: `历史目标（只读）：${item.phase}`,
      source: "board" as const,
      level: "info" as const,
    },
    next: {
      text: "归档历史；不切换当前目标，不恢复、不批准、不启动",
      source: "board" as const,
      level: "info" as const,
    },
  };
  const document = (id: UiDocument["id"], title: string, value: unknown): UiDocument => ({
    id,
    title,
    availability: "available",
    text: `历史原值/记录，不是当前授权或重新验收：\n${JSON.stringify(value, null, 2)}`,
  });
  return freezeClone({
    summary: immutable,
    board: item.board,
    documents: [
      document("overview", "历史目标总览", {
        goal: item.goal,
        goalKey: item.goalKey,
        originalPhase: item.phase,
        archiveEntryId: item.archiveEntryId,
        counts: item.counts,
        usage: item.usage,
        receiptCount: item.receiptCount,
        boardWasRecorded: item.boardWasRecorded,
        note: "旧 receipts 原始内容保留在原分支；本页不复制或承接到新目标。任务 implementing 不是当前进程存活证明。",
      }),
      document("acceptance", "历史目标验收与额度", item.supervisor),
      {
        id: "current-board-request",
        title: "历史页面没有可操作的当前请求",
        availability: "absent",
        text: "此页没有 approve/start/resume/recover 操作；查看记录不改变当前目标。",
      },
      document("latest-board-response", "历史请求与回应", item.responses),
      document("preflight", "原权限/启动方案（不适用于当前目标）", item.preflight),
    ],
  });
}
function label(item: GoalHistorySummary, index: number): string {
  const raw = `${index + 1}. ${item.goalKey} · ${item.phase} · ${item.counts.done}/${item.counts.total} done · ${item.goal}`;
  return stripTerminalSequences(
    truncateToWidth(stripTerminalSequences(raw).replace(/[\p{Cc}\p{Cf}]/gu, " "), 120, "…"),
  );
}
async function selectHistory(
  ctx: ExtensionContext,
  current: () => boolean,
  signal: AbortSignal,
  initialCursor = "0",
): Promise<string | undefined> {
  let cursor = initialCursor;
  while (current()) {
    const page = readGoalHistory(ctx, cursor);
    if (!page.items.length) {
      ctx.ui.notify("尚无已归档目标；当前目标未被切换。", "info");
      return undefined;
    }
    const labels = page.items.map(label);
    const next = "下一页（只读）";
    const back = "返回当前目标（不切换、不执行）";
    const options = [back, ...labels, ...(page.nextCursor ? [next] : [])];
    const selected = await ctx.ui.select("目标历史（只读，不改变当前目标）", options, { signal });
    if (!current() || !selected || selected === back) return undefined;
    if (selected === next && page.nextCursor) {
      cursor = page.nextCursor;
      continue;
    }
    const index = labels.indexOf(selected);
    return page.items[index]?.goalKey;
  }
  return undefined;
}
function historyRequest(id?: string): { goalId?: string; cursor?: string } {
  return id?.startsWith("page:") ? { cursor: id.slice(5) } : { goalId: id };
}
function textHistory(ctx: ExtensionContext, id?: string): void {
  const query = historyRequest(id);
  const value = query.goalId
    ? readGoalHistory(ctx, "0", query.goalId)
    : readGoalHistory(ctx, query.cursor);
  ctx.ui.notify(`历史目标（只读，不是当前许可或验收）\n${JSON.stringify(value, null, 2)}`, "info");
}
async function renderArchive(
  ctx: ExtensionContext,
  view: UiBoardView,
  signal: AbortSignal,
  current: () => boolean,
): Promise<void> {
  let component: ReturnType<typeof createReadOnlyBoard> | undefined;
  let abort: (() => void) | undefined;
  try {
    await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
      let completed = false;
      const finish = () => {
        if (!completed) {
          completed = true;
          done(undefined);
        }
      };
      component = createReadOnlyBoard(
        view,
        {
          theme,
          keybindings,
          rows: () => Math.max(0, tui.terminal.rows - 10),
          requestRender: () => {
            tui.requestRender();
          },
        },
        finish,
      );
      abort = () => {
        component?.dispose();
        finish();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (!current()) abort();
      return component;
    });
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
    component?.dispose();
  }
}
export async function showGoalHistory(ctx: ExtensionContext, id?: string): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    textHistory(ctx, id);
    return;
  }
  if (hasActiveNativeQuestion(ctx)) {
    ctx.ui.notify("请先完成当前确认。", "info");
    return;
  }
  const lease = beginReadOnlyView(ctx);
  if (!lease) return;
  const token = suspendTaskWidget(ctx);
  const manager = ctx.sessionManager;
  const sessionId = manager.getSessionId();
  const anchor = manager.getLeafId();
  const current = () =>
    !lease.signal.aborted &&
    ctx.sessionManager === manager &&
    manager.getSessionId() === sessionId &&
    (anchor === null ||
      manager.getLeafId() === anchor ||
      manager.getBranch().some((entry) => entry.id === anchor));
  try {
    if (!token || !current()) return;
    const query = historyRequest(id);
    const selected =
      query.goalId ?? (await selectHistory(ctx, current, lease.signal, query.cursor));
    if (!selected || !current()) return;
    const item = readGoalHistory(ctx, "0", selected).items[0];
    if (!item) {
      ctx.ui.notify("未找到此分支上的历史目标；未切换当前目标。", "info");
      return;
    }
    const view = captureGoalHistoryView(ctx, item);
    await renderArchive(ctx, view, lease.signal, current);
  } catch {
    if (current()) ctx.ui.notify("历史看板暂不可用；未修改当前目标，请重新打开。", "info");
  } finally {
    lease.finish();
    token?.release();
  }
}
