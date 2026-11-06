# 工具参考

插件向 Agent 注册 **36 个** `browser_*` 工具。工具名即调用名，返回值统一以 `{ok:true,…}` 表示工具执行完成，失败抛类型化 `BrowserError`。

> `ok:true` 只说明工具完成了动作，**不等于**验收通过。视觉结论看 `verdict`，网络结论看 `integrity`，动态结论看 `analysis.verdict`。

## 总览

| 分组 | 数量 | 工具 |
| --- | --- | --- |
| P0-E 多标签（tabs） | 1 | `browser_tabs` |
| 程序化（T1） | 10 | `browser_navigate` `browser_eval` `browser_screenshot` `browser_input` `browser_network` `browser_computed_style` `browser_http_request` `browser_viewport` `browser_state` `browser_capabilities` |
| 结构化 GUI（T2） | 7 | `browser_snapshot` `browser_click` `browser_type` `browser_scroll` `browser_fill_form` `browser_node_state` `browser_wait_for` |
| 静态视觉（T3） | 6 | `browser_vision_image` `browser_vision_find` `browser_vision_compare` `browser_vision_act` `browser_vision_baseline` `browser_vision_check` |
| 动态行为（T4） | 5 | `browser_dynamic_session` `browser_motion_observe` `browser_motion_analyze` `browser_motion_control` `browser_dynamic_correlate` |
| 网络（P0-B） | 7 | `browser_network_session` `browser_network_events` `browser_network_detail` `browser_network_trace` `browser_network_control` `browser_network_evidence` `browser_network_subscribe` |

## 多标签（P0-E）

`browser_tabs` 管理当前 workspace 的 primary + child 标签；Agent 的其余工具默认操作当前会话 selectedTab，无选择时 primary。详见[多标签页](multi-tab.md)。

| 工具 | 主要参数 | 要点 |
| --- | --- | --- |
| `browser_tabs` | `action:"list"\|"current"\|"select"\|"open"\|"close"\|"wait"` `tabId?` `kind?` `source?` `timeoutMs?` `pollMs?` | `list/current/wait` 只读（wait 纯内存轮询，不启动 Chromium、不取 lease，超时 `WAIT_TIMEOUT`）；`select` 原子 claim；`open` 新建 about:blank；`close` 仅本人有效 lease；`list` 每项含 `source/parentTabId/openEventId/createdAt/lastUsedAt/idleRemainingMs/manageable` 并返回 `notices`/`recentClosed`（各最多 8 条）；错误 `TAB_NOT_FOUND/TAB_LIMIT/TAB_FORBIDDEN/BUSY/WAIT_TIMEOUT` |

## 程序化（T1）

| 工具 | 主要参数 | 要点 |
| --- | --- | --- |
| `browser_navigate` | `url` | 只接受 HTTP(S)；校验目标、DNS 与最终 URL；**不保证加载完成** |
| `browser_eval` | `expression` | 主世界执行，返回可序列化值；页面异常以错误对象返回 |
| `browser_screenshot` | `scale` `region` `persist` `out` | 显式 scale 0.1–4；省略时跟随共享 `view.scale`；`region` 为 canvas CSS px（`O=0` 时与文档坐标相同）；PNG 经结构/尺寸校验；内联 base64 超过 24 MiB 时 `image=null` 并附 `image_base64_omitted` 警告（附件优先） |
| `browser_input` | `events[]` | 原始鼠标/滚轮/键盘事件，单批 ≤ 200 条（超出 `INVALID_ARGUMENT`）；`applied` 只是数组长度，不能证明生效 |
| `browser_network` | `limit` | 轻量请求列表（默认 50、上限 300）；深度分析用网络 P0 七工具 |
| `browser_computed_style` | `selector` `properties` | 首个匹配元素的计算样式；简写属性（如 `border-color`/`margin`/`font`）经页面 `getComputedStyle` 回退读取，未知属性不返回；不证明视觉结果 |
| `browser_http_request` | `url` `method` `headers` `body` `timeoutMs` `maxBytes` … | 独立 HTTP(S) 客户端，不启动浏览器、不占页面租约；`ok:true` **不等于 2xx** |
| `browser_viewport` | `action:"get"\|"set"` `mode` `x` `y` `canvasX` `canvasY` `width` `height` `scale` `expectedRevision` | `get` 是只读缓存诊断；`set` 是页面操作，走队列与租约 |
| `browser_state` | — | URL、标题、视口、错误、标注等诊断信息；不保证新鲜 |
| `browser_capabilities` | — | 真实运行态三态、各段 limits 与 observed；不启动浏览器；`dynamic.assertions` 给机器可读七类断言规格，`dynamic.sampling` 说明 requested/measured，顶层 `limitations` 声明低采样不得证明无异常 |

详见[视口、画布与标注](viewport-control.md)、[截图与图片交付](capture-p0.md)。

## 结构化 GUI（T2）

`browser_snapshot` 把无障碍树投影成 `refs`，后续动作优先用 `ref`，也可用唯一 `selector`。

| 工具 | 关键约束 |
| --- | --- |
| `browser_snapshot` | `scope`/`maxNodes`(≤2000)/`depth`(≤32)/`boxes`；返回 `snapshotId`、`digest`、`refs`、`truncated` |
| `browser_click` | `ref`/`selector` 恰一；滚动进视口、两帧稳定、命中校验后派发 CDP 真实鼠标事件 |
| `browser_type` | 仅原生文本输入与 textarea；`replace` 默认替换，`submit` 默认不提交；不回显输入 |
| `browser_scroll` | `direction` 与 `to` 恰一；目标须在视口内且稳定，否则零派发 |
| `browser_fill_form` | 1–20 个字段；`combobox`/`slider` 走原生 setter（`eventSource:"dom-control"`） |
| `browser_node_state` | 读取可见/启用/勾选/bbox 等；可编辑 `value` 恒脱敏 |
| `browser_wait_for` | 文本/消失/节点状态三类条件互斥；超时抛 `WAIT_TIMEOUT`，页面不关闭 |

详见[结构化 GUI](t2-structured-gui.md)。

## 静态视觉（T3）

源图只接受 `live`（当前截图）、`product`（本 scope 的视觉产物）或 `baseline`（受管基线），**不接受任意文件路径或调用方 base64**。

| 工具 | 用途 |
| --- | --- |
| `browser_vision_image` | 裁剪、缩放、预处理、统计、识别、标注并交付 PNG |
| `browser_vision_find` | 颜色/连通域/边缘/模板确定性定位；无匹配是成功空列表 |
| `browser_vision_compare` | 两图 YIQ 差异，输出标注差异图；两图必须同尺寸 |
| `browser_vision_act` | 按截图坐标派发真实输入；六步校验不过则零派发 |
| `browser_vision_baseline` | 受管基线：不可变 revision、HEAD CAS、墓碑删除 |
| `browser_vision_check` | 回归与六类缺陷用例；整批先校验再执行 |

详见[静态视觉](t3-vision.md)。

## 动态行为（T4）

| 工具 | 用途 |
| --- | --- |
| `browser_dynamic_session` | `start`/`stop`/`status`/`reset`/`extend`；帧源 `screencast` 或 `screenshot-loop`；`session.sampling` 给出机制/节奏/requested/measured/计数器/limitations |
| `browser_motion_observe` | 只读帧与事件查询；`includeImages` ≤3；`region`（image-px，仅与 `includeImages` 同用，注册 schema 可发现）只交付指定矩形；顶层与 `evidence.dynamic.sampling` 附实测采样块 |
| `browser_motion_analyze` | 七类断言：帧差/区域变化/闪烁/冻结/卡顿/轨迹/过渡；时间断言的 `metrics.sampling` 给出实测间隔，低采样只加 limitation 不改 verdict（flicker 阴性除外：低采样或无时间基准 → `INCONCLUSIVE(insufficient-temporal-resolution)`） |
| `browser_motion_control` | WAAPI `pause`/`resume`/`seek`/`rate`/`restore`，逐目标回读 |
| `browser_dynamic_correlate` | 六向「帧 ↔ 网络」关联，区分因果与时间邻近 |

`browser_capabilities.dynamic.assertions` 直接投影纯核心的 `MOTION_ASSERTION_SCHEMA`（七类 allowed/required/枚举/默认阈值），`dynamic.sampling` 与顶层 `limitations` 共同声明：**实际 fps 以 measured 为准，低采样不得证明「无异常/未发生」**（详见[动态行为](t4-dynamic-behavior.md)）。

## 网络（P0-B）

| 工具 | 用途 |
| --- | --- |
| `browser_network_session` | 唯一会懒启动采集的动作：`start`/`stop`/`status`/`reset` |
| `browser_network_events` | 列表、时间线、聚合、过滤与检索（命中内容只回脱敏预览） |
| `browser_network_detail` | 单个请求/WS/SSE 的完整详情；读不到就是 `available:false` |
| `browser_network_trace` | 业务步骤窗口、对象提取、显式关联与因果查询 |
| `browser_network_control` | 限速、离线、拦截、hold、重放、mock |
| `browser_network_evidence` | JSONL（保真）/ HAR（1.2 子集）导出、导入、索引与完整性 |
| `browser_network_subscribe` | 多 Agent 各自游标 poll/ack，pin 预算内不丢 |

`browser_network_session` 的 `status`/`start`/`stop`/`reset` 与各 network 工具的 `evidence` 回传 `attribution:{scopeId,runtimeId,tabId}`（主标签 `primary`，缺失为 `null`、不反推）；`status` 另有 `activeSessionId`/`bufferedEvents`。`browser_network_detail` 的 body 为三态 `captured|empty|unavailable`，`unavailable` 带兼容字段 `reason:"NET_BODY_UNAVAILABLE"` + 稳定 `reasonCode`（`not-captured` / `cdp-*`）+ 脱敏 `reasonDetail`（≤160 字节）；`captureBodies:false` 明确 `not-captured`，不补抓。无会话时 `browser_network_events` 返回空并明示 `session:null`；跨标签不聚合，status 与 events 的历史不一致按 UNKNOWN 记录（详见[网络调试](network-p0.md)）。

详见[网络调试](network-p0.md)。

## 常见错误分类

| 错误码 | 含义 |
| --- | --- |
| `INVALID_ARGUMENT` | 参数不合法（含未知字段、互斥字段同时出现） |
| `BUSY` | 当前工作区页面被其他 owner 占用 |
| `REF_STALE` | ref 所属快照或文档已失效，需要重新 snapshot |
| `NOT_INTERACTABLE` | 目标不可见/被遮挡/持续运动，零派发 |
| `TARGET_NOT_UNIQUE` | selector 命中多个元素 |
| `VIEWPORT_CONFLICT` | `expectedRevision` 不匹配，patch 未应用 |
| `VISION_*` | 视觉源、尺寸、基线或比较错误 |
| `DYNAMIC_*` | 动态会话、预算、控制或关联错误 |
| `NET_*` | 网络会话、事件、规则、证据或订阅错误 |

完整错误列表与字段以各功能文档为准；失败时 `details` 携带结构化证据，不要把错误文本当成结论。
