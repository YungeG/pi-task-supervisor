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
import { installCustomUI } from "./custom-ui";
import { trustedCliRoots } from "../../human-ui";
import type { AcceptanceProposal } from "../../acceptance-proposal";
import type { PreflightProposal } from "../../preflight";
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
  approvalWorkflow?: {
    contract: (dir: string) => AcceptanceProposal;
    proposal: (dir: string) => Omit<PreflightProposal, "contractProposalId">;
    produce: (dir: string) => void;
    prepareChecker?: (dir: string) => void;
  };
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
  const argv = process.argv;
  const tty = [process.stdin, process.stdout].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, "isTTY"),
  );
  let uiDriver: ReturnType<typeof installCustomUI> | undefined;
  try {
    if (hooks.approvalWorkflow) {
      const root = trustedCliRoots()[0];
      if (!root) throw Error("Owned native UI peer unavailable");
      process.argv = [process.execPath, join(root, "dist/cli.js")];
      for (const stream of [process.stdin, process.stdout])
        Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
    }
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
    if (hooks.approvalWorkflow)
      manager.appendMessage({
        role: "user",
        content:
          "Owned covered SDK mechanism: plan only; permissions and Start remain separate native decisions.",
        timestamp: Date.now(),
      });
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
    const workflow = hooks.approvalWorkflow;
    const planning = workflow
      ? [
          fauxAssistantMessage(
            fauxToolCall(
              "propose_contract",
              { proposal: workflow.contract(dir) },
              { id: "owned-contract-proposal" },
            ),
            { stopReason: "toolUse" },
          ),
          () => {
            const proposal = manager
              .getBranch()
              .find(
                (row) =>
                  row.type === "message" &&
                  row.message.role === "toolResult" &&
                  row.message.toolCallId === "owned-contract-proposal",
              );
            const text =
              proposal?.type === "message" && proposal.message.role === "toolResult"
                ? proposal.message.content.find((item) => item.type === "text")
                : undefined;
            const id =
              text?.type === "text"
                ? (JSON.parse(text.text) as { proposalId?: string }).proposalId
                : undefined;
            const stored = [...customRows(manager)]
              .reverse()
              .find((row) => row.customType === "continuous-tasks:preflight")?.data as
              | { preflightId?: string; snapshot?: { preflightId?: string } }
              | undefined;
            const preflightId = stored?.snapshot?.preflightId ?? stored?.preflightId;
            if (!id || !preflightId) throw Error("Actual planning references unavailable");
            return fauxAssistantMessage(
              fauxToolCall(
                "submit_preflight",
                { preflightId, proposal: { ...workflow.proposal(dir), contractProposalId: id } },
                { id: "owned-preflight-submit" },
              ),
              { stopReason: "toolUse" },
            );
          },
          fauxAssistantMessage(
            "Owned consolidated approval checkpoint; no Start requested by model",
          ),
        ]
      : [];
    faux.setResponses([
      ...planning,
      ...(workflow?.prepareChecker
        ? [
            rootCall(
              'await tools.write_tasks({mode:"replace",phases:[{title:"Owned",tasks:[{title:"Native check",prompt:"Finite native fixture check",profile:"main"}]}]}); await tools.owned_prepare({});',
              "owned-preparation",
            ),
            fauxAssistantMessage(
              "Owned concrete checker prepared; request only native definition review",
            ),
            fauxAssistantMessage(
              JSON.stringify({
                action: "hold",
                message: "Wait for concrete native definition review",
                taskIds: [],
                evidenceRefs: [],
              }),
            ),
          ]
        : []),
      rootCall(
        workflow?.prepareChecker
          ? 'await tools.compile_tasks({finalAcceptanceTaskId:"t-1.1"});'
          : plan,
        "owned-plan",
      ),
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
        ...(workflow?.prepareChecker
          ? [
              {
                name: "owned_prepare",
                label: "Owned checker preparation",
                description: "Create only the exact approved owned checker fixture",
                parameters: Type.Object({}),
                execute: async () => {
                  workflow.prepareChecker!(dir);
                  return {
                    content: [{ type: "text" as const, text: "Actual owned checker prepared" }],
                    details: {},
                    structuredContent: { exit_code: 0 },
                  };
                },
              },
            ]
          : []),
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
            if (hooks.approvalWorkflow) hooks.approvalWorkflow.produce(dir);
            else writeFileSync(join(dir, "input.txt"), "owned\n");
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
    const uiHost = createMockContext();
    if (workflow) {
      uiHost.ui.select = async (_title, options) =>
        options.includes("开始执行")
          ? "开始执行"
          : (options.find((option) => /^选项 1(?:$| ·)/u.test(option)) ?? "确认提交所选方案");
      uiDriver = installCustomUI(uiHost, (driver) => {
        driver.reviewAll();
      });
    }
    await session.bindExtensions({
      mode: workflow ? "tui" : "rpc",
      uiContext: {
        ...uiHost.ui,
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
    const latest = () =>
      [...customRows(manager)]
        .reverse()
        .find(
          (row) =>
            row.customType === "continuous-tasks:supervisor" &&
            (row.data as { version?: number }).version === 3,
        )?.data as { status: string; reason?: string } | undefined;
    const command = session.extensionRunner.getCommand("task-supervisor");
    if (!command) throw Error("Owned command missing");
    await command.handler(
      workflow
        ? "supervise Owned covered SDK mechanism"
        : "supervise-legacy Owned covered SDK mechanism",
      session.extensionRunner.createCommandContext(),
    );
    if (workflow) {
      await session.waitForIdle();
      const approval = [...customRows(manager)]
        .reverse()
        .find((row) => row.customType === "continuous-tasks:preflight")?.data as
        | { phase?: string; snapshot?: { phase?: string } }
        | undefined;
      if ((approval?.snapshot?.phase ?? approval?.phase) !== "approved")
        throw Error("Actual consolidated approval did not settle: " + JSON.stringify(notices));
      await command.handler("start", session.extensionRunner.createCommandContext());
      if (workflow.prepareChecker) {
        const deadline = Date.now() + 5000;
        while (latest()?.status !== "paused") {
          if (Date.now() > deadline)
            throw Error(
              "Owned preparation did not reach a bounded native-review hold: " +
                JSON.stringify(latest()),
            );
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await session.waitForIdle();
        const response = manager
          .getBranch()
          .find(
            (row) =>
              row.type === "message" &&
              row.message.role === "toolResult" &&
              row.message.toolCallId === "owned-contract-proposal",
          );
        const text =
          response?.type === "message" && response.message.role === "toolResult"
            ? response.message.content.find((item) => item.type === "text")
            : undefined;
        const proposalId =
          text?.type === "text"
            ? (JSON.parse(text.text) as { proposalId: string }).proposalId
            : undefined;
        if (!proposalId) throw Error("Original preparation proposal unavailable");
        await command.handler(
          `review-contract ${proposalId}`,
          session.extensionRunner.createCommandContext(),
        );
        if (latest()?.status !== "paused")
          throw Error("Definition review improperly cleared the prior hold");
        // This is a Supervisor advisor hold over an uncompiled board, not a
        // paused task board. Explicit recovery is the existing legal entry.
        await command.handler("recover", session.extensionRunner.createCommandContext());
      }
    }
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
    passed = !hooks.approvalWorkflow || latest()?.status === (accepts ? "completed" : "paused");
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
    process.argv = argv;
    [process.stdin, process.stdout].forEach((stream, index) => {
      const descriptor = tty[index];
      if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
      else Reflect.deleteProperty(stream, "isTTY");
    });
    globalThis.fetch = fetch;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (passed) rmSync(dir, { recursive: true, force: true });
    else console.error("Owned covered SDK failure retained:", dir);
    uiDriver?.assertNoScriptErrors();
  }
}
