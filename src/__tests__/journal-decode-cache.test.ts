import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { inspectSessionJournal, journalDecodeStats } from "../human-journal";

function owned() {
  const dir = mkdtempSync(join(tmpdir(), "owned-decode-cache-")),
    path = join(dir, "fixture.jsonl"),
    sessionId = dir;
  const header = { type: "session", version: 3, id: sessionId },
    row = {
      id: dir + "-node",
      parentId: null,
      type: "custom",
      customType: "continuous-tasks:control-facts",
      data: { owned: dir },
    };
  const write = (rows: unknown[] = [row], end = "\n") => {
    writeFileSync(path, [header, ...rows].map((value) => JSON.stringify(value)).join("\n") + end);
  };
  write();
  return {
    dir,
    path,
    row,
    write,
    view: { path, sessionId, leafId: row.id },
    close: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("bounded content-only native decode cache", () => {
  it("does not let immutable sharing skip fresh physical contents, headers, limits or complete tails", () => {
    const h = owned();
    try {
      const first = inspectSessionJournal(h.view, undefined, true);
      h.row.data.owned = "physically changed";
      h.write();
      expect(inspectSessionJournal(h.view, undefined, true).branch[0]!.digest).not.toBe(
        first.branch[0]!.digest,
      );
      h.write([h.row, h.row]);
      expect(() => inspectSessionJournal(h.view, undefined, true)).toThrow("JOURNAL_INVALID");
      h.write();
      expect(() =>
        inspectSessionJournal({ ...h.view, sessionId: "foreign" }, undefined, true),
      ).toThrow("JOURNAL_INVALID");
      expect(() =>
        inspectSessionJournal(
          h.view,
          { maxBytes: 100000, maxLineBytes: 20, maxEntries: 100 },
          true,
        ),
      ).toThrow("JOURNAL_LIMIT");
      h.write([h.row], "");
      expect(() => inspectSessionJournal(h.view, undefined, true)).toThrow("JOURNAL_INVALID");
    } finally {
      h.close();
    }
  });
  it("shares only recursively frozen nodes for internal readonly inspections; default projections remain isolated mutable copies", () => {
    const h = owned();
    try {
      const first = inspectSessionJournal(h.view, undefined, true),
        second = inspectSessionJournal(h.view, undefined, true);
      const node = first.nodes.get(h.row.id)!;
      expect(Object.isFrozen(node)).toBe(true);
      expect(Object.isFrozen(node.data)).toBe(true);
      expect(second.nodes.get(h.row.id)).toBe(node);
      expect(() => {
        (node.data as { owned: string }).owned = "tampered";
      }).toThrow();
      const mutable = inspectSessionJournal(h.view);
      (mutable.nodes.get(h.row.id)!.data as { owned: string }).owned = "local";
      expect(
        (
          inspectSessionJournal(h.view, undefined, true).nodes.get(h.row.id)!.data as {
            owned: string;
          }
        ).owned,
      ).toBe(h.row.data.owned);
    } finally {
      h.close();
    }
  });
  it("evicts pure decoded entries at the fixed bound without granting authority or skipping a later read", () => {
    const h = owned();
    try {
      const rows = [
        h.row,
        ...Array.from({ length: 8192 }, (_, i) => ({ ...h.row, id: `${h.row.id}-${i}` })),
      ];
      h.write(rows);
      inspectSessionJournal(h.view);
      expect(journalDecodeStats().entries).toBe(8192);
      expect(journalDecodeStats().bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      const decoded = journalDecodeStats().decodedNodes;
      h.write();
      expect(inspectSessionJournal(h.view).branch[0]!.data).toEqual(h.row.data);
      expect(journalDecodeStats().decodedNodes).toBe(decoded + 1);
    } finally {
      h.close();
    }
  });
  it("reuses pure decoding but returns isolated nodes/proofs", () => {
    const h = owned();
    try {
      const before = journalDecodeStats(),
        first = inspectSessionJournal(h.view),
        once = journalDecodeStats();
      (first.nodes.get(h.row.id)!.data as { owned: string }).owned = "mutated projection";
      first.nodes.get(h.row.id)!.data = { owned: "replaced local field" };
      const second = inspectSessionJournal(h.view),
        twice = journalDecodeStats();
      expect(once.decodedNodes - before.decodedNodes).toBe(1);
      expect(twice.decodedNodes).toBe(once.decodedNodes);
      expect(second.nodes.get(h.row.id)!.data).toEqual(h.row.data);
      expect(second.nodes.get(h.row.id)).not.toBe(first.nodes.get(h.row.id));
    } finally {
      h.close();
    }
  });
  it("redecodes changed content under identical IDs", () => {
    const h = owned();
    try {
      const before = inspectSessionJournal(h.view);
      h.row.data.owned = "changed";
      h.write();
      const after = inspectSessionJournal(h.view);
      expect(after.branch[0]!.digest).not.toBe(before.branch[0]!.digest);
      expect(after.branch[0]!.data).toEqual(h.row.data);
    } finally {
      h.close();
    }
  });
  it("still rejects cached duplicate IDs, foreign headers and incomplete tails", () => {
    const h = owned();
    try {
      inspectSessionJournal(h.view);
      h.write([h.row, h.row]);
      expect(() => inspectSessionJournal(h.view)).toThrow("JOURNAL_INVALID");
      h.write();
      expect(() => inspectSessionJournal({ ...h.view, sessionId: "foreign" })).toThrow(
        "JOURNAL_INVALID",
      );
      h.write([h.row], "");
      expect(() => inspectSessionJournal(h.view)).toThrow("JOURNAL_INVALID");
    } finally {
      h.close();
    }
  });
  it("does not bypass stricter per-read limits on a hit", () => {
    const h = owned();
    try {
      inspectSessionJournal(h.view);
      expect(() =>
        inspectSessionJournal(h.view, { maxBytes: 100000, maxLineBytes: 20, maxEntries: 100 }),
      ).toThrow("JOURNAL_LIMIT");
      const stats = journalDecodeStats();
      expect(stats.entries).toBeLessThanOrEqual(8192);
      expect(stats.bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    } finally {
      h.close();
    }
  });
});
