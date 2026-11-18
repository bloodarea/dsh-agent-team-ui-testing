# 快速开始

## 1. 安装

准备好 [DSH](https://github.com/deepseek-ai/deepseek-harness) 和 Node.js 24.9+，将插件装到要使用的 profile。

```sh
dsh plugin --profile web add dsh-agent-team-ui-testing
```

上例使用 `web` profile。安装后重启 DSH。需要从 GitHub 安装或固定版本时，参见[其他安装方式](#其他安装方式)。

## 2. 配置并使用目标环境

- [Web 快速开始](web/getting-started.md)说明如何准备浏览器、打开网页并首次调用工具。
- [目标环境定义与配置入口](target-environments.md)索引各环境的运行条件。
- [环境设置](settings.md)说明如何启用环境并检查连接。

## 其他安装方式

npm 安装按 semver 更新。需要 GitHub 来源或固定版本时可使用以下命令。

```sh
# 跟随仓库，package.json 的 version 变化时提示更新
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing

# 固定 tag，不接收更新提示。将 vX.Y.Z 替换为实际标签
dsh plugin --profile web add github:bloodarea/dsh-agent-team-ui-testing#vX.Y.Z
```

开发时可将本仓库链接或复制进 profile。代码和文档改动的生效方式见[验证与贡献](verification.md#改动如何生效)。
