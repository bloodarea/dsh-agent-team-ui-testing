# 公开文档

从目标环境索引进入具体配置和操作指南。目前支持 Web 调试与测试，以及 Linux 和 Windows 上的 Blender 纯视口与 Agent 工具面。

## 目标环境

| 文档 | 内容 |
| --- | --- |
| [目标环境定义与配置入口](target-environments.md) | 目标环境、目标、执行端、宿主平台及接入状态 |
| [Web 目标环境文档](web/index.md) | 浏览器配置、实操教程、能力、工具、运行时实现与验收 |
| [3D 目标环境文档](three-d/index.md) | 视口、工程加载、工作区实例、参考图、时间轴、原生浮窗与运行时配置 |
| [Blender Agent 工具与 Skill](three-d/blender-agent.md) | 13 个 `blender_*` 工具、分组披露、写入前置、受控 op、错误码与 Director Skill |

## 公共接口与机制

| 文档 | 内容 |
| --- | --- |
| [快速开始](getting-started.md) | 插件安装及环境上手入口 |
| [环境设置](settings.md) | 环境启用、配置保存及诊断流程 |
| [架构](architecture.md) | 公共职责、模块与执行链路 |
| [客户端开发](verification.md#客户端开发) | 客户端源码目录、构建及发布检查 |
| [适配器接口与接入](adapters.md) | TargetAdapter、CapabilityAdapter、P0Provider 与接入步骤 |
| [能力分层与接口](capability-tiers.md) | T1–T4 定义、证据要求及 P0 家族 |
| [工具准入与参考索引](tools.md) | 工具准入和各环境工具参考 |
| [工具参数声明与模型网关兼容性](tool-parameter-schemas.md) | 对象根节点、多动作参数、执行校验与网关回归验证 |
| [调试面板公共视图接口](debug-panel.md) | 公共外壳、环境正文、标注映射和空白画布 |
| [图像采集与交付](capture-p0.md) | P0-A 采集与证据接口 |
| [网络采集与证据](network-p0.md) | P0-B 事件、会话与证据接口 |
| [显示空间、画布与标注](viewport-control.md) | P0-C/D 的几何与标注文档接口 |
| [多目标管理](multi-tab.md) | P0-E 多目标管理接口和公共标签栏 |
| [诊断状态码](diagnose-reason-codes.md) | 公共诊断页使用的机器码与界面术语 |
| [验证与贡献](verification.md) | 公共验证、报告判读和提交要求 |

环境专用实现放在 `docs/<环境 id>/`，并从对应公共主题及目标环境索引进入。公开文档记录当前行为、可复现用法和已知限制。内置 Web Agent 操作手册随 [ui-testing-web Skill](../skills/ui-testing-web/SKILL.md) 分发。
