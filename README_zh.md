# dsh-agent-team-ui-testing

**面向 DeepSeekHarness 的 AI 原生 UI 测试能力。**

让 AI Agent 真正操作、检查、测试并验证用户界面，并留下人类可复核的证据。

[English](README.md) | **简体中文**

> **状态：预发布。** Web / Chromium 通道已实现：30 个 Agent 工具 + 调试面板，覆盖程序化检查、结构化 GUI 操作、静态视觉分析、网络抓包、共享视口控制、混合画布与客户端标注。其他运行环境仍在规划中，运行时选择器保持禁用。插件目前以本地链接方式接入，尚未发布安装包。验证状态与已知缺口见 [docs/status.md](docs/status.md)。

## 这是什么项目？

**dsh-agent-team-ui-testing** 是 [DeepSeekHarness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 的 UI 测试基础设施插件。它让一个 AI Agent——或一组协作的 Agent Team——操作真实应用、读取应用暴露的状态、验证预期行为、采集可复核的证据，并报告可执行的缺陷。

运行时围绕一个共享 Chromium 实例构建：每个 DSH 工作区拥有独立页面，插件提供类型化的工具面和面向人类的调试面板。同一个会话既可以做程序化检查，也可以通过结构化 DOM/无障碍数据操作、截图采集或视觉分析来验证。

项目由早期的 `dsh-agent-team-browser` 演进而来。共享浏览器工作区仍是当前第一个适配器，未来会扩展到更完整的、按能力分层的 UI 测试运行时。

## 为什么开发它？

写代码的 Agent 可以产出 UI 代码，却不一定能回答：**“这个应用真的能正常工作、外观也正确吗？”** HTTP 200、进程启动或一张截图，都不能证明用户旅程真的通过。

这个项目关注：

- **真实 UI 反馈**——在渲染后的界面上跑用户旅程，而不只看源码。
- **结构化优先**——优先使用 API、DOM 和无障碍信息；结构不足时再使用视觉。
- **证据化结论**——记录执行了什么、观察到了什么、什么通过、什么失败、什么仍未验证。
- **人类可控**——授权访问、限定会话范围，并保留人类观察或接管的入口。
- **低干扰**——优先后台浏览器操作，不抢占桌面前台输入。

## 当前已实现

- **共享浏览器运行时**——每台主机一个无头 Chromium；每个 DSH 工作区拥有独立的页面、URL、视口、历史、网络缓冲与租约。Cookie 和存储由 Chromium profile 共享。
- **30 个 Agent 工具**，覆盖程序化调试、结构化 GUI、静态视觉与网络调试。
- **调试面板**——实时预览、响应式尺寸控制、共享视口状态、混合画布，以及 Agent 可读回的客户端标注层。
- **证据与安全**——类型化错误、结构化操作证据、经过校验的 PNG 截图、受管视觉基线、网络证据，以及共享状态的乐观并发控制。

### Agent 工具

| 分组 | 工具 | 能力 |
| --- | --- | --- |
| **程序化**（10） | `browser_navigate` `browser_eval` `browser_screenshot` `browser_input` `browser_network` `browser_computed_style` `browser_http_request` `browser_viewport` `browser_state` `browser_capabilities` | 导航、JavaScript、控制台/网络检查、独立 HTTP 请求、计算样式、截图、原始鼠标/滚轮/键盘输入、共享视口状态与能力发现 |
| **结构化 GUI**（7） | `browser_snapshot` `browser_click` `browser_type` `browser_scroll` `browser_fill_form` `browser_node_state` `browser_wait_for` | 快照 → ref 定位、可信输入、表单、节点状态与等待，返回结构化证据和类型化错误 |
| **静态视觉**（6） | `browser_vision_image` `browser_vision_find` `browser_vision_compare` `browser_vision_act` `browser_vision_baseline` `browser_vision_check` | PNG 裁剪/缩放/预处理/标注，颜色/组件/边缘/模板确定性识别，YIQ 差异，坐标输入，受管基线与视觉断言 |
| **网络**（7） | `browser_network_session` `browser_network_events` `browser_network_detail` `browser_network_trace` `browser_network_control` `browser_network_evidence` `browser_network_subscribe` | 采集、时间线、分析、业务步骤链路、拦截/限速/重放/Mock、JSONL/HAR 证据与多 Agent 订阅 |

### 调试面板

面板是人类观察同一运行时的窗口。

- **实时预览**：通过 screencast 显示工作区页面，WebSocket 优先、HTTP 轮询兜底。
- **尺寸栏**：宽屏 / 横屏 / 平板 / 手机 四个预设以分页选择器呈现，另有 X/Y 画布位置、宽 × 高、显示比例和 `拖拽 | 适应窗口 | 默认` 模式选择。点击预设会重置 X/Y，并保持当前显示模式；选中预设显示绿色小球，且与拖拽模式互斥。
- **混合画布**：视口可以像画布一样定位——带符号的原点、负坐标和空白区域；面板用深色棋盘格表示空白（截图与 T3 中为纯白），支持拖拽平移和以屏幕光标为锚点的滚轮缩放。
- **标注模式**：圆形、矩形、线段、箭头、画笔、文字、橡皮擦，以及填充/外框、颜色、粗细和清除画布。标注锚定在画布坐标中，模式内页面不接收输入；标注文档会发布给 Agent，可通过 `browser_state.annotations` 读取。
- **共享状态**：Agent 与面板读取同一份视口；写入使用 `expectedRevision`，冲突会明确报告，不会静默覆盖。

### 证据与安全

- 结构化操作可返回证据：目标身份、前后状态、派发事实、网络增量和类型化错误。
- 截图是经过校验的 PNG，支持显式比例和画布空间区域；可暂存，也可持久化到受控根目录。
- 视觉基线是不可变 revision，使用 HEAD 比较交换和墓碑机制。
- 网络证据支持 JSONL（无损）和 HAR 1.2 导出，默认脱敏并显式统计截断。
- 运行时访问按 DSH 工作区隔离；页面写操作通过租约和串行队列串行化。
- 导航限制在授权目标内（默认允许 loopback，私网需显式放开），并校验 DNS、重定向和弹窗。

## 工作方式

```text
DSH Agent / Agent Team
        │
        ▼
UI 测试插件运行时
  ├─ 共享无头 Chromium
  ├─ 每个 DSH 工作区独立页面（URL、视口、历史、网络、租约）
  ├─ 30 个 Agent 工具
  └─ 调试面板（预览、尺寸栏、画布、标注）
        │
        ▼
观察结果、证据与结论
```

目前只实现了 Web / Chromium 适配器。桌面、Android、TUI、HarmonyOS、游戏和 3D 适配器仍在规划中；每个适配器都必须如实报告自己的能力，而不是假装支持同样的操作。

## 能力分层

工具面按**选择与回退层级**组织，不是必须逐层执行的流水线。优先选择成本最低且可靠的路径；当前层级无法产出所需证据时再升级。

| 层级 | 关注点 | 典型用途 |
| --- | --- | --- |
| **T1** 程序化 | CDP、HTTP、JavaScript、网络、控制台 | 接口检查、网络故障、页面状态、性能数据 |
| **T2** 结构化 GUI | DOM、无障碍树、快照/ref、可信输入 | 按钮、表单、导航、交互测试 |
| **T3** 静态视觉 | 截图、确定性像素分析、坐标操作 | 布局、颜色、遮挡、Canvas、图表与样式缺陷 |
| **T4** 动态视觉 | 帧序列、时序、运动推理 | 动画、过渡、拖拽与时间相关行为——规划中，尚未实现 |

T1 调用成功不能被当成视觉验收通过。涉及界面的验收标准仍然需要 UI 层观察。

## 快速开始

**要求：** 已安装 DSH，并有本地 Chrome/Chromium。

插件目前以本地链接方式接入 DSH profile，还没有发布 npm 包或兼容性矩阵。

1. 把仓库链接或复制到开发用的 DSH profile。
2. 首次安装后重启 DSH，让插件 bundle 完成注册。
3. 从 **更多 → 调试视图** 打开调试面板，或从右侧边栏的插件卡片进入。
4. 只改 `client.js` 时刷新面板即可；改 `index.js`、工具面或内置 Skill 需要重启 DSH。

接入细节与已知坑见 [docs/dsh-integration.md](docs/dsh-integration.md)。

典型的 Agent 流程是：导航到目标页面，用 `browser_state`/`browser_eval` 检查状态，用 T2 工具执行结构化操作，截图或运行 T3 检查，用网络工具分析请求，并在涉及布局、取景或视觉反馈时使用共享视口/画布/标注状态。

## 当前限制

- **仅 Web。** Windows、Linux、macOS 桌面、Android、TUI、HarmonyOS、游戏和 3D 仍在规划中，运行时选择器保持禁用。
- **仅静态视觉。** T3 用确定性算法判断单张 PNG；没有 VLM/OCR 或语义命名，也不能证明动画或中间帧。T4 尚未实现。
- **共享浏览器 profile。** Cookie 和存储由 Chromium profile 共享；只有页面、URL、视口、历史、网络缓冲和租约按工作区隔离。
- **截图不脱敏。** 分享前请检查截图内容。
- **附件不等于 provider 可见。** 返回图片附件不代表模型一定以原始分辨率收到了它。
- **网络采集在边界上不完整。** 同页 iframe 和专用 Worker 已覆盖；OOPIF 为部分覆盖；共享 Worker 和 Service Worker 不采集；HAR 是 1.2 子集；正文/头脱敏不是通用密钥检测器。
- **视口显示是 1× screencast。** 显示比例超过 100% 是对位图的放大，不是增加像素密度；需要分辨率时请显式指定截图比例。尺寸变化后的输入屏障是尽力而为，画布偏移则使用 fail-closed 屏障。
- **共享状态是乐观并发。** `browser_viewport get` 是缓存诊断；`stale` 表示“最近没有观测”，`expectedRevision` 竞争失败会返回 `VIEWPORT_CONFLICT`，不会自动重放 patch。

## Roadmap

- 加固 Web 通道，完成 T4 动态视觉验证。
- 增加跨环境测试核心：类型化会话、观察、断言与报告。
- 按需求和平台可行性验证桌面（Windows/Linux/macOS）、Android、TUI、HarmonyOS、游戏和 3D 适配器。
- 增加多 Agent 调度、人类接管与发布加固。

## 文档

| 文件 | 内容 |
| --- | --- |
| [docs/index.md](docs/index.md) | 项目文档索引 |
| [docs/status.md](docs/status.md) | 当前实现状态、验证证据与已知缺口 |
| [docs/capability-tiers.md](docs/capability-tiers.md) | T1–T4 分层模型、完成门槛与回退规则 |
| [docs/viewport-control.md](docs/viewport-control.md) | 共享视口契约：view 模型、CAS、面板映射与截图比例 |
| [docs/canvas-viewport.md](docs/canvas-viewport.md) | 混合画布契约：带符号原点、空白、拖拽/缩放、输入映射与画布空间截图 |
| [docs/annotation-p0d.md](docs/annotation-p0d.md) | 标注契约：工具、画布锚定、Agent 可见文档与保留策略 |
| [docs/network-p0.md](docs/network-p0.md) | 网络抓包契约：工具、事件、配额、证据与错误 |
| [docs/capture-p0.md](docs/capture-p0.md) | 截图与证据文件契约 |
| [docs/t2-structured-gui.md](docs/t2-structured-gui.md) | 结构化 GUI 契约与 ref 协议 |
| [docs/t3-vision.md](docs/t3-vision.md) | 静态视觉契约、算法与结论规则 |
| [docs/dsh-integration.md](docs/dsh-integration.md) | DSH 接入要点与已踩的坑 |
| [docs/verification.md](docs/verification.md) | 如何验证（隔离 DSH + 无头 Chromium） |

## 与配套项目的关系

| 项目 | 角色 |
| --- | --- |
| [`dsh-agent-team-presets`](https://github.com/bloodarea/dsh-agent-team-presets) | 可复用的团队/角色配置、模型路由与工具策略 |
| **`dsh-agent-team-ui-testing`** | UI 测试目标、会话、自动化、证据，以及受治理的人机协作控制 |

两者互补，但不互相依赖；运行时支持单个 DSH Agent 在没有 presets 插件的情况下使用。

## 贡献

最有价值的贡献包括：可复现的 DSH 接入结论、平台可行性测试、无障碍/DOM 回退案例、安全威胁模型，以及具体的 UI 验收场景。

提交 issue 时请附上 DSH 版本/commit、平台与运行时版本、复现步骤、预期结果、实际结果和脱敏后的证据。不要上传凭据、个人设备数据或未脱敏的认证流量。

## 许可证

仓库目前尚未声明许可证。再分发或复用前请先补充明确的许可证；后续引入的第三方代码必须保留其适用的声明。

---

**仓库：** [bloodarea/dsh-agent-team-ui-testing](https://github.com/bloodarea/dsh-agent-team-ui-testing) · **维护者：** [bloodarea](https://github.com/bloodarea) · **状态：** 预发布
