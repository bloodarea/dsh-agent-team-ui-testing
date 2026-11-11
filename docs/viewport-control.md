# 视口、画布与标注

本页描述三件共享同一份状态的能力：**共享视口**（尺寸、滚动、显示比例）、**混合画布**（带符号的原点与空白区域）和**客户端标注**（人画、Agent 读）。

## 共享视口

每个 DSH 工作区的 Runtime 持有唯一权威对象：

```text
view = { version, mode, x, y, canvasX, canvasY, width, height, scale, source, revision }
```

| 字段 | 含义 | 范围 |
| --- | --- | --- |
| `x` / `y` | 页面顶层滚动位置（文档 CSS px） | set 只接受非负，超出内容范围会被 clamp；RTL 页面的观测值可为负 |
| `canvasX` / `canvasY` | 视口左上角在文档画布上的位置 | ±10,000,000，可为负 |
| `width` / `height` | 页面 CSS 视口尺寸 | 整数 200–4096 |
| `scale` | 显示比例，也是省略 scale 时的截图默认密度 | 0.1–2（10%–200%） |
| `source` | 最近一次写入来源：`default`/`gui`/`agent`/`page` | — |
| `revision` | 内容变化时递增，用于乐观并发 | 整数 |

要点：

- 宽高变化才发 `Emulation.setDeviceMetricsOverride`；只改 `scale` 或只改 `x/y` **不改变**页面 CSS 视口、DPR 与页面缩放。
- `deviceScaleFactor` 固定为 1、`mobile=false`，不用页面 zoom 或 CDP 的 scale/positionX/Y 实现放大。
- `browser_viewport action:"get"` 是**只读缓存诊断**：不启动浏览器、不发 CDP、不进队列、不占租约，可读取他人租约下的缓存；`viewMeta.stale=true` 表示缓存不新鲜（不保证页面此刻没动）。
- `action:"set"` 是**页面操作**：预检在队列外，随后懒启动 + 串行队列 + single-owner lease；成功后回读 `settled`、`clamped`、`overrideApplied`。
- `expectedRevision` 与当前 revision 不一致时返回 `VIEWPORT_CONFLICT`（HTTP 409），patch **零应用**并返回最新 view；不要自动重放旧 patch。
- 页面自主滚动会被观测到，以 `source:"page"` 回显并递增 revision，因此缓存 revision 可能随时失效。

## 混合画布

- `canvasX/canvasY` 是视口左上角在文档画布中的坐标，可为负或超出内容边界。
- 当 `canvasX ≠ x` 时存在偏移 `O = C − S`；偏移区域在面板中显示为深色棋盘格，在截图与 T3 中是**纯白 `#ffffff`**。
- `O = 0` 时截图与 T3 同旧行为字节/像素一致；`O ≠ 0` 时先截真实页面帧再白底合成，并披露 `capture.canvas.composite=true`（可能重编码）。
- 面板支持拖拽平移与以屏幕光标为锚点的滚轮缩放；拖拽写画布坐标，页面本身不接收这些输入。
- `canvasX/canvasY` 与 `x/y` 不能出现在同一个 patch（`INVALID_ARGUMENT`）。
- 空白区域不存在于 DOM 中；`O ≠ 0` 时坐标输入 fail-closed（宁可短暂「点不动」也不误派发）。

## 标注

- 工具：圆形、矩形、线段、箭头、画笔、文字、橡皮擦；另有填充/外框、颜色、粗细与清除画布。
- 锚定在**画布坐标**中，可画在空白区域；标注模式下页面不接收任何指针或键盘输入。
- 标注不进入页面 DOM、不进入截图与 T3 分析，是一份独立文档。
- Agent 读取：`browser_state.annotations`（或认证 `/state` 的 `ui.annotations`），返回图形列表与 `revision`。
- 按工作区隔离；导航换文档时清空；跨分页与会话保留。
- 写面唯一：面板通过认证的 `POST /plugins/ui-testing/annotations` 提交，带 `clientRevision` 幂等与 `409 annotation-context-stale`；Host 侧有软限额（图形数、单笔点数、总点数、文字长度、文档字节数）并做确定性裁剪。

## 截图比例

- `browser_screenshot` 省略 `scale` 时在调用内解析为当前 `view.scale`（冷启动为 1），证据中标注 `capture.request.scaleSource:"view"` 与 `viewRevision`。
- 显式 `scale` 范围 0.1–4，只影响本次调用，不改 view、DPR、滚动或视口。
- `region` 使用画布 CSS 像素；`O = 0` 时与文档坐标相同。
- 两轴期望像素小于 1 时提前返回 `INVALID_ARGUMENT(empty-output-dimensions)`。

## 面板交互

- 尺寸预设（宽屏 / 横屏 / 平板 / 手机）是分页选择器，选中项显示绿色小球；点击预设把 X/Y 归零并保持当前显示模式。
- `拖拽 | 适应窗口 | 默认` 三选一互斥；「适应窗口」只是本地显示偏好，不发布比例。
- 数值框支持滚轮：X/Y/W/H 步长 10（Shift 100、Alt 1），比例步长 5（Shift 10、Alt 1）。
- 显示比例超过 100% 是位图放大，不增加像素密度；需要更高分辨率时显式给截图 `scale`。
- 预览内的普通滚轮由面板统一消费：只有落在页面内容上的点会滚目标页；空白、letterbox、舞台 margin 或输入屏障未就绪时零派发，也不会滚动面板/舞台/宿主。Ctrl/Meta、拖拽模式的画布缩放和标注模式保持原语义。
- 输入屏障持续失配 ≥650ms 时显示「画面同步中，暂时无法操作」与「重试同步」；点击空白区域只显示「此处是画布空白，请在页面区域操作」，不派发页面输入。
- 「选元素」模式与标注、尺寸调整三者**双向互斥**：任一开启时另外两个入口 disabled；选元素模式内页面零输入，但普通滚轮仍滚动目标页，滚动稳定后按最后指针位置重取悬浮命中。详见 [选元素加入聊天框](element-picker.md)。
- 页面滚动时整帧按保留偏移 `O = C − S`（`T = −O × 显示比例`）定位，不随帧采集滚动 `F` 与状态 `C` 的异步到达产生伪平移；`O = 0` 时保持旧像素不动，`O ≠ 0` 时保留合法的空白带。
- 「更多 → 打开调试工具」打开的是 Chrome 自带 DevTools 的独立窗口，直接连接当前页面的 CDP；它不是插件工具，不受面板标注模式、串行队列或 single-owner lease 约束。device toolbar、DPR/网络模拟、断点、Console 求值等会改变页面，自动化取证前应恢复设置并重新采集。

页面内容右键优先交给页面；未取消默认行为时，面板显示后退、前进、重新加载与复制相关项。页面菜单、键盘操作、iframe、失效与截图边界详见[页面右键菜单](panel-context-menu.md)。

## 内部标签页

- 面板在**地址栏下方**提供内部标签栏；一个标签对应一个浏览器页面，由「标注」左侧开关控制显隐，单标签时也占一行（默认显示）。它不是新的 DSH 侧边栏分页。
- 页面里由**真人操作**触发的 `target=_blank` / `window.open` 会在同一面板新增标签并自动选中；原标签保留，各有独立 URL、历史、输入、标注、尺寸与 DevTools。切回原标签仍是原页面，子页自己的后退不会影响原页。
- 标签栏可与标注栏、尺寸栏等横向栏上下叠加；「标注」按钮左侧的标签页开关控制显示/隐藏，单标签下同样生效，隐藏只收起栏，页面与标签状态保留。
- 关闭标签会回收该页面的 Runtime；关闭当前标签后回到原页面或剩下的标签。每个工作区 primary + 最多 3 个 child（共 4 个），并计入全局 8 页上限；标签栏最右 `+` 新建空白标签，工具栏不常驻 `+`（标签栏隐藏时先打开标签栏再新建）。
- 自动弹窗、没有真人输入、目标地址被导航策略拒绝或超容量时仍会阻断，并在面板给出提示；不会把这些 target 交给 Agent 工具。
- 所有页面共享同一个浏览器 profile（Cookie、localStorage、cache）；这是浏览器语义，不是登录态隔离。Agent 的 `browser_*` 工具默认操作当前会话的选择（写用 workSelection、读优先 observationSelection，均无设置时 primary），不会因为 GUI 切换标签而改目标；`browser_tabs` 提供 list/current/select/open/close/wait/acquire/release/transfer，跨 root 的目标一律 not-found 语义。

## 限制

- 实时预览是 1× screencast；宽高变更后的输入屏障只是 best-effort（≤250 ms），画布偏移使用 fail-closed 屏障。
- 画布是视图层合成，不是页面级无限画布；`fixed`/`sticky` 元素会随整帧平移。
- 截图与 T3 不包含标注层；标注只通过 `browser_state.annotations` 读取。
