# Supervisor 修改文档：总则与实施索引

> 方案方向已获用户认可；本次授权是**形成修改文档，不是开始实现**。
>
> 基线：`ef47ec5299e321676ad6f38db8b3f02e9401f43c`。文档采用 Full packet，覆盖身份、授权、持久化、兼容与失败优先级。生产源码、协议及配置尚未修改；Supervisor 保持用户停止后的状态。
>
> **文档状态：已形成。实现状态：NOT_STARTED。整体实施就绪判定：NOT_READY_FOR_ALL_NODES。** 尚有 E-EXEC、E-CODEMODE 资格证据需按下文核实；P0 和独立记账的准备不需要等待全部高级集成。此判定不把未来测试未执行一概算成架构阻塞，也不等于需要再次批准已认可的方案方向。

## 1. 文档分工与权威

| 标识 | 依据                                                                 | 用途                                         |
| ---- | -------------------------------------------------------------------- | -------------------------------------------- |
| C1   | 用户“针对这些问题，给出解决方案”及随后认可方案、要求形成修改文档     | 确定本轮只交付设计/修改文档                  |
| R1   | [问题总账](supervisor-known-issues.md)                               | 问题 ID、当前修复状态的唯一入口              |
| R2   | [已认可方案](supervisor-remediation-proposal.md)                     | 设计目标、取舍与推荐默认值                   |
| R3   | [隔离复核及证据](reviews/supervisor-followup-ef47ec5.md)             | 四项缺陷、策略与嵌套事件的实测依据           |
| R4   | [生命周期观察](reviews/supervisor-lifecycle-observations-ef47ec5.md) | L-01–L-04 的源码依据及验证限制               |
| S1   | `CONTEXT.md`、`README.md`、现有 owner/控制/回执实现                  | 不改变授权、停止、归档、证据等领域事实的含义 |
| S2   | ef47ec5 已验收源码与历史验收记录                                     | 保留 H-01–H-09 已修复性质和原覆盖率门        |

修改文档分为三卷，字段/行为的具体合同以所属分卷为准，不在问题总账维护第二份实施进度：

1. [P1/P2：外部执行结算与 Advisor 记账](supervisor-changes/01-execution-accounting.md)
2. [P3/P4：最终审查、审查视图与管理生命周期](supervisor-changes/02-review-lifecycle.md)
3. [P5/P6/P7：推进、Code Mode 与验收契约](supervisor-changes/03-progress-codemode-acceptance.md)

## 2. 所有权与执行范围

- 本次 writer：主控，仅修改文档；不建立执行任务板，不重新启用 Supervisor，不派发实现子代理。
- 将来获准实现时，在独立 worktree 开发；共享文件保持一名 writer，主控集成并承担最终接受。
- 不修改现有 main 的未跟踪 `.pi/` 和日志修复方案；不读取真实/归档会话作迁移样本。
- 本文不会创建真实 journal fence、模式记录或执行器请求。提交、合并、推送、安装和重载不在本次授权内。
- 已修复历史不重做；未知结果、真实权限、暂停和显式拒绝不因“继续到完成”而放开。

## 3. 最小共同合同 P0

本节冻结跨卷必须使用的概念及责任，避免后续 writer 自选身份或新鲜度语义。具体 TypeBox schema 和字节测试在对应节点开始前固化，不要求先实现一个无业务用途的通用框架。

### 3.1 身份

- `GoalOwnerKey`：`sessionId + goalKey + goalRunId/null + lifecycleCommitId/null`。
- scoped 目标的 goalKey 使用真实 goalRunId。legacy ledger 使用已恢复的 ledger goalId；纯 v1 使用经验证的原 Supervisor anchor entry ID 与 sessionId，不使用目标文字推断身份。
- `BoardOwnerKey`：sessionId、宿主生成的 boardRunId、建立该看板归属的 mode/seed entry ID。用于 tasks 模式，不伪造 GoalRun 或监督验收。
- `WorkOwnerKey` 是带 kind 的 goal/board 联合：goal 分支携带 GoalOwnerKey，board 分支携带 BoardOwnerKey。外部执行/调用树可归属工作，Advisor 与目标接受只归属 goal。P1 的新记录按此联合编码。
- `OperationLease` 为进程内事实：runtime/manager 对象身份、sessionFile 身份、GoalOwnerKey、goalEpoch、mutationEpoch、当前 branch leaf、任务审查摘要；不把对象身份序列化后假称重启仍有效。
- `goalEpoch` 用于目标/规划回调失效；`mutationEpoch` 是回执账本的变更屏障。二者不得混用或同时任意归零。
- 所有外部 Run、Advisor call、容器 root/parent、延迟完成意图都绑定发起时的 owner。模型输入中的 ID、正文中的“已批准”及路径不是身份来源。

### 3.2 产物与证据版本

新增 `artifact-version.ts`，对可信定义的 `ArtifactScope` 生成 `ArtifactVersionV1`：

- scopeId / scopeDigest；workspace 身份；相关输入和产物的路径/内容摘要；声明的非秘密环境及检查配置摘要。
- versionId 使用单独带版本前缀的、字段顺序固定的 tuple 摘要；不得修改现有 receipt/journal/control digest 的 preimage。
- 文件清单排序、相对路径规则、缺失与符号链接处理在 P0 字节测试中冻结。越界、读取失败或关键依赖未覆盖返回 `unknown`，不能以空树代替。
- Git commit 只是一部分：脏工作树、必要未跟踪输入和配置也必须覆盖。不要把整个环境/凭据打包或上传，环境仅取明确非秘密 allowlist。
- `verifyArtifactVersion()` 返回 `same | changed | unknown`。只有 same 才能支持保留适用性；文件 hash 不证明任意远端/OS 副作用没有发生。

P3 可先消费最小受管输入范围；P7 再将范围与正式检查定义关联。未达到可靠版本能力时，继续使用保守的新鲜验证，不先放松 mutationEpoch。

### 3.3 持久化与新记录

继续使用现有 session journal；不新增数据库。新增小型 `control-journal.ts`，统一处理以下宿主控制事实：

- `ExecutionBinding / ExecutionSettlement / ExecutionResolution`；
- `AdvisorCallStarted / AdvisorCallObserved / FinalReviewAttempt`；
- `SessionModeChanged / CompletionIntent / EligibilityAttested`。

记录携带 version、kind、recordId、owner、previous/因果引用、必要摘要。实现前冻结每种记录的确切 schema、大小上限和摘要 tuple，不允许任意 JSON 控制 payload。

`appendControlFact(pi, ctx, fact, lease)` 的职责：检查身份与允许的追加位置 → 同步追加 → 对所选实际分支作新鲜确认 → 返回 `{ entryId, digest, leafAfter }`。调用者只在确认后发布新状态。若写入结果不确定，保留现场并 journalFault/cancel；不声称 fsync、数据库事务或 OS 原子提交。

该入口不替代原生人工 control/witness 校验，也不把普通任务提交全部改成额外物理扫描。稳定无写恢复复用已验证 reader；live 授权、执行结算和必要写后确认仍新鲜核验。

### 3.4 格式栅栏

采用**新增明确版本栅栏 + 新控制事实**，不直接扩展旧 wire5 的 phase 枚举并假定旧读者会安全理解。

拟定 `ControlFormatFenceV1`：

```text
customType = continuous-tasks:supervisor
version = 6
protocol = task-supervisor-control-v1
kind = format-fence
sessionId, revision, previousFence/null, features[], owner/null
```

- `features` 只接受本实现已知的能力标识，按字典序去重编码；初始标识为 execution-settlement-v1、advisor-accounting-v1、final-review-v1、management-mode-v1、progress-facts-v1、invocation-tree-v1、completion-intents-v1、acceptance-contract-v1。revision 从 1 单调递增，previousFence 引用同分支真实 entry ID/digest。首个新语义事实前必须确认该栅栏，失败则不继续。
- 新读者为 fence 增加独立解析/fold，不把它当成 Supervisor 状态、业务授权或新的 GoalRun。
- 当前 wire1/2/3/5、carrier3、原生 frame/control/witness 的原始记录和摘要保留；不通过批量重写旧日志“升级”。
- 控制事实使用独立 `continuous-tasks:control-facts` customType 和 version1 的严格 kind 联合；不冒充 receipt、权限或原生人工回应。
- `human-journal.ts` 必须保留小型 fence/控制事实供严格读取；`goal-journal.ts`、`supervisor.ts` 与恢复编排共同验证 fence、owner 和因果引用。不能只让其中一个消费者跳过 version6。
- 已确认原调用的迟到用量仅允许追加原 owner 的观测账目，不作为关闭 owner 的业务修改；其余业务事实须验证当前工作归属。恢复按 kind 分派，不能因允许补账就允许旧目标重新执行。
- ef47ec5 的 `decodeSupervisorEntry()` 对未知 version6 有拒绝路径，但这只是源码依据。P0 必须以原始冻结读者实际验证完整 session_start 的安全拒绝，不能只测一个 decoder。
- 若资格测试证明 version6 在任一所需回滚读者中被静默忽略，则本编号布局不可写入；修订兼容合同后再继续，而不是删除负向用例。
- 新会话默认 off 不需要为了加载而写 fence。明确选择新功能或新模式时才写；读旧历史不自动迁移、派发或重放。

## 4. 核对过的宿主事实与剩余资格

### 已有静态证据

- 当前 SDK 1.1.0 的 `ExtensionToolContext.executeTool()` 文档规定嵌套 ID 为 `<calling id>/<n>`，tool_call、tool_result、tool_execution 事件带 `parentToolCallId`，父结果有有界 nestedCalls。**P6 应消费已有事件字段，不把“新增宿主父子字段”当作默认前置。**
- SDK Codemode 文档说明：QuickJS 无直接 Node/fs/network；但 store 会持久化 codemode-store，image/models 还可能产生文件或用量。不能仅凭有工具调用树就证明容器完全无直接效果。
- 本机 pi-subagents 的 RPC ping 声明 asyncStatusSnapshot 和 processTerminalProof，status 的 targeted/rich 路径走执行器。文档明确 stop 返回 stopping 不是终止证明；process proof 的 observed 与业务成功、不可恢复停止是不同维度。
- 这些都是本机源码/文档证据，不是当前运行实例已实际声明并交付该能力的证明；不写死安装路径或从裸路径读取未知执行器 artifacts。

### 尚需执行的资格检查

| ID         | 缺口                                                                                        | 核查方式与不满足时行为                                                                                         | 只阻塞什么                                                           |
| ---------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| E-WIRE     | 新 fence 与旧读者的完整恢复拒绝尚未动态验证                                                 | 自有小型 fixture，经冻结旧读者 session_start 验证；若被忽略则禁止写该格式                                      | 任何依赖新持久语义的生产写入；P0 的 RED 检查本身可先做               |
| E-EXEC     | 直接 Run、workflow/子树的 targeted status 及进程证明组合尚未用实际 adapter fixture 资格验证 | 先 1 个自有短运行，不启动业务；核对身份、运行代次、writer 范围与 proof；无法证明则保留 unknown，不解除验收屏障 | P1 相应执行器形态及依赖其静止结论的退管路径，不拖住 P2 设计/测试准备 |
| E-CODEMODE | 真实 root/parent 事件顺序、非工具效果及 only 模式的静止完成尚未端到端资格验证               | SDK/faux-provider + 真实 Codemode 工具，记录可信树；不明效果保持保守资格，不能标记所有脚本只读                 | P6 完整 only 模式接受，不拖住 P1–P5 的独立结果                       |

资格检查不使用真实/旧业务会话，不在本次文档阶段启动。它们是实现前明确的证据节点，不是让 writer 自己选择未知时是否放行。

## 5. 通用失败优先级

1. **CONTROL_HELD / OWNER_CHANGED**：人工暂停、停止、撤权、未决原生控制、owner/lease 改变；旧操作停止，不安装旧视图。已发生的用量仍按原 call 归账，不授予执行权。
2. **EXECUTION_UNKNOWN / JOURNAL_UNCERTAIN**：未知外部执行、未闭合宿主调用、关键追加未确认；闭锁，不清事实、不重放。
3. **VALIDATION_STALE / CONTRACT_CHANGED**：产物或检查前提改变；要求新验证。范围/权限变化使用原授权流程，不能以 retry-review 解决。
4. **REVIEW_VIEW_TOO_LARGE / EVIDENCE_MISSING**：在提交候选状态前拒绝不可处理数据；已存在旧完成态保持可诊断，不伪造成功。
5. **REVIEW_TRANSIENT / ADVICE_MISMATCH**：只有结构化可识别的临时错误或可纠正动作进入有限重试；不重置预算、不覆盖 hold。
6. **UI_ONLY_FAILURE**：成功关键提交后的可选 UI 降级，不把成功改成失败。

错误码为新内部合同；对外消息清晰、不带敏感 payload。不能只靠 error.message 的英文片段判断“这是 503，可以自动重试”。

## 6. 执行图、写入所有者与子计划

| 节点 | 产出                                           | 契约前置                               | 额外证据前置                  | 所属文档    |
| ---- | ---------------------------------------------- | -------------------------------------- | ----------------------------- | ----------- |
| P0   | 最小身份/版本/因果记录及兼容资格               | 本总则、已有领域与安全合同             | E-WIRE；各分支按需补资格      | 本文        |
| P1   | 可信执行结算，关闭 F-01                        | P0 的 owner/fence/追加合同             | E-EXEC，F-01 红用例           | 分卷 01     |
| P2   | 真实已知用量独立归账，关闭 F-04                | P0 的 call/owner/追加合同              | 用量拒绝/晚到/重复对照        | 分卷 01     |
| P3   | 完成后可终审、可重试、有界视图，关闭 F-02/F-03 | P1 结算、P2 记账、最小 ArtifactVersion | 容量与 503 红用例             | 分卷 02     |
| P4   | 显式模式、停止和安全退管，处理 L-01–L-04       | P1 静止结论、P3 执行/审查分离          | 模式矩阵、真实命令路径        | 分卷 02     |
| P5   | 可核验进展、确定性交接，处理 S-01/S-02         | P2、P3、P4                             | 防刷进度、动作/hold 对照      | 分卷 03     |
| P6   | 可信调用树与 only 模式静止完成，处理 I-01      | P3 资格、P4 归属、SDK 事件合同         | E-CODEMODE                    | 分卷 03     |
| P7   | 需求/检查/版本/回执契约，处理 B-01             | P3 视图、P4 身份、明确检查定义         | noop 替代、漏条件、人工项对照 | 分卷 03     |
| P8   | 当前完整候选的组合接受                         | P1–P7 实际结果                         | 原 gate + 新跨节点/兼容验证   | 本文第 7 节 |

P0 不等待 Code Mode 的全部能力。P1/P2 可独立准备，但都会写 supervisor，默认单 writer 串行落地；P5/P6/P7 的逻辑独立也不自动授权并行工作或子代理。所有新增生产文件均在分卷写集中明示，不能趁机改动无关 UI/包依赖。

## 7. P8 最终接受与交付

### 验证分配

- 编辑循环：所属公开 seam 的 RED/GREEN；原有覆盖保持，只有经本修改合同明确替代的策略断言才更新。
- 子计划：聚焦用例、直接消费者和相关静态检查；外部 adapter 使用真实 SDK/工具路径与隔离替身对照。
- 兼容/恢复：新旧 wire、实际旧读者拒绝、半追加、旧合法无文件例外、Session/tree/GoalRun/epoch/父子变化、迟到结果及 idempotency。
- 资源：先 10 或相应单例，再 100/500/1000；核对总字节、缓存、稳定恢复读取预算和未知状态屏障。无写稳定恢复仍应一完整扫描，必要追加/实时证明不套用此预算。
- 最终组合：原 `npm run check`（现有四项 90% 门及 13 个隔离 SDK/faux-provider 冒烟）、新增契约和真实 Code Mode only 模式、生命周期命令矩阵、完整差异与主工作树保护检查。
- 不在文档更新或无源码变化的每个交接点重复昂贵整套；最终实际通过记录绑定具体候选与命令，模拟不能冒称真实 CLI/生产业务接受。

### 完成条件

1. 总账所列每个拟关闭问题对应具体用例及候选，不因单个节点通过宣称全部修复。
2. H-01–H-09 的保护、授权/首次启动分离、未知不重放、正常退出与只读历史仍成立。
3. 未资格验证的执行器形态/宿主版本明确标为不支持或待验证，不默认为成功。
4. 当前候选的产物/检查/模式/账本版本、协议栅栏与回执可追溯；无伪造迁移事实。
5. 文档与实现状态分开：本次只有文档交付，不填写任何新修复的 PASSED 记录。

### 本次交付后的下一位执行者

主控在收到**实现授权**后，先建立独立 worktree，保留当前文档和原未跟踪文件；从 P0 的最小 fence/owner 检查和 P1/P2 的红回归开始。E-EXEC、E-CODEMODE 仅阻塞其对应能力，其他已具备合同的准备继续。此处不启动 writer，也不要求用户现在执行停用/重载命令。
