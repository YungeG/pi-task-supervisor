// Owned SDK resource probe only. One loader graph; no Main registration tool,
// progress credit, new business permission or task/Goal acceptance is created.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { statSync } from "node:fs";
import { registerSupervisorComponents } from "../src/index";
import { startSupervisor } from "../src/supervisor";
import { enableSessionScope } from "../src/scope";
import { adoptSupervisedMode } from "../src/management-policy";
import { registerProgressMilestone } from "../src/progress-facts";
import { currentRuntime, scopedAPI } from "../src/runtime";
import { readControlJournal, controlReadStats } from "../src/control-journal";
import { journalDecodeStats } from "../src/human-journal";
export default function registrationResource(raw: ExtensionAPI) {
  scopedAPI(raw, (pi) => {
    const count = Number(process.env.P8_REGISTRATION_COUNT ?? "1");
    if (![1, 10, 100].includes(count)) throw Error("Owned registration count must be1/10/100");
    registerSupervisorComponents(pi);
    pi.on("session_start", (_event, ctx) => {
      if (!basename(ctx.cwd).startsWith("owned-p8-registration-"))
        throw Error("Owned registration workspace required");
      if (!currentRuntime().supervisor && !currentRuntime().journalFault) {
        // Host registration-resource module setup, not a human command/approval.
        startSupervisor(pi, ctx, "Owned bounded registration resource");
        enableSessionScope(pi);
        adoptSupervisedMode(pi, ctx);
      }
    });
    let measured = false;
    pi.on("tool_execution_end", (event, ctx) => {
      if (event.toolName !== "get_ready_tasks" || measured) return;
      measured = true;
      if (!basename(ctx.cwd).startsWith("owned-p8-registration-"))
        throw Error("Owned registration workspace required");
      const start = performance.now(),
        samples: number[] = [];
      let registered = 0;
      try {
        for (let i = 0; i < count; i++) {
          const at = performance.now();
          const result = registerProgressMilestone(pi, ctx, {
            id: `owned-${i}`,
            taskId: "t-1.1",
            milestone: "input_difference",
            policy: "git-visible-workspace-v1",
          });
          if (!result) throw Error("Actual trusted registration unavailable or prematurely capped");
          registered++;
          samples.push(performance.now() - at);
          if (performance.now() - start > 10000)
            throw Error(
              "Original100-call10s registration budget exceeded; preserve/profile, do not relax",
            );
        }
        const before = ctx.sessionManager.getLeafId();
        let capHeld = false;
        if (count === 100) {
          capHeld =
            registerProgressMilestone(pi, ctx, {
              id: "over-limit",
              taskId: "t-1.1",
              milestone: "input_difference",
              policy: "git-visible-workspace-v1",
            }) === undefined;
          if (!capHeld || before !== ctx.sessionManager.getLeafId())
            throw Error("Definition cap evicted or appended authority");
        }
        const view = readControlJournal(ctx),
          file = ctx.sessionManager.getSessionFile();
        pi.events.emit("owned-p8-registration", {
          count,
          registered,
          elapsedMs: performance.now() - start,
          samples,
          capHeld,
          definitions:
            view.progressFacts?.filter((row) => row.data.kind === "progress-definition").length ??
            0,
          journalBytes: file ? statSync(file).size : null,
          decode: journalDecodeStats(),
          fold: controlReadStats(),
          maxRssKiB: process.resourceUsage().maxRSS,
          source: "actual-sdk-get_ready_tasks-kernel-end",
          qualification: false,
        });
      } catch (error) {
        pi.events.emit("owned-p8-registration-failure", {
          count,
          registered,
          elapsedMs: performance.now() - start,
          samples,
          error: error instanceof Error ? error.message : "Unknown registration failure",
          journalFault: currentRuntime().journalFault,
        });
        throw error;
      }
    });
  });
}
