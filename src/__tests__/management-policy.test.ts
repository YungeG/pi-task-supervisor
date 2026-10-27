import { expect, it } from "vitest";
import {
  decideAdmission,
  workContext,
  type ManagementSnapshot,
  type AdmissionOperation,
} from "../management-policy";
import { sameGoalOwner, type WorkOwnerKey } from "../control-journal";
import { journalDigest } from "../human-journal";

// Pure policy inputs only, never native provenance, approval or qualification.
// Public command/SDK tests separately establish where trusted snapshots come from.
const owner: WorkOwnerKey = {
  kind: "goal",
  goal: {
    sessionId: "policy-only",
    goalKey: "synthetic-legacy",
    goalRunId: null,
    lifecycleCommitId: null,
  },
};
const boardOwner: WorkOwnerKey = {
  kind: "board",
  board: { sessionId: "policy-only", boardRunId: "synthetic-board", seedEntryId: "synthetic-seed" },
};
const base: ManagementSnapshot = {
  mode: "supervised",
  state: "active",
  activeWorkOwner: owner,
  context: workContext(owner),
  legacyEnabled: true,
  controlPending: false,
  supervisorStatus: "active",
  goalPhase: "active",
  source: "volatile",
  lastGoal: null,
  attention: [],
};
type Row = [
  string,
  Partial<ManagementSnapshot>,
  AdmissionOperation,
  "allow" | "readonly_only" | "deny",
];
const rows: Row[] = [
  [
    "integrity hold beats metadata flags",
    { journalFault: "Source unavailable" },
    { kind: "tool", metadataRepair: true },
    "deny",
  ],
  [
    "integrity hold preserves trusted read-only inspection",
    { journalFault: "Source unavailable" },
    { kind: "tool", readOnly: true },
    "readonly_only",
  ],
  [
    "integrity hold suppresses context",
    { journalFault: "Source unavailable" },
    { kind: "context" },
    "deny",
  ],
  [
    "pending native control admits exact original control repair",
    { controlPending: true },
    { kind: "tool", controlRepair: true },
    "allow",
  ],
  [
    "pending native control admits read-only only",
    { controlPending: true },
    { kind: "tool", readOnly: true },
    "readonly_only",
  ],
  [
    "pending native control blocks boundary",
    { controlPending: true },
    { kind: "boundary" },
    "deny",
  ],
  [
    "pending native control beats stopping metadata exception",
    { controlPending: true, state: "stopping-with-attention" },
    { kind: "tool", metadataRepair: true },
    "deny",
  ],
  [
    "stopping permits exact metadata repair",
    { state: "stopping-with-attention" },
    { kind: "tool", metadataRepair: true },
    "allow",
  ],
  [
    "stopping permits exact original control repair",
    { state: "stopping-with-attention" },
    { kind: "tool", controlRepair: true },
    "allow",
  ],
  [
    "stopping cannot turn validation into release",
    { state: "stopping-with-attention" },
    { kind: "tool", validationCheck: true },
    "deny",
  ],
  [
    "stopping allows readonly inspection",
    { state: "stopping-with-attention" },
    { kind: "tool", readOnly: true },
    "readonly_only",
  ],
  [
    "stopping suppresses context",
    { state: "stopping-with-attention" },
    { kind: "context" },
    "deny",
  ],
  [
    "off ordinary tool is unmanaged",
    { mode: "off", activeWorkOwner: null, context: workContext(null) },
    { kind: "tool" },
    "allow",
  ],
  [
    "off does not open preflight tools",
    { mode: "off", activeWorkOwner: null, context: workContext(null) },
    { kind: "tool", preflightTool: true },
    "deny",
  ],
  [
    "off has no native continuation",
    { mode: "off", activeWorkOwner: null, context: workContext(null) },
    { kind: "boundary" },
    "deny",
  ],
  [
    "legacy disabled state is held, not unmanaged",
    { source: "legacy-compatible", legacyEnabled: false },
    { kind: "tool" },
    "deny",
  ],
  [
    "legacy held reads stay readonly",
    { source: "legacy-compatible", legacyEnabled: false },
    { kind: "tool", readOnly: true },
    "readonly_only",
  ],
  [
    "legacy held suppresses context",
    { source: "legacy-compatible", legacyEnabled: false },
    { kind: "context" },
    "deny",
  ],
  [
    "tasks cannot submit supervised proposals",
    { mode: "tasks", activeWorkOwner: boardOwner, context: workContext(boardOwner) },
    { kind: "tool", preflightTool: true },
    "deny",
  ],
  ["active ordinary managed work", {}, { kind: "tool" }, "allow"],
  ["planning readonly context", { goalPhase: "planning" }, { kind: "context" }, "allow"],
  [
    "planning proposal exception",
    { goalPhase: "planning" },
    { kind: "tool", preflightTool: true },
    "allow",
  ],
  [
    "held proposal cannot grant itself planning",
    { goalPhase: "planning-interrupted" },
    { kind: "tool", preflightTool: true },
    "deny",
  ],
  [
    "held readonly tool",
    { supervisorStatus: "paused" },
    { kind: "tool", readOnly: true },
    "readonly_only",
  ],
  [
    "held metadata repair",
    { supervisorStatus: "fault" },
    { kind: "tool", metadataRepair: true },
    "allow",
  ],
  [
    "held native control repair",
    { supervisorStatus: "fault" },
    { kind: "tool", controlRepair: true },
    "allow",
  ],
  [
    "held qualified validation only",
    { supervisorStatus: "completed" },
    { kind: "tool", validationCheck: true },
    "allow",
  ],
  [
    "held context is readonly guidance, not execution",
    { supervisorStatus: "fault" },
    { kind: "context" },
    "allow",
  ],
];
it("compares semantic Goal owner identity without changing order-sensitive historical wire hashes", () => {
  const left = owner.goal;
  const reordered = {
    goalKey: left.goalKey,
    lifecycleCommitId: left.lifecycleCommitId,
    goalRunId: left.goalRunId,
    sessionId: left.sessionId,
  };
  expect(journalDigest(left)).not.toBe(journalDigest(reordered));
  expect(sameGoalOwner(left, reordered)).toBe(true);
  for (const field of ["sessionId", "goalKey", "goalRunId", "lifecycleCommitId"] as const)
    expect(sameGoalOwner(left, { ...left, [field]: "distinct" })).toBe(false);
});
it.each(rows)("applies shared policy: %s", (_name, change, operation, expected) => {
  const input = Object.freeze({ ...base, ...change });
  const before = JSON.stringify(input);
  const result = decideAdmission(input, Object.freeze(operation));
  expect(result.verdict).toBe(expected);
  expect(result.owner).toEqual(input.activeWorkOwner);
  expect(result.context).toEqual(input.context);
  expect(JSON.stringify(input)).toBe(before);
});
