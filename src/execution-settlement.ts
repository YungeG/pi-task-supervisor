import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { type Static } from "typebox";
import { Check } from "typebox/value";
import { ExecutionResolutionParams } from "./schemas";
import { RECEIPT_LEDGER_ENTRY } from "./receipt-store";
import {
  appendControlFact,
  appendControlFence,
  assertLease,
  executionPersistenceIssue,
  executionActivityIssue,
  isExecutionRepairRequest,
  captureControlLease,
  currentWorkOwner,
  ownerSession,
  executionOwnerSnapshot,
  readControlJournal,
  type ControlLease,
  type ExecutionBindingFact,
  type ExecutionRegistryEntry,
  type ExecutionFactView,
  type ExecutionObservedFact,
  type ExecutionSettledFact,
  type ExecutionResolutionFact,
  type BoardRunSeedFact,
  type WorkOwnerKey,
} from "./control-journal";
import { inspectRestorableSession } from "./human-control";
import { currentRuntime } from "./runtime";
import { activeGoalContext } from "./management-policy";
import { isSessionScopeEnabled } from "./scope";
import { CUSTOM_SNAPSHOT_TYPE, type TaskBoardSnapshot, type ExecutionRef } from "./types";
import {
  queryExecutionTarget,
  type ExecutionIdentity,
  type ExecutionOwnerQuery,
} from "./async-execution";
import { journalDigest } from "./human-journal";

/** Exact existing metadata only; never admission to launch another writer. */
export function existingExecutionMetadata(
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (isExecutionRepairRequest(toolName, input, owner)) return true;
  if (
    toolName !== "workflow_gate" ||
    input.action !== "clear_execution" ||
    input.executionRef === undefined ||
    !owner
  )
    return false;
  return (currentRuntime().controlJournal?.executionRegistry ?? []).some(
    (entry) =>
      journalDigest(entry.binding.data.owner) === journalDigest(owner) &&
      entry.binding.data.taskId === input.taskId &&
      journalDigest(entry.binding.data.executionRef) === journalDigest(input.executionRef) &&
      !entry.releasedSnapshot,
  );
}

export type ExecutionGeneration =
  | { kind: "runner"; runnerProcessInstanceId: string }
  | { kind: "workflow"; parentToolCallId: string };
export interface ExecutionObservationV1 {
  outcome: "active" | "unknown" | "success" | "failure" | "cancelled";
  reason: string;
  requestId: string;
  observedAt: number;
  snapshotDigest: string;
  snapshotGeneratedAt: number;
  rootState: string;
  subtreeDigest: string;
  writerEvidence: "observed" | "not-applicable" | "unknown";
  generation?: ExecutionGeneration;
  proofDigest?: string;
}
export type SettlementDecision = ExecutionObservationV1;
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function safeTime(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Date.now() + 10000
  );
}
function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
function treeStates(
  root: Record<string, unknown>,
): { states: string[]; nestedWriter: boolean } | undefined {
  const states: string[] = [];
  let nestedWriter = false;
  function visit(raw: unknown, depth: number): boolean {
    const node = object(raw);
    if (
      !node ||
      depth > 4 ||
      states.length >= 512 ||
      !boundedId(node.id) ||
      !["subagent", "workflow", "step", "host-step"].includes(String(node.kind))
    )
      return false;
    if (depth && node.kind !== "step") nestedWriter = true;
    if (
      ![
        "queued",
        "running",
        "complete",
        "failed",
        "partial",
        "paused",
        "stopped",
        "rejected",
      ].includes(String(node.state))
    )
      return false;
    states.push(String(node.state));
    const children = node.children ?? [];
    return (
      Array.isArray(children) &&
      children.length <= 32 &&
      children.every((child) => visit(child, depth + 1))
    );
  }
  return visit(root, 0) ? { states, nestedWriter } : undefined;
}
function runnerGeneration(raw: unknown, runId: string): ExecutionGeneration | undefined {
  const proof = object(raw);
  return proof?.version === 1 && proof.runId === runId && boundedId(proof.runnerProcessInstanceId)
    ? { kind: "runner", runnerProcessInstanceId: proof.runnerProcessInstanceId }
    : undefined;
}
interface RunnerClose {
  processInstanceId: string;
  closeObservedAt: number;
  exitCode: number | null;
  signal: string | null;
}
function validExit(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 255)
  );
}
function validSignal(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^SIG[A-Z0-9]+$/.test(value));
}
function singleRunnerInstance(raw: unknown): RunnerClose | undefined {
  if (!Array.isArray(raw) || raw.length !== 1) return undefined;
  const instance = object(raw[0]);
  if (
    !instance ||
    instance.kind !== "runner" ||
    !boundedId(instance.processInstanceId) ||
    !safeTime(instance.closeObservedAt) ||
    !validExit(instance.exitCode) ||
    !validSignal(instance.signal)
  )
    return undefined;
  return {
    processInstanceId: instance.processInstanceId,
    closeObservedAt: instance.closeObservedAt,
    exitCode: instance.exitCode,
    signal: instance.signal,
  };
}
function runnerClosed(raw: unknown, generation: ExecutionGeneration): RunnerClose | undefined {
  const proof = object(raw);
  if (
    !proof ||
    generation.kind !== "runner" ||
    proof.state !== "observed" ||
    proof.resumeDisposition !== "unavailable" ||
    !safeTime(proof.observedAt)
  )
    return undefined;
  const instance = singleRunnerInstance(proof.instances);
  return instance?.processInstanceId === generation.runnerProcessInstanceId &&
    instance.closeObservedAt === proof.observedAt
    ? instance
    : undefined;
}
interface WriterEvidence {
  generation: ExecutionGeneration;
  successfulExit: boolean;
  proofDigest: string;
}
function writerCapability(query: ExecutionOwnerQuery): boolean {
  const capability = object(object(query.ping.capabilities)?.processTerminalProof);
  return capability?.version === 1 && capability.lifecycleArtifactVersion === 3;
}
function directWriter(
  query: ExecutionOwnerQuery,
  runId: string,
  expected?: ExecutionGeneration,
): WriterEvidence | undefined {
  const details = object(query.data.details);
  const proof = object(details?.lifecycleStatus)?.processTerminal;
  const generation = runnerGeneration(proof, runId);
  if (
    !writerCapability(query) ||
    details?.runId !== runId ||
    !expected ||
    !generation ||
    journalDigest(generation) !== journalDigest(expected)
  )
    return undefined;
  const instance = runnerClosed(proof, generation);
  return instance
    ? {
        generation,
        successfulExit: instance.exitCode === 0 && instance.signal === null,
        proofDigest: journalDigest(proof),
      }
    : undefined;
}
function workflowGeneration(details: unknown, runId: string): ExecutionGeneration | undefined {
  const source = object(details);
  const inventory = object(source?.workflowChildren);
  return source?.runId === runId &&
    inventory?.version === 1 &&
    inventory.workflowRunId === runId &&
    boundedId(inventory.parentToolCallId)
    ? { kind: "workflow", parentToolCallId: inventory.parentToolCallId }
    : undefined;
}
function closedWorkflowDispatch(raw: unknown, runId: string): Record<string, unknown> | undefined {
  const proof = object(raw);
  return proof?.version === 1 &&
    proof.kind === "workflow" &&
    proof.runId === runId &&
    proof.state === "observed" &&
    proof.dispatchClosed === true &&
    safeTime(proof.observedAt)
    ? proof
    : undefined;
}
interface WorkflowTables {
  children: readonly unknown[];
  proofs: ReadonlyMap<unknown, unknown>;
  steps: ReadonlyMap<unknown, Record<string, unknown> | undefined>;
}
function workflowTables(
  inventory: Record<string, unknown>,
  proof: Record<string, unknown>,
  root: Record<string, unknown>,
): WorkflowTables | undefined {
  const children = inventory.children,
    proofs = proof.children,
    steps = root.children;
  if (
    !Array.isArray(children) ||
    children.length < 1 ||
    children.length > 32 ||
    !Array.isArray(proofs) ||
    !Array.isArray(steps)
  )
    return undefined;
  if (proofs.length !== children.length || steps.length !== children.length) return undefined;
  const proofMap = new Map(proofs.map((value: unknown) => [object(value)?.runId, value] as const));
  const stepMap = new Map(
    steps.map((value: unknown) => [object(value)?.id, object(value)] as const),
  );
  return proofMap.size === children.length && stepMap.size === children.length
    ? { children, proofs: proofMap, steps: stepMap }
    : undefined;
}
interface WorkflowChild {
  runId: string;
  childId: string;
  expectedState: string;
}
function workflowChild(raw: unknown): WorkflowChild | undefined {
  const child = object(raw);
  if (!child || !boundedId(child.runId) || !boundedId(child.childId)) return undefined;
  const states: Record<string, string> = {
    completed: "complete",
    failed: "failed",
    stopped: "stopped",
    cancelled: "stopped",
    rejected: "rejected",
  };
  const expectedState = states[String(child.state)];
  return expectedState ? { runId: child.runId, childId: child.childId, expectedState } : undefined;
}
function workflowChildClose(
  child: WorkflowChild,
  tables: WorkflowTables,
  observedAt: number,
): RunnerClose | undefined {
  const step = tables.steps.get(child.childId);
  if (step?.kind !== "step" || step.state !== child.expectedState) return undefined;
  const proof = tables.proofs.get(child.runId);
  const generation = runnerGeneration(proof, child.runId);
  const instance = generation ? runnerClosed(proof, generation) : undefined;
  return instance && instance.closeObservedAt <= observedAt ? instance : undefined;
}
function workflowChildren(
  inventory: Record<string, unknown>,
  proof: Record<string, unknown>,
  root: Record<string, unknown>,
): boolean | undefined {
  const tables = workflowTables(inventory, proof, root);
  if (!tables) return undefined;
  const ids = new Set<string>(),
    keys = new Set<string>();
  let successfulExit = true;
  for (const raw of tables.children) {
    const child = workflowChild(raw);
    if (!child || ids.has(child.runId) || keys.has(child.childId)) return undefined;
    ids.add(child.runId);
    keys.add(child.childId);
    const instance = workflowChildClose(child, tables, Number(proof.observedAt));
    if (!instance) return undefined;
    successfulExit = successfulExit && instance.exitCode === 0 && instance.signal === null;
  }
  return successfulExit;
}
function workflowWriter(
  query: ExecutionOwnerQuery,
  runId: string,
  expected?: ExecutionGeneration,
): WriterEvidence | undefined {
  if (!writerCapability(query)) return undefined;
  const details = object(query.data.details);
  const generation = workflowGeneration(details, runId);
  if (!generation || !expected || journalDigest(generation) !== journalDigest(expected))
    return undefined;
  const inventory = object(details?.workflowChildren);
  const proof = closedWorkflowDispatch(details?.workflowTerminalProof, runId);
  if (
    !inventory ||
    inventory.inventoryComplete !== true ||
    !["completed", "failed", "stopped"].includes(String(inventory.workflowState)) ||
    !proof
  )
    return undefined;
  const successfulExit = workflowChildren(inventory, proof, query.root);
  return successfulExit === undefined
    ? undefined
    : {
        generation,
        successfulExit,
        proofDigest: journalDigest(["workflow-writer-v1", inventory, proof]),
      };
}
function terminalOutcome(states: readonly string[]): ExecutionObservationV1["outcome"] {
  if (states.includes("paused")) return "unknown";
  if (states.some((state) => ["failed", "partial", "rejected"].includes(state))) return "failure";
  return states.includes("stopped") ? "cancelled" : "success";
}
function observation(query: ExecutionOwnerQuery): ExecutionObservationV1 {
  return {
    outcome: "unknown",
    reason: "Execution terminal/writer proof is not qualified; preserve the existing receipt",
    requestId: query.requestId,
    observedAt: query.observedAt,
    snapshotDigest: journalDigest(query.data.asyncSnapshot),
    snapshotGeneratedAt: Number(object(query.data.asyncSnapshot)?.generatedAt),
    rootState: String(query.root.state),
    subtreeDigest: journalDigest(query.root),
    writerEvidence: "unknown",
  };
}
/** A protocol terminal label never substitutes for a same-generation writer observation. */
export async function observeExecutionSettlement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  ref: ExecutionIdentity,
  signal: AbortSignal,
  expectedGeneration?: ExecutionGeneration,
): Promise<SettlementDecision> {
  const query = await queryExecutionTarget(pi, ctx, ref, signal);
  const result = observation(query);
  const proof = object(object(query.data.details)?.lifecycleStatus)?.processTerminal;
  const generation =
    ref.source === "workflow"
      ? workflowGeneration(query.data.details, ref.runId)
      : runnerGeneration(proof, ref.runId);
  if (generation) result.generation = generation;
  const tree = treeStates(query.root);
  if (!tree) return result;
  if (tree.states.some((state) => state === "queued" || state === "running"))
    return {
      ...result,
      outcome: "active",
      reason: "Execution is still active; preserve the existing receipt",
    };
  const outcome = terminalOutcome(tree.states);
  if (outcome === "unknown" || tree.nestedWriter) return result;
  const writer =
    ref.source === "workflow"
      ? workflowWriter(query, ref.runId, expectedGeneration)
      : directWriter(query, ref.runId, expectedGeneration);
  if (!writer) return result;
  if (outcome === "success" && !writer.successfulExit) return result;
  return {
    ...result,
    outcome,
    reason: "Owner-confirmed terminal execution and writer proof",
    writerEvidence: "observed",
    proofDigest: writer.proofDigest,
  };
}

export function executionRegistryFor(owner: WorkOwnerKey): ExecutionRegistryEntry[] {
  const key = journalDigest(owner);
  return (currentRuntime().controlJournal?.executionRegistry ?? []).filter(
    (entry) => journalDigest(entry.binding.data.owner) === key,
  );
}
export function executionAcceptanceIssue(owner: WorkOwnerKey): string | undefined {
  if (
    currentRuntime().executionMemoryBindings?.some(
      (binding) =>
        binding.sessionId === ownerSession(owner) &&
        (binding.owner === null || journalDigest(binding.owner) === journalDigest(owner)),
    )
  )
    return "A legacy memory execution remains unverified; no physical settlement proof";
  for (const entry of executionRegistryFor(owner)) {
    if (!entry.boundSnapshot) return "Execution binding snapshot is not confirmed";
    if (!entry.settlement) return "A registered execution has no trusted terminal settlement";
    if (!entry.releasedSnapshot) return "Execution settlement release snapshot is not confirmed";
    if (entry.settlement.data.outcome !== "success" && !entry.resolution)
      return "A known failed/cancelled execution still requires validated resolution";
  }
  return undefined;
}
function workOwner(ctx: ExtensionContext): WorkOwnerKey {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!owner) throw new Error("Execution registry requires a verified work owner");
  return owner;
}
export function ownerBoardSnapshot(
  ctx: ExtensionContext,
  owner: WorkOwnerKey | null,
  board: Readonly<TaskBoardSnapshot>,
): { entryId: string; digest: string } {
  const journal = inspectRestorableSession(ctx);
  if (!journal) throw new Error("Execution binding requires a physical owner snapshot");
  for (let index = journal.branch.length - 1; index >= 0; index--) {
    const node = journal.branch[index];
    if (node?.customType !== CUSTOM_SNAPSHOT_TYPE) continue;
    const snapshot = executionOwnerSnapshot(node.data, owner);
    if (snapshot && journalDigest(snapshot) === journalDigest(board))
      return { entryId: node.id, digest: node.digest };
  }
  throw new Error("Current execution task board has no verified selected snapshot");
}
function ensureExecutionFeature(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  lease: ControlLease,
): void {
  const view = readControlJournal(ctx);
  if (!view.latestFence?.data.features.includes("execution-settlement-v1"))
    appendControlFence(
      pi,
      ctx,
      [
        ...new Set([
          ...(view.latestFence?.data.features ?? []),
          "execution-settlement-v1" as const,
        ]),
      ],
      lease,
    );
}
export function prepareExecutionOwner(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
): void {
  const runtime = currentRuntime();
  runtime.controlJournal = readControlJournal(ctx);
  if (currentWorkOwner(ctx.sessionManager.getSessionId())) return;
  const activity = executionActivityIssue(ctx.sessionManager.getSessionId());
  if (activity) throw new Error(activity);
  if (activeGoalContext() && (runtime.supervisor || runtime.receiptStore || runtime.goal?.current))
    throw new Error(
      "Legacy Supervisor requires explicit native recovery of its verified receipt/anchor identity before execution registration",
    );
  if (!isSessionScopeEnabled())
    throw new Error("Board execution registration requires explicit session activation");
  const snapshotRef = ownerBoardSnapshot(ctx, null, board);
  const lease = captureControlLease(ctx);
  ensureExecutionFeature(pi, ctx, lease);
  const seed: BoardRunSeedFact = {
    version: 1,
    kind: "board-run-seed",
    recordId: randomUUID(),
    sessionId: lease.sessionId,
    boardRunId: randomUUID(),
    snapshotRef,
    boardDigest: journalDigest(board),
  };
  appendControlFact(pi, ctx, seed);
}
function assertExecutionOperation(
  ctx: ExtensionContext,
  action: string,
  taskId: string,
  executionRef: ExecutionRef,
): void {
  const owner = workOwner(ctx),
    issue = executionPersistenceIssue(owner);
  if (issue && !isExecutionRepairRequest("workflow_gate", { action, taskId, executionRef }, owner))
    throw new Error(issue);
}
export async function recordExecutionBinding(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  boundBoard: TaskBoardSnapshot,
  taskId: string,
  ref: ExecutionRef,
  signal: AbortSignal,
  imported = false,
): Promise<ControlLease> {
  assertExecutionNotAborted(signal);
  prepareExecutionOwner(pi, ctx, board);
  const lease = captureControlLease(ctx);
  const owner = workOwner(ctx);
  currentRuntime().controlJournal = readControlJournal(ctx);
  assertExecutionOperation(ctx, "bind_execution", taskId, ref);
  const previous = registeredExecution(ctx, taskId, ref);
  if (previous) {
    if (
      !previous.boundSnapshot &&
      previous.binding.data.beforeBoardDigest === journalDigest(board) &&
      previous.binding.data.boundBoardDigest === journalDigest(boundBoard)
    )
      return lease;
    throw new Error(
      "Existing execution binding must be inspected; no duplicate binding or generation reuse",
    );
  }
  const snapshot = ownerBoardSnapshot(ctx, owner, board);
  const task = board.tasks.find((task) => task.id === taskId);
  if (!task) throw new Error("Execution task disappeared before binding");
  let generation: ExecutionGeneration | undefined;
  try {
    generation = (await observeExecutionSettlement(pi, ctx, { taskId, ...ref }, signal)).generation;
  } catch {
    /* Register the actual reference as unverified; lookup failure never means unstarted. */
  }
  assertLease(ctx, lease);
  if (signal.aborted) throw new Error("Execution binding cancelled before persistence");
  ensureExecutionFeature(pi, ctx, lease);
  const fact: ExecutionBindingFact = {
    version: 1,
    kind: "execution-binding",
    recordId: randomUUID(),
    bindingId: randomUUID(),
    owner,
    taskId,
    executionRef: { ...ref },
    generation: generation ?? null,
    beforeSnapshotRef: snapshot,
    beforeBoardDigest: journalDigest(board),
    boundBoardDigest: journalDigest(boundBoard),
    taskDigest: journalDigest(task),
    imported,
    boundAt: Date.now(),
  };
  appendControlFact(pi, ctx, fact);
  return captureControlLease(ctx);
}
export function registeredExecution(
  ctx: ExtensionContext,
  taskId: string,
  ref: ExecutionRef,
): ExecutionRegistryEntry | undefined {
  const entries = executionRegistryFor(workOwner(ctx));
  return [...entries]
    .reverse()
    .find(
      (entry) =>
        entry.binding.data.taskId === taskId &&
        entry.binding.data.executionRef.source === ref.source &&
        entry.binding.data.executionRef.runId === ref.runId,
    );
}
function assertExecutionNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Execution settlement cancelled before persistence");
}
async function settlementObservation(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  entry: ExecutionRegistryEntry,
  taskId: string,
  ref: ExecutionRef,
  signal: AbortSignal,
): Promise<{ record: ExecutionFactView & { data: ExecutionObservedFact }; lease: ControlLease }> {
  const binding = entry.binding.data;
  const confirmed = entry.observation;
  assertExecutionNotAborted(signal);
  if (confirmed) return { record: confirmed, lease: captureControlLease(ctx) };
  const lease = captureControlLease(ctx);
  const observed = await observeExecutionSettlement(
    pi,
    ctx,
    { taskId, ...ref },
    signal,
    binding.generation ?? undefined,
  );
  assertLease(ctx, lease);
  assertExecutionNotAborted(signal);
  if (observed.outcome === "active" || observed.outcome === "unknown")
    throw new Error(observed.reason);
  const data: ExecutionObservedFact = {
    version: 1,
    kind: "execution-observation",
    recordId: randomUUID(),
    owner: binding.owner,
    bindingId: binding.bindingId,
    bindingRef: { entryId: entry.binding.entryId, digest: entry.binding.digest },
    observation: observed,
  };
  const receipt = appendControlFact(pi, ctx, data, lease);
  return {
    record: { entryId: receipt.entryId, digest: receipt.digest, data },
    lease: captureControlLease(ctx),
  };
}
export async function recordExecutionSettlement(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  releasedBoard: TaskBoardSnapshot,
  taskId: string,
  ref: ExecutionRef,
  signal: AbortSignal,
): Promise<ControlLease> {
  assertExecutionNotAborted(signal);
  prepareExecutionOwner(pi, ctx, board);
  currentRuntime().controlJournal = readControlJournal(ctx);
  assertExecutionOperation(ctx, "clear_execution", taskId, ref);
  let entry = registeredExecution(ctx, taskId, ref);
  if (!entry) {
    const importedLease = await recordExecutionBinding(
      pi,
      ctx,
      board,
      { ...board },
      taskId,
      ref,
      signal,
      true,
    );
    assertLease(ctx, importedLease);
    entry = registeredExecution(ctx, taskId, ref);
  }
  if (!entry?.boundSnapshot)
    throw new Error("Execution binding needs explicit snapshot repair before settlement");
  if (entry.settlement) {
    if (entry.settlement.data.releasedBoardDigest !== journalDigest(releasedBoard))
      throw new Error(
        "Execution settlement requires its original derived snapshot; no requery/replay",
      );
    return captureControlLease(ctx);
  }
  const binding = entry.binding.data;
  const handoff = await settlementObservation(pi, ctx, entry, taskId, ref, signal);
  assertLease(ctx, handoff.lease);
  const observedEntry = handoff.record;
  const observed = observedEntry.data.observation;
  if (observed.outcome === "active" || observed.outcome === "unknown")
    throw new Error("Confirmed execution observation is not terminal");
  const settlement: ExecutionSettledFact = {
    version: 1,
    kind: "execution-settlement",
    recordId: randomUUID(),
    settlementId: randomUUID(),
    owner: binding.owner,
    bindingId: binding.bindingId,
    observationRef: { entryId: observedEntry.entryId, digest: observedEntry.digest },
    outcome: observed.outcome,
    beforeBoardDigest: journalDigest(board),
    releasedBoardDigest: journalDigest(releasedBoard),
    settledAt: Date.now(),
  };
  appendControlFact(pi, ctx, settlement, handoff.lease);
  return captureControlLease(ctx);
}
export type ExecutionResolutionRequest = Static<typeof ExecutionResolutionParams>;
export function nativeValidationSources(
  ctx: ExtensionContext,
  owner: WorkOwnerKey,
  refs: readonly string[],
): ExecutionResolutionFact["validationSources"] {
  const journal = inspectRestorableSession(ctx);
  if (!journal || owner.kind !== "goal")
    throw new Error("Resolution requires fresh native owner validation records");
  const starts = new Map<string, { entryId: string; digest: string }>(),
    results = new Map<string, { entryId: string; digest: string }>();
  for (const node of journal.branch) {
    const data = node.receiptProof;
    if (
      node.customType !== RECEIPT_LEDGER_ENTRY ||
      !data ||
      data.sessionId !== owner.goal.sessionId ||
      data.goalId !== owner.goal.goalKey
    )
      continue;
    if (data.kind === "intent")
      starts.set(data.captureId, { entryId: node.id, digest: node.digest });
    if (data.kind === "receipt")
      results.set(data.captureId, { entryId: node.id, digest: node.digest });
  }
  return refs.map((id) => {
    const intentRef = starts.get(id),
      receiptRef = results.get(id);
    if (!intentRef || !receiptRef)
      throw new Error(
        "Resolution needs a new normal host validation with a native intent/result pair",
      );
    return { intentRef, receiptRef };
  });
}
function sameResolutionInput(
  previous: ExecutionResolutionFact,
  input: ExecutionResolutionRequest,
  refs: readonly string[],
): boolean {
  return (
    previous.resolutionKind === input.resolutionKind &&
    previous.supersedingBindingId === input.supersedingBindingId &&
    journalDigest(previous.validationRefs) === journalDigest(refs)
  );
}
function failedSettlement(owner: WorkOwnerKey, taskId: string, settlementId: string) {
  const entry = executionRegistryFor(owner).find(
    (entry) =>
      entry.settlement?.data.settlementId === settlementId && entry.binding.data.taskId === taskId,
  );
  if (!entry?.settlement || entry.settlement.data.outcome === "success" || !entry.releasedSnapshot)
    throw new Error("Resolution needs a trusted failed/cancelled settlement and confirmed release");
  return { ...entry, settlement: entry.settlement };
}
export function recordExecutionResolution(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: Readonly<TaskBoardSnapshot>,
  taskId: string,
  input: ExecutionResolutionRequest,
  verify: (refs: readonly string[]) => void,
): void {
  if (!Check(ExecutionResolutionParams, input))
    throw new Error("Invalid execution resolution request");
  const refs = [...new Set(input.validationRefs)].sort();
  if (refs.length !== input.validationRefs.length)
    throw new Error("Execution resolution validation references must be unique");
  const lease = captureControlLease(ctx),
    owner = workOwner(ctx);
  currentRuntime().controlJournal = readControlJournal(ctx);
  const entry = failedSettlement(owner, taskId, input.settlementId);
  if (entry.resolution) {
    if (!sameResolutionInput(entry.resolution.data, input, refs))
      throw new Error("Conflicting execution resolution; confirmed history is immutable");
    return;
  }
  const pending = executionPersistenceIssue(owner);
  if (pending) throw new Error(pending);
  const task = board.tasks.find((task) => task.id === taskId),
    state = currentRuntime().supervisor;
  if (task?.status !== "reviewing" || task.executionRef || !state || state.status === "stopped")
    throw new Error(
      "Execution resolution needs a current supervised review and no active reference",
    );
  verify(refs);
  const fact: ExecutionResolutionFact = {
    version: 1,
    kind: "execution-resolution",
    recordId: randomUUID(),
    resolutionId: randomUUID(),
    owner,
    bindingId: entry.binding.data.bindingId,
    settlementRef: { entryId: entry.settlement.entryId, digest: entry.settlement.digest },
    resolutionKind: input.resolutionKind,
    validationRefs: refs,
    validationSources: nativeValidationSources(ctx, owner, refs),
    reviewSnapshotRef: ownerBoardSnapshot(ctx, owner, board),
    ...(input.supersedingBindingId ? { supersedingBindingId: input.supersedingBindingId } : {}),
    taskDigest: journalDigest(task),
    mutationEpoch: state.epoch,
    resolvedAt: Date.now(),
  };
  appendControlFact(pi, ctx, fact, lease);
}
export function confirmExecutionSnapshot(
  ctx: ExtensionContext,
  board: TaskBoardSnapshot,
  lease: ControlLease,
): void {
  const entry = ctx.sessionManager.getLeafEntry();
  if (
    !entry ||
    entry.type !== "custom" ||
    entry.customType !== CUSTOM_SNAPSHOT_TYPE ||
    !lease.owner
  )
    throw new Error("Execution task snapshot was not installed");
  assertLease(ctx, lease, entry.id);
  const observed = executionOwnerSnapshot(entry.data, lease.owner);
  if (!observed || journalDigest(observed) !== journalDigest(board))
    throw new Error("Execution task snapshot does not match its derived intent");
  const view = readControlJournal(ctx);
  assertLease(ctx, lease, entry.id);
  currentRuntime().controlJournal = view;
}
