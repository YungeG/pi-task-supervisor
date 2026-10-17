import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { captureUiBoardView, captureUiSummary } from "./ui-capture";
import { createReadOnlyBoard, renderCompactBoard } from "./board-view";
import type { UiSummary } from "./ui-view";
import { refreshUI } from "./state";
import { hasActiveNativeQuestion } from "./human-ui";
import { beginReadOnlyView } from "./ui-view-lifecycle";
import { phaseLabel } from "./formatting";
import { flowFacts, nextFlowStep } from "./flow";
import { currentRuntime } from "./runtime";
import { preflightSummary } from "./human-presentation";
import type { PreflightState } from "./preflight";
import type { SupervisorState } from "./supervisor";
import type { TaskBoardSnapshot, TaskRecord } from "./types";

export const TASK_WIDGET_KEY = "continuous-tasks:board";
type Manager = ExtensionContext["sessionManager"];
type DisplayScope = Readonly<{ sessionId: string; anchor: string | null }>;
type DisplayEpoch = DisplayScope & {
  live: boolean;
  tokens: Set<object>;
  publication?: object;
};
const displayEpochs = new WeakMap<Manager, DisplayEpoch>();

function displayCurrent(
  ctx: ExtensionContext,
  manager: Manager,
  epoch: DisplayEpoch,
  scope: DisplayScope = epoch,
): boolean {
  try {
    return (
      epoch.live &&
      displayEpochs.get(manager) === epoch &&
      ctx.sessionManager === manager &&
      manager.getSessionId() === scope.sessionId &&
      (scope.anchor === null ||
        manager.getLeafId() === scope.anchor ||
        manager.getBranch().some((entry) => entry.id === scope.anchor))
    );
  } catch {
    return false;
  }
}

function displayEpoch(ctx: ExtensionContext): DisplayEpoch {
  const manager = ctx.sessionManager;
  const previous = displayEpochs.get(manager);
  if (previous && displayCurrent(ctx, manager, previous)) return previous;
  if (previous?.live && previous.tokens.size)
    throw new Error("Active UI suppression has uncertain identity");
  if (previous) previous.live = false;
  const sessionId = manager.getSessionId();
  const anchor = manager.getLeafId();
  if (!sessionId || (anchor !== null && !anchor)) throw new Error("Unavailable UI identity");
  const epoch = { sessionId, anchor, live: true, tokens: new Set<object>() };
  displayEpochs.set(manager, epoch);
  return epoch;
}

/** Invalidate only this extension's display epoch before lifecycle joins. */
export function invalidateTaskWidget(ctx: ExtensionContext): void {
  const epoch = displayEpochs.get(ctx.sessionManager);
  if (epoch) {
    epoch.live = false;
    epoch.publication = undefined;
  }
}

/** Display-only suppression; never an admission or answer capability. */
export function suspendTaskWidget(
  ctx: ExtensionContext,
): Readonly<{ release(): void }> | undefined {
  if (!ctx.hasUI || ctx.mode !== "tui") return undefined;
  let epoch: DisplayEpoch | undefined;
  const token = {};
  try {
    const manager = ctx.sessionManager;
    epoch = displayEpoch(ctx);
    const captured = epoch;
    const scope = { sessionId: manager.getSessionId(), anchor: manager.getLeafId() };
    if (!scope.sessionId || (scope.anchor !== null && !scope.anchor)) return undefined;
    epoch.tokens.add(token);
    epoch.publication = undefined;
    ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
    if (!displayCurrent(ctx, manager, captured, scope)) {
      captured.tokens.delete(token);
      return undefined;
    }
    let released = false;
    return {
      release(): void {
        if (released) return;
        released = true;
        captured.tokens.delete(token);
        try {
          if (captured.tokens.size || !displayCurrent(ctx, manager, captured, scope)) return;
          captured.publication = undefined;
          refreshUI(ctx);
        } catch {
          // Optional display transport/identity cannot change an owner result.
        }
      },
    };
  } catch {
    epoch?.tokens.delete(token);
    return undefined;
  }
}

const STATUS_ORDER = {
  implementing: 0,
  reviewing: 0,
  ready: 1,
  configured: 2,
  draft: 3,
  done: 4,
  abandoned: 5,
};

const SUPERVISOR_COLORS = {
  active: "accent",
  reviewing: "accent",
  completed: "success",
  fault: "error",
  paused: "warning",
  stopped: "warning",
} satisfies Record<SupervisorState["status"], ThemeColor>;

/** Display-only normalization: never change the task or its evidence. */
function text(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function orderedTasks(board: Readonly<TaskBoardSnapshot>): TaskRecord[] {
  return [...board.tasks].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.phase - b.phase,
  );
}

function taskNotes(board: Readonly<TaskBoardSnapshot>, task: TaskRecord): string[] {
  const notes: string[] = [];
  const unmet = task.dependencies.filter(
    (id) => board.tasks.find((dependency) => dependency.id === id)?.status !== "done",
  );
  if (unmet.length) notes.push(`waiting for ${unmet.map(text).join(", ")}`);
  if (task.status === "draft") notes.push("plan not compiled");
  if (
    task.status === "configured" &&
    board.phases.some((phase) => phase.phase === task.phase && phase.status === "pending")
  )
    notes.push(`waiting for phase ${task.phase}`);
  if (task.executionRef)
    notes.push(`run ${task.executionRef.source}:${text(task.executionRef.runId)}; status unknown`);
  return notes;
}

function taskRow(board: Readonly<TaskBoardSnapshot>, task: TaskRecord): string {
  const notes = taskNotes(board, task);
  return `[${task.status}] ${text(task.id)} ${text(task.title)}${notes.length ? ` — ${notes.join("; ")}` : ""}`;
}

function currentPreflight(ctx: ExtensionContext): PreflightState | undefined {
  const state = currentRuntime().preflight;
  return state?.sessionId === ctx.sessionManager.getSessionId() ? state : undefined;
}

type HeaderLine = { text: string; color: ThemeColor };
function preflightView(ctx: ExtensionContext) {
  const state = currentPreflight(ctx);
  if (!state) return undefined;
  const runtime = currentRuntime();
  const repair = runtime.preflightRepair?.sessionId === ctx.sessionManager.getSessionId();
  const summary = preflightSummary(
    state,
    repair ? "repair" : runtime.journalFault ? "fault" : undefined,
  );
  return { state, repair, summary };
}

function progressHeader(
  board: Readonly<TaskBoardSnapshot>,
  view: ReturnType<typeof preflightView>,
): HeaderLine[] {
  const done = board.tasks.filter((task) => task.status === "done").length;
  const abandoned = board.tasks.filter((task) => task.status === "abandoned").length;
  const unfinished = board.tasks.length - done - abandoned;
  const phase = board.phases.find((item) => item.status === "active");
  const lines: HeaderLine[] = [
    {
      text:
        view && !board.tasks.length
          ? "Tasks: 执行前确认"
          : `Tasks: ${done}/${board.tasks.length} done · ${unfinished} unfinished${abandoned ? ` · ${abandoned} abandoned` : ""}`,
      color: "muted",
    },
    {
      text: view
        ? `状态：${view.summary.label}`
        : `Workflow: ${board.workflowStatus} · ${phase ? text(phaseLabel(board, phase.phase)) : "No active phase"}`,
      color: view?.summary.color ?? (board.workflowStatus === "completed" ? "success" : "muted"),
    },
  ];
  if (view && !board.tasks.length)
    lines.push({ text: `目标：${text(view.state.goal)}`, color: "muted" });
  return lines;
}

function nextHeader(
  board: Readonly<TaskBoardSnapshot>,
  ctx: ExtensionContext,
  view: ReturnType<typeof preflightView>,
): HeaderLine[] {
  const { supervisor, journalFault } = currentRuntime();
  if (!(supervisor || journalFault || board.decision || view)) return [];
  let next: string;
  if (view && (!supervisor || view.repair) && !board.decision)
    next =
      !ctx.isIdle() || ctx.hasPendingMessages()
        ? "等待当前主流程与待处理消息结束，再处理确认"
        : view.summary.next;
  else next = nextFlowStep(board, supervisor, flowFacts(ctx));
  return [{ text: `${view ? "下一步：" : "Next: "}${text(next)}`, color: "muted" }];
}

function boardHeader(board: Readonly<TaskBoardSnapshot>, ctx: ExtensionContext): HeaderLine[] {
  const view = preflightView(ctx);
  const lines = progressHeader(board, view);
  const { supervisor, journalFault } = currentRuntime();
  if (supervisor)
    lines.push({
      text: `Supervisor: ${supervisor.status}${supervisor.externalWait ? " (external wait; last owner report)" : ""}${supervisor.reason ? ` — ${text(supervisor.reason)}` : ""}`,
      color: SUPERVISOR_COLORS[supervisor.status],
    });
  lines.push(...nextHeader(board, ctx, view));
  if (journalFault) lines.push({ text: `Fault: ${text(journalFault)}`, color: "error" });
  if (board.workflowStatus === "paused")
    lines.push({
      text: `Paused: ${text(board.pauseReason ?? "Paused by user")}`,
      color: "warning",
    });
  if (board.decision)
    lines.push({
      text: `Decision ${text(board.decision.id)} (${text(board.decision.taskId)}): ${text(board.decision.question)}`,
      color: "warning",
    });
  return lines;
}

/** A bounded TUI view of the existing board, not a second store. */
export function updateTaskWidget(
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  summary?: UiSummary,
): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  try {
    const manager = ctx.sessionManager;
    const epoch = displayEpoch(ctx);
    if (epoch.tokens.size) return;
    epoch.publication = undefined;
    const captured = summary ?? captureUiSummary(ctx, board);
    const scope = { sessionId: captured.scope.sessionId, anchor: captured.scope.leafId };
    const publication = {};
    epoch.publication = publication;
    const live = () => epoch.live && epoch.tokens.size === 0 && epoch.publication === publication;
    if (!captured.visible) {
      ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(
      TASK_WIDGET_KEY,
      (_tui, theme: Theme) => {
        const current = live() && displayCurrent(ctx, manager, epoch, scope);
        return {
          render: (width) => (current && live() ? renderCompactBoard(captured, width, theme) : []),
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );
  } catch {
    // Optional display failure cannot change the saved owner/carrier result.
    try {
      ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
    } catch {
      // The UI transport itself may be unavailable.
    }
  }
}

/** Scrollable full list and details; never activates, mutates, or schedules work. */
export async function showTaskList(
  ctx: ExtensionContext,
  snapshot: Readonly<TaskBoardSnapshot>,
): Promise<void> {
  if (!ctx.hasUI) return;
  if (ctx.mode !== "tui") return showLegacyTaskList(ctx, snapshot);
  if (hasActiveNativeQuestion(ctx)) {
    ctx.ui.notify("请先完成当前确认。", "info");
    return;
  }
  const lease = beginReadOnlyView(ctx);
  if (!lease) return;
  const token = suspendTaskWidget(ctx);
  let component: ReturnType<typeof createReadOnlyBoard> | undefined;
  let abort: (() => void) | undefined;
  let completed = false;
  try {
    if (!token) return;
    const manager = ctx.sessionManager;
    const epoch = displayEpochs.get(manager);
    if (!epoch) return;
    const view = captureUiBoardView(ctx, snapshot);
    const scope = { sessionId: view.summary.scope.sessionId, anchor: view.summary.scope.leafId };
    await ctx.ui.custom<undefined>((tui, theme, keybindings, done) => {
      const current = displayCurrent(ctx, manager, epoch, scope);
      const finish = () => {
        if (completed) return;
        completed = true;
        done(undefined);
      };
      component = createReadOnlyBoard(
        view,
        {
          theme,
          keybindings,
          requestRender: () => {
            tui.requestRender();
          },
          rows: () => Math.max(0, tui.terminal.rows - 10),
        },
        finish,
      );
      abort = () => {
        component?.dispose();
        finish();
      };
      lease.signal.addEventListener("abort", abort, { once: true });
      if (lease.signal.aborted || !current || !epoch.live) abort();
      return component;
    });
  } catch {
    try {
      ctx.ui.notify("看板暂不可用，请重新打开。", "info");
    } catch {
      /* Optional transport. */
    }
  } finally {
    completed = true;
    if (abort) lease.signal.removeEventListener("abort", abort);
    component?.dispose();
    lease.finish();
    token?.release();
  }
}

async function showLegacyTaskList(
  ctx: ExtensionContext,
  snapshot: Readonly<TaskBoardSnapshot>,
): Promise<void> {
  const board = structuredClone(snapshot);
  const header = boardHeader(board, ctx).map((line) => line.text);
  if (!board.tasks.length) {
    ctx.ui.notify([...header, "No tasks"].join("\n"), "info");
    return;
  }
  const tasks = orderedTasks(board);
  const options = tasks.map((task) => `Phase ${task.phase} · ${taskRow(board, task)}`);
  const selected = await ctx.ui.select(`${header[0]} · generation ${board.generation}`, options);
  const task = tasks[options.indexOf(selected ?? "")];
  if (!task) return;
  const details = [
    ...header,
    `Generation: ${board.generation}`,
    taskRow(board, task),
    `Phase: ${text(phaseLabel(board, task.phase))}`,
    `Profile: ${text(task.profile)}`,
    `Prompt: ${text(task.prompt)}`,
  ];
  if (task.completionEvidence) {
    const evidence = task.completionEvidence;
    details.push(`Evidence: ${text(evidence.summary)}`);
    for (const ref of evidence.refs)
      details.push(
        `  ${ref.kind} ${ref.status}: ${text(ref.label)}${ref.ref ? ` (${text(ref.ref)})` : ""}`,
      );
    for (const risk of evidence.residualRisks ?? []) details.push(`Residual risk: ${text(risk)}`);
  }
  ctx.ui.notify(details.join("\n"), "info");
}
