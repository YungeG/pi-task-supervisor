import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEntriesFromFile } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import {
  findReadbackProof,
  inspectSessionJournal,
  type JournalLimits,
  type ReadbackFrame,
  type SessionJournalView,
} from "../human-journal";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "human-journal-test-"));
  dirs.push(dir);
  return dir;
}

function fixture() {
  const dir = makeDir();
  const path = join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id: "test-session" };
  const base = {
    type: "custom",
    id: "base",
    parentId: null,
    customType: "continuous-tasks:snapshot",
    data: { version: 2, generation: 1 },
  };
  const frame: ReadbackFrame = {
    version: 1,
    owner: "board",
    sessionId: header.id,
    requestId: "request",
    presentationId: "presentation",
    scopeDigest: "a".repeat(64),
    baseSnapshotEntryId: base.id,
    baseSnapshotDigest: hash(base.data),
  };
  const control = {
    type: "custom",
    id: "control",
    parentId: base.id,
    customType: "continuous-tasks:event",
    data: { type: "resolve_decision", id: "request", answer: "approve", humanInteraction: frame },
  };
  return {
    path,
    header,
    base,
    frame,
    control,
    view: { path, sessionId: header.id, leafId: control.id } as SessionJournalView,
  };
}

function preflightFixture() {
  const dir = makeDir();
  const path = join(dir, "session.jsonl");
  const header = { type: "session", version: 3, id: "pf-session" };
  const base = {
    type: "custom",
    id: "pf-base",
    parentId: null,
    customType: "continuous-tasks:preflight",
    data: { version: 1, scope: "test" },
  };
  const frame: ReadbackFrame = {
    version: 1,
    owner: "preflight",
    sessionId: header.id,
    requestId: "pf-req",
    presentationId: "pf-pres",
    scopeDigest: "b".repeat(64),
    baseSnapshotEntryId: base.id,
    baseSnapshotDigest: hash(base.data),
  };
  const control = {
    type: "custom",
    id: "pf-control",
    parentId: base.id,
    customType: "continuous-tasks:preflight-control",
    data: { kind: "approve", humanInteraction: frame },
  };
  return {
    path,
    header,
    base,
    frame,
    control,
    view: { path, sessionId: header.id, leafId: control.id } as SessionJournalView,
  };
}

function writeJournal(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function expectCode(fn: () => unknown, code: string): void {
  expect(() => fn()).toThrow(expect.objectContaining({ code }));
}

describe("human readback evidence (not approval authority)", () => {
  it("retains verified disk evidence when the ordinary projection snapshot is absent", () => {
    const f = fixture();
    const witness = {
      type: "custom",
      id: "witness",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: f.control.id,
        controlDigest: hash(f.control),
        frame: f.frame,
      },
    };
    writeJournal(f.path, [f.header, f.base, f.control, witness]);
    const proof = findReadbackProof(
      inspectSessionJournal({ ...f.view, leafId: witness.id }),
      "board",
      "request",
    );
    expect(proof.status).toBe("confirmed");
    if (proof.status === "confirmed") {
      expect(proof.control.id).toBe("control");
      expect(proof.base.id).toBe("base");
      expect(proof.witness.id).toBe("witness");
    }
  });

  it("does not certify an orphan merely because the native loader repairs its missing LF", () => {
    const f = fixture();
    writeFileSync(
      f.path,
      [f.header, f.base, f.control].map((entry) => JSON.stringify(entry)).join("\n"),
    );
    expect(readFileSync(f.path).at(-1)).not.toBe(10);
    loadEntriesFromFile(f.path);
    expect(readFileSync(f.path).at(-1)).toBe(10);
    expect(findReadbackProof(inspectSessionJournal(f.view), "board", "request").status).toBe(
      "unconfirmed",
    );
  });
});

describe("journal file access errors", () => {
  it("returns JOURNAL_UNAVAILABLE when path is undefined", () => {
    expectCode(
      () => inspectSessionJournal({ path: undefined, sessionId: "x", leafId: null }),
      "JOURNAL_UNAVAILABLE",
    );
  });

  it("returns JOURNAL_UNAVAILABLE for a non-existent file", () => {
    const dir = makeDir();
    expectCode(
      () => inspectSessionJournal({ path: join(dir, "nope.jsonl"), sessionId: "x", leafId: null }),
      "JOURNAL_UNAVAILABLE",
    );
  });

  it("returns JOURNAL_UNAVAILABLE for a directory (non-regular file)", () => {
    const dir = makeDir();
    expectCode(
      () => inspectSessionJournal({ path: dir, sessionId: "x", leafId: null }),
      "JOURNAL_UNAVAILABLE",
    );
  });

  it("returns JOURNAL_UNAVAILABLE for a symlink (O_NOFOLLOW)", () => {
    const dir = makeDir();
    const real = join(dir, "real.jsonl");
    const link = join(dir, "link.jsonl");
    writeFileSync(real, '{"type":"session","version":3,"id":"x"}\n');
    symlinkSync(real, link);
    expectCode(
      () => inspectSessionJournal({ path: link, sessionId: "x", leafId: null }),
      "JOURNAL_UNAVAILABLE",
    );
  });
});

describe("journal content validation", () => {
  it("returns JOURNAL_INVALID for invalid UTF-8 bytes", () => {
    const dir = makeDir();
    const path = join(dir, "bad-utf8.jsonl");
    // 0xff 0xfe are invalid UTF-8 start bytes
    const buf = Buffer.from([0xff, 0xfe, 0x0a]);
    writeFileSync(path, buf);
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "x", leafId: null }),
      "JOURNAL_INVALID",
    );
  });

  it("returns JOURNAL_INVALID for malformed JSON", () => {
    const dir = makeDir();
    const path = join(dir, "bad-json.jsonl");
    writeFileSync(path, "{not valid json}\n");
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "x", leafId: null }),
      "JOURNAL_INVALID",
    );
  });

  it("returns JOURNAL_INVALID when header sessionId does not match view", () => {
    const dir = makeDir();
    const path = join(dir, "wrong-session.jsonl");
    writeJournal(path, [{ type: "session", version: 3, id: "other-session" }]);
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "expected-session", leafId: null }),
      "JOURNAL_INVALID",
    );
  });

  it("returns JOURNAL_INVALID when file has no trailing LF", () => {
    const f = fixture();
    // Write without trailing newline
    const content = [f.header, f.base, f.control].map((e) => JSON.stringify(e)).join("\n");
    expect(content.at(-1)).not.toBe("\n");
    writeFileSync(f.path, content);
    expectCode(() => inspectSessionJournal(f.view), "JOURNAL_INVALID");
  });

  it("returns JOURNAL_INVALID for duplicate entry IDs", () => {
    const f = fixture();
    const dup = {
      type: "custom",
      id: "base",
      parentId: null,
      customType: "continuous-tasks:snapshot",
      data: { version: 2, generation: 2 },
    };
    // Write header + base + dup(base) — dup should trigger JOURNAL_INVALID
    writeJournal(f.path, [f.header, f.base, dup]);
    expectCode(() => inspectSessionJournal({ ...f.view, leafId: null }), "JOURNAL_INVALID");
  });
});

describe("journal limits", () => {
  it("returns JOURNAL_LIMIT when file exceeds maxBytes", () => {
    const f = fixture();
    // Write a journal that's larger than 100 bytes
    writeJournal(f.path, [f.header, f.base, f.control]);
    const tinyLimits: JournalLimits = { maxBytes: 100, maxLineBytes: 1024, maxEntries: 1000 };
    expectCode(() => inspectSessionJournal(f.view, tinyLimits), "JOURNAL_LIMIT");
  });

  it("returns JOURNAL_LIMIT when a line exceeds maxLineBytes", () => {
    const dir = makeDir();
    const path = join(dir, "long-line.jsonl");
    const header = { type: "session", version: 3, id: "s" };
    const longEntry = {
      type: "custom",
      id: "long",
      parentId: null,
      customType: "x",
      padding: "z".repeat(200),
    };
    writeJournal(path, [header, longEntry]);
    const limits: JournalLimits = { maxBytes: 1024 * 1024, maxLineBytes: 50, maxEntries: 1000 };
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "s", leafId: null }, limits),
      "JOURNAL_LIMIT",
    );
  });

  it("returns JOURNAL_LIMIT when entries exceed maxEntries", () => {
    const dir = makeDir();
    const path = join(dir, "many-entries.jsonl");
    const header = { type: "session", version: 3, id: "s" };
    const entries: unknown[] = [header];
    for (let i = 0; i < 10; i++) {
      entries.push({
        type: "custom",
        id: `n${i}`,
        parentId: i === 0 ? null : `n${i - 1}`,
        customType: "x",
      });
    }
    writeJournal(path, entries);
    const limits: JournalLimits = {
      maxBytes: 1024 * 1024,
      maxLineBytes: 1024 * 1024,
      maxEntries: 3,
    };
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "s", leafId: "n9" }, limits),
      "JOURNAL_LIMIT",
    );
  });
});

describe("expanded default journal capacity (bounded synthetic fixtures only)", () => {
  function sparseInvalidJournal(size: number): SessionJournalView & { path: string } {
    const path = join(makeDir(), "sparse-capacity.jsonl");
    writeFileSync(path, "{invalid-json}\n");
    truncateSync(path, size);
    const stat = statSync(path);
    expect(stat.size).toBe(size);
    // Only sparse metadata is large. Never read or allocate the declared GiB body.
    expect(stat.blocks * 512).toBeLessThan(64 * 1024);
    return { path, sessionId: "s", leafId: null };
  }

  function sizedHeader(lineBytes: number): SessionJournalView {
    const path = join(makeDir(), "bounded-header.jsonl");
    const prefix = '{"type":"session","version":3,"id":"s","fixturePadding":"';
    const suffix = '"}';
    const padding = "x".repeat(lineBytes - Buffer.byteLength(prefix + suffix));
    writeFileSync(path, prefix + padding + suffix + "\n");
    expect(statSync(path).size).toBe(lineBytes + 1);
    return { path, sessionId: "s", leafId: null };
  }

  it("smoke: a small sparse fixture reaches structural validation without allocating its body", () => {
    const view = sparseInvalidJournal(8 * 1024 * 1024);
    expectCode(() => inspectSessionJournal(view), "JOURNAL_INVALID");
  });

  it("permits the declared 2GiB byte boundary, still rejects malformed structure, and rejects one byte above", () => {
    const view = sparseInvalidJournal(2_147_483_648);
    expectCode(() => inspectSessionJournal(view), "JOURNAL_INVALID");
    expect(statSync(view.path).size).toBe(2_147_483_648);
    truncateSync(view.path, 2_147_483_649);
    expectCode(() => inspectSessionJournal(view), "JOURNAL_LIMIT");
  });

  it.each([8_388_609, 16_777_216])(
    "parses a complete valid header with %i physical line bytes under default limits",
    (bytes) => {
      const view = sizedHeader(bytes);
      const journal = inspectSessionJournal(view);
      expect(journal.sessionId).toBe("s");
      expect(journal.nodes.size).toBe(0);
      expect(journal.branch).toEqual([]);
    },
  );

  it("rejects a physical line one byte above 16MiB", () => {
    expectCode(() => inspectSessionJournal(sizedHeader(16_777_217)), "JOURNAL_LIMIT");
  });

  it("keeps the entry-count guard and physical proof checks at a scaled three/four-entry boundary", () => {
    const f = fixture();
    const witness = {
      type: "custom",
      id: "witness",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: f.control.id,
        controlDigest: hash(f.control),
        frame: f.frame,
      },
    };
    const limits: JournalLimits = { maxBytes: 4096, maxLineBytes: 2048, maxEntries: 3 };
    writeJournal(f.path, [f.header, f.base, f.control, witness]);
    const view = { ...f.view, leafId: witness.id };
    const journal = inspectSessionJournal(view, limits);
    expect(journal.branch.map((node) => node.id)).toEqual(["base", "control", "witness"]);
    expect(findReadbackProof(journal, "board", "request").status).toBe("confirmed");
    writeJournal(f.path, [
      f.header,
      f.base,
      f.control,
      witness,
      { type: "custom", id: "extra", parentId: witness.id },
    ]);
    expectCode(() => inspectSessionJournal({ ...view, leafId: "extra" }, limits), "JOURNAL_LIMIT");
  });
});

describe("branch validation", () => {
  it("returns JOURNAL_BRANCH_INVALID when leafId is not in the journal", () => {
    const f = fixture();
    writeJournal(f.path, [f.header, f.base, f.control]);
    expectCode(
      () => inspectSessionJournal({ ...f.view, leafId: "nonexistent" }),
      "JOURNAL_BRANCH_INVALID",
    );
  });

  it("returns JOURNAL_BRANCH_INVALID when a parent in the chain is missing", () => {
    const dir = makeDir();
    const path = join(dir, "orphan-parent.jsonl");
    const header = { type: "session", version: 3, id: "s" };
    // child references parentId "ghost" which doesn't exist
    const child = { type: "custom", id: "child", parentId: "ghost", customType: "x" };
    writeJournal(path, [header, child]);
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "s", leafId: "child" }),
      "JOURNAL_BRANCH_INVALID",
    );
  });

  it("returns JOURNAL_BRANCH_INVALID for cyclic ancestry", () => {
    const dir = makeDir();
    const path = join(dir, "cycle.jsonl");
    const header = { type: "session", version: 3, id: "s" };
    const a = { type: "custom", id: "a", parentId: "b", customType: "x" };
    const b = { type: "custom", id: "b", parentId: "a", customType: "x" };
    writeJournal(path, [header, a, b]);
    expectCode(
      () => inspectSessionJournal({ path, sessionId: "s", leafId: "a" }),
      "JOURNAL_BRANCH_INVALID",
    );
  });
});

describe("readback proof outcomes", () => {
  it("returns confirmed for a valid preflight owner proof", () => {
    const pf = preflightFixture();
    const witness = {
      type: "custom",
      id: "pf-witness",
      parentId: pf.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: pf.control.id,
        controlDigest: hash(pf.control),
        frame: pf.frame,
      },
    };
    writeJournal(pf.path, [pf.header, pf.base, pf.control, witness]);
    const journal = inspectSessionJournal({ ...pf.view, leafId: witness.id });
    const proof = findReadbackProof(journal, "preflight", "pf-req");
    expect(proof.status).toBe("confirmed");
    if (proof.status === "confirmed") {
      expect(proof.control.id).toBe("pf-control");
      expect(proof.base.id).toBe("pf-base");
      expect(proof.witness.id).toBe("pf-witness");
    }
  });

  it("returns missing when no humanInteraction frame exists on the branch", () => {
    const dir = makeDir();
    const path = join(dir, "no-control.jsonl");
    const header = { type: "session", version: 3, id: "s" };
    const node = {
      type: "custom",
      id: "plain",
      parentId: null,
      customType: "continuous-tasks:event",
      data: { type: "other" },
    };
    writeJournal(path, [header, node]);
    const journal = inspectSessionJournal({ path, sessionId: "s", leafId: "plain" });
    const proof = findReadbackProof(journal, "board", "request");
    expect(proof.status).toBe("missing");
  });

  it("returns unconfirmed when witness references a different (abandoned) control", () => {
    const f = fixture();
    // Create a witness that references a control NOT on the current branch
    const otherControl = {
      type: "custom",
      id: "other-control",
      parentId: f.base.id,
      customType: "continuous-tasks:event",
      data: {
        type: "resolve_decision",
        id: "other-req",
        answer: "approve",
        humanInteraction: { ...f.frame, requestId: "other-req" },
      },
    };
    const witness = {
      type: "custom",
      id: "witness",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      // Witness points to otherControl, not f.control
      data: {
        version: 1,
        controlEntryId: otherControl.id,
        controlDigest: hash(otherControl),
        frame: f.frame,
      },
    };
    // Branch: header → base → control → witness (otherControl is NOT on this branch)
    writeJournal(f.path, [f.header, f.base, f.control, witness]);
    const journal = inspectSessionJournal(f.view);
    // Query for f.control's requestId — the witness references a different control
    const proof = findReadbackProof(journal, "board", "request");
    expect(proof.status).toBe("unconfirmed");
  });

  it("returns READBACK_INVALID when witness controlDigest does not match actual control digest", () => {
    const f = fixture();
    const wrongDigest = "0".repeat(64);
    const witness = {
      type: "custom",
      id: "witness",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: f.control.id,
        controlDigest: wrongDigest,
        frame: f.frame,
      },
    };
    writeJournal(f.path, [f.header, f.base, f.control, witness]);
    const journal = inspectSessionJournal({ ...f.view, leafId: witness.id });
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_INVALID");
  });

  it("returns READBACK_INVALID when witness frame does not match control frame", () => {
    const f = fixture();
    const alteredFrame = { ...f.frame, presentationId: "different" };
    const witness = {
      type: "custom",
      id: "witness",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: f.control.id,
        controlDigest: hash(f.control),
        frame: alteredFrame,
      },
    };
    writeJournal(f.path, [f.header, f.base, f.control, witness]);
    const journal = inspectSessionJournal({ ...f.view, leafId: witness.id });
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_INVALID");
  });

  it("returns READBACK_INVALID when base snapshot digest does not match", () => {
    const f = fixture();
    const wrongBaseDigest = "f".repeat(64);
    const badFrame = { ...f.frame, baseSnapshotDigest: wrongBaseDigest };
    const badControl = {
      ...f.control,
      data: { ...f.control.data, humanInteraction: badFrame },
    };
    const witness = {
      type: "custom",
      id: "witness",
      parentId: badControl.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: badControl.id,
        controlDigest: hash(badControl),
        frame: badFrame,
      },
    };
    writeJournal(f.path, [f.header, f.base, badControl, witness]);
    const journal = inspectSessionJournal({ ...f.view, leafId: witness.id });
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_INVALID");
  });

  it("returns READBACK_INVALID for unknown frame version", () => {
    const f = fixture();
    const badFrame = { ...f.frame, version: 2 };
    const badControl = {
      ...f.control,
      data: { ...f.control.data, humanInteraction: badFrame },
    };
    writeJournal(f.path, [f.header, f.base, badControl]);
    const journal = inspectSessionJournal(f.view);
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_INVALID");
  });

  it("returns READBACK_INVALID for unknown witness version", () => {
    const f = fixture();
    const witness = {
      type: "custom",
      id: "witness",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 2,
        controlEntryId: f.control.id,
        controlDigest: hash(f.control),
        frame: f.frame,
      },
    };
    writeJournal(f.path, [f.header, f.base, f.control, witness]);
    const journal = inspectSessionJournal({ ...f.view, leafId: witness.id });
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_INVALID");
  });

  it("returns READBACK_CONFLICT for duplicate controls matching same owner/requestId", () => {
    const f = fixture();
    const control2 = {
      type: "custom",
      id: "control2",
      parentId: f.control.id,
      customType: "continuous-tasks:event",
      data: { type: "resolve_decision", id: "request", answer: "deny", humanInteraction: f.frame },
    };
    writeJournal(f.path, [f.header, f.base, f.control, control2]);
    const journal = inspectSessionJournal({ ...f.view, leafId: control2.id });
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_CONFLICT");
  });

  it("returns READBACK_CONFLICT for duplicate witnesses referencing the same control", () => {
    const f = fixture();
    const w1 = {
      type: "custom",
      id: "w1",
      parentId: f.control.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: f.control.id,
        controlDigest: hash(f.control),
        frame: f.frame,
      },
    };
    const w2 = {
      type: "custom",
      id: "w2",
      parentId: w1.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: f.control.id,
        controlDigest: hash(f.control),
        frame: f.frame,
      },
    };
    writeJournal(f.path, [f.header, f.base, f.control, w1, w2]);
    const journal = inspectSessionJournal({ ...f.view, leafId: w2.id });
    expectCode(() => findReadbackProof(journal, "board", "request"), "READBACK_CONFLICT");
  });
});
