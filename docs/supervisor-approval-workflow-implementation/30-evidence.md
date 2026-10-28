# E：有限验收与实际来源

状态与文件归属见[施工索引](./README.md)。E 只实现 P1→K→S 已选定并明确的有限路线，不自行决定引入通用 Python／Bash 执行器。

## 结果

对一个精确代表场景，取得有实际来源、准确范围／版本、close／exit 和结果语义的执行观察；伪造报告、复制 DTO、旧成功或未知结束不能进入正式验收。

取得底层执行观察不等于取得权限、合同信任或任务接受。实际 owner／调用资格／验收消费接入仍由 I 连接 A 与现有资格门。

## 输入／输出与边界

- 消费：S 的 C-DEF、C-PREP、C-EVI、C-WIRE 及 P1 精确代表场景、必要样本证据。
- 保留既有有限 Node 路线及调用者。尚未实现的新 profile 明确不支持，不把它默认为原有限 Node 的别名。
- 输出：受限执行／版本捕获实现、原始结果的可核验取得方式、负向证明、能力与限制表，以及需要 I 接入的准确消费位置。
- 不依赖 A／B／U 的实现提交；用 S 的真实输入／输出与合法的受控执行生产者验证本线。不通过 DTO 回填伪造一个 A 会接受的结果。

## 现有接缝与写占用

本线独占 `src/check-runner.ts` 与 `src/artifact-version.ts`，现有 symbols 包括 `NativeCheckInvocation/NativeCheckExecution`、`captureCheckVersion/nativeCheckExecution/runNativeCheck`、`ArtifactScope/ArtifactVersionV1`、`captureUnownedArtifactInputs/captureArtifactVersion/verifyArtifactVersion`。

不改 `acceptance-runtime.ts`、`qualified-evidence.ts`、控制 journal 或 command／event 路由；涉及这些消费者的改动交 I，新的公开字段回 K／S。

本线测试占用：`src/__tests__/check-runner.test.ts`、`check-runner-lifecycle.test.ts`、`artifact-version.test.ts`、`workspace-version.test.ts`。合同消费、SDK 资格及共享 fixtures 归 I／A 对应文件，不并行抢写。

## 保持与拒绝规则

1. 来源与实际执行对象通过正确原始路径取得；公开结构形状、文件名、stdout 或声明 exit 0 都不独立成为正式证据。
2. 执行器、脚本、argv、环境、读写对象、过程界限及终止观察按冻结 profile 执行，不静默开放网络、shell、子进程、写范围或敏感环境。
3. 正常未来产物缺失只影响定义阶段的计划表示，不能放宽实际结果捕获为“缺失也通过”。已有必需输入缺失、越 root／符号链接或来源未知仍停住。
4. spawn、timeout、cancel／kill ACK 不等于真实 close；未闭合状态必须保留未知，不自动重派。
5. 验证前后版本、generation 和潜在写入影响继续参与适用性；普通源码进展不补授权，也不让旧结果继续有效。
6. 不把任意报告 JSON 的语义提升成宿主实际观察，更不能为通过外部场景而移除原始登记、资格／版本或旧 reader 保护。

## 本线最小验收

在获准隔离样本内先验证原有有限 Node 路线，再验证精确的外部守卫／Python 路线。必须有成功来源与结果的正向证明，不能只跑拒绝用例。

负例至少包括伪造／复制结果、wrong owner／scope、输入或产物改变、缺失／恶意路径、超限、零／失败／跳过结果、cancel 后未 close、结果未知及旧 profile 兼容。

A 需要的基本定义捕获原语必须已经存在于 S 或旧基线；若本线发现必须改变其语义，通知 Main 更新公共基线和真实依赖，不能令 A 在成功 mock 上“并行完成”。

本线只跑本地 Vitest 中上述文件与冻结的代表样本，完整合同／控制组合和全量门留 V。若必要代表能力仍不支持，E 就仍有缺口，不得把“不支持”本身算作修复完成。

## 交接 I

交付真实候选身份、输入／结果原始取得方法、profile 能力表、已执行结果及未知、消费 API 与失败类型、兼容变化和确切 adapter 请求。只读报告可以辅助核对，不能替代这些来源事实。
