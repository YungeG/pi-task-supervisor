# 阶段 B：共享恢复读取与失效合同记录

这是 t-3.1 的局部交付记录；整体候选完整门、实际宿主冷加载、真实 L1 对比和独立最终源码审阅仍由 t-4.1/t-5.1 完成。没有安装、重载或改写真实日志。

## 1. 候选范围

- 同一独立 worktree `journal-growth-restore`，分支 `fix/supervisor-journal-growth-restore-current-main`，基线 `3c19f559a9dc1378e34ad3a140b589cb1707c28e`。
- 开批核对阶段 A 的完整源码指纹 `ab7303704d1a67c44fe72a80c6cfbc07d62631a4054deb8a1a1df34ed598b644` 一致，没有活动实现进程或重复 writer。
- 主控是唯一源码写入者。保持阶段 A 来源守卫及原有 UI publication 修复，未改 schema、账本协议、digest、工具参数或覆盖率门。
- 新增一个实例内 Module：`src/restore-journal.ts`。没有全局缓存、数据库、持久索引或后台进程。

## 2. RED 与实现闭包

### 2.1 完整恢复而不是单 helper 的扫描预算

新测试从 TUI/RPC 的真实 header 文件和原生 session_start handler 入口测量物理 open/read 字节。实现前两个用例均真实失败：期望一次，实际四次。

实现后，稳定有持久日志、无恢复写入时，只做一次原有严格检查；同时验证实际读取字节等于文件字节，不以函数调用计数冒充物理预算。owner-free 内存视图不能跳过已有文件。

### 2.2 恢复私有读取周期

`beginRestoreJournal` 建立私有 Restoration，记录实际 runtime、manager、session/path、root leaf、expected goalEpoch 和文件类型/dev/ino/size/mtimeNs/ctimeNs。消费者使用显式 `RestoreJournalRead`，不是可注入工具参数。

- require 对合法无文件结果仍拒绝产生物理证明；inspect 保留内存/setup-only 的原有 undefined 行为。
- 根读取检查来源；前缀同时限制 branch、nodes、visible leaf，并检查 bound context 的 session/path/manager、revision 与前缀 ID 列表。
- afterConfirmedAppend 只有在原闭包成功后调用，重新严格读取并使旧前缀失效；错误（包括内存 no-op）关闭能力。
- finally 关闭周期；派生 view、UI 摘要或授权操作不长期保留缓存。

本地负向用例曾检出并已修复：派生前缀身份变化、前缀数组事后扩大、内存 no-op 追加确认、已知恢复失败后仍可读等缺口。使用真实断言 RED/GREEN，不把一次不可重定义测试 getter 的 fixture 错误算作有效 RED。

### 2.3 受控 epoch 交接

restoreSession 入口依旧先使旧回调失效；存在目标视图时，只有它直接拥有的同步 installGoalView 可以再递增一次 epoch。帧只更新自己的预期值，不复活旧 planning lease、人类回调或任何授权。

稳定 v5 planning GoalRun 的测试验证整个 session_start 的总 epoch 增量为2（入口1次＋安装1次），但物理读取只有1次。没有视图时不执行安装交接。额外 epoch、manager/session 替换或异步安装会拒绝/作废，旧 owner 不向新 owner 发布故障或继续执行。

### 2.4 深层读取与实时准入分离

只读恢复传递到 goal fold、Board human fold、Supervisor history、preflight control **和 snapshot** fold、proof/projection/startup、严格启动前缀，以及恢复期间 UI→flowFacts→preflight 的只读摘要。

首次 native approve/start 集成测试仍读了4次，调用栈定位到 foldPreflightSnapshot 内的 approvalIssue。补齐这条接线后，已有原生 approve/start 的 scoped、paused Supervisor（包含 TUI 状态摘要）也只有一次读取，保持原状态且没有追加。

实时 preflightAuthorizationIssue/启动/授权提交和原始 inspectRestorableSession 默认不接受恢复帧，仍独立新鲜读取。测试在恢复后调用真实准入检查，确认它再次进行物理读取。

原有 startupContext 的 prefix manager 保留；缓存节点查找集合不能借未来/兄弟记录闭合过去的证明。完整日志中的未来 witness 在启动前缀里为 unconfirmed，不能借 full nodes map 获得 confirmed。

## 3. 合法写入、变化和失败

- confirmed pending goal：保留提交前新鲜证明及 append 后的物理确认；刷新读取周期后再安装，不能用旧帧提交。
- before / memory-only / written-then-throw：集成测试覆盖恢复中的同一追加失败边界；不重复提交，不自动派发 Main。已经真实落盘且原 native proof 有效的目标元数据可按原逻辑只读重建，不冒充未知业务工具成功。
- 旧 v1 500 条容量缺口：专用屏障仍只写一次；这次合法写入重新检查。下次 reopen 没有新写入，恢复为一次检查。没有为预算删除屏障。
- 已知同步 Supervisor restore 中途发生原生追加时，追加后的内部读取退回原新鲜路径，返回编排后重建周期；不在旧 leaf 上消费缓存。
- 可观察文件/root leaf 变化在同 owner 下最多两次读取尝试；仍不稳定时不再为 held-view UI 做第三次扫描，保持受阻并明确 counts unknown。
- 初始严格 reader 的稳定损坏/UTF-8/limits/错误分支继续拒绝，不把所有 JournalReadError 当成 cache miss。仅实际观察到来源/leaf变化才进入有界重试。
- 外部 epoch 失效取消旧恢复，不重试、不追加、不向新 owner 发布错误。无文件且已有 message 仍拒绝，合法内存/setup-only 零物理读取。

### 文件系统一致性边界

元数据检查不提供 OS 事务或对抗保留所有文件元数据的篡改保证。文件系统可能合并同一 tick 的改写时间；同尺寸失效测试显式使 mtime 可观察地变化，不能把它夸称为任意同尺寸篡改检出证明。首次 strict reader 和实时准入仍使用原有实际文件与摘要检查，恢复帧仅限同步只读周期。

## 4. 验证与本机工件

先运行小型 persisted owner-free RED、读取帧负向和 scoped native 机制样本，再扩大到旧500回执及相邻模块。unit/integration 使用真实临时文件、fake-native manager/UI driver 或 sandbox/faux provider；不是业务运行或真人授权质量认证。

- `phase-b-integration-red.log`：TUI/RPC 稳定恢复4→1的真实 RED。
- `phase-b-read-frame-negative-red.log`：读取帧的初始负向发现。
- `phase-b-native-integration-first.log`：深层 snapshot 检查和读取期间变化的初始失败。
- `phase-b-native-v1-small.log` / `phase-b-native-v2-small.log`：新代码先以2条回执跑原生机制冒烟。
- 最终 reviewing 的 `phase-b-review.json` 及对应日志绑定源码指纹、focused/static 检查、原生模式结果和保护状态。报告在仓库外同级 `journal-growth-restore-artifacts/`。

没有给 ESLint complexity/max-lines、日志 limits、schema、断言或覆盖率门加豁免。读取周期用私有 class 分解状态与方法，故障展示与重试判别提取小函数；保留原错误展示和跨 UI 客户端状态清理。

## 5. 尚未完成的整体验收

本批不宣称 L1 由14.7秒降至特定数值。下一批 t-4.1 将执行完整 npm run check/coverage、要求的原生/冷恢复、同输入阶段时间与读取字节/峰值内存对比，并再次绑定最终候选。

t-5.1 仍需独立源码审阅、处理有效发现和最终接受。外部 main 的后续提交不自动合入本分支；真实日志未缩小，也未执行方案 C。提交、push、merge、安装和真实 reload 仍保留单独授权。
