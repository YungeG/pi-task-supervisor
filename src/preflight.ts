import { createHash, randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
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
export const PreflightControlSchema = Type.Object(
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
export type PreflightControl = Static<typeof PreflightControlSchema>;
export const PreflightStateSchema = Type.Object(
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
export type PreflightState = Static<typeof PreflightStateSchema>;

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
    version: 1,
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
function permissionSelection(state: PreflightState, selection: string): string[] {
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
export function approvePreflight(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  planId: string,
  selection: string,
): PreflightState {
  const issue = controlIssue(ctx);
  if (issue) throw new Error(issue);
  const state = requireOwn(ctx);
  const invalid = proposalIssue(state);
  if (invalid) throw new Error(invalid);
  if (planId !== state.planId || !state.proposal || !state.planDigest)
    throw new Error("Preflight plan ID is stale or no complete proposal exists");
  const permissionIds = permissionSelection(state, selection);
  const createdAt = new Date().toISOString();
  const control: PreflightControl = {
    kind: "approve",
    sessionId: state.sessionId,
    preflightId: state.preflightId,
    planId,
    planDigest: state.planDigest,
    permissionIds,
    createdAt,
  };
  const controlEntryId = appendControl(pi, ctx, control);
  const next: PreflightState = {
    ...state,
    approval: { planId, planDigest: state.planDigest, permissionIds, controlEntryId, createdAt },
    phase: "awaiting_authorization",
  };
  if (!missingRequired(next).length) next.phase = next.started ? "started" : "approved";
  return savePreflight(pi, next);
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
function proposalIssue(state: PreflightState): string | undefined {
  if (!Check(PreflightStateSchema, state) || !safeStrings(state)) return "Invalid preflight state";
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
function currentControls(ctx: ExtensionContext): Array<{ id: string; data: PreflightControl }> {
  const controls: Array<{ id: string; data: PreflightControl }> = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== PREFLIGHT_CONTROL_ENTRY) continue;
    if (foreignRecord(entry.data, ctx.sessionManager.getSessionId())) continue;
    if (
      !Check(PreflightControlSchema, entry.data) ||
      (entry.data.kind === "revoke" && entry.data.permissionIds.length)
    )
      throw new Error("Invalid preflight control journal");
    controls.push({ id: entry.id, data: entry.data });
  }
  return controls;
}
function controlClosureIssue(ctx: ExtensionContext, state: PreflightState): string | undefined {
  let controls: ReturnType<typeof currentControls>;
  try {
    controls = currentControls(ctx);
  } catch {
    return "Invalid preflight control journal";
  }
  const latest = controls.reverse().find((entry) => entry.data.preflightId === state.preflightId);
  const approval = state.approval;
  if (!approval || !latest || latest.id !== approval.controlEntryId)
    return "No current-branch human control closure for preflight approval";
  const control = latest.data;
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
      JSON.stringify(permissionSelection(state, ids.length ? ids.join(",") : "none")) ===
      JSON.stringify(ids)
    );
  } catch {
    return false;
  }
}
function approvalIssue(ctx: ExtensionContext, state: PreflightState): string | undefined {
  const invalid = proposalIssue(state);
  if (invalid) return invalid;
  const approval = state.approval;
  if (state.phase === "revoked" || !approval)
    return "Preflight authorization is absent or revoked; obtain exact human approval";
  if (approval.planId !== state.planId || approval.planDigest !== state.planDigest)
    return "Preflight approval is stale";
  if (!validSelection(state, approval.permissionIds))
    return "Invalid preflight permission selection";
  const closure = controlClosureIssue(ctx, state);
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
export function preflightStartBinding(
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
export function markPreflightStarted(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  binding: PreflightBinding,
): void {
  const state = requireOwn(ctx);
  if (state.started || state.phase !== "approved")
    throw new Error("Preflight startup was already used or is not approved");
  if (
    state.preflightId !== binding.preflightId ||
    state.planId !== binding.planId ||
    state.planDigest !== binding.planDigest
  )
    throw new Error("Preflight changed before startup commit");
  const issue = approvalIssue(ctx, state);
  if (issue) throw new Error(issue);
  savePreflight(pi, {
    ...state,
    phase: "started",
    started: { goal: state.goal, startedAt: new Date().toISOString() },
  });
}
export function preflightAuthorizationIssue(
  ctx: ExtensionContext | undefined,
  binding: PreflightBinding,
): string | undefined {
  if (!ctx) return "Bound preflight requires a current-session verification context";
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
  const owner = currentRuntime().supervisor;
  if (
    owner?.preflightBinding?.preflightId === binding.preflightId &&
    normalizeGoal(owner.goal) !== state.goal
  )
    return "Bound supervisor goal changed; obtain a new exact preflight";
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
function restoreApproval(ctx: ExtensionContext, state: PreflightState): void {
  if (!state.approval) {
    if (["approved", "started"].includes(state.phase))
      throw new Error("Preflight claims approval without human control closure");
    return;
  }
  const issue = approvalIssue(ctx, state);
  if (
    issue &&
    !(
      state.phase === "awaiting_authorization" &&
      issue.startsWith("Preflight missing required permissions:")
    )
  )
    throw new Error(issue);
}
function restoreControlSnapshot(
  state: PreflightState,
  controls: ReturnType<typeof currentControls>,
): void {
  const latest = controls
    .reverse()
    .find((entry) => entry.data.preflightId === state.preflightId)?.data;
  if (!latest || latest.planId !== state.planId) return;
  if (
    (latest.kind === "revoke" && state.phase !== "revoked") ||
    (latest.kind === "approve" && !state.approval)
  )
    throw new Error("Incomplete preflight control persistence; inspect before recovery");
}
export function restorePreflight(ctx: ExtensionContext): void {
  currentRuntime().preflight = undefined;
  let state: PreflightState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== PREFLIGHT_ENTRY) continue;
    if (foreignRecord(entry.data, ctx.sessionManager.getSessionId())) continue;
    state = restoredSnapshot(entry.data);
  }
  const controls = currentControls(ctx);
  if (!state) return;
  restoreApproval(ctx, state);
  restoreControlSnapshot(state, controls);
  currentRuntime().preflight =
    state.phase === "planning" ? { ...state, phase: "interrupted" } : state;
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

export function preflightContext(ctx: ExtensionContext): string | undefined {
  const state = currentRuntime().preflight;
  if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return undefined;
  const owner = currentRuntime().supervisor;
  if (owner && !owner.preflightBinding && unboundLegacyGoal(state, owner.goal)) return undefined;
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
  if (state.phase === "awaiting_authorization")
    lines.push(`Next preflight: /task-supervisor approve ${state.planId} <all|none|IDs>`);
  if (state.phase === "approved")
    lines.push(`Next preflight: /task-supervisor start ${state.planId}`);
  return lines;
}
