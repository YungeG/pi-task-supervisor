import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findGoalReadbackProof, inspectSessionJournal, journalDigest } from "../human-journal";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("closes a goal-frame2 witness against the actual old checkpoint entry without hydrating its receipt body", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-native-proof-"));
  dirs.push(dir);
  const path = join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id: "test-session" };
  const base = {
    type: "custom",
    id: "base",
    parentId: null,
    customType: "continuous-tasks:supervisor",
    data: {
      version: 3,
      sessionId: header.id,
      status: "stopped",
      receipts: [],
      goal: "Synthetic history",
    },
  };
  const frame = {
    version: 2,
    owner: "goal",
    sessionId: header.id,
    requestId: "transition",
    presentationId: "screen",
    scopeDigest: "a".repeat(64),
    baseEntryId: base.id,
    baseEntryDigest: journalDigest(base),
  };
  const control = {
    type: "custom",
    id: "answer",
    parentId: base.id,
    customType: "continuous-tasks:supervisor",
    data: {
      version: 5,
      protocol: "goal-lifecycle-v1",
      kind: "transition-control",
      transitionId: "transition",
      humanInteraction: frame,
    },
  };
  const witness = {
    type: "custom",
    id: "witness",
    parentId: control.id,
    customType: "continuous-tasks:human-readback",
    data: { version: 1, controlEntryId: control.id, controlDigest: journalDigest(control), frame },
  };
  writeFileSync(
    path,
    [header, base, control, witness].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  const journal = inspectSessionJournal({ path, sessionId: header.id, leafId: witness.id });
  const proof = findGoalReadbackProof(journal, "transition");
  expect(proof.status).toBe("confirmed");
  if (proof.status === "confirmed") {
    expect(proof.base.id).toBe("base");
    expect(proof.control.id).toBe("answer");
    expect(proof.witness.id).toBe("witness");
  }
  expect(journal.nodes.get(base.id)?.data).toBeUndefined();
});
