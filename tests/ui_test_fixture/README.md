# tests/ui_test_fixture — 明确授权的本地 Web 靶机

这是 **`dsh-agent-team-ui-testing` 插件 Web 验收专用的本地靶机**（T1/T2/T3、P0 与 WEB-T4 准备靶机），由本仓库自行编写并明确授权被测 Agent 访问。它**不是**外网站点、不是用户数据、也不包含任何真实凭据。

## 性质与边界

- 零依赖：只用 Node.js 内置 `node:http` / `node:fs` / `node:url`，不装任何 npm 包。
- 离线确定：页面与接口内容全部写死，无随机数、无外部请求、无第三方 CDN、无字体/图片外链。
- 只监听 `127.0.0.1`，端口用 `0` 由内核分配（每次运行不同，不会撞端口）。
- 供 `tests/acceptance/` 的验收探针驱动；也可以手工启动后用插件面板/工具调试。

## 启动

```bash
# 独立启动（前台运行，Ctrl+C 退出）
node tests/ui_test_fixture/server.mjs
# 打印：FIXTURE_URL=http://127.0.0.1:<随机端口>/

# 在验收脚本里以编程方式启动（推荐）
node -e "import('./tests/ui_test_fixture/server.mjs').then(async (m) => { const f = await m.startFixtureServer(); console.log(f.url); await f.close(); })"
```

## 接口（全部确定性）

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/health` | `200 {"ok":true,"status":"healthy","fixture":"dsh-ui-testing"}` |
| GET | `/api/data` | `200 {"message":"fixture-data-ok","items":[1,2,3],"source":"dsh-ui-testing-fixture"}` |
| GET | `/api/error` | `500 {"error":"fixture-internal-error","status":500}` |
| GET | `/api/slow?ms=N` | 延迟 `min(N,5000)` ms 后 `200 {"delayed":true,"ms":N}` |
| POST | `/api/echo` | `200 {"method":"POST","echo":<JSON 解析后的 body，失败则为原文>}` |
| GET | `/missing` | `404 {"error":"not-found","status":404}` |
| GET | `/redirect` | `302`，固定 `Location: /second.html?from=redirect#landed`，`Cache-Control: no-store`；无自由 `to` 参数（不可变成开放重定向） |
| GET | `/`、`/index.html` | 主页面 `index.html` |
| GET | `/second.html` | 第二页 `second.html` |
| GET | `/web-t2.html` | **T2 主页面** `web-t2.html`（结构化输入契约页，见下节） |
| GET | `/web-t2-second.html` | **T2 第二页** `web-t2-second.html`（跨页/独立 instrument 契约） |
| GET | `/capture-p0.html` | **P0 截图真值页** `capture-p0.html`（固定 CSS 盒/颜色/条纹，见 §P0） |
| GET | `/blank.html` | **P0 空白页** `blank.html`（纯白 body，用于空白识别告警） |

`pushState` / `replaceState` / `location.hash` / GET 搜索表单等地址栏验收场景由测试脚本经插件 `/eval` 在页面内临时安装，不改本仓库页面文件；`/redirect` 是唯一为地址栏验收新增的固定路由。

**网络验收靶机**（T1 网络采集 / `browser_http_request` 等）另有 21 条 `/n/*` 确定性路由、两个页面与一个 Worker 脚本，逐项真值见 §NET：`/n/json`、`/n/echo`、`/n/status/*`、`/n/slow`、`/n/redirect/{1,2}`、`/n/final`、`/n/gzip`、`/n/chunked`、`/n/large`、`/n/sse`、`/n/ws`、`/n/poll`、`/n/flaky`、`/n/token`、`/n/cors`、`/n/worker.js`、`/n/worker-data`、`/n/iframe.html`、`/n/iframe-data`；页面 `/web-network.html`、`/web-network-frame.html`、`/web-network-oopif.html`。

**电商业务链路靶机**：5 个真实 MPA 页面 `/shop/{products,product,order,checkout,orders}.html` + `/api/shop/*`（`products` / `products/:id` / `orders`(GET·POST) / `orders/status` / `orders/list` / `checkout` / `reset`）+ 共用记账脚本 `/shop/shop-ledger.js`；冻结 `runId=chain-1`、订单号 `ORD-chain-1-1`，逐项真值见 §SHOP。

**WEB-T4 准备靶机（仅准备资产；T4 仍未实现、工具面仍 30）**：两套确定性靶机与独立真值表——

- `/web-t4-visual.html`：CSS/DOM、Canvas 2D、WebGL/WebGPU、动态媒体四卡，逻辑时钟暂停/seek、五场景（normal/flash/freeze/jank/media-stall）、`window.__t4.visual` 真值；见 [t4-visual.md](t4-visual.md)。
- `/web-t4-network.html` + `/api/t4/*` + `/t4/ws`：单页电商链路（加入购物车→GET 刷新→结算→订单更新），含幂等重复、失败重试、慢请求、轮询、SSE、WS、错误→UI 传导与 `window.__t4.net` + 服务端账本双真值；见 [t4-network.md](t4-network.md)。
- 冻结口径：[t4-prep-contract.md](t4-prep-contract.md)；验收：`flock /tmp/dsh-t4-browser.lock node tests/acceptance/t4-visual-fixtures.mjs` / `... t4-network-fixtures.mjs`。两套只证明靶机与证据链可用，**不注册 T4 工具、不改变 30 工具能力面**。

## 页面断言值（验收脚本依赖，改动页面必须同步改 `tests/acceptance/run.mjs`）
`index.html`：

- `#counter`：初始文本固定为 `"0"`；点击 `#inc` 一次后变为 `"1"`。
- `#style-target`：固定计算样式，用于 `browser_computed_style` 断言：
  - `color: rgb(220, 38, 38)`
  - `font-size: 16px`
  - `font-weight: 700`
  - `padding-top: 12px`、`padding-left: 16px`
- `#name`（输入框）、`#submit`（按钮）、`#result`：点击提交后 `#result` 为 `"hello <name>"`；空名字为 `"empty-name"`。
- `#fetch-btn` → `#fetch-result`：点击后显示 `/api/data` 的 `message`（`fixture-data-ok`），并在 `body.dataset.fetchStatus` 写入状态码。
- 页面加载时**自动**发起一次 `GET /api/data`，并把 `fixture-data-ok` 写入 `body.dataset.autoload`，供 `browser_network` 断言。
- `?token=DEMO_TOKEN_NOT_REAL`：页面把 query 里的 token 写入 `window.__fixture.token` 与 `body.dataset.token`。它**只是假 token**，用于验证运行时网络记录是否脱敏（不用于任何鉴权）。

`second.html`：

- `<title>` 固定为 `DSH UI Testing Fixture — Second Page`，`#second-marker` 文本为 `second-page`。

## T2 页面契约（`/web-t2.html`、`/web-t2-second.html`）

> 这两页是为 **Web T2（结构化输入）验收**新增的确定性靶机页面。`tests/acceptance/t2-structured.mjs` **逐条依赖**下表中的 id、初始值与交互后的精确文本/状态；改动其中任何一项，都必须同步修改该验收脚本。
> 实测口径：本机无头 Chromium，视口 `1280×800`；`document.compatMode === "CSS1Compat"`，`document.documentElement.scrollHeight === 2687`（2026-11-01 压缩用例区新增后；此前为 2404）。页面加载有 0 个跨源请求（`extraRequests === []`）。

### T2.1 标题与结构

| 选择器 | 初始值 / 文本 | 说明 |
| --- | --- | --- |
| `<title>` | `DSH T2 Fixture` | 用于 `browser_state` / 标签标题断言 |
| `#t2-title`（h1） | `DSH T2 Fixture` | 页面唯一 h1 |
| `main#main` | — | 唯一的 `<main>`，包含全部 T2 区块 |
| `#t2-heading-2`（h2） | `Structure` | 页面共 7 个 h2：`Structure` / `Form` / `Interactions` / `States` / `Overlay / hit test` / `Scroll` / `Shadow DOM` |
| `#t2-heading-3`（h3） | `List and table` | 页面唯一 h3 |
| `#t2-nav` | 2 个链接 | `#t2-nav-first` → `/index.html`（文本 `T1 fixture page`）；`#t2-nav-second` → `/web-t2-second.html`（文本 `T2 second page`） |
| `#t2-list` | 40 个 `<li>` | 文本固定为 `Item 1` … `Item 40`（无标点、无前后空格） |
| `#t2-table` | `thead` + 2 行 `tbody` | `thead` 单元格文本 `Name` / `Value`；`tbody` 两行为 `alpha`/`1`、`beta`/`2` |
| `#t2-long-text` | **恰好 300 字符** | 单行文本，全文见 §T2.8 |

### T2.2 表单（`#t2-form`）

`#t2-form` 的 `submit` 处理器一律 `preventDefault()`，并把 JSON 摘要写入 `#t2-output` 的**文本**，同时置 `document.body.dataset.t2Submitted = "1"`。`#t2-name`、`#t2-email` 带原生 `required`，空表单点击 `#t2-submit` 时浏览器原生校验会拦截提交：不会触发 `submit` 事件，`#t2-output` 保持 `not-submitted`，也不会出现任何弹窗/对话框。

| 选择器 | 类型 / 初始值 | 说明 |
| --- | --- | --- |
| `#t2-form` | `action="/web-t2.html" method="get"` | 提交被脚本阻止，URL 不变（`location.pathname` 仍为 `/web-t2.html`） |
| `#t2-name` | `type=text required`，初始 `""` | 有 `<label for="t2-name">Name</label>` |
| `#t2-email` | `type=email required`，初始 `""` | `<label for="t2-email">Email</label>` |
| `#t2-bio` | `<textarea rows="2" cols="30">`，初始 `""` | `<label for="t2-bio">Bio</label>` |
| `#t2-agree` | `checkbox`，初始 `false`（未勾选） | `<label for="t2-agree">I agree to the fixture terms</label>` |
| `#t2-plan-basic` | `radio name="t2-plan" value="basic"`，**初始 checked** | 组内共 2 个（`[name="t2-plan"]` 计数为 2） |
| `#t2-plan-pro` | `radio name="t2-plan" value="pro"`，初始未选 | — |
| `#t2-country` | 原生 `<select>`，初始 `"us"` | 选项：`us`=`United States`、`cn`=`China`、`de`=`Germany` |
| `#t2-tags` | `<select multiple size="3">`，初始**无选中**（`selectedOptions.length === 0`） | 选项：`a`=`Tag A`、`b`=`Tag B`、`c`=`Tag C` |
| `#t2-volume` | `type=range min="0" max="100" value="30"` | 初始 `value === "30"`；`min`/`max` 属性为 `"0"`/`"100"` |
| `#t2-volume-value` | 文本 `30` | range 的镜像读数，随 `input` 事件更新为当前 `value` |
| `#t2-submit` | `type=submit`，文本 `Submit form` | 真实点击会触发一次 `submit`（`submit` **不在** `__t2` 事件白名单内，用 `#t2-output` / `body.dataset.t2Submitted` 断言） |
| `#t2-readonly` | `readonly`，值 `readonly-value` | 只读：Focus/插入文本后值不变 |
| `#t2-disabled` | `disabled`，值 `disabled-value` | 不可聚焦（`focus()` 不改变 `document.activeElement`） |
| `#t2-disabled-btn` | `disabled`，文本 `Disabled action` | 结构化点击必须判定为不可交互 |
| `#t2-output` | 初始文本 `not-submitted` | 提交后为 JSON 摘要（键顺序固定，见下） |

JSON 摘要的键顺序与取值（`JSON.stringify` 结果**逐字符稳定**）：

```
{"name":<#t2-name.value>,"email":<#t2-email.value>,"bio":<#t2-bio.value>,"agree":<#t2-agree.checked>,"plan":"basic"|"pro"|null,"country":<#t2-country.value>,"tags":[<#t2-tags.selectedOptions 的 value，按 DOM 顺序>],"volume":<Number(#t2-volume.value)>,"readonly":"readonly-value"}
```

- 默认值下（未输入）的结果：`{"name":"","email":"","bio":"","agree":false,"plan":"basic","country":"us","tags":[],"volume":30,"readonly":"readonly-value"}`。
- 典型用例（name=`T2 Tester`、email=`t2@example.test`、bio=`bio text`、勾选 agree、保留 basic、选 `cn`、选中 `a`、range 拖到 ~81）：`{"name":"T2 Tester","email":"t2@example.test","bio":"bio text","agree":true,"plan":"basic","country":"cn","tags":["a"],"volume":81,"readonly":"readonly-value"}`。
- `volume` 是**数字**（`Number(...)`），不是字符串。

### T2.3 交互

| 选择器 | 初始状态 | 交互后的精确结果 |
| --- | --- | --- |
| `#t2-counter` | 文本 `0` | 每点击一次 `#t2-inc` 加 1：`1`、`2` …（纯十进制字符串，无前后缀） |
| `#t2-inc` | 文本 `Increment` | 真实点击一次后 `#t2-counter === "1"` |
| `#t2-toggle` | `aria-expanded="false"`，文本 `Toggle panel` | 第 1 次点击：`aria-expanded="true"` 且 `#t2-panel` **移除** `hidden`；第 2 次点击：回到 `"false"` 且 `hidden` 重新加上 |
| `#t2-panel` | 带 `hidden` 属性，文本 `panel body text` | 见上；展开时 `textContent === "panel body text"` |
| `#t2-async` | 文本 `Start async` | 点击后立即把 `#t2-async-result` 置为 `pending` |
| `#t2-async-result` | 文本 `idle` | 点击 250 ms 后变为 `async-done`（测试建议等 400 ms 再断言） |
| `#t2-live` | `role="status" aria-live="polite"`，初始空文本 | 每次 async 完成**追加**文本 `saved`：第 1 次 `saved`，第 2 次 `saved saved` |
| `#t2-save-1` / `#t2-save-2` | 都是 `.t2-save`，可访问名**完全相同**都为 `Save` | 用于「同名元素唯一性/歧义」测试；点击后 `#t2-save-result` 变为被点按钮的 id（`t2-save-1` / `t2-save-2`） |
| `#t2-save-result` | 文本 `none` | 见上 |
| `#t2-editable` | `<span contenteditable="true">`，文本 `editable text` | 输入直接反映到 `textContent`（例：追加 `!` 后为 `editable text!`） |

### T2.4 状态

| 选择器 | 初始状态 | 断言要点 |
| --- | --- | --- |
| `#t2-hidden` | 计算样式 `display: none` | 其内 `#t2-hidden-btn` 文本 `Hidden action`；实测 `getBoundingClientRect()` 全 0 且 `offsetParent === null` → 不可命中、不可交互 |
| `#t2-aria-hidden` | `aria-hidden="true"` | 文本 `aria hidden text`（语义树里应被排除，但 DOM 可读） |
| `#t2-checked` | `checkbox`，初始 **checked** | 「已是选中态」用例 |
| `#t2-selected-tab` | `role="tab"` + `aria-selected="true"` | 文本 `Selected tab`；同组 `#t2-unselected-tab` 为 `role="tab"` + `aria-selected="false"` |
| `#t2-tablist` | `role="tablist"` | 上面两个 tab 的容器 |
| `#t2-long-text` | 300 字符长文本（见 §T2.8） | 长文本不截断、跨次运行逐字符相同 |

### T2.5 遮挡 / 命中测试

| 选择器 | 说明 |
| --- | --- |
| `#t2-stack` | `position: relative` 的定位容器（240×44） |
| `#t2-covered` | `<button>`，文本 `Covered action`，几何 `240×44` |
| `#t2-overlay` | `position: absolute; inset: 0`，文本 `overlay`，几何 `240×44`，与 `#t2-covered` **完全重合**；`pointer-events` 保持默认 `auto` |

断言值（实测）：

- `document.elementFromPoint(被遮挡按钮中心)` 返回 `#t2-overlay`（不是 `#t2-covered`）。
- 真实点击投放到该坐标时，`window.__t2` 记录的 `click` 目标是 `t2-overlay`，`#t2-covered` 收不到任何事件 → 结构化工具必须判定 "not interactable / 被遮挡"。

### T2.6 滚动

| 选择器 | 说明 |
| --- | --- |
| `#t2-scroll-box` | 计算高度 **200px**、`overflow: auto`；实测 `clientHeight === 200`、`scrollHeight === 1216`、最大 `scrollTop === 1016` |
| `#t2-scroll-content` | 高度 **1200px**（`getComputedStyle(...).height === "1200px"`） |
| `#t2-page-spacer` | 高 154px 的页底占位，使整页 ≈ 2400px |
| `#t2-page-end` | 文本 `page-end`，位于文档最底部 |

断言值：`document.documentElement.scrollHeight === 2687`（1280×800 视口实测，跨次稳定；`#t2-compression-section` 与固定定位的 `#t2-moving-track` 加入后从 2404 增长）；把 `#t2-scroll-box.scrollTop` 设为 `400` 会产生一条 `scroll` 记录 `{type:"scroll", target:"t2-scroll-box", scrollTop:400, isTrusted:true}`；页面滚动记录 `target:"document"` 且 `scrollTop === window.scrollY`。

### T2.7 Shadow DOM

| 选择器 / 对象 | 说明 |
| --- | --- |
| `<t2-widget>` | 自定义元素，`connectedCallback` 里 `attachShadow({mode:"open"})`（`shadowRoot.mode === "open"`） |
| shadow 内 `#shadow-btn` | 文本 `Shadow Action`；需经 `document.querySelector("t2-widget").shadowRoot.getElementById("shadow-btn")` 或 uia 穿透伪元素定位 |
| `#t2-shadow-result` | 光 DOM 可见结果文本，初始 `not-clicked`；每次点击阴影按钮 → `Shadow clicked 1`、`Shadow clicked 2` … |
| `window.__t2.shadow` | `{clicks, trustedClicks, lastTrusted}`：阴影内点击同样记录 `event.isTrusted`；真实注入点击会同时增加 `clicks` 与 `trustedClicks`，`element.click()` 只增 `clicks` 且 `lastTrusted === false` |

事件归属：阴影内的点击冒泡到 window 时 target 会被**重定向为宿主**，因此 `window.__t2` 里看到的条目是 `{type:"click", target:"t2-widget"}`；阴影内按钮本身收到的事件（含 `isTrusted`）记在 `window.__t2.shadow`。

### T2.8 长文本（`#t2-long-text`，恰好 300 字符）

```
The T2 fixture long text block is deterministic: exactly three hundred characters, identical on every run. It exists so a structured read can be compared character by character, proving that long text is returned in full, that whitespace stays intact, and that nothing is truncated. End of the block.
```

### T2.9 事件插桩 `window.__t2`

两页都有同构的 `window.__t2`（第二页没有 `shadow` 字段）：

| 字段 / 方法 | 类型 | 说明 |
| --- | --- | --- |
| `events` | `Array` | 环形缓冲，只保留**最新 300** 条（`maxEvents === 300`，超出时丢弃最旧），数组标识不变（`reset()` 清空而不换引用） |
| `seq` | `number` | 累计记录数（不因缓冲上限回退）；`reset()` 置 0 |
| `maxEvents` | `number` | 固定 `300` |
| `types` | `string[]` | 白名单类型列表（见下） |
| `summary()` | `() => {[type]: number}` | 返回**零值补齐**的 13 个类型的计数映射（未发生的类型为 `0`，不是 `undefined`） |
| `reset()` | `() => void` | 清空 `events`、`seq` 归零、（主页）阴影计数归零 |
| `shadow`（仅主页） | `{clicks, trustedClicks, lastTrusted}` | 见 §T2.7 |

记录的事件类型（13 个，全部以 window 捕获阶段监听，因此也能看到不冒泡的 `scroll` 与阴影内被重定向的事件）：
`pointerdown`、`mousedown`、`mouseup`、`click`、`dblclick`、`contextmenu`、`keydown`、`keyup`、`input`、`change`、`scroll`、`focusin`、`focusout`。

> `dblclick` 是 T2 验收（`tests/acceptance/t2-structured.mjs` C14「double click 两 click/一 dblclick」）所需的追加记录类型；T1 页面不使用 `window.__t2`，因此不影响 T1 断言。

单条记录结构：

```js
{
  type: "click",                 // 类型
  isTrusted: true,               // 直接取 DOM 事件的 isTrusted：真实注入 true，element.click() false
  target: "t2-inc",              // 元素 id；无 id 时退化为 `role:名称` 或 `tag:文本前 40 字` 或 `tag`
  key: null,                     // keydown/keyup 为 e.key，其余为 null
  modifiers: { ctrl: false, shift: false, alt: false, meta: false },
  value: "30",                   // 目标当前 value（contenteditable 为文本），截断到 60 字符；multi-select 用 `,` 连接
  scrollTop: 400,                // 仅 type === "scroll"：元素 scrollTop 或 window.scrollY
  ts: 1730000000000              // Date.now() 毫秒
}
```

已实测的典型序列（可直接作为验收判据）：

| 场景 | 记录到的事件（按顺序） |
| --- | --- |
| 真实点击 `#t2-inc` | `pointerdown:true`、`mousedown:true`、`focusin:true`、`mouseup:true`、`click:true` |
| `#t2-inc.click()` 合成点击 | 仅 `click:false`（`isTrusted` 为 `false` —— 这是「必须证明是真实输入」的关键判据） |
| 真实点击 `<select multiple>` 的 `Tag A` 选项 | `pointerdown`/`mousedown`/`mouseup`/`click` 的 target 为 `option:Tag A`；`input`/`change` 的 target 为 `t2-tags` 且 `value === "a"`（全部 `isTrusted: true`） |
| 真实点击阴影内 `#shadow-btn` | window 侧记录 `click`，`target === "t2-widget"`（宿主重定向），`isTrusted: true` |
| 真实双击 `#t2-inc`（`clickCount:2`） | 两组 `pointerdown`/`mousedown`/`mouseup`/`click` + 1 次 `dblclick`，全部 `isTrusted: true` |
| `Ctrl+Shift+B` 按键 | `keydown` 的 `key === "b"`，`modifiers === {ctrl:true, shift:true, alt:false, meta:false}` |

注意：**`submit` 事件不在白名单内**（T2 契约只要求上述 13 类）；表单是否真的提交，用 `#t2-output` 的 JSON 文本与 `body.dataset.t2Submitted === "1"` 断言。

### T2.10 冗余文本压缩用例（2026-11-01，对应契约 §3.1.1 与 §9.4）

这一区只服务于「快照冗余文本压缩」的正负例；既有 id / 初始值 / 语义全部不变。

| 选择器 | 初始值 / 文本 | 契约要求（压缩后仍须成立） |
| --- | --- | --- |
| `#t2-compression-section` | `<h2>Compression cases</h2>` | 区块容器；h2 文本 `Compression cases` |
| `#t2-aria-label-btn` | `<button aria-label="Save">Save now</button>`，紧邻 `#t2-aria-label-result`（初始 `not-clicked`） | 可访问名来自 **aria-label**（`button "Save"`），可见子文本 `Save now` 与名字不同 → **两者都必须保留**，不得互相吞掉；点击后 `#t2-aria-label-result` 变为 `save-clicked` |
| `#t2-fragmented` | `<span>Alpha</span> <b>Beta</b> <i>Gamma</i>` | 分片文本按顺序拼接后必须是 `Alpha Beta Gamma`（空格不得丢、不得有损 normalize） |
| `#t2-same-text` | 两个独立的 `<span class="t2-same-text">Same</span>` | 两个同名 sibling 都必须保留（不做全局去重），最终树里 `text "Same"` 恰好 2 条 |
| `#t2-dup-buttons` | `#t2-same-btn-a` 与 `#t2-same-btn-b`，可访问名都是 `Duplicate`；`#t2-dup-result` 初始 `none` | 两个独立语义节点各自保留 + 各自独立 ref；点击哪个 `#t2-dup-result` 就变成那个按钮的 id（`t2-same-btn-a` / `t2-same-btn-b`） |
| `#t2-long-name` | `aria-label` 长 **300 字节**（`alpha-bravo-charlie-` ×15），可见子文本长 **475 字节**（`delta-echo-foxtrot-` ×25） | 名字截断到 256 字节 + `…`；子文本 475 字节未被截断 → **保留更完整的子表示**，不得因截断后「看起来相等」而抑制 |
| `#t2-moving-track` | `position: fixed` 的 **200×60** 轨道（`right:24px; bottom:24px`），内部 `#t2-moving` 80×30（`overflow:auto`，内容高 400px 以具备滚动范围） | 轨道固定尺寸且脱离文档流：不改变其它元素 bbox，也不改变页面 `scrollHeight` |
| `#t2-moving` | rAF 每帧改 `transform: translateX()`，用帧计数器在 0…120px 间往返（无随机、无外部依赖） | 持续运动目标：`browser_scroll` 必须零派发 `NOT_INTERACTABLE(reason=unstable)`；不得换点、不得 force |

没有新增的 `window.__t2` 事件类型（压缩用例不改插桩契约）。

### T2.11 第二页 `/web-t2-second.html`

| 选择器 / 对象 | 初始值 | 交互后的精确结果 |
| --- | --- | --- |
| `<title>` | `DSH T2 Fixture — Second` | — |
| `#t2-second-marker` | 文本 `t2-second` | 用于「当前在哪一页」的身份断言 |
| `#t2-second-btn` | 文本 `Second action` | 真实点击一次后 `#t2-second-counter === "1"`，且 `window.__t2` 里出现 `click`（`isTrusted: true`，target `t2-second-btn`） |
| `#t2-second-counter` | 文本 `0` | 见上 |
| `#t2-second-back` | 链接 → `/web-t2.html` | — |
| `window.__t2` | 与主页同构（`events`/`seq`/`maxEvents`/`types`/`summary()`/`reset()`） | 导航到本页后 `events.length === 0`、`seq === 0`（每页独立上下文） |

## P0 截图页面契约（`/capture-p0.html`、`/blank.html`）

供 `tests/acceptance/capture-p0.mjs`（C1–C13）使用。页面**离线、无时钟、无随机**，所有断言都是 PNG 像素真值或文件事实；改这里的几何/颜色必须同步改 `capture-p0.mjs` 的期望值。

`capture-p0.html`：`<title>P0 Capture Fixture</title>`；`html,body { margin:0; padding:0; background:#ffffff }`；`body { height:2600px; position:relative }`（CSS 视口 1280×800，可滚到 400 以上）。

| 元素 | CSS 盒（left/top/width/height） | 颜色/内容 | 用途 |
| --- | --- | --- | --- |
| `#cap-red` | 20 / 20 / 60 / 40 | 纯 `rgb(255,0,0)` | region 无损裁剪真值（中心 20×20 全红） |
| `#cap-blue` | 120 / 20 / 40 / 40 | 纯 `rgb(0,128,255)` | region 裁剪真值（中心 20×20 全 `0,128,255`） |
| `#cap-stripes` | 20 / 100 / 120 / 40 | `repeating-linear-gradient(90deg,#000 0 1px,#fff 1px 2px)` | scale 重新光栅化真值（1 CSS px 黑白硬边，无灰阶） |
| `#cap-doc-green` | 20 / 1500 / 40 / 40 | 纯 `rgb(0,255,0)` | 文档 CSS 坐标 + 滚动映射（`scrollTo(0,400)` 后在视口外） |
| `#cap-text` | 20 / 200（无固定宽高） | `font:13px/16px monospace`，文本 `P0CAPTURE-Q` | 稀疏内容（空白识别不得误报纯色） |
| `#cap-fixed` | `position:fixed`，left 200 / top 300 / 30×30 | 纯 `rgb(255,0,255)` | `captureBeyondViewport` 副作用探针（截图前后 rect 不变） |

`blank.html`：`<title>blank</title>`；纯白 body、无任何内容 → 视口截图应 `anomaly.uniform=true` 且 `warnings` 含 `content_uniform`，但图仍正常交付。

固定期望（与 `capture-p0.mjs` 一一对应）：

- 默认截图 1280×800；`region {x:20,y:30,width:100,height:50}` → 100×50；`{30,30,20,20}` 全红、`{130,30,20,20}` 全 `0,128,255`。
- `region {x:0,y:0,width:101,height:50}`：scale 1.25 → 126×63、1.5 → 152×75、1.11 → `round(101×1.11)×round(50×1.11)`（不写死）。
- 条纹区域 `{x:20,y:100,width:120,height:40}`：scale1 → 120×40（run 宽 1）、scale2 → 240×80（run 宽 2），纯黑/纯白像素占比 >99%。
- `scrollTo(0,400)` 后 `region {x:20,y:1500,width:40,height:40}` → 40×40 全 `0,255,0`，`environment.scroll.y=400`，并带 `capture_beyond_viewport` 警告。

## 明确禁止

- 不要把它改成需要外网依赖（CDN、远程 API、外部字体）的页面。
- 不要把真实 token / Cookie / 凭据写进页面或 query；测试 token 固定用 `DEMO_TOKEN_NOT_REAL`。
- 不要改成监听 `0.0.0.0`；靶机必须只在本机回环地址可达。
- T2 两页（`web-t2.html` / `web-t2-second.html`）的 id、文本、几何与 `window.__t2` 契约是 `tests/acceptance/t2-structured.mjs` 的硬依赖；不要为了「更好看」改结构、改文案或加外部资源。

## T3 静态视觉页面契约（`/web-t3.html`）

> 本页是为 **Web T3（静态视觉调试）验收**新增的确定性靶机。`tests/acceptance/t3-vision.mjs` 逐条依赖下表的 id、几何、颜色与 `window.__t3` 场景函数；改动任何一项都必须同步修改该脚本与本节真值表。
> 实测口径：本机无头 Chromium，`--hide-scrollbars --window-size=1280,800`，视口 `1280×800`、`document.compatMode === "CSS1Compat"`、`document.documentElement.scrollHeight === 1600`、初始 `scrollY === 0`。所有盒子都是 `position:absolute` 的整数 CSS 坐标；没有任何 border / 圆角 / 阴影 / 渐变（否则边缘抗锯齿会让像素真值不确定）；页面无外链、无网络请求、无随机数、无自动动画。

### T3.1 像素真值盒（y = 40–320）

| 选择器 | CSS 盒（left/top/width/height） | 颜色 / 内容 | 用途 |
| --- | --- | --- | --- |
| `#t3-red` | 40 / 40 / 80 / 60 | 纯 `rgb(255,0,0)` | live 采集/裁剪/识别/颜色真值；scale 1.25 → **100×75** |
| `#t3-blue` | 160 / 40 / 80 / 60 | 纯 `rgb(0,0,255)` | 颜色负例（找红色时不得命中） |
| `#t3-click` | 300 / 40 / 80 / 60 | 白底 + 文本计数（初始 `"0"`） | act 点击坐标/事件真值；每次 click +1 |
| `#t3-clock` | 500 / 40 / 80 / 20 | 初始 `rgb(255,255,0)`，`toggleClock()` 后 `rgb(0,255,0)` | C24 动态区域 mask（只显式 toggle，不自动变色） |
| `#t3-overlay` | 320 / 50 / 40 / 40（默认 `display:none`） | `rgb(255,0,255)` | 覆盖 `#t3-click` 中心 (340,70)；`showOverlay()` 后改变像素并遮挡点击 |
| `#t3-canvas` | 40 / 140 / 160 / 80 | 真实 canvas 2D 位图：左 80×80 纯红、右 80×80 纯蓝（backing store 160×80，DSF=1） | C14/C25/C27/C54/C56 canvas 识别与坐标输入；click 会在命中处画 8×8 黑块 |
| `#t3-textimg` | 240 / 140 / 160 / 60 | 白底 canvas + 黑字 `T3 TEXT`（`24px monospace`） | C54：文字图像候选 `semanticName` 必须为 `null`（无 OCR） |
| `#t3-drag-source` | 280 / 140 / 40 / 40 | `rgb(200,200,200)` | 拖拽起点中心 **(300,160)** |
| `#t3-drop` | 380 / 140 / 80 / 40 | `rgb(220,220,220)` | 拖拽 drop 中心 **(420,160)**；`mouseup` 真值记入 `__t3.last.drop` |
| `#t3-flip` | 300 / 240 / 80 / 60 | 初始纯红，点击后纯蓝（再点回红） | C17 前后对比（真实 click 改变固定纯色卡片） |
| `#t3-moving` | 500 / 240 / 40 / 40 | `rgb(255,128,0)`；`startMoving()` 才用 rAF 往返 0–60px | C30 持续运动拒绝（默认静止） |
| `#t3-disabled` | 560 / 240 / 80 / 40 | `<button disabled>` | C30 disabled 命中拒绝 |
| `#t3-inert`（内含 `#t3-inert-btn` 670/250/60/20） | 660 / 240 / 80 / 40 | `<div inert>` + button | C30 inert 命中拒绝 |
| `#t3-frame` | 760 / 240 / 160 / 80 | 同源 iframe（`srcdoc`，内部 button） | C30 跨 frame 命中边界 |
| `#t3-css-patch` | 50 / 50 / 10 / 10（默认 `display:none`） | 纯黑 | C22：`showCssPatch()` 后 10×10 CSS 变化（scale 2 → 20×20 像素） |

固定像素断言（`decodePng` 正规化为 RGBA 后逐像素）：

- `{x:40,y:40,width:80,height:60}` → 4800 像素全部 `[255,0,0,255]`。
- `{x:160,y:40,width:80,height:60}` → 全部 `[0,0,255,255]`。
- `{x:40,y:140,width:160,height:80}` → 左 6400 像素 `[255,0,0,255]`、右 6400 像素 `[0,0,255,255]`。
- `{x:500,y:40,width:80,height:20}` → 全部 `[255,255,0,255]`；`toggleClock()` 后全部 `[0,255,0,255]`。

### T3.2 六类缺陷容器（y = 420–690）与正常副本

| 类型 | 缺陷 id / 盒 | 正常副本 id / 盒 | DOM 事实（测试侧显式读取后作为 `facts` 传入；工具不自行查 DOM） |
| --- | --- | --- | --- |
| layout | `#t3-layout` 100 / 420 / 120 / 40 | `#t3-layout-ok` 300 / 420 / 120 / 40 | `rect`；`moveLayout(104)` / `moveLayout(100.5)` 改 left |
| occlusion | `#t3-occluded` 100 / 470 / 120 / 40 | `#t3-occluded-ok` 300 / 470 / 120 / 40 | `rect` + `visible` + `hitSamples`（5 点：中心 + 四象限，`document.elementFromPoint` 判定 `covered`）；`showOccluder('auto'\|'none'\|'partial')` / `hideOccluder()` |
| overflow | `#t3-overflow` 100 / 520 / 100 / 40（`overflow:visible`，子元素 150×20 蓝） | `#t3-overflow-ok` 300 / 520 / 100 / 40（`overflow:auto`，同子元素） | `scroll`（实测 `scrollWidth/clientWidth = 150/100`，两者一致）+ `style.overflowX/Y` + `allowOverflow`；`setOverflow('auto'\|'visible')` |
| truncation | `#t3-truncated` 100 / 570 / 100 / 20（nowrap/hidden/ellipsis，实测 `scrollWidth/clientWidth = 447/100`） | `#t3-truncated-ok` 300 / 570 / 480 / 20（同文本，`447/480` 完整显示） | `textMetrics`（content=scrollWidth/scrollHeight、available=clientWidth/clientHeight）+ `style`（overflow/whiteSpace/textOverflow/lineClamp）+ `allowTruncation`；`setTruncation('defect'\|'clamp')` |
| color | `#t3-color` 100 / 620 / 80 / 40（初始纯红；`setColorBox('rgb(0,0,255)')` 变蓝） | `#t3-color-ok` 300 / 620 / 80 / 40 纯红；`#t3-color-conflict` 420/620/80/40（父蓝、子 `#t3-color-conflict-inner` 430/630/60/20 红）；`#t3-color-alpha` 520/620/80/40（`rgba(255,0,0,0.5)`） | `rect` + `style.backgroundColor`（父盒蓝 / 子 ROI 红 = 冲突；alpha 128 = 透明背景未知） |
| missing | `#t3-missing-icon` 100 / 670 / 20 / 20 纯红 | `#t3-missing-ok` 300 / 670 / 20 / 20 纯红 | `presence`（`expected/exists/searchComplete`）+ 模板 product（从 `#t3-missing-icon` live 区域采集）；`hideMissingIcon()` / `restoreMissingIcon()` / `recolorMissingIcon()` |

> required 规则只由「显式 fact + 图像」决定；pixels-only 的 required 结论必须是 `INCONCLUSIVE(reason=insufficient-facts)`，advisory 才可按像素信号给 `WARN`。像素信号与几何事实不一致时两者都要保留。

### T3.3 `window.__t3`（只供验收取证，视觉工具不得读取）

| 字段 / 方法 | 说明 |
| --- | --- |
| `events` | 环形缓冲（最多 `maxEvents = 300`，超出丢最旧）；`reset()` 清空且不换引用 |
| `seq` | 累计记录数（不因缓冲上限回退） |
| `types` | 捕获阶段监听的 6 类：`mousemove`、`mousedown`、`mouseup`、`click`、`dblclick`、`contextmenu` |
| `counters` | `{moves,downs,ups,clicks,rightClicks,middleClicks,dblclicks,drops,canvasClicks,flipClicks,clockToggles,inertClicks}`（`inertClicks` 在 inert 子树被激活时才会增长，用于证明事件未被递送） |
| `last` | 每种类型最近一条记录；`last.drop` 为 drop 真值 |
| 单条记录 | `{type, isTrusted, clientX, clientY, button, buttons, detail, modifiers:{ctrl,shift,alt,meta}, target, ts}`；`target` 为元素 id（无 id 时退化为 `aria:` 名称或 `tag:文本`） |
| `summary()` | 按类型的计数映射（只统计仍在缓冲内的记录） |
| `reset()` | 清空 events/seq/counters/last |
| 场景函数 | `showOverlay/hideOverlay`、`toggleClock`、`moveLayout(x)`、`showOccluder(mode)/hideOccluder`、`setOverflow(mode)`、`setTruncation(mode)`、`setColorBox(css)`、`hideMissingIcon/restoreMissingIcon/recolorMissingIcon`、`startMoving/stopMoving`、`startFlash/stopFlash`、`showCssPatch/hideCssPatch`、`resetScene()`（恢复所有 DOM 默认值并重绘 canvas） |

已实测的典型事件真值（无头 Chromium、`--hide-scrollbars`）：

| 场景 | 记录 |
| --- | --- |
| 真实 click `#t3-click` 中心 (340,70) | `mousemove` → `mousedown`(button 0, buttons 1) → `mouseup`(buttons 0) → `click`，全部 `isTrusted:true`，`clientX/clientY` 为连续 CSS 坐标（保留小数） |
| 双击 | 两组 `mousedown/mouseup/click`（`detail` 依次 1、2）+ 一条 `dblclick` |
| 右键 | `mousedown/contextmenu/mouseup` 的 `button === 2` |
| 拖拽（steps=4） | 1 条起始 `mousemove` + `mousedown` + 4 条线性 `mousemove` + `mouseup`；`#t3-drop` 收到 `mouseup` 时 `counters.drops === 1`（按下记录 `pressOrigin`，捕获阶段只在非 drop 目标释放时清空，drop 的冒泡 handler 记录真值） |
| 页面加载 | `events.length === 0`、`seq === 0`（页面自身不派发输入事件） |

### T3.4 禁止

- 不要给色块加 border/圆角/阴影/渐变/内文；不要给页面加外链、字体、图片或网络请求。
- 不要自动启动动画（`startMoving` / `startFlash` 必须由场景显式调用，且测试结束调用 `stopMoving` / `stopFlash` / `resetScene`）。
- 不要修改 `#t3-*` 的 id、几何、颜色或 `window.__t3` 契约；`tests/acceptance/t3-vision.mjs` 与本节逐项对应。

## 网络靶机契约（`/n/*`、`/web-network.html`、`/web-network-frame.html`）

> 本节为 **网络采集验收** 的确定性真值表。`tests/acceptance/` 的网络脚本逐条依赖下表的路径、状态码、响应体、时序与 `window.__net` 结构；改动任何一项都必须同步修改验收脚本与 [docs/network-p0.md](../../docs/network-p0.md) §9。

### NET.1 通用不变量

- 只监听 `127.0.0.1`、`port=0`（ephemeral）。所有 `/n/*` 响应都带 `cache-control: no-store` 与 `x-fixture: dsh-ui-testing`（SSE / WebSocket / chunked 同样带）。
- 零依赖：只用 `node:http` / `node:fs` / `node:url` / `node:crypto` / `node:zlib`。WebSocket 是**手写最小帧编解码**（`node:http` 的 `upgrade` 事件；只支持 text / close / ping / pong，单帧与分片累积，payload ≤ 64 KiB），没有引入 `ws` 或任何 npm 包。
- 载荷确定性：无随机数、无时钟字段、无外网请求、无第三方资源。`/n/echo` 的 `multipart boundary` 由浏览器生成（每次不同），因此**不要断言 boundary 原文或 multipart 的精确 `bytes`**。
- 页面（`/web-network.html`）加载时 **0 条业务请求**（`window.__net.requests.length === 0`）。Document 自身与 `/favicon.ico` 属于导航开销，**不计业务请求**；页面无 autoload、无定时器、无 `load` 钩子。
- 假凭据常量（只为脱敏断言存在，不授予任何权限）：`SECRET_netfixture01`（URL token / `x-net-token`）、`Bearer SECRET_netfixture02`（`authorization`）。服务端把它们原样回显，验收侧应断言**运行时记录里被脱敏**，而不是断言服务端不回显。

### NET.2 路由真值表

| 方法 | 路径 | 状态 | 关键头 | 响应体（逐字） | 时序 / 说明 |
| --- | --- | --- | --- | --- | --- |
| GET | `/n/json` | 200 | `content-type: application/json; charset=utf-8`、`content-length` | `{"message":"net-fixture-ok","items":[1,2,3],"query":{…}}` | `query` = 全部 query 参数（字符串值，按 URL 顺序；同名重复 → 数组）；无 query → `{}` |
| POST / PUT | `/n/echo` | 200 | 同上 | `{"method":"POST"\|"PUT","kind":"json"\|"urlencoded"\|"multipart"\|"text"\|"empty","parsed":<解析值>,"headers":{…},"bytes":<int>}` | `headers` 恒含 5 个键：`content-type`、`content-length`、`x-net-probe`、`x-net-token`、`authorization`，缺失为 `null`。JSON→JSON 值；urlencoded→对象（重复键→数组）；multipart→字段对象，文件字段→`{"filename","type","size"}`；其他→原文字符串；空体→`kind:"empty","parsed":null` |
| GET | `/n/status/404` | 404 | — | `{"error":"net-not-found","status":404}` | — |
| GET | `/n/status/500` | 500 | — | `{"error":"net-server-error","status":500}` | — |
| GET | `/n/slow?ms=N` | 200 | — | `{"delayed":true,"ms":<effective>}` | 延迟 `min(round(N),5000)` ms；缺失/非法 → `ms:0` 立即返回 |
| GET | `/n/redirect/1` | 302 | `location: /n/redirect/2`、`content-length: 0` | 空 | 第 1 跳；无自由 target 参数（不可变成开放重定向） |
| GET | `/n/redirect/2` | 302 | `location: /n/final`、`content-length: 0` | 空 | 第 2 跳 |
| GET | `/n/final` | 200 | — | `{"landed":true}` | 链长固定 2 跳 |
| GET | `/n/gzip` | 200 | `content-encoding: gzip`、`content-length` = gzip 字节数 | `{"gzip":true,"message":"net-gzip-ok"}`（gzip 压缩传输） | `zlib.gzipSync`，mtime=0 → 字节确定；`fetch` 会自动解压，断言原始字节要用未解压的 HTTP 客户端 |
| GET | `/n/chunked` | 200 | `transfer-encoding: chunked`，**无** `content-length` | `chunk-1\nchunk-2\nchunk-3\n` | 3 段分别在 0 / 10 / 20 ms 写出（HTTP 层固定 3 个 chunk） |
| GET | `/n/large?bytes=N` | 200 | — | `{"pad":"x"*n}` | `n = clamp(N ?? 20000, 0, 1000000)`；正文总字节 = `n + 10` |
| GET | `/n/sse` | 200 | `content-type: text/event-stream; charset=utf-8` | 3 条事件后 `end()`：`id: 1\nevent: tick\ndata: sse-1\n\n`、`…data: sse-2`、`…data: sse-3` | 绝对 10 / 30 / 60 ms 各一条；`data` 是**纯文本** `sse-1\|sse-2\|sse-3`（不是 JSON）；第 3 条写完立即关流 |
| GET(upgrade) | `/n/ws` | 101 | `sec-websocket-accept`（按 RFC 6455 计算） | — | open 后 **+10 ms** 服务端推送文本 `server-push-1`；收到的每个 text 帧**原样 echo**；ping→pong；close→close。非 upgrade 的 GET → 426 `{"error":"net-upgrade-required","status":426}` |
| GET | `/n/poll?n=N` | 200 | — | `{"poll":<int>}` | `int = clamp(N ?? 1, 1, 100)`；无状态 |
| GET | `/n/flaky?key=K` | 503 → 200 | — | 首次：`{"key":"K","attempt":1,"ok":false,"error":"net-flaky"}`；之后：`{"key":"K","attempt":<n>,"ok":true}` | **服务端按 key 记忆**（进程生命周期内）：该 key 第 1 次 503，之后全部 200 且 `attempt` 递增；缺 `key` → `"default"`；`&reset=1` → 清零并 200 `{"key":"K","reset":true,"attempt":0}` |
| GET | `/n/token?token=T` | 200 | — | `{"token":"T","length":<T 字符数>}` | 缺 → `{"token":"","length":0}`；用于脱敏断言 |
| GET | `/n/cors` | 200 | 与 preflight 同一组：`ACAO: *`、`ACAM`、`ACAH`、`access-control-max-age: 0` | `{"cors":true}` | 简单请求；CORS 头在 GET 上也齐全 |
| OPTIONS | `/n/cors` | 204 | `ACAO: *`、`ACAM: GET,POST,PUT,OPTIONS`、`ACAH: content-type,x-net-probe,x-net-token,authorization`、`access-control-max-age: 0` | 空 | preflight |
| GET | `/n/worker.js` | 200 | `content-type: text/javascript; charset=utf-8` | 见 `net-worker.js` | Worker 脚本，启动即 `self.fetch('/n/worker-data')` |
| GET | `/n/worker-data` | 200 | — | `{"from":"worker-data","ok":true}` | — |
| GET | `/n/shared-worker.js` | 200 | `content-type: text/javascript; charset=utf-8` | SharedWorker 脚本 | `self.onconnect`：每连接 1× `fetch('/n/worker-data')`；SharedWorker 仅同源可用 |
| GET | `/n/sw.js` | 200 | `content-type: text/javascript; charset=utf-8`、`service-worker-allowed: /` | ServiceWorker 脚本 | **无 `fetch` 监听**（不拦截任何 `/n/*`），只答 `postMessage({type:"net-sw-fetch"})`；作用域 `/` |
| GET | `/n/iframe.html` | 200 | `content-type: text/html; charset=utf-8` | 与 `/web-network-frame.html` **同一份文档** | 该文档内部 fetch `/n/iframe-data` |
| GET | `/n/iframe-data` | 200 | — | `{"from":"iframe-data","ok":true}` | — |
| GET | `/web-network.html` | 200 | `text/html` | 主页面（见 NET.3） | — |
| GET | `/web-network-frame.html` | 200 | `text/html` | iframe 目标页 | 见 NET.4 |
| GET | `/web-network-oopif.html` | 200 | `text/html` | OOPIF 探针页（主文档 `127.0.0.1`，iframe `http://localhost:<port>`） | 见 NET.7 |
| 其它方法 | 上述任一 | 405 | `allow: <允许的方法>` | `{"error":"net-method-not-allowed","status":405}` | 方法不匹配时 |

### NET.3 主页面按钮 → 请求 / 事件序列（`/web-network.html`）

按钮 id 与**可见文案**都是固定值（T2 selector 依赖）；每个按钮点击只做下表的事，不做别的。

| id | 文案（可访问名） | 触发后（trigger 名） |
| --- | --- | --- |
| `#net-fetch-json` | `Fetch JSON` | 1× `GET /n/json?from=page&n=1`（`fetch-json`）→ 200，`body.query === {from:"page",n:"1"}` |
| `#net-post-json` | `POST JSON` | 1× `POST /n/echo`，体 `{"hello":"world","n":1}`，头 `content-type: application/json`、`x-net-probe: net-probe-1`、`x-net-token: SECRET_netfixture01`、`authorization: Bearer SECRET_netfixture02`（`post-json`） |
| `#net-post-form` | `POST form` | 1× `POST /n/echo`（multipart）：`a=1`、`b=two`、文件字段 `file` = Blob `file-body-1`（filename `net-file.txt`、type `text/plain`、`size:11`）（`post-form`） |
| `#net-redirect` | `Follow redirect` | `GET /n/redirect/1` →302→ `/n/redirect/2` →302→ `/n/final`（`redirect`）；记录的 `finalUrl === "/n/final"`、`body === {"landed":true}` |
| `#net-500` | `Trigger 500` | 1× `GET /n/status/500`（`status-500`）：fetch **不抛错**，记录 `status:500, ok:false` |
| `#net-slow` | `Slow request (300 ms)` | 1× `GET /n/slow?ms=300`（`slow`）→ 约 300 ms 后 200 `{"delayed":true,"ms":300}` |
| `#net-large` | `Large body (20 KB)` | 1× `GET /n/large?bytes=20000`（`large`）→ `body.pad.length === 20000` |
| `#net-flaky` | `Flaky (2 calls)` | 串行 2 次 `GET /n/flaky?key=page`（`flaky` ×2）：`byTrigger.flaky[0].status === 503`、`byTrigger.flaky[1].status === 200`（**前提：该 key 的服务端计数为 0**，见 NET.5） |
| `#net-poll-start` | `Start polling` | `GET /n/poll?n=1..3`，间隔 30 ms，满 3 次**自动停止**（`poll-1`、`poll-2`、`poll-3`），`poll.active` 回到 `false`、`poll.values === [1,2,3]` |
| `#net-poll-stop` | `Stop polling` | 不发请求，仅停定时器（`poll.active === false`）；已开始的请求不会取消 |
| `#net-token` | `Send token URL` | 1× `GET /n/token?token=SECRET_netfixture01`（`token`）→ 200 `{"token":"SECRET_netfixture01","length":19}` |
| `#net-parallel` | `Parallel ×3` | 3 条**并发** `GET /n/json?p=1|2|3`（`parallel-1..3`）：`seq` 按发出顺序 1、2、3，但完成顺序不保证 |
| `#net-ws-connect` | `Connect WebSocket` | 1× WebSocket upgrade 到 `ws://<host>/n/ws`；`ws.connects`、`ws.opens` 各 +1 |
| `#net-ws-send` | `Send WebSocket text` | 发文本 `client-hello-<n>`（第 1 次 `client-hello-1`）并计入 `ws.sent`；**socket 未 open 时只加 `ws.errors`，不伪造 `sent`** |
| `#net-sse-start` | `Start SSE` | 1× `GET /n/sse`（EventSource）；收到 3 条 `tick` 事件后服务器关流 |
| `#net-sse-stop` | `Stop SSE` | 不发请求，`es.close()`；`sse.stops` +1、`sse.closeReason === "user"` |
| `#net-worker` | `Run worker` | `new Worker('/n/worker.js')` → 内部 1× `GET /n/worker-data`；`worker.started/done` 各 +1 |
| `#net-shared-worker` | `Run shared worker` | `new SharedWorker('/n/shared-worker.js')` + `port.start()` → 内部 1× `GET /n/worker-data`；`sharedWorker.started/done` 各 +1。SharedWorker 同源专用：失败只记 `sharedWorker.error`，不抛 |
| `#net-sw-register` | `Register service worker` | `navigator.serviceWorker.register('/n/sw.js', { scope: '/' })` → `ready`；`serviceWorker.registered = true`、`scope` 为源根；`controller` 由 `controllerchange` 事件更新（首次可能延迟到 activate/claim 之后）。注册失败只记 `serviceWorker.error`，不抛 |
| `#net-sw-fetch` | `Service worker fetch` | 向 `navigator.serviceWorker.controller` 发 `{type:"net-sw-fetch"}` → SW 内 1× `GET /n/worker-data?from=sw`；**占不到 controller 时只记 `error:"no-controller"`**（不伪造 done） |
| `#net-iframe` | `Load iframe` | 在 `#net-iframe-host` 内注入 `<iframe id="net-iframe-el" src="/web-network-frame.html">`（重建时先移除旧的）→ 内部 1× `GET /n/iframe-data`；`iframe.started/done` 各 +1 |

页面另有固定文本节点：`#net-title`（`DSH Net Fixture`）、`#net-status`（`pending === 0` 时文本 `idle`，否则 `busy`）、`#net-status-line`；小节标题 `#net-heading-http`/`#net-heading-poll`/`#net-heading-token`/`#net-heading-parallel`/`#net-heading-ws`/`#net-heading-sse`/`#net-heading-worker`/`#net-heading-iframe`。

### NET.4 `window.__net`（页面侧真值插桩，不依赖 CDP）

| 字段 / 方法 | 说明 |
| --- | --- |
| `version` / `fixture` | `1` / `"dsh-ui-testing"` |
| `seq` | 请求触发序号，每次发起请求 +1（并发时按**发起**顺序取号） |
| `pending` | 未完成请求数（含失败的会归零） |
| `requests` | 按触发顺序的记录数组（`reset()` 保持数组引用不变） |
| `byTrigger` | `trigger → [record…]`；判断"某按钮做了什么"优先用它，**不要**用绝对 `seq` |
| 单条 record | `{seq, trigger, method, url, status, ok, body, error, finalUrl}`；`url`/`finalUrl` 是**路径+query**（不含 origin，避开端口差异）；`status:0` + `error` 表示 fetch 抛错；`body` 为 JSON 解析值（非 JSON 为文本） |
| `ws` | `{connects, opens, errors, closes, sent[], received[]}`；`sent` 是发出的文本，`received` 是收到的文本（页面不主动关闭 socket，故 `closes` 通常为 0） |
| `sse` | `{starts, stops, errors, events[], lastEventId, closeReason}`；`events` 元素为 `{id, event, data}`；服务器关流后 EventSource 触发一次 `error`，页面立刻 `close()` 并记 `errors:1`、`closeReason:"server"` |
| `worker` | `{started, done, messages[]}`；`messages[0]` = `{source:"worker", status:200, body:{from:"worker-data",ok:true}}` |
| `sharedWorker` | `{started, done, port:"shared", error, messages[]}`；`messages` 为 `{source:"shared-worker", phase:"connected"\|"done"\|"error", status, body}`，成功时 `done:1` |
| `serviceWorker` | `{registered, controller, done, error, messages[], scope?}`；注册成功 `registered:true`，被控后 `controller:true`，`#net-sw-fetch` 成功后 `done:1` + `messages[0] = {source:"service-worker", phase:"done", status:200, body:{from:"worker-data",ok:true}}`；失败记 `error` 字符串（`service-worker-unavailable` / `no-controller` / 注册异常原文），**不抛异常** |
| `iframe` | `{started, done, messages[]}`；`messages` 元素为 `{status, body, error}`（来自 iframe 的 `postMessage`） |
| `poll` | `{active, count, values[]}` |
| `reset()` | 清空**页面侧**计数与记录（数组引用不变、`seq` 归零）。**不**断开 WebSocket / EventSource，**不**重置服务端 `/n/flaky` 计数 |
| `summary()` | 返回 `{requests, pending, statuses{trigger:[status…]}, ws{…counts}, sse{…}, worker{started,done}, sharedWorker{started,done,port,error}, serviceWorker{registered,controller,done,error}, iframe{started,done}, poll{active,count}}` |

iframe 页另有 `window.__netFrame = {version:1, done, status, body, error}`，并把结果镜像到 `body[data-net-frame]`（`pending` → `ok`/`error`）与 `#net-frame-status`（`pending` → `ok`/`error`）；页内标题 `#net-frame-title`、`#net-frame-marker`（`net-frame`）。

### NET.5 实测到的、最容易被误断言的地方

1. **`/n/flaky` 是服务端有状态的**：`__net.reset()` 只清页面计数。要重新拿到 503，必须先 `fetch('/n/flaky?key=page&reset=1')`（或用新的 key）；否则第二次点 `#net-flaky` 得到的是 `[200, 200]`（`attempt` 2、3）。
2. **SSE 的 `errors` 期望是 1，不是 0**：服务端在 3 条事件后主动关流，EventSource 必然报一次 `error`（页面随即 close 防止自动重连）。断言"无错误"是错的。
3. **轮询的 `seq` 不连续**：`poll-1..3` 之间隔 30 ms，期间若点别的按钮，别的请求会插进 `seq`；只断言 `byTrigger['poll-N']` 与 `poll.values`。
4. **`/n/echo` 的 multipart 不可逐字断言**：`boundary` 由浏览器随机生成，`content-type` 只能断言前缀 `multipart/form-data; boundary=`，`bytes`/`content-length` 只能断言 `> 0`；字段值（`a`/`b`/`file.filename`/`file.size`）才是稳定真值。
5. **`/n/gzip` 的 `fetch` 肉眼看不出 gzip**：`fetch`/XHR 自动解压，只有未解压的 HTTP 客户端（如 `browser_http_request` 或 curl 不加 `--compressed`）才能断言 `content-encoding` 与原始字节；页面侧 `__net` 里只能断言解析后的 JSON。
6. **`/n/large` 的总字节是 `n + 10`**（`{"pad":"…"}` 的 10 字节壳），不是 `n`。
7. **`#net-500` 不会抛异常**：`fetch` 对 5xx 正常 resolve（`ok:false`）。断言 `record.error` 非空是错的。
8. **`/n/slow` 的 `ms` 是服务端钳制后值**：页面固定传 300；`ms=99999` 会被钳到 5000。
9. **主页面加载 0 业务请求**：`__net.requests.length === 0`；Document 与 `/favicon.ico` 不算业务请求，不要拿 `browser_network` 的总条数当"0"。
10. **WebSocket 的接收顺序**：`received[0]` 是服务端推送 `server-push-1`（open 后 10 ms），`received[1]` 才是自己发的回显文本；若 `#net-ws-send` 点得极早（10 ms 内）可能出现先回显后推送，验收要先等 `ws.opens === 1` 再断言顺序。
11. **Service worker 的作用域是 `/`，不是 `/n/`**：脚本在 `/n/sw.js`，但注册时显式 `scope: '/'`（服务端回 `service-worker-allowed: /`），否则 `/web-network.html` 不在 `/n/` 作用域内、`controller` 永远为 `false`。SW **故意不注册 `fetch` 监听**，因此不会拦截或改变任何 `/n/*` 请求的网络事件；如果发现页面请求变成了 `ServiceWorker` 类型，说明 fixture 被改坏了。
12. **`controller` 是异步出现的**：注册 → activate → `clients.claim()` → `controllerchange`。`#net-sw-register` 之后要等到 `serviceWorker.controller === true` 再点 `#net-sw-fetch`，否则只会得到 `error:"no-controller"`（这是契约允许的容忍分支，不是失败）。
13. **SW 内部 fetch 不进页面网络记录**：`/n/worker-data?from=sw` 由 service-worker target 发起，页面侧 `__net.requests` 里看不到（同理 Worker/SharedWorker/iframe 的请求也不在页面 ledger 里）。要断言这条请求必须附着到 `service_worker` target 会话的 Network 事件，或用 SW 回传的 `messages[0]` 作为真值。
14. **OOPIF 是否真隔离取决于浏览器 site isolation**：本机 headless Chromium 实测会为 `localhost` 子框架单独开 `iframe` target（隔离成立）；但 headless/`--site-per-process` 相关开关、平台差异都可能让它留在同一进程。**没有观察到独立 `iframe` target 时，G1.5 的 OOPIF 子项必须记 NOT_RUN，不得用"同源内联 frame 也测到了"替代**。

### NET.6 禁止

- 不要给 `/n/*` 增加随机载荷、时钟字段、外网依赖或 npm 依赖（含 `ws`）。
- 不要把 token / 凭据换成真实值；固定用本节的假常量。
- 不要改页面按钮 id、文案顺序、`window.__net` 字段与语义；网络验收脚本与本节逐项对应。
- 不要用固定端口启动本靶机（永远 `port: 0`），也不要改成监听 `0.0.0.0`。
- 不要给 `/n/sw.js` 加 `fetch` 监听（会拦截 fixture 自己的请求、污染网络事件类型），也不要把注册作用域改回 `/n/`（会让主页面永远拿不到 controller）。
- 不要把 OOPIF 探针页的 iframe `src` 改成与主文档同 host（`127.0.0.1` → `127.0.0.1`）：那样就不再是跨站 frame，OOPIF 条件消失。

### NET.7 OOPIF 探针页（`/web-network-oopif.html`）

跨站子框架探针，用于 `docs/network-p0.md` §13 / G1.5 的 OOPIF 正例。

| 项 | 真值 |
| --- | --- |
| `<title>` / `#net-oopif-title` | `DSH Net Fixture OOPIF` |
| 主文档 URL | `http://127.0.0.1:<port>/web-network-oopif.html` |
| iframe | 由 `#net-oopif`（文案 `Load cross-site iframe`）创建，**固定 id `net-oopif-frame`**，`src = http://localhost:<同一 port>/web-network-frame.html`（host 不同 ⇒ 不同 site ⇒ OOPIF 条件） |
| 加载时请求 | 0 业务请求（不自动装配 frame；必须点按钮） |
| `window.__net` | `{version:1, fixture:"dsh-ui-testing", oopif:{created, loaded, messages[]}, reset(), summary()}`；本页没有 HTTP/WS/SSE 区块 |
| `oopif.created` | 每次点 `#net-oopif` +1；第 2 次起是**重载**（重新赋 `src`，不换元素） |
| `oopif.loaded` | 子框架 `load` 事件次数（跨源也可观测，是最稳的完成信号） |
| `oopif.messages` | 子框架 `postMessage` 载荷：`{origin:"http://localhost:<port>", status:200, body:{from:"iframe-data",ok:true}}` |
| 子框架内真值 | 仍由 `window.__netFrame` 记录（`{version:1,done:true,status:200,body:{from:"iframe-data",ok:true}}`）、`body[data-net-frame]="ok"`、`#net-frame-status="ok"` |
| 跨源可见性 | 父页读 `iframe.contentDocument === null`（跨源隔离的页面侧旁证；不能代替 CDP target 判定） |

实测（本机 headless Chromium，2026-11-01）：点 `#net-oopif` 后出现**独立**的 `iframe` target `http://localhost:<port>/web-network-frame.html`（`Target.attachedToTarget`，`autoAttach` 于 page 会话），即 OOPIF **成立**；`oopif={created:1,loaded:1,messages:1}`。

判定口径：**以 CDP target 为准**。若只看到 page target 而没有 `iframe`（或 `type:"iframe"` 的 `attachedToTarget`）子 target，说明该环境未隔离 → G1.5 的 OOPIF 子项记 **NOT_RUN**，原因写"site isolation 未生效"，不要改写成 PASS，也不要用同源 frame 充当正例。

## 电商业务链路靶机契约（`/shop/*`、`/api/shop/*`）

> 5 个**真实 MPA 页面**（每次跳转都是全页导航，不是 SPA）+ 确定性 `/api/shop/*`。供端到端业务链路追踪验收使用；冻结 runId 为 `chain-1`，冻结订单号 `ORD-chain-1-1`。改这里任何 id、路径、响应体都必须同步改验收脚本与 [docs/network-p0.md](../../docs/network-p0.md) 的 §14。

### SHOP.1 通用不变量

- 只监听 `127.0.0.1`、`port=0`；页面与 API 同源，无外网、无第三方资源、无随机数。
- **关联标识（关键）**：5 个页面的**每一个** API fetch 都带请求头 `x-correlation-id: trace-shop-chain-1`（默认规则提取器读的那个）与 `x-shop-trace: trace-shop-chain-1`（人类可读副本）；API 响应也回同样两个头。
- 所有 API 响应：`content-type: application/json; charset=utf-8`、`cache-control: no-store`、`x-fixture: dsh-ui-testing`、`x-request-id: shop-req-<n>`（**每请求唯一**，服务端进程内从 1 单调递增，整链固定顺序 ⇒ 可预测）、JSON 顶层 `code: 0`。
- 状态是服务端进程内、按 runId 记忆的：一个 fixture 进程跑一次 canonical 链路即产出上表真值；同进程再跑一遍会命中幂等（同 orderId）且订单已是 `paid`。要重放首轮状态用 `GET /api/shop/reset?runId=chain-1`，或直接新起 fixture（验收推荐后者）。
- 唯一非确定字段是 `window.__shop.requests[].at`（epoch ms，页面本地记账）。只可断言类型/单调，**不可断等值**。

### SHOP.2 API 真值表

| 方法 | 路径 | 请求体 / 查询 | 状态 | 响应体（逐字） |
| --- | --- | --- | --- | --- |
| GET | `/api/shop/products?runId=chain-1` | — | 200 | `{"code":0,"data":{"products":[{"id":"sku-1","name":"Widget A","price":1999},{"id":"sku-2","name":"Widget B","price":2999},{"id":"sku-3","name":"Widget C","price":3999}]}}` |
| GET | `/api/shop/products/sku-1` | — | 200 | `{"code":0,"data":{"product":{"id":"sku-1","name":"Widget A","price":1999,"stock":10}}}` |
| POST | `/api/shop/orders` | `{"runId":"chain-1","productId":"sku-1"}` | 200 | `{"code":0,"data":{"order":{"orderId":"ORD-chain-1-1","productId":"sku-1","total":1999,"status":"created"}}}`。**幂等**：同 runId 再次 POST（哪怕换 productId）返回同一个 `ORD-chain-1-1` 与首单的 `productId/total` |
| GET | `/api/shop/orders?orderId=ORD-chain-1-1` | — | 200 | canonical 链路上（checkout 之前）：`{"code":0,"data":{"order":{"orderId":"ORD-chain-1-1","productId":"sku-1","total":1999,"status":"created"}}}`；checkout 之后同一请求返回 `status:"paid"`（状态机读数，见 SHOP.5(3)） |
| POST | `/api/shop/checkout` | `{"runId":"chain-1","orderId":"ORD-chain-1-1","payMethod":"card"}` | 200 | `{"code":0,"data":{"orderId":"ORD-chain-1-1","status":"paid","paidAt":"2026-11-01T00:00:00.000Z"}}`（`paidAt` 固定常量） |
| GET | `/api/shop/orders/status?orderId=ORD-chain-1-1` | — | 200 | `{"code":0,"data":{"orderId":"ORD-chain-1-1","status":"paid"}}`（checkout 之后；之前为 `created`；未知 orderId ⇒ `status:"created"`） |
| GET | `/api/shop/orders/list?runId=chain-1` | — | 200 | `{"code":0,"data":{"orders":[{"orderId":"ORD-chain-1-1","status":"paid","total":1999}]}}` |
| GET | `/api/shop/reset?runId=chain-1` | — | 200 | `{"code":0,"data":{"runId":"chain-1","reset":true}}`（fixture 专用：清掉该 runId 的订单状态） |
| GET | `/shop/shop-ledger.js` | — | 200 | 5 页共用的 `window.__shop` 记账脚本（`text/javascript`） |

方法不匹配 → `405 {"error":"net-method-not-allowed","status":405}` + `allow` 头（沿用 `/n/*` 的约定）。

### SHOP.3 页面真值表（真实全页导航）

| 页面 | 入口 URL | load 时自动请求 | 固定 id / 文本 | 按钮 → 行为 |
| --- | --- | --- | --- | --- |
| 商品列表 | `/shop/products.html?runId=chain-1` | `GET /api/shop/products?runId=chain-1` | `#shop-products` 渲染 3 个 `<li id="shop-product-sku-N">`，文本 `sku-1|Widget A|1999`（同格式）；`#shop-status` `loading`→`ready` | `#shop-pick-1`（`Pick Widget A`）→ 全页导航到 `/shop/product.html?runId=chain-1&productId=sku-1` |
| 商品详情 | `/shop/product.html?runId=chain-1&productId=sku-1` | `GET /api/shop/products/sku-1` | `#shop-product-detail` = `sku-1|Widget A|1999|10` | `#shop-create-order`（`Create order`）→ `POST /api/shop/orders` 成功后全页导航到 `/shop/order.html?runId=chain-1&productId=sku-1&orderId=ORD-chain-1-1` |
| 订单确认 | `/shop/order.html?runId=…&productId=…&orderId=ORD-chain-1-1` | `GET /api/shop/orders?orderId=ORD-chain-1-1` | `#shop-order-detail` = `ORD-chain-1-1|created|1999` | `#shop-checkout`（`Go to checkout`）→ 全页导航到 `/shop/checkout.html?runId=…&productId=…&orderId=…` |
| 结算 | `/shop/checkout.html?runId=…&productId=…&orderId=…` | `POST /api/shop/checkout` → 然后 **3 次** `GET /api/shop/orders/status?orderId=…`（间隔 **30 ms**） | `#shop-checkout-status` = `ORD-chain-1-1|paid|2026-11-01T00:00:00.000Z`；`#shop-poll-count` = `polls: 3 [paid,paid,paid]`；`#shop-spa-state` 初始 `spa: not-pushed` | `#shop-spa-route`（`Simulate SPA route`）→ `history.pushState({}, '', '/shop/checkout/step2?orderId=…')` 后再 1 次 `GET /api/shop/orders/status`；`#shop-go-orders`（`Go to my orders`）→ 全页导航到 `/shop/orders.html?runId=chain-1&orderId=…` |
| 我的订单 | `/shop/orders.html?runId=chain-1&orderId=ORD-chain-1-1` | `GET /api/shop/orders/list?runId=chain-1` | `#shop-orders` 渲染 `<li id="shop-order-ORD-chain-1-1">`，文本 `ORD-chain-1-1|paid|1999`；`#shop-orders-count` = `orders: 1` | `#shop-back-products`（链接）→ `/shop/products.html?runId=chain-1`（重放链路用） |

每页 `body` 上的可观测标记：`data-shop-stage`（`products|product|order|checkout|orders`）、`data-shop-ready`（该页 load 完成时写入 stage 名）、`#shop-status` 文本 `loading`→`ready`（失败为 `error`）。

### SHOP.4 `window.__shop`

| 字段 | 说明 |
| --- | --- |
| `runId` | 固定 `"chain-1"`（来自 query，缺省 `chain-1`） |
| `stage` | 当前页阶段：`products` / `product` / `order` / `checkout` / `orders` |
| `route` | `{path, search}`，随全页导航与 `pushState` 更新（SPA 后为 `/shop/checkout/step2` + `?orderId=…`） |
| `requests` | `[{stage, method, url, status, at}]`，**按发起顺序**；`url` 为路径+query；网络/解析失败记 `status:0` 并进 `errors` |
| `products` / `product` / `order` / `checkout` / `orders` | 各自页面对应 API 的 `data`（`products` 为数组、`product`/`order` 为对象、`checkout` 为 `{orderId,status,paidAt}`、`orders` 为数组） |
| `polls` | 结算页自动轮询收到的 `status` 数组，canonical 链路恒为 `["paid","paid","paid"]`（长度 3；**不含** SPA 那次额外 GET） |
| `spa` | `{pushed, pushedPath, status}`：`pushed` 布尔、`pushedPath` = `/shop/checkout/step2?orderId=ORD-chain-1-1`、`status` 是 pushState 之后那次 GET 的返回值 |
| `errors` | 失败原因字符串数组（canonical 链路为空） |
| `done` | `{products, product, order, checkout, orders}`，**每个页面只把自己那一项置 true**（新文档 = 新 ledger），用于验收等待 |
| `request()` / `markDone()` / `pushRoute()` / `query()` / `summary()` | 页面内部使用的辅助方法；`summary()` 返回精简快照（`stage/runId/route/requests/polls/spa/done/errors`） |

### SHOP.5 时序与最容易被误断言的点

1. **每页都要等 `__shop.done.<stage> === true`，不要用固定 sleep**：`products/product/order/checkout/orders` 各自对应本页 load 完成；`done` 是**每页独立**的（导航后是新文档，上一页的 `true` 不复存在），不要断言"全部 5 个 true"。
2. **结算页的 3 次轮询是串行 + 30 ms 间隔**：第 1 次在 `POST /api/shop/checkout` 成功**之后立即**发出，第 2、3 次各间隔 30 ms。三者为**同一个 URL**（`/api/shop/orders/status?orderId=…`），这是 polling 识别的正例；`done.checkout` 在**第 3 次返回后**才为 true。
3. **订单状态是状态机**：`created` → checkout 后 `paid`。`GET /api/shop/orders?orderId=…` 与 `/orders/list` 返回**当前**状态：canonical 链路上 order 页读到 `created`、orders 页读到 `paid`；**在 checkout 之后再读 `/api/shop/orders` 会得到 `paid`**，不要断言它永远 `created`。
4. **`POST /api/shop/orders` 幂等**：同 runId 第二次 POST（哪怕换 `productId`）返回同一个 `ORD-chain-1-1` 与首单的 `productId/total`（不是新建第二单，也不是 400）。因此"重放链路"不会产生第二个订单号；要新状态请 `reset` 或新起 fixture。
5. **SPA 路由不改变 documentURL**：`#shop-spa-route` 只做 `pushState` + 再发 1 次 status GET。该请求的 `documentURL`/文档仍是 `checkout.html`（这是已知边界，只能断言"同文档路由 + 新 URL 的 state mark"，不能断言服务器端看到 `/shop/checkout/step2`）。
6. **`/shop/checkout/step2?...` 直接 GET 是 404**：它只是 `pushState` 出来的前端 URL，没有对应文件。刷新/直接访问会 404，这是有意的。
7. **诊断页面跳转时不要用"导航后立刻读 `__shop`"**：全页导航会换文档，`Runtime.evaluate` 的上下文也会换；等到 `location.pathname` 与 `__shop.done.<stage>` 同时满足再读。
8. **`x-request-id` 依赖服务端进程内计数**：同一 fixture 进程里第 1 个 shop API 请求是 `shop-req-1`，之后严格递增；**断言唯一性/格式 `^shop-req-\d+$` 是安全的，断言绝对序号只在"从新 fixture 起的 canonical 链路"里成立**。
9. **关联标识读请求头**：`x-correlation-id` 是页面 fetch 显式带的请求头（提取器按默认规则读请求头）。若你在导出/详情里只看到响应头而请求头缺失，说明页面被改坏了。
10. **`at` 是唯一非确定字段**（epoch ms），不要断等值；`requests` 的**顺序**才是可断言的（幂等/重试/轮询靠顺序与 URL 判）。

### SHOP.6 禁止

- 不要把 5 个页面改成 SPA 或加前端路由框架；`#shop-pick-1`/`#shop-create-order`/`#shop-checkout`/`#shop-go-orders` 必须是**真实全页导航**（`location.href`）。
- 不要改 runId（`chain-1`）与 orderId 规则（`ORD-<runId>-1`），不要给订单号加随机后缀。
- 不要给 API 响应加时钟/随机字段（`paidAt` 固定 `2026-11-01T00:00:00.000Z`），也不要去掉 `x-correlation-id` / `x-shop-trace` / `x-request-id` / `no-store`。
- 不要在页面里直连外网、加 CDN 资源或在 `__shop` 里塞 CDP 依赖。
