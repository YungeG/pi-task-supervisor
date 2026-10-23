# 日志增长与恢复读取：Full Implementation Packet

状态：**READY — 仅表示实施合同已冻结；阶段 A/B 尚未实现，最终验收尚未完成。**

## 1. 授权、身份和批次

- C1：用户在方案复审完成后明确要求“新开一个 worktree，按照计划推进至完成”，授权本工作树中的 A/B 修复及方案要求的验证。
- C2：[已复审修复方案](supervisor-journal-growth-and-restore-repair-plan.md)，最终文档 SHA-256 `5c8dd321218b37ae2ef9827f034e5b53f9a7892e852ecab765a7a6b04939aa03`，W1–W4、R1–R9、G1 为验收源。该文档的“未批准实施”是此前审阅时状态；本节记录后来明确的用户实施授权，不回写或伪造此前的审批历史。
- C3：`CONTEXT.md`、现有 goal/preflight/receipt 合同及负向测试继续约束身份、授权、因果版本、故障优先级和不自动重放。
- 实施基线 HEAD：`3c19f559a9dc1378e34ad3a140b589cb1707c28e`。准备期间 main 外部新增了该状态发布修复；已审方案的 `5aa8b71` 为诊断基线，不冒充当前源码。
- 当前分支：`fix/supervisor-journal-growth-restore-current-main`。最初准备分支 `fix/supervisor-journal-growth-restore` 保留在 `5aa8b71`，无本任务提交、无活动 writer。此处仅在尚无源码改动的独立 worktree 创建/切换新分支，没有 merge、改写提交或修改 main。
- Worktree：`/home/ygguo/agent-projs/agent-ext/pi-task-supervisor-worktrees/journal-growth-restore`。
- 单一写入者/最终接受者：主控；后续独立 reviewer 只读。未派发实现 writer，不存在本工作树的重复执行引用。
- 本批为 t-1.1：工作树、合同、基线冒烟与哨兵复现。阶段 A、B、完整验证、最终审阅分别由 t-2.1 至 t-5.1 承担。本批完成后先正常结束当前 run，不继续领取下一批。
- 排除：提交、push、merge、安装、真实日志迁移、生产会话 reload、账本 wire 变更和方案 C。它们仍需单独授权。

## 2. 已保护的状态与基线检查

本任务不修改原仓库 main；未跟踪 `.pi/` 和原始方案保留。准备期间另一项工作将 main 从 `5aa8b71` 更新为 `3c19f55`，其 `state.ts/status-ui.ts/supervisor.ts` 和 UI 回归必须保留。主控先记录这次外部变化，再将无源码改动的独立 worktree 切到新基线，不能把外部提交误报为本任务修改或声称 main 自始至终未变化。工作树通过绝对 symlink 复用原 `node_modules`，没有安装依赖。共享依赖目录只读取，不通过它执行安装、修复或升级。

独立产物目录：`../journal-growth-restore-artifacts/`，不打入包。

- `protection-before.json`：初始 main HEAD、tracked status、原方案/global settings/原源码/当前已装源码及原 `.pi/extensions` JSON 的 SHA-256 清单，保留不覆盖。
- `protection-current-baseline.json`：记录已确认的外部 `3c19f55` 变化及本任务接受的新基线；后续证明本任务没有改变保护范围，不将旧 main hash 作为永远不可变化的全机锁。
- `baseline-small-inspect.log`：当前 worktree 的现有 100 节点单 inspect 测试通过，10,127 字节、一次扫描、约 1.20 ms；不是大历史性能通过证据。
- `lost-store-sentinel.mjs` / `lost-store-baseline-red.log`：在原 `5aa8b71` 的真实 SDK 内存 SessionManager 和生产函数上复现，无模型、真实工具或磁盘 session；切到当前基线后另存 `lost-store-current-baseline-red.log` 再核验，不拿旧结果代替新基线验证。

故障注入结果：真实 `startSupervisor` 与一条 synthetic host read receipt 后，仅移除运行时 `receiptStore`，调用 `saveSupervisor`；基线没有拒绝，原生记录数从 2 增至 3，新记录 version=1、receipts=1。哨兵按期望守卫返回 RED（exit 1），外层核验确认其确实复现而不是导入失败。

这证明“新格式运行态丢失 store 后会退回大快照”的防御缺口，不证明正常生产一定发生过 store 丢失，也不改变 L1 大文件来自历史 v1 的诊断。

## 3. 阶段 A：精确状态与符号

### A1. 来源字段

在 `runtime.ts:TaskRuntime` 增加实例内、非持久化字段：

```ts
receiptPersistence: "legacy-v1" | "ledger" | undefined;
```

此字段不是 wire version，不用运行态 `SupervisorState.version` 推断。`ledger` 同时涵盖 v2 兼容视图与 v3 账本；实际保存版本仍由 `ReceiptStore.format` 决定。

| 符号                                                                                 | 冻结变更                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime.ts:createRuntime`、`state.ts:resetState`                                    | 初始/重置为 undefined                                                                                                                                                       |
| `supervisor.ts:startSupervisor`                                                      | 正常建立 store 后标记 ledger，再保存初始检查点                                                                                                                              |
| `supervisor.ts:restoreSupervisor/restoreReceiptViews`                                | 开始清除旧来源；从已校验的 history.ledger / history.legacyV2 / 实际 v1 checkpoint 分别标记 ledger / ledger / legacy-v1；无 state 保持 undefined                             |
| `supervisor.ts:receiptRecoveryStore`                                                 | 显式、已核验的旧目标迁移成功建立 store 时改为 ledger；v2 promote 不需要更改该二分类来源                                                                                     |
| `goal-lifecycle.ts:installGoalView`、`events.ts:restoreFaultedSupervisor` 的清理分支 | 清理 store/supervisor 时同步清理来源，防止跨目标残留                                                                                                                        |
| `supervisor.ts:saveSupervisor`                                                       | 保留现有 scope/identity/epoch 检查优先级；无 store 时，只有实际 legacy-v1 来源且没有当前 GoalRun scope 才允许原兼容保存。ledger/undefined 来源缺 store 时先拒绝，不追加记录 |

正常 v3 检查点、v5 包装、bindings、receipt 身份和缓存淘汰不变。`retainLegacyGap` 的专用旧格式屏障、既有 stop/hold/recover 写入语义和物理确认不删除；不得用通用 payload 去重拦截器替代 append 确认。

A 的其他生产路径若已经满足线性合同，只补回归。测试人工构造旧来源时须通过真实恢复或明确的旧 fixture 设置，不能把新 guard 默认关闭来维持不真实的测试前提。

### A2. 首个 RED 与验收分配

将已复现哨兵纳入 `supervisor-receipts.test.ts` 或 `receipt-store.test.ts` 的真实内存宿主 harness：新目标 capture 后移除 store，保存必须抛错且 native entry count 不变。随后验证明确旧 v1 恢复的必要控制写入仍可用。

W1/W2：逐项覆盖重复/冲突结果、查询、暂停、恢复、停止、审查、验收、连续目标切换与故障恢复。W3：固定任务/bindings/负载，仅统计扩展新增条目字节，先 10 条冒烟，再 100/500/1000；500→1000 增长不超过方案冻结的 2.2 倍。W4：沿用有界缓存及淘汰后读证据回归。

## 4. 阶段 B：一个实例内恢复读取 Module

新增 `src/restore-journal.ts`。它是恢复编排的内部 Module，不成为工具参数、协议或全局服务。严格 reader `inspectSessionJournal`、实时 `inspectRestorableSession` 及授权准入函数默认行为保留。

### B1. 冻结 Interface

```ts
interface RestoreJournalRead {
  inspect(ctx: ExtensionContext): SessionJournal | undefined;
  require(ctx: ExtensionContext): SessionJournal;
  prefix(ctx: ExtensionContext, entryId: string): RestoreJournalRead;
}
interface RestoreJournalCycle {
  readonly read: RestoreJournalRead;
  installGoal(ctx: ExtensionContext, install: () => void): void;
  afterConfirmedAppend(ctx: ExtensionContext, expectedLeaf: string): void;
  runSupervisorRestore(ctx: ExtensionContext, restore: () => void): void;
  assertCurrent(ctx: ExtensionContext): void;
  close(): void;
}
function beginRestoreJournal(ctx: ExtensionContext): RestoreJournalCycle;
// goal-lifecycle.ts 的内部参数，不进入工具/持久化协议。
interface GoalRestoreOptions {
  read: RestoreJournalRead;
  install: (operation: () => void) => void;
  afterConfirmedAppend: (entryId: string) => void;
}
```

- `beginRestoreJournal` 在恢复入口原有 cancel/invalidate/await-close/freshness 检查之后创建；执行一次真实 `inspectRestorableSession`，记录来源及检查结果。构造前后比对来源，不能把读取期间变化当稳定快照。
- `inspect` 先验证帧和 ctx，再返回本周期的只读 journal，或原有合法无文件例外的 undefined。`require` 对 undefined 抛现有 `JOURNAL_UNAVAILABLE`，不伪造空 journal。
- 源码使用上述 Interface 的只读部分；只有 `events.ts` 和生命周期编排可持有 cycle 的安装/续读操作。它们不是任意 epoch/leaf 更新接口。
- 同一检查结果不复制所有 receipt 正文，不由消费者修改 journal/nodes/data；派生 owner state 仍用原来的 clone。root 读取对象可跟随一次合法重建进入新 revision；已派生前缀绑定旧 revision，重建后失效。
- cycle 在 `finally` close；不保存到 TaskRuntime、不放入 AsyncLocalStorage 或进程全局缓存，不跨 UI 交互/授权/工具执行复用。

### B2. 来源身份与前缀

私有 core 捕获：原 ctx、TaskRuntime 引用、原生 manager 引用、sessionId、session 文件路径、原生 root leaf、expectedGoalEpoch、revision，以及文件的类型/dev/ino/size/mtimeNs/ctimeNs。文件状态只有 existing / missing-setup / in-memory 三种；inode/元数据检查不冒称对抗恶意并发改写的 OS 隔离。

每次消费及最终接受前检查同一 runtime/manager/session/path、root leaf、epoch 和文件来源。不得仅以同文本目标、mtime 或 in-memory 记录缺失命中缓存。

`prefix(ctx, entryId)` 仅接受当前可见祖先中的 entry，ctx 必须是现有 `startupContext` 从当前 manager 派生的只读前缀（或等价明确验证的内部视图），且 session/path/visible leaf 与该 entry 一致。返回 branch 截至 entry、nodes 仅包含这段祖先、visible leaf=entry 的新 read；同时继续检查原始原生 root 身份，不能只对被替换的 prefix manager 自证。

未来/兄弟记录在 branch 和按 ID 查找两条路径均不可见。嵌套前缀只可缩短当前前缀，不能扩大。原有 startup 同一性、owner/GoalRun 和控制闭包检查保留。

### B3. epoch 与恢复自身写入

- `installGoal` 仅包裹 `installGoalView` 这一同步步骤，禁止返回 thenable。前后要求文件/root leaf/runtime/manager/session 不变，epoch 必须恰好 +1；无视图时不调用，所以保持 +0。仅推进只读帧的 expected epoch，旧回调和权限不恢复。
- `restoreGoalLifecycle(pi, ctx, restore?: GoalRestoreOptions)` 在存在 view 时通过由编排传入的 `restore.install` 回调完成安装；实时调用者没有该参数时使用原实现。其他外部 epoch 变化不允许交接。`commitPending(pi, ctx, view, restore?)` 同样显式接收该对象，用 `restore.afterConfirmedAppend` 通知编排，不能让只读 read 对象私下取得写入权限。
- `commitPending` 和 `appendObservedGoalCheckpoint` 保留原来提交前的新鲜物理证明及写后确认。内部 `commitPending` 在拿到真实 append id 后通知 `afterConfirmedAppend(ctx, id)`，然后从新 read 重新 fold，不把提交前的 view 继续当最新记录。
- `afterConfirmedAppend` 要求原生当前 leaf 正好等于已确认 id，身份/预期 epoch 不变、原 leaf 是其祖先、文件为同一来源的合法追加。它重新严格检查、增加 revision；这不是用旧快照授权写入。若原有 append 后检查已经失败，不通知/不续用。
- 旧 `retainLegacyGap` 或恢复中 `restoreBoundPreflight`/hold 路径可写。`events.ts` 只用 `runSupervisorRestore` 包裹原来的同步 `restoreSupervisor`：先检查帧，执行原 restore 与原确认；无 leaf/文件变化时只检查后置条件；原生 leaf 在此已知同步步骤中合法前进时，验证旧 leaf 仍在同一 ancestry 后重新严格读取。若只有文件变化而原生 leaf 没有对应前进、身份/epoch 变化、分支替换、原函数抛错，则作废，不自动采用新状态。
- 以上已知写入重建不套用“稳定只读恰好一次”预算。不能为了计数删掉新鲜证明，也不能用统一重试重复提交业务动作。

### B4. 变化与失败优先级

| 顺序 | 条件                                                                    | 动作                                                                                         |
| ---- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | runtime/manager/session/外部 epoch 已失效                               | 终止旧恢复，不向新 owner 写 journalFault、UI 或回调；沿用原生命周期取消语义                  |
| 2    | 严格 reader 发现损坏、错误分支、未知格式、缺文件但有 message、limits 等 | 保留原错误类别和受阻状态，不能切到无 owner/空 journal，也不重试工具                          |
| 3    | 已知恢复写入且原闭包/身份/ancestry 成立                                 | 原确认之后建立新读取 revision，不复活旧能力                                                  |
| 4    | 相同 owner/epoch 下，仅读取期间文件或一致的原生 leaf 发生新变化         | 最多重新建立一次只读恢复（总计最多两个尝试）；仍不稳定则保守受阻并显示需重新检查，不无限重试 |
| 5    | existing 稳定，无恢复写入                                               | 一次物理检查，所有只读投影共用                                                               |
| 6    | 无路径内存会话；或缺文件且无任何 type=message 的 setup-only             | 保留 undefined/零物理读取，不创建日志、不产生新可恢复授权                                    |

旧错误捕获/hold 优先级保留。必要时新增仅内部 `RestoreReadInvalidated` 判别，不能把真实 JournalReadError 都改写成可重试的 cache miss。

## 5. 共享读取的完整接线图

下面参数均为内部可选参数，未传时执行原新鲜路径，不增加工具 wire 字段。

```text
session_start / session_tree
  -> restoreSession (原入口失效与关闭旧视图)
  -> beginRestoreJournal
  -> restoreGoalLifecycle(pi, ctx, {read, install, afterConfirmedAppend})
       -> readGoalJournal(ctx, read.inspect(ctx))
       -> [可选 commitPending：原 fresh proof/append -> cycle.afterConfirmedAppend -> 新 fold]
       -> cycle.installGoal(installGoalView)
  -> reconstructState（原 native 只读 fold）
  -> restoreBoardHuman(ctx, board, read)
  -> restoreSessionScope（原逻辑）
  -> restorePreflight(ctx, read)
  -> cycle.runSupervisorRestore(() => restoreSupervisor(pi, ctx, read))
  -> updateUI(ctx, board, read)
  -> cycle.assertCurrent / finally close
```

| 文件/符号                                                                                            | 参数与消费者合同                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `goal-journal.ts:readGoalJournal`                                                                    | 已有 supplied journal 能力，保持默认真实检查；恢复调用前由 read 校验，不把 raw supplied journal 暴露给模型                      |
| `goal-lifecycle.ts:restoreGoalLifecycle/commitPending`                                               | 增加恢复 read 和受控 install/已确认 append 通知；请求授权、choiceIsCurrent、实时 transition 路径仍原 fresh 检查                 |
| `board-human.ts:restoreBoardHuman`                                                                   | 增加 read；readBoardHumanPresentation/answerBoardDecision 等实时路径不默认复用                                                  |
| `supervisor.ts:restoreSupervisor/readSupervisorHistory`                                              | 恢复时传 read，包括 v5 内部 readGoalJournal；其他 live/startup 调用无 read 时原行为                                             |
| `supervisor.ts:readSupervisorStartRecord/startupContext`                                             | 在原 prefix ctx 构造后派生 read.prefix(prefixCtx, entryId)，传给前缀历史 fold；不把 full nodes 带进去                           |
| `preflight.ts:restorePreflight/readPreflightFold/foldPreflightControl`                               | 向深层 confirmedPreflightProof、verifiedPreflightProjection、readPreflightStartup 传 read，避免藏着的重新物理扫描               |
| `preflight.ts:approvalIssue/controlClosureIssue/preflightAuthorizationIssue/preflightTaskIssue`      | 仅内部恢复/展示调用可带 read。真实授权、启动、工具门及公共默认调用不带 read，继续新鲜证明                                       |
| `supervisor.ts:restoreBoundPreflight/updateSupervisorUI`                                             | 仅恢复路径传 read；其他 recover/check/执行验收不复用                                                                            |
| `state.ts:updateUI`、`ui-capture.ts:captureUiSummary/summaryInput/captureFacts`、`flow.ts:flowFacts` | 恢复期间 UI 状态摘要也传只读 read 至 preflightTaskIssue，避免 hasUI=true 时额外扫描；不改 UI 样式或交互、不改只读页面的实时捕获 |

所有 preflight proof helper 在无 read 时仍用原来的 `inspectSessionJournal`。需要真实日志的深层 helper 带 read 时调用 read.require，不能把 undefined 当空批准。

## 6. 精确写集与所有权

唯一 writer 为主控。预计生产写集（只改需要的符号）：

- 新增 `src/restore-journal.ts`；
- `src/runtime.ts`、`src/state.ts`、`src/supervisor.ts`、`src/events.ts`；
- `src/goal-lifecycle.ts`，`src/goal-journal.ts` 仅在必要的参数传递/类型支持时改，不修改协议；
- `src/board-human.ts`、`src/preflight.ts`；
- `src/ui-capture.ts`、`src/flow.ts` 仅透传恢复读取，不增加样式或交互。

测试：新增 `src/__tests__/restore-journal.test.ts`、`src/__tests__/restore-journal-integration.test.ts`；扩展 `receipt-store.test.ts`、`supervisor-receipts.test.ts`、`events.test.ts`、`preflight-restoration.test.ts`、`goal-native-proof.test.ts` 及必要的 helper，原有断言不得随意削弱。必须保留新基线的 `ui-publication.test.ts`，候选相邻回归包含其 TUI/legacy 客户端状态清理合同，不能通过恢复旧的双重 status 发布抵消 `3c19f55`。实际修改文件比名单少可以，比名单多时先说明它处在何条已批准调用链，不借机改无关代码。

基准/文档：新增 `test/journal-growth-restore-bench.mjs`（小样本默认、有界 synthetic、真实历史须显式外部路径）及本 packet、候选验收记录；如复用既有测试 helper，保持包 files 不纳入测试/真实数据。只为验收该功能时才调整 README/CANARY 的真实行为描述。

禁止改 package.json/lock、schema/wire 版本、tsconfig、coverage 门、已安装内容寻址包、全局 settings 或原始 session。

## 7. Sentinel 与验收映射

| 合同        | 第一条能够失败的检查                                                                 | 后续接受                                                  |
| ----------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| C2/W1–W2    | lost modern store 后禁止新增 v1 的 RED（已复现）；旧 v1 来源的合法控制保存仍可读写   | 生产 guard GREEN + 全事件路径/重复/冲突/跨目标回归        |
| C2/W3–W4    | 小样本固定负载的新增 checkpoint 不含 receipts 正文，淘汰后旧证据可读                 | 100/500/1000 新增字节近线性、原缓存上限                   |
| C2/R1/R9    | 有持久日志无 owner 小 fixture 的 session_start 实际读取字节/EOF 次数；合法无文件零次 | legacy 重负载、TUI/RPC、setup/in-memory、缺文件有 message |
| C2/R7       | scoped v5 视图自身安装 epoch +1 仍一次扫描；额外 +1 必须失效                         | 安装前后/await 间隙身份变化，零视图 +0、旧回调不复活      |
| C2/R8       | native approve/start + scoped Supervisor 稳定恢复总扫描次数                          | 深层 proof 链、nodes/branch/leaf 前缀、未来/兄弟记录拒绝  |
| C2/R3–R4    | append、替换、损坏/半行与 append no-op/抛错/提交后抛错                               | 原错误类别、未知结果与 hold 不变，合法恢复写入额外检查    |
| C2/R2/R5–R6 | 同一小 fixture 的 owner 投影/工具启用、无 Main 派发                                  | 同候选固定输入的分阶段耗时/读取字节/最大记录/峰值内存     |
| C2/G1       | 本轮 touched seams 的 focused tests/typecheck/lint/format                            | 完整 npm run check、相关 native/cold 与独立最终源码审阅   |

编辑循环用最小 sentinel；A 结束跑 A focused/static；B 结束跑 shared-read focused/adjacent；候选阶段跑一次完整门，变更或失败修复后重跑影响范围。不得反复全量测试来发现普通导入错误，也不得以库 helper 一次扫描代替整个 session_start（含恢复 UI 摘要）预算。

现有 npm run check 使用开发 SDK 1.1；native/cold 验证还需实际宿主 SDK 1.3。不得因为旧诊断报告用过 SDK 1.3 就假定候选自动兼容。

## 8. Hash、字节和兼容性

- 保持 `tool:<opaque host id>`、摘要 preimage/算法、旧 entry ID/parent、GoalRun scope、legacyBase、receiptLedger/cursor 及所有审查/绑定含义。
- 不用原始行 bytes hash 替代 JSON 语义摘要，不用 snapshot cache 声称获得 fsync/OS 事务。
- 新来源字段仅实例内，不修改 v1/v2/v3/v5 持久格式；旧来源正常读写边界按原合同保留。
- 失败输出不打印真实 payload、Cookie、auth.json 或模型凭据；合成回执可写测试，真实日志只读且不进入仓库/包。
- 保持 data/review/epoch identity 校验及 mutation overlap、未闭合 intent、新鲜最终验证、缓存淘汰、故障后显式恢复的语义。
- 对外工具参数/返回结构不变。新增可选读取参数不是用户注入 journal 的入口。

## 9. READY 结论与下一执行者

- 当前没有需要用户新增裁决的外部格式、权限或破坏性操作决定。
- 新 worktree/分支、精确 plan hash、单 writer、写集、返回值、所有读取者、来源/epoch/prefix/追加失效、失败优先级和各阶段验收均已固定，判定 READY。
- 下一执行者：主控在同一 worktree 领取 t-2.1，先把独立 RED 哨兵落到生产测试 harness，再实现最小来源 guard；不抢先实现 B，不启动重复 writer。
- 本文 READY 不代表 A/B 已通过。L1 4–6 秒只是待测目标；首次真实数据回放须先有 synthetic smoke，且真实 session 不得改变。
- 提交、发布、安装、merge、真实 reload 和历史迁移仍不在授权内。最终主控必须消费独立源码审阅并验证最终候选指纹，才能完成 t-5.1。
