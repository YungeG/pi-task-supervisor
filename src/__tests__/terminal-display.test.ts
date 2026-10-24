import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { normalizeTerminalOutput } from "../../node_modules/@earendil-works/pi-tui/dist/utils.js";
import {
  createAdvanceTasksTool,
  createClearTasksTool,
  createCompileTasksTool,
  createEditTasksTool,
  createGetReadyTasksTool,
  createSubmitPreflightTool,
  createWorkflowGateTool,
  createWriteTasksTool,
} from "../tools";
import { registerMessageRenderers } from "../renderers";
import { digest } from "../receipt-store";
import { safeTerminalText } from "../terminal-text";
import { createEmptyBoard } from "../engine";
import { getBoard, resetState, setBoard } from "../state";
import { setSessionScopeEnabled } from "../scope";
import { activeBoard, lifecycle } from "./helpers/lifecycle";
import { createMockTheme } from "./helpers/mocks";

vi.unmock("@earendil-works/pi-tui");

const clipboardControl = "\u001b]52;c;VEVTVA==\u0007";

function coloredTheme() {
  const theme = createMockTheme();
  vi.mocked(theme.fg).mockImplementation((_color, value) => `\u001b[36m${value}\u001b[39m`);
  return theme;
}

function renderContext<T>(args: T) {
  return {
    args,
    toolCallId: "synthetic-display",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: "/synthetic",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: true,
    showImages: false,
    isError: false,
    durationMs: 0,
    outputPad: 0,
  };
}

beforeEach(() => {
  resetState();
  setSessionScopeEnabled(true);
  setBoard(createEmptyBoard());
});

describe("native terminal display isolation", () => {
  it("escapes task-controlled commands before native Text rendering without changing canonical content", async () => {
    const h = lifecycle();
    const title = `Task ${clipboardControl} END`;
    const tool = createWriteTasksTool(h.mock.api);
    const input = {
      mode: "replace" as const,
      phases: [{ title: "Plan", tasks: [{ title, prompt: "Synthetic work", profile: "main" }] }],
    };
    const result = await tool.execute("untrusted-title", input, undefined, undefined, h.ctx);
    expect(result.isError).not.toBe(true);
    const component = tool.renderResult!(
      result,
      { expanded: true, isPartial: false },
      coloredTheme(),
      renderContext(input),
    );
    expect(component.constructor.name).toBe("Text");
    const display = component.render(240).map(normalizeTerminalOutput).join("\n");
    expect(display.includes(clipboardControl)).toBe(false);
    expect(display.includes("\u001b[36m")).toBe(true);
    expect(getBoard().tasks[0]!.title === title).toBe(true);
    expect(result.details.snapshot.tasks[0]!.title === title).toBe(true);
    expect(
      result.content.some((item) => item.type === "text" && item.text.includes(clipboardControl)),
    ).toBe(true);
  });

  it.each(
    [
      "write_tasks",
      "edit_tasks",
      "compile_tasks",
      "clear_tasks",
      "get_ready_tasks",
      "advance_tasks",
    ].flatMap((name) => ["success", "error", "fallback"].map((scenario) => ({ name, scenario }))),
  )("protects the $name $scenario renderer with real Text", ({ name, scenario }) => {
    const h = lifecycle();
    const tools = [
      createWriteTasksTool(h.mock.api),
      createEditTasksTool(h.mock.api),
      createCompileTasksTool(h.mock.api),
      createClearTasksTool(h.mock.api),
      createGetReadyTasksTool(h.mock.api),
      createAdvanceTasksTool(h.mock.api),
    ];
    const tool = tools.find((candidate) => candidate.name === name)!;
    const snapshot = activeBoard();
    snapshot.tasks[0]!.title += clipboardControl;
    const details =
      scenario === "fallback"
        ? undefined
        : {
            snapshot,
            ...(scenario === "error" ? { error: `Synthetic failure ${clipboardControl}` } : {}),
          };
    // A missing details object is the legacy/fallback render case already supported by these tools.
    const result = {
      content: [{ type: "text" as const, text: `🟢 t-1.1: Task ${clipboardControl} END` }],
      details: details!,
    };
    const before = digest(result);
    const component = tool.renderResult!(
      result,
      { expanded: true, isPartial: false },
      coloredTheme(),
      renderContext({} as never),
    );
    expect(component.constructor.name).toBe("Text");
    const output = component.render(240).map(normalizeTerminalOutput).join("\n");
    expect(output.includes(clipboardControl)).toBe(false);
    if (scenario !== "fallback") expect(output.includes("\u001b[36m")).toBe(true);
    expect(digest(result)).toBe(before);
  });

  it.each([
    { name: "write_tasks", args: { phases: [{ tasks: { length: clipboardControl } }] } },
    { name: "edit_tasks", args: { tasks: { length: clipboardControl } } },
    { name: "advance_tasks", args: { transitions: { length: clipboardControl } } },
    { name: "get_ready_tasks", args: { count: clipboardControl } },
    { name: "workflow_gate", args: { action: clipboardControl } },
  ])("protects $name call previews before argument validation", ({ name, args }) => {
    const h = lifecycle();
    const tools = [
      createWriteTasksTool(h.mock.api),
      createEditTasksTool(h.mock.api),
      createAdvanceTasksTool(h.mock.api),
      createGetReadyTasksTool(h.mock.api),
      createWorkflowGateTool(h.mock.api),
    ];
    const tool = tools.find((candidate) => candidate.name === name)!;
    const before = digest(args);
    // The SDK previews streamed arguments before tool argument validation.
    const component = tool.renderCall!(args as never, coloredTheme(), {
      ...renderContext(args as never),
      argsComplete: false,
      executionStarted: false,
    });
    const output = component.render(240).map(normalizeTerminalOutput).join("\n");
    expect(output.includes(clipboardControl)).toBe(false);
    expect(output.includes("\u001b[36m")).toBe(true);
    expect(digest(args)).toBe(before);
  });

  it.each(
    ["continuous-tasks:context", "continuous-tasks:notice"].flatMap((customType) =>
      [false, true].map((structured) => ({ customType, structured })),
    ),
  )(
    "protects $customType (structured=$structured) without changing custom-message content",
    ({ customType, structured }) => {
      const h = lifecycle();
      registerMessageRenderers(h.mock.api);
      const renderer = h.mock.registerMessageRenderer.mock.calls.find(
        ([name]) => name === customType,
      )?.[1] as Parameters<ExtensionAPI["registerMessageRenderer"]>[1];
      const text = `Notice ${clipboardControl} \u202e END`;
      const message = {
        role: "custom" as const,
        customType,
        content: structured ? [{ type: "text" as const, text }] : text,
        display: true,
        timestamp: 0,
      };
      const before = digest(message);
      const component = renderer(message, { expanded: true, outputPad: 0 }, coloredTheme())!;
      expect(component.constructor.name).toBe("Text");
      const output = component.render(240).map(normalizeTerminalOutput).join("\n");
      expect(output.includes(clipboardControl) || output.includes("\u202e")).toBe(false);
      expect(output.includes("\u001b[36m")).toBe(true);
      expect(digest(message)).toBe(before);
    },
  );

  it.each(["error", "expanded-proposal"])(
    "protects preflight %s display without changing request material",
    (scenario) => {
      const h = lifecycle();
      const proposal = {
        summary: "Unsubmitted proposal \u202e END",
        steps: ["Plan"],
        acceptance: ["Check"],
        prohibitions: [],
        reconfirm: [],
        permissions: [
          {
            id: "A1",
            action: "Read",
            target: "Fixture",
            environment: "Local",
            required: true,
            limits: "Read only",
            risks: "None",
            fallback: "Defer",
            reconfirm: "Scope changes",
          },
        ],
      };
      const details =
        scenario === "error"
          ? { error: `Synthetic error ${clipboardControl}` }
          : {
              state: {
                version: 2 as const,
                sessionId: "synthetic",
                preflightId: "pf-display",
                goal: "Read fixture",
                revision: 1,
                phase: "awaiting_authorization" as const,
                proposal,
                permissionRequest: { id: "r", permissionIds: ["A1"] },
              },
              status: "partial" as const,
            };
      const result = { content: [{ type: "text" as const, text: "Machine result" }], details };
      const before = digest(result);
      const component = createSubmitPreflightTool(h.mock.api).renderResult!(
        result,
        { expanded: true, isPartial: false },
        coloredTheme(),
        renderContext({} as never),
      );
      expect(component.constructor.name).toBe("Text");
      const output = component.render(240).map(normalizeTerminalOutput).join("\n");
      expect(output.includes(clipboardControl) || output.includes("\u202e")).toBe(false);
      expect(output.includes("\u001b[36m")).toBe(true);
      expect(digest(result)).toBe(before);
    },
  );

  it("renders a streamed workflow call before its action arrives", () => {
    const h = lifecycle();
    const component = createWorkflowGateTool(h.mock.api).renderCall!({} as never, coloredTheme(), {
      ...renderContext({} as never),
      argsComplete: false,
      executionStarted: false,
    });
    expect(component.render(240).some((line) => line.includes("workflow_gate"))).toBe(true);
  });

  it.each(["error", "expanded-board"])("protects workflow-gate %s display", (scenario) => {
    const h = lifecycle();
    const snapshot = activeBoard();
    snapshot.tasks[0]!.title += clipboardControl;
    snapshot.workflowStatus = "waiting_for_decision";
    snapshot.decision = {
      id: "decision-display",
      taskId: snapshot.tasks[0]!.id,
      question: `Choose ${clipboardControl}`,
      whyUserOwned: "Synthetic choice",
      options: [`Option ${clipboardControl}`, "Defer"],
      spec: { version: 1, kind: "choice" },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const result = {
      content: [{ type: "text" as const, text: "Machine result" }],
      details: {
        snapshot,
        ...(scenario === "error" ? { error: `Failure ${clipboardControl}` } : {}),
      },
    };
    const before = digest(result);
    const component = createWorkflowGateTool(h.mock.api).renderResult!(
      result,
      { expanded: true, isPartial: false },
      coloredTheme(),
      renderContext({} as never),
    );
    expect(component.constructor.name).toBe("Text");
    const output = component.render(240).map(normalizeTerminalOutput).join("\n");
    expect(output.includes(clipboardControl)).toBe(false);
    expect(output.includes("\u001b[36m")).toBe(true);
    expect(digest(result)).toBe(before);
  });

  it.each([
    { name: "ANSI", input: "\u001b[31m", expected: "\\u{1B}[31m" },
    { name: "BEL", input: "\u0007", expected: "\\u{7}" },
    { name: "C1", input: "\u009b2J", expected: "\\u{9B}2J" },
    { name: "bidi", input: "\u202e", expected: "\\u{202E}" },
    { name: "surrogate", input: "\ud800", expected: "\\u{D800}" },
    { name: "zero-width format", input: "\u200b", expected: "\\u{200B}" },
    {
      name: "other ASCII controls",
      input: "\r\b\u0000\u007f",
      expected: "\\u{D}\\u{8}\\u{0}\\u{7F}",
    },
    {
      name: "Unicode and layout",
      input: "中文 ▶️ e\u0301\n\tEND",
      expected: "中文 ▶️ e\u0301\n\tEND",
    },
  ])("keeps a visible display representation: $name", ({ input, expected }) => {
    expect(safeTerminalText(input) === expected).toBe(true);
  });
});
