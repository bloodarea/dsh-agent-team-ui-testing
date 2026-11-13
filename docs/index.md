# 文档

本目录提供插件的使用说明、能力参考与贡献者指南。通用接口与能力分层面向十个目标环境，具体实现按目标环境和执行端组织。当前已有 Web 目标环境的 Chrome 实现、P0 基础设施与 T1–T4 工具；其他目标环境尚未提供真实适配器。

## 开始使用

| 文档 | 内容 |
| --- | --- |
| [新手图文教程](tutorial.md) | 从打开调试视图到让 Agent 完成一次可复核的操作：加载页面、观察、操作、选元素、标注与取证，全部带截图 |
| [快速开始](getting-started.md) | 安装要求、安装与接入、打开面板与首次调用 |
| [诊断状态码（中英对照）](diagnose-reason-codes.md) | 诊断页每个状态码的英文机器契约与中文界面文案、出现阶段、动态码族与维护方式 |
| [工具参考](tools.md) | 37 个工具的参数、返回与错误分类 |
| [能力分层与接口](capability-tiers.md) | 十个目标环境共用的 T1–T4 定义与接口，按环境和执行端组织实现；包含 Chrome 的完整协议、参数、操作、注册与验证 |

## 功能参考

| 文档 | 内容 |
| --- | --- |
| [多标签页](multi-tab.md) | 页面组按 (workspace, provider, 团队根) 分组、双选择（work/observe）、`browser_tabs` 九动作含队长 acquire/release/transfer、长期归属与控制权、GUI 内部标签栏与 `+` |
| [视口、画布与标注](viewport-control.md) | 共享视口、坐标、缩放、拖拽、光标跟随、标注选择/实时框选/键盘操作与并发控制 |
| [页面右键菜单](panel-context-menu.md) | 页面自绘菜单优先、默认菜单常用操作、可信事件观测与失效边界 |
| [选元素加入聊天框](element-picker.md) | 面板选元素模式、悬浮框选、文档坐标、`@` 元素引用 chip（显示紧凑、模型文本完整）、原生下拉浮层与绑定写回、降级与限制 |
| [截图与图片交付](capture-p0.md) | 截图区域、分辨率、includeAnnotations 标注叠加、文件留存与证据边界 |
| [网络调试](network-p0.md) | 请求、WebSocket、SSE、链路、控制与证据导出 |

## 参与开发

| 文档 | 内容 |
| --- | --- |
| [架构](architecture.md) | 运行时、模块职责、工作区隔离与扩展位置 |
| [适配器接口与接入](adapters.md) | 先定义 TargetAdapter / CapabilityAdapter / P0Provider 的接口与约束，再说明 Chrome 的实现、注册、调用链与验证方式 |
| [验证与贡献](verification.md) | 环境要求、测试命令、结果判读与提交要求 |

公开文档只描述当前行为、可复现的用法和已知限制。实施计划、协作记录、逐轮验收日志和本机环境信息不纳入公开文档；自动生成的报告与截图默认保留在本地。内置 Agent 操作手册随 [ui-testing-web Skill](../skills/ui-testing-web/SKILL.md) 分发。
