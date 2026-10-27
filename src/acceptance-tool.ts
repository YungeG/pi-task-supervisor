import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeRegisteredCheck, proposeAcceptanceContract } from "./acceptance-runtime";
import { ProposeContractParams } from "./acceptance-proposal";
export { ProposeContractParams } from "./acceptance-proposal";
export function createProposeContractTool(
  pi: ExtensionAPI,
): ToolDefinition<typeof ProposeContractParams> {
  return {
    name: "propose_contract",
    label: "Propose Acceptance Contract",
    description:
      "Propose complete acceptance conditions and check specifications as untrusted planning metadata. This cannot grant trust, confirm artifacts, approve business permissions or start work. The user must use native review-contract before the normal Goal is compiled.",
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
export const RunCheckParams = Type.Object(
  { checkId: Type.String({ minLength: 1, maxLength: 100 }) },
  { additionalProperties: false },
);
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
