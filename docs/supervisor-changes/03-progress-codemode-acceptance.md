# 分卷 03：推进韧性、Code Mode 与可追溯验收

> 覆盖 P5/S-01/S-02、P6/I-01、P7/B-01。依赖[总则](../supervisor-change-plan.md)以及前两卷的结算、归账、产物版本和模式/审查接口。当前未实施；P6 的真实集成须通过 E-CODEMODE，不能只靠平面事件探针宣称完整支持。

## A. P5：真实进展与确定性批次交接

### A1. 进展事实

新增 `progress-facts.ts`：

- `observeProgressFact(owner, task, source, version)`：从宿主已观察的记录生成事实；不接受任意 Main 文本为进展。
- `progressKey(fact)`：排除时间戳等噪声后按有版本前缀的 tuple 摘要去重。
- `progressSince(checkpoint)`：返回适用的新事实与已有任务状态变化，供停滞判定和审查视图使用。

`ProgressFactV1` 包含 owner、taskId、milestone/check ID、来源 receipt/artifact digest、适用 ArtifactVersion、规范化结果和因果位置。允许的首批事实为：预先登记里程碑的实际产物形成、受信检查由失败到成功、受管输入范围新的可核实差异。P7 前可以使用宿主登记的最小里程碑定义，不把它冒称完整需求覆盖。

- 同一内容/结果反复出现不重新计分；输出时间戳、问状态、generation、模型自述或工具次数不算。
- A→B→A 等已见指纹不靠往返变化无限刷进度。里程碑数量、等待和总审查/继续预算仍有界。
- implementing 多轮有新的适用事实时，不只因任务状态未变而累计旧的三次停滞。
- 新 fact 只改变推进判断，不授予权限、不自动 done 或接受目标。

### A2. 批次决定

新增内部 `decideHostContinuation(snapshot)`，返回 next_batch / review_needed / held 及所用事实摘要。必须核对当前模式/owner、授权/人工门、无已领取批次、ready 任务、无未结算执行与未结束宿主操作，且仍在受管契约范围。

满足全部机械条件时由宿主构造 next_batch；不把模型正文直接当执行指令。已有 hold 或人工 pause/stop 不能被重解释成继续。语义不明、目标偏差及最终接受仍交给审查，而非宿主假定所有任务都应继续。

保留一次有预算的动作纠正作为过渡：格式合法但 guide/next_batch 与宿主事实不匹配时，在 lease 和事实未变、无 hold 的条件下可纠正一次。重复错误为可诊断 blocked，不无限重试；原建议和所有用量保留。

### A3. 精确写集与验收

`src/progress-facts.ts`（新增）、`src/supervisor.ts:progressDigest/prepareReview/assertBatchAdvice/applyAdvice`、`src/events.ts:supervisedBoundary/makeController`、`src/flow.ts` 的只读事实、`src/runtime.ts`、control journal/恢复和新增 progress/batch-policy 回归。

- 原“generation/问题不算进展”、人工 hold、预算、重复执行屏障继续保留。
- 旧“动作错一次必 fault”断言按本合同更新为一次受限纠正/宿主决定，不能删除暂停、伪造任务或证据的负向断言。
- 哨兵：4 份真实不同且适用的里程碑，任务 implementing，不误停；相同回执/噪声/循环差异不能续跑；一次错误动作可有界处理，第二次不无限继续；hold 不被覆盖；事实已改变时旧决定丢弃。

## B. P6：真实调用树与静止完成

### B1. 已有 SDK seam

SDK 1.1.0 已在 `ToolCallEventBase` / `ToolResultEventBase` 提供 `parentToolCallId`。`ctx.executeTool()` 为子调用赋 `<parent>/<n>` 并经过相同 hooks/许可；父结果的 nestedCalls 是有界记录。

新增 `invocation-tree.ts`，由事件元数据维护 `InvocationNodeV1`：operationId、rootId、parentId/null、host sequence、WorkOwnerKey、start/end 状态、可信效果分类、适用输入/产物范围和 receipt 引用。

- 不从模型代码、调用 ID 的斜杠或 label 猜父子关系。
- parent 必须是当前宿主已登记的运行节点，owner/Session 匹配；重复冲突、环、越界深度或身份变化拒绝。
- 冻结首批运行上限为 512 个未结束节点、深度 16；到上限在执行前拒绝新节点，不静默驱逐活动 parent。已结束历史使用线性 journal 与有界缓存，不能以“总节点超过 512”为由丢掉必要的恢复信息。
- root seal 记录子树计数、顺序/摘要与未知标记，不把完整递归子树嵌入每个 checkpoint，避免平方级增长。

### B2. 容器效果资格

只对来自已核实宿主实现的编排容器做优化，不能仅看 toolName=codemode。adapter 要确认 SDK/工具来源、事件完整性及 effects 合同；缺能力保持 conservative/unknown。

Codemode 的 store、image、models 不是普通子工具事件：须核对其实际 journal/文件/用量效果与受管 ArtifactScope。SDK 文档说明没有直接 fs/network，不代表这些效果全无。无法说明的效果不得视为 readonly；若某支持范围只包括已核实的工具型路径，明确标能力范围，不借一个通过宣布全部脚本支持。

### B3. 新鲜资格追加

现有 receipt 正文和原 hash 不改写。新增 `EligibilityAttestedV1`，绑定：原 receipt ID/digest、root seal、任务审查摘要、owner、当前 mutationEpoch、ArtifactVersion、受信顺序依据。

允许有效资格的必要条件：

1. root 正常结束，全部必需子节点已结算；无中断/未知效果或脱离树的相关写入。
2. 检查本身成功，实际 structured exit_code=0，任务审查摘要仍匹配。
3. 验证没有与相关潜在写入重叠，验证之后也没有相关潜在写入。只读 sibling 可按已核实效果分类处理；不能仅凭 root 前后 hash 恰好相同就忽略并发写入。
4. 输入/产物版本和必要前提仍适用；未知不等于相同。
5. 只有因父容器/已解释的父子顺序导致原 eligible=false，才可通过可信新事实取得有效资格；原失败、未知结果或真实晚写不能洗白。

新增 `qualifiedEvidence()` 查询原 receipt + 合法 attestation；`assertObservedEvidence`、最终 freshness、审查视图共同消费，不只修改其中一个调用点。旧读者必须在 P0 fence 下拒绝新资格语义。

### B4. only 模式的 done 不能假装即时成功

新增 `CompletionIntentV1`：intentId、owner、taskId、原 review digest、所选 receipt IDs/digests、rootId、候选版本及请求位置。

- 容器内 done 请求由宿主当前 toolCallId 查树，不能由模型传 parent/root ID 决定。
- 先验证请求结构、可追溯回执和目标允许性；尚未静止时只保存 intent，任务仍 reviewing，不更新任务 digest/evidence。
- 工具结果明确 `completionState: deferred`、intentId/rootId 和原快照，文案不得说“已 done/验收成功”。普通根级无 pending 的完成仍沿现有即时路径。
- 在 `agent_before_settle` 中，先过模式/权限/停止/身份门，再在调用 Advisor 前执行 `finalizeCompletionIntentsAtBoundary()`。此时要求根调用与子调用都已结束，使用可信资格、版本和候选视图重新检查，通过才按原 persistTaskUpdate/bindCompletion 顺序提交。
- 选结束边界而非 root tool_result 中立刻提交，避免把“回调已进入”误当成整个容器/宿主结果处理已静止。真实 SDK 事件顺序仍由 E-CODEMODE 验证。
- root 后出现相关写入、换目标、暂停、scope/权限改变或崩溃未知时不提交。失效意图明确报告，修复需新验证，不重放工具。重复边界/结果以 intent/root ID 幂等。
- 只有真实 intent 已提交后才允许推进下一阶段或接受目标；排队意图不算 done 或新进展。

### B5. 精确写集

| 文件                                                                   | 符号/改动                                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/invocation-tree.ts`（新增）                                       | `InvocationNodeV1`、`admitInvocation`、`observeInvocationEnd`、`sealInvocationRoot`  |
| `src/completion-intents.ts`（新增）                                    | `CompletionIntentV1`、`queueCompletionIntent`、`finalizeCompletionIntentsAtBoundary` |
| `src/receipt-store.ts`                                                 | 保留原始回执，追加/恢复资格；暴露 `qualifiedEvidence`，缓存与 index 保持有界         |
| `src/goal-tool-leases.ts`                                              | 记录可信 parent/root、原 owner；活动节点不被旧 marker 驱逐                           |
| `src/events.ts`                                                        | tool_call/tool_result 接线，结束边界先安全 finalize 再审查/续跑                      |
| `src/tools.ts`                                                         | advance_tasks 检测宿主容器上下文，明确 deferred 输出，不伪即时完成                   |
| `src/supervisor.ts`                                                    | 完成证据/最终 freshness 使用共同资格查询，排队 intent 阻断接受                       |
| `src/runtime.ts`、reader/fold、control journal                         | 树/意图/资格恢复与状态清理，不重放未知副作用                                         |
| `test/codemode-supervisor-smoke.mjs`（新增）、tree/intent/receipt 回归 | 真实 SDK Codemode only 路径与隔离故障注入                                            |

### B6. P6 验收与资格退出

先单 root+单 check，再多子调用/1000 条顺序叶子；既有平面探针转为回归，另必须实际执行真实工具 only 模式。

检查后无晚写可在静止边界 done；检查后再写不能 done；并发写、未 await 子调用被取消、root error/timeout、伪 parent、重复回调、restart unknown、mode/GoalRun 切换、store/models/image 效果均有明确结果。树不完整或 unsupported 必须明确报能力缺口，不能用模型文字“这是只编排”升级资格。

## C. P7：验收条件、检查定义、版本与回执

### C1. 正式值

新增 `acceptance-contract.ts`：

- `AcceptanceContractV1`：contractId、owner、revision、来源引用、requirements、checkDefinitions、ArtifactScope 引用、人工项、digest/信任来源。
- `RequirementV1`：requirementId、来源位置、条件文本/摘要、是否必需；不只从 Main 的任务表反推需求全集。
- `CheckDefinitionV1`：checkId、覆盖的 requirement IDs、受信来源、runner/实际调用规范摘要、输入范围、环境 profile、结构化预期与允许的 skip 规则。
- `CheckObservationV1`：check definition digest、receipt ID、ArtifactVersion、受信解析结果及可用 artifact 引用；不接受 Main 自报“tests passed”。

调用规范针对实际工具参数编码。普通 bash 使用完整 command 与 cwd/输入版本的确定摘要，不用不完整的 shell 字符串分词假装获得真实 argv；本来提供 argv 的检查器才按 argv 冻结。检查脚本/配置字节属于输入版本。

### C2. 构造、确认与变更

- Main 可以提出契约，但受信检查来源必须是用户/规格明确要求、已认可检查定义，或通过明确审阅确认；不是模型任意贴 requirement ID 就获得可信定义。
- 规划阶段构造，首次启动/编译时绑定固定版本。用户原目标、完整条件与检查含义必须可见，不能只展示不可读 hash。
- 原生业务权限/首次启动仍独立；契约确认不是业务授权。新绑定通过 P0 的版本化事实记录引用真实现有审批/目标材料，不改写旧 control/witness 字节或向已存在旧 payload 偷塞新字段。
- 重要条件/范围变化需新契约和相应用户授权；仅技术检查组织调整也要版本化并明确失效影响，不能为通过验收删必需条件。
- 旧目标没有契约时，历史保留为 legacy 宿主回执级接受。迁移不虚构来源、产物版本或条件覆盖。

### C3. 确定性接受

新增 `checkContractAcceptance(contract, observations, currentVersion)`，由 acceptanceError 调用：

1. 每个必需 requirement 有受信定义的成功、适用检查；失败、缺失和不允许的 skip 不能当通过。
2. 回执与实际调用规范、环境/脚本版本一致，不能以一个 noop 的成功回执替代契约中的测试。
3. 输入/产物版本匹配、资格有效、外部结算与人工门均满足。
4. 任务图闭包继续检查，但不替代条件覆盖。
5. 检查定义自身的质量仍需独立测试/审阅；结构匹配不证明所有语义都正确。

对于不能自动化的条件，新增 `ManualCheckBindingV1`：将 condition/check、contract digest、ArtifactVersion 与宿主生成的原生 choice/information 问题绑定。复用现有受信 human-control/private registry/物理 readback 路径，原生问题必须呈现这些条件及版本；人工回应不新增业务权限。

新增 human command `verify-check <checkId>` 进入该受信问题，模型不可伪造确认。只有匹配的物理确认才能形成手工 CheckObservation；普通聊天、SDK custom UI 返回值或复制结果不作正式人工证明。旧 permission approval 不推导为用户已接受产物。

### C4. 接受层级与写集

报告明确区分：任务记录完成、宿主成功回执、契约检查通过、模型相关性审查、真实人工/产品接受。mode=tasks 不显示监督接受，SDK/faux 测试不显示真实产品接受。

精确写集：`src/acceptance-contract.ts`（新增）、`src/validation.ts`、`src/supervisor.ts:acceptanceError/evidencePacket`、`src/review-view.ts`、`src/types.ts`、`src/schemas.ts`、`src/commands.ts` 的 verify-check、既有 human-control/board-human/material 入口的受信复用接线、runtime/reader/control journal，以及新 contract/manual-check 回归。不得顺便重写整个 UI 或宿主权限系统。

首个哨兵：任务全 done、宿主回执 exit 0，但一项必需条件无检查或调用不符，不能 accepted。另覆盖定义/版本替换、测试数量为 0、必需用例跳过、人工项未确认、伪 SDK 回应、条件来源遗漏、老记录级别不升级及 64KB 视图可处理性。

## D. 本卷交付条件

P5 不可取消总预算，P6 不可删除 pending/新鲜度检查，P7 不可把模型映射当作独立正确性证明。新增事实均需真实资格、恢复与旧读者拒绝测试，结果归并到 P8。只有相应端到端范围实际通过，才在问题总账关闭对应条目。
