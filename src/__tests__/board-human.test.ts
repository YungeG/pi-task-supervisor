const drivers: ReturnType<typeof installCustomUI>[] = [];
afterEach(() => {
  for (const ui of drivers.splice(0)) ui.assertNoScriptErrors();
});
import { installCustomUI } from "./helpers/custom-ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decisionScope, projectBoardAnswer } from "../board-human";
import type { DecisionRecord, TaskBoardSnapshot } from "../types";
import { journalDigest } from "../human-journal";
import { publishReadbackControl, captureReadbackFrame } from "../human-control";
import { requestNativeAnswer, type NativeQuestion } from "../human-ui";

// Mock node:fs at system boundary for trusted TUI tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    realpathSync: vi.fn((path: string) => path),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

// Mock node:fs at system boundary for trusted TUI tests
vi.mock("node:fs", async () => {
  const actual = await vi.importActual("node:fs");
  return {
    ...actual,
    realpathSync: vi.fn((path: string) => path),
    readFileSync: vi.fn(),
    statSync: vi.fn(() => ({ isDirectory: () => true })),
  };
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeDir(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), "board-human-test-"));
  dirs.push(dir);
  return dir;
}

function createBaseBoard(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 1,
    workflowStatus: "waiting_for_decision",
    tasks: [],
    phases: [],
    stagnantSettles: 0,
    ...overrides,
  };
}

function createAuthorizationDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "decision-1",
    taskId: "task-1",
    question: "Approve scope?",
    whyUserOwned: "User must approve the scope",
    spec: {
      version: 1,
      kind: "authorization",
      scope: "Implement feature X",
      prohibitions: ["No database changes"],
    },
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

function createChoiceDecision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "decision-2",
    taskId: "task-2",
    question: "Choose option",
    whyUserOwned: "User must choose",
    spec: { version: 1, kind: "choice" },
    options: ["Option A", "Option B", "Option C"],
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

function createInformationDecision(
  format: "text" | "integer" | "date",
  overrides: Partial<DecisionRecord> = {},
): DecisionRecord {
  return {
    id: "decision-3",
    taskId: "task-3",
    question: "Provide information",
    whyUserOwned: "User must provide info",
    spec: { version: 1, kind: "information", format },
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("decisionScope", () => {
  it("captures immutable decision identity for hashing", () => {
    const decision = createAuthorizationDecision();
    const scope = decisionScope(decision);
    expect(scope).toMatchObject({
      id: decision.id,
      taskId: decision.taskId,
      question: decision.question,
      whyUserOwned: decision.whyUserOwned,
      spec: decision.spec,
      options: decision.options,
      supersedes: decision.supersedes,
    });
  });

  it("produces different digests for different decisions", () => {
    const d1 = createAuthorizationDecision({ id: "d1" });
    const d2 = createAuthorizationDecision({ id: "d2" });
    const scope1 = journalDigest(decisionScope(d1));
    const scope2 = journalDigest(decisionScope(d2));
    expect(scope1).not.toBe(scope2);
  });
});

describe("projectBoardAnswer - authorization", () => {
  it("approves and clears decision, sets workflow to active", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("active");
    expect(next.decision).toBeUndefined();
    expect(next.generation).toBe(base.generation + 1);
    expect(next.stagnantSettles).toBe(0);
  });

  it("rejects and marks decision as rejected, preserves waiting status", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "reject",
      answer: "不批准上述范围",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("waiting_for_decision");
    expect(next.decision?.response).toBe("rejected");
    expect(next.generation).toBe(base.generation + 1);
  });

  it("throws when authorization outcome is missing", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "some answer",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow(
      "Authorization needs an explicit outcome",
    );
  });

  it("throws when decision id does not match", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: "wrong-id",
      outcome: "approve",
      answer: "批准上述范围",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid board human control");
  });

  it("throws when workflow is not waiting_for_decision", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ workflowStatus: "active", decision });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid board human control");
  });

  it("throws when decision has no spec", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision: { ...decision, spec: undefined } });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid board human control");
  });

  it("throws when decision already has a response", () => {
    const decision = createAuthorizationDecision({ response: "rejected" });
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid board human control");
  });

  it("throws when answer is not safe bounded text", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid board human control");
  });

  it("does not modify tasks or phases", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({
      decision,
      tasks: [
        {
          id: "t1",
          title: "Task 1",
          prompt: "p",
          profile: "dev",
          phase: 1,
          dependencies: [],
          status: "draft",
          createdAt: "",
          updatedAt: "",
        },
      ],
      phases: [{ phase: 1, status: "active" }],
    });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.tasks).toEqual(base.tasks);
    expect(next.phases).toEqual(base.phases);
  });
});

describe("projectBoardAnswer - choice", () => {
  it("accepts a captured option", () => {
    const decision = createChoiceDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "Option B",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("active");
    expect(next.decision).toBeUndefined();
    expect(next.generation).toBe(base.generation + 1);
  });

  it("throws when answer is not in captured options", () => {
    const decision = createChoiceDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "Option D",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Unknown decision option");
  });

  it("throws when outcome is not answer", () => {
    const decision = createChoiceDecision();
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "Option A",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Information is not authorization");
  });
});

describe("projectBoardAnswer - information", () => {
  it("accepts valid text", () => {
    const decision = createInformationDecision("text");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "Some text answer",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("active");
    expect(next.decision).toBeUndefined();
  });

  it("accepts valid integer", () => {
    const decision = createInformationDecision("integer");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "42",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("active");
  });

  it("accepts valid negative integer", () => {
    const decision = createInformationDecision("integer");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "-10",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("active");
  });

  it("throws on invalid integer", () => {
    const decision = createInformationDecision("integer");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "3.14",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid information answer");
  });

  it("accepts valid date", () => {
    const decision = createInformationDecision("date");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "2026-10-15",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.workflowStatus).toBe("active");
  });

  it("throws on invalid date format", () => {
    const decision = createInformationDecision("date");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "10/15/2026",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid information answer");
  });

  it("throws on invalid date value", () => {
    const decision = createInformationDecision("date");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "answer",
      answer: "2026-13-45",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Invalid information answer");
  });

  it("throws when outcome is not answer", () => {
    const decision = createInformationDecision("text");
    const base = createBaseBoard({ decision });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "text",
    };
    expect(() => projectBoardAnswer(base, control)).toThrow("Information is not authorization");
  });
});

describe("projectBoardAnswer - invariants", () => {
  it("does not modify executionRef or evidence", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({
      decision,
      tasks: [
        {
          id: "t1",
          title: "Task",
          prompt: "p",
          profile: "dev",
          phase: 1,
          dependencies: [],
          status: "implementing",
          createdAt: "",
          updatedAt: "",
          executionRef: { source: "pi-subagents", runId: "run-1" },
          completionEvidence: { summary: "done", refs: [] },
        },
      ],
    });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.tasks[0]!.executionRef).toEqual(base.tasks[0]!.executionRef);
    expect(next.tasks[0]!.completionEvidence).toEqual(base.tasks[0]!.completionEvidence);
  });

  it("increments generation exactly once", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision, generation: 5 });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.generation).toBe(6);
  });

  it("resets stagnantSettles to zero", () => {
    const decision = createAuthorizationDecision();
    const base = createBaseBoard({ decision, stagnantSettles: 3 });
    const control = {
      id: decision.id,
      outcome: "approve",
      answer: "批准上述范围",
    };
    const next = projectBoardAnswer(base, control);
    expect(next.stagnantSettles).toBe(0);
  });
});

describe("publisher integration (real journal files)", () => {
  const originalArgv = process.argv;
  const originalStdin = process.stdin;
  const originalStdout = process.stdout;

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });
    Object.defineProperty(process, "stdout", { value: originalStdout, writable: true });
    vi.restoreAllMocks();
  });

  async function setupTrustedTui() {
    Object.defineProperty(process, "stdin", { value: { isTTY: true }, writable: true });
    Object.defineProperty(process, "stdout", { value: { isTTY: true }, writable: true });

    const realpathSyncMock = vi.mocked(fs.realpathSync);
    const readFileSyncMock = vi.mocked(fs.readFileSync);
    const statSyncMock = vi.mocked(fs.statSync);

    realpathSyncMock.mockImplementation((path: any) => String(path));
    statSyncMock.mockReturnValue({ isDirectory: () => true } as any);

    // Get actual fs for session file reads
    const actualFs = await vi.importActual("node:fs");

    // Mock readFileSync to return package.json content for trusted package,
    // but allow real reads for session files
    readFileSyncMock.mockImplementation((path: any, options?: any) => {
      const pathStr = String(path);
      if (pathStr.includes("@earendil-works/pi-coding-agent/package.json")) {
        return JSON.stringify({ name: "@earendil-works/pi-coding-agent" });
      }
      // For session files, use real readFileSync
      return (actualFs as any).readFileSync(path, options);
    });

    const nodePath = fs.realpathSync(process.execPath);
    const prefix = nodePath.substring(0, nodePath.lastIndexOf("/bin/node"));
    const trustedCliPath = `${prefix}/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`;
    process.argv = ["node", trustedCliPath];
  }

  function createMockContext(
    sessionFile: string,
    sessionId: string,
    leafId: string,
  ): ExtensionContext {
    const ctx = {
      mode: "tui",
      hasUI: true,
      sessionManager: {
        getSessionFile: vi.fn(() => sessionFile),
        getSessionId: vi.fn(() => sessionId),
        getLeafId: vi.fn(() => leafId),
        getBranch: vi.fn(() => []),
      },
      ui: {
        setWidget: vi.fn(),
        setStatus: vi.fn(),
        select: vi.fn(),
        input: vi.fn(),
        notify: vi.fn(),
      },
      signal: undefined,
    } as unknown as ExtensionContext;
    const ui = installCustomUI(ctx, (d) => {
      d.reviewAll();
    });
    drivers.push(ui);
    return ctx;
  }

  function createMockAPI(): ExtensionAPI {
    return {
      appendEntry: vi.fn(),
    } as unknown as ExtensionAPI;
  }

  it("publishes control and witness to real journal file", async () => {
    await setupTrustedTui();
    const dir = makeDir();
    const sessionFile = join(dir, "session.jsonl");
    const sessionId = "test-session";

    // Create initial journal with header and base snapshot
    const header = { type: "session", version: 3, id: sessionId };
    const baseSnapshot = {
      version: 2,
      generation: 1,
      workflowStatus: "waiting_for_decision",
      tasks: [],
      phases: [],
      stagnantSettles: 0,
      decision: createAuthorizationDecision(),
    };
    const baseEntry = {
      type: "custom",
      id: "base-snapshot",
      parentId: null,
      customType: "continuous-tasks:snapshot",
      data: baseSnapshot,
    };
    fs.writeFileSync(
      sessionFile,
      [header, baseEntry].map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const ctx = createMockContext(sessionFile, sessionId, "base-snapshot");
    const pi = createMockAPI();

    // Mock appendEntry to write to file and update leafId
    let currentLeafId = "base-snapshot";
    let entryCounter = 0;
    vi.mocked(pi.appendEntry).mockImplementation((customType: string, data: unknown) => {
      entryCounter++;
      const newId = `entry-${entryCounter}`;
      const entry = {
        type: "custom",
        id: newId,
        parentId: currentLeafId,
        customType,
        data,
      };
      const content = fs.readFileSync(sessionFile, "utf-8");
      fs.writeFileSync(sessionFile, content + JSON.stringify(entry) + "\n");
      currentLeafId = newId;
      vi.mocked(ctx.sessionManager.getLeafId).mockReturnValue(newId);
      vi.mocked(ctx.sessionManager.getBranch).mockReturnValue([entry] as any);
    });

    // Get a real NativeAnswer through requestNativeAnswer
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("允许上述范围");

    const decision = baseSnapshot.decision;
    const scope = decisionScope(decision);
    const frame = captureReadbackFrame(ctx, "board", decision.id, scope, baseSnapshot);

    const question: NativeQuestion = {
      frame,
      kind: "authorization",
      title: decision.question,
      body: decision.whyUserOwned,
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();

    // Publish the control
    const controlBody = {
      type: "resolve_decision",
      id: decision.id,
      outcome: answer!.outcome,
      answer: "批准上述范围",
    };

    const proof = publishReadbackControl(pi, ctx, answer!, frame, controlBody);
    expect(proof.status).toBe("confirmed");
    expect(proof.control.id).toBeDefined();
    expect(proof.witness.id).toBeDefined();
    expect(proof.frame.requestId).toBe(decision.id);

    // Verify journal file has control and witness
    const journalContent = fs.readFileSync(sessionFile, "utf-8");
    const lines = journalContent.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(4); // header + base + control + witness
  });

  it("rejects when prior control exists for same request", async () => {
    await setupTrustedTui();
    const dir = makeDir();
    const sessionFile = join(dir, "session.jsonl");
    const sessionId = "test-session";

    const header = { type: "session", version: 3, id: sessionId };
    const baseSnapshot = {
      version: 2,
      generation: 1,
      workflowStatus: "waiting_for_decision",
      tasks: [],
      phases: [],
      stagnantSettles: 0,
      decision: createAuthorizationDecision(),
    };
    const baseEntry = {
      type: "custom",
      id: "base-snapshot",
      parentId: null,
      customType: "continuous-tasks:snapshot",
      data: baseSnapshot,
    };

    // Create a prior control for the same request
    const decision = baseSnapshot.decision;
    const scope = decisionScope(decision);
    const frame = {
      version: 1 as const,
      owner: "board" as const,
      sessionId,
      requestId: decision.id,
      presentationId: randomUUID(),
      scopeDigest: journalDigest(scope),
      baseSnapshotEntryId: baseEntry.id,
      baseSnapshotDigest: journalDigest(baseSnapshot),
    };
    const priorControl = {
      type: "custom",
      id: "prior-control",
      parentId: baseEntry.id,
      customType: "continuous-tasks:event",
      data: {
        type: "resolve_decision",
        id: decision.id,
        outcome: "approve",
        answer: "批准",
        humanInteraction: frame,
      },
    };
    const priorWitness = {
      type: "custom",
      id: "prior-witness",
      parentId: priorControl.id,
      customType: "continuous-tasks:human-readback",
      data: {
        version: 1,
        controlEntryId: priorControl.id,
        controlDigest: journalDigest(priorControl),
        frame,
      },
    };

    fs.writeFileSync(
      sessionFile,
      [header, baseEntry, priorControl, priorWitness].map((e) => JSON.stringify(e)).join("\n") +
        "\n",
    );

    const ctx = createMockContext(sessionFile, sessionId, priorWitness.id);
    const pi = createMockAPI();

    // Try to publish another control for the same request
    const selectMock = vi.mocked(ctx.ui.select);
    selectMock.mockResolvedValueOnce("允许上述范围");

    const question: NativeQuestion = {
      frame,
      kind: "authorization",
      title: decision.question,
      body: decision.whyUserOwned,
    };

    const answer = await requestNativeAnswer(ctx, question, () => true);
    expect(answer).toBeDefined();

    const controlBody = {
      type: "resolve_decision",
      id: decision.id,
      outcome: answer!.outcome,
      answer: "批准上述范围",
    };

    // Should throw READBACK_CONFLICT
    expect(() => publishReadbackControl(pi, ctx, answer!, frame, controlBody)).toThrow(
      "READBACK_CONFLICT",
    );
  });
});
