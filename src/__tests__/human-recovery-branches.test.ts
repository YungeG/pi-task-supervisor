import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canReplaceBoardDecision,
  decisionScope,
  projectBoardAnswer,
  restoreBoardHuman,
  repairBoardProjection,
} from "../board-human";
import type { DecisionRecord, TaskBoardSnapshot } from "../types";
import { currentRuntime } from "../runtime";
import { resetState } from "../state";
import { createMockAPI, createMockContext } from "./helpers/mocks";

const dirs: string[] = [];

beforeEach(() => {
  resetState();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "board-recovery-"));
  dirs.push(dir);
  return dir;
}

function baseBoard(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
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

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: "decision-1",
    taskId: "task-1",
    question: "Approve?",
    whyUserOwned: "User must approve",
    spec: {
      version: 1,
      kind: "authorization",
      scope: "Test scope",
      prohibitions: ["No network"],
    },
    createdAt: "now",
    ...overrides,
  };
}

describe("canReplaceBoardDecision edge cases", () => {
  it("rejects when workflowStatus is not waiting_for_decision", () => {
    const board = baseBoard({ workflowStatus: "active" });
    const input = { action: "wait_for_decision", taskId: "task-1", decision: {} };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("rejects when board has no decision", () => {
    const board = baseBoard({ decision: undefined });
    const input = { action: "wait_for_decision", taskId: "task-1", decision: {} };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("rejects when action is not wait_for_decision", () => {
    const board = baseBoard({ decision: decision() });
    const input = { action: "other", taskId: "task-1", decision: {} };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("rejects when taskId does not match", () => {
    const board = baseBoard({ decision: decision() });
    const input = { action: "wait_for_decision", taskId: "other-task", decision: {} };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("rejects when proposal has no supersedes field", () => {
    const board = baseBoard({ decision: decision() });
    const input = {
      action: "wait_for_decision",
      taskId: "task-1",
      decision: { spec: { version: 1, kind: "authorization", scope: "x", prohibitions: [] } },
    };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("rejects when supersedes does not match board decision id", () => {
    const board = baseBoard({ decision: decision() });
    const input = {
      action: "wait_for_decision",
      taskId: "task-1",
      decision: {
        supersedes: "other-id",
        spec: { version: 1, kind: "authorization", scope: "x", prohibitions: [] },
      },
    };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("rejects when spec is invalid", () => {
    const board = baseBoard({ decision: decision() });
    const input = {
      action: "wait_for_decision",
      taskId: "task-1",
      decision: { supersedes: "decision-1", spec: { version: 1, kind: "invalid" } },
    };
    expect(canReplaceBoardDecision(board, input)).toBe(false);
  });

  it("accepts valid replacement proposal", () => {
    const board = baseBoard({ decision: decision() });
    const input = {
      action: "wait_for_decision",
      taskId: "task-1",
      decision: {
        supersedes: "decision-1",
        spec: { version: 1, kind: "authorization", scope: "x", prohibitions: [] },
      },
    };
    expect(canReplaceBoardDecision(board, input)).toBe(true);
  });
});

describe("decisionScope", () => {
  it("extracts scope fields from decision", () => {
    const d = decision();
    const scope = decisionScope(d) as any;
    expect(scope.id).toBe(d.id);
    expect(scope.taskId).toBe(d.taskId);
    expect(scope.question).toBe(d.question);
    expect(scope.whyUserOwned).toBe(d.whyUserOwned);
    expect(scope.spec).toBe(d.spec);
    expect(scope.options).toBe(d.options);
    expect(scope.supersedes).toBe(d.supersedes);
  });
});

describe("projectBoardAnswer validation", () => {
  it("throws when workflowStatus is not waiting_for_decision", () => {
    const board = baseBoard({ workflowStatus: "active", decision: decision() });
    expect(() => {
      projectBoardAnswer(board, { id: "decision-1", answer: "42", outcome: "answer" });
    }).toThrow("Invalid board human control");
  });

  it("throws when decision is missing", () => {
    const board = baseBoard({ decision: undefined });
    expect(() => {
      projectBoardAnswer(board, { id: "decision-1", answer: "42", outcome: "answer" });
    }).toThrow("Invalid board human control");
  });

  it("throws when decision already has response", () => {
    const board = baseBoard({ decision: { ...decision(), response: "rejected" } });
    expect(() => {
      projectBoardAnswer(board, { id: "decision-1", answer: "42", outcome: "answer" });
    }).toThrow("Invalid board human control");
  });

  it("throws when id does not match decision", () => {
    const board = baseBoard({ decision: decision() });
    expect(() => {
      projectBoardAnswer(board, { id: "other-id", answer: "42", outcome: "answer" });
    }).toThrow("Invalid board human control");
  });

  it("throws when answer is not safe bounded text", () => {
    const board = baseBoard({ decision: decision() });
    expect(() => {
      projectBoardAnswer(board, { id: "decision-1", answer: "x".repeat(1001), outcome: "answer" });
    }).toThrow("Invalid board human control");
  });
});

describe("restoreBoardHuman edge cases", () => {
  type Entry = {
    type: "custom";
    id: string;
    parentId: string | null;
    customType: string;
    data: unknown;
    digest?: string;
  };

  function fixture() {
    const dir = makeDir();
    const path = join(dir, "session.jsonl");
    const entries: Entry[] = [];
    let leaf: string | null = null;
    let count = 0;
    const mock = createMockAPI();
    const ctx = createMockContext();
    Object.assign(ctx.sessionManager, {
      getSessionFile: () => path,
      getLeafId: () => leaf,
      getBranch: () => entries,
    });
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
    mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
      const entry: Entry = {
        type: "custom",
        id: `e${++count}`,
        parentId: leaf,
        customType,
        data: structuredClone(data),
        digest: randomUUID(),
      };
      entries.push(entry);
      leaf = entry.id;
      appendFileSync(path, JSON.stringify(entry) + "\n");
    });
    return { ...mock, ctx, path, entries };
  }

  it("returns board unchanged when no controls exist", () => {
    const h = fixture();
    const board = baseBoard();
    const result = restoreBoardHuman(h.ctx, board);
    expect(result).toBe(board);
  });

  it("throws when frame owner is not board", () => {
    const h = fixture();
    const board = baseBoard({ decision: decision() });
    h.api.appendEntry("continuous-tasks:snapshot", board);
    h.api.appendEntry("continuous-tasks:event", {
      humanInteraction: { owner: "preflight", requestId: "req-1" },
    });
    expect(() => {
      restoreBoardHuman(h.ctx, board);
    }).toThrow("Invalid board control frame");
  });

  it("throws when frame requestId is not string", () => {
    const h = fixture();
    const board = baseBoard({ decision: decision() });
    h.api.appendEntry("continuous-tasks:snapshot", board);
    h.api.appendEntry("continuous-tasks:event", {
      humanInteraction: { owner: "board", requestId: 123 },
    });
    expect(() => {
      restoreBoardHuman(h.ctx, board);
    }).toThrow("Invalid board control frame");
  });
});

describe("repairBoardProjection edge cases", () => {
  type Entry = {
    type: "custom";
    id: string;
    parentId: string | null;
    customType: string;
    data: unknown;
    digest?: string;
  };

  function fixture() {
    const dir = makeDir();
    const path = join(dir, "session.jsonl");
    const entries: Entry[] = [];
    let leaf: string | null = null;
    let count = 0;
    const mock = createMockAPI();
    const ctx = createMockContext();
    Object.assign(ctx.sessionManager, {
      getSessionFile: () => path,
      getLeafId: () => leaf,
      getBranch: () => entries,
    });
    writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "test-session" }) + "\n");
    mock.appendEntry.mockImplementation((customType: string, data: unknown) => {
      const entry: Entry = {
        type: "custom",
        id: `e${++count}`,
        parentId: leaf,
        customType,
        data: structuredClone(data),
        digest: randomUUID(),
      };
      entries.push(entry);
      leaf = entry.id;
      appendFileSync(path, JSON.stringify(entry) + "\n");
    });
    return { ...mock, ctx, path, entries };
  }

  it("throws when not idle", () => {
    const h = fixture();
    vi.mocked(h.ctx.isIdle).mockReturnValue(false);
    expect(() => {
      repairBoardProjection(h.api, h.ctx);
    }).toThrow("Wait for Main and pending messages before repair");
  });

  it("throws when has pending messages", () => {
    const h = fixture();
    vi.mocked(h.ctx.hasPendingMessages).mockReturnValue(true);
    expect(() => {
      repairBoardProjection(h.api, h.ctx);
    }).toThrow("Wait for Main and pending messages before repair");
  });

  it("throws when no pending repair", () => {
    const h = fixture();
    expect(() => {
      repairBoardProjection(h.api, h.ctx);
    }).toThrow("No pending board projection repair");
  });

  it("throws when repair session does not match", () => {
    const h = fixture();
    currentRuntime().boardRepair = {
      sessionId: "other-session",
      controlEntryId: "e1",
      projectedDigest: "digest",
      faultMessage: "fault",
      ownsJournalFault: true,
    };
    expect(() => {
      repairBoardProjection(h.api, h.ctx);
    }).toThrow("No pending board projection repair");
  });
});
