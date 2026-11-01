# tests/ui_test_fixture — 明确授权的本地 Web 靶机

这是 **`dsh-agent-team-ui-testing` 插件 T1/T2 Web 验收专用的本地靶机**，由本仓库自行编写并明确授权被测 Agent 访问。它**不是**外网站点、不是用户数据、也不包含任何真实凭据。

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
