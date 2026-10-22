import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const longReceipts = process.argv.includes("--long-receipts");
const receiptReadCount = longReceipts ? Number(process.env.PI_RECEIPT_SMOKE_COUNT ?? 1000) : 0;
if (!Number.isSafeInteger(receiptReadCount) || receiptReadCount < 0 || receiptReadCount > 1000)
  throw new Error("Invalid bounded smoke read count");
const batchContinuation = process.argv.includes("--batch-continuation");
const batchStopAdvice = "本批已经完成。现在整体暂停，不领取下一批任务，等待用户确认。";
const preflight = process.argv.includes("--preflight");
const asyncExecution = process.argv.includes("--async-execution");
const compaction = process.argv.includes("--compaction");
const nativeAbort = process.argv.includes("--native-abort");
const ordinaryPause = process.argv.includes("--ordinary-pause");
const interruptCompaction =
  process.argv.includes("--interrupt-compaction") || nativeAbort || ordinaryPause;
const supervised =
  process.argv.includes("--supervised") ||
  batchContinuation ||
  longReceipts ||
  compaction ||
  interruptCompaction ||
  asyncExecution ||
  preflight;
let smokeEventBus;
let interruptedReviewStarted = false;
let releaseInterruptedReview;
let completedCompactions = 0;
let advisoryChecks = 0;
const goal = "Verify the approved local smoke work";
const preflightProposal = {
  summary: "Verify local SDK fixtures without external effects",
  steps: ["Run the two-task SDK fixture"],
  acceptance: ["Fresh host receipts and final acceptance"],
  permissions: ["A1", "A2"].map((id) => ({
    id,
    action: id === "A1" ? "Run approved local fixture" : "Optional alternative fixture",
    target: "Isolated smoke directory",
    environment: "Local faux SDK only",
    required: id === "A1",
    limits: "One isolated fixture; no real business execution",
    risks: "Temporary local files",
    fallback: "Use only A1",
    reconfirm: "Changed scope or external effects",
  })),
  prohibitions: ["No settings, credentials, dependencies or business execution"],
  reconfirm: ["Material proposal changes"],
};
function latestPreflight(manager) {
  return [...manager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === "continuous-tasks:preflight")
    ?.data;
}
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

// Native built-in themes, resolved from this SDK; no theme/settings mutation.
const { getThemeByName } = await import(
  new URL(
    "./modes/interactive/theme/theme.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ).href
);
const widgetThemes = ["system", "dark", "light"].map((name) => {
  const theme = getThemeByName(name);
  if (!theme) throw new Error(`Native theme unavailable: ${name}`);
  return theme;
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "src", "index.ts");
const sandbox = mkdtempSync(join(tmpdir(), "pi-task-supervisor-smoke-"));
const realSettings = join(homedir(), ".pi", "agent", "settings.json");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousArgv = process.argv;
const ttyDescriptors = [process.stdin, process.stdout].map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
let preflightApprovalEnabled = false;
let session;

function digest(path) {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex")
    : "absent";
}

function tool(name, args, id) {
  return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
}

function latestSupervisor(manager) {
  const branch = manager.getBranch();
  const state = [...branch]
    .reverse()
    .find(
      (entry) => entry.type === "custom" && entry.customType === "continuous-tasks:supervisor",
    )?.data;
  if (state?.version !== 3) return state;
  // Inspection only. The extension validates actual ledger/checkpoint closure on recovery.
  const base = state.receiptLedger.legacyBase;
  const receipts = base ? [...branch.find((entry) => entry.id === base.entryId).data.receipts] : [];
  const records = branch.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === "continuous-tasks:receipt-ledger" &&
      entry.data.sessionId === state.sessionId &&
      entry.data.goalId === state.receiptLedger.goalId,
  );
  for (const entry of records) if (entry.data.kind === "receipt") receipts.push(entry.data.receipt);
  return { ...state, epoch: records.at(-1)?.data.epoch ?? state.epoch, receipts };
}

function advisory(action, taskIds = ["t-2.1"]) {
  return (context) => {
    if (context.tools?.length) throw new Error("Supervisor was given executor tools");
    const content = context.messages.findLast((message) => message.role === "user")?.content;
    const packet = JSON.parse(
      typeof content === "string" ? content : content.map((item) => item.text ?? "").join(""),
    );
    if (packet.goal !== goal || !packet.board)
      throw new Error("Durable supervisor goal/board missing");
    advisoryChecks++;
    if (
      preflight &&
      (JSON.stringify(packet.preflight?.proposal) !== JSON.stringify(preflightProposal) ||
        JSON.stringify(packet.preflight?.approval.permissionIds) !== JSON.stringify(["A1"]))
    )
      throw new Error("Advisor lost full exact preflight scope/selected permission set");
    if (
      compaction &&
      advisoryChecks === 2 &&
      (completedCompactions !== 1 ||
        !packet.receipts.some(
          (receipt) => receipt.id === "tool:implementation-validation" && receipt.ok,
        ))
    )
      throw new Error("Advisor lost actual host evidence after automatic compaction");
    if (action === "accept" && packet.acceptanceBlocker !== null)
      throw new Error(`Acceptance blocked: ${packet.acceptanceBlocker}`);
    return fauxAssistantMessage(
      JSON.stringify({
        action,
        message:
          action === "next_batch"
            ? batchContinuation && taskIds.includes("t-2.1")
              ? batchStopAdvice
              : "Claim the next approved batch and collect fresh host validation during review."
            : "All approved work has host validation.",
        taskIds,
        evidenceRefs: action === "next_batch" ? [] : ["tool:final-validation"],
      }),
    );
  };
}

function interruptedAdvisory(context) {
  const packet = JSON.parse(
    context.messages.findLast((message) => message.role === "user").content,
  );
  if (packet.goal !== goal || context.tools?.length)
    throw new Error("Invalid interrupted review context");
  advisoryChecks++;
  interruptedReviewStarted = true;
  return new Promise((resolveReply) => {
    releaseInterruptedReview = () =>
      resolveReply(
        fauxAssistantMessage(
          JSON.stringify({
            action: "next_batch",
            message: "Stale advice must never be delivered",
            taskIds: ["t-1.1"],
            evidenceRefs: [],
          }),
        ),
      );
  });
}

async function waitUntil(check, description) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`Timed out: ${description}`);
}

function latestSnapshot(sessionManager) {
  return [...sessionManager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === "continuous-tasks:snapshot")
    ?.data;
}

async function loadExtension(settingsManager) {
  smokeEventBus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: sandbox,
    settingsManager,
    eventBus: smokeEventBus,
    additionalExtensionPaths: [
      extensionPath,
      ...(compaction || interruptCompaction ? [join(sandbox, "compact-fixture.mjs")] : []),
      ...(asyncExecution ? [join(sandbox, "async-fixture.mjs")] : []),
    ],
  });
  await loader.reload();
  return loader;
}

async function waitForCompletion(sessionManager) {
  for (let attempt = 0; attempt < (longReceipts ? 5000 : 500); attempt++) {
    const snapshot = latestSnapshot(sessionManager);
    if (
      snapshot?.workflowStatus === "completed" &&
      (!supervised || latestSupervisor(sessionManager)?.status === "completed")
    )
      return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(
    `Timed out waiting for completion: ${JSON.stringify({
      supervisor: latestSupervisor(sessionManager),
      snapshot: latestSnapshot(sessionManager),
      completedCompactions,
      advisoryChecks,
      recent: sessionManager.getBranch().slice(-6),
    })}`,
  );
}

const settingsDigestBefore = digest(realSettings);
process.env.PI_CODING_AGENT_DIR = sandbox;

try {
  if (preflight) {
    // Explicit source-boundary mechanism simulation only, NOT a real CLI/human positive.
    // The separate real double-TTY SDK-negative and actual CLI/PTY tests stay unchanged.
    const sdkRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
    process.argv = [process.execPath, join(sdkRoot, "dist", "cli.js"), ...previousArgv.slice(2)];
    for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    console.log("PREFLIGHT SDK SOURCE-BOUNDARY SIMULATION (argv/TTY/UI mocked; not native CLI or human proof)");
  }
  const sessionManager = SessionManager.create(sandbox, join(sandbox, "sessions"));
  writeFileSync(
    join(sandbox, "continuous-tasks.json"),
    JSON.stringify({
      countdownMs: 0,
      maxStagnantSettles: 5,
      requireCompletionEvidence: true,
    }),
  );

  if (compaction || interruptCompaction)
    writeFileSync(
      join(sandbox, "compact-fixture.mjs"),
      `
    ${latestSupervisor.toString()}
    export default function (pi) {
      pi.on("session_before_compact", (event) => {
        if (event.reason !== ${JSON.stringify(interruptCompaction ? "manual" : "threshold")} || event.willRetry) throw new Error("Unexpected smoke compaction trigger");
        const state = latestSupervisor({ getBranch: () => event.branchEntries });
        if (state?.goal !== ${JSON.stringify(goal)} || state.receipts.length !== ${interruptCompaction ? 0 : 1} || state.bindings.length !== ${interruptCompaction ? 0 : 1})
          throw new Error("Durable supervised evidence was not ready before compaction");
        return { compaction: {
          summary: "Smoke history compacted; durable task journal is authoritative.",
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
        } };
      });
    }
  `,
    );
  if (asyncExecution)
    writeFileSync(
      join(sandbox, "async-fixture.mjs"),
      `
      export default function(pi) {
        let ctx; let state = "running";
        pi.on("session_start", (_event, context) => { ctx = context; });
        pi.events.on("subagents:rpc:v1:request", (request) => {
          const data = request.method === "ping" ? {
            version: 1,
            session: { sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() ?? null },
            events: { asyncComplete: "subagent:async-complete" },
            capabilities: { asyncStatusSnapshot: { kind: "pi-subagents.async-status-snapshot", version: 1 } },
          } : { asyncSnapshot: {
            kind: "pi-subagents.async-status-snapshot", version: 1, generatedAt: Date.now(),
            omitted: { runs: 0, children: 0, byteLimitExceeded: false },
            runs: [{ id: "smoke-run-1", kind: "subagent", state }],
          } };
          pi.events.emit("subagents:rpc:v1:reply:" + request.requestId, {
            version: 1, requestId: request.requestId, method: request.method, success: true, data,
          });
        });
        pi.events.on("smoke:complete", () => {
          state = "complete";
          pi.events.emit("subagent:async-complete", {
            sessionId: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(),
            runId: "smoke-run-1", success: true,
          });
          pi.sendMessage({ customType: "smoke:executor-result", content: "Faux execution completed. Inspect and validate its result.", display: false },
            { triggerTurn: true, deliverAs: "followUp" });
        });
      }
    `,
    );
  const settingsManager = SettingsManager.inMemory(
    compaction || interruptCompaction
      ? {
          // Arm automatic compaction only after the fixture has bound validation.
          // Pi 1.2 also checks thresholds between turns, before the next assistant response.
          compaction: { enabled: false, reserveTokens: 4096, keepRecentTokens: 128 },
        }
      : {},
  );
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
  const proof = (ref) =>
    supervised
      ? {
          summary: "Fresh faux host validation passed",
          refs: [
            {
              kind: "command",
              label: "local validation",
              status: "passed",
              exitCode: 0,
              ref: `tool:${ref}`,
            },
          ],
        }
      : evidence;
  const validationTool = {
    name: "validate_smoke",
    label: "Validate Smoke",
    description: "Deterministic local smoke validation only; no shell or network execution",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "Faux host validation passed" }],
      details: {},
      structuredContent: { exit_code: 0 },
    }),
  };
  const readTool = {
    name: "read",
    label: "Inspect receipt fixture",
    description: "Pure isolated fixture read",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "Isolated read-only fixture" }],
      details: {},
    }),
  };
  const faux = fauxProvider({
    provider: "pi-task-supervisor-faux",
    models: [{ id: "test", contextWindow: compaction ? 8192 : 128000 }],
  });
  // The faux provider computes usage from text; this bounded padding crosses the native threshold.
  const compactionStop = fauxAssistantMessage(
    "Implementation verified; final acceptance remains. " + "local faux padding ".repeat(350),
  );
  faux.setResponses([
    ...(preflight
      ? [
          (context) => {
            const plan = latestPreflight(sessionManager);
            if (
              !plan ||
              plan.phase !== "planning" ||
              context.tools?.some((item) => item.name === "write_tasks")
            )
              throw new Error("Planning exposed execution tools or lost human context");
            return tool(
              "submit_preflight",
              { preflightId: plan.preflightId, proposal: preflightProposal },
              "proposal-only",
            );
          },
          fauxAssistantMessage(
            "Read-only proposal submitted; awaiting exact human approval and separate start.",
          ),
        ]
      : []),
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
    ...(supervised ? [interruptCompaction ? interruptedAdvisory : advisory("next_batch", ["t-1.1"])] : []),
    tool("get_ready_tasks", { count: 1 }),
    ...(asyncExecution
      ? [
          tool("workflow_gate", {
            action: "bind_execution",
            taskId: "t-1.1",
            executionRef: { source: "pi-subagents", runId: "smoke-run-1" },
          }),
          fauxAssistantMessage("Waiting for the existing background execution."),
          tool("workflow_gate", {
            action: "clear_execution",
            taskId: "t-1.1",
            executionRef: { source: "pi-subagents", runId: "smoke-run-1" },
          }),
        ]
      : []),
    tool("advance_tasks", { transitions: [{ id: "t-1.1" }] }),
    ...(supervised ? [tool("validate_smoke", {}, "implementation-validation")] : []),
    ...Array.from({ length: receiptReadCount }, (_, i) => tool("read", {}, `history-${i}`)),
    tool("advance_tasks", {
      transitions: [{ id: "t-1.1", evidence: proof("implementation-validation") }],
    }),
    ...(compaction || batchContinuation
      ? [
          compaction
            ? compactionStop
            : fauxAssistantMessage("First batch verified; yielding to the next-batch checkpoint."),
          advisory("next_batch"),
        ]
      : []),
    (context) => {
      if (batchContinuation) {
        const next = sessionManager.getBranch().findLast(
          (entry) => entry.type === "custom_message" && entry.customType === "continuous-tasks:continue",
        );
        const board = latestSnapshot(sessionManager);
        const state = latestSupervisor(sessionManager);
        if (
          next?.details?.action !== "next_batch" ||
          !next.content.includes("get_ready_tasks") ||
          !next.content.includes("not a goal pause") ||
          JSON.stringify(context.messages).includes(batchStopAdvice) ||
          board.tasks[0].status !== "done" ||
          board.tasks[1].status !== "ready" ||
          state.status !== "active" ||
          state.continuations !== 2 ||
          state.stagnant !== 0
        )
          throw new Error("Batch handoff forwarded contradictory prose, lost host control, or spun without progress");
      }
      return tool("get_ready_tasks", { count: 1 });
    },
    tool("advance_tasks", { transitions: [{ id: "t-2.1" }] }),
    ...(supervised ? [tool("validate_smoke", {}, "final-validation")] : []),
    tool("advance_tasks", { transitions: [{ id: "t-2.1", evidence: proof("final-validation") }] }),
    fauxAssistantMessage("All approved phases are complete."),
    ...(supervised ? [advisory("accept")] : []),
  ]);

  const modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  modelRuntime.registerNativeProvider(faux.provider);
  const model = modelRuntime.getModel("pi-task-supervisor-faux", "test");
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
    customTools: supervised ? [validationTool, ...(longReceipts ? [readTool] : [])] : [],
  });
  if (created.extensionsResult.errors.length > 0) {
    throw new Error(`Extension load failed: ${JSON.stringify(created.extensionsResult.errors)}`);
  }
  session = created.session;
  const extensionErrors = [];
  const widgetHistory = [];
  let reviewedWidgetPublication = false;
  let widgetLines = [];
  const uiScriptErrors = [];
  const scopeMaterial = [];
  const boardMaterial = [];
  let customMode = "scope";
  function assertNoUiScriptErrors() {
    if (uiScriptErrors.length) throw uiScriptErrors[0];
  }
  let taskDetails = "";
  // Real SDK callbacks with a UI stub, not a real terminal or human visual certification.
  const uiContext = {
    setStatus() {},
    notify(message) {
      taskDetails = message;
    },
    async select(_title, options) {
      if (preflight && options.includes("允许上述范围") && options.includes("稍后决定")) return preflightApprovalEnabled ? "允许上述范围" : "稍后决定";
      if (preflight && options.includes("开始执行")) return "开始执行";
      return options[0];
    },
    custom(factory) {
      return new Promise((resolveCustom, rejectCustom) => {
        try {
          let completed = false;
          let originalRendered = false;
          const component = factory(
            { terminal: { rows: 40 }, requestRender() {} }, widgetThemes[0],
            new KeybindingsManager(TUI_KEYBINDINGS),
            (value) => { completed = true; resolveCustom(value); },
          );
          const render = (width = 120) => {
            const lines = component.render(width).map(stripTerminalSequences);
            if (customMode === "scope") {
              if (lines[0] === "只读核对（非作答）") {
                originalRendered = true;
                scopeMaterial.push(lines.join("\n"));
              }
            } else boardMaterial.push(lines.join("\n"));
            return lines.join("\n");
          };
          const press = (key) => { component.handleInput(key); return render(); };
          render();
          if (customMode === "scope") {
            for (let page = 0; page < 10000 && !completed; page++) {
              const header = render().split("\n")[0];
              if (header !== "只读核对（非作答）" && header !== "格式化浏览（非核对、非作答）")
                throw new Error("Expected actual formatted/original scope-review page");
              press("\r");
            }
            if (!originalRendered) throw new Error("Formatted browsing cannot replace original review");
          } else {
            const detail = () => {
              press("\r");
              let previous = render();
              for (let line = 0; line < 10000; line++) {
                const next = press("\u001b[B");
                if (next === previous) { press("\u001b"); return; }
                previous = next;
              }
              throw new Error("Read-only detail never reached its end");
            };
            // The three fixed routes remain stable; phase headings are now selectable.
            for (let item = 1; item <= 2; item++) { press("\u001b[B"); detail(); }
            for (const id of ["t-1.1", "t-2.1"]) {
              let found = false;
              for (let step = 0; step < 250; step++) {
                const selected = render(80).split("\n").find((line) => line.startsWith("→ ")) ?? "";
                if (selected.includes(` · ${id} `)) { detail(); found = true; break; }
                if (selected.startsWith("→ ▸")) press("\r");
                press("\u001b[B");
              }
              if (!found) throw new Error(`Original task detail not reachable: ${id}`);
            }
            press("\u001b");
          }
          if (!completed) throw new Error("Real custom component did not finish");
        } catch (error) {
          uiScriptErrors.push(error);
          rejectCustom(error);
        }
      });
    },
    setWidget(key, content, options) {
      try {
      if (key !== "continuous-tasks:board") throw new Error(`Unexpected widget: ${key}`);
      widgetLines = [];
      if (content) {
        if (typeof content !== "function" || options?.placement !== "aboveEditor")
          throw new Error("Widget did not use the bounded above-editor component");
        for (const theme of widgetThemes) {
          const component = content(undefined, theme);
          for (const width of [0, 1, 2, 35, 72, 120]) {
            const lines = component.render(width);
            if (
              lines.length > 8 ||
              lines.some(
                (line) =>
                  visibleWidth(line) > width || /\p{Cc}/u.test(stripTerminalSequences(line)),
              )
            )
              throw new Error(`Widget exceeded terminal width/row limits in ${theme.name}`);
          }
          const plain = component.render(72).map(stripTerminalSequences);
          if (widgetLines.length && JSON.stringify(plain) !== JSON.stringify(widgetLines))
            throw new Error("Theme changed task-board content or alignment");
          widgetLines = plain;
        }
      }
      widgetHistory.push([...widgetLines]);
      if (latestSupervisor(sessionManager)?.status === "reviewing" && widgetLines.some((line) =>
        line.includes("监督检查中") || line.includes("宿主工作中"))) reviewedWidgetPublication = true;
      } catch (error) { uiScriptErrors.push(error); throw error; }
    },
  };
  const uiBindings = {
    mode: "tui",
    uiContext,
    onError: (error) => extensionErrors.push(error),
    commandContextActions: { waitForIdle: () => session.waitForIdle() },
  };
  await session.bindExtensions(uiBindings);
  assertNoUiScriptErrors();
  if (widgetLines.length) throw new Error("Fresh session had a stale task widget");
  if (session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("A fresh session exposed task tools before user activation");
  }
  const enableCommand = session.extensionRunner.getCommand("task-supervisor");
  const legacyCommand = session.extensionRunner.getCommand("continuous-tasks");
  if (!enableCommand || !legacyCommand)
    throw new Error("Pi Task Supervisor primary command or legacy alias was not registered");
  let agentStarts = 0;
  const toolSequence = [];
  session.subscribe((event) => {
    if (
      compaction &&
      completedCompactions === 0 &&
      event.type === "tool_execution_end" &&
      event.toolName === "advance_tasks" &&
      latestSnapshot(sessionManager)?.tasks[0]?.status === "done" &&
      latestSupervisor(sessionManager)?.bindings.some((binding) => binding.taskId === "t-1.1")
    )
      settingsManager.setCompactionEnabled(true);
    if (event.type === "agent_start") agentStarts++;
    if (event.type === "compaction_end") {
      if (!event.result || event.aborted || event.willRetry || event.errorMessage)
        extensionErrors.push({
          event: "compaction_end",
          error: event.errorMessage ?? "Incomplete compaction",
        });
      else {
        completedCompactions++;
        // This smoke covers one automatic compaction, not repeated summarization.
        settingsManager.setCompactionEnabled(false);
      }
    }
    if (event.type === "tool_execution_start") toolSequence.push(event.toolName);
  });

  if (preflight) {
    await enableCommand.handler(
      `preflight ${goal}`,
      session.extensionRunner.createCommandContext(),
    );
    await waitUntil(
      () => latestPreflight(sessionManager)?.phase === "awaiting_authorization",
      "preflight proposal",
    );
    await session.waitForIdle();
    if (latestSupervisor(sessionManager) || latestSnapshot(sessionManager)?.tasks.length)
      throw new Error("Read-only preflight started execution");
    const plan = latestPreflight(sessionManager);
    const starts = agentStarts;
    preflightApprovalEnabled = true;
    await legacyCommand.handler(
      `approve ${plan.planId} A1`,
      session.extensionRunner.createCommandContext(),
    );
    assertNoUiScriptErrors();
    const approved = latestPreflight(sessionManager);
    const control = sessionManager
      .getBranch()
      .find((entry) => entry.id === approved.approval.controlEntryId);
    if (
      agentStarts !== starts ||
      latestSupervisor(sessionManager) ||
      approved.phase !== "approved" ||
      control?.customType !== "continuous-tasks:preflight-control"
    )
      throw new Error("Approval dispatched Main or lacked actual control identity");
    await enableCommand.handler(
      `start ${plan.planId}`,
      session.extensionRunner.createCommandContext(),
    );
  } else
    await enableCommand.handler(
      supervised ? `supervise ${goal}` : "enable",
      session.extensionRunner.createCommandContext(),
    );
  await legacyCommand.handler("enable", session.extensionRunner.createCommandContext());
  if (!supervised) await session.prompt("Start the approved task supervisor board.");
  if (interruptCompaction) {
    await waitUntil(() => interruptedReviewStarted, "supervisor review start");
    // Pi's native compact() waits for its boundary before emitting before_compact.
    if (nativeAbort) {
      const compacted = session.compact();
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      if (completedCompactions !== 0) throw new Error("Native compaction ordering changed");
      releaseInterruptedReview();
      await compacted;
    } else {
      // Explicit pause cancels our advisor immediately, even if the provider ignores its signal.
      await legacyCommand.handler(
        "pause compaction maintenance",
        session.extensionRunner.createCommandContext(),
      );
      if (ordinaryPause) await session.waitForIdle();
      else await session.compact();
    }
    if (!nativeAbort && latestSupervisor(sessionManager)?.holdCause !== "user_pause")
      throw new Error(
        `Explicit ordinary pause lost its host-correlated origin: ${JSON.stringify(
          sessionManager
            .getBranch()
            .filter(
              (entry) =>
                entry.type === "custom" &&
                ["continuous-tasks:supervisor", "continuous-tasks:event"].includes(
                  entry.customType,
                ),
            )
            .slice(-8)
            .map((entry) => ({
              type: entry.customType,
              status: entry.data.status,
              cause: entry.data.holdCause ?? entry.data.cause,
              reason: entry.data.reason,
            })),
        )}`,
      );
    if (latestSupervisor(sessionManager)?.status !== "paused")
      throw new Error("Interrupted advisor was not visibly paused");
    releaseInterruptedReview();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    if (
      agentStarts !== 1 ||
      latestSupervisor(sessionManager)?.continuations !== (nativeAbort ? 1 : 0)
    )
      throw new Error("Stale advisor restarted Main after compaction");
    await enableCommand.handler("resume", session.extensionRunner.createCommandContext());
    if (nativeAbort)
      await legacyCommand.handler("recover", session.extensionRunner.createCommandContext());
  }
  if (asyncExecution) {
    await waitUntil(
      () => latestSupervisor(sessionManager)?.externalWait?.phase === "active",
      "owned asynchronous wait",
    );
    await session.waitForIdle();
    const waiting = latestSupervisor(sessionManager);
    if (
      waiting.status !== "active" ||
      waiting.reviews !== 1 ||
      waiting.continuations !== 1 ||
      waiting.stagnant !== 0 ||
      advisoryChecks !== 1 ||
      agentStarts !== 2
    )
      throw new Error("Async waiting repeated advisor calls, spent budget, or faulted settlement");
    if (latestSnapshot(sessionManager)?.tasks[0]?.executionRef?.runId !== "smoke-run-1")
      throw new Error("Waiting lost the exact execution reference");
    const beforeStatus = JSON.stringify(sessionManager.getBranch());
    await enableCommand.handler("status", session.extensionRunner.createCommandContext());
    if (
      !taskDetails.includes("External wait: execution pending") ||
      beforeStatus !== JSON.stringify(sessionManager.getBranch())
    )
      throw new Error("Read-only wait status mutated history or lost owner observation");
    smokeEventBus.emit("smoke:complete");
  }
  const snapshot = await waitForCompletion(sessionManager);
  await session.agent.waitForIdle();

  assertNoUiScriptErrors();
  if (
    !widgetHistory.some((lines) => lines.some((line) => line.includes("实施记录 ·"))) ||
    !widgetHistory.some((lines) => lines.some((line) => line.includes("核验记录 ·"))) ||
    !widgetLines.some((line) => line.includes("已完成 2/2 · 未结束 0 · 放弃 0")) ||
    widgetLines.some((line) => line.includes("任务已完成记录 ·") || line.includes("已放弃记录 ·"))
  )
    throw new Error("Widget missed lifecycle progress or failed to fold completed tasks");
  if (
    supervised &&
    !reviewedWidgetPublication
  )
    throw new Error("Widget did not update for a supervisor-only review transition");
  const branchBeforeList = JSON.stringify(sessionManager.getBranch());
  const startsBeforeList = agentStarts;
  customMode = "board";
  await enableCommand.handler("tasks", session.extensionRunner.createCommandContext());
  assertNoUiScriptErrors();
  if (
    snapshot.tasks.length !== 2 ||
    !snapshot.tasks.every((task) => boardMaterial.join("\n").includes(task.id)) ||
    !boardMaterial.join("\n").includes("证据 summary：") ||
    !boardMaterial.join("\n").includes("确认与回应") ||
    !boardMaterial.join("\n").includes("最近已保存回应") ||
    !boardMaterial.join("\n").includes("最终验收") ||
    JSON.stringify(sessionManager.getBranch()) !== branchBeforeList ||
    agentStarts !== startsBeforeList
  )
    throw new Error("Full task list lost evidence, changed history, or started Main");

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
  if (agentStarts !== (preflight ? 3 : compaction || batchContinuation || asyncExecution ? 3 : 2))
    throw new Error(`Unexpected agent run count: ${agentStarts}`);
  if (completedCompactions !== ((compaction || interruptCompaction) && !ordinaryPause ? 1 : 0))
    throw new Error("Unexpected automatic compaction count");
  if (faux.getPendingResponseCount() !== 0) throw new Error("Faux responses were not exhausted");
  if (userMessages.length !== (supervised ? 0 : 1))
    throw new Error("Auto-continuation forged a user message");
  if (continuationMessages.length !== (compaction || batchContinuation || nativeAbort ? 3 : supervised ? 2 : 1)) {
    throw new Error(`Unexpected hidden continuation count: ${continuationMessages.length}`);
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
    ...(preflight ? ["submit_preflight"] : []),
    "write_tasks",
    "edit_tasks",
    "compile_tasks",
    "get_ready_tasks",
    ...(asyncExecution ? ["workflow_gate", "workflow_gate"] : []),
    "advance_tasks",
    ...(supervised ? ["validate_smoke"] : []),
    ...Array.from({ length: receiptReadCount }, () => "read"),
    "advance_tasks",
    "get_ready_tasks",
    "advance_tasks",
    ...(supervised ? ["validate_smoke"] : []),
    "advance_tasks",
  ];
  if (JSON.stringify(toolSequence) !== JSON.stringify(expectedTools)) {
    throw new Error(`Unexpected tool sequence: ${JSON.stringify(toolSequence)}`);
  }
  if (digest(realSettings) !== settingsDigestBefore) {
    throw new Error("Real Pi settings changed during isolated smoke test");
  }

  if (supervised) {
    const state = latestSupervisor(sessionManager);
    if (
      state?.status !== "completed" ||
      state.reviews !== (compaction || batchContinuation ? 3 : nativeAbort ? 1 : 2) ||
      state.continuations !== (compaction || batchContinuation ? 2 : interruptCompaction ? 0 : 1) ||
      state.receipts.length !== 2 + receiptReadCount ||
      state.bindings.length !== 2
    )
      throw new Error(`Incorrect supervisor completion: ${JSON.stringify(state)}`);
  }

  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("Persistent smoke session was not created");
  await session.extensionRunner.emit({ type: "session_shutdown" });
  if (widgetLines.length) throw new Error("Shutdown did not clear the task widget");
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
  await session.bindExtensions(uiBindings);
  if (!widgetLines.some((line) => line.includes("已完成 2/2 · 未结束 0 · 放弃 0")))
    throw new Error("Resume did not restore the task widget from session data");
  if (!session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("Resuming the session did not restore activated task tools");
  }
  if (supervised) {
    if (latestSupervisor(reopened)?.status !== "completed")
      throw new Error("Reopened supervisor lost verified acceptance");
    const gate = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "write_tasks",
      toolCallId: "resume-probe",
      input: { mode: "append" },
    });
    if (!gate?.block || !gate.reason?.includes("completed"))
      throw new Error("Reopened accepted supervisor did not freeze completed work");
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
  await session.bindExtensions(uiBindings);
  if (widgetLines.some((line) => line.includes("Supervisor:")))
    throw new Error("Forked widget inherited the source supervisor");
  const forkActivated = session.extensionRunner.getActiveTools().includes("workflow_gate");
  if (preflight ? forkActivated : !forkActivated) {
    throw new Error(preflight ? "Fork inherited source-session native approval/activation" : "Forking the session did not inherit activated task tools");
  }
  if (supervised) {
    const gate = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "write_tasks",
      toolCallId: "fork-probe",
      input: { mode: "append" },
    });
    if (preflight) {
      if (!gate?.block || !/journal|session|preflight/i.test(gate.reason)) throw new Error("Fork accepted source-session native authorization");
    } else if (gate?.block) throw new Error("Fork improperly inherited the source session's supervisor");
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
  await session.bindExtensions(uiBindings);
  if (widgetLines.length) throw new Error("Independent session inherited a task widget");
  if (session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("An independent session inherited activation");
  }

  console.log(
    JSON.stringify({
      result: "PASS",
      preflightApprovedAndSeparatelyStarted: preflight,
      preflightOptionalPermissionNotGranted: preflight,
      mode: batchContinuation
        ? "supervised-batch-continuation"
        : longReceipts
          ? "supervised-long-receipts"
          : preflight
            ? "supervised-preflight"
            : asyncExecution
              ? "supervised-async-execution"
              : ordinaryPause
                ? "supervised-ordinary-pause"
                : nativeAbort
                  ? "supervised-native-abort"
                  : interruptCompaction
                    ? "supervised-interrupted-compaction"
                    : compaction
                      ? "supervised-compaction"
                      : supervised
                        ? "supervised"
                        : "board-only",
      completedCompactions,
      supervisorAccepted: supervised,
      sessionId: sessionManager.getSessionId(),
      agentStarts,
      toolSequence,
      finalStatus: snapshot.workflowStatus,
      userMessages: userMessages.length,
      hiddenContinuations: continuationMessages.length,
      activationEntries: activationEntries.length,
      primaryAndLegacyCommands: true,
      boundedTaskWidgetLifecycle: true,
      readOnlyFullTaskList: true,
      uiStubNotRealTerminal: true,
      preflightSourceBoundarySimulated: preflight,
      productionHumanProof: false,
      resumedActivation: true,
      resumedSupervisorAcceptance: supervised,
      forkSupervisorNotInherited: supervised,
      forkedActivation: !preflight,
      nativePreflightForkDenied: preflight,
      independentDefaultDeny: true,
      realSettingsUntouched: true,
    }),
  );
} finally {
  releaseInterruptedReview?.();
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  process.argv = previousArgv;
  if (preflight) [process.stdin, process.stdout].forEach((stream, i) => { const descriptor = ttyDescriptors[i]; if (descriptor) Object.defineProperty(stream, "isTTY", descriptor); else Reflect.deleteProperty(stream, "isTTY"); });
  rmSync(sandbox, { recursive: true, force: true });
}
