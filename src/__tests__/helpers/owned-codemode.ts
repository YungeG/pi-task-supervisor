// Actual SDK/QuickJS producer under Vitest coverage. Text rendering alone is mocked by setup.ts;
// no provider network, real user identity, CLI or production acceptance is claimed.
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Type } from "typebox";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import supervisor from "../../index";
import { createMockContext } from "./mocks";
const customRows = (manager: SessionManager) =>
  manager.getBranch().filter((row) => row.type === "custom");
const forbiddenNavigation = async () => {
  throw Error("Owned SDK fixture forbids unrelated session/navigation/reload actions");
};

export type OwnedCase =
  | "normal"
  | "late-write"
  | "store"
  | "image"
  | "root-error"
  | "parallel"
  | "unfinished"
  | "write-then-check"
  | "capability-unavailable"
  | "pause"
  | "journal-uncertain"
  | "duplicate-done"
  | "conflicting-done"
  | "task-change"
  | "bad-ref"
  | "early-check"
  | "nonzero-check"
  | "after-seal-write"
  | "spill";
const pixel =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3XQAAAAASUVORK5CYII=";
const plan =
  'await tools.write_tasks({mode:"replace",phases:[{title:"Owned",tasks:[{title:"Native check",prompt:"Finite native fixture check",profile:"main"}]}]}); await tools.compile_tasks({finalAcceptanceTaskId:"t-1.1"});';
function work(kind: OwnedCase) {
  const prefix =
    kind === "early-check"
      ? "await tools.get_ready_tasks({count:1});"
      : 'await tools.get_ready_tasks({count:1}); await tools.advance_tasks({transitions:[{id:"t-1.1"}]});';
  const check =
    kind === "parallel"
      ? "const pending=tools.owned_wait_write({}); const proof=await tools.owned_check({}); await pending;"
      : kind === "early-check"
        ? 'const proof=await tools.owned_check({}); await tools.advance_tasks({transitions:[{id:"t-1.1"}]});'
        : "const proof=await tools.owned_check({});";
  const completion =
    'try { text(await tools.advance_tasks({transitions:[{id:"t-1.1",evidence:{summary:"Actual owned check",refs:[{kind:"command",label:"Owned check",status:"passed",ref:"tool:"+proof.id,exitCode:0}]}}]})); } catch(error) { text({completionError:String(error)}); }';
  const extra =
    kind === "late-write"
      ? "await tools.owned_write({});"
      : kind === "store"
        ? 'store("owned",{value:1});'
        : kind === "image"
          ? `image({type:"image",data:"${pixel}",mimeType:"image/png"});`
          : kind === "root-error"
            ? 'throw new Error("Owned root failure");'
            : kind === "unfinished"
              ? "tools.owned_wait_write({});"
              : kind === "pause"
                ? "await tools.owned_wait_write({});"
                : kind === "spill"
                  ? 'text("owned spill".repeat(20000));'
                  : "";
  const second =
    kind === "duplicate-done"
      ? completion
      : kind === "conflicting-done"
        ? completion.replace('summary:"Actual owned check"', 'summary:"Conflicting owned request"')
        : kind === "task-change"
          ? 'await tools.edit_tasks({tasks:[{id:"t-1.1",type:"data",data:{prompt:"Changed owned task context"}}]});'
          : "";
  return (
    prefix +
    (kind === "write-then-check" ? "await tools.owned_write({});" : "") +
    check +
    (kind === "bad-ref"
      ? completion.replace('ref:"tool:"+proof.id', 'ref:"tool:untrusted"')
      : completion) +
    extra +
    second
  );
}
export interface OwnedFixtureHooks {
  directCheck?: boolean;
  workCode?: string;
  checkTool?: string;
  prepare?: (dir: string) => void;
  goalStart?: (pi: ExtensionAPI, ctx: ExtensionContext, dir: string) => void;
}
export async function ownedCodemode(kind: OwnedCase, hooks: OwnedFixtureHooks = {}) {
  const dir = mkdtempSync(join(tmpdir(), "owned-codemode-covered-")),
    previous = process.env.PI_CODING_AGENT_DIR,
    fetch = globalThis.fetch;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined,
    passed = false,
    checks = 0,
    writing = false,
    overlapObserved = false;
  const errors: unknown[] = [],
    notices: string[] = [];
  let injected = false;
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    globalThis.fetch = async () => {
      throw Error("Owned SDK fixture forbids network");
    };
    execFileSync("git", ["init", "--quiet", dir], { stdio: "ignore", timeout: 2000 });
    writeFileSync(join(dir, ".gitignore"), "*\n!.gitignore\n!input.txt\n");
    writeFileSync(join(dir, "input.txt"), "owned\n");
    hooks.prepare?.(dir);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    const accepts = kind === "normal" || kind === "write-then-check" || kind === "duplicate-done";
    const faux = fauxProvider({
      provider: "owned-covered-faux",
      models: [{ id: "test", contextWindow: 128000 }],
    });
    const manager = SessionManager.create(dir, join(dir, "sessions"));
    if (kind === "journal-uncertain" || kind === "after-seal-write") {
      const append = manager.appendCustomEntry.bind(manager);
      manager.appendCustomEntry = (type, data) => {
        const result = append(type, data);
        if (
          !injected &&
          type === "continuous-tasks:control-facts" &&
          typeof data === "object" &&
          data !== null &&
          "kind" in data
        ) {
          if (kind === "journal-uncertain" && data.kind === "eligibility-attested") {
            injected = true;
            throw Error("Owned failure after actual qualification bytes; unknown caller result");
          }
          if (kind === "after-seal-write" && checks > 0 && data.kind === "invocation-root-sealed") {
            injected = true;
            writeFileSync(join(dir, "input.txt"), "changed after actual root seal\n");
          }
        }
        return result;
      };
    }
    const rootCall = (code: string, id: string) =>
      fauxAssistantMessage(fauxToolCall("codemode", { code }, { id }), { stopReason: "toolUse" });
    faux.setResponses([
      rootCall(plan, "owned-plan"),
      fauxAssistantMessage("Owned plan checkpoint"),
      fauxAssistantMessage(
        JSON.stringify({
          action: "next_batch",
          message: "Run owned finite task",
          taskIds: ["t-1.1"],
          evidenceRefs: [],
        }),
      ),
      ...(hooks.directCheck
        ? [
            rootCall(
              'await tools.get_ready_tasks({count:1}); await tools.advance_tasks({transitions:[{id:"t-1.1"}]});',
              "owned-work",
            ),
            fauxAssistantMessage(
              fauxToolCall("run_check", { checkId: "required-node" }, { id: "owned-direct-check" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
              fauxToolCall(
                "advance_tasks",
                {
                  transitions: [
                    {
                      id: "t-1.1",
                      evidence: {
                        summary: "Actual direct native check",
                        refs: [
                          {
                            kind: "command",
                            label: "Registered native check",
                            status: "passed",
                            ref: "tool:owned-direct-check",
                            exitCode: 0,
                          },
                        ],
                      },
                    },
                  ],
                },
                { id: "owned-direct-done" },
              ),
              { stopReason: "toolUse" },
            ),
          ]
        : [rootCall(hooks.workCode ?? work(kind), "owned-work")]),
      fauxAssistantMessage("Owned work checkpoint"),
      () => {
        const receipt = [...customRows(manager)]
          .reverse()
          .find(
            (row) =>
              row.customType === "continuous-tasks:receipt-ledger" &&
              (row.data as { kind?: string; receipt?: { tool: string } }).kind === "receipt" &&
              (row.data as { receipt: { tool: string } }).receipt.tool ===
                (hooks.checkTool ?? "owned_check"),
          )?.data as { receipt?: { id: string } } | undefined;
        return fauxAssistantMessage(
          JSON.stringify({
            action: accepts ? "accept" : "hold",
            message: "Owned mechanism only",
            taskIds: accepts ? ["t-1.1"] : [],
            evidenceRefs: accepts ? (receipt?.receipt ? [receipt.receipt.id] : []) : [],
          }),
        );
      },
    ]);
    runtime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      codemode: { mode: hooks.directCheck ? "on" : "only" },
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      extensionFactories: [
        ...(hooks.goalStart
          ? [
              (pi: ExtensionAPI) => {
                let started = false;
                pi.on("tool_call", (_event, ctx) => {
                  if (!started) {
                    started = true;
                    hooks.goalStart?.(pi, ctx, dir);
                  }
                });
              },
            ]
          : []),
        supervisor,
        {
          name: "codemode",
          builtin: true,
          factory: createCodemodeExtension({
            mode: hooks.directCheck ? "on" : "only",
            models: kind === "capability-unavailable",
          }),
        },
      ],
    });
    await loader.reload();
    const model = runtime.getModel("owned-covered-faux", "test");
    if (!model) throw Error("Owned faux model unavailable");
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
          name: "owned_check",
          label: "Owned check",
          description: "Actually checks the fixed private input",
          parameters: Type.Object({}),
          outputSchema: Type.Object({ id: Type.String(), exit_code: Type.Integer() }),
          execute: async (id) => {
            checks++;
            overlapObserved ||= writing;
            if (readFileSync(join(dir, "input.txt"), "utf8") !== "owned\n")
              throw Error("Owned input mismatch");
            return {
              content: [{ type: "text", text: "Owned input matched" }],
              details: {},
              structuredContent: { id, exit_code: kind === "nonzero-check" ? 3 : 0 },
            };
          },
        },
        {
          name: "owned_write",
          label: "Owned same-byte write",
          description: "Actually rewrites private input to identical bytes",
          parameters: Type.Object({}),
          execute: async () => {
            writeFileSync(join(dir, "input.txt"), "owned\n");
            return {
              content: [{ type: "text", text: "Owned write" }],
              details: {},
              structuredContent: { exit_code: 0 },
            };
          },
        },
        {
          name: "owned_wait_write",
          label: "Owned finite delayed write",
          description: "Waits briefly with real abort handling, then rewrites only owned input",
          parameters: Type.Object({}),
          execute: async (_id, _params, signal) => {
            writing = true;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, kind === "pause" ? 1000 : 80);
              signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  resolve();
                },
                { once: true },
              );
            });
            try {
              if (signal?.aborted) throw Error("Owned writer actually cancelled");
              writeFileSync(join(dir, "input.txt"), "owned\n");
              return {
                content: [{ type: "text", text: "Owned delayed write" }],
                details: {},
                structuredContent: { exit_code: 0 },
              };
            } finally {
              writing = false;
            }
          },
        },
      ],
    });
    if (created.extensionsResult.errors.length)
      throw Error(JSON.stringify(created.extensionsResult.errors));
    session = created.session;
    await session.bindExtensions({
      mode: "rpc",
      uiContext: {
        ...createMockContext().ui,
        notify: (text) => {
          notices.push(text);
        },
      },
      onError: (error) => {
        errors.push(error);
      },
      commandContextActions: {
        waitForIdle: () => created.session.waitForIdle(),
        newSession: forbiddenNavigation,
        fork: forbiddenNavigation,
        navigateTree: forbiddenNavigation,
        switchSession: forbiddenNavigation,
        reload: forbiddenNavigation,
      },
    });
    const command = session.extensionRunner.getCommand("task-supervisor");
    if (!command) throw Error("Owned command missing");
    await command.handler(
      "supervise-legacy Owned covered SDK mechanism",
      session.extensionRunner.createCommandContext(),
    );
    const isWriting = () => writing;
    if (kind === "pause") {
      const waiting = Date.now() + 1500;
      while (!isWriting()) {
        if (Date.now() > waiting)
          throw Error("Owned child did not reach actual running pause boundary");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await command.handler(
        "pause Owned native pause during deferred root",
        session.extensionRunner.createCommandContext(),
      );
    }
    const latest = () =>
      [...customRows(manager)]
        .reverse()
        .find(
          (row) =>
            row.customType === "continuous-tasks:supervisor" &&
            (row.data as { version?: number }).version === 3,
        )?.data as { status: string; reason?: string } | undefined;
    const deadline = Date.now() + 15000;
    while (!["paused", "fault", "completed"].includes(latest()?.status ?? "")) {
      if (
        (kind === "unfinished" || kind === "journal-uncertain") &&
        !session.isStreaming &&
        manager
          .getBranch()
          .some(
            (row) =>
              row.type === "message" &&
              row.message.role === "toolResult" &&
              row.message.toolCallId === "owned-work",
          )
      )
        break;
      if (Date.now() > deadline)
        throw Error("Owned SDK did not settle: " + JSON.stringify(latest()));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await session.waitForIdle();
    const writerDeadline = Date.now() + 1000;
    while (isWriting()) {
      if (Date.now() > writerDeadline)
        throw Error("Actual owned finite writer did not settle; preserve fixture");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const branch = structuredClone(manager.getBranch()),
      file = manager.getSessionFile();
    if (!file) throw Error("Owned SDK did not produce a physical session file");
    passed = true;
    return {
      branch,
      state: latest(),
      checks,
      overlapObserved,
      injected,
      errors,
      notices,
      source: readFileSync(file, "utf8"),
      modelCalls: faux.state.callCount,
    };
  } finally {
    session?.dispose();
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (passed) rmSync(dir, { recursive: true, force: true });
    else console.error("Owned covered SDK failure retained:", dir);
  }
}
