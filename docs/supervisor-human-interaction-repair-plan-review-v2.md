# 二轮报告归档说明

2026-11-02 · 审阅对象：计划 v2；行号和结论对应当时版本，不是 v3 的复审结果。

- Reviewer run：`78cd6260-b890-4520-bb19-2f44db17111f`。
- 结论：首轮三项已在计划层闭合；旧 settled deferred 路径仍有 1 项 P1，完整实施设计基准 BLOCK。
- 主控处置见[计划 v3 第 11 节](supervisor-human-interaction-repair-plan.md#11-二轮审阅处置与当前设计阻塞)。

---

# Supervisor 人工交互修复计划 v2：定向只读复审

## Review

**结论：首轮恢复协议、具体定义审核、资源限制消歧三项已在计划层闭合；生命周期项修正了原 idle 冲突，但新选定路径仍有一项 P1 队列／取消契约缺口。**

已完整读取计划 v2 和首轮原始审阅，并核对指定源码及本地 Pi 1.1.0 实现。未修改文件、运行测试、安装、重载、操作业务或读取目标 session JSONL；不评价已有未提交实现的可合并性。

### Correct：首轮各项处置

| 首轮发现 | 本轮结论 | 计划及源码依据 |
|---|---|---|
| P1：before-settle 与实际 idle 冲突 | **原冲突已修正，生命周期整体尚未闭合** | v2 第 5.1 节明确移至正常 settled 后实际 idle，不在 before-settle 等待自身。宿主确实先清除活动标记再发 settled；`isIdle` 此时可以成立。仍有下述 deferred 队列缺口。 |
| P1：恢复确认与见证协议未区分 | **计划层已闭合** | 第 3.1、4.4 节明确恢复为命令等价控制，收窄 `NativeAnswer`／物理见证声明，不增加恢复 kind。可信私有 UI、单问题锁、owner/branch/hold/epoch 绑定、回答后复核、一次原控制及不重放均已规定。 |
| P1：准备后的具体定义审核遗漏 | **计划层已闭合** | 已进入第 2.1、4.1、4.3、5 节、冻结调用链、P2/P3 和验证矩阵；规定审核后保留批准、Start、hold、用量且零派发。 |
| P2：预算补充表述歧义 | **已闭合** | 第 2.2 节及资源验证项区分业务 `limits` 精确修订与 Supervisor 硬预算／已用计数，保留历史未知。 |

#### 生命周期中已经成立的部分

本地宿主路径为：

- `_emitAgentSettled()` 清除 `_isAgentRunActive` 后，才等待扩展 settled 处理器；
- `sendCustomMessage()` 在 settled 期间收到 `triggerTurn`，只登记 deferred action；
- 所有 settled 回调退出后，宿主才执行这些 action。

证据：`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:684–709、1053–1055、1793–1808`。

因此，**独立用户操作引起下一 run，不等于从 settled 返回自动 continuation**。本地文档的 notification-only 约束及事件类型没有提供 continuation 返回协议，但也不能据此否定上述公开发送行为（同包 `docs/extensions.md:64–67、93–98`；`dist/core/extensions/types.d.ts:776–780、1187`）。

按 v2 明确的调用顺序，未发现原来的自等待，也不能把宿主在回调退出后启动下一 run 指认为扩展处理器内递归。**问题在派发前后的竞争闭合，不在通知事件这个名称本身。**

#### 恢复协议与现有记录相容

原 resume 写入 `resume_user`／看板快照，recover 保存 Supervisor 恢复状态，均不要求原生批准回答参数（`src/commands.ts:147–206、486–494`；`src/supervisor.ts:845–900`）。原 reader 的 board 通道限定 `resolve_decision`，preflight 通道也仅接受既定 kind（`src/human-journal.ts:693–710`）。

v2 第 4.4 节避开了向这些记录强塞 `humanInteraction` 的冲突。需要后续冻结共享函数签名和锁的提取方式，但**未发现必须新增持久恢复批准协议的理由**。该项仍受下面同一派发竞争问题影响，不构成另一项协议发现。

#### 定义审核和 resource-scope 覆盖充分

- `approvalAction()` 在准备阶段指向 `review-contract`；原审核要求实际 idle，最终仅记录／绑定具体定义，不调用恢复或派发（`src/approval-bundle.ts:218–231`；`src/acceptance-runtime.ts:1054–1187`）。v2 已覆盖这些接缝和效果。
- 固定权限比较不包含 `limits`，但保留权限身份、prohibitions、preparation；合同固定对象另有检查（`src/scope-revision-proposal.ts:97–116`；`src/scope-revision-journal.ts:454–481`）。v2 的业务资源条件表述与此相容，也与 `src/acceptance-tool.ts:18–19`、`src/scope-guidance.ts:1–4` 一致，不意味着任意检查定义或技术上限都能修改。

### Finding：P1 — settled deferred 队列不可见且没有交付前复核，现有检查不足以兑现队列／取消承诺

**计划位置：**`docs/supervisor-human-interaction-repair-plan.md:162–175`，尤其第 5.1 节第 3、5–7 点及“唯一新 run”调用链；相关承诺还见第 4.4 节第 5–7 点、P2/P3 接受条件。

v2 要求等待人工回答期间出现排队消息、abort 或新请求时停止保存／派发，并复用 `continueNow()` 的 idle、pending 和其他资格检查。然而，本地 1.1.0 的 deferred actions **不属于这些检查能观察的消息队列**：

1. settled 期间的 `prompt()` 在入口直接加入 `_deferredSettledActions`，尚未处理输入或命令便返回。  
   证据：`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1517–1521`；公开 `sendUserMessage()` 最终进入该路径，见 `:1870–1875`。

2. `pendingMessageCount` 只计算 steering 和 follow-up；`ctx.hasPendingMessages()` 正是读取该计数。`isIdle` 也不检查 deferred actions。  
   证据：同文件 `:1053–1055、1892–1894、2754–2764`。扩展现有 `flowFacts()` 和 `continueNow()` 因而看不到这种 pending（`src/flow.ts:198–200`；`src/commands.ts:96–125`）。

3. Supervisor 的 settled 发送登记的是直接调用 `_runAgentPrompt(appMessage)` 的闭包。回调全部退出后，宿主顺序执行闭包，**不重新核对 owner、hold、epoch、队列或取消状态**。  
   证据：宿主文件 `:696–703、1803–1808`。`abort()` 和 `clearQueue()` 也不删除这批 action，且新 `_runAgentPrompt()` 会重置 run abort 标记，见 `:1379–1387、1881–1894、1909–1919`。

**由源码可推导的竞争序列，未实际运行：**

- Supervisor 在 settled 回调中等待人工确认；
- 同期经受支持的宿主发送路径提交另一条输入，它进入隐藏的 deferred 队列，idle/pending 检查仍可通过；
- 用户确认 Start／恢复，Supervisor 再登记一条 deferred action；
- 回调退出后，宿主先处理较早输入，再无条件执行旧 Supervisor action，即使较早输入已经改变 hold 或控制状态。

另一个窗口是 Supervisor 已登记派发、后续 settled 处理器仍在等待时发生取消／暂停。宿主按注册顺序等待处理器（`dist/core/extensions/runner.js:813–839`），所以派发前检查和实际 run 开始之间确实可以存在异步窗口；原检查不会在交付点再执行。

这不是断言当前目标会话已经发生该竞争，也不证明业务工具一定越过门禁；它证明了：**第 5.1 节所选路径不能仅靠“每次 await 后复核 + 原 continueNow + 宿主 deferred 分支”保证其承诺。**

**最小计划修订：**

- 明确承认本地 1.1.0 的 deferred pending／取消缺口，不能仅把它列为待测事项；
- 若继续冻结此路径，先规定实际可实现的公开 pending 可见性及交付前撤销／资格复核契约，不依赖私有队列；
- 若当前公开契约无法满足，应对该版本采用事件外显式入口兜底，收窄自动交接承诺，并复审修订后的路径。

不要求本轮修改宿主、实现或运行探针；这是需要先补齐的计划契约。

### 后续实施应验证，不作为本轮额外缺陷

- 真实运行版本、可信 TUI、settled UI 可用性及实际 idle 时点。
- 单问题锁、恢复意图不可伪造、陈旧 hold／跨分支失效、持久化失败及冷恢复不重放。
- preparation 无命令定义审核后保持 held、零派发；合法 resource-scope 修订与硬预算门保持分离。
- 上述 deferred 队列竞争修订后的隔离原生样本。

这些验证均未执行。静态源码证据不代表原生测试通过；未授权运行测试本身不是文档缺陷。未发现需要另列的可选改进项。

### Fixed

无；严格只读。

### Merge verdict

**BLOCK，仅针对将 v2 冻结为完整实施设计基准。** 不评价现有工作树实现，不构成实现就绪证明、发布或任何业务操作授权。

Plan verdict: BLOCK