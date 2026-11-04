# T1/T2 运行时：内嵌无头 Chromium 与预览帧管线

> 索引：[docs/index.md](index.md) · 2026-10-31 实现；帧管线调整为 2026-10-31；共享视口（`/viewport` v1、`ui.view`、`browser_viewport`）2026-11-01 加入，契约见 [viewport-control.md](viewport-control.md)

Host 起**真正的无头 Chromium**，用 CDP 驱动；同一时刻最多一个 Chromium/profile，但按 DSH 工作区创建独立 page target（每页独立 URL/viewport/history/网络缓冲/队列/租约）。画面通过各自的 `Page.startScreencast` JPEG 帧回到对应面板，用户输入经该工作区 page 的 CDP 派发。窗口从不显示，因此**不会抢焦点**。Cookie/localStorage/cache 仍共享，不是安全隔离；完整契约见 [workspace-isolation.md](workspace-isolation.md)。

画面采集是 **CDP 事件驱动**：页面发生 damage 时 Chromium 才发帧，不是固定帧率采样。客户端传输优先走**同源 WebSocket 服务端推送**，失败或断开时自动回退到原有 `GET /frame` HTTP 轮询；两种传输共用同一份"最新帧"缓存与元数据。

## 结构

```text
Host (index.js + frame-source.js + frame-push.js)     Client (client.js)
├─ spawn chrome --headless=new（单 Host/profile）       ├─ createFrameTransport(scope)
├─ BrowserHost：owned/pending/autoattach/closing       │   ├─ WS 优先（服务端按 scope 推帧）
├─ 每工作区 Runtime：独立 page target + page-level CDP  │   └─ 80ms /frame 轮询回退
├─ 每 Runtime：FrameSource（seq/epoch/时间戳/计数）     ├─ <img> 渲染 Blob URL（object-fit: contain）
├─ FramePush hub（同源 WS，40ms 合并、背压丢帧）        ├─ 指针/滚轮/键盘 → POST /input（带 scope）
├─ Network.enable → 每页请求环形缓冲                    ├─ 地址 → /navigate；刷新 → /reload；后退/前进 → /history
├─ 第 8 轮网络 P0：Runtime 级全事件采集 + network-p0.js  │   （网络能力只走 Agent 工具，无新面板路由）
├─ Runtime.evaluate / DOM / CSS（每页）                ├─ /state 每 500ms（已认证 GUI 带 ui.address/ui.history/ui.view/scope）
├─ 每 Runtime 一份 view（宽高/x/y/比例/来源/版本）      ├─ 尺寸栏 X/Y/宽高/比例（滚轮、120ms 合并、fit 本地）
└─ HTTP 路由 /plugins/ui-testing/*（按 scope 选实例）   └─ /metrics 每 2s 上报实测显示指标（viewer 心跳）
```

**网络采集（第 8 轮补充）**：除既有 `Network.enable` 元数据环形缓冲（旧 `browser_network` 仍用它）外，Runtime 另建一套按 scope 隔离的网络事件库——`Network.*` 全事件、`Fetch` 单一 dispatcher、按需 `getRequestPostData/getResponseBody`、`Target.setAutoAttach` 子目标；纯逻辑（标准化/配额/分析/链路/规则/导入导出/订阅）在 `network-p0.js`。它**不新增面板 HTTP 路由、也不改 `client.js`**：只经 7 个 `browser_network_*` 工具访问，权威契约见 [network-p0.md](network-p0.md)。

## 帧管线

- **采集**：`Page.screencastFrame` → `FrameSource.accept()`；每帧记录 `seq`、`epoch`、`capturedAt`（CDP 秒 → epoch 毫秒）、`receivedAt`、`width/height/pageWidth/pageHeight`、`format`。收到即 `Page.screencastFrameAck`，ack 失败计数进 `/metrics`。
- **缓存**：只保留最新一帧（last-writer-wins）。慢消费者不会看到积压帧，因此预览延迟不会随轮询/渲染变慢而持续增长。
- **页面切换**：主 frame 的 `Page.frameNavigated` 让 `FrameSource.epoch + 1`；传输侧丢弃旧 epoch 的排队帧（`stale` 计数），客户端也忽略旧 epoch 帧。
- **推送（WebSocket）**：`frame-push.js` 通过单个 `ctx.webServer.registerUpgrade()` dispatcher 自实现 RFC 6455 握手（无第三方依赖），按 scope 绑定 `createFramePusher`；每工作区独立 clients/背压/统计，hello/二进制头带 `scopeId/runtimeId`。最新帧合并推送，最小间隔 40ms；`socket.write` 背压时丢帧并计数，绝不排队；客户端不需要逐帧 ACK。
- **回退（HTTP 轮询）**：`GET /frame?since=N` 保持兼容；无新帧返回 `{pending:true}`。WS 未连上或断开时客户端自动轮询，重连退避 0.8s→15s。
- **资源释放**：`/close`/插件卸载时关闭全部 WS 客户端、`Page.stopScreencast`、清空帧缓存/网络缓冲/运行态，等待 Chromium 退出（SIGTERM → SIGKILL 兜底）并同步删除临时 profile；启动失败路径也会清理已 spawn 的进程与 profile。

## HTTP 接口

> 这些都是**同源 HTTP 路由**；`webServer` 层不做登录鉴权，默认只监听 loopback。Agent 侧只应使用 30 个结构化工具（10 T1 + 7 T2 + 6 T3 + 7 network），不应直接调这些路由。M0–M2 现行契约与待验收项见 [t1-m0-m2-contract.md](t1-m0-m2-contract.md)，网络 P0 契约见 [network-p0.md](network-p0.md)，按工作区 scope 见 [workspace-isolation.md](workspace-isolation.md)。HTTP 错误保留 `error` 字符串并新增 `code/category/retryable`。

**工作区 scope（第 5 轮）**：scoped HTTP 发 `X-UI-Testing-Scope-Version: 1` + 三选一 identity（`-Session-Id` / `-Scope: recent|unassigned` / `-Scope-Binding: <runtimeId>`）；WS 用 `?scopeVersion=1&sessionId=…` / `&scope=…` / `&binding=…`。无 scope 版本是 `legacy:default`。scoped 请求严格 owner-only（`connection.admit` + `browserPeer`），先鉴权后解析、零副作用；unknown session/binding 404、存储故障 503、非 owner 403、满 8 page `RUNTIME_LIMIT` 503。state/ui/工具结果带不含绝对路径的 `scope`。

**鉴权与原始地址边界（2026-10-31）**：GET `/state`、GET `/frame`、POST `/ensure`、`/navigate` 的响应统一经同一投影——`ctx.get('connection')` 存在且 `requestRejection(req)` 明确返回 `undefined`（已认证同源 GUI）时返回 HTTP 专用 `uiState()`（含未脱敏 `ui.address` 与 `ui.history`）；服务缺失、抛错、401/403 一律只回既有脱敏 `state()`（fail closed）。`/reload`、`/history` 只服务已认证 GUI，未认证直接 401/403，错误体沿用 `{ok:false,error,code:'UNSUPPORTED',category:'capability',retryable:false}`，不写入页面 `lastError`。原始地址不会进入 `browser_state` 工具值、网络记录、`/metrics` 或 WS 头；HTTP UI state 响应带 `Cache-Control: no-store`，不加宽泛 CORS。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/plugins/ui-testing/ensure` | 启动浏览器；可选 `{url}` 直接打开 |
| POST | `/plugins/ui-testing/navigate` | `{url}`，HTTP(S) 目标、DNS 与最终 URL 校验；Document 请求/重定向继续拦截；不保证加载完成 |
| POST | `/plugins/ui-testing/reload` | 刷新当前文档（`Page.reload({ignoreCache:false})`）；不读客户端 URL，未运行 → `TARGET_NOT_FOUND`，不懒启动；先装主框架提交等待器再发送，10s 无提交 → `CDP_TIMEOUT`；需已认证 GUI |
| POST | `/plugins/ui-testing/history` | `{direction:'back'\|'forward'}`；队列内先 `Page.getNavigationHistory()`，`currentIndex±1` 的 `entries[i].id` → `Page.navigateToHistoryEntry({entryId})`；越界返回 `moved:false` 且零派发，非法 direction → `INVALID_ARGUMENT` 零派发；需已认证 GUI |
| POST | `/plugins/ui-testing/viewport` | 双形状：legacy `{width,height}`（Number/round/clamp，保留 x/y/scale）或 v1 `{version:1,...patch,expectedRevision?,originId?}`（与工具同严格校验）；响应对两者都带 `view/observed/viewMeta/requested/clamped/applied/settled/state`，`VIEWPORT_CONFLICT → 409`（见下） |
| POST | `/plugins/ui-testing/input` | `{events:[…]}`，mouse / wheel / key / text |
| POST | `/plugins/ui-testing/eval` | `{expression}` → `{ok,value,type}` |
| POST | `/plugins/ui-testing/screenshot` | → `{image: base64 PNG}` |
| POST | `/plugins/ui-testing/close` | 关闭浏览器并清理临时 profile、WS 客户端、帧缓存 |
| GET | `/plugins/ui-testing/frame?since=N` | 轮询回退：无新帧 `{pending:true}`，否则 `{seq,epoch,transport:"poll",image,capturedAt,receivedAt,width,height,…,state}`；`pending` 与有图两个分支的 `state` 同形 |
| GET | `/plugins/ui-testing/state` | 保留 `mode/activity/url/title/viewport/seq/running/error` 与 owner 诊断字段，新增安全 `view`、`canvas` 与**标注文档 `annotations`**（P0-D v2：Agent 可见的面板标注，`browser_state.annotations` 同源）；已认证 GUI 额外带 `ui`（含 `ui.view/ui.viewMeta/ui.observed`、`ui.annotations` 与 `ui.annotationContext`，见下） |
| POST | `/plugins/ui-testing/annotations` | P0-D v2 面板标注上报（唯一写面）：仅认证 scoped；body ≤262144 bytes；严格白名单/校验；旧 `documentKey` → 409 `annotation-context-stale` 零写入；ACK `{ok,accepted,ignored,clientRevision,annotations}`；不新增工具（见 [annotation-p0d.md](annotation-p0d.md) §11） |
| GET | `/plugins/ui-testing/metrics` | host 采集/推送/丢帧/ackFailures/captureFps + 最近一次 client 实测指标 |
| POST | `/plugins/ui-testing/metrics` | 客户端上报 `{transport,displayFps,endToEndMs,transportMs,droppedClient,received,displayed,seq,epoch,measuredAt}` |
| GET（Upgrade） | `/plugins/ui-testing/frames` | WebSocket 推帧；升级前经 `ctx.get('connection').requestRejection(req)` 鉴权，无 connection 服务时只允许 loopback |

### GUI 地址栏与导航历史投影

已认证 GUI 的 `state`/`frame.state`/`ensure`/`navigate` 响应在既有字段上追加：

```text
ui: {
  version: 1,
  runtimeId: "<一次 Host 插件生命周期内固定>",
  revision: <每个 HTTP 快照 +1 的顺序号>,
  address: "<主框架真实 location.href，含 query/hash；停止时 ''>",
  history: { available, index, length, canGoBack, canGoForward }   // 停止/查询失败时 available:false、index:-1、length:0
}
```

- `history` 是浏览器 CDP 历史（`Page.getNavigationHistory`）的聚合投影：`length=entries.length`、`index=currentIndex`，`canGoBack = index>0`、`canGoForward = index>=0 && index<length-1`；**不返回 entries/entryId/title 列表**。查询失败按 `available:false` 处理，不能当"只有一条历史"。`/reload`、`/history` 的成功响应带同一 `ui`。
- 客户端所有快照（`/state`、`/frame`、导航响应）走单一 `acceptRemote(state)`：v1 按 `runtimeId`+`revision` 排序，同 runtime 较小 revision 丢弃；切换 runtime 清空地址来源并记住退役 `runtimeId` 丢弃迟到响应；轮询请求带客户端 `requestGeneration`，导航动作提交前递增，先前发出的响应不能覆盖提交后的地址。
- 停止（`/close`）后 `address=''`、history 全部禁用；`runtimeId` 不变、`revision` 继续递增，避免旧读回重填地址。

### 共享视口：`/viewport` v1、`ui.view` 与实时观测

权威语义见 [viewport-control.md](viewport-control.md)。每个工作区 Runtime 持有 `view={version:1,mode,x,y,width,height,scale,source,revision}`，顶层 `viewport={width,height}` 是它的 getter 别名；面板与 Agent 读写同一对象。

```text
ui: {
  version: 1, runtimeId, revision, address, history:{…},
  view:     {version:1,mode,x,y,width,height,scale,source,revision},
  viewMeta: {runtimeId,observedAt:null|ms,stale:boolean,originId:null|string},  # originId 本轮恒 null（面板不发，见下）
  observed: null | {x,y,width,height,contentWidth,contentHeight,
                    pageDevicePixelRatio,visualViewportScale,observedAt,
                    source:'Page.getLayoutMetrics'}
}
```

- **坐标与尺寸**：`x/y` 是文档 CSS px 的页面顶层滚动位置，来自 `Page.getLayoutMetrics.cssLayoutViewport.pageX/pageY`（不是窗口位置，也不是缓存页面值）；**`canvasX/canvasY` 是画布 v2 的视口原点（±1e7，可为负；面板 X/Y 绑定它）**；`width/height` 是 CSS viewport（整数 200–4096）；`mode` 由宽高精确匹配派生（custom 只作返回值）。`Runtime.evaluate` 只用于 instant `scrollTo` 与 DPR 读取。
- **比例**：`scale` 0.1–2（10–200%）是面板显示比例与"省略 scale 的截图默认密度"；页面 CSS 视口、DPR（固定 1）、页面 zoom 与布局都不受影响。只有显式改宽高才发 `Emulation.setDeviceMetricsOverride({deviceScaleFactor:1,mobile:false})`。
- **HTTP 双形状**：legacy `{width,height}` 保持旧的 Number/round/clamp 与 `viewport` 返回（`source` 记 `gui`）；v1 使用与工具相同的严格校验（`version` 只接受 1；`originId` 为**可选诊断字段**、≤64 可打印 ASCII，**本轮面板不发送**，因此 `viewMeta.originId` 恒为 null，不承担鉴权/scope/租约语义），响应对两种形状都带 `view/observed/viewMeta/requested/clamped/applied/settled/state`。冲突映射 `VIEWPORT_CONFLICT → 409`，其余沿用既有 code→status 映射。
- **谁会被投影**：认证 `/state`、`/frame` 的 state、`ensure`/`navigate`/`reload`/`history` 响应都附 `ui.view/ui.viewMeta/ui.observed`；`browser_state` 工具返回同一份安全 `view`（无页面文本、无路径），但**不保证新鲜**——需要确定更新后事实时用 `browser_viewport set` 的读回。
- **实时观测的触发与节流**：成功 set 自带两帧 + 最多 1000ms 的有界稳定读回（`settled:false` 是合法答案）；主框架导航提交、`/input` 派发后（50ms 与 250ms）、`/frame`（80ms 轮询）与 `/state`（500ms 轮询）、以及除 `browser_viewport` 外任何成功的页面操作都会调度一次读回。读回**合并、至少间隔 200ms、single-flight、事件驱动**：没有 viewer、没有动作的静止页面零 CDP 采样；缓存超过 1000ms 标 `stale:true`；后台读回只回显 x/y（`source:"page"`、revision+1），不覆盖宽高与比例；读回失败保留旧事实并标 stale，不虚构位置。
- **截图默认比例**：`browser_screenshot` 省略 `scale` 时在调用内取当前 `view.scale`（`capture.request.scaleSource:"view"`，cold 为 1），显式 `scale` 允许 0.1–4 且只影响该次截图（`scaleSource:"explicit"`）；两轴期望像素 <1 时提前 `INVALID_ARGUMENT(empty-output-dimensions)`。T3 `Source.live` 同规则（本次调用冻结一次默认值，`act` 沿用原采集比例）。
- **limits**：`browser_capabilities.limits.viewport={width:[200,4096],height:[200,4096],scroll:[0,10000000],scale:[0.1,2],default:{1280,800,0,0,1},presets,scrollPollMinMs:200,staleAfterMs:1000,settleMaxMs:1000,deviceScaleFactor:1,pageZoomChanged:false}`；`capture`/`limits.capture` 报 `defaultScaleSource:"view.scale"`、`defaultScale:1`、`scaleRange:[0.1,4]`、`minOutputPixels:{1,1}`。`viewport` 段另报 `get:{readOnly:true,lazyStart:false,lease:false,fresh:false}`、`set:{lazyStart:true,lease:true}` 与 `observed`（只来自真实读回）。

### 地址/标题/历史的同步事件

- **主框架识别**：启动后 `Page.getFrameTree()` 取主 `frame.id`；`Page.frameNavigated`（无 `parentId`）更新主框架 id、`url`（含可选 `urlFragment`）并清空旧标题、递增 metadata generation、触发帧 epoch。
- **同文档导航**：新增 `Page.navigatedWithinDocument` 监听，**仅 `frameId === mainFrameId`** 时更新 `url`（覆盖 `pushState`/`replaceState`/`hash`/popstate），子 iframe 不污染地址；same-document 不算新 epoch。
- **合并刷新**：`/state` 与 `/frame` 立即回缓存并共同调用 `refreshMetadataSoon()`：250ms 节流 + single-flight，读 `document.title`/`location.href`/`Page.getNavigationHistory`；不进入写队列、不申请租约、不懒启动。250ms 只是发起节流，不是实时 SLA；验收用 3s bounded wait 记录实际延迟。
- **防旧结果覆写**：每次读取捕获 cdp 引用与 `metadataGeneration`；主导航、写导航开始、`/close` 都递增 generation；只有 cdp 未变且 generation 未变才发布结果，过期结果丢弃并标脏，等下一次合并刷新（≤250ms）。

### 刷新/后退前进的提交语义

- 三个写入口（`/navigate`、`/reload`、`/history`）整体包在 `runtime.run()` 串行队列里（查历史→选 ID→跳转→刷新元数据都在队列内），UI 调用保持 `agent:false`：与 Agent 串行，但不 claim/续租租约，也不因 Agent 持有 owner 而禁用面板按钮。
- `Page.reload` / `Page.navigateToHistoryEntry` 的 CDP ACK **不等于提交**：发送前先安装一次性主框架 commit 等待器（reload 等 `frameNavigated`；history 等 `frameNavigated` 或主框架 `navigatedWithinDocument`），提交后重读真实 URL/标题/历史再响应，不等完整 load；10s 无提交 → `CDP_TIMEOUT`（沿用 `run()` 的超时先关浏览器再放锁语义），断连 → `CDP_DISCONNECTED`，取消 → `ABORTED`，listener/timer 全部清理。
- **写路径同步元数据**：`/navigate`、`/reload`、`/history` 都在返回前同步刷新 title+history；`/navigate` 把 title 与 history 两个读取并发发起（不增加串行往返），响应里的 `ui.history` 直接可用。跨文档提交瞬间 `Page.getNavigationHistory` 可能瞬时回 "Not attached to an active page"，写路径按 0/0/5/10/20ms 有界重试，仍失败才按"历史不可用"（双向禁用）处理；`CDP_TIMEOUT`/`CDP_DISCONNECTED`/`ABORTED` 不重试。
- 安全：reload 的当前地址与 history 目标 `entries[].url` 先过 `validateTarget`；仅"浏览器内部已有条目"的精确 `about:blank` 例外（以便回退到初始空页）。外部 `/navigate` 仍只接受 HTTP(S)。

### WebSocket 线格式

```text
文本: {"type":"hello","transport":"ws","pushIntervalMs":40,"epoch":N,"seq":N}
二进制: [uint32BE headerLen][JSON header][JPEG bytes]
header: {v:1, seq, epoch, capturedAtMs, receivedAtMs, width, height,
         pageWidth, pageHeight, format:"jpeg",
         dropped:{pushed,coalesced,blocked,stale,rejected,protocolErrors,clients}}
```

## Agent 工具

T1（10 个）：`browser_navigate`、`browser_eval`、`browser_screenshot`、`browser_input`、`browser_network`、`browser_computed_style`、`browser_http_request`、`browser_viewport`（第 9 轮新增，共享视口 get/set）、`browser_state`、`browser_capabilities`。

T2（第 6 轮新增 7 个）：`browser_snapshot`、`browser_click`、`browser_type`、`browser_scroll`、`browser_fill_form`、`browser_node_state`、`browser_wait_for`。完整契约见 [t2-structured-gui.md](t2-structured-gui.md)，实现/验收状态见 [status.md](status.md)。

T3（第 7 轮新增 6 个）：`browser_vision_image`、`browser_vision_find`、`browser_vision_compare`、`browser_vision_act`、`browser_vision_baseline`、`browser_vision_check`。完整契约见 [t3-vision.md](t3-vision.md)，实现/验收状态见 [status.md](status.md)。

`browser_viewport` 的 `get` 是**缓存诊断**（包装器按 `readOnly(args)` 在 `run()` 之外执行：不 ensure、不发 CDP、不进队列、不申请/续租租约、不改 recent/error），`set` 与其它页面工具一样走预检 → 串行队列 → 懒启动 + single-owner-lease；`expectedRevision` 冲突抛 `VIEWPORT_CONFLICT`（HTTP 409）且 patch 零应用。详见 [viewport-control.md](viewport-control.md) §7。

T2 与 T1 共用同一 Runtime/队列/租约，`browser_snapshot` 的 ref 表按 Runtime 隔离；七工具都是页面操作（懒启动 + BUSY），`browser_state`/`browser_capabilities` 与独立 HTTP 不因 T2 改变语义。`browser_capabilities` 新增 `web.t2.*` 与 `limits.structuredGui`。**本文 T2 轮快照中的“T3/T4 仍 unsupported”已被第 7 轮取代**：T3 六个视觉工具与 `web.t3.*` 已实现并验收；T4 已于 2026-11-04 实现（5 个 `browser_*` 工具，工具面 35），见 [status.md](status.md)「WEB-T4 实现」。

M0–M2 的 `single-owner-lease` 保留，但已改为**按 DSH 工作区**：页面操作与 network 先按 exec 身份解析工作区 runtime，再申请该 runtime 的租约；空闲 15s、进行中保持，同工作区其他 session 返回 `BUSY`，不同工作区互不影响。exec 身份缺失走 `legacy:default`；`agent/disposed` 只释放对应 owner。同一工作区的面板与 Agent 使用同一 page/串行队列；不同工作区 page/URL/viewport/网络缓冲独立，但 Cookie/存储共享。state/capabilities 不启动浏览器也不占租约。`browser_http_request` 仍是独立分支：不启动 Chromium、不申请/续租、不进页面队列、不建 page/entry，插件卸载时取消在飞请求。帧管线、`/metrics`、WS 都不是 Agent 工具。scope 身份、请求头/query、recent→binding 与限制见 [workspace-isolation.md](workspace-isolation.md)。

工具失败抛带 `[CODE]` 的 `BrowserError(code/category/retryable/details)`，eval/style 操作失败返回 error 对象。每次调用返回并 render `actionId/sessionId/startedAt/finishedAt/target/args` 摘要；截图保留 base64，带 `capturedAt/sha256/attachmentId`，可选附件服务保存并 render image block，无服务则明确 `base64-fallback` 文本。**工具返回值必须是 lossless JSON**（宿主会校验，含 `undefined` 属性即被判 `INVALID_TOOL_OUTPUT`），统一在 `register()` 边界做投影。已发 CDP 命令后取消会在队列内关闭浏览器再放锁，下一调用可懒启动。完整字段、错误码、实测报告及残余风险见 [现行契约](t1-m0-m2-contract.md) 与 [HTTP 契约](t1-http-request.md)：本轮计数与结论以 `tests/acceptance/runs/` 报告为准；真实宿主内第九工具的真实调用已于 2026-11-02 复验（`browser_http_request GET /health` → 200），provider 视图仍 NOT_RUN。

### P0 截图采集（`browser_screenshot`）

T1回归有既有随机P21 flake：同一行为实现仅persist描述文案不同，一次22/22、324/324、exit0（[05-49-22](../tests/acceptance/runs/2026-11-01T05-49-22-590Z-100191/run-report.json)），一次21/22、323/324通过/1失败、exit1（[05-59-53](../tests/acceptance/runs/2026-11-01T05-59-53-185Z-105978/run-report.json)）。唯一失败为P21-host-output-contract的loadingFailed条目检查，实际仅3条成功网络记录，与[基线同项](../tests/acceptance/runs/2026-11-01T04-30-43-916Z-53146/run-report.json)相同；Lead判定既有环境flake而非P0回归，失败记录仍为FAIL。验收需串行，串行不能保证flake不出现。

权威契约见 [capture-p0.md](capture-p0.md)；默认暂存修订 C1–C15 **15/15、162/162、exit0**（画布轮 [capture-p0-2026-11-01T20-18-32-415Z-768943](../tests/acceptance/runs/capture-p0-2026-11-01T20-18-32-415Z-768943/report.json)；此前 14/14、142/142 保留为历史）。注意：从第 9 轮起显式 `scale` 下界是 **0.1**、默认值不再固定 1（省略时跟随共享 `view.scale`）；2026-11-02 起 `region` 为 canvas CSS（O=0 与文档相同），O≠0 由 Host 白底合成并披露 `capture.canvas.composite=true`。见 [canvas-viewport.md](canvas-viewport.md) §6。下方13/115属修订前历史：进程内真实 Chromium 三次各 **13/13 probes、115/115 必需项、exit 0**（[末次报告](../tests/acceptance/runs/capture-p0-2026-11-01T04-58-32-550Z-66980/report.json)），宿主重启后加载已于 2026-11-02 复验（默认/显式比例、region、mapping、networkWindow），provider 视觉仍 NOT_RUN。

| 项 | 现行语义 |
| --- | --- |
| 参数 | `scale?:number`显式连续0.1–4，**省略=当前共享`view.scale`（cold 1）**；region文档CSS px；`persist?:boolean=false`；out为持久根相对.png，提供即持久；无out/persist:true/非空env时默认暂存 |
| 单一采集路径 | `Page.captureScreenshot` PNG clip，DSF固定1，只用clip.scale；输出逐轴 `round(css×scale)`，最多16M像素；不事后放大/重编码，PNG损坏或尺寸不符不交付 |
| capture | `version(仍1)/request/environment/png/expected/sizeCheck/mapping/anomaly/file/delivery/warnings`；`request` 新增 `scaleSource(explicit\|view)`/`viewRevision`，`mapping` 新增逐轴 `cssPerPixel` 与 `scrollAtCapture` 与连续点公式；mapping纯JSON；PNG CRC/尺寸与≤16M全量均匀/透明统计，纯色仅警告 |
| 环境 | `deviceScaleFactorSource:'runtime-override'`；页面DPR读回失败null；`headless/headlessSource` 联合product/userAgent判定，任一HeadlessChrome命中true，未知null（Chrome152实测source=userAgent） |
| 文件 | 默认staging（插件实例tmp目录/绝对file.path/pathKind=absolute/persistence=staging/root=staging/ephemeral=true），正常dispose清理；out/persist:true/非空env触发persistent（env或cwd根/相对path/ephemeral=false）；0600/link/no-clobber；legacy持久无根报OUTPUT_PATH_INVALID(root_unknown)，暂存失败只file=null+capture_file_unavailable |
| 交付 | base64与落盘是同份PNG/hash；附件仅compare='attachment-metadata'，缺字段不推断相同；附件降采样/重编码警告不能证明provider最终接收尺寸 |
| 能力发现 | capture.output声明defaultMode=staging、persistRules、stagingRoot/workspaceRoot占位、ephemeral；limits.capture含staging/persistParam/pathKind；observed首次null，file仅{persistence,relativePath|null}；诊断不启动/不建暂存根 |

warnings封闭为 `content_uniform/content_transparent/model_image_downscaled/attachment_reencoded/blank_check_skipped/capture_file_unavailable/attachment_unavailable/capture_beyond_viewport`。新增错误为 `CAPTURE_FAILED/INVALID_PNG/CAPTURE_SIZE_MISMATCH/CAPTURE_UPSCALED/CAPTURE_TOO_LARGE/OUTPUT_PATH_INVALID/OUTPUT_EXISTS/OUTPUT_WRITE_FAILED`，分类和恢复见权威契约；取消/超时/断连原码透传。region与T2 bbox/输入的视口CSS坐标不同，转换使用采集前scroll及mapping。高密度不增加canvas/WebGL内部位图细节；C13只证明fixture前后布局无持久变化，瞬时布局影响、TOCTOU和provider仍不作保证。

### 独立 HTTP 客户端（`browser_http_request`）

- 传输：Host 进程内 `node:http`/`node:https`，不经过页面、CDP 或面板路由；零第三方依赖。
- 预算：默认 GET、5000ms 总截止（上限 20000）、65536 保留字节（上限 1048576）、请求体 ≤65536 字节、请求头合计 ≤8192 字节；默认不跟随重定向（上限 5 跳）。
- 安全：每次派发（含每一跳）复用 `validateTarget`；HTTPS→HTTP 降级拒绝；拒绝 `host/content-length/transfer-encoding/connection/cookie/accept-encoding` 等客户端托管头；无 cookie jar；跨 origin 重定向清空调用方头。
- 返回：`ok:true` 只表示取得响应；404/500 正常返回；`headers` 小写→`string[]`、敏感头 `["***"]`；`encoding` 为 utf8/base64；`bodyBytes` 为保留原始实体字节；`bodyTruncated` 明确截断；不自动解压。
- 错误：`HTTP_TIMEOUT`、`HTTP_FAILED`、`HTTP_REDIRECT_LIMIT`（DNS 仍 `NAV_FAILED`）；取消/超时只销毁当前请求，不关浏览器、不改页面租约或错误。
- 能力发现：`browser_capabilities` 报 `web.t1.http-request: available` 与 `limits.httpRequest`，不因 Chrome 缺失或其他 owner 占用降级。

## 内置 Skill 与能力发现

`index.js` 在 `apply()` 里用 `ctx.inject(['skills'], …)` 注册 bundled skill `ui-testing`：正文取自 `skills/ui-testing/SKILL.md`，`resourceBase` 指向该目录，`modelInvocable`/`userInvocable` 均为 true；宿主没有 `skills` 服务或资源缺失时只记日志，不阻断浏览器工具。`package.json` 的 `files` 含 `skills/**`，`npm pack --dry-run` 可见 31 个 Skill 文件随包发布。正文含「读取面板标注（P0-D annotations）」小节，细则在 `skills/ui-testing/references/scenarios/annotations.md`（`browser_state.annotations` 读取、`p=d−S`、箭头尖 `(x2,y2)`、手写无原文、指代用 `elementFromPoint` 复核）；该文件被 `check-skill-registry.mjs` 的“正文引用可读”检查覆盖。

- 运行时通过新增 `browser_capabilities` 根据真实状态报告 `available/unavailable/unsupported`、限制及 `single-owner-lease`。当前注册表决定工具是否可调用；`browser_state` 仍专注运行态、标题从 `document.title` 刷新。state/capabilities 不懒启动。台账与 manifest 是开发事实，不是运行时证据。
- 服务级验证（真实 `SkillRegistry`）见 `tests/acceptance/check-skill-registry.mjs`；宿主重启后 Agent 会话内是否可见，以新会话工具列表为准。
- 7 条基础设施清单的逐条审计见 [t1-infrastructure-audit.md](t1-infrastructure-audit.md)。

## 焦点与接管

- 浏览器以 `--headless=new` 启动，无窗口、无输入注入到桌面 → 不会抢焦点。
- 用户在面板里点击/滚轮/打字 → `POST /input` → CDP 派发，宿主把 `mode` 记为 `human`（4 秒）。
- 剪贴板、文件选择、权限弹窗、跨窗口行为都未实现。

## 性能观测与指标口径

状态栏（`${fps} FPS ${ms} ms`）与 `/metrics` 使用**实测值**：

- **显示 FPS**：客户端统计最近 1s 内真正触发 `img.onload` 并在 `requestAnimationFrame` 中完成显示的帧数。不是轮询次数，也不是采集次数；页面静止时为 `0 FPS` 是正常的。
- **端到端显示延迟（ms）**：`显示时刻 - capturedAtMs` 的中位数（最近 60 帧），从 Chromium 采集到面板显示整条链路，包含传输/解码/React 渲染。
- **传输耗时**：客户端收到帧时的 `now - capturedAtMs`（不含显示等待），与端到端延迟分开记录。
- **host 指标**（`/metrics` → `host`）：`captured` 采集帧数、`pushed` 推送数、`coalesced` 合并丢弃、`blocked` 背压丢弃、`stale` 旧 epoch 丢弃、`ackFailures`、`clients`、`captureFps`/`captureIntervalMs`（由 CDP 帧时间戳测量，静止页面可能为 0）、`lastFrame` 元数据。
- **client 指标**（`/metrics` → `client`）：客户端每 2s 上报的最近一次实测值，字段标注意义见上；`measuredAt` 为客户端时间。
- `captureFps` 与 `displayFps` 是**不同口径**：前者是 Chromium 出帧速率，后者是面板真正显示的速率；不要用轮询间隔/推送间隔直接代表 FPS。

### 本机实测（隔离 DSH + 无头 Chromium，沙箱内使用 chrome-wrapper）

| 场景 | 指标 | 数值 |
| --- | --- | --- |
| WebSocket 推送，连续改页面 12 次 | 面板显示 FPS / 端到端延迟 | 8 FPS / 11 ms（client 上报 endToEndMs 12ms、transportMs 8ms） |
| HTTP 轮询回退（禁用 WS），同一动作 | 面板显示 FPS / 端到端延迟 | 6 FPS / 56 ms（transportMs 29ms） |
| 静态页面 | 显示 FPS / 延迟 | 0 FPS（只有首帧/截图种子，符合事件驱动语义） |
| host 采集 | captured / pushed / captureFps | 14 / 14 / 约 20（突发时） |

这些是**本机小样本**，不是跨机器基准；测试环境与命令见 `tests/acceptance/`。WS 相比轮询的主要收益是少一次 80ms 轮询等待，实测端到端延迟约降到 1/3。

自动化回归：`node tests/acceptance/real-browser-ws.mjs` → 13/13 PASS（真实隔离 DSH + 页面内 WebSocket；页面收到 6 帧 1280×800 JPEG、`Network.webSocketCreated` 命中 `/frames`、host.captured/pushed=6、`/close` 后 WS 关闭 1001）。帧推送/鉴权/回退探针见 `run.mjs` 的 P11–P13（13/13、6/6、12/12 PASS）；面板显示层数值由上表的 CDP 手动回归测得，自动化脚本只覆盖到“页面收到帧 + metrics 可写读”。

## 传输选型：为什么保留 JPEG screencast，不用 WebRTC

- **帧源**：CDP screencast 是浏览器合成器的原生输出，不需要 `getDisplayMedia`/`captureStream` 之类页面内采集，不改变被测页面行为、不触发媒体权限；WebRTC 出图反而要额外采集/插桩。
- **传输面**：WS 走 DSH 同源 HTTP Upgrade，复用连接服务鉴权；WebRTC 需要 signaling、ICE/STUN/TURN、DTLS/SRTP、SDP/编解码协商与重连，等于在插件里再养一套媒体栈和暴露面。
- **播放面**：`<img>` + Blob URL 不依赖 WebRTC 栈/硬件解码；推帧只保留最新一帧，天然背压，不会堆积延迟。轮询回退保证 WS 不可用时功能不退化。
- **时间证据**：每帧带 `metadata.timestamp`，host/client 两侧都可算延迟与丢帧；后续 T4 计划复用同一条 CDP 帧/时间戳管线。WebRTC 的抖动缓冲会隐藏逐帧采集时刻，不利于可复核的时序证据。
- **升级条件**：只有出现「浏览器在远端 / 需要 60fps 级实时 / 音频 / 多观众」时，才值得引入 WebRTC 及 signaling、TURN 和权限模型。当前 T1 是本地单用户预览，升级收益不足以抵消复杂度。

## 已知限制

- 帧仍是 JPEG（质量 72、最大 1600×1200），WS 推送最小间隔 40ms；高动态页面可能掉帧，`dropped.coalesced/blocked` 会增长。轮询回退固定 80ms。
- **共享视口的显示粒度**：实时帧固定 1x screencast，面板只按 `scale` 做 CSS 放大/缩小（>100% 时是位图放大、不是更高像素密度）；需要细节时用 `browser_screenshot` 的显式 `scale`（0.1–4）或 T3。缩放比例不改变页面 CSS 视口与 DPR。
- **共享比例会改变默认截图尺寸**：`view.scale≠1` 时省略 `scale` 的截图（含 T3 live 源）按该比例输出；需要固定分辨率请显式给 `scale`。比例过低会丢细节，极小 region 会被提前拒绝（`empty-output-dimensions`）。
- **视口 X/Y 是页面滚动位置**，不是窗口位置；页面自己滚动、smooth scroll 或 scroll snap 会继续改变它，缓存超过 1s 标 stale；`browser_viewport get` 只是缓存诊断，不保证新鲜。
- **宽高变更后的输入屏障是 best-effort**：帧协议未扩展（`frame-source.js`/`frame-push.js` 本轮未改），只按已解码帧尺寸/元数据暂停输入 ≤250ms。
- **真实宿主**：3080 已于 2026-11-02 01:28:05 重启（`dsh web` pid <pid>），真实 Agent 会话复验的是**画布前**构建（30 工具、`ui.view`、viewport/截图/T3 默认比例）；**画布 v2 Host 面已于 2026-11-02 11:15 重启后实测**（canvasX/Y、白色 blank、合成截图/T3 canvas、blank act 零派发、导航复位、页面自主滚动保留 O；[证据](../tests/acceptance/evidence/canvas-realhost-2026-11-02.md)）；**面板交互与需 GUI 认证的路由仍 NOT_RUN**。隔离实例不能冒充主实例。
- 推帧只有服务端合并/背压，没有逐帧客户端 ACK；客户端丢帧通过 `seq` 跳号和 `droppedClient` 观测。
- WS 升级依赖宿主 `connection` 服务鉴权；该服务不存在时仅 loopback 放行（测试/最小组合）。反向代理若不透传 Upgrade，会自然回退到轮询。
- 键盘：`browser_input` 已支持 `modifiers`（数组或位掩码）与 `virtualKeyCode`，可派发 Tab/Shift+Tab/Enter/Esc/方向键与组合键（P20 用页面 DOM 事件与 `activeElement` 实测）；`commands`、`unmodifiedText`、`pointerType:pen` 只有 schema 与透传，无页面级行为断言（未验证）。面板里的人类输入走同一个 `/input` 通道。
- 输入事件会先到达宿主页面，因此宿主里若有模态遮罩会吞掉点击。
- 没有下载、上传、Cookie 导出、多标签页、跨源隔离。
- **实测只证明覆盖路径**：标题刷新、导航失败信号、分类错误、返回值 lossless JSON、N2 输入事件、截图附件/render 已由第 4 轮 22 组、303 项主验收（含 P22 独立 HTTP 95 项）覆盖，取代相应历史 F2/F3/F4/F9 结论；3081 终版（pid <pid>）Lead 独立终验 verify-3081 22/22、GUI address-history 276/276 通过（硬化后连续 3 次 276/276 + B1/G1 专项各 12/12）；真实 Agent 会话内 8 工具曾真实调用；第 4 轮第九工具于 2026-11-02 在真实宿主调用成功（`GET /health` → 200）；provider 是否显示图像仍 NOT_RUN。此前“截图无裁剪”属历史；P0 已提供文档 clip/连续 scale/PNG校验/安全落盘，验收见上节与 [状态记录](status.md)，仍无像素差异/VLM/视觉判断。
- **跨工作区 Cookie/存储不隔离**：同一 Chromium/profile 下 Cookie、localStorage、IndexedDB、cache 共享；page/URL/viewport/网络缓冲/队列/租约按工作区隔离。真实 Agent exec 身份链与两个 GUI 工作区已在 3081 验收，见 [workspace-isolation.md](workspace-isolation.md)。
- **目标策略不是完整网络沙箱**：允许 loopback；默认阻断 RFC1918（`DSH_UI_TESTING_ALLOW_PRIVATE=1` 开放）、metadata/unspecified/multicast、credentials、已配置 `DSH_WEB_URL` origin；导航、DNS、最终 URL 和 Document 重定向校验仍不能消除子资源与 DNS rebinding 风险。
- **网络是有限元数据**：URL 脱敏并记录 loadingFailed，Map/记录有界；无请求/响应头或正文，脱敏也不能保证覆盖所有业务敏感字段。
- 帧/指标只保存在内存；`/metrics` 的 client 数据是最近一次上报，重启即清空；不实现 T4 帧序列分析。
- 地址/历史只有**单个 Runtime、单个主 page** 的浏览器历史；不跨 session 持久化、不展示历史条目列表、不做多标签/popup 接管，也不注入 DOM history shim。`about:blank` 只在"浏览器内部已有条目"时允许回退；其它非 HTTP(S) 历史目标按 `INVALID_ARGUMENT` 拒绝。
- `ui.address` 只在已认证同源 GUI 的 HTTP 响应里出现；`browser_state`、网络记录、`/metrics`、WS 头仍是脱敏/无地址。旧 Host（未重启）没有 `ui` 字段，客户端降级为只读脱敏 URL 且禁用刷新/后退/前进。
- Host 半边、`skills/**` 或 `package.json` 改动需要重启 DSH；Client 半边热更新。**本轮 3081 已重启到终版**（pid <pid>，18:36:21；index `fe870ee1…a38b3`/18:19:00、client `f03a1c2d…681edf`/18:01:07，``editedAfterStart={}``），`verify-3081` 22/22、GUI `address-history-3081` 276/276 均 PASS（Lead 独立终验；硬化后连续 3 次 276/276 + B1/G1 专项各 12/12；此前 255/260 的偶发根因是 shell 对话框 `autoFocus` 抢焦点，属环境/脚本，脚本已硬化）；**3080 已由用户于 19:36:05 重启**（pid <pid>）并确认 `ui.version=1`；legacy 降级只适用于重启前旧 Host（历史状态）。3081 验收完成后已停止。
- **`host.clients` 不是绝对健康指标**：3081 上可能存在外部 viewer（用户 3080 浏览器、旧 headless `/tmp/chrome-iso2`），基线非 0 属正常；正常 GUI reload 会把本页 client 回收为 0。既有缺口：无 WebSocket Close 帧的粗暴断开会让服务端 socket 停在 `CLOSE-WAIT`、frame-push 不回收（`MAX_CLIENTS=8`，`frame-push.js` 本轮未改），建议后续单独修。

逐条证据与缺口见 [t1-infrastructure-audit.md](t1-infrastructure-audit.md) 与 `tests/acceptance/evidence/`。
