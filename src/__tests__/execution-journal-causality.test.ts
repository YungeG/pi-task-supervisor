import { expect, it } from "vitest";
import { executionRegistryFixture } from "./helpers/execution-registry";
import { currentRuntime } from "../runtime";
import { getBoard } from "../state";
import { journalDigest } from "../human-journal";
import {
  appendControlFact,
  ControlJournalError,
  type ExecutionObservedFact,
} from "../control-journal";
import { observeExecutionSettlement } from "../execution-settlement";

it.each([
  "missing-snapshot",
  "snapshot-kind",
  "snapshot-digest",
  "board-digest",
  "foreign-carrier",
  "missing-task",
  "task-digest",
  "unverified-import",
  "unimported-reference",
  "duplicate-record",
  "duplicate-binding",
  "foreign-owner",
  "unsupported-version",
  "extra-proof",
])("rejects a %s binding before writing a control fact", async (kind) => {
  const f = await executionRegistryFixture();
  try {
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    const entry = currentRuntime().controlJournal?.executionRegistry?.[0];
    if (!entry) throw Error("Missing real binding");
    const data = structuredClone(entry.binding.data);
    data.recordId = "new-record";
    data.bindingId = "new-binding";
    switch (kind) {
      case "missing-snapshot":
        data.beforeSnapshotRef.entryId = "missing-native-source";
        break;
      case "snapshot-kind": {
        const source = f
          .entries()
          .find((entry) => entry.customType === "continuous-tasks:supervisor")!;
        data.beforeSnapshotRef = { entryId: source.id, digest: journalDigest(source) };
        break;
      }
      case "snapshot-digest":
        data.beforeSnapshotRef.digest = "0".repeat(64);
        break;
      case "board-digest":
        data.beforeBoardDigest = "0".repeat(64);
        break;
      case "foreign-carrier":
        data.beforeSnapshotRef = { entryId: f.oldEntry.id, digest: journalDigest(f.oldEntry) };
        data.beforeBoardDigest = journalDigest(f.old);
        break;
      case "missing-task":
        data.taskId = "missing-task";
        break;
      case "task-digest":
        data.taskDigest = "0".repeat(64);
        break;
      case "unverified-import":
        data.imported = true;
        break;
      case "unimported-reference": {
        const board = getBoard();
        if (!entry.boundSnapshot || !board.tasks[0]) throw Error("Missing bound source");
        data.beforeSnapshotRef = entry.boundSnapshot;
        data.beforeBoardDigest = journalDigest(board);
        data.taskDigest = journalDigest(board.tasks[0]);
        break;
      }
      case "duplicate-record":
        data.recordId = entry.binding.data.recordId;
        break;
      case "duplicate-binding":
        data.bindingId = entry.binding.data.bindingId;
        break;
      case "foreign-owner":
        if (data.owner.kind === "goal") {
          data.owner.goal.goalKey = "foreign-run";
          data.owner.goal.goalRunId = "foreign-run";
        }
        break;
      case "unsupported-version":
        Reflect.set(data, "version", 2);
        break;
      case "extra-proof":
        Reflect.set(data, "proof", { claimed: true });
        break;
    }
    const count = f.entries().length;
    expect(() => appendControlFact(f.api, f.ctx, data)).toThrow(ControlJournalError);
    expect(f.entries()).toHaveLength(count);
    expect(currentRuntime().journalFault).toBeUndefined();
  } finally {
    f.close();
  }
});

it.each([
  "binding-entry",
  "binding-digest",
  "unknown-binding",
  "writer-unknown",
  "proof-missing",
  "generation-missing",
  "generation-conflict",
  "unverified-original-generation",
])("rejects a %s terminal observation without inventing causal proof", async (kind) => {
  const f = await executionRegistryFixture();
  try {
    if (kind === "unverified-original-generation") f.backend.generation = "";
    expect((await f.invoke("bind_execution")).isError).not.toBe(true);
    const entry = currentRuntime().controlJournal?.executionRegistry?.[0];
    if (!entry) throw Error("Missing real binding");
    f.backend.state = "complete";
    const observed = await observeExecutionSettlement(
      f.api,
      f.ctx,
      { taskId: "t-1.1", ...f.executionRef },
      AbortSignal.timeout(1000),
      entry.binding.data.generation ?? undefined,
    );
    const data: ExecutionObservedFact = {
      version: 1,
      kind: "execution-observation",
      recordId: "invalid-observation",
      owner: entry.binding.data.owner,
      bindingId: entry.binding.data.bindingId,
      bindingRef: { entryId: entry.binding.entryId, digest: entry.binding.digest },
      observation: observed,
    };
    switch (kind) {
      case "binding-entry":
        data.bindingRef.entryId = "missing-entry";
        break;
      case "binding-digest":
        data.bindingRef.digest = "0".repeat(64);
        break;
      case "unknown-binding":
        data.bindingId = "unknown-binding";
        break;
      case "writer-unknown":
        data.observation.writerEvidence = "unknown";
        break;
      case "proof-missing":
        delete data.observation.proofDigest;
        break;
      case "generation-missing":
        delete data.observation.generation;
        break;
      case "generation-conflict":
        data.observation.generation = {
          kind: "runner",
          runnerProcessInstanceId: "another-process",
        };
        break;
      case "unverified-original-generation":
        Object.assign(data.observation, {
          outcome: "success",
          writerEvidence: "observed",
          generation: { kind: "runner", runnerProcessInstanceId: "unproven-original" },
          proofDigest: "0".repeat(64),
        });
        break;
    }
    const count = f.entries().length;
    expect(() => appendControlFact(f.api, f.ctx, data)).toThrow();
    expect(f.entries()).toHaveLength(count);
    expect(currentRuntime().journalFault).toBeUndefined();
  } finally {
    f.close();
  }
});
