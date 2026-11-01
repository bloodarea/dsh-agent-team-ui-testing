# 能力分层：Web 的 T1–T4（现行标准）

> 索引：[docs/index.md](index.md)

四层是**选择与回退策略**，不是必须逐层执行的流水线：挑"够用且成本最低的可靠路径"，不通再往下退。涉及外观/交互的验收必须有 UI 层证据，不能拿 T1 的成功当界面测试通过。

| 层级 | 正式名称 | 核心技术 | 主要调试能力 | 触发与升级条件 | 相对成本 |
| --- | --- | --- | --- | --- | --- |
| **T1** | 程序化调试 | CDP、HTTP、Fetch、JavaScript、`Network`、`Console` | 接口请求、网络抓包、JS 执行、异常检测、资源加载、状态检查、性能数据 | 默认优先；需要操作页面元素时进入 T2 | 低 |
| **T2** | 结构化 GUI 调试 | DOM、Accessibility Tree、ARIA、Snapshot、Locator、Ref | 元素定位、点击、输入、滚动、表单、交互测试、节点状态、结构化证据 | 无法通过可靠的结构化定位完成操作，或需要视觉判断时进入 T3 | 低～中 |
| **T3** | 静态视觉调试 | Screenshot、Computer Vision、坐标操作、图像差异分析 | UI 布局、颜色、遮挡、样式缺陷、Canvas、图表、静态截图操作 | 需要连续动作、动画或时间状态判断时进入 T4 | 高 |
| **T4** | 动态视觉调试 | Screencast、帧序列、时间戳、视觉推理、鼠标键盘事件 | 动画、拖拽、复杂动态组件、过渡状态、连续画面分析 | 最高级：失败后输出诊断结果，交由 Agent 或人类裁决 | 最高 |

选型对照与实现策略（“参考”只是对比对象，不代表已选定依赖；Web T3 已按纯 JavaScript 自研实现，未引入 Sharp/Pixelmatch/Argos 依赖）：T1 Playwright MCP / agent-browser / Chrome DevTools MCP，直接复用；T2 ego-lite / agent-browser / Playwright MCP，复用 + 统一节点协议；T3 Playwright MCP Vision / Sharp / Pixelmatch / Argos，参考算法、自研判定（现行实现见下方“对当前实现的含义”）；T4 agent-browser 视频录制机制 / 自研动态视觉调度 / CDP Animation / rrweb / 按需 FFmpeg・OpenCV，复用采集、自研时序验证。

## 每一级的完成门槛

- **T1**：独立完成不依赖视觉理解的页面与接口诊断，并向 T2 提供同一浏览器会话。
- **T2**：对常规 Web 页面实现可靠的结构化发现、定位、操作、验证闭环，并明确识别何时需要视觉能力。
- **T3**：对静态画面完成视觉定位与操作并准确验证前后状态；需要连续时间信息时升级 T4。
- **T4**：根据连续帧判断动态交互的结果，并输出带时间戳的可复现证据。

## 回退链规则

1. **按需选择**：网络异常优先 T1，按钮交互优先 T2，布局错误可以直接 T3。
2. **逐级升级是默认策略，允许跳级**：已明确需要连续动态画面时可以直接进入 T4。
3. **区分工具失败和产品缺陷**：定位器失效可重试或升级；业务断言失败必须记录缺陷，不能用回退掩盖。
4. **证据跨层级复用**：T1 的 Network 数据、T2 的元素 Ref、T3 的截图与 T4 的关键帧归属同一次调试任务。

## 三条约束

- **只对 Web 定义过 T1–T4。** 其他运行环境（Windows / Android / Linux / macOS / TUI / HarmonyOS / 游戏 / 3D）尚未定义，不要照搬 Web 的技术栈去假设它们的实现路径。
- `README.md` / `README_zh.md` 的分层章节与本文件是同一套 T1–T4（分层总表、每级完成门槛、回退链规则、架构图节点、R2 里程碑）；再调整分层时三份文件要一起改。
- 仓库其余位置（`skills/ui-testing/references/tiers/*.md` 的标题、[t1-issues-and-solutions.md](t1-issues-and-solutions.md) 的分类栏）沿用旧称（T1 程序化接口、T2 结构化 GUI、T3 静态视觉理解、T4 动态视觉理解），指的就是本表的四层；名称以本表为准，改名时不要顺带改工具名或验收口径。

## 对当前实现的含义

调试视图通过无头 Chromium + CDP 同时提供 Web T1（程序化）、T2（结构化 GUI）与 T3（静态视觉）。**P0 基础设施由三项独立能力组成：P0-A 图片输入流/截图采集（capture-p0.md）、P0-B 网络抓包/业务链路（network-p0.md）与 P0-C 共享视口控制（viewport-control.md）；三者独立验收、不能互相顶替。工具面 30 个 = 10 T1 + 7 T2 + 6 T3 + 7 network**（第 8 轮网络 P0 的 7 个工具与第 9 轮 P0-C 的 `browser_viewport` 都是**纯新增**；旧工具除有意变更的截图默认密度外只做加法式增强：`browser_screenshot` 证据新增 `capture.networkWindow`（`capture.version` 仍 1）、T2 动作与网络事件加 mark 关联，`browser_network`/T3 语义不变）：

- T1：10 个工具（导航、JS、截图、输入、网络、计算样式、独立 HTTP、共享视口、状态、能力发现），现行契约与验收见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)、[t1-http-request.md](t1-http-request.md)、[viewport-control.md](viewport-control.md)。T1 行的「网络抓包」仍由旧 `browser_network`（元数据、300 条环形缓冲）提供，**深度抓包/正文/控制看下面的 network P0 七工具**，两者并存、语义不互相顶替。
- **P0-B network（第 8 轮，网络抓包/业务链路）**：7 个工具 `browser_network_session` / `events` / `detail` / `trace` / `control` / `evidence` / `subscribe`，覆盖六类能力——采集（HTTP/HTTPS 请求响应体、WebSocket 双向帧、SSE 事件、同主 page 的 same-origin iframe/OOPIF/Worker）、时序（标准化事件 + 统一时间轴 + 与 GUI 动作/页面状态/截图的时间关联）、分析（参数解析、业务状态码、耗时统计、错误/重试/重复、关联标识、筛选检索聚合、依赖关系）、链路（步骤窗口、业务对象提取传递、跨请求关联、状态变化、异步/轮询、因果元数据）、控制（启停、按需详情、拦截/改写/延迟带宽/断连/重放/Mock）、证据（JSONL/HAR 导入导出、索引检索、脱敏、配额与完整性、多 Agent 独立订阅）。纯 JavaScript、零 npm 依赖；诊断/只读动作不启动浏览器，`session.start` 与需要 page 的 `control` 才懒启动。权威契约 [network-p0.md](network-p0.md)（7 工具 schema、事件 schema、配额、`NET_*` 错误、靶机路由、验收 C1–C52）。
  - **边界（不夸大）**：`G1.5` 为 **partial**——same-origin iframe 与 dedicated worker 已实证，OOPIF 为 `partial`（未单独验证），shared/service worker **不采集**（attach 会暂停 service worker 并破坏 `register()`），popup 继续被既有目标策略阻断，不采 popup、不跨 scope 聚合、无多标签/窗口工具；**HTTPS 未独立验收**（能力报告 `limits.network.https = "mechanism-identical"`，C1 子项 NOT_RUN）；**`responseModification` 条件支持**（仅当 Chrome 实测支持 `Fetch.continueResponse` 才声明，否则 C37 子项 NOT_RUN）；不做 MITM/不装 CA/不读 TLS 密钥、不做真实网络限速（只模拟 CDP 网络条件）、HAR 只保证 1.2 子集。
  - **验收（Lead 独立串行，同一最终代码）**：`node tests/acceptance/network-p0.mjs` → **52/52 criteria（pass 52 / fail 0）、requiredChecks 266/266、failedChecks 0、notRunChecks 8、exit 0**（[run-report.json](../tests/acceptance/runs/2026-11-01T12-27-48-770Z-370586/run-report.json)），单测 `tests/network-p0.test.mjs` **43/43**；8 条 NOT_RUN（C1 HTTPS、C2 二进制 body、C5 service worker、C20 单样本 p95、C35 淘汰 body 三态、C37 `modify-response`、C52 外部套件、C52 真实宿主）逐条登记在 [status.md](status.md) 与网络台账。**真实宿主重启后的网络冒烟仍 NOT_RUN**，不能由进程内套件推定。

- **P0-A 图片输入流/截图采集**：已有 `browser_screenshot` 增强为显式 scale 0.1–4（省略时跟随共享 view.scale）、文档 CSS region、PNG 结构/尺寸/均匀统计、安全落盘和 capture 证据；默认暂存（dispose 清理），out/persist:true/非空 env 显式持久；file 区分绝对暂存/相对持久，能力 observed 不含绝对路径。C1–C14 共 14/14、142/142（[Lead 终验报告](../tests/acceptance/runs/capture-p0-2026-11-01T16-19-51-182Z-564952/report.json)）。**P0 采集本身不构成 T3 判定**；T3 由新增六工具与独立验收另证（见下）。权威契约见 [capture-p0.md](capture-p0.md)；provider 与真实宿主 P0 重载仍 NOT_RUN。
- **P0-C 共享视口控制（第 9 轮，viewport-control）**：每个工作区一份权威 CSS 像素 `view`（页面滚动 x/y、CSS 视口宽高、显示/默认截图比例、派生 mode、source/revision），`browser_viewport get` 为只读缓存诊断（不启动/不占租约），`set` 为租约内页面操作（含 scale-only），`expectedRevision` 乐观并发（`VIEWPORT_CONFLICT`，HTTP 409），背景滚动观测 200ms 合并/single-flight；面板尺寸栏新增 X/Y、五输入滚轮、fit 本地语义与 painted-rect 坐标映射。**不改页面 CSS 视口/DPR/页面缩放**。权威契约 [viewport-control.md](viewport-control.md)；Lead 终验 `viewport.mjs` 11/11 probes、107/107 required、exit 0，隔离 DSH `viewport-gui.mjs` 73/73 PASS、5 NOT_RUN、exit 0；真实 3080 未重启，30 工具/`ui.view` 在那里仍 NOT_RUN。
- T2：7 个工具（`browser_snapshot` + `click` / `type` / `scroll` / `fill_form` / `node_state` / `wait_for`），AX 语义树 + 单调 `eN` Ref + 可信输入 + `evidence.version=1`；契约与 38 条验收见 [t2-structured-gui.md](t2-structured-gui.md)，实现/验收状态见 [status.md](status.md)。T2 仍属主 frame + AX-backed open shadow，iframe 内部、closed shadow、原生 select popup/拖拽/上传下载/contenteditable/IME 与视觉判定不在范围内。
- **T3（静态视觉，已实现并通过进程内验收）**：6 个工具 `browser_vision_image` / `find` / `compare` / `act` / `baseline` / `check`（工具面共 30 = 10 T1 + 7 T2 + 6 T3 + 7 network）。纯 JavaScript、零 npm 依赖：PNG 编解码/裁剪/缩放/预处理/标注、YIQ 像素差异与相似度/差异区域高亮/动态 mask、color/components/edges/template 确定性识别、截图坐标的真实 CDP 输入（六步安全校验、失败零派发）、受管基线（不可变 revision + HEAD CAS + 墓碑）、回归与六类缺陷用例（像素信号 + 调用方显式 provenance facts；T3 不主动读 DOM）。权威契约 [t3-vision.md](t3-vision.md)；进程内验收 **56/56 criteria、391/391 required、exit 0**（Lead 终验：[报告](../tests/acceptance/runs/2026-11-01T16-42-25-550Z-595320/run-report.json)）。无 VLM/OCR/语义命名；真实宿主重启加载与 provider 图像可见性、T4 仍 NOT_RUN。
- **T4 未实现**：动态视觉（screencast/帧序列/时间戳/时序推理）仍 unsupported；`browser_screenshot` 与 T3 的 before/after 静态两帧都不能证明动画/中间闪烁。面板视觉未变，「选择元素」「打开调试工具」仍禁用。
