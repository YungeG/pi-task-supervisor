import type { TaskBoardSnapshot, TaskRecord, TaskStatus } from "./types";
import { STATUS_ICONS } from "./types";
import { getStatusCounts } from "./validation";

// ── Plain-Text Formatting (for LLM tool output) ──

/** Returns a phase label string including the title if available. */
export function phaseLabel(board: TaskBoardSnapshot, phaseNum: number): string {
  const rec = board.phases.find((p) => p.phase === phaseNum);
  return rec?.title ? `Phase ${phaseNum}: ${rec.title}` : `Phase ${phaseNum}`;
}

/** Returns the plain-text icon for a task status. */
function getStatusIcon(status: TaskStatus): string {
  return STATUS_ICONS[status];
}

/** Format a single task as a plain-text line. */
function formatTaskLine(task: TaskRecord): string {
  return `${getStatusIcon(task.status)} ${task.id}: ${task.title}`;
}

/** Format the full board as a plain-text summary for LLM consumption. */
export function formatBoardText(
  board: TaskBoardSnapshot,
  options?: { activePhaseOnly?: boolean; counts?: Record<TaskStatus, number> },
): string {
  if (board.tasks.length === 0) return "No tasks on the board.";

  const lines: string[] = ["Task Board:", ""];

  const activePhaseOnly = options?.activePhaseOnly === true;
  const activePhaseRecord = board.phases.find((p) => p.status === "active");
  const useActiveOnly = activePhaseOnly && activePhaseRecord !== undefined;

  // Determine which phases to render
  const phases = useActiveOnly
    ? [activePhaseRecord.phase]
    : [...new Set(board.tasks.map((t) => t.phase))].sort((a, b) => a - b);

  for (const phase of phases) {
    lines.push(`─── ${phaseLabel(board, phase)} ───`);
    const phaseTasks = board.tasks.filter((t) => t.phase === phase);
    for (const task of phaseTasks) {
      let line = formatTaskLine(task);
      if (task.dependencies.length > 0) {
        line += ` → depends on ${task.dependencies.join(", ")}`;
      }
      lines.push(line);
    }
    lines.push("");
  }

  // Summary line (always across ALL phases)
  const counts = options?.counts ?? getStatusCounts(board);
  const parts: string[] = [];
  for (const [status, count] of Object.entries(counts)) {
    if (count > 0) parts.push(`${count} ${status}`);
  }
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}

/** Format a short summary for tool output headers. */
export function formatSummaryLine(
  board: TaskBoardSnapshot,
  counts?: Record<TaskStatus, number>,
): string {
  const total = board.tasks.length;
  const done = counts
    ? counts.done + counts.abandoned
    : board.tasks.filter((t) => t.status === "done" || t.status === "abandoned").length;
  const activePhase = board.phases.find((p) => p.status === "active");
  return activePhase
    ? `${phaseLabel(board, activePhase.phase)} · ${done}/${total} done`
    : `${done}/${total} done`;
}

/** Format claimed task details with prompt preview. */
export function formatClaimedTaskDetails(tasks: TaskRecord[]): string {
  return tasks
    .map((t) => {
      const lines = [`${getStatusIcon(t.status)} ${t.id}: ${t.title}  (${t.profile})`];
      const promptLines = t.prompt.split("\n");
      const shown = promptLines.slice(0, 3);
      lines.push(...shown);
      if (promptLines.length > 3) {
        lines.push("  ... (truncated)");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** Format the hidden context message for before_agent_start injection. */
export function formatHiddenContext(board: TaskBoardSnapshot): string {
  const lines: string[] = ["[CONTINUOUS TASKS ACTIVE]", ""];

  const activePhase = board.phases.find((p) => p.status === "active");
  lines.push(`Active Phase: ${activePhase ? phaseLabel(board, activePhase.phase) : "none"}`);

  // Counts by status
  const counts = getStatusCounts(board);
  lines.push(
    `Status: ${Object.entries(counts)
      .filter(([, c]) => c > 0)
      .map(([s, c]) => `${c} ${s}`)
      .join(", ")}`,
  );

  // Currently claimed tasks
  const claimed = board.tasks.filter(
    (t) => t.status === "implementing" || t.status === "reviewing",
  );
  if (claimed.length > 0) {
    lines.push("");
    lines.push("Currently claimed:");
    for (const t of claimed) {
      lines.push(`  ${getStatusIcon(t.status)} [${t.id}] ${t.title}`);
      if (t.executionRef) {
        lines.push(
          `    Existing ${t.executionRef.source} run ${t.executionRef.runId}; inspect it before launching any writer.`,
        );
      }
    }
  }

  // Non-terminal tasks
  lines.push("");
  lines.push("Remaining tasks:");
  const nonTerminal = board.tasks.filter((t) => t.status !== "done" && t.status !== "abandoned");
  for (const t of nonTerminal) {
    lines.push(`  ${formatTaskLine(t)}`);
  }

  // Recently completed (up to 10)
  const terminal = board.tasks.filter((t) => t.status === "done" || t.status === "abandoned");
  if (terminal.length > 0) {
    lines.push("");
    lines.push("Recently completed:");
    const sorted = [...terminal].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const recent = sorted.slice(0, 10);
    if (terminal.length > 10) {
      lines.push(`  ... and ${terminal.length - 10} more terminal tasks`);
    }
    for (const t of recent) {
      lines.push(`  ${formatTaskLine(t)}`);
    }
  }

  lines.push("");
  lines.push(
    "Workflow: write_tasks → edit_tasks → compile_tasks → get_ready_tasks → advance_tasks → workflow_gate → done",
  );

  return lines.join("\n");
}

/** Format the auto-continue prompt. */
export function formatContinuePrompt(board: TaskBoardSnapshot): string {
  const ready = board.tasks.filter((t) => t.status === "ready");
  const active = board.tasks.filter((t) => t.status === "implementing" || t.status === "reviewing");

  if (ready.length > 0 || active.length > 0) {
    const lines: string[] = ["Tasks remain. Continue working on the phased task board."];
    if (active.length > 0) {
      lines.push("");
      lines.push("Currently claimed:");
      for (const t of active) {
        lines.push(`  [${t.id}] ${t.title} (${t.status})`);
        if (t.executionRef) {
          lines.push(
            `    Existing ${t.executionRef.source} run ${t.executionRef.runId}; inspect it and do not launch a duplicate writer.`,
          );
        }
      }
    }
    if (ready.length > 0) {
      lines.push("");
      lines.push(`Ready to claim: ${ready.length} task(s). Call get_ready_tasks to claim them.`);
    }
    return lines.join("\n");
  }

  // Deadlock
  const nonTerminal = board.tasks.filter((t) => t.status !== "done" && t.status !== "abandoned");
  if (nonTerminal.length > 0) {
    return [
      "The task board is blocked — no tasks are ready, implementing, or reviewing, but tasks remain.",
      "Inspect dependencies and phase gating. Use edit_tasks to resolve blockers, then compile_tasks.",
      "",
      "Blocked tasks:",
      ...nonTerminal.map(
        (t) => `  [${t.id}] ${t.title} (${t.status}, ${phaseLabel(board, t.phase)})`,
      ),
    ].join("\n");
  }

  return "";
}

/** Format the "all done" terminal message. */
export function formatAllDoneMessage(board: TaskBoardSnapshot): string {
  if (board.phases.length === 0) return "All tasks resolved.";
  const lastPhaseRecord = board.phases[board.phases.length - 1];
  if (!lastPhaseRecord) return "All tasks resolved.";
  return `All tasks resolved. ${phaseLabel(board, lastPhaseRecord.phase)} complete.`;
}
