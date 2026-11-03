# H0 R2 定向独立实现复审

## Review

**H0 local candidate verdict: OK。**

同意 R2 对首轮四项 P1 的处置：当前源码与新增回归均已闭合，未发现修正引入新的 material blocker。此结论仅针对隔离宿主 H0 候选，不接受 B 或整体 Goal。

### 审阅对象

- 已先读 `AGENTS.md`，并读取首轮 BLOCK、R2 validation、implementation packet。
- 审阅实际工作树的 **13 个候选文件**，包括四个 untracked 文件，不以 HEAD 代替候选。
- 清单：`/tmp/pi-human-interaction-h0-candidate-20261102-r2.json`
- R2 候选指纹：`066b21cda79bd3ea2a12840243c428bfb525c1c21fc8f3442d5d281f400434a1`
- 九源文件指纹：`db154401d52c563420fc1fd09dc9ac1f5878f0619653432c6346521b7e96913c`

以下路径相对于 `packages/coding-agent/`。

## 四项 P1 闭合

### 1. RPC leased UI：CLOSED

**Correct：** `src/core/extensions/runner.ts:634–639` 在有 owner 且非 TUI、或 raw UI 为 no-op 时同步抛错，位置早于 activity 登记、UI 事件和 raw UI 调用。

五种 blocking UI 都经过此入口（`:598–610`）；普通 UI 没有 owner，不受新增限制。H0 API 绑定仍保留在 `src/core/agent-session.ts:3653`，没有一并删除 metadata-only 能力。

**测试：** `test/rpc-idle-actions.test.ts:58–111` 对 select、confirm、input、editor、custom 分别断言：
- leased 调用不产生 outbound UI request；
- 未处理异常得到 `failed/callback_error`；
- 随后的普通 RPC select 仍可收到并返回回答，`hasUI` 仍为 true。

`docs/extensions.md:338` 明确限定 leased blocking UI，并区分普通 RPC `hasUI`。守卫不承担 NativeAnswer 或可信本机 TUI 身份认证；没有新增 TTY、argv、环境变量绕过。

### 2. 普通 observer 的宿主 ALS 隔离：CLOSED

**Correct：**
- Session subscriber：`src/core/agent-session.ts:1086–1090` 逐个通过本 controller 的 `outside()` 调用。
- Runner error listener：`src/core/extensions/runner.ts:814–818` 通过绑定的 `invokeOutsideIdleAction` 调用。
- 实际绑定：`src/core/agent-session.ts:3654`。
- `src/core/idle-actions.ts:71–80` 只退出本 controller 的 ALS；没有清除扩展自身 ALS，也没有新增 await、吞异常或异步调度。

**最短 trace 已闭合：** action 保存 metadata → 普通 observer 发输入 → 输入被识别为外部竞争 → 同步取消旧 action → 等其 cleanup → 处理输入，而非 self-send 拒绝。

**测试：** `test/suite/agent-session-idle-actions.test.ts:47–128` 覆盖两种 observer，检查取消、cleanup、扩展 ALS 保留及恰好一条用户消息；明确等待实际 `agent_settled`。直接 action self-send 仍在 `:892–933` 断言 fail-fast。

同步异常仍直接向原调用栈传播；logical-start observer 抛错的既有候选回归在 `:336–378` 保留。

### 3. idle warming 专用 dispatch 的整段 activity：CLOSED

**Correct：** `src/core/extensions/runner.ts:1205–1212` 的共享 helper 用整段 `try/finally` 包住 dispatch；generic emit、decision、payload、headers 分别在 `:1215`、`:1250`、`:1494`、`:1529` 使用。不是逐 handler 计数，没有两个 handler 之间的空窗。

已独立核对实际调用图：

- `src/core/cache-warmer.ts:300–317` await decision，经 `src/core/sdk.ts:334–338` 到 runner。
- refresh 在 `cache-warmer.ts:333–339` 保留原 request options。
- headers 经 SDK `:353–355`，由 `src/core/model-runtime.ts:690` await。
- payload 经 SDK `:374–377,424`；agent options 在 `packages/agent/src/agent.ts:482–484` 保留这些 hooks。
- response/stream 回调经 SDK `:379–401` 使用已有 generic emit，同样受整段 activity 保护。

`src/core/idle-actions.ts:96–112` 对 foreign activity 同步取消 running action，但不等待 callback；cleanup 只等待 owned UI（`:291–310`），没有引入自等待。

**测试：** `test/suite/agent-session-idle-actions.test.ts:130–231` 的六例分别覆盖三种 dispatch：
- 首 handler 申请、后 handler 栅栏阻塞时，callback 零进入；
- 全部退出后才进入；
- 遇到 active action 立即取消，dispatch 与 cleanup 均能结束。

### 4. 无 UI 模式 `hasUI`：CLOSED

**Correct：** `src/core/extensions/runner.ts:693–695` 直接判断 raw sentinel，guarded Proxy 仍保留在 `:592–625`，未通过撤销保护修复布尔值。

真实构造路径为：

`AgentSession` 构造（`:568`）→ `_buildRuntime`（`:3868`）→ `_applyExtensionBindings`（`:3550–3552`）→ `setUIContext(undefined)`。

**测试：** `test/suite/agent-session-idle-actions.test.ts:32–45` 从真实 harness Session 构造开始，覆盖初始无 UI、显式 undefined，以及 TUI/RPC 设置真实 context 后再清除。不是仅测未绑定的裸 runner。

## 连带回归核查

- **Owner/token 与取消：** leased context 仍由 raw UI 加私有 owner 创建（`runner.ts:1034–1054`）；普通 handler 经 `snapshotHandlers` 隔离（`:1062–1072`），不会因 ALS 获得 owner。缓存 UI 方法仍在调用时检查 stale。
- **唯一交付：** `idle-actions.ts:315–369` 保留 one-shot、可取消 validate、最终资格复核；`agent-session.ts:1960–1971` 仍先写 busy、同步 ACK，再发观察事件或 await。
- **旧模式接线：** TUI shortcut 仍使用原 runner 的 guarded context（`interactive-mode.ts:2242–2263`）；TUI/RPC bash 整段 barrier 仍绑定 origin Session（`:6927–7020`；`rpc-mode.ts:561–588`）。
- **其他 callback 接缝：** loader EventBus 保留调用时读取隔离 hook 和原订阅清理（`extensions/loader.ts:524–536`）。其余专用 runner dispatch 的实际调用点已核对，未以“通常在 run 内”替代 warming 路径证据。
- **Fixed：** 本复审未修改任何文件。

## MUST_FIX

No issues found.

## 已有验证证据

本轮只读核查，未重跑测试、check 或构建。

- 三个新增测试文件静态展开为 **49 例**，其中本轮对应四项修正为 **14 例**。RED 历史来自 validation §7；本轮没有重新制造 RED。
- 已读最终定向日志：**20 文件 / 308 tests PASS**。
- 已读完整根 check、offline build 日志，无失败输出。
- 已读两种 Node CLI 的 R2 `verified.json`、实际 session/events，并抽查 pane 文本：各 **1 started、4 cancelled、1 条 H0 delivery**；其余四个 run 对应明确注入的竞争及更早输入。
- 两份原生报告的九源文件哈希、源集合指纹与 R2 清单一致；抽查 unbundled runner 编译接缝与源码一致。**本轮未独立重算全部源码、dist 或保护文件哈希**，该部分依赖已有 Main 审计结果，不冒称本轮执行。

## NOTE / GAP / BASELINE

- **BASELINE：** RPC 缺 dialog-close ACK 未被修复；本轮通过禁止 leased blocking UI 关闭新增 H0 违反路径，不要求新增可信 RPC 前端。
- **GAP：** 未验证 Bun、RPC 客户端实际关闭或 B；warming 新回归直接测试 runner dispatch，实际 SDK/cache-warmer 接线由源码调用图核对。
- **NOTE：** H0 lease、started 收据及合成按键均不构成业务批准。B 仍未启用，必须先独立冻结原控制接入。

**Merge verdict: OK，仅限本次 H0 local candidate。整体 Goal 未完成。**