# Supervisor 恢复、执行证据与 off 模式修复实施计划

2026-10-29，计划 v4。**本轮共8项：6项行为修复＋2项接口简化，现已完成源码实现和完整源码门；包验收及发布状态见第9节。F7、F8正式包含用户要求的兼容命令入口删除，不再保留旧命令别名、转发或直接启动捷径。旧历史数据的读取与来源验证仍保留。此文仅冻结计划范围，不是开始实现、提交、安装、重载、派发代理或恢复业务会话的授权。**

**后续执行许可：** 用户已通过当前 Goal 明确要求“按照计划推进至完成”。Main按本计划实施与隔离验证。用户后续另行明确授权提交、推送、然后本机安装；重载当前/业务会话、恢复业务及npm发布仍不在本轮授权中。[W0实施契约](./supervisor-recovery-and-mode-implementation-packet.md)记录具体接缝和阶段门。

## 1. 当前基线与状态

- 源码基线：`95cb9d77c7dbc5cf944590c37f127a87d135ccb7`。
- `95cb9d7` 的手动契约审核单列 UI 修复已经本地提交，尚未安装；不要重新列为未实现，也不要把它当作以下8项已经实现。
- 形成本计划时全局配置使用 `97a3430e2b7a16c5b2393b25553d00799ff8c9bf`。用户后续已授权通过验证后提交、推送并安装；本轮不重载当前/业务会话，不自动恢复业务。
- 新一轮事实依据：
  - 恢复链路审计：`/home/ygguo/agent-artifacts/pi-task-supervisor/recovery-audit-20261028-hObgOM/REPORT.md`。
  - off 审计：`/home/ygguo/agent-artifacts/pi-task-supervisor/off-audit-20261029-BlUcdp/REPORT.md`。
- 旧计划、冻结候选验证和部署记录保留为各自历史事实。本文件是这8项后续工作的单一计划入口，不覆盖历史接受记录。
- 上述审计是本轮历史RED依据；对应源码路径现已修复，本轮新证据见第9节。原3239个测试、115条恢复相关回归和109条管理模式回归的旧绿灯不作为本轮修复验收。

## 2. 计划冻结时列项（表内为当时状态；当前完成证据见第9节）

| ID  | 修复事项                            | 用户可见结果                                                                     | 状态           |
| --- | ----------------------------------- | -------------------------------------------------------------------------------- | -------------- |
| F1  | 已启动目标的范围修订与恢复路径      | 当前目标遇到准入条件变化时可精确审核变更，再显式恢复，不被错误引导重新 preflight | 待实施         |
| F2  | 默认 codemode 与证据能力不匹配      | 运行前知道实际可用的正式检查通道；没有合格通道就提前说明并阻塞                   | 待实施         |
| F3  | 预算耗尽后的 recover 循环           | 额度耗尽不伪装恢复成功，不再建议同一个无效 recover                               | 待实施         |
| F4  | 直接工具被当成容器校验              | bash/write 等按真实类型记录与解释，不再泛报容器资格不足                          | 待实施         |
| F5  | off 在首次对话落盘后丢失            | 首次聊天前 tasks-only→disable，之后落盘、重载，仍然保持关闭                      | 新增，待实施   |
| F6  | off 状态错误提示 enable             | 关闭被展示为正常未托管状态，不再提示必须重新开启或等待监督检查点                 | 新增，待实施   |
| F7  | 统一 supervise 主入口并删除兼容命令 | 显式重规划与已启动范围修订分开，不再保留 preflight 等旧入口                      | 新纳入，待实施 |
| F8  | 以 tasks-only 取代 enable           | 名称明确表示仅任务看板，删除旧 enable 入口，tasks 继续只读查看                   | 新纳入，待实施 |

F1–F6的设计见第4节；F7、F8的正式设计与验收见第8节。两项接口简化现已纳入本轮必做范围。

## 3. 不可改变的约束

1. 不放松 G0，不把目录时间戳变化推断为无害，不自动刷新或改写旧基线。
2. 原 Goal、任务 ID、首次 Start、未变权限、历史失败、旧证据和用量保持原身份。新例外需要原生明确批准。
3. 审核和修复投影不自动执行；恢复也不补授权、重启外部写者或清空预算。
4. 未闭合执行、未知捕获、撤销和未决原生控制优先阻塞，不因 off 或新修订丢失。
5. off 退出任务管理/自动监督，普通宿主工作按未托管处理，不借用旧 Goal 的权限、证据或记账。
6. off 不是强杀进程、完成任务、清空历史或安装卸载。未能安全释放时保持 `stopping-with-attention`，不冒充完全关闭。
7. 不伪造 builtin 来源、SDK 回执或 tools-only 能力；模型字段、脚本文字、复制 DTO 和报告文件均不是资格证明。
8. 旧 journal、hash 和来源强度保持不变。新行为不得通过重新解释旧记录产生新授权或 qualified 证据。
9. Main 单写者、一个工作树；不默认启动代理、workflow、并行 writer。任何独立审阅另按明确授权执行。
10. 合并入口、命令改名不合并规划/批准/首次Start，不新增业务权限，不改管理模式的内部标识或借改名隐式切换 owner。
11. 删除的是兼容命令入口，不是旧 journal 的读取/验真，也不是 submit_preflight 等仍有独立职责的模型工具；不得全局替换持久化的 continuous-tasks:\* 标识。

## 4. F1–F6：行为修复设计与验收

### F1：当前已启动目标的范围修订

**问题不是 G0 停止本身。** 当前 `beginPreflight` 拒绝未停止的 Supervisor/已有任务板，`reviewAcceptanceContract` 也仅适用于首次编译前；不能仅替换命令提示或放宽原入口。

方案：

- 新增独立的当前目标范围修订 Module，原 preflight 不覆盖，原 Goal 不重建。
- Main 提交不可信修订；用户原生审核只对本次变化授权；确认后仍暂停，之后显式 recover。
- 工具/命令：`propose_scope_revision`、`review-scope <proposalId>`、`repair-scope <proposalId>`、`revoke-scope <revisionId>`。本轮W4已在源码接入，仍待W6完整接受，尚未安装；不能据此在既有业务会话直接使用。
- 第一版限同一目标、工作区和既有权限对象内的明确约束/验收修订；不借此更换 owner、添加未选权限、扩展根路径/运行时能力或增加监督器硬预算。
- 对当前 G0 例外，只能确认列明的两项时间戳和值；不能采用“接受最新值”。其余528项 stat、159源码及其他保护继续生效。
- 原生审核完整展示原目标、原批准/Start、未变权限、本次前后差异、验收定义和风险。批准、拒绝、稍后均有明确标签。

来源与保存：

```text
不可信提案
→ 原生回应控制
→ 物理见证
→ 冻结定义和候选契约
→ 修订提交记录
→ 派生投影
→ 等待显式恢复
```

- 修订引用实际 owner、原批准/Start、上一有效范围/契约、本次提案/控制/见证及候选契约。
- 未有完整提交记录的候选契约不能被选为当前契约；持久化引用必须无循环。
- 回应或投影丢失只精确补原记录，不重问已保存的批准，不重放业务；材料变更不能借旧回应生成新版。
- 执行捕获、receipt、契约检查和最终证据消费关联当前修订；先前成功不自动适用于新条件。预算/epoch 不通过清零实现失效。
- 撤销修订不得自动退回旧范围继续执行。父修订撤销后，其后继依赖也不能继续借用该授权。
- 原来仅批准“形成例外方案”的决定不能升级成执行许可。原业务资源耗用未知也继续未知，不能用时间戳修订补齐剩余额度证明。

主要写集：新的修订 schema/控制/reader、`control-journal.ts`、`human-journal.ts`、`acceptance-journal.ts`、`acceptance-runtime.ts`、`commands.ts`、`human-ui.ts`、`approval-review.ts`、`receipt-store.ts`、`qualified-evidence.ts`及对应测试。精确新类型和 feature 列表在 W0 冻结。

验收：已启动、已编译且暂停的合成目标可在原 owner 内续办；原 Start 仍恰好一条；取消/拒绝/过期/跨 owner/半写/撤销不产生执行权；修订批准仍暂停，旧证据不能作为新修订的通过依据。

### F2：实际执行能力预检

方案：

- 从真实宿主读取来源、schema、暴露方式和有效工具模式，不依赖名称或模型自述。
- 返回 `direct-check`、`tools-only-container` 或 `unsupported`，同时给出具体原因与所需材料。
- 默认 models-enabled codemode 不颁发 tools-only 资格；优先选择真实可达的直接正式检查路径。
- 若工具模式隐藏全部直接入口，且没有真实受信的 tools-only profile，则提前阻塞。不能等执行后才发现无法形成要求的证据。
- 不静默修改用户全局工具配置，不删来源/能力比对，不伪造 `builtin` 或仅修改说明字符串。
- 原来安全的直接检查与已存在的严格容器路径分别保留；辅助批量操作不自动成为正式检查证据。

主要写集：`invocation-tree.ts`、`invocation-runtime.ts`、`scope.ts`、`flow.ts`、启动/恢复控制及真实 CLI 测试。

验收：隔离默认 CLI 必须保留 builtin codemode，不能全部使用 `--no-extensions` 隐去问题；项目 SDK1.1与实际宿主1.4覆盖正常直接路径、无合格通道的拒绝路径。若宿主不能提供真实 tools-only profile，明确不支持，不制造正例。

### F3：预算耗尽不再恢复循环

方案：

- 状态、resume/recover、自动继续与 Advisor 调用共享预算判断；包括实际额外 Advisor 调用，未知用量不按零算。
- 在修改 Supervisor 状态、关闭捕获或派发之前检查是否耗尽；耗尽则保持 hold，不先 active 后再次暂停。
- 不再推荐同一个无效 recover；明确展示用量、上限及当前版本支持的后续选择。
- 本轮不新增同目标预算充值功能，也不承诺不存在的追加额度命令。需要另立后续目标时保留旧目标全部用量/失败，且必须由用户明确决定。
- 普通尚有余额的恢复继续保留现有语义，计数不重置。

主要写集：`supervisor.ts`、`commands.ts`、`flow.ts`及相关预算状态捕获。

验收：40/40、continuation耗尽、额外调用耗尽、未知用量、正常余额各有直接控制测试；此前外部隔离预算复现应转GREEN，无状态伪恢复或继续派发。

### F4：直接根与容器根分别校验

方案：

- 按原始宿主调用类型区分直接 SDK 工具、合格 tools-only 容器、能力不足容器和来源不明调用。
- 直接 bash/write 不要求容器的 capability 和 `details.calls`；容器仍严格验证完整子树及副作用闭合。
- 分开表达“已观察到结束”“检查成功”“证据可消费”“目标通过”。不能仅为消除 held 就统一判 qualified。
- 如现有 seal 格式无法表达，采用新版本和 feature；旧 held 原字节保留，不倒推升级。
- 继续记录直接写者以判断并发与验证重叠，不为避免错误提示而删除因果节点。

主要写集：`invocation-tree.ts`、`invocation-runtime.ts`、`control-journal.ts`、`qualified-evidence.ts`及对应投影/完成意图测试。

验收：直接根不再返回虚假的容器错误；真实容器能力不足、失败、未知 close、未闭合子调用、写者重叠和验证后写入仍拒绝。不能从旧误报推断直接命令失败或凭此提升其资格。

### F5：off 停止意图持久化（新增）

已在真实 SDK1.1/1.4 的旧接口复现：首次聊天前 enable→disable，首次对话落盘后重开，旧 activation=true 使任务工具重新启用；落盘后再 disable 一次也未补齐。这里的enable仅描述历史证据；新实现用tasks-only复现同一模式转换，不为回归测试保留旧命令。

方案：

- 区分 `volatile off` 和物理确认的 `confirmed off`，不能把前者当作已完成持久化的幂等返回。
- 当真实会话来源可验证时，根据物理前缀、原 owner/board 和停止意图追加确认 off；不重写旧 activation，不凭缓存伪造确认来源。
- 覆盖首次对话落盘后的生命周期，不能只依赖下一次 tool_call；纯文本对话、无后续工具、正常关闭/重开也必须保留停止意图。
- 来源仍不存在时明确保持 volatile，不强称跨进程可恢复；一旦真正落盘必须正确承接。
- 来源不确定、未知捕获或未决控制存在时继续 `stopping-with-attention`；不为持久化 off 清掉这些事实。
- 已确认 durable off 的重复 disable 仍应无额外写入、不打断无关宿主工作。

主要写集：`management-policy.ts::materializeManagement/requestModeChange/completeModeChange`、必要的 `events.ts` 生命周期接缝、管理模式 reader/restore 及新的真实 SDK 持久化回归。

验收至少包括：

1. 从未进入tasks-only的新会话，落盘/重开仍 off。
2. 落盘前 tasks-only→disable→首次对话→重开，仍 off且任务工具关闭。
3. 上述过程没有任何后续工具调用，也仍正确。
4. 落盘后重复 disable 可补齐原先未持久化的关闭，不重开管理。
5. 先落盘再 disable 的既有正常路径不回归。
6. 内存 source、真实新文件、分支切换、并发切换、半写/回应丢失不制造确认来源。
7. 已知未闭合写者/捕获/控制时仍保持停止待处理；迟到回调不再激活旧 owner。

不夸大当前发现：已证实任务工具重新启用，未证实 Advisor、自动监督或业务写者因此被启动。

### F6：off 作为正常未托管状态展示（新增）

方案：

- 已确认关闭时显示“当前未托管，可正常处理普通工作”，不把 enable 当作必须的修复步骤。
- 再次进入任务板或监督只能是明确可选动作；不显示正在等 native end-of-run 的监督检查点。
- 历史任务/验收与当前管理状态分开，不能借旧 Goal 形成当前执行义务。
- volatile off 与 confirmed off、完全 off 与 stopping-with-attention 必须可区分；后者仍显示真实未闭合问题与可执行动作。
- 所有改动只影响正确指引，不隐去安全问题或改变业务准入。

主要写集：`flow.ts::flowBlocker/formatFlowStatus`、必要的 `ui-view.ts/ui-capture.ts` 和状态/驻留 UI 测试。

验收：fresh/volatile/confirmed off 均无“必须 enable”指引；stopping-with-attention 不被误标为干净 off；普通工具准入、旧记录只读、无自动监督保持。

## 5. 共享接缝与失败顺序

- 共享恢复判断返回结构化的允许/拒绝/仅显式处理结果、actor、准确命令或无命令、原因和剩余门。展示用缓存；执行重新核验来源。
- 不靠解析 Advisor 自由文本推断权限已获得。未知 hold 先要求说明/检查材料，不推荐已移除的命令，也不随便推荐 recover。
- 新修订来源必须进入执行捕获与直接/容器证据适用性判断，不能只在 UI 上增加 revision 标签。
- 持久化前发布 feature envelope；新增记录需要严格 schema、容量、hash 和引用闭合。不存在新字段时保持旧语义和旧字节。

失败优先级：

1. owner/session/branch或journal来源不确定；
2. 未闭合调用/写者/host捕获、未决控制及撤销；
3. 修订未确认/未完整提交、契约/输入或材料过期；
4. 实际执行能力不支持、预算耗尽/余额不可证明；
5. 其余执行与最终证据门。

先处理上游阻塞，不拿下游批准、修复或 off 掩盖上游问题。

## 6. 实施分组与依赖

Main现按后续执行许可串行实施，拥有全部共享文件；阶段证据不代替整轮验收。命令端到端验收与机制验收分开，见下文审阅意见处置。

| 组  | 可独立核验的交付                                                    | 覆盖事项       | 主要依赖                                   |
| --- | ------------------------------------------------------------------- | -------------- | ------------------------------------------ |
| W0  | 冻结来源、兼容、恢复动作、修订及命令接口；把既有RED移入正确回归接缝 | 全部           | 已有审计/源码                              |
| W1  | off 停止意图可靠落盘，关闭状态不再反向提示开启                      | F5、F6         | W0                                         |
| W2  | 恢复状态与预算判断一致，没有无效恢复循环                            | F3及F1错误指引 | W0；与W1共享flow.ts，串行写                |
| W3  | 根类型准确且提前选择真实合格执行通道                                | F4、F2         | W0                                         |
| W4  | 同目标修订从原生批准贯穿契约、执行和证据适用性                      | F1             | W0、W2、W3                                 |
| W5  | 统一 supervise/tasks-only，删除兼容命令，命令/帮助/引导与测试同步   | F7、F8         | W0、W1、W2、W4；共享 commands/flow，串行写 |
| W6  | 完整门、实际默认CLI、恢复/旧reader、旧入口删除和包装验收            | 全部           | W1–W5                                      |

建议串行顺序：**W0 → W1 → W2 → W3 → W4 → W5 → W6**。优先完成 off 这种能独立闭合的停止语义修复；不会仅交付提示变化就宣称整轮完成。W0先冻结对外语义，W5将规范命令注册、兼容入口删除、帮助、引导和测试迁移一并落地；中间版本不推荐尚未实现的命令。先前图中的S0–S5是v1分组示意，此处为v4计划的实施分组，不声称旧图已同步。

## 7. 验证与交付门

### 审阅P2：W1/W5命令验收分层

独立审阅快照v4（SHA256 `adada054a6f58cbaa2f99d699385d2ae8d92d97326f824a544e5a1b64955481b`）结论为OK with notes，仅允许进入获授权W0。其P2现明确为：W1用真实SDK SessionManager/生命周期和规范模式Module验证off持久化，不记作tasks-only命令E2E；W5注册规范命令并迁移场景；W6经tasks-only重跑完整命令矩阵。不为此保留测试专用兼容入口或伪造批准。原审阅与本轮后续实现验收分开。

### 编辑循环

- 每个具体缺陷先运行最小RED，再实现并转GREEN，复跑原始代表场景。
- 实际SDK持久化问题不得只用伪造 source 标记或纯对象测试代替。
- 长时间、大数据或多配置执行前，先用同路径、同配置的有界代表样本验证输出、失败处理和不变量。

### 集成验收

- 项目SDK1.1与实际全局宿主1.4；只证明实际测过的组合。
- 正常集中批准/独立Start、授权准备/定义审核、已编译暂停目标的范围修订三条正向路径。
- 默认builtin codemode实际存在时的直接正式检查，以及无合格通道的提前拒绝；不能通过禁用builtin掩盖。
- off首次落盘/重开、纯文本无工具、重复关闭、未闭合执行、迟到Advisor、分支和冷恢复矩阵，通过规范tasks-only入口验证，不保留enable测试捷径。
- supervise及显式replan在fresh/未启动/已启动/已结束目标下的行为矩阵；重复supervise不重派规划，显式重规划不新建目标或借用旧批准。
- tasks只读与tasks-only模式切换严格区分；模式切换遇到未闭合控制仍阻塞，帮助/通知只推荐实际可执行的规范入口。
- 被移除的preflight、enable、supervise-legacy、resolve子命令不执行、不转发、不修改mode/owner或派发；/continuous-tasks不再注册。历史记录仍可读取和验真，不能因删入口而删除旧数据保护。
- 原生审核80×24、长材料、取消、拒绝、resize、过期及原对象来源。
- 新修订不能复用旧证据；未知、错误退出、未清理临时目录等不形成成功。
- 新feature旧reader明确拒绝；不改写历史hash或把已知weak provenance升级。
- 新候选冻结后一次完整`npm run check`，保留原阈值、规则和所有要求的smoke。已有绿灯不复用为新候选结果。
- 记录源码身份、命令、原始日志、限制、保护文件与仓库状态；独立只读复核如需代理，须先获授权。

### 发布边界

- 实现、验证、本地提交、安装和业务恢复分别报告，不默认安装或操作指定业务会话。
- 写过新feature的会话不能简单回滚旧包继续使用；不能删fence、改journal或重放批准来兼容旧reader。
- 保护既有未跟踪文件`.pi/`及`docs/supervisor-journal-growth-and-restore-repair-plan.md`，不纳入本轮写集或提交。

## 8. F7、F8：正式纳入的接口简化

用户已要求将两项纳入计划，并去掉为了兼容而保留的命令入口。以下接口和删除规则已落地；原设计和本轮验证证据分别保留。原D1、D2分别归入F7、F8；命令删除不等于删除历史数据支持。

### F7：以 supervise 统一规划入口

规范入口与状态语义：

- `supervise <目标>`：建立目标并进入只读规划；有已结束历史时仍需原生归档/新目标流程，不借旧授权或首次Start。
- 对同一当前未结束目标重复调用普通supervise，仅报告当前状态，不重复派发规划或业务。
- `supervise --replan [目标]`：显式重规划，只作用于同一尚未首次启动的当前目标。若提供目标文字，必须与当前目标相符；不能用这个选项另建目标。
- 已启动目标不允许通过上述重新规划改变范围，准确引导到F1范围修订；不能用stop/archive或新Goal替代同目标恢复。
- 删除用户子命令`preflight`，不保留别名或自动转发；原有首次规划能力由supervise承接，未启动目标的显式重规划由supervise --replan承接。
- `--replan`由明确选项解析处理，提供`--`以分隔可能以选项样式开头的目标文字；不改变历史Goal归一化、身份或digest语义。
- 主帮助、通知、状态、Main上下文和README只推荐supervise及其显式replan操作；旧preflight只可出现在不可执行的移除说明、历史材料或负向测试中。
- 规划、业务批准、首次Start仍是不同状态和权限门。合并入口不能使supervise直接开始业务执行。

主要写集：`commands.ts::registerCommands/beginPlanning/legacySupervise/supervisorCommand`、`goal-commands.ts::routeSameGoal/routeGoalInput/routeGoalCommand`、必要的`goal-planning.ts`、`flow.ts`、帮助与README，以及命令、SDK/CLI脚本和测试helper。保留一套规范规划模块，删除兼容路由及仅为该路由存在的分支；旧数据reader不因此删除。

验收：fresh首次进入规划只有一次派发；同目标重复supervise幂等；显式replan建立新规划尝试但保留Goal身份，未决控制/旧批准按原规则处理，不移用旧尝试权限；已启动时不能重收Start或重建目标；已结束历史仍经原生新目标确认；旧命令调用明确不可执行且不改变状态；选项解析不误吞真实目标文字。

### F8：以 tasks-only 明确仅任务板模式

规范入口与状态语义：

- 新增`tasks-only`作为仅任务板模式的对外名称；内部仍使用`ManagementMode = tasks`，不为改名变更旧mode记录或activation/hash。
- 删除`enable`用户入口，不保留兼容转发；tasks-only调用现有`enableTasksMode`或等义规范模块，不变成supervise或隐式Start。重复进入已选tasks模式保持幂等。
- `tasks`继续只读打开任务板，不切模式、不启用工具、不创建owner，不与tasks-only合并。
- tasks-only提供任务/阶段/依赖记录和受约束的状态/证据流转，不自动调用Advisor、不自动监督继续、不提供额外业务权限。
- 从supervised切到tasks-only仍需原有安全交接，明确显示是模式切换；未闭合写者、未知捕获或未决原生控制仍阻塞。不能把新名称包装成无影响的查看操作。
- 从off重新选择任务板模式，仍按既有规则保留历史并建立独立board owner，不复活旧Supervisor、Goal许可或证据；不因为改名而跳过F5持久化和F6关闭语义。
- 主帮助、通知、状态和README只用tasks-only说明仅任务板入口；旧enable只可出现在不可执行的移除说明、历史材料或负向测试中。用户使用supervise不需要先调用tasks-only。

主要写集：`commands.ts::ownerControlCommand/enableNotice`、`management-policy.ts::enableTasksMode`的Adapter调用与提示、`flow.ts`、相关UI/帮助/README及management命令/持久化/实际SDK测试。底层管理和权限规则除F5/F6明确修复外不因名称变化扩张。

验收：tasks-only保持原任务板能力和安全交接；tasks调用前后模式、owner和工具启用集合不变；tasks-only通过F5首次落盘/冷恢复矩阵；未闭合执行/控制下不能切换成功；不会调用Advisor、自动派发、授予权限或继承旧Goal证据；enable不能再进入任何管理路径。

### 统一的兼容入口删除清单

F7/F8共同覆盖以下命令面收敛：

- `/task-supervisor preflight`：删除；使用规范supervise或显式supervise --replan。
- `/task-supervisor enable`：删除；仅任务板模式使用tasks-only。
- `/task-supervisor supervise-legacy`：删除；不保留绕过正常规划的直接启动入口，使用supervise→原生批准→独立Start。
- `/task-supervisor resolve`：删除；当前原生决策统一使用decide。
- `/continuous-tasks`：取消整个旧前缀的注册；只保留`/task-supervisor`。

删除要求：

- 不保留隐藏别名、自动转发、仅供测试调用的旧入口或旧直接启动捷径。
- 可对已移除子命令返回明确错误和新命令说明，但不能执行或转发；未注册旧前缀的宿主处理不得被当成授权来源。
- 同步迁移help、README、通知、Main上下文、自动化脚本及测试helper。旧命令的正向测试改用规范入口/受信原生流程，旧历史场景使用真实保留夹具，不伪造批准来替代被删除的捷径。
- 增加旧命令不执行/不改mode或owner/不派发的负向测试，并检查旧前缀不在命令注册集合中。
- 继续读取并验证历史`continuous-tasks:*`记录、preflight来源、既有Goal和物理见证；不全局改名持久化标识，不重写旧hash，不升级旧来源强度。
- `submit_preflight`等仍有独立职责的模型工具、status/tasks/history及repair类功能不是兼容命令，本次不因此删除。stop/disable、resume/recover也不因名称或实现相近而顺手删掉；若要再合并，需另行明确范围。

## 9. 现在应做什么

实施已启动，W0接缝已冻结。W1已修复volatile off落盘、原Session/分支限制和off指引，W2已修复共享预算判断与无效recover；相邻验证15文件/304例通过。W3已增加直接根V2 observed（非qualified）记录、真实执行能力预检和嵌套正式检查入口守卫；invocation相邻8文件/150例、能力/审批相邻5文件/99例通过；实际全局Pi1.4 CLI保留并激活默认builtin codemode时，直接正式检查完整分支和不合格container-only在Start前拒绝的分支都通过。

W4已接通提案、单文档原生scope审核、同版修复/撤销、提交前候选隔离，以及Frame/capture/receipt/契约/完成证据的当前修订门槛；显式recover采用修订，resume/repair不代为采用。21项范围专项覆盖半写/冷恢复/撤销后继/停止注意项；相邻17文件/388例通过（后续原始receipt来源强化后4文件/105例再次通过）；typecheck/lint通过。真实SDK1.1、宿主1.4 CLI保留默认builtin的范围修订分支均已通过，1.4在原始receipt来源强化后重跑通过；隔离合成目标保持一条原批准及一条Start，原生修订仍暂停，显式恢复后实际固定Python检查并完成。旧95cb reader接受同一实测journal的scope fence前原始前缀，在新feature后拒读且无改写。这些不是既有业务会话或真人可用性接受。

W5已完成规范supervise/--replan/--和tasks-only，删除全部约定的兼容命令/旧前缀、直接启动fallback和helper命令重写；README/Main指引及SDK脚本同步迁移。模块机制夹具不伪称当前命令/批准证据；独立session不会被测试host初始化继承。

W6源码门通过：`npm run check`，143文件/3335测试、13个必需SDK smoke；statements93.27%、branches90.01%（14168/15739）、functions97.99%、lines95.38%，90%阈值、maxWorkers4及生产预算不变。新增多事务native测试使用各自有界仪器化时限，不改原100次注册10秒资源门。

真实默认builtin CLI已在SDK1.1/宿主1.4各跑通集中批准/独立Start、先准备后定义审核、同目标scope修订与显式recover、同Session显式replan/后继Goal，以及container-only在Start前拒绝；scope原生80×24完整阅读及实际resize后重读通过。canonical tasks-only的fresh/首次对话前关闭/落盘后再关/先落盘后关四场景，包含真实纯文本无工具对话及重开，已在两个实际SDK版本通过。旧95cb reader拒绝新的scope会话且字节不变。

证据目录：`/home/ygguo/agent-artifacts/pi-task-supervisor/recovery-mode-implementation-20261029-D8MnLB/`；完整门`w6-fourth-full-check.log`；实际CLI `w6-final-{sdk-1.1,host-1.4}-*.log`；模式矩阵`w5-tasks-only-real-{sdk,host-1.4}-matrix.log`；旧reader`w6-old-reader-final-result.json`。均为隔离机制/合成任务，不是既有业务G0、真人可用性或对抗沙箱证书。

用户已明确授权提交、推送、然后本机安装。Main继续包内验证、冻结身份和发布；不重载当前/业务会话，不调用业务recover，不npm发布。包及安装完成后另记录精确commit和加载验证；此前的源码门不冒充已完成安装。
