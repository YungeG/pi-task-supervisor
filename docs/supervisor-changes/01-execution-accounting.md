# 分卷 01：可信执行结算与 Advisor 用量记账

> 覆盖 P1/F-01、P2/F-04。共同身份、追加与 fence 合同见[修改总则](../supervisor-change-plan.md)。当前仅为修改文档，未改实现；执行器形态必须分别通过 E-EXEC，不把本机包的 capability 声明等同于运行中的终态证明。

## A. P1：外部执行结算

### A1. 行为接口与调用链

当前：

```text
workflow_gate(clear_execution) → 比较 source/runId → 删除 executionRef
最终验收 → 看 executionRef 是否为空
```

修改后：

```text
workflow_gate(clear_execution)
  → resolveCurrentExecutionBinding
  → observeExecutionSettlement（新鲜 owner/Run/子树/进程证据）
  → 重新核对 lease
  → 追加 settlement/release 事实并确认
  → 提交任务快照，最后发布内存
最终验收 → executionAcceptanceIssue（查全部登记执行及未决处理）
```

`observeExecutionSettlement()` 返回结论，不修改任务字段、不停止执行器、不提交 done。调用者负责确认并发布结果；不得在 tools.ts 再写一套判定逻辑。

### A2. 冻结的值与结果

新增 `ExecutionBindingV1`：bindingId、WorkOwnerKey、taskId、source/runId、绑定时的目标/任务摘要、原始绑定 entry/digest，以及可取得的执行代次身份。WorkOwnerKey 采用总则的 goal/board 联合：轻量看板不因绑定外部 Run 就变成 Supervisor；最终目标验收只查询其 goal owner 的记录。Run 身份不得由 label、列表位置或目标文字替代。

新增 `ExecutionObservationV1`：

- bindingId、查询 requestId、Session 与执行器来源、exact Run ID；
- snapshot 的协议/生成时间/摘要、原始 root state、子树摘要与缺失/截断标记；
- writer evidence：`observed | explicitly-not-started | not-applicable | unknown`；可适用时保留 runnerProcessInstanceId 与 proof digest；
- observedAt、lease stamp；原始状态与规范化结论同时保留，不能把 partial/paused/failed 统一写成 success。

`SettlementDecision` 返回以下之一：

| 结果                      | 字段变化                                 | 后续                                                |
| ------------------------- | ---------------------------------------- | --------------------------------------------------- |
| active                    | 不删除引用                               | 继续已知执行等待，沿用绝对 deadline，不刷新无限等待 |
| unknown / stale / foreign | 不删除引用，不推导“未启动”               | 进入检查/held，禁止 Goal 接受                       |
| success                   | 追加确认的结算/解除引用事实              | 允许后续任务验证，但终态本身不代替业务验证          |
| failure / cancelled       | 记录真实终态，可解除“仍在运行”的活动等待 | 建立 pending resolution；不能直接接受目标           |

`ExecutionSettlementV1`：settlementId、bindingId、observation entry/digest、outcome、release entry、resolution 状态。唯一性键为当前 owner + bindingId + observed execution generation，而不是 runId 字符串在所有会话中全局唯一。

### A3. 查询与资格

1. 保留现有 ping 的 Session ID/sessionFile、协议及 capabilities 校验。
2. 继续检查有界 asyncSnapshot 的 freshness、omitted 和子树状态。父 complete/子 running 一律 active。
3. 结算使用 targeted status（exact runId），不能用仅面向显示的 fleet key、摘要文字或未针对目标 Run 的缓存替代。
4. 若声明 processTerminalProof，则验证其 exact Run 和 runnerProcessInstanceId。`stop` 返回 stopping、endedAt、结果文件存在、PID 消失都不是 observed 证明。
5. workflow root 不机械套用不存在的单一 runner proof；适配器必须说明 writer 子树和可适用的证明。缺失/不适用不能靠本地猜测互相转换。
6. not-started 必须是执行器明确且身份匹配的证明，不以找不到 Run 或文件代替。
7. paused/resumable 的工作不作为普通成功终态。存在恢复或新代次时，必须形成新绑定/观察，不借旧 proof 证明新写入已结束。
8. RPC await 前后检查 runtime、manager、Session、GoalRun、goalEpoch、mutationEpoch、所选 branch 及原绑定。用户 stop/换目标等已先发生时丢弃旧决策，不向新 owner 清字段。

若当前协议对特定形态不能给出足够事实，该形态返回 unknown。是否允许仅协议终态而无适用 writer 证明的降级，不能由 writer 临时决定；默认不放行，保留为 E-EXEC 的能力缺口。

### A4. 失败与取消的处理入口

新增 `workflow_gate(action: resolve_execution)`，只处理已经可信结算的非成功结果，不启动、取消或重放执行。输入包含 taskId、settlementId、resolutionKind、相关回执/替代执行引用。

- `validated_repair`：要求同 owner/task 的真实后续成功验证，时间/资格在失败处理之后且当前版本适用。
- `superseded_success`：要求明确关联的新执行成功结算与新的适用验证；旧 Run 不能仍 active/unknown。
- 解决事实只表明该已知失败已有后续处理，不伪造旧 Run 的 success。P7 后还校验与检查条件的对应关系；P1 本身不独立证明业务修复语义。
- unknown 状态不能通过 resolve_execution 洗成 terminal；任意 Main 文本“已处理”不是证据。

最终验收同时要求所有必需任务 done、活动引用为空、登记执行均有适用结算、非成功结算无未处理 resolution。不能通过删除任务字段绕过 registry。显式 stop 不等于验收：已知 writer 均结束时，未完成任务/失败记录可以保留为历史 attention，不强迫用户先修好业务才能退出，也不能自动改成 done/abandoned。

### A5. 精确写集与符号

| 文件                                                                                   | 新增/修改符号                                                                                                                     | 责任与消费者                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `src/execution-settlement.ts`（新增）                                                  | `ExecutionBindingV1`、`ExecutionObservationV1`、`ExecutionSettlementV1`、`observeExecutionSettlement`、`executionAcceptanceIssue` | 结算规则、记录 fold 与验收查询；不承担工具调度                    |
| `src/async-execution.ts`                                                               | 扩展 `observeExecutions` 内部 adapter，新增 targeted proof 读取                                                                   | 与等待共用 owner/Run/子树校验，保持等待绝对期限                   |
| `src/tools.ts`                                                                         | `bindExecution`、`clearExecution`、`applyWorkflowGate`、`createWorkflowGateTool`                                                  | 改成异步结算，统一关键持久化；不再直接清字段                      |
| `src/schemas.ts`                                                                       | `WorkflowGateParams`                                                                                                              | 增加 resolve_execution 的严格字段与描述，不允许模型上传自造 proof |
| `src/supervisor.ts`                                                                    | `supervisorAcceptanceIssue` / `acceptanceError`                                                                                   | 查 registry，不只看 task.executionRef                             |
| `src/runtime.ts`、`src/events.ts`、`src/goal-scope.ts`                                 | 结算投影的安装/清理/恢复接线                                                                                                      | 每 owner 独立，恢复只读；不复用另一会话缓存                       |
| `src/control-journal.ts`、严格 reader/fold                                             | P0 记录接线                                                                                                                       | 追加、确认、恢复与版本拒绝                                        |
| `src/__tests__/execution-settlement.test.ts`（新增）及现有 async/tools/acceptance 回归 | 公开工具与边界哨兵                                                                                                                | 不以私有 helper 测试替代完整组合                                  |

若补字段确实需要修改 `types.ts`，仅增加正式记录类型导出或明确的只读投影；保留现有 ExecutionRef 的 source/runId，不要求调用者生成 bindingId。

### A6. 持久化、恢复和幂等

- 绑定、结算及解除引用采用有因果引用的追加组；不是数据库事务。
- 终态事实已写而任务快照未确认时，保持 journalFault，不在内存先清引用。
- 恢复可识别已确认 settlement 但 release 尚不完整；保持 held，显式修复只补派生状态，不重查后把未知副作用伪造为旧成功，不重跑外部执行。
- 重复 clear/resolution 返回已确认结果，不重复追加相同事实。后续代次或状态冲突必须拒绝，不能覆盖旧事实。
- 旧 executionRef 没有 registry 时标为 legacy-unverified。显式结算时可从经验证的 owner snapshot 建立导入绑定，再查询当前 owner；不从缺失字段虚构终态。

### A7. P1 验收

先迁移现有 F-01 红用例：running → clear → fresh validation → boundary 不能 accepted。另覆盖：父完成/子运行、foreign/遗漏/过期、stop stopping ACK、process proof pending/unknown/错误代次、失败待处理、处理后仍需验证、重复 clear、append 前/后故障、重启半提交、晚到查询、旧引用导入以及新旧读者。

E-EXEC 使用一个自有短运行先确认 actual adapter 的响应形态；直接 Run 与 workflow 分别资格，不借一个通过宣布全部通过。不读取现有真实业务 Run 或日志。

## B. P2：Advisor 调用记账

### B1. 接口与顺序

新增 `advisor-calls.ts`：

- `beginAdvisorCall(owner, attemptId, viewDigest, model, budgetSlot)`：分配宿主 callId 并记录开始。
- `observeAdvisorCall(callId, outcome)`：校验并幂等追加已知 usage/unknown，返回确认后的归账结果。
- `advisorUsageFor(owner)`：从事实投影已知小计和未结算计数，不安装旧业务运行态。

模型适配器拆成“取得原始响应/usage”与“解析/校验 advice”。禁止在 usage 已存在时先因 JSON、动作、引用或任务校验抛错而丢掉用量。

顺序固定：

```text
预留预算/记录审查进入 → 构造视图 → 记录 call started
→ 请求原始模型响应
→ 记录已知 usage 或明确 unknown
→ 校验当前 lease 与 advice
→ 有限重试/采纳/拒绝
```

若请求甚至未发送（如视图超限），不能制造一次 provider usage。保留原 reviews 的入审计数语义；首个调用使用已预留槽位，新增重试/详情/纠正调用各额外占一个槽位，总数不越原 40 次。另显示实际 providerCalls，不能把它与入审次数混为一谈。continuations 等其他预算不因此归零。

### B2. 数据与原归属

`AdvisorCallStartedV1`：callId、GoalOwnerKey、reviewAttemptId、viewDigest、模型、budgetSlot、startedAt。

`AdvisorCallObservedV1`：callId、status（returned/error/aborted）、usageState（known/unknown）、有效数值、结果/错误分类摘要、observedAt。known 必须验证有限、非负、整数计数及累计不溢出；没有收到值时 unknown，不以 0 表示完整消费。

同一 call 的重复相同结果幂等；冲突保留并诊断，不能重计。晚到响应只归原 owner 的账目：原归档快照不改写，历史视图可显示迟到补记；不恢复原 GoalRun、不增加权限或任务进展。

### B3. 审查叶节点变化

用量事实追加会改变 journal leaf。`reviewSupervisor` 必须区分本调用自己的已确认追加与外部上下文变化：

1. 开始事实与审查 checkpoint 先于捕获 protected leaf。
2. 原始响应到达后先记录归账；若追加前已发现外部变化，依然按原 call 记账，但标记业务结果 stale，不采纳 advice。
3. 只有当前 owner/lease 仍一致、追加前 leaf 匹配且追加确认，才把本次自有 leaf 推进当作允许的交接。
4. 不通过忽略所有 leaf 变化来避免自触发失效，也不把用量追加当产物修改或新业务批准。

### B4. 精确写集

`src/advisor-calls.ts`（新增）、`src/supervisor.ts` 的 modelAdvisor/applyAdvice/reviewSupervisor/recordUsage、`src/runtime.ts` 的只读统计投影、`src/control-journal.ts`、`src/events.ts` 的异常接线，以及 `src/__tests__/advisor-usage.test.ts`（新增）和现有 model/policy/batch 回归。

recordUsage 不再只在 applyAdvice 的成功路径负责记账；旧数据 totals 保留为 legacy 已知小计，不反推出从未记录过的 tokens。未知量不影响真实调用次数门的继续计数。

### B5. P2 验收

公开模型适配器返回 guide、17 tokens、0.25 cost 但宿主要求 next_batch：拒绝动作后用量仍准确、reviews 已计。另覆盖非法 JSON/引用、有效失败 usage、非有限数值、无 usage 超时、取消后晚到、切目标后晚到、重复响应和追加前/后异常。所有重试/详情轮次均计入预算，不绕过 hold。

## C. 本卷就绪与退出条件

设计接口、失败政策和写集已明确；实现仍需 P0 的格式资格，P1 的适配器形态还须 E-EXEC。未知形态的合同已固定为不放行，不由实现者自行降级。P2 准备不等待 Code Mode 能力。

通过本卷不宣称最终审查恢复、模式退出、only 模式或语义覆盖全部解决；后续分别消费这里产出的结算查询和调用归账结果。
