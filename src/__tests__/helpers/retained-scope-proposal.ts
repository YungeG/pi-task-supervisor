// Historical scope-v1 producer seam, before submission reviewability checks.
// Use only to retain an already-saved oversized candidate in an owned journal.
// Approval/Start/witness bytes come from the real native-component fixture;
// this does not synthesize an answer, commit, evidence, or execution permission.
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import type { ProposeScopeRevisionParams } from "../../scope-revision-schema";
import { currentRuntime } from "../../runtime";
import { scopeRevisionContractContext, proposeAcceptanceContract } from "../../acceptance-runtime";
import { ownerSnapshot } from "../../goal-scope";
import { journalDigest } from "../../human-journal";
import { inspectRestorableSession } from "../../human-control";
import { canonicalPreflightProposal, PREFLIGHT_ENTRY } from "../../preflight";
import {
  appendControlFence,
  captureControlLease,
  assertLease,
  readControlJournal,
} from "../../control-journal";
import { contractProposalViews } from "../../acceptance-planning";
import {
  SCOPE_REVISION_PROPOSAL_ENTRY,
  scopeProposalBase,
  scopeRevisionProposalViews,
  assertScopePlanObjects,
} from "../../scope-revision-proposal";
import { selectedScopeRevision, assertScopeContractObjects } from "../../scope-revision-journal";

export function retainScopeV1Candidate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: Static<typeof ProposeScopeRevisionParams>,
) {
  const source = scopeRevisionContractContext(ctx, "proposal"),
    state = currentRuntime().preflight;
  if (
    !state ||
    state.version !== 2 ||
    !state.proposal ||
    !state.approval ||
    !state.started ||
    !("controlEntryId" in state.started)
  )
    throw Error("Historical producer requires original native approval and first Start");
  const base = source.journal.branch
      .filter(
        (n) =>
          n.customType === PREFLIGHT_ENTRY &&
          journalDigest(ownerSnapshot(n.data, "preflight")) === journalDigest(state),
      )
      .at(-1),
    approval = source.journal.nodes.get(state.approval.controlEntryId),
    start = source.journal.nodes.get(state.started.controlEntryId);
  if (!base || !approval || !start) throw Error("Historical producer original sources missing");
  assertScopePlanObjects(state.proposal, input.plan);
  assertScopeContractObjects(source.proposal, input.contract);
  const proposed = proposeAcceptanceContract(pi, ctx, input.contract, true),
    journal = inspectRestorableSession(ctx, true);
  const contract =
    journal &&
    contractProposalViews(journal).find((p) => p.data.proposalId === proposed.proposalId);
  if (!journal || !contract) throw Error("Historical contract source missing");
  const ref = (entry: { id: string; digest: string }) => ({
    entryId: entry.id,
    digest: entry.digest,
  });
  const previous = selectedScopeRevision(source.view.acceptance, source.owner),
    plan = { ...input.plan, contractProposalId: proposed.proposalId };
  canonicalPreflightProposal(source.goal, plan);
  const data = {
    version: 1 as const,
    sessionId: journal.sessionId,
    proposalId: randomUUID(),
    owner: source.owner,
    sourceRef: source.sourceRef,
    basePreflightRef: ref(base),
    approvalRef: ref(approval),
    startRef: ref(start),
    previousRevisionRef: previous ? { entryId: previous.entryId, digest: previous.digest } : null,
    previousContractRef: { entryId: source.bound.entryId, digest: source.bound.digest },
    contractProposalRef: { entryId: contract.entryId, digest: contract.digest },
    plan,
    reason: input.reason,
  };
  scopeProposalBase(journal, data, journal.branch.length);
  const features = readControlJournal(ctx).latestFence?.data.features ?? [];
  if (!features.includes("scope-revision-v1"))
    appendControlFence(pi, ctx, [...features, "scope-revision-v1"]);
  const lease = captureControlLease(ctx);
  pi.appendEntry(SCOPE_REVISION_PROPOSAL_ENTRY, data);
  assertLease(ctx, lease, ctx.sessionManager.getLeafId());
  const saved = inspectRestorableSession(ctx, true),
    result =
      saved && scopeRevisionProposalViews(saved).find((p) => p.data.proposalId === data.proposalId);
  if (!result) throw Error("Historical candidate was not physically saved");
  currentRuntime().controlJournal = readControlJournal(ctx);
  return result;
}
