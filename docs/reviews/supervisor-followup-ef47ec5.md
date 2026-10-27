# Supervisor 后续问题复核（ef47ec5）

> 状态：记录，未修复。此文保存前一轮隔离诊断报告；下文“本轮只读”指诊断阶段，本次新增的仅是问题文档与证据记录。当前分类与历史修复见[问题总账](../supervisor-known-issues.md)，自包含观测见[证据 JSON](supervisor-followup-ef47ec5-evidence.json)。
>
> 下文日志、探针及配置的裸文件名指本机已核验归档目录 `/home/ygguo/agent-projs/agent-ext/pi-task-supervisor-worktrees/audit-fixes-artifacts/followup-review-ef47ec5/`。`/tmp` 命令是原始环境记录；冻结探针仍含原始绝对路径，迁移重放前须重定位，未接入正式回归。

## 结论与范围

当前源码：main `ef47ec5299e321676ad6f38db8b3f02e9401f43c`。

前四项均确认：1 为外部执行未闭环可能导致提前验收的 P1；2/3 为完成后审查恢复与容量不闭合的 P2；4 为 Advisor 用量漏记的 P2，不是调用次数预算绕过。三项策略/集成行为中，停滞策略和动作错误即故障已确认；Code Mode 的平面事件模型障碍已复现，但本轮未做真实插件 only 模式端到端测试。最后关于“宿主成功回执不等于验证覆盖用户目标”的限定也成立。

本轮只读审查仓库，在本目录创建隔离探针；没有修改源码、阈值、现有测试、配置或 Git 引用，没有安装/重载/推送，没有访问真实/归档会话或实际执行器。模拟使用注册的真实 tool_call / 工具 execute / tool_result / agent_before_settle 处理器，宿主上下文、追加适配器、执行器 RPC 和 Advisor 为合成替身，不是完整真实 CLI/生产会话。

## 实测结果

- 小样本：正常完成/验收对照通过。
- 完整隔离探针两次一致：4 项应满足的安全/恢复/记账断言失败，3 项正常或现有策略对照通过。完善用量分项后再次运行仍得到同样结果。
- 原仓库 async-execution、supervisor-batch、supervisor-policy、supervisor-packet 共 82 项相关测试全部通过。它们没有覆盖这里的完整组合路径，不能用已有通过结果排除这些问题。
- main HEAD、已验收 141 文件摘要及原有未跟踪状态保持不变。

命令：

```sh
./node_modules/.bin/vitest run --config /tmp/supervisor-followup-review-2ckEgl/vitest.config.mjs --reporter verbose
```

结果日志：results-final.log；前两遍 results-1.log / results-2.log；正常链路 smoke.log；原有回归 existing-tests.log。

## 必须优先处理

### 1. P1：clear_execution 删除了验收前唯一的外部任务屏障

位置：src/tools.ts:845–865；src/events.ts:283；src/async-execution.ts:164、227；src/supervisor.ts:936。

- **机制**：绑定时保留 source/runId，等待时向执行器查询 Session、协议、Run 和子节点；清除时却只检查调用参数与现有引用相等，然后删除 executionRef。最终验收仅检查任务上不再存在该引用，没有检验持久化的终态确认。
- **实测**：先经公开 bind_execution 绑定 run，原生结束处理器收到 running 后进入等待。随后经公开 clear_execution 准入/执行/结果链清除，RPC 请求始终只有最初的 `[ping,status]`。再提交合法的新鲜验证与 done，Supervisor 接受 completed；合成执行器状态仍为 running。
- **影响**：在该外部任务仍可写受验产物的条件下，目标可能在写入未结束时被接受。探针证明相矛盾的执行器状态仍可通过验收，没有声称实际启动了写文件的子进程或观察到生产文件损坏。
- **最小闭环方向**：清除/解除等待必须经过可信执行器的同 Session/同 Run/含子节点的终态确认，并保留可追溯终态记录供最终验收检查。未知状态保留阻塞；失败/取消等终态记录真实结果，进入明确处理路径，不能等同于成功。保证仍只到可信执行器协议边界，不是 OS 级“绝不会再写”的证明。

### 2. P2：任务全部完成后，临时 Advisor 故障没有仅重试最终审查的路径

位置：src/supervisor.ts:710–718、1271；src/events.ts 的边界异常处理。

- **机制**：所有终审异常会变成 fault，而 recover 无条件拒绝 completed 看板。
- **实测**：单任务已合法 done，acceptanceError 返回 undefined。模拟最终 Advisor 503 后进入 fault；检查仍返回 undefined，原完成证据不变。把 Advisor 改回可用后调用 recover，得到 `A faulted completed board cannot be reopened ...`，第二次结束检查也不再调用 Advisor。
- **影响**：明明只有审查失败，却被要求重建目标，重新规划与收集证据。
- **修复方向**：建立“执行完成、最终审查待完成”的可重试路径，区分传输故障与证据失效。重试前检查权限、目标/看板摘要、回执 epoch、产物版本及外部执行闭合；只重跑审查，不重放任务/授权/首次启动，不顺便重置预算。不能简单删除 completed 禁止恢复规则，否则会重新开放真正失效的完成态。

### 3. P2：合法绑定证据的容量大于终审视图容量

位置：src/schemas.ts:79–81；src/supervisor.ts:999、1043–1059；同上 completed 恢复规则。

- **机制**：一个任务允许最多 20 个证据引用。绑定回执进入 packet 时保留完整正文，循环压缩只作用于未绑定回执/最近消息。任务 done 前没有同一审查视图容量检查。
- **实测**：单最终任务绑定 16 个合法成功回执，每份输出 1600 个中文字符；仅输出就是 76,800 UTF-8 字节。公开 advance 成功、快照有效、确定性验收通过，但 packet 超过 64,000 字节。Advisor 调用数为 0，目标 fault；recover 再因 completed 被拒绝。
- **影响**：合法输入形成正常终审无法处理的完成态。当前是安全地失败关闭，不是偷偷截断或伪造证据；缺陷在可处理性与恢复能力不闭合。
- **修复方向**：保留已有账本/宿主原始记录，单独构造有界审查视图：宿主生成的结果结构、检查与产物版本、回执 ID/hash、必要且明确截断的摘录。需要详情时由宿主受限补给。当前 Advisor 无工具，按需读取需要明确协议，不能假定已有能力。提交 done 前复用同一视图构造检查，避免提交后才发现无解。不能只把超限材料静默截短后仍宣称完整审查。

### 4. P2：动作校验拒绝了建议，也拒绝了已经发生的用量记账

位置：src/supervisor.ts:1198–1215；模型适配器 modelAdvisor。

- **机制**：assertBatchAdvice 在 recordUsage 之前。建议虽格式合法、模型已经返回用量，只要动作与批次不相容，就在记账前抛错。
- **实测**：实际走 modelAdvisor 适配器，模拟合法 guide、17 tokens、0.25 cost，但宿主事实要求 next_batch。模型调用 1 次，reviews=1，tokens=0，cost=0，fault/review_failed。
- **影响**：Supervisor 这份 token/cost 统计不完整。reviews 已计数，不能据此称调用次数预算被绕过，也没有测量 SDK 的独立账单统计。
- **修复方向**：把调用用量与建议采纳分离，已返回且有效的用量先按调用身份精确记账，再校验业务动作，保证不重计。更完整的实现还需处理解析拒绝与晚到响应的原调用归属；未知用量不能凭空估算为已知值。

## 策略与集成限制

### A. 停滞摘要确实忽略成功工具工作的变化

位置：src/supervisor.ts:976–985、1132–1150。

4 份不同的成功 edit 回执、任务一直 implementing，仍达到 stagnant=3 并暂停。源码有意只纳入任务 ID/状态/完成证据，避免 generation 或问状态刷进度；所以是保守策略的真实误暂停场景，不是未计入任何工具日志。

建议增加宿主可核验、去重、绑定产物版本的里程碑/差异/测试结果信号，并保留总预算和循环上限。单纯使用成功工具调用次数会制造逃逸空间。

### B. guide / next_batch 选错一次确实直接 fault

位置：src/supervisor.ts:1178–1196；src/**tests**/supervisor-batch.test.ts:98。

现有测试明确要求这样处理。F4 的动态用例也显示只调用一次模型便 fault，并没有受限纠正。它拒绝矛盾建议，不能作为新权限来源，但降低了推进韧性。

可以在真实门禁已满足时由宿主确定性生成 next_batch，或只容许一次有预算的动作纠正；不能重解释 hold、忽略人工 pause/stop 或新增业务权限。

### C. Code Mode：确认平面回执模型不表达调用树

位置：src/receipt-store.ts:332、369–405；src/supervisor.ts:840–855、931。

模拟已准入外层 codemode → 内层成功 bash 验证：内层完成时 pending=1，因此不能推进 done。外层也返回后 pending=0，但内层 epoch=2/eligible=false，外层 epoch=1/eligible=false，当前 epoch=3；没有一条可作为验收的新鲜成功证据。

这是包含潜在变更子调用的嵌套事件路径的复现，不是当前真实 Code Mode 插件 only 模式的端到端认证，也不能概括所有 Code Mode 组合都必然失败。当前保守门禁有其安全理由：容器仍可能继续修改状态。

可靠支持需要宿主提供真实调用树、父子身份与修改顺序/静止边界，在容器结束后判断哪些检查仍适用；不能把所有 codemode 一概标记只读，或在父调用仍可修改时提前释放证据门。

## 验收能力的边界

用户最后的判断成立。src/supervisor.ts:936–974 校验任务全 done、无 executionRef、最终任务依赖闭包、任务摘要绑定及成功/新鲜宿主回执；它不独立解释命令是否测试了某项功能。src/types.ts:16–29 的 CompletionEvidence 没有需求→检查→产物版本的结构化契约。

preflight 已有 acceptance 文本，不能说项目完全没有记录验收要求；但它没有成为可执行的逐项检查覆盖关系。相关性/完整性仍依赖 Main 的计划与 Advisor 判断。补映射仍需可信的检查定义和结果预期，不能只是由模型给任意成功命令贴一个需求 ID。

## 建议顺序与未验证范围

优先 1；把 2 和 3 作为最终审查状态/视图一致性的同一组修复；4 可独立修正。之后再调整进展信号、动作纠正及 Code Mode 调用树支持，别用解除门禁换取表面续跑。

本轮未修复任何一项；没有独立源码 reviewer、真实执行器/文件写竞争、真实 503 网络、真实 Code Mode only 模式或生产 CLI/PTY 验证。此前完整测试通过不能排除这些新补充场景。
