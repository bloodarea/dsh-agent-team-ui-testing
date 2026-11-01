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

调试视图通过无头 Chromium + CDP 同时提供 Web T1（程序化）、T2（结构化 GUI）与 T3（静态视觉）：

- T1：9 个工具（导航、JS、截图、输入、网络、计算样式、独立 HTTP、状态、能力发现），现行契约与验收见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)、[t1-http-request.md](t1-http-request.md)。
- P0共享采集：已有 `browser_screenshot` 增强为连续scale1–4、文档CSS region、PNG结构/尺寸/均匀统计、安全落盘和capture证据；默认暂存（dispose清理），out/persist:true/非空env显式持久；file区分绝对暂存/相对持久，能力observed不含绝对路径。C1–C14共14/14、142/142（[最终报告](../tests/acceptance/runs/capture-p0-2026-11-01T07-35-21-142Z-176846/report.json)）。**P0 采集本身不构成 T3 判定**；T3 由新增六工具与独立验收另证（见下）。权威契约见 [capture-p0.md](capture-p0.md)，真实Chromium+fake ctx历史报告见 [t3-vision.md](t3-vision.md) 引用的证据；provider与真实宿主P0重载仍NOT_RUN。
- T2：7 个工具（`browser_snapshot` + `click` / `type` / `scroll` / `fill_form` / `node_state` / `wait_for`），AX 语义树 + 单调 `eN` Ref + 可信输入 + `evidence.version=1`；契约与 38 条验收见 [t2-structured-gui.md](t2-structured-gui.md)，实现/验收状态见 [status.md](status.md)。T2 仍属主 frame + AX-backed open shadow，iframe 内部、closed shadow、原生 select popup/拖拽/上传下载/contenteditable/IME 与视觉判定不在范围内。
- **T3（静态视觉，已实现并通过进程内验收）**：6 个工具 `browser_vision_image` / `find` / `compare` / `act` / `baseline` / `check`（工具面共 22 = 9 T1 + 7 T2 + 6 T3）。纯 JavaScript、零 npm 依赖：PNG 编解码/裁剪/缩放/预处理/标注、YIQ 像素差异与相似度/差异区域高亮/动态 mask、color/components/edges/template 确定性识别、截图坐标的真实 CDP 输入（六步安全校验、失败零派发）、受管基线（不可变 revision + HEAD CAS + 墓碑）、回归与六类缺陷用例（像素信号 + 调用方显式 provenance facts；T3 不主动读 DOM）。权威契约 [t3-vision.md](t3-vision.md)；进程内验收 **56/56 criteria、389/389 required、exit 0**（[报告](../tests/acceptance/runs/2026-11-01T07-34-49-952Z-174834/run-report.json)）。无 VLM/OCR/语义命名；真实宿主重启加载与 provider 图像可见性、T4 仍 NOT_RUN。
- **T4 未实现**：动态视觉（screencast/帧序列/时间戳/时序推理）仍 unsupported；`browser_screenshot` 与 T3 的 before/after 静态两帧都不能证明动画/中间闪烁。面板视觉未变，「选择元素」「打开调试工具」仍禁用。
