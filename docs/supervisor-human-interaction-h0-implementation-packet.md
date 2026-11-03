# H0：事件外人工交互与可撤销交付实施约束

2026-11-02 · v2 · **首轮三项 P1 经 v2 定向独立复审全部设计层 CLOSED；Design READY，Main 已接受；首轮实现审阅 BLOCK 的四项意见已修正，R2 独立实现 OK，Main 已复核并接受隔离 H0 候选。** 本 packet 只冻结 H0；B 的原控制接入须在 H0 通过后另行冻结符号约束。原始审阅保留在[首轮报告](supervisor-human-interaction-h0-design-review.md)，不将文档修订记作接受或实现证据。

## 1. 授权、固定源码与边界

- 用户已明确“允许”在 `/home/ygguo/agent-projs/pi-human-interaction-host` 建立隔离 Pi 源码副本，锁定版本、设计复审后修改、构建和验证。**不替换已安装 Pi、不重载或操作业务会话、不提交/发布。**
- 官方 `https://github.com/earendil-works/pi.git`，tag `v1.4.0`，commit `4a080252f06caf63a525d7873c5d94d3c23887e0`；新建隔离工作树，初始 clean。
- `agent-session.ts`、extensions `types.ts/runner.ts/loader.ts` 已与已安装 1.4 的 source map sourcesContent 逐字匹配；不是仅凭版号推定来源。宿主规则见该仓库根 `AGENTS.md`，不改生成模型 TS、不跑安装生命周期、不跑真实 provider/e2e。
- `npm ci --ignore-scripts` 的 dry-run 后进行本地依赖准备；原锁文件不变。缺失的 ignored 模型 JSON 用已安装同版官方包的 43 文件、990090 字节精确副本离线补齐，官方 `check:model-data` 通过；不请求模型 API、不刷新市场/模型目录。
- 最小宿主测试已运行：`agent-session-concurrent.test.ts` 7 passed；构建小样 `npm --prefix packages/telemetry run build` passed。
- 要求来源：原路线图 §5.2 的 H0 六项；A 不变式及独立审阅确认的队列/取消缺口。原 `isIdle`/`hasPendingMessages` 保持旧含义，不能当作 H0 资格。

## 2. 问题与选定接缝

旧 trace：settled 回调中保存 Start → 旧 sendMessage 登记 deferred → 更早输入改变 hold/取消 → deferred 仍启动旧 run。仅重新读一次 isIdle 看不到该 pending，也没有交付前资格门。

选定：宿主提供 **单个 pending/active idle action 槽位**。这是宿主有限交互接缝，不是扩展自行维护第二业务队列。待真正退出所有相关事件、输入操作和 earlier queues 后，执行一次带取消信号的回调；回调仍用原生批准/见证，唯一模型交付仅通过该 action 的 dispatch。

宿主负责事件、输入、会话和交付资格；扩展负责实际 owner/hold/权限/材料/预算。两者均不能替代另一方。H0 lease/result 都不是 NativeAnswer，不授予业务权限。

## 3. 固定公开类型（宿主 extensions/types.ts）

以下是拟新增接口，不是当前 v1.4 已有能力：

```ts
interface IdleActionState {
  phase: "busy" | "settling" | "idle";
  pendingInputs: number;
  activeActionId?: string;
}
type IdleActionReason =
  | "invalid_request" | "conflict" | "busy" | "capacity"
  | "input" | "abort" | "stale" | "validation"
  | "callback_error" | "dispatch_unknown" | "unavailable";
type IdleActionResult =
  | { status: "completed" | "cancelled" | "rejected" | "failed" | "unknown"; actionId: string; reason?: IdleActionReason }
  | { status: "started"; actionId: string; runId: string; sessionId: string };
interface IdleActionHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly result: Promise<IdleActionResult>;
  cancel(): void;
}
interface IdleActionLease {
  readonly id: string;
  readonly context: ExtensionContext;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  dispatch(
    message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
    validate: () => boolean | Promise<boolean>,
  ): Promise<IdleActionResult>;
}
interface IdleActionRequest {
  id: string;
  binding: string;
  isCurrent: () => boolean;
  run: (lease: IdleActionLease) => Promise<void>;
}
interface IdleActionAPI {
  readonly version: 1;
  state(): IdleActionState;
  request(request: IdleActionRequest): IdleActionHandle;
}
// Optional when no AgentSession-backed implementation is bound.
// Getter/method closures retain the original runner's stale-instance checks.
interface ExtensionContext { readonly idleActions?: IdleActionAPI; }
```

- id 为一次 UI 尝试的 UUID；binding 为调用方源/owner/请求/材料身份的 SHA-256，不是批准值。相同 id+binding 的重复调用返回原 handle；同 id 不同 binding 拒绝 conflict，不替换 callback。用户稍后后显式重新打开用新 attempt id，不重放原 handle。
- 同一 Session 最多一个 pending/active action；不同 id 竞争时拒绝 busy，不排第二个问题。terminal 只保留 outcome+binding 等少量去重元数据，释放 UI/callback/message 引用；最多保留 4096 个尝试，满后新请求失败关闭为 capacity，保留旧幂等结果。它不是 Supervisor 业务预算，原命令仍可用，不自动清零或驱逐旧幂等键。重启不持久化或重放 action。
- `completed` 只表示 callback 返回，不表示批准或验收；`started` 只表示宿主 logical run 已开始，不表示 provider 请求成功、任务完成或目标验收。
- `dispatch` 冻结 message 副本，在 async validate 后再次核对 token/input epoch/Session/branch/全 pending。一个 lease 最多 dispatch 一次。validate 必须是只读、可取消的资格检查，不能发送输入、启动工作或依赖新输入才能结束。
- `request.run` 与 validate 禁止通过旧 pi.sendMessage/sendUserMessage/prompt 绕过 dispatch；自身这么做失败关闭，不自等待。普通旧输入的行为不因 H0 自动变成业务批准。

## 4. 宿主实现符号与固定写集

单写者为当前 Main；不改 global/node_modules、模型生成 TS、锁文件或已发布版本段。

| 文件/符号 | 责任 |
| --- | --- |
| 新 `src/core/idle-actions.ts / IdleActionController` | 单槽位、attempt 幂等/有界记录、取消/代际、callback 生命周期、可取消 async validate、唯一 dispatch/result；依赖注入宿主 state/context/start，不解析业务权限 |
| `agent-session.ts / _idleActions, _idleInputOperations, _deferredSettledInFlight` | 原生输入/交付状态；pending 对真实 core queue、deferred（含 splice 后尚未执行项）、nextTurn、context-only、bash pending 全覆盖，不重复把 UI mirror 算成独立输入 |
| `agent-session.ts / _withIdleInput` | 输入方法入口同步使现有 lease 失效；计数在 await 前增加；UI/validation 中的外部输入等待已取消 callback 退出后处理；callback 内误用旧输入 fail-fast，不等待自己 |
| `prompt, sendCustomMessage, _queueUserInput` | 薄包装调用上述输入接缝，原 body 留在私有内部方法，旧输入队列/命令/模板/鉴权规则不删 |
| `bindExtensions, reload, setModel, cycleModel` | 在跨 await 的 native control 操作期间保持对应 barrier；复用同一入口 helper，不开放 UI 中的新 action |
| `abort, clearQueue, dispose, compact, navigateTree, setThinkingLevel, setActiveToolsByName, executeBash, recordBashResult` | 在原状态改变前同步取消尚未交付 action；原行为/返回值保留。`recordBashResult` 保持 void，不以异步包装改变调用方；action 自调用在写入前 fail-fast。dispose 永久失效；reload 只取消并保留本 Session 已用 attempt 幂等结果 |
| `agent-session.ts / withUserBashInput<T>(run: () => Promise<T>): Promise<T>` | 仅供宿主 mode 调用的整段 bash 输入 barrier，委托 `_withIdleInput`；从拦截前同步计数/取消，经 cleanup join，再覆盖 handler、执行或 full-result 记录，直到 finally 退出。不是 ExtensionContext 的新权力 |
| `modes/interactive/interactive-mode.ts / handleBashCommand`、`modes/rpc/rpc-mode.ts / handleCommand` 的 bash 分支 | 外层调用 `withUserBashInput`，保留原 UI、错误处理、operations/full-result 分支及唯一结果记录；不只包 `executeBash` 或 dedicated emit |
| `_emitAgentSettled` | 全部 settled 回调与原 deferred 处理完后才能 pump；deferred 处理中的剩余/在途计数持续可见；有更早输入则 action 取消，不越过它弹窗 |
| `_bindExtensionCore` | 向 runner 绑定 optional idleActions 实现、leased context/UI hooks、activity-change 和回调隔离 |
| `_startRun` | 新增 private idle-delivery 参数；最终检查到此函数同步设置 busy 之间不得 await；到 logical-start 消费一次交付，再按原准备/agent 路径执行，不靠旧 settled send 队列 |
| `AgentSessionEvent` | 仅 H0 路径新增 `idle_action_started` 观察事件，含 actionId/runId/sessionId。旧 agent_start 不冒充新的 logical-start 收据 |
| `extensions/runner.ts / createContext, createIdleContext` | optional API getter；leased context 以相同原 SessionManager/runner 提供 action.signal 和带 owner token 的 UI，不增加 command/waitForIdle 权力 |
| `modes/interactive/interactive-mode.ts / setupExtensionShortcuts` | 删除手工拼装 raw context 的旁路，每次按键用绑定该快捷键的原 runner `createContext()`；普通 wrapped UI、惰性 getter/stale 检查及 idleActions 同源。通过 runner 的 callback 隔离 helper 调用 handler；不发 leased token，不把整个异步快捷键 handler 当作阻止其自身 action 的 activity |
| `wrapUIPromptContext, withUIPrompt, emitUIPromptEvent` | leased UI 的 activity 标明本 action；普通/别的 UI 为 foreign，先取消/加入旧 action 再打开，不抢未关闭的问题。自己的 source review/最终 select 不取消自身；leased blocking UI 仅限 tui + 非 no-op raw UI，RPC/无 UI 失败关闭 |
| `emit` 及 callback 调用接缝（含 `emitUserBash`） | 跟踪未结束的普通 emit/排队 UI 事件与 UI lifetime；idle cache-warming decision 及 warming 的 provider headers/payload 专用 dispatch 同样有整段 activity try/finally。action UI 事件按 owner token 识别；普通 extension handler 不继承 action ALS；bash 整体输入计数由 mode barrier 保持 |
| `agent-session.ts / _emit`、`runner.ts / emitError, hasUI` | 普通 SDK subscriber/error listener 调用时只退出宿主 action ALS，保留同步返回/异常及扩展自己的 ALS。hasUI 按 raw no-op sentinel 判断，不因 wrapper/Proxy 错报 |
| `extensions/types.ts / ExtensionRuntimeState.invokeOutsideIdleAction`、`ExtensionContextActions.invokeOutsideIdleAction` | 内部 generic hook：`<T>(run: () => T) => T`；context action 可选，runtime 有 identity 默认实现。只退出宿主自己的 action ALS，原样传递返回值/Promise/异常，不能清除扩展自己的 ALS 或作为 UI owner 证明 |
| `extensions/loader.ts / createExtensionRuntime, createExtensionAPI.events.on` | 初始化 identity hook；注册包裹后的订阅者，每次收到事件时检查原 runtime，再通过当前绑定 hook 调用原 handler。沿用原 `trackEventBusSubscription`/discard/invalidate 清理，不改 EventBus 的同步 emit 和 safeHandler 异常策略 |
| `extensions/runner.ts / bindCore, invokeOutsideIdleAction` | 将宿主 hook 绑定到原 runtime，未绑定时维持 identity；普通 Runner、快捷键及 loader EventBus 订阅回调共用这一最小隔离接缝，不新增订阅调度器 |
| `extensions/types.ts, extensions/index.ts, src/index.ts` | 公开上述类型，内部可选 context actions；不修改批准 wire 或 NativeAnswer |
| `docs/extensions.md` | 清楚区分 before-settle、notification-only settled、事件外 idle action 和 logical-start；普通事件不能返回新继续权利 |
| 新 `test/suite/agent-session-idle-actions.test.ts` | 原 harness/faux-provider 下验证 controller、会话、pending/取消、EventBus 输入和 logical-start，作为首个 RED 及核心回归 |
| 新 `test/interactive-mode-idle-actions.test.ts`、`test/rpc-idle-actions.test.ts` | 通过真实 mode 入口验证快捷键和整段 bash 拦截（full-result/operations）；不以直接调用新 helper 的测试冒充 mode 接线通过 |
| `test/extensions-runner.test.ts` | 校验 callback hook 的绑定前 identity、返回值/异常/扩展 ALS、普通/leased UI 和失效/订阅清理；既有对话框堆叠测试保持 |

内部使用 Node AsyncLocalStorage 仅识别“action callback 误调用旧输入”的自等待，不用 ALS 认定 UI 所有权；UI 所有权由 lease.context 的私有 token 明确标记，避免旁观事件 handler 继承 async context 而被误当成自己的 UI。

具体约束：

- Runner 统一 callback 调用 helper 在宿主 action ALS 外执行普通 extension handler（包括 dedicated emit 方法的 handler）；generic emit 的整段 dispatch、真实 UI lifetime 和已排队 UI 事件用 activity 计数，不在两个 handler 之间误判空闲。已有 run/input/control barrier 覆盖 dedicated request/turn 路径；idle background 的观察回调若实际打开 UI，必须先经过 foreign UI 取消/cleanup hook。
- `createIdleContext` 克隆原 guarded getter descriptors，仅覆盖 signal 与 ui；SessionManager、mode、来源和 API stale 检查仍相同。leased UI 由 raw UI 生成带 token 的 wrapper，不能再经过无 owner wrapper 而取消自己。普通 handler 获得原 context，不能继承 leased UI 权力。普通和 leased UI 的交互方法也在调用时检查原 runner/lease，不能只依赖取 `ctx.ui` 时的一次 getter 检查。
- 快捷键不再另取 raw `createExtensionUIContext()`；使用 `bindCurrentSessionExtensions` 已绑定的 runner context，因此保留现有 TUI mode、`abortHandler` 的队列回编辑器行为、shutdown 和 compact 绑定。旧 runner 创建的 context/API/UI 在 reload/replacement 后不能借当前 `this.session` 重新取得权力。延迟快捷键后来打开 UI 仍是 foreign，必须取消并等待原 owned UI 实际关闭；不改无 H0 action 时旧 raw 对话框的合法堆叠行为。
- EventBus 的 loader 包装只退出宿主 action ALS，不对发布者或扩展自己使用的 ALS 做 `disable`/全局退出。加载中尚未 bindCore 的订阅行为保持原样；绑定后在每次调用时读取原 runtime hook，不在订阅注册时冻结 identity。action 内 emit → 普通订阅者旧输入必须进入 external cancel/join；action 本身直接调用旧输入仍 fail-fast。订阅者后来打开 UI 仍只获得原普通 context，无 owned token。
- private activity 变化会同步使正在交互/验证的 action 失效；pending action 则等待 barrier 退出。自己 UI 的事件用同 token 计数；别的 UI 在打开前取消并等待旧 callback cleanup。dispatch 还必须确认自己的实际 UI lifetime 已关闭，不能因 lease.isCurrent 忽略自己的 UI 就边问边派发。
- run callback 属于受信任扩展，必须使用 lease.context/signal 并在取消后关闭 UI、退出 finally；宿主不强杀任意 JS。B 的原 questionView 已有 abort→dispose→done/join 路径，必须用原生场景验证。若 callback 不合作，槽位保持关闭而不是假称完成或开第二问题；过期 lease 无论如何不能派发。
- 外部输入只在 action 尚处于 UI/validate、未 logical-start 时等待其 cleanup。logical-start 已确认后不再等待旧 callback 才按原队列处理输入；lease 不可再开 UI 或做第二次派发。callback 自己调用旧输入 API 时 fail-fast，普通 handler 经 ALS 隔离不会被误判为自己。
- bash 外层 barrier 在 `emitUserBash` **之前**登记，直到 full-result `recordBashResult` 或 operations/默认 `executeBash` 以及 mode 清理全部结束才退出，不能在 dedicated handler 返回和结果写入之间 pump。两种 mode 在入口捕获同一个 origin Session 供 barrier、拦截、执行和记录使用，不能把 barrier 挂在旧 Session 却通过可变的 mode.session 向新 Session 写入。嵌套 `executeBash` 的输入计数成对退出，不等待自己。更早拦截等待时新 action 保持 pending；active UI/validate 时新 bash 同步取消并等待 cleanup。直接 SDK `recordBashResult` 是同步入口：先失效 token/input epoch 再原样写入，不能 await，但槽位仍等原 action cleanup，陈旧 validate 永不恢复。

## 5. 关键时序与失败次序

### 5.1 呈现与取消

1. request 捕获当前 Session、runner/source epoch、branch anchor、输入代际及 binding；只保留单槽，不立刻跨 barrier 执行。
2. 原生明确生命周期退出点和输入方法 finally 调用 pump；不加 timer、轮询或 microtask 猜“idle”。同名 UI 事件原有 microtask 传送须计入 host activity，不能当作已完成。
3. phase idle、完整 pending=0、无 foreign UI/emit/native control，且原源当前时才进入 run。回调用 lease.context，不借旧 agent.signal 或命令上下文。
4. 任一新输入/abort/clear/树导航/会话或模式失效取消 token；signal 贯穿 NativeAnswer 原路径。已关闭 UI、等待 validate 时同样可取消。
5. 外部输入在 UI/校验阶段取消并等待 callback cleanup；async validate 自身即使迟迟不返回，取消应让 dispatch 立即返回 cancelled，晚到 true 不再生效。callback 自己误用旧输入则明确失败，不加入循环等待。
6. 原始来源不明、UI 正在别处处理或更早 deferred 尚在途，均不能凭旧 isIdle/pending 去呈现或保存。

### 5.2 实际交付定义

这里的 **run 开始点** 为 `AgentSession._startRun` 同步设置 `_isAgentRunActive=true` 的 logical-start；它包括 compaction/before_agent_start 准备，不是更晚的第一个 provider 调用或 kernel agent_start。原宿主文档已把这段计为 busy。

- dispatch 先冻结 payload，再 await 只读 validate；等待可被取消。
- validate=true 后同步复核 token、binding/source、完整 pending 和原 domain 资格；没有 await 地进入 `_startRun` 并设置 busy，然后同步确认本次 runId/消费交付、发 `idle_action_started`。JS 事件不能插入检查与设置 busy 之间。
- result.started 可先于 provider 请求；此后到来的新输入/abort 遵循原“启动中/运行中”的队列与取消语义，不再被描述为“尚未交付”。真实开始后任何错误都不能把这次启动改成未发生并重试。
- 原 RPC onStarted 回调原位置保留；H0 的 logical-start 确认是单独 private 参数，不能移动旧回调来改变含义。
- 若准备在 kernel agent_start 之前失败，H0 路径仍须有失败/settlement 通知供原 Supervisor held 处理，不能保存了 Start 后永远没有交接结果。old 非 H0 路径不顺便重写。logical-start 的 ACK/event 在第一条 busy 状态写入后、任何 emit/await 前确认；不能把 RPC 原 onStarted 或 kernel agent_start 当成这个 ACK。
- 未取得 native logical-start 确认但后端异常的结果保守为 unknown，不自动重试。已确认 started 后 callback 抛错不降为“可再派发”。

### 5.3 与业务记录的分工

NativeAnswer/Start/定义/scope/恢复仍先走原控制核心和物理见证。已合法保存 Start，但 H0 在 logical-start 前取消：保留原记录、清楚显示未派发或待核，并进入原 hold；不再收取 Start或自动补派。H0 不把 UI lease/result 序列化成批准，不刷新任何原预算，也不直接采用 scope。

## 6. 首个哨兵与验证分配

宿主新 `test/suite/agent-session-idle-actions.test.ts` 复用原 suite/harness 和 faux provider，不复制宿主、不用真实模型。

首个 RED：第一个 settled handler 请求 action，后一个 handler 被栅栏挂住并登记更早 prompt；action 在整个事件退出前不进入 run，事件退出后也不能越过该新输入。源码缺 API 的 RED 只算功能未实现，不假称已复现某业务会话历史。

实现后依次覆盖：

- 事件外实际状态/无自等待；metadata-only action 0 provider 调用。
- 普通/owned UI activity 与第二个问题互斥；旧 action context不能在取消后打开新 UI；自己的原文核对/最终 select 正常。
- 真实快捷键拿到同源 guarded context 的 `idleActions`；延迟快捷键 UI 在 action 中打开时，先取消并等待旧 UI cleanup，不能同时存在两个问题。reload/replacement 后旧快捷键 context 及已取出的 UI 方法失败关闭；原 TUI abort/compact 绑定不回退。
- 两种 bash 拦截返回（full-result 和 operations）用栅栏证明整段 mode 输入阻止 action；UI/validate 中提交 bash 会及时取消，释放栅栏后旧 dispatch 为零、原 bash 结果只记录一次；直接 `recordBashResult` 仍返回 void 并先取消。
- action 内 EventBus emit 后，普通订阅者调用旧输入走 external cancel/join，非 self-call 拒绝；action 直接调用旧输入仍 fail-fast。订阅者自己的 ALS 值保持，UI 为 foreign，未绑定 runtime 的订阅、unsubscribe/discard/invalidate 行为不变。
- queued/deferred/in-flight/context-only/native control 可见性；更早输入优先。
- UI 中新 prompt/custom/steer、后续 settled handler 取消、async validate 中输入/abort/变更、校验晚到 true：0 陈旧 run。
- 同 id+binding 重复、冲突 binding、同 lease 二次 dispatch、capacity、reload/tree/dispose 后旧 handle：0 重复 run。
- 一次明确派发的 logical-start 事件与 receipt 同 actionId/runId/Session；provider 完成与 delivery 分开；准备失败/回调异常不能变回可重试。
- 新输入在 logical-start 之后仍按原队列/abort 行为处理，不丢失、不被误当第二次 delivery。

命令：从 coding-agent package 用根 node_modules/vitest 的 CLI 跑具体文件；先一个哨兵，再该新文件，再现有 concurrent、queue、boundaries、runtime、retry、compaction、tree、extensions-runner、interactive-dialogs 等受影响文件。禁止直接跑可能使用真实凭据的全 vitest；如需全 monorepo 测试使用原 `./test.sh` 的清洁环境。

宿主代码后必须 `npm run check`（根规则要求完整输出，不 tail）；其含 formatter，因此先复核写集，不覆盖外来改动。构建用原 offline pipeline，已先完成 telemetry 单臂 smoke。deps/scripts/模型目录不新增假数据或降门。

## 7. 原生交付与 B 的接入门

- H0 单测/静态/构建通过后，还要隔离真实 CLI/PTY 的事件外 UI、竞争/取消和派发证据；SDK 模拟不能代替它。
- 新宿主和扩展只在临时验证副本配对。通过原模块解析让 trustedCliRoots 指向真正执行的隔离宿主包；不加 env/argv/TTY/NativeAnswer 信任绕过，不替换当前仓库 peer 或已安装 Pi。
- Extension B 的 callbacks 显式绑定原 ALS runtime，使用 lease.context，control保存后只合法更新自己预期的原记录引用；最后 dispatch.validate 再查原 owner/hold/权限/能力/预算/执行结算。禁止改写原控制对象来“使检查通过”。
- H0 设计审阅通过且 H0 原生资格接受前，不在扩展启用 B。旧宿主仍只有 A，不更改实际会话的 loaded revision 声明。

## 8. 设计审阅门

请独立审阅 API/所有权、输入/cleanup 自等待、logical-start 定义、UI事件 activity、bounded 幂等及原控制语义，并定向复核 §9 三项接缝。确认本 packet 足以让单写者实现，无 material blocker 才标 READY；本文件、用户范围批准和一次 smoke 都不等于 H0 已实现或可直接派发业务。

## 9. 首轮设计意见与 v2 处置

本节记录 v2 设计修订当时的核查：Main 已只读复核全部三项源码 trace 并同意原始意见，当时只改文档，未实施宿主 API，也未重跑已通过的基线构建。之后的候选状态见 §10。

| 首轮发现 | 已核实来源（固定宿主源码） | v2 修订及验证归属 |
| --- | --- | --- |
| P1 快捷键绕过 Runner/context/UI | `interactive-mode.ts:2243–2289` 自建 raw context；`bindCurrentSessionExtensions` 已提供相同 mode/abort/compact 绑定 | §4 纳入 `setupExtensionShortcuts`，统一 guarded context/普通 wrapped UI；§6 要求真实快捷键、延迟 foreign UI 和 stale context 哨兵 |
| P1 user_bash 拦截等待及 full-result 记录无整体 barrier | TUI `handleBashCommand`；RPC bash 分支；`emitUserBash` dedicated await；`recordBashResult` 同步写上下文 | §4 增加 `withUserBashInput` 整段 mode barrier 与同步记录失效；§6 覆盖两种拦截返回、UI/validate 取消和一次记录 |
| P1 EventBus 订阅继承 action ALS | loader 的 `events.on` 直连 EventBus；EventBus safeHandler 同步进入原 handler | §4 增加 runtime/contextActions generic hook、bindCore 和 loader 订阅包装；§6 区分外部输入与 self-call，保留扩展 ALS 及订阅清理 |

**设计状态：READY。** [v2 定向独立复审](supervisor-human-interaction-h0-design-review-v2.md)确认三项 CLOSED、无新增 material blocker，Main 核实后接受设计门。单写者 Main 随后在已授权隔离宿主进入 RED/GREEN 实施；H0 实现/资格与 B 仍未接受。设计报告只读且未重跑基线，不当作实现验证。

## 10. 实施候选状态

[候选验证记录](supervisor-human-interaction-h0-validation.md)列出 13 文件写集、49 项新增测试、20 文件/308 项相关回归、根检查、离线构建及两种真实 Node CLI 的原生竞争/取消/交付工件。[首轮实现审阅](supervisor-human-interaction-h0-implementation-review.md)为 BLOCK，报告原样保留；四项修正及 14 个 RED/GREEN 见验证记录 §7。[R2 复审](supervisor-human-interaction-h0-implementation-review-followup.md)确认四项 CLOSED / OK；Main 审计确认相同指纹并重跑 16 项相关测试后接受本隔离 H0 候选。B 进入独立实施约束准备，尚未接入。旧安装和业务会话未变。

R2 将 UI 资格明确为本机 TUI：metadata action 可在其他模式使用，但 RPC 没有 dialog-close ACK，不能将本地 Promise 结束当客户端 UI 已关闭，因此在 raw RPC UI 调用前拒绝 leased blocking UI；普通 RPC UI/bash 及 hasUI 原义保留。不新增可信前端或批准协议。

已沿 SDK/cache-warmer 的实际 idle 调用核实 warming decision、headers、payload 的专用 await 路径，补齐整段 activity，不以“通常在 run 内”代替证明。普通 Session/error observer 的隔离不授予 leased owner token，也不丢弃其竞争输入。
