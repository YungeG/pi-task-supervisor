import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
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
} from "./tools";

export default function (pi: ExtensionAPI): void {
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
}
