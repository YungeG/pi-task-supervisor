import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime, type TaskRuntime } from "./runtime";
import { currentWorkOwner, type WorkOwnerKey } from "./control-journal";
import { captureManagementSnapshot } from "./management-policy";
import { goalLease } from "./goal-scope";
import { journalDigest } from "./human-journal";
import { captureWorkspaceArtifactVersion } from "./artifact-version";
import type { HostReceipt } from "./receipt-store";
import {
  invocationOwnerKey,
  qualificationKey,
  type EligibilityView,
  type InvocationReference,
} from "./invocation-tree";

export interface InvocationFrame {
  runtime: TaskRuntime;
  manager: ExtensionContext["sessionManager"];
  sessionId: string;
  path: string | undefined;
  owner: WorkOwnerKey;
  modeRef: InvocationReference | null;
  goalToken: string;
  humanEpoch: number;
}
export function captureInvocationFrame(
  ctx: ExtensionContext,
  owner: WorkOwnerKey,
): InvocationFrame {
  const record = currentRuntime().management?.record;
  return {
    runtime: currentRuntime(),
    manager: ctx.sessionManager,
    sessionId: ctx.sessionManager.getSessionId(),
    path: ctx.sessionManager.getSessionFile(),
    owner,
    modeRef: record ? { entryId: record.entryId, digest: record.digest } : null,
    goalToken: goalLease(),
    humanEpoch: currentRuntime().humanEpoch,
  };
}
export function invocationCarrierCurrent(ctx: ExtensionContext, frame: InvocationFrame): boolean {
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  return (
    currentRuntime() === frame.runtime &&
    ctx.sessionManager === frame.manager &&
    ctx.sessionManager.getSessionId() === frame.sessionId &&
    ctx.sessionManager.getSessionFile() === frame.path &&
    !!owner &&
    invocationOwnerKey(owner) === invocationOwnerKey(frame.owner)
  );
}
export function invocationFrameCurrent(ctx: ExtensionContext, frame: InvocationFrame): boolean {
  if (
    !invocationCarrierCurrent(ctx, frame) ||
    frame.humanEpoch !== currentRuntime().humanEpoch ||
    frame.goalToken !== goalLease()
  )
    return false;
  const mode = captureManagementSnapshot(ctx),
    ref = mode.record ? { entryId: mode.record.entryId, digest: mode.record.digest } : null;
  return (
    mode.state === "active" &&
    mode.mode === "supervised" &&
    journalDigest(ref) === journalDigest(frame.modeRef)
  );
}
export interface QualifiedEvidence {
  receipt: HostReceipt;
  eligible: boolean;
  effectiveEpoch: number;
  qualification?: EligibilityView;
}
function directEvidence(
  receipt: HostReceipt,
  taskId: string,
  taskDigest: string,
  epoch: number,
): boolean {
  return (
    receipt.ok &&
    receipt.eligible !== false &&
    receipt.epoch === epoch &&
    receipt.reviews.some((review) => review.taskId === taskId && review.digest === taskDigest) &&
    !currentRuntime().receiptStore?.pendingCount
  );
}
function matchingAttestation(
  ctx: ExtensionContext,
  owner: WorkOwnerKey,
  receipt: HostReceipt,
  taskId: string,
  taskDigest: string,
  epoch: number,
): EligibilityView | undefined {
  const graph = currentRuntime().controlJournal?.invocations,
    qualification = graph?.qualifications.get(qualificationKey(owner, receipt.id, taskId));
  if (!qualification || graph?.active.size) return undefined;
  const data = qualification.data,
    node = graph?.nodes.get(data.operationId),
    frame = node && currentRuntime().invocation?.frames.get(node.rootId);
  return frame &&
    invocationFrameCurrent(ctx, frame) &&
    data.receiptDigest === receipt.digest &&
    data.taskDigest === taskDigest &&
    data.epoch === epoch
    ? qualification
    : undefined;
}
export function qualificationProjection(
  ctx: ExtensionContext,
  receipts: readonly HostReceipt[],
  epoch: number,
) {
  const selected = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  return [...(currentRuntime().controlJournal?.invocations?.qualifications.values() ?? [])].flatMap(
    (qualification) => {
      const data = qualification.data,
        receipt = selected.get(data.receiptId);
      if (!receipt) return [];
      const effective = qualifiedEvidence(receipt, data.taskId, data.taskDigest, epoch, ctx);
      return [
        {
          receiptId: receipt.id,
          originalDigest: receipt.digest,
          originalEligible: receipt.eligible,
          originalEpoch: receipt.epoch,
          taskId: data.taskId,
          effectiveEpoch: effective.effectiveEpoch,
          eligible: effective.eligible,
          sourceRef: qualification.ref,
          rootSealRef: data.rootSealRef,
          versionId: data.artifactVersion.versionId,
        },
      ];
    },
  );
}
/** Original body/hash/eligible/epoch are always returned unchanged, never promoted in place. */
export function qualifiedEvidence(
  receipt: HostReceipt,
  taskId: string,
  taskDigest: string,
  epoch: number,
  ctx?: ExtensionContext,
): QualifiedEvidence {
  if (directEvidence(receipt, taskId, taskDigest, epoch))
    return { receipt, eligible: true, effectiveEpoch: receipt.epoch };
  const rejected: QualifiedEvidence = { receipt, eligible: false, effectiveEpoch: receipt.epoch };
  if (
    !ctx ||
    !receipt.ok ||
    receipt.exitCode !== 0 ||
    receipt.eligible !== false ||
    currentRuntime().journalFault ||
    currentRuntime().receiptStore?.pendingCount
  )
    return rejected;
  const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!owner) return rejected;
  const qualification = matchingAttestation(ctx, owner, receipt, taskId, taskDigest, epoch);
  if (!qualification) return rejected;
  const data = qualification.data;
  const captured = captureWorkspaceArtifactVersion(
    ctx.cwd,
    owner,
    ctx.sessionManager.getSessionFile(),
  );
  if (captured.status !== "known" || captured.version.versionId !== data.artifactVersion.versionId)
    return rejected;
  return { receipt, eligible: true, effectiveEpoch: data.epoch, qualification };
}
