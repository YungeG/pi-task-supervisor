# Supervisor 操作指引一致性与恢复交接修复计划

2026-10-30 · 设计基准 v1。**当前本地实现及验证已完成，未批准或执行发布。** 详见[实施与验收记录](supervisor-guidance-consistency-validation.md)。下文保留制定计划时的范围和授权边界。

## 1. 目标、基线与权限范围

### 1.1 要解决的结果

同一份当前状态，状态页、Main 上下文、命令回执、TUI 必须给出一致且可执行的下一动作。按提示执行后，应当满足下列之一：

1. 到达下一个合法阶段；
2. 明确说明等待谁、等待什么事实，以及怎样触发下一步；
3. 发现新的真实阻塞，并给出与该阻塞匹配的诊断路径。

不能反复推荐一个已知不会改变状态、也不会提供新信息的动作。不能把材料缺失、宿主能力问题或预算耗尽交给用户重复批准来解决。

### 1.2 基线

- 仓库与已安装受审版本：`118229f64e02be364836aa394042db169dac6e0e`。
- 审阅结论：原问题 K0 + 新增确认 F1–F6；其中新增为5项运行时缺陷、1项文档错误，均 P2。
- 现有证据：11文件/345测试通过；新增10项探针中8项正确行为断言失败、2项正向对照通过，重复运行一致。
- 未证实项 U0 不算确认缺陷；必须先补合格夹具，不能直接按静态猜测改控制逻辑。
- 实施前重新记录 HEAD、工作树、受影响文件哈希。若基线变化，先重放代表性探针并检查差异，不盲用旧行号。

### 1.3 本次和后续授权边界

本文件最初落实用户“给出详细的修复计划”的请求。用户随后以当前Goal“按照修复计划推进至完成”授权本地实现及隔离验证；这些已完成，设置、安装包和业务会话未改。

发布操作仍需相应执行授权。以前针对 `118229f` 的提交/推送/安装授权不自动适用于这轮新修订。以下均为独立边界：

- 本地源码与隔离验证；
- 提交、推送、安装；
- 重新打包；
- 当前/业务会话重载、恢复、批准、G0重跑；
- npm发布。

本计划不授权后四类操作，也不要求用户为了计划审阅先恢复业务会话。

### 1.4 不变式

- 规划 ≠ 批准 ≠ 首次 Start；元数据登记 ≠ 执行 ≠ 验收。
- 原 Goal/owner/Session/branch、workspace、原权限对象、禁止项、准备能力、首次 Start、任务身份和已用预算不重建、不重置。
- 修复只能补同版原始见证支持的元数据；材料变化必须新的精确原生审核。
- 撤销不回退旧授权；后继提案不能复活撤销链。
- 未闭合执行、未知捕获、来源不明、预算未知均不得解释为零或成功。
- 显示缓存、复制 DTO、用户聊天、模型判断不产生原生批准或检查资格。
- `status`/TUI 展示不写日志、不扫描工作区重算版本、不派发 Main；保留现有恢复单次物理扫描与账本资源门。
- pause/review/repair/验证登记维持不自动派发业务的语义。显式人工消息可请求 Main 做原有准入范围内的元数据工作或精确验证，不因此扩大权限。
- 不恢复 `preflight`、`enable`、`supervise-legacy`、`resolve`、`/continuous-tasks` 等已删除入口；旧历史 wire/readers 不删。

## 2. 范围与问题映射

| ID | 已确认现象 | 本计划交付 |
| --- | --- | --- |
| K0 | recover→active 后无法提修订；pause 后 Main 不自行再提交 | 明确区分原范围恢复与暂停中修订；可直接发送的 Main 元数据请求；实际事件准入验证 |
| F1 | Start失败后，主 Next、Next preflight、Main 提示相互矛盾 | 统一包含真实诊断的审批动作投影 |
| F2 | repair返回 needs_review，Next仍指向repair | 绑定来源的展示诊断，完整命令结果，精确转入review |
| F3 | 最终验证已登记，Next仍推荐重复登记 | 区分登记前、已登记待验证、已有新证据待审查；明确 Main 交接 |
| F4 | 预算耗尽时resume回执仍推荐recover | 回执复用共享预算/流程判断 |
| F5 | 撤销范围后Main仍被推荐提交后继提案 | 撤销专用分流；不再推荐不可达动作 |
| F6 | README仍推荐已删除命令 | 当前操作说明与真实命令面一致 |
| U0 | completed后范围提交与采用规则可能冲突，尚未复现 | 独立调查、有效正负对照、明确支持范围；未经证实不改控制门 |

### 非目标

不重写整个Supervisor，不引入通用工作流框架，不新增自动审批/自动恢复，不扩展范围修订支持的新权限对象，不改业务G0基线，不升级浏览器依赖。本轮默认不新增人类命令或模型工具。

## 3. 设计决策

### D1：统一动作推导，不新建第二个控制器

保留现有职责：

- `approval-bundle.ts / approvalAction`：纯审批/定义阶段判断；
- `scope-revision-journal.ts`：范围状态与只读投影；
- `final-review.ts`：验证登记、当前验证及最终审查事实；
- `flow.ts / flowFacts / nextFlowStep`：组合当前动作与门槛优先级；
- `commands.ts`、`preflight.ts`、TUI：表达结果和指引，不另行猜下一步。

实现时先删除重复分支，再补缺失的结构化状态。不要给整套系统再包一个能执行任意动作的注册器。

### D2：共同语义至少包含五个信息

各领域已有动作类型按需补齐：

1. `actor`：user / Main / host；
2. `stage`或稳定结果码：处于哪个实际阶段；
3. 当前动作：命令、模型工具，或明确的人工消息；
4. `effect`：此动作实际改变什么；
5. `remaining`：不会顺便完成什么，还有哪些门。

格式可以不同，语义必须一致。机器结果保留原字段兼容，新增字段为可选补充；不把自然语言错误消息解析成授权或阶段状态。

### D3：不把未知意图推断为范围修订，也不把所有hold推断为recover

没有成功提案、没有来源明确的修订事实时，Supervisor无法仅凭Advisor文本判断用户到底要恢复原范围还是修订范围。

因此通用held提示应给出**带条件的两条路线**，不是无条件“然后recover”：

- 原范围与条件仍有效，真实阻塞已经解决：检查其余门后显式recover；
- 需要修订范围：保持paused/fault，由Main先提交完整元数据，再原生审核。

“需要修订”是明确的人类/任务意图，不通过匹配reason中的“G0”“修订”等文字制造一个新控制状态。

### D4：修补明确交接，不改变pause的行为

本轮不新增 `prepare-scope` / `validate-final` 等命令，不让pause、repair或登记隐式唤醒Main。

在需人工发消息的场景，必须明确显示：

> Main目前没有被排队。请发送下面的受限请求；该消息只请求元数据/精确验证，不是业务批准或恢复。

并给出完整可用请求，不再使用“收到暂停回执后我会继续”这类没有实际唤醒机制的承诺。

如果未来需要“一次原生命令显式排队元数据Main轮次”，应作为另一项有明确意图、取消、重复请求、冷恢复和未知派发处理的功能设计；不偷偷塞进本轮提示修复。

### D5：显示诊断只减小误导，不成为授权

范围修复等新展示诊断必须绑定原owner、Session/文件身份、提案/控制/契约引用。跨目标、分支失配、重载或不同提案不复用。

默认不新增持久化协议记录。冷恢复后若没有可用的“已检查材料变化”诊断，应诚实显示“待核查原修复材料”，而不是宣称当前可修复或可执行。明确的核查命令可提供新信息；同一活跃上下文已得到needs_review后不得继续推荐无信息增量的repair。

### D6：优先级按动作类别保留，不让展示替代准入

对业务执行/自动继续：原有来源、身份、控制、未闭合执行、范围、能力、预算、当前验证检查全部保留。

对诊断/元数据：仍需自己的来源与静止条件，但不能因为业务预算耗尽就隐藏只读说明或原见证元数据修复。可展示“元数据可处理，但即使完成也不能恢复”。具体动作仍走原处理器。

## 4. 目标行为矩阵

| 事实 | 主提示与负责者 | 控制效果 | 禁止的提示/副作用 |
| --- | --- | --- | --- |
| 已批准未Start，定义变化 | user：审核当前定义 | 不重新授予未变业务权限 | Next preflight不得再说Start |
| 已批准未Start，材料缺失 | Main：核对并补齐必要材料 | 不自动修文件/运行程序；既有权限门保留 | 不催approve或Start |
| 已批准未Start，证据通道不支持 | Main/宿主配置责任人：核对真实工具模式 | 不静默改settings | 不能以重新批准解决能力缺失 |
| active时提交范围元数据 | user：先pause；随后显式请求Main元数据工作 | 不自动暂停/恢复/修正提案 | 错误不得只说泛化source unknown |
| paused且无成功范围提案 | 按意图选择原范围恢复或修订路线 | 不猜意图，不自动派发 | 不无条件推荐recover |
| 提案缺reason或不可变项不符 | Main：修正指定字段/恢复原固定对象 | 不写候选授权，不静默补字段 | 不把权限扩大包装成“格式修复” |
| 有未审核提案 | user：review-scope精确ID | 只审核当前材料 | 不重复preflight/Start |
| 已见证但元数据不完整、同版资格待核查 | user：repair-scope核查/补齐原记录 | 原见证不变 | 不声称已有当前执行许可 |
| repair确认材料已变化 | user：review-scope精确ID | 新精确审核；仍保持hold | 不继续推荐repair或批准复制品 |
| scope已commit未采用，看板另有pause | 先board-only resume，再recover | 只有recover采用scope | 不能让resume/repair代采用 |
| scope已撤销 | 检查撤销链；若要后续工作由用户决定结束旧Goal并独立规划 | 不复活旧链 | 不推荐propose_scope_revision或recover |
| 最终验证尚未登记 | user：retry-review核查/登记原有唯一验证 | 不执行验证 | 不暗示已验证 |
| 最终验证已登记，尚无适用新证据 | 明确请求Main执行登记对应的精确验证 | 原权限与实际准入仍需通过 | 不继续把retry-review当主动作 |
| 已有新的适用验证 | user：retry-review | 仅最终审查 | 不重做任务、不扩权 |
| 预算耗尽或未知 | 说明用量与保留的hold | 可只恢复看板，不恢复监督预算 | resume回执不能催recover |
| source/owner/branch不明 | 只读检查来源 | 不自动创建替代owner | 不推荐批准、启动或回放 |

矩阵中的“补齐材料”是说明责任，不授予任何写入或执行权限；若补齐需要新的权限对象，必须停在既有权限门，不能用本轮修复越过它。

## 5. 实施分解、依赖与责任

保持单一Main写者，不因计划分节点而启动并行写者或子代理。以下是依赖图，不是已开始的任务状态。

```text
P0 复现与行为契约
 ├─→ P1 审批动作统一
 ├─→ P2 原问题的元数据交接
 ├─→ P3 范围修复/撤销分流
 ├─→ P4 最终验证阶段与交接
 ├─→ P5 预算回执/文档
 └─→ U0 完成态边界调查
         ↓
P6 组合验收 ← P1/P2/P3/P4/P5/U0结论
         ↓
P7 候选交付与发布门（不自动发布）
```

| 节点 | 依赖类型 | 原因 | 风险 |
| --- | --- | --- | --- |
| P1–P5 依赖 P0 | 契约/证据 | 共用动作语义、已有RED和不变式 | 中 |
| P2/P3 | 写冲突 | commands、scope-revision、preflight、events | 高：靠近授权/暂停 |
| P1/P4/P5 | 写冲突 | flow、commands、preflight上下文 | 中 |
| P6 依赖 U0结论 | 证据 | 完成态准入/采用支持范围必须明确 | 高 |
| P7 依赖 P6 | 证据 | 通过组合、冷恢复、真实入口及完整门禁 | 高 |

推荐顺序：P0 → U0的小样判定 → P1 → P2 → P3 → P4 → P5 → P6 → P7。U0遇到夹具问题时继续独立的P1–P5，但不能把它记作通过；达到P6前必须有明确结论或显式留下不完整验收。

### P0：把已确认问题变成仓库内回归，不以审计脚本代替

**产出：** 可在当前基线稳定RED的测试与上面的行为契约。

- 把外部10项探针移入相应现有测试文件。外部审计日志、哈希与历史报告保留，不改成“曾经通过”。
- 复用 `helpers/preflight.ts`、`helpers/lifecycle.ts`、现有完成态/执行来源夹具。只有至少两个测试真正共享时才提取新的helper；不复制整套测试框架。
- 为K0补上“实际命令→原生暂停→显式用户轮次→before_agent_start→tool_call准入→proposal写入”的测试。
- 加入快照对比：原批准/Start、owner、任务、预算、pending、账本epoch及物理源没有被提示逻辑修改。
- 每个RED必须停在用户症状断言，不得把夹具构造失败记成产品缺陷。

**预期写集：** `src/__tests__/{approval-workflow,flow-commands,scope-revision,final-review,canonical-commands}.test.ts`；必要时复用/小幅提取helpers。

**接受：** 基线8个已知变体仍RED、两个正向对照仍GREEN；新增K0有明确反馈环。单小样先跑，再扩大矩阵。

### P1：修复F1，统一已知审批阻塞的表达

**产出：** 同一审批事实只得到一个动作方向。

1. 将 `matchingDefinitionBlock` 和 `cachedApprovalAction` 中的诊断选择规则收敛到 `approval-bundle.ts` 中可纯调用的审批动作推导。
2. 输入显式携带定义诊断，不再用一个stale布尔值替代 materials/capability/scope/definitions。
3. `flow.ts` 的 `cachedApprovalAction` 仅做当前owner/上下文过滤与事实收集，不再另写一套分类。
4. `preflight.ts / permissionContext / preflightStatusLines`、`human-presentation.ts / preflightSummary`、`board-ui.ts`、`ui-capture.ts`使用相同结果；可删除重复的“Next preflight”行，也可保留一致摘要，但不能保留矛盾动作。
5. 避免让preflight反向运行时导入flow造成循环。纯审批规则留在已有approval-bundle；必要的类型导入为type-only。
6. 真实文件/能力检查仍在Start/review入口，不移入status渲染。

**接受：** changed/missing/capability/workspace四类材料诊断，所有展示面语义一致；材料修复后的实际入口重新捕获，不能因为旧诊断或展示缓存而跳过检查。冷import、setup-only、foreign-owner不会抛出新的模块初始化错误。

### P2：修复K0，让暂停中的元数据交接可操作

**产出：** 不再需要用户猜“先recover还是先提交”，也不虚假承诺自动继续。

1. `flow.ts / heldNextStep` 对无结构化修订事实的hold改为带条件分流，保留已有来源/预算/控制阻塞优先级。
2. `acceptance-runtime.ts / heldScopeOwner` 的错误区分：状态未held、来源不明、pending、未闭合执行、未编译等。仍按真实先后检查，不能仅因状态active就声称其他来源已验证。
3. `createProposeScopeRevisionTool` 保留error/isError语义；已知失败可附带稳定诊断码和受限next/effect/remaining。普通未知异常仍失败关闭，不把所有异常改写为“请pause”。
4. 工具说明/上下文明确要求 `plan + contract + reason`，以及固定权限投影、prohibitions、preparation不得改写。错误可指出不匹配类别/字段，不自动纠正用户材料，不回显不必要的敏感全文。
5. 暂停回执明确：没有新Main轮次被排队。修订路线给出可直接发送的人工请求：

   > 保持当前Goal暂停，只读取当前批准及契约原件，保留全部固定权限、禁止项和准备能力，补齐reason后提交完整propose_scope_revision。不要recover、重跑业务、重新Start、重建看板或重置预算。若来源或静止条件不满足，只报告阻塞。

6. 核对 `events.ts / beforePlanningContext / before_agent_start` **实际发送的内容**，不能只让独立调用的preflightContext文本测试通过。flat与生命周期scoped Goal都应允许原本支持的受限元数据工具；不能把paused范围提案放宽成任意写工具。
7. 保留 `isScopeRevisionProposalTool` 的原始注册/schema身份检查，不能通过同名工具、复制DTO或容器包装绕过。
8. Main材料构造始终引用原始数据；本次10→6禁止项失败应被准确说明，而不是让用户重批同一份旧业务权限。

**接受：** 用户暂停后发送明确元数据请求，实际Main事件链能成功提交，Supervisor仍held且原权限/Start/预算不变；没有消息则没有Main派发；active直接提案仍拒绝且指引明确；busy/unknown/source错误不被提示逻辑自动“处理”。

### P3：修复F2/F5，范围状态有明确分流

**产出：** needs_review能转审核；撤销态不再被引向不可用的提交。

1. 范围只读投影区分至少：待提案、待审核、原记录待修复核查、必须新审核、已commit待recover、已撤销、来源不明。
2. `repairScopeRevision` 的结果包含该次真实结论和明确后续；`commands.scopeRevisionCommand` 显示 `remaining` 和真实参数，不只显示状态词。
3. 对 `ScopeMaterialChanged` 保存有界、display-only的最近诊断：当前Session/文件/owner、proposalRef、controlRef、currentContractRef和修订链锚点。源锚点必须仍属当前分支，不能只用显示文本或proposalId字符串认领。
4. `cachedScopeFlow` 先使用匹配的needs_review诊断，而不是看到旧批准+witness就永久推荐repair。新提案/新control/commit/revoke/owner变更使旧诊断失效。
5. cold restore不持久化“授权状态”来保存提示。缺失展示诊断时可给“核查原记录，只有同版才能repair”的入口；一旦实际核查返回needs_review，同一上下文必须前进。说明这是最后一次观察，不是当前文件版本证明。
6. `preflight.executionAgreement` 对revoked单独表达：本链不得再提交、恢复或回退。后继工作需用户决定结束旧Goal并独立规划；不得自动stop或造新owner。
7. SCOPE_REVISION_FAULT不再落到给Main的通用repair-preflight建议。展示原始故障，同时给正确的范围元数据入口；来源损坏时仍只能检查，不能重问批准掩盖损坏。
8. 全部新分类优先以内存/纯投影实现，不改变scope wire schema/feature fence，也不重写历史日志。

**接受：** 同版原见证修复仍成功；材料改变后连续两次操作不再引向repair循环；missing witness不能被补造；拒绝/取消/撤销/已保存各有准确结果；暖态和冷态均不借旧诊断升级权限；撤销后提案仍被拒，但Main不再建议它。

### P4：修复F3，最终验证从登记阶段正确交接

**产出：** 已登记的验证不再被当成“还需登记”。

1. `registerCompletedValidation` 返回结构化结果，至少区分 registered / already_registered，而不是在幂等分支提前void返回后丢失精确阶段说明。
2. `retryFinalReview / registerNeededValidation` 保留“已有精确登记、待新证据”的事实和说明，重复点击不退回模糊的needs_validation登记提示。
3. 增加仅供展示的最终验证投影，组合现有registration、finalValidation、finalReview和owner事实，区分：待登记、已登记待新验证、已有适用新验证待审查、登记过期/不明。
4. `flow.finalReviewNext` 使用该投影。`facts.finalReview.status`不再独自决定所有needs_validation后续。
5. 现有notice、status、实际Main上下文明确交接：Main未被排队；用户可请求Main仅执行已登记的唯一调用，成功且证据适用后再retry-review。只读展示应写“已记录登记/验证，动作时重核”，不能把上次观察声称为当前文件未变化的证明。
6. 给Main的材料必须从当前owner的原始登记读取精确工具、参数和cwd。不得从脱敏摘要逆向拼命令、从旧聊天猜参数；不能确认完整原始调用时继续blocked。
7. 进入实际验证仍调用 `registeredFinalValidation / validationControlAllowed`，重新核对原生源、owner、cwd、board/bindings digest、epoch、input digest和当前版本。展示缓存不能替代这些条件。
8. 本轮不新增自动执行队列。验证登记不自动运行检查，retry-review不重放任务，也不更改既有预算。

**接受：** 第一次登记后主动作是明确的Main验证交接；重复retry不加新登记/不排队/不耗新Advisor调用；只有原精确调用可进入，其他命令拒绝；当前验证观察后才出现“重试审查”；重启/分支/版本/epoch变化不能把旧登记当作当前通行证。

### P5：修复F4/F6，去掉残留的旧通知与旧说明

**产出：** 用户不会从其他入口重新获得同一条错误指引。

- `resume` 的board-only回执在状态已提交后使用当前共享流程/预算结论。reviews、continuations、未知用量、stopped、超任务上限分别说明，不能总是拼recover。
- 不改变ordinary user_pause联合resume语义；只有原来合法的场景才派发一次继续。
- 删除README中preflight/supervise-legacy的正向操作建议，统一canonical路径；旧语义留在明确历史资料，不批量改历史证据。
- 同步实际命令帮助、工具说明、中文TUI提示与Main上下文。事实说明“旧入口已删除”可以保留，测试不能把任何旧名字出现都当失败。
- 增加语义回归：正向示例可以映射到现有注册入口，删除的命令仍不能写入/派发。

**接受：** reviews=40、continuations=20、unknown额外调用等阻塞下，回执和status均不推荐必失败recover；普通暂停恢复、off正常操作和stopping attention不退化；README不再自相矛盾。

### U0：完成态范围修订先证明，不用失败夹具冒充复现

**目标：** 将未证实疑点变为有证据的结论。

1. 从已有真实CLI/SDK正常批准→Start→绑定合同→合法完成路径构造代表性小样。必须有原生来源完整的检查/回执，不能手工设done或复制新合同绕过资格。
2. 在任务completed但最终接受尚未完成的真实状态，检查propose/review/repair/recover/resume/retry-review的准入组合；记录每一实际入口结果。
3. 对照尚未completed但held的同Goal修订，确认不是破坏夹具导致所有状态都失败。
4. 如果路径被更早的正确门拒绝且给出合理后续，记录“未复现/不受支持”，补防回归，不修改权限规则。
5. 若确实允许commit但无合法采用路径，优先方案是**在原生收集新批准前明确拒绝该不受支持状态**，保留历史并给既有review-only或另行规划说明。不能删除completed恢复门或重开已完成任务。
6. 若需求明确要求completed后同Goal修订，则需另冻结“review-only采用”设计和证据适用性；该新增能力超出本轮提示修复，须单独决策，不能由writer暗自实现。

**接受：** 可重放的有效样本、清楚的支持范围、正负对照。仍停在夹具身份/回执资格错误时继续标记验证缺口，不进入“全部通过”的交付结论。

## 6. 跨模块测试矩阵

### 6.1 每个重要场景至少四层断言

1. **动作语义：** actor、命令/工具/人工消息、effect、remaining一致；不是要求每个入口逐字同文。
2. **真实入口：** 用注册命令/事件/tool.execute执行推荐动作，核对是否被接纳；不要只对helper输出做字符串断言。
3. **持久化与权限：** 原身份、审批/Start、账本和预算不变；只允许本动作应有的元数据增量。
4. **后继状态：** next前进，或出现新的真实阻塞；重复点击不能不断加记录、催审批或派发Main。

### 6.2 必须覆盖的组合

- flat已启动Goal与生命周期scoped Goal；不是只测其中一种。
- active/paused/fault；独立board pause；busy/pending；已编译/准备阶段/完成态。
- 无提案、待审、取消、拒绝、同版部分提交、缺见证、材料变化、commit未采用、撤销、后继撤销。
- 已知预算余量、review耗尽、continuation耗尽、额外调用未知；不把同一budget slot算两次。
- 暖态、session reopen、tree/branch切换、外Session/owner；复制诊断和陈旧引用不生效。
- 默认models-enabled codemode存在时的直接正式检查；unsupported配置仍失败关闭。
- status/TUI/主助手上下文/命令回执：实际入口捕获，不只调用格式函数。
- 异常回执：源不明优先，不能被末尾“下一步批准/Start”盖过。
- 模式off和stopping-with-attention仍保持原语义，不因本轮展示统一重新管理历史工作。

### 6.3 精确的编辑验证顺序

每个节点：先一个代表性RED → 最小实现 → 同节点GREEN → 相邻组合 → typecheck/lint/format检查。不要用全仓长跑来发现普通导入、schema或夹具错误。

复用并扩展当前测试：

- `approval-workflow.test.ts`：F1四类诊断及权限/定义分离；
- `flow-commands.test.ts`：K0条件分流、F4回执；
- `scope-revision.test.ts`：F2/F5、真实proposal入口、部分写/冷恢复；
- `final-review.test.ts`：F3、幂等登记、精确调用/新证据；
- `canonical-commands.test.ts`：F6及不恢复别名；
- `management-controls.test.ts`、`management-materialization.test.ts`、`goal-commands.test.ts`、`goal-command-recovery.test.ts`、`human-ui.test.ts`：相邻边界；
- 现有恢复/账本资源测试：只读渲染没有新增物理扫描、哈希或失控缓存增长。

外部审计探针迁入仓库后不再依赖某个绝对artifact路径或安装包路径。

## 7. P6：最终集成与真实入口验收

### 7.1 代码门

```bash
npm run check
```

沿用现有typecheck、lint、format、四项90%覆盖率阈值与13臂SDK smoke。保留maxWorkers及生产预算；不通过删安全测试、降低阈值、放宽超时或改变统计分母消除RED。

- 新探针全部GREEN，并仍能在原基线RED；
- 原345相关测试全部保留并通过；其中只验证内部拆分的重复断言可在不损失场景覆盖的前提下调整，但不得删掉安全或回归场景来获得GREEN；
- 全仓测试数量按最终真实输出记录，不把历史3335写作本轮结果。

### 7.2 真实CLI/PTY门

先运行一个有界的 `approval-scope`，确认当前源码、宿主配置和输出正确后，才扩到完整相关矩阵。

现有入口可复用：

```bash
python3 test/goal-native-smoke.py approval-scope --default-builtin --out <本轮证据目录>/sdk11-scope
python3 test/goal-native-smoke.py approval-preparation --default-builtin --out <本轮证据目录>/sdk11-preparation
python3 test/goal-native-smoke.py approval-existing --default-builtin --out <本轮证据目录>/sdk11-existing
python3 test/goal-native-smoke.py sequential --out <本轮证据目录>/sdk11-sequential
python3 test/goal-native-smoke.py sdk-denial --out <本轮证据目录>/sdk11-denial
```

用 `--cli <已核实的Pi1.4 CLI路径>` 重跑相同关键路径；不要假定测试运行器自动覆盖两个版本。

在现有faux-provider/PTY夹具中追加以下场景，新增scenario在实现前不能称为已有命令：

- 原问题：active提案拒绝→pause不自动派发→显式人工消息→受限元数据提案→原生review→必要board resume→recover；原Start只一次。
- 缺材料/能力或定义变化后，真实终端输出没有互相冲突的Next。
- repair发现材料变化后，真实回执显示review-scope精确ID；原生重新审核仍需完整阅读。
- 最终验证登记后显示Main交接，不把重复retry当进展；真实精确验证成功后才只重试审查。
- 80×24与100×30布局中关键actor/动作/残余门可读；长ID、窄屏、展开详情不丢字段。

真实CLI、模拟按键、mock SDK三类证据分别标注。不得将其声称为真实人类批准、生产业务验收或hostile-code沙箱认证。

### 7.3 兼容与资源门

- 不新增wire时，旧日志读取/哈希/缺省字段语义保持不变；若实现发现必须新增wire，先停止相关写入设计并补feature-fence/旧reader计划，不能顺手追加。
- 源状态不变时反复status/TUI刷新：无新增append、无Main派发、无workspace捕获、无额外全日志扫描。
- 新展示诊断每当前owner/提案有界；不按每次工具错误堆积缓存。
- 包内源与冻结候选一致；审计fixtures、私人设置、会话日志不进入包。
- 当前两份受保护未跟踪文件不变：`.pi/extensions/pi-provider-service-tier.json`、`docs/supervisor-journal-growth-and-restore-repair-plan.md`。

## 8. P7：交付与发布门

在没有新发布授权时，仅交付候选diff、测试日志、审阅结果和实施说明，不提交/推送/安装。

满足发布授权后再按明确顺序处理：

1. 冻结候选SHA/tree/文件哈希与验收记录；
2. 复核没有未关闭的必需问题；U0未解决时明确阻止“全部完成”的声明；
3. 提交、推送，核对远端不可变提交；
4. 从冻结候选打包，安装只替换单一Supervisor来源，保留旧包回滚；
5. 新隔离进程验证只注册一份规范命令与工具；
6. 不重载正在运行或业务会话。业务恢复/G0仍需单独授权及当前来源检查。

本轮提示修复默认不产生新wire，因此回滚代码不应要求改历史日志；如最终实际改变协议，此默认失效，必须重新评估回滚和reader支持。

## 9. 完成判据

全部满足才可宣布本轮修复完成：

- K0、F1–F6逐项有入口级验证；不只是字符串被替换；
- 新10项探针与K0扩展全部通过，现有安全与正向行为不退化；
- status/Main/回执/TUI同事实给相容动作，执行后有合法后继；
- 元数据操作不再虚假承诺Main自动继续，用户有明确可发送的受限请求；
- repair needs_review与final-validation registered不再形成无信息增量循环；
- 撤销、预算耗尽、来源不明时没有不可达的批准/恢复建议；
- U0有有效证据结论，或明确未完成；不能拿失败夹具当缺陷已修；
- 完整门禁、真实入口矩阵、冷恢复、资源和包检查有当前候选证据；
- 业务会话未被本轮验证隐式操作；发布状态单独记载。

## 10. 材料与状态

### 当前已有证据

本机只读审阅目录：

`/home/ygguo/agent-artifacts/pi-task-supervisor/flow-guidance-audit-20261030-3UbUE9/`

核心材料：`REPORT.md`、`verification-summary.json`、`guidance.test.ts`、`final-guidance.test.ts`、`reproductions-final.log`、`reproductions-repeat.log`、`existing-regressions.log`。

原会话诊断：

`/home/ygguo/agent-artifacts/pi-task-supervisor/session-behavior-review-20261030-x3uqJe/REVIEW.md`

HTML审阅页与SSH预览仍是“已确认未修复”的审阅材料；不随本计划改写为已完成。

### 实施后证据

本轮RED/GREEN、CLI交接扩展、U0有效完成态夹具、完整门禁、候选文件快照及包内容/冷加载检查均已生成，见[验收记录](supervisor-guidance-consistency-validation.md)及其外部交付目录。没有生成部署记录或用户分发档案，因为尚未获得本轮发布授权。旧审阅和上一个release的GREEN不作为本轮接受证据。

**当前状态：P0–P6、U0及P7的未发布候选交付已完成。** U0已由实际SDK复现并在新提案/新原生审核前阻断；同版原见证元数据处理保留。真实CLI另外发现并修复P4登记误用通知叶子作为检查点的问题。候选、完整门禁、实际CLI矩阵与包检查见[验收记录](supervisor-guidance-consistency-validation.md)。未提交、推送、安装、重新分发打包、重载或恢复业务；这些发布/业务门不由本轮完成声明打开。
