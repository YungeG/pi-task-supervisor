# A：前置定义、联合确认与恢复闭环

状态与生产文件归属见[施工索引](./README.md)。本卡不授权施工；必须先消费 K／S 的实际冻结产物，不靠新增批准跳过技术缺口。

## 结果

在正确的当前规划／目标来源下确认明确权限和已有检查定义，分别可信保存，随后与本次 Start 的执行身份衔接。任何半写、过期、重开或撤销均不能制造权利或重复启动。

**A 交付内部模块闭环，不宣称公共命令、真实 TUI 或外部 Python 全链已接好；这些由 I 集成并在 V／Q 验证。**

## 消费与生产

- 消费：S 的共同接口基线，以及 C-ID、C-DEF、C-PREP、C-EVI、C-VIEW、C-WIRE。
- 不必等 B／E／U 实现完成：基本正向用例使用既有、可核验的 workspace 内有限 Node 能力；新外部能力未交付时明确不支持，不能用成功 mock 伪造资格。
- 生产：真实记录写入／读取、定义确认与执行关联的模块候选、失败矩阵、针对性验证、需要 I 接入的准确 adapter 清单。
- 若 K 选定的基本路径必须依赖 E 的新增原语，Main 必须把它实际交付到 S 或显式修订依赖；不得继续宣称二者独立。

## 改动接缝

仅改索引 A 组文件。已定位入口包括：

- `submitPreflight`、`inspectPreflightStart`、`approvePreflight`、`startApprovedPreflight`、`submitAndPresentPreflight`。
- `proposeAcceptanceContract`、`preCompileOwner`、`prepareContractBinding`、`finishContractReview` 及定义／绑定 journal 的写入和读取。
- `NativeReadbackFrame` 等原始控制／见证相关结构；具体新 variants、schema、身份 preimage 和恢复入口必须由 K 确定。

不修改 `human-ui.ts`、命令／事件／runtime，也不擅自改 `artifact-version.ts` 或 `check-runner.ts`。需要的公共类型在 S 先落地，真实 transport 与执行路由交 I。

## 必须保持的行为

1. 一次明确操作覆盖哪版材料、哪些权限选择和定义必须可核验；提案、局部草稿、DTO 或旧业务回答不能充当联合确认。
2. 权限、验收定义、首次 Start 和实际结果分开记账。产物尚不存在不等于规则不能确认，也不能提前生成通过证据。
3. 必要事实不齐不开放对应执行；完整原始事实仅缺投影时，只考虑精确幂等修复。原始来源或派发结果不明时保留未知，不重放。
4. 材料实质变化不能挪用旧确认；普通产物进展不自动清除仍适用权限。
5. 准备阶段完成后存在合法的具体定义冻结与继续路径；不靠重建同一目标、重复 Start 或提前执行依赖未冻结定义的任务解围。
6. 新 reader、写入顺序和恢复规则随本节点交付，不留待上线后补；旧记录、暂停／撤销和原始字节保护按 C-WIRE 保持。

## 本节点测试归属

优先复用以下现有文件；必要新增测试文件须在 K／S 中分配唯一归属：

- `src/__tests__/preflight.test.ts`、`preflight-human.test.ts`、`preflight-restoration.test.ts`、`preflight-io-failures.test.ts`、`preflight-recovery-branches.test.ts`。
- `src/__tests__/acceptance-planning.test.ts`、`acceptance-proposal.test.ts`、`acceptance-contract.test.ts`、`acceptance-restore-io.test.ts`、`acceptance-wire-negative.test.ts`。
- `src/__tests__/human-journal.test.ts`、`human-recovery-branches.test.ts`。

`human-ui.test.ts`、`human-owner.test.ts`、真实 SDK／CLI 流程与共享 fixtures 归 I，不由 A 并行修改。

## 最小验证与交接

首个红灯：通过真实模块入口处理“已有检查器＋未生成产物”的启动前定义确认，不能绕过 owner／控制验证只测纯 helper。然后覆盖两个事实各保存点、过期、撤销、重开与不重复 Start；具体标题／命令在 K 冻结，当前未创建或运行这些新用例。

候选可先使用本地 `node_modules/.bin/vitest run` 选择 A 的相关文件，不运行完整 smoke 矩阵。针对性模块测试中的原生来源模拟不能升级成真实人类或 CLI 证明。

交接 I 时列出实际分支／快照、消费契约、记录格式与恢复证据、仍不支持的能力、需要连接的入口。A 停止写入并释放文件后，I 才可接管或把具体发现退回 A 修复。
