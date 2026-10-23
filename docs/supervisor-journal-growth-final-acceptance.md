# 日志增长与恢复读取修复：最终源码验收

结论：**ACCEPT_CANDIDATE_ONLY**。本记录接受独立 worktree 中的最终修复与验证，不授权提交、合并、部署、真实 reload 或旧日志迁移。任务完成状态还须由 reviewing 阶段的新鲜成功宿主核验收据确认。

- 分支：`fix/supervisor-journal-growth-restore-current-main`；HEAD 基线仍为 `3c19f559a9dc1378e34ad3a140b589cb1707c28e`，改动未提交。
- 最终 `src/**/*.ts` 清单指纹：`1ccebd0ab49fa1830495e2156205f656bf0c7946a5aa584270a10e230fa5b4c1`。不是阶段 C 的 `20514c…`，也不是中间修复 `ee95e…`。
- 唯一源码 writer、发现裁决与最终接受者：主控。独立 reviewer 全程只读，未执行测试、未读取真实 session、未自行重算源码哈希；源码绑定与所有执行验证由主控独立完成。
- 私有证据目录：同级 `journal-growth-restore-artifacts/`。最终清单、报告和实际宿主收据需一起使用；单独的 reviewer OK、阶段 C 通过或本文件均不替代验收。

## 1. 独立审阅与逐项裁决

初审运行 `1b63aaa5-8ccc-48a7-ba50-fb70c3a3eba0` 报告 **BLOCK**。主控接受以下两项为有效 P1，而非忽略为已有测试通过：

| 发现                                                                                                                        | 主控复现与最小修复                                                                                                                                                                                         | 最终裁决                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| P1-1：preflight broad catch 吞掉恢复失效，使外部 epoch 变化或文件变化变成授权缺陷，并可能新增 authorization hold checkpoint | 新增直接深层闭包和 bound-preflight epoch/source 三项回归；旧代码全部失败，确实观察到错误持久化 hold。`controlClosureIssue` 仅将 `RestoreReadInvalidated` 原样抛出，真实证明错误仍走原转换                  | VALID → FIXED；不再写错误 hold，epoch 放弃、source 仅有界重试              |
| P1-2：已确认 commit 后刷新失败被 broad catch 转成 blocked，再安装已关闭 cycle，以 `closed` 遮盖原 epoch/严格 reader 错误    | 新增 post-confirmation EOF epoch 与无效 UTF-8 两项回归；旧代码均失败。`commitPending` 保留新鲜证明、物理确认、原默认 live refold 的不确定性处理；恢复 refresh/refold 位于该 catch 之外，失败不再安装旧视图 | VALID → FIXED；commit 仅一次，epoch 不发布新 fault，`JOURNAL_INVALID` 保留 |

五项新回归先全部 RED，再 GREEN。既有 before / memory-only / written-then-throw 三类 append 合同继续通过。首次完整门被原复杂度阈值拦截（20>15），主控将 pending 恢复这一完整工作收拢到原 helper，未放宽阈值或增加通用抽象；之后 typecheck、lint、15 项恢复集成测试均通过。

定向复审 `cee8e5c9-193c-4a6b-86dd-8f8f95ccc2b9` 确认两 P1 已修复，但其指纹为中间版本，不能直接接受最终代码。最终定向复审 `9fee24cc-d560-40df-b794-1093be5dc0eb` 重新检查 helper 整理后的 `1ccebd…`，确认语义、错误优先级和原 live 路径均保留，无新增问题，**Merge verdict: OK**。初审与两次复审报告全部保留；没有未处置的 P0/P1/P2。

## 2. 最终源码验证

- `phase-d-full-check-final.log`：76 个文件、**1986 项测试**、**12 个既有冒烟模式**通过；typecheck、lint、format、coverage 门保持原阈值。
- 覆盖率：statements **93.99%**、branches **90.44%**、functions **98.22%**、lines **95.99%**。
- 最终 SDK native 检查 7 项：SDK 1.1 顺序目标/权限/普通 SDK 双 TTY 拒绝；精确 SDK 1.3 与当前 SDK 1.4 各自顺序目标/权限。
- 最终独立进程 cold 22 项：读者 1.1 五项、1.3 八项、1.4 九项，包含自身与跨 SDK / 阶段 C 历史生产物、pending 不重放、旧扩展 reader 对 v5 拒绝。真实 SessionManager、无 source mock；cold 模型调用 0、owner journal 与真实 settings 逐次不变。
- 最终 SDK 1.3 和 1.4 各有 v1=500、v2=501、未闭合 intent 的实际 SDK 回执 smoke；现代 store 丢失哨兵仍拒绝新增 v1。smoke 的 faux provider、合成按键和受控工具不是生产业务或人类身份认证，不可用其测试授权作为本任务授权。

## 3. W1–W4 / R1–R9 / G1 逐项绑定

以下证据均对应最终 `1ccebd…`，不是只沿用阶段 A/B/C 的旧执行结果。

| 合同                                             | 源码/测试与最终执行证据                                                                                                    | 判定                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| W1 现代 checkpoint 无历史正文、重复不增/冲突拒绝 | `supervisor.ts` 来源 guard；`supervisor-receipts.test.ts`、`receipt-store.test.ts`；最终全门、`phase-d-lost-store.log`     | PASS                               |
| W2 控制事件/连续目标/恢复与必要屏障              | 全门中的 receipt/preflight/goal 负向测试；最终 SDK 1.3/1.4 v1=500、v2=501、intent smoke；15 项恢复集成含必要追加异常       | PASS                               |
| W3 每结果 checkpoint 的线性新增字节              | `receipt-store.test.ts` 对应 total incremental 测试；最终 10/100/500/1000 报告，500→1000 为 **2.0004386**，低于原 2.2 上限 | PASS                               |
| W4 原缓存与淘汰后证据                            | 同一最终增长测试检查原 128 条及 byte 限额、淘汰后首条可读；既有 cache/locator 测试                                         | PASS；不声称总索引恒定内存         |
| R1 稳定持久恢复一次物理读取                      | `events.test.ts` 实际字节检查；恢复集成稳定 planning/native-start/TUI 与 RPC；最终 benchmark Open/EOF/实际 bytes           | PASS                               |
| R2 相同恢复状态与无自动 Main                     | 最终 baseline/candidate 业务投影摘要相同，效果计数均 0；工具启用另由 `events.test.ts` activation/setActiveTools 断言验证   | PASS；benchmark 不模拟实际工具执行 |
| R3 变化/损坏/未知格式/limits 拒绝                | restore-journal / human-journal / preflight 既有负向测试及新增 source/epoch/无效 UTF-8 深层回归；最终全门                  | PASS                               |
| R4 新鲜证明/物理确认/未知结果不升成功            | goal-journal 与 receipt intent 测试；pending commit before/memory/after/refresh 异常、旧 500 gap；最终 SDK intent smoke    | PASS；合法写入不套一次读取预算     |
| R5 小→有界旧格式→只读 L1                         | 最终 benchmark 顺序与 `phase-d-small/medium/l1-*.json`；输入 SHA 和字节前后一致                                            | PASS；真实内容不入仓库             |
| R6 分阶段/扫描/字节/最大记录/峰值                | 最终六份 benchmark 报告 + 同 SHA 输入形状报告；见下表                                                                      | PASS，范围限制见下文               |
| R7 受控 epoch 恰好交接/外部失效                  | restore-journal 单测、scoped 恢复集成及新增深层 epoch/刷新 epoch 放弃断言；最终全门/native/cold                            | PASS                               |
| R8 原生 approve/start 深层读取与严格前缀         | 恢复集成共享 proof/UI、默认 live admission 仍新鲜；单测严格 branch/nodes/leaf、未来/兄弟拒绝；最终 native/cold             | PASS                               |
| R9 内存/setup-only 零读取及非法缺文件拒绝        | restore-journal 与 events 测试；owner-free 已有文件实际严格读取                                                            | PASS                               |
| G1 原功能/安全门/覆盖率/独立审阅                 | 1986 测试、12 smoke、7 native、22 cold、两次定向复审与最终指纹检查；package/lock/门配置未改                                | PASS                               |

## 4. 最终资源结果与限制

基线/候选使用相同 Node v25.9.0、SDK 1.4.0、驱动、输入、selected leaf；每组恢复投影相同。驱动执行生产 session_start/严格 reader，但上下文为物理输入构造的只读内存视图，并非实际 SessionManager 的完整 Pi 进程；真实 SDK 兼容性另由 native/cold 覆盖。

| 输入               |    文件字节 | 基线读取字节/扫描 | 候选读取字节/扫描 |      恢复 ms 基线→候选 |
| ------------------ | ----------: | ----------------: | ----------------: | ---------------------: |
| synthetic 10       |      84,657 |       338,628 / 4 |        84,657 / 1 |            11.10→23.27 |
| bounded legacy 200 |  29,581,968 |   118,327,872 / 4 |    29,581,968 / 1 |          575.55→338.71 |
| read-only L1       | 369,023,966 | 1,476,095,864 / 4 |   369,023,966 / 1 | **16,289.84→5,128.02** |

L1 最大 JSON 记录 **1,084,716 字节**（不含换行）；整个隔离基准进程峰值 RSS **1,486.43→1,056.27 MiB**，不等于恢复专属分配峰值或真实 Pi 内存。导入、输入解析、恢复各阶段原始时间保存在报告中。缓存为暖状态、机器负载未隔离、最终代码仅此轮配对；先前阶段的多轮结果保留为历史证据，不偷换为最终指纹的多轮统计。

小输入存在固定开销回退。一次预算仅用于稳定无写恢复；确认 commit、legacy gap 等必要写入保留额外新鲜证明。没有测整个实时 `/reload`、没有保证固定 reload 时延、没有清理现存 352 MiB 历史文件，也不宣称 OS 事务或抵御恶意同元数据修改。

## 5. 保护状态、授权与交付边界

- 已装 Supervisor 内容寻址包 `52b83558…` 及其引用保留，候选未安装。项目/worktree package、lock、tsconfig、coverage/lint 门未修改，共享 node_modules symlink 只复用。
- 原 main 的后续外部提交未合入候选；不恢复、覆盖或合并他人改动。将来整合到新 main 必须再验证，当前接受仅针对基线 3c19f55 的独立候选。
- 已记录的外部漂移保留：全局 SDK 从 1.3 到 1.4；项目 provider 配置的早期变化；隔离安装前 08:04:51 的全局 settings 变化。最终核对绑定已观察 hash，不冒称最初 hash 从未变，也无旧完整 settings 快照可断言只有某字段变化。
- SDK 1.3 测试环境唯一安装例外来自原生授权 `decision-0752522d-ed33-44ca-9ab6-754e12efa5d9` / control `2d507932`，仅位于独立产物目录 `test-hosts/sdk13/`，禁用安装脚本；本批复用它，没有新增安装或扩大授权。
- 等待 reviewer 引起的停滞暂停与之前用户中止均由用户显式 recover；主控未自行恢复、修改账本或重置预算。后续实际工作与复审并行，不重复初审、不用空确认冒充进度。
- 本任务未提交、push、merge、生产安装、真实 reload、真实目标 journal 写入或 C 历史迁移。真实日志及摘录不进入仓库或包。

交付位置即上述独立 worktree、完整 diff（包含 untracked 新模块/测试/文档）和私有最终证据清单。后续部署或历史瘦身须另行授权；没有将其列为本任务已完成操作。
