# 目标环境定义与配置入口

**目标环境（target environment）定义被测界面的类别，以及插件发现、绑定和操作这类界面时使用的适配器边界。** 在设置页，目标环境对应一个环境分组。一次操作要先确定环境，再由该环境的适配器解析具体目标和可用能力。

## 公共接口

| 概念 | 含义 |
| --- | --- |
| 目标环境 | 被测界面的类别，例如网页、原生桌面或交互式终端 |
| 目标 | 环境内可发现、可绑定的具体被测对象，由该环境的适配器定义其身份和生命周期 |
| 执行端 | 环境实际使用的调试实现。同一环境可以提供多个可选执行端，配置由该环境定义 |
| 宿主平台 | 运行 DSH 和插件的系统。环境配置说明该实现依赖哪些本地程序或服务 |

跨环境接入使用三类接口。`TargetAdapter` 负责就绪探测和目标会话，`CapabilityAdapter` 声明与执行操作，`P0Provider` 提供共享数据服务。各环境通过这些接口提供自己的目标、能力和证据。接口签名、配置快照与生命周期见[适配器接口与接入](adapters.md)。

在 **设置 → UI 测试** 中管理环境启用状态，并查看依赖、连接、目标绑定和能力的诊断结果。启用状态与现场可用性分别判断。各环境所需的依赖、执行端选择、运行参数和验证边界以对应配置文档为准。通用操作见[环境设置](settings.md)。

## 各目标环境的配置

| 目标环境 | 环境 id | 实现状态 | 配置文档 |
| --- | --- | --- | --- |
| Web | `web` | 已接入真实适配器，目标为浏览器页面 | [Web 文档入口](web/index.md) · [运行配置](web/browser-runtime.md) |
| 测试夹具 | `fake` | 已登记的确定性夹具，仅供测试 | [适配器契约](adapters.md) |
| Linux 桌面 | `linux-desktop` | 已登记为 planned：可启用、可切换空白视图，无适配器 | 暂无可执行的运行时配置 |
| Windows | `windows` | 同上 | 暂无 |
| macOS | `macos` | 同上 | 暂无 |
| Android | `android` | 同上 | 暂无 |
| TUI | `tui` | 同上 | 暂无 |
| HarmonyOS | `harmonyos` | 同上 | 暂无 |
| 小程序 | `mini-program` | 同上 | 暂无 |
| 游戏 | `game` | 同上 | 暂无 |
| 3D | `three-d` | `status: supported`：Blender 同时提供视口交互（鼠标、标注、截图）与 Agent 执行适配器（13 个 `blender_*` 工具） | [Blender 纯视口与运行时配置](three-d/index.md) · [Blender Agent 工具与 Skill](three-d/blender-agent.md) |

「默认视图」（`default`，`status: empty`、`kind: view`）是一个**空态视图**，不是目标环境：它只出现在调试面板的组合框里，用来表示"当前没有选择目标环境"，不可启用、不出现在设置页分组。选择语义见[调试面板公共视图 · 视图选择](debug-panel.md#3-视图选择与默认视图)。

## 运行环境（provider）开关

一个目标环境可以有多个**运行环境**：该环境下实际执行或出画面的具体实现。Web 下是 Chrome / Edge / Firefox，3D 下是 Blender。运行环境的 id 词表和工程支持度由 `core/contracts.js` 的 `ENVIRONMENT_PROVIDER_IDS` 与 `ENVIRONMENT_PROVIDER_SUPPORT` 定义，配置层只接受这里登记过的 id。

| 支持度 | 含义 | 卡片开关 | 例子 |
| --- | --- | --- | --- |
| `supported` | 有执行适配器，Agent 能驱动 | 可启用 | Chrome、Edge、Blender |
| `preview` | 只接了纯视口：能看画面、标注、截图，没有 Agent 执行适配器 | 可启用 | —（3D 已升级为 `supported`） |
| `pending` | 可保存启用意图，但没有驱动 | 可启用但不可执行 | — |
| `unsupported` | 没有驱动，本阶段也没有计划 | 灰态不可启用 | Firefox |

运行环境之间是**互斥选择**：同一目标环境同一时刻只启用一种运行环境，打开一个就会关闭同环境的其它（调试视图只对着一个目标）。Web 的单选执行端 `provider` 跟着开关走——打开的开关就是"要跑的那个"；把它们全关也是合法状态，此时该环境没有可用运行环境，执行侧如实报 `provider-disabled`。旧配置里同时开着多个时，加载后收敛成 `provider` 指向的那一个。

设置页的两层开关各有自己的字段，互不改写：

| 层级 | 控件 | 写入字段 |
| --- | --- | --- |
| 目标环境 | 分组标题右侧的总开关 | `environments.<env>.enabled` |
| 运行环境 | 卡片右上角的开关 | `environments.<env>.providers.<id>.enabled`（只对有 provider 轴的环境） |

没有运行环境轴的环境（例如游戏、TUI）只存 `enabled`，写 `providers` 会被判 `CONFIG_INVALID`。关闭总开关不会改写各运行环境已保存的值，重新打开后恢复。

3D 的 Blender 纯视口默认开启，打开 3D 总开关即可出画面。任一开关关闭时，Host 拒绝视口请求并释放 Blender 调试实例。详见 [Blender 视口行为](three-d/debug-panel.md#视口行为)。

环境 id 与显示名以 Host 目录为唯一来源：`core/config.js` 的 `environmentCatalog()`，经 `GET /config` 的 `catalog` 字段提供给面板与设置页。新增环境时先登记目录，再实现适配器；只在客户端加一个视图 id 不算接入。

各环境的能力范围见[能力分层与接口](capability-tiers.md#3-目标环境实现)。新增真实适配器时，在 `docs/<环境 id>/` 为该环境编写配置文档，说明它的目标类型、可用执行端、依赖与启动条件、配置生效方式和验证入口，并在此处和[公开文档索引](index.md)登记。
