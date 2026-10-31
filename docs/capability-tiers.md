# 能力分层：Web 的 T1–T4（现行标准）

> 索引：[docs/index.md](index.md)

四层是**选择与回退策略**，不是必须逐层执行的流水线：挑"够用且成本最低的可靠路径"，不通再往下退。涉及外观/交互的验收必须有 UI 层证据，不能拿 T1 的成功当界面测试通过。

| 层级 | 推荐技术栈 | 主要能力 | 参考项目 | 实现策略 |
| --- | --- | --- | --- | --- |
| **T1 程序化接口** | Playwright `APIRequestContext` + CDP `Runtime`/`Input`/`Network` | HTTP API、JS 执行、原生事件、网络抓包、CSSOM | Playwright、Chrome DevTools MCP | 直接复用 |
| **T2 结构化 GUI** | Playwright Locator / ARIA Snapshot + CDP `DOM`/`Accessibility`/`Overlay` | DOM 树、Shadow DOM、元素选取、结构化定位、布局属性 | Playwright MCP、agent-browser | 复用 + 统一节点协议 |
| **T3 静态视觉理解** | Playwright Screenshot + Sharp + Pixelmatch + VLM | 截图、局部放大、像素差异、布局缺陷、视觉语义判断 | Sharp、Pixelmatch、Argos | 复用算法，自研判定 |
| **T4 动态视觉理解** | Web Animations API + CDP `Animation`/`Screencast` + Sharp；按需 FFmpeg / OpenCV | 动画时间轴、连续帧、淡入淡出、运动轨迹、卡顿分析 | CDP Animation、rrweb、OpenCV | 复用采集，自研时序验证 |

## 两条约束

- **只对 Web 定义过 T1–T4。** 其他运行环境（Windows / Android / Linux / macOS / TUI / HarmonyOS / 游戏 / 3D）尚未定义，不要照搬 Web 的技术栈去假设它们的实现路径。
- `README.md` / `README_zh.md` 的分层章节已同步为同一套 T1–T4（技术栈表、架构图节点、R2 里程碑），三处表述一致；再调整分层时三份文件要一起改。

## 对当前实现的含义

调试视图当前通过无头 Chromium + CDP 提供部分 T1 工具及 screencast 预览，已经有真实 T1 通道；M0–M2 工具面与待验收状态见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)。T2 DOM/ARIA/结构化节点协议仍未实现，「选择元素」「打开调试工具」继续禁用；单纯有 CDP 连接或可见截图不代表 T2/T3/T4 已实现。
