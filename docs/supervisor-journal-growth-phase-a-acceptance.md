# 阶段 A：写入增长与兼容守卫记录

这是 t-2.1 的局部交付记录，不是完整修复交付。阶段 B 共享恢复读取、完整候选门和独立最终源码审阅仍由后续任务承担。最终 reviewing 检查及源码指纹保存于本机 `../journal-growth-restore-artifacts/phase-a-review.json`。

## 1. 候选与权限

- 工作树：`pi-task-supervisor-worktrees/journal-growth-restore`。
- 分支：`fix/supervisor-journal-growth-restore-current-main`；本候选基线 `3c19f559a9dc1378e34ad3a140b589cb1707c28e`。
- 按[已审方案](supervisor-journal-growth-and-restore-repair-plan.md) A1/A2、W1–W4 和[实施包](supervisor-journal-growth-implementation-packet.md)推进。
- 主控唯一写入者，没有实现 subagent 或后台 writer；未提交、merge、推送、安装、reload 或修改真实日志。
- 阶段内观察到 main 外部推进至 `0e851d37255b7d526b224aa2c4273e4c8b9b4def`（host-controlled batch handoffs）。没有覆盖、回退或混入本候选；后续若整合到更新 main，必须重新验证相应交集，不把本基线的结果冒称新 main 已通过。
- 第一轮最终检查完成静态/331项测试/资源/native回归后，因原仓库未跟踪的 `.pi/extensions/pi-provider-service-tier.json` 与 t-1.1 旧快照不同而停止，未把该命令报为通过。复核原生时间线：本批首次预检完成于北京时间16:54:33，该文件最后修改于16:40:37，属于本批之前的既存变化。保存散列与时间证据，不回退他人/框架状态；最终保护核验区分这项开批前差异与候选的写入范围。全局 settings 和原已安装源码没有改变。

## 2. 两条真正 RED → GREEN 的故障注入

### 2.1 保存路径

真实内存 SessionManager，先执行生产 `startSupervisor` 与一条 synthetic read capture，再移除运行时 store：

- RED：`saveSupervisor` 不拒绝，新增 version=1、含回执正文的快照。
- GREEN：抛出 `Supervisor receipt ledger is unavailable`，原生分支记录数不变。

既有独立 SDK 哨兵再次通过；它使用实际宿主 SDK 1.3，但无真实会话、工具或模型调用。该测试是防御性丢失-store 注入，不声称生产必然出现过这一状态。

### 2.2 恢复路径

只修保存入口还不够。合法配置 cacheEntries=512、1 MiB，现代目标取得 500 条 synthetic receipt 后暂停并失去 store：

- RED：显式 recover 可将缓存误认成旧 v1，通过 `retainLegacyGap` 追加完整 v1 安全屏障，再以刚写的记录建立迁移锚点。
- GREEN：在任何旧格式屏障/迁移写入之前拒绝；原生分支不变，Supervisor 保持 fault，不能制造新旧格式锚点。

这属于原有 A2 的生产者审计和来源守卫，不改变合法 recover 或容量屏障的语义。

## 3. 最小生产改动

实例内新增 `receiptPersistence: "legacy-v1" | "ledger" | undefined`，不进入持久 wire 或工具参数：

- 正常 startup 和成功迁移标记 ledger。
- 恢复从经过校验的 v1 / v2 / v3 历史判定来源，不按运行态 version=1 猜来源。
- reset、目标视图切换及失败恢复清理来源，防止残留。
- `saveSupervisor` 与 `receiptRecoveryStore` 的无 store 路径仅允许明确旧 v1 来源；现代/未知来源拒绝。
- ReceiptStore、v2 cursor、v3 ledger、v5 wrapper、摘要算法、ID、bindings、epoch、预算与未知执行规则均未修改。

### 生产者审计处置

| 路径                                 | 处置与验证                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| 新目标 startup                       | 复用原 ReceiptStore 小检查点；补来源记录，不改 runtime v1 结构                           |
| tool_call / tool_result              | 复用原 intent/receipt 增量协议；重复结果幂等、冲突结果拒绝、未知结果与重放保护沿用原测试 |
| hold / 暂停 / 普通 resume / stop     | 走现有控制保存；现代写小检查点，真正旧 v1 来源的合法兼容控制保存仍允许                   |
| 审查 / 最终接受 / completion binding | 继续原证据和因果校验；save 入口统一防丢 store 的全量回退，不为减小体积移除控制记录       |
| 显式 recover                         | 真正 v1 允许屏障与迁移，v2 允许原显式 promote；现代 store 丢失不能假迁移                 |
| 查询 / UI 刷新                       | 不新增持久化；保留基线 `3c19f55` 的跨客户端状态发布修复                                  |
| 连续 GoalRun / reset / 空会话恢复    | 清理来源资格，不能把旧 legacy 来源带入现代或未知状态                                     |

## 4. 兼容回归

新增或复用的验证包含：

- 真正旧 v1 的控制保存仍可用；显式迁移后再丢 store 不回退 v1。
- v2 小检查点仍可保存；失去 v2 view 不回退完整 v1。
- 现代日志恢复后运行态仍可为 version=1，但没有旧格式回退资格。
- reset/空会话替换后的迟到旧状态不能借用旧来源写入权限。
- 旧 500 回执安全屏障、stopped 不迁移、缓存淘汰后旧证据读取、重复/冲突结果、分支/会话隔离保持原有语义。
- 相邻回归覆盖 events、preflight、GoalRun 隔离/作用域/原生证明、UI publication，以及控制命令、Supervisor 接受和暂停规则。

原生开发 SDK 的迁移检查先以 v1=2、v2=2 条冒烟，再执行 v1=500、v2=501 和未闭合 intent 恢复。全部为 sandbox/faux-provider/UI stub，不认证真实用户授权质量、真实终端显示或业务过程。

## 5. 全部增量字节验证（包括每条结果后的检查点）

固定任务、绑定和输入输出，每次 result 后显式 `saveSupervisor`。统计真实 SDK 内存 journal 中扩展 custom entries 的 JSON UTF-8 编码加换行，扣除固定初始记录；不是 OS 磁盘延迟，也不包括 Pi 原生 transcript。

| 回执数 | 新增持久化编码字节 | 检查点数 | receipt 正文数 | 缓存条数 |
| -----: | -----------------: | -------: | -------------: | -------: |
|     10 |             15,127 |       11 |             10 |       10 |
|    100 |            151,570 |      101 |            100 |      100 |
|    500 |            759,170 |      501 |            500 |      128 |
|   1000 |          1,518,673 |     1001 |           1000 |      128 |

500→1000 的新增字节比例为 **2.0004386**，小于冻结的 2.2 门；每个检查点 receipts 数组为空，每条结果正文仅一份，淘汰后最早回执仍可读取。缓存正文在 500/1000 条时约 42,752 字节；locator 随历史增长，不宣称整个进程内存恒定。

默认新增样本为10条，依次通过后才放大到100/500/1000；原来的 ledger-only 增长测试及其 getBranch 调用次数断言原样保留。

## 6. 证据与保留范围

本机独立产物目录：`pi-task-supervisor-worktrees/journal-growth-restore-artifacts/`。

- `phase-a-red.log` / `phase-a-first-green.log`：保存路径的真实断言失败和修复后通过。
- `phase-a-recovery-path-red.log` / `phase-a-recovery-path-green.log`：假旧格式恢复路径的真实 RED/GREEN。
- `phase-a-growth-{10,100,500,1000}.json`：分级资源结果。
- `phase-a-native-v1-small.log`、`phase-a-native-v2-small.log`、`phase-a-native-v1-500.log`、`phase-a-native-v2-501.log`、`phase-a-native-intent.log`：sandbox 原生兼容结果。
- 最终 `phase-a-review.json` 与同名 reviewing 日志绑定本候选生产/测试指纹、静态检查、局部测试与保护核验；不能拿原基线/方案审阅报告替代。

过程中曾因新增测试的 shorthand void 回调触发现有 ESLint 规则，已改用原有 block 回调样式；未禁用规则或降低门槛。完整 npm run check/coverage/所有 cold smokes 和独立最终源码审阅留在 t-4.1/t-5.1，不将局部通过冒充它们已完成。

下一批为 t-3.1：共享恢复读取及其 epoch/严格前缀/追加失效/无文件例外。本批没有实现 `restore-journal.ts`，也没有改变恢复扫描次数；现有大历史文件不会因此变小。
