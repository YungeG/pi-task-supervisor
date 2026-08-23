import { describe, expect, it } from "vitest";
import type { CompletionEvidence, TaskBoardSnapshot } from "../types";
import { completionEvidenceError, isValidSnapshotV2 } from "../validation";

const NOW = "2026-08-23T00:00:00.000Z";

function evidence(overrides: Partial<CompletionEvidence> = {}): CompletionEvidence {
  return {
    summary: "Validated",
    refs: [
      {
        kind: "review",
        label: "review",
        status: "passed",
        ref: "test://review",
      },
    ],
    ...overrides,
  };
}

function snapshot(overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
  return {
    version: 2,
    generation: 1,
    workflowStatus: "active",
    finalAcceptanceTaskId: "t-1.1",
    stagnantSettles: 0,
    tasks: [
      {
        id: "t-1.1",
        title: "Final acceptance",
        prompt: "Verify",
        profile: "reviewer",
        phase: 1,
        dependencies: [],
        status: "reviewing",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    phases: [{ phase: 1, status: "active" }],
    ...overrides,
  };
}

describe("completion evidence validation branches", () => {
  it.each([
    [evidence({ refs: [{ kind: "unknown" as never, label: "x", status: "passed" }] }), /kind/],
    [evidence({ refs: [{ kind: "review", label: "x", status: "unknown" as never }] }), /status/],
    [evidence({ refs: [{ kind: "review", label: "x", status: "passed", digest: "" }] }), /digest/],
    [
      evidence({ refs: [{ kind: "review", label: "x", status: "passed", exitCode: 1.5 }] }),
      /integer/,
    ],
    [evidence({ refs: [{ kind: "review", label: "x", status: "fixed" }] }), /reference/],
    [evidence({ refs: [] }), /1-20/],
    [
      evidence({
        refs: Array.from({ length: 21 }, () => ({ kind: "review", label: "x", status: "passed" })),
      }),
      /1-20/,
    ],
    [evidence({ refs: [{ kind: "review", label: "x", status: "deferred" }] }), /passed/],
    [evidence({ residualRisks: Array.from({ length: 21 }, () => "risk") }), /Residual/],
    [evidence({ residualRisks: ["token=secret-value-123456"] }), /Residual/],
  ])("rejects malformed evidence %#", (value, expected) => {
    expect(completionEvidenceError(value)).toMatch(expected);
  });
});

describe("snapshot v2 validation branches", () => {
  it.each([
    { generation: -1 },
    { generation: 1.5 },
    { workflowStatus: "unknown" },
    { stagnantSettles: -1 },
    { stagnantSettles: 1.5 },
    { finalAcceptanceTaskId: 7 },
  ])("rejects invalid metadata: %j", (overrides) => {
    expect(isValidSnapshotV2({ ...snapshot(), ...overrides })).toBe(false);
  });

  it.each([
    { executionRef: null },
    { executionRef: { source: "unknown", runId: "run-1" } },
    { executionRef: { source: "workflow", runId: "token=secret-value-123456" } },
  ])("rejects invalid execution receipt: %j", (taskOverrides) => {
    expect(
      isValidSnapshotV2({
        ...snapshot(),
        tasks: snapshot().tasks.map((task) => ({ ...task, ...taskOverrides })),
      }),
    ).toBe(false);
  });

  it("rejects a missing, non-final, or abandoned final acceptance task", () => {
    expect(isValidSnapshotV2({ ...snapshot(), finalAcceptanceTaskId: "missing" })).toBe(false);
    expect(
      isValidSnapshotV2({
        ...snapshot(),
        finalAcceptanceTaskId: "t-1.1",
        tasks: [
          snapshot().tasks[0]!,
          { ...snapshot().tasks[0]!, id: "t-2.1", phase: 2, status: "configured" },
        ],
      }),
    ).toBe(false);
    expect(
      isValidSnapshotV2({
        ...snapshot(),
        tasks: snapshot().tasks.map((task) => ({ ...task, status: "abandoned" })),
      }),
    ).toBe(false);
  });

  it("requires completed workflow tasks and final acceptance evidence", () => {
    expect(isValidSnapshotV2({ ...snapshot(), workflowStatus: "completed" })).toBe(false);
    expect(
      isValidSnapshotV2({
        ...snapshot(),
        workflowStatus: "completed",
        tasks: snapshot().tasks.map((task) => ({ ...task, status: "done" })),
        phases: [{ phase: 1, status: "completed" }],
      }),
    ).toBe(false);
    expect(
      isValidSnapshotV2({
        ...snapshot(),
        workflowStatus: "completed",
        tasks: snapshot().tasks.map((task) => ({
          ...task,
          status: "done",
          completionEvidence: evidence(),
        })),
        phases: [{ phase: 1, status: "completed" }],
      }),
    ).toBe(true);
  });

  it("validates the complete decision record and options", () => {
    const waiting = {
      ...snapshot(),
      workflowStatus: "waiting_for_decision" as const,
      decision: {
        id: "decision-2",
        taskId: "t-1.1",
        question: "Choose",
        whyUserOwned: "Product decision",
        createdAt: NOW,
      },
    };
    expect(isValidSnapshotV2(waiting)).toBe(true);
    expect(
      isValidSnapshotV2({ ...waiting, decision: { ...waiting.decision, taskId: "missing" } }),
    ).toBe(false);
    expect(
      isValidSnapshotV2({
        ...waiting,
        decision: { ...waiting.decision, options: Array(11).fill("x") },
      }),
    ).toBe(false);
    expect(
      isValidSnapshotV2({
        ...waiting,
        decision: { ...waiting.decision, options: ["token=secret-value-123456"] },
      }),
    ).toBe(false);
    expect(isValidSnapshotV2({ ...snapshot(), decision: waiting.decision })).toBe(false);
  });
});
