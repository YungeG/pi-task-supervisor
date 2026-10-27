// Mutations are negative codec probes, never invented positive observations/receipts.
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSessionJournal } from "../human-journal";
import { readControlFences } from "../control-journal";
import { ownedCodemode } from "./helpers/owned-codemode";
interface OwnedRow {
  id: string;
  type: string;
  customType?: string;
  data?: Record<string, unknown>;
}
let lines: string[], rows: OwnedRow[], workId: string, checkId: string;
beforeAll(async () => {
  lines = (await ownedCodemode("normal")).source.trimEnd().split("\n");
  rows = lines.map((line) => JSON.parse(line) as OwnedRow);
  const work = rows.find(
      (row) => row.data?.kind === "invocation-started" && row.data.toolCallId === "owned-work",
    ),
    check = rows.find(
      (row) => row.data?.kind === "invocation-started" && row.data.toolName === "owned_check",
    );
  if (!work || !check) throw Error("Actual owned producer is missing native start facts");
  workId = String(work.data?.operationId);
  checkId = String(check.data?.operationId);
}, 20000);
type Mutation = [string, string, (data: Record<string, unknown>) => void, string?];
const badDigest = "0".repeat(64);
const cases: Mutation[] = [
  [
    "invocation-started",
    "wrong actual assistant call",
    (d) => {
      d.toolCallId = "invented";
    },
  ],
  [
    "invocation-started",
    "missing root source",
    (d) => {
      d.sourceRef = null;
    },
  ],
  [
    "invocation-started",
    "wrong input digest",
    (d) => {
      d.inputDigest = badDigest;
    },
  ],
  [
    "invocation-started",
    "cyclic own parent",
    (d) => {
      d.parentId = d.operationId;
    },
  ],
  [
    "invocation-started",
    "wrong root",
    (d) => {
      d.rootId = "foreign-root";
    },
    "Invocation root does not match its actual parent",
  ],
  [
    "invocation-started",
    "unmatched management reference",
    (d) => {
      d.modeRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "invocation-started",
    "metadata container lie",
    (d) => {
      d.effect = "metadata";
    },
  ],
  [
    "invocation-started",
    "skipped sequence",
    (d) => {
      d.sequence = 900000;
    },
    "Invocation sequence is not the next actual host observation",
  ],
  [
    "invocation-ended",
    "wrong operation",
    (d) => {
      d.operationId = "unknown";
    },
  ],
  [
    "invocation-ended",
    "wrong receipt identity",
    (d) => {
      d.receiptId = "tool:invented";
    },
  ],
  [
    "invocation-ended",
    "wrong receipt digest",
    (d) => {
      d.receiptDigest = badDigest;
    },
  ],
  [
    "invocation-ended",
    "wrong receipt source",
    (d) => {
      d.receiptRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "invocation-ended",
    "changed actual exit",
    (d) => {
      d.exitCode = 7;
    },
  ],
  [
    "invocation-ended",
    "skipped end sequence",
    (d) => {
      d.sequence = 900000;
    },
    "Invocation sequence is not the next actual host observation",
  ],
  [
    "invocation-root-sealed",
    "unseen root",
    (d) => {
      d.rootId = "unknown";
    },
  ],
  [
    "invocation-root-sealed",
    "wrong start aggregate",
    (d) => {
      d.started = Number(d.started) + 1;
    },
    "Invocation seal does not match the complete causal journal aggregate",
  ],
  [
    "invocation-root-sealed",
    "wrong end aggregate",
    (d) => {
      d.ended = Number(d.ended) + 1;
    },
    "Invocation seal does not match the complete causal journal aggregate",
  ],
  [
    "invocation-root-sealed",
    "wrong causal history",
    (d) => {
      d.historyDigest = badDigest;
    },
    "Invocation seal does not match the complete causal journal aggregate",
  ],
  [
    "invocation-root-sealed",
    "wrong kernel end",
    (d) => {
      d.endRef = { entryId: "unknown", digest: badDigest };
    },
    "Invocation seal does not match the complete causal journal aggregate",
  ],
  [
    "invocation-root-sealed",
    "wrong actual result message",
    (d) => {
      d.messageRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "invocation-root-sealed",
    "wrong ledger epoch",
    (d) => {
      d.epoch = 900000;
    },
  ],
  [
    "invocation-root-sealed",
    "positive seal without version",
    (d) => {
      d.artifactVersion = null;
    },
  ],
  [
    "eligibility-attested",
    "wrong original receipt",
    (d) => {
      d.receiptId = "tool:invented";
    },
  ],
  [
    "eligibility-attested",
    "wrong receipt digest",
    (d) => {
      d.receiptDigest = badDigest;
    },
  ],
  [
    "eligibility-attested",
    "wrong reviewed task",
    (d) => {
      d.taskDigest = badDigest;
    },
  ],
  [
    "eligibility-attested",
    "wrong seal reference",
    (d) => {
      d.rootSealRef = { entryId: "unknown", digest: badDigest };
    },
    "Eligibility is not bound to its actual qualified owner/root seal",
  ],
  [
    "eligibility-attested",
    "wrong current epoch",
    (d) => {
      d.epoch = 900000;
    },
    "Eligibility is not bound to its actual qualified owner/root seal",
  ],
  [
    "completion-intent-queued",
    "wrong task review digest",
    (d) => {
      d.taskDigest = badDigest;
    },
  ],
  [
    "completion-intent-queued",
    "unseen root",
    (d) => {
      d.rootId = "unknown";
    },
  ],
  [
    "completion-intent-queued",
    "wrong confirmed snapshot",
    (d) => {
      d.snapshotRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "completion-intent-queued",
    "unknown original receipts",
    (d) => {
      d.receipts = [{ id: "tool:invented", digest: badDigest }];
    },
  ],
  [
    "completion-intent-disposed",
    "wrong intent identity",
    (d) => {
      d.intentId = "unknown";
    },
  ],
  [
    "completion-intent-disposed",
    "wrong original intent reference",
    (d) => {
      d.intentRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "completion-intent-disposed",
    "wrong confirmed done snapshot",
    (d) => {
      d.snapshotRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "completion-intent-disposed",
    "wrong actual binding checkpoint",
    (d) => {
      d.supervisorRef = { entryId: "unknown", digest: badDigest };
    },
  ],
  [
    "completion-intent-disposed",
    "wrong actual done digest",
    (d) => {
      d.taskDigest = badDigest;
    },
  ],
];
function target(kind: string): number {
  return rows.findIndex(
    (row) =>
      row.data?.kind === kind &&
      (kind === "invocation-started"
        ? row.data.operationId === workId
        : kind === "invocation-ended"
          ? row.data.operationId === checkId
          : kind === "invocation-root-sealed"
            ? row.data.rootId === workId
            : true),
  );
}
describe("strict actual-producer invocation/completion prefix validation", () => {
  it.each(cases)("rejects %s: %s", (kind, _name, mutate, expectedError) => {
    const index = target(kind),
      row = rows[index];
    if (!row?.data) throw Error("Owned source has no target fact");
    const dir = mkdtempSync(join(tmpdir(), "owned-invocation-wire-")),
      path = join(dir, "prefix.jsonl"),
      view = { path, sessionId: rows[0]!.id, leafId: row.id };
    let passed = false;
    try {
      writeFileSync(path, lines.slice(0, index + 1).join("\n") + "\n");
      expect(() => readControlFences(inspectSessionJournal(view))).not.toThrow();
      const altered = structuredClone(row);
      if (!altered.data) throw Error("Missing owned data");
      mutate(altered.data);
      writeFileSync(path, [...lines.slice(0, index), JSON.stringify(altered)].join("\n") + "\n");
      expect(() => readControlFences(inspectSessionJournal(view))).toThrow(
        expectedError ?? /CONTROL_FORMAT_INVALID|CONTROL_FACT_UNSUPPORTED/,
      );
      passed = true;
    } finally {
      if (passed) rmSync(dir, { recursive: true, force: true });
      else console.error("Owned negative wire failure retained:", dir);
    }
  });
});
