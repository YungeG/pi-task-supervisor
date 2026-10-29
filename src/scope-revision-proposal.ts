import { Type } from "typebox";
import { Check } from "typebox/value";
import { isDeepStrictEqual } from "node:util";
import {
  NativePreflightStateSchema,
  confirmedPreflightControlSource,
  confirmedPreflightStartSource,
  type PreflightProposal,
  type PreflightState,
} from "./preflight";
import {
  contractProposalViews,
  proposalForGoal,
  type ContractProposalView,
} from "./acceptance-planning";
import { isGoalCarrier } from "./goal-records";
import { PreflightProposalSchema } from "./preflight-proposal-schema";
import type { SessionJournal, JournalNode } from "./human-journal";
import {
  validWorkOwner,
  validControlFence,
  ControlJournalError,
  type WorkOwnerKey,
} from "./control-journal";
import { invocationOwnerKey } from "./invocation-tree";
import type { AcceptanceReference } from "./acceptance-contract";
export const SCOPE_REVISION_PROPOSAL_ENTRY = "continuous-tasks:scope-revision-proposal";
export interface ScopeRevisionProposal {
  version: 1;
  sessionId: string;
  proposalId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  basePreflightRef: AcceptanceReference;
  approvalRef: AcceptanceReference;
  startRef: AcceptanceReference;
  previousRevisionRef: AcceptanceReference | null;
  previousContractRef: AcceptanceReference;
  contractProposalRef: AcceptanceReference;
  plan: PreflightProposal;
  reason: string;
}
export interface ScopeRevisionProposalView extends AcceptanceReference {
  data: ScopeRevisionProposal;
}
const strict = { additionalProperties: false } as const;
const id = (max = 200) => Type.String({ minLength: 1, maxLength: max });
const reference = Type.Object(
  { entryId: id(), digest: Type.String({ pattern: "^[a-f0-9]{64}$" }) },
  strict,
);
const ScopeRevisionProposalSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: id(),
    proposalId: id(),
    owner: Type.Unknown(),
    sourceRef: reference,
    basePreflightRef: reference,
    approvalRef: reference,
    startRef: reference,
    previousRevisionRef: Type.Union([reference, Type.Null()]),
    previousContractRef: reference,
    contractProposalRef: reference,
    plan: PreflightProposalSchema,
    reason: id(2000),
  },
  strict,
);
function bad(): never {
  throw new ControlJournalError("CONTROL_FORMAT_INVALID");
}
export function scopeNodeBefore(
  journal: SessionJournal,
  ref: AcceptanceReference,
  position: number,
): JournalNode {
  const node = journal.nodes.get(ref.entryId),
    index = journal.branch.findIndex((item) => item.id === ref.entryId);
  if (!node || node.digest !== ref.digest || index < 0 || index >= position) bad();
  return node;
}
export function validScopeRevisionProposal(
  value: unknown,
  sessionId: string,
): value is ScopeRevisionProposal {
  return (
    Check(ScopeRevisionProposalSchema, value) &&
    value.sessionId === sessionId &&
    validWorkOwner(value.owner) &&
    value.owner.kind === "goal" &&
    value.owner.goal.sessionId === sessionId &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 64000
  );
}
function permissionObjects(plan: PreflightProposal) {
  return plan.permissions.map((p) => [p.id, p.action, p.target, p.environment, p.required]);
}
export function assertScopePlanObjects(
  original: PreflightProposal,
  replacement: PreflightProposal,
): void {
  if (
    !isDeepStrictEqual(permissionObjects(original), permissionObjects(replacement)) ||
    !isDeepStrictEqual(original.prohibitions, replacement.prohibitions) ||
    !isDeepStrictEqual(original.preparation, replacement.preparation)
  )
    throw Error(
      "Scope revision cannot add/change permission objects, prohibitions or preparation capabilities",
    );
}
function assertGoalScope(
  view: ScopeRevisionProposal,
  scope: { goalRunId: string; lifecycleCommitId: string } | undefined,
): void {
  if (view.owner.kind !== "goal") bad();
  if (
    scope
      ? scope.goalRunId !== view.owner.goal.goalRunId ||
        scope.lifecycleCommitId !== view.owner.goal.lifecycleCommitId
      : view.owner.goal.goalRunId !== null || view.owner.goal.lifecycleCommitId !== null
  )
    bad();
}
function assertScopeBaseSources(
  base: PreflightState,
  grant: ReturnType<typeof confirmedPreflightControlSource>,
  start: ReturnType<typeof confirmedPreflightStartSource>,
  data: ScopeRevisionProposal,
): void {
  if (
    grant.control.kind !== "approve" ||
    grant.base.planDigest !== base.planDigest ||
    start.base.planDigest !== base.planDigest ||
    base.approval?.controlEntryId !== data.approvalRef.entryId ||
    base.goal !== start.base.goal ||
    grant.base.goal !== base.goal ||
    !isDeepStrictEqual(base.proposal, grant.base.proposal) ||
    !isDeepStrictEqual(base.approval.permissionIds, grant.control.permissionIds)
  )
    bad();
}
export function scopeProposalBase(
  journal: SessionJournal,
  data: ScopeRevisionProposal,
  position: number,
) {
  const source = scopeNodeBefore(journal, data.basePreflightRef, position),
    stored = source.data,
    base = isGoalCarrier(stored) ? stored.snapshot : stored;
  if (
    source.customType !== "continuous-tasks:preflight" ||
    !Check(NativePreflightStateSchema, base) ||
    !base.proposal ||
    !base.approval ||
    !base.started ||
    base.phase !== "started"
  )
    bad();
  const grant = confirmedPreflightControlSource(journal, data.approvalRef),
    start = confirmedPreflightStartSource(journal, data.startRef);
  assertScopeBaseSources(base, grant, start, data);
  if ("controlEntryId" in base.started && base.started.controlEntryId !== data.startRef.entryId)
    bad();
  if (
    journal.branch.indexOf(grant.proof.witness) >= journal.branch.indexOf(source) ||
    journal.branch.indexOf(start.proof.witness) >= journal.branch.indexOf(source)
  )
    bad();
  const currentGrant = journal.branch
    .slice(0, position)
    .filter(
      (node) =>
        node.customType === "continuous-tasks:preflight-control" &&
        node.data &&
        typeof node.data === "object" &&
        "preflightId" in node.data &&
        node.data.preflightId === base.preflightId &&
        "planDigest" in node.data &&
        node.data.planDigest === base.planDigest &&
        "kind" in node.data &&
        ["approve", "reject", "revoke"].includes(String(node.data.kind)),
    )
    .at(-1);
  if (currentGrant?.id !== data.approvalRef.entryId) bad();
  assertGoalScope(data, grant.goalScope);
  assertGoalScope(data, start.goalScope);
  assertScopePlanObjects(base.proposal, data.plan);
  return { plan: base.proposal };
}
function assertScopeContract(
  proposal: ContractProposalView,
  journal: SessionJournal,
  data: ScopeRevisionProposal,
  position: number,
): void {
  proposalForGoal(journal, proposal, data.owner, data.sourceRef);
  if (data.plan.contractProposalId !== proposal.data.proposalId) bad();
  const old = scopeNodeBefore(journal, data.previousContractRef, position).data;
  if (
    !old ||
    typeof old !== "object" ||
    !("kind" in old) ||
    old.kind !== "acceptance-contract-bound" ||
    !("owner" in old) ||
    !validWorkOwner(old.owner) ||
    invocationOwnerKey(old.owner) !== invocationOwnerKey(data.owner)
  )
    bad();
}
export function scopeRevisionProposalViews(journal: SessionJournal): ScopeRevisionProposalView[] {
  if (!journal.branch.some((node) => node.customType === SCOPE_REVISION_PROPOSAL_ENTRY)) return [];
  const contracts = contractProposalViews(journal),
    views: ScopeRevisionProposalView[] = [];
  for (const [position, node] of journal.branch.entries()) {
    if (node.customType !== SCOPE_REVISION_PROPOSAL_ENTRY) continue;
    if (!validScopeRevisionProposal(node.data, journal.sessionId)) bad();
    const data = node.data;
    if (
      !journal.branch
        .slice(0, position)
        .some(
          (entry) =>
            entry.customType === "continuous-tasks:supervisor" &&
            validControlFence(entry.data) &&
            entry.data.features.includes("scope-revision-v1"),
        )
    )
      bad();
    if (views.some((view) => view.data.proposalId === data.proposalId)) bad();
    if (
      views.filter((view) => invocationOwnerKey(view.data.owner) === invocationOwnerKey(data.owner))
        .length >= 8
    )
      bad();
    scopeNodeBefore(journal, data.sourceRef, position);
    scopeProposalBase(journal, data, position);
    const contract = contracts.find(
      (view) =>
        view.entryId === data.contractProposalRef.entryId &&
        view.digest === data.contractProposalRef.digest,
    );
    if (!contract) bad();
    scopeNodeBefore(journal, data.contractProposalRef, position);
    assertScopeContract(contract, journal, data, position);
    views.push({ entryId: node.id, digest: node.digest, data });
  }
  return views;
}
export function scopeRevisionContractProposal(
  journal: SessionJournal,
  proposal: ScopeRevisionProposalView,
): ContractProposalView {
  const found = contractProposalViews(journal).find(
    (view) =>
      view.entryId === proposal.data.contractProposalRef.entryId &&
      view.digest === proposal.data.contractProposalRef.digest,
  );
  if (!found) bad();
  return found;
}
