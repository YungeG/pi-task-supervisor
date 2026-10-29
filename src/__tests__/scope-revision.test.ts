import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { goalFixture, completeGoalProposal } from "./helpers/goal";
import { scopeRevisionContractContext } from "../acceptance-runtime";
import { preflightLifecycle, localProposal } from "./helpers/preflight";
import { installCustomUI } from "./helpers/custom-ui";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { createProposeContractTool, createProposeScopeRevisionTool } from "../acceptance-tool";
import { isScopeRevisionProposalTool } from "../scope-revision-schema";
import { createSubmitPreflightTool, createWriteTasksTool, createCompileTasksTool } from "../tools";
import { readControlJournal, currentWorkOwner } from "../control-journal";
import { selectedAcceptanceContract } from "../acceptance-journal";
import {
  proposeScopeRevision,
  reviewScopeRevision,
  repairScopeRevision,
  revokeScopeRevision,
} from "../scope-revision";
import {
  scopeRevisionIssue,
  selectedScopeRevision,
  scopeControlAttention,
  assertScopeControl,
  assertScopeBound,
  assertScopeCommit,
  assertScopeRevocation,
  scopeIsRevoked,
  scopeProposalFor,
} from "../scope-revision-journal";
import {
  qualifiedEvidence,
  captureInvocationFrame,
  invocationFrameCurrent,
} from "../qualified-evidence";
import { recoverSupervisor } from "../supervisor";
import { goalExecutionIssue } from "../goal-scope";
import {
  validScopeRevisionProposal,
  scopeProposalBase,
  scopeNodeBefore,
  scopeRevisionProposalViews,
} from "../scope-revision-proposal";
import { journalDigest } from "../human-journal";
import { inspectRestorableSession } from "../human-control";
import type { ScopeRevisionControl, ScopeRevisionCommitted } from "../scope-revision-facts";
import type { AcceptanceBoundFact } from "../acceptance-journal";
import type { HostReceipt } from "../receipt-store";
import type { PreflightState } from "../preflight";
import type { AcceptanceProposal } from "../acceptance-proposal";

beforeEach(resetState);
async function fixture() {
  const h = preflightLifecycle(),
    root = dirname(h.path);
  const header = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0] ?? "{}");
  writeFileSync(h.path, JSON.stringify({ ...header, cwd: root }) + "\n");
  h.ctx.cwd = root;
  writeFileSync(join(root, "input.txt"), "source");
  writeFileSync(
    join(root, "checker.mjs"),
    "console.log(JSON.stringify({protocol:'check-result-v1',tests:1,passed:1,failed:0,skipped:0,requiredCases:{output:'passed'},skippedIds:[]}));\n",
  );
  await h.nativeCommand("supervise Scope same original Goal");
  const contract: AcceptanceProposal = {
    version: 1,
    scopeId: "scope-test",
    inputs: ["input.txt", "checker.mjs"],
    artifacts: ["result.txt"],
    environment: { profileId: "owned", values: {} },
    requirements: [
      {
        requirementId: "output",
        source: "original condition",
        text: "produce output",
        required: true,
      },
    ],
    checks: [
      {
        kind: "automatic",
        checkId: "output",
        requirementIds: ["output"],
        script: "checker.mjs",
        checkerFiles: ["checker.mjs"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        expected: { minTests: 1, requiredCases: ["output"], allowedSkipped: [] },
      },
    ],
  };
  const proposed = await createProposeContractTool(h.mock.api).execute(
    "contract",
    { proposal: contract },
    undefined,
    undefined,
    h.ctx,
  );
  expect(proposed.isError, JSON.stringify(proposed.content)).not.toBe(true);
  const proposalId = (proposed.details as { proposalId: string }).proposalId;
  const submitted = await createSubmitPreflightTool(h.mock.api).execute(
    "plan",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: { ...localProposal, contractProposalId: proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
  await h.command("start");
  expect(
    currentRuntime().preflight?.started,
    JSON.stringify(vi.mocked(h.ctx.ui.notify).mock.calls),
  ).toBeDefined();
  const board = await createWriteTasksTool(h.mock.api).execute(
    "board",
    {
      mode: "replace",
      phases: [
        {
          title: "Delivery",
          tasks: [{ title: "Deliver", prompt: "Implement and check", profile: "main" }],
        },
      ],
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(board.isError, JSON.stringify(board.content)).not.toBe(true);
  const compiled = await createCompileTasksTool(h.mock.api).execute(
    "compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
  await h.command("pause Exact scope needs amendment");
  expect(currentRuntime().supervisor?.status).toBe("paused");
  const input = {
    plan: { ...localProposal, acceptance: ["produce the revised exact output"] },
    contract: {
      ...contract,
      requirements: [{ ...contract.requirements[0]!, text: "produce the revised exact output" }],
    },
    reason: "Precisely amend an existing condition, no new object or authority",
  };
  return { ...h, root, input };
}
it("commits an exact same-Goal native revision while preserving Start, tasks, pause and accounting", async () => {
  const h = await fixture(),
    original = structuredClone(currentRuntime().preflight),
    state = structuredClone(currentRuntime().supervisor),
    board = getBoard();
  const proposed = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    view = readControlJournal(h.ctx),
    owner = currentWorkOwner(h.ctx.sessionManager.getSessionId())!;
  const before = selectedAcceptanceContract(view.acceptance, owner);
  expect(scopeRevisionIssue(view.acceptance, owner)).toMatch(/review\/commit/);
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  const result = await reviewScopeRevision(h.mock.api, h.ctx, proposed.proposalId);
  ui.assertNoScriptErrors();
  expect(result.status).toBe("committed");
  expect(currentRuntime().preflight).toEqual(original);
  expect(currentRuntime().supervisor).toEqual(state);
  expect(getBoard()).toEqual(board);
  const after = readControlJournal(h.ctx),
    selected = selectedAcceptanceContract(after.acceptance, owner);
  expect(selected?.data.authority.kind).toBe("scope-revision-reviewed");
  expect(selected?.data.revision).toBe((before?.data.revision ?? 0) + 1);
  expect(scopeRevisionIssue(after.acceptance, owner)).toBeUndefined();
  expect(ui.rendered.join("\n")).toContain("范围修订审核");
  expect(ui.rendered.join("\n")).toContain("原方案全文");
  expect(ui.rendered.join("\n")).not.toContain("必需权限已齐，仍需独立Start");
  const count = h.entries.length;
  expect((await repairScopeRevision(h.mock.api, h.ctx, proposed.proposalId)).status).toBe(
    "already_saved",
  );
  expect(h.entries).toHaveLength(count);
  const commit = selectedScopeRevision(after.acceptance, owner)!;
  expect((await revokeScopeRevision(h.mock.api, h.ctx, commit.entryId)).status).toBe("revoked");
  expect(scopeRevisionIssue(readControlJournal(h.ctx).acceptance, owner)).toMatch(/revoked/);
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow(/revoked/i);
});
it.each(["defer", "reject", "bytes", "resize"])(
  "does not grant from %s and never repeats original approval or Start",
  async (kind) => {
    const h = await fixture(),
      original = structuredClone(currentRuntime().preflight),
      proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input);
    const ui = installCustomUI(h.ctx, (d) => {
      if (kind === "defer") {
        d.press("\u001b");
        return;
      }
      if (kind === "reject") {
        d.press("r");
        return;
      }
      if (kind === "bytes")
        writeFileSync(join(h.root, "checker.mjs"), "// changed during review\n");
      if (kind === "resize") {
        d.resize(80, 24);
        d.press("\r");
        expect(d.doneCount).toBe(0);
        d.resize(100, 30);
        d.press("\r");
        expect(d.doneCount).toBe(0);
        d.press("\u001b");
        return;
      }
      d.reviewAll();
    });
    const result = await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId);
    ui.assertNoScriptErrors();
    expect(result.status).toBe(kind === "reject" ? "rejected" : "deferred");
    expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
    expect(currentRuntime().preflight).toEqual(original);
    expect(currentRuntime().supervisor?.status).toBe("paused");
  },
);
it("requires separate recover and invalidates old direct evidence/callbacks without zeroing epoch or budget", async () => {
  const h = await fixture(),
    state = currentRuntime().supervisor!,
    owner = currentWorkOwner(h.ctx.sessionManager.getSessionId())!;
  const receipt: HostReceipt = {
    id: "unit-original-receipt",
    tool: "owned-check",
    epoch: state.epoch,
    ok: true,
    exitCode: 0,
    eligible: true,
    digest: "a".repeat(64),
    input: "{}",
    output: "unit decision",
    reviews: [{ taskId: "t-1.1", digest: "unit-task" }],
    taskIds: ["t-1.1"],
  };
  expect(qualifiedEvidence(receipt, "t-1.1", "unit-task", state.epoch, h.ctx).eligible).toBe(true);
  const oldFrame = captureInvocationFrame(h.ctx, owner),
    before = structuredClone(state),
    proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input);
  expect(qualifiedEvidence(receipt, "t-1.1", "unit-task", state.epoch, h.ctx).eligible).toBe(false);
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "committed",
  );
  ui.assertNoScriptErrors();
  expect(invocationFrameCurrent(h.ctx, oldFrame)).toBe(false);
  expect(goalExecutionIssue(h.ctx)).toMatch(/explicit recover/);
  expect(qualifiedEvidence(receipt, "t-1.1", "unit-task", state.epoch, h.ctx).eligible).toBe(false);
  await h.nativeCommand("resume");
  expect(getBoard().workflowStatus).toBe("active");
  expect(currentRuntime().supervisor?.status).toBe("paused");
  recoverSupervisor(h.mock.api, h.ctx);
  const recovered = currentRuntime().supervisor!;
  expect(recovered).toMatchObject({
    epoch: before.epoch,
    reviews: before.reviews,
    continuations: before.continuations,
    cost: before.cost,
    tokens: before.tokens,
    status: "active",
  });
  const current = selectedScopeRevision(readControlJournal(h.ctx).acceptance, owner)!;
  expect(recovered.scopeRevisionRef).toEqual({ entryId: current.entryId, digest: current.digest });
  expect(goalExecutionIssue(h.ctx)).toBeUndefined();
  expect(qualifiedEvidence(receipt, "t-1.1", "unit-task", state.epoch, h.ctx).eligible).toBe(false);
  expect(
    qualifiedEvidence(
      { ...receipt, scopeRevisionRef: { entryId: current.entryId, digest: current.digest } },
      "t-1.1",
      "unit-task",
      state.epoch,
      h.ctx,
    ).eligible,
  ).toBe(false); // A copied DTO with the new reference is not the original ledger source.
  const store = currentRuntime().receiptStore!,
    scopeRef = { entryId: current.entryId, digest: current.digest };
  store.prepareToolCapture(
    {
      type: "tool_call",
      toolName: "read",
      toolCallId: "new-scope-physical",
      input: { path: "owned unit fixture" },
    },
    [{ taskId: "t-1.1", digest: "unit-task" }],
    true,
    scopeRef,
  );
  const physical = store.commitToolReceipt({
    type: "tool_result",
    toolName: "read",
    toolCallId: "new-scope-physical",
    input: { path: "owned unit fixture" },
    content: [{ type: "text", text: "owned mechanism observation; not a certified SDK execution" }],
    details: {},
    isError: false,
  });
  expect(qualifiedEvidence(physical, "t-1.1", "unit-task", state.epoch, h.ctx).eligible).toBe(true);
  expect(
    qualifiedEvidence(
      { ...physical, output: "copied and changed" },
      "t-1.1",
      "unit-task",
      state.epoch,
      h.ctx,
    ).eligible,
  ).toBe(false);
});
it.each(
  [
    "acceptance-scope-control",
    "human-readback",
    "acceptance-definition-declared",
    "acceptance-contract-bound",
    "scope-revision-committed",
  ].flatMap((kind) => [false, true].map((cold) => ({ kind, cold }))),
)(
  "holds an actual $kind acknowledgement gap (cold=$cold) and repairs only original witnessed metadata",
  async ({ kind, cold }) => {
    const h = await fixture(),
      original = structuredClone(currentRuntime().preflight),
      proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input);
    const append = h.mock.appendEntry.getMockImplementation() as (
      type: string,
      data: unknown,
    ) => void;
    let failed = false;
    h.mock.appendEntry.mockImplementation((type, data) => {
      append(type, data);
      if (
        !failed &&
        ((kind === "human-readback" && type === "continuous-tasks:human-readback") ||
          (type === "continuous-tasks:acceptance-facts" &&
            (data as { kind?: string }).kind === kind))
      ) {
        failed = true;
        throw Error("Owned acknowledgement lost after actual scope write");
      }
    });
    const ui = installCustomUI(h.ctx, (d) => {
      d.reviewAll();
    });
    await expect(reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).rejects.toThrow();
    ui.assertNoScriptErrors();
    expect(failed).toBe(true);
    h.mock.appendEntry.mockImplementation(append);
    if (cold) await h.fire("session_start", { type: "session_start" });
    expect(["paused", "fault"]).toContain(currentRuntime().supervisor?.status);
    const frames = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    const result = await repairScopeRevision(h.mock.api, h.ctx, proposal.proposalId);
    expect(result.status).toBe(
      kind === "acceptance-scope-control"
        ? "needs_review"
        : kind === "scope-revision-committed"
          ? "already_saved"
          : "committed",
    );
    expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(frames);
    expect(currentRuntime().preflight).toEqual(original);
    if (kind === "acceptance-scope-control") {
      expect(scopeControlAttention()).toMatch(/witness/);
      expect(goalExecutionIssue(h.ctx)).toMatch(/review\/commit/);
      const replacement = installCustomUI(h.ctx, (d) => {
        d.reviewAll();
      });
      expect((await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
        "committed",
      );
      replacement.assertNoScriptErrors();
    }
    expect(scopeControlAttention()).toBeUndefined();
    expect(goalExecutionIssue(h.ctx)).toMatch(/explicit recover/);
  },
);
it("will not refresh a saved approval after material changes; a genuinely new native review can replace it", async () => {
  const h = await fixture(),
    proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    append = h.mock.appendEntry.getMockImplementation() as (type: string, data: unknown) => void;
  let failed = false;
  h.mock.appendEntry.mockImplementation((type, data) => {
    if (
      !failed &&
      type === "continuous-tasks:acceptance-facts" &&
      (data as { kind?: string }).kind === "acceptance-contract-bound"
    ) {
      failed = true;
      throw Error("Owned before-bound failure");
    }
    append(type, data);
  });
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  await expect(reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).rejects.toThrow();
  ui.assertNoScriptErrors();
  h.mock.appendEntry.mockImplementation(append);
  writeFileSync(join(h.root, "checker.mjs"), "// explicitly changed material needs fresh review\n");
  expect((await repairScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "needs_review",
  );
  expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
  const replacement = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "committed",
  );
  replacement.assertNoScriptErrors();
  expect(currentRuntime().supervisor?.status).toBe("paused");
});
it("keeps a pending native scope control through disable and permits only exact metadata resolution before release", async () => {
  const h = await fixture(),
    proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    append = h.mock.appendEntry.getMockImplementation() as (type: string, data: unknown) => void;
  let failed = false;
  h.mock.appendEntry.mockImplementation((type, data) => {
    append(type, data);
    if (
      !failed &&
      type === "continuous-tasks:acceptance-facts" &&
      (data as { kind?: string }).kind === "acceptance-scope-control"
    ) {
      failed = true;
      throw Error("Owned missing-witness ack gap");
    }
  });
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  await expect(reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).rejects.toThrow();
  ui.assertNoScriptErrors();
  h.mock.appendEntry.mockImplementation(append);
  await h.nativeCommand("disable");
  expect(currentRuntime().management?.state).toBe("stopping-with-attention");
  const retained = readControlJournal(h.ctx).acceptance?.scopeReviews?.at(-1);
  expect(retained?.control).toBeDefined();
  expect(retained?.witness).toBeUndefined();
  expect((await repairScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "needs_review",
  );
  expect(scopeControlAttention()).toMatch(/witness/);
  const next = installCustomUI(h.ctx, (d) => {
    d.press("r");
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "rejected",
  );
  next.assertNoScriptErrors();
  expect(scopeControlAttention()).toBeUndefined();
  await h.nativeCommand("disable");
  expect(currentRuntime().management?.mode).toBe("off");
  expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
});
it("a parent revocation blocks its committed successor without falling back to older authority", async () => {
  const h = await fixture(),
    owner = currentWorkOwner(h.ctx.sessionManager.getSessionId())!;
  const first = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    ui = installCustomUI(h.ctx, (d) => {
      d.reviewAll();
    });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, first.proposalId)).status).toBe("committed");
  ui.assertNoScriptErrors();
  const parent = selectedScopeRevision(readControlJournal(h.ctx).acceptance, owner)!;
  const next = proposeScopeRevision(h.mock.api, h.ctx, {
    ...h.input,
    reason: "Further exact amendment within the same existing objects",
    plan: { ...h.input.plan, acceptance: ["second exact condition"] },
    contract: {
      ...h.input.contract,
      requirements: [{ ...h.input.contract.requirements[0]!, text: "second exact condition" }],
    },
  });
  const ui2 = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, next.proposalId)).status).toBe("committed");
  ui2.assertNoScriptErrors();
  const child = selectedScopeRevision(readControlJournal(h.ctx).acceptance, owner)!;
  expect(child.data.previousRevisionRef).toEqual({
    entryId: parent.entryId,
    digest: parent.digest,
  });
  await revokeScopeRevision(h.mock.api, h.ctx, parent.entryId);
  expect(scopeRevisionIssue(readControlJournal(h.ctx).acceptance, owner)).toMatch(/revoked/);
  expect(selectedScopeRevision(readControlJournal(h.ctx).acceptance, owner)?.entryId).toBe(
    child.entryId,
  );
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow(/revoked/i);
}, 15000); // Two complete native document transactions plus source reparsing under V8 coverage.
it("does not bypass unknown captures or transfer a proposal to another Session", async () => {
  const h = await fixture(),
    session = h.ctx.sessionManager.getSessionId();
  vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue("foreign-session");
  const count = h.entries.length;
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow();
  expect(h.entries).toHaveLength(count);
  vi.mocked(h.ctx.sessionManager.getSessionId).mockReturnValue(session);
  currentRuntime().receiptStore!.prepareToolCapture(
    {
      type: "tool_call",
      toolName: "bash",
      toolCallId: "unsettled-source",
      input: { command: "owned unit intent; not executed" },
    },
    [],
    false,
  );
  const pending = h.entries.length;
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow(
    /unknown capture|unsettled/,
  );
  expect(h.entries).toHaveLength(pending);
  expect(currentRuntime().receiptStore?.pendingCount).toBe(1);
});
it.each([
  "active",
  "pending",
  "fault",
  "busy",
  "queue",
  "no-store",
  "active-invocation",
  "invocation-attention",
  "uncompiled",
])("holds scope metadata for %s without writing or dispatching", async (kind) => {
  const h = await fixture(),
    count = h.entries.length,
    calls = h.mock.sendMessage.mock.calls.length;
  if (kind === "active") currentRuntime().supervisor!.status = "active";
  if (kind === "pending") currentRuntime().supervisor!.pending = true;
  if (kind === "fault") currentRuntime().journalFault = "Independent unknown source";
  if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
  if (kind === "queue") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
  if (kind === "no-store") currentRuntime().receiptStore = undefined;
  if (kind === "active-invocation")
    currentRuntime().controlJournal!.invocations!.active.add("unclosed");
  if (kind === "invocation-attention") {
    currentRuntime().invocation = {
      live: new Map(),
      results: new Map(),
      frames: new Map(),
      attention: "Unresolved actual effects",
    };
  }
  if (kind === "uncompiled") currentRuntime().board.finalAcceptanceTaskId = undefined;
  await expect(reviewScopeRevision(h.mock.api, h.ctx, "unknown")).rejects.toThrow();
  expect(h.entries).toHaveLength(count);
  expect(h.mock.sendMessage).toHaveBeenCalledTimes(calls);
});
it.each(["missing", "version", "approval", "start", "proposal", "revoked", "stale"])(
  "rejects a %s original preflight base before scope records",
  async (kind) => {
    const h = await fixture(),
      before = h.entries.length;
    if (kind === "missing") currentRuntime().preflight = undefined;
    else {
      const original = currentRuntime().preflight!;
      if (kind === "version") currentRuntime().preflight = { ...original, version: 1 };
      if (kind === "approval") original.approval = undefined;
      if (kind === "start") original.started = undefined;
      if (kind === "proposal") original.proposal = undefined;
      if (kind === "revoked") original.phase = "revoked";
      if (kind === "stale") original.goal = "Unmatched cached material";
    }
    expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow();
    expect(h.entries).toHaveLength(before);
  },
);
it("exposes only the original proposal tool schema and never grants from its result", async () => {
  const h = await fixture(),
    tool = createProposeScopeRevisionTool(h.mock.api);
  vi.mocked(h.mock.api.getAllTools).mockReturnValue([
    ...h.mock.api.getAllTools(),
    {
      ...tool,
      sourceInfo: {
        path: "owned-test:scope",
        source: "path",
        scope: "temporary",
        origin: "top-level",
      },
      exposure: "direct",
    },
  ]);
  expect(isScopeRevisionProposalTool(h.mock.api, tool.name)).toBe(true);
  expect(isScopeRevisionProposalTool(h.mock.api, "other")).toBe(false);
  const result = await tool.execute("scope-metadata", h.input, undefined, undefined, h.ctx);
  expect(result.isError).not.toBe(true);
  expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
  expect(currentRuntime().supervisor?.status).toBe("paused");
  const malformed = await tool.execute(
    "scope-bad",
    { ...h.input, reason: "" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(malformed.isError).toBe(true);
  const hostFailure: unknown = JSON.parse('"Owned non-Error persistence failure"');
  h.mock.appendEntry.mockImplementation(() => {
    throw hostFailure;
  });
  const failed = await tool.execute("scope-unknown", h.input, undefined, undefined, h.ctx);
  expect(failed.isError).toBe(true);
  expect(failed.content).toEqual([{ type: "text", text: "Scope proposal failed" }]);
});
it("refuses missing/unknown scope IDs, foreign UI and unrelated repair faults without collecting answers", async () => {
  const h = await fixture(),
    count = h.entries.length;
  await expect(reviewScopeRevision(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/Unknown/);
  await expect(repairScopeRevision(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/Unknown/);
  currentRuntime().journalFault = undefined;
  await expect(revokeScopeRevision(h.mock.api, h.ctx, "unknown")).rejects.toThrow(/Unknown/);
  currentRuntime().journalFault = "Unrelated source fault";
  await expect(repairScopeRevision(h.mock.api, h.ctx, "unknown")).rejects.toThrow(
    "Unrelated source fault",
  );
  currentRuntime().journalFault = undefined;
  Object.assign(h.ctx, { mode: "sdk" });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, "unknown")).status).toBe("unsupported");
  expect(h.entries).toHaveLength(count);
});
it.each(["busy", "queue", "epoch", "path"])(
  "does not save a scope response when %s changes during reading",
  async (kind) => {
    const h = await fixture(),
      proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input),
      before = readControlJournal(h.ctx).acceptance?.scopeReviews?.length;
    const ui = installCustomUI(h.ctx, (d) => {
      if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
      if (kind === "queue") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
      if (kind === "epoch") currentRuntime().goalEpoch++;
      if (kind === "path")
        vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue("/missing-foreign-source");
      d.reviewAll();
    });
    expect((await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
      "deferred",
    );
    ui.assertNoScriptErrors();
    vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(h.path);
    expect(readControlJournal(h.ctx).acceptance?.scopeReviews).toHaveLength(before!);
  },
);
it("keeps native review capacity bounded before asking and never discards old proposals", async () => {
  const h = await fixture();
  for (let i = 0; i < 8; i++)
    proposeScopeRevision(h.mock.api, h.ctx, { ...h.input, reason: `Bounded exact proposal ${i}` });
  const count = h.entries.length;
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow(/capacity exhausted/);
  expect(h.entries).toHaveLength(count);
}, 15000);
it("rejects copied control, candidate and commit links against the original native physical source", async () => {
  const h = await fixture(),
    proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    before = readControlJournal(h.ctx).acceptance!;
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId);
  ui.assertNoScriptErrors();
  const full = readControlJournal(h.ctx).acceptance!,
    journal = inspectRestorableSession(h.ctx, true)!,
    review = full.scopeReviews!.at(-1)!,
    candidate = full.contracts.at(-1)!,
    commit = full.scopeCommits!.at(-1)!;
  const position = (id: string) => journal.branch.findIndex((n) => n.id === id),
    fake = { entryId: "foreign-entry", digest: "a".repeat(64) };
  const controls: Array<(d: ScopeRevisionControl) => void> = [
    (d) => {
      d.previousControlRef = fake;
    },
    (d) => {
      if (d.owner.kind === "goal") d.owner.goal.goalKey = "foreign";
    },
    (d) => {
      d.sourceRef = fake;
    },
    (d) => {
      d.frame.sessionId = "foreign";
    },
    (d) => {
      d.frame.baseEntryId = "foreign";
    },
    (d) => {
      d.frame.baseEntryDigest = "a".repeat(64);
    },
    (d) => {
      d.contractId = "foreign";
    },
    (d) => {
      d.revision++;
    },
  ];
  for (const mutate of controls) {
    const copy = structuredClone(review.control.data);
    mutate(copy);
    expect(() => {
      assertScopeControl(before, copy, journal, position(review.control.entryId));
    }).toThrow();
  }
  const repeated = { ...before, scopeReviews: [{ control: review.control }] };
  const duplicate = structuredClone(review.control.data);
  duplicate.previousControlRef = { entryId: review.control.entryId, digest: review.control.digest };
  expect(() => {
    assertScopeControl(repeated, duplicate, journal, position(review.control.entryId));
  }).toThrow();
  const boundView = { ...before, definitions: full.definitions, scopeReviews: [review] };
  const definitions = candidate.data.definitions.map(
    (r) =>
      full.definitions.find((d) => d.entryId === r.ref.entryId && d.digest === r.ref.digest)!.data,
  );
  const bounds: Array<(d: AcceptanceBoundFact) => void> = [
    (d) => {
      d.authority = { kind: "recognized-host", originalGoalDigest: "a".repeat(64) };
    },
    (d) => {
      d.contractId = "foreign";
    },
    (d) => {
      d.revision++;
    },
    (d) => {
      d.previousRef = fake;
    },
    (d) => {
      d.owner = {
        kind: "goal",
        goal: {
          sessionId: "foreign",
          goalKey: "foreign",
          goalRunId: null,
          lifecycleCommitId: null,
        },
      };
    },
    (d) => {
      d.header.requirements[0]!.text = "Unreviewed condition";
    },
    (d) => {
      d.workspace.root = "/unapproved";
    },
    (d) => {
      d.header.artifacts = ["unapproved.txt"];
    },
    (d) => {
      d.sourceRef = fake;
    },
  ];
  for (const mutate of bounds) {
    const copy = structuredClone(candidate.data);
    mutate(copy);
    expect(() => {
      assertScopeBound(copy, definitions, boundView, journal, position(candidate.entryId));
    }).toThrow();
  }
  expect(() => {
    assertScopeBound(
      candidate.data,
      definitions,
      { ...boundView, scopeReviews: [] },
      journal,
      position(candidate.entryId),
    );
  }).toThrow();
  expect(() => {
    assertScopeBound(
      candidate.data,
      definitions,
      { ...boundView, scopeReviews: [{ control: review.control }] },
      journal,
      position(candidate.entryId),
    );
  }).toThrow();
  expect(() => {
    assertScopeBound(
      candidate.data,
      definitions,
      { ...boundView, contracts: [...boundView.contracts, candidate] },
      journal,
      position(candidate.entryId),
    );
  }).toThrow();
  const commits: Array<(d: ScopeRevisionCommitted) => void> = [
    (d) => {
      d.proposalRef = fake;
    },
    (d) => {
      d.controlRef = fake;
    },
    (d) => {
      d.witnessRef = fake;
    },
    (d) => {
      d.previousRevisionRef = fake;
    },
    (d) => {
      d.contractRef = fake;
    },
    (d) => {
      d.sourceRef = fake;
    },
    (d) => {
      if (d.owner.kind === "goal") d.owner.goal.goalKey = "foreign";
    },
  ];
  const commitView = { ...boundView, contracts: full.contracts };
  const cycle = structuredClone(commit);
  cycle.data.previousRevisionRef = { entryId: cycle.entryId, digest: cycle.digest };
  expect(() => scopeIsRevoked({ ...full, scopeCommits: [cycle] }, cycle)).toThrow();
  const missingParent = structuredClone(commit);
  missingParent.data.previousRevisionRef = fake;
  expect(() => scopeIsRevoked({ ...full, scopeCommits: [missingParent] }, missingParent)).toThrow();
  for (const mutate of commits) {
    const copy = structuredClone(commit.data);
    mutate(copy);
    expect(() => {
      assertScopeCommit(commitView, copy, journal, position(commit.entryId));
    }).toThrow();
  }
  const rejected = structuredClone(review);
  rejected.control.data.value = "Reject revision";
  expect(() => {
    assertScopeBound(
      candidate.data,
      definitions,
      { ...boundView, scopeReviews: [rejected] },
      journal,
      position(candidate.entryId),
    );
  }).toThrow();
  expect(() => {
    assertScopeCommit(
      { ...commitView, scopeReviews: [rejected] },
      commit.data,
      journal,
      position(commit.entryId),
    );
  }).toThrow();
  expect(() => {
    assertScopeCommit(
      { ...commitView, scopeReviews: [{ control: review.control }] },
      commit.data,
      journal,
      position(commit.entryId),
    );
  }).toThrow();
  await revokeScopeRevision(h.mock.api, h.ctx, commit.entryId);
  const revoked = readControlJournal(h.ctx).acceptance!.scopeRevocations!.at(-1)!;
  expect(() => {
    assertScopeRevocation(
      { ...full, scopeCommits: [] },
      revoked.data,
      journal,
      journal.branch.length,
    );
  }).toThrow();
  expect(() => {
    assertScopeRevocation(
      { ...full, scopeRevocations: [revoked] },
      revoked.data,
      journal,
      journal.branch.length,
    );
  }).toThrow();
  expect((await revokeScopeRevision(h.mock.api, h.ctx, commit.entryId)).status).toBe(
    "already_revoked",
  );
}, 15000);
it("validates untrusted proposal structure, original scope identity and physical prefix without issuing authority", async () => {
  const h = await fixture(),
    p = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    view = readControlJournal(h.ctx).acceptance!,
    value = view.scopeProposals![0]!.data,
    journal = inspectRestorableSession(h.ctx, true)!;
  expect(validScopeRevisionProposal(value, journal.sessionId)).toBe(true); // Shape only, never approval.
  expect(validScopeRevisionProposal({ ...value, owner: {} }, journal.sessionId)).toBe(false);
  expect(
    validScopeRevisionProposal(
      {
        ...value,
        owner: {
          kind: "board",
          board: { sessionId: journal.sessionId, boardRunId: "b", seedEntryId: "seed" },
        },
      },
      journal.sessionId,
    ),
  ).toBe(false);
  const foreign = structuredClone(value);
  if (foreign.owner.kind === "goal") foreign.owner.goal.sessionId = "foreign";
  expect(validScopeRevisionProposal(foreign, journal.sessionId)).toBe(false);
  expect(validScopeRevisionProposal(value, "foreign")).toBe(false);
  const huge = structuredClone(value);
  huge.plan.steps = Array(20).fill("x".repeat(1000));
  huge.plan.acceptance = Array(20).fill("y".repeat(1000));
  huge.plan.reconfirm = Array(20).fill("z".repeat(1000));
  huge.plan.prohibitions = Array(20).fill("p".repeat(1000));
  expect(validScopeRevisionProposal(huge, journal.sessionId)).toBe(false);
  expect(() => scopeProposalFor(view, { entryId: "missing", digest: "a".repeat(64) })).toThrow();
  expect(() => scopeNodeBefore(journal, value.sourceRef, 0)).toThrow();
  expect(() =>
    scopeNodeBefore(journal, { ...value.sourceRef, digest: "a".repeat(64) }, journal.branch.length),
  ).toThrow();
  expect(() =>
    scopeNodeBefore(
      { ...journal, branch: journal.branch.filter((n) => n.id !== value.sourceRef.entryId) },
      value.sourceRef,
      journal.branch.length,
    ),
  ).toThrow();
  const wrong = structuredClone(value);
  wrong.basePreflightRef = value.sourceRef;
  expect(() => scopeProposalBase(journal, wrong, journal.branch.length)).toThrow();
  const scoped = structuredClone(value);
  if (scoped.owner.kind === "goal") {
    scoped.owner.goal.goalRunId = "different";
    scoped.owner.goal.lifecycleCommitId = "different";
  }
  expect(() => scopeProposalBase(journal, scoped, journal.branch.length)).toThrow();
  const changed = structuredClone(value);
  changed.plan.prohibitions = [];
  expect(() => scopeProposalBase(journal, changed, journal.branch.length)).toThrow();
  expect(p.status).toBe("proposed");
  expect(view.scopeCommits).toHaveLength(0);
});
it("routes scope review, repair and revocation only through canonical native commands", async () => {
  const h = await fixture();
  for (const action of ["review-scope", "repair-scope", "revoke-scope"]) {
    await h.nativeCommand(action);
    expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain("Usage:");
  }
  const proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    original = structuredClone(currentRuntime().preflight),
    state = structuredClone(currentRuntime().supervisor);
  await h.nativeCommand(`review-scope ${proposal.proposalId}`);
  const owner = currentWorkOwner(h.ctx.sessionManager.getSessionId())!,
    commit = selectedScopeRevision(readControlJournal(h.ctx).acceptance, owner)!;
  expect(commit).toBeDefined();
  expect(currentRuntime().preflight).toEqual(original);
  expect(currentRuntime().supervisor).toEqual(state);
  await h.nativeCommand(`repair-scope ${proposal.proposalId}`);
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain("already_saved");
  await h.nativeCommand(`revoke-scope ${commit.entryId}`);
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain("revoked");
  expect(currentRuntime().supervisor?.status).toBe("paused");
  await h.nativeCommand("supervise --replan Scope same original Goal");
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toMatch(/Started Goal/);
  expect(currentRuntime().supervisor).toEqual(state);
});
it("binds scope revisions to an actual lifecycle-scoped Goal and its original permission/Start witnesses", async () => {
  const g = await goalFixture({ gitWorkspace: true });
  try {
    await g.command("supervise Lifecycle-scoped scope amendment");
    const submitted = await createSubmitPreflightTool(g.api).execute(
      "scoped-plan",
      {
        preflightId: currentRuntime().preflight!.preflightId,
        proposal: await completeGoalProposal(g),
      },
      undefined,
      undefined,
      g.ctx,
    );
    expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
    vi.mocked(g.ctx.ui.select).mockResolvedValue("开始执行");
    await g.command("start");
    expect(
      currentRuntime().supervisor?.status,
      JSON.stringify(vi.mocked(g.ctx.ui.notify).mock.calls),
    ).toBe("active");
    await createWriteTasksTool(g.api).execute(
      "scoped-board",
      {
        mode: "replace",
        phases: [
          {
            title: "Current",
            tasks: [{ title: "Final", prompt: "Verify current conditions", profile: "main" }],
          },
        ],
      },
      undefined,
      undefined,
      g.ctx,
    );
    const compiled = await createCompileTasksTool(g.api).execute(
      "scoped-compile",
      { finalAcceptanceTaskId: "t-1.1" },
      undefined,
      undefined,
      g.ctx,
    );
    expect(compiled.isError).not.toBe(true);
    await g.command("pause Exact same-owner amendment");
    const source = scopeRevisionContractContext(g.ctx),
      plan = structuredClone(currentRuntime().preflight!.proposal!);
    delete plan.contractProposalId;
    const proposed = proposeScopeRevision(g.api, g.ctx, {
      plan: { ...plan, acceptance: ["Exact current scoped condition"] },
      contract: {
        ...source.proposal,
        requirements: source.proposal.requirements.map((r) => ({
          ...r,
          text: r.text + "; exact revised condition",
        })),
      },
      reason: "Precise scoped amendment within original objects",
    });
    const ui = installCustomUI(g.ctx, (d) => {
      d.reviewAll();
    });
    expect((await reviewScopeRevision(g.api, g.ctx, proposed.proposalId)).status).toBe("committed");
    ui.assertNoScriptErrors();
    const committed = selectedScopeRevision(readControlJournal(g.ctx).acceptance, source.owner)!;
    expect(committed.data.owner).toEqual(source.owner);
    expect(source.owner.goal.goalRunId).toBe(currentRuntime().goal!.current!.scope.goalRunId);
    expect(currentRuntime().supervisor?.status).toBe("paused");
    const count = g.appendEntry.mock.calls.length;
    await g.command("supervise --replan Lifecycle-scoped scope amendment");
    expect(g.appendEntry).toHaveBeenCalledTimes(count);
    expect(vi.mocked(g.ctx.ui.notify).mock.calls.at(-1)?.[0]).toMatch(/Started Goal/);
  } finally {
    g.restoreHost();
    rmSync(g.dir, { recursive: true, force: true });
  }
}, 15000);
it("rejects unfenced, duplicate, foreign-contract and over-capacity proposal projections", async () => {
  const h = await fixture(),
    p = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    journal = inspectRestorableSession(h.ctx, true)!,
    node = journal.nodes.get(p.ref.entryId)!,
    data = structuredClone(readControlJournal(h.ctx).acceptance!.scopeProposals![0]!.data);
  const projected = (value: typeof data) => {
    const copy = { ...node, data: value };
    return {
      ...journal,
      branch: journal.branch.map((n) => (n.id === node.id ? copy : n)),
      nodes: new Map([...journal.nodes, [node.id, copy]]),
    };
  };
  const changed = structuredClone(data);
  changed.plan.contractProposalId = "not-the-source-proposal";
  expect(() => scopeRevisionProposalViews(projected(changed))).toThrow();
  const old = structuredClone(data);
  old.previousContractRef = old.sourceRef;
  expect(() => scopeRevisionProposalViews(projected(old))).toThrow();
  const missing = structuredClone(data);
  missing.contractProposalRef = { entryId: "missing", digest: "a".repeat(64) };
  expect(() => scopeRevisionProposalViews(projected(missing))).toThrow();
  const noFence = {
    ...journal,
    branch: journal.branch.filter(
      (n) =>
        !(
          n.data &&
          typeof n.data === "object" &&
          "features" in n.data &&
          Array.isArray(n.data.features) &&
          n.data.features.includes("scope-revision-v1")
        ),
    ),
  };
  expect(() => scopeRevisionProposalViews(noFence)).toThrow();
  const duplicate = { ...node, id: "duplicate-source-entry", parentId: node.id };
  expect(() =>
    scopeRevisionProposalViews({
      ...journal,
      branch: [...journal.branch, duplicate],
      nodes: new Map([...journal.nodes, [duplicate.id, duplicate]]),
    }),
  ).toThrow();
  const extras = Array.from({ length: 8 }, (_, i) => ({
    ...node,
    id: `extra-untrusted-${i}`,
    data: { ...data, proposalId: `extra-${i}` },
  }));
  expect(() =>
    scopeRevisionProposalViews({
      ...journal,
      branch: [...journal.branch, ...extras],
      nodes: new Map([...journal.nodes, ...extras.map((n) => [n.id, n] as const)]),
    }),
  ).toThrow();
  const base = journal.nodes.get(data.basePreflightRef.entryId)!;
  if (!base.data || typeof base.data !== "object") throw Error("Original base unavailable");
  const stored = structuredClone(base.data) as { started: { controlEntryId: string } };
  stored.started.controlEntryId = "unmatched-first-start";
  const baseNode = { ...base, data: stored, digest: journalDigest(stored) },
    withBase = {
      ...journal,
      branch: journal.branch.map((n) => (n.id === base.id ? baseNode : n)),
      nodes: new Map([...journal.nodes, [base.id, baseNode]]),
    };
  expect(() =>
    scopeProposalBase(
      withBase,
      { ...data, basePreflightRef: { entryId: base.id, digest: baseNode.digest } },
      withBase.branch.length,
    ),
  ).toThrow();
  const baseMutations: Array<(v: PreflightState) => void> = [
    (v) => {
      v.planDigest = "a".repeat(64);
    },
    (v) => {
      v.goal = "Not the original Goal";
    },
    (v) => {
      if (v.approval) v.approval.controlEntryId = "foreign";
    },
    (v) => {
      if (v.approval) v.approval.permissionIds = [];
    },
  ];
  for (const mutate of baseMutations) {
    const bad = structuredClone(base.data) as PreflightState;
    mutate(bad);
    const altered = { ...base, data: bad, digest: journalDigest(bad) },
      source = {
        ...journal,
        branch: journal.branch.map((n) => (n.id === base.id ? altered : n)),
        nodes: new Map([...journal.nodes, [base.id, altered]]),
      };
    expect(() =>
      scopeProposalBase(
        source,
        { ...data, basePreflightRef: { entryId: base.id, digest: altered.digest } },
        source.branch.length,
      ),
    ).toThrow();
  }
  expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
}, 15000);
it("refuses a seventeenth native response before opening another question", async () => {
  const h = await fixture(),
    p = proposeScopeRevision(h.mock.api, h.ctx, h.input);
  const ui = installCustomUI(h.ctx, (d) => {
    d.press("r");
  });
  for (let i = 0; i < 16; i++)
    expect((await reviewScopeRevision(h.mock.api, h.ctx, p.proposalId)).status).toBe("rejected");
  ui.assertNoScriptErrors();
  const calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await expect(reviewScopeRevision(h.mock.api, h.ctx, p.proposalId)).rejects.toThrow(
    /capacity exhausted/,
  );
  expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(calls);
  expect(readControlJournal(h.ctx).acceptance?.scopeReviews).toHaveLength(16);
  expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
}, 60000); // Sixteen real native responses/source folds under V8 instrumentation; production caps stay16.
it("rejects added permission, workspace and runtime objects before metadata writes", async () => {
  const h = await fixture(),
    count = h.entries.length;
  const permissions = [...h.input.plan.permissions, { ...h.input.plan.permissions[0]!, id: "new" }];
  expect(() =>
    proposeScopeRevision(h.mock.api, h.ctx, { ...h.input, plan: { ...h.input.plan, permissions } }),
  ).toThrow(/permission objects/);
  expect(() =>
    proposeScopeRevision(h.mock.api, h.ctx, {
      ...h.input,
      contract: { ...h.input.contract, artifacts: ["other.txt"] },
    }),
  ).toThrow(/objects/);
  expect(h.entries).toHaveLength(count);
});
