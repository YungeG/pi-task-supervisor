import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { TaskBoardSnapshot } from "./types";
import type { PreflightState } from "./preflight";
import type { GoalReadbackFrame } from "./human-journal";

export const GOAL_PROTOCOL = "goal-lifecycle-v1";
export const GOAL_ENTRY = "continuous-tasks:supervisor";
const text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const strict = { additionalProperties: false } as const;
const modelSchema = Type.Object({ provider: text(200), id: text(300) }, strict);
export const GoalScopeSchema = Type.Object(
  { goalRunId: text(100), lifecycleCommitId: text(200) },
  strict,
);
export type GoalScope = Static<typeof GoalScopeSchema>;
const refSchema = Type.Object(
  {
    entryId: text(200),
    entryDigest: hash,
    selector: Type.Union([
      Type.Literal("data"),
      Type.Literal("legacy-board"),
      Type.Literal("snapshot"),
      Type.Literal("seed-board"),
      Type.Literal("seed-preflight"),
      Type.Literal("supervisor"),
    ]),
  },
  strict,
);
export type GoalSourceRef = Static<typeof refSchema>;
const nullableRef = Type.Union([refSchema, Type.Null()]);
const SourceSchema = Type.Object(
  {
    sessionId: text(200),
    goalKey: text(300),
    scope: Type.Union([GoalScopeSchema, Type.Null()]),
    head: refSchema,
    board: nullableRef,
    preflight: nullableRef,
    supervisor: nullableRef,
    boardDigest: hash,
    preflightDigest: Type.Union([hash, Type.Null()]),
    supervisorDigest: Type.Union([hash, Type.Null()]),
  },
  strict,
);
export type GoalSource = Static<typeof SourceSchema>;
const PlanningSchema = Type.Object(
  {
    attemptNo: natural,
    attemptId: text(100),
    preflightId: text(200),
    status: Type.Union([
      Type.Literal("prepared"),
      Type.Literal("dispatch-claimed"),
      Type.Literal("dispatched"),
      Type.Literal("settled"),
      Type.Literal("closed-unknown-result"),
    ]),
  },
  strict,
);
export type GoalPlanning = Static<typeof PlanningSchema>;
const phaseSchema = Type.Union([
  Type.Literal("planning"),
  Type.Literal("planning-interrupted"),
  Type.Literal("active"),
  Type.Literal("reviewing"),
  Type.Literal("paused"),
  Type.Literal("fault"),
  Type.Literal("completed"),
  Type.Literal("stopped"),
]);
export type GoalPhase =
  | "planning"
  | "planning-interrupted"
  | "active"
  | "reviewing"
  | "paused"
  | "fault"
  | "completed"
  | "stopped";
const SeedSchema = Type.Object(
  {
    goalRunId: text(100),
    goal: text(4000),
    model: modelSchema,
    board: Type.Unknown(),
    preflight: Type.Unknown(),
    planning: PlanningSchema,
  },
  strict,
);
export type GoalSeed = Omit<Static<typeof SeedSchema>, "board" | "preflight"> & {
  board: TaskBoardSnapshot;
  preflight: PreflightState;
};
const common = {
  version: Type.Literal(5),
  protocol: Type.Literal(GOAL_PROTOCOL),
  sessionId: text(200),
};
const ControlSchema = Type.Object(
  {
    ...common,
    kind: Type.Literal("transition-control"),
    transitionId: text(200),
    from: SourceSchema,
    seed: SeedSchema,
    humanInteraction: Type.Unknown(),
    createdAt: text(100),
    supersedes: Type.Optional(
      Type.Object({ entryId: text(200), requestId: text(200), entryDigest: hash }, strict),
    ),
  },
  strict,
);
const CommitSchema = Type.Object(
  {
    ...common,
    kind: Type.Literal("transition-committed"),
    transitionId: text(200),
    controlEntryId: text(200),
    controlDigest: hash,
    witnessEntryId: text(200),
    witnessDigest: hash,
    from: SourceSchema,
    seed: SeedSchema,
  },
  strict,
);
const QuiescenceSchema = Type.Object(
  {
    sessionId: text(200),
    goalRunId: text(100),
    attemptId: text(100),
    branchAnchor: text(200),
    hostIdle: Type.Literal(true),
    pendingMessages: Type.Literal(false),
    observedAt: natural,
  },
  strict,
);
export type GoalQuiescence = Static<typeof QuiescenceSchema>;
const StateSchema = Type.Object(
  {
    ...common,
    kind: Type.Literal("goal-state"),
    scope: GoalScopeSchema,
    previous: text(200),
    action: Type.Union([
      Type.Literal("prepare-planning"),
      Type.Literal("claim-planning-dispatch"),
      Type.Literal("observe-planning-dispatch"),
      Type.Literal("settle-planning"),
      Type.Literal("stop-unstarted"),
      Type.Literal("supervisor"),
    ]),
    phase: phaseSchema,
    planning: PlanningSchema,
    preflightSeed: Type.Optional(Type.Unknown()),
    quiescence: Type.Optional(QuiescenceSchema),
    disposition: Type.Optional(Type.Literal("closed-unstarted")),
    supervisor: Type.Union([Type.Unknown(), Type.Null()]),
  },
  strict,
);
export const GoalRecordSchema = Type.Union([ControlSchema, CommitSchema, StateSchema]);
export type RawGoalRecord = Static<typeof GoalRecordSchema>;
export type GoalControl = Omit<Static<typeof ControlSchema>, "seed" | "humanInteraction"> & {
  seed: GoalSeed;
  humanInteraction: GoalReadbackFrame;
};
export type GoalCommit = Omit<Static<typeof CommitSchema>, "seed"> & { seed: GoalSeed };
export type GoalStateRecord = Omit<Static<typeof StateSchema>, "preflightSeed" | "phase"> & {
  preflightSeed?: PreflightState;
  phase: GoalPhase;
};
export type GoalRecord = GoalControl | GoalCommit | GoalStateRecord;
export const GoalCarrierSchema = Type.Object(
  {
    version: Type.Literal(3),
    protocol: Type.Literal(GOAL_PROTOCOL),
    ...GoalScopeSchema.properties,
    snapshot: Type.Unknown(),
  },
  strict,
);
export type GoalCarrier = Static<typeof GoalCarrierSchema>;

/** Structural decoding only. The journal owner additionally validates all semantic payloads. */
export function isGoalRecord(value: unknown): value is RawGoalRecord {
  return Check(GoalRecordSchema, value);
}
export function isGoalCarrier(value: unknown): value is GoalCarrier {
  return Check(GoalCarrierSchema, value);
}
export function scopeEqual(a: GoalScope, b: GoalScope): boolean {
  return a.goalRunId === b.goalRunId && a.lifecycleCommitId === b.lifecycleCommitId;
}
export function wrapGoalSnapshot(scope: GoalScope, snapshot: unknown): GoalCarrier {
  return { version: 3, protocol: GOAL_PROTOCOL, ...scope, snapshot: structuredClone(snapshot) };
}
export function unwrapGoalSnapshot(data: unknown, scope?: GoalScope): unknown {
  if (!scope) {
    if (isGoalCarrier(data)) throw new Error("Scoped snapshot has no selected GoalRun");
    return data;
  }
  if (!isGoalCarrier(data) || !scopeEqual(data, scope))
    throw new Error("Snapshot belongs to a different or missing GoalRun");
  return data.snapshot;
}
export function supervisorPayload(data: unknown): unknown {
  if (data && typeof data === "object" && "version" in data && data.version === 5) {
    if (!isGoalRecord(data)) throw new Error("Invalid goal-lifecycle checkpoint");
    return data.kind === "goal-state" ? (data.supervisor ?? undefined) : undefined;
  }
  return data;
}
export interface GoalArchive {
  commitEntryId: string;
  goalKey: string;
  source: GoalSource;
}
export interface GoalCurrent {
  scope: GoalScope;
  seed: GoalSeed;
  phase: GoalPhase;
  planning: GoalPlanning;
  headEntryId: string;
  preflightSeed: PreflightState;
  preflightBaseEntryId: string;
  supervisor: unknown;
  disposition?: "closed-unstarted";
  board: TaskBoardSnapshot;
}
export interface GoalRuntime {
  sessionId: string;
  current?: GoalCurrent;
  pending?: { controlEntryId: string; control: GoalControl; confirmed: boolean };
  archives: GoalArchive[];
  blocked?: string;
  repair?: { record: GoalStateRecord; reason: string };
}
