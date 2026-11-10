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
   面板里的键盘会转发到页面（含 `Ctrl/Cmd/Alt/Shift` 组合、F1–F12、Home/End/PgUp/PgDn/Delete/Insert）。原生弹层（`alert/confirm`、浏览器默认右键菜单）由浏览器 UI 绘制、面板里看不到；预览区内的右键仍会转发给页面——页面自己画的右键菜单能出现在帧里，而 DSH Web 自己的右键菜单不会在预览里弹出；**单选 `<select>` 例外**：点一下就在点击点弹出面板侧浮层（↑↓ / Enter / Esc、点外部关闭），选项来自 Host 的只读 `POST /element`，选中后走 `POST /select` 写回。`multiple`/`size>1`/无选项会在地址栏下方、预览外提示改用键盘，Esc 可关闭提示；同进程 `<iframe>` 内的单选 `<select>` 同样有浮层。自定义下拉沿用页面自己的交互。
   两个入口共用同一套视图：**右上角的「选择运行环境」组合框决定下方渲染哪个目标环境的视图**，而组合框**只列出设置页里已打开的目标环境**——例如只开了 Web 与 Android，就只出现这两项，没开的连选项都没有。当前只有 Web 视图实现了：选中 Android 这类已启用但没有视图的环境，会显示「视图层暂不支持」占位，并明确写出「执行环境仍然是 Web 视图，这里只切换视图」——**切视图不改执行环境**。把某个环境的开关关掉后，若当时正停在它的视图上，面板会退回宿主当前的执行环境。
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

卡片表示五节点链路的第五节点——被调试的运行时或应用；框架与图形 API 放在说明中。候选目标如下：

| 环境分组 | 卡片目标 | 技术栈说明举例 |
| --- | --- | --- |
| Web | Chrome、Edge、Firefox（运行环境 = provider） | 相应浏览器中运行的网页 |
| Linux | Linux 原生桌面应用、Electron 应用、Tauri 应用 | GTK / Qt / Flutter、Chromium、WebKitGTK |
| Windows | Windows 原生桌面应用、.NET 桌面应用、WinUI 3 应用、Electron 应用、Tauri 应用 | Win32 / Qt / Flutter、WPF / Windows Forms、Windows App SDK、WebView2 |
| macOS | macOS 原生桌面应用、Electron 应用、Tauri 应用 | AppKit / SwiftUI / Qt / Flutter、Chromium、WKWebView |
| Android | Android 原生应用、Android WebView 应用、Flutter Android 应用、React Native 应用 | Views / Compose、Capacitor / Cordova、Flutter 引擎、原生视图与 JS 运行时 |
| TUI | Python、Node.js、Go、Rust 终端应用 | Textual、Ink / blessed、Bubble Tea、Ratatui |
| HarmonyOS | 鸿蒙原生应用、ArkUI-X 应用、Flutter 鸿蒙应用、React Native 鸿蒙应用 | ArkUI / ArkTS 与相应适配应用 |
| 游戏 | Unity 游戏、Unreal 游戏、Godot 游戏、Cocos 游戏 | 对应引擎运行实例（浏览器内运行的 Web 游戏归 Web 环境，不在此重复列出） |
| 3D | Web 三维应用、原生三维应用、Unity 三维应用、Blender、3ds Max、MikuMikuDance、PMX Editor | Three.js / Babylon.js / PlayCanvas、WebGL / WebGPU、原生窗口与 Unity Player、Blender / 3ds Max 编辑界面、MMD 与 PMX 模型工具 |
| 小程序 | 微信、支付宝、抖音、QQ、百度智能、快手、京东、美团、小红书、淘宝、钉钉小程序 | 对应小程序容器中的应用 |

- 十个环境分组、共 48 张卡片，分组**默认收起**；标题右侧显示当前筛选下的目标数量。展开/收起状态保存在浏览器 `localStorage`，刷新或重开设置页保持。
- 右上角「隐藏未实现」默认关闭；开启后只保留已实现的运行环境（卡片上标「可用」的那些），没有剩余目标的分组一并隐藏。它只筛选页面展示，不改变工具、Skill 或目标的启用配置。
- 卡片只保留名称、启用分开关，以及页脚：左下角是状态槽——**已实现**标一枚绿色「可用」，未实现放一行灰色小字「未支持」或「未接入」；右下角固定「诊断」按钮。不再显示「当前使用 / 未选中」标记（开关本身已反映启用状态），也不再使用「已实现 / 未支持 / 未接入」的药丸标签。说明文字统一压到两行（超出省略，鼠标悬停可看全文），因此同一行卡片高度稳定一致。
- 设置页的**目标环境总开关**：v1 只有 Web 有适配器，但**其余 9 个环境允许先打开开关**——「启用」不等于「可执行」：开关打开后它才出现在面板的组合框里（视图层没实现则显示占位），而执行环境仍然只能是已实现且已启用的那一个（把 `planned` 环境设为当前执行环境依旧会被宿主拒绝）。宿主返回的英文校验原因（`environment X is planned and cannot be selected in v1`、`unknown environment/provider`、`test-only`）在界面上统一翻成中文，原文只留在悬停提示里。
- 点卡片上的「诊断」会在**独立弹层**（frame-wide overlay，不再挤在设置页里）打开诊断面板，面板宽度 `min(1180px, 94vw)`，设置页本身仍是环境分组列表；关闭方式有 ✕ 按钮、`Esc`、点遮罩三种，关闭会中止进行中的检查并把焦点还给卡片按钮。打开面板会**真实执行一次诊断 run**（`POST /plugins/ui-testing/diagnose`，NDJSON 流）：打开即发起一次 `observe` run，不会启动浏览器；页面按五个阶段（① 宿主集成/工具注册/调用通道、② 插件 Core/配置/调度、③ 通信接口探测、④ 执行后端与依赖、⑤ 目标列表/绑定/连接）逐条回填。节点与边只用 Host 的五个结果状态：**正常 / 警告 / 异常 / 跳过 / 未知**（「正常」绿、「警告」琥珀、「异常」红虚线、「跳过」灰虚线、「未知」灰蓝点线）；界面上只显示中文，英文状态码与原因码（`WARN`、`browser-not-running` 等）只出现在 `data-uts-*` 属性与 NDJSON 的 `reason` 里，供 agent 解析。所以「警告」是**已经得出的诊断结论**，不是让你再去点一次。四个板块右上角原来那几条英文装饰（`HOST RUN · STAGED CHECKS` 等）已去掉，同样的值仍从 `data-uts-*` 属性可读。每个调试节点的状态区固定预留两行（30px），超出两行才截断；**鼠标悬停在节点上**会给出完整信息：角色与名称、职责、完整状态、原因码、阻塞于哪一段、耗时；顶部胶囊的悬停提示同样带完整状态句。面板四块从上到下是**调试流程**（步骤 1–5 的链路）、**各模块诊断状态**（六轴卡片）、**诊断日志**、**步骤职责**；调试流程里每张步骤卡片的职责描述固定占两行，「能力就绪」的检查项一行一项、最多三行（还有几条就写在第三行末尾，如「快照：跳过 +3」，悬停看全部），六张模块卡片都按三行占位，所以卡片高度不随结果长短跳动；界面上用中文术语（本轮、宿主、阶段开始/结束、只读求值、目标列表、快照、截图），英文原词只在 `data-uts-*` 与 NDJSON 里，逐条对照见 [诊断状态码](diagnose-reason-codes.md)。还没有任何 run 结果时，总览与节点写「**待诊断**」；run 没能跑出结果时写「**诊断未完成**」（错误另起一行说明）——这两个词不属于五态，只是「本轮还没有结论」。状态码与状态词本身是英文机器契约（`data-uts-*`、NDJSON 的 `reason`），界面上只显示中文译文，逐条对照见 [诊断状态码](diagnose-reason-codes.md)。没有 run 就没有 `PASS`：这里不拿 readiness 快照冒充「已检查」。拓扑里 ④「Chromium DevTools」为绿色意味着 ③→④ 这一段在本 run 里 PASS，不会再出现「节点绿、前面那条边却断」的矛盾。页面顶部**始终**有「开始诊断」按钮：手动触发一轮 `start` 模式的真实检查；浏览器未运行时由该动作启动所选浏览器并创建受管调试页，已连接时只重新检查、不重启浏览器；打开页面本身的自动检查仍然是不启动浏览器的 `observe`，在用户点击之前不会启动任何浏览器。离开诊断页会中止进行中的 run（Host 侧随之停止），不会留下迟到执行。每次点「诊断」进入本页都会发起一次新的 `observe` run（相同 provider 也一样），旧结果只用于离开前的回显；进入时不会重放上一次的动画。
- **两层开关。** 分组标题栏里是**目标环境总开关**（写 `environments.<env>.enabled`）；卡片里的「用户启用」是**运行环境分开关**（Web 分组下写 `environments.web.providers.<id>.enabled`，即 `chrome` / `edge` / `firefox` 各一份）。两者独立：开一个 provider 不会切换当前执行端，也不会改动其它 provider；关闭总开关时所有分开关置灰不可点，但**已保存的值原样保留**（不写 0），重新打开后按原值显示。
- **运行环境（provider）与当前执行端。** 一个 `web` 目标环境下可以有多个 provider，执行时按 `provider` 单选。选择链为：会话选择 > 父会话 > 工作区 > 全局 > 默认 `chrome`；当前 provider 被禁用时**不会静默切换到别的浏览器**，而是保留选择并阻断执行（错误码见 [adapters.md](adapters.md) 的错误语义）。卡片不再单独标出「当前使用 / 未选中」，该值仍由 Host 投影提供（`GET /state` 的 `resolved.provider` 与 `[data-uts-provider-current]` 属性），只是不在界面上重复写第二遍。预览面板仍按工作区展示，不按 provider 分栏。
- **配置形状。** `environments.web` 下有 `provider`（当前执行端，默认 `chrome`）与 `providers.{chrome,edge,firefox}.enabled`；`enabledProviders` 是**派生**列表，不单独存储。更早版本写下的、没有 `provider` 字段的配置文件会被自动按「chrome 默认选择 + chrome 启用」解释，**不会**被判为配置损坏。
- **配置真值在 Host**：设置页每次打开时自动读取一次 `GET /plugins/ui-testing/config?view=global`（页面上不再有「重新读取」按钮），启用开关通过 `PUT /plugins/ui-testing/config` 提交并携带 `expectedRevision`。成功用返回的 revision 更新；冲突（`CONFIG_CONFLICT`）会展示最新 revision 并回滚，不显示“已保存”。配置文件默认在 `${DSH_HOME}/ui-testing/config.json`，可用 `DSH_UI_TESTING_CONFIG_DIR` 覆盖。
- **工具布局由面板决定**：设置页里启用了哪些环境，模型请求里就出现这些环境的工具（外加两个环境无关诊断），不会带入其它环境的 schema；关掉某个环境即从请求里消失，不需要重启。
- **各模块诊断状态（六轴）与诊断日志都来自本轮诊断**：六轴仍是原来的词表（`工程支持 / 目标绑定 / 用户启用 / 能力就绪 / 依赖可用 / 连接可信`），值取自 `run-end.axes`，每轴带 `source=run`、`runId`、`checkedAt` 与 `checks`；「用户启用」始终是 Host 配置里保存的开关，「能力就绪」来自本次真正跑过的六条**只读**探测：只读表达式求值、目标列表、结构化快照、截图、计算样式、网络元数据读取；它们不改页面、不导航、不落盘（截图只留字节数/尺寸/哈希摘要，快照只留节点数与 id）。六条全过才标「可用」，部分通过标「部分可用」，冷态没有连接时标「未探测」。「本次 run / 就绪快照 / 副作用 / 实际调用」这些运行信息不占版面，放在状态胶囊的**悬停提示**里；「开始诊断」会不会启动浏览器、会不会重启，也在按钮的**悬停提示**里说明。没有 run 时才回退到 readiness 快照并标明来源。事件流每个 `stage-end` 一行，显示 Host 实测 `durationMs`、状态、原因与 `blockedBy`；SKIPPED 阶段没有实际耗时，显示「—」而不是 0。run 进行中暂停 5 秒 readiness 轮询；run 结束后六轴与拓扑以 run 结果为准，轮询只更新「就绪快照」时间戳，不会把结果换回 readiness。证据边界：readiness 快照只说明配置与探测结果，不等于一次真实调用；只有本 run 的 `actualCalls`（`browser_capabilities`、只读 `browser_eval`）才是真实执行的证据。
- 依赖探测只做低干扰检查（可执行文件是否存在），不启动浏览器、不扫描未启用环境；连接与能力探测在需要时另行执行，读取型探测不证明输入已生效。
- 面板顶栏「运行环境」选择器读取同一份 Host 配置的 `enabledEnvironments`；切换时 `POST /plugins/ui-testing/config/select` 只写当前会话，成功才更新本地状态。未实现环境仍禁用，且不会触发任何探测。
- 生效方式：`client.js` 改动刷新当前 DSH GUI 后生效；`index.js`、工具注册、Skill provider 与配置存储改动需要重启或重挂插件。已注入历史的 Skill 正文不会被开关自动移除，切换只对后续轮次生效。

## 运行环境（provider）：Chrome 与 Edge

- **可执行文件按厂商分立**：Chrome 与 Edge 各有一份候选清单（Linux `microsoft-edge` / `microsoft-edge-stable`、Windows `Microsoft/Edge/Application/msedge.exe`、macOS Edge `.app` 内的可执行文件），互不混用。
- **覆盖变量按 provider 分开**：Chrome 用 `DSH_UI_TESTING_CHROME`，Edge 用 `DSH_UI_TESTING_EDGE`。显式值**权威且不回退**：Edge 的值不可用时直接报 `DEPENDENCY_MISSING`（reason `override-invalid`），不会改用 Chrome。
- **profile 按 provider 独立**（无头用一次性临时目录；有头持久目录也按 provider 分开），Chrome 与 Edge 不共享同一个有头 profile。
- **启动后校验产品身份**：连上 CDP 之后用 `Browser.getVersion` 的产品串确认实际启动的是哪个厂商（Edge 必须含 `Edg/`，Chrome 必须含 `Chrome/` 且不含 `Edg/`）。"连上"不等于"开对了"；对不上报 `DEPENDENCY_MISSING`（reason `identity-mismatch`），Edge 拿不到产品串则按 `identity-unverified` 拒绝启动。
- **Edge 的当前边界（务必按字面理解）**：Edge 的驱动与参数化代码已接入（复用同一套 CDP 连接、目标生命周期、输入、结构树、截图、网络与帧采集实现），但**本轮没有在装了 Edge 的机器上实际拉起过**。在没有 Edge 二进制的机器上：Edge 未启用时依赖轴是「未探测」（未启用不探测）；**启用之后**依赖轴变为 `failed / executable-missing`（卡片上「依赖」一行直接显示），此时启用它不会有任何页面被打开——这**不代表 Edge 已验证可用**。
- **Firefox 当前未支持**：卡片置灰，开关不可点。

## 安全边界

- 页面访问按 DSH 工作区隔离，写操作串行化并通过 single-owner lease 授权。
- 导航默认只允许 loopback 目标；私网地址需要显式设置 `DSH_UI_TESTING_ALLOW_PRIVATE=1`。DNS、重定向与弹窗都会被校验。
- 截图与网络正文默认不脱敏，分享前请自行检查。
- Cookie 与浏览器存储由 Chromium profile 共享，**不是**登录态隔离。

## 相关文档

- [工具参考](tools.md)
- [能力分层与限制](capability-tiers.md)
- [架构](architecture.md)
