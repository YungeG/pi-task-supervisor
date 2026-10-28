import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { preflightLifecycle, localProposal } from "./helpers/preflight";
import { installCustomUI } from "./helpers/custom-ui";
import { createProposeContractTool } from "../acceptance-tool";
import { createSubmitPreflightTool, createWriteTasksTool, createCompileTasksTool } from "../tools";
import { currentRuntime } from "../runtime";
import { readControlJournal } from "../control-journal";
import { getBoard, resetState } from "../state";
import { restorePreflight } from "../preflight";
import { approvePreflight } from "../preflight-human";
import type { AcceptanceProposal } from "../acceptance-proposal";
import { flowFacts, nextFlowStep } from "../flow";
import { preflightSummary } from "../human-presentation";
import {
  approvalAction,
  approvalContractProposal,
  captureApprovalContract,
  ensureApprovalWorkflowFence,
} from "../approval-bundle";
import { inspectSessionJournal } from "../human-journal";
import { sessionJournalView } from "../human-control";
import {
  repairPreflightAcceptance,
  reviewAcceptanceContract,
  cachedAcceptanceReviewMaterial,
  adoptPreflightAcceptance,
  contractCompilationAdmission,
} from "../acceptance-runtime";

beforeEach(resetState);

it("does not recollect unchanged permissions and confirms only changed definitions before independent Start", async () => {
  const h = await plannedBundle();
  const submitted = await createSubmitPreflightTool(h.mock.api).execute(
    "bundle",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
  const approval = structuredClone(currentRuntime().preflight?.approval);
  const questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await h.command("approve");
  expect(vi.mocked(h.ctx.ui.custom).mock.calls).toHaveLength(questions);
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  writeFileSync(join(h.root, "checker.mjs"), `${h.checker}\n// concrete changed definition\n`);
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(currentRuntime().supervisor).toBeUndefined();
  const stale = flowFacts(h.ctx);
  expect(stale.approval).toMatchObject({
    kind: "definitions",
    actor: "user",
    command: "/task-supervisor approve",
  });
  expect(nextFlowStep(getBoard(), currentRuntime().supervisor, stale)).not.toContain(
    "/task-supervisor start",
  );
  expect(preflightSummary(currentRuntime().preflight!, undefined, stale.approval).next).toContain(
    "/task-supervisor approve",
  );
  await h.command("approve");
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  const state = currentRuntime().preflight;
  const definition = state?.version === 2 ? state.definitionApproval : undefined;
  expect(definition?.controlEntryId).not.toBe(approval?.controlEntryId);
  expect(() => {
    restorePreflight(h.ctx);
  }).not.toThrow();
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  expect(currentRuntime().preflight?.started).toBeUndefined();
  await h.command("start");
  const bound = readControlJournal(h.ctx).acceptance?.contracts.at(-1)?.data;
  expect(bound?.authority.kind, JSON.stringify(vi.mocked(h.ctx.ui.notify).mock.calls)).toBe(
    "preflight-reviewed",
  );
  if (bound?.authority.kind !== "preflight-reviewed") throw Error("Missing actual association");
  expect(bound.authority.permissionControlRef.entryId).toBe(approval?.controlEntryId);
  expect(bound.authority.definitionControlRef.entryId).toBe(definition?.controlEntryId);
});

it.each(
  ["acceptance-definition-declared", "acceptance-contract-bound"].flatMap((kind) =>
    [false, true].map((cold) => ({ kind, cold })),
  ),
)(
  "repairs exact association after $kind acknowledgement loss (cold=$cold) without replay",
  async ({ kind, cold }) => {
    const h = await plannedBundle();
    await createSubmitPreflightTool(h.mock.api).execute(
      "bundle",
      {
        preflightId: currentRuntime().preflight!.preflightId,
        proposal: { ...localProposal, contractProposalId: h.proposalId },
      },
      undefined,
      undefined,
      h.ctx,
    );
    const append = h.mock.appendEntry.getMockImplementation() as (
      type: string,
      data: unknown,
    ) => void;
    let failed = false;
    h.mock.appendEntry.mockImplementation((type, data) => {
      append(type, data);
      if (
        !failed &&
        type === "continuous-tasks:acceptance-facts" &&
        (data as { kind?: string }).kind === kind
      ) {
        failed = true;
        throw Error("Owned acknowledgement lost after actual derived metadata write");
      }
    });
    const approval = structuredClone(currentRuntime().preflight?.approval);
    const turns = () =>
      h.mock.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn).length;
    const messages = turns();
    await h.command("start");
    expect(failed).toBe(true);
    expect(currentRuntime().preflight?.started).toBeDefined();
    expect(currentRuntime().journalFault).toBeTruthy();
    expect(nextFlowStep(getBoard(), currentRuntime().supervisor, flowFacts(h.ctx))).toContain(
      "/task-supervisor repair-preflight",
    );
    expect(turns()).toBe(messages);
    const started = structuredClone(currentRuntime().preflight?.started);
    if (cold) await h.fire("session_tree");
    const held = structuredClone(currentRuntime().supervisor);
    const beforeRepair = h.entries.length,
      fault = currentRuntime().journalFault;
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValueOnce(true);
    expect(() => {
      repairPreflightAcceptance(h.mock.api, h.ctx);
    }).toThrow(/quiescence/);
    vi.mocked(h.ctx.isIdle).mockReturnValueOnce(false);
    expect(() => {
      repairPreflightAcceptance(h.mock.api, h.ctx);
    }).toThrow(/quiescence/);
    currentRuntime().journalFault = "Unrelated dispatch uncertainty";
    expect(() => {
      repairPreflightAcceptance(h.mock.api, h.ctx);
    }).toThrow(/Unrelated/);
    expect(h.entries).toHaveLength(beforeRepair);
    expect(currentRuntime().supervisor).toEqual(held);
    currentRuntime().journalFault = fault;
    await h.command("repair-preflight");
    expect(
      currentRuntime().journalFault,
      JSON.stringify(vi.mocked(h.ctx.ui.notify).mock.calls),
    ).toBeUndefined();
    expect(currentRuntime().preflight?.approval).toEqual(approval);
    expect(currentRuntime().preflight?.started).toEqual(started);
    expect(readControlJournal(h.ctx).acceptance?.contracts).toHaveLength(1);
    expect(readControlJournal(h.ctx).acceptance?.definitions).toHaveLength(1);
    expect(currentRuntime().supervisor).toEqual(held);
    const entries = h.entries.length;
    await h.command("repair-preflight");
    expect(h.entries).toHaveLength(entries);
    expect(turns()).toBe(messages);
    expect(
      h.entries.filter((row) => row.customType === "continuous-tasks:preflight-control"),
    ).toHaveLength(2);
  },
);

it("blocks cold recovery and ordinary business admission until the concrete preflight association is exactly repaired", async () => {
  const h = await approvedNodeBundle(),
    append = h.mock.appendEntry.getMockImplementation() as
      | ((type: string, data: unknown) => void)
      | undefined;
  if (!append) throw Error("No actual publisher");
  let lost = false;
  h.mock.appendEntry.mockImplementation((type, data) => {
    append(type, data);
    if (
      !lost &&
      type === "continuous-tasks:acceptance-facts" &&
      (data as { kind?: string }).kind === "acceptance-definition-declared"
    ) {
      lost = true;
      throw Error("Definition association acknowledgement lost");
    }
  });
  const turns = () =>
    h.mock.sendMessage.mock.calls.filter(([, options]) => options?.triggerTurn).length;
  await h.command("start");
  expect(lost).toBe(true);
  await h.fire("session_tree");
  const held = structuredClone(currentRuntime().supervisor),
    before = turns();
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
  await h.command("recover");
  expect(turns()).toBe(before);
  expect(currentRuntime().supervisor).toEqual(held);
  expect(nextFlowStep(getBoard(), currentRuntime().supervisor, flowFacts(h.ctx))).toContain(
    "/task-supervisor repair-preflight",
  );
  const facts = flowFacts(h.ctx);
  expect(
    nextFlowStep(getBoard(), currentRuntime().supervisor, {
      ...facts,
      goal: {
        sessionId: facts.sessionId,
        goalRunId: "display-only",
        phase: "fault",
        preflightId: currentRuntime().preflight!.preflightId,
        hasSupervisor: true,
        closedUnstarted: false,
        hasProposal: true,
        preflightPhase: "started",
      },
    }),
  ).toContain("/task-supervisor repair-preflight");
  const blocked = h.fire("tool_call", {
    toolCallId: "cold-must-not-write",
    toolName: "write",
    input: { path: join(h.root, "unexpected.txt"), content: "no" },
  });
  expect(blocked).toMatchObject({ block: true });
  expect(contractCompilationAdmission(h.ctx, "write", {}, false)).toContain("association repair");
  expect(contractCompilationAdmission(h.ctx, "read", {}, true)).toBeUndefined();
  h.fire("tool_result", {
    toolCallId: "cold-must-not-write",
    toolName: "write",
    input: {},
    content: [],
    isError: true,
  });
  expect(existsSync(join(h.root, "unexpected.txt"))).toBe(false);
  const entriesBefore = h.entries.length;
  writeFileSync(join(h.root, "checker.mjs"), `${h.checker}\n// changed after cold restore`);
  await h.command("repair-preflight");
  expect(h.entries).toHaveLength(entriesBefore);
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
  expect(currentRuntime().supervisor).toEqual(held);
  expect(turns()).toBe(before);
  writeFileSync(join(h.root, "checker.mjs"), h.checker);
  await h.command("repair-preflight");
  expect(currentRuntime().supervisor).toEqual(held);
  expect(turns()).toBe(before);
  expect(readControlJournal(h.ctx).acceptance?.contracts).toHaveLength(1);
  await h.command("recover");
  expect(turns()).toBe(before + 1);
});

it("waits for complete contract material without asking for approval or allowing Start", async () => {
  const h = await plannedBundle();
  const questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  const messages = vi.mocked(h.mock.api.sendMessage).mock.calls.length;
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "incomplete",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: localProposal,
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect((result.details as { status?: string }).status).toBe("awaiting_contract");
  const facts = flowFacts(h.ctx);
  expect(facts.approval).toMatchObject({ kind: "materials", actor: "Main" });
  expect(facts.approval?.command).toBeUndefined();
  expect(nextFlowStep(getBoard(), currentRuntime().supervisor, facts)).toContain(
    "propose_contract",
  );
  expect(preflightSummary(currentRuntime().preflight!).next).not.toContain(
    "/task-supervisor approve",
  );
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(vi.mocked(h.ctx.ui.custom).mock.calls).toHaveLength(questions);
  expect(vi.mocked(h.mock.api.sendMessage).mock.calls).toHaveLength(messages);
  const pending = structuredClone(currentRuntime().preflight);
  expect(() => {
    restorePreflight(h.ctx);
  }).not.toThrow();
  expect(currentRuntime().preflight).toEqual(pending);
  await h.fire("session_tree");
  expect(currentRuntime().preflight).toEqual(pending);
  const complete = await createSubmitPreflightTool(h.mock.api).execute(
    "complete-material",
    {
      preflightId: pending!.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(complete.isError, JSON.stringify(complete.content)).not.toBe(true);
  expect(currentRuntime().preflight?.phase).toBe("approved");
  expect(() => {
    restorePreflight(h.ctx);
  }).not.toThrow();
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeDefined();
});

it("retains a genuine revocation of material-only planning without manufacturing a permission request", async () => {
  const h = await plannedBundle(),
    state = currentRuntime().preflight;
  if (!state) throw Error("No actual planning source");
  await createSubmitPreflightTool(h.mock.api).execute(
    "material-only",
    { preflightId: state.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  await h.command(`revoke ${currentRuntime().preflight?.planId}`);
  expect(currentRuntime().preflight?.phase).toBe("revoked");
  expect(() => {
    restorePreflight(h.ctx);
  }).not.toThrow();
  expect(currentRuntime().preflight).toMatchObject({ phase: "revoked" });
  expect(currentRuntime().preflight?.approval).toBeUndefined();
});
it.each(["legacy", "linked", "approved"])(
  "does not accept a missing request on a %s proposal as material-only",
  async (kind) => {
    const h = await plannedBundle(),
      state = currentRuntime().preflight;
    if (!state) throw Error("No actual planning source");
    await createSubmitPreflightTool(h.mock.api).execute(
      "material-only",
      { preflightId: state.preflightId, proposal: localProposal },
      undefined,
      undefined,
      h.ctx,
    );
    const pending = structuredClone(currentRuntime().preflight);
    if (!pending || pending.version !== 2 || !pending.proposal)
      throw Error("No real material-only row");
    if (kind === "legacy") delete pending.approvalFlow;
    if (kind === "linked")
      pending.proposal = { ...pending.proposal, contractProposalId: h.proposalId };
    if (kind === "approved") pending.phase = "approved";
    h.mock.api.appendEntry("continuous-tasks:preflight", pending);
    expect(() => {
      restorePreflight(h.ctx);
    }).toThrow("Native proposal needs permission request");
  },
);

it("renders independently declared preflight acceptance terms in the actual complete bundled document", async () => {
  const h = await plannedBundle(),
    state = currentRuntime().preflight;
  if (!state) throw Error("No actual preflight");
  const sentinel = "PREFLIGHT-ONLY-ACCEPTANCE-73";
  expect(JSON.stringify(h.proposal)).not.toContain(sentinel);
  const outcome = await createSubmitPreflightTool(h.mock.api).execute(
    "full-document",
    {
      preflightId: state.preflightId,
      proposal: {
        ...localProposal,
        contractProposalId: h.proposalId,
        acceptance: [sentinel, ...localProposal.acceptance],
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(outcome.isError, JSON.stringify(outcome.content)).not.toBe(true);
  expect(currentRuntime().preflight?.phase).toBe("approved");
  expect(h.approvalUI.rendered.join("\n")).toContain(sentinel);
});

it("keeps a rejected consolidated proposal with Main instead of suggesting another unchanged approval", async () => {
  const h = await plannedBundle();
  const ui = installCustomUI(h.ctx, (driver) => driver.press("r"));
  interfaces.push(ui);
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "rejected",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect((result.details as { status: string }).status).toBe("rejected");
  expect(() => {
    restorePreflight(h.ctx);
  }).not.toThrow();
  const facts = flowFacts(h.ctx);
  expect(facts.approval).toMatchObject({ kind: "rejected", actor: "Main" });
  expect(facts.approval?.command).toBeUndefined();
  expect(nextFlowStep(getBoard(), currentRuntime().supervisor, facts)).not.toContain(
    "/task-supervisor approve",
  );
  expect(currentRuntime().preflight?.started).toBeUndefined();
});

it("rejects definition bytes changed during native review before publishing any permission response", async () => {
  const h = await plannedBundle();
  const ui = installCustomUI(h.ctx, (driver) => {
    driver.reviewAll();
    writeFileSync(join(h.root, "checker.mjs"), `${h.checker}\n// changed while reading\n`);
  });
  interfaces.push(ui);
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "changing-review",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).toBe(true);
  expect(
    h.entries.filter((row) => row.customType === "continuous-tasks:preflight-control"),
  ).toHaveLength(0);
  expect(currentRuntime().preflight?.approval).toBeUndefined();
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(() => {
    restorePreflight(h.ctx);
  }).not.toThrow();
  const old = currentRuntime().preflight;
  await h.command("approve");
  expect(currentRuntime().preflight?.phase).toBe("approved");
  const fresh = currentRuntime().preflight;
  expect(fresh?.version === 2 && fresh.permissionRequest?.id).not.toBe(
    old?.version === 2 && old.permissionRequest?.id,
  );
  expect(
    h.entries.filter((row) => row.customType === "continuous-tasks:preflight-control"),
  ).toHaveLength(1);
  expect(currentRuntime().supervisor).toBeUndefined();
});

it.each(["defer", "decline"] as const)(
  "preserves original permissions but does not start after definition %s",
  async (response) => {
    const h = await plannedBundle();
    await createSubmitPreflightTool(h.mock.api).execute(
      "initial",
      {
        preflightId: currentRuntime().preflight!.preflightId,
        proposal: { ...localProposal, contractProposalId: h.proposalId },
      },
      undefined,
      undefined,
      h.ctx,
    );
    const approval = structuredClone(currentRuntime().preflight?.approval);
    writeFileSync(join(h.root, "checker.mjs"), `${h.checker}\n// new definition\n`);
    const ui = installCustomUI(h.ctx, (driver) => {
      driver.press("\u001b[B");
      driver.press(" ");
      driver.press("a");
      driver.press(response === "defer" ? "\u001b" : "r");
    });
    interfaces.push(ui);
    await h.command("approve");
    expect(currentRuntime().preflight?.approval).toEqual(approval);
    const state = currentRuntime().preflight;
    expect(state?.version === 2 && state.definitionApproval).toBeUndefined();
    expect(() => {
      restorePreflight(h.ctx);
    }).not.toThrow();
    expect(currentRuntime().preflight?.approval).toEqual(approval);
    await h.command("start");
    expect(currentRuntime().preflight?.started).toBeUndefined();
    expect(currentRuntime().supervisor).toBeUndefined();
  },
);

it("cannot replace already reviewed important conditions while preparing the first concrete definition", async () => {
  const h = await plannedBundle({ pending: true });
  await createSubmitPreflightTool(h.mock.api).execute(
    "preparation",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: {
        ...localProposal,
        contractProposalId: h.proposalId,
        preparation: {
          checkIds: ["output"],
          steps: ["Create the declared checker"],
          permissionIds: ["A1"],
        },
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  await h.command("start");
  const approval = structuredClone(currentRuntime().preflight?.approval);
  const started = structuredClone(currentRuntime().preflight?.started);
  writeFileSync(join(h.root, "checker.mjs"), h.checker);
  const replacement = await createProposeContractTool(h.mock.api).execute(
    "different-conditions",
    {
      proposal: {
        ...h.proposal,
        requirements: h.proposal.requirements.map((r) => ({
          ...r,
          text: "Different important business meaning",
        })),
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(replacement.isError, JSON.stringify(replacement.content)).not.toBe(true);
  const questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await h.command(`review-contract ${(replacement.details as { proposalId: string }).proposalId}`);
  expect(vi.mocked(h.ctx.ui.custom).mock.calls).toHaveLength(questions);
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  expect(currentRuntime().preflight?.started).toEqual(started);
  expect(currentRuntime().journalFault).toBeUndefined();
  expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain("new Goal/preflight");
});

async function approvedNodeBundle() {
  const h = await plannedBundle();
  const state = currentRuntime().preflight;
  if (!state) throw Error("No actual preflight");
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "review-base",
    {
      preflightId: state.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return h;
}
async function startedNodeBundle() {
  const h = await approvedNodeBundle();
  await h.command("start");
  expect(readControlJournal(h.ctx).acceptance?.contracts).toHaveLength(1);
  return h;
}
it.each(["defer", "busy", "pending", "fault", "bytes"])(
  "preserves original authority when a definition review is %s",
  async (kind) => {
    const h = await startedNodeBundle(),
      before = readControlJournal(h.ctx).acceptance;
    const approved = structuredClone(currentRuntime().preflight),
      supervisor = structuredClone(currentRuntime().supervisor);
    const ui = installCustomUI(h.ctx, (driver) => {
      if (kind === "defer") {
        driver.press("\u001b");
        return;
      }
      if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
      if (kind === "pending") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
      if (kind === "fault") currentRuntime().journalFault = "Unrelated material uncertainty";
      if (kind === "bytes")
        writeFileSync(join(h.root, "checker.mjs"), `${h.checker}\n// changed while reviewing`);
      driver.reviewAll();
    });
    interfaces.push(ui);
    const result = await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId);
    expect(result.status).toBe("deferred");
    expect(currentRuntime().preflight).toEqual(approved);
    expect(currentRuntime().supervisor).toEqual(supervisor);
    expect(readControlJournal(h.ctx).acceptance?.contracts).toEqual(before?.contracts);
    expect(readControlJournal(h.ctx).acceptance?.contractReviews).toHaveLength(0);
  },
);
it.each(["unsupported", "unknown-proposal", "busy", "pending"])(
  "does not open native definition controls for %s",
  async (kind) => {
    const h = await startedNodeBundle(),
      questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    if (kind === "unsupported") Object.assign(h.ctx, { mode: "rpc" });
    if (kind === "busy") vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    if (kind === "pending") vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    const call = reviewAcceptanceContract(
      h.mock.api,
      h.ctx,
      kind === "unknown-proposal" ? "absent" : h.proposalId,
    );
    if (kind === "unsupported") expect(await call).toEqual({ status: "unsupported" });
    else
      await expect(call).rejects.toThrow(
        kind === "unknown-proposal" ? /Unknown current-session/ : /actual idle/,
      );
    expect(h.ctx.ui.custom).toHaveBeenCalledTimes(questions);
  },
);
it("records a native definition decline without replacing the original bound contract or business grant", async () => {
  const h = await startedNodeBundle(),
    before = readControlJournal(h.ctx).acceptance?.contracts;
  const approved = structuredClone(currentRuntime().preflight);
  vi.mocked(h.ctx.ui.select).mockImplementation(
    async (_title, options) =>
      options.find((option) => /^选项 2(?:$| ·)/u.test(option)) ?? "稍后决定",
  );
  const ui = installCustomUI(h.ctx, (driver) => {
    driver.press("\u001b[B");
    driver.press("\u001b[B");
    driver.reviewAll();
  });
  interfaces.push(ui);
  expect(await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId)).toEqual({
    status: "declined",
  });
  expect(currentRuntime().preflight).toEqual(approved);
  expect(readControlJournal(h.ctx).acceptance?.contracts).toEqual(before);
  expect(readControlJournal(h.ctx).acceptance?.contractReviews).toHaveLength(1);
});

it("does not treat absent, interrupted, legacy or incomplete cached definition labels as authority or Start", async () => {
  const h = await approvedNodeBundle(),
    state = currentRuntime().preflight;
  if (!state || state.version !== 2) throw Error("No original consolidated state");
  expect(approvalAction(undefined)).toBeUndefined();
  expect(approvalAction({ ...state, phase: "interrupted" })).toBeUndefined();
  expect(approvalAction({ ...state, version: 1 })).toBeUndefined();
  expect(
    approvalAction({ ...state, approvalFlow: undefined, proposal: undefined }),
  ).toBeUndefined();
  expect(approvalAction({ ...state, definitionApproval: undefined })).toMatchObject({
    kind: "definitions",
  });
  expect(approvalAction({ ...state, permissionRequest: undefined })).toMatchObject({
    kind: "definitions",
  });
  expect(
    approvalAction({
      ...state,
      approval: state.approval ? { ...state.approval, permissionIds: [] } : undefined,
    }),
  ).toMatchObject({ kind: "permissions" });
  expect(currentRuntime().preflight).toEqual(state);
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
});
it("rejects missing, foreign and cross-workspace proposal references before unapproved capture", async () => {
  const h = await approvedNodeBundle(),
    state = currentRuntime().preflight;
  if (!state) throw Error("No original state");
  const journal = inspectSessionJournal(sessionJournalView(h.ctx));
  expect(() => approvalContractProposal(journal, { ...state, proposal: undefined })).toThrow(
    /Complete the acceptance proposal/,
  );
  expect(() => approvalContractProposal(journal, { ...state, sessionId: "foreign" })).toThrow(
    /does not belong/,
  );
  expect(() => approvalContractProposal(journal, { ...state, preflightId: "foreign" })).toThrow(
    /does not belong/,
  );
  expect(() => approvalContractProposal(journal, { ...state, goal: "foreign" })).toThrow(
    /does not belong/,
  );
  expect(() =>
    captureApprovalContract({ ...h.ctx, cwd: join(h.root, "unapproved") }, state),
  ).toThrow(/actual physical workspace/);
});
it.each([false, true])(
  "fails closed if the actual approval capability envelope cannot be published (priorFault=%s)",
  async (priorFault) => {
    const h = preflightLifecycle();
    await h.command("preflight Owned legacy source only");
    if (priorFault) currentRuntime().journalFault = "Earlier unrelated source uncertainty";
    h.mock.appendEntry.mockImplementation(() => {
      throw Error("Capability envelope write failed");
    });
    expect(() => {
      ensureApprovalWorkflowFence(h.mock.api, h.ctx);
    }).toThrow();
    expect(currentRuntime().journalFault).toBe(
      priorFault
        ? "Earlier unrelated source uncertainty"
        : "Control journal persistence failed; inspect before further mutation or retry",
    );
    expect(currentRuntime().preflight?.approval).toBeUndefined();
    expect(currentRuntime().preflight?.started).toBeUndefined();
  },
);

it("projects actual consolidated revocation without suggesting another Start or renewing the old grant", async () => {
  const h = await startedNodeBundle(),
    state = currentRuntime().preflight;
  if (!state?.planId) throw Error("No actual started source");
  const started = structuredClone(state.started);
  await h.command(`revoke ${state.planId}`);
  expect(currentRuntime().preflight?.phase).toBe("revoked");
  expect(flowFacts(h.ctx).approval).toMatchObject({ kind: "revoked", actor: "user" });
  expect(flowFacts(h.ctx).approval?.command).toBeUndefined();
  expect(currentRuntime().supervisor).toMatchObject({
    status: "paused",
    holdCause: "authorization_revoked",
  });
  await h.command("start");
  expect(currentRuntime().preflight?.started).toEqual(started);
  expect(
    h.entries.filter(
      (row) =>
        row.customType === "continuous-tasks:preflight-control" &&
        (row.data as { kind?: string }).kind === "start",
    ),
  ).toHaveLength(1);
});

it("rejects an over-capacity actual checker capture before publishing any native review or dropping files", async () => {
  const h = await plannedBundle(),
    proposal = structuredClone(h.proposal),
    base = proposal.checks[0];
  if (!base || base.kind !== "automatic") throw Error("No original checker declaration");
  const files = ["checker.mjs", ...Array.from({ length: 23 }, (_, i) => `support-${i}.mjs`)];
  for (const file of files.slice(1)) writeFileSync(join(h.root, file), "0;\n");
  proposal.inputs = ["input.txt", ...files];
  proposal.checks = Array.from({ length: 4 }, (_, i) => ({
    ...base,
    checkId: `bounded-${i}`,
    checkerFiles: files,
  }));
  const proposed = await createProposeContractTool(h.mock.api).execute(
    "bounded-declaration",
    { proposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(proposed.isError, JSON.stringify(proposed.content)).not.toBe(true);
  const state = currentRuntime().preflight,
    questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  if (!state) throw Error("No original preflight");
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "bounded-capture",
    {
      preflightId: state.preflightId,
      proposal: {
        ...localProposal,
        contractProposalId: (proposed.details as { proposalId: string }).proposalId,
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("Captured approval definitions exceed");
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(questions);
  expect(currentRuntime().preflight).toEqual(state);
  expect(currentRuntime().journalFault).toBeUndefined();
});

it("does not let a non-native context confirm or renew pre-start definitions", async () => {
  const h = await approvedNodeBundle(),
    before = structuredClone(currentRuntime().preflight),
    count = h.entries.length;
  Object.assign(h.ctx, { mode: "rpc" });
  expect((await approvePreflight(h.mock.api, h.ctx)).status).toBe("unsupported");
  expect(currentRuntime().preflight).toEqual(before);
  expect(h.entries).toHaveLength(count);
});
it("preserves the same open Start request after native deferral without repeating business permission", async () => {
  const h = await approvedNodeBundle(),
    approval = structuredClone(currentRuntime().preflight?.approval);
  const cancel = installCustomUI(h.ctx, (driver) => {
    driver.press("\u001b");
  });
  interfaces.push(cancel);
  await h.command("start");
  const first = currentRuntime().preflight;
  if (!first || first.version !== 2) throw Error("No actual native Start request");
  expect(first.startRequest).toBeDefined();
  expect(first.started).toBeUndefined();
  await h.command("approve");
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  Object.assign(h.ctx.ui, { custom: h.approvalUI.custom });
  await h.command("start");
  const final = currentRuntime().preflight;
  expect(final?.version === 2 && final.startRequest?.id).toBe(first.startRequest?.id);
  expect(final?.started).toBeDefined();
  expect(
    h.entries.filter(
      (row) =>
        row.customType === "continuous-tasks:preflight-control" &&
        (row.data as { kind?: string }).kind === "approve",
    ),
  ).toHaveLength(1);
  expect(
    h.entries.filter(
      (row) =>
        row.customType === "continuous-tasks:preflight-control" &&
        (row.data as { kind?: string }).kind === "start",
    ),
  ).toHaveLength(1);
});

it("never materializes a cached-only planning preflight without the actual committed Goal seed", async () => {
  const h = preflightLifecycle({ consolidated: true });
  await h.command("preflight Owned missing physical source");
  const root = dirname(h.path);
  h.ctx.cwd = root;
  h.entries.splice(0, h.entries.length);
  vi.mocked(h.ctx.sessionManager.getLeafId).mockReturnValue(null);
  writeFileSync(
    h.path,
    JSON.stringify({
      type: "session",
      version: 3,
      id: h.ctx.sessionManager.getSessionId(),
      cwd: root,
    }) + "\n",
  );
  const result = await createProposeContractTool(h.mock.api).execute(
    "missing-source",
    {
      proposal: {
        version: 1,
        scopeId: "untrusted",
        inputs: ["input.txt"],
        artifacts: [],
        environment: { profileId: "empty", values: {} },
        requirements: [
          {
            requirementId: "r",
            source: "Fixture original goal",
            text: "Validate declared input",
            required: true,
          },
        ],
        checks: [
          {
            kind: "manual",
            checkId: "r",
            requirementIds: ["r"],
            question: "Does the declared input meet the original condition?",
            response: { kind: "choice", options: ["yes", "no"] },
            expectedValue: "yes",
          },
        ],
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).toBe(true);
  expect(JSON.stringify(result.content)).toContain("no actual preflight source");
  expect(h.entries).toHaveLength(0);
});

it.each([false, true])(
  "publishes the required envelope before adding bundled fields to retained preflight (writeFailure=%s)",
  async (writeFailure) => {
    const h = await plannedBundle({ retained: true }),
      base = structuredClone(currentRuntime().preflight);
    expect(readControlJournal(h.ctx).latestFence?.data.features ?? []).not.toContain(
      "approval-workflow-v1",
    );
    const questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    const append = h.mock.appendEntry.getMockImplementation() as
      | ((type: string, data: unknown) => void)
      | undefined;
    if (!append || !base) throw Error("No actual retained source publisher");
    if (writeFailure)
      h.mock.appendEntry.mockImplementation((type, data) => {
        if (
          (data as { kind?: string; features?: string[] }).kind === "format-fence" &&
          (data as { features: string[] }).features.includes("approval-workflow-v1")
        )
          throw Error("Envelope write failure");
        append(type, data);
      });
    const result = await createSubmitPreflightTool(h.mock.api).execute(
      "retained-bundle",
      {
        preflightId: base.preflightId,
        proposal: { ...localProposal, contractProposalId: h.proposalId },
      },
      undefined,
      undefined,
      h.ctx,
    );
    const bundle = h.entries.findIndex(
      (row) =>
        row.customType === "continuous-tasks:preflight" &&
        !!(row.data as { permissionRequest?: { acceptance?: unknown } }).permissionRequest
          ?.acceptance,
    );
    if (writeFailure) {
      expect(result.isError).toBe(true);
      expect(bundle).toBe(-1);
      expect(currentRuntime().preflight).toEqual(base);
      expect(h.ctx.ui.custom).toHaveBeenCalledTimes(questions);
      expect(currentRuntime().journalFault).toBeTruthy();
    } else {
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const fence = h.entries.findIndex(
        (row) =>
          (row.data as { kind?: string; features?: string[] }).kind === "format-fence" &&
          (row.data as { features: string[] }).features.includes("approval-workflow-v1"),
      );
      expect(bundle).toBeGreaterThan(-1);
      expect(fence).toBeGreaterThan(-1);
      expect(fence).toBeLessThan(bundle);
    }
  },
);

it("does not invent an association or repair intent without any actual preflight", () => {
  const h = preflightLifecycle(),
    count = h.entries.length;
  expect(adoptPreflightAcceptance(h.mock.api, h.ctx)).toBeUndefined();
  expect(() => {
    repairPreflightAcceptance(h.mock.api, h.ctx);
  }).toThrow(/No pending/);
  expect(h.entries).toHaveLength(count);
});
it("does not associate or repair a pending checker as if concrete definitions existed", async () => {
  const h = await plannedBundle({ pending: true }),
    state = currentRuntime().preflight;
  if (!state) throw Error("No actual preflight");
  const outcome = await createSubmitPreflightTool(h.mock.api).execute(
    "pending-association",
    {
      preflightId: state.preflightId,
      proposal: {
        ...localProposal,
        contractProposalId: h.proposalId,
        preparation: {
          checkIds: ["output"],
          permissionIds: ["A1"],
          steps: ["Create only the declared checker"],
        },
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(outcome.isError, JSON.stringify(outcome.content)).not.toBe(true);
  await h.command("start");
  const count = h.entries.length;
  expect(adoptPreflightAcceptance(h.mock.api, h.ctx)).toBeUndefined();
  expect(() => {
    repairPreflightAcceptance(h.mock.api, h.ctx);
  }).toThrow(/No pending/);
  expect(h.entries).toHaveLength(count);
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
  expect(currentRuntime().supervisor?.status).toBe("active");
});

it("reuses only an existing exact derived association and never creates a second binding", async () => {
  const h = await startedNodeBundle(),
    before = readControlJournal(h.ctx).acceptance?.contracts.at(-1);
  const count = h.entries.length;
  expect(adoptPreflightAcceptance(h.mock.api, h.ctx)).toEqual(
    before ? { entryId: before.entryId, digest: before.digest } : undefined,
  );
  expect(h.entries).toHaveLength(count);
});
it("does not associate or repair definitions that have not actually reached Start", async () => {
  const h = await approvedNodeBundle(),
    count = h.entries.length;
  expect(() => adoptPreflightAcceptance(h.mock.api, h.ctx)).toThrow(/incomplete/);
  expect(() => {
    repairPreflightAcceptance(h.mock.api, h.ctx);
  }).toThrow(/No pending/);
  expect(h.entries).toHaveLength(count);
});
it.each(["before", "after", "workspace"])(
  "does not refresh a confirmed association during exact repair after %s failure",
  async (when) => {
    const h = await approvedNodeBundle(),
      append = h.mock.appendEntry.getMockImplementation() as
        | ((type: string, data: unknown) => void)
        | undefined;
    if (!append) throw Error("No actual file publisher");
    let failed = false;
    h.mock.appendEntry.mockImplementation((type, data) => {
      const fail =
        !failed &&
        type === "continuous-tasks:acceptance-facts" &&
        (data as { kind?: string }).kind === "acceptance-definition-declared";
      if (fail) {
        failed = true;
        if (when === "after") append(type, data);
        throw Error("Owned definition acknowledgement failure");
      }
      append(type, data);
    });
    await h.command("start");
    expect(failed).toBe(true);
    let container: string | undefined;
    if (when === "workspace") {
      container = mkdtempSync("/tmp/repair-root-identity-");
      const backup = join(container, "original");
      renameSync(h.root, backup);
      mkdirSync(h.root);
      for (const name of readdirSync(backup)) renameSync(join(backup, name), join(h.root, name));
    } else
      writeFileSync(join(h.root, "checker.mjs"), `${h.checker}\n// not the confirmed definition`);
    const count = h.entries.length,
      fault = currentRuntime().journalFault,
      held = structuredClone(currentRuntime().supervisor);
    expect(() => {
      repairPreflightAcceptance(h.mock.api, h.ctx);
    }).toThrow();
    expect(currentRuntime().journalFault).toBe(fault);
    expect(currentRuntime().supervisor).toEqual(held);
    expect(h.entries).toHaveLength(count);
    if (container) rmSync(container, { recursive: true, force: true });
  },
);

it("does not publish new protocol payloads when the actual SessionManager source read fails", async () => {
  const h = preflightLifecycle();
  await h.command("preflight Owned read failure");
  vi.mocked(h.ctx.sessionManager.getBranch).mockImplementation(() => {
    throw Error("Actual source adapter unavailable");
  });
  expect(() => {
    ensureApprovalWorkflowFence(h.mock.api, h.ctx);
  }).toThrow(/source adapter unavailable/);
  expect(currentRuntime().journalFault).toBe(
    "Approval workflow fence could not be source-verified; inspect without replay",
  );
  expect(currentRuntime().preflight?.approval).toBeUndefined();
});

const interfaces: ReturnType<typeof installCustomUI>[] = [];
afterEach(() => {
  for (const ui of interfaces.splice(0)) ui.assertNoScriptErrors();
});

async function plannedBundle(
  options: { pending?: boolean; python?: boolean; manual?: boolean; retained?: boolean } = {},
) {
  const h = preflightLifecycle({ consolidated: !options.retained });
  const root = dirname(h.path);
  const header = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0] ?? "{}");
  writeFileSync(h.path, JSON.stringify({ ...header, cwd: root }) + "\n");
  h.ctx.cwd = root;
  writeFileSync(join(root, "input.txt"), "frozen source");
  const checker =
    "import{readFileSync}from'node:fs';import assert from'node:assert/strict';assert.equal(readFileSync(new URL('./result.txt',import.meta.url),'utf8'),'made');console.log(JSON.stringify({protocol:'check-result-v1',tests:1,passed:1,failed:0,skipped:0,requiredCases:{output:'passed'},skippedIds:[]}));\n";
  const filename = options.python ? "test_output.py" : "checker.mjs";
  if (!options.pending)
    writeFileSync(
      join(root, filename),
      options.python
        ? "import unittest,pathlib\nclass Output(unittest.TestCase):\n def test_output(self):\n  self.assertEqual(pathlib.Path('result.txt').read_text(),'made')\n"
        : checker,
    );
  await h.command("preflight Confirm once before work");
  const proposal: AcceptanceProposal = {
    version: 1 as const,
    scopeId: "owned-output",
    inputs: options.python || options.manual ? ["input.txt"] : ["input.txt", "checker.mjs"],
    artifacts: ["result.txt"],
    environment: { profileId: "owned", values: {} },
    requirements: [
      {
        requirementId: "output",
        source: "The current original Goal",
        text: "Produce the declared output and actually execute its checker",
        required: true,
      },
    ],
    checks: options.manual
      ? [
          {
            kind: "manual",
            checkId: "output",
            requirementIds: ["output"],
            question: "Does the actual declared output meet the original condition?",
            response: { kind: "choice", options: ["yes", "no"] },
            expectedValue: "yes",
          },
        ]
      : [
          {
            kind: "automatic" as const,
            checkId: "output",
            requirementIds: ["output"],
            script: filename,
            checkerFiles: [filename],
            configs: [],
            args: [],
            timeoutMs: 1000,
            expected: {
              minTests: 1,
              requiredCases: [options.python ? "test_output.Output.test_output" : "output"],
              allowedSkipped: [],
            },
            ...(options.python
              ? {
                  runtime: "python-unittest-v1" as const,
                  checkerRoot: root,
                  permissionId: "A3",
                  tests: ["test_output.Output.test_output"],
                }
              : {}),
          },
        ],
  };
  const proposed = await createProposeContractTool(h.mock.api).execute(
    "contract-proposal",
    { proposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(proposed.isError, JSON.stringify(proposed.content)).not.toBe(true);
  const proposalId = (proposed.details as { proposalId: string }).proposalId;
  const ui = installCustomUI(h.ctx, (driver) => {
    if (!driver.render().includes("集中审核")) {
      driver.reviewAll();
      return;
    }
    driver.press("a");
    for (let page = 0; page < 1000; page++) {
      if (driver.render().includes("完整材料已核对")) break;
      driver.press("\u001b[6~");
    }
    driver.press("\r");
  });
  interfaces.push(ui);
  return { ...h, root, proposal, proposalId, checker, approvalUI: ui };
}

it.each([
  "no-permission",
  "foreign-target",
  "optional-permission",
  "missing-input",
  "missing-checker",
  "unknown-prepare-check",
  "unknown-prepare-permission",
])(
  "does not request a bundled decision on incomplete or unauthorized material (%s)",
  async (kind) => {
    const h = await plannedBundle({ python: true });
    const first = localProposal.permissions[0];
    if (!first) throw Error("No baseline permission");
    let permissions = [
      ...localProposal.permissions,
      {
        ...first,
        id: "A3",
        target: h.root,
        action: "Run fixed python-unittest-v1 with declared reads and private scratch only",
      },
    ];
    if (kind === "no-permission") permissions = [...localProposal.permissions];
    if (kind === "foreign-target")
      permissions = permissions.map((p) => (p.id === "A3" ? { ...p, target: "/tmp" } : p));
    if (kind === "optional-permission")
      permissions = permissions.map((p) => (p.id === "A3" ? { ...p, required: false } : p));
    if (kind === "missing-input") unlinkSync(join(h.root, "input.txt"));
    if (kind === "missing-checker") unlinkSync(join(h.root, "test_output.py"));
    const preparation = kind.startsWith("unknown-prepare")
      ? {
          checkIds: [kind === "unknown-prepare-check" ? "not-declared" : "output"],
          permissionIds: [kind === "unknown-prepare-permission" ? "A999" : "A3"],
          steps: ["Only declared preparation"],
        }
      : undefined;
    const before = structuredClone(currentRuntime().preflight),
      questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    const result = await createSubmitPreflightTool(h.mock.api).execute(
      "invalid-material",
      {
        preflightId: before!.preflightId,
        proposal: {
          ...localProposal,
          contractProposalId: h.proposalId,
          permissions,
          ...(preparation ? { preparation } : {}),
        },
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(true);
    expect(currentRuntime().preflight).toEqual(before);
    expect(currentRuntime().journalFault).toBeUndefined();
    expect(h.ctx.ui.custom).toHaveBeenCalledTimes(questions);
    expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
    expect(currentRuntime().supervisor).toBeUndefined();
  },
);

it.each(["profile", "permission-id", "checker-root", "missing-permission"])(
  "cannot add a formal %s capability using definition-only review",
  async (kind) => {
    const h = await plannedBundle({ python: true }),
      first = localProposal.permissions[0];
    if (!first) throw Error("No original permission template");
    const submitted = await createSubmitPreflightTool(h.mock.api).execute(
      "bounded-python",
      {
        preflightId: currentRuntime().preflight!.preflightId,
        proposal: {
          ...localProposal,
          contractProposalId: h.proposalId,
          permissions: [
            ...localProposal.permissions,
            ...["A3", "A4"].map((id) => ({
              ...first,
              id,
              target: h.root,
              action: "Use only originally offered root/profile/check association",
            })),
          ],
        },
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
    await h.command("start");
    const journal = readControlJournal(h.ctx);
    expect(journal.acceptance?.contracts).toHaveLength(1);
    const approval = structuredClone(currentRuntime().preflight?.approval),
      started = structuredClone(currentRuntime().preflight?.started);
    const replacement = structuredClone(h.proposal),
      check = replacement.checks[0];
    if (!check || check.kind !== "automatic") throw Error("No original automatic check");
    if (kind === "profile") {
      delete check.runtime;
      delete check.tests;
    }
    if (kind === "permission-id") check.permissionId = "A4";
    if (kind === "missing-permission") check.permissionId = "A999";
    if (kind === "checker-root") check.checkerRoot = join(h.root, "unapproved-external-root");
    const proposed = await createProposeContractTool(h.mock.api).execute(
      "new-definition",
      { proposal: replacement },
      undefined,
      undefined,
      h.ctx,
    );
    expect(proposed.isError, JSON.stringify(proposed.content)).not.toBe(true);
    const prompts = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    await h.command(`review-contract ${(proposed.details as { proposalId: string }).proposalId}`);
    expect(h.ctx.ui.custom).toHaveBeenCalledTimes(prompts);
    expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain(
      "exact current root/profile permission is absent",
    );
    expect(readControlJournal(h.ctx).acceptance?.contracts).toHaveLength(1);
    expect(currentRuntime().preflight?.approval).toEqual(approval);
    expect(currentRuntime().preflight?.started).toEqual(started);
    expect(existsSync(join(h.root, "unapproved-external-root"))).toBe(false);
  },
);

it.each(["input.txt", "checker.mjs"])(
  "asks Main to repair missing %s material, not reapprove or Start",
  async (file) => {
    const h = await approvedNodeBundle(),
      approved = structuredClone(currentRuntime().preflight);
    const questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    unlinkSync(join(h.root, file));
    await h.command("start");
    expect(currentRuntime().preflight?.started).toBeUndefined();
    expect(currentRuntime().preflight?.approval).toEqual(approved?.approval);
    expect(flowFacts(h.ctx).approval).toMatchObject({ kind: "materials", actor: "Main" });
    expect(flowFacts(h.ctx).approval?.command).toBeUndefined();
    expect(h.ctx.ui.custom).toHaveBeenCalledTimes(questions);
    expect(currentRuntime().journalFault).toBeUndefined();
  },
);
it("requires an explicit full scope review after actual workspace identity replacement, never definition-only renewal", async () => {
  const h = await approvedNodeBundle(),
    approved = structuredClone(currentRuntime().preflight?.approval);
  const questions = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  const container = mkdtempSync("/tmp/approval-root-identity-"),
    backup = join(container, "original");
  try {
    renameSync(h.root, backup);
    mkdirSync(h.root);
    for (const name of readdirSync(backup)) renameSync(join(backup, name), join(h.root, name));
    await h.command("start");
    expect(currentRuntime().preflight?.started).toBeUndefined();
    const action = flowFacts(h.ctx).approval;
    expect(action).toMatchObject({ kind: "permissions", actor: "user" });
    expect(action?.command).toContain(`approve ${currentRuntime().preflight?.planId} A1`);
    await h.command("approve");
    expect(currentRuntime().preflight?.approval).toEqual(approved);
    expect(h.ctx.ui.custom).toHaveBeenCalledTimes(questions);
    expect(vi.mocked(h.ctx.ui.notify).mock.calls.at(-1)?.[0]).toContain(
      "Workspace identity changed",
    );
    if (!action?.command) throw Error("No exact scope review action");
    await h.command(action.command.replace("/task-supervisor ", ""));
    expect(currentRuntime().preflight?.approval?.controlEntryId).not.toBe(approved?.controlEntryId);
    await h.command("start");
    expect(readControlJournal(h.ctx).acceptance?.contracts).toHaveLength(1);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

it("offers usable additional permission review, never Start, for an unselected preparation capability", async () => {
  const h = await plannedBundle({ pending: true });
  const state = currentRuntime().preflight;
  if (!state) throw Error("No actual planning state");
  const outcome = await createSubmitPreflightTool(h.mock.api).execute(
    "optional-preparation",
    {
      preflightId: state.preflightId,
      proposal: {
        ...localProposal,
        contractProposalId: h.proposalId,
        preparation: {
          checkIds: ["output"],
          permissionIds: ["A2"],
          steps: ["Create the checker only with the explicitly selected A2 capability"],
        },
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(outcome.isError, JSON.stringify(outcome.content)).not.toBe(true);
  // A1 is genuinely approved; that does not cover this declared A2-only preparation.
  expect(outcome.details).toMatchObject({
    status: "approved",
    state: { phase: "approved", approval: { permissionIds: ["A1"] } },
  });
  const action = flowFacts(h.ctx).approval;
  expect(action).toMatchObject({
    kind: "permissions",
    command: `/task-supervisor approve ${currentRuntime().preflight?.planId} A1,A2`,
  });
  const prompts = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeUndefined();
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(prompts);
  // Select the extra capability on the original component, not through a forged answer.
  const selected = installCustomUI(h.ctx, (driver) => {
    driver.press("a");
    driver.press("\u001b[B");
    driver.press(" ");
    for (let page = 0; page < 1000 && !driver.render().includes("完整材料已核对"); page++)
      driver.press("\u001b[6~");
    driver.press("\r");
  });
  interfaces.push(selected);
  if (!action?.command) throw Error("No legal exact permission action");
  await h.command(action.command.replace("/task-supervisor ", ""));
  expect(currentRuntime().preflight).toMatchObject({
    phase: "approved",
    approval: { permissionIds: ["A1", "A2"] },
  });
  expect(currentRuntime().preflight?.started).toBeUndefined();
  Object.assign(h.ctx.ui, { custom: h.approvalUI.custom });
  await h.command("start");
  expect(currentRuntime().preflight?.started).toBeDefined();
  expect(readControlJournal(h.ctx).acceptance?.runs ?? []).toHaveLength(0);
});

it("reviews a manual check definition before Start without treating permission confirmation as its answer", async () => {
  const h = await plannedBundle({ manual: true }),
    state = currentRuntime().preflight;
  if (!state) throw Error("No actual planning state");
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "manual-definition",
    {
      preflightId: state.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  await h.command("start");
  const view = readControlJournal(h.ctx).acceptance;
  expect(view?.contracts).toHaveLength(1);
  expect(view?.manualChecks).toHaveLength(0);
  expect(cachedAcceptanceReviewMaterial()).toMatchObject({
    checkDefinitions: [{ actualInvocation: null }],
    observations: [],
    manual: [],
  });
  const cache = currentRuntime().controlJournal;
  if (!cache?.acceptance) throw Error("No actual source-verified cache");
  // A resident partial view is display-only and must expose its missing definition.
  currentRuntime().controlJournal = {
    ...cache,
    acceptance: { ...cache.acceptance, definitions: [] },
  };
  expect(cachedAcceptanceReviewMaterial()).toMatchObject({
    checkDefinitions: [{ unavailable: true }],
  });
  currentRuntime().controlJournal = cache;
});

it("binds an existing explicitly permitted Python definition before future output exists", async () => {
  const h = await plannedBundle({ python: true });
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "python-plan",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: {
        ...localProposal,
        contractProposalId: h.proposalId,
        permissions: [
          ...localProposal.permissions,
          {
            ...localProposal.permissions[0]!,
            id: "A3",
            target: h.root,
            action:
              "Run fixed python-unittest-v1 with declared reads and private /tmp scratch only",
          },
        ],
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  const approval = structuredClone(currentRuntime().preflight?.approval);
  await h.command("start");
  const journal = readControlJournal(h.ctx);
  const bound = journal.acceptance?.contracts.at(-1)?.data;
  expect(bound?.authority.kind, JSON.stringify(vi.mocked(h.ctx.ui.notify).mock.calls)).toBe(
    "preflight-reviewed",
  );
  expect(bound?.checkerScopes).toMatchObject([
    { checkId: "output", root: h.root, inputs: ["test_output.py"] },
  ]);
  const definition = journal.acceptance?.definitions.at(-1)?.data;
  expect(definition?.invocation?.profile?.id).toBe("python-unittest-v1");
  expect(definition?.checkerWorkspace?.root).toBe(h.root);
  expect(cachedAcceptanceReviewMaterial()).toMatchObject({
    checkDefinitions: [{ actualInvocation: { profile: "python-unittest-v1" } }],
  });
  expect(currentRuntime().preflight?.approval).toEqual(approval);
  expect(existsSync(join(h.root, "result.txt"))).toBe(false);
  expect(journal.acceptance?.runs).toHaveLength(0);
});

it("confirms permissions and existing definitions once before Start without inventing a future output", async () => {
  const h = await plannedBundle();
  const result = await createSubmitPreflightTool(h.mock.api).execute(
    "complete-plan",
    {
      preflightId: currentRuntime().preflight!.preflightId,
      proposal: { ...localProposal, contractProposalId: h.proposalId },
    },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  expect(currentRuntime().preflight?.phase).toBe("approved");
  const rows = readFileSync(h.path, "utf8")
    .trim()
    .split("\n")
    .map(
      (line) =>
        JSON.parse(line) as {
          data?: { kind?: string; approvalFlow?: string; features?: string[] };
        },
    );
  const fence = rows.findIndex(
    (row) =>
      row.data?.kind === "format-fence" && row.data.features?.includes("approval-workflow-v1"),
  );
  expect(fence).toBeGreaterThanOrEqual(0);
  expect(fence).toBeLessThan(rows.findIndex((row) => row.data?.approvalFlow === "consolidated-v1"));
  expect(currentRuntime().supervisor).toBeUndefined();
  expect(existsSync(join(h.root, "result.txt"))).toBe(false);
  await h.command("start");
  expect(currentRuntime().preflight?.phase).toBe("started");
  expect(currentRuntime().supervisor?.status).toBe("active");
  expect(
    readControlJournal(h.ctx).acceptance?.contracts.at(-1)?.data.authority.kind,
    JSON.stringify({
      fault: currentRuntime().journalFault,
      notices: vi.mocked(h.ctx.ui.notify).mock.calls,
    }),
  ).toBe("preflight-reviewed");
  expect(readControlJournal(h.ctx).acceptance?.contractReviews).toHaveLength(0);
  expect(existsSync(join(h.root, "result.txt"))).toBe(false);
  await createWriteTasksTool(h.mock.api).execute(
    "owned-board",
    {
      mode: "replace",
      phases: [
        {
          title: "Output",
          tasks: [{ title: "Final output", prompt: "Produce and verify output", profile: "main" }],
        },
      ],
    },
    undefined,
    undefined,
    h.ctx,
  );
  const compiled = await createCompileTasksTool(h.mock.api).execute(
    "compile",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
  expect(getBoard().workflowStatus).toBe("active");
});

it.each([false, true])(
  "creates and freezes a pending checker without another business approval or Start (paused=%s)",
  async (paused) => {
    const h = await plannedBundle({ pending: true });
    const submitted = await createSubmitPreflightTool(h.mock.api).execute(
      "preparing-plan",
      {
        preflightId: currentRuntime().preflight!.preflightId,
        proposal: {
          ...localProposal,
          contractProposalId: h.proposalId,
          preparation: {
            checkIds: ["output"],
            steps: ["Create the declared checker in the approved source scope"],
            permissionIds: ["A1"],
          },
        },
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(submitted.isError, JSON.stringify(submitted.content)).not.toBe(true);
    const approvalId = currentRuntime().preflight?.approval?.controlEntryId;
    await h.command("start");
    expect(currentRuntime().preflight?.phase).toBe("started");
    expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
    const startId = currentRuntime().preflight?.started;
    await createWriteTasksTool(h.mock.api).execute(
      "draft",
      {
        mode: "replace",
        phases: [
          {
            title: "Owned",
            tasks: [{ title: "Final", prompt: "Create output and validate it", profile: "main" }],
          },
        ],
      },
      undefined,
      undefined,
      h.ctx,
    );
    expect(
      h.fire("tool_call", {
        toolCallId: "not-yet",
        toolName: "compile_tasks",
        input: { finalAcceptanceTaskId: "t-1.1" },
      }),
    ).toMatchObject({ block: true });
    h.fire("tool_result", {
      toolCallId: "not-yet",
      toolName: "compile_tasks",
      input: { finalAcceptanceTaskId: "t-1.1" },
      content: [],
      isError: true,
    });
    expect(existsSync(join(h.root, "checker.mjs"))).toBe(false);
    writeFileSync(join(h.root, "checker.mjs"), h.checker);
    if (paused) await h.command("pause");
    const supervisorBefore = structuredClone(currentRuntime().supervisor);
    await h.command(`review-contract ${h.proposalId}`);
    expect(
      readControlJournal(h.ctx).acceptance?.contracts.at(-1)?.data.authority.kind,
      JSON.stringify(vi.mocked(h.ctx.ui.notify).mock.calls),
    ).toBe("native-reviewed");
    expect(currentRuntime().preflight?.approval?.controlEntryId).toBe(approvalId);
    expect(currentRuntime().preflight?.started).toEqual(startId);
    expect(currentRuntime().supervisor).toMatchObject(supervisorBefore!);
    if (paused) {
      expect(currentRuntime().supervisor?.status).toBe("paused");
      expect(
        h.fire("tool_call", {
          toolCallId: "still-paused",
          toolName: "compile_tasks",
          input: { finalAcceptanceTaskId: "t-1.1" },
        }),
      ).toMatchObject({ block: true });
      h.fire("tool_result", {
        toolCallId: "still-paused",
        toolName: "compile_tasks",
        input: { finalAcceptanceTaskId: "t-1.1" },
        content: [],
        isError: true,
      });
      await h.command("resume");
    }
    const compiled = await createCompileTasksTool(h.mock.api).execute(
      "ready-now",
      { finalAcceptanceTaskId: "t-1.1" },
      undefined,
      undefined,
      h.ctx,
    );
    expect(compiled.isError, JSON.stringify(compiled.content)).not.toBe(true);
    expect(getBoard().workflowStatus).toBe("active");
  },
);
