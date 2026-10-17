import { beforeEach, expect, it } from "vitest";
import { createSubmitPreflightTool, createWorkflowGateTool } from "../tools";
import { createEmptyBoard } from "../engine";
import { resetState } from "../state";
import { createMockAPI, createMockTheme } from "./helpers/mocks";

beforeEach(() => {
  resetState();
});

it("renders the workflow gate without leaking machine JSON or changing its original carrier", () => {
  const tool = createWorkflowGateTool(createMockAPI().api);
  const result = {
    content: [
      {
        type: "text" as const,
        text: 'Workflow gate applied: wait_for_decision; human result: {"status":"answered","confirmed":{"value":"42"}}. A native approval is not task acceptance.',
      },
    ],
    details: { snapshot: { ...createEmptyBoard(), workflowStatus: "active" as const } },
  };
  const before = structuredClone(result);
  const rendered = (tool as any).renderResult(
    result,
    { expanded: false, isPartial: false },
    createMockTheme(),
    { isError: false },
  );
  expect(rendered.render(120).join("\n")).not.toContain('{"status"');
  expect(rendered.render(120).join("\n")).toContain("门槛");
  expect(rendered.render(120).join("\n")).toContain("详情：/task-supervisor tasks → 确认与回应");
  expect(result).toEqual(before);
});

it.each([
  ["approved", "权限已确认"],
  ["partial", "必需权限尚未齐全"],
  ["rejected", "未获允许"],
  ["deferred", "本次未提交确认"],
  ["unsupported", "当前环境无法提交确认"],
  ["started", "启动确认已保存"],
  ["already_saved", "没有重复确认或启动"],
])(
  "renders a human-readable %s result without changing its machine payload",
  (status, expected) => {
    const tool = createSubmitPreflightTool(createMockAPI().api);
    const result = {
      content: [{ type: "text", text: JSON.stringify({ status, marker: "machine-only" }) }],
      details: { status, state: { phase: "approved" } },
    };
    const before = structuredClone(result);
    const output = (tool as any).renderResult(
      result,
      { expanded: false, isPartial: false },
      createMockTheme(),
    );
    expect(output.render(120).join("\n")).toContain(expected);
    expect(output.render(120).join("\n")).toContain("详情：/task-supervisor tasks → 确认与回应");
    expect(output.render(120).join("\n")).not.toContain("machine-only");
    expect(result).toEqual(before);
  },
);

it.each(["approved", "partial", "rejected"])(
  "does not say an already-started plan never started on %s",
  (status) => {
    const tool = createSubmitPreflightTool(createMockAPI().api);
    const details = {
      status,
      state: { phase: "started", started: { goal: "existing", startedAt: "now" } },
    };
    const output = (tool as any).renderResult(
      { content: [], details },
      { expanded: false, isPartial: false },
      createMockTheme(),
    );
    const text = output.render(120).join("\n");
    expect(text).toContain("既有启动记录保留，未自动恢复或重启");
    expect(text).not.toContain("尚未启动");
  },
);

it.each([
  [{ projectionPending: true }, "无需重复批准"],
  [{ projectionPending: true, startupPending: "startup" }, "不要重复启动"],
])("prioritizes the saved-but-held state over success wording: %j", (held, expected) => {
  const tool = createSubmitPreflightTool(createMockAPI().api);
  const output = (tool as any).renderResult(
    { content: [], details: { status: "approved", ...held } },
    { expanded: false, isPartial: false },
    createMockTheme(),
  );
  expect(output.render(120).join("\n")).toContain(expected);
  expect(output.render(120).join("\n")).toContain("[warning]");
});

it("keeps the complete original scope readable in expanded preflight results without treating it as a grant", () => {
  const tool = createSubmitPreflightTool(createMockAPI().api);
  const proposal = {
    summary: "界面方案",
    steps: ["检查现有布局"],
    acceptance: ["所有门槛保留"],
    prohibitions: ["不得发布"],
    reconfirm: ["新增路径需要再确认"],
    permissions: [
      {
        id: "P1",
        required: true,
        action: "修改界面",
        target: "当前仓库",
        environment: "本机",
        limits: "不改协议",
        risks: "文案回归",
        fallback: "保留原界面",
        reconfirm: "范围变化",
      },
    ],
  };
  const result = {
    content: [{ type: "text", text: '{"machine":"unchanged"}' }],
    details: {
      status: "rejected",
      state: {
        version: 2,
        phase: "awaiting_authorization",
        goal: "易读且安全",
        proposal,
        permissionRequest: { id: "request", permissionIds: ["P1"] },
      },
    },
  };
  const before = structuredClone(result);
  const output = (tool as any).renderResult(
    result,
    { expanded: true, isPartial: false },
    createMockTheme(),
  );
  const text = output.render(200).join("\n");
  expect(text).toContain("原请求全文（不代表当前授权）");
  expect(text).toContain("详情：/task-supervisor tasks → 确认与回应");
  for (const value of [
    "修改界面",
    "当前仓库",
    "不改协议",
    "文案回归",
    "保留原界面",
    "范围变化",
    "不得发布",
    "新增路径需要再确认",
    "所有门槛保留",
  ])
    expect(text).toContain(value);
  expect(text).not.toContain('{"machine"');
  expect(result).toEqual(before);
});

it.each([false, true])(
  "keeps unknown workflow result metadata neutral instead of claiming a saved response (error=%s)",
  (isError) => {
    const tool = createWorkflowGateTool(createMockAPI().api);
    const output = (tool as any).renderResult(
      { content: [], details: undefined },
      { expanded: false, isPartial: true },
      createMockTheme(),
      { isError },
    );
    const text = output.render(120).join("\n");
    expect(text).not.toContain("已保存");
    expect(text).not.toContain("门槛已更新");
    expect(text).toContain(isError ? "结果需要检查" : "等待任务门槛结果");
  },
);

it("keeps a partial preflight render neutral when no result details have arrived", () => {
  const tool = createSubmitPreflightTool(createMockAPI().api);
  const output = (tool as any).renderResult(
    { content: [], details: undefined },
    { expanded: false, isPartial: true },
    createMockTheme(),
  );
  expect(output.render(120).join("\n")).toContain("正在等待方案确认结果");
});
