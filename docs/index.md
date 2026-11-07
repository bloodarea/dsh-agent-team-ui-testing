# 文档

本目录提供插件的使用说明、能力参考与贡献者指南。Web / Chromium 已实现 WEB-P0 基础设施与 T1–T4 工具，并通过三类 adapter 契约接入 Host 权威配置、逐 step 工具准入与按环境 Skill 发现；其他运行环境尚未提供真实适配器。

## 开始使用

| 文档 | 内容 |
| --- | --- |
| [快速开始](getting-started.md) | 安装要求、安装与接入、打开面板与首次调用 |
| [工具参考](tools.md) | 36 个工具的参数、返回与错误分类 |
| [能力分层与限制](capability-tiers.md) | WEB-P0 与 T1–T4 的职责、选路与支持边界 |

## 功能参考

| 文档 | 内容 |
| --- | --- |
| [多标签页](multi-tab.md) | 每工作区 primary + 3 child、per-tab BUSY、Agent selectedTab、`browser_tabs`、GUI 内部标签栏与 `+` |
| [视口、画布与标注](viewport-control.md) | 共享视口、坐标、缩放、拖拽、标注与并发控制 |
| [选元素加入聊天框](element-picker.md) | 面板选元素模式、悬浮框选、文档坐标、`@` 元素引用 chip（显示紧凑、模型文本完整）、降级与限制 |
| [截图与图片交付](capture-p0.md) | 截图区域、分辨率、文件留存与证据边界 |
| [网络调试](network-p0.md) | 请求、WebSocket、SSE、链路、控制与证据导出 |
| [结构化 GUI](t2-structured-gui.md) | snapshot/ref、点击、输入、表单与等待 |
| [静态视觉](t3-vision.md) | 图像处理、定位、比较、基线与视觉断言 |
| [动态行为](t4-dynamic-behavior.md) | 帧采集、运动分析、时间轴控制与事件关联 |

## 参与开发

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | 运行时、模块职责、工作区隔离与扩展位置 |
| [三类 adapter：契约、接入与坑点](adapters.md) | TargetAdapter / CapabilityAdapter / P0Provider 的接口形状、配置约束、六轴就绪写法、12 条实测坑点与新平台接入步骤 |
| [验证与贡献](verification.md) | 环境要求、测试命令、结果判读与提交要求 |

公开文档只描述当前行为、可复现的用法和已知限制。实施计划、协作记录、逐轮验收日志和本机环境信息不纳入公开文档；自动生成的报告与截图默认保留在本地。内置 Agent 操作手册随 [ui-testing-web Skill](../skills/ui-testing-web/SKILL.md) 分发。
