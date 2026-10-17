import { describe, expect, it } from "vitest";
import type { TaskBoardSnapshot, TaskRecord, TaskStatus } from "../types";
import type { SupervisorState } from "../supervisor";
import type { PreflightState } from "../preflight";
import type { FlowFacts } from "../flow";
import { createEmptyBoard } from "../engine";
import { buildUiSummary, type UiSummaryInput, type UiScope } from "../ui-view";

// ── Test Helpers ──

function task(id: string, status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    title: `Task ${id}`,
    prompt: "Approved local work",
    profile: "worker",
    phase: 1,
    dependencies: [],
    status,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

function board(tasks: TaskRecord[], overrides: Partial<TaskBoardSnapshot> = {}): TaskBoardSnapshot {
  return {
    ...createEmptyBoard(),
    generation: 5,
    workflowStatus: "active",
    tasks,
    phases: [
      { phase: 1, status: "active", title: "Implement" },
      { phase: 2, status: "pending", title: "Accept" },
    ],
    ...overrides,
  };
}

function scope(overrides: Partial<UiScope> = {}): UiScope {
  return {
    sessionId: "session-1",
    leafId: "leaf-1",
    generation: 5,
    capturedAt: 1700000000000,
    ...overrides,
  };
}

function facts(overrides: Partial<FlowFacts> = {}): FlowFacts {
  return {
    enabled: true,
    sessionId: "session-1",
    idle: true,
    pending: false,
    ...overrides,
  };
}

function limits(): { reviews: number; continuations: number; stagnant: number } {
  return { reviews: 40, continuations: 20, stagnant: 3 };
}

function input(overrides: Partial<UiSummaryInput> = {}): UiSummaryInput {
  return {
    scope: scope(),
    board: board([]),
    facts: facts(),
    limits: limits(),
    ...overrides,
  };
}

function supervisorState(overrides: Partial<SupervisorState> = {}): SupervisorState {
  return {
    version: 1,
    sessionId: "session-1",
    goal: "Test goal",
    model: { provider: "test", id: "test-model" },
    status: "active",
    reviews: 0,
    continuations: 0,
    stagnant: 0,
    epoch: 0,
    pending: false,
    receipts: [],
    bindings: [],
    tokens: 0,
    cost: 0,
    ...overrides,
  };
}

function preflightState(overrides: Partial<PreflightState> = {}): PreflightState {
  return {
    version: 1,
    sessionId: "session-1",
    preflightId: "pf-1",
    goal: "Preflight goal",
    phase: "planning",
    revision: 0,
    ...overrides,
  };
}

// ── Smoke Tests (RED/GREEN) ──

describe("S1 smoke tests", () => {
  it("receiptIssue + active → next must be exact receiptIssue text", () => {
    const result = buildUiSummary(
      input({
        facts: facts({
          receiptIssue: "Unknown host capture requires explicit recover",
        }),
        board: board([task("t1", "implementing")]),
      }),
    );
    expect(result.next.text).toBe("下一步未一致确认，请查看状态");
    expect(result.next.source).toBe("receipt");
    expect(result.next.level).toBe("error");
    expect(result.headline.text).toBe("需检查");
  });

  it("done=2/abandoned=1/total=4 → correct counts", () => {
    const result = buildUiSummary(
      input({
        board: board([
          task("t1", "done"),
          task("t2", "done"),
          task("t3", "abandoned"),
          task("t4", "implementing"),
        ]),
      }),
    );
    expect(result.counts).toEqual({ total: 4, done: 2, abandoned: 1, unfinished: 1 });
  });
});

// ── Counts ──

describe("counts", () => {
  it("empty board → all zeros", () => {
    const result = buildUiSummary(input());
    expect(result.counts).toEqual({ total: 0, done: 0, abandoned: 0, unfinished: 0 });
  });

  it("all done → unfinished=0", () => {
    const result = buildUiSummary(
      input({ board: board([task("t1", "done"), task("t2", "done")]) }),
    );
    expect(result.counts).toEqual({ total: 2, done: 2, abandoned: 0, unfinished: 0 });
  });

  it("all abandoned → unfinished=0", () => {
    const result = buildUiSummary(
      input({ board: board([task("t1", "abandoned"), task("t2", "abandoned")]) }),
    );
    expect(result.counts).toEqual({ total: 2, done: 0, abandoned: 2, unfinished: 0 });
  });
});

// ── Goals ──

describe("goals", () => {
  it("supervisor goal shown when same session", () => {
    const result = buildUiSummary(
      input({ supervisor: supervisorState({ goal: "Supervisor goal" }) }),
    );
    expect(result.goals).toEqual([{ source: "supervisor", text: "Supervisor goal" }]);
  });

  it("supervisor goal NOT shown when foreign session", () => {
    const result = buildUiSummary(
      input({ supervisor: supervisorState({ sessionId: "other-session", goal: "Foreign goal" }) }),
    );
    expect(result.goals).toEqual([]);
  });

  it("preflight goal shown when same session", () => {
    const result = buildUiSummary(input({ preflight: preflightState({ goal: "Preflight goal" }) }));
    expect(result.goals).toEqual([{ source: "preflight", text: "Preflight goal" }]);
  });

  it("both goals shown when different", () => {
    const result = buildUiSummary(
      input({
        supervisor: supervisorState({ goal: "Supervisor goal" }),
        preflight: preflightState({ goal: "Preflight goal" }),
      }),
    );
    expect(result.goals).toEqual([
      { source: "supervisor", text: "Supervisor goal" },
      { source: "preflight", text: "Preflight goal" },
    ]);
  });
});

// ── Phase ──

describe("phase", () => {
  it("active phase with title", () => {
    const result = buildUiSummary(input());
    expect(result.phase).toBe("Implement");
  });

  it("active phase without title → number", () => {
    const result = buildUiSummary(
      input({
        board: board([], {
          phases: [{ phase: 3, status: "active" }],
        }),
      }),
    );
    expect(result.phase).toBe("3");
  });

  it("no active phase → undefined", () => {
    const result = buildUiSummary(
      input({
        board: board([], {
          phases: [{ phase: 1, status: "completed" }],
        }),
      }),
    );
    expect(result.phase).toBeUndefined();
  });
});

// ── Task Summaries ──

describe("task summaries", () => {
  it("preserves task order and copies only summary fields", () => {
    const result = buildUiSummary(
      input({
        board: board([
          task("t1", "done", { title: "First task" }),
          task("t2", "implementing", { title: "Second task" }),
        ]),
      }),
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]!).toEqual({
      id: "t1",
      title: "First task",
      phase: 1,
      status: "done",
      notes: [],
    });
    expect(result.tasks[1]!).toEqual({
      id: "t2",
      title: "Second task",
      phase: 1,
      status: "implementing",
      notes: [],
    });
  });

  it("notes: unmet dependencies", () => {
    const result = buildUiSummary(
      input({
        board: board([
          task("t1", "configured", { dependencies: ["t2"] }),
          task("t2", "implementing"),
        ]),
      }),
    );
    expect(result.tasks[0]!.notes).toContain("依赖 t2 未完成");
  });

  it("notes: dependency on done task → no note", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "configured", { dependencies: ["t2"] }), task("t2", "done")]),
      }),
    );
    expect(result.tasks[0]!.notes).not.toContain("依赖 t2 未完成");
  });

  it("notes: dependency on abandoned task → still unmet", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "configured", { dependencies: ["t2"] }), task("t2", "abandoned")]),
      }),
    );
    expect(result.tasks[0]!.notes).toContain("依赖 t2 未完成");
  });

  it("notes: draft → 未编译", () => {
    const result = buildUiSummary(input({ board: board([task("t1", "draft")]) }));
    expect(result.tasks[0]!.notes).toContain("未编译");
  });

  it("notes: configured with pending phase → 所在阶段待处理", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "configured", { phase: 2 })]),
      }),
    );
    expect(result.tasks[0]!.notes).toContain("所在阶段待处理");
  });

  it("notes: executionRef → 执行状态未知", () => {
    const result = buildUiSummary(
      input({
        board: board([
          task("t1", "implementing", {
            executionRef: { source: "pi-subagents", runId: "run-1" },
          }),
        ]),
      }),
    );
    expect(result.tasks[0]!.notes).toContain("执行状态未知");
  });
});

// ── Visibility ──

describe("visibility", () => {
  it("empty board, inactive, no facts → false", () => {
    const result = buildUiSummary(
      input({ board: board([], { workflowStatus: "inactive", phases: [] }) }),
    );
    expect(result.visible).toBe(false);
  });

  it("has tasks → true", () => {
    const result = buildUiSummary(input({ board: board([task("t1", "done")]) }));
    expect(result.visible).toBe(true);
  });

  it("active workflow → true", () => {
    const result = buildUiSummary(input({ board: board([], { workflowStatus: "active" }) }));
    expect(result.visible).toBe(true);
  });

  it("same session supervisor → true", () => {
    const result = buildUiSummary(input({ supervisor: supervisorState() }));
    expect(result.visible).toBe(true);
  });

  it("decision present → true", () => {
    const result = buildUiSummary(
      input({
        board: board([], {
          decision: {
            id: "d1",
            taskId: "t1",
            question: "Approve?",
            whyUserOwned: "User owned",
            createdAt: "2026-08-23T00:00:00.000Z",
          },
        }),
      }),
    );
    expect(result.visible).toBe(true);
  });

  it("repair flags → true", () => {
    const result = buildUiSummary(input({ repairs: { board: true, preflight: false } }));
    expect(result.visible).toBe(true);
  });

  it("journal fault → true", () => {
    const result = buildUiSummary(input({ facts: facts({ journalFault: "Journal corrupt" }) }));
    expect(result.visible).toBe(true);
  });
});

// ── Blockers ──

describe("blockers", () => {
  it("collects all blocker sources", () => {
    const result = buildUiSummary(
      input({
        facts: facts({
          journalFault: "Journal corrupt",
          receiptIssue: "Receipt pending",
          preflightIssue: "Preflight blocked",
        }),
        repairs: { board: true, preflight: true },
        board: board([task("t1", "done")], {
          decision: {
            id: "d1",
            taskId: "t1",
            question: "Approve?",
            whyUserOwned: "User owned",
            createdAt: "2026-08-23T00:00:00.000Z",
          },
          pauseReason: "User paused",
        }),
        supervisor: supervisorState({
          reason: "Review failed",
          holdCause: "user_pause",
          reviews: 40,
        }),
      }),
    );
    const sources = result.blockers.map((b) => b.source);
    expect(sources).toContain("journal");
    expect(sources).toContain("receipt");
    expect(sources).toContain("preflight");
    expect(sources).toContain("repair");
    expect(sources).toContain("board");
    expect(sources).toContain("supervisor");
  });

  it("multiple blockers not cleared by each other", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ journalFault: "Fault", receiptIssue: "Receipt" }),
      }),
    );
    expect(result.blockers.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Headline/Next Priority ──

describe("headline/next priority", () => {
  it("level 1: identity issue → 身份需检查", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ sessionId: "other-session" }),
      }),
    );
    expect(result.headline.text).toBe("身份需检查");
    expect(result.next.text).toBe("下一步未一致确认，请查看状态");
  });

  it("level 1: journalFault → 需检查", () => {
    const result = buildUiSummary(input({ facts: facts({ journalFault: "Journal corrupt" }) }));
    expect(result.headline.text).toBe("需检查");
    expect(result.next.text).toBe("下一步未一致确认，请查看状态");
  });

  it("level 1: receiptIssue → exact next text", () => {
    const result = buildUiSummary(input({ facts: facts({ receiptIssue: "Receipt pending" }) }));
    expect(result.next.text).toBe("下一步未一致确认，请查看状态");
  });

  it("level 1: expired external wait", () => {
    const result = buildUiSummary(
      input({
        supervisor: supervisorState({
          externalWait: {
            boardDigest: "a".repeat(64),
            epoch: 0,
            deadlineAt: 1699999999000,
            observedAt: 1699999998000,
            phase: "active",
            refs: [{ taskId: "t1", source: "pi-subagents", runId: "run-1" }],
          },
        }),
      }),
    );
    expect(result.headline.text).toBe("需检查");
  });

  it("level 2: repair flags", () => {
    const result = buildUiSummary(input({ repairs: { board: true, preflight: false } }));
    expect(result.headline.text).toBe("确认或回应已保存，状态同步未完成");
    expect(result.next.text).toBe("查看状态，勿重复确认/启动");
  });

  it("level 3: preflight revoked", () => {
    const result = buildUiSummary(input({ preflight: preflightState({ phase: "revoked" }) }));
    expect(result.headline.text).toBe("权限已撤销或范围未获允许");
  });

  it("level 3: decision rejected", () => {
    const result = buildUiSummary(
      input({
        board: board([], {
          decision: {
            id: "d1",
            taskId: "t1",
            question: "Approve?",
            whyUserOwned: "User owned",
            createdAt: "2026-08-23T00:00:00.000Z",
            response: "rejected",
          },
        }),
      }),
    );
    expect(result.headline.text).toBe("权限已撤销或范围未获允许");
  });

  it("level 4: decision with spec → 等待原生回应", () => {
    const result = buildUiSummary(
      input({
        board: board([], {
          decision: {
            id: "d1",
            taskId: "t1",
            question: "Approve?",
            whyUserOwned: "User owned",
            createdAt: "2026-08-23T00:00:00.000Z",
            spec: { version: 1, kind: "authorization", scope: "test", prohibitions: [] },
          },
        }),
      }),
    );
    expect(result.headline.text).toBe("等待原生回应");
  });

  it("level 4: decision without spec → 旧请求待 Main 完整替换", () => {
    const result = buildUiSummary(
      input({
        board: board([], {
          decision: {
            id: "d1",
            taskId: "t1",
            question: "Approve?",
            whyUserOwned: "User owned",
            createdAt: "2026-08-23T00:00:00.000Z",
          },
        }),
      }),
    );
    expect(result.headline.text).toBe("旧请求待 Main 完整替换");
  });

  it("level 5: host busy", () => {
    const result = buildUiSummary(input({ facts: facts({ idle: false }) }));
    expect(result.headline.text).toBe("宿主工作中");
    expect(result.next.text).toBe("等待宿主当前工作和待处理消息");
  });

  it("level 5: pending messages", () => {
    const result = buildUiSummary(input({ facts: facts({ pending: true }) }));
    expect(result.headline.text).toBe("宿主工作中");
  });

  it("level 6: board paused with ownerNext", () => {
    const result = buildUiSummary(
      input({
        board: board([], { workflowStatus: "paused", pauseReason: "User paused" }),
        ownerNext: "Custom next step",
      }),
    );
    expect(result.next.text).toBe("Custom next step");
  });

  it("level 6: supervisor paused", () => {
    const result = buildUiSummary(input({ supervisor: supervisorState({ status: "paused" }) }));
    expect(result.headline.text).toContain("Supervisor: paused");
  });

  it("level 6: budget exhausted", () => {
    const result = buildUiSummary(input({ supervisor: supervisorState({ reviews: 40 }) }));
    expect(result.headline.text).toContain("预算已达上限");
  });

  it("level 7: preflight not started with display", () => {
    const result = buildUiSummary(
      input({
        preflight: preflightState({ phase: "planning" }),
        preflightDisplay: { label: "规划中", next: "等待规划完成" },
      }),
    );
    expect(result.headline.text).toBe("规划中");
    expect(result.next.text).toBe("等待规划完成");
  });

  it("level 7: preflight not started without display → fallback", () => {
    const result = buildUiSummary(input({ preflight: preflightState({ phase: "planning" }) }));
    expect(result.headline.text).toBe("执行前流程待处理");
    expect(result.next.text).toBe("查看状态");
  });

  it("level 8: external wait active", () => {
    const result = buildUiSummary(
      input({
        supervisor: supervisorState({
          externalWait: {
            boardDigest: "a".repeat(64),
            epoch: 0,
            deadlineAt: 1700000001000,
            observedAt: 1699999998000,
            phase: "active",
            refs: [{ taskId: "t1", source: "pi-subagents", runId: "run-1" }],
          },
        }),
      }),
    );
    expect(result.headline.text).toBe("等待外部结果（最近owner报告）");
  });

  it("level 8: external wait results_pending", () => {
    const result = buildUiSummary(
      input({
        supervisor: supervisorState({
          externalWait: {
            boardDigest: "a".repeat(64),
            epoch: 0,
            deadlineAt: 1700000001000,
            observedAt: 1699999998000,
            phase: "results_pending",
            refs: [{ taskId: "t1", source: "pi-subagents", runId: "run-1" }],
          },
        }),
      }),
    );
    expect(result.headline.text).toBe("结果待 Main 核验（最近owner报告）");
  });

  it("level 8: executionRef without externalWait", () => {
    const result = buildUiSummary(
      input({
        board: board([
          task("t1", "implementing", {
            executionRef: { source: "pi-subagents", runId: "run-1" },
          }),
        ]),
      }),
    );
    expect(result.headline.text).toBe("执行状态未知");
  });

  it("level 9: supervisor reviewing", () => {
    const result = buildUiSummary(input({ supervisor: supervisorState({ status: "reviewing" }) }));
    expect(result.headline.text).toBe("监督检查中");
  });

  it("level 9: supervisor active", () => {
    const result = buildUiSummary(input({ supervisor: supervisorState({ status: "active" }) }));
    expect(result.headline.text).toBe("监督已启用");
  });

  it("level 9: supervisor completed", () => {
    const result = buildUiSummary(input({ supervisor: supervisorState({ status: "completed" }) }));
    expect(result.headline.text).toBe("监督记录已标记目标完成");
  });

  it("level 9: preflight started", () => {
    const result = buildUiSummary(
      input({
        preflight: preflightState({
          phase: "started",
          started: { goal: "Test", startedAt: "2026-08-23T00:00:00.000Z" },
        }),
      }),
    );
    expect(result.headline.text).toBe("启动记录已保存");
  });

  it("level 10: fallback → 暂无任务", () => {
    const result = buildUiSummary(input());
    expect(result.headline.text).toBe("暂无任务");
    expect(result.next.text).toBe("尚无已确认的下一步，请查看状态");
  });

  it("level 10: fallback → 任务记录已结束", () => {
    const result = buildUiSummary(
      input({ board: board([task("t1", "done")], { workflowStatus: "completed" }) }),
    );
    expect(result.headline.text).toBe("任务记录已结束");
  });

  it("level 10: fallback → active board shows 任务流程已启用（任务记录）", () => {
    const result = buildUiSummary(
      input({ board: board([task("t1", "ready")], { workflowStatus: "active" }) }),
    );
    expect(result.headline.text).toBe("任务流程已启用（任务记录）");
    expect(result.headline.source).toBe("board");
    expect(result.headline.level).toBe("info");
    expect(result.next.text).toBe("尚无已确认的下一步，请查看状态");
  });

  it("level 10: fallback → active board consumes known ownerNext", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "implementing")], { workflowStatus: "active" }),
        ownerNext: "Continue approved implementation",
      }),
    );
    expect(result.headline.text).toBe("任务流程已启用（任务记录）");
    expect(result.next.text).toBe("Continue approved implementation");
  });

  it("keeps a blank board-only next step explicitly unknown", () => {
    for (const ownerNext of ["", " \t\n"]) {
      const result = buildUiSummary(input({ board: board([task("t1", "ready")]), ownerNext }));
      expect(result.next.text).toBe("尚无已确认的下一步，请查看状态");
    }
  });

  it("level 10: fallback → inactive board keeps 只读规划", () => {
    const result = buildUiSummary(
      input({ board: board([task("t1", "draft")], { workflowStatus: "inactive" }) }),
    );
    expect(result.headline.text).toBe("只读规划");
    expect(result.headline.source).toBe("board");
  });
});

// ── Expected Preflight Gate Exception ──

describe("expected preflight gate exception", () => {
  it("applies: planning, not started, no binding, no faults", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Preflight not authorized" }),
        preflight: preflightState({ phase: "planning" }),
      }),
    );
    // Should NOT be level 1 (需检查)
    expect(result.headline.text).not.toBe("需检查");
    // Should be level 7 (执行前流程待处理)
    expect(result.headline.text).toBe("执行前流程待处理");
    // But preflightIssue should still be in blockers
    expect(result.blockers.some((b) => b.source === "preflight")).toBe(true);
  });

  it("applies: awaiting_authorization phase", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Awaiting authorization" }),
        preflight: preflightState({ phase: "awaiting_authorization" }),
      }),
    );
    expect(result.headline.text).toBe("执行前流程待处理");
  });

  it("applies: approved phase", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Approved but not started" }),
        preflight: preflightState({ phase: "approved" }),
      }),
    );
    expect(result.headline.text).toBe("执行前流程待处理");
  });

  it("does NOT apply: with effective binding", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Preflight issue" }),
        preflight: preflightState({ phase: "planning" }),
        supervisor: supervisorState({
          preflightBinding: {
            preflightId: "pf-1",
            planId: "plan-1",
            planDigest: "a".repeat(64),
          },
        }),
      }),
    );
    // Should be level 1 (需检查)
    expect(result.headline.text).toBe("需检查");
  });

  it("does NOT apply: already started", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Preflight issue" }),
        preflight: preflightState({
          phase: "planning",
          started: { goal: "Test", startedAt: "2026-08-23T00:00:00.000Z" },
        }),
      }),
    );
    // Should be level 1 (需检查)
    expect(result.headline.text).toBe("需检查");
  });

  it("does NOT apply: interrupted phase", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Preflight issue" }),
        preflight: preflightState({ phase: "interrupted" }),
      }),
    );
    // Should be level 1 (需检查)
    expect(result.headline.text).toBe("需检查");
  });

  it("does NOT apply: with journal fault", () => {
    const result = buildUiSummary(
      input({
        facts: facts({
          preflightIssue: "Preflight issue",
          journalFault: "Journal corrupt",
        }),
        preflight: preflightState({ phase: "planning" }),
      }),
    );
    // Should be level 1 (需检查)
    expect(result.headline.text).toBe("需检查");
  });

  it("does NOT apply: with receipt issue", () => {
    const result = buildUiSummary(
      input({
        facts: facts({
          preflightIssue: "Preflight issue",
          receiptIssue: "Receipt pending",
        }),
        preflight: preflightState({ phase: "planning" }),
      }),
    );
    // Should be level 1 (需检查)
    expect(result.headline.text).toBe("需检查");
  });

  it("does NOT apply: with identity issue", () => {
    const result = buildUiSummary(
      input({
        facts: facts({
          preflightIssue: "Preflight issue",
          sessionId: "other-session",
        }),
        preflight: preflightState({ phase: "planning" }),
      }),
    );
    // Should be level 1 (身份需检查)
    expect(result.headline.text).toBe("身份需检查");
  });

  it("does NOT count stopped binding as effective → gate exception applies, but supervisor stopped hits level 6 first", () => {
    const result = buildUiSummary(
      input({
        facts: facts({ preflightIssue: "Preflight issue" }),
        preflight: preflightState({ phase: "planning" }),
        supervisor: supervisorState({
          status: "stopped",
          preflightBinding: {
            preflightId: "pf-1",
            planId: "plan-1",
            planDigest: "a".repeat(64),
          },
        }),
      }),
    );
    // Stopped binding doesn't count as effective, so gate exception applies.
    // But supervisor stopped triggers level 6 before level 7.
    expect(result.headline.text).toContain("Supervisor: stopped");
    // Preflight blocker should still be present
    expect(result.blockers.some((b) => b.source === "preflight")).toBe(true);
  });
});

// ── Foreign/Session Mismatch ──

describe("foreign/session mismatch", () => {
  it("foreign supervisor → identity issue, no goal shown", () => {
    const result = buildUiSummary(
      input({
        supervisor: supervisorState({ sessionId: "other-session", goal: "Foreign goal" }),
      }),
    );
    expect(result.headline.text).toBe("身份需检查");
    expect(result.goals).toEqual([]);
  });

  it("facts sessionId mismatch → identity issue", () => {
    const result = buildUiSummary(input({ facts: facts({ sessionId: "other-session" }) }));
    expect(result.headline.text).toBe("身份需检查");
  });
});

// ── Acceptance ──

describe("acceptance", () => {
  it("no finalAcceptanceTaskId → 尚未记录目标验收", () => {
    const result = buildUiSummary(input());
    expect(result.acceptance).toBe("尚未记录目标验收");
  });

  it("finalAcceptanceTaskId not found → 尚未记录目标验收", () => {
    const result = buildUiSummary(
      input({ board: board([], { finalAcceptanceTaskId: "missing" }) }),
    );
    expect(result.acceptance).toBe("尚未记录目标验收");
  });

  it("finalAcceptanceTaskId found → show task status", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "done")], { finalAcceptanceTaskId: "t1" }),
      }),
    );
    expect(result.acceptance).toContain("验收任务 t1: done");
  });

  it("finalAcceptanceTaskId + supervisor completed → owner record", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "done")], { finalAcceptanceTaskId: "t1" }),
        supervisor: supervisorState({ status: "completed" }),
      }),
    );
    expect(result.acceptance).toContain("owner 记录已标记目标完成");
  });

  it("all tasks done but no finalAcceptanceTaskId → NOT 目标通过", () => {
    const result = buildUiSummary(
      input({ board: board([task("t1", "done"), task("t2", "done")]) }),
    );
    expect(result.acceptance).toBe("尚未记录目标验收");
  });
});

// ── Control Characters ──

describe("control characters", () => {
  it("strips ANSI sequences", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "done", { title: "\x1b[31mRed task\x1b[0m" })]),
      }),
    );
    expect(result.tasks[0]!.title).toBe("Red task");
  });

  it("strips C0 control characters", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "done", { title: "Task\x00with\x01controls" })]),
      }),
    );
    expect(result.tasks[0]!.title).toBe("Task with controls");
  });

  it("normalizes whitespace", () => {
    const result = buildUiSummary(
      input({
        board: board([task("t1", "done", { title: "Task   with   spaces" })]),
      }),
    );
    expect(result.tasks[0]!.title).toBe("Task with spaces");
  });
});

// ── Deep Freeze ──

describe("deep freeze", () => {
  it("result is frozen", () => {
    const result = buildUiSummary(input());
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("nested objects are frozen", () => {
    const result = buildUiSummary(input({ board: board([task("t1", "done")]) }));
    expect(Object.isFrozen(result.counts)).toBe(true);
    expect(Object.isFrozen(result.tasks)).toBe(true);
    expect(Object.isFrozen(result.tasks[0]!)).toBe(true);
    expect(Object.isFrozen(result.blockers)).toBe(true);
    expect(Object.isFrozen(result.goals)).toBe(true);
  });

  it("cannot mutate frozen result", () => {
    const result = buildUiSummary(input());
    expect(() => {
      (result as any).visible = true;
    }).toThrow();
  });
});

// ── Input Mutation ──

describe("input mutation", () => {
  it("mutating input after buildUiSummary does not affect result", () => {
    const tasks = [task("t1", "done")];
    const inputObj = input({ board: board(tasks) });
    const result = buildUiSummary(inputObj);
    const beforeCounts = { ...result.counts };
    const beforeTitle = result.tasks[0]!.title;

    // Mutate input
    tasks.push(task("t2", "done"));
    tasks[0]!.title = "Mutated title";

    // Result should be unchanged
    expect(result.counts).toEqual(beforeCounts);
    expect(result.tasks[0]!.title).toBe(beforeTitle);
  });

  it("does not freeze input", () => {
    const tasks = [task("t1", "done")];
    const inputObj = input({ board: board(tasks) });
    buildUiSummary(inputObj);
    expect(Object.isFrozen(inputObj)).toBe(false);
    expect(Object.isFrozen(inputObj.board)).toBe(false);
  });
});

// ── Scope ──

describe("scope", () => {
  it("copies scope to output", () => {
    const s = scope({ sessionId: "test-session" });
    const result = buildUiSummary(input({ scope: s }));
    expect(result.scope).toEqual(s);
    expect(result.scope).not.toBe(s);
  });

  it("uses capturedAt, not Date.now", () => {
    const s = scope({ capturedAt: 1234567890000 });
    const result = buildUiSummary(input({ scope: s }));
    expect(result.scope.capturedAt).toBe(1234567890000);
  });
});

// Independent controlling-agent acceptance regressions; preserve the original 80 cases.
describe("parent acceptance regressions", () => {
  it("does not disclose a foreign supervisor reason or budget through blockers", () => {
    const result = buildUiSummary(
      input({
        supervisor: supervisorState({
          sessionId: "foreign-session",
          goal: "FOREIGN_GOAL_MARKER",
          reason: "FOREIGN_REASON_MARKER",
          reviews: 99,
          continuations: 77,
        }),
      }),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("FOREIGN_GOAL_MARKER");
    expect(serialized).not.toContain("FOREIGN_REASON_MARKER");
    expect(serialized).not.toContain("99/40");
    expect(serialized).not.toContain("77/20");
    expect(result.headline.text).toBe("身份需检查");
  });

  it("a foreign preflight yields only a visible identity issue", () => {
    const result = buildUiSummary(
      input({
        board: board([], { workflowStatus: "inactive", phases: [] }),
        preflight: preflightState({ sessionId: "foreign-session", goal: "FOREIGN_PF_MARKER" }),
      }),
    );
    expect(result.headline.text).toBe("身份需检查");
    expect(result.visible).toBe(true);
    expect(JSON.stringify(result)).not.toContain("FOREIGN_PF_MARKER");
  });

  it("does not hide a facts/session identity issue on an otherwise empty board", () => {
    const result = buildUiSummary(
      input({
        board: board([], { workflowStatus: "inactive", phases: [] }),
        facts: facts({ sessionId: "other-session" }),
      }),
    );
    expect(result.headline.text).toBe("身份需检查");
    expect(result.visible).toBe(true);
  });

  it.each(["planning", "approved", "revoked", "interrupted"] as const)(
    "keeps current-session preflight %s visible without tasks or another fault",
    (phase) => {
      const result = buildUiSummary(
        input({
          board: board([], { workflowStatus: "inactive", phases: [] }),
          preflight: preflightState({ phase }),
        }),
      );
      expect(result.visible).toBe(true);
    },
  );

  it.each(["active", "results_pending"] as const)(
    "qualifies an external %s observation as a previous owner report",
    (phase) => {
      const result = buildUiSummary(
        input({
          supervisor: supervisorState({
            externalWait: {
              boardDigest: "a".repeat(64),
              epoch: 0,
              observedAt: 1699999998000,
              deadlineAt: 1700000001000,
              phase,
              refs: [{ taskId: "t1", source: "pi-subagents", runId: "run-1" }],
            },
          }),
        }),
      );
      expect(result.headline.text).toMatch(/最近.*(?:记录|报告)|历史/);
      expect(result.headline.text).not.toBe("外部执行进行中");
    },
  );

  it("safely normalizes summary IDs, dependency notes and acceptance display without mutating input", () => {
    const id = "\u001b[31mt1\u001b[0m\tX";
    const original = input({
      board: board([task(id, "reviewing", { dependencies: ["\u001b[32mmissing\u001b[0m\tdep"] })], {
        finalAcceptanceTaskId: id,
      }),
    });
    const before = JSON.stringify(original);
    const result = buildUiSummary(original);
    const displayed = [result.tasks[0]!.id, ...result.tasks[0]!.notes, result.acceptance].join(
      "\n",
    );
    expect(displayed).not.toContain(String.fromCharCode(27));
    expect(displayed).not.toContain("\t");
    expect(displayed).not.toContain("\r");
    expect(JSON.stringify(original)).toBe(before);
  });

  it("describes interruption as interruption, not a revoked or rejected permission", () => {
    const result = buildUiSummary(input({ preflight: preflightState({ phase: "interrupted" }) }));
    expect(result.headline.text).toContain("中断");
    expect(result.headline.text).not.toContain("撤销");
  });

  it("uses the supplied owner next step rather than repeating the active status", () => {
    const result = buildUiSummary(
      input({ supervisor: supervisorState(), ownerNext: "核对已批准任务并正常结束本轮" }),
    );
    expect(result.headline.text).toBe("监督已启用");
    expect(result.next.text).toBe("核对已批准任务并正常结束本轮");
  });

  it("makes an absent or blank normal next step explicitly unknown", () => {
    for (const ownerNext of [undefined, "", " \t\n"]) {
      const result = buildUiSummary(input({ supervisor: supervisorState(), ownerNext }));
      expect(result.next.text).toBe("尚无已确认的下一步，请查看状态");
    }
  });
});
