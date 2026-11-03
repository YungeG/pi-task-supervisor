# B：原控制的事件外交互与唯一交接实施约束

2026-11-02 · v1 · 2026-11-03 收束：**独立设计 READY；B R3 最终独立实现 OK，Main 核对同指纹与关键回归后接受完整本地候选。** H0 隔离候选已接受，但本 packet 不把它等同于 B 或整体完成。

## 1. 结果、依据与依赖

完整结果仍是[路线图](supervisor-human-interaction-repair-plan.md) §4.1：支持范围内首次权限、独立 Start、决定/信息、准备后的具体定义、scope 审核及明确恢复均可原生操作，不需输入审批命令。审核、恢复、派发的效果不能混合。

| ID | 依据 | 必须保留 |
| --- | --- | --- |
| B1 | 路线图 §3、§4.1、§4.4 | 权限≠Start；定义/scope 元数据≠恢复/执行；恢复是命令等价控制，不新增批准 kind |
| B2 | 路线图 §5.2–5.3；已接受 H0 | 所有新交互由公开可取消 lease 承接；实际 dispatch 前重新资格；未知不重放 |
| B3 | `preflight-human.ts / permission, startApprovedPreflight`，`board-human.ts / answerBoardDecision` | 原 NativeAnswer、scope/request binding、A+B 物理回读和投影故障优先级 |
| B4 | `acceptance-runtime.ts / reviewAcceptanceContract`，`scope-revision.ts / reviewScopeRevision` | 原完整材料、当前文件/环境版本、原 owner、容量及原见证，不自动编译/采用 scope/恢复 |
| B5 | `commands.ts / continueNow, resume, startGoal`，`supervisor.ts / recoverSupervisor` | 原控制检查、旧命令效果、独立 board/Supervisor hold、实际执行结算及已用 reviews/continuations/tokens/cost |
| B6 | `runtime.ts / scopedAPI` | H0 延后调用的 run/isCurrent/validate/result handler 也绑定原 TaskRuntime，不能落入 test/global/另一 Session |
| B7 | `pending-ui.ts`、路线图 §4.3 | 原事实派生待办；稍后/拒绝不自动重问；冷恢复只恢复入口；不另存批准或第二业务队列 |
| B8 | `human-ui.ts / isTrustedLocalTui` | 原真实 argv/TTY/package resolution 不变；RPC/SDK/复制回答不是新增可信批准前端 |

H0 固定依赖：`/home/ygguo/agent-projs/pi-human-interaction-host`，base v1.4.0 `4a080252f06caf63a525d7873c5d94d3c23887e0`，13 文件候选 `066b21cda79bd3ea2a12840243c428bfb525c1c21fc8f3442d5d281f400434a1`、九源指纹 `db154401d52c563420fc1fd09dc9ac1f5878f0619653432c6346521b7e96913c`。独立实现 OK、Main 复核同指纹及 16 项测试后接受，见[验证](supervisor-human-interaction-h0-validation.md)。**本 packet 不修改已接受宿主。**

当前主仓库 HEAD 仍非完整候选；保留既有未提交 guidance/resource-scope/final-review 改动，不 reset/stash/清理。单写者 Main。用户已有本地实现/隔离验证授权；没有安装/发布/提交、重载或业务会话控制授权。

## 2. 已核实的接入障碍与选定实现

### 2.1 不能直接把旧命令函数放入 lease

具体 trace：`startApprovedPreflight` 保存原 Start 后调用 `supervisorNotice` → `pi.sendMessage(triggerTurn:false)`，又调用 `updateActiveTools` → `pi.setActiveTools`。H0 正确地把这些旧输入/native-control 调用识别为 action 自调用并失败关闭。`holdSupervisor`/恢复错误路径也会通知；只换正常路径并不够。

选定方案，不扩 H0：

1. 原控制/物理写入继续使用原函数；命令专属 `waitForIdle` 留在 command adapter。
2. leased 控制用最小 adapter：**阻塞 UI 仍委托实际 lease UI**；只把 notify/setStatus/setWidget 委托同源普通 context 的 guarded UI，作为非授权展示且最佳努力。mode、hasUI、manager、signal、isIdle、hasPendingMessages 的原 guarded getters 不覆盖。阻塞 UI wrapper 只附加“本控制已进入呈现”的去重观察，不改选择或答案。
3. 控制用 `pi` adapter **仅截获**原 `continuous-tasks:notice` + display=true + triggerTurn=false + string content，改作普通 UI 通知；任何其他 sendMessage 都抛错，绝不发送或隐式转队列。其余方法保留原 scoped API，native setter 仍受 H0 自调用保护。
4. Start 增加内部 `deferToolActivation` 选项：原激活事实仍按原数据保存，只延后 `setActiveTools`。默认命令路径不延后。
5. B 仅为本次已保存原 Start 的 defer 效果保留一个 `deferredTools={stableOwner,startControlRef,prepareFailure?}` 标记；没有待执行 payload、timer 或自动派发。实际 `before_agent_start` 普通回调只在存在同源标记、原 `continuous-tasks:continue` custom trigger、真实当前 supervised/active owner 和原 Start/权限/模式仍有效时，按原 `updateActiveTools` 规则补齐工具；成功即删除，相同列表不 setter。这样不重置其他旧命令/用户自己选择的工具。它在 logical-start 后、provider 前执行。**消息 customType/details 本身不授予权限或创建标记**。取消后的标记也不启动工作，只能等另一次原资格通过的明确恢复/继续；冷启动原 restoreSessionScope 自行重建工具，不重放本标记。

不采用：临时改 argv/TTY/native 信任、把旧 send 全吞掉、在 action 中伪装普通 callback、两段 lease 间丢失输入代际、在 callback 外“稍后补派”、新增 host prepare API 或持久 UI intent。

### 2.2 source predicate 不能把原控制自己的写入当作外部变化

原 `prepareRequest` 会生成问题 ID、改 humanEpoch/请求快照；Start 会保存 Supervisor 并采用原管理 owner；scope 审核会产生新 revision。若 H0 predicate 固定整个 preflight/board/humanEpoch，原合法写入之后的 UI 刷新会错误变 stale。

H0 predicate 只守住不可跨越的**同一 TaskRuntime/manager/Session、goalEpoch、GoalRun/lifecycle/planning attempt、管理模式家族与原 branch ancestor**。不以当前 transcript leaf、mutable humanEpoch、whole-board digest 或当前 scope revision 作为 lease-wide predicate。每个原控制在入口和原 NativeAnswer/current/publisher 中继续严格守住自己的请求、材料、版本、hold；派发另绑定控制后的确切原事实。

这不是放宽材料验证：permission/Start/board/definition/scope 都仍由原 frame/current/WeakMap/物理 witness 决定，不能因为 host lease 存在就跳过它们。

### 2.3 精确身份与哈希闭合

不把指针序列化或当成批准。`HumanOwnerBinding` 保留 runtime/manager 对象引用（仅比较 ===），以及 sessionId、goalEpoch、goalRunId/lifecycleCommitId、planningAttemptId、管理模式家族、实际 branchAnchor。字段缺失仍是明确的 null/undefined，不伪造 owner。

| 值 | 固定 preimage / 语义 | 使用者 |
| --- | --- | --- |
| stableOwnerKey | `[sessionId, goalEpoch, GoalRun/lifecycle/planning IDs, modeFamily, preflightId 或 task-board WorkOwnerKey]` 的 journalDigest；对应对象引用另行相等检查 | H0 source predicate、短命状态归属 |
| H0 binding | `[stableOwnerKey, kind, 原 request/proposal/control ref 的 entryId+digest, material parent ref/digest]` 的 SHA-256 | 宿主一次尝试，不是 NativeAnswer |
| parent mute key | `[stableOwnerKey, kind, preflight attempt / decision / 原 previous contract+revision refs]` 的 journalDigest；不包含新随机问题 ID 或普通 transcript leaf | 同 parent 不自动重问 |
| before/after state stamp | 当前实际 WorkOwner、mode record ref、原 board、preflight、Supervisor（含已用 counters）、当前 contract/scope refs 的 journalDigest；不包含展示诊断 cache。after 只能在原核心成功/物理回读后采集 | 恢复确认前后、派发资格冻结；不是可传入的授权 DTO |
| confirmed control refs | 原核心 result.confirmed 的 controlEntryId，再由实际 journal 取 digest；定义/scope 用原返回 ref。projectionPending/缺 ref 不能自造 | cancellation 后保留事实、准备失败关联 |

ContinuationCandidate.current 重新调用同一真实资格/当前 payload，并比较其 stamp 与 payload digest；只读事实变化即失效，不通过改写原对象刷新 stamp。

## 3. 固定类型与接口

### 3.1 `src/host-idle.ts`（新增，小型宿主 adapter）

- 本地只读定义与已接受 H0 v1 同形的 API/handle/lease/result 类型，避免把 peer 从 1.1 偷改为 1.4；`getIdleActions(ctx): IdleActionAPI | undefined` 仅认可 version=1 及必需函数形状，陈旧 getter/未知 shape 失败关闭。
- `idleControlContext(origin, lease, onBlockingUI): ExtensionContext`：从 leased context 的 descriptors 构造，按 §2.1 仅覆盖 ui 的非授权显示适配；五种阻塞方法最终调用原 leased 方法。原 signal/manager/模式/idle/pending 不伪造。
- `idleControlApi(pi, origin): ExtensionAPI`：按 §2.1 做唯一 notice 特例，其他 sendMessage 一律失败；不注册任何新 model tool。
- 不解析命令文本、不保存 NativeAnswer、不实现宿主队列。

### 3.2 `runtime.ts / bindRuntimeCallback`（新增函数）

`bindRuntimeCallback<TArgs extends unknown[], TResult>(callback: (...args: TArgs) => TResult): (...args: TArgs) => TResult` 捕获调用时的 TaskRuntime，只对当前模块 ALS 做 `storage.run`。H0 request 的 run/isCurrent、dispatch.validate 和 result reaction 全使用它；现有 scopedAPI 行为不改。

### 3.3 `src/session-controls.ts`（新增，原命令/原生交互的共享控制核心）

| 接口 | 精确责任/返回值 |
| --- | --- |
| `continuationCandidate(ctx)` | 保留当前 commands.continueNow 的全部资格：management boundary、goal/preflight association、flow idle/pending/journal/preflight/receipt、原 hold/外部执行/预算/stagnant、board gate、已占用 executionRef、actionable work。无资格返回 undefined；有资格返回 `{message, current():boolean}`。message 为原 continue payload 副本；current 重跑同一资格并比较原 owner/control/board/预算事实及 payload digest，不发送、不计新用量 |
| `adoptStartedGoal(pi,ctx)` | 提取 startGoal 在原 Start 成功后的 adoptSupervisedMode、config receiptCache、adoptPreflightAcceptance；不派发、不自行恢复，不改变原异常优先级 |
| `resumeBoardControl(pi,ctx)` | 提取原 resume 的检查、精确 Supervisor/board 写入和 rollback/fault 处理；返回 `resumed / board_only / review_only / unchanged`，不派发。保留原 resumePausedFinalReview 的早退；B 不把 completed/final-review 控制作为新业务恢复入口 |
| `pauseBoard(pi,ctx,reason,cause)` | 从 events 原样提取，继续使用 `pause_controller` 和原 holdSupervisor；供旧控制器及 B 失败收束共用 |
| `retainHumanDelivery(pi,ctx,source,result)` | 仅当同一实际 owner 仍当前且本次已保存可执行控制、未确认 logical-start 时，使用原 pause_controller/holdSupervisor 留住未派发/未知结果；不覆盖已经存在的独立用户暂停/stronger hold，不回滚批准或 Start、不 refund 用量。来源未知/ctx 已失效时不向新 owner 写入，不伪造检查通过 |

`commands.continueNow` 成为 candidate + 原 pi.sendMessage 的旧 adapter；B 使用 candidate + lease.dispatch。命令的通知、等待及原旧宿主限制不被认证为 H0。

### 3.4 原控制接口的最小调整

- `preflight-human.ts / idle, approvePreflight, startApprovedPreflight` 接受 ExtensionContext（无 command cast）；现有 idle/原控制检查保留。Start 最后增加内部 options `{deferToolActivation?: boolean}`，默认 false；B true 时仍通知/保存 activation 元数据，跳过 native setter。将原 validateBundleBeforeStart 以 `assertPreflightStartMaterial(ctx,base): void` 命名共享；旧调用位置不变，B 首次 Start 的 dispatch.validate 再用同一逻辑核对刚确认的当前材料。后续恢复/定义绑定不误把已批 preparation 的旧 pending capture 当成必须重批业务许可。
- `scope.ts / enableSessionScope` 支持同一 defer 选项；提取 `scopedActiveTools(pi,value): string[]` 的原工具列表计算供 updateActiveTools 和 `reconcileActiveTools(pi,value): void` 共用，后者相同列表时不 setter。只有原事实投影，不是新权限或新用户工具。
- `reviewAcceptanceContract`、`reviewScopeRevision` 保留旧 ExtensionCommandContext wrapper 及 wait；新增 `reviewAcceptanceContractNow(pi,ctx,id)`、`reviewScopeRevisionNow(pi,ctx,id)` 作为同一原代码的事件外核心。原 native utility 已合并 ctx.signal，lease 取消贯穿原问答/见证；不另造回答 DTO。
- `answerBoardDecision` 原接口/效果保留；由 B 传同源 leased adapter 和原 signal。
- `human-ui.ts` 仅提取现有 activeQuestions + suspend/release 为共享 `withNativeUiLock<T>(ctx, run): Promise<{status:"busy"|"display_unavailable"}|{status:"done";value:T}>`；先安装锁，再进入原微任务内的 suspend/readonly-view cleanup，finally release。map 的 promise 值可泛化为 unknown，但 `answerRegistry` 及答案校验不放宽。原 NativeAnswer 路径仍在外层保留 admission、frame、branch、current、signal、诊断和物理验证。新恢复确认复用锁，自己保留 trusted/current/signal 前后检查，不产生 NativeAnswer 或新的 humanInteraction kind。

### 3.5 `src/idle-human.ts`（新增，有限原生控制衔接）

内部 sealed descriptor，只含 kind/原 source refs/展示材料，不含 approved/confirmed 之类输入；没有注册器或第二批准库。

支持 kind：permissions、preflight-definitions、first-start、board-decision、contract-definition、scope-review、resume-board、recover-supervisor。每种直接调用上面的具体原核心，不解释 descriptor.command 字符串。

`reconcileHumanContinuationTools(pi,event,ctx): void` 在现有 before_agent_start handler 开始处调用。仅处理已登记的同源 deferredTools 标记，认可 H0 v1、原可信本机 TUI 和 custom `continuous-tasks:continue` trigger；读取真实当前 supervised/active Goal/preflight，使用 `preflight.startRequest.id` 的 `inspectConfirmedPreflightProjection`，要求其 start control 与标记的 startControlRef、`preflight.started.controlEntryId`、原 approval/binding 对应，无 projection/owner/journal 异常。它不调用需要 idle=true 的 continuationCandidate，不把 incoming details 当权力；仅在列表不同时 setActiveTools，成功清除标记，不能修改批准/Start/预算或发送新工作。旧 host、无标记或不匹配实际事实时直接返回，不恢复已被暂停/撤销的控制。若事实原本合格但 native 工具投影抛错，不能依赖 Runner 吞异常后继续：在标记（及仍匹配的 correlation）记 prepareFailure，调用原 ctx.abort() 阻止 provider 工作并保留原技术 hold；不把这个中止说成用户拒绝。

`requestIdleHuman(pi,ctx,origin: "automatic" | "shortcut")` 的内部过程：

1. 特性与真实本机 TUI 资格成立才进入 B；旧/未知宿主保持 A-only。
2. 采集稳定 owner、分支 ancestor 和原控制 refs，建立 SHA-256 binding + 新 UUID。手动入口先看公开 phase/pending：忙/已有问题只通知，不 abort、不请求以后自动补开。
3. 向 H0 单槽 request 注册 runtime-bound callback。自动来源只能在现有 settled 对账完成后注册，不在事件中问/保存/派发。
4. callback 再核对原 descriptor 仍当前，使用真实 lease 派生的 control context/API。手动入口可先选待办，再单独进入完整原控制。
5. permissions 若原结果 approved、无 projection/startup pending、required grants 完整且原 approvalAction 为 start，可在**同一 lease**自动呈现独立原 Start；仍是两个原 request/frame、两次明确选择。partial/reject/Later/未知不进入 Start。
6. Start/已解决 board gate/明确恢复仅在原 continuationCandidate 允许时调用一次 `lease.dispatch(message, validate)`；validate 同时核对 lease、当前 owner、控制后原 refs、完整候选及原当前 evidence capability。validator 不写业务事实、不调用发送/setter。
7. 定义/scope、拒绝、投影待修复、缺材料/未知执行一律零派发。已保存执行控制但 dispatch 取消/拒绝/unknown 时收束为原 hold，原记录和已用计数保留，绝不收取第二次 Start或自动补派。

## 4. 恢复的精确边界

- private native 函数只接受当前 descriptor，校验 isTrustedLocalTui + lease + 原 sources；不对外接收 confirmed=true 或复制回答。
- 显示并绑定原 board generation/digest、Supervisor status/holdCause/reason、owner、scope refs、用量和执行结算事实。选项明确区分：仅恢复看板、联合解除普通 user_pause、尝试原 recover；不隐式连做。
- 使用共享单问题锁、真实 leased select/custom、原 signal 和 readonly-view 协调。选择后重读同一 refs及原资格才调用 resumeBoardControl/recoverSupervisor 一次。
- B 遇到 activityIssue、receiptIssue、unknown execution/capture、journal/owner unknown 时只诊断，不提供可生效恢复；不借 UI 去 closeUnknown/migrate 原未知事实。原命令保留其显式诊断/修复语义。
- recover 的原 preflight/association/scope/budget/capability 等检查仍执行；正常 resume 与 recover 不合并。保存 scope 仍不采用；只有用户另行明确的 recover 按原逻辑采用。
- 保留 hard limits、已用 reviews/continuations/tokens/cost 和原未知计量。原 recover 的 stagnant/progress 处理不冒称“清零预算”，不新增预算重置入口。
- completed 业务、repair/verify-check/retry-review/revoke/stop 等不扩为新 UI 自动控制，仍保留原显式流程。

## 5. 原事实待办、自动入口与去重

`pending-ui.ts` 在支持 H0 的可信 TUI 分支调用 idle-human；其他情况原 A 只读面板/通知仍原样可用。不会把“来自快捷键”当宿主事件外证明。

### 派生来源

- permissions/start/preflight-definitions：当前预检与原 approvalAction，原 plan/preflight/request refs；不从通知文案或自然语言推断。
- board-decision：原当前 structured decision，排除 legacy/unstructured、已有拒绝及无明确新意图的替代项。原工具内首次呈现保留；本阶段只新增安全重新打开与交接。
- contract-definition：approval-preparation 的原 proposalId，或实际当前 owner 的新完整 proposal ref；用原 review 核心准备验证材料。缺具体文件/条件时是 Main 的准备事项，不出现可批准请求。
- scope-review：原当前 owner 的完整未回应 proposal，前一 contract/revision refs 必须仍匹配；原容量/材料错误只诊断。
- resume/recover：原状态/hold/flow 资格，只允许用户手动明确选择，不自动弹恢复。

### 自动来源的允许集

- 自动仅 first-start（本轮实际完成权限）、首次可审核的准备后定义、首次完整当前 scope proposal。
- 权限/board 的原工具内首次呈现保持原代码；退出后不再由 settled 自动催问，快捷入口可显式重开。
- definition/scope 先在 H0 callback 调用原准备验证，完整后才开问题；未完整且未进入 UI不算用户已看/拒绝，不启动准备 Main。
- 一次 callback 仅作有限上述衔接，无 timer/microtask 猜 idle、轮询、重试队列或隐藏模型轮次。

### 有界运行态

WeakMap 按 TaskRuntime 保存：当前 handle/单条 delivery correlation、一个只含原 Start ref 的 deferredTools 投影标记、bounded shown/muted keys。该标记不是可运行项或派发意图；既有命令正常路径不创建它。最多 4096 去重项，不驱逐旧键，满后关闭自动呈现并保留手动/原命令，不刷新业务预算。

Key 包含真实 Session/manager 对应关系、goalEpoch/GoalRun/lifecycle、控制 kind、原材料 parent refs；不按 transcript leaf 或新随机 requestId 刷新。permissions/Start 的 parent 为原 preflight attempt；scope 的 parent 为原 previous revision/contract。进入阻塞 UI即标记该 parent 已呈现；稍后/退出/拒绝/host cancel/UI error 不自动重问同一 parent，材料换 ID 不清除此标记。显式快捷操作不受自动去重禁止。

session_start、session_tree 在原恢复完成后将已存在的当前 owner 待办 parent 标作历史，包含尚缺文件的 preparation/定义候选，不以 ready=true 才 seed；只恢复入口。shutdown 清理句柄/短命状态。历史已批 Start 不自动开；用户本轮明确批准后新产生的独立 Start 可按原新控制衔接。新本轮 proposal/control 仍从原事实派生。没有回应持久化日志或 UI intent replay。

## 6. 交付相关记录与失败次序

运行态只有一条 correlation：`{attemptId, stableOwner, kind, originalBeforeRefs, verifiedAfterRefs?, startedReceipt?, prepareFailure?}`。它不是 runnable queue，也不持久化。只有原核心返回/物理回读成功才登记 after refs，不通过手工改写原控制对象使验证成立。

- dispatch started 是 H0 logical-start，不是 provider 成功；此后 callback 异常不降级为未派发。
- `before_agent_start` 的原 continue trigger 只按当前真实原控制补齐工具，消息 DTO 不获权限。
- 现有 settled handler 先消费其 `runs.shift()`，再调用 `settleHumanDeliveryFailure(pi,event,ctx): boolean`，位置早于 kernel-run 来源的早退。匹配真实 idleActionFailure 或本 correlation/deferredTools.prepareFailure 时，保持 Start/恢复事实，以原 interrupted/fault hold 表示“logical-start 已确认但准备失败”，不降为未派发、不重派；投影失败的故障关联在消费后清除，但尚未完成的原 Start 工具投影 ref 可等下次明确合法恢复，不自行重试；不要走旧 event.aborted 的“用户中止”文案。首个核对可先匹配已注册 attemptId，收到 runId 后再关联，不假设 result reaction 总比失败事件先运行。普通无关事件返回 false，继续原对账。
- kernel agent_start 后原 run/receipt/settled 继续负责；无 prepareFailure 则清理本次 correlation，有已标记的准备中止则留到对应 settled 消费。result reaction 只更新仍是同一 correlation 的对象，不能把已清理记录重新放回；不影响原已用计量。
- Session/owner 已失效时，不向新 owner 写 hold；旧恢复逻辑仍把未结 active/reviewing 状态留为 interrupted，冷启动不重放。

| 优先 | 条件 | 结果 |
| ---: | --- | --- |
| 1 | 原 journal/witness/projection/来源未知 | 原 repair/hold 优先，不再问同一批准，不降低为普通 deferred |
| 2 | 非可信 TUI / 无合格 H0 | A-only/unsupported，无新写入或派发 |
| 3 | 旧 owner/材料、signal 取消、host pending/foreign UI | 零陈旧控制；已保存原事实不回滚，明确未派发或待核 |
| 4 | 原权限/Start/独立 gate/结算/预算/当前能力不满足 | 原门保持；元数据成功不代表能执行 |
| 5 | 真实独立确认 + 原控制完成 + 最终 H0/domain 资格 | 至多一次逻辑开始；其他结果不自动重放 |

## 7. 固定写集与所有权

Main 为唯一写者。允许：

- 新 `src/host-idle.ts`、`src/session-controls.ts`、`src/idle-human.ts`。
- `src/runtime.ts`：callback binding；`commands.ts`：仅等待/命令 adapter 与上述共享核心接线。
- `src/preflight-human.ts`、`scope.ts`：普通 context、原 Start 材料断言共享及 defer-tool-effect；不重写原批准/Start wire。
- `src/acceptance-runtime.ts`、`scope-revision.ts`：原 review wrapper/Now core 分离，保留原投影/容量/错误语义。
- `src/human-ui.ts`：仅共享原问题锁/显示生命周期供恢复，不放宽答案注册表或信任。
- `src/pending-ui.ts`、`events.ts`：feature-gated 原生入口、历史初始化、原对账后的请求及准备失败收束/工具投影；不改变原工具内首次许可/决定呈现。既有 before_agent_start handler 调用 `reconcileHumanContinuationTools`，既有 settled handler 在 kernel-run 来源早退前处理匹配的 idleActionFailure。
- 新 `src/__tests__/host-idle.test.ts`、`session-controls.test.ts`、`idle-human.test.ts`；扩展原 pending-ui/runtime/preflight-human/board-human/approval-workflow/scope-revision/events/canonical-commands 有关断言，保护既有未提交测试。
- `test/goal-native-fixture.ts`、`test/goal-native-smoke.py`、`test/approval-native-responses.ts`：受控添加 B 场景；README/本路线图/验证文档。

不改已接受 H0、node_modules、锁文件、peer 最低版本、原批准 schemas、预算常量、业务或全局设置。不新增通用 action 注册/调度框架。

## 8. 首个哨兵与接受门

### 顺序

1. 单个 RED：原控制权限记录成功后，H0 请求只在全部 settled handlers 退出时进入独立 Start；旧 host 同样事实仍 A-only 零自动控制。单测不冒充真实 TTY 可信性，原生证明另按下述跨系统门取得。
2. 共用核心原命令回归；H0 callback 中禁止真实旧消息/native setter，notice adapter 只允许展示，Start 工具启用发生在 logical-start 后/请求模型前。
3. 各 kind：metadata success、Later/Esc/拒绝、投影/未知、错误来源、两 runtime/branch、busy/deferred、同一 parent 不自动重问、历史冷恢复。
4. 保存 Start/恢复/board 回应后取消/unknown/准备失败：原事实与用量保留，原 hold，不再收取/补派；定义/scope 始终零派发/恢复。
5. 相关自动测试通过后，完整 `npm run check`，保持原 90% 覆盖率门；定向独立实现审阅及 Main 复核。

### 真实跨系统验证

从原脚本先一个小样再组合；临时只读复制本候选到 owned sandbox，通过实际 package/module resolution 把该副本的 coding-agent peer 指向已接受隔离 H0，**不替换主仓库 peer/全局安装，也不伪造 argv/TTY/trustedCliRoots**。记录真实 pair roots、源哈希、session/按键和物理 controls/witness。

必测：权限→独立 Start 无命令唯一 run；preparation 后完整 definition 自动审核且暂停/权限/Start/用量不变；scope 自动审核不采用/恢复，随后手动独立 resume/recover 仅原资格通过才唯一派发；board choice/information 重新处理；冷启动旧待办不自动开；GUI中竞争输入、更晚 settled handler/async validate 取消、已保存 Start 后取消/准备失败、重复/未知零重放；旧 1.1/无 H0 的 A-only 样本和原命令兼容。

模型与按键为合成离线夹具，不是业务批准或验收。原业务 session 不用于测试。缺失项明确 GAP，不以 mocked NativeAnswer/SDK UI 通过替代。

## 9. 审阅门与执行状态

**READY：独立设计复审无 blocker，Main 已核实并接受设计门；不需要新用户授权。** [原始报告](supervisor-human-interaction-b-design-review.md)保留；该结果不当作实现或原生验证。 重点审阅 §2 的 effect adapter/延期工具投影、稳定 owner与每控制严格材料的分工、取消后原 hold、恢复未知边界、自动去重及原命令兼容。Main 已按 §8 首个 RED 在同一写集内实现；验证见下节。不重新要求用户批准已授权本地范围。

B 或整体 Goal 只有完整矩阵、原生证据、独立实现接受和逐项审计完成后才能记完成。H0 已接受不是替代项。

## 10. 实现收束说明（不是接受替代）

- 符号按固定写集落地。新增桥接/共享控制/有限交互控制器，无新批准 schema、依赖、队列或 host 改动。
- RED 发现保留的 v2 记录可能没有 `approvalFlow`：不能让“仅定义审核”走 `approvePreflight` 的权限分支。最小收束是导出原 `reviewPreflightDefinitions` 核心，B 的定义 kind 直接调用；旧命令语义不变，原 grant 不替换、无 Start/dispatch。
- RED 发现部分批准后只传已批 IDs 会永远漏掉原计划其余必需项。B 权限选择显式包含**原已批 IDs + 当前原计划 required IDs + 原 preparation IDs**；不加入未选的 optional 项，仍须完整原生核对/确认后由原核心发布，仍另问 Start。
- 工具投影失败由 `ctx.abort()` 阻止 provider。真实宿主可能已记录 custom continuation 并发出 kernel `agent_start`，随后 `agent_settled.aborted=true`，但零新增 provider 调用；不可把已 logical-start 的事件说成“从未派发”或重试。B 保留故障关联直到该 settlement，原 Start、权限与预算不回滚。另有真正的 pre-kernel preparation throw 独立样本。
- [B 验证记录](supervisor-human-interaction-b-validation.md)区分单测、SDK stub、真实 CLI/TTY、合成模型/按键及本地实现接受边界。独立实现门未通过前不宣称整体完成。

### R2：独立实现 BLOCK 后的精确修复（Main 单写，原授权内）

三项 P1 见[原始实现报告](supervisor-human-interaction-b-implementation-review.md)。不扩批准/恢复语义，不改冻结 H0。

1. `idle-human.identity` 对 tasks 家族加入原 `currentWorkOwner(sessionId)`；supervised 家族仍允许本控制合法的 planning→Start 归属变化。测试经原 tasks-only/write/compile/resume 入口，在 dispatch 未知结果前实际替换 owner，要求旧 callback/result 零后续写入。
2. `recoveryBlocked` 在派生、呈现前和确认后直接检查 `captureManagementSnapshot` 的 active 状态、非空同源 owner、identity/invocation/journal integrity，并复用原 `management-policy.writerAttention` 的执行/capture 检查；仅增加该原只读 checker 的导出（固定写集在此扩一项），不改旧命令调用或判断。保留原 flow/domain 门。
3. `confirmRecovery` 在共享锁内先用原 `human-ui.reviewScope` 只读完整分页查看当前恢复 facts，再作独立 native select。仅导出原 reader，不创建 NativeAnswer/kind。显示 board generation/digest、原 owner、Supervisor 原 hold/reason/已用 counters、contract/revision/拟采用 scope refs 和执行/capture 结算；同时绑定完整 facts 与原 humanStateStamp，读完/确认后重核。board-only、普通联合恢复、recover/adopt 的效果必须分别明示，缺失数据明示未知，不借隐藏 widget 代替。

已有公共 seam/原生 harness 为原批准范围；先失败测试，再最小修改，完整检查与受影响原生样本重跑，重新独立接受。H0/A 接受及旧候选证据保留，旧 manifest 不冒充修复后候选。

### R3：材料必须使用原 owner-aware 契约选择器

[R2 独立复审](supervisor-human-interaction-b-implementation-review-followup.md)已闭合 owner 与 recovery safety 两项 P1；材料一项仍因 `contracts.at(-1)` 会选历史 Goal 契约而 BLOCK。当前唯一生产修正：`recoveryScope` 用实际 `currentWorkOwner(sessionId)` 和原 `selectedAcceptanceContract(view,owner)`，不重写 selector，也不使用仅有 scope proposal 才存在的 `source.owner`。保留 Goal→disable→tasks-only 的真实历史，原工具创建/编译/暂停新看板，先 RED 后验证旧契约未显示、当前缺失明确未知。原批准/恢复/dispatch/预算及 H0 均不改；重新完整检查及原生材料流程后，[最终复审](supervisor-human-interaction-b-implementation-review-final.md)确认 CLOSED / OK，Main 同指纹和 17 项关键回归复核后接受。详见[最终验证与路线图审计](supervisor-human-interaction-b-validation.md#9-main-最终逐项审计与本轮完成边界)。
