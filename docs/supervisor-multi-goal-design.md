# 同一 Session 多目标生命周期修复方案

状态：**PROPOSED / P1-1 文档修订，待独立复审，未实施**。本轮只修订方案与术语，不修改目标会话、运行状态或安装配置，不提交、合并、推送或启动业务工作。原始独立审阅的 BLOCK 结论保留，本次修订不冒称复审通过。

代码基线：`974b5ddca57f8c2bf62534a3b14b1a5f23c275ac`，包含驻留显示修复 `4a2c7b1`。该基线不包含另一个工作树中尚未完成独立实现审查的 recovery-experience 候选。本文不能作为那个候选的验收或集成许可。

## 1. 结论与目标

**Session 是对话和历史容器，不是只能使用一次的目标槽位。** 保持一个当前目标执行（GoalRun），允许在同一 Session 内依次建立多个 GoalRun。

修复采用一个统一的目标交接 owner：

1. 用户明确提出新目标；符合条件时，通过真实原生界面确认“归档旧目标并规划新目标”。
2. 旧目标、旧看板、证据、授权、暂停原因和资源用量保持原状，转为只读历史；不把未完成任务改成 done 或 abandoned。
3. 建立独立的新 GoalRun、新看板和新 preflight。新目标先规划，再按原生权限确认与独立 start 流程进入执行。
4. 历史可在当前 Session 内浏览，不要求清空旧板、切换 Session、手工编辑日志或尝试 resume/recover 组合。
5. 真实决策、未知执行、未确认回执、损坏日志和不确定写入仍然阻断交接，不能用“新目标”一并批准或掩盖。

最小范围是**顺序多目标**，不是并行多目标，也不是允许随意重新激活历史目标。

## 2. 已确认的问题及根因

### 2.1 本次具体状态

只读诊断的捕获分支中，Supervisor 为 `stopped`、pending=false；看板仍为 `paused`、generation=48，共 12 项：4 done、1 implementing、7 configured，没有看板 decision 和执行引用。新增日志切片与先前捕获的叶节点正确衔接。它是持久记录证据，不是对运行中内存叶节点或已加载扩展版本的认证。

这些状态不代表要补一次业务审批：旧监督已经停止，但旧看板仍被当成“当前工作”。`implementing` 在这里是历史任务状态，不能单独断言有进程活着。ReceiptStore 的健康、pending ledger、原生来源和当前分支仍须在实际交接时重新验证，不能从 Supervisor.pending=false 推导全部通过。

### 2.2 当前路径

```text
/task-supervisor supervise <goal>
  → commands.routeStart → startGoal → supervisor.startSupervisor
  → 旧看板 paused/waiting_for_decision：拒绝
  → 即使 board-only resume：旧板存在 done 任务，仍拒绝新目标继承旧证据
```

`recoverSupervisor` 只接受 paused/fault，不接受 stopped；`clear_tasks` 又拒绝 implementing/reviewing 任务。不能把这些命令串起来作为正常的新目标入口。

根因不是存在“每 Session 只能一个目标”的计数限制，而是 runtime 的 board、supervisor、preflight、receiptStore 只有当前槽位，没有一个共同负责历史封存、当前身份和交接恢复的 owner。单独放宽任意 guard 都会留下跨目标证据或授权污染。

### 2.3 源码依据（全部相对上述基线）

| ID  | 来源                                                                                                                                            | 必须保留或修复的事实                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| U1  | 用户要求：保留历史，在同一 Session 开始新目标                                                                                                   | 不能以另开 Session 或清历史代替修复                           |
| U2  | 用户本轮要求                                                                                                                                    | 只交付文档，不实施或操作业务会话                              |
| C1  | [supervisor.ts](../src/supervisor.ts)：`startSupervisor`、`recoverSupervisor`                                                                   | 新目标不得批准旧门禁；旧 done 不自动属于新目标；恢复不是新建  |
| C2  | [commands.ts](../src/commands.ts)：`startGoal`、`supervisorCommand`、`resume`                                                                   | stop 保留看板；board-only resume 不重新启动 stopped 监督      |
| C3  | [preflight.ts](../src/preflight.ts)：`beginPreflight`、`preflightStartBinding`、`restorePreflight`                                              | 旧板和旧权限不能由规划入口偷偷清除或复用                      |
| C4  | [human-control.ts](../src/human-control.ts)、[human-journal.ts](../src/human-journal.ts)、[human-ui.ts](../src/human-ui.ts)                     | 原生来源、opaque answer、实际分支 A/B 回读；缓存不是授权      |
| C5  | [receipt-store.ts](../src/receipt-store.ts)：`ReceiptStore`、`appendCheckpoint`；[supervisor.ts](../src/supervisor.ts)：`readSupervisorHistory` | goalId 已有独立账本；真实回执、分支闭合、未知执行禁止自动重放 |
| C6  | [state.ts](../src/state.ts)：`reconstructState`、`persistEntries`；[events.ts](../src/events.ts)                                                | snapshot generation 单调；生命周期恢复后才开放事件/工具       |
| C7  | [flow.ts](../src/flow.ts)、[ui-capture.ts](../src/ui-capture.ts)、[ui-view.ts](../src/ui-view.ts)                                               | owner 和只读状态使用同一资格判断；历史显示不能变成执行许可    |

现有隔离复现已经确认：原错误无写入/无派发；resume 后仍可能撞上旧 done 保护；recover 不重开 stopped。它们证明当前问题，不是新实现的验收。

## 3. 领域模型与不变量

术语见 [CONTEXT.md](../CONTEXT.md)。

| 对象                         | 含义                       | 本方案的身份约束                                                    |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------- |
| Session                      | 连续对话和完整历史         | 现有 sessionId；cwd/工作树改变不创建目标                            |
| GoalRun                      | 一次用户明确建立的目标执行 | 独立 `goalRunId`；相同目标文字也可属于不同执行                      |
| Current GoalRun              | 当前唯一可规划/执行的目标  | 由已确认的 lifecycle checkpoint 选择，不由“最近任意 snapshot”猜测   |
| Archived GoalRun             | 历史目标                   | 只读，保留最后真实状态；归档不是通过验收                            |
| Board / Preflight / Evidence | 属于一个 GoalRun 的记录    | 必须闭合到目标、Session、分支和当前版本，不只比较 taskId 或目标文字 |

硬约束：

- 同时至多一个 Current GoalRun；浏览历史不切换当前目标。GoalRun 在 Supervisor 创建之前就已经存在，其显式重规划和结束必须由 lifecycle owner 处理，不能要求先有 Supervisor、proposal 或 planId。
- 旧任务可以保留 implementing 等原状态；仅凭状态文字不推断执行存活，也不自动完成、放弃、重跑。
- 新目标无旧 bindings、acceptedDigest、审批、start answer、externalWait 或 host receipt；旧 `tool:<callId>` 引用不能解析成新目标证据。
- 新 GoalRun 的初始计数为零，是明确新目标的独立记账，不是重置旧目标预算。旧 reviews/continuations/stagnant/tokens/cost 和暂停原因全部保留。
- 保持每目标 100 任务、40 reviews、20 continuations、3 stagnant 上限；保持 advisor packet 64,000 UTF-8 bytes 和至少 90% 覆盖率门槛，lint complexity≤15。
- 不增加权限，不继承旧批准或旧拒绝作为新目标的批准；新目标仍须取得自己需要的许可。归档确认只允许归档和准备新目标，不允许执行旧任务或业务动作。
- 不重写、截断或修补原日志；不复制全部旧回执形成第二套证明；不声称 OS sandbox、fsync 或跨进程事务原子性。

## 4. 用户流程及命令语义

### 4.1 主流程：不用再增加一串管理命令

```text
用户在原 Session 输入 supervise <新目标>（或 preflight <新目标>）
  → 统一入口先识别“目标交接”，不能先按目标文字匹配旧 preflight
  → 资格检查
  → 原生确认：归档旧目标并规划新目标 / 取消
  → 物理确认归档交接已提交
  → 新 GoalRun + 空看板 + 全新的 preflight planning
  → Main 只读规划（不执行业务）
  → 新方案的权限确认
  → 独立 Start execution
  → 新目标的实际执行与验收
```

确认页必须明确显示：旧目标与当前 Session、旧状态和任务计数、未完成任务将原样归档、新目标完整原值、旧授权不承接、旧用量保留、新目标独立记账，以及“本次不会启动旧任务或取消外部进程”。主按钮不能写成含糊的“修复”或“继续”。默认/取消不提交交接。

**可见行为变化：存在历史交接时，`supervise` 先进入新目标规划，而不是直接派发业务执行。** 干净旧会话中现有 legacy-supervise 行为暂不无声改写；推荐的新流程始终是 preflight→approve→start。这里复用真实业务许可流程，不把技术缓存修复包装成新一轮业务审批。

### 4.2 按当前状态路由

| 当前事实                                                                                  | 行为                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 无目标、无历史看板                                                                        | 保留现有入口语义；不弹无意义归档确认                                                             |
| stopped + paused/inactive/completed 历史板，且全部保护检查通过                            | 提供归档并规划新目标；允许保留历史 implementing 记录                                             |
| completed 且原 owner 的验收状态有效                                                       | 允许显式归档后规划新目标，保留 completed 和验收证明；不先改成 stopped                            |
| active/reviewing/普通 paused/fault 目标                                                   | 不自动停止/恢复；先显示当前事实，要求明确结束旧目标。新文字不是旧门禁批准                        |
| stopped 但板已被单独 resume 成 active                                                     | 不把活动看板猜成历史；先经原 stop owner 结束当前工作                                             |
| 看板 decision、待决业务授权/启动请求、native question、repair、未知执行或回执故障         | 阻断并给具体原因，不归档以绕过它                                                                 |
| 已提交的新 GoalRun 正在规划，重复 `supervise` 或当前规划仍在途                            | 只显示状态；不重复归档、分配身份或派发 Main                                                      |
| Current GoalRun 未启动监督，规划已中断/尚未派发/已结束且无 proposal；用户显式 `preflight` | 按 §4.4 在同一 GoalRun 建立新规划尝试；保持 goalRunId，不再做 C                                  |
| Current GoalRun 未启动监督、无真实待决/未知执行；用户显式 `stop`                          | 按 §4.4 结束当前 GoalRun，即使没有 Supervisor/proposal/planId                                    |
| scoped GoalRun 已由 lifecycle owner 确认 stopped，但没有 Supervisor                       | 按其 GoalRun 身份进入下一次归档交接；不是无监督 legacy-board，也不能被原始 planning 字段再次锁住 |
| 仅有无监督的历史板                                                                        | 经相同资格检查，确认页标明“未记录监督目标”；归档为 legacy-board，不杜撰旧目标或验收              |

### 4.3 既有动作保持分工

`pause/resume` 只作用于当前目标的既有恢复语义；`recover` 保持明确的当前目标恢复/计数重置语义，不变成“换目标”。`stop` 面向 Current GoalRun，不以 Supervisor 是否存在判断目标是否存在；也不表示完成、撤销业务许可或杀死外部工作。`clear_tasks` 不作为交接内部捷径。`enable` 不归档、不启动。

增加一个只读入口 `history [goalRunId]`；`tasks`、`status` 和完整看板能到达目标历史。RPC/print 保留旧文字路径；新增交接若不满足真实原生来源要求，只能返回只读诊断，不能降级为聊天、参数 flag、普通 select 或 SDK 伪造确认。

### 4.4 未启动 Supervisor 的 GoalRun：重规划和结束

以下是对 P1-1 的明确闭合，不依赖 `recoverSupervisor`、`revokePreflight` 或伪造 Supervisor。新契约仅用于 wire5/scoped Current GoalRun；没有 lifecycle owner 的 legacy 命令语义不无声改变。

**显式重规划：**已有 Current GoalRun 时，`/task-supervisor preflight`（不带目标文字）表示“对当前目标重新进行只读规划”；`preflight <与当前目标相同的规范化文字>` 也走此分支。先捕获当前 GoalRun 身份再比较输入，不能只靠目标文字选择身份。重复 `supervise` 仍只显示状态；不同目标文字必须走明确结束/归档交接，不能冒充重规划。

重规划必须同时满足：

- Current GoalRun.phase 为 planning/planning-interrupted（尝试可以是 prepared），而不是 stopped、archived 或 execution active；物理生命周期记录证明其 Supervisor/执行账本尚未创建，也没有 first-start 控制或执行派发。仅凭 runtime.supervisor 为 undefined 不足以证明“尚未启动”。
- 无 proposal、approval、有效业务待决请求、start 控制、board decision、repair、receipt pending、外部执行或独立 fault。已经进入业务审批/启动的目标仍由原 owner 处理，不借重规划丢弃它们。
- Main idle、无 pending messages，旧规划尝试有宿主证据证明未派发或已结束。若仅只读规划的结果丢失，owner 可先确认本目标从未执行、其宿主运行已取消/结束且队列为空、旧 lease 已失效，再把该尝试封存为“已收敛、结果未知”；不要求重建丢失的规划内容。缺少这些正面证据、first-start/业务执行仍未知、回执未闭合或外部引用未解决时继续 hold，不能把计时、缺记录或用户再次输入当成证明。

满足后，owner 在同一 `goalRunId`、同一 lifecycleCommitId 下保存一个新规划尝试，增加 planning attempt 序号，分配新 attemptId 和 preflightId（revision=0），并使旧规划 lease 失效。旧尝试及其 interrupted 状态保留。看板身份、既有记账和历史不重置，不创建新 GoalRun/receipt ledger，不重复归档 C；原始 preflight 的 interrupted 不会被直接改成可提交，旧 attempt/preflightId 的 proposal 必须拒绝。新记录物理确认后才允许命令外层派发一次只读规划，不能因此执行业务、自动批准或自动 start。

**显式结束：**`/task-supervisor stop` 先路由到 lifecycle owner；若当前 scoped GoalRun 尚未创建 Supervisor 且仍处规划阶段，由 `stopCurrentGoal` 结束它，而不是报 `No supervisor is registered`。owner 先冻结目标/尝试身份、使旧规划 lease 失效；必要时通过现有宿主取消/等待流程结束该只读规划，再复验实际队列、分支与全部门禁。不能证实只读规划已收敛、存在 first-start/业务执行不确定性或真实待决时保持 hold，不假装已经停止；纯规划结果丢失可在上述宿主收敛和 lease 失效条件下原样记为 unknown 后结束，不要求凭空恢复输出。它不使用“没有 proposal 就无法 revoke”作为前置条件。

结束成功以 wire5 `goal-state` 的 `stop-unstarted` 记录物理确认：Current GoalRun.phase=stopped、planning disposition=closed-unstarted，Supervisor 和执行账本明确仍未创建。旧 preflight 原值及尝试引用保留，**不制造 revoked control 或假的 stopped Supervisor**，也不修改任务完成状态/额度。其后禁止该目标再提交 proposal、批准、start 或通过 replan 自动复活；真实许可/请求若存在仍由对应 owner 处理，不能被结束动作批准或清除。已经存在 Supervisor 时仍调用原 stop owner，并将其真实确认的结果归入同一个 wire5 当前目标记录，不能出现 Supervisor 已停而 GoalRun 仍被当作 active。

再次 `stop` 返回同一停止结果，不新写一次停止、不分配目标或派发。对这种“无 Supervisor 但已结束的 scoped GoalRun”，资格检查以生命周期停止记录和无待决/未知工作为依据；它保留未派发/中断的规划历史，但不再把这份已闭合草稿当成未决规划。下一次新目标仍须正常归档确认，浏览旧历史保持只读。

本节的人类命令来自实际原生命令上下文，并重新捕获当前身份；只表示重新规划或停止当前目标，不生成 NativeAnswer，也不替代任何业务许可/执行 start。模型工具、聊天/JSON、重复旧控制或缓存修复均不得调用这两条人类控制路径来取得派发意图；来源不支持时只返回诊断，不绕过既有来源要求。纯投影修复可以由 owner 完成，不为缓存写失败重复索要业务审批。

## 5. 统一 owner 与接口设计

新增一个有深度的 **Module：`src/goal-lifecycle.ts`**，把身份、资格、交接提交和恢复集中在这里；命令、UI、flow 只消费其 Interface，不各自实现归档逻辑。

拟定的最小 Interface（设计，不是现有可调用代码）：

```ts
inspectGoalTransition(ctx, request): GoalTransitionView
requestGoalTransition(pi, ctx, request, signal?): Promise<GoalTransitionResult>
replanCurrentGoal(pi, ctx, signal?): Promise<GoalPlanningResult>
stopCurrentGoal(pi, ctx, signal?): Promise<GoalStopResult>
restoreGoalLifecycle(pi, ctx): GoalLifecycleView
readGoalHistory(ctx, cursor?, goalRunId?): Readonly<GoalHistoryPage>
```

- `request` 仅含归一化后的目标原值和入口意图（supervise/preflight）；不接受模型传入的旧路径、源 snapshot、runId 或“已批准”标志。
- `GoalTransitionView` 精确返回 `fresh | same-current | eligible | blocked | pending`、规范化新目标、owner 捕获的源身份、原生来源是否支持、具体 blocker；不写日志或派发。
- `requestGoalTransition` 负责复验、原生请求、A/B/C、当前投影发布；返回 `cancelled | deferred | committed-planning | projection-pending | blocked`。**它不派发 Main，也不启动 Supervisor。**
- `restoreGoalLifecycle` 只按持久分支恢复/修复确定性投影，不重开归档目标，不补造答复，不派发模型或执行。
- `replanCurrentGoal` 返回 `planning-ready | already-running | projection-pending | blocked` 及精确 planning lease；只建立/修复同一目标的规划尝试，不派发。拒绝实际未知工作和真实门禁，不重置 quota 或身份。
- `stopCurrentGoal` 返回 `stopped | already-stopped | projection-pending | blocked`；只结束当前目标，先使该目标的旧规划回调失效并核对宿主收敛，再确认持久停止，不把不存在的 Supervisor 作为失败条件。
- 命令调用方只在 `committed-planning` 或 `planning-ready` 且全部身份/门禁再次匹配时，调用唯一 `dispatchGoalPlanning`。该内部 helper 先物理确认当前 attempt 的派发 claim 再发送一次只读规划；派发结果未知时保持诊断，不自动重试。三个 owner 动作及 restore 都不自行发送模型 turn。
- history 返回只读 DTO；禁止用临时修改 runtime 到旧目标的方式调用现有 owner。

内部 seams：纯 `qualifyGoalTransition`、`qualifyCurrentGoalPlanning`、纯 `goalTransitionScope`、唯一 `appendObservedGoalCheckpoint`、`projectGoalCommit`、`dispatchGoalPlanning`。复用既有原生问答/材料展示与分支检查；不引入可配置事务框架或第二套存储。

## 6. 身份、源引用与历史存储

### 6.1 canonical identity

- 新 `goalRunId` 沿用现有 ReceiptStore 的 `rg-<UUID>` 形式，在一次交接请求建立时只分配一次；执行启动时通过构造器现有 `goalId` 参数使用同一个值。
- v3 旧目标使用已验证 ledger.goalId 作为既有身份。v1/v2 缺少该身份时，使用带种类的精确 legacy-checkpoint 引用；无监督旧板使用 legacy-board 引用，不将目标文字哈希假称为执行身份。
- 源捕获至少含 sessionId、分支 ancestry anchor、旧 Supervisor/board/preflight 的 entryId 与 **entryDigest**（实际完整原生日志节点的摘要）、旧 board generation、receipt cursor/head/epoch、旧原生 control 链引用；读取载荷还要核对其 dataDigest。缺失项显式为 none/unknown，不伪造默认有效状态。
- A 的 scope 还包含 transitionId、新 goalRunId、目标原值摘要、所选 model、归档及 planning-only 意图。由固定 DTO 构造函数产生摘要 preimage；沿用现有 digest(JSON.stringify(value)) 规则，冻结字段顺序与测试向量，不顺便重算旧历史哈希。
- 同一 GoalRun 的规划尝试另有单调 attemptNo、不可复用 attemptId、preflightId 和精确前驱 goal-state 引用；重规划不改 goalRunId。派发、结果、proposal 和 UI lease 均须匹配当前尝试；序号溢出保持 hold，不能绕回零或顺手新建目标。
- 区分 dataDigest（记录 data 的摘要）与 entryDigest/现有 witness 的 JournalNode.digest（完整节点摘要）。新 goal owner 的 frame 使用明确的 baseEntryId/baseEntryDigest，不能把 entryDigest 塞进旧 baseSnapshotDigest 字段。

### 6.2 归档引用，而非复制原始历史

已提交交接记录保存旧状态的可验证引用及有界显示元数据。原始看板、完整目标、证据、权限、额度和聊天仍在同一 Session 原分支中；详情按引用只读读取。归档不新增一份旧 receipt body，不把 1227 条证据装进新 checkpoint。

Current GoalRun 选择由已确认的生命周期记录决定。后续 board、preflight、Supervisor 和 native response 必须匹配这个选择；不能在新旧混合日志里独立各取“最后一条”。

## 7. 提交协议与失效顺序

### 7.1 前置检查（每次确认后再验一次）

1. 目标文本符合现有非秘密/有界输入要求，原生来源满足 `isTrustedLocalTui`，Session/branch 可读且身份一致。
2. 无 journal fault、未知格式、未完成的其他交接、board/preflight repair、互相冲突的 owner 或 native question。
3. Main idle、无待处理消息；若有 Supervisor/ReceiptStore，则 pending=false、账本验证健康且 pendingCount=0。没有账本只有两种可证明的合法来源：按原严格读取验证的 legacy 分支，或物理 scoped 生命周期记录证明执行账本尚未创建且没有任何 first-start/执行记录；不能把 runtime 缺失当零。
4. 无 board decision 或 waiting_for_decision；旧 preflight 若仍有待处理的规划/授权/start 请求，不替其批准、拒绝或取消。由原 owner 处理后重试。有效待决由 owner 的 scope/control/readback 状态判定，不因某个已回答 request 字段仍存在就永远阻断；由同一 GoalRun 的 `stop-unstarted` 正确闭合、且无 proposal/授权/start/未知工作的草稿，不因原 preflight.phase 仍为 planning/interrupted 被再次当作待决业务请求。
5. 无 task.executionRef，无未闭合 externalWait；不以 owner 报告、implementing 字样或超时推断外部工作结束。Main 负责检索证据，不向用户要求“批准未知执行已结束”。
6. 旧目标为 stopped（包括 lifecycle owner 确认的无 Supervisor 目标），或确实已由原 owner 验证 completed；旧板无独立活动工作。历史 started/revoked preflight 只有在严格归属于旧目标且无未决请求时可一并归档，新目标必须重新 preflight。

只读检查与执行使用同一个资格结果。不要新增“忽略门禁”“force”“按缓存猜测安全”等路径。

### 7.2 活体请求 → A → B → C → projection → planning dispatch

| 阶段       | 持久内容及作用                                                                                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 活体请求   | 从已存在的旧 Supervisor checkpoint（没有监督目标时为 board snapshot）捕获实际节点摘要，固定旧源引用、新目标、transitionId 和新 goalRunId，再展示原生确认。尚不写生命周期栅栏；取消/来源不支持不改变持久目标状态 |
| A          | 真实 NativeAnswer 对应的 wire5 `transition-control`，以 `continuous-tasks:supervisor` 类型物理写入。它同时是格式栅栏与“归档旧目标并规划新目标”的精确控制，不承载业务许可或 execution start                      |
| B          | 现有 human-readback 风格 witness；闭合到 A、goal frame 的旧 base 节点、当前原生分支及精确 scope                                                                                                                 |
| C          | 唯一 wire5 `transition-committed`：引用 A/B、封存旧目标引用，并携带完整新 GoalRun seed（空板、全新 planning preflight、尚未启动监督）                                                                           |
| Projection | 只从 C 投影当前 runtime；seed 已在 C 内，不重复追加同 generation/revision 的初始 board/preflight snapshot。下一次实际修改才写 scoped carrier                                                                    |
| Dispatch   | 命令外层经 `dispatchGoalPlanning` 先物理确认该 attempt 的派发 claim，再最多发送一次只读规划；每次显式重规划使用新 attempt。它不是 C 的权威来源，重启不自动补发                                                  |

pending 是“已有 A 但未闭合到 C”的派生状态，不是确认前必须写入旧目标的管理状态。这样正常取消不会升级旧日志或留下一个必须修复的目标槽。A 的 append 是第一条持久生命周期写入；不能先另写一个新 customType 让旧 reader 忽略，再清除旧投影。

确认期间发生 branch/session/source 变化、取消、compaction 或新工作进入，废弃旧活体答复；不能用它提交别的 scope。重复命令若已有 A/B/C，先读取同一请求结果，不再分配新身份；尚无 A 的重复打开须使旧活体 frame 失效。取消后的新请求使用新身份，不能拿旧 opaque answer 顶替。

新 seed 明确清除的是**当前投影中的旧关联**：新 board 无任务/decision/finalAcceptance，generation=旧全局 generation+1；新 preflight 有新 ID、revision=0、无旧 proposal/approval/start；当前 GoalRun.phase=planning，Supervisor/执行账本为显式 not-created，并含首个 prepared planning attempt。C 中的 seed 是初始权威状态，后续 board generation 必须严格大于它；不能通过重写相同 seed 绕过单调性检查。旧记录每一个字段仍保留在归档源中，4 done / 1 implementing / 7 configured 仍以原状态留在旧目标里。

### 7.3 故障恢复契约

| 故障切点                                | 正确结果                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 尚无 A，取消/关闭或确认前中断           | 不切换、不启动，不写新生命周期栅栏；旧目标及其格式保留。没有已保存的人类选择就不能从聊天或缓存补造它                     |
| A 已写但 B 未确认                       | 保持不确定 hold；不能把 A 单独当有效答复或为它自动制造 witness                                                           |
| A+B 已确认，C 未写                      | 旧目标保持当前且不继续工作；owner 可在完全相同的源/分支条件下修复 C 投影，不重复审批、不派发                             |
| C 已物理写入但 append 抛错/ACK 丢失     | 本运行时先 hold，不报告切换完成；重开按实际 C 选新 prepared/planning 目标，不能重新归档或复制 C                          |
| C 后缓存写失败                          | 按 C 修复新投影；不复活旧目标，不要求用户再批准同一业务选择                                                              |
| A/B/C 之后有更新目标、分支变化或冲突 C  | 不覆盖较新状态，拒绝旧修复并保留诊断                                                                                     |
| C 后 planning 派发结果未知/进程退出     | 保留同一新目标，不自动派发；按 §7.4 及 §4.4 核对旧尝试，随后只接受明确的当前目标重规划或结束，不用新 GoalRun/重复 C 掩盖 |
| replan goal-state 已写入但 ACK/投影丢失 | 恢复已写入的同一 attempt，只修投影；不再分配一个 attempt 或自动发送。无物理确认不发布 planning-ready                     |
| stop-unstarted 已写入但 ACK 丢失        | 恢复同一目标的 stopped/closed-unstarted；不制造 Supervisor、不重复停止、不自动归档或创建下一个目标                       |
| 最终 execution start 部分失败           | 仍由新目标的既有 preflight/start owner 保持中断状态；归档 owner 不补发业务执行                                           |

只接受本分支的首个精确 C。重复、冲突、同摘要错误 predecessor、兄弟分支 witness 或未来记录不能闭合当前前缀。A 单独存在且已无原活体答复时，不自动补 B；只能保持 hold，并在源状态仍相同的前提下由一次新的真实原生确认明确 supersede 未确认 A，不能重放聊天或反复问已经由 A+B 证明的同一选择。不存在跨多个 append 的 OS 原子事务保证；保证来自物理读回、确定性恢复和始终不提前执行。

### 7.4 同一目标的规划尝试与无 Supervisor 停止

- wire5 `goal-state` 增加严格的 `goalPhase`、Supervisor/执行账本的 absent/not-created 或已验证引用，以及 planning attempt 身份、前驱和状态。本节 GoalRun 阶段为 planning/planning-interrupted/stopped；prepared、dispatch-claimed、dispatched、settled、closed-unknown-result 属于尝试状态，不能混作目标身份或新目标。允许的相关动作固定为 `prepare-planning`、`claim-planning-dispatch`、`observe-planning-dispatch`、`settle-planning`、`stop-unstarted`；它们不是新的交接 C，不移动旧 archive 引用，不创建新 GoalRun。
- C 内首个 attempt 为 prepared；`replanCurrentGoal` 在同一目标上保存下一个 prepared attempt。命令外层必须先物理确认 `claim-planning-dispatch`，再调用 Pi 发送；claim 缺失时该协议保证尚未进入发送，不能先 send 后补 intent。claim 已有而结果未闭合时一律视为可能已发送，ACK 丢失不回退为 prepared。
- 队列、宿主完成/取消结果和 attempt 身份共同支持 `observe/settle`，不能单凭 UI 缓存、计时或缺消息推导旧派发已结束。owner 直接核对实际宿主及当前分支，必要时取消并等待自己的只读规划，保存有界的身份/lease/队列收敛观察后才能记为 settled 或 closed-unknown-result；后者明确保留丢失结果，不伪称成功或从未派发。恢复只重建事实，不自动 claim/send。显式 `preflight` 仅在旧尝试已被证实未发送或已收敛且 lease 失效后建立新尝试；任何业务/外部执行、first-start 或回执未知仍 hold，不要求用户“批准未知已结束”。
- `stopCurrentGoal` 若要结束仍在运行的只读规划，先使该 GoalRun/attempt lease 失效，再经宿主取消并等待实际收敛；阻断迟到 submit/proposal 和旧 UI 回调。物理停止记录确认后才发布 stopped。它保留旧 preflight 数据，仅在 GoalRun 上记录 closed-unstarted，既不伪造 revoke，也不因原 raw planning 字段阻断下一目标。
- 所有 action 使用当前 Session/分支、goalRunId、lifecycleCommitId、attempt 和精确前驱核验；同一个 action 的已确认结果可回读，但较新尝试/目标存在时旧修复不得覆盖。技术投影修复不生成重规划意图，已发送或 unknown 的尝试不自动重试。用户显式重规划是一次新的只读规划尝试，不是旧工具 replay、业务许可或额度重置。

## 8. 版本和兼容策略

基线实际格式：Supervisor checkpoint 1/2/3，board snapshot 2，preflight 1/2；receipt ledger entry 为 version=1（存储体系称 v3）。不要混淆 checkpoint wire 与 receipt 格式。

拟定协议如下，实施前冻结为 fixtures；**不得把新字段悄悄塞进旧 reader 会忽略的附加属性中**：

| 载体                          | 新设计                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `continuous-tasks:supervisor` | `version:5, protocol:"goal-lifecycle-v1"` 的严格判别联合：`transition-control`、`transition-committed`、`goal-state`。control 是 A；commit 是 C；goal-state 绑定当前 goalRunId/lifecycleCommitId、goalPhase、planning attempt/action 及 Supervisor/ledger 的明确未创建状态或已验证引用；支持无 Supervisor 的 planning/interrupted/stopped，不伪造旧 Supervisor 元数据 |
| `continuous-tasks:snapshot`   | 新 scoped envelope version=3：goalRunId、lifecycleCommitId、原内存 V2 snapshot。保持全 Session generation 单调                                                                                                                                                                                                                                                        |
| `continuous-tasks:preflight`  | 新 scoped envelope version=3，绑定同一 GoalRun 和 lifecycle commit；原 preflight 语义保留在内层，由 owner Adapter 解包                                                                                                                                                                                                                                                |
| 原生控制                      | 新 `GoalReadbackFrame`：`version:2, owner:"goal"`，共有身份字段与显式 baseEntryId/baseEntryDigest。A 使用上述 Supervisor wire5，不增加独立的 goal-control 副本；扩展严格 frame 联合、human-ui 的版本检查/framesEqual、owner 控制路由。旧 board/preflight frame V1 原义不变，后续请求 scope 加入 GoalRun 身份，Adapter 对物理 carrier 而非裸内存 body 做回读           |
| ReceiptStore                  | 沿用账本 record 格式和构造器 goalId 参数；新 GoalRun 使用同名独立 ledger，不迁移旧证明至新账本                                                                                                                                                                                                                                                                        |

选择 checkpoint 5 是为避免与停放 recovery-experience 候选所使用的 wire4 语义碰撞；**不是承认/集成 wire4**。本修复基于当前主线，只解码已冻结的 1/2/3 和本方案 5；未纳入实现和验收的 wire4 必须明确拒绝。若日后合并该候选，先统一协议注册和兼容矩阵，不把两种不同格式都叫 wire4。

旧日志只读加载不自动归档、不批量升级。只有真实归档确认产生 A 时才写新格式栅栏；一旦出现 wire5，后续不得降回 wire3 或裸旧 owner 记录。A/B 未闭合时旧 owner 只能保持只读 hold，不能在栅栏之后继续写 legacy 快照。旧 reader 应在 A/C/scoped snapshot 上拒绝写入，而不是忽略新 customType 后继续修改旧板。拒绝必须可通过实际旧版本打开测试证实。

`human-journal` 只新增保留严格匹配的 wire5 交接载荷，不把所有历史 Supervisor data 都加入 RETAINED；goal frame 依赖原生日志已有的完整 entry digest 验证 base，避免为一次交接将大量 legacy inline receipt bodies 留入 NativeAnswer 证明扫描。旧 board/preflight 的 V1 dataDigest 核验不改变。

原 `goalIdentity` 的旧摘要 preimage 不变；新增仅用于 wire5 的 `receiptScopeIdentity`，精确采用 `digest(["goal-lifecycle-v1", goalRunId, goalIdentity(legacyCompatibleState)])`，不能修改旧函数后重算历史导致 v1/v2 兼容证据失效。`readSupervisorStartRecord` 仍要求新启动没有继承 receipts/pending captures；不要为支持 archive 放宽它。

## 9. Session 恢复与历史 UI

恢复顺序改为：读取并验证生命周期选择与 planning/stop action → 验证/投影当前 scoped board/preflight → 恢复存在时的 Supervisor/receipt views → 再开放工具、事件和 UI。legacy 无 lifecycle 时走原严格恢复路径；A 后无 C 时只保留旧源的只读 hold。scoped planning 恢复可保留 interrupted，但必须同时提供 §4.4 的显式重规划/结束入口；已确认 stop-unstarted 则优先呈现 GoalRun stopped，不能因原 preflight planning/interrupted 复活或锁死目标。规划阶段（含 prepared 尝试）和 stopped 均持有 lifecycle 执行门禁，不能因为没有 Supervisor 就落入旧的 board-only 自动继续路径。恢复函数本身不发起模型 turn。

所有异步规划、advisor、tool capture/result、executor 通知和 UI 发布都捕获 GoalRun lease（Session、goalRunId、lifecycleCommitId、runtime epoch；规划还含 attemptId/preflightId），await 后复验。旧回调不得写新板、满足新任务、接受旧批准或重新发布旧驻留 UI。迟到/未知结果保留诊断，不能作为新目标成功证据，也不能自动重跑旧工具。

历史入口：

- `status` 区分当前目标、交接 pending/技术 hold、规划尝试及派发事实、当前授权与只读历史数量。无 Supervisor 的 interrupted/prepared 目标给出准确的显式 `preflight`/`stop` 指引；未知尝试显示具体 hold，不推荐 recover/revoke/clear。
- `tasks`/完整看板增加“目标历史”入口；`history` 分页列出目标身份、原始末状态、任务分布和资源用量；历史详情明确只读。
- 历史详情按 archive 引用显示原目标、原任务/证据/授权/额度。禁止在历史页面操作 resume/recover/approve/start；不能把 archived rendering 塞回 runtime。
- 日常 `captureUiSummary` 只取当前捕获和缓存的有界元数据，不扫描/水合全部历史，不让档案数量重新撑起 stopped 驻留 UI；规划中的新目标则正常显示。
- 对话上下文原样保留。新增明确的目标交接说明，告诉 Main 当前归属；不把旧历史提示当成新指令、许可或证据，不将全部旧证明灌入 advisor packet。

启动时构建的 archive locator/index 随目标数线性增长，原 Pi 日志也保持线性；不声称全 Session 常量内存。当前 receipt raw cache 继续受既有 entries/bytes 上限约束。历史内容按需读取，分页不克隆整个会话；新增记录/材料沿用有界、安全终端文本处理。

## 10. 实现落点和分期

一个 Main writer 负责共享写集，不并发改同一工作树；implementation 必须另建固定基线工作树。本设计工作树不承担运行实现。

| 阶段              | 主要 symbols/文件                                                                                                                                  | 独立产物/退出条件                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D0 固定合同       | `goal-lifecycle.ts` 的类型/Interface；`human-journal.ts` 协议 schema                                                                               | 版本、scope preimage、A/B/C、旧 reader 拒绝及资格表冻结；现有案例 RED-capable fixture；Full readiness packet 完成                        |
| D1 owner 与恢复   | `requestGoalTransition`、`replanCurrentGoal`、`stopCurrentGoal`、`restoreGoalLifecycle`；`runtime.ts`、`state.ts`、`supervisor.ts`、`preflight.ts` | 无模型/业务派发的 archive+new seed、同一目标重规划/无 Supervisor 停止 owner；attempt/claim/stop 逐切点持久化；legacy 1/2/3 只读兼容      |
| D2 原生入口       | `commands.startGoal/routeStart`、`beginPreflight`、`human-control.ts`、`human-ui.ts`、`human-journal.ts`                                           | 真实来源的归档确认；`preflight`/`stop` 先识别当前 scoped GoalRun；共享资格、复验和唯一 claim-before-send 只读规划派发，审批/start 仍独立 |
| D3 目标隔离与历史 | `events.ts`、`flow.ts`、`receipt-store.ts`、`ui-capture.ts`、`ui-view.ts`、`board-view.ts`、`board-ui.ts`                                          | 全部读写归当前 GoalRun；只读历史分页；旧回调、旧 taskId/receipt/answer 拒绝污染                                                          |
| D4 fan-in         | `src/__tests__/goal-lifecycle*.test.ts`、既有 owner/receipt/UI 测试、`test/*smoke*`、README/CANARY                                                 | 同一 frozen candidate 的完整 gates、实际 CLI 来源路径、旧 reader 和故障矩阵、独立审查后交付                                              |

D1 的离线 owner 可以先测，不应等待 UI 完成；D3 的只读 renderer 可使用冻结 DTO，但不能与 D1/D2 同时写共享恢复/owner 文件。每阶段完成更新验收，不把阶段派发、设计通过或部分 PASS 宣称为功能完成。

预计 shared write set：上述生产文件及 `types.ts`/`validation.ts`（scoped carrier）、对应 tests。D0 必须用源码图枚举全部 snapshot/preflight/Supervisor append 与 restore 调用点；遗漏直接 append 是 NOT_READY，不能让 writer 现场选择归属或保留无 scope 捷径。

## 11. 验收与拒绝矩阵

| 场景                                                                                | 必须观察到的结果                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本例 stopped + paused + 4/1/7，全部实时 guard 通过                                  | 原会话中 native archive→新 planning；旧状态与证据字节不改，新板空、新 ID/权限范围、新账本，未执行旧任务                                                                                       |
| completed 目标转新目标                                                              | 旧验收及完成状态可查；新目标不自动 accepted                                                                                                                                                   |
| 连续 A→B→C；A/C 文本相同；taskId 重复                                               | 独立 GoalRun/ledger/control scopes，只有一个当前目标；历史均可查                                                                                                                              |
| 新目标第一次启动                                                                    | 无继承 receipts/pending/bindings/approval/start/externalWait；成功证据仍须真实匹配当前 review/epoch，command 必须 structured exit_code=0                                                      |
| 真实 decision、未决授权、repair、receipt pending、external refs、忙/foreign/unknown | no C、无派发、旧板不变；具体 blocker 可见，不要求用户批准证据缺口                                                                                                                             |
| 否决/关闭/超时/取消/来源不支持/伪 TTY/SDK/RPC                                       | 不产生有效归档控制；无新当前目标、无运行；native answer 不可由 JSON/聊天替代                                                                                                                  |
| 分支切换、未来/兄弟记录、同 digest 错前驱、首次 C 冲突                              | 严格拒绝闭合，不覆盖更新状态                                                                                                                                                                  |
| 每个 append 前后 throw、零写入、真实写入后 throw/丢 ACK                             | 状态符合第 7 节；没有提前发布成功、重复 C、自动 replay 或丢失旧历史                                                                                                                           |
| 会话 reopen/tree/compaction/shutdown，各阶段中断                                    | 从物理分支恢复正确 owner 或明确 hold；不自动启动旧/新业务，也不重复规划派发                                                                                                                   |
| C 后无 proposal、无 Supervisor，重开后显式 `preflight`                              | 正确区分 prepared/interrupted/unknown；经未派发/收敛证据允许后，在同一 goalRunId 建立新 attempt/preflightId，仅发送一次只读规划；丢失的纯规划结果不伪造，业务/宿主活动未知继续 hold，不重复 C |
| 无 proposal 的 planning，显式 `stop` 后开始下一目标                                 | 不依赖 Supervisor/planId/proposal；确认 stopped/closed-unstarted，旧内容和额度保留，下一次归档正常可达；无假 revoke/假 Supervisor                                                             |
| 重复 `supervise`、在途时重复 `preflight`、重复 `stop`                               | 不重复归档、分配 GoalRun、重复 claim/send 或停止写入；不因命令重试清掉真实门禁                                                                                                                |
| 同一目标多次显式重规划、旧 attempt 的迟到 proposal                                  | goalRunId/lifecycleCommitId 不变，attempt/preflightId 更新；旧答复/结果拒绝，不增加业务许可或 reset 计数                                                                                      |
| planning claim/send/observe 与 stop 每个写入/ACK 切点                               | prepared 与可能已发送严格区分；仅物理确认后发布状态；缓存修复不自动发送；纯规划丢失结果须在正面收敛证据下保持 unknown 后关闭，业务未知仍 hold；stop/replan 的旧结果不覆盖新 attempt           |
| 无 Supervisor 但有 first-start、真实审批、业务/宿主活动 unknown、repair、foreign    | 重规划/无监督停止不把缺失当 not-created，不批准/撤销请求、不忽略独立 fault；显示原 owner 的真实阻断                                                                                           |
| 旧 callback、旧回执、旧 approval/start、同名任务返回                                | 不接受为新 GoalRun 证据或权限，不计入新验收；必要的不确定性保持可见                                                                                                                           |
| scoped cache 缺失/更新/跨目标串入；A/B 成功 C/缓存失败                              | 缓存不能选目标、授予权限或要求重复审批；只按精确 authority 修复，更新目标不被覆盖                                                                                                             |
| legacy v1/v2/v3 与饱和/损坏/缺记录输入                                              | 严格旧规则保留；不重写批次、自动迁移或伪造 gap barrier；不认识的 wire4 明确拒绝                                                                                                               |
| 旧 reader 打开 A/C/后续日志；正常取消后打开旧日志                                   | 前者实际拒绝写入；正常取消没有 A 时旧日志未升级。不能只拿 schema 单测当降级安全证据                                                                                                           |
| 日常 UI/历史浏览/RPC、用户对话                                                      | 不改任务/计数/授权/选择，不打开新模型 turn；历史和其他扩展状态不被清除                                                                                                                        |

验证分层：先用一个目标转换的小样例跑通真实代码路径及失败输出，再扩到连续多目标、故障矩阵和大历史。静态检查、lint、format、完整 coverage≥90% 和全部既有 smoke 是 unchanged gates；实际 CLI/PTY、SDK double-TTY 否定、冷源加载/重开、旧 reader 测试分别记录，faux-provider/UI stub 不冒充真实终端或业务执行验收。

资源采样覆盖 1→10→100 个目标、以及原有 100/1000/5000 receipt 规模；先小样例再扩展，区分 locator 元数据、raw cache 与整个日志增长，不编造磁盘吞吐/fsync 或进程活性保证。

## 12. 选择理由、非目标与交付门槛

选择统一 owner + 已有原生日志/回读，而不是删 guard、调用 clear 或增加一套数据库。归档原始引用比复制 receipt/body 更少漂移；单个当前目标比并行活动目标更小且符合本次需求。旧记录不被重新解释为新证据。

非目标：并行目标、自动重启 archived 目标、回滚业务副作用、自动杀外部进程、历史目标修改/合并、跨 Session 证据迁移、放宽来源校验、重复资源审批、自动 reset 旧预算，以及本轮安装/发布。

**文档交付不等于 READY_TO_CODE 或实施授权。** 实施前由 Main 完成 D0 的 Full readiness packet，冻结 exact schemas/write set/fixtures，确认版本与 source/SDK 能力，再取得实施范围授权。实现阶段必须经独立的安全/兼容/失败切点审查；审查工具若不可用，要明确报告，不将曾经的设计/CLI 审查授权挪用到本功能。本次文档修订未启动第二轮审阅；既有独立审阅及限制见 §13。

最终接受仅绑定同一冻结源树：完整验证通过、独立审查问题处置完成、源与配置/旧会话/其他工作树保护检查通过、可回放 diff/pack 清单齐全。未获单独授权前不修改业务会话、不强制 reload、不安装、不提交/合并/推送；上次 footer 修复的 push 授权不延伸到本方案。

## 13. P1-1 修订记录与验证边界

本次按用户“修订”授权，补充了 §4.2/4.4 的用户入口、§5 的两个当前目标 owner 动作、§6/7.4 的 planning attempt/claim-before-send、§7.1/7.3 的资格和故障恢复、§8/9 的无 Supervisor 停止状态与恢复投影，以及 §10/11 的实现/验收要求；术语同步说明停止面向目标而非 Supervisor 的存在性。

原独立审阅针对设计 SHA256 `73717078a8001580a0db975b7857036651dbdc0b6a8720d0156b7e71723210c0`，报告 SHA256 `77e79658eaaf0f83009a59665164bf73e3187426cf21f7c7db7e14be265eed9c`，结论为 BLOCK。原报告、输入快照、设置探针失败和正式运行审计限制均保留，不改写成 PASS。

当前处置是“**P1-1 已补充设计契约，Main 自检，待独立复审**”，不是已经实现/通过恢复测试或独立审阅。仅验证文档格式、链接、源码依据与保护范围；本轮未发起第二次 CLI 审阅，未实施或修改目标会话。
