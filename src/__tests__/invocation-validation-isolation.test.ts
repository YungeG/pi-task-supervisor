// Controlled failed append of an actual producer's next fact. This is a negative isolation
// probe, not a new successful invocation/receipt/qualification.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, expect, it } from "vitest";
import { currentRuntime } from "../runtime";
import { resetState, setBoard } from "../state";
import { appendControlFact, readControlJournal, type ControlFact } from "../control-journal";
import { isValidSnapshotV2 } from "../validation";
import { createMockAPI, createMockContext } from "./helpers/mocks";
interface Row {
  id: string;
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
}
const lines = readFileSync(
    fileURLToPath(new URL("./fixtures/codemode-only-sdk.jsonl", import.meta.url)),
    "utf8",
  )
    .trimEnd()
    .split("\n"),
  rows = lines.map((line) => JSON.parse(line) as Row);
const root = rows.find(
  (row) => row.data?.kind === "invocation-started" && row.data.toolCallId === "owned-work-root",
)!.data!.operationId;
const check = rows.find(
  (row) => row.data?.kind === "invocation-started" && row.data.toolName === "owned_check",
)!.data!.operationId;
beforeEach(() => {
  resetState();
});
it.each([
  "invocation-started",
  "invocation-ended",
  "invocation-root-sealed",
  "eligibility-attested",
])("a failed %s candidate cannot mutate the verified private prefix", (kind) => {
  const index = rows.findIndex(
    (row) =>
      row.data?.kind === kind &&
      (kind === "invocation-started"
        ? row.data.operationId === root
        : kind === "invocation-ended"
          ? row.data.operationId === check
          : kind === "invocation-root-sealed"
            ? row.data.rootId === root
            : true),
  );
  if (index < 1) throw Error("Owned producer next fact missing");
  const dir = mkdtempSync(join(tmpdir(), "owned-invocation-isolation-")),
    file = join(dir, "prefix.jsonl");
  writeFileSync(file, lines.slice(0, index).join("\n") + "\n");
  let passed = false;
  try {
    const ctx = createMockContext(),
      mock = createMockAPI(),
      manager = SessionManager.open(file);
    Object.assign(ctx, { sessionManager: manager });
    const runtime = currentRuntime();
    runtime.controlJournal = readControlJournal(ctx);
    const mode = runtime.controlJournal.modeRecords!.at(-1)!;
    runtime.management = {
      mode: mode.data.mode,
      state: mode.data.state,
      record: mode,
      activeWorkOwner: mode.data.activeWorkOwner,
      lastGoal: mode.data.lastGoal,
      attention: mode.data.attention,
      source: "confirmed",
    };
    const snapshot = [...rows.slice(0, index)]
      .reverse()
      .find((row) => row.customType === "continuous-tasks:snapshot")?.data;
    if (!isValidSnapshotV2(snapshot)) throw Error("Owned snapshot missing");
    setBoard(structuredClone(snapshot));
    const before = readControlJournal(ctx),
      bytes = readFileSync(file, "utf8");
    mock.appendEntry.mockImplementation(() => {
      throw Error("Owned failure before opaque append confirmation");
    });
    expect(() =>
      appendControlFact(
        mock.api,
        ctx,
        structuredClone(rows[index]!.data) as unknown as ControlFact,
      ),
    ).toThrow("CONTROL_JOURNAL_UNCERTAIN");
    expect(mock.appendEntry).toHaveBeenCalledTimes(1);
    expect(runtime.journalFault).toMatch(/inspect before further mutation/);
    expect(readControlJournal(ctx)).toEqual(before);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    passed = true;
  } finally {
    if (passed) rmSync(dir, { recursive: true, force: true });
    else console.error("Owned invocation isolation failure retained:", dir);
  }
});
