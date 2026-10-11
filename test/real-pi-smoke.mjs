import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const compaction = process.argv.includes("--compaction");
const nativeAbort = process.argv.includes("--native-abort");
const interruptCompaction = process.argv.includes("--interrupt-compaction") || nativeAbort;
const supervised = process.argv.includes("--supervised") || compaction || interruptCompaction;
let interruptedReviewStarted = false;
let releaseInterruptedReview;
let completedCompactions = 0;
let advisoryChecks = 0;
const goal = "Verify the approved local smoke work";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "src", "index.ts");
const sandbox = mkdtempSync(join(tmpdir(), "pi-task-supervisor-smoke-"));
const realSettings = join(homedir(), ".pi", "agent", "settings.json");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
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
  return [...manager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "custom" && entry.customType === "continuous-tasks:supervisor")
    ?.data;
}

function advisory(action) {
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
          action === "guide"
            ? "Claim and complete both approved tasks, running fresh host validation during each review."
            : "All approved work has host validation.",
        taskIds: action === "guide" ? ["t-1.1", "t-2.1"] : ["t-2.1"],
        evidenceRefs: action === "guide" ? [] : ["tool:final-validation"],
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
            action: "guide",
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
  const loader = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: sandbox,
    settingsManager,
    additionalExtensionPaths: [
      extensionPath,
      ...(compaction || interruptCompaction ? [join(sandbox, "compact-fixture.mjs")] : []),
    ],
  });
  await loader.reload();
  return loader;
}

async function waitForCompletion(sessionManager) {
  for (let attempt = 0; attempt < 500; attempt++) {
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
    export default function (pi) {
      pi.on("session_before_compact", (event) => {
        if (event.reason !== ${JSON.stringify(interruptCompaction ? "manual" : "threshold")} || event.willRetry) throw new Error("Unexpected smoke compaction trigger");
        const state = [...event.branchEntries].reverse().find((entry) => entry.type === "custom" && entry.customType === "continuous-tasks:supervisor")?.data;
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
  const settingsManager = SettingsManager.inMemory(
    compaction || interruptCompaction
      ? {
          compaction: { enabled: compaction, reserveTokens: 4096, keepRecentTokens: 128 },
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
  const faux = fauxProvider({
    provider: "pi-task-supervisor-faux",
    models: [{ id: "test", contextWindow: compaction ? 8192 : 128000 }],
  });
  // The faux provider computes usage from text; this bounded padding crosses the native threshold.
  const compactionStop = fauxAssistantMessage(
    "Implementation verified; final acceptance remains. " + "local faux padding ".repeat(350),
  );
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
    ...(supervised ? [interruptCompaction ? interruptedAdvisory : advisory("guide")] : []),
    tool("get_ready_tasks", { count: 1 }),
    tool("advance_tasks", { transitions: [{ id: "t-1.1" }] }),
    ...(supervised ? [tool("validate_smoke", {}, "implementation-validation")] : []),
    tool("advance_tasks", {
      transitions: [{ id: "t-1.1", evidence: proof("implementation-validation") }],
    }),
    ...(compaction ? [compactionStop, advisory("guide")] : []),
    tool("get_ready_tasks", { count: 1 }),
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
    customTools: supervised ? [validationTool] : [],
  });
  if (created.extensionsResult.errors.length > 0) {
    throw new Error(`Extension load failed: ${JSON.stringify(created.extensionsResult.errors)}`);
  }
  session = created.session;
  const extensionErrors = [];
  const widgetHistory = [];
  let widgetLines = [];
  let listOptions = [];
  let taskDetails = "";
  // Real SDK callbacks with a UI stub, not a real terminal or human visual certification.
  const uiContext = {
    setStatus() {},
    notify(message) {
      taskDetails = message;
    },
    async select(_title, options) {
      listOptions = options;
      return options[0];
    },
    setWidget(key, content, options) {
      if (key !== "continuous-tasks:board") throw new Error(`Unexpected widget: ${key}`);
      widgetLines = [];
      if (content) {
        if (typeof content !== "function" || options?.placement !== "aboveEditor")
          throw new Error("Widget did not use the bounded above-editor component");
        const component = content(undefined, undefined);
        for (const width of [1, 35, 72]) {
          const lines = component.render(width);
          if (
            lines.length > 8 ||
            lines.some(
              (line) => visibleWidth(line) > width || /\p{Cc}/u.test(stripTerminalSequences(line)),
            )
          )
            throw new Error("Widget exceeded terminal width/row limits");
        }
        widgetLines = component.render(72).map(stripTerminalSequences);
      }
      widgetHistory.push([...widgetLines]);
    },
  };
  const uiBindings = { mode: "tui", uiContext, onError: (error) => extensionErrors.push(error) };
  await session.bindExtensions(uiBindings);
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
      await session.compact();
    }
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
    await legacyCommand.handler("recover", session.extensionRunner.createCommandContext());
  }
  const snapshot = await waitForCompletion(sessionManager);
  await session.agent.waitForIdle();

  if (
    !widgetHistory.some((lines) => lines.some((line) => line.includes("[implementing]"))) ||
    !widgetHistory.some((lines) => lines.some((line) => line.includes("[reviewing]"))) ||
    !widgetLines.some((line) => line.includes("2/2 done · 0 unfinished")) ||
    widgetLines.some((line) => line.includes("[done]"))
  )
    throw new Error("Widget missed lifecycle progress or failed to fold completed tasks");
  if (
    supervised &&
    !widgetHistory.some((lines) => lines.some((line) => line.includes("Supervisor: reviewing")))
  )
    throw new Error("Widget did not update for a supervisor-only review transition");
  const branchBeforeList = JSON.stringify(sessionManager.getBranch());
  const startsBeforeList = agentStarts;
  await enableCommand.handler("tasks", session.extensionRunner.createCommandContext());
  if (
    listOptions.length !== 2 ||
    !taskDetails.includes("Evidence:") ||
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
  if (agentStarts !== (compaction ? 3 : 2))
    throw new Error(`Unexpected agent run count: ${agentStarts}`);
  if (completedCompactions !== (compaction || interruptCompaction ? 1 : 0))
    throw new Error("Unexpected automatic compaction count");
  if (faux.getPendingResponseCount() !== 0) throw new Error("Faux responses were not exhausted");
  if (userMessages.length !== (supervised ? 0 : 1))
    throw new Error("Auto-continuation forged a user message");
  if (continuationMessages.length !== (compaction || nativeAbort ? 3 : supervised ? 2 : 1)) {
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
    "write_tasks",
    "edit_tasks",
    "compile_tasks",
    "get_ready_tasks",
    "advance_tasks",
    ...(supervised ? ["validate_smoke"] : []),
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
      state.reviews !== (compaction ? 3 : interruptCompaction ? 1 : 2) ||
      state.continuations !== (compaction ? 2 : interruptCompaction ? 0 : 1) ||
      state.receipts.length !== 2 ||
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
  if (!widgetLines.some((line) => line.includes("2/2 done · 0 unfinished")))
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
  if (!session.extensionRunner.getActiveTools().includes("workflow_gate")) {
    throw new Error("Forking the session did not inherit activated task tools");
  }
  if (supervised) {
    const gate = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "write_tasks",
      toolCallId: "fork-probe",
      input: { mode: "append" },
    });
    if (gate?.block) throw new Error("Fork improperly inherited the source session's supervisor");
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
      mode: nativeAbort
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
      resumedActivation: true,
      resumedSupervisorAcceptance: supervised,
      forkSupervisorNotInherited: supervised,
      forkedActivation: true,
      independentDefaultDeny: true,
      realSettingsUntouched: true,
    }),
  );
} finally {
  releaseInterruptedReview?.();
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(sandbox, { recursive: true, force: true });
}
