// C1/D public strict-reader seam. Every baseline prefix is unchanged actual SDK output.
// Single-point mutants are negative wire probes, never new execution/qualification proof.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectSessionJournal, journalDigest } from "../human-journal";
import { readControlFences } from "../control-journal";
import {
  acceptanceDefinitionDigest,
  acceptanceContractDigest,
  acceptanceRunActivityIssue,
  readAcceptanceFacts,
  acceptanceGoalSource,
  type AcceptanceDefinitionFact,
  type AcceptanceBoundFact,
  type AcceptanceCheckStarted,
  type AcceptanceCheckObserved,
  type AcceptanceReviewBound,
  type AcceptanceFact,
} from "../acceptance-journal";
interface Row {
  type: string;
  id: string;
  parentId: string | null;
  customType?: string;
  data?: unknown;
}
const bytes = readFileSync(new URL("./fixtures/acceptance-check-sdk.jsonl", import.meta.url));
expect(createHash("sha256").update(bytes).digest("hex")).toBe(
  "d60084ec33faf1e94e06d5574e57df59bd4b007757fc3335e3b94800eeb8c27f",
);
const source = bytes
  .toString()
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line) as Row);
const sessionId = (JSON.parse(bytes.toString().split("\n")[0] ?? "{}") as { id: string }).id;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function journal(rows: Row[]) {
  const dir = mkdtempSync(join(tmpdir(), "owned-p7-wire-")),
    file = join(dir, "source.jsonl");
  roots.push(dir);
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return inspectSessionJournal({ path: file, sessionId, leafId: rows.at(-1)?.id ?? null });
}
function load(rows: Row[]) {
  return readControlFences(journal(rows));
}
function prefix<T extends AcceptanceFact>(kind: T["kind"]) {
  const index = source.findIndex(
    (row) =>
      row.customType === "continuous-tasks:acceptance-facts" &&
      (row.data as { kind?: string } | undefined)?.kind === kind,
  );
  if (index < 0) throw Error("Actual producer prefix unavailable");
  const rows = structuredClone(source.slice(0, index + 1));
  expect(() => load(rows)).not.toThrow();
  const row = rows.at(-1);
  if (!row) throw Error("Native target missing");
  return { rows, row, data: row.data as T };
}
it.each([
  "board-owner",
  "future-source",
  "non-goal-source",
  "foreign-goal",
  "foreign-lifecycle",
  "missing-goal-text",
])("does not infer original Goal source from %s", (kind) => {
  const item = prefix<AcceptanceDefinitionFact>("acceptance-definition-declared"),
    actual = journal(item.rows),
    ref = { ...item.data.sourceRef };
  const nodes = new Map(actual.nodes);
  let owner = structuredClone(item.data.owner),
    position = actual.branch.length;
  if (kind === "board-owner")
    owner = {
      kind: "board",
      board: { sessionId, boardRunId: "not-an-actual-board", seedEntryId: "missing" },
    };
  if (kind === "future-source") position = 0;
  if (kind === "non-goal-source") {
    ref.entryId = item.row.id;
    ref.digest = journalDigest(item.data);
  }
  if (kind === "foreign-goal" && owner.kind === "goal") owner.goal.goalKey = "foreign";
  if (kind === "foreign-lifecycle" && owner.kind === "goal")
    owner.goal.lifecycleCommitId = "foreign";
  if (kind === "missing-goal-text") {
    const node = nodes.get(ref.entryId);
    if (!node?.supervisorProof) throw Error("Original Goal source missing");
    nodes.set(node.id, {
      ...node,
      supervisorProof: { ...node.supervisorProof, goalText: undefined },
    });
  }
  expect(() => acceptanceGoalSource({ ...actual, nodes }, owner, ref, position)).toThrow();
});
const definitions: Array<[string, (data: AcceptanceDefinitionFact) => void]> = [
  [
    "board-owned-definition",
    (data) => {
      data.owner = {
        kind: "board",
        board: { sessionId, boardRunId: "not-an-actual-board", seedEntryId: "missing" },
      };
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
  [
    "missing-native-descriptor",
    (data) => {
      data.invocation = null;
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
  [
    "manual-with-frozen-automatic-files",
    (data) => {
      data.invocation = null;
      data.spec = {
        kind: "manual",
        checkId: "manual",
        requirementIds: ["declared-check"],
        question: "Owned manual question",
        response: { kind: "choice", options: ["yes", "no"] },
        expectedValue: "yes",
      };
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
  [
    "foreign-session",
    (data) => {
      if (data.owner.kind === "goal") data.owner.goal.sessionId = "foreign";
    },
  ],
  [
    "missing-source",
    (data) => {
      data.sourceRef.entryId = "missing";
    },
  ],
  [
    "wrong-source-digest",
    (data) => {
      data.sourceRef.digest = "0".repeat(64);
    },
  ],
  [
    "wrong-definition-digest",
    (data) => {
      data.definitionDigest = "0".repeat(64);
    },
  ],
  [
    "duplicate-frozen-path",
    (data) => {
      data.frozenFiles = [...data.frozenFiles, ...data.frozenFiles];
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
  [
    "wrong-checker-inventory",
    (data) => {
      if (data.spec.kind === "automatic") data.spec.checkerFiles = ["not-captured.mjs"];
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
  [
    "wrong-execution-environment",
    (data) => {
      data.environmentDigest = "0".repeat(64);
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
  [
    "manual-with-process",
    (data) => {
      data.spec = {
        kind: "manual",
        checkId: "manual",
        requirementIds: ["declared-check"],
        question: "Actual manual condition",
        response: { kind: "choice", options: ["yes", "no"] },
        expectedValue: "yes",
      };
      data.definitionDigest = acceptanceDefinitionDigest(data);
    },
  ],
];
it.each(definitions)("refuses native definition %s", (name, mutate) => {
  void name;
  const item = prefix<AcceptanceDefinitionFact>("acceptance-definition-declared");
  mutate(item.data);
  expect(() => load(item.rows)).toThrow();
});
const contracts: Array<[string, (data: AcceptanceBoundFact) => void]> = [
  [
    "wrong-contract-digest",
    (data) => {
      data.contractDigest = "0".repeat(64);
    },
  ],
  [
    "missing-definition-ref",
    (data) => {
      for (const item of data.definitions) item.ref.entryId = "missing";
    },
  ],
  [
    "wrong-definition-digest",
    (data) => {
      for (const item of data.definitions) item.definitionDigest = "0".repeat(64);
    },
  ],
  [
    "wrong-native-definition-name",
    (data) => {
      for (const item of data.definitions) item.checkId = "other";
    },
  ],
  [
    "unsupported-revision",
    (data) => {
      data.revision = 2;
      data.contractDigest = acceptanceContractDigest(data);
    },
  ],
  [
    "wrong-native-workspace",
    (data) => {
      data.workspace.root = "/tmp/owned-p7-other";
      data.contractDigest = acceptanceContractDigest(data);
    },
  ],
  [
    "missing-required-mapping",
    (data) => {
      data.header.requirements = data.header.requirements.map((item) => ({
        ...item,
        requirementId: "uncovered",
      }));
      data.contractDigest = acceptanceContractDigest(data);
    },
  ],
  [
    "changed-profile",
    (data) => {
      data.header.environment.values = { LANG: "C" };
      data.contractDigest = acceptanceContractDigest(data);
    },
  ],
  [
    "unsafe-input",
    (data) => {
      data.header.inputs = ["../foreign"];
      data.contractDigest = acceptanceContractDigest(data);
    },
  ],
  [
    "too-many-required-conditions",
    (data) => {
      data.header.requirements = Array.from({ length: 17 }, (_, i) => ({
        requirementId: `r${i}`,
        source: "original spec",
        text: "Required condition",
        required: true,
      }));
    },
  ],
];
it.each(contracts)("refuses native contract %s", (name, mutate) => {
  void name;
  const item = prefix<AcceptanceBoundFact>("acceptance-contract-bound");
  mutate(item.data);
  expect(() => load(item.rows)).toThrow();
});
const starts: Array<[string, (data: AcceptanceCheckStarted) => void]> = [
  [
    "missing-contract",
    (data) => {
      data.contractRef.entryId = "missing";
    },
  ],
  [
    "wrong-contract-hash",
    (data) => {
      data.contractRef.digest = "0".repeat(64);
    },
  ],
  [
    "missing-definition",
    (data) => {
      data.definitionRef.entryId = "missing";
    },
  ],
  [
    "missing-invocation",
    (data) => {
      data.invocationRef.entryId = "missing";
    },
  ],
  [
    "wrong-actual-call",
    (data) => {
      data.callId = "not-the-actual-call";
    },
  ],
  [
    "wrong-scope",
    (data) => {
      data.scopeDigest = "0".repeat(64);
    },
  ],
  [
    "wrong-original-source",
    (data) => {
      data.sourceRef.digest = "0".repeat(64);
    },
  ],
];
it.each(starts)("refuses native run admission %s", (name, mutate) => {
  void name;
  const item = prefix<AcceptanceCheckStarted>("acceptance-check-started");
  mutate(item.data);
  expect(() => load(item.rows)).toThrow();
});
it("does not re-admit an already started actual call under a new run ID", () => {
  const item = prefix<AcceptanceCheckStarted>("acceptance-check-started");
  item.rows.push({
    ...structuredClone(item.row),
    id: "invalid-duplicate",
    parentId: item.row.id,
    data: { ...item.data, recordId: "other-record", runId: "another-run" },
  });
  expect(() => load(item.rows)).toThrow();
});
const observations: Array<[string, (data: AcceptanceCheckObserved) => void]> = [
  [
    "missing-start",
    (data) => {
      data.startedRef.entryId = "missing";
    },
  ],
  [
    "wrong-run-identity",
    (data) => {
      data.runId = "different";
    },
  ],
  [
    "wrong-actual-invocation",
    (data) => {
      data.invocation.cwd = "/tmp/owned-p7-other";
    },
  ],
  [
    "closed-unknown",
    (data) => {
      data.termination = "unknown";
    },
  ],
  [
    "missing-source",
    (data) => {
      data.sourceRef.entryId = "missing";
    },
  ],
];
it.each(observations)("refuses native observation %s", (name, mutate) => {
  void name;
  const item = prefix<AcceptanceCheckObserved>("acceptance-check-observed");
  mutate(item.data);
  expect(() => load(item.rows)).toThrow();
});
it("retains unclosed actual-check metadata as a safety reference instead of discarding it", () => {
  const item = prefix<AcceptanceCheckObserved>("acceptance-check-observed");
  item.data.closed = false;
  item.data.termination = "unknown";
  item.data.exitCode = null;
  const view = load(item.rows);
  expect(acceptanceRunActivityIssue(view.acceptance, sessionId)).toContain("unclosed/unknown");
});
const reviews: Array<[string, (data: AcceptanceReviewBound) => void]> = [
  [
    "missing-attempt",
    (data) => {
      data.reviewStartedRef.entryId = "missing";
    },
  ],
  [
    "wrong-contract",
    (data) => {
      data.contractRef.entryId = "missing";
    },
  ],
  [
    "wrong-board",
    (data) => {
      data.boardDigest = "0".repeat(64);
    },
  ],
  [
    "wrong-bindings",
    (data) => {
      data.bindingsDigest = "0".repeat(64);
    },
  ],
  [
    "wrong-epoch",
    (data) => {
      data.epoch++;
    },
  ],
  [
    "expired-version",
    (data) => {
      data.versionId = "0".repeat(64);
    },
  ],
  [
    "expired-generation",
    (data) => {
      data.inputGeneration = "0".repeat(64);
    },
  ],
  [
    "missing-observation",
    (data) => {
      data.observations = [{ entryId: "missing", digest: "0".repeat(64) }];
    },
  ],
  [
    "empty-observations",
    (data) => {
      data.observations = [];
    },
  ],
];
it.each(reviews)("refuses sealed contract-review material %s", (name, mutate) => {
  void name;
  const item = prefix<AcceptanceReviewBound>("acceptance-review-bound");
  mutate(item.data);
  expect(() => load(item.rows)).toThrow();
});
it.each([
  "missing-end",
  "cancelled-end",
  "nonzero-end",
  "missing-receipt-ref",
  "future-end",
  "wrong-receipt-id",
  "missing-seal",
  "future-seal",
  "unqualified-seal",
])("refuses an incomplete source-qualified invocation projection: %s", (kind) => {
  const item = prefix<AcceptanceReviewBound>("acceptance-review-bound"),
    actual = journal(item.rows),
    view = readControlFences(actual),
    graph = structuredClone(view.invocations);
  if (!graph) throw Error("Actual native invocation graph unavailable");
  const run = view.acceptance?.runs[0],
    node = [...graph.nodes.values()].find((value) => value.toolCallId === run?.start.data.callId);
  if (!node?.end) throw Error("Actual native ended check missing");
  const end = node.end;
  if (kind === "missing-end") node.end = undefined;
  if (kind === "cancelled-end") end.outcome = "cancelled";
  if (kind === "nonzero-end") end.exitCode = 7;
  if (kind === "missing-receipt-ref") end.receiptRef = null;
  if (kind === "future-end") end.ref.entryId = "missing";
  if (kind === "wrong-receipt-id") end.receiptId = "wrong";
  if (kind === "missing-seal") graph.seals.delete(node.rootId);
  if (kind === "future-seal") {
    const seal = graph.seals.get(node.rootId);
    if (!seal) throw Error("Seal missing");
    seal.ref.entryId = "future";
  }
  if (kind === "unqualified-seal") {
    const seal = graph.seals.get(node.rootId);
    if (!seal) throw Error("Seal missing");
    seal.data.outcome = "held";
  }
  const records = actual.branch.filter(
    (value) => value.customType === "continuous-tasks:acceptance-facts",
  );
  // Consumer-boundary NEGATIVE projection, not a reconstructed positive proof.
  expect(() => readAcceptanceFacts(actual, records, graph)).toThrow();
});
it.each(["missing-proof", "failed-host", "unknown-exit", "nonzero-host", "wrong-tool", "wrong-id"])(
  "requires the original host receipt, not just its invocation aggregate: %s",
  (kind) => {
    const item = prefix<AcceptanceReviewBound>("acceptance-review-bound"),
      actual = journal(item.rows),
      view = readControlFences(actual),
      graph = view.invocations,
      run = view.acceptance?.runs[0];
    const check =
        graph &&
        [...graph.nodes.values()].find((node) => node.toolCallId === run?.start.data.callId),
      ref = check?.end?.receiptRef,
      entry = ref && actual.nodes.get(ref.entryId);
    if (!graph || !entry?.receiptProof?.receipt) throw Error("Actual original host proof missing");
    const proof = structuredClone(entry.receiptProof),
      receipt = proof.receipt,
      nodes = new Map(actual.nodes);
    if (!receipt) throw Error("Cloned negative source projection missing");
    if (kind === "failed-host") receipt.ok = false;
    if (kind === "unknown-exit") receipt.exitCode = undefined;
    if (kind === "nonzero-host") receipt.exitCode = 7;
    if (kind === "wrong-tool") receipt.tool = "not-run-check";
    if (kind === "wrong-id") receipt.id = "not-original";
    nodes.set(entry.id, {
      ...entry,
      receiptProof: kind === "missing-proof" ? undefined : proof,
    });
    const records = actual.branch.filter(
      (node) => node.customType === "continuous-tasks:acceptance-facts",
    );
    expect(() => readAcceptanceFacts({ ...actual, nodes }, records, graph)).toThrow();
  },
);
it.each(["late-write", "unclosed-write", "unlocated-write-end"])(
  "retains the independent source writer barrier: %s",
  (kind) => {
    const item = prefix<AcceptanceReviewBound>("acceptance-review-bound"),
      actual = journal(item.rows),
      view = readControlFences(actual),
      graph = structuredClone(view.invocations),
      run = view.acceptance?.runs[0];
    const check =
        graph &&
        [...graph.nodes.values()].find((node) => node.toolCallId === run?.start.data.callId),
      writer =
        graph &&
        [...graph.nodes.values()].find(
          (node) =>
            node.effect === "metadata" && node.start.sequence > (check?.end?.sequence ?? Infinity),
        );
    if (!graph || !writer?.end) throw Error("Actual later metadata boundary unavailable");
    writer.effect = "write";
    if (kind === "unclosed-write") writer.end = undefined;
    if (kind === "unlocated-write-end" && writer.end) writer.end.ref.entryId = "missing";
    expect(() =>
      readAcceptanceFacts(
        actual,
        actual.branch.filter((node) => node.customType === "continuous-tasks:acceptance-facts"),
        graph,
      ),
    ).toThrow();
  },
);
it("rejects missing/duplicate/unlisted records at the public source reducer without minting authority", () => {
  const item = prefix<AcceptanceReviewBound>("acceptance-review-bound"),
    actual = journal(item.rows),
    graph = readControlFences(actual).invocations,
    records = actual.branch.filter(
      (value) => value.customType === "continuous-tasks:acceptance-facts",
    ),
    first = records[0];
  if (!first) throw Error("Actual fact missing");
  expect(() => readAcceptanceFacts(actual, [...records, first], graph)).toThrow();
  expect(() =>
    readAcceptanceFacts(actual, [{ ...first, id: "not-in-physical-branch" }], graph),
  ).toThrow();
  expect(() => readAcceptanceFacts(actual, [{ ...first, data: null }], graph)).toThrow();
  expect(() => readAcceptanceFacts(actual, records, undefined)).toThrow();
});
const failedHistory: Array<[string, (data: AcceptanceCheckObserved) => void]> = [
  [
    "unclosed",
    (data) => {
      data.closed = false;
      data.termination = "unknown";
      data.exitCode = null;
    },
  ],
  [
    "timeout",
    (data) => {
      data.termination = "timed_out";
      data.exitCode = null;
    },
  ],
  [
    "cancelled",
    (data) => {
      data.termination = "cancelled";
      data.exitCode = null;
    },
  ],
  [
    "nonzero",
    (data) => {
      data.exitCode = 7;
    },
  ],
  [
    "missing-result",
    (data) => {
      data.result = null;
    },
  ],
  [
    "changed-output-version",
    (data) => {
      data.afterVersionId = "0".repeat(64);
    },
  ],
  [
    "changed-output-generation",
    (data) => {
      data.afterGeneration = "0".repeat(64);
    },
  ],
  [
    "failed-required-case",
    (data) => {
      if (data.result) {
        data.result.requiredCases = { input: "failed" };
        data.result.passed = 0;
        data.result.failed = 1;
      }
    },
  ],
];
it.each(failedHistory)(
  "never seals %s check history even with rehashed observation references",
  (name, mutate) => {
    const item = prefix<AcceptanceReviewBound>("acceptance-review-bound"),
      row = item.rows.find(
        (value) =>
          (value.data as { kind?: string } | undefined)?.kind === "acceptance-check-observed",
      );
    if (!row) throw Error("Original actual observation unavailable");
    const data = row.data as AcceptanceCheckObserved;
    mutate(data);
    // Negative internally rehashed forgery: not a new native producer or success.
    item.data.observations = item.data.observations.map((ref) =>
      ref.entryId === row.id ? { entryId: row.id, digest: journalDigest(row) } : ref,
    );
    expect(() => load(item.rows.slice(0, -1)), `${name} preceding group`).not.toThrow();
    expect(() => load(item.rows), name).toThrow();
  },
);
