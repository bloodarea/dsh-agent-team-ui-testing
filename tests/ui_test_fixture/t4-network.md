# WEB-T4 动态网络靶机（`/web-t4-network.html` + `/api/t4/*` + `/t4/ws`）真值表

> 状态：**准备阶段靶机**。本文件冻结该靶机的逐路由真值、场景、按钮→真值映射、错误码、时序与
> 限制。它**不是** T4 实现契约：T4 仍 unsupported、工具面仍 30、不注册任何 `browser_motion_*` / T4
> 工具。实现契约见 `docs/t4-dynamic-behavior.md`；本文件只描述靶机侧。
>
> 权威契约：`tests/ui_test_fixture/t4-prep-contract.md` §0/§2（Lead 冻结）。本文件与契约冲突时以契约
> 为准，并先向 Lead 报告。验收套件：`tests/acceptance/t4-network-fixtures.mjs`（N1–N15）。

## 0. 范围与不变量

- 只监听 `127.0.0.1`、`port: 0`（ephemeral）；零 npm 依赖、无外网、无 CDN/字体/图片外链、无随机数、
  无真实凭据。页面与 API 同源（`http://127.0.0.1:<port>`）。
- 所有响应（含 SSE / 405 / 404）带 `cache-control: no-store` 与 `x-fixture: dsh-ui-testing`；
  每个 `/api/t4/*` 响应回显 `x-request-id` / `x-trace-id` / `x-op-id`（原样，固定假值，不脱敏）。
- 服务端状态 **per fixture instance**（`startFixtureServer()` 每次新建一份），不进程全局；两个 fixture
  服务器不共享计数器。
- 浏览器会话单驱动：任何启动插件浏览器/验收套件的命令都必须在
  `flock /tmp/dsh-t4-browser.lock ...` 下执行，不得与另一套 T4 套件并发。
- 页面加载时**会重置本 fixture 的服务端状态**（`POST /api/t4/reset`，见 §5），因此同一 fixture 上重复
  打开页面得到同一初始真值。

## 1. 文件与启动

| 文件 | 作用 |
| --- | --- |
| `tests/ui_test_fixture/web-t4-network.html` | 单页购买链路页面（稳定 id，见 §4） |
| `tests/ui_test_fixture/t4-network-ledger.js` | 页面侧真值脚本 `window.__t4.net`（经 `/t4/network/t4-network-ledger.js` 提供） |
| `tests/ui_test_fixture/t4-network-route.mjs` | 路由 + 服务端账本 + SSE + WS upgrade（`handleT4NetworkRoute` / `handleT4NetworkUpgrade` / `disposeT4Network`） |
| `tests/ui_test_fixture/t4-http-utils.mjs` | Lead 提供的 `json`/`sendFile`/`readJsonBody` 等（只读引用） |
| `tests/ui_test_fixture/server.mjs` | Lead 已接线（本靶机不改它；它把 `/t4/ws` 之外的 upgrade 交给本模块） |
| `tests/acceptance/t4-network-fixtures.mjs` | 准备验收套件（N1–N15，写 run-report.json + run.log + PNG） |

```bash
# 独立启动（前台，Ctrl+C 退出）；打印 FIXTURE_URL=http://127.0.0.1:<port>/
node tests/ui_test_fixture/server.mjs

# 准备验收（单驱动；报告写到 tests/acceptance/runs/<ISO>-<pid>/）
flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-network-fixtures.mjs
```

页面入口：`GET /web-t4-network.html`（可加 `?scenario=<name>`，见 §6）。

## 2. 固定真值

| 名称 | 值 | 说明 |
| --- | --- | --- |
| `runId` | `t4-run-1` | 固定；页面/账本/WS query 一致 |
| `traceId` | `t4-trace-1` | 固定；所有业务请求 `x-trace-id` |
| `orderId` | `ORD-T4-1` | 固定；每 fixture 实例同一订单 |
| 单价 | `4200`（`¥ 42.00`） | 主商品与远程加购商品同价 |
| 主商品 | `sku-t4-main` / `T4 Widget` | `#t4n-product-name` / `#t4n-product-price` |
| 远程商品 | `sku-t4-remote` | WS `+400ms` 由服务端加 1 件（§7.5） |
| 数量 | `1..9`（默认 1） | `#t4n-qty` / `#t4n-qty-dec` / `#t4n-qty-inc` |
| 订单状态 | `pending` → `paid`(+200ms) → `fulfilled`(+400ms)；`cancelled` | 服务端定时器推进；不可回退 |
| 购物车 `revision` | 从 0 开始，每次加购 +1 | 幂等命中不递增 |
| 购物车 `count` | Σ `qty`（件数） | 初始 0 |
| 订单 `total` | 创建时的 Σ `price*qty` | 之后加购不改已创建订单 |

## 3. 路由真值表

### 3.1 页面与资产

| 方法 | 路径 | 状态 | 说明 |
| --- | --- | --- | --- |
| GET | `/web-t4-network.html` | 200 | `text/html; charset=utf-8`，单页（无导航、无外部资源） |
| GET | `/t4/network/t4-network-ledger.js` | 200 | `text/javascript; charset=utf-8`；白名单资产，其他 `/t4/network/*` → 404 `t4-asset-not-found` |
| GET | `/t4/ws`（非 upgrade） | 426 | `{"error":"t4-upgrade-required","status":426}`；只有 upgrade 才说 WebSocket |

### 3.2 业务 API（全部 `cache-control: no-store` + `x-fixture` + 三个关联头回显）

| 方法 | 路径 | 请求 | 状态 | 响应体（逐字形状） | 说明 |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/t4/cart` | `{"runId":"t4-run-1","sku":"sku-t4-main","qty":1..9}` + `x-idempotency-key` | 200 | `{"code":0,"cart":{"count":N,"revision":R,"items":[{"sku","qty","price"}]},"deduped":false}` | 加购；同 key 第二次 → 同一 cart + `"deduped":true`，**不重复加购** |
| POST | `/api/t4/cart` | 同上（场景 `fail-cart`） | 500 | `{"error":{"code":"CART_REJECTED","message":"…"}}` | 所有 POST cart 均 500；不改购物车 |
| GET | `/api/t4/cart` | — | 200 | `{"code":0,"cart":{…}}` | 购物车真值（幂等、无副作用） |
| POST | `/api/t4/orders` | `{"runId":"t4-run-1","cartRevision":R,"total":T}` + `x-idempotency-key` | 200 | `{"code":0,"order":{"orderId":"ORD-T4-1","status":"pending","total":T,"createdAtWallMs":…},"deduped":false,"retried":false}` | 创建订单（服务端从当前购物车算 `total`）；同 key 第二次 → `deduped:true`；订单已存在（不同 key）→ 返回同一订单 + `deduped:true` |
| POST | `/api/t4/orders` | 同上（场景 `fail-order`，第一次尝试） | 500 | `{"error":{"code":"ORDER_REJECTED","message":"…"}}` | 不创建订单；同 key 第二次成功且 `"retried":true` |
| POST | `/api/t4/orders` | 同上（场景 `slow-order`） | 200 | 同上 | 延迟 **800ms** 后创建并响应 |
| GET | `/api/t4/orders/ORD-T4-1` | — | 200 | `{"code":0,"order":{"orderId","status","total","createdAtWallMs"}}` | 当前状态（服务端定时器推进，见 §7.3） |
| GET | `/api/t4/orders/<unknown>` | — | 404 | `{"error":{"code":"ORDER_NOT_FOUND","message":"…"}}` | — |
| POST | `/api/t4/orders/ORD-T4-1/cancel` | — | 200 | `{"code":0,"order":{"orderId","status":"cancelled","total",…},"cancelled":true}` | 幂等；终态；清除状态推进定时器并向该订单 SSE 推 `cancelled` 后关流 |
| GET | `/api/t4/order-events?orderId=ORD-T4-1` | — | 200 | `text/event-stream`：`id: 1/2/3`、`event: order`、`data: {"orderId","status","atWallMs"}` | `pending` 立即、`paid` +200ms、`fulfilled` +400ms、+600ms 关流（§7.3） |
| GET | `/api/t4/ledger?runId=t4-run-1` | — | 200 | `{"ok":true,"runId","traceId","scenario","requests":[…],"state":{"cart":{…},"order":{…}|null}}` | 服务端请求账本；**不记录自身** |
| POST / GET | `/api/t4/reset` | `{"scenario":"normal"}`（POST）或 `?scenario=` | 200 | `{"ok":true,"runId":"t4-run-1","scenario":"normal","state":{"cart":{…},"order":null}}` | 重置本 fixture 实例；**不记录自身**；未知场景 → 400 `INVALID_SCENARIO` |

方法不匹配 → 405 `{"error":"method-not-allowed","status":405,"allowed":[…],"allow":"…"}`（`t4-http-utils` 形状）。

### 3.3 服务端账本形状

```jsonc
{
  "ok": true, "runId": "t4-run-1", "traceId": "t4-trace-1", "scenario": "normal",
  "requests": [{
    "seq": 1,                    // 1..n，严格递增，重置后从 1 重新开始
    "method": "POST", "path": "/api/t4/cart",
    "traceId": "t4-trace-1", "opId": "op-2", "requestId": "t4-req-2",
    "idempotencyKey": "t4-idem-cart-1",
    "status": 200, "deduped": false, "retried": false,
    "atWallMs": 1760000000000    // 仅用于关联，不用于结构断言
  }],
  "state": { "cart": { "count": 1, "revision": 1, "items": [{ "sku": "sku-t4-main", "qty": 1, "price": 4200 }] },
             "order": null }
}
```

- `/api/t4/reset` 与 `/api/t4/ledger` 本身**不进入账本**（否则“重置后账本清空/服务端请求数一致”无法断言）。
- `state.order` 无订单时为 `null`；有订单时为完整快照。

## 4. 页面结构与按钮 → 真值

### 4.1 稳定 id（验收依赖，不得改名）

| 区域 | id |
| --- | --- |
| 标题/状态 | `#t4n-title`（`DSH T4 动态网络靶机`）、`#t4n-subtitle`、`#t4n-status`、`#t4n-scenario` |
| 商品 | `#t4n-product-name`（`T4 Widget`）、`#t4n-product-price`（`¥ 42.00`）、`#t4n-qty`、`#t4n-qty-dec`、`#t4n-qty-inc` |
| 操作 | `#t4n-add-cart`（加入购物车）、`#t4n-checkout`（结算）、`#t4n-cancel-order`（取消订单）、`#t4n-retry`（重试，默认 `hidden`）、`#t4n-reset`（重置） |
| 购物车 | `#t4n-cart-count`、`#t4n-cart-revision`（文本 `revision N`）、`#t4n-cart-list`（`<li data-sku data-qty>`） |
| 订单 | `#t4n-order-id`、`#t4n-order-status`（未创建/待支付/已支付/已完成/已取消）、`#t4n-order-banner` |
| 错误 | `#t4n-error`（默认 `hidden`；文本 `购物车更新失败：CART_REJECTED` / `订单创建失败：ORDER_REJECTED`） |
| 通道 | `#t4n-ws-state`（open/closed/disabled）、`#t4n-sse-state`、`#t4n-poll-count`（0..3） |

`body[data-t4n-scenario]` = 场景名；`body[data-t4n-stage]` = `boot|idle|busy|ordered|cancelled|error|cart-updated`。

`#t4n-error` 用 `hidden` 属性控制显隐，同时 CSS 用 `#t4n-error[hidden]{visibility:hidden}` 保留占位（避免
错误出现时页面跳动）。因此“可见”的判定是 `hidden === false && getComputedStyle(...).visibility === 'visible'`，
不是 `offsetHeight === 0`。

### 4.2 按钮/方法 → 真值字段

| 触发 | `ops` | `requests`（顺序） | `ui` 变化 | 服务端 |
| --- | --- | --- | --- | --- |
| `#t4n-add-cart` 点击 / `addToCart()` | `kind:click|api`、`target:#t4n-add-cart`、`requestIds[POST,GET]`、`idempotencyKey=t4-idem-cart-<n>` | 1×`POST /api/t4/cart` → 1×`GET /api/t4/cart` | `cart.count`/`cart.revision`（cause=refresh 响应 requestId） | cart count +qty、revision +1 |
| `addToCart({double:true})` | 同上（一个 op） | 2×`POST`（**同 key**）→ 1×`GET` | 只 1 次 `cart.count` 变化 | 第一次 +qty，第二次 `deduped:true` 不加 |
| `#t4n-checkout` 点击 / `checkout()` | `kind:click|api`、`target:#t4n-checkout`、`idempotencyKey=t4-idem-order-1`、`requestIds[POST,3×poll]` | 1×`POST /api/t4/orders` → SSE 连接 → 200/400/600ms 3×`GET /api/t4/orders/ORD-T4-1` | `order.status` pending→paid→fulfilled（cause=响应/SSE/轮询） | 创建订单；+200 paid、+400 fulfilled |
| `#t4n-retry` 点击 / `retryOrder()` | `kind:click|api`、`target:#t4n-retry`、**同一** `idempotencyKey`、`requestIds[POST,…]` | 1×`POST /api/t4/orders`（同 key）→ 成功后 SSE + 3×轮询 | `error` 清空、`order.status` | `fail-order` 第二次成功且 `retried:true` |
| `#t4n-cancel-order` 点击 / `cancelOrder()` | `kind:click|api`、`target:#t4n-cancel-order` | 1×`POST /api/t4/orders/ORD-T4-1/cancel` | `order.status`→cancelled | 终态；清定时器；SSE 推 `cancelled` 后关流 |
| `#t4n-reset` 点击 / `reset()` | 无新 op（清空账本） | 1×`POST /api/t4/reset`（内部，不记账） | 账本清空、`ws.state/sse.state=closed` | 全部状态清空 |
| `setScenario(name)` | 无新 op（清空账本） | 1×`POST /api/t4/reset`（内部，不记账） | 账本清空、按场景重连通道 | 按场景重置 |
| 页面加载（boot） | `kind:api`、`target:#t4n-cart-refresh` | 1×`POST /api/t4/reset`（内部）→ 1×`GET /api/t4/cart` | `cart.count` 0→0（无变化） | 重置后读取空购物车 |

`#t4n-qty`/`#t4n-qty-dec`/`#t4n-qty-inc` 只改本地 `qty`（1..9），不发请求；下次加购使用该数量。

## 5. `window.__t4.net`（页面侧真值，不依赖 CDP）

| 字段 | 说明 |
| --- | --- |
| `version` / `fixture` | `1` / `"web-t4-network"` |
| `runId` / `traceId` | `"t4-run-1"` / `"t4-trace-1"` |
| `scenario` | 当前场景名（`body[data-t4n-scenario]` 同步） |
| `ops` | `[{opId:"op-N", kind:"click|input|api", target, atMs, atWallMs, traceId, idempotencyKey, requestIds:[]}]`，按发生顺序 |
| `requests` | `[{requestId:"t4-req-N", opId, method, url, atMs, atWallMs, status, ok, duplicate, retried, traceId, idempotencyKey, durationMs, error:{code}|null}]`，按发起顺序；`duplicate`=响应 `deduped`，`retried`=响应 `retried` |
| `responses` | `[{requestId, atMs, atWallMs, status, traceId, deduped, body}]`（`body` 为解析后的 JSON 或 null） |
| `ui` | `[{key:"cart.count|cart.revision|order.status|error|ws.state|sse.state", from, to, atMs, atWallMs, cause:{kind:"op|request|response|ws|sse|poll", id}}]`；**只在值变化时记录一次** |
| `ws` | `{state:"open|closed|disabled", frames:[{direction:"in|out", type, data, frameId, atMs, atWallMs}]}`；`frameId` 是附加字段（`cart-updated` 帧为 `ws-frame-1`，见 §7.5） |
| `sse` | `{state:"open|closed|disabled", events:[{type:"order", data:{orderId,status,atWallMs}, id, atMs, atWallMs}]}` |
| `polls` | `[{requestId, orderId:"ORD-T4-1", atMs, atWallMs}]`（响应到达时记录，最多 3 条） |
| `errors` | `[{atMs, atWallMs, code:"CART_REJECTED|ORDER_REJECTED|…", requestId}]` |
| `serverLedgerUrl` | `"/api/t4/ledger?runId=t4-run-1"` |
| `methods` | `{state, reset, setScenario, addToCart, checkout, retryOrder, cancelOrder, snapshot}`；同名方法也直接挂在 `__t4.net` 上（`__t4.net.state()` 等） |

附加（不在冻结形状内，只增不改）：`snapshot()` 在 `state()` 基础上追加 `cart{count,revision,items}`、
`order{orderId,status,total}`、`qty`、`ready`；`ws.frames[].frameId` 供 `ui` cause 引用。

### 5.1 方法语义（`browser_eval` 可调，全部返回 Promise<普通对象>，不抛到页面）

- `state()`：冻结形状的深拷贝（函数省略）。
- `snapshot()`：`state()` + 当前 `cart/order/qty/ready`。
- `reset()`：`POST /api/t4/reset`（当前场景）+ 清空本地账本；**关闭 WS/SSE 且不自动重连**（见 §10）。
- `setScenario(name)`：校验场景 → `POST /api/t4/reset {scenario}` → 清空本地账本 → 按场景重连 WS →
  `ws.state=disabled`（`no-ws`）。未知场景返回 `{ok:false,error:{code:"INVALID_SCENARIO"}}`，不改状态。
- `addToCart({qty=1, double=false})`：生成 op；`double:true` 时串行发 2 个同 key 的 `POST /api/t4/cart`，
  然后 1 个 `GET /api/t4/cart` 刷新。
- `checkout()`：已存在未取消订单时直接返回 `{ok:true,alreadyOrdered:true}`（不发请求）；否则
  `POST /api/t4/orders`（固定 key `t4-idem-order-1`），成功后开 SSE + 3 次固定轮询。
- `retryOrder()`：同 key 重发 `POST /api/t4/orders`，成功后开 SSE + 轮询。
- `cancelOrder()`：`POST /api/t4/orders/ORD-T4-1/cancel`（无订单返回 `{ok:false,error:{code:"NO_ORDER"}}`）。

### 5.2 请求头（每个业务请求）

```text
x-request-id: t4-req-<n>        # 每请求唯一；服务端账本按它对齐
x-trace-id:   t4-trace-1        # 整轮固定
x-op-id:      op-<n>            # 触发它的 UI/API 操作
x-idempotency-key: <key>        # POST: op 级 key（cart: t4-idem-cart-<n>；orders: t4-idem-order-1）
                                # GET : t4-idem-get-<n>（占位，服务端只在 POST 上做幂等）
```

## 6. 场景

场景由 `?scenario=` 或 `setScenario(name)` 设置；切换会**同时**重置服务端状态与本地账本（逻辑 t=0），
并按新场景重连通道。未知场景 → 400 `INVALID_SCENARIO`。

| 场景 | WS | SSE | 轮询 | 业务差异 |
| --- | --- | --- | --- | --- |
| `normal` | 开 | 开 | 3 次 | 全部正常 |
| `no-ws` | **不连接**（`ws.state=disabled`；服务端也不推 `cart-updated`） | 开 | 3 次 | 购物车无远程加购 |
| `no-sse` | 开 | **不打开**（`sse.state=disabled`） | 3 次 | 订单状态只由轮询推进 |
| `poll-off` | 开 | 开 | **不轮询**（`polls=[]`） | 订单状态只由 SSE 推进 |
| `dup` | 开 | 开 | 3 次 | 与 `normal` 相同；供 `addToCart({double:true})` 使用 |
| `fail-cart` | 开 | 开 | 3 次 | 所有 `POST /api/t4/cart` → 500 `CART_REJECTED` |
| `fail-order` | 开 | 开 | 3 次 | `POST /api/t4/orders` 每个 key 第 1 次 → 500 `ORDER_REJECTED`；同 key 第 2 次成功 `retried:true` |
| `slow-order` | 开 | 开 | 3 次 | `POST /api/t4/orders` 延迟 800ms 后成功 |

## 7. 时序与确定性

### 7.1 加入购物车（点击 / `addToCart`）

```text
t0      op-N 生成（kind=click|api, target=#t4n-add-cart, idempotencyKey=t4-idem-cart-K）
t0      POST /api/t4/cart (x-request-id=t4-req-A) → 200 {code:0, cart, deduped:false}
        （double:true 时第二个 POST /api/t4/cart 同 key → 200 {deduped:true}，cart 不变）
t1      GET /api/t4/cart (t4-req-B) → 200 {cart}
t1      applyCart(cart, cause={kind:"response", id:"t4-req-B"}) → 仅当 count/revision 变化才记 ui
```

### 7.2 结算链路

```text
t0      POST /api/t4/orders (t4-req-C, key=t4-idem-order-1) → 200 {order{status:pending}}
t0+     applyOrder(pending, cause={response,t4-req-C})
t0+     SSE open  GET /api/t4/order-events?orderId=ORD-T4-1
        SSE: id1 pending(立即) → id2 paid(+200ms) → id3 fulfilled(+400ms) → +600ms 关流
t0+200  poll#1 GET /api/t4/orders/ORD-T4-1（记录 polls[0]）
t0+400  poll#2 GET …（polls[1]）
t0+600  poll#3 GET …（polls[2]）
```

- 服务端订单状态由**创建时刻**起的定时器推进：+200ms `paid`、+400ms `fulfilled`（`cancelled` 为终态）。
- GET 与 SSE 读同一个状态：谁先到谁更新 UI，**相同值不产生第二次 transition**。
- SSE 的 3 条事件时间相对 **SSE 连接打开**，不是订单创建；两者相差一个 POST 往返（本机 <10ms）。
- 浏览器 `EventSource` 在服务端关流后会触发一次 `error`；页面随即 `close()` 并把 `sse.state` 置
  `closed`（不自动重连）。

### 7.3 幂等 / 重复 / 重试

- `POST /api/t4/cart`：同 `x-idempotency-key` 第二次返回**同一** cart 快照 + `deduped:true`，不重复加购。
- `POST /api/t4/orders`：同 key 第二次返回同一订单 + `deduped:true`；`fail-order` 下第 1 次 500（不入幂等缓存），
  第 2 次成功并 `retried:true`。
- 重试 op 与失败请求共享 `traceId` 与 `idempotencyKey`；`ops[].requestIds` 指向新请求。
- 订单是每 fixture 实例的单例：不同 key 再 POST 也返回 `ORD-T4-1`（`deduped:true`），不产生第二个订单。

### 7.4 轮询

- 固定 3 次，间隔 200/400/600ms（相对 `POST /api/t4/orders` 成功返回）；`poll-off` 时 0 次。
- 每次都是 `GET /api/t4/orders/ORD-T4-1`（同 URL），并记入 `polls` 与 `requests`（`opId`=结算/重试 op）。
- 轮询不取消、不重发；页面不因轮询失败而崩溃。

### 7.5 WS（`/t4/ws?runId=t4-run-1`）

```text
open    服务端立即推 {"type":"hello","runId":"t4-run-1","scenario":…,"atWallMs":…}
client  {"type":"ping","nonce":"t4-ping-1"}  → 服务端 {"type":"pong","nonce":…,"atWallMs":…}
+400ms  服务端加购 sku-t4-remote ×1（cart count+1、revision+1），推
        {"type":"cart-updated","frameId":"ws-frame-1","sku":"sku-t4-remote","qty":1,"cart":{…},"atWallMs":…}
```

- 每个连接只推**一次** `cart-updated`（`client.remotePushed`），不重复；重连（`setScenario`）会得到新的
  hello + 新的 `cart-updated`。
- 页面收到 `cart-updated` 后更新徽标并记 `ui.cart.count` cause=`{kind:"ws", id:"ws-frame-1"}`。
- 未知客户端文本帧 → `{"type":"echo","data":…}`；裸文本 `ping` → `pong`；close/ping 控制帧按 RFC 处理。
- `no-ws` 场景页面不连接；即使手工连上，服务端也不推 `cart-updated`（避免污染购物车基线）。

## 8. 错误码

| 码 | 来源 | 触发 |
| --- | --- | --- |
| `CART_REJECTED` | 服务端 500 / `errors[].code` | `fail-cart` 场景的所有 `POST /api/t4/cart` |
| `ORDER_REJECTED` | 服务端 500 / `errors[].code` | `fail-order` 场景中每个 key 的第一次 `POST /api/t4/orders` |
| `ORDER_NOT_FOUND` | 服务端 404 | `GET /api/t4/orders/<unknown>` 或 cancel 未知订单 |
| `INVALID_ARGUMENT` | 服务端 400 | 请求体不是合法 JSON |
| `INVALID_SCENARIO` | 服务端 400 / `setScenario` 返回值 | 未知场景名 |
| `NETWORK_ERROR` | 页面 `requests[].error.code` | fetch 本身失败（本机正常链路不会出现） |
| `HTTP_<status>` | 页面 `requests[].error.code` | 非 2xx 且响应无 `error.code` 时的兜底 |

错误传导：失败时 `#t4n-error` 可见且文本含错误码；`ui` 记 `error` transition（cause=`{kind:"request", id:requestId}`）；
`errors[]` 记 `{code, requestId}`；`#t4n-retry` **仅**在订单创建失败后可见，成功/重试后隐藏。

## 9. 时间、确定性与容差

- `atMs` = 页面启动后的相对毫秒（逻辑时钟，`Date.now() - bootWallMs`）；`atWallMs` = `Date.now()`。
  **只断言 `atMs/atWallMs` 的类型与单调/相对关系，不断等值**。
- 固定定时器：WS `hello` 立即、`cart-updated` +400ms；订单状态 +200/+400ms；SSE 0/+200/+400/+600ms；
  轮询 200/400/600ms；`slow-order` 800ms。
- 验收容差：`slow-order` 断言浏览器事件 `durationMs ≥ 700`（服务端 800ms，留 100ms 余量）；SSE/轮询只断言
  “至少 2 条 SSE / 恰好 3 次轮询 / 最终状态 ∈ {paid, fulfilled}”，不写死毫秒级相等。
- 计数器（`requestId`/`opId`/`idempotencyKey`）每次重置（boot / reset / setScenario）从 1 重新开始；同一
  流程内的编号是确定的。
- 同一 `scenario + 操作序列` 在**同一页面实例**内产生相同真值；跨进程只保证结构相同，不保证 `atWallMs` 相同。

## 10. 限制与已知边界（如实）

1. **`reset()` 关闭通道且不自动重连**：为了“重置后页面账本为空”可断言，`reset()` 之后 WS/SSE 保持
   `closed`（`ws.state=closed`），不会在 400ms 后再推 `cart-updated`。需要通道时用 `setScenario()`（会重连）
   或重新打开页面。`#t4n-reset` 按钮同此语义。
2. **页面加载即重置服务端**：boot 会 `POST /api/t4/reset`（内部请求，不进账本），因此同一 fixture 上
   重复打开页面得到同一初始状态；这也意味着“先手工调 API 再打开页面”会被清掉。
3. **`slow-order` 的 800ms 在订单创建之前**：延迟结束后才创建订单并启动 +200/+400ms 状态定时器；
   因此总可见时延约 800ms + 600ms。
4. **SSE 时间轴相对 SSE 连接**，不是订单创建；`no-sse` 下订单状态只由轮询推进，`poll-off` 下只由 SSE 推进。
5. **远程加购与主商品同价（4200）**：订单 `total` = 创建时 Σ `price*qty`，因此包含 WS 远程商品；
   验收用“相对增量”和“服务端账本快照”断言，不假设绝对金额。
6. **订单是每 fixture 实例的单例**：不同 idempotencyKey 再 POST 也返回同一 `ORD-T4-1`（`deduped:true`）。
7. **`cancelled` 是终态**：取消后不再推进 `paid/fulfilled`；已 `fulfilled` 的订单仍可被取消（fixture 允许，
   取消是唯一终态），取消会关掉该订单的 SSE 流。
8. **`/api/t4/ledger` 与 `/api/t4/reset` 不记账**：这是为了让“重置后账本清空”“浏览器真值 vs 账本请求数一致”
   可断言；诊断读取不计入业务链路。
9. **WS 只支持文本帧**（hello/cart-updated/pong/echo），不支持二进制；单帧上限 64 KiB。
10. **无 HTTPS / 无真实凭据 / 无外网**：靶机只用于本机验收，不模拟真实支付、库存、鉴权。
11. **页面在 1280×800 默认视口内完整可见**（无滚动），因此 `browser_screenshot` 默认截图即整页；若改视口
    需自行确认整页覆盖。
12. **准备阶段 ≠ 能力上线**：本靶机与验收只证明“T4 准备资产就绪、现有 P0 网络工具能观测这条业务链”，
    **不**代表 T4 动态视觉/动态网络能力已实现；`browser_capabilities` 中 T4 仍 `unsupported`、工具面仍 30。

## 11. 验收映射（N1–N15）

| 编号 | 覆盖内容 | 主要真值来源 |
| --- | --- | --- |
| N1 | 标题/24 个稳定 id/version/runId/traceId/初始 cart 0/无跨源请求 | DOM + `__t4.net` + 网络事件 |
| N2 | 初始 `GET /api/t4/cart`、WS 握手与帧可见 | 网络事件 + `detail.ws` |
| N3 | 点击加购 → `POST`+`GET`、200、`x-trace-id`/`x-request-id` 同组 hash | `ops/requests` + 网络事件 + `detail.correlation` |
| N4 | cart 增量、`ui` cause、服务端账本同 requestId/traceId | `__t4.net` + `/api/t4/ledger` |
| N5 | `dup` 双发：2×POST 同 key、第二条 deduped、cart 只 +1、UI 一次变化 | `__t4.net` + 账本 |
| N6 | 结算：orders 200、SSE pending/paid/fulfilled、3 次轮询、UI 最终态 | `__t4.net` + 网络事件 |
| N7 | WS `cart-updated` → 徽标、`ui.cause{ws}`、真值与网络帧一致 | `__t4.net.ws` + `detail.ws` |
| N8 | `fail-cart`：500 `CART_REJECTED`、横幅、`ui.error.cause` | `__t4.net` + DOM + 网络事件 |
| N9 | `fail-order`：500 `ORDER_REJECTED` → 同 key 重试 `retried:true` 成功 | `__t4.net` + 账本 |
| N10 | `slow-order`：duration ≥700ms、最终 UI 更新 | 网络事件 + `__t4.net` |
| N11 | 步骤 counters 含 http/ws/sse、correlation ≥3、causality 无 temporal | `trace.query` + `detail.correlation` |
| N12 | 账本 method/path/status/traceId/key 一致、seq 单调 | `/api/t4/ledger` + `__t4.net` |
| N13 | 重置：server/页面账本清空、再购 revision 1 | `/api/t4/reset` + `__t4.net.reset()` + 账本 |
| N14 | 错误态/订单完成态整页 PNG、sha256/尺寸/路径 | `browser_screenshot` 证据 + 磁盘 |
| N15 | T4 unsupported、工具面 30、无 T4 工具 | `browser_capabilities` + 注册表 |
