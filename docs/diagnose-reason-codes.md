# 诊断状态码（中英对照）

诊断页（设置页每张卡片的「诊断」）上出现的每个状态码都在这里对照：**英文码是机器契约，中文是给人看的**。

## 两种文字分居两处

**界面上只显示中文**；英文码是给调用方 agent 的，只出现在属性与 NDJSON 里，不挤进可见文案。

| 位置 | 界面可见（中文） | 给 agent 的英文 |
| --- | --- | --- |
| 节点状态 | `警告 · 未找到可执行文件` | `data-uts-node-state="WARN"`、`data-uts-stage-reason="executable-missing"` |
| 总览胶囊 | `警告 · 运行环境与所选 provider 不一致` | `data-uts-overall="WARN"`、`data-uts-overall-reason="provider-mismatch"` |
| 各模块诊断状态（六轴）的原因 | `未选择该运行环境` | `data-uts-axis-reason-code="provider-not-selected"` |
| 能力就绪的检查项（一行一项，最多三行，多余用 `+n`） | `只读求值：跳过` / `目标列表：跳过` / `快照：跳过 +3` | `data-uts-axis-checks-en="readonly-eval: skip · target-list: skip …"`、`data-uts-axis-checks-truncated` |
| 诊断日志 | `第 4 段 · 警告 · 没找到该浏览器的可执行文件` | `data-uts-event-operation="stage-4"`、`data-uts-event-reason="executable-missing"`、`data-uts-event-status="WARN"` |
| NDJSON 事件流 | — | 事件对象里的 `reason` 原样是英文 |

表里没有的码不猜：界面回落到原样显示英文码（不会显示错误的中文），这样宿主以后新增码也不会误导用户。

诊断日志左侧那一列同理：界面写 `本轮开始` / `第 3 段` / `本轮结束`，底层 id 仍是 `run-start` / `stage-3` / `run-end`（读 `data-uts-event-operation`）。

节点卡片里的文案会被截断（状态区固定两行）：把鼠标停在节点上，提示里按行列出角色·名称、职责、完整状态、原因码、阻塞阶段与耗时，被省略的内容都能读到。

## 术语对照（中文界面 / 英文底层）

下面这些词在界面上**一律用中文**；英文原样只出现在 `data-uts-*`、NDJSON 与代码里，供 agent 与排障使用。译文按上下文取用户能看懂的词，不做字对字直译。

| 英文（底层） | 界面中文 | 说明 |
| --- | --- | --- |
| `run` | 本轮 | 一轮完整诊断；界面上说「本轮」 |
| `Host` | 宿主 | 运行本插件的 DSH 进程 |
| `Failed to fetch` | 连不上宿主（请求失败） | 浏览器原话、对用户没有信息量，换成说清对象 |
| `stage-start` | 阶段开始 | 某一段开始检查 |
| `stage-end` | 阶段结束 | 某一段检查结束 |
| `readonly-eval` | 只读求值 | 在页面里执行只读表达式 |
| `target-list` | 目标列表 | 标签页 / 目标清单 |
| `snapshot` | 快照 | 结构化快照 |
| `screenshot` | 截图 | 截图 |
| `computed-style` | 计算样式 | 读页面的计算样式 |
| `network-read` | 网络记录 | 读最近几条网络请求 |
| `pass` | 通过 | 检查项通过 |
| `fail` | 失败 | 检查项失败 |
| `skip` | 跳过 | 检查项被跳过 |
| `ok` | 通过 | 就绪轴通过（与 pass 同译） |
| `PASS` | 正常 | 整段结论通过 |

## 五个结果状态（同样中英双语）

状态词与原因码一样，界面上**只写中文**，例如 `警告 · 浏览器未运行`；大写状态码只在 `data-uts-node-state` / `data-uts-overall` 等属性里。

| 状态（机器） | 中文（界面） | 含义 |
| --- | --- | --- |
| `PASS` | 正常 | 这一段真的通过了 |
| `WARN` | 警告 | 这一段跑完但有问题，后面跟原因码（如 `browser-not-running`） |
| `FAIL` | 异常 | 这一段失败，链路在这里断 |
| `SKIPPED` | 跳过 | 这一段没执行（上游已失败或 provider 不匹配），带 `blockedBy` |
| `UNKNOWN` | 未知 | 这一段没给出结论（例如超时、被取消） |

这五个词只表示**本轮诊断已经得出的结论**：`警告` 后面跟的原因码就是结论本身（「警告 · 未找到可执行文件」= 查出来缺可执行文件，不是等你操作）。

还没跑出结论时不借用五态的词，也**没有机器码**（它们只是本页的说明）：**待诊断**（这一屏还没跑过 run）、**诊断未完成**（run 没能跑出结果，错误另起一行）。操作步骤与证据判读见[环境设置（settings.md）](settings.md#诊断流程)。

> 面板四块的标题现在是**调试流程 / 各模块诊断状态 / 诊断日志 / 步骤职责**（步骤按 1–5 编号），右上角原来那几条英文装饰（`HOST RUN · STAGED CHECKS`、`THIS RUN · <runId>`、`HOST STAGES · 8 行`、`LOGICAL LAYERS`）已去掉；同样的信息在 `data-uts-run-id`、`data-uts-axis-source`、`data-uts-event-count` 这些属性里仍可读到。

## ① 诊断 run 的五个阶段

阶段编号：① 宿主集成/工具注册/调用通道、② 插件 Core/配置/调度、③ 通信接口探测、④ 执行后端与依赖、⑤ 目标列表/绑定/连接。

| 状态码（英文，机器契约） | 中文（界面显示） | 出现位置 |
| --- | --- | --- |
| `scope-unresolved` | 无法确定当前作用域（不知道要查哪个工作区） | 全部阶段（作用域未定时） |
| `registration-unreadable` | 读取工具注册信息失败 | 阶段 1 |
| `registration-broken` | 工具声明与实际注册对不上 | 阶段 1 |
| `tool-call-not-attempted` | 没能发起工具调用 | 阶段 1 |
| `tool-call-failed` | 工具调用失败 | 阶段 1 |
| `tool-not-admitted` | 本作用域未放行这些工具 | 阶段 1 |
| `config-invalid` | 宿主配置无效 | 阶段 2 |
| `adapter-unresolved` | 没取到该运行环境的执行适配器 | 阶段 2 |
| `no-runtime-entry` | 插件还没建立运行时入口 | 阶段 2、阶段 3 |
| `busy` | 插件正在处理别的操作，稍后再试 | 阶段 3 |
| `browser-not-running` | 浏览器未运行 | 阶段 3 |
| `provider-mismatch` | 实际在跑的浏览器与所选运行环境不一致 | 阶段 3 |
| `cdp-protocol-error` | 浏览器调试协议返回错误 | 阶段 3 |
| `cancelled` | 本轮检查已被取消 | 全部阶段（被取消） |
| `executable-missing` | 没找到该浏览器的可执行文件 | 阶段 4、六轴「依赖可用」 |
| `identity-mismatch` | 启动起来的浏览器不是所选的那一个 | 阶段 4 |
| `identity-unverified` | 拿不到浏览器版本信息，无法确认身份 | 阶段 4 |
| `blocked-by-provider-mismatch` | 上游运行环境不一致，这一段没执行 | 阶段 5 |
| `blocked-by-stage-1` | 第 1 段失败，这一段没执行 | 阶段 2–5（前一段失败时） |
| `blocked-by-stage-3` | 第 3 段未通过，这一段没执行 | 阶段 5 |
| `stage-timeout` | 这一段超时，没拿到结果 | 全部阶段（该段超时） |
| `target-list-failed` | 读取标签页列表失败 | 阶段 5 |
| `no-bound-target` | 还没有绑定调试目标 | 阶段 5 |
| `readonly-eval-failed` | 只读求值失败（在页面里跑只读脚本出错） | 阶段 5 |
| `readonly-eval-unexpected` | 只读求值的结果不是预期的 1 | 阶段 5 |
| `target-not-in-list` | 目标已不在标签页列表里（可能已被关闭） | 阶段 5 |
| `capability-partial` | 部分能力不可用 | 阶段 5 |
| `cold` | 浏览器还没启动 | 阶段 4、六轴「依赖可用」 |
| `host-idle-no-transport` | 宿主空闲，没有可用的传输通道 | 阶段 4、六轴「依赖可用」 |
| `session-missing` | 调试会话已不存在 | 阶段 4、六轴「连接可信」 |
| `aborted` | 已中止 | 阶段 3、阶段 4（被中止） |

## ② 就绪六轴的来源（`not-probed` 等）

诊断页第二块「各模块诊断状态」就是这六轴（工程支持 / 目标绑定 / 用户启用 / 能力就绪 / 依赖可用 / 连接可信）。它们来自 Host 的就绪快照或本次 run；没有 run 结论时回退快照，此时原因码是下面这些。

| 状态码（英文，机器契约） | 中文（界面显示） | 出现位置 |
| --- | --- | --- |
| `not-probed` | 未探测 | 六轴（未探测） |
| `probe-failed` | 探测失败 | 六轴「依赖可用」 |
| `environment-disabled` | 环境总开关已关闭 | 六轴（环境总开关关闭） |
| `adapter-not-registered` | 该环境还没接入适配器 | 六轴「工程支持」「能力就绪」 |
| `no-capabilities` | 没有上报能力清单 | 六轴「能力就绪」 |
| `no-runtime` | 宿主里还没有这个环境的运行时 | 六轴「连接可信」 |
| `no-target` | 还没有目标 | 六轴「目标绑定」 |
| `target-not-bound` | 目标未绑定 | 六轴「目标绑定」 |
| `target-unbound` | 目标已解绑 | 六轴「目标绑定」 |
| `target-gone` | 调试目标已消失 | 六轴「目标绑定」 |
| `cdp-not-attached` | 还没连上浏览器调试端口 | 六轴「连接可信」 |
| `collector-missing` | 缺少网络采集器 | 六轴「连接可信」 |
| `frame-source-missing` | 没有可用的帧来源 | 六轴「连接可信」 |
| `input-unsupported` | 该浏览器后端不支持模拟输入 | 六轴「连接可信」 |
| `provider-not-selected` | 未选择该运行环境 | 六轴（该运行环境未选中） |
| `provider-disabled` | 该运行环境已停用 | 六轴（该运行环境停用） |
| `provider-driver-pending` | 该运行环境的驱动待接入 | 六轴「工程支持」 |
| `provider-not-implemented` | 该运行环境尚未实现 | 六轴「工程支持」 |
| `provider-dependency-not-verified` | 还没验证该运行环境的依赖 | 六轴「依赖可用」 |
| `provider-missing` | 没有这个运行环境 | 六轴（该运行环境不存在） |
| `driver-pending` | 该运行环境的驱动待接入 | 六轴「工程支持」「依赖可用」 |
| `unknown-provider` | 没有这个运行环境 | 六轴（运行环境不存在） |
| `provider-unsupported` | 该运行环境不受支持 | 六轴「工程支持」 |
| `override-invalid` | 指定的浏览器路径不可用 | 六轴「依赖可用」 |
| `capability-disabled` | 该能力已关闭 | 六轴「能力就绪」 |
| `capability-unknown` | 未知的能力名 | 六轴「能力就绪」 |
| `no-session` | 没有调试会话 | 六轴「连接可信」 |

## ③ 页面自身造的两个码

不是 Host 的码，只是本页在没有结论时的说明。

| 状态码（英文，机器契约） | 中文（界面显示） | 出现位置 |
| --- | --- | --- |
| `no-run` | 还没有诊断结果 | 总览胶囊与节点（页面自身） |
| `run-in-progress` | 诊断进行中 | 总览胶囊（页面自身） |

## 动态族

| 模式 | 中文 | 说明 |
| --- | --- | --- |
| `tool-call-<ERROR_CODE>` | 工具调用失败 | 阶段 ① 用真实 handler 调一次 `browser_capabilities` 失败时，把工具错误码小写拼在后面，例如 `tool-call-tool_not_found` |
| `stage-<n>` | 该段没有给出原因 | 阶段 ⑤ 判断目标绑定时，该段既没 PASS 也没写原因，Host 用这个兜底 |

## 怎么维护

1. 客户端词表在 [`client.js`](../client.js) 的 `DIAG_REASON_ZH`；
2. 本文件的表格必须逐条一致；
3. `tests/contracts/diagnose-status-text.test.mjs` 会强制三件事：客户端表与本表相同、Host 侧能吐出的诊断原因码全部有中文、没有重复码。改词表就同时改这两处，否则测试失败。
