# 三项 P2 修复：当前 GoalRun 记录

当前目标：`rg-23ff6c95-c9d3-4cb9-b90b-dbca12e4f424`；计划 `pf-297fea44-f86d-48f3-a851-287f682b6c01.r1`。仅使用 inspect_candidate、patch_candidate、run_validation；额外 SDK/历史 artifacts 与独立 reviewer 权限未选中，不沿用此前授权或验收。

状态：**阶段 1 focused 验证通过；完整门与最终接受尚未执行。** 本记录不是部署许可，也不重新认证此前 L1 性能。

## 复现与修复

1. UI 失效传播：新增四条 UI 回归，原代码三条失败、普通降级一条通过。`captureFacts` 与 `updateUI` 在恢复专用路径原样抛出 RestoreReadInvalidated，普通展示/transport 失败仍降级。另加实际 session_start 的晚期 UI epoch 失效测试，断言不写 widget/status、journal 或派发 Main。
2. SDK 依赖布局：将基准准备工作提取为两个内部 helper，先保留旧行为。小型合成 SDK 包树复现嵌套入口硬编码、hoisted 路径和缺失依赖诊断问题。改用选中 SDK 的 createRequire 定位既有 jiti，再复用其 ESM resolver 解析 typebox/pi-ai/pi-tui；不新增依赖或更改 SDK/Node 支持范围。覆盖 nested、hoisted、import-only exports、nested 优先于外层 decoy，以及缺失依赖不回落到项目 SDK。
3. 流式边界：小型文件在 stat 后追加约 4 KiB，旧准备器仍返回成功；修复后固定初始读取范围，并在返回 fixture/导入恢复代码之前核查读取量及 dev/ino/size/mtime/ctime。丢失末尾 LF、坏 JSON、祖先环仍拒绝；退出解析时关闭 reader/stream。单元测试用小预算验证，无真实大日志。

原准备代码快照与 RED/GREEN 日志仅新增到本目标 `p2-repair/`。首次 RED 日志检查器误以为 Node 使用 TAP 文本，实际是另一 reporter；已按实际输出复核六项失败，不将该检查器问题当作生产缺陷。初次 lint 发现新测试的 shorthand-void 回调，已修正；没有修改规则。

## 阶段 1 新证据

- Vitest 相邻五文件 **122 项**通过，包括四条新 UI 用例、晚期 UI epoch 集成与既有 publication/capture/恢复测试。
- Node 内建 runner 的六条 SDK/I/O 准备用例通过。
- typecheck、lint 通过；本目标改动格式检查和语法检查随 reviewing 再核对。
- 10-record synthetic 完整基准使用已存在开发依赖 SDK 1.1.0：一次 open/EOF，实际读取 84,661 字节；writes/executions/dispatches/notices/network 均为 0，输入未变。
- 新基准报告同时记录主脚本和 I/O helper 指纹，不能仅按旧主文件哈希声称方法相同。

以上是本目标的新执行，不使用旧 GoalRun 通过记录。阶段 2 尚需一次完整 `npm run check`、必要的有界 synthetic 复核及最终指纹验收。本轮不读取真实 session、生产日志、凭据、旧 artifacts 或额外 SDK，不运行真实 L1；没有新增安装、提交、push、merge、生产 reload、旧目标恢复或预算重置。未获批的独立 reviewer/额外 SDK 场景将在最终报告列为未验证。
