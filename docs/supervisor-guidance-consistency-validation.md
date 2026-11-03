# Supervisor 指引一致性修复：实施与验收记录

2026-10-30。对应[修复计划](supervisor-guidance-consistency-repair-plan.md)。

## 结论与权限边界

**本地实现及计划要求的验证已完成；候选未提交、未推送、未安装、未发布。** Main 单一写者。没有操作业务会话、重载、审批、恢复或重跑业务 G0。旧 HTML 审阅页仍描述原受审版本，不是本候选的部署状态。

基线为 `118229f64e02be364836aa394042db169dac6e0e`。候选内容身份、逐文件哈希和包检查详见外部交付目录；未提交候选没有新的 commit SHA，不能把基线 SHA 当成新版本。

## 逐项结果

| 项 | 实施结果 | 当前证据 |
| --- | --- | --- |
| K0 暂停中修订交接 | 通用hold改为条件分流；明确Main未排队；完整plan/contract/reason和固定对象约束；实际Main事件提供元数据上下文，普通写入仍受阻 | scope-revision入口级测试；approval-guidance两版CLI |
| F1 启动前提示矛盾 | 在approval-bundle集中诊断选择，status/Main/TUI共用；来源故障及off历史不再附带批准/Start建议 | approval-workflow材料/能力/定义/来源/off用例；CLI定义变化后状态 |
| F2 repair循环 | 材料变化的最近实际诊断绑定Session/文件/owner/提案/控制/契约引用及goalEpoch；结果显示remaining和精确review入口 | scope-revision暖/冷/异文件测试；真实半写→材料变化→新审核 |
| F3 最终验证登记循环 | 区分已登记、记录新证据、上下文失配；幂等登记保留阶段；明确请求Main读取原登记、执行唯一精确验证 | final-review入口级测试；final-guidance两版CLI |
| F4 预算通知错误 | board-only resume回执使用当前nextFlowStep，不再对耗尽预算推荐recover | reviews/continuations边界回归及完整预算测试 |
| F5 撤销后的错误提案建议 | scope撤销专用分流；Main上下文和pause回执均不再建议复活链 | scope-revision撤销/后继撤销与pause回归 |
| F6 README旧命令 | 去掉已删除入口的正向使用说明，补充显式交接与验证登记说明；没有恢复别名 | canonical-commands文档及真实注册测试 |
| U0 完成态修订边界 | 实际SDK已复现：可以commit、recover却拒绝completed。现于提案及新原生审核前拒绝这种不支持的修订；保留原见证元数据修复/撤销。历史已commit未采用的completed状态不再被提示recover | u0-valid-boundary-red.log及正常SDK回归；同Goal未完成修订正向对照 |
| P4-S1 实测发现的登记来源错误 | 真实CLI发现最新叶子可能是通知，不能当Supervisor检查点。改为读取匹配原owner/状态/epoch/bindings的实际检查点引用；不放宽reader | p4-source-red/green.log；实际Bash登记/验证/最终审查CLI |

没有新增持久化wire schema或特征；原始日志、哈希、物理见证和既有权限/首次Start/预算语义不迁移。新增诊断只用于显示，不参与授权或执行资格。

## 验收事实

### 完整门禁

已执行 `npm run check`，最终日志 `accepted-full-check.log`：

- typecheck、lint、format检查通过；
- **143文件 /3351测试通过**；
- statements **93.30%**，branches **90.02%（14291/15875）**，functions **98.03%**，lines **95.40%**；
- **13臂SDK smoke通过**；
- 四项90%阈值、maxWorkers及生产预算未放宽。

第一次完整检查暴露分支覆盖率89.98%，未作为通过；随后补充真实的来源/owner/cwd/epoch/通知叶子负例。初期类型/格式/测试夹具错误均留有日志，没有冒充业务症状或验收结果。

### 实际CLI矩阵

Pi SDK1.1与本机Pi1.4各执行8臂，合计 **16臂通过**：

`approval-existing`、`approval-preparation`、`approval-scope`、`approval-guidance`、`final-guidance`、`sequential`、`sdk-denial`、`unsupported-before-start`。

- approval-guidance：实际定义变化→定义单独核对→唯一首次Start→active元数据拒绝→明确pause且不新增模型轮次→显式人工消息提交→原生范围回应后注入写入失败→材料变化→repair返回needs_review及新审核入口→新精确原生回应→board-only resume→recover→真实有限Python检查及合成任务完成。
- 范围审核实际80×24未读拒绝、100×30重排后重读；长ID与剩余门均保留。
- final-guidance：使用明确标注的受信host模块测试初始化，不冒充新业务批准或首次Start；实际CLI命令、实际Bash进程、实际日志来源和精确验证准入。登记及重复retry不排队Main；显式人工消息才执行登记验证，之后仅重试最终审查。
- sdk-denial：普通SDK/双TTY不产生原生批准；unsupported配置在首次Start前拒绝。

新CLI臂在既有隔离fixture中实现；test目录不进生产包。假模型/模拟按键证明的是机制与来源处理，不是实际人类身份、业务验收或hostile-code隔离。

## 资源、兼容与交付核对

- 现有恢复、UI只读、账本有界/线性增长测试随完整门禁通过；另以 `P8_COMPONENT_REGISTRATION_COUNT=100` 单独运行原注册资源用例，100次真实模块注册用时 **1143.54ms**，保持原10000ms限额及第101次不得写入的断言。
- 最近scope诊断每runtime至多一个token；Session/文件/owner/引用或goalEpoch改变后失效；冷恢复不继承权限结论。
- 只读投影不捕获当前文件版本；显示“已记录”，动作仍重新核对来源与适用性。
- 受保护的 `.pi/extensions/pi-provider-service-tier.json` 与 `docs/supervisor-journal-growth-and-restore-repair-plan.md` 哈希未变。
- 当前工作树的npm dry-run会拾取无关未跟踪docs文件，因此正式包内容核对使用明确的候选文件快照；不把整个脏工作树直接当可分发包。
- 包检查仅dry-run及隔离源加载，不生成新的用户分发档案，不修改安装来源。发布、重新打包与业务使用仍按计划保留独立授权门。

## 可复核材料

外部交付目录：

`/home/ygguo/agent-artifacts/pi-task-supervisor/guidance-repair-20261030-DCphgn/`

主要文件：

- `baseline.json`：实施前身份及保护文件；
- `p1-red.log`、`p2-p5-red.log`、`p3-red.log`、`p4-red.log`、`u0-valid-boundary-red.log`、`p4-source-red.log`：实际RED记录；
- `accepted-full-check.log`：完整门禁；
- `accepted-{sdk11,host14}-*.log`及对应`owned-*/verified.json`：最终CLI矩阵；
- `handoff.json`、`candidate-files.json`、`package-check.json`：最终候选、要求审计及包内容/加载检查；
- `final-production.diff`：源码复核材料。

上述最终候选与包材料在交付审计时生成，须以其真实内容为准；本记录不把历史release的成功结果当成本轮证据。
