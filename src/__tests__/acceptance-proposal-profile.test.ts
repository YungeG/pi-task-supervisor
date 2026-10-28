// Untrusted declaration validation and role inventory, not authority or execution.
import { expect, it } from "vitest";
import {
  checkerScopeInventory,
  validateAcceptanceProposal,
  type AcceptanceProposal,
} from "../acceptance-proposal";
function proposal(): AcceptanceProposal {
  return {
    version: 1,
    scopeId: "metadata",
    inputs: ["input.txt"],
    artifacts: ["result.txt"],
    environment: { profileId: "empty", values: {} },
    requirements: [
      {
        requirementId: "result",
        source: "Original fixture goal",
        text: "Produce declared result",
        required: true,
      },
    ],
    checks: [
      {
        kind: "automatic",
        checkId: "python",
        requirementIds: ["result"],
        script: "nested/test_scope.py",
        checkerFiles: ["nested/test_scope.py"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        runtime: "python-unittest-v1",
        checkerRoot: "/tmp/metadata-only",
        permissionId: "A1",
        tests: ["nested.test_scope.Scope.test_owned"],
        expected: {
          minTests: 1,
          requiredCases: ["nested.test_scope.Scope.test_owned"],
          allowedSkipped: [],
        },
      },
    ],
  };
}
it("accepts only an explicit nested-module TestCase method declaration", () => {
  const good = proposal();
  expect(validateAcceptanceProposal(good)).toEqual(good);
  const check = good.checks[0];
  if (!check || check.kind !== "automatic") throw Error("No fixture check");
  check.tests = ["nested.test_scope.test_owned"];
  check.expected.requiredCases = [...check.tests];
  expect(() => validateAcceptanceProposal(good)).toThrow();
});
it.each([
  "no-permission",
  "missing-tests",
  "minimum",
  "unknown-case",
  "unknown-skip",
  "python-args",
  "foreign-module",
  "non-python",
  "node-tests",
])("does not advertise unsupported %s declarations for native approval", (kind) => {
  const input = proposal(),
    check = input.checks[0];
  if (!check || check.kind !== "automatic") throw Error("No fixture check");
  if (kind === "no-permission") delete check.permissionId;
  if (kind === "missing-tests") delete check.tests;
  if (kind === "minimum") check.expected.minTests = 2;
  if (kind === "unknown-case")
    check.expected.requiredCases = ["nested.test_scope.Scope.test_missing"];
  if (kind === "unknown-skip")
    check.expected.allowedSkipped = ["nested.test_scope.Scope.test_missing"];
  if (kind === "python-args") check.args = ["--discovery"];
  if (kind === "foreign-module") {
    check.tests = ["other.Scope.test_owned"];
    check.expected.requiredCases = [...check.tests];
  }
  if (kind === "non-python") {
    check.script = "check.mjs";
    check.checkerFiles = [check.script];
  }
  if (kind === "node-tests") delete check.runtime;
  expect(() => validateAcceptanceProposal(input)).toThrow();
});
it("sorts actual role declarations and never subtracts an external checker's same-named product input", () => {
  const base = proposal().checks[0];
  if (!base || base.kind !== "automatic") throw Error("No fixture check");
  const checks = [
    {
      ...base,
      checkId: "z",
      checkerRoot: "/product",
      script: "local.py",
      checkerFiles: ["local.py"],
    },
    {
      ...base,
      checkId: "a",
      checkerRoot: "/external",
      script: "input.txt",
      checkerFiles: ["input.txt"],
    },
    {
      ...base,
      checkId: "m",
      checkerRoot: "/product",
      script: "config.py",
      checkerFiles: ["config.py"],
    },
  ];
  const inventory = checkerScopeInventory(
    "/product",
    ["input.txt", "local.py", "config.py"],
    checks,
  );
  expect(inventory.checkerScopes.map((scope) => scope.checkId)).toEqual(["a", "m", "z"]);
  expect(inventory.inputs).toEqual(["input.txt"]);
});
