import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
const strict = { additionalProperties: false } as const;
const text = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const identifiers = () => Type.Array(text(100), { minItems: 1, maxItems: 16, uniqueItems: true });
export const RequirementSchema = Type.Object(
  { requirementId: text(100), source: text(300), text: text(1200), required: Type.Boolean() },
  strict,
);
export const CheckExpectationSchema = Type.Object(
  {
    minTests: Type.Integer({ minimum: 1, maximum: 1000000 }),
    requiredCases: Type.Array(text(200), { maxItems: 32, uniqueItems: true }),
    allowedSkipped: Type.Array(text(200), { maxItems: 32, uniqueItems: true }),
  },
  strict,
);
const checkIdentity = { checkId: text(100), requirementIds: identifiers() };
const automatic = Type.Object(
  {
    ...checkIdentity,
    kind: Type.Literal("automatic"),
    script: text(4096),
    checkerFiles: Type.Array(text(4096), { minItems: 1, maxItems: 32, uniqueItems: true }),
    configs: Type.Array(text(4096), { maxItems: 32, uniqueItems: true }),
    args: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 64 }),
    timeoutMs: Type.Integer({ minimum: 1, maximum: 30000 }),
    expected: CheckExpectationSchema,
  },
  strict,
);
const response = Type.Union([
  Type.Object(
    {
      kind: Type.Literal("choice"),
      options: Type.Array(text(300), { minItems: 2, maxItems: 10, uniqueItems: true }),
    },
    strict,
  ),
  Type.Object(
    {
      kind: Type.Literal("information"),
      format: Type.Union([Type.Literal("text"), Type.Literal("integer"), Type.Literal("date")]),
    },
    strict,
  ),
]);
const manual = Type.Object(
  {
    ...checkIdentity,
    kind: Type.Literal("manual"),
    question: text(1200),
    response,
    expectedValue: text(1000),
  },
  strict,
);
export const AcceptanceProposalSchema = Type.Object(
  {
    version: Type.Literal(1),
    scopeId: text(200),
    inputs: Type.Array(text(4096), { minItems: 1, maxItems: 512, uniqueItems: true }),
    artifacts: Type.Array(text(4096), { maxItems: 512, uniqueItems: true }),
    environment: Type.Object(
      {
        profileId: text(100),
        values: Type.Record(
          Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_.-]{0,99}$" }),
          Type.String({ maxLength: 1000 }),
          strict,
        ),
      },
      strict,
    ),
    requirements: Type.Array(RequirementSchema, { minItems: 1, maxItems: 16 }),
    checks: Type.Array(Type.Union([automatic, manual]), { minItems: 1, maxItems: 16 }),
  },
  strict,
);
export const ProposeContractParams = Type.Object({ proposal: AcceptanceProposalSchema }, strict);
export type AcceptanceProposal = Static<typeof AcceptanceProposalSchema>;
export type AutomaticCheckProposal = Extract<
  AcceptanceProposal["checks"][number],
  { kind: "automatic" }
>;
export type ManualCheckProposal = Extract<AcceptanceProposal["checks"][number], { kind: "manual" }>;
function proposalPath(path: string): boolean {
  return (
    !/[\\\p{Cc}\p{Cf}\p{Cs}*?{},[\]]/u.test(path) &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}
function completeCheck(
  check: AcceptanceProposal["checks"][number],
  proposal: AcceptanceProposal,
  requirements: Set<string>,
): boolean {
  if (!check.requirementIds.every((id) => requirements.has(id))) return false;
  if (check.kind === "manual")
    return check.response.kind !== "choice" || check.response.options.includes(check.expectedValue);
  const files = [...check.checkerFiles, ...check.configs];
  return (
    files.length <= 32 &&
    new Set(files).size === files.length &&
    check.checkerFiles.includes(check.script) &&
    files.every((path) => proposal.inputs.includes(path)) &&
    check.args.every((arg) => !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(arg))
  );
}
/** Untrusted normalization only. No trust/owner/grant/result field is accepted. The native
 * binder must still capture actual file/profile bytes and verify original context. */
export function validateAcceptanceProposal(value: unknown): AcceptanceProposal {
  if (!Check(AcceptanceProposalSchema, value))
    throw Error("Acceptance proposal has an invalid structural schema");
  const files = [...value.inputs, ...value.artifacts],
    requirements = new Set(value.requirements.map((item) => item.requirementId));
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") > 64000 ||
    files.length > 512 ||
    new Set(files).size !== files.length ||
    !files.every(proposalPath) ||
    requirements.size !== value.requirements.length ||
    new Set(value.checks.map((check) => check.checkId)).size !== value.checks.length ||
    !value.requirements.some((requirement) => requirement.required)
  )
    throw Error("Acceptance proposal exceeds capacity or has ambiguous identities/paths");
  if (
    !value.checks.every((check) => completeCheck(check, value, requirements)) ||
    !value.requirements.every(
      (requirement) =>
        !requirement.required ||
        value.checks.some((check) => check.requirementIds.includes(requirement.requirementId)),
    )
  )
    throw Error(
      "Acceptance proposal lacks exact declared checker inputs or required-condition coverage",
    );
  return structuredClone(value);
}
export interface RecognizedAcceptanceSuite {
  expectedOriginalGoal: string;
  proposal: AcceptanceProposal;
}
const recognizedSuites = new WeakMap<object, RecognizedAcceptanceSuite>();
/** Trusted host-code API only; deliberately not an agent tool or native answer. */
export function recognizeAcceptanceSuite(expectedOriginalGoal: string, proposal: unknown): object {
  if (
    !expectedOriginalGoal.trim() ||
    Buffer.byteLength(expectedOriginalGoal) > 4000 ||
    /[\p{Cc}\p{Cf}\p{Cs}]/u.test(expectedOriginalGoal)
  )
    throw Error("Acceptance proposal needs its exact bounded original Goal");
  const normalized = validateAcceptanceProposal(proposal),
    token = Object.freeze({});
  recognizedSuites.set(token, { expectedOriginalGoal, proposal: normalized });
  return token;
}
export function recognizedAcceptanceSuite(value: unknown): RecognizedAcceptanceSuite | undefined {
  const recognized = value && typeof value === "object" ? recognizedSuites.get(value) : undefined;
  return recognized ? structuredClone(recognized) : undefined;
}
