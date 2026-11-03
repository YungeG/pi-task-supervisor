import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { goalFixture, completeGoalProposal } from "./helpers/goal";
import {
  scopeRevisionContractContext,
  executeRegisteredCheck,
  prepareScopeRevisionContract,
  proposeAcceptanceContract,
} from "../acceptance-runtime";
import { preflightLifecycle, localProposal } from "./helpers/preflight";
import { installCustomUI } from "./helpers/custom-ui";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { createProposeContractTool, createProposeScopeRevisionTool } from "../acceptance-tool";
import { isScopeRevisionProposalTool } from "../scope-revision-schema";
import { createSubmitPreflightTool, createWriteTasksTool, createCompileTasksTool } from "../tools";
import { readControlJournal, currentWorkOwner } from "../control-journal";
import { selectedAcceptanceContract, validAcceptanceFact } from "../acceptance-journal";
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
  cachedScopeFlow,
  scopeEffectivePlan,
} from "../scope-revision-journal";
import {
  qualifiedEvidence,
  captureInvocationFrame,
  invocationFrameCurrent,
} from "../qualified-evidence";
import { recoverSupervisor } from "../supervisor";
import { ownedCodemode } from "./helpers/owned-codemode";
import { retainScopeV1Candidate } from "./helpers/retained-scope-proposal";
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
import { preflightContext, type PreflightState } from "../preflight";
import { flowFacts, nextFlowStep } from "../flow";
import type { AcceptanceProposal } from "../acceptance-proposal";
import * as checkRunner from "../check-runner";

beforeEach(resetState);
async function fixture(resourceLimits?: string, requirementCount = 1) {
  const h = preflightLifecycle(),
    root = dirname(h.path);
  const plan = resourceLimits
    ? {
        ...localProposal,
        permissions: localProposal.permissions.map((p, i) =>
          i === 0 ? { ...p, limits: resourceLimits } : p,
        ),
      }
    : localProposal;
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
    requirements: Array.from({ length: requirementCount }, (_, i) => ({
      requirementId: i ? `output-${i}` : "output",
      source: "original condition",
      text: "produce output",
      required: true,
    })),
    checks: [
      {
        kind: "automatic",
        checkId: "output",
        requirementIds: Array.from({ length: requirementCount }, (_, i) =>
          i ? `output-${i}` : "output",
        ),
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
      proposal: { ...plan, contractProposalId: proposalId },
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
    plan: { ...plan, acceptance: ["produce the revised exact output"] },
    contract: {
      ...contract,
      requirements: contract.requirements.map((r) => ({
        ...r,
        text: "produce the revised exact output",
      })),
    },
    reason: "Precisely amend an existing condition, no new object or authority",
  };
  return { ...h, root, input };
}
it("refuses an unadoptable completed-board scope before collecting native approval", async () => {
  let inspected = false;
  const result = await ownedCodemode("normal", {
    directCheck: true,
    checkTool: "run_check",
    finalAction: "hold",
    prepare: (dir) => {
      writeFileSync(
        join(dir, "checker.mjs"),
        "import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync(new URL('./input.txt',import.meta.url),'utf8'),'owned\\n');console.log(JSON.stringify({protocol:'check-result-v1',tests:1,passed:1,failed:0,skipped:0,requiredCases:{input:'passed'},skippedIds:[]}));",
      );
    },
    approvalWorkflow: {
      proposal: () => localProposal,
      produce: () => undefined,
      contract: () => ({
        version: 1,
        scopeId: "completed-scope",
        inputs: ["input.txt", "checker.mjs"],
        artifacts: [],
        environment: { profileId: "owned", values: {} },
        requirements: [
          {
            requirementId: "input",
            source: "Owned original native Goal",
            text: "Finite input check",
            required: true,
          },
        ],
        checks: [
          {
            kind: "automatic",
            checkId: "required-node",
            requirementIds: ["input"],
            script: "checker.mjs",
            checkerFiles: ["checker.mjs"],
            configs: [],
            args: [],
            timeoutMs: 1000,
            expected: { minTests: 1, requiredCases: ["input"], allowedSkipped: [] },
          },
        ],
      }),
    },
    afterSettled: async (pi, ctx) => {
      if (getBoard().workflowStatus !== "completed" || inspected) return;
      inspected = true;
      expect(["paused", "fault"]).toContain(currentRuntime().supervisor?.status);
      const questions = vi.spyOn(ctx.ui, "custom");
      const before = readFileSync(ctx.sessionManager.getSessionFile()!, "utf8");
      const source = scopeRevisionContractContext(ctx);
      expect(() => proposeAcceptanceContract(pi, ctx, source.proposal)).toThrow(
        /Completed work stays closed.*no new scope adoption/,
      );
      expect(() =>
        proposeScopeRevision(pi, ctx, {
          plan: currentRuntime().preflight!.proposal!,
          contract: {
            ...source.proposal,
            requirements: source.proposal.requirements.map((r) => ({
              ...r,
              text: r.text + " precise amendment",
            })),
          },
          reason: "Owned completed work must not commit a scope it cannot adopt",
        }),
      ).toThrow(/completed.*scope|scope.*completed/i);
      expect(questions).not.toHaveBeenCalled();
      expect(readFileSync(ctx.sessionManager.getSessionFile()!, "utf8")).toBe(before);
      // Retained scope-v1 metadata from before completed-board admission existed;
      // actual SDK work is already completed above, not a copied board DTO.
      retainScopeV1Candidate(pi, ctx, {
        plan: currentRuntime().preflight!.proposal!,
        contract: source.proposal,
        reason: "Historical pending metadata; never reopen completed business",
      });
      expect(cachedScopeFlow(ctx)?.stage).toBe("closed");
      expect(cachedScopeFlow(ctx)?.next).not.toContain("review-scope");
      expect(questions).not.toHaveBeenCalled();
      questions.mockRestore();
    },
  });
  expect(inspected).toBe(true);
  expect(result.errors).toEqual([]);
}, 20000);
it("reviews exact business resource conditions without refilling Supervisor budgets or rewriting history", async () => {
  const h = await fixture(
      "Active <=120 seconds; reads <=64 MiB; RSS <=512 MiB. Old usage stays unknown.",
    ),
    before = structuredClone(currentRuntime().supervisor),
    original = structuredClone(currentRuntime().preflight),
    input = structuredClone(h.input);
  input.plan.permissions[0]!.limits =
    "Future active <=600 seconds; reads <=256 MiB; RSS <=1024 MiB. Old usage stays unknown, not zero.";
  const spec = input.contract.checks[0]!;
  if (spec.kind !== "automatic") throw Error("Expected original finite check");
  spec.timeoutMs = 30000;
  const p = proposeScopeRevision(h.mock.api, h.ctx, input);
  expect(currentRuntime().supervisor).toEqual(before);
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, p.proposalId)).status).toBe("committed");
  ui.assertNoScriptErrors();
  expect(currentRuntime().supervisor).toEqual(before);
  expect(ui.rendered.join("\n")).toContain("历史计量");
  const description = createProposeScopeRevisionTool(h.mock.api).description;
  expect(description).not.toContain("budgets cannot expand/reset");
  expect(description).toContain("business resource conditions");
  await h.command("resume");
  await h.command("recover");
  expect(currentRuntime().supervisor?.reviews).toBe(before?.reviews);
  expect(currentRuntime().supervisor?.continuations).toBe(before?.continuations);
  expect(currentRuntime().preflight).toEqual(original);
  const view = readControlJournal(h.ctx),
    owner = currentWorkOwner(h.ctx.sessionManager.getSessionId())!;
  expect(scopeEffectivePlan(view.acceptance, owner)?.permissions[0]?.limits).toBe(
    input.plan.permissions[0]!.limits,
  );
});
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
  const context = preflightContext(h.ctx);
  expect(context).toContain("revoked");
  expect(context).not.toContain("Main may submit a complete propose_scope_revision");
  expect(nextFlowStep(getBoard(), currentRuntime().supervisor, flowFacts(h.ctx))).not.toContain(
    "recover",
  );
  await h.command("pause Retain revoked scope");
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).not.toContain("propose_scope_revision");
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
  expect(preflightContext(h.ctx)).not.toContain("/task-supervisor repair-preflight");
  writeFileSync(join(h.root, "checker.mjs"), "// explicitly changed material needs fresh review\n");
  expect((await repairScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "needs_review",
  );
  expect(nextFlowStep(getBoard(), currentRuntime().supervisor, flowFacts(h.ctx))).toContain(
    `review-scope ${proposal.proposalId}`,
  );
  await h.nativeCommand(`repair-scope ${proposal.proposalId}`);
  const notice = vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0];
  expect(notice).toContain(`review-scope ${proposal.proposalId}`);
  expect(notice).toContain("changed");
  const file = h.ctx.sessionManager.getSessionFile();
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue("/foreign/display-source.jsonl");
  expect(cachedScopeFlow(h.ctx)?.stage).not.toBe("needs_review");
  vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(file);
  const physical = readFileSync(h.path, "utf8");
  await h.fire("session_tree", {});
  expect(cachedScopeFlow(h.ctx)?.stage).not.toBe("needs_review");
  expect(readFileSync(h.path, "utf8")).toBe(physical);
  expect((await repairScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "needs_review",
  );
  expect(cachedScopeFlow(h.ctx)?.stage).toBe("needs_review");
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
it("hands explicit paused Main turns metadata-only guidance without automatically dispatching them", async () => {
  const h = await fixture(),
    tool = createProposeScopeRevisionTool(h.mock.api);
  vi.mocked(h.mock.api.getAllTools).mockReturnValue([
    ...h.mock.api.getAllTools(),
    {
      ...tool,
      exposure: "direct",
      sourceInfo: {
        path: "owned-test:scope",
        source: "path",
        scope: "temporary",
        origin: "top-level",
      },
    },
  ]);
  await h.command("resume");
  const denied = await tool.execute("active-scope", h.input, undefined, undefined, h.ctx);
  expect(denied.isError).toBe(true);
  expect(denied.details).toMatchObject({ code: "SCOPE_NOT_HELD" });
  expect(JSON.stringify(denied)).toContain("/task-supervisor pause");
  h.mock.sendMessage.mockClear();
  await h.command("pause Exact scope metadata only");
  expect(h.mock.sendMessage.mock.calls.some(([, options]) => options?.triggerTurn)).toBe(false);
  expect(
    vi
      .mocked(h.ctx.ui.notify)
      .mock.calls.map(([text]) => text)
      .join("\n"),
  ).toContain("Main未排队");
  const state = structuredClone(currentRuntime().supervisor),
    original = structuredClone(currentRuntime().preflight);
  const context = await h.fire("before_agent_start", {
    prompt: "Keep paused; submit metadata only",
  });
  expect(JSON.stringify(context)).toContain("propose_scope_revision");
  expect(JSON.stringify(context)).toContain("reason");
  expect(
    await h.fire("tool_call", {
      toolName: tool.name,
      toolCallId: "paused-metadata",
      input: h.input,
    }),
  ).toBeUndefined();
  const proposal = await tool.execute("paused-metadata", h.input, undefined, undefined, h.ctx);
  expect(proposal.isError).not.toBe(true);
  expect(currentRuntime().supervisor).toEqual(state);
  expect(currentRuntime().preflight).toEqual(original);
  expect(readControlJournal(h.ctx).acceptance?.scopeCommits).toHaveLength(0);
  expect(
    await h.fire("tool_call", {
      toolName: "write",
      toolCallId: "forbidden-paused-write",
      input: { path: "bad", content: "bad" },
    }),
  ).toMatchObject({ block: true });
});
it.each(["missing-file", "profile-limit", "foreign-source"])(
  "keeps %s material unproposed and performs no dispatch or avoidable file capture",
  async (kind) => {
    const h = await fixture(),
      input = structuredClone(h.input),
      spec = input.contract.checks[0]!;
    if (spec.kind !== "automatic") throw Error("Expected finite check");
    if (kind === "missing-file") rmSync(join(h.root, "checker.mjs"));
    if (kind === "profile-limit") spec.timeoutMs = 30001;
    if (kind === "foreign-source")
      vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue("/foreign/unavailable.jsonl");
    const before = readFileSync(h.path, "utf8"),
      calls = h.mock.sendMessage.mock.calls.length,
      prompts = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    const capture = vi.spyOn(checkRunner, "captureCheckDefinitionVersion");
    try {
      const result = await createProposeScopeRevisionTool(h.mock.api).execute(
        "unreviewable",
        input,
        undefined,
        undefined,
        h.ctx,
      );
      expect(result.isError).toBe(true);
      if (kind !== "missing-file") expect(capture).not.toHaveBeenCalled();
    } finally {
      capture.mockRestore();
    }
    expect(readFileSync(h.path, "utf8")).toBe(before);
    expect(h.mock.sendMessage).toHaveBeenCalledTimes(calls);
    expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(prompts);
  },
);
it("recaptures actual definition bytes at native review, not a submission-time proof or repeated-proposal cache", async () => {
  const h = await fixture(),
    proposal = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    before = readFileSync(h.path, "utf8");
  const path = join(h.root, "checker.mjs"),
    changed =
      readFileSync(path, "utf8") + "// Newly frozen exact definition after metadata preflight\n";
  writeFileSync(path, changed);
  expect(proposeScopeRevision(h.mock.api, h.ctx, h.input).ref).toEqual(proposal.ref);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, proposal.proposalId)).status).toBe(
    "committed",
  );
  ui.assertNoScriptErrors();
  const view = readControlJournal(h.ctx).acceptance!,
    bound = view.contracts.at(-1)!,
    ref = bound.data.definitions[0]!.ref;
  const actual = view.definitions.find((d) => d.entryId === ref.entryId && d.digest === ref.digest)!
    .data.frozenFiles[0]!.sha256;
  expect(actual).toBe(createHash("sha256").update(changed).digest("hex"));
  expect(ui.rendered.join("\n")).toContain(actual);
  expect(currentRuntime().supervisor?.status).toBe("paused");
});
it("rejects a structurally valid but unfreezable scope before any metadata or feature append", async () => {
  const h = await fixture(),
    input = structuredClone(h.input),
    spec = input.contract.checks[0]!;
  if (spec.kind !== "automatic") throw Error("Expected finite check");
  spec.args = Array.from({ length: 16 }, (_, i) => `arg${i}-` + "x".repeat(890));
  const delta = 14899 - Buffer.byteLength(JSON.stringify(input.contract)),
    last = spec.args[15]!;
  spec.args[15] = delta >= 0 ? last + "x".repeat(delta) : last.slice(0, last.length + delta);
  expect(Buffer.byteLength(JSON.stringify(input.contract))).toBe(14899);
  expect(spec.args.every((arg) => arg.length <= 1000)).toBe(true);
  const before = readFileSync(h.path, "utf8"),
    state = structuredClone(currentRuntime().supervisor),
    prompts = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  for (let i = 0; i < 3; i++)
    expect(() => proposeScopeRevision(h.mock.api, h.ctx, input)).toThrow(/16KiB|capacity/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(currentRuntime().supervisor).toEqual(state);
  expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(prompts);
  expect(readControlJournal(h.ctx).acceptance?.scopeProposals ?? []).toHaveLength(0);
});
it("checks the closed-board gate before recapturing retained unreviewable metadata (deny-only stage fixture)", async () => {
  const h = await fixture(),
    large = structuredClone(h.input),
    spec = large.contract.checks[0]!;
  if (spec.kind !== "automatic") throw Error("Expected finite check");
  spec.args = Array.from({ length: 16 }, () => "x".repeat(890));
  const retained = retainScopeV1Candidate(h.mock.api, h.ctx, large);
  // This cache change proves rejection precedence only, never completed-business authority.
  currentRuntime().board.workflowStatus = "completed";
  const before = readFileSync(h.path, "utf8"),
    capture = vi.spyOn(checkRunner, "captureCheckDefinitionVersion");
  try {
    await expect(reviewScopeRevision(h.mock.api, h.ctx, retained.data.proposalId)).rejects.toThrow(
      /Completed task board/,
    );
    expect(capture).not.toHaveBeenCalled();
  } finally {
    capture.mockRestore();
  }
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("reports a conservative plan/ref upper bound before writing when the raw UTF-8 plan is near16000", async () => {
  const h = await fixture(),
    input = structuredClone(h.input);
  input.plan.steps = Array.from({ length: 4 }, (_, i) => `${i}${"界".repeat(999)}`);
  input.plan.steps.push(
    "界".repeat(Math.floor((15800 - Buffer.byteLength(JSON.stringify(input.plan))) / 3)),
  );
  const before = readFileSync(h.path, "utf8");
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, input)).toThrow(/plan capacity upper bound/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("sizes UTF-8 material with long refs and actual scope authority/deterministic IDs, not a shorter generic record", async () => {
  const h = await fixture(undefined, 4),
    input = structuredClone(h.input),
    prepared = prepareScopeRevisionContract(h.ctx, input.contract, "proposal");
  const requirements = input.contract.requirements.map((r) => ({
    ...r,
    source: "界".repeat(300),
    text: "",
  }));
  const generic = {
    ...prepared.base,
    header: { ...prepared.base.header, requirements },
    authority: { kind: "recognized-host" as const, originalGoalDigest: "a".repeat(64) },
    definitions: prepared.definitions.map((d) => ({
      checkId: d.spec.checkId,
      ref: { entryId: "x".repeat(200), digest: "a".repeat(64) },
      definitionDigest: d.definitionDigest,
    })),
    contractDigest: "a".repeat(64),
  };
  const size = (target: number) => {
    for (const r of requirements) r.text = "";
    let remaining = target - Buffer.byteLength(JSON.stringify(generic));
    for (let i = 0; i < requirements.length; i++) {
      const bytes = Math.min(3600, remaining - (requirements.length - 1 - i)),
        remainder = bytes % 3;
      requirements[i]!.text =
        "界".repeat(Math.floor(bytes / 3)) + (remainder === 2 ? "é" : remainder === 1 ? "x" : "");
      remaining -= bytes;
    }
    expect(remaining).toBe(0);
    expect(Buffer.byteLength(JSON.stringify(generic))).toBe(target);
    input.contract.requirements = structuredClone(requirements);
  };
  size(16284);
  expect(validAcceptanceFact(generic, h.ctx.sessionManager.getSessionId())).toBe(true);
  const before = readFileSync(h.path, "utf8");
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, input)).toThrow(/16KiB/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  size(15500);
  input.plan.steps = Array.from({ length: 4 }, (_, i) => `${i}${"界".repeat(999)}`);
  input.plan.steps.push(
    "界".repeat(Math.floor((15500 - Buffer.byteLength(JSON.stringify(input.plan))) / 3)),
  );
  const p = proposeScopeRevision(h.mock.api, h.ctx, input),
    ui = installCustomUI(h.ctx, (d) => {
      d.reviewAll();
    });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, p.proposalId)).status).toBe("committed");
  ui.assertNoScriptErrors();
  const committedBytes = readFileSync(h.path, "utf8");
  expect(() =>
    proposeScopeRevision(h.mock.api, h.ctx, {
      ...input,
      reason: "Second large full document, do not omit historical conditions",
    }),
  ).toThrow(/64KB/);
  expect(readFileSync(h.path, "utf8")).toBe(committedBytes);
});
it.each([false, true])(
  "routes a retained oversized scope to Main after actual reviewability failure (cold=%s)",
  async (cold) => {
    const h = await fixture(),
      large = structuredClone(h.input),
      spec = large.contract.checks[0]!;
    if (spec.kind !== "automatic") throw Error("Expected finite check");
    spec.args = Array.from({ length: 16 }, (_, i) => `arg${i}-` + "x".repeat(890));
    const saved = retainScopeV1Candidate(h.mock.api, h.ctx, large),
      before = readFileSync(h.path, "utf8");
    if (cold) await h.fire("session_tree", {});
    const prompts = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    await h.nativeCommand(`review-scope ${saved.data.proposalId}`);
    const notice = vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0];
    expect(notice).toContain("Main");
    expect(cachedScopeFlow(h.ctx)?.stage).toBe("unreviewable");
    const next = nextFlowStep(getBoard(), currentRuntime().supervisor, flowFacts(h.ctx));
    expect(next).toContain("Main");
    expect(next).not.toContain(`review-scope ${saved.data.proposalId}`);
    expect(
      JSON.stringify(
        await h.fire("before_agent_start", { prompt: "Explain exact material failure only" }),
      ),
    ).toContain("Main");
    const definitionCapture = vi.spyOn(checkRunner, "captureCheckDefinitionVersion"),
      executionCapture = vi.spyOn(checkRunner, "captureCheckVersion");
    try {
      await h.command("status");
      expect(definitionCapture).not.toHaveBeenCalled();
      expect(executionCapture).not.toHaveBeenCalled();
    } finally {
      definitionCapture.mockRestore();
      executionCapture.mockRestore();
    }
    expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain("Main");
    expect(readFileSync(h.path, "utf8")).toBe(before);
    expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(prompts);
    vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue("/foreign/display-source.jsonl");
    expect(cachedScopeFlow(h.ctx)?.stage).not.toBe("unreviewable");
    vi.mocked(h.ctx.sessionManager.getSessionFile).mockReturnValue(h.path);
    currentRuntime().goalEpoch++;
    expect(cachedScopeFlow(h.ctx)?.stage).not.toBe("unreviewable");
    await h.nativeCommand(`review-scope ${saved.data.proposalId}`);
    expect(cachedScopeFlow(h.ctx)?.stage).toBe("unreviewable");
    const small = proposeScopeRevision(h.mock.api, h.ctx, h.input),
      ui = installCustomUI(h.ctx, (d) => {
        d.reviewAll();
      });
    expect(small.proposalId).not.toBe(saved.data.proposalId);
    expect(cachedScopeFlow(h.ctx)?.stage).toBe("review");
    expect((await reviewScopeRevision(h.mock.api, h.ctx, small.proposalId)).status).toBe(
      "committed",
    );
    ui.assertNoScriptErrors();
  },
);
it("reuses only the latest identical pending scope without consuming the eight genuine proposal slots", async () => {
  const h = await fixture(),
    first = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    before = readFileSync(h.path, "utf8");
  for (let i = 0; i < 8; i++) {
    const again = proposeScopeRevision(h.mock.api, h.ctx, {
      ...h.input,
      plan: { ...h.input.plan, contractProposalId: "untrusted-derived-value" },
    });
    expect(again.proposalId).toBe(first.proposalId);
    expect(again.ref).toEqual(first.ref);
  }
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(readControlJournal(h.ctx).acceptance?.scopeProposals).toHaveLength(1);
  for (let i = 1; i < 8; i++)
    proposeScopeRevision(h.mock.api, h.ctx, { ...h.input, reason: `Distinct exact reason ${i}` });
  const full = readFileSync(h.path, "utf8");
  const latest = proposeScopeRevision(h.mock.api, h.ctx, {
    ...h.input,
    reason: "Distinct exact reason 7",
  });
  expect(latest.proposalId).toBe(
    readControlJournal(h.ctx).acceptance?.scopeProposals?.at(-1)?.data.proposalId,
  );
  expect(readFileSync(h.path, "utf8")).toBe(full);
  expect(() =>
    proposeScopeRevision(h.mock.api, h.ctx, { ...h.input, reason: "Ninth genuine material" }),
  ).toThrow(/capacity/);
  expect(readFileSync(h.path, "utf8")).toBe(full);
});
it.each(["contract", "plan"])(
  "counts distinct full %s values with the same reason, while reusing a cancelled pending candidate at capacity",
  async (kind) => {
    const h = await fixture();
    const input = (i: number) => ({
      ...h.input,
      ...(kind === "plan"
        ? { plan: { ...h.input.plan, steps: [`Exact step variant${i}`] } }
        : {
            contract: {
              ...h.input.contract,
              requirements: h.input.contract.requirements.map((r) => ({
                ...r,
                text: `Exact requirement variant${i}`,
              })),
            },
          }),
    });
    for (let i = 0; i < 8; i++) proposeScopeRevision(h.mock.api, h.ctx, input(i));
    const before = readFileSync(h.path, "utf8"),
      pending = proposeScopeRevision(h.mock.api, h.ctx, input(7));
    expect(pending.reused).toBe(true);
    expect(readFileSync(h.path, "utf8")).toBe(before);
    expect(() => proposeScopeRevision(h.mock.api, h.ctx, input(8))).toThrow(/capacity/);
    const ui = installCustomUI(h.ctx, (d) => {
      d.press("\u001b");
    });
    expect((await reviewScopeRevision(h.mock.api, h.ctx, pending.proposalId)).status).toBe(
      "deferred",
    );
    ui.assertNoScriptErrors();
    expect(proposeScopeRevision(h.mock.api, h.ctx, input(7)).ref).toEqual(pending.ref);
    expect(readFileSync(h.path, "utf8")).toBe(before);
  },
  15000, // Eight distinct physical proposals plus exact native cancellation under V8; production counts/caps are unchanged.
);
it("does not revive an older pending A after B or reuse a native response as new proposal authority", async () => {
  const h = await fixture(),
    a = proposeScopeRevision(h.mock.api, h.ctx, h.input);
  const b = proposeScopeRevision(h.mock.api, h.ctx, { ...h.input, reason: "B exact replacement" });
  const againA = proposeScopeRevision(h.mock.api, h.ctx, h.input);
  expect(againA.proposalId).not.toBe(a.proposalId);
  expect(againA.proposalId).not.toBe(b.proposalId);
  const ui = installCustomUI(h.ctx, (d) => {
    d.press("r");
  });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, againA.proposalId)).status).toBe("rejected");
  ui.assertNoScriptErrors();
  const before = readFileSync(h.path, "utf8");
  expect(() => proposeScopeRevision(h.mock.api, h.ctx, h.input)).toThrow(
    /responded|review|repair/i,
  );
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("rejects ordinary post-compilation contract metadata before writing and points at the usable scope route", async () => {
  const h = await fixture();
  await h.command("resume");
  writeFileSync(join(h.root, "checker.mjs"), "// changed definition; no process run\n");
  await expect(executeRegisteredCheck(h.mock.api, h.ctx, "not-admitted", "output")).rejects.toThrow(
    /propose_scope_revision|review-scope/,
  );
  const before = readFileSync(h.path, "utf8"),
    prompts = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  const result = await createProposeContractTool(h.mock.api).execute(
    "wrong-stage",
    { proposal: h.input.contract },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("propose_scope_revision");
  const forged = { proposal: h.input.contract, scopeMetadata: true };
  const copied = await createProposeContractTool(h.mock.api).execute(
    "copied-private-flag",
    forged,
    undefined,
    undefined,
    h.ctx,
  );
  expect(copied.isError).toBe(true);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(prompts);
  await h.command("pause Exact scope only");
  const proposed = proposeScopeRevision(h.mock.api, h.ctx, h.input),
    ui = installCustomUI(h.ctx, (d) => {
      d.reviewAll();
    });
  expect((await reviewScopeRevision(h.mock.api, h.ctx, proposed.proposalId)).status).toBe(
    "committed",
  );
  ui.assertNoScriptErrors();
});
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
  const failed = await tool.execute(
    "scope-unknown",
    { ...h.input, reason: h.input.reason + " persistence failure" },
    undefined,
    undefined,
    h.ctx,
  );
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
    const context = await g.fire("before_agent_start", {
      prompt: "Explicit metadata-only request",
    });
    expect(JSON.stringify(context)).toContain("propose_scope_revision");
    expect(JSON.stringify(context)).toContain("reason");
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
it("repairs the original witnessed last-slot scope metadata without reserving a seventeenth response", async () => {
  const h = await fixture(),
    p = proposeScopeRevision(h.mock.api, h.ctx, h.input);
  for (let i = 0; i < 15; i++) {
    const ui = installCustomUI(h.ctx, (d) => {
      d.press("r");
    });
    expect((await reviewScopeRevision(h.mock.api, h.ctx, p.proposalId)).status).toBe("rejected");
    ui.assertNoScriptErrors();
  }
  const append = h.mock.appendEntry.getMockImplementation() as (
    type: string,
    data: unknown,
  ) => void;
  let failed = false;
  h.mock.appendEntry.mockImplementation((type, data) => {
    if (
      !failed &&
      type === "continuous-tasks:acceptance-facts" &&
      (data as { kind?: string }).kind === "acceptance-contract-bound"
    ) {
      failed = true;
      throw Error("Owned final-slot before-bound failure");
    }
    append(type, data);
  });
  const ui = installCustomUI(h.ctx, (d) => {
    d.reviewAll();
  });
  await expect(reviewScopeRevision(h.mock.api, h.ctx, p.proposalId)).rejects.toThrow();
  ui.assertNoScriptErrors();
  h.mock.appendEntry.mockImplementation(append);
  const count = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  expect((await repairScopeRevision(h.mock.api, h.ctx, p.proposalId)).status).toBe("committed");
  expect(vi.mocked(h.ctx.ui.custom)).toHaveBeenCalledTimes(count);
  expect(readControlJournal(h.ctx).acceptance?.scopeReviews).toHaveLength(16);
}, 60000);
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
