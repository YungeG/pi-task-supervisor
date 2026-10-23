# 三项 P2 修复：限定范围最终验收

当前 GoalRun：`rg-23ff6c95-c9d3-4cb9-b90b-dbca12e4f424`；计划 `pf-297fea44-f86d-48f3-a851-287f682b6c01.r1`。本轮只使用 inspect_candidate / patch_candidate / run_validation。结论是 **ACCEPT_P2_REPAIRS_ONLY**，须由当前任务 reviewing 的新鲜宿主收据绑定，不承接旧 GoalRun 的验收或授权。

## 1. 当前改动与逐项裁决

基线 HEAD 仍为 `3c19f559a9dc1378e34ad3a140b589cb1707c28e`，分支仍为 `fix/supervisor-journal-growth-restore-current-main`；此前已有的未提交改动保留。进入本轮时的源码指纹为 `1ccebd…`，修复后的完整 `src/**/*.ts` 清单指纹为：

`e68e5300975cc485a4e11c42d176f4c9ceeb946ae78f975b0984dff2fbcc11b1`

本轮生产变更仅为 `src/ui-capture.ts`、`src/state.ts` 的恢复专用失效传播；另外新增四条 UI 单测，在既有恢复集成文件增加一条晚期 UI epoch 用例。基准修改在 `test/journal-growth-restore-bench.mjs`，将准备工作提取到 `test/journal-growth-restore-bench-io.mjs` 并增加对应 Node 内建测试。没有改变工具/wire/schema、摘要、业务授权/预算或未知执行规则，也未改变 package/lock/Node 支持范围或质量门。

| P2                       | 当前目标新复现                                             | 最小修复与验收                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UI 捕获吞掉恢复失效      | 原代码四项 UI 测试中三项失败，普通降级一项通过             | 两层 catch 只在 restoration 路径原样传播 RestoreReadInvalidated；普通 UI/transport 降级保留。相邻测试及实际 session_start 的晚期 epoch 失效断言通过：不写 UI/journal、不通知、不派发 |
| SDK 路径假定嵌套布局     | 合成包树复现 nested 导出入口硬编码与 hoisted jiti 定位失败 | 使用选中 SDK 的 createRequire 定位其既有 jiti，再用 ESM resolver 解析依赖；nested/hoisted/import-only 导出、nested 优先于外层 decoy、缺失依赖不回落项目 SDK 的测试通过               |
| 并发增长越过准备输入预算 | 小型输入在 stat 后追加约4 KiB，旧准备器未拒绝              | 固定物理读取终点为初始文件末尾，返回前核对读取量与 dev/ino/size/mtime/ctime；变化在恢复导入/计时前拒绝。小预算测试确认实际读取不超预算；缺 LF、坏 JSON、环继续拒绝                   |

原行为提取快照和 RED 日志保存在本目标新目录，不覆写旧证据。初次 RED 日志解析器误判 Node reporter 文本、初次 lint 发现 shorthand-void 新测试样式，均保留记录并修正；不将工具输出解析问题当作生产缺陷，不放宽 lint。

## 2. 本目标执行验证

新证据仅在 `../journal-growth-restore-artifacts/p2-repair/`：

- 阶段1：122 项相邻 Vitest、6 项 Node SDK/I/O 测试、typecheck/lint/format/语法检查通过；reviewing 收据只证明该阶段，不代表完整门。
- `full-check.log`：本轮只执行一次完整 `npm run check`，**1991 项测试、12 个既有 smoke** 通过。
- 覆盖率：statements **93.99%**、branches **90.45%**、functions **98.22%**、lines **95.99%**；未更改门槛。
- 最终 Node helper 六项重新通过。Node 测试位于 `test/`，不冒称它们包含在 Vitest 的1991项内。
- 先10条、后100条有界 synthetic 完整基准，均使用已有开发依赖 SDK **1.1.0**；非额外 SDK。

| 样本 | 实际文件/读取字节 | open/EOF | 恢复 ms | 整个基准进程峰值 RSS KiB |
| ---- | ----------------: | -------- | ------: | -----------------------: |
| 10   |            84,664 | 1 / 1    |  10.785 |                  303,136 |
| 100  |         7,451,075 | 1 / 1    | 114.654 |                  356,024 |

两份报告均校验输入未变、源码清单匹配，writes/executions/dispatches/notices/network 全为0；报告同时绑定主驱动和 I/O helper 哈希。使用生产恢复 handler 与严格 reader，但准备上下文仍是只读内存视图，不是整个真实 Pi/TUI 或实际 SessionManager 的性能认证。没有前后性能对照，也不据此承诺速度或真实 reload 时延。

## 3. 权限、保护与未验证范围

- 主控唯一 writer；没有派发 reviewer 或其他子代理。
- 没有读取旧 artifacts、额外 SDK、真实 session/L1、生产日志或凭据；没有沿用旧收据证明当前通过。
- 复用现有开发依赖；没有安装/升级、修改共享 node_modules、全局 SDK/settings、已装扩展、原项目 package/lock 或他人工作树。
- 只新增本目标证据和候选说明，coverage 为批准的验证输出；没有覆盖历史审阅/验证材料。
- package/lock/tsconfig/vitest/eslint 配置与 HEAD 字节相同；本轮开始清单之外的旧源码保持原状，具体新文件哈希见本目标最终清单。
- 不执行真实 L1/完整 reload；历史 L1 性能不重新认证。独立 reviewer、额外 SDK 及历史原始报告权限未选中，明确 **NOT_AUTHORIZED / NOT_RUN**，不是通过。
- 没有提交、push、merge、切换分支、部署、生产安装、reload、日志迁移、旧目标恢复或预算重置。

最终接受仅针对三项 P2 在当前范围内的修复与新执行验证，不替代将来整合其他 main 变更、部署或真实数据性能复测所需的授权及重验。
