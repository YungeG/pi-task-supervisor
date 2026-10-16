# V2/V3 回执整合实施包

状态：I1/I2/I3 本地整合验收完成，见 [receipt-integration-acceptance.md](./receipt-integration-acceptance.md)。授权来源为用户在 V2 整理后指示“继续”；范围是独立整合候选，不含清理原目录、提交合入、推送、发布、安装或人机交互 r2 合并。

## 证据与权威

| ID  | 依据                                                         | 要求                                                                                                                      |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| A1  | V2 原样归档 `7064d572...`，5 文件，补丁/哈希与 15 项局部回归 | 保留旧上限观察缺口保护、resume 统一序列化与不猜测未知写入；不盲目叠加两个 writer                                          |
| A2  | V3 接受代码 `e2578137...`                                    | 保留有界原始体缓存、当前分支/目标身份、intent 与未知结果闭包、既有授权及 64,000 字节保护规则                              |
| A3  | 本轮 `configured-source-audit.json`                          | 选中的 `content-sha256-514525...` 快照实际是 V2，supervisor 字节与归档一致。因此必须读取 V2，不以项目日志暂未出现就删兼容 |
| A4  | `format-audit.json`                                          | 三个项目日志完整扫描至抓取时文件大小，未见 V2 原生记录；不是对外部/未来/已删除数据的否定证明                              |
| S1  | 证据新鲜性与数据完整性                                       | 旧 500 条状态可能漏记修改，不能继续承认其旧接受；未知执行不能自动重放，迁移不改变授权或重开完成板                         |

审计只输出版本/头信息；安装配置、原日志、原 V2/V3 候选与人机交互工作树均不修改。

## 所有权与基线

- 主控单 writer；整合 worktree：`receipt-integration`，分支 `integrate/supervisor-receipts-v2-v3`，HEAD `f6d3c7f...`。
- 先逐项核对 V3 指纹再复制其 87 个文件，未覆盖 V2 原始候选；来源清单在 `receipt-integration-artifacts/source-candidates.json`。
- 本目录复制的旧 V3 验收只证明旧候选，不作为本次整合通过。新结果单独记录。

## I1：旧 v1 饱和观察缺口

- `SupervisorSchema` 增加可选 `receiptGapEpoch`，只用作单调失效标记，不伪造 receipt。
- `restoreSupervisor` 在最后选择的是 v1、500 条、非 stopped 且尚无 barrier 时，epoch+1、清 acceptedDigest；paused 保留暂停和更强 hold，其余 fault；旧 board/done/bindings/usage/counters不重置。
- 只追加一个经过真实 entry/leaf 确认的 v1 barrier 检查点，不自动写 v3、不重写旧历史。重开读取标记不重复推进 epoch。
- completed board 保持 completed；Supervision 接受置为不可信/fault，recover 仍不能重开完成板，需明确新目标。499 completed 与 stopped500不被一概失效。
- append 不确定时可见锁定，无自动 retry。实施先用 public `restoreSupervisor/recoverSupervisor` 的 completed500、paused500 与499对照 RED/GREEN。

## I2：严格 V2 读取、缓存与显式迁移

新私有 Module `receipt-v2.ts`：

- `V2CursorSchema` 和已安装候选的 batch schema；`V2ReceiptHistory` 一次按实际 branch 解析批次/检查点。
- 保持 count/first/previousHead/SHA-256/重复 ID/同 journal goal scope、session/未闭合批次拒绝。source 数据不被裁剪、猜测或自动修补。
- 构建仅含原生 entry ID、slot、顺序的定位元数据，不建立全量 raw receipt 副本。
- `V2Archive` Interface 提供精确 anchor ID/digest、原 cursor/epoch、定位信息及按 ID 从原记录验证读取；不序列化 callback。

`ReceiptStore`：

- type-only 引入 V2Archive，避免与共享 ReceiptSchema 的运行时 import cycle。
- `fromV2` 创建 bounded readonly view，format=2；公开引用仍 `tool:<id>`。旧完成态可验证，未完成态恢复不自动启 Main。
- 此 view 仅写必要的 v2 **控制元数据**（pause/fault/stop，不追加新 v2 bodies），使人类明确 recover 前不发生格式迁移。
- `promoteV2` 仅由合法 recover 调用，锚定最新精确 v2 控制检查点，epoch+1，转为 v3；原批次/绑定/使用量不重写、不清空。
- v3 `legacyBase` 增加 version=2 判别；v1 无该字段保持原编码。重开 v3 时通过已验证 V2History重建定位，原始体仍按缓存预算读取。
- 新目标/显式恢复后统一写 v3，不运行第二个 v2 body writer。旧扩展仍拒绝 v3。

`supervisor.ts`：

- `decodeSupervisorEntry/readSupervisorHistory` 支持 1/2/3；V2 batch/root不能被忽略成无监督。
- 每个原生 checkpoint 的完整 schema、journal identity 与 goal/model/preflight scope 均校验，v3 之后不允许反向写 1/2。
- `saveSupervisor` 根据 store format选择控制元数据，普通 resume 继续经统一入口；不把 cache投影当完整历史。
- `prepareToolCapture/observeTool` 在只读兼容 view 不产生新证明，修改要先显式恢复；新鲜验证在迁移屏障后重取。
- `recoverSupervisor` 候选状态先持久化确认后才发布 active；失败保持 fault/journal锁，不发送 continue，不重置审批。
- FlowFacts 的 legacy/pending issue 用 format 区分，status 仍纯只读。

## 精确写集与保留

- 生产：`receipt-v2.ts`（新增）、`receipt-store.ts`、`supervisor.ts`、`flow.ts`，仅必要时 `runtime.ts/events.ts`；不改 task wire contract 或 engine/任务上限。
- 测试：现有 host-event / restore/recover Interface，不新增未授权业务执行 seam；V2 fixtures、corrupt/orphan/order、ordinary pause、terminal、两阶段恢复失败、原始归档与 native迁移/重开。
- 工具/文档：现有 smoke增加 V2格式 fixture；package scripts只扩充测试；本包、专用验收、README/CANARY/CHANGELOG。
- 保持100 tasks、40checks、20resumes、3stagnant、原来90% coverage门、64,000 UTF-8包上限；不改模型、凭据、安装源或用户权限。

## 失败优先级

1. 未知格式/损坏/孤立V2批次、scope/前驱/anchor错误 → journalFault，不静默降级。
2. v1饱和/未知执行 →接受失效、合法人类控制后新验证；不重开完成板。
3. 人类审批/暂停/决策/已有执行/预算门照旧，不因兼容或缓存释放。
4. Cache miss/eviction不是fault；超包保护材料仍拒绝。

## 验收与推进

- I1先复现completed500差异，追加屏障幂等及499/stopped对照。
- I2先两条/一批小样本，再500/501+跨批次；强制损坏、孤立、分支/fork、只读加载与显式恢复。
- I3原有737全套作为基线，补充新用例后完整check，不降低门槛；SDK1.1/1.2无包内依赖冷测、旧1/2 reader拒读3、资源100→1000→5000及pack dry-run。
- 用新整合diff指纹绑定最终证据；不能引用旧V3通过来代替本次整合。主控对候选作blocker自查，不新增未授权正式外部审查或 workflow。
- 完成是“可验证整合候选”；最终提交/合入原目录及发布/安装需单独授权和协作者交接。
