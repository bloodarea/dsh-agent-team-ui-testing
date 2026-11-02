# 统一视口控制契约（已实现）

> 2026-11-01 · Lead 冻结 + Host/Client 双切片落地。**本文是现行契约，不再是草案**：所有"推荐/待裁决"已由 Lead 裁决（见 §9.2），实现与验收计数以实际代码与报告为准。
>
> 关联：[文档索引](index.md)、[当前状态](status.md)、[运行时](runtime-t1.md)、[P0 采集](capture-p0.md)、[T3](t3-vision.md)、[工作区隔离](workspace-isolation.md)、[验证方法](verification.md)、[界面规格](ui-spec.md)。
>
> 本轮对截图默认密度（跟随 `view.scale`）与 scale 下界（1 → 0.1）的变更**是有意的契约变更**，已同步更新 P0/T3 文档，不能继续宣称旧工具语义完全不变。

> **2026-11-02 画布式加法（已拆为独立的 P0-D 混合画布，权威契约见 [canvas-viewport.md](canvas-viewport.md)）**：本文只描述 P0-C 共享视口（`x/y`/宽高/`scale`/CAS/观测）；画布原点、空白、拖拽与滚轮缩放归属 P0-D。`view` 新增 `canvasX/canvasY`（视口左上角在文档画布上的位置，带符号 ±10,000,000）；`x/y` 保留真实 document scroll。面板 X/Y 输入与拖拽改为写 `canvasX/canvasY`（可为负/露白），`O=C-S` 时预览/截图/T3 按画布空间合成（O=0 与本文旧语义字节/像素一致）。本文 §3 的 x/y 描述、§6 的截图默认路径在 `O=0` 时仍成立；`O≠0` 以 canvas-viewport 为准。

## 1. 冻结的裁决与实施边界

1. 尺寸栏每个数值输入框支持鼠标滚轮快速调整；新增视口 X/Y 输入框，同样支持滚轮。X/Y 是**页面顶层滚动位置**，即 layout viewport 左上角在文档中的 CSS 坐标，不是桌面窗口位置、容器平移或 CDP positionX/Y。
2. Agent 可以通过工具设置宽屏/横屏/平板/手机预设、x/y/width/height/显示比例。宽高的显式设置改变页面 CSS viewport；仅修改显示比例时，Chromium 页面 CSS viewport、DPR、页面缩放与布局保持不变。"保持 CSS 视口不变"约束的是放大镜式显示/采集操作，不是禁止用户显式改宽高。
3. 不用 deviceScaleFactor 或页面 zoom 实现面板放大。沿用 Runtime 受控 `deviceScaleFactor=1`、`mobile=false`，不发送 setPageScaleFactor，不改 CSS zoom，不用 Emulation 的 scale/positionX/positionY。
4. 人类面板保留实时 screencast，帧按 CSS viewport 比例显示；Agent 默认截图按当前逻辑视口与显示比例输出，并保留显式获取更高密度 PNG 的能力。二者网页内容、布局、相对大小和可视文档矩形一致；像素密度与 JPEG/PNG 编码可以不同。不为图片宽高相等而替换实时链路。
5. 用户提供的实测事实（仍属外部证据，本轮未复跑）：Emulation.setDeviceMetricsOverride 的 scale 不影响输出；positionX/Y 报 "View position should be on the screen"；DPR=2 时 800×600 页面 screencast 仍是 800×600，而 captureScreenshot 为 1600×1200；clip.scale 与 dsf 相乘。因此采纳 A 方案：面板 1x 实时帧按比例显示，Agent 逻辑比例截图并保留显式高密度能力。
6. 沿用现有一个 Chromium/profile、每工作区 page、scope 身份链、鉴权、串行队列、single-owner-lease、取消关闭及 BUSY；不新增设备仿真、窗口定位或页面缩放功能。**帧协议未扩展**（见 §5.4）。

## 2. 实现落点

| 位置 | 实现事实 |
| --- | --- |
| `index.js` `VIEW_PRESETS` / `VIEW_LIMITS` | 四个预设 + 全部范围常量（宽高 200–4096、scroll 0–10,000,000、`scale` 0.1–2、默认 1280×800@100%、`scrollPollMinMs` 200、`staleAfterMs` 1000、`settleMaxMs` 1000）；`browser_capabilities.limits.viewport` 与此同源，不重复魔法数字 |
| `Runtime.view` / `get viewport()` | 每 Runtime 一份权威 view；顶层 `viewport` 改为 **getter 别名**，与 `view.width/height` 不可能漂移 |
| `normalizeViewportRequest` / `expandViewPatch` | 纯预检（无浏览器/CDP/文件）与 patch 展开；`mode` 展开为预设宽高 |
| `Runtime.applyView` | 队列内的 CAS 复查 → `ensure` → 仅在宽高变化时 metrics override → 仅在给出 x/y 时滚动 → 两帧 + 有界稳定读回 → 提交 |
| `Runtime.#readViewMetrics` / `#scrollViewTo` / `#waitTwoFrames` / `#settleViewObservation` | `Page.getLayoutMetrics`（css* 字段）为唯一事实源；只允许两处 `Runtime.evaluate`：instant `scrollTo` 与 DPR 读回 |
| `refreshViewObservation(Soon)` / `#commitObservedPosition` | 合并、节流、single-flight 的后台观测；只回显 x/y（`source:'page'`），不覆盖宽高/比例 |
| `viewProjection` / `observedProjection` / `viewMeta` / `viewSnapshot` | 同一份纯 JSON 投影供工具、HTTP `ui.view` 与 `state.view` 使用 |
| `Runtime.capture` / `normalizeCaptureRequest` / `assertCaptureBudget` | 缺省 scale 保留到调用内解析；逐轴 mapping；低比例空输出提前拒绝 |
| `capture-p0.js` | `CAPTURE_LIMITS.scaleMin=0.1`、`minOutputPixels=1`、`hasPositiveOutputSize()` |
| `vision-t3.js` / `t3ResolveSource` | `Source.live` 保留"省略 scale"，由 Host 在调用内用冻结的 `view.scale` 解析 |
| `browser-safety.js` | 新增 `VIEWPORT_CONFLICT`（state / retryable） |
| `client.js` | 共享 view 采纳/草稿/滚轮/fit/painted rect 映射/帧几何屏障；尺寸栏 X/Y 与 flex-wrap；**拖拽视口（2026-11-02 用户要求）**：`☑拖拽`、抓取光标、按 painted rect 把拖动换算成 x/y 并 80ms 合并写入 |
| `tests/acceptance/viewport.mjs` / `viewport-gui.mjs` | Host 与隔离 GUI 验收套件（见 §8） |

## 3. 数据模型与范围

### 3.1 权威对象

每个 Runtime 持有 `view`（不存于全局 Client）。顶层旧 `viewport={width,height}` 保留为 getter 别名。认证 GUI 的 `ui.view` 与工具的 `view` 是同一数据的纯 JSON 投影，不能各自计算模式或比例。

```text
view = {version:1, mode, x,y,width,height,scale,source,revision}
observed = null | {
  x,y,width,height, contentWidth,contentHeight,
  pageDevicePixelRatio,visualViewportScale,
  observedAt,source:"Page.getLayoutMetrics"
}
viewMeta = {runtimeId, observedAt:null|epochMs, stale:boolean, originId:null|string}
```

| 字段 | 默认 / 范围 | 语义 |
| --- | --- | --- |
| mode | `custom`；`wide/landscape/tablet/phone/custom` | 按最终 width/height 精确匹配派生（`viewModeFor`），禁止独立持有易失真的选中状态；`custom` 只作为返回值 |
| x / y | 0；有限 number，输入 `[0,10000000]` | 文档 CSS px 的页面顶层滚动位置；成功应用后回实际 scroll，允许小数。请求超内容边界由浏览器约束，`clamped.x/y=true` 如实报告；观测到 RTL 负 x 时如实返回负值，v1 setter 只接受非负请求 |
| width / height | 1280 / 800；integer `[200,4096]` | 显式改尺寸才调用 metrics override；工具与 v1 HTTP 不隐式 round/clamp（旧 legacy HTTP 仍 round/clamp，见 §4.2） |
| scale | 1；连续 finite number `[0.1,2]`（10–200%） | 面板 CSS 显示比例，也是省略 scale 截图的默认密度；不是 DPR、page zoom 或设备模拟。显式截图 scale 的合法范围更宽（0.1–4，见 §6） |
| source | `default`；`default/gui/agent/page` | 最近一次可观察 view 内容变更来源；`page` 代表自主滚动/恢复历史/脚本等读回变化，不推断具体触发者 |
| revision | 0；非负安全整数 | 同 Runtime 单调递增；仅内容改变或成功应用后读回改变时递增，纯 get/轮询/同值 set 不递增；不可复用 `ui.revision` |
| viewMeta.originId | null | **本轮实际恒为 null**：Client 只提交 `expectedRevision`，不发送 `originId`；Agent 写入恒传 null。Host 的 HTTP v1 仍接受可选的 `originId`（≤64 可打印 ASCII），仅当调用方显式提供时才原样投影，用于诊断"这次写入是谁发的"，**不是鉴权、scope 或租约身份** |
| observed | cold 为 null | 最近一次真实 metrics 与 DPR/visual scale；缺失值为 null，禁止用默认值标"已观测" |

`view.x/y` 是最后接受的实测位置；cold 未观测时仅为默认值，须与 `observed:null` / `viewMeta.stale:true` 一起读。成功 set 返回 `requested`（本次 patch）、`view`（最终状态）、`applied`/`settled` 与 `clamped:{x:boolean,y:boolean}`（该轴请求值是否被浏览器约束），**不把请求值当实际 scroll 回显**。关闭页面保留宽高/scale 配置，x/y 复位 0、observed=null、originId=null，并在确有位置变化时 revision+1；新文档导航/历史恢复以浏览器最终滚动为准，不自动 scroll 回旧页面位置。

预设：wide=1920×1080，landscape=1024×768，tablet=768×1024，phone=393×852；1280×800 派生 custom。`set mode` 只展开宽高，**同一 patch 里同时给出的 x/y/scale 仍生效**（`expandViewPatch` 已修复为透传，见 §9.2 第 7 条）。mode 与 width/height 同传一律 INVALID_ARGUMENT；custom 不能作为输入。

### 3.2 观测事实来源与节流（已实现）

统一 `Page.getLayoutMetrics`：`cssLayoutViewport.pageX/pageY/clientWidth/clientHeight` 为 x/y/尺寸来源；`cssContentSize` 提供内容范围；`cssVisualViewport.scale` 提供 zoom 事实；页面 DPR 由 `Runtime.evaluate('window.devicePixelRatio')` 读取（失败为 null）。`Runtime.evaluate` 只用于 instant `scrollTo` 与 DPR 读取，不建立 `window.scrollX/Y` 权威缓存（验收可用它做独立真值对照）。缺少 `css*` 字段的 Chromium 报 `UNSUPPORTED`（`reason:'css-layout-viewport-missing'`），不把 device px 无标识混入 CSS 字段。

- **触发**：成功 `set`（自身有界读回）、主框架导航提交、`/input`（派发后 50ms 与 250ms）、`/frame`（80ms 轮询）与 `/state`（500ms 轮询）、以及除 `browser_viewport` 外任何成功的页面操作后各调度一次。
- **节流**：真实读回至少间隔 `scrollPollMinMs`（200ms）；同一窗口内的多个请求合并为一次；同时最多一个读回（single-flight）；**事件驱动，无常驻计时器**——没有 viewer、没有动作的静止页面零 CDP 调用。
- **只回显位置**：后台读回只把 x/y 写回 `view` 并置 `source:'page'`、revision+1；宽高与 scale 由 set 独占，后台样本不改写；同值样本不增 revision。
- **过期与失败**：缓存超过 `staleAfterMs`(1000) 标 `stale:true`；读回失败保留旧事实并标 stale，不虚构位置；进行中的页面操作/启动/关闭期间只延后一个槽位，不堆队列。
- **稳定性**：set 先等两帧（rAF×2，500ms 上限，失败仅放弃提前量），再在 `settleMaxMs`(1000) 内每 50ms 采样，x/y/width/height 连续两次差 ≤0.01 CSS px 视为 settled；仍未稳定返回 `applied:true`、`settled:false` 与最后实测值。smooth scroll / scroll snap / 页面脚本可继续改位置，不声称永久锁定。

## 4. Host 应用、兼容与同步

### 4.1 set 顺序与失败

同 Runtime 一个串行事务，实际顺序：

1. **队列外纯预检**（`preflight`）：未知字段、action、空 patch、`mode`+宽高冲突、非有限/非整数/越界、`expectedRevision` 类型全部在 `INVALID_ARGUMENT` 拒绝——不 ensure、不发 CDP、不落盘。
2. 进入 `run()`（scope 租约 + 串行队列）后**复查 `expectedRevision`**：与当前 `view.revision` 不同 → `VIEWPORT_CONFLICT`，patch 零应用。
3. `ensure`（scale-only set 也按页面操作 ensure，保持单一权限规则）。
4. **只有宽高变化**才发 `Emulation.setDeviceMetricsOverride({width,height,deviceScaleFactor:1,mobile:false})`；**scale-only、x/y-only 不发 override**。
5. 有显式 x 或 y 时，先读现场 metrics，按保留另一轴的现场 scroll 执行 `scrollTo({behavior:'instant'})`；未给 x/y 不额外 scroll。
6. 两帧 + 有界稳定读回，以实际 metrics 提交 x/y/宽高，scale 与 source 一起提交；有内容变化时 revision+1。
7. 返回 `{ok,requested,before,view,observed,viewMeta,applied,settled,clamped,overrideApplied,appliedFields}`；screencast 继续沿现有 ACK/缓存/WS/轮询工作，不改成 PNG 定时截图。

多步 CDP 没有数据库式回滚：override 成功但后续失败时，先提交可证明已应用的字段，再抛错，`details` 带 `phase/appliedFields/view/observed`（安全数值），**禁止返回"零副作用"**。ABORTED/CDP_DISCONNECTED/CAPTURE 类沿用现有清理与分类；非协议的稳定超时用 `settled:false` 成功，协议错误仍抛错误。

### 4.2 HTTP 与 UI 投影（已实现）

`POST /plugins/ui-testing/viewport` 同时支持两种形状：

```text
legacy: {width,height}                       # 无 version，维持 Number/round/clamp，保留 x/y/scale
v1:     {version:1, ...patch, expectedRevision?, originId?}
response: {ok:true, viewport:{width,height}, view, observed, viewMeta,
           requested, clamped, applied, settled, state}
```

- **legacy 兼容**：保持原来的两字段必需性/数值转换/200–4096 clamp/`viewport` 返回字段；只改宽高，保留当前 x/y（受 resize 自然约束）与 scale，不把缺省当重置；该路径把 `source` 记为 `gui`。
- **v1 严格**：`version` 只接受 1；`originId` 可选，给了就必须是 ≤64 个可打印 ASCII（非法 INVALID_ARGUMENT），不取代可信 scope 头——**本轮面板不发送它**，所以 `viewMeta.originId` 恒为 null；其余字段与工具同一 `normalizeViewportRequest`；`state` 总是附着。
- **错误映射**：`VIEWPORT_CONFLICT → 409`，其余沿用既有 code→status 映射。
- 认证 `/state`、`/frame` 的 state、ensure/navigate/reload/history 响应统一附 `ui.view`/`ui.viewMeta`/`ui.observed`；顶层 `view` 为无页面文本的安全投影，供 `browser_state` 使用。`ui.version=1` 保持加法，`ui.revision` 继续用于跨响应排序；WS transport 不承担 raw address 同步。
- 旧 client 不懂 `view`，仍按 legacy 形状读写宽高；同 scope 下可能每次导航覆盖宽高——这是兼容边界，不能宣称其具备新同步能力。

### 4.3 GUI ↔ Agent 与 fit（已实现）

Host view 是页面和默认截图的权威；Client 字符串输入仅为编辑草稿。

- **首次绑定/切工作区**：先 `acceptRemote` 接受 `ui.view` 再显示尺寸。只有 Host view 的 `source==='default'` 时，本次 scope gen 的首次绑定会**推送一次**本面板历史默认 393×852@100%（保持"新开面板即手机尺寸"的产品行为）；其他 source 一律直接采纳，不写 Host。挂载、打开尺寸栏、导航、重连都不再发送本地 393×852。
- **导航链**：`ensure` 的响应若已带共享 view，就不再隐式 POST 本地尺寸；只有旧 Host（无 `ui.view`）保留旧写入口。
- **响应顺序**：沿现有 runtimeId+ui.revision 退役/丢迟到响应；`view.revision` 单独保护内容变更；scope gen 切换时清空 view/drafts/帧几何/在飞请求。
- **编辑保护**：x/y/width/height/scale 各自持 draft/dirty/editVersion/wheelVersion；轮询照常更新已接受的权威状态与画面，不覆盖 dirty 文本；Enter/blur 提交合法草稿，Escape 取消并采纳最新值；非法中间态不发请求。
- **按字段 patch**：只提交被改动的字段，120ms trailing debounce 合并；同面板最多一个 set 在途，后续意图排队到响应后以最新版本提交；轮询采纳不触发发送。宽度/高度一次编辑会合并成一个 patch（预设按钮同时改两轴）。
- **CAS**：GUI v1 总是带最后接受的 `expectedRevision`；检查在队列内。冲突时保留用户手打的草稿、采纳返回的最新 view、**不自动重放**旧 patch；被拒绝的滚轮步进不算草稿，直接回落到权威值。
- **fit 是面板本地显示偏好**，Host 只接收计算后的 numeric scale：`fitScale=clamp(min(1,(roomW-48)/W,(roomH-24)/H),0.1,1)`，room 取 stage 内容尺寸。勾选 fit 时不发布比例；手动改比例取消 fit 并 POST v1；取消勾选只是回到显示 Host 比例，不发布。收到 `source=agent` 或另一面板的内容变更（revision 变化）时采纳 Host 全部值并取消本地 fit；`source=page` 只更新 x/y，不取消 fit；自己的 ACK 不再触发 fit。界面可显示整数百分比，但写入用 0.01 精度（`scale` 0.001 步长），同值不发请求、不增 revision。

## 5. 面板坐标映射与滚轮

### 5.1 纯几何公式（已实现）

Client 使用**当前已显示帧**的自然尺寸（Nw,Nh）、已接受的该帧对应 CSS viewport（W,H），以及 img content box 在宿主窗口 CSS 坐标中的矩形 B=(left,top,Bw,Bh)。`object-fit:contain; object-position:50% 50%` 时（`paintedRect()`）：

```text
k = min(Bw/Nw, Bh/Nh)
Pw = Nw*k; Ph = Nh*k
L = B.left + (Bw-Pw)/2
T = B.top  + (Bh-Ph)/2
u = (event.clientX-L)/Pw
v = (event.clientY-T)/Ph
viewportCss = {x:u*W, y:v*H}          # 半开区间 [L,L+Pw)×[T,T+Ph)
documentCss = {x:view.x+u*W, y:view.y+v*H}
imagePixel  = {x:u*Nw, y:v*Nh}
```

B 不包括 border/padding（当前 img border=0）。`event.clientX/Y`、`getBoundingClientRect` 与 W/H 都是 CSS px，**不乘除宿主 window.devicePixelRatio**；目标页 DPR 也不进公式；自然图片密度通过 Nw/Nh 抵消。screencast 降采样时 W≠Nw，两者都必须保留；不能用 PNG 截图 scale 当 screencast 密度。natural*=0 或未关联帧时禁用输入，不回退发 (0,0)。

- letterbox 内 pointerdown/click/wheel 不派发；普通 hover 在图外不派发。
- 拖拽一旦在图内开始使用 pointer capture，move/release 共用同一公式并 clamp 到 `[0,W-ε]×[0,H-ε]`（ε=0.001）；**图外也派发最终 mouseReleased**，pointercancel/lostpointercapture 做尽力释放。
- 连续坐标不提前 Math.round（CDP 接受 CSS 小数）。

### 5.2 可直接断言的样例

| 输入 | 期望 |
| --- | --- |
| W=800,H=600；N=800×600；B=(100,50,800,800) | painted=(100,150,800,600)；client=(500,450) → viewport=(400,300) |
| 上例 client=(500,100) | 在上方 letterbox，零派发 |
| W=1920,H=1080；N=1600×900；B=(0,0,960,540) | client=(480,270) → viewport=(960,540)，不能得到 800×450 |
| W=800,H=600；N=1600×1200；B=(0,0,520,390)；宿主 DPR=1 或 2 | client=(130,97.5) 都 → viewport=(200,150) |
| 上例 scroll=(40,120) | document=(240,270)；派发 CDP 鼠标仍用 viewport=(200,150) |
| 图像中心点击，在 scale=.65、1、2 各测一次 | 目标页 clientX/Y 相同，isTrusted=true，目标计数只增 1 |

GUI 套件实测覆盖：fit<100% 与 200% 下固定元素命中、画面外点击零派发、窄面板 wrap、Ctrl/Meta 滚轮不编辑字段（V8.1–V8.6、V11）。**letterbox 零派发在 GUI 套件里是 NOT_RUN**：该帧 painted rect 填满容器、没有 band 可点（V8.5）。

### 5.3 两类滚轮（已实现）

**尺寸栏数值滚轮**：五个输入（X/Y/W/H/百分比）都处理；向上增、向下减，`deltaY==0` 不改；每事件一个步长（`WHEEL_STEPS`）：X/Y/W/H 默认 10 CSS px、Shift=100、Alt=1；比例默认 5 个百分点、Shift=10、Alt=1；**Alt 优先于 Shift**。Ctrl/Meta+wheel 被面板吞掉（`preventDefault`+`stopPropagation`）：既不编辑字段，也不让聚焦的 `input[type=number]` 走浏览器原生步进（那是第二条不同步写入路径）；面板其余位置的浏览器缩放不受影响。捕获在该输入上的非被动 wheel，宿主滚动与目标页都收不到。

**画面滚轮**：位置按 §5.1，只有画面内才 `preventDefault`。`deltaMode` 固定换算（`FRAME_WHEEL_LINE_CSS_PX=16`）：

```text
mode 0 (host CSS px): delta_target = delta_host * (W / Pw)      # y 轴同理 H/Ph
mode 1 (line):        delta_target = delta_host * 16 * (W / Pw)
mode 2 (page):        delta_target = delta_host * W
```

GUI 实测：200% 时页面位移约是 100% 时的一半（V9.1–V9.3）。Ctrl/Meta 组合不映射成目标页 zoom。

### 5.4 宽高变更后的输入屏障（best-effort，partial）

改宽高后，在新帧被证明匹配前暂停指针/滚轮输入：`onFrameLoad` 记录解码后的 `naturalWidth/Height` 与帧元数据的 `pageWidth/pageHeight`；`geometryMatches()` 优先比对 page 尺寸（±1 CSS px），没有元数据时退回纵横比（≤0.02）。屏障上限 `GEOMETRY_WAIT_MS=250`，超时后放行并清掉 pending——**这是屏障而不是保证**。**帧协议未扩展**（`frame-source.js`/`frame-push.js` 本轮未改），因此没有可信的帧几何/代次关联；该子项在 GUI 套件里记 NOT_RUN（V10.6），文档与报告都按 partial 表述。

### 5.5 拖拽视口（面板「拖拽」模式，用户 2026-11-02 要求，已实现）

尺寸栏在 `适应窗口` 与缩放 `%` 之间新增 `☑拖拽` 复选框（`aria-label="拖拽视口"`，无共享 `ui.view` 的旧 Host 时禁用）。语义：

- **光标**：勾选后预览画面的 `cursor` 为 `grab`，按住拖动期间为 `grabbing`；不勾选时为 `auto`。
- **方向与换算（2026-11-02 canvas v2 起）**：按住画面拖动按**内容跟手**方向平移**画布原点 C**——向右/下拖 → `canvasX/canvasY` 减小，向左/上拖 → 增大；可进入负值/露白，范围 ±10,000,000。位移按同一 painted rect 换算：`Δcanvas = ΔhostPx × W / Pw`（y 同理，`Pw` 为实际绘制宽度；缩放比例抵消）。空白区也可起手（拖拽模式 overlay）。
- **写入路径**：与输入框相同的 `/viewport` v1/CAS 请求；面板按 80ms 合并移动事件，同一时刻最多一个 set 在途（Host 每次 set 含两帧 + ≤1000ms 稳定读回，不能被洪泛）。冲突/失败沿用 `VIEWPORT_CONFLICT` 处理，不自动重放；拖拽模式不改变 `source` 归因规则（HTTP v1 记为 `gui`）。
- **输入抑制**：勾选期间不向目标页面派发 pointerdown/move/up（点击、拖拽、悬停都零派发）。
- **滚轮 = 缩放画布（2026-11-02 用户要求，已实现）**：拖拽模式下画面滚轮不再滚动目标页，而是改共享 `view.scale`（步进 5%/Shift 10%/Alt 1%，Alt 优先；范围 0.1–2，越界 no-op；Ctrl/Meta+滚轮不缩放）。以**屏幕光标**为锚点（含盒子居中补偿）：`d = C + (S−R.left)/s`、`C' = d − (S−left')/s'`（`S` 光标屏幕点、`R` 盒实测矩形，两轴独立；不居中轴退回 `R.left`），`canvasX/canvasY` 与 `scale` 同 patch 且不与 `x/y` 混传；拿不到几何则只改 scale。若「适应窗口」勾选则**自动取消**（走手动改比例的同一路径）。拖拽模式外的滚轮仍是 §5.3 的滚页面语义。取消勾选、关闭尺寸栏、切换工作区（scope/binding generation 变化）都会结束拖拽并恢复默认光标与页面交互。`O≠0` 时输入使用 §5.3 的 fail-closed 屏障；空白区零派发。
- **边界**：拖拽期间显示帧若更新（screencast 尺寸变化），换算沿用按下时的绘制矩形（一次拖拽内一致）；`x/y` 只在文档滚动范围内移动，RTL/scroll snap 等边界与 §3.1 相同，不做额外承诺。

GUI 验收见 §8.2 的 V12（复选框/光标/方向/抑制页面事件/clamp/恢复交互）。

## 6. Agent 截图比例与映射

### 6.1 单图、显式密度、扩展下界（Lead 冻结）

- `browser_screenshot` 省略 `scale` → **在调用内读取一次当前 `view.scale`**（`scaleSource:'view'`，cold 为 1）；默认 region 仍取现场 layout viewport。显式 finite scale `[0.1,4]` 覆盖 `view.scale`（`scaleSource:'explicit'`），只影响该次截图，不写 view、DPR、scroll 或 viewport。显式 `null` 视为省略（validator 不把它固化成 1）。
- T3 所有 `Source.live` 同规则：省略 `scale` 时由 Host 用**本次调用开始时冻结**的 `view.scale` 解析（一个调用里多个 live 源共享同一默认值，避免解析间比例漂移）；显式值覆盖。`act` 再采样使用 `captureFacts` 里冻结的原采集比例，不重新取当前 `view.scale`。
- `view.scale` 合法范围 0.1–2（10–200%，GUI 与 Agent 同源）；显式截图 scale 0.1–4。旧 `scale=1–4` 全部继续合法；**默认值随 view 变化与新增 scale<1 是有意契约变更**。默认 Host scale=1 时旧默认图片尺寸不变。
- 不新增 raw 参数、不默认返回两张图、不保存未披露的"原始高清图"、不二次 capture。`scale:1` 明确请求逻辑 CSS 原始尺寸；`scale:2…4` 是更高密度原始光栅 PNG。需要高精细保留时用显式 scale + region（控制 16M 预算）与 persist/out；返回/落盘/base64/hash 必须同一份 CDP 原始 PNG。
- 不能用实时 JPEG 放大伪装高清；不能靠修改 dsf 得到更多像素；T3 `resize.factor` 仍 `[1,4]` 且只做事后位图处理，`bitmap-upscaled` 警告规则不变。

例：view=800×600,scale=.65 → 默认 PNG=520×390；显式 scale=1 → 800×600；scale=2 → 1600×1200；三次 viewport/scroll/DPR 与 DOM rect 读数必须不变。输出比例不改变网页可视范围。

### 6.2 P0 变更与不变项（已实现）

继续 `p=scale*runtimeDSF`，runtimeDSF=1：

```text
expectedWidth  = round(R.width*p)
expectedHeight = round(R.height*p)
1 <= expectedWidth,expectedHeight          # 新增：任一轴 <1 → INVALID_ARGUMENT(empty-output-dimensions)
expectedWidth*expectedHeight <= 16000000
```

`region.width/height` 仍 ≥1 CSS px。低比例配极小 region 会在派发前被 `hasPositiveOutputSize()` 拒绝（不偷偷升到 1px、不发送非法 clip）。实测（`capture-p0.js` 注释与套件）clip.scale=0.1/0.5/0.65/1.11 时 PNG 尺寸精确等于 `round(css×scale)`，取整发生在 clip 的 CSS 尺寸上，因此 P0 严格尺寸容差仍为 0。

返回保留 `capture.version=1`、旧字段与安全落盘规则；本轮加法字段：

```text
capture.request.scale             # 已解析本次比例
capture.request.scaleSource       # "explicit" | "view"
capture.request.viewRevision      # 默认比例读取时的 view 版本（显式时亦记录）
capture.mapping.cssPerPixel       # {x:R.width/PNG.width, y:R.height/PNG.height}（真实 PNG 尺寸派生）
capture.mapping.scrollAtCapture   # {x,y}
capture.mapping.formulas.continuous
```

原 `mapping.pixelsPerCssPixel` 保留为**名义密度** p，imagePixels 来自校验后的实际 PNG。连续点到 CSS 的统一式：

```text
docX = R.x + imageX * R.width  / actualPngWidth
docY = R.y + imageY * R.height / actualPngHeight
viewportX = docX - scrollAtCapture.x
viewportY = docY - scrollAtCapture.y
```

PNG 结构/CRC、16M 预算、空白统计、0600/no-clobber、默认暂存与 persist/out/env、附件元数据比较、provider 可见性边界与 networkWindow 不变；新增字段全部是 lossless JSON。

### 6.3 T3 不改的部分

T3 mapping 已用实际 PNG 宽高计算 `cssPerPixel`，直接支持 scale<1；crop/resize 后的 mapping 派生、PixelRect/Point 的完整图坐标、find `documentCss`、baseline mapping 兼容检查、act CSS 派发都沿用。live size check 仍保留既有逐轴 ±1（不反向用于 P0）。必须改的只有 source validator、缺省 scale 的保留与 Host 二次 resolve、能力声明和测试——本轮已完成。T2 bbox、`browser_input` 的位置/滚轮单位仍为 CSS；不乘 `view.scale`，T2 语义未变。

## 7. `browser_viewport` 工具（已实现）

工具面 **29 → 30**，能力 ID `web.t1.viewport`。注册 schema `additionalProperties:false`、`required:["action"]`；条件约束（get 不接受其他字段、set 至少一个 view 字段、mode 与宽高互斥）在执行期校验。注册 schema 只用类型/枚举/描述（宿主 `assertSupportedJsonSchema` 白名单不含 `minimum/maximum`），**范围一律在执行时校验**。

```json
{
  "type":"object","additionalProperties":false,"required":["action"],
  "properties":{
    "action":{"type":"string","enum":["get","set"]},
    "mode":{"type":"string","enum":["wide","landscape","tablet","phone"]},
    "x":{"type":"number"},
    "y":{"type":"number"},
    "width":{"type":"integer"},
    "height":{"type":"integer"},
    "scale":{"type":"number"},
    "expectedRevision":{"type":"integer"}
  }
}
```

| action | 语义 / 运行边界 | 返回业务体（另附 action envelope） |
| --- | --- | --- |
| get | **只读缓存诊断**；不接受其他字段；包装器用 `readOnly(args)` 在 `run()` 之外执行：不 ensure、不发 CDP（含 Page.bringToFront）、不 claim/续 lease、不进队列、不改 recent/error；resolve scope 可创建 cold Runtime 容器但不创建 page/profile | `{ok:true,running,view,observed,viewMeta}`；可在他人持租约时读取，stale 明示 |
| set | 至少一个 view 字段；mode 与 width/height 互斥；preflight 在队列外；进页面队列后 claim/ensure（scale-only 也算页面操作） | `{ok:true,requested,before,view,observed,viewMeta,applied:true,settled,clamped:{x,y},overrideApplied,appliedFields}` |

`browser_state` 继续提供运行态、地址/标题、控制权、旧 `viewport`，并新增安全 `view` 缓存投影；不承担"保证新鲜"的接口，不增加设置参数。需要确定更新后事实的调用用 `set` 的读回。未来若要 fresh get，须另立显式页面操作，不能悄悄把诊断 get 改成 ensure/租约操作。

### 7.1 错误表

错误沿用 `BrowserError`/envelope，不新增工具 `{ok:false}` 分支；HTTP 使用既有 code→status 映射。

| code | 分类 / 重试 | 触发与副作用 |
| --- | --- | --- |
| INVALID_ARGUMENT | input / false | 非有限、类型错误、null、越界、未知字段、空 patch、非法 action/mode、mode+尺寸；预检零 CDP/启动/落盘 |
| **VIEWPORT_CONFLICT**（新增） | state / true | expectedRevision 与队列内当前版本不同；返回 `expected/actual/view` 安全数值，不应用 patch；HTTP **409**；不覆盖 page lastError |
| BUSY | existing / true | set 遇其他 Agent owner；零应用；get 仍能诊断读取 |
| UNSUPPORTED | existing / false | 必需 css layout metrics 不支持，不能证明 CSS 坐标；含安全 `phase/reason` |
| CDP_TIMEOUT / CDP_DISCONNECTED / ABORTED | existing | 保留分类、部分应用事实与现有关闭清理，不能重包成 INVALID_ARGUMENT |
| RUNTIME_LIMIT / SCOPE_* | existing | 按现有 scope/实例配额契约；不向调用者泄露路径或其他 scope 状态 |
| CAPTURE_* / INVALID_PNG / OUTPUT_* | existing | 属后续截图，不是 viewport set 的自动副作用；沿 P0 原义 |

### 7.2 能力与 limits（已实现）

`browser_capabilities` 继续完全诊断，不启动、不采样。新增 `viewport` 段与 `limits.viewport`，工具表列 30 项；`web.t1.viewport` 在另一 owner 持租约时与页面类一起报 `unavailable`+BUSY（reason 明示"get 仍可只读诊断"）。

```text
viewport={version:1,tool:"browser_viewport",coordinateSpace:"document-css-px",
  get:{readOnly:true,lazyStart:false,lease:false,fresh:false},
  set:{lazyStart:true,lease:true},
  deviceScaleFactor:1,pageZoomChanged:false,
  presets:{wide,landscape,tablet,phone},
  default:{width:1280,height:800,x:0,y:0,scale:1},
  scaleRange:[0.1,2],
  observed: null | {revision,source,observedAt,stale}}
limits.viewport={version:1,width:[200,4096],height:[200,4096],scroll:[0,10000000],
  scale:[0.1,2],default:{...},presets:{...},
  scrollPollMinMs:200,staleAfterMs:1000,settleMaxMs:1000,
  deviceScaleFactor:1,pageZoomChanged:false}
capture.defaultScaleSource="view.scale"
capture.defaultScale=1                       # cold fallback，不再是 scaleMin
capture.scaleRange=[0.1,4]; capture.viewScaleRange=[0.1,2]
limits.capture={scaleRange:[0.1,4],defaultScaleSource:"view.scale",defaultScale:1,
                minOutputPixels:{width:1,height:1},...}
```

`limits.viewport` 的 `width/height` 是范围数组（覆盖旧的当前尺寸对象）；旧消费者若把 `limits.viewport` 当 `{width,height}` 数字对象需改读 `capture`/`state`。vision `Source.live` 同步 `scaleRange:[0.1,4]` 与"省略跟随 view.scale"，resize 因子不变。capabilities 的 observed 只来自真实操作/采样。

## 8. 验收（同一最终代码，已执行）

### 8.1 Host + 真实 Chromium：`node tests/acceptance/viewport.mjs`

**probes 11/11、requiredChecks 107/107、failedChecks 0、findings 1（info）、exit 0** — Lead 终验 `tests/acceptance/runs/viewport-2026-11-01T16-19-36-641Z-564516/report.json`；执行者连跑两次同结果（`...16-13-39-758Z-559039`、`...16-13-53-771Z-559488`）。

| probe | 覆盖的契约条目 | 结果 |
| --- | --- | --- |
| V1-tool-surface | H1 注册面/能力项/无原始 CDP 工具 | PASS（6 项） |
| V2-cold-diagnostics | H1 cold get/capabilities 不启动、null 观测与 stale 可见 | PASS（8 项） |
| V3-patch-semantics | H2 四 preset 与派生、partial patch 保留、`mode` 与同传 x/y/scale 一起生效、同值不增 revision、两 scope 独立、非法参数零 CDP | PASS（23 项） |
| V4-scale-only | H3 scale-only 不改布局、override 计数不增 | PASS（13 项） |
| V5-scroll | H4 x/y 实测、clamp、单轴保留、resize 后 clamp | PASS（5 项） |
| H4b-scroll-echo | §3.2 页面自主滚动回显（source=page、revision+1、无空闲高频采样） | PASS（11 项） |
| V6-conflict-busy | H5 CAS 冲突、BUSY、他人持租约时 get 可读 | PASS（6 项） |
| V7-http | H6 legacy 兼容、v1 严校验、`ui.view` 投影 | PASS（14 项） |
| V8-capture-scale | H7 默认/显式比例尺寸、mapping、低比例拒绝、16M 预算 | PASS（10 项） |
| V9-t3-live | H8 T3 live 缺省比例、act 冻结原比例 | PASS（5 项） |
| V10-ui-projection | H10 lossless JSON、close 清 observed/x/y | PASS（6 项） |

**NOT_RUN（Host 侧）**：H9 screencast ACK/帧递增时序。

**真实宿主复验（2026-11-02，用户重启 3080 后）**：`dsh web` pid <pid>（01:28:05 启动）的真实 Agent 会话报告 30 工具与 `ui.view`，并实测：get 缓存诊断（`stale`/`originId:null`）、set 宽高+X/Y（回读 `mode:landscape`/`settled:true`/页面真值 1024×768、DPR 1、scrollY 120、zoom 1）、scale-only 不改几何且默认截图 666×499（`scaleSource:"view"`）、显式 scale=1 → 1024×768、`VIEWPORT_CONFLICT` 零应用、5 例 `INVALID_ARGUMENT`、tablet/wide 预设与 `mode+同传 x/y/scale`、y clamp 1520、页面自主滚动回显 `source:"page"`；截图 region 纯红 `maxDelta:0`、T3 live 默认比例 960×540。**面板交互（X/Y/滚轮/fit/命中映射/帧屏障）仍未验证**（只确认下发的 bundle 含客户端切片）。记录见 [viewport-real-host-2026-11-02.md](../tests/acceptance/evidence/viewport-real-host-2026-11-02.md)。`mode` 与同传 x/y/scale 的断言已在 V3 内通过。

### 8.2 隔离 DSH + GUI：`node tests/acceptance/viewport-gui.mjs`

**142/142 PASS、0 FAIL、5 NOT_RUN、exit 0**（2026-11-02 画布 v2）— Lead 复跑 `tests/acceptance/runs/viewport-gui-2026-11-01T20-07-15-023Z-753710/run-report.json`，证据 `tests/acceptance/evidence/viewport-gui-2026-11-01T20-07-15-023Z/`（9 张 PNG + `SUMMARY.md`）；含 V12 拖拽 12 项 + V13 画布 41 项。拖拽前的 73/73 PASS 记录（`runs/viewport-gui-2026-11-01T16-25-59-658Z-576275/run-report.json`，执行者 `...16-09-04-966Z-554236`、`...16-10-07-443Z-555424`）保留为历史。

覆盖：V0 隔离实例与本仓库构建指纹（隔离端口、token 不落 GUI/log、3080/3081 未触碰、加载的 bundle 含尺寸栏/X-Y 代码）、V1 面板与五个输入框（含精确 aria-label）与窄面板不溢出、V2 `ui.view` 字段与范围、V3 首次绑定只推一次 393×852 且用 v1 形状、V4 页面 CSS 视口=Host 尺寸且 DPR=1、V5 十五项滚轮（步长/Shift/Alt/Alt 优先/合并/不滚动宿主/不误发目标页/delta=0/Ctrl/Meta/边界 clamp）、V6 X/Y 提交与 Escape 恢复与页面自主滚动回显（V6.4/V6.4b/V6.4c）、V7 Host 侧 mode/x/y/scale 与 fit 取消与导航不隐式写、V8 fit<100% 与 200% 的真实命中（isTrusted、映射 clientX/Y）与框外零派发、V9 画面滚轮 W/Pw 缩放、V10 全程无页面异常/DPR 未被动/范围收敛、V11 窄面板 flex-wrap、**V12「拖拽」模式**、**V13 画布 v2（2026-11-02）**：ui.canvas 握手、负 canvas 输入/滚轮、O=0 无位移、四边纯白 blank、内容点击 `p=q+O`、blank 零派发、帧/滚动 fail-closed、拖拽进入负 C、空白 overlay 拖回、seed 刷新/过期丢弃/缺 provenance/fail-closed、旧 Host/无 canvas 回退、canvas 与 x/y 不混传。

**5 条 NOT_RUN（原样保留，不算通过）**：

| ID | 原因 |
| --- | --- |
| V7.10 | `view.source=agent` 归因：GUI 只能走 HTTP v1 路由，Host 记为 `source=gui`；agent 归因由 Host 侧（H2）覆盖 |
| V8.5 | letterbox 零派发：该帧 painted rect 填满容器，没有 band 可点（`band:0`） |
| V10.4 | 旧 Host 降级（X/Y 禁用、legacy `{width,height}`）：套件只启动带 `ui.view` 的新 Host |
| V10.5 | `expectedRevision` 冲突处理：并发/CAS 属 Host 切片（H5），GUI 只断言 patch 携带 `expectedRevision` |
| V10.6 | 宽高变更后的几何屏障只到 best-effort（帧协议未扩展，≤250ms，文档记 partial） |

### 8.3 回归与证据台账

Lead 终验（终版代码，2026-11-01 16:19–16:45，串行单驱动者）的全量回归结果——同一套件、同一代码，全部 exit 0：

| 套件 | 结果 | 报告 |
| --- | --- | --- |
| `run.mjs`（T1） | 23/23 probes、**349/349** required、0 failed、exit 0（P21 loadingFailed flake 本轮未复现） | `runs/2026-11-01T16-43-50-413Z-599293/run-report.json`（画布 v2 回归报告待 task-5 更新） |
| `capture-p0.mjs` | 15/15 probes、**162/162** required、0 failed、exit 0 | `runs/capture-p0-2026-11-01T20-18-32-415Z-768943/report.json` |
| `t2-structured.mjs` | 38 probes：37 PASS / 0 FAIL / 1 NOT_RUN（C38 套件边界）、**261/261** required、exit 0 | `runs/2026-11-01T16-41-28-155Z-593638/run-report.json` |
| `t3-vision.mjs` | criteria **56/56**、**415/415** required、failedChecks 0、notApplicableChecks 3、exit 0 | `runs/2026-11-01T20-18-56-169Z-770336/run-report.json` |
| `network-p0.mjs` | criteria **52/52**、**266/266** required、failedChecks 0、notRunChecks 8、exit 0 | `runs/2026-11-01T16-43-03-471Z-597623/run-report.json` |
| `network-chain.mjs` | criteria **12/12**、49 required、0 failed、1 NOT_RUN、exit 0 | `runs/2026-11-01T16-43-43-439Z-598890/run-report.json` |
| `workspace-isolation.test.mjs` | **77/77**、exit 0 | `runs/workspace-isolation-1793550357248/report.json` |
| `runtime-faults.test.mjs` | **16/16**、exit 0 | `node --test`（无 JSON 报告） |
| `viewport-gui.mjs`（拖拽前，2026-11-01） | **73/73 PASS**、0 FAIL、5 NOT_RUN、exit 0 | `runs/viewport-gui-2026-11-01T16-25-59-658Z-576275/run-report.json` |
| `viewport-gui.mjs`（拖拽轮，2026-11-02） | **85/85 PASS**、0 FAIL、5 NOT_RUN、exit 0 | `runs/viewport-gui-2026-11-01T18-11-12-661Z-654115/run-report.json` |
| `viewport-gui.mjs`（画布轮，2026-11-02） | **142/142 PASS**、0 FAIL、5 NOT_RUN、exit 0 | `runs/viewport-gui-2026-11-01T20-07-15-023Z-753710/run-report.json` |
| `check-skill.mjs` / `check-skill-registry.mjs` | **30/30** / **19/19**、exit 0 | 结构/注册检查（无 JSON 报告） |

T3 的 3 条 NOT_APPLICABLE（不算 PASS）：`dom-fractional-clientxy`（Blink 整数截断）、`inert-hit-test-vision`（真实浏览器 hit-test 不返回 inert 子树）、`page-drag-truth`（ABORTED 已关页，页面级 downs/ups 不可读）；C50 曾出现的失败是测试共享时间戳累计 >1000ms 的时序假象，已改为每 case 现取 context（只改测试，`index.js` 未动）。完整记录见 [status.md](status.md)「Lead 独立终验」。新增/调整的旧断言保留了显式 scale=1 回归（没有删旧高密度/CRC/预算断言来凑通过）。

必须继续记为 NOT_RUN，直到有对应证据：

- **真实宿主（3080）**：2026-11-02 01:28 重启后，30 工具、`ui.view` 与 `browser_viewport` 的 Agent 侧已复验（见 §8.1）；**面板交互（X/Y/滚轮/fit/命中映射/2026-11-02 的拖拽）仍 NOT_RUN**，隔离 DSH GUI 结果不能替代真实面板操作。
- **H9 screencast 帧密度/ACK 时序**：未单独实测；用户提供的 DPR=2 实验结论仍只是外部事实，本轮未复测。
- **GUI 5 条 NOT_RUN** 的归属（§8.2 表）。
- **provider 图像可见性**：附件元数据不能证明模型收到原分辨率图像。
- 实时 1600×1200 上限下大 viewport 降采样、页面瞬时布局影响、scroll snap/RTL/visual viewport ≠1、provider 最终图像尺寸：无专项实测前仍标 partial/NOT_RUN；宽高变更后的帧几何屏障只有 best-effort（§5.4）。

本轮已收口的一个实现偏差：Host 侧 `expandViewPatch` 曾丢弃 `mode` 同传的 `x/y/scale`，task-7 已改为透传并在 `viewport.mjs` 的 V3 内增 6 项断言（17 → 23），**不改 UI/API 语义**；修复后的计数就是上面的 11/11、107/107。

## 9. 风险、恢复与文件交接

| 风险 | 限制 / 缓解 / 恢复 |
| --- | --- |
| scale<1 丢失细节及 0 像素/取整 | 显式高密度 region 供精细检测；最小输出 ≥1 提前拒绝；不改 DPR 或 viewport 兜底 |
| fit 反馈与多面板竞争 | adopt 不触发 write、阈值 + 120ms debounce、自 ACK 识别、外部 set 取消 fit、CAS；冲突后读缓存并等待新的明确提交 |
| Agent/GUI 并发与旧 client | page 队列 + Agent lease + expectedRevision；旧 client 无 CAS 仍可能覆盖宽高，升级所有打开的面板后再验同步；不把客户端 ID 当权限 |
| screencast 被 1600×1200 降采样 | 页面 CSS 尺寸与 JPEG 自然尺寸分别保存，按 painted rect 映射；放大面板允许像素粗糙，高清检测走 PNG |
| 旧帧配新 viewport | 输入前几何/时间屏障（≤250ms，best-effort）；无法证明就暂停输入，不靠宽高相似猜已刷新；**帧协议未扩展** |
| 映射边界、DPR 与 letterbox | 连续坐标、半开区间、release 保证、宿主 CSS 坐标不乘 DPR；用页面事件真值验证 |
| 页面自主滚动/snap/RTL | metrics 唯一事实源、stale 与 settled 明确；非负 set 不代表 RTL 全支持；不用页面事件监听器覆盖业务滚动 |
| 高倍资源预算 | 最大 4 仍受 16M 约束，4096²@1 已超 16M 须拒绝截图但可设置 viewport；set 不承诺之后截图必成功 |
| 部分 CDP 成功/取消 | 回实际状态及 phase；取消沿现有关闭清理；不自动回滚或重放未知已应用输入 |
| 文档/工具台账漂移 | 主文档、Skill、manifest、台账与计数同一轮同步；真实宿主 30 工具与 provider 能力另证 |

### 9.1 本轮切片与写入范围（已完成）

- **Host 切片**：`index.js`（view/metrics/apply/HTTP/ui 投影、注册包装器按 action 分类、新工具与 capabilities、P0 默认解析、T3 live 缺省与冻结 scale）、`browser-safety.js`（VIEWPORT_CONFLICT）、`capture-p0.js`（scale 下界/空输出/公开 mapping）、`vision-t3.js`（live validator 缺省与范围）。
- **Client 切片**：`client.js` 尺寸草稿/远端采纳/X-Y/滚轮、fit 权属与保护、单一 painted rect 映射、导航链停止隐式覆盖、显示帧几何关联；transport 实时职责与 scope 隐藏停播不变。
- **帧协议**：本轮**未改** `frame-source.js`/`frame-push.js`（Lead 裁决不扩协议，按 best-effort 屏障实现）。
- **文档/Skill/清单切片**：本文、[状态](status.md)、[运行时](runtime-t1.md)、[契约](t1-m0-m2-contract.md)、[已知缺口](t1-known-gaps.md)、[架构](architecture.md)、[UI 规格](ui-spec.md)、[验证](verification.md)、[索引](index.md)、两份 README、[Skill](../skills/ui-testing/SKILL.md)、[manifest](../skills/ui-testing/manifests/declared-capabilities.json)、[能力台账](../skills/ui-testing/knowledge/web/t1-capability-ledger.md)、`check-skill*.mjs`。

### 9.2 Lead 冻结的裁决（原待裁决项 → 已裁决）

| # | 原问题 | 裁决（已实施） |
| --- | --- | --- |
| 1 | scale 范围与 GUI 上限 | **0.1–2.0（10–200%）统一为 view.scale 与 GUI 手动范围**；显式截图 scale 仍允许 0.1–4，高分屏/高密度检测用显式值，不要求 GUI 能显示 400% |
| 2 | 原始高清保留 | **单张原始 PNG + 显式 scale(1/2–4) + persist/out**；不做同次低清/高清双表示，不隐藏第二次 capture |
| 3 | 首次绑定与 fit 默认 | **采纳 Host 值；仅当 Host `source==='default'` 时推送一次本地默认 393×852@100%**；fit 是本地显示偏好、默认勾选但不发布，Agent/其他面板变更时取消 |
| 4 | get/set 分类 | **get 只读缓存诊断（不 ensure/CDP/租约）、set 页面操作（含 scale-only）**；由注册包装器的 `readOnly(args)` 与 `preflight(args)` 落实 |
| 5 | 并发保护 | **expectedRevision CAS + VIEWPORT_CONFLICT（HTTP 409）**；Client 只发 `expectedRevision`，`originId` 保留为可选诊断字段但本轮未使用（`viewMeta.originId` 恒 null）；冲突不自动重放，page 自主滚动也会让旧 revision 失效 |
| 6 | 帧尺寸变更屏障 | **不扩帧协议**：用现有帧元数据/解码尺寸做 ≤250ms best-effort 屏障，文档与报告按 partial 记录（GUI V10.6 NOT_RUN） |
| 7 | （实现期发现）mode 与 x/y/scale 同传 | 契约要求 mode 展开宽高后**其余字段仍生效**；`expandViewPatch` 曾丢弃同传字段，task-7 已修复为透传，并在 `viewport.mjs` V3 增 6 项断言（17 → 23）。修复后 Host 套件 11/11、107/107、exit 0；不改 UI/API 语义 |
