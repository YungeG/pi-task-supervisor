# 资源约束与范围提案准入修复方案

2026-10-30 · 方案 v1.1 · **方案审阅时未实施；不授权修改业务额度或发布部署。** v1已完成独立只读subagent审阅，结论OK with notes；本版由Main核实并补齐唯一P2 NOTE，修订范围及审阅证据见文末。

## 1. 目标与基线

本轮解决资源／范围审阅中的R1–R4：

- R1：笼统的“预算不可扩充”与实际可审核字段不一致；
- R2：编译后普通契约提案被受理，但review-contract无法处理；
- R3：提交成功后才发现冻结记录装不下，指引仍让人重复审核；
- R4：相同未决范围提案反复占用8份名额。

目标不是增加一个预算系统，而是让**能力说明、提交准入、原生审核、下一步指引一致**。

当前已安装候选：`b1bcdb0b5710492b5597f067bd767321469ec769fe929c44faaf8d3e8d155947`；Git HEAD仍为`118229f64e02be364836aa394042db169dac6e0e`，上一轮已验收修改尚未提交。本轮后续实施必须在这些修改上增量进行，不reset、不覆盖既有成果。

证据目录：

`/home/ygguo/agent-artifacts/pi-task-supervisor/resource-scope-audit-20261030-WHW9WZ/`

其中7项探针为4 RED /3 GREEN，重复一致；相关5文件/163项既有回归通过。真实Pi1.4 CLI已经证实部分资源限制文字与检查timeout可经范围审核修改；这不是对业务会话的新批准。

## 2. 先冻结的产品决策

### 2.1 不新增入口

继续使用：

```text
用户明确需要改范围
→ 保持同Goal held
→ Main提交 propose_scope_revision
→ 用户原生 review-scope
→ 必要时解除独立看板pause
→ 显式 recover 采用修订
→ 按新精确条件和剩余门执行
```

不新增budget命令、预算配置页或自动审批；不再建议用户寻找不存在的入口。pause、提案、审核、修复均不隐式批准业务或刷新计数。

### 2.2 四种“限制”必须分开表达

| 类别 | 现状与本轮规则 |
| --- | --- |
| Supervisor硬限制和已用计数 | 40审查、20继续等现有硬门不由scope/recover修改；已知/未知用量不重置 |
| 业务资源条件文字 | 在既有固定权限对象、原工作区和原能力内，可以提出对limits及对应计划/验收条件的精确修改；须原生审核，不保证所有请求都适用 |
| 正式检查profile技术限制 | 可修改受支持的定义字段，但不能超profile上限；当前Node单次检查最多30000ms，Python unittest最多120000ms，业务总时限600秒不等于单次检查允许600秒 |
| 历史计量和过去是否达标 | 是证据，不是可改额度；缺失保持未知，旧失败保留，新批准不能使过去“通过” |

不增加自然语言数值解析器，不从字符串中的“600”推导执行权限，不声称limits文字是OS硬配额。

### 2.3 固定对象不变

保留现有固定比较：

- 权限的id/action/target/environment/required；
- prohibitions与preparation；
- Goal/owner/Session/branch、workspace、首次Start和任务身份；
- 合同scopeId、inputs、artifacts、environment；
- requirementId/required；check kind/checkId/runtime/checkerRoot/permissionId。

限制文字、要求正文及受支持检查定义的修改不是免审许可。若请求需要改变上述固定对象，必须明确报告本接口不支持，不偷偷改写或用其他工具绕过。

### 2.4 历史缺口与后续片段不能混淆

若业务需要讨论“后续执行片段的新额度”，完整提案应交代：

1. 新条件从哪个未来检查点开始适用、到何处结束；
2. 旧计量继续未知，原累计条件过去未获满足的事实不改；
3. 哪些后续准入条件拟被修改，哪些原约束继续有效；
4. 新计量口径、记录来源、停止条件及超限处理；
5. 所有相关limits、steps、acceptance、reconfirm和合同要求是否一致。

这只是应审核的材料要求，**不是预先决定接受历史未知，也不是本轮插件修改对该业务方案的批准**。不可变禁止项若仍与请求冲突，就必须停下。本轮不新增资源遥测系统，也不伪造旧资源证据。

## 3. R1：按真实支持范围修正文案与审核材料

### 修改位置

- `src/acceptance-tool.ts / createProposeScopeRevisionTool`；
- `src/scope-guidance.ts`；
- `src/human-presentation.ts / readableScopeRevision`；
- `src/scope-revision-proposal.ts / assertScopePlanObjects`的错误说明；
- README与必要的Main上下文说明。

### 指定行为

1. 删除“所有budgets不能扩充”的笼统说法，明确其不可重置部分是Supervisor硬限制及已用计数。
2. 明确业务条件可提出精确修订，但须检查固定对象、原权限、完整材料和profile能力。
3. 固定对象错误指出具体类别，例如权限身份字段、prohibitions或preparation，而不是把整个权限对象描述为全部不可变。
4. 原生材料继续展示完整旧／新计划和定义；增加简明说明区分“未来条件变更”和“历史证据不变”，不省略原文，不生成自动批准结论。
5. 保持当前schema和所有准入强度，不因为文案承认已有能力而额外扩展可变字段。

### 验收

- 同一已批准权限对象内的limits修订、支持范围内的timeout变更，经原生审核及recover后确实采用。
- 提案阶段未授权；review后仍held；原批准/首次Start只一次，Supervisor计数不变。
- target、runtime、root、prohibitions等固定对象变化仍拒绝且不写候选。
- Node/Python profile边界分别验证；总资源条件不被当成profile上限变更。
- 所有用户/Main提示不再虚构独立预算入口。

## 4. R2：普通契约提案在错误阶段提前拒绝

### 修改位置

- `src/acceptance-runtime.ts / proposeAcceptanceContract / preCompileOwner / beginRegisteredCheck`；
- `src/acceptance-tool.ts / createProposeContractTool`。

### 指定行为

在验证当前owner/来源后、创建普通契约记录前检查阶段：

- 未启动规划：保留现有propose_contract/预检流程。
- 已Start但未编译：保留现有准备、具体定义审核流程。
- 已编译且任务未completed：普通propose_contract返回错误、不落盘，明确改走held范围修订。
- completed：保持上一轮修复的闭合语义，不把用户引向不支持的新范围；检查既有review-only路径或另行决定结束并独立规划。
- 来源、owner或未知执行有问题：先报告真实问题，不给通用的“pause就能解决”建议。

`proposeScopeRevision`内部使用的契约保存路径继续可用，但必须已经完成范围身份/固定对象/静止条件检查。不得向模型新增可绕过普通入口门的scopeMetadata参数。

检查定义变化的错误也按当前阶段给出方向：不要只说“native review required”，让Main自行猜review-contract还是review-scope。

### 验收

- 已编译普通提案在成功返回前拒绝：日志字节、候选数、UI调用、Main派发均不变。
- pause→propose_scope_revision→review-scope仍可处理同一合法定义修改。
- 初次规划、获准准备后定义审核和普通契约去重不退化。
- 公共工具不能通过同名字段、复制DTO或容器包装选中内部scope路径。

## 5. R4：仅复用最新的完全相同未决提案

R4先于R3落地，以便把去重、容量预检和追加串成一条路径；不能先检查“8份已满”就拒绝对现有提案的无写入查询式重试。

### 修改位置

- `src/scope-revision.ts / scopeProposalContext / proposeScopeRevision`；
- 必要的原始契约解析继续复用`scope-revision-proposal.ts`。

### 精确等价规则

只检查**当前owner最新提案**，不搜索并复用已被更新提案超越的旧记录。以下必须同时相同：

- Session与实际文件/分支来源仍有效；
- 原owner、原Goal源、原预检、原批准及首次Start引用；
- previousRevisionRef、previousContractRef；
- 完整plan和contract的验证后字段值、完整reason；
- 该提案没有原生回应、scope commit或撤销关系。

plan中的`contractProposalId`是宿主按所提交contract绑定的派生引用：输入里旧的该字段不能成为新的权限来源。比较时只排除这个被宿主替换的派生字段，并核对保存提案实际引用的原始contract全文。

不对用户字符串增加trim、模糊匹配或语义近似；不忽略有意义的数组顺序。不要仅比较summary或reason。

### 返回与计数

- 相同最新未决提案：通过当前来源和可审核性核查后，返回原proposalId/ref，保持`status: proposed`；可补`reused: true`，零append、零新名额、零UI、零派发。
- 不同完整材料：按现有规则创建新提案，占一个名额。
- 已有回应、半写或不明见证：不作为“未决重复”复用，不刷新批准；转现有review/repair/来源诊断。
- 已commit或revoked：保持现有有效范围/撤销规则，不借重复提交恢复旧权限。
- 第8个真实不同提案仍是上限，第9个拒绝。已有历史重复记录不删除、不折叠、不自动回收名额。

复用逻辑不是崩溃自动重放。持久化结果不明时仍先检查原始日志，不能因为输入相同就再次写入。

### 验收

- 连续8次相同未决输入只有一个proposalId、一份scope记录；第9次真正不同材料仍有名额。
- 8份真正不同材料仍耗尽名额；上限不变。
- 同reason但plan/contract不同、同plan但reason不同、已拒绝/已批准/已commit、不同owner/分支/前置契约不错误复用。
- A→B→再次提交A不能返回被B超越的旧A；仍按当前最新上下文处理。
- 全部历史记录和原哈希保持。

## 6. R3：在持久化提案前验证其可审核性

### 修改位置

- `src/scope-revision.ts / proposeScopeRevision / preparedReview / requireScopeReviewCapacity`；
- `src/acceptance-runtime.ts / prepareScopeRevisionContract / prepareContractBinding / assertPayload`；
- `src/human-presentation.ts / readableScopeRevision`继续作为完整材料构造来源；
- `src/scope-revision-journal.ts / cachedScopeFlow / pendingScopeFlow`：历史不可审核候选的展示分流；
- `src/flow.ts / scopeNext`、`src/preflight.ts / executionAgreement / heldPreflightNext`及命令回执：消费同一诊断，不能保留只推荐失败审核ID的旧提示。

### 指定设计

将“范围定义准备与容量检查”复用到提交和审核两端，但保留不同的宿主静止要求：

- 提交路径允许Main在其当前元数据轮次中运行；仍必须是held owner、无未闭合writer/捕获/原生控制。
- 原生审核仍要求实际idle。
- 不得直接在提案中调用现有默认review模式，导致合法Main提交被`isIdle`拒绝；内部准备函数显式接收proposal/review模式，复用原有heldScopeOwner规则。

新增内部准入步骤的结果仅为“当前材料可构造/容量可容纳”或明确错误，不能作为NativeAnswer、批准、commit或之后可免检的令牌。

### 必须提前核对的容量

- 计划的现有16000 UTF-8字节规则；
- contract和scope proposal的现有64000字节/schema规则；
- **实际scope授权形态**下每条冻结定义及bound记录的16KiB规则；
- 完整原方案、新方案、原冻结定义和新定义组合后的审核正文64000字节；
- 当前owner的原生回应和冻结定义数量上限；提案/内部contract的新增数量检查只计入实际新增量，重复复用不因历史已达8份而误判新增；
- 内部契约提案是否复用及其独立容量上限。

不能只检查原始contract JSON大小。scope实际提交使用的authority引用、较长确定性recordId、definition refs都计入；不能用更短的recognized-host临时形态宣称最终记录一定装得下。

### 尚未产生的引用如何计量

复用最终序列化/显示构造规则，以schema允许的引用ID最大长度和固定digest长度做**明确的保守容量上界**。已经存在的来源使用真实引用。

- 预览占位引用仅用于字节估算，不能进入journal、NativeAnswer、读回见证或真正的commit。
- 预检错误明确说明是容量上界/材料错误，不伪称已完成原生源验证。
- 临界大小可以保守拒绝，不能低估后成功返回再必然失败。
- 测试覆盖UTF-8中文、长ID、scope-specific authority及确定性recordId与UUID长度不同的边界。

### 写入顺序

```text
不可信输入schema校验
→ 实际owner/来源/held/静止条件
→ 基于已核实原件校验固定对象与检查能力
→ 找最新未决重复候选（暂不返回）
→ 对当前材料做定义、记录、审核正文及数量预检
→ 若复用：返回原ID，不写入
→ 若新增：确认数量仍可用，保存contract提案
→ 保存scope提案并做原始读回
→ 返回proposed及精确review入口
```

所有可预先发现的无效材料必须在contract提案、scope提案和新增feature fence写入之前拒绝。真实读源/权限检查始终先于外部checker文件读取。

审核端仍重新捕获实际文件、权限和版本，再检查容量；预检通过不证明审核时条件未变。追加过程中发生异常时按既有partial-write/unknown规则保持hold，不删除历史、不伪造回滚、不自动重放。

### 错误与历史不可审核候选

- 新请求超容量：返回error，指出超出的是冻结记录还是完整审核材料；责任人为Main；没有写入或名额消耗。
- 文件/能力不明：返回“材料尚不可审核”，不宣称proposed就绪，也不运行程序尝试补齐。
- 历史已保存的超容量候选：保留记录，明确让Main提出较小但完整的替代材料；不能继续只推荐同一个必失败review。实际审核或显式核查确认不可审核后，用绑定当前Session/owner/提案及前置契约引用的有界display-only诊断驱动`cachedScopeFlow/pendingScopeFlow`，状态、Main上下文和回执必须一致。
- 冷加载不把丢失的内存诊断当作通过，也不为了status主动读取checker或重建完整审核材料。未核查时可以明确提示“先核查现有候选可审核性”；一旦当前源下已确认容量失败，下一步必须转Main修正。诊断不能参与授权、改写历史、刷新旧批准或放宽容量。
- 允许删冗余表达，不允许静默丢弃条件、缩减验证要求或加大上限。

### 验收

- 本次14,899字节contract用例在提交前失败，journal字节、候选数、feature fence、UI和派发均不变。
- 边界内完整材料可提交及审核；边界外明确拒绝。
- 审核前文件变化仍触发现有新审核/阻塞路径，不借预检缓存继续。
- 容量错误反复尝试不消耗名额；历史不可审核记录仍可查，合格替代提案在剩余名额内可用。
- 增加旧版本已保存超容量提案的日志fixture：暖态和冷加载后分别经实际审核/核查确认不可审核，断言status的Next、Main上下文和命令回执都指向Main修正完整材料，不再单独推荐原失败ID；随后较小完整提案可正常提交和审核。
- 同一fixture验证只读status不产生新append/派发/文件捕获；诊断跨owner、分支或提案失配后不复用，不伪造新批准。

## 7. 统一失败优先级与不变式

1. 不可信schema/错误身份、原来源或分支不明：失败关闭。
2. 当前控制状态、撤销、completed、未知捕获/writer：遵守各入口原门，不用去重或预检绕过。
3. 固定对象/检查能力不支持：指出不支持的类别。
4. 有效最新未决重复与当前材料预检：只识别，不授予权利。
5. 新材料的容量/可审核性不足：零新增记录，给Main明确修正方向。
6. 真正追加及原始读回；异常保留unknown/partial-write。
7. 原生审核、commit、显式采用、实际新证据仍是后续独立阶段。

不改变Supervisor硬预算，不清历史重复候选，不提升旧证据，不把预览材料变成原生见证，不改变现有wire/readers/哈希算法。若实现证明必须新增持久协议，先修订方案和兼容验证，不自行塞字段。

## 8. 实施顺序与写集

单一Main写者，默认串行，无新代理或并行写树：

1. **S0 复现冻结**：把外部7项用例迁入相应现有测试，先确认同样的4 RED/3 GREEN；保留当前已部署候选和未提交diff。
2. **S1 R1语义**：工具说明、错误、审核正文、README；明确字段支持矩阵，不改业务数据。
3. **S2 R2阶段**：普通契约入口提前分流，零写入拒绝。
4. **S3 R4去重**：最新未决等价匹配、名额计数、状态返回。
5. **S4 R3准入**：共享定义/容量准备、写入前预检；同时修改历史不可审核候选的scope展示投影及其消费者，用暖态/冷加载旧日志fixture验证下一动作确实转Main修正。
6. **S5 组合验收**：四项连用、暖态/冷态、来源变化、真实CLI及完整门禁。
7. **S6 候选交付**：冻结新候选、差异、证据和未执行的发布边界。

主要写集为上述src文件及README；测试优先放入`scope-revision.test.ts`、`acceptance-admission.test.ts`、`acceptance-proposal-profile.test.ts`、`approval-workflow.test.ts`、`canonical-commands.test.ts`。真实CLI扩展复用`test/approval-native-responses.ts`和`test/goal-native-smoke.py`，不进入生产包。

## 9. 验证要求

### 编辑循环

每一纵向修改先最小RED，再最小实现，再相邻GREEN。先用一个代表性用例验证新调用方式和fixture，再扩展矩阵，不用全仓长跑发现导入或schema错误。

### 必需场景

- 未Start规划、已Start未编译、编译后active/held、completed、revoked；
- 无回应/取消后仍未决、reject、approve部分写、完整commit；
- 相同重复、真正不同、跨owner/Session/branch、旧提案被新提案超越；
- 8份名额边界、8份历史重复不能自动回收、contract复用计数；
- 16KiB/64000字节和UTF-8/长引用边界；
- 提交预检后文件/版本/前置契约变化；
- 暖态、重载、失去回应的原始日志检查；
- 没有新增批准/首次Start、没清计数、无业务派发，读源错误不产生候选。

### 最终门

- `npm run check`完整通过，四项90%阈值、资源门和13臂SDK smoke不降低。
- 原7项审计探针按修复语义全部GREEN，保留所有安全/正向对照；不要通过删除触发条件获取GREEN。
- Pi1.1和Pi1.4真实CLI：范围修订资源条件、明确原生审核、显式recover、实际有限检查；加入重复提案、容量拒绝、编译后错误入口分流。
- 原有guidance、final-guidance、preparation、sequential、SDK denial和unsupported路径不退化。
- 原生源、原始日志/哈希、审核完整阅读、无隐式Main派发和设置不变有独立断言。
- 对声明“资源额度变化”的用例逐字段核对实际提交与采用的值，不能只看到generic PASS。

## 10. 交付与当前业务的关系

实施交付应包含R1–R4逐项证据、新候选内容哈希、差异复核、包内容/冷加载检查。不会沿用旧部署成功记录来代表新代码。

本轮方案及未来插件修复**都不替业务会话批准600秒/256MiB等额度，不批准历史缺口例外**。需要另在原会话核对完整有效计划、固定禁止项、旧累计义务及拟议未来片段，再走其真实原生流程；当前不要因读到本方案重复recover。

提交、推送、安装、分发包、业务重载/恢复/G0、npm发布均保留独立授权门。上轮“部署到本机”的授权已经执行，不自动延续到本轮新候选。

## 11. 独立计划审阅记录

- reviewer run：`a73a89de-a037-40a0-91bd-b986bcf3f095`；fresh上下文、只读，未修改文件或执行测试。
- 被审v1 SHA256：`8a7cec72ea5601edcdaf27d4641a79a35746309d1b0076430c370d87499b415a`。
- 结论：**OK with notes**；0项阻断问题，1项P2 NOTE。R1、R2、R4覆盖充分，R3核心设计充分，但缺历史不可审核候选的Next修改落点与直接验收。
- Main已对照`cachedScopeFlow/pendingScopeFlow`、`scopeNext`和`executionAgreement`核实该NOTE有效，本版仅补齐第6节写集/状态语义/旧日志验收及S4交付说明。
- 原报告和v1快照：`/home/ygguo/agent-artifacts/pi-task-supervisor/resource-scope-plan-review-20261030-oo8revxe/`，文件`reviewer-report.md`与`plan-reviewed-v1.md`。
- 326个受审及保护文件在child审阅前后哈希一致；文档修订由Main随后进行。child没有独立重算哈希或重跑测试，身份核对由Main完成。
- v1.1是Main吸收该NOTE后的文档修订，未再次提交独立复审；不把v1的结论扩大成v1.1实现或发布验收。

**实施跟进：用户随后以“按照计划推进至完成”授权Main实施及隔离验证，S0–S6本地实现/验收及候选交付已完成。见[实施与验收记录](supervisor-resource-scope-admission-validation.md)及其中外部交付身份；原计划审阅不扩大为代码独立审阅。未提交、推送、部署或操作业务会话；这些授权门继续保留，用户目前无需操作业务会话。**
