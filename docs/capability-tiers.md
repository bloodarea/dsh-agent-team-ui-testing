# 能力分层与限制

四层是**选择与回退策略**，不是必须逐层执行的流水线：挑够用且成本最低的可靠路径，不通再升级。涉及外观与交互的验收必须有 UI 层证据，不能拿 T1 的成功当界面测试通过。

| 层级 | 名称 | 核心技术 | 典型用途 | 升级条件 | 相对成本 |
| --- | --- | --- | --- | --- | --- |
| **T1** | 程序化调试 | CDP、HTTP、JavaScript、Network、Console | 接口检查、网络故障、页面状态、性能数据 | 需要操作页面元素 → T2 | 低 |
| **T2** | 结构化 GUI | DOM、无障碍树、Snapshot/Ref、可信输入 | 按钮、表单、导航、交互测试 | 结构定位不可靠或需视觉判断 → T3 | 低～中 |
| **T3** | 静态视觉 | 截图、确定性像素分析、坐标操作 | 布局、颜色、遮挡、Canvas、图表、样式缺陷 | 需要连续画面/时序 → T4 | 高 |
| **T4** | 动态视觉 | Screencast、帧序列、时间戳、运动分析 | 动画、过渡、拖拽、时间相关行为 | 最高层；输出诊断交 Agent 或人裁决 | 最高 |

## 完成门槛

- **T1**：独立完成不依赖视觉理解的页面与接口诊断，并向 T2 提供同一浏览器会话。
- **T2**：对常规页面实现可靠的结构化发现、定位、操作、验证闭环，并能识别何时需要视觉能力。
- **T3**：对静态画面完成视觉定位与操作，并准确验证前后状态。
- **T4**：根据连续帧判断动态交互结果，并输出带时间戳的可复现证据。

## 回退规则

1. **按需选择**：网络异常优先 T1，按钮交互优先 T2，布局错误可以直接 T3。
2. **允许跳级**：已明确需要连续动态画面时可直接进入 T4。
3. **区分工具失败与产品缺陷**：定位器失效可重试或升级；业务断言失败必须记录为缺陷，不能用回退掩盖。
4. **证据跨层复用**：T1 的网络数据、T2 的 ref、T3 的截图与 T4 的关键帧归属同一次调试任务。

## 基础设施（P0）

P0 是四项互相独立的能力，不能相互顶替：

| 项 | 内容 | 文档 |
| --- | --- | --- |
| P0-A | 图片输入流与截图采集 | [capture-p0.md](capture-p0.md) |
| P0-B | 网络抓包与业务链路 | [network-p0.md](network-p0.md) |
| P0-C | 共享视口控制 | [viewport-control.md](viewport-control.md) |
| P0-D | 混合画布与客户端标注 | [viewport-control.md](viewport-control.md) |
| P0-E | 多标签页/每会话选页 | [multi-tab.md](multi-tab.md) |

工具面共 36 个：10 T1 + 1 P0-E（`browser_tabs`）+ 7 T2 + 6 T3 + 7 network + 5 T4。

## 各层已实现范围

- **T1**：导航、JS 执行、截图、原始输入、轻量网络列表、计算样式、独立 HTTP 请求、共享视口、状态与能力发现。轻量 `browser_network` 只提供元数据环形缓冲，且**只读**（不取页面队列与单 owner 租约）；深度抓包、正文与控制属于 P0-B 的七个工具，两者并存、语义不互相顶替。
- **T2**：snapshot → ref 定位 → 可信输入 → 证据 → 等待/节点状态，覆盖点击、输入、滚动、表单与状态读取。
- **T3**：纯 JavaScript、零 npm 依赖的图像处理、确定性识别、YIQ 差异、坐标输入、受管基线、回归与六类缺陷用例。
- **T4**：真实 CDP screencast 与 screenshot-loop 两条帧源、有界帧存储、七类确定性分析、WAAPI 运动控制、六向事件关联。
- **P0-B**：采集（HTTP/HTTPS 请求响应、WebSocket、SSE、同页 iframe 与 dedicated worker）、时序、分析、业务链路、控制、证据导出与多 Agent 订阅。

## 跨环境适配状态

三类 adapter 契约（TargetAdapter / CapabilityAdapter / P0Provider）已落地，Web 是唯一真实实现；配置驱动工具 schema、Skill 目录/正文与执行准入。`targets/fake/` 只是 test-only 契约夹具，不是真实平台。

| 环境 | 工程支持 | 说明 |
| --- | --- | --- |
| Web / Chromium | supported | 36 个 `browser_*` 工具、T1–T4 与 P0；唯一可执行的真实目标环境 |
| Web 运行环境 `chrome` | supported | 默认 provider；可执行文件、覆盖变量、profile、身份校验均已参数化 |
| Web 运行环境 `edge` | supported（代码）/ 依赖视本机而定 | 与 Chrome 复用同一套 CDP 实现，候选路径、`DSH_UI_TESTING_EDGE`、profile、产品身份校验独立；本机没有 Edge 二进制时依赖轴报 `failed / executable-missing`，真机拉起未实测 |
| Web 运行环境 `firefox` | unsupported | 配置里可写入开关，但没有驱动；设置页置灰，执行返回 `ADAPTER_UNSUPPORTED` |
| fake（test-only） | supported（仅测试） | 确定性夹具，用于验证契约/隔离/证据；生产配置默认拒绝，不得称为真实平台 |
| Linux/Windows/macOS 桌面、Android、TUI、HarmonyOS、小程序、游戏、3D | planned / unsupported | 尚无 adapter 与真实探针；设置页显示 planned，运行环境选择器不启用 |

## 已知限制

- **仅 Web 目标环境。** Web / Chromium 是唯一实现的目标环境，可运行在 Linux、macOS 与 Windows 宿主上；桌面应用、Android、TUI、HarmonyOS、小程序、游戏与 3D 尚无适配器，运行时选择器保持禁用。跨环境契约与配置隔离已落地，但不等于这些平台已支持。
- **视觉是确定性的，不是语义的。** 没有 VLM/OCR、没有语义命名；「这段文字是什么意思」「人看着对不对」不在范围内。
- **T4 验收未全覆盖。** 44 条动态行为门槛中 12 条通过、20 条部分通过、12 条未运行、0 条失败。close/dispose 恢复、WebGPU 渲染、媒体 seek/stall、header 校验身份、16 ms 闪白覆盖与长连接稳定性仍未验证。
- **网络采集边界不完整。** OOPIF 为部分覆盖；shared/service worker 不采集；GUI 内部标签页可打开真人触发的 `target=_blank`（每个标签独立页面/Runtime），Agent 工具操作当前会话 selectedTab（未选择时 primary），多标签详见 [multi-tab.md](multi-tab.md)，自动/未授权 popup 仍阻断，也不做跨标签聚合；HTTPS 未独立验收；`responseModification` 在本构建固定为 `false`（`modify-response` 不可用，不做 CDP 能力探测）；HAR 只保证 1.2 子集。
- **共享浏览器 profile。** Cookie 与存储由 Chromium profile 共享；只有页面、URL、视口、历史、网络缓冲与租约按工作区隔离，**不是登录态隔离**。
- **原生弹层不在页面像素里。** `alert/confirm`、浏览器默认右键菜单、文件选择器由浏览器 UI 图层绘制，不进入页面渲染面，因此面板（screencast/截图）与 `browser_screenshot` 都看不到它们。**右键不再是死路**：预览区内的 `contextmenu` 由面板自己吃掉（不弹 DSH Web 的右键菜单、也不让它继续冒泡），右键按下/抬起按 `button:'right'`（`buttons` 2→0）派发给页面，因此页面自绘的右键菜单会正常出现在帧里并可点选；浏览器默认菜单仍不可投影：无头环境里不存在；有头环境的窗口默认不映射（离屏、`IsUnMapped`），实测 CDP 右键不会弹出原生菜单，所以它既不会出现在预览里，也不会挡住后续输入。预览区之外的右键保持宿主原有行为。**单选 `<select>` 已有面板侧浮层**：点击后 Host 用 `POST /element` 只读返回选项，面板在点击点画自己的列表（↑↓ / Enter / Esc、点击外部关闭、超出边界自动上翻左移），选中后通过 `POST /select` 以 native setter + `input`/`change` 写回再补一次 `Escape` 关掉可能已打开的原生弹层。不支持浮层的形态（`multiple`、`size > 1`、没有选项）会在地址栏下方、预览区域外提示「该下拉不支持浮层，请用键盘 ↑↓ + Enter」，不覆盖页面或抢占键盘焦点，Esc 可关闭提示。同进程 `<iframe>` 内的单选 `<select>` 走同一条链路（命中返回顶层文档坐标与该 frame 的 `loaderId`）；跨进程 OOPIF 与 closed shadow root 内部不读取、不显示浮层。自定义下拉沿用页面自己的鼠标与键盘交互；agent 可用 `browser_fill_form` 的 `combobox` 选择原生控件。
- **面板键盘转发的是按键本身。** 除注释/选元素模式与 IME 组合期间外，按键都以 keydown + keyUp 转发到页面，带 CDP `modifiers` 位掩码（Alt=1/Ctrl=2/Meta=4/Shift=8）、物理 `code`、`virtualKeyCode` 与 `autoRepeat`，可打印字符同时带 `text/unmodifiedText`；`Ctrl/Cmd/Alt` 组合与 F1–F12、Home/End/PgUp/PgDn/Delete/Insert 都在范围内。
- **截图不脱敏。** 分享前请检查内容；附件返回也不等于 provider 一定以原始分辨率收到图像。
- **共享状态是乐观并发。** `browser_viewport get` 是缓存诊断，`stale` 表示「最近没观测」；`expectedRevision` 竞争失败返回 `VIEWPORT_CONFLICT` 且不自动重放。

## 如何判断「真的可用」

以运行态为准，不以文档为准：

1. `browser_capabilities` 报三态（`available`/`unavailable`/`unsupported`）与 limits。
2. 实际调用返回的证据（`evidence`、`verdict`、`integrity`、`analysis`）。
3. 需要复现时按[验证与贡献](verification.md)跑测试。
