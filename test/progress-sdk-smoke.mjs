// Owned SDK/faux-provider progress qualification; not CLI/human/business acceptance.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "owned-progress-sdk-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const previousHostGoal=process.env.OWNED_HOST_MODULE_GOAL;
const previousHostSession=process.env.OWNED_HOST_MODULE_SESSION;
let session,
  passed = false,
  edits = 0;
const errors = [];
const correction = process.argv.includes("--correction");
const goal = "Owned four-step implementing progress";
const tool = (name, args, id) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const latest = (manager) =>
  [...manager.getBranch()]
    .reverse()
    .find(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:supervisor" &&
        row.data.version === 3,
    )?.data;
const facts = (manager) =>
  manager
    .getBranch()
    .filter(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:control-facts" &&
        row.data.kind === "progress-observed",
    );
try {
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.OWNED_HOST_MODULE_GOAL=goal;
  execFileSync("git", ["init", "--quiet", dir], { stdio: "ignore", timeout: 2000 });
  writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n!fixed-input.txt\n");
  writeFileSync(join(dir, "fixed-input.txt"), "Initial owned implementation\n");
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({
    provider: "owned-progress-faux",
    models: [{ id: "test", contextWindow: 128000 }],
  });
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  process.env.OWNED_HOST_MODULE_SESSION=manager.getSessionId();
  const advice = (action, count) => (context) => {
    const packet = JSON.parse(
      context.messages.findLast((message) => message.role === "user").content,
    );
    assert.equal(packet.goal, goal);
    assert.equal(packet.progress.credited, count);
    return fauxAssistantMessage(
      JSON.stringify({
        action,
        message:
          action === "hold"
            ? "Owned bounded sample complete; no goal acceptance"
            : "Continue same authorized implementing work",
        taskIds: ["t-1.1"],
        evidenceRefs: [],
      }),
    );
  };
  faux.setResponses([
    tool(
      "write_tasks",
      {
        mode: "replace",
        phases: [
          {
            title: "Implement",
            tasks: [
              { title: "Implement", prompt: "Four actual finite file changes", profile: "main" },
            ],
          },
          {
            title: "Accept",
            tasks: [{ title: "Acceptance", prompt: "Do not force completion", profile: "main" }],
          },
        ],
      },
      "plan",
    ),
    tool(
      "edit_tasks",
      { tasks: [{ id: "t-2.1", type: "blockers", data: { dependencies: ["t-1.1"] } }] },
      "deps",
    ),
    tool("compile_tasks", { finalAcceptanceTaskId: "t-2.1" }, "compile"),
    fauxAssistantMessage("Plan ready; finish this batch normally."),
    ...(correction ? [advice("guide", 0)] : []),
    advice("next_batch", 0),
    tool("get_ready_tasks", { count: 1 }, "claim"),
    ...[1, 2, 3, 4].flatMap((i) => [
      tool("edit_progress_fixture", { value: i }, `edit-${i}`),
      fauxAssistantMessage(`Owned real edit ${i} complete; same task still implementing.`),
      advice(i === 4 ? "hold" : "guide", i),
    ]),
  ]);
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel("owned-progress-faux", "test");
  assert(model);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = async () => {
    const value = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      additionalExtensionPaths: [join(root, "test/host-module-extension.ts")],
    });
    await value.reload();
    return value;
  };
  const create = async (sm) => {
    const result = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model,
      sessionManager: sm,
      settingsManager,
      resourceLoader: await loader(),
      noTools: "builtin",
      customTools: [
        {
          name: "edit_progress_fixture",
          label: "Owned edit",
          description: "Change only a fixed private fixture input",
          parameters: Type.Object({ value: Type.Integer({ minimum: 1, maximum: 4 }) }),
          execute: async (_id, args) => {
            edits++;
            writeFileSync(
              join(dir, "fixed-input.txt"),
              `Actual owned implementation ${args.value}\n`,
            );
            return {
              content: [{ type: "text", text: "Finite input changed" }],
              structuredContent: { exit_code: 0 },
            };
          },
        },
      ],
    });
    assert.deepEqual(result.extensionsResult.errors, []);
    session = result.session;
    await session.bindExtensions({
      mode: "rpc",
      uiContext: { setWidget() {}, setStatus() {}, notify() {} },
      onError: (error) => errors.push(error),
      commandContextActions: { waitForIdle: () => session.waitForIdle() },
    });
  };
  await create(manager);
  const command = session.extensionRunner.getCommand("task-supervisor");
  assert(command);
  void session.prompt("Exercise the owned trusted-host progress mechanism").catch(error=>errors.push(error));
  const deadline = Date.now() + 15000;
  while (latest(manager)?.status !== "paused") {
    if (Date.now() > deadline)
      throw Error(`Owned progress sample did not settle: ${JSON.stringify(latest(manager))}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  await session.waitForIdle();
  assert.equal(edits, 4);
  const batchAdvice = manager
    .getBranch()
    .filter(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:control-facts" &&
        row.data.kind === "batch-advice-observed",
    );
  assert.equal(batchAdvice.filter((row) => !row.data.valid).length, correction ? 1 : 0);
  const calls = manager
    .getBranch()
    .filter(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:control-facts" &&
        row.data.kind === "advisor-call-started",
    );
  assert.equal(calls.length, correction ? 6 : 5);
  assert.equal(latest(manager).stagnant, 0);
  assert.equal(latest(manager).holdCause, "advisor_hold");
  assert.equal(facts(manager).filter((row) => row.data.result === "changed").length, 4);
  const board = [...manager.getBranch()]
    .reverse()
    .find((row) => row.type === "custom" && row.customType === "continuous-tasks:snapshot").data;
  assert.equal(board.tasks[0].status, "implementing");
  const bytes = readFileSync(manager.getSessionFile());
  const file = manager.getSessionFile();
  if (process.env.P5_SDK_PREFIX) {
    const prefix = process.env.P5_SDK_PREFIX;
    assert(/^p5-[A-Za-z0-9_-]{1,60}$/.test(prefix));
    const artifacts = resolve(root, "../control-remediation-artifacts");
    const fixture = join(artifacts, `${prefix}-fixture.jsonl`);
    writeFileSync(fixture, bytes, { flag: "wx" });
    writeFileSync(
      join(artifacts, `${prefix}-input.json`),
      JSON.stringify({
        sessionFile: fixture,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        changedFacts: 4,
        calls: calls.length,
        correction,
        ownerKind: "goal",
        productionHumanProof: false,
      }),
      { flag: "wx" },
    );
  }
  await session.extensionRunner.emit({ type: "session_shutdown" });
  session.dispose();
  await create(SessionManager.open(file, join(dir, "sessions")));
  assert.equal(facts(session.sessionManager).length, 4);
  assert.equal(Buffer.compare(bytes, readFileSync(file)), 0);
  assert.deepEqual(errors, []);
  assert.equal(faux.getPendingResponseCount(), 0);
  passed = true;
  console.log(
    JSON.stringify({
      result: "PASS",
      mode: "owned-sdk-progress-four-edits",
      actualEdits: edits,
      durableChangedFacts: 4,
      boundedActionCorrection: correction,
      actualAdvisorCalls: calls.length,
      sameTaskStillImplementing: true,
      stagnant: 0,
      actualAdvisorHoldPreserved: true,
      coldRestoreNoReplay: true,
      productionHumanProof: false,
      sourceBoundary:
        "Owned real SDK/custom finite file tool/faux provider; explicit trusted-host module initialization (not a user command/approval), progress is not business acceptance",
    }),
  );
} finally {
  session?.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  if(previousHostGoal===undefined)delete process.env.OWNED_HOST_MODULE_GOAL;else process.env.OWNED_HOST_MODULE_GOAL=previousHostGoal;
  if(previousHostSession===undefined)delete process.env.OWNED_HOST_MODULE_SESSION;else process.env.OWNED_HOST_MODULE_SESSION=previousHostSession;
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Owned progress SDK failure retained: ${dir}`);
}
