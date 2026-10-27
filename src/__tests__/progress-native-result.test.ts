import { expect, it } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSessionJournal, type SessionJournal, type JournalNode } from "../human-journal";
import { readControlFences, type ProgressObserved } from "../control-journal";
import { currentRuntime } from "../runtime";
import { cachedProgressSummary } from "../progress-facts";
import { resetState } from "../state";
const file = fileURLToPath(new URL("./fixtures/progress-task-only-sdk.jsonl", import.meta.url));
// Frozen bytes from the owned real SDK --progress-tasks producer; not invented evidence.
const bytes = readFileSync(file);
const rows = bytes
  .toString("utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
function load(path = file): SessionJournal {
  return inspectSessionJournal({ path, sessionId: rows[0].id, leafId: rows.at(-1).id });
}
function source(journal: SessionJournal): JournalNode {
  const node = journal.branch.find((n) => n.toolResultProof?.tool === "edit_smoke_progress");
  if (!node) throw Error("Actual SDK result source missing");
  return node;
}
it("reads actual task-only SDK native results and preserves all four causal progress facts", () => {
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "ee4f614f9db4b7a1d517f09e84953414516076add0fcd0691544a364a201729b",
  );
  const journal = load(),
    view = readControlFences(journal);
  const observed = view.progressFacts?.filter((row) => row.data.kind === "progress-observed");
  expect(observed).toHaveLength(4);
  expect(
    observed?.every(
      (row) =>
        row.data.kind === "progress-observed" &&
        row.data.sourceKind === "native-result" &&
        row.data.owner.kind === "board",
    ),
  ).toBe(true);
  expect(source(journal).toolResultProof).toMatchObject({ ok: true });
  // SDK 1.1.0 persists isError, but not the structured exit field from this custom result.
  expect(source(journal).toolResultProof?.exitCode).toBeUndefined();
});
it("projects actual cached board progress without hydration, and hides a mismatched cached owner", () => {
  resetState();
  try {
    const runtime = currentRuntime(),
      view = readControlFences(load());
    runtime.controlJournal = view;
    expect(cachedProgressSummary()?.credited).toBe(4);
    const seed = runtime.controlJournal.boardOwner;
    if (!seed) throw Error("Actual SDK board owner missing");
    seed.board.seedEntryId = "foreign-cache-owner";
    expect(cachedProgressSummary()).toBeUndefined();
    runtime.controlJournal = undefined;
    expect(cachedProgressSummary()).toBeUndefined();
  } finally {
    resetState();
  }
});
it("rejects native result/call ambiguity, failed effects, missing proof and changed causal outcomes", () => {
  const mutations: Array<(j: SessionJournal) => void> = [
    (j) => {
      delete source(j).toolResultProof;
    },
    (j) => {
      const proof = source(j).toolResultProof;
      if (proof) proof.id = "wrong-result";
    },
    (j) => {
      const proof = source(j).toolResultProof;
      if (proof) proof.tool = "wrong-tool";
    },
    (j) => {
      const proof = source(j).toolResultProof;
      if (proof) proof.ok = false;
    },
    (j) => {
      const proof = source(j).toolResultProof;
      if (proof) proof.exitCode = 1;
    },
    (j) => {
      for (const node of j.branch)
        if (node.toolCalls?.some((call) => call.name === "edit_smoke_progress"))
          node.toolCalls = [];
    },
    (j) => {
      const node = j.branch.find((row) =>
        row.toolCalls?.some((call) => call.name === "edit_smoke_progress"),
      );
      if (node?.toolCalls?.[0]) node.toolCalls.push(structuredClone(node.toolCalls[0]));
    },
    (j) => {
      const node = j.branch.find((row) =>
        row.toolCalls?.some((call) => call.name === "edit_smoke_progress"),
      );
      if (node?.toolCalls?.[0]) node.toolCalls[0].name = "wrong-tool";
    },
    (j) => {
      const node = j.branch.find(
        (row) =>
          row.customType === "continuous-tasks:control-facts" &&
          (row.data as { kind: string }).kind === "progress-observed",
      );
      if (node) (node.data as ProgressObserved).result = "failure";
    },
    (j) => {
      const node = j.branch.find(
        (row) =>
          row.customType === "continuous-tasks:control-facts" &&
          (row.data as { kind: string }).kind === "progress-observed",
      );
      if (node) (node.data as ProgressObserved).sourceKind = "receipt";
    },
  ];
  for (const mutate of mutations) {
    const journal = structuredClone(load());
    mutate(journal);
    expect(() => readControlFences(journal)).toThrow();
  }
});
it.each(["no-status", "bad-exit", "nonzero", "empty-id", "long-id", "empty-name", "long-name"])(
  "bounds native %s metadata without assuming success",
  (kind) => {
    const dir = mkdtempSync(join(tmpdir(), "owned-progress-native-metadata-"));
    try {
      const changed = structuredClone(rows);
      const row = changed.find(
        (n) => n.message?.role === "toolResult" && n.message.toolName === "edit_smoke_progress",
      );
      if (kind === "no-status") delete row.message.isError;
      if (kind === "bad-exit") row.message.structuredContent = { exit_code: "0" };
      if (kind === "nonzero") row.message.structuredContent = { exit_code: 1 };
      if (kind === "empty-id") row.message.toolCallId = "";
      if (kind === "long-id") row.message.toolCallId = "x".repeat(2001);
      if (kind === "empty-name") row.message.toolName = "";
      if (kind === "long-name") row.message.toolName = "x".repeat(201);
      const path = join(dir, "metadata.jsonl");
      writeFileSync(path, changed.map((n) => JSON.stringify(n)).join("\n") + "\n");
      const node = load(path).nodes.get(row.id);
      if (["no-status", "bad-exit", "nonzero"].includes(kind))
        expect(node?.toolResultProof?.ok).toBe(false);
      else expect(node?.toolResultProof).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
