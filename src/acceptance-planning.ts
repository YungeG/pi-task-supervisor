import { Type } from "typebox";
import { Check } from "typebox/value";
import {
  WorkOwnerSchema,
  validWorkOwner,
  ControlJournalError,
  type WorkOwnerKey,
} from "./control-journal";
const PREFLIGHT_ENTRY = "continuous-tasks:preflight";
function preflightBody(
  value: unknown,
): { sessionId: string; preflightId: string; goal: string } | undefined {
  const body = isGoalCarrier(value) ? value.snapshot : value;
  if (
    !body ||
    typeof body !== "object" ||
    !("version" in body) ||
    (body.version !== 1 && body.version !== 2) ||
    !("sessionId" in body) ||
    typeof body.sessionId !== "string" ||
    !("preflightId" in body) ||
    typeof body.preflightId !== "string" ||
    !("goal" in body) ||
    typeof body.goal !== "string" ||
    Buffer.byteLength(body.goal) > 4000
  )
    return undefined;
  return { sessionId: body.sessionId, preflightId: body.preflightId, goal: body.goal };
}
import { isGoalCarrier } from "./goal-records";
import { journalDigest, type SessionJournal, type JournalNode } from "./human-journal";
import { invocationOwnerKey } from "./invocation-tree";
import {
  AcceptanceProposalSchema,
  validateAcceptanceProposal,
  type AcceptanceProposal,
} from "./acceptance-proposal";
import type { AcceptanceReference } from "./acceptance-contract";
export const ACCEPTANCE_PROPOSAL_ENTRY = "continuous-tasks:acceptance-proposal";
export interface ContractProposalRecord {
  version: 1;
  sessionId: string;
  proposalId: string;
  sourceRef: AcceptanceReference;
  target: { kind: "preflight"; preflightId: string } | { kind: "goal"; owner: WorkOwnerKey };
  proposal: AcceptanceProposal;
}
export interface ContractProposalView extends AcceptanceReference {
  data: ContractProposalRecord;
}
const strict = { additionalProperties: false } as const,
  id = (max = 200) => Type.String({ minLength: 1, maxLength: max }),
  hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
function recordSchema() {
  return Type.Unsafe<ContractProposalRecord>(
    Type.Object(
      {
        version: Type.Literal(1),
        sessionId: id(),
        proposalId: id(),
        sourceRef: Type.Object({ entryId: id(), digest: hash }, strict),
        target: Type.Union([
          Type.Object({ kind: Type.Literal("preflight"), preflightId: id() }, strict),
          Type.Object({ kind: Type.Literal("goal"), owner: WorkOwnerSchema }, strict),
        ]),
        proposal: AcceptanceProposalSchema,
      },
      strict,
    ),
  );
}
export function validContractProposal(
  value: unknown,
  sessionId: string,
): value is ContractProposalRecord {
  return (
    Check(recordSchema(), value) &&
    value.sessionId === sessionId &&
    Buffer.byteLength(JSON.stringify(value), "utf8") <= 64000 &&
    (value.target.kind === "preflight" ||
      (validWorkOwner(value.target.owner) &&
        value.target.owner.kind === "goal" &&
        value.target.owner.goal.sessionId === sessionId))
  );
}
function bad(): never {
  throw new ControlJournalError("CONTROL_FORMAT_INVALID");
}
function goalProposalSource(owner: WorkOwnerKey, source: JournalNode): string {
  const proof = source.supervisorProof;
  if (
    owner.kind !== "goal" ||
    proof?.sessionId !== owner.goal.sessionId ||
    proof.goalKey !== owner.goal.goalKey ||
    (owner.goal.lifecycleCommitId !== null &&
      proof.lifecycleCommitId !== owner.goal.lifecycleCommitId) ||
    typeof proof.goalText !== "string"
  )
    bad();
  return proof.goalText;
}
export function proposalOriginalGoal(
  journal: SessionJournal,
  data: ContractProposalRecord,
  position: number,
): string {
  const source = journal.nodes.get(data.sourceRef.entryId),
    index = journal.branch.findIndex((node) => node.id === data.sourceRef.entryId);
  if (!source || source.digest !== data.sourceRef.digest || index < 0 || index >= position) bad();
  if (data.target.kind === "goal") return goalProposalSource(data.target.owner, source);
  const body = preflightBody(source.data);
  if (
    source.customType !== PREFLIGHT_ENTRY ||
    !body ||
    body.sessionId !== data.sessionId ||
    body.preflightId !== data.target.preflightId
  )
    bad();
  return body.goal;
}
export function contractProposalViews(journal: SessionJournal): ContractProposalView[] {
  const result: ContractProposalView[] = [];
  for (const [position, node] of journal.branch.entries()) {
    if (node.customType !== ACCEPTANCE_PROPOSAL_ENTRY) continue;
    if (!validContractProposal(node.data, journal.sessionId)) bad();
    const data = node.data;
    if (result.some((item) => item.data.proposalId === data.proposalId)) bad();
    validateAcceptanceProposal(node.data.proposal);
    proposalOriginalGoal(journal, node.data, position);
    result.push({ entryId: node.id, digest: node.digest, data: node.data });
  }
  return result;
}
export function proposalForGoal(
  journal: SessionJournal,
  proposal: ContractProposalView,
  owner: WorkOwnerKey,
  sourceRef: AcceptanceReference,
): void {
  if (owner.kind !== "goal" || proposal.data.sessionId !== owner.goal.sessionId) bad();
  const source = journal.nodes.get(sourceRef.entryId),
    proof = source?.supervisorProof;
  if (
    !source ||
    source.digest !== sourceRef.digest ||
    proof?.goalKey !== owner.goal.goalKey ||
    proof.sessionId !== owner.goal.sessionId ||
    (owner.goal.lifecycleCommitId !== null &&
      proof.lifecycleCommitId !== owner.goal.lifecycleCommitId)
  )
    bad();
  const target = proposal.data.target;
  if (
    target.kind === "goal"
      ? invocationOwnerKey(target.owner) !== invocationOwnerKey(owner)
      : proof.preflightId !== target.preflightId
  )
    bad();
  if (proposalOriginalGoal(journal, proposal.data, journal.branch.length) !== proof.goalText) bad();
}
export function proposalTargetKey(data: ContractProposalRecord): string {
  return journalDigest([
    data.sessionId,
    data.target.kind,
    data.target.kind === "goal" ? invocationOwnerKey(data.target.owner) : data.target.preflightId,
  ]);
}
export function proposalSourceNode(
  journal: SessionJournal,
  prefId: string,
): JournalNode | undefined {
  return [...journal.branch].reverse().find((node) => {
    if (node.customType !== PREFLIGHT_ENTRY) return false;
    const body = preflightBody(node.data);
    return !!body && body.sessionId === journal.sessionId && body.preflightId === prefId;
  });
}
