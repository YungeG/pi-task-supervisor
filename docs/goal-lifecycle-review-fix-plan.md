# Goal lifecycle 独立审查后修复计划

状态：**历史计划修订稿 2；原稿独立审查为 NOT_READY，修订稿未独立复核。当前 R5 按原生选择 A 进行本地修复，尚待当前字节的验证与独立验收**（见 §9）。本文件记录修复与验收路线，不授予部署、安装、重载、提交、合并或推送权限；计划审阅也不等于修复后的实现验收。

## 1. 固定输入与当前结论

| 输入                   | 固定身份／事实                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| 工作树／唯一 writer    | `goal-lifecycle`，`feat/supervisor-goal-lifecycle`；Main                                        |
| 基线 HEAD              | `974b5ddca57f8c2bf62534a3b14b1a5f23c275ac`                                                      |
| 已审 R1 候选，161 文件 | `44650375b163a74be0d0a982eb59d633bcf7138b1325e2bbbdca99ae06680a0d`                              |
| R1 生产代码，45 文件   | `afab30284f3414827c18c6424dfb2ac401a6c1cd9a75c9dc9043789b86a28df8`                              |
| 独立实现审查           | `cli-implementation-review-6fcvs10g`，结论 **BLOCK**；Standards 无发现，Spec 有 P1／P2 各一项   |
| 审查报告 SHA256        | `1aa07ea00330b59aa22a3a8d8a5a6cca419447b0b57a738323558d23f18e497b`                              |
| R1 自动化证据          | 1857 tests／72 files，90.05% branches，66 项主冷测通过；这些结果不能替代 BLOCK，也不自动证明 R2 |

既有文档：[领域词汇](../CONTEXT.md)、[多目标设计](./supervisor-multi-goal-design.md)、[原实现契约](./goal-lifecycle-implementation.md)。审查报告、逐文件清单和日志保存在兄弟目录 `goal-lifecycle-artifacts/`，不从可变 `main` 或其他工作树补入输入。

原计划批次仅编写与修订计划文档；后续实际修复不改变以下历史审阅结论。原稿 SHA256 为 `6b691151b0d15d2ffa17d3610e9235846ef8f6d9df6141bed7576b68941e9fcc`；用户另行允许的一次只读 CLI 计划审查 `cli-repair-plan-review-l0c5xo6u` 给出 **NOT_READY**，报告 SHA256 为 `47933a2c8980e19a971ef1ea1d5cdd2dc64fc0819193d33a553c9688080b6319`。Main 核对源码后接受其两项 P1 计划遗漏，并将五项问题的处置纳入本修订稿。原稿仍完整保存在该审查 workspace；这不是修订稿已复审通过。

原实现审查 workspace、R1 快照、patch、tarball、报告及历史成功／失败日志均保留；计划文档不修改 R1 生产代码身份。后续修复必须生成独立 R2 身份，不能覆盖旧证据或把旧 BLOCK／NOT_READY 改成 PASS。

## 2. 约束与修复目标

| ID  | 权威来源                                          | 必须保持                                                                                                                                     |
| --- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 多目标设计 §4.4、§7.1；审查 P1                    | 真实待决请求不能由 stop、closed-unstarted 或 archive 代为回答／消除；是否闭合由精确 scope／control／readback 判断，不能只看 phase 或字段存在 |
| A2  | 多目标设计 §4.4；原实现契约 Source audit；审查 P2 | 规划／执行角色跨缓存失效仍一致；旧规划回调不能污染新执行账本                                                                                 |
| A3  | 原实现契约、现有 receipt-store 规则               | 真正同目标执行的迟到写入仍产生新鲜度屏障；不凭未知来源丢弃业务执行，不重放未知工作，不伪造完成证明                                           |
| A4  | 原多目标设计兼容契约                              | legacy1／2／3 及既有 identity preimage 不变；不降级 wire5／carrier3／frame2，不整合 parked wire4                                             |
| A5  | 用户授权与工作约定                                | Main 为唯一 writer；不操作业务会话，不修改外部配置，不覆盖或静默整合并行 `main` 改动                                                         |

目标只限两个已接受发现。不开新授权系统、不增加自动重试、不重置额度、不清理旧 board，不以删除旧 approval 或强行补 B／C 来规避问题。

## 3. 分批推进、责任与完成条件

| 批次                   | Main 的工作                                                                                           | 该批完成条件                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| B0：计划审阅           | 由一个 fresh-context 只读 reviewer 检查计划与冻结源码；原生工具缺失时仅使用用户当次明确允许的隔离 CLI | 有真实审阅结果与 Main 处置；不能把请求已派发或 `READY` 当成通过                |
| B1：P1                 | 先补 RED 回归，再修当前请求的精确闭合检查及 archive 调用点                                            | 新请求 defer／未确认时 stop 和 archive 均 hold；旧已闭合许可不被删除或再次催批 |
| B2：P2                 | 先补冷角色分类 RED，再复用 owner 的首次启动核验与原生调用元数据                                       | 已证明的旧只读规划结果不写执行账本；真正执行迟到写入的屏障仍成立               |
| B3：整体验证与 R2 冻结 | 完整静态／覆盖率／冷测、保护清单、包装及正反回放                                                      | 同一 R2 候选通过所有所需自动化门槛，失败记录保留                               |
| B4：独立实现复审       | 对实际 R2 diff 做窄范围独立复审；Main 处置发现                                                        | 无未解决阻塞项，才可最终接受 `t-8.1`；合并与部署仍需另行授权                   |

每批结束报告实际结果和下一步，不为 checkpoint 标记未完成任务 done，不重复启动已有 reviewer／writer。原计划批次的授权仅为文档及当次独立计划审阅；当前 R5 的原生契约见 §9，不构成新的 CLI 审阅许可。

## 4. P1：当前待答权限请求不能被旧批准掩盖

### 4.1 已核对的失败路径

`preflight-human.prepareRequest` 创建新的 `permissionRequest`，同时保留旧 phase／approval。随后：

```text
已批准且未 Start
  → 再次 approve 创建新请求
  → defer（新请求无回应，旧 approval 仍在）
  → stopCurrentGoal
  → unstartedPreflightStopIssue 的 approved 快捷路径
  → approvalIssue／controlClosureIssue 只确认旧 approval
  → stop-unstarted 成功
  → closedDraft 快捷路径允许 archive
```

涉及现有符号：`prepareRequest`、`unstartedPreflightStopIssue`、`controlClosureIssue`、`confirmedPreflightProof`、`verifiedPreflightProjection`、`closedDraft`、`preflightTransitionIssue`。不能仅修新 stop 而继续让已保存的 `closed-unstarted` 组合绕过当前请求核验。也不能只检查草稿：已有 Supervisor 的 started／revoked 目标上再次 approve 后 defer，旧归档分支仍仅比较 phase／binding，同样必须拦住未答请求。

### 4.2 修复 seam 与接口契约

请求是否有效待决属于 **preflight module**，不是 lifecycle module 自行解释 phase。

- 在 `preflight.ts` 增加并导出一个共享、只读的 owner 接口，拟名 `currentPreflightRequestIssue(ctx, state): string | undefined`；调用方是 unstarted stop 与所有 archive 路径，内部 proof／fold 细节仍私有。
- `undefined` 只表示没有有效待答请求，或该请求已由其原 owner 的精确记录闭合；不是新的许可。非空字符串表示 pending／unconfirmed／inconsistent 的 hold 原因。
- 核验现有请求的 session、GoalRun／lifecycle scope、preflightId、requestId、planId／digest、所选权限与实际当前分支控制、回读关系；复用现有 proof／projection 校验，不另造一套简化证明。
- helper 不 append、不修 projection、不改变 phase／approval、不派发模型，不清除故障。坏文件、错误分支或不确定闭合必须保持 hold。
- `unstartedPreflightStopIssue` 在 approved／revoked 快捷返回之前调用它；first-start／业务执行不确定性的既有更强门禁保留。
- `preflightTransitionIssue(ctx, view)` 内部传递现有 `ctx`。存在 preflight 时，**所有归档分支**先调用 `currentPreflightRequestIssue(ctx, state)`；不能让 started／revoked 或 `closedDraft` 快捷绕过。仅匹配 `closedDraft` 时再调用 `unstartedPreflightStopIssue(ctx, state)`；普通已启动目标继续保留原 phase／binding 门禁，不能因 `state.started` 存在就一律禁止合法归档。lifecycle 不自行解析授权。
- `prepareRequest` 保留真实旧批准原值；不靠清空 approval、伪造 reject／revoke 或重置 phase 来“修复”。

判定不能退化为“存在 permissionRequest 字段就永远 pending”。按 §9 原生选择 A，必须分开处理：

1. **请求最终闭合**：只接受精确当前 request 的原生 A+B，复用 `confirmedPreflightProof`／`verifiedPreflightProjection` 核验身份、scope 与选择；旧 request 的答复不能关闭新 request。
2. **许可撤销／请求处置**：现有 `revokePreflight` 仍立即按既有 admission／settle 规则撤权，不要求额外 UI 答复；其记录没有精确问题时序或原生 B，不能证明最后问题已经回答。即使 revoke 位于当前 request 首次记录之后，旧 producer 也可能在它之后无落盘重提问。因此撤销记录只能保留撤权及禁止 ID 复用的证据，不能替代请求最终闭合。伪造 revoked snapshot、不同 scope、较早控制也不能闭合。

这取代原修订稿“有效后继 revoke 即可关闭问题”的规则；冻结旧文档／审查结论保留，不改写历史。独立完整性故障、A-only、矛盾来源或未知 Start／业务执行继续 hold；没有原生问题的合法 legacy 记录不凭空制造问题或答复。

### 4.3 首批 RED 与保留控制

| 用例                                                              | 必须观察到                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| approved → 新 permissionRequest → defer → stop                    | stop hold，无新的 stop-unstarted／C／模型派发；旧 approval 和新请求原值仍在          |
| 同上 → 重开／tree restore → stop／archive                         | 仍不能由旧控制或缓存 phase 关闭新请求；不自动重放                                    |
| 当前 request 的 A 无 B、错 scope／plan／request、错分支或缺失来源 | 不制造证据，保持 hold／原有完整性故障                                                |
| 当前 request 已精确回答且许可完整、没有 Start／未知执行           | 可结束 never-started 目标，保留许可，不制造 revoke／Supervisor                       |
| 新请求已精确回答但仍缺必要许可，或真实 start 请求存在             | 原业务门禁仍 hold，不因“有回应”就准许执行／归档                                      |
| 已回答旧 request 字段仍存在                                       | 不仅因字段存在而新增永久阻塞                                                         |
| 已启动目标再次 approve → defer → stop → archive                   | 所有 archive 分支先核验当前请求；不得仅凭 started／revoked 和旧 binding 放行         |
| 撤销早于／晚于新请求、仅有伪造 revoked 投影                       | 撤权真实生效，但 revoke 单独不能证明问题终结；纯 phase 更不能替代原生最终答复        |
| R1 已产生 stopped／closed-unstarted，但仍有有效未答请求           | archive hold；原 owner 原生 Reject 后显式 revoke，重开核验后方可正常归档；不自动复活 |

旧错误停止的出口按 §9 收窄：当前 stopped／completed owner 的 `approve` 入口仅接受真实原生 Reject／不允许；Allow／Later 不提交控制、不授予许可或 Start。`goal-journal.validateClosedPreflight` 在 closed-unstarted 下只额外接受严格解码的既有 version2 Reject；它并不替代原 owner 对 A+B、请求、scope／branch 的核验。保持“archive hold → 原 owner 的真实原生 Reject → 用户显式 revoke → 重开核验 → 合法归档”，不新增命令／格式，不复活 GoalRun，不自动回答或替用户撤销。历史批准／合法 Start 仍保留；独立 journal／执行故障不会因此消失。

## 5. P2：冷路径也要证明规划／执行角色

### 5.1 已核对的失败路径

热路径的 lease 含 GoalRun／C／attempt 及 planning／execution 角色。`historicalNativeCall` 的冷路径却只比较原生调用位置与 `preflightBaseEntryId`：

```text
C → 同一 attempt 的只读规划调用 → 首次启动
  → 调用身份缓存丢失／淘汰 → 旧规划结果到达
  → 冷路径判 current
  → unmatched receipt → epoch 屏障／Supervisor fault
```

修复不能把所有缓存未命中或所有首次启动前的成功结果一概丢弃。尤其是无法证明已获准的业务写入，必须保留 unknown 和既有屏障。

### 5.2 修复 seam 与接口契约

- `goal-tool-leases.ts` 继续只负责 callback 归属，不重新实现业务启动授权。
- 由 preflight owner 提供一个小的只读首次启动 inspector，拟名 `readGoalFirstStartEntry(ctx, current: Readonly<GoalCurrent>): string | undefined`。调用链固定为：原始 Start 的 `confirmedPreflightProof` → `verifiedPreflightProjection(ctx, proof, false)` → **一次** `readPreflightStartup(ctx, proof)`；后者已经调用 `readSupervisorStartRecord`，不再重复跑另一套 startup 验证。
- 返回值是**精确当前 scope／attempt／preflight** 首次启动 checkpoint 的实际原生 entryId，不是任意最新 Supervisor，也不是新许可。没有已验证启动记录返回 `undefined`；冲突、坏来源或未确认记录走既有校验错误。调用方均按 unknown 处理，不据此判 historical。
- 验证正向闭合包括：原始 SessionManager 来源、当前分支、传入 current 与物理选择／runtime 的 Session／GoalRun／C／attempt／preflight 一致、原始 Native Start A+B、**启动时**批准 binding、原始零继承 startup prefix。后来的重新批准／recover binding 或 checkpoint 不能替代原始启动。witness 后首个实际 Supervisor 若矛盾，立即保留错误，禁止继续搜索一个“能用”的后来 checkpoint。
- 只读 prefix 视图不能成为新的审批 admission context，也不临时安装归档 runtime。沿用现有模块依赖，用类型导入且不在模块初始化读取；不调用 restore／install，不让 inspector 递归调用自己。
- 冻结事件接口：`GoalToolLeases.result(id, ctx, toolName)` 的第三参由 `events.registerReceiptHandlers` 传入 `event.toolName`；所有测试调用点同步更新。缺失／不同工具名不能判为 historical，按现有 current／unknown 路径保留。为让热角色拒绝也不吞掉名字不匹配的可疑结果，`begin(id, ctx, toolName)` 在已有有界 Lease 中记录 admission 工具名；不引入新磁盘记录或角色指令。
- 物理回退先维持原有 C／attempt 选择，再检查同 attempt 的首次启动位置。统计调用 **出现次数**，包括同一 assistant message 内重复 ID，不以“包含 ID 的节点数”为唯一性证明。唯一调用须在当前 attempt 起点之后、已核验首次启动之前，实际 name 等于结果 toolName，且满足既有 `read/grep/find/ls` 策略，才返回 `historical`。
- 若需要调用名以核对实际结果，在 `human-journal.ts` 的原生调用元数据提取处增加有界的 id／name 元数据，保留现有 `toolCallIds` 使用契约；沿用最多 1000 个 content 块、id 最长 2000 字符，name 最长 200 字符；超界不制造身份。不能缓存 message／参数／receipt 正文，不改磁盘 wire。
- 不能只凭“出现在 Start 前”丢弃一个可能执行过的写入。自定义 `readOnlyHint` 若缺历史 admission 证明，不能把当前 annotation 冒充历史证明；保持 unknown 和原有屏障，不为消除额外 fault 写新证明。这是缺关联时的保守行为，不声称所有自定义工具都能无故障重建角色。
- 首次启动后属于同一 GoalRun／C／attempt 的执行结果继续交给现有 receipt-store；未匹配／迟到写入仍推进 freshness barrier。其他目标／旧 attempt 的热路径拒绝语义不变。
- 限制不变：512 个有界 callback 身份、128 条／1 MiB 原始回执 cache；未知来源不能用分类 helper 清除，恢复不能派发模型。

### 5.3 首批 RED 与保留控制

| 用例                                                                                                                  | 必须观察到                                                                               |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 原生 read 调用在 C 后、首次启动前；缓存冷失／淘汰后结果到达                                                           | 返回 historical；ledger、epoch、acceptance、fault、journal 条目及派发数均不变            |
| 同一 GoalRun 执行开始后的写入迟到，尤其 recover 后到达                                                                | 原有新鲜度屏障和故障仍成立；较早验证不再当作新鲜证明                                     |
| 同 ID 多个调用（含同一 message 内重复）、不同／缺失结果工具名、错误 Session／C／attempt、源损坏、缺失／不确认启动记录 | 不伪造 historical 证明；热／冷路径按原规则拒绝或 unknown／hold                           |
| 原始启动后出现重新批准、recover 或后续 checkpoint                                                                     | 仍选原始 Start 对应的首个 startup；首个矛盾不能由后来的正常记录遮盖                      |
| Start 前疑似写入的成功结果，或只凭当前 annotation 推测旧调用只读                                                      | 不静默丢弃业务执行不确定性                                                               |
| 其他 GoalRun／旧 attempt 的迟到结果                                                                                   | 不进入当前目标账本，也不恢复旧执行                                                       |
| 调用名字元数据提取                                                                                                    | 正文不保留，数量／字符串有界；既有 journal digest、legacy frame 和原生 ancestry 校验不变 |

## 6. 写集合与执行纪律

以下是拟定的最大写集合，不意味着所有文件都必须改；超出集合先说明原因。

| 文件／符号                                                                                         | 责任                                                                                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/preflight.ts`                                                                                 | P1 当前请求 closure；P2 只读首次启动 inspector；复用既有校验                            |
| `src/goal-lifecycle.ts`                                                                            | 所有 archive 分支先复用当前请求门禁；仅 closedDraft 调 unstarted 门禁；内部传递 ctx     |
| `src/goal-tool-leases.ts`                                                                          | `begin`／`result` 接收工具名；有界热 Lease 与冷原生元数据对齐；消费已验证原始启动 entry |
| `src/events.ts`                                                                                    | 仅两个 receipt handler 调用点传递 `event.toolName`；不改故障优先级／continuation 语义   |
| `src/human-journal.ts`                                                                             | 仅在必要时补有界 id／name 元数据；不改磁盘载体                                          |
| `src/__tests__/goal-command-recovery.test.ts`、`goal-lifecycle.test.ts`、`preflight-human.test.ts` | P1 的命令、恢复、终止及归档回归                                                         |
| `src/__tests__/goal-isolation.test.ts`、`human-journal.test.ts`                                    | P2 的冷／热角色、同目标屏障与元数据回归                                                 |
| 必要的 `test/goal-*` driver                                                                        | 只补原生／冷测场景；不模拟 argv、TTY、UI 或 source admission 来冒充正式入口             |

不预期更改：生产 receipt-store 语义、事件故障优先级、CLI 审批模型、wire5／carrier3／frame2、legacy1／2／3 preimage、额度常量、64,000-byte advisor cap。若测试表明必须改其中之一，先停下修订本计划，而不是顺手调整。

所有生产代码由 Main 在隔离工作树串行修改。当前 `main` 与全局配置有并行变化，归属尚不明；保留它们，不把它们作为这个计划的输入或自动移植。依赖仅恢复本任务所有且目标已核对的开发链接，不运行安装；验证后移除，不删除其他工作树或原始依赖。

## 7. 验证、证据与最终接受

1. **先 RED 后修复**：分别保存 P1／P2 旧候选失败与最小修复后的成功日志；按实际 source fingerprint 标记，不把 fixture／环境问题归成产品发现。
2. **相邻检查**：preflight proof／projection／restore、goal command／lifecycle／isolation、human journal、receipt-store 的同目标迟到屏障、legacy 对照及无副作用读取。
3. **同一 R2 完整门槛**：typecheck、lint、format、全量 tests、branches ≥90%、complexity ≤15、12 个开发 smokes；不降低门槛、不伪造 host receipt。
4. **小样例后扩展**：先跑最小角色和请求场景，再扩展三个实际 Pi host 的既有 cold、实际 CLI/PTY 正向与普通 SDK 双 TTY 否定、A-only 旧 reader 拒绝、fork／重开不重放；保留所需 100→1000→5000 资源与冷恢复检查。脚本按新身份输出，禁止覆盖 R1 的独占日志／manifest。
5. **R2 冻结**：记录全部代码／文档与逐文件 hash、patch 正反回放、包内生产源码一致性及无包内依赖；受保护输入若变更则保留实际 delta，不能报整体保护 PASS。
6. **实现复审**：复审实际修复 diff 及两项回归，同时看修复是否引入新缺陷；计划审阅、旧 R1 自动化或 Main 自查不能代替它。只读 subagent 可在明确授权与能力范围执行；另起 CLI 审查必须另获当次授权，不复用任何此前已消耗的许可。
7. **最终接受**：Main 只有在有效阻塞全部解决、验证和所需独立验收齐备后，才将 `t-8.1` 推进完成。合并、发布、安装、重载及业务使用仍是另外的授权范围。

## 8. 初稿独立计划审阅与 Main 处置

本次用户允许的单次只读计划审查已完成：155.831 秒、45 次只读工具调用、exit0／agent_settled、无越界读取、原稿与生产代码未变；原稿结论 **NOT_READY**。只有非秘密模型目录缓存发生变化，归属不明；不报告整体保护 PASS。本节是 Main 对源码和审查的处置，**不是修订稿独立复审结果**。

| 项目                                                    | Main 处置                                               | 本稿落实                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 计划 P1：普通 started／revoked archive 分支漏验当前请求 | 有效阻塞，不能只修 closedDraft                          | §4.2：所有 archive 路径先调用共享 preflight owner 请求门禁，只有 closedDraft 再走 unstarted 判断；补已启动目标 reapprove／defer 反例 |
| 计划 P1：结果工具名没有传递接口，写集合漏 events        | 有效阻塞；元数据本身无法替代结果身份                    | §5.2／§6：冻结 `result(id, ctx, toolName)` 与事件调用点；同时把 admission 名字接入有界热 Lease，名字不匹配保持 unknown               |
| revoked 与保留请求字段                                  | 历史处置已被 §9 原生 A 取代                             | 旧判定接受后继 owner revoke；H3 实测证明其不足，现撤权与原生最终闭合分开                                                             |
| 错误 closed-unstarted 的出口                            | 历史单步 revoke 出口已被 §9 取代                        | 当前出口为原 owner 原生 Reject → 显式 revoke → 重开核验 → archive；不复活，独立故障保持                                              |
| 首次启动 inspector                                      | preflight owner 合理，复用一次原始 startup 读取         | §5.2：Start proof → projection(false) → readPreflightStartup；只用启动时 binding，首个矛盾即 hold，不搜索后来记录                    |
| 冷调用唯一性及自定义 hint                               | 统计出现次数；缺历史 admission 的自定义工具保持 unknown | §5.2／§5.3：同节点重复 ID、名字不匹配、超界、重新批准／recover checkpoint 均有控制用例                                               |

代码模块选择和确定性 cache 协调仍由 Main 负责；真正的业务／权限取舍才提交用户决定，不能让用户批准一个证据缺口。不能把原稿的 NOT_READY、Main 的修订或旧自动化改写成“独立计划已通过”。

## 9. R5：原生选择 A 与历史 H3

R4 独立复审仍为 BLOCK。实际冻结旧 producer 重现 H3：普通问题 Q2 → 真实 revoke → 同选择的新一次原生提问／Later，旧 producer 复用 Q2 且 owner 字节不变。两个冻结 R4 reader RED 均错误地缺少 hold；真实 Native Reject A+B 的对照则强制后续旧 producer 使用新 ID。诊断、失败日志和原始捕获保存在 `goal-lifecycle-artifacts/repair-r5/`，不改写旧字节。

原生 decision `decision-c4d8e23f-9c7a-4487-b8b4-6a873a957659`／control `355142c7`／readback `59bfdc61` 确认 A：保留旧 wire，撤权仍立即生效；未答／不确定问题必须由现有真实原生最终回应闭合。此选择不是任务接受、独立复审许可或部署授权。所有旧 CLI 审查许可已消耗。

本地实施只改 `preflight.ts`、`preflight-human.ts`、`goal-scope.ts`、`goal-journal.ts`、`commands.ts` 及必要文档／既有命令与恢复／原生 journal 测试 seam：

- `requestClosed` 不接受 revoke 单独闭合；`canReusePreflightRequest` 独立拒绝已撤销 ID，避免复发 F1。
- 仅精确当前 stopped／completed GoalRun 的未终结问题可进入 denial-only；已最终回答的关闭 owner 不因此创建新问题。pending／blocked／fault／异 Session 与历史 owner 不放行。await 期间 scope、epoch、base、idle／队列与 journal 守卫保持有效。
- closed-unstarted 仅允许严格 version2 Native Reject 或原有 revoke；伪造、缺 B、错 scope／branch、Approve／Start 均不能变成许可或最终证明。拒绝后 GoalRun 仍关闭、Supervisor 保持 null、任务与用量不重置。
- 继续按 §7 验证当前 R5 字节。R1–R4 的绿测、此次选择及 Main 自查都不能替代新候选的完整门槛、独立复审与精确当前 review／epoch 的真实 host 验收。
