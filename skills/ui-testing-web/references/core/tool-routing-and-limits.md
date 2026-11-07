# 工具路由、断言 schema 与坐标空间（实现为准）

> 本文件回答三个问题：**该用哪层**、**参数怎么写才对**、**失败码出现后下一步是什么**。
> 工具名/字段/枚举以当前 `index.js` 注册表与调用实现为准；运行态可用性仍以 `browser_capabilities` 的实测三态为准，不以本文或 manifest 推断。

## 1. 能力路由（按断言选层）

| 断言/问题 | 首选 | 最小调用序列 | 关键返回 | 不能证明 |
| --- | --- | --- | --- | --- |
| 地址/标题/运行态/owner | T1 | `browser_state {}`（不启动、不占租约） | `url/title/viewport/running/error*` | 加载完成、业务状态 |
| 页面 JS 值/应用状态 | T1 | `browser_eval { expression }` | `{ok,value,type}` | 用户可见像素、交互命中 |
| 计算样式 | T1 | `browser_computed_style { selector, properties }` | `{ok,style}` | 遮挡、最终像素 |
| 原始事件序列（多点/组合键/滚轮） | T1 | `browser_input { events }` | `{ok,applied}`（事件数，不是生效数） | 焦点、默认动作、业务副作用 |
| 独立接口契约 | T1 | `browser_http_request { url, … }` | `status/headers/body/redirects` | 页面是否真的发了同一请求 |
| 视口/画布位置 | T1 | `browser_viewport { action:"set", … }` 后读回 | `view/observed/applied/clamped` | 页面 CSS 缩放（scale 只是显示比例） |
| 单页截图（原始 PNG） | P0 截图 | `browser_screenshot { scale?, region?, out? }` | PNG/hash/capture.mapping/warnings | 像素差异结论、动画时序 |
| 元素语义/元素级交互 | T2 | `snapshot → ref → click/type/scroll/fill_form → node_state/wait_for` | `snapshotId/digest/targets/dispatch` | 业务结果（必须另读页面真值） |
| 颜色/遮挡/溢出/区域差异/基线回归 | T3 | `vision_image`（取 product）→ `compare`/`check` | `comparison.metrics`、`verdict` | 持续运动、时长、闪烁 |
| 用截图坐标派发鼠标 | T3 | `vision_image` → `vision_act` | `dispatched` + `INCONCLUSIVE(dispatch-only)` | 点中业务目标、视觉验收通过 |
| 帧序列/间隔/冻结/闪烁/轨迹/过渡 | T4 | `dynamic_session start` → `motion_observe` → `motion_analyze` | 帧 `sourceTimestamp/hash/integrity`、`verdict` | 技术身份（CSS/Canvas/WebGL/video）、属性值 |
| A 是否导致 B | T4 + P0 | `dynamic_correlate { directions }` | `basis/grade` | 时间邻近不是因果 |
| 请求/响应/WS/SSE/拦截/重放/证据包 | P0 | `network_session start` → `events` → `detail` → `trace` | 事件时间轴、body 三态、integrity | 页面语义因果 |
| 多标签管理 | P0-E | `browser_tabs { action }` | `tab{id,runtimeId,selectionRevision}` | 跨 tab 证据聚合 |

## 2. `browser_motion_analyze` 断言 schema（七类，逐字段）

顶层参数（注册 schema）：`motionSessionId`（必填）、`assertions`（必填，1–20 条）、`window` 与 `frameIds` **二选一**（同给 → `DYNAMIC_INVALID_ARGUMENT(window-and-frameIds-exclusive)`）。离线执行，不采帧、不 ensure、不续租。

每条断言允许的键固定为：`id / type / region / masks / thresholds / expectedIntervalMs / query / expectation`（未知键拒绝；`id` 必填、同批唯一、≤64 字节）。

| type | 必填专属字段 | 专属字段的精确要求 | `thresholds` 允许键（默认值） |
| --- | --- | --- | --- |
| `frame-diff` | — | — | `pixelThreshold`(0–1, 0.1)、`changeRatio`(0–1, 0.01) |
| `region-change` | — | — | 同上 + `minArea`(1–16000000 整数, 4) |
| `flicker` | — | — | `pixelThreshold`(0.1)、`changeRatio`(0.2)、`stableRatio`(0.01)、`brightnessDelta`(0–255, 64)、`maxDurationMs`(0–10000, 100) |
| `freeze` | **`expectation`（对象）** | 见下 | `pixelThreshold`(0.1)、`stableRatio`(0.001)、`minDurationMs`(0–10000, 500) |
| `jank` | **`expectedIntervalMs`** | 有限数且 `> 0`；传 `null` 或非 jank 类型携带 → `DYNAMIC_INVALID_ARGUMENT` | `intervalFactor`(1–10, 2) |
| `trajectory` | **`query`（对象）** | 见下 | `maxStep`(1–1000000, 80) |
| `transition` | — | — | `pixelThreshold`(0.1)、`changeRatio`(0.01)、`stableRatio`(0.001)、`stableSamples`(2–20 整数, 3) |

`freeze.expectation` 的封闭形状（不是字符串！写成字符串必失败）：

```json
{ "motionExpected": true,
  "sourceEventId": "≤128 字节的事件 id",
  "referenceEventIds": ["1–16 个、≤128 字节、不重复的参照事件 id"] }
```

- `motionExpected` 必须**字面为 `true`**；`sourceEventId`、`referenceEventIds` 均必填。
- 语义：用可核验的"此处本应继续推进"的事件作参照；没有可核验参照就不要写 freeze 断言。

`trajectory.query` 两种形状：

```json
{ "method": "color",    "color": [r,g,b], "tolerance": 0–255, "minArea": 1–16000000, "maxResults": 1–20 }
{ "method": "template", "productId": "v1_<32hex>", "minScore": 0–1, "stride": 1–16, "maxResults": 1–20 }
```

- `color`：三通道 0–255 整数；`tolerance` 默认 16、`minArea` 默认 4、`maxResults` 默认 20。
- `template`：`productId` 必须来自本工作区 product；`minScore` 默认 0.95、`stride` 默认 1。
- `region` / `masks` 对全部类型都可给，但**坐标是帧图像像素**（整数、x/y ≥0、宽高 ≥1、像素数 ≤4,000,000）；`masks` ≤64 个 `{id, region}`。
- 单次分析共用 5000ms 算法预算：超时 → 结果 `BLOCKED(reason:dynamic-timeout)` + `remaining-assertions-not-run`。用 `frameIds`/`window` 抽帧降成本，不要抬阈值凑通过。
- `verdict` 严重度顺序 `FAIL > BLOCKED > INCONCLUSIVE > WARN > PASS`；`exitCode`：PASS/WARN=0、FAIL=1、INCONCLUSIVE/BLOCKED=2。

## 3. `browser_dynamic_session` 配置（start 时唯一生效）

`action` ∈ `start|stop|status|reset|extend`。`config` 只接受这 10 个键：
`captureVisual / networkSessionId / source / encoding / durationMs / maxFrames / maxBytes / region / scale / sampleIntervalMs`。

| 键 | 视觉采集（`captureVisual:true`，默认） | 纯网络关联视图（`captureVisual:false`） |
| --- | --- | --- |
| `source` | **必填**，`screencast` 或 `screenshot-loop` | 禁止 |
| `encoding` | `screencast` 只允许 jpeg（显式要 png → `DYNAMIC_SOURCE_UNAVAILABLE`）；`screenshot-loop` 只允许 png（显式要 jpeg 同上） | 禁止 |
| `region` | **canvas CSS px** 矩形；`screencast` 不支持（`DYNAMIC_SOURCE_UNAVAILABLE(screencast-mode-conflict)`） | 禁止 |
| `scale` | 0.1–2，默认 1；`screencast` 只接受 1 | 禁止 |
| `sampleIntervalMs` | 仅 `screenshot-loop` 必填，50–1000 整数；`screencast` 携带即 `DYNAMIC_INVALID_ARGUMENT` | 禁止 |
| `durationMs` | 1–60000 整数，默认 3000 | 禁止（视图无采集） |
| `maxFrames` | 1–300，默认 180 | 禁止 |
| `maxBytes` | 1–64 MiB，默认 32 MiB | 禁止 |
| `networkSessionId` | 可选；用于关联已有 P0 会话 | **必填**，且必须是本 scope 已存在的 P0 会话（否则 `DYNAMIC_SESSION_NOT_FOUND`） |

- `captureVisual:false` 是"纯关联视图"：不启动浏览器、不采帧、不建 page、不占 page 租约，也不启动/停止 P0；同时给其它采集字段会被拒绝。
- 同 scope 只允许 1 个活动会话（`DYNAMIC_SESSION_ACTIVE`）；`status`/`stop`/`reset` 不启动浏览器。
- `extend`：`durationMs` 1–60000/次，自 `startedAt` 起累计 ≤300000ms（超了 `DYNAMIC_LIMIT_EXCEEDED`），**仅 running 有效**；已停会话返回 `DYNAMIC_SESSION_NOT_ACTIVE` 且不复活。
- Agent 一次工具往返约 11.7s：多步取证要显式给足 `durationMs` 或中途 `extend`，否则观察窗口可能已结束（结论只能写采样不足）。

## 4. `browser_motion_observe`（只读）

- 必填 `motionSessionId`；`limit` 1–200（默认 50）。查询组合按实现：`cursor` 与 `sinceSeq` 互斥；`frameIds` 与 `window`/`cursor`/`sinceSeq` 互斥；`fresh:true` 不能与 `sinceSeq`/`cursor`/`window`/`frameIds` 同用；`window` 可与 `sinceSeq` 同时给出（取交集，以返回的 `fromSeq/toSeq` 为准）。
- `includeImages:true` 最多命中 **3 帧**；`fresh:true` 是唯一显式采样动作，只允许当前活动的视觉会话。
- `region`：只交付该矩形（crop-on-delivery，需同时 `includeImages:true`），**坐标是帧图像像素（整数）**，越界/缺 `includeImages` → `DYNAMIC_INVALID_ARGUMENT`；裁剪结果附 `crop{region,sourceSha256,sourceDimensions,sourceEncoding,roiSha256,outputBytes}`，`roiSha256` 与整帧 `encodedSha256` **不是一回事**。
- 只读查询不 ensure、不续租、不启动浏览器；帧被淘汰/丢弃/截断要写在结论里，不能静默忽略。
- `region` 已在 `browser_motion_observe` 的注册 schema 中声明，按上述规则使用即可，不需要假设宿主会拒绝该字段。

## 5. `browser_dynamic_correlate`

- 必填 `dynamicSessionId`；首次调用至少再给 `motionSessionId` 或 `networkSessionId` 之一，且必须属于该动态会话。
- `directions` ∈ 六向：`operation->visual`、`operation->network`、`network->visual`、`visual->network`、`network->network`、`visual->visual`（不得重复）。
- `beforeMs` 0–5000（默认 250）、`afterMs` 0–5000（默认 1000）；`limit` 1–200（默认 50）；`includeTemporal` 默认 `false`（只回时间邻近、不混入因果）。
- `basis` → `grade`：`explicit`/`redirect`/`initiator` = `confirmed-causal`；`observed` = `observed-association`；`temporal` = `temporal-proximity`（默认过滤）。
- 固定 `verdict=INCONCLUSIVE(no-assertion)`：本工具给关联，不给"因果成立"的产品结论；无共同 ID/协议父端点只能进 `unresolved`。

## 6. 网络 P0 参数要点

- `browser_network_session`：`start` 是唯一懒启动动作；`config` 只接受 `captureBodies/captureWebSocket/captureSse/captureWorkers/maxEvents/maxBodyBytes/maxTotalBytes/maxWsFrames/businessStatusPath/maskRules`；上限 `maxEvents ≤ 20000`、`maxBodyBytes ≤ 1 MiB`、`maxTotalBytes ≤ 32 MiB`、`maxWsFrames ≤ 20000`；同名 `start` 幂等（`changed:false`），不同名运行中 → `NET_SESSION_ACTIVE`。
- `browser_network_events`：`view` ∈ `summary|full|timeline|aggregate`；`groupBy` 仅 `aggregate` 需要；`limit` 1–200（默认 50）；`filter.phase` 取值见下表；`cursor` 与 `sinceSeq` 二选一，指向已淘汰 seq → `gap`。
- 事件 `kind` ∈ `http|ws|sse|marker`；`phase` ∈
  `request|redirect|response|data|finished|failed|extra-info`、
  `ws-created|ws-handshake|ws-send|ws-receive|ws-error|ws-closed`、
  `sse-message|mark|step-begin|step-end|evidence-link|control|session-meta`。
- `browser_network_detail`：`requestId`/`seq` 恰一；`include` 缺省除 body 外全部；body 三态 `captured|empty|unavailable`，读不到就 `available:false`（`NET_BODY_UNAVAILABLE`），纯只读、不为此启动 CDP。
- `browser_network_trace`：`action` ∈ `begin-step|end-step|mark|link|window|query|reset`，全部 Host 内存操作、不启动浏览器；窗口归属是 `basis:"temporal"` 派生，不改写事件。
- `browser_network_control`：`action` ∈ `throttle|offline|intercept-add|intercept-remove|intercept-clear|intercept-list|hold|resume|replay|mock|reset`；规则 ≤32、同 id `NET_RULE_CONFLICT`；`hold` ≤64 且超时自动放行并计数（`NET_CONTROL_TIMEOUT` 不抛错）；`reset` 不得 `Fetch.disable`（导航守卫保留）。
- `browser_network_evidence`：`action` ∈ `export|import|index|search|link|integrity|clear|list`；`format` ∈ `jsonl|har|auto`；`out` 必须是持久根内相对路径（否则 `NET_OUTPUT_ROOT_UNKNOWN`/`NET_OUTPUT_PATH_INVALID`）；导入会话为 `state:"snapshot"`，不可 control/replay（`NET_CONTROL_UNAVAILABLE`）。
- `browser_network_subscribe`：`action` ∈ `create|poll|ack|close|list`；每 scope 订阅 ≤16、pin 1000 条；超出给 `gap/dropped` 不许静默。

## 7. 失败码 → 下一步（只列允许动作）

| 错误码（层） | 含义 | 允许的下一步 | 禁止 |
| --- | --- | --- | --- |
| `REF_STALE`(T2) | ref 未知/LRU 淘汰/文档代次变化/节点替换 | 重新 `browser_snapshot` 取新 ref | 猜编号、复用旧 ref、改坐标硬点 |
| `TARGET_NOT_FOUND`(T2) | selector 0 命中；或多标签 selection 指向已关闭 child（`reason:selected-tab-closed`，`fallbackTabId:primary`） | 检查 selector；后者用 `browser_tabs current/select` 确认 | 取"看起来像"的节点；忽略 reason |
| `TARGET_NOT_UNIQUE`(T2) | selector 多命中（含隐藏副本） | 改 ref 或更具体 selector | 取首个匹配 |
| `NOT_INTERACTABLE`(T2) | hidden/disabled/covered/零面积/离视口/运动/不可编辑/焦点或值不匹配 | 记 `FAIL`（或按断言判 `BLOCKED`）；hidden/covered 可用 T3 给成因；`unstable` 走 T4 | force/JS click、改坐标、换相似节点、抖动等待 |
| `WAIT_TIMEOUT`(T2) | 条件未在预算内成立（page 不关闭） | 复核条件写法；记 `FAIL`/`INCONCLUSIVE` | 缩小 `timeoutMs` 掩盖、把超时当"不存在" |
| `UNSUPPORTED`(T2/T4) | 控件/适配器不支持（contenteditable、number/date/file、closed shadow、iframe 内部、非 WAAPI 适配器） | 写 `BLOCKED`；或 T1 替代并在报告声明强度不同 | 假装 T2 已完成；虚构接口 |
| `BUSY`(全层) | 同 tab 有其它 owner（idle 15s） | 等释放后用 `state/capabilities` 诊断，再重试 | 绕面板 HTTP/CDP |
| `VIEWPORT_CONFLICT`(T1) | `expectedRevision` CAS 失败，patch 零应用 | 读最新 `view` 再决定是否重新提交 | 自动重放旧 patch |
| `VISION_STALE_IMAGE` / `VISION_HIT_MISMATCH`(T3 act) | 图过期（>30s/代次/滚动/视口变化/重采样 hash 不符）或命中不一致 | 重新 `vision_image` 取新 product 再派发 | 回退点、换坐标凑命中 |
| `VISION_SIZE_MISMATCH`(T3 compare) | 两图尺寸不同 | 同视口/同 scale 重采同一区域 | 强制比较/缩放后比 |
| `VISION_EMPTY_COMPARISON`(T3 compare) | ROI 被 mask 全排除（无分母） | 扩 ROI 或减 mask | 写 `similarity=1` |
| `VISION_SOURCE_NOT_FOUND`(T3) | product 不存在/LRU/跨 scope/重启丢失 | 重新采 `vision_image` | 换 scope 读取 |
| `VISION_BASELINE_*`(T3 基线) | 根不可用 / 名字非法 / 已存在 / 无此基线 / CAS 冲突 / 读失败 / 写失败 | 配可信持久根；换 name；读 HEAD revision 后重提交；`READ/WRITE_FAILED` 按 reason 处理 | 静默回退暂存、覆盖已有基线 |
| `CAPTURE_FAILED` / `INVALID_PNG` / `CAPTURE_SIZE_MISMATCH` / `CAPTURE_UPSCALED` / `CAPTURE_TOO_LARGE` | 截图采集/校验失败 | 保留 expected/actual；降 scale/缩 region 重采 | 交付坏图/尺寸异常图 |
| `OUTPUT_PATH_INVALID` / `OUTPUT_EXISTS` / `OUTPUT_WRITE_FAILED` | 持久路径问题 | 修相对 `.png`/env 根；换 out 名；核对发布事实 | 覆盖已有路径 |
| `HTTP_TIMEOUT` / `HTTP_FAILED` / `HTTP_REDIRECT_LIMIT`(独立 HTTP) | 超时/网络失败/重定向超限 | 缩短任务、核对 URL；副作用未知先查状态 | 自动重试写操作 |
| `NET_SESSION_ACTIVE` | 不同名会话运行中 | 复用现有 `sessionId` 或先 `stop` | 强开第二个会话 |
| `NET_SESSION_NOT_FOUND` | 无会话 | `session start`（懒启动） | 用 `snapshot` 会话做 control |
| `NET_BODY_UNAVAILABLE` | body 未采到/被淘汰/配额不足 | 报告写原因码；必要时提高 `captureBodies`/配额后重放 | 伪造空体、用 UI 文本反推报文 |
| `NET_EVENT_NOT_FOUND` / `NET_QUOTA_EXCEEDED` / `NET_RULE_INVALID` / `NET_RULE_CONFLICT` | 事件已淘汰 / 超配额 / 规则非法或冲突 | 用 `cursor`/`gap` 重查；调小采集面；改规则 id | 假装事件存在 |
| `NET_OUTPUT_ROOT_UNKNOWN` / `NET_OUTPUT_PATH_INVALID` | 持久根缺失/路径非法 | 用持久根内相对路径 | 写暂存绝对路径 |
| `DYNAMIC_INVALID_ARGUMENT` | 断言/配置 schema 错（必填、互斥、枚举、未知键） | 按 §2–§3 修正后零成本重试 | 猜字段名、把失败当"没有异常" |
| `DYNAMIC_LIMIT_EXCEEDED` | 断言/会话/帧/字节/ID 数量超上限 | 缩规模或新会话 | 抬内部预算掩盖 |
| `DYNAMIC_SESSION_NOT_FOUND` / `NOT_ACTIVE` / `ACTIVE` | 会话不存在/已停（`extend` 不复活）/已有活动会话 | 重新 `start`（给足 `durationMs`）；先 `stop` 旧会话 | 复用已停 motionSessionId |
| `DYNAMIC_SOURCE_UNAVAILABLE` | screencast 不支持 png/region/scale≠1，或核心不可用 | 换 `screenshot-loop`（PNG 精确）或去掉不支持字段 | 静默降级后宣称精确 |
| `DYNAMIC_CONTROL_CONFLICT` / `DYNAMIC_RESTORE_FAILED` | 目标/字段被外部改动，恢复冲突 | 重新定位目标；如实报告 `restoreStatus` | 覆盖外部新状态 |
| `DYNAMIC_EVENT_NOT_FOUND` | frame/event id 不属于本会话 | 用 `motion_observe` 重新取 id | 跨会话使用 id |
| `TAB_NOT_FOUND` / `TAB_LIMIT` / `TAB_FORBIDDEN`(P0-E) | 标签不存在/超 3 child 或全局 8/跨 workspace | 重新 `list` 选 tab；关掉不需要的 child | 跨 workspace 读 tab |

## 8. 坐标空间对照表（最容易错的地方）

| 参数 / 字段 | 所属空间 | 说明 |
| --- | --- | --- |
| `browser_screenshot.region` | **canvas CSS px** | `O=0` 时与文档 CSS 相同；`O≠0` 时先截真实帧再白底合成（`capture.canvas.composite=true`，blank 为纯白 `#ffffff`）；`mapping.cssPerPixel/scrollAtCapture` 是换算依据 |
| `browser_input` 的 `x/y` | **viewport CSS px** | CDP Input 坐标；元素级操作优先 T2，不要用它猜元素位置 |
| T2 `bbox` / `hitTarget` / 动作 `point` | **viewport CSS px** | 来自 `getBoundingClientRect()`；滚动后变化，动作前现读 |
| `browser_viewport` 的 `x/y` | **文档 CSS px** | 页面顶层滚动位置（实测回读、可能被 clamp） |
| `browser_viewport` 的 `canvasX/canvasY` | **画布坐标** | 视口左上角在文档画布上的位置（±1e7，可为负） |
| T3 `Source.live.region` | **文档 CSS px** | 采集前的 live 裁剪区域 |
| T3 `vision_image.region` / `vision_find.region` / `vision_compare.region` / `vision_check` 的 assertion region、`masks`、`annotations` | **图像像素（整数）** | 相对完整源图；`vision_act.point/to` 是连续图像坐标（像素中心传 `i+0.5`）；`vision_check` 的 case `source.live.region` 仍按文档 CSS 解释 |
| T4 `dynamic_session.config.region` | **canvas CSS px** | 截图区域；`screencast` 不支持 |
| T4 `motion_observe.region`、`assertions[].region/masks` | **帧图像像素（整数）** | 帧证据里以 `frame.dimensions` 为准，不是视口 CSS |
| T4 帧 `mapping` | 混合 | `space:"canvas-css-px"`、`viewport`(=画布位置)、`scroll`、`canvasOffset{O=C−S}`、`coordinateSpace:"document-css-px"`、`originCss`、`cssPerPixel{x,y}`、`imagePixels` |
| 面板标注 `shapes` | **画布 CSS px** | 页面坐标 `p = d − S`（`S` = 当前 `view.x/y`，不是发布时的 view） |

换算公式（`C` = `view.canvasX/Y`，`S` = `view.x/y`，`O = C − S`；`d` = 画布坐标，`q` = 视口内偏移，`p` = 文档滚动坐标）：

```text
O = C - S                     # 画布偏移；O=0 时画布坐标 = 文档坐标
q = d - C                     # 画布点 → 视口内偏移（browser_input 用）
p = q + O = d - S             # 视口偏移 → 文档滚动坐标（也用于标注 shapes）
d = v + C                     # 视口坐标 v（T2 bbox）→ 画布坐标（screenshot region 用）
imagePx = (docCss - originCss) * cssPerPixel   # 文档 CSS → 帧图像像素（用该帧 mapping）
```

例（`v` = T2 `bbox` 的视口坐标，`S`/`C` 取自 `browser_viewport` 的 `view`）：

```text
情况 1：C=S=(0,0)  → O=0，d=p；screenshot region 起点 = v
情况 2：C=(300,200), S=(0,0), v=(120,80)
        → O=(300,200)；画布 d=(420,280)（screenshot region 起点）；p=v=(120,80)；q=d−C=(120,80)
情况 3：C=(300,200), S=(40,10), v=(120,80)
        → O=(260,190)；画布 d=(420,280)；文档 p=v+S=(160,90)；q=d−C=(120,80)=p−O
```

## 9. 其它硬限额速查（写报告时直接引用）

- 截图：`scale` 0.1–4（省略跟随 `view.scale`）；输出 ≤16,000,000 像素；`region` 宽高 ≥1 CSS px；`out` 必须是工作区相对 `.png`；`persist` 非布尔 → `INVALID_ARGUMENT`。
- 视口：宽高 200–4096 整数；`scale` 0.1–2；`canvasX/canvasY` ±10,000,000；`expectedRevision` CAS。
- T3：product 每 scope 16 张 / 单张 32 MiB / 16M 像素 / 每 scope 合计 128 MiB；evidence JSON ≤262144 字节、`regions` ≤100；`vision_act` 只接受 ≤30s 的 capture。
- T4：断言 ≤20；`masks` ≤64；`region` 像素 ≤4,000,000；帧 ≤180（硬 300）、字节 32/64 MiB；`includeImages` ≤3；算法预算 5000ms；`correlate limit` ≤200。
- T2：ref 表 2000 项 LRU；`snapshot maxNodes` 1–2000、`depth` 0–32；`wait_for timeoutMs` 0–30000；`fill_form` 1–20 项、文本合计 ≤65536 字节。
- 网络：`events limit` ≤200；会话 `maxEvents` ≤20000、`maxBodyBytes` ≤1 MiB、`maxTotalBytes` ≤32 MiB、`maxWsFrames` ≤20000；规则 ≤32、`hold` ≤64、订阅 ≤16。
- 独立 HTTP：总超时 1–20000ms（默认 5000）、保留正文 1–1048576 字节（默认 65536）、重定向 ≤5 跳、body ≤64 KiB。
- 多标签：每 workspace primary+3 child=4，全局 8，lease idle 15s。