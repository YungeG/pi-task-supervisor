import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { phaseLabel } from "./formatting";
import { currentRuntime } from "./runtime";
import { TERMINAL_STATUSES, type TaskBoardSnapshot, type TaskRecord } from "./types";

export const TASK_WIDGET_KEY = "continuous-tasks:board";
const MAX_WIDGET_LINES = 8;
const STATUS_ORDER = {
  implementing: 0,
  reviewing: 0,
  ready: 1,
  configured: 2,
  draft: 3,
  done: 4,
  abandoned: 5,
};

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
    notes.push(`run ${task.executionRef.source}:${text(task.executionRef.runId)}`);
  return notes;
}

function taskRow(board: Readonly<TaskBoardSnapshot>, task: TaskRecord): string {
  const notes = taskNotes(board, task);
  return `[${task.status}] ${text(task.id)} ${text(task.title)}${notes.length ? ` — ${notes.join("; ")}` : ""}`;
}

function boardHeader(board: Readonly<TaskBoardSnapshot>): string[] {
  const done = board.tasks.filter((task) => task.status === "done").length;
  const abandoned = board.tasks.filter((task) => task.status === "abandoned").length;
  const unfinished = board.tasks.length - done - abandoned;
  const activePhase = board.phases.find((phase) => phase.status === "active");
  const lines = [
    `Tasks: ${done}/${board.tasks.length} done · ${unfinished} unfinished${abandoned ? ` · ${abandoned} abandoned` : ""}`,
    `Workflow: ${board.workflowStatus} · ${activePhase ? text(phaseLabel(board, activePhase.phase)) : "No active phase"}`,
  ];
  const { supervisor, journalFault } = currentRuntime();
  if (supervisor)
    lines.push(
      `Supervisor: ${supervisor.status}${supervisor.reason ? ` — ${text(supervisor.reason)}` : ""}`,
    );
  if (journalFault) lines.push(`Fault: ${text(journalFault)}`);
  if (board.workflowStatus === "paused")
    lines.push(`Paused: ${text(board.pauseReason ?? "Paused by user")}`);
  if (board.decision)
    lines.push(
      `Decision ${text(board.decision.id)} (${text(board.decision.taskId)}): ${text(board.decision.question)}`,
    );
  return lines;
}

/** A bounded TUI view of the existing board, not a second store. */
export function updateTaskWidget(ctx: ExtensionContext, board: Readonly<TaskBoardSnapshot>): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const { supervisor, journalFault } = currentRuntime();
  if (!board.tasks.length && board.workflowStatus === "inactive" && !supervisor && !journalFault) {
    ctx.ui.setWidget(TASK_WIDGET_KEY, undefined);
    return;
  }
  const unfinished = orderedTasks(board).filter((task) => !TERMINAL_STATUSES.has(task.status));
  const lines = boardHeader(board);
  const visible = unfinished.slice(0, MAX_WIDGET_LINES - lines.length - 1);
  lines.push(...visible.map((task) => taskRow(board, task)));
  const hidden = unfinished.length - visible.length;
  const folded = board.tasks.length - unfinished.length;
  lines.push(`/task-supervisor tasks · ${hidden} more unfinished · ${folded} terminal folded`);
  // Capture strings here: Pi can render later, outside this session's AsyncLocalStorage scope.
  ctx.ui.setWidget(
    TASK_WIDGET_KEY,
    () => ({
      render: (width) => lines.map((line) => truncateToWidth(line, width)),
      invalidate() {},
    }),
    { placement: "aboveEditor" },
  );
}

/** Scrollable full list and details; never activates, mutates, or schedules work. */
export async function showTaskList(
  ctx: ExtensionContext,
  snapshot: Readonly<TaskBoardSnapshot>,
): Promise<void> {
  if (!ctx.hasUI) return;
  const board = structuredClone(snapshot);
  const header = boardHeader(board);
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
