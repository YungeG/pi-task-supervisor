export const SCOPE_REVISION_FAULT =
  "Scope revision metadata is incomplete; inspect or repair the exact original native source, without replay or recovery";
import { Type, type TSchema } from "typebox";
import type { WorkOwnerKey } from "./control-journal";
import { GoalReadbackFrameSchema, type GoalReadbackFrame } from "./human-journal";
import type { AcceptanceReference } from "./acceptance-contract";
export interface ScopeRevisionControl {
  version: 1;
  kind: "acceptance-scope-control";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  proposalRef: AcceptanceReference;
  previousControlRef: AcceptanceReference | null;
  contractId: string;
  revision: number;
  frame: GoalReadbackFrame;
  value: "Approve revision" | "Reject revision";
  versionId: string;
  inputGeneration: string;
}
export interface ScopeRevisionCommitted {
  version: 1;
  kind: "scope-revision-committed";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  proposalRef: AcceptanceReference;
  controlRef: AcceptanceReference;
  witnessRef: AcceptanceReference;
  previousRevisionRef: AcceptanceReference | null;
  contractRef: AcceptanceReference;
}
export interface ScopeRevisionRevoked {
  version: 1;
  kind: "scope-revision-revoked";
  recordId: string;
  owner: WorkOwnerKey;
  sourceRef: AcceptanceReference;
  revisionRef: AcceptanceReference;
}
export type ScopeRevisionFact =
  | ScopeRevisionControl
  | ScopeRevisionCommitted
  | ScopeRevisionRevoked;
/** Built lazily by the journal after its canonical owner schema is initialized. */
export function scopeRevisionSchemas(owner: TSchema) {
  const strict = { additionalProperties: false } as const,
    id = Type.String({ minLength: 1, maxLength: 200 }),
    hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
  const reference = Type.Object({ entryId: id, digest: hash }, strict),
    nullable = Type.Union([reference, Type.Null()]);
  const common = { version: Type.Literal(1), recordId: id, owner, sourceRef: reference };
  return [
    Type.Object(
      {
        ...common,
        kind: Type.Literal("acceptance-scope-control"),
        proposalRef: reference,
        previousControlRef: nullable,
        contractId: id,
        revision: Type.Integer({ minimum: 1, maximum: 16 }),
        frame: GoalReadbackFrameSchema,
        value: Type.Union([Type.Literal("Approve revision"), Type.Literal("Reject revision")]),
        versionId: hash,
        inputGeneration: hash,
      },
      strict,
    ),
    Type.Object(
      {
        ...common,
        kind: Type.Literal("scope-revision-committed"),
        proposalRef: reference,
        controlRef: reference,
        witnessRef: reference,
        previousRevisionRef: nullable,
        contractRef: reference,
      },
      strict,
    ),
    Type.Object(
      { ...common, kind: Type.Literal("scope-revision-revoked"), revisionRef: reference },
      strict,
    ),
  ];
}
