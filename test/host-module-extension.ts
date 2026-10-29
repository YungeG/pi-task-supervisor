// Existing SDK kernel/effects/management mechanism fixtures. This is not a user
// command, native business approval or first-Start qualification. Fresh command
// authority is verified separately by the actual CLI/PTY suites.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { registerSupervisorComponents } from "../src/index";
import { scopedAPI, currentRuntime } from "../src/runtime";
import { startSupervisor } from "../src/supervisor";
import { enableSessionScope } from "../src/scope";
import { adoptSupervisedMode } from "../src/management-policy";
export default function hostModuleFixture(pi: ExtensionAPI): void {
  const goal = process.env.OWNED_HOST_MODULE_GOAL,targetSession=process.env.OWNED_HOST_MODULE_SESSION;
  scopedAPI(pi, (api) => {
    registerSupervisorComponents(api);
    api.on("session_start", (_event, ctx) => {
      if (!goal || !targetSession || ctx.sessionManager.getSessionId()!==targetSession || currentRuntime().supervisor || currentRuntime().journalFault) return;
      if (!/^(?:owned-|pi-task-supervisor-smoke-)/.test(basename(ctx.cwd)))
        throw Error("Trusted-host module fixture requires an isolated owned workspace");
      startSupervisor(api, ctx, goal);
      enableSessionScope(api);
      adoptSupervisedMode(api, ctx);
    });
  });
}
