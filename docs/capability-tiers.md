# 能力分层与接口

本文定义插件十个目标环境共用的 T1–T4 能力语义、接口边界、选路和证据要求，并按“目标环境 → 具体执行端”组织实现、协议与调用说明。当前实现位于 Web 下的 Chrome 小节；其他环境接入后在同一章增加自己的实现，不改变通用定义。三类适配器的完整对象接口见[适配器接口与接入](adapters.md)，工具名称索引见[工具参考](tools.md)。

阅读入口：[抽象定义](#1-四层能力的抽象定义) · [共同约束与选路](#2-共同约束与选路) · [目标环境实现](#3-目标环境实现) · [验证与新增环境](#4-验证与新增环境)。

## 1. 四层能力的抽象定义

| 层级 | 通用定义 | 观察对象 | 需要回答的问题 |
| --- | --- | --- | --- |
| **T1** | **状态与接口调试** | 程序暴露的状态、接口结果、日志与事件 | 当前状态是什么，接口或运行环节在哪里出错？ |
| **T2** | **结构与交互调试** | 可定位的界面结构、控件与交互状态 | 操作哪个对象，能否操作，操作后发生了什么？ |
| **T3** | **输出与呈现调试** | 有限张静态输出及其空间关系 | 指定区域的布局、颜色、形状或像素是否符合预期？ |
| **T4** | **过程与行为调试** | 连续观察、时间轴、事件和交互过程 | 状态如何随时间变化，过渡、运动或流程是否满足条件？ |

“程序化”“结构化 GUI”“静态视觉”“动态行为”是当前 Web 工具分组中使用的名称。上表的通用定义不要求其他目标环境提供 JavaScript、DOM、CDP 或浏览器标签页。

**T1–T4 是按问题选择的能力分类。** 可以直接用 T3 检查布局，也可以直接用 T4 检查过渡；不必先依次执行较低层。一次测试可以组合多层证据，任何一层也不自动证明其他层通过。

### 1.1 分层怎样落到真实接口

当前代码通过同一个 **CapabilityAdapter** 声明和执行操作，没有分别名为 T1Adapter、T2Adapter、T3Adapter、T4Adapter 的四套接口。各层操作共享以下调用形状：

```text
CapabilityAdapter
  manifest.capabilities / manifest.operations     声明能力与操作
  operationStatus({ session, snapshot })          查询操作状态
  preflight(args, operation)                      提供参数预检
  invoke({ operation, args, session, snapshot,
           signal, executionClass, context })
    -> Promise<{ value, evidence }>               执行并封装证据
```

`operation` 与参数由目标环境定义，`session` 来自 TargetAdapter，`snapshot` 提供配置与能力准入，P0Provider 提供需要的公共数据服务。上面是现有对象的接口摘要；下文各层的“读取、定位、比较”等是操作职责，不是额外存在的公共方法名。完整字段和生命周期见[CapabilityAdapter 接口](adapters.md#22-capabilityadapter操作声明准入与执行)。

T 层级、能力 id 与执行类别分别描述不同事情：

| 概念 | 决定什么 | 示例 |
| --- | --- | --- |
| 层级 | 用哪类观察和操作回答问题 | T3 输出与呈现调试 |
| 能力 id | 当前环境允许哪些操作 | Chrome 的 `web.t3` |
| 操作 id | 本次执行哪个具体功能 | `browser_vision_compare` |
| 执行类别 | 如何安排队列、目标就绪与租约 | `page`、`readOnly`、`independentHttp` |

同一层可以含只读、页面输入、独立请求和离线分析。不能从“T1 成本低”推断它只读，也不能从“T3/T4”推断每次调用都会启动目标。

### 1.2 T1：状态与接口调试

| 接口职责 | 输入 | 输出与证据要求 |
| --- | --- | --- |
| 读取状态与诊断 | 目标身份、状态查询或诊断项 | 实际读取值、来源、新鲜度；缓存与未检测值要标明 |
| 调用接口或求值 | 请求、表达式、参数、时限和返回预算 | 响应、错误、截断和执行上下文；工具完成与业务结果分别表达 |
| 观察日志与事件 | 已接入的数据源、查询范围 | 事件、时间与缺失边界；没有该数据源时报告不支持 |
| 底层控制 | 环境提供的导航、显示或原始输入参数 | 已执行动作、前后状态或派发事实；需要独立观察验证效果 |

T1 可独立完成接口和状态诊断。接口成功只能支持相应接口断言；外观、可操作性和完整用户流程需要对应的 UI 或过程证据。读取到应用自述也不自动成为独立旁证。

### 1.3 T2：结构与交互调试

| 接口职责 | 输入 | 输出与证据要求 |
| --- | --- | --- |
| 发现结构 | 目标、子树范围、深度与节点预算 | 有来源的结构、可定位引用、覆盖和截断信息 |
| 解析定位 | 引用或唯一定位条件 | 对象身份、当前代次；失效或多匹配须明确拒绝 |
| 检查并操作 | 对象、输入内容或交互动作 | 可操作性检查、实际输入机制、派发与部分应用情况 |
| 读取结果或等待 | 期望状态、观察对象、时限 | 当前状态或超时证据，不能只凭输入成功认定目标达成 |

目标环境提供自己的结构来源和输入方式。可用的结构不必是 DOM；缺少结构时应报告缺失并选择其他路径。T2 可以证明特定控件状态和交互反馈，颜色、呈现差异和连续运动需要其他证据。

### 1.4 T3：输出与呈现调试

| 接口职责 | 输入 | 输出与证据要求 |
| --- | --- | --- |
| 取得静态输出 | 目标采集请求、已存产物或基线 | 图像身份、尺寸、来源、时间与坐标映射 |
| 处理与定位 | 区域、处理参数、识别条件 | 处理结果、候选与坐标空间；候选不自动成为界面对象引用 |
| 比较与断言 | 待比较输出、基线、阈值、mask、外部事实 | 差异、断言结论、证据缺口与比较边界 |
| 按输出定位操作 | 可操作产物及坐标 | 派发前复验、命中与派发证据；动作完成后另外验证结果 |

静态输出只支持指定来源、区域、尺度和断言范围内的结论。两图能算像素差，不代表目标身份和几何映射适合验收；没有断言时，处理、识别或交付成功不产生通过结论。

### 1.5 T4：过程与行为调试

| 接口职责 | 输入 | 输出与证据要求 |
| --- | --- | --- |
| 建立有界观察 | 目标、数据源、时长、帧与事件预算 | 会话身份、来源、时钟、实测采样与完整性 |
| 查询过程记录 | 时间窗、帧或事件条件 | 带时间的记录、缺口、淘汰、截断及采样限制 |
| 分析过程 | 记录范围、过程断言和阈值 | 结论、时间分辨率、使用的证据与缺失条件 |
| 控制与恢复 | 平台声明支持的控制目标和动作 | 逐目标前后状态、已应用项与恢复结果 |
| 关联观察 | 操作、视觉或网络事件身份及窗口 | 关联依据与不确定性；时间相近不直接等于因果 |

T4 的核心是“过程是否被足够地观察”。请求的采样频率不能充当实测频率，缺帧或无时间基准不能证明没有异常。动作控制成功、观察到终态和全程满足要求是不同结论。

## 2. 共同约束与选路

### 2.1 支持、可用、执行和通过分别判断

适配器的操作状态分成 `support`（`supported / unsupported / planned`）与 `availability`（`available / unavailable / not-probed / busy`）。目标探测的六轴另用 `axes.<name>.status`，不能把两种结构混用；字段说明见[状态与证据约束](adapters.md#13-状态与证据约束)。

一次判断要区分：

1. **工程支持**：实现是否存在、操作是否已接线。
2. **配置准入**：环境、执行端与所需能力是否启用。
3. **现场可用**：依赖、连接、目标身份及资源是否满足要求。
4. **实际执行**：本次操作返回了什么，有哪些失败或部分应用。
5. **断言结论**：独立观察是否满足具体验收条件。

证据需要保留作用域、目标与代次、配置版本、来源、时间和不完整标记；跨目标、跨代次的引用不能直接复用。输入文本等字段是否脱敏由具体工具规定，不能把证据封装理解为自动脱敏。

### 2.2 选路与回退

| 问题 | 首选路径 | 何时补充其他证据 |
| --- | --- | --- |
| 接口报错、请求重复、状态异常 | T1；深度请求调查使用网络 P0 | 要验证实际界面反馈时补 T2/T3 |
| 点击、填写、提交、控件状态 | T2 的发现 → 操作 → 观察 | 结构无法定位时用 T3；涉及过渡时用 T4 |
| 布局、颜色、形状或基线差异 | T3，可直接进入 | 原因可能来自结构或样式时补 T1/T2 |
| 动画、闪烁、拖拽轨迹、过程时序 | T4，可直接进入 | 补终态 T2/T3 与网络证据，核对时间和身份 |

优先选证据充分、成本较低的可靠路径。引用失效属于定位问题，可刷新观察或升级；业务断言失败应保留为失败，不能换一种路径后抹去。跨层复用证据时需核对归属和新鲜度，不能只因属于同一任务就视为同一目标。

### 2.3 P0 怎样支持四层

P0 是横跨各层的五个数据家族，三类适配器是接入职责，T1–T4 是能力分类。它们不构成连续执行的流水线。

| 家族 | 共享职责 | Chrome 的使用例子 | 详细指南 |
| --- | --- | --- | --- |
| P0-A | 图像与采集产物 | T1 截图、T3 实时源；T4 复用采集与帧源设施 | [截图与图片交付](capture-p0.md) |
| P0-B | 网络事件、控制与证据 | T1 请求调查、T4 帧与网络事件关联 | [网络调试](network-p0.md) |
| P0-C | 显示空间与几何映射 | 共享视口、采集与输入坐标转换 | [视口、画布与标注](viewport-control.md) |
| P0-D | 人类与 Agent 共享标注 | 读取问题线索、在静态截图中叠加已提交标注 | [视口、画布与标注](viewport-control.md#标注) |
| P0-E | 目标投影与租约原语 | 页面组、选页与访问控制 | [多标签页](multi-tab.md) |

家族存在不等于每种方法都已接线；T4 帧查询也不代表经由 P0-A 的 `readFrame` 执行。公共模型与当前 Chrome 方法接线见[P0Provider 实现](adapters.md#34-chrome-如何实现-p0provider)。

## 3. 目标环境实现

十个目标环境共用前两章的能力定义。各环境有独立的实现位置，具体运行时、应用容器或执行端放在环境下面；实现接入后，在本章新增与 Web 平级的小节。目录中的环境覆盖范围与当前可执行范围分开表达：

| 目标环境 | 具体执行端与实现位置 | 当前实现状态 |
| --- | --- | --- |
| Web | [Chrome](#web-chrome)；其他浏览器按执行端另设小节 | 当前提供 Chrome 的实现说明 |
| Linux | Linux 原生桌面、Electron、Tauri 等，接入后独立成节 | 尚无真实目标适配器 |
| Windows | 原生桌面、.NET、WinUI 3、Electron、Tauri 等，接入后独立成节 | 尚无真实目标适配器 |
| macOS | 原生桌面、Electron、Tauri 等，接入后独立成节 | 尚无真实目标适配器 |
| Android | 原生、WebView、Flutter、React Native 等，接入后独立成节 | 尚无真实目标适配器 |
| TUI | 终端应用，接入后独立成节 | 尚无真实目标适配器 |
| HarmonyOS | 鸿蒙应用及相应容器，接入后独立成节 | 尚无真实目标适配器 |
| 小程序 | 各平台小程序容器，接入后独立成节 | 尚无真实目标适配器 |
| 游戏 | Unity、Unreal、Godot、Cocos 等，接入后独立成节 | 尚无真实目标适配器 |
| 3D | 三维应用及编辑工具，接入后独立成节 | 尚无真实目标适配器 |

环境与执行端的配置入口见[目标环境设置](getting-started.md#设置页)。下面只记录已有实现，不用未接入的配置卡片或 fake 契约夹具证明真实环境可用。

### 3.1 Web

<a id="web-chrome"></a>

#### 3.1.1 Chrome

目标环境为 `web`，执行端为 `chrome`，配置身份为 `adapterId:"web"`、`executionAdapterId:"web-chrome"`。Linux、macOS、Windows 是运行 Chrome 的宿主平台；它们作为原生桌面测试目标时，使用上表各自的环境位置。

Chrome 的实现目录：[T1](#web-chrome-t1) · [T2](#web-chrome-t2) · [T3](#web-chrome-t3) · [T4](#web-chrome-t4) · [注册与调用](#web-chrome-integration) · [能力发现](#web-chrome-discovery) · [跨层边界](#web-chrome-limits)。

<a id="web-chrome-t1"></a>

##### T1：JavaScript、HTTP 与页面运行状态

Chrome 的 T1 操作归入 `web.t1`，共有十个工具：

| 实现路径 | 工具 | 机制与返回边界 |
| --- | --- | --- |
| 页面控制与求值 | `browser_navigate`、`browser_eval`、`browser_input` | CDP 导航、`Runtime.evaluate` 与原始输入；导航返回不保证加载完成，派发不保证生效 |
| 页面数据读取 | `browser_network`、`browser_computed_style` | 已收集的轻量网络元数据、页面计算样式；样式值不能证明像素外观 |
| 图像与显示 | `browser_screenshot`、`browser_viewport` | CDP 截图及 Host 合成/校验、共享视口；截图本身不执行视觉断言 |
| 独立接口调用 | `browser_http_request` | Host HTTP(S) 客户端；不启动 Chrome、不使用页面 Cookie jar，`ok:true` 不保证 HTTP 2xx |
| 诊断 | `browser_state`、`browser_capabilities` | 缓存、运行态投影与能力报告；不启动 Chrome、不证明本次工具闭环通过 |

主世界 JavaScript 求值返回可序列化值或页面异常。这里没有独立的 Console 历史读取工具；不能把可执行 JavaScript 推成已提供完整控制台日志服务。

轻量 `browser_network` 保留元数据读取语义，不取页面队列与写租约。正文、WebSocket、SSE、控制、链路和证据导出使用独立的七个 P0-B 工具，对应 `web.network`，不计入十个 T1 工具。网络覆盖、正文三态及控制限制见[网络指南](network-p0.md)。

<a id="web-chrome-t2"></a>

##### T2：DOM / 无障碍快照与控件输入

`web.t2` 包含七个工具：`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`。

1. **发现。** Runtime 通过 CDP 读取主框架无障碍树并关联 DOM 身份，生成 `snapshotId`、`digest`、压缩树和 `refs`，同时报告覆盖与截断。
2. **定位。** ref 将快照中的可操作项关联到当前文档身份；主文档唯一 CSS selector 是另一条路径。引用失效或多匹配时拒绝操作，具体协议见下文。
3. **执行。** 点击、输入等动作按自身契约做可操作性检查，使用 CDP 真实输入。`combobox/slider` 使用原生 setter，并明确 `eventSource:"dom-control"`，不能称为可信硬件输入。
4. **验证。** 通过节点状态、等待条件和前后证据检查目标结果。`dispatched:true` 只证明输入派发；提交后是否成功需要另读反馈。

当前 ref/selector 操作覆盖主文档，AX 支持的 open shadow 内容可进入快照，iframe 内部不提供 T2 ref。面板的选元素功能有自己的 frame 边界，不应混当成 T2 覆盖。ref 生命周期、具体检查、表单类型与错误如下。

T2 证据使用 `evidence.version=1`，包含 `provenance / targets / before / after / dispatch / networkDelta / escalation / incomplete`；失败证据在 `BrowserError.details.evidence`。输入文本和可编辑控件值不回显。

###### 工作流

```text
browser_snapshot { depth:12, maxNodes:500 }
browser_click    { ref:"e12" }
browser_type     { ref:"e15", text:"hello", submit:true }
browser_wait_for { text:"已保存" }
```

`browser_snapshot` 返回 `snapshotId`、`digest`、压缩后的 `tree` 与 `refs`。`refs` 只包含树中显示的有效项；`generic` 包装节点不分配 ref，需要读它的状态时请用显式 `selector`。

<a id="web-chrome-t2-ref"></a>

###### Ref 协议

- ref 形如 `e12`，按快照单调分配，**永不复用**。
- 主框架跨文档导航、刷新、历史前进后退、执行上下文丢失都会让 ref 失效，此时返回 `REF_STALE`，重新 snapshot 即可。
- ref 表按工作区隔离，跨快照按 `(documentEpoch, backendNodeId)` 复用。
- 也可以直接用唯一 `selector`；命中多个返回 `TARGET_NOT_UNIQUE`。

###### 动作与可操作性

点击等输入动作在派发前滚动进视口、等待两帧稳定并做命中校验（含 open shadow 的 composed 命中）。滚动工具不自动滚入视口；状态读取与等待按各自的观察契约执行。

| 工具 | 关键约束 |
| --- | --- |
| `browser_snapshot` | `scope`/`maxNodes`(≤2000)/`depth`(≤32)/`boxes`；返回 `snapshotId`、`digest`、`refs`、`truncated` |
| `browser_click` | `ref`/`selector` 恰一；`button` 为 left/right/middle，`clickCount` 1–2，`modifiers` ≤4；滚动进视口、两帧稳定、命中校验后派发 CDP 真实鼠标事件 |
| `browser_type` | 仅原生文本输入与 textarea；`replace` 默认替换，`submit` 默认不提交；不回显输入 |
| `browser_scroll` | `direction` 与 `to` 恰一；目标须在视口内且稳定，否则零派发 |
| `browser_fill_form` | 1–20 个字段；`combobox`/`slider` 走原生 setter（`eventSource:"dom-control"`） |
| `browser_node_state` | 读取可见/启用/勾选/bbox 等；可编辑 `value` 恒脱敏 |
| `browser_wait_for` | 文本/消失/节点状态三类条件互斥；超时抛 `WAIT_TIMEOUT`，页面不关闭 |

`browser_fill_form` 先校验整批 1–20 个字段，再逐项执行；失败停止、不回滚，`details.applied/failedIndex` 说明部分应用。

`browser_fill_form` 的字段类型：`textbox`、`checkbox`、`radio`（只接受 `true`）、`combobox`（按 `option.value` 精确匹配，不打开原生下拉）、`slider`（须在 min/max 内且符合 step）。`combobox`/`slider` 走原生 setter（`eventSource:"dom-control"`），**不能声称 `isTrusted`**。

###### 错误

| 错误码 | 含义 |
| --- | --- |
| `REF_STALE` | ref 所属快照或文档失效 |
| `TARGET_NOT_UNIQUE` | selector 命中多个元素 |
| `NOT_INTERACTABLE` | 隐藏/禁用/零面积/离屏/被遮挡/持续运动；`details.reason` 说明原因 |
| `WAIT_TIMEOUT` | 等待超时，页面不关闭 |
| `INVALID_ARGUMENT` | 参数非法或条件互斥 |
| `BUSY` | 该页队列正被其他会话的写操作占用（短暂忙，不是权限答案）；只读工具不占写租约 |

只读的 `snapshot`/`node_state`/`wait_for` 同样受 BUSY 限制。

###### 边界

- 语义来源是主框架的无障碍树；跨 iframe 定位不在范围内。
- 快照树是压缩投影：`nodeCount` 与 `digest` 会随构建变化，跨版本差异不算回归。
- 需要呈现或过程证据时，按[选路表](capability-tiers.md#22-选路与回退)补充观察。
- 面板的「选择元素」见 [选元素加入聊天框](element-picker.md)：在预览中悬浮框选页面元素，点击把节点信息追加到聊天框；主帧与同进程嵌套 frame 都能命中（T2 自身的 ref/selector 仍只覆盖主文档）。

<a id="web-chrome-t3"></a>

##### T3：静态 PNG 处理、定位、比较与操作

`web.t3` 包含六个工具：`browser_vision_image`、`browser_vision_find`、`browser_vision_compare`、`browser_vision_act`、`browser_vision_baseline`、`browser_vision_check`。

Chrome 的实时源由 CDP 截图取得；已存 product 和受管 baseline 可以离线处理。图像核心在[静态视觉模块](../vision-t3.js)与[基线模块](../vision-baseline.js)，通过纯 JavaScript 实现裁剪、缩放、预处理、颜色/连通域/边缘/模板识别、YIQ 差异和基线管理。

**当前分析是确定性的，没有 VLM/OCR 或语义命名。** `semanticName` 恒为 `null`，定位候选不是 DOM 身份；`similarity` 是阈值化像素差异的覆盖指标，不能作为语义相似度。算法只对指定来源、区域、分辨率与阈值负责，不证明业务、可访问性或整页正确性。

按截图执行 `browser_vision_act` 时，产物必须属于当前 scope、采集不超过 30 秒、匹配 Runtime/页面/文档代次且具备可操作映射。运行时依次复验现场几何、同区域 RGBA hash、视口与 DOM 命中稳定性，再派发真实输入并采集 after product；任一前置条件失败都零派发。该工具固定返回 `INCONCLUSIVE(dispatch-only)`，不能当作视觉验收通过。

比较与断言遵守以下规则：

- 两图像素尺寸必须一致。几何映射不兼容时返回 `BLOCKED(mapping-incompatible)`；像素比率仍可作为附加数据读取，不能作为几何验收通过的依据。当前 `browser_vision_compare` 的 schema 虽声明 `bitmapOnly`，参数校验尚未接通，显式传入会被拒绝，不能依赖该参数绕过门禁。
- `required` 事实缺失或来源不匹配返回 `INCONCLUSIVE/BLOCKED`；`advisory` 事实最多给 `WARN`。调用方事实标为 `trusted:false`，T3 不重新查询 DOM。
- 全 mask、没有有效分母时返回 `VISION_EMPTY_COMPARISON`。证据截断若丢失必需依据，PASS 降为 `INCONCLUSIVE`。
- T3/T4 分析结论的聚合优先级为 `FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS`。`browser_vision_check` 与 `browser_motion_analyze` 的 `exitCode` 为：存在 FAIL 时 1，否则有 BLOCKED/INCONCLUSIVE 时 2，其余 0。是否通过看具体断言的 `verdict`，不能只看 `ok:true`。

成功证据在 `evidence.vision.version=1`，失败在 `BrowserError.details.evidence.vision`。源图类型、坐标、预算、基线与调用示例如下。

<a id="web-chrome-t3-source"></a>

###### 源图

```text
Source = { kind:"live", scale?:0.1–4, region?:画布CSS Rect（O=0 时与文档相同） }
       | { kind:"product", productId:"v1_<32hex>" }
       | { kind:"baseline", name, revision? }
```

- 不接受任意文件路径、URL、附件 ID 或调用方 base64，也不从附件服务反读图像。
- `live` 省略 `scale` 时使用本次调用开始时冻结的共享 `view.scale`。
- T3 原始源图不含面板标注；`browser_screenshot` 的 `includeAnnotations:true` 不传播到 T3。用户指代面板标注时，先读 `browser_state.annotations` 并用带标注截图查看，详见[截图与图片交付](capture-p0.md)。T3 的 `annotations` 仅给输出图片添加后处理标记。
- `product` 按工作区隔离：每 scope 16 张、合计 128 MiB、单张 32 MiB / 16M 像素；页面导航或关闭后仍可离线分析，但 `act` 的可操作资格失效；不跨重启恢复。

<a id="web-chrome-t3-tools"></a>

###### 六个工具

| 工具 | 用途 | 关键约束 |
| --- | --- | --- |
| `browser_vision_image` | 裁剪、缩放、预处理、统计、识别、标注并交付 PNG | 处理顺序固定：source → crop → resize → preprocess → 统计/识别 → 标注 → 编码；分析与识别在标注之前 |
| `browser_vision_find` | 颜色/连通域/边缘/模板定位 | 无匹配是**成功空列表**；`semanticName` 恒 `null`，候选不是可操作 ref |
| `browser_vision_compare` | 两图 YIQ 差异与标注差异图 | 必须显式提供 `before/after`；可选 `region/masks/options/thresholds/output`；`bitmapOnly` 当前会被参数校验拒绝，尺寸与映射门禁见本节前述规则 |
| `browser_vision_act` | 按截图坐标派发真实输入 | 六步校验全过才派发，任何一步不过**零派发**；`verdict` 固定 `INCONCLUSIVE(dispatch-only)` |
| `browser_vision_baseline` | 受管基线的增删改查 | 不可变 revision、HEAD CAS、删除是墓碑 |
| `browser_vision_check` | 回归与六类缺陷用例 | 整批先纯参数校验再逐 case 执行；不导航、不建基线、不读 DOM |

###### 比较输出

差异算法固定为 `yiq-v1`，输出完整尺寸的标注 PNG：红色表示差异、黄色表示抗锯齿、灰色表示 mask、蓝色表示区域 bbox。边缘识别使用 Sobel；识别与比较的结论边界见本节前述规则。

###### 坐标与基线存储

- `find` 的候选坐标始终相对完整源图（ROI 原点已回加）；`documentCss` 由 mapping 换算，可为负；blank 区域 `documentCss=null`。
- 基线位于 `<持久根>/output/vision-baselines/<scopeHash>/<name>/{images,heads}`；HEAD 是连续 revision + 父 hash 链；读取时校验 PNG hash 与元数据，损坏报 `READ_FAILED`。

###### 结论与证据字段

`evidence.vision` 的字段为 `provenance/source/coordinateSpace/regions/metrics/baseline/facts/verdict/dispatch/output/escalation/incomplete/truncated`。证据预算为 262144 字节，超过时截断并标记；调用方应保留 `incomplete/truncated`，不要只摘取 verdict。

###### 推荐流程

```text
browser_vision_image      # 取 product + 统计
browser_vision_find       # 可选：确定性定位
browser_click / browser_vision_act   # 执行动作
browser_vision_image / browser_vision_compare   # 前后对比
browser_vision_baseline create → browser_vision_check   # 建基线并做回归
```

###### 颜色参数的写法

识别/缺陷类参数里的颜色（`color`、`background` 等）一律是**整数数组**：`[r,g,b]` 或 `[r,g,b,a]`，每通道 0–255；写成 `{r,g,b}` 对象会返回 `INVALID_ARGUMENT`，detail 为 `expected-rgba-array-3`（或 `-4`）。`tolerance` 是可选整数。

###### 错误

| 错误码 | 含义 |
| --- | --- |
| `VISION_SIZE_MISMATCH` | 比较的两图尺寸不同 |
| `VISION_EMPTY_COMPARISON` | 全部被 mask，无有效分母 |
| `VISION_HIT_MISMATCH` | act 复验失败（含 `blank-area`） |
| `VISION_STALE_IMAGE` | 截图过期，需重新采集 |
| `VISION_BASELINE_CONFLICT` | 基线 CAS 不匹配 |
| `VISION_BASELINE_NOT_FOUND` | 基线不存在 |
| `INVALID_ARGUMENT` | 参数或源图非法 |

###### 边界

- 基线目录守卫不抵抗本地恶意进程的 TOCTOU，也不保证网络文件系统上的 CAS。
- 跨 Node/zlib 版本只保证解码像素一致，不保证压缩字节相同。

<a id="web-chrome-t4"></a>

##### T4：帧序列、动画与事件关联

`web.t4` 包含五个工具：`browser_dynamic_session`、`browser_motion_observe`、`browser_motion_analyze`、`browser_motion_control`、`browser_dynamic_correlate`。

| 接口职责 | Chrome 实现 | 主要边界 |
| --- | --- | --- |
| 会话与采集 | `dynamic_session` 选择 `screencast` 或 `screenshot-loop` | 有界时长/帧/字节预算；不承诺固定 fps |
| 观察 | `motion_observe` 查询已存帧与事件，可交付指定区域 | 默认只读；`fresh:true` 是显式真实采样动作；原图查询不自动生成 T3 product |
| 分析 | `motion_analyze` 对已存证据离线执行七类断言 | 不采新帧；缺证据不能补成 PASS |
| 控制 | `motion_control` 操作 WAAPI 动画并回读 | 支持 pause/resume/seek/rate/restore；不承诺冻结整个 Chrome，media 适配器不可用 |
| 关联 | `dynamic_correlate` 查询六向操作/视觉/网络关系 | 复用网络 P0；固定 `INCONCLUSIVE(no-assertion)` |

七类断言为 `frame-diff / region-change / flicker / freeze / jank / trajectory / transition`。分析、时钟、存储和关联核心在[动态行为模块](../dynamic-t4.js)，Chrome 帧源与 WAAPI 控制在 Host Runtime。

**采样与时间真实性：**

- `screencast` 复用面板唯一的 CDP JPEG 流，按页面损伤出帧（`damage-driven`），可能间隔不均或长时间没有新帧；不是固定渲染帧率。
- `screenshot-loop` 用 PNG 单飞采样（`host-scheduled`），记录真实采样区间。没有呈现时间戳，`sourceTimestamp:null`，不能用接收时刻冒充源时间。
- `sampling.requested` 是请求，`sampling.measured` 才是已存帧推导的实测结果。数据不足用 `null`；统计窗口最多 240 个已存帧，超出带 `sampling-window-bounded`。
- dropped、evicted、gaps、缺时间戳和解码失败影响证据完整性；16 ms 等短暂异常可能采样不到。低采样或无采样不得证明“无异常/未发生”。
- `flicker` 在最终准备给出 `no-flicker` 时，若没有可测时间基准，或实测中位间隔粗于 `maxDurationMs`，返回 `INCONCLUSIVE(insufficient-temporal-resolution)`。已观察到变化但亮度低于阈值（`brightness-below-threshold`）、或持续时间过长（`flicker-too-long`）的分支仍可返回 PASS。freeze/jank/transition 当前只在 `metrics.sampling` 与 `limitations` 披露粗采样，不自动改写 PASS/FAIL；报告结论时须同时说明这些限制。

**控制与关联的证据：** 控制逐目标返回 `before/after`、部分应用和恢复状态；外部已改变动画时不强行覆盖恢复。`explicit / redirect / initiator` 才能形成 confirmed-causal，时间邻近默认过滤。页面账本属于 `page-declared`，需要独立旁证；关联头默认脱敏，不能独立核验 header 身份。

会话动作、采样字段、预算、帧查询和控制参数如下。能力发现中的 `dynamic.assertions` 提供机器可读的七类断言规格，`dynamic.sampling` 说明采样语义。

###### 会话

```text
browser_dynamic_session { action:"start", config:{ captureVisual:true, source:"screencast", durationMs:3000 } }
```

- `captureVisual:true` 必须显式选择 `source:"screencast"` 或 `source:"screenshot-loop"`；两者的编码、时钟和采样机制见本节前述说明。
- 两种帧源均不含面板标注；`includeAnnotations` 仅用于 `browser_screenshot`，不改变 T4 采帧。用户指代标注时另读 `browser_state.annotations` 并截取 `includeAnnotations:true` 的静态图片，不能把它作为 T4 帧序列证据。
- `captureVisual:false` + `networkSessionId` 建立**纯网络关联视图**：不启动采集、不采帧。
- `action` 支持 `start`/`stop`/`status`/`reset`/`extend`。
- `extend` 只对 `running` 会话生效：单次 ≤ 60000 ms，自 `startedAt` 累计 ≤ 300000 ms；`stopped`/`retained` 返回 `DYNAMIC_SESSION_NOT_ACTIVE`，**不会复活会话**。
- `fresh:true` 与幂等 `start` **不续期**；`stop`/`reset` 会尽力恢复本 scope 的全部未结控制。
- start/status/extend/stop 的 `session.sampling` 给出实测采样，字段见下文[采样字段](#web-chrome-t4-sampling)。

<a id="web-chrome-t4-sampling"></a>

###### 采样字段

每个会话（start/status/extend/stop、`browser_motion_observe` 顶层、`evidence.dynamic.sampling`）都返回同一块 `sampling`：

| 字段 | 含义 |
| --- | --- |
| `mechanism` | `screenshot-loop` / `screencast` / `network-only`（`captureVisual:false` 无像素采样） |
| `cadence` | `host-scheduled`（screenshot-loop 定时循环） / `damage-driven`（screencast 按页面损伤出帧） / `none` |
| `requested.intervalMs` / `requested.source` | 只是**请求值**：screenshot-loop 为 `setInterval(host)`；screencast 为 `null`（无目标周期） |
| `measured.frames` / `measured.intervals` | 有效采样点数与间隔数 |
| `measured.p50Ms` / `p95Ms` / `minMs` / `maxMs` / `meanMs` | 实测间隔统计（毫秒） |
| `measured.windowMs` / `effectiveFps` / `measured.from` | 采样跨度、由实测间隔推导的真实 fps、时间基准（`loop-tick-start` / `frame-timeline`；两者都来自已存帧记录，与 `browser_motion_observe` 返回的帧集合同源） |
| `counters` | `sampled`（screenshot-loop=tick 采样数，screencast=收到帧数）/ `dropped` / `evicted` / `samplingFailures` |
| `limitations` | 数据不足、采样窗口有界、缺时间戳等如实标注 |

- screenshot-loop 用**已存帧上的循环 tick 起点**（`receivedMonoMs`）实测间隔：与 `browser_motion_observe` 返回的帧集合同源，`measured.frames/intervals/p50Ms` 可与该次 observe 的帧逐一核对。单飞；错过的 tick 只计入 `samplingFailures`，不伪造帧/间隔；内部仍保留有界 tick 轨迹（最多 240 个）供诊断，但不参与 `measured` 统计。
- screencast 使用已存帧的 `timelineMs` 间隔（与 observe 同源）；缺时间戳带 `frames-missing-tick-start` / `frames-missing-timeline`。

###### 帧与完整性

| 预算 | 默认 | 上限 |
| --- | --- | --- |
| 会话时长 | 3000 ms | 60000 ms |
| 保留帧 | 180 | 300 |
| 帧字节 | 32 MiB | 64 MiB |
| 单帧像素 / 字节 | 4M px / 8 MiB | — |
| 事件 | 5000 | 20000 |

帧存储有界：淘汰、丢弃与空档全部计数（`dropped`/`evicted`/`gaps`），不会静默丢证据。每帧保留原始 `sourceTimestamp`（缺失记 `null`，不伪填），编码 hash 与 RGBA hash 分列。

###### 观测

```text
browser_motion_observe { motionSessionId, sinceSeq:0, limit:50 }
browser_motion_observe { motionSessionId, includeImages:true, region:{x,y,width,height} }
```

- 默认查询已存记录，不 ensure、不续租、不启动浏览器。`fresh:true` 是显式页面采样动作，只允许当前活动视觉会话，并返回真实采样区间。
- `cursor`/`sinceSeq`/`window`/`frameIds` 互斥；`includeImages` 最多 3 帧。
- **`region` 只交付该矩形**（帧图像像素 `image-px`，PNG，需配合 `includeImages`）：用于「只看动画那一块」，避免把整页内容喂给 Agent；不带 `region` 时按存储的原始编码交付整帧且不解码。注册 JSON schema 已列出 `region`（`x/y/width/height` 非负整数，`width/height ≥ 1`），与 handler 行为一致。
- 顶层返回 `sampling`（与会话块同一结构），并在 `evidence.dynamic.sampling` 内附同一块；即使会话已停止、帧被淘汰，也能读到实测采样节奏。
- 越界、负值、零面积，或给了 `region` 没给 `includeImages` → `DYNAMIC_INVALID_ARGUMENT`，不 clamp、不静默忽略。

###### 分析

七类断言与采样不足时的结论边界见本节前述说明，聚合规则见[T3 比较与断言](#web-chrome-t3)。`browser_motion_analyze` 的调用约束：

- `window` 与 `frameIds` 恰一；单次最多 20 条断言，分析已存帧，不采新帧。
- 预算耗尽或超时如实返回 `BLOCKED(dynamic-timeout)`，并给出 `budgetUsedMs`/`budgetSplitMs`。
- `complete:false` 带缺失时间戳、空档或解码失败等原因。
- flicker/freeze/jank/transition 的 `metrics.sampling` 给出实测间隔；粗采样附 `limitations:["sampling-coarser-than-assertion-window"]`。`flicker.maxDurationMs` 默认 100 ms；无可测间隔时 `metrics.sampling.insufficientReason="no-interval"`。判决处理见本节前述说明，不把所有断言的低采样行为视为相同。
- 断言规格可发现：`browser_capabilities.dynamic.assertions` 直接投影纯核心导出的 `MOTION_ASSERTION_SCHEMA`（七类的 `allowed`/`required`/字段类型、枚举、`thresholds.allowed/defaults`、`maxAssertions`、`idPattern`）；`dynamic.sampling` 说明 requested/measured 语义，顶层 `limitations` 明示低采样声明。

###### 控制

`browser_motion_control` 对 WAAPI 动画做真实时间轴控制：

```text
{ motionSessionId, action:"pause", adapterId:"waapi", targetIds:["#orb"] }
{ motionSessionId, action:"seek", adapterId:"waapi", targetIds:["#orb"], timeMs:500 }
{ motionSessionId, action:"rate", adapterId:"waapi", targetIds:["#orb"], rate:0.5 }
{ motionSessionId, action:"restore", restoreToken }
```

- `targetIds` ≤ 20；支持 `waapi-N`、动画 id 与 CSS selector；多匹配 `TARGET_AMBIGUOUS`，未知 `TARGET_NOT_FOUND`。
- 逐目标回读 `before`/`after`，返回 `applied`/`failedIndex`/`restoreStatus`。
- `restore` 使用 `restoreToken`；若外部已改动则报 conflict，不覆盖。

###### 关联

`browser_dynamic_correlate` 在帧与网络事件之间做六向关联：

```text
operation→visual  operation→network  network→visual
visual→network    network→network    visual→visual
```

- `includeTemporal:true` 才返回时间邻近候选；没有共同 ID 的关系保留在 `observed/temporal/unresolved`，因果边界见本节前述说明。
- 候选预算 `maxCandidateCompares=40000`；同域候选先按时间窗预筛。超出预算如实返回 `candidate-budget-exhausted` 与 `truncated:true`。

###### 推荐流程

```text
dynamic_session start → 执行被测操作（点击、拖拽或导航）
→ motion_observe 定位帧
→ motion_analyze 跑断言
→ motion_observe {region, includeImages} 只看目标区域
→ motion_control 消融验证
→ dynamic_correlate 与网络时序对齐
```

<a id="web-chrome-integration"></a>

##### Chrome 的注册、准入与调用

###### 能力怎样接入

[公共能力目录](../core/contracts.js)登记 `web.t1 / web.t2 / web.t3 / web.t4`；[Web 适配器](../targets/web/adapter.js)的 `WEB_TOOL_OPERATIONS` 把操作映射到能力 id，`WEB_TOOL_OPERATION_SPECS` 提供执行类别声明。网络、标签和标注分别使用 `web.network / web.tabs / web.p0.annotations`。

工具总数为 **37**：10 T1 + 7 T2 + 6 T3 + 5 T4 + 7 网络 + 1 标签 + 1 标注。其中 `browser_state`、`browser_capabilities` 是常驻诊断；它们虽然列在 Web 的 T1 表中，注册与禁用环境诊断有专门分支。

```text
Host apply()
  → 跨环境组合根加载配置，解析环境/Chrome 开关与配置快照
  → 按需创建并注册 Web 的三类适配器
  → declarableToolNames() 决定工具注册面
  → 逐 Agent 的 when 与执行入口检查当前环境和能力
  → invokeTool() 创建目标会话并按需绑定
  → CapabilityAdapter.invoke(operation, ...)
  → 注入的 dispatch → context.execute() → 工具 handler
  → Chrome Runtime / 独立 HTTP / 离线分析
  → 工具结果与证据，finally 释放调用会话
```

上图的目标会话与 CapabilityAdapter 分支适用于普通能力操作。`browser_state`、`browser_capabilities` 在 `invokeTool()` 内直接执行诊断 handler，跳过目标会话创建与能力适配器调用。

T 层级不决定调用分支。Host 根据具体操作和动作安排队列、ensure、访问控制与租约；普通点击、独立 HTTP、缓存诊断、离线图像与网络查询各有边界。适配器 `preflight()` 是可用接口，当前 `invokeTool()` 不自动调用它，工具包装层另行做参数预检。

注册面控制模型看得到的 schema，会话准入控制当前 Agent 能否执行；`when=false` 本身不保证移除工具声明。注册、配置身份、Skill 和点击/截图两条完整调用链见[Chrome 的注册与调用链](adapters.md#4-chrome-的注册与调用链)。

<a id="web-chrome-discovery"></a>

###### 怎样判断当前可用

先调用 `browser_capabilities`，再按需要取得真实观察和执行结果：

| 报告内容 | 读取方式 | 能证明什么 |
| --- | --- | --- |
| 适配器状态 | `adapter` 中的能力、P0 家族、六轴与 declaration | 配置、支持、准入和探测结果；不等于业务通过 |
| Web 工具状态 | `capabilities[]` 的细分 id、tool、status、constraints | Web 返回的 `available / unavailable / unsupported` 投影与限制；不是通用适配器的两字段结构 |
| 图像、视觉和动态最近观察 | `capture / vision / dynamic` 的 `observed` | 最近一次真实调用的事实；没有调用时可为 `null` |
| 预算与算法规格 | `limits`、`dynamic.assertions` 等 | 当前允许的规模与断言形状；不是采样性能承诺 |

细分 id（如 `web.t3.compare`）是工具能力报告的条目，配置准入仍使用目录中的 `web.t3`，不能把两者互换。这些条目有的来自声明或当前 BUSY 状态，有的来自实际探测；不能把整份报告理解为逐项执行后的结论。诊断调用不会启动 Chrome，报告可执行也不能保证随后的启动、命中或业务断言成功。

<a id="web-chrome-limits"></a>

##### Chrome 的跨层边界

| 边界 | 当前行为与解释入口 |
| --- | --- |
| 目标与引用 | 工具随当前 Agent 的工作/观察选页路由；GUI 选页独立。页面组与证据存储的隔离粒度并不相同，见[多标签页限制](multi-tab.md) |
| 登录态 | 页面状态按 Runtime 分开，Cookie 与存储由 Chrome profile 共享；不构成登录态隔离 |
| 页面像素与原生 UI | alert/confirm、文件选择器和浏览器原生菜单不在页面截图中；面板右键菜单及 select 浮层属于面板 UI，见[页面右键菜单](panel-context-menu.md)与[选元素指南](element-picker.md) |
| 人工标注 | 标注是问题线索，不能代替页面事实。仅 `browser_screenshot {includeAnnotations:true}` 叠加 Host 已接受文档，T3/T4 原始源不包含它；映射与交付见[截图指南](capture-p0.md#带面板标注的截图) |
| 图像交付 | 截图不脱敏；附件成功不证明模型收到原始分辨率。合成可能重编码，Canvas/WebGL 位图也不会因提高截图 scale 自动变清晰 |
| 共享状态 | 读缓存需核对 stale，更新使用 revision/CAS，冲突不会自动重放；见[视口指南](viewport-control.md) |
| 实现覆盖 | Web 是当前真实目标环境；fake 仅是契约夹具。其他目标环境没有真实适配器，不用配置卡片或假环境测试证明可用 |

## 4. 验证与新增环境

### 4.1 当前验证入口

以下是真实 Chrome 与公共契约的验证入口，其他目标环境应在各自实现下登记独立的验收命令。

| 验证对象 | 入口 | 应核对的结果 |
| --- | --- | --- |
| 能力声明与适配器 | `node --test tests/contracts/*.test.mjs` | 操作/能力映射、配置版本、支持与可用状态、执行与证据边界 |
| T1 和工具面 | `node tests/acceptance/run.mjs` | 真实 Chrome 运行、工具返回与能力报告 |
| T2 | `node tests/acceptance/t2-structured.mjs` | 结构发现、引用失效、控件输入、状态与失败证据 |
| T3 | `node tests/acceptance/t3-vision.mjs` | 图像来源、几何映射、比较、操作与基线 |
| T4 | `node tests/acceptance/t4-dynamic.mjs` | 采帧、分析、控制、恢复、关联与缺证据判定 |
| T4 场景 | `node tests/acceptance/t4-visual-fixtures.mjs`、`node tests/acceptance/t4-network-fixtures.mjs` | 连续画面、时序与真实网络旁证 |

测试命令、环境要求、报告字段和隔离实例用法统一见[验证与贡献](verification.md)。真实浏览器套件按该指南串行运行。

实现存在不等于所有场景均已验证。close/dispose 恢复、WebGPU 渲染、媒体 seek/stall、短暂闪白和长连接稳定性等，须有对应真实记录才能下结论；未运行、部分覆盖和时间分辨率不足必须原样报告，不使用固定历史计数代表当前状态。

### 4.2 新增目标环境的文档位置

新增环境时，在[目标环境实现](#3-目标环境实现)中增加与 Web 平级的小节；同一环境下按具体执行端继续细分。每个执行端记录 T1–T4 的已实现操作、参数、协议、证据、限制、注册接线与验证入口；缺失层级如实标记，不照搬 Chrome 的 DOM、CDP、WAAPI 或页面模型。

能力分层和接口职责仍由前两章统一定义。适配器对象、配置与生命周期的接入步骤见[适配器接口与接入](adapters.md#5-接入与验证)，图像、网络、显示空间等独立基础设施继续由对应 P0 文档解释。
