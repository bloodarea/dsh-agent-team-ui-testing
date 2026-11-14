# 工具参考

插件向 Agent 注册 **37 个** `browser_*` 工具。工具名即调用名，返回值统一以 `{ok:true,…}` 表示工具执行完成，失败抛类型化 `BrowserError`。

> 能力分层、支持/可用/执行/通过的区别，以及证据判读统一见[能力分层文档](capability-tiers.md#2-共同约束与选路)。`integrity` 报告采集完整性，业务结论仍需具体断言。

工具声明与执行由 Host 配置驱动：默认只暴露当前环境的专用 schema（Web 默认 37 个）；未启用/非当前环境的工具不会出现在模型请求中，旧调用与 GUI 旁路在执行时仍会被拒绝（`ADAPTER_DISABLED`，未注册的工具报 `unknown tool`）。`browser_state` 与 `browser_capabilities` 是**环境中立诊断**：任何环境（含被禁用）都保留，用于回答"支持什么/为什么被拒"，它们不启动目标；被禁用环境的六轴报告为 `support=supported` + `enabled=false`，不再退化成"未注册"或 `INTERNAL`。成功/失败 envelope 额外携带 `configRevision`、`environment`、`adapterId`，用于核对本次执行使用的配置版本；`browser_capabilities.adapter` 报告 adapter 契约版本、能力矩阵、P0 family 状态、六轴就绪，以及 `declaration`：`registeredTools`（当前注册面＝模型请求能看到的插件 schema）、`admittedTools`（逐 Agent 准入集合）、`isolated`（两者是否一致）。

**工具布局由设置页的面板配置作为唯一权威**：启用了哪些环境，就只注册这些环境的工具，不会额外带入其它环境的 schema。

| 面板里启用 | 注册面（模型请求可见的插件工具） |
| --- | --- |
| 只 Web | 37 个 `browser_*`（其中 `browser_state`/`browser_capabilities` 是两个环境无关诊断） |
| Web + fake（测试环境） | 上述 37 个 + `browser_fake_probe` = 38 |
| 只 fake | `browser_fake_probe` + `browser_state` + `browser_capabilities` = 3 |
| 全关 | `browser_state` + `browser_capabilities` = 2（诊断在任何环境都可用，用于回答“支持什么/为什么被拒”） |

被禁用或不允许选择的环境，其工具**根本不注册**，因此不可能出现在任何模型请求里。`when(agent)` 仍是第二道闸门（会话级执行准入与 Skill 发现都按会话解析），但**声明面以注册范围为准**：实测本机 3080 的 `request/header` 按“已注册”构建请求，`when=false` 不会移除声明，所以 `declaration.surface=host-tool-registration`、`registration=enabled-union`；两者不一致时 `isolated=false` 并给出说明。三个环境的真实请求头实测：37 → 2 → 37（关闭/重开 Web）。`browser_fake_probe` 仅在 `DSH_UI_TESTING_TEST_HOOKS=1`/`DSH_UI_TESTING_ALLOW_TEST_ENV=1` 的测试配置中注册，不属于生产 37 工具面。

## 总览

| 分组 | 数量 | 工具 |
| --- | --- | --- |
| P0-E 多标签（tabs） | 1 | `browser_tabs` |
| P0-D 标注（annotations） | 1 | `browser_annotation` |
| 程序化（T1） | 10 | `browser_navigate` `browser_eval` `browser_screenshot` `browser_input` `browser_network` `browser_computed_style` `browser_http_request` `browser_viewport` `browser_state` `browser_capabilities` |
| 结构化 GUI（T2） | 7 | `browser_snapshot` `browser_click` `browser_type` `browser_scroll` `browser_fill_form` `browser_node_state` `browser_wait_for` |
| 静态视觉（T3） | 6 | `browser_vision_image` `browser_vision_find` `browser_vision_compare` `browser_vision_act` `browser_vision_baseline` `browser_vision_check` |
| 动态行为（T4） | 5 | `browser_dynamic_session` `browser_motion_observe` `browser_motion_analyze` `browser_motion_control` `browser_dynamic_correlate` |
| 网络（P0-B） | 7 | `browser_network_session` `browser_network_events` `browser_network_detail` `browser_network_trace` `browser_network_control` `browser_network_evidence` `browser_network_subscribe` |

## 多标签（P0-E）

P0-E 的[多目标管理接口](multi-tab.md#1-公共抽象)由各目标环境实现，当前提供 Web 工具 `browser_tabs`。它管理当前 workspace、provider 与团队根内的 primary + child 页面；写工具走调用者 workSelection（默认指向自己已拥有的页，没有自有页则未绑定），读工具优先 observationSelection，再回退 workSelection。具体约定见[Web 实现](multi-tab.md#2-具体实现web)。

| 工具 | 主要参数 | 要点 |
| --- | --- | --- |
| `browser_tabs` | `action:"list"\|"current"\|"select"\|"open"\|"close"\|"wait"\|"acquire"\|"release"\|"transfer"` `tabId?` `mode?`（仅 select，work/observe）`kind?` `source?` `timeoutMs?`（wait/acquire）`pollMs?`（wait）`expectedControlRevision?`（acquire/release/transfer 必填）`expectedOwnershipRevision?`（transfer 必填）`toSessionId?`（transfer） | `list/current/wait` 只读（wait 纯内存轮询，不启动 Chromium、不取 lease，超时 `WAIT_TIMEOUT`）；`select` 只改调用者自己的选择（work 写目标 / observe 只读目标），**不 claim 租约、不切前台**；`open` 新建 about:blank；`close` 按长期归属/控制权判定（owner 或 controller，本 root Lead 亦可）；`acquire/release/transfer` 仅本 root Lead，带 CAS 版本，`acquire` 先 draining 再等安全边界（不中断在途操作，超时 `BUSY` 且撤销 draining）；页面组按 (workspace, provider, 团队根) 划分，child 最多 3 个按 (workspace, provider) 跨 root 合计、全局 live 8；`list` 每项含 `source/parentTabId/openEventId/createdAt/lastUsedAt/idleRemainingMs/manageable` 与 `accessVersion/rootSessionId/creatorSessionId/ownerSessionId/controllerSessionId/ownershipRevision/controlRevision/accessState/permissions`，并返回 `notices`/`recentClosed`（各最多 8 条）；错误 `TAB_NOT_FOUND`（跨 root 统一，不泄露存在性）`/TAB_FORBIDDEN/TAB_CONTROL_CHANGED/TAB_OWNERSHIP_STALE/TAB_IDENTITY_UNAVAILABLE/TAB_LIMIT/BUSY(仅短暂忙)/WAIT_TIMEOUT/INVALID_ARGUMENT` |

## 标注（P0-D）

`browser_annotation` 读写**调试视图里的面板标注文档**：每个 Runtime 一份，与面板认证的 `POST /plugins/ui-testing/annotations` 是**同一份**文档。人类画的形状和 Agent 画的形状落在同一个文档里，面板下一次 `/state` 轮询（约 500ms）就会画出来。它**不启动浏览器、不进页面串行队列、不占 single-owner lease、不写页面 `lastError`、不改页面 DOM/CSS**——只写 Host 侧的标注文档。坐标契约同[视口、画布与标注](viewport-control.md)。

| 动作 | 参数 | 要点 |
| --- | --- | --- |
| `read` | 不接受其它字段 | 返回当前文档：`revision`、`shapes`、`shapeCount`、`truncated`、`truncation`、`foreground`。**不受前台条件限制** |
| `draw` | `shapes` 1–64、`expectRevision?` | 形状**追加**到现有文档，不是替换；省略 `id` 时由 Host 从现有最大 id 继续分配 `a<N>` |
| `erase` | `ids?` 1–64、`point?`、`expectRevision?` | `ids` 与 `point` 至少给一个；`point` 为 `{x,y,radius?}`，默认半径 8 画布 px |
| `clear` | 不接受其它字段（`expectRevision?` 除外） | 清空画布：写成空形状列表 |

写动作成功后返回写入后的同一份文档视图，字段与 `read` 相同。

形状字段：

| 字段 | 取值 |
| --- | --- |
| `type` | 必填：`circle` / `rect` / `line` / `arrow` / `brush` / `text`，分别对应面板的圆形、矩形、线段、箭头、画笔（铅笔）、文字（用于写问题、问号等文字提示） |
| `id` | 可省略（省略则由 Host 分配）；显式给出时必须匹配 `^a[1-9][0-9]{0,15}$` 且不重复 |
| `color` | `#rrggbb`，默认 `#ff3b30` |
| `strokeWidth` | 整数 1–20，默认 3（面板的「粗细」） |
| `style` | `stroke` / `fill`（面板的「外框」/「填充」），只对 `circle`/`rect` 有效；`text` 固定 `fill`，`line`/`arrow`/`brush` 固定 `stroke` |
| `fill` / `stroke` | 也接受显式布尔值；**同时**给 `style` 与 `fill`/`stroke` 报 `INVALID_ARGUMENT` |

几何字段按类型：

| `type` | 字段 | 备注 |
| --- | --- | --- |
| `rect` | `x,y,width,height` | 左上角 + 尺寸 |
| `circle` | `cx,cy,rx,ry` | 与面板一致：包围盒内接椭圆（不是「中心 + 半径」） |
| `line` / `arrow` | `x1,y1,x2,y2` | `arrow` 的 head 由 Host 按端点与线宽派生，调用方给了也不作数 |
| `brush` | `points:[[x,y],…]` | 单笔画笔点数受下文限额约束 |
| `text` | `x,y,text,fontSize?` | `fontSize` 固定 20 |

- **橡皮擦命中规则**：`erase.point` 命中形状的判据与面板橡皮擦一致——形状几何到该点的距离 ≤ `max(strokeWidth/2, 6)` 与给定 `radius` 取大者。
- **前台硬约束**：`draw`/`erase`/`clear` 只在目标标签页**正被人类在调试视图里选中且可见**时才允许，否则**零写入**并报 `ANNOTATION_NOT_FOREGROUND`。判断依据是面板在认证请求上携带的前台标签心跳（约 1.5s 新鲜窗口）：人切走标签、关掉面板、或把 DSH 标签页切到后台都会让窗口过期。目的就是 Agent 画的标注必须人能立刻看到。`read` 不受此限；可用 `browser_state.annotations.foreground = {active, ageMs, maxAgeMs}` 先判断能不能画。
- **页面必须处于运行态**：未启动页面时写标注报 `INVALID_ARGUMENT`（reason `annotation-runtime-not-running`）。
- **乐观并发**：`expectRevision` 与当前文档 `revision` 不同则报 `ANNOTATION_REVISION_CONFLICT`，零写入并返回 `currentRevision`。
- **整份替换语义**：文档是整份替换模型——人类在面板里下一次编辑会整体发布自己的形状列表（其中已包含 Agent 画的形状，因为面板会采纳 Host 文档），而人类「清除画布」会连 Agent 的形状一起清掉。
- **软限额**：与面板写面相同——文档最多 `maxShapes` 128 个形状、单笔画笔 512 点、文档总点数 8192、文字 200 字符、文档 65536 字节。Host 做确定性裁剪，并在结果里如实报 `truncated` / `truncation`。
- **证据边界**：标注是 `trusted=false` 的问题线索，不是页面事实；`browser_screenshot {includeAnnotations:true}` 会把 Agent 画的形状与人类画的形状一起叠加。

## 程序化（T1）

| 工具 | 主要参数 | 要点 |
| --- | --- | --- |
| `browser_navigate` | `url` | 只接受 HTTP(S)；校验目标、DNS 与最终 URL；**不保证加载完成** |
| `browser_eval` | `expression` | 主世界执行，返回可序列化值；页面异常以错误对象返回 |
| `browser_screenshot` | `scale` `region` `includeAnnotations?:boolean=false` `persist` `out` | 显式 scale 0.1–4；省略时跟随共享 `view.scale`；`region` 为 canvas CSS px（`O=0` 时与文档坐标相同）；`includeAnnotations:true` 按相同映射叠加 Host 已接受的六种面板标注，不含未提交草稿/工具栏，证据见 `capture.annotations`；默认截图及 T3/T4 原始源不含面板标注；PNG 经结构/尺寸校验；内联 base64 超过 24 MiB 时 `image=null` 并附 `image_base64_omitted` 警告（附件优先） |
| `browser_input` | `events[]` | 原始鼠标/滚轮/键盘事件，单批 ≤ 200 条（超出 `INVALID_ARGUMENT`）；`applied` 只是数组长度，不能证明生效。**带按键状态机**：`keyDown` 记位、`keyUp` 清位，按住 Shift/Ctrl/Alt/Meta 时后续 key/mouse/wheel 自动带上对应位（页面 `e.shiftKey` 等为真），`synthesizeModifiers:false` 可显式关掉；`mouse` 事件给 `deltaX/deltaY` 时按相对位移移动一个虚拟光标（点积锁定/转视角类调用不需要知道绝对坐标，光标被 clamp 在视口内）；返回 `{ok,applied,modifiers,held,cursor}`，`held` 是当前仍按住的键。导航/关闭会清空状态 |
| `browser_network` | `limit` | 轻量请求列表（默认 50、上限 300）；**只读**：不取页面队列、不取也不校验单 owner 租约（owner 持租约时仍可读），因此信封里 `sessionId` 是采集会话、agent 会话见 `agentSessionId`；深度分析用网络 P0 七工具 |
| `browser_computed_style` | `selector` `properties` | 首个匹配元素的计算样式；简写属性（如 `border-color`/`margin`/`font`）经页面 `getComputedStyle` 回退读取，未知属性不返回；不证明视觉结果 |
| `browser_http_request` | `url` `method` `headers` `body` `timeoutMs` `maxBytes` … | 独立 HTTP(S) 客户端，不启动浏览器、不占页面租约；`ok:true` **不等于 2xx** |
| `browser_viewport` | `action:"get"\|"set"` `mode` `x` `y` `canvasX` `canvasY` `width` `height` `scale` `expectedRevision` | `get` 是只读缓存诊断；`set` 是页面操作，走队列与租约 |
| `browser_state` | — | URL、标题、视口、错误、标注等诊断信息；不保证新鲜 |
| `browser_capabilities` | — | 能力声明、状态投影、limits 与最近 observed；不启动浏览器；报告结构及其能证明的范围见[能力发现](capability-tiers.md#web-chrome-discovery) |

详见[视口、画布与标注](viewport-control.md)、[截图与图片交付](capture-p0.md)。

## 结构化 GUI（T2）

结构化发现、ref 协议、七个工具的参数、动作门禁、证据和错误统一见[Chrome T2 实现](capability-tiers.md#web-chrome-t2)。

## 静态视觉（T3）

Source、图像处理、定位、比较、动作、基线与断言的完整说明见[Chrome T3 实现](capability-tiers.md#web-chrome-t3)，包括[工具表](capability-tiers.md#web-chrome-t3-tools)与[源图协议](capability-tiers.md#web-chrome-t3-source)。

## 动态行为（T4）

| 工具 | 用途 |
| --- | --- |
| `browser_dynamic_session` | `start`/`stop`/`status`/`reset`/`extend`；帧源 `screencast` 或 `screenshot-loop`；`session.sampling` 给出机制/节奏/requested/measured/计数器/limitations |
| `browser_motion_observe` | 只读帧与事件查询；`includeImages` ≤3；`region`（image-px，仅与 `includeImages` 同用，注册 schema 可发现）只交付指定矩形；顶层与 `evidence.dynamic.sampling` 附实测采样块 |
| `browser_motion_analyze` | `motionSessionId` + 1–20 条断言；`window`/`frameIds` 恰一；返回 results/summary/verdict/exitCode 与 integrity |
| `browser_motion_control` | WAAPI `pause`/`resume`/`seek`/`rate`/`restore`，逐目标回读 |
| `browser_dynamic_correlate` | 六向「帧 ↔ 网络」关联，区分因果与时间邻近 |

完整会话、采样字段、帧查询、分析、控制与关联说明见[Chrome T4 实现](capability-tiers.md#web-chrome-t4)。

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
| `BUSY` | 该页队列正被其他会话的**写**操作占用（短暂忙；只读观察不占写租约，权限问题不会报 BUSY） |
| `REF_STALE` | ref 所属快照或文档已失效，需要重新 snapshot |
| `NOT_INTERACTABLE` | 目标不可见/被遮挡/持续运动，零派发 |
| `TARGET_NOT_UNIQUE` | selector 命中多个元素 |
| `VIEWPORT_CONFLICT` | `expectedRevision` 不匹配，patch 未应用 |
| `VISION_*` | 视觉源、尺寸、基线或比较错误 |
| `DYNAMIC_*` | 动态会话、预算、控制或关联错误 |
| `NET_*` | 网络会话、事件、规则、证据或订阅错误 |
| `ANNOTATION_NOT_FOREGROUND` | 目标标签页不是人类此刻选中且可见的前台标签，写标注零写入 |
| `ANNOTATION_REVISION_CONFLICT` | `expectRevision` 与当前文档 `revision` 不一致，写标注零写入并返回 `currentRevision` |

完整错误列表与字段以各功能文档为准；失败时 `details` 携带结构化证据，不要把错误文本当成结论。
