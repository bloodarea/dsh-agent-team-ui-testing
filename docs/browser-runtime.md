# 浏览器运行配置

插件使用本地浏览器，不随安装下载浏览器。默认执行端为 Chrome / Chromium，无头模式按需启动；`browser_state`、`browser_capabilities` 等诊断不会启动浏览器。安装步骤见[快速开始（getting-started.md）](getting-started.md)。

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
| Chrome / Chromium | `DSH_UI_TESTING_CHROME` | 默认执行端 |
| Edge | `DSH_UI_TESTING_EDGE` | 驱动已接入，真实 Edge 启动尚未验证 |
| Firefox | — | 尚未支持，设置卡片不可启用 |

Chrome 与 Edge 使用各自的候选路径；Edge 查找 Linux 的 `microsoft-edge` / `microsoft-edge-stable`、Windows 的 `Microsoft/Edge/Application/msedge.exe` 与 macOS 的 Edge 应用。覆盖无效时不会改用另一厂商。未启用的 provider 不探测；启用但缺少二进制时，依赖诊断报告 `failed / executable-missing`，不会打开页面。

连接后通过 `Browser.getVersion` 校验产品身份：Chrome 的产品串需含 `Chrome/` 且不含 `Edg/`；Edge 需含 `Edg/`。身份不符报 `DEPENDENCY_MISSING / identity-mismatch`；Edge 无法取得产品串时按 `identity-unverified` 拒绝，Chrome 在取得产品串时核对。

执行端的启用与选择见[环境设置（settings.md）](settings.md#启用与选择)。

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

## 目标访问与数据

只接受 HTTP(S) 目标，拒绝带凭据的 URL 和 DSH 自身 origin。loopback 可访问；私网目标需在启动 DSH 前设置 `DSH_UI_TESTING_ALLOW_PRIVATE=1`。DNS、重定向与弹窗会再次校验目标。

页面状态与访问权限的隔离见[多标签页（multi-tab.md）](multi-tab.md)。截图与网络正文默认不脱敏，分享前请检查内容。

## 其他安装方式

npm 安装按 semver 更新。需要 GitHub 来源或固定版本时可使用：

```sh
# 跟随仓库；package.json 的 version 变化时才提示更新
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing

# 固定 tag，不接收更新提示；将 vX.Y.Z 替换为实际标签
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing#vX.Y.Z
```

开发时可将本仓库链接或复制进 profile。代码和文档改动的生效方式见[验证与贡献（verification.md）](verification.md#改动如何生效)。
