# 调试面板公共视图接口

调试视图由公共外壳、可复用组件和环境正文组成。公共外壳处理环境选择、多目标标签栏、尺寸、标注与状态。前端接点是 [client.js](../client.js) 中的组件内部接口。

从 **更多 → 调试视图** 或右侧边栏进入。右侧会话入口可绑定当前会话。

## 1. 视图层的职责与边界

面板负责展示与收集操作意图，Host 负责目标状态、配置、权限与实际执行。前端选择了某个视图、存在一个渲染函数、Host 支持该目标，以及目标现场可用，需要分别判断。

| 部分 | 负责什么 | 当前边界 |
| --- | --- | --- |
| 公共外壳 | 会话入口、视图标题、环境选择、共享状态、公共组件组合 | `DebugViewBody` 仍集中持有状态、事件处理器与副作用 |
| 公共视图组件 | 标注栏、尺寸栏、标注图层、状态栏和无视图回退 | 渲染已复用；部分处理器仍依赖现有 Web Host 状态与路由 |
| 环境视图 | 环境自己的正文、目标画面与输入方式 | Web 调试正文和 Blender 纯视口 |
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

主面板的身份可能解析为 `recent`，没有可写入的聊天会话。右侧入口可绑定当前会话；选元素或加入截图前仍要检查聊天框服务是否可用，见[选元素前置条件（element-picker.md）](web/element-picker.md#前置)。

### 2.2 公共渲染接点

以下接点返回 React 节点、节点数组或条件空值，是渲染辅助函数，不是拥有独立 props 与生命周期的 React 组件。`shellTabsBar(model, visible)` 显式接收展示模型与显隐状态；其余函数直接读取 `DebugViewBody` 的闭包状态。

| 接点 | 返回与职责 | 当前调用方 |
| --- | --- | --- |
| `shellTabsBar(model, visible)` | 根据中立展示模型渲染标签、选中项、创建与关闭操作；不解析 URL 或调用 Web 路由 | 根外壳统一调用，模型来自当前环境的 `ENV_TABS` provider |
| `shellAnnotBar()` | 标注模式下返回绘制、选择／框选、样式、截图、删除与清除控件 | Web、Blender 与无视图分支 |
| `shellSizeBar()` | 按当前环境显示分辨率、显示缩放及可用的坐标和适应选项 | Web、Blender 与无视图分支 |
| `shellAnnotLayer()` | 返回共享 SVG 标注图层，绘制图形、选择状态与手势草稿 | Web、Blender 与公共空白画布 |
| `shellStatusBar()` | 显示当前环境的视图状态和测得的数据，以及标注相关状态 | 外壳根部统一调用 |
| `shellBarPublic(hint)` | 返回公共提示、标注和尺寸入口；标签无 provider 时禁用 | Blender 与 `shellNoViewRows()` |
| `shellBlankStage()` | 返回按当前尺寸与显示比例铺设的空白画布 | `shellNoViewRows()` |
| `shellNoViewRows()` | 返回公共工具栏、标注栏、尺寸栏与空白画布的行集合 | 环境无视图实现时的根分支 |

控件出现只说明渲染入口存在。坐标、拖拽、截图和标注同步仍须满足各自的状态门禁；不能由“公共栏可见”推导所有环境已经具有对应后端能力。

### 2.3 环境正文注册接口

`ENV_VIEWS` 以环境 id 为键，值为环境的正文渲染函数。

以当前本地视图 id `env` 查表，值为零参数渲染函数，返回该环境的 React 行节点数组。没有对应函数时调用 `shellNoViewRows()`。根部先渲染行集合首项（工具栏），再渲染公共标签栏与后续正文，末尾追加一次公共状态栏。

`ENV_VIEWS` 是组件执行时创建的局部对象，不是 Host 的适配器注册表，也没有对外导出的 `registerView()` 方法。目标视图当前仍通过同一闭包读取状态和调用操作处理器。

标签栏单独通过 `ENV_TABS` 获取展示模型。无 provider 或能力不可用时返回 `null`，公共标签入口禁用。字段与 Host 管理接口见[多目标管理接口](multi-tab.md#1-公共抽象)。

### 2.4 标注坐标映射接口

共享标注图层通过 `ENV_ANNOT_MAP` 取得当前环境的坐标转换。

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

公共 `annotBlankMap()` 以空白视图窗作为绘制区，原点为 `(0, 0)`，逻辑尺寸取当前宽高；空白视图经过适应或缩放后，比例不一定是 1:1。

坐标、绘制与选择规则见[显示空间、画布与标注接口](viewport-control.md)。映射只解决显示与输入坐标，不负责采集真实目标或创建环境独立的标注文档。

### 2.5 配置、状态与操作接线

环境下拉框只列出已启用的环境。切换到 Web 时，`changeEnv(next)` 提交带配置 revision 的 Host 执行环境选择，成功后更新显示。切换到 Blender 纯视口或其他环境的空白画布时，只更新面板选中的视图。配置规则见[环境设置](settings.md#启用与选择)。

公共组件复用 Host 状态与操作处理器。现有传输与路由接线见 [Web 调试面板](web/debug-panel.md#面板状态与操作接线)。

共享标注文档仍依据 Host 返回的作用域、运行时和页面身份管理；切换前端 `env` 不会自动创建另一套环境命名空间。图形可见、已同步、截图成功与真实目标验证通过是不同结论。

## 3. 视图选择与默认视图

侧边栏右上角的组合框选择的是**本会话的视图**，由 Host 持久化。选择本身就是"这个会话对着什么调试"的答案：执行环境跟着它走，所以选 3D 的会话里 Web 工具面为空（3D 没有 Agent 执行适配器），选默认视图的会话没有任何目标环境。

### 3.1 解析顺序

一个面板显示什么，按下面这条链解析，命中即停（Host `resolveSnapshot`）：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `sessions.<id>.view` | 本会话的选择 |
| 2 | `sessions.<id>.environment` | 旧字段，读兼容 |
| 3 | 父会话的有效选择 | 跟随 `parentSession`，深度 ≤ 8，防环 |
| 4 | `workspaces.<key>.view` | 所属工作区最后一次选择 |
| 5 | `workspaces.<key>.environment` | 旧字段，读兼容 |
| 6 | `global.view` | 宿主默认视图（可选，缺省即空态） |
| 7 | 默认视图 | 空态 |

- **没有"回退到 Web"这一步。** 没存过选择就是空态，不会因为 Web 碰巧启用就把它当成默认。
- 选择不可用（环境在设置页被关掉，或该环境仍是 `planned`）时同样落到默认视图，并把用户选过的值保留在 `snapshot.view` 与 `source.rejectedEnvironment` 里；重新打开开关后选择自己回来，不需要再点一次。
- `global.view` 是给"整机默认视图"用的：写 `{"view":"web"}` 就让没存过选择的会话都落在 Web。

### 3.2 按会话持久化、按工作区隔离

- 选一次 = 一次 `POST /plugins/ui-testing/config/select`，body 是 `{scope:"session", view:"<env id 或 default>"}`，Host 在一次 revision 里同时写 `sessions.<id>.view` 与 `workspaces.<key>.view`。
- 因此 **A 工作区看 3D、B 工作区看 Web**：每个会话记住自己的选择，切换工作区里的会话不会把面板强行切到另一个目标环境。
- 同工作区的新会话继承该工作区最后一次选择；没有继承来源的新会话落在默认视图。
- 组合框永远列「默认视图」+ 已启用的目标环境。默认视图没有开关，不可在设置页停用。

### 3.3 默认视图

默认视图是一个**空态视图**，不是目标环境：它在 Host catalog 里（`kind: "view"`、`status: "empty"`）、在组合框里，但不可启用、没有适配器、不出现在设置页分组，也不进 `enabledEnvironments`。它展示公共视图组件（工具栏、尺寸栏、状态栏、标注入口）与空白画布，供"还没有选环境"或"所有环境都关掉"时使用。

## 4. 具体目标环境实现

- [Web 调试面板](web/debug-panel.md)
- [Blender 纯视口](three-d/debug-panel.md)

### 4.2 其他目标环境与公共空白画布

环境 id **不在面板里定义**：面板从 Host `GET /config` 响应的 `catalog` 字段取 id、显示名与实现状态（Host 侧由 `core/config.js` 的 `environmentCatalog()` 生成），因此下拉框、设置页分组和下文表格是同一份词表。环境状态分四类：`supported`（有执行适配器，可启用可选中）、`view`（只有视图，可启用可选中，无执行适配器——3D 的 Blender 属于这一类）、`planned`（可启用、**不可选中**，Host 以 `environment … is planned and cannot be selected in v1` 拒绝）、`empty`（默认视图，不可启用、可选中）。

| 目标环境 | 环境 id | 当前正文与映射 |
| --- | --- | --- |
| Linux 桌面 | `linux-desktop` | 未注册专有视图与映射，使用公共空白画布 |
| Windows | `windows` | 同上 |
| macOS | `macos` | 同上 |
| Android | `android` | 同上 |
| TUI | `tui` | 同上 |
| HarmonyOS | `harmonyos` | 同上 |
| 小程序 | `mini-program` | 同上 |
| 游戏 | `game` | 同上 |

这些环境启用后出现在下拉框；选中时根分支调用 `shellNoViewRows()`，显示公共工具栏、尺寸与标注入口以及空白视图窗，不显示 Web 地址栏和标签栏。视图能力同样按表判断：`ENV_VIEWS` 决定有没有正文，`ENV_TABS` 决定有没有标签栏，`ENV_FEATURES` 决定外壳级控件（运行模式、DevTools）——外壳里没有按环境 id 写的条件分支。

默认逻辑尺寸由 `envDefaultSize()` 提供：Android、HarmonyOS、小程序为 393×852，游戏、3D 为 1920×1080，Web 与桌面／TUI 为 1024×768，并默认适应窗口。空白画布沿用公共缩放与标注渲染，不是该平台的实时画面。

这条回退路径的接线边界：

- 任何选择都会提交 `config/select`：视图要持久化，执行环境跟着视图走。空白画布只改本地布局与默认尺寸，不发布视口。它仍不是独立沙盒——公共状态栏、标注文档和截图入口仍指向当前 Host。
- 帧传输与状态轮询由视图通道按「这个环境有没有视图」挂载：切入空白画布会关闭旧帧流、停掉状态轮询、撤销在途请求与对象 URL（迟到的视口回包按面板实例代次丢弃）。运行中的 Web 目标不会被拆除，只是不再被这个面板观察。
- 标注入口对空白视图采用公共放行条件，但运行态丢失、画布能力、文档水合和同步门禁仍可能使图层不可见或退出模式。不能据按钮可点击就承诺脱离 Host 的完整绘制、保存与导出能力。
- 「截图（含标注）」在空白视图中仍请求 Host 截图，没有独立的空白画布导出实现。空白视图中可见的图形不保证出现在返回图片中，也不能据此声称采集到了所选平台的画面。

实际可执行环境、依赖和能力需要检查 Host 配置与就绪结果，见[环境设置（settings.md）](settings.md)和[能力分层（capability-tiers.md）](capability-tiers.md#3-目标环境实现)。

## 5. 接入与验证

阅读或接入环境视图时，应分别核对：

1. 正文接点：当前环境在 `ENV_VIEWS` 中的函数是否返回正确行集合，是否复用了公共组件，未接入时是否走公共回退。
2. 几何接点：`ENV_ANNOT_MAP` 是否提供来源可信的映射，空映射、缩放和手势期间几何变化是否得到处理。
3. Host 接线：配置选择、状态、采集、输入、尺寸、标注文档与截图是否真正指向该目标，而不是仍复用 Web 语义。
4. 生命周期：可见性、会话／目标切换、过时响应、帧流关闭与输入释放是否由明确的所有者管理。
5. 真实结果：用实际目标验证控件状态、显示画面与操作反馈，不能用函数存在、空白画布或源码断言证明真实平台已接入。

当前解耦主要落在正文分派、公共渲染和标注映射接点；状态和副作用仍集中在同一组件中。测试入口与报告要求见[验证与贡献（verification.md）](verification.md)。
