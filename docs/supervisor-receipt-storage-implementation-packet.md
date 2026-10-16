# 回执存储修复实施包

合同状态：READY；G0–G3 实现与本地验收已完成，实际结果见[验收记录](./supervisor-receipt-storage-acceptance.md)。实施与测试授权来自用户“根据计划书推进至完成”，不含提交、发布、安装。

## 基线与隔离

- 工作树：`../pi-task-supervisor-worktrees/receipt-retention-plan`，分支 `docs/supervisor-receipt-retention-plan`，基线 `f6d3c7f6cab37bae2f0cb4b63024cb5eae8053ce`。
- 单 writer：当前主控代理。另一工作树的未提交内容不覆盖、不合并。
- 已只读核对并行候选：其检查点使用 v2、`continuous-tasks:supervisor-receipts` 批次日志，且内存仍保留完整 receipts。因此本候选保留已发布 v1 读取，使用 **v3 检查点 + v1 receipt-ledger**；不把尚未提交的 v2 当成已支持的稳定格式。未来候选整合必须单独处理，不能称无冲突。
- 用户已执行 stop；只读核对旧监督器为 stopped、旧回执 500。旧看板/历史不重置，本修复不复用其接受记录。
- 开发 peers 仅以本工作树 `node_modules` 临时链接复用，不安装/新增依赖；冷加载前移除该链接。

## 权威与证明

| ID  | 来源                 | 合同                                                                          |
| --- | -------------------- | ----------------------------------------------------------------------------- |
| C1  | 已批准方案书 §1–8    | 无累计 500 死锁、证据可重读、缓存有界、追加日志、真实分支闭包、迁移及安全失败 |
| C2  | 方案书 §3 / R04、R16 | 保持 task digest、epoch、结构化退出码及完整受保护材料 64,000 字节规则         |
| C3  | 方案书 §9–11         | worktree 隔离、一次一个 writer、先小样本再扩容、R01–R18 与原有全套验收        |
| C4  | 当前用户 stop        | 旧目标停用不等于新修复已验收，禁止清旧板或解除授权门                          |

SDK 小样本已执行：`/tmp/pi-supervisor-receipt-g0-E3eXVQ/` 的 SDK 1.1 与 1.2 supervised faux harness 均 PASS；确认 serial tool_call→tool_result、真实 leaf/parent 与 getEntry 读回、结构化 exit_code=0，真实 settings 未改。它们不是并发/嵌套、迁移或新实现的通过证据。

## 冻结设计

1. 对外 `tool:<toolCallId>` 与 Runtime SupervisorState 的公共字段保持兼容。运行态 `receipts` 仅作有界缓存投影，不是全部历史，也不是验收权威；所有证据消费者使用统一读取器。持久化检查点单独为 v3，不保存缓存体。
2. `ReceiptSchema`、脱敏与 digest 的现有实现归入 `receipt-store.ts`；从 supervisor 保持兼容 re-export，避免循环依赖和两份算法。
3. 一个 `ReceiptStore` 拥有当前 session/goal 的账本头、epoch、待完成调用、小型原始回执缓存和定位索引。定位索引只存 receipt ID→日志位置/序号，不保存全量回执副本；其元数据随历史线性增长，**不谎称插件总内存恒定**。缓存受数量和 UTF-8 字节双预算限制。
4. 每个潜在修改调用先持久化 intent 并推进 epoch，结果闭合；普通调用推进一次，若未知父调用跨越其他修改，则闭合时再推进版本，防止把子验证冒充整个父调用后的验证。开始/结束时与其他修改交错的回执不具备新鲜验证资格。只读工具仍记录，但不推进 epoch。
5. 缺少开始上下文或结果冲突不能制造证明；未知/未闭合调用只有人类合法 recover 可写 close_unknown，随后必须新验证。结果写失败保持 intent 和旧证明失效，不自动重试工具。
6. append 验证使用公共 getLeafEntry/getEntry 与直接 parent，无每条全分支扫描；恢复一次扫描当前分支，验证每个相关检查点的 head、epoch、count 和 pending 引用，再重放增量。缓存缺失通过定位索引和真实 entry 读取。
7. 新目标初始化独立 UUID。v1 未完成目标仅在显式 recover 时以精确 legacy checkpoint ID/digest 作只读锚点迁移，epoch+1；终态保持旧规则。旧代码遇 v3 明确失败；本候选遇并行未发布 v2 也明确失败，不猜测兼容。
8. 配置默认缓存 128 条 / 1 MiB；不是累计执行预算。advisor 仍查询绑定 refs 与最近 30 条，缓存大小不影响选取范围。
9. 完整账本记录在 append 前做有界 Schema 校验，确认后仍检查真实 entry/leaf。迟到/未匹配结果以 `close_unknown.resultGap` 持久化失效屏障，不制造 receipt、不自动闭合仍待人工处理的 intent。账本身份同时冻结 session/goal/model/preflight tuple；v1 锚点必须是当前分支更早的精确 Supervisor 检查点并匹配 scope。

## 精确符号与写集

| 文件/符号                                                                                                                                                                                                                                                 | 改动                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `receipt-store.ts`：`ReceiptSchema`, `ReceiptLedgerSchema`, `ReceiptStore`, `digest`, `redact`, `redactedJSON`                                                                                                                                            | 新 Module；prepareToolCapture、commitToolReceipt、readReceipts、restore、checkpoint、closeUnknown、缓存配置/统计 |
| `supervisor.ts`：`saveSupervisor(pi, candidate?)`, `startSupervisor`, `restoreSupervisor`, `recoverSupervisor`, `prepareToolCapture`, `observeTool`, `receiptMatchesReview`, `assertObservedEvidence`, `acceptanceError`, `evidencePacket`, `applyAdvice` | v1/v3 检查点、统一查询、生命周期与故障闭包；保持现有导出和证明规则                                               |
| `runtime.ts`（含 `receiptIdentity`）, `state.ts::resetState`                                                                                                                                                                                              | 实例本地 store 初始化/清理；不使用跨实例全局缓存                                                                 |
| `events.ts::registerWorkHandlers/registerSessionHandlers`                                                                                                                                                                                                 | 现有 gate 后捕获 tool_call；结果闭合、保持 structuredContent；日志失败不递归重写并反复刷旧告警                   |
| `commands.ts::resume`                                                                                                                                                                                                                                     | 候选状态通过 saveSupervisor 写检查点，不能直接追加运行态伪 v1                                                    |
| `config.ts`                                                                                                                                                                                                                                               | 可选 receiptCache 范围校验；既有配置兼容                                                                         |
| `flow.ts::formatFlowStatus`                                                                                                                                                                                                                               | 只读显示累计、缓存、pending、格式与健康；不改人类门顺序                                                          |
| `async-execution.ts::executionWaitTimer`                                                                                                                                                                                                                  | 保持特定 expiry 持久化故障来源，不用通用账本错误遮蔽；不增加执行/重试                                            |
| `package.json::scripts.test:smoke`                                                                                                                                                                                                                        | 原有八模式加长历史、迁移与 intent 三模式；不改版本、依赖或锁文件                                                 |
| 原有 tests/helpers、新增 receipt-store tests、SDK smoke                                                                                                                                                                                                   | 系统边界 mocks 使用实际 branch/leaf；业务证明经 tool_call/result，不靠补造回执                                   |
| 方案、README、CANARY、CHANGELOG                                                                                                                                                                                                                           | 更新实际行为与验证记录，保留历史                                                                                 |

## 失败优先级与禁行路径

- 日志/作用域/前驱损坏 → journalFault；不能降级成无监督。
- 未知执行或未闭合 intent → interrupted/fault，保持更强 hold；禁止验收和自动重放。
- 原有 preflight、board decision、暂停与预算门不因迁移或缓存释放。
- 过期/错误证明按原证据规则拒绝；缓存回收不是故障。
- 完整受保护材料超 64,000 字节仍拒绝，不提高限制。
- 禁止：清 receipts 以 recover、自动重开终态、读其他分支补证明、把 v2 候选当已发布基线、重复派发、改旧任务历史、降低覆盖率阈值。

## 执行与接受

- G0：本包 READY；并发/嵌套规则按上文保守冻结，真实行为在 R10 验证，失败则先修合同不跳断言。
- G1：在已批准的 host-event / ReceiptStore Interface 做第 501 条 RED→GREEN；最小验证后实现完整闭包。
- G2：旧格式锚点、迁移、树分支及故障注入。
- G3：配置/状态、R01–R18、100→1000→5000 资源样本、现有 90% 覆盖门和完整 npm run check、SDK 1.1/1.2 冷加载。
- 主控独立于写代码步骤做候选 diff 的 blocker 自查；未新增正式外部审查授权，不声称取得第二个独立 reviewer 批准。
- 完成依据为独立 worktree 的明确 diff/hash 及新验证，不使用旧目标 5/5 接受。提交身份在获得提交授权后再固定；当前先记录已验证候选文件哈希，不擅自创建 commit。
