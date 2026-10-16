# 回执整合验收记录

状态：**本地整合候选 PASS；未提交、未合入原目录、未发布、未安装。** I1/I2/I3 已完成。下一步若要落地，由 Main 在取得提交/合入授权及原 V2 写者交接后执行；本记录不代替该授权。当前交付无需用户操作。

## 身份与范围

- Worktree：`receipt-integration`；branch：`integrate/supervisor-receipts-v2-v3`；基线 HEAD：`f6d3c7f6cab37bae2f0cb4b63024cb5eae8053ce`。
- 最终代码/测试/配置指纹：`09641ecbc4b44d590ae8b8d5fc083d117c19e56ab9c349a8f29ba71b88a96d40`。
- 冷测源码快照：`../receipt-integration-artifacts/snapshots/ead26fe196ba8f988b360c49da8e86f8c923d860f27e4023034b2d03e434df2e`。快照逐文件 hash 与 manifest 相符，无包内 `node_modules`；当前 worktree 的临时开发链接亦已移除。
- 输入：V3 代码指纹 `e2578137...`、V2 五文件指纹 `7064d572...`。旧 V3 PASS 不是本次接受；两份候选、原目录和人机交互 r2 都保留。
- 本机原始产物：`../receipt-integration-artifacts/`，不是随仓库发布的便携证据。所有最终结果使用本次新指纹；没有启动第二次外部正式审查、delegated writer 或 workflow。

## 环境事实

`format-audit.json`：先解析器自测、每日志 1MiB 小样本，再扫描三个项目会话日志至抓取时文件大小，只分析原生自定义记录的版本/头信息，不输出目标正文或凭据。未发现 V2 原生记录，但这不证明其他项目、外部、删除、CLI 覆盖或未来数据不存在。

`configured-source-audit.json`：真实设置选中本地 `content-sha256-514525...` 快照，其 `supervisor.ts` / `commands.ts` 逐字节匹配已归档 V2，故严格 V2 兼容是必要条件。安装源及配置未改动；选中源码不证明运行中旧进程已加载它。

## 整合结果

1. **补上原 V3 缺失的饱和保护。** legacy completed+500 在旧 V3 保留接受的问题已 RED 复现。整合在加载饱和、非 stopped v1 时追加一次经实际 entry/leaf 确认的失效屏障，清旧接受，不伪造 receipt、不重开完成板；paused/更强 hold、预算、使用量和绑定保留。499 completed、stopped500 不被一概迁移；重复加载不重复推进 epoch。
2. **读 V2，不启动第二个 body writer。** 严格校验批次 schema/hash/first/previousHead/count/head、重复身份、session/goal/model/preflight 范围、未闭合批次及反向格式降级。运行视图只留定位元数据和有界原始体 cache；必要 pause/fault/stop 控制元数据可留 V2，不追加新 V2 bodies。
3. **显式恢复才转 V3。** 最新且精确的 V2 原生 anchor ID/digest 被固定；迁移另设新鲜性边界，原批次、原检查点、使用量、绑定不重写。新目标和已恢复工作统一写 V3；普通 resume 不能绕过恢复。
4. **恢复的当前内存发布受确认约束。** 先保存并确认检查点，才发布 active/reset 后的运行状态；失败保持当前 fault/journal 锁与原计数，不发 continue。若记录实际已落盘但确认丢失，重开以真实检查点为准（其预算可能已重置），并将 active 状态视为中断 fault，要求明确检查/恢复，绝不自动重放。这不是跨进程预算原子性或 fsync 认证。
5. **分支与不确定性回归。** 真实 SessionManager sibling 分支上的 checkpoint 即使全局可查询也不能闭合当前 V2 批次或成为 V3 迁移 anchor；损坏 archive lookup 会锁 journal；unknown execution 无自动 replay。

V1 饱和加载屏障与显式格式恢复是两个因果边界。原 V3 500 条测试的期望 epoch 5→6，以及 native v1 迁移 6→7，来自新增保护，不是减少验证。兼容读取保留已安装 V2 schema 允许的零值 marker 作为元数据，但 v1 的零值不能伪装有效饱和屏障。

## 最终验证

| 项目                             | 本次结果                                                                                                         | 真实产物                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm run check`                  | **PASS；768 tests / 36 files**，typecheck、lint、format、coverage、12 native smokes 均通过                       | `check-final.log`                                                                  |
| 原 90% 覆盖门                    | **PASS**；statements 93.90%、branches **90.20% (2312/2563)**、functions 98.58%、lines 96.32%；复杂度最高允许仍15 | 同上；阈值文件未修改                                                               |
| 开发 SDK 1.1                     | **12/12 PASS**                                                                                                   | `check-final.log` 中12个原生 JSON 结果                                             |
| SDK 1.1 / 1.2 冷加载             | **各12/12 PASS**，精确冻结源码，无包内依赖；先各2条V2小样本再完整矩阵                                            | `cold-final-results.json`、`cold-final/*.log`                                      |
| 旧 reader 拒读                   | **6/6 PASS**，旧 v1/v2/V3-only reader 各在两个 SDK 上拒绝 V2-base V3，无静默非监督降级                           | `cold-final/sdk*-old-*-reader.log`                                                 |
| 资源100→1000→5000                | **PASS**，每个规模单独先跑成功后再扩大                                                                           | `resource-final-{100,1000,5000}.{json,log}`                                        |
| pack dry-run                     | **PASS；38 files / 21 production TS**，包含新 store/reader，不含测试或node_modules；无实际发布                   | `package-dry-run-final.json`                                                       |
| 最终身份、源码、冷快照、输入保护 | 逐文件核对；后续仅验收文档/CANARY状态更新，代码指纹不变；无 staged changes                                       | `final-verification.json`、`protected-before-cold.json`、`preservation-stage.json` |

资源的 encoded ledger bytes 为 **94,466 / 947,667 / 4,751,667**，全量/半量增长约2.00×。5000时 raw cache 为 **128 entries / 43,008 bytes**；索引5000条。测量使用 SDK in-memory journal 的编码大小，不是物理磁盘吞吐/fsync延迟；compact locator、索引和 Pi session 历史仍线性增长，不承诺整体常量内存。

### 中间失败原样保留

- `legacy-gap-red.log`、`v2-reader-red.log`：所修兼容/饱和缺陷的真实 RED。
- `coverage-first.log`：89.92% **FAIL**，未降阈值；通过补充真实边界与故障回归后达到最终90.20%。
- `unit-first.log`：752 PASS/1 FAIL，是新增饱和边界后的旧 epoch 期望；修正后全套重跑。
- `v2-negative-green.log` 文件名虽含green，其中有一次异常正则大小写断言失败；不能当作 PASS。后续最终套件覆盖正确断言。
- `check-first-complete.log`：新增零值 marker 验证后 complexity16 **FAIL**；拆分内聚验证函数，规则仍15，最终全套通过。
- `integration-branch-ack.log`：30 PASS/1 FAIL，仅中断文案期望不匹配；改用实际合同文案后最终768全套通过，生产逻辑没有为该断言改变。
- 第一轮冻结指纹 `5cf228db...` 的矩阵/manifest保留为阶段证据。之后只增加3个持久分支/不确定确认测试及文档，生产文件不变；仍重新运行完整check、资源和最终双SDK矩阵，未拿阶段PASS顶替最终候选。

## Main blocker 自查与边界

自查了 `receipt-v2.ts`、store 的 archive/view/promote/checkpoint、Supervisor 的分支解析/饱和/recovery、flow 的 legacy gate，以及公共 restore/recover 和真实 SDK 路径。当前本地范围无剩余实现 blocker；不是新的独立审查结论。

- 原目录 V2 五文件、原 V2 inventory、原 V3 87文件以及人机交互目录，在保护核对中 HEAD、状态及文件 hash 不变；没有清理/暂存其内容。
- 100任务、40审查、20继续、3停滞、64,000 UTF-8 保护包上限、90%覆盖门和既有审批/暂停/未知执行门未降低。没有模型/凭据/安装配置改动，没有强制 reload 运行中会话。
- 保留历史不等于证明所有历史执行可知。老格式无法补造预执行 intent；恢复必须取得新验证，未知执行不自动重放。
- 旧 v1/v2 和旧 V3-only reader 的拒读是回滚限制，不是原会话被自动转换回旧格式。保留旧包不能让已写新格式的会话安全地用旧版继续写入。
- SDK/faux-provider/UI-stub 只认证接口与控制路径，不认证真实业务命令、活模型遵从、操作系统隔离或交互式 TUI。没有新依赖、注册表发布或业务部署。

下一步提交/合入原目录仍需明确授权和原 V2 写者交接；安装/推送/发布也不因本地 PASS 获得授权。
