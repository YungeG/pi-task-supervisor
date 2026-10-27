// Recover exact prefixes of an owned real SDK producer, never a real/archived user session.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = resolve(
  process.env.P6_RECOVERY_FIXTURE ?? "../control-remediation-artifacts/p6-scale-1-fixture.jsonl",
);
assert(input.startsWith(resolve(root, "../control-remediation-artifacts") + "/p6-"));
const source = readFileSync(input, "utf8"),
  lines = source.trimEnd().split("\n"),
  rows = lines.map((line) => JSON.parse(line));
const stage = process.env.P6_RECOVERY_STAGE ?? "done";
assert(["queued", "done", "binding", "applied"].includes(stage));
const done = rows.findIndex(
  (row) =>
    row.type === "custom" &&
    row.customType === "continuous-tasks:snapshot" &&
    row.data.tasks?.[0]?.status === "done",
);
const queued = rows.findIndex(
  (row) => row.type === "custom" && row.data.kind === "eligibility-attested",
);
const bound = rows.findIndex(
  (row, index) =>
    index > done &&
    row.type === "custom" &&
    row.customType === "continuous-tasks:supervisor" &&
    row.data.bindings?.length,
);
const applied = rows.findIndex(
  (row) =>
    row.type === "custom" &&
    row.data.kind === "completion-intent-disposed" &&
    row.data.outcome === "applied",
);
assert(done > queued && bound > done && applied > bound);
const position = { queued, done, binding: bound, applied }[stage];
const dir = mkdtempSync(join(tmpdir(), "owned-codemode-recovery-")),
  file = join(dir, "owned-prefix.jsonl"),
  previous = process.env.PI_CODING_AGENT_DIR;
writeFileSync(file, lines.slice(0, position + 1).join("\n") + "\n");
let session,
  passed = false,
  toolsExecuted = 0;
try {
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async () => {
    throw Error("Owned recovery forbids network");
  };
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({
    provider: "owned-codemode-supervisor-faux",
    models: [{ id: "test", contextWindow: 128000 }],
  });
  runtime.registerNativeProvider(faux.provider);
  const manager = SessionManager.open(file),
    settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      codemode: { mode: "only" },
    });
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(root, "src/index.ts")],
    extensionFactories: [
      {
        name: "codemode",
        builtin: true,
        factory: createCodemodeExtension({ mode: "only", models: false }),
      },
    ],
  });
  await loader.reload();
  const forbidden = (name) => ({
    name,
    label: name,
    description: "Owned restore sentinel: execution is forbidden",
    parameters: Type.Object({}),
    execute: async () => {
      toolsExecuted++;
      throw Error("Recovery replayed an owned check/business tool");
    },
  });
  const created = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model: runtime.getModel("owned-codemode-supervisor-faux", "test"),
    sessionManager: manager,
    settingsManager,
    resourceLoader: loader,
    noTools: "builtin",
    tools: ["+codemode"],
    customTools: [forbidden("owned_check"), forbidden("owned_write")],
  });
  assert.deepEqual(created.extensionsResult.errors, []);
  session = created.session;
  const notices = [],
    errors = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { setWidget() {}, setStatus() {}, notify: (text) => notices.push(String(text)) },
    onError: (error) => errors.push(error),
    commandContextActions: { waitForIdle: () => session.waitForIdle() },
  });
  const actual = () => manager.getBranch(),
    fact = (kind) => actual().filter((row) => row.type === "custom" && row.data.kind === kind),
    task = () =>
      [...actual()]
        .reverse()
        .find((row) => row.type === "custom" && row.customType === "continuous-tasks:snapshot")
        ?.data.tasks[0];
  const intentId = fact("completion-intent-queued")[0]?.data.intentId;
  assert(intentId);
  const before = readFileSync(file),
    beforeRows = actual().length,
    checksBefore = actual().filter(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:receipt-ledger" &&
        row.data.kind === "receipt",
    ).length;
  const command = session.extensionRunner.getCommand("task-supervisor");
  await command.handler(
    `repair-completion ${intentId}`,
    session.extensionRunner.createCommandContext(),
  );
  if (stage === "queued") {
    assert.equal(task().status, "reviewing");
    assert.deepEqual(readFileSync(file), before);
    assert(
      notices.some((text) => /no exact confirmed original done snapshot/.test(text)),
      JSON.stringify(notices),
    );
  } else {
    assert.equal(task().status, "done");
    assert.equal(
      fact("completion-intent-disposed").filter((row) => row.data.outcome === "applied").length,
      1,
    );
    const repaired = readFileSync(file);
    await command.handler(
      `repair-completion ${intentId}`,
      session.extensionRunner.createCommandContext(),
    );
    assert.deepEqual(
      readFileSync(file),
      repaired,
      "Repeated native metadata repair must append nothing",
    );
    if (stage === "applied") assert.deepEqual(repaired, before);
  }
  assert.equal(toolsExecuted, 0);
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(errors, []);
  assert.equal(
    actual().filter(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:receipt-ledger" &&
        row.data.kind === "receipt",
    ).length,
    checksBefore,
  );
  assert.equal(
    fact("review-attempt-started").length,
    0,
    "Metadata repair cannot buy final review or freshen old qualifications",
  );
  assert.equal(readFileSync(input, "utf8"), source);
  console.log(
    JSON.stringify({
      result: "PASS",
      mode: "owned-actual-sdk-prefix-recovery",
      stage,
      appendedRows: actual().length - beforeRows,
      toolsExecuted,
      modelCalls: faux.state.callCount,
      goalAccepted: false,
      newFreshness: false,
      productionHumanProof: false,
    }),
  );
  passed = true;
} finally {
  session?.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Owned recovery failure retained: ${dir}`);
}
