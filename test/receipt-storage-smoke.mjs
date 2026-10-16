import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = join(packageRoot, "src", "index.ts");
const intent = process.argv.includes("--intent");
const v2 = process.argv.includes("--v2");
assert(!(intent && v2));
const legacyCount = intent ? 0 : Number(process.env.PI_RECEIPT_LEGACY_COUNT ?? (v2 ? 501 : 500));
assert(Number.isSafeInteger(legacyCount) && legacyCount >= 0 && legacyCount <= (v2 ? 1000 : 500));
const expectedEpoch = intent ? 3 : !v2 && legacyCount === 500 ? 7 : 6;
const sandbox = mkdtempSync(join(tmpdir(), "pi-receipt-storage-smoke-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const settingsHash = () =>
  existsSync(settingsPath)
    ? createHash("sha256").update(readFileSync(settingsPath)).digest("hex")
    : "absent";
const before = settingsHash();
const goal = "Verify isolated receipt persistence and recovery";
const now = "2026-10-01T00:00:00.000Z";
const RECEIPTS = "continuous-tasks:receipt-ledger";
const SUPERVISOR = "continuous-tasks:supervisor";
let session;
const errors = [];
const notices = [];
const command = (name = "task-supervisor") => {
  const cmd = session.extensionRunner.getCommand(name);
  assert(cmd, `Missing command ${name}`);
  return (args) => cmd.handler(args, session.extensionRunner.createCommandContext());
};
const latest = (manager) =>
  [...manager.getBranch()].reverse().find((e) => e.type === "custom" && e.customType === SUPERVISOR)
    ?.data;
const tool = (name, args, id) =>
  fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
async function loader(settingsManager, selected = extensionPath) {
  const resources = new DefaultResourceLoader({
    cwd: sandbox,
    agentDir: sandbox,
    settingsManager,
    additionalExtensionPaths: [selected],
  });
  await resources.reload();
  return resources;
}
const bindings = () => ({
  mode: "tui",
  uiContext: {
    setStatus() {},
    setWidget() {},
    select: async () => undefined,
    notify: (text) => notices.push(text),
  },
  onError: (e) => errors.push(e),
  commandContextActions: { waitForIdle: () => session.waitForIdle() },
});

try {
  process.env.PI_CODING_AGENT_DIR = sandbox;
  const manager = SessionManager.create(sandbox, join(sandbox, "sessions"));
  // A known historical fixture, not a claim that a business command ran in this process.
  manager.appendMessage(fauxAssistantMessage("Isolated historical receipt fixture."));
  const finalId = intent ? "t-1.1" : "t-2.1";
  const historical = {
    summary: "Historical fixture validation",
    refs: [
      {
        kind: "command",
        label: "fixture only",
        ref: "tool:legacy-0",
        status: "passed",
        exitCode: 0,
      },
    ],
  };
  const task = (id, status, phase, dependencies = []) => ({
    id,
    title: "Fixture",
    prompt: "Verify the isolated fixture",
    profile: "worker",
    status,
    phase,
    dependencies,
    createdAt: now,
    updatedAt: now,
  });
  const first = { ...task("t-1.1", "done", 1), completionEvidence: historical };
  const board = {
    version: 2,
    generation: 7,
    workflowStatus: "active",
    stagnantSettles: 0,
    finalAcceptanceTaskId: finalId,
    tasks: intent
      ? [task(finalId, "reviewing", 1)]
      : [first, task(finalId, "reviewing", 2, ["t-1.1"])],
    phases: intent
      ? [{ phase: 1, title: "Verify", status: "active" }]
      : [
          { phase: 1, title: "Historical", status: "completed" },
          { phase: 2, title: "Verify", status: "active" },
        ],
  };
  const legacy = {
    version: 1,
    sessionId: manager.getSessionId(),
    goal,
    model: { provider: "receipt-storage-faux", id: "test" },
    status: "fault",
    reviews: 7,
    continuations: 3,
    stagnant: 1,
    epoch: intent ? 0 : 4,
    pending: false,
    reason: "Historical fixture awaiting explicit recovery",
    holdCause: "interrupted",
    receipts: intent
      ? []
      : Array.from({ length: legacyCount }, (_, i) => ({
          id: `tool:legacy-${i}`,
          tool: "fixture",
          taskIds: ["t-1.1"],
          reviews: [{ taskId: "t-1.1", digest: digest({ ...first, status: "reviewing" }) }],
          epoch: 4,
          ok: true,
          exitCode: 0,
          digest: "a".repeat(64),
          input: "{}",
          output: "Historical fixture only",
        })),
    bindings: intent ? [] : [{ taskId: "t-1.1", digest: digest(first), refs: ["tool:legacy-0"] }],
    tokens: 123,
    cost: 0.25,
  };
  manager.appendCustomEntry("continuous-tasks:activation", { version: 1, enabled: true });
  manager.appendCustomEntry("continuous-tasks:snapshot", board);
  let source = intent
    ? {
        ...legacy,
        version: 3,
        receiptLedger: {
          goalId: "rg-intent-fixture",
          sequence: 0,
          head: null,
          receiptCount: 0,
          epoch: 0,
          pending: [],
        },
      }
    : legacy;
  const v2Anchors = [];
  if (v2) {
    let head = null;
    for (let offset = 0; offset < legacyCount; offset += 500) {
      const payload = {
        version: 1,
        sessionId: manager.getSessionId(),
        journalId: "v2-native-fixture",
        previousHead: head,
        first: offset + 1,
        receipts: legacy.receipts.slice(offset, offset + 500),
      };
      head = digest(payload);
      const data = { ...payload, head };
      const id = manager.appendCustomEntry("continuous-tasks:supervisor-receipts", data);
      v2Anchors.push({ id, digest: digest(data) });
    }
    source = {
      ...legacy,
      version: 2,
      receipts: [],
      receiptJournal: { id: "v2-native-fixture", count: legacyCount, head },
    };
  }
  const anchor = manager.appendCustomEntry(SUPERVISOR, source);
  const anchorHash = digest(source);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
  const faux = fauxProvider({
    provider: "receipt-storage-faux",
    models: [{ id: "test", contextWindow: 128000 }],
  });
  faux.setResponses([
    tool("validate_receipt_fixture", {}, "fresh-validation"),
    tool(
      "advance_tasks",
      {
        transitions: [
          {
            id: finalId,
            evidence: {
              summary: "New real SDK fixture host validation",
              refs: [
                {
                  kind: "command",
                  label: "fixture",
                  ref: "tool:fresh-validation",
                  status: "passed",
                  exitCode: 0,
                },
              ],
            },
          },
        ],
      },
      "complete-final",
    ),
    fauxAssistantMessage("All isolated fixture work completed."),
    (context) => {
      assert.equal(context.tools?.length ?? 0, 0);
      const raw = context.messages.findLast((m) => m.role === "user").content;
      const packet = JSON.parse(
        typeof raw === "string" ? raw : raw.map((v) => v.text ?? "").join(""),
      );
      assert.equal(packet.acceptanceBlocker, null);
      assert(packet.receipts.some((r) => r.id === "tool:fresh-validation" && r.exitCode === 0));
      if (!intent) assert(packet.receipts.some((r) => r.id === "tool:legacy-0"));
      return fauxAssistantMessage(
        JSON.stringify({
          action: "accept",
          message: "Fixture fully verified",
          taskIds: [finalId],
          evidenceRefs: ["tool:fresh-validation"],
        }),
      );
    },
  ]);
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel("receipt-storage-faux", "test");
  assert(model);
  const validation = {
    name: "validate_receipt_fixture",
    label: "Validate receipt fixture",
    description: "Pure isolated validation",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "Fixture passed" }],
      details: {},
      structuredContent: { exit_code: 0 },
    }),
  };
  async function open(sm, selected = extensionPath) {
    const created = await createAgentSession({
      cwd: sandbox,
      agentDir: sandbox,
      modelRuntime: runtime,
      model,
      resourceLoader: await loader(settingsManager, selected),
      settingsManager,
      sessionManager: sm,
      noTools: "builtin",
      customTools: [validation],
    });
    assert.deepEqual(created.extensionsResult.errors, []);
    session = created.session;
    await session.bindExtensions(bindings());
  }
  await open(manager);
  assert.equal(latest(manager).version, intent ? 3 : v2 ? 2 : 1);
  if (!intent && !v2 && legacyCount === 500) assert.equal(latest(manager).receiptGapEpoch, 5);
  if (intent) {
    const gate = await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "write",
      toolCallId: "interrupted-fixture-write",
      input: { path: "not-executed" },
    });
    assert(!gate?.block);
    const record = manager
      .getBranch()
      .findLast((e) => e.type === "custom" && e.customType === RECEIPTS);
    assert.equal(record.data.kind, "intent");
    // Deliberate SDK-boundary crash injection: there is no fabricated result.
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
    await open(SessionManager.open(manager.getSessionFile()));
    await command()("status");
    assert(notices.at(-1).includes("1 unknown/in-flight"));
  }
  await command()("recover");
  for (let i = 0; i < 500 && latest(session.sessionManager)?.status !== "completed"; i++)
    await new Promise((r) => setTimeout(r, 10));
  await session.waitForIdle();
  const activeManager = session.sessionManager;
  const state = latest(activeManager);
  assert.equal(state.status, "completed");
  assert.equal(state.version, 3);
  assert.equal(state.receiptLedger.receiptCount, intent ? 1 : legacyCount + 1);
  assert.equal(state.epoch, expectedEpoch);
  assert.equal(state.receipts.length, 0);
  assert.equal(state.receiptLedger.pending.length, 0);
  assert.equal(digest(activeManager.getEntry(anchor).data), anchorHash);
  for (const batch of v2Anchors)
    assert.equal(digest(activeManager.getEntry(batch.id).data), batch.digest);
  assert(state.tokens >= 123 && state.cost >= 0.25);
  assert.equal(faux.getPendingResponseCount(), 0);
  const file = activeManager.getSessionFile();
  await session.extensionRunner.emit({ type: "session_shutdown" });
  session.dispose();
  await open(SessionManager.open(file));
  const freeze = await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "write_tasks",
    toolCallId: "frozen-probe",
    input: { mode: "append" },
  });
  assert(freeze?.block && freeze.reason.includes("completed"));
  assert.equal(latest(session.sessionManager).status, "completed");
  if (process.env.PI_SUPERVISOR_OLD_ENTRY) {
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
    await open(SessionManager.open(file), process.env.PI_SUPERVISOR_OLD_ENTRY);
    assert(!session.extensionRunner.getActiveTools().includes("advance_tasks"));
    assert(
      session.sessionManager
        .getBranch()
        .some(
          (e) =>
            e.type === "custom_message" &&
            typeof e.content === "string" &&
            e.content.includes("Invalid supervisor journal"),
        ),
    );
  }
  assert.equal(settingsHash(), before);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      result: "PASS",
      mode: intent
        ? "receipt-intent-recovery"
        : v2
          ? "receipt-v2-migration"
          : "receipt-v1-migration",
      legacyReceipts: legacyCount,
      expectedEpoch,
      v2BatchesUnchanged: v2Anchors.length,
      oldAnchorUnchanged: true,
      realStructuredExitZero: true,
      explicitRecovery: true,
      noUnknownToolReplay: true,
      reopenedFrozenAcceptance: true,
      legacyReaderRefusedV3: Boolean(process.env.PI_SUPERVISOR_OLD_ENTRY),
      realSettingsUntouched: true,
      uiStubNotRealTerminal: true,
    }),
  );
} finally {
  session?.dispose();
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(sandbox, { recursive: true, force: true });
}
