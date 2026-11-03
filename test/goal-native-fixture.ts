// Offline actual CLI fixture. No argv/TTY/UI/admission substitution; no business effects.
import { join } from "node:path";
import { writeFileSync, appendFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import extension, { registerSupervisorComponents } from "../src/index.ts";
import { currentRuntime, scopedAPI, bindRuntimeCallback } from "../src/runtime.ts";
import { hasActiveNativeQuestion } from "../src/human-ui.ts";
import hostModuleFixture from "./host-module-extension.ts";
import { getBoardRef, setBoard, persistEntries } from "../src/state.ts";
import { answerBoardDecision } from "../src/board-human.ts";
import { approvalNativeResponses } from "./approval-native-responses.ts";
import { readControlJournal } from "../src/control-journal.ts";
import { cachedApprovalAction } from "../src/flow.ts";
import { assessEvidenceCapability } from "../src/execution-capability.ts";

const proposal = {
  summary: "Owned offline native lifecycle check; no business operations",
  steps: ["Return an offline fixture response"],
  acceptance: ["Inspect exact physical lifecycle and permission records"],
  permissions: [
    {
      id: "N1",
      action: "Return an offline fixture response",
      target: "Owned temporary synthetic session only",
      environment: "offline local test",
      required: true,
      limits: "No business operation or external process",
      risks: "Synthetic test only",
      fallback: "Stop this fixture",
      reconfirm: "Any changed target or operation",
    },
  ],
  prohibitions: [
    "No business session, network, repository, install, publish or credential changes",
  ],
  reconfirm: ["Any changed operation"],
};
export default function goalNativeFixture(pi: any) {
  const scenario = process.env.GOAL_NATIVE_SCENARIO;
  let manager: any;
  let idles = 0;
  let readRestored: ((ctx: Parameters<typeof readControlJournal>[0]) => unknown) | undefined;
  let nativeUiPrompts = 0;
  pi.on("ui_prompt_start", (event: unknown) => {
    nativeUiPrompts++;
    appendFileSync(join(process.env.GOAL_NATIVE_OUT!, "native-ui-events.jsonl"), JSON.stringify(event)+"\n");
  });
  const settledObservations: Array<{ idle: boolean; pending: boolean }> = [];
  const scopedObservations: Array<Record<string, unknown>> = [];
  let ownedScopeWriteFailed = false;
  let ownedHumanFault = false;
  let ownedHumanPause = false;
  let compilePauseRelease: (() => void) | undefined;
  const ownedHumanEvents: Array<Record<string, unknown>> = [];
  const branch = () => manager?.getBranch() ?? [];
  const commits = () =>
    branch().filter(
      (entry: any) =>
        entry.customType === "continuous-tasks:supervisor" &&
        entry.data?.version === 5 &&
        entry.data.kind === "transition-committed",
    );
  const faux = fauxProvider({
    provider: "goal-native-fixture",
    models: [{ id: "test", contextWindow: 128000 }],
  });
  faux.setResponses(
    approvalNativeResponses(scenario, branch, proposal) ?? [
      fauxAssistantMessage("GOAL_NATIVE_PLAN_ONE: read-only proposal attempt, no business work"),
      fauxAssistantMessage("GOAL_NATIVE_PLAN_TWO: explicit same-goal replan, no business work"),
      fauxAssistantMessage("GOAL_NATIVE_PLAN_THREE: independent following goal, no business work"),
    ],
  );
  pi.registerProvider(faux.provider);
  if (scenario === "final-guidance") hostModuleFixture(pi);
  else {
    if (scenario === "human-interaction") {
      // Observe real shortcut completion; never substitute context, UI or answers.
      const register = pi.registerShortcut.bind(pi);
      pi.registerShortcut = (key: any, options: any) =>
        register(key, {
          ...options,
          async handler(ctx: any) {
            await options.handler(ctx);
            ctx.ui.notify("GOAL_NATIVE_UI_CLOSED", "info");
          },
        });
    }
    if (["permissions", "human-interaction"].includes(scenario ?? "") || process.env.GOAL_NATIVE_CANCEL_AFTER_START === "1" || process.env.GOAL_NATIVE_PREPARE_FAILURE === "1" || process.env.GOAL_NATIVE_COLD_CHECK === "1" || process.env.GOAL_NATIVE_PROJECTION_FAILURE === "1" || process.env.GOAL_NATIVE_JOINT_RESUME === "1" || (process.env.GOAL_NATIVE_HUMAN_CONTROLS === "1" && scenario === "information")) {
      // Exact production composition plus a readonly runtime observer.
      scopedAPI(pi, (api) => {
        const append = api.appendEntry.bind(api);
        const controlled = { ...api, registerCommand(name: string, command: Parameters<typeof api.registerCommand>[1]) {
          api.registerCommand(name, {...command, handler(args, ctx) {
            if (name === "task-supervisor" && args.startsWith("pause ")) compilePauseRelease?.();
            return command.handler(args, ctx);
          }});
        }, setActiveTools(names: string[]) {
          if (process.env.GOAL_NATIVE_PROJECTION_FAILURE === "1" && currentRuntime().preflight?.started && !ownedHumanFault) { ownedHumanFault = true; throw new Error("Owned tool projection failure"); }
          return api.setActiveTools(names);
        }, appendEntry(type: string, value: unknown) {
          append(type, value);
          const body = value && typeof value === "object" && "snapshot" in value ? value.snapshot : value;
          if (!ownedHumanFault && process.env.GOAL_NATIVE_CANCEL_AFTER_START === "1" && type === "continuous-tasks:preflight" && body && typeof body === "object" && "started" in body && body.started) {
            ownedHumanFault = true;
            api.events.emit("owned-native-cancel", {});
          }
        } };
        api.events.on("owned-native-cancel", () => { api.sendUserMessage("Inspect the retained Start only; no business execution or replay."); });
        registerSupervisorComponents(controlled);
        readRestored = bindRuntimeCallback((ctx) => { const runtime=currentRuntime(), journal=readControlJournal(ctx); return {mode:runtime.management?.mode,journalFault:runtime.journalFault,approval:!!runtime.preflight?.approval,started:!!runtime.preflight?.started,pendingAction:cachedApprovalAction(ctx.sessionManager.getSessionId())?.kind,hasBoundContract:!!journal.acceptance?.latestContractBound}; });
        if (scenario === "information") api.registerCommand("goal-native-pending-info", { handler(_args, context) {
          const board = structuredClone(getBoardRef());
          board.generation++; board.workflowStatus = "waiting_for_decision"; board.pauseReason = undefined;
          board.tasks = [{ id: "owned-info-task", title: "Owned draft", prompt: "Metadata only", profile: "main", phase: 1, dependencies: [], status: "draft", createdAt: "2026-11-02", updatedAt: "2026-11-02" }];
          board.phases = [{ phase: 1, status: "pending" }]; board.finalAcceptanceTaskId = undefined;
          board.decision = { id: "owned-h0-info", taskId: "owned-info-task", question: process.env.GOAL_NATIVE_CHOICE === "1" ? "选择唯一原方案（不扩权）" : "填写候选观察天数", whyUserOwned: "只记录整数，不授权或执行业务。", createdAt: "2026-11-02", ...(process.env.GOAL_NATIVE_CHOICE === "1" ? {options:["保留原方案"],spec:{version:1,kind:"choice"}} : {spec: { version: 1, kind: "information", format: "integer" }}) };
          persistEntries(api, { type: "owned-fixture-question" }, board); setBoard(board);
          context.ui.notify("GOAL_NATIVE_PENDING_READY");
        } });
        api.on("before_agent_start", (event: any) => {
          if (!ownedHumanFault && process.env.GOAL_NATIVE_PREPARE_FAILURE === "1" && event.messageType === "custom" && event.message.customType === "continuous-tasks:continue") {
            ownedHumanFault = true; event.systemPromptOptions.selectedTools = null;
          }
        });
        api.on("tool_result", async (event, ctx) => {
          if (process.env.GOAL_NATIVE_JOINT_RESUME === "1" && !ownedHumanPause && event.toolName === "compile_tasks" && !event.isError) {
            ownedHumanPause = true;
            await new Promise<void>(resolve => { compilePauseRelease = resolve; ctx.ui.notify("GOAL_NATIVE_COMPILE_CHECKPOINT"); });
          }
        });
        api.on("agent_start", () => { ownedHumanEvents.push({ type: "agent_start" }); });
        api.on("agent_settled", (_event, ctx) => {
          ownedHumanEvents.push({ type: "agent_settled", aborted: _event.aborted, failure: (_event as unknown as { idleActionFailure?: unknown }).idleActionFailure ?? null });
          const runtime = currentRuntime();
          scopedObservations.push({
            enabled: runtime.enabled,
            phase: runtime.preflight?.phase,
            preflightSession: runtime.preflight?.sessionId,
            sessionId: ctx.sessionManager.getSessionId(),
            boardStatus: runtime.board.workflowStatus,
            nativeQuestion: hasActiveNativeQuestion(ctx),
          });
        });
      });
    } else extension(pi);
  }
  pi.on("session_start", (_event: any, ctx: any) => {
    manager = ctx.sessionManager;
    if (scenario === "approval-guidance") {
      const append = manager.appendCustomEntry.bind(manager);
      manager.appendCustomEntry = (type: string, data: any) => {
        if (
          !ownedScopeWriteFailed &&
          type === "continuous-tasks:acceptance-facts" &&
          data?.kind === "acceptance-contract-bound" &&
          data.authority?.kind === "scope-revision-reviewed"
        ) {
          ownedScopeWriteFailed = true;
          throw Error("Owned scope binding write failure before append");
        }
        return append(type, data);
      };
    }
    if (process.env.GOAL_NATIVE_COLD_CHECK === "1") {
      writeFileSync(join(process.env.GOAL_NATIVE_OUT!, "cold-ready.json"), JSON.stringify({pid:process.pid,mode:ctx.mode,argv1:process.argv[1],resolvedCodingAgent:import.meta.resolve("@earendil-works/pi-coding-agent")}));
      process.on("SIGUSR1", () => { writeFileSync(join(process.env.GOAL_NATIVE_OUT!, "cold-observer.json"), JSON.stringify({mode:ctx.mode,stdinTty:process.stdin.isTTY,stdoutTty:process.stdout.isTTY,h0:ctx.idleActions?.state(),nativeUiPrompts,modelCalls:faux.state.callCount,restored:readRestored?.(ctx) ?? null})); });
    }
    ctx.ui.notify("GOAL_NATIVE_READY", "info");
  });
  pi.on("before_agent_start", (_event: any, ctx: any) => {
    manager = ctx.sessionManager;
  });
  pi.on("agent_settled", (_event: any, ctx: any) => {
    manager = ctx.sessionManager;
    idles++;
    settledObservations.push({ idle: ctx.isIdle(), pending: ctx.hasPendingMessages() });
    // A second toast in the same tick replaces the pending notice before paint.
    // Keep this synthetic marker out of the notification channel in its native test.
    if (scenario === "permissions") console.log(`GOAL_NATIVE_IDLE_${idles}`);
    else ctx.ui.notify(`GOAL_NATIVE_IDLE_${idles}`, "info");
  });
  if (scenario === "human-interaction") {
    let diagnosticCalls = 0;
    pi.registerCommand("goal-native-diagnostic", {
      description: "Owned native no-answer diagnostic fixture; no business control",
      async handler(_args: string, ctx: any) {
        const board = structuredClone(getBoardRef());
        board.generation++;
        board.workflowStatus = "waiting_for_decision";
        board.decision = {
          id: `owned-diagnostic-${++diagnosticCalls}`,
          taskId: "old-task",
          question: "只验证稍后与未知退出的区别",
          whyUserOwned: "仅临时夹具；不授权或执行任何业务。",
          createdAt: "2026-11-02T00:00:00.000Z",
          spec: { version: 1, kind: "choice" },
          options: ["临时选项"],
        };
        pi.appendEntry("continuous-tasks:snapshot", board);
        setBoard(board);
        const result = await answerBoardDecision(pi, ctx);
        if (result.status !== "deferred" || result.confirmed)
          throw Error("Owned diagnostic unexpectedly submitted a control");
        writeFileSync(
          join(process.env.GOAL_NATIVE_OUT!, `diagnostic-${diagnosticCalls}.json`),
          JSON.stringify(result),
        );
        ctx.ui.notify(`GOAL_NATIVE_DIAGNOSTIC_${result.interaction?.code ?? "missing"}`, "info");
      },
    });
  }
  if (scenario === "information")
    pi.registerCommand("goal-native-information", {
      description: "Owned offline information-card fixture; no business execution",
      async handler(_args: string, ctx: any) {
        const board = structuredClone(getBoardRef());
        board.generation++;
        board.workflowStatus = "waiting_for_decision";
        board.decision = {
          id: "owned-information",
          taskId: "old-task",
          question: "填写候选观察天数",
          whyUserOwned: "只记录一个整数，不授权或执行任务。",
          createdAt: "2026-10-23T00:00:00.000Z",
          spec: { version: 1, kind: "information", format: "integer" },
        };
        pi.appendEntry("continuous-tasks:snapshot", board);
        setBoard(board);
        const result = await answerBoardDecision(pi, ctx);
        if (result.status !== "answered" || result.confirmed?.value !== "42")
          throw new Error("Native information not saved exactly");
        ctx.ui.notify("GOAL_NATIVE_INFORMATION_SAVED", "info");
      },
    });
  pi.registerCommand("goal-native-probe", {
    description: "Read only owned offline fixture metadata",
    handler(label: string, ctx: any) {
      if (!/^[a-z0-9-]+$/.test(label)) throw new Error("Invalid owned fixture label");
      manager = ctx.sessionManager;
      const entries = branch();
      const selected = commits().at(-1);
      const value = {
        scenario,
        mode: ctx.mode,
        stdinTty: process.stdin.isTTY === true,
        stdoutTty: process.stdout.isTTY === true,
        argv1: process.argv[1],
        resolvedCodingAgent: import.meta.resolve("@earendil-works/pi-coding-agent"),
        h0Version: ctx.idleActions?.version ?? null,
        nativeSourceMocked: false,
        businessExecutionCertified: false,
        sessionFile: manager.getSessionFile(),
        leafId: manager.getLeafId(),
        modelCalls: faux.state.callCount,
        codemode: pi
          .getAllTools()
          .filter((tool: any) => tool.name === "codemode")
          .map((tool: any) => ({
            sourceInfo: tool.sourceInfo,
            modelsAdvertised: tool.description.includes("`models`"),
          })),
        evidenceCapability: assessEvidenceCapability(pi),
        idles,
        settledObservations,
        scopedObservations,
        ownedScopeWriteFailed,
        ownedHumanFault,
        ownedHumanPause,
        ownedHumanEvents,
        // This command is outside the supervisor's private scopedAPI runtime.
        // Inspect actual published first-owner facts, not its unrelated default runtime.
        ...(scenario?.startsWith("approval-") || scenario === "final-guidance"
          ? {
              board: [...entries]
                .reverse()
                .find((row: any) => row.customType === "continuous-tasks:snapshot")?.data,
              supervisor: [...entries]
                .reverse()
                .find(
                  (row: any) =>
                    row.customType === "continuous-tasks:supervisor" && row.data?.version === 3,
                )?.data,
              acceptance: readControlJournal(ctx).acceptance,
              stateFromPublishedJournal: true,
            }
          : {}),
        currentGoalRunId: selected?.data.seed.goalRunId,
        entries: entries.filter(
          (entry: any) =>
            entry.type === "custom" ||
            entry.type === "custom_message",
        ),
      };
      writeFileSync(
        join(process.env.GOAL_NATIVE_OUT!, `${label}.json`),
        JSON.stringify(value, null, 2),
      );
      ctx.ui.notify(`GOAL_NATIVE_SAVED_${label}`, "info");
    },
  });
}
