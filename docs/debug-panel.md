# 调试面板：公共视图接口与目标环境实现

调试视图由公共外壳、可复用的视图组件和目标环境专有内容组成。公共部分提供环境选择、多目标标签栏、尺寸、标注和状态展示；目标环境决定实际画面、交互方式与专有工具。当前已接入 Web 视图，其余目标环境使用公共空白画布。

从 **更多 → 调试视图** 或右侧边栏的插件卡片进入。需要把元素或标注截图加入聊天框时，优先从当前会话右侧打开，让面板绑定该会话并保持聊天框可见。按截图练习见[图文教程（tutorial.md）](tutorial.md)，直接查 Web 操作见[Web 实现](#31-web)。

本文先说明公共接口与接线，再按目标环境说明具体行为。这里的公共接口是当前各环境复用的**组件内部接点**，不是独立导出的视图 SDK；实现集中在 [client.js](../client.js)，还没有动态注册第三方视图的公开方法。

## 1. 视图层的职责与边界

面板负责展示与收集操作意图，Host 负责目标状态、配置、权限与实际执行。前端选择了某个视图、存在一个渲染函数、Host 支持该目标，以及目标现场可用，需要分别判断。

| 部分 | 负责什么 | 当前边界 |
| --- | --- | --- |
| 公共外壳 | 会话入口、视图标题、环境选择、共享状态、公共组件组合 | `DebugViewBody` 仍集中持有状态、事件处理器与副作用 |
| 公共视图组件 | 标注栏、尺寸栏、标注图层、状态栏和无视图回退 | 渲染已复用；部分处理器仍依赖现有 Web Host 状态与路由 |
| 环境视图 | 环境自己的工具栏、目标画面与输入方式 | 当前仅 `webViewBody()` 有具体目标实现 |
| 环境坐标映射 | 将共享标注画布映射到该环境的显示区域 | 当前 Web 有专用映射，其他环境回退到空白画布映射 |
| Host 适配器 | 目标生命周期、能力准入、采集与实际操作 | 使用 `TargetAdapter`、`CapabilityAdapter`、`P0Provider`；与前端视图注册表是不同接口 |

后端三类适配器见[适配器接口与接入（adapters.md）](adapters.md)。不能仅通过增加一个前端视图函数，就认为新的真实目标环境已经接入。

## 2. 公共视图接口

### 2.1 面板入口与组合

DSH 装载出口注册的是面板：`apply(ctx)` 注册主区、右侧面板等入口，并通过 `sidebarRightTabs.register` 注册 `kind: 'debug-view'` 的页签类型。

`DebugView(props)` 按会话和入口选择 `SidebarDebugView`、`SessionDebugViewStatic` 或 `MainDebugView`，最终渲染同一个 `DebugViewBody`。入口包装负责提供会话与可见性等上下文，正文组件共享渲染和处理逻辑：

```text
DebugView(props)
  → 对应入口包装
    → DebugViewBody
      ├─ 公共顶栏与环境选择
      ├─ 环境工具栏（环境行集合的首行）
      ├─ shellTabsBar(envTabs, tabsVisible)
      ├─ 环境行集合的后续正文（ENV_VIEWS[env]() 或 shellNoViewRows()）
      └─ shellStatusBar()
```

主面板的身份可能解析为 `recent`，没有可写入的聊天会话。右侧入口可绑定当前会话；选元素或加入截图前仍要检查聊天框服务是否可用，见[选元素前置条件（element-picker.md）](element-picker.md#前置)。

### 2.2 公共渲染接点

以下接点返回 React 节点、节点数组或条件空值，是渲染辅助函数，不是拥有独立 props 与生命周期的 React 组件。`shellTabsBar(model, visible)` 显式接收展示模型与显隐状态；其余函数直接读取 `DebugViewBody` 的闭包状态。

| 接点 | 返回与职责 | 当前调用方 |
| --- | --- | --- |
| `shellTabsBar(model, visible)` | 根据中立展示模型渲染标签、选中项、创建与关闭操作；不解析 URL 或调用 Web 路由 | 根外壳统一调用，模型来自当前环境的 `ENV_TABS` provider |
| `shellAnnotBar()` | 标注模式下返回工具栏：绘制、选择／框选、样式、截图、删除与清除 | Web 与无视图分支 |
| `shellSizeBar()` | 尺寸模式下返回预设、宽高、坐标、缩放和拖拽／适应／默认控制 | Web 与无视图分支 |
| `shellAnnotLayer()` | 返回共享 SVG 标注图层，绘制图形、选择状态与手势草稿 | Web 预览区与公共空白画布 |
| `shellStatusBar()` | 返回控制权、显示帧率／延迟、已选标注数、同步状态和活动摘要 | 外壳根部统一调用 |
| `shellBarPublic()` | 返回无视图分支的标签入口、标注、尺寸与更多工具栏；标签无 provider 时禁用 | `shellNoViewRows()` |
| `shellBlankStage()` | 返回按当前尺寸与显示比例铺设的空白画布 | `shellNoViewRows()` |
| `shellNoViewRows()` | 返回公共工具栏、标注栏、尺寸栏与空白画布的行集合 | 环境无视图实现时的根分支 |

控件出现只说明渲染入口存在。坐标、拖拽、截图和标注同步仍须满足各自的状态门禁；不能由“公共栏可见”推导所有环境已经具有对应后端能力。

### 2.3 环境正文注册接口

当前正文注册表的实际形状是：

```js
const ENV_VIEWS = { web: webViewBody };
```

以当前本地视图 id `env` 查表，值为零参数渲染函数，返回该环境的 React 行节点数组。没有对应函数时调用 `shellNoViewRows()`。根部先渲染行集合首项（工具栏），再渲染公共标签栏与后续正文，末尾追加一次公共状态栏。`webViewBody()` 内部复用公共标注栏、尺寸栏和标注图层。

`ENV_VIEWS` 是组件执行时创建的局部对象，不是 Host 的适配器注册表，也没有对外导出的 `registerView()` 方法。目标视图当前仍通过同一闭包读取状态和调用操作处理器。

标签栏单独通过 `ENV_TABS = { web: webTabsProvider }` 取模型。`webTabsProvider()` 负责把 Web 运行时列表转成中立的 `items/activeId`、展示文案与 `onSelect/onClose/onCreate` 回调；`shellTabsBar(model, visible)` 消费这些值。无 provider 或无实际能力时返回 `null`，公共标签入口禁用，不显示 Web 页也不调用 Web `/tabs`。完整展示字段与 Host 管理接口见[多标签页公共接口](multi-tab.md#1-公共抽象)。

### 2.4 标注坐标映射接口

共享标注图层通过独立的映射接点取得当前环境的坐标转换：

```js
const ENV_ANNOT_MAP = {
  web: () => (canvasOn && shot ? annotMap() : null),
};
```

`resolveAnnotMap()` 调用当前环境的 provider；环境没有注册 provider 时，回退到 `annotBlankMap()`。`annotMapForEnv()` 是该解析过程的包装。已有 provider 返回 `null` 时直接保留不可映射状态，不继续套用其他环境的几何信息。

provider 返回映射对象或 `null`：

| 字段 | 含义 |
| --- | --- |
| `painted` | 实际可绘制区域，使用浏览器视口中的 CSS 坐标 |
| `boxRect` | 视图容器的边界矩形 |
| `cx`、`cy` | 当前逻辑画布窗口的原点 |
| `w`、`h` | 逻辑画布窗口的宽高 |
| `sx`、`sy` | 逻辑画布单位到屏幕 CSS 像素的比例 |

指针位置按 `cx + (clientX - painted.left) / sx`、`cy + (clientY - painted.top) / sy` 转回画布坐标，并限制在当前窗口内。映射在手势开始时冻结，避免显示尺寸变化使同一笔使用不同坐标系。

Web 的 `annotMap()` 从实际帧显示区域、已接受的视口尺寸与画布原点推导映射。公共 `annotBlankMap()` 以空白视图窗作为绘制区，原点为 `(0, 0)`，逻辑尺寸取当前宽高；空白视图经过适应或缩放后，比例不一定是 1:1。

坐标、绘制与选择规则见[视口、画布与标注（viewport-control.md）](viewport-control.md)。映射只解决显示与输入坐标，不负责采集真实目标或创建环境独立的标注文档。

### 2.5 配置、状态与操作接线

环境下拉框只列出已启用的环境。对已有视图的环境，`changeEnv(next)` 提交带配置 revision 的 Host 选择，成功后才更新；对没有视图的环境，仅更新本地视图 id，不提交执行环境选择。完整配置规则见[环境设置（settings.md）](settings.md#启用与选择)。

当前公共组件使用的几个 Host 接点如下；它们仍由面板现有处理器连接，不构成已经跨所有环境实现的统一传输协议：

| 接点 | 当前用途与限制 |
| --- | --- |
| `POST /plugins/ui-testing/config/select` | 为已有视图提交当前作用域的执行环境选择；冲突或失败保留原选择 |
| `GET /plugins/ui-testing/state` | 接收当前 Host 状态，更新目标身份、共享视口、画布与标注上下文 |
| `POST /plugins/ui-testing/viewport` | 公共尺寸处理器提交视口修改，仍使用当前 Host 的版本和几何语义 |
| `POST /plugins/ui-testing/annotations` | 将已提交图形同步到 Host 返回的标注文档上下文 |
| `POST /plugins/ui-testing/screenshot` | 标注栏以 `includeAnnotations: true` 请求截图，再加入绑定会话的聊天框附件 |

共享标注文档仍依据 Host 返回的作用域、运行时和页面身份管理；切换前端 `env` 不会自动创建另一套环境命名空间。图形可见、已同步、截图成功与真实目标验证通过是不同结论。

## 3. 具体目标环境实现

### 3.1 Web

Web 在 `ENV_VIEWS` 中注册 `webViewBody()`，在 `ENV_ANNOT_MAP` 中注册 Web 画布映射，在 `ENV_TABS` 中注册 `webTabsProvider`。正文返回导航工具栏、Web 提示、公共标注栏、公共尺寸栏和页面预览区；公共标签栏由根部插入工具栏之后。预览内部叠加公共标注图层，以及 Web 专有的下拉浮层、右键菜单与选元素提示。

#### 地址栏与最近访问

输入 HTTP(S) 地址后按 Enter，或点右侧「转到」。两者共用 `submit()` 的地址校验；标注模式或导航进行中禁用「转到」。返回、前进与刷新分别使用 Host 的历史、刷新接点；它们属于 Web 导航语义。

时钟按钮打开最近访问列表：

- 最近的地址在上，最多 7 条；重复访问只置顶，点条目直接跳转。
- 空地址、`about:blank` 和应用自身地址不记录。
- 点外部或按 Esc 收起；切换工作区作用域或进入标注模式也会收起。
- 历史按工作区保存在浏览器 `localStorage`：`dsh-agent-team-ui-testing:address-history:v2:<工作区作用域 id>`。同工作区的多个面板共享，作用域未解析时不读写；旧版 `v1` 历史不迁移。

#### 页面输入与预览

Web 通过 CDP screencast 提供页面帧。`createFrameTransport(handlers, scope)` 已与 React 渲染分开：接收帧、状态等回调及作用域，返回启动、关闭、状态通知、seed 更新／重试与统计方法；当前实现仍使用 Web 帧格式、同源 WebSocket 和 Host HTTP 路由，不是通用的环境帧源 API。

预览优先从 `/plugins/ui-testing/frames` WebSocket 收帧，HTTP `/frame` 轮询兜底，必要时用 Host 截图作 PNG seed。帧回调更新 `shot` 与几何元数据，Web `<img>` 使用这些数据渲染。状态另行通过 `/state` 轮询接收；`ingestHostState()`、`acceptRemote()` 处理作用域与状态版本，拒绝过时快照。

点击预览使其获得焦点后，鼠标、滚轮与键盘事件经 `sendEvents()` 串行发送到 Host 输入接口。键盘支持修饰键组合、F1–F12、Home/End、PageUp/PageDown、Delete/Insert；按下与松开分别转发，离开焦点时释放仍按住的键。

标注、选元素和尺寸调整有各自的输入规则。普通点击没有到达页面时，先检查当前模式、控制权与画面同步状态。坐标、缩放、拖拽、输入屏障与光标跟随见[视口、画布与标注（viewport-control.md）](viewport-control.md#面板交互)。

浏览器原生的 alert/confirm、文件选择器不在页面画面中。单选 `<select>` 使用面板浮层；多选、列表框和不支持的情况会提示改用键盘，详见[选元素与原生下拉（element-picker.md）](element-picker.md)。页面右键菜单的优先级和默认操作见[页面右键菜单（panel-context-menu.md）](panel-context-menu.md)。

#### 标签页、标注与尺寸

| 操作 | 环境专有与公共部分 | 详细入口 |
| --- | --- | --- |
| 切换或新建页面 | Web 标签栏位于地址栏下方，工具栏开关控制显隐，`+` 在标签栏内；GUI 与 Agent 选页独立 | [多标签页（multi-tab.md）](multi-tab.md) |
| 调整画面 | 复用公共尺寸栏；Web 的视口写入、页面几何与输入屏障决定操作是否可执行 | [视口控制（viewport-control.md）](viewport-control.md) |
| 指定元素 | Web 选元素层将页面节点转换为聊天框 `@` 引用 | [选元素（element-picker.md）](element-picker.md) |
| 画标注并交付图片 | 复用公共标注栏与图层；使用 Web 坐标映射、Host 文档和截图接线 | [标注（viewport-control.md）](viewport-control.md#标注)、[截图交付（capture-p0.md）](capture-p0.md) |

无头／有头开关属于 Web：当前在公共顶栏以 `env === 'web'` 且视图存在为条件显示，调用 Host `display` 操作，并处理页面与绑定重置。运行模式和 profile 说明见[浏览器运行配置（browser-runtime.md）](browser-runtime.md#无头与有头模式)。

#### 打开 Chrome DevTools

在「更多 → 打开调试工具」中，为当前页面打开 Chrome 自带 DevTools 的独立窗口。需要该工作区的浏览器运行时已经启动，且 GUI 与 DSH 同机、通过 `127.0.0.1` 或 `localhost` 访问；远程 GUI 暂不支持。

弹窗被浏览器拦截时，使用提示中的「在新标签页打开调试工具」链接。DevTools 直接连接页面 CDP；断点、Console 求值、设备和网络模拟会改变页面，自动化取证前应恢复设置并重新采集。连接与访问边界见[外部 DevTools（architecture.md）](architecture.md#外部-devtools)。

### 3.2 其他目标环境与公共空白画布

| 目标环境 | 前端视图 id | 当前正文与映射 |
| --- | --- | --- |
| Linux | `linux` | 未注册专有视图与映射，使用公共空白画布 |
| Windows | `windows` | 同上 |
| macOS | `macos` | 同上 |
| Android | `android` | 同上 |
| TUI | `tui` | 同上 |
| HarmonyOS | `harmonyos` | 同上 |
| 小程序 | `miniprogram` | 同上 |
| 游戏 | `game` | 同上 |
| 3D | `three-d` | 同上 |

这里列的是前端视图 id，不是后端适配器已支持的声明。环境启用后可出现在下拉框；选中这些环境时，实际根分支调用 `shellNoViewRows()`，显示公共工具栏、尺寸与标注入口，以及空白视图窗，不显示 Web 地址栏和标签栏。

默认逻辑尺寸由 `envDefaultSize()` 提供：Android、HarmonyOS、小程序为 393×852，游戏、3D 为 1920×1080，Web 与桌面／TUI 为 1024×768，并默认适应窗口。空白画布沿用公共缩放与标注渲染，不是该平台的实时画面。

这条回退路径仍有以下接线边界：

- 切换没有视图的环境不提交 `config/select`，Host 的执行环境保持不变；但应用默认尺寸会复用共享视口队列，仍可能向当前 Host 发布宽高，不能当作完全独立的本地沙盒。
- 帧传输和状态轮询仍由外壳按 `visible`、`ready`、作用域管理，没有按本地 `env` 分别启停；切到空白视图不代表原 Web 运行时已经停止。公共状态栏的读数仍可能来自当前 Host。
- 标注入口对空白视图采用公共放行条件，但运行态丢失、画布能力、文档水合和同步门禁仍可能使图层不可见或退出模式。不能据按钮可点击就承诺脱离 Host 的完整绘制、保存与导出能力。
- 截图按钮仍请求当前 Host 截图，没有独立的空白画布导出实现。空白视图中可见的图形不保证出现在返回图片中，也不能据此声称采集到了所选平台的画面。

实际可执行环境、依赖和能力需要检查 Host 配置与就绪结果，见[环境设置（settings.md）](settings.md)和[能力分层（capability-tiers.md）](capability-tiers.md#3-目标环境实现)。

## 4. 接入与验证

阅读或接入环境视图时，应分别核对：

1. 正文接点：当前环境在 `ENV_VIEWS` 中的函数是否返回正确行集合，是否复用了公共组件，未接入时是否走公共回退。
2. 几何接点：`ENV_ANNOT_MAP` 是否提供来源可信的映射，空映射、缩放和手势期间几何变化是否得到处理。
3. Host 接线：配置选择、状态、采集、输入、尺寸、标注文档与截图是否真正指向该目标，而不是仍复用 Web 语义。
4. 生命周期：可见性、会话／目标切换、过时响应、帧流关闭与输入释放是否由明确的所有者管理。
5. 真实结果：用实际目标验证控件状态、显示画面与操作反馈，不能用函数存在、空白画布或源码断言证明真实平台已接入。

当前解耦主要落在正文分派、公共渲染和标注映射接点；状态和副作用仍集中在同一组件中。测试入口与报告要求见[验证与贡献（verification.md）](verification.md)。
