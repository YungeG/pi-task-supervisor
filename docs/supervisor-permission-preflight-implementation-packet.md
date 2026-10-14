# Supervisor 授权预检本地实施契约

状态：**READY（任务 `t-2.1` 冻结时的契约状态，不等同功能实现验收）**。本契约拥有任务 `t-2.1` 的交付；不是任务 `t-2.2` 的实现验收，也不允许提交、发布或安装功能候选。后续本地源码候选已经实现，当前进展与未安装边界见 [README](../README.md#opt-in-authorization-preflight-local-source-candidate)；最终任务板验收及独立实现审阅是单独的必需门。后续真实 `decision-19 = B` 已批准隔离 CLI 只读审阅路径；唯一一次独立审阅已完成（约 221 秒），报告两项具体问题，Main 已逐项复现、修复并补回归。原审阅报告的 `BLOCK` 结论不被改写；最终接受仍由 Main 根据修复验证和整板证据完成。

后续交付说明：本契约冻结时的禁止事项和上述授权来源保留为历史事实；完成本地整板验收后，用户另已明确授权“提交，推送，并安装”。新授权仅覆盖已验收源码的提交、推送与精确提交安装，不覆盖 npm 发布、业务部署、凭据或其他权限配置变更；不得把安装结果或后续验收结论倒写为本契约冻结时已经获得的许可。

## 1. 权威、交付范围与基线

| ID  | 来源                                                             | 必须保持的结果                                                                                                                                                                      |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 本会话真实 `decision-5`，用户以人类命令回答 `B`                  | 批准本仓库最小内置预检的契约、源码、测试和文档；保留旧 `supervise` 兼容语义，批准与启动分开；允许一次最多 10 分钟的只读功能实现审阅。                                               |
| C2  | 用户随后批准的独立热修复范围                                     | `273cc792f350a5a833adcfd918de9871a9c8449c` 仅用于两项故障的本地提交与固定快照安装。不得把它扩展为功能候选的提交、推送、发布或安装许可。额外热修复审阅已完成，不消耗 C1 的审阅额度。 |
| C3  | [流程设计第 4–8 节](./supervisor-permission-preflight-design.md) | 提前列范围、必需/可选授权、风险、替代路线和重新确认条件；真实用户确认后启动；范围不变不重复请求；超范围仍停在真实门。                                                               |
| S1  | `src/commands.ts`、`src/supervisor.ts` 及 Pi 1.1 命令契约        | 人类命令是本插件的可信控制入口；模型工具只提交提案。已有目标、板级门、宿主活动、证据门和强停顿不能被新功能隐式解除。                                                                |
| S2  | `src/runtime.ts`、`src/state.ts`、Pi 会话格式                    | 每个扩展实例独立；使用同一会话分支的 append-only 日志；不创建第二份任务板，不跨会话或 fork 自动继承许可。                                                                           |
| S3  | 已验证的热修复及现有异步候选                                     | 保留 UTF-8 64,000 字节证据包上限、完整计划和绑定证明、真实人工等待豁免，以及既有 owner 确认的有限异步等待，不回退未提交候选。                                                       |

主开发分支为 `local/supervisor-async-integration`，HEAD `9933feaee451046168fb1384b7276fe1ad78c787`。已有 15 个修改/未跟踪文件需保留；当前包配置指向只读热修复快照 `273cc79`，不等于主工作树或新功能已经部署。

**本轮没有**新依赖、宿主权限策略、账号/凭据/模型配置、业务 workflow、委派写者、功能提交/推送/发布/安装权限。最终只读功能审阅使用 C1 的单次额度；本任务不提前消耗它。

## 2. 最小产品边界

新增一个预检 Module `src/preflight.ts`，封装提案、精确授权、身份校验和会话日志。现有命令、任务工具和原生生命周期作为 Adapter 调用它。

这是**授权预检与执行约定**，不是 OS 沙箱或通用命令权限匹配引擎：

- 可以确定性限制本插件自己的提案修改、任务板变更、启动、恢复和目标接受。
- 不修改 `defaultTools`、宿主确认策略、账号角色或外部执行器；不把工具的 `readOnlyHint` 当作已验证的安全证明。
- Main 仍须遵守只读预检和获准动作范围。金额、次数、目标环境、风险及外部状态等自然语言条件由 Main 在动作前核对；不能声称插件已自动解析或强制执行这些条件。
- 源码/普通进度产生的新 mutation epoch 不自动撤销业务授权；真实方案/目标变化、撤销或条件失效才需要重新确认。

## 3. 人类命令与模型工具 Interface

以下为拟实施 Interface；**现在还不能把它们当作已安装命令使用**。`/continuous-tasks` 提供完全相同的别名行为。

| 入口                                            | 输入                                                              | 行为与禁止事项                                                                                                                                                                      |
| ----------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/task-supervisor preflight <goal>`             | 与旧命令相同的目标空白归一化，非空、非秘密、最多 4,000 个 JS 字符 | 检查真实空闲、无 pending host 消息、无未停止 Supervisor、空任务板及无人工门。创建本会话规划记录并启动一次隐藏只读 Main 规划消息；不启动 Supervisor，不建执行板，不停止/清除旧目标。 |
| `submit_preflight` 模型工具                     | `preflightId` 和完整 `proposal`                                   | 仅保存当前人类创建的预检提案；不能提供或设置授权字段。输出精确 `planId`、digest、完整提案、下一条人类命令；不唤醒执行，不批准权利。                                                 |
| `/task-supervisor approve <planId> <selection>` | `selection` 为 `all`、`none` 或逗号分隔的精确 permission ID       | 确认这版完整方案并**替换**当前额外许可集合，不是隐式增量。未知/重复 ID 拒绝。必需项未齐可保留明确的部分批准，但禁止启动。`none` 不批准任何额外权利。无自动 Main turn。              |
| `/task-supervisor start <planId>`               | 当前精确计划 ID                                                   | 复核真实批准、会话/目标/方案绑定、必需项和全部现有启动条件；随后启动原有 Supervisor，并记录已经使用的方案。计划 ID 不匹配或旧完成任务存在时拒绝，不自动清板。                       |
| `/task-supervisor revoke <planId>`              | 当前精确计划 ID                                                   | 记录真实撤销，保留提案、任务和证据；若它绑定正在执行的目标，先取消本插件审查、请求中止 Main 并真实等待空闲，再保存撤销并形成强停顿。不能声称已停止外部进程或替外部执行器回滚。      |
| 旧 `/task-supervisor supervise <goal>`          | 旧输入不变                                                        | 没有预检记录时保持原立即启动语义。选用预检后，同一目标必须满足该计划的批准和启动门，走同一受检启动路径；不能用旧入口绕过待批准或已撤销的方案。                                      |

### 兼容路由的精确定义

1. 有未开始且未撤销的预检时，`supervise` 必须匹配其归一化目标并采用当前批准；不同目标先由真实用户撤销或重新预检，不能静默替换。
2. 已撤销或已经使用的预检不能再次为同一目标提供一次新启动。当前目标的继续须有同版新的人类批准并走已有恢复门；新目标须重新预检，不能复用旧授权。
3. 已撤销的未执行预检不为**不同**的显式 legacy 目标提供任何授权；该目标可走旧路径，但 Main 仍受真实用户禁止事项和宿主许可约束。不声称能做自然语言目标的语义等价识别。
4. 用户重新 `preflight` 规划，能替换尚未执行的规划记录，但必须保留历史并使旧计划 ID/批准失效；不能替换一个未停止的执行目标。
5. 已有 `pause/stop/resume/resolve/recover/status/tasks` 及真实人工门保留。任何新命令不得清掉独立故障、预算耗尽、决策或 pending 执行引用。

## 4. 数据、身份与可信确认

### 4.1 提案字段

`PreflightProposal` 是严格 TypeBox 对象，拒绝未知字段：

| 字段                                            | 类型与限制                                   | 语义                                                                              |
| ----------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| `summary`                                       | 非秘密 string，1–2,000 JS 字符               | 完整方案概要。                                                                    |
| `steps`、`acceptance`                           | 各 1–20 个非秘密 string，每项 1–1,000 字符   | 有序实施步骤及可验收标准；不是任务板。                                            |
| `permissions`                                   | 0–20 个严格对象，ID 唯一                     | 需要额外确认的权利，而非模型自报已经获准的权利。                                  |
| permission 的 `id`                              | 1–64 字符，无空白、不为 `all/none`、不含逗号 | 精确选择和引用。                                                                  |
| permission 的 `action/target/environment`       | 各 1–500 字符                                | 明确动作、对象和环境。                                                            |
| permission 的 `required`                        | boolean                                      | 原方案启动前必须具备该项，或有已经写明的可选替代路线。                            |
| permission 的 `limits/risks/fallback/reconfirm` | 各 1–1,000 字符                              | 限额和有效条件、风险/回退或替代路线、重新确认条件；未知明确写未知，不能等同允许。 |
| `prohibitions`、`reconfirm`                     | 各 0–20 项，每项 1–1,000 字符                | 禁止事项与整个方案的重新确认条件。                                                |

完整归一化 `{goal, proposal}` 编码不得超过 **16,000 UTF-8 字节**。这是预检材料资源预算，不是新的工具权限；用于让受保护范围与后续任务/验证证据留有空间。拒绝超限提案，不悄悄删字段或调高已有 64KB 审查上限。

### 4.2 精确身份闭包

- `preflightId`：人类 `preflight` 入口生成的 `pf-<UUID>`，模型不能自行创建有效的预检上下文。
- `revision`：自然数，从 1 开始；不同提案增一。
- `planId`：`<preflightId>.r<revision>`，不得按模糊前缀或旧版本解析。
- 目标空白归一化沿用现有命令分词规则；不改变大小写、Unicode 正规化、路径大小写或模型语言。
- 提案字符串仅修剪首尾空白，数组步骤顺序保留；permissions 按 ID 排序编码，批准 ID 集合排序。
- `planDigest`：SHA-256，preimage 固定为 `preflight-v1\0`、本 session ID、归一化目标及固定字段顺序的 canonical proposal JSON。精确内容、环境/动作/条件变化均生成新 digest 和 revision，旧批准全部失效。
- 同一 `preflightId` 的重复、字节等价 canonical proposal 是幂等提交，不生成新版本、不重置批准。
- 一旦方案绑定执行目标，模型不得重新提交或修改它；需真实用户在现有门下处理改目标/重规划，不允许滚动偷换权限。

### 4.3 记录模型

`PreflightState`：严格 schema version 1，含 `sessionId/preflightId/goal/phase/revision/planId/planDigest/proposal`；`phase` 为 `planning/awaiting_authorization/approved/started/revoked/interrupted`，**不是现有 `workflowStatus`**。

可选 `approval` 仅由人类命令创建：含当前 `planId/planDigest`、排序的 `permissionIds`、真实控制 entry ID 和批准时间。可选 `started` 标记已经绑定的目标及开始时间；它不会因为暂停消失。

新增日志：

- `continuous-tasks:preflight`：最新状态快照。
- `continuous-tasks:preflight-control`：人类 `approve/revoke` 的严格事件；包括本 session ID、精确 preflight/plan/digest/选择集合与时间。

`appendEntry` 后读取真实 `ctx.sessionManager.getLeafId()`，把对应 control entry ID 放进快照。资格检查必须确认该 ID 在**当前分支**，类型、kind、会话、计划、digest、选择集合全部相同，且没有更新的撤销或取代它的控制事件。不是“看到一个 approved 字符串”就允许执行。

这验证的是插件自己的可信命令入口和日志闭包，不是用户密码学身份认证：拥有同等 OS 权限的恶意代码、伪造宿主或手改日志不在本模块的沙箱保证内。

Supervisor 的现有 version 1 schema 只增加可选 `preflightBinding = { preflightId, planId, planDigest }`，旧条目没有它时保持原行为。不得命名成会被现有敏感键脱敏规则吞掉的 `authorization`。

## 5. 状态、撤销与恢复

| 事件                             | 状态结果                                                    | 是否启动/继续                                                                                              |
| -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 人类创建规划                     | `planning`，无 proposal/approval                            | 只开始一次只读规划；现有执行任务工具被阻塞。                                                               |
| 首次或修订提交                   | `awaiting_authorization`；不同内容清除全部旧批准            | 不执行。相同内容幂等。                                                                                     |
| 人类批准，必需项仍缺             | 保留精确部分选择，仍 `awaiting_authorization`               | 不启动原方案。Main 可提出已获准的替代方案，但新提案需新确认。                                              |
| 人类批准，必需项齐备             | `approved`                                                  | 等待真实 `start`，不触发 Main。                                                                            |
| 受检的人类启动                   | Supervisor 绑定同一方案，预检 `started`                     | 最多一次 Main dispatch；复用原板和宿主证据语义，不复用旧目标成果。                                         |
| 普通暂停或自动压缩               | 保留当前真实批准及关联                                      | 不补授权。保持已有暂停/压缩控制，不仅因 epoch 变化让批准失效。                                             |
| 人类撤销                         | `revoked`，原批准不能使用；保留历史/提案/已绑定目标         | 绑定目标停止在强门，不自动续跑。                                                                           |
| 对已绑定、未变更方案重新真实批准 | 必需项齐备时回到 `started`，但 Supervisor 仍保持原暂停/故障 | 还须满足真实 `resume/recover` 条件，不自动运行。                                                           |
| 重启/切树                        | 只恢复当前分支、本 session 的有效 closure                   | 不重派规划或执行。未完成规划显示 `interrupted`；已有合法批准可保留，执行仍遵守旧 Supervisor 显式恢复规则。 |
| fork/不同 session                | 不继承源会话预检及批准                                      | 不假定运行活着、失败或已授权。                                                                             |
| 新目标/新版方案                  | 新的绑定范围；旧授权不可迁移                                | 重新预检确认，除非用户选择没有关联预检的合法 legacy 目标。                                                 |

`resume/resolve/recover`、advisor、子代理完成通知、工具输出、模型文字、审阅 `OK` 或 `READY` 都不能创建、增加或重新生效许可。

对绑定目标，任务变更、续跑、恢复及最终接受都须检查当前许可 closure。若任何必需项缺失/方案不匹配/已撤销，则保留任务与证据并拒绝。条件变化或自然语言限额失效由 Main 标出相关动作及依赖，优先继续独立获准工作，再按既有真实决策门处理；多个待授权任务阻止建门时直接汇总给用户，不虚构 decision ID 或任务完成。

## 6. 准确符号、Seam 与写集

所有共享文件由 Main 单独拥有；没有委派写者。新 preflight Module 不 import `supervisor.ts` 的值，避免双向初始化依赖；Supervisor/commands/events 作为调用方读取它。`runtime.ts` 对新状态仅作 type import。

| 文件 / Symbol                                                                                                                   | 冻结责任                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新 `src/preflight.ts`：`PreflightProposalSchema/PreflightStateSchema/PreflightControlSchema/SubmitPreflightParams` 及对应 types | 严格数据边界；16KB 提案预算；不接收 `approved/status/approval` 等模型授权字段。                                                                                                                                                                         |
| `canonicalPreflightProposal(goal, proposal): string`、`preflightDigest(sessionId, goal, proposal): string`                      | 固定字段编码、稳定排序和 hash preimage；不把代码 epoch 纳入批准身份。                                                                                                                                                                                   |
| `beginPreflight(pi, ctx, goal): PreflightState`、`submitPreflight(pi, ctx, preflightId, proposal): PreflightState`              | 创建/提交/幂等/版本失效；不批准、不启动、不改任务板。                                                                                                                                                                                                   |
| `approvePreflight(pi, ctx, planId, selection): PreflightState`、`revokePreflight(pi, ctx, planId): PreflightState`              | 仅从 CommandContext 写真实控制事件及相应状态；proposal 内无信任兜底。                                                                                                                                                                                   |
| `preflightStartBinding(ctx, goal, planId?): PreflightBinding \| undefined`、`markPreflightStarted(pi, ctx, binding): void`      | 无记录的旧路径返回 undefined；选用预检时返回精确已验证绑定或抛错；标记实际使用，不派发。                                                                                                                                                                |
| `preflightAuthorizationIssue(ctx, binding): string \| undefined`                                                                | 检查当前分支可信控制 closure、本 session、方案和权限；只返回原因，无批准或恢复副作用。                                                                                                                                                                  |
| `restorePreflight(ctx): void`、`preflightContext(ctx): string \| undefined`、`preflightStatusLines(ctx): string[]`              | 只恢复有效自有记录；只读展示确切缺项和下一命令；不存在的证据说未知，不自行查运行或调用模型。                                                                                                                                                            |
| `preflightEvidence(ctx, binding): object`                                                                                       | 完整方案、禁止事项、重新确认条件、选择集合、digest 和 control entry 身份；作为受保护审查材料，不能裁剪。                                                                                                                                                |
| `src/runtime.ts`：`createRuntime`；`src/state.ts`：`resetState`                                                                 | 添加/重置实例独立的可选 preflight 状态；不新建任务存储。                                                                                                                                                                                                |
| `src/tools.ts`：`createSubmitPreflightTool`；`src/index.ts`                                                                     | 注册模型唯一的提案入口，顺序执行，返回明确状态/下一人类动作；不是批准工具。                                                                                                                                                                             |
| `src/scope.ts`：`TASK_TOOL_NAMES/updateActiveTools`                                                                             | 新工具属于内部会话工具；未激活不暴露，仅当前有效规划时启用 submit。已批准未启动时不启用执行变更能力。旧无预检激活保留七个旧工具，不无故改变正常 loadout。                                                                                               |
| `src/commands.ts`：`registerCommands/supervisorCommand/continueNow/resume/status`                                               | 增加四个 action 路由和别名；真实空闲且无 pending 后作控制；批准不触发 turn。共享受检启动次序：校验 → 写 Supervisor → 标记 preflight started → 激活工具 → 单次 dispatch。旧 supervise 同目标走此路径。revoke 由 command 负责取消/abort/idle 等待及强门。 |
| `src/flow.ts`：`FlowFacts/flowFacts/resumeControlIssue/ordinaryResumeIssue/nextFlowStep/formatFlowStatus`                       | 添加可选授权阻塞信息；普通恢复不能绕过撤销。无预检时保持现有状态文本/资格，所有阻塞可见，不推荐被其他门拒绝的动作。                                                                                                                                     |
| `src/events.ts`：`taskGate/registerSessionHandlers/registerWorkHandlers`                                                        | 规划/未启动阻塞旧任务工具，submit 只有有效规划可用；绑定执行检查真实许可；before_agent_start 注入只读规划或完整已确认范围；恢复、切树、shutdown 处理状态，事件本身不批准或重派。                                                                        |
| `src/supervisor.ts`：`SupervisorSchema/startSupervisor/recoverSupervisor/restoreSupervisor/acceptanceError/evidencePacket`      | 可选绑定；新路径启动/恢复/接受不得绕过许可；必要时 recover/acceptance helper 增加可选 context，旧无绑定调用兼容，绑定调用缺验证 context 则拒绝。完整 preflight 证据受 64KB 保护，不裁剪以换取通过。                                                     |
| 同 `src/events.ts` 的 `agent_settled`                                                                                           | 选择性整合 `273cc79` 合法人工等待豁免，并保留主工作树 `currentExecutionWait` 分支；不能复制旧整文件覆盖异步候选。                                                                                                                                       |
| `README.md`、设计文档、必要 `CHANGELOG.md`；现有 `package.json` smoke 脚本                                                      | 准确说明本地候选/未安装，新旧入口区别、限制和示例；不改依赖/版本发布元数据。                                                                                                                                                                            |

生产功能写集限定于上表及必要的新测试文件。不修改 `src/engine.ts`、板 version 2/旧流程事件、普通证据结构、已有异步 executor RPC 或 worktree 管理。若出现必须改变这些 preserved seams 的证据，应保持阻塞并报告，不静默扩展。

## 7. 失败优先级、持久化次序和信任

1. 先尊重既有 journal fault、错误 session、宿主 busy/pending、独立决策、未停止目标及旧完成任务；新授权不能解除它们。
2. 模型提案先严格校验完整字段/ID/秘密样式/UTF-8 预算，再 canonicalize/比对；失败前不写状态。
3. 人类批准先校验当前精确计划和全部 selection，再写 control event、取实际 leaf ID、写关联 snapshot，最后更新内存。只写了事件或快照的半批准不能被恢复成可执行权利。
4. control 验证总是考虑最新的相关 revoke/替代批准，不凭较早 approved snapshot 放行。
5. 执行启动先复核全部门；共享控制段中先保存带可选绑定的 Supervisor、再保存 started 关联，全部成功后才激活与 dispatch。半启动恢复为不一致/中断故障，不能自动重放或启动重复 writer。
6. 任何相关 append/dispatch 失败都取消旧工作票据、记录可见 `journalFault`，不撤销已有真实证据、不假装成功；status/tasks 可读，自动执行和控制恢复禁用，要求实际日志/pending work 检查。
7. 自有 malformed/不匹配/未知版本记录 fail closed；明确外来 session 的条目不赋权，旧无 preflight 条目保持正常行为。
8. 撤销使用新的强 `authorization_revoked` holdCause；不能把此前 fault、budget、stagnant 等更强停顿降级成人工普通 pause。新批准只恢复许可闭包，不重置 Supervisor 计数或自动清门。
9. 注册命令和本插件写出的 control provenance 是应用信任 Seam，不是 OS 隔离、密码学用户签名或工具权限配置。不得把 SDK fixture 中模拟的人类命令说成真实业务批准。

## 8. 验收分配与红绿检查

先最小代表性测试通过，再扩大验证；不使用全量测试发现普通 schema、import 或 command-context 错误。

| ID  | 必须可失败的检查                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | 新旧注册命令/别名、默认关闭、无预检旧 supervise 和既有任务板行为不变。                                                                                |
| T2  | 人类 preflight → 隐藏只读规划 → 真实模型工具提交 → awaiting_authorization；没有 Supervisor/执行板/自动批准。                                          |
| T3  | 缺失、未知、重复、秘密样式/超长/超字节字段和模型伪造 approval/status 拒绝，失败不落半状态。                                                           |
| T4  | approve 精确 ID/all/none/部分集合；确认不启动 Main；必需缺项不能 start/同目标 supervise。                                                             |
| T5  | 控制 entry 必须本分支、本 session、当前 revision/digest/集合；工具输出或假 snapshot 缺可信 closure 不能批准。                                         |
| T6  | 同 canonical proposal 幂等；内容/目标/环境/条件变化更新 revision，失效全部旧批准；开始后模型不得换提案。                                              |
| T7  | start 的真实 idle/no pending/旧目标/板 gate/旧 done 限制，全部成功只派发一次；失败无重复 writer。                                                     |
| T8  | 进入 review/done、claim、清板或编辑等旧任务工具不能绕过 pending preflight；执行后仍满足原结构化 exit_code/epoch 证据门。                              |
| T9  | 普通代码/epoch 和 pause 不失效未变批准；resume/recover/resolve 不创造权利、不解除独立强门。                                                           |
| T10 | revoke 前后真正控制序列、当前绑定和所有旧 holds 优先级；同版重新批准仍需真实恢复，通知不能自动解门。                                                  |
| T11 | restart/tree/compaction/fork/foreign/unknown-version，不自动继承、重派、补批准或删除历史；合法同分支确认可追溯。                                      |
| T12 | approve/start 各处 append/dispatch 失败及迟到结果，journalFault 可见，控制/任务变更拒绝，status/tasks 仍只读。                                        |
| T13 | 完整 preflight 方案和控制身份进入 advisor 受保护部分；预算不提高，不截绑定证明，超限在模型调用前失败。                                                |
| T14 | 当前 async waiting 与合法 human decision wait 共存，原生 abort/真实中断、三次停滞及 budget 保持。                                                     |
| T15 | 真实 Pi 1.1 SDK/faux 小样本完整 opt-in 流程、至少一项 required/一项 optional、明确批准和分别 start、host 验证及最终接受；真实 settings 和主会话不动。 |
| T16 | 主工作树与安装快照明确区分；不把本地功能 candidate 验证说成配置已切换、真实模型/业务/TUI 已认证。                                                     |

拟新增测试：`src/__tests__/preflight.test.ts`（schema/身份/纯资格）、`preflight-commands.test.ts`（可信控制/失败）、`preflight-lifecycle.test.ts`（恢复/模型工具/门）、`test/preflight-smoke.mjs`（SDK/faux）。尽量复用现有 mocks/lifecycle helpers；需要可信 leaf/control 日志时增加专用真实追加 fixture，不能让空 `appendEntry` mock 给假 ID。

- 编辑循环：T2–T5 的单会话代表样本及最小 schema/import/static 检查。
- 集成候选：全部上述契约 tests、现有恢复/证据/packet/async 回归、类型/lint/格式、原 90% 覆盖率门。
- Full gate：必要一次 `npm run check`，保持旧 smoke，并接入新的 opt-in SDK/faux smoke；先小样本再扩矩阵。
- 独立接受：C1 剩余一次 fresh-context 只读实现审阅，最多 10 分钟；只审完整候选，不提前用于本文。父级独立复核 findings 与最终文件/命令证据；失败不标 done。
- 最终任务 `t-3.2`：整板依赖闭包、未清执行引用、真实新鲜宿主验证和准确交付，仍由 Main/现有 Supervisor 接受，不由此 READY 文档接受。

## 9. 下一执行者与冻结决定

- 下一执行者：Main；工作树为原主仓库，不启动委派写者。
- 首个 sentinel：T2–T5 的最小新命令/工具 fixture；legacy command/context fixture 先确认绑定，再扩大。
- 共享文件所有权：Main，选择性增补并保留既有 async/packet/board 文档修改；不 stash、reset、清任务板或整文件覆盖。
- 本任务只交付这份 READY 契约、设计状态/入口一致性和文档验证。**下一批 `t-2.2` 才实施**；本轮正常收束，不能以阶段交接冒充功能完成。
- 无新的用户决策或权限缺口。C1 内安全可逆细节直接默认并继续；出现新的外部副作用或本契约明确禁止的变更时才停止受影响动作与依赖。
