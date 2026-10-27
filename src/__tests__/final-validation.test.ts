import { expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { createAdvanceTasksTool } from "../tools";
import { finalReviewEligibility } from "../final-review";
import { currentRuntime } from "../runtime";

async function finish(f: Awaited<ReturnType<typeof executionRegistryFixture>>) {
  return createAdvanceTasksTool(f.api).execute(
    "validation-done",
    {
      transitions: [
        {
          id: "t-1.1",
          evidence: {
            summary: "Actual fixed check",
            refs: [
              {
                kind: "command",
                label: "Stable input validation",
                status: "passed",
                ref: "tool:repair-proof",
                exitCode: 0,
              },
            ],
          },
        },
      ],
    },
    undefined,
    undefined,
    f.ctx,
  );
}
it("does not attest a check that changed relevant source while it ran", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect((await f.review()).isError).not.toBe(true);
    const event = {
      toolCallId: "repair-proof",
      toolName: "bash",
      input: { command: "synthetic fixed validation" },
    };
    await f.fire("tool_call", { type: "tool_call", ...event });
    writeFileSync(join(f.dir, "review-input.txt"), "Changed during validation\n");
    await f.fire("tool_result", {
      type: "tool_result",
      ...event,
      content: [{ type: "text", text: "Succeeded but modified source" }],
      structuredContent: { exit_code: 0 },
      isError: false,
    });
    expect((await finish(f)).isError).not.toBe(true);
    expect(finalReviewEligibility(f.ctx)).toMatchObject({ status: "needs_validation" });
  } finally {
    f.close();
  }
});
it.each(["before", "memory", "after"] as const)(
  "keeps an actual host receipt when a %s applicability append fails, without pretending the failed append was acknowledged",
  async (failure) => {
    const f = await executionRegistryFixture(false, { gitWorkspace: true });
    try {
      expect((await f.review()).isError).not.toBe(true);
      f.fail((type, data) =>
        type === "continuous-tasks:control-facts" &&
        (data as { kind?: string }).kind === "final-validation"
          ? failure
          : undefined,
      );
      await f.validate();
      expect(currentRuntime().journalFault).toBeDefined();
      expect(currentRuntime().receiptStore?.readReceipts(["tool:repair-proof"])[0]).toMatchObject({
        ok: true,
        exitCode: 0,
      });
      f.fail(undefined);
      f.reload();
      await f.fire("session_tree");
      expect(currentRuntime().journalFault).toBeUndefined();
      await f.command("recover");
      expect((await finish(f)).isError).not.toBe(true);
      expect(finalReviewEligibility(f.ctx)).toMatchObject({
        status: failure === "after" ? "ready" : "needs_validation",
      });
    } finally {
      f.close();
    }
  },
);
it("requires the version actually covered by final validation, not a snapshot invented after work changed", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  try {
    expect((await f.review()).isError).not.toBe(true);
    await f.validate();
    const result = await createAdvanceTasksTool(f.api).execute(
      "validated-work-done",
      {
        transitions: [
          {
            id: "t-1.1",
            evidence: {
              summary: "Actual stable fixture validation",
              refs: [
                {
                  kind: "command",
                  label: "Fixed fixture check",
                  status: "passed",
                  ref: "tool:repair-proof",
                  exitCode: 0,
                },
              ],
            },
          },
        ],
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(finalReviewEligibility(f.ctx)).toMatchObject({ status: "ready" });
    f.reload();
    await f.fire("session_tree");
    expect(finalReviewEligibility(f.ctx)).toMatchObject({ status: "ready" });
    writeFileSync(join(f.dir, "review-input.txt"), "Changed after validation\n");
    expect(finalReviewEligibility(f.ctx)).toMatchObject({ status: "needs_validation" });
    await f.command("stop");
    expect(finalReviewEligibility(f.ctx)).toMatchObject({
      status: "blocked",
      code: "CONTROL_HELD",
    });
  } finally {
    f.close();
  }
});
