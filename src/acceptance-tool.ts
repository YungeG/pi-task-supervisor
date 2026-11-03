import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeRegisteredCheck, proposeAcceptanceContract } from "./acceptance-runtime";
import { ProposeContractParams } from "./acceptance-proposal";
import { RunCheckParams } from "./check-tool-schema";
export { RunCheckParams } from "./check-tool-schema";
export { ProposeContractParams } from "./acceptance-proposal";
import { ProposeScopeRevisionParams } from "./scope-revision-schema";
import { proposeScopeRevision } from "./scope-revision";
import { ScopeProposalError } from "./scope-guidance";
export function createProposeScopeRevisionTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof ProposeScopeRevisionParams> {
  return {
    name: "propose_scope_revision",
    label: "Propose Same-Goal Scope Revision",
    parameters: ProposeScopeRevisionParams,
    description:
      "Submit complete untrusted plan, contract AND reason for a paused/fault, already started and compiled Goal. Keep original permission id/action/target/environment/required fields, prohibitions and preparation unchanged. Exact business resource conditions in limits/plan/acceptance and supported check definitions may be proposed for native review, not granted by submission. Supervisor hard limits and spent review/continuation counters cannot expand/reset. Historical usage remains known/unknown as recorded; new approval never proves missing past metering or OS quota enforcement. Check timeouts remain profile-bounded (Node <=30000ms; Python unittest <=120000ms), not the business total allowance. Workspace, owner and first Start stay intact. If active, user pauses then explicitly requests a metadata-only Main turn; pause never queues Main. Use existing review-scope, not a separate budget command; recover and fresh evidence remain separate.",
    execute(_id, params, _signal, _update, ctx) {
      try {
        const result = proposeScopeRevision(pi, ctx, params);
        return Promise.resolve({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
          structuredContent: result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Scope proposal failed";
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: error instanceof ScopeProposalError ? `${message}\n${error.next}` : message,
            },
          ],
          details: { error: true, ...(error instanceof ScopeProposalError ? error.guidance : {}) },
          isError: true,
        });
      }
    },
  };
}
export function createProposeContractTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof ProposeContractParams> {
  return {
    name: "propose_contract",
    label: "Propose Acceptance Contract",
    description:
      "Propose complete acceptance conditions/check specifications as untrusted metadata before first board compilation. Already compiled work must stay held and use propose_scope_revision plus native review-scope, not this ordinary definition route. Completed work stays closed. No trust, business permission, execution or artifact acceptance from a proposal; original source/control gates remain.",
    parameters: ProposeContractParams,
    execute(_id, params, _signal, _update, ctx) {
      try {
        const result = proposeAcceptanceContract(pi, ctx, params.proposal);
        return Promise.resolve({
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
          structuredContent: result,
        });
      } catch (error) {
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: error instanceof Error ? error.message : "Contract proposal failed",
            },
          ],
          details: { error: true },
          isError: true,
        });
      }
    },
  };
}
const Output = Type.Object({
  id: Type.String(),
  runId: Type.String(),
  checkId: Type.String(),
  exit_code: Type.Union([Type.Integer(), Type.Null()]),
  result_digest: Type.String(),
  passed: Type.Boolean(),
});
/** Additive validation/business tool; never classified as a metadata or read-only tool. */
export function createRunCheckTool(pi: ExtensionAPI): ToolDefinition<typeof RunCheckParams> {
  return {
    name: "run_check",
    label: "Run Registered Check",
    description:
      "Run the exact trusted bound check definition by checkId. Command, scope, environment, expected cases and trust are host-bound, not caller fields. Original permissions/first-start and execution safety still apply; manual checks use the native verify-check command.",
    parameters: RunCheckParams,
    outputSchema: Output,
    async execute(id, params, signal, _update, ctx) {
      try {
        const result = await executeRegisteredCheck(pi, ctx, id, params.checkId, signal);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
          structuredContent: result,
          isError: !result.passed,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Registered check unavailable";
        return {
          content: [{ type: "text" as const, text: message }],
          details: { error: message },
          structuredContent: {
            id,
            runId: "unavailable",
            checkId: params.checkId,
            exit_code: null,
            result_digest: "unavailable",
            passed: false,
          },
          isError: true,
        };
      }
    },
  };
}
