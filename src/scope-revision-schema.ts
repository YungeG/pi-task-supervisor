import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PreflightProposalSchema } from "./preflight-proposal-schema";
import { AcceptanceProposalSchema } from "./acceptance-proposal";
export function isScopeRevisionProposalTool(pi: ExtensionAPI, name: string): boolean {
  return (
    name === "propose_scope_revision" &&
    pi
      .getAllTools()
      .some((tool) => tool.name === name && tool.parameters === ProposeScopeRevisionParams)
  );
}
export const ProposeScopeRevisionParams = Type.Object(
  {
    plan: Type.Omit(PreflightProposalSchema, ["contractProposalId"]),
    contract: AcceptanceProposalSchema,
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
