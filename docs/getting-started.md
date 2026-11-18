# 快速开始

## 1. 安装

准备好 [DSH](https://github.com/deepseek-ai/deepseek-harness)、Node.js 24.9+ 和本地 Chrome / Chromium（插件不自带浏览器），然后安装到要使用的 profile：

```sh
dsh plugin --profile web add dsh-agent-team-ui-testing
```

上例使用 `web` profile。安装后重启 DSH。需要从 GitHub 安装或固定版本时，参见[其他安装方式](#其他安装方式)。

## 2. 打开页面

从 **更多 → 调试视图** 或右侧边栏的插件卡片打开面板，在地址栏输入你的本地网页地址，例如 `http://127.0.0.1:3000`，按 Enter。该地址需要已有应用服务运行。

找不到浏览器时，用 `DSH_UI_TESTING_CHROME` 指定可执行文件后重新启动 DSH。浏览器路径、执行端和运行模式见[Web 目标环境配置](browser-runtime.md#浏览器路径)。

## 第一次调用

在当前会话中告诉 Agent：

> 查看我刚打开的页面，列出可操作的控件，并把截图保存到 output/capture/first.png。

Agent 应先用 `browser_capabilities`、`browser_state` 核对当前目标，再用 `browser_snapshot` 读取控件、`browser_screenshot` 留存截图。若看到的页面不同，先用 `browser_tabs` 核对并切换目标。

接着指定一个控件，让 Agent 点击或填写，并读取操作后的结果。

## 按需查阅

- 想跟着截图走一遍：[图文教程（tutorial.md）](tutorial.md)。
- 设置环境或检查连接：[环境设置（settings.md）](settings.md)。
- 查面板操作：[调试面板（debug-panel.md）](debug-panel.md)。
- 查参数或选择调试方法：[工具参考（tools.md）](tools.md)、[能力分层（capability-tiers.md）](capability-tiers.md)。

## 其他安装方式

npm 安装按 semver 更新。需要 GitHub 来源或固定版本时可使用以下命令。

```sh
# 跟随仓库，package.json 的 version 变化时提示更新
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing

# 固定 tag，不接收更新提示。将 vX.Y.Z 替换为实际标签
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing#vX.Y.Z
```

开发时可将本仓库链接或复制进 profile。代码和文档改动的生效方式见[验证与贡献](verification.md#改动如何生效)。
