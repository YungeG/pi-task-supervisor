# 人工交互兼容交付 A：实施约束

2026-11-02 · A：本地实现/完整验证及修复后独立审阅完成，候选已接受；B：NOT_READY（宿主范围已获确认，H0 设计/能力尚未通过）。本文件保留原实施约束，不将A接受解释为整体完成。

## 授权与结果

- C1：用户当前 Goal「按照计划推进至完成」允许按已审阅路线图开展本仓库本地实现/验证；原“仅文档”是此前交付的历史状态，不再作为 A 的执行禁止。
- C2：`supervisor-human-interaction-repair-plan.md` v3 第 2、3、5、6 节规定 A 不等于完整目标，新增通知/面板只读，B 仍硬依赖 H0。
- S1：原 NativeAnswer 身份、物理见证、权限/Start/定义/scope/恢复及预算规则不改；不安装、不重载、不操作业务会话。
- H0：已核对测试 Pi 1.1.0、安装 Pi 1.4.0，均无合格公开接口。用户随后允许隔离宿主源码/修改/构建/验证；已建立精确 v1.4.0 副本并通过离线构建基线，H0 packet 尚待独立设计审阅。范围批准不替代设计/能力证据。

## 接缝与精确结果

原：`原工具/命令 → present → requestNativeAnswer → opaque answer | undefined`。

新：`原工具/命令 → present → requestNativeInteraction → { answer?, diagnostic }`；原 `requestNativeAnswer` 保留为兼容适配，仅返回同一个原始 opaque answer。只有原答案注册器可生成有效答案；诊断不能生成或验证批准。

- `NativeInteractionDiagnostic`：仅 `phase: admission | presentation | response` 与稳定 `code`，不含错误消息、标题、完整材料、输入值或凭据。
- `code`：`answered | unsupported | invalid_request | stale | aborted | busy | display_unavailable | no_response | user_deferred | ui_error`。
- `user_deferred` 只在实际选择稍后时设置。组件取消/返回 undefined 但原因不可证实时为 `no_response`；不能声称用户取消或已看见界面。presentation 只表示进入宿主 UI 路径，不是截图/视觉证明。
- `NativeInteractionResult`：`answer?: NativeAnswer; diagnostic: NativeInteractionDiagnostic`。原许可/决策/Start 状态码保留；上层未取得答案时附加可选 `interaction`，既有成功/持久化故障优先级保持不变。
- 不新增持久诊断表或历史回填。工具结果及命令回执显示本次诊断；待办面板读取当前原状态，不把最近诊断当授权。

## 精确写集与责任

单一写者：当前 Main；保留已有未提交改动，不 reset/stash/清理/提交。

| 文件/符号 | 改动 |
| --- | --- |
| `human-ui.ts` | 新诊断/result 类型、`requestNativeInteraction`；原 `requestNativeAnswer` 兼容适配；内部 admission/UI/response 路径仅记录稳定原因，不改答案来源 |
| `human-decision-card.ts / DecisionCard` | 可选只读 `onDefer` 观察回调，仅在选择“稍后”时触发，不改变完成值/草稿注册 |
| `preflight-human.ts / present` 及其三个调用点 | 消费 rich result，未提交结果带本次诊断，不改变批准、定义、Start记录或门禁 |
| `board-human.ts / presentDecision, answerBoardDecision` | 同上，board 准入/原见证不变 |
| `human-presentation.ts / preflightNotice, boardNotice` | 仅未提交时按诊断显示中文原因；已保存但投影/启动未知仍优先 |
| `board-view.ts / createReadOnlyBoard, confirmationText` | 可选初始确认只读页；显示共享 next，不增加动作处理 |
| `board-ui.ts / showTaskList` | 将可选只读初始页传给现有组件，复用当前视图生命周期与取消握手 |
| `pending-ui.ts`（新增） | scoped 只读快捷入口、普通 settled 去重通知；requestIdentity 绑定既有 goalEpoch、实际请求/材料引用，不用每轮 leaf；只读派生，不调用控制或 sendMessage |
| `runtime.ts / scopedAPI` | 包装 registerShortcut，保证回调及 await 属于原 AsyncLocalStorage runtime |
| `index.ts` | 注册 pending-ui；不选择管理模式、不启动工作 |
| `src/__tests__/helpers/mocks.ts`、相关测试 | 补真实存在的 registerShortcut 模拟，测试 runtime 隔离和零控制副作用 |
| `test/goal-native-fixture.ts`、`test/goal-native-smoke.py` | 在既有隔离 CLI/PTY 夹具中新增 human-interaction 场景：真实快捷键只读/零日志写入、明确稍后与未知退出诊断、通知不触发额外模型轮次 |
| README、实施验证记录 | 如实记录 A、缺失 H0、支持宿主和验证范围；不宣称完整自动化/原会话修复 |

快捷键默认 `ctrl+shift+y`；环境变量 `PI_TASK_SUPERVISOR_PENDING_KEY` 仅接受 `ctrl+shift+<a-z>` 或 `off`。非法值禁用，显示仍可用既有 tasks 命令；宿主原有冲突诊断保持。注册不会读/改设置文件。

## 失败次序与保留

1. 可信本机来源检查失败：unsupported，UI 不调用。
2. 原 Session/frame/branch/isCurrent/signal 检查失败：对应 invalid/stale/aborted，无答案。
3. 已有原生问题：busy，不抢锁或替换现有问题。
4. UI 进入失败/异常：稳定诊断，不回显异常原文，不退回摘要审批、不隐式重试。
5. UI 后 signal/来源失效优先于任何选择：不产生答案；合法原生结果仍经原答案映射和 WeakMap 注册。
6. 控制保存/见证/投影失败仍由原控制模块处理；诊断不把它们改成成功或再要一次批准。

原命令、wire、审批值、hash预像、NativeAnswer签名/对象身份不改；新 rich API 的诊断是展示数据，不是可信授权输入。

## 首个反馈环与验证

- 已跑最小基线：`npm test -- src/__tests__/human-ui.test.ts -t 'returns undefined when not trusted TUI'`：2 passed。
- 先在真实 submit_preflight 控制链的既有夹具注入 UI 抛错，断言保持 deferred/无控制记录，且 diagnostic=ui_error；运行得到 symptom RED 后再改实现。
- 再覆盖明确稍后、未知退出、unsupported/stale/abort/busy、伪造答案拒绝及 UI 异常不泄露正文。
- 新只读入口断言所有键盘路径不追加 journal、不调用批准/恢复/派发；两实例快捷回调 runtime 不串用；忙碌/已有问题不抢焦点；settled通知去重且不自动打开 UI。
- 复用既有单测/真实 CLI PTY 路径先一小样再扩大；先聚焦/类型/lint，再完整 `npm run check`。未通过的必需门保持未完成，不因 A 通过结束完整 Goal。
- 所有 H0/B 竞争、启动及恢复验收保持未执行/未通过，直到明确宿主范围、独立设计和能力验证完成。
