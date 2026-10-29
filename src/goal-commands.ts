import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import { adoptSupervisedMode } from "./management-policy";
import { getBoardRef, updateUI } from "./state";
import { enableSessionScope, updateActiveTools } from "./scope";
import {
  requestGoalTransition,
  restoreGoalLifecycle,
  replanCurrentGoal,
  stopCurrentGoal,
  dispatchGoalPlanning,
} from "./goal-lifecycle";
import { readGoalJournal } from "./goal-journal";
import { invalidateGoalCallbacks } from "./goal-scope";

const normalize = (value: string) => value.trim().split(/\s+/).join(" ");
export function parseSuperviseArgs(text: string): { goal: string; replan: boolean } {
  const input = normalize(text);
  if (input === "--" || input.startsWith("-- "))
    return { goal: input.slice(2).trim(), replan: false };
  const replan = input === "--replan" || input.startsWith("--replan ");
  const goal = replan ? input.slice(8).trim() : input;
  if (goal === "--" || goal.startsWith("-- ")) return { goal: goal.slice(2).trim(), replan };
  if (goal.startsWith("--")) throw Error("Unknown supervise flag; use -- before literal goal text");
  return { goal, replan };
}
function notify(ctx: ExtensionCommandContext, text: string, error = false): void {
  if (ctx.hasUI) ctx.ui.notify(text, error ? "error" : "info");
}
export function goalStatusText(): string | undefined {
  const goal = currentRuntime().goal;
  if (!goal) return undefined;
  const current = goal.current;
  const lines = [
    current
      ? `GoalRun: ${current.scope.goalRunId}; ${current.phase}; planning ${current.planning.attemptNo}/${current.planning.status}`
      : "GoalRun: legacy current owner; transition pending",
    `Archived goals: ${goal.archives.length}; /task-supervisor history (readonly)`,
  ];
  if (goal.pending)
    lines.push(
      `Goal transition: ${goal.pending.confirmed ? "saved answer; projection pending" : "unconfirmed answer; fresh native confirmation required"}`,
    );
  if (goal.blocked) lines.push(`Goal hold: ${goal.blocked}`);
  if (current?.supervisor === null)
    lines.push(
      current.phase === "stopped"
        ? "Goal stopped before execution; a new supervise <goal> can archive it"
        : "Explicit /task-supervisor supervise --replan replans this same goal; /task-supervisor stop ends it. No business execution before separate approval/start.",
    );
  return lines.join("\n");
}
function showStatus(ctx: ExtensionCommandContext): void {
  notify(ctx, goalStatusText() ?? "No lifecycle-scoped current goal");
}
function legacyHistory(): boolean {
  const runtime = currentRuntime();
  const board = getBoardRef();
  if (runtime.supervisor && ["stopped", "completed"].includes(runtime.supervisor.status))
    return true;
  return !runtime.supervisor && board.tasks.length > 0 && board.workflowStatus !== "active";
}
function prepareTools(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  adoptSupervisedMode(pi, ctx);
  enableSessionScope(pi);
  updateActiveTools(pi, true);
}
function reconcileTransitionCache(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const runtime = currentRuntime();
  const goal = runtime.goal;
  if (!goal || goal.repair || !(goal.blocked || goal.pending?.confirmed)) return;
  const observed = readGoalJournal(ctx);
  if (!observed) return;
  if (observed.pending && !observed.pending.confirmed) {
    runtime.goal = observed;
    return;
  }
  if (!observed.current || observed.current.supervisor === null) restoreGoalLifecycle(pi, ctx);
}
async function routeSameGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  replan: boolean,
  goal: string,
): Promise<boolean> {
  const current = currentRuntime().goal?.current;
  if (
    !current ||
    (goal && goal !== current.seed.goal) ||
    ["stopped", "completed"].includes(current.phase)
  )
    return false;
  if (replan) {
    const result = await replanCurrentGoal(pi, ctx);
    if (result.status === "planning-ready" && result.planning) {
      prepareTools(pi, ctx);
      dispatchGoalPlanning(pi, ctx, result.planning);
    } else notify(ctx, result.reason ?? result.status, result.status === "blocked");
    updateUI(ctx, getBoardRef());
  } else showStatus(ctx);
  return true;
}
async function routeGoalInput(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  text: string,
  replan: boolean,
): Promise<void> {
  reconcileTransitionCache(pi, ctx);
  if (replan) {
    const current = currentRuntime().goal?.current;
    if (!current || (text && normalize(text) !== current.seed.goal))
      throw Error(
        "--replan requires the same current unstarted Goal; it cannot create another target",
      );
    if (current.supervisor !== null)
      throw Error(
        "Started Goal: use propose_scope_revision and native review-scope, not replan or another Start",
      );
  }
  if (await routeSameGoal(pi, ctx, replan, normalize(text))) return;
  if (replan)
    throw Error("A closed Goal cannot be replanned; explicitly prepare an independent goal");
  const goal = currentRuntime().goal;
  if (goal?.blocked) {
    notify(ctx, goal.blocked, true);
    return;
  }
  const result = await requestGoalTransition(pi, ctx, { goal: text, intent: "supervise" });
  if (result.status === "committed-planning" && result.planning) {
    prepareTools(pi, ctx);
    dispatchGoalPlanning(pi, ctx, result.planning);
    notify(ctx, "旧目标已只读归档；新目标进入只读规划。业务权限与首次执行仍需独立确认。");
  } else notify(ctx, result.reason ?? result.status, result.status === "blocked");
  updateUI(ctx, getBoardRef());
}
async function routeUnstartedControl(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
): Promise<boolean> {
  const current = currentRuntime().goal?.current;
  if (!current || current.supervisor !== null) return false;
  if (action === "stop") {
    const result = await stopCurrentGoal(pi, ctx);
    notify(ctx, result.reason ?? result.status, result.status === "blocked");
    updateUI(ctx, getBoardRef());
    return true;
  }
  if (action === "resume" || action === "recover") {
    notify(
      ctx,
      "该目标尚未启动监督；请显式 supervise --replan 重规划，或 stop 结束它。恢复命令不能创建 Supervisor。",
      true,
    );
    return true;
  }
  return false;
}

/** Human command adapter only. Goal ownership never depends on a model-supplied run ID. */
export async function routeGoalCommand(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  action: string,
  text: string,
): Promise<boolean> {
  const lifecycle = currentRuntime().goal;
  if (action === "supervise") {
    const request = parseSuperviseArgs(text);
    if (!lifecycle && !legacyHistory()) return false;
    await routeGoalInput(pi, ctx, request.goal, request.replan);
    return true;
  }
  if (!lifecycle) return false;
  if (lifecycle.pending || (lifecycle.blocked && !lifecycle.repair)) {
    notify(
      ctx,
      lifecycle.blocked ?? "先检查目标交接的实际控制/见证；它不能被其他命令批准或跳过。",
      true,
    );
    return true;
  }
  if (await routeUnstartedControl(pi, ctx, action)) return true;
  if (action === "stop") invalidateGoalCallbacks();
  return false;
}
