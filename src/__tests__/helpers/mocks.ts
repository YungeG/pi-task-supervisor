import type {
  Theme,
  ExtensionToolContext,
  ExtensionCommandContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/** Creates a mock Theme that returns its arguments wrapped in brackets for assertion */
export function createMockTheme(): Theme {
  return {
    fg: vi.fn((color: string, text: string) => `[${color}]${text}`),
    bold: vi.fn((text: string) => `**${text}**`),
    strikethrough: vi.fn((text: string) => `~~${text}~~`),
  } as unknown as Theme;
}

/** Creates a mock ExtensionContext with a configurable branch */
export function createMockContext(
  branch: Array<{
    type: string;
    customType?: string;
    data?: unknown;
  }> = [],
): ExtensionToolContext & ExtensionCommandContext {
  return {
    hasUI: true,
    waitForIdle: vi.fn(async () => undefined),
    abort: vi.fn(),
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    sessionManager: {
      getBranch: vi.fn(() => branch),
      getSessionId: vi.fn(() => "test-session"),
      getLeafId: vi.fn(() => "test-leaf"),
    },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
  } as unknown as ExtensionToolContext & ExtensionCommandContext;
}

/** Creates a mock ExtensionAPI */
export function createMockAPI(): {
  api: ExtensionAPI;
  sendMessage: ReturnType<typeof vi.fn>;
  sendUserMessage: ReturnType<typeof vi.fn>;
  registerTool: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  registerMessageRenderer: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  getActiveTools: ReturnType<typeof vi.fn>;
  setActiveTools: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
} {
  const sendMessage = vi.fn();
  const sendUserMessage = vi.fn();
  const registerTool = vi.fn();
  const on = vi.fn();
  const registerMessageRenderer = vi.fn();
  const registerCommand = vi.fn();
  const getActiveTools = vi.fn(() => ["read", "write_tasks"]);
  const setActiveTools = vi.fn();
  const appendEntry = vi.fn();

  return {
    api: {
      sendMessage,
      sendUserMessage,
      registerTool,
      on,
      registerMessageRenderer,
      registerCommand,
      getActiveTools,
      setActiveTools,
      appendEntry,
      getAllTools: vi.fn(() => []),
    } as unknown as ExtensionAPI,
    sendMessage,
    sendUserMessage,
    registerTool,
    on,
    registerMessageRenderer,
    registerCommand,
    getActiveTools,
    setActiveTools,
    appendEntry,
  };
}
