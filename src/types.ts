// ── Status ──

export type TaskStatus =
  | "draft"
  | "configured"
  | "ready"
  | "implementing"
  | "reviewing"
  | "done"
  | "abandoned";

// ── Domain Records ──

export interface EvidenceRef {
  kind: "command" | "review" | "artifact" | "diff";
  label: string;
  status: "passed" | "fixed" | "deferred";
  ref?: string;
  exitCode?: number;
  digest?: string;
}

export interface CompletionEvidence {
  summary: string;
  refs: EvidenceRef[];
  residualRisks?: string[];
}

export interface ExecutionRef {
  source: "pi-subagents" | "workflow";
  runId: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  profile: string;
  phase: number;
  dependencies: string[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  executionRef?: ExecutionRef;
  completionEvidence?: CompletionEvidence;
}

export interface PhaseRecord {
  phase: number;
  status: "pending" | "active" | "completed";
  completedAt?: string;
  title?: string;
}

// ── Board Snapshot ──

export type WorkflowStatus =
  | "inactive"
  | "active"
  | "paused"
  | "waiting_for_decision"
  | "completed";

export interface DecisionRecord {
  id: string;
  question: string;
  whyUserOwned: string;
  options?: string[];
  createdAt: string;
}

export interface LegacyTaskBoardSnapshot {
  version: 1;
  tasks: TaskRecord[];
  phases: PhaseRecord[];
  pendingPhasePrompt?: {
    phase: number;
    message: string;
  };
}

export interface TaskBoardSnapshot {
  version: 2;
  generation: number;
  workflowStatus: WorkflowStatus;
  finalAcceptanceTaskId?: string;
  tasks: TaskRecord[];
  phases: PhaseRecord[];
  pendingPhasePrompt?: {
    phase: number;
    message: string;
  };
  decision?: DecisionRecord;
  pauseReason?: string;
  stagnantSettles: number;
}

// ── Event Types ──

export type TaskWorkflowEvent =
  | {
      type: "write_tasks";
      mode: "replace" | "append";
      phases: Array<{
        phase: number;
        title: string;
        tasks: Array<{
          id: string;
          title: string;
          prompt: string;
          profile: string;
          phase: number;
        }>;
      }>;
    }
  | {
      type: "edit_task_data";
      id: string;
      data: Partial<Pick<TaskRecord, "title" | "prompt" | "profile" | "phase">>;
    }
  | { type: "edit_task_blockers"; id: string; dependencies: string[] }
  | { type: "compile_tasks" }
  | { type: "claim_ready_tasks"; ids: string[] }
  | {
      type: "advance_task";
      id: string;
      from: "implementing" | "reviewing";
      to: "reviewing" | "done";
      evidence?: CompletionEvidence;
    }
  | { type: "abandon_task"; id: string }
  | { type: "clear_tasks" };

// ── Edit Input Types ──

export interface DataEdit {
  id: string;
  type: "data";
  data: { title?: string; prompt?: string; profile?: string; phase?: number };
}

export interface BlockersEdit {
  id: string;
  type: "blockers";
  data: { dependencies: string[] };
}

export interface AdvanceEdit {
  id: string;
  type: "advance";
  data?: { evidence?: CompletionEvidence };
}

export interface AbandonEdit {
  id: string;
  type: "abandon";
  data?: Record<string, never>;
}

export type TaskEdit = DataEdit | BlockersEdit | AdvanceEdit | AbandonEdit;

// ── Constants ──

export const MAX_TASKS = 100;
export const MAX_AUTO_CONTINUE = 20;

export const CUSTOM_EVENT_TYPE = "continuous-tasks:event";
export const CUSTOM_SNAPSHOT_TYPE = "continuous-tasks:snapshot";
export const LEGACY_CUSTOM_SNAPSHOT_TYPE = "phased-tasks:snapshot";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "abandoned"]);
export const ACTIVE_STATUSES: ReadonlySet<TaskStatus> = new Set(["implementing", "reviewing"]);
export const ALL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "draft",
  "configured",
  "ready",
  "implementing",
  "reviewing",
  "done",
  "abandoned",
]);

/** Status → plain-text icon character */
export const STATUS_ICONS = {
  draft: "⚪",
  configured: "🔵",
  ready: "🟢",
  implementing: "▶️",
  reviewing: "🔍",
  done: "✅",
  abandoned: "❌",
} satisfies Record<TaskStatus, string>;
