# U：原生单列审核单与局部草稿

状态与文件归属见[施工索引](./README.md)。U 消费 S 的 C-VIEW／C-ACT 等实际接口；界面可以与 A／B／E 并行实现，但不自行决定权限、来源或控制协议。

## 结果

把完整决定、范围、风险、选择草稿和操作影响组织成默认单列审核单；窄屏可读、键盘可操作、详情可核对。提交前后状态明确，不让用户先理解 A／C 模式和多套功能键才能作决定。

U 交付呈现组件和局部草稿，不交付批准、首次启动、修复或结果通过。原生回应及见证生成仍由 I 接入的受信路径负责。

## 输入与输出

- 输入来自同版准确材料：目标／版本、决定、实际权限项、已有授权、验收定义及待冻结状态、限制／风险、合法动作与准确反馈。
- 输出为 `HumanMaterial`、组件和 S 冻结的局部草稿；现有 `DecisionDraft` 的字段不够时，先用 S 的实际扩展，不能自行塞 JSON 或伪造 `NativeAnswer`。
- 只读原型在 `~/.agent/diagrams/supervisor-review-ui-v1-prototype.html`，是视觉与交互参考，不是生产代码、完整审批包或已验证的真实 TUI。

## 现有接缝与写占用

本线独占 `src/human-presentation.ts`、`src/human-decision-card.ts`、`src/human-material-view.ts`、`src/human-scope-view.ts`。

主要 symbols：`preflightMaterial/readablePreflight/preflightNotice`、`HumanMaterial/MaterialReading`、`DecisionDraft/isDecisionDraft/DecisionCard` 及原文阅读器。以源码中真实导出为准，必要新增接口先在 K／S 明确。

`src/human-ui.ts`、`src/ui-environment.ts`、命令／事件及审批 journal 不归 U。若需调整审核占屏、transport 或完成握手，只给 I 明确 adapter 请求；不绕过既有完整核对门或改私有回应注册。

测试占用：`src/__tests__/human-decision-card.test.ts`、`human-scope-view.test.ts`、`board-human-presentation.test.ts`、`human-feedback.test.ts`。`human-ui.test.ts`、真实 CLI／PTY 和共享 fixtures 归 I。

## 呈现与交互要求

1. 主视图先说明需要决定什么、当前事实／未知、选项差异、准确范围、限制和风险；完整关键内容在确认前可阅读，不藏进只看得到 raw JSON 的附录。
2. 已有授权只展示不重复申请；必需、可选、未授权及待冻结事项分开。复选只是草稿，拒绝／延期／撤销的含义不能混用。
3. 本次确认是否仅保存、是否仍需 Start、接下来由谁操作必须清楚；保存异常不能显示普通成功，也不让用户重批已有完整事实。
4. 摘要、格式化材料与规范化来源一致；重要空白、控制／双向字符、路径及关键数值保留安全表达。漂亮排版不能改变授权值。
5. 显示和局部选择不创建权威；复制 draft、过期 question、改变分支或取消均不能变成正式回应。
6. 使用现有 TUI 的宽字符、主题、布局与输入能力；不引入第二渲染器。具体审核区域／overlay 适配由 I 根据支持的宿主能力处理。
7. 所有操作有键盘路径；默认焦点不造成意外批准。调整窗口和浏览详情不扩大权限、丢弃选择或错误继承未完整核对的标记。

## 最小验证

先用同一份长材料验证正确字段、草稿选择、完整阅读和清晰反馈，再覆盖中文／长路径、窄宽窗口、主题、取消、过期、必需项未齐及投影待修复。不要只用短示例截图证明可用。

本线运行上述本地 Vitest 文件和无副作用的组件检查。若获准做隔离 TUI 小样本，可记录键盘／布局证据；它不等于实际原生批准或人类可用性接受，真实控制全链仍归 I／V。

## 交接 I

交付组件入口、C-VIEW／C-ACT 消费版本、实际字段覆盖表、草稿返回值、adapter 与审核区域需求、实际检查及未验证范围。I 把这些组件接入同一可信材料与原生确认，不把原型演示状态接成业务状态。
