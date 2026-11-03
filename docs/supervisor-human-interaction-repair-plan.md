# Supervisor 人工阻塞自动交互修复计划

2026-11-02 · v3 · 2026-11-03 收束：**A、冻结 H0 R2、B R3 均获独立实现接受与 Main 复核。本轮完整本地候选交付完成：3493 项完整检查、11 项原生矩阵及最后 17 项定向复核 PASS。全部 P1 CLOSED；[最终逐项审计与边界](supervisor-human-interaction-b-validation.md#9-main-最终逐项审计与本轮完成边界)。未安装、未重载或操作业务会话。**

首轮发现 3 项 P1、1 项 P2；二轮确认恢复控制、具体定义审核和资源限制表述已在计划层闭合，但指出新生命周期路径仍有 P1 隐藏队列/取消缺口。本版撤回旧宿主 settled 回调中的新回应/派发方案，分开兼容交付 A 与完整目标 B。第三轮确认条件化路线图可交付、无新增实质问题；不代表 H0 已具备或 B 可实施。原始意见见[首轮](supervisor-human-interaction-repair-plan-review.md)、[二轮](supervisor-human-interaction-repair-plan-review-v2.md)及[最终报告](supervisor-human-interaction-repair-plan-review-v3.md)。

## 1. 结果、授权与基线

### 1.1 目标

需要用户决定时，Supervisor 直接展示完整材料和可操作的原生交互；用户不必记住或输入 `approve`、`decide`、`start` 等命令。旧命令保留为兼容、重新打开及诊断入口。

必须同时做到：

- 自动呈现问题不等于自动批准、自动启动或自动恢复。
- 用户选择“稍后”后不反复弹窗，但能通过待处理快捷入口回来继续。
- 审批、业务选择、信息补充、首次启动、准备后的具体定义审核、范围审核、恢复各自保留不同效果，不合并成一个“继续”按钮。
- UI 未展示、用户退出、上下文失效、环境不支持、界面异常能区分；不能统一暗示用户主动选择了“稍后”。

这是完整目标 B。当前仓库宿主只能先交付 A 的诊断和只读待办；A 不等于“无需审批命令”的目标已完成。B 必须先满足第 5.2 节 H0 的公开宿主能力和验证门，不能把不支持自动控制的旧版本默认为支持。

### 1.2 授权沿革与当前执行门

文档阶段的用户请求为“形成文档，用 subagent 审阅”，当时仅允许文档及只读审阅。随后当前 Goal「按照计划推进至完成」要求执行路线图，现已开始本仓库 A 的本地实现及隔离验证；其约束见[A 实施 packet](supervisor-human-interaction-a-implementation-packet.md)。

计划和审阅本身从不产生批准。当前 Goal 不替代本计划保留的独立门：宿主跨仓库变更须明确对应源码/范围并取得确认；提交/推送、安装/发布、当前或业务会话重载，以及研究业务的批准/首次 Start/恢复均未获本轮授权。用户随后已明确允许隔离宿主源码副本及修改/构建/验证范围；Main 已锁定官方 v1.4.0 副本，先做 H0 设计复审。该确认不覆盖安装、发布、会话重载或业务控制，也不替代能力证据。

### 1.3 基线与事实分级

- 仓库：`/home/ygguo/agent-projs/agent-ext/pi-task-supervisor`。
- 制定计划时 HEAD：`118229f64e02be364836aa394042db169dac6e0e`；工作树含此前大量未提交改动，**HEAD 不代表本计划审阅的全部源码**。
- 当前源码有自动交互：`submitAndPresentPreflight()` 在首次保存完整提案后调用权限呈现；`executeWorkflowGate()` 在首次创建决策时调用 `answerBoardDecision()`。重复提交及替代决策不是同一个入口条件。
- `startGoal()`、`startApprovedPreflight()`、`reviewAcceptanceContract()`、`reviewScopeRevision()` 等仍由专用命令进入，不仅外层依赖 `ExtensionCommandContext.waitForIdle()`，部分下层还要求实际 idle。
- 仓库内 Pi 1.1.0 的 `agent_before_settle` 仍在活动 run 内，`ctx.isIdle()` 为 false；`agent_settled` 发出前才清除活动标记。公开发送会在 settled 期间登记 deferred action，但 `isIdle`/`hasPendingMessages` 看不到这批 pending，旧 `abort`/`clearQueue` 不清除它们，交付时也不重新验证来源/hold/取消资格。因此，真实 idle 加旧 `continueNow` 并不足以保证此处的安全交接。该缺口由本地源码确认，不证明目标会话使用此版本或已经发生该竞争。
- `requestNativeAnswer()` 返回 `undefined` 的原因很多；`invokeUI()` 捕获异常后也返回 `undefined`。上层可将这些结果统一呈现为 `deferred`，这是已确认的诊断信息缺口，不是已确认的终端渲染根因。
- 目标会话 `01a17fe4-d0bc-74fc-b71d-f17a0c27cf26` 的已观察记录：2026-11-02 09:16（UTC+8）提案结果 `deferred`、阶段 `awaiting_authorization`、无已保存人工回应。记录不能证明弹窗是否展示，也不能证明用户取消。
- 目标会话实际加载版本、当前前端及弹窗退出原因尚未建立证据；不得用磁盘 HEAD 或当前源码代替运行版本证明。

实施前重新保存工作树摘要、受影响源码哈希、Pi/扩展版本和最小探针结果。保护现有改动，不自动 stash、reset、清理、提交或覆盖。

## 2. 范围与非目标

### 2.1 两个交付范围，不能互相冒充完成

**兼容交付 A（当前宿主可单独规划实施）：**

1. 现有可信本机 TUI 工具内自动交互的诊断，保持原权限/决策控制规则。
2. 正常 settled 的只读通知，以及从原状态派生的只读待处理快捷面板；该面板不产生批准、Start、恢复、scope 采用或 Main 派发。
3. 原命令兼容和真实限制说明。新面板在不支持 H0 的宿主上只显示现有显式入口，不伪装成已支持无命令控制。

**完整目标 B（严格依赖 H0，不允许在旧 1.1 宿主降级实现）：**

1. 权限批准后，独立首次启动确认的自动呈现和安全唯一派发。
2. 准备后的具体定义审核、完整范围提案审核的自动呈现及无命令重新打开。
3. 原业务选择/信息回应的安全交接，以及明确可恢复状态下的独立恢复控制。
4. 可执行的待处理快捷入口、完整取消/队列可见性、交付前复核和不重放。

H0 是宿主公开契约的设计、实现和验证前置项，并非本仓库内删掉等待或添加 timer 就能代替。路线图本身不授权修改/升级宿主；随后用户已另行允许隔离宿主源码/修改/构建/验证，不覆盖安装或重载。实现 A 可以独立验收，但不能记作 B 或整体问题完成。

### 2.2 不隐含扩入

- 不新增自动审批、自动恢复、独立补预算入口、外部执行重放或自动接受结果；不扩大/重置 Supervisor 硬限制和已用计数。既有固定权限对象内的业务资源条件 `limits` 及对应受支持检查定义仍可经精确范围审核修订，历史计量未知不变成零。详见[资源范围修订计划](supervisor-resource-scope-admission-repair-plan.md)。
- 不重写 Supervisor，不引入通用动作注册器、第二个调度器或新工作流框架；不增加第三方依赖。
- 不因普通工具被门禁拒绝就制造批准请求；由原控制模块给出真实动作资格。
- `repair-*`、撤销、结束管理、最终验证登记/重试及人工检查见证，本轮保留原显式入口，不自动执行。待处理视图可说明其原因及现有入口，不把它们包装成普通批准。
- `/task-supervisor tasks`、`status`、`history` 继续只读；不让查看历史触发审核、恢复或 Main。
- 不在本计划中降低 `isTrustedLocalTui()` 的条件。RPC/移动端需要独立可信交互传输契约；Pi 支持 RPC 对话传输不等于当前扩展已允许其产生授权，`custom()` 也不具有 RPC 对等能力。

P0 若发现目标会话实际为当前不支持的前端，应记录该缺口并形成独立对接子项；A 的本机 TUI 诊断可以继续，但不能宣称目标客户端问题已解决。实际版本是否支持 B 由 H0 能力和原生验证决定，不按版本号大小推定。

## 3. 不变式与失败优先级

### 3.1 不变式

- 规划 ≠ 权限批准 ≠ 首次 Start；范围审核 ≠ scope 采用 ≠ 恢复；恢复 ≠ 重新执行；操作记录 ≠ 业务验收。
- 原 Goal/owner/Session/branch、权限对象、材料版本、首次 Start、任务、收据和已用预算全部保留。撤销不回退到旧授权。
- 聊天文本、模型参数、复制 DTO、待处理卡片、快捷键选择不直接成为批准。权限/Start、既有 board 选择或信息回应、契约定义和 scope 审核仍必须走对应的现有不透明 `NativeAnswer`、原始呈现绑定、物理记录回读及见证校验。
- resume/recover 是命令等价的显式状态控制，不是新业务授权，也不伪装成上述批准记录。UI 恢复采用第 4.4 节的可信交互、当前 hold 绑定与一次性原控制效果，不新增 `humanInteraction` 记录 kind 或另一份授权库。
- 同一 Session 同时最多一个原生问题；复用已有 `activeQuestions`、取消机制和只读视图协调，不另造并发问题队列。
- 用户拒绝后不催问同一请求；取消/稍后不保存最终答案，不启动、不恢复。
- 请求/材料失效后旧回应无效；切会话、换分支、压缩、暂停、停止、撤销、重载时按现有规则失效和取消。
- 人工等待不使用 Advisor 的短超时；超时、断连、异常不能映射成批准，也不能误记为用户拒绝。
- 未闭合/未知外部执行、未知宿主捕获和不明派发结果不得重试为普通业务执行。
- UI 展示不扫描市场数据、不运行检查、不修改业务材料；展示失败不能破坏已保存的控制事实。

### 3.2 两类资格，不能共用一个“可继续”布尔值

**呈现/回应资格：**请求来源和当前 owner 明确、材料完整且对应、原生 UI 可信、无问题冲突，并满足该类元数据操作原有的准入条件。失败时只展示诊断或等待，不保存新授权。

**执行/恢复资格：**在上述来源检查之外，还必须满足当前模式、原权限和首次启动、独立看板门、scope 采用、宿主静止、执行结算、证据能力及预算等原有检查。审核可以成功而执行继续被阻止。

具体失败次序沿用原控制模块，不从 reason 文本猜动作，不因新增按钮先显示就跳过底层检查。已确认回应但派生元数据未完成时，优先显示“原记录待修复”，不再收取同一批准。

## 4. 交互契约

### 4.1 完整目标 B 的行为矩阵

除保留的原工具内首次呈现外，下面新增的审核/Start/恢复控制均以 H0 已成立为前提。旧 1.1 的 settled 回调只发通知；新快捷面板也只读。它们不会执行下面的 B 控制，也不会以兼容兜底冒充完整完成。

| 当前事实 | 自动呈现/用户操作 | 保存后的效果与剩余门 |
| --- | --- | --- |
| 新完整提案可审核 | 自动展示全部范围、必需/可选权限、风险和禁止项 | 只保存本次权限；不启动 |
| 必需权限不全 | 显示缺项；用户可从待处理入口重新选择 | 不自动循环弹窗，不进入 Start |
| 权限齐全、定义有效、从未 Start | H0 在所有 settled 回调退出、完整队列可见且获得有效 idle action 后，展示独立“首次启动”确认 | 只有明确确认、原 Start 检查全通过且宿主交付前复核通过才唯一首次派发 |
| 定义变化、材料/能力缺失 | 展示对应问题及负责者，不显示虚假的可启动操作 | 补材料/定义审核不自动获得业务权限或启动 |
| 已获准准备，当前具体定义完整且可审核 | H0 的事件外有效 idle action 自动打开原 `review-contract` 对应的完整审核；稍后可从待办重开 | 仅绑定当前具体定义；保留原业务批准、Start、hold 和用量，不编译、不恢复、不排队 |
| 新的结构化业务选择/信息请求 | 自动展示精确选项或输入格式 | 只解决该信息门，不扩权；其余门通过才继续 |
| 新范围提案完整、原 Goal held 且可审核 | H0 的事件外有效 idle action 展示原/新材料和变化，用户选择审核结果 | 原 Start/权限/用量不变，继续保持 held；不采用 scope、不排队业务 |
| scope 已提交但未采用或看板另有门 | 展示仍需的独立操作 | 用户单独确认对应 resume/recover；绝不一次点击隐式连做 |
| 普通人工暂停，原条件仍成立 | 提供独立恢复确认，说明实际恢复对象 | 复用原 resume 资格；不重置预算、不重启外部 writer |
| stronger hold/fault | 先展示原原因与当前恢复资格；资格不明时仅诊断 | 明确确认仍须通过原 recover 检查；不能声明故障已消除 |
| 未知执行/未知派发/日志证明缺失 | 展示已知事实和所需检查 | 不提供可生效的 Start/replay/强制恢复 |
| 用户稍后、取消或拒绝 | 关闭交互，保留待办/拒绝结果说明 | 不新增权限、不派发；同一请求不自动重问 |
| 冷启动/重载后有历史待办 | 恢复当前分支待办入口 | 不自动重开历史弹窗、不重放回应或恢复业务 |

“自动展示”只适用于本轮运行新产生且可审核的请求，不包含用户已退出/拒绝的同一请求、没有明确新审核意图的替代请求或历史恢复记录。材料变更不能靠更换请求 ID 无限重问。

### 4.2 交互结果与诊断

保留现有上层 `approved/rejected/deferred/unsupported/...` 兼容含义；以可选诊断字段细分，不把诊断升级成授权协议。

最低需要区分：未展示（原因明确）、用户明确稍后、UI 取消但具体原因不明、宿主取消、请求/材料失效、环境不支持、UI 异常，以及已保存但投影待修复。只有真的观察到用户选择，才显示“你选择了稍后”。

诊断至少有发生阶段和稳定原因码；当前请求标识仅用于定位。错误文本脱敏且有界，不复制批准全文、输入答案或凭据。诊断不能改变不透明答案注册表；不能接受调用方制造的 `NativeAnswer`。

默认不新增持久化诊断日志。原工具结果保留必要诊断；命令/快捷入口使用运行时诊断和可见回执。历史没有诊断时显示未知，不回填推测。

### 4.3 待处理入口与去重

- 状态区提示“待你处理”和原因；注册一个可配置、避开已有绑定的快捷入口。A 只打开只读待办面板；B 获得 H0 当前可取消的 idle action 后，才可进入原控制界面。
- 待办从当前原始请求、批准/Start、决策、`approvalAction()` 指向的具体定义提案、scope 和 hold 事实派生；不建立第二份批准数据库。定义未准备齐全时是 Main 的材料任务，不制造可批准请求。
- 短生命周期去重绑定原 owner、Session、branch、请求/材料标识和运行时 epoch；不按自然语言相似度匹配，不依赖轮询。
- 快捷入口每次读取新状态；A 不调用任何写入/执行控制。B 除重新核对材料，还必须向 H0 获取当前有效的 idle action；不能仅凭 `ctx.isIdle()` 或“这次来自快捷键”认定已在全部 settled 回调之外。
- 忙碌、有任一宿主待交付输入（包括 deferred）、正处于另一确认或 H0 资格未知时，说明等待条件，不抢焦点、不 abort Main 来打开问题。静态文本、旧卡片和历史材料不是操作凭证。
- 选择稍后/Esc 后同一请求不自动再弹；需要用户通过快捷入口或原命令显式打开。冷启动只恢复入口，不自动弹旧请求。

### 4.4 B 的恢复控制契约：命令等价，不新增批准协议

本版选择命令等价控制，**不新增恢复原生见证格式**。恢复 UI 的作用相当于用户明确执行现有 resume 或 recover，不授予原权限之外的任何权利。该新增 UI 控制也需要 H0；旧 1.1 的新快捷面板不执行恢复，不因来源是快捷键就免除隐藏队列问题。

1. 只允许可信本机 TUI 内、由当前 scoped runtime 发起的私有交互。恢复不注册为模型工具，不接受 `confirmed: true`、复制回答或其他序列化确认参数。
2. 复用单问题锁及取消/只读视图协调；锁可在同一模块内提取最小共享实现，但不另造持久问题队列。恢复确认调用与原生批准互斥。
3. 打开前捕获 Session/manager、原 owner、分支锚点、runtime/human epoch、原 board/Supervisor hold 来源和待采用 scope 引用；显示究竟恢复看板、联合普通暂停，还是尝试 Supervisor recover。
4. 由私有函数直接调用原生选择界面；只有观察到对应明确选项才继续。回答不作为可保存、可转交或可重放的授权 DTO。取消、稍后、宿主 abort、界面异常均不执行控制。
5. 回答后，在 H0 有效 action 和完整队列/取消资格内重新核对上述来源及全部原控制资格；hold/材料/分支有变则失效。调用原 resume 或 recover 核心一次，不能以“之前已经确认”跳过新的检查。一次操作只完成一种原控制；看板恢复和 recover 不隐式连做。
6. 持久化保持原 `resume_user`/看板快照、Supervisor 恢复快照和已有故障处理，不给这些记录追加不受现有 reader 支持的 `humanInteraction`。写入/派发结果不明仍 held，冷启动不重放用户意图。
7. 派发仍经过原 `continueNow()` 等效的完整资格，并由 H0 在实际启动前再次复核或撤销；不能使用旧 settled deferred 发送代替此交付检查。恢复看板但 Supervisor 仍 held 时不派发。新按钮不声称一切故障已消除。

旧命令仍以用户显式命令作为控制意图，行为不变；它们和 UI 共享控制核心，而不是命令路径偷偷再执行一轮 UI。

## 5. 源码接缝与调度设计

以现有控制函数为唯一行为来源，仅提取必要共享函数，不把自然语言命令解释成动作。

| 位置/符号 | 拟修改责任 | 不得发生 |
| --- | --- | --- |
| `human-ui.ts / requestNativeAnswer, invokeUI` | 原生交互结果诊断、单问题与失效传播 | 吞掉异常后假称用户稍后；放宽答案来源 |
| `preflight-human.ts / submitAndPresentPreflight, approvePreflight, startApprovedPreflight` | 保留首次自动呈现；拆开命令等待适配与共享审核/Start 核心 | 复用批准执行 Start；同提案重提交触发重问 |
| `board-human.ts / answerBoardDecision`、`tools.ts / executeWorkflowGate` | 决策诊断与首次交互衔接 | 替代/拒绝决策自动绕过原规则 |
| `commands.ts / startGoal, resolveDecision, approveCommand, resume, supervisorCommand` | B：命令等待适配与共用控制核心分离；保留 `continueNow` 的原资格，再经 H0 交付前复核 | 解析命令字符串、模拟输入、用旧 idle/pending 假称完整队列已空 |
| `acceptance-runtime.ts / reviewAcceptanceContract`、`approval-bundle.ts / approvalAction` | 将命令等待与已有具体定义审核核心分开；待办保留准备/定义阶段 | 定义审核解除 hold、重复业务批准或首次 Start |
| `scope-revision.ts / reviewScopeRevision` 及范围提案工具 | 将命令专属等待与原生审核核心分开，仅在实际 idle 且完整可审时呈现 | review/repair 隐式采用 scope 或恢复业务 |
| `events.ts / makeController, registerWorkHandlers` | A：保留原业务门，settled 仅通知；B：仅向合格 H0 提交事件外可取消交互请求 | settled 回调保存新回应或排队业务、读取私有队列、假造 idle、自等待 |
| `runtime.ts / scopedAPI` | 新快捷回调也进入对应 `AsyncLocalStorage` runtime，保留单写者 | 快捷回调落入全局/test runtime 或另一 Session |
| `flow.ts`、`human-presentation.ts`、现有 UI 投影 | 共享已有动作/阻塞语义，呈现待办、原因、实际效果 | 根据错误字符串发明权限或第二套 Next |

### 5.1 当前版本决策：不使用旧 settled deferred 路径执行新控制

**v3 撤回 v2 的 settled 内审核/Start/恢复派发方案。** 已确认本地 1.1.0 有两个不同问题：before-settle 并非 idle；settled 内虽可显示 idle，但 deferred prompt/命令/触发 run 对原 pending 检查不可见，而且交付闭包不重新核对取消或来源。

以下约束已冻结，不交给实现者自行放宽：

1. 原工具内首次权限/board 决策呈现保持既有规则；本轮不因此重写整个宿主的历史消息行为。兼容交付 A 只补诊断和只读待办，不能宣称已解决旧宿主所有全局队列竞争。
2. before-settle 仍只执行既有业务继续逻辑，不承接要求实际 idle 的新控制，不等待自身、不加隐藏模型轮次。
3. settled 先完成原对账/异常暂停；A 只发只读通知，**不保存新人工回应、不直接派发、不调用旧公开发送来登记新 deferred run**。
4. 新快捷入口在 A 也只读；来源是快捷键不等于已离开其他扩展的 settled 回调。没有 H0 的完整队列/交付资格，不能仅靠 `ctx.isIdle()`、`hasPendingMessages()`、一个本地 busy 标记或额外复核就启用 B。
5. 原命令保留原行为及其真实宿主限制；A 只是提供现有入口，不将它们认证为已修复所有 hidden-deferred 竞争。不能模拟命令输入来掩盖 B 尚未实现。
6. 不读/改 `_deferredSettledActions`，不依赖注册顺序或“我是最后一个回调”，不加 timer/microtask 猜测事件已退出，不轮询 idle，不强转 `ExtensionCommandContext`。

### 5.2 H0：完整目标 B 的宿主公开契约前置门（当前安装缺失，隔离候选已接受）

当前已安装宿主仍不具备 H0。用户已允许隔离源码/修改/构建/验证，[H0 packet](supervisor-human-interaction-h0-implementation-packet.md)已获独立设计 READY，隔离候选已完成[验证、独立实现接受及 Main 复核](supervisor-human-interaction-h0-validation.md)；不能在本扩展内私造第二宿主队列，B 精确控制接入已按独立 READY packet 实现并获最终独立 OK 和 Main 同指纹接受。最低契约如下：

1. **事件外 idle action。** 通过公开接口申请一次、有限的交互动作；仅在所有 settled 回调真正退出，且当前 run/compaction/retry/其他控制和相关队列均已满足资格后交付回调。请求本身不启动模型、不产生批准。宿主必须可证明处于哪一阶段，而不是让扩展猜。
2. **完整 pending 可见性及归属。** 覆盖 deferred prompt/命令/run、steering、follow-up 和其他会在本动作前执行的输入；公开资格能区分本动作自身与竞争输入。当前 `pendingMessageCount` 不符合此要求。既有任一更早输入未闭合时不能呈现新控制；等待 UI 时出现竞争输入应使本动作失效或取消。
3. **一次性身份和可撤销交付。** 公开 handle 绑定请求、Session/owner/branch、控制/材料代际；支持取消、停止、会话替换和过期。批准界面和恢复界面共用原单问题约束。取消不仅关 UI，还必须撤销尚未交付的相应启动意图；不能把旧 deferred action 留到之后无条件启动。
4. **保存前及实际交付前复核。** UI 回答后执行原控制资格/见证；实际开始下一 run 前，宿主再次调用绑定本动作的资格验证，并以代际/取消令牌保证验证与启动交付之间不会被其他输入插入后继续用旧结论。异步校验期间有新状态须失效并重查；不能只复用 UI 回答时的检查。
5. **明确结果和不重放。** 接受交付请求不等于已启动。提供与该一次性请求相关联的拒绝/取消/已启动或结果未知信息，能够定位实际 run；重复提交不能启动两次。结果未知沿用 hold/检查原执行规则，不盲重试；进程重启不重放 UI 意图。
6. **原业务控制保持独立。** 不新增业务批准含义，不代替原 Start/权限/定义/scope 物理见证，不刷新预算。Start 已合法保存但后续交付取消时保留该事实，明确“已确认未派发/派发待核”，不重新收取 Start，不自动补派或当成未启动。恢复状态已写入但派发失败时同样保留原事实并按原故障规则处理。

H0 接口名称/签名在对应宿主 packet 中冻结后，本扩展才能实现适配。**现有公开 `pi.sendMessage` 和旧 isIdle/pending 检查不足以当作 H0 实现。** 没有合格公开接口或实测失败的版本仅支持 A，不允许悄悄提高最低版本、安装新宿主或放宽准入。

### 5.3 H0 成立后的 B 调用链

- 权限：`原工具内 permission 呈现/见证 → 只读通知/合格 H0 请求 → 所有 settled 回调退出且完整队列就绪 → 一次性 idle action → 独立 Start 呈现及原检查/见证 → 原 continueNow 等效资格 → H0 可撤销交付前复核 → 唯一新 run`。
- 定义：`获准准备/具体提案 → H0 事件外 idle action → reviewAcceptanceContract 共享审核核心 → 原定义记录/见证 → 保持 hold，零派发`。
- 范围：`held 元数据提案 → H0 事件外 idle action → reviewScopeRevision 共享审核核心 → 原 scope 记录/见证 → 保持 held，零采用/派发`。
- 重新处理：`scoped 快捷入口 → H0 有效 idle action → 当前待办/对应独立控制 → 只在原控制允许且 H0 交付复核通过时唯一派发`。

人工等待不使用 Advisor 的短超时。工具、快捷键和生命周期回调不强转命令上下文、不自等待；旧命令的 `waitForIdle()` 留在适配层。整个 action 的取消/代际失效必须贯穿 UI、保存前检查和实际启动交付，而不止“每次 await 后检查一次”。

## 6. 实施阶段与接受条件

以下保留接受契约和依赖顺序。当前 P0/A 本地实现、自测及修复后独立实现审阅已完成，A 本地候选已接受；H0 隔离候选已完成独立接受，B R3 已完成本地验证、最终独立 OK 与 Main 同指纹接受，P0–P4 本轮候选交付门均满足。逐项证据见[A 验证记录](supervisor-human-interaction-a-validation.md)、[H0 验证记录](supervisor-human-interaction-h0-validation.md)及第 13 节，不能把 A 当作整体完成。

### P0：建立根因证据与行为契约

- 确认真实版本/前端；保留隔离工作树基线和目标历史只读证据。
- 最小原生探针通过首次提交的真实调用链验证展示、回应、取消和输出。先单个样本、单一配置，不启动业务、不读取市场源。
- 对历史 `deferred` 无法证明的原因标未知；若不能复现同一根因，列出已确认诊断缺陷与尚未确认的展示缺陷，不能冒称根因已修复。
- 记录 tool/before-settle/settled 的实际 idle、现有 hidden-deferred 可见性和取消限制；该已确认源码缺口不能只标成“待测”。P0 不通过 UI 在原业务会话提交真实控制。
- A 的符号约束可单独冻结。B 先核对实际公开能力是否满足第 5.2 节；当前本地 1.1 不满足，直接标 H0 BLOCKED。不得因新版本号更大或一次正常样本通过而推定合格。

**接受：**首次交互路径与结果有可追溯证据；用户症状断言或对应诊断断言稳定失败；隔离夹具自身错误不算产品 RED。

### P1：兼容交付 A——诊断与只读待办

改共享原生交互诊断和上层显示，保留旧状态码及答案注册验证。覆盖退出、stale、异常、unsupported 和物理记录/投影失败；旧历史不迁移成已知原因。加入 scoped 的只读待办快捷面板和限制说明，不在 settled 或新快捷回调保存回应/Start/恢复或派发。

**接受：**真实取消与 UI 故障可区分；历史缺失仍未知；旧控制行为不变；新通知/面板零授权、零派发。可交付 A，但整体无命令自动交互仍未完成。

### H0：宿主契约设计与资格（B 的独立阻塞前置）

宿主来源和独立范围授权已确认，接口/取消/交付语义已获设计复审 READY，隔离候选现已完成本地验证、独立实现 OK 及 Main 复核接受。原范围不覆盖安装、发布、会话重载或业务控制；本计划和 A 的授权也不能替代这些独立门。

**接受：**有合格公开接口、精确版本/源码与真实隔离测试证据；完整 deferred 可见、竞争输入/取消可撤销、交付点重新资格验证、重复请求唯一 run、未知不重放。仅通过普通场景、静态分支或单测不解除此门。当前状态：**隔离 H0 已接受；已安装能力仍缺失，B 已在隔离配对中验证并完成最终独立接受；部署仍是后续独立授权门。**

### P2：B 的共享控制与运行时资格（依赖 H0）

在 H0 设计与资格成立后冻结并提取权限/Start、具体定义、scope 及恢复共用核心，保留下层真实 idle/原控制检查及完整交付资格。补齐 `scopedAPI` 绑定。恢复采用第 4.4 节命令等价控制，不新增批准 kind。

**接受：**无合格 H0 时 B 控制不可执行；新回调在自己的 runtime，伪造/陈旧/跨分支/取消均无效果；原控制只发生一次。已确认但交付取消/未知时不重复保存或重放。

### P3：自动交接与快捷入口

在 H0 和 P2 均通过后按第 5.3 节接通首次提交/决策、准备后具体定义、范围审核和独立 Start，启用可执行待办及单请求防重问。命令/UI 共享原语义；定义/范围审核、验证登记和元数据修复均不派发。未具备 H0 的版本继续只有 A，不能以按钮换命令后宣称全链路完成。

**接受：**支持范围内首次完整流程不需要输入审批命令；`approval-preparation` 路径无需键入 `review-contract` 就能审核具体定义，且审核后原批准、Start、hold 和用量不变。Start 与恢复各自独立明确确认；同一事件不会多问、多写批准或多次派发，冷恢复只恢复待办。

### P4：组合回归、文档与候选交付

按第 7 节完成小样、原生、竞争和失败矩阵，再运行完整检查。更新 README 和操作说明，明确支持前端、版本、交互失败原因、快捷入口和命令兜底。独立审阅后逐项核实意见，保存候选验证记录。

**接受：**有实测证据的场景才记 PASS；缺失版本、前端或原生验证明确为 GAP。代码通过不等于已安装或目标会话已修复。

依赖：`P0 → P1(A)`；`P0 → H0 → P2(B) → P3(B)`；组合 P4 依赖 A、H0 和 B 的接受。A 可独立交付诊断，H0 未完成不阻止 A，但整体目标和 B 均保持未完成。同一工作树只保留一个实现写者；审阅者只读。

## 7. 验证矩阵与执行顺序

| 类别 | 必测场景 | 核心断言 |
| --- | --- | --- |
| 正常 | 首次提案、业务选择、信息输入、首次 Start | 不输入专用命令；完整材料；权限/Start 分离；唯一派发 |
| 审批/定义 | 必需权限不全、可选权限未选、定义变化/缺失、approval-preparation 完整定义审核 | 不误报权限齐全；缺材料不 Start；定义审核无需命令但不重新批准/Start，不解除 hold或派发 |
| 生命周期/H0 | tool/before-settle/settled 与事件外 action 时点；更早 deferred 输入、UI 中竞争输入、后续 settled 回调等待时取消/暂停 | 旧宿主 B 不可执行；合格 H0 完整可见/可撤销，交付前重查；无陈旧 run、无自等待、重复请求零重复派发 |
| A 限制 | Pi1.1正常settled通知、只读快捷面板、无H0/未知能力 | 新入口零回应写入/Start/恢复/派发；不把快捷来源当作事件外证明，不声称整体目标完成 |
| 资源 | 固定权限内合法 limits/检查定义精确修订、硬预算耗尽、历史计量未知 | 保留合法 resource-scope 审核能力；硬预算不补充/重置，未知不当零 |
| 退出 | 稍后、Esc、宿主 abort、UI 抛错、unsupported | 原因准确或明确未知；无授权/启动/恢复；不重复催问 |
| 并发 | 重复事件、连续提案、已有问题、已有队列消息 | 单问题、不抢焦点、不多派发；新材料不复用旧回答 |
| 失效 | 切 Session、换分支、压缩、暂停、停止、撤销、重载 | 回答失效；runtime 不串用；取消后无后续业务派发 |
| 恢复 | 普通人工暂停、legacy pause、stronger hold、scope 待采用、完成态 | 保留原 resume/recover 区分；完成业务不重开；不重置用量 |
| 外部执行 | writer 在跑、结算未知、捕获未知、Start 派发结果未知 | 不重放、不强制 release、不把结果未知解释为未执行 |
| 持久化 | 批准/定义/信息回应写入失败、见证缺失、已确认但投影失败；恢复原记录失败 | 原授权见证不伪造或重取；恢复仅保存原控制记录、不新增 humanInteraction kind；失败仍 held且不重放 |
| 历史 | 同请求重提交、被拒绝请求、替代请求、冷启动、旧 deferred | 不自动重问；保留未知；无隐式迁移、重放、启动 |
| 显示 | 窄终端、中文、resize、只读视图切换、快捷键冲突 | 材料可读、焦点正确、可退出；tasks/status/history 始终只读 |
| 兼容 | 现有命令、工具结果消费者、支持版本/前端 | 旧状态兼容；不支持环境失败关闭，不放宽可信 UI 条件 |

验证顺序：

1. 从现有 `human-ui`、`preflight-human`、`preflight-human-boundaries`、`board-human`、`ui-coordination` 等测试中选单个回归；先证明夹具与失败路径正确。
2. 扩展上述测试以及 `events`、`canonical-commands`、`flow-commands`、`approval-workflow`、`scope-revision`、`restore-ui-invalidation` 的有关断言。若新增操作核心有真实共享行为，再增加对应测试，不复制另一套宿主。
3. A 先跑一个现有原生工具内交互及只读面板小样。B 的无命令用例须先满足 H0：使用公开发送路径构造更早 deferred 输入，并让后续 settled 回调等待时注入取消/暂停，证明旧路径不能冒充合格交付、合格接口零陈旧 run。再复用 `test/goal-native-smoke.py`、`test/approval-native-responses.ts` 验证 preparation 等完整路径。每配置先单样本再组合，记录版本、原生来源未 mock、按键、动作身份和物理 session 证据。
4. 原生故障注入与竞争样本通过后运行 `npm run check`，保存失败或不支持项；不以 mock UI 通过代替原生验证。
5. 由独立只读审阅者检查 diff 与证据，主控复核相关最小验证后才接受候选实现。

文档阶段只检查引用、源码锚点、范围、Markdown 和审阅结果，不运行上述实现验收，不写“测试通过”或“原会话已修复”。

## 8. 交付与后续批准门

原文档交付及三轮审阅已完成；当前新增 A 本地候选、自测记录及修复后独立实现接受。审阅意见是证据，不是授权。H0 的隔离宿主来源、范围授权及构建基线现已建立，现已完成隔离 H0 的设计、实现、资格和独立接受；B 控制接入及无命令矩阵证据已收集，最终独立 OK 后 Main 已接受同指纹 R3；不能以用户批准替代实现/证据，也不能默认为存在的安装或隐式升级。

后续候选交付必须包含：实际修改范围、版本/工作树基线、逐项验证证据、未验证项、诊断/兼容影响及安装前状态。若需要增加持久化协议、扩大可信前端或改变原授权/恢复语义，应先修订设计，不随小修混入。

安装、重载、在原业务会话中使用，以及批准/首次启动/恢复均仍为独立操作。不得为了验证 UI 在原会话提交真实批准，也不通过安装或重载来反推旧会话加载过什么版本。

## 9. 代码与文档依据

- `src/human-ui.ts`：`isTrustedLocalTui`、`requestNativeAnswer`、`performNativeInteraction`、`invokeUI`。
- `src/preflight-human.ts`：`permission`、`submitAndPresentPreflight`、`approvePreflight`、`startApprovedPreflight`。
- `src/board-human.ts`：`answerBoardDecision`；`src/tools.ts`：`executeWorkflowGate`。
- `src/commands.ts`：`startGoal`、`resolveDecision`、`approveCommand`、`scopeRevisionCommand`。
- `src/scope-revision.ts`：`reviewScopeRevision`；`src/runtime.ts`：`scopedAPI`。
- `src/acceptance-runtime.ts`：`reviewAcceptanceContract`、`heldScopeOwner`；`src/approval-bundle.ts`：`approvalAction`；`src/scope-guidance.ts`：资源条件与硬限制的区别。
- 仓库内 Pi 1.1.0 `dist/core/agent-session.js`：`isIdle`、`_runAgentPrompt`、`_emitAgentSettled`、公开发送实现 `sendCustomMessage`；内部符号仅作为宿主行为证据，不允许扩展直接调用。
- `src/events.ts`：`boundaryAllowed`、`makeController`、`registerWorkHandlers`；`src/flow.ts`：既有下一动作推导。
- `src/board-ui.ts`、`src/ui-view-lifecycle.ts`：只读视图、控件暂停和 UI 生命周期协调。
- `README.md`：Native human responses、Authorization preflight、Same-Goal scope amendments。
- Pi 本地文档：`docs/extensions.md` 的生命周期/命令上下文、`docs/tui.md` 的 UI/焦点、`docs/rpc-extension-ui.md` 的能力限制。宿主文档位于已安装 Pi 包，必须和实际受测版本核对，不假定最新文档描述的能力全部存在于旧运行时。
- 相关既有计划：[操作指引一致性](supervisor-guidance-consistency-repair-plan.md)、[恢复与模式](supervisor-recovery-and-mode-repair-plan.md)、[资源范围修订](supervisor-resource-scope-admission-repair-plan.md)。本计划新增交互入口，但不推翻它们保留的权限/恢复/不重放约束。

## 10. 首轮审阅处置

| 发现 | 主控核实 | v2 处置 | 仍需验证 |
| --- | --- | --- | --- |
| P1：before-settle 与实际 idle 门冲突 | 确认；不是只移除 waitForIdle 就能解决 | v2 的时点修正获复审认可，但派发契约仍不够；v3撤回旧settled执行路径，引入第5.2节H0硬前置 | H0当前缺失；A可独立交付，B不能实施/宣称完成 |
| P1：恢复确认与现有见证协议未区分 | 确认；原 reader 不支持任意恢复 humanInteraction | 第 3.1、4.4 节选定命令等价控制，不新增持久批准格式；可信来源、原 hold绑定及原控制检查必须一致 | 单问题锁、伪造/陈旧/跨分支负例及原恢复记录验证 |
| P1：准备后的具体定义审核遗漏 | 确认；现有 approval-preparation 依赖 review-contract | 加入范围、矩阵、待办、源码接缝、P2/P3 和验证；仅定义绑定、不恢复/派发 | 原生 preparation 路径无需输入命令，原权限/Start/hold/用量不变 |
| P2：预算补充表述有歧义 | 确认；已有 resource-scope能力不能被新指引抹掉 | 第 2.2 节区别硬预算/已用量与既有业务资源条件修订，并加入资源回归 | 合法精确修订可审，硬预算不变、历史未知不清零 |

这里的“处置”只表示文档已修改，不表示复审通过、实现完成或测试通过。

## 11. 二轮审阅处置与当前设计阻塞

二轮原始结论见[复审报告](supervisor-human-interaction-repair-plan-review-v2.md)：首轮恢复协议、具体定义审核、资源限制歧义均在计划层闭合；生命周期原 idle 冲突已修正，但 v2 的旧 settled deferred 派发仍有 P1 隐藏队列/取消缺口。

主控核实并接受此发现：本地宿主的 `prompt`/`sendCustomMessage` 在 settled 时加入 deferred actions；`pendingMessageCount`/`hasPendingMessages` 和 `isIdle` 不覆盖它们；旧 abort/clearQueue 不撤销该闭包，最后也不运行扩展原资格检查。它不是仅靠更多“await后复核”可消除的未知风险。

v3 因此不再把该路径冻结为可实现的安全自动交接，而是：

- A 仅诊断/只读待办，保留原功能及限制，不新增事件内授权/派发。
- B 及可执行快捷入口硬依赖 H0；没有公开完整 pending、可撤销交付和最终资格复核即不可执行。
- H0 所需接口、对应宿主源码/载体和实施授权尚未建立，不能写成已存在能力；它是后续设计/实现前置任务，不把缺口交给用户重复批准。
- 原“完整流程无需命令”仍是 B/整体接受条件，不降格为 A 的完成声明。

最后定向复审已确认这次范围收窄与硬前置门在计划层封住了已确认矛盾；该结果不当作 H0 实现、原生验证或整体实施就绪证明。

## 12. 最终文档交付状态

- 三轮 reviewer 只读审阅已完成；最终结论 **OK with notes，仅针对条件化路线图交付**，无新增实质问题。原始报告均已归档，未将早期 BLOCK 改写为通过。
- 当前完整 B 实施仍 **BLOCKED**：H0 公开接口、对应宿主设计复审和原生竞争/取消/交付资格证据尚未具备。A 可作为独立后续本地候选范围，但本轮没有实现授权。
- 主控已逐项核实审阅依据并做文档引用、源码锚点和 Markdown 结构检查。未运行实现/原生验收，不声称代码、宿主能力或业务会话已修复。
- 文档交付后的执行状态见第 13 节；上面的“本轮没有实现授权”描述文档交付当时，不覆盖随后明确要求执行计划的当前 Goal。H0、安装和业务控制的独立门仍保留。

## 13. 当前 Goal 执行状态

- A：本地实现和修订后 `npm run check` 已通过（144 文件/3401 测试；全局覆盖率四项通过原 90% 门），Pi 1.1/1.4 的原生只读/诊断样本及正常 settled 通知已重验。首轮实现审阅的通知去重 P2 已先 RED 后修复；定向复审为 A OK，主控再跑相关 18 项并核对源指纹后接受 A 本地候选。该结论不解除 H0/B 或整体 Goal 门。
- 实施范围、RED/GREEN、失败处置和原生工件见[A 实施约束](supervisor-human-interaction-a-implementation-packet.md)与[A 验证记录](supervisor-human-interaction-a-validation.md)。既有未提交 guidance/resource-scope 等实现被保留，没有清理或提交。
- H0/B：用户已允许跨仓库隔离源码/本地修改/构建/验证；官方 v1.4.0（4a08025）副本与已安装 source map 精确匹配，离线构建基线及7项并发测试小样通过。[H0 packet](supervisor-human-interaction-h0-implementation-packet.md)首轮三项 P1 已获[独立 v2 设计复审](supervisor-human-interaction-h0-design-review-v2.md)CLOSED / READY，[原始 BLOCK](supervisor-human-interaction-h0-design-review.md)保留。[首轮独立实现审阅](supervisor-human-interaction-h0-implementation-review.md)为 BLOCK，四项 P1 已核实、修正并先 RED 后 GREEN；R2 的 49 项 H0 专项、20 文件/308 项相关回归、根检查、离线构建及 bundled/unbundled CLI 原生组合验证通过，[证据及缺口](supervisor-human-interaction-h0-validation.md)已更新。[R2 复审](supervisor-human-interaction-h0-implementation-review-followup.md)确认全部 CLOSED / OK，Main 重核相同指纹及 16 项相关测试后接受隔离 H0。[B 实施约束 v1](supervisor-human-interaction-b-implementation-packet.md)已获[独立 READY](supervisor-human-interaction-b-design-review.md)，Main 按原授权单写实现；[B 验证](supervisor-human-interaction-b-validation.md)记录完整检查、隔离配对的无命令原生矩阵及中间失败。[B 首轮实现审阅](supervisor-human-interaction-b-implementation-review.md)三项 P1 已修复，R2 复审闭合两项后，R3 又修正当前契约 owner 选择；3493 项测试及 11 项原生矩阵通过，[最终独立实现 OK](supervisor-human-interaction-b-implementation-review-final.md)后 Main 核对同指纹、再跑 17 项关键回归并完成逐项审计，接受完整本地候选交付。不把该结果当作安装或业务会话已修复。
- 整体 Goal 保持未完成；未安装、未发布、未重载，也未批准/启动/恢复原研究会话。
