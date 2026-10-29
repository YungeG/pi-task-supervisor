import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
import {
  createRunCheckTool,
  createProposeContractTool,
  createProposeScopeRevisionTool,
} from "./acceptance-tool";
import { scopedAPI } from "./runtime";
import { registerMessageRenderers } from "./renderers";
import { registerEventHandlers } from "./events";
import {
  createWriteTasksTool,
  createEditTasksTool,
  createCompileTasksTool,
  createClearTasksTool,
  createGetReadyTasksTool,
  createAdvanceTasksTool,
  createWorkflowGateTool,
  createSubmitPreflightTool,
} from "./tools";

/** Component registration only; it does not select a mode, approve or start work. */
export function registerSupervisorComponents(pi: ExtensionAPI): void {
  registerMessageRenderers(pi);
  registerEventHandlers(pi);
  registerCommands(pi);

  pi.registerTool(createWriteTasksTool(pi));
  pi.registerTool(createEditTasksTool(pi));
  pi.registerTool(createCompileTasksTool(pi));
  pi.registerTool(createClearTasksTool(pi));
  pi.registerTool(createGetReadyTasksTool(pi));
  pi.registerTool(createAdvanceTasksTool(pi));
  pi.registerTool(createWorkflowGateTool(pi));
  pi.registerTool(createSubmitPreflightTool(pi));
  pi.registerTool(createRunCheckTool(pi));
  pi.registerTool(createProposeContractTool(pi));
  pi.registerTool(createProposeScopeRevisionTool(pi));
}
export default function (api: ExtensionAPI): void {
  scopedAPI(api, registerSupervisorComponents);
}
