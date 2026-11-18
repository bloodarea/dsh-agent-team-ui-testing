# 按任务披露工具

插件注册 **43 个执行工具 + 1 个发现工具 `browser_tools`，共 44 个**。这 43 个执行工具包含 `browser_state`、`browser_capabilities` 两个诊断工具。默认向模型发送的插件定义只有 **3 个**：`browser_tools`、`browser_state`、`browser_capabilities`。需要操作页面、网络、图像或动态帧时，Agent 先选择能力组，宿主在下一模型 step 发送对应定义。

## 注册、发送与执行

三者需要分别判断：

| 概念 | 含义 | 不能据此推断 |
| --- | --- | --- |
| 注册 | 插件向宿主登记完整工具实现与 schema | 当前模型请求已包含全部定义 |
| 发送 | 宿主每个 step 根据 `when(agent)`、环境准入、披露选择和工具白名单生成本步 `toolSet`，将定义交给 provider | 工具一定能在当前目标上成功执行 |
| 允许调用 | 本步 `toolSet` 允许该名字，且执行时通过环境授权、工具作用域、目标权限及 guards | 页面输入生效或断言通过 |

宿主必须支持按 step 过滤真实模型工具定义，并让执行使用同一份 `toolSet`。本步的 `toolSet` 冻结：在本步调用 `activate` 或 `reset` 不会修改已经发给模型的定义，也不会增加本步可调用名字；选择变化从**下一模型 step**生效。

披露不改变环境授权、工具白名单或 guards。插件保持发现与诊断入口可达，以便环境关闭时仍能说明原因；**宿主白名单仍可屏蔽这三个入口**，它们没有白名单豁免。若发现工具也被宿主屏蔽，需要调整宿主工具策略，不能绕过工具层调用内部 HTTP/CDP。

## `browser_tools` 的用法

只接受 `action` 和 `groups` 两个字段；`groups` 仅用于 `activate`。

| 调用 | 效果 |
| --- | --- |
| `browser_tools {"action":"status"}` | 读取当前 Agent 的选择、能力组目录及下一请求候选工具名；不激活工具、不启动浏览器 |
| `browser_tools {"action":"activate","groups":["basic"]}` | 累加选择基础组 |
| `browser_tools {"action":"activate","groups":["network","dynamic"]}` | 一次选择多组，自动加入依赖 `basic` |
| `browser_tools {"action":"reset"}` | 清空本 Agent 的选择，下一 step 回到发现与诊断入口 |

`activate.groups` 必须是非空数组，只能含 `basic`、`network`、`vision`、`dynamic`，最多四项。整次请求先检查所有组及依赖是否在当前环境/工具作用域下可用，再修改选择；失败不留下半次激活。工具白名单可以只允许一组中的部分工具，激活不会补齐被屏蔽的定义。

### 能力组

以下数量描述完整 Web 工具目录；实际发送结果仍受环境与宿主策略过滤。披露组是任务配方，与 T1–T4 的能力分类不完全相同。

| 组 | 本组工具数 | 自动依赖 | 用途 | 从默认状态选择后总数（含初始 3 个） |
| --- | --- | --- | --- | --- |
| `basic` | 15 | 无 | 页面导航、JS、截图、输入、样式、视口、标签、标注与 T2 结构化操作 | 18 |
| `network` | 9 | `basic` | 轻量网络、独立 HTTP 及网络 P0 七工具 | 27 |
| `vision` | 6 | `basic` | 静态图像处理、定位、差异、视觉输入、基线、断言 | 24 |
| `dynamic` | 5 | `basic` | 动态采帧、观察、分析、WAAPI 控制与事件关联 | 23 |

- `basic`：`browser_navigate`、`browser_eval`、`browser_screenshot`、`browser_input`、`browser_computed_style`、`browser_viewport`、`browser_tabs`、`browser_annotation`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`。
- `network`：`browser_network`、`browser_http_request`、`browser_network_session`、`browser_network_events`、`browser_network_detail`、`browser_network_trace`、`browser_network_control`、`browser_network_evidence`、`browser_network_subscribe`。
- `vision`：`browser_vision_image`、`browser_vision_find`、`browser_vision_compare`、`browser_vision_act`、`browser_vision_baseline`、`browser_vision_check`。
- `dynamic`：`browser_dynamic_session`、`browser_motion_observe`、`browser_motion_analyze`、`browser_motion_control`、`browser_dynamic_correlate`。

普通截图只需 `basic`；像素分析/视觉输入选 `vision`；纯视觉动态任务选 `dynamic`；**纯网络动态视图、视觉与网络关联需同时选 `network` 和 `dynamic`**。例如先选择两组，下一 step 才开始网络会话，再用其 ID 建立动态视图；选择组本身不启动网络或帧采集。全部组激活且无策略过滤时，共发送 39 个插件定义。

### 返回值与错误

`status`、`activate`、`reset` 返回同一状态形状：

| 字段 | 解释 |
| --- | --- |
| `environment` / `provider` | 当前配置解析出的环境与执行端 |
| `selected` | 已选择的组，包含自动加入的依赖 |
| `catalog` | 组的 `id`、用途、`requires`、本组 `count`、`available`；`available` 表示该组有环境与工具作用域允许的工具，不保证整组都允许 |
| `nextRequestTools` | 按当前选择、环境准入与插件可见作用域计算的下一请求候选名字；没有完整 schema，不是当前冻结的 `toolSet`，也不是最终权限裁决 |
| `effective` / `lifetime` | 下一 step 生效与 Agent 内存生命周期说明 |

`browser_capabilities.disclosure` 提供同样的披露状态，能力矩阵里对应 `web.tools.discovery`（`tool: "browser_tools"`，不占 Web 操作计数）。`adapter.declaration.registeredTools` 描述注册集合，`admittedTools` 描述环境准入集合；两者都不能冒充实际 provider 请求的发送列表。确认真实发送内容要检查 provider 请求中的工具定义。

| 错误 | 处理 |
| --- | --- |
| `INVALID_ARGUMENT` | 修正未知 action、额外字段或非 activate 上的 groups |
| `TOOL_DISCLOSURE_AGENT_REQUIRED` | 需要真实当前 Agent 身份；不伪造 Agent 对象绕过 |
| `TOOL_DISCLOSURE_UNKNOWN_GROUP` | 使用合法的非空组数组 |
| `TOOL_DISCLOSURE_UNAVAILABLE` | 查看目录、环境配置与宿主工具策略；整次选择不变 |

## 选择的生命周期

选择按 **Agent 对象**存于内存 `WeakMap`，不会写入用户会话或配置：

- 同一 Agent 的选择累加到显式 `reset`；每次页面动作后无需重选或重置。
- 任务阶段结束，先停止采集、恢复网络控制/WAAPI 等任务副作用，再显式 `reset`。披露 reset 只清工具选择，不停止采集、不清页面，也不撤销已执行动作。
- 环境、provider 或该 Agent 的有效准入配置变化会清空选择；仅其他 Agent 的无关配置变更、页面导航或标签选择不会结束本阶段。
- 父 Agent 的选择不由子 Agent 继承，各 Agent 独立激活。相同 session ID 也不能使新对象继承旧选择。
- 恢复得到新 Agent 对象、重挂/重载插件或重启宿主后，选择从初始状态开始；重新调用 `status`，按任务激活。

Host、工具 schema 和 Skill 修改需要重挂插件或重启 DSH。已经注入当前会话的旧 Skill 正文不会自动移除；验证新手册时应使用重新加载的新上下文。单纯修改本页文档只需重新打开文档。

## 已知限制

- **无自有页时的诊断**：`browser_capabilities` 在 Web 环境仍按会话页绑定执行，Agent 尚未 `browser_tabs open`/`select` 自己的页时会得到 `TARGET_NOT_BOUND`（这是既有的页归属行为，不属于披露机制）。此种状态下用 `browser_tools {"action":"status"}` 读取能力组目录与候选工具名：该入口不解析 Principal、不创建页面、不占租约。
- **已有 Skill 正文**：Agent 已经在上下文里加载的 Skill 不会被撤回；披露只影响后续模型请求的工具定义。
- **宿主白名单**：`ctx.tools.restrict()` 可以连发现与诊断入口一起屏蔽；插件不会绕过工具层。

## 复现与证据范围

在仓库根目录运行：

```bash
node tests/acceptance/progressive-disclosure.mjs
node tests/acceptance/check-skill.mjs
node tests/acceptance/check-skill-registry.mjs
```

渐进披露验收使用**确定性本地 HTTP 模型协议 fixture**，驱动真实 Agent 循环和 provider 发送路径；它可以核对默认定义、组选择、下一 step 生效、冻结调用集合、Agent 隔离与重置等行为。它不是远端模型推理，也不能证明供应商缓存命中、缓存计费或真实推理质量。实际报告、未运行项与退出状态以命令输出为准；这里列出复现方法，不预置通过结论。其他检查与报告判读见[验证与贡献](verification.md)。

面向 Agent 的最短操作手册见 [Web Skill](../skills/ui-testing-web/SKILL.md)，详细参数与能力契约见[工具参考](tools.md)和[能力分层与接口](capability-tiers.md)。
