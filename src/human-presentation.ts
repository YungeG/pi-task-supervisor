import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { PreflightState, PreflightProposal } from "./preflight";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PreflightHumanResult } from "./preflight-human";
import type { BoardHumanResult } from "./board-human";
import type { DecisionRecord } from "./types";
import type { HumanMaterial } from "./human-material-view";

export interface HumanNotice {
  message: string;
  level: "info" | "warning" | "error";
}

export function preflightNotice(result: Partial<PreflightHumanResult>): HumanNotice {
  if (result.startupPending === "startup")
    return {
      message: "启动确认已保存，但启动结果尚未确认。请检查已有记录，不要重复启动。",
      level: "warning",
    };
  if (result.projectionPending)
    return {
      message:
        "确认已保存，但状态记录尚未同步；执行仍被阻止，无需重复批准。\n下一步：/task-supervisor repair-preflight（仅修复记录，其他门槛仍有效）",
      level: "warning",
    };
  if (!result.status) return { message: "正在等待方案确认结果。", level: "info" };
  const retained = result.state?.started ? "既有启动记录保留，未自动恢复或重启。" : "尚未启动。";
  const messages = {
    approved: `权限已确认。${retained}${result.state?.started ? "" : "\n下一步：/task-supervisor start（独立确认）"}`,
    partial: `已保存所选权限，但必需权限尚未齐全。${retained}\n下一步：/task-supervisor approve`,
    rejected: `本次范围未获允许。${retained}不会自动重复询问；请先检查或修改方案。`,
    deferred: "本次未提交确认，既有授权及执行状态未改变。可稍后再处理。",
    unsupported: "当前环境无法提交确认。请使用本机 Pi 交互终端；既有状态未改变。",
    started: "启动确认已保存，等待 Main 推进。权限、证据和预算门槛仍有效，不代表任务完成。",
    already_saved: "已找到保存的记录，本次没有重复确认或启动。其他门槛仍有效。",
  };
  return {
    message: messages[result.status],
    level: ["partial", "rejected", "unsupported"].includes(result.status) ? "warning" : "info",
  };
}

export function boardNotice(result: BoardHumanResult): HumanNotice {
  if (result.projectionPending)
    return {
      message:
        "回应已保存，但状态记录尚未同步；无需重复确认。\n下一步：/task-supervisor repair-decision（其他门槛仍有效）",
      level: "warning",
    };
  const messages = {
    approved: "本次范围已确认。未改变任务证据、预算或其他权限门槛。",
    answered: "答案已保存，未新增业务权限。其他门槛仍有效。",
    rejected: "本次范围未获允许。请修改方案后再提出完整请求；不会自动重复询问。",
    deferred: "本次未提交回应，任务仍在等待。可稍后使用 /task-supervisor decide。",
    unsupported: "当前环境无法提交回应，请使用本机 Pi 交互终端。",
    legacy: "旧请求缺少结构化范围，需要 Main 提出完整替代方案；聊天文本不能批准。",
  };
  return {
    message: messages[result.status],
    level: ["rejected", "unsupported", "legacy"].includes(result.status) ? "warning" : "info",
  };
}

function displayText(value: string): string {
  const text = stripTerminalSequences(value);
  // Scope strings are not display-normalized: preserve meaningful whitespace
  // and make multiline/control-like separators explicit instead of new headers.
  return /[\r\n\t]|^\s|\s$| {2}/u.test(text) ? JSON.stringify(text) : text;
}
function list(title: string, values: readonly string[]): string {
  return `${title}\n${values.length ? values.map((value) => `• ${displayText(value)}`).join("\n") : "• 无"}`;
}
function permissionText(permission: PreflightProposal["permissions"][number]): string {
  return [
    `• [${displayText(permission.id)}] ${permission.required ? "必需" : "可选"}：${displayText(permission.action)}`,
    `  对象：${displayText(permission.target)}`,
    `  环境：${displayText(permission.environment)}`,
    `  限制：${displayText(permission.limits)}`,
    `  风险：${displayText(permission.risks)}`,
    `  替代方案：${displayText(permission.fallback)}`,
    `  重新确认条件：${displayText(permission.reconfirm)}`,
  ].join("\n");
}
export function readablePreflight(
  state: PreflightState,
  selectedIds: readonly string[],
  start: boolean,
): { title: string; body: string } {
  const title = start ? "是否启动已确认的方案？" : "是否允许本次明确范围？";
  const proposal = state.proposal;
  if (!proposal)
    return {
      title,
      body: `目标：${displayText(state.goal)}\n尚无完整方案，不能从这段提示取得权限。`,
    };
  const selected = proposal.permissions.filter((permission) => selectedIds.includes(permission.id));
  const unselected = proposal.permissions.filter(
    (permission) => !selectedIds.includes(permission.id),
  );
  const body = [
    `目标：${displayText(state.goal)}`,
    `方案：${displayText(proposal.summary)}`,
    `本次允许（只包含以下所选权限）\n${selected.map(permissionText).join("\n") || "• 无额外权限"}`,
    `未选择，本次不授权\n${unselected.map(permissionText).join("\n") || "• 无"}`,
    list("执行计划", proposal.steps),
    list("验收要求", proposal.acceptance),
    list("禁止事项", proposal.prohibitions),
    list("需要重新确认的变化", proposal.reconfirm),
    start
      ? "本次仅确认首次启动，不扩大已有权限。回执、证据、预算和其他门槛仍有效。"
      : "本次仅保存权限决定，不会启动执行。启动需要另一次独立确认；聊天文本不能批准。",
  ].join("\n\n");
  return { title, body };
}

/** Readable request material, not an approval or task acceptance. */
export function readableBoardRequest(decision: Readonly<DecisionRecord>): {
  title: string;
  body: string;
} {
  const spec = decision.spec;
  const details = [
    `请求：${displayText(decision.id)}；任务：${displayText(decision.taskId)}`,
    `提出时间：${displayText(decision.createdAt)}`,
    displayText(decision.whyUserOwned),
  ];
  if (decision.supersedes) details.push(`替代请求：${displayText(decision.supersedes)}`);
  if (!spec)
    details.push("旧请求缺少结构化范围，权限未知；需要 Main 提出完整替代方案。聊天文本不能批准。");
  else if (spec.kind === "authorization")
    details.push(
      `本次允许的范围：\n${displayText(spec.scope)}`,
      list("禁止事项：", spec.prohibitions),
      "只确认上述范围，不代表任务验收通过；其他门槛仍有效。",
    );
  else if (spec.kind === "choice")
    details.push(
      "本次仅提供业务选择，不新增业务权限。",
      list("业务选项：", decision.options ?? []),
    );
  else details.push(`本次仅提供信息（${spec.format}），不新增业务权限。`);
  if (!spec && decision.options)
    details.push(list("旧请求原选项（不代表授权）：", decision.options));
  if (decision.response) details.push(`原回应标记：${displayText(decision.response)}`);
  return { title: displayText(decision.question), body: details.join("\n\n") };
}

function materialList(values: readonly string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "无";
}

/** Formatted browsing from original owner fields, never a replacement for exact-source review. */
export function boardMaterial(decision: Readonly<DecisionRecord>): HumanMaterial {
  const sections = [
    { title: "需要你决定", markdown: `${decision.question}\n\n${decision.whyUserOwned}` },
  ];
  const spec = decision.spec;
  if (spec?.kind === "authorization")
    sections.push(
      { title: "本次请求的范围", markdown: spec.scope },
      { title: "禁止事项", markdown: materialList(spec.prohibitions) },
      { title: "回应含义", markdown: "只确认所示范围，不代表任务验收通过；其他门槛仍有效。" },
    );
  else if (spec?.kind === "choice")
    sections.push({
      title: "业务选项（原值仍须核对）",
      markdown: (decision.options ?? [])
        .map((option, index) => `### 选项 ${index + 1}\n\n${option}`)
        .join("\n\n"),
    });
  else if (spec?.kind === "information")
    sections.push({
      title: "填写要求（不新增业务权限）",
      markdown:
        spec.format === "date"
          ? "日期：YYYY-MM-DD"
          : spec.format === "integer"
            ? "整数，原值保存"
            : "文本，不超过1000字；原值保存",
    });
  else
    sections.push({
      title: "缺少结构化范围",
      markdown: "权限未知，需要完整替代请求；浏览不能取得权限。",
    });
  const summary =
    spec?.kind === "authorization"
      ? [`范围：${spec.scope}`, `禁止：${spec.prohibitions.join("；")}`]
      : [
          `影响：本次仅${spec?.kind === "information" ? "填写信息" : "选择方案"}，不新增执行权限。`,
          `用途：${decision.whyUserOwned}`,
        ];
  return { context: decision.question, summary, sections };
}

function permissionMaterial(
  permission: PreflightProposal["permissions"][number],
  selected: boolean,
): HumanMaterial["sections"][number] {
  return {
    title: `${selected ? "请求允许" : "本次不授权"} · ${permission.id} · ${permission.required ? "必需" : "可选"}`,
    markdown: [
      permission.action,
      `**对象**\n\n${permission.target}`,
      `**环境**\n\n${permission.environment}`,
      `**限制**\n\n${permission.limits}`,
      `**风险**\n\n${permission.risks}`,
      `**替代方案**\n\n${permission.fallback}`,
      `**重新确认条件**\n\n${permission.reconfirm}`,
    ].join("\n\n"),
  };
}

export function preflightMaterial(
  state: PreflightState,
  selectedIds: readonly string[],
  start: boolean,
): HumanMaterial {
  const proposal = state.proposal;
  if (!proposal)
    return { context: state.goal, sections: [{ title: "尚无完整方案", markdown: state.goal }] };
  return {
    context: state.goal,
    summary: [
      `禁止：${proposal.prohibitions.join("；")}`,
      ...proposal.permissions
        .filter((p) => selectedIds.includes(p.id))
        .map((p) => `${p.action}；对象：${p.target}；风险：${p.risks}`),
      start ? "本次只确认首次启动，不扩大已有权限。" : "本次只确认范围，不会启动执行。",
    ],
    sections: [
      { title: "目标与方案", markdown: `${state.goal}\n\n${proposal.summary}` },
      ...proposal.permissions.map((permission) =>
        permissionMaterial(permission, selectedIds.includes(permission.id)),
      ),
      {
        title: "执行计划",
        markdown: proposal.steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
      },
      { title: "验收要求", markdown: materialList(proposal.acceptance) },
      { title: "禁止事项", markdown: materialList(proposal.prohibitions) },
      { title: "需要重新确认的变化", markdown: materialList(proposal.reconfirm) },
      {
        title: "本次操作的含义",
        markdown: start
          ? "本次仅确认首次启动，不扩大已有权限；回执、证据、预算和其他门槛仍有效。"
          : "本次仅保存权限决定，不会启动执行。启动仍需另一次独立确认；聊天文本不能批准。",
      },
    ],
  };
}

export function preflightDetailText(result: Partial<PreflightHumanResult>): string {
  const state = result.state;
  if (!state?.proposal) return "";
  let ids = result.confirmed?.permissionIds;
  if (!ids && state.version === 2) ids = state.permissionRequest?.permissionIds;
  ids ??= state.approval?.permissionIds ?? [];
  return `原请求全文（不代表当前授权）\n${readablePreflight(state, ids, false).body}`;
}

/** A read-only label, never a permission or execution qualification. */
export function preflightSummary(
  state: PreflightState,
  held?: "repair" | "fault",
): { label: string; next: string; color: ThemeColor } {
  if (held === "repair")
    return {
      label: "确认已保存，状态同步未完成；执行仍被阻止",
      next: "/task-supervisor repair-preflight（仅修复记录，其他门槛仍有效）",
      color: "warning",
    };
  if (held === "fault")
    return {
      label: "记录需要检查；执行仍被阻止",
      next: "/task-supervisor status（先检查记录，不要重复启动）",
      color: "error",
    };
  if (state.phase === "awaiting_authorization" && state.started)
    return {
      label: "等待权限确认；既有启动记录保留，未自动恢复或重启",
      next: "/task-supervisor approve",
      color: "warning",
    };
  const labels = {
    planning: ["只读规划中，尚未授权", "等待 Main 提交完整方案"],
    awaiting_authorization: ["等待权限确认，尚未启动", "/task-supervisor approve"],
    approved: ["权限已确认，尚未启动", "/task-supervisor start"],
    started: ["启动记录已保存；不代表任务完成", "/task-supervisor status（其他门槛仍有效）"],
    revoked: ["权限已撤销；不代表外部执行已停止", "/task-supervisor status（检查现有执行与权限）"],
    interrupted: ["执行前流程已中断，需要检查", "/task-supervisor status（不要重放已有执行）"],
  } as const;
  const [label, next] = labels[state.phase];
  return {
    label,
    next,
    color: state.phase === "revoked" || state.phase === "interrupted" ? "warning" : "muted",
  };
}
