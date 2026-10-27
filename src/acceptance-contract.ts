import type { WorkOwnerKey } from "./control-journal";
import type { TaskRuntime } from "./runtime";
import type { AcceptanceLayers } from "./types";
import { invocationOwnerKey } from "./invocation-tree";
export {
  recognizeAcceptanceSuite,
  recognizedAcceptanceSuite,
  validateAcceptanceProposal,
  AcceptanceProposalSchema,
  type AcceptanceProposal,
} from "./acceptance-proposal";

type LayerCache = Pick<
  TaskRuntime,
  "supervisor" | "board" | "management" | "controlJournal" | "receiptStore"
>;
function cachedLayerContract(runtime: LayerCache) {
  const state = runtime.supervisor,
    mode = runtime.management;
  if (!state || (mode && mode.mode !== "supervised")) return undefined;
  const goalKey = runtime.receiptStore?.ownerGoalId ?? state.goalRunId;
  return runtime.controlJournal?.acceptance?.contracts
    .filter(
      (item) =>
        item.data.owner.kind === "goal" &&
        item.data.owner.goal.sessionId === state.sessionId &&
        item.data.owner.goal.goalKey === goalKey,
    )
    .at(-1);
}
/** Pure cached layer labels, never live eligibility or a person/product-identity claim. */
export function acceptanceLayersFromCache(runtime: LayerCache): AcceptanceLayers {
  const state = runtime.supervisor,
    mode = runtime.management,
    board = runtime.board,
    bound = cachedLayerContract(runtime);
  const common = {
    taskRecords:
      board.tasks.length > 0 && board.tasks.every((task) => task.status === "done")
        ? ("complete" as const)
        : ("incomplete" as const),
    currentApplicability: "unknown" as const,
    realHumanProductAcceptance: "not-inferred" as const,
    definitionQuality: "independent-review-required" as const,
  };
  if (!state || (mode && mode.mode !== "supervised"))
    return {
      ...common,
      hostBindings: 0,
      contract: "not-supervised",
      modelReview: "not-applicable",
      manualResponses: 0,
    };
  const contract: AcceptanceLayers["contract"] = !bound
    ? "legacy-host"
    : state.status === "completed"
      ? "accepted-history"
      : "bound-unchecked";
  return {
    ...common,
    hostBindings: state.bindings.length,
    contract,
    ...(bound ? { contractId: bound.data.contractId, revision: bound.data.revision } : {}),
    modelReview: state.status === "completed" ? "accepted-history" : "not-accepted",
    manualResponses: bound
      ? (runtime.controlJournal?.acceptance?.manualChecks.filter(
          (item) => !!item.witness && item.control.data.contractRef.entryId === bound.entryId,
        ).length ?? 0)
      : 0,
  };
}
export interface AcceptanceReference {
  entryId: string;
  digest: string;
}
export interface RequirementV1 {
  requirementId: string;
  source: string;
  text: string;
  required: boolean;
}
interface CheckDefinitionIdentity {
  checkId: string;
  requirementIds: string[];
  definitionDigest: string;
}
export interface ManualCheckDefinitionV1 extends CheckDefinitionIdentity {
  kind: "manual";
  expectedValue: string;
}
export interface AutomaticCheckDefinitionV1 extends CheckDefinitionIdentity {
  kind: "automatic";
  invocationDigest: string;
  environmentDigest: string;
  checkerDigest: string;
  expected: { minTests: number; requiredCases: string[]; allowedSkipped: string[] };
}
export type CheckDefinitionV1 = AutomaticCheckDefinitionV1 | ManualCheckDefinitionV1;
export interface CheckResultV1 {
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  requiredCases: Record<string, "passed" | "failed" | "skipped">;
  skippedIds: string[];
}
export interface AcceptanceContractV1 {
  version: 1;
  contractId: string;
  revision: number;
  owner: WorkOwnerKey;
  digest: string;
  sourceRef: AcceptanceReference;
  requirements: RequirementV1[];
  checks: CheckDefinitionV1[];
  scopeId: string;
  scopeDigest: string;
}
export interface ContractVersion {
  versionId: string;
  inputGeneration: string;
  qualifiedReceipts?: readonly AcceptanceReference[];
}
interface CheckObservationIdentity {
  checkId: string;
  definitionDigest: string;
  contractDigest: string;
  owner: WorkOwnerKey;
  receiptRef: AcceptanceReference;
  versionId: string;
  inputGeneration: string;
  outcome: "passed" | "failed" | "unknown";
}
export interface ManualCheckObservationV1 extends CheckObservationIdentity {
  kind: "manual";
  value: string;
  controlRef: AcceptanceReference;
  witnessRef: AcceptanceReference;
}
export interface AutomaticCheckObservationV1 extends CheckObservationIdentity {
  kind: "automatic";
  invocationDigest: string;
  environmentDigest: string;
  checkerDigest: string;
  exitCode: number | null;
  result: CheckResultV1;
}
export type CheckObservationV1 = AutomaticCheckObservationV1 | ManualCheckObservationV1;
export interface ContractAcceptance {
  status: "blocked" | "passed" | "unknown";
  code?: "EVIDENCE_MISSING" | "VALIDATION_STALE" | "CONTRACT_CHANGED" | "REVIEW_VIEW_TOO_LARGE";
  missingRequirements: string[];
}
/** Pure deterministic policy over an already source-verified native view. This does not
 * establish trust, run a check, confirm a user response, or grant goal acceptance. */
export function checkContractAcceptance(
  contract: AcceptanceContractV1,
  observations: readonly CheckObservationV1[],
  current: ContractVersion | undefined,
): ContractAcceptance {
  if (!current) return { status: "unknown", code: "VALIDATION_STALE", missingRequirements: [] };
  if (
    contract.requirements.length > 16 ||
    contract.checks.length > 16 ||
    observations.length > 128 ||
    Buffer.byteLength(JSON.stringify(contract), "utf8") > 64000
  )
    return { status: "unknown", code: "REVIEW_VIEW_TOO_LARGE", missingRequirements: [] };
  // The source-verified view supplies causal journal order, never caller timestamps.
  const latest = new Map<string, CheckObservationV1>();
  for (const observation of observations)
    if (
      observation.contractDigest === contract.digest &&
      invocationOwnerKey(observation.owner) === invocationOwnerKey(contract.owner)
    )
      latest.set(observation.checkId, observation);
  const missingRequirements = contract.requirements
    .filter(
      (requirement) =>
        requirement.required &&
        !contract.checks.some((check) => {
          const observation = latest.get(check.checkId);
          return (
            check.requirementIds.includes(requirement.requirementId) &&
            !!observation &&
            applicableCheck(contract, check, observation, current)
          );
        }),
    )
    .map((requirement) => requirement.requirementId);
  return missingRequirements.length
    ? {
        status: "blocked",
        code: missingCheckCode(contract, latest, current, missingRequirements),
        missingRequirements,
      }
    : { status: "passed", missingRequirements: [] };
}
function missingCheckCode(
  contract: AcceptanceContractV1,
  latest: ReadonlyMap<string, CheckObservationV1>,
  current: ContractVersion,
  missing: readonly string[],
): ContractAcceptance["code"] {
  const candidates = contract.checks.filter((check) =>
    check.requirementIds.some((id) => missing.includes(id)),
  );
  if (
    candidates.some((check) => {
      const observation = latest.get(check.checkId);
      return observation && observation.definitionDigest !== check.definitionDigest;
    })
  )
    return "CONTRACT_CHANGED";
  if (
    candidates.some((check) => {
      const observation = latest.get(check.checkId);
      return (
        observation &&
        (observation.versionId !== current.versionId ||
          observation.inputGeneration !== current.inputGeneration)
      );
    })
  )
    return "VALIDATION_STALE";
  return "EVIDENCE_MISSING";
}
export function checkResultPassed(
  check: AutomaticCheckDefinitionV1,
  result: CheckResultV1,
): boolean {
  const counts = [result.tests, result.passed, result.failed, result.skipped];
  return (
    counts.every((value) => Number.isSafeInteger(value) && value >= 0) &&
    result.tests >= Math.max(1, check.expected.minTests) &&
    result.tests === result.passed + result.failed + result.skipped &&
    result.failed === 0 &&
    result.passed > 0 &&
    result.skipped === result.skippedIds.length &&
    new Set(result.skippedIds).size === result.skippedIds.length &&
    result.skippedIds.every((id) => check.expected.allowedSkipped.includes(id)) &&
    check.expected.requiredCases.every((id) => result.requiredCases[id] === "passed")
  );
}
function currentObservation(
  contract: AcceptanceContractV1,
  check: CheckDefinitionV1,
  observation: CheckObservationV1,
  current: ContractVersion,
): boolean {
  return (
    (observation.checkId === check.checkId &&
      observation.contractDigest === contract.digest &&
      invocationOwnerKey(observation.owner) === invocationOwnerKey(contract.owner) &&
      observation.definitionDigest === check.definitionDigest &&
      observation.versionId === current.versionId &&
      observation.inputGeneration === current.inputGeneration &&
      current.qualifiedReceipts?.some(
        (ref) =>
          ref.entryId === observation.receiptRef.entryId &&
          ref.digest === observation.receiptRef.digest,
      ) &&
      observation.outcome === "passed") === true
  );
}
function applicableCheck(
  contract: AcceptanceContractV1,
  check: CheckDefinitionV1,
  observation: CheckObservationV1,
  current: ContractVersion,
): boolean {
  if (!currentObservation(contract, check, observation, current)) return false;
  if (check.kind === "manual" && observation.kind === "manual")
    return (
      observation.value === check.expectedValue &&
      !!observation.controlRef.entryId &&
      !!observation.witnessRef.entryId &&
      observation.controlRef.entryId !== observation.witnessRef.entryId
    );
  return (
    check.kind === "automatic" &&
    observation.kind === "automatic" &&
    observation.invocationDigest === check.invocationDigest &&
    observation.environmentDigest === check.environmentDigest &&
    observation.checkerDigest === check.checkerDigest &&
    observation.exitCode === 0 &&
    checkResultPassed(check, observation.result)
  );
}
