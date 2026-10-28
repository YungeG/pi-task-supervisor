# 集中审批工作流：冻结候选验证记录

2026-10-28。**计划内源码候选验收完成：独立只读审阅最终返回 OK，Main 已核对全部发现处置、当前验证与审阅前后身份，完成 F。** 接受范围仅为本页冻结的未提交源码候选，不包含安装、发布或真人/产品接受。无需用户操作；没有提交、安装、重载或操作业务会话。

本页前文保留最初冻结候选的历史验收事实；后续手动绑约 UI 修补单独记录在[文末追加记录](#后续修补手动-review-contract-单列审核)，不沿用原候选的审阅结论。

## 候选和范围

- 源码起点/当前 HEAD：`0f8f5f83e01a9db1d1e2c4662046471797897ab0`，未提交修改，仍只有 main 一个工作树。
- 冻结源码/测试/配置：251 文件，摘要 `efcac46227bd808a1ec94265b0f6d293a1ce7e6115caa553b82efcb3244b9b32`。
- 逐文件身份和执行证据目录：`/home/ygguo/agent-artifacts/pi-task-supervisor/approval-workflow-20261027-E3V0Hk/`，下文文件名均相对此目录。
- `candidate-pre-review.json` 是源码身份，不用只包含已提交内容的 HEAD 代替未提交候选。最终完整门后逐文件复核无漂移；本验证文档/索引另行记录，不改变上述源码身份。
- Main 始终是唯一代码写者；获准后仅使用一个独立只读审阅器及其同一会话的针对性恢复，没有实现代理、并行 worktree 或 workflow。没有提交/推送、依赖安装、扩展重载、发布或业务会话操作。

## 同一候选的完整门

`npm run check` 返回 0，完整输出 `check-q-final-candidate.log`：

| 检查            | 实际结果                    |
| --------------- | --------------------------- |
| TypeScript      | 通过                        |
| ESLint          | 通过；没有降低规则          |
| Prettier `src/` | 通过                        |
| 测试            | **136 文件、3219 用例通过** |
| Statements      | 93.29%（13559/14534）       |
| Branches        | **90.02%（13325/14802）**   |
| Functions       | 98%（2656/2710）            |
| Lines           | 95.38%（12160/12748）       |
| 标准 smoke      | 13 分支全部通过             |

覆盖率阈值没有修改；分支覆盖率刚达到既定门槛，后续修改仍必须重跑，不能把这个数字等同于安全证明。早期 89.5%、89.75%、89.84%、89.92%、89.99% 的失败与中间绿灯保留，但不是当前通过依据。

13 个标准 smoke 覆盖 task-only、监督、批次继续、压缩/中断压缩、native abort、普通暂停、异步执行、当前集中 preflight、1000 条读取回执，以及 v1/intent/v2 回执恢复。扩大执行前先运行了 8 条读取/回执的小样本。现行 preflight smoke 通过正常 `propose_contract → submit_preflight`，不再靠 recognized-host 后备绑定替代新流程；普通 SDK 的 argv/TTY/UI 在该 arm 明确为模拟，不是 CLI 证据。

## 两个实际 CLI/PTY 正向分支

使用安装在本项目的实际 Pi 1.1.0 CLI、真实双 TTY、隔离 session/agent 目录、离线 faux model 和自动按键；没有替换 argv、TTY、UI 组件、原生完成握手或 SDK 执行准入。

```sh
python3 test/goal-native-smoke.py approval-existing --out <隔离产物目录>
python3 test/goal-native-smoke.py approval-preparation --out <隔离产物目录>
```

| 场景                             | 实际来源/结果                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 已有 Python 定义、未来产物未生成 | 未读 Enter 不提交；Esc 不产生批准；重开并改变真实 PTY 几何后重新阅读；一次业务批准，独立一次 Start；创建产物、实际注册 `run_check`、当前版本证据与监督完成                                       |
| 本任务准备检查器                 | 原批准覆盖精确准备/后续范围；Start 后在未编译 draft 上用真实工具创建检查器；保持 advisor hold，原生审核具体定义；显式 recover 后编译/执行/取得原始检查证据；没有再次批准未变业务权限或再次 Start |

当前候选的原始证据：

- `cli-q-final-existing/owned-hnl86b6n/verified.json`、`completed-0.json`、`session.jsonl`、`terminal.log`。
- `cli-q-final-preparation/owned-_rsycrxx/verified.json`、`prepared-*.json`、`reviewed.json`、`completed-0.json`、`session.jsonl`、`terminal.log`。
- 两个场景均检查原业务批准和 Start 各一条、定义关联 authority、实际 pid/close/exit、Python 测试结果和临时目录清理；准备场景另检查原暂停/计数和原批准不变。

**限定证明**：这是首个正常 public preflight owner 的源合格合成任务完成，不是现有业务会话或真人批准。较新 GoalRun 的 seed/冷恢复有专门源码/SDK测试；另在 `cli-q-final-goal/owned-66myj2a5/verified.json` 用实际 CLI 验证了从旧历史创建 GoalRun、真实 seed 镜像、一次联合批准和独立 Start（没有执行任务或宣称最终完成）。本报告不把这些限定场景冒充所有 GoalRun 最终审查变体。没有进行真人视觉评价、SSH 网络链路体验或产品接受。

## 契约逐项核对

| 契约   | 实现/验证依据                                                                                                                               | 仍保留的门                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| C-ID   | 原提案引用/原生 source、完整 permission scope、完整阅读期间版本变化拒绝；`approval-workflow.test.ts` 与真实 CLI                             | 模型字段、局部草稿、复制 NativeAnswer 不是权利     |
| C-DEF  | future output 不阻止定义确认；原始确认在独立 Start 后关联实际 owner；更新使用定义控制而非重收未变权限                                       | 定义确认不是产物或手工检查答案                     |
| C-PREP | 两个实际 SDK 和 CLI 分支；未冻结具体定义时禁止编译/managed 执行；review 不清 pause，显式 recover 才继续                                     | 未选中的准备权限不会因 Start/定义确认补齐          |
| C-ACT  | 缺材料归 Main；过期定义、拒绝、撤销、工作区身份变化、关联修复各有准确动作；额外准备权限明确给出真实可执行的选择命令                         | 投影无文件捕获/源扫描/准入副作用，执行入口重新验证 |
| C-EVI  | 有限 Node/Python，真实 before/after generation、pid/close/exit、私有原对象、正式 SDK 消费；Python SQLite/FD、越界读写/网络/process/环境拒绝 | stdout/DTO/旧成功或未知 close 不产生合格证据       |
| C-VIEW | 原始组件选择、冻结对象归属、长文/中文/窄屏/取消/resize、64KB 材料与16KB捕获容量拒绝，原生最终完成链                                         | 浏览/草稿/原型不产生批准；未声称真人可用性         |
| C-WIRE | 新特征 envelope 先于 payload；真实旧 producer fixtures、旧 reader 拒读、暖/冷精确修复、故障不重放/不清其他 hold                             | 必须重新验证原控制/物理见证；不把修复当恢复执行    |

重要的补测修复：

1. 冷导入的 schema/controller 循环：提取无 controller 依赖的 `approval-schema.ts`，没有掩盖导入错误。
2. 历史范围账本：保留原 header/cwd；旧 fixture 不制造当前 SDK 成功来源。
3. Python test ID：提案与执行预览共用语法校验，要求在完整 module 后仍有 TestCase owner 和 `test_*`；运行时仍验证实际类/方法，不支持 discovery/factory。
4. 同步方法实际执行：真实进程 RED 证实标准 unittest 曾把 async/generator/async-generator/返回 TestSuite 的方法计为成功；固定 bootstrap 现在拒绝这些方法、异步生命周期和自定义内部执行派发，方法/cleanup 必须实际完成并返回 None。新增 7 个真实进程拒绝用例，两个 SDK/CLI 正向与包内执行重新验证。自检前的 3173 用例候选不作为本版通过证据。
5. 缓存详情不再把 Python profile 显示为 Node。
6. 已选准备缺额外权限时不推荐必定失败的 Start；给出需要明确新选择的准确审核命令，不自动扩大批准。
7. 精确关联修复在任何派生事实写入前复用 reader 的冻结定义匹配规则；旧确认之后代码或 workspace 改变，拒绝无写入修复，不能写入刷新后的定义污染后续恢复。声明/绑定 acknowledgement loss 的暖/冷正例仍通过。

## 独立审阅与发现处置

用户已明确允许一个只读审阅代理，没有启动并行 writer。第一轮因只读角色没有 shell、无法自行计算文件哈希而停止，报告保留于 `independent-review-infrastructure-block.md`；这不是代码通过。由 Main 实时校验全部250文件/HEAD/保护文件并承诺审阅后再查，保持同一审阅器只读分析，不赋予 shell。审阅者明确区分 Parent-live-verified 身份与自身独立代码判断。

实质首轮报告：`independent-review-a8199960.23405998.md`，覆盖原 a819 候选；主控在复核其后无源码漂移后开始修复。下列均经实际 RED → GREEN，不把先前3180用例绿灯套用到新候选。

| 项             | Main 复现与最小修复                                                                                                                                                 | 证据                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q1 P1          | 完整 `TestResult.wasSuccessful()` 决定exit；fixture errors/failures诊断有界保留。class/module teardown/cleanup失败不能借单方法通过而合格，真实SDK负例验证任务不完成 | `q1-fixture-errors-red.log`、`q1-fixture-error-sdk-consumption.log`                               |
| Q2 P1          | 模块/类hook与cleanup复用同步/None完成规则，保留标准suite顺序、继承绑定、cleanup参数和可选None hook                                                                  | `q2-module-lifecycle-red.log`、`q1-q2-lifecycle-matrix.log`、`q-fixes-core-green.log`             |
| Q3 P1          | reader只接受无批准/Start/定义控制的准确material-only形状及其真实撤销；冷恢复后可补材料继续，旧/有契约/声称批准却缺请求仍拒绝                                        | `q3-pending-contract-restore-red.log`、`q3-material-revocation-red.log`、`q-fixes-core-green.log` |
| Q4 P1          | 从当前owner缺绑定派生阻塞，不靠易失fault；`recover`、Main派发与非只读工具共用入口规则。明确pending-checker准备单独保留，修复不清暂停预算；冷态改码不得写入关联      | `q4-cold-recovery-red.log`、`q4-associated-admission-green.log`、`q-fixes-core-green.log`         |
| Q5 P1          | 原预检验收条款与正式契约条件分开完整显示；同时明确实际工作区、逻辑scope与准备check IDs，实际组件sentinel验证                                                        | `q5-complete-native-material-red.log`、`q3-q5-q6-green.log`                                       |
| Q6 P2/契约要求 | retained preflight在写bundle/preparation新字段前先发布envelope；fence失败不保存新payload                                                                            | `q6-retained-envelope-red.log`、`q3-q6-reader-envelope-green.log`                                 |

新生产改动相对已核验的 a819 包内原文件生成于 `q-production-fixes.diff`，并非只比较HEAD而遗漏未提交文件。完整验证与CLI/包装均已在页首新摘要上重跑；同一审阅器后续指出的遗漏及最终结论见下一节；首轮绿灯不替代这些处置。

### 针对性复核与最后修复

第二次报告 `independent-review-a8199960.23405998.1fcb9883.md` 确认 Q1/Q2（原报告漏洞）/Q3/Q5/Q6 已修复，但指出 Q4 还遗漏自然 settle 边界，以及 cleanup 包装器的关键字兼容回归。Main 校验 dff4 候选审阅期间无漂移后再次复现：

- `q4-native-boundary-red.log`：真实 scoped GoalRun 的 Start checkpoint 已保存、started projection 保存失败，单独修复投影后 Supervisor 仍 active；`reviewSupervisor` 与 `agent_before_settle` 两条入口均会调用 advisor 并把 reviews 从0改为1。现于 `reviewSupervisor` 的预算/`prepareReview` 之前复用关联门，保存 acceptance_pending 暂停；`supervisedBoundary` 在异步建议返回后也复核门，不产生继续指令。新增 `approval-association-boundary.test.ts` 的两例验证无 advisor/预算/派发，随后仅精确关联修复可解除该屏障。
- `q2-cleanup-keywords-red.log`：合法 callback 关键词 `function`/`cls`/`method` 被包装器消费。现仅将三处内部簿记参数改为 positional-only，保持标准 unittest 转发行为；真实 Python 正例覆盖 module/class/instance cleanup。
- `q-final-boundary-cleanup-green.log`：四个相关文件139例通过；其后整个新候选的完整门、CLI/PTY、SDK负例与包内进程全部重新通过，见本页当前摘要及结果。

最后针对性复核已返回 **Merge verdict: OK**，无剩余阻塞或非阻塞发现。完整报告为 `independent-review-a8199960.23405998.1fcb9883.d81902c0.md`，等字节副本 `independent-review-final-efcac462.md`。该结论与前两轮相接，确认原1–6项处置及 settle/kwargs 修复；不是每个文件的重新穷举审计。审阅只读、未执行测试，文件身份由 Main 实时前后验证，未声称审阅器自行计算哈希。

## 兼容、包装和来源边界

- 原提交 `0f8f5f8` 的实际 `control-journal.ts` 摘要与 Git 原文核对后，对本次真实 CLI session 调用旧 reader：`CONTROL_FORMAT_INVALID`，物理 journal 不变，没有静默降级。见 `retained-reader-verified.json`。
- 普通 SDK 在真实双 TTY 中被拒绝，UI/model 调用为零，没有新权利且 journal 不变；见 `sdk-q-final-denial/owned-ysx4ph58/sdk-denial.json`。这与 SDK 模拟 native 的正向 harness 严格区分。
- `npm pack --ignore-scripts` 的实际归档包含 bootstrap、不含测试；校验 tar integrity/路径后，解包模块使用现有 peer 依赖运行实际 Python，参数精确指向**包内** bootstrap，实际 close/exit0 且 scratch 已删除。见 `package-native-YacbYC/verified.json`、`package-q-final-candidate.log`。这是包装/runner 机械验证，不单独证明 SDK 资格。
- 当前实际宿主：Linux、Node v25.9.0、非 root、`/usr/bin/python3.13` 3.13.5。其他平台/运行时被明确拒绝，不声称跨平台通过。没有引入第三方 Python 库或新依赖。
- Python audit/资源/SQLite 限制仅用于已审阅的良性检查器，**不是恶意原生代码安全沙箱或 OS-原子文件系统快照**。

## 保留项与下一操作

受保护文件摘要未改变：

- `.pi/extensions/pi-provider-service-tier.json`：`1b0a684a0fbe1acbdf0dd16c9156950747d8da6a3b8897a6b6ec7b66f2c41b63`。
- `docs/supervisor-journal-growth-and-restore-repair-plan.md`：`5c8dd321218b37ae2ef9827f034e5b53f9a7892e852ecab765a7a6b04939aa03`。

**Main 最终接受（F）：** 当前251文件摘要与审阅前完全一致，HEAD/单一工作树/两项受保护文件未变；再次检查实际CLI journal中的唯一批准/Start、完成状态、实际pid/close/exit与scratch清理，包的SHA-512完整性及bootstrap字节也匹配当前源码。证据为 `review-parent-identity-after-final.json`；原始完整门和最终审阅报告的SHA-256记录在该凭据中。C-ID/C-DEF/C-PREP/C-ACT/C-EVI/C-VIEW/C-WIRE的本轮要求、两个必要分支和发现处置已闭合，无已知必须完成而遗留的工作。

本轮授权范围内的源码候选接受完成，后续不再自动修改或派发。仍未提交、推送、安装、重载、发布或操作业务会话；这些需要新的明确请求。真人可用性、产品/业务接受、非已声明宿主和恶意代码隔离不由本次结果推断。

## 后续修补：手动 review-contract 单列审核

2026-10-28，用户要求修复手动绑约可读性。此前集中审核只覆盖前置 `approval-bundle`；手动 `reviewAcceptanceContract` 没有 material，仍走旧的全文分页和“选项 1/2”弹窗。已安装新包不等于这条入口已改善，也不能用最初的 UI 测试代替此入口验收。

本次以 `97a3430e2b7a16c5b2393b25553d00799ff8c9bf` 为起点修补，Main 单写者、自检，没有复用前轮独立审阅 OK 或操作被诊断的业务会话：

- `acceptance-runtime.ts` 指定内部 `contract-definition` 用途，`human-ui.ts` 将其路由至原生单列 `ApprovalReview`，不再使用 legacy ordinal popup。
- 同一审核文档持续显示 **Enter 绑定当前定义 / r 不绑定 / Esc 稍后**；不显示权限复选或建议再次 Start。未完整展示材料、取消、窗口变化或源版本过期不能绑定。
- 范围、工作区、验收条件和通过要求先列出；身份、版本、固定执行元数据按层级字段列出而非大块 JSON。技术字段仍属于完整材料，没有裁剪或绕过阅读门。
- 组件结果仍仅为原问题登记的私有本地选择。Host 将其映射为原有 `outcome: answer` 与“绑定此契约”/“不绑定”，不是 business approve；契约/物理见证 codec、源新鲜度、已批准范围、Start、暂停、撤销和预算语义未变。复制 DTO、错误 kind/owner/options、携带 approval 或非法/超量文本均拒绝，不退回旧弹窗。

新的证据目录：`/home/ygguo/agent-artifacts/pi-task-supervisor/manual-contract-ui-20261028-hTIp7R/`。

- `manual-contract-ui-red.log` 通过实际手动 review 入口复现旧路由，随后原生组件与命令回归通过。
- `check-final.log`：`npm run check` 返回 0，**137 文件 / 3239 用例**，标准 **13 个 smoke 分支**全通过；statements **93.32%**、branches **90.05%**、functions **98.04%**、lines **95.4%**，未降低阈值或规则。中间门发现 null purpose 被误当默认值，已恢复“仅 undefined 可取默认”的拒绝边界，并重跑完整门。
- `cli-host-1.4-manual-accepted/verified.json`：实际全局 Pi **1.4.0** CLI、真实 PTY、离线合成任务；**80×24** 未读 Enter 拒绝，Esc 稍后、r 不绑定均保持原批准及完整 supervisor 状态；重新审核完整材料，再改变真实几何为 **100×30** 后必须重新阅读；成功绑定仍保持暂停，显式 recover 后才执行。业务批准/Start 仍各一条，实际 Python check 与最终完成合格。
- `cli-host-1.4-existing-accepted/verified.json`：原有定义的集中审核/独立 Start/实际 check/完成分支仍通过。项目 Pi 1.1 CLI 的准备分支另在 `cli-local-preparation-verified/owned-qeexbcjf/verified.json` 通过。

以上是真实 CLI 下的自动按键和隔离合成任务，不是真人视觉评价、SSH 网络体验或业务接受。本次修补**尚未提交、安装或重载**；当前全局配置仍指向原 `97a3430...` 安装包，不能要求用户仅重载同包来获得此修复。原业务会话无需重建目标、重批未变权限或重复 Start。
