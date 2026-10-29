// Owned real-SDK/faux-provider stop/disable qualification, not CLI/human/business proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
const sdk=await import(process.env.MANAGEMENT_SDK_ENTRY ?? '@earendil-works/pi-coding-agent');
const {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager}=sdk;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "owned-management-sdk-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const previousHostGoal=process.env.OWNED_HOST_MODULE_GOAL;
const previousHostSession=process.env.OWNED_HOST_MODULE_SESSION;
const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
const settingsHash = () => existsSync(settingsPath) ? createHash("sha256").update(readFileSync(settingsPath)).digest("hex") : "absent";
const beforeSettings = settingsHash();
let session, release, passed = false;
const errors = [];
let reviewStarted = false, agentStarts = 0;
const tool = (name, args, id) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
async function until(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw Error(`Owned bounded wait failed: ${label}`); await new Promise(resolveWait => setTimeout(resolveWait, 5)); }
}
const latest = (manager, type) => [...manager.getBranch()].reverse().find(row => row.type === "custom" && row.customType === type)?.data;
const mode = manager => [...manager.getBranch()].reverse().find(row => row.type === "custom" && row.customType === "continuous-tasks:control-facts" && row.data.kind === "session-mode-changed")?.data;
try {
  process.env.PI_CODING_AGENT_DIR = sandbox;
  process.env.OWNED_HOST_MODULE_GOAL="Owned finite SDK management qualification";
  writeFileSync(join(sandbox, "fixed-input.txt"), "Owned finite SDK mode input\n");
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const freshLoader = async () => {
    const loader = new DefaultResourceLoader({ cwd: sandbox, agentDir: sandbox, settingsManager, additionalExtensionPaths: [join(root, "test/host-module-extension.ts")] });
    await loader.reload();
    return loader;
  };
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({ provider: "owned-management-faux", models: [{ id: "test", contextWindow: 128000 }] });
  faux.setResponses([
    tool("write_tasks", { mode: "replace", phases: [
      { title: "Owned work", tasks: [{ title: "First", prompt: "Finite fixture tracking only", profile: "main" }] },
      { title: "Owned acceptance", tasks: [{ title: "Second", prompt: "No business dispatch", profile: "main" }] },
    ] }, "mode-board"),
    tool("edit_tasks", { tasks: [{ id: "t-2.1", type: "blockers", data: { dependencies: ["t-1.1"] } }] }, "mode-dependency"),
    tool("compile_tasks", { finalAcceptanceTaskId: "t-2.1" }, "mode-compile"),
    fauxAssistantMessage("Owned plan ready; end this batch normally."),
    context => {
      assert.equal(context.tools?.length ?? 0, 0);
      reviewStarted = true;
      return new Promise(resolveReply => { release = () => resolveReply(fauxAssistantMessage(JSON.stringify({ action: "next_batch", message: "STALE_MODE_GUIDANCE_MUST_NOT_RUN", taskIds: ["t-1.1"], evidenceRefs: [] }))); });
    },
  ]);
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel("owned-management-faux", "test");
  assert(model);
  const manager = SessionManager.create(sandbox, join(sandbox, "sessions"));
  process.env.OWNED_HOST_MODULE_SESSION=manager.getSessionId();
  const create = async sm => {
    const result = await createAgentSession({ cwd: sandbox, agentDir: sandbox, modelRuntime: runtime, model, resourceLoader: await freshLoader(), settingsManager, sessionManager: sm, noTools: "builtin", customTools: [] });
    assert.deepEqual(result.extensionsResult.errors, []);
    session = result.session;
    session.subscribe(event => { if (event.type === "agent_start") agentStarts++; });
    await session.bindExtensions({ mode: "rpc", uiContext: { setStatus() {}, setWidget() {}, notify() {} }, onError: error => errors.push(error), commandContextActions: { waitForIdle: () => session.waitForIdle() } });
  };
  await create(manager);
  const command = session.extensionRunner.getCommand("task-supervisor");
  assert(command);
  void session.prompt("Exercise the owned trusted-host management mechanism").catch(error=>errors.push(error));
  await until(() => reviewStarted, "first real SDK advisor boundary");
  assert.equal(session.extensionRunner.createCommandContext().isIdle(), false);
  const beforeBoard = structuredClone(latest(manager, "continuous-tasks:snapshot"));
  const beforeStarts = agentStarts;
  await command.handler("disable", session.extensionRunner.createCommandContext());
  await session.waitForIdle();
  assert.equal(session.extensionRunner.createCommandContext().isIdle(), true);
  assert.equal(session.extensionRunner.createCommandContext().hasPendingMessages(), false);
  assert.equal(mode(manager)?.mode, "off");
  assert.equal(mode(manager)?.state, "active");
  assert.equal(mode(manager)?.activeWorkOwner, null);
  assert.equal(latest(manager, "continuous-tasks:supervisor")?.status, "stopped");
  assert.deepEqual(latest(manager, "continuous-tasks:snapshot").tasks, beforeBoard.tasks);
  release();
  await until(() => manager.getBranch().some(row => row.type === "custom" && row.customType === "continuous-tasks:control-facts" && row.data.kind === "advisor-call-observed"), "original-owner late/cancelled accounting");
  assert.equal(agentStarts, beforeStarts);
  assert.equal(latest(manager, "continuous-tasks:supervisor")?.status, "stopped");
  const continuationMessages = manager.getBranch().filter(row => row.type === "custom_message" && row.customType === "continuous-tasks:continue");
  assert(!continuationMessages.some(row => JSON.stringify(row.content).includes("STALE_MODE_GUIDANCE_MUST_NOT_RUN")));
  const writes = manager.getBranch().length;
  await command.handler("disable", session.extensionRunner.createCommandContext());
  assert.equal(manager.getBranch().length, writes);
  const gate = await session.extensionRunner.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "unmanaged-admission-only", input: { path: "not-executed" } });
  assert(!gate?.block, JSON.stringify(gate));
  const file = manager.getSessionFile();
  const bytes = readFileSync(file);
  await session.extensionRunner.emit({ type: "session_shutdown" });
  session.dispose();
  await create(SessionManager.open(file, join(sandbox, "sessions")));
  assert.equal(mode(session.sessionManager)?.mode, "off");
  assert(!session.extensionRunner.getActiveTools().includes("write_tasks"), JSON.stringify({ errors, tools: session.extensionRunner.getActiveTools() }));
  assert.equal(agentStarts, beforeStarts);
  assert.equal(Buffer.compare(bytes, readFileSync(file)), 0);
  assert.deepEqual(errors, []);
  assert.equal(settingsHash(), beforeSettings);
  session.dispose();
  delete process.env.OWNED_HOST_MODULE_GOAL;
  const textCases=[];
  for(const first of ["fresh","before","twice","after"]){
    const sm=SessionManager.create(sandbox,join(sandbox,`text-${first}`));
    await create(sm);
    const canonical=session.extensionRunner.getCommand("task-supervisor");assert(canonical);
    assert.equal(session.extensionRunner.getCommand("continuous-tasks"),undefined);
    if(first!=="fresh")await canonical.handler("tasks-only",session.extensionRunner.createCommandContext());
    if(first==="before"||first==="twice")await canonical.handler("disable",session.extensionRunner.createCommandContext());
    faux.setResponses([fauxAssistantMessage("Owned pure text only; no tools or business execution")]);
    await session.prompt("Persist one owned pure-text conversation");await session.waitForIdle();
    if(first==="after"||first==="twice")await canonical.handler("disable",session.extensionRunner.createCommandContext());
    const path=sm.getSessionFile();assert(existsSync(path));
    await session.extensionRunner.emit({type:"session_shutdown"});session.dispose();
    await create(SessionManager.open(path,join(sandbox,`text-${first}`)));
    assert(!session.extensionRunner.getActiveTools().includes("write_tasks"));
    assert.equal(mode(session.sessionManager)?.mode ?? "off","off");
    assert(!session.sessionManager.getBranch().some(row=>row.type === "custom" && row.customType === "continuous-tasks:supervisor" && row.data?.version === 3));
    textCases.push(first);session.dispose();
  }
  assert.deepEqual(errors,[]);assert.equal(settingsHash(),beforeSettings);
  passed = true;
  console.log(JSON.stringify({ result: "PASS", mode: "owned-sdk-disable-in-flight-review", sdk: sdk.VERSION, canonicalTasksOnlyPureTextMatrix:textCases, finiteMainActuallyBusyBeforeDisable: true, actualMainIdleAndNoPendingAfterDisable: true, oldAdvisorNotAdopted: true, originalOwnerAccountingRetained: true, noForcedTaskCompletion: true, repeatDisableNoWrite: true, coldRestoreOffNoDispatch: true, ordinaryUnmanagedAdmissionOnly: true, realSettingsUntouched: true, productionHumanProof: false, sourceBoundary: "Owned createAgentSession/SessionManager/faux-provider and real command-context waitForIdle; explicit trusted-host module initialization for busy-advisor checks and canonical tasks-only for actual pure-text persistence/reopen; no CLI/human or business acceptance" }));
} finally {
  release?.();
  session?.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  if(previousHostGoal===undefined)delete process.env.OWNED_HOST_MODULE_GOAL;else process.env.OWNED_HOST_MODULE_GOAL=previousHostGoal;
  if(previousHostSession===undefined)delete process.env.OWNED_HOST_MODULE_SESSION;else process.env.OWNED_HOST_MODULE_SESSION=previousHostSession;
  if (passed) rmSync(sandbox, { recursive: true, force: true });
  else console.error(`Owned failed SDK fixture retained: ${sandbox}`);
}
