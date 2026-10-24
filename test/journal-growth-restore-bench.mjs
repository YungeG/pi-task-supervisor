// Read-only, isolated Supervisor session_start benchmark; no providers or business execution.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { readFixture, loadSdkRuntime } from "./journal-growth-restore-bench-io.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const opt = (key) => {
  const i = args.indexOf(key);
  return i < 0 ? undefined : args[i + 1];
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (value) => createHash("sha256").update(value).digest("hex");
function sourceFiles(directory) {
  const result = {};
  function visit(path) {
    for (const entry of fs
      .readdirSync(path, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(path, entry.name);
      if (entry.isDirectory()) visit(name);
      else if (entry.name.endsWith(".ts"))
        result[name.slice(directory.length + 1)] = sha(fs.readFileSync(name));
    }
  }
  visit(join(directory, "src"));
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
async function fileHash(path) {
  const hash = createHash("sha256");
  for await (const bytes of fs.createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
function generate() {
  const out = resolve(opt("--generate"));
  const n = Number(opt("--records") ?? 10);
  assert(Number.isInteger(n) && n >= 1 && n <= 500, "synthetic count must be bounded 1..500");
  fs.mkdirSync(out, { recursive: true, mode: 0o700 });
  const path = join(out, "synthetic.jsonl");
  assert(!fs.existsSync(path), "refuse to replace an existing fixture");
  fs.writeFileSync(
    path,
    JSON.stringify({ type: "session", version: 3, id: "bench-session", cwd: out }) + "\n",
    { mode: 0o600 },
  );
  const receipts = [];
  let parent = null;
  for (let i = 1; i <= n; i++) {
    receipts.push({
      id: `tool:synthetic-${String(i).padStart(4, "0")}`,
      tool: "read",
      taskIds: [],
      reviews: [],
      epoch: 0,
      ok: true,
      digest: "a".repeat(64),
      input: "I".repeat(256),
      output: "O".repeat(1024),
    });
    const id = `snapshot-${String(i).padStart(4, "0")}`;
    const data = {
      version: 1,
      sessionId: "bench-session",
      goal: "Synthetic legacy benchmark only",
      model: { provider: "faux", id: "bench" },
      status: "stopped",
      reviews: 0,
      continuations: 0,
      stagnant: 0,
      epoch: 0,
      pending: false,
      tokens: 0,
      cost: 0,
      bindings: [],
      receipts,
    };
    fs.appendFileSync(
      path,
      JSON.stringify({
        type: "custom",
        id,
        parentId: parent,
        customType: "continuous-tasks:supervisor",
        data,
      }) + "\n",
    );
    parent = id;
  }
  const view = join(out, "view.json");
  fs.writeFileSync(
    view,
    JSON.stringify(
      { path, sessionId: "bench-session", leafId: parent, fixtureKind: "synthetic-v1", records: n },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({ result: "GENERATED", view, records: n, bytes: fs.statSync(path).size }),
  );
}
async function measure() {
  const source = resolve(opt("--source") ?? root);
  const sdk = fs.realpathSync(
    resolve(opt("--sdk") ?? join(root, "node_modules/@earendil-works/pi-coding-agent")),
  );
  const output = resolve(opt("--out"));
  fs.mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = join(dirname(output), "isolated-agent");
  const view = JSON.parse(fs.readFileSync(resolve(opt("--view")), "utf8"));
  const input = resolve(view.path);
  const sources = sourceFiles(source);
  const setupStarted = performance.now();
  const { before, rows, digest, byId, branch } = await readFixture(input, view);
  const fixtureMs = performance.now() - setupStarted;
  const setupRss = process.memoryUsage().rss;
  let phase = false;
  const counters = { opens: 0, bytes: 0, eof: 0 };
  const tracked = new Set();
  const original = { open: fs.openSync, read: fs.readSync, close: fs.closeSync };
  fs.openSync = function (path, ...rest) {
    const fd = original.open.call(fs, path, ...rest);
    if (phase && resolve(String(path)) === input) {
      tracked.add(fd);
      counters.opens++;
    }
    return fd;
  };
  fs.readSync = function (fd, ...rest) {
    const count = original.read.call(fs, fd, ...rest);
    if (phase && tracked.has(fd)) {
      counters.bytes += count;
      if (count === 0) counters.eof++;
    }
    return count;
  };
  fs.closeSync = function (fd) {
    tracked.delete(fd);
    return original.close.call(fs, fd);
  };
  syncBuiltinESMExports();
  let writes = 0,
    executions = 0,
    dispatches = 0,
    notices = 0,
    network = 0;
  globalThis.fetch = async () => {
    network++;
    throw Error("BENCH_NETWORK_BLOCKED");
  };
  const { createJiti, aliases } = await loadSdkRuntime(sdk);
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: aliases });
  const importStarted = performance.now();
  const { registerEventHandlers } = await jiti.import(join(source, "src/events.ts"));
  const { currentRuntime } = await jiti.import(join(source, "src/runtime.ts"));
  const { getBoard } = await jiti.import(join(source, "src/state.ts"));
  const importMs = performance.now() - importStarted;
  const handlers = new Map();
  const pi = {
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
      return () => {};
    },
    getActiveTools: () => ["read", "bash", "edit", "write"],
    setActiveTools() {},
    getAllTools: () => [],
    getToolDefinitions: () => [],
    appendEntry() {
      writes++;
      throw Error("BENCH_WRITE_BLOCKED");
    },
    sendUserMessage() {
      dispatches++;
      throw Error("BENCH_DISPATCH_BLOCKED");
    },
    sendMessage() {
      notices++;
    },
    exec() {
      executions++;
      throw Error("BENCH_EXEC_BLOCKED");
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
  };
  const manager = {
    getSessionFile: () => input,
    getSessionId: () => view.sessionId,
    getLeafId: () => view.leafId,
    getEntries: () => rows.slice(),
    getBranch: () => branch.slice(),
    getEntry: (key) => byId.get(key),
    getLeafEntry: () => byId.get(view.leafId),
    getCwd: () => root,
  };
  const ctx = {
    cwd: root,
    hasUI: false,
    mode: "rpc",
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: manager,
    ui: { setStatus() {}, setWidget() {}, notify() {} },
    model: { provider: "faux", id: "bench" },
  };
  registerEventHandlers(pi);
  const beforeRestoreRss = process.memoryUsage().rss;
  phase = true;
  const started = performance.now();
  for (const handler of handlers.get("session_start") ?? [])
    await handler({ type: "session_start", reason: "reload" }, ctx);
  const restoreMs = performance.now() - started;
  phase = false;
  const afterRestoreRss = process.memoryUsage().rss;
  assert.equal(
    writes + executions + dispatches + notices + network,
    0,
    "benchmark did not execute a stable read-only restoration",
  );
  const runtime = currentRuntime();
  assert.equal(runtime.journalFault, undefined, "restoration faulted");
  const projectionDigest = sha(
    JSON.stringify({
      board: getBoard(),
      supervisor: runtime.supervisor,
      preflight: runtime.preflight,
      goal: runtime.goal,
      enabled: runtime.enabled,
    }),
  );
  const after = fs.statSync(input, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.ctimeNs, before.ctimeNs);
  assert.equal(await fileHash(input), digest, "input bytes changed");
  assert.deepEqual(sourceFiles(source), sources, "source changed during benchmark");
  const report = {
    result: "PASS",
    benchmarkScriptHash: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
    benchmarkIoHash: sha(
      fs.readFileSync(new URL("./journal-growth-restore-bench-io.mjs", import.meta.url)),
    ),
    label: opt("--label"),
    source,
    sourceTreeHash: sha(JSON.stringify(sources)),
    sourceFiles: sources,
    sdkVersion: JSON.parse(fs.readFileSync(join(sdk, "package.json"))).version,
    nodeVersion: process.version,
    fixture: {
      kind: view.fixtureKind ?? "external-read-only",
      sha256: digest,
      bytes: Number(before.size),
      sessionId: view.sessionId,
      leafId: view.leafId,
      entries: rows.length,
      branchEntries: branch.length,
    },
    actualSessionManager: false,
    mechanism:
      "production event handler + physical strict reader + read-only in-memory context; no live TUI, models or providers",
    timings: { importsMs: importMs, fixtureParseMs: fixtureMs, restorationMs: restoreMs },
    reads: counters,
    memory: {
      setupRssBytes: setupRss,
      beforeRestoreRssBytes: beforeRestoreRss,
      afterRestoreRssBytes: afterRestoreRss,
      peakWholeProcessRssKiB: process.resourceUsage().maxRSS,
    },
    effects: { writes, executions, dispatches, notices, network },
    projectionDigest,
    inputUnchanged: true,
    warmFilesystemNotColdIo: true,
  };
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      result: report.result,
      label: report.label,
      bytes: report.fixture.bytes,
      reads: report.reads,
      restorationMs: report.timings.restorationMs,
      peakWholeProcessRssKiB: report.memory.peakWholeProcessRssKiB,
      projectionDigest,
      report: output,
    }),
  );
}
try {
  if (opt("--generate")) generate();
  else await measure();
} catch (error) {
  // Do not print original session content or provider exception payloads.
  console.error(
    JSON.stringify({
      result: "FAIL",
      error: error.name,
      reason:
        error instanceof assert.AssertionError
          ? error.message
          : "inspect source/fixture using bounded synthetic inputs",
    }),
  );
  process.exitCode = 1;
}
