# 环境设置

打开 DSH 的 **设置 → UI 测试**。设置页管理目标环境与具体执行端，浏览器依赖见[浏览器运行配置（browser-runtime.md）](browser-runtime.md)。

## 启用与选择

| 控件 | 作用 |
| --- | --- |
| 环境分组总开关 | 启用目标环境，例如 Web；关闭时分开关置灰，已保存的值保留 |
| 卡片「用户启用」 | 启用该运行环境，例如 Web 下的 Chrome 或 Edge；不会自动切换当前执行端 |
| 「隐藏未实现」 | 仅筛选设置页展示；不改变启用配置、工具或 Skill |
| 卡片「诊断」 | 检查该目标的配置、依赖与连接，见[诊断流程](#诊断流程) |

分组默认收起，展开状态保存在浏览器本地。分组覆盖 Web、Linux、Windows、macOS、Android、TUI、HarmonyOS、游戏、3D 与小程序；具体框架和容器列在各组卡片中。环境能力范围见[目标环境实现（capability-tiers.md）](capability-tiers.md#3-目标环境实现)。

启用与可执行分别判断。尚无适配器的环境可以保存启用状态，但不能设为当前执行环境；卡片上的「未支持」「未接入」保留其含义。Firefox 当前不可启用；Edge 的真实启动验证范围见[浏览器执行端说明（browser-runtime.md）](browser-runtime.md#chromeedge-与-firefox)。

调试面板的环境选择器只列出已启用环境。没有视图实现的环境只切换本地视图选择，不提交 Host 的执行环境选择；公共尺寸和截图处理器仍复用当前 Host，具体边界见[公共空白画布（debug-panel.md）](debug-panel.md#32-其他目标环境与公共空白画布)。对已有视图的环境，面板通过 `POST /plugins/ui-testing/config/select` 提交当前会话选择，成功后才更新显示，冲突或失败保留原选择并提示。

Web 的当前 provider 按以下优先级解析：**会话 → 父会话 → 工作区 → 全局 → 默认 Chrome**。当前 provider 被禁用时保留选择并阻断执行，不静默改用另一浏览器。有效值可从 Host 状态中的 `resolved.provider` 读取；面板预览不按 provider 分栏。

## 配置保存与工具生效

配置由 Host 保存，设置页打开时读取、开关改变时提交：

| 接口 | 用途 |
| --- | --- |
| `GET /plugins/ui-testing/config?view=global` | 读取全局配置与 revision |
| `PUT /plugins/ui-testing/config` | 携带 `expectedRevision` 更新配置 |
| `POST /plugins/ui-testing/config/select` | 写入当前作用域的环境选择 |

提交成功后采用返回的 revision。遇到 `CONFIG_CONFLICT` 时显示冲突、采用最新 revision 并回滚本次改动，不显示保存成功。

环境总开关写入 `environments.<env>.enabled`；Web 的分开关写入 `environments.web.providers.<id>.enabled`，`environments.web.provider` 保存执行端选择。`enabledProviders` 是派生列表，不另行存储；缺少 provider 字段的旧配置按默认选择 Chrome 且 Chrome 启用处理。

配置默认保存在 `${DSH_HOME}/ui-testing/config.json`，可用 `DSH_UI_TESTING_CONFIG_DIR` 覆盖目录。配置快照与适配器准入见[适配器接口（adapters.md）](adapters.md#12-三者使用统一的配置快照结构)。

启用配置决定工具的注册范围，当前会话的环境与能力决定执行准入；设置变更不需要重启 DSH。已注入对话历史的 Skill 正文不会自动移除，切换只影响后续轮次。完整规则见[架构（architecture.md）](architecture.md#配置驱动执行与上下文)。

## 诊断流程

1. 点卡片「诊断」，独立弹层会自动发起一次 `observe` 检查，**不会启动浏览器**。
2. 需要启动目标并检查时，点「开始诊断」执行 `start`：冷态启动所选浏览器并创建受管调试页；已有连接时重新检查，不重启浏览器。
3. 查看「调试流程」中的阻塞阶段，再看「各模块诊断状态」与「诊断日志」。节点悬停提示提供完整原因和耗时。
4. 用关闭按钮、Esc 或点击遮罩退出；关闭会中止本轮检查。再次打开会执行新的 `observe`。

五个阶段依次检查宿主集成、插件 Core 与配置、通信接口、执行后端与依赖、目标列表与连接。结果有正常、警告、异常、跳过、未知五种；「警告」是已得到的结果。尚无结果显示「待诊断」，未能完成显示「诊断未完成」。中文与机器码的对应关系见[诊断状态码（diagnose-reason-codes.md）](diagnose-reason-codes.md)。

### 诊断证据怎样判读

诊断通过 `POST /plugins/ui-testing/diagnose` 的 NDJSON 流逐阶段返回。六轴取自 `run-end.axes`，带 `source=run`、`runId`、`checkedAt` 与检查明细；无本轮结论时回退到注明来源的 readiness 快照。

能力检查包含只读求值、目标列表、快照、截图、计算样式与网络元数据。截图只保留字节数、尺寸和哈希，快照只保留节点数与 id；这些检查不导航、不落盘，也不证明页面输入已生效。全通过显示可用，部分通过显示部分可用，冷态无连接时显示未探测。

诊断期间暂停 readiness 轮询；结束后轮询只更新快照时间，不覆盖本轮结果。日志保留阶段状态、原因、`blockedBy` 与实测耗时；跳过项的耗时显示「—」。readiness 不能代替真实调用证据，实际调用以本轮 `actualCalls` 为准。复现测试与报告判读见[验证与贡献（verification.md）](verification.md)。
