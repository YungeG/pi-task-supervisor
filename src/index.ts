import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands";
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

export default function (api: ExtensionAPI): void {
  scopedAPI(api, (pi) => {
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
  });
}
