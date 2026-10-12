# 第一阶段流程优化实施契约

状态：READY。用户在 2026-10-11 明确要求按优化文档实现；范围为该文档第 4 节 P1-A/B/C。第 5 节 P2 的外部等待与并行接口继续后置，不发布、安装或重载业务会话。

## 权威与测试接口

- C1：`supervisor-flow-optimization.md` P1-A：批次收束仅为执行指引，复用原生结束检查，不用 abort 强制检查或每工具调用 advisor。
- C2：P1-B 与验收矩阵：普通人工暂停一键恢复，保留全部计数、用量、证据、epoch、目标；旧未知来源、强停顿和真实决策不能自动解除。
- C3：P1-C：只读状态说明执行者、领取任务、检查点、真实可用动作；保持八行 TUI 上限。
- C4：第 6 节与现有源码：默认未启用、会话隔离、重启/切树中断、宿主证据和最终接受门均保留。
- 用户的“根据计划文档实现”批准上述矩阵已有公开测试接口：注册的 `task-supervisor/continuous-tasks` 人类命令、扩展生命周期事件、只读状态/列表和现有 TUI widget。测试不通过内部 helper 代替这些公开接口。

## 所有权与写集

一个父级 writer，在 `local/continuous-tasks` 工作树；基线 HEAD 为 `cfd569d7856cd69ea3bf5b5c94767c9de6b83bca`。保留已有 README 和优化提案。

生产写集：`src/supervisor.ts`、`src/commands.ts`、`src/events.ts`、`src/runtime.ts`、`src/state.ts`、`src/flow.ts`、`src/formatting.ts`、`src/board-ui.ts`。测试写集限相关命令/事件/格式/板/会话隔离测试及一个经公开命令观察的回归文件；更新 `test/real-pi-smoke.mjs` 的真实 command-context 绑定和恢复预期，并在 `package.json` 测试脚本加入第六种普通暂停场景。依赖和生产包资源入口不变。文档同步实施状态与用户用法。

## 符号与值契约

| 所在模块/符号                      | 改动                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `supervisor.ts / SupervisorSchema` | 增加可选 `holdCause` 枚举；缺字段的旧日志仍可读取，但来源未知，不能快速联合恢复。保留 version 1 和所有 journal 标识。                                                                                                                                                                                                                                                             |
| `holdSupervisor`                   | 调用者显式传来源。fault 不被人工 pause 降级；已有非普通停顿的原因不会被新的普通 pause 覆盖。预算/无进展数值独立参与资格检查。                                                                                                                                                                                                                                                     |
| `runtime.ts / createRuntime`       | 会话局部的 `manualPauseDepth` 仅包围人类 pause 命令的 cancel/abort/waitForIdle。宿主必须真实绑定 `commandContextActions.waitForIdle`；SDK 未绑定时该动作默认为空操作，不能当成结算证据。真实 Pi 1.1 idle 等待在 `agent_settled` handlers 完成后解决；等待后再次检查 idle，仍忙时拒绝控制完成。因此已确认的宿主停止才能与已知命令意图关联。异常必须 finally 清除；不得跨会话使用。 |
| `events.ts`                        | abort、失败、advisor 错误、压缩中断、预算和无进展使用显式来源。只有处于已知人工 pause 控制期间的宿主中止使用 `user_pause`；其他 abort 不自动放行。                                                                                                                                                                                                                                |
| `commands.ts / resume`             | 新的普通 user_pause、同一 session、板 paused、Supervisor paused、宿主 idle、无 pending 消息/继续、无更强原因和未耗尽限额才联合恢复。最多发送一次 Main 继续；重复 resume 不重复调度。                                                                                                                                                                                              |
| `commands.ts / resume` 兼容路线    | 旧/强停顿仍只恢复板级暂停，并明确告知 Supervisor 未恢复、需要检查后显式 recover；不调用 recover、不清零、不安排受监督 Main。此路线保留现有双命令恢复前置条件，不把部分解除误报为完整恢复。completed/stopped 或不一致状态不获得联合恢复。                                                                                                                                          |
| `resume` 持久化                    | 联合恢复先写下一份 Supervisor checkpoint，再写事件和板 snapshot；两者成功后才发布内存状态和安排继续。不新增第二个任务库或原子日志假象。任何写入失败：不启动 Main、内存保持暂停、设置可见 journalFault 禁止继续控制。重启若已保存 active 监督 checkpoint，现有恢复逻辑将其 fault，不自动回放。                                                                                     |
| `flow.ts`                          | 纯状态投影和联合恢复资格判断，输入板/Supervisor/会话与宿主事实，返回说明/下一步；不查询外部运行、不写状态、不调用模型。命令与 UI 复用同一资格判断。                                                                                                                                                                                                                               |
| `status / boardHeader`             | status 在未启用或 journalFault 下仍可只读查看。状态命令展示完整事实；widget 仅加一个紧凑下一步行，保持有界。执行引用显示状态未知，不凭 runId 推断活跃。                                                                                                                                                                                                                           |
| `formatting.ts`                    | 明示当前领取组完成验证后正常收束并报告下一步；已有运行先核查，不重复启动，未完成不能假标 done。                                                                                                                                                                                                                                                                                   |

来源枚举为 `user_pause`、`run_aborted`、`run_failed`、`advisor_hold`、`review_failed`、`budget_exhausted`、`stagnant`、`interrupted`、`acceptance_invalid`、`unknown`。没有来源的旧 paused/fault 按 unknown 处理；不解析 reason 文案赋权。显式 recover 清除来源，但保留其原有计数重置语义。

## 失败优先级与禁止路线

1. invalid journal、错误 session、决策或结构不一致：不得联合恢复；状态显示所有阻塞，不能推荐被其他门拒绝的动作。
2. fault、旧未知原因、预算/无进展/中断/advisor hold：不能被后来的 user_pause 改造成普通恢复资格。
3. 非 idle 或存在 pending 消息/继续：不取消用户消息，也不恢复或追加重复继续。
4. 日志提交失败：停在可检查故障状态；不能拿回滚/推测充当持久化成功。
5. 合格普通 pause：保持 reviews、continuations、stagnant、tokens、cost、epoch、goal/model、receipts/bindings，不调用 `recoverSupervisor`。

board-only 模式不创建 Supervisor。普通 resume 不启用会话，不启动/停止/重派外部运行。暂停意图不会替代其他业务批准。

## 验证分配

先经公开命令写一个普通暂停/单命令恢复保持计数的 RED sentinel，再按垂直切片补旧来源、强停顿防降级、pending/busy、写入失败和重复恢复测试。随后测试只读 status、决策加 fault 的动作顺序、未知执行引用和有界 widget、软批次指引。

先跑最小相关测试与一个隔离 faux-provider slice；检查输出和失败处理后才跑 `npm run check` 的完整门（typecheck/lint/format/coverage/六种隔离 smoke）。主动 LSP 检查改动 TS 路径。安全保护包括原生压缩/中止/重启/fork、过期证据和完整最终验收测试。

本次没有新增独立 subagent 实现审查授权：父级执行源码与差异复核，不复用此前仅针对文档的 reviewer 结论。若后续要求独立实现审查，必须单独执行，不把源码检查说成独立审查。
