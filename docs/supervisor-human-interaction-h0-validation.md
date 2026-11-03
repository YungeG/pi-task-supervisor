# H0 隔离宿主候选验证

2026-11-02 · R2 · **H0 R2 隔离候选已获定向独立实现 OK，Main 复核指纹及 16 项相关测试后接受。不是 B 完成、安装或业务会话修复声明。**

## 1. 载体、授权与候选身份

- 用户已允许隔离源码/修改/构建/验证；载体 `/home/ygguo/agent-projs/pi-human-interaction-host`，官方 `v1.4.0` / `4a080252f06caf63a525d7873c5d94d3c23887e0`。未提交、安装、发布、替换已安装 Pi 或重载业务会话。
- [H0 packet v2](supervisor-human-interaction-h0-implementation-packet.md)的[独立设计复审](supervisor-human-interaction-h0-design-review-v2.md)为 READY；首轮 BLOCK 报告保留不改。
- 固定写集内修改 13 文件：9 源文件、公开扩展文档及 3 个新增测试。未修改依赖、锁文件、生成模型 TS 或已发布版本；此前精确复制的 ignored 官方模型 JSON 仍仅为离线构建输入。
- 当前 R2 的 13 文件候选指纹：`066b21cda79bd3ea2a12840243c428bfb525c1c21fc8f3442d5d281f400434a1`；逐文件清单 `/tmp/pi-human-interaction-h0-candidate-20261102-r2.json`。Main 的工件复核脚本 `/tmp/pi-h0-audit-candidate-r2.py` 已核对当前源码、实际 dist、物理 session/receipt 及保护文件哈希，PASS。
- 首轮被 BLOCK 的候选指纹 `aa171bef5ee533815a37507f3d7165d3dab5cbad7cb2b190dd5020e2bf3aecf5` 及原清单/原生报告均保留；不能当作当前 R2 接受证据。
- 当前 9 源文件集合指纹：`db154401d52c563420fc1fd09dc9ac1f5878f0619653432c6346521b7e96913c`。算法为原生验证脚本对 `{相对 src 路径: SHA256}` 排序 JSON（无空格）再 SHA256；逐文件值见最终原生 verified.json。HEAD 单独不代表候选。

## 2. 实际修改

| 接缝 | 实现 |
| --- | --- |
| `core/idle-actions.ts` | session 单槽、UUID/SHA-256 binding、有界幂等、取消及 cleanup join、可取消 async validate、一次 dispatch；不持久化 UI 意图 |
| `agent-session.ts` | 完整 pending 来源及输入/控制 barrier、splice 后 deferred 在途计数、origin bash barrier、同步失效、busy 写入后的独立 logical-start 收据；H0-only 准备失败 settlement；普通 subscriber 退出 action ALS，保留同步异常语义 |
| `extensions/runner.ts` | guarded 普通/leased context，私有 UI owner，普通 callback/error listener 退出 action ALS；通用 emit 与 idle warming decision、provider headers/payload 都有整段 activity；实际 UI lifetime/queued events；缓存方法 stale；leased blocking UI 限本机 TUI，hasUI 按 raw sentinel 判断 |
| `extensions/loader.ts` | EventBus 订阅者调用时读取最小 runtime 隔离 hook，保留绑定前 identity、扩展自身 ALS 与原订阅清理 |
| TUI / RPC mode | 快捷键不再自建 raw context；两种 bash 分支从拦截前到结果记录结束使用同一 origin Session 的整体 barrier |
| 类型 / exports / docs | optional `ctx.idleActions.version === 1` 与结果类型；started 只表示 logical-start，不代表 provider/任务成功；旧 isIdle/pending 语义不冒充完整资格 |

未修改 Supervisor 控制、NativeAnswer、物理见证、批准/Start/恢复协议或预算。H0 收据只是宿主交付观察，不是业务批准。

补充通知选择：`agent_settled.idleActionFailure` 标识已 ACK 但 kernel agent_start 前失败的 H0 delivery，含同一 actionId/runId/sessionId。该 optional 字段实现 packet 的失败/settlement 要求；旧非 H0 路径不增加自动重试或新批准含义。

## 3. RED → GREEN 与失败处置

| 哨兵 | 实际失败与修正 |
| --- | --- |
| 第一个 settled handler 申请、后一个阻塞并提交更早输入 | 首次 RED 为公开能力尚不存在；实现后事件内零 callback，输入取消原 pending。它不证明历史业务会话曾发生同一竞争 |
| async validate 中 abort | RED：signal 未失效；接入原输入/控制失效后，取消不等 validator 返回，晚 true 零派发 |
| dispatch 拒绝后 handle outcome | RED：handle 错报 completed；修正为保留首个 dispatch 结果，不以重复 dispatch 覆盖 |
| 回调返回但 owned UI 尚未实际关闭 | RED：handle/槽位提前释放；修正为 abort 后继续 join 自己的实际 UI lifetime，不加入正等本 cleanup 的 foreign activity |
| TUI 快捷键及两种 bash 拦截返回 | RED：快捷键无 API、更早 bash 等待时 action 已进入；修复原 mode 接线，记录只一次且不写入 replacement Session |
| RPC 两种 bash 拦截返回 | 同一整体 barrier 缺口 RED 后修复；实际 RPC 输入处理入口验证 origin Session 归属 |
| 4 个专用 abort 控制 | RED：validate 未取消；补齐 bash/compaction/branch-summary/retry 的同步失效 |
| source/validator 返回非 boolean true | RED：truthy 值通过；仅接受 literal true，binding 还要求实际 string |
| 最后 source predicate 重入 cancel 后返回 true | RED：仍获得 started；修正为 callback 返回后再次核对 slot/token/epoch，不能复活取消 |
| logical-start observer 抛错 | 初次测试等待 settlement 超时；已确认无残留 vitest 进程，再改成确定性断言得到 busy 不释放的 RED。增加 H0-only 外层失败收束，保留 started、不重放 settlement，GREEN |

验证过程中有过静态检查失败：新 RPC 测试的 Node listener 类型不兼容；修正后最终完整根检查通过。旧 9068 fixture 还暴露新私有 helper 的 fixture 耦合，已将 TUI 整段 barrier 内联回原方法，旧回归恢复通过。未把这些中途失败算作 PASS。

## 4. 最终自动验证

### 定向测试

- 新增 3 文件 **49 tests PASS**（包含本轮 14 个先 RED 后 GREEN 用例）：`test/suite/agent-session-idle-actions.test.ts`、`test/interactive-mode-idle-actions.test.ts`、`test/rpc-idle-actions.test.ts`。
- 与既有 concurrent、queue、boundaries、runtime、prompt、retry、compaction、model-extension、bash、extensions-runner/input、dialogs、cache-warmer 及有关启动/9068 回归组合：**20 files / 308 tests PASS**。
- 完整命令和输出：`/tmp/pi-human-interaction-h0-targeted-20261102-r2-final.log`。
- 另覆盖容量 4096、重复/冲突/busy、旧 lease/API disposal、扩展 ALS/绑定前事件及 unsubscribe/discard/invalidate、owned 两步 UI 和 queued UI observer、真实 core queue/nextTurn 与 splice 后在途计数、准备失败及 post-start callback 异常。

### 静态 / 构建

- 根 `npm run check` **PASS**，完整输出无 tail，含 formatter、依赖/入口图/锁文件检查、tsc 和 browser smoke。最终日志 `/tmp/pi-human-interaction-h0-check-20261102-r2-final.log`。
- package `build:unbundled` 作为同配置小样 **PASS**，再运行完整 `npm run build:offline` **PASS**；最终日志 `/tmp/pi-human-interaction-h0-build-20261102-r2-final.log`。`check:model-data` 通过，bundle 81 files / 8.8 MiB。
- `git diff --check` **PASS**。仅 formatter 改动本候选文件；没有更新源模型目录或锁文件。

## 5. 真实 CLI / tmux / TTY 验证

隔离、离线、合成 faux provider；**没有 mock argv/TTY/UI，没有真实 provider/业务调用**。先单次小样，再同路径组合。脚本 `/tmp/pi-h0-native-smoke.py`，fixture `/tmp/pi-h0-native-fixture.ts`；专用随机 tmux socket 在结束后关闭。

| 载体 | 最终实际工件 |
| --- | --- |
| Node unbundled `dist/cli.js` | `/tmp/pi-h0-native-unbundled-r2-20261102/verified.json` |
| Node bundled `dist/bundle/cli.js` | `/tmp/pi-h0-native-bundle-r2-20261102/verified.json` |

两份报告均为 PASS、指向独立真实 session.jsonl、events.jsonl 及实际 terminal pane captures；记录同一最终源码指纹，分别记录 9 / 81 个实际 dist JS 哈希。每份物理会话均为 **1 started、4 cancelled、1 条 H0 delivery**；另外 4 个模型 run 属于明确注入的竞争/更早输入，不是旧 action 的重复派发。

每种载体实际覆盖：

1. 原生快捷键获得 guarded API、真实 select，唯一收据与实际 custom message 的 action 身份一致。
2. UI 期间公开输入取消并等待 UI callback cleanup，才启动竞争输入。
3. async validate 期间输入取消；外部信号随后释放旧 validator 到 true，仍零陈旧派发。
4. ordinary foreign UI 的 ui_prompt_start 在旧 callback cleanup 之后，不能同时保留两个问题。
5. 后一个 settled handler 被栅栏挂住并登记更早 deferred 输入；原 action 不进入 callback，被取消，旧 UI 不补开。

合成按键和信号不是人类身份或业务批准证明。tmux 有默认 extended-keys 提示；本次实际 CSI-u 快捷键及普通 Enter 已实测，不修改全局 tmux 配置。此处没有验证 Bun 二进制、RPC 客户端实际 UI 关闭或新的可信前端；B 仍仅允许原可信本机 TUI，不能据此放宽。

已安装 Pi `dist/core/agent-session.js` 哈希仍为 `436e8be3bbab2db475ce30bb5d0bb30f0046b19a3476f8cd57b8133e68891162`；全局 settings.json 哈希前后相同（值保存在报告，不复制内容）。Main 已读取报告及原生界面文本，未使用其他会话。

## 6. 接受门与后续责任

- [首轮独立实现报告](supervisor-human-interaction-h0-implementation-review.md)为 BLOCK，原样归档。四项问题已按 §7 修正，[R2 独立复审](supervisor-human-interaction-h0-implementation-review-followup.md)确认全部 CLOSED / OK。Main 随后重新运行工件审计（同一 13 文件指纹）及两文件内 16 项相关测试，均 PASS，接受本隔离 H0 候选。
- 定向测试不是全 monorepo 全量 suite；未调用可能带真实 provider 凭据的全 vitest。已按 packet 运行相关文件和根检查。
- H0 设计/实现/本机 TUI 原生资格门现已满足；以本文件固定候选为依赖，进入 B 的精确接入 packet。任何后续宿主改动须重新核对候选和受影响验证，不暗改已接受载体。
- [B 实施约束 v1](supervisor-human-interaction-b-implementation-packet.md)已获独立 READY、Main 已实现并取得[本地完整检查及隔离原生矩阵](supervisor-human-interaction-b-validation.md)；B 经 R2/R3 复现修正原实现审阅的问题，R3 已最终独立 OK、Main 同指纹+17 项复核接受并完成路线图审计。H0 本身仍冻结，旧宿主仍只有 A。
- 整体 Goal 未完成；没有用户需要补批的当前范围门，也没有安装/重载/业务控制授权。

## 7. 首轮实现意见的 R2 处置

Main 逐项核实源码并同意四项 P1；14 个新回归在修复前均 RED，修复后 GREEN。原报告未将其记为复现实验，Main 的这些 RED 补齐了运行证据。

| 意见 | 最小修改 | 当前验证，不代替复审 |
| --- | --- | --- |
| RPC 本地 Promise 结束不代表客户端关闭 | leased select/confirm/input/editor/custom 在进入 raw UI 前拒绝非 tui 或无 raw UI 的上下文；metadata action API 保留，普通 RPC UI 和 bash 不改，不新增 RPC wire | 5 种 leased UI 均无 outbound UI request、callback 失败关闭；每种随后普通 RPC select 仍能正常响应 |
| 普通 Session observer 继承 action ALS | `_emit` 逐 subscriber 只退出本 controller ALS；同类 runner error listener 同样隔离，不改变同步返回/抛错语义 | 两种 observer 的竞争输入取消并 join 旧 action，随后处理一次；扩展自己的 ALS 值保留；既有直接 self-send 仍 fail-fast |
| idle warming 专用 dispatch 未计 activity | 与 generic emit 共用整段 try/finally helper，覆盖 cache decision 和实际 warming 路径的 provider headers/payload；SDK/cache-warmer 本身不改 | 三种 dispatch 的第一 handler 申请、第二栅栏阻塞时零 callback；全退出才 callback；三种事件碰到 active action 都取消且无自等待；旧 cache-warmer 9 项回归 PASS |
| no-op UI Proxy 让 hasUI 错报 true | 用 raw UI sentinel 判断，不撤销 guarded wrappers | 实际无 UI Session、显式 setUIContext(undefined)、真实 TUI/RPC 设置后清除均断言正确 |

本轮中途两项 fixture 验证问题均已处理：observer 的输入事件发生不代表模型 run 已开始，测试现等待实际 settled，不放宽旧 isIdle 语义；RPC custom 的假组件缺 `invalidate()` 曾令 tsc 失败，核对真实 Component 类型后补齐。最终检查通过，不把中途失败算作通过。

更新 packet、类型注释与公开文档，明确仅本机 TUI 的 leased blocking UI 获得资格。此为保守失败关闭，不建立新的可信 RPC 前端、不扩大 B 或批准含义。
