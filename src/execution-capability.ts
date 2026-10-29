import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { currentRuntime } from "./runtime";
import { approvalContractProposal } from "./approval-bundle";
import { inspectRestorableSession } from "./human-control";
import { RunCheckParams } from "./check-tool-schema";
import { codemodeCapability, invocationParent, SDK_TOOL_ONLY_CAPABILITY } from "./invocation-tree";
import { currentWorkOwner } from "./control-journal";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
export interface EvidenceCapability {
  route: "direct-check" | "tools-only-container" | "unsupported";
  reason: string;
}
/** Actual registry/loadout observations are guidance and gates, never execution proof. */
export function assessEvidenceCapability(pi: ExtensionAPI): EvidenceCapability {
  const tools = pi.getAllTools(),
    check = tools.find((tool) => tool.name === "run_check" && tool.parameters === RunCheckParams);
  if (!check)
    return {
      route: "unsupported",
      reason:
        "Formal evidence route unsupported: the original registered check tool is unavailable; inspect actual tool registration",
    };
  const container = tools.find((tool) => tool.name === "codemode"),
    active = pi.getActiveTools().includes("codemode");
  const only =
    active && typeof pi.getSettings === "function" && pi.getSettings().codemode?.mode === "only";
  if (!only && check.exposure === "direct")
    return {
      route: "direct-check",
      reason:
        "Use the original registered check and completion tools directly; auxiliary containers do not become qualified evidence",
    };
  if (active && codemodeCapability(container))
    return {
      route: "tools-only-container",
      reason:
        "Actual SDK tools-only container metadata is available; each invocation still requires closed effects and current evidence",
    };
  return {
    route: "unsupported",
    reason:
      "Formal evidence route unsupported: this loadout has no qualified direct check or original tools-only container. Default models-enabled codemode cannot supply container eligibility; choose a supported direct loadout explicitly",
  };
}
export function requireCurrentEvidenceCapability(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): EvidenceCapability | undefined {
  const state = currentRuntime().preflight;
  if (!state?.proposal?.contractProposalId) return;
  const journal = inspectRestorableSession(ctx, true);
  if (!journal) throw Error("Evidence capability needs the actual preflight source");
  const proposal = approvalContractProposal(journal, state).data.proposal;
  if (!proposal.checks.some((check) => check.kind === "automatic")) return;
  const result = assessEvidenceCapability(pi);
  if (result.route === "unsupported") {
    if (state.version === 2 && state.definitionApproval && state.planDigest)
      currentRuntime().preflightDefinitionBlock = {
        preflightId: state.preflightId,
        planDigest: state.planDigest,
        controlEntryId: state.definitionApproval.controlEntryId,
        kind: "capability",
        reason: result.reason,
      };
    throw Error(result.reason);
  }
  if (currentRuntime().preflightDefinitionBlock?.kind === "capability")
    currentRuntime().preflightDefinitionBlock = undefined;
  return result;
}
/** Source parent identity, not script text, decides whether this exact check may run. */
export function registeredCheckInvocationIssue(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  event: ToolCallEvent,
): string | undefined {
  if (event.toolName !== "run_check" || event.parentToolCallId === undefined) return;
  if (
    !pi
      .getAllTools()
      .some((tool) => tool.name === "run_check" && tool.parameters === RunCheckParams)
  )
    return "Original registered check metadata is unavailable";
  const graph = currentRuntime().controlJournal?.invocations,
    owner = currentWorkOwner(ctx.sessionManager.getSessionId());
  if (!graph || !owner) return "Nested formal check has no actual current invocation source";
  const parent = invocationParent(graph, owner, event.parentToolCallId),
    root = parent && graph.nodes.get(parent.rootId);
  return root?.capability === SDK_TOOL_ONLY_CAPABILITY
    ? undefined
    : "Formal check not started: unqualified container source; call the original registered check directly in a supported loadout";
}
