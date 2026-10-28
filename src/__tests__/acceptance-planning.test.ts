// C2 approved normal planning -> independent permission/start -> native contract
// review -> first compilation. Owned physical adapter + public component simulation,
// not actual person/product/CLI acceptance or a new permission grant.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { preflightLifecycle, localProposal } from "./helpers/preflight";
import { installCustomUI } from "./helpers/custom-ui";
import { resetState, getBoard } from "../state";
import { currentRuntime } from "../runtime";
import { createSubmitPreflightTool, createWriteTasksTool, createCompileTasksTool } from "../tools";
import { createProposeContractTool } from "../acceptance-tool";
import { reviewAcceptanceContract, contractCompilationAdmission } from "../acceptance-runtime";
import { readControlJournal, readControlFences } from "../control-journal";
import { inspectSessionJournal, journalDigest } from "../human-journal";
import {
  contractProposalViews,
  type ContractProposalRecord,
  proposalForGoal,
  proposalSourceNode,
  validContractProposal,
} from "../acceptance-planning";
import {
  acceptanceRunActivityIssue,
  acceptanceContractDigest,
  acceptanceDefinitionDigest,
  type ContractReviewControl,
  type AcceptanceBoundFact,
  type AcceptanceDefinitionFact,
} from "../acceptance-journal";
beforeEach(resetState);
interface NativeRow {
  id: string;
  parentId: string | null;
  customType?: string;
  data?: unknown;
  [key: string]: unknown;
}
it("rejects native proposal/review/witness forgeries and retains an interrupted source group", async () => {
  const h = await plannedFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId);
  const source = readFileSync(h.path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as NativeRow),
    sessionId = h.ctx.sessionManager.getSessionId(),
    file = join(h.root, "negative-wire.jsonl");
  function journal(rows: NativeRow[]) {
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return inspectSessionJournal({ path: file, sessionId, leafId: rows.at(-1)?.id ?? null });
  }
  function prefix(kind: string) {
    const index = source.findIndex(
      (row) =>
        row.customType === "continuous-tasks:acceptance-facts" &&
        (row.data as { kind?: string } | undefined)?.kind === kind,
    );
    if (index < 0) throw Error("Actual native fixture unavailable");
    const rows = structuredClone(source.slice(0, index + 1));
    expect(() => readControlFences(journal(rows))).not.toThrow();
    return rows;
  }
  const proposals = source.findIndex(
      (row) => row.customType === "continuous-tasks:acceptance-proposal",
    ),
    proposalRows = structuredClone(source.slice(0, proposals + 1));
  expect(contractProposalViews(journal(proposalRows))).toHaveLength(1);
  const badProposals: Array<[string, (value: ContractProposalRecord) => void]> = [
    [
      "foreign-session",
      (value) => {
        value.sessionId = "foreign";
      },
    ],
    [
      "missing-source",
      (value) => {
        value.sourceRef.entryId = "missing";
      },
    ],
    [
      "wrong-source-hash",
      (value) => {
        value.sourceRef.digest = "0".repeat(64);
      },
    ],
    [
      "wrong-preflight",
      (value) => {
        value.target = { kind: "preflight", preflightId: "other" };
      },
    ],
    [
      "invalid-proposal",
      (value) => {
        value.proposal.inputs = ["../outside"];
      },
    ],
    [
      "goal-instead-of-preflight",
      (value) => {
        const owner = readControlJournal(h.ctx).acceptance?.contracts[0]?.data.owner;
        if (!owner) throw Error("Actual owner unavailable");
        value.target = { kind: "goal", owner };
      },
    ],
  ];
  for (const [name, mutate] of badProposals) {
    const rows = structuredClone(proposalRows);
    mutate(rows.at(-1)?.data as ContractProposalRecord);
    expect(() => contractProposalViews(journal(rows)), name).toThrow();
  }
  const duplicate = structuredClone(proposalRows),
    last = duplicate.at(-1);
  if (!last) throw Error("Actual proposal missing");
  duplicate.push({ ...structuredClone(last), id: "owned-negative-duplicate", parentId: last.id });
  expect(() => contractProposalViews(journal(duplicate))).toThrow();
  const controls: Array<[string, (value: ContractReviewControl) => void]> = [
    [
      "missing-proposal",
      (value) => {
        value.proposalRef.entryId = "missing";
      },
    ],
    [
      "wrong-proposal-digest",
      (value) => {
        value.proposalRef.digest = "0".repeat(64);
      },
    ],
    [
      "foreign-frame",
      (value) => {
        value.frame.sessionId = "foreign";
      },
    ],
    [
      "wrong-base",
      (value) => {
        value.frame.baseEntryId = "missing";
      },
    ],
    [
      "wrong-base-digest",
      (value) => {
        value.frame.baseEntryDigest = "0".repeat(64);
      },
    ],
    [
      "wrong-source",
      (value) => {
        value.sourceRef.entryId = "missing";
      },
    ],
  ];
  for (const [name, mutate] of controls) {
    const rows = prefix("acceptance-contract-control");
    mutate(rows.at(-1)?.data as ContractReviewControl);
    expect(() => readControlFences(journal(rows)), name).toThrow();
  }
  for (const kind of ["declined-answer", "different-contract-id", "different-revision"]) {
    const rows = prefix("acceptance-contract-bound"),
      controlRow = rows.find(
        (row) =>
          (row.data as { kind?: string } | undefined)?.kind === "acceptance-contract-control",
      ),
      bound = rows.at(-1)?.data as AcceptanceBoundFact;
    if (!controlRow) throw Error("Actual native control missing");
    const control = controlRow.data as ContractReviewControl;
    if (kind === "declined-answer") control.value = "不绑定";
    if (kind === "different-contract-id") control.contractId = "different";
    if (kind === "different-revision") control.revision++;
    const hash = journalDigest(controlRow),
      witness = rows.find(
        (row) =>
          row.customType === "continuous-tasks:human-readback" &&
          (row.data as { controlEntryId?: string } | undefined)?.controlEntryId === controlRow.id,
      );
    if (!witness || bound.authority.kind !== "native-reviewed")
      throw Error("Actual reviewed authority missing");
    (witness.data as { controlDigest: string }).controlDigest = hash;
    bound.authority.controlRef.digest = hash;
    bound.contractDigest = acceptanceContractDigest(bound);
    expect(
      () => readControlFences(journal(rows.slice(0, -1))),
      `${kind} preceding group`,
    ).not.toThrow();
    expect(() => readControlFences(journal(rows)), kind).toThrow();
  }
  const interrupted = prefix("acceptance-contract-control"),
    pending = readControlFences(journal(interrupted)).acceptance;
  expect(pending?.contractReviews[0]?.witness).toBeUndefined();
  expect(acceptanceRunActivityIssue(pending, sessionId)).toMatch(/no confirmed witness/);
  const bounds: Array<[string, (value: AcceptanceBoundFact) => void]> = [
    [
      "missing-review",
      (value) => {
        if (value.authority.kind === "native-reviewed")
          value.authority.controlRef.entryId = "missing";
      },
    ],
    [
      "wrong-review-hash",
      (value) => {
        if (value.authority.kind === "native-reviewed")
          value.authority.controlRef.digest = "0".repeat(64);
      },
    ],
    [
      "unreviewed-meaning",
      (value) => {
        for (const req of value.header.requirements) req.text = "Changed after native review";
      },
    ],
  ];
  for (const [name, mutate] of bounds) {
    const rows = prefix("acceptance-contract-bound"),
      bound = rows.at(-1)?.data as AcceptanceBoundFact;
    mutate(bound);
    bound.contractDigest = acceptanceContractDigest(bound);
    expect(() => readControlFences(journal(rows)), name).toThrow();
  }
  // Deliberately rehash dependent records: still a NEGATIVE forgery, not proof of
  // execution/consent. The real native frame must bind the complete frozen bytes.
  const forged = prefix("acceptance-contract-bound"),
    definitionRow = forged.find(
      (row) =>
        (row.data as { kind?: string } | undefined)?.kind === "acceptance-definition-declared",
    ),
    bound = forged.at(-1)?.data as AcceptanceBoundFact;
  if (!definitionRow) throw Error("Actual definition missing");
  const definition = definitionRow.data as AcceptanceDefinitionFact;
  definition.frozenFiles = definition.frozenFiles.map((item) => ({
    ...item,
    sha256: "0".repeat(64),
  }));
  definition.definitionDigest = acceptanceDefinitionDigest(definition);
  bound.definitions = bound.definitions.map((item) => ({
    ...item,
    definitionDigest: definition.definitionDigest,
    ref: { entryId: definitionRow.id, digest: journalDigest(definitionRow) },
  }));
  bound.contractDigest = acceptanceContractDigest(bound);
  expect(() => readControlFences(journal(forged.slice(0, -1)))).not.toThrow();
  expect(() => readControlFences(journal(forged))).toThrow();
});
it("keeps an interrupted native definition witness held without asking or binding it again", async () => {
  const h = await plannedFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  const append = h.mock.appendEntry.getMockImplementation() as
    | ((type: string, data: unknown) => void)
    | undefined;
  if (!append) throw Error("Owned append missing");
  h.mock.appendEntry.mockImplementation((type, data) => {
    if (type === "continuous-tasks:human-readback") throw Error("Owned definition witness failure");
    append(type, data);
  });
  await expect(reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId)).rejects.toThrow(
    /Owned definition witness failure/,
  );
  const before = readFileSync(h.path, "utf8"),
    calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  expect(readControlJournal(h.ctx).acceptance?.contractReviews[0]?.witness).toBeUndefined();
  await h.command(`review-contract ${h.proposalId}`);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
});
it("does not bind after the confirmed definition witness when controlled inputs have subsequently changed", async () => {
  const h = await plannedFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  const append = h.mock.appendEntry.getMockImplementation() as
    | ((type: string, data: unknown) => void)
    | undefined;
  if (!append) throw Error("Owned append missing");
  h.mock.appendEntry.mockImplementation((type, data) => {
    append(type, data);
    if (type === "continuous-tasks:human-readback")
      writeFileSync(join(h.root, "input.txt"), "changed after witness");
  });
  await expect(reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId)).rejects.toThrow(
    /do not reconstruct or replay/,
  );
  const view = readControlJournal(h.ctx).acceptance;
  expect(view?.contractReviews[0]?.witness).toBeDefined();
  expect(view?.contracts).toHaveLength(0);
});
it("holds complete over-64KB native review material even when each individual fact fits", async () => {
  const h = await plannedFixture(),
    configs = Array.from({ length: 31 }, (_, i) => `config-${i}.json`);
  for (const name of configs) writeFileSync(join(h.root, name), "{}");
  const proposal = {
    ...h.proposal,
    inputs: [...h.proposal.inputs, ...configs],
    checks: Array.from({ length: 16 }, (_, i) => ({
      ...h.proposal.checks[0]!,
      checkId: `unit-${i}`,
      configs,
    })),
  };
  const result = await createProposeContractTool(h.mock.api).execute(
    "wide-material",
    { proposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).not.toBe(true);
  const before = readFileSync(h.path, "utf8"),
    calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await expect(
    reviewAcceptanceContract(
      h.mock.api,
      h.ctx,
      (result.details as { proposalId: string }).proposalId,
    ),
  ).rejects.toThrow(/exceeds64KB/);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
});
it("holds every managed execution entry before a normal Goal has its trusted contract", async () => {
  const h = await plannedFixture();
  for (const toolName of [
    "compile_tasks",
    "get_ready_tasks",
    "advance_tasks",
    "workflow_gate",
    "run_check",
  ]) {
    const id = `unbound-${toolName}`;
    expect(h.fire("tool_call", { toolCallId: id, toolName, input: {} })).toMatchObject({
      block: true,
      reason: expect.stringContaining("contract"),
    });
    h.fire("tool_result", { toolCallId: id, toolName, input: {}, content: [], isError: true });
  }
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
});
it("rejects foreign, missing and unreadable proposal-to-Goal sources at the public matching boundary", async () => {
  const h = await plannedFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId);
  const actual = inspectSessionJournal({
      path: h.path,
      sessionId: h.ctx.sessionManager.getSessionId(),
      leafId: h.ctx.sessionManager.getLeafId(),
    }),
    proposal = contractProposalViews(actual)[0],
    bound = readControlJournal(h.ctx).acceptance?.contracts[0];
  if (!proposal || !bound) throw Error("Actual reviewed source missing");
  expect(() => {
    proposalForGoal(actual, proposal, bound.data.owner, bound.data.sourceRef);
  }).not.toThrow();
  for (const kind of [
    "board-owner",
    "foreign-proposal",
    "missing-goal-source",
    "wrong-source-hash",
    "wrong-lifecycle",
    "wrong-goal-key",
    "missing-goal-proof",
    "foreign-source-session",
    "original-goal-mismatch",
    "different-goal-target",
    "different-preflight-target",
  ]) {
    const candidate = structuredClone(proposal),
      owner = structuredClone(bound.data.owner),
      ref = { ...bound.data.sourceRef },
      nodes = new Map(actual.nodes);
    if (kind === "board-owner") {
      expect(() => {
        proposalForGoal(
          actual,
          candidate,
          {
            kind: "board",
            board: { sessionId: actual.sessionId, boardRunId: "foreign", seedEntryId: "missing" },
          },
          ref,
        );
      }).toThrow();
      continue;
    }
    if (kind === "foreign-proposal") candidate.data.sessionId = "foreign";
    if (kind === "missing-goal-source") nodes.delete(ref.entryId);
    if (kind === "wrong-source-hash") ref.digest = "0".repeat(64);
    if (kind === "wrong-lifecycle" && owner.kind === "goal")
      owner.goal.lifecycleCommitId = "foreign";
    if (kind === "wrong-goal-key" && owner.kind === "goal") owner.goal.goalKey = "foreign";
    if (["missing-goal-proof", "foreign-source-session", "original-goal-mismatch"].includes(kind)) {
      const node = nodes.get(ref.entryId);
      if (!node?.supervisorProof) throw Error("Actual Goal proof missing");
      nodes.set(node.id, {
        ...node,
        supervisorProof:
          kind === "missing-goal-proof"
            ? undefined
            : {
                ...node.supervisorProof,
                ...(kind === "foreign-source-session"
                  ? { sessionId: "foreign" }
                  : { goalText: "Different original Goal" }),
              },
      });
    }
    if (kind === "different-goal-target" && owner.kind === "goal")
      candidate.data.target = {
        kind: "goal",
        owner: { ...owner, goal: { ...owner.goal, goalKey: "different" } },
      };
    if (kind === "different-preflight-target")
      candidate.data.target = { kind: "preflight", preflightId: "different" };
    expect(() => {
      proposalForGoal({ ...actual, nodes }, candidate, owner, ref);
    }, kind).toThrow();
  }
  const source = actual.nodes.get(proposal.data.sourceRef.entryId);
  if (!source) throw Error("Actual preflight source missing");
  for (const body of [
    null,
    { version: 0 },
    { version: 1, sessionId: actual.sessionId, preflightId: "x", goal: 7 },
    { version: 1, sessionId: actual.sessionId, preflightId: "x", goal: "界".repeat(1400) },
  ]) {
    const node = { ...source, data: body };
    expect(
      proposalSourceNode({ ...actual, branch: [node], nodes: new Map([[node.id, node]]) }, "x"),
    ).toBeUndefined();
  }
  const board = {
    ...proposal.data,
    target: {
      kind: "goal" as const,
      owner: {
        kind: "board" as const,
        board: { sessionId: actual.sessionId, boardRunId: "foreign", seedEntryId: "missing" },
      },
    },
  };
  expect(validContractProposal(board, actual.sessionId)).toBe(false);
  const foreign = structuredClone(proposal.data),
    owner = structuredClone(bound.data.owner);
  if (owner.kind !== "goal") throw Error("Actual Goal owner missing");
  owner.goal.sessionId = "foreign";
  foreign.target = { kind: "goal", owner };
  expect(validContractProposal(foreign, actual.sessionId)).toBe(false);
  const wide = structuredClone(proposal.data),
    requirements = Array.from({ length: 16 }, (_, i) => ({
      ...wide.proposal.requirements[0]!,
      requirementId: `r-${i}`,
      text: "界".repeat(1200),
    }));
  wide.proposal = {
    ...wide.proposal,
    requirements,
    inputs: [
      ...wide.proposal.inputs,
      ...Array.from({ length: 100 }, (_, i) => `f-${i}`.padEnd(120, "x")),
    ],
    checks: wide.proposal.checks.map((check) => ({
      ...check,
      requirementIds: requirements.map((req) => req.requirementId),
    })),
  };
  expect(validContractProposal(wide, actual.sessionId)).toBe(false);
});
it("keeps the native contract gate separate from ordinary business authorization and releases compilation only after binding", async () => {
  const h = await plannedFixture();
  expect(contractCompilationAdmission(h.ctx, "read", {}, true)).toBeUndefined();
  expect(contractCompilationAdmission(h.ctx, "write", {}, false)).toBeUndefined();
  expect(contractCompilationAdmission(h.ctx, "compile_tasks", {}, false)).toMatch(/not bound/);
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId);
  expect(contractCompilationAdmission(h.ctx, "compile_tasks", {}, false)).toBeUndefined();
});
async function plannedFixture() {
  const h = preflightLifecycle(),
    root = dirname(h.path),
    header = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0] ?? "{}") as Record<
      string,
      unknown
    >;
  writeFileSync(h.path, JSON.stringify({ ...header, cwd: root }) + "\n");
  h.ctx.cwd = root;
  writeFileSync(join(root, "input.txt"), "owned");
  writeFileSync(
    join(root, "checker.mjs"),
    "import assert from 'node:assert/strict';import{readFileSync}from'node:fs';assert.equal(readFileSync(new URL('./input.txt',import.meta.url),'utf8'),'owned');console.log(JSON.stringify({protocol:'check-result-v1',tests:1,passed:1,failed:0,skipped:0,requiredCases:{input:'passed'},skippedIds:[]}));\n",
  );
  await h.command("preflight Owned planned contract");
  const proposal = {
    version: 1 as const,
    scopeId: "planned",
    inputs: ["input.txt", "checker.mjs"],
    artifacts: [],
    environment: { profileId: "none", values: {} },
    requirements: [
      {
        requirementId: "required-input",
        source: "Native review of the original Goal",
        text: "The declared checker must execute its input case",
        required: true,
      },
    ],
    checks: [
      {
        kind: "automatic" as const,
        checkId: "unit",
        requirementIds: ["required-input"],
        script: "checker.mjs",
        checkerFiles: ["checker.mjs"],
        configs: [],
        args: [],
        timeoutMs: 1000,
        expected: { minTests: 1, requiredCases: ["input"], allowedSkipped: [] },
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
  expect(proposed.isError).not.toBe(true);
  expect(proposed.details).toMatchObject({ status: "proposed-untrusted" });
  const proposalId = (proposed.details as { proposalId: string }).proposalId;
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
  const preflight = currentRuntime().preflight;
  if (!preflight) throw Error("Native planning owner missing");
  await createSubmitPreflightTool(h.mock.api).execute(
    "plan-proposal",
    { preflightId: preflight.preflightId, proposal: localProposal },
    undefined,
    undefined,
    h.ctx,
  );
  await h.command(`approve ${currentRuntime().preflight?.planId} A1`);
  await h.command(`start ${currentRuntime().preflight?.planId}`);
  await createWriteTasksTool(h.mock.api).execute(
    "graph",
    {
      mode: "replace",
      phases: [
        {
          title: "Owned",
          tasks: [{ title: "Final", prompt: "Run the declared check", profile: "main" }],
        },
      ],
    },
    undefined,
    undefined,
    h.ctx,
  );
  return { ...h, root, proposal, proposalId };
}
it("keeps model proposals untrusted until a separate native review fixes the current contract before compile", async () => {
  const h = await plannedFixture(),
    { proposalId } = h;
  expect(
    h.fire("tool_call", {
      toolCallId: "compile-before",
      toolName: "compile_tasks",
      input: { finalAcceptanceTaskId: "t-1.1" },
    }),
  ).toMatchObject({ block: true, reason: expect.stringContaining("contract") });
  h.fire("tool_result", {
    toolCallId: "compile-before",
    toolName: "compile_tasks",
    input: { finalAcceptanceTaskId: "t-1.1" },
    content: [],
    isError: true,
  });
  const permissions = h.entries
    .filter((row) => row.customType === "continuous-tasks:preflight-control")
    .map((row) => JSON.stringify(row));
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  expect(await reviewAcceptanceContract(h.mock.api, h.ctx, proposalId)).toMatchObject({
    status: "bound",
  });
  expect(readControlJournal(h.ctx).acceptance?.contracts.at(-1)?.data.authority.kind).toBe(
    "native-reviewed",
  );
  expect(
    h.entries
      .filter((row) => row.customType === "continuous-tasks:preflight-control")
      .map((row) => JSON.stringify(row)),
  ).toEqual(permissions);
  const compiled = await createCompileTasksTool(h.mock.api).execute(
    "compile-after",
    { finalAcceptanceTaskId: "t-1.1" },
    undefined,
    undefined,
    h.ctx,
  );
  expect(compiled.isError).not.toBe(true);
  expect(getBoard().workflowStatus).toBe("active");
  expect(h.ui.rendered.join("\n")).toContain("Owned·planned·contract");
});
it("does not bind a copied SDK/RPC definition-review result", async () => {
  const h = await plannedFixture();
  h.ctx.mode = "rpc";
  vi.mocked(h.ctx.ui.custom).mockResolvedValue({ outcome: "answer", value: "绑定此契约" });
  const before = readFileSync(h.path, "utf8"),
    calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await h.command(`review-contract ${h.proposalId}`);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
});
it("records a real declined definition review without manufacturing a selected contract", async () => {
  const h = await plannedFixture();
  const ui = installCustomUI(h.ctx, (driver) => driver.press("r"));
  expect(await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId)).toEqual({
    status: "declined",
  });
  ui.assertNoScriptErrors();
  const view = readControlJournal(h.ctx).acceptance;
  expect(view?.contractReviews[0]?.witness).toBeDefined();
  expect(view?.contracts).toHaveLength(0);
});
it("invalidates a native review when owned controlled bytes change before the answer is admitted", async () => {
  const h = await plannedFixture();
  const ui = installCustomUI(h.ctx, (driver) => {
    writeFileSync(join(h.root, "input.txt"), "changed");
    driver.reviewAll();
  });
  expect(await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId)).toEqual({
    status: "deferred",
  });
  ui.assertNoScriptErrors();
  expect(readControlJournal(h.ctx).acceptance?.contracts ?? []).toHaveLength(0);
});
it("versions a technical checker replacement, but does not allow deleting or changing required meaning", async () => {
  const h = await plannedFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  const initial = await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId);
  expect(initial).toMatchObject({ status: "bound", revision: 1 });
  writeFileSync(
    join(h.root, "checker.mjs"),
    readFileSync(join(h.root, "checker.mjs"), "utf8") +
      "\n// Owned technical organization revision\n",
  );
  expect(await reviewAcceptanceContract(h.mock.api, h.ctx, h.proposalId)).toMatchObject({
    status: "bound",
    revision: 2,
  });
  const rows = readFileSync(h.path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as NativeRow),
    index = rows
      .map((row) => (row.data as { kind?: string } | undefined)?.kind)
      .lastIndexOf("acceptance-contract-bound"),
    prefixRows = rows.slice(0, index + 1),
    file = join(h.root, "revision-negative.jsonl");
  for (const kind of [
    "skipped-revision",
    "different-contract",
    "wrong-predecessor",
    "changed-condition",
  ]) {
    const candidate = structuredClone(prefixRows),
      bound = candidate.at(-1)?.data as AcceptanceBoundFact;
    if (kind === "skipped-revision") bound.revision = 3;
    if (kind === "different-contract") bound.contractId = "different";
    if (kind === "wrong-predecessor")
      bound.previousRef = { entryId: "missing", digest: "0".repeat(64) };
    if (kind === "changed-condition") bound.header.requirements[0]!.text = "Unreviewed replacement";
    bound.contractDigest = acceptanceContractDigest(bound);
    writeFileSync(file, candidate.map((row) => JSON.stringify(row)).join("\n") + "\n");
    expect(
      () =>
        readControlFences(
          inspectSessionJournal({
            path: file,
            sessionId: h.ctx.sessionManager.getSessionId(),
            leafId: candidate.at(-1)?.id ?? null,
          }),
        ),
      kind,
    ).toThrow();
  }
  const proposed = await createProposeContractTool(h.mock.api).execute(
    "new-meaning",
    {
      proposal: {
        ...h.proposal,
        requirements: h.proposal.requirements.map((item) => ({
          ...item,
          text: "Different required business meaning",
        })),
      },
    },
    undefined,
    undefined,
    h.ctx,
  );
  const id = (proposed.details as { proposalId: string }).proposalId,
    calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await expect(reviewAcceptanceContract(h.mock.api, h.ctx, id)).rejects.toThrow(/new Goal/);
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
  expect(readControlJournal(h.ctx).acceptance?.contracts.at(-1)?.data.revision).toBe(2);
});
it("holds native binding capacity before UI or any authority append instead of dropping conditions", async () => {
  const h = await plannedFixture(),
    requirements = Array.from({ length: 16 }, (_, i) => ({
      requirementId: `r${i}`,
      source: "Complete original specification",
      text: "必需验收条件".repeat(190),
      required: true,
    }));
  const proposal = {
    ...h.proposal,
    requirements,
    checks: h.proposal.checks.map((item) => ({
      ...item,
      requirementIds: requirements.map((req) => req.requirementId),
    })),
  };
  const result = await createProposeContractTool(h.mock.api).execute(
    "capacity",
    { proposal },
    undefined,
    undefined,
    h.ctx,
  );
  expect(result.isError).not.toBe(true);
  const id = (result.details as { proposalId: string }).proposalId;
  const before = readFileSync(h.path, "utf8"),
    calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  await expect(reviewAcceptanceContract(h.mock.api, h.ctx, id)).rejects.toThrow(/capacity/);
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
