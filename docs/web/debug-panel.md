# Web 调试面板

公共外壳、渲染与坐标映射接点见[调试面板公共视图接口](../debug-panel.md)。

## 视图接线

Web 在 `ENV_VIEWS` 中注册 `webViewBody()`，在 `ENV_ANNOT_MAP` 中注册 Web 画布映射，在 `ENV_TABS` 中注册 `webTabsProvider`。正文返回导航工具栏、Web 提示、公共标注栏、公共尺寸栏和页面预览区；公共标签栏由根部插入工具栏之后。预览内部叠加公共标注图层，以及 Web 专有的下拉浮层、右键菜单与选元素提示。

## 地址栏与最近访问

输入 HTTP(S) 地址后按 Enter，或点右侧「转到」。两者共用 `submit()` 的地址校验；标注模式或导航进行中禁用「转到」。返回、前进与刷新分别使用 Host 的历史、刷新接点；它们属于 Web 导航语义。

时钟按钮打开最近访问列表：

- 最近的地址在上，最多 7 条；重复访问只置顶，点条目直接跳转。
- 空地址、`about:blank` 和应用自身地址不记录。
- 点外部或按 Esc 收起；切换工作区作用域或进入标注模式也会收起。
- 历史按工作区保存在浏览器 `localStorage`：`dsh-agent-team-ui-testing:address-history:v2:<工作区作用域 id>`。同工作区的多个面板共享，作用域未解析时不读写；旧版 `v1` 历史不迁移。

## 页面输入与预览

Web 通过 CDP screencast 提供页面帧。`createFrameTransport(handlers, scope)` 已与 React 渲染分开：接收帧、状态等回调及作用域，返回启动、关闭、状态通知、seed 更新／重试与统计方法；当前实现仍使用 Web 帧格式、同源 WebSocket 和 Host HTTP 路由，不是通用的环境帧源 API。

预览优先从 `/plugins/ui-testing/frames` WebSocket 收帧，HTTP `/frame` 轮询兜底，必要时用 Host 截图作 PNG seed。帧回调更新 `shot` 与几何元数据，Web `<img>` 使用这些数据渲染。状态另行通过 `/state` 轮询接收；`ingestHostState()`、`acceptRemote()` 处理作用域与状态版本，拒绝过时快照。

点击预览使其获得焦点后，鼠标、滚轮与键盘事件经 `sendEvents()` 串行发送到 Host 输入接口。键盘支持修饰键组合、F1–F12、Home/End、PageUp/PageDown、Delete/Insert；按下与松开分别转发，离开焦点时释放仍按住的键。

标注、选元素和尺寸调整有各自的输入规则。普通点击没有到达页面时，先检查当前模式、控制权与画面同步状态。坐标、缩放、拖拽、输入屏障与光标跟随见[视口、画布与标注（viewport-control.md）](viewport-control.md#面板交互)。

浏览器原生的 alert/confirm、文件选择器不在页面画面中。单选 `<select>` 使用面板浮层；多选、列表框和不支持的情况会提示改用键盘，详见[选元素与原生下拉（element-picker.md）](element-picker.md)。页面右键菜单的优先级和默认操作见[页面右键菜单（panel-context-menu.md）](panel-context-menu.md)。

## 页面声音

预览默认静音。**地址栏内侧、历史记录按钮左边的「声音」按钮**（从右往左第二个，`right:26px`，历史按钮 `right:2px`）开关当前页面的音频；地址输入右侧留出 56px，文字不会压到这两个按钮下面。按钮上的斜杠表示静音，两条声波表示已开启，开启时用品牌色；`title` 会说明「正在播放」或「页面当前没有声音」。点它不会抢走地址栏焦点，也不会提交地址栏表单。

| 环节 | 行为 |
| --- | --- |
| 采集 | 页面内注入的 tap 挂钩 Web Audio（节点连到 `destination` 时同时接到静音混音器）和 `<audio>`/`<video>`（`captureStream()` 的音轨），由 `ScriptProcessorNode` 输出 |
| 传输 | Host 用 CDP binding 收包（24 kHz、单声道、s16le，约每 85 ms 一包），再作为 `{"type":"audio"}` 文本消息走同一条 `/plugins/ui-testing/frames` WebSocket；帧的二进制格式不变 |
| 播放 | 面板把每包解码成 `AudioBuffer` 依次排程；落后超过 1.2 s 时丢弃积压而不是继续延后 |
| 导航 | 主文档提交时 Host 发 `{"type":"audio","state":"reset"}`，面板清空时间线，新页面从「现在」重新开始 |
| 静音页 | 数字静音（RMS < 4e-4）不发送，空闲页面不占用带宽 |
| 统计 | `GET /plugins/ui-testing/metrics` 的 `host.audio` 给出格式与计数，从不包含 PCM 数据 |

边界：

- 面板必须在**用户点击**「声音」后才能出声——浏览器不允许脚本自行启动音频。开关状态不持久化，重载面板后回到静音。
- 「声音」按钮只在 Web 视图出现，挂在地址栏容器内：`data-utb-audio`（`on`/`off`）与 `data-utb-audio-live`（`live`/`idle`）供验收读取；`aria-pressed` 同时反映开关状态。
- 只采集**主文档**：子帧内置的播放器不进入这条链路（两路序列号会互相覆盖）。
- 只覆盖 Web Audio 图与媒体元素；`srcObject` 直连的 `MediaStream`、闭合 shadow DOM 隔离的播放路径不采集。
- 浏览器由插件启动时固定带 `--mute-audio`：页面声音**不会**从宿主音箱外放，只有面板里的「声音」开关会让它可听。无头与有头模式都一样。
- 无头环境还要靠 `--autoplay-policy=no-user-gesture-required`（插件启动参数已带），否则页面和采集 `AudioContext` 都会停在 `suspended`，页面自己也不会开始播放。
- 声音开关只影响本地面板播放，不改变页面、不写入证据，也不进入 T1–T4 断言。

## 标签页、标注与尺寸

| 操作 | 环境专有与公共部分 | 详细入口 |
| --- | --- | --- |
| 切换或新建页面 | Web 标签栏位于地址栏下方，工具栏开关控制显隐，`+` 在标签栏内；GUI 与 Agent 选页独立 | [多标签页（multi-tab.md）](multi-tab.md) |
| 调整画面 | 复用公共尺寸栏；Web 的视口写入、页面几何与输入屏障决定操作是否可执行 | [视口控制（viewport-control.md）](viewport-control.md) |
| 指定元素 | Web 选元素层将页面节点转换为聊天框 `@` 引用 | [选元素（element-picker.md）](element-picker.md) |
| 画标注并交付图片 | 复用公共标注栏与图层；使用 Web 坐标映射、Host 文档和截图接线 | [标注（viewport-control.md）](viewport-control.md#标注)、[截图交付（capture-p0.md）](capture-p0.md) |

无头／有头开关属于 Web：当前在公共顶栏以 `env === 'web'` 且视图存在为条件显示，调用 Host `display` 操作，并处理页面与绑定重置。运行模式和 profile 说明见[Web 目标环境配置](browser-runtime.md#无头与有头模式)。

## 打开 Chrome DevTools

在「更多 → 打开调试工具」中，为当前页面打开 Chrome 自带 DevTools 的独立窗口。需要该工作区的浏览器运行时已经启动，且 GUI 与 DSH 同机、通过 `127.0.0.1` 或 `localhost` 访问；远程 GUI 暂不支持。

弹窗被浏览器拦截时，使用提示中的「在新标签页打开调试工具」链接。DevTools 直接连接页面 CDP；断点、Console 求值、设备和网络模拟会改变页面，自动化取证前应恢复设置并重新采集。连接与访问边界见[外部 DevTools（architecture.md）](architecture.md#外部-devtools)。

## 面板状态与操作接线

当前公共组件使用的几个 Host 接点如下；它们仍由面板现有处理器连接，不构成已经跨所有环境实现的统一传输协议：

| 接点 | 当前用途与限制 |
| --- | --- |
| `POST /plugins/ui-testing/config/select` | 为已有视图提交当前作用域的执行环境选择；冲突或失败保留原选择 |
| `GET /plugins/ui-testing/state` | 接收当前 Host 状态，更新目标身份、共享视口、画布与标注上下文 |
| `POST /plugins/ui-testing/viewport` | 公共尺寸处理器提交视口修改，仍使用当前 Host 的版本和几何语义 |
| `POST /plugins/ui-testing/annotations` | 将已提交图形同步到 Host 返回的标注文档上下文 |
| `POST /plugins/ui-testing/screenshot` | 标注栏以 `includeAnnotations: true` 请求截图，再加入绑定会话的聊天框附件 |

Web 的 `annotMap()` 从帧实际显示区域、已接受的视口尺寸和画布原点推导标注映射。
