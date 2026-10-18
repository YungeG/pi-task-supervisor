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
    italic: vi.fn((text: string) => text),
    underline: vi.fn((text: string) => text),
    strikethrough: vi.fn((text: string) => `~~${text}~~`),
  } as unknown as Theme;
}

/** Creates a mock ExtensionContext with a configurable branch */
export function createMockContext(
  branch: Array<{
    type: string;
    id?: string;
    parentId?: string | null;
    customType?: string;
    data?: unknown;
  }> = [],
): ExtensionToolContext & ExtensionCommandContext {
  const entries = branch.map((entry, index) => ({
    ...entry,
    id: entry.id ?? `initial-${index + 1}`,
    parentId:
      entry.parentId !== undefined
        ? entry.parentId
        : index
          ? (branch[index - 1]?.id ?? `initial-${index}`)
          : null,
  }));
  const getBranch = vi.fn(() => entries);
  const getLeafId = vi.fn(function (this: ExtensionToolContext["sessionManager"]): string | null {
    return this.getBranch().at(-1)?.id ?? null;
  });
  const ctx = {
    hasUI: true,
    mode: "tui",
    waitForIdle: vi.fn(async () => undefined),
    abort: vi.fn(),
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      select: vi.fn(async () => undefined),
      notify: vi.fn(),
    },
    sessionManager: {
      getBranch,
      getSessionId: vi.fn(() => "test-session"),
      getLeafId,
      getLeafEntry: vi.fn(function (this: ExtensionToolContext["sessionManager"]) {
        return this.getBranch().find((entry) => entry.id === this.getLeafId());
      }),
      getEntry: vi.fn(function (this: ExtensionToolContext["sessionManager"], id: string) {
        return this.getBranch().find((entry) => entry.id === id);
      }),
      getEntries: vi.fn(function (this: ExtensionToolContext["sessionManager"]) {
        return this.getBranch();
      }),
      getSessionFile: vi.fn(() => undefined),
    },
    isIdle: vi.fn(() => true),
    hasPendingMessages: vi.fn(() => false),
  };
  return ctx as unknown as ExtensionToolContext & ExtensionCommandContext;
}

let journalSequence = 0;
/** Filesystem/SDK persistence seam: real identities and parent links, never a fixed fake leaf. */
export function attachMockJournal(
  mock: ReturnType<typeof createMockAPI>,
  ctx: ReturnType<typeof createMockContext>,
): void {
  mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
    const entry = {
      id: `journal-${++journalSequence}`,
      parentId: ctx.sessionManager.getLeafId(),
      type: "custom",
      customType,
      data: structuredClone(data),
      timestamp: new Date().toISOString(),
    };
    (ctx.sessionManager.getBranch() as unknown[]).push(entry);
  });
}

/** Append native transcript entries without replacing the evidence branch. */
export function appendMockEntries(
  ctx: ReturnType<typeof createMockContext>,
  entries: Array<Record<string, unknown>>,
): void {
  for (const entry of entries) {
    (ctx.sessionManager.getBranch() as unknown[]).push({
      ...entry,
      id: `native-${++journalSequence}`,
      parentId: ctx.sessionManager.getLeafId(),
      timestamp: new Date().toISOString(),
    });
  }
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
