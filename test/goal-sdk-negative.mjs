// Ordinary SDK custom TUI in a real double TTY. No argv/TTY/admission spoofing or live model.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { fauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = resolve(process.env.GOAL_NATIVE_OUT);
const path = join(sandbox, "session.jsonl");
const settingsPath = join(homedir(), ".pi/agent/settings.json");
const hash = (path) =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : "absent";
const settingsBefore = hash(settingsPath);
let session;
let uiCalls = 0;
const notices = [];
try {
  assert.equal(process.stdin.isTTY, true);
  assert.equal(process.stdout.isTTY, true);
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
    additionalExtensionPaths: [join(root, "src/index.ts")],
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
    mode: "tui",
    uiContext: {
      select: async () => {
        uiCalls++;
        return "选项 1";
      },
      input: async () => {
        uiCalls++;
        return "approved";
      },
      custom: async () => {
        uiCalls++;
        return "reviewed";
      },
      notify: (text) => {
        notices.push(text);
      },
      setStatus() {},
      setWidget() {},
    },
    commandContextActions: { waitForIdle: () => session.waitForIdle() },
  });
  const command = session.extensionRunner.getCommand("task-supervisor");
  assert(command);
  const ctx = session.extensionRunner.createCommandContext();
  assert.equal(ctx.mode, "tui");
  assert.equal(ctx.hasUI, true);
  const before = hash(path);
  const count = manager.getBranch().length;
  await command.handler("supervise Ordinary SDK cannot archive a new goal", ctx);
  await command.handler("preflight Ordinary SDK cannot archive a new goal", ctx);
  assert.equal(uiCalls, 0);
  assert.equal(hash(path), before);
  assert.equal(manager.getBranch().length, count);
  assert(
    notices.some((text) => /trusted|native/i.test(text)),
    JSON.stringify(notices),
  );
  assert.equal(faux.state.callCount, 0);
  assert.equal(hash(settingsPath), settingsBefore);
  const value = {
    result: "PASS",
    mode: "ordinary-sdk-double-tty-denied",
    stdinTty: true,
    stdoutTty: true,
    nativeSourceMocked: false,
    uiCalls,
    modelCalls: faux.state.callCount,
    newAuthority: false,
    actualSessionManager: true,
    physicalJournalUnchanged: true,
    settingsUnchanged: true,
  };
  writeFileSync(join(sandbox, "sdk-denial.json"), JSON.stringify(value, null, 2));
  console.log("GOAL_SDK_DENIAL_SAVED");
} finally {
  session?.dispose();
}
