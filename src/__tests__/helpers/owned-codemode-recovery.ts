// Exact prefixes of a source emitted by the owned SDK helper; never real/archived sessions.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider } from "@earendil-works/pi-ai";
import supervisor from "../../index";
import { createMockContext } from "./mocks";

interface OwnedRow {
  type: string;
  customType?: string;
  data?: {
    kind?: string;
    tasks?: Array<{ status: string }>;
    bindings?: unknown[];
    outcome?: string;
    intentId?: string;
  };
}
export type RecoveryStage = "queued" | "done" | "binding" | "applied" | "invalidated" | "accepted";
function prefix(source: string, stage: RecoveryStage) {
  if (stage === "accepted") return source;
  const lines = source.trimEnd().split("\n"),
    rows = lines.map((line) => JSON.parse(line) as OwnedRow);
  if (stage === "invalidated") {
    const invalidated = rows.findIndex(
      (row) =>
        row.data?.kind === "completion-intent-disposed" && row.data.outcome === "invalidated",
    );
    if (invalidated < 0) throw Error("Owned producer has no actual invalidated intent");
    return lines.slice(0, invalidated + 1).join("\n") + "\n";
  }
  const done = rows.findIndex(
    (row) =>
      row.type === "custom" &&
      row.customType === "continuous-tasks:snapshot" &&
      row.data?.tasks?.[0]?.status === "done",
  );
  const queued = rows.findIndex((row) => row.data?.kind === "eligibility-attested");
  const binding = rows.findIndex(
    (row, index) =>
      index > done &&
      row.customType === "continuous-tasks:supervisor" &&
      row.data?.bindings?.length,
  );
  const applied = rows.findIndex(
    (row) => row.data?.kind === "completion-intent-disposed" && row.data.outcome === "applied",
  );
  if (!(done > queued && binding > done && applied > binding))
    throw Error("Owned producer is not the expected completed native sequence");
  return lines.slice(0, { queued, done, binding, applied }[stage] + 1).join("\n") + "\n";
}
export async function ownedRecovery(source: string, stage: RecoveryStage) {
  const dir = mkdtempSync(join(tmpdir(), "owned-covered-recovery-")),
    file = join(dir, "prefix.jsonl"),
    previous = process.env.PI_CODING_AGENT_DIR,
    fetch = globalThis.fetch;
  writeFileSync(file, prefix(source, stage));
  const initial = readFileSync(file, "utf8");
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined,
    passed = false;
  const notices: string[] = [],
    errors: unknown[] = [];
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    globalThis.fetch = async () => {
      throw Error("Owned recovery forbids network");
    };
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    const faux = fauxProvider({
      provider: "owned-covered-faux",
      models: [{ id: "test", contextWindow: 128000 }],
    });
    runtime.registerNativeProvider(faux.provider);
    const model = runtime.getModel("owned-covered-faux", "test");
    if (!model) throw Error("Owned faux missing");
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
      extensionFactories: [
        supervisor,
        {
          name: "codemode",
          builtin: true,
          factory: createCodemodeExtension({ mode: "only", models: false }),
        },
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
    });
    if (created.extensionsResult.errors.length)
      throw Error(JSON.stringify(created.extensionsResult.errors));
    session = created.session;
    const forbid = async () => {
      throw Error("Owned recovery forbids session/navigation/reload");
    };
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...createMockContext().ui,
        notify: (message) => {
          notices.push(message);
        },
      },
      onError: (error) => {
        errors.push(error);
      },
      commandContextActions: {
        waitForIdle: () => created.session.waitForIdle(),
        newSession: forbid,
        fork: forbid,
        navigateTree: forbid,
        switchSession: forbid,
        reload: forbid,
      },
    });
    const command = session.extensionRunner.getCommand("task-supervisor");
    if (!command) throw Error("Owned native repair command missing");
    const before = readFileSync(file, "utf8"),
      rowsBefore = manager.getBranch().length;
    const intent = manager
      .getBranch()
      .find(
        (row) =>
          row.type === "custom" &&
          (row.data as { kind?: string }).kind === "completion-intent-queued",
      );
    const intentId =
      intent?.type === "custom" ? (intent.data as { intentId: string }).intentId : undefined;
    if (!intentId) throw Error("Owned intent missing");
    await command.handler(
      `repair-completion ${intentId}`,
      session.extensionRunner.createCommandContext(),
    );
    const after = readFileSync(file, "utf8");
    await command.handler(
      `repair-completion ${intentId}`,
      session.extensionRunner.createCommandContext(),
    );
    const repeated = readFileSync(file, "utf8"),
      branch = structuredClone(manager.getBranch());
    passed = true;
    return {
      initial,
      before,
      after,
      repeated,
      branch,
      notices,
      errors,
      modelCalls: faux.state.callCount,
      appendedRows: branch.length - rowsBefore,
    };
  } finally {
    session?.dispose();
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (passed) rmSync(dir, { recursive: true, force: true });
    else console.error("Owned covered recovery failure retained:", dir);
  }
}
