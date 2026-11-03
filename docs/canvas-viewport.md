# P0-D 混合画布（hybrid canvas，2026-11-02 用户要求）

> 索引：[docs/index.md](index.md) · 关系：[viewport-control.md](viewport-control.md)（滚动语义/现有 H1–H10）、[capture-p0.md](capture-p0.md)、[t3-vision.md](t3-vision.md)、[ui-spec.md](ui-spec.md)。
>
> 用户目标：X/Y 像 PS 画布——表示“浏览器视口左上角零点”在文档画布上的位置，**可为负数**；继续往负数调，页面内容在视口内向右/下移动，露出空白；反向同理；没有内容的区域不显示内容。
>
> 本文是这次变更的权威契约。**已实现并通过进程内验收**（Host viewport 14/14、166/166；隔离 GUI 画布轮 142/142、5 NOT_RUN；capture-p0 15/15、162/162；T3 56/56、415/415；全部 exit 0），证据见 [canvas-v2-2026-11-02.md](../tests/acceptance/evidence/canvas-v2-2026-11-02.md)。**标注 v1 轮同一 GUI 套件为 198/198、14 NOT_RUN，v2 起 222/222，v3 起 242/242，v4（2026-11-03 面板交互细节）起 256/256（Host 整包 19/206），见 [annotation-p0d.md](annotation-p0d.md)。** `viewport-control.md` 的“X/Y=页面滚动”仍描述 `x/y`；面板 X/Y 与画布空间以本文为准。**真实 3080 已于 2026-11-02 11:15 重启并加载画布 v2**：Host 画布语义（canvasX/Y、blank 合成、O=0 不重编码、T3 canvas mapping、blank act 零派发、导航复位、页面自主滚动保留 O）已在真实会话实测（[证据](../tests/acceptance/evidence/canvas-realhost-2026-11-02.md)）；**面板交互（画布与标注）与需 GUI 认证的路由仍 NOT_RUN**。

> **P0-D 独立性（2026-11-02 用户裁定）**：混合画布是 P0 的**第四项独立基础设施**，不再挂在 P0-C 下。P0-C 只负责共享视口（`x/y` 真实滚动、宽高、`scale`、`get`/`set`、`expectedRevision` CAS、滚动观测）；P0-D 负责画布取景（`canvasX/canvasY`、`O=C−S`、内容盒与空白、面板棋盘格、拖拽/滚轮缩放、`q→p=q+O` 与 fail-closed、画布空间截图/T3 与 `composite` 证据）。两者共用同一份 Runtime `view` 与 revision，但**各自独立验收**：P0-C 看 `viewport.mjs` 的 H/V1–V10；P0-D 看 `viewport.mjs` 的 V11-canvas/V12-frame/V13-route、GUI `viewport-gui.mjs` 的 V13/V14、`capture-p0.mjs` C15 与 `t3-vision.mjs` C57。P0-D 不改变页面 DOM/CSS/视口/DPR/zoom。

## 1. 术语与不变量

```text
canvas    = 文档内容区域（cssContentSize，原点 (0,0)，宽 contentWidth、高 contentHeight）
viewport  = 宽 width、高 height 的取景框（CSS px）
C         = (canvasX, canvasY) 视口左上角在 canvas 上的位置，可为负、可越出右下
S         = (x, y) 浏览器真实 document scroll，永远 0..max（max = content - viewport，负为 0）
O         = C - S（view 与真实内容帧之间的残差；O=0 时视觉与旧行为完全一致）
blank     = canvas 上 [0,contentWidth)×[0,contentHeight) 之外的视口区域
```

不变量：

1. `S` 永远在浏览器可滚动范围；`C` 是权威的视口原点；`O` 由 `C-S` 派生，不单独持久化。
2. `O = 0` 时：预览、截图、输入、坐标映射与旧实现逐字节/逐像素一致（回归保护）。
3. `O ≠ 0` 时：预览与默认截图显示的是 canvas 取景框 `[C, C+W) × [C, C+H)`；与内容区域交集之外为 blank。
4. 页面自身滚动（滚轮、JS、scroll snap、内层滚动容器）不禁止；顶层 `S` 变化时 **保留 O**（`C = S_new + O`），`source:"page"`、revision+1。
5. 导航/reload/新文档：`C=0,S=0,O=0`；关闭页面保留 width/height/scale，`C/S` 复位 0。
6. 不改页面 DOM/CSS/transform，不改 DPR、页面 zoom、Emulation 的 position；blank 是合成出来的，**不存在于页面 DOM**。

## 2. 数据模型（增量，不破坏旧字段）

`view` 增加两个字段，`version` 仍为 1（加性演进；旧 client 忽略未知字段）：

```text
view = {version:1, mode, x, y, canvasX, canvasY, width, height, scale, source, revision}
```

| 字段 | 范围/默认 | 语义 |
| --- | --- | --- |
| `x/y` | 0..10,000,000；默认 0 | 旧语义保留：真实 document scroll `S`（`Page.getLayoutMetrics` 实测回读） |
| `canvasX/canvasY` | 有限数，[-10,000,000, 10,000,000]；默认 0 | 新增：视口左上角在 canvas 上的位置 `C`；允许负/越界 |
| `mode` | 由 width/height 派生 | 不变 |
| `revision` | 单调递增 | `C` 或 `S` 内容变化、或成功应用后回读变化都递增；同值 set 不增 |
| `source` | default/gui/agent/page | 不变；页面自主滚动仍 `page` |

派生响应/投影（安全数值，只用 JSON）：

```text
offset = {x: C.x - S.x, y: C.y - S.y}
content = {width, height}        // 来自 Page.getLayoutMetrics cssContentSize
blank = "outside-content"
space = "canvas-css-px"
```

`ui.canvas`（`/state`、`/frame`、ensure/navigate/reload/history、`browser_state` 的 `ui` 投影）新增：

```text
ui.canvas = {
  version: 1, space: "canvas-css-px",
  x: canvasX, y: canvasY, offsetX: offset.x, offsetY: offset.y,
  contentWidth, contentHeight, blank: "white"
}
```

`browser_capabilities.viewport` 增加：

```text
canvas = {version:1, space:"canvas-css-px", range:[-10000000,10000000],
          blankColor:"#ffffff", compositeProvenance:true}
limits.viewport.canvas 同上 + {width/height 仍为旧范围}
```

## 3. 应用顺序与 set 语义

`applyView` 的预检/队列/CAS/ensure/两帧+稳定读回顺序不变，新增：

1. 纯预检：`canvasX/canvasY` 必须有限且在范围内；与 `x/y` **同时给出**时 `INVALID_ARGUMENT`（两种坐标不能同 patch）。空 patch 仍拒绝。
2. 队列内 CAS 复查（`expectedRevision`）不变，冲突 → `VIEWPORT_CONFLICT` 零应用。
3. 宽高变化才发 `Emulation.setDeviceMetricsOverride`。
4. 计算目标滚动 `S_target`：
   - 只给 `canvasX/canvasY`：`S_target = clamp(C, 0, max)`；`O = C - S_target`。
   - 只给 `x/y`：`S_target = x/y`；**保留旧 O**：`C_new = S_target + O_old`。
   - 都不给（只改 width/height/scale）：不动 C/S；宽高变化后 `S` 由浏览器自然约束，`O` 保留，`C = S + O`。
5. 有 `S_target` 时执行 `scrollTo({left,top,behavior:'instant'})`，两帧 + ≤1000ms 稳定读回实测 `S_actual`；`C_actual = S_actual + O`（若页面无法到达目标，最终以实测为准）。
6. 提交 `x/y = S_actual`、`canvasX/canvasY = C_actual`；`source` 按调用来源；有内容变化 revision+1。
7. 返回在旧字段基础上增加：`canvasX`,`canvasY`,`offset:{x,y}`,`content:{width,height}`；`clamped` 增加 `canvasX/canvasY`（该轴请求是否被浏览器/范围约束）。页面自主滚动只在后台观测时更新 S，并保留 O：`C = S_new + O`，`source:"page"`，revision+1。

关闭页面/导航：`C=S=0,O=0`。

## 4. HTTP / 工具 / 兼容

- `browser_viewport` 参数增加 `canvasX?:number`、`canvasY?:number`；`get` 返回 `view`（含新字段）与 `canvas`/`content`；`set` 同上。旧 `x/y` 语义不变。
- `POST /plugins/ui-testing/viewport` 的 v1 body **加性接受** `canvasX/canvasY`（与工具同一校验/CAS/响应）；旧 `{width,height}` legacy 路径不变；不要传 `version:2`。
- `browser_state`：`view` 带 canvasX/canvasY；新增安全 `canvas` 投影；不保证新鲜。
- **旧 client + 新 Host**：旧 client 只会写 x/y（scroll）并显示 x/y；Host 保留 O，因此不会静默破坏画布状态，但旧面板看不到 blank/offset；发布说明要求刷新面板。旧 client 的 `browser_screenshot`/T3 仍走旧 Host 的 x/y 语义（O≠0 时 Host 按 canvas 合成，可能与旧面板显示不一致）——**旧面板必须刷新后才能声称一致**。
- **新 client + 旧 Host**：`ui.canvas` 缺失时禁用画布字段与拖拽（X/Y 回退为旧 scroll 输入），不发送 `canvasX/canvasY`。

## 5. 画面与输入（client.js / 帧管线）

### 5.1 帧元数据

帧必须携带采集时的顶层滚动：`scrollX/scrollY`（来自 `screencastFrameMetadata.scrollOffsetX/Y` 或帧生成时的实测 S），通过 `frame-source.js`、`frame-push.js`、`/frame` 与 WS 元数据传给 client。旧 Host 无此字段 → client 禁用画布并回退。

### 5.2 预览合成

- 视口盒 `W*scale × H*scale` 作为裁剪容器（`overflow:hidden`）。**blank 在面板上是深色棋盘格**（固定屏幕像素格 12–16px、两个深色交替，纯本地显示样式，不随 `scale` 缩放）——2026-11-02 用户实测反馈「白页面 + 白空白看不出边界」后改为棋盘格；它只是可辨识的显示底色，**不是页面像素、不是证据**。
- **面板显示色 ≠ 证据色**：面板 blank = 深色棋盘格；截图 / T3 的 blank 仍是纯白 `#ffffff`（`capture.canvas.blank`、`mapping.blank` 均为 `"#ffffff"`）——截图要能被像素断言、要被基线比较，不能掺入 UI 花纹。`O=0` 且帧与视口尺寸一致时图像完全覆盖盒子，棋盘格不可见，旧像素不变（V13.0d 像素锁定）。隔离 GUI 套件 `viewport-gui.mjs`（画布轮）**142/142 PASS、5 NOT_RUN、exit 0**（执行者两次）；Lead 复跑 118/118 + 7 NOT_RUN（seed 两条条件检查未触发，非失败）；**标注 v1 轮 198/198、v2 起 222/222、v3 起 242/242、v4 起 256/256（12 NOT_RUN）**（见 [annotation-p0d.md](annotation-p0d.md)）。
- 当前帧内容在 `frame.scrollX/scrollY` 处的页面视口；显示位移 = `-(C - frame.scroll) * displayScale`（`displayScale = paintedWidth / W`，y 同理；用实际绘制矩形）。
- 使用 `transform: translate(...)` 或等价偏移，**不改页面**；`O=0` 且 `frame.scroll=S` 时位移为 0，视觉与旧版一致。
- **seed 帧**：静态页面可能没有 live frame；seed 是 `/screenshot` 的合成画布图。seed 必须记录生成时的 canvas (`C`) 与 `S`（或 view revision）；canvas 变化后旧 seed 失效并重新采集（同一页面状态只请求一次，失败保持 fail-closed），否则静态页在 pan 后无法恢复输入。
- 空白区只显示白色，不绘制页面内容、不显示网格。

### 5.3 指针/滚轮/拖拽

- 视口点 `q`（CSS px，相对视口左上角）→ canvas 点 `d = q + C` → 页面视口点 `p = q + O`。
- 只在 `d` 落在 `[0,contentWidth)×[0,contentHeight)` 且 `p` 落在页面视口范围内派发；否则 blank：**零派发**。滚轮在 blank 上零派发。**兼容边界**：`O=0` 时保留旧行为（不按内容盒做 blank gating），以免改变“页面背景小于视口”时的既有交互；blank 严格判定只在 `O≠0` 生效。
- 键盘仍只在画面有焦点时转发；拖入 blank 不自动结束页面拖拽（保持现有释放/取消语义），但 blank 的按下/移动不派发。
- **几何/滚动屏障**：当 `O ≠ 0` 时，必须等 `frame.scroll` 与当前 `S` 一致（±1 CSS px）且 pageWidth/Height 与 view 一致才允许输入；不一致时 **fail-closed**（不派发），不能沿用旧的 250ms 超时放行。帧无 scroll 元数据时视为不满足。
- **空白起手拖拽**：拖拽模式增加仅在该模式生效的透明 overlay 覆盖视口盒（cursor `grab`/`grabbing`），即使内容完全移出视口也能从空白处拖回；非拖拽模式不改变命中面。
- **拖拽模式滚轮 = 缩放**（2026-11-02 用户要求，同日改为**严格锁屏幕光标点**）：`panMode` 时画面滚轮改 `view.scale`（5%/Shift 10%/Alt 1%，0.1–2）。锚点按**屏幕坐标**：`d = C + (S − R.left)/s`（S 光标屏幕点、R 盒子实测矩形），预测缩放后盒位（居中轴 `left' = stage.left + (stageW − W·s')/2`，不居中轴退回 `R.left`），`C' = d − (S − left')/s'`——光标下的画布点在屏幕上不动。`canvasX/canvasY` 与 `scale` 同 patch、不与 `x/y` 混传；fit 勾选则自动取消；空白上也可缩放（视图层操作，不是页面输入）。非拖拽模式滚轮仍滚页面。实测屏幕漂移 ≤0.03 CSS px（V14.2/V14.2c）。
- **拖拽模式**：语义改为直接平移视口 `C`（不是 scroll）：内容跟手，`C_new = C_start - Δhost × W / Pw`（y 同理），范围 ±10,000,000；写入 `canvasX/canvasY`（可与旧 x/y 写路径共用 CAS/节流，但字段必须是 canvas）。到范围边界后停止（不再 clamp 到 0）。
- X/Y 输入/wheel 绑定 canvasX/canvasY；`O=0` 时数值与旧 scroll 行为相同。

## 6. 截图与 T3（Host）

### 6.1 截图（`browser_screenshot` / `Runtime.capture`）

- **默认截图（无显式 region）**：捕获 canvas 视口 `[C,C+W)×[C,C+H)`。`O=0` 时沿用现有单次 CDP PNG 路径，不重编码；`O≠0` 时：
  1. 以真实 `S` 捕获页面视口（现有 path，PNG）；
  2. 生成 `W×H`（×scale）白底画布，把内容帧按 `-O` 平移贴入，裁剪到视口；
  3. 输出合成 PNG；运行既有 PNG 结构/CRC/尺寸/均匀统计/16M 检查。
- **显式 region**：坐标空间为 **canvas CSS px**（`O=0` 时与 document 相同），同样按 canvas 合成；region 与内容区域的交集贴图，其余 blank。
- 证据新增：

```text
capture.canvas = {version:1, space:"canvas-css-px", x:C.x, y:C.y,
                  scrollX:S.x, scrollY:S.y, offsetX:O.x, offsetY:O.y,
                  contentWidth, contentHeight, blank:"#ffffff",
                  composite:boolean, source:"cdp-page-capture-screenshot"}
capture.request.space = "canvas-css-px"
mapping.coordinateSpace = "canvas-css-px"（O≠0）| "document-css-px"（O=0，兼容）
mapping.canvas = {x,y,scrollX,scrollY,offsetX,offsetY,contentWidth,contentHeight}
mapping.contentRect = {x,y,width,height}   // canvas 与内容交集
mapping.blank = "outside-content"
```

- 合成 PNG 会重编码；证据必须显式 `composite:true`，不能继续宣称“原始 CDP PNG 未重编码”。16M 预算按最终合成图计算。
- blank 的 documentCss 无内容（T3 映射为 `null`，act 不派发）。

> **2026-11-02 spike（独立无头 Chrome）**：`Page.captureScreenshot` 的 `clip.x/y` 传负值不会平移画面（返回与 `clip=0,0` 相同的像素），因此**不能**用单次 CDP clip 直接截出负坐标画布；`captureBeyondViewport` 也不能补出 blank。O≠0 的截图必须走“原生视口 PNG + 白底合成”（重编码），O=0 才保持原始 PNG 路径。

### 6.2 T3

- `Source.live` 使用画布截图（O=0 行为不变）；mapping 使用 canvas 空间；`find.documentCss` 仍是文档坐标（可能为负），并带 `canvas` 字段；blank 上的识别候选保留像素结果但 `documentCss=null`。
- `act`：图像点 → canvas 点 → `p = q + O`；blank/内容外 → 零派发（`VISION_HIT_MISMATCH` 或新 `VISION_BLANK_AREA`）；复核 C/S/代次/mask/hash 不变。
- `baseline`/`compare` 等算法不变，mapping 兼容检查接受新字段；旧基线（document）与 canvas 映射不兼容时按既有 `mapping-incompatible` 处理。

## 7. 验收（必须程序化）

### 7.1 Host（`viewport.mjs` 增量）

- C 默认 0，O=0，旧 H1–H10 全绿。
- `canvasX=-100,canvasY=-50` → `x=y=0`，`offset=-100/-50`，页面 scroll 仍 0；页面真值不变；revision 递增；`expectedRevision` CAS 零应用；范围/类型/与 x/y 同传拒绝。
- `canvasX` 在内容内部 → scroll 到该值，O=0；超过 max → 露 blank（offset>0）。
- 页面自主滚动：保留 O，C=S+O，source page。
- 导航/关闭：C/S 复位 0；width/height/scale 保留。
- 能力/limits/ui.canvas/state 投影；旧字段不变。
- 帧元数据：新帧带 scrollX/Y；旧帧无字段时 client 禁用。

### 7.2 隔离 GUI（`viewport-gui.mjs` 增量）

- X/Y 输入/wheel 写 canvas 坐标；负值可输入/滚轮可到负数；输入框显示 C。
- 预览：`C=-100` 时左侧 100px 棋盘格、内容右移；`C>max` 时右侧棋盘格；`O=0` 时与旧截图/命中一致（无缝无棋盘格）。
- 点击/滚轮/拖拽在 blank 零派发；内容区点击 `clientX/Y` 按 `p=q+O` 命中；`frame.scroll` 不一致时 fail-closed。
- 拖拽模式：内容跟手、可进入负 C、边界 ±1e7、关闭后恢复页面交互。
- 旧 Host 模拟：禁用 canvas 字段/拖拽。

### 7.3 截图/T3（`capture-p0.mjs`/`t3-vision.mjs` 增量）

- O=0：旧基线断言全通过（不重编码）。
- O≠0：默认截图 W×H、四边 blank 纯白、内容位置与 `-O` 一致；`capture.canvas`/mapping/`composite:true`；region 为 canvas 坐标；16M 拒绝；空白 documentCss=null。
- T3 live/find/act：canvas 映射、blank 零派发、`O=0` 旧断言不回归。

## 8. 风险与限制（不夸大）

- fixed/sticky 按原生 `S` 布局后随整帧平移，**不锚定新视口窗口**；这是合成画布的已知代价。
- 截图/T3 合成会重编码 PNG，不能承诺原始 CDP 字节不变；证据必须披露 provenance。
- 只合成“页面内容帧”；blank 不在 DOM 中，不能通过 `browser_eval` 查到页面元素/命中。
- 旧 client/旧 Host 的兼容按 §4；旧面板未刷新时不保证画布显示一致。
- 帧元数据缺失或滚动不一致时输入 fail-closed；可能表现为短暂“点不动”（这是安全行为，需在面板提示）。
- 范围 ±10,000,000；16M 输出预算按最终合成图；**截图/T3 的空白背景纯白、无网格**（面板棋盘格不入证据）。
- 未实现前不得声称“真实页面露出空白”；合成是 Host/Client 的视图层事实。

## 9. 切片

1. `index.js` + `frame-source.js` + `frame-push.js`：view 模型/应用/观测/HTTP/工具/能力/state/帧 scroll 元数据。
2. `capture-p0.js` + `vision-t3.js` + `index.js`：合成截图、mapping、T3 act/blank。
3. `client.js`：X/Y canvas、预览平移/裁剪、**深色棋盘格 blank（面板显示）**、输入映射、drag、fail-closed 屏障。
4. `tests/acceptance/*` + 本文件 + `viewport-control.md`/`ui-spec.md`/`status.md`/README/Skill/台账：验收与文档。
