# A 首轮独立实现审阅归档

2026-11-02 · 审阅对象：P2 去重修订前的 A 候选（3399 项测试版本）。

- Reviewer run：`47919ae6-7732-40d4-9773-cb825a6e18d6`。
- 结论：A OK with notes，1 项 P2；H0/B 及完整 Goal 未完成。
- 下文原始意见不改写；主控随后复现并修复 P2，处置与新候选证据见[A 验证记录](supervisor-human-interaction-a-validation.md)。

---

## Review

### 范围与方法

已完整读取 A 实施 packet、验证记录及计划中的 A、不变式、H0 门；按指定文件检查当前 diff、真实调用链和相邻实现。未将此前 guidance/resource-scope 修改归入 A。

本次只读，未修改文件、运行测试、安装或操作业务会话。

### Correct

- **诊断没有成为授权能力。** `requestNativeAnswer()` 仍仅返回原注册器产生的 opaque answer；诊断不进入答案注册表。原 `requireNativeAnswer()` 继续检查对象身份、frame、Session、分支、当前性与取消状态（`src/human-ui.ts:212–234、374–389、1004–1064`）。
- **取消与失效仍优先。** UI 返回后外层再次核对当前性；取消/失效覆盖已观察选择。异常仅产生稳定 `ui_error`，不回显异常正文、不降级重试；未知退出保留 `no_response`（`src/human-ui.ts:297–308、350–367、809–831`）。
- **原保存与故障语义保留。** preflight/board 仅在未取得可接受答案时附加诊断，后续仍调用原物理控制和见证路径；投影及启动待核优先于退出提示（`src/preflight-human.ts:473–529、810–856`；`src/board-human.ts:181–230`；`src/human-presentation.ts:44–89`）。
- **新入口只读。** 快捷键复用 `showTaskList()` 和原视图生命周期；组件键盘路径只有导航、阅读及退出，没有授权、恢复或派发调用。快捷回调通过原 ALS runtime 包装（`src/pending-ui.ts:35–46`；`src/board-ui.ts:307–396`；`src/board-view.ts:328–344、634–720`；`src/runtime.ts:132–136`）。
- **settled 新路径只有通知。** 没有打开审批 UI、发送消息、计时器或私有队列访问（`src/pending-ui.ts:48–71`）。禁用配置及冲突说明与实现、宿主冲突处理一致。
- **验证证据分层正确。** 已读取最终完整检查日志：144 文件、3399 测试通过，覆盖率四项均超过原门槛；未把旧注册数失败当作当前失败。三个指定 `verified.json` 均标明真实 CLI、合成按键、非业务证明；对应原生驱动确实检查只读前后 journal、退出诊断及通知观察。SDK 模拟不被计作原生证据。

### Finding

#### P2：通知去重缺少分支代际及实际请求身份，可能吞掉另一分支的新待办

- **位置：** `src/pending-ui.ts:54–63`。
- **证据：** fingerprint 包含 Session、Goal/preflight 标识、board generation 和两段摘要，但没有分支代际或 `board.decision.id`。结构化决策的摘要固定为“等待原生回应”，不包含请求身份（`src/ui-view.ts:586–593`）。切树会恢复当前分支并使原回调代际失效，但此通知缓存没有对应失效处理（`src/events.ts:485–486、588–589`）。
- **可复现推导：** 同一 SessionManager 下，兄弟分支分别从相同 generation 的共同祖先产生不同决策；两边 generation 相同，Goal/preflight 相同，摘要也相同。分支一通知后，切到分支二，其下一次符合条件的 settled 会命中旧 fingerprint，遗漏不同请求的通知。
- **契约依据：** 计划 §4.3 要求去重绑定 owner、Session、branch、请求/材料及运行时代际，不能依赖自然语言摘要区分请求。
- **最小修复：** 在分支恢复时清除该 manager 的通知缓存，并将实际请求/材料标识加入 fingerprint。不要直接加入每轮都会变化的 leaf，否则会造成重复提示。
- **接受条件：** 增加同 manager、相同 generation、不同分支/决策的回归：新请求应重新提示，同分支同请求重复 settled 仍只提示一次，且零控制写入、零派发。

此项仅影响提示完整性，不影响授权或执行安全，可作为 A 本地候选的非阻塞备注。

### 边界分类

- **BASELINE：** 既有 guidance/resource-scope 修改及旧宿主队列限制，不作为本轮 A 新缺陷。
- **NOTE：** 本次核验已有日志和工件，未独立重跑测试。
- **DEFER：** H0/B、原业务会话加载版本及历史退出根因仍未闭合；A 文档没有宣称它们已经修复。
- **Fixed：** 无；本次严格只读。

### 结论

未发现本轮 A 的 P0/P1 问题。

**Merge verdict: OK with notes（仅限 A 本地候选接受）。**

**A verdict: OK with notes**

完整 Goal 仍未完成：H0/B 继续阻塞，本结论不授权跨仓库修改、安装、重载或业务控制。