# 多目标管理（P0-E）

P0-E 是跨目标环境的多目标管理基础设施。“标签页”是调试控制端组织多个独立目标的方式；目标可以是浏览器页面，也可以是应用实例、窗口或资产会话。Web 是当前已有的具体实现，其他环境的实现接点留空。

## 1. 公共抽象

### 目标与标签的映射

一个标签对应一个可独立寻址、选择和管理生命周期的目标。目标适配器决定它实际代表什么：

| 目标环境 | 标签对应的目标 | 当前实现 |
| --- | --- | --- |
| Web | 浏览器标签页及其独立页面 Runtime | [已接入](web/multi-tab.md#2-具体实现web) |
| 3D / Blender | 可映射为多个 Blender 实例，每个实例加载一个 3D 资产 | 未实现，接口留空；此处仅说明映射方式 |
| 桌面、移动端、TUI、游戏等 | 由适配器定义应用实例、窗口、设备会话或其他目标的边界 | 未实现，接口留空 |

公共抽象不要求目标具备 URL、DOM、浏览器 profile、popup 或 `about:blank`，也不要求每个环境采用相同数量的目标、进程或资源限额。新增环境应声明自己的实际支持动作与目标语义。

### 管理接口与职责

[公共接口模块](../core/target-tabs.js) 提供 `createTargetTabs({ environment, handlers })`：

```text
TargetAdapter {
  ...
  tabs?: TargetTabs
}

TargetTabs {
  contractVersion: 1
  environment: string
  actions: string[]                  // 实际接线的动作
  invoke(request, context) -> Promise<平台结果>
}

request = { action, ...该动作的参数 }
```

`tabs` 是 TargetAdapter 可选的多目标管理服务。它使用目标实现已有的生命周期资源，不另建目标注册表；`TargetSession` 仍负责一次调用的发现、绑定与释放。P0Provider 的 `targets` 家族负责 `TargetIdentity` 投影和 `Lease` 原语，不能在 provider 内重复创建或关闭实际目标。三者的完整关系见[适配器接口](adapters.md#23-p0provider五个可选的数据家族)。

| 动作 | 公共职责 | 参数 |
| --- | --- | --- |
| `list` | 列出当前作用域可见的目标 | 无附加字段 |
| `current` | 查询调用者当前选择及失效确认状态 | 无附加字段 |
| `select` | 更新调用者的工作或观察目标 | `tabId`、可选 `mode: work / observe` |
| `open` | 按目标环境语义创建并选择目标 | 当前基础请求不带附加字段；资源内容由实现决定 |
| `close` | 关闭指定目标或当前目标 | 可选 `tabId` |
| `wait` | 有界等待目标出现 | 可选 `tabId / kind / source / timeoutMs / pollMs` |
| `acquire` | 等待安全边界后接管控制权 | `tabId / expectedControlRevision`，可选 `timeoutMs` |
| `release` | 将控制权归还所有者 | `tabId / expectedControlRevision` |
| `transfer` | 转交所有权与控制权 | `tabId / toSessionId / expectedControlRevision / expectedOwnershipRevision` |

公共层验证请求形状、动作所属字段与通用参数类型；未知或非所属字段报 `INVALID_ARGUMENT`，合法但未提供 handler 的动作报 `CAPABILITY_UNSUPPORTED`。`kind/source` 的具体取值与结果字段由目标环境定义，不能把 Web 的 `primary/tab`、`gui-popup` 枚举作为其他环境的要求。调用上下文传递作用域、调用者、取消信号和平台执行句柄；权限判定、资源配额、取消清理和平台错误由实现负责。

接口返回各实现的结果，不把 Web 的 `title/url/runtimeId` 伪装成中立字段。目标身份与租约的公共模型分别由 [P0 模型](../core/p0.js) 的 `createTargetIdentity()`、`createLease()` 定义。`actions` 只说明哪些管理方法已接线，现场连接、目标身份和可用性还需独立探测。

### 公共标签栏

[面板实现](../client.js) 的 `shellTabsBar(model, visible)` 消费中立展示模型和回调：

```text
model = {
  label, items: [{ id, label, title, closeLabel, closeTitle, closeKind }],
  activeId, canCreate, creating, createLabel, createTitle,
  onSelect(id), onClose(id), onCreate()
}
```

组件只负责标签展示、当前项指示与操作意图，不解析 URL、连接浏览器或调用 Web 路由。组件内部 `ENV_TABS` 按当前环境解析 provider；只有 Web 注册了 `webTabsProvider`。未注册环境返回 `null`，标签栏不出现，也不会复用 Web 的目标和创建操作。空白视图的标签入口禁用，Blender 使用独立的[工作区标签](three-d/debug-panel.md#工作区布局)切换同一实例中的编辑器布局。该注册表是组件内部接点，尚不是第三方动态注册 SDK。

GUI 当前目标与 Agent 的工作／观察选择分别管理。切换 GUI 标签不能隐式改变 Agent 的目标；不同标签的引用与证据仍需核对目标身份和代次。完整视图接点见[调试面板](debug-panel.md)。

## 2. 目标环境实现

- [Web 多标签页](web/multi-tab.md#2-具体实现web)

## 3. 其他目标环境的扩展位置

其他真实目标环境暂不注册 `TargetAdapter.tabs` 或 `ENV_TABS` provider。公共空白画布只提供视图回退，不能创建 Blender、桌面窗口或设备目标，也不能以 Web 的页数、profile 与 popup 策略推导其他环境行为。

新增实现时，先在目标环境目录提供自己的 TargetAdapter 和 `createTargetTabs()` handlers，再在组合根接入该服务与环境工具；前端提供独立的标签展示模型与目标绑定回调。比如 Blender 可在 `open` 中启动一个实例、加载其资产，在 `list` 中返回该实例身份，在 `select` 中切换控制端绑定，在 `close` 中按应用自身的保存与生命周期规则释放实例。资产参数与保存规则需要实现时明确，当前没有这些动作的实际接线。

## 4. 验证接口与实现

| 检查 | 命令 | 能证明的范围 |
| --- | --- | --- |
| 公共多目标接口 | `node --test tests/contracts/target-tabs.test.mjs` | 请求校验、可选动作、缺失动作拒绝及非 Web 的 `kind/source`，不证明真实 Blender 可用 |
| 公共标签栏 | `node --test tests/contracts/panel-tabs.test.mjs` | 展示模型、环境 provider 分派及未实现环境不借用 Web 操作 |
| 跨环境契约 | `node --test tests/contracts/*.test.mjs` | 现有配置、P0、适配器、权限与面板回归 |

接口测试验证请求、接线和标签栏行为。目标创建、输入、画面和资源清理由各环境自己的真实验收覆盖。
