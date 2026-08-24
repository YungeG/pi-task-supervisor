import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "src", "index.ts");
const sandbox = mkdtempSync(join(tmpdir(), "continuous-tasks-smoke-"));
const realSettings = join(homedir(), ".pi", "agent", "settings.json");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let session;

function digest(path) {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
}

function tool(name, args) {
  return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function latestSnapshot(sessionManager) {
  return [...sessionManager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === "continuous-tasks:snapshot")
    ?.data;
}

async function loadExtension(settingsManager) {
  const loader = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: sandbox,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
  });
  await loader.reload();
  return loader;
}

async function waitForCompletion(sessionManager) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const snapshot = latestSnapshot(sessionManager);
    if (snapshot?.workflowStatus === "completed") return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for the automatic continuation to complete the board");
}

const settingsDigestBefore = digest(realSettings);
process.env.PI_CODING_AGENT_DIR = sandbox;

try {
  const sessionManager = SessionManager.create(sandbox, join(sandbox, "sessions"));
  writeFileSync(
    join(sandbox, "continuous-tasks.json"),
    JSON.stringify({
      countdownMs: 0,
      maxStagnantSettles: 5,
      requireCompletionEvidence: true,
    }),
  );

  const settingsManager = SettingsManager.inMemory();
  const loader = await loadExtension(settingsManager);

  const evidence = {
    summary: "Reviewed and validated in the real Pi smoke",
    refs: [
      {
        kind: "review",
        label: "real Pi smoke review",
        status: "passed",
        ref: "smoke://review",
      },
    ],
  };
  const faux = fauxProvider({ provider: "continuous-tasks-faux", models: [{ id: "test" }] });
  faux.setResponses([
    tool("write_tasks", {
      mode: "replace",
      phases: [
        {
          title: "Implement",
          tasks: [{ title: "Implement", prompt: "Implement", profile: "worker" }],
        },
        {
          title: "Accept",
          tasks: [{ title: "Final acceptance", prompt: "Verify", profile: "reviewer" }],
        },
      ],
    }),
    tool("edit_tasks", {
      tasks: [{ id: "t-2.1", type: "blockers", data: { dependencies: ["t-1.1"] } }],
    }),
    tool("compile_tasks", { finalAcceptanceTaskId: "t-2.1" }),
    fauxAssistantMessage("Implementation phase prepared; ending this turn."),
    tool("get_ready_tasks", { count: 1 }),
    tool("advance_tasks", { transitions: [{ id: "t-1.1" }] }),
    tool("advance_tasks", { transitions: [{ id: "t-1.1", evidence }] }),
    tool("get_ready_tasks", { count: 1 }),
    tool("advance_tasks", { transitions: [{ id: "t-2.1" }] }),
    tool("advance_tasks", { transitions: [{ id: "t-2.1", evidence }] }),
    fauxAssistantMessage("All approved phases are complete."),
  ]);

  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("continuous-tasks-faux", "test");
  if (!model) throw new Error("Faux model was not registered");

  const created = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    modelRuntime,
    model,
    resourceLoader: loader,
    settingsManager,
    sessionManager,
    noTools: "builtin",
  });
  if (created.extensionsResult.errors.length > 0) {
    throw new Error(`Extension load failed: ${JSON.stringify(created.extensionsResult.errors)}`);
  }
  session = created.session;
  const extensionErrors = [];
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  if (session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("A fresh session exposed task tools before user activation");
  }
  const enableCommand = session.extensionRunner.getCommand("continuous-tasks");
  if (!enableCommand) throw new Error("Continuous Tasks command was not registered");
  await enableCommand.handler("enable", session.extensionRunner.createCommandContext());

  let agentStarts = 0;
  const toolSequence = [];
  session.subscribe((event) => {
    if (event.type === "agent_start") agentStarts++;
    if (event.type === "tool_execution_start") toolSequence.push(event.toolName);
  });

  await session.prompt("Start the approved continuous task board.");
  const snapshot = await waitForCompletion(sessionManager);
  await session.agent.waitForIdle();

  const branch = sessionManager.getBranch();
  const userMessages = branch.filter(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  const continuationMessages = branch.filter(
    (entry) => entry.type === "custom_message" && entry.customType === "continuous-tasks:continue",
  );
  const activationEntries = branch.filter(
    (entry) => entry.type === "custom" && entry.customType === "continuous-tasks:activation",
  );

  if (extensionErrors.length > 0)
    throw new Error(`Extension errors: ${JSON.stringify(extensionErrors)}`);
  if (agentStarts !== 2) throw new Error(`Expected two agent runs, got ${agentStarts}`);
  if (faux.getPendingResponseCount() !== 0) throw new Error("Faux responses were not exhausted");
  if (userMessages.length !== 1) throw new Error("Auto-continuation forged a user message");
  if (continuationMessages.length !== 1) {
    throw new Error(`Expected one hidden continuation, got ${continuationMessages.length}`);
  }
  if (
    activationEntries.length !== 1 ||
    JSON.stringify(activationEntries[0].data) !== JSON.stringify({ version: 1, enabled: true })
  ) {
    throw new Error("The enable command did not persist one valid session activation entry");
  }
  if (!snapshot.tasks.every((task) => task.status === "done" && task.completionEvidence)) {
    throw new Error("Completed tasks are missing evidence");
  }
  const expectedTools = [
    "write_tasks",
    "edit_tasks",
    "compile_tasks",
    "get_ready_tasks",
    "advance_tasks",
    "advance_tasks",
    "get_ready_tasks",
    "advance_tasks",
    "advance_tasks",
  ];
  if (JSON.stringify(toolSequence) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected tool sequence: ${JSON.stringify(toolSequence)}`);
  }
  if (digest(realSettings) !== settingsDigestBefore) {
    throw new Error("Real Pi settings changed during isolated smoke test");
  }

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Persistent smoke session was not created");
  session.dispose();
  const reopened = SessionManager.open(sessionFile);
  const resumedLoader = await loadExtension(settingsManager);
  const resumed = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    modelRuntime,
    model,
    resourceLoader: resumedLoader,
    settingsManager,
    sessionManager: reopened,
    noTools: "builtin",
  });
  session = resumed.session;
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  if (!session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("Resuming the session did not restore activated task tools");
  }

  session.dispose();
  const forkedManager = SessionManager.forkFrom(
    sessionFile,
    sandbox,
    join(sandbox, "fork-sessions"),
  );
  const forkedLoader = await loadExtension(settingsManager);
  const forked = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    modelRuntime,
    model,
    resourceLoader: forkedLoader,
    settingsManager,
    sessionManager: forkedManager,
    noTools: "builtin",
  });
  session = forked.session;
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  if (!session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("Forking the session did not inherit activated task tools");
  }

  session.dispose();
  const independentManager = SessionManager.create(sandbox, join(sandbox, "independent-sessions"));
  const independentLoader = await loadExtension(settingsManager);
  const independent = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    modelRuntime,
    model,
    resourceLoader: independentLoader,
    settingsManager,
    sessionManager: independentManager,
    noTools: "builtin",
  });
  session = independent.session;
  await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
  if (session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("An independent session inherited activation");
  }

  console.log(
    JSON.stringify({
      result: "PASS",
      sessionId: sessionManager.getSessionId(),
      agentStarts,
      toolSequence,
      finalStatus: snapshot.workflowStatus,
      userMessages: userMessages.length,
      hiddenContinuations: continuationMessages.length,
      activationEntries: activationEntries.length,
      resumedActivation: true,
      forkedActivation: true,
      independentDefaultDeny: true,
      realSettingsUntouched: true,
    }),
  );
} finally {
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(sandbox, { recursive: true, force: true });
}
