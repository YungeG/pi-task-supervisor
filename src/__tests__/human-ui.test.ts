import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync, readFileSync, statSync } from "node:fs";
import type { ReadbackFrame } from "../human-journal";
import {
  isTrustedLocalTui,
  requestNativeAnswer,
  requireNativeAnswer,
  trustedCliRoots,
  type NativeQuestion,
} from "../human-ui";

// Mock node:fs at system boundary for trusted TUI tests
vi.mock("node:fs", () => ({
  realpathSync: vi.fn((path: string) => path),
  readFileSync: vi.fn(),
  statSync: vi.fn(() => ({ isDirectory: () => true })),
}));

const originalArgv = process.argv;
const originalStdin = process.stdin;
const originalStdout = process.stdout;

afterEach(() => {
  process.argv = originalArgv;
  Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
  Object.defineProperty(process, "stdout", { value: originalStdout, writable: true });
  vi.restoreAllMocks();
});

function createMockFrame(overrides: Partial<ReadbackFrame> = {}): ReadbackFrame {
  return {
    version: 1,
    owner: "board",
    sessionId: "test-session",
    requestId: "test-request",
    presentationId: "test-presentation",
    scopeDigest: "a".repeat(64),
    baseSnapshotEntryId: "test-base",
    baseSnapshotDigest: "b".repeat(64),
    ...overrides,
  };
}

function createMockContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
  return {
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionId: vi.fn(() => "test-session"),
      getLeafId: vi.fn(() => "test-leaf"),
      getBranch: vi.fn(() => []),
    },
    ui: {
      select: vi.fn(),
      input: vi.fn(),
      notify: vi.fn(),
    },
    signal: undefined,
    ...overrides,
  } as unknown as ExtensionContext;
}

describe("trustedCliRoots", () => {
  it("returns array of trusted roots", () => {
    const roots = trustedCliRoots();
    expect(Array.isArray(roots)).toBe(true);
  });
});

describe("isTrustedLocalTui - negative cases", () => {
  it("rejects non-tui mode", () => {
    const ctx = createMockContext({ mode: "rpc" });
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects print mode", () => {
    const ctx = createMockContext({ mode: "print" });
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects json mode", () => {
    const ctx = createMockContext({ mode: "json" });
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects missing hasUI", () => {
    const ctx = createMockContext({ hasUI: false });
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects non-TTY stdin", () => {
    Object.defineProperty(process, "stdin", { value: { isTTY: false }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });
    const ctx = createMockContext();
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects non-TTY stdout", () => {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: false }, writable: true });
    const ctx = createMockContext();
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects missing argv[1]", () => {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });
    process.argv = ["node"];
    const ctx = createMockContext();
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("rejects non-matching CLI path", () => {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });
    process.argv = ["node", "/usr/local/bin/fake-cli.js"];
    const ctx = createMockContext();
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });

  it("CRITICAL: rejects SDK script even with double TTY and tui mode", () => {
    // This is the key security test from the contract
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });
    process.argv = ["node", "/tmp/sdk-script.js"];
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    // Even with tui mode and hasUI, SDK script must be rejected
    expect(isTrustedLocalTui(ctx)).toBe(false);
  });
});

describe("requestNativeAnswer - rejection cases", () => {
  it("returns undefined when not trusted TUI (RPC mode)", async () => {
    const ctx = createMockContext({ mode: "rpc" });
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "authorization",
      title: "Test",
      body: "Test body",
    };
    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
    // UI should not be called
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("returns undefined when not trusted TUI (SDK script)", async () => {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });
    process.argv = ["node", "/tmp/sdk.js"];
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "authorization",
      title: "Test",
      body: "Test body",
    };
    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("returns undefined when isCurrent is false before UI", async () => {
    const ctx = createMockContext({ mode: "rpc" }); // Will fail trust check first
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "authorization",
      title: "Test",
      body: "Test body",
    };
    const result = await requestNativeAnswer(ctx, question, () => false);
    expect(result).toBeUndefined();
  });

  it("returns undefined when signal is aborted before UI", async () => {
    const ctx = createMockContext({ mode: "rpc" });
    const controller = new AbortController();
    controller.abort();
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "authorization",
      title: "Test",
      body: "Test body",
    };
    const result = await requestNativeAnswer(ctx, question, () => true, controller.signal);
    expect(result).toBeUndefined();
  });

  it("returns undefined when session has no ID", async () => {
    const ctx = createMockContext({
      mode: "rpc",
      sessionManager: {
        getSessionId: vi.fn(() => ""),
        getLeafId: vi.fn(() => "test-leaf"),
        getBranch: vi.fn(() => []),
      },
    } as unknown as ExtensionContext);
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "authorization",
      title: "Test",
      body: "Test body",
    };
    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
  });
});

describe("requireNativeAnswer - validation", () => {
  it("throws on null answer", () => {
    const ctx = createMockContext();
    const frame = createMockFrame();
    expect(() => requireNativeAnswer(ctx, null, frame)).toThrow("Invalid native answer");
  });

  it("throws on non-object answer", () => {
    const ctx = createMockContext();
    const frame = createMockFrame();
    expect(() => requireNativeAnswer(ctx, "string", frame)).toThrow("Invalid native answer");
    expect(() => requireNativeAnswer(ctx, 123, frame)).toThrow("Invalid native answer");
  });

  it("throws on unrecognized answer object", () => {
    const ctx = createMockContext();
    const frame = createMockFrame();
    const fakeAnswer = { outcome: "approve", value: undefined, answeredAt: Date.now() };
    expect(() => requireNativeAnswer(ctx, fakeAnswer, frame)).toThrow("Unrecognized native answer");
  });

  it("throws on DTO copy (JSON-like object)", () => {
    const ctx = createMockContext();
    const frame = createMockFrame();
    // Simulate a DTO copy that looks like an answer but isn't registered
    const dtoCopy = JSON.parse(
      JSON.stringify({ outcome: "approve", value: undefined, answeredAt: Date.now() }),
    );
    expect(() => requireNativeAnswer(ctx, dtoCopy, frame)).toThrow("Unrecognized native answer");
  });
});

describe("NativeQuestion structure", () => {
  it("accepts authorization kind", () => {
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "authorization",
      title: "Authorize",
      body: "Please approve",
    };
    expect(question.kind).toBe("authorization");
  });

  it("accepts choice kind with options", () => {
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "choice",
      title: "Choose",
      body: "Pick one",
      options: ["A", "B", "C"],
    };
    expect(question.kind).toBe("choice");
    expect(question.options).toEqual(["A", "B", "C"]);
  });

  it("accepts information kind with validator", () => {
    const validator = (v: string) => v.length > 0;
    const question: NativeQuestion = {
      frame: createMockFrame(),
      kind: "information",
      title: "Enter",
      body: "Provide info",
      informationValidator: validator,
    };
    expect(question.kind).toBe("information");
    expect(question.informationValidator).toBe(validator);
  });
});

describe("requestNativeAnswer - positive mechanism tests", () => {
  // Helper to setup trusted TUI environment
  function setupTrustedTui() {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });

    // Mock fs operations at system boundary
    const realpathSyncMock = vi.mocked(realpathSync);
    const readFileSyncMock = vi.mocked(readFileSync);
    const statSyncMock = vi.mocked(statSync);

    // Mock realpathSync to return the path as-is
    realpathSyncMock.mockImplementation((path: any) => String(path));

    // Mock statSync to indicate directory
    statSyncMock.mockReturnValue({ isDirectory: () => true } as any);

    // Mock readFileSync to return package.json content for trusted package
    readFileSyncMock.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes("@earendil-works/pi-coding-agent/package.json")) {
        return JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
      }
      throw new Error("File not found");
    });

    // Use the actual node execPath to construct the trusted CLI path
    const nodePath = realpathSync(process.execPath);
    const prefix = nodePath.substring(0, nodePath.lastIndexOf("/bin/node"));
    const trustedCliPath = `${prefix}/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`;
    process.argv = ["node", trustedCliPath];
  }

  it("returns approve answer when user selects Approve", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Please approve",
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeDefined();
    expect(result?.outcome).toBe("approve");
    expect(result?.value).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns reject answer when user selects Reject", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Reject");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Please reject",
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeDefined();
    expect(result?.outcome).toBe("reject");
    expect(result?.value).toBeUndefined();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns undefined when user selects Defer (no decision)", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Defer");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Please defer",
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
  });

  it("returns answer for choice question", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Option B");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "choice",
      title: "Choose",
      body: "Pick one",
      options: ["Option A", "Option B", "Option C"],
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeDefined();
    expect(result?.outcome).toBe("answer");
    expect(result?.value).toBe("Option B");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("returns answer for information question with valid input", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const inputMock = vi.mocked(ctx.ui.input);
    inputMock.mockResolvedValueOnce("Valid input text");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "information",
      title: "Enter",
      body: "Provide info",
      informationValidator: (v) => v.length > 0,
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeDefined();
    expect(result?.outcome).toBe("answer");
    expect(result?.value).toBe("Valid input text");
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects information with secret-like content", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const inputMock = vi.mocked(ctx.ui.input);
    inputMock.mockResolvedValueOnce("password=secret123");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "information",
      title: "Enter",
      body: "Provide info",
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
  });

  it("rejects information exceeding 1000 char limit", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const inputMock = vi.mocked(ctx.ui.input);
    inputMock.mockResolvedValueOnce("a".repeat(1001));

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "information",
      title: "Enter",
      body: "Provide info",
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
  });

  it("rejects when frame.sessionId does not match ctx.sessionId", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "different-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const result = await requestNativeAnswer(ctx, question, () => true);
    expect(result).toBeUndefined();
  });

  it("rejects when isCurrent becomes false during UI", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);

    let isCurrentFlag = true;
    selectMock.mockImplementation(async () => {
      isCurrentFlag = false; // Become non-current during UI
      return "Approve";
    });

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const result = await requestNativeAnswer(ctx, question, () => isCurrentFlag);
    expect(result).toBeUndefined();
  });

  it("rejects when signal aborts during UI", async () => {
    setupTrustedTui();
    const controller = new AbortController();
    const ctx = createMockContext({ mode: "tui", hasUI: true, signal: controller.signal });
    const selectMock = vi.mocked(ctx.ui.select);

    selectMock.mockImplementation(async () => {
      controller.abort(); // Abort during UI
      return "Approve";
    });

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const result = await requestNativeAnswer(ctx, question, () => true, controller.signal);
    expect(result).toBeUndefined();
  });

  it("prevents concurrent questions for same sessionManager", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);

    let resolveFirst: ((value: string) => void) | undefined;
    selectMock.mockImplementation(() => {
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    });

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const firstPromise = requestNativeAnswer(ctx, question, () => true);
    const secondResult = await requestNativeAnswer(ctx, question, () => true);

    expect(secondResult).toBeUndefined();

    resolveFirst?.("Approve");
    const firstResult = await firstPromise;
    expect(firstResult?.outcome).toBe("approve");
  });
});

describe("requireNativeAnswer - enhanced validation", () => {
  function setupTrustedTui() {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });

    // Mock fs operations at system boundary
    const realpathSyncMock = vi.mocked(realpathSync);
    const readFileSyncMock = vi.mocked(readFileSync);
    const statSyncMock = vi.mocked(statSync);

    // Mock realpathSync to return the path as-is
    realpathSyncMock.mockImplementation((path: any) => String(path));

    // Mock statSync to indicate directory
    statSyncMock.mockReturnValue({ isDirectory: () => true } as any);

    // Mock readFileSync to return package.json content for trusted package
    readFileSyncMock.mockImplementation((path: any) => {
      const pathStr = String(path);
      if (pathStr.includes("@earendil-works/pi-coding-agent/package.json")) {
        return JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
      }
      throw new Error("File not found");
    });

    // Use the actual node execPath to construct the trusted CLI path
    const nodePath = realpathSync(process.execPath);
    const prefix = nodePath.substring(0, nodePath.lastIndexOf("/bin/node"));
    const trustedCliPath = `${prefix}/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`;
    process.argv = ["node", trustedCliPath];
  }

  it("rejects mutable answer object", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();

    // Try to mutate (should fail silently or throw in strict mode)
    const mutableAnswer = { ...answer };
    expect(() => requireNativeAnswer(ctx, mutableAnswer, question.frame)).toThrow(
      "Unrecognized native answer",
    );
  });

  it("rejects when session ID changes after answer", async () => {
    setupTrustedTui();
    const sessionManager = {
      getSessionId: vi.fn(() => "test-session"),
      getLeafId: vi.fn(() => "test-leaf"),
      getBranch: vi.fn(() => []),
    } as any;
    const ctx = createMockContext({ mode: "tui", hasUI: true, sessionManager });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();

    // Change session ID
    sessionManager.getSessionId.mockReturnValue("different-session");

    expect(() => requireNativeAnswer(ctx, answer, question.frame)).toThrow("Session ID changed");
  });

  it("rejects when isCurrent becomes false at require time", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    let isCurrentFlag = true;
    const answer = await requestNativeAnswer(ctx, question, () => isCurrentFlag);
    expect(answer).toBeDefined();

    isCurrentFlag = false;
    expect(() => requireNativeAnswer(ctx, answer, question.frame)).toThrow(
      "Request no longer current",
    );
  });

  it("rejects when frame version is not 1", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();

    const invalidFrame = { ...question.frame, version: 2 as unknown as 1 };
    expect(() => requireNativeAnswer(ctx, answer, invalidFrame)).toThrow("Invalid frame version");
  });

  it("rejects DTO copy even with correct fields", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();

    // Create DTO copy
    const dtoCopy = {
      outcome: answer?.outcome,
      value: answer?.value,
      answeredAt: answer?.answeredAt,
    };

    expect(() => requireNativeAnswer(ctx, dtoCopy, question.frame)).toThrow(
      "Unrecognized native answer",
    );
  });

  it("accepts valid frozen answer with all checks passing", async () => {
    setupTrustedTui();
    const ctx = createMockContext({ mode: "tui", hasUI: true });
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("Approve");

    const question: NativeQuestion = {
      frame: createMockFrame({ sessionId: "test-session" }),
      kind: "authorization",
      title: "Authorize",
      body: "Test",
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();
    expect(Object.isFrozen(answer)).toBe(true);

    const result = requireNativeAnswer(ctx, answer, question.frame);
    expect(result.outcome).toBe("approve");
  });
});
