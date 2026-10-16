import { Text } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { validDecisionSpec, type DecisionSpec } from "./decision-spec";
import { answerBoardDecision, canReplaceBoardDecision } from "./board-human";
import { currentRuntime } from "./runtime";
import type {
  ToolDefinition,
  ExtensionAPI,
  AgentToolResult,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  WriteTasksParams,
  EditTasksParams,
  CompileTasksParams,
  ClearTasksParams,
  GetReadyTasksParams,
  AdvanceTasksParams,
  WorkflowGateParams,
} from "./schemas";
import {
  CUSTOM_EVENT_TYPE,
  CUSTOM_SNAPSHOT_TYPE,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
} from "./types";
import type { AdvanceEdit, TaskBoardSnapshot, TaskEdit, TaskWorkflowEvent } from "./types";
import { writeTasks, applyEdits, compileBoard, createEmptyBoard, claimReadyTasks } from "./engine";
import { cloneBoard, getStatusCounts, isSafeBoundedText } from "./validation";
import { getBoardRef, setBoard, persistEntries, updateUI } from "./state";
import { loadConfig, resolvePhasePrompt } from "./config";
import { assertObservedEvidence, bindCompletion } from "./supervisor";
import { isSessionScopeEnabled } from "./scope";
import { submitAndPresentPreflight, type PreflightHumanResult } from "./preflight-human";
import { SubmitPreflightParams, validPreflightSubmission } from "./preflight";
import {
  formatBoardText,
  formatSummaryLine,
  formatAllDoneMessage,
  formatClaimedTaskDetails,
} from "./formatting";

// ── Details Type ──

interface TaskToolDetails {
  snapshot: TaskBoardSnapshot;
  error?: string;
}

// ── Result Helpers ──

function makeSuccessResult(
  text: string,
  snapshot: TaskBoardSnapshot,
): AgentToolResult<TaskToolDetails> {
  return {
    content: [{ type: "text", text }],
    details: { snapshot },
  };
}

function makeErrorResult(
  errorText: string,
  snapshot: TaskBoardSnapshot,
): AgentToolResult<TaskToolDetails> {
  return {
    content: [{ type: "text", text: errorText }],
    details: { snapshot, error: errorText },
    isError: true,
  };
}

/**
 * Check for phases that just completed (before vs after) and set pending phase prompt.
 * MUTATES `afterBoard` — sets `afterBoard.pendingPhasePrompt` directly.
 * Returns void; callers must read from the mutated board.
 */
async function checkAndSetPhaseCompletion(
  beforePhases: TaskBoardSnapshot["phases"],
  afterBoard: TaskBoardSnapshot,
): Promise<void> {
  // Find phases that were NOT completed before but ARE completed after
  for (const afterPhase of afterBoard.phases) {
    if (afterPhase.status !== "completed") continue;
    const beforePhase = beforePhases.find((p) => p.phase === afterPhase.phase);
    if (!beforePhase || beforePhase.status !== "completed") {
      // This phase just completed
      const config = await loadConfig();
      const template = config.phaseCompletionPromptTemplate
        ? resolvePhasePrompt(config.phaseCompletionPromptTemplate, afterPhase.phase)
        : undefined;
      if (template) {
        afterBoard.pendingPhasePrompt = {
          phase: afterPhase.phase,
          message: template,
        };
      }
      return; // Only handle the first newly completed phase
    }
  }
}

function assertBoardCurrent(
  board: Readonly<TaskBoardSnapshot>,
  signal: AbortSignal | undefined,
  enabled: boolean,
): void {
  if (signal?.aborted || getBoardRef() !== board || isSessionScopeEnabled() !== enabled)
    throw new Error("Task update cancelled; session or task board changed before commit");
}

// ── Shared Result Renderer ──

function renderColoredBoardResult(text: string, _snapshot: TaskBoardSnapshot, theme: Theme): Text {
  const lines = text.split("\n");
  const colored = lines
    .map((line) => {
      if (/^─── Phase \d+/.test(line)) {
        return theme.fg("accent", theme.bold(line));
      }
      const taskLineMatch = line.match(/^(\S+\s+)(t-\d+\.\d+:\s)(.*)/);
      if (taskLineMatch) {
        const [, prefix, id, rest] = taskLineMatch;
        if (prefix != null && id != null && rest != null) {
          return prefix + theme.fg("muted", id) + rest;
        }
      }
      if (line.includes("→ depends on")) {
        return line.replace(/(t-\d+\.\d+)/g, (m) => theme.fg("muted", m));
      }
      if (line.startsWith("Summary:")) {
        return theme.fg("muted", line);
      }
      return line;
    })
    .join("\n");
  return new Text(colored, 0, 0);
}

export function createSubmitPreflightTool(
  pi: ExtensionAPI,
): ToolDefinition<
  typeof SubmitPreflightParams,
  Partial<PreflightHumanResult> & { error?: string }
> {
  return {
    name: "submit_preflight",
    label: "Submit Preflight",
    description:
      "Submit the exact read-only plan and additional permission inventory for a human-created preflight. This tool cannot approve or start execution.",
    parameters: SubmitPreflightParams,
    promptSnippet:
      "Submit a complete read-only preflight proposal; only the user can approve and separately start it.",
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        if (signal?.aborted) throw new Error("Preflight submission cancelled");
        if (!validPreflightSubmission(params))
          throw new Error("Invalid preflight submission; approval/status fields are not accepted");
        const outcome = await submitAndPresentPreflight(
          pi,
          ctx,
          _id,
          params.preflightId,
          params.proposal,
          signal,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(outcome) }],
          details: outcome,
          ...(outcome.projectionPending ? { isError: true } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Preflight submission failed";
        return Promise.resolve({
          content: [{ type: "text" as const, text: message }],
          details: { error: message },
          isError: true,
        });
      }
    },
  };
}

// ── Tool 1: write_tasks ──

export function createWriteTasksTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof WriteTasksParams, TaskToolDetails> {
  return {
    name: "write_tasks",
    label: "Write Tasks",
    description:
      "Add tasks to the phased task board. Provide phases (each with a title and tasks) and a mode ('replace' to clear the board first, 'append' to add to existing tasks). Phases are numbered automatically from array position. Tasks are created in 'draft' status. After writing, use compile_tasks to validate dependencies and activate phases.",
    parameters: WriteTasksParams,
    promptSnippet:
      "Phased task board: write, edit (data/blockers/advance/abandon), compile, claim ready tasks",
    promptGuidelines: [
      "Use write_tasks to add tasks grouped by phase, then compile_tasks to validate and activate them.",
      "write_tasks accepts a mode ('replace' or 'append') and an array of phases, each with a title and tasks.",
      "Each task needs a title, prompt, and profile. Phase numbers are assigned automatically from array position.",
      "Use 'replace' mode to start fresh (clears the board). Use 'append' mode to add phases to an existing board.",
      "Use edit_tasks to set dependencies between tasks after writing.",
      "Tasks are written in 'draft' status. Use compile_tasks to transition them to 'configured' or 'ready'.",
      "Phases gate execution: tasks in later phases only become ready after earlier phases are complete.",
      "Maximum 100 tasks allowed on the board.",
    ],

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const board = getBoardRef();
      const now = new Date().toISOString();

      try {
        const newBoard = writeTasks(
          board,
          {
            mode: params.mode as "replace" | "append",
            phases: params.phases.map((p) => ({
              title: p.title,
              tasks: p.tasks.map((t) => ({
                title: t.title,
                prompt: t.prompt,
                profile: t.profile,
              })),
            })),
          },
          now,
        );
        setBoard(newBoard);

        const totalNewTasks = params.phases.reduce(
          (sum: number, p: { tasks: unknown[] }) => sum + p.tasks.length,
          0,
        );
        const newPhaseNumbers = newBoard.phases.slice(-params.phases.length).map((p) => p.phase);
        const event: TaskWorkflowEvent = {
          type: "write_tasks",
          mode: params.mode as "replace" | "append",
          phases: params.phases.map((p: (typeof params.phases)[number], i: number) => ({
            phase: newPhaseNumbers[i] ?? i + 1,
            title: p.title.trim(),
            tasks: newBoard.tasks
              .filter((t) => t.phase === (newPhaseNumbers[i] ?? i + 1))
              .map((t) => ({
                id: t.id,
                title: t.title,
                prompt: t.prompt,
                profile: t.profile,
                phase: t.phase,
              })),
          })),
        };
        persistEntries(pi, event, newBoard);
        updateUI(ctx, newBoard);

        return makeSuccessResult(
          `Added ${totalNewTasks} task(s) to the board.\n\n${formatBoardText(newBoard)}`,
          newBoard,
        );
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err), board);
      }
    },

    renderCall(args, theme) {
      const phases = args.phases as Array<{ tasks: Array<unknown> }> | undefined;
      const totalTasks = phases ? phases.reduce((sum: number, p) => sum + p.tasks.length, 0) : 0;
      return new Text(
        theme.fg("toolTitle", theme.bold("write_tasks ")) +
          theme.fg("muted", `(${totalTasks} items)`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (!details) return new Text(text, 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      return renderColoredBoardResult(text, details.snapshot, theme);
    },
  };
}

// ── Tool 2: edit_tasks ──

export function createEditTasksTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof EditTasksParams, TaskToolDetails> {
  return {
    name: "edit_tasks",
    label: "Edit Tasks",
    description:
      "Batch-edit tasks on the board. Supports three edit types: 'data' (modify title/prompt/profile/phase), 'blockers' (set dependencies), and 'abandon' (mark as abandoned). Edits are atomic — if any fails, none are applied.",
    parameters: EditTasksParams,
    promptSnippet: undefined,
    promptGuidelines: undefined,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const board = getBoardRef();
      const enabled = isSessionScopeEnabled();
      const now = new Date().toISOString();

      // Snapshot before-phases for phase completion detection
      const beforePhases = board.phases.map((p) => ({ ...p }));

      const edits: TaskEdit[] = params.tasks.map((t: (typeof params.tasks)[number]): TaskEdit => {
        if (t.type === "data") {
          return {
            id: t.id,
            type: "data",
            data: (
              t as { data: { title?: string; prompt?: string; profile?: string; phase?: number } }
            ).data,
          };
        }
        if (t.type === "blockers") {
          return {
            id: t.id,
            type: "blockers",
            data: (t as { data: { dependencies: string[] } }).data,
          };
        }
        return { id: t.id, type: "abandon" };
      });

      try {
        const newBoard = applyEdits(board, edits, now);

        // Detect phase completion and set pending prompt
        await checkAndSetPhaseCompletion(beforePhases, newBoard);
        assertBoardCurrent(board, signal, enabled);

        setBoard(newBoard);

        // Emit one event per edit with the correct type
        for (const edit of edits) {
          let event: TaskWorkflowEvent;
          if (edit.type === "data") {
            event = { type: "edit_task_data", id: edit.id, data: edit.data };
          } else if (edit.type === "blockers") {
            event = {
              type: "edit_task_blockers",
              id: edit.id,
              dependencies: edit.data.dependencies,
            };
          } else {
            event = { type: "abandon_task", id: edit.id };
          }
          pi.appendEntry(CUSTOM_EVENT_TYPE, event);
        }
        pi.appendEntry(CUSTOM_SNAPSHOT_TYPE, newBoard);
        updateUI(ctx, newBoard);

        const counts = getStatusCounts(newBoard);
        const summary = formatSummaryLine(newBoard, counts);
        const hasStructuralEdits = edits.some((e) => e.type === "data" || e.type === "blockers");
        const allTerminal = newBoard.tasks.every((t) => TERMINAL_STATUSES.has(t.status));
        const boardText =
          hasStructuralEdits || allTerminal
            ? formatBoardText(newBoard, { counts })
            : formatBoardText(newBoard, { activePhaseOnly: true, counts });
        return makeSuccessResult(
          `Applied ${edits.length} edit(s). ${summary}\n\n${boardText}`,
          newBoard,
        );
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err), board);
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("edit_tasks ")) +
          theme.fg("warning", `(${args.tasks.length} edits)`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (!details) return new Text(text, 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      return renderColoredBoardResult(text, details.snapshot, theme);
    },
  };
}

// ── Tool 3: compile_tasks ──

export function createCompileTasksTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof CompileTasksParams, TaskToolDetails> {
  return {
    name: "compile_tasks",
    label: "Compile Tasks",
    description:
      "Validate and compile the task board with an explicit final acceptance task. Checks cycles, dependencies, acceptance coverage, and phase gating before enabling autonomous execution.",
    parameters: CompileTasksParams,
    promptSnippet: undefined,
    promptGuidelines: undefined,

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const board = getBoardRef();
      const enabled = isSessionScopeEnabled();
      const now = new Date().toISOString();

      // Snapshot before-phases for phase completion detection
      const beforePhases = board.phases.map((p) => ({ ...p }));

      try {
        const newBoard = compileBoard(board, now, params.finalAcceptanceTaskId);

        // Detect phase completion and set pending prompt
        await checkAndSetPhaseCompletion(beforePhases, newBoard);
        assertBoardCurrent(board, signal, enabled);

        setBoard(newBoard);

        const event: TaskWorkflowEvent = { type: "compile_tasks" };
        persistEntries(pi, event, newBoard);
        updateUI(ctx, newBoard);

        const counts = getStatusCounts(newBoard);
        const readyCount = counts.ready;
        const summary = formatSummaryLine(newBoard, counts);
        return makeSuccessResult(
          `Board compiled. ${summary}. ${readyCount} task(s) ready to claim.\n\n${formatBoardText(newBoard, { counts })}`,
          newBoard,
        );
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err), board);
      }
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("compile_tasks")), 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (!details) return new Text(text, 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      return renderColoredBoardResult(text, details.snapshot, theme);
    },
  };
}

// ── Tool 4: clear_tasks ──

export function createClearTasksTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof ClearTasksParams, TaskToolDetails> {
  return {
    name: "clear_tasks",
    label: "Clear Tasks",
    description: "Clear the entire task board, removing all tasks and resetting state.",
    parameters: ClearTasksParams,
    promptSnippet: undefined,
    promptGuidelines: undefined,

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const board = getBoardRef();

      if (board.tasks.some((t) => ACTIVE_STATUSES.has(t.status))) {
        return makeErrorResult(
          "Cannot clear board while tasks are implementing or reviewing. Complete or advance active tasks first.",
          board,
        );
      }

      const emptyBoard = createEmptyBoard();
      emptyBoard.generation = board.generation + 1;
      setBoard(emptyBoard);

      const event: TaskWorkflowEvent = { type: "clear_tasks" };
      persistEntries(pi, event, emptyBoard);
      updateUI(ctx, emptyBoard);

      return makeSuccessResult("Board cleared.", emptyBoard);
    },

    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("clear_tasks")), 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (!details) return new Text(text, 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      return new Text(theme.fg("text", text), 0, 0);
    },
  };
}

// ── Tool 5: get_ready_tasks ──

export function createGetReadyTasksTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof GetReadyTasksParams, TaskToolDetails> {
  return {
    name: "get_ready_tasks",
    label: "Get Ready Tasks",
    description:
      "Claim ready tasks from the board. Moves claimed tasks to 'implementing' status. Ordered by phase ascending, then creation order. After claiming, work through implementing → reviewing → done using advance_tasks.",
    parameters: GetReadyTasksParams,
    promptSnippet: undefined,
    promptGuidelines: undefined,

    // eslint-disable-next-line @typescript-eslint/require-await
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const board = getBoardRef();
      const now = new Date().toISOString();

      try {
        const result = claimReadyTasks(board, params.count, now);

        if (result.claimed.length === 0) {
          // Determine why no tasks were claimed
          const allTerminal = board.tasks.every((t) => TERMINAL_STATUSES.has(t.status));
          if (allTerminal && board.tasks.length > 0) {
            return makeErrorResult(formatAllDoneMessage(board), board);
          }

          // Deadlock: non-terminal tasks but none actionable
          const nonTerminal = board.tasks.filter((t) => !TERMINAL_STATUSES.has(t.status));
          if (nonTerminal.length > 0) {
            const blockedList = nonTerminal
              .map((t) => `[${t.id}] ${t.title} (${t.status}, Phase ${t.phase})`)
              .join("\n");
            return makeErrorResult(
              `No ready tasks available. Tasks remain but none are actionable. Check dependencies and phase gating.\n\nBlocked tasks:\n${blockedList}\n\nUse edit_tasks to resolve blockers, then compile_tasks.`,
              board,
            );
          }

          return makeErrorResult("No tasks on the board.", board);
        }

        // Success: claimed tasks
        setBoard(result.board);

        const event: TaskWorkflowEvent = {
          type: "claim_ready_tasks",
          ids: result.claimed.map((t) => t.id),
        };
        persistEntries(pi, event, result.board);
        updateUI(ctx, result.board);

        const claimedDetails = formatClaimedTaskDetails(result.claimed);

        return makeSuccessResult(
          `Claimed ${result.claimed.length} task(s).\n\n${claimedDetails}\n\nReview each claimed task and advance through implementing → reviewing → done using advance_tasks.\n\n${formatBoardText(result.board, { activePhaseOnly: true })}`,
          result.board,
        );
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err), board);
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("get_ready_tasks ")) +
          theme.fg("muted", `(count: ${args.count})`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (!details) return new Text(text, 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      return renderColoredBoardResult(text, details.snapshot, theme);
    },
  };
}

// ── Tool 6: advance_tasks ──

function advanceEvent(
  edit: AdvanceEdit,
  before: TaskBoardSnapshot,
  after: TaskBoardSnapshot,
): TaskWorkflowEvent {
  const original = before.tasks.find((task) => task.id === edit.id);
  const updated = after.tasks.find((task) => task.id === edit.id);
  if (!original || !updated) throw new Error(`Task "${edit.id}" disappeared during advance`);
  if (original.status !== "implementing" && original.status !== "reviewing") {
    throw new Error(`Task "${edit.id}" had invalid pre-advance status ${original.status}`);
  }
  if (updated.status !== "reviewing" && updated.status !== "done") {
    throw new Error(`Task "${edit.id}" had invalid post-advance status ${updated.status}`);
  }
  return {
    type: "advance_task",
    id: edit.id,
    from: original.status,
    to: updated.status,
    evidence: edit.data?.evidence,
  };
}

export function createAdvanceTasksTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof AdvanceTasksParams, TaskToolDetails> {
  return {
    name: "advance_tasks",
    label: "Advance Tasks",
    description:
      "Advance tasks through implementing → reviewing → done. Reviewing tasks require bounded completion evidence; evidence is rejected before review or when validation failed.",
    parameters: AdvanceTasksParams,
    promptSnippet: "advance_tasks: move tasks implementing → reviewing → done",
    promptGuidelines: [
      "Use advance_tasks to advance claimed tasks through implementing → reviewing → done.",
      "Each transition advances one task by one step; provide evidence only for reviewing→done.",
      "Do not mark reviewing tasks done until review and required validation evidence are available.",
    ],

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const board = getBoardRef();
      const enabled = isSessionScopeEnabled();
      const now = new Date().toISOString();
      const beforePhases = board.phases.map((p) => ({ ...p }));
      const ids = params.transitions.map((transition) => transition.id);
      if (new Set(ids).size !== ids.length) {
        return makeErrorResult("Duplicate task ids in transitions", board);
      }
      const edits: AdvanceEdit[] = params.transitions.map((transition) => ({
        id: transition.id,
        type: "advance" as const,
        // SDK StringEnum uses its host TypeBox's TUnsafe; keep the existing wire contract.
        // Runtime argument/engine/evidence validation remains unchanged below.
        data: transition.evidence ? { evidence: transition.evidence } : undefined,
      }));

      try {
        for (const edit of edits) {
          if (board.tasks.find((task) => task.id === edit.id)?.status === "reviewing")
            assertObservedEvidence(edit.id, edit.data?.evidence);
        }
        const newBoard = applyEdits(board, edits, now);
        await checkAndSetPhaseCompletion(beforePhases, newBoard);
        assertBoardCurrent(board, signal, enabled);

        setBoard(newBoard);

        for (const edit of edits) {
          pi.appendEntry(CUSTOM_EVENT_TYPE, advanceEvent(edit, board, newBoard));
        }
        pi.appendEntry(CUSTOM_SNAPSHOT_TYPE, newBoard);
        bindCompletion(pi, newBoard, ids);
        updateUI(ctx, newBoard);

        const counts = getStatusCounts(newBoard);
        const allTerminal = newBoard.tasks.every((t) => TERMINAL_STATUSES.has(t.status));
        const boardText = allTerminal
          ? formatBoardText(newBoard, { counts })
          : formatBoardText(newBoard, { activePhaseOnly: true, counts });

        const summary = formatSummaryLine(newBoard, counts);
        return makeSuccessResult(
          `Advanced ${edits.length} task(s). ${summary}\n\n${boardText}`,
          newBoard,
        );
      } catch (err) {
        return makeErrorResult(err instanceof Error ? err.message : String(err), board);
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("advance_tasks ")) +
          theme.fg("muted", `(${args.transitions.length} tasks)`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (!details) return new Text(text, 0, 0);
      if (details.error) return new Text(theme.fg("error", details.error), 0, 0);
      return renderColoredBoardResult(text, details.snapshot, theme);
    },
  };
}

type WorkflowGateInput = {
  action: "wait_for_decision" | "bind_execution" | "clear_execution";
  taskId?: string;
  decision?: {
    question: string;
    whyUserOwned: string;
    options?: string[];
    spec?: DecisionSpec;
    supersedes?: string;
  };
  executionRef?: { source: "pi-subagents" | "workflow"; runId: string };
};

type GateResult = { board: TaskBoardSnapshot; event: TaskWorkflowEvent };

function gateTask(board: Readonly<TaskBoardSnapshot>, taskId: string | undefined) {
  if (!taskId || !isSafeBoundedText(taskId, 100)) throw new Error("taskId is required");
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error(`Task "${taskId}" not found`);
  return task;
}

function gateDecision(params: WorkflowGateInput): NonNullable<WorkflowGateInput["decision"]> {
  const decision = params.decision;
  if (!decision) throw new Error("decision is required");
  if (!decision.spec || !validDecisionSpec(decision.spec))
    throw new Error("Invalid structured decision scope");
  if (decision.spec.kind === "choice" && !decision.options?.length)
    throw new Error("Choice decision requires options");
  if (
    !isSafeBoundedText(decision.question, 1000) ||
    !isSafeBoundedText(decision.whyUserOwned, 1000) ||
    (decision.options ?? []).length > 10 ||
    (decision.options ?? []).some((option) => !isSafeBoundedText(option, 500))
  ) {
    throw new Error("Decision content is invalid or secret-like");
  }
  return decision;
}

function waitForDecision(
  board: Readonly<TaskBoardSnapshot>,
  params: WorkflowGateInput,
  now: string,
): GateResult {
  const task = gateTask(board, params.taskId);
  const decision = gateDecision(params);
  if (board.workflowStatus === "waiting_for_decision" && !canReplaceBoardDecision(board, params))
    throw new Error(
      "Replacement must name the current decision and task with a complete structured proposal",
    );
  const actionable = board.tasks.filter((candidate) =>
    ["ready", "implementing", "reviewing"].includes(candidate.status),
  );
  if (actionable.some((candidate) => candidate.id !== task.id)) {
    throw new Error(
      "Independent actionable tasks remain; continue them before waiting for a decision",
    );
  }
  const updated = cloneBoard(board);
  const record = {
    id: decision.spec ? `decision-${randomUUID()}` : `decision-${board.generation + 1}`,
    ...(decision.spec ? { spec: structuredClone(decision.spec) } : {}),
    ...(decision.supersedes ? { supersedes: decision.supersedes } : {}),
    taskId: task.id,
    question: decision.question,
    whyUserOwned: decision.whyUserOwned,
    options: decision.options ? [...decision.options] : undefined,
    createdAt: now,
  };
  updated.workflowStatus = "waiting_for_decision";
  updated.decision = record;
  updated.generation++;
  updated.stagnantSettles = 0;
  return { board: updated, event: { type: "wait_for_decision", decision: record } };
}

function requireExecutionRef(params: WorkflowGateInput) {
  if (!params.executionRef || !isSafeBoundedText(params.executionRef.runId, 200)) {
    throw new Error("executionRef is required and must be safe");
  }
  return params.executionRef;
}

function bindExecution(board: Readonly<TaskBoardSnapshot>, params: WorkflowGateInput): GateResult {
  const task = gateTask(board, params.taskId);
  if (task.status !== "implementing" && task.status !== "reviewing") {
    throw new Error("Execution receipts can only be bound to implementing or reviewing tasks");
  }
  const executionRef = requireExecutionRef(params);
  if (task.executionRef) {
    throw new Error(`Task "${task.id}" already has an execution receipt`);
  }
  const updated = cloneBoard(board);
  const target = updated.tasks.find((candidate) => candidate.id === task.id);
  if (!target) throw new Error(`Task "${task.id}" disappeared during update`);
  target.executionRef = { ...executionRef };
  updated.generation++;
  updated.stagnantSettles = 0;
  return {
    board: updated,
    event: { type: "bind_execution", id: task.id, executionRef: { ...executionRef } },
  };
}

function clearExecution(board: Readonly<TaskBoardSnapshot>, params: WorkflowGateInput): GateResult {
  const task = gateTask(board, params.taskId);
  const executionRef = requireExecutionRef(params);
  if (!task.executionRef) throw new Error(`Task "${task.id}" has no execution receipt`);
  if (
    task.executionRef.source !== executionRef.source ||
    task.executionRef.runId !== executionRef.runId
  ) {
    throw new Error("executionRef does not match the active receipt");
  }
  const updated = cloneBoard(board);
  const target = updated.tasks.find((candidate) => candidate.id === task.id);
  if (!target) throw new Error(`Task "${task.id}" disappeared during update`);
  target.executionRef = undefined;
  updated.generation++;
  updated.stagnantSettles = 0;
  return {
    board: updated,
    event: { type: "clear_execution", id: task.id, executionRef: { ...executionRef } },
  };
}

function persistWorkflowGate(pi: ExtensionAPI, result: GateResult): void {
  try {
    persistEntries(pi, result.event, result.board);
  } catch {
    currentRuntime().journalFault =
      "Workflow gate persistence failed; inspect journal before further mutation";
    currentRuntime().cancel();
    throw new Error(currentRuntime().journalFault);
  }
}

function applyWorkflowGate(
  board: Readonly<TaskBoardSnapshot>,
  params: WorkflowGateInput,
  now: string,
): GateResult {
  switch (params.action) {
    case "wait_for_decision":
      return waitForDecision(board, params, now);
    case "bind_execution":
      return bindExecution(board, params);
    case "clear_execution":
      return clearExecution(board, params);
    default: {
      const unsupported: never = params.action;
      throw new Error(`Unsupported workflow gate: ${String(unsupported)}`);
    }
  }
}

export function createWorkflowGateTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof WorkflowGateParams, TaskToolDetails> {
  return {
    name: "workflow_gate",
    label: "Workflow Gate",
    description:
      "Create a real user-decision gate or bind/clear an opaque subagent/workflow execution receipt. This tool never runs or resumes the external execution itself.",
    parameters: WorkflowGateParams,
    promptSnippet: "workflow_gate: wait for a user decision or bind an existing execution receipt",
    promptGuidelines: [
      "Use workflow_gate wait_for_decision only for a material user-owned decision after independent ready work is exhausted. Include spec version 1: authorization with scope/prohibitions, choice with exact options, or information with text/integer/date format. This is a proposal, never approval.",
      "For a legacy or rejected waiting gate submit the complete replacement with supersedes=current decision ID and the same task. Only its metadata changes; request a new native response through /task-supervisor decide, never claim chat text resolved it.",
      "Use workflow_gate bind_execution immediately after launching a writer so later continuations inspect rather than duplicate it.",
    ],

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const board = getBoardRef();
      const journalFault = currentRuntime().journalFault;
      if (journalFault) return makeErrorResult(journalFault, board);
      const replacing = canReplaceBoardDecision(board, params);
      if (board.workflowStatus !== "active" && !replacing) {
        return makeErrorResult("Workflow must be active or a complete decision replacement", board);
      }
      const now = new Date().toISOString();
      try {
        const result = applyWorkflowGate(board, params, now);
        persistWorkflowGate(pi, result);
        setBoard(result.board);
        updateUI(ctx, result.board);
        const status =
          params.action === "wait_for_decision" && !replacing
            ? await answerBoardDecision(pi, ctx, _signal)
            : undefined;
        return {
          ...makeSuccessResult(
            `Workflow gate applied: ${params.action}${status ? `; human result: ${JSON.stringify(status)}` : ""}. A native approval is not task acceptance.`,
            getBoardRef(),
          ),
          ...(status?.projectionPending ? { isError: true } : {}),
        };
      } catch (error) {
        return makeErrorResult(error instanceof Error ? error.message : String(error), board);
      }
    },

    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("workflow_gate ")) + theme.fg("muted", args.action),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as TaskToolDetails | undefined;
      const text = result.content[0] && "text" in result.content[0] ? result.content[0].text : "";
      if (details?.error) return new Text(theme.fg("error", details.error), 0, 0);
      return new Text(theme.fg("success", text), 0, 0);
    },
  };
}
