# H0 实现与证据独立审阅

## Review

**H0 local candidate verdict: BLOCK。** 当前候选有 4 项需修正的问题；已有本机 TUI 证据有效，但不足以接受整个公开 H0 契约。

审阅对象为实际工作树：9 个 tracked 变更和 4 个 untracked 新文件，不以 HEAD 代替候选。清单指纹为 `aa171bef5ee533815a37507f3d7165d3dab5cbad7cb2b190dd5020e2bf3aecf5`。

以下源码路径相对于 `packages/coding-agent/`。发现均有源码 trace；本轮未执行复现测试。

## Correct

- **取消、幂等及唯一交付主体正确。** `src/core/idle-actions.ts:137–180,209–240,312–387` 实现单槽、4096 条无驱逐记录、literal true、重入取消后的复核、可取消校验及一次 dispatch。
- **实际 owned UI 关闭受到等待。** `idle-actions.ts:291–310` 不因 callback 返回就释放尚有 UI 的槽位；`extensions/runner.ts:627–682` 覆盖实际调用及排队 UI 事件。
- **主要输入接线正确。** `agent-session.ts:1125–1189` 覆盖输入操作及 splice 后 deferred 在途计数；TUI `interactive-mode.ts:6927–7020`、RPC `rpc-mode.ts:561–588` 将整段 bash 输入绑定 origin Session。
- **logical-start 与 provider 成功已分开。** `agent-session.ts:1961–2032` 在 busy 写入后同步 ACK，保留 started，并为 H0 准备失败提供 settlement。
- 快捷键使用原 runner 的 guarded context；loader EventBus 订阅调用时退出宿主 ALS，未清除扩展自身 ALS。

## MUST_FIX

### Finding 1 — P1：RPC 对话未实际关闭，H0 却可释放槽位

**权威依据：** packet §4、§5.1 要求实际 UI lifetime 关闭后才能释放；本轮仅本机 TUI 获得原生资格。公开文档 `docs/extensions.md:336,365` 没有限定此前端能力。

**源码证据：**

- `agent-session.ts:3653` 无条件绑定 H0 API。
- `extensions/runner.ts:1029–1049` 为当前 raw UI 创建 leased wrapper，没有 RPC 限制。
- `rpc-mode.ts:91–130` 的 abort 只删除 pending 并 resolve 本地 Promise，不发送关闭请求。
- `rpc-types.ts:252–287` 的 outbound union 没有撤销/关闭对话协议。
- Runner 在 Promise 结束后结束 UI activity：`runner.ts:651–668`。

**最短 trace：**

RPC action 调用 `lease.context.ui.select(...,{signal:lease.signal})` → 客户端显示问题 A → 新 prompt 或 foreign UI 取消 action → RPC 本地 Promise 立即结束 → callback cleanup、槽位释放 → 输入继续或问题 B 发出；客户端没有收到关闭 A 的指令，A 可以仍然存在。

**影响：** 新通用 API 将“本地等待结束”误作“真实 UI 已关闭”，破坏 H0 单问题及 cleanup 契约。这不证明 RPC 能产生 Supervisor 批准，但已是宿主新 API 的真实违反路径，不能只记为缺原生证据。

**最小修正：** 当前在 RPC 上失败关闭 leased 交互 UI，或不暴露其 H0 API；文档明确当前合格前端为本机 TUI。保留普通 RPC 对话及 bash barrier，不要求本轮建设新的可信 RPC 协议。

**定向验证：** RPC mode 测试断言 H0 leased 对话不可用、无 UI request 发出；普通 RPC 对话和 bash interception 保持原行为。

### Finding 2 — P1：AgentSession 普通观察者仍继承 action ALS，竞争输入被丢弃

**权威依据：** packet §4 要求普通回调不被识别为 action 自调用；`docs/extensions.md:367` 明确普通 observers 在宿主 action marker 外执行。

**源码证据：**

- callback 在 action ALS 中执行：`idle-actions.ts:256–282`。
- action 可正常调用 `pi.appendEntry()`：`agent-session.ts:3622–3627`。
- 该入口同步 `_emit(entry_appended)`；`agent-session.ts:1086–1089` 直接执行普通 subscriber，没有 ALS 隔离。
- subscriber 的 `pi.sendUserMessage()` 随后命中 `agent-session.ts:3613`、`idle-actions.ts:75–80` 的 self-call 拒绝。

**最短 trace：**

普通 SDK subscriber 在 `entry_appended` 时调用 `pi.sendUserMessage("competing input")` → action 保存元数据调用 `pi.appendEntry()` → subscriber 继承 action marker → 输入抛错，action 被标记 `callback_error`，该输入从未登记。

**影响：** 合法普通观察者的竞争输入丢失，并误报 action 自调用；现有 EventBus 隔离测试不覆盖此接缝。

**最小修正：** `_emit` 调用普通 subscriber 时退出本 controller 的 ALS，保留原同步返回和异常语义；同类直接 listener 接缝应采用同一隔离原则。

**定向验证：** 在 `agent-session-idle-actions.test.ts` 增加上述 subscriber trace：输入应取消并 join action，然后实际处理一次；action 直接调用旧发送接口仍须 fail-fast，扩展自身 ALS 保持。

### Finding 3 — P1：idle cache-warming 专用事件没有整段 activity barrier

**权威依据：** packet §5.1 要求相关事件退出后才进入 action；`types.ts:389–391` 和 `docs/extensions.md:336` 宣称 awaited lifecycle handler 外的资格。

**源码证据：**

- generic `emit()` 有 activity：`runner.ts:1200–1207`。
- `emitCacheWarmingDecision()` 只隔离 handler ALS，没有 activity：`runner.ts:1241–1262`。
- 这不是不可达的内部方法：`sdk.ts:333–339` 将它接到 CacheWarmer；`cache-warmer.ts:298–317` 在实际 idle refresh 中 await 此事件。
- `IdleActionController.request()` 同步 pump：`idle-actions.ts:179–180`。

**最短 trace：**

idle refresh → 第一个 `cache_warming_decision` handler 请求 action、不等待 result → request 同步进入 callback → 后续 handler 此时尚未执行，或仍在等待栅栏。

即使所有 handler 遵守“不 await handle.result”，仍可在事件未退出时呈现新问题。

**影响：** 专用 idle 事件绕过事件外资格。类似 provider 专用 hooks 也不能仅凭“通常在 run 内”推定已有 barrier；cache warmer 会在 idle 发起 provider 请求。

**最小修正：** 对实际可在 idle 执行的专用 awaited dispatch 增加整段 activity 的 try/finally，至少覆盖 cache-warming decision，并核对 warming 路径的 provider headers/payload hooks；不要只按单个 handler 计数而留下间隙。

**定向验证：** 第一 handler 请求、后一 handler 用栅栏阻塞：释放前 callback 零进入；全部返回后才进入。再验证 active action 遇到该事件时取消且不自等待。

### Finding 4 — P1：无 UI 模式的旧 `hasUI` 行为发生回归

**权威依据：** packet §4 要求旧普通接口行为保持；`docs/extensions.md:400–403` 明确 JSON/print 无 UI，调用方可用 `ctx.hasUI` 判断。

**源码证据：**

- `runner.ts:592–595` 现在对缺省 `noOpUIContext` 也创建 wrapper/Proxy。
- `runner.ts:688–690` 仍按 `this.uiContext !== noOpUIContext` 判断，结果变为 true。
- 真实 Session 构造必经 `_buildRuntime → _applyExtensionBindings → setUIContext(undefined)`：`agent-session.ts:568,3550–3552,3868`。
- 既有 `extensions-runner.test.ts:557–565` 只测试未调用 `setUIContext` 的裸 runner，因而没有覆盖回归。

**最短 trace：**

构造无 UI 的 AgentSession → `createContext().hasUI === true`，但 `ui.select()` 仍只返回 undefined。

**影响：** 旧扩展会跳过其非交互 fallback，误把无 UI 环境当成交互可用；与是否使用 H0 无关。

**最小修正：** `hasUI()` 根据 raw UI 是否为 no-op 判断，或保留无 UI sentinel 身份，不撤销真实 UI 的 guarded wrapper。

**定向验证：** 增加 `setUIContext(undefined)`、真实无 UI AgentSession、UI 设置后清除三种断言；RPC/TUI 提供真实 context 时仍为 true。

## 证据与范围

- **已查：** 完整 AGENTS、三份指定 H0 文档、相关路线图；controller、runner、会话及模式连接代码、新增三份测试、类型/exports/docs，以及 cache-warmer、SDK、EventBus 和 RPC UI 协议接缝。
- **证据一致：** 已读三个最终日志，分别记录 19 文件/285 项 PASS、根 check 完成、offline build 完成。两份 native report、实际 events/session 和抽查 pane captures 相符：各 1 started、4 cancelled、1 条 H0 delivery；另外 4 个模型 run 对应明确注入的竞争/更早输入。
- 清单与两份 native report 的九源文件哈希及源集合指纹一致；本轮没有重新计算全部文件哈希。两次工作树摘要一致。
- **BASELINE：** RPC 缺关闭 wire 是原有事实；本次新增 H0 在该前端将本地 Promise 当真实 lifetime，才构成本次 Finding 1。未重新审 A。
- **GAP：** 未验证 Bun、RPC 客户端真实关闭、B 或业务流程。TUI 证据不扩展到这些范围。
- **Fixed：无。** 本轮只读，未修改、安装、构建、运行测试、联网、重载或操作业务会话。

**Merge verdict: BLOCK。** 修正上述接缝并完成对应定向验证后，再由 Main 接受 H0；本结果不代表 B 接受或整个 Goal 完成。