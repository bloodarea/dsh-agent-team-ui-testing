# 环境设置

打开 DSH 的 **设置 → UI 测试**。设置页管理目标环境与具体执行端。环境定义和各环境的依赖、运行配置见[目标环境定义与配置入口](target-environments.md)。

## 启用与选择

| 控件 | 作用 |
| --- | --- |
| 环境分组总开关 | 启用目标环境，例如 Web；关闭时分开关置灰，已保存的值保留 |
| 卡片「用户启用」 | 启用该运行环境，例如 Web 下的 Chrome 或 Edge、3D 下的 Blender。**同一目标环境同一时刻只启用一种运行环境**：打开一个会自动关闭同环境的其它（调试视图只对着一个目标）。Web 的执行端选择跟着开关走 |
| 「隐藏未实现」 | 仅筛选设置页展示；不改变启用配置、工具或 Skill |
| 卡片「诊断」 | 检查该目标的配置、依赖与连接，见[诊断流程](#诊断流程) |

分组默认收起，展开状态保存在浏览器本地。分组覆盖 Web、Linux、Windows、macOS、Android、TUI、HarmonyOS、游戏、3D 与小程序；具体框架和容器列在各组卡片中。环境能力范围见[目标环境实现（capability-tiers.md）](capability-tiers.md#3-目标环境实现)。

启用与可执行分别判断。尚无适配器的环境可以保存启用状态，可执行选择要求已接入适配器。环境内的配置和支持状态见[各目标环境的配置](target-environments.md#各目标环境的配置)。

调试面板的环境选择器列出「默认视图」与已启用的目标环境。任何选择都会通过 `POST /plugins/ui-testing/config/select`（带 `view` 字段）提交为**本会话的视图选择**，同时记进所属工作区；成功后更新显示，冲突或失败时保留原选择并提示。选择的解析顺序、按工作区隔离与默认视图的语义见[调试面板公共视图 · 视图选择](debug-panel.md#3-视图选择与默认视图)。

设置页只管"哪些环境可用于被选"，不保存"当前选哪一个"——后者属于会话。默认视图是空态视图，不出现在设置页分组里，也无法被停用。

## 配置保存与工具生效

配置由 Host 保存，设置页打开时读取、开关改变时提交：

| 接口 | 用途 |
| --- | --- |
| `GET /plugins/ui-testing/config?view=global` | 读取全局配置与 revision |
| `PUT /plugins/ui-testing/config` | 携带 `expectedRevision` 更新配置 |
| `POST /plugins/ui-testing/config/select` | 写入当前作用域的环境选择 |

提交成功后采用返回的 revision。遇到 `CONFIG_CONFLICT` 时显示冲突、采用最新 revision 并回滚本次改动，不显示保存成功。

环境总开关写入 `environments.<env>.enabled`，卡片开关写入 `environments.<env>.providers.<id>.enabled`。哪些环境有运行环境轴、每个 id 的工程支持度，由 Host 的 provider 目录决定；没有该轴的环境不接受 `providers` 写入（`CONFIG_INVALID`），参见[运行环境（provider）开关](target-environments.md#运行环境provider开关)。执行端的**选择**字段仍由环境定义，参见[各目标环境的配置](target-environments.md#各目标环境的配置)。

关闭 3D 总开关或 Blender 卡片开关会关闭全部 Blender 调试实例，实例中的未保存场景改动随之丢弃。重新启用后，Blender 按需启动。详见 [Blender 视口行为](three-d/debug-panel.md#视口行为)。

配置默认保存在 `${DSH_HOME}/ui-testing/config.json`，可用 `DSH_UI_TESTING_CONFIG_DIR` 覆盖目录。配置快照与适配器准入见[适配器接口（adapters.md）](adapters.md#12-三者使用统一的配置快照结构)。

启用配置决定工具的注册范围，当前会话的环境与能力决定执行准入；设置变更不需要重启 DSH。已注入对话历史的 Skill 正文不会自动移除，切换只影响后续轮次。完整规则见[架构（architecture.md）](architecture.md#配置驱动执行与上下文)。

## 诊断流程

1. 点卡片「诊断」，独立弹层会自动发起一次 `observe` 检查，**不会启动目标**。请求里带 `environment`（被诊断的目标环境 id），Host 按它诊断，不看面板当前的视图选择——面板停在默认视图时诊断 Web 仍然诊断 Web。
2. 需要启动目标并检查时，点「开始诊断」执行 `start`。启动、连接和实际检查项由环境适配器决定。
3. 查看「调试流程」中的阻塞阶段，再看「各模块诊断状态」与「诊断日志」。节点悬停提示提供完整原因和耗时。
4. 用关闭按钮、Esc 或点击遮罩退出；关闭会中止本轮检查。再次打开会执行新的 `observe`。

五个阶段依次检查宿主集成、插件 Core 与配置、通信接口、执行后端与依赖、目标列表与连接。结果有正常、警告、异常、跳过、未知五种；「警告」是已得到的结果。尚无结果显示「待诊断」，未能完成显示「诊断未完成」。中文与机器码的对应关系见[诊断状态码（diagnose-reason-codes.md）](diagnose-reason-codes.md)。

只有视图、没有 Agent 执行适配器的环境（`status: view`）在阶段 1/2 显示「跳过 · 该环境只有视图」，后续阶段随之前置跳过——这不是异常，也不表示工具被拒。目前所有已接入的目标环境都带执行适配器，因此不会出现这一状态。

### 诊断证据怎样判读

诊断通过 `POST /plugins/ui-testing/diagnose` 的 NDJSON 流逐阶段返回。六轴取自 `run-end.axes`，带 `source=run`、`runId`、`checkedAt` 与检查明细；无本轮结论时回退到注明来源的 readiness 快照。

各检查项的观测范围由环境实现决定。Web 的启动行为、检查项和证据范围见 [Web 诊断](web/browser-runtime.md#web-诊断)。

诊断期间暂停 readiness 轮询；结束后轮询只更新快照时间，不覆盖本轮结果。日志保留阶段状态、原因、`blockedBy` 与实测耗时；跳过项的耗时显示「—」。readiness 不能代替真实调用证据，实际调用以本轮 `actualCalls` 为准。复现测试与报告判读见[验证与贡献（verification.md）](verification.md)。
