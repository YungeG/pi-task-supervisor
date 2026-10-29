import { Type } from "typebox";
import {
  scopeRevisionSchemas,
  type ScopeRevisionControl,
  type ScopeRevisionCommitted,
  type ScopeRevisionRevoked,
} from "./scope-revision-facts";
import {
  scopeRevisionProposalViews,
  type ScopeRevisionProposalView,
} from "./scope-revision-proposal";
import {
  assertScopeControl,
  assertScopeExecutionSource,
  assertScopeBound,
  assertScopeCommit,
  assertScopeRevocation,
} from "./scope-revision-journal";
import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import { validDecisionInformation } from "./decision-spec";
import {
  contractProposalViews,
  proposalForGoal,
  type ContractProposalView,
} from "./acceptance-planning";
import {
  WorkOwnerSchema,
  validWorkOwner,
  validControlFence,
  ControlJournalError,
  validInvocationFact,
  ReviewAttemptStartedSchema,
  type WorkOwnerKey,
} from "./control-journal";
import {
  journalDigest,
  GoalReadbackFrameSchema,
  type GoalReadbackFrame,
  type JournalNode,
  type SessionJournal,
} from "./human-journal";
import {
  invocationOwnerKey,
  invocationCallKey,
  SDK_TOOL_ONLY_CAPABILITY,
  type InvocationGraph,
  type InvocationNodeV1,
} from "./invocation-tree";
import {
  AcceptanceProposalSchema,
  validateAcceptanceProposal,
  CheckerScopeSchema,
  checkerScopeInventory,
  type AcceptanceProposal,
} from "./acceptance-proposal";
import type {
  AcceptanceContractV1,
  AcceptanceReference,
  CheckDefinitionV1,
  CheckResultV1,
  CheckObservationV1,
} from "./acceptance-contract";
import { checkContractAcceptance } from "./acceptance-contract";
import type { ArtifactFileDigest, CheckerScope, ArtifactVersionV1 } from "./artifact-version";
import { NativeInvocationDescriptorSchema } from "./check-profile";
import type { NativeCheckExecution } from "./check-runner";
import { confirmedApprovalDefinitionSource } from "./preflight";

export const ACCEPTANCE_FACT_ENTRY = "continuous-tasks:acceptance-facts";
export type AcceptanceHeader = Omit<AcceptanceProposal, "checks">;
export interface AcceptanceDefinitionFact {
  version: 1;
  kind: "acceptance-definition-declared";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  spec: AcceptanceProposal["checks"][number];
  frozenFiles: ArtifactFileDigest[];
  checkerWorkspace?: ArtifactVersionV1["workspace"];
  environmentDigest: string;
  invocation:
    | (NativeCheckExecution["invocation"] & { nodeVersion: string; platform: string })
    | null;
  definitionDigest: string;
}
export interface AcceptanceBoundFact {
  version: 1;
  kind: "acceptance-contract-bound";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  contractId: string;
  revision: number;
  previousRef: AcceptanceReference | null;
  header: AcceptanceHeader;
  workspace: { root: string; device: string; inode: string };
  scopeDigest: string;
  checkerScopes?: CheckerScope[];
  definitions: Array<{ checkId: string; ref: AcceptanceReference; definitionDigest: string }>;
  authority:
    | { kind: "recognized-host"; originalGoalDigest: string }
    | { kind: "native-reviewed"; originalGoalDigest: string; controlRef: AcceptanceReference }
    | {
        kind: "scope-revision-reviewed";
        originalGoalDigest: string;
        controlRef: AcceptanceReference;
      }
    | {
        kind: "preflight-reviewed";
        originalGoalDigest: string;
        permissionControlRef: AcceptanceReference;
        definitionControlRef: AcceptanceReference;
      };
  contractDigest: string;
}
export interface AcceptanceCheckStarted {
  version: 1;
  kind: "acceptance-check-started";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  runId: string;
  contractRef: AcceptanceReference;
  definitionRef: AcceptanceReference;
  callId: string;
  invocationRef: AcceptanceReference;
  versionId: string;
  inputGeneration: string;
  scopeDigest: string;
}
export interface AcceptanceCheckObserved {
  version: 1;
  kind: "acceptance-check-observed";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  runId: string;
  startedRef: AcceptanceReference;
  closed: boolean;
  pid: number | null;
  exitCode: number | null;
  termination: NativeCheckExecution["termination"];
  invocation: NonNullable<AcceptanceDefinitionFact["invocation"]>;
  outputDigest: string;
  beforeVersionId: string;
  afterVersionId: string | null;
  beforeGeneration: string;
  afterGeneration: string | null;
  result: CheckResultV1 | null;
  temporary?: NativeCheckExecution["temporary"];
}
export interface AcceptanceCheckRun {
  start: AcceptanceFactView<AcceptanceCheckStarted>;
  observed?: AcceptanceFactView<AcceptanceCheckObserved>;
}
export interface AcceptanceReviewBound {
  version: 1;
  kind: "acceptance-review-bound";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  contractRef: AcceptanceReference;
  reviewStartedRef: AcceptanceReference;
  boardDigest: string;
  bindingsDigest: string;
  epoch: number;
  versionId: string;
  inputGeneration: string;
  observations: AcceptanceReference[];
}
export interface ManualCheckBindingV1 {
  version: 1;
  kind: "acceptance-manual-control";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  contractRef: AcceptanceReference;
  definitionRef: AcceptanceReference;
  versionId: string;
  inputGeneration: string;
  sourceSequence: number;
  frame: GoalReadbackFrame;
  value: string;
}
export interface ManualCheckEntry {
  control: AcceptanceFactView<ManualCheckBindingV1>;
  witness?: AcceptanceReference;
}
export interface ContractReviewControl {
  version: 1;
  kind: "acceptance-contract-control";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  proposalRef: AcceptanceReference;
  contractId: string;
  revision: number;
  frame: GoalReadbackFrame;
  value: "绑定此契约" | "不绑定";
  versionId: string;
  inputGeneration: string;
}
export interface ContractReviewEntry {
  control: AcceptanceFactView<ContractReviewControl>;
  witness?: AcceptanceReference;
}
export interface ScopeRevisionReviewEntry {
  control: AcceptanceFactView<ScopeRevisionControl>;
  witness?: AcceptanceReference;
}
export type AcceptanceFact =
  | ScopeRevisionControl
  | ScopeRevisionCommitted
  | ScopeRevisionRevoked
  | AcceptanceDefinitionFact
  | AcceptanceBoundFact
  | AcceptanceCheckStarted
  | AcceptanceCheckObserved
  | AcceptanceReviewBound
  | ManualCheckBindingV1
  | ContractReviewControl;
export interface AcceptanceFactView<
  T extends AcceptanceFact = AcceptanceFact,
> extends AcceptanceReference {
  data: T;
}
export interface AcceptanceJournalView {
  definitions: AcceptanceFactView<AcceptanceDefinitionFact>[];
  contracts: AcceptanceFactView<AcceptanceBoundFact>[];
  runs: AcceptanceCheckRun[];
  reviewBindings: AcceptanceFactView<AcceptanceReviewBound>[];
  manualChecks: ManualCheckEntry[];
  contractReviews: ContractReviewEntry[];
  scopeReviews?: ScopeRevisionReviewEntry[];
  scopeCommits?: AcceptanceFactView<ScopeRevisionCommitted>[];
  scopeRevocations?: AcceptanceFactView<ScopeRevisionRevoked>[];
  scopeProposals?: ScopeRevisionProposalView[];
}
const strict = { additionalProperties: false } as const;
const id = (max = 200) => Type.String({ minLength: 1, maxLength: max });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const reference = Type.Object({ entryId: id(), digest: hash }, strict);
export const CheckResultSchema = Type.Object(
  {
    tests: Type.Integer({ minimum: 0, maximum: 1000000 }),
    passed: Type.Integer({ minimum: 0, maximum: 1000000 }),
    failed: Type.Integer({ minimum: 0, maximum: 1000000 }),
    skipped: Type.Integer({ minimum: 0, maximum: 1000000 }),
    requiredCases: Type.Record(
      Type.String({ minLength: 1, maxLength: 200 }),
      Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped")]),
      { ...strict, maxProperties: 32 },
    ),
    skippedIds: Type.Array(id(200), { maxItems: 32, uniqueItems: true }),
  },
  strict,
);
const invocationDescriptorSchema = NativeInvocationDescriptorSchema;
const workspaceSchema = Type.Object({ root: id(4096), device: id(), inode: id() }, strict);
const frozenFileSchema = Type.Object(
  { path: id(4096), bytes: Type.Integer({ minimum: 0, maximum: 16777216 }), sha256: hash },
  strict,
);
function checkStartSchema(owner: typeof WorkOwnerSchema) {
  return Type.Object(
    {
      version: Type.Literal(1),
      recordId: id(),
      owner,
      sourceRef: reference,
      kind: Type.Literal("acceptance-check-started"),
      runId: id(),
      contractRef: reference,
      definitionRef: reference,
      callId: id(2000),
      invocationRef: reference,
      versionId: hash,
      inputGeneration: hash,
      scopeDigest: hash,
    },
    strict,
  );
}
function contractControlSchema(owner: typeof WorkOwnerSchema) {
  return Type.Object(
    {
      version: Type.Literal(1),
      kind: Type.Literal("acceptance-contract-control"),
      recordId: id(),
      owner,
      sourceRef: reference,
      proposalRef: reference,
      contractId: id(),
      revision: Type.Integer({ minimum: 1, maximum: 16 }),
      frame: GoalReadbackFrameSchema,
      value: Type.Union([Type.Literal("绑定此契约"), Type.Literal("不绑定")]),
      versionId: hash,
      inputGeneration: hash,
    },
    strict,
  );
}
function declarationSchema(owner: typeof WorkOwnerSchema) {
  return Type.Object(
    {
      version: Type.Literal(1),
      recordId: id(),
      owner,
      sourceRef: reference,
      kind: Type.Literal("acceptance-definition-declared"),
      spec: AcceptanceProposalSchema.properties.checks.items,
      frozenFiles: Type.Array(frozenFileSchema, { maxItems: 32 }),
      checkerWorkspace: Type.Optional(workspaceSchema),
      environmentDigest: hash,
      invocation: Type.Union([Type.Null(), invocationDescriptorSchema]),
      definitionDigest: hash,
    },
    strict,
  );
}
function observationSchema(owner: typeof WorkOwnerSchema) {
  const base = { version: Type.Literal(1), recordId: id(), owner, sourceRef: reference };
  return Type.Object(
    {
      ...base,
      kind: Type.Literal("acceptance-check-observed"),
      runId: id(),
      startedRef: reference,
      closed: Type.Boolean(),
      pid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      exitCode: Type.Union([Type.Integer(), Type.Null()]),
      termination: Type.Union([
        Type.Literal("exited"),
        Type.Literal("cancelled"),
        Type.Literal("timed_out"),
        Type.Literal("output_limit"),
        Type.Literal("spawn_error"),
        Type.Literal("unknown"),
      ]),
      invocation: invocationDescriptorSchema,
      outputDigest: hash,
      beforeVersionId: hash,
      afterVersionId: Type.Union([hash, Type.Null()]),
      beforeGeneration: hash,
      afterGeneration: Type.Union([hash, Type.Null()]),
      result: Type.Union([CheckResultSchema, Type.Null()]),
      temporary: Type.Optional(
        Type.Object(
          {
            root: id(4096),
            inputDigest: hash,
            cleanup: Type.Union([
              Type.Literal("removed"),
              Type.Literal("retained"),
              Type.Literal("failed"),
            ]),
          },
          strict,
        ),
      ),
    },
    strict,
  );
}
function makeSchema(owner: typeof WorkOwnerSchema) {
  const base = { version: Type.Literal(1), recordId: id(), owner, sourceRef: reference };
  const bound = Type.Object(
    {
      ...base,
      kind: Type.Literal("acceptance-contract-bound"),
      contractId: id(),
      revision: Type.Integer({ minimum: 1, maximum: 16 }),
      previousRef: Type.Union([reference, Type.Null()]),
      header: Type.Omit(AcceptanceProposalSchema, ["checks"]),
      workspace: workspaceSchema,
      scopeDigest: hash,
      checkerScopes: Type.Optional(Type.Array(CheckerScopeSchema, { maxItems: 16 })),
      definitions: Type.Array(
        Type.Object({ checkId: id(100), ref: reference, definitionDigest: hash }, strict),
        { minItems: 1, maxItems: 16 },
      ),
      authority: Type.Union([
        Type.Object({ kind: Type.Literal("recognized-host"), originalGoalDigest: hash }, strict),
        Type.Object(
          {
            kind: Type.Union([
              Type.Literal("native-reviewed"),
              Type.Literal("scope-revision-reviewed"),
            ]),
            originalGoalDigest: hash,
            controlRef: reference,
          },
          strict,
        ),
        Type.Object(
          {
            kind: Type.Literal("preflight-reviewed"),
            originalGoalDigest: hash,
            permissionControlRef: reference,
            definitionControlRef: reference,
          },
          strict,
        ),
      ]),
      contractDigest: hash,
    },
    strict,
  );
  const observed = observationSchema(owner);
  const reviewed = Type.Object(
    {
      ...base,
      kind: Type.Literal("acceptance-review-bound"),
      contractRef: reference,
      reviewStartedRef: reference,
      boardDigest: hash,
      bindingsDigest: hash,
      epoch: Type.Integer({ minimum: 0 }),
      versionId: hash,
      inputGeneration: hash,
      observations: Type.Array(reference, { minItems: 1, maxItems: 16 }),
    },
    strict,
  );
  const manual = Type.Object(
    {
      ...base,
      kind: Type.Literal("acceptance-manual-control"),
      contractRef: reference,
      definitionRef: reference,
      versionId: hash,
      inputGeneration: hash,
      sourceSequence: Type.Integer({ minimum: 0 }),
      frame: GoalReadbackFrameSchema,
      value: Type.String({ minLength: 1, maxLength: 1000 }),
    },
    strict,
  );
  return Type.Unsafe<AcceptanceFact>(
    Type.Union([
      declarationSchema(owner),
      bound,
      checkStartSchema(owner),
      observed,
      reviewed,
      manual,
      contractControlSchema(owner),
      ...scopeRevisionSchemas(owner),
    ]),
  );
}
let schema: ReturnType<typeof makeSchema> | undefined;
export function validAcceptanceFact(value: unknown, sessionId: string): value is AcceptanceFact {
  schema ??= makeSchema(WorkOwnerSchema);
  return (
    Check(schema, value) &&
    Buffer.byteLength(JSON.stringify(value)) <= 16384 &&
    validWorkOwner(value.owner) &&
    (value.owner.kind === "goal" ? value.owner.goal.sessionId : value.owner.board.sessionId) ===
      sessionId
  );
}
function fail(): never {
  throw new ControlJournalError("CONTROL_FORMAT_INVALID");
}
const refTuple = (ref: AcceptanceReference) => [ref.entryId, ref.digest];
function specTuple(spec: AcceptanceProposal["checks"][number]): unknown[] {
  const base = [spec.kind, spec.checkId, [...spec.requirementIds].sort()];
  return spec.kind === "manual"
    ? [...base, spec.question, spec.response, spec.expectedValue]
    : [
        ...base,
        spec.script,
        [...spec.checkerFiles].sort(),
        [...spec.configs].sort(),
        spec.args,
        spec.timeoutMs,
        [
          spec.expected.minTests,
          [...spec.expected.requiredCases].sort(),
          [...spec.expected.allowedSkipped].sort(),
        ],
        ...(spec.runtime || spec.checkerRoot || spec.tests || spec.permissionId
          ? [
              [
                spec.runtime ?? null,
                spec.checkerRoot ?? null,
                spec.tests ?? null,
                spec.permissionId ?? null,
              ],
            ]
          : []),
      ];
}
export function acceptanceDefinitionDigest(
  data: Omit<AcceptanceDefinitionFact, "definitionDigest">,
): string {
  const command = data.invocation;
  return journalDigest([
    "acceptance-check-definition-v1",
    invocationOwnerKey(data.owner),
    refTuple(data.sourceRef),
    specTuple(data.spec),
    data.frozenFiles.map((file) => [file.path, file.bytes, file.sha256]),
    data.environmentDigest,
    command
      ? [
          command.executable,
          command.args,
          command.cwd,
          command.environmentDigest,
          command.nodeVersion,
          command.platform,
          ...(command.profile ? [command.profile] : []),
        ]
      : null,
    ...(data.checkerWorkspace ? [["checker-workspace-v1", data.checkerWorkspace]] : []),
  ]);
}
export function acceptanceContractDigest(
  data: Omit<AcceptanceBoundFact, "contractDigest">,
): string {
  const header = data.header;
  return journalDigest([
    "acceptance-contract-v1",
    invocationOwnerKey(data.owner),
    data.contractId,
    data.revision,
    data.previousRef ? refTuple(data.previousRef) : null,
    refTuple(data.sourceRef),
    header.scopeId,
    header.inputs,
    header.artifacts,
    header.requirements.map((item) => [item.requirementId, item.source, item.text, item.required]),
    [
      header.environment.profileId,
      Object.keys(header.environment.values)
        .sort()
        .map((key) => [key, header.environment.values[key]]),
    ],
    [data.workspace.root, data.workspace.device, data.workspace.inode],
    data.scopeDigest,
    data.definitions.map((item) => [item.checkId, refTuple(item.ref), item.definitionDigest]),
    data.authority.kind === "recognized-host"
      ? [data.authority.kind, data.authority.originalGoalDigest]
      : data.authority.kind === "native-reviewed" ||
          data.authority.kind === "scope-revision-reviewed"
        ? [
            data.authority.kind,
            data.authority.originalGoalDigest,
            refTuple(data.authority.controlRef),
          ]
        : [
            data.authority.kind,
            data.authority.originalGoalDigest,
            refTuple(data.authority.permissionControlRef),
            refTuple(data.authority.definitionControlRef),
          ],
    ...(data.checkerScopes !== undefined ? [["checker-scopes-v1", data.checkerScopes]] : []),
  ]);
}
/** Actual earlier native supervisor material only; a cache or model label is not a source. */
export function acceptanceGoalSource(
  journal: SessionJournal,
  owner: WorkOwnerKey,
  ref: AcceptanceReference,
  position: number,
): string {
  const node = journal.nodes.get(ref.entryId),
    index = journal.branch.findIndex((item) => item.id === ref.entryId);
  if (
    owner.kind !== "goal" ||
    !node ||
    index < 0 ||
    index >= position ||
    node.digest !== ref.digest
  )
    fail();
  const proof = node.supervisorProof,
    goal = owner.goal;
  if (
    !proof ||
    proof.sessionId !== goal.sessionId ||
    proof.goalKey !== goal.goalKey ||
    (goal.lifecycleCommitId !== null && proof.lifecycleCommitId !== goal.lifecycleCommitId)
  )
    fail();
  if (typeof proof.goalText !== "string") fail();
  return proof.goalText;
}
export function acceptanceGoalDigest(
  owner: WorkOwnerKey,
  ref: AcceptanceReference,
  goal: string,
): string {
  return journalDigest([
    "acceptance-original-goal-v1",
    invocationOwnerKey(owner),
    refTuple(ref),
    goal,
  ]);
}
function assertDefinition(data: AcceptanceDefinitionFact): void {
  const spec = data.spec,
    paths = data.frozenFiles.map((file) => file.path);
  if (
    data.definitionDigest !== acceptanceDefinitionDigest(data) ||
    new Set(paths).size !== paths.length
  )
    fail();
  if (spec.kind === "manual") {
    if (data.invocation !== null || paths.length) fail();
    return;
  }
  if (
    !data.invocation ||
    data.invocation.environmentDigest !== data.environmentDigest ||
    journalDigest([...paths].sort()) !==
      journalDigest([...spec.checkerFiles, ...spec.configs].sort())
  )
    fail();
}
function isScopeFact(
  data: AcceptanceFact,
): data is ScopeRevisionControl | ScopeRevisionCommitted | ScopeRevisionRevoked {
  return [
    "acceptance-scope-control",
    "scope-revision-committed",
    "scope-revision-revoked",
  ].includes(data.kind);
}
function assertCurrentOwner(journal: SessionJournal, data: AcceptanceFact, position: number): void {
  if (data.owner.kind !== "goal") fail();
  const last = [...journal.branch.slice(0, position)]
    .reverse()
    .find((node) => node.supervisorProof)?.supervisorProof;
  const metadata =
    data.kind === "acceptance-definition-declared" ||
    (data.kind === "acceptance-contract-bound" && data.authority.kind !== "recognized-host") ||
    isScopeFact(data);
  const pausedMetadata =
    metadata &&
    ["paused", "fault"].includes(last?.status ?? "") &&
    journal.branch
      .slice(0, position)
      .some(
        (node) =>
          node.customType === "continuous-tasks:supervisor" &&
          validControlFence(node.data) &&
          node.data.features.includes("approval-workflow-v1"),
      );
  if (
    !last ||
    last.sessionId !== data.owner.goal.sessionId ||
    last.goalKey !== data.owner.goal.goalKey ||
    (last.status !== "active" && !pausedMetadata)
  )
    fail();
}
function boundDefinitions(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceFactView<AcceptanceDefinitionFact>[],
): AcceptanceDefinitionFact[] {
  return data.definitions.map((ref) => {
    const entry = definitions.find(
      (item) => item.entryId === ref.ref.entryId && item.digest === ref.ref.digest,
    );
    if (
      !entry ||
      entry.data.definitionDigest !== ref.definitionDigest ||
      entry.data.spec.checkId !== ref.checkId ||
      invocationOwnerKey(entry.data.owner) !== invocationOwnerKey(data.owner) ||
      journalDigest(entry.data.sourceRef) !== journalDigest(data.sourceRef)
    )
      fail();
    return entry.data;
  });
}
function assertCheckerInventory(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceDefinitionFact[],
  proposal: AcceptanceProposal,
): void {
  if (data.checkerScopes !== undefined) {
    const inventory = checkerScopeInventory(
      data.workspace.root,
      data.header.inputs,
      proposal.checks,
    );
    if (
      !isDeepStrictEqual(data.checkerScopes, inventory.checkerScopes) ||
      definitions.some(
        (definition) =>
          definition.spec.kind === "automatic" &&
          (!definition.checkerWorkspace ||
            definition.checkerWorkspace.root !==
              (definition.spec.checkerRoot ?? data.workspace.root)),
      )
    )
      fail();
  } else if (
    definitions.some(
      (definition) =>
        definition.checkerWorkspace ||
        definition.invocation?.profile ||
        (definition.spec.kind === "automatic" &&
          (definition.spec.runtime || definition.spec.checkerRoot)),
    )
  )
    fail();
}
function assertBound(
  data: AcceptanceBoundFact,
  view: AcceptanceJournalView,
  journal: SessionJournal,
  position: number,
): void {
  const definitions = boundDefinitions(data, view.definitions),
    proposal = validateAcceptanceProposal({
      ...data.header,
      checks: definitions.map((item) => item.spec),
    });
  const prior = selectedAcceptanceContract(view, data.owner);
  if (
    data.contractDigest !== acceptanceContractDigest(data) ||
    data.authority.originalGoalDigest !==
      acceptanceGoalDigest(
        data.owner,
        data.sourceRef,
        acceptanceGoalSource(journal, data.owner, data.sourceRef, position),
      )
  )
    fail();
  if (prior) {
    if (
      data.revision !== prior.data.revision + 1 ||
      data.contractId !== prior.data.contractId ||
      journalDigest(data.previousRef) !==
        journalDigest({ entryId: prior.entryId, digest: prior.digest }) ||
      (data.authority.kind !== "scope-revision-reviewed" &&
        journalDigest([
          proposal.requirements,
          data.checkerScopes === undefined
            ? proposal.inputs
            : checkerScopeInventory(data.workspace.root, proposal.inputs, proposal.checks).inputs,
          proposal.artifacts,
          proposal.scopeId,
        ]) !==
          journalDigest([
            prior.data.header.requirements,
            prior.data.checkerScopes === undefined
              ? prior.data.header.inputs
              : checkerScopeInventory(
                  prior.data.workspace.root,
                  prior.data.header.inputs,
                  boundDefinitions(prior.data, view.definitions).map((item) => item.spec),
                ).inputs,
            prior.data.header.artifacts,
            prior.data.header.scopeId,
          ]))
    )
      fail();
  } else if (data.revision !== 1 || data.previousRef !== null) fail();
  assertCheckerInventory(data, definitions, proposal);
  assertReviewedAuthority(data, definitions, view, journal, position);
  const environmentDigest = journalDigest(
    Object.keys(data.header.environment.values)
      .sort()
      .map((key) => [key, data.header.environment.values[key]]),
  );
  if (
    data.workspace.root !== journal.cwd ||
    definitions.some((item) => item.environmentDigest !== environmentDigest)
  )
    fail();
}
function runSources(view: AcceptanceJournalView, start: AcceptanceCheckStarted) {
  const contract = view.contracts.find(
    (item) =>
      item.entryId === start.contractRef.entryId && item.digest === start.contractRef.digest,
  );
  const definition = view.definitions.find(
    (item) =>
      item.entryId === start.definitionRef.entryId && item.digest === start.definitionRef.digest,
  );
  if (
    !contract ||
    !definition ||
    definition.data.spec.kind !== "automatic" ||
    invocationOwnerKey(contract.data.owner) !== invocationOwnerKey(start.owner) ||
    invocationOwnerKey(definition.data.owner) !== invocationOwnerKey(start.owner) ||
    !contract.data.definitions.some(
      (item) => item.ref.entryId === definition.entryId && item.ref.digest === definition.digest,
    )
  )
    fail();
  return { contract, definition };
}
function checkInvocationSource(
  data: AcceptanceCheckStarted,
  journal: SessionJournal,
  position: number,
) {
  const source = journal.nodes.get(data.invocationRef.entryId),
    index = journal.branch.findIndex((node) => node.id === data.invocationRef.entryId);
  if (
    !source ||
    index < 0 ||
    index >= position ||
    source.digest !== data.invocationRef.digest ||
    !validInvocationFact(source.data, journal.sessionId) ||
    source.data.kind !== "invocation-started"
  )
    fail();
  return source.data;
}
function assertCheckStart(
  view: AcceptanceJournalView,
  data: AcceptanceCheckStarted,
  journal: SessionJournal,
  position: number,
): void {
  assertScopeExecutionSource(view, journal, data.owner, position);
  const { contract, definition } = runSources(view, data);
  if (
    view.runs.some(
      (run) =>
        run.start.data.runId === data.runId ||
        (invocationOwnerKey(run.start.data.owner) === invocationOwnerKey(data.owner) &&
          run.start.data.callId === data.callId),
    ) ||
    view.runs.filter(
      (run) => invocationOwnerKey(run.start.data.owner) === invocationOwnerKey(data.owner),
    ).length >= 128 ||
    view.runs.some(
      (run) =>
        invocationOwnerKey(run.start.data.owner) === invocationOwnerKey(data.owner) &&
        !run.observed?.data.closed,
    )
  )
    fail();
  const actual = checkInvocationSource(data, journal, position);
  if (
    actual.toolCallId !== data.callId ||
    actual.toolName !== "run_check" ||
    invocationOwnerKey(actual.owner) !== invocationOwnerKey(data.owner) ||
    actual.inputDigest !==
      journalDigest(JSON.stringify({ checkId: definition.data.spec.checkId })) ||
    data.scopeDigest !== contract.data.scopeDigest ||
    journalDigest(data.sourceRef) !== journalDigest(contract.data.sourceRef) ||
    selectedAcceptanceContract(view, data.owner)?.entryId !== contract.entryId
  )
    fail();
}
function consumeCheckFact(
  view: AcceptanceJournalView,
  node: JournalNode,
  data: AcceptanceCheckStarted | AcceptanceCheckObserved,
  journal: SessionJournal,
  position: number,
): void {
  if (data.kind === "acceptance-check-started") {
    assertCheckStart(view, data, journal, position);
    view.runs.push({ start: { entryId: node.id, digest: node.digest, data } });
    return;
  }
  const run = view.runs.find(
    (item) =>
      item.start.entryId === data.startedRef.entryId &&
      item.start.digest === data.startedRef.digest,
  );
  if (
    !run ||
    run.observed ||
    run.start.data.runId !== data.runId ||
    invocationOwnerKey(run.start.data.owner) !== invocationOwnerKey(data.owner) ||
    journalDigest(run.start.data.sourceRef) !== journalDigest(data.sourceRef)
  )
    fail();
  const { definition } = runSources(view, run.start.data);
  if (
    journalDigest(definition.data.invocation) !== journalDigest(data.invocation) ||
    (data.closed && data.termination === "unknown")
  )
    fail();
  run.observed = { entryId: node.id, digest: node.digest, data };
}
export function isAcceptanceWitness(node: JournalNode, journal: SessionJournal): boolean {
  if (
    node.customType !== "continuous-tasks:human-readback" ||
    !node.data ||
    typeof node.data !== "object" ||
    !("controlEntryId" in node.data) ||
    typeof node.data.controlEntryId !== "string"
  )
    return false;
  const control = journal.nodes.get(node.data.controlEntryId);
  return (
    control?.customType === ACCEPTANCE_FACT_ENTRY &&
    !!control.data &&
    typeof control.data === "object" &&
    "kind" in control.data &&
    (control.data.kind === "acceptance-manual-control" ||
      control.data.kind === "acceptance-contract-control" ||
      control.data.kind === "acceptance-scope-control")
  );
}
export function manualCheckSubject(
  bound: AcceptanceBoundFact,
  definition: AcceptanceDefinitionFact,
  versionId: string,
  inputGeneration: string,
  originalGoal: string,
) {
  const spec = definition.spec;
  if (spec.kind !== "manual") fail();
  return {
    protocol: "manual-condition-check-v1",
    originalGoal,
    owner: bound.owner,
    contractDigest: bound.contractDigest,
    definitionDigest: definition.definitionDigest,
    checkId: spec.checkId,
    conditions: bound.header.requirements.filter((item) =>
      spec.requirementIds.includes(item.requirementId),
    ),
    scopeId: bound.header.scopeId,
    workspace: bound.workspace,
    scopeDigest: bound.scopeDigest,
    inputs: bound.header.inputs,
    artifacts: bound.header.artifacts,
    versionId,
    inputGeneration,
    question: spec.question,
    response: spec.response,
    expectedValue: spec.expectedValue,
  };
}
function manualControlSources(view: AcceptanceJournalView, data: ManualCheckBindingV1) {
  const bound = selectedAcceptanceContract(view, data.owner),
    definition = view.definitions.find(
      (item) =>
        item.entryId === data.definitionRef.entryId && item.digest === data.definitionRef.digest,
    );
  if (
    !bound ||
    !definition ||
    definition.data.spec.kind !== "manual" ||
    bound.entryId !== data.contractRef.entryId ||
    bound.digest !== data.contractRef.digest ||
    journalDigest(data.sourceRef) !== journalDigest(bound.data.sourceRef) ||
    !bound.data.definitions.some(
      (item) => item.ref.entryId === definition.entryId && item.ref.digest === definition.digest,
    )
  )
    fail();
  return { bound, definition, response: definition.data.spec.response };
}
function nativeSequenceAt(
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph,
): number {
  let sequence = 0;
  for (const node of graph.nodes.values()) {
    if (!beforePosition(journal, node.start.ref, position)) continue;
    if (!node.end || !beforePosition(journal, node.end.ref, position)) fail();
    sequence = Math.max(sequence, node.start.sequence, node.end.sequence);
  }
  return sequence;
}
function assertManualControl(
  view: AcceptanceJournalView,
  data: ManualCheckBindingV1,
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph | undefined,
): void {
  assertScopeExecutionSource(view, journal, data.owner, position);
  const { bound, definition, response } = manualControlSources(view, data);
  if (
    view.manualChecks.some(
      (item) => !item.witness || item.control.data.frame.requestId === data.frame.requestId,
    ) ||
    view.manualChecks.filter(
      (item) => invocationOwnerKey(item.control.data.owner) === invocationOwnerKey(data.owner),
    ).length >= 128
  )
    fail();
  const subject = manualCheckSubject(
    bound.data,
    definition.data,
    data.versionId,
    data.inputGeneration,
    acceptanceGoalSource(journal, data.owner, data.sourceRef, position),
  );
  if (
    data.frame.sessionId !== journal.sessionId ||
    data.frame.baseEntryId !== data.sourceRef.entryId ||
    data.frame.baseEntryDigest !== data.sourceRef.digest ||
    data.frame.scopeDigest !== journalDigest(subject) ||
    !graph
  )
    fail();
  if (nativeSequenceAt(journal, position, graph) !== data.sourceSequence) fail();
  if (
    response.kind === "choice"
      ? !response.options.includes(data.value)
      : !validDecisionInformation(
          { version: 1, kind: "information", format: response.format },
          data.value,
        )
  )
    fail();
}
function nativeWitnessSchema() {
  return Type.Object(
    {
      version: Type.Literal(1),
      controlEntryId: id(),
      controlDigest: hash,
      frame: GoalReadbackFrameSchema,
    },
    strict,
  );
}
function consumeManualWitness(view: AcceptanceJournalView, node: JournalNode): void {
  if (!Check(nativeWitnessSchema(), node.data)) fail();
  const value = node.data,
    manual =
      view.manualChecks.find((item) => item.control.entryId === value.controlEntryId) ??
      view.contractReviews.find((item) => item.control.entryId === value.controlEntryId) ??
      view.scopeReviews?.find((item) => item.control.entryId === value.controlEntryId);
  if (
    !manual ||
    manual.witness ||
    manual.control.digest !== value.controlDigest ||
    journalDigest(manual.control.data.frame) !== journalDigest(value.frame)
  )
    fail();
  manual.witness = { entryId: node.id, digest: node.digest };
}
export function manualCheckObservations(
  view: AcceptanceJournalView,
  bound: AcceptanceFactView<AcceptanceBoundFact>,
): CheckObservationV1[] {
  return view.manualChecks.flatMap((item) => {
    const data = item.control.data,
      witness = item.witness;
    if (!witness || data.contractRef.entryId !== bound.entryId) return [];
    const definition = view.definitions.find(
      (entry) => entry.entryId === data.definitionRef.entryId,
    )?.data;
    if (!definition || definition.spec.kind !== "manual") return [];
    return [
      {
        kind: "manual" as const,
        checkId: definition.spec.checkId,
        definitionDigest: definition.definitionDigest,
        contractDigest: bound.data.contractDigest,
        owner: data.owner,
        receiptRef: witness,
        versionId: data.versionId,
        inputGeneration: data.inputGeneration,
        outcome:
          data.value === definition.spec.expectedValue ? ("passed" as const) : ("failed" as const),
        value: data.value,
        controlRef: { entryId: item.control.entryId, digest: item.control.digest },
        witnessRef: witness,
      },
    ];
  });
}
export function contractReviewSubject(
  data: Pick<
    AcceptanceBoundFact,
    | "owner"
    | "sourceRef"
    | "contractId"
    | "revision"
    | "previousRef"
    | "header"
    | "workspace"
    | "scopeDigest"
    | "checkerScopes"
  >,
  definitions: readonly AcceptanceDefinitionFact[],
  proposal: ContractProposalView,
  versionId: string,
  inputGeneration: string,
  originalGoal: string,
) {
  return {
    protocol: "acceptance-definition-review-v1",
    originalGoal,
    owner: data.owner,
    sourceRef: data.sourceRef,
    proposalRef: { entryId: proposal.entryId, digest: proposal.digest },
    contractId: data.contractId,
    revision: data.revision,
    previousRef: data.previousRef,
    header: data.header,
    workspace: data.workspace,
    scopeDigest: data.scopeDigest,
    ...(data.checkerScopes !== undefined ? { checkerScopes: data.checkerScopes } : {}),
    checkDefinitions: definitions.map((item) => ({
      spec: item.spec,
      frozenFiles: item.frozenFiles,
      environmentDigest: item.environmentDigest,
      invocation: item.invocation,
      definitionDigest: item.definitionDigest,
      ...(item.checkerWorkspace ? { checkerWorkspace: item.checkerWorkspace } : {}),
    })),
    versionId,
    inputGeneration,
  };
}
function assertContractReviewControl(
  view: AcceptanceJournalView,
  data: ContractReviewControl,
  journal: SessionJournal,
  position: number,
): void {
  const proposal = contractProposalViews(journal).find(
    (item) => item.entryId === data.proposalRef.entryId && item.digest === data.proposalRef.digest,
  );
  if (
    !proposal ||
    !beforePosition(journal, data.proposalRef, position) ||
    view.contractReviews.some(
      (item) => item.control.data.frame.requestId === data.frame.requestId || !item.witness,
    )
  )
    fail();
  proposalForGoal(journal, proposal, data.owner, data.sourceRef);
  if (
    data.frame.sessionId !== journal.sessionId ||
    data.frame.baseEntryId !== data.sourceRef.entryId ||
    data.frame.baseEntryDigest !== data.sourceRef.digest
  )
    fail();
}
function assertReviewedAuthority(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceDefinitionFact[],
  view: AcceptanceJournalView,
  journal: SessionJournal,
  position: number,
): void {
  if (data.authority.kind === "scope-revision-reviewed") {
    assertScopeBound(data, definitions, view, journal, position);
    return;
  }
  if (data.authority.kind === "preflight-reviewed") {
    assertPreflightReviewedAuthority(data, definitions, journal, position);
    return;
  }
  if (data.authority.kind !== "native-reviewed") return;
  const controlRef = data.authority.controlRef,
    review = view.contractReviews.find(
      (item) =>
        item.control.entryId === controlRef.entryId && item.control.digest === controlRef.digest,
    );
  if (
    !review?.witness ||
    review.control.data.value !== "绑定此契约" ||
    review.control.data.contractId !== data.contractId ||
    review.control.data.revision !== data.revision ||
    !beforePosition(journal, review.witness, position)
  )
    fail();
  const control = review.control.data,
    proposal = contractProposalViews(journal).find(
      (item) =>
        item.entryId === control.proposalRef.entryId && item.digest === control.proposalRef.digest,
    );
  if (
    !proposal ||
    !isDeepStrictEqual(
      { ...data.header, checks: definitions.map((item) => item.spec) },
      proposal.data.proposal,
    )
  )
    fail();
  const subject = contractReviewSubject(
    data,
    definitions,
    proposal,
    control.versionId,
    control.inputGeneration,
    acceptanceGoalSource(journal, data.owner, data.sourceRef, position),
  );
  if (
    journalDigest(subject) !== control.frame.scopeDigest ||
    invocationOwnerKey(control.owner) !== invocationOwnerKey(data.owner)
  )
    fail();
}
type ConfirmedApprovalSource = ReturnType<typeof confirmedApprovalDefinitionSource>;
function assertAssociationMaterial(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceDefinitionFact[],
  journal: SessionJournal,
  position: number,
  permission: ConfirmedApprovalSource,
  definition: ConfirmedApprovalSource,
): void {
  const binding = journal.nodes.get(data.sourceRef.entryId)?.supervisorProof?.preflightBinding;
  const expected = {
    preflightId: permission.base.preflightId,
    planId: permission.base.planId,
    planDigest: permission.base.planDigest,
  };
  if (
    permission.control.kind !== "approve" ||
    !isDeepStrictEqual(binding, expected) ||
    permission.base.planDigest !== definition.base.planDigest ||
    !isDeepStrictEqual(permission.capture.workspace, definition.capture.workspace) ||
    !isDeepStrictEqual(definition.capture.workspace, data.workspace) ||
    definition.capture.pendingChecks.length ||
    permission.base.proposal?.permissions.some(
      (item) => item.required && !permission.control.permissionIds.includes(item.id),
    ) ||
    !isDeepStrictEqual(
      { ...data.header, checks: definitions.map((item) => item.spec) },
      definition.proposal.data.proposal,
    ) ||
    !beforePosition(
      journal,
      { entryId: permission.proof.witness.id, digest: permission.proof.witness.digest },
      position,
    ) ||
    !beforePosition(
      journal,
      { entryId: definition.proof.witness.id, digest: definition.proof.witness.digest },
      position,
    )
  )
    fail();
}
function assertAssociationOwner(
  owner: Extract<WorkOwnerKey, { kind: "goal" }>,
  authority: Extract<AcceptanceBoundFact["authority"], { kind: "preflight-reviewed" }>,
  permission: ConfirmedApprovalSource,
  definition: ConfirmedApprovalSource,
): void {
  const scope = definition.goalScope;
  if (
    scope
      ? scope.goalRunId !== owner.goal.goalRunId ||
        scope.lifecycleCommitId !== owner.goal.lifecycleCommitId
      : owner.goal.goalRunId !== null
  )
    fail();
  if (definition.control.kind === "define") {
    if (
      !isDeepStrictEqual(
        definition.base.permissionRequest?.businessApproval,
        authority.permissionControlRef,
      ) ||
      !isDeepStrictEqual(definition.control.permissionIds, permission.control.permissionIds)
    )
      fail();
  } else if (!isDeepStrictEqual(authority.permissionControlRef, authority.definitionControlRef))
    fail();
}
function assertNoLaterApprovalChanges(
  journal: SessionJournal,
  position: number,
  definition: ConfirmedApprovalSource,
): void {
  const start = journal.branch.findIndex((node) => node.id === definition.proof.witness.id);
  for (const node of journal.branch.slice(start + 1, position)) {
    if (
      node.customType !== "continuous-tasks:preflight-control" ||
      !node.data ||
      typeof node.data !== "object"
    )
      continue;
    const later = node.data as { preflightId?: unknown; kind?: unknown };
    if (later.preflightId === definition.base.preflightId && later.kind !== "start") fail();
  }
}
function capturedCheckerMatches(
  item: AcceptanceDefinitionFact,
  frozen: ConfirmedApprovalSource["capture"]["checkers"][number] | undefined,
  capture: ConfirmedApprovalSource["capture"],
  workspace: AcceptanceBoundFact["workspace"],
): boolean {
  if (!frozen || !item.invocation) return false;
  const { nodeVersion, platform, ...command } = item.invocation;
  const invocationMatches = frozen.invocation
    ? isDeepStrictEqual(frozen.invocation, command)
    : item.invocation.executable === capture.executable;
  return (
    isDeepStrictEqual(frozen.files, item.frozenFiles) &&
    isDeepStrictEqual(frozen.workspace, item.checkerWorkspace ?? workspace) &&
    item.environmentDigest === capture.environmentDigest &&
    invocationMatches &&
    nodeVersion === capture.nodeVersion &&
    platform === capture.platform
  );
}
/** Exact metadata match only, not provenance or authority. Reused before producer
 * writes so a repair cannot append refreshed bytes under an old confirmation. */
export function assertCapturedApprovalDefinitions(
  data: Pick<AcceptanceBoundFact, "workspace">,
  definitions: readonly AcceptanceDefinitionFact[],
  definition: ConfirmedApprovalSource,
): void {
  const automatic = definitions.filter((item) => item.spec.kind === "automatic");
  if (
    !isDeepStrictEqual(data.workspace, definition.capture.workspace) ||
    automatic.length !== definition.capture.checkers.length
  )
    fail();
  for (const item of automatic) {
    const frozen = definition.capture.checkers.find((row) => row.checkId === item.spec.checkId);
    if (!capturedCheckerMatches(item, frozen, definition.capture, data.workspace)) fail();
  }
}
function assertPreflightReviewedAuthority(
  data: AcceptanceBoundFact,
  definitions: readonly AcceptanceDefinitionFact[],
  journal: SessionJournal,
  position: number,
): void {
  if (data.authority.kind !== "preflight-reviewed" || data.owner.kind !== "goal") fail();
  const permission = confirmedApprovalDefinitionSource(
    journal,
    data.authority.permissionControlRef,
  );
  const definition = confirmedApprovalDefinitionSource(
    journal,
    data.authority.definitionControlRef,
  );
  assertAssociationMaterial(data, definitions, journal, position, permission, definition);
  assertAssociationOwner(data.owner, data.authority, permission, definition);
  assertNoLaterApprovalChanges(journal, position, definition);
  assertCapturedApprovalDefinitions(data, definitions, definition);
}
export function acceptanceRunActivityIssue(
  view: AcceptanceJournalView | undefined,
  sessionId: string,
): string | undefined {
  if (view?.contractReviews.some((item) => !item.witness))
    return "A native contract definition response has no confirmed witness; inspect before changing owner";
  if (
    view?.manualChecks.some(
      (item) =>
        !item.witness &&
        (item.control.data.owner.kind === "goal"
          ? item.control.data.owner.goal.sessionId
          : item.control.data.owner.board.sessionId) === sessionId,
    )
  )
    return "A native artifact response has no confirmed physical witness; inspect before changing owner";
  return view?.runs.some(
    (run) =>
      (run.start.data.owner.kind === "goal"
        ? run.start.data.owner.goal.sessionId
        : run.start.data.owner.board.sessionId) === sessionId && !run.observed?.data.closed,
  )
    ? "A native declared check remains unclosed/unknown; inspect without replay or dropping its owner"
    : undefined;
}
function beforePosition(
  journal: SessionJournal,
  ref: AcceptanceReference,
  position: number,
): JournalNode | undefined {
  const node = journal.nodes.get(ref.entryId),
    index = journal.branch.findIndex((item) => item.id === ref.entryId);
  return node && node.digest === ref.digest && index >= 0 && index < position ? node : undefined;
}
function closedHistoricalObservation(run: AcceptanceCheckRun): boolean {
  const value = run.observed?.data,
    start = run.start.data;
  return (
    !!value &&
    value.closed &&
    value.termination === "exited" &&
    value.exitCode === 0 &&
    value.result !== null &&
    value.beforeVersionId === start.versionId &&
    value.afterVersionId === start.versionId &&
    value.beforeGeneration === start.inputGeneration &&
    value.afterGeneration === start.inputGeneration
  );
}
function historicalKernel(
  run: AcceptanceCheckRun,
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph,
) {
  const start = run.start.data,
    node = graph.nodes.get(graph.calls.get(invocationCallKey(start.owner, start.callId)) ?? "");
  if (
    !node?.end ||
    node.end.outcome !== "returned" ||
    node.end.exitCode !== 0 ||
    !node.end.receiptRef ||
    !beforePosition(journal, node.end.ref, position)
  )
    return undefined;
  return { node, receiptId: node.end.receiptId, receiptRef: node.end.receiptRef };
}
function historicalCheckNode(
  run: AcceptanceCheckRun,
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph,
): InvocationNodeV1 | undefined {
  if (!closedHistoricalObservation(run)) return undefined;
  const kernel = historicalKernel(run, journal, position, graph);
  if (!kernel) return undefined;
  const { node } = kernel;
  const receipt = beforePosition(journal, kernel.receiptRef, position)?.receiptProof?.receipt;
  if (
    !receipt?.ok ||
    receipt.exitCode !== 0 ||
    receipt.tool !== "run_check" ||
    receipt.id !== kernel.receiptId
  )
    return undefined;
  if (node.parentId !== null) {
    const seal = graph.seals.get(node.rootId);
    if (seal?.data.outcome !== "qualified" || !beforePosition(journal, seal.ref, position))
      return undefined;
  }
  return node;
}
function historicalWriter(
  run: AcceptanceCheckRun,
  view: AcceptanceJournalView,
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph,
): boolean {
  const node = historicalCheckNode(run, journal, position, graph);
  if (!node) return true;
  const known = new Set(
    view.runs.map((item) => historicalCheckNode(item, journal, position, graph)?.operationId),
  );
  return [...graph.nodes.values()].some((other) => {
    if (
      invocationOwnerKey(other.owner) !== invocationOwnerKey(node.owner) ||
      other.effect !== "write" ||
      known.has(other.operationId) ||
      !beforePosition(journal, other.start.ref, position)
    )
      return false;
    const seal = graph.seals.get(other.rootId);
    if (
      other.capability === SDK_TOOL_ONLY_CAPABILITY &&
      seal?.data.outcome === "qualified" &&
      beforePosition(journal, seal.ref, position)
    )
      return false;
    return (
      !other.end ||
      !beforePosition(journal, other.end.ref, position) ||
      other.end.sequence >= node.start.sequence
    );
  });
}
function historicalObservations(
  view: AcceptanceJournalView,
  bound: AcceptanceFactView<AcceptanceBoundFact>,
): CheckObservationV1[] {
  const contract = acceptanceContractValue(bound, view);
  const automatic = view.runs.flatMap((run) => {
    const observed = run.observed;
    if (!observed || run.start.data.contractRef.entryId !== bound.entryId) return [];
    const spec = view.definitions.find(
      (item) => item.entryId === run.start.data.definitionRef.entryId,
    )?.data.spec;
    const check = contract.checks.find((item) => item.checkId === spec?.checkId);
    if (!check || check.kind !== "automatic") return [];
    const value = observed.data;
    return [
      {
        kind: "automatic" as const,
        checkId: check.checkId,
        definitionDigest: check.definitionDigest,
        contractDigest: contract.digest,
        owner: contract.owner,
        receiptRef: { entryId: observed.entryId, digest: observed.digest },
        versionId: value.beforeVersionId,
        inputGeneration: value.beforeGeneration,
        invocationDigest: journalDigest(["native-check-invocation-v1", value.invocation]),
        environmentDigest: value.invocation.environmentDigest,
        checkerDigest: check.checkerDigest,
        outcome:
          value.closed && value.termination === "exited" && value.exitCode === 0 && value.result
            ? ("passed" as const)
            : ("failed" as const),
        exitCode: value.exitCode,
        result: value.result ?? {
          tests: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          requiredCases: {},
          skippedIds: [],
        },
      },
    ];
  });
  return [...automatic, ...manualCheckObservations(view, bound)];
}
function historicalManualWriter(
  manual: ManualCheckEntry,
  view: AcceptanceJournalView,
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph,
): boolean {
  const source = manual.control.data,
    known = new Set(
      view.runs.map((run) => historicalCheckNode(run, journal, position, graph)?.operationId),
    );
  return [...graph.nodes.values()].some((node) => {
    if (
      invocationOwnerKey(node.owner) !== invocationOwnerKey(source.owner) ||
      node.effect !== "write" ||
      node.start.sequence <= source.sourceSequence ||
      known.has(node.operationId) ||
      !beforePosition(journal, node.start.ref, position)
    )
      return false;
    const seal = graph.seals.get(node.rootId);
    return !(
      node.capability === SDK_TOOL_ONLY_CAPABILITY &&
      seal?.data.outcome === "qualified" &&
      beforePosition(journal, seal.ref, position)
    );
  });
}
function reviewBindingSource(
  view: AcceptanceJournalView,
  data: AcceptanceReviewBound,
  journal: SessionJournal,
  position: number,
) {
  const bound = selectedAcceptanceContract(view, data.owner),
    source = beforePosition(journal, data.reviewStartedRef, position);
  if (
    !bound ||
    bound.entryId !== data.contractRef.entryId ||
    bound.digest !== data.contractRef.digest ||
    !source ||
    !Check(ReviewAttemptStartedSchema, source.data)
  )
    fail();
  return { bound, start: source.data };
}
function assertReviewBound(
  view: AcceptanceJournalView,
  data: AcceptanceReviewBound,
  journal: SessionJournal,
  position: number,
  graph: InvocationGraph | undefined,
): void {
  if (!graph) fail();
  const { bound, start } = reviewBindingSource(view, data, journal, position);
  if (
    invocationOwnerKey(start.owner) !== invocationOwnerKey(data.owner) ||
    start.boardDigest !== data.boardDigest ||
    start.bindingsDigest !== data.bindingsDigest ||
    start.epoch !== data.epoch ||
    view.reviewBindings.some(
      (item) => item.data.reviewStartedRef.entryId === data.reviewStartedRef.entryId,
    )
  )
    fail();
  for (const ref of data.observations) {
    const run = view.runs.find(
      (item) => item.observed?.entryId === ref.entryId && item.observed.digest === ref.digest,
    );
    if (run) {
      if (historicalWriter(run, view, journal, position, graph)) fail();
      continue;
    }
    const manual = view.manualChecks.find(
      (item) => item.witness?.entryId === ref.entryId && item.witness.digest === ref.digest,
    );
    if (!manual || historicalManualWriter(manual, view, journal, position, graph)) fail();
  }
  const result = checkContractAcceptance(
    acceptanceContractValue(bound, view),
    historicalObservations(view, bound),
    {
      versionId: data.versionId,
      inputGeneration: data.inputGeneration,
      qualifiedReceipts: data.observations,
    },
  );
  if (result.status !== "passed") fail();
}
function requiresActiveOwner(data: AcceptanceFact): boolean {
  return (
    data.kind === "acceptance-definition-declared" ||
    data.kind === "acceptance-contract-bound" ||
    data.kind === "acceptance-check-started" ||
    data.kind === "acceptance-scope-control" ||
    data.kind === "scope-revision-committed" ||
    data.kind === "scope-revision-revoked"
  );
}
/** Caller supplies only actual preceding-fenced physical nodes in causal order. */
function assertApprovalFeature(
  journal: SessionJournal,
  data: AcceptanceFact,
  position: number,
): void {
  const scope =
    isScopeFact(data) ||
    (data.kind === "acceptance-contract-bound" &&
      data.authority.kind === "scope-revision-reviewed");
  if (
    scope &&
    !journal.branch
      .slice(0, position)
      .some(
        (node) =>
          node.customType === "continuous-tasks:supervisor" &&
          validControlFence(node.data) &&
          node.data.features.includes("scope-revision-v1"),
      )
  )
    fail();
  const extended =
    (data.kind === "acceptance-definition-declared" &&
      (data.checkerWorkspace || data.invocation?.profile)) ||
    (data.kind === "acceptance-contract-bound" && data.checkerScopes !== undefined) ||
    (data.kind === "acceptance-check-observed" && (data.temporary || data.invocation.profile));
  if (
    extended &&
    !journal.branch
      .slice(0, position)
      .some(
        (entry) =>
          entry.customType === "continuous-tasks:supervisor" &&
          validControlFence(entry.data) &&
          entry.data.features.includes("approval-workflow-v1"),
      )
  )
    fail();
}
function consumeScopeFact(
  view: AcceptanceJournalView,
  node: JournalNode,
  data: AcceptanceFact,
  journal: SessionJournal,
  position: number,
): boolean {
  if (data.kind === "acceptance-scope-control") {
    assertScopeControl(view, data, journal, position);
    view.scopeReviews?.push({ control: { entryId: node.id, digest: node.digest, data } });
  } else if (data.kind === "scope-revision-committed") {
    assertScopeCommit(view, data, journal, position);
    view.scopeCommits?.push({ entryId: node.id, digest: node.digest, data });
  } else if (data.kind === "scope-revision-revoked") {
    assertScopeRevocation(view, data, journal, position);
    view.scopeRevocations?.push({ entryId: node.id, digest: node.digest, data });
  } else return false;
  return true;
}
export function readAcceptanceFacts(
  journal: SessionJournal,
  records: readonly JournalNode[],
  graph?: InvocationGraph,
): AcceptanceJournalView {
  const view: AcceptanceJournalView = {
      definitions: [],
      contracts: [],
      runs: [],
      reviewBindings: [],
      manualChecks: [],
      contractReviews: [],
      scopeReviews: [],
      scopeCommits: [],
      scopeRevocations: [],
      scopeProposals: scopeRevisionProposalViews(journal),
    },
    ids = new Set<string>();
  for (const node of records) {
    if (node.customType === "continuous-tasks:human-readback") {
      consumeManualWitness(view, node);
      continue;
    }
    if (!validAcceptanceFact(node.data, journal.sessionId) || ids.has(node.data.recordId)) fail();
    const data = node.data,
      position = journal.branch.findIndex((item) => item.id === node.id);
    if (position < 0) fail();
    assertApprovalFeature(journal, data, position);
    if (requiresActiveOwner(data)) assertCurrentOwner(journal, data, position);
    acceptanceGoalSource(journal, data.owner, data.sourceRef, position);
    if (isScopeFact(data)) {
      consumeScopeFact(view, node, data, journal, position);
      ids.add(data.recordId);
      continue;
    }
    if (data.kind === "acceptance-definition-declared") {
      if (
        view.definitions.filter(
          (item) => invocationOwnerKey(item.data.owner) === invocationOwnerKey(data.owner),
        ).length >= 256
      )
        fail();
      assertDefinition(data);
      view.definitions.push({ entryId: node.id, digest: node.digest, data });
    } else if (data.kind === "acceptance-contract-bound") {
      assertBound(data, view, journal, position);
      view.contracts.push({ entryId: node.id, digest: node.digest, data });
    } else if (data.kind === "acceptance-review-bound") {
      assertReviewBound(view, data, journal, position, graph);
      view.reviewBindings.push({ entryId: node.id, digest: node.digest, data });
    } else if (data.kind === "acceptance-manual-control") {
      assertManualControl(view, data, journal, position, graph);
      view.manualChecks.push({ control: { entryId: node.id, digest: node.digest, data } });
    } else if (data.kind === "acceptance-contract-control") {
      assertContractReviewControl(view, data, journal, position);
      view.contractReviews.push({ control: { entryId: node.id, digest: node.digest, data } });
    } else consumeCheckFact(view, node, data, journal, position);
    ids.add(data.recordId);
  }
  return view;
}
export function selectedAcceptanceContract(
  view: AcceptanceJournalView | undefined,
  owner: WorkOwnerKey,
): AcceptanceFactView<AcceptanceBoundFact> | undefined {
  return view?.contracts
    .filter(
      (entry) =>
        invocationOwnerKey(entry.data.owner) === invocationOwnerKey(owner) &&
        (entry.data.authority.kind !== "scope-revision-reviewed" ||
          view.scopeCommits?.some(
            (commit) =>
              commit.data.contractRef.entryId === entry.entryId &&
              commit.data.contractRef.digest === entry.digest,
          )),
    )
    .at(-1);
}
export function acceptanceContractValue(
  entry: AcceptanceFactView<AcceptanceBoundFact>,
  view: AcceptanceJournalView,
): AcceptanceContractV1 {
  const data = entry.data,
    definitions = boundDefinitions(data, view.definitions);
  const checks: CheckDefinitionV1[] = definitions.map((item) =>
    item.spec.kind === "manual"
      ? {
          kind: "manual",
          checkId: item.spec.checkId,
          requirementIds: item.spec.requirementIds,
          definitionDigest: item.definitionDigest,
          expectedValue: item.spec.expectedValue,
        }
      : {
          kind: "automatic",
          checkId: item.spec.checkId,
          requirementIds: item.spec.requirementIds,
          definitionDigest: item.definitionDigest,
          invocationDigest: journalDigest(["native-check-invocation-v1", item.invocation]),
          environmentDigest: item.environmentDigest,
          checkerDigest: journalDigest(["check-files-v1", item.frozenFiles]),
          expected: item.spec.expected,
        },
  );
  return {
    version: 1,
    contractId: data.contractId,
    revision: data.revision,
    owner: data.owner,
    digest: data.contractDigest,
    sourceRef: data.sourceRef,
    requirements: data.header.requirements,
    checks,
    scopeId: data.header.scopeId,
    scopeDigest: data.scopeDigest,
  };
}
