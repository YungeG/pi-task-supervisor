# K：本轮实施契约与实际授权边界

记录日期：2026-10-27。源码起点 `0f8f5f83e01a9db1d1e2c4662046471797897ab0`。

用户在“只细化文档”之后另已明确回复“允许”，允许计划范围内的代码修改与隔离测试。本轮由 Main 单写者实施，不创建并行 worktree，不提交／推送、安装／重载／发布，不操作实际业务会话。原文档中的“不施工”是先前文档阶段的边界，不是本轮代码授权；新的授权也不消除技术契约和验证要求。

**本文件冻结下面的实施选择，不表示代码或正式验收已经通过。** 节点状态和候选身份仍由[施工索引](./README.md)维护。

## 1. P0／P1／P2 输入与证据边界

- P0 已核对当前 preflight、真实回应、合同绑定、实际 owner 和恢复入口；原路径先跑 1 个 native-boundary 小样本，再跑 3 个文件共 59 个用例，均通过。
- P1 已用固定 Python 3.13、`-I -S -B -c` 和私有临时目录做机械小样本，再跑 4 个场景：声明输入、外部检查器、SQLite／FD 清理、未声明读取／范围外写入／子进程拒绝。结果通过；尚未证明正式源资格或恶意代码隔离。
- P2 已有只读 UI 稿和现有 `HumanMaterial/DecisionDraft/NativeQuestion` 核对；网页稿不是原生 TUI 验收。
- 原始材料在 `/home/ygguo/agent-artifacts/pi-task-supervisor/approval-workflow-20261027-E3V0Hk/`。仅为本机产物，包含 `baseline-small.log`、`baseline-focused.log`、`python-profile-small.json` 和 `python-profile-cases.json`；不把这些结果扩大为新流程通过。

## 2. 联合材料使用已有提案，不重复塞进 16KB 预检

1. `propose_contract` 继续保存不受信的完整验收提案，可在只读 preflight 阶段提交；它不产生批准。
2. `PreflightProposal` 增加可选 `contractProposalId`，引用当前 preflight 的准确合同提案。仅保存该 ID，不把完整合同重复放进 16KB 方案。
3. 新建的正常规划显式标记 `approvalFlow: "consolidated-v1"`；缺完整合同材料时只记录待准备，不弹权限批准、不开放 Start。旧记录没有该标记时保持原语义，不能偷偷升级。
4. Host 解析实际分支中的提案与 sourceRef，验证目标、preflightId、原始 Goal 和完整条件；不可用模型给出的 hash／owner 替代来源。新 Goal 尚无独立 preflight 行时，只可将实际已提交 Goal 的准确 revision-0 seed 镜像为带原 scope 的物理元数据行，经读回和 lease 核对后再引用；不靠先问权限来制造来源。
5. `PreflightRequest` 可携带 host 产生的 `acceptance` 捕获：提案 ID／引用、workspace 身份、具体检查器／配置文件的冻结数据、执行描述和 pending check IDs。模型的提交 schema 不接受这些字段。
6. 完整计划、引用、捕获和权限选项共同进入原生 scope；容量保持有界，不裁条件或提高既有 64KB 保护上限。旧材料无新字段时保持原 canonical bytes／digest。

## 3. 前置定义与执行 owner 不混为一阶段

启动前的确认绑定真实预检来源与 host 捕获的检查器定义，不预造 Supervisor、产物字节版本或通过证据。

首次 Start 的顺序为：校验原始批准与当前捕获 → 保存独立 Start 控制／见证 → 建立 Supervisor 和原有 preflight started 关联 → 将已确认定义关联到该实际 owner → 全部成立后才 dispatch。

执行后的 `AcceptanceBoundFact` 增加 `authority.kind = "preflight-reviewed"`，引用实际权限控制与定义控制。reader 必须回到原始 preflight base、control、witness 和 Start source，核对完整 scope、选择、proposalRef、捕获及 planDigest，不能只看 authority 标签。

首个联合批准可同时产生业务权限和定义确认；后续仅检查定义变化时使用原生 `define/decline-definition` 控制，引用原业务批准，不重新收取或撤销未变化业务权限。必要事实或定义关联不齐时仍不执行。

## 4. 准备阶段采用未编译板，不放宽任意 task 门

`PreflightProposal.preparation` 显式声明待形成 check IDs、准备步骤及所需 permission IDs。只接受合同中已声明的 automatic checks 和已列出的权限，不接受未知检查器或隐藏范围。

- 现存检查器必须可捕获；待创建检查器只能在明确 preparation 中列为 pending，不能当作受信代码。
- 原权限与独立 Start 可以覆盖准备及后续范围。准备期间保留 draft／未编译任务板，允许 Main 按现有执行约定进行获准的普通工具准备；不新增自然语言权限沙箱。
- managed compile／claim／advance／run_check 在具体定义未确认前仍关闭。不得先编译准备任务再依赖旧的编译前绑定规则解锁。
- 准备完成后通过准确提案的原生定义审核冻结实际字节，继续同一目标和原 Start 意图，不重复启动，也不自动信任新生成代码。
- 原有用户暂停、撤销、其他 fault 和未知执行保留。仅新增明确归属于“等待本次定义”的技术 hold 可在本次原生审核成功后重新复核；不自动清除旧的泛化 advisor hold。

## 5. 版本与定义捕获

增加定义阶段捕获，读取已存在的输入／检查器／配置，声明输出路径但不要求正常未来产物存在；执行后的实际版本捕获继续要求产物存在。

外部检查器只通过每个 automatic check 显式声明的 `checkerRoot` 读取；root 必须绝对、规范、可核对，文件仍是明确相对清单。product workspace 不改变，不接受 `..`、模糊路径或隐式绝对输入。初次只读预检不因模型声明而读取 workspace 外文件：外部 root 在联合材料中标为待捕获，先确认精确读取／执行权限并独立 Start，再取得具体定义的必要确认。额外 profile 的 permission ID 必须准确选中，其权限 target 为实际 checker root；不能用不相关的旧许可获取外部字节。

`ArtifactScope.checkerScopes` 是可选的精确 `{checkId, root, inputs}` 清单；`ArtifactVersionV1.checkerWorkspaces` 相应携带 `{checkId, workspace}` 的实际 root 身份。逻辑文件键使用受保留的 `@checker/<encodeURIComponent(checkId)>/<path>`，保存在 version.inputs 中；新 scope 的普通 inputs／artifacts 不得冒充这些键。scope／version hash 和 generation 包含这些来源；没有新字段时保持旧 hash、旧路径解释和原执行器。

新的联合绑定及额外 profile 使用这一带角色 scope：`AcceptanceBoundFact.checkerScopes` 由宿主按实际定义派生，不接受模型提交；product inputs 从声明输入中扣除本地 checker／config 清单，checker 字节单独捕获。`AcceptanceDefinitionFact.checkerWorkspace` 与冻结文件一起进入定义摘要。只换具体定义不等于改变 product 输入／产物或重要验收条件；首次准备后尚无绑定时，也必须对照原联合确认的完整条件，不能借“首次绑定”偷换条件。

普通 product 输入／产物进展需要新验证证据，不因此重批未变业务权限；具体检查器、执行 profile、外部 root 或条件实质变化需要对应的新定义确认。发生在用户阅读期间的变化拒绝过期回应，不静默重试。

## 6. 有限 Python 路线

保留原固定 Node 路线。新增明确的 `python-unittest-v1` automatic profile，而不是任意 Python／shell 命令执行器：

- 固定 `/usr/bin/python3.13 -I -S -B <包内固定 host bootstrap 文件>`，只执行明示的同步 `unittest.TestCase.test_*` 方法 IDs，不 discovery／factory，不接受任意 shell 或外部命令。固定 bootstrap 拒绝 coroutine/generator/async-generator、异步生命周期及自定义内部执行派发；测试方法/cleanup 必须完成并返回 None，不能利用标准 unittest 的警告行为把未执行的函数体记为通过。机械原型使用 `-c`；正式实现改为带准确摘要的包内固定文件，避免在每条16KB事实和默认审核材料中重复塞入整段宿主源码，执行语义不扩大。
- script、checker files、checkerRoot、test IDs、timeout 和所需 permission ID 进入受信定义；扩大执行／外部 root 的 profile 需要联合预检中准确选中的权限，旧业务批准不能自动升级。
- stdin 的静态配置和 host bootstrap 有准确摘要；`check-profile.ts` 是共享 descriptor／schema 与固定 profile 编码源，不依赖控制状态。`nativePlanDescriptor` 可预览无 owner 的声明，`nativeCheckDescriptor` 与实际执行复用同一编码；预览不是执行或信任。`NativeCheckInvocation` 增加 `checkId/runtime/tests`，不得增加任意 executable／shell 字段。
- 每次运行在固定 `/tmp` 下由 producer 创建0700私有目录，不接受调用者指定写路径；实际目录、stdin 摘要和清理结果进入原始 `NativeCheckExecution.temporary`。静态 profile 描述带 interpreter／stdlib 身份、bootstrap 摘要和配置摘要，模型不能提供这些观测字段。
- 读取限于捕获文件及受信 stdlib（不开放第三方 site-packages），测试写入只允许 owned 临时范围；禁止网络、exec／fork、loader／环境注入和资源限额改写。只支持非 root Linux 的固定 interpreter，进程数量、内存、CPU、FD、文件大小和时间有界。FD 相对路径、SQLite 和 cleanup 必须真实验证。
- SQLite 的路径审核还要覆盖 ATTACH／VACUUM INTO、扩展加载与可改存储目录的 PRAGMA；不能只检查 connect 的主数据库路径。该限制仍不是针对恶意原生代码的安全沙箱。
- Python audit／资源策略仅适用于已审阅的良性检查器，不声称 OS 或恶意代码沙箱；不能据此执行不受信程序或扩大原业务许可。
- 框架产生准确测试数量、每项 case 的结果与失败／跳过信息；actual pid／close／exit、输出和版本由原始 producer 取得。仍通过原私有执行登记与资格链消费，不接收报告 DTO 代替执行。
- 已确认 close 后才回收自己创建的临时目录；close 或派发结果未知则保留诊断与阻塞，不自动重跑。

本 profile 的支持与拒绝、大小限制及实际来源须通过 E／I／V 的新验证；机械原型本身不证明全部守卫或正式资格。

## 7. UI、动作与恢复接缝

- 新联合界面产生有原始组件归属的局部选择草稿，只有受信 `requestNativeAnswer` 生命周期、真实完成握手及 current 校验才能转为 `NativeAnswer`；复制对象不能进入登记。
- 联合界面在同一次明确提交中选择准确权限并确认定义；不在之后再叠一个相同的权限弹窗。旧 UI 协议保持原行为。
- 完整材料与关键范围必须可核对；单列、滚动及稳定操作区只改呈现，不允许摘要或浏览标记成为新权威。
- C-ACT 的输出明确动作、参数、执行者、影响、剩余门和 blocked／unsupported；显示只读，执行入口仍对实际来源重新验证。不得推荐已知必定失败的动作，也不保证过期后仍可执行。
- 在第一条新协议 payload 之前写格式特征 `approval-workflow-v1`，同时保留／开启它依赖的 `acceptance-contract-v1` 与 `invocation-tree-v1`；旧 reader 不支持时必须拒读，不能按 legacy 接受。旧无新字段记录、字节和入口保持。
- 半写后只精确修复可证明投影／定义关联，不重新索取已完整确认的回答，不重放 Start 或未知执行。重开不自动 dispatch。

## 8. 实际修改与测试边界

新增 Module 仅限本闭环所需：`approval-schema.ts` 保存无 controller 依赖的 wire schema，`approval-bundle.ts` 保存捕获/核对与纯动作投影，不另建状态存储；拆分 schema 解决实际冷导入循环而非增加可选旁路。`approval-review.ts` 呈现与局部草稿，不生成权利；`check-profile.ts` 共享有限 profile 的描述、schema、编码、TestCase method ID 语法和能力检查，避免 producer/提案/codec 分叉；Python bootstrap 为包内固定 host 代码，不引入新依赖。

既有 preflight、acceptance journal／runtime、artifact／check runner、flow、native UI 和共享入口按施工索引分工推进；本轮由 Main 一人承担这些角色。必要精确类型、原生控制 variants、parser 与 consumer 同步修改，不允许先写新事实而 reader 不认识。

测试沿用已批准的真实命令、`submit_preflight/propose_contract/compile_tasks/run_check`、原生回应及现有 Module 接缝；新内部 helper 通过这些入口的行为与直接边界验证，不新增靠内部旁路通过的验收。

首个 RED：正常规划在首次 Start 前完成联合材料确认，正常未来输出尚不存在；当前代码应拒绝新提案字段或无法完成关联。已在公共 submit_preflight 入口观察到新字段被拒绝，记录于本机 `approval-workflow-red.log`；仍须 GREEN，并验证输出证据只在实际执行后产生。

保留历史 v1／v2 preflight 的测试 fixture 必须明确以旧记录／旧 host API 初始化，不用测试后门绕过新默认流程；新正常命令必须有独立真实入口与实际 CLI／PTY 正向证明。

现已形成冻结源码候选并通过索引列明的完整门、两个实际 SDK/CLI 分支、包装及旧 reader 拒读验证；精确范围见[验证记录](../supervisor-approval-workflow-validation.md)，不把中间样本拼接成最终结论。额外冻结了 `acceptance-journal.ts::assertCapturedApprovalDefinitions`：它只匹配元数据，不赋予来源资格；reader 与 producer 在派生写入前共用原冻结定义/工作区匹配，精确修复不得刷新代码或 profile。独立源码审阅 Q 已完成；首轮及随后发现经 Main 复现修复，最终复核 OK，Main 已核对当前候选身份/验证/保护项并完成 F；真人/产品接受不由自动化推断。

补充的冷恢复契约：`approval-bundle.ts::needsPreflightAssociation` 只派生“具体定义仍缺关联”的要求，`acceptance-runtime.ts::preflightAssociationIssue` 以当前owner的实际source-verified binding复核；恢复、命令派发、原生 settle review/continuation 与非只读业务工具不能仅因 transient journalFault 消失而放行；自然边界必须在任何 advisor 调用和预算消费之前复核，异步建议返回后再查关联门。原始明确pending-checker准备仍是不同路径，不混成关联故障；准确material-only proposal不需要不存在的权限请求，但不能携带批准/Start/定义控制。

后续针对性、整合、完整门、独立审阅和 Main 接受缺一不可；未获准的提交／安装／业务运行仍不执行。
