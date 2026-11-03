Design verdict: READY

本 packet 足以约束单写者开始 B 实现，未发现需先修订设计的 blocker。Main 可按 §8 从首个 RED 推进；当前无需用户补充授权或决策。**本结论仅接受设计，不接受 B 实现或整体 Goal 完成。**

## Review

### Correct：关键接缝已闭合

1. **严格 effect adapter 可行，不需要放宽 NativeAnswer。**  
   packet §2.1、§3.1 仅转换明确的 display-only notice，其余发送抛错；阻塞 UI 仍调用真实 leased UI，身份、模式、signal、idle/pending 不替换。
   - 旧路径确实调用通知和工具 setter：`src/preflight-human.ts:859–865`、`src/supervisor.ts:282–291`、`src/scope.ts:72–76`。
   - 原答案仍由私有注册表及 frame/current/signal 检查承认：`src/human-ui.ts:203–204,1004–1070`；物理 control/witness 仍走 `src/human-control.ts:109–137`。  
   因而这是展示效果适配，不是吞业务输入、伪造答案或消除原持久化故障。

2. **延后工具投影与失败收束具备实际接入点。**  
   packet §2.1、§3.5、§6 将 `deferredTools` 限为原 Start 引用；真实当前权限、Start、owner 和模式共同决定能否投影，成功清标记，无标记时不触碰普通工具选择。
   - canonical 工具计算已有来源：`src/scope.ts:39–51`。
   - 普通 `before_agent_start` 接缝：`src/events.ts:970–991`。
   - 原 settled 先 `runs.shift()` 再来源早退：`src/events.ts:995–999`。packet 明确在早退前消费匹配准备失败，并要求 `ctx.abort()`，避免依赖 Runner 吞异常。  
   已接受 H0 的 logical-start ACK 确实早于准备/provider；准备失败有对应 settlement：宿主 `packages/coding-agent/src/core/agent-session.ts:1960–1984,2019–2027`。packet 没有把 started 降成可重试的“未派发”。

3. **稳定 owner 与严格材料验证的分工合理。**  
   packet §2.2–2.3 不冻结自身合法控制会修改的整体状态，但冻结 runtime/manager/Session、GoalRun、planning attempt、模式家族及 ancestor；最终派发另绑定控制后的实际引用和完整候选。
   - 原请求准备确会改请求快照及 humanEpoch：`src/preflight-human.ts:230–268`。
   - 原问题仍严格绑定 epoch、goal lease 和 preflight digest：`src/preflight-human.ts:270–289`。
   - 材料与 owner 检查仍有实际来源：`src/preflight-human.ts:743–778`、`src/acceptance-runtime.ts:421–441,544–623,1094–1118`、`src/scope-revision.ts:345–374,412–428,465–478`。  
   after stamp 仅能在核心成功及物理回读后采集；不得改写原控制“刷新预期”。首次 Start 材料复核也没有被错误扩成 preparation 后恢复必须重批权限。

4. **命令等待、元数据审核和恢复效果保持独立。**  
   packet §3.3–3.4、§4 的 wrapper/Now core 分离可保留原检查，不需要强转命令上下文。
   - 原继续资格可从 `src/commands.ts:84–125` 提取。
   - 原 resume 的独立 board/Supervisor 效果及失败处理位于 `src/commands.ts:147–210`。
   - 定义/scope 的等待与审核主体位于 `src/acceptance-runtime.ts:1054–1187`、`src/scope-revision.ts:492–609`。
   - 原 recover 仍执行权限、association、scope、预算和能力检查：`src/supervisor.ts:845–899`。  
   packet 明确禁止 B 对未知 capture/execution 生效恢复，不能借原 recover 内的 `closeUnknown()` 绕过此门；旧命令的显式修复语义保留。共享 UI 锁不扩展 `answerRegistry`，恢复不新增批准 kind 或序列化确认参数。

5. **事件外请求、runtime 绑定及去重范围有界。**  
   packet §3.2、§5–6 明确绑定延后 callback、predicate、validator 和 result reaction；单 handle、单 correlation、非 runnable 投影标记均不持久化。
   - 现有 ALS 确实只覆盖已注册入口，新增延后 callback binding 有必要：`src/runtime.ts:98–140`。
   - 原事件处理先于 pending-ui 注册：`src/index.ts:24–28`。
   - parent 去重排除随机 request ID/普通 leaf；冷恢复连未就绪 preparation 一并 seed，拒绝、退出及 unknown 不自动重问或补派。满额关闭自动呈现而不驱逐旧键，也未引入第二调度框架。

### Fixed

无。本次只读，未修改文件。

### Finding

No issues found.

## NOTE / BASELINE / GAP

- **NOTE：** packet §8 的临时配对必须验证真实模块解析。现有 `test/goal-native-smoke.py:7–17,48` 的 `--cli` 只选择执行入口，不能单独证明扩展解析到了 H0；原信任根由 `src/human-ui.ts:36–64,102–123` 决定。packet 已明确要求实际 resolution 配对，实施时不能退化成仅换 CLI 路径。
- **BASELINE：** 无合格 H0 时继续 A-only；原命令保留原宿主限制。已接受 A/H0 不在本次重新验收范围内，也不授权修改 H0、安装、发布、重载或业务控制。
- **GAP：** B 尚未改码，本次未运行测试、构建或原生验证。§8 的单样本、完整无命令矩阵、竞争/取消/准备失败、旧宿主兼容及独立实现接受仍须取得真实证据；这不是当前设计 blocker。

**Merge verdict: OK，仅限 B packet 设计门。B 与整体 Goal 保持未完成。**