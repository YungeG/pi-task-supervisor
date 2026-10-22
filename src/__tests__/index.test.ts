import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetState } from "../state";
import { createMockAPI } from "./helpers/mocks";

// We need to mock the tools module since the tool factories depend on the full API
vi.mock("../tools", () => ({
  createWriteTasksTool: vi.fn(() => ({ name: "write_tasks" })),
  createEditTasksTool: vi.fn(() => ({ name: "edit_tasks" })),
  createCompileTasksTool: vi.fn(() => ({ name: "compile_tasks" })),
  createClearTasksTool: vi.fn(() => ({ name: "clear_tasks" })),
  createGetReadyTasksTool: vi.fn(() => ({ name: "get_ready_tasks" })),
  createAdvanceTasksTool: vi.fn(() => ({ name: "advance_tasks" })),
  createWorkflowGateTool: vi.fn(() => ({ name: "workflow_gate" })),
  createSubmitPreflightTool: vi.fn(() => ({ name: "submit_preflight" })),
}));

// Import after mocks are set up
const indexModule = await import("../index");

describe("index (default export)", () => {
  beforeEach(() => {
    resetState();
  });

  it("registers all tools, event handlers, and message renderers", () => {
    const mockObj = createMockAPI();

    indexModule.default(mockObj.api);

    // Seven legacy task tools plus one opt-in proposal-only tool.
    expect(mockObj.registerTool).toHaveBeenCalledTimes(8);
    const toolNames = mockObj.registerTool.mock.calls.map(
      (call: unknown) => (call as [{ name: string }])[0].name,
    );
    expect(toolNames).toContain("write_tasks");
    expect(toolNames).toContain("edit_tasks");
    expect(toolNames).toContain("compile_tasks");
    expect(toolNames).toContain("clear_tasks");
    expect(toolNames).toContain("get_ready_tasks");
    expect(toolNames).toContain("advance_tasks");
    expect(toolNames).toContain("workflow_gate");
    expect(toolNames).toContain("submit_preflight");

    expect(mockObj.registerCommand).toHaveBeenCalledTimes(2);
    expect(mockObj.registerCommand).toHaveBeenCalledWith(
      "task-supervisor",
      expect.objectContaining({ description: expect.any(String) }),
    );
    expect(mockObj.registerCommand).toHaveBeenCalledWith(
      "continuous-tasks",
      expect.objectContaining({ description: expect.any(String) }),
    );

    // Native continuation boundary plus notification-only abort reconciliation.
    expect(mockObj.on).toHaveBeenCalledTimes(11);
    const eventNames = mockObj.on.mock.calls.map((call: unknown) => (call as [string, unknown])[0]);
    expect(eventNames).toContain("session_start");
    expect(eventNames).toContain("agent_start");
    expect(eventNames).toContain("session_tree");
    expect(eventNames).toContain("session_shutdown");
    expect(eventNames).toContain("before_agent_start");
    expect(eventNames).toContain("agent_before_settle");
    expect(eventNames).toContain("agent_settled");
    expect(eventNames).toContain("session_before_compact");
    expect(eventNames).toContain("input");
    expect(eventNames).toContain("tool_call");
    expect(eventNames).toContain("tool_result");

    // Message renderers registered (2 renderers)
    expect(mockObj.registerMessageRenderer).toHaveBeenCalledTimes(2);
    const rendererTypes = mockObj.registerMessageRenderer.mock.calls.map(
      (call: unknown) => (call as [string, unknown])[0],
    );
    expect(rendererTypes).toContain("continuous-tasks:context");
    expect(rendererTypes).toContain("continuous-tasks:notice");
  });
});
