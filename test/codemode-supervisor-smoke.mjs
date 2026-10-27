// Owned real SDK/Codemode only public sentinel. No live models, CLI/PTY or real-user proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  ModelRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "owned-codemode-supervisor-")),
  previous = process.env.PI_CODING_AGENT_DIR;
const events = [],
  errors = [],
  cacheSamples = [];
const startedAt = performance.now();
const checkCount = Number(process.env.P6_CHECK_COUNT ?? 1);
const rootTimeout = Number(process.env.P6_ROOT_TIMEOUT_MS ?? 5000);
const maxWait = Number(process.env.P6_MAX_WAIT_MS ?? 20000);
assert(Number.isInteger(maxWait) && maxWait >= 20000 && maxWait <= 190000);
assert(Number.isInteger(checkCount) && checkCount > 0 && checkCount <= 1000);
assert(Number.isInteger(rootTimeout) && rootTimeout >= 5000 && rootTimeout <= 180000);
const acceptFixture = process.env.P6_SMOKE_ACCEPT === "1";
const scenario = process.env.P6_SMOKE_SCENARIO ?? "normal";
assert(
  ["normal", "late-write", "store", "image", "models", "root-error", "timeout"].includes(scenario),
);
const negative = scenario !== "normal";
let modelCalls = 0;
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XQAAAAASUVORK5CYII=";
let session,
  passed = false,
  checkRuns = 0;
const latest = (manager) =>
  [...manager.getBranch()]
    .reverse()
    .find(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:supervisor" &&
        row.data.version === 3,
    )?.data;
const snapshot = (manager) =>
  [...manager.getBranch()]
    .reverse()
    .find((row) => row.type === "custom" && row.customType === "continuous-tasks:snapshot")?.data;
const plan =
  'await tools.write_tasks({mode:"replace",phases:[{title:"Owned check",tasks:[{title:"Owned final task",prompt:"Finite native check then safe completion",profile:"main"}]}]}); await tools.compile_tasks({finalAcceptanceTaskId:"t-1.1"}); return "Owned plan built";';
const extra =
  scenario === "late-write"
    ? "await tools.owned_write({});"
    : scenario === "store"
      ? 'store("owned_case",{value:1});'
      : scenario === "image"
        ? `image({type:"image",data:"${pixel}",mimeType:"image/png"});`
        : scenario === "models"
          ? 'text(await models.classify({provider:"owned-codemode-supervisor-faux",id:"owned-classifier"},{state:{owned:true},questions:{ok:{type:"bool",instructions:"Fixed owned fixture",criteria:{true:"yes",false:"no"}}}}));'
          : scenario === "root-error"
            ? 'throw new Error("Owned root failure after deferred request");'
            : scenario === "timeout"
              ? "while(true){}"
              : "";
const work =
  `await tools.get_ready_tasks({count:1}); await tools.advance_tasks({transitions:[{id:"t-1.1"}]}); let proof; for(let i=0;i<${checkCount};i++) proof = await tools.owned_check({}); try { text(await tools.advance_tasks({transitions:[{id:"t-1.1",evidence:{summary:"Actual owned child check",refs:[{kind:"command",label:"Owned check",status:"passed",ref:"tool:"+proof.id,exitCode:0}]}}]})); } catch(error) { text({completionError:String(error)}); }` +
  extra;
function code(code, id) {
  return (context) => {
    const declared = context.messages
      .flatMap((message) => (message.role === "system" ? (message.toolsAdded ?? []) : []))
      .map((tool) => tool.name);
    assert(declared.includes("codemode"));
    assert(!declared.includes("advance_tasks"));
    return fauxAssistantMessage(
      fauxToolCall(
        "codemode",
        {
          code: `// @options: {"timeout_ms": ${scenario === "timeout" && id === "owned-work-root" ? 1000 : rootTimeout}}\n${code}`,
        },
        { id },
      ),
      { stopReason: "toolUse" },
    );
  };
}
try {
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = async () => {
    throw Error("Owned Codemode fixture forbids network");
  };
  execFileSync("git", ["init", "--quiet", dir], { timeout: 2000, stdio: "ignore" });
  writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n!fixed-input.txt\n");
  writeFileSync(join(dir, "fixed-input.txt"), "Fixed owned native Codemode input\n");
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({
    provider: "owned-codemode-supervisor-faux",
    models: [{ id: "test", contextWindow: 128000 }],
  });
  faux.setResponses([
    code(plan, "owned-plan-root"),
    fauxAssistantMessage("Owned plan checkpoint."),
    fauxAssistantMessage(
      JSON.stringify({
        action: "next_batch",
        message: "Run the existing finite owned task",
        taskIds: ["t-1.1"],
        evidenceRefs: [],
      }),
    ),
    code(work, "owned-work-root"),
    fauxAssistantMessage("Owned bounded work checkpoint."),
    () => {
      const receipt = [...manager.getBranch()]
        .reverse()
        .find(
          (row) =>
            row.type === "custom" &&
            row.customType === "continuous-tasks:receipt-ledger" &&
            row.data.kind === "receipt" &&
            row.data.receipt.tool === "owned_check",
        )?.data.receipt;
      return fauxAssistantMessage(
        JSON.stringify({
          action: acceptFixture ? "accept" : "hold",
          message: "Owned finite fixture review only; not production/human acceptance",
          taskIds: acceptFixture ? ["t-1.1"] : [],
          evidenceRefs: acceptFixture && receipt ? [receipt.id] : [],
        }),
      );
    },
  ]);
  const classifier = {
    ...faux.models[0],
    id: "owned-classifier",
    type: "classifier",
    api: "owned-fixture-classifier",
  };
  runtime.registerNativeProvider({
    ...faux.provider,
    getAllModels: () => [...faux.models, classifier],
    classify: async (model) => {
      modelCalls++;
      return {
        provider: model.provider,
        model: model.id,
        answers: { ok: { type: "bool", probability: 1 } },
        stopReason: "stop",
        usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
      };
    },
  });
  const model = runtime.getModel("owned-codemode-supervisor-faux", "test");
  assert(model);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    codemode: { mode: "only" },
  });
  const observer = (pi) => {
    pi.events.on("owned-p6-cache-metrics", (metrics) => cacheSamples.push(metrics));
    for (const type of ["tool_call", "tool_result", "tool_execution_end"])
      pi.on(type, (event, ctx) => {
        events.push({
          type: event.type,
          id: event.toolCallId,
          parent: event.parentToolCallId ?? null,
          tool: event.toolName,
          isError: event.isError,
          taskStatus: snapshot(ctx.sessionManager)?.tasks[0]?.status,
          ...(event.type === "tool_result"
            ? { completionState: event.details?.completionState }
            : {}),
        });
      });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      join(
        root,
        process.env.P6_CACHE_METRICS === "1"
          ? "test/codemode-owned-metrics-extension.ts"
          : "src/index.ts",
      ),
    ],
    extensionFactories: [
      {
        name: "codemode",
        builtin: true,
        factory: createCodemodeExtension({ mode: "only", models: scenario === "models" }),
      },
      observer,
    ],
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime: runtime,
    model,
    sessionManager: manager,
    settingsManager,
    resourceLoader: loader,
    noTools: "builtin",
    tools: ["+codemode"],
    customTools: [
      {
        name: "owned_write",
        label: "Owned same-byte write",
        description: "Actually rewrites only the fixed private input to identical bytes",
        parameters: Type.Object({}),
        execute: async () => {
          writeFileSync(join(dir, "fixed-input.txt"), "Fixed owned native Codemode input\n");
          return {
            content: [{ type: "text", text: "Owned same-byte write completed" }],
            details: {},
            structuredContent: { exit_code: 0 },
          };
        },
      },
      {
        name: "owned_check",
        label: "Owned finite native check",
        description:
          "Reads the fixed private input and returns actual structured zero only when it matches",
        parameters: Type.Object({}),
        outputSchema: Type.Object({ id: Type.String(), exit_code: Type.Integer() }),
        execute: async (id) => {
          checkRuns++;
          assert.equal(
            readFileSync(join(dir, "fixed-input.txt"), "utf8"),
            "Fixed owned native Codemode input\n",
          );
          return {
            content: [{ type: "text", text: "Owned native check passed" }],
            details: {},
            structuredContent: { id, exit_code: 0 },
          };
        },
      },
    ],
  });
  assert.deepEqual(created.extensionsResult.errors, []);
  session = created.session;
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { setWidget() {}, setStatus() {}, notify() {} },
    onError: (error) => errors.push(error),
    commandContextActions: { waitForIdle: () => session.waitForIdle() },
  });
  const command = session.extensionRunner.getCommand("task-supervisor");
  assert(command);
  await command.handler(
    "supervise-legacy Owned native Codemode-only sentinel",
    session.extensionRunner.createCommandContext(),
  );
  const deadline = Date.now() + maxWait;
  while (!["paused", "fault", "completed"].includes(latest(manager)?.status)) {
    if (Date.now() > deadline)
      throw Error(`Owned sample did not settle: ${JSON.stringify(latest(manager))}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  await session.waitForIdle();
  const result = manager
    .getBranch()
    .find(
      (row) =>
        row.type === "message" &&
        row.message.role === "toolResult" &&
        row.message.toolCallId === "owned-work-root",
    );
  const text =
    result?.message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n") ?? "";
  const diagnostic = {
    goalAccepted: latest(manager)?.status === "completed",
    taskStatus: snapshot(manager)?.tasks[0]?.status,
    checkRuns,
    events,
    rootResult: result?.message,
    supervisorStatus: latest(manager)?.status,
    errors,
  };
  if (process.env.P6_SMOKE_DIAGNOSTIC)
    writeFileSync(process.env.P6_SMOKE_DIAGNOSTIC, JSON.stringify(diagnostic, null, 2), {
      flag: "wx",
    });
  assert.equal(checkRuns, checkCount);
  assert.deepEqual(errors, []);
  assert.match(
    text,
    /"completionState"\s*:\s*"deferred"/,
    "Nested done must return a real deferred intent, never immediate fake completion or flat-receipt rejection",
  );
  const nested = events.find(
    (event) =>
      event.type === "tool_result" &&
      event.tool === "advance_tasks" &&
      event.parent === "owned-work-root" &&
      event.taskStatus === "reviewing" &&
      event.completionState === "deferred",
  );
  assert(nested);
  const rootEnd = events.find(
    (event) => event.type === "tool_execution_end" && event.id === "owned-work-root",
  );
  assert.equal(
    rootEnd?.taskStatus,
    "reviewing",
    "Kernel end notification is not immediate task completion",
  );
  assert.equal(snapshot(manager)?.tasks[0]?.status, negative ? "reviewing" : "done");
  if (negative) assert.notEqual(latest(manager)?.status, "completed");
  if (acceptFixture && !negative)
    assert.equal(
      latest(manager)?.status,
      "completed",
      "Final review must consume the same actual appended qualification",
    );
  const ledgerReceipt = manager
    .getBranch()
    .find(
      (row) =>
        row.type === "custom" &&
        row.customType === "continuous-tasks:receipt-ledger" &&
        row.data.kind === "receipt" &&
        row.data.receipt.tool === "owned_check",
    )?.data.receipt;
  assert.equal(ledgerReceipt?.eligible, false, "Original child receipt eligibility is immutable");
  if (checkCount > 256) {
    assert.equal(result.message.nestedCalls.complete, false);
    assert.equal(result.message.nestedCalls.calls.length, 256);
    const facts = manager
      .getBranch()
      .filter((row) => row.type === "custom" && row.customType === "continuous-tasks:control-facts")
      .map((row) => row.data);
    const rootStart = facts.find(
      (row) => row.kind === "invocation-started" && row.toolCallId === "owned-work-root",
    );
    const seal = facts.find(
      (row) => row.kind === "invocation-root-sealed" && row.rootId === rootStart?.operationId,
    );
    assert.equal(
      facts.filter(
        (row) =>
          row.kind === "invocation-started" &&
          row.rootId === rootStart?.operationId &&
          row.toolName === "owned_check",
      ).length,
      checkCount,
    );
    assert.equal(seal?.outcome, "qualified");
    assert.equal(seal.started, checkCount + 4);
    assert.equal(seal.ended, checkCount + 4);
  }
  assert.equal(
    manager
      .getBranch()
      .filter(
        (row) =>
          row.type === "custom" &&
          row.customType === "continuous-tasks:control-facts" &&
          row.data.kind === "completion-intent-disposed" &&
          row.data.outcome === "applied",
      ).length,
    negative ? 0 : 1,
  );
  if (negative)
    assert.equal(
      manager
        .getBranch()
        .filter(
          (row) =>
            row.type === "custom" &&
            row.customType === "continuous-tasks:control-facts" &&
            row.data.kind === "completion-intent-disposed" &&
            row.data.outcome === "invalidated",
        ).length,
      1,
    );
  assert.equal(modelCalls, scenario === "models" ? 1 : 0);
  assert.equal(faux.getPendingResponseCount(), negative ? 1 : 0);
  if (process.env.P6_SMOKE_FIXTURE)
    writeFileSync(resolve(process.env.P6_SMOKE_FIXTURE), readFileSync(manager.getSessionFile()), {
      flag: "wx",
    });
  const cacheMetrics = cacheSamples.at(-1);
  if (process.env.P6_CACHE_METRICS === "1") {
    assert(
      cacheMetrics?.decode.decodedNodes > 0 && cacheMetrics.fold.hits > 0,
      "Counters must belong to the actual SDK-loaded candidate modules, never a separate empty module",
    );
  }
  passed = true;
  console.log(
    JSON.stringify({
      result: "PASS",
      mode: "owned-real-sdk-codemode-only",
      scenario,
      checkCount,
      rootTimeout,
      maxWait,
      cacheMetrics,
      cacheMetricsBoundary: cacheMetrics ? "last-actual-main-agent-end" : undefined,
      durationMs: Math.round(performance.now() - startedAt),
      heapBytes: process.memoryUsage().heapUsed,
      maxRssKiB: process.resourceUsage().maxRSS,
      modelCalls,
      actualChecks: checkRuns,
      deferredObserved: true,
      taskStatus: snapshot(manager)?.tasks[0]?.status,
      goalAccepted: diagnostic.goalAccepted,
      productionHumanProof: false,
      sourceBoundary:
        "Explicit legacy fixture start; native SDK parent events and real finite check, not real user identity",
    }),
  );
} finally {
  session?.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  if (passed) rmSync(dir, { recursive: true, force: true });
  else console.error(`Owned Codemode sentinel failure retained: ${dir}`);
}
