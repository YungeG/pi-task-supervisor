// C3 native human-control/private-registry/physical-readback seam. In-memory
// trusted-source/TTY simulation only; never real person, CLI/PTY or product acceptance.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
beforeEach(resetState);
import { preflightLifecycle } from "./helpers/preflight";
import { recognizeAcceptanceSuite } from "../acceptance-contract";
import {
  registerHostAcceptanceContract,
  verifyManualCheck,
  acceptanceContractIssue,
  cachedAcceptanceLayers,
  cachedAcceptanceReviewMaterial,
} from "../acceptance-runtime";
import { readControlJournal, readControlFences } from "../control-journal";
import { inspectSessionJournal } from "../human-journal";
import {
  acceptanceRunActivityIssue,
  type ManualCheckBindingV1,
  manualCheckObservations,
  manualCheckSubject,
  type AcceptanceDefinitionFact,
} from "../acceptance-journal";
it("preserves an actual pause during native artifact response instead of publishing or resuming", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
    await h.command("pause");
    return "选项 1";
  });
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toEqual({
    status: "deferred",
    checkId: "manual",
  });
  expect(currentRuntime().supervisor?.status).toBe("paused");
  expect(readControlJournal(h.ctx).acceptance?.manualChecks).toHaveLength(0);
});
it.each([false, true])(
  "rejects copied/mismatched native manual wire sources (information=%s)",
  async (information) => {
    const h = await manualFixture(information);
    if (information) Object.assign(h.ctx.ui, { input: vi.fn(async () => "42") });
    else vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
    await verifyManualCheck(h.mock.api, h.ctx, "manual");
    interface Row {
      id: string;
      parentId: string | null;
      customType?: string;
      data?: unknown;
      [key: string]: unknown;
    }
    const source = readFileSync(h.path, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Row),
      index = source.findIndex(
        (row) => (row.data as { kind?: string } | undefined)?.kind === "acceptance-manual-control",
      ),
      file = join(dirname(h.path), "manual-negative.jsonl"),
      sessionId = h.ctx.sessionManager.getSessionId();
    if (index < 0) throw Error("Actual native manual control unavailable");
    function load(rows: Row[]) {
      writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return readControlFences(
        inspectSessionJournal({ path: file, sessionId, leafId: rows.at(-1)?.id ?? null }),
      );
    }
    const prefix = source.slice(0, index + 1);
    expect(() => load(prefix)).not.toThrow();
    expect(acceptanceRunActivityIssue(load(prefix).acceptance, sessionId)).toMatch(
      /no confirmed physical witness/,
    );
    const controls: Array<[string, (value: ManualCheckBindingV1) => void]> = [
      [
        "foreign-owner",
        (value) => {
          if (value.owner.kind === "goal") value.owner.goal.sessionId = "foreign";
        },
      ],
      [
        "missing-contract",
        (value) => {
          value.contractRef.entryId = "missing";
        },
      ],
      [
        "wrong-contract-digest",
        (value) => {
          value.contractRef.digest = "0".repeat(64);
        },
      ],
      [
        "missing-definition",
        (value) => {
          value.definitionRef.entryId = "missing";
        },
      ],
      [
        "wrong-definition-digest",
        (value) => {
          value.definitionRef.digest = "0".repeat(64);
        },
      ],
      [
        "wrong-source",
        (value) => {
          value.sourceRef.entryId = "missing";
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
        "wrong-subject",
        (value) => {
          value.frame.scopeDigest = "0".repeat(64);
        },
      ],
      [
        "wrong-version",
        (value) => {
          value.versionId = "0".repeat(64);
        },
      ],
      [
        "wrong-generation",
        (value) => {
          value.inputGeneration = "0".repeat(64);
        },
      ],
      [
        "wrong-sequence",
        (value) => {
          value.sourceSequence++;
        },
      ],
      [
        "invalid-response",
        (value) => {
          value.value = information ? "not-an-integer" : "not-a-choice";
        },
      ],
    ];
    for (const [name, mutate] of controls) {
      const rows = structuredClone(prefix);
      mutate(rows.at(-1)?.data as ManualCheckBindingV1);
      expect(() => load(rows), name).toThrow();
    }
    const duplicate = structuredClone(prefix),
      last = duplicate.at(-1);
    if (!last) throw Error("Control missing");
    duplicate.push({ ...structuredClone(last), id: "owned-duplicate-control", parentId: last.id });
    expect(() => load(duplicate)).toThrow();
    const witnessIndex = source.findIndex(
        (row, i) => i > index && row.customType === "continuous-tasks:human-readback",
      ),
      witnessRows = source.slice(0, witnessIndex + 1);
    expect(() => load(witnessRows)).not.toThrow();
    for (const key of ["controlDigest", "frame"] as const) {
      const rows = structuredClone(witnessRows),
        data = rows.at(-1)?.data as { controlDigest: string; frame: ManualCheckBindingV1["frame"] };
      if (key === "controlDigest") data.controlDigest = "0".repeat(64);
      else data.frame.requestId = "other";
      expect(() => load(rows), key).toThrow();
    }
    const copies = structuredClone(witnessRows),
      witness = copies.at(-1);
    if (!witness) throw Error("Witness missing");
    copies.push({
      ...structuredClone(witness),
      id: "owned-duplicate-witness",
      parentId: witness.id,
    });
    expect(() => load(copies)).toThrow();
  },
);
it("does not bypass a newer negative manual observation to reuse an earlier positive answer", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await verifyManualCheck(h.mock.api, h.ctx, "manual");
  expect(acceptanceContractIssue(h.ctx)).toBeUndefined();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 2");
  await verifyManualCheck(h.mock.api, h.ctx, "manual");
  expect(readControlJournal(h.ctx).acceptance?.manualChecks).toHaveLength(2);
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
});
it("requires a new native response for a new current artifact version", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await verifyManualCheck(h.mock.api, h.ctx, "manual");
  writeFileSync(join(dirname(h.path), "artifact.txt"), "new artifact version");
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
  await verifyManualCheck(h.mock.api, h.ctx, "manual");
  expect(acceptanceContractIssue(h.ctx)).toBeUndefined();
  const checks = readControlJournal(h.ctx).acceptance?.manualChecks;
  expect(checks?.[0]?.control.data.versionId).not.toBe(checks?.[1]?.control.data.versionId);
});
it("does not mint tracked invocation authority from a copied tool_call DTO", async () => {
  const h = await manualFixture(),
    path = join(dirname(h.path), "artifact.txt"),
    before = readFileSync(path, "utf8");
  expect(
    h.fire("tool_call", {
      toolCallId: "copied-manual-writer",
      toolName: "write",
      input: { path, content: "not executed" },
    }),
  ).toMatchObject({
    block: true,
    reason: expect.stringContaining("actual SDK assistant call source"),
  });
  expect(readFileSync(path, "utf8")).toBe(before);
});
it("does not turn incomplete cached manual projections or an automatic definition into manual proof", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await verifyManualCheck(h.mock.api, h.ctx, "manual");
  const view = readControlJournal(h.ctx).acceptance,
    bound = view?.contracts[0];
  if (!view || !bound) throw Error("Actual native manual source missing");
  for (const kind of ["no-witness", "different-contract", "missing-definition"]) {
    const copy = structuredClone(view),
      entry = copy.manualChecks[0];
    if (!entry) throw Error("Manual control missing");
    if (kind === "no-witness") entry.witness = undefined;
    if (kind === "different-contract") entry.control.data.contractRef.entryId = "different";
    if (kind === "missing-definition") copy.definitions = [];
    expect(manualCheckObservations(copy, bound)).toEqual([]);
  }
  const row = readFileSync(
    new URL("./fixtures/acceptance-check-sdk.jsonl", import.meta.url),
    "utf8",
  )
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { data?: AcceptanceDefinitionFact })
    .find((value) => value.data?.kind === "acceptance-definition-declared");
  if (!row?.data) throw Error("Actual owned automatic definition missing");
  expect(() =>
    manualCheckSubject(bound.data, row.data!, "0".repeat(64), "0".repeat(64), "Owned manual check"),
  ).toThrow();
});
it.each(["foreign-workspace", "missing-current-input"])(
  "does not ask or append a manual response with %s",
  async (kind) => {
    const h = await manualFixture();
    if (kind === "foreign-workspace") h.ctx.cwd = join(dirname(h.path), "other");
    else unlinkSync(join(dirname(h.path), "artifact.txt"));
    const before = readFileSync(h.path, "utf8"),
      calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
    await expect(verifyManualCheck(h.mock.api, h.ctx, "manual")).rejects.toThrow();
    expect(readFileSync(h.path, "utf8")).toBe(before);
    expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
  },
);
it("keeps manual response history but invalidates current applicability after an actual pause", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  await verifyManualCheck(h.mock.api, h.ctx, "manual");
  expect(cachedAcceptanceReviewMaterial()).toMatchObject({
    checkDefinitions: [{ actualInvocation: null }],
    manual: [{ witness: expect.any(Object) }],
  });
  await h.command("pause");
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
  expect(currentRuntime().supervisor?.status).toBe("paused");
  expect(readControlJournal(h.ctx).acceptance?.manualChecks[0]?.witness).toBeDefined();
});
it("does not confirm a native artifact answer after the actual host workspace changes during review", async () => {
  const h = await manualFixture(),
    before = readFileSync(h.path, "utf8");
  vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
    h.ctx.cwd = join(dirname(h.path), "other");
    return "选项 1";
  });
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toEqual({
    status: "deferred",
    checkId: "manual",
  });
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
async function manualFixture(information = false) {
  const h = preflightLifecycle(),
    root = dirname(h.path);
  const header = JSON.parse(readFileSync(h.path, "utf8").split("\n")[0] ?? "{}") as Record<
    string,
    unknown
  >;
  writeFileSync(h.path, JSON.stringify({ ...header, cwd: root }) + "\n");
  h.ctx.cwd = root;
  writeFileSync(join(root, "artifact.txt"), "owned-artifact\n");
  await h.command("supervise-legacy Owned manual check");
  const token = recognizeAcceptanceSuite("Owned manual check", {
    version: 1,
    scopeId: "owned-manual",
    inputs: ["artifact.txt"],
    artifacts: [],
    environment: { profileId: "owned-empty", values: {} },
    requirements: [
      {
        requirementId: "manual-condition",
        source: "Owned recognized manual specification",
        text: "The current owned artifact is manually checked",
        required: true,
      },
    ],
    checks: [
      {
        checkId: "manual",
        kind: "manual",
        requirementIds: ["manual-condition"],
        question: "核对当前产物，不能把权限审批当作产物接受。",
        response: information
          ? { kind: "information", format: "integer" }
          : { kind: "choice", options: ["已核验", "未通过"] },
        expectedValue: information ? "42" : "已核验",
      },
    ],
  });
  registerHostAcceptanceContract(h.mock.api, h.ctx, token);
  return h;
}
it("uses an actual opaque native response and paired physical witness, without task/permission/start changes", async () => {
  const h = await manualFixture();
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
  const before = h.entries
    .filter((row) => row.customType === "continuous-tasks:supervisor")
    .map((row) => JSON.stringify(row));
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toMatchObject({
    status: "confirmed",
    checkId: "manual",
    value: "已核验",
  });
  const view = readControlJournal(h.ctx);
  expect(view.acceptance?.manualChecks).toHaveLength(1);
  expect(view.acceptance?.manualChecks[0]?.witness).toBeDefined();
  expect(acceptanceContractIssue(h.ctx)).toBeUndefined();
  const branch = vi.spyOn(h.ctx.sessionManager, "getBranch").mockImplementation(() => {
    throw Error("Resident acceptance layers must not hydrate source");
  });
  expect(cachedAcceptanceLayers()).toMatchObject({
    contract: "bound-unchecked",
    manualResponses: 1,
    currentApplicability: "unknown",
    realHumanProductAcceptance: "not-inferred",
  });
  branch.mockRestore();
  expect(
    h.entries
      .filter((row) => row.customType === "continuous-tasks:supervisor")
      .map((row) => JSON.stringify(row)),
  ).toEqual(before);
  expect(h.ui.rendered.join("\n")).toContain("Owned·manual·check");
  expect(h.ui.rendered.join("\n")).toContain("manual-condition");
  expect(h.entries.some((row) => row.customType === "continuous-tasks:preflight-control")).toBe(
    false,
  );
});
it("records native information as information only, not approval or an execution grant", async () => {
  const h = await manualFixture(true);
  Object.assign(h.ctx.ui, { input: vi.fn(async () => "42") });
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toMatchObject({
    status: "confirmed",
    value: "42",
  });
  expect(acceptanceContractIssue(h.ctx)).toBeUndefined();
  expect(
    h.entries.filter((row) => row.customType === "continuous-tasks:preflight-control"),
  ).toEqual([]);
});
it("retains a genuine negative manual response without treating it as acceptance", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 2");
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toMatchObject({
    status: "confirmed",
    value: "未通过",
  });
  expect(readControlJournal(h.ctx).acceptance?.manualChecks[0]?.witness).toBeDefined();
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
});
it("does not publish a stale response after a real owned input change during the final native choice", async () => {
  const h = await manualFixture(),
    before = readFileSync(h.path, "utf8");
  vi.mocked(h.ctx.ui.select).mockImplementation(async () => {
    writeFileSync(join(dirname(h.path), "artifact.txt"), "changed-owned-artifact\n");
    return "选项 1";
  });
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toMatchObject({
    status: "deferred",
  });
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
});
it("does not admit a copied custom review DTO as a real scope-review handshake", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.custom).mockResolvedValue({
    reviewed: true,
    outcome: "answer",
    value: "已核验",
  });
  const before = readFileSync(h.path, "utf8"),
    calls = vi.mocked(h.ctx.ui.select).mock.calls.length;
  expect(await verifyManualCheck(h.mock.api, h.ctx, "manual")).toMatchObject({
    status: "deferred",
  });
  expect(h.ctx.ui.select).toHaveBeenCalledTimes(calls);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("keeps a confirmed control without its physical witness held and never replays the native question", async () => {
  const h = await manualFixture();
  vi.mocked(h.ctx.ui.select).mockResolvedValue("选项 1");
  const append = h.mock.appendEntry.getMockImplementation() as
    | ((type: string, data: unknown) => void)
    | undefined;
  if (!append) throw Error("Owned append adapter missing");
  h.mock.appendEntry.mockImplementation((type, data) => {
    if (type === "continuous-tasks:human-readback") throw Error("Owned witness write rejected");
    append(type, data);
  });
  await expect(verifyManualCheck(h.mock.api, h.ctx, "manual")).rejects.toThrow(
    "Owned witness write rejected",
  );
  const before = readFileSync(h.path, "utf8"),
    calls = vi.mocked(h.ctx.ui.custom).mock.calls.length;
  expect(readControlJournal(h.ctx).acceptance?.manualChecks[0]?.witness).toBeUndefined();
  await h.command("verify-check manual");
  expect(h.ctx.ui.custom).toHaveBeenCalledTimes(calls);
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
it("rejects an SDK/RPC copied UI DTO before requesting it or appending a confirmation", async () => {
  const h = await manualFixture();
  h.ctx.mode = "rpc";
  const custom = vi.mocked(h.ctx.ui.custom);
  custom.mockResolvedValue({ outcome: "answer", value: "已核验", answeredAt: 1 });
  const before = readFileSync(h.path, "utf8"),
    calls = custom.mock.calls.length;
  await h.command("verify-check manual");
  expect(h.ctx.ui.notify).toHaveBeenCalledWith(
    expect.stringContaining("受信本机原生 TUI"),
    "warning",
  );
  expect(custom).toHaveBeenCalledTimes(calls);
  expect(readFileSync(h.path, "utf8")).toBe(before);
  expect(acceptanceContractIssue(h.ctx)).toContain("manual-condition");
});
