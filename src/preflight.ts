import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import {
  ReadbackFrameSchema,
  findReadbackProof,
  inspectSessionJournal,
  journalDigest,
  type ReadbackFrame,
  type ReadbackProof,
} from "./human-journal";
import {
  sessionJournalView,
  saveReadbackProjection,
  inspectRestorableSession,
} from "./human-control";
import { requireNativeAnswer, type NativeAnswer } from "./human-ui";
import {
  readSupervisorStartRecord,
  SUPERVISOR_ENTRY,
  type SupervisorStartRecord,
  type SupervisorState,
} from "./supervisor";
import { currentRuntime } from "./runtime";
import { getBoardRef } from "./state";
import { isSafeBoundedText } from "./validation";

export const PREFLIGHT_ENTRY = "continuous-tasks:preflight";
export const PREFLIGHT_CONTROL_ENTRY = "continuous-tasks:preflight-control";
const MAX_PROPOSAL_BYTES = 16_000;
const text = (max: number) => Type.String({ minLength: 1, maxLength: max });
const strings = (minimum = 0) => Type.Array(text(1000), { minItems: minimum, maxItems: 20 });
const strict = { additionalProperties: false };

const PermissionSchema = Type.Object(
  {
    id: text(64),
    action: text(500),
    target: text(500),
    environment: text(500),
    required: Type.Boolean(),
    limits: text(1000),
    risks: text(1000),
    fallback: text(1000),
    reconfirm: text(1000),
  },
  strict,
);
export const PreflightProposalSchema = Type.Object(
  {
    summary: text(2000),
    steps: strings(1),
    acceptance: strings(1),
    permissions: Type.Array(PermissionSchema, { maxItems: 20 }),
    prohibitions: strings(),
    reconfirm: strings(),
  },
  strict,
);
export type PreflightProposal = Static<typeof PreflightProposalSchema>;
export const SubmitPreflightParams = Type.Object(
  { preflightId: text(100), proposal: PreflightProposalSchema },
  strict,
);
export function validPreflightSubmission(value: unknown): boolean {
  return Check(SubmitPreflightParams, value);
}
export const PreflightBindingSchema = Type.Object(
  { preflightId: text(100), planId: text(120), planDigest: text(64) },
  strict,
);
export type PreflightBinding = Static<typeof PreflightBindingSchema>;
export const LegacyPreflightControlSchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("approve"), Type.Literal("revoke")]),
    sessionId: text(200),
    preflightId: text(100),
    planId: text(120),
    planDigest: text(64),
    permissionIds: Type.Array(text(64), { maxItems: 20 }),
    createdAt: text(100),
  },
  strict,
);

export const LegacyPreflightStateSchema = Type.Object(
  {
    version: Type.Literal(1),
    sessionId: text(200),
    preflightId: text(100),
    goal: text(4000),
    phase: Type.Union([
      Type.Literal("planning"),
      Type.Literal("awaiting_authorization"),
      Type.Literal("approved"),
      Type.Literal("started"),
      Type.Literal("revoked"),
      Type.Literal("interrupted"),
    ]),
    revision: Type.Integer({ minimum: 0 }),
    planId: Type.Optional(text(120)),
    planDigest: Type.Optional(text(64)),
    proposal: Type.Optional(PreflightProposalSchema),
    approval: Type.Optional(
      Type.Object(
        {
          planId: text(120),
          planDigest: text(64),
          permissionIds: Type.Array(text(64), { maxItems: 20 }),
          controlEntryId: text(200),
          createdAt: text(100),
        },
        strict,
      ),
    ),
    started: Type.Optional(Type.Object({ goal: text(4000), startedAt: text(100) }, strict)),
  },
  strict,
);
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
export const PreflightSupersedesSchema = Type.Union([
  Type.Object({ requestId: uuid, controlEntryId: Type.Optional(text(200)) }, strict),
  Type.Object({ legacyControlEntryId: text(200) }, strict),
]);
export const PreflightRequestSchema = Type.Object(
  {
    id: uuid,
    supersedes: Type.Optional(PreflightSupersedesSchema),
    permissionIds: Type.Optional(Type.Array(text(64), { maxItems: 20 })),
  },
  strict,
);
const nativeCommon = {
  version: Type.Literal(2),
  sessionId: text(200),
  preflightId: text(100),
  planId: text(120),
  planDigest: hash,
  permissionIds: Type.Array(text(64), { maxItems: 20 }),
  createdAt: text(100),
  humanInteraction: ReadbackFrameSchema,
  supersedes: Type.Optional(PreflightSupersedesSchema),
};
export const NativePreflightControlSchema = Type.Union([
  Type.Object(
    { ...nativeCommon, kind: Type.Literal("approve"), answer: Type.Literal("Approve") },
    strict,
  ),
  Type.Object(
    { ...nativeCommon, kind: Type.Literal("reject"), answer: Type.Literal("Reject") },
    strict,
  ),
  Type.Object(
    {
      ...nativeCommon,
      kind: Type.Literal("start"),
      answer: Type.Literal("Start execution"),
      approvalControlEntryId: text(200),
      approvalControlDigest: hash,
    },
    strict,
  ),
]);
export const NativePreflightStateSchema = Type.Object(
  {
    ...LegacyPreflightStateSchema.properties,
    version: Type.Literal(2),
    permissionRequest: Type.Optional(PreflightRequestSchema),
    startRequest: Type.Optional(PreflightRequestSchema),
    started: Type.Optional(
      Type.Union([
        Type.Object(
          {
            goal: text(4000),
            startedAt: text(100),
            controlEntryId: text(200),
            approvalControlEntryId: text(200),
          },
          strict,
        ),
        Type.Object({ goal: text(4000), startedAt: text(100) }, strict),
      ]),
    ),
  },
  strict,
);
export const PreflightStateSchema = Type.Union([
  LegacyPreflightStateSchema,
  NativePreflightStateSchema,
]);
export const PreflightControlSchema = Type.Union([
  LegacyPreflightControlSchema,
  NativePreflightControlSchema,
]);
export type NativePreflightControl = Static<typeof NativePreflightControlSchema>;
export type NativePermissionControl = Extract<
  NativePreflightControl,
  { kind: "approve" | "reject" }
>;
export type NativeStartControl = Extract<NativePreflightControl, { kind: "start" }>;
export type PreflightControl = Static<typeof PreflightControlSchema>;
export type PreflightState = Static<typeof PreflightStateSchema>;
export type NativePreflightStartResponse = { answer: NativeAnswer; frame: ReadbackFrame };
type ConfirmedProof = Extract<ReadbackProof, { status: "confirmed" }>;

function controlIssue(ctx: ExtensionContext): string | undefined {
  if (currentRuntime().journalFault) return currentRuntime().journalFault;
  if (!ctx.isIdle() || ctx.hasPendingMessages())
    return "Wait for Main and pending messages before preflight control";
  return undefined;
}
function requireOwn(ctx: ExtensionContext): PreflightState {
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("No current-session preflight; use the human preflight command first");
  return state;
}
function failPersistence(message: string): never {
  currentRuntime().cancel();
  currentRuntime().journalFault = message;
  throw new Error(message);
}
function savePreflight(pi: ExtensionAPI, state: PreflightState): PreflightState {
  try {
    pi.appendEntry(PREFLIGHT_ENTRY, structuredClone(state));
    currentRuntime().preflight = structuredClone(state);
    return structuredClone(state);
  } catch {
    return failPersistence(
      "Preflight persistence failed; inspect journal and pending work before control",
    );
  }
}
function normalizeGoal(goal: string): string {
  return goal.trim().split(/\s+/).join(" ");
}
function safeStrings(value: unknown): boolean {
  if (typeof value === "string") return isSafeBoundedText(value, 4000);
  if (Array.isArray(value)) return value.every(safeStrings);
  if (value && typeof value === "object") return Object.values(value).every(safeStrings);
  return true;
}
function normalizedProposal(proposal: PreflightProposal): PreflightProposal {
  return {
    summary: proposal.summary.trim(),
    steps: proposal.steps.map((s) => s.trim()),
    acceptance: proposal.acceptance.map((s) => s.trim()),
    permissions: proposal.permissions
      .map((p) => ({
        id: p.id.trim(),
        action: p.action.trim(),
        target: p.target.trim(),
        environment: p.environment.trim(),
        required: p.required,
        limits: p.limits.trim(),
        risks: p.risks.trim(),
        fallback: p.fallback.trim(),
        reconfirm: p.reconfirm.trim(),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    prohibitions: proposal.prohibitions.map((s) => s.trim()),
    reconfirm: proposal.reconfirm.map((s) => s.trim()),
  };
}
export function canonicalPreflightProposal(goal: string, proposal: PreflightProposal): string {
  if (!isSafeBoundedText(goal, 4000)) throw new Error("Invalid preflight goal");
  if (!Check(PreflightProposalSchema, proposal) || !safeStrings(proposal))
    throw new Error("Invalid, unknown or secret-like preflight proposal fields");
  const normalized = normalizedProposal(proposal);
  const ids = normalized.permissions.map((p) => p.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => /[\s,]/u.test(id) || ["all", "none"].includes(id))
  )
    throw new Error(
      "Permission IDs must be unique, exact, without whitespace/commas and not all/none",
    );
  const encoded = JSON.stringify({ goal: normalizeGoal(goal), proposal: normalized });
  if (Buffer.byteLength(encoded, "utf8") > MAX_PROPOSAL_BYTES)
    throw new Error(
      "Preflight proposal exceeds 16000 UTF-8 bytes; narrow the proposal without dropping required scope",
    );
  return encoded;
}
export function preflightDigest(
  sessionId: string,
  goal: string,
  proposal: PreflightProposal,
): string {
  return createHash("sha256")
    .update(`preflight-v1\0${sessionId}\0${canonicalPreflightProposal(goal, proposal)}`)
    .digest("hex");
}
export function beginPreflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  goal: string,
): PreflightState {
  const issue = controlIssue(ctx);
  if (issue) throw new Error(issue);
  const supervisor = currentRuntime().supervisor;
  if (supervisor && supervisor.status !== "stopped")
    throw new Error("Stop the existing supervisor before starting preflight");
  const board = getBoardRef();
  if (
    board.tasks.length ||
    board.decision ||
    ["paused", "waiting_for_decision"].includes(board.workflowStatus)
  )
    throw new Error(
      "Inspect the existing task board and human gates; preflight cannot clear or approve them",
    );
  goal = normalizeGoal(goal);
  if (!isSafeBoundedText(goal, 4000))
    throw new Error("A bounded non-secret preflight goal is required");
  return savePreflight(pi, {
    version: 2,
    sessionId: ctx.sessionManager.getSessionId(),
    preflightId: `pf-${randomUUID()}`,
    goal,
    phase: "planning",
    revision: 0,
  });
}
export function submitPreflight(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  preflightId: string,
  proposal: PreflightProposal,
): PreflightState {
  if (currentRuntime().journalFault) throw new Error(currentRuntime().journalFault);
  const state = requireOwn(ctx);
  if (
    preflightId !== state.preflightId ||
    state.started ||
    state.phase === "revoked" ||
    state.phase === "interrupted"
  )
    throw new Error(
      "Stale, revoked, interrupted or already-started preflight cannot be replaced by a model proposal",
    );
  const encoded = canonicalPreflightProposal(state.goal, proposal);
  const normalized = (JSON.parse(encoded) as { proposal: PreflightProposal }).proposal;
  const planDigest = preflightDigest(state.sessionId, state.goal, normalized);
  if (state.planDigest === planDigest) return structuredClone(state);
  const revision = state.revision + 1;
  return savePreflight(pi, {
    ...state,
    version: 2,
    permissionRequest: {
      id: randomUUID(),
      supersedes: preflightRequestPredecessor(ctx, state, "permission"),
      permissionIds: normalized.permissions
        .filter((p) => p.required)
        .map((p) => p.id)
        .sort(),
    },
    startRequest: undefined,
    proposal: normalized,
    revision,
    planId: `${state.preflightId}.r${revision}`,
    planDigest,
    approval: undefined,
    phase: "awaiting_authorization",
  });
}
function missingRequired(state: PreflightState): string[] {
  const granted = new Set(state.approval?.permissionIds ?? []);
  return (
    state.proposal?.permissions.filter((p) => p.required && !granted.has(p.id)).map((p) => p.id) ??
    []
  );
}
export function preflightPermissionSelection(state: PreflightState, selection?: string): string[] {
  if (selection === undefined)
    return (
      state.proposal?.permissions
        .filter((p) => p.required)
        .map((p) => p.id)
        .sort() ?? []
    );
  const known = state.proposal?.permissions.map((p) => p.id);
  if (!known) throw new Error("No complete preflight proposal");
  const ids = selection === "all" ? known : selection === "none" ? [] : selection.split(",");
  if (!selection || new Set(ids).size !== ids.length || ids.some((id) => !known.includes(id)))
    throw new Error(
      "Unknown or duplicate exact permission IDs; use all, none or a comma-separated complete selection",
    );
  return [...ids].sort();
}
function appendControl(pi: ExtensionAPI, ctx: ExtensionContext, control: PreflightControl): string {
  try {
    pi.appendEntry(PREFLIGHT_CONTROL_ENTRY, control);
    const id = ctx.sessionManager.getLeafId();
    const entry = ctx.sessionManager.getBranch().find((item) => item.id === id);
    if (
      !id ||
      entry?.type !== "custom" ||
      entry.customType !== PREFLIGHT_CONTROL_ENTRY ||
      JSON.stringify(entry.data) !== JSON.stringify(control)
    )
      throw new Error("Control entry was not observed on the current branch");
    return id;
  } catch {
    return failPersistence("Preflight control persistence failed; inspect journal before recovery");
  }
}
export function preflightRequestPredecessor(
  ctx: ExtensionContext,
  state: PreflightState,
  kind: "permission" | "start",
): Static<typeof PreflightSupersedesSchema> | undefined {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const previous = [...journal.branch]
    .reverse()
    .find(
      (n) =>
        n.customType === PREFLIGHT_ENTRY &&
        Check(NativePreflightStateSchema, n.data) &&
        n.data.preflightId === state.preflightId &&
        (kind === "permission" ? n.data.permissionRequest : n.data.startRequest),
    );
  const data = previous?.data;
  const request = Check(NativePreflightStateSchema, data)
    ? kind === "permission"
      ? data.permissionRequest
      : data.startRequest
    : undefined;
  if (request) {
    const proof = findReadbackProof(journal, "preflight", request.id);
    if (proof.status === "unconfirmed")
      throw new Error("Unconfirmed preflight request cannot be superseded without inspection");
    return {
      requestId: request.id,
      ...(proof.status === "confirmed" ? { controlEntryId: proof.control.id } : {}),
    };
  }
  if (kind === "start") return undefined;
  const legacy = currentControls(ctx)
    .filter((c) => c.data.preflightId === state.preflightId && !("version" in c.data))
    .at(-1);
  return legacy ? { legacyControlEntryId: legacy.id } : undefined;
}
export function preflightPermissionScope(base: PreflightState, ids: string[]): object {
  return {
    action: "permissions",
    sessionId: base.sessionId,
    goal: base.goal,
    preflightId: base.preflightId,
    revision: base.revision,
    planId: base.planId,
    planDigest: base.planDigest,
    proposal: base.proposal,
    request: base.version === 2 ? base.permissionRequest : undefined,
    permissionIds: ids,
  };
}
export function preflightStartScope(base: PreflightState, approvalEntryDigest: string): object {
  return {
    action: "start",
    sessionId: base.sessionId,
    goal: base.goal,
    preflightId: base.preflightId,
    revision: base.revision,
    planId: base.planId,
    planDigest: base.planDigest,
    proposal: base.proposal,
    request: base.version === 2 ? base.startRequest : undefined,
    permissionIds: base.approval?.permissionIds,
    approvalControlEntryId: base.approval?.controlEntryId,
    approvalControlDigest: approvalEntryDigest,
  };
}
function nativeRequest(base: PreflightState, start: boolean) {
  if (base.version !== 2) return undefined;
  return start ? base.startRequest : base.permissionRequest;
}
function nativeSnapshot(data: unknown): boolean {
  return Boolean(data && typeof data === "object" && "version" in data && data.version === 2);
}
function nativeIdentity(base: PreflightState, control: NativePreflightControl): void {
  const request = nativeRequest(base, control.kind === "start");
  if (
    !Check(NativePreflightControlSchema, control) ||
    proposalIssue(base) ||
    !request ||
    control.sessionId !== base.sessionId ||
    control.preflightId !== base.preflightId ||
    control.planId !== base.planId ||
    control.planDigest !== base.planDigest ||
    !same(
      {
        owner: control.humanInteraction.owner,
        sessionId: control.humanInteraction.sessionId,
        requestId: control.humanInteraction.requestId,
      },
      { owner: "preflight", sessionId: base.sessionId, requestId: request.id },
    ) ||
    JSON.stringify(control.supersedes) !== JSON.stringify(request.supersedes) ||
    !validSelection(base, control.permissionIds) ||
    (control.kind !== "start" && !same(request.permissionIds, control.permissionIds))
  )
    throw new Error("Invalid native preflight identity/selection");
  const scope =
    control.kind === "start"
      ? preflightStartScope(base, control.approvalControlDigest)
      : preflightPermissionScope(base, control.permissionIds);
  if (journalDigest(scope) !== control.humanInteraction.scopeDigest)
    throw new Error("Preflight scope changed");
}
export function projectPreflightPermissions(
  base: PreflightState,
  control: NativePermissionControl,
  controlEntryId: string,
): PreflightState {
  nativeIdentity(base, control);
  const persistedBase = structuredClone(base);
  if (!persistedBase.approval) delete persistedBase.approval;
  const next: PreflightState = {
    ...persistedBase,
    version: 2,
    approval:
      control.kind === "approve"
        ? {
            planId: control.planId,
            planDigest: control.planDigest,
            permissionIds: [...control.permissionIds],
            controlEntryId,
            createdAt: control.createdAt,
          }
        : undefined,
    phase: "awaiting_authorization",
  };
  if (!base.started) next.startRequest = undefined;
  if (control.kind === "approve" && !missingRequired(next).length)
    next.phase = next.started ? "started" : "approved";
  return next;
}
export function projectPreflightStart(
  base: PreflightState,
  control: NativeStartControl,
  controlEntryId: string,
): PreflightState {
  nativeIdentity(base, control);
  if (
    base.phase !== "approved" ||
    base.started ||
    !base.approval ||
    missingRequired(base).length ||
    control.approvalControlEntryId !== base.approval.controlEntryId ||
    journalDigest(control.permissionIds) !== journalDigest(base.approval.permissionIds)
  )
    throw new Error("Preflight startup is not unused/exact approved scope");
  return {
    ...structuredClone(base),
    version: 2,
    phase: "started",
    started: {
      goal: base.goal,
      startedAt: control.createdAt,
      controlEntryId,
      approvalControlEntryId: control.approvalControlEntryId,
    },
  };
}

function associationIssue(state: PreflightState): string | undefined {
  return normalizeGoal(state.goal) !== state.goal ||
    (state.started && state.started.goal !== state.goal) ||
    (state.phase === "started" && !state.started) ||
    (state.phase === "approved" && state.started) ||
    ["planning", "interrupted"].includes(state.phase)
    ? "Inconsistent preflight phase/goal association"
    : undefined;
}
function proposalRequestIssue(state: PreflightState): string | undefined {
  if (state.version !== 2) return undefined;
  if (!state.permissionRequest) return "Native proposal needs permission request";
  if (
    !state.permissionRequest.permissionIds ||
    !validSelection(state, state.permissionRequest.permissionIds) ||
    state.startRequest?.permissionIds !== undefined
  )
    return "Invalid immutable preflight request selection";
  return undefined;
}
function proposalIssue(state: PreflightState): string | undefined {
  if (!Check(PreflightStateSchema, state) || !safeStrings(state)) return "Invalid preflight state";
  const requestIssue = proposalRequestIssue(state);
  if (requestIssue) return requestIssue;
  if (!state.proposal || !state.planId || !state.planDigest || state.revision < 1)
    return "No complete preflight proposal";
  const association = associationIssue(state);
  if (association) return association;
  try {
    if (
      state.planId !== `${state.preflightId}.r${state.revision}` ||
      state.planDigest !== preflightDigest(state.sessionId, state.goal, state.proposal)
    )
      return "Preflight proposal identity changed";
  } catch {
    return "Invalid preflight proposal identity";
  }
  return undefined;
}
function foreignRecord(data: unknown, sessionId: string): boolean {
  return Boolean(
    data &&
    typeof data === "object" &&
    "sessionId" in data &&
    typeof data.sessionId === "string" &&
    data.sessionId !== sessionId,
  );
}
function legacyGrant(data: PreflightControl): boolean {
  return !("version" in data) && data.kind !== "revoke";
}
function currentControls(
  ctx: ExtensionContext,
  beforeEntryId?: string,
): Array<{ id: string; data: PreflightControl }> {
  const controls: Array<{ id: string; data: PreflightControl }> = [];
  let nativeSeen = false;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.id === beforeEntryId) break;
    if (
      entry.type === "custom" &&
      entry.customType === PREFLIGHT_ENTRY &&
      nativeSnapshot(entry.data)
    )
      nativeSeen = true;
    if (entry.type !== "custom" || entry.customType !== PREFLIGHT_CONTROL_ENTRY) continue;
    if (foreignRecord(entry.data, ctx.sessionManager.getSessionId())) continue;
    if (
      !Check(PreflightControlSchema, entry.data) ||
      (entry.data.kind === "revoke" && entry.data.permissionIds.length)
    )
      throw new Error("Invalid preflight control journal");
    if (nativeSeen && legacyGrant(entry.data))
      throw new Error("Preflight legacy approval downgrade");
    if ("version" in entry.data) nativeSeen = true;
    controls.push({ id: entry.id, data: entry.data });
  }
  return controls;
}
function controlClosureIssue(
  ctx: ExtensionContext,
  state: PreflightState,
  beforeEntryId?: string,
): string | undefined {
  let controls: ReturnType<typeof currentControls>;
  try {
    controls = currentControls(ctx, beforeEntryId);
  } catch {
    return "Invalid preflight control journal";
  }
  const latest = controls
    .reverse()
    .find((entry) => entry.data.preflightId === state.preflightId && entry.data.kind !== "start");
  const approval = state.approval;
  if (!approval || !latest || latest.id !== approval.controlEntryId)
    return "No current-branch human control closure for preflight approval";
  const control = latest.data;
  if ("version" in control) {
    try {
      const proof = confirmedPreflightProof(ctx, control.humanInteraction.requestId);
      const projected = verifiedPreflightProjection(ctx, proof);
      if (proof.control.id !== latest.id || !same(projected.approval, approval))
        return "Invalid native preflight closure";
    } catch {
      return "Invalid native preflight journal closure";
    }
  }
  return control.kind !== "approve" ||
    control.planId !== state.planId ||
    control.planDigest !== state.planDigest ||
    control.createdAt !== approval.createdAt ||
    JSON.stringify(control.permissionIds) !== JSON.stringify(approval.permissionIds)
    ? "Preflight control closure is revoked or inconsistent"
    : undefined;
}
function validSelection(state: PreflightState, ids: string[]): boolean {
  try {
    return (
      JSON.stringify(preflightPermissionSelection(state, ids.length ? ids.join(",") : "none")) ===
      JSON.stringify(ids)
    );
  } catch {
    return false;
  }
}
function approvalIssue(
  ctx: ExtensionContext,
  state: PreflightState,
  beforeEntryId?: string,
): string | undefined {
  const invalid = proposalIssue(state);
  if (invalid) return invalid;
  const approval = state.approval;
  if (state.phase === "revoked" || !approval)
    return "Preflight authorization is absent or revoked; obtain exact human approval";
  if (approval.planId !== state.planId || approval.planDigest !== state.planDigest)
    return "Preflight approval is stale";
  if (!validSelection(state, approval.permissionIds))
    return "Invalid preflight permission selection";
  const closure = controlClosureIssue(ctx, state, beforeEntryId);
  if (closure) return closure;
  const missing = missingRequired(state);
  return missing.length
    ? `Preflight missing required permissions: ${missing.join(", ")}`
    : undefined;
}
function bindingOf(state: PreflightState): PreflightBinding {
  if (!state.planId || !state.planDigest) throw new Error("No complete preflight proposal");
  return { preflightId: state.preflightId, planId: state.planId, planDigest: state.planDigest };
}
function unboundLegacyGoal(state: PreflightState, goal: string, planId?: string): boolean {
  return (
    planId === undefined &&
    state.phase === "revoked" &&
    !state.started &&
    state.goal !== normalizeGoal(goal)
  );
}
export function inspectPreflightStart(
  ctx: ExtensionContext,
  goal: string,
  planId?: string,
): PreflightBinding | undefined {
  const state = currentRuntime().preflight;
  if (state) {
    const issue = controlIssue(ctx);
    if (issue) throw new Error(issue);
  }
  if (!state) {
    if (planId !== undefined) throw new Error("No preflight for the requested plan ID");
    return undefined;
  }
  if (state.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("Preflight belongs to another session");
  if (unboundLegacyGoal(state, goal, planId)) return undefined;
  if (state.goal !== normalizeGoal(goal) || (planId !== undefined && planId !== state.planId))
    throw new Error("Preflight goal or plan ID does not match");
  const issue = approvalIssue(ctx, state);
  if (issue) throw new Error(issue);
  if (state.phase !== "approved" || state.started)
    throw new Error("This preflight is not an unused approved plan; do not start it twice");
  return bindingOf(state);
}
export function preflightStartBinding(
  ctx: ExtensionContext,
  goal: string,
  planId?: string,
  nativeStart?: NativePreflightStartResponse,
): PreflightBinding | undefined {
  const binding = inspectPreflightStart(ctx, goal, planId);
  if (!binding) return undefined;
  if (!nativeStart) throw new Error("Native first-start confirmation is required");
  requireNativeAnswer(ctx, nativeStart.answer, nativeStart.frame);
  const proof = confirmedPreflightProof(ctx, nativeStart.frame.requestId);
  const control = proof.control.data;
  if (
    !Check(NativePreflightControlSchema, control) ||
    control.kind !== "start" ||
    nativeStart.answer.value !== "Start execution"
  )
    throw new Error("Invalid native start response");
  verifiedPreflightProjection(ctx, proof, false);
  return binding;
}
export function markPreflightStarted(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  binding: PreflightBinding,
  nativeStart: NativePreflightStartResponse,
): void {
  const state = requireOwn(ctx);
  preflightStartBinding(ctx, state.goal, binding.planId, nativeStart);
  const proof = confirmedPreflightProof(ctx, nativeStart.frame.requestId);
  const next = verifiedPreflightProjection(ctx, proof);
  saveReadbackProjection(pi, ctx, proof, next);
  currentRuntime().preflight = next;
}
function boundSupervisorGoalIssue(
  state: PreflightState,
  binding: PreflightBinding,
): string | undefined {
  const owner = currentRuntime().supervisor;
  return owner?.preflightBinding?.preflightId === binding.preflightId &&
    normalizeGoal(owner.goal) !== state.goal
    ? "Bound supervisor goal changed; obtain a new exact preflight"
    : undefined;
}

export function preflightAuthorizationIssue(
  ctx: ExtensionContext | undefined,
  binding: PreflightBinding,
): string | undefined {
  if (!ctx) return "Bound preflight requires a current-session verification context";
  if (currentRuntime().journalFault) return currentRuntime().journalFault;
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId())
    return "Bound preflight is absent or belongs to another session";
  if (
    state.preflightId !== binding.preflightId ||
    state.planId !== binding.planId ||
    state.planDigest !== binding.planDigest
  )
    return "Bound preflight identity does not match";
  const issue = approvalIssue(ctx, state);
  if (issue) return issue;
  const goalIssue = boundSupervisorGoalIssue(state, binding);
  if (goalIssue) return goalIssue;
  return state.phase !== "started" || !state.started || state.started.goal !== state.goal
    ? "Preflight startup association is incomplete"
    : undefined;
}

export function revokePreflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planId: string,
): PreflightState {
  const issue = controlIssue(ctx);
  if (issue) throw new Error(issue);
  const state = requireOwn(ctx);
  if (planId !== state.planId || !state.planDigest || !state.proposal)
    throw new Error("Exact current preflight plan ID is required for revocation");
  appendControl(pi, ctx, {
    kind: "revoke",
    sessionId: state.sessionId,
    preflightId: state.preflightId,
    planId,
    planDigest: state.planDigest,
    permissionIds: [],
    createdAt: new Date().toISOString(),
  });
  return savePreflight(pi, { ...state, phase: "revoked", approval: undefined });
}

function restoredSnapshot(data: unknown): PreflightState {
  if (!Check(PreflightStateSchema, data) || !safeStrings(data))
    throw new Error("Invalid persisted preflight state");
  if (data.proposal) {
    const issue = proposalIssue(data);
    if (issue) throw new Error(issue);
  } else if (
    data.revision !== 0 ||
    data.approval ||
    data.started ||
    data.planId ||
    data.planDigest ||
    !["planning", "interrupted"].includes(data.phase)
  )
    throw new Error("Incomplete persisted preflight proposal");
  return structuredClone(data);
}
function confirmedPreflightProof(ctx: ExtensionContext, requestId: string): ConfirmedProof {
  const proof = findReadbackProof(
    inspectSessionJournal(sessionJournalView(ctx)),
    "preflight",
    requestId,
  );
  if (proof.status !== "confirmed")
    throw new Error("Unconfirmed preflight control; inspect before recovery");
  return proof;
}
function initialStartupState(state: SupervisorState): boolean {
  return (
    state.status === "active" &&
    !state.pending &&
    [
      state.reviews,
      state.continuations,
      state.stagnant,
      state.tokens,
      state.cost,
      state.epoch,
      state.receipts.length,
      state.bindings.length,
    ].every((n) => n === 0)
  );
}
function readPreflightStartup(
  ctx: ExtensionContext,
  proof: ConfirmedProof,
): SupervisorStartRecord | undefined {
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const witnessIndex = journal.branch.findIndex((n) => n.id === proof.witness.id);
  const first = journal.branch
    .slice(witnessIndex + 1)
    .find((n) => n.customType === SUPERVISOR_ENTRY);
  if (!first) return undefined;
  const entry = ctx.sessionManager.getBranch().find((e) => e.id === first.id);
  if (!entry || entry.type !== "custom" || journalDigest(entry) !== first.digest)
    throw new Error("Invalid preflight startup record");
  const { state } = readSupervisorStartRecord(ctx, first.id);
  const base = restoredSnapshot(proof.base.data);
  if (
    state.sessionId !== base.sessionId ||
    state.goal !== base.goal ||
    journalDigest(state.preflightBinding) !== journalDigest(bindingOf(base)) ||
    !initialStartupState(state)
  )
    throw new Error("Contradictory preflight startup record");
  return { entryId: first.id, state: structuredClone(state) };
}
function verifiedPreflightProjection(
  ctx: ExtensionContext,
  proof: ConfirmedProof,
  requireStartup = true,
): PreflightState {
  const base = restoredSnapshot(proof.base.data);
  const control = proof.control.data;
  if (!Check(NativePreflightControlSchema, control))
    throw new Error("Invalid native preflight control");
  if (control.kind !== "start") return projectPreflightPermissions(base, control, proof.control.id);
  const issue = approvalIssue(ctx, base, proof.control.id);
  if (issue) throw new Error(issue);
  const journal = inspectSessionJournal(sessionJournalView(ctx));
  const approval = journal.branch.find((n) => n.id === control.approvalControlEntryId);
  if (!approval || approval.digest !== control.approvalControlDigest)
    throw new Error("Preflight approval digest changed");
  const next = projectPreflightStart(base, control, proof.control.id);
  if (requireStartup && !readPreflightStartup(ctx, proof))
    throw new Error(
      "Confirmed preflight start lacks Supervisor startup; unresolved hold, never retry",
    );
  return next;
}
export function inspectConfirmedPreflightProjection(
  ctx: ExtensionContext,
  requestId: string,
): { proof: ConfirmedProof; state: PreflightState } {
  const proof = confirmedPreflightProof(ctx, requestId);
  return { proof, state: verifiedPreflightProjection(ctx, proof) };
}

function projectionPending(
  ctx: ExtensionContext,
  proof: ConfirmedProof,
  projected: PreflightState,
): void {
  const runtime = currentRuntime();
  const faultMessage = "Confirmed preflight result retained; projection pending explicit repair";
  const ownsJournalFault = !runtime.journalFault;
  runtime.preflightRepair = {
    sessionId: ctx.sessionManager.getSessionId(),
    controlEntryId: proof.control.id,
    projectedDigest: journalDigest(projected),
    faultMessage,
    ownsJournalFault,
  };
  if (ownsJournalFault) runtime.journalFault = faultMessage;
}
function same(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify({ value: a })),
    JSON.parse(JSON.stringify({ value: b })),
  );
}
function requestPreparation(before: PreflightState, after: PreflightState): boolean {
  if (after.version !== 2) return false;
  const strip = (s: PreflightState) => {
    const c = structuredClone(s) as Record<string, unknown>;
    delete c.version;
    delete c.permissionRequest;
    delete c.startRequest;
    return c;
  };
  return same(strip(before), strip(after));
}
function validProposalTransition(before: PreflightState, after: PreflightState): boolean {
  return (
    !before.started &&
    !["revoked", "interrupted"].includes(before.phase) &&
    after.revision === before.revision + 1 &&
    after.planDigest !== before.planDigest &&
    after.phase === "awaiting_authorization" &&
    !after.approval &&
    !after.started &&
    !(after.version === 2 && after.startRequest) &&
    same(after.proposal, after.proposal && normalizedProposal(after.proposal))
  );
}
type RequestKind = "permission" | "start";
type PreflightRequest = Static<typeof PreflightRequestSchema>;
interface SeenRequest {
  owner: string;
  kind: RequestKind;
  planDigest?: string;
  request: PreflightRequest;
  controlEntryId?: string;
  retired: boolean;
}
interface PreflightFold {
  state?: PreflightState;
  pending?: { proof: ConfirmedProof; projected: PreflightState };
  legacyPending?: { id: string; control: PreflightControl };
  nativeSeen: boolean;
  owners: Set<string>;
  requests: Map<string, SeenRequest>;
  lastRequests: Map<string, SeenRequest>;
  legacyControls: Map<string, string>;
  legacyStarted: Map<string, PreflightState["started"]>;
}
function requestKey(owner: string, kind: RequestKind): string {
  return `${owner}:${kind}`;
}
function validateFreshRequest(
  fold: PreflightFold,
  state: PreflightState,
  kind: RequestKind,
  request: PreflightRequest,
  last: SeenRequest | undefined,
): void {
  const legacy = kind === "permission" ? fold.legacyControls.get(state.preflightId) : undefined;
  const predecessor = last
    ? {
        requestId: last.request.id,
        ...(last.controlEntryId ? { controlEntryId: last.controlEntryId } : {}),
      }
    : legacy
      ? { legacyControlEntryId: legacy }
      : undefined;
  if (!same(request.supersedes, predecessor))
    throw new Error("Preflight request predecessor changed");
  if (
    kind === "start" &&
    (state.phase !== "approved" ||
      !state.approval ||
      state.started ||
      missingRequired(state).length)
  )
    throw new Error("Preflight start request requires an unused approved plan");
}
function trackRequest(fold: PreflightFold, state: PreflightState, kind: RequestKind): void {
  const request = nativeRequest(state, kind === "start");
  const key = requestKey(state.preflightId, kind);
  const last = fold.lastRequests.get(key);
  if (!request) {
    if (last) last.retired = true;
    return;
  }
  const seen = fold.requests.get(request.id);
  if (seen) {
    if (
      seen.retired ||
      seen.owner !== state.preflightId ||
      seen.kind !== kind ||
      seen.planDigest !== state.planDigest ||
      !same(seen.request, request)
    )
      throw new Error("Preflight request identity reused or changed");
    return;
  }
  validateFreshRequest(fold, state, kind, request, last);
  if (last) last.retired = true;
  const record: SeenRequest = {
    owner: state.preflightId,
    kind,
    planDigest: state.planDigest,
    request: structuredClone(request),
    retired: false,
  };
  fold.requests.set(request.id, record);
  fold.lastRequests.set(key, record);
}
function validateStartRetention(before: PreflightState | undefined, next: PreflightState): void {
  if (before?.version !== 2 || next.version !== 2 || !before.startRequest) return;
  const replaced = before.permissionRequest?.id !== next.permissionRequest?.id;
  if (before.started && !same(before.startRequest, next.startRequest))
    throw new Error("Used preflight start request must be preserved");
  if (!before.started && replaced && next.startRequest)
    throw new Error("Permission replacement must clear unused start request");
  if (!before.started && !replaced && !next.startRequest)
    throw new Error("Unused start request cleared without permission replacement");
}
function validateSnapshotRequests(fold: PreflightFold, next: PreflightState): void {
  if (next.version !== 2) return;
  if (!next.proposal && (next.permissionRequest || next.startRequest))
    throw new Error("Planning preflight cannot contain requests");
  if (
    next.started &&
    !("controlEntryId" in next.started) &&
    !same(next.started, fold.legacyStarted.get(next.preflightId))
  )
    throw new Error("Untraced legacy preflight started marker");
  trackRequest(fold, next, "permission");
  trackRequest(fold, next, "start");
}
function legacyStartedTransition(before: PreflightState, after: PreflightState): boolean {
  return (
    before.version === 1 &&
    after.version === 1 &&
    Boolean(before.approval) &&
    after.phase === "started" &&
    !before.started &&
    Boolean(after.started) &&
    same({ ...after, phase: before.phase, started: undefined }, before)
  );
}
function beginFoldOwner(fold: PreflightFold, after: PreflightState): void {
  if (
    fold.owners.has(after.preflightId) ||
    after.phase !== "planning" ||
    after.revision !== 0 ||
    after.approval ||
    after.started
  )
    throw new Error("New preflight must begin planning with a fresh identity");
  fold.owners.add(after.preflightId);
}
function foldSnapshot(fold: PreflightFold, after: PreflightState): void {
  const before = fold.state;
  if (fold.nativeSeen && after.version !== 2) throw new Error("Preflight snapshot downgrade");
  if (!before || before.preflightId !== after.preflightId) {
    beginFoldOwner(fold, after);
    return;
  }
  if (before.sessionId !== after.sessionId || before.goal !== after.goal)
    throw new Error("Preflight owner identity changed");
  if (
    same(before, after) ||
    requestPreparation(before, after) ||
    validProposalTransition(before, after)
  )
    return;
  if (legacyStartedTransition(before, after)) return;
  throw new Error("Conflicting preflight snapshot transition");
}
function legacyProjection(
  base: PreflightState,
  control: PreflightControl,
  id: string,
): PreflightState {
  if (
    control.sessionId !== base.sessionId ||
    control.preflightId !== base.preflightId ||
    control.planId !== base.planId ||
    control.planDigest !== base.planDigest ||
    !validSelection(base, control.permissionIds)
  )
    throw new Error("Invalid legacy preflight control identity/selection");
  if (control.kind === "revoke") {
    if (control.permissionIds.length) throw new Error("Invalid legacy revoke selection");
    return { ...base, phase: "revoked", approval: undefined };
  }
  const next: PreflightState = {
    ...base,
    approval: {
      planId: control.planId,
      planDigest: control.planDigest,
      permissionIds: [...control.permissionIds],
      controlEntryId: id,
      createdAt: control.createdAt,
    },
    phase: "awaiting_authorization",
  };
  if (!missingRequired(next).length) next.phase = next.started ? "started" : "approved";
  return next;
}
function foldPreflightControl(
  ctx: ExtensionContext,
  fold: PreflightFold,
  value: unknown,
  id: string,
): void {
  if (!Check(PreflightControlSchema, value) || !fold.state)
    throw new Error("Invalid preflight control journal");
  if (fold.legacyPending) throw new Error("Incomplete legacy preflight control cache");
  if ("version" in value) {
    const proof = confirmedPreflightProof(ctx, value.humanInteraction.requestId);
    if (proof.control.id !== id || !same(fold.state, proof.base.data))
      throw new Error("Preflight control base is stale");
    const request = fold.requests.get(value.humanInteraction.requestId);
    if (!request || request.retired || request.controlEntryId)
      throw new Error("Preflight request is retired or already finalized");
    const projected = verifiedPreflightProjection(ctx, proof);
    request.controlEntryId = id;
    fold.nativeSeen = true;
    fold.state = projected;
    fold.pending = { proof, projected };
  } else {
    if (fold.nativeSeen && value.kind !== "revoke")
      throw new Error("Preflight legacy approval downgrade");
    const projected = legacyProjection(fold.state, value, id);
    fold.legacyControls.set(value.preflightId, id);
    if (value.kind === "approve") fold.legacyPending = { id, control: value };
    fold.state = projected;
  }
}
function foldPreflightSnapshot(
  ctx: ExtensionContext,
  fold: PreflightFold,
  value: unknown,
  id: string,
): void {
  const next = restoredSnapshot(value);
  if (next.sessionId !== ctx.sessionManager.getSessionId())
    throw new Error("Preflight snapshot session changed");
  foldSnapshot(fold, next);
  validateStartRetention(fold.state, next);
  validateSnapshotRequests(fold, next);
  if (next.approval) {
    const issue = approvalIssue(ctx, next, id);
    if (issue && !issue.startsWith("Preflight missing required permissions:"))
      throw new Error(issue);
  } else if (["approved", "started"].includes(next.phase))
    throw new Error("Preflight claims approval without human closure");
  if (fold.legacyPending) {
    if (!same(next.approval?.controlEntryId, fold.legacyPending.id))
      throw new Error("Incomplete legacy preflight control cache");
    fold.legacyPending = undefined;
  }
  if (next.version === 1 && next.started)
    fold.legacyStarted.set(next.preflightId, structuredClone(next.started));
  if (next.version === 2) fold.nativeSeen = true;
  // A legal successor deterministically preserves/advances the proven projection.
  fold.pending = undefined;
  fold.state = next;
}
export function restorePreflight(ctx: ExtensionContext): void {
  const runtime = currentRuntime();
  runtime.preflight = undefined;
  runtime.preflightRepair = undefined;
  const persisted = inspectRestorableSession(ctx);
  const hasOwnerRecord = ctx.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom" &&
        [PREFLIGHT_ENTRY, PREFLIGHT_CONTROL_ENTRY].includes(entry.customType),
    );
  if (!hasOwnerRecord) return; // No authority to restore; persisted ancestry was checked first.
  const journal = persisted ?? inspectSessionJournal(sessionJournalView(ctx));
  const fold: PreflightFold = {
    nativeSeen: false,
    owners: new Set(),
    requests: new Map(),
    lastRequests: new Map(),
    legacyControls: new Map(),
    legacyStarted: new Map(),
  };
  for (const node of journal.branch) {
    if (node.customType === PREFLIGHT_ENTRY) foldPreflightSnapshot(ctx, fold, node.data, node.id);
    else if (node.customType === PREFLIGHT_CONTROL_ENTRY)
      foldPreflightControl(ctx, fold, node.data, node.id);
  }
  if (fold.legacyPending) throw new Error("Incomplete legacy preflight control persistence");
  if (fold.pending) projectionPending(ctx, fold.pending.proof, fold.pending.projected);
  runtime.preflight =
    fold.state?.phase === "planning" ? { ...fold.state, phase: "interrupted" } : fold.state;
}

export function preflightEvidence(
  ctx: ExtensionContext | undefined,
  binding: PreflightBinding,
): object {
  const issue = preflightAuthorizationIssue(ctx, binding);
  if (issue) throw new Error(issue);
  const state = currentRuntime().preflight;
  if (!state) throw new Error("Bound preflight is absent");
  return {
    preflightId: state.preflightId,
    planId: state.planId,
    planDigest: state.planDigest,
    goal: state.goal,
    proposal: structuredClone(state.proposal),
    approval: structuredClone(state.approval),
  };
}

export function preflightTaskIssue(
  ctx: ExtensionContext,
  binding?: PreflightBinding,
): string | undefined {
  if (binding) return preflightAuthorizationIssue(ctx, binding);
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
  // Stopping supervision does not detach the retained execution board from its grant.
  if (state.started) {
    if (!state.planId || !state.planDigest) return "Preflight startup association is incomplete";
    return preflightAuthorizationIssue(ctx, {
      preflightId: state.preflightId,
      planId: state.planId,
      planDigest: state.planDigest,
    });
  }
  return state.phase !== "revoked"
    ? "Preflight planning/approval must finish and be explicitly started before execution task mutation"
    : undefined;
}

function permissionResponseText(ctx: ExtensionContext, state: PreflightState): string | undefined {
  if (state.version !== 2 || !state.permissionRequest) return undefined;
  try {
    const proof = findReadbackProof(
      inspectSessionJournal(sessionJournalView(ctx)),
      "preflight",
      state.permissionRequest.id,
    );
    if (proof.status === "unconfirmed")
      return "Permission submission is unconfirmed; do not approve or execute from it.";
    if (
      proof.status === "confirmed" &&
      Check(NativePreflightControlSchema, proof.control.data) &&
      proof.control.data.kind === "reject"
    )
      return "The displayed permission selection was rejected; no permission was granted. Wait for a new explicit native response or a revised proposal.";
  } catch {
    return "Permission journal cannot be verified; inspect before control.";
  }
  return undefined;
}

function permissionContext(ctx: ExtensionContext, state: PreflightState): string | undefined {
  if (state.phase === "approved")
    return `Preflight permissions are approved, not started. No execution has been authorized by this approval alone. Remain read-only until startup. Wait for the human's separate /task-supervisor start (no plan ID needed); do not resubmit the same proposal. Recorded scope: ${JSON.stringify({ goal: state.goal, planId: state.planId, planDigest: state.planDigest, proposal: state.proposal, selectedPermissionIds: state.approval?.permissionIds ?? [] })}`;
  if (state.phase === "awaiting_authorization")
    return `Preflight proposal saved, awaiting an exact native permission response. ${permissionResponseText(ctx, state) ?? "No complete current authorization is recorded."} Use /task-supervisor approve with no plan ID for the required-only selection. Chat text is not an approval; do not implement or start. Recorded proposal: ${JSON.stringify(state.proposal)}`;
  return undefined;
}

export function preflightContext(ctx: ExtensionContext): string | undefined {
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
  const owner = currentRuntime().supervisor;
  if (owner && !owner.preflightBinding && unboundLegacyGoal(state, owner.goal)) return undefined;
  const fault = currentRuntime().journalFault;
  if (fault || currentRuntime().preflightRepair)
    return `Recorded preflight result is held: ${fault ?? "projection repair pending"}. Do not execute or request the same approval again. Inspect and use /task-supervisor repair-preflight only for its confirmed pending cache; other holds remain.`;
  const permissions = permissionContext(ctx, state);
  if (permissions) return permissions;
  if (state.started)
    return `Confirmed preflight execution agreement (not a sandbox): ${JSON.stringify({ goal: state.goal, phase: state.phase, planId: state.planId, planDigest: state.planDigest, proposal: state.proposal, selectedPermissionIds: state.approval?.permissionIds ?? [] })}\nMain must verify natural-language limits, prohibitions and reconfirmation conditions before every relevant action. A tool, advisor, READY or review result never grants permissions.`;
  if (state.phase === "interrupted" || state.phase === "revoked")
    return `Preflight ${state.phase}; no execution permission. Inspect history and use a new human preflight command before planning again.`;
  return `Preflight ${state.preflightId}; user-recorded goal: ${state.goal}\nPrepare a read-only proposal with scope, permissions, prohibitions and validation. Submit it through submit_preflight using this exact preflightId. Do not implement or start supervision. A proposal is not user approval. Current preflight phase: ${state.phase}.`;
}
export function preflightStatusLines(ctx: ExtensionContext): string[] {
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return [];
  const lines = [
    `Preflight: ${state.phase}; ${state.preflightId}`,
    `Preflight goal: ${state.goal}`,
  ];
  if (state.planId) lines.push(`Preflight plan: ${state.planId}; digest ${state.planDigest}`);
  if (state.approval)
    lines.push(
      `Preflight selected: ${state.approval.permissionIds.join(", ") || "none"}; missing required: ${missingRequired(state).join(", ") || "none"}`,
    );
  if (currentRuntime().preflightRepair) {
    lines.push(
      "Confirmed preflight result saved; projection repair pending; execution held.",
      "Next preflight: inspect, then /task-supervisor repair-preflight (cache only; no restart)",
    );
    return lines;
  }
  if (state.phase === "awaiting_authorization") {
    const response = permissionResponseText(ctx, state);
    if (response) lines.push(response);
    lines.push("Next preflight: /task-supervisor approve");
  }
  if (state.phase === "approved")
    lines.push("Permissions approved, not started.", "Next preflight: /task-supervisor start");
  return lines;
}
