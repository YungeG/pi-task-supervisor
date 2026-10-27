// Host-source registry/schema probes only: recognizing a suite is neither a native
// artifact confirmation, actual execution, permission nor Goal acceptance.
import { expect, it } from "vitest";
import { recognizeAcceptanceSuite, recognizedAcceptanceSuite } from "../acceptance-contract";
function proposal() {
  return {
    version: 1,
    scopeId: "owned-inputs",
    inputs: ["checker.mjs", "source.js"],
    artifacts: [],
    environment: { profileId: "owned", values: { LANG: "C" } },
    requirements: [
      {
        requirementId: "r1",
        source: "approved original Goal",
        text: "Required behavior",
        required: true,
      },
    ],
    checks: [
      {
        checkId: "unit",
        kind: "automatic",
        requirementIds: ["r1"],
        script: "checker.mjs",
        checkerFiles: ["checker.mjs"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        expected: { minTests: 1, requiredCases: ["behavior"], allowedSkipped: [] },
      },
    ],
  };
}
it.each([
  ["blank", "  "],
  ["oversize", "界".repeat(1400)],
  ["display-control", `Goal${String.fromCodePoint(0x202e)}`],
])("rejects %s original Goal recognition before token creation", (_label, goal) => {
  expect(() => recognizeAcceptanceSuite(goal, proposal())).toThrow(/exact bounded original Goal/);
});
it("never promotes primitive or callable values into a recognized native source", () => {
  for (const value of [undefined, null, false, 0, "host-recognized", () => ({ trusted: true })])
    expect(recognizedAcceptanceSuite(value)).toBeUndefined();
});
it("recognizes only an actual process-local host token, never a proposal/copy/trust label", () => {
  const value = proposal(),
    token = recognizeAcceptanceSuite("Original approved Goal", value),
    selected = recognizedAcceptanceSuite(token);
  expect(selected).toMatchObject({
    expectedOriginalGoal: "Original approved Goal",
    proposal: value,
  });
  expect(recognizedAcceptanceSuite(value)).toBeUndefined();
  expect(recognizedAcceptanceSuite(structuredClone(token))).toBeUndefined();
  expect(
    recognizedAcceptanceSuite({ trusted: true, source: "host-recognized", proposal: value }),
  ).toBeUndefined();
  value.requirements = value.requirements.map((requirement) => ({
    ...requirement,
    text: "changed Main proposal",
  }));
  expect(recognizedAcceptanceSuite(token)?.proposal.requirements[0]?.text).toBe(
    "Required behavior",
  );
  if (!selected) throw Error("Actual host registry token missing");
  selected.proposal.requirements = selected.proposal.requirements.map((requirement) => ({
    ...requirement,
    text: "changed detached projection",
  }));
  expect(recognizedAcceptanceSuite(token)?.proposal.requirements[0]?.text).toBe(
    "Required behavior",
  );
});
it.each([
  "trust-label",
  "missing-map",
  "unknown-requirement",
  "duplicate-check",
  "outside-path",
  "unchecked-script",
])("rejects %s before a native binding can be proposed", (kind) => {
  const value = proposal();
  if (kind === "trust-label") Object.assign(value, { trusted: true });
  if (kind === "missing-map") value.checks = [];
  if (kind === "unknown-requirement")
    value.checks = value.checks.map((check) => ({ ...check, requirementIds: ["unknown"] }));
  if (kind === "duplicate-check")
    value.checks = [...value.checks, ...structuredClone(value.checks)];
  if (kind === "outside-path") value.inputs = ["../outside"];
  if (kind === "unchecked-script") value.inputs = ["source.js"];
  expect(() => recognizeAcceptanceSuite("Original approved Goal", value)).toThrow(
    /Acceptance proposal/,
  );
});
