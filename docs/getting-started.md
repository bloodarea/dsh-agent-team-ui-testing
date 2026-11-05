# 快速开始

本插件让 Agent 在真实 Chromium 里操作、检查并验证 Web 界面，并把结论落成可复核的证据。当前只提供 Web / Chromium 适配器。

## 要求

- 已安装 [DeepSeekHarness（DSH）](https://github.com/deepseek-ai/deepseek-harness)。
- 本地有 Chrome 或 Chromium。解析顺序：`DSH_UI_TESTING_CHROME`（显式覆盖）→ `/opt/google/chrome/chrome` → `PATH` 中的 `chrome` / `chromium` 等命令名。显式覆盖无效时如实报 `UNSUPPORTED`，不会静默回退。
- Node.js 22 及以上（运行时使用原生 WebSocket）。

插件目前以本地链接方式接入 DSH profile，尚未发布 npm 包，也没有兼容性矩阵。

## 安装与生效

1. 把本仓库链接或复制进 DSH profile。
2. 首次安装后**重启 DSH**，让插件 bundle 完成注册。
3. 从 **更多 → 调试视图** 打开面板，或从右侧边栏的插件卡片进入。
4. 生效范围：

| 改动 | 生效方式 |
| --- | --- |
| `client.js`（面板 UI） | 刷新面板 |
| `index.js`、工具 schema、内置 Skill | 重启 DSH |
| 仅文档 | 无需重启 |

## 第一次调用

建议按「先诊断、再操作、最后取证」的顺序：

```text
browser_capabilities            # 看真实运行态：哪些工具 available、limits 是多少
browser_navigate {url}          # 打开授权目标
browser_state                   # URL / 标题 / 视口 / 错误
browser_snapshot                # 拿 ref，再 click / type / fill_form
browser_screenshot {out}        # 留一张可复核的 PNG
```

典型的完整流程：

1. **确认环境**：`browser_capabilities` 与 `browser_state`，不要用文档或 manifest 代替运行态。
2. **操作**：T2 结构化工具（`browser_snapshot` → `browser_click`/`browser_type`/`browser_fill_form`）。
3. **取证**：`browser_screenshot` 或 T3（`browser_vision_image`/`compare`/`check`）。
4. **看网络**：`browser_network_session start` → 触发真实流量 → `browser_network_events`/`detail`。
5. **看动态**：需要动画、过渡、拖拽、时序时升级到 T4（`browser_dynamic_session` → `browser_motion_observe` → `browser_motion_analyze`）。

## 调试面板

面板与 Agent 读写同一份运行时状态。

- **实时预览**：CDP screencast 帧，WebSocket 推送优先、HTTP 轮询兜底。
- **尺寸栏**：宽屏 / 横屏 / 平板 / 手机预设，X/Y 画布位置，宽 × 高，显示比例，`拖拽 | 适应窗口 | 默认` 模式。
- **混合画布**：视口可像画布一样定位，支持负坐标、空白区域、拖拽平移与滚轮缩放。
- **标注**：圆形、矩形、线段、箭头、画笔、文字、橡皮擦；标注锚定画布坐标，模式内页面不接收输入，Agent 可通过 `browser_state.annotations` 读回。
- **内部标签页**：真人点击 `target=_blank` / `window.open` 时，面板会在地址栏下方新增内部标签并自动切过去，原页面保留为另一个标签；标签栏由「标注」左侧开关控制显隐，单标签时也显示并可新建；`+` 只在标签栏内，工具栏不常驻。Agent 工具默认操作各自会话的 selectedTab（无选择 primary），可用 `browser_tabs` 查看/选择；GUI 切页不改 Agent 选择。自动弹窗与未授权弹窗仍被阻断。
- **调试工具**：「更多 → 打开调试工具」为当前页面请求一个独立窗口，加载 Chrome 自带的 DevTools（与 F12 等价）。需要当前工作区的浏览器运行时已启动；只有 GUI 与 DSH 同机、且通过 loopback（127.0.0.1/localhost）访问时可用，远程 GUI 暂不支持。弹窗被浏览器拦截时，面板会显示提示和「在新标签页打开调试工具」链接。
- **共享状态**：面板与 Agent 使用同一 `expectedRevision`，冲突会明确报告而不是静默覆盖。

## 安全边界

- 页面访问按 DSH 工作区隔离，写操作串行化并通过 single-owner lease 授权。
- 导航默认只允许 loopback 目标；私网地址需要显式设置 `DSH_UI_TESTING_ALLOW_PRIVATE=1`。DNS、重定向与弹窗都会被校验。
- 截图与网络正文默认不脱敏，分享前请自行检查。
- Cookie 与浏览器存储由 Chromium profile 共享，**不是**登录态隔离。

## 相关文档

- [工具参考](tools.md)
- [能力分层与限制](capability-tiers.md)
- [架构](architecture.md)
