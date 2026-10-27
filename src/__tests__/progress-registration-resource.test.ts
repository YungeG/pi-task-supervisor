// Original P5 component-fixture configuration, not the raw wire-capacity substitute.
// This measures trusted registrations only; no execution/acceptance proof is minted.
import { statSync } from "node:fs";
import { expect, it } from "vitest";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { registerProgressMilestone } from "../progress-facts";
import { readControlJournal, controlReadStats } from "../control-journal";
import { journalDecodeStats } from "../human-journal";
import { currentRuntime } from "../runtime";
const count = Number(process.env.P8_COMPONENT_REGISTRATION_COUNT ?? "1");
if (![1, 10, 100].includes(count)) throw Error("Owned component count must be1/10/100");
it("completes genuine trusted registration calls within the original bounded test budget", async () => {
  const f = await executionRegistryFixture(false, { gitWorkspace: true });
  let passed = false;
  try {
    const started = performance.now();
    for (let i = 0; i < count; i++)
      expect(
        registerProgressMilestone(f.api, f.ctx, {
          id: `actual-full-${i}`,
          taskId: "t-1.1",
          milestone: "input_difference",
          policy: "git-visible-workspace-v1",
        }),
      ).toBeDefined();
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThanOrEqual(10000);
    const defs = readControlJournal(f.ctx).progressFacts?.filter(
      (row) => row.data.kind === "progress-definition",
    );
    expect(defs).toHaveLength(count);
    expect(
      new Set(
        defs?.map((row) => (row.data.kind === "progress-definition" ? row.data.definitionId : "")),
      ).size,
    ).toBe(count);
    if (count === 100) {
      const leaf = f.ctx.sessionManager.getLeafId();
      expect(
        registerProgressMilestone(f.api, f.ctx, {
          id: "actual-full-overflow",
          taskId: "t-1.1",
          milestone: "input_difference",
          policy: "git-visible-workspace-v1",
        }),
      ).toBeUndefined();
      expect(f.ctx.sessionManager.getLeafId()).toBe(leaf);
    }
    process.stdout.write(
      JSON.stringify({
        kind: "original-component-full-registration",
        count,
        elapsedMs,
        journalBytes: statSync(f.path).size,
        decode: journalDecodeStats(),
        fold: controlReadStats(),
        maxRssKiB: process.resourceUsage().maxRSS,
        qualification: false,
      }) + "\n",
    );
    passed = true;
  } finally {
    if (passed) f.close();
    else {
      currentRuntime().cancel();
      f.restoreHost();
      console.error("Owned full-registration component failure retained:", f.dir);
    }
  }
}, 10000);
