# 快速开始

本插件让 Agent 在真实 Chromium 里操作、检查并验证 Web 界面，并把结论落成可复核的证据。当前只提供 Web / Chromium 适配器。

## 要求

- 已安装 [DeepSeekHarness（DSH）](https://github.com/deepseek-ai/deepseek-harness)。
- **本地已安装 Chrome 或 Chromium：插件不自带浏览器，也不会在安装时自动下载/安装。** 运行时懒解析（第一次真正需要页面时才执行），顺序为：
  1. `DSH_UI_TESTING_CHROME`：显式覆盖，接受绝对路径或 `PATH` 中的单个命令名（Windows 上按 `PATHEXT` 展开）；
  2. `/opt/google/chrome/chrome`（仅 POSIX 宿主）；
  3. `PATH` 中的 `google-chrome-stable`、`google-chrome`、`chromium`、`chromium-browser`；Windows 上另查 `chrome.exe`、`google-chrome-stable.exe`、`google-chrome.exe`、`chromium.exe`、`chromium-browser.exe`；
  4. macOS 的 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`、`Google Chrome Canary.app/...`、`Chromium.app/...`；
  5. Windows 的 `%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramW6432%`、`%LOCALAPPDATA%` 下的 `Google\Chrome\Application\chrome.exe`（stable / Beta / Dev / SxS）与 `Chromium\Application\chrome.exe`。

  找不到时第一个页面工具报 `UNSUPPORTED` 并列出候选路径；显式覆盖无效时如实报错，不会静默回退到别的浏览器。Windows 上**不探测注册表**：Chrome 装在非标准目录、或使用 scoop/choco 的 `.cmd` shim 时，请用 `DSH_UI_TESTING_CHROME` 直接指向 `chrome.exe`。
- 安装参考：Chrome 官方下载 <https://www.google.com/chrome/>；Debian/Ubuntu 也可 `sudo apt install chromium`（或发行版提供的 `chromium-browser`）；macOS 可 `brew install --cask google-chrome`。Windows 用官方安装包（默认装在 `C:\Program Files\Google\Chrome\Application`）。以发行版实际包名为准。
- **有头模式额外要求**：POSIX 宿主需要 `DISPLAY` 或 `WAYLAND_DISPLAY`，否则返回 `DISPLAY_UNAVAILABLE` 并保持无头；Windows 宿主本身有窗口系统，不需要这两个变量。Linux/X11 想彻底隐藏窗口/任务栏/Alt-Tab 需要 `xdotool`（未安装时退化为离屏位置）；Windows 上通过给窗口加 `WS_EX_TOOLWINDOW` 移除任务栏与 Alt-Tab 条目，依赖系统自带的 `powershell.exe`（不可用时退化为"离屏位置 + 任务栏可见"，不影响功能）。默认离屏无可见窗口，设 `DSH_UI_TESTING_HEADED_VISIBLE=1` 可显示窗口；持久 profile 默认 `$DSH_HOME/ui-testing/headed-profile`，可用 `DSH_UI_TESTING_PROFILE_DIR` 覆盖。
- Node.js 24.9 及以上（当前 DSH 发行版的 engines 要求；插件自身使用原生 WebSocket）。

插件以 DSH 插件 bundle 的形式提供，npm 包名为 `dsh-agent-team-ui-testing`；除上文的 Node.js 与 DSH 要求外，没有额外的兼容性矩阵。

## 安装与生效

```sh
# npm 形式（推荐）：按 semver 走，dsh-market 可以提示更新
dsh plugin --profile web add dsh-agent-team-ui-testing

# 浮动 GitHub 形式：也能收到更新，但只有 package.json 的 version 变化时才提示
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing

# 固定 tag 形式：精确复现某一个版本，但永远不会收到更新提示
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing#vX.Y.Z
```

1. 把包安装进要使用的 DSH profile。
2. 首次安装后**重启 DSH**，让插件 bundle 完成注册。
3. 从 **更多 → 调试视图** 打开面板，或从右侧边栏的插件卡片进入。
4. 插件开发时改为把本仓库链接或复制进 profile，不必安装 npm 包。
5. 生效范围：

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

## 设置页

打开 DSH 的「设置」，左侧导航里的 `UI 测试` 就是「目标环境配置」：

- 按环境视图分组，每个环境列出候选前端技术栈：Web视图 Chrome / Edge / Firefox；Linux视图 Electron（调试 Electron 应用）/ Tauri / GTK / Qt / Flutter；Windows视图 WinUI 3 / WPF / WinForms / Electron / Tauri / Qt / Flutter；macOS视图 SwiftUI / AppKit / Electron / Tauri / Qt / Flutter；Android视图 Jetpack Compose / Android Views / Flutter / React Native / Capacitor / Cordova；TUI视图 Textual / Ink / Bubble Tea / Ratatui / blessed；HarmonyOS视图 ArkUI / ArkUI-X / Flutter / React Native / uni-app；小程序视图 微信小程序 / 支付宝小程序 / 抖音小程序 / QQ小程序 / 百度智能小程序 / 快手小程序 / 京东小程序 / 美团小程序 / 小红书小程序 / 淘宝小程序 / 钉钉小程序；游戏视图 Unity / Unreal Engine / Godot / Cocos Creator / Phaser；3D视图 Three.js / Babylon.js / PlayCanvas / WebGL / WebGPU / Unity。
- 十个环境分组**默认收起**，点分组标题展开该环境的候选技术栈卡片，再点一次收起；标题右侧显示目标数量。
- 每张目标卡片显示「环境是否有效：」与版本占位、以及「是否启用：」开关；未支持/未接入的目标禁用开关，并在卡片内部底部显示灰色标签（Edge、Firefox 为「未支持」，其余未接入目标为「未接入」）。
- 当前只做前端：不探测本机环境、不保存启用状态，也不新增 Host 接口；开关只在当前页面内切换，重新打开即复位。

## 安全边界

- 页面访问按 DSH 工作区隔离，写操作串行化并通过 single-owner lease 授权。
- 导航默认只允许 loopback 目标；私网地址需要显式设置 `DSH_UI_TESTING_ALLOW_PRIVATE=1`。DNS、重定向与弹窗都会被校验。
- 截图与网络正文默认不脱敏，分享前请自行检查。
- Cookie 与浏览器存储由 Chromium profile 共享，**不是**登录态隔离。

## 相关文档

- [工具参考](tools.md)
- [能力分层与限制](capability-tiers.md)
- [架构](architecture.md)
