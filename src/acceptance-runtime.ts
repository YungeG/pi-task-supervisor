import type { RestoreJournalRead } from "./restore-journal";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { Check } from "typebox/value";
import {
  requestNativeAnswer,
  requireNativeAnswer,
  isTrustedLocalTui,
  type NativeAnswer,
} from "./human-ui";
import { validDecisionInformation } from "./decision-spec";
import {
  captureInvocationFrame,
  invocationFrameCurrent,
  type InvocationFrame,
} from "./qualified-evidence";
import {
  invocationCallKey,
  invocationOwnerKey,
  SDK_TOOL_ONLY_CAPABILITY,
  type InvocationNodeV1,
} from "./invocation-tree";
import { resolve } from "node:path";
import { currentRuntime } from "./runtime";
import {
  confirmedApprovalDefinitionSource,
  preflightAuthorizationIssue,
  preflightPlanBinding,
  PREFLIGHT_ENTRY,
  type PreflightState,
} from "./preflight";
import { readGoalJournal } from "./goal-journal";
import { appendOwnerSnapshot } from "./goal-scope";
import { getBoardRef } from "./state";
import type { AcceptanceLayers } from "./types";
import {
  inspectRestorableSession,
  captureGoalReadbackFrame,
  publishObservedNativeWitness,
} from "./human-control";
import { journalDigest, type SessionJournal, type GoalReadbackFrame } from "./human-journal";
import {
  readControlJournal,
  currentWorkOwner,
  appendControlFence,
  appendAcceptanceFact,
  appendContractProposal,
  captureControlLease,
  assertLease,
  executionActivityIssue,
  type WorkOwnerKey,
  type ControlJournalView,
} from "./control-journal";
import { checkerInputKey, type ArtifactScope, type ArtifactVersionV1 } from "./artifact-version";
import {
  ensureApprovalWorkflowFence,
  PREFLIGHT_ASSOCIATION_FAULT,
  needsPreflightAssociation,
} from "./approval-bundle";
import { holdSupervisor } from "./supervisor";
import { readableDefinitionReview } from "./human-presentation";
import {
  captureCheckVersion,
  captureCheckDefinitionVersion,
  nativeCheckDescriptor,
  runNativeCheck,
  nativeCheckExecution,
  type NativeCheckExecution,
} from "./check-runner";
import {
  recognizedAcceptanceSuite,
  validateAcceptanceProposal,
  checkerScopeInventory,
  productScopeInputs,
  type AutomaticCheckProposal,
  type AcceptanceProposal,
} from "./acceptance-proposal";
import {
  contractProposalViews,
  proposalForGoal,
  proposalSourceNode,
  proposalTargetKey,
  type ContractProposalRecord,
} from "./acceptance-planning";
import {
  checkContractAcceptance,
  acceptanceLayersFromCache,
  checkResultPassed,
  type CheckResultV1,
  type CheckObservationV1,
  type AcceptanceReference,
} from "./acceptance-contract";
import {
  acceptanceDefinitionDigest,
  assertCapturedApprovalDefinitions,
  acceptanceContractDigest,
  acceptanceGoalSource,
  acceptanceGoalDigest,
  selectedAcceptanceContract,
  acceptanceContractValue,
  validAcceptanceFact,
  CheckResultSchema,
  manualCheckSubject,
  manualCheckObservations,
  contractReviewSubject,
  type ContractReviewControl,
  type ManualCheckBindingV1,
  type AcceptanceCheckStarted,
  type AcceptanceCheckObserved,
  type AcceptanceCheckRun,
  type AcceptanceReviewBound,
  type AcceptanceJournalView,
  type AcceptanceDefinitionFact,
  type AcceptanceBoundFact,
} from "./acceptance-journal";

export function proposeAcceptanceContract(pi: ExtensionAPI, ctx: ExtensionContext, input: unknown) {
  const proposal = validateAcceptanceProposal(input),
    runtime = currentRuntime(),
    sessionId = ctx.sessionManager.getSessionId();
  let journal = inspectRestorableSession(ctx, true);
  if (!journal || runtime.journalFault)
    throw Error("Contract proposal needs its actual current physical source");
  const pref = runtime.preflight,
    owner = currentWorkOwner(sessionId);
  let target: ContractProposalRecord["target"], sourceRef: AcceptanceReference;
  if (
    pref &&
    !pref.started &&
    pref.sessionId === sessionId &&
    !["revoked", "interrupted"].includes(pref.phase)
  ) {
    const source = actualPlanningPreflightSource(pi, ctx, journal, pref);
    const node = source.node;
    journal = source.journal;
    target = { kind: "preflight", preflightId: pref.preflightId };
    sourceRef = { entryId: node.id, digest: node.digest };
  } else {
    if (!owner || owner.kind !== "goal" || runtime.supervisor?.status !== "active")
      throw Error("Contract proposals require the actual current planning or active Goal context");
    target = { kind: "goal", owner };
    sourceRef = ownedGoalSource(journal, owner);
  }
  const data: ContractProposalRecord = {
    version: 1,
    sessionId,
    proposalId: randomUUID(),
    sourceRef,
    target,
    proposal,
  };
  const previous = contractProposalViews(journal).filter(
    (item) => proposalTargetKey(item.data) === proposalTargetKey(data),
  );
  const duplicate = previous.find(
    (item) => journalDigest(item.data.proposal) === journalDigest(proposal),
  );
  if (duplicate)
    return {
      status: "proposed-untrusted" as const,
      proposalId: duplicate.data.proposalId,
      ref: { entryId: duplicate.entryId, digest: duplicate.digest },
    };
  if (previous.length >= 8)
    throw Error("Contract proposal capacity reached; no source history is evicted");
  if (
    proposal.checks.some(
      (check) => check.kind === "automatic" && (check.runtime || check.checkerRoot),
    )
  )
    ensureApprovalWorkflowFence(pi, ctx);
  const result = appendContractProposal(pi, ctx, data);
  return {
    status: "proposed-untrusted" as const,
    proposalId: data.proposalId,
    ref: { entryId: result.entryId, digest: result.digest },
  };
}
/** A newly committed Goal has an actual seed but no standalone preflight row yet.
 * Materialize only that exact verified seed, as metadata, before referencing it.
 * This is not a model-supplied owner, grant, definition or execution fact. */
function assertInitialSeedCurrent(ctx: ExtensionContext, pref: PreflightState): void {
  const actual = readGoalJournal(ctx)?.current;
  const selected = currentRuntime().goal?.current;
  if (
    !actual ||
    !selected ||
    actual.phase !== "planning" ||
    pref.revision !== 0 ||
    pref.phase !== "planning" ||
    pref.proposal ||
    pref.approval ||
    pref.started ||
    journalDigest(actual.scope) !== journalDigest(selected.scope) ||
    journalDigest(actual.preflightSeed) !== journalDigest(pref)
  )
    throw Error("Contract proposal has no actual preflight source");
}
function actualPlanningPreflightSource(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  journal: SessionJournal,
  pref: PreflightState,
) {
  const existing = proposalSourceNode(journal, pref.preflightId);
  if (existing) return { node: existing, journal };
  assertInitialSeedCurrent(ctx, pref);
  const lease = captureControlLease(ctx);
  try {
    const stored = appendOwnerSnapshot(pi, PREFLIGHT_ENTRY, pref);
    const source = inspectRestorableSession(ctx, true);
    const node = source?.branch.at(-1);
    if (
      !source ||
      !node ||
      node.customType !== PREFLIGHT_ENTRY ||
      journalDigest(node.data) !== journalDigest(stored)
    )
      throw Error("The exact Goal preflight seed was not physically mirrored");
    assertLease(ctx, lease, node.id);
    return { node, journal: source };
  } catch (error) {
    currentRuntime().journalFault ??=
      "Goal preflight source projection could not be verified; inspect without replay";
    currentRuntime().cancel();
    throw error;
  }
}
function ownedGoalSource(journal: SessionJournal, owner: WorkOwnerKey): AcceptanceReference {
  if (owner.kind !== "goal")
    throw Error(
      "Acceptance contract needs an actual Goal source; task-only acceptance is unavailable",
    );
  const source = journal.branch.find(
    (node) =>
      node.supervisorProof?.sessionId === owner.goal.sessionId &&
      node.supervisorProof.goalKey === owner.goal.goalKey &&
      (owner.goal.lifecycleCommitId === null ||
        node.supervisorProof.lifecycleCommitId === owner.goal.lifecycleCommitId),
  );
  if (!source) throw Error("Acceptance contract lacks its physical original Goal source");
  return { entryId: source.id, digest: source.digest };
}
export function boundAcceptanceScope(data: AcceptanceBoundFact): ArtifactScope {
  return {
    scopeId: data.header.scopeId,
    owner: data.owner,
    root: data.workspace.root,
    inputs:
      data.checkerScopes === undefined
        ? data.header.inputs
        : productScopeInputs(data.workspace.root, data.header.inputs, data.checkerScopes),
    artifacts: data.header.artifacts,
    environmentKeys: Object.keys(data.header.environment.values).sort(),
    ...(data.checkerScopes !== undefined ? { checkerScopes: data.checkerScopes } : {}),
  };
}
function nativeCheckInput(
  scope: ArtifactScope,
  spec: AutomaticCheckProposal,
  environment: Readonly<Record<string, string>>,
) {
  return {
    scope,
    script: spec.script,
    args: spec.args,
    environment,
    timeoutMs: spec.timeoutMs,
    ...(scope.checkerScopes !== undefined ? { checkId: spec.checkId } : {}),
    ...(spec.runtime ? { runtime: spec.runtime, tests: spec.tests } : {}),
  };
}
/** Extra execution/root capability must already be in the actual native business
 * review. A definition response or recognized-host token cannot grant it. */
function assertOneCheckerPermission(
  check: AutomaticCheckProposal,
  state: PreflightState,
  selectedIds: readonly string[],
  offeredChecks: AcceptanceProposal["checks"],
  productRoot: string,
): void {
  const root = check.checkerRoot ?? productRoot;
  const permission = state.proposal?.permissions.find((item) => item.id === check.permissionId);
  const offered = offeredChecks.some(
    (item) =>
      item.kind === "automatic" &&
      item.permissionId === check.permissionId &&
      item.runtime === check.runtime &&
      (item.checkerRoot ?? productRoot) === root,
  );
  if (
    !permission?.required ||
    permission.target !== root ||
    !selectedIds.includes(permission.id) ||
    !offered
  )
    throw Error(
      `Check ${check.checkId}: exact current root/profile permission is absent; no external bytes were read`,
    );
}
function assertCheckerPermissions(
  ctx: ExtensionContext,
  checks: readonly AcceptanceProposal["checks"][number][],
): void {
  const extended = checks.filter(
    (check): check is AutomaticCheckProposal =>
      check.kind === "automatic" && !!(check.runtime || check.checkerRoot),
  );
  if (!extended.length) return;
  const state = currentRuntime().preflight,
    binding = currentRuntime().supervisor?.preflightBinding;
  if (
    !state ||
    state.version !== 2 ||
    !state.started ||
    !state.approval ||
    !binding ||
    preflightAuthorizationIssue(ctx, binding)
  )
    throw Error(
      "Extended checker reads/execution require current original preflight permission; definition review cannot grant it",
    );
  const journal = inspectRestorableSession(ctx, true),
    node = journal?.nodes.get(state.approval.controlEntryId);
  if (!journal || !node) throw Error("Checker permission has no actual original source");
  const source = confirmedApprovalDefinitionSource(journal, {
    entryId: node.id,
    digest: node.digest,
  });
  for (const check of extended)
    assertOneCheckerPermission(
      check,
      state,
      state.approval.permissionIds,
      source.proposal.data.proposal.checks,
      resolve(ctx.cwd),
    );
}
function makeDefinition(
  owner: WorkOwnerKey,
  sourceRef: AcceptanceReference,
  spec: AcceptanceProposal["checks"][number],
  scope: ArtifactScope,
  environment: Record<string, string>,
  version: ArtifactVersionV1,
): AcceptanceDefinitionFact {
  const checkerWorkspace =
    spec.kind === "automatic"
      ? version.checkerWorkspaces?.find((entry) => entry.checkId === spec.checkId)?.workspace
      : undefined;
  const frozenFiles =
    spec.kind === "automatic"
      ? [...spec.checkerFiles, ...spec.configs].sort().map((path) => {
          const file = version.inputs.find(
            (item) => item.path === (checkerWorkspace ? checkerInputKey(spec.checkId, path) : path),
          );
          if (!file)
            throw Error("Acceptance definition lacks an actual captured checker/config file");
          return { ...file, path };
        })
      : [];
  const invocation =
    spec.kind === "automatic"
      ? {
          ...nativeCheckDescriptor(nativeCheckInput(scope, spec, environment), version),
          nodeVersion: process.version,
          platform: process.platform,
        }
      : null;
  const data = {
    version: 1 as const,
    kind: "acceptance-definition-declared" as const,
    recordId: randomUUID(),
    owner,
    sourceRef,
    spec,
    frozenFiles,
    ...(checkerWorkspace ? { checkerWorkspace } : {}),
    environmentDigest: version.environmentDigest,
    invocation,
  };
  return { ...data, definitionDigest: acceptanceDefinitionDigest(data) };
}
function assertPayload(
  value: AcceptanceDefinitionFact | AcceptanceBoundFact,
  sessionId: string,
): void {
  if (!validAcceptanceFact(value, sessionId))
    throw Error(
      "Acceptance contract record exceeds its native 16KiB/schema capacity; no condition is dropped",
    );
}
function preCompileOwner(
  ctx: ExtensionContext,
  mode: "execution-start" | "native-review" | "association-repair" = "execution-start",
) {
  const runtime = currentRuntime(),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (
    runtime.journalFault ||
    (runtime.supervisor?.status !== "active" &&
      !(mode !== "execution-start" && runtime.supervisor?.status === "paused") &&
      !(mode === "association-repair" && runtime.supervisor?.status === "fault")) ||
    !owner ||
    owner.kind !== "goal" ||
    !!getBoardRef().finalAcceptanceTaskId ||
    getBoardRef().tasks.some((task) => task.status !== "draft")
  )
    throw Error(
      "Acceptance contract host binding requires the actual active owner before first board compilation",
    );
  return owner;
}
/** Trusted host-code registration only. Neither a model proposal nor a copied token is
 * recognition. Actual definitions/sources are captured before first board compilation. */
export function registerHostAcceptanceContract(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  token: unknown,
): AcceptanceReference {
  const recognized = recognizedAcceptanceSuite(token);
  if (!recognized)
    throw Error("Acceptance contract registration requires an actual recognized host token");
  const owner = preCompileOwner(ctx);
  const journal = inspectRestorableSession(ctx, true);
  if (!journal || journal.cwd !== resolve(ctx.cwd))
    throw Error("Acceptance contract needs its actual physical workspace/session");
  const sourceRef = ownedGoalSource(journal, owner),
    goal = acceptanceGoalSource(journal, owner, sourceRef, journal.branch.length);
  if (goal !== recognized.expectedOriginalGoal)
    throw Error("Acceptance contract recognition belongs to another original Goal");
  const view = readControlJournal(ctx);
  if (selectedAcceptanceContract(view.acceptance, owner))
    throw Error(
      "Acceptance contract is already bound; explicit native versioned review is required",
    );
  const prepared = prepareContractBinding(ctx, owner, sourceRef, goal, recognized.proposal);
  return commitContractBinding(pi, ctx, prepared, {
    kind: "recognized-host",
    originalGoalDigest: acceptanceGoalDigest(owner, sourceRef, goal),
  });
}
function assertOriginalConditionOwner(
  pref: Extract<PreflightState, { version: 2 }>,
  original: ReturnType<typeof confirmedApprovalDefinitionSource>,
  owner: WorkOwnerKey,
  goal: string,
): void {
  if (owner.kind !== "goal")
    throw Error("The consolidated condition source belongs to another plan/owner");
  const scoped = original.goalScope;
  if (
    original.control.kind !== "approve" ||
    original.base.preflightId !== pref.preflightId ||
    original.base.planDigest !== pref.planDigest ||
    pref.goal !== goal ||
    (scoped
      ? scoped.goalRunId !== owner.goal.goalRunId ||
        scoped.lifecycleCommitId !== owner.goal.lifecycleCommitId
      : owner.goal.goalRunId !== null)
  )
    throw Error("The consolidated condition source belongs to another plan/owner");
}
function approvedPreflightConditions(owner: WorkOwnerKey, goal: string, journal: SessionJournal) {
  const pref = currentRuntime().preflight;
  if (pref?.version !== 2 || !pref.started || !pref.approval || !pref.proposal?.contractProposalId)
    return undefined;
  const node = journal.nodes.get(pref.approval.controlEntryId);
  if (!node) throw Error("The original consolidated condition source is missing");
  const original = confirmedApprovalDefinitionSource(journal, {
    entryId: node.id,
    digest: node.digest,
  });
  assertOriginalConditionOwner(pref, original, owner, goal);
  return original.proposal.data.proposal;
}
function bindingInventory(
  root: string,
  proposal: AcceptanceProposal,
  previous: ReturnType<typeof selectedAcceptanceContract>,
  approved: AcceptanceProposal | undefined,
) {
  const aware =
    previous?.data.checkerScopes !== undefined ||
    !!approved ||
    !!currentRuntime().preflight?.proposal?.contractProposalId ||
    proposal.checks.some(
      (check) => check.kind === "automatic" && (check.runtime || check.checkerRoot),
    );
  return aware ? checkerScopeInventory(root, proposal.inputs, proposal.checks) : undefined;
}
function assertConditionContinuity(
  root: string,
  proposal: AcceptanceProposal,
  inputs: readonly string[],
  previous: ReturnType<typeof selectedAcceptanceContract>,
  approved: AcceptanceProposal | undefined,
): void {
  const original = previous?.data.header ?? approved;
  if (!original) return;
  const originalInputs = previous
    ? boundAcceptanceScope(previous.data).inputs
    : approved
      ? checkerScopeInventory(root, approved.inputs, approved.checks).inputs
      : undefined;
  if (
    journalDigest([proposal.requirements, proposal.scopeId, inputs, proposal.artifacts]) !==
    journalDigest([original.requirements, original.scopeId, originalInputs, original.artifacts])
  )
    throw Error(
      "Important acceptance conditions/scope changed; create a new Goal/preflight with appropriate authorization",
    );
}
function prepareContractBinding(
  ctx: ExtensionContext,
  owner: WorkOwnerKey,
  sourceRef: AcceptanceReference,
  goal: string,
  proposal: AcceptanceProposal,
) {
  const journal = inspectRestorableSession(ctx, true);
  if (!journal) throw Error("Contract binding requires a physical source");
  const view = readControlJournal(ctx),
    previous = selectedAcceptanceContract(view.acceptance, owner);
  const { checks, ...header } = proposal;
  const approved = previous ? undefined : approvedPreflightConditions(owner, goal, journal);
  const inventory = bindingInventory(resolve(ctx.cwd), proposal, previous, approved);
  assertConditionContinuity(
    resolve(ctx.cwd),
    proposal,
    inventory?.inputs ?? header.inputs,
    previous,
    approved,
  );
  const scope: ArtifactScope = {
    scopeId: header.scopeId,
    owner,
    root: resolve(ctx.cwd),
    inputs: inventory?.inputs ?? header.inputs,
    artifacts: header.artifacts,
    environmentKeys: Object.keys(header.environment.values).sort(),
    ...(inventory ? { checkerScopes: inventory.checkerScopes } : {}),
  };
  assertCheckerPermissions(ctx, checks);
  const capture = captureCheckDefinitionVersion(scope, header.environment.values);
  if (capture.status !== "known")
    throw Error(`Acceptance definition input capture is unknown: ${capture.reason}`);
  const definitions = checks.map((spec) =>
    makeDefinition(owner, sourceRef, spec, scope, header.environment.values, capture.version),
  );
  const base: Omit<AcceptanceBoundFact, "definitions" | "authority" | "contractDigest"> = {
    version: 1 as const,
    kind: "acceptance-contract-bound" as const,
    recordId: randomUUID(),
    owner,
    sourceRef,
    contractId: previous?.data.contractId ?? randomUUID(),
    revision: previous ? previous.data.revision + 1 : 1,
    previousRef: previous ? { entryId: previous.entryId, digest: previous.digest } : null,
    header,
    workspace: capture.version.workspace,
    scopeDigest: capture.version.scopeDigest,
    ...(inventory ? { checkerScopes: inventory.checkerScopes } : {}),
  };
  const placeholders = definitions.map((item) => ({
    checkId: item.spec.checkId,
    ref: { entryId: "x".repeat(200), digest: "a".repeat(64) },
    definitionDigest: item.definitionDigest,
  }));
  for (const definition of definitions) assertPayload(definition, journal.sessionId);
  assertPayload(
    {
      ...base,
      authority: {
        kind: "recognized-host",
        originalGoalDigest: acceptanceGoalDigest(owner, sourceRef, goal),
      },
      definitions: placeholders,
      contractDigest: "a".repeat(64),
    },
    journal.sessionId,
  );
  return { base, definitions, scope, capture, goal };
}
function commitContractBinding(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prepared: ReturnType<typeof prepareContractBinding>,
  authority: AcceptanceBoundFact["authority"],
): AcceptanceReference {
  const { base, definitions } = prepared,
    view = readControlJournal(ctx);
  if (base.checkerScopes !== undefined) ensureApprovalWorkflowFence(pi, ctx);
  else if (!view.latestFence?.data.features.includes("acceptance-contract-v1"))
    appendControlFence(pi, ctx, [
      ...new Set([
        ...(view.latestFence?.data.features ?? []),
        "acceptance-contract-v1" as const,
        "invocation-tree-v1" as const,
      ]),
    ]);
  const references = definitions.map((definition) => ({
    checkId: definition.spec.checkId,
    ref: appendOrReuseDefinition(pi, ctx, definition),
    definitionDigest: definition.definitionDigest,
  }));
  // Keep the wire ref shape exact; append's leafAfter is not part of a reference/hash.
  const refs = references.map((item) => ({
    ...item,
    ref: { entryId: item.ref.entryId, digest: item.ref.digest },
  }));
  const body = { ...base, authority, definitions: refs };
  const result = appendAcceptanceFact(pi, ctx, {
    ...body,
    contractDigest: acceptanceContractDigest(body),
  });
  return { entryId: result.entryId, digest: result.digest };
}
function appendOrReuseDefinition(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  definition: AcceptanceDefinitionFact,
): AcceptanceReference {
  const prior = readControlJournal(ctx).acceptance?.definitions.find(
    (item) => item.data.recordId === definition.recordId,
  );
  if (!prior) return appendAcceptanceFact(pi, ctx, definition);
  if (journalDigest(prior.data) !== journalDigest(definition))
    throw Error("Existing approval definition differs; no metadata replay is allowed");
  return { entryId: prior.entryId, digest: prior.digest };
}
/** Derived binding from one source-verified preflight approval; no new question or dispatch. */
function associationDecisionState(state: Extract<PreflightState, { version: 2 }>) {
  if (
    !state.started ||
    !state.approval ||
    !state.definitionApproval ||
    !state.permissionRequest?.acceptance
  )
    throw Error("Preflight definition association is incomplete; do not repeat Start");
  return {
    approval: state.approval,
    definition: state.definitionApproval,
    capture: state.permissionRequest.acceptance,
  };
}
function associationSources(ctx: ExtensionContext, approvalId: string, definitionId: string) {
  const journal = inspectRestorableSession(ctx, true);
  if (!journal) throw Error("Preflight definition association requires its physical source");
  const permissionNode = journal.nodes.get(approvalId),
    definitionNode = journal.nodes.get(definitionId);
  if (!permissionNode || !definitionNode) throw Error("Preflight confirming source is missing");
  const permissionControlRef = { entryId: permissionNode.id, digest: permissionNode.digest },
    definitionControlRef = { entryId: definitionNode.id, digest: definitionNode.digest };
  const confirmed = confirmedApprovalDefinitionSource(journal, definitionControlRef);
  confirmedApprovalDefinitionSource(journal, permissionControlRef);
  return { journal, permissionControlRef, definitionControlRef, confirmed };
}
export function adoptPreflightAcceptance(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  repair = false,
): AcceptanceReference | undefined {
  const runtime = currentRuntime();
  const state = runtime.preflight;
  if (!state?.proposal?.contractProposalId || state.version !== 2) return undefined;
  const decision = associationDecisionState(state);
  if (decision.capture.pendingChecks.length) return undefined;
  const permissionIssue = preflightAuthorizationIssue(ctx, preflightPlanBinding(state));
  if (permissionIssue) throw Error(permissionIssue);
  const owner = preCompileOwner(ctx, repair ? "association-repair" : "execution-start");
  const { journal, permissionControlRef, definitionControlRef, confirmed } = associationSources(
    ctx,
    decision.approval.controlEntryId,
    decision.definition.controlEntryId,
  );
  const existing = selectedAcceptanceContract(readControlJournal(ctx).acceptance, owner);
  if (existing) return { entryId: existing.entryId, digest: existing.digest };
  try {
    const sourceRef = ownedGoalSource(journal, owner);
    const goal = acceptanceGoalSource(journal, owner, sourceRef, journal.branch.length);
    const prepared = prepareContractBinding(
      ctx,
      owner,
      sourceRef,
      goal,
      confirmed.proposal.data.proposal,
    );
    assertCapturedApprovalDefinitions(prepared.base, prepared.definitions, confirmed);
    const identity = journalDigest([owner, sourceRef, permissionControlRef, definitionControlRef]);
    prepared.base.recordId = `bundle-bound-${identity}`;
    prepared.base.contractId = `bundle-${identity}`;
    for (const definition of prepared.definitions)
      definition.recordId = `bundle-definition-${journalDigest([identity, definition.spec.checkId])}`;
    return commitContractBinding(pi, ctx, prepared, {
      kind: "preflight-reviewed",
      originalGoalDigest: acceptanceGoalDigest(owner, sourceRef, goal),
      permissionControlRef,
      definitionControlRef,
    });
  } catch (error) {
    // A failed derived association precedes dispatch. Keep a resumable technical
    // hold, but never overwrite an existing user pause or another fault.
    if (runtime.supervisor?.status === "active")
      holdSupervisor(
        pi,
        ctx,
        "paused",
        "Confirmed definitions need exact metadata association repair; no Main dispatch",
        "acceptance_pending",
      );
    runtime.journalFault = PREFLIGHT_ASSOCIATION_FAULT;
    runtime.cancel();
    throw error;
  }
}
/** Explicit exact metadata repair only. Never re-asks, starts, resumes, resets
 * counters or dispatches Main. An unrelated fault or unknown execution stays held. */
function assertAssociationRepairIntent(state: PreflightState | undefined): void {
  if (
    !state ||
    state.version !== 2 ||
    !state.started ||
    !state.proposal?.contractProposalId ||
    !state.definitionApproval ||
    state.permissionRequest?.acceptance?.pendingChecks.length
  )
    throw Error("No pending preflight definition association repair");
}
function assertAssociationRepairQuiescence(
  ctx: ExtensionCommandContext,
  view: ControlJournalView,
  owner: WorkOwnerKey | null,
): void {
  const runtime = currentRuntime();
  if (
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    runtime.supervisor?.pending ||
    runtime.receiptStore?.pendingCount
  )
    throw Error("Wait for actual quiescence before metadata association repair");
  const open = [...(view.invocations?.nodes.values() ?? [])].some(
    (node) =>
      owner &&
      invocationOwnerKey(node.owner) === invocationOwnerKey(owner) &&
      (!node.end || !view.invocations?.roots.get(node.rootId)?.sealed),
  );
  const activity = executionActivityIssue(ctx.sessionManager.getSessionId());
  if (open || activity)
    throw Error(
      activity ?? "An invocation remains unclosed/unsealed; metadata repair cannot clear it",
    );
}
export function repairPreflightAcceptance(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  const runtime = currentRuntime(),
    oldFault = runtime.journalFault;
  const state = runtime.preflight;
  assertAssociationRepairIntent(state);
  if (oldFault && oldFault !== PREFLIGHT_ASSOCIATION_FAULT)
    throw Error("Unrelated journal/dispatch uncertainty remains; no association replay");
  const view = readControlJournal(ctx),
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  runtime.controlJournal = view;
  assertAssociationRepairQuiescence(ctx, view, owner);
  const existing = owner && selectedAcceptanceContract(view.acceptance, owner);
  try {
    // Only this exact owned derived-write fault may be masked inside the explicit
    // metadata transaction; every actual original control/source is revalidated.
    runtime.journalFault = undefined;
    if (!existing) adoptPreflightAcceptance(pi, ctx, true);
  } catch (error) {
    runtime.journalFault ??= oldFault ?? PREFLIGHT_ASSOCIATION_FAULT;
    throw error;
  }
}
function ensureContractFence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pausedMetadata = false,
): void {
  const view = readControlJournal(ctx);
  if (
    view.latestFence?.data.features.includes("acceptance-contract-v1") &&
    (!pausedMetadata || view.latestFence.data.features.includes("approval-workflow-v1"))
  )
    return;
  appendControlFence(pi, ctx, [
    ...new Set([
      ...(view.latestFence?.data.features ?? []),
      "acceptance-contract-v1" as const,
      "invocation-tree-v1" as const,
      ...(pausedMetadata ? ["approval-workflow-v1" as const] : []),
    ]),
  ]);
}
function publishNativeContractControl(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  data: ContractReviewControl,
): AcceptanceReference {
  const control = appendAcceptanceFact(pi, ctx, data),
    physical = inspectRestorableSession(ctx, true)?.nodes.get(control.entryId);
  if (!physical) throw Error("Native contract definition control is not physically confirmed");
  try {
    const lease = captureControlLease(ctx);
    publishObservedNativeWitness(pi, ctx, physical, data.frame);
    assertLease(ctx, lease, ctx.sessionManager.getLeafId());
    currentRuntime().controlJournal = readControlJournal(ctx);
  } catch (error) {
    currentRuntime().journalFault ??=
      "Contract definition response has an uncertain physical witness; inspect without replay";
    currentRuntime().cancel();
    throw error;
  }
  return { entryId: control.entryId, digest: control.digest };
}
export async function reviewAcceptanceContract(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  proposalId: string,
) {
  if (!isTrustedLocalTui(ctx)) return { status: "unsupported" as const };
  await ctx.waitForIdle();
  if (
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    executionActivityIssue(ctx.sessionManager.getSessionId())
  )
    throw Error("Contract review requires actual idle and resolved execution/native controls");
  // Explicit native metadata review is legal while the same owner is paused.
  // It never clears a pause, compiles work, or dispatches a continuation.
  const owner = preCompileOwner(ctx, "native-review"),
    journal = inspectRestorableSession(ctx, true);
  if (!journal) throw Error("Contract review requires its actual physical source");
  const proposal = contractProposalViews(journal).find(
    (item) => item.data.proposalId === proposalId,
  );
  if (!proposal) throw Error("Unknown current-session contract proposal");
  const sourceRef = ownedGoalSource(journal, owner),
    goal = acceptanceGoalSource(journal, owner, sourceRef, journal.branch.length);
  proposalForGoal(journal, proposal, owner, sourceRef);
  const prepared = prepareContractBinding(ctx, owner, sourceRef, goal, proposal.data.proposal);
  const subject = contractReviewSubject(
    prepared.base,
    prepared.definitions,
    proposal,
    prepared.capture.version.versionId,
    prepared.capture.inputGeneration,
    goal,
  );
  const presentation = readableDefinitionReview(subject);
  const body = presentation.body;
  if (Buffer.byteLength(body, "utf8") > 64000)
    throw Error("Contract review material exceeds64KB; no condition is dropped");
  ensureContractFence(pi, ctx, currentRuntime().supervisor?.status === "paused");
  const carrier = captureInvocationFrame(ctx, owner);
  const frame = captureGoalReadbackFrame(ctx, randomUUID(), subject, sourceRef.entryId);
  const current = () => {
    if (
      !invocationFrameCurrent(ctx, carrier) ||
      !ctx.isIdle() ||
      ctx.hasPendingMessages() ||
      currentRuntime().journalFault
    )
      return false;
    const selected = selectedAcceptanceContract(readControlJournal(ctx).acceptance, owner),
      prior = prepared.base.previousRef;
    if (
      prior ? selected?.entryId !== prior.entryId || selected.digest !== prior.digest : !!selected
    )
      return false;
    const version = captureCheckDefinitionVersion(
      prepared.scope,
      prepared.base.header.environment.values,
    );
    return (
      version.status === "known" &&
      version.version.versionId === prepared.capture.version.versionId &&
      version.inputGeneration === prepared.capture.inputGeneration
    );
  };
  const answer = await requestNativeAnswer(
    ctx,
    {
      frame,
      kind: "choice",
      purpose: "contract-definition",
      title: presentation.title,
      body,
      options: ["绑定此契约", "不绑定"],
    },
    current,
  );
  if (!answer) return { status: "deferred" as const };
  return finishContractReview(
    pi,
    ctx,
    prepared,
    { entryId: proposal.entryId, digest: proposal.digest },
    frame,
    current,
    answer,
  );
}
function finishContractReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prepared: ReturnType<typeof prepareContractBinding>,
  proposalRef: AcceptanceReference,
  frame: GoalReadbackFrame,
  current: () => boolean,
  answer: NativeAnswer,
) {
  const { owner, sourceRef } = prepared.base,
    goal = prepared.goal;
  const admitted = requireNativeAnswer(ctx, answer, frame);
  if (admitted.outcome !== "answer" || !["绑定此契约", "不绑定"].includes(admitted.value ?? ""))
    throw Error("Business authorization/start responses cannot confirm a contract definition");
  ensureContractFence(pi, ctx);
  const data: ContractReviewControl = {
    version: 1,
    kind: "acceptance-contract-control",
    recordId: randomUUID(),
    owner,
    sourceRef,
    proposalRef,
    contractId: prepared.base.contractId,
    revision: prepared.base.revision,
    frame,
    value: admitted.value as ContractReviewControl["value"],
    versionId: prepared.capture.version.versionId,
    inputGeneration: prepared.capture.inputGeneration,
  };
  const controlRef = publishNativeContractControl(pi, ctx, data);
  if (data.value !== "绑定此契约") return { status: "declined" as const };
  if (!current())
    throw Error(
      "Confirmed contract definition inputs/context changed; do not reconstruct or replay the old review",
    );
  const ref = commitContractBinding(pi, ctx, prepared, {
    kind: "native-reviewed",
    originalGoalDigest: acceptanceGoalDigest(owner, sourceRef, goal),
    controlRef,
  });
  return {
    status: "bound" as const,
    contractId: prepared.base.contractId,
    revision: prepared.base.revision,
    ref,
  };
}
/** Resident display projection only: no manager/source reads, hydration, hashing of files,
 * scope capture, permission adoption or current-applicability claim. */
export function cachedAcceptanceLayers(): AcceptanceLayers {
  return acceptanceLayersFromCache(currentRuntime());
}
export function cachedAcceptanceReviewMaterial(): unknown {
  const runtime = currentRuntime(),
    layers = cachedAcceptanceLayers();
  if (!layers.contractId) return undefined;
  const view = runtime.controlJournal?.acceptance,
    bound = view?.contracts.find(
      (item) =>
        item.data.contractId === layers.contractId && item.data.revision === layers.revision,
    );
  if (!view || !bound) return undefined;
  return {
    layers,
    contractId: bound.data.contractId,
    revision: bound.data.revision,
    digest: bound.data.contractDigest,
    sourceRef: bound.data.sourceRef,
    authority: bound.data.authority,
    requirements: bound.data.header.requirements,
    scope: {
      workspace: bound.data.workspace,
      scopeId: bound.data.header.scopeId,
      inputs: bound.data.header.inputs,
      artifacts: bound.data.header.artifacts,
    },
    environment: bound.data.header.environment,
    checkDefinitions: bound.data.definitions.map((ref) => {
      const definition = view.definitions.find((item) => item.entryId === ref.ref.entryId);
      if (!definition) return { ref, unavailable: true };
      const data = definition.data;
      return {
        ref,
        definitionDigest: data.definitionDigest,
        spec: data.spec,
        environmentDigest: data.environmentDigest,
        checkerFilesDigest: journalDigest(data.frozenFiles),
        actualInvocation: data.invocation
          ? {
              digest: journalDigest(data.invocation),
              executable: data.invocation.executable,
              cwd: data.invocation.cwd,
              nodeVersion: data.invocation.nodeVersion,
              profile: data.invocation.profile?.id ?? "fixed-native-node-permission-check-v1",
            }
          : null,
      };
    }),
    observations: view.runs
      .filter((run) => run.start.data.contractRef.entryId === bound.entryId)
      .slice(-16)
      .map((run) => ({
        startRef: { entryId: run.start.entryId, digest: run.start.digest },
        definitionRef: run.start.data.definitionRef,
        actualCallId: run.start.data.callId,
        observed: run.observed
          ? {
              ref: { entryId: run.observed.entryId, digest: run.observed.digest },
              closed: run.observed.data.closed,
              exitCode: run.observed.data.exitCode,
              termination: run.observed.data.termination,
              outputDigest: run.observed.data.outputDigest,
              versionId: run.observed.data.beforeVersionId,
              inputGeneration: run.observed.data.beforeGeneration,
              result: run.observed.data.result,
            }
          : null,
      })),
    manual: view.manualChecks
      .filter((item) => item.control.data.contractRef.entryId === bound.entryId)
      .slice(-16),
  };
}
/** Live execution barrier. Never inferred from a transient fault or a UI label;
 * source-verified current-owner binding is required after a concrete bundled Start. */
export function preflightAssociationIssue(ctx?: ExtensionContext): string | undefined {
  const runtime = currentRuntime(),
    state = runtime.supervisor;
  if (
    !state?.preflightBinding ||
    ["stopped", "completed"].includes(state.status) ||
    !needsPreflightAssociation(runtime.preflight, false)
  )
    return;
  const owner = ctx ? currentWorkOwner(ctx.sessionManager.getSessionId()) : null;
  const view = ctx ? readControlJournal(ctx) : undefined;
  return needsPreflightAssociation(
    runtime.preflight,
    !!(owner && selectedAcceptanceContract(view?.acceptance, owner)),
  )
    ? PREFLIGHT_ASSOCIATION_FAULT
    : undefined;
}
export function contractCompilationAdmission(
  ctx: ExtensionContext,
  toolName: string,
  _input: Record<string, unknown>,
  readOnly: boolean,
): string | undefined {
  const runtime = currentRuntime(),
    state = runtime.supervisor,
    board = getBoardRef();
  const association = !readOnly && preflightAssociationIssue(ctx);
  if (association) return association;
  if (!state?.preflightBinding || state.status !== "active" || board.finalAcceptanceTaskId)
    return undefined;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (owner && selectedAcceptanceContract(runtime.controlJournal?.acceptance, owner))
    return undefined;
  // Contract binding is the first-compilation/task-execution gate, not another
  // business authorization layer. Existing ordinary-tool owner/permission/late-result
  // rules still apply unchanged before a board has been compiled.
  if (
    readOnly ||
    !["compile_tasks", "get_ready_tasks", "advance_tasks", "workflow_gate", "run_check"].includes(
      toolName,
    )
  )
    return undefined;
  return "Acceptance contract is not bound: propose complete conditions/check definitions and use native review-contract before compilation or managed task execution";
}
function definitionCurrent(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceDefinitionFact[],
  version: ArtifactVersionV1,
): boolean {
  return definitions.every((item) => {
    if (item.environmentDigest !== version.environmentDigest) return false;
    if (item.spec.kind === "manual") return true;
    const actualWorkspace = version.checkerWorkspaces?.find(
      (entry) => entry.checkId === item.spec.checkId,
    )?.workspace;
    if (journalDigest(actualWorkspace ?? null) !== journalDigest(item.checkerWorkspace ?? null))
      return false;
    const files = item.frozenFiles.map((file) => {
      const current = version.inputs.find(
        (entry) =>
          entry.path ===
          (item.checkerWorkspace ? checkerInputKey(item.spec.checkId, file.path) : file.path),
      );
      return current ? { ...current, path: file.path } : undefined;
    });
    if (journalDigest(files) !== journalDigest(item.frozenFiles)) return false;
    const descriptor = {
      ...nativeCheckDescriptor(
        nativeCheckInput(boundAcceptanceScope(data), item.spec, data.header.environment.values),
        version,
      ),
      nodeVersion: process.version,
      platform: process.platform,
    };
    return journalDigest(descriptor) === journalDigest(item.invocation);
  });
}
const checkFrames = new WeakMap<ReturnType<typeof currentRuntime>, Map<string, InvocationFrame>>();
function liveCheckFrames() {
  const runtime = currentRuntime();
  let frames = checkFrames.get(runtime);
  if (!frames) {
    frames = new Map();
    checkFrames.set(runtime, frames);
  }
  return frames;
}
function parseCheckResult(stdout: string): CheckResultV1 | null {
  try {
    const value: unknown = JSON.parse(stdout);
    if (
      !value ||
      typeof value !== "object" ||
      !("protocol" in value) ||
      value.protocol !== "check-result-v1"
    )
      return null;
    const { protocol, ...result } = value;
    void protocol;
    return Check(CheckResultSchema, result) ? result : null;
  } catch {
    return null;
  }
}
function runNode(run: AcceptanceCheckRun): InvocationNodeV1 | undefined {
  const graph = currentRuntime().controlJournal?.invocations,
    start = run.start.data;
  return graph?.nodes.get(graph.calls.get(invocationCallKey(start.owner, start.callId)) ?? "");
}
function closedNativeRun(run: AcceptanceCheckRun): boolean {
  const start = run.start.data,
    observed = run.observed?.data;
  return (
    !!observed &&
    observed.closed &&
    observed.termination === "exited" &&
    observed.exitCode === 0 &&
    observed.result !== null &&
    observed.beforeVersionId === start.versionId &&
    observed.afterVersionId === start.versionId &&
    observed.beforeGeneration === start.inputGeneration &&
    observed.afterGeneration === start.inputGeneration
  );
}
function currentCheckEnd(run: AcceptanceCheckRun, ctx: ExtensionContext) {
  const frame = liveCheckFrames().get(run.start.data.runId),
    node = runNode(run),
    graph = currentRuntime().controlJournal?.invocations;
  if (
    !closedNativeRun(run) ||
    !frame ||
    !invocationFrameCurrent(ctx, frame) ||
    !node?.end ||
    node.end.outcome !== "returned" ||
    node.end.exitCode !== 0 ||
    !node.end.receiptId ||
    graph?.active.size
  )
    return undefined;
  return { node, end: node.end, receiptId: node.end.receiptId };
}
function sourceQualifiedRun(run: AcceptanceCheckRun, ctx: ExtensionContext): boolean {
  const closed = currentCheckEnd(run, ctx);
  if (!closed) return false;
  const receipt = currentRuntime().receiptStore?.readReceipts([closed.receiptId])[0],
    graph = currentRuntime().controlJournal?.invocations;
  if (!receipt?.ok || receipt.exitCode !== 0 || receipt.tool !== "run_check") return false;
  return (
    closed.node.parentId === null ||
    graph?.seals.get(closed.node.rootId)?.data.outcome === "qualified"
  );
}
function potentialWriterAfter(
  run: AcceptanceCheckRun,
  view: AcceptanceJournalView,
  ctx: ExtensionContext,
): boolean {
  const graph = currentRuntime().controlJournal?.invocations,
    node = runNode(run);
  if (!graph || !node) return true;
  const known = new Set(
    view.runs
      .filter((item) => sourceQualifiedRun(item, ctx))
      .map((item) => runNode(item)?.operationId),
  );
  return [...graph.nodes.values()].some((other) => {
    if (
      invocationOwnerKey(other.owner) !== invocationOwnerKey(node.owner) ||
      other.effect !== "write" ||
      known.has(other.operationId)
    )
      return false;
    if (
      other.capability === SDK_TOOL_ONLY_CAPABILITY &&
      graph.seals.get(other.rootId)?.data.outcome === "qualified"
    )
      return false;
    return !other.end || other.end.sequence >= node.start.sequence;
  });
}
function observedChecks(
  view: AcceptanceJournalView,
  data: AcceptanceBoundFact,
  ctx: ExtensionContext,
) {
  const contract = acceptanceContractValue({ entryId: "projection-only", digest: "", data }, view);
  const observations: CheckObservationV1[] = [],
    qualified: AcceptanceReference[] = [];
  for (const run of view.runs) {
    const entry = run.observed,
      start = run.start.data;
    if (
      !entry ||
      start.contractRef.entryId !== selectedAcceptanceContract(view, data.owner)?.entryId
    )
      continue;
    const check = contract.checks.find(
      (item) =>
        item.checkId ===
        view.definitions.find((def) => def.entryId === start.definitionRef.entryId)?.data.spec
          .checkId,
    );
    if (!check || check.kind !== "automatic") continue;
    const observed = entry.data;
    observations.push({
      kind: "automatic",
      checkId: check.checkId,
      definitionDigest: check.definitionDigest,
      contractDigest: contract.digest,
      owner: data.owner,
      receiptRef: { entryId: entry.entryId, digest: entry.digest },
      versionId: observed.beforeVersionId,
      inputGeneration: observed.beforeGeneration,
      invocationDigest: journalDigest(["native-check-invocation-v1", observed.invocation]),
      environmentDigest: observed.invocation.environmentDigest,
      checkerDigest: check.checkerDigest,
      outcome:
        observed.closed &&
        observed.termination === "exited" &&
        observed.exitCode === 0 &&
        observed.result
          ? "passed"
          : "failed",
      exitCode: observed.exitCode,
      result: observed.result ?? {
        tests: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        requiredCases: {},
        skippedIds: [],
      },
    });
    if (sourceQualifiedRun(run, ctx) && !potentialWriterAfter(run, view, ctx))
      qualified.push({ entryId: entry.entryId, digest: entry.digest });
  }
  const manual = qualifiedManualChecks(view, data, ctx);
  observations.push(...manual.observations);
  qualified.push(...manual.qualified);
  return { observations, qualified };
}
function qualifiedManualChecks(
  view: AcceptanceJournalView,
  data: AcceptanceBoundFact,
  ctx: ExtensionContext,
) {
  const observations = manualCheckObservations(view, {
    entryId: selectedAcceptanceContract(view, data.owner)?.entryId ?? "projection-only",
    digest: "",
    data,
  });
  const qualified: AcceptanceReference[] = [];
  for (const entry of view.manualChecks) {
    const source = entry.control.data,
      frame = liveCheckFrames().get(source.frame.requestId);
    if (
      entry.witness &&
      source.contractRef.entryId === selectedAcceptanceContract(view, data.owner)?.entryId &&
      frame &&
      invocationFrameCurrent(ctx, frame) &&
      !manualWriterAfter(source, view, ctx)
    )
      qualified.push(entry.witness);
  }
  return { observations, qualified };
}
function manualWriterAfter(
  source: ManualCheckBindingV1,
  view: AcceptanceJournalView,
  ctx: ExtensionContext,
): boolean {
  const graph = currentRuntime().controlJournal?.invocations;
  if (!graph || graph.active.size || currentRuntime().receiptStore?.pendingCount) return true;
  const known = new Set(
    view.runs.filter((run) => sourceQualifiedRun(run, ctx)).map((run) => runNode(run)?.operationId),
  );
  return [...graph.nodes.values()].some((node) => {
    if (
      invocationOwnerKey(node.owner) !== invocationOwnerKey(source.owner) ||
      node.effect !== "write" ||
      node.start.sequence <= source.sourceSequence ||
      known.has(node.operationId)
    )
      return false;
    return !(
      node.capability === SDK_TOOL_ONLY_CAPABILITY &&
      graph.seals.get(node.rootId)?.data.outcome === "qualified"
    );
  });
}
function selectManualCheck(ctx: ExtensionCommandContext, checkId: string) {
  if (
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    currentRuntime().journalFault ||
    executionActivityIssue(ctx.sessionManager.getSessionId())
  )
    throw Error(
      "Wait for actual idle/quiet ownership and complete existing native readback before checking an artifact",
    );
  const { owner, view } = contractContext(ctx);
  if (!owner || !view) throw Error("Native manual check needs the selected actual contract owner");
  const bound = selectedAcceptanceContract(view, owner),
    selected = bound?.data.definitions.find((item) => item.checkId === checkId),
    definition = view.definitions.find((item) => item.entryId === selected?.ref.entryId)?.data;
  if (!bound || !selected || !definition || definition.spec.kind !== "manual")
    throw Error("Native manual check ID is not a current trusted manual definition");
  return { owner, view, bound, selected, definition, response: definition.spec.response };
}
function prepareManualCheck(
  ctx: ExtensionContext,
  selection: ReturnType<typeof selectManualCheck>,
) {
  const { owner, bound, definition } = selection,
    graph = currentRuntime().controlJournal?.invocations;
  if (resolve(ctx.cwd) !== bound.data.workspace.root)
    throw Error("Native manual check host workspace changed; inspect the original context");
  if (!graph || graph.active.size)
    throw Error("Actual managed invocation history is not quiet; do not substitute idle/abort ACK");
  const scope = boundAcceptanceScope(bound.data),
    environment = bound.data.header.environment.values,
    version = captureCheckVersion(scope, environment);
  if (version.status !== "known")
    throw Error("Native manual check current artifact version is unknown");
  const journal = inspectRestorableSession(ctx, true);
  if (!journal) throw Error("Native manual check has no physical source");
  const goal = acceptanceGoalSource(journal, owner, bound.data.sourceRef, journal.branch.length),
    subject = manualCheckSubject(
      bound.data,
      definition,
      version.version.versionId,
      version.inputGeneration,
      goal,
    ),
    body = `这只是当前产物条件核对，不授予业务权限、不启动或恢复任务。\n${JSON.stringify(subject, null, 2)}`;
  if (Buffer.byteLength(body, "utf8") > 64000)
    throw Error("Native manual condition material exceeds capacity; no condition is omitted");
  const requestId = randomUUID(),
    frame = captureGoalReadbackFrame(ctx, requestId, subject, bound.data.sourceRef.entryId),
    carrier = captureInvocationFrame(ctx, owner),
    sequence = graph.sequence;
  return { scope, environment, version, requestId, frame, carrier, sequence, body };
}
function manualQuestionCurrent(
  ctx: ExtensionContext,
  prepared: ReturnType<typeof prepareManualCheck>,
): boolean {
  const { carrier, sequence, scope, environment, version } = prepared;
  if (
    resolve(ctx.cwd) !== scope.root ||
    !invocationFrameCurrent(ctx, carrier) ||
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    currentRuntime().journalFault ||
    currentRuntime().controlJournal?.invocations?.sequence !== sequence
  )
    return false;
  const actual = captureCheckVersion(scope, environment);
  return (
    actual.status === "known" &&
    actual.version.versionId === version.version.versionId &&
    actual.inputGeneration === version.inputGeneration
  );
}
export async function verifyManualCheck(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  checkId: string,
) {
  if (!isTrustedLocalTui(ctx)) return { status: "unsupported" as const };
  await ctx.waitForIdle();
  const selection = selectManualCheck(ctx, checkId),
    prepared = prepareManualCheck(ctx, selection),
    { frame, body } = prepared,
    { response } = selection;
  const current = () => manualQuestionCurrent(ctx, prepared);
  const answer = await requestNativeAnswer(
    ctx,
    {
      frame,
      kind: response.kind,
      title: `核验产物条件：${checkId}`,
      body,
      options: response.kind === "choice" ? response.options : undefined,
      purpose: response.kind === "choice" ? "business-choice" : "information",
      ...(response.kind === "information"
        ? {
            informationFormat: response.format,
            informationValidator: (value: string) =>
              validDecisionInformation(
                { version: 1, kind: "information", format: response.format },
                value,
              ),
          }
        : {}),
    },
    current,
  );
  if (!answer) return { status: "deferred" as const, checkId };
  return publishManualResponse(pi, ctx, checkId, selection, prepared, answer);
}
function publishManualResponse(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  checkId: string,
  selection: ReturnType<typeof selectManualCheck>,
  prepared: ReturnType<typeof prepareManualCheck>,
  answer: NativeAnswer,
) {
  const { owner, bound, selected } = selection,
    { frame, version, sequence, requestId, carrier } = prepared;
  const admitted = requireNativeAnswer(ctx, answer, frame);
  if (admitted.outcome !== "answer" || admitted.value === undefined)
    throw Error("A permission/start response is not a manual artifact check");
  const data: ManualCheckBindingV1 = {
    version: 1,
    kind: "acceptance-manual-control",
    recordId: randomUUID(),
    owner,
    sourceRef: bound.data.sourceRef,
    contractRef: { entryId: bound.entryId, digest: bound.digest },
    definitionRef: selected.ref,
    versionId: version.version.versionId,
    inputGeneration: version.inputGeneration,
    sourceSequence: sequence,
    frame,
    value: admitted.value,
  };
  const control = appendAcceptanceFact(pi, ctx, data),
    physical = inspectRestorableSession(ctx, true)?.nodes.get(control.entryId);
  if (!physical) throw Error("Native artifact control append is not physically confirmed");
  try {
    const lease = captureControlLease(ctx);
    publishObservedNativeWitness(pi, ctx, physical, frame);
    assertLease(ctx, lease, ctx.sessionManager.getLeafId());
    currentRuntime().controlJournal = readControlJournal(ctx);
  } catch (error) {
    currentRuntime().journalFault ??=
      "Native artifact response persistence is uncertain; inspect original control/witness without replay";
    currentRuntime().cancel();
    throw error;
  }
  liveCheckFrames().set(requestId, carrier);
  return { status: "confirmed" as const, checkId, value: admitted.value };
}
function selectRegisteredCheck(ctx: ExtensionContext, checkId: string) {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId()),
    view = readControlJournal(ctx).acceptance;
  if (!owner || !view || currentRuntime().supervisor?.status !== "active")
    throw Error(
      "Registered check requires the actual active supervised owner and independent execution permission",
    );
  const bound = selectedAcceptanceContract(view, owner);
  if (!bound) throw Error("Registered check requires a trusted bound acceptance contract");
  const selected = bound.data.definitions.find((item) => item.checkId === checkId),
    definition = view.definitions.find((item) => item.entryId === selected?.ref.entryId)?.data;
  if (!selected || !definition || definition.spec.kind !== "automatic")
    throw Error(
      "Unknown or manual check; use the actual native verify-check command for manual conditions",
    );
  const check = acceptanceContractValue(bound, view).checks.find(
    (item) => item.checkId === checkId,
  );
  if (!check || check.kind !== "automatic")
    throw Error("Declared native checker projection is unavailable");
  return { owner, view, bound, selected, definition, spec: definition.spec, check };
}
function beginRegisteredCheck(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  callId: string,
  selection: ReturnType<typeof selectRegisteredCheck>,
) {
  const { owner, view, bound, selected, definition } = selection;
  if (resolve(ctx.cwd) !== bound.data.workspace.root)
    throw Error("Registered check host workspace changed; native review is required");
  const scope = boundAcceptanceScope(bound.data),
    environment = bound.data.header.environment.values,
    capture =
      (assertCheckerPermissions(ctx, [definition.spec]), captureCheckVersion(scope, environment));
  if (capture.status !== "known" || !definitionCurrent(bound.data, [definition], capture.version))
    throw Error(
      "Registered check inputs/definition are changed or unknown; native review is required",
    );
  if (view.runs.some((run) => !run.observed?.data.closed))
    throw Error("A declared check is already active/unknown; never replay it");
  const graph = currentRuntime().controlJournal?.invocations,
    node = graph?.nodes.get(graph.calls.get(invocationCallKey(owner, callId)) ?? "");
  if (!node || node.toolName !== "run_check" || node.end)
    throw Error("Declared check requires its actual admitted SDK invocation");
  const runId = randomUUID(),
    frame = captureInvocationFrame(ctx, owner),
    frames = liveCheckFrames();
  for (const [key, value] of frames)
    if (invocationOwnerKey(value.owner) !== invocationOwnerKey(owner)) frames.delete(key);
  const started: AcceptanceCheckStarted = {
    version: 1,
    kind: "acceptance-check-started",
    recordId: randomUUID(),
    owner,
    sourceRef: bound.data.sourceRef,
    runId,
    contractRef: { entryId: bound.entryId, digest: bound.digest },
    definitionRef: selected.ref,
    callId,
    invocationRef: node.start.ref,
    versionId: capture.version.versionId,
    inputGeneration: capture.inputGeneration,
    scopeDigest: capture.version.scopeDigest,
  };
  const recorded = appendAcceptanceFact(pi, ctx, started);
  frames.set(runId, frame);
  return { scope, environment, frame, started, recorded };
}
function executionObservation(
  started: AcceptanceCheckStarted,
  recorded: AcceptanceReference,
  execution: NativeCheckExecution,
): AcceptanceCheckObserved {
  if (nativeCheckExecution(execution) !== execution)
    throw Error("Copied execution DTO is not an actual native check result");
  return {
    version: 1,
    kind: "acceptance-check-observed",
    recordId: randomUUID(),
    owner: started.owner,
    sourceRef: started.sourceRef,
    runId: started.runId,
    startedRef: { entryId: recorded.entryId, digest: recorded.digest },
    closed: execution.closed,
    pid: execution.pid,
    exitCode: execution.exitCode,
    termination: execution.termination,
    invocation: {
      ...execution.invocation,
      nodeVersion: process.version,
      platform: process.platform,
    },
    outputDigest: execution.outputDigest,
    beforeVersionId: execution.before.versionId,
    afterVersionId: execution.after.status === "known" ? execution.after.version.versionId : null,
    beforeGeneration: execution.beforeGeneration,
    afterGeneration: execution.after.status === "known" ? execution.after.inputGeneration : null,
    result: parseCheckResult(execution.stdout),
    ...(execution.temporary ? { temporary: execution.temporary } : {}),
  };
}
export async function executeRegisteredCheck(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  callId: string,
  checkId: string,
  signal?: AbortSignal,
) {
  const selection = selectRegisteredCheck(ctx, checkId),
    { scope, environment, frame, started, recorded } = beginRegisteredCheck(
      pi,
      ctx,
      callId,
      selection,
    );
  const { spec, check } = selection;
  const execution = await runNativeCheck(nativeCheckInput(scope, spec, environment), signal);
  const observed = executionObservation(started, recorded, execution),
    result = observed.result;
  appendAcceptanceFact(pi, ctx, observed);
  const passed =
    closedNativeRun({
      start: { entryId: recorded.entryId, digest: recorded.digest, data: started },
      observed: { entryId: "projection-only", digest: "", data: observed },
    }) &&
    result !== null &&
    checkResultPassed(check, result) &&
    invocationFrameCurrent(ctx, frame);
  return {
    id: callId,
    runId: started.runId,
    checkId,
    exit_code: execution.exitCode,
    result_digest: execution.outputDigest,
    passed,
  };
}
export function bindContractReview(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reviewStartedRef: AcceptanceReference,
): void {
  const { owner, view } = contractContext(ctx);
  if (!owner || !view) return;
  const bound = selectedAcceptanceContract(view, owner);
  if (!bound) return;
  const issue = acceptanceContractIssue(ctx);
  if (issue) throw Error(issue);
  const control = readControlJournal(ctx),
    start = control.reviewAttempts?.find(
      (item) =>
        item.start.entryId === reviewStartedRef.entryId &&
        item.start.digest === reviewStartedRef.digest,
    )?.start.data;
  if (!start) throw Error("Contract review binding requires its actual native review start");
  const current = captureCheckVersion(
    boundAcceptanceScope(bound.data),
    bound.data.header.environment.values,
  );
  if (current.status !== "known")
    throw Error("Contract review binding has no current native input version");
  const { observations, qualified } = observedChecks(view, bound.data, ctx),
    latest = new Map(observations.map((item) => [item.checkId, item]));
  const refs = [...latest.values()]
    .filter(
      (item) =>
        item.versionId === current.version.versionId &&
        item.inputGeneration === current.inputGeneration &&
        qualified.some(
          (ref) => ref.entryId === item.receiptRef.entryId && ref.digest === item.receiptRef.digest,
        ),
    )
    .map((item) => item.receiptRef);
  const data: AcceptanceReviewBound = {
    version: 1,
    kind: "acceptance-review-bound",
    recordId: randomUUID(),
    owner,
    sourceRef: bound.data.sourceRef,
    contractRef: { entryId: bound.entryId, digest: bound.digest },
    reviewStartedRef,
    boardDigest: start.boardDigest,
    bindingsDigest: start.bindingsDigest,
    epoch: start.epoch,
    versionId: current.version.versionId,
    inputGeneration: current.inputGeneration,
    observations: refs,
  };
  appendAcceptanceFact(pi, ctx, data);
}
function retainedContractHistory(
  ctx: ExtensionContext,
  bound: AcceptanceReference,
  view: AcceptanceJournalView,
  retained: { boardDigest: string; bindingsDigest: string; epoch: number },
  restoration?: RestoreJournalRead,
): boolean {
  const binding = view.reviewBindings
    .filter(
      (item) =>
        item.data.contractRef.entryId === bound.entryId &&
        item.data.contractRef.digest === bound.digest,
    )
    .at(-1);
  if (!binding) return false;
  const attempt = readControlJournal(ctx, restoration)
    .reviewAttempts?.filter(
      (item) =>
        invocationOwnerKey(item.start.data.owner) === invocationOwnerKey(binding.data.owner),
    )
    .at(-1);
  if (
    attempt?.start.entryId !== binding.data.reviewStartedRef.entryId ||
    attempt.start.digest !== binding.data.reviewStartedRef.digest
  )
    return false;
  return (
    attempt.result?.data.outcome === "accepted" &&
    binding.data.boardDigest === retained.boardDigest &&
    binding.data.bindingsDigest === retained.bindingsDigest &&
    binding.data.epoch === retained.epoch
  );
}
function contractContext(ctx: ExtensionContext | undefined, restoration?: RestoreJournalRead) {
  const runtime = currentRuntime();
  if (!runtime.controlJournal?.latestFence?.data.features.includes("acceptance-contract-v1"))
    return { owner: null, view: undefined };
  const sessionId = ctx?.sessionManager.getSessionId() ?? runtime.supervisor?.sessionId;
  return {
    owner: sessionId ? currentWorkOwner(sessionId) : null,
    view: ctx ? readControlJournal(ctx, restoration).acceptance : runtime.controlJournal.acceptance,
  };
}
/** Semantic gate is additional to structural, original receipt, execution and human gates.
 * No-contract histories stay at their legacy level; no historical mapping is invented. */
export function acceptanceContractIssue(
  ctx: ExtensionContext | undefined,
  retained?: { boardDigest: string; bindingsDigest: string; epoch: number },
  restoration?: RestoreJournalRead,
): string | undefined {
  const { owner, view } = contractContext(ctx, restoration);
  if (!owner || !view) return undefined;
  const bound = selectedAcceptanceContract(view, owner);
  if (!bound)
    return view.definitions.some((item) => journalDigest(item.data.owner) === journalDigest(owner))
      ? "Acceptance contract binding is incomplete; inspect confirmed metadata without replay"
      : undefined;
  if (!ctx) return "Acceptance contract requires its actual current host/version";
  if (retained)
    return retainedContractHistory(ctx, bound, view, retained, restoration)
      ? undefined
      : "Acceptance contract lacks its exact physically sealed accepted review binding";
  if (resolve(ctx.cwd) !== bound.data.workspace.root)
    return "Acceptance contract host workspace changed; native review is required";
  const data = bound.data,
    current = captureCheckVersion(boundAcceptanceScope(data), data.header.environment.values);
  if (current.status !== "known")
    return `Acceptance contract current input version is unknown: ${current.reason}`;
  if (current.version.scopeDigest !== data.scopeDigest)
    return "Acceptance contract scope changed; native review is required";
  const definitions = data.definitions
    .map((ref) => view.definitions.find((item) => item.entryId === ref.ref.entryId)?.data)
    .filter((item): item is AcceptanceDefinitionFact => !!item);
  if (!definitionCurrent(data, definitions, current.version))
    return "Acceptance contract checker/config/environment definition changed; native review is required";
  const { observations, qualified } = observedChecks(view, data, ctx);
  const result = checkContractAcceptance(acceptanceContractValue(bound, view), observations, {
    versionId: current.version.versionId,
    inputGeneration: current.inputGeneration,
    qualifiedReceipts: qualified,
  });
  return result.status === "passed"
    ? undefined
    : `Acceptance contract lacks applicable required checks: ${result.missingRequirements.join(", ")} (${result.code ?? result.status})`;
}
