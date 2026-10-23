import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFixture, loadSdkRuntime } from "./journal-growth-restore-bench-io.mjs";

const peer = createRequire(
  new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url),
);
const existingJiti = dirname(peer.resolve("jiti/package.json"));
function temp(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "p2-bench-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function pkg(path, json, files) {
  fs.mkdirSync(path, { recursive: true });
  fs.writeFileSync(join(path, "package.json"), JSON.stringify(json));
  for (const [name, data] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(path, name)), { recursive: true });
    fs.writeFileSync(join(path, name), data);
  }
}
function sdkFixture(t, layout) {
  const root = temp(t),
    sdk = join(root, "node_modules/@earendil-works/pi-coding-agent");
  pkg(
    sdk,
    {
      name: "@earendil-works/pi-coding-agent",
      type: "module",
      exports: { ".": { import: "./dist/index.js" } },
    },
    { "dist/index.js": "export const sdk = true;" },
  );
  const deps = layout === "nested" ? join(sdk, "node_modules") : join(root, "node_modules");
  fs.mkdirSync(deps, { recursive: true });
  fs.symlinkSync(existingJiti, join(deps, "jiti"), "dir");
  for (const name of ["pi-ai", "pi-tui"])
    pkg(
      join(deps, "@earendil-works", name),
      {
        name: "@earendil-works/" + name,
        type: "module",
        exports: { ".": { import: "./entry.mjs" } },
      },
      { "entry.mjs": `export const marker = ${JSON.stringify(layout)};` },
    );
  pkg(
    join(deps, "typebox"),
    { name: "typebox", type: "module", exports: { ".": "./index.mjs", "./value": "./value.mjs" } },
    { "index.mjs": "export const Type = {};", "value.mjs": "export const Check = true;" },
  );
  return { root, sdk, deps };
}
for (const layout of ["nested", "hoisted"])
  test(`resolves ${layout} SDK dependencies including ESM-only entry points`, async (t) => {
    const h = sdkFixture(t, layout);
    const { aliases } = await loadSdkRuntime(h.sdk);
    for (const name of ["pi-ai", "pi-tui"]) {
      const path = aliases["@earendil-works/" + name];
      assert.equal(
        fs.realpathSync(path),
        fs.realpathSync(join(h.deps, "@earendil-works", name, "entry.mjs")),
      );
      assert.equal((await import(pathToFileURL(path).href)).marker, layout);
    }
  });
test("prefers the selected SDK's nested dependency over a hoisted decoy", async (t) => {
  const h = sdkFixture(t, "nested");
  pkg(
    join(h.root, "node_modules/@earendil-works/pi-ai"),
    { name: "@earendil-works/pi-ai", type: "module", exports: "./wrong.mjs" },
    { "wrong.mjs": "export const marker = 'wrong';" },
  );
  const { aliases } = await loadSdkRuntime(h.sdk);
  assert.equal(
    (await import(pathToFileURL(aliases["@earendil-works/pi-ai"]).href)).marker,
    "nested",
  );
});
test("rejects a missing selected-SDK dependency instead of using the project's SDK", async (t) => {
  const h = sdkFixture(t, "hoisted");
  fs.rmSync(join(h.deps, "@earendil-works/pi-ai"), { recursive: true });
  await assert.rejects(loadSdkRuntime(h.sdk), /pi-ai/);
});
const body = () =>
  JSON.stringify({ type: "session", id: "fixture" }) +
  "\n" +
  JSON.stringify({ id: "one", parentId: null }) +
  "\n";
const view = { sessionId: "fixture", leafId: "one" };
test("bounds bytes actually read and rejects concurrent growth before returning a fixture", async (t) => {
  const input = join(temp(t), "session.jsonl");
  fs.writeFileSync(input, body());
  const budget = fs.statSync(input).size;
  const original = fs.createReadStream;
  let bytes = 0;
  const replacement = mock.method(fs, "createReadStream", function (path, options) {
    fs.appendFileSync(
      input,
      JSON.stringify({ id: "two", parentId: "one", data: "X".repeat(4096) }) + "\n",
    );
    const stream = original.call(this, path, options);
    stream.on("data", (chunk) => (bytes += chunk.length));
    return stream;
  });
  try {
    await assert.rejects(readFixture(input, view, budget), /changed|bound/);
    assert(bytes <= budget, `read ${bytes} > ${budget}`);
  } finally {
    replacement.mock.restore();
  }
});
test("returns an unchanged small fixture and rejects half-lines, bad JSON and cycles", async (t) => {
  const input = join(temp(t), "session.jsonl");
  fs.writeFileSync(input, body());
  const value = await readFixture(input, view);
  assert.equal(value.branch.length, 1);
  fs.writeFileSync(input, body().trimEnd());
  await assert.rejects(readFixture(input, view), /line|LF|incomplete/);
  fs.writeFileSync(input, "{broken}\n");
  await assert.rejects(readFixture(input, view));
  fs.writeFileSync(
    input,
    JSON.stringify({ type: "session", id: "fixture" }) +
      "\n" +
      JSON.stringify({ id: "one", parentId: "one" }) +
      "\n",
  );
  await assert.rejects(readFixture(input, view), /cycle/);
});
