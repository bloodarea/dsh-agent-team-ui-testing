# Web 快速开始

先在 DSH 中安装插件，再准备本机的 Chrome 或 Chromium。插件使用宿主已有的浏览器。安装命令见[快速开始](../getting-started.md#1-安装)。

## 打开页面

从 **更多 → 调试视图** 或右侧边栏的插件卡片打开面板，在地址栏输入你的本地网页地址，例如 `http://127.0.0.1:3000`，按 Enter。该地址需要已有应用服务运行。

找不到浏览器时，用 `DSH_UI_TESTING_CHROME` 指定可执行文件后重新启动 DSH。浏览器路径、执行端和运行模式见[Web 目标环境配置](browser-runtime.md#浏览器路径)。

## 第一次调用

在当前会话中告诉 Agent：

> 查看我刚打开的页面，列出可操作的控件，并把截图保存到 output/capture/first.png。

Agent 应先用 `browser_capabilities`、`browser_state` 核对当前目标，再用 `browser_snapshot` 读取控件、`browser_screenshot` 留存截图。若看到的页面不同，先用 `browser_tabs` 核对并切换目标。

接着指定一个控件，让 Agent 点击或填写，并读取操作后的结果。

## 按需查阅

- 想跟着截图走一遍：[图文教程（tutorial.md）](tutorial.md)。
- 设置环境或检查连接：[环境设置（settings.md）](../settings.md)。
- 查面板操作：[调试面板（debug-panel.md）](debug-panel.md)。
- 查参数或选择调试方法：[工具参考（tools.md）](tools.md)、[能力分层（capability-tiers.md）](../capability-tiers.md)。
