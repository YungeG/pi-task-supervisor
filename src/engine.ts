import type { TaskBoardSnapshot, TaskRecord, TaskEdit } from "./types";
import { MAX_TASKS, ACTIVE_STATUSES, TERMINAL_STATUSES } from "./types";
import {
  isNonEmptyString,
  isValidPhase,
  hasSelfDependency,
  hasDuplicateDependencies,
  findMissingDependencies,
  detectCycle,
  cloneBoard,
  completionEvidenceError,
} from "./validation";

// ── Internal Helpers ──

function guardNoActiveTasks(board: TaskBoardSnapshot, message: string): void {
  if (board.tasks.some((t) => ACTIVE_STATUSES.has(t.status))) {
    throw new Error(message);
  }
}

// ── Board Creation ──

export function createEmptyBoard(): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 0,
    workflowStatus: "inactive",
    tasks: [],
    phases: [],
    pendingPhasePrompt: undefined,
    stagnantSettles: 0,
  };
}

// ── Write Tasks ──

function validateTaskInput(
  input: { title: string; prompt: string; profile: string },
  index: number,
  phaseNum: number,
): void {
  const trimmedTitle = input.title.trim();
  const trimmedPrompt = input.prompt.trim();
  const trimmedProfile = input.profile.trim();

  if (!isNonEmptyString(trimmedTitle)) {
    throw new Error(`Phase ${phaseNum} task ${index + 1}: title must be a non-empty string`);
  }
  if (!isNonEmptyString(trimmedPrompt)) {
    throw new Error(`Phase ${phaseNum} task ${index + 1}: prompt must be a non-empty string`);
  }
  if (!isNonEmptyString(trimmedProfile)) {
    throw new Error(`Phase ${phaseNum} task ${index + 1}: profile must be a non-empty string`);
  }
}

export function writeTasks(
  board: TaskBoardSnapshot,
  input: {
    mode: "replace" | "append";
    phases: Array<{
      title: string;
      tasks: Array<{ title: string; prompt: string; profile: string }>;
    }>;
  },
  now: string,
): TaskBoardSnapshot {
  let result: TaskBoardSnapshot;
  let startPhase: number;

  if (input.mode === "replace") {
    guardNoActiveTasks(board, "Cannot replace board while tasks are implementing or reviewing.");
    result = createEmptyBoard();
    startPhase = 1;
  } else {
    result = cloneBoard(board);
    startPhase = result.tasks.length > 0 ? Math.max(...result.tasks.map((t) => t.phase)) + 1 : 1;
  }

  const totalNewTasks = input.phases.reduce((sum, p) => sum + p.tasks.length, 0);
  if (result.tasks.length + totalNewTasks > MAX_TASKS) {
    throw new Error(
      `Cannot add ${totalNewTasks} tasks: would exceed maximum of ${MAX_TASKS} (currently ${result.tasks.length})`,
    );
  }

  for (const [i, inputPhase] of input.phases.entries()) {
    const phaseNum = startPhase + i;

    if (!isNonEmptyString(inputPhase.title.trim())) {
      throw new Error(`Phase ${i + 1}: title must be a non-empty string`);
    }

    for (const [j, taskInput] of inputPhase.tasks.entries()) {
      validateTaskInput(taskInput, j, phaseNum);

      const phaseCount = result.tasks.filter((t) => t.phase === phaseNum).length;
      const id = `t-${phaseNum}.${phaseCount + 1}`;
      result.tasks.push({
        id,
        title: taskInput.title.trim(),
        prompt: taskInput.prompt.trim(),
        profile: taskInput.profile.trim(),
        phase: phaseNum,
        dependencies: [],
        status: "draft",
        createdAt: now,
        updatedAt: now,
      });
    }

    result.phases.push({
      phase: phaseNum,
      status: "pending" as const,
      title: inputPhase.title.trim(),
    });
  }

  result.generation = board.generation + 1;
  result.workflowStatus = "inactive";
  result.finalAcceptanceTaskId = undefined;
  result.decision = undefined;
  result.pauseReason = undefined;
  result.stagnantSettles = 0;
  return result;
}

// ── Recompute Phases and Readiness (internal) ──

function recomputePhasesAndReadiness(
  board: TaskBoardSnapshot,
  oldBoard: TaskBoardSnapshot,
  now: string,
): TaskBoardSnapshot {
  const allPhaseNumbers = new Set(board.tasks.map((t) => t.phase));
  const nonTerminalTasks = board.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));

  if (nonTerminalTasks.length === 0) {
    const phases = [...allPhaseNumbers]
      .sort((a, b) => a - b)
      .map((phase) => {
        const oldPhase = oldBoard.phases.find((p) => p.phase === phase);
        return {
          phase,
          status: "completed" as const,
          completedAt: oldPhase?.completedAt ?? now,
          title: oldPhase?.title,
        };
      });
    board.phases = phases;
    return board;
  }

  const nonTerminalPhases = new Set(nonTerminalTasks.map((t) => t.phase));
  const sortedNonTerminalPhases = [...nonTerminalPhases].sort((a, b) => a - b);
  const activePhase = sortedNonTerminalPhases[0];
  if (activePhase === undefined) return board;

  const oldPhaseMap = new Map(oldBoard.phases.map((p) => [p.phase, p]));
  board.phases = buildPhasesArray(allPhaseNumbers, activePhase, oldPhaseMap, now);

  markReadyTasksInActivePhase(board, activePhase);

  const allActivePhaseTerminal = board.tasks
    .filter((t) => t.phase === activePhase)
    .every((t) => TERMINAL_STATUSES.has(t.status));

  if (allActivePhaseTerminal && sortedNonTerminalPhases.length > 1) {
    const phaseRecord = board.phases.find((p) => p.phase === activePhase);
    if (phaseRecord) {
      phaseRecord.status = "completed";
      phaseRecord.completedAt = now;
    }
    return recomputePhasesAndReadiness(board, oldBoard, now);
  }

  return board;
}

function buildPhasesArray(
  allPhaseNumbers: Set<number>,
  activePhase: number,
  oldPhaseMap: Map<number, { completedAt?: string; title?: string }>,
  now: string,
): TaskBoardSnapshot["phases"] {
  return [...allPhaseNumbers]
    .sort((a, b) => a - b)
    .map((phase) => {
      const oldPhase = oldPhaseMap.get(phase);
      if (phase < activePhase) {
        return {
          phase,
          status: "completed" as const,
          completedAt: oldPhase?.completedAt ?? now,
          title: oldPhase?.title,
        };
      }
      if (phase === activePhase) {
        return { phase, status: "active" as const, title: oldPhase?.title };
      }
      return { phase, status: "pending" as const, title: oldPhase?.title };
    });
}

function markReadyTasksInActivePhase(board: TaskBoardSnapshot, activePhase: number): void {
  const taskMap = new Map(board.tasks.map((t) => [t.id, t]));
  for (const task of board.tasks) {
    if (task.phase === activePhase && task.status === "configured") {
      const allDepsDone = task.dependencies.every((depId) => {
        const dep = taskMap.get(depId);
        return dep !== undefined && dep.status === "done";
      });
      if (allDepsDone) {
        task.status = "ready";
      }
    }
  }
}

// ── Apply Edits ──

function validateDataEdit(edit: TaskEdit & { type: "data" }, hasActiveTasksOnBoard: boolean): void {
  if (hasActiveTasksOnBoard) {
    throw new Error(
      "Cannot edit data while tasks are implementing/reviewing. Complete or advance active tasks first.",
    );
  }
  if (edit.data.title !== undefined && !isNonEmptyString(edit.data.title)) {
    throw new Error(`Task "${edit.id}": title must be a non-empty string`);
  }
  if (edit.data.prompt !== undefined && !isNonEmptyString(edit.data.prompt)) {
    throw new Error(`Task "${edit.id}": prompt must be a non-empty string`);
  }
  if (edit.data.profile !== undefined && !isNonEmptyString(edit.data.profile)) {
    throw new Error(`Task "${edit.id}": profile must be a non-empty string`);
  }
  if (edit.data.phase !== undefined && !isValidPhase(edit.data.phase)) {
    throw new Error(
      `Task "${edit.id}": phase must be an integer >= 1, got ${String(edit.data.phase)}`,
    );
  }
}

function validateAdvanceEdit(edit: TaskEdit & { type: "advance" }, task: TaskRecord): void {
  if (task.status !== "implementing" && task.status !== "reviewing") {
    throw new Error(
      `Cannot advance task "${edit.id}" from "${task.status}". Can only advance from "implementing" or "reviewing".`,
    );
  }
  if (task.status === "implementing" && edit.data?.evidence !== undefined) {
    throw new Error(`Task "${edit.id}" cannot attach completion evidence before review`);
  }
  if (task.status === "reviewing") {
    const error = completionEvidenceError(edit.data?.evidence);
    if (error) throw new Error(`Task "${edit.id}": ${error}`);
  }
}

function validateEdit(
  edit: TaskEdit,
  taskMap: Map<string, TaskRecord>,
  existingIds: Set<string>,
  hasActiveTasksOnBoard: boolean,
): void {
  const task = taskMap.get(edit.id);
  if (!task) {
    throw new Error(`Task "${edit.id}" not found`);
  }

  switch (edit.type) {
    case "data": {
      validateDataEdit(edit, hasActiveTasksOnBoard);
      break;
    }
    case "blockers": {
      if (hasActiveTasksOnBoard) {
        throw new Error(
          "Cannot edit blockers while tasks are implementing/reviewing. Complete or advance active tasks first.",
        );
      }
      if (hasSelfDependency(edit.id, edit.data.dependencies)) {
        throw new Error(`Task "${edit.id}" cannot depend on itself`);
      }
      if (hasDuplicateDependencies(edit.data.dependencies)) {
        throw new Error(`Task "${edit.id}" has duplicate dependencies`);
      }
      const missing = findMissingDependencies(edit.data.dependencies, existingIds);
      if (missing.length > 0) {
        throw new Error(
          `Task "${edit.id}" references non-existent dependencies: ${missing.join(", ")}`,
        );
      }
      break;
    }
    case "advance": {
      validateAdvanceEdit(edit, task);
      break;
    }
    case "abandon": {
      if (task.status === "done" || task.status === "abandoned") {
        throw new Error(
          `Cannot abandon task "${edit.id}" in "${task.status}" status. Already resolved.`,
        );
      }
      break;
    }
    default: {
      const unsupported: never = edit;
      throw new Error(`Unsupported task edit: ${String(unsupported)}`);
    }
  }
}

function applyStructuralEdits(
  edits: TaskEdit[],
  taskMap: Map<string, TaskRecord>,
  now: string,
): void {
  for (const edit of edits) {
    const task = taskMap.get(edit.id);
    if (!task) continue;

    if (edit.type === "data") {
      if (edit.data.title !== undefined) task.title = edit.data.title;
      if (edit.data.prompt !== undefined) task.prompt = edit.data.prompt;
      if (edit.data.profile !== undefined) task.profile = edit.data.profile;
      if (edit.data.phase !== undefined) task.phase = edit.data.phase;
      task.updatedAt = now;
    }
    // edit.type === "blockers" is the only other structural type
    // TypeScript doesn't narrow after the if above, so we check explicitly
    if (edit.type === "blockers") {
      task.dependencies = [...edit.data.dependencies];
      task.updatedAt = now;
    }
  }
}

function resetNonTerminalToDraft(tasks: TaskRecord[], now: string): void {
  for (const task of tasks) {
    if (!TERMINAL_STATUSES.has(task.status) && !ACTIVE_STATUSES.has(task.status)) {
      task.status = "draft";
      task.updatedAt = now;
    }
  }
}

function invalidateCompilation(board: TaskBoardSnapshot): void {
  if (board.decision || ["paused", "waiting_for_decision"].includes(board.workflowStatus))
    throw new Error("Resume or resolve the task-board gate before structural edits");
  const titles = new Map(board.phases.map((phase) => [phase.phase, phase.title]));
  board.workflowStatus = "inactive";
  board.finalAcceptanceTaskId = undefined;
  board.pendingPhasePrompt = undefined;
  board.pauseReason = undefined;
  board.phases = [...new Set(board.tasks.map((task) => task.phase))]
    .sort((a, b) => a - b)
    .map((phase) => ({ phase, status: "pending", title: titles.get(phase) }));
}

function boardCompleted(board: TaskBoardSnapshot): boolean {
  const finalTask = board.tasks.find((task) => task.id === board.finalAcceptanceTaskId);
  return (
    finalTask?.status === "done" && board.tasks.every((task) => TERMINAL_STATUSES.has(task.status))
  );
}

function applyStateEdits(
  edits: TaskEdit[],
  taskMap: Map<string, TaskRecord>,
  board: TaskBoardSnapshot,
  oldBoard: TaskBoardSnapshot,
  now: string,
): void {
  let needsRecompute = false;
  for (const edit of edits) {
    const task = taskMap.get(edit.id);
    if (!task) continue;

    if (edit.type === "advance") {
      if (task.status === "implementing") {
        task.status = "reviewing";
        task.updatedAt = now;
      } else {
        // Must be "reviewing" with valid evidence (validated above)
        const evidence = edit.data?.evidence;
        if (!evidence) throw new Error(`Task "${edit.id}": Completion evidence is required`);
        task.status = "done";
        task.completionEvidence = structuredClone(evidence);
        task.updatedAt = now;
        needsRecompute = true;
      }
    }
    // edit.type === "abandon" is the only other state type
    if (edit.type === "abandon") {
      task.status = "abandoned";
      task.updatedAt = now;
      needsRecompute = true;
    }
  }
  if (needsRecompute) {
    recomputePhasesAndReadiness(board, oldBoard, now);
    board.workflowStatus = boardCompleted(board) ? "completed" : board.workflowStatus;
  }
}

export function applyEdits(
  board: TaskBoardSnapshot,
  edits: TaskEdit[],
  now: string,
): TaskBoardSnapshot {
  if (edits.length === 0) return cloneBoard(board);

  const result = cloneBoard(board);
  const taskMap = new Map(result.tasks.map((t) => [t.id, t]));
  const existingIds = new Set(result.tasks.map((t) => t.id));
  const boardHasActiveTasks = result.tasks.some((t) => ACTIVE_STATUSES.has(t.status));

  // First pass: validate all edits
  for (const edit of edits) {
    validateEdit(edit, taskMap, existingIds, boardHasActiveTasks);
  }

  // Second pass: apply all edits
  const structuralEdits = edits.filter((e) => e.type === "data" || e.type === "blockers");
  const stateEdits = edits.filter((e) => e.type === "advance" || e.type === "abandon");

  // Apply structural edits, then reset non-terminal tasks
  if (structuralEdits.length > 0) {
    applyStructuralEdits(structuralEdits, taskMap, now);
    resetNonTerminalToDraft(result.tasks, now);
    invalidateCompilation(result);
  }

  // Apply state edits (advance / abandon) with recompute
  if (stateEdits.length > 0) {
    applyStateEdits(stateEdits, taskMap, result, board, now);
  }

  result.generation = board.generation + 1;
  result.stagnantSettles = 0;
  return result;
}

// ── Compile Board ──

function assertFinalAcceptanceCoverage(
  board: TaskBoardSnapshot,
  finalAcceptanceTaskId: string,
  finalAcceptanceTask: TaskRecord,
): void {
  const taskMap = new Map(board.tasks.map((task) => [task.id, task]));
  const covered = new Set<string>();
  const stack = [...finalAcceptanceTask.dependencies];
  while (stack.length > 0) {
    const dependencyId = stack.pop();
    if (dependencyId === undefined) break;
    if (covered.has(dependencyId)) continue;
    covered.add(dependencyId);
    const dependency = taskMap.get(dependencyId);
    if (dependency) stack.push(...dependency.dependencies);
  }
  const uncovered = board.tasks.filter(
    (task) => task.id !== finalAcceptanceTaskId && !covered.has(task.id),
  );
  if (uncovered.length > 0) {
    throw new Error(
      `Final acceptance task must depend on every earlier task: ${uncovered
        .map((task) => task.id)
        .join(", ")}`,
    );
  }
}

function assertSchedulablePhases(tasks: readonly TaskRecord[]): void {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    if (TERMINAL_STATUSES.has(task.status)) continue;
    for (const id of task.dependencies) {
      const dependency = taskMap.get(id);
      if (dependency && dependency.phase > task.phase && dependency.status !== "done")
        throw new Error(`Task "${task.id}" depends on unfinished task "${id}" in a future phase`);
    }
  }
}

export function compileBoard(
  board: TaskBoardSnapshot,
  now: string,
  finalAcceptanceTaskId?: string,
): TaskBoardSnapshot {
  if (board.tasks.length === 0) {
    throw new Error("Cannot compile an empty board");
  }

  guardNoActiveTasks(
    board,
    "Cannot compile board while tasks are implementing or reviewing. Complete or advance active tasks first.",
  );

  const idSet = new Set(board.tasks.map((t) => t.id));
  if (idSet.size !== board.tasks.length) {
    throw new Error("Duplicate task ids found on the board");
  }

  for (const task of board.tasks) {
    const missing = findMissingDependencies(task.dependencies, idSet);
    if (missing.length > 0) {
      throw new Error(
        `Task "${task.id}" references non-existent dependencies: ${missing.join(", ")}`,
      );
    }
  }

  const cycle = detectCycle(board.tasks);
  if (cycle.length > 0) {
    throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
  }
  assertSchedulablePhases(board.tasks);

  if (finalAcceptanceTaskId) {
    const finalAcceptanceTask = board.tasks.find((task) => task.id === finalAcceptanceTaskId);
    if (!finalAcceptanceTask) {
      throw new Error(`Final acceptance task not found: ${finalAcceptanceTaskId}`);
    }
    const finalPhase = Math.max(...board.tasks.map((task) => task.phase));
    if (finalAcceptanceTask.phase !== finalPhase) {
      throw new Error("Final acceptance task must be in the final phase");
    }
    if (finalAcceptanceTask.status === "abandoned") {
      throw new Error("Final acceptance task cannot be abandoned");
    }
    assertFinalAcceptanceCoverage(board, finalAcceptanceTaskId, finalAcceptanceTask);
  }

  const result = cloneBoard(board);

  for (const task of result.tasks) {
    if (task.status === "draft") {
      task.status = "configured";
      task.updatedAt = now;
    }
  }

  recomputePhasesAndReadiness(result, board, now);
  result.finalAcceptanceTaskId = finalAcceptanceTaskId;
  result.workflowStatus = finalAcceptanceTaskId
    ? boardCompleted(result)
      ? "completed"
      : "active"
    : "inactive";
  result.generation = board.generation + 1;
  result.stagnantSettles = 0;

  return result;
}

// ── Claim Ready Tasks ──

export function claimReadyTasks(
  board: TaskBoardSnapshot,
  count: number,
  now: string,
): { board: TaskBoardSnapshot; claimed: TaskRecord[] } {
  if (count < 1) {
    throw new Error("count must be >= 1");
  }

  guardNoActiveTasks(
    board,
    "Cannot claim tasks while tasks are implementing or reviewing. Complete or advance active tasks first.",
  );

  const result = cloneBoard(board);

  const readyTasks = result.tasks
    .map((t, index) => ({ task: t, index }))
    .filter(({ task }) => task.status === "ready")
    .sort((a, b) => {
      if (a.task.phase !== b.task.phase) return a.task.phase - b.task.phase;
      return a.index - b.index;
    });

  const toClaim = readyTasks.slice(0, count);
  const claimed: TaskRecord[] = [];

  for (const { task } of toClaim) {
    task.status = "implementing";
    task.updatedAt = now;
    claimed.push({ ...task });
  }
  if (claimed.length > 0) {
    result.generation = board.generation + 1;
    result.stagnantSettles = 0;
  }

  return { board: result, claimed };
}

// ── Query Functions ──

export { hasActionableTasks, hasBlockedNonTerminalTasks, getStatusCounts } from "./validation";
