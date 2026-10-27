import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { goalFixture } from "./helpers/goal";
import { localProposal } from "./helpers/preflight";
import { resetState } from "../state";
import { currentRuntime } from "../runtime";
import { requestGoalTransition } from "../goal-lifecycle";
import { readGoalJournal, goalTransitionScope } from "../goal-journal";
import { journalDigest } from "../human-journal";

// Deliberately malformed, physically recorded fixture bytes; none is accepted as authority.
type Row = Record<string, any>;
type Change = (row: Row, f: Awaited<ReturnType<typeof goalFixture>>) => void;
const fixtures: Awaited<ReturnType<typeof goalFixture>>[] = [];
beforeEach(() => {
  resetState();
});
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.restoreHost();
    rmSync(f.dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
async function prepared() {
  const f = await goalFixture();
  fixtures.push(f);
  expect(
    (
      await requestGoalTransition(f.api, f.ctx, {
        goal: "Protocol guarded goal",
        intent: "supervise",
      })
    ).status,
  ).toBe("committed-planning");
  return f;
}
function control(f: Awaited<ReturnType<typeof goalFixture>>): Row {
  return structuredClone(
    f.entries().find((e) => (e.data as Row).kind === "transition-control")!.data,
  ) as Row;
}
function nativeRef(f: Awaited<ReturnType<typeof goalFixture>>, predicate: (row: Row) => boolean) {
  const entry = f.entries().find((e) => predicate(e.data as Row))!;
  return { entryId: entry.id, entryDigest: journalDigest(entry), selector: "data" };
}
const seedChanges: [string, Change][] = [
  [
    "invalid run identity",
    (r) => {
      r.seed.goalRunId = "not-a-reserved-run-id";
    },
  ],
  [
    "invalid board",
    (r) => {
      r.seed.board = {};
    },
  ],
  [
    "inherited tasks",
    (r, f) => {
      r.seed.board = { ...f.old, generation: r.seed.board.generation, workflowStatus: "inactive" };
    },
  ],
  [
    "inherited phases",
    (r) => {
      r.seed.board.phases = [{ phase: 1, status: "pending" }];
    },
  ],
  [
    "paused board",
    (r) => {
      r.seed.board.workflowStatus = "paused";
      r.seed.board.pauseReason = "Old pause";
    },
  ],
  [
    "inherited stagnation",
    (r) => {
      r.seed.board.stagnantSettles = 1;
    },
  ],
  [
    "wrong planning format",
    (r) => {
      r.seed.preflight.version = 1;
    },
  ],
  [
    "foreign planning session",
    (r) => {
      r.seed.preflight.sessionId = "foreign";
    },
  ],
  [
    "different planning target",
    (r) => {
      r.seed.preflight.goal = "Other target";
    },
  ],
  [
    "different preflight identity",
    (r) => {
      r.seed.preflight.preflightId = "other-pf";
    },
  ],
  [
    "inherited revision",
    (r) => {
      r.seed.preflight.revision = 1;
    },
  ],
  [
    "inherited planning phase",
    (r) => {
      r.seed.preflight.phase = "interrupted";
    },
  ],
  [
    "inherited proposal",
    (r) => {
      r.seed.preflight.proposal = localProposal;
    },
  ],
  [
    "inherited plan id",
    (r) => {
      r.seed.preflight.planId = "old-plan";
    },
  ],
  [
    "inherited plan digest",
    (r) => {
      r.seed.preflight.planDigest = "0".repeat(64);
    },
  ],
  [
    "inherited first-start",
    (r) => {
      r.seed.preflight.started = true;
    },
  ],
  [
    "inherited attempt count",
    (r) => {
      r.seed.planning.attemptNo = 1;
    },
  ],
  [
    "inherited dispatch claim",
    (r) => {
      r.seed.planning.status = "dispatch-claimed";
    },
  ],
];
it.each(seedChanges)("refuses an archive control with %s", async (_label, change) => {
  const f = await prepared();
  const r = control(f);
  change(r, f);
  r.humanInteraction.scopeDigest = journalDigest(
    goalTransitionScope(r.from, r.seed, r.transitionId),
  );
  f.api.appendEntry("continuous-tasks:supervisor", r);
  expect(() => readGoalJournal(f.ctx)).toThrow();
  expect(currentRuntime().goal?.current?.seed.goal).toBe("Protocol guarded goal");
});
const frameChanges: [string, Change][] = [
  [
    "another request",
    (r) => {
      r.humanInteraction.requestId = "other";
    },
  ],
  [
    "foreign session",
    (r) => {
      r.humanInteraction.sessionId = "foreign";
    },
  ],
  [
    "wrong base id",
    (r) => {
      r.humanInteraction.baseEntryId = "other";
    },
  ],
  [
    "wrong base digest",
    (r) => {
      r.humanInteraction.baseEntryDigest = "0".repeat(64);
    },
  ],
  [
    "wrong choice digest",
    (r) => {
      r.humanInteraction.scopeDigest = "0".repeat(64);
    },
  ],
  [
    "legacy frame",
    (r) => {
      r.humanInteraction.version = 1;
    },
  ],
];
it.each(frameChanges)("rejects a goal-native frame with %s", async (_label, change) => {
  const f = await prepared();
  const r = control(f);
  change(r, f);
  f.api.appendEntry("continuous-tasks:supervisor", r);
  expect(() => readGoalJournal(f.ctx)).toThrow();
});
const sourceChanges: [string, Change][] = [
  [
    "foreign source",
    (r) => {
      r.from.sessionId = "foreign";
    },
  ],
  [
    "wrong board digest",
    (r) => {
      r.from.boardDigest = "0".repeat(64);
    },
  ],
  [
    "missing recorded board",
    (r) => {
      r.from.board = null;
    },
  ],
  [
    "wrong source entry digest",
    (r) => {
      r.from.board.entryDigest = "0".repeat(64);
    },
  ],
  [
    "missing source entry",
    (r) => {
      r.from.board.entryId = "missing";
    },
  ],
  [
    "wrong source selector",
    (r) => {
      r.from.board.selector = "supervisor";
    },
  ],
  [
    "live source board",
    (r, f) => {
      r.from.board = nativeRef(f, (x) => x.version === 2 && x.workflowStatus === "active");
      r.from.boardDigest = journalDigest(
        f.entries().find((e) => e.id === r.from.board.entryId)!.data,
      );
    },
  ],
  [
    "wrong Supervisor digest",
    (r) => {
      r.from.supervisorDigest = "0".repeat(64);
    },
  ],
  [
    "untraced Supervisor",
    (r) => {
      r.from.supervisor = null;
    },
  ],
  [
    "untraced preflight",
    (r) => {
      r.from.preflightDigest = "0".repeat(64);
    },
  ],
  [
    "non-preflight source",
    (r) => {
      r.from.preflight = r.from.board;
      r.from.preflightDigest = r.from.boardDigest;
    },
  ],
  [
    "nonterminal source Supervisor",
    (r, f) => {
      r.from.supervisor = nativeRef(f, (x) => x.version === 3 && x.status === "active");
      r.from.supervisorDigest = journalDigest(
        f.entries().find((e) => e.id === r.from.supervisor.entryId)!.data,
      );
    },
  ],
  [
    "non-successor generation",
    (r) => {
      r.seed.board.generation = Number(r.seed.board.generation) + 2;
    },
  ],
  [
    "unclosed source head",
    (r) => {
      r.from.head.entryId = "missing-head";
      r.humanInteraction.baseEntryId = "missing-head";
    },
  ],
];
it.each(sourceChanges)("refuses an archive with %s", async (_label, change) => {
  const f = await prepared();
  const r = control(f);
  change(r, f);
  r.humanInteraction.scopeDigest = journalDigest(
    goalTransitionScope(r.from, r.seed, r.transitionId),
  );
  f.api.appendEntry("continuous-tasks:supervisor", r);
  expect(() => readGoalJournal(f.ctx)).toThrow();
});
const commitChanges: [string, Change][] = [
  [
    "another transition",
    (r) => {
      r.transitionId = "other-transition";
    },
  ],
  [
    "wrong control id",
    (r) => {
      r.controlEntryId = "other-control";
    },
  ],
  [
    "wrong control digest",
    (r) => {
      r.controlDigest = "0".repeat(64);
    },
  ],
  [
    "wrong witness id",
    (r) => {
      r.witnessEntryId = "other-witness";
    },
  ],
  [
    "wrong witness digest",
    (r) => {
      r.witnessDigest = "0".repeat(64);
    },
  ],
  [
    "changed chosen target",
    (r) => {
      r.seed.goal = "Changed after answer";
    },
  ],
  [
    "changed chosen source",
    (r) => {
      r.from.boardDigest = "0".repeat(64);
    },
  ],
];
it.each(commitChanges)("does not publish C with %s", async (_label, change) => {
  const f = await prepared();
  const entry = [...f.entries()]
    .reverse()
    .find((item) => (item.data as Row).kind === "transition-committed")!;
  const r = structuredClone(entry.data) as Row;
  const lines = readFileSync(f.path, "utf8").trimEnd().split("\n");
  const commitAt = lines.findIndex((line) => (JSON.parse(line) as Row).id === entry.id);
  expect(commitAt).toBeGreaterThan(0);
  // Retain actual A/B; remove C and its derived mode records, not an arbitrary last row.
  writeFileSync(f.path, lines.slice(0, commitAt).join("\n") + "\n");
  f.reload();
  change(r, f);
  f.api.appendEntry("continuous-tasks:supervisor", r);
  expect(() => readGoalJournal(f.ctx)).toThrow();
});
function state(f: Awaited<ReturnType<typeof goalFixture>>): Row {
  const current = currentRuntime().goal!.current!;
  return {
    version: 5,
    protocol: "goal-lifecycle-v1",
    kind: "goal-state",
    sessionId: f.ctx.sessionManager.getSessionId(),
    scope: structuredClone(current.scope),
    previous: current.headEntryId,
    action: "claim-planning-dispatch",
    phase: "planning",
    planning: { ...current.planning, status: "dispatch-claimed" },
    supervisor: null,
  };
}
function observed(f: Awaited<ReturnType<typeof goalFixture>>) {
  const current = currentRuntime().goal!.current!;
  return {
    sessionId: "test-session",
    goalRunId: current.scope.goalRunId,
    attemptId: current.planning.attemptId,
    branchAnchor: f.ctx.sessionManager.getLeafId(),
    hostIdle: true,
    pendingMessages: false,
    observedAt: Date.now(),
  };
}
function replacement(r: Row, f: Awaited<ReturnType<typeof goalFixture>>): void {
  r.action = "prepare-planning";
  r.quiescence = observed(f);
  r.planning = {
    attemptNo: 1,
    attemptId: "replacement",
    preflightId: "pf-replacement",
    status: "prepared",
  };
  r.preflightSeed = {
    ...currentRuntime().goal!.current!.preflightSeed,
    preflightId: "pf-replacement",
  };
}
const stateChanges: [string, Change][] = [
  [
    "reused replacement attempt",
    (r, f) => {
      replacement(r, f);
      r.planning.attemptId = currentRuntime().goal!.current!.planning.attemptId;
    },
  ],
  [
    "reused replacement preflight",
    (r, f) => {
      replacement(r, f);
      r.planning.preflightId = currentRuntime().goal!.current!.planning.preflightId;
    },
  ],
  [
    "replacement already settled",
    (r, f) => {
      replacement(r, f);
      r.planning.status = "settled";
    },
  ],
  [
    "replacement already interrupted",
    (r, f) => {
      replacement(r, f);
      r.phase = "planning-interrupted";
    },
  ],
  [
    "missing replacement seed",
    (r, f) => {
      replacement(r, f);
      delete r.preflightSeed;
    },
  ],
  [
    "wrong predecessor",
    (r) => {
      r.previous = "other-entry";
    },
  ],
  [
    "foreign scope",
    (r) => {
      r.scope.goalRunId = "other-goal";
    },
  ],
  [
    "sibling commit",
    (r) => {
      r.scope.lifecycleCommitId = "other-commit";
    },
  ],
  [
    "different attempt number",
    (r) => {
      r.planning.attemptNo = 1;
    },
  ],
  [
    "different attempt id",
    (r) => {
      r.planning.attemptId = "other-attempt";
    },
  ],
  [
    "different preflight id",
    (r) => {
      r.planning.preflightId = "other-pf";
    },
  ],
  [
    "unexpected seed replacement",
    (r) => {
      r.preflightSeed = currentRuntime().goal!.current!.preflightSeed;
    },
  ],
  [
    "skipped claim",
    (r) => {
      r.planning.status = "dispatched";
    },
  ],
  [
    "wrong action phase",
    (r) => {
      r.phase = "stopped";
    },
  ],
  [
    "unexpected stop disposition",
    (r) => {
      r.disposition = "closed-unstarted";
    },
  ],
  [
    "missing Supervisor payload",
    (r) => {
      r.action = "supervisor";
    },
  ],
  [
    "planning with execution payload",
    (r) => {
      r.supervisor = {};
    },
  ],
  [
    "missing quiescence",
    (r) => {
      r.action = "stop-unstarted";
      r.phase = "stopped";
      r.planning.status = "prepared";
      r.disposition = "closed-unstarted";
    },
  ],
  [
    "foreign quiescence session",
    (r, f) => {
      r.quiescence = { ...observed(f), sessionId: "foreign" };
    },
  ],
  [
    "foreign quiescence goal",
    (r, f) => {
      r.quiescence = { ...observed(f), goalRunId: "foreign" };
    },
  ],
  [
    "old quiescence attempt",
    (r, f) => {
      r.quiescence = { ...observed(f), attemptId: "old" };
    },
  ],
  [
    "wrong quiescence parent",
    (r, f) => {
      r.quiescence = { ...observed(f), branchAnchor: "old-parent" };
    },
  ],
  [
    "unobserved replacement",
    (r, f) => {
      r.action = "prepare-planning";
      r.quiescence = observed(f);
      r.planning.status = "prepared";
    },
  ],
  [
    "missing stop disposition",
    (r, f) => {
      r.action = "stop-unstarted";
      r.phase = "stopped";
      r.planning.status = "prepared";
      r.quiescence = observed(f);
    },
  ],
];
it.each(stateChanges)("does not accept goal state with %s", async (_label, change) => {
  const f = await prepared();
  const r = state(f);
  change(r, f);
  f.api.appendEntry("continuous-tasks:supervisor", r);
  expect(() => readGoalJournal(f.ctx)).toThrow();
});
