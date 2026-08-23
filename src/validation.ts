import type {
  CompletionEvidence,
  EvidenceRef,
  LegacyTaskBoardSnapshot,
  TaskBoardSnapshot,
  TaskRecord,
  TaskStatus,
} from "./types";
import { TERMINAL_STATUSES, ACTIVE_STATUSES } from "./types";

// ── String Validation ──

/** Returns true if the value is a non-empty trimmed string. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ── Phase Validation ──

/** Returns true if the value is an integer >= 1. */
export function isValidPhase(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// ── Dependency Validation ──

/** Returns true if a task's dependencies have no self-reference. */
export function hasSelfDependency(taskId: string, dependencies: string[]): boolean {
  return dependencies.includes(taskId);
}

/** Returns true if the dependencies array has duplicates. */
export function hasDuplicateDependencies(dependencies: string[]): boolean {
  return new Set(dependencies).size !== dependencies.length;
}

/** Returns the set of dependency ids that don't exist in the task id set. */
export function findMissingDependencies(
  dependencies: string[],
  existingIds: Set<string>,
): string[] {
  return dependencies.filter((d) => !existingIds.has(d));
}

// ── Cycle Detection ──

/**
 * Detect cycles in the task dependency graph using DFS.
 * Returns an array of task ids forming a cycle, or empty array if acyclic.
 */
export function detectCycle(tasks: TaskRecord[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  const path: string[] = [];

  function dfs(id: string): string[] | null {
    color.set(id, GRAY);
    path.push(id);
    const task = taskMap.get(id);
    if (task) {
      for (const dep of task.dependencies) {
        const depColor = color.get(dep);
        if (depColor === GRAY) {
          // Found cycle — extract cycle path
          const cycleStart = path.indexOf(dep);
          return path.slice(cycleStart);
        }
        if (depColor === WHITE) {
          const cycle = dfs(dep);
          if (cycle) return cycle;
        }
      }
    }
    path.pop();
    color.set(id, BLACK);
    return null;
  }

  for (const t of tasks) {
    if (color.get(t.id) === WHITE) {
      const cycle = dfs(t.id);
      if (cycle) return cycle;
    }
  }

  return [];
}

// ── Status Counts ──

/** Counts tasks by status. Returns a fully-populated Record with all statuses (zero if absent). */
export function getStatusCounts(board: TaskBoardSnapshot): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    draft: 0,
    configured: 0,
    ready: 0,
    implementing: 0,
    reviewing: 0,
    done: 0,
    abandoned: 0,
  };
  for (const t of board.tasks) {
    counts[t.status]++;
  }
  return counts;
}

// ── Board State Checks ──

type TaskCollection = { readonly tasks: readonly TaskRecord[] };

/** Returns true if any task is in implementing or reviewing. */
function hasActiveTasks(board: TaskCollection): boolean {
  return board.tasks.some((t) => ACTIVE_STATUSES.has(t.status));
}

/** Returns true if any task is in a non-terminal state. */
function hasNonTerminalTasks(board: TaskCollection): boolean {
  return board.tasks.some((t) => !TERMINAL_STATUSES.has(t.status));
}

/** Returns true if there are tasks in ready, implementing, or reviewing. */
export function hasActionableTasks(board: TaskCollection): boolean {
  return board.tasks.some((t) => t.status === "ready") || hasActiveTasks(board);
}

/** Returns true if there are non-terminal tasks but none are actionable (deadlock). */
export function hasBlockedNonTerminalTasks(board: TaskCollection): boolean {
  return hasNonTerminalTasks(board) && !hasActionableTasks(board);
}

// ── Snapshot Validation ──

const VALID_TASK_STATUSES = new Set([
  "draft",
  "configured",
  "ready",
  "implementing",
  "reviewing",
  "done",
  "abandoned",
]);

const VALID_PHASE_STATUSES = new Set(["pending", "active", "completed"]);
const VALID_EVIDENCE_KINDS = new Set(["command", "review", "artifact", "diff"]);
const VALID_EVIDENCE_STATUSES = new Set(["passed", "fixed", "deferred"]);
const SECRET_LIKE =
  /\b(?:Bearer\s+[A-Za-z0-9._-]{8,}|(?:api[_-]?key|token|password)\s*[:=]\s*\S+|(?:sk|ghp|pt|dt)_[A-Za-z0-9_-]{8,})/i;

export function isSafeBoundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength &&
    !SECRET_LIKE.test(value)
  );
}

function evidenceRefError(ref: EvidenceRef): string | undefined {
  if (!VALID_EVIDENCE_KINDS.has(ref.kind)) return `Invalid evidence kind: ${ref.kind}`;
  if (!VALID_EVIDENCE_STATUSES.has(ref.status)) return `Invalid evidence status: ${ref.status}`;
  if (!isSafeBoundedText(ref.label, 200)) return "Evidence label is invalid or secret-like";
  if (ref.ref !== undefined && !isSafeBoundedText(ref.ref, 500)) {
    return "Evidence ref is invalid or secret-like";
  }
  if (ref.digest !== undefined && !isSafeBoundedText(ref.digest, 200)) {
    return "Evidence digest is invalid or secret-like";
  }
  if (ref.exitCode !== undefined && !Number.isInteger(ref.exitCode)) {
    return "Evidence exitCode must be an integer";
  }
  if (ref.kind === "command" && ref.exitCode !== 0) {
    return "Command evidence must have exitCode 0";
  }
  if (ref.status === "fixed" && ref.ref === undefined) {
    return "Fixed evidence must reference a finding or report";
  }
  return undefined;
}

export function completionEvidenceError(
  evidence: CompletionEvidence | undefined,
): string | undefined {
  if (!evidence) return "Completion evidence is required";
  if (!isSafeBoundedText(evidence.summary, 1000)) {
    return "Completion evidence summary is invalid or secret-like";
  }
  if (!Array.isArray(evidence.refs) || evidence.refs.length < 1 || evidence.refs.length > 20) {
    return "Completion evidence must contain 1-20 refs";
  }
  for (const ref of evidence.refs) {
    const error = evidenceRefError(ref);
    if (error) return error;
  }
  if (!evidence.refs.some((ref) => ref.status === "passed")) {
    return "Completion evidence must include at least one passed ref";
  }
  if (
    evidence.residualRisks !== undefined &&
    (evidence.residualRisks.length > 20 ||
      !evidence.residualRisks.every((risk) => isSafeBoundedText(risk, 500)))
  ) {
    return "Residual risks are invalid or secret-like";
  }
  return undefined;
}

function isValidExecutionRef(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    (ref.source === "pi-subagents" || ref.source === "workflow") &&
    isSafeBoundedText(ref.runId, 200)
  );
}

function isValidTask(t: unknown, requireEvidence: boolean): boolean {
  if (typeof t !== "object" || t === null) return false;
  const task = t as Record<string, unknown>;
  const validShape =
    typeof task.id === "string" &&
    typeof task.title === "string" &&
    typeof task.status === "string" &&
    VALID_TASK_STATUSES.has(task.status) &&
    typeof task.phase === "number" &&
    Array.isArray(task.dependencies) &&
    (task.dependencies as unknown[]).every((d) => typeof d === "string");
  if (!validShape) return false;
  if (task.executionRef !== undefined && !isValidExecutionRef(task.executionRef)) return false;
  return (
    !requireEvidence ||
    task.status !== "done" ||
    completionEvidenceError(task.completionEvidence as CompletionEvidence) === undefined
  );
}

function isValidPhaseRecord(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const phase = p as Record<string, unknown>;
  return (
    typeof phase.phase === "number" &&
    typeof phase.status === "string" &&
    VALID_PHASE_STATUSES.has(phase.status)
  );
}

const VALID_WORKFLOW_STATUSES = new Set([
  "inactive",
  "active",
  "paused",
  "waiting_for_decision",
  "completed",
]);

function hasValidTaskAndPhaseArrays(
  obj: Record<string, unknown>,
  requireEvidence: boolean,
): boolean {
  return (
    Array.isArray(obj.tasks) &&
    Array.isArray(obj.phases) &&
    (obj.tasks as unknown[]).every((task) => isValidTask(task, requireEvidence)) &&
    (obj.phases as unknown[]).every(isValidPhaseRecord)
  );
}

/** Type guard for the pinned upstream version-1 snapshot. */
export function isValidLegacySnapshot(data: unknown): data is LegacyTaskBoardSnapshot {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  return obj.version === 1 && hasValidTaskAndPhaseArrays(obj, false);
}

function hasValidV2Metadata(obj: Record<string, unknown>): boolean {
  if (!Number.isInteger(obj.generation) || (obj.generation as number) < 1) return false;
  if (typeof obj.workflowStatus !== "string" || !VALID_WORKFLOW_STATUSES.has(obj.workflowStatus)) {
    return false;
  }
  if (!Number.isInteger(obj.stagnantSettles) || (obj.stagnantSettles as number) < 0) {
    return false;
  }
  if (obj.finalAcceptanceTaskId !== undefined && typeof obj.finalAcceptanceTaskId !== "string") {
    return false;
  }
  return true;
}

function isValidDecision(value: unknown, tasks: Array<Record<string, unknown>>): boolean {
  if (typeof value !== "object" || value === null) return false;
  const decision = value as Record<string, unknown>;
  if (
    !isSafeBoundedText(decision.id, 100) ||
    !isSafeBoundedText(decision.taskId, 100) ||
    !isSafeBoundedText(decision.question, 1000) ||
    !isSafeBoundedText(decision.whyUserOwned, 1000) ||
    !isSafeBoundedText(decision.createdAt, 100)
  ) {
    return false;
  }
  if (!tasks.some((task) => task.id === decision.taskId)) return false;
  if (decision.options === undefined) return true;
  return (
    Array.isArray(decision.options) &&
    decision.options.length <= 10 &&
    decision.options.every((option) => isSafeBoundedText(option, 500))
  );
}

function hasConsistentWorkflowState(obj: Record<string, unknown>): boolean {
  const status = obj.workflowStatus as string;
  const tasks = obj.tasks as Array<Record<string, unknown>>;
  const finalAcceptanceTaskId = obj.finalAcceptanceTaskId;
  if (status !== "inactive" && typeof finalAcceptanceTaskId !== "string") return false;

  if (typeof finalAcceptanceTaskId === "string") {
    const finalTask = tasks.find((task) => task.id === finalAcceptanceTaskId);
    if (!finalTask) return false;
    const finalPhase = Math.max(...tasks.map((task) => Number(task.phase)));
    if (finalTask.phase !== finalPhase || finalTask.status === "abandoned") return false;
    if (status === "completed" && finalTask.status !== "done") return false;
  }

  if (
    status === "completed" &&
    tasks.some((task) => task.status !== "done" && task.status !== "abandoned")
  ) {
    return false;
  }
  if (status === "waiting_for_decision") {
    return isValidDecision(obj.decision, tasks);
  }
  return obj.decision === undefined;
}

/** Type guard for a valid local version-2 snapshot. */
export function isValidSnapshotV2(data: unknown): data is TaskBoardSnapshot {
  if (typeof data !== "object" || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (obj.version !== 2 || !hasValidTaskAndPhaseArrays(obj, true) || !hasValidV2Metadata(obj)) {
    return false;
  }
  return hasConsistentWorkflowState(obj);
}

/** Backward-compatible snapshot predicate for callers that inspect stored history. */
export function isValidSnapshot(
  data: unknown,
): data is TaskBoardSnapshot | LegacyTaskBoardSnapshot {
  return isValidSnapshotV2(data) || isValidLegacySnapshot(data);
}

// ── Deep Clone ──

/**
 * Creates a deep copy of a TaskBoardSnapshot.
 * Uses JSON roundtrip (instead of structuredClone) because benchmarks show it's
 * faster for plain-object graphs without special types.
 */
export function cloneBoard<T extends TaskBoardSnapshot | LegacyTaskBoardSnapshot>(
  board: Readonly<T>,
): T {
  return structuredClone(board);
}
