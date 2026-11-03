# H0 packet v2 定向独立设计复审

## Review

**Design verdict: READY**

同意 v2 对首轮三项 P1 的修订：三项均在**设计层 CLOSED**。结合固定宿主源码，未发现仍阻止单写者实施的 material blocker。

审阅对象为任务指定的 packet v2、原始 BLOCK 报告、host discovery，以及路线图相关要求；源码基线为官方 v1.4.0 commit `4a080252f06caf63a525d7873c5d94d3c23887e0`。以下宿主路径均相对于 `packages/coding-agent/src/`。

## 三项原发现

### 1. 快捷键 raw context/UI 旁路：CLOSED

**源码依据**

- `modes/interactive/interactive-mode.ts:2243–2289` 当前手工创建快捷键 context，并直接取得 raw UI。
- 同文件 `1973–2038` 已通过 `bindExtensions` 提供 TUI mode、队列回编辑器的 abort、shutdown 等绑定。
- `core/extensions/runner.ts:884–961` 提供 guarded context；`997–1004` 已有保留 getter descriptors 的克隆范式。

**v2 闭合 trace**

按键 → 原快捷键 runner 的 `createContext()` → 普通 wrapped UI／同源 idleActions → 请求 action → handler 可等待 `handle.result`。

packet §4 明确**不把整个异步快捷键 handler 计为 activity**，因此不会形成“handler 等 result，而 action 等 handler 退出”的自等待。延迟快捷键打开 UI 时仍属 foreign，须先 cancel/join 旧 action。

v2 还明确检查已取出的 UI 方法，而不仅检查 `ctx.ui` getter，覆盖 reload/replacement 后缓存方法的失效问题；未授予快捷键 leased owner token。

### 2. `user_bash` 等待及 full-result 记录缺少整段 barrier：CLOSED

**源码依据**

- `core/extensions/runner.ts:1269–1298` 的 dedicated `emitUserBash()` 等待 handler，不经过 generic emit。
- TUI：`modes/interactive/interactive-mode.ts:6960–7049`。
- RPC：`modes/rpc/rpc-mode.ts:561–583`。
- `core/agent-session.ts:3901–3933` 执行后调用记录入口；`3939–3962` 的 `recordBashResult()` 为同步写入。

**v2 闭合 trace**

捕获 origin Session → 同步登记 `withUserBashInput`、取消旧 lease → 等待 cleanup → `emitUserBash` → full-result 记录或 operations/default 执行 → mode 清理 → finally 退出 barrier。

该范围覆盖 dedicated handler 返回与结果写入之间的空隙，不只包装 `executeBash`。两种 mode 的 barrier、拦截、执行和记录均绑定同一 origin Session，不再经可变 `mode.session` 转写新 Session。

直接 SDK `recordBashResult()` 保持 void：先同步失效 token/input epoch，再保留原记录行为；不伪造异步 join。槽位仍等待旧 callback cleanup，晚到 validate 不能恢复交付。嵌套 `executeBash` 计数成对退出、不等待自身，约束明确。

### 3. EventBus 订阅者继承宿主 action ALS：CLOSED

**源码依据**

- `core/extensions/loader.ts:519–528` 当前将订阅者直接交给 EventBus。
- `core/event-bus.ts:13–27` 同步进入 safeHandler／原 handler，emit 不等待订阅者完成。
- loader 的 runtime 失效和订阅跟踪位于 `196–215`，加载失败清理位于 `545–550`。

**v2 闭合 trace**

action 内 emit → loader 的订阅包装 → 检查原 runtime → **调用时**读取已绑定的 `invokeOutsideIdleAction` → 普通订阅者旧输入同步取消 action、随后 external join。

EventBus 不等待订阅者，因此这条 trace 不要求 action 反向等待订阅者。action 本身直接调用旧输入仍保留宿主 ALS 标记，走 fail-fast，而非等待自己。

generic hook 只退出宿主自己的 ALS，原样传递返回值、Promise 和异常；绑定前 identity、扩展自身 ALS、unsubscribe/discard/invalidate 均明确保留。它也不构成 UI owner 证明。

## 交叉核查

- **UI ownership 与 stale：Correct。** packet §4 将 owner 放在 leased UI 私有 token，而非 ALS；leased wrapper 从 raw UI 构造，避免再次穿过 foreign wrapper 而取消自己。普通 handler 不继承 leased UI 权力。
- **取消与 cleanup：Correct。** 外部输入先失效，再等待 UI/validate callback cleanup；action 自调用旧输入 fail-fast。现有 Supervisor `src/human-ui.ts:521–580` 确有 abort → dispose → done → finally 路径；宿主 custom UI 的关闭入口位于 `interactive-mode.ts:2954–2966`。这支持方案可实施，但不代替后续原生验证。
- **logical-start 原契约：Correct。** 当前 `agent-session.ts:1873–1890` 先设置 busy，再准备消息，最后调用旧 `onStarted`。packet §5.2 保留旧回调位置，另设同步 logical-start ACK/event；准备失败必须通知，已确认 started 不降级为可重试。v2 未破坏该区分。
- **事件与队列退出：Correct。** 当前 settled 在 `agent-session.ts:1078–1100` splice 后逐项执行 deferred。packet 保留剩余／在途可见性与全部回调退出条件；未用旧 isIdle、注册顺序或 microtask 猜测替代资格。

## Finding

**No issues found.**

没有需要在单写者实施前另行冻结的新 material blocker。上述 CLOSED 只表示设计遗漏已闭合，不表示源码已经修复。

## 后续验证门

packet §6 的验证分配足以进入实施，尤其必须实际覆盖：

- 真实快捷键申请 action 并等待 result；延迟 foreign UI、缓存 UI 方法失效。
- 两种 mode 的 full-result／operations 栅栏、取消、origin Session 归属和唯一记录。
- EventBus external 输入与 action self-call 区分；扩展 ALS、绑定前行为及订阅清理不变。
- owned UI 实际关闭、晚到 validate 零陈旧派发；logical-start 后输入及准备失败通知。

本轮全部只读；未修改文档或源码，未安装、构建、测试、使用网络或操作业务会话。前后工作树检查均无变化；未重跑既有基线。

**Fixed：无。**  
**Merge verdict: OK（仅 H0 设计门）。**

这不是 H0 实现接受、H0 能力资格通过或 B 接受；整体目标仍未完成。