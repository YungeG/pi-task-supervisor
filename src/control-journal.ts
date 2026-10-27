import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import {
  ACCEPTANCE_PROPOSAL_ENTRY,
  validContractProposal,
  proposalOriginalGoal,
  type ContractProposalRecord,
} from "./acceptance-planning";
import {
  ACCEPTANCE_FACT_ENTRY,
  validAcceptanceFact,
  readAcceptanceFacts,
  acceptanceRunActivityIssue,
  isAcceptanceWitness,
  type AcceptanceFact,
  type AcceptanceJournalView,
} from "./acceptance-journal";
import { currentRuntime, type TaskRuntime } from "./runtime";
import { goalControlIssue, goalLease } from "./goal-scope";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { inspectRestorableSession, sessionJournalView } from "./human-control";
import {
  inspectSessionJournal,
  journalDigest,
  type SessionJournal,
  type JournalReceiptProof,
  type JournalSupervisorProof,
  type JournalNode,
} from "./human-journal";
import { RECEIPT_LEDGER_ENTRY, digest as receiptDigest, redactedJSON } from "./receipt-store";
import type { RestoreJournalRead } from "./restore-journal";
import {
  emptyInvocationGraph,
  admitInvocation,
  observeInvocationEnd,
  sealInvocationRoot,
  attestInvocation,
  qualificationKey,
  invocationOwnerKey,
  SDK_TOOL_ONLY_CAPABILITY,
  type InvocationGraph,
  type InvocationStartedV1,
  type InvocationEndedV1,
  type InvocationNodeV1,
  type InvocationRootSealedV1,
  type EligibilityAttestedV1,
} from "./invocation-tree";
import { isGoalCarrier, isGoalRecord } from "./goal-records";
import { isValidSnapshotV2, completionEvidenceError } from "./validation";
import { CUSTOM_EVENT_TYPE, CUSTOM_SNAPSHOT_TYPE, type TaskBoardSnapshot } from "./types";
import { CompletionEvidenceParams, EvidenceRefParams } from "./schemas";
import type {
  CompletionIntentV1,
  CompletionDispositionV1,
  CompletionIntentEntry,
} from "./completion-intents";

export const CONTROL_FENCE_ENTRY = "continuous-tasks:supervisor";
export const CONTROL_FACT_ENTRY = "continuous-tasks:control-facts";
export const CONTROL_PROTOCOL = "task-supervisor-control-v1";
export const CONTROL_FEATURES = [
  "acceptance-contract-v1",
  "advisor-accounting-v1",
  "completion-intents-v1",
  "execution-settlement-v1",
  "final-review-v1",
  "invocation-tree-v1",
  "management-mode-v1",
  "progress-facts-v1",
] as const;
export type ControlFeature = (typeof CONTROL_FEATURES)[number];
const supportedControlFeatures = new Set<ControlFeature>([
  "acceptance-contract-v1",
  "advisor-accounting-v1",
  "completion-intents-v1",
  "execution-settlement-v1",
  "final-review-v1",
  "invocation-tree-v1",
  "management-mode-v1",
  "progress-facts-v1",
]);
const id = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const strict = { additionalProperties: false } as const;
const nullableId = (maxLength: number) => Type.Union([id(maxLength), Type.Null()]);
const GoalOwnerSchema = Type.Object(
  {
    sessionId: id(200),
    goalKey: id(300),
    goalRunId: nullableId(100),
    lifecycleCommitId: nullableId(200),
  },
  strict,
);
const BoardOwnerSchema = Type.Object(
  { sessionId: id(200), boardRunId: id(100), seedEntryId: id(200) },
  strict,
);
export const WorkOwnerSchema = Type.Union([
  Type.Object({ kind: Type.Literal("goal"), goal: GoalOwnerSchema }, strict),
  Type.Object({ kind: Type.Literal("board"), board: BoardOwnerSchema }, strict),
]);
export type GoalOwnerKey = Static<typeof GoalOwnerSchema>;
export type BoardOwnerKey = Static<typeof BoardOwnerSchema>;
export type WorkOwnerKey = Static<typeof WorkOwnerSchema>;
const natural = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const money = Type.Number({ minimum: 0 });
const reference = Type.Object({ entryId: id(200), digest: hash }, strict);
const advisorOwner = Type.Object({ kind: Type.Literal("goal"), goal: GoalOwnerSchema }, strict);
export const AdvisorUsageSchema = Type.Object(
  {
    input: natural,
    output: natural,
    cacheRead: natural,
    cacheWrite: natural,
    totalTokens: natural,
    cost: Type.Object(
      { input: money, output: money, cacheRead: money, cacheWrite: money, total: money },
      strict,
    ),
  },
  strict,
);
const advisorCommon = {
  version: Type.Literal(1),
  recordId: id(100),
  callId: id(100),
  owner: advisorOwner,
};
export const AdvisorStartedSchema = Type.Object(
  {
    ...advisorCommon,
    kind: Type.Literal("advisor-call-started"),
    attemptId: id(100),
    viewDigest: hash,
    model: Type.Object({ provider: id(200), id: id(300) }, strict),
    budgetSlot: Type.Integer({ minimum: 1, maximum: 40 }),
    legacySubtotal: Type.Object({ tokens: natural, cost: money, reviews: natural }, strict),
    startedAt: natural,
  },
  strict,
);
export const AdvisorObservedSchema = Type.Object(
  {
    ...advisorCommon,
    kind: Type.Literal("advisor-call-observed"),
    startedRef: reference,
    outcomeDigest: hash,
    status: Type.Union([Type.Literal("returned"), Type.Literal("error"), Type.Literal("aborted")]),
    usage: Type.Union([
      Type.Object({ state: Type.Literal("known"), values: AdvisorUsageSchema }, strict),
      Type.Object(
        {
          state: Type.Literal("unknown"),
          reason: Type.Union([
            Type.Literal("missing"),
            Type.Literal("invalid"),
            Type.Literal("overflow"),
          ]),
        },
        strict,
      ),
    ]),
    observedAt: natural,
  },
  strict,
);
export const AdvisorConflictSchema = Type.Object(
  {
    ...advisorCommon,
    kind: Type.Literal("advisor-call-conflict"),
    firstObservationRef: reference,
    outcomeDigest: hash,
    status: AdvisorObservedSchema.properties.status,
    usage: AdvisorObservedSchema.properties.usage,
    observedAt: natural,
  },
  strict,
);
export const AdvisorFactSchema = Type.Union([
  AdvisorStartedSchema,
  AdvisorObservedSchema,
  AdvisorConflictSchema,
]);
export type AdvisorStartedFact = Static<typeof AdvisorStartedSchema>;
export type AdvisorObservedFact = Static<typeof AdvisorObservedSchema>;
export type AdvisorConflictFact = Static<typeof AdvisorConflictSchema>;
export type AdvisorFact = Static<typeof AdvisorFactSchema>;
export interface AdvisorFactView {
  entryId: string;
  digest: string;
  data: AdvisorFact;
}
export const BoardRunSeedSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("board-run-seed"),
    recordId: id(100),
    sessionId: id(200),
    boardRunId: id(100),
    snapshotRef: reference,
    boardDigest: hash,
  },
  strict,
);
export type BoardRunSeedFact = Static<typeof BoardRunSeedSchema>;
export interface BoardRunSeedView {
  entryId: string;
  digest: string;
  data: BoardRunSeedFact;
}
export const ExecutionGenerationSchema = Type.Union([
  Type.Object({ kind: Type.Literal("runner"), runnerProcessInstanceId: id(200) }, strict),
  Type.Object({ kind: Type.Literal("workflow"), parentToolCallId: id(200) }, strict),
]);
const executionRefSchema = Type.Object(
  { source: Type.Union([Type.Literal("pi-subagents"), Type.Literal("workflow")]), runId: id(200) },
  strict,
);
const executionCommon = {
  version: Type.Literal(1),
  recordId: id(100),
  owner: WorkOwnerSchema,
  bindingId: id(100),
};
export const ExecutionBindingSchema = Type.Object(
  {
    ...executionCommon,
    kind: Type.Literal("execution-binding"),
    taskId: id(100),
    executionRef: executionRefSchema,
    generation: Type.Union([ExecutionGenerationSchema, Type.Null()]),
    beforeSnapshotRef: reference,
    beforeBoardDigest: hash,
    boundBoardDigest: hash,
    taskDigest: hash,
    imported: Type.Boolean(),
    boundAt: natural,
  },
  strict,
);
export const ExecutionObservationSchema = Type.Object(
  {
    outcome: Type.Union([
      Type.Literal("active"),
      Type.Literal("unknown"),
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Literal("cancelled"),
    ]),
    reason: id(300),
    requestId: id(100),
    observedAt: natural,
    snapshotGeneratedAt: natural,
    snapshotDigest: hash,
    rootState: id(30),
    subtreeDigest: hash,
    writerEvidence: Type.Union([
      Type.Literal("observed"),
      Type.Literal("not-applicable"),
      Type.Literal("unknown"),
    ]),
    generation: Type.Optional(ExecutionGenerationSchema),
    proofDigest: Type.Optional(hash),
  },
  strict,
);
export const ExecutionObservedSchema = Type.Object(
  {
    ...executionCommon,
    kind: Type.Literal("execution-observation"),
    bindingRef: reference,
    observation: ExecutionObservationSchema,
  },
  strict,
);
export const ExecutionSettledSchema = Type.Object(
  {
    ...executionCommon,
    kind: Type.Literal("execution-settlement"),
    settlementId: id(100),
    observationRef: reference,
    outcome: Type.Union([
      Type.Literal("success"),
      Type.Literal("failure"),
      Type.Literal("cancelled"),
    ]),
    beforeBoardDigest: hash,
    releasedBoardDigest: hash,
    settledAt: natural,
  },
  strict,
);
const validationSource = Type.Object({ intentRef: reference, receiptRef: reference }, strict);
export const ExecutionResolutionSchema = Type.Object(
  {
    ...executionCommon,
    kind: Type.Literal("execution-resolution"),
    resolutionId: id(100),
    settlementRef: reference,
    resolutionKind: Type.Union([
      Type.Literal("validated_repair"),
      Type.Literal("superseded_success"),
    ]),
    validationRefs: Type.Array(id(500), { minItems: 1, maxItems: 20 }),
    validationSources: Type.Array(validationSource, { minItems: 1, maxItems: 20 }),
    reviewSnapshotRef: reference,
    supersedingBindingId: Type.Optional(id(100)),
    taskDigest: hash,
    mutationEpoch: natural,
    resolvedAt: natural,
  },
  strict,
);
export const ExecutionFactSchema = Type.Union([
  ExecutionBindingSchema,
  ExecutionObservedSchema,
  ExecutionSettledSchema,
  ExecutionResolutionSchema,
]);
export type ExecutionBindingFact = Static<typeof ExecutionBindingSchema>;
export type ExecutionObservedFact = Static<typeof ExecutionObservedSchema>;
export type ExecutionSettledFact = Static<typeof ExecutionSettledSchema>;
export type ExecutionResolutionFact = Static<typeof ExecutionResolutionSchema>;
export type ExecutionFact = Static<typeof ExecutionFactSchema>;
export interface ExecutionFactView {
  entryId: string;
  digest: string;
  data: ExecutionFact;
}
export const ReviewVersionSchema = Type.Object(
  {
    version: Type.Literal(1),
    scopeId: id(200),
    workspace: Type.Object({ root: id(4096), device: id(100), inode: id(100) }, strict),
    scopeDigest: hash,
    inputsDigest: hash,
    artifactDigest: hash,
    environmentDigest: hash,
    versionId: hash,
    inputCount: Type.Integer({ minimum: 0, maximum: 10000 }),
    artifactCount: Type.Integer({ minimum: 0, maximum: 10000 }),
  },
  strict,
);
export const FinalValidationSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("final-validation"),
    recordId: id(100),
    owner: advisorOwner,
    validationId: id(100),
    taskId: id(100),
    taskDigest: hash,
    receiptId: id(300),
    source: validationSource,
    snapshotRef: reference,
    epoch: natural,
    toolName: id(200),
    inputDigest: hash,
    capturedInputDigest: hash,
    artifactVersion: ReviewVersionSchema,
    observedAt: natural,
    validationOnly: Type.Optional(
      Type.Object({ registrationRef: reference, boardDigest: hash, bindingsDigest: hash }, strict),
    ),
  },
  strict,
);
export const FinalValidationRegistrationSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("final-validation-registered"),
    recordId: id(100),
    owner: advisorOwner,
    registrationId: id(100),
    snapshotRef: reference,
    supervisorRef: reference,
    boardDigest: hash,
    bindingsDigest: hash,
    epoch: natural,
    taskId: id(100),
    taskDigest: hash,
    toolName: Type.Literal("bash"),
    inputJSON: id(1999),
    inputDigest: hash,
    capturedInputDigest: hash,
    cwd: id(4096),
    originalReceiptId: id(300),
    source: validationSource,
    artifactVersion: ReviewVersionSchema,
    registeredAt: natural,
  },
  strict,
);
export type FinalValidationRegistrationFact = Static<typeof FinalValidationRegistrationSchema>;
export interface FinalValidationRegistrationView {
  entryId: string;
  digest: string;
  data: FinalValidationRegistrationFact;
}
export type FinalValidationFact = Static<typeof FinalValidationSchema>;
export interface FinalValidationFactView {
  entryId: string;
  digest: string;
  data: FinalValidationFact;
}
const reviewAttemptCommon = {
  version: Type.Literal(1),
  recordId: id(100),
  owner: advisorOwner,
  attemptId: id(100),
};
export const ReviewAttemptStartedSchema = Type.Object(
  {
    ...reviewAttemptCommon,
    kind: Type.Literal("review-attempt-started"),
    snapshotRef: reference,
    supervisorRef: reference,
    baseLeafRef: reference,
    boardDigest: hash,
    bindingsDigest: hash,
    viewDigest: hash,
    firstCallViewDigest: hash,
    artifactVersion: ReviewVersionSchema,
    validationRef: reference,
    epoch: natural,
    reviewNumber: Type.Integer({ minimum: 1, maximum: 40 }),
    startedAt: natural,
    deadlineAt: natural,
  },
  strict,
);
export const ReviewAttemptObservedSchema = Type.Object(
  {
    ...reviewAttemptCommon,
    kind: Type.Literal("review-attempt-observed"),
    startedRef: reference,
    outcome: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("retryable_error"),
      Type.Literal("needs_validation"),
      Type.Literal("blocked"),
    ]),
    failureClass: Type.Union([
      Type.Literal("none"),
      Type.Literal("transient"),
      Type.Literal("deadline"),
      Type.Literal("budget"),
      Type.Literal("unknown_model_failure"),
      Type.Literal("authentication"),
      Type.Literal("advice_mismatch"),
      Type.Literal("evidence_missing"),
      Type.Literal("validation_stale"),
      Type.Literal("control_held"),
      Type.Literal("interrupted"),
    ]),
    callIds: Type.Array(id(100), { maxItems: 4 }),
    transportRetries: Type.Integer({ minimum: 0, maximum: 1 }),
    corrections: Type.Integer({ minimum: 0, maximum: 1 }),
    detailRounds: Type.Integer({ minimum: 0, maximum: 2 }),
    endLeafRef: reference,
    epoch: natural,
    observedAt: natural,
    reason: id(2000),
  },
  strict,
);
export const ReviewAttemptSchema = Type.Union([
  ReviewAttemptStartedSchema,
  ReviewAttemptObservedSchema,
]);
export type ReviewAttemptStartedFact = Static<typeof ReviewAttemptStartedSchema>;
export type ReviewAttemptObservedFact = Static<typeof ReviewAttemptObservedSchema>;
export type ReviewAttemptFact = Static<typeof ReviewAttemptSchema>;
export interface ReviewAttemptFactView {
  entryId: string;
  digest: string;
  data: ReviewAttemptFact;
}
export interface ReviewAttemptEntry {
  start: ReviewAttemptFactView & { data: ReviewAttemptStartedFact };
  result?: ReviewAttemptFactView & { data: ReviewAttemptObservedFact };
}
export const SessionModeSchema = Type.Object(
  {
    version: Type.Literal(1),
    kind: Type.Literal("session-mode-changed"),
    recordId: id(100),
    sessionId: id(200),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    previousModeRecord: Type.Union([reference, Type.Null()]),
    mode: Type.Union([Type.Literal("off"), Type.Literal("tasks"), Type.Literal("supervised")]),
    state: Type.Union([Type.Literal("active"), Type.Literal("stopping-with-attention")]),
    originOwner: Type.Union([WorkOwnerSchema, Type.Null()]),
    activeWorkOwner: Type.Union([WorkOwnerSchema, Type.Null()]),
    boardRef: Type.Union([reference, Type.Null()]),
    lastGoal: Type.Union([
      Type.Null(),
      Type.Object(
        {
          owner: Type.Union([GoalOwnerSchema, Type.Null()]),
          sourceRef: Type.Union([reference, Type.Null()]),
          acceptedRef: Type.Union([reference, Type.Null()]),
          validity: Type.Union([
            Type.Literal("accepted"),
            Type.Literal("needs_verification"),
            Type.Literal("stale"),
          ]),
        },
        strict,
      ),
    ]),
    attention: Type.Array(
      Type.Object(
        {
          kind: Type.Union([
            Type.Literal("execution"),
            Type.Literal("capture"),
            Type.Literal("control"),
            Type.Literal("source"),
            Type.Literal("business_failure"),
          ]),
          ref: Type.Union([reference, Type.Null()]),
          reason: id(1000),
        },
        strict,
      ),
      { maxItems: 32 },
    ),
    hostIdle: Type.Boolean(),
    pendingMessages: Type.Boolean(),
    observedAt: natural,
  },
  strict,
);
export type SessionModeChangedV1 = Static<typeof SessionModeSchema>;
export interface SessionModeView {
  entryId: string;
  digest: string;
  data: SessionModeChangedV1;
}
const progressCommon = { version: Type.Literal(1), recordId: id(100), owner: WorkOwnerSchema };
export const ProgressDefinitionSchema = Type.Object(
  {
    ...progressCommon,
    kind: Type.Literal("progress-definition"),
    definitionId: id(200),
    taskId: id(100),
    taskDigest: hash,
    milestone: Type.Union([
      Type.Literal("input_difference"),
      Type.Literal("artifact"),
      Type.Literal("check"),
    ]),
    policy: Type.Union([Type.Literal("git-visible-workspace-v1"), Type.Literal("declared-v1")]),
    root: id(4096),
    inputs: Type.Array(id(4096), { maxItems: 64 }),
    artifacts: Type.Array(id(256), { maxItems: 1 }),
    baseline: ReviewVersionSchema,
    absent: Type.Boolean(),
    check: Type.Union([Type.Null(), Type.Object({ tool: id(200), inputDigest: hash }, strict)]),
    boardRef: reference,
  },
  strict,
);
export const ProgressObservedSchema = Type.Object(
  {
    ...progressCommon,
    kind: Type.Literal("progress-observed"),
    definitionRef: reference,
    definitionId: id(200),
    taskId: id(100),
    sourceKind: Type.Union([Type.Literal("receipt"), Type.Literal("native-result")]),
    sourceRef: reference,
    receiptId: id(300),
    receiptDigest: hash,
    result: Type.Union([
      Type.Literal("changed"),
      Type.Literal("formed"),
      Type.Literal("failure"),
      Type.Literal("success"),
    ]),
    artifactVersion: ReviewVersionSchema,
  },
  strict,
);
export const BatchAdviceObservedSchema = Type.Object(
  {
    ...progressCommon,
    kind: Type.Literal("batch-advice-observed"),
    callRef: reference,
    supervisorRef: reference,
    boardRef: reference,
    graphDigest: hash,
    authorityDigest: hash,
    valid: Type.Boolean(),
    advice: Type.Object(
      {
        action: Type.Union([
          Type.Literal("guide"),
          Type.Literal("next_batch"),
          Type.Literal("hold"),
        ]),
        message: id(2000),
        taskIds: Type.Array(id(100), { maxItems: 100 }),
        evidenceRefs: Type.Array(id(300), { maxItems: 100 }),
      },
      strict,
    ),
  },
  strict,
);
export const ProgressFactSchema = Type.Union([
  ProgressDefinitionSchema,
  ProgressObservedSchema,
  BatchAdviceObservedSchema,
]);
export type ProgressDefinition = Static<typeof ProgressDefinitionSchema>;
export type ProgressObserved = Static<typeof ProgressObservedSchema>;
export type BatchAdviceObserved = Static<typeof BatchAdviceObservedSchema>;
export type ProgressFact = Static<typeof ProgressFactSchema>;
export interface ProgressFactView {
  entryId: string;
  digest: string;
  data: ProgressFact;
}
export function progressOwnerKey(owner: WorkOwnerKey): string {
  return journalDigest(
    owner.kind === "goal"
      ? [
          "goal",
          owner.goal.sessionId,
          owner.goal.goalKey,
          owner.goal.goalRunId,
          owner.goal.lifecycleCommitId,
        ]
      : ["board", owner.board.sessionId, owner.board.boardRunId, owner.board.seedEntryId],
  );
}
export function taskGraphDigest(board: Readonly<TaskBoardSnapshot>): string {
  return journalDigest([
    "task-graph-v1",
    board.finalAcceptanceTaskId ?? null,
    board.phases.map((p) => [p.phase, p.title]),
    board.tasks.map((t) => [
      t.id,
      t.title,
      t.prompt,
      t.profile,
      t.phase,
      [...t.dependencies].sort(),
    ]),
  ]);
}
export function progressKey(data: ProgressObserved): string {
  return journalDigest([
    "progress-key-v1",
    progressOwnerKey(data.owner),
    data.definitionId,
    data.taskId,
    data.result,
    data.artifactVersion.versionId,
  ]);
}
export function batchActionMismatch(
  board: Readonly<TaskBoardSnapshot>,
  advice: BatchAdviceObserved["advice"],
): boolean {
  const claimed = board.tasks.some((t) => ["implementing", "reviewing"].includes(t.status)),
    ready = board.tasks.filter((t) => t.status === "ready").map((t) => t.id);
  if (advice.action === "next_batch")
    return (
      board.workflowStatus !== "active" ||
      !!board.decision ||
      claimed ||
      board.tasks.some((t) => t.executionRef) ||
      !advice.taskIds.length ||
      advice.taskIds.some((id) => !ready.includes(id))
    );
  return advice.action === "guide" && !claimed && ready.length > 0;
}
const invocationCommon = {
  version: Type.Literal(1),
  recordId: id(100),
  owner: WorkOwnerSchema,
  operationId: id(100),
  sequence: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
};
export const InvocationStartedSchema = Type.Unsafe<InvocationStartedV1>(
  Type.Object(
    {
      ...invocationCommon,
      kind: Type.Literal("invocation-started"),
      toolCallId: id(2000),
      parentId: Type.Union([id(100), Type.Null()]),
      rootId: id(100),
      toolName: id(200),
      effect: Type.Union([
        Type.Literal("container"),
        Type.Literal("readonly"),
        Type.Literal("metadata"),
        Type.Literal("write"),
        Type.Literal("unknown"),
      ]),
      capability: Type.Union([Type.Literal(SDK_TOOL_ONLY_CAPABILITY), Type.Null()]),
      inputDigest: hash,
      sourceRef: Type.Union([reference, Type.Null()]),
      modeRef: Type.Union([reference, Type.Null()]),
    },
    strict,
  ),
);
export const InvocationEndedSchema = Type.Unsafe<InvocationEndedV1>(
  Type.Object(
    {
      ...invocationCommon,
      kind: Type.Literal("invocation-ended"),
      outcome: Type.Union([
        Type.Literal("returned"),
        Type.Literal("error"),
        Type.Literal("cancelled"),
        Type.Literal("unknown"),
      ]),
      receiptId: Type.Union([id(300), Type.Null()]),
      receiptDigest: Type.Union([hash, Type.Null()]),
      receiptRef: Type.Union([reference, Type.Null()]),
      exitCode: Type.Union([Type.Integer(), Type.Null()]),
      effects: Type.Union([Type.Literal("tool-only"), Type.Literal("unqualified")]),
      reasons: Type.Array(id(300), { maxItems: 8 }),
      artifactVersion: Type.Union([ReviewVersionSchema, Type.Null()]),
    },
    strict,
  ),
);
export const InvocationRootSealedSchema = Type.Unsafe<InvocationRootSealedV1>(
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("invocation-root-sealed"),
      recordId: id(100),
      owner: WorkOwnerSchema,
      rootId: id(100),
      endRef: reference,
      messageRef: reference,
      started: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
      ended: natural,
      historyDigest: hash,
      epoch: natural,
      artifactVersion: Type.Union([ReviewVersionSchema, Type.Null()]),
      outcome: Type.Union([
        Type.Literal("qualified"),
        Type.Literal("held"),
        Type.Literal("unknown"),
      ]),
      reason: id(1000),
    },
    strict,
  ),
);
export const EligibilityAttestedSchema = Type.Unsafe<EligibilityAttestedV1>(
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("eligibility-attested"),
      recordId: id(100),
      owner: advisorOwner,
      operationId: id(100),
      receiptId: id(300),
      receiptDigest: hash,
      rootSealRef: reference,
      taskId: id(100),
      taskDigest: hash,
      epoch: natural,
      artifactVersion: ReviewVersionSchema,
      justification: Type.Literal("parent-only-overlap-v1"),
    },
    strict,
  ),
);
export const InvocationFactSchema = Type.Union([
  InvocationStartedSchema,
  InvocationEndedSchema,
  InvocationRootSealedSchema,
  EligibilityAttestedSchema,
]);
export type InvocationFact =
  | InvocationStartedV1
  | InvocationEndedV1
  | InvocationRootSealedV1
  | EligibilityAttestedV1;
export interface InvocationFactView {
  entryId: string;
  digest: string;
  data: InvocationFact;
}
const intentEvidence = Type.Object(
  {
    ...CompletionEvidenceParams.properties,
    refs: Type.Array(Type.Object({ ...EvidenceRefParams.properties }, strict), {
      minItems: 1,
      maxItems: 20,
    }),
  },
  strict,
);
export const CompletionIntentSchema = Type.Unsafe<CompletionIntentV1>(
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("completion-intent-queued"),
      recordId: id(100),
      owner: advisorOwner,
      intentId: id(100),
      taskId: id(100),
      taskDigest: hash,
      operationId: id(100),
      rootId: id(100),
      snapshotRef: reference,
      evidence: intentEvidence,
      receipts: Type.Array(Type.Object({ id: id(300), digest: hash, ref: reference }, strict), {
        minItems: 1,
        maxItems: 20,
      }),
      candidateVersion: ReviewVersionSchema,
      queuedAt: natural,
    },
    strict,
  ),
);
export const CompletionDispositionSchema = Type.Unsafe<CompletionDispositionV1>(
  Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("completion-intent-disposed"),
      recordId: id(100),
      owner: advisorOwner,
      intentId: id(100),
      intentRef: reference,
      outcome: Type.Union([Type.Literal("applied"), Type.Literal("invalidated")]),
      snapshotRef: Type.Union([reference, Type.Null()]),
      taskDigest: Type.Union([hash, Type.Null()]),
      supervisorRef: Type.Union([reference, Type.Null()]),
      reason: id(1000),
    },
    strict,
  ),
);
export const CompletionFactSchema = Type.Union([
  CompletionIntentSchema,
  CompletionDispositionSchema,
]);
export type CompletionFact = CompletionIntentV1 | CompletionDispositionV1;
export type ControlFact =
  | CompletionFact
  | InvocationFact
  | ProgressFact
  | AdvisorFact
  | ExecutionFact
  | BoardRunSeedFact
  | FinalValidationFact
  | FinalValidationRegistrationFact
  | ReviewAttemptFact
  | SessionModeChangedV1;
export const ControlFenceSchema = Type.Object(
  {
    version: Type.Literal(6),
    protocol: Type.Literal(CONTROL_PROTOCOL),
    kind: Type.Literal("format-fence"),
    sessionId: id(200),
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    previousFence: Type.Union([
      Type.Null(),
      Type.Object({ entryId: id(200), digest: hash }, strict),
    ]),
    features: Type.Array(
      Type.Union([
        Type.Literal(CONTROL_FEATURES[0]),
        Type.Literal(CONTROL_FEATURES[1]),
        Type.Literal(CONTROL_FEATURES[2]),
        Type.Literal(CONTROL_FEATURES[3]),
        Type.Literal(CONTROL_FEATURES[4]),
        Type.Literal(CONTROL_FEATURES[5]),
        Type.Literal(CONTROL_FEATURES[6]),
        Type.Literal(CONTROL_FEATURES[7]),
      ]),
      { maxItems: CONTROL_FEATURES.length },
    ),
    owner: Type.Union([WorkOwnerSchema, Type.Null()]),
  },
  strict,
);
export type ControlFormatFenceV1 = Static<typeof ControlFenceSchema>;
export interface ControlFenceView {
  entryId: string;
  digest: string;
  data: ControlFormatFenceV1;
}
export interface ControlJournalView {
  latestFence?: ControlFenceView;
  acceptance?: AcceptanceJournalView;
  advisorFacts?: AdvisorFactView[];
  executionFacts?: ExecutionFactView[];
  executionRegistry?: ExecutionRegistryEntry[];
  boardSeeds?: BoardRunSeedView[];
  boardOwner?: WorkOwnerKey & { kind: "board" };
  finalValidations?: FinalValidationFactView[];
  finalValidationRegistrations?: FinalValidationRegistrationView[];
  reviewAttempts?: ReviewAttemptEntry[];
  modeRecords?: SessionModeView[];
  progressFacts?: ProgressFactView[];
  invocationFacts?: InvocationFactView[];
  invocations?: InvocationGraph;
  completionIntents?: Map<string, CompletionIntentEntry>;
  pendingHostCaptures?: Array<{
    entryId: string;
    digest: string;
    sessionId: string;
    goalKey: string;
    captureId: string;
  }>;
}
export class ControlJournalError extends Error {
  constructor(
    readonly code:
      | "CONTROL_FORMAT_INVALID"
      | "CONTROL_UNSUPPORTED_FEATURE"
      | "CONTROL_FACT_UNSUPPORTED"
      | "CONTROL_SOURCE_UNAVAILABLE"
      | "CONTROL_OWNER_CHANGED"
      | "CONTROL_SOURCE_CHANGED"
      | "CONTROL_JOURNAL_UNCERTAIN",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ControlJournalError";
  }
}
function fail(): never {
  throw new ControlJournalError("CONTROL_FORMAT_INVALID");
}
export function validAdvisorFact(value: unknown, sessionId: string): value is AdvisorFact {
  if (
    !Check(AdvisorFactSchema, value) ||
    Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 ||
    !validWorkOwner(value.owner) ||
    ownerSession(value.owner) !== sessionId
  )
    return false;
  if (value.kind === "advisor-call-started") return Number.isFinite(value.legacySubtotal.cost);
  return (
    value.usage.state !== "known" || Object.values(value.usage.values.cost).every(Number.isFinite)
  );
}
type AdvisorFold = {
  ids: Set<string>;
  calls: Map<
    string,
    {
      start: AdvisorFactView & { data: AdvisorStartedFact };
      observed?: AdvisorFactView & { data: AdvisorObservedFact };
      conflicted?: boolean;
    }
  >;
  owners: Map<string, { baseline: string; slot: number }>;
};
function createAdvisorFold(): AdvisorFold {
  return { ids: new Set(), calls: new Map(), owners: new Map() };
}
function addAdvisorResult(
  call: NonNullable<ReturnType<AdvisorFold["calls"]["get"]>>,
  view: AdvisorFactView & { data: AdvisorObservedFact | AdvisorConflictFact },
): void {
  const value = view.data;
  if (value.kind === "advisor-call-observed") {
    if (
      call.observed ||
      call.start.entryId !== value.startedRef.entryId ||
      call.start.digest !== value.startedRef.digest
    )
      fail();
    call.observed = { ...view, data: value };
  } else {
    if (
      !call.observed ||
      call.conflicted ||
      call.observed.entryId !== value.firstObservationRef.entryId ||
      call.observed.digest !== value.firstObservationRef.digest ||
      call.observed.data.outcomeDigest === value.outcomeDigest
    )
      fail();
    call.conflicted = true;
  }
}
function addAdvisorFact(fold: AdvisorFold, view: AdvisorFactView): void {
  const value = view.data;
  if (fold.ids.has(value.recordId)) fail();
  const call = fold.calls.get(value.callId);
  const key = journalDigest(value.owner);
  if (value.kind === "advisor-call-started") {
    const previous = fold.owners.get(key);
    const baseline = journalDigest(value.legacySubtotal);
    if (call || (previous && (previous.baseline !== baseline || previous.slot >= value.budgetSlot)))
      fail();
    fold.owners.set(key, { baseline, slot: value.budgetSlot });
    fold.calls.set(value.callId, { start: { ...view, data: value } });
  } else {
    if (!call || journalDigest(call.start.data.owner) !== key) fail();
    addAdvisorResult(call, { ...view, data: value });
  }
  fold.ids.add(value.recordId);
}
function assertAdvisorAddition(records: readonly AdvisorFactView[], data: AdvisorFact): void {
  const fold = createAdvisorFold();
  for (const record of records) addAdvisorFact(fold, record);
  addAdvisorFact(fold, { entryId: "candidate-not-a-receipt", digest: "", data });
}
export function executionOwnerSnapshot(
  data: unknown,
  owner: WorkOwnerKey | null,
): TaskBoardSnapshot | undefined {
  let body = data;
  if (owner?.kind === "goal" && owner.goal.goalRunId !== null) {
    if (
      !isGoalCarrier(data) ||
      data.goalRunId !== owner.goal.goalRunId ||
      data.lifecycleCommitId !== owner.goal.lifecycleCommitId
    )
      return undefined;
    body = data.snapshot;
  } else if (isGoalCarrier(data)) return undefined;
  return isValidSnapshotV2(body) ? body : undefined;
}
export function validExecutionFact(value: unknown, sessionId: string): value is ExecutionFact {
  return (
    Check(ExecutionFactSchema, value) &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024 &&
    validWorkOwner(value.owner) &&
    ownerSession(value.owner) === sessionId
  );
}
export interface ExecutionRegistryEntry {
  binding: ExecutionFactView & { data: ExecutionBindingFact };
  observation?: ExecutionFactView & { data: ExecutionObservedFact };
  settlement?: ExecutionFactView & { data: ExecutionSettledFact };
  resolution?: ExecutionFactView & { data: ExecutionResolutionFact };
  boundSnapshot?: { entryId: string; digest: string };
  releasedSnapshot?: { entryId: string; digest: string };
}
type ExecutionFoldBinding = ExecutionRegistryEntry;
interface ExecutionFold {
  ids: Set<string>;
  positions: ReadonlyMap<string, number>;
  snapshots: ReadonlyMap<string, ExecutionSnapshot[]>;
  boardSeeds: Map<string, BoardRunSeedView>;
  boardBoundaries: number[];
  bindings: Map<string, ExecutionFoldBinding>;
}
function createExecutionFold(journal: SessionJournal): ExecutionFold {
  return {
    ids: new Set(),
    positions: new Map(journal.branch.map((node, index) => [node.id, index])),
    snapshots: executionSnapshotIndex(journal),
    boardSeeds: new Map(),
    boardBoundaries: journal.branch.flatMap((node, position) =>
      node.customType === CUSTOM_EVENT_TYPE && isBoardReplacementEvent(node.data) ? [position] : [],
    ),
    bindings: new Map(),
  };
}
function bindingSnapshot(
  journal: SessionJournal,
  positions: ReadonlyMap<string, number>,
  data: ExecutionBindingFact,
  position: number,
): void {
  const source = journal.nodes.get(data.beforeSnapshotRef.entryId);
  const index = positions.get(data.beforeSnapshotRef.entryId) ?? -1;
  if (
    !source ||
    source.customType !== CUSTOM_SNAPSHOT_TYPE ||
    source.digest !== data.beforeSnapshotRef.digest ||
    index < 0 ||
    index >= position
  )
    fail();
  const board = executionOwnerSnapshot(source.data, data.owner);
  if (!board || journalDigest(board) !== data.beforeBoardDigest) fail();
  bindingTask(board, data);
}
function bindingTask(board: TaskBoardSnapshot, data: ExecutionBindingFact): void {
  const task = board.tasks.find((task) => task.id === data.taskId);
  if (!task || journalDigest(task) !== data.taskDigest) fail();
  if (
    data.imported &&
    (!task.executionRef ||
      journalDigest(task.executionRef) !== journalDigest(data.executionRef) ||
      data.beforeBoardDigest !== data.boundBoardDigest)
  )
    fail();
  if (!data.imported && task.executionRef) fail();
}
function executionObservationLink(
  binding: ExecutionFoldBinding,
  view: ExecutionFactView & { data: ExecutionObservedFact },
): void {
  const data = view.data;
  if (binding.observation || binding.settlement) fail();
  if (
    data.bindingRef.entryId !== binding.binding.entryId ||
    data.bindingRef.digest !== binding.binding.digest
  )
    fail();
  const observation = data.observation;
  if (["success", "failure", "cancelled"].includes(observation.outcome)) {
    if (
      observation.writerEvidence !== "observed" ||
      !observation.proofDigest ||
      !observation.generation ||
      !binding.binding.data.generation ||
      journalDigest(observation.generation) !== journalDigest(binding.binding.data.generation)
    )
      fail();
    binding.observation = view;
  }
}
function executionSettlementLink(
  binding: ExecutionFoldBinding,
  view: ExecutionFactView & { data: ExecutionSettledFact },
): void {
  const observation = binding.observation;
  if (
    binding.settlement ||
    !observation ||
    observation.entryId !== view.data.observationRef.entryId ||
    observation.digest !== view.data.observationRef.digest ||
    observation.data.bindingId !== view.data.bindingId ||
    observation.data.observation.outcome !== view.data.outcome
  )
    fail();
  binding.settlement = view;
}
function resolutionNode(
  journal: SessionJournal,
  fold: ExecutionFold,
  ref: { entryId: string; digest: string },
  before: number,
) {
  const node = journal.nodes.get(ref.entryId);
  const position = fold.positions.get(ref.entryId) ?? -1;
  if (!node || node.digest !== ref.digest || position < 0 || position >= before) fail();
  return { node, position };
}
function resolutionRelease(
  fold: ExecutionFold,
  binding: ExecutionFoldBinding,
  before: number,
): number {
  const settled = binding.settlement;
  if (!settled) fail();
  const position = fold.positions.get(settled.entryId) ?? -1;
  const ref = executionSnapshotAfter(
    fold.snapshots,
    settled.data.releasedBoardDigest,
    position,
    binding.binding.data.owner,
    binding.binding.data.taskId,
    true,
  );
  const released = ref ? (fold.positions.get(ref.entryId) ?? -1) : -1;
  if (released <= position || released >= before) fail();
  return released;
}
function matchingResolutionProofs(
  intent: JournalReceiptProof | undefined,
  result: JournalReceiptProof | undefined,
  owner: WorkOwnerKey,
): boolean {
  if (
    !intent ||
    !result ||
    owner.kind !== "goal" ||
    intent.kind !== "intent" ||
    result.kind !== "receipt"
  )
    return false;
  return (
    intent.sessionId === owner.goal.sessionId &&
    intent.goalId === owner.goal.goalKey &&
    result.sessionId === intent.sessionId &&
    result.goalId === intent.goalId &&
    result.sequence > intent.sequence &&
    intent.captureId === result.captureId &&
    intent.captureDigest === result.captureDigest
  );
}
function resolutionValidation(
  journal: SessionJournal,
  fold: ExecutionFold,
  data: ExecutionResolutionFact,
  index: number,
  task: TaskBoardSnapshot["tasks"][number],
  released: number,
  position: number,
): void {
  const source = data.validationSources[index];
  if (!source) fail();
  const start = resolutionNode(journal, fold, source.intentRef, position);
  const end = resolutionNode(journal, fold, source.receiptRef, position);
  if (
    start.position <= released ||
    end.position <= start.position ||
    start.node.customType !== RECEIPT_LEDGER_ENTRY ||
    end.node.customType !== RECEIPT_LEDGER_ENTRY
  )
    fail();
  if (!matchingResolutionProofs(start.node.receiptProof, end.node.receiptProof, data.owner)) fail();
  const receipt = end.node.receiptProof?.receipt;
  if (
    !receipt ||
    receipt.id !== data.validationRefs[index] ||
    !receipt.ok ||
    receipt.eligible === false ||
    receipt.exitCode !== 0 ||
    receipt.epoch !== data.mutationEpoch ||
    !receipt.reviews.some(
      (review) => review.taskId === task.id && review.digest === receiptDigest(task),
    )
  )
    fail();
}
function resolutionReplacement(
  fold: ExecutionFold,
  binding: ExecutionFoldBinding,
  data: ExecutionResolutionFact,
  before: number,
): number {
  const originalRelease = resolutionRelease(fold, binding, before);
  if (data.resolutionKind === "validated_repair") {
    if (data.supersedingBindingId) fail();
    return originalRelease;
  }
  const next = data.supersedingBindingId ? fold.bindings.get(data.supersedingBindingId) : undefined;
  if (!next?.settlement || next.settlement.data.outcome !== "success") fail();
  const previousSettlement = binding.settlement;
  if (!previousSettlement) fail();
  if (
    next.binding.data.taskId !== binding.binding.data.taskId ||
    journalDigest(next.binding.data.owner) !== journalDigest(data.owner) ||
    (fold.positions.get(next.binding.entryId) ?? -1) <=
      (fold.positions.get(previousSettlement.entryId) ?? -1)
  )
    fail();
  if (
    journalDigest(next.binding.data.executionRef) ===
      journalDigest(binding.binding.data.executionRef) &&
    journalDigest(next.binding.data.generation) === journalDigest(binding.binding.data.generation)
  )
    fail();
  return Math.max(originalRelease, resolutionRelease(fold, next, before));
}
function canonicalResolutionRefs(data: ExecutionResolutionFact): boolean {
  const refs = [...new Set(data.validationRefs)].sort();
  return (
    data.validationRefs.length === data.validationSources.length &&
    refs.length === data.validationRefs.length &&
    refs.every((ref, index) => ref === data.validationRefs[index])
  );
}
function executionResolutionLink(
  fold: ExecutionFold,
  binding: ExecutionFoldBinding,
  view: ExecutionFactView & { data: ExecutionResolutionFact },
  journal: SessionJournal,
  position: number,
): void {
  const data = view.data,
    settlement = binding.settlement;
  if (
    binding.resolution ||
    !settlement ||
    settlement.data.outcome === "success" ||
    settlement.entryId !== data.settlementRef.entryId ||
    settlement.digest !== data.settlementRef.digest
  )
    fail();
  const review = resolutionNode(journal, fold, data.reviewSnapshotRef, position);
  const board = executionOwnerSnapshot(review.node.data, data.owner),
    task = board?.tasks.find((task) => task.id === binding.binding.data.taskId);
  if (
    review.node.customType !== CUSTOM_SNAPSHOT_TYPE ||
    !task ||
    task.status !== "reviewing" ||
    task.executionRef ||
    journalDigest(task) !== data.taskDigest
  )
    fail();
  const released = resolutionReplacement(fold, binding, data, position);
  if (review.position < released || !canonicalResolutionRefs(data)) fail();
  data.validationRefs.forEach((_, index) => {
    resolutionValidation(journal, fold, data, index, task, released, position);
  });
  binding.resolution = view;
}
function validBoardRunSeed(value: unknown, sessionId: string): value is BoardRunSeedFact {
  return (
    Check(BoardRunSeedSchema, value) &&
    value.sessionId === sessionId &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
  );
}
function addBoardRunSeed(
  fold: ExecutionFold,
  view: BoardRunSeedView,
  journal: SessionJournal,
  position: number,
): void {
  const data = view.data,
    source = journal.nodes.get(data.snapshotRef.entryId);
  const sourcePosition = fold.positions.get(data.snapshotRef.entryId) ?? -1;
  const board = source ? executionOwnerSnapshot(source.data, null) : undefined;
  if (
    !source ||
    source.customType !== CUSTOM_SNAPSHOT_TYPE ||
    source.digest !== data.snapshotRef.digest ||
    sourcePosition < 0 ||
    sourcePosition >= position ||
    !board ||
    journalDigest(board) !== data.boardDigest
  )
    fail();
  if (
    [...fold.boardSeeds.values()].some(
      (seed) => seed.data.boardRunId === data.boardRunId || seed.data.recordId === data.recordId,
    )
  )
    fail();
  assertBoardSeedBoundary(fold, data, sourcePosition, position);
  fold.boardSeeds.set(view.entryId, view);
}
export function isBoardReplacementEvent(event: unknown): boolean {
  if (!event || typeof event !== "object" || !("type" in event)) return false;
  return (
    event.type === "clear_tasks" ||
    (event.type === "write_tasks" && "mode" in event && event.mode === "replace")
  );
}
function boardBoundaryBefore(fold: ExecutionFold, position: number): number {
  let left = 0,
    right = fold.boardBoundaries.length;
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if ((fold.boardBoundaries[middle] ?? Infinity) < position) left = middle + 1;
    else right = middle;
  }
  return fold.boardBoundaries[left - 1] ?? -1;
}
function assertBoardSeedBoundary(
  fold: ExecutionFold,
  data: BoardRunSeedFact,
  snapshotPosition: number,
  position: number,
): void {
  const boundary = boardBoundaryBefore(fold, position),
    previous = [...fold.boardSeeds.values()].at(-1);
  if (
    snapshotPosition <= boundary ||
    (previous && boundary <= (fold.positions.get(previous.entryId) ?? -1))
  )
    fail();
  const unresolved = deriveExecutionSnapshots(fold).some(
    (entry) =>
      ownerSession(entry.binding.data.owner) === data.sessionId &&
      (!entry.boundSnapshot ||
        !entry.settlement ||
        !entry.releasedSnapshot ||
        (fold.positions.get(entry.releasedSnapshot.entryId) ?? Infinity) >= boundary),
  );
  if (unresolved) fail();
}
function boardBindingOwner(fold: ExecutionFold, owner: WorkOwnerKey, position: number): void {
  if (owner.kind !== "board") return;
  const seed = fold.boardSeeds.get(owner.board.seedEntryId);
  if (
    !seed ||
    seed.data.sessionId !== owner.board.sessionId ||
    seed.data.boardRunId !== owner.board.boardRunId ||
    (fold.positions.get(seed.entryId) ?? -1) >= position
  )
    fail();
  if (boardBoundaryBefore(fold, position) > (fold.positions.get(seed.entryId) ?? -1)) fail();
}
function addExecutionFact(
  fold: ExecutionFold,
  view: ExecutionFactView,
  journal: SessionJournal,
  position: number,
): void {
  const data = view.data;
  if (fold.ids.has(data.recordId)) fail();
  fold.ids.add(data.recordId);
  if (data.kind === "execution-binding") {
    if (fold.bindings.has(data.bindingId)) fail();
    boardBindingOwner(fold, data.owner, position);
    bindingSnapshot(journal, fold.positions, data, position);
    fold.bindings.set(data.bindingId, { binding: { ...view, data } });
    return;
  }
  const binding = fold.bindings.get(data.bindingId);
  if (!binding || journalDigest(binding.binding.data.owner) !== journalDigest(data.owner)) fail();
  if (data.kind === "execution-observation") executionObservationLink(binding, { ...view, data });
  else if (data.kind === "execution-settlement")
    executionSettlementLink(binding, { ...view, data });
  else executionResolutionLink(fold, binding, { ...view, data }, journal, position);
}
interface ExecutionSnapshot {
  node: SessionJournal["branch"][number];
  position: number;
}
function executionSnapshotIndex(journal: SessionJournal): Map<string, ExecutionSnapshot[]> {
  const index = new Map<string, ExecutionSnapshot[]>();
  for (const [position, node] of journal.branch.entries()) {
    if (node.customType !== CUSTOM_SNAPSHOT_TYPE) continue;
    const body = isGoalCarrier(node.data) ? node.data.snapshot : node.data;
    if (!isValidSnapshotV2(body)) continue;
    const key = journalDigest(body);
    const entries = index.get(key) ?? [];
    entries.push({ node, position });
    index.set(key, entries);
  }
  return index;
}
function executionSnapshotAfter(
  index: ReadonlyMap<string, ExecutionSnapshot[]>,
  digest: string,
  position: number,
  owner: WorkOwnerKey,
  taskId: string,
  released: boolean,
): { entryId: string; digest: string } | undefined {
  const source = index.get(digest)?.find((entry) => {
    if (entry.position <= position) return false;
    const board = executionOwnerSnapshot(entry.node.data, owner);
    const task = board?.tasks.find((task) => task.id === taskId);
    return !!task && (!released || task.executionRef === undefined);
  });
  return source ? { entryId: source.node.id, digest: source.node.digest } : undefined;
}
function deriveExecutionSnapshots(fold: ExecutionFold): ExecutionRegistryEntry[] {
  if (!fold.bindings.size) return [];
  const index = fold.snapshots;
  return [...fold.bindings.values()].map((entry) => {
    const binding = entry.binding.data;
    const position = fold.positions.get(entry.binding.entryId) ?? -1;
    const boundSnapshot = binding.imported
      ? binding.beforeSnapshotRef
      : executionSnapshotAfter(
          index,
          binding.boundBoardDigest,
          position,
          binding.owner,
          binding.taskId,
          false,
        );
    const settlement = entry.settlement;
    const releasedSnapshot = settlement
      ? executionSnapshotAfter(
          index,
          settlement.data.releasedBoardDigest,
          fold.positions.get(settlement.entryId) ?? -1,
          binding.owner,
          binding.taskId,
          true,
        )
      : undefined;
    return { ...entry, boundSnapshot, releasedSnapshot };
  });
}
export function validWorkOwner(value: unknown): value is WorkOwnerKey {
  if (!Check(WorkOwnerSchema, value)) return false;
  if (value.kind === "board") return true;
  const goal = value.goal;
  return goal.goalRunId === null
    ? goal.lifecycleCommitId === null
    : goal.lifecycleCommitId !== null && goal.goalKey === goal.goalRunId;
}
export function ownerSession(owner: WorkOwnerKey): string {
  return owner.kind === "goal" ? owner.goal.sessionId : owner.board.sessionId;
}
export function validControlFence(value: unknown): value is ControlFormatFenceV1 {
  if (!Check(ControlFenceSchema, value) || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024)
    return false;
  if (
    value.owner !== null &&
    (!validWorkOwner(value.owner) || ownerSession(value.owner) !== value.sessionId)
  )
    return false;
  return value.features.every(
    (feature, index) => index === 0 || (value.features[index - 1] ?? "") < feature,
  );
}
export function isControlFenceEntry(entry: {
  type?: string;
  customType?: string;
  data?: unknown;
}): boolean {
  return (
    entry.type === "custom" &&
    entry.customType === CONTROL_FENCE_ENTRY &&
    entry.data !== null &&
    typeof entry.data === "object" &&
    "version" in entry.data &&
    entry.data.version === 6
  );
}
function assertFenceSuccessor(value: ControlFormatFenceV1, previous?: ControlFenceView): void {
  if (value.revision !== (previous?.data.revision ?? 0) + 1) fail();
  if (previous) {
    if (
      value.previousFence?.entryId !== previous.entryId ||
      value.previousFence.digest !== previous.digest ||
      previous.data.features.some((feature) => !value.features.includes(feature))
    )
      fail();
  } else if (value.previousFence !== null) fail();
  if (value.features.some((feature) => !supportedControlFeatures.has(feature)))
    throw new ControlJournalError("CONTROL_UNSUPPORTED_FEATURE");
}
/** Empty capability fencing is usable first; consumers add feature support with their own fold/tests. */
function validFinalValidation(value: unknown, sessionId: string): value is FinalValidationFact {
  return (
    Check(FinalValidationSchema, value) &&
    validWorkOwner(value.owner) &&
    value.owner.goal.sessionId === sessionId &&
    value.artifactVersion.inputCount + value.artifactVersion.artifactCount > 0 &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
  );
}
function validFinalValidationRegistration(
  value: unknown,
  sessionId: string,
): value is FinalValidationRegistrationFact {
  return (
    Check(FinalValidationRegistrationSchema, value) &&
    validWorkOwner(value.owner) &&
    value.owner.goal.sessionId === sessionId &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
  );
}
function registrationCheckpoint(
  data: FinalValidationRegistrationFact,
  proof: JournalSupervisorProof | undefined,
): boolean {
  return (
    !!proof &&
    proof.sessionId === data.owner.goal.sessionId &&
    proof.goalKey === data.owner.goal.goalKey &&
    (proof.lifecycleCommitId ?? null) === data.owner.goal.lifecycleCommitId &&
    ["active", "fault"].includes(proof.status) &&
    proof.epoch === data.epoch &&
    proof.bindingsDigest === data.bindingsDigest
  );
}
function registeredInputValid(data: FinalValidationRegistrationFact): boolean {
  if (/\[redacted\]|\(empty\)/i.test(data.inputJSON)) return false;
  try {
    const input: unknown = JSON.parse(data.inputJSON);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof Reflect.get(input, "command") !== "string" ||
      !Reflect.get(input, "command")
    )
      return false;
    return (
      JSON.stringify(input) === data.inputJSON &&
      redactedJSON(input) === data.inputJSON &&
      journalDigest(input) === data.inputDigest &&
      receiptDigest(data.inputJSON) === data.capturedInputDigest
    );
  } catch {
    return false;
  }
}
function registrationOriginalReceipt(
  data: FinalValidationRegistrationFact,
  task: TaskBoardSnapshot["tasks"][number],
  snapshotPosition: number,
  journal: SessionJournal,
  fold: ExecutionFold,
  position: number,
): void {
  const intent = resolutionNode(journal, fold, data.source.intentRef, position),
    result = resolutionNode(journal, fold, data.source.receiptRef, position);
  if (
    intent.position >= result.position ||
    result.position >= snapshotPosition ||
    !matchingResolutionProofs(intent.node.receiptProof, result.node.receiptProof, data.owner)
  )
    fail();
  const receipt = result.node.receiptProof?.receipt;
  if (
    !receipt ||
    !receipt.ok ||
    receipt.eligible === false ||
    receipt.exitCode !== 0 ||
    receipt.id !== data.originalReceiptId ||
    receipt.tool !== data.toolName ||
    result.node.receiptProof?.inputDigest !== data.capturedInputDigest
  )
    fail();
  if (
    !task.completionEvidence?.refs.some(
      (ref) =>
        ref.ref === data.originalReceiptId &&
        ref.kind === "command" &&
        ref.status === "passed" &&
        ref.exitCode === 0,
    )
  )
    fail();
}
function addFinalRegistration(
  records: FinalValidationRegistrationView[],
  view: FinalValidationRegistrationView,
  journal: SessionJournal,
  fold: ExecutionFold,
  position: number,
): void {
  const data = view.data;
  if (
    data.cwd !== journal.cwd ||
    data.cwd !== data.artifactVersion.workspace.root ||
    !registeredInputValid(data)
  )
    fail();
  if (
    records.some(
      (record) =>
        record.data.recordId === data.recordId ||
        record.data.registrationId === data.registrationId,
    )
  )
    fail();
  const snapshot = resolutionNode(journal, fold, data.snapshotRef, position),
    supervisor = resolutionNode(journal, fold, data.supervisorRef, position);
  const board = executionOwnerSnapshot(snapshot.node.data, data.owner),
    task = board?.tasks.find((task) => task.id === data.taskId);
  if (
    !board ||
    !task ||
    board.workflowStatus !== "completed" ||
    board.finalAcceptanceTaskId !== data.taskId ||
    board.tasks.some((task) => task.status !== "done" || task.executionRef)
  )
    fail();
  if (
    journalDigest(board) !== data.boardDigest ||
    receiptDigest(task) !== data.taskDigest ||
    !registrationCheckpoint(data, supervisor.node.supervisorProof)
  )
    fail();
  registrationOriginalReceipt(data, task, snapshot.position, journal, fold, position);
  records.push(view);
}
function finalValidationSource(
  data: FinalValidationFact,
  task: TaskBoardSnapshot["tasks"][number],
  snapshotPosition: number,
  journal: SessionJournal,
  fold: ExecutionFold,
  position: number,
): void {
  const start = resolutionNode(journal, fold, data.source.intentRef, position),
    end = resolutionNode(journal, fold, data.source.receiptRef, position);
  if (
    start.position <= snapshotPosition ||
    end.position <= start.position ||
    start.node.customType !== RECEIPT_LEDGER_ENTRY ||
    end.node.customType !== RECEIPT_LEDGER_ENTRY
  )
    fail();
  if (!matchingResolutionProofs(start.node.receiptProof, end.node.receiptProof, data.owner)) fail();
  finalValidationReceipt(data, task, end.node.receiptProof);
}
function finalValidationReceipt(
  data: FinalValidationFact,
  task: TaskBoardSnapshot["tasks"][number],
  proof: JournalReceiptProof | undefined,
): void {
  const receipt = proof?.receipt;
  if (
    !receipt ||
    !receipt.ok ||
    receipt.exitCode !== 0 ||
    receipt.eligible === false ||
    receipt.id !== data.receiptId ||
    receipt.epoch !== data.epoch
  )
    fail();
  if (
    receipt.tool !== data.toolName ||
    proof.inputDigest !== data.capturedInputDigest ||
    !receipt.reviews.some(
      (review) => review.taskId === data.taskId && review.digest === data.taskDigest,
    ) ||
    receiptDigest(task) !== data.taskDigest
  )
    fail();
}
function validationOnlySource(
  data: FinalValidationFact,
  registrations: readonly FinalValidationRegistrationView[],
  journal: SessionJournal,
  fold: ExecutionFold,
  position: number,
): void {
  const context = data.validationOnly;
  if (!context) return;
  const registration = registrations.find(
    (record) =>
      record.entryId === context.registrationRef.entryId &&
      record.digest === context.registrationRef.digest,
  );
  if (!registration) fail();
  const registered = registration.data,
    intent = resolutionNode(journal, fold, data.source.intentRef, position);
  if (
    intent.position <= (fold.positions.get(registration.entryId) ?? Infinity) ||
    journalDigest(registered.owner) !== journalDigest(data.owner)
  )
    fail();
  if (
    registered.boardDigest !== context.boardDigest ||
    registered.bindingsDigest !== context.bindingsDigest ||
    registered.epoch + 1 !== data.epoch
  )
    fail();
  const invocation = (value: FinalValidationRegistrationFact | FinalValidationFact) => [
    value.taskId,
    value.taskDigest,
    value.toolName,
    value.inputDigest,
    value.capturedInputDigest,
    value.snapshotRef,
    value.artifactVersion,
  ];
  if (journalDigest(invocation(registered)) !== journalDigest(invocation(data))) fail();
}
function addFinalValidation(
  records: FinalValidationFactView[],
  view: FinalValidationFactView,
  journal: SessionJournal,
  fold: ExecutionFold,
  position: number,
  registrations: readonly FinalValidationRegistrationView[] = [],
): void {
  const data = view.data;
  if (
    records.some(
      (record) =>
        record.data.recordId === data.recordId || record.data.validationId === data.validationId,
    )
  )
    fail();
  const snapshot = resolutionNode(journal, fold, data.snapshotRef, position);
  if (snapshot.node.customType !== CUSTOM_SNAPSHOT_TYPE) fail();
  const board = executionOwnerSnapshot(snapshot.node.data, data.owner),
    task = board?.tasks.find((task) => task.id === data.taskId);
  if (!task || !["reviewing", "done"].includes(task.status)) fail();
  finalValidationSource(data, task, snapshot.position, journal, fold, position);
  validationOnlySource(data, registrations, journal, fold, position);
  records.push(view);
}
function validReviewAttempt(value: unknown, sessionId: string): value is ReviewAttemptFact {
  return (
    Check(ReviewAttemptSchema, value) &&
    validWorkOwner(value.owner) &&
    value.owner.goal.sessionId === sessionId &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
  );
}
function matchingReviewCheckpoint(
  data: ReviewAttemptStartedFact,
  proof: JournalSupervisorProof | undefined,
): boolean {
  return (
    !!proof &&
    proof.sessionId === data.owner.goal.sessionId &&
    proof.goalKey === data.owner.goal.goalKey &&
    (proof.lifecycleCommitId ?? null) === data.owner.goal.lifecycleCommitId &&
    proof.status === "reviewing" &&
    proof.epoch === data.epoch &&
    proof.reviews === data.reviewNumber &&
    proof.bindingsDigest === data.bindingsDigest
  );
}
function reviewStartSources(
  fold: ControlFold,
  data: ReviewAttemptStartedFact,
  journal: SessionJournal,
  position: number,
): void {
  const snapshot = resolutionNode(journal, fold.execution, data.snapshotRef, position),
    source = resolutionNode(journal, fold.execution, data.supervisorRef, position);
  const base = resolutionNode(journal, fold.execution, data.baseLeafRef, position);
  if (
    base.position !== position - 1 ||
    source.node.customType !== CONTROL_FENCE_ENTRY ||
    snapshot.node.customType !== CUSTOM_SNAPSHOT_TYPE
  )
    fail();
  const board = executionOwnerSnapshot(snapshot.node.data, data.owner);
  if (
    !board ||
    board.workflowStatus !== "completed" ||
    board.tasks.some((task) => task.status !== "done" || task.executionRef) ||
    journalDigest(board) !== data.boardDigest
  )
    fail();
  if (!matchingReviewCheckpoint(data, source.node.supervisorProof)) fail();
}
function reviewValidationSource(
  fold: ControlFold,
  data: ReviewAttemptStartedFact,
  journal: SessionJournal,
  position: number,
): Pick<FinalValidationFact, "owner" | "epoch" | "artifactVersion"> | undefined {
  const record = fold.finalValidations.find(
    (item) =>
      item.entryId === data.validationRef.entryId && item.digest === data.validationRef.digest,
  );
  if (record) return record.data;
  const qualification = [...fold.invocations.qualifications.values()].find(
    (item) =>
      item.ref.entryId === data.validationRef.entryId &&
      item.ref.digest === data.validationRef.digest,
  );
  if (!qualification || qualification.data.owner.kind !== "goal") return undefined;
  const board = executionOwnerSnapshot(
      resolutionNode(journal, fold.execution, data.snapshotRef, position).node.data,
      data.owner,
    ),
    task = board?.tasks.find((item) => item.id === board.finalAcceptanceTaskId);
  if (
    !task ||
    task.id !== qualification.data.taskId ||
    !task.completionEvidence?.refs.some(
      (ref) => ref.status === "passed" && ref.ref === qualification.data.receiptId,
    )
  )
    fail();
  return {
    owner: qualification.data.owner,
    epoch: qualification.data.epoch,
    artifactVersion: qualification.data.artifactVersion,
  };
}
function addReviewStart(
  fold: ControlFold,
  view: ReviewAttemptFactView & { data: ReviewAttemptStartedFact },
  journal: SessionJournal,
  position: number,
): void {
  const data = view.data;
  if (
    fold.reviewAttempts.has(data.attemptId) ||
    data.deadlineAt <= data.startedAt ||
    data.deadlineAt - data.startedAt > 30000
  )
    fail();
  const validation = reviewValidationSource(fold, data, journal, position);
  if (
    !validation ||
    journalDigest(validation.owner) !== journalDigest(data.owner) ||
    validation.epoch !== data.epoch ||
    journalDigest(validation.artifactVersion) !== journalDigest(data.artifactVersion)
  )
    fail();
  reviewStartSources(fold, data, journal, position);
  fold.reviewAttempts.set(data.attemptId, { start: view });
}
function assertAcceptedReview(
  fold: ControlFold,
  data: ReviewAttemptObservedFact,
  start: ReviewAttemptStartedFact,
  calls: readonly AdvisorFactView[],
): void {
  if (data.outcome !== "accepted") return;
  const last = calls.at(-1);
  const returned =
    last && fold.advisor.calls.get(last.data.callId)?.observed?.data.status === "returned";
  if (
    data.failureClass !== "none" ||
    !returned ||
    data.epoch !== start.epoch ||
    data.observedAt > start.deadlineAt
  )
    fail();
}
function assertReviewCall(
  entries: readonly ReviewAttemptEntry[],
  facts: readonly AdvisorFactView[],
  call: AdvisorStartedFact,
): void {
  const entry = entries.find((entry) => entry.start.data.attemptId === call.attemptId);
  if (!entry) return;
  const start = entry.start.data;
  const prior = facts.filter(
    (record) =>
      record.data.kind === "advisor-call-started" && record.data.attemptId === call.attemptId,
  );
  if (entry.result || journalDigest(start.owner) !== journalDigest(call.owner) || prior.length >= 4)
    fail();
  if (
    call.startedAt < start.startedAt ||
    call.startedAt > start.deadlineAt ||
    (!prior.length && call.viewDigest !== start.firstCallViewDigest)
  )
    fail();
}
function addReviewOutcome(
  fold: ControlFold,
  view: ReviewAttemptFactView & { data: ReviewAttemptObservedFact },
  journal: SessionJournal,
  position: number,
): void {
  const data = view.data,
    entry = fold.reviewAttempts.get(data.attemptId);
  if (
    !entry ||
    entry.result ||
    journalDigest(entry.start.data.owner) !== journalDigest(data.owner) ||
    entry.start.entryId !== data.startedRef.entryId ||
    entry.start.digest !== data.startedRef.digest
  )
    fail();
  const end = resolutionNode(journal, fold.execution, data.endLeafRef, position);
  if (end.position !== position - 1 || data.observedAt < entry.start.data.startedAt) fail();
  const calls = fold.advisorFacts.filter(
    (record) =>
      record.data.kind === "advisor-call-started" &&
      record.data.attemptId === data.attemptId &&
      journalDigest(record.data.owner) === journalDigest(data.owner),
  );
  if (
    new Set(data.callIds).size !== data.callIds.length ||
    calls.length !== data.callIds.length ||
    calls.some((record) => !data.callIds.includes(record.data.callId))
  )
    fail();
  assertAcceptedReview(fold, data, entry.start.data, calls);
  entry.result = view;
}
function addReviewAttempt(
  fold: ControlFold,
  view: ReviewAttemptFactView,
  journal: SessionJournal,
  position: number,
): void {
  const data = view.data;
  if (fold.reviewRecordIds.has(data.recordId)) fail();
  fold.reviewRecordIds.add(data.recordId);
  if (data.kind === "review-attempt-started")
    addReviewStart(fold, { ...view, data }, journal, position);
  else addReviewOutcome(fold, { ...view, data }, journal, position);
}
interface ControlFold {
  acceptanceRecords?: JournalNode[];
  hostPending: Map<string, { entryId: string; digest: string; proof: JournalReceiptProof }>;
  modeRecords: SessionModeView[];
  progressFacts: ProgressFactView[];
  invocationFacts: InvocationFactView[];
  invocations: InvocationGraph;
  completionIntents: Map<string, CompletionIntentEntry>;
  finalValidations: FinalValidationFactView[];
  finalValidationRegistrations: FinalValidationRegistrationView[];
  reviewAttempts: Map<string, ReviewAttemptEntry>;
  reviewRecordIds: Set<string>;
  advisorFacts: AdvisorFactView[];
  executionFacts: ExecutionFactView[];
  advisor: AdvisorFold;
  execution: ExecutionFold;
}
function modeHostCaptureKey(proof: JournalReceiptProof): string {
  return JSON.stringify([proof.sessionId, proof.goalId, proof.captureId]);
}
function observeModeHostCapture(
  pending: ControlFold["hostPending"],
  node: SessionJournal["branch"][number],
): void {
  const proof = node.receiptProof;
  if (!proof) return;
  const key = modeHostCaptureKey(proof);
  if (proof.kind === "intent") pending.set(key, { entryId: node.id, digest: node.digest, proof });
  else if (pending.get(key)?.proof.captureDigest === proof.captureDigest) pending.delete(key);
}
function validSessionMode(value: unknown, sessionId: string): value is SessionModeChangedV1 {
  if (
    !Check(SessionModeSchema, value) ||
    value.sessionId !== sessionId ||
    Buffer.byteLength(JSON.stringify(value)) > 16 * 1024
  )
    return false;
  return [value.originOwner, value.activeWorkOwner].every(
    (owner) => owner === null || (validWorkOwner(owner) && ownerSession(owner) === sessionId),
  );
}
function modeGoalBirthKnown(
  goal: GoalOwnerKey,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): boolean {
  const birth = goal.lifecycleCommitId && journal.nodes.get(goal.lifecycleCommitId);
  return (
    !!birth &&
    (execution.positions.get(birth.id) ?? Infinity) < position &&
    isGoalRecord(birth.data) &&
    birth.data.kind === "transition-committed" &&
    birth.data.seed.goalRunId === goal.goalRunId &&
    birth.data.sessionId === goal.sessionId
  );
}
function assertModeOwner(
  owner: WorkOwnerKey | null,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (!owner) return;
  if (owner.kind === "board") {
    const seed = execution.boardSeeds.get(owner.board.seedEntryId);
    if (
      !seed ||
      seed.data.boardRunId !== owner.board.boardRunId ||
      (execution.positions.get(seed.entryId) ?? Infinity) >= position
    )
      fail();
    return;
  }
  const goal = owner.goal;
  if (modeGoalBirthKnown(goal, journal, execution, position)) return;
  const found = journal.branch.slice(0, position).some((node) => {
    const proof = node.supervisorProof;
    return (
      proof &&
      proof.sessionId === goal.sessionId &&
      proof.goalKey === goal.goalKey &&
      (proof.lifecycleCommitId ?? null) === goal.lifecycleCommitId
    );
  });
  if (!found) fail();
}
/** Semantic identity only; do not change existing wire/digest preimages. */
export function sameGoalOwner(left: GoalOwnerKey, right: GoalOwnerKey): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.goalKey === right.goalKey &&
    left.goalRunId === right.goalRunId &&
    left.lifecycleCommitId === right.lifecycleCommitId
  );
}
/** Native retained-owner source, not a label or the newest unrelated checkpoint. */
export function modeGoalSourceMatches(
  node: SessionJournal["branch"][number],
  owner: GoalOwnerKey,
): boolean {
  if (node.customType !== CONTROL_FENCE_ENTRY) return false;
  if (isGoalRecord(node.data)) {
    const record = node.data;
    if (record.sessionId !== owner.sessionId) return false;
    if (record.kind === "transition-committed")
      return node.id === owner.lifecycleCommitId && record.seed.goalRunId === owner.goalRunId;
    return (
      record.kind === "goal-state" &&
      record.scope.goalRunId === owner.goalRunId &&
      record.scope.lifecycleCommitId === owner.lifecycleCommitId
    );
  }
  const proof = node.supervisorProof;
  return (
    !!proof &&
    proof.sessionId === owner.sessionId &&
    proof.goalKey === owner.goalKey &&
    (proof.lifecycleCommitId ?? null) === owner.lifecycleCommitId
  );
}
function assertModeLastGoal(
  data: SessionModeChangedV1,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const last = data.lastGoal;
  if (!last) return;
  if (!last.owner) {
    if (last.sourceRef || last.acceptedRef || last.validity === "accepted") fail();
    return;
  }
  const owner: WorkOwnerKey = { kind: "goal", goal: last.owner };
  if (!validWorkOwner(owner) || ownerSession(owner) !== journal.sessionId) fail();
  assertModeOwner(owner, journal, execution, position);
  if (
    last.sourceRef &&
    !modeGoalSourceMatches(
      resolutionNode(journal, execution, last.sourceRef, position).node,
      last.owner,
    )
  )
    fail();
  if (last.acceptedRef) {
    const accepted = resolutionNode(journal, execution, last.acceptedRef, position).node.data;
    if (
      !Check(ReviewAttemptObservedSchema, accepted) ||
      accepted.outcome !== "accepted" ||
      !sameGoalOwner(accepted.owner.goal, last.owner)
    )
      fail();
  } else if (last.validity === "accepted") fail();
}
function assertModeQuiescence(
  data: SessionModeChangedV1,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
  pending: number,
  activeInvocations: number,
): void {
  if (data.mode !== "off" || data.state !== "active") return;
  if (
    data.activeWorkOwner !== null ||
    !data.hostIdle ||
    data.pendingMessages ||
    pending ||
    activeInvocations ||
    data.attention.some((item) => item.kind !== "business_failure")
  )
    fail();
  const unresolved = deriveExecutionSnapshots(execution).some((entry) => {
    if (ownerSession(entry.binding.data.owner) !== data.sessionId) return false;
    const refs = [entry.boundSnapshot, entry.settlement, entry.releasedSnapshot];
    return refs.some(
      (ref) => !ref || (execution.positions.get(ref.entryId) ?? Infinity) >= position,
    );
  });
  if (unresolved) fail();
  if (data.boardRef) {
    const source = resolutionNode(journal, execution, data.boardRef, position);
    const board = executionOwnerSnapshot(source.node.data, data.originOwner);
    if (
      !board ||
      board.tasks.some((task) => task.executionRef) ||
      (board.decision && board.decision.response !== "rejected")
    )
      fail();
  }
}
function assertInvocationModeOwner(data: SessionModeChangedV1, active: number): void {
  if (
    active &&
    (!data.originOwner ||
      !data.activeWorkOwner ||
      invocationOwnerKey(data.originOwner) !== invocationOwnerKey(data.activeWorkOwner))
  )
    fail();
}
function addSessionMode(
  records: SessionModeView[],
  view: SessionModeView,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
  pending: number,
  activeInvocations = 0,
): void {
  const data = view.data,
    previous = records.at(-1);
  assertInvocationModeOwner(data, activeInvocations);
  if (
    data.revision !== (previous?.data.revision ?? 0) + 1 ||
    records.some((record) => record.data.recordId === data.recordId)
  )
    fail();
  if (
    previous
      ? data.previousModeRecord?.entryId !== previous.entryId ||
        data.previousModeRecord.digest !== previous.digest
      : data.previousModeRecord !== null
  )
    fail();
  if (previous && journalDigest(data.originOwner) !== journalDigest(previous.data.activeWorkOwner))
    fail();
  assertModeOwner(data.originOwner, journal, execution, position);
  assertModeOwner(data.activeWorkOwner, journal, execution, position);
  assertModeLastGoal(data, journal, execution, position);
  if (data.mode === "tasks" && data.activeWorkOwner?.kind === "goal") fail();
  assertModeQuiescence(data, journal, execution, position, pending, activeInvocations);
  records.push(view);
}
function consumeReviewFact(
  node: SessionJournal["branch"][number],
  fence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
  position: number,
): boolean {
  if (validSessionMode(node.data, journal.sessionId)) {
    if (!fence?.data.features.includes("management-mode-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    addSessionMode(
      fold.modeRecords,
      { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
      journal,
      fold.execution,
      position,
      fold.hostPending.size,
      fold.invocations.active.size,
    );
    return true;
  }
  if (validFinalValidationRegistration(node.data, journal.sessionId)) {
    if (!fence?.data.features.includes("final-review-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    addFinalRegistration(
      fold.finalValidationRegistrations,
      { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
      journal,
      fold.execution,
      position,
    );
    return true;
  }
  if (validReviewAttempt(node.data, journal.sessionId)) {
    if (!fence?.data.features.includes("final-review-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    addReviewAttempt(
      fold,
      { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
      journal,
      position,
    );
    return true;
  }
  if (validFinalValidation(node.data, journal.sessionId)) {
    if (!fence?.data.features.includes("final-review-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    addFinalValidation(
      fold.finalValidations,
      { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
      journal,
      fold.execution,
      position,
      fold.finalValidationRegistrations,
    );
    return true;
  }
  return false;
}
export function validProgressFact(value: unknown, sessionId: string): value is ProgressFact {
  return (
    Check(ProgressFactSchema, value) &&
    validWorkOwner(value.owner) &&
    ownerSession(value.owner) === sessionId &&
    Buffer.byteLength(JSON.stringify(value)) <= 16384
  );
}
function ownProgress(
  records: readonly ProgressFactView[],
  owner: WorkOwnerKey,
): ProgressFactView[] {
  return records.filter((r) => progressOwnerKey(r.data.owner) === progressOwnerKey(owner));
}
export function creditedProgress(records: readonly ProgressFactView[]): ProgressFactView[] {
  const last = new Map<string, string>(),
    seen = new Set<string>();
  return records.filter((record) => {
    const fact = record.data;
    if (fact.kind !== "progress-observed") return false;
    const definition = `${progressOwnerKey(fact.owner)}/${fact.definitionId}`,
      previous = last.get(definition),
      key = progressKey(fact),
      novel = !seen.has(key);
    last.set(definition, fact.result);
    seen.add(key);
    return (
      novel &&
      (["changed", "formed"].includes(fact.result) ||
        (fact.result === "success" && previous === "failure"))
    );
  });
}
function progressDefinition(
  view: ProgressFactView,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const data = view.data;
  if (data.kind !== "progress-definition") fail();
  assertModeOwner(data.owner, journal, execution, position);
  const source = resolutionNode(journal, execution, data.boardRef, position);
  const board = executionOwnerSnapshot(source.node.data, data.owner),
    task = board?.tasks.find((t) => t.id === data.taskId);
  if (
    !task ||
    task.status !== "implementing" ||
    journalDigest(task) !== data.taskDigest ||
    data.baseline.workspace.root !== data.root
  )
    fail();
  validateProgressPolicy(data);
}
function validateDeclaredProgressPolicy(data: ProgressDefinition): void {
  if (
    data.baseline.scopeId !== `progress:${data.definitionId}` ||
    data.baseline.inputCount !== data.inputs.length ||
    data.baseline.artifactCount !== (data.absent ? 0 : data.artifacts.length) ||
    data.baseline.inputCount + data.baseline.artifactCount < 1
  )
    fail();
}
function validateProgressPolicy(data: ProgressDefinition): void {
  if (data.policy === "declared-v1") validateDeclaredProgressPolicy(data);
  if (
    data.policy === "git-visible-workspace-v1" &&
    (data.milestone !== "input_difference" ||
      data.inputs.length ||
      data.artifacts.length ||
      data.baseline.scopeId !== "git-visible-workspace-v1")
  )
    fail();
  if (data.milestone === "check" ? !data.check : data.check !== null) fail();
  if (data.milestone === "artifact" ? data.artifacts.length !== 1 : data.absent) fail();
}
function receiptProgressSource(
  data: ProgressObserved,
  definition: ProgressDefinition,
  source: SessionJournal["branch"][number],
) {
  const proof = source.receiptProof,
    receipt = proof?.receipt;
  if (
    !proof ||
    !receipt ||
    data.owner.kind !== "goal" ||
    proof.goalId !== data.owner.goal.goalKey ||
    proof.sessionId !== data.owner.goal.sessionId ||
    receipt.id !== data.receiptId ||
    receipt.digest !== data.receiptDigest ||
    receipt.eligible === false
  )
    fail();
  if (
    definition.check &&
    (receipt.tool !== definition.check.tool || proof.inputDigest !== definition.check.inputDigest)
  )
    fail();
  return { ok: receipt.ok, exitCode: receipt.exitCode };
}
function progressSource(
  data: ProgressObserved,
  definition: ProgressDefinition,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
) {
  const source = resolutionNode(journal, execution, data.sourceRef, position).node;
  if (data.sourceKind === "receipt") return receiptProgressSource(data, definition, source);
  const result = source.toolResultProof;
  if (!result || data.receiptId !== `tool:${result.id}` || data.receiptDigest !== source.digest)
    fail();
  const calls = journal.branch
    .slice(0, position)
    .flatMap((n) => n.toolCalls ?? [])
    .filter((c) => c.id === result.id);
  if (calls.length !== 1 || calls[0]?.name !== result.tool) fail();
  if (
    definition.check &&
    (definition.check.tool !== result.tool || definition.check.inputDigest !== calls[0].inputDigest)
  )
    fail();
  return result;
}
function progressObservation(
  records: readonly ProgressFactView[],
  view: ProgressFactView,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const data = view.data;
  if (data.kind !== "progress-observed") fail();
  const registration = records.find(
    (r) => r.entryId === data.definitionRef.entryId && r.digest === data.definitionRef.digest,
  );
  const definition = registration?.data;
  if (
    !definition ||
    definition.kind !== "progress-definition" ||
    definition.definitionId !== data.definitionId ||
    definition.taskId !== data.taskId ||
    progressOwnerKey(definition.owner) !== progressOwnerKey(data.owner)
  )
    fail();
  if (
    (execution.positions.get(data.sourceRef.entryId) ?? -1) <=
    (execution.positions.get(registration.entryId) ?? Infinity)
  )
    fail();
  const source = progressSource(data, definition, journal, execution, position);
  assertProgressWorkspace(data, definition);
  const sameScope =
    data.artifactVersion.scopeDigest === definition.baseline.scopeDigest &&
    data.artifactVersion.environmentDigest === definition.baseline.environmentDigest;
  const observed = records.flatMap((r) => (r.data.kind === "progress-observed" ? [r.data] : []));
  validateProgressRepetition(data, definition, observed, execution);
  validateProgressResult(data, definition, source, sameScope, records, observed);
}
function validateProgressRepetition(
  data: ProgressObserved,
  definition: ProgressDefinition,
  observed: readonly ProgressObserved[],
  execution: ExecutionFold,
): void {
  const previous = [...observed].reverse().find((f) => f.definitionId === data.definitionId);
  if (
    previous &&
    (execution.positions.get(data.sourceRef.entryId) ?? -1) <=
      (execution.positions.get(previous.sourceRef.entryId) ?? Infinity)
  )
    fail();
  if (
    observed.some((f) => progressKey(f) === progressKey(data)) &&
    (definition.milestone !== "check" || previous?.result === data.result)
  )
    fail();
}
function assertProgressWorkspace(data: ProgressObserved, definition: ProgressDefinition): void {
  const current = data.artifactVersion,
    baseline = definition.baseline;
  if (
    current.scopeId !== baseline.scopeId ||
    current.workspace.root !== baseline.workspace.root ||
    current.workspace.device !== baseline.workspace.device ||
    current.workspace.inode !== baseline.workspace.inode ||
    current.environmentDigest !== baseline.environmentDigest
  )
    fail();
  if (definition.policy === "declared-v1" && current.inputCount !== definition.inputs.length)
    fail();
}
function successfulProgressEffect(source: { ok: boolean; exitCode?: number }): boolean {
  return source.ok && (source.exitCode === undefined || source.exitCode === 0);
}
function validateProgressResult(
  data: ProgressObserved,
  definition: ProgressDefinition,
  source: { ok: boolean; exitCode?: number },
  sameScope: boolean,
  records: readonly ProgressFactView[],
  observed: readonly ProgressObserved[],
): void {
  if (definition.milestone === "input_difference") {
    if (
      !sameScope ||
      !successfulProgressEffect(source) ||
      data.result !== "changed" ||
      data.artifactVersion.versionId === definition.baseline.versionId
    )
      fail();
    if (progressVersionSeen(records, data.artifactVersion.versionId)) fail();
  } else if (definition.milestone === "artifact") {
    if (
      !definition.absent ||
      !successfulProgressEffect(source) ||
      data.result !== "formed" ||
      data.artifactVersion.artifactCount !== 1 ||
      observed.some((f) => f.definitionId === data.definitionId)
    )
      fail();
  } else validateCheckProgress(data, source, sameScope);
}
export function progressVersionSeen(
  records: readonly ProgressFactView[],
  versionId: string,
): boolean {
  return records.some((r) =>
    r.data.kind === "progress-definition"
      ? r.data.baseline.versionId === versionId
      : r.data.kind === "progress-observed" && r.data.artifactVersion.versionId === versionId,
  );
}
function validateCheckProgress(
  data: ProgressObserved,
  source: { ok: boolean; exitCode?: number },
  sameScope: boolean,
): void {
  if (
    !sameScope ||
    !["failure", "success"].includes(data.result) ||
    (data.result === "success"
      ? !source.ok || source.exitCode !== 0
      : source.ok && (source.exitCode === undefined || source.exitCode === 0))
  )
    fail();
}
function batchEvidenceKnown(
  data: BatchAdviceObserved,
  journal: SessionJournal,
  position: number,
): boolean {
  if (data.owner.kind !== "goal") return false;
  const owner = data.owner.goal;
  return data.advice.evidenceRefs.every((id) =>
    journal.branch
      .slice(0, position)
      .some(
        (node) =>
          node.receiptProof?.receipt?.id === id &&
          node.receiptProof.sessionId === owner.sessionId &&
          node.receiptProof.goalId === owner.goalKey,
      ),
  );
}
function batchProgressAdvice(
  data: BatchAdviceObserved,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const source = resolutionNode(journal, execution, data.callRef, position).node.data;
  const supervisor = resolutionNode(journal, execution, data.supervisorRef, position).node
    .supervisorProof;
  const board = executionOwnerSnapshot(
    resolutionNode(journal, execution, data.boardRef, position).node.data,
    data.owner,
  );
  if (
    !validAdvisorFact(source, journal.sessionId) ||
    source.kind !== "advisor-call-observed" ||
    source.status !== "returned" ||
    progressOwnerKey(source.owner) !== progressOwnerKey(data.owner)
  )
    fail();
  if (
    !supervisor ||
    supervisor.status !== "reviewing" ||
    supervisor.authorityDigest !== data.authorityDigest ||
    !board ||
    data.graphDigest !== taskGraphDigest(board) ||
    data.valid === batchActionMismatch(board, data.advice)
  )
    fail();
  if (
    data.advice.taskIds.some((id) => !board.tasks.some((t) => t.id === id)) ||
    Buffer.byteLength(JSON.stringify(data.advice)) > 8000 ||
    !batchEvidenceKnown(data, journal, position)
  )
    fail();
}
function addProgressFact(
  records: ProgressFactView[],
  view: ProgressFactView,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const data = view.data,
    own = ownProgress(records, data.owner);
  if (own.some((r) => r.data.recordId === view.data.recordId)) fail();
  if (data.kind === "progress-definition") {
    if (
      own.filter((r) => r.data.kind === "progress-definition").length >= 100 ||
      own.some(
        (r) => r.data.kind === "progress-definition" && r.data.definitionId === data.definitionId,
      )
    )
      fail();
    progressDefinition(view, journal, execution, position);
  } else if (data.kind === "progress-observed") {
    if (
      own.filter((r) => r.data.kind === "progress-observed").length >= 256 ||
      creditedProgress(own).length >= 128
    )
      fail();
    progressObservation(own, view, journal, execution, position);
  } else {
    if (own.filter((r) => r.data.kind === "batch-advice-observed").length >= 80) fail();
    batchProgressAdvice(data, journal, execution, position);
  }
  records.push(view);
}
function validateProgressAddition(
  view: ControlJournalView,
  value: ProgressFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (!view.latestFence?.data.features.includes("progress-facts-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (!lease.owner || progressOwnerKey(value.owner) !== progressOwnerKey(lease.owner))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const execution = createExecutionFold(journal);
  for (const seed of view.boardSeeds ?? []) execution.boardSeeds.set(seed.entryId, seed);
  addProgressFact(
    [...(view.progressFacts ?? [])],
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    journal,
    execution,
    journal.branch.length,
  );
}
export function validInvocationFact(value: unknown, sessionId: string): value is InvocationFact {
  return (
    Check(InvocationFactSchema, value) &&
    validWorkOwner(value.owner) &&
    ownerSession(value.owner) === sessionId &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
  );
}
function invocationModeMatches(
  owner: WorkOwnerKey,
  modeRef: InvocationStartedV1["modeRef"],
  modes: readonly SessionModeView[],
): boolean {
  const selected = modes.at(-1);
  return selected
    ? !!modeRef &&
        modeRef.entryId === selected.entryId &&
        modeRef.digest === selected.digest &&
        !!selected.data.activeWorkOwner &&
        invocationOwnerKey(selected.data.activeWorkOwner) === invocationOwnerKey(owner)
    : modeRef === null;
}
function invocationStartSource(
  data: InvocationStartedV1,
  graph: InvocationGraph,
  modes: readonly SessionModeView[],
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (!invocationModeMatches(data.owner, data.modeRef, modes)) fail();
  if (
    data.capability !== null &&
    (data.toolName !== "codemode" || data.effect !== "container" || data.parentId !== null)
  )
    fail();
  if (data.parentId !== null) {
    if (data.sourceRef !== null) fail();
    const parent = graph.nodes.get(data.parentId);
    if (!parent || journalDigest(parent.modeRef) !== journalDigest(data.modeRef)) fail();
    return;
  }
  assertModeOwner(data.owner, journal, execution, position);
  invocationRootCallSource(data, journal, execution, position);
}
function invocationRootCallSource(
  data: InvocationStartedV1,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (!data.sourceRef || journal.branch.slice(0, position).some((node) => node.toolCallsIncomplete))
    fail();
  const source = resolutionNode(journal, execution, data.sourceRef, position).node;
  const calls = journal.branch
    .slice(0, position)
    .flatMap((node) =>
      (node.toolCalls ?? [])
        .filter((call) => call.id === data.toolCallId)
        .map((call) => ({ node, call })),
    );
  if (
    calls.length !== 1 ||
    calls[0]?.node.id !== source.id ||
    calls[0].call.name !== data.toolName ||
    calls[0].call.inputDigest !== data.inputDigest
  )
    fail();
}
function invocationEndSource(
  data: InvocationEndedV1,
  graph: InvocationGraph,
  modes: readonly SessionModeView[],
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const node = graph.nodes.get(data.operationId);
  if (!node) fail();
  if (data.outcome === "returned" && !invocationModeMatches(data.owner, node.modeRef, modes))
    fail();
  if (!data.receiptRef) {
    if (
      data.receiptId !== null ||
      data.receiptDigest !== null ||
      (data.owner.kind === "goal" && node.effect !== "metadata" && data.outcome === "returned")
    )
      fail();
    return;
  }
  const source = resolutionNode(journal, execution, data.receiptRef, position).node.receiptProof;
  invocationReceiptSource(data, node, source);
}
function invocationReceiptSource(
  data: InvocationEndedV1,
  node: InvocationNodeV1,
  source: JournalReceiptProof | undefined,
): void {
  const receipt = source?.receipt;
  if (
    !source ||
    !receipt ||
    data.owner.kind !== "goal" ||
    source.sessionId !== data.owner.goal.sessionId ||
    source.goalId !== data.owner.goal.goalKey
  )
    fail();
  if (
    receipt.id !== `tool:${node.toolCallId}` ||
    receipt.id !== data.receiptId ||
    receipt.digest !== data.receiptDigest ||
    receipt.tool !== node.toolName ||
    (receipt.exitCode ?? null) !== data.exitCode ||
    (data.outcome === "returned" && !receipt.ok)
  )
    fail();
}
function invocationPendingCaptures(
  owner: WorkOwnerKey,
  journal: SessionJournal,
  position: number,
): number {
  if (owner.kind !== "goal") return 0;
  const pending = new Map<string, string>();
  for (const node of journal.branch.slice(0, position)) {
    const proof = node.receiptProof;
    if (!proof || proof.sessionId !== owner.goal.sessionId || proof.goalId !== owner.goal.goalKey)
      continue;
    if (proof.kind === "intent") pending.set(proof.captureId, proof.captureDigest);
    else if (pending.get(proof.captureId) === proof.captureDigest) pending.delete(proof.captureId);
  }
  return pending.size;
}
function invocationRegistryQuiet(
  owner: WorkOwnerKey,
  execution: ExecutionFold,
  position: number,
): boolean {
  return !deriveExecutionSnapshots(execution).some(
    (entry) =>
      invocationOwnerKey(entry.binding.data.owner) === invocationOwnerKey(owner) &&
      // Writer closure is separate from business failure handling; task completion still requires resolution.
      [entry.boundSnapshot, entry.settlement, entry.releasedSnapshot].some(
        (ref) => !ref || (execution.positions.get(ref.entryId) ?? Infinity) >= position,
      ),
  );
}
function invocationSealEpoch(
  data: InvocationRootSealedV1,
  journal: SessionJournal,
  position: number,
): void {
  if (data.owner.kind !== "goal") return;
  const owner = data.owner.goal;
  const last = [...journal.branch.slice(0, position)]
    .reverse()
    .find(
      (node) =>
        node.receiptProof?.sessionId === owner.sessionId &&
        node.receiptProof.goalId === owner.goalKey,
    )?.receiptProof;
  if (
    !last ||
    last.ledgerEpoch !== data.epoch ||
    invocationPendingCaptures(data.owner, journal, position)
  )
    fail();
}
function invocationSealSource(
  data: InvocationRootSealedV1,
  graph: InvocationGraph,
  modes: readonly SessionModeView[],
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const root = graph.nodes.get(data.rootId);
  if (!root?.end) fail();
  const source = resolutionNode(journal, execution, data.messageRef, position),
    proof = source.node.toolResultProof;
  const ended = execution.positions.get(root.end.ref.entryId) ?? Infinity;
  if (
    source.position <= ended ||
    !proof ||
    proof.id !== root.toolCallId ||
    proof.tool !== root.toolName
  )
    fail();
  if (data.outcome !== "qualified") return;
  if (
    !proof.ok ||
    !invocationModeMatches(data.owner, root.modeRef, modes) ||
    !data.artifactVersion ||
    data.artifactVersion.inputCount + data.artifactVersion.artifactCount < 1 ||
    !invocationRegistryQuiet(data.owner, execution, position)
  )
    fail();
  invocationSealEpoch(data, journal, position);
}
function invocationCurrentTask(
  owner: WorkOwnerKey,
  taskId: string,
  journal: SessionJournal,
  position: number,
) {
  for (const node of [...journal.branch.slice(0, position)].reverse()) {
    if (node.customType !== CUSTOM_SNAPSHOT_TYPE) continue;
    const board = executionOwnerSnapshot(node.data, owner);
    if (board) return board.tasks.find((task) => task.id === taskId);
  }
  return undefined;
}
function invocationSupervisorActive(
  owner: WorkOwnerKey,
  journal: SessionJournal,
  position: number,
): boolean {
  if (owner.kind !== "goal") return false;
  const goal = owner.goal;
  const source = [...journal.branch.slice(0, position)]
    .reverse()
    .find(
      (node) =>
        node.supervisorProof?.sessionId === goal.sessionId &&
        node.supervisorProof.goalKey === goal.goalKey,
    )?.supervisorProof;
  return source?.status === "active";
}
function invocationAttestationReceipt(
  data: EligibilityAttestedV1,
  node: InvocationNodeV1,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (!node.end?.receiptRef) fail();
  const proof = resolutionNode(journal, execution, node.end.receiptRef, position).node.receiptProof;
  if (
    !proof?.receipt ||
    data.owner.kind !== "goal" ||
    proof.goalId !== data.owner.goal.goalKey ||
    proof.sessionId !== data.owner.goal.sessionId
  )
    fail();
  const receipt = proof.receipt;
  if (
    !receipt.ok ||
    receipt.exitCode !== 0 ||
    receipt.eligible !== false ||
    receipt.id !== data.receiptId ||
    receipt.digest !== data.receiptDigest ||
    !receipt.reviews.some(
      (review) => review.taskId === data.taskId && review.digest === data.taskDigest,
    )
  )
    fail();
}
function invocationAttestationSource(
  data: EligibilityAttestedV1,
  graph: InvocationGraph,
  modes: readonly SessionModeView[],
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const node = graph.nodes.get(data.operationId),
    task = invocationCurrentTask(data.owner, data.taskId, journal, position);
  if (
    !node ||
    !invocationModeMatches(data.owner, node.modeRef, modes) ||
    !task ||
    task.status !== "reviewing" ||
    receiptDigest(task) !== data.taskDigest
  )
    fail();
  const seal = graph.seals.get(node.rootId);
  if (
    !seal ||
    (execution.positions.get(seal.ref.entryId) ?? Infinity) >= position ||
    !invocationSupervisorActive(data.owner, journal, position) ||
    !invocationRegistryQuiet(data.owner, execution, position)
  )
    fail();
  invocationSealEpoch(seal.data, journal, position);
  invocationAttestationReceipt(data, node, journal, execution, position);
}
function addInvocationFact(
  facts: InvocationFactView[],
  graph: InvocationGraph,
  view: InvocationFactView,
  modes: readonly SessionModeView[],
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const data = view.data,
    ref = { entryId: view.entryId, digest: view.digest };
  if (data.kind === "invocation-started") {
    invocationStartSource(data, graph, modes, journal, execution, position);
    admitInvocation(graph, data, ref);
  } else if (data.kind === "invocation-ended") {
    invocationEndSource(data, graph, modes, journal, execution, position);
    observeInvocationEnd(graph, data, ref);
  } else if (data.kind === "invocation-root-sealed") {
    invocationSealSource(data, graph, modes, journal, execution, position);
    sealInvocationRoot(graph, data, ref);
  } else {
    invocationAttestationSource(data, graph, modes, journal, execution, position);
    attestInvocation(graph, data, ref);
  }
  facts.push(view);
}
// One candidate addition only mutates collection membership, one node.end and its root aggregate.
// Keep retained owner/receipt/version payloads shared read-only instead of deep-copying all history.
function invocationAdditionGraph(graph: InvocationGraph, value: InvocationFact): InvocationGraph {
  const copy: InvocationGraph = {
    ...graph,
    records: new Set(graph.records),
    nodes: new Map(graph.nodes),
    calls: new Map(graph.calls),
    active: new Set(graph.active),
    roots: new Map(graph.roots),
    seals: new Map(graph.seals),
    qualifications: new Map(graph.qualifications),
  };
  const node = "operationId" in value ? graph.nodes.get(value.operationId) : undefined;
  if (node) copy.nodes.set(node.operationId, { ...node });
  const rootId = "rootId" in value ? value.rootId : node?.rootId;
  const root = rootId ? graph.roots.get(rootId) : undefined;
  if (root && rootId) copy.roots.set(rootId, { ...root });
  return copy;
}
function validateInvocationAddition(
  view: ControlJournalView,
  value: InvocationFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (!view.latestFence?.data.features.includes("invocation-tree-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (!lease.owner || invocationOwnerKey(value.owner) !== invocationOwnerKey(lease.owner))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const execution = createExecutionFold(journal);
  for (const seed of view.boardSeeds ?? []) execution.boardSeeds.set(seed.entryId, seed);
  addInvocationFact(
    [],
    invocationAdditionGraph(view.invocations ?? emptyInvocationGraph(), value),
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    view.modeRecords ?? [],
    journal,
    execution,
    journal.branch.length,
  );
}
export function validCompletionFact(value: unknown, sessionId: string): value is CompletionFact {
  return (
    Check(CompletionFactSchema, value) &&
    validWorkOwner(value.owner) &&
    ownerSession(value.owner) === sessionId &&
    Buffer.byteLength(JSON.stringify(value)) <= 16 * 1024
  );
}
function completionReceiptOwner(data: CompletionIntentV1, proof: JournalReceiptProof | undefined) {
  const receipt = proof?.receipt;
  if (
    !proof ||
    !receipt ||
    data.owner.kind !== "goal" ||
    proof.goalId !== data.owner.goal.goalKey ||
    proof.sessionId !== data.owner.goal.sessionId
  )
    fail();
  return receipt;
}
function completionReceiptSources(
  data: CompletionIntentV1,
  graph: InvocationGraph,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  const passed = data.evidence.refs.filter((ref) => ref.status === "passed");
  if (
    !passed.some((ref) => ref.kind === "command" && ref.exitCode === 0) ||
    journalDigest(passed.map((ref) => ref.ref)) !==
      journalDigest(data.receipts.map((ref) => ref.id))
  )
    fail();
  for (const source of data.receipts) {
    const proof = resolutionNode(journal, execution, source.ref, position).node.receiptProof;
    const receipt = completionReceiptOwner(data, proof);
    if (
      !receipt.ok ||
      receipt.exitCode !== 0 ||
      receipt.id !== source.id ||
      receipt.digest !== source.digest ||
      !receipt.reviews.some(
        (review) => review.taskId === data.taskId && review.digest === data.taskDigest,
      )
    )
      fail();
    const node = [...graph.nodes.values()].find(
      (item) => item.rootId === data.rootId && item.end?.receiptId === receipt.id,
    );
    if (
      !node?.end ||
      journalDigest(node.end.artifactVersion) !== journalDigest(data.candidateVersion)
    )
      fail();
  }
}
function completionQueuedSource(
  data: CompletionIntentV1,
  entries: Map<string, CompletionIntentEntry>,
  graph: InvocationGraph,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (
    entries.has(data.intentId) ||
    [...entries.values()].filter((entry) => !entry.disposition).length >= 100 ||
    [...entries.values()].some(
      (entry) =>
        !entry.disposition &&
        entry.data.taskId === data.taskId &&
        invocationOwnerKey(entry.data.owner) === invocationOwnerKey(data.owner),
    )
  )
    fail();
  const invocation = graph.nodes.get(data.operationId);
  if (
    !invocation ||
    invocation.parentId === null ||
    invocation.toolName !== "advance_tasks" ||
    invocation.rootId !== data.rootId ||
    !graph.active.has(invocation.operationId) ||
    invocationOwnerKey(invocation.owner) !== invocationOwnerKey(data.owner)
  )
    fail();
  const snapshot = resolutionNode(journal, execution, data.snapshotRef, position),
    board = executionOwnerSnapshot(snapshot.node.data, data.owner),
    task = board?.tasks.find((item) => item.id === data.taskId);
  if (
    !task ||
    task.status !== "reviewing" ||
    receiptDigest(task) !== data.taskDigest ||
    completionEvidenceError(data.evidence)
  )
    fail();
  completionReceiptSources(data, graph, journal, execution, position);
}
function completionDoneSnapshot(
  data: CompletionDispositionV1,
  entry: CompletionIntentEntry,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): number {
  if (!data.snapshotRef || !data.taskDigest) fail();
  const snapshot = resolutionNode(journal, execution, data.snapshotRef, position),
    task = executionOwnerSnapshot(snapshot.node.data, data.owner)?.tasks.find(
      (item) => item.id === entry.data.taskId,
    );
  const before = executionOwnerSnapshot(
    resolutionNode(journal, execution, entry.data.snapshotRef, position).node.data,
    data.owner,
  )?.tasks.find((item) => item.id === entry.data.taskId);
  if (
    !task ||
    !before ||
    task.status !== "done" ||
    receiptDigest(task) !== data.taskDigest ||
    journalDigest({
      ...before,
      status: "done",
      completionEvidence: entry.data.evidence,
      updatedAt: task.updatedAt,
    }) !== journalDigest(task)
  )
    fail();
  return snapshot.position;
}
function completionBindingOwner(
  proof: JournalSupervisorProof | undefined,
  owner: WorkOwnerKey,
): boolean {
  return (
    !!proof &&
    owner.kind === "goal" &&
    proof.sessionId === owner.goal.sessionId &&
    proof.goalKey === owner.goal.goalKey &&
    (proof.lifecycleCommitId ?? null) === owner.goal.lifecycleCommitId
  );
}
function completionAppliedSource(
  data: CompletionDispositionV1,
  entry: CompletionIntentEntry,
  graph: InvocationGraph,
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (!data.snapshotRef || !data.taskDigest || !data.supervisorRef) fail();
  const snapshotPosition = completionDoneSnapshot(data, entry, journal, execution, position);
  for (const source of entry.data.receipts) {
    const qualified = graph.qualifications.get(
      qualificationKey(data.owner, source.id, entry.data.taskId),
    );
    const node = qualified && graph.nodes.get(qualified.data.operationId);
    if (
      !qualified ||
      node?.rootId !== entry.data.rootId ||
      qualified.data.taskDigest !== entry.data.taskDigest
    )
      fail();
  }
  const supervisor = resolutionNode(journal, execution, data.supervisorRef, position),
    proof = supervisor.node.supervisorProof;
  const refsDigest = receiptDigest(
    entry.data.evidence.refs
      .filter((ref) => ref.status === "passed")
      .flatMap((ref) => (ref.ref ? [ref.ref] : [])),
  );
  if (
    supervisor.position <= snapshotPosition ||
    !completionBindingOwner(proof, data.owner) ||
    !proof?.taskBindings?.some(
      (binding) =>
        binding.taskId === entry.data.taskId &&
        binding.digest === data.taskDigest &&
        binding.refsDigest === refsDigest,
    )
  )
    fail();
}
function addCompletionFact(
  entries: Map<string, CompletionIntentEntry>,
  graph: InvocationGraph,
  data: CompletionFact,
  ref: { entryId: string; digest: string },
  journal: SessionJournal,
  execution: ExecutionFold,
  position: number,
): void {
  if (
    [...entries.values()].some(
      (entry) =>
        entry.data.recordId === data.recordId || entry.disposition?.data.recordId === data.recordId,
    )
  )
    fail();
  if (data.kind === "completion-intent-queued") {
    completionQueuedSource(data, entries, graph, journal, execution, position);
    entries.set(data.intentId, { data, ref });
    return;
  }
  const entry = entries.get(data.intentId);
  if (
    !entry ||
    entry.disposition ||
    journalDigest(entry.ref) !== journalDigest(data.intentRef) ||
    invocationOwnerKey(entry.data.owner) !== invocationOwnerKey(data.owner)
  )
    fail();
  if (data.outcome === "applied")
    completionAppliedSource(data, entry, graph, journal, execution, position);
  else if (data.snapshotRef !== null || data.taskDigest !== null || data.supervisorRef !== null)
    fail();
  entry.disposition = { data, ref };
}
function validateCompletionAddition(
  view: ControlJournalView,
  value: CompletionFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (
    !view.latestFence?.data.features.includes("completion-intents-v1") ||
    !view.latestFence.data.features.includes("invocation-tree-v1")
  )
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (!lease.owner || invocationOwnerKey(value.owner) !== invocationOwnerKey(lease.owner))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const execution = createExecutionFold(journal);
  for (const seed of view.boardSeeds ?? []) execution.boardSeeds.set(seed.entryId, seed);
  addCompletionFact(
    structuredClone(view.completionIntents ?? new Map<string, CompletionIntentEntry>()),
    view.invocations ?? emptyInvocationGraph(),
    value,
    { entryId: "candidate-not-a-receipt", digest: "" },
    journal,
    execution,
    journal.branch.length,
  );
}
function consumeCompletionFact(
  node: SessionJournal["branch"][number],
  fence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
  position: number,
): boolean {
  if (!validCompletionFact(node.data, journal.sessionId)) return false;
  if (
    !fence?.data.features.includes("completion-intents-v1") ||
    !fence.data.features.includes("invocation-tree-v1")
  )
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  addCompletionFact(
    fold.completionIntents,
    fold.invocations,
    structuredClone(node.data),
    { entryId: node.id, digest: node.digest },
    journal,
    fold.execution,
    position,
  );
  return true;
}
function consumeInvocationFact(
  node: SessionJournal["branch"][number],
  fence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
  position: number,
): boolean {
  if (!validInvocationFact(node.data, journal.sessionId)) return false;
  if (!fence?.data.features.includes("invocation-tree-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  addInvocationFact(
    fold.invocationFacts,
    fold.invocations,
    { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
    fold.modeRecords,
    journal,
    fold.execution,
    position,
  );
  return true;
}
function consumeProgressFact(
  node: SessionJournal["branch"][number],
  fence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
  position: number,
): boolean {
  if (!validProgressFact(node.data, journal.sessionId)) return false;
  if (!fence?.data.features.includes("progress-facts-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  addProgressFact(
    fold.progressFacts,
    { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
    journal,
    fold.execution,
    position,
  );
  return true;
}
function consumeBoardSeed(
  node: SessionJournal["branch"][number],
  fence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
  position: number,
): boolean {
  if (!validBoardRunSeed(node.data, journal.sessionId)) return false;
  if (!fence?.data.features.includes("execution-settlement-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  addBoardRunSeed(
    fold.execution,
    { entryId: node.id, digest: node.digest, data: structuredClone(node.data) },
    journal,
    position,
  );
  return true;
}
function consumeControlFact(
  node: SessionJournal["branch"][number],
  fence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
  position: number,
): void {
  if (consumeCompletionFact(node, fence, fold, journal, position)) return;
  if (consumeInvocationFact(node, fence, fold, journal, position)) return;
  if (consumeProgressFact(node, fence, fold, journal, position)) return;
  if (consumeReviewFact(node, fence, fold, journal, position)) return;
  if (consumeBoardSeed(node, fence, fold, journal, position)) return;
  if (validAdvisorFact(node.data, journal.sessionId)) {
    if (node.data.kind === "advisor-call-started")
      assertReviewCall([...fold.reviewAttempts.values()], fold.advisorFacts, node.data);
    if (!fence?.data.features.includes("advisor-accounting-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    const view = { entryId: node.id, digest: node.digest, data: structuredClone(node.data) };
    addAdvisorFact(fold.advisor, view);
    fold.advisorFacts.push(view);
    return;
  }
  if (
    !validExecutionFact(node.data, journal.sessionId) ||
    !fence?.data.features.includes("execution-settlement-v1")
  )
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  const view = { entryId: node.id, digest: node.digest, data: structuredClone(node.data) };
  addExecutionFact(fold.execution, view, journal, position);
  fold.executionFacts.push(view);
}
function newControlFold(journal: SessionJournal): ControlFold {
  return {
    advisorFacts: [],
    executionFacts: [],
    hostPending: new Map(),
    modeRecords: [],
    progressFacts: [],
    invocationFacts: [],
    invocations: emptyInvocationGraph(),
    completionIntents: new Map(),
    finalValidations: [],
    finalValidationRegistrations: [],
    reviewAttempts: new Map(),
    reviewRecordIds: new Set(),
    advisor: createAdvisorFold(),
    execution: createExecutionFold(journal),
  };
}
interface CachedControlFold {
  runtime: ReturnType<typeof currentRuntime>;
  sessionId: string;
  path: string | undefined;
  cwd: string | undefined;
  nodes: [string, string][];
  branch: string[];
  fold: ControlFold;
  latestFence?: ControlFenceView;
}
const controlFoldCache = new WeakMap<ExtensionContext["sessionManager"], CachedControlFold>();
let foldedControlNodes = 0,
  controlFoldHits = 0;
/** Derived-read diagnostics only; never approval, freshness, quiescence or receipt evidence. */
export function controlReadStats() {
  return { foldedNodes: foldedControlNodes, hits: controlFoldHits };
}
function consumeAcceptanceNode(
  node: JournalNode,
  latestFence: ControlFenceView | undefined,
  fold: ControlFold,
  journal: SessionJournal,
): boolean {
  if (node.customType !== ACCEPTANCE_FACT_ENTRY && !isAcceptanceWitness(node, journal))
    return false;
  if (!latestFence?.data.features.includes("acceptance-contract-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  (fold.acceptanceRecords ??= []).push(node);
  return true;
}
function acceptanceProjection(
  journal: SessionJournal,
  fold: ControlFold,
): Pick<ControlJournalView, "acceptance"> {
  return fold.acceptanceRecords?.length
    ? { acceptance: readAcceptanceFacts(journal, fold.acceptanceRecords, fold.invocations) }
    : {};
}
function foldControlJournal(journal: SessionJournal, prior?: CachedControlFold) {
  let latestFence = prior?.latestFence;
  const fold = prior?.fold ?? newControlFold(journal);
  if (prior) {
    const sources = createExecutionFold(journal);
    fold.execution.positions = sources.positions;
    fold.execution.snapshots = sources.snapshots;
    fold.execution.boardBoundaries = sources.boardBoundaries;
  }
  const start = prior?.branch.length ?? 0;
  for (const [offset, node] of journal.branch.slice(start).entries()) {
    const position = start + offset;
    foldedControlNodes = Math.min(Number.MAX_SAFE_INTEGER, foldedControlNodes + 1);
    observeModeHostCapture(fold.hostPending, node);
    if (consumeAcceptanceNode(node, latestFence, fold, journal)) continue;
    if (node.customType === CONTROL_FACT_ENTRY) {
      consumeControlFact(node, latestFence, fold, journal, position);
      continue;
    }
    if (node.customType !== CONTROL_FENCE_ENTRY || node.wireVersion !== 6) continue;
    if (!validControlFence(node.data) || node.data.sessionId !== journal.sessionId) fail();
    const value = node.data;
    assertFenceSuccessor(value, latestFence);
    latestFence = { entryId: node.id, digest: node.digest, data: structuredClone(value) };
  }
  const registry = deriveExecutionSnapshots(fold.execution);
  const view: ControlJournalView = {
    latestFence,
    ...acceptanceProjection(journal, fold),
    advisorFacts: fold.advisorFacts,
    executionFacts: fold.executionFacts,
    executionRegistry: registry,
    finalValidations: fold.finalValidations,
    finalValidationRegistrations: fold.finalValidationRegistrations,
    reviewAttempts: [...fold.reviewAttempts.values()],
    modeRecords: fold.modeRecords,
    progressFacts: fold.progressFacts,
    invocationFacts: fold.invocationFacts,
    invocations: fold.invocations,
    completionIntents: fold.completionIntents,
    pendingHostCaptures: [...fold.hostPending.values()].map((item) => ({
      entryId: item.entryId,
      digest: item.digest,
      sessionId: item.proof.sessionId,
      goalKey: item.proof.goalId,
      captureId: item.proof.captureId,
    })),
    boardSeeds: [...fold.execution.boardSeeds.values()],
    boardOwner: selectedBoardOwner(fold.execution, registry, journal.branch.length),
  };
  return { view, fold, latestFence };
}
export function readControlFences(journal: SessionJournal): ControlJournalView {
  return foldControlJournal(journal).view;
}
function reusableControlFold(
  ctx: ExtensionContext,
  journal: SessionJournal,
  cached: CachedControlFold,
): boolean {
  return (
    cached.runtime === currentRuntime() &&
    cached.sessionId === journal.sessionId &&
    cached.cwd === journal.cwd &&
    cached.path === ctx.sessionManager.getSessionFile() &&
    cached.branch.length <= journal.branch.length &&
    cached.branch.every((id, index) => journal.branch[index]?.id === id) &&
    cached.nodes.every(([id, digest]) => journal.nodes.get(id)?.digest === digest)
  );
}
function verifiedControlView(
  ctx: ExtensionContext,
  journal: SessionJournal,
  isolate = true,
): ControlJournalView {
  const cached = controlFoldCache.get(ctx.sessionManager);
  controlFoldCache.delete(ctx.sessionManager); // A failed fold/mirror cannot leave an adopted partial cache.
  const prior = cached && reusableControlFold(ctx, journal, cached) ? cached : undefined;
  if (prior) controlFoldHits = Math.min(Number.MAX_SAFE_INTEGER, controlFoldHits + 1);
  const { view, fold, latestFence } = foldControlJournal(journal, prior);
  assertFenceMirror(ctx.sessionManager.getBranch(), journal);
  const path = ctx.sessionManager.getSessionFile();
  if (path && journal.nodes.size <= 8192 && lstatSync(path).size <= 32 * 1024 * 1024)
    controlFoldCache.set(ctx.sessionManager, {
      runtime: currentRuntime(),
      sessionId: journal.sessionId,
      path,
      cwd: journal.cwd,
      nodes: [...journal.nodes].map(([id, node]) => [id, node.digest]),
      branch: journal.branch.map((node) => node.id),
      fold,
      latestFence,
    });
  // Public/runtime projections always own copies. The sole private non-isolated consumer
  // validates one invocation addition through invocationAdditionGraph's copy-on-write maps.
  return isolate ? structuredClone(view) : view;
}
function selectedBoardOwner(
  fold: ExecutionFold,
  registry: readonly ExecutionRegistryEntry[],
  position: number,
): (WorkOwnerKey & { kind: "board" }) | undefined {
  const seed = [...fold.boardSeeds.values()].at(-1);
  if (!seed) return undefined;
  const owner = {
    kind: "board" as const,
    board: {
      sessionId: seed.data.sessionId,
      boardRunId: seed.data.boardRunId,
      seedEntryId: seed.entryId,
    },
  };
  const boundary = boardBoundaryBefore(fold, position);
  if (boundary <= (fold.positions.get(seed.entryId) ?? -1)) return owner;
  const unresolved = registry.some(
    (entry) =>
      journalDigest(entry.binding.data.owner) === journalDigest(owner) &&
      (!entry.boundSnapshot ||
        !entry.settlement ||
        !entry.releasedSnapshot ||
        (fold.positions.get(entry.releasedSnapshot.entryId) ?? Infinity) >= boundary),
  );
  return unresolved ? owner : undefined;
}
function assertFenceMirror(
  entries: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>,
  journal: SessionJournal,
): void {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const node of journal.branch) {
    if (
      node.customType !== CONTROL_FACT_ENTRY &&
      node.customType !== ACCEPTANCE_FACT_ENTRY &&
      node.customType !== ACCEPTANCE_PROPOSAL_ENTRY &&
      !isAcceptanceWitness(node, journal) &&
      (node.customType !== CONTROL_FENCE_ENTRY || node.wireVersion !== 6)
    )
      continue;
    const entry = byId.get(node.id);
    if (!entry || journalDigest(entry) !== node.digest) fail();
  }
}
function hostIntentCandidate(entry: {
  type: string;
  customType?: string;
  data?: unknown;
}): boolean {
  if (entry.type !== "custom" || entry.customType !== RECEIPT_LEDGER_ENTRY) return false;
  const data = entry.data;
  return !!data && typeof data === "object" && "kind" in data && data.kind === "intent";
}
export function readControlJournal(
  ctx: ExtensionContext,
  restoration?: RestoreJournalRead,
): ControlJournalView {
  const entries = ctx.sessionManager.getBranch();
  const persistent = ctx.sessionManager.getSessionFile() !== undefined;
  if (
    !entries.some(
      (entry) =>
        isControlFenceEntry(entry) ||
        (entry.type === "custom" && entry.customType === CONTROL_FACT_ENTRY) ||
        (persistent && hostIntentCandidate(entry)),
    )
  )
    return {};
  const journal = restoration ? restoration.require(ctx) : inspectRestorableSession(ctx, true);
  if (!journal) throw new ControlJournalError("CONTROL_SOURCE_UNAVAILABLE");
  return verifiedControlView(ctx, journal);
}

export interface ControlLease {
  readonly runtime: TaskRuntime;
  readonly manager: ExtensionContext["sessionManager"];
  readonly sessionId: string;
  readonly path: string;
  readonly leafId: string | null;
  readonly source: string;
  readonly goalToken: string;
  readonly mutationEpoch: number | undefined;
  readonly board: TaskRuntime["board"];
  readonly boardDigest: string;
  readonly owner: WorkOwnerKey | null;
}
function sourceStamp(path: string): string {
  try {
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile()) throw new Error("not a regular file");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch {
    throw new ControlJournalError("CONTROL_SOURCE_UNAVAILABLE");
  }
}
function selectedManagementOwner(sessionId: string): WorkOwnerKey | null | undefined {
  const management = currentRuntime().management;
  if (!management) return undefined;
  if (management.record && management.record.data.sessionId !== sessionId)
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const owner = management.activeWorkOwner;
  if (owner && ownerSession(owner) !== sessionId)
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  return owner;
}
export function currentWorkOwner(sessionId: string): WorkOwnerKey | null {
  const selected = selectedManagementOwner(sessionId);
  return selected === undefined ? retainedWorkOwner(sessionId) : selected;
}
export function retainedWorkOwner(sessionId: string): WorkOwnerKey | null {
  const runtime = currentRuntime();
  if (runtime.goal && runtime.goal.sessionId !== sessionId)
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const goal = runtime.goal?.current;
  if (goal)
    return {
      kind: "goal",
      goal: {
        sessionId,
        goalKey: goal.scope.goalRunId,
        goalRunId: goal.scope.goalRunId,
        lifecycleCommitId: goal.scope.lifecycleCommitId,
      },
    };
  if (runtime.supervisor && runtime.supervisor.sessionId !== sessionId)
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  if (runtime.receiptStore)
    return {
      kind: "goal",
      goal: {
        sessionId,
        goalKey: runtime.receiptStore.checkpoint().goalId,
        goalRunId: null,
        lifecycleCommitId: null,
      },
    };
  const boardOwner = runtime.controlJournal?.boardOwner;
  if (boardOwner && boardOwner.board.sessionId !== sessionId)
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  return boardOwner ?? null;
}
function runtimeWorkSession(): string | undefined {
  const runtime = currentRuntime();
  return (
    runtime.sessionId ??
    runtime.goal?.sessionId ??
    runtime.supervisor?.sessionId ??
    runtime.controlJournal?.latestFence?.data.sessionId
  );
}
function runtimeWorkOwner(): WorkOwnerKey | null {
  const sessionId = runtimeWorkSession();
  return sessionId ? currentWorkOwner(sessionId) : null;
}
export function executionActivityIssue(
  sessionId: string | undefined = runtimeWorkSession(),
): string | undefined {
  if (!sessionId) return undefined;
  const runtime = currentRuntime();
  if (runtime.executionMemoryBindings?.some((binding) => binding.sessionId === sessionId))
    return "An unverified memory execution remains registered; inspect before replacing its work owner";
  const nativeCheck = acceptanceRunActivityIssue(runtime.controlJournal?.acceptance, sessionId);
  if (nativeCheck) return nativeCheck;
  return runtime.controlJournal?.executionRegistry?.some(
    (entry) =>
      ownerSession(entry.binding.data.owner) === sessionId &&
      (!entry.boundSnapshot || !entry.settlement || !entry.releasedSnapshot),
  )
    ? "A registered writer is unresolved or incompletely released; do not discard its board or create another Goal"
    : undefined;
}
export function observeExecutionBoardBoundary(events: readonly unknown[]): void {
  const runtime = currentRuntime();
  if (
    events.some(isBoardReplacementEvent) &&
    !runtime.goal?.current &&
    !runtime.supervisor &&
    !runtime.receiptStore &&
    runtime.controlJournal
  )
    runtime.controlJournal.boardOwner = undefined;
}
function partialExecutions(owner: WorkOwnerKey | null): ExecutionRegistryEntry[] {
  if (!owner) return [];
  const view = currentRuntime().controlJournal;
  return (view?.executionRegistry ?? []).filter(
    (entry) =>
      journalDigest(entry.binding.data.owner) === journalDigest(owner) &&
      (!entry.boundSnapshot || (entry.settlement ? !entry.releasedSnapshot : !!entry.observation)),
  );
}
export function executionPersistenceIssue(
  owner: WorkOwnerKey | null = runtimeWorkOwner(),
): string | undefined {
  return partialExecutions(owner).length
    ? "Execution metadata group is incomplete; explicitly repair the same binding/settlement before other mutations"
    : undefined;
}
export function isExecutionRepairRequest(
  name: string,
  input: Record<string, unknown>,
  owner: WorkOwnerKey | null = runtimeWorkOwner(),
): boolean {
  if (
    name !== "workflow_gate" ||
    !["bind_execution", "clear_execution"].includes(String(input.action)) ||
    input.executionRef === undefined
  )
    return false;
  return partialExecutions(owner).some((entry) => {
    const binding = entry.binding.data;
    const action = !entry.boundSnapshot ? "bind_execution" : "clear_execution";
    return (
      input.action === action &&
      input.taskId === binding.taskId &&
      journalDigest(input.executionRef) === journalDigest(binding.executionRef)
    );
  });
}
function assertExecutionCompletions(snapshot: TaskBoardSnapshot): void {
  const runtime = currentRuntime(),
    owner = runtimeWorkOwner();
  const previous = new Map(runtime.board.tasks.map((task) => [task.id, task]));
  const completing = snapshot.tasks.filter(
    (task) => task.status === "done" && previous.get(task.id)?.status !== "done",
  );
  for (const task of completing) {
    if (task.executionRef || previous.get(task.id)?.executionRef)
      throw new Error(
        "Task completion requires a trusted execution settlement and released reference",
      );
    const memory = runtime.executionMemoryBindings?.some(
      (binding) =>
        binding.sessionId === runtimeWorkSession() &&
        binding.taskId === task.id &&
        (binding.owner === null || journalDigest(binding.owner) === journalDigest(owner)),
    );
    if (memory) throw new Error("Task completion is blocked by its unverified volatile execution");
    if (!owner) continue;
    const unresolved = runtime.controlJournal?.executionRegistry?.some(
      (entry) =>
        journalDigest(entry.binding.data.owner) === journalDigest(owner) &&
        entry.binding.data.taskId === task.id &&
        (!entry.boundSnapshot ||
          !entry.settlement ||
          !entry.releasedSnapshot ||
          (entry.settlement.data.outcome !== "success" && !entry.resolution)),
    );
    if (unresolved)
      throw new Error(
        "Task completion is blocked by its unresolved registered execution or failure handling",
      );
  }
}
export function assertExecutionTaskWrite(
  events: readonly unknown[],
  snapshot: TaskBoardSnapshot,
): void {
  assertExecutionCompletions(snapshot);
  const activity = events.some(isBoardReplacementEvent) ? executionActivityIssue() : undefined;
  if (activity) throw new Error(activity);
  const issue = executionPersistenceIssue();
  if (!issue) return;
  const event = events.length === 1 ? events[0] : undefined;
  if (
    !event ||
    typeof event !== "object" ||
    !("type" in event) ||
    !("id" in event) ||
    !("executionRef" in event)
  )
    throw new Error(issue);
  const input = { action: event.type, taskId: event.id, executionRef: event.executionRef };
  const allowed =
    isExecutionRepairRequest("workflow_gate", input) &&
    partialExecutions(runtimeWorkOwner()).some((entry) => {
      const expected =
        event.type === "bind_execution"
          ? entry.binding.data.boundBoardDigest
          : entry.settlement?.data.releasedBoardDigest;
      return (
        event.id === entry.binding.data.taskId &&
        journalDigest(event.executionRef) === journalDigest(entry.binding.data.executionRef) &&
        journalDigest(snapshot) === expected
      );
    });
  if (!allowed) throw new Error(issue);
}
export function captureControlLease(ctx: ExtensionContext): ControlLease {
  if (currentRuntime().journalFault) throw new ControlJournalError("CONTROL_JOURNAL_UNCERTAIN");
  if (goalControlIssue(ctx)) throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const path = ctx.sessionManager.getSessionFile();
  if (!path) throw new ControlJournalError("CONTROL_SOURCE_UNAVAILABLE");
  const runtime = currentRuntime();
  const sessionId = ctx.sessionManager.getSessionId();
  return Object.freeze({
    runtime,
    manager: ctx.sessionManager,
    sessionId,
    path,
    leafId: ctx.sessionManager.getLeafId(),
    source: sourceStamp(path),
    goalToken: goalLease(),
    mutationEpoch: runtime.supervisor?.epoch,
    board: runtime.board,
    boardDigest: journalDigest(runtime.board),
    owner: currentWorkOwner(sessionId),
  });
}
function sameBoardLease(runtime: TaskRuntime, lease: ControlLease): boolean {
  return runtime.board === lease.board && journalDigest(runtime.board) === lease.boardDigest;
}
export function assertLease(ctx: ExtensionContext, lease: ControlLease, leaf = lease.leafId): void {
  const runtime = currentRuntime();
  if (runtime.journalFault) throw new ControlJournalError("CONTROL_JOURNAL_UNCERTAIN");
  if (
    runtime !== lease.runtime ||
    ctx.sessionManager !== lease.manager ||
    ctx.sessionManager.getSessionId() !== lease.sessionId ||
    ctx.sessionManager.getSessionFile() !== lease.path ||
    ctx.sessionManager.getLeafId() !== leaf ||
    goalLease() !== lease.goalToken ||
    runtime.supervisor?.epoch !== lease.mutationEpoch ||
    !sameBoardLease(runtime, lease) ||
    JSON.stringify(currentWorkOwner(lease.sessionId)) !== JSON.stringify(lease.owner)
  )
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  if (leaf === lease.leafId && sourceStamp(lease.path) !== lease.source)
    throw new ControlJournalError("CONTROL_SOURCE_CHANGED");
}
function appendedControl(
  ctx: ExtensionContext,
  parent: string | null,
  customType: string,
  value: unknown,
) {
  const entry = ctx.sessionManager.getLeafEntry();
  if (
    !entry ||
    entry.id === parent ||
    entry.parentId !== parent ||
    entry.type !== "custom" ||
    entry.customType !== customType ||
    journalDigest(entry.data) !== journalDigest(value)
  )
    fail();
  return entry;
}
export function appendControlFence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  features: readonly ControlFeature[],
  lease = captureControlLease(ctx),
): { entryId: string; digest: string; leafAfter: string } {
  assertLease(ctx, lease);
  if (sourceStamp(lease.path) !== lease.source)
    throw new ControlJournalError("CONTROL_SOURCE_CHANGED");
  const before = inspectSessionJournal(sessionJournalView(ctx), undefined, true);
  const latest = verifiedControlView(ctx, before).latestFence;
  const value: ControlFormatFenceV1 = {
    version: 6,
    protocol: CONTROL_PROTOCOL,
    kind: "format-fence",
    sessionId: lease.sessionId,
    revision: (latest?.data.revision ?? 0) + 1,
    previousFence: latest ? { entryId: latest.entryId, digest: latest.digest } : null,
    features: [...features].sort(),
    owner: structuredClone(lease.owner),
  };
  if (!validControlFence(value)) fail();
  if (value.features.some((feature) => !supportedControlFeatures.has(feature)))
    throw new ControlJournalError("CONTROL_UNSUPPORTED_FEATURE");
  assertLease(ctx, lease);
  if (sourceStamp(lease.path) !== lease.source)
    throw new ControlJournalError("CONTROL_SOURCE_CHANGED");
  return appendConfirmedControl(pi, ctx, CONTROL_FENCE_ENTRY, value, lease);
}
function appendConfirmedControl(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  customType: string,
  value: unknown,
  lease: ControlLease,
): { entryId: string; digest: string; leafAfter: string } {
  try {
    pi.appendEntry(customType, value);
    const entry = appendedControl(ctx, lease.leafId, customType, value);
    assertLease(ctx, lease, entry.id);
    const physical = inspectSessionJournal(sessionJournalView(ctx), undefined, true);
    const observed = physical.nodes.get(entry.id);
    if (!observed || observed.digest !== journalDigest(entry)) fail();
    const view = verifiedControlView(ctx, physical);
    assertLease(ctx, lease, entry.id);
    lease.runtime.controlJournal = view;
    return { entryId: entry.id, digest: observed.digest, leafAfter: entry.id };
  } catch (error) {
    lease.runtime.journalFault ??=
      "Control journal persistence failed; inspect before further mutation or retry";
    lease.runtime.cancel();
    throw new ControlJournalError("CONTROL_JOURNAL_UNCERTAIN", { cause: error });
  }
}
export function appendAcceptanceFact(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  value: AcceptanceFact,
): { entryId: string; digest: string; leafAfter: string } {
  if (!validAcceptanceFact(value, ctx.sessionManager.getSessionId()))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  const lease = captureControlLease(ctx);
  assertLease(ctx, lease);
  const journal = inspectSessionJournal(sessionJournalView(ctx), undefined, true),
    view = verifiedControlView(ctx, journal);
  if (!view.latestFence?.data.features.includes("acceptance-contract-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (invocationOwnerKey(value.owner) !== (lease.owner ? invocationOwnerKey(lease.owner) : null))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const node: JournalNode = {
    id: "candidate-not-a-receipt",
    parentId: journal.branch.at(-1)?.id ?? null,
    type: "custom",
    customType: ACCEPTANCE_FACT_ENTRY,
    data: value,
    digest: "",
  };
  const records = [
    ...journal.branch.filter(
      (item) => item.customType === ACCEPTANCE_FACT_ENTRY || isAcceptanceWitness(item, journal),
    ),
    node,
  ];
  readAcceptanceFacts(
    {
      ...journal,
      branch: [...journal.branch, node],
      nodes: new Map([...journal.nodes, [node.id, node]]),
    },
    records,
    view.invocations,
  );
  assertLease(ctx, lease);
  return appendConfirmedControl(pi, ctx, ACCEPTANCE_FACT_ENTRY, value, lease);
}
export function appendContractProposal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  value: ContractProposalRecord,
): { entryId: string; digest: string; leafAfter: string } {
  if (!validContractProposal(value, ctx.sessionManager.getSessionId()))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  const lease = captureControlLease(ctx);
  assertLease(ctx, lease);
  const journal = inspectSessionJournal(sessionJournalView(ctx), undefined, true);
  verifiedControlView(ctx, journal);
  proposalOriginalGoal(journal, value, journal.branch.length);
  if (
    value.target.kind === "preflight"
      ? currentRuntime().preflight?.preflightId !== value.target.preflightId ||
        !!currentRuntime().preflight?.started
      : !lease.owner || invocationOwnerKey(lease.owner) !== invocationOwnerKey(value.target.owner)
  )
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  assertLease(ctx, lease);
  return appendConfirmedControl(pi, ctx, ACCEPTANCE_PROPOSAL_ENTRY, value, lease);
}
export function appendManagedBoardSnapshot(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  board: TaskBoardSnapshot,
): { entryId: string; digest: string; leafAfter: string } {
  if (
    !isValidSnapshotV2(board) ||
    currentWorkOwner(ctx.sessionManager.getSessionId()) !== null ||
    executionActivityIssue(ctx.sessionManager.getSessionId())
  )
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const lease = captureControlLease(ctx);
  assertLease(ctx, lease);
  appendConfirmedControl(pi, ctx, CUSTOM_EVENT_TYPE, { type: "clear_tasks" }, lease);
  return appendConfirmedControl(pi, ctx, CUSTOM_SNAPSHOT_TYPE, board, captureControlLease(ctx));
}
function confirmedTaskBootstrap(
  view: ControlJournalView,
  value: BoardRunSeedFact,
  lease: ControlLease,
): boolean {
  const mode = view.modeRecords?.at(-1),
    selected = lease.runtime.management?.record;
  return (
    !!mode &&
    !!selected &&
    mode.entryId === selected.entryId &&
    mode.digest === selected.digest &&
    mode.data.mode === "tasks" &&
    mode.data.state === "stopping-with-attention" &&
    mode.data.activeWorkOwner === null &&
    mode.data.boardRef?.entryId === value.snapshotRef.entryId &&
    mode.data.boardRef.digest === value.snapshotRef.digest
  );
}
function validateBoardSeedAddition(
  view: ControlJournalView,
  value: BoardRunSeedFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (!view.latestFence?.data.features.includes("execution-settlement-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (
    lease.owner ||
    ((lease.runtime.supervisor || lease.runtime.receiptStore || lease.runtime.goal?.current) &&
      !confirmedTaskBootstrap(view, value, lease)) ||
    journalDigest(lease.board) !== value.boardDigest
  )
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const fold = createExecutionFold(journal);
  for (const seed of view.boardSeeds ?? []) fold.boardSeeds.set(seed.entryId, seed);
  for (const record of view.executionFacts ?? [])
    addExecutionFact(fold, record, journal, fold.positions.get(record.entryId) ?? -1);
  addBoardRunSeed(
    fold,
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    journal,
    journal.branch.length,
  );
}
function validateReviewAddition(
  view: ControlJournalView,
  value: ReviewAttemptFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (!view.latestFence?.data.features.includes("final-review-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (journalDigest(value.owner) !== journalDigest(lease.owner))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const previous = structuredClone(view.reviewAttempts ?? []);
  const advisor = createAdvisorFold();
  for (const record of view.advisorFacts ?? []) addAdvisorFact(advisor, record);
  const fold: ControlFold = {
    advisorFacts: [...(view.advisorFacts ?? [])],
    modeRecords: [...(view.modeRecords ?? [])],
    progressFacts: [...(view.progressFacts ?? [])],
    invocationFacts: [...(view.invocationFacts ?? [])],
    invocations: structuredClone(view.invocations ?? emptyInvocationGraph()),
    completionIntents: structuredClone(
      view.completionIntents ?? new Map<string, CompletionIntentEntry>(),
    ),
    hostPending: new Map(),
    executionFacts: [],
    finalValidations: [...(view.finalValidations ?? [])],
    finalValidationRegistrations: [...(view.finalValidationRegistrations ?? [])],
    advisor,
    execution: createExecutionFold(journal),
    reviewAttempts: new Map(previous.map((entry) => [entry.start.data.attemptId, entry])),
    reviewRecordIds: new Set(
      previous.flatMap((entry) => [
        entry.start.data.recordId,
        ...(entry.result ? [entry.result.data.recordId] : []),
      ]),
    ),
  };
  addReviewAttempt(
    fold,
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    journal,
    journal.branch.length,
  );
}
function validateReviewControlAddition(
  view: ControlJournalView,
  value: ControlFact,
  journal: SessionJournal,
  lease: ControlLease,
): boolean {
  if (validReviewAttempt(value, lease.sessionId)) {
    validateReviewAddition(view, value, journal, lease);
    return true;
  }
  if (validFinalValidationRegistration(value, lease.sessionId)) {
    if (!view.latestFence?.data.features.includes("final-review-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    if (
      journalDigest(value.owner) !== journalDigest(lease.owner) ||
      value.epoch !== lease.mutationEpoch
    )
      throw new ControlJournalError("CONTROL_OWNER_CHANGED");
    addFinalRegistration(
      [...(view.finalValidationRegistrations ?? [])],
      { entryId: "candidate-not-a-receipt", digest: "", data: value },
      journal,
      createExecutionFold(journal),
      journal.branch.length,
    );
    return true;
  }
  if (!validFinalValidation(value, lease.sessionId)) return false;
  if (!view.latestFence?.data.features.includes("final-review-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (
    journalDigest(value.owner) !== journalDigest(lease.owner) ||
    value.epoch !== lease.mutationEpoch
  )
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  addFinalValidation(
    [...(view.finalValidations ?? [])],
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    journal,
    createExecutionFold(journal),
    journal.branch.length,
    view.finalValidationRegistrations,
  );
  return true;
}
function validateModeAddition(
  view: ControlJournalView,
  value: SessionModeChangedV1,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (!view.latestFence?.data.features.includes("management-mode-v1"))
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (journalDigest(value.originOwner) !== journalDigest(lease.owner))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const execution = createExecutionFold(journal);
  for (const seed of view.boardSeeds ?? []) execution.boardSeeds.set(seed.entryId, seed);
  for (const record of view.executionFacts ?? [])
    addExecutionFact(execution, record, journal, execution.positions.get(record.entryId) ?? -1);
  const pending = new Map() as ControlFold["hostPending"];
  for (const node of journal.branch) observeModeHostCapture(pending, node);
  addSessionMode(
    [...(view.modeRecords ?? [])],
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    journal,
    execution,
    journal.branch.length,
    pending.size,
    view.invocations?.active.size ?? 0,
  );
}
function validateInvocationControlAddition(
  view: ControlJournalView,
  value: ControlFact,
  journal: SessionJournal,
  lease: ControlLease,
): boolean {
  if (validCompletionFact(value, lease.sessionId)) {
    validateCompletionAddition(view, value, journal, lease);
    return true;
  }
  if (validInvocationFact(value, lease.sessionId)) {
    validateInvocationAddition(view, value, journal, lease);
    return true;
  }
  return false;
}
function validateControlAddition(
  view: ControlJournalView,
  value: ControlFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (validateInvocationControlAddition(view, value, journal, lease)) return;
  if (validProgressFact(value, lease.sessionId)) {
    validateProgressAddition(view, value, journal, lease);
    return;
  }
  if (validSessionMode(value, lease.sessionId)) {
    validateModeAddition(view, value, journal, lease);
    return;
  }
  if (validateReviewControlAddition(view, value, journal, lease)) return;
  if (validBoardRunSeed(value, lease.sessionId)) {
    validateBoardSeedAddition(view, value, journal, lease);
    return;
  }
  if (validAdvisorFact(value, lease.sessionId)) {
    if (value.kind === "advisor-call-started")
      assertReviewCall(view.reviewAttempts ?? [], view.advisorFacts ?? [], value);
    if (!view.latestFence?.data.features.includes("advisor-accounting-v1"))
      throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
    if (
      value.kind === "advisor-call-started" &&
      journalDigest(value.owner) !== journalDigest(lease.owner)
    )
      throw new ControlJournalError("CONTROL_OWNER_CHANGED");
    assertAdvisorAddition(view.advisorFacts ?? [], value);
    return;
  }
  validateExecutionAddition(view, value, journal, lease);
}
function validateExecutionAddition(
  view: ControlJournalView,
  value: ControlFact,
  journal: SessionJournal,
  lease: ControlLease,
): void {
  if (
    !validExecutionFact(value, lease.sessionId) ||
    !view.latestFence?.data.features.includes("execution-settlement-v1")
  )
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  if (journalDigest(value.owner) !== journalDigest(lease.owner))
    throw new ControlJournalError("CONTROL_OWNER_CHANGED");
  const fold = createExecutionFold(journal);
  for (const seed of view.boardSeeds ?? []) fold.boardSeeds.set(seed.entryId, seed);
  for (const record of view.executionFacts ?? [])
    addExecutionFact(fold, record, journal, fold.positions.get(record.entryId) ?? -1);
  addExecutionFact(
    fold,
    { entryId: "candidate-not-a-receipt", digest: "", data: value },
    journal,
    journal.branch.length,
  );
}
export function appendControlFact(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  value: ControlFact,
  suppliedLease?: ControlLease,
): { entryId: string; digest: string; leafAfter: string } {
  if (
    !validAdvisorFact(value, ctx.sessionManager.getSessionId()) &&
    !validExecutionFact(value, ctx.sessionManager.getSessionId()) &&
    !validBoardRunSeed(value, ctx.sessionManager.getSessionId()) &&
    !validFinalValidation(value, ctx.sessionManager.getSessionId()) &&
    !validFinalValidationRegistration(value, ctx.sessionManager.getSessionId()) &&
    !validReviewAttempt(value, ctx.sessionManager.getSessionId()) &&
    !validSessionMode(value, ctx.sessionManager.getSessionId()) &&
    !validInvocationFact(value, ctx.sessionManager.getSessionId()) &&
    !validCompletionFact(value, ctx.sessionManager.getSessionId()) &&
    !validProgressFact(value, ctx.sessionManager.getSessionId())
  )
    throw new ControlJournalError("CONTROL_FACT_UNSUPPORTED");
  const lease = suppliedLease ?? captureControlLease(ctx);
  assertLease(ctx, lease);
  if (sourceStamp(lease.path) !== lease.source)
    throw new ControlJournalError("CONTROL_SOURCE_CHANGED");
  const journal = inspectSessionJournal(sessionJournalView(ctx), undefined, true);
  const view = verifiedControlView(ctx, journal, !validInvocationFact(value, lease.sessionId));
  validateControlAddition(view, value, journal, lease);
  assertLease(ctx, lease);
  if (sourceStamp(lease.path) !== lease.source)
    throw new ControlJournalError("CONTROL_SOURCE_CHANGED");
  return appendConfirmedControl(pi, ctx, CONTROL_FACT_ENTRY, value, lease);
}
