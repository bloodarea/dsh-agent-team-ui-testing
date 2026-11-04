# WEB-T4 准备工作 · 靶机与验收冻结契约（Lead 冻结，执行者只读）

> 状态：**准备阶段**。本文件冻结两套 T4 准备靶机的路由、DOM、真值 API、场景与验收口径。
> 它不是 T4 实现契约，不改变插件能力：**T4 仍 unsupported，工具面仍 30，不注册任何 `browser_motion_*`/T4 工具**。
> T4 的实现契约由 `docs/t4-dynamic-behavior.md` 承载（本文件只冻结靶机侧）。

执行者只能在各自任务列出的写入范围内改文件；**本文件与 `server.mjs`、`t4-http-utils.mjs` 由 Lead 持有**。若实现中确实需要偏离本契约，先给 Lead 发消息说明原因，得到确认后再改；不得静默改口径、放宽断言或把未验证项写成通过。

## 0. 通用要求

- 只监听 `127.0.0.1`、零 npm 依赖、无外部网络、无随机数、无真实凭据、无第三方 CDN/字体/图片外链。
- 路由实现放在 `tests/ui_test_fixture/t4-*-route.mjs`，由 `server.mjs` 已接好的入口调用；页面/资源也由该模块自取，**不要改 `server.mjs`，不要把页面塞进 `STATIC_FILES`**。
- 所有接口响应带 `cache-control: no-store` 与 `x-fixture: dsh-ui-testing`（`t4-http-utils.mjs` 的 `json`/`sendFile` 已带）。
- 浏览器会话串行：仓库既有约束是**单驱动**。任何启动插件浏览器/验收套件的命令都必须在 `flock /tmp/dsh-t4-browser.lock ...` 下执行（包括调试用的一次性 harness 脚本），不得与另一套 T4 套件并发跑。
- 不触碰真实 DSH 3080/3081，不重启 DSH，不改 `index.js`/`client.js`/插件工具。验收通过 fixture server + fake ctx + 真实无头 Chromium（`tests/acceptance/harness.mjs`），只用注册过的 `browser_*` 工具，**不得自行拼 CDP**。
- 证据：验收脚本在 `tests/acceptance/runs/<ISO>-<pid>/` 写 `run-report.json`、`run.log` 与 PNG 截图（把 `DSH_UI_TESTING_CAPTURE_DIR` 指向该目录后再 import harness），报告含每条检查 expected/actual 与证据路径。测试命令用 `flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-*.mjs`。
- 退出码：0 = 全部必需检查通过；1 = 至少一条必需检查失败；2 = 套件自身无法运行（无 Chromium/fixture 缺失/致命错误/超时）。NOT_RUN 不计通过，逐条写明原因。
- 时间：逻辑时钟用毫秒整数；真值里同时给 `atMs`（逻辑/相对）与 `atWallMs`（`Date.now()`，仅用于关联，不用于结构断言）。计时容差写进检查名或 actual，不写死脆弱值。

## 1. 动态视觉靶机（owner：executor-visual）

文件（写入范围）：
- `tests/ui_test_fixture/web-t4-visual.html`
- `tests/ui_test_fixture/t4-visual-route.mjs`（替换 Lead 的 stub）
- `tests/ui_test_fixture/t4-visual.md`（真值表/资产来源/限制）
- `tests/acceptance/t4-visual-fixtures.mjs`
- 可选：`tests/ui_test_fixture/t4-visual-media.webm`（生成的 3s 资产）、`tests/ui_test_fixture/tools/make-t4-media.mjs`（一次性生成脚本，注明 provenance/sha256）

路由：
- `GET /web-t4-visual.html` → 页面（`text/html`，UTF-8）。
- `GET /t4/visual/*` → 页面脚本/样式/媒体（二进制允许；用 `sendFile`，`root` 指向本目录）。
- 其他路径返回 false。`disposeT4Visual(state)` 清理 rAF/timer（页面在浏览器里，服务器侧一般无需清理；不要留 setInterval）。

页面结构（稳定 id；参考图 1 的四卡布局，2×2）：
- `#t4v-title`（h1，文本 `DSH T4 动态视觉靶机`）、`#t4v-subtitle`、`#t4v-status`（状态行）。
- 四张卡片：`#t4v-panel-css`（CSS / DOM 动画）、`#t4v-panel-canvas2d`（Canvas 2D 动画）、`#t4v-panel-webgl`（WebGL / WebGPU 场景）、`#t4v-panel-media`（动态媒体）；每卡含标题、说明和真值状态行（`data-panel`）。
- 渲染目标：`#t4v-css-orb`（用 Web Animations API 驱动的 transform/opacity）、`#t4v-canvas2d`（`<canvas width=240 height=160>`，2D context）、`#t4v-canvas-webgl`（`<canvas width=240 height=160>`，WebGL2，失败时退回 WebGL1 并如实记录）、`#t4v-video`（`<video muted playsinline>`）。
- 控制：`#t4v-pause`、`#t4v-resume`、`#t4v-reset`、`#t4v-scenario-select`（normal/flash/freeze/jank/media-stall）、`#t4v-seek`（range 0–3000）+ `#t4v-seek-value`（显示 ms）、`#t4v-step-back`、`#t4v-step-forward`（±50ms）。
- `body[data-t4v-scenario]`、`body[data-t4v-paused]` 同步状态。

冻结真值 API：`window.__t4.visual`

```js
{
  version: 1,
  fixture: 'web-t4-visual',
  truth: {
    durationMs: 3000,
    seed: 20261104,
    panels: ['css', 'canvas2d', 'webgl', 'media'],
    css: { periodMs: 1200, animatedProps: ['transform', 'opacity'] },
    canvas2d: { width: 240, height: 160, particles: 24, checksum: 'fnv1a32-rgba' },
    webgl: { width: 240, height: 160, api: 'webgl2|webgl|unavailable' },
    media: {
      asset: '/t4/visual/t4-visual-media.webm',
      durationMs: 3000,
      checkpoints: [
        { ms: 500, dominant: 'r' }, { ms: 1500, dominant: 'g' }, { ms: 2500, dominant: 'b' }
      ],
      fallback: null // 或 'canvas-capture-stream' 并说明限制
    }
  },
  clock: { nowMs, paused, rate, frame, startedAtWallMs, lastTickWallMs },
  panels: {
    css:   { panel:'css', timeMs, transform:{translateX,scale}, opacity, animationCount,
             animations:[{ id, currentTimeMs, playState }], checksum? },
    canvas2d: { panel:'canvas2d', timeMs, frames, draws, particle0:{x,y}, checksum,
                frozen:false, flash:false },
    webgl: { panel:'webgl', timeMs, frames, checksum, contextType:'webgl2|webgl|none',
             renderer:string|null, webgpu:{ available:boolean, reason:string|null } },
    media: { panel:'media', durationMs, currentTimeMs, paused, readyState, frameCount,
             sample:{ r,g,b }, stalled:false, frozen:false }
  },
  scenario: 'normal',
  ops: [{ opId, kind:'click'|'seek'|'scenario'|'pause'|'resume', target, atMs, atWallMs }],
  events: [{ seq, kind:'clock'|'draw'|'anomaly'|'control'|'media'|'visibility', panel,
             atMs, atWallMs, causeOpId:string|null, detail }],
  timeline: [/* ops 与 events 合并、按 atWallMs 排序；每项至少 {seq,domain:'operation'|'visual',kind,atMs,atWallMs,panel,causeOpId} */],
  anomalies: { flashFrames:[], frozenAtMs:null, jankFrames:[], mediaStalled:false },
  controls: { pause, resume, reset, seek, setScenario, state, samplePanel } // 函数；仅页面内使用
}
```

方法（`browser_eval` 可调）：
- `__t4.visual.state()` → 序列化快照（深拷贝，函数省略）。
- `__t4.visual.setPaused(bool)`、`__t4.visual.seek(ms)`（`0..3000`，隐含暂停）、`__t4.visual.setScenario(name)`（重置 t=0、清 anomalies、按场景决定是否自动运行）、`__t4.visual.reset()`。
- `__t4.visual.samplePanel(name)` → 该面板真值 + 像素/逻辑 checksum。

确定性规则：
- 逻辑时钟只由 rAF 推进（`dt = min(now-last, 50) * rate`）；`paused` 时四块画面全部冻结（视频 `pause()`，canvas 不重绘，CSS 动画 `pause()` 且 `currentTime = t`）。
- 同一 `t + scenario + paused` 在同一运行内必须得到相同逻辑真值与 canvas/webgl checksum；不同 `t` 必须不同（除非该场景明确冻结）。跨进程不要求像素 hash 相同（GPU/软件栅格差异），验收只做“同运行内相等/不等 + 颜色主导通道”断言。
- checksum 固定为 **FNV-1a 32-bit over RGBA 字节**（宽×高×4，按行序），在页面内计算并在文档写明；不要用画布 draw 调用次数代替像素。
- CSS 动画必须真实使用 Web Animations API（`element.animate(...)` 或 CSS animation + `getAnimations()`），`pause()` + 设 `currentTime`；真值从 `getComputedStyle`/`getBoundingClientRect` 读回，不用手写状态冒充。
- Canvas 2D：24 个粒子，位置为 `t` 的确定性函数（固定 seed 的 PRNG 只用于初始化），每帧全量重绘；`frames` 只在真正重绘时 +1；`checksum` 每帧计算。
- WebGL：着色器以 `u_time = t/1000` 输出确定性图案（例如随 t 移动的彩色渐变/色块），每帧 `readPixels` 算 checksum；`contextType` 如实（优先 webgl2）；`renderer` 从 `WEBGL_debug_renderer_info` 读，取不到为 null；`webgpu.available` 用 `navigator.gpu` 探测，**不可用就如实 false，不伪造 WebGPU 画面**。
- 动态媒体：优先提交 `/t4/visual/t4-visual-media.webm` 资产（3s，0–1s 红、1–2s 绿、2–3s 蓝，白色方块横向移动）；`<video>` 用真实 `play/pause/currentTime`，每帧 `drawImage` 到离屏 canvas 取平均 RGB 作为 `sample`，并用 `requestVideoFrameCallback`（可用时）累计 `frameCount`。若生成资产不可行，必须在 `t4-visual.md` 与本 API 的 `truth.media.fallback='canvas-capture-stream'` 中如实披露，套件相应检查记 NOT_RUN，不得声称测过视频 seek。

场景（`setScenario`/`?scenario=`，均确定性）：
- `normal`：四块都动；无异常。
- `flash`：逻辑时钟进入 `[640, 656) ms` 时 Canvas 2D 绘制**整帧纯白**一次（仅该帧），`anomalies.flashFrames` 记录对应 `frames` 值；`panels.canvas2d.flash=true` 仅该帧。正常区间不得闪白。
- `freeze`：Canvas 2D 在 `t>=800ms` 后停止重绘（`frozen=true`、`draws/frames` 不变、checksum 不变），时钟与 CSS 继续；`anomalies.frozenAtMs=800`。
- `jank`：Canvas 2D 每 3 帧丢弃 1 帧（不重绘），`anomalies.jankFrames` 记录被跳过的帧号；时钟继续。
- `media-stall`：视频在 `currentTime>=1.2s` 后暂停且不再推进（`stalled=true`、`anomalies.mediaStalled=true`），其他面板正常。
- 场景切换重置 t=0、清空 anomalies 与对应事件，重新装载视频。

验收套件 `tests/acceptance/t4-visual-fixtures.mjs` 至少覆盖（必需项，可加）：
1. 页面加载：标题、四卡、`version===1`、`truth.media.asset` 或 fallback 披露；无跨源请求。
2. 四类画面真实：CSS `animationCount>=1` 且 transform/opacity 随 t 变化；Canvas2D `contextType='2d'` 且 frames>0；WebGL `contextType` 为 webgl2/webgl（环境确实不支持时按 NOT_RUN 记，不写 PASS）；视频 readyState>=2、duration 3.0±0.15（有资产时）。
3. 暂停 + seek 确定性：`seek(300)` 两次（中间 seek 900）canvas checksum 相同；300 vs 900 checksum 不同；CSS/WebGL 真值随 t 变化；同一 t 的 WebGL checksum 相同。
4. 运行推进：resume 后 `clock.nowMs` 增长、canvas frames/draws 增长、CSS currentTime 增长。
5. 视频：play 后 currentTime 增长、frameCount/sample 变化；pause 后 250ms 内 currentTime 漂移 <80ms 且 sample 不变；seek(1500)/seek(2500) 的 sample 主导通道分别为 g/b（容差：主导通道比次高 ≥12，或按实际资产校准并写进 actual）。
6. `flash`：seek(648) 的 canvas checksum 与同 t normal 不同且 `flash=true`、`flashFrames` 非空；seek(600) 不闪。
7. `freeze`：resume 到 `clock.nowMs>1200` 后 `frozen=true`、frames/checksum 两次采样不变，CSS 仍变化。
8. `jank`：resume ~1200ms 后 `jankFrames.length>=5`、`frames < clock.frame`。
9. `media-stall`：play 到 currentTime≈1.2s 后再等 400ms，currentTime 漂移 <80ms、`stalled=true`。
10. 操作→视觉：用 `browser_click` 点 `#t4v-pause`，`ops` 出现对应 op，`clock.paused=true`，timeline 有 `causeOpId` 的 visual 事件（数据可用性，不是因果引擎）。
11. 截图证据：`browser_screenshot` 整页/两卡，落盘 PNG 到本次 run 目录，报告记录 sha256/尺寸/路径。
12. 不越界：`browser_capabilities` 仍报 T4 unsupported、注册工具仍 30、不存在 `browser_motion_*`（防止把准备靶机写成能力上线）。

## 2. 动态网络靶机（owner：executor-network）

文件（写入范围）：
- `tests/ui_test_fixture/web-t4-network.html`
- `tests/ui_test_fixture/t4-network-route.mjs`（替换 Lead 的 stub）
- `tests/ui_test_fixture/t4-network-ledger.js`（页面记账脚本；可由页面内联替代，但推荐独立文件）
- `tests/ui_test_fixture/t4-network.md`（真值表）
- `tests/acceptance/t4-network-fixtures.mjs`

路由：
- `GET /web-t4-network.html` → 单页电商流程页。
- `GET /t4/network/*` → 页面脚本/样式。
- `GET /api/t4/ledger?runId=t4-run-1` → 服务端收到请求的真值账本。
- `POST /api/t4/reset`（也接受 GET 便于探针）→ 重置本 fixture 服务端状态，返回 `{ok:true}`。
- `POST /api/t4/cart`、`GET /api/t4/cart`、`POST /api/t4/orders`、`GET /api/t4/orders/:id`、`POST /api/t4/orders/:id/cancel`、`GET /api/t4/order-events?orderId=…`（SSE）。
- `GET /t4/ws`（upgrade；由 `handleT4NetworkUpgrade({req,socket,head,pathname,state})` 接管，返回 true；其他路径返回 false）。
- 其他路径返回 false。

页面（稳定 id；参考图 2 的购买链路，单页不导航）：
- `#t4n-title`（`DSH T4 动态网络靶机`）、`#t4n-subtitle`、`#t4n-status`、`#t4n-scenario`。
- 商品：`#t4n-product-name`（`T4 Widget`）、`#t4n-product-price`（`¥ 42.00`）、`#t4n-qty`、`#t4n-qty-dec`、`#t4n-qty-inc`。
- 操作：`#t4n-add-cart`（加入购物车）、`#t4n-checkout`（结算）、`#t4n-cancel-order`（取消订单）、`#t4n-retry`（重试，默认 hidden）、`#t4n-reset`。
- 购物车：`#t4n-cart-count`、`#t4n-cart-revision`、`#t4n-cart-list`。
- 订单：`#t4n-order-id`、`#t4n-order-status`（未创建→待支付→已支付→已完成）、`#t4n-order-banner`。
- 错误：`#t4n-error`（默认 hidden；文本含业务错误码，如 `订单创建失败：ORDER_REJECTED`）。
- 通道：`#t4n-ws-state`、`#t4n-sse-state`、`#t4n-poll-count`。
- `body[data-t4n-scenario]`、`body[data-t4n-stage]` 同步阶段。

冻结真值 API：`window.__t4.net`

```js
{
  version: 1,
  fixture: 'web-t4-network',
  runId: 't4-run-1',
  traceId: 't4-trace-1',
  scenario: 'normal',
  ops: [{ opId:'op-1', kind:'click'|'input'|'api', target, atMs, atWallMs,
          traceId, idempotencyKey, requestIds:[] }],
  requests: [{ requestId:'t4-req-1', opId, method, url, atMs, atWallMs, status,
               ok, duplicate, retried, traceId, idempotencyKey,
               durationMs, error:{code}|null }],
  responses: [{ requestId, atMs, atWallMs, status, traceId, deduped, body }],
  ui: [{ key:'cart.count'|'cart.revision'|'order.status'|'error'|'ws.state'|'sse.state',
         from, to, atMs, atWallMs, cause:{ kind:'op'|'request'|'response'|'ws'|'sse'|'poll', id } }],
  ws: { state:'open'|'closed'|'disabled', frames:[{ direction:'in'|'out', type, data, atMs, atWallMs }] },
  sse: { state:'open'|'closed'|'disabled', events:[{ type, data, atMs, atWallMs }] },
  polls: [{ requestId, orderId, atMs, atWallMs }],
  errors: [{ atMs, atWallMs, code, requestId }],
  serverLedgerUrl: '/api/t4/ledger?runId=t4-run-1',
  methods: { state, reset, setScenario, addToCart, checkout, retryOrder, cancelOrder, snapshot }
}
```

方法（`browser_eval` 可调）：
- `__t4.net.state()`（序列化快照）、`__t4.net.reset()`（清 server + 本地账本）、`__t4.net.setScenario(name)`。
- `__t4.net.addToCart({ qty=1, double=false })`：生成 op，发送 1 或 2 个 `POST /api/t4/cart`（同一 `idempotencyKey`），每个请求带 `x-request-id`/`x-trace-id`/`x-op-id`。
- `__t4.net.checkout()`：发送 `POST /api/t4/orders`；成功则打开 SSE、启动 3 次固定轮询（见场景）。
- `__t4.net.retryOrder()`：错误后以同一 idempotencyKey 重发订单。
- `__t4.net.cancelOrder()`：`POST /api/t4/orders/:id/cancel`（视觉→网络用）。

服务端真值账本 `GET /api/t4/ledger?runId=…`：
```js
{ ok:true, runId:'t4-run-1',
  requests:[{ seq, method, path, traceId, opId, requestId, idempotencyKey,
              status, deduped, retried, atWallMs }],
  state:{ cart:{ count, revision, items:[{sku,qty,price}] }, order:{ orderId, status, total } } }
```
服务端必须把客户端 `x-request-id`/`x-trace-id`/`x-op-id`/`x-idempotency-key` 原样记账（不做脱敏；这些是 fixture 固定假值），每个 API 响应也回显 `x-trace-id`/`x-request-id`/`x-op-id`。业务码放 JSON `code:0` 或错误 `error.code`，响应头 `cache-control:no-store`。

状态机与确定性：
- 固定 `runId=t4-run-1`、`traceId=t4-trace-1`；购物车 revision 从 1 递增；订单号固定 `ORD-T4-1`；价格 `4200`（¥42.00）；总量 = Σ price*qty。
- 幂等：同一 `idempotencyKey` 的第二次 `POST /api/t4/cart` 返回同一 cart revision + `deduped:true`，**不重复加购**；`POST /api/t4/orders` 同理（同一 key 返回同一订单 + `deduped:true`；`fail-order` 场景第一次 500，第二次同 key 成功并 `retried:true`）。
- 订单状态：创建后 `pending`；+200ms `paid`；+400ms `fulfilled`；取消后 `cancelled`。GET 与 SSE 一致（定时器推进；同一订单不可回到更早状态）。
- SSE：`pending` 立即、`paid` +200ms、`fulfilled` +400ms，+600ms 关闭；`event: order`、`data: {orderId,status,atWallMs}`、`id` 递增。
- 轮询：订单创建后 200/400/600ms 各 `GET /api/t4/orders/ORD-T4-1`（除非场景 `poll-off`），每次记 `polls` 与 request；UI 状态由任意先到者更新（幂等，一次 transition）。
- WS：页面加载即连 `/t4/ws?runId=t4-run-1`（除非 `no-ws`）；服务端立即 `hello`，+400ms 将远程商品 `sku-t4-remote` 加 1 件（服务端 cart count+1、revision+1）并推 `cart-updated`；客户端据 WS 更新购物车徽标并记 `ui` cause `{kind:'ws',id:'ws-frame-1'}`。服务端回显 `ping`→`pong`。WS 不重复推同一事件。
- 初始购物车为空；WS 远程加购后 count=1，因此验收断言用**增量**（如点击加入购物车后 count = 基线+1），不要假设绝对 1。
- 场景：`normal`（WS+SSE+轮询全开）、`no-ws`、`no-sse`（SSE 不发送/关闭）、`poll-off`（不轮询）、`dup`（同 normal，供 `addToCart({double:true})`）、`fail-cart`（所有 POST cart 500 `CART_REJECTED`）、`fail-order`（第一次 orders 500 `ORDER_REJECTED`，同 key 重试成功）、`slow-order`（orders 延迟 800ms 后成功）。场景切换重置 server 状态与本地账本（t=0）。
- 错误传导：失败时 `#t4n-error` 可见且文本含错误码，`ui` 记录 `error` transition（cause=对应 requestId），`errors` 记录；成功/重试后隐藏。`#t4n-retry` 仅在订单错误时可见。
- 视觉→网络数据：错误 banner 的 `ui` 记录带 `cause.id=requestId`；重试 op 与失败请求共享 `traceId` 与 `idempotencyKey`，`ops.retryOrder.requestIds` 指向新请求；因此六向关联的数据都可从真值推导（关联引擎本身不在准备阶段实现）。

页面不得直接调用内部 HTTP 路由绕过工具做断言；结算/加购等动作既可由真实点击触发，也可由 `__t4.net.*` 方法触发（套件优先真实 `browser_click`，双击/并行发送用方法）。

验收套件 `tests/acceptance/t4-network-fixtures.mjs` 至少覆盖（必需项，可加）：
1. 页面加载：标题、商品/购物车/订单/错误节点存在、`version===1`、`runId/traceId` 固定、初始 cart 0、无跨源请求。
2. 网络采集：`browser_network_session start` 后导航；初始 `GET /api/t4/cart` 与 WS 握手/帧可见（WS 事件 kind=ws，方向/文本可读）。
3. 操作→网络：`browser_click #t4n-add-cart` → fixture `ops` 有 click + requestIds；浏览器网络事件含 `POST /api/t4/cart` 与随后 `GET /api/t4/cart`，状态 200，响应头/请求头 trace id 可关联（值可能被 P0 脱敏，用同组 hash/数量断言，不读原文）。
4. 网络→视觉 + 服务端真值：购物车 count/revision 增加且 `ui` transition 的 cause 指向 request/response；server ledger 中同 requestId/traceId 记录 200、`deduped:false`；浏览器真值与服务端账本请求数/状态一致（时间戳除外）。
5. 重复发送（网络→网络）：`dup` 场景 `addToCart({double:true})` → 浏览器看到 2 个 `POST /api/t4/cart`（同 idempotencyKey），fixture requests 两条、其中第二条 `duplicate/deduped=true`，server ledger 两条且 cart 只 +1；UI 只一次变化。
6. 结算链路：`browser_click #t4n-checkout` → `POST /api/t4/orders` 200、orderId=`ORD-T4-1`、SSE 事件 pending/paid/fulfilled 可见（至少 2 条）、3 次轮询 GET 可见、UI 订单状态最终 `已支付` 或 `已完成`，cause 指向 SSE/轮询。
7. WS→视觉：等待 WS `cart-updated`，`#t4n-cart-count` 增加，`ui` 有 cause `{kind:'ws'}`，WS 帧方向/内容在真值与网络事件中一致。
8. 错误传导（网络→视觉）：`fail-cart` 点击加购 → 捕获 500，`#t4n-error` 可见且文本含 `CART_REJECTED`，`ui.error.cause` 指向 requestId。
9. 重试（网络→网络）：`fail-order` 结算 → 500 `ORDER_REJECTED`，error/retry 可见；点击 `#t4n-retry` → 第二次 `POST /api/t4/orders` 同 idempotencyKey、`retried:true`、成功；UI 错误消失、订单进入 pending/paid。
10. 慢请求：`slow-order` 结算 → 浏览器事件 duration ≥700ms（容差写明），最终 UI 更新；不把“慢”写成失败。
11. Trace/步骤关联：`browser_network_trace begin-step → 动作 → end-step → query`，步骤 counters 包含上述请求/WS/SSE，correlation 同 trace 组计数 ≥3，`causality` 只出现 explicit/redirect/initiator（temporal 默认不返回）。
12. 服务端账本：`browser_http_request` 取 ledger，核对 method/path/status/traceId/idempotencyKey 与浏览器真值；服务端 seq 单调。
13. 重置：`POST /api/t4/reset` + `__t4.net.reset()` 后 server cart/order/requests 清空、页面账本清空、再次加购从 revision 1 开始。
14. 截图证据：错误态、订单完成态各一张整页 PNG 落到 run 目录，报告记录 sha256/尺寸/路径。
15. 不越界：`browser_capabilities` T4 仍 unsupported、工具面仍 30、无 T4 工具注册。

## 3. 文档与交接

- 执行者交付消息必须包含：改动文件、测试命令（带 flock）、报告路径、必需检查数/通过数/失败数/NOT_RUN、证据路径（含截图）、已知限制。只报事实，不报“应该”。
- Lead 会独立复跑两套件并实看落盘截图；执行者不得把“我跑绿了”当作最终验收，也不得放宽断言来变绿。失败先定位是实现/测试 setup/真环境，保留失败报告。
- 准备阶段结束时更新：`docs/t4-dynamic-behavior.md`（顾问）、`docs/index.md`/`docs/capability-tiers.md`/`docs/capability-tiers.md` 的“T4 仍未实现 + 准备资产”表述（Lead）、`tests/ui_test_fixture/README.md` 两行入口（Lead）。
