# 恢复与模式修复：W0 实施契约

2026-10-29。Full packet；来源为[计划v4](./supervisor-recovery-and-mode-repair-plan.md)及用户当前“按照计划推进至完成”执行请求。Main为唯一实现/集成写者，main单工作树。允许本地实现及隔离验证。用户后续已明确授权：完成验证后提交、推送并安装到本机；本轮按该顺序发布。此授权不包括重载当前/业务会话、恢复业务任务或npm发布。

## 权威与保留项

- C1–C8：计划F1–F8及第3、5、7、8节的身份、权限、停机、证据和兼容约束。
- C9：独立审阅P2阶段验收修正：W1只通过实际SDK生命周期/规范模式Module证明持久化机制，不宣称tasks-only命令E2E；W5交付规范命令，W6经真实命令重跑。不得保留测试专用兼容入口或伪造批准。
- 基线95cb9d77c7dbc5cf944590c37f127a87d135ccb7；已有UI提交不重做。两份审计报告及RED路径见计划；旧绿灯不作为本轮接受。
- 保护未跟踪`.pi/`与journal-growth计划；旧来源/历史hash不变，弱历史不升级。

## 已冻结的公开接缝和测试面

用户批准的接缝：计划列出的命令Adapter、真实SDK SessionManager/生命周期、管理模式Module、flow动作判断、预算控制、invocation图/来源/资格、正式检查与receipt消费、范围修订提案/原生审核/修复/撤销。使用这些公开Interface做RED/GREEN；不测试私有方法或借复制NativeAnswer作为来源。

## 符号及值契约

### 停止意图与动作

- `materializeManagement(pi,ctx)`：来源可验证时补齐原volatile管理选择；off也必须可落盘。原Session/manager/物理前缀或owner不符即保持hold，不能用缓存off制造来源。
- `requestModeChange(...,"off")`：仅已确认durable off（或来源尚未落盘的纯volatile状态）可无写入幂等返回；来源落盘后应完成原关闭，不中断无关宿主工作。
- `events`的before-agent、settled、shutdown与tree恢复接缝在来源变成durable后承接volatile off，包含纯文本无工具场景；不得在只读status渲染中写入。
- `nextFlowStep/formatFlowStatus`：off显示正常unmanaged，无强制enable/监督检查点；stopping attention保留实际原因。
- 预算事实以原owner真实`reviews + advisorExtraCalls`、continuations和已知/未知使用量为输入；公共纯评估与控制方新鲜捕获分开。耗尽在recover写状态/关闭捕获之前拒绝；不清旧用量，不实现充值。

### 原始根与真实能力

- 直接根只证明实际SDK工具调用/结果闭合，不要求codemode调用表，不因缺少容器capability虚报容器失败。
- 容器根继续要求实际builtin/schema/工具限定能力、完整子树、无未解释副作用和实际kernel end；models-enabled不降格假装tools-only。
- 新根封存版本区分`direct`和`container`及`observed/qualified/held/unknown`；direct observed不等于资格提升。旧V1 seal按原规则解读、原字节保留。新特征先于新版本payload。
- 执行能力评估返回`direct-check | tools-only-container | unsupported`、具体原因和真实入口。选定直接通道必须确认实际工具来源/暴露及有效loadout；如果工具模式仅允许不合格容器则拒绝，不能静默改全局配置。

### 同Goal范围修订

- 提案独立于旧preflight快照，包含实际owner/source、原批准与Start、前一修订/契约引用、完整有效计划/验收提案和reason。提案无授权；完整材料超过既定容量则明确拒绝，不能裁字段。
- `propose_scope_revision`仅提交元数据；`review-scope`以私有原生authorization回应精确材料；`repair-scope`仅补齐同版已确认记录；`revoke-scope`撤销新范围不自动退回旧授权继续。
- 第一版只允许同owner/工作区/已选权限对象内的约束和验收修订；不添加未选权限/根/运行时能力/监督硬预算，不改原Goal/Start/账本。
- 新事实的实际wire名：原生`acceptance-scope-control`、`scope-revision-committed`、`scope-revision-revoked`；提案customType为`continuous-tasks:scope-revision-proposal`。严格schema及引用顺序，使用`scope-revision-v1`特征。提交引用原提案、回应、物理见证、旧修订和候选契约；候选契约authority引用已出现的提案/回应，不能反向引用未来commit形成环。
- 修订提交是唯一激活点；提交前的候选契约不能被`selectedAcceptanceContract`选为有效当前契约。任何半写保持执行关闭；同版原材料仍成立才能补齐，材料变化必须新审核。
- 私有执行Frame及新capture/receipt通过可选`scopeRevisionRef`关联有效修订Ref；Supervisor仅在显式recover后保存同名采用标记，resume/repair不能代为采用。旧事实的字段缺省/hash语义保持原样。物理reader验证capture/receipt的生效前缀；新修订的证据还必须匹配原始ReceiptStore来源，不能给复制DTO补引用后提升。
- 私有执行Frame及新capture/receipt关联有效修订Ref；`qualifiedEvidence`的direct快捷路径、嵌套attestation、完成意图和最终验收均重新验证适用性。旧成功不自动成为新修订证据，旧hash与字段缺省语义不变。
- 旧scope撤销不能被新提交复活；父修订撤销阻断后继。所有控制的source/session/owner/branch、版本、原批准/Start和quiescence重新核验；未知不默认为无。

### 唯一命令面

- 主入口`supervise <goal>`幂等，`supervise --replan [goal]`只重规划同一未启动Goal，`--`保留字面目标。
- `tasks-only`复用规范任务模式Module；`tasks`仍只读。
- 删除preflight/enable/supervise-legacy/resolve及整个/continuous-tasks注册；旧名不转发、不保留隐藏测试入口。历史continuous-tasks:\*和相关reader继续存在。
- 测试/脚本正向流程迁移至规范命令或已命名的机制Interface；不得把机制测试伪称原生命令或批准证明。
- `registerSupervisorComponents`只注册组件，不选择模式、授权或启动。单元/受信host SDK机制夹具显式调用已有模块API；不注册legacy命令、替换命令字符串或伪造批准。隔离host夹具按实际session ID限定且不进npm包，不可把它当成当前人类命令/Start证明；人类命令的接受由真实CLI/PTY单独证明。
- flat规划的preflight ID标识一次规划尝试，不是已执行Goal owner。普通重复supervise保留它；显式replan只在无已有提案/批准/未决控制时创建新尝试，目标文字和未启动状态保持，不挪用旧尝试许可。生命周期Goal复用原重规划模块、保持GoalRun身份。

## 失败优先级与兼容

来源/owner/branch不确定 → 未闭合执行/捕获/原生控制及撤销 → 修订与材料缺失/过期 → 实际能力/预算不足或未知 → 当前验证/验收。显示缓存不是授权。每个新增feature必须先fence；旧reader拒读，旧事实不迁移为强来源。

## 写集、顺序与接受

Main串行持有计划W0–W6写集。先W1模式持久化与展示，W2预算，W3根/能力，W4修订及证据，W5规范命令与旧入口移除，W6集成。共享schema/feature变化在对应生产写入前落实reader与直接边界测试，不以局部mock通过代替原始来源。

- 编辑循环：正确公开接缝的最小RED/GREEN；实际SDK持久化用真实SessionManager，先有界样本后扩矩阵。
- 候选：相邻测试、typecheck、lint、format；规则/阈值不降低。
- 最终：完整npm run check；实际默认builtin存在的SDK1.1/宿主1.4 CLI矩阵；范围修订/定义准备/正常Start；80×24原生UI、故障写点/冷恢复/旧reader/包内检查；保护文件与候选逐文件复核。
- 只有全部F1–F8闭合且无所需遗留工作才结束目标。计划、阶段派发、RED或未验证断言不算完成。

**W0设计门：READY，允许Main沿上述接缝开始已授权实现。** 新增记录schema/reader在生产写入前以同一Main原子实施；若实际源码显示冻结契约不可实现，先修订本packet并保留原要求，不能缩减目标。
