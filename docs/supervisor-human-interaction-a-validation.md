# 人工交互兼容交付 A：实现与验证记录

2026-11-02 · **A 本地候选已接受：P2 修复后定向复审 OK，主控复核通过。整体 Goal 未完成；H0/B 仍阻塞。未安装、未重载、未操作业务会话。**

## 1. 实现范围及基线

用户以当前 Goal「按照计划推进至完成」要求执行已审阅路线图。本轮只在当前仓库实现 A，保留原计划要求的宿主跨仓库、安装、发布和业务操作门。工作树开始时已含 guidance/resource-scope 等未提交实现；没有清理、重置、暂存或提交它们。

- HEAD 仍为 `118229f64e02be364836aa394042db169dac6e0e`；它不是整个候选源码版本。
- A 的 18 个源码/测试文件内容集合本轮记录指纹：`2c11680f2c5f0811df3d498c90bcb130222860f232e978c249b75d81e5c383eb`。文件范围见[实施约束](supervisor-human-interaction-a-implementation-packet.md)，另补 `src/__tests__/index.test.ts` 与 `ui-presentation.test.ts` 的相关断言。
- 新增 `pending-ui.ts`：只读快捷面板和 settled 提示；没有控制调用、授权数据库、timer、模型派发或 H0 冒充。
- 新增 `requestNativeInteraction()`：仅稳定阶段/原因码；原 `requestNativeAnswer()` 返回原注册器产生的同一个 opaque answer。权限、board 回应及 Start 原保存、见证、故障优先级不改。
- `DecisionCard` 的可选稍后观察回调只记录实际选择，不改草稿/答案来源。原因未知的 undefined 仍为 `no_response`，不回填历史意图。
- 旧命令行为保留；`scopedAPI` 新包装快捷回调，跨 await 仍回到原 runtime。
- README 已明确 A 不等于完整自动交互；默认 `Ctrl+Shift+Y`、严格环境变量改键/禁用、终端与 H0 限制均已说明。

## 2. 最小 RED/GREEN 与聚焦验证

1. 基线小样 `npm test -- src/__tests__/human-ui.test.ts -t 'returns undefined when not trusted TUI'`：2 passed。
2. 新增真实 `submit_preflight` 调用链 UI 异常哨兵：先 RED，原结果只有 deferred，缺 `interaction.ui_error`；修复后同一命令 GREEN。异常正文不进入结果、无新增权限控制或 Supervisor。
3. 明确稍后与未知退出分别断言 `user_deferred/response`、`no_response/presentation`，没有批准或 Start。
4. 新快捷注册哨兵先 RED（0 次），加入 A 后 GREEN；实际组件键盘路径、两实例 runtime 隔离、忙碌不 abort、通知去重及零日志/零派发均有断言。
5. opaque answer 原身份可验证；诊断对象和复制答案被原 `requireNativeAnswer` 拒绝。stale/abort/unsupported/busy/display-unavailable 分支保留原门。
6. 聚焦组合曾通过 329 项；最终静态/聚焦组合通过 137 项，注册/待办局部复核通过 11 项。以上均不替代下面完整检查。

## 3. 完整检查

最终命令：`npm run check`，**退出码 0**。

当前候选最终日志：`/tmp/task-supervisor-human-interaction-a-check-20261102-final.log`。P2 修订前的中间完整通过记录保留在 `...-attempt2.log`，不能代替当前候选结果。

- typecheck、lint、format:check：PASS。
- coverage：144 文件、3401 测试全部通过（含本轮 P2 新增的 2 项回归）。
- 全局覆盖率：statements 93.35%、branches 90.07%、functions 98.06%、lines 95.46%；均通过现有 90% 全局门，没有降低门槛或排除新文件。
- `test:smoke` 原有任务/监督/批次/压缩/中断/普通暂停/异步执行/preflight/长收据/迁移组合：PASS。

这些 SDK smoke 中包含 UI/argv/TTY 模拟的 arm，日志也明确 `productionHumanProof: false`；不能当真实终端或真实用户授权证据。原生证据另列。

首次完整检查的结果保留在 `/tmp/task-supervisor-human-interaction-a-check-20261102.log`：3398 项通过、1 项失败，原因是注册数量测试仍期待 12 hooks，新增只读通知后实际 13。更新对应精确断言后先局部复核，再完整重跑；没有忽略失败或改弱控制断言。

## 4. 真实 CLI/PTY 验证（隔离临时夹具）

所有 native 场景均离线、合成模型响应和按键、临时会话；CLI/TTY/原生组件/答案机制未替换。它们不是真实用户身份或业务批准证明。夹具只观察生产快捷 handler 返回，不伪造 UI 结果；全局 settings 前后哈希不变。

| 场景 | 宿主 | 当前候选结果与证据 |
| --- | --- | --- |
| human-interaction | 本仓库 Pi 1.1.0 | PASS：真实快捷键只读视图，前后 journal 字节相同；实际稍后与 Esc 未提交分别有不同诊断；0 额外模型调用，0 人工控制/见证。`/tmp/task-supervisor-human-interaction-a-postreview-20261102/owned-w0cl_zet/verified.json` |
| permissions | 本仓库 Pi 1.1.0 | PASS：真实正常 settled 只读提示可观察；原权限批准与独立 Start 仍分开，未添加自动 Start/恢复。`/tmp/task-supervisor-human-interaction-a-postreview-20261102/owned-tkie__zs/verified.json` |
| human-interaction | 已安装 Pi 1.4.0（只读使用，未修改） | PASS：同一只读/诊断/零派发断言。`/tmp/task-supervisor-human-interaction-a-postreview-20261102-pi14/owned-olajtrc2/verified.json` |
| information | 本仓库 Pi 1.1.0 | PASS：原信息输入、只读往返、最终原生确认和原见证保持。先行小样：`/tmp/task-supervisor-human-interaction-a-native-20261102/owned-2hyr4elj/verified.json` |

每个 verified.json 同目录保存原 session.jsonl、terminal.log 和 probe JSON，可按路径检查，不只有模型口头结论。

### 驱动修正与证据限制

- 最初的保留 stopped 历史夹具没有当前人工待办，不应断言它产生通知；该场景改为只读快捷/退出诊断，通知由真实 permissions 流程验证。没有为了夹具放宽产品控制。
- 原生驱动曾用 UI 结束通知判断快捷完成，改为只读观察真实 handler 返回，避免把无法稳定观察的回调当成结果。
- permissions 夹具自己的 `GOAL_NATIVE_IDLE` toast 与新增通知同 tick 合并，覆盖了真实提示；改用 stdout 合成 marker，不改产品通知或原生 UI，随后真实通知可观察。
- UI 抛错用受控单测边界注入；没有声称它证明了原业务会话为何退出。
- 所有 `[DEBUG-human-a-*]` 临时探针已移除。没有把任何一次未通过小样记作通过。

## 5. H0/B 与未执行项

- 本地 Pi 1.1、已安装 Pi 1.4 都未提供路线图要求的公开 H0 交付契约；新入口始终只读。A 自测通过不解除此门。
- 原目标会话的 loaded revision/历史退出原因仍未知；本轮未对它做批准、Start、恢复或重载。
- 首轮独立 A 实现审阅 OK with notes，P2 已由主控修复；修复后[定向复审](supervisor-human-interaction-a-review-followup.md)为 A OK，无新增 P0/P1/P2。主控随后独立重跑相关 18 项并核对源码指纹与完整检查候选一致，现接受 A 本地候选，不接受未实现的 B。
- 用户随后已允许隔离宿主源码/本地修改/构建/验证，且官方 v1.4.0 副本/离线构建基线已核实；独立 H0 packet 设计复审、H0 竞争/取消/交付资格及 B 全链路仍未完成。
- 不提交/推送，不安装/发布，不修改已安装宿主或全局设置，不重载业务会话。

下一责任：A 本地接受已完成；Main 在已获准隔离源码位置先完成 H0 设计复审，随后实现并验证宿主，而不是直接改已安装包。详见[H0 来源与前置调查](supervisor-human-interaction-host-discovery.md)。

## 6. 首轮实现审阅与 P2 处置

原始报告见[A 首轮审阅](supervisor-human-interaction-a-review.md)。其 P2 为通知 fingerprint 缺少分支代际/实际请求身份，可能把同 generation、相同摘要的兄弟分支请求误认为已提示。

- 主控先加真实 handler 路径回归并跑 RED：第二个请求应提示 2 次，实际仍 1 次。
- `pending-ui.ts / requestIdentity()` 现把原恢复流程已有的 `runtime.goalEpoch`、实际 board decision ID、preflight 权限/Start 请求 ID、planDigest/具体定义提案和缓存 scope 提案引用纳入只读 fingerprint；没有加入每轮变化的 leaf，没有新持久表或控制权。恢复流程本来就递增 goalEpoch，因此切树/恢复会自然失效上一代缓存。
- 回归覆盖：同请求重复 settled 只一次；同 generation 新决策重新提示；普通后继 leaf 不重复提示；恢复代际改变后重新提示；同版 preflight 的新请求或新材料摘要重新提示；全程零日志写入/派发。
- 修复后相关 pending/restore/runtime 18 项通过；随后完整检查 3401 项通过，并再次跑过表中三个当前原生样本。临时故障和旧候选证据均保留，不覆写为通过。
- 修复后只读定向复审为 A OK；主控再跑 pending/restore/runtime 18 项通过，当前源码集合 hash 与完整检查/原生样本候选一致。H0/B 依然不是本轮已实现内容。

## 7. A 逐项接受审计

| 要求 | 权威证据 | 当前结论 |
| --- | --- | --- |
| 退出原因可区分、未知不猜、错误正文不泄露 | submit_preflight RED/GREEN、human-ui及notice回归、原生稍后/未知退出 | A PASS；原业务会话历史原因仍未知 |
| 诊断不授权，原NativeAnswer/见证/保存和故障优先级保留 | 原身份/负例测试，完整smoke，独立实现审阅与定向复审 | A PASS |
| scoped只读快捷与所有键盘路径不写控制/不派发 | 两实例实际组件测试，Pi1.1/1.4原生journal字节/控制/模型调用断言 | A PASS |
| settled只提示、无自动弹窗/Start/恢复/私有队列 | 新模块源码、通知去重/副作用断言、permissions原生观察 | A PASS |
| branch/请求/材料/epoch去重且普通leaf不重复催问 | P2先RED后GREEN，实际restore源码接线，定向复审OK | A PASS |
| 当前候选完整门与证据分层 | final.log：3401项/覆盖率/13smoke；独立原生工件；源码集合指纹一致 | A PASS |
| 完整自动交互与当前业务会话生效 | H0公开能力/隔离宿主范围/设计/资格/B尚未完成，未安装或重载 | **未完成，不属于A通过** |

因此只接受当前 A 本地候选；不调用完整 Goal 完成标记，不把路线图、A 或审阅结论当作 H0 能力/范围授权。
