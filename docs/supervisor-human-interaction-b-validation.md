# B 本地候选：原控制、H0 唯一交接与隔离原生验证

2026-11-03 · **R3 最终独立实现 OK，全部 P1 CLOSED；Main 重核同指纹、17 项关键回归及完整路线图后，接受 B 与本轮完整本地候选交付。** 3493 项完整检查与 11 项原生矩阵 PASS。未安装/部署、未重载或操作原业务会话。

Main 已按[独立设计 READY](supervisor-human-interaction-b-design-review.md)接受的[实施约束](supervisor-human-interaction-b-implementation-packet.md)单写实现。无需用户补充本地授权。未安装/发布/提交、未改主仓库依赖或全局设置、未重载或操作原业务会话。

**当前候选为 §8 的 R3。§1–§5 保留 R1、§7 保留 R2 历史证据，不把其通过测试误作已接受。**

## 1. R1 历史候选身份与保护边界

- 主仓库：`/home/ygguo/agent-projs/agent-ext/pi-task-supervisor`，HEAD `118229f64e02be364836aa394042db169dac6e0e` **不是完整候选**；既有 guidance/resource-scope/final-review/A 未提交改动均保留。
- 本次冻结全代码/测试/配置 manifest：`/tmp/task-supervisor-human-interaction-b-candidate-20261102.json`。
- 87 个非测试生产文件指纹：`6941d2399c445871aa991a8ae1bf3aeae6562765605db4ebb1b82493966d760d`。
- 含全部 src 测试、三个原生夹具和配置的候选指纹：`3c9e91f623284060678ce4b63b22e4c52ecdce129a99dcfc96684db7122b4d3a`。
- 审计：`python /tmp/audit-task-supervisor-b-candidate.py`；核对生产源码与实际原生 pair 完全一致、10 份原生报告及 session/transcript 哈希、主 peer 仍为 1.1.0、受保护安装/设置哈希不变。docs 不参与代码指纹。
- 配对副本：`/tmp/task-supervisor-b-pair-final-20261102`。复制候选 src/test/docs/package.json，只有临时副本的 coding-agent/ai/tui resolution 指向已接受隔离 H0；没有替换主仓库 node_modules 或全局安装。
- 实际 CLI：`/home/ygguo/agent-projs/pi-human-interaction-host/packages/coding-agent/dist/cli.js`；扩展实际 coding-agent resolution 为同包 `dist/index.js`，公开 `idleActions.version=1`。不是只改变 `--cli` 或可信根白名单。
- H0 仍是[已接受 R2](supervisor-human-interaction-h0-validation.md)的冻结依赖：13 文件指纹 `066b21cda79bd3ea2a12840243c428bfb525c1c21fc8f3442d5d281f400434a1`，九源指纹 `db154401d52c563420fc1fd09dc9ac1f5878f0619653432c6346521b7e96913c`；`python /tmp/pi-h0-audit-candidate-r2.py` 复核 PASS，没有为 B 修改或重新认证 H0。
- 全局设置 SHA-256 仍为 `930ba1016301cb0e3bc442cded6903a0f7043f5765343d2fdf13e6d7603832c0`；已安装 1.4.0 的 `dist/core/agent-session.js` 仍为 `436e8be3bbab2db475ce30bb5d0bb30f0046b19a3476f8cd57b8133e68891162`。

## 2. 自动检查

完整 `npm run check` **PASS**，日志 `/tmp/task-supervisor-human-interaction-b-check-final-20261102.log`：

| 检查 | 结果 |
| --- | --- |
| TypeScript、ESLint、Prettier | PASS，无放宽规则 |
| Vitest | **147 文件 / 3476 测试 PASS** |
| Statements | 93.36%（15127/16202） |
| Branches | **90.01%（14837/16482）** |
| Functions | 97.90%（2997/3061） |
| Lines | 95.49%（13559/14199） |
| 原 `test:smoke` 全链 | PASS，含 ordinary-pause/native-abort/async execution/preflight/receipt migration |
| `git diff --check` | PASS |

保留原四项 90% 全局门，未删测试/排除新源码。原 SDK smoke 明示 argv/TTY/UI stub，不冒称原生可信性。43 项 idle-human、其余 bridge/shared-control 测试及 runtime 延后 callback 测试覆盖原资格、后置材料变化、状态/用量保持、saved Start 的取消/unknown/拒绝/准备失败、投影 abort、历史静默及回调 runtime 隔离。

两个实际 RED→GREEN 收束：

1. 无 `approvalFlow` 的保留 v2 记录，“仅定义”错误进入权限发布。B 直接调用导出的原定义审核核心；原 grant 不改，不 Start/dispatch。
2. 部分批准后仅传已批 IDs，遗漏同一原计划其余 required 项。原生范围改为显式已批+原 required+preparation IDs，不加入缺失 optional；完整原确认后仍单独问 Start。测试先观察只保留 A1 的失败，再验证 A1+A2、排除 A3、无 Start。

## 3. 真实 CLI/TTY 矩阵（10 份最终报告）

全部使用拥有的临时 session、真实 Node CLI/PTY/native UI/物理 control+witness。没有 argv、TTY、UI 或 admission substitution。模型与按键是合成离线夹具，**不是人类身份、业务批准或业务研究验收证明**。

下表路径均为 `/tmp/` 下的真实验证产物；报告完整路径与哈希另收于 manifest。每份有 `verified.json`、实际 `session.jsonl`、`terminal.log` 和只读 probe。

| 样本 | 验证与最终报告 |
| --- | --- |
| 原具体定义→权限→独立 Start→完成 | `task-supervisor-b-native-approval-existing-final-20261102/owned-x4oxkdab/verified.json`；单次权限、单次单独 Start，无审批命令 |
| preparation→自动具体定义→独立 recover→完成 | `task-supervisor-b-native-approval-preparation-final-20261102/owned-emxhvq9s/verified.json`；定义审核不恢复/派发，原 grant/Start/暂停保持 |
| scope→自动审核→仅恢复看板→独立 recover/adopt→完成 | `task-supervisor-b-native-approval-scope-final-20261102/owned-42bvtpxt/verified.json`；审核不采用 scope，board-only 保留原独立 Supervisor hold 及用量 |
| 有限业务 choice | `task-supervisor-b-native-choice-final-20261102/owned-988khsxf/verified.json`；快捷入口、原完整材料、原生最终确认、原物理见证，仅选择原方案；零模型调用 |
| integer information | `task-supervisor-b-native-information-final-20261102/owned-7b6jf793/verified.json`；同屏 42、返回保留草稿、宽屏完整原文、原生最终确认；零模型调用 |
| 保存 Start 后竞争普通输入 | `task-supervisor-b-native-saved-cancel-final-20261102/owned-h3axz9ie/verified.json`；真实 EventBus 普通输入取消 H0 lease，已批/Start 各一次，无业务工具调用/文件，无自动补派 |
| 已 ACK、pre-kernel 准备异常 | `task-supervisor-b-native-prepare-failure-final-20261102/owned-zaf9__cp/verified.json`；真实 `idleActionFailure.started` 同 Session，模型仍仅 3 次规划调用，Start 保留/技术 hold，不重放 |
| defer-tool setter 异常 | `task-supervisor-b-native-projection-failure-final-20261102/owned-jl30fd2_/verified.json`；调用真实 `ctx.abort`，无新增 provider 调用/业务工具；技术故障而非用户拒绝 |
| 冷恢复历史未绑定定义→无关只读轮次 | `task-supervisor-b-native-cold-final-20261102/verified.json`；真实恢复后 pendingAction 仍 preparing、有原 grant/Start，无 journal fault；只读轮次后 H0 idle/pending=0、nativeUiPrompts=0，原控制不变 |
| 旧 1.1.0 A-only | `task-supervisor-b-native-old-host-final-20261102/owned-mp9ahy9_/verified.json`；同快捷键只读，journal 不改，无 control/witness，无新增模型调用 |

投影失败不是 pre-kernel throw 的同义词：本样本已经 logical-start，custom continuation 可已持久化、kernel 可发出 `agent_start`，继而 `agent_settled.aborted=true`；**provider 调用数没有增加**。不能把 ACK 降成“未派发”再重试。B 在 kernel start 时保留 prepareFailure 关联，先于来源早退收束技术 hold；原 grant/Start/已用计数不回滚。

冷恢复使用先前拥有的 preparation session 的**字节相同副本、同一 workspace**，不是原业务会话。只读 signal observer 在真实事件循环 checkpoint 读取 H0/原缓存 facts，不通过诊断输入取消问题后再声称没有问题。原 session 文件及全部原 controls 前缀保持。脚本 `/tmp/task-supervisor-b-cold-native.py`；首次试验就绪 toast 不可见等夹具错误见 §5，不算通过。

重跑示例（新 out 路径，避免覆盖证据）：

```sh
python test/goal-native-smoke.py approval-preparation --human-controls \
  --source /tmp/task-supervisor-b-pair-final-20261102 \
  --cli /home/ygguo/agent-projs/pi-human-interaction-host/packages/coding-agent/dist/cli.js \
  --out /tmp/task-supervisor-b-native-new-owned-run
```

同脚本支持 `approval-existing` / `approval-scope` / `information`；额外 `--human-choice --decision-layouts`、`--human-cancel-after-start`、`--human-prepare-failure`、`--human-projection-failure` 为各有界场景。先单样，再组合，未用全量发现普通配置错误。

## 4. 要求审计与组合证据

| 要求 | 本轮证据 |
| --- | --- |
| B1/B3：原权限、Start、board 与物理回读不替换 | shared-control/approval/board/human-ui 回归；两项 RED→GREEN；原生权限/Start、choice/information witness |
| B2：完整 barrier、竞争/取消、最终资格、唯一 ACK | 已接受 H0 的真实 late-settled/deferred/async-validator 组合及固定指纹；B 初始 settled 哨兵、严格 post-state validate、saved Start 竞争输入/两类 ACK 后失败；不复制宿主队列 |
| B4：定义/scope 元数据不是恢复/采用/派发 | 单测原 refs/材料/owner/current；preparation/scope 原生审核前后完整状态比对，独立 recover 才继续 |
| B5：旧命令与独立 hold/预算 | 原 check/smoke；shared original command cores；board-only 原生保留整个 Supervisor，取消/unknown/changed-usage 单测不 refund |
| B6：延后回调原 runtime / branch | `bindRuntimeCallback` 两个独立 runtime、嵌套 await 和结果 reaction；owner/material/branch 失效单测，H0 本身 source/manager 隔离 |
| B7：原事实待办、有界去重、冷恢复 | 运行态 WeakMap、4096 fail-closed 源审计；Later/拒绝/取消/历史测试；实际 cold pending preparation 在无关轮次后不重问 |
| B8：真实 TUI，其他失败关闭 | 当前 pair 的真实 resolution+TTY；旧 1.1 A-only；unsupported frontend/capability 单测。没有认证 RPC/Bun 为批准前端 |

## 5. 失败历史与边界

- 首批全测 3447 PASS 但 branches 89.55%；随后 3460/89.88%、3466/89.96%、3472/89.98%、3474/89.99% 均**不通过门**。补充实际分支行为、发现并修复两项真实接线错误后，3475/90.01% 全 check PASS；再加入 runtime 隔离测试，最终 3476/90.01% 全 check PASS。没有把门失败说成通过。
- 中间测试错误包含 publication 事件名、原生确认标签及缺 import；均修正并重新运行。非 Error reject 用真实 mock rejection 测试，不放宽 lint。
- 首个 preparation 原生试验在审核 commit 前注入 probe，正确取消了审核。改为等实际 bound/committed 通知后再 probe，不以固定 sleep 冒充提交。
- saved-cancel 初版假设必有 board snapshot 而 KeyError；改为核对实际物理 assistant 工具调用，没有业务调用/文件；不把缺 snapshot 伪造为“已验证空计数”。
- 投影失败初版错误地要求零 custom continuation/零 kernel start；观测证明 ACK 已发生、kernel 中止但 provider 未调用。修正边界断言，原生产逻辑未改成假“未派发”。
- 冷样本初版等待被历史渲染覆盖的 toast、遗漏冷分支 runtime 捕获、误用 control view 查 legacy proposal；改为真实 ready 文件+渲染、原 runtime-bound observer 及原 cachedApprovalAction。最终同 workspace/原物理前缀来源成立才通过。
- 本地候选和临时 H0 pair 通过不代表升级/部署。当前全局宿主无 H0，仍 A-only；RPC/Bun 未新认证；原业务 session 未用作样本。

## 6. 当前接受门

[首轮实现报告](supervisor-human-interaction-b-implementation-review.md)为 **BLOCK**，原样归档并 byte-compare；三项 P1 是缺 task WorkOwner 稳定绑定、恢复依赖 presentation projection 而漏实际未知来源、恢复只哈希而不展示材料。R1 不接受。A/H0 仍已接受；不修改它们或原业务会话。

## 7. R2 修复与当前验证

### 7.1 明确修复与 RED→GREEN

- **P1 owner：** `identity()` 仅 tasks 家族加入实际 `currentWorkOwner(sessionId)`。允许原 supervised planning→Start 合法变化，不用 board generation 代替 owner。经原 tasks-only/write/compile/resume 核心，在旧 dispatch 结果返回前实际替换并编译新 owner；cancelled/rejected/unknown 三例均先 RED（多写 2 条 pause 记录），修后零后续写入、新 board 不变。
- **P1 recovery safety：** B 派生、展示前与确认后直接核对 management active/non-null owner、identity/invocation/journal；复用原 `writerAttention` 的执行/capture 安全检查及原 `executionAcceptanceIssue`，保留原 domain/flow 门。仅导出原只读 checker，不改变旧命令行为。task-only null/invalidated owner、stopping、未知 memory execution、pending host capture、invocation attention 均不提供生效恢复；原生确认期间再出现后三类也零写入/派发。
- **P1 material：** 在原单问题锁中先用导出的原 `reviewScope` 完整只读分页，关闭后再独立 native select。显示实际 owner、board generation/digest、Supervisor status/hold/reason/已用 counters、原 contract/scope/拟采用 revision 与完整 proposal、执行结算和 host-capture facts；缺项明示未知。完整 facts + humanStateStamp 在阅读及最终确认前后都重核。没有新 NativeAnswer/kind/批准存储。
- 原 viewer 会显式编码空白/控制字符；材料不能用日志默认 2000 字截断。采用原 redactor 的显式无截断上限，保留完整分页与取消。仅恢复看板、联合 user_pause、recover/adopt 及无 Supervisor 的 task-only 效果分别说明。
- `/tmp/task-supervisor-b-r2-red-minimal.log`：**14 项全部 RED**，不是超时替代。修后这 14 项及新增阅读 Esc/精确 scope adoption 测试全 GREEN；idle-human 共 **59 项**。初版 P2 测试 await 会等待已错误提交的 host handle，已改为立即断言请求次数，反馈缩至 <1 秒。

### 7.2 当前冻结代码和检查

- R2 manifest：`/tmp/task-supervisor-human-interaction-b-candidate-r2-20261102.json`。
- 87 生产文件指纹：`08a4f3598d37ed05fd7928493c736689889a98cf17a3107d370cd7f14f2dc7da`。
- 全 src/测试/原生 harness/配置指纹：`b4a0e26a3c0b93c832e9258b2915fe1e3c210b5c6f6b531fcf7126c14dce4f41`。
- 实际原生 pair：`/tmp/task-supervisor-b-pair-r2-qualified-20261102`，生产字节与当前候选相同；CLI/resolution 与 R1 同一冻结 H0，不伪造 trust。
- `python /tmp/audit-task-supervisor-b-candidate-r2.py`：PASS；11 份报告/session/transcript 及 4 份完整恢复材料哈希均固定，安装/设置不变、主 peer 1.1.0。
- 完整 `npm run check` PASS：`/tmp/task-supervisor-human-interaction-b-r2-check-first.log`，**147 文件 / 3492 测试**；statements **93.37%**、branches **90.04%**、functions **97.91%**、lines **95.49%**，原 90% 门和原完整 smoke 不变。
- H0 只重核冻结指纹 PASS，没有重跑已经接受的 H0 suite 或改 host。`git diff --check` PASS。

### 7.3 R2 实际 CLI/TTY 矩阵（11 份）

全部报告位于 `/tmp/`，同前仍是合成模型/按键、真实 CLI/TTY/UI/物理日志，不是业务授权或验收。

| 场景 | 报告（各目录内 `verified.json`） |
| --- | --- |
| 原材料→权限→单独 Start→完成 | `task-supervisor-b-native-approval-existing-r2-qualified-20261102/owned-rjulvpxs/` |
| preparation→定义→完整恢复材料→独立 recover | `task-supervisor-b-native-approval-preparation-r2-qualified-20261102/owned-8fltaakk/` |
| scope metadata→完整材料/仅恢复看板→完整拟采用 revision/proposal/独立 recover | `task-supervisor-b-native-scope-r2-qualified-20261102/owned-reqorqpi/` |
| 真实原命令普通 pause→完整材料/原生联合 resume | `task-supervisor-b-native-joint-r2-qualified-20261102/owned-gyxgzmi0/` |
| 有限 choice | `task-supervisor-b-native-choice-r2-qualified-20261102/owned-79hqx8xj/` |
| integer information | `task-supervisor-b-native-information-r2-qualified-20261102/owned-u1o3n5wc/` |
| saved Start + 竞争输入取消 | `task-supervisor-b-native-human-cancel-after-start-r2-qualified-20261102/owned-8h35xwnh/` |
| 已 ACK / pre-kernel throw | `task-supervisor-b-native-human-prepare-failure-r2-qualified-20261102/owned-0z3akac0/` |
| 已 ACK / setter failure / abort，零新增 provider 工作 | `task-supervisor-b-native-human-projection-failure-r2-qualified-20261102/owned-1nwe6w0t/` |
| 冷 pending preparation + 无关只读轮次零问题 | `task-supervisor-b-native-cold-r2-qualified-20261102/` |
| 原 1.1 A-only | `task-supervisor-b-native-old-host-r2-qualified-20261102/owned-5on2feyl/` |

四份 `recovery-material-N.txt` 从真实终端逐页捕获；harness 在独立最终选择前确认完整字段、board-only/joint/recover 的不同效果，scope recover 另核对当前精确 revision entryId/digest 与 recoveryRequired=true。没有通过 widget 或内部 hash 冒称展示。

普通 pause 的首个新增试验只在 fixture 调用 pause 核心后 abort，原 settled 正确标作 run_aborted，不算 user_pause。修正为真实 PTY `/task-supervisor pause ...`；有界 compile-checkpoint 只等该原命令进入，然后原 command 的 manualPauseDepth/abort/settle 完整执行。没有模拟 ctx.waitForIdle、改 argv/TTY、预写 confirmed 或将 fixture pause 当批准。新 `--human-joint-resume` 仅验证这一独立恢复样本。

### 7.4 当前门

[R2 独立复审](supervisor-human-interaction-b-implementation-review-followup.md)已闭合 #1 owner 与 #2 safety，#3 仍因材料的 currentContract 取了历史全局最后一项而 BLOCK。该报告原样保留；R2 不接受。

## 8. R3：原 owner-aware 选择器与最新冻结证据

### 修复

唯一生产修改在 `idle-human.recoveryScope`：真实 `currentWorkOwner(sessionId)` + 原 `selectedAcceptanceContract(source.view,owner)`。该原 selector 选择实际 owner，且 scope-reviewed 契约须有有效 commit；不新增 fallback 或选取规则，不用 `source.owner`（未提出 scope proposal 时它可能为空）。

新增回归经真实原核心 Goal/contract→disable→tasks-only→新 board write/compile/pause：确认历史契约仍在物理 journal、实际 owner 已不同，再通过原生组件 driver 查看恢复材料。旧代码先 RED，错误显示旧 Goal contract；修后 currentContract 明示“未提供/未知”，旧 entryId/digest 不出现在材料。源测试日志 `/tmp/task-supervisor-b-r3-red.log`。原 owner 有契约和明确 scope adoption 的既有测试仍通过。idle-human 共 **60 项**。

### 当前代码与完整检查

- Manifest：`/tmp/task-supervisor-human-interaction-b-candidate-r3-20261103.json`。
- 87 生产文件指纹：`e1f5aa17616519df04654e9b956089bfa13e4e84cdd6401e46b62a31c377d852`。
- 全 src/测试/原生 harness/配置指纹：`dbc1b349c9fba798971b66b281dd99a197cbe54d1baf98a2759c57f543436f8b`。
- Pair：`/tmp/task-supervisor-b-pair-r3-qualified-20261103`；生产字节相同，真实模块解析仍对应冻结 H0。
- 审计：`python /tmp/audit-task-supervisor-b-candidate-r3.py` PASS；11 份当前报告/session/transcript 与 4 份恢复材料哈希固定，安装、设置与主 1.1 peer 不变。
- 完整 `npm run check` PASS：`/tmp/task-supervisor-human-interaction-b-r3-check-final.log`，**147 文件 / 3493 测试**；statements **93.37%**、branches **90.05%**、functions **97.91%**、lines **95.49%**；原 90% 门及原 smoke 全链不变。
- H0 仍为接受的 `066b21…434a1`，只读 hash audit PASS，没有重新修改/构建宿主。`git diff --check` PASS。

### 当前 11 项原生矩阵

同 §7 的全部 11 项已在 R3 pair 重跑：原权限/独立 Start、preparation/定义/独立 recover、scope/仅看板恢复/精确采用 revision、普通 pause/联合 resume、choice、integer information、保存 Start 后竞争取消、ACK 后 pre-kernel throw、setter abort、冷 pending 历史静默、旧 1.1 A-only，**全部 PASS**。完整路径与实际 session 哈希在 manifest；报告目录格式 `/tmp/task-supervisor-b-native-<场景>-r3-qualified-20261103/`，不复用旧候选报告当最新源码证明。

四份新的实际恢复阅读材料位于：
- scope `owned-ynsmz8l4/recovery-material-1.txt`（board-only）及 `-2.txt`（精确 scope revision/proposal）；
- joint `owned-3e82cywo/recovery-material-1.txt`；
- preparation `owned-gwoesmlb/recovery-material-1.txt`。

仍是合成模型/按键，不是业务授权/研究验收。没有新增安装、部署、重载或业务会话操作。R1/R2 BLOCK 报告及全部失败工件保留。

### 当前门

[最终独立复审](supervisor-human-interaction-b-implementation-review-final.md)明确 **B R3 local candidate implementation verdict: OK**；剩余材料选择 P1 CLOSED，两项已闭合 P1 无回归。报告原样归档。Main 接受前再次核对 R3 manifest / 11 份实际原生工件 / 相同 87 源与全代码指纹、H0 冻结指纹，并独立重跑 **17 项关键回归 PASS**（43 skipped 仅为本次定向过滤），日志 `/tmp/task-supervisor-b-r3-main-acceptance-20261103.log`。完整 3493 项及原 smoke 证据仍是上述全 check，不用定向测试代替。

## 9. Main 最终逐项审计与本轮完成边界

| 路线图要求 | 当前依据与结论 |
| --- | --- |
| P0：诊断/宿主事实与不虚构根因 | A 诊断、实际 1.1/1.4 隔离原生记录、H0 discovery/source-map 对应已核实。历史 deferred 和原业务客户端的真实退出原因仍明确未知；本轮不声称重现/修复了该旧客户端现场 |
| P1/A：诊断、只读待办、旧兼容 | A 已独立接受；当前旧 1.1 真 CLI 样本再次确认零新增 control/witness/模型调用。新 helper 不放宽 NativeAnswer、argv/TTY/package trust，旧状态/命令保留 |
| H0：公开完整 idle/pending、取消、最终验证、唯一开始、不重放 | 独立已接受 R2、原生 late-settled/deferred/async validation 及 bundled/unbundled 证据保留；当前 13 文件指纹复核一致。B 未改宿主、未读取私有队列或另造调度器 |
| P2/B：共享原控制、runtime/owner/材料与失败闭合 | 原共享核心及独立命令 wait；H0 run/predicate/validate/result 绑定原 runtime；R2/R3 全部 P1 已 CLOSED。原控制与物理见证不换协议，原权限/Start/已用 budget 不回滚，未知派发不重放 |
| P3/B：完整无审批命令交互 | 当前 pair 的权限→独立 Start、具体定义、scope、choice/information、board-only/joint/recover 全部原生通过；元数据审核不恢复/采用/执行，恢复先完整材料后独立选择。缺来源/未知 capture/execution 仅诊断，拒绝/Later/历史不自动重问 |
| P4：完整回归、原生竞争/失败、独立接受、README | 147 文件/3493 项、原 90% 门及全 smoke PASS；11 当前真实 CLI/TTY 样本及 4 份恢复材料哈希；三轮独立 B 审阅记录完整、最终 OK，Main 同指纹+17 项复核 PASS。README/packet/本记录已更新 |
| 显示/并发/失效/持久化/资源/历史/兼容矩阵 | 原始完整回归覆盖各控制的失效和故障优先级；实际 reader/resize/choice/information/metadata/cancel/prepare-failure/cold/legacy 样本组合，不拿 SDK stub 代替原生证明；固定权限 limits 修订与原硬限额保持原模块/测试，无新增 budget reset |
| 范围与保留门 | 主仓库/隔离 host 现有改动保留，无 reset/stash/commit/push/install/publish。全局设置和已安装 host 哈希未变；原业务 session 不用于测试；RPC/Bun 未新认证。部署/重载/业务批准/Start/恢复是后续独立授权，不是本轮本地实现验收缺口 |

**结论：本轮“按计划推进至完成”的本地实现、隔离验证、独立接受与候选交付全部完成，无已知必需编码/验证工作遗留。** 当前安装环境仍 A-only；需要启用 B 时执行者须先另行明确授权部署/重载范围，不能把本结论当安装指令或业务批准。用户现在无需执行部署或业务操作。

管理状态限制：以当前上下文给出的 Goal ID 调用 `goal_complete` 时，服务拒绝 `current run does not own the active goal`；本根会话也没有可联系的 supervisor。未重试其他 Goal ID 或绕过所有权。上述本地交付与验收已完成，但**不声称系统 Goal 状态已成功更新**；该管理状态只能由实际拥有 Goal 的会话处理。
