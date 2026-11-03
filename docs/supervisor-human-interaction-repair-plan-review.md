# Supervisor 人工交互修复计划：首轮独立审阅

2026-11-02 · 审阅对象：计划 v1（尚未应用 v2 修订时）。下文保留原始意见，行号对应 v1，不应被当作 v2 的复审结论。

- Reviewer run：`f1ca6696-54fd-44ac-963e-c188b95803b5`。
- 结论：3 项 P1、1 项 P2；完整实施设计基准 BLOCK。
- 后续处置：[当前计划第 10 节](supervisor-human-interaction-repair-plan.md#10-首轮审阅处置)。主控核实及文档修订不替代独立复审。

---

## Review

**结论：暂不能作为完整实施设计基准。** 可保留为 P0 调查及诊断修复的范围基线，但自动交接的生命周期路径、恢复确认的记录契约，以及既有定义审核的覆盖范围仍需先修订。发现 **3 项 P1、1 项 P2**；未确认严重性 P0 缺陷。

本报告是**只读文档审阅，不是实现、测试通过或发布验收**。已完整读取目标计划，并核对当前工作树源码、相关测试及仓库内 Pi 1.1.0 契约；没有运行测试、启动业务、读取目标业务 session JSONL 或修改文件。

### Correct：已有设计正确的部分

- **没有把自动入口误诊为完全不存在。** 计划第 28–32 行的分级符合源码：`submitAndPresentPreflight()` 在新提交后进入权限呈现，重复修订不重问；`executeWorkflowGate()` 仅对非替代的新决策自动呈现（`src/preflight-human.ts:661–683`；`src/tools.ts:1043–1047`）。
- **没有凭 `deferred` 推断用户取消。** `requestNativeAnswer()` 有多个提前返回分支，`invokeUI()` 也会吞掉异常并返回 `undefined`（`src/human-ui.ts:186–211、712–735`）。计划第 30–32、102–108 行正确区分了诊断缺口与尚未证实的渲染根因。
- **授权与执行隔离方向正确。** 计划第 61–75、90–96 行保留批准、Start、scope 审核、采用和恢复的不同效果，与现有原生身份校验、物理见证及 scope commit 后仍 held 的实现相符（`src/human-ui.ts:889–955`；`src/scope-revision.ts:526–605`）。
- **快捷键 runtime 缺口识别准确。** 现有 `scopedAPI()` 只包装事件、工具和命令，没有包装快捷键；本地 Pi 的快捷键处理器确实只收到 `ExtensionContext`（`src/runtime.ts:115–146`；`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1208–1212`）。计划没有错误复用命令上下文。
- 去重、稍后后显式重开、冷启动仅恢复入口、不建第二份批准库，以及只读视图不承担授权的约束合理。现有单问题锁和只读视图关闭握手可复用（`src/human-ui.ts:209–245`；`src/ui-view-lifecycle.ts:69–80`）。

### Finding：P1 — 所指定的自动检查点与保留的实际 idle 门不相容

**计划位置：**第 73、87、90、129、136–141、164–172 行。

计划要求：

1. 保留原操作准入；
2. 在检查点完成独立 Start／完整 scope 审核；
3. `agent_settled` 只观察通知，不从这里批准或派发；
4. 不自等待、不使用计时器或隐藏模型轮次。

但当前仓库宿主已经能静态确认：

- Pi 1.1.0 的 `isIdle` 要求没有活动 agent run；`agent_before_settle` 在 `_emitAgentSettled()` 清除活动标记**之前**执行（`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:684–690、1053–1055、1391–1412`）。
- Start 不仅有命令外层等待，还在核心及下层绑定中检查 idle（`src/preflight-human.ts:116–119、770–781`；`src/preflight.ts:242–246、1058–1068、1085–1093`）。
- scope 的 review 模式同样要求实际 idle；proposal 模式才允许当前 Main 元数据轮次（`src/acceptance-runtime.ts:682–719`）。
- `continueNow()` 也会在非 idle 时返回，不能原样搬到 before-settle 完成首次派发（`src/commands.ts:96–112`）。

**影响：**仅“拆掉命令专属等待”不能得到计划承诺的调用链。在现有约束下，before-settle 会被正确门禁拒绝；在那里等待 idle 又会等待自身结束。scope 自动审核也有同一问题。

**最小修订：**把这一点从“可能缺少路径”改为已确认的当前版本约束。冻结具体的呈现、保存、执行时点及调用符号，明确如何保持真实静止检查；若需宿主支持或改变现有检查语义，应先形成窄设计并复审，不能让实施者自行选取绕过方式。

**可验证接受条件：**在真实 CLI 中记录工具、before-settle、settled 的 idle 状态；不强转上下文、不伪造 idle、不自等待，仍能完成独立 Start 和新 scope 审核。取消／排队消息时零派发，正常确认时仅一次派发。这里要求的是后续设计与验证，不要求本轮未授权运行探针。

### Finding：P1 — 恢复确认缺少与现有持久化协议相容的明确契约

**计划位置：**第 63、92–93、115、164–166 行。

第 63 行要求“所有实际回应”都走 `NativeAnswer`、原始绑定、物理回读和见证；恢复则只规定复用原 resume/recover。

**源码证据：**

- 当前 resume 保存 `resume_user` 和快照；recover 保存恢复后的 Supervisor 状态，没有原生回答／见证参数（`src/commands.ts:147–196、486–494`；`src/supervisor.ts:845–900`）。
- 现有通用回读 reader 的 board 原生控制限定为 `resolve_decision`，preflight 控制也只有既定 kind；不能直接把带 `humanInteraction` 的恢复记录塞入原格式（`src/human-journal.ts:693–710`）。
- `publishReadbackControl()` 会向这两类既定控制通道写入，不是任意恢复确认的发布器（`src/human-control.ts:109–138`）。

**影响：**实施者必须自行决定：恢复只是命令等价的显式控制，还是新增需要持久见证的人工控制。前者与“所有回应必须物理见证”不符；后者涉及尚未设计的记录、reader 和兼容边界。

**最小修订：**明确二选一的契约：若恢复是命令等价控制，应收窄第 63 行的适用范围，并规定可信原生来源、当前 owner/hold 绑定和执行前复核；若恢复也必须持久见证，则先设计最小记录及读取兼容方案。两者均不得形成第二授权库或重新授予业务权限。

**可验证接受条件：**伪造／复制回答、陈旧 hold、跨分支和取消均不能恢复；成功确认只发生一次原控制效果；冷恢复不重放确认。持久化检查须与最终选定契约一致。

### Finding：P1 — 已有“获准准备后的具体定义审核”没有进入动作清单

**计划位置：**第 9、51、88、113、125–132、170–172 行。

计划明确排除了人工检查见证、最终验证登记等动作，但**没有排除契约定义审核，也没有为它安排自动／待办入口**。源码接缝表只列出 preflight、board 和 scope 审核。

这不是未来扩展场景：

- 当前审批动作在准备后明确转向 `review-contract`（`src/approval-bundle.ts:218–231`）。
- `reviewAcceptanceContract()` 是独立的原生定义审核，要求实际 idle，绑定具体定义，但不解除暂停或派发（`src/acceptance-runtime.ts:1054–1138`）。
- 现有真实 CLI 准备流程也必须输入该命令才能完成定义审核（`test/goal-native-smoke.py:352–374`）。

**影响：**按当前列出的实现接缝完成后，已有 preparation 流程仍可能停在命令专属人工门，无法兑现“首次完整流程不需要输入审批命令”的接受条件。

**最小修订：**将该现有动作加入矩阵、待办来源、共享操作接缝和验收；明确只绑定定义、不自动恢复。若本轮确实不支持，则像其他非目标一样显式排除，并收窄“完整流程”声明，不能留给实施者解释。

**可验证接受条件：**在 `approval-preparation` 路径中，不键入 `review-contract` 也能到达完整定义审核；稍后／拒绝不重问；审核后原批准、Start、hold 和用量保持不变。

### Finding：P2 — “预算补充”表述需要与已有 resource-scope 能力消歧

**计划位置：**第 48 行。

“不新增……预算补充”没有区分 Supervisor 硬预算与可经范围审核修订的业务资源条件。当前源码明确允许后者提出精确修订，同时禁止硬限制／已用计数扩充或重置（`src/acceptance-tool.ts:18–19`；`src/scope-guidance.ts:1–4`）。相关 resource-scope 计划也专门区分这两者（`docs/supervisor-resource-scope-admission-repair-plan.md:42–61`）。

**影响：**可能重新引入此前已修正的“所有额度都不可修订”指引。此处是文档歧义，尚不能据此断言会改变代码门禁。

**最小修订：**明确“不新增独立补预算入口，不扩大／重置 Supervisor 硬预算和已用计数；既有业务资源条件精确修订能力保持不变”，并补充对 resource-scope 设计的引用。

**可验证接受条件：**同一固定权限对象内的合法 limits／检查定义修订仍可呈现、审核；硬预算耗尽仍不能恢复，历史未知不变成零。

### 仍需实施阶段 P0 调查，不算已确认缺陷

- 目标会话实际加载版本、前端及历史 `deferred` 的退出原因仍未知。本次没有打开业务 JSONL，不能独立认证该历史观察。
- 本地 Pi 1.1.0 证据只证明当前仓库宿主契约，不证明目标会话运行该版本。
- 原生取消、异常和布局问题仍需隔离探针；没有未授权实测**本身不构成本次阻断理由**。

### Fixed

无；严格只读。

### Merge verdict

**BLOCK：仅针对将本文冻结为完整实施设计基准。** 先解决上述 P1 契约问题；不据此评价现有未提交代码的可合并性，也不扩大任何实施、安装或业务操作授权。

Plan verdict: BLOCK