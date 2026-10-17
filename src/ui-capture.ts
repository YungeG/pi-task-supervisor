import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { currentRuntime } from "./runtime";
import { flowFacts, nextFlowStep, SUPERVISOR_LIMITS, type FlowFacts } from "./flow";
import { currentExecutionWait, type SupervisorState } from "./supervisor";
import { inspectConfirmedPreflightProjection, type PreflightState } from "./preflight";
import { readBoardHumanPresentation } from "./board-human";
import { readableBoardRequest, readablePreflight, preflightSummary } from "./human-presentation";
import {
  buildUiSummary,
  type UiScope,
  type UiSummary,
  type UiSummaryInput,
  type UiBoardView,
  type UiDocument,
} from "./ui-view";
import type { TaskBoardSnapshot } from "./types";
import type { ReceiptStore } from "./receipt-store";

function freezeClone<T>(value: T): Readonly<T> {
  const clone = structuredClone(value);
  function freeze(item: unknown): void {
    if (item === null || typeof item !== "object") return;
    Object.freeze(item);
    for (const child of Object.values(item)) freeze(child);
  }
  freeze(clone);
  return clone;
}
function text(value: string): string {
  return stripTerminalSequences(value).replace(/[\p{Cc}]/gu, (char) =>
    char === "\n" || char === "\t" ? char : JSON.stringify(char).slice(1, -1),
  );
}
function snapshot(value: unknown): string {
  return text(value === undefined ? "未记录" : JSON.stringify(value, null, 2));
}
function document(
  id: UiDocument["id"],
  title: string,
  availability: UiDocument["availability"],
  body: string,
): UiDocument {
  return {
    id,
    title,
    availability,
    text: text(body),
    ...(availability === "unknown" ? { reason: text(body) } : {}),
  };
}
function scopeAt(ctx: ExtensionContext, board: Readonly<TaskBoardSnapshot>): UiScope {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    leafId: ctx.sessionManager.getLeafId(),
    generation: board.generation,
    capturedAt: Date.now(),
  };
}
function assertIdentity(
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  scope: UiScope,
): void {
  if (
    ctx.sessionManager.getSessionId() !== scope.sessionId ||
    ctx.sessionManager.getLeafId() !== scope.leafId ||
    board.generation !== scope.generation
  )
    throw new Error("UI-only identity-changed: reopen the read-only view");
}
function captureFacts(ctx: ExtensionContext, sessionId: string): FlowFacts {
  try {
    return flowFacts(ctx);
  } catch {
    // A presentation uncertainty is not a runtime journal fault.
    return {
      enabled: currentRuntime().enabled,
      sessionId,
      idle: false,
      pending: true,
      journalFault: "展示事实读取失败，状态未知；请重新检查。",
    };
  }
}
function summaryInput(
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  scope: UiScope,
  receiptStore: ReceiptStore | undefined,
): UiSummaryInput {
  const runtime = currentRuntime();
  const facts = captureFacts(ctx, scope.sessionId);
  if (receiptStore && receiptStore.sessionId !== scope.sessionId)
    facts.receiptIssue = "回执身份需检查；回执计数未知（未水合或恢复）。";
  const supervisor = runtime.supervisor;
  const preflight = runtime.preflight;
  const repairs = {
    board: runtime.boardRepair?.sessionId === scope.sessionId,
    preflight: runtime.preflightRepair?.sessionId === scope.sessionId,
  };
  let ownerNext: string | undefined;
  try {
    ownerNext = nextFlowStep(board, supervisor, facts);
  } catch {
    facts.journalFault ??= "展示用 owner 下一步未知，请查看状态。";
  }
  let preflightDisplay: UiSummaryInput["preflightDisplay"];
  try {
    if (preflight?.sessionId === scope.sessionId)
      preflightDisplay = preflightSummary(
        preflight,
        repairs.preflight ? "repair" : facts.journalFault ? "fault" : undefined,
      );
  } catch {
    facts.journalFault ??= "执行前展示用 owner 说明未知，请查看状态。";
  }
  return {
    scope,
    board,
    facts,
    supervisor,
    preflight,
    repairs,
    limits: SUPERVISOR_LIMITS,
    ownerNext,
    preflightDisplay,
  };
}

/** Bounded current facts only; no board history or retained context parsing. */
export function captureUiSummary(
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
): UiSummary {
  const scope = scopeAt(ctx, board);
  const summary = buildUiSummary(summaryInput(ctx, board, scope, currentRuntime().receiptStore));
  assertIdentity(ctx, board, scope);
  return summary;
}
function ownSupervisor(input: UiSummaryInput): Readonly<SupervisorState> | undefined {
  return input.supervisor?.sessionId === input.scope.sessionId ? input.supervisor : undefined;
}
function ownPreflight(input: UiSummaryInput): Readonly<PreflightState> | undefined {
  return input.preflight?.sessionId === input.scope.sessionId ? input.preflight : undefined;
}
function receiptStats(scope: UiScope, store: ReceiptStore | undefined): string {
  if (store && store.sessionId !== scope.sessionId)
    return "回执身份需检查；回执计数未知（未水合或恢复）。";
  try {
    return snapshot(store?.stats);
  } catch {
    return "回执计数未知（未水合或恢复）";
  }
}
function externalReport(input: UiSummaryInput): string {
  const owner = ownSupervisor(input);
  if (!owner?.externalWait) return "外部最近 owner 报告：未记录；执行状态未知。";
  const applicability =
    owner.externalWait.deadlineAt <= input.scope.capturedAt
      ? "已过期"
      : currentExecutionWait(input.board, owner, input.scope.capturedAt)
        ? "适用于此捕获"
        : "不适用于此捕获";
  return `外部最近 owner 报告（${applicability}；不证明进程实时存活，不是任务验收）：\n${snapshot(owner.externalWait)}`;
}
function overview(
  input: UiSummaryInput,
  summary: UiSummary,
  receiptStore: ReceiptStore | undefined,
): UiDocument {
  const owner = ownSupervisor(input);
  const preflight = ownPreflight(input);
  const goals = [
    ...(owner ? [{ source: "supervisor", text: owner.goal }] : []),
    ...(preflight ? [{ source: "preflight", text: preflight.goal }] : []),
  ];
  const lines = [
    `只读捕获身份：\n${snapshot(input.scope)}`,
    `目标来源（原值）：\n${snapshot(goals)}`,
    `工作流：${input.board.workflowStatus}`,
    `全部阶段：\n${snapshot(input.board.phases)}`,
    `阶段提示：\n${snapshot(input.board.pendingPhasePrompt)}`,
    `全部阻塞：\n${snapshot(summary.blockers)}`,
    `宿主事实：\n${snapshot(input.facts)}`,
    `监督记录（仅同 session）：\n${snapshot(
      owner && {
        status: owner.status,
        model: owner.model,
        reason: owner.reason,
        holdCause: owner.holdCause,
        pending: owner.pending,
        epoch: owner.epoch,
        preflightBinding: owner.preflightBinding,
      },
    )}`,
    `预算记录（不重置）：\n${snapshot(
      owner && {
        reviews: owner.reviews,
        continuations: owner.continuations,
        stagnant: owner.stagnant,
        tokens: owner.tokens,
        cost: owner.cost,
        limits: SUPERVISOR_LIMITS,
      },
    )}`,
    `回执纯计数（不查找或水合）：\n${receiptStats(input.scope, receiptStore)}`,
    externalReport(input),
    `任务外部引用（状态未知）：\n${snapshot(input.board.tasks.filter((task) => task.executionRef).map((task) => ({ taskId: task.id, reference: task.executionRef })))}`,
    `下一步展示（不是可执行动作）：${summary.next.text}`,
  ];
  return document("overview", "总览", "available", lines.join("\n\n"));
}
function acceptance(input: UiSummaryInput): UiDocument {
  const owner = ownSupervisor(input);
  const task = input.board.tasks.find((item) => item.id === input.board.finalAcceptanceTaskId);
  return document(
    "acceptance",
    "目标验收记录",
    "available",
    [
      "任务 done、放弃和目标通过不同；以下只展示 owner 已有记录，未重算验收。",
      `finalAcceptanceTaskId：${snapshot(input.board.finalAcceptanceTaskId)}`,
      `验收任务与证据：\n${snapshot(task)}`,
      `owner 完成记录：\n${snapshot(owner && { status: owner.status, acceptedDigest: owner.acceptedDigest, bindings: owner.bindings })}`,
      "缺失的目标验收记录为未知；全 done 不代表目标通过。",
    ].join("\n\n"),
  );
}
function currentRequest(board: Readonly<TaskBoardSnapshot>): UiDocument {
  if (!board.decision)
    return document(
      "current-board-request",
      "当前看板请求",
      "absent",
      "当前未记录看板请求；历史回应不代表当前授权。",
    );
  const readable = readableBoardRequest(board.decision);
  return document(
    "current-board-request",
    "当前看板请求",
    "available",
    `当前请求快照（不是授权证明）\n${readable.title}\n\n${readable.body}`,
  );
}
function latestResponse(ctx: ExtensionContext): UiDocument {
  const result = readBoardHumanPresentation(ctx);
  if (result.status === "unknown")
    return document("latest-board-response", "最近看板回应", "unknown", result.reason);
  if (result.status === "absent")
    return document(
      "latest-board-response",
      "最近看板回应",
      "absent",
      "此分支没有已保存的看板原生回应；没有从缓存或工具 JSON 重建证明。",
    );
  const saved = result.confirmed;
  const request = readableBoardRequest(saved.request);
  return document(
    "latest-board-response",
    "最近看板回应",
    "available",
    [
      "原请求/历史回应，不代表当前授权；材料可查看不代表当前有效，不是任务验收。",
      request.title,
      request.body,
      `原 outcome：${snapshot(saved.outcome)}`,
      `原回应：${snapshot(saved.value)}`,
      `controlEntryId：${snapshot(saved.controlEntryId)}`,
    ].join("\n\n"),
  );
}
function preflightHistory(
  ctx: ExtensionContext,
  state: Readonly<PreflightState>,
  kind: "permission" | "start",
): string {
  const request =
    state.version === 2
      ? kind === "permission"
        ? state.permissionRequest
        : state.startRequest
      : undefined;
  if (!request) return `${kind} 历史：unknown（legacy 或缺少 requestId，未重新证明）。`;
  try {
    const checked = inspectConfirmedPreflightProjection(ctx, request.id);
    if (checked.state.sessionId !== state.sessionId) return `${kind} 历史：unknown（身份需检查）。`;
    const ids =
      checked.state.version === 2 && kind === "permission"
        ? (checked.state.permissionRequest?.permissionIds ?? [])
        : (checked.state.approval?.permissionIds ?? []);
    return [
      `${kind} 原请求/历史回应，不代表当前授权；不证明实时执行或目标验收。`,
      readablePreflight(checked.state, ids, kind === "start").body,
      `controlEntryId：${snapshot(checked.proof.control.id)}`,
      `原控制回应：\n${snapshot(checked.proof.control.data)}`,
    ].join("\n\n");
  } catch {
    return `${kind} 历史：unknown（missing/unconfirmed/证明或 S 启动记录未确认；未重新证明，不重放）。`;
  }
}
function preflightDocument(ctx: ExtensionContext, input: UiSummaryInput): UiDocument {
  const state = ownPreflight(input);
  if (!state)
    return document(
      "preflight",
      "执行前方案与历史",
      input.preflight ? "unknown" : "absent",
      input.preflight
        ? "当前状态身份需检查；不展示外来方案或回应。"
        : "当前未记录执行前方案；没有取得新的授权。",
    );
  const ids = state.version === 2 ? state.permissionRequest?.permissionIds : undefined;
  const readable = readablePreflight(
    structuredClone(state),
    ids ?? state.approval?.permissionIds ?? [],
    false,
  );
  return document(
    "preflight",
    "执行前方案与历史",
    "available",
    [
      "当前方案/请求/选择快照（可查看，不是新的批准；与历史原回应分栏）：",
      `当前捕获身份：\n${snapshot(input.scope)}`,
      readable.title,
      readable.body,
      `当前 owner 状态记录（不是重新核验的 native proof）：\n${snapshot(state)}`,
      preflightHistory(ctx, state, "permission"),
      preflightHistory(ctx, state, "start"),
    ].join("\n\n"),
  );
}

/** Explicit tasks capture only. Consumers receive independent, deeply frozen plain values. */
export function captureUiBoardView(
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
): UiBoardView {
  const scope = scopeAt(ctx, board);
  const receiptStore = currentRuntime().receiptStore;
  const input = summaryInput(ctx, board, scope, receiptStore);
  const summary = buildUiSummary(input);
  const view = freezeClone({
    summary,
    board,
    documents: [
      overview(input, summary, receiptStore),
      acceptance(input),
      currentRequest(board),
      latestResponse(ctx),
      preflightDocument(ctx, input),
    ],
  });
  assertIdentity(ctx, board, scope);
  return view;
}
