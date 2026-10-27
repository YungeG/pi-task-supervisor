# 生命周期管理：此前自行发现的问题与边界

> 基线：`ef47ec5299e321676ad6f38db8b3f02e9401f43c`。此文补充前一次机制梳理中由我们自行发现的生效边界、退出体验及模式差异，不与随后用户补充的四项缺陷混为一组。仅记录，不修改实现或授予修复/停用权限。

当前分类见[问题总账](../supervisor-known-issues.md)。这里的 L-01–L-04 是源码核实的策略/使用体验问题，尚未按专门的生命周期端到端矩阵验收，不新增“已复现 P1/P2”结论。已修复的 owned epoch 安装问题另列为 H-08。

## 观察依据

- 扩展入口无条件注册 session/tool/boundary 处理器；runtime 初始 enabled=false，并非初始就启动 Advisor。
- session_start / session_tree 恢复日志中的 activation、GoalRun、看板、授权与 Supervisor。
- lifecycleToolRule 在普通任务控制和 Supervisor 状态判断前运行；goalExecutionIssue 依据 GoalRun phase，而不是统一依据 enabled 或 Supervisor 是否存在/已停止。
- stop 保留会话启用和目标历史，命令列表没有会话级持久化 disable/detach。
- 对话中曾出现：上轮 goal accepted 后，新的合并请求触发“验收后发生变化、需要新目标”提醒；用户停止 Supervisor 后，我们成功继续了明确授权的 Git 操作。该观察只证明当时会话允许该操作，未核实当时加载修订和 legacy/scoped 模式，不能反推所有会话都有相同行为。
- 本轮合并/push 没有执行扩展重载。当前文件版本不能充当运行实例版本的证据。

## L-01：管理生效范围不是统一的显式 opt-in 开关

**位置**：`src/index.ts`、`src/scope.ts`、`src/events.ts:lifecycleToolRule`、`src/goal-scope.ts:goalExecutionIssue`。

**当前行为**：

1. 加载扩展即注册钩子；enabled 主要控制任务工具暴露和续跑入口。
2. 新 GoalRun 可以已进入 planning，但尚没有执行 Supervisor；此时仍有生命周期准入限制。
3. lifecycleToolRule 本身不以 enabled / supervisor.status 为统一开关。有当前 GoalRun 时，非 active/reviewing 阶段仍可拦非只读工具。
4. 上述生命周期拦截以已经建立或恢复出的目标上下文为前提；没有历史记录的新会话并不会因此自动受监督。不能把“钩子始终注册”描述成“所有聊天自动运行 Advisor”或“从未进入目标管理也必然拦普通工具”。

**问题**：用户难以仅凭“我是否启动 Supervisor”判断门禁是否生效。如果希望普通聊天/轻量看板/严格监督是明确选择，当前几个独立状态并没有形成清楚的统一工作模式。

**待设计**：显式区分扩展已加载、会话管理模式、GoalRun 状态与 Supervisor 状态，并展示当前生效范围。不能只在生命周期检查前加 enabled=false 放行，否则可能绕过未结束的真实授权或未知执行屏障。

## L-02：stop 结束目标监督，但没有与 enable 对称的会话级退出管理入口

**位置**：`src/commands.ts:supervisorCommand`、`src/commands.ts:registerCommands`、`src/scope.ts:enableSessionScope/restoreSessionScope`、`src/goal-scope.ts`。

**当前行为**：

- stop 将 Supervisor 标为 stopped、取消继续能力，并保留看板/目标/授权/回执历史；不等于卸载扩展。
- 它不删除 activation，也不写一个受支持的持久化关闭状态。restoreSessionScope 在所选分支发现 enabled=true 的 activation 后恢复启用。
- 恢复 enabled **不等于重新启动已 stopped 的 Supervisor**，两者不能混淆。
- 命令集中没有 disable/detach。新 GoalRun 已 stopped/completed 时，普通非只读工具仍可能受 L-01 的生命周期门禁限制。

**问题**：用户明确想“不再使用 Supervisor、继续普通工作”，现有 stop 的语义不保证完成会话级退出。宿主层停用扩展/重载与停止当前目标是两种不同操作，当前会话控制缺少对称、易理解的入口。

**待设计**：明确停止目标、暂停监督、退出会话管理和卸载扩展的区别。退出路径必须说明旧历史如何只读保留，以及未闭合外部执行、未决人工请求、授权限制和未知结果由谁继续负责；不能通过退出抹掉这些事实或伪造许可。

**历史说明**：此前回答“stop 后无需新建目标即可直接工作”过宽，后续机制检查已纠正。本次 Git 操作成功不能被推广成所有 GoalRun 模式的保证。

## L-03：同一命令的行为依赖 legacy / 新 GoalRun 历史

**位置**：`src/goal-commands.ts:legacyHistory/routeGoalCommand/routeGoalInput`、`src/commands.ts:startGoal`、`src/events.ts:lifecycleToolRule`。

| 场景                                               | 当前分支行为                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 无生命周期、无已结束历史的兼容会话执行 supervise   | 可直接创建 Supervisor、启用工具并派发 Main                                                     |
| 已有 stopped/completed 历史后执行 supervise        | 转入原生旧目标归档/新目标只读规划；业务权限与首次启动仍需分别确认                              |
| 没有当前 GoalRun 的兼容会话停止监督后调用普通工具  | 这层生命周期检查没有 GoalRun phase 可阻断，监督回执捕获也在 stopped 时跳过；宿主自身控制仍有效 |
| 当前 GoalRun 已 stopped/completed 后调用非只读工具 | goalExecutionIssue 可拒绝执行，即使自动监督已经停止                                            |

**问题**：用户输入相同指令，仅因历史不同就进入不同的授权/启动/退出流程。兼容性与隔离目标可以成立，但模式切换对用户不够明确，容易误把 supervise、stop 看作稳定的通用开关。

**待设计**：在命令执行前明确显示当前模式与将发生的转换，统一命令语义或给出清楚的分流入口。不能通过偷偷沿用旧授权或让新目标跳过首次启动来统一体验。

## L-04：目标完成后的工作交接与粗粒度失效判定增加不必要的重建成本

**位置**：`src/supervisor.ts:readOnlyTool/prepareToolCapture/observeTool`、`src/receipt-store.ts:prepareToolCapture`、`src/goal-lifecycle.ts:terminalIssue`。

**当前行为**：

- 完成目标不会因为新一条聊天请求、切换目录或 worktree 自动变成另一个 GoalRun。这本身是身份隔离策略，不是缺陷。
- 工具按名称或宿主 readOnlyHint 分类；Bash、未标记只读的 Code Mode 等保守地视为潜在变更，并非先检查 Git diff 或分析子命令实际效果。
- 因此，通过通用工具执行只读检查也可能让已有验收过期。兼容路径可能在工具结果之后才转 fault 并提示新目标；scoped 路径则可能在工具准入时拒绝。
- 从已结束历史进入独立新工作通常要显式结束/归档、规划及所需授权/启动，而不能直接复用旧完成态和证据。

**问题**：验收后核对状态、执行另行授权的收尾操作、开始独立小任务，与真正修改原产物之间缺乏细化的交接体验。保守的“潜在变更”分类可能把没有实际改变产物的操作也送入故障/新目标流程。

**待设计**：明确已验收只读查看、原目标内追加工作、另行授权的交付收尾、独立新目标的边界；有条件地使用宿主确认的只读工具或产物版本证明。不能相信模型自称只读，也不能保留真实修改后的旧验收。

**与其他条目的关系**：F-02 是有效完成证据下的最终审查故障恢复；F-03 是容量不闭合；I-01 是嵌套调用归属。L-04 是完成后的工作归属与交接策略，不重复算作又一个已复现 P2。

## H-08：已修复的 owned epoch 安装重复/重入

这是此前本地整合日志候选时自行发现、已经修复的生命周期不变量问题，不属于当前 L-01–L-04 未解决集合。

- 原候选 `4e058da` 只约束一次 callback 的 epoch 增量，没有防止同一恢复 cycle 重复安装。
- 第一条红回归确认第二次安装仍可运行。第一版修补在 callback 返回后才记录安装位，第二条红回归又确认重入缺口。
- 当前 `src/restore-journal.ts:installGoal` 在 callback 运行前消耗一次性安装位；重复/重入不运行第二个 callback，异常关闭 lease，同时保留 runtime/manager/session/path/leaf/source/epoch 检查。
- 已合并并推送于 `ef47ec5`。历史验证包含 47 项恢复能力/集成/UI 回归，之后完整 2146 项测试、原覆盖率门和 13 个隔离 SDK 冒烟通过；不等于真实 CLI/生产接受。

本机历史材料：`/home/ygguo/agent-projs/agent-ext/pi-task-supervisor-worktrees/audit-fixes-artifacts/phase4-assessment.md`、`phase4-one-install-red.log`、`phase4-reentrant-install-red.log`、`post-merge-check.log`。

## 运行版本与后续验证边界

- 当前源码行为与实际加载实例应分开记录。未确认加载版本时，不能把某次会话现象全部归因于 ef47ec5。
- 上述 L 项以源码和对话中的操作反馈为依据，没有新增专门的生命周期模式矩阵端到端测试。本次仅补文档，没有执行停用扩展、重载或更改真实会话日志。
- 后续若实施，应覆盖新会话/恢复会话、legacy/scoped、Supervisor 不存在/active/stopped/completed、GoalRun planning/stopped/completed，以及只读/潜在变更工具的组合；逐项明确门禁是否生效、能否显式退出、历史和真实授权如何保留。
- 是否需要“会话明确选择不受任务管理”的工作模式属于待定需求；本文不把该需求当成已实现能力，也不授权通过删除历史或放松门禁实现它。
