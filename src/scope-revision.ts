import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { Static } from "typebox";
import { ProposeScopeRevisionParams } from "./scope-revision-schema";
import { canonicalPreflightProposal, PREFLIGHT_ENTRY } from "./preflight";
import { ownerSnapshot, goalLease } from "./goal-scope";
import { captureManagementSnapshot } from "./management-policy";
import { currentRuntime } from "./runtime";
import { getBoardRef } from "./state";
import { ScopeProposalError, ScopeReviewabilityError } from "./scope-guidance";
import { journalDigest, type GoalReadbackFrame, type JournalNode } from "./human-journal";
import {
  inspectRestorableSession,
  captureGoalReadbackFrame,
  publishObservedNativeWitness,
} from "./human-control";
import { isTrustedLocalTui, requestNativeAnswer, requireNativeAnswer } from "./human-ui";
import {
  captureInvocationFrame,
  invocationCarrierCurrent,
  type InvocationFrame,
} from "./qualified-evidence";
import { captureCheckDefinitionVersion } from "./check-runner";
import {
  appendAcceptanceFact,
  appendControlFence,
  readControlJournal,
  captureControlLease,
  assertLease,
} from "./control-journal";
import {
  scopeRevisionContractContext,
  prepareScopeRevisionContract,
  scopeBindingRecordId,
  commitScopeRevisionContract,
  proposeAcceptanceContract,
} from "./acceptance-runtime";
import {
  SCOPE_REVISION_PROPOSAL_ENTRY,
  validScopeRevisionProposal,
  scopeRevisionProposalViews,
  scopeProposalBase,
  scopeRevisionContractProposal,
  assertScopePlanObjects,
} from "./scope-revision-proposal";
import {
  selectedScopeRevision,
  sameScopeRef,
  scopeIsRevoked,
  scopeEffectivePlan,
  scopeRevisionReviewSubject,
  scopePreviousContractMaterial,
  rememberScopeMaterialChange,
  rememberUnreviewableScope,
  assertScopeContractObjects,
} from "./scope-revision-journal";
import { readableScopeRevision } from "./human-presentation";
import {
  contractProposalViews,
  proposalTargetKey,
  validContractProposal,
  type ContractProposalView,
} from "./acceptance-planning";
import { validateAcceptanceProposal } from "./acceptance-proposal";
import { contractReviewSubject } from "./acceptance-journal";
import type { AcceptanceReference } from "./acceptance-contract";
import { SCOPE_REVISION_FAULT, type ScopeRevisionControl } from "./scope-revision-facts";
export { SCOPE_REVISION_FAULT } from "./scope-revision-facts";
const ref = (entry: AcceptanceReference | JournalNode): AcceptanceReference => ({
  entryId: "entryId" in entry ? entry.entryId : entry.id,
  digest: entry.digest,
});
function ensureFence(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const features = readControlJournal(ctx).latestFence?.data.features ?? [];
  if (features.includes("scope-revision-v1")) return;
  appendControlFence(pi, ctx, [
    ...new Set([
      ...features,
      "scope-revision-v1" as const,
      "approval-workflow-v1" as const,
      "acceptance-contract-v1" as const,
      "invocation-tree-v1" as const,
    ]),
  ]);
}
function originalBase(source: ReturnType<typeof scopeRevisionContractContext>) {
  const state = currentRuntime().preflight;
  if (
    !state?.started ||
    state.version !== 2 ||
    !state.approval ||
    !state.proposal ||
    state.phase !== "started"
  )
    throw Error("Scope revision requires original approved and first-started native material");
  const node = source.journal.branch
    .filter(
      (n) =>
        n.customType === PREFLIGHT_ENTRY &&
        ownerSnapshot(n.data, "preflight") !== undefined &&
        journalDigest(ownerSnapshot(n.data, "preflight")) === journalDigest(state),
    )
    .at(-1);
  if (!node) throw Error("Original preflight state has no exact physical source");
  const approval = source.journal.nodes.get(state.approval.controlEntryId),
    start =
      "controlEntryId" in state.started
        ? source.journal.nodes.get(state.started.controlEntryId)
        : undefined;
  if (!approval || !start)
    throw Error("Original approval/first-start references are unavailable; no reconstruction");
  return { node, approval, start, plan: state.proposal };
}
function requireAmendableWork(): void {
  if (getBoardRef().workflowStatus === "completed")
    throw Error(
      "Completed task board does not support scope revision/adoption; inspect retry-review for the existing contract, or explicitly end this Goal and plan independent work. Completed business remains closed",
    );
}
function scopeProposalContext(
  ctx: ExtensionContext,
  input: Static<typeof ProposeScopeRevisionParams>,
) {
  const source = scopeRevisionContractContext(ctx, "proposal"),
    base = originalBase(source),
    previous = selectedScopeRevision(source.view.acceptance, source.owner);
  requireAmendableWork();
  if (previous && source.view.acceptance && scopeIsRevoked(source.view.acceptance, previous))
    throw Error("Revoked scope cannot be revived by a proposal");
  assertScopePlanObjects(base.plan, input.plan);
  assertScopeContractObjects(source.proposal, input.contract);
  canonicalPreflightProposal(source.goal, input.plan);
  return { source, base, previous };
}
function scopePlanMaterial(
  plan: Static<typeof ProposeScopeRevisionParams>["plan"] & { contractProposalId?: string },
) {
  const material = { ...plan };
  delete material.contractProposalId;
  return material;
}
function latestMatchingScope(
  context: ReturnType<typeof scopeProposalContext>,
  input: Static<typeof ProposeScopeRevisionParams>,
) {
  const { source, base, previous } = context;
  const latest = source.view.acceptance?.scopeProposals
    ?.filter((p) => journalDigest(p.data.owner) === journalDigest(source.owner))
    .at(-1);
  if (!latest) return;
  const data = latest.data;
  const expected = [
    source.owner,
    source.sourceRef,
    ref(base.node),
    ref(base.approval),
    ref(base.start),
    previous ? ref(previous) : null,
    ref(source.bound),
    scopePlanMaterial(input.plan),
    input.contract,
    input.reason,
  ];
  const actual = [
    data.owner,
    data.sourceRef,
    data.basePreflightRef,
    data.approvalRef,
    data.startRef,
    data.previousRevisionRef,
    data.previousContractRef,
    scopePlanMaterial(data.plan),
    scopeRevisionContractProposal(source.journal, latest).data.proposal,
    data.reason,
  ];
  if (!isDeepStrictEqual(actual, expected)) return;
  if (
    source.view.acceptance?.scopeReviews?.some((row) =>
      sameScopeRef(row.control.data.proposalRef, latest),
    )
  )
    throw Error(
      `Latest identical scope proposal already responded; inspect saved native review/repair for ${data.proposalId}, not a replacement proposal or refreshed approval`,
    );
  return latest;
}
const futureReference = () => ({ entryId: "x".repeat(200), digest: "a".repeat(64) });
function scopeProposalData(
  context: ReturnType<typeof scopeProposalContext>,
  input: Static<typeof ProposeScopeRevisionParams>,
  contract: ContractProposalView,
  proposalId: string,
) {
  const { source, base, previous } = context;
  const plan = { ...input.plan, contractProposalId: contract.data.proposalId };
  try {
    canonicalPreflightProposal(source.goal, plan);
  } catch (error) {
    throw new ScopeReviewabilityError(
      `Scope plan capacity upper bound/material with derived contract reference is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const data = {
    version: 1 as const,
    sessionId: source.journal.sessionId,
    proposalId,
    owner: source.owner,
    sourceRef: source.sourceRef,
    basePreflightRef: ref(base.node),
    approvalRef: ref(base.approval),
    startRef: ref(base.start),
    previousRevisionRef: previous ? ref(previous) : null,
    previousContractRef: ref(source.bound),
    contractProposalRef: ref(contract),
    plan,
    reason: input.reason,
  };
  if (!validScopeRevisionProposal(data, source.journal.sessionId))
    throw new ScopeReviewabilityError(
      "Scope proposal exceeds exact schema/capacity; nothing is omitted",
    );
  return data;
}
function previewContractProposal(
  context: ReturnType<typeof scopeProposalContext>,
  input: Static<typeof ProposeScopeRevisionParams>,
): ContractProposalView {
  const { source } = context,
    proposal = validateAcceptanceProposal(input.contract);
  const data = {
    version: 1 as const,
    sessionId: source.journal.sessionId,
    proposalId: "x".repeat(200),
    sourceRef: source.sourceRef,
    target: { kind: "goal" as const, owner: source.owner },
    proposal,
  };
  const previous = contractProposalViews(source.journal).filter(
    (p) => proposalTargetKey(p.data) === proposalTargetKey(data),
  );
  const existing = previous.find((p) => journalDigest(p.data.proposal) === journalDigest(proposal));
  if (existing) return existing;
  if (previous.length >= 8)
    throw new ScopeReviewabilityError(
      "Contract proposal capacity reached; no source history is evicted",
      "Main: inspect saved contract proposals; no new contract slot remains. Reuse only exact existing complete material when otherwise admissible; never delete history, omit conditions or reset limits",
    );
  if (!validContractProposal(data, source.journal.sessionId))
    throw new ScopeReviewabilityError(
      "Contract proposal metadata exceeds native64KB/schema capacity upper bound; no condition is dropped",
    );
  return { ...futureReference(), data };
}
function preflightScopeReview(
  ctx: ExtensionContext,
  context: ReturnType<typeof scopeProposalContext>,
  input: Static<typeof ProposeScopeRevisionParams>,
  duplicate: ReturnType<typeof latestMatchingScope>,
): void {
  const prepared = prepareScopeRevisionContract(ctx, input.contract, "proposal");
  const contract = duplicate
    ? scopeRevisionContractProposal(context.source.journal, duplicate)
    : previewContractProposal(context, input);
  const proposal = duplicate ?? {
    ...futureReference(),
    data: scopeProposalData(context, input, contract, "x".repeat(200)),
  };
  scopeReviewMaterial(context.source, proposal, contract, prepared, context.base.plan);
}
function requireScopeProposalSlot(source: ReturnType<typeof scopeRevisionContractContext>) {
  if (
    (source.view.acceptance?.scopeProposals?.filter(
      (p) => journalDigest(p.data.owner) === journalDigest(source.owner),
    ).length ?? 0) >= 8
  )
    throw Error("Scope proposal capacity exhausted; no existing history is discarded");
}
export function proposeScopeRevision(pi: ExtensionAPI, ctx: ExtensionContext, input: unknown) {
  if (!Check(ProposeScopeRevisionParams, input))
    throw new ScopeProposalError(
      "SCOPE_PROPOSAL_INVALID",
      "Scope proposal must include the complete exact plan, contract and reason",
      "Main: supply complete plan, contract and nonempty reason; do not infer authority or silently fill missing material",
    );
  const context = scopeProposalContext(ctx, input),
    { source } = context;
  const duplicate = latestMatchingScope(context, input);
  preflightScopeReview(ctx, context, input, duplicate);
  if (duplicate)
    return {
      proposalId: duplicate.data.proposalId,
      ref: { entryId: duplicate.entryId, digest: duplicate.digest },
      status: "proposed" as const,
      next: `/task-supervisor review-scope ${duplicate.data.proposalId}`,
      reused: true,
    };
  requireScopeProposalSlot(source);
  const contract = proposeAcceptanceContract(pi, ctx, input.contract, true);
  const journal = inspectRestorableSession(ctx, true);
  const contractProposal =
    journal &&
    contractProposalViews(journal).find((p) => p.data.proposalId === contract.proposalId);
  if (!journal || !contractProposal)
    throw Error("Scope acceptance proposal is not physically available");
  const data = scopeProposalData(context, input, contractProposal, randomUUID());
  scopeProposalBase(journal, data, journal.branch.length);
  ensureFence(pi, ctx);
  const lease = captureControlLease(ctx);
  try {
    pi.appendEntry(SCOPE_REVISION_PROPOSAL_ENTRY, data);
    assertLease(ctx, lease, ctx.sessionManager.getLeafId());
    const after = inspectRestorableSession(ctx, true),
      saved =
        after &&
        scopeRevisionProposalViews(after).find((p) => p.data.proposalId === data.proposalId);
    if (
      !saved ||
      after.branch.at(-1)?.id !== saved.entryId ||
      journalDigest(saved.data) !== journalDigest(data)
    )
      throw Error("Scope proposal readback failed");
    currentRuntime().controlJournal = readControlJournal(ctx);
    return {
      proposalId: data.proposalId,
      ref: { ...ref(saved) },
      status: "proposed" as const,
      reused: false,
      next: `/task-supervisor review-scope ${data.proposalId}`,
    };
  } catch (error) {
    scopeFault();
    throw error;
  }
}
function scopeFault(): void {
  currentRuntime().cancel();
  currentRuntime().journalFault = SCOPE_REVISION_FAULT;
}
function preparedReview(
  ctx: ExtensionContext,
  proposalId: string,
  originalControl?: AcceptanceReference,
) {
  const source = scopeRevisionContractContext(ctx),
    view = source.view.acceptance;
  if (!originalControl) requireAmendableWork();
  const proposal = view?.scopeProposals?.find((p) => p.data.proposalId === proposalId);
  if (!proposal || !view) throw Error("Unknown actual current-owner scope proposal");
  if (
    journalDigest(proposal.data.owner) !== journalDigest(source.owner) ||
    !sameScopeRef(proposal.data.previousContractRef, source.bound) ||
    !sameScopeRef(proposal.data.previousRevisionRef, selectedScopeRevision(view, source.owner))
  )
    throw Error("Scope proposal no longer names the current exact contract/revision");
  const previous = selectedScopeRevision(view, source.owner);
  if (previous && scopeIsRevoked(view, previous))
    throw Error("Scope revision is revoked; no fallback");
  const base = scopeProposalBase(source.journal, proposal.data, source.journal.branch.length),
    contract = scopeRevisionContractProposal(source.journal, proposal);
  assertScopeContractObjects(source.proposal, contract.data.proposal);
  const prepared = prepareScopeRevisionContract(
    ctx,
    contract.data.proposal,
    "review",
    originalControl,
  );
  return {
    source,
    proposal,
    prepared,
    ...scopeReviewMaterial(source, proposal, contract, prepared, base.plan, originalControl),
  };
}
function scopeReviewMaterial(
  source: ReturnType<typeof scopeRevisionContractContext>,
  proposal: Parameters<typeof scopeRevisionReviewSubject>[0],
  contract: ContractProposalView,
  prepared: ReturnType<typeof prepareScopeRevisionContract>,
  originalPlan: Static<typeof ProposeScopeRevisionParams>["plan"],
  originalControl?: AcceptanceReference,
) {
  const view = source.view.acceptance;
  if (!view) throw Error("Original scope acceptance view unavailable");
  // Preview references size material only. This subject is never accepted as a native response.
  const subject = scopeRevisionReviewSubject(
    proposal,
    scopeEffectivePlan(source.view.acceptance, source.owner) ?? originalPlan,
    contractReviewSubject(
      prepared.base,
      prepared.definitions,
      contract,
      prepared.capture.version.versionId,
      prepared.capture.inputGeneration,
      source.goal,
    ),
    scopePreviousContractMaterial(view, proposal),
  );
  const presentation = readableScopeRevision(subject);
  requireScopeReviewCapacity({ source, prepared }, originalControl);
  if (!originalControl && Buffer.byteLength(presentation.body, "utf8") > 64000)
    throw new ScopeReviewabilityError(
      "Scope review material exceeds64KB capacity upper bound; no condition is dropped",
    );
  return { subject, presentation };
}
function materialCurrent(
  ctx: ExtensionContext,
  review: ReturnType<typeof preparedReview>,
): boolean {
  const { prepared, source } = review;
  const selected = scopeRevisionContractContext(ctx).bound;
  if (!sameScopeRef(selected, source.bound)) return false;
  const capture = captureCheckDefinitionVersion(
    prepared.scope,
    prepared.base.header.environment.values,
  );
  return (
    capture.status === "known" &&
    capture.version.versionId === prepared.capture.version.versionId &&
    capture.inputGeneration === prepared.capture.inputGeneration
  );
}
function requireScopeReviewCapacity(
  review: {
    source: ReturnType<typeof scopeRevisionContractContext>;
    prepared: ReturnType<typeof prepareScopeRevisionContract>;
  },
  originalControl?: AcceptanceReference,
): void {
  const view = review.source.view.acceptance,
    key = journalDigest(review.source.owner);
  if (
    !originalControl &&
    (view?.scopeReviews?.filter((r) => journalDigest(r.control.data.owner) === key).length ?? 0) >=
      16
  )
    throw new ScopeReviewabilityError(
      "Scope native response capacity exhausted before collecting a new answer",
      "Inspect original saved scope responses; no new response slot remains for this Goal. Repair only exact witnessed metadata where applicable; do not repeat review, delete history or reset counts",
    );
  const additions = originalControl
    ? review.prepared.definitions.filter(
        (definition) =>
          !view?.definitions.some(
            (d) =>
              d.data.recordId === scopeBindingRecordId(originalControl, definition.spec.checkId),
          ),
      ).length
    : review.prepared.definitions.length;
  if (
    (view?.definitions.filter((d) => journalDigest(d.data.owner) === key).length ?? 0) + additions >
    256
  )
    throw new ScopeReviewabilityError(
      "Frozen scope definition capacity exhausted before native review; no field is omitted",
      "Inspect original definitions and repair only exact witnessed metadata; capacity cannot be renewed by dropping required checks or historical records",
    );
}
function scopeCarrierCurrent(ctx: ExtensionContext, frame: InvocationFrame): boolean {
  if (
    !invocationCarrierCurrent(ctx, frame) ||
    frame.goalToken !== goalLease() ||
    frame.humanEpoch !== currentRuntime().humanEpoch
  )
    return false;
  const mode = captureManagementSnapshot(ctx),
    record = mode.record;
  const modeRef = record ? { entryId: record.entryId, digest: record.digest } : null;
  // Exact native scope metadata may close its retained control during stopping.
  // This does not relax execution-frame qualification or release the mode.
  return (
    mode.mode === "supervised" &&
    ["active", "stopping-with-attention"].includes(mode.state) &&
    journalDigest(modeRef) === journalDigest(frame.modeRef)
  );
}
function prepareNativeScopeReview(ctx: ExtensionContext, proposalId: string) {
  try {
    return preparedReview(ctx, proposalId);
  } catch (error) {
    if (error instanceof ScopeReviewabilityError)
      rememberUnreviewableScope(ctx, proposalId, error.next);
    throw error;
  }
}
export async function reviewScopeRevision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  proposalId: string,
) {
  if (!isTrustedLocalTui(ctx)) return { status: "unsupported" as const };
  await ctx.waitForIdle();
  return reviewScopeRevisionNow(pi, ctx, proposalId);
}

export async function reviewScopeRevisionNow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  proposalId: string,
) {
  if (!isTrustedLocalTui(ctx)) return { status: "unsupported" as const };
  const review = prepareNativeScopeReview(ctx, proposalId),
    presentation = review.presentation;
  ensureFence(pi, ctx);
  const carrier = captureInvocationFrame(ctx, review.source.owner),
    frame = captureGoalReadbackFrame(
      ctx,
      randomUUID(),
      review.subject,
      review.source.sourceRef.entryId,
    );
  const current = () => {
    try {
      return scopeCarrierCurrent(ctx, carrier) && materialCurrent(ctx, review);
    } catch {
      return false;
    }
  };
  const answer = await requestNativeAnswer(
    ctx,
    {
      frame,
      kind: "authorization",
      purpose: "scope-revision",
      title: presentation.title,
      body: presentation.body,
    },
    current,
  );
  if (!answer) return { status: "deferred" as const };
  const admitted = requireNativeAnswer(ctx, answer, frame);
  if (!["approve", "reject"].includes(admitted.outcome))
    throw Error("Scope revision needs its original native authorization response");
  const previous = readControlJournal(ctx)
    .acceptance?.scopeReviews?.filter(
      (r) => journalDigest(r.control.data.owner) === journalDigest(review.source.owner),
    )
    .at(-1);
  const data: ScopeRevisionControl = {
    version: 1,
    kind: "acceptance-scope-control",
    recordId: randomUUID(),
    owner: review.source.owner,
    sourceRef: review.source.sourceRef,
    proposalRef: ref(review.proposal),
    previousControlRef: previous ? ref(previous.control) : null,
    contractId: review.prepared.base.contractId,
    revision: review.prepared.base.revision,
    frame,
    value: admitted.outcome === "approve" ? "Approve revision" : "Reject revision",
    versionId: review.prepared.capture.version.versionId,
    inputGeneration: review.prepared.capture.inputGeneration,
  };
  try {
    const control = appendAcceptanceFact(pi, ctx, data),
      node = inspectRestorableSession(ctx, true)?.nodes.get(control.entryId);
    if (!node) throw Error("Scope native response is not physically available");
    publishObservedNativeWitness(pi, ctx, node, frame);
    currentRuntime().controlJournal = readControlJournal(ctx);
    if (data.value !== "Approve revision") return { status: "rejected" as const };
    if (!current())
      throw Error("Scope material changed after native response; no reconstructed approval");
    return finishRevision(pi, ctx, review, ref(control), frame);
  } catch (error) {
    scopeFault();
    throw error;
  }
}
function finishRevision(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  review: ReturnType<typeof preparedReview>,
  controlRef: AcceptanceReference,
  frame: GoalReadbackFrame,
) {
  const { prepared, source, proposal } = review;
  const row = readControlJournal(ctx).acceptance?.scopeReviews?.find((r) =>
    sameScopeRef(r.control, controlRef),
  );
  if (!row?.witness || journalDigest(row.control.data.frame) !== journalDigest(frame))
    throw Error("Original confirmed scope response is unavailable; never synthesize its witness");
  const existing = readControlJournal(ctx).acceptance?.contracts.find(
    (b) =>
      b.data.authority.kind === "scope-revision-reviewed" &&
      sameScopeRef(b.data.authority.controlRef, controlRef),
  );
  const contractRef = existing
    ? ref(existing)
    : commitScopeRevisionContract(pi, ctx, prepared, controlRef);
  const commit = appendAcceptanceFact(pi, ctx, {
    version: 1,
    kind: "scope-revision-committed",
    recordId: `scope-commit-${journalDigest(controlRef)}`,
    owner: source.owner,
    sourceRef: source.sourceRef,
    proposalRef: ref(proposal),
    controlRef,
    witnessRef: ref(row.witness),
    previousRevisionRef: proposal.data.previousRevisionRef,
    contractRef,
  });
  return {
    status: "committed" as const,
    revision: prepared.base.revision,
    ref: ref(commit),
    remaining:
      "Still paused; explicit recover, current capability/budget/source checks and fresh evidence remain required",
  };
}
class ScopeMaterialChanged extends Error {}
function approvedScopeRepair(
  ctx: ExtensionContext,
  proposal: ReturnType<typeof preparedReview>["proposal"],
) {
  const view = readControlJournal(ctx).acceptance;
  const row = view?.scopeReviews
    ?.filter((r) => journalDigest(r.control.data.owner) === journalDigest(proposal.data.owner))
    .at(-1);
  if (
    !row?.witness ||
    row.control.data.value !== "Approve revision" ||
    !sameScopeRef(row.control.data.proposalRef, proposal)
  )
    throw Error(
      "Repair needs the original latest approved native control AND its physical witness; review anew otherwise",
    );
  const review = preparedReview(ctx, proposal.data.proposalId, ref(row.control)),
    data = row.control.data;
  if (
    data.frame.scopeDigest !== journalDigest(review.subject) ||
    data.versionId !== review.prepared.capture.version.versionId ||
    data.inputGeneration !== review.prepared.capture.inputGeneration
  )
    throw new ScopeMaterialChanged(
      "Original approved scope material changed; repair cannot refresh it",
    );
  return { review, row };
}
function scopeProposalNeedsReview(
  view: ReturnType<typeof readControlJournal>["acceptance"],
  proposal: ReturnType<typeof preparedReview>["proposal"],
): boolean {
  const latest = view?.scopeReviews
    ?.filter((r) => journalDigest(r.control.data.owner) === journalDigest(proposal.data.owner))
    .at(-1);
  return (
    !latest?.witness ||
    latest.control.data.value !== "Approve revision" ||
    !sameScopeRef(latest.control.data.proposalRef, proposal)
  );
}
export async function repairScopeRevision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  proposalId: string,
) {
  await ctx.waitForIdle();
  const runtime = currentRuntime(),
    old = runtime.journalFault;
  if (old && old !== SCOPE_REVISION_FAULT) throw Error(old);
  try {
    runtime.journalFault = undefined;
    const view = readControlJournal(ctx).acceptance,
      proposal = view?.scopeProposals?.find((p) => p.data.proposalId === proposalId);
    if (!view || !proposal) throw Error("Unknown original scope proposal");
    const committed = view.scopeCommits?.find((c) => sameScopeRef(c.data.proposalRef, proposal));
    if (committed) {
      scopeRevisionContractContext(ctx);
      runtime.controlJournal = readControlJournal(ctx);
      return { status: "already_saved" as const, ref: ref(committed) };
    }
    if (scopeProposalNeedsReview(view, proposal)) {
      scopeRevisionContractContext(ctx);
      runtime.controlJournal = readControlJournal(ctx);
      return {
        status: "needs_review" as const,
        next: `/task-supervisor review-scope ${proposalId}`,
        remaining:
          "No matching original approved physical witness; still held. A new exact native review is required, not replay or recovery",
      };
    }
    const { review, row } = approvedScopeRepair(ctx, proposal);
    const result = finishRevision(pi, ctx, review, ref(row.control), row.control.data.frame);
    runtime.controlJournal = readControlJournal(ctx);
    return result;
  } catch (error) {
    if (error instanceof ScopeMaterialChanged) {
      runtime.journalFault = undefined;
      scopeRevisionContractContext(ctx);
      runtime.controlJournal = readControlJournal(ctx);
      rememberScopeMaterialChange(ctx, proposalId);
      return {
        status: "needs_review" as const,
        next: `/task-supervisor review-scope ${proposalId}`,
        remaining:
          error.message +
          "; execution remains held, only a new exact native review can authorize the changed material",
      };
    }
    runtime.journalFault = old ?? SCOPE_REVISION_FAULT;
    throw error;
  }
}
export async function revokeScopeRevision(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  revisionId: string,
) {
  await ctx.waitForIdle();
  const source = scopeRevisionContractContext(ctx),
    view = source.view.acceptance;
  const revision = view?.scopeCommits?.find(
    (c) => c.entryId === revisionId || c.data.recordId === revisionId,
  );
  if (!revision || journalDigest(revision.data.owner) !== journalDigest(source.owner))
    throw Error("Unknown current-owner scope revision");
  const existing = view?.scopeRevocations?.find((r) => sameScopeRef(r.data.revisionRef, revision));
  if (existing) return { status: "already_revoked" as const, ref: ref(existing) };
  try {
    const saved = appendAcceptanceFact(pi, ctx, {
      version: 1,
      kind: "scope-revision-revoked",
      recordId: randomUUID(),
      owner: source.owner,
      sourceRef: source.sourceRef,
      revisionRef: ref(revision),
    });
    return {
      status: "revoked" as const,
      ref: ref(saved),
      remaining: "Held; revocation never falls back to an older scope or resets accounting",
    };
  } catch (error) {
    scopeFault();
    throw error;
  }
}
