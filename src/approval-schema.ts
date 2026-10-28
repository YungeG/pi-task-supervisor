// Shared wire schemas only: no journal, runtime, controller or approval side effects.
import { Type, type Static } from "typebox";
import { ExecutionDescriptorSchema } from "./check-profile";

const strict = { additionalProperties: false } as const;
const id = (max = 200) => Type.String({ minLength: 1, maxLength: max });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
export const ApprovalReferenceSchema = Type.Object({ entryId: id(), digest: hash }, strict);
const WorkspaceSchema = Type.Object({ root: id(4096), device: id(100), inode: id(100) }, strict);
const FileSchema = Type.Object(
  {
    path: id(4096),
    bytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    sha256: hash,
  },
  strict,
);
export const ApprovalPreparationSchema = Type.Object(
  {
    checkIds: Type.Array(id(100), { minItems: 1, maxItems: 16, uniqueItems: true }),
    steps: Type.Array(id(1000), { minItems: 1, maxItems: 20 }),
    permissionIds: Type.Array(id(64), { minItems: 1, maxItems: 20, uniqueItems: true }),
  },
  strict,
);
export const ApprovalContractCaptureSchema = Type.Object(
  {
    version: Type.Literal(1),
    proposalId: id(),
    proposalRef: ApprovalReferenceSchema,
    workspace: WorkspaceSchema,
    environmentDigest: hash,
    executable: id(4096),
    nodeVersion: id(100),
    platform: id(100),
    checkers: Type.Array(
      Type.Object(
        {
          checkId: id(100),
          workspace: WorkspaceSchema,
          files: Type.Array(FileSchema, { maxItems: 32 }),
          invocation: Type.Optional(ExecutionDescriptorSchema),
        },
        strict,
      ),
      { maxItems: 16 },
    ),
    pendingChecks: Type.Array(id(100), { maxItems: 16, uniqueItems: true }),
  },
  strict,
);
export type ApprovalContractCapture = Static<typeof ApprovalContractCaptureSchema>;
