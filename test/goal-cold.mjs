// Real SDK cold restore / old-reader refusal over an owned copy of an actual native session.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const input = option("--session");
assert(input, "an owned native fixture session is required");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reader = resolve(option("--reader") ?? root);
const old = args.includes("--expect-refusal");
const aOnly = args.includes("--a-only");
const output = resolve(option("--out") ?? mkdtempSync(join(tmpdir(), "goal-cold-")));
mkdirSync(output, { recursive: true });
const sandbox = mkdtempSync(join(output, "owned-"));
const path = join(sandbox, "session.jsonl");
const bytes = readFileSync(input);
const parsed = bytes
  .toString("utf8")
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line));
assert(parsed[0].type === "session");
let rows = parsed;
if (aOnly) {
  const index = parsed.findIndex(
    (row) =>
      row.customType === "continuous-tasks:supervisor" &&
      row.data?.version === 5 &&
      row.data.kind === "transition-control",
  );
  assert(index > 0);
  rows = parsed.slice(0, index + 1);
}
writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
const owner = () =>
  JSON.stringify(
    readFileSync(path, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((row) => row.type === "custom"),
  );
const settingsPath = join(homedir(), ".pi/agent/settings.json");
const hash = (path) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const settingsBefore = hash(settingsPath);
const ownerBefore = owner();
const previous = process.env.PI_CODING_AGENT_DIR;
let session;
const notices = [];
const statuses = [];
try {
  process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
  const settings = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    compaction: { enabled: false },
  });
  const manager = SessionManager.open(path);
  const loader = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths: [join(reader, "src/index.ts")],
  });
  await loader.reload();
  const models = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({
    provider: "goal-native-fixture",
    models: [{ id: "test", contextWindow: 16000 }],
  });
  models.registerNativeProvider(faux.provider);
  const model = models.getModel("goal-native-fixture", "test");
  assert(model);
  ({ session } = await createAgentSession({
    cwd: sandbox,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    settingsManager: settings,
    sessionManager: manager,
    resourceLoader: loader,
    modelRuntime: models,
    model,
    noTools: "builtin",
  }));
  await session.bindExtensions({
    mode: "print",
    uiContext: {
      notify: (text) => {
        notices.push(text);
      },
      setStatus: (_key, value) => {
        if (value) statuses.push(value);
      },
      setWidget() {},
      select: async () => {
        throw new Error("Cold restore must not ask for authority");
      },
      custom: async () => {
        throw new Error("Cold restore must not open an authority prompt");
      },
    },
    commandContextActions: { waitForIdle: () => session.waitForIdle() },
  });
  const command = session.extensionRunner.getCommand("task-supervisor");
  assert(command);
  const ctx = session.extensionRunner.createCommandContext();
  await command.handler("status", ctx);
  const gate = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "write_tasks",
    toolCallId: "cold-not-executed",
    input: { mode: "replace", phases: [] },
  });
  assert.equal(gate?.block, true);
  assert.equal(faux.state.callCount, 0);
  assert.equal(owner(), ownerBefore);
  assert.equal(hash(settingsPath), settingsBefore);
  const commits = rows.filter(
    (row) =>
      row.customType === "continuous-tasks:supervisor" && row.data?.kind === "transition-committed",
  );
  const selected = commits.at(-1)?.data.seed.goalRunId;
  if (old)
    assert(
      [...notices, ...statuses].some((value) =>
        /invalid.*journal|journal.*invalid|journal.*fault/i.test(value),
      ),
      JSON.stringify({ notices, statuses, gate }),
    );
  else if (aOnly)
    assert(
      notices.some((value) => /transition|pending|readback/i.test(value)),
      JSON.stringify(notices),
    );
  else {
    assert(selected);
    assert(
      notices.some((value) => value.includes(selected)),
      JSON.stringify(notices),
    );
  }
  const result = {
    result: "PASS",
    mode: old ? "old-reader-refused" : "current-cold-no-replay",
    aOnly,
    reader,
    source: root,
    actualSessionManager: true,
    modelCalls: 0,
    ownerJournalUnchanged: true,
    settingsUnchanged: true,
    selectedGoalRunId: selected,
    path,
    gate,
    nativeSourceMocked: false,
  };
  writeFileSync(join(sandbox, "verified.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  session?.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
}
