# 回执存储修复验收记录

状态：**PASS — 本地实现和要求的验证已完成；未提交、推送、发布或安装。**

## 1. 候选身份与范围

- Worktree：`/home/ygguo/agent-projs/agent-ext/pi-task-supervisor-worktrees/receipt-retention-plan`。
- 分支：`docs/supervisor-receipt-retention-plan`；基线 HEAD 仍为 `f6d3c7f6cab37bae2f0cb4b63024cb5eae8053ce`，当前交付为明确的未提交 diff。
- 最终代码/测试/构建配置指纹（SHA-256）：`e2578137d0aca2bf91ab7adc2071ef8cc31c7dd647bde5b596e5f33b4fc3e48c`。
- 冷测冻结树指纹：`18910e21d2e965755b9365d66a28036e5ab7ac6d12711f7ed65fe4c8a767512f`，快照包含 87 个文件，不含 `node_modules`。冻结后源码哈希逐项复核未变；本记录和结果文档的后续更新不被混称为源码变化。
- 主工作树另一个任务的未提交 v2 没有覆盖或合入。本候选写 v3、读已发布 v1，不假设 v2 兼容；最终跨候选整合必须另行处理。
- 开发依赖仅临时链接复用，未安装/新增依赖，链接已移除。旧目标已由用户 stop，旧 5/5 任务、bindings 和 500 条回执未清空，不作为本次接受凭证。

原始本地证据：`/tmp/pi-supervisor-receipt-g0-E3eXVQ/`。该目录是真实本机验证产物，不是 npm 包内可移植的通过证明。

## 2. 最终执行结果

| 检查                                | 结果                                                                                           | 证据                                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                     | **PASS：737 tests / 35 files，分支 90.14%**；statements 93.86%、functions 98.51%、lines 96.39% | `check-final-candidate.log`；原有四项 90% 门保持不变，含 typecheck / lint / source format                                                         |
| 开发 SDK 1.1 冒烟                   | **原有 8 + 新增 3 = 11 模式 PASS**                                                             | 同一完整 check 日志中的 11 个结构化 PASS                                                                                                          |
| 无包内依赖的 SDK 1.1 冷加载         | **11 模式 PASS**                                                                               | `final-cold/sdk11-*.log`                                                                                                                          |
| 无包内依赖的实际宿主 SDK 1.2 冷加载 | **11 模式 PASS**                                                                               | `final-cold/sdk12-*.log`                                                                                                                          |
| 稳定旧版拒读 v3                     | **SDK 1.1 / 1.2 各 1 项 PASS**                                                                 | `final-cold/sdk11-old-reader.log`、`sdk12-old-reader.log`；旧版禁用 task 工具并显示无效 journal，不静默退化                                       |
| 冷测身份/配置/源码保护              | **PASS**                                                                                       | `candidate-manifest.json`、`final-cold-results.json`：22 个主场景 + 2 个旧 reader 场景均绑定同一 codeHash，每次真实 settings 未改变，快照源码未变 |
| 资源实验                            | **100 → 1000 → 5000 逐级 PASS**                                                                | `resource-accepted-{100,1000,5000}.json/.log`；先有代表样本再扩大                                                                                 |
| 包装检查                            | **PASS（dry-run，不是发布）**                                                                  | `package-dry-run-final.json`；原始测试、依赖目录、Git/运行态元数据不得打入包                                                                      |
| 变更范围与文档                      | **PASS**                                                                                       | 最后复核工作树/基线、源码指纹、格式、链接、`git diff --check`；只改本 worktree 和隔离验证产物                                                     |

### 资源结果的准确含义

| 回执数 | 编码账本字节 | 相对半规模增长 | 缓存条数 | 缓存字节 | 定位索引数 | 实测耗时 ms |
| -----: | -----------: | -------------: | -------: | -------: | ---------: | ----------: |
|    100 |       94,466 |         2.0008 |      100 |   33,390 |        100 |        46.7 |
|   1000 |      947,667 |         2.0007 |      128 |   42,880 |       1000 |       252.1 |
|   5000 |    4,751,667 |         2.0014 |      128 |   43,008 |       5000 |      1007.7 |

这是**真实 SDK 内存 journal 路径的编码字节与时间**，不是磁盘 fsync/延迟基准。固定任务、绑定及单条负载，全文分支扫描只由试验中/末两次计量触发，不逐回执全扫描。缓存为有界原始体；定位索引与 Pi 本身日志仍随历史增长，不声称整个插件或会话恒定内存。实际持久文件的写入/重开另由冷测与迁移/intent 模式覆盖。

## 3. R01–R18 逐项闭包

| ID  | 结果 | 主要证据 / 测试面                                                                                                       |
| --- | ---- | ----------------------------------------------------------------------------------------------------------------------- |
| R01 | PASS | real SDK journal 的 501 条回归、已有失败结果用例、1000 读模式、5000 资源实验；不触发累计数 fault                        |
| R02 | PASS | 单条缓存淘汰后的旧证明读取；native 旧目标迁移保留已完成任务 binding 并最终接受                                          |
| R03 | PASS | 先验证、1000 次只读调用后再提交完成，缓存淘汰不丢审查证明                                                               |
| R04 | PASS | 原有伪造、错误/缺退出码、旧版本与旧 task digest 测试；归档缺失立即锁 journal fault，不能继续任务推进                    |
| R05 | PASS | 冷缓存重复结果幂等/冲突拒绝；完整宿主 ID 保留；账本 hash、顺序和 scope 校验                                             |
| R06 | PASS | append 抛错、no-op、提交后抛错及不合法宿主 ID；执行前技术阻止，不写畸形记录，不把 SDK blocked result 当执行成功         |
| R07 | PASS | 接受后 intent 未闭合/结果丢失不能重启恢复为已接受；宿主结果原始结构仍保留                                               |
| R08 | PASS | receipt 已提交但缺检查点、或提交确认异常，重放一次、不重复执行                                                          |
| R09 | PASS | close_unknown、迟到结果的持久 freshness barrier、未知结果不伪造 proof，native intent 中断/显式恢复                      |
| R10 | PASS | 并发修改重叠、opaque 父调用/子验证、审查前启动的验证被拒绝；独立新验证才能完成                                          |
| R11 | PASS | 2/500 条 v1 锚点测试及 native 500 条迁移，旧锚点/使用量/bindings 保留，推进 epoch 并取得新证明                          |
| R12 | PASS | stopped/完成态保留、faulted completed 不重开；不支持的格式锁定，真实旧版在两个 SDK 上拒读 v3                            |
| R13 | PASS | sibling 分支不能取证、同文本新目标 ID 隔离、同 ledger ID 不可改 goal scope；原有 restart/fork/新会话冷测                |
| R14 | PASS | 原有压缩、abort、普通 pause、async wait 模式；未知 intent 不能 ordinary joint resume 越过，需显式 recover               |
| R15 | PASS | 缓存条数/UTF-8 字节、单条超预算绕过缓存、无效配置、原始体回收；不增加累计执行预算                                       |
| R16 | PASS | 最近 30 条不受小缓存误裁剪、绑定证据不缩短、原有 ASCII/CJK/超大保护材料与 64,000 字节门                                 |
| R17 | PASS | 多实例/预检授权原有测试、status 只读、捕获失败保留宿主 structuredContent；重复错误不刷旧接受告警，显示当前 capture 诊断 |
| R18 | PASS | 有界缓存、原始体一次追加、小检查点；100/1000/5000 编码字节增长门与扫描次数断言                                          |

## 4. 自查与原始失败记录

没有新增正式外部 reviewer，也不宣称第二次独立审查批准。主控在与编码分开的候选 blocker 自查中实际复现并解决了：

- 累计 501 条死锁：`cap-red.log` → 新账本回归及最终 check。
- 原始 append 后才验证结构、可能污染历史：`prevalidate-red-real.log` → `prevalidate-green.log` / 最终 check。
- 迟到结果只报错而没有持久化版本失效：`late-gap-red.log` → 持久 `close_unknown.resultGap`，不冒充工具成功或人类恢复。
- 缓存淘汰后归档读失败没有立即锁全局任务门：`archive-fault-red.log` → 锁 journal fault / 最终 check。
- 新错误反复刷已有接受告警：`old-warning-red.log` → 当前错误附在工具结果中，保留结构化宿主结果，既有 fault 不重复通知。
- 同一账本身份能被新检查点改写目标：`goal-identity-red.log` → 不变 session/goal/model/preflight tuple、运行态和恢复校验。
- 旧锚点类型、位置、digest、scope 与派生身份校验；普通 resume 绕过未闭合捕获的风险。

保留的非通过记录不会被算作最终 PASS：

- `coverage-first.log` / `coverage-second.log` / `coverage-third.log` 分别因 89.76% / 89.95% / 89.99% 未达 90% 失败；补的是合同失败路径，没有降低阈值。后续第四次达标，最终为 90.14%。
- 一次 120 秒命令超时已检查无残留验证进程；随后单项与整专项重跑通过，没有把超时当成功。超时原因未被伪称为已定位。
- `prevalidate-red.log` 是移除开发链接后的 test-runner import 启动失败，不是逻辑 RED；恢复链接后 `prevalidate-red-real.log` 才是有效缺陷复现。
- 首次 SDK v3 smoke 失败是旧 inspection helper 仍把检查点的空 receipts 当整个历史；修正观测辅助，不改变实际验收断言。
- 旧 reader 的首次辅助断言读取了错误通知通道；最终从真实持久 custom_message 核对，并保持任务禁用断言。

## 5. 明确限制与交付边界

- 本次没有合并另一工作树的 v2，最终整合/发布须审查两候选的格式关系；不能直接宣称可无冲突合并。
- 新格式为 v3，支持已发布 v1 读/显式迁移，不提供向下转换；包降级不等于可用旧程序写 v3 会话。
- 原有 100 任务、40 检查、20 自动续跑、三次停滞和 64,000 UTF-8 字节受保护证据包限制仍有效；移除的只是累计 500 回执死锁。
- 监督仍按会话/显式目标，不自动推断 cwd 权限或替用户启停目标。跨 worktree 不等于新监督目标；后验潜在修改仍会使已接受工作失效，不能用自动退出规避。
- Node 25.9.0，实际 SDK 1.1/1.2；没有重新认证 Node 22/24 或干净 peer 安装。raw-cache 预算不是整个进程内存上限；无 OS 沙箱/fsync 保证。
- 所有新 SDK 场景是 isolated faux-provider / UI stub，不是业务进程、真人授权质量、实时模型遵循或真实 TUI 的认证。
- 本任务未改安装配置、凭据或业务会话；开发链接已移除。旧任务历史未清理，当前安装没有因源码修改而自动升级。
- 实施包、计划、README/CANARY/CHANGELOG 与本记录已同步。未提交/推送/发布/安装；若用户要求交付部署，主控下一步先核对并行候选整合策略，再按单独授权办理。
