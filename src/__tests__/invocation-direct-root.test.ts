// Actual isolated SDK producer; no real-user/CLI/business certification.
import { expect, it } from "vitest";
import { ownedCodemode } from "./helpers/owned-codemode";
it("observes a direct SDK check without diagnosing it as an unqualified container", async () => {
  const result = await ownedCodemode("normal", { directCheck: true, checkTool: "owned_check" });
  const facts = result.branch
    .filter((row) => row.type === "custom" && row.customType === "continuous-tasks:control-facts")
    .map((row) => (row.type === "custom" ? (row.data as Record<string, unknown>) : {}));
  const start = facts.find(
    (data) => data.kind === "invocation-started" && data.toolCallId === "owned-direct-check",
  );
  expect(start).toBeDefined();
  const seal = facts.find(
    (data) => data.kind === "invocation-root-sealed" && data.rootId === start?.rootId,
  );
  expect(seal).toMatchObject({ version: 2, rootKind: "direct", outcome: "observed" });
  expect(String(seal?.reason)).not.toContain("Container source/effects");
  expect(
    facts.filter(
      (data) => data.kind === "eligibility-attested" && data.operationId === start?.operationId,
    ),
  ).toHaveLength(0);
  expect(result.errors).toEqual([]);
  expect(result.state?.status).toBe("completed");
});
