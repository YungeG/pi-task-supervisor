import { Check } from "typebox/value";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PreflightState } from "./preflight";
import {
  contractProposalViews,
  proposalOriginalGoal,
  type ContractProposalView,
} from "./acceptance-planning";
import { captureUnownedArtifactInputs } from "./artifact-version";
import { inspectRestorableSession } from "./human-control";
import { journalDigest, type SessionJournal } from "./human-journal";
import { appendControlFence, readControlJournal } from "./control-journal";
import { currentRuntime } from "./runtime";
import { checkerScopeInventory, type AutomaticCheckProposal } from "./acceptance-proposal";
import { nativePlanDescriptor, type NativeCheckPlan } from "./check-profile";
import { ApprovalContractCaptureSchema, type ApprovalContractCapture } from "./approval-schema";
export {
  ApprovalReferenceSchema,
  ApprovalPreparationSchema,
  ApprovalContractCaptureSchema,
  type ApprovalContractCapture,
} from "./approval-schema";

export const PREFLIGHT_ASSOCIATION_FAULT =
  "Confirmed preflight definitions await exact association repair; no Main dispatch was performed";

export interface ApprovalAction {
  kind:
    | "plan"
    | "materials"
    | "permissions"
    | "rejected"
    | "definitions"
    | "start"
    | "preparing"
    | "association"
    | "bound"
    | "revoked";
  actor: "Main" | "user";
  command?: string;
  laterCommand?: string;
  effect: string;
  proposalId?: string;
}
function preparationPermissionAction(
  state: Extract<PreflightState, { version: 2 }>,
  proposalId: string,
): ApprovalAction | undefined {
  if (!state.permissionRequest?.acceptance?.pendingChecks.length) return;
  const selected = state.approval?.permissionIds ?? [];
  const needed = state.proposal?.preparation?.permissionIds ?? [];
  if (needed.every((id) => selected.includes(id))) return;
  const ids = [...new Set([...selected, ...needed])].sort();
  return {
    kind: "permissions",
    actor: "user",
    proposalId,
    command: `/task-supervisor approve ${state.planId} ${ids.join(",")}`,
    effect: "所选准备仍缺准确权限；明确核对新增选择，既有批准不代表这些权限，不请求 Start。",
  };
}
function beforeStartAction(
  state: Extract<PreflightState, { version: 2 }>,
  proposalId: string,
  stale: boolean,
): ApprovalAction {
  const preparation = preparationPermissionAction(state, proposalId);
  if (preparation) return preparation;
  if (
    stale ||
    !state.definitionApproval ||
    state.definitionApproval.requestId !== state.permissionRequest?.id
  )
    return {
      kind: "definitions",
      actor: "user",
      proposalId,
      command: "/task-supervisor approve",
      effect: "仅重新核对当前定义；既有业务权限不变，仍不启动。",
    };
  return {
    kind: "start",
    actor: "user",
    proposalId,
    command: "/task-supervisor start",
    effect: state.permissionRequest.acceptance?.pendingChecks.length
      ? "独立 Start 只允许已批准备先行；具体定义未确认前不编译、不 run_check、不判定通过。"
      : "独立确认首次 Start；动作时复核实际来源与版本，不扩大权限，不代表验收通过。",
  };
}
function needsPermissionReview(state: Extract<PreflightState, { version: 2 }>): boolean {
  const approval = state.approval;
  return (
    !approval ||
    Boolean(
      state.proposal?.permissions.some(
        (permission) => permission.required && !approval.permissionIds.includes(permission.id),
      ),
    )
  );
}
function isConsolidatedState(
  state: PreflightState | undefined,
): state is Extract<PreflightState, { version: 2 }> {
  return (
    state?.version === 2 &&
    (state.approvalFlow === "consolidated-v1" || Boolean(state.proposal?.contractProposalId))
  );
}
/** Derived requirement only, not a source/binding qualification. A pending checker
 * is the distinct explicitly authorized preparation route, not a failed association. */
export function needsPreflightAssociation(
  state: PreflightState | undefined,
  bound: boolean,
): boolean {
  return (
    !bound &&
    state?.version === 2 &&
    !!state.started &&
    !!state.proposal?.contractProposalId &&
    !state.permissionRequest?.acceptance?.pendingChecks.length
  );
}
/** Pure cached decision projection, never an execution/permission qualification. */
export function approvalAction(
  state: PreflightState | undefined,
  bound = false,
  stale = false,
): ApprovalAction | undefined {
  if (!isConsolidatedState(state)) return;
  if (state.phase === "interrupted") return;
  if (state.phase === "revoked")
    return {
      kind: "revoked",
      actor: "user",
      effect: "权限已撤销；不会恢复或重放。先检查已有执行与原范围，改变决定必须另行原生确认。",
    };
  if (!state.proposal)
    return {
      kind: "plan",
      actor: "Main",
      effect:
        "Main 先准备完整计划与验收提案，再用 submit_preflight 提交；目前不需要你批准或 Start。",
    };
  const proposalId = state.proposal.contractProposalId;
  if (!proposalId)
    return {
      kind: "materials",
      actor: "Main",
      effect:
        "Main 先 propose_contract，再 submit_preflight 补齐 contractProposalId；目前不请求批准或 Start。",
    };
  if (state.permissionDisposition === "rejected")
    return {
      kind: "rejected",
      actor: "Main",
      proposalId,
      effect: "本版方案已拒绝；Main 先调整范围/替代方案，不自动重问、不启动。",
    };
  if (needsPermissionReview(state))
    return {
      kind: "permissions",
      actor: "user",
      proposalId,
      command: "/task-supervisor approve",
      effect: "只确认所选业务范围与可用定义，不启动、不接受产物。",
    };
  if (!state.started) return beforeStartAction(state, proposalId, stale);
  if (needsPreflightAssociation(state, bound))
    return {
      kind: "association",
      actor: "user",
      proposalId,
      command: "/task-supervisor repair-preflight",
      effect:
        "已确认的具体定义仍缺实际 owner 关联；只精确修复元数据，不重批、不 Start、不恢复或派发。",
    };
  return bound
    ? {
        kind: "bound",
        actor: "Main",
        proposalId,
        effect: "定义已关联；仍需实际执行、当前版本证据及其余门，既有暂停不改变。",
      }
    : {
        kind: "preparing",
        actor: "Main",
        proposalId,
        laterCommand: `/task-supervisor review-contract ${proposalId}`,
        effect:
          "Main 先完成明确获准的准备；就绪后由用户检查/审核具体定义，不重复权限或 Start，不自动恢复暂停。",
      };
}

/** Publish the capability envelope before any new protocol payload. Old readers
 * must stop rather than silently falling back to their former approval semantics. */
export function ensureApprovalWorkflowFence(pi: ExtensionAPI, ctx: ExtensionContext): void {
  try {
    const features = readControlJournal(ctx).latestFence?.data.features ?? [];
    const required = [
      "approval-workflow-v1",
      "acceptance-contract-v1",
      "invocation-tree-v1",
    ] as const;
    if (!required.every((feature) => features.includes(feature)))
      appendControlFence(pi, ctx, [...new Set([...features, ...required])]);
  } catch (error) {
    currentRuntime().journalFault ??=
      "Approval workflow fence could not be source-verified; inspect without replay";
    currentRuntime().cancel();
    throw error;
  }
}
export function approvalContractProposal(
  journal: SessionJournal,
  state: Pick<PreflightState, "sessionId" | "preflightId" | "goal" | "proposal">,
): ContractProposalView {
  const proposalId = state.proposal?.contractProposalId;
  if (!proposalId) throw Error("Complete the acceptance proposal before requesting approval");
  const proposal = contractProposalViews(journal).find(
    (item) => item.data.proposalId === proposalId,
  );
  if (
    !proposal ||
    proposal.data.sessionId !== state.sessionId ||
    proposal.data.target.kind !== "preflight" ||
    proposal.data.target.preflightId !== state.preflightId ||
    proposalOriginalGoal(journal, proposal.data, journal.branch.length) !== state.goal
  )
    throw Error("The acceptance proposal does not belong to this exact preflight and Goal");
  return proposal;
}
function workspaceAt(root: string) {
  const canonical = resolve(root);
  const stat = lstatSync(canonical, { bigint: true });
  if (!stat.isDirectory() || realpathSync(canonical) !== canonical)
    throw Error("Approval workspace is unavailable or symbolic");
  return { root: canonical, device: String(stat.dev), inode: String(stat.ino) };
}
function validatePreparation(
  state: Pick<PreflightState, "proposal">,
  proposal: ContractProposalView["data"]["proposal"],
): Set<string> {
  const preparation = state.proposal?.preparation;
  if (!preparation) return new Set();
  const checks = new Set(
    proposal.checks.filter((item) => item.kind === "automatic").map((c) => c.checkId),
  );
  const permissions = new Set(state.proposal?.permissions.map((p) => p.id));
  if (
    !preparation.checkIds.every((value) => checks.has(value)) ||
    !preparation.permissionIds.every((value) => permissions.has(value))
  )
    throw Error("Preparation must name exact declared automatic checks and permission IDs");
  return new Set(preparation.checkIds);
}

function checkerCapturePlan(
  check: AutomaticCheckProposal,
  state: Pick<PreflightState, "proposal">,
  workspace: ApprovalContractCapture["workspace"],
  scope: NativeCheckPlan["scope"],
  environment: Record<string, string>,
  environmentDigest: string,
) {
  const root = check.checkerRoot ?? workspace.root;
  if (!isAbsolute(root) || resolve(root) !== root)
    throw Error(`Check ${check.checkId}: checkerRoot must be an exact absolute root`);
  if (check.runtime || check.checkerRoot) {
    const permission = state.proposal?.permissions.find((p) => p.id === check.permissionId);
    if (!permission || permission.target !== root || !permission.required)
      throw Error(
        `Check ${check.checkId}: a required exact permission target must cover its formal checker root/profile`,
      );
  }
  const invocation = nativePlanDescriptor(
    {
      scope,
      checkId: check.checkId,
      script: check.script,
      args: check.args,
      timeoutMs: check.timeoutMs,
      environment: environment,
      ...(check.runtime ? { runtime: check.runtime, tests: check.tests } : {}),
    },
    workspace,
    environmentDigest,
  );
  return { root, invocation };
}
function assertProductInputs(
  proposal: ContractProposalView["data"]["proposal"],
  root: string,
  inputs: string[],
): void {
  if (inputs.length) {
    const captured = captureUnownedArtifactInputs(
      {
        scopeId: proposal.scopeId,
        root: root,
        inputs: inputs,
        artifacts: [],
        environmentKeys: Object.keys(proposal.environment.values),
      },
      proposal.environment.values,
    );
    if (captured.status !== "known")
      throw Error(`Required product inputs are unavailable: ${captured.reason}`);
  }
}
/** Host preparation only. A model proposal and this snapshot alone never grant trust. */
export function captureApprovalContract(
  ctx: ExtensionContext,
  state: Pick<PreflightState, "sessionId" | "preflightId" | "goal" | "proposal">,
): ApprovalContractCapture {
  const journal = inspectRestorableSession(ctx, true);
  if (!journal || journal.cwd !== resolve(ctx.cwd))
    throw Error("Approval requires its actual physical workspace and Session");
  const view = approvalContractProposal(journal, state);
  const proposal = view.data.proposal;
  const workspace = workspaceAt(ctx.cwd);
  const preparing = validatePreparation(state, proposal);
  const inventory = checkerScopeInventory(workspace.root, proposal.inputs, proposal.checks);
  const environmentDigest = journalDigest(
    Object.keys(proposal.environment.values)
      .sort()
      .map((key) => [key, proposal.environment.values[key]]),
  );
  assertProductInputs(proposal, workspace.root, inventory.inputs);
  const scope = {
    scopeId: proposal.scopeId,
    root: workspace.root,
    inputs: inventory.inputs,
    artifacts: proposal.artifacts,
    checkerScopes: inventory.checkerScopes,
    environmentKeys: Object.keys(proposal.environment.values),
  };
  const checkers: ApprovalContractCapture["checkers"] = [];
  const pendingChecks: string[] = [];
  for (const check of proposal.checks) {
    if (check.kind !== "automatic") continue;
    const { root, invocation } = checkerCapturePlan(
      check,
      state,
      workspace,
      scope,
      proposal.environment.values,
      environmentDigest,
    );
    if (root !== workspace.root) {
      if (!preparing.has(check.checkId))
        throw Error(
          `Check ${check.checkId}: external bytes need approved preparation before capture`,
        );
      pendingChecks.push(check.checkId);
      continue;
    }
    const files = [...check.checkerFiles, ...check.configs].sort();
    const captured = captureUnownedArtifactInputs(
      {
        scopeId: proposal.scopeId,
        root,
        inputs: files,
        artifacts: [],
        environmentKeys: Object.keys(proposal.environment.values),
      },
      proposal.environment.values,
    );
    if (captured.status !== "known") {
      if (!preparing.has(check.checkId))
        throw Error(
          `Check ${check.checkId}: checker/config capture is unknown (${captured.reason})`,
        );
      pendingChecks.push(check.checkId);
      continue;
    }
    checkers.push({
      checkId: check.checkId,
      workspace: captured.snapshot.workspace,
      files: captured.snapshot.inputs,
      invocation,
    });
  }
  const capture: ApprovalContractCapture = {
    version: 1,
    proposalId: view.data.proposalId,
    proposalRef: { entryId: view.entryId, digest: view.digest },
    workspace,
    environmentDigest,
    executable: process.execPath,
    nodeVersion: process.version,
    platform: process.platform,
    checkers,
    pendingChecks,
  };
  if (
    !Check(ApprovalContractCaptureSchema, capture) ||
    Buffer.byteLength(JSON.stringify(capture)) > 16000
  )
    throw Error("Captured approval definitions exceed the bounded native material capacity");
  return capture;
}
