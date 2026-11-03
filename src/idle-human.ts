import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getIdleActions,
  idleControlApi,
  idleControlContext,
  idleOutcome,
  type IdleActionHandle,
  type IdleActionLease,
  type IdleActionResult,
} from "./host-idle";
import { bindRuntimeCallback, currentRuntime, type TaskRuntime } from "./runtime";
import { isTrustedLocalTui, withNativeUiLock, reviewScope } from "./human-ui";
import { getBoardRef, refreshUI } from "./state";
import { journalDigest } from "./human-journal";
import { inspectRestorableSession } from "./human-control";
import {
  approvePreflight,
  reviewPreflightDefinitions,
  startApprovedPreflight,
  assertPreflightStartMaterial,
} from "./preflight-human";
import {
  inspectConfirmedPreflightProjection,
  preflightAuthorizationIssue,
  type PreflightState,
} from "./preflight";
import { answerBoardDecision } from "./board-human";
import { reviewAcceptanceContractNow } from "./acceptance-runtime";
import { reviewScopeRevisionNow } from "./scope-revision";
import { flowFacts, cachedApprovalAction, ordinaryResumeIssue, resumeControlIssue } from "./flow";
import { captureManagementSnapshot, writerAttention } from "./management-policy";
import { executionAcceptanceIssue, executionRegistryFor } from "./execution-settlement";
import { currentScopeState, scopeProposalFor, sameScopeRef } from "./scope-revision-journal";
import { supervisorState, recoverSupervisor } from "./supervisor";
import { currentWorkOwner, readControlJournal, type WorkOwnerKey } from "./control-journal";
import { contractProposalViews } from "./acceptance-planning";
import { selectedAcceptanceContract, type AcceptanceJournalView } from "./acceptance-journal";
import {
  continuationCandidate,
  adoptStartedGoal,
  humanStateStamp,
  resumeBoardControl,
  retainHumanDelivery,
} from "./session-controls";
import { requireCurrentEvidenceCapability } from "./execution-capability";
import { isSessionScopeEnabled, reconcileActiveTools } from "./scope";
import { preflightNotice, boardNotice } from "./human-presentation";
import { redact } from "./receipt-store";

type Kind =
  | "permissions"
  | "preflight-definitions"
  | "first-start"
  | "board-decision"
  | "contract-definition"
  | "scope-review"
  | "resume-board"
  | "recover-supervisor";
interface Intent {
  kind: Kind;
  id: string;
  parent: string;
  label: string;
  auto: boolean;
  material: string;
  selection?: string;
}
type BareIntent = Omit<Intent, "material">;
interface Owner {
  runtime: TaskRuntime;
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  key: string;
  current: () => boolean;
}
interface Ref {
  entryId: string;
  digest: string;
}
interface Delivery {
  attemptId: string;
  owner: Owner;
  kind: Kind;
  saved: boolean;
  after?: string;
  started?: Extract<IdleActionResult, { status: "started" }>;
  prepareFailure?: boolean;
}
interface HumanUiState {
  muted: Set<string>;
  handle?: IdleActionHandle;
  delivery?: Delivery;
  deferredTools?: { owner: Owner; ref: Ref; prepareFailure?: boolean };
}
interface ControlRun {
  origin: ExtensionContext;
  ctx: ExtensionContext;
  pi: ExtensionAPI;
  lease: IdleActionLease;
  owner: Owner;
  state: HumanUiState;
  memo: Delivery;
  step: Intent;
}
const states = new WeakMap<TaskRuntime, HumanUiState>();
function state(): HumanUiState {
  const runtime = currentRuntime();
  let value = states.get(runtime);
  if (!value) {
    value = { muted: new Set() };
    states.set(runtime, value);
  }
  return value;
}
function identity(ctx: ExtensionContext): unknown {
  const runtime = currentRuntime(),
    goal = runtime.goal?.current,
    mode =
      runtime.management?.mode ??
      (runtime.preflight || runtime.supervisor ? "supervised" : runtime.enabled ? "tasks" : "off");
  return [
    ctx.sessionManager.getSessionId(),
    runtime.goalEpoch,
    goal?.scope.goalRunId,
    goal?.scope.lifecycleCommitId,
    goal?.planning.attemptId,
    mode,
    runtime.preflight?.preflightId,
    mode === "tasks" ? currentWorkOwner(ctx.sessionManager.getSessionId()) : undefined,
  ];
}
function owner(ctx: ExtensionContext): Owner | undefined {
  const runtime = currentRuntime(),
    manager = ctx.sessionManager,
    sessionId = manager.getSessionId();
  const anchor = manager.getLeafId();
  if (!anchor) return;
  const key = journalDigest(identity(ctx));
  return {
    runtime,
    manager,
    sessionId,
    key,
    current: () => {
      try {
        return (
          currentRuntime() === runtime &&
          ctx.sessionManager === manager &&
          manager.getSessionId() === sessionId &&
          journalDigest(identity(ctx)) === key &&
          manager.getBranch().some((entry) => entry.id === anchor)
        );
      } catch {
        return false;
      }
    },
  };
}
function mute(s: HumanUiState, parent: string): void {
  if (s.muted.size < 4096) s.muted.add(parent);
}
export function idleHumanSupported(ctx: ExtensionContext): boolean {
  return !!getIdleActions(ctx) && ctx.mode === "tui" && ctx.hasUI && isTrustedLocalTui(ctx);
}
function notify(ctx: ExtensionContext, text: string, level: "info" | "warning" = "info"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  } catch {
    /* Display does not own the saved result. */
  }
}
function parent(ctx: ExtensionContext, kind: Kind, source: unknown): string {
  return journalDigest([identity(ctx), kind, source]);
}
function recoveryBlocked(ctx: ExtensionContext): boolean {
  try {
    const management = captureManagementSnapshot(ctx),
      facts = flowFacts(ctx);
    if (!management.activeWorkOwner || management.state !== "active") return true;
    return !!(
      management.identityIssue ||
      management.invocationIssue ||
      writerAttention(ctx).length ||
      executionAcceptanceIssue(management.activeWorkOwner) ||
      facts.journalFault ||
      facts.goalIssue ||
      facts.activityIssue ||
      facts.receiptIssue
    );
  } catch {
    return true;
  }
}
function permissionSelection(pref: PreflightState): string | undefined {
  if (!pref.approval) return;
  return (
    [
      ...new Set([
        ...pref.approval.permissionIds,
        ...(pref.proposal?.permissions
          .filter((permission) => permission.required)
          .map((p) => p.id) ?? []),
        ...(pref.proposal?.preparation?.permissionIds ?? []),
      ]),
    ]
      .sort()
      .join(",") || "none"
  );
}
function unstartedIntent(ctx: ExtensionContext, pref: PreflightState): BareIntent | undefined {
  if (!pref.proposal || ["revoked", "interrupted"].includes(pref.phase)) return;
  if (pref.version === 2 && pref.permissionDisposition === "rejected") return;
  const action = cachedApprovalAction(ctx.sessionManager.getSessionId());
  if (action?.kind === "materials") return;
  let kind: Kind = "permissions";
  if (action?.kind === "definitions") kind = "preflight-definitions";
  else if (pref.phase === "approved" && !action?.command?.includes("approve")) kind = "first-start";
  const labels = {
    permissions: "审核原计划权限（不启动）",
    "preflight-definitions": "重新核对当前定义（不重批业务许可）",
    "first-start": "独立确认首次启动（权限批准不是 Start）",
  };
  return {
    kind,
    id: pref.planId ?? "",
    parent: parent(ctx, kind, pref.preflightId),
    label: labels[kind],
    auto: kind === "first-start",
    selection: kind === "permissions" ? permissionSelection(pref) : undefined,
  };
}
function preflightIntent(ctx: ExtensionContext): BareIntent | undefined {
  const pref = currentRuntime().preflight;
  if (pref?.sessionId !== ctx.sessionManager.getSessionId()) return;
  if (!pref.started) return unstartedIntent(ctx, pref);
  const action = cachedApprovalAction(ctx.sessionManager.getSessionId());
  if (action?.kind !== "preparing" || !action.proposalId || getBoardRef().finalAcceptanceTaskId)
    return;
  return {
    kind: "contract-definition",
    id: action.proposalId,
    parent: parent(ctx, "contract-definition", pref.preflightId),
    label: "检查准备并审核具体定义（保持暂停，不执行）",
    auto: true,
  };
}
function goalDefinitionIntent(
  ctx: ExtensionContext,
  selected: WorkOwnerKey,
  view: AcceptanceJournalView | undefined,
): BareIntent | undefined {
  if (getBoardRef().finalAcceptanceTaskId) return;
  const journal = inspectRestorableSession(ctx, true);
  if (!journal) return;
  const proposal = contractProposalViews(journal)
    .filter(
      (item) =>
        item.data.target.kind === "goal" &&
        journalDigest(item.data.target.owner) === journalDigest(selected),
    )
    .at(-1);
  if (
    !proposal ||
    view?.contractReviews.some((item) => item.control.data.proposalRef.entryId === proposal.entryId)
  )
    return;
  return {
    kind: "contract-definition",
    id: proposal.data.proposalId,
    parent: parent(ctx, "contract-definition", selected),
    label: "审核当前 owner 的具体定义（不恢复、不执行）",
    auto: true,
  };
}
function scopeIntent(
  ctx: ExtensionContext,
  selected: WorkOwnerKey,
  view: AcceptanceJournalView | undefined,
): BareIntent | undefined {
  const proposal = view?.scopeProposals
    ?.filter((item) => journalDigest(item.data.owner) === journalDigest(selected))
    .at(-1);
  if (
    !proposal ||
    view?.scopeReviews?.some((item) => item.control.data.proposalRef.entryId === proposal.entryId)
  )
    return;
  return {
    kind: "scope-review",
    id: proposal.data.proposalId,
    parent: parent(ctx, "scope-review", [
      proposal.data.previousContractRef,
      proposal.data.previousRevisionRef,
    ]),
    label: "审核原范围修订（不采用、不恢复）",
    auto: true,
  };
}
function recoveryIntent(ctx: ExtensionContext): BareIntent | undefined {
  const board = getBoardRef();
  if (recoveryBlocked(ctx) || board.workflowStatus === "completed") return;
  const supervisor = supervisorState(),
    facts = flowFacts(ctx);
  if (board.workflowStatus === "paused" && !resumeControlIssue(board, supervisor, facts))
    return {
      kind: "resume-board",
      id: String(board.generation),
      parent: parent(ctx, "resume-board", [board.generation, supervisor?.holdCause]),
      label:
        supervisor && !ordinaryResumeIssue(board, supervisor, facts)
          ? "确认恢复看板与普通人工暂停（预算不变）"
          : "仅恢复看板（Supervisor 的独立 hold 不变）",
      auto: false,
    };
  if (
    !supervisor ||
    !["paused", "fault"].includes(supervisor.status) ||
    ["paused", "waiting_for_decision"].includes(board.workflowStatus) ||
    facts.budget?.status !== "available"
  )
    return;
  return {
    kind: "recover-supervisor",
    id: journalDigest(supervisor),
    parent: parent(ctx, "recover-supervisor", [supervisor.epoch, supervisor.holdCause]),
    label: "尝试原 Supervisor recover（仍须原全部检查）",
    auto: false,
  };
}
function boardIntent(ctx: ExtensionContext): BareIntent | undefined {
  const board = getBoardRef(),
    decision = board.decision;
  if (board.workflowStatus !== "waiting_for_decision" || !decision?.spec || decision.response)
    return;
  return {
    kind: "board-decision",
    id: decision.id,
    parent: parent(ctx, "board-decision", decision.id),
    label: "回应原业务选择或信息问题（不扩权）",
    auto: false,
  };
}
function materialIntents(ctx: ExtensionContext, values: BareIntent[]): Intent[] {
  const stamp = humanStateStamp(ctx),
    journal = inspectRestorableSession(ctx, true);
  const proposals = journal ? contractProposalViews(journal) : [];
  const view = currentRuntime().controlJournal?.acceptance;
  return values.map((item) => ({
    ...item,
    material: journalDigest([
      stamp,
      item.kind,
      item.id,
      proposals.find((proposal) => proposal.data.proposalId === item.id),
      view?.scopeProposals?.find((proposal) => proposal.data.proposalId === item.id),
    ]),
  }));
}
/** Original facts only. Each candidate still enters its original material/admission checks. */
function intents(ctx: ExtensionContext): Intent[] {
  const runtime = currentRuntime();
  if (runtime.journalFault || runtime.preflightRepair || runtime.boardRepair) return [];
  const mode = captureManagementSnapshot(ctx);
  if (mode.mode === "off") return [];
  const values: BareIntent[] = [];
  const board = boardIntent(ctx);
  if (board) values.push(board);
  if (mode.mode === "supervised") {
    const preflight = preflightIntent(ctx);
    if (preflight) values.push(preflight);
    const selected = currentWorkOwner(ctx.sessionManager.getSessionId()),
      view = readControlJournal(ctx).acceptance;
    if (selected?.kind === "goal") {
      const definition =
        preflight?.kind === "contract-definition"
          ? undefined
          : goalDefinitionIntent(ctx, selected, view);
      if (definition) values.push(definition);
      const scope = scopeIntent(ctx, selected, view);
      if (scope) values.push(scope);
    }
  }
  const recovery = recoveryIntent(ctx);
  if (recovery) values.push(recovery);
  return materialIntents(ctx, values);
}

/** Incomplete old preparations are historical too; restoring never reopens a question. */
export function seedIdleHuman(ctx: ExtensionContext): void {
  if (!idleHumanSupported(ctx)) return;
  const s = state();
  s.handle?.cancel();
  s.handle = undefined;
  s.delivery = undefined;
  s.deferredTools = undefined;
  try {
    for (const intent of intents(ctx)) mute(s, intent.parent);
  } catch {
    /* Unknown source is diagnostic only. */
  }
}
export function cancelIdleHuman(): void {
  states.get(currentRuntime())?.handle?.cancel();
  states.delete(currentRuntime());
}
function physicalRef(ctx: ExtensionContext, id: string): Ref {
  const node = inspectRestorableSession(ctx, true)?.nodes.get(id);
  if (!node) throw new Error("Saved control has no original physical source");
  return { entryId: node.id, digest: node.digest };
}
function recoveryScope(ctx: ExtensionContext) {
  const source = currentScopeState(ctx),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  return {
    currentAdoptedRef: supervisorState()?.scopeRevisionRef,
    currentContract: owner ? selectedAcceptanceContract(source.view, owner) : undefined,
    latestRevision: source.revision,
    recoveryRequired: Boolean(
      source.revision && !sameScopeRef(source.revision, supervisorState()?.scopeRevisionRef),
    ),
    proposal:
      source.view && source.revision
        ? scopeProposalFor(source.view, source.revision.data.proposalRef)
        : undefined,
  };
}
function recoverySupervisor() {
  const state = supervisorState();
  if (!state) return "本次 task-board 上下文没有 Supervisor，其他 Goal 不属于本次操作";
  return {
    status: state.status,
    holdCause: state.holdCause,
    reason: state.reason,
    reviews: state.reviews,
    continuations: state.continuations,
    tokens: state.tokens,
    cost: state.cost,
    stagnant: state.stagnant,
    pending: state.pending,
    externalWait: state.externalWait,
  };
}
function recoveryFacts(run: ControlRun) {
  const { ctx, step } = run,
    runtime = currentRuntime(),
    management = captureManagementSnapshot(ctx),
    board = getBoardRef(),
    state = supervisorState(),
    owner = management.activeWorkOwner;
  if (!owner) throw new Error("Recovery owner is unavailable");
  const effect =
    step.kind === "recover-supervisor"
      ? "原 Supervisor recover：仍执行原检查；若下列 scope.recoveryRequired=true，将采用所列原 revision/proposal；可能重置原 stagnant，不退还已用预算"
      : !state
        ? "恢复当前 task-only 看板：不改变其他 Goal；仅在原任务可执行且最终资格通过时唯一派发 Main"
        : !ordinaryResumeIssue(board, state, flowFacts(ctx))
          ? "联合解除普通 user_pause：恢复看板与当前 Supervisor；仍须最终资格才可派发"
          : "仅恢复看板：不改变任何独立 Supervisor hold，不采用 scope，不派发 Main";
  return {
    恢复控制材料: step.label,
    本次精确效果: effect,
    sessionId: ctx.sessionManager.getSessionId(),
    owner,
    management: {
      mode: management.mode,
      state: management.state,
      source: management.source,
      record: management.record,
    },
    board: {
      generation: board.generation,
      digest: journalDigest(board),
      status: board.workflowStatus,
      pauseReason: board.pauseReason,
    },
    Supervisor: recoverySupervisor(),
    scope: recoveryScope(ctx),
    执行结算: executionRegistryFor(owner).map((entry) => ({
      binding: entry.binding,
      boundSnapshot: entry.boundSnapshot,
      settlement: entry.settlement,
      releasedSnapshot: entry.releasedSnapshot,
      resolution: entry.resolution,
    })),
    hostCaptures: runtime.controlJournal?.pendingHostCaptures,
    receiptStore: runtime.receiptStore?.stats,
    始终保留:
      "原权限与 Start、已用 reviews/continuations/tokens/cost；不重放未知执行，不以缺失资料当结算证明",
  };
}
function recoveryStamp(run: ControlRun): string {
  return journalDigest([humanStateStamp(run.ctx), recoveryFacts(run)]);
}
async function confirmRecovery(run: ControlRun): Promise<boolean> {
  const { ctx, lease, step, owner } = run;
  if (recoveryBlocked(ctx)) return false;
  const material = recoveryFacts(run),
    stamp = recoveryStamp(run);
  const current = () =>
    owner.current() &&
    lease.isCurrent() &&
    !lease.signal.aborted &&
    !recoveryBlocked(ctx) &&
    recoveryStamp(run) === stamp;
  const text = redact(
    JSON.stringify(
      material,
      (_key: string, value: unknown) => (value === undefined ? "未提供/未知" : value),
      2,
    ),
    Number.MAX_SAFE_INTEGER,
  );
  const answer = await withNativeUiLock(ctx, async () => {
    if (!(await reviewScope(ctx, text, current, lease.signal)) || !current()) return;
    return ctx.ui.select(
      step.label +
        "\n恢复材料已完整核对（全文已核对）；确认仅作用于上述原材料，不新增权限、Start 或预算。",
      ["稍后", "确认执行这一恢复控制"],
      { signal: lease.signal },
    );
  });
  return answer.status === "done" && answer.value === "确认执行这一恢复控制" && current();
}
async function startControl(run: ControlRun): Promise<boolean> {
  if (captureManagementSnapshot(run.ctx).mode !== "supervised") return false;
  const outcome = await startApprovedPreflight(run.pi, run.ctx, run.step.id, run.lease.signal, {
    deferToolActivation: true,
  });
  if (outcome.confirmed?.kind === "start") {
    run.memo.saved = true;
    run.state.deferredTools = {
      owner: run.owner,
      ref: physicalRef(run.ctx, outcome.confirmed.controlEntryId),
    };
  }
  notify(run.origin, preflightNotice(outcome).message);
  if (outcome.status !== "started" || outcome.projectionPending || outcome.startupPending)
    return false;
  await adoptStartedGoal(run.pi, run.ctx);
  return true;
}
async function permissionControl(run: ControlRun): Promise<boolean> {
  const outcome =
    run.step.kind === "preflight-definitions"
      ? await reviewPreflightDefinitions(run.pi, run.ctx, run.lease.signal)
      : await approvePreflight(run.pi, run.ctx, run.step.id, run.step.selection, run.lease.signal);
  notify(run.origin, preflightNotice(outcome).message);
  if (outcome.projectionPending || outcome.status !== "approved" || run.step.kind !== "permissions")
    return false;
  const next = intents(run.ctx).find((item) => item.kind === "first-start");
  if (!next || !run.lease.isCurrent() || !run.owner.current()) return false;
  run.step = next;
  run.memo.kind = next.kind;
  return startControl(run);
}
async function boardControl(run: ControlRun): Promise<boolean> {
  const outcome = await answerBoardDecision(run.pi, run.ctx, run.lease.signal);
  notify(run.origin, boardNotice(outcome).message);
  run.memo.saved = !outcome.projectionPending && ["approved", "answered"].includes(outcome.status);
  return run.memo.saved;
}
async function recoveryControl(run: ControlRun): Promise<boolean> {
  if (!(await confirmRecovery(run))) return false;
  if (run.step.kind === "resume-board") {
    if (resumeBoardControl(run.pi, run.ctx) !== "resumed") return false;
  } else recoverSupervisor(run.pi, run.ctx);
  run.memo.saved = true;
  return true;
}
async function performControl(run: ControlRun): Promise<boolean> {
  switch (run.step.kind) {
    case "permissions":
    case "preflight-definitions":
      return permissionControl(run);
    case "first-start":
      return startControl(run);
    case "board-decision":
      return boardControl(run);
    case "resume-board":
    case "recover-supervisor":
      return recoveryControl(run);
    case "contract-definition": {
      const result = await reviewAcceptanceContractNow(run.pi, run.ctx, run.step.id);
      notify(run.origin, `具体定义：${result.status}；原权限、Start、暂停和用量不变，不派发。`);
      return false;
    }
    case "scope-review": {
      const result = await reviewScopeRevisionNow(run.pi, run.ctx, run.step.id);
      notify(run.origin, `范围元数据：${result.status}；不采用、不恢复、不派发，原用量不变。`);
      return false;
    }
  }
}
function validateDelivery(
  run: ControlRun,
  candidate: NonNullable<ReturnType<typeof continuationCandidate>>,
): boolean {
  if (
    !run.owner.current() ||
    !run.lease.isCurrent() ||
    humanStateStamp(run.ctx) !== run.memo.after ||
    !candidate.current()
  )
    return false;
  requireCurrentEvidenceCapability(run.pi, run.ctx);
  if (run.step.kind === "first-start") {
    const pref = currentRuntime().preflight;
    if (!pref) return false;
    assertPreflightStartMaterial(run.ctx, pref);
  }
  return (
    run.owner.current() &&
    run.lease.isCurrent() &&
    humanStateStamp(run.ctx) === run.memo.after &&
    candidate.current()
  );
}
async function dispatchControl(run: ControlRun): Promise<void> {
  refreshUI(run.ctx);
  if (!run.owner.current()) return;
  const candidate = continuationCandidate(run.ctx);
  if (!run.lease.isCurrent() || !candidate) {
    if (run.memo.saved && (!run.lease.isCurrent() || run.step.kind === "first-start"))
      retainHumanDelivery(run.pi, run.ctx, run.owner.current, {
        status: "cancelled",
        actionId: run.memo.attemptId,
        reason: "validation",
      });
    return;
  }
  run.memo.after = humanStateStamp(run.ctx);
  const raw = await run.lease.dispatch(
    candidate.message,
    bindRuntimeCallback(() => validateDelivery(run, candidate)),
  );
  const delivery = idleOutcome(raw, run.memo.attemptId, run.owner.sessionId);
  if (delivery.status === "started") run.memo.started = delivery;
  else if (run.memo.saved) retainHumanDelivery(run.pi, run.ctx, run.owner.current, delivery);
}
async function chooseIntent(
  origin: "automatic" | "shortcut",
  eligible: Intent[],
  ctx: ExtensionContext,
  lease: IdleActionLease,
): Promise<Intent | undefined> {
  if (origin === "automatic" || eligible.length === 1) return eligible[0];
  const menu = await withNativeUiLock(ctx, () =>
    lease.context.ui.select(
      "待你处理：选择操作后仍须独立原生确认",
      [...eligible.map((item) => item.label), "稍后"],
      { signal: lease.signal },
    ),
  );
  return menu.status === "done" ? eligible.find((item) => item.label === menu.value) : undefined;
}
function controlFailed(run: ControlRun, error: unknown): void {
  if (run.memo.saved && !run.memo.started) {
    try {
      retainHumanDelivery(run.pi, run.ctx, run.owner.current, {
        status: "unknown",
        actionId: run.memo.attemptId,
      });
    } catch {
      /* Original journal/hold errors retain precedence. */
    }
  }
  notify(
    run.origin,
    `本次原生控制未完成：${redact(error instanceof Error ? error.message : "控制来源需检查")}. 不重放批准、Start 或工作。`,
    "warning",
  );
}
async function runInteraction(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  origin: "automatic" | "shortcut",
  eligible: Intent[],
  lease: IdleActionLease,
  source: Owner,
  s: HumanUiState,
  memo: Delivery,
): Promise<void> {
  let running: ControlRun | undefined;
  const control = idleControlContext(ctx, lease, () => {
    const step = running?.step ?? eligible[0];
    if (step) mute(s, step.parent);
  });
  const adapter = idleControlApi(pi, ctx);
  try {
    if (!source.current() || !lease.isCurrent()) return;
    const step = await chooseIntent(origin, eligible, control, lease);
    if (!step) return;
    const current = intents(control).find(
      (item) =>
        item.kind === step.kind &&
        item.id === step.id &&
        item.parent === step.parent &&
        item.material === step.material,
    );
    if (!current || !source.current() || !lease.isCurrent()) return;
    memo.kind = step.kind;
    running = {
      origin: ctx,
      ctx: control,
      pi: adapter,
      lease,
      owner: source,
      state: s,
      memo,
      step,
    };
    if (await performControl(running)) await dispatchControl(running);
  } catch (error) {
    if (running) controlFailed(running, error);
    else notify(ctx, "原控制来源已改变；没有保存新回应或补派。", "warning");
  } finally {
    if (s.delivery === memo && !memo.started) s.delivery = undefined;
  }
}
function observeOutcome(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  s: HumanUiState,
  memo: Delivery,
  handle: IdleActionHandle,
  raw: unknown,
): void {
  const result = idleOutcome(raw, memo.attemptId, memo.owner.sessionId);
  if (s.handle === handle) s.handle = undefined;
  if (s.delivery === memo) {
    if (result.status === "started") memo.started = result;
    else s.delivery = undefined;
  }
  if (["completed", "started"].includes(result.status)) return;
  if (memo.saved && !memo.started) {
    try {
      retainHumanDelivery(idleControlApi(pi, ctx), ctx, memo.owner.current, result);
    } catch {
      /* Keep the original fault. */
    }
  }
  notify(ctx, `宿主交互：${result.status}；原记录保留，不自动补派或再次收取 Start。`);
}
export async function requestIdleHuman(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  origin: "automatic" | "shortcut",
): Promise<boolean> {
  if (!idleHumanSupported(ctx)) return false;
  const api = getIdleActions(ctx);
  if (!api) return false;
  const s = state(),
    initial = intents(ctx);
  const eligible =
    origin === "automatic"
      ? initial.filter((item) => item.auto && !s.muted.has(item.parent) && s.muted.size < 4096)
      : initial;
  const first = eligible[0];
  if (!first) return false;
  const host = api.state();
  if (s.handle || (origin === "shortcut" && (host.phase !== "idle" || host.pendingInputs !== 0))) {
    notify(ctx, "请等待当前工作、队列或确认结束；不会中断 Main 或补开旧问题。");
    return true;
  }
  const source = owner(ctx);
  if (!source) return false;
  const attemptId = randomUUID(),
    memo: Delivery = { attemptId, owner: source, kind: first.kind, saved: false };
  s.delivery = memo;
  const handle = api.request({
    id: attemptId,
    binding: journalDigest([
      source.key,
      eligible.map((item) => [item.kind, item.id, item.parent, item.material]),
    ]),
    isCurrent: bindRuntimeCallback(() => source.current()),
    run: bindRuntimeCallback((lease) =>
      runInteraction(pi, ctx, origin, eligible, lease, source, s, memo),
    ),
  });
  s.handle = handle;
  const onOutcome = bindRuntimeCallback((raw: unknown) => {
    observeOutcome(pi, ctx, s, memo, handle, raw);
  });
  const settled = handle.result.then(onOutcome, () => {
    onOutcome(undefined);
  });
  if (origin === "shortcut") await settled;
  return true;
}
function continuationTrigger(event: unknown): boolean {
  if (
    !event ||
    typeof event !== "object" ||
    !("messageType" in event) ||
    event.messageType !== "custom" ||
    !("message" in event)
  )
    return false;
  const message = event.message;
  return (
    !!message &&
    typeof message === "object" &&
    "customType" in message &&
    message.customType === "continuous-tasks:continue"
  );
}
function originalStartRef(ctx: ExtensionContext): Ref | undefined {
  const pref = currentRuntime().preflight,
    supervisor = supervisorState();
  if (
    !pref?.started ||
    pref.version !== 2 ||
    !pref.startRequest ||
    !("controlEntryId" in pref.started)
  )
    return;
  if (
    !supervisor?.preflightBinding ||
    supervisor.status !== "active" ||
    currentRuntime().journalFault ||
    currentRuntime().preflightRepair
  )
    return;
  if (
    captureManagementSnapshot(ctx).mode !== "supervised" ||
    preflightAuthorizationIssue(ctx, supervisor.preflightBinding)
  )
    return;
  const proof = inspectConfirmedPreflightProjection(ctx, pref.startRequest.id);
  if (proof.proof.control.id !== pref.started.controlEntryId) return;
  return { entryId: proof.proof.control.id, digest: proof.proof.control.digest };
}
/** A trigger DTO never creates the deferred projection or grants tool/business permission. */
export function reconcileHumanContinuationTools(
  pi: ExtensionAPI,
  event: unknown,
  ctx: ExtensionContext,
): void {
  const s = states.get(currentRuntime());
  if (!s) return;
  const pending = s.deferredTools;
  if (
    !pending ||
    !idleHumanSupported(ctx) ||
    !pending.owner.current() ||
    !continuationTrigger(event)
  )
    return;
  try {
    const actual = originalStartRef(ctx);
    if (actual?.entryId !== pending.ref.entryId || actual.digest !== pending.ref.digest) return;
    reconcileActiveTools(pi, isSessionScopeEnabled());
    s.deferredTools = undefined;
  } catch {
    pending.prepareFailure = true;
    if (s.delivery) s.delivery.prepareFailure = true;
    ctx.abort();
  }
}
export function humanKernelStarted(): void {
  const s = states.get(currentRuntime());
  if (s?.delivery && !s.delivery.prepareFailure) s.delivery = undefined;
}
function failedOwner(s: HumanUiState, event: unknown): Owner | undefined {
  if (s.delivery?.prepareFailure) return s.delivery.owner;
  if (s.deferredTools?.prepareFailure) return s.deferredTools.owner;
  if (!s.delivery || !event || typeof event !== "object" || !("idleActionFailure" in event)) return;
  const result = idleOutcome(
    event.idleActionFailure,
    s.delivery.attemptId,
    s.delivery.owner.sessionId,
  );
  return result.status === "started" ? s.delivery.owner : undefined;
}
export function settleHumanDeliveryFailure(
  pi: ExtensionAPI,
  event: unknown,
  ctx: ExtensionContext,
): boolean {
  const s = states.get(currentRuntime());
  if (!s) return false;
  const source = failedOwner(s, event);
  if (!source?.current()) return false;
  retainHumanDelivery(pi, ctx, source.current, { status: "prepare_failed" });
  s.delivery = undefined;
  if (s.deferredTools) s.deferredTools.prepareFailure = undefined;
  return true;
}
