// Fixed isolated smoke declaration. This object is not a trusted contract or grant.
export const preflightContract = {
  version: 1,
  scopeId: "owned-preflight-smoke",
  inputs: ["review-input.txt", "acceptance-check.mjs"],
  artifacts: [],
  environment: { profileId: "owned-empty", values: {} },
  requirements: [
    {
      requirementId: "fixed-smoke-input",
      source: "test/preflight-smoke.mjs fixed owned specification",
      text: "The finite registered Node check reads the owned review-input and asserts its exact fixed premise",
      required: true,
    },
  ],
  checks: [
    {
      kind: "automatic",
      checkId: "fixed-input",
      requirementIds: ["fixed-smoke-input"],
      script: "acceptance-check.mjs",
      checkerFiles: ["acceptance-check.mjs"],
      configs: [],
      args: [],
      timeoutMs: 1000,
      expected: { minTests: 1, requiredCases: ["smoke-input"], allowedSkipped: [] },
    },
  ],
};
