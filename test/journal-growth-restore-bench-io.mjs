import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Preparation only: neither helper restores a session or invokes a provider.
export async function readFixture(input, view, maxBytes = 512 * 1024 * 1024) {
  assert(
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 512 * 1024 * 1024,
    "invalid benchmark byte bound",
  );
  const before = fs.statSync(input, { bigint: true });
  assert(
    before.size > 0n && before.size <= BigInt(maxBytes),
    "input exceeds benchmark bound; use a bounded slice",
  );
  const rows = [];
  const hash = createHash("sha256");
  // Fix the physical read range before a concurrent append can expand it.
  const stream = fs.createReadStream(input, { start: 0, end: Number(before.size) - 1 });
  let bytes = 0,
    lastByte;
  stream.on("data", (chunk) => {
    bytes += chunk.length;
    lastByte = chunk.at(-1);
    hash.update(chunk);
  });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line) continue;
      assert(rows.length < 500001, "fixture exceeds the strict-reader entry bound");
      rows.push(JSON.parse(line));
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  const after = fs.statSync(input, { bigint: true });
  assert(
    bytes === Number(before.size) &&
      ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((key) => before[key] === after[key]),
    "benchmark input changed during preparation",
  );
  assert(lastByte === 0x0a, "fixture has an incomplete final line (missing LF)");
  const digest = hash.digest("hex");
  assert(rows.shift()?.id === view.sessionId, "fixture session identity mismatch");
  const byId = new Map(rows.map((row) => [row.id, row]));
  const branch = [],
    seen = new Set();
  let id = view.leafId;
  while (id) {
    assert(!seen.has(id), "fixture ancestry cycle");
    seen.add(id);
    const row = byId.get(id);
    assert(row, "fixture ancestry missing");
    branch.push(row);
    id = row.parentId;
  }
  branch.reverse();
  return { before, rows, digest, byId, branch };
}

export async function loadSdkRuntime(sdk) {
  const require = createRequire(join(sdk, "package.json"));
  // Node locates the SDK's own jiti; jiti's existing ESM resolver handles import-only exports.
  const module = await import(pathToFileURL(require.resolve("jiti")).href);
  const createJiti = module.createJiti ?? module.default;
  const resolver = createJiti(join(sdk, "package.json"), { fsCache: false });
  const resolve = (name) => fileURLToPath(resolver.esmResolve(name));
  return {
    createJiti,
    aliases: {
      typebox: resolve("typebox"),
      "typebox/value": resolve("typebox/value"),
      "@earendil-works/pi-coding-agent": join(sdk, "dist/index.js"),
      "@earendil-works/pi-ai": resolve("@earendil-works/pi-ai"),
      "@earendil-works/pi-tui": resolve("@earendil-works/pi-tui"),
    },
  };
}
