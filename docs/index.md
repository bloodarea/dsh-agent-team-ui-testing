# 文档

本目录提供插件的使用说明、能力参考与贡献者指南。当前已实现 Web 目标环境下的 Chrome 适配器、P0 基础设施与 T1–T4 工具；其他目标环境尚未提供真实适配器。

按查阅目的选择入口：首次安装看「安装与上手」，使用界面看「调试面板与交互」，查询工具和证据看「能力、工具与取证」，排查问题看「诊断与验证」，理解实现或新增环境看「架构与扩展」。

## 安装与上手

| 文档 | 内容 |
| --- | --- |
| [快速开始（getting-started.md）](getting-started.md) | 安装插件、打开页面、让 Agent 完成第一次操作 |
| [新手图文教程（tutorial.md）](tutorial.md) | 用可复制的对话和配图完成订单查询、选元素、圈图与保存结果；附本地演示材料 |
| [开发者进阶（tutorial-advanced.md）](tutorial-advanced.md) | 手动启动演示、理解工具调用与结果验证，进阶检查网络、布局和动态行为 |
| [浏览器运行配置（browser-runtime.md）](browser-runtime.md) | 浏览器路径、Chrome / Edge、有头模式、profile、目标访问与其他安装方式 |
| [环境设置（settings.md）](settings.md) | 环境与执行端的启用、选择、配置保存，以及诊断流程与证据判读 |

## 调试面板与交互

| 文档 | 内容 |
| --- | --- |
| [调试面板（debug-panel.md）](debug-panel.md) | 公共视图接口、环境正文与标注映射接点、Web 实现，以及其他目标环境的公共空白画布与接线边界 |
| [多标签页（multi-tab.md）](multi-tab.md) | 打开、切换和关闭页面，理解 Agent 选页、团队访问权限与控制权 |
| [视口、画布与标注（viewport-control.md）](viewport-control.md) | 调整视口、坐标和缩放，使用拖拽、光标跟随、标注选择与框选 |
| [选元素加入聊天框（element-picker.md）](element-picker.md) | 在画面中选取元素，以 `@` 引用加入聊天框，以及原生下拉浮层的操作与限制 |
| [页面右键菜单（panel-context-menu.md）](panel-context-menu.md) | 页面自绘菜单与面板默认菜单的行为、常用操作与失效边界 |

## 能力、工具与取证

| 文档 | 内容 |
| --- | --- |
| [能力分层与接口（capability-tiers.md）](capability-tiers.md) | 十个目标环境共用的 T1–T4 定义、选路和证据要求，以及 Chrome 各层的完整实现与调用说明 |
| [工具参考（tools.md）](tools.md) | 37 个工具的名称、参数、返回与错误分类 |
| [截图与图片交付（capture-p0.md）](capture-p0.md) | 截图区域、分辨率、标注叠加、文件留存与图片交付的证据边界 |
| [网络调试（network-p0.md）](network-p0.md) | 请求、WebSocket、SSE、业务链路、网络控制与证据导出 |

## 诊断与验证

| 文档 | 内容 |
| --- | --- |
| [诊断状态码（中英对照，diagnose-reason-codes.md）](diagnose-reason-codes.md) | 查询诊断页状态码的含义、出现阶段、动态码族与维护方式 |
| [验证与贡献（verification.md）](verification.md) | 验证环境、测试命令、报告判读、真实目标验证与提交前检查 |

## 架构与扩展

| 文档 | 内容 |
| --- | --- |
| [架构（architecture.md）](architecture.md) | 理解运行时、模块职责、工作区隔离与扩展位置 |
| [适配器接口与接入（adapters.md）](adapters.md) | TargetAdapter / CapabilityAdapter / P0Provider 的职责与接口、Chrome 接线，以及新增环境的接入与验证步骤 |

公开文档只描述当前行为、可复现的用法和已知限制。实施计划、协作记录、逐轮验收日志和本机环境信息不纳入公开文档；自动生成的报告与截图默认保留在本地。内置 Agent 操作手册随 [ui-testing-web Skill（SKILL.md）](../skills/ui-testing-web/SKILL.md) 分发。
