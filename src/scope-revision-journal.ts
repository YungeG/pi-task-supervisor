import { isDeepStrictEqual } from "node:util";
import { journalDigest, type SessionJournal } from "./human-journal";
import {
  ControlJournalError,
  currentWorkOwner,
  retainedWorkOwner,
  readControlJournal,
  type WorkOwnerKey,
} from "./control-journal";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import type { RestoreJournalRead } from "./restore-journal";
import { invocationOwnerKey } from "./invocation-tree";
import {
  contractReviewSubject,
  acceptanceGoalSource,
  type AcceptanceBoundFact,
  type AcceptanceDefinitionFact,
  type AcceptanceJournalView,
  type AcceptanceFactView,
} from "./acceptance-journal";
import {
  scopeRevisionContractProposal,
  scopeProposalBase,
  scopeNodeBefore,
  type ScopeRevisionProposalView,
} from "./scope-revision-proposal";
import type {
  ScopeRevisionControl,
  ScopeRevisionCommitted,
  ScopeRevisionRevoked,
} from "./scope-revision-facts";
import type { AcceptanceReference } from "./acceptance-contract";
import type { AcceptanceProposal } from "./acceptance-proposal";
import type { PreflightProposal } from "./preflight";
function fail(): never {
  throw new ControlJournalError("CONTROL_FORMAT_INVALID");
}
export function sameScopeRef(
  a: AcceptanceReference | null | undefined,
  b: AcceptanceReference | null | undefined,
): boolean {
  return a?.entryId === b?.entryId && a?.digest === b?.digest;
}
export function selectedScopeRevision(
  view: AcceptanceJournalView | undefined,
  owner: WorkOwnerKey | null,
) {
  if (!owner) return undefined;
  return view?.scopeCommits
    ?.filter((entry) => invocationOwnerKey(entry.data.owner) === invocationOwnerKey(owner))
    .at(-1);
}
export function scopeProposalFor(
  view: AcceptanceJournalView,
  ref: AcceptanceReference,
): ScopeRevisionProposalView {
  const proposal = view.scopeProposals?.find((p) => sameScopeRef(p, ref));
  if (!proposal) fail();
  return proposal;
}
export function scopeIsRevoked(
  view: AcceptanceJournalView,
  entry: AcceptanceFactView<ScopeRevisionCommitted>,
): boolean {
  let current: typeof entry | undefined = entry;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.entryId)) fail();
    seen.add(current.entryId);
    if (view.scopeRevocations?.some((rev) => sameScopeRef(rev.data.revisionRef, current)))
      return true;
    const previous: AcceptanceReference | null = current.data.previousRevisionRef;
    current = previous
      ? view.scopeCommits?.find((item) => sameScopeRef(item, previous))
      : undefined;
    if (previous && !current) fail();
  }
  return false;
}
export function scopeEffectivePlan(
  view: AcceptanceJournalView | undefined,
  owner: WorkOwnerKey,
): PreflightProposal | undefined {
  const commit = selectedScopeRevision(view, owner);
  return commit && view ? scopeProposalFor(view, commit.data.proposalRef).data.plan : undefined;
}
export function scopeRevisionIssue(
  view: AcceptanceJournalView | undefined,
  owner: WorkOwnerKey,
): string | undefined {
  if (!view) return;
  const current = selectedScopeRevision(view, owner);
  if (current && scopeIsRevoked(view, current))
    return "Current scope revision is revoked; no fallback to an older scope or automatic execution";
  const latest = view.scopeProposals
    ?.filter((p) => invocationOwnerKey(p.data.owner) === invocationOwnerKey(owner))
    .at(-1);
  if (latest && (!current || !sameScopeRef(current.data.proposalRef, latest)))
    return "Current Goal scope change awaits exact native review/commit; no repeated preflight or first Start";
  const review = view.scopeReviews
    ?.filter((r) => invocationOwnerKey(r.control.data.owner) === invocationOwnerKey(owner))
    .at(-1);
  if (review && (!current || !sameScopeRef(current.data.controlRef, review.control)))
    return "Scope response is not an effective committed revision; inspect/review or repair its exact original metadata";
  return undefined;
}
function physicalScopeView(
  ctx: ExtensionContext,
  restoration?: RestoreJournalRead,
): AcceptanceJournalView | undefined {
  // Native scope revisions cannot originate in fileless sessions. Preserve the
  // old in-memory ledger path; a claimed scope feature still requires real readback.
  if (
    ctx.sessionManager.getSessionFile() === undefined &&
    !currentRuntime().controlJournal?.latestFence?.data.features.includes("scope-revision-v1")
  )
    return undefined;
  return readControlJournal(ctx, restoration).acceptance;
}
export function currentScopeState(ctx?: ExtensionContext, restoration?: RestoreJournalRead) {
  const runtime = currentRuntime(),
    sessionId = ctx?.sessionManager.getSessionId() ?? runtime.supervisor?.sessionId;
  const view = ctx ? physicalScopeView(ctx, restoration) : runtime.controlJournal?.acceptance;
  const owner = view?.scopeProposals?.length && sessionId ? currentWorkOwner(sessionId) : null;
  const revision = selectedScopeRevision(view, owner);
  const issue = owner ? scopeRevisionIssue(view, owner) : undefined;
  const recoveryRequired =
    revision && !sameScopeRef(revision, runtime.supervisor?.scopeRevisionRef);
  return {
    owner,
    view,
    revision,
    issue,
    executionIssue:
      issue ??
      (recoveryRequired
        ? "Committed scope revision requires explicit recover; resume/repair cannot adopt it or dispatch"
        : undefined),
  };
}
export function currentScopeReference(ctx?: ExtensionContext): AcceptanceReference | undefined {
  const revision = currentScopeState(ctx).revision;
  return revision ? { entryId: revision.entryId, digest: revision.digest } : undefined;
}
export function scopeCaptureReference(ctx?: ExtensionContext): AcceptanceReference | undefined {
  // Optional capture stamp only: ordinary pre-feature receipts retain their exact
  // schema/hash and amortized ledger path. Eligibility always rechecks actual scope.
  if (!currentRuntime().controlJournal?.latestFence?.data.features.includes("scope-revision-v1"))
    return undefined;
  return currentScopeReference(ctx);
}
export function scopeExecutionIssue(
  ctx?: ExtensionContext,
  restoration?: RestoreJournalRead,
): string | undefined {
  try {
    return currentScopeState(ctx, restoration).executionIssue;
  } catch {
    return "Scope execution owner/source is unavailable; inspect original identity and journal before control";
  }
}
function latestScopeProposal(view: AcceptanceJournalView | undefined, owner: WorkOwnerKey) {
  return view?.scopeProposals
    ?.filter((p) => invocationOwnerKey(p.data.owner) === invocationOwnerKey(owner))
    .at(-1);
}
export function cachedScopeFlow() {
  const source = currentScopeState(),
    issue = source.executionIssue;
  if (!issue || !source.owner) return undefined;
  const pending = source.issue;
  if (!pending)
    return {
      issue,
      next: "/task-supervisor recover (explicitly adopt current committed scope; clear a separate board gate first)",
      recoveryRequired: true,
    };
  const owner = source.owner;
  const proposal = latestScopeProposal(source.view, owner),
    review = ownerScopeReviews(source.view, owner).at(-1);
  const repair =
    review?.witness &&
    review.control.data.value === "Approve revision" &&
    sameScopeRef(review.control.data.proposalRef, proposal);
  const next =
    source.revision && source.view && scopeIsRevoked(source.view, source.revision)
      ? "/task-supervisor status (revoked scope remains held; no fallback)"
      : proposal
        ? `/task-supervisor ${repair ? "repair-scope" : "review-scope"} ${proposal.data.proposalId}`
        : "Main: propose_scope_revision with complete exact material";
  return { issue, next, recoveryRequired: false };
}
export function scopeControlAttention(): string | undefined {
  const runtime = currentRuntime(),
    sessionId = runtime.supervisor?.sessionId;
  const owner = sessionId ? retainedWorkOwner(sessionId) : null,
    view = runtime.controlJournal?.acceptance;
  if (!owner) return;
  const review = ownerScopeReviews(view, owner).at(-1);
  if (!review) return;
  if (!review.witness)
    return "Original scope response lacks its physical witness; repair/inspect then explicitly review anew, not replay";
  if (
    review.control.data.value === "Approve revision" &&
    !view?.scopeCommits?.some((c) => sameScopeRef(c.data.controlRef, review.control))
  )
    return "Confirmed scope response awaits exact metadata repair; do not discard it through a mode change";
  return undefined;
}
export function scopeEvidenceApplicable(
  scopeRef: AcceptanceReference | undefined,
  ctx?: ExtensionContext,
): boolean {
  try {
    const source = currentScopeState(ctx);
    return !source.executionIssue && sameScopeRef(scopeRef, source.revision);
  } catch {
    return false;
  }
}
/** Pure cache token for private callback leases, not an authority or physical-source check. */
export function scopeLeaseToken(): unknown {
  const view = currentRuntime().controlJournal?.acceptance;
  if (!view?.scopeCommits?.length) return undefined;
  return [view.scopeCommits.map((c) => c.entryId), view.scopeRevocations?.map((r) => r.entryId)];
}
export function assertScopeExecutionSource(
  view: AcceptanceJournalView,
  journal: SessionJournal,
  owner: WorkOwnerKey,
  position: number,
): void {
  const prefix = {
    ...view,
    scopeProposals: view.scopeProposals?.filter(
      (p) => journal.branch.findIndex((n) => n.id === p.entryId) < position,
    ),
  };
  if (scopeRevisionIssue(prefix, owner)) fail();
  const revision = selectedScopeRevision(prefix, owner);
  if (!revision) return;
  if (owner.kind !== "goal") fail();
  const source = journal.branch
    .slice(0, position)
    .filter((node) => node.supervisorProof?.goalKey === owner.goal.goalKey)
    .at(-1)?.supervisorProof;
  if (!sameScopeRef(source?.scopeRevisionRef, revision)) fail();
}
export function assertScopeReceiptSources(
  journal: SessionJournal,
  view: AcceptanceJournalView | undefined,
): void {
  const commits = new Map((view?.scopeCommits ?? []).map((c) => [c.entryId, c]));
  const selected = new Map<string, AcceptanceReference>();
  for (const node of journal.branch) {
    const commit = commits.get(node.id);
    if (commit && commit.data.owner.kind === "goal")
      selected.set(commit.data.owner.goal.goalKey, commit);
    const supervisor = node.supervisorProof;
    const active = supervisor?.goalKey ? selected.get(supervisor.goalKey) : undefined;
    if (
      supervisor &&
      active &&
      ["active", "reviewing", "completed"].includes(supervisor.status) &&
      !sameScopeRef(supervisor.scopeRevisionRef, active)
    )
      fail();
    const proof = node.receiptProof;
    if (proof && !sameScopeRef(proof.scopeRevisionRef, selected.get(proof.goalId))) fail();
  }
}
function proposalBefore(
  view: AcceptanceJournalView,
  journal: SessionJournal,
  ref: AcceptanceReference,
  position: number,
) {
  const p = scopeProposalFor(view, ref);
  scopeNodeBefore(journal, p, position);
  scopeProposalBase(journal, p.data, position);
  return p;
}
function currentBase(view: AcceptanceJournalView, p: ScopeRevisionProposalView): void {
  const current = selectedScopeRevision(view, p.data.owner);
  if (!sameScopeRef(p.data.previousRevisionRef, current)) fail();
  if (current && scopeIsRevoked(view, current)) fail();
  const contracts = view.contracts.filter(
    (entry) =>
      invocationOwnerKey(entry.data.owner) === invocationOwnerKey(p.data.owner) &&
      (entry.data.authority.kind !== "scope-revision-reviewed" ||
        view.scopeCommits?.some((commit) => sameScopeRef(commit.data.contractRef, entry))),
  );
  if (!sameScopeRef(contracts.at(-1), p.data.previousContractRef)) fail();
}
function ownerScopeReviews(view: AcceptanceJournalView | undefined, owner: WorkOwnerKey) {
  return (view?.scopeReviews ?? []).filter(
    (r) => invocationOwnerKey(r.control.data.owner) === invocationOwnerKey(owner),
  );
}
export function assertScopeControl(
  view: AcceptanceJournalView,
  data: ScopeRevisionControl,
  journal: SessionJournal,
  position: number,
): void {
  const p = proposalBefore(view, journal, data.proposalRef, position);
  currentBase(view, p);
  const previous = ownerScopeReviews(view, data.owner).at(-1);
  if (
    !sameScopeRef(data.previousControlRef, previous?.control) ||
    invocationOwnerKey(data.owner) !== invocationOwnerKey(p.data.owner) ||
    !sameScopeRef(data.sourceRef, p.data.sourceRef)
  )
    fail();
  if (
    data.frame.sessionId !== journal.sessionId ||
    data.frame.baseEntryId !== data.sourceRef.entryId ||
    data.frame.baseEntryDigest !== data.sourceRef.digest ||
    view.scopeReviews?.some((r) => r.control.data.frame.requestId === data.frame.requestId)
  )
    fail();
  const old = view.contracts.find((entry) => sameScopeRef(entry, p.data.previousContractRef));
  if (!old || data.contractId !== old.data.contractId || data.revision !== old.data.revision + 1)
    fail();
  if (ownerScopeReviews(view, data.owner).length >= 16) fail();
}
export function scopeRevisionReviewSubject(
  proposal: ScopeRevisionProposalView,
  previousPlan: PreflightProposal,
  contract: ReturnType<typeof contractReviewSubject>,
  previousContract: ReturnType<typeof scopePreviousContractMaterial>,
) {
  return {
    protocol: "goal-scope-revision-review-v1",
    proposalRef: { entryId: proposal.entryId, digest: proposal.digest },
    owner: proposal.data.owner,
    sourceRef: proposal.data.sourceRef,
    approvalRef: proposal.data.approvalRef,
    startRef: proposal.data.startRef,
    previousRevisionRef: proposal.data.previousRevisionRef,
    previousContractRef: proposal.data.previousContractRef,
    previousPlan,
    previousContract,
    plan: proposal.data.plan,
    reason: proposal.data.reason,
    contract,
  };
}
function checkObjects(spec: AcceptanceProposal["checks"][number]) {
  return spec.kind === "manual"
    ? [spec.kind, spec.checkId]
    : [spec.kind, spec.checkId, spec.runtime, spec.checkerRoot, spec.permissionId];
}
export function assertScopeContractObjects(
  previous: AcceptanceProposal,
  next: AcceptanceProposal,
): void {
  if (
    !isDeepStrictEqual(
      [
        previous.scopeId,
        previous.inputs,
        previous.artifacts,
        previous.environment,
        previous.requirements.map((r) => [r.requirementId, r.required]),
        previous.checks.map(checkObjects),
      ],
      [
        next.scopeId,
        next.inputs,
        next.artifacts,
        next.environment,
        next.requirements.map((r) => [r.requirementId, r.required]),
        next.checks.map(checkObjects),
      ],
    )
  )
    throw Error(
      "Scope revision cannot replace scope/input/output/environment or checker capability objects",
    );
}
export function scopePreviousContractMaterial(
  view: AcceptanceJournalView,
  p: ScopeRevisionProposalView,
) {
  const contract = view.contracts.find((c) => sameScopeRef(c, p.data.previousContractRef));
  if (!contract) fail();
  const definitions = contract.data.definitions.map(
    (ref) => view.definitions.find((d) => sameScopeRef(d, ref.ref))?.data,
  );
  if (definitions.some((d) => !d)) fail();
  return { contract: contract.data, definitions: definitions as AcceptanceDefinitionFact[] };
}
export function assertScopeBound(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceDefinitionFact[],
  view: AcceptanceJournalView,
  journal: SessionJournal,
  position: number,
): void {
  if (data.authority.kind !== "scope-revision-reviewed") fail();
  const controlRef = data.authority.controlRef;
  const review = ownerScopeReviews(view, data.owner).find((r) =>
    sameScopeRef(r.control, controlRef),
  );
  if (!review?.witness || review.control.data.value !== "Approve revision") fail();
  scopeNodeBefore(journal, review.witness, position);
  const c = review.control.data,
    p = proposalBefore(view, journal, c.proposalRef, position);
  currentBase(view, p);
  const latest = ownerScopeReviews(view, data.owner).at(-1);
  if (
    latest !== review ||
    c.contractId !== data.contractId ||
    c.revision !== data.revision ||
    !sameScopeRef(data.previousRef, p.data.previousContractRef)
  )
    fail();
  const contract = scopeRevisionContractProposal(journal, p),
    next = { ...data.header, checks: definitions.map((d) => d.spec) };
  if (
    !isDeepStrictEqual(contract.data.proposal, next) ||
    invocationOwnerKey(c.owner) !== invocationOwnerKey(data.owner)
  )
    fail();
  const previous = scopePreviousContractMaterial(view, p);
  assertScopeContractObjects(
    { ...previous.contract.header, checks: previous.definitions.map((d) => d.spec) },
    next,
  );
  const original = scopeProposalBase(journal, p.data, position).plan;
  const previousPlan = scopeEffectivePlan(view, data.owner) ?? original;
  const inner = contractReviewSubject(
    data,
    definitions,
    contract,
    c.versionId,
    c.inputGeneration,
    acceptanceGoalSource(journal, data.owner, data.sourceRef, position),
  );
  if (
    journalDigest(scopeRevisionReviewSubject(p, previousPlan, inner, previous)) !==
    c.frame.scopeDigest
  )
    fail();
  if (
    view.contracts.some(
      (entry) =>
        entry.data.authority.kind === "scope-revision-reviewed" &&
        sameScopeRef(entry.data.authority.controlRef, controlRef),
    )
  )
    fail();
}
function scopeCommitLinks(
  view: AcceptanceJournalView,
  data: ScopeRevisionCommitted,
  p: ScopeRevisionProposalView,
): void {
  const review = ownerScopeReviews(view, data.owner).at(-1),
    contract = view.contracts.find((b) => sameScopeRef(b, data.contractRef));
  if (
    !review?.witness ||
    review.control.data.value !== "Approve revision" ||
    !sameScopeRef(review.control, data.controlRef) ||
    !sameScopeRef(review.witness, data.witnessRef) ||
    !sameScopeRef(review.control.data.proposalRef, p) ||
    !sameScopeRef(data.previousRevisionRef, p.data.previousRevisionRef) ||
    !contract ||
    contract.data.authority.kind !== "scope-revision-reviewed" ||
    !sameScopeRef(contract.data.authority.controlRef, review.control) ||
    !sameScopeRef(data.sourceRef, p.data.sourceRef) ||
    invocationOwnerKey(data.owner) !== invocationOwnerKey(p.data.owner)
  )
    fail();
}
export function assertScopeCommit(
  view: AcceptanceJournalView,
  data: ScopeRevisionCommitted,
  journal: SessionJournal,
  position: number,
): void {
  const p = proposalBefore(view, journal, data.proposalRef, position);
  currentBase(view, p);
  scopeCommitLinks(view, data, p);
  for (const ref of [data.controlRef, data.witnessRef, data.contractRef])
    scopeNodeBefore(journal, ref, position);
  if (view.scopeCommits?.some((item) => sameScopeRef(item.data.controlRef, data.controlRef)))
    fail();
}
export function assertScopeRevocation(
  view: AcceptanceJournalView,
  data: ScopeRevisionRevoked,
  journal: SessionJournal,
  position: number,
): void {
  scopeNodeBefore(journal, data.revisionRef, position);
  const revision = view.scopeCommits?.find((c) => sameScopeRef(c, data.revisionRef));
  if (
    !revision ||
    invocationOwnerKey(revision.data.owner) !== invocationOwnerKey(data.owner) ||
    !sameScopeRef(data.sourceRef, revision.data.sourceRef) ||
    view.scopeRevocations?.some((r) => sameScopeRef(r.data.revisionRef, data.revisionRef))
  )
    fail();
}
