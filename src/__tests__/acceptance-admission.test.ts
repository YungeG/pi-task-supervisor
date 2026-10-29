import { startSupervisor } from "../supervisor";
import { enableSessionScope } from "../scope";
import { adoptSupervisedMode } from "../management-policy";
// C1/C2/C3 public admission/source APIs. Owned physical/TUI boundary adapter;
// negative calls must not spawn a checker, create approval or fabricate proof.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { preflightLifecycle } from "./helpers/preflight";
import { resetState } from "../state";
import { createWriteTasksTool, createCompileTasksTool } from "../tools";
import { recognizeAcceptanceSuite } from "../acceptance-contract";
import {
  registerHostAcceptanceContract,
  executeRegisteredCheck,
  proposeAcceptanceContract,
  reviewAcceptanceContract,
  verifyManualCheck,
  acceptanceContractIssue,
  cachedAcceptanceReviewMaterial,
} from "../acceptance-runtime";
import { createRunCheckTool, createProposeContractTool } from "../acceptance-tool";
beforeEach(resetState);
it.each(["no-current-host", "foreign-host", "unknown-version", "changed-definition"])(
  "reports native acceptance applicability barrier %s",
  async (kind) => {
    const h = await setup();
    if (kind === "foreign-host") h.ctx.cwd = join(h.root, "foreign");
    if (kind === "unknown-version") unlinkSync(join(h.root, "input.txt"));
    if (kind === "changed-definition")
      writeFileSync(join(h.root, "check.mjs"), "// no-op replacement\n");
    const issue = acceptanceContractIssue(kind === "no-current-host" ? undefined : h.ctx);
    expect(issue).toMatch(
      kind === "no-current-host"
        ? /actual current host/
        : kind === "foreign-host"
          ? /workspace changed/
          : kind === "unknown-version"
            ? /version is unknown/
            : /definition changed/,
    );
  },
);
it("does not silently re-register an already bound host contract", async () => {
  const h = await setup(),
    before = readFileSync(h.path, "utf8");
  expect(() =>
    registerHostAcceptanceContract(
      h.mock.api,
      h.ctx,
      recognizeAcceptanceSuite("Owned admission", h.proposal),
    ),
  ).toThrow(/already bound/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("does not propose after an actual native stop or without the physical Session source", async () => {
  const h = await setup(false);
  expect(cachedAcceptanceReviewMaterial()).toBeUndefined();
  await h.command("stop");
  expect(() => proposeAcceptanceContract(h.mock.api, h.ctx, h.proposal)).toThrow(
    /actual current planning or active Goal/,
  );
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(undefined);
  expect(() => proposeAcceptanceContract(h.mock.api, h.ctx, h.proposal)).toThrow(/physical source/);
});
it.each(["foreign-workspace", "unknown-input", "paused-owner"])(
  "does not bind a host source under %s",
  async (kind) => {
    const h = await setup(false);
    if (kind === "foreign-workspace") h.ctx.cwd = join(h.root, "foreign");
    if (kind === "unknown-input") unlinkSync(join(h.root, "input.txt"));
    if (kind === "paused-owner") await h.command("pause");
    const before = readFileSync(h.path, "utf8");
    expect(() =>
      registerHostAcceptanceContract(
        h.mock.api,
        h.ctx,
        recognizeAcceptanceSuite("Owned admission", h.proposal),
      ),
    ).toThrow();
    expect(readFileSync(h.path, "utf8")).toBe(before);
  },
);
it("does not retroactively upgrade an already compiled legacy Goal to contract acceptance", async () => {
  const h = await setup(false);
  await createWriteTasksTool(h.mock.api).execute(
    "legacy-graph",
    {
      mode: "replace",
      phases: [
        { title: "Legacy", tasks: [{ title: "Final", prompt: "Owned legacy", profile: "main" }] },
      ],
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(
    (
      await createCompileTasksTool(h.mock.api).execute(
        "legacy-compile",
        { finalAcceptanceTaskId: "t-1.1" },
        undefined,
        undefined,
        h.ctx,
      )
    ).isError,
  ).not.toBe(true);
  expect(() =>
    registerHostAcceptanceContract(
      h.mock.api,
      h.ctx,
      recognizeAcceptanceSuite("Owned admission", h.proposal),
    ),
  ).toThrow(/before first board compilation/);
});
it("does not execute checks on a paused Goal or treat an automatic definition as a native manual condition", async () => {
  const h = await setup();
  await expect(verifyManualCheck(h.mock.api, h.ctx, "unit")).rejects.toThrow(/manual/);
  await h.command("pause");
  const before = readFileSync(h.path, "utf8");
  await expect(executeRegisteredCheck(h.mock.api, h.ctx, "not-started", "unit")).rejects.toThrow(
    /actual active supervised owner/,
  );
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("keeps untrusted thrown values as errors, never native proof or a fabricated exit", async () => {
  const h = await setup(false),
    bad = Object.defineProperty({}, "version", {
      enumerable: true,
      get: () => {
        throw JSON.parse('"owned-untrusted-proposal"') as unknown;
      },
    });
  expect(
    (
      await createProposeContractTool(h.mock.api).execute(
        "getter",
        { proposal: bad as typeof h.proposal },
        undefined,
        undefined,
        h.ctx,
      )
    ).isError,
  ).toBe(true);
  const args = Object.defineProperty({}, "checkId", {
    get: () => {
      throw JSON.parse('"owned-untrusted-id"') as unknown;
    },
  }) as { checkId: string };
  await expect(
    createRunCheckTool(h.mock.api).execute("getter", args, undefined, undefined, h.ctx),
  ).rejects.toBe("owned-untrusted-id");
});
it("rejects a complete over-64KB untrusted proposal before any source append", async () => {
  const h = await setup(false),
    requirements = Array.from({ length: 16 }, (_, i) => ({
      ...h.proposal.requirements[0]!,
      requirementId: `r-${i}`,
      text: "界".repeat(1200),
    })),
    proposal = {
      ...h.proposal,
      requirements,
      inputs: [
        ...h.proposal.inputs,
        ...Array.from({ length: 100 }, (_, i) => `f-${i}`.padEnd(120, "x")),
      ],
      checks: h.proposal.checks.map((check) => ({
        ...check,
        requirementIds: requirements.map((req) => req.requirementId),
      })),
    };
  const before = readFileSync(h.path, "utf8");
  expect(
    (
      await createProposeContractTool(h.mock.api).execute(
        "oversized",
        { proposal },
        undefined,
        undefined,
        h.ctx,
      )
    ).isError,
  ).toBe(true);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
async function setup(bound = true) {
  const h = preflightLifecycle(),
    root = dirname(h.path),
    header = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0] ?? "{}") as Record<
      string,
      unknown
    >;
  writeFileSync(h.path, JSON.stringify({ ...header, cwd: root }) + "\n");
  h.ctx.cwd = root;
  writeFileSync(join(root, "input.txt"), "owned");
  writeFileSync(join(root, "check.mjs"), 'console.log("unexecuted");\n');
  startSupervisor(h.mock.api, h.ctx, "Owned admission");
  enableSessionScope(h.mock.api);
  adoptSupervisedMode(h.mock.api, h.ctx);
  const proposal = {
    version: 1 as const,
    scopeId: "admission",
    inputs: ["input.txt", "check.mjs"],
    artifacts: [],
    environment: { profileId: "empty", values: {} },
    requirements: [
      {
        requirementId: "r1",
        source: "Owned recognized API specification",
        text: "Required actual validation",
        required: true,
      },
    ],
    checks: [
      {
        kind: "automatic" as const,
        checkId: "unit",
        requirementIds: ["r1"],
        script: "check.mjs",
        checkerFiles: ["check.mjs"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        expected: { minTests: 1, requiredCases: ["input"], allowedSkipped: [] },
      },
    ],
  };
  if (bound)
    registerHostAcceptanceContract(
      h.mock.api,
      h.ctx,
      recognizeAcceptanceSuite("Owned admission", proposal),
    );
  return { ...h, root, proposal };
}
it("does not treat a copied host-source token as registration authority", async () => {
  const h = await setup(false),
    before = readFileSync(h.path, "utf8");
  expect(() =>
    registerHostAcceptanceContract(h.mock.api, h.ctx, { trusted: true, proposal: h.proposal }),
  ).toThrow(/actual recognized host token/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("rejects recognition for a different original Goal before appending any authority", async () => {
  const h = await setup(false),
    before = readFileSync(h.path, "utf8");
  expect(() =>
    registerHostAcceptanceContract(
      h.mock.api,
      h.ctx,
      recognizeAcceptanceSuite("Other Goal", h.proposal),
    ),
  ).toThrow(/another original Goal/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it.each([
  "unbound",
  "unknown-id",
  "no-actual-invocation",
  "changed-checker",
  "missing-input",
  "foreign-workspace",
] as const)("denies %s before executing a native process", async (kind) => {
  const h = await setup(kind !== "unbound");
  if (kind === "changed-checker")
    writeFileSync(join(h.root, "check.mjs"), 'console.log("different checker");\n');
  if (kind === "missing-input") unlinkSync(join(h.root, "input.txt"));
  if (kind === "foreign-workspace") h.ctx.cwd = join(h.root, "other");
  const before = readFileSync(h.path, "utf8");
  await expect(
    executeRegisteredCheck(
      h.mock.api,
      h.ctx,
      "not-a-native-call",
      kind === "unknown-id" ? "unknown" : "unit",
    ),
  ).rejects.toThrow();
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("returns null/unavailable rather than exit zero when the tool has no actual definition/call", async () => {
  const h = await setup(false);
  const result = await createRunCheckTool(h.mock.api).execute(
    "unstarted",
    { checkId: "unit" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ exit_code: null, passed: false });
});
it("rejects an invalid model proposal without transforming it into trusted metadata", async () => {
  const h = await setup(false),
    before = readFileSync(h.path, "utf8");
  const result = await createProposeContractTool(h.mock.api).execute(
    "bad",
    { proposal: { ...h.proposal, inputs: ["../outside"] } },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).toBe(true);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("keeps exact proposals idempotent and enforces bounded source history without eviction", async () => {
  const h = await setup(false),
    first = proposeAcceptanceContract(h.mock.api, h.ctx, h.proposal),
    before = readFileSync(h.path, "utf8");
  expect(proposeAcceptanceContract(h.mock.api, h.ctx, h.proposal).proposalId).toBe(
    first.proposalId,
  );
  expect(readFileSync(h.path, "utf8")).toBe(before);
  for (let n = 1; n < 8; n++)
    proposeAcceptanceContract(h.mock.api, h.ctx, {
      ...h.proposal,
      requirements: h.proposal.requirements.map((item) => ({
        ...item,
        text: `Required actual validation ${n}`,
      })),
    });
  const full = readFileSync(h.path, "utf8");
  expect(() =>
    proposeAcceptanceContract(h.mock.api, h.ctx, {
      ...h.proposal,
      requirements: h.proposal.requirements.map((item) => ({
        ...item,
        text: "Ninth distinct condition",
      })),
    }),
  ).toThrow(/capacity/);
  expect(readFileSync(h.path, "utf8")).toBe(full);
});
it("requires actual quiet control and a known current manual definition before native questions", async () => {
  const h = await setup(false);
  vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
  await expect(reviewAcceptanceContract(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/idle/);
  await expect(verifyManualCheck(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/idle/);
  vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(false);
  await expect(reviewAcceptanceContract(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/Unknown/);
  await expect(verifyManualCheck(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/actual contract/);
});
it("does not expose or confirm a native review through a non-TUI copied response", async () => {
  const h = await setup(false);
  h.ctx.mode = "rpc";
  const before = readFileSync(h.path, "utf8");
  expect(await reviewAcceptanceContract(h.mock.api, h.ctx, "unknown")).toEqual({
    status: "unsupported",
  });
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
