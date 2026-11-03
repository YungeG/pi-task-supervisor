# A 修复后定向复审归档

2026-11-02 · Reviewer run：`7c54a70b-52fb-4b90-8ea6-5799a7382550`。

结论：**A verdict: OK，仅限 A 本地候选。** H0/B 及完整 Goal 仍未完成；不授权宿主修改、安装、重载或业务控制。下文保留原始报告，行号对应复审时源码。

---

# A 实现 P2 修复定向复审

## Review

### 范围与方法

本轮严格只读：未修改项目文件、运行测试、安装、重载、操作业务会话或派生代理。已读取原始审阅、验证记录第 6 节、当前实现及测试，并核查恢复调用链、相邻授权/保存路径和指定日志、CLI 工件。

`watchdog_diff` 是相对 HEAD 的工作树差异，不是首轮候选快照差异；本报告不将其冒充历史版本比较。

### Correct

- **原 P2 已闭合。** `requestIdentity()` 纳入 `goalEpoch`、实际 decision ID、preflight 权限/Start 请求 ID、planDigest、具体定义提案 ID及缓存 scope 提案 entryId/digest；fingerprint 仍保留 Session、Goal、preflight 和 generation（`src/pending-ui.ts:32–45、71–81`）。同 generation、同摘要但不同请求不再必然碰撞。定义提案 ID 与原 `approvalAction()` 使用的字段一致（`src/approval-bundle.ts:183`）。
- **epoch 失效足以替代显式清空本缓存。** 真实 `session_start/session_tree → restoreCache → restoreSession` 路径在恢复前调用 `invalidateGoalCallbacks()`，且发生在首次 `await` 前（`src/events.ts:479–492、575–590`）；该函数确实执行 `runtime.goalEpoch++`（`src/goal-scope.ts:207–214`），恢复代码没有把它从 journal 回写为旧值。缓存每个 manager 只保存一个 fingerprint，旧代值不能命中新代值；重新注册时缓存和 scoped runtime 也重新创建（`src/pending-ui.ts:49–51、81–86`；`src/runtime.ts:106–136`）。因此无需额外清空接口。
- **没有用每轮 leaf 换取去重正确性。** 新元组不包含 leaf；普通 `setBoard()` 也不递增 epoch（`src/state.ts:35–37`）。两项真实注册 handler 回归覆盖同请求一次、同 generation 新 decision 再提示、普通后继 leaf 不重提示、epoch 改变再提示，以及 preflight 新请求/新摘要再提示，并断言零 append/send（`src/__tests__/pending-ui.test.ts:118–176`）。其中 epoch 场景由测试直接递增模拟；实际恢复接线由上述生产源码另行确认，不依赖测试注释。
- **新增身份计算没有控制副作用。** 它只读取 runtime 字段；settled 路径仍只捕获摘要、通知和更新局部 WeakMap，不调用回应保存、Start、恢复或派发（`src/pending-ui.ts:32–45、65–89`）。
- **首轮正确结论未被该小修破坏。** 快捷入口仍只调用原只读视图，键盘路径仅导航、阅读和退出（`src/pending-ui.ts:52–63`；`src/board-ui.ts:307–383`；`src/board-view.ts:634–720`）。兼容 API 仍返回原 opaque answer，注册及身份/frame/Session/branch/当前性/取消校验保留（`src/human-ui.ts:212–230、374–389、1004–1064`）。preflight/board 仍经原控制发布与见证路径；已保存但投影或启动待核仍优先于退出诊断（`src/preflight-human.ts:473–529、810–856`；`src/board-human.ts:181–230`；`src/human-presentation.ts:44–89`）。

### Fixed

本轮未应用修改。主控对原 P2 的修复已通过本轮定向核验。

### Finding

No issues found.

本次修订未发现有明确源码或契约证据支持的新增 P0/P1/P2 实质问题。

### 证据与边界

- **NOTE：** 已核验 `/tmp/task-supervisor-human-interaction-a-check-20261102-final.log`：显示 typecheck、lint、格式检查通过，144 文件、3401 测试通过，覆盖率为 **93.35/90.07/98.06/95.46**，随后 13 个原 smoke 样本均报告 PASS。本轮未重跑；RED 顺序依据验证记录 §6，未独立重演。
- **NOTE：** 三个指定 `verified.json` 均为 PASS。两份 human-interaction 诊断文件分别记录 `user_deferred` 与 `no_response`，最终 probe 均为零模型调用；驱动实际检查只读快捷前后 journal 不变及无新增人工控制/见证（`test/goal-native-smoke.py:264–288`）。permissions 工件保留“通知后由独立 Start 命令确认”的路径（同文件 `494–502`）。这些都是**真实 CLI、合成模型/按键的隔离证据，不是真实用户或业务执行证明**。
- **BASELINE：** 既有 guidance/resource-scope 改动及旧宿主队列限制不归入本次身份元组修订，也不据此宣称已修复。
- **DEFER：** 完整 Goal 未完成。H0 跨仓库源码及修改范围仍待用户回应，宿主/H0/B 尚未实现；原业务会话加载版本及历史退出根因也未因此闭合。

### 结论

**Merge verdict: OK（仅限 A 本地候选）。**

**A verdict: OK**