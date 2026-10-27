# 分卷 02：最终审查、证据视图与管理生命周期

> 覆盖 P3/F-02/F-03、P4/L-01–L-04。依赖[总则](../supervisor-change-plan.md)的身份/产物/追加合同，以及[分卷 01](01-execution-accounting.md)的结算和记账结果。仅文档，未开始实现。

## A. P3：最终审查状态与有限重试

### A1. 状态拆分与投影

新增 `FinalReviewStateV1`，不直接给旧 wire5 的 GoalPhase 加枚举：

| 状态             | 进入条件                                 | 允许的后续                   |
| ---------------- | ---------------------------------------- | ---------------------------- |
| not_ready        | 任务/执行结算/证据尚不完整               | 已授权工作与验证，不接受目标 |
| pending          | 工作与必要验证已完成，审查视图可构造     | 开始审查                     |
| running          | 记录审查进入、预算和当前输入版本         | 结果/详情/有限重试/取消      |
| retryable_error  | 只有审查调用失败，事实仍适用             | 同 GoalRun 的 retry-review   |
| needs_validation | 产物或检查前提改变、旧证明不适用         | 新验证，不重放已完成业务     |
| blocked          | 权限/身份/执行未知、材料缺失或容量不满足 | 对应原门禁/材料修复          |
| accepted         | 确定性门与相关性审查均通过               | 记录接受的版本；不授权新业务 |

`workComplete` 是任务、执行结算与验证事实的派生结论，不能由 Main 写一个布尔值。board completed 只表示任务层终态。状态兼容投影可继续显示旧 Supervisor active/reviewing/fault/completed，但所有实际准入使用新的组合状态，不靠旧字符串推断执行是否重新开放。

新增 `ReviewAttemptV1`：attemptId、GoalOwnerKey、board/task binding 摘要、ArtifactVersion、reviewViewDigest、起止 leaf/epoch、状态、结构化 failureClass、已用调用/纠正/详情轮次、期限、call IDs。接受记录单独绑定当次版本，不改写旧接受历史。

### A2. 明确的入口与顺序

- `requestFinalReview(ctx)`：从当前事实生成可审查输入，不重跑任务。
- `retryFinalReview(ctx, attemptId)`：供新增 human command `/task-supervisor retry-review [attemptId]` 使用；不调用通用 recover，不复位预算。
- `finalReviewEligibility(ctx)`：统一返回 ready / needs_validation / blocked 及机器原因；提交、重试和 UI 共用。
- `runReviewAttempt()`：取得 view → 记录 attempt/call → 请求原始响应 → 先归账 → 检查 lease/解释 advice → 追加审查结论。

重试入口必须验证：同 owner、同任务与绑定摘要、有效权限/首次启动、无未决人工门、无未结算执行/宿主捕获、当前产物与前提 same、证据资格仍适用。未知产物版本不能当 same。

running/retryable_error 下的工作完成态只开放只读材料/审查控制，不把 Supervisor 简单设 active 后顺便开放 write/edit/claim。needs_validation 可允许已授权的验证；需要修业务时应先明确状态转换及失效范围。

### A3. 错误分类与预算

- 结构化可识别的 503、可重试传输错误：至多一次自动重试；共用原 30 秒总期限。
- deadline 已耗尽、调用槽位不足：保留 retryable_error，允许以后显式 retry-review 启动新的受限尝试，不重建 GoalRun。
- 认证、身份/权限、上下文变化、未知执行、容量/材料错误：不套用传输自动重试。
- 只有英文 error.message、没有可信结构化 status 的错误：归为 unknown_model_failure，不靠字符串含“503”自动判断；事实仍适用时可显式 retry-review。
- 每个真实重试、纠正或详情调用都按分卷 01 记账并占预算。每个审查尝试最多 4 次 provider 调用、至多 1 次传输重试、1 次动作纠正、2 次详情往返；这些是同时生效的上限，不保证所有分支都能用满。
- 保留模型每次 2048 token 输出和单包 64,000 UTF-8 字节限制；不通过放大 cap 解决 F-03。

任务、授权和产物已改变时进入需要新验证/新授权的路径，不能拿“临时故障”恢复旧证明。通用 recover 对真正失效的 completed/accepted 保护不删除。

### A4. 旧完成态恢复

旧 fault 没有结构化 failureClass/ArtifactVersion，不能从原因字符串伪造可重试事实。明确的 retry-review 命令可引导：核对实际旧记录、保留已完成任务、补新的适用验证和版本事实，再创建新审查尝试；不重复业务、不虚构旧产物版本、不重新授予权限。

## B. P3：一个有界审查视图构造器

### B1. 值与职责

新增 `review-view.ts`，导出纯函数：

- `buildReviewView(input, limits): ReviewViewV1 | ReviewViewError`；
- `reviewViewDigest(view)`；
- `resolveEvidenceDetail(input, registeredRef, limit): EvidenceDetailV1`（只使用宿主已登记材料，无任意路径执行）。

`ReviewViewInput` 包含 owner/目标、当前权限边界、候选看板和绑定、受信 receipt 投影、结算、当前 ArtifactVersion 与可用检查契约。它不访问可变全局状态，也不追加记录。

### B2. 必须保留与可分页内容

- 必须保留目标与权限限制、条件/check 标识、必要结果、版本适用性、完整关键引用与 hash。缺少这些则不能得到完整审查结论。
- 长提示、原始输出正文和最近消息使用有界摘录与详情引用。保留信息充分性/截断标记；不把 digest 当作内容已被读过。
- view 不修改 receipt、原生记录或旧摘要。现有 receipt 的 output 本身可能已被既有捕获上限截断，详情只能返回实际保留内容；原始输出不存在时明确 truncated/missing，不能凭 hash 恢复或宣称全量可读。
- 新的受信检查可登记结果 artifact，读取须限定于获准产物范围并校验当前 digest/版本。不接受模型传入任意本机路径。
- 必需元数据本身仍可能超限。此时返回 REVIEW_VIEW_TOO_LARGE 和可操作拆分建议，而不是只截正文后照样发送一个超限包。

### B3. 同一规则用于提交前和真实审查

`advance_tasks` 完成候选先经现有证据校验、构造 next board/next bindings，再调用同一 buildReviewView 检查该候选的审查可处理性；通过后才执行关键持久化/绑定/发布。

不能为了检查先修改 live state；不能先 done 后发现无解；也不能维护一套估算公式与另一套真实打包规则。已存在旧超限 completed 看板通过 A4 的视图/补充验证路径处理，不清空账本或重新规划全部任务。

新增只读 advice 动作 `request_evidence`：仅可引用本 view 已登记的 evidence/detail IDs，并列明缺什么；宿主在既定 cap/轮次内补给。它不授予权限、不执行命令、不接受任意路径。无可用详情或剩余预算时，报告材料不足/blocked，不能默认通过。

## C. P3 精确改动集

| 文件                                                              | 新增/修改符号                                                                                               | 内容                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/final-review.ts`（新增）                                     | `FinalReviewStateV1`、`ReviewAttemptV1`、`finalReviewEligibility`、`requestFinalReview`、`retryFinalReview` | 状态、资格、重试与结论；业务执行不在此重放                   |
| `src/review-view.ts`（新增）                                      | `ReviewViewInput`、`ReviewViewV1`、`ReviewViewError`、`buildReviewView`、`resolveEvidenceDetail`            | 一个容量与详情规则                                           |
| `src/supervisor.ts`                                               | `evidencePacket`、`AdviceSchema`、`modelAdvisor`、`prepareReview`、`applyAdvice`、`reviewSupervisor`        | 委托共同构造/编排；支持 request_evidence、结构化失败与先归账 |
| `src/tools.ts`                                                    | `createAdvanceTasksTool`                                                                                    | done 前的候选 view 检查，不改变 F2 写入后发布顺序            |
| `src/state.ts`                                                    | `persistTaskUpdate` 的调用接线                                                                              | 保留现有关键追加闭锁；不得把 UI/网络审查塞进 afterPersist    |
| `src/commands.ts`                                                 | 新增 retry-review 路由                                                                                      | human command，不是模型可直接改变权限的工具                  |
| `src/events.ts`、`src/flow.ts`、`src/ui-capture.ts`               | 新审查状态的边界处理和只读显示                                                                              | 区分待审查/可重试/需重验，不泛称需重建目标                   |
| `src/runtime.ts`、`src/control-journal.ts`、严格恢复 fold         | 审查投影恢复/归属/清理                                                                                      | 只读恢复不自动派发旧请求                                     |
| 新增 final-review/review-view 测试与 acceptance/model/packet 回归 | 公开链路测试                                                                                                | F-02/F-03 与失效负向对照                                     |

P3 首个哨兵仍是已经复现的 503 completed 死路和 16×1600 中文证据。新算法必须保留 raw ledger 摘要，同时实际调用可用 Advisor；不能只让测试改为期待失败。

## D. P4：管理模式与执行归属

### D1. 模式、转换及状态来源

新增 `management-policy.ts`：

- `ManagementMode = off | tasks | supervised`；
- `WorkContext = unmanaged | board(owner) | goal(owner)`，由可信命令/宿主确定；
- `decideAdmission(snapshot, operation)` 返回 allow / readonly_only / deny、原因和 owner；
- `requestModeChange()` / `completeModeChange()` 处理请求、静止检查与持久化。

`SessionModeChangedV1` 包含 sessionId、revision、previousModeRecord、mode、activeWorkOwner/null、lastGoal/null、attention refs。只有 human command adapter 可改变模式，模型不能传一个 managed=false 绕过门禁。旧回调按发起时 owner 结算，不因当前 off 就变成当前证据。

新会话默认 off。恢复旧 activation/GoalRun 不静默改成 off：显示 legacy-compatible/held 投影，保持历史原语义与中断保护；首次明确模式转换后按新记录最新有效 revision 恢复。不能再以“曾经出现过 enabled=true”作为最终模式。

### D2. 命令语义

| 命令                 | 拟定效果                                                             | 必须保留                                       |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------- |
| enable               | 进入 tasks 轻量看板，不启动 Advisor                                  | 任务记录 done 不是监督验收                     |
| supervise            | 统一进入显式 supervised 规划/权限/首次启动流程                       | 不因旧历史而偷偷改变含义；兼容快捷方式单独声明 |
| pause                | 留在管理上下文暂停，不能继续写受管任务                               | 权限、计数、未决执行和人工门                   |
| stop                 | 立即停止监督/自动继续并结束目标处理；不 kill 外部进程                | 未完成任务、引用、账目与历史真实性             |
| disable              | 幂等请求退管，即使没有 Supervisor、只有看板也可调用                  | 不伪造外部终止、授权拒绝或验收                 |
| retry-review         | 仅按 A 节资格重试终审                                                | 不开放一般业务写入                             |
| status/history/tasks | 显示模式、归属、最后目标、attention 和已知加载修订；不知道就 unknown | 只读，不重新开启监督                           |

supervise 新流程的独立权限和首次启动只在用户选择受管执行时发生；off 的普通工作不被要求创建 GoalRun。宿主工具本身的许可控制始终独立存在。

### D3. 停止与完整退管不是一个瞬间

1. 人工 stop 先立即取消自动监督/继续、使旧回调租约失效，再确认停止意图的持久化。未知执行或追加故障不能让取消动作不发生；若持久化不确定，保持故障/现场，不假称退管已成功。
2. 在宿主真实 idle 后，经 P1 核对受管运行、宿主捕获和未决控制。
3. 已静止、关键结果已知且没有必须先处理的真实控制事项：确认模式转换，将 activeWorkOwner 置空，进入 off/unmanaged 工作上下文。旧目标只作为历史/attention，不再因其 phase 全局拦普通新工作。已知失败的业务修复/任务未完成可以保留历史，不强迫用户先把业务做完才允许 stop；这与通过目标验收需要处理 resolution 是不同门。
4. 仍 running/unknown writer、关键追加结果未知，或存在不能直接关闭的控制：显示 stopping-with-attention，明确自动化已停、完整释放未完成。保留已知事实；第一版不提供静默强制脱离/清空引用。不能把单纯已知业务失败与仍有未知写入混为一类。
5. UI 不把“收到 stop ACK”显示成“外部进程已停止”。取消执行器需其原有授权入口，不能假定用户停止 Supervisor 就授权所有远端 kill。

tasks 模式若需要独立看板归属，使用宿主分配的 board owner（见总则补充），不伪造 GoalRun 或继承旧 GoalRun grant。off 不运行 Advisor、不显示为当前受管业务；它仍不能把旧许可当作新动作授权。

### D4. 完成后工作交接

历史接受绑定接受时的版本，保持不可改；当前有效性另行表示 accepted / needs_verification / stale，不直接删掉历史事实。

- 可信只读调用保持版本，不要求新目标。
- 普通 Bash/未知容器不靠命令字符串自称只读；先保持保守资格，必要时核对受信产物/检查前提。无法确认则需新验证，而不是宣称内容没有变化。
- 目标尚未接受、范围未变的补验证可留在原 GoalRun 的验证/终审阶段；真实范围改变须新授权/交接。
- 已验收目标之外的新授权工作，可以明确进入 unmanaged，或新建受管目标。交付收尾若是原需求，提前在契约列入，避免先接受再强迫重建。

### D5. 精确改动集

`src/management-policy.ts`（新增）、`src/scope.ts` 的 enable/restore/updateActiveTools、`src/runtime.ts`、`src/commands.ts`、`src/goal-commands.ts`、`src/goal-scope.ts`、`src/goal-tool-leases.ts`、`src/events.ts` 的准入/上下文/边界，以及 flow/UI 的只读模式显示、control journal 与恢复。

旧 enabled 接口保留为兼容投影，不再成为另一套独立真相。task gate、before_agent_start 和 boundary 都消费 decideAdmission/同一 WorkContext；不在三个地方分别判断一组布尔条件。记录模式改变不修改原生 control/witness，不将旧 unresolved 问题批量转为 rejected/approved。

### D6. P4 验收矩阵

- fresh/resume/tree；legacy/scoped；无 Supervisor/active/stopped/completed；GoalRun planning/stopped/completed；off/tasks/supervised。
- 无未决事实时 disable 持久生效，恢复不被历史 true 激活；stop 后新普通 Git 工作不挂到旧 GoalRun。
- 有未知执行时自动化能立即停，但不假称完整释放；没有 Supervisor 的看板也可请求 disable。
- 模型不能改变模式/伪造上下文；暂停/撤权/未决问题仍阻断原受管工作；旧结果不串入新 owner。
- 只有 SDK/faux 验证时不宣称真实 CLI/原生身份矩阵通过；实际加载修订未知时按 unknown 显示。

## E. 本卷边界

P3 不等于可以重开任何 accepted 目标；P4 也不等于抹掉旧义务或宿主权限。Code Mode 的延迟完成和更强条件覆盖分别由下一卷消费，不把本卷状态拆分误称为全部问题已解决。
