# H0 宿主来源与实施前置调查

2026-11-02 · **用户已允许隔离宿主源码/修改/构建/验证范围；源码基线和离线构建已核实。H0 v2 设计 READY；首轮实现审阅 BLOCK 的四项意见已修正，R2 完成 308 项相关测试、根检查、离线构建及两种 Node CLI 原生组合验证，R2 复审 OK、Main 核对相同指纹及 16 项测试后接受隔离 H0；B 仅进入实施约束准备。未替换安装或重载会话。**

## 1. 当前已核实的载体

| 载体 | 实际位置 | 事实 |
| --- | --- | --- |
| 仓库测试依赖 | `pi-task-supervisor/node_modules/@earendil-works/pi-coding-agent` | package 1.1.0，包含 dist/docs/examples，没有可编辑的完整源码工作树 |
| 当前 PATH 的 pi | `/home/ygguo/.nvm/versions/node/v25.9.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` | package 1.4.0；没有因此认定某个已运行会话加载该版本 |
| 真实验证的 1.4 CLI | 同包 `dist/cli.js` | 在隔离 PTY 中跑过 A 场景；未安装或修改该包 |
| 原包源码信息 | 两包 `dist/core/agent-session.js.map` | `sources` 指向 `../../src/core/agent-session.ts`，含 sourcesContent，可只读核对实现；不是已确认的可构建 Git checkout |
| 官方仓库声明 | 两包 package.json 的 repository | `https://github.com/earendil-works/pi.git`，子目录 `packages/coding-agent`；两份 package.json 均无 gitHead，不能虚构精确 upstream commit |

初次只读调查未找到完整工作树；用户明确允许后，现已从官方仓库在 `/home/ygguo/agent-projs/pi-human-interaction-host` 新建隔离副本，锁定 tag `v1.4.0` / commit `4a080252f06caf63a525d7873c5d94d3c23887e0`。初始工作树 clean；agent-session.ts 与 extensions/types.ts、runner.ts、loader.ts 均逐字匹配已安装 1.4 source map。node_modules 和已安装包仍只读，不是修改载体。

当前 packaged `dist/core/agent-session.js` SHA-256：

- 测试 1.1.0：`0ba5c847b4fd2fd838f71ea84885b9f3a4f15d9bf4b5493e2e88a41d1507e20b`。
- 安装 1.4.0：`436e8be3bbab2db475ce30bb5d0bb30f0046b19a3476f8cd57b8133e68891162`。

## 2. 已确认能力缺口，不是可绕过的门

1. 1.1 的 before-settle 仍属于活动 run；要求实际 idle 的控制不能在这里等待自己结束。
2. settled 中可登记 deferred 输入或发送，但旧公开 pending 和取消契约并不覆盖完整交付资格；普通 isIdle 不是“没有更早待执行输入”的证明。
3. 1.4 的发送实现虽有局部差异，实际类型和公开契约仍没有路线图 H0 的事件外一次性 action、完整 pending、可撤销交付及交付前原控制复核。版本较新或 A 的正常路径通过都不能补出这些能力。
4. 不读取/修改私有 deferred 队列，不用 timer/microtask 或函数注册顺序假装事件已退出，不让快捷键来源冒充完整资格。

A 现已按此限制保持新入口只读；B 接入尚未开始。

## 3. 已提出的授权请求与后续责任

Main 已在当前 Goal 执行中明确询问：是否授权**建立隔离的 Pi 宿主源码副本，并对宿主源码修改/构建/验证，不安装、不重载**。

当前状态：用户已明确回复“允许”，范围门已满足；它不替代实际设计与能力证据。隔离副本仅本地修改/验证，不替换已安装 Pi、不重载或操作业务会话。

Main 正按以下门推进：

1. 已确认该路径原先不存在；metadata-only clone 小样后 checkout 固定官方 tag，未覆盖或清理旧目录。
2. 已记录固定 commit、clean 状态及精确来源匹配；npm ci --ignore-scripts 不改锁文件。ignored 模型构建输入取自已安装同版发布包，官方 check:model-data 通过，未重写生成 TS。telemetry 构建小样后，原 build:offline 全链通过，未请求模型或安装生命周期脚本。
3. 读取该宿主仓库的 AGENTS/标准、扩展及 UI/lifecycle 文档和相应测试，冻结窄接口 packet；必要时复核源码 map 的来源差异。
4. 首轮三项 P1 已经 v2 定向独立设计复审 CLOSED / READY；[原始报告](supervisor-human-interaction-h0-design-review.md)和[复审](supervisor-human-interaction-h0-design-review-v2.md)均归档。随后完成候选实现；[首轮实现审阅](supervisor-human-interaction-h0-implementation-review.md)发现四项 P1，Main 核实后修正并补齐[更新验证](supervisor-human-interaction-h0-validation.md)，[R2 实现复审](supervisor-human-interaction-h0-implementation-review-followup.md)为 OK，Main 已完成相同指纹与 16 项测试复核并接受隔离 H0。
5. 独立源码工作树只保留一个写者，不修改 node_modules、全局包、当前 pi 命令或已运行会话；安装/重载仍另有批准门。

## 4. 下一份 H0 packet 必须冻结的接缝

以下是调查锚点，不是已存在的公共接口名字：

| 当前源码接缝 | packet 必须解决的问题 |
| --- | --- |
| `packages/coding-agent/src/core/agent-session.ts`：prompt、sendCustomMessage、run/settled、abort/clearQueue、session replacement | 所有相关输入可见；idle action 只能在事件退出/队列资格满足后交付；取消可撤销未交付意图；异步资格检查与实际启动间不留旧结果窗口 |
| `src/core/extensions/types.ts`、loader/runtime/runner 的上下文与生命周期 | 明确公开能力、返回值/失败分类、源/Session/branch/代际、一次性 handle 和实际 run 关联；无能力的旧宿主失败关闭 |
| 原生 UI 的公共上下文及交互生命周期 | 阻止或取消竞争确认，区分本 action 自己与其他 UI/输入；人工等待不借用 Advisor 超时 |
| 宿主有关单元/集成测试和真实 CLI 路径 | 更早 deferred 输入、UI 中新输入、后续 settled 回调中的取消、校验中变更、重复请求与未知结果不能产生陈旧或重复 run |
| 扩展 `runtime.ts`、`events.ts` 和原各控制模块 | 在合格 H0 上才接入 B；原权限/Start/定义/scope/恢复记录与预算门保持；没有 H0 的配置仅 A |

结果至少包含明确失败分类、完整队列归属、一次性可撤销交付，以及实际交付点再次验证。仅把现有 sendMessage 包一层或暴露 isIdle 不满足要求。接口决定还需实际源码和独立复审，不能让实现者临场选择授权语义。

## 5. 不可越过的完成条件

- 当前完成了来源/授权、设计复审、隔离候选实现及[所列本地验证](supervisor-human-interaction-h0-validation.md)；R2 独立实现接受及 Main 复核现已完成，但不是 B、安装或整体完成。
- 获准修改宿主仍必须先独立设计；批准不替代缺失的接口/竞争/原生验证证据。
- A 的独立实现验收可先完成；完整 Goal 继续保持未完成，直至 H0 和 B 按[原计划](supervisor-human-interaction-repair-plan.md)全部接受。
