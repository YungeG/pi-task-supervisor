## Review

**结论：BLOCK。发现 3 项 P1 接缝遗漏；先修订 packet，再进入宿主实现。** 不是因当前源码尚无新 API 而阻断。

以下 packet 指 `supervisor-human-interaction-h0-implementation-packet.md`。

### Correct

- **取消与交付次序基本自洽。** packet §4、§5.1 明确区分 callback 自调用旧输入的 fail-fast、普通外部输入的 cancel/join，以及 async validate 取消后立即返回；未发现这些已冻结次序本身必然形成循环等待。
- **logical-start 接缝选取正确。** 当前 `agent-session.ts:1867–1915` 已先设置 busy，再准备消息，之后才调用原 `onStarted` 和 kernel prompt。packet §5.2 保留这三个不同时间点，并要求准备失败通知、started 不降级重试，能够避免把启动中输入误作未交付。
- **队列及原控制边界有明确约束。** packet §4 已包含 deferred splice 后在途计数、完整 pending、owned UI 实际关闭检查；§5.3 保留已保存 Start、原 hold 和预算，不重新批准或自动补派。

### Finding：P1 — 快捷键上下文绕过新 API 和 foreign UI 接缝

**条款：** packet §4 要求普通 UI 在打开前取消并加入旧 action；路线图 §4.3 要求 B 快捷入口获得 H0 action。

**源码：**
- `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2243–2289` 自行创建快捷键 context，没有经过 `ExtensionRunner.createContext()`，其 UI 来自 raw `createExtensionUIContext()`。
- `interactive-mode.ts:2633–2658` 的 raw UI 直接打开对话框；Runner 的包装只在 `extensions/runner.ts:572–588` 安装。
- 现有对话框会堆叠而非拒绝第二问题，见 `interactive-mode.ts:2693–2714`；对应行为由 `test/interactive-mode-extension-dialogs.test.ts:66–86` 固定。

**竞争 trace：** 一个异步快捷键 handler 尚未打开 UI；随后 run settled，H0 打开 owned UI；前一个 handler 恢复并通过 raw context 打开 foreign UI。它不经过取消、cleanup 或 activity hook，两个问题同时存活。快捷入口本身也拿不到拟新增的 `ctx.idleActions`。

**最小修订：** 将 `setupExtensionShortcuts` 纳入写集，使用当前 runner 的 guarded 普通 context及包装 UI，保留现有 mode 绑定行为；不要给快捷键 leased owner token。

**验证条件：** 真实快捷键 context 可申请 H0；延迟快捷键 UI 必须先取消并等待旧 action cleanup，不能堆叠；旧快捷键 context 在 reload/replacement 后失效。

### Finding：P1 — `user_bash` 拦截阶段不在所列输入 barrier 内

**条款：** 路线图 §5.2.1–2、packet §4/§5.1 要求更早输入操作未结束时不能进入 action，且新输入应同步使 active action 失效。

**源码：**
- `extensions/runner.ts:1269–1298` 的 dedicated `emitUserBash()` 会等待 handler，不经过 generic `emit()`。
- TUI 在 `interactive-mode.ts:6960–6971` 先等待该事件；full-result 分支直接调用 `recordBashResult()`，见 `7001–7005`。
- RPC 同样如此，见 `modes/rpc/rpc-mode.ts:561–580`。
- `agent-session.ts:3939–3962` 的 `recordBashResult()` 可直接修改上下文；packet 写集只列 `executeBash`，未覆盖这个入口及前面的拦截等待。

**竞争 trace：** run 进行中用户提交 `!`；`user_bash` handler 被栅栏挂住。run 随后 settled 并请求 action；所列 run/input/generic-emit barrier 均退出，但更早的 bash 输入仍在等待，H0 可以提前呈现。handler 后来返回完整结果时又绕过 `executeBash` 写入上下文。

**最小修订：** 冻结覆盖两个 mode 中整个 bash 输入操作的宿主 barrier——从 `emitUserBash` 前直到执行或结果记录结束；补列 `recordBashResult` 的同步失效接缝，保持其原返回类型。仅给 dedicated emit 增加结束计数仍不足以覆盖后续结果记录。

**验证条件：** 阻塞的 full-result 与 operations 两条拦截路径均阻止 action 进入；active UI/validate 中提交 bash 会及时取消；释放栅栏后无陈旧派发，原 bash 结果仍只记录一次。

### Finding：P1 — EventBus 旁观 handler 仍继承 action 的宿主 ALS

**条款：** packet §4 明确要求普通 extension handler 在 action ALS 外执行，避免把旁观插件输入误判为 action 自调用。

**源码：**
- `extensions/loader.ts:519–528` 将 `pi.events.emit/on` 直接连接 EventBus。
- `core/event-bus.ts:13–23` 通过 `EventEmitter.emit()` 同步进入订阅 handler，没有 Runner callback helper。
- 因此，仅修改 packet 所列 Runner handler 调用点不能覆盖这些普通扩展订阅者。

**具体 trace：** action callback 调用合法的 `pi.events.emit()`；另一扩展的订阅 handler 调用原 `pi.sendUserMessage()`。该 handler 继承 action ALS，新 fail-fast guard 会把它误判为 action 自己绕过 dispatch，丢弃本应作为竞争输入处理的旧 API 调用。

**最小修订：** 将 loader 的 EventBus callback 接缝纳入写集，通过宿主绑定的最小隔离 hook 调用订阅者；保持扩展自身 ALS、订阅清理及未绑定 runtime 行为，不新增调度框架。

**验证条件：** action 内 emit 后，普通订阅者的旧输入走外部 cancel/join 路径，不被当作自调用；action 真正直接调用旧输入仍 fail-fast；旁观者 UI 仍为 foreign。

### Fixed

无。本轮只读。

### NOTE / BASELINE

- 已完整读取根规则、packet、路线图、实际调查文件 `supervisor-human-interaction-host-discovery.md`、主要源码及指定测试。
- 工作树检查无变化。未运行测试、构建、安装或业务会话；这属于本轮明确限制，不是验收缺陷。
- 提供的并发 smoke／离线构建通过仅是基线证据，不证明 H0 能力成立。
- 上述发现针对新增 H0 契约的接缝覆盖，不要求改写旧宿主全部 UI 或业务授权框架。

**Merge verdict：BLOCK。**

**Design verdict: BLOCK**