# Web 目标环境配置

Web（`web`）是[目标环境接口](../target-environments.md#公共接口)的浏览器实现，具体目标是浏览器页面。Linux、macOS 和 Windows 均可作为这个实现的宿主平台。

插件使用宿主机已有的浏览器。默认执行端为 Chrome / Chromium，在首次需要页面时以无头模式启动。`browser_state`、`browser_capabilities` 等诊断不会启动浏览器。插件安装步骤见[快速开始](../getting-started.md)。

## 浏览器路径

Chrome 在第一次需要页面时解析可执行文件，按以下顺序查找：

1. `DSH_UI_TESTING_CHROME`：接受绝对路径或 `PATH` 中的单个命令名；Windows 按 `PATHEXT` 展开命令名。
2. POSIX 宿主上的 `/opt/google/chrome/chrome`。
3. `PATH` 中的 `google-chrome-stable`、`google-chrome`、`chromium`、`chromium-browser`；Windows 另查对应的 `.exe` 名称与 `chrome.exe`。
4. macOS 的 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`、Google Chrome Canary 与 Chromium 的应用内可执行文件。
5. Windows 的 `%ProgramFiles%`、`%ProgramFiles(x86)%`、`%ProgramW6432%`、`%LOCALAPPDATA%` 下的 Chrome（stable / Beta / Dev / SxS）与 Chromium 安装目录。

显式覆盖无效时直接报错，不回退到其他候选。找不到 Chrome 时，页面工具会报错并列出尝试过的路径；底层解析器使用 `UNSUPPORTED`，适配器依赖诊断还会给出 `executable-missing` 或 `override-invalid` 等原因。

Windows 不查注册表；非标准安装目录或 scoop/choco 的 `.cmd` shim 应改为直接指向 `chrome.exe`。环境变量需要在启动 DSH 的进程环境中设置。

浏览器可从 [Chrome 官网](https://www.google.com/chrome/) 安装；Debian/Ubuntu 可使用发行版提供的 `chromium` 或 `chromium-browser` 包，macOS 可用 `brew install --cask google-chrome`。

## Chrome、Edge 与 Firefox

| 执行端（provider） | 可执行文件覆盖 | 当前边界 |
| --- | --- | --- |
| Chrome / Chromium（`chrome`） | `DSH_UI_TESTING_CHROME` | 默认启用并选中的执行端 |
| Edge（`edge`） | `DSH_UI_TESTING_EDGE` | 默认关闭。驱动已接入，真实 Edge 启动尚未验证 |
| Firefox（`firefox`） | — | 尚未支持，设置卡片不可启用 |

Chrome 与 Edge 使用各自的候选路径；Edge 查找 Linux 的 `microsoft-edge` / `microsoft-edge-stable`、Windows 的 `Microsoft/Edge/Application/msedge.exe` 与 macOS 的 Edge 应用。覆盖无效时不会改用另一厂商。未启用的 provider 不探测；启用但缺少二进制时，依赖诊断报告 `failed / executable-missing`，不会打开页面。

连接后通过 `Browser.getVersion` 校验产品身份：Chrome 的产品串需含 `Chrome/` 且不含 `Edg/`；Edge 需含 `Edg/`。身份不符报 `DEPENDENCY_MISSING / identity-mismatch`；Edge 无法取得产品串时按 `identity-unverified` 拒绝，Chrome 在取得产品串时核对。

## 启用与选择 Web 执行端

打开 **设置 → UI 测试 → Web**。打开 Web 总开关和所需浏览器卡片的「用户启用」开关。打开卡片开关后，当前执行端保持原选择。通用的选择与诊断操作见[环境设置](../settings.md#启用与选择)。

- Host 使用 `environments.web.providers.<id>.enabled` 保存各浏览器的启用状态，使用 `environments.web.provider` 保存全局或工作区的执行端选择。`enabledProviders` 从启用状态派生。缺少 provider 字段的旧配置默认启用并选择 Chrome。
- 当前执行端依次取会话、父会话、工作区和全局的设置，缺省为 Chrome。所选执行端被禁用时，Host 保留选择并阻断执行。可从 Host 状态的 `resolved.provider` 查看生效值。调试面板预览按目标环境展示。

## 无头与有头模式

Web 视图可切换无头与有头模式。切换会关闭当前浏览器进程及其页面，下次打开页面时按新模式启动。

| 项目 | 行为 |
| --- | --- |
| 默认模式 | 无头；每次启动使用临时 profile |
| 有头的显示依赖 | POSIX 需要 `DISPLAY` 或 `WAYLAND_DISPLAY`，缺失时报 `DISPLAY_UNAVAILABLE` 并保持无头；Windows 不需要这两个变量 |
| 有头窗口 | 默认放在屏幕外；`DSH_UI_TESTING_HEADED_VISIBLE=1` 显示窗口 |
| Linux/X11 隐藏 | 使用 `xdotool` 隐藏窗口和任务栏条目；缺失时保留离屏位置 |
| Windows 隐藏 | 使用系统 `powershell.exe` 设置 `WS_EX_TOOLWINDOW`；不可用时保留离屏位置，任务栏条目可能可见 |
| 有头持久 profile | Chrome 默认 `${DSH_HOME}/ui-testing/headed-profile`，Edge 为 `headed-profile-edge`；未设 `DSH_HOME` 时使用 `~/.dsh` |
| profile 路径覆盖 | `DSH_UI_TESTING_PROFILE_DIR`；使用不同 provider 时应分别指定目录 |

默认 profile 按 provider 分开。同一 profile 内的 Cookie、存储和缓存共享，不构成登录态隔离。

## 声音与自动播放

插件启动浏览器时固定带 `--mute-audio` 与 `--autoplay-policy=no-user-gesture-required`：

- `--mute-audio` 让页面声音**不出宿主音箱**（无头和有头都一样），页面音频另走调试面板的「声音」开关，见[调试面板 · 页面声音](debug-panel.md#页面声音)。
- `--autoplay-policy=no-user-gesture-required` 让页面和自己的采集 `AudioContext` 在没有用户手势时也能运行；没有它，无头页面会停在 `suspended`，既不自动播放也采集不到。
- 这两项是固定行为，不提供单独开关；需要页面在真实自动播放策略下表现不同时，用独立 Chrome 手动复核。

## 目标访问与数据

只接受 HTTP(S) 目标，拒绝带凭据的 URL 和 DSH 自身 origin。loopback 可访问；私网目标需在启动 DSH 前设置 `DSH_UI_TESTING_ALLOW_PRIVATE=1`。DNS、重定向与弹窗会再次校验目标。

页面状态与访问权限的隔离见[多标签页（multi-tab.md）](multi-tab.md)。截图与网络正文默认不脱敏，分享前请检查内容。

## Web 诊断

设置页的 `observe` 检查只读当前状态，不启动浏览器。`start` 在冷态启动所选浏览器并创建受管调试页。已有连接时重新检查，继续使用当前浏览器。

Web 检查只读求值、目标列表、快照、截图、计算样式和网络元数据。截图只留字节数、尺寸和哈希，快照只留节点数和 id。检查过程不导航、不落盘。全部通过报告可用，部分通过报告部分可用，冷态无连接报告未探测。页面输入效果需要独立证据。

诊断操作与证据字段见[环境设置](../settings.md#诊断流程)。

## 其他安装方式

GitHub 安装、固定版本和本地开发安装方式见[快速开始](../getting-started.md#其他安装方式)。
