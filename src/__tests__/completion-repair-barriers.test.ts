// Negative metadata-repair seams use exact owned producer prefixes and actual SDK physical
// loading. Cache mutations / the missing-Q mutant are not new execution or eligibility proof.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { currentRuntime } from "../runtime";
import { resetState, setBoard } from "../state";
import { readControlJournal } from "../control-journal";
import {
  repairCompletionMetadata,
  finalizeCompletionIntentsAtBoundary,
} from "../completion-intents";
import { isValidSnapshotV2 } from "../validation";
import { createMockAPI, createMockContext } from "./helpers/mocks";

interface Row {
  id: string;
  parentId?: string | null;
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
}
const bytes = readFileSync(
    fileURLToPath(new URL("./fixtures/codemode-only-sdk.jsonl", import.meta.url)),
    "utf8",
  ),
  lines = bytes.trimEnd().split("\n"),
  original = lines.map((line) => JSON.parse(line) as Row);
const dirs: string[] = [];
beforeEach(() => {
  resetState();
});
afterEach((context) => {
  const paths = dirs.splice(0);
  if (context.task.result?.state === "fail" || context.task.result?.errors?.length) {
    console.error("Owned completion-repair failures retained:", paths);
    return;
  }
  for (const dir of paths) rmSync(dir, { recursive: true, force: true });
});
function ownedPrefix(kind: string) {
  const done = original.findIndex(
    (row) =>
      row.customType === "continuous-tasks:snapshot" &&
      isValidSnapshotV2(row.data) &&
      row.data.tasks[0]?.status === "done",
  );
  const queued = original.findIndex((row) => row.data?.kind === "completion-intent-queued");
  const rows = structuredClone(original.slice(0, (kind === "active" ? queued : done) + 1));
  if (kind === "missing-qualification") {
    const q = rows.findIndex((row) => row.data?.kind === "eligibility-attested");
    if (q < 1) throw Error("Owned qualification missing");
    const previous = rows[q - 1]!.id;
    rows.splice(q, 1);
    rows[q]!.parentId = previous;
  }
  const dir = mkdtempSync(join(tmpdir(), "owned-repair-barrier-"));
  dirs.push(dir);
  const path = join(dir, "prefix.jsonl");
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const ctx = createMockContext(),
    mock = createMockAPI(),
    manager = SessionManager.open(path);
  Object.assign(ctx, { sessionManager: manager });
  ctx.cwd = dir;
  const runtime = currentRuntime();
  runtime.controlJournal = readControlJournal(ctx);
  const entry = [...runtime.controlJournal.completionIntents!.values()][0]!;
  runtime.management = {
    mode: "supervised",
    state: "active",
    source: "volatile",
    activeWorkOwner: entry.data.owner,
    lastGoal: null,
    attention: [],
  };
  const snapshot = [...rows]
    .reverse()
    .find((row) => row.customType === "continuous-tasks:snapshot")?.data;
  if (!isValidSnapshotV2(snapshot)) throw Error("Owned native snapshot missing");
  setBoard(structuredClone(snapshot));
  return { runtime, ctx, mock, entry, path };
}
it.each([false, true])(
  "never advances an already-confirmed cold done snapshot again (runtime present: %s)",
  async (present) => {
    const h = ownedPrefix("done"),
      before = readFileSync(h.path, "utf8"),
      commit = vi.fn();
    if (present) h.runtime.invocation = { live: new Map(), results: new Map(), frames: new Map() };
    await expect(finalizeCompletionIntentsAtBoundary(h.mock.api, h.ctx, commit)).rejects.toThrow(
      /task changed; original intent is not reapplied/,
    );
    expect(commit).not.toHaveBeenCalled();
    expect(h.mock.appendEntry).not.toHaveBeenCalled();
    expect(readFileSync(h.path, "utf8")).toBe(before);
    if (present)
      expect(h.runtime.invocation?.attention).toContain("same-group binding/disposition repair");
  },
);
it.each([
  "missing-task",
  "not-done",
  "changed-task",
  "missing-supervisor",
  "missing-qualification",
  "active",
  "unknown-intent",
  "no-owner",
])("does not invent completion/binding through %s", (kind) => {
  const h = ownedPrefix(kind),
    before = readFileSync(h.path, "utf8");
  if (kind === "missing-task") h.runtime.board.tasks = [];
  if (kind === "not-done") h.runtime.board.tasks[0]!.status = "reviewing";
  if (kind === "changed-task") h.runtime.board.tasks[0]!.title = "Unconfirmed cache mutation";
  if (kind === "no-owner") h.runtime.management!.activeWorkOwner = null;
  const expected =
    kind === "missing-supervisor"
      ? /Original supervised completion owner is unavailable/
      : kind === "missing-qualification"
        ? /lacks its original sealed qualification/
        : kind === "active"
          ? /Actual invocation history remains active\/unknown/
          : kind === "unknown-intent" || kind === "no-owner"
            ? /actual intent in the current owner/
            : /no exact confirmed original done snapshot/;
  expect(() => {
    repairCompletionMetadata(
      h.mock.api,
      h.ctx,
      kind === "unknown-intent" ? "untrusted" : h.entry.data.intentId,
    );
  }).toThrow(expected);
  expect(h.mock.appendEntry).not.toHaveBeenCalled();
  expect(readFileSync(h.path, "utf8")).toBe(before);
});
