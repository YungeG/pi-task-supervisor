// Fixed HOST-recognized local smoke specification only. This is not a model
// registration API, native human confirmation, CLI identity or product acceptance.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import supervisor from "../src/index";
import { basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { recognizeAcceptanceSuite } from "../src/acceptance-contract";
import { registerHostAcceptanceContract } from "../src/acceptance-runtime";
import { currentRuntime } from "../src/runtime";
import { currentWorkOwner, readControlJournal } from "../src/control-journal";
import { selectedAcceptanceContract } from "../src/acceptance-journal";
export default function acceptanceSmoke(pi: ExtensionAPI) {
  const token = recognizeAcceptanceSuite("Verify the approved local smoke work", {
    version: 1,
    scopeId: "owned-preflight-smoke",
    inputs: ["review-input.txt", "acceptance-check.mjs"],
    artifacts: [],
    environment: { profileId: "owned-empty", values: {} },
    requirements: [
      {
        requirementId: "fixed-smoke-input",
        source: "test/preflight-smoke.mjs fixed host-recognized fixture specification",
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
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write_tasks") return;
    const state = currentRuntime().supervisor;
    if (
      state?.status !== "active" ||
      !state.preflightBinding ||
      state.sessionId !== ctx.sessionManager.getSessionId()
    )
      return;
    if (
      dirname(resolve(ctx.cwd)) !== resolve(tmpdir()) ||
      !basename(ctx.cwd).startsWith("pi-task-supervisor-smoke-")
    )
      throw Error("Owned smoke contract requires its fixed temporary workspace");
    const owner = currentWorkOwner(ctx.sessionManager.getSessionId());
    if (!owner || selectedAcceptanceContract(readControlJournal(ctx).acceptance, owner)) return;
    registerHostAcceptanceContract(pi, ctx, token);
  });
  // One actual SDK loader graph, like the owned P6 metrics wrapper. A second
  // separately loaded extension would have a distinct private runtime/registry.
  supervisor(pi);
}
