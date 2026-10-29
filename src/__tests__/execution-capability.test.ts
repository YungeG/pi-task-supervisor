// Registry metadata policy only; no native execution or business authority proof.
import { expect, it, vi } from "vitest";
import { createCodemodeExtension, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { createMockContext } from "./helpers/mocks";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { emptyInvocationGraph } from "../invocation-tree";
import { registeredCheckInvocationIssue } from "../execution-capability";
import { createMockAPI } from "./helpers/mocks";
import { assessEvidenceCapability } from "../execution-capability";
function profile(models: boolean, mode: "on" | "only") {
  const h = createMockAPI();
  let definition: Pick<ToolInfo, "parameters" | "description"> | undefined;
  void createCodemodeExtension({ models })({
    registerTool: (tool) => {
      definition = tool;
    },
  } as Parameters<ReturnType<typeof createCodemodeExtension>>[0]);
  if (!definition) throw Error("Actual SDK schema missing");
  const tool: ToolInfo = {
    ...definition,
    name: "codemode",
    exposure: "model-only",
    sourceInfo: {
      path: "builtin:codemode",
      source: "builtin",
      scope: "temporary",
      origin: "top-level",
    },
  };
  vi.mocked(h.api.getAllTools).mockReturnValue([...h.api.getAllTools(), tool]);
  h.getActiveTools.mockReturnValue(["codemode"]);
  Object.assign(h.api, { getSettings: () => ({ codemode: { mode } }) });
  return h;
}
it("selects an available direct formal route with default models-enabled codemode still present", () => {
  expect(assessEvidenceCapability(profile(true, "on").api).route).toBe("direct-check");
});
it("rejects an only-container loadout whose real SDK metadata exposes models", () => {
  expect(assessEvidenceCapability(profile(true, "only").api)).toMatchObject({
    route: "unsupported",
  });
});
it("recognizes only the actual original tools-only SDK metadata as a container profile", () => {
  const h = profile(false, "only");
  expect(assessEvidenceCapability(h.api).route).toBe("tools-only-container");
  const tools = h.api
    .getAllTools()
    .map((tool) =>
      tool.name === "codemode" ? { ...tool, parameters: structuredClone(tool.parameters) } : tool,
    );
  vi.mocked(h.api.getAllTools).mockReturnValue(tools);
  expect(assessEvidenceCapability(h.api).route).toBe("unsupported");
});
it("rejects nested checks without original metadata, invocation graph or owner", () => {
  resetState();
  const h = profile(true, "on"),
    ctx = createMockContext(),
    input = { checkId: "owned" };
  expect(
    registeredCheckInvocationIssue(h.api, ctx, {
      type: "tool_call",
      toolName: "read",
      toolCallId: "r",
      input,
      parentToolCallId: "root",
    }),
  ).toBeUndefined();
  expect(
    registeredCheckInvocationIssue(h.api, ctx, {
      type: "tool_call",
      toolName: "run_check",
      toolCallId: "c",
      input,
    }),
  ).toBeUndefined();
  const event = {
    type: "tool_call" as const,
    toolName: "run_check",
    toolCallId: "c",
    input,
    parentToolCallId: "root",
  };
  expect(registeredCheckInvocationIssue(h.api, ctx, event)).toMatch(/actual current invocation/);
  currentRuntime().controlJournal = { invocations: emptyInvocationGraph() };
  expect(registeredCheckInvocationIssue(h.api, ctx, event)).toMatch(/actual current invocation/);
  vi.mocked(h.api.getAllTools).mockReturnValue([]);
  expect(registeredCheckInvocationIssue(h.api, ctx, event)).toMatch(/metadata is unavailable/);
});
it("does not promise a formal route when the original registered checker is absent", () => {
  const h = profile(true, "on");
  vi.mocked(h.api.getAllTools).mockReturnValue(
    h.api.getAllTools().filter((tool) => tool.name !== "run_check"),
  );
  expect(assessEvidenceCapability(h.api).route).toBe("unsupported");
});
