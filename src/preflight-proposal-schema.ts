// Shared proposal wire only; no controller, runtime, or journal imports.
import { Type, type Static } from "typebox";
import { ApprovalPreparationSchema } from "./approval-schema";
const text = (max: number) => Type.String({ minLength: 1, maxLength: max }),
  strict = { additionalProperties: false };
const strings = (minimum = 0) => Type.Array(text(1000), { minItems: minimum, maxItems: 20 });
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
    contractProposalId: Type.Optional(text(200)),
    preparation: Type.Optional(ApprovalPreparationSchema),
  },
  strict,
);
export type PreflightProposal = Static<typeof PreflightProposalSchema>;
