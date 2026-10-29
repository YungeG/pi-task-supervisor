// Offline actual CLI fixture. No argv/TTY/UI/admission substitution; no business effects.
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import extension from "../src/index.ts";
import { getBoardRef, setBoard } from "../src/state.ts";
import { answerBoardDecision } from "../src/board-human.ts";
import { approvalNativeResponses } from "./approval-native-responses.ts";
import { readControlJournal } from "../src/control-journal.ts";
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
  extension(pi);
  pi.on("session_start", (_event: any, ctx: any) => {
    manager = ctx.sessionManager;
    ctx.ui.notify("GOAL_NATIVE_READY", "info");
  });
  pi.on("before_agent_start", (_event: any, ctx: any) => {
    manager = ctx.sessionManager;
  });
  pi.on("agent_settled", (_event: any, ctx: any) => {
    manager = ctx.sessionManager;
    idles++;
    ctx.ui.notify(`GOAL_NATIVE_IDLE_${idles}`, "info");
  });
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
        // This command is outside the supervisor's private scopedAPI runtime.
        // Inspect actual published first-owner facts, not its unrelated default runtime.
        ...(scenario?.startsWith("approval-")
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
            (entry.type === "custom_message" &&
              entry.customType === "continuous-tasks:preflight-planning"),
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
