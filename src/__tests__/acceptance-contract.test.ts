// Approved seam: volume03 C3 / t-6.2 deterministic contract gate. Pure value probes
// are not native execution, contract-confirmation or real-human qualification.
import { expect, it } from "vitest";
import {
  checkContractAcceptance,
  type AcceptanceContractV1,
  type CheckObservationV1,
} from "../acceptance-contract";
const owner = {
  kind: "goal" as const,
  goal: { sessionId: "owned", goalKey: "goal", goalRunId: null, lifecycleCommitId: null },
};
const contract: AcceptanceContractV1 = {
  version: 1,
  contractId: "owned-contract",
  revision: 1,
  owner,
  digest: "c".repeat(64),
  sourceRef: { entryId: "owned-spec", digest: "a".repeat(64) },
  requirements: [
    {
      requirementId: "tests",
      source: "approved specification: tests",
      text: "At least one actual required test passes",
      required: true,
    },
  ],
  checks: [
    {
      checkId: "unit",
      requirementIds: ["tests"],
      definitionDigest: "d".repeat(64),
      kind: "automatic",
      invocationDigest: "1".repeat(64),
      environmentDigest: "2".repeat(64),
      checkerDigest: "3".repeat(64),
      expected: { minTests: 1, requiredCases: ["must"], allowedSkipped: [] },
    },
  ],
  scopeId: "owned-inputs",
  scopeDigest: "b".repeat(64),
};
const receiptRef = { entryId: "pure-observation", digest: "4".repeat(64) };
const observation: CheckObservationV1 = {
  checkId: "unit",
  definitionDigest: "d".repeat(64),
  contractDigest: contract.digest,
  owner,
  receiptRef,
  versionId: "v1",
  inputGeneration: "g1",
  kind: "automatic",
  invocationDigest: "1".repeat(64),
  environmentDigest: "2".repeat(64),
  checkerDigest: "3".repeat(64),
  outcome: "passed",
  exitCode: 0,
  result: {
    tests: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    requiredCases: { must: "passed" },
    skippedIds: [],
  },
};
it("allows a source-qualified actual-definition result to cover its required condition", () => {
  expect(
    checkContractAcceptance(contract, [observation], {
      versionId: "v1",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef],
    }),
  ).toMatchObject({ status: "passed", missingRequirements: [] });
});
it("does not select an older pass around a later actual failed check of the same contract", () => {
  const failure: CheckObservationV1 = {
    ...observation,
    receiptRef: { entryId: "later-failure", digest: "5".repeat(64) },
    outcome: "failed",
    exitCode: 1,
    result: { ...observation.result, passed: 0, failed: 1, requiredCases: { must: "failed" } },
  };
  expect(
    checkContractAcceptance(contract, [observation, failure], {
      versionId: "v1",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef, failure.receiptRef],
    }),
  ).toMatchObject({ status: "blocked", missingRequirements: ["tests"] });
});
it.each([
  "noop-invocation",
  "environment",
  "checker-bytes",
  "definition",
  "contract",
  "version",
  "generation",
  "zero-tests",
  "required-skip",
  "disallowed-skip",
  "receipt-source",
  "no-qualification",
])("rejects %s rather than trusting a passed label or exit zero", (kind) => {
  const value = structuredClone(observation),
    current = { versionId: "v1", inputGeneration: "g1", qualifiedReceipts: [receiptRef] };
  if (kind === "noop-invocation") value.invocationDigest = "0".repeat(64);
  if (kind === "environment") value.environmentDigest = "0".repeat(64);
  if (kind === "checker-bytes") value.checkerDigest = "0".repeat(64);
  if (kind === "definition") value.definitionDigest = "0".repeat(64);
  if (kind === "contract") value.contractDigest = "0".repeat(64);
  if (kind === "version") value.versionId = "old";
  if (kind === "generation") value.inputGeneration = "old";
  if (kind === "zero-tests")
    value.result = {
      tests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      requiredCases: {},
      skippedIds: [],
    };
  if (kind === "required-skip")
    value.result = {
      tests: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      requiredCases: { must: "skipped" },
      skippedIds: ["must"],
    };
  if (kind === "disallowed-skip")
    value.result = {
      tests: 2,
      passed: 1,
      failed: 0,
      skipped: 1,
      requiredCases: { must: "passed" },
      skippedIds: ["optional"],
    };
  if (kind === "receipt-source") value.receiptRef = { ...receiptRef, digest: "0".repeat(64) };
  if (kind === "no-qualification") current.qualifiedReceipts = [];
  expect(checkContractAcceptance(contract, [value], current).status).toBe("blocked");
});
it("requires a separately source-qualified physical manual answer for the current version", () => {
  const manual: AcceptanceContractV1 = {
    ...contract,
    checks: [
      {
        checkId: "manual",
        requirementIds: ["tests"],
        definitionDigest: "d".repeat(64),
        kind: "manual",
        expectedValue: "accepted",
      },
    ],
  };
  const answer: CheckObservationV1 = {
    checkId: "manual",
    definitionDigest: "d".repeat(64),
    contractDigest: contract.digest,
    owner,
    receiptRef,
    versionId: "v1",
    inputGeneration: "g1",
    kind: "manual",
    outcome: "passed",
    value: "accepted",
    controlRef: { entryId: "actual-control", digest: "8".repeat(64) },
    witnessRef: { entryId: "physical-witness", digest: "9".repeat(64) },
  };
  expect(
    checkContractAcceptance(manual, [answer], { versionId: "v1", inputGeneration: "g1" }).status,
  ).toBe("blocked");
  expect(
    checkContractAcceptance(manual, [answer], {
      versionId: "v1",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef],
    }).status,
  ).toBe("passed");
  expect(
    checkContractAcceptance(manual, [{ ...answer, value: "rejected" }], {
      versionId: "v1",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef],
    }).status,
  ).toBe("blocked");
});
it("does not call an unavailable current capture same/fresh", () => {
  expect(checkContractAcceptance(contract, [observation], undefined)).toMatchObject({
    status: "unknown",
    code: "VALIDATION_STALE",
  });
});
it("holds capacity rather than dropping even optional declared conditions", () => {
  const oversized = {
    ...contract,
    requirements: [
      ...contract.requirements,
      ...Array.from({ length: 16 }, (_, index) => ({
        requirementId: `optional-${index}`,
        source: "approved spec",
        text: "optional",
        required: false,
      })),
    ],
  };
  expect(
    checkContractAcceptance(oversized, [observation], {
      versionId: "v1",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef],
    }),
  ).toMatchObject({ status: "unknown", code: "REVIEW_VIEW_TOO_LARGE" });
});
it("reports stale versions distinctly from missing check material", () => {
  expect(
    checkContractAcceptance(contract, [observation], {
      versionId: "v2",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef],
    }),
  ).toMatchObject({ status: "blocked", code: "VALIDATION_STALE" });
});
it("does not let an entirely skipped suite cover a required condition even when optional skips are allowed", () => {
  const check = contract.checks[0];
  if (!check || check.kind !== "automatic") throw Error("Automatic owned policy fixture missing");
  const onlyOptional = {
    ...contract,
    checks: [
      { ...check, expected: { minTests: 1, requiredCases: [], allowedSkipped: ["optional"] } },
    ],
  };
  const skipped = {
    ...observation,
    result: {
      tests: 1,
      passed: 0,
      failed: 0,
      skipped: 1,
      requiredCases: {},
      skippedIds: ["optional"],
    },
  };
  expect(
    checkContractAcceptance(onlyOptional, [skipped], {
      versionId: "v1",
      inputGeneration: "g1",
      qualifiedReceipts: [receiptRef],
    }).status,
  ).toBe("blocked");
});
it("does not mistake completed task/host receipt metadata for a missing required condition check", () => {
  const result = checkContractAcceptance(contract, [], { versionId: "v1", inputGeneration: "g1" });
  expect(result).toMatchObject({
    status: "blocked",
    code: "EVIDENCE_MISSING",
    missingRequirements: ["tests"],
  });
});
