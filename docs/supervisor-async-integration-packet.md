# 异步执行衔接实施契约（收缩后的第二阶段）

状态：READY；合并后的本地候选已实现并通过隔离验证，未部署。用户确认 Supervisor 不应重复管理并行、写权限和 worktree，并要求继续开发。第二阶段主范围为既有执行器的等待/结果衔接；候选另含从其他工作目录合入的证据包边界修正。不运行实际子代理或业务 workflow，不发布、安装或继续 npm 登录。

基线：`9933feaee451046168fb1384b7276fe1ad78c787`。开发分支 `local/supervisor-async-integration`；npm 首版准备分支和已验证 tarball 保留，实际安装仍为 Git `0d7e1f5`。

## 接口与权威

- 使用既有 `pi-subagents` 进程内 RPC v1 的 `ping/status`，不导入另一安装根的私有模块，不解析人类状态文本或任意文件路径。
- `ping` 确認协议、事件能力、当前 session UUID 与 sessionFile；执行器状态以其当前会话结构化 `asyncSnapshot` 的精确 run ID 为准。该事实表示执行器报告的状态，不声称独立证明 OS 进程存活。
- 完成通知投递、去重与唤醒 Main 继续归执行器。Supervisor 不另订阅原始完成事件、不复制通知队列或触发第二轮；在 Main 原生边界重新读取 owner snapshot。原始通知无论旧、重复或外来，都不直接改变 Supervisor、人工门或任务验收。
- 原有 `workflow_gate` 仍负责 Main 绑定/清除执行引用。只核对存在的引用，不启动、停止、恢复或重派执行器。
- 保持既有计划中的公开工具/原生生命周期/只读状态接口。隔离 fixture 提供 RPC owner 响应；不增加人类并发/写权限命令，不把 fixture 成功描述为真实执行器的业务联调。

## 精确行为

1. 只有受监督、active 板、当前领取任务全部有执行引用且执行器报告这些精确运行 queued/running 时才进入等待；存在未绑定的 Main 工作就保留正常监督。
2. RPC 请求带独立随机 request ID，订阅先于发送；回复协议/方法/身份校验，单次 2 秒边界，取消、缺执行器、畸形/缺失/截断状态均可见故障，不以文本或缺记录推断完成。
3. 等待记录为 Supervisor 的可选 `externalWait`：板 digest、当前 epoch、精确引用、最后 owner 观察时间、`active/results_pending` 阶段及首次进入的绝对期限；保留原 status/计数/用量/epoch/证据，同一引用组不续期。固定 30 分钟期限，仅一个到期停顿计时器，不增加状态或模型轮询。
4. 等待时不调用 advisor、不增加续跑/无进展计数。`agent_settled` 只协调，不从该通知派发工作。
5. Main 经执行器已有结果唤醒后检查产物/清除精确引用/做新鲜验证，不自动 mark done。若 owner 已报告完成但 Main 尚未清除引用，记录 `results_pending`，仍有限等待、不追加 advisor/唤醒；失败/停止/未知或超时保留引用并可见故障。
6. RPC 状态应用核对等待记录的板 digest/epoch/session、有效上下文与精确运行 ID。human pause/stop、decision、fault、预算停顿优先；任何原始通知均不能直接恢复。
7. 重启/切树恢复任何未完成 active/externalWait 目标仍 interrupted fault；不自动确认运行存活，不自动重派。旧日志缺外部等待字段保持现有语义。
8. 八行 widget/只读 status 显示“执行器最后确认的等待/绝对期限”，不主动查询执行器，不把缓存当当前进程证明。RPC/print 不增加自定义 widget。

## 符号与写集

- `src/async-execution.ts`：只读 RPC adapter、结构化协议解码、会话别名与精确引用匹配；不启动执行。
- 沿用 `src/runtime.ts` 的既有 AsyncLocalStorage 生命周期作用域；RPC reply 解码只解析数据，await 与到期计时器保留调用方 runtime，不新增通知缓存或事件总线状态库。
- `src/supervisor.ts`：可选等待 schema、预算保持、持久化等待与清理；接受目标仍拒绝未解决引用。
- `src/events.ts`：`makeController` 在原生结束检查前调用 `waitForExecutions`；仅通过 `currentExecutionWait` 放行等待结算；保留取消票据、启动恢复上下文和压缩中断保护，不订阅新的完成处理器。
- `src/flow.ts`、`src/board-ui.ts`：只读的最后 owner 报告与绝对期限提示；既有命令通过 `holdSupervisor` 清理等待，不另改恢复命令语义。
- 测试限上述公开接口的 fixture、必要隔离 SDK smoke 与文档。`engine.ts` 的 active 批次保护、任务数量和阶段/依赖不改；不新增 pi-subagents 依赖或并发配置。

## 合入的证据包边界修正

- `src/supervisor.ts::evidencePacket` 按 UTF-8 字节验证 64,000 字节上限，逐级缩短未绑定回执的 input/output 与近期对话摘录，并显式设置 `excerpts.shortened`；不增加模型调用或重试。
- 完整目标、任务板、选定回执的身份/digest/epoch/验证元数据及绑定验证回执不缩短；只构造发送给 advisor 的临时包，不修改持久化历史或证据绑定。保护材料仍超限时，在 advisor 调用前可见故障。
- `src/__tests__/supervisor-packet.test.ts` 新增 4 项公开原生边界回归，覆盖 ASCII/中文大摘录、绑定证据超限拒绝、UTF-8 与 UTF-16 长度差异；没有改变任务验收、权限或恢复门。

## 失败优先级与提交

- 会话/板/epoch/真实门变化先作废等待结果；取消不转成新的权限。
- 预算耗尽/无进展已经停顿不得通过等待绕过。
- RPC/等待记录持久化失败 fail closed，不静默继续 advisor 或重派。
- 运行终态失败/停止及超时不能成为成功；缺通知或缺匹配状态不能被当作完成。
- 成功的 owner 状态只进入 `results_pending`；原始通知不解除等待或人类门，不改变 task 状态或 evidence binding。等待写入或到期日志失败锁定 journal recovery，不能经失败的 recover 重新启用任务。

先用一个公开生命周期 RED sentinel 验证“可信运行等待不调用 advisor”，再逐切片验证身份、取消、终态、超时、旧日志和真实门。先小样本 SDK fixture 后完整现有检查门；不拿 npm 发布或真实业务执行做实验。

## 本地候选验证

- 异步衔接保留 38 项公开生命周期/RPC fixture 回归；证据包修正新增 4 项回归。审查期间 12 个候选文件的哈希与 HEAD 均未漂移，没有未解决合并项或冲突标记。
- 合入后 `npm run check` 通过：600 项测试 / 30 文件，分支覆盖率 91.14%（1410/1547），类型、ESLint、格式与 7 种隔离真实 SDK/faux-provider smoke 均通过。异步 SDK 场景通过 `workflow_gate` 绑定/清除、真实原生结算、执行器 fixture 唤醒和新鲜宿主验证完成整个目标。
- 最新验证证据：`/tmp/pi-supervisor-merge-review-check.log`；审查前文件清单及哈希：`/tmp/pi-supervisor-merge-review-baseline.json`。合入前的 596 项验证记录保留在 `/tmp/pi-supervisor-stage2-final-check.log`，不作为合入后计数。7 种 smoke 均确认真实 settings 未变；上轮核验的安装 pin 为 `0d7e1f5`、全局配置包数为 18，本轮未部署。
- 合入后的两路径主动 LSP 检查未报告错误：1 路径确认 clean，1 路径因 push-only 服务未确认；不宣称所有路径 LSP clean。完整 `tsc --noEmit` 包含所有 `src/**/*` 并通过。先前邻居 `tools.ts:586` 的自动 TypeScript 2322 提示在主动检查和编译中均未复现，未据此修改既有任务推进代码。
- 未执行真实子代理/业务 workflow、真实推理或独立实现审查；fixture 不是这些项目的通过证据。当前为本地未提交 diff；未 push、发布、安装或重载业务会话，npm 发布继续暂停。
